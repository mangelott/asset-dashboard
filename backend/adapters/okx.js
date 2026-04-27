const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = 'https://www.okx.com';

function signRequest(secret, timestamp, method, path, body = '') {
  const message = timestamp + method + path + body;
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

async function request(apiKey, secret, passphrase, method, path, params = {}) {
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

module.exports = { getBalances, getPositions };