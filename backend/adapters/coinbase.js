const crypto = require('crypto');
const axios = require('axios');

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

module.exports = { getBalances, getPositions };