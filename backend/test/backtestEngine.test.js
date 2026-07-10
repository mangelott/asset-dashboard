const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runBacktest, sma, rsi, computeIndicators, decideEntry, hasOppositeSignal } = require('../services/backtestEngine');

test('sma computes a trailing simple moving average with null warmup', () => {
  const out = sma([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4, 5]);
});

test('rsi is pinned at 100 once warmup is past for a strictly increasing series', () => {
  const closes = Array.from({ length: 16 }, (_, i) => i + 1); // 1..16, always +1
  const out = rsi(closes, 14);
  for (let i = 0; i < 14; i++) assert.equal(out[i], null);
  assert.equal(out[14], 100);
  assert.equal(out[15], 100);
});

test('rsi is pinned at 0 once warmup is past for a strictly decreasing series', () => {
  const closes = Array.from({ length: 16 }, (_, i) => 16 - i); // 16..1, always -1
  const out = rsi(closes, 14);
  assert.equal(out[14], 0);
  assert.equal(out[15], 0);
});

function candle(time, open, high, low, close) {
  return { time, open, high, low, close };
}

test('computeIndicators only precomputes series actually referenced by entry_rules', () => {
  const spec = { entry_rules: [{ indicator: 'rsi', period: 14 }, { indicator: 'ma_cross', fast_period: 5, slow_period: 20 }] };
  const candles = Array.from({ length: 25 }, (_, i) => candle(i, i, i + 1, i - 1, i));
  const series = computeIndicators(spec, candles);
  assert.ok(series.rsi_14);
  assert.ok(series.sma_5);
  assert.ok(series.sma_20);
  assert.equal(series.sma_50, undefined);
});

test('decideEntry with entry_logic "any" fires on the first rule that holds', () => {
  const spec = {
    entry_logic: 'any',
    entry_rules: [{ indicator: 'rsi', period: 2, comparator: 'below', value: 30 }]
  };
  // Sharp drop so RSI falls below 30 quickly
  const closes = [100, 100, 90, 80, 70, 60];
  const candles = closes.map((c, i) => candle(i, c, c, c, c));
  const series = computeIndicators(spec, candles);
  // Find the first index where the rule actually holds and assert decideEntry agrees
  let firedAt = null;
  for (let i = 0; i < candles.length; i++) {
    const side = decideEntry(spec, i, candles, series);
    if (side) { firedAt = i; break; }
  }
  assert.equal(firedAt !== null, true, 'expected the RSI-below-30 rule to eventually fire');
  assert.equal(decideEntry(spec, firedAt, candles, series), 'long');
});

test('decideEntry with entry_logic "all" requires every same-side rule to hold', () => {
  const spec = {
    entry_logic: 'all',
    entry_rules: [
      { indicator: 'rsi', period: 2, comparator: 'below', value: 90 }, // easy to satisfy (long)
      { indicator: 'price_vs_ma', period: 2, comparator: 'below' }     // long side too
    ]
  };
  const closes = [100, 90, 80, 70, 60];
  const candles = closes.map((c, i) => candle(i, c, c, c, c));
  const series = computeIndicators(spec, candles);
  // Once both indicators have warmed up and price is below its MA with low RSI, both rules hold.
  const side = decideEntry(spec, 4, candles, series);
  assert.equal(side, 'long');
});

test('decideEntry ignores signals on the disallowed side when spec.side is restricted', () => {
  const spec = {
    side: 'long',
    entry_logic: 'any',
    entry_rules: [{ indicator: 'rsi', period: 2, comparator: 'above', value: 10 }] // "above" => short side
  };
  const closes = [10, 20, 30, 40, 50];
  const candles = closes.map((c, i) => candle(i, c, c, c, c));
  const series = computeIndicators(spec, candles);
  const side = decideEntry(spec, 4, candles, series);
  assert.equal(side, null); // the short signal exists but is filtered out by spec.side = 'long'
});

test('hasOppositeSignal detects a signal on the opposite side while a position is open', () => {
  const spec = {
    entry_logic: 'any',
    entry_rules: [
      { indicator: 'rsi', period: 2, comparator: 'below', value: 90 }, // long
      { indicator: 'rsi', period: 2, comparator: 'above', value: 5 }   // short — will also hold here
    ]
  };
  const closes = [10, 20, 30, 40, 50];
  const candles = closes.map((c, i) => candle(i, c, c, c, c));
  const series = computeIndicators(spec, candles);
  assert.equal(hasOppositeSignal(spec, 'long', 4, candles, series), true);
});

test('runBacktest: breakout entry, take-profit exit, fees applied — hand-verified numbers', () => {
  // Bars 0-1 establish a tight range; bar 2 breaks out above the 2-bar rolling high (10),
  // triggering a long entry at close=14. Bar 3's high touches the 10% take-profit level.
  const candles = [
    candle(0, 9.5, 10, 9, 9.5),
    candle(1, 9.5, 10, 9, 9.5),
    candle(2, 9.5, 15, 9, 14),
    candle(3, 14, 16, 14, 15)
  ];
  const spec = {
    entry_logic: 'any',
    entry_rules: [{ indicator: 'breakout', period: 2, direction: 'above' }],
    exit_rules: { take_profit_pct: 10 },
    position_sizing: { type: 'fixed_usd', value: 1000 },
    leverage: 1
  };
  const startingCapital = 10000;
  const { metrics, trades, equityCurve } = runBacktest(spec, candles, startingCapital);

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryPrice, 14);
  assert.equal(trades[0].exitReason, 'take_profit');
  assert.equal(trades[0].exitPrice, 14 * 1.10); // 15.4

  // qty = 1000 / 14; grossPnl = (15.4 - 14) * qty = 100 exactly (1.4 * 1000/14 = 100)
  // fees = (14*qty + 15.4*qty) * 0.00055 = (29.4 * 1000/14) * 0.00055 = 2100 * 0.00055 = 1.155
  const expectedPnl = 100 - 1.155;
  assert.ok(Math.abs(trades[0].pnl - expectedPnl) < 1e-9, `expected pnl ~${expectedPnl}, got ${trades[0].pnl}`);

  assert.equal(equityCurve.length, candles.length);
  assert.equal(equityCurve[1].equity, startingCapital); // still flat before entry
  assert.equal(equityCurve[2].equity, startingCapital);  // position open, no realized pnl yet
  // equityCurve rounds to cents (Math.round(equity * 100) / 100), so allow a
  // one-cent tolerance for floating-point rounding rather than exact equality.
  assert.ok(Math.abs(equityCurve[3].equity - (startingCapital + expectedPnl)) < 0.01);

  assert.equal(metrics.totalTrades, 1);
  assert.equal(metrics.winRate, 100);
  assert.ok(Math.abs(metrics.totalPnl - expectedPnl) < 1e-6);
  assert.equal(metrics.profitFactor, 999); // sentinel for "no losses yet" (see backtestEngine.js comment)
});

test('runBacktest: stop-loss exits at the exact stop level, not the candle close', () => {
  const candles = [
    candle(0, 9.5, 10, 9, 9.5),
    candle(1, 9.5, 10, 9, 9.5),
    candle(2, 9.5, 15, 9, 14),   // entry at 14 (breakout)
    candle(3, 14, 14, 12, 12.5) // low breaches the 10% stop-loss level (12.6)
  ];
  const spec = {
    entry_logic: 'any',
    entry_rules: [{ indicator: 'breakout', period: 2, direction: 'above' }],
    exit_rules: { stop_loss_pct: 10 },
    position_sizing: { type: 'fixed_usd', value: 1000 },
    leverage: 1
  };
  const { trades } = runBacktest(spec, candles, 10000);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'stop_loss');
  assert.ok(Math.abs(trades[0].exitPrice - 14 * 0.9) < 1e-9); // 12.6, not the 12.5 close
  assert.ok(trades[0].pnl < 0);
});

test('runBacktest: max_hold_candles forces an exit at the close after N bars', () => {
  const candles = [
    candle(0, 9.5, 10, 9, 9.5),
    candle(1, 9.5, 10, 9, 9.5),
    candle(2, 9.5, 15, 9, 14),  // entry at 14
    candle(3, 14, 14.2, 13.9, 14.1),
    candle(4, 14.1, 14.3, 14, 14.2) // 2 bars after entry -> forced exit here
  ];
  const spec = {
    entry_logic: 'any',
    entry_rules: [{ indicator: 'breakout', period: 2, direction: 'above' }],
    exit_rules: { max_hold_candles: 2 },
    position_sizing: { type: 'fixed_usd', value: 1000 },
    leverage: 1
  };
  const { trades } = runBacktest(spec, candles, 10000);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, 'max_hold');
  assert.equal(trades[0].exitPrice, 14.2); // exits at that bar's close
});
