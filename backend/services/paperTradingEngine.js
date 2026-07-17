const db = require('../database');
const telegram = require('./telegram');
const { getRecentKlines, timeframeMs } = require('./bybitMarketData');
const { buildContext, decideEntry, hasOppositeSignal } = require('./backtestEngine');

const TAKER_FEE = 0.00055;
const WARMUP_CANDLES = 250; // enough history for typical indicator periods (e.g. SMA 200)

function parseJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Mirrors backtestEngine's per-bar exit check, but reads/writes persisted
// position state (peak_price, opened_at) since live positions survive across cron ticks.
function evaluateExit(spec, position, candle, i, ctx) {
  const exitRules = spec.exit_rules || {};
  const side = position.side;
  const entryPrice = parseFloat(position.entry_price);
  let peakPrice = parseFloat(position.peak_price);
  peakPrice = side === 'long' ? Math.max(peakPrice, candle.high) : Math.min(peakPrice, candle.low);

  const slLevel = exitRules.stop_loss_pct
    ? (side === 'long' ? entryPrice * (1 - exitRules.stop_loss_pct / 100) : entryPrice * (1 + exitRules.stop_loss_pct / 100))
    : null;
  const tpLevel = exitRules.take_profit_pct
    ? (side === 'long' ? entryPrice * (1 + exitRules.take_profit_pct / 100) : entryPrice * (1 - exitRules.take_profit_pct / 100))
    : null;
  const trailLevel = exitRules.trailing_stop_pct
    ? (side === 'long' ? peakPrice * (1 - exitRules.trailing_stop_pct / 100) : peakPrice * (1 + exitRules.trailing_stop_pct / 100))
    : null;

  const candlesHeld = Math.round((candle.time - new Date(position.opened_at).getTime()) / timeframeMs(spec.timeframe || '15m'));

  let exitPrice = null, reason = null;
  if (slLevel !== null && (side === 'long' ? candle.low <= slLevel : candle.high >= slLevel)) {
    exitPrice = slLevel; reason = 'stop loss';
  } else if (tpLevel !== null && (side === 'long' ? candle.high >= tpLevel : candle.low <= tpLevel)) {
    exitPrice = tpLevel; reason = 'take profit';
  } else if (trailLevel !== null && (side === 'long' ? candle.low <= trailLevel : candle.high >= trailLevel)) {
    exitPrice = trailLevel; reason = 'trailing stop';
  } else if (exitRules.max_hold_candles && candlesHeld >= exitRules.max_hold_candles) {
    exitPrice = candle.close; reason = 'tempo máximo';
  } else if (exitRules.opposite_signal_exit && hasOppositeSignal(spec, side, i, ctx)) {
    exitPrice = candle.close; reason = 'sinal contrário';
  }

  return { exitPrice, reason, peakPrice };
}

// How far equity has fallen from its high-water mark, as a percentage.
function computeDrawdownPct(peakEquity, equity) {
  return peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
}

function computePnl(position, exitPrice) {
  const entryPrice = parseFloat(position.entry_price);
  const qty = parseFloat(position.qty);
  const gross = (exitPrice - entryPrice) * qty * (position.side === 'long' ? 1 : -1);
  const fees = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  return gross - fees;
}

async function evaluateStrategy(strategy) {
  const assets = parseJson(strategy.assets);
  const spec = parseJson(strategy.spec);
  const timeframe = strategy.timeframe;
  if (!assets?.length || !timeframe) return;

  let equity = parseFloat(strategy.equity);
  let peakEquity = parseFloat(strategy.peak_equity);
  const maxDrawdownPct = strategy.max_drawdown_pct !== null ? parseFloat(strategy.max_drawdown_pct) : null;

  for (const symbol of assets) {
    const asset = symbol.replace(/USDT$/, '');
    const candles = await getRecentKlines(symbol, timeframe, WARMUP_CANDLES);
    const now = Date.now();
    const closed = candles.filter(c => c.time + timeframeMs(timeframe) <= now);
    if (!closed.length) continue;

    const lastCandle = closed[closed.length - 1];
    const lastProcessed = await db.getLastProcessedCandleTime(strategy.id, symbol);
    if (lastProcessed === lastCandle.time) continue; // this candle was already acted on

    // The HTF series is per-asset (each symbol has its own daily/4h candles),
    // so it's fetched inside the loop even though the flag is checked once above.
    let assetHtf = null;
    if (spec.htf_timeframe) {
      const htfBarMs = timeframeMs(spec.htf_timeframe);
      const htfCandlesRaw = await getRecentKlines(symbol, spec.htf_timeframe, WARMUP_CANDLES);
      const htfCandles = htfCandlesRaw.filter(c => c.time + htfBarMs <= now);
      assetHtf = { candles: htfCandles, barMs: htfBarMs };
    }
    const ctx = buildContext(spec, closed, assetHtf);
    const i = closed.length - 1;

    const openPositions = await db.getOpenPaperPositions(strategy.id);
    const openPosition = openPositions.find(p => p.asset === asset);

    if (openPosition) {
      const { exitPrice, reason, peakPrice } = evaluateExit({ ...spec, timeframe }, openPosition, lastCandle, i, ctx);
      if (exitPrice !== null) {
        const pnl = computePnl(openPosition, exitPrice);
        await db.closePaperPosition(openPosition.id, { exitPrice, pnl, closedAt: new Date(lastCandle.time) });
        equity += pnl;
        peakEquity = Math.max(peakEquity, equity);
        await db.updatePaperStrategyEquity(strategy.id, equity);
        await db.addPaperEquitySnapshot(strategy.id, equity);
        await telegram.notifyUser(strategy.user_id,
          `📉 <b>${strategy.name}</b> — fechou ${asset} (${reason})\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);

        const drawdownPct = computeDrawdownPct(peakEquity, equity);
        if (maxDrawdownPct !== null && drawdownPct >= maxDrawdownPct) {
          await db.updatePaperStrategyStatus(strategy.user_id, strategy.id, 'paused');
          await telegram.notifyUser(strategy.user_id,
            `🛑 <b>${strategy.name}</b> pausada automaticamente — drawdown de ${drawdownPct.toFixed(1)}% atingiu o limite de ${maxDrawdownPct}%.`);
          return; // strategy is no longer live — stop evaluating its remaining assets this tick
        }
      } else {
        await db.updatePaperPositionPeak(openPosition.id, peakPrice);
      }
    } else {
      const side = decideEntry(spec, i, ctx);
      if (side) {
        const sizing = spec.position_sizing || { type: 'fixed_usd', value: 1000 };
        const leverage = spec.leverage || 1;
        const margin = sizing.type === 'pct_capital' ? equity * (sizing.value / 100) : sizing.value;
        const notional = margin * leverage;
        const qty = notional / lastCandle.close;
        await db.openPaperPosition(strategy.id, {
          asset, side, entryPrice: lastCandle.close, qty, leverage, openedAt: new Date(lastCandle.time)
        });
        await telegram.notifyUser(strategy.user_id,
          `📈 <b>${strategy.name}</b> — abriu ${side === 'long' ? 'LONG' : 'SHORT'} em ${asset} a $${lastCandle.close}`);
      }
    }

    await db.setLastProcessedCandleTime(strategy.id, symbol, lastCandle.time);
  }
}

async function checkLiveStrategies() {
  const strategies = await db.getAllLivePaperStrategies();
  for (const strategy of strategies) {
    try {
      await evaluateStrategy(strategy);
    } catch (e) {
      console.error(`Paper trading engine error (strategy ${strategy.id}):`, e.message);
    }
  }
}

module.exports = { checkLiveStrategies, computeDrawdownPct };
