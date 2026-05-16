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

function parseTicker(ticker) {
  // "AAPL_US_EQ" → "AAPL", "VWRL_EQ" → "VWRL"
  return (ticker || '').replace(/(_US)?_EQ$/, '').replace(/_[A-Z]+$/, '') || ticker;
}

async function getBalances(apiKey, apiSecret) {
  try {
    const summary = await request(apiKey, apiSecret, '/equity/account/summary');
    const totalValue = parseFloat(summary.totalValue || 0);
    const cashFree = parseFloat(summary.cash?.availableToTrade || 0);
    const cashInPies = parseFloat(summary.cash?.inPies || 0);
    const cashTotal = cashFree + cashInPies;
    const investedValue = parseFloat(summary.investments?.currentValue || totalValue - cashTotal);
    const unrealizedPnl = parseFloat(summary.investments?.unrealizedProfitLoss || 0);
    const totalCost = parseFloat(summary.investments?.totalCost || 0);
    const pnlPct = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;
    const currency = summary.currency || 'GBP';

    const balances = [];

    if (cashTotal > 0) {
      balances.push({
        asset: `Cash (${currency})`,
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
        asset: `Stocks (${currency})`,
        free: investedValue.toString(),
        locked: '0',
        valueUsdt: investedValue,
        currentPrice: 1,
        avgEntryPrice: totalCost > 0 ? totalCost / (investedValue / 1) : 1,
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
    const positions = await request(apiKey, apiSecret, '/equity/positions');
    if (!Array.isArray(positions)) return [];

    return positions
      .filter(p => parseFloat(p.quantity || 0) > 0)
      .map(p => {
        const ticker = parseTicker(p.instrument?.ticker || p.ticker || '');
        const name = p.instrument?.name || ticker;
        const qty = parseFloat(p.quantity || 0);
        const avgEntry = parseFloat(p.averagePricePaid || p.averagePrice || 0);
        const currentPrice = parseFloat(p.currentPrice || 0);
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
