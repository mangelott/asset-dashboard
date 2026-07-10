// Pure simulation engine: given a strategy spec (the bounded DSL) and a
// chronological array of candles, walks bar-by-bar and simulates trades.
// No network calls, no DB access — fully deterministic given the same inputs.

const TAKER_FEE = 0.00055; // Bybit linear futures taker fee

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Wilder's RSI
function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function rollingHigh(highs, period) {
  const out = new Array(highs.length).fill(null);
  for (let i = period; i < highs.length; i++) {
    out[i] = Math.max(...highs.slice(i - period, i)); // excludes current bar — breakout of PRIOR range
  }
  return out;
}

function rollingLow(lows, period) {
  const out = new Array(lows.length).fill(null);
  for (let i = period; i < lows.length; i++) {
    out[i] = Math.min(...lows.slice(i - period, i));
  }
  return out;
}

// Precomputes every indicator series any entry rule in the spec needs.
function computeIndicators(spec, candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const series = {};

  (spec.entry_rules || []).forEach(rule => {
    if (rule.indicator === 'rsi') {
      const key = `rsi_${rule.period}`;
      if (!series[key]) series[key] = rsi(closes, rule.period);
    } else if (rule.indicator === 'ma_cross') {
      const fastKey = `sma_${rule.fast_period}`;
      const slowKey = `sma_${rule.slow_period}`;
      if (!series[fastKey]) series[fastKey] = sma(closes, rule.fast_period);
      if (!series[slowKey]) series[slowKey] = sma(closes, rule.slow_period);
    } else if (rule.indicator === 'price_vs_ma') {
      const key = `sma_${rule.period}`;
      if (!series[key]) series[key] = sma(closes, rule.period);
    } else if (rule.indicator === 'breakout') {
      const highKey = `high_${rule.period}`;
      const lowKey = `low_${rule.period}`;
      if (!series[highKey]) series[highKey] = rollingHigh(highs, rule.period);
      if (!series[lowKey]) series[lowKey] = rollingLow(lows, rule.period);
    }
  });

  return series;
}

// Evaluates one rule at bar index i. Returns { holds, side } or null if not enough warmup data yet.
function evalRule(rule, i, candles, series) {
  const close = candles[i].close;

  if (rule.indicator === 'rsi') {
    const value = series[`rsi_${rule.period}`][i];
    if (value === null) return null;
    const side = rule.comparator === 'below' ? 'long' : 'short';
    const holds = rule.comparator === 'below' ? value < rule.value : value > rule.value;
    return { holds, side };
  }

  if (rule.indicator === 'ma_cross') {
    const fast = series[`sma_${rule.fast_period}`];
    const slow = series[`sma_${rule.slow_period}`];
    if (i === 0 || fast[i] === null || slow[i] === null || fast[i - 1] === null || slow[i - 1] === null) return null;
    const side = rule.direction === 'bullish' ? 'long' : 'short';
    const holds = rule.direction === 'bullish'
      ? fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]
      : fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    return { holds, side };
  }

  if (rule.indicator === 'price_vs_ma') {
    const ma = series[`sma_${rule.period}`][i];
    if (ma === null) return null;
    const side = rule.comparator === 'above' ? 'long' : 'short';
    const holds = rule.comparator === 'above' ? close > ma : close < ma;
    return { holds, side };
  }

  if (rule.indicator === 'breakout') {
    const side = rule.direction === 'above' ? 'long' : 'short';
    const level = rule.direction === 'above' ? series[`high_${rule.period}`][i] : series[`low_${rule.period}`][i];
    if (level === null) return null;
    const holds = rule.direction === 'above' ? close > level : close < level;
    return { holds, side };
  }

  return null;
}

// Combines all rule evaluations for bar i into an entry decision.
function decideEntry(spec, i, candles, series) {
  const allowedSide = spec.side || 'both';
  const results = (spec.entry_rules || [])
    .map(rule => evalRule(rule, i, candles, series))
    .filter(r => r !== null)
    .filter(r => allowedSide === 'both' || r.side === allowedSide);

  if (!results.length) return null;

  if (spec.entry_logic === 'any') {
    const hit = results.find(r => r.holds);
    return hit ? hit.side : null;
  }

  // 'all' — group by side, enter if an entire side-group holds
  for (const side of ['long', 'short']) {
    const group = results.filter(r => r.side === side);
    if (group.length && group.every(r => r.holds)) return side;
  }
  return null;
}

function hasOppositeSignal(spec, side, i, candles, series) {
  const opposite = side === 'long' ? 'short' : 'long';
  return (spec.entry_rules || [])
    .map(rule => evalRule(rule, i, candles, series))
    .some(r => r && r.side === opposite && r.holds);
}

function runBacktest(spec, candles, startingCapital) {
  const exitRules = spec.exit_rules || {};
  const sizing = spec.position_sizing || { type: 'fixed_usd', value: 1000 };
  const leverage = spec.leverage || 1;

  const series = computeIndicators(spec, candles);
  const trades = [];
  const equityCurve = [];
  let equity = startingCapital;
  let position = null; // { side, entryPrice, qty, entryIndex, entryTime, peakPrice }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (position) {
      const { side, entryPrice, qty } = position;
      position.peakPrice = side === 'long' ? Math.max(position.peakPrice, candle.high) : Math.min(position.peakPrice, candle.low);

      let exitPrice = null;
      let exitReason = null;

      const slLevel = exitRules.stop_loss_pct
        ? (side === 'long' ? entryPrice * (1 - exitRules.stop_loss_pct / 100) : entryPrice * (1 + exitRules.stop_loss_pct / 100))
        : null;
      const tpLevel = exitRules.take_profit_pct
        ? (side === 'long' ? entryPrice * (1 + exitRules.take_profit_pct / 100) : entryPrice * (1 - exitRules.take_profit_pct / 100))
        : null;
      const trailLevel = exitRules.trailing_stop_pct
        ? (side === 'long' ? position.peakPrice * (1 - exitRules.trailing_stop_pct / 100) : position.peakPrice * (1 + exitRules.trailing_stop_pct / 100))
        : null;

      if (slLevel !== null && (side === 'long' ? candle.low <= slLevel : candle.high >= slLevel)) {
        exitPrice = slLevel; exitReason = 'stop_loss';
      } else if (tpLevel !== null && (side === 'long' ? candle.high >= tpLevel : candle.low <= tpLevel)) {
        exitPrice = tpLevel; exitReason = 'take_profit';
      } else if (trailLevel !== null && (side === 'long' ? candle.low <= trailLevel : candle.high >= trailLevel)) {
        exitPrice = trailLevel; exitReason = 'trailing_stop';
      } else if (exitRules.max_hold_candles && i - position.entryIndex >= exitRules.max_hold_candles) {
        exitPrice = candle.close; exitReason = 'max_hold';
      } else if (exitRules.opposite_signal_exit && hasOppositeSignal(spec, side, i, candles, series)) {
        exitPrice = candle.close; exitReason = 'opposite_signal';
      }

      if (exitPrice !== null) {
        const grossPnl = (exitPrice - entryPrice) * qty * (side === 'long' ? 1 : -1);
        const fees = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
        const pnl = grossPnl - fees;
        equity += pnl;
        trades.push({ side, entryTime: position.entryTime, entryPrice, exitTime: candle.time, exitPrice, pnl, exitReason });
        position = null;
      }
    }

    if (!position) {
      const side = decideEntry(spec, i, candles, series);
      if (side) {
        const margin = sizing.type === 'pct_capital' ? equity * (sizing.value / 100) : sizing.value;
        const notional = margin * leverage;
        const qty = notional / candle.close;
        position = { side, entryPrice: candle.close, qty, entryIndex: i, entryTime: candle.time, peakPrice: candle.close };
      }
    }

    equityCurve.push({ time: candle.time, equity: Math.round(equity * 100) / 100 });
  }

  return { metrics: computeMetrics(trades, equity, startingCapital, equityCurve), trades, equityCurve };
}

function computeMetrics(trades, finalEquity, startingCapital, equityCurve) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startingCapital, maxDrawdownPct = 0;
  equityCurve.forEach(p => {
    peak = Math.max(peak, p.equity);
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
  });

  return {
    totalTrades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPnl: finalEquity - startingCapital,
    totalPnlPct: ((finalEquity - startingCapital) / startingCapital) * 100,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    // JSON has no Infinity — cap at a large finite sentinel so "no losses yet" survives serialization
    // instead of silently becoming null (which would look like "not computed").
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0),
    maxDrawdownPct
  };
}

// Splits a chronological candle set into an in-sample (tuning) portion and a
// held-out out-of-sample (test) portion by TIME, not candle count, so the
// split boundary is deterministic regardless of how many candles each asset
// actually returned for the window. Default 80/20 matches the common
// train/test convention: the strategy was (presumably) tuned by eye against
// the oldest 80%, so the most recent 20% approximates unseen data.
const IN_SAMPLE_FRACTION = 0.8;

function splitInOutOfSample(candles, startTime, endTime, inSampleFraction = IN_SAMPLE_FRACTION) {
  const splitTime = startTime + (endTime - startTime) * inSampleFraction;
  return {
    inSampleCandles: candles.filter(c => c.time < splitTime),
    outOfSampleCandles: candles.filter(c => c.time >= splitTime)
  };
}

module.exports = { runBacktest, sma, rsi, computeIndicators, decideEntry, hasOppositeSignal, splitInOutOfSample, IN_SAMPLE_FRACTION };
