const crypto = require('crypto');
const axios = require('axios');
const { computeRealizedPnl } = require('../utils/pnl');

const BASE_URL = 'https://api.bybit.com';

function signRequest(apiKey, secret, params) {
  const timestamp = Date.now();
  const recvWindow = 5000;
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signStr = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  const signature = crypto.createHmac('sha256', secret).update(signStr).digest('hex');
  return { timestamp, recvWindow, signature };
}

// getBalances/getSpotPositions/getTradeHistory each independently fetch the same
// wallet-balance endpoint (and often overlapping execution-history windows) on
// every poll cycle. Cache in-flight/recent responses per (apiKey, endpoint,
// params) so concurrent callers within a short window share one upstream call
// instead of tripling Bybit's request volume for identical data.
const requestCache = new Map(); // cacheKey -> { promise, expiresAt }
const REQUEST_CACHE_TTL_MS = 20000;

async function request(apiKey, secret, endpoint, params = {}) {
  const cacheKey = `${apiKey}:${endpoint}:${JSON.stringify(params)}`;
  const cached = requestCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const { timestamp, recvWindow, signature } = signRequest(apiKey, secret, params);
  const queryString = new URLSearchParams(params).toString();
  const promise = axios.get(`${BASE_URL}${endpoint}?${queryString}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': signature
    }
  }).then(res => res.data).catch(e => {
    console.error(`[Bybit] ${endpoint} HTTP ${e.response?.status}:`, JSON.stringify(e.response?.data));
    throw e;
  });
  promise.catch(() => requestCache.delete(cacheKey)); // don't cache failures
  requestCache.set(cacheKey, { promise, expiresAt: Date.now() + REQUEST_CACHE_TTL_MS });
  return promise;
}

const EXECUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // Bybit's max span per request
const MAX_LOOKBACK_WINDOWS = 105; // ~2 years — Bybit's documented execution history limit

// Bybit's /v5/execution/list defaults to (and caps each request at) the last 7 days.
// Trades older than a week are invisible unless you page backward through 7-day
// windows. We do that here, stopping early once enough buy volume is found to
// account for the currently held quantity — most positions resolve in 1-2 windows.
async function fetchBybitExecutions(apiKey, secret, symbol, qtyNeeded = Infinity) {
  const executions = [];
  let boughtQty = 0;
  let windowEnd = Date.now();

  outer:
  for (let w = 0; w < MAX_LOOKBACK_WINDOWS; w++) {
    const windowStart = windowEnd - EXECUTION_WINDOW_MS;
    let cursor;
    for (let page = 0; page < 10; page++) {
      const params = { category: 'spot', symbol, limit: 100, startTime: windowStart, endTime: windowEnd };
      if (cursor) params.cursor = cursor;
      let data;
      try {
        data = await request(apiKey, secret, '/v5/execution/list', params);
      } catch (e) {
        // Network/HTTP-level failure — retrying with an older window won't help.
        break outer;
      }
      // Bybit signals errors (bad symbol, permission denied, rate limit) via retCode
      // on an HTTP 200 response, not a thrown exception — stop the whole search, not
      // just this window, since it'll fail identically for every older window too.
      if (data.retCode !== 0) break outer;
      const list = data.result?.list || [];
      executions.push(...list);
      list.forEach(t => { if (t.side === 'Buy') boughtQty += parseFloat(t.execQty); });
      cursor = data.result?.nextPageCursor;
      if (!cursor || !list.length) break;
    }
    if (boughtQty >= qtyNeeded) break;
    windowEnd = windowStart;
  }

  return executions;
}

async function getSpotPnl(apiKey, secret, coin, currentPrice, qty = Infinity) {
  try {
    const list = await fetchBybitExecutions(apiKey, secret, `${coin}USDT`, qty);
    if (!list.length) return { avgEntryPrice: 0, pnl: 0, pnlPct: 0, openDate: null };

    let totalQty = 0, totalCost = 0, earliestTime = Infinity;
    list.forEach(t => {
      const execQty = parseFloat(t.execQty);
      const price = parseFloat(t.execPrice);
      const time = parseInt(t.execTime);
      if (t.side === 'Buy') { totalQty += execQty; totalCost += execQty * price; }
      else { totalQty -= execQty; totalCost -= execQty * price; }
      if (time < earliestTime) earliestTime = time;
    });

    if (totalQty <= 0) return { avgEntryPrice: 0, pnl: 0, pnlPct: 0, openDate: null };
    const avgEntryPrice = totalCost / totalQty;
    const pnl = (currentPrice - avgEntryPrice) * totalQty;
    const pnlPct = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
    const openDate = earliestTime < Infinity ? new Date(earliestTime).toISOString() : null;
    return { avgEntryPrice, pnl, pnlPct, openDate };
  } catch (e) {
    return { avgEntryPrice: 0, pnl: 0, pnlPct: 0, openDate: null };
  }
}

async function getBalances(apiKey, secret) {
  let data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  console.log('[Bybit] UNIFIED wallet-balance retCode:', data.retCode, 'retMsg:', data.retMsg, 'list length:', data.result?.list?.length);

  if (!data.result?.list?.length) {
    data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'CONTRACT' });
    console.log('[Bybit] CONTRACT wallet-balance retCode:', data.retCode, 'retMsg:', data.retMsg, 'list length:', data.result?.list?.length);
  }

  if (!data.result?.list?.length) throw new Error('Bybit: no account data returned');

  const account = data.result.list[0];
  console.log('[Bybit] totalEquity:', account.totalEquity, 'coins:', account.coin?.length);
  const totalUsdt = parseFloat(account.totalEquity || 0);

  const coins = (account.coin || []).filter(c => parseFloat(c.equity) > 0);

  const balances = await Promise.all(coins.map(async c => {
    const currentPrice = c.coin === 'USDT' ? 1 : parseFloat(c.usdValue || 0) / parseFloat(c.equity || 1);
    let avgEntryPrice = 0, pnl = 0, pnlPct = 0;

    if (c.coin !== 'USDT' && currentPrice > 0) {
      const spotPnl = await getSpotPnl(apiKey, secret, c.coin, currentPrice, parseFloat(c.equity));
      avgEntryPrice = spotPnl.avgEntryPrice;
      pnl = spotPnl.pnl;
      pnlPct = spotPnl.pnlPct;
    }

    return {
      asset: c.coin,
      free: c.availableToWithdraw || '0',
      locked: c.locked || '0',
      valueUsdt: parseFloat(c.usdValue || 0),
      currentPrice,
      avgEntryPrice,
      pnl,
      pnlPct,
      type: 'Spot'
    };
  }));

  return { balances, totalUsdt };
}

async function getPositions(apiKey, secret) {
  const data = await request(apiKey, secret, '/v5/position/list', {
    category: 'linear', settleCoin: 'USDT'
  });

  console.log('[Bybit] positions retCode:', data.retCode, 'retMsg:', data.retMsg, 'count:', data.result?.list?.length);

  if (!data.result?.list) return [];

  return data.result.list
    .filter(p => parseFloat(p.size) > 0)
    .map(p => {
      const entryPrice = parseFloat(p.avgPrice);
      const markPrice = parseFloat(p.markPrice);
      const size = parseFloat(p.size);
      const pnl = parseFloat(p.unrealisedPnl);
      const pnlPct = entryPrice > 0
        ? ((markPrice - entryPrice) / entryPrice) * 100 * (p.side === 'Buy' ? 1 : -1)
        : 0;

      return {
        symbol: p.symbol,
        side: p.side,
        size,
        entryPrice,
        markPrice,
        pnl,
        pnlPct,
        leverage: p.leverage,
        liquidationPrice: parseFloat(p.liqPrice || 0)
      };
    });
}

const BYBIT_STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'USDD']);

async function getSpotPositions(apiKey, secret) {
  let data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  if (!data.result?.list?.length) {
    data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'CONTRACT' });
  }
  if (!data.result?.list?.length) return [];

  const account = data.result.list[0];
  const coins = (account.coin || []).filter(c =>
    parseFloat(c.equity) > 0 && !BYBIT_STABLECOINS.has(c.coin)
  );

  const positions = await Promise.all(coins.map(async c => {
    const qty = parseFloat(c.equity);
    const valueUsdt = parseFloat(c.usdValue || 0);
    if (valueUsdt < 1) return null;
    const currentPrice = qty > 0 ? valueUsdt / qty : 0;

    const { avgEntryPrice, pnl, pnlPct, openDate } = await getSpotPnl(apiKey, secret, c.coin, currentPrice, qty);
    const openValue = avgEntryPrice > 0 ? avgEntryPrice * qty : 0;

    return { asset: c.coin, quantity: qty, currentPrice, valueUsdt, avgEntryPrice, openValue, openDate, pnl, pnlPct };
  }));

  return positions.filter(Boolean);
}

// Bybit only exposes execution history per symbol, so coverage is limited to
// assets currently (or recently, while still held) in the account.
async function getTradeHistory(apiKey, secret) {
  let data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  if (!data.result?.list?.length) {
    data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'CONTRACT' });
  }
  if (!data.result?.list?.length) return [];

  const account = data.result.list[0];
  const coins = (account.coin || []).filter(c => parseFloat(c.equity) > 0 && !BYBIT_STABLECOINS.has(c.coin));

  const perAsset = await Promise.all(coins.map(async c => {
    try {
      const list = await fetchBybitExecutions(apiKey, secret, `${c.coin}USDT`, parseFloat(c.equity));
      const normalized = list.map(t => ({
        asset: c.coin,
        side: t.side === 'Buy' ? 'buy' : 'sell',
        qty: parseFloat(t.execQty),
        price: parseFloat(t.execPrice),
        date: new Date(parseInt(t.execTime)).toISOString()
      })).sort((a, b) => new Date(a.date) - new Date(b.date));
      return computeRealizedPnl(normalized);
    } catch (e) {
      return [];
    }
  }));

  return perAsset.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
}

module.exports = { getBalances, getPositions, getSpotPositions, getTradeHistory };