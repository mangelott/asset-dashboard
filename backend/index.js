const dotenv = require('dotenv');
dotenv.config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getBalances: getBinanceBalances, getFuturesPositions: getBinancePositions, getSpotPositions: getBinanceSpotPositions, getNetDeposits: getBinanceDeposits, getTradeHistory: getBinanceTradeHistory } = require('./adapters/binance');
const { getBalances: getBybitBalances, getPositions: getBybitPositions, getSpotPositions: getBybitSpotPositions, getNetDeposits: getBybitDeposits, getTradeHistory: getBybitTradeHistory } = require('./adapters/bybit');
const { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions, getSpotPositions: getCoinbaseSpotPositions, getNetDeposits: getCoinbaseDeposits, getTradeHistory: getCoinbaseTradeHistory } = require('./adapters/coinbase');
const { getBalances: getKrakenBalances, getPositions: getKrakenPositions, getSpotPositions: getKrakenSpotPositions, getNetDeposits: getKrakenDeposits, getTradeHistory: getKrakenTradeHistory } = require('./adapters/kraken');
const { getBalances: getOkxBalances, getPositions: getOkxPositions, getSpotPositions: getOkxSpotPositions, getNetDeposits: getOkxDeposits, getTradeHistory: getOkxTradeHistory } = require('./adapters/okx');
const { getBalances: getWalletBalances, getPositions: getWalletPositions, getSpotPositions: getWalletSpotPositions, getNetDeposits: getWalletDeposits, getTradeHistory: getWalletTradeHistory } = require('./adapters/wallet_eth');
const { getBalances: getT212Balances, getPositions: getT212Positions, getSpotPositions: getT212SpotPositions, getNetDeposits: getT212Deposits, getTradeHistory: getT212TradeHistory } = require('./adapters/trading212');
const db = require('./database');
const telegram = require('./services/telegram');
const alertEngine = require('./services/alertEngine');
const anthropic = require('./services/anthropic');
const { getHistoricalKlines, timeframeMs } = require('./services/bybitMarketData');
const { runBacktest, splitInOutOfSample } = require('./services/backtestEngine');
const paperTradingEngine = require('./services/paperTradingEngine');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// ─── Adapter Registry ─────────────────────────────────────
const ADAPTERS = {
  binance: { getBalances: getBinanceBalances, getPositions: getBinancePositions, getSpotPositions: getBinanceSpotPositions, getNetDeposits: getBinanceDeposits, getTradeHistory: getBinanceTradeHistory },
  bybit: { getBalances: getBybitBalances, getPositions: getBybitPositions, getSpotPositions: getBybitSpotPositions, getNetDeposits: getBybitDeposits, getTradeHistory: getBybitTradeHistory },
  coinbase: { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions, getSpotPositions: getCoinbaseSpotPositions, getNetDeposits: getCoinbaseDeposits, getTradeHistory: getCoinbaseTradeHistory },
  kraken: { getBalances: getKrakenBalances, getPositions: getKrakenPositions, getSpotPositions: getKrakenSpotPositions, getNetDeposits: getKrakenDeposits, getTradeHistory: getKrakenTradeHistory },
  okx: { getBalances: getOkxBalances, getPositions: getOkxPositions, getSpotPositions: getOkxSpotPositions, getNetDeposits: getOkxDeposits, getTradeHistory: getOkxTradeHistory },
  wallet_eth: { getBalances: getWalletBalances, getPositions: getWalletPositions, getSpotPositions: getWalletSpotPositions, getNetDeposits: getWalletDeposits, getTradeHistory: getWalletTradeHistory },
  trading212: { getBalances: getT212Balances, getPositions: getT212Positions, getSpotPositions: getT212SpotPositions, getNetDeposits: getT212Deposits, getTradeHistory: getT212TradeHistory }
};

// ─── Helpers ──────────────────────────────────────────────
async function fetchExchangeData(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter) throw new Error(`Adapter not found: ${exchange.type}`);
  if (exchange.type === 'trading212') return adapter.getBalances(exchange.api_key, exchange.api_secret);
  if (exchange.type === 'wallet_eth') return adapter.getBalances(exchange.api_key, exchange.api_secret);
  if (exchange.type === 'okx') return adapter.getBalances(exchange.api_key, exchange.api_secret, exchange.passphrase);
  return adapter.getBalances(exchange.api_key, exchange.api_secret);
}

async function fetchExchangePositions(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter) return [];
  if (exchange.type === 'trading212') return adapter.getPositions();
  if (exchange.type === 'okx') return adapter.getPositions(exchange.api_key, exchange.api_secret, exchange.passphrase);
  return adapter.getPositions(exchange.api_key, exchange.api_secret);
}

async function fetchExchangeSpotPositions(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter?.getSpotPositions) return [];
  if (exchange.type === 'trading212') return adapter.getSpotPositions(exchange.api_key, exchange.api_secret);
  if (exchange.type === 'okx') return adapter.getSpotPositions(exchange.api_key, exchange.api_secret, exchange.passphrase);
  return adapter.getSpotPositions(exchange.api_key, exchange.api_secret);
}

async function fetchExchangeTransactions(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter?.getTradeHistory) return [];
  if (exchange.type === 'okx') return adapter.getTradeHistory(exchange.api_key, exchange.api_secret, exchange.passphrase);
  return adapter.getTradeHistory(exchange.api_key, exchange.api_secret);
}

// Injected into telegram.handleUpdate() so bot commands can reach the same
// balance-aggregation and paper-strategy logic the authenticated routes use,
// without telegram.js needing to require index.js (would be circular).
const telegramCommandHandlers = {
  async getGlobalBalance(userId) {
    const list = await db.getAllExchanges(userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(fetchExchangeData));
    return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value.totalUsdt : 0), 0);
  },
  async listLiveStrategies(userId) {
    const strategies = await db.getPaperStrategiesByUserId(userId);
    return strategies.filter(s => s.status === 'live');
  },
  async pauseStrategyByName(userId, name) {
    const strategies = await db.getPaperStrategiesByUserId(userId);
    const match = strategies.find(s => s.status === 'live' && s.name.toLowerCase() === name.toLowerCase());
    if (!match) return null;
    return db.updatePaperStrategyStatus(userId, match.id, 'paused');
  }
};

// ─── Auth Middleware ──────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function requirePro(req, res, next) {
  try {
    const plan = await db.getUserPlan(req.user.userId);
    if (plan.plan === 'pro') return next();
    res.status(402).json({ error: 'Plano Pro necessário', upgrade: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─── Auth Routes ──────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser(email, passwordHash);
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Exchanges CRUD ───────────────────────────────────────
app.get('/api/exchanges', auth, async (req, res) => {
  try {
    res.json(await db.getAllExchanges(req.user.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exchanges', auth, async (req, res) => {
  try {
    const { id, name, type, apiKey, apiSecret, passphrase } = req.body;
    if (!id || !name || !type || !apiKey) return res.status(400).json({ error: 'Missing required fields' });
    await db.saveExchange(req.user.userId, id, name, type, apiKey, apiSecret || '', passphrase || '');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/exchanges/:id', auth, async (req, res) => {
  try {
    await db.deleteExchange(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Account ──────────────────────────────────────────────
app.get('/api/exchange/:id/account', auth, async (req, res) => {
  try {
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    res.json(await fetchExchangeData(exchange));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exchange/:id/positions', auth, async (req, res) => {
  try {
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    res.json(await fetchExchangePositions(exchange));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Global ───────────────────────────────────────────────
app.get('/api/global/account', auth, async (req, res) => {
  try {
    const list = await db.getAllExchanges(req.user.userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(req.user.userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(fetchExchangeData));

    let totalUsdt = 0, allBalances = [], breakdown = {};
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[${exchanges[i]?.name}] account error:`, result.reason?.message);
      } else {
        totalUsdt += result.value.totalUsdt;
        allBalances = [...allBalances, ...result.value.balances.map(b => ({ ...b, exchange: exchanges[i].name }))];
        breakdown[exchanges[i].name] = result.value.totalUsdt;
      }
    });

    res.json({ totalUsdt, balances: allBalances, breakdown });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/global/positions', auth, async (req, res) => {
  try {
    const list = await db.getAllExchanges(req.user.userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(req.user.userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(fetchExchangePositions));

    let allPositions = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[${exchanges[i]?.name}] positions error:`, result.reason?.message);
      } else {
        allPositions = [...allPositions, ...result.value.map(p => ({ ...p, exchange: exchanges[i].name }))];
      }
    });

    res.json(allPositions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exchange/:id/spot-positions', auth, async (req, res) => {
  try {
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    res.json(await fetchExchangeSpotPositions(exchange));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/global/spot-positions', auth, async (req, res) => {
  try {
    const list = await db.getAllExchanges(req.user.userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(req.user.userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(fetchExchangeSpotPositions));

    let allPositions = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[${exchanges[i]?.name}] spot-positions error:`, result.reason?.message);
      } else {
        allPositions = [...allPositions, ...result.value.map(p => ({ ...p, exchange: exchanges[i].name }))];
      }
    });

    res.json(allPositions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exchange/:id/transactions', auth, async (req, res) => {
  try {
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    res.json(await fetchExchangeTransactions(exchange));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/global/transactions', auth, async (req, res) => {
  try {
    const list = await db.getAllExchanges(req.user.userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(req.user.userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(fetchExchangeTransactions));

    let allTransactions = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[${exchanges[i]?.name}] transactions error:`, result.reason?.message);
      } else {
        allTransactions = [...allTransactions, ...result.value.map(t => ({ ...t, exchange: exchanges[i].name }))];
      }
    });

    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(allTransactions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Share Links ──────────────────────────────────────────
app.post('/api/share', auth, async (req, res) => {
  try {
    const showValues = !!req.body.showValues;
    const token = crypto.randomBytes(32).toString('hex');
    const link = await db.upsertShareLink(req.user.userId, token, showValues);
    res.json({ token: link.token, showValues: link.show_values });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/share/me', auth, async (req, res) => {
  try {
    const link = await db.getShareLinkByUserId(req.user.userId);
    res.json(link ? { token: link.token, showValues: link.show_values } : null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/share', auth, async (req, res) => {
  try {
    await db.deleteShareLink(req.user.userId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public — no auth. Security relies on the token being an unguessable secret.
app.get('/api/share/:token', async (req, res) => {
  try {
    const link = await db.getShareLinkByToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    const userId = link.user_id;
    const list = await db.getAllExchanges(userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(fetchExchangeData));

    let totalUsdt = 0;
    const breakdown = {};
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        totalUsdt += result.value.totalUsdt;
        breakdown[exchanges[i].name] = result.value.totalUsdt;
      }
    });

    const snapshots = await db.getSnapshotsByExchangeId(userId, 'global');
    const firstValue = snapshots.length > 0 ? parseFloat(snapshots[0].total_value_usdt) : 0;
    const historicalPnlPct = firstValue > 0 ? ((totalUsdt - firstValue) / firstValue) * 100 : 0;

    if (link.show_values) {
      return res.json({
        showValues: true,
        totalUsdt,
        historicalPnlPct,
        breakdown,
        snapshots: snapshots.map(s => ({ date: new Date(s.date).toISOString().split('T')[0], value: parseFloat(s.total_value_usdt) }))
      });
    }

    const breakdownPct = {};
    Object.entries(breakdown).forEach(([name, value]) => {
      breakdownPct[name] = totalUsdt > 0 ? (value / totalUsdt) * 100 : 0;
    });

    res.json({
      showValues: false,
      historicalPnlPct,
      breakdown: breakdownPct,
      snapshots: snapshots.map(s => {
        const v = parseFloat(s.total_value_usdt);
        const pctFromStart = firstValue > 0 ? ((v - firstValue) / firstValue) * 100 : 0;
        return { date: new Date(s.date).toISOString().split('T')[0], value: pctFromStart };
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Telegram ─────────────────────────────────────────────
app.get('/api/telegram/status', auth, async (req, res) => {
  try {
    const link = await db.getTelegramLinkByUserId(req.user.userId);
    res.json({ linked: !!link, configured: telegram.isConfigured() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/link', auth, async (req, res) => {
  try {
    const invite = await telegram.createLinkInvite(req.user.userId);
    res.json(invite);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/telegram/link', auth, async (req, res) => {
  try {
    await db.deleteTelegramLink(req.user.userId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public — called by Telegram's servers, not the frontend.
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    await telegram.handleUpdate(req.body, telegramCommandHandlers);
  } catch (e) {
    console.error('Telegram webhook error:', e.message);
  }
  res.sendStatus(200);
});

// ─── Price Alerts ─────────────────────────────────────────
app.get('/api/alerts', auth, async (req, res) => {
  try {
    res.json(await db.getPriceAlertsByUserId(req.user.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alerts', auth, requirePro, async (req, res) => {
  try {
    const { asset, condition, timeframe, threshold, isRecurring } = req.body;
    if (!asset || !condition || threshold === undefined) return res.status(400).json({ error: 'Missing required fields' });
    const validConditions = ['candle_close_above', 'candle_close_below', 'price_above', 'price_below', 'price_change_pct_up', 'price_change_pct_down'];
    if (!validConditions.includes(condition)) return res.status(400).json({ error: 'Invalid condition' });
    if ((condition.startsWith('candle_close_') || condition.startsWith('price_change_pct')) && !timeframe)
      return res.status(400).json({ error: 'Timeframe required for this condition' });
    const alert = await db.createPriceAlert(req.user.userId, { asset: asset.toUpperCase(), condition, timeframe, threshold, isRecurring });
    res.json(alert);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/alerts/:id', auth, async (req, res) => {
  try {
    await db.deletePriceAlert(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Paper Trading ────────────────────────────────────────
app.get('/api/paper/strategies', auth, requirePro, async (req, res) => {
  try {
    res.json(await db.getPaperStrategiesByUserId(req.user.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies', auth, requirePro, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const strategy = await db.createPaperStrategy(req.user.userId, { name, assets: [], timeframe: null, spec: {}, startingCapital: 10000 });
    res.json(strategy);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/strategies/:id', auth, requirePro, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    const messages = await db.getStrategyChatMessages(strategy.id);
    const backtests = await db.getBacktestRunsByStrategyId(strategy.id);
    res.json({ ...strategy, messages, backtests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/paper/strategies/:id', auth, requirePro, async (req, res) => {
  try {
    await db.deletePaperStrategy(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/chat', auth, requirePro, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const history = await db.getStrategyChatMessages(strategy.id);
    const messages = [...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: message }];

    await db.addStrategyChatMessage(strategy.id, 'user', message);
    const { reply, proposedSpec } = await anthropic.chat(messages);
    await db.addStrategyChatMessage(strategy.id, 'assistant', reply || '(proposta de estratégia enviada)');

    res.json({ reply, proposedSpec });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

// Ordering used to validate that spec.htf_timeframe is strictly "higher" than
// the strategy's own trading timeframe (a daily-bias filter on a 15m strategy
// makes sense; a 5m "HTF" on a 1h strategy doesn't).
const TIMEFRAME_RANK = { '1m': 1, '3m': 2, '5m': 3, '15m': 4, '30m': 5, '1h': 6, '2h': 7, '4h': 8, '6h': 9, '12h': 10, '1d': 11, '1w': 12 };

app.post('/api/paper/strategies/:id/apply-spec', auth, requirePro, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    const { assets, timeframe, ...spec } = req.body;
    if (!assets?.length || assets.length > 3) return res.status(400).json({ error: 'Escolhe entre 1 e 3 ativos' });
    if (spec.leverage > 10) return res.status(400).json({ error: 'Alavancagem máxima é 10x' });
    if (spec.htf_timeframe && TIMEFRAME_RANK[spec.htf_timeframe] <= TIMEFRAME_RANK[timeframe]) {
      return res.status(400).json({ error: 'O timeframe superior (htf_timeframe) tem de ser maior do que o timeframe da estratégia' });
    }

    const updated = await db.updatePaperStrategySpec(strategy.id, {
      assets, timeframe, spec,
      version: strategy.version + 1,
      parentVersionId: strategy.id
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function aggregateMetrics(results, key) {
  if (!results.every(r => r[key])) return null;
  return {
    perAsset: results.map(r => ({ symbol: r.symbol, ...r[key].metrics })),
    totalTrades: results.reduce((s, r) => s + r[key].metrics.totalTrades, 0)
  };
}

app.post('/api/paper/strategies/:id/backtest', auth, requirePro, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    const assets = typeof strategy.assets === 'string' ? JSON.parse(strategy.assets) : strategy.assets;
    const spec = typeof strategy.spec === 'string' ? JSON.parse(strategy.spec) : strategy.spec;
    if (!assets?.length || !strategy.timeframe) return res.status(400).json({ error: 'Estratégia ainda não tem ativos/timeframe definidos' });

    const days = Math.min(parseInt(req.body.days) || 365, 365);
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;
    const startingCapital = parseFloat(strategy.starting_capital);

    const results = await Promise.all(assets.map(async symbol => {
      const candles = await getHistoricalKlines(symbol, strategy.timeframe, startTime, endTime);
      const { inSampleCandles, outOfSampleCandles } = splitInOutOfSample(candles, startTime, endTime);

      // Optional higher-timeframe filter (daily bias, HTF support/resistance).
      // Fetched over the same [startTime, endTime] window and split at the
      // same boundary so in-sample/out-of-sample stay aligned with the
      // primary series.
      let htfFull = null, htfInSample = null, htfOutOfSample = null;
      if (spec.htf_timeframe) {
        const htfCandles = await getHistoricalKlines(symbol, spec.htf_timeframe, startTime, endTime);
        const htfBarMs = timeframeMs(spec.htf_timeframe);
        const htfSplit = splitInOutOfSample(htfCandles, startTime, endTime);
        htfFull = { candles: htfCandles, barMs: htfBarMs };
        htfInSample = { candles: htfSplit.inSampleCandles, barMs: htfBarMs };
        htfOutOfSample = { candles: htfSplit.outOfSampleCandles, barMs: htfBarMs };
      }

      return {
        symbol,
        full: runBacktest(spec, candles, startingCapital, htfFull),
        inSample: inSampleCandles.length ? runBacktest(spec, inSampleCandles, startingCapital, htfInSample) : null,
        outOfSample: outOfSampleCandles.length ? runBacktest(spec, outOfSampleCandles, startingCapital, htfOutOfSample) : null
      };
    }));

    const combinedEquityCurve = results[0]?.full.equityCurve || [];
    const metrics = {
      perAsset: results.map(r => ({ symbol: r.symbol, ...r.full.metrics })),
      totalTrades: results.reduce((s, r) => s + r.full.metrics.totalTrades, 0),
      inSample: aggregateMetrics(results, 'inSample'),
      outOfSample: aggregateMetrics(results, 'outOfSample')
    };

    const run = await db.createBacktestRun(strategy.id, {
      version: strategy.version,
      dateRangeStart: new Date(startTime),
      dateRangeEnd: new Date(endTime),
      metrics,
      equityCurve: combinedEquityCurve
    });
    res.json(run);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/activate', auth, requirePro, async (req, res) => {
  try {
    const backtests = await db.getBacktestRunsByStrategyId(req.params.id);
    if (!backtests.length) return res.status(400).json({ error: 'Corre pelo menos um backtest antes de ativar' });
    const updated = await db.updatePaperStrategyStatus(req.user.userId, req.params.id, 'live');
    if (!updated) return res.status(404).json({ error: 'Strategy not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/pause', auth, requirePro, async (req, res) => {
  try {
    const updated = await db.updatePaperStrategyStatus(req.user.userId, req.params.id, 'paused');
    if (!updated) return res.status(404).json({ error: 'Strategy not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/risk', auth, requirePro, async (req, res) => {
  try {
    const { maxDrawdownPct } = req.body;
    if (maxDrawdownPct !== null && (typeof maxDrawdownPct !== 'number' || maxDrawdownPct <= 0 || maxDrawdownPct > 100)) {
      return res.status(400).json({ error: 'maxDrawdownPct deve ser um número entre 0 e 100, ou null para desativar' });
    }
    const updated = await db.updatePaperStrategyRisk(req.user.userId, req.params.id, maxDrawdownPct);
    if (!updated) return res.status(404).json({ error: 'Strategy not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/strategies/:id/positions', auth, requirePro, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    res.json(await db.getPaperPositionsByStrategyId(strategy.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/strategies/:id/equity', auth, requirePro, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    res.json(await db.getPaperEquitySnapshots(strategy.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Snapshots ────────────────────────────────────────────
app.post('/api/snapshot', auth, async (req, res) => {
  try {
    const { exchangeId } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const userId = req.user.userId;

    if (exchangeId === 'global') {
      const list = await db.getAllExchanges(userId);
      const exchanges = await Promise.all(list.map(e => db.getExchangeById(userId, e.id)));
      const results = await Promise.allSettled(exchanges.map(fetchExchangeData));
      let totalUsdt = 0;
      results.forEach(r => { if (r.status === 'fulfilled') totalUsdt += r.value.totalUsdt; });
      await db.saveDailySnapshot(userId, 'global', today, totalUsdt);
      res.json({ date: today, total_value_usdt: totalUsdt });
    } else {
      const exchange = await db.getExchangeById(userId, exchangeId);
      if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
      const data = await fetchExchangeData(exchange);
      await db.saveDailySnapshot(userId, exchangeId, today, data.totalUsdt);
      res.json({ date: today, total_value_usdt: data.totalUsdt });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots/:exchangeId', auth, async (req, res) => {
  try {
    const rows = await db.getSnapshotsByExchangeId(req.user.userId, req.params.exchangeId);
    res.json(rows.map(s => ({ ...s, date: new Date(s.date).toISOString().split('T')[0] })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Auto snapshot (cron) ─────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    const users = await db.getAllUsers();
    const today = new Date().toISOString().split('T')[0];

    for (const { id: userId } of users) {
      const list = await db.getAllExchanges(userId);
      const exchanges = await Promise.all(list.map(e => db.getExchangeById(userId, e.id)));
      let globalTotal = 0;

      for (const exchange of exchanges) {
        try {
          const data = await fetchExchangeData(exchange);
          await db.saveDailySnapshot(userId, exchange.id, today, data.totalUsdt);
          globalTotal += data.totalUsdt;
        } catch (e) {
          console.error(`Snapshot error ${exchange.name}:`, e.message);
        }
      }

      await db.saveDailySnapshot(userId, 'global', today, globalTotal);
    }
    console.log(`Auto snapshots saved: ${today}`);
  } catch (e) { console.error('Auto snapshot error:', e.message); }
});

// ─── Net Deposits ─────────────────────────────────────────
async function fetchExchangeDeposits(exchange, since) {
  const adapter = ADAPTERS[exchange.type];
  let apiDeposits = 0;
  if (adapter?.getNetDeposits) {
    try {
      if (exchange.type === 'okx') apiDeposits = await adapter.getNetDeposits(exchange.api_key, exchange.api_secret, exchange.passphrase, since);
      else apiDeposits = await adapter.getNetDeposits(exchange.api_key, exchange.api_secret, since);
    } catch (e) {
      console.error(`[${exchange.name}] API deposits error:`, e.message);
    }
  }
  const manualTotal = await db.getTotalManualDeposits(exchange.user_id, exchange.id, since);
  return apiDeposits + manualTotal;
}

app.get('/api/exchange/:id/net-deposits', auth, async (req, res) => {
  try {
    const { since } = req.query;
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    const totalDeposits = await fetchExchangeDeposits(exchange, since);
    res.json({ totalDeposits });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/global/net-deposits', auth, async (req, res) => {
  try {
    const { since } = req.query;
    const list = await db.getAllExchanges(req.user.userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(req.user.userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(ex => fetchExchangeDeposits(ex, since)));

    let totalDeposits = 0;
    const byExchange = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        totalDeposits += r.value;
        byExchange[exchanges[i].name] = r.value;
      } else {
        console.error(`[${exchanges[i]?.name}] deposits error:`, r.reason?.message);
        byExchange[exchanges[i].name] = 0;
      }
    });

    res.json({ totalDeposits, byExchange });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Manual Deposits CRUD ──────────────────────────────────
app.get('/api/exchanges/:id/deposits', auth, async (req, res) => {
  try {
    const deposits = await db.getManualDeposits(req.user.userId, req.params.id);
    res.json(deposits);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exchanges/:id/deposits', auth, async (req, res) => {
  try {
    const { amount, date, note } = req.body;
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ error: 'Valid amount required' });
    const deposit = await db.addManualDeposit(req.user.userId, req.params.id, parsed, date || null, note || '');
    res.json(deposit);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/deposits/:depositId', auth, async (req, res) => {
  try {
    await db.deleteManualDeposit(req.user.userId, parseInt(req.params.depositId));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Alert checker (cron) ─────────────────────────────────
cron.schedule('* * * * *', () => {
  alertEngine.checkAllAlerts().catch(e => console.error('Alert engine error:', e.message));
});

// ─── Paper trading live engine (cron) ─────────────────────
cron.schedule('* * * * *', () => {
  paperTradingEngine.checkLiveStrategies().catch(e => console.error('Paper trading engine error:', e.message));
});

// ─── Realized P&L ─────────────────────────────────────────
function aggregateTradeStats(trades) {
  const closed = trades.filter(t => t.pnl !== null && t.pnl !== undefined);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const best = closed.length ? closed.reduce((b, t) => t.pnl > b.pnl ? t : b) : null;
  const worst = closed.length ? closed.reduce((w, t) => t.pnl < w.pnl ? t : w) : null;
  const byAsset = {};
  closed.forEach(t => {
    if (!byAsset[t.asset]) byAsset[t.asset] = { pnl: 0, wins: 0, losses: 0 };
    byAsset[t.asset].pnl += t.pnl;
    t.pnl > 0 ? byAsset[t.asset].wins++ : byAsset[t.asset].losses++;
  });
  return {
    totalPnl, tradeCount: closed.length, winCount: wins.length, lossCount: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    avgWin: wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    best, worst, byAsset
  };
}

async function fetchTradeHistory(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter?.getTradeHistory) return [];
  if (exchange.type === 'okx') return adapter.getTradeHistory(exchange.api_key, exchange.api_secret, exchange.passphrase);
  if (exchange.type === 'wallet_eth') return adapter.getTradeHistory(exchange.api_key, exchange.api_secret);
  return adapter.getTradeHistory(exchange.api_key, exchange.api_secret);
}

app.get('/api/exchange/:id/realized-pnl', auth, requirePro, async (req, res) => {
  try {
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    const trades = await fetchTradeHistory(exchange);
    res.json({ trades, stats: aggregateTradeStats(trades) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/global/realized-pnl', auth, requirePro, async (req, res) => {
  try {
    const list = await db.getAllExchanges(req.user.userId);
    const exchanges = await Promise.all(list.map(e => db.getExchangeById(req.user.userId, e.id)));
    const results = await Promise.allSettled(exchanges.map(async (ex, i) => {
      const trades = await fetchTradeHistory(ex);
      return trades.map(t => ({ ...t, exchangeName: ex.name, exchangeType: ex.type }));
    }));
    const allTrades = results
      .flatMap((r, i) => r.status === 'fulfilled' ? r.value : [])
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ trades: allTrades, stats: aggregateTradeStats(allTrades) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Push Notifications ───────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: alertEngine.VAPID_PUBLIC });
});

app.post('/api/push/subscribe', auth, requirePro, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid subscription' });
    await db.savePushSubscription(req.user.userId, endpoint, keys.p256dh, keys.auth);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/push/unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await db.deletePushSubscription(req.user.userId, endpoint);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Benchmark ────────────────────────────────────────────
app.get('/api/benchmark', auth, requirePro, async (req, res) => {
  try {
    const { from } = req.query;
    const startMs = from ? new Date(from).getTime() : Date.now() - 365 * 24 * 3600 * 1000;
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const result = {};
    for (const sym of symbols) {
      const klines = await getHistoricalKlines(sym, '1d', startMs);
      result[sym] = klines.map(k => ({
        date: new Date(k.time).toISOString().split('T')[0],
        close: k.close
      }));
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Hourly Intraday Snapshots (cron) ─────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const users = await db.getAllUsers();
    for (const { id: userId } of users) {
      const list = await db.getAllExchanges(userId);
      const exchanges = await Promise.all(list.map(e => db.getExchangeById(userId, e.id)));
      let globalTotal = 0;
      for (const exchange of exchanges) {
        try {
          const adapter = ADAPTERS[exchange.type];
          if (!adapter) continue;
          let data;
          if (exchange.type === 'trading212') data = await adapter.getBalances(exchange.api_key, exchange.api_secret);
          else if (exchange.type === 'wallet_eth') data = await adapter.getBalances(exchange.api_key, exchange.api_secret);
          else if (exchange.type === 'okx') data = await adapter.getBalances(exchange.api_key, exchange.api_secret, exchange.passphrase);
          else data = await adapter.getBalances(exchange.api_key, exchange.api_secret);
          const val = data.totalUsdt || 0;
          await db.saveIntradaySnapshot(userId, exchange.id, val);
          globalTotal += val;
        } catch (e) { console.error(`Intraday snapshot error [${exchange.name}]:`, e.message); }
      }
      if (list.length > 0) await db.saveIntradaySnapshot(userId, 'global', globalTotal);
    }
    console.log('Intraday snapshots saved:', new Date().toISOString());
  } catch (e) { console.error('Intraday snapshot cron error:', e.message); }
});

app.get('/api/intraday-snapshots/:exchangeId', auth, requirePro, async (req, res) => {
  try {
    const { since } = req.query;
    const rows = await db.getIntradaySnapshots(req.user.userId, req.params.exchangeId, since);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Billing ──────────────────────────────────────────────
app.get('/api/billing/plan', auth, async (req, res) => {
  try {
    res.json(await db.getUserPlan(req.user.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/billing/checkout', auth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Billing não configurado ainda' });
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ error: 'priceId obrigatório' });
    const plan = await db.getUserPlan(req.user.userId);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(plan.stripe_customer_id ? { customer: plan.stripe_customer_id } : { customer_email: req.user.email }),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard?upgraded=1`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/upgrade`,
      metadata: { userId: String(req.user.userId) }
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/billing/portal', auth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Billing não configurado ainda' });
    const plan = await db.getUserPlan(req.user.userId);
    if (!plan.stripe_customer_id) return res.status(400).json({ error: 'Sem conta de faturação associada' });
    const session = await stripe.billingPortal.sessions.create({
      customer: plan.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard`
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/billing/webhook', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = parseInt(session.metadata?.userId);
      if (userId) {
        await db.upsertUserPlan(userId, { plan: 'pro', stripeCustomerId: session.customer, stripeSubscriptionId: session.subscription });
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const sub = event.data.object;
      const plan = await db.getUserPlanByStripeCustomerId(sub.customer);
      if (plan) {
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        await db.upsertUserPlan(plan.user_id, {
          plan: isActive ? 'pro' : 'free',
          stripeSubscriptionId: sub.id,
          stripePriceId: sub.items?.data[0]?.price?.id,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          cancelAtPeriodEnd: sub.cancel_at_period_end
        });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const plan = await db.getUserPlanByStripeCustomerId(sub.customer);
      if (plan) await db.upsertUserPlan(plan.user_id, { plan: 'free', stripeSubscriptionId: null, cancelAtPeriodEnd: false });
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

async function registerTelegramWebhook() {
  if (!telegram.isConfigured() || !process.env.PUBLIC_BACKEND_URL) return;
  try {
    const axios = require('axios');
    const url = `${process.env.PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/telegram/webhook`;
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, { url });
    console.log(`Telegram webhook registered: ${url}`);
  } catch (e) {
    console.error('Telegram webhook registration failed:', e.response?.data || e.message);
  }
}

db.initDB()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .then(registerTelegramWebhook)
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
