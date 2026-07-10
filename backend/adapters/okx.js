const crypto = require('crypto');
const axios = require('axios');
const { computeRealizedPnl } = require('../utils/pnl');

const BASE_URL = 'https://www.okx.com';

function signRequest(secret, timestamp, method, path, body = '') {
  const message = timestamp + method + path + body;
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

// getSpotPositions/getTradeHistory both call getBalances() internally, and the
// dashboard also polls getBalances directly — each re-fetches
// /api/v5/account/balance (and per-asset /api/v5/trade/fills) every cycle.
// Cache in-flight/recent responses per (apiKey, method, path, params) so
// concurrent callers share one upstream call.
const requestCache = new Map(); // cacheKey -> { promise, expiresAt }
const REQUEST_CACHE_TTL_MS = 20000;

async function request(apiKey, secret, passphrase, method, path, params = {}) {
  const cacheKey = `${apiKey}:${method}:${path}:${JSON.stringify(params)}`;
  const cached = requestCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const timestamp = new Date().toISOString();
    const queryString = method === 'GET' && Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString()
      : '';
    const body = method !== 'GET' && Object.keys(params).length
      ? JSON.stringify(params)
      : '';
    const fullPath = path + queryString;
    const signature = signRequest(secret, timestamp, method, fullPath, body);

    const response = await axios({
      method,
      url: `${BASE_URL}${fullPath}`,
      headers: {
        'OK-ACCESS-KEY': apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': passphrase,
        'Content-Type': 'application/json'
      },
      data: body || undefined,
      timeout: 10000
    });

    if (response.data.code !== '0') {
      throw new Error(`OKX Error: ${response.data.msg}`);
    }

    return response.data.data;
  })();
  promise.catch(() => requestCache.delete(cacheKey)); // don't cache failures
  requestCache.set(cacheKey, { promise, expiresAt: Date.now() + REQUEST_CACHE_TTL_MS });
  return promise;
}

async function getBalances(apiKey, secret, passphrase) {
  try {
    const data = await request(apiKey, secret, passphrase, 'GET', '/api/v5/account/balance');
    
    let totalUsdt = 0;
    const balances = [];

    const details = data[0]?.details || [];
    details.forEach(d => {
      const amount = parseFloat(d.cashBal);
      if (amount <= 0) return;

      const valueUsdt = parseFloat(d.usdValue || 0);
      const currentPrice = amount > 0 ? valueUsdt / amount : 0;

      totalUsdt += valueUsdt;
      balances.push({
        asset: d.ccy,
        free: d.availBal,
        locked: (amount - parseFloat(d.availBal)).toString(),
        valueUsdt,
        currentPrice,
        avgEntryPrice: 0,
        pnl: 0,
        pnlPct: 0,
        type: 'Spot'
      });
    });

    return { balances, totalUsdt };
  } catch (e) {
    console.error('Erro OKX:', e.message);
    throw e;
  }
}

async function getPositions(apiKey, secret, passphrase) {
  try {
    const data = await request(apiKey, secret, passphrase, 'GET', '/api/v5/account/positions');
    
    return data
      .filter(p => parseFloat(p.pos) !== 0)
      .map(p => ({
        symbol: p.instId,
        side: parseFloat(p.pos) > 0 ? 'Buy' : 'Sell',
        size: Math.abs(parseFloat(p.pos)),
        entryPrice: parseFloat(p.avgPx),
        markPrice: parseFloat(p.markPx),
        pnl: parseFloat(p.upl),
        pnlPct: parseFloat(p.uplRatio) * 100,
        leverage: p.lever,
        liquidationPrice: parseFloat(p.liqPx || 0)
      }));
  } catch (e) {
    return [];
  }
}

const OKX_STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP']);

async function getSpotPositions(apiKey, secret, passphrase) {
  const { balances } = await getBalances(apiKey, secret, passphrase);
  const holdings = balances.filter(b => !OKX_STABLECOINS.has(b.asset) && b.valueUsdt >= 1);

  const positions = await Promise.all(holdings.map(async b => {
    const qty = parseFloat(b.free) + parseFloat(b.locked);
    let avgEntryPrice = 0, openDate = null, pnl = 0, pnlPct = 0, openValue = 0;

    try {
      const fills = await request(apiKey, secret, passphrase, 'GET', '/api/v5/trade/fills', {
        instType: 'SPOT', instId: `${b.asset}-USDT`, limit: '100'
      });

      if (fills.length > 0) {
        let totalQty = 0, totalCost = 0, earliestTime = Infinity;
        fills.forEach(f => {
          const fQty = parseFloat(f.fillSz);
          const fPrice = parseFloat(f.fillPx);
          const fTime = parseInt(f.ts);
          if (f.side === 'buy') { totalQty += fQty; totalCost += fQty * fPrice; }
          else { totalQty -= fQty; totalCost -= fQty * fPrice; }
          if (fTime < earliestTime) earliestTime = fTime;
        });

        if (totalQty > 0) {
          avgEntryPrice = totalCost / totalQty;
          openDate = earliestTime < Infinity ? new Date(earliestTime).toISOString() : null;
          openValue = avgEntryPrice * qty;
          pnl = (b.currentPrice - avgEntryPrice) * qty;
          pnlPct = ((b.currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
        }
      }
    } catch (e) { /* fills unavailable */ }

    return { asset: b.asset, quantity: qty, currentPrice: b.currentPrice, valueUsdt: b.valueUsdt, avgEntryPrice, openValue, openDate, pnl, pnlPct };
  }));

  return positions.filter(Boolean);
}

// OKX only exposes fills per instrument, so coverage is limited to assets
// currently (or recently, while still held) in the account.
async function getTradeHistory(apiKey, secret, passphrase) {
  const { balances } = await getBalances(apiKey, secret, passphrase);
  const holdings = balances.filter(b => !OKX_STABLECOINS.has(b.asset));

  const perAsset = await Promise.all(holdings.map(async b => {
    try {
      const fills = await request(apiKey, secret, passphrase, 'GET', '/api/v5/trade/fills', {
        instType: 'SPOT', instId: `${b.asset}-USDT`, limit: '100'
      });
      const normalized = fills.map(f => ({
        asset: b.asset,
        side: f.side === 'buy' ? 'buy' : 'sell',
        qty: parseFloat(f.fillSz),
        price: parseFloat(f.fillPx),
        date: new Date(parseInt(f.ts)).toISOString()
      })).sort((a, c) => new Date(a.date) - new Date(c.date));
      return computeRealizedPnl(normalized);
    } catch (e) {
      return [];
    }
  }));

  return perAsset.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
}

module.exports = { getBalances, getPositions, getSpotPositions, getTradeHistory };