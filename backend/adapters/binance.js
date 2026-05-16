const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = 'https://api.binance.com';
const FUTURES_URL = 'https://fapi.binance.com';

function signRequest(secret, params) {
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return {
    ...params,
    signature: crypto.createHmac('sha256', secret).update(queryString).digest('hex')
  };
}

async function request(baseUrl, apiKey, secret, endpoint, params = {}) {
  const timestamp = Date.now();
  const signedParams = signRequest(secret, { ...params, timestamp });
  const queryString = new URLSearchParams(signedParams).toString();
  const response = await axios.get(`${baseUrl}${endpoint}?${queryString}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10000
  });
  return response.data;
}

async function getSpotBalances(apiKey, secret) {
  const [accountData, pricesData] = await Promise.all([
    request(BASE_URL, apiKey, secret, '/api/v3/account'),
    axios.get(`${BASE_URL}/api/v3/ticker/price`, { timeout: 10000 })
  ]);

  const priceMap = {};
  pricesData.data.forEach(p => { priceMap[p.symbol] = parseFloat(p.price); });

  const balances = accountData.balances.filter(b =>
    parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
  );

  let totalUsdt = 0;
  const balancesWithValue = balances.map(b => {
    const amount = parseFloat(b.free) + parseFloat(b.locked);
    let valueUsdt = 0;
    let currentPrice = 0;

    if (b.asset === 'USDT' || b.asset === 'USDC') {
      valueUsdt = amount;
      currentPrice = 1;
    } else {
      currentPrice = priceMap[`${b.asset}USDT`] || priceMap[`${b.asset}USDC`] || 0;
      valueUsdt = amount * currentPrice;
    }

    totalUsdt += valueUsdt;
    return {
      asset: b.asset, free: b.free, locked: b.locked,
      valueUsdt, currentPrice,
      avgEntryPrice: 0, pnl: 0, pnlPct: 0,
      type: 'Spot'
    };
  });

  return { balances: balancesWithValue, totalUsdt };
}

async function getFuturesBalances(apiKey, secret) {
  try {
    const data = await request(FUTURES_URL, apiKey, secret, '/fapi/v2/account');
    const balances = data.assets
      .filter(a => parseFloat(a.walletBalance) > 0)
      .map(a => ({
        asset: a.asset,
        free: a.availableBalance,
        locked: (parseFloat(a.walletBalance) - parseFloat(a.availableBalance)).toString(),
        valueUsdt: parseFloat(a.marginBalance),
        currentPrice: 1, avgEntryPrice: 1, pnl: 0, pnlPct: 0,
        type: 'Futures'
      }));
    return { balances, totalUsdt: balances.reduce((s, b) => s + b.valueUsdt, 0) };
  } catch (e) {
    console.error('Erro futures Binance:', e.message);
    return { balances: [], totalUsdt: 0 };
  }
}

async function getFuturesPositions(apiKey, secret) {
  try {
    const data = await request(FUTURES_URL, apiKey, secret, '/fapi/v2/positionRisk');
    
    const active = data.filter(p => 
      Math.abs(parseFloat(p.positionAmt)) > 0 &&
      parseFloat(p.entryPrice) > 0
    );
    
    return active.map(p => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? 'Buy' : 'Sell',
      size: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      pnl: parseFloat(p.unRealizedProfit),
      pnlPct: parseFloat(p.entryPrice) > 0
        ? ((parseFloat(p.markPrice) - parseFloat(p.entryPrice)) / parseFloat(p.entryPrice)) * 100
        : 0,
      leverage: p.leverage,
      liquidationPrice: parseFloat(p.liquidationPrice)
    }));
  } catch (e) {
    console.error('Erro posições Binance:', e.message);
    return [];
  }
}

async function getBalances(apiKey, secret) {
  const [spot, futures] = await Promise.allSettled([
    getSpotBalances(apiKey, secret),
    getFuturesBalances(apiKey, secret)
  ]);

  const spotData = spot.status === 'fulfilled' ? spot.value : { balances: [], totalUsdt: 0 };
  const futuresData = futures.status === 'fulfilled' ? futures.value : { balances: [], totalUsdt: 0 };

  return {
    balances: [...spotData.balances, ...futuresData.balances],
    totalUsdt: spotData.totalUsdt + futuresData.totalUsdt
  };
}

const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'USDP', 'USDD']);

async function getSpotPositions(apiKey, secret) {
  const [accountData, pricesData] = await Promise.all([
    request(BASE_URL, apiKey, secret, '/api/v3/account'),
    axios.get(`${BASE_URL}/api/v3/ticker/price`, { timeout: 10000 })
  ]);

  const priceMap = {};
  pricesData.data.forEach(p => { priceMap[p.symbol] = parseFloat(p.price); });

  const holdings = accountData.balances.filter(b => {
    const amount = parseFloat(b.free) + parseFloat(b.locked);
    return amount > 0 && !STABLECOINS.has(b.asset);
  });

  const positions = await Promise.all(holdings.map(async b => {
    const qty = parseFloat(b.free) + parseFloat(b.locked);
    const currentPrice = priceMap[`${b.asset}USDT`] || priceMap[`${b.asset}USDC`] || 0;
    const valueUsdt = qty * currentPrice;
    if (valueUsdt < 1) return null;

    let avgEntryPrice = 0, openDate = null, pnl = 0, pnlPct = 0, openValue = 0;

    try {
      const symbol = priceMap[`${b.asset}USDT`] ? `${b.asset}USDT` : `${b.asset}USDC`;
      const trades = await request(BASE_URL, apiKey, secret, '/api/v3/myTrades', { symbol, limit: 1000 });

      if (trades.length > 0) {
        let totalQty = 0, totalCost = 0, earliestTime = Infinity;
        trades.forEach(t => {
          const tQty = parseFloat(t.qty);
          const tPrice = parseFloat(t.price);
          if (t.isBuyer) { totalQty += tQty; totalCost += tQty * tPrice; }
          else { totalQty -= tQty; totalCost -= tQty * tPrice; }
          if (t.time < earliestTime) earliestTime = t.time;
        });

        if (totalQty > 0) {
          avgEntryPrice = totalCost / totalQty;
          openDate = earliestTime < Infinity ? new Date(earliestTime).toISOString() : null;
          openValue = avgEntryPrice * qty;
          pnl = (currentPrice - avgEntryPrice) * qty;
          pnlPct = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
        }
      }
    } catch (e) { /* trade history unavailable */ }

    return { asset: b.asset, quantity: qty, currentPrice, valueUsdt, avgEntryPrice, openValue, openDate, pnl, pnlPct };
  }));

  return positions.filter(Boolean);
}

module.exports = { getBalances, getFuturesPositions, getSpotPositions };