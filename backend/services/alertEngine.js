const db = require('../database');
const telegram = require('./telegram');
const { getLastClosedCandle, getTickerPrice } = require('./bybitMarketData');

const PRICE_ALERT_COOLDOWN_MS = 15 * 60 * 1000; // avoid spamming while price hovers near threshold

function conditionMet(condition, value, threshold) {
  if (condition === 'candle_close_above' || condition === 'price_above') return value > threshold;
  if (condition === 'candle_close_below' || condition === 'price_below') return value < threshold;
  return false;
}

async function evaluateAlert(alert) {
  const symbol = `${alert.asset}USDT`;
  const isCandleCondition = alert.condition.startsWith('candle_close_');

  if (isCandleCondition) {
    const candle = await getLastClosedCandle(symbol, alert.timeframe || '15m');
    if (!candle) return;
    // Cooldown keyed to the candle's own close time — never re-fire for the same candle.
    const candleCloseIso = new Date(candle.time).toISOString();
    if (alert.last_triggered_at && new Date(alert.last_triggered_at).toISOString() === candleCloseIso) return;
    if (!conditionMet(alert.condition, candle.close, parseFloat(alert.threshold))) return;

    await telegram.notifyUser(alert.user_id,
      `🔔 <b>${alert.asset}</b> — vela de ${alert.timeframe} fechou ${alert.condition === 'candle_close_above' ? 'acima' : 'abaixo'} de $${alert.threshold}\nFecho real: $${candle.close}`);
    await db.markAlertTriggered(alert.id, candleCloseIso, alert.is_recurring);
    return;
  }

  // Simple live-price condition, time-based cooldown instead of candle-based.
  if (alert.last_triggered_at && Date.now() - new Date(alert.last_triggered_at).getTime() < PRICE_ALERT_COOLDOWN_MS) return;
  const price = await getTickerPrice(symbol);
  if (!conditionMet(alert.condition, price, parseFloat(alert.threshold))) return;

  await telegram.notifyUser(alert.user_id,
    `🔔 <b>${alert.asset}</b> — preço ${alert.condition === 'price_above' ? 'acima' : 'abaixo'} de $${alert.threshold}\nPreço atual: $${price}`);
  await db.markAlertTriggered(alert.id, null, alert.is_recurring);
}

async function checkAllAlerts() {
  if (!telegram.isConfigured()) return; // nothing to notify with — skip silently
  const alerts = await db.getAllActivePriceAlerts();
  for (const alert of alerts) {
    try {
      await evaluateAlert(alert);
    } catch (e) {
      console.error(`Alert check failed for alert ${alert.id} (${alert.asset}):`, e.message);
    }
  }
}

module.exports = { checkAllAlerts };
