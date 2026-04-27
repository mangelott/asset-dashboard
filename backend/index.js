const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const cron = require('node-cron');
const { getBalances: getBinanceBalances, getFuturesPositions: getBinancePositions } = require('./adapters/binance');
const { getBalances: getBybitBalances, getPositions: getBybitPositions } = require('./adapters/bybit');
const { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions } = require('./adapters/coinbase');
const { getBalances: getKrakenBalances, getPositions: getKrakenPositions } = require('./adapters/kraken');
const { getBalances: getOkxBalances, getPositions: getOkxPositions } = require('./adapters/okx');
const { getBalances: getWalletBalances, getPositions: getWalletPositions } = require('./adapters/wallet_eth');
const { saveDailySnapshot, getAllSnapshots, saveExchange, getAllExchanges, getExchangeById, deleteExchange } = require('./database');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

// ─── Adapter Registry ─────────────────────────────────────
const ADAPTERS = {
  binance: { getBalances: getBinanceBalances, getPositions: getBinancePositions },
  bybit: { getBalances: getBybitBalances, getPositions: getBybitPositions },
  coinbase: { getBalances: getCoinbaseBalances, getPositions: getCoinbasePositions },
  kraken: { getBalances: getKrakenBalances, getPositions: getKrakenPositions },
  okx: { getBalances: getOkxBalances, getPositions: getOkxPositions },
  wallet_eth: { getBalances: getWalletBalances, getPositions: getWalletPositions }
};

// ─── Helpers ──────────────────────────────────────────────
async function fetchExchangeData(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter) throw new Error(`Adaptador não encontrado: ${exchange.type}`);
  if (exchange.type === 'wallet_eth') return adapter.getBalances(exchange.api_key, exchange.api_secret);
  if (exchange.type === 'okx') return adapter.getBalances(exchange.api_key, exchange.api_secret, exchange.passphrase);
  return adapter.getBalances(exchange.api_key, exchange.api_secret);
}

async function fetchExchangePositions(exchange) {
  const adapter = ADAPTERS[exchange.type];
  if (!adapter) return [];
  if (exchange.type === 'okx') return adapter.getPositions(exchange.api_key, exchange.api_secret, exchange.passphrase);
  return adapter.getPositions(exchange.api_key, exchange.api_secret);
}

// ─── Exchanges CRUD ───────────────────────────────────────
app.get('/api/exchanges', (req, res) => {
  try {
    const exchanges = getAllExchanges();
    res.json(exchanges);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exchanges', (req, res) => {
  try {
    const { id, name, type, apiKey, apiSecret, passphrase } = req.body;
    if (!id || !name || !type || !apiKey) {
      return res.status(400).json({ error: 'Campos obrigatórios em falta' });
    }
    saveExchange(id, name, type, apiKey, apiSecret || '', passphrase || '');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/exchanges/:id', (req, res) => {
  try {
    deleteExchange(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Account ──────────────────────────────────────────────
app.get('/api/exchange/:id/account', async (req, res) => {
  try {
    const exchange = getExchangeById(req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange não encontrada' });
    const data = await fetchExchangeData(exchange);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exchange/:id/positions', async (req, res) => {
  try {
    const exchange = getExchangeById(req.params.id);
    if (!exchange) return res.status(404).json({ error: 'Exchange não encontrada' });
    const positions = await fetchExchangePositions(exchange);
    res.json(positions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Global ───────────────────────────────────────────────
app.get('/api/global/account', async (req, res) => {
  try {
    const exchanges = getAllExchanges().map(e => getExchangeById(e.id));
    const results = await Promise.allSettled(exchanges.map(e => fetchExchangeData(e)));

    let totalUsdt = 0;
    let allBalances = [];
    let breakdown = {};

    results.forEach((result, i) => {
      const ex = exchanges[i];
      if (result.status === 'fulfilled') {
        totalUsdt += result.value.totalUsdt;
        allBalances = [...allBalances, ...result.value.balances.map(b => ({ ...b, exchange: ex.name }))];
        breakdown[ex.name] = result.value.totalUsdt;
      }
    });

    res.json({ totalUsdt, balances: allBalances, breakdown });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/global/positions', async (req, res) => {
  try {
    const exchanges = getAllExchanges().map(e => getExchangeById(e.id));
    const results = await Promise.allSettled(exchanges.map(e => fetchExchangePositions(e)));

    let allPositions = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allPositions = [...allPositions, ...result.value.map(p => ({ ...p, exchange: exchanges[i].name }))];
      }
    });

    res.json(allPositions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Snapshots ────────────────────────────────────────────
app.post('/api/snapshot', async (req, res) => {
  try {
    const { exchangeId } = req.body;
    const today = new Date().toISOString().split('T')[0];

    if (exchangeId === 'global') {
      const exchanges = getAllExchanges().map(e => getExchangeById(e.id));
      const results = await Promise.allSettled(exchanges.map(e => fetchExchangeData(e)));
      let totalUsdt = 0;
      results.forEach(r => { if (r.status === 'fulfilled') totalUsdt += r.value.totalUsdt; });
      saveDailySnapshot(`global_${today}`, totalUsdt);
      res.json({ date: today, total_value_usdt: totalUsdt });
    } else {
      const exchange = getExchangeById(exchangeId);
      if (!exchange) return res.status(404).json({ error: 'Exchange não encontrada' });
      const data = await fetchExchangeData(exchange);
      saveDailySnapshot(`${exchangeId}_${today}`, data.totalUsdt);
      res.json({ date: today, total_value_usdt: data.totalUsdt });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots/:exchangeId', (req, res) => {
  try {
    const { exchangeId } = req.params;
    const all = getAllSnapshots();
    const filtered = all
      .filter(s => s.date.startsWith(exchangeId))
      .map(s => ({ ...s, date: s.date.replace(`${exchangeId}_`, '') }));
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Snapshot automático ──────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    const exchanges = getAllExchanges().map(e => getExchangeById(e.id));
    const today = new Date().toISOString().split('T')[0];
    let globalTotal = 0;

    for (const exchange of exchanges) {
      try {
        const data = await fetchExchangeData(exchange);
        saveDailySnapshot(`${exchange.id}_${today}`, data.totalUsdt);
        globalTotal += data.totalUsdt;
      } catch (e) {
        console.error(`Erro snapshot ${exchange.name}:`, e.message);
      }
    }

    saveDailySnapshot(`global_${today}`, globalTotal);
    console.log(`Snapshots automáticos guardados: ${today}`);
  } catch (e) { console.error('Erro snapshot automático:', e.message); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});