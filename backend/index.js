const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getBalances: getBinanceBalances, getFuturesPositions: getBinancePositions, getSpotPositions: getBinanceSpotPositions } = require('./adapters/binance');
const { getBalances: getBybitBalances, getPositions: getBybitPositions, getSpotPositions: getBybitSpotPositions } = require('./adapters/bybit');
const { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions, getSpotPositions: getCoinbaseSpotPositions } = require('./adapters/coinbase');
const { getBalances: getKrakenBalances, getPositions: getKrakenPositions, getSpotPositions: getKrakenSpotPositions } = require('./adapters/kraken');
const { getBalances: getOkxBalances, getPositions: getOkxPositions, getSpotPositions: getOkxSpotPositions } = require('./adapters/okx');
const { getBalances: getWalletBalances, getPositions: getWalletPositions, getSpotPositions: getWalletSpotPositions } = require('./adapters/wallet_eth');
const { getBalances: getT212Balances, getPositions: getT212Positions, getSpotPositions: getT212SpotPositions } = require('./adapters/trading212');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Adapter Registry ─────────────────────────────────────
const ADAPTERS = {
  binance: { getBalances: getBinanceBalances, getPositions: getBinancePositions, getSpotPositions: getBinanceSpotPositions },
  bybit: { getBalances: getBybitBalances, getPositions: getBybitPositions, getSpotPositions: getBybitSpotPositions },
  coinbase: { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions, getSpotPositions: getCoinbaseSpotPositions },
  kraken: { getBalances: getKrakenBalances, getPositions: getKrakenPositions, getSpotPositions: getKrakenSpotPositions },
  okx: { getBalances: getOkxBalances, getPositions: getOkxPositions, getSpotPositions: getOkxSpotPositions },
  wallet_eth: { getBalances: getWalletBalances, getPositions: getWalletPositions, getSpotPositions: getWalletSpotPositions },
  trading212: { getBalances: getT212Balances, getPositions: getT212Positions, getSpotPositions: getT212SpotPositions }
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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/debug/exchange/:id', auth, async (req, res) => {
  try {
    const exchange = await db.getExchangeById(req.user.userId, req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange not found' });
    res.json({
      name: exchange.name,
      type: exchange.type,
      api_key_length: exchange.api_key.length,
      api_secret_length: exchange.api_secret.length,
      passphrase_length: exchange.passphrase.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

db.initDB()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
