const crypto = require('crypto');
const axios = require('axios');
const { computeRealizedPnl } = require('../utils/pnl');

const BASE_URL = 'https://api.coinbase.com';

function signRequest(secret, timestamp, method, path, body = '') {
  const message = timestamp + method + path + body;
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

async function request(apiKey, secret, method, path, body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signRequest(secret, timestamp, method, path, body);

  const response = await axios({
    method,
    url: `${BASE_URL}${path}`,
    headers: {
      'CB-ACCESS-KEY': apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-VERSION': '2016-02-18',
      'Content-Type': 'application/json'
    },
    data: body || undefined,
    timeout: 10000
  });
  return response.data;
}

async function getBalances(apiKey, secret) {
  try {
    const data = await request(apiKey, secret, 'GET', '/v2/accounts');
    
    let totalUsdt = 0;
    const balances = [];

    for (const account of data.data) {
      const amount = parseFloat(account.balance.amount);
      if (amount <= 0) continue;

      const asset = account.balance.currency;
      let valueUsdt = 0;
      let currentPrice = 0;

      if (asset === 'USD' || asset === 'USDT' || asset === 'USDC') {
        valueUsdt = amount;
        currentPrice = 1;
      } else {
        try {
          const priceData = await axios.get(`${BASE_URL}/v2/prices/${asset}-USD/spot`, { timeout: 5000 });
          currentPrice = parseFloat(priceData.data.data.amount);
          valueUsdt = amount * currentPrice;
        } catch (e) { }
      }

      totalUsdt += valueUsdt;
      balances.push({
        asset,
        free: account.balance.amount,
        locked: '0',
        valueUsdt,
        currentPrice,
        avgEntryPrice: 0,
        pnl: 0,
        pnlPct: 0,
        type: 'Spot'
      });
    }

    return { balances, totalUsdt };
  } catch (e) {
    console.error('Erro Coinbase:', e.message);
    throw e;
  }
}

async function getPositions() {
  return [];
}

const CB_STABLECOINS = new Set(['USD', 'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP']);

async function getCoinbaseOrderSide(apiKey, secret, accountId, side) {
  try {
    const data = await request(apiKey, secret, 'GET', `/v2/accounts/${accountId}/${side}s`);
    return (data.data || []).filter(o => o.status === 'completed');
  } catch (e) {
    return [];
  }
}

async function getSpotPositions(apiKey, secret) {
  const accountsData = await request(apiKey, secret, 'GET', '/v2/accounts');
  const accounts = (accountsData.data || []).filter(acc => {
    const amount = parseFloat(acc.balance.amount);
    return amount > 0 && !CB_STABLECOINS.has(acc.balance.currency);
  });

  const positions = await Promise.all(accounts.map(async acc => {
    const asset = acc.balance.currency;
    const qty = parseFloat(acc.balance.amount);

    let currentPrice = 0, valueUsdt = 0;
    try {
      const priceData = await axios.get(`${BASE_URL}/v2/prices/${asset}-USD/spot`, { timeout: 5000 });
      currentPrice = parseFloat(priceData.data.data.amount);
      valueUsdt = qty * currentPrice;
    } catch (e) {}

    if (valueUsdt < 1) return null;

    let avgEntryPrice = 0, openDate = null, pnl = 0, pnlPct = 0, openValue = 0;

    try {
      const [buys, sells] = await Promise.all([
        getCoinbaseOrderSide(apiKey, secret, acc.id, 'buy'),
        getCoinbaseOrderSide(apiKey, secret, acc.id, 'sell')
      ]);

      let totalQty = 0, totalCost = 0, earliestTime = Infinity;

      buys.forEach(o => {
        const oQty = parseFloat(o.amount?.amount || 0);
        const oPrice = parseFloat(o.unit_price?.amount || 0) ||
          (o.subtotal?.amount && oQty > 0 ? parseFloat(o.subtotal.amount) / oQty : 0);
        const oTime = new Date(o.created_at).getTime();
        if (oQty > 0 && oPrice > 0) {
          totalQty += oQty;
          totalCost += oQty * oPrice;
          if (oTime < earliestTime) earliestTime = oTime;
        }
      });

      sells.forEach(o => {
        const oQty = parseFloat(o.amount?.amount || 0);
        const oPrice = parseFloat(o.unit_price?.amount || 0) ||
          (o.subtotal?.amount && oQty > 0 ? parseFloat(o.subtotal.amount) / oQty : 0);
        if (oQty > 0) { totalQty -= oQty; totalCost -= oQty * oPrice; }
      });

      if (totalQty > 0) {
        avgEntryPrice = totalCost / totalQty;
        openDate = earliestTime < Infinity ? new Date(earliestTime).toISOString() : null;
        openValue = avgEntryPrice * qty;
        pnl = (currentPrice - avgEntryPrice) * qty;
        pnlPct = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
      }
    } catch (e) { /* order history unavailable */ }

    return { asset, quantity: qty, currentPrice, valueUsdt, avgEntryPrice, openValue, openDate, pnl, pnlPct };
  }));

  return positions.filter(Boolean);
}

// Coinbase only exposes buy/sell history per account, so coverage is limited
// to assets currently (or recently, while still held) in the account.
async function getTradeHistory(apiKey, secret) {
  const accountsData = await request(apiKey, secret, 'GET', '/v2/accounts');
  const accounts = (accountsData.data || []).filter(acc => {
    const amount = parseFloat(acc.balance.amount);
    return amount > 0 && !CB_STABLECOINS.has(acc.balance.currency);
  });

  function normalize(orders, side, asset) {
    return orders.map(o => {
      const qty = parseFloat(o.amount?.amount || 0);
      const price = parseFloat(o.unit_price?.amount || 0) ||
        (o.subtotal?.amount && qty > 0 ? parseFloat(o.subtotal.amount) / qty : 0);
      return { asset, side, qty, price, date: new Date(o.created_at).toISOString() };
    }).filter(t => t.qty > 0 && t.price > 0);
  }

  const perAsset = await Promise.all(accounts.map(async acc => {
    const asset = acc.balance.currency;
    try {
      const [buys, sells] = await Promise.all([
        getCoinbaseOrderSide(apiKey, secret, acc.id, 'buy'),
        getCoinbaseOrderSide(apiKey, secret, acc.id, 'sell')
      ]);

      const normalized = [...normalize(buys, 'buy', asset), ...normalize(sells, 'sell', asset)]
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      return computeRealizedPnl(normalized);
    } catch (e) {
      return [];
    }
  }));

  return perAsset.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
}

module.exports = { getBalances, getPositions, getSpotPositions, getTradeHistory };