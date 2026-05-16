const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');

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

async function getBalances(apiKey, secret) {
  try {
    const [balanceData, tickerData] = await Promise.all([
      request(apiKey, secret, '/0/private/Balance'),
      axios.get(`${BASE_URL}/0/public/Ticker`, { timeout: 10000 })
    ]);

    // Buscar preços
    const priceMap = {};
    try {
      const pairs = Object.keys(balanceData)
        .filter(a => a !== 'ZUSD' && a !== 'USDT' && a !== 'USDC')
        .map(a => `${a}ZUSD`)
        .join(',');

      if (pairs) {
        const prices = await axios.get(`${BASE_URL}/0/public/Ticker?pair=${pairs}`, { timeout: 10000 });
        Object.entries(prices.data.result || {}).forEach(([pair, data]) => {
          priceMap[pair] = parseFloat(data.c[0]);
        });
      }
    } catch (e) { }

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
          currentPrice = priceMap[`${asset}ZUSD`] || priceMap[`X${asset}ZUSD`] || 0;
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

async function fetchKrakenTradesHistory(apiKey, secret) {
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

module.exports = { getBalances, getPositions, getSpotPositions };