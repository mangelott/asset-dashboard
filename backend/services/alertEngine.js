const db = require('../database');
const telegram = require('./telegram');
const { getLastClosedCandle, getTickerPrice, getHistoricalKlines, timeframeMs } = require('./bybitMarketData');
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BEH2yT-OYVADUbaFPpZ-hfVrrqv1N-NvIauwBmBR5VkvNS77FVKlPFresU9e2WdeI_xpt8GLEniJgLj5nWaBH64';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '4kDppvK73-GQr_CqpfjLLEqrMZyvAT_9hYU-PHwdTqU';

webpush.setVapidDetails('mailto:admin@assetdashboard.app', VAPID_PUBLIC, VAPID_PRIVATE);

const PRICE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

function conditionMet(condition, value, threshold) {
  if (condition === 'candle_close_above' || condition === 'price_above') return value > threshold;
  if (condition === 'candle_close_below' || condition === 'price_below') return value < threshold;
  return false;
}

async function sendPushToUser(userId, title, body) {
  try {
    const subs = await db.getPushSubscriptionsByUserId(userId);
    await Promise.allSettled(subs.map(sub =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body })
      ).catch(e => {
        if (e.statusCode === 410 || e.statusCode === 404) {
          db.deletePushSubscription(userId, sub.endpoint).catch(() => {});
        }
      })
    ));
  } catch (e) {
    console.error('Push notification error:', e.message);
  }
}

async function notifyUser(userId, message, title = '🔔 Asset Dashboard') {
  const plain = message.replace(/<[^>]+>/g, '');
  await Promise.allSettled([
    telegram.isConfigured() ? telegram.notifyUser(userId, message) : Promise.resolve(),
    sendPushToUser(userId, title, plain)
  ]);
}

async function evaluateAlert(alert) {
  const symbol = `${alert.asset}USDT`;

  // Candle close conditions
  if (alert.condition === 'candle_close_above' || alert.condition === 'candle_close_below') {
    const candle = await getLastClosedCandle(symbol, alert.timeframe || '15m');
    if (!candle) return;
    const candleCloseIso = new Date(candle.time).toISOString();
    if (alert.last_triggered_at && new Date(alert.last_triggered_at).toISOString() === candleCloseIso) return;
    if (!conditionMet(alert.condition, candle.close, parseFloat(alert.threshold))) return;

    const dir = alert.condition === 'candle_close_above' ? 'acima' : 'abaixo';
    await notifyUser(alert.user_id,
      `🔔 <b>${alert.asset}</b> — vela de ${alert.timeframe} fechou ${dir} de $${alert.threshold}\nFecho real: $${candle.close}`);
    await db.markAlertTriggered(alert.id, candleCloseIso, alert.is_recurring);
    return;
  }

  // % change conditions
  if (alert.condition === 'price_change_pct_up' || alert.condition === 'price_change_pct_down') {
    if (alert.last_triggered_at && Date.now() - new Date(alert.last_triggered_at).getTime() < PRICE_ALERT_COOLDOWN_MS) return;

    const tf = alert.timeframe || '1h';
    const msPerTf = timeframeMs[tf] || 3600000;
    const startTime = Date.now() - msPerTf * 2;
    const klines = await getHistoricalKlines(symbol, tf, startTime);
    if (!klines || klines.length < 1) return;

    const refPrice = klines[0].open;
    const currentPrice = await getTickerPrice(symbol);
    const changePct = ((currentPrice - refPrice) / refPrice) * 100;
    const threshold = parseFloat(alert.threshold);

    const triggered =
      (alert.condition === 'price_change_pct_up' && changePct >= threshold) ||
      (alert.condition === 'price_change_pct_down' && changePct <= -threshold);

    if (!triggered) return;

    const dirLabel = changePct >= 0 ? `subiu ${changePct.toFixed(2)}%` : `desceu ${Math.abs(changePct).toFixed(2)}%`;
    await notifyUser(alert.user_id,
      `🔔 <b>${alert.asset}</b> — ${dirLabel} em ${tf}\nPreço atual: $${currentPrice.toFixed(4)}`);
    await db.markAlertTriggered(alert.id, null, alert.is_recurring);
    return;
  }

  // Simple live-price conditions
  if (alert.last_triggered_at && Date.now() - new Date(alert.last_triggered_at).getTime() < PRICE_ALERT_COOLDOWN_MS) return;
  const price = await getTickerPrice(symbol);
  if (!conditionMet(alert.condition, price, parseFloat(alert.threshold))) return;

  const dir = alert.condition === 'price_above' ? 'acima' : 'abaixo';
  await notifyUser(alert.user_id,
    `🔔 <b>${alert.asset}</b> — preço ${dir} de $${alert.threshold}\nPreço atual: $${price}`);
  await db.markAlertTriggered(alert.id, null, alert.is_recurring);
}

async function checkAllAlerts() {
  const alerts = await db.getAllActivePriceAlerts();
  for (const alert of alerts) {
    try {
      await evaluateAlert(alert);
    } catch (e) {
      console.error(`Alert check failed for alert ${alert.id} (${alert.asset}):`, e.message);
    }
  }
}

module.exports = { checkAllAlerts, VAPID_PUBLIC };
