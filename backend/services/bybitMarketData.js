const axios = require('axios');

const BASE_URL = 'https://api.bybit.com';

// Maps our friendly timeframe strings to Bybit's kline interval codes.
const INTERVAL_MAP = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W', '1M': 'M'
};

function toBybitInterval(timeframe) {
  const interval = INTERVAL_MAP[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return interval;
}

function normalizeCandle(row) {
  // Bybit order: [startTime, open, high, low, close, volume, turnover]
  return {
    time: parseInt(row[0]),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5])
  };
}

// Fetches the most recent candles for live use (alerts, live paper trading).
// Bybit sorts results newest-first — we return oldest-first for easier processing.
async function getRecentKlines(symbol, timeframe, limit = 2) {
  const interval = toBybitInterval(timeframe);
  const res = await axios.get(`${BASE_URL}/v5/market/kline`, {
    params: { category: 'linear', symbol, interval, limit },
    timeout: 10000
  });
  if (res.data.retCode !== 0) throw new Error(`Bybit kline error: ${res.data.retMsg}`);
  const list = res.data.result?.list || [];
  return list.map(normalizeCandle).sort((a, b) => a.time - b.time);
}

// Returns the last fully-closed candle (i.e. not the one still forming).
async function getLastClosedCandle(symbol, timeframe) {
  const candles = await getRecentKlines(symbol, timeframe, 3);
  const now = Date.now();
  const closed = candles.filter(c => c.time + timeframeMs(timeframe) <= now);
  return closed.length ? closed[closed.length - 1] : null;
}

function timeframeMs(timeframe) {
  const unit = timeframe.slice(-1);
  const value = parseInt(timeframe);
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd' || unit === 'D') return value * 24 * 60 * 60 * 1000;
  if (unit === 'w' || unit === 'W') return value * 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000; // month, approximate
}

// Fetches a full historical range for backtesting, paginating backward in
// 1000-candle pages (Bybit's max per request) until startTime is covered.
async function getHistoricalKlines(symbol, timeframe, startTime, endTime = Date.now()) {
  const interval = toBybitInterval(timeframe);
  const allCandles = [];
  let currentEnd = endTime;
  const MAX_PAGES = 500; // safety cap — 500k candles is far beyond any 1-year request

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await axios.get(`${BASE_URL}/v5/market/kline`, {
      params: { category: 'linear', symbol, interval, start: startTime, end: currentEnd, limit: 1000 },
      timeout: 15000
    });
    if (res.data.retCode !== 0) throw new Error(`Bybit kline error: ${res.data.retMsg}`);
    const list = (res.data.result?.list || []).map(normalizeCandle);
    if (!list.length) break;

    allCandles.push(...list);
    const oldestInPage = Math.min(...list.map(c => c.time));
    if (oldestInPage <= startTime || list.length < 1000) break;
    currentEnd = oldestInPage - 1;
  }

  const seen = new Set();
  return allCandles
    .filter(c => c.time >= startTime && c.time <= endTime)
    .filter(c => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time);
}

// Current live price (for simple price_above/price_below alerts, not tied to a candle close).
async function getTickerPrice(symbol) {
  const res = await axios.get(`${BASE_URL}/v5/market/tickers`, {
    params: { category: 'linear', symbol },
    timeout: 10000
  });
  if (res.data.retCode !== 0) throw new Error(`Bybit ticker error: ${res.data.retMsg}`);
  const ticker = res.data.result?.list?.[0];
  if (!ticker) throw new Error(`No ticker data for ${symbol}`);
  return parseFloat(ticker.lastPrice);
}

module.exports = { getRecentKlines, getLastClosedCandle, getHistoricalKlines, getTickerPrice, toBybitInterval, timeframeMs };
