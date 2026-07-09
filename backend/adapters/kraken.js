const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');
const { computeRealizedPnl } = require('../utils/pnl');

const BASE_URL = 'https://api.kraken.com';

function signRequest(secret, path, nonce, data) {
  const message = qs.stringify(data);
  const secretBuffer = Buffer.from(secret, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + message).digest('binary');
  const hmac = crypto.createHmac('sha512', secretBuffer).update(path + hash, 'binary').digest('base64');
  return hmac;
}

async function request(apiKey, secret, path, data = {}) {
  const nonce = Date.now().toString();
  data.nonce = nonce;
  const signature = signRequest(secret, path, nonce, data);

  const response = await axios.post(`${BASE_URL}${path}`, qs.stringify(data), {
    headers: {
      'API-Key': apiKey,
      'API-Sign': signature,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 10000
  });

  if (response.data.error && response.data.error.length > 0) {
    throw new Error(response.data.error.join(', '));
  }

  return response.data.result;
}

// Kraken's public Ticker endpoint rejects the ENTIRE batch if any single pair in it is
// unknown. Legacy assets use the "ZUSD" suffix (XXBTZUSD, XETHZUSD) but newer listings
// (SOL, ADA, AVAX, ...) use plain "USD" (SOLUSD) — mixing both in one request throws
// "EQuery:Unknown asset pair" for the whole call, silently zeroing out every price.
// Fetch each asset's price independently so one unknown pair can't poison the rest.
async function fetchKrakenPrice(rawAsset) {
  for (const suffix of ['ZUSD', 'USD']) {
    try {
      const res = await axios.get(`${BASE_URL}/0/public/Ticker?pair=${rawAsset}${suffix}`, { timeout: 10000 });
      const result = res.data.result || {};
      const key = Object.keys(result)[0];
      if (key) return parseFloat(result[key].c[0]);
    } catch (e) { /* try next suffix */ }
  }
  return 0;
}

async function getBalances(apiKey, secret) {
  try {
    const balanceData = await request(apiKey, secret, '/0/private/Balance');

    // Buscar preços
    const priceMap = {};
    const assetsToPrice = Object.keys(balanceData).filter(a => a !== 'ZUSD' && a !== 'USDT' && a !== 'USDC');
    await Promise.all(assetsToPrice.map(async a => {
      priceMap[`${a}ZUSD`] = await fetchKrakenPrice(a);
    }));

    let totalUsdt = 0;
    const balances = Object.entries(balanceData)
      .filter(([, amount]) => parseFloat(amount) > 0)
      .map(([asset, amount]) => {
        const cleanAsset = asset.replace(/^[XZ]/, '')
        const qty = parseFloat(amount);
        let valueUsdt = 0;
        let currentPrice = 0;

        if (cleanAsset === 'USD' || asset === 'ZUSD' || cleanAsset === 'USDT' || cleanAsset === 'USDC') {
          valueUsdt = qty;
          currentPrice = 1;
        } else {
          currentPrice = priceMap[`${asset}ZUSD`] || 0;
          valueUsdt = qty * currentPrice;
        }

        totalUsdt += valueUsdt;
        return {
          asset: cleanAsset,
          free: amount,
          locked: '0',
          valueUsdt,
          currentPrice,
          avgEntryPrice: 0,
          pnl: 0,
          pnlPct: 0,
          type: 'Spot'
        };
      });

    return { balances, totalUsdt };
  } catch (e) {
    console.error('Erro Kraken:', e.message);
    throw e;
  }
}

async function getPositions(apiKey, secret) {
  try {
    const data = await request(apiKey, secret, '/0/private/OpenPositions');
    return Object.entries(data).map(([id, p]) => ({
      symbol: p.pair,
      side: p.type === 'buy' ? 'Buy' : 'Sell',
      size: parseFloat(p.vol),
      entryPrice: parseFloat(p.cost) / parseFloat(p.vol),
      markPrice: parseFloat(p.value) / parseFloat(p.vol),
      pnl: parseFloat(p.net),
      pnlPct: (parseFloat(p.net) / parseFloat(p.cost)) * 100,
      leverage: '1',
      liquidationPrice: 0
    }));
  } catch (e) {
    return [];
  }
}

const KRAKEN_STABLECOINS = new Set(['USD', 'USDT', 'USDC', 'DAI', 'EUR', 'GBP', 'ZUSD', 'ZEUR', 'ZGBP']);
const KRAKEN_QUOTE_SUFFIXES = ['ZUSD', 'ZEUR', 'ZGBP', 'XXBT', 'XBT', 'USD', 'EUR', 'GBP'];

function parseKrakenPairBase(pair) {
  let base = pair;
  for (const q of KRAKEN_QUOTE_SUFFIXES) {
    if (base.endsWith(q)) { base = base.slice(0, -q.length); break; }
  }
  // Remove single leading X or Z prefix (Kraken convention)
  return base.replace(/^[XZ](?=[A-Z])/, '');
}

async function fetchKrakenTradesHistory(apiKey, secret, strict = false) {
  const allTrades = {};
  let offset = 0;
  // Fetch up to 5 pages (250 trades)
  for (let page = 0; page < 5; page++) {
    try {
      const data = await request(apiKey, secret, '/0/private/TradesHistory', { ofs: offset });
      const trades = data.trades || {};
      const keys = Object.keys(trades);
      if (!keys.length) break;
      keys.forEach(k => { allTrades[k] = trades[k]; });
      if (keys.length < 50) break;
      offset += 50;
    } catch (e) {
      console.error('Kraken TradesHistory error:', e.message);
      // In strict mode, a first-page failure means the request itself is broken
      // (bad key, network) — surface it instead of silently returning nothing.
      if (strict && page === 0) throw e;
      break;
    }
  }
  return allTrades;
}

async function getSpotPositions(apiKey, secret) {
  const [{ balances }, allTrades] = await Promise.all([
    getBalances(apiKey, secret),
    fetchKrakenTradesHistory(apiKey, secret)
  ]);

  const holdings = balances.filter(b => !KRAKEN_STABLECOINS.has(b.asset) && b.valueUsdt >= 1);
  if (!holdings.length) return [];

  // Group trades by parsed base asset
  const tradesByAsset = {};
  Object.values(allTrades).forEach(t => {
    const base = parseKrakenPairBase(t.pair);
    if (!base) return;
    if (!tradesByAsset[base]) tradesByAsset[base] = [];
    tradesByAsset[base].push(t);
  });

  return holdings.map(b => {
    const qty = parseFloat(b.free) + parseFloat(b.locked);
    const trades = tradesByAsset[b.asset] || [];

    let avgEntryPrice = 0, openDate = null, pnl = 0, pnlPct = 0, openValue = 0;

    if (trades.length > 0) {
      let totalQty = 0, totalCost = 0, earliestTime = Infinity;
      trades.forEach(t => {
        const tQty = parseFloat(t.vol);
        const tPrice = parseFloat(t.price);
        const tTime = parseFloat(t.time); // Unix seconds
        if (t.type === 'buy') { totalQty += tQty; totalCost += tQty * tPrice; }
        else { totalQty -= tQty; totalCost -= tQty * tPrice; }
        if (tTime < earliestTime) earliestTime = tTime;
      });

      if (totalQty > 0) {
        avgEntryPrice = totalCost / totalQty;
        openDate = earliestTime < Infinity ? new Date(earliestTime * 1000).toISOString() : null;
        openValue = avgEntryPrice * qty;
        pnl = (b.currentPrice - avgEntryPrice) * qty;
        pnlPct = ((b.currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
      }
    }

    return { asset: b.asset, quantity: qty, currentPrice: b.currentPrice, valueUsdt: b.valueUsdt, avgEntryPrice, openValue, openDate, pnl, pnlPct };
  });
}

// Kraken's TradesHistory is account-wide (not limited to currently-held
// assets), so this gives the best coverage among all adapters.
async function getTradeHistory(apiKey, secret) {
  const allTrades = await fetchKrakenTradesHistory(apiKey, secret, true);

  const byAsset = {};
  Object.values(allTrades).forEach(t => {
    const base = parseKrakenPairBase(t.pair);
    if (!base) return;
    const trade = {
      asset: base,
      side: t.type === 'buy' ? 'buy' : 'sell',
      qty: parseFloat(t.vol),
      price: parseFloat(t.price),
      date: new Date(parseFloat(t.time) * 1000).toISOString()
    };
    if (!byAsset[base]) byAsset[base] = [];
    byAsset[base].push(trade);
  });

  let result = [];
  Object.values(byAsset).forEach(trades => {
    trades.sort((a, b) => new Date(a.date) - new Date(b.date));
    result = result.concat(computeRealizedPnl(trades));
  });

  return result.sort((a, b) => new Date(b.date) - new Date(a.date));
}

module.exports = { getBalances, getPositions, getSpotPositions, getTradeHistory };