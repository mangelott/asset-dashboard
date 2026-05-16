const axios = require('axios');

const BASE_URL = 'https://live.trading212.com/api/v0';

function buildAuthHeader(apiKey, apiSecret) {
  if (apiSecret) {
    return 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  }
  return apiKey;
}

async function request(apiKey, apiSecret, path) {
  const response = await axios.get(`${BASE_URL}${path}`, {
    headers: { Authorization: buildAuthHeader(apiKey, apiSecret) },
    timeout: 10000
  });
  return response.data;
}

async function getUsdRate(currency) {
  if (currency === 'USD') return 1;
  try {
    const res = await axios.get(`https://api.frankfurter.app/latest?from=${currency}&to=USD`, { timeout: 5000 });
    return res.data?.rates?.USD || 1;
  } catch (e) {
    console.error(`Trading 212: failed to fetch ${currency}/USD rate`, e.message);
    return 1;
  }
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
        avgEntryPrice: totalCost > 0 ? totalCost / investedValue : 1,
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

module.exports = { getBalances, getPositions, getSpotPositions };
