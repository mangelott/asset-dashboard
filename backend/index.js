const dotenv = require('dotenv');
dotenv.config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getBalances: getBinanceBalances, getFuturesPositions: getBinancePositions, getSpotPositions: getBinanceSpotPositions, getTradeHistory: getBinanceTradeHistory } = require('./adapters/binance');
const { getBalances: getBybitBalances, getPositions: getBybitPositions, getSpotPositions: getBybitSpotPositions, getTradeHistory: getBybitTradeHistory } = require('./adapters/bybit');
const { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions, getSpotPositions: getCoinbaseSpotPositions, getTradeHistory: getCoinbaseTradeHistory } = require('./adapters/coinbase');
const { getBalances: getKrakenBalances, getPositions: getKrakenPositions, getSpotPositions: getKrakenSpotPositions, getTradeHistory: getKrakenTradeHistory } = require('./adapters/kraken');
const { getBalances: getOkxBalances, getPositions: getOkxPositions, getSpotPositions: getOkxSpotPositions, getTradeHistory: getOkxTradeHistory } = require('./adapters/okx');
const { getBalances: getWalletBalances, getPositions: getWalletPositions, getSpotPositions: getWalletSpotPositions, getTradeHistory: getWalletTradeHistory } = require('./adapters/wallet_eth');
const { getBalances: getT212Balances, getPositions: getT212Positions, getSpotPositions: getT212SpotPositions, getTradeHistory: getT212TradeHistory } = require('./adapters/trading212');
const db = require('./database');
const telegram = require('./services/telegram');
const alertEngine = require('./services/alertEngine');
const anthropic = require('./services/anthropic');
const { getHistoricalKlines, timeframeMs } = require('./services/bybitMarketData');
const { runBacktest, splitInOutOfSample } = require('./services/backtestEngine');
const paperTradingEngine = require('./services/paperTradingEngine');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Adapter Registry ─────────────────────────────────────
const ADAPTERS = {
  binance: { getBalances: getBinanceBalances, getPositions: getBinancePositions, getSpotPositions: getBinanceSpotPositions, getTradeHistory: getBinanceTradeHistory },
  bybit: { getBalances: getBybitBalances, getPositions: getBybitPositions, getSpotPositions: getBybitSpotPositions, getTradeHistory: getBybitTradeHistory },
  coinbase: { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions, getSpotPositions: getCoinbaseSpotPositions, getTradeHistory: getCoinbaseTradeHistory },
  kraken: { getBalances: getKrakenBalances, getPositions: getKrakenPositions, getSpotPositions: getKrakenSpotPositions, getTradeHistory: getKrakenTradeHistory },
  okx: { getBalances: getOkxBalances, getPositions: getOkxPositions, getSpotPositions: getOkxSpotPositions, getTradeHistory: getOkxTradeHistory },
  wallet_eth: { getBalances: getWalletBalances, getPositions: getWalletPositions, getSpotPositions: getWalletSpotPositions, getTradeHistory: getWalletTradeHistory },
  trading212: { getBalances: getT212Balances, getPositions: getT212Positions, getSpotPositions: getT212SpotPositions, getTradeHistory: getT212TradeHistory }
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

app.post('/api/alerts', auth, async (req, res) => {
  try {
    const { asset, condition, timeframe, threshold, isRecurring } = req.body;
    if (!asset || !condition || threshold === undefined) return res.status(400).json({ error: 'Missing required fields' });
    const validConditions = ['candle_close_above', 'candle_close_below', 'price_above', 'price_below'];
    if (!validConditions.includes(condition)) return res.status(400).json({ error: 'Invalid condition' });
    if (condition.startsWith('candle_close_') && !timeframe) return res.status(400).json({ error: 'Timeframe required for candle-based alerts' });
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
app.get('/api/paper/strategies', auth, async (req, res) => {
  try {
    res.json(await db.getPaperStrategiesByUserId(req.user.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const strategy = await db.createPaperStrategy(req.user.userId, { name, assets: [], timeframe: null, spec: {}, startingCapital: 10000 });
    res.json(strategy);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/strategies/:id', auth, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    const messages = await db.getStrategyChatMessages(strategy.id);
    const backtests = await db.getBacktestRunsByStrategyId(strategy.id);
    res.json({ ...strategy, messages, backtests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/paper/strategies/:id', auth, async (req, res) => {
  try {
    await db.deletePaperStrategy(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/chat', auth, async (req, res) => {
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

app.post('/api/paper/strategies/:id/apply-spec', auth, async (req, res) => {
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

app.post('/api/paper/strategies/:id/backtest', auth, async (req, res) => {
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

app.post('/api/paper/strategies/:id/activate', auth, async (req, res) => {
  try {
    const backtests = await db.getBacktestRunsByStrategyId(req.params.id);
    if (!backtests.length) return res.status(400).json({ error: 'Corre pelo menos um backtest antes de ativar' });
    const updated = await db.updatePaperStrategyStatus(req.user.userId, req.params.id, 'live');
    if (!updated) return res.status(404).json({ error: 'Strategy not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/pause', auth, async (req, res) => {
  try {
    const updated = await db.updatePaperStrategyStatus(req.user.userId, req.params.id, 'paused');
    if (!updated) return res.status(404).json({ error: 'Strategy not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/strategies/:id/risk', auth, async (req, res) => {
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

app.get('/api/paper/strategies/:id/positions', auth, async (req, res) => {
  try {
    const strategy = await db.getPaperStrategyById(req.user.userId, req.params.id);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    res.json(await db.getPaperPositionsByStrategyId(strategy.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/strategies/:id/equity', auth, async (req, res) => {
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

// ─── Alert checker (cron) ─────────────────────────────────
cron.schedule('* * * * *', () => {
  alertEngine.checkAllAlerts().catch(e => console.error('Alert engine error:', e.message));
});

// ─── Paper trading live engine (cron) ─────────────────────
cron.schedule('* * * * *', () => {
  paperTradingEngine.checkLiveStrategies().catch(e => console.error('Paper trading engine error:', e.message));
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
