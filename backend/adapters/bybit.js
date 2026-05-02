const crypto = require('crypto');
const axios = require('axios');

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

async function request(apiKey, secret, endpoint, params = {}) {
  const { timestamp, recvWindow, signature } = signRequest(apiKey, secret, params);
  const queryString = new URLSearchParams(params).toString();
  const response = await axios.get(`${BASE_URL}${endpoint}?${queryString}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': signature
    }
  });
  return response.data;
}

async function getSpotPnl(apiKey, secret, coin, currentPrice) {
  try {
    const data = await request(apiKey, secret, '/v5/execution/list', {
      category: 'spot', symbol: `${coin}USDT`, limit: 100
    });
    if (!data.result?.list?.length) return { avgEntryPrice: 0, pnl: 0, pnlPct: 0 };

    let totalQty = 0, totalCost = 0;
    data.result.list.forEach(t => {
      const qty = parseFloat(t.execQty);
      const price = parseFloat(t.execPrice);
      if (t.side === 'Buy') { totalQty += qty; totalCost += qty * price; }
      else { totalQty -= qty; totalCost -= qty * price; }
    });

    if (totalQty <= 0) return { avgEntryPrice: 0, pnl: 0, pnlPct: 0 };
    const avgEntryPrice = totalCost / totalQty;
    const pnl = (currentPrice - avgEntryPrice) * totalQty;
    const pnlPct = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
    return { avgEntryPrice, pnl, pnlPct };
  } catch (e) {
    return { avgEntryPrice: 0, pnl: 0, pnlPct: 0 };
  }
}

async function getBalances(apiKey, secret) {
  const data = await request(apiKey, secret, '/v5/account/wallet-balance', { accountType: 'UNIFIED' });

  console.log('[Bybit] wallet-balance retCode:', data.retCode, 'retMsg:', data.retMsg, 'list length:', data.result?.list?.length);
  if (data.result?.list?.[0]) console.log('[Bybit] totalEquity:', data.result.list[0].totalEquity, 'coins:', data.result.list[0].coin?.length);

  if (!data.result?.list) throw new Error('Erro ao buscar saldo Bybit');

  const account = data.result.list[0];
  const totalUsdt = parseFloat(account.totalEquity || 0);

  const coins = (account.coin || []).filter(c => parseFloat(c.equity) > 0);

  const balances = await Promise.all(coins.map(async c => {
    const currentPrice = c.coin === 'USDT' ? 1 : parseFloat(c.usdValue || 0) / parseFloat(c.equity || 1);
    let avgEntryPrice = 0, pnl = 0, pnlPct = 0;

    if (c.coin !== 'USDT' && currentPrice > 0) {
      const spotPnl = await getSpotPnl(apiKey, secret, c.coin, currentPrice);
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

module.exports = { getBalances, getPositions };