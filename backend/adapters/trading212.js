const axios = require('axios');
const { computeRealizedPnl } = require('../utils/pnl');

const BASE_URL = 'https://live.trading212.com/api/v0';

// Trading 212's API has a strict per-endpoint rate limit (account summary in
// particular). getBalances/getSpotPositions/getTradeHistory each hit the same
// summary endpoint on every poll cycle, and the dashboard's independent 60s
// intervals for balances and spot positions fire close together — without
// dedup that's multiple near-simultaneous calls to the same endpoint, which
// T212 answers with 429. Caching the in-flight/recent response per path lets
// concurrent callers share one upstream request.
const requestCache = new Map(); // `${apiKey}:${path}` -> { promise, expiresAt }
const REQUEST_CACHE_TTL_MS = 30000;

function buildAuthHeader(apiKey, apiSecret) {
  if (apiSecret) {
    return 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  }
  return apiKey;
}

async function request(apiKey, apiSecret, path) {
  const cacheKey = `${apiKey}:${path}`;
  const cached = requestCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = axios.get(`${BASE_URL}${path}`, {
    headers: { Authorization: buildAuthHeader(apiKey, apiSecret) },
    timeout: 10000
  }).then(res => res.data);
  promise.catch(() => requestCache.delete(cacheKey)); // don't cache failures
  requestCache.set(cacheKey, { promise, expiresAt: Date.now() + REQUEST_CACHE_TTL_MS });
  return promise;
}

const rateCache = new Map(); // currency -> { promise, expiresAt }
const RATE_CACHE_TTL_MS = 5 * 60 * 1000; // FX rates barely move; cache longer than requests

async function getUsdRate(currency) {
  if (currency === 'USD') return 1;
  const cached = rateCache.get(currency);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = axios.get(`https://api.frankfurter.dev/v1/latest?from=${currency}&to=USD`, { timeout: 5000 })
    .then(res => res.data?.rates?.USD || 1)
    .catch(e => {
      console.error(`Trading 212: failed to fetch ${currency}/USD rate`, e.message);
      return 1;
    });
  rateCache.set(currency, { promise, expiresAt: Date.now() + RATE_CACHE_TTL_MS });
  return promise;
}

function parseTicker(ticker) {
  // "AAPL_US_EQ" → "AAPL", "VWRL_EQ" → "VWRL"
  return (ticker || '').replace(/(_US)?_EQ$/, '').replace(/_[A-Z]+$/, '') || ticker;
}

async function getBalances(apiKey, apiSecret) {
  try {
    const summary = await request(apiKey, apiSecret, '/equity/account/summary');
    const currency = summary.currency || 'USD';
    const toUsd = await getUsdRate(currency);

    const totalValue = parseFloat(summary.totalValue || 0) * toUsd;
    const cashFree = parseFloat(summary.cash?.availableToTrade || 0) * toUsd;
    const cashInPies = parseFloat(summary.cash?.inPies || 0) * toUsd;
    const cashTotal = cashFree + cashInPies;
    const investedValue = parseFloat(summary.investments?.currentValue || 0) * toUsd;
    const unrealizedPnl = parseFloat(summary.investments?.unrealizedProfitLoss || 0) * toUsd;
    const totalCost = parseFloat(summary.investments?.totalCost || 0) * toUsd;
    const pnlPct = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

    const balances = [];

    if (cashTotal > 0) {
      balances.push({
        asset: 'Cash (T212)',
        free: cashFree.toString(),
        locked: cashInPies.toString(),
        valueUsdt: cashTotal,
        currentPrice: 1,
        avgEntryPrice: 1,
        pnl: 0,
        pnlPct: 0,
        type: 'Spot'
      });
    }

    if (investedValue > 0) {
      balances.push({
        asset: 'Stocks (T212)',
        free: investedValue.toString(),
        locked: '0',
        valueUsdt: investedValue,
        currentPrice: 1,
        avgEntryPrice: 0,
        pnl: unrealizedPnl,
        pnlPct,
        type: 'Spot'
      });
    }

    return { balances, totalUsdt: totalValue };
  } catch (e) {
    console.error('Trading 212 balances error:', e.message);
    throw e;
  }
}

async function getPositions() {
  return [];
}

async function getSpotPositions(apiKey, apiSecret) {
  try {
    const [positions, summary] = await Promise.all([
      request(apiKey, apiSecret, '/equity/positions'),
      request(apiKey, apiSecret, '/equity/account/summary')
    ]);

    if (!Array.isArray(positions)) return [];

    const currency = summary.currency || 'USD';
    const toUsd = await getUsdRate(currency);

    return positions
      .filter(p => parseFloat(p.quantity || 0) > 0)
      .map(p => {
        const ticker = parseTicker(p.instrument?.ticker || p.ticker || '');
        const name = p.instrument?.name || ticker;
        const qty = parseFloat(p.quantity || 0);
        const avgEntry = parseFloat(p.averagePricePaid || p.averagePrice || 0) * toUsd;
        const currentPrice = parseFloat(p.currentPrice || 0) * toUsd;
        const valueUsdt = qty * currentPrice;
        const openValue = qty * avgEntry;
        const pnl = (currentPrice - avgEntry) * qty;
        const pnlPct = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0;
        const openDate = p.createdAt || p.initialFillDate || null;

        return { asset: ticker, name, quantity: qty, currentPrice, valueUsdt, avgEntryPrice: avgEntry, openValue, openDate, pnl, pnlPct };
      });
  } catch (e) {
    console.error('Trading 212 spot positions error:', e.message);
    return [];
  }
}

// Trading 212's order history endpoint is account-wide (not limited to
// currently-held tickers), giving broad coverage like Kraken.
async function getTradeHistory(apiKey, apiSecret) {
  const summary = await request(apiKey, apiSecret, '/equity/account/summary');
  const currency = summary.currency || 'USD';
  const toUsd = await getUsdRate(currency);

  let allItems = [];
  let cursor = null;
  for (let page = 0; page < 4; page++) {
    try {
      const path = cursor ? `/equity/history/orders?cursor=${cursor}&limit=50` : '/equity/history/orders?limit=50';
      const res = await request(apiKey, apiSecret, path);
      allItems = allItems.concat(res.items || []);
      if (!res.nextPagePath) break;
      const match = res.nextPagePath.match(/cursor=([^&]+)/);
      cursor = match ? match[1] : null;
      if (!cursor) break;
    } catch (e) {
      // First page failing means the request itself is broken (bad key, network) —
      // surface it. A later page failing after some data was already fetched is tolerated.
      if (page === 0) throw e;
      break;
    }
  }

  const byAsset = {};
  allItems.forEach(item => {
    const order = item.order || {};
    if (order.status !== 'FILLED') return;
    const ticker = parseTicker(order.ticker);
    const qty = parseFloat(order.filledQuantity || 0);
    const price = parseFloat(item.fill?.price || 0) * toUsd;
    const date = order.createdAt || item.fill?.filledAt;
    if (qty <= 0 || price <= 0 || !date) return;

    const trade = {
      asset: ticker,
      side: order.side === 'BUY' ? 'buy' : 'sell',
      qty,
      price,
      date: new Date(date).toISOString()
    };
    if (!byAsset[ticker]) byAsset[ticker] = [];
    byAsset[ticker].push(trade);
  });

  let result = [];
  Object.values(byAsset).forEach(trades => {
    trades.sort((a, b) => new Date(a.date) - new Date(b.date));
    result = result.concat(computeRealizedPnl(trades));
  });

  return result.sort((a, b) => new Date(b.date) - new Date(a.date));
}

module.exports = { getBalances, getPositions, getSpotPositions, getTradeHistory };
