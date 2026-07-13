const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Derive 32-byte AES key from JWT_SECRET so only one env var is needed
const ENCRYPTION_KEY = crypto.createHash('sha256')
  .update(process.env.JWT_SECRET || 'change-this-secret')
  .digest();

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

function decrypt(text) {
  if (!text) return '';
  const [ivHex, encrypted] = text.split(':');
  if (!ivHex || !encrypted) return '';
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS exchanges (
      id VARCHAR(255) NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(100) NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      api_secret TEXT NOT NULL DEFAULT '',
      passphrase TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (id, user_id)
    );

    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exchange_id VARCHAR(255) NOT NULL,
      date DATE NOT NULL,
      total_value_usdt DECIMAL(20, 8) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, exchange_id, date)
    );

    CREATE TABLE IF NOT EXISTS share_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(64) UNIQUE NOT NULL,
      show_values BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS telegram_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id VARCHAR(64) NOT NULL,
      linked_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code VARCHAR(32) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset VARCHAR(50) NOT NULL,
      condition VARCHAR(30) NOT NULL,
      timeframe VARCHAR(10),
      threshold DECIMAL(24, 8) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      is_recurring BOOLEAN NOT NULL DEFAULT false,
      last_triggered_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS paper_strategies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      assets JSONB NOT NULL DEFAULT '[]',
      timeframe VARCHAR(10),
      spec JSONB NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      parent_version_id INTEGER REFERENCES paper_strategies(id) ON DELETE SET NULL,
      starting_capital DECIMAL(20, 8) NOT NULL DEFAULT 10000,
      equity DECIMAL(20, 8) NOT NULL DEFAULT 10000,
      peak_equity DECIMAL(20, 8) NOT NULL DEFAULT 10000,
      max_drawdown_pct DECIMAL(5, 2) DEFAULT 25,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE paper_strategies ADD COLUMN IF NOT EXISTS peak_equity DECIMAL(20, 8) NOT NULL DEFAULT 10000;
    ALTER TABLE paper_strategies ADD COLUMN IF NOT EXISTS max_drawdown_pct DECIMAL(5, 2) DEFAULT 25;

    CREATE TABLE IF NOT EXISTS strategy_chat_messages (
      id SERIAL PRIMARY KEY,
      strategy_id INTEGER NOT NULL REFERENCES paper_strategies(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS paper_backtest_runs (
      id SERIAL PRIMARY KEY,
      strategy_id INTEGER NOT NULL REFERENCES paper_strategies(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      date_range_start TIMESTAMP NOT NULL,
      date_range_end TIMESTAMP NOT NULL,
      metrics JSONB NOT NULL DEFAULT '{}',
      equity_curve JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      id SERIAL PRIMARY KEY,
      strategy_id INTEGER NOT NULL REFERENCES paper_strategies(id) ON DELETE CASCADE,
      asset VARCHAR(50) NOT NULL,
      side VARCHAR(10) NOT NULL,
      entry_price DECIMAL(24, 8) NOT NULL,
      qty DECIMAL(24, 8) NOT NULL,
      leverage DECIMAL(6, 2) NOT NULL DEFAULT 1,
      peak_price DECIMAL(24, 8),
      opened_at TIMESTAMP NOT NULL,
      closed_at TIMESTAMP,
      exit_price DECIMAL(24, 8),
      pnl DECIMAL(20, 8),
      status VARCHAR(10) NOT NULL DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
      id SERIAL PRIMARY KEY,
      strategy_id INTEGER NOT NULL REFERENCES paper_strategies(id) ON DELETE CASCADE,
      recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
      equity_usd DECIMAL(20, 8) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_asset_state (
      strategy_id INTEGER NOT NULL REFERENCES paper_strategies(id) ON DELETE CASCADE,
      asset VARCHAR(50) NOT NULL,
      last_candle_time BIGINT NOT NULL,
      PRIMARY KEY (strategy_id, asset)
    );
  `);
}

// ─── Users ────────────────────────────────────────────────
async function createUser(email, passwordHash) {
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
    [email, passwordHash]
  );
  return rows[0];
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0];
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT id FROM users');
  return rows;
}

// ─── Exchanges ────────────────────────────────────────────
async function saveExchange(userId, id, name, type, apiKey, apiSecret, passphrase = '') {
  await pool.query(`
    INSERT INTO exchanges (id, user_id, name, type, api_key, api_secret, passphrase)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id, user_id) DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      api_key = CASE WHEN EXCLUDED.api_key = '' THEN exchanges.api_key ELSE EXCLUDED.api_key END,
      api_secret = CASE WHEN EXCLUDED.api_secret = '' THEN exchanges.api_secret ELSE EXCLUDED.api_secret END,
      passphrase = CASE WHEN EXCLUDED.passphrase = '' THEN exchanges.passphrase ELSE EXCLUDED.passphrase END
  `, [id, userId, name, type, encrypt(apiKey), encrypt(apiSecret), encrypt(passphrase)]);
}

async function getAllExchanges(userId) {
  const { rows } = await pool.query(
    'SELECT id, name, type FROM exchanges WHERE user_id = $1',
    [userId]
  );
  return rows;
}

async function getExchangeById(userId, id) {
  const { rows } = await pool.query(
    'SELECT * FROM exchanges WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  if (!rows[0]) return null;
  const ex = rows[0];
  return { ...ex, api_key: decrypt(ex.api_key), api_secret: decrypt(ex.api_secret), passphrase: decrypt(ex.passphrase) };
}

async function deleteExchange(userId, id) {
  await pool.query('DELETE FROM exchanges WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ─── Snapshots ────────────────────────────────────────────
async function saveDailySnapshot(userId, exchangeId, date, totalValueUsdt) {
  await pool.query(`
    INSERT INTO daily_snapshots (user_id, exchange_id, date, total_value_usdt)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, exchange_id, date) DO UPDATE SET total_value_usdt = EXCLUDED.total_value_usdt
  `, [userId, exchangeId, date, totalValueUsdt]);
}

async function getSnapshotsByExchangeId(userId, exchangeId) {
  const { rows } = await pool.query(
    'SELECT * FROM daily_snapshots WHERE user_id = $1 AND exchange_id = $2 ORDER BY date ASC',
    [userId, exchangeId]
  );
  return rows;
}

// ─── Share Links ──────────────────────────────────────────
async function upsertShareLink(userId, token, showValues) {
  const { rows } = await pool.query(`
    INSERT INTO share_links (user_id, token, show_values)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET
      token = EXCLUDED.token,
      show_values = EXCLUDED.show_values,
      created_at = NOW()
    RETURNING token, show_values, created_at
  `, [userId, token, showValues]);
  return rows[0];
}

async function getShareLinkByUserId(userId) {
  const { rows } = await pool.query('SELECT * FROM share_links WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function getShareLinkByToken(token) {
  const { rows } = await pool.query('SELECT * FROM share_links WHERE token = $1', [token]);
  return rows[0] || null;
}

async function deleteShareLink(userId) {
  await pool.query('DELETE FROM share_links WHERE user_id = $1', [userId]);
}

// ─── Telegram ─────────────────────────────────────────────
async function createTelegramLinkCode(userId, code, expiresAt) {
  await pool.query(
    'INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES ($1, $2, $3)',
    [code, userId, expiresAt]
  );
}

async function consumeTelegramLinkCode(code) {
  const { rows } = await pool.query(
    'DELETE FROM telegram_link_codes WHERE code = $1 AND expires_at > NOW() RETURNING user_id',
    [code]
  );
  return rows[0]?.user_id || null;
}

async function upsertTelegramLink(userId, chatId) {
  await pool.query(`
    INSERT INTO telegram_links (user_id, chat_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, linked_at = NOW()
  `, [userId, chatId]);
}

async function getTelegramLinkByUserId(userId) {
  const { rows } = await pool.query('SELECT * FROM telegram_links WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function deleteTelegramLink(userId) {
  await pool.query('DELETE FROM telegram_links WHERE user_id = $1', [userId]);
}

async function getUserIdByTelegramChatId(chatId) {
  const { rows } = await pool.query('SELECT user_id FROM telegram_links WHERE chat_id = $1', [chatId]);
  return rows[0]?.user_id || null;
}

// ─── Price Alerts ─────────────────────────────────────────
async function createPriceAlert(userId, { asset, condition, timeframe, threshold, isRecurring }) {
  const { rows } = await pool.query(`
    INSERT INTO price_alerts (user_id, asset, condition, timeframe, threshold, is_recurring)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [userId, asset, condition, timeframe, threshold, !!isRecurring]);
  return rows[0];
}

async function getPriceAlertsByUserId(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM price_alerts WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

async function getAllActivePriceAlerts() {
  const { rows } = await pool.query('SELECT * FROM price_alerts WHERE active = true');
  return rows;
}

async function deletePriceAlert(userId, id) {
  await pool.query('DELETE FROM price_alerts WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function markAlertTriggered(id, triggeredAt = null, keepActive = false) {
  await pool.query(
    'UPDATE price_alerts SET active = $3, last_triggered_at = COALESCE($2, NOW()) WHERE id = $1',
    [id, triggeredAt, keepActive]
  );
}

// ─── Paper Trading Strategies ─────────────────────────────
async function createPaperStrategy(userId, { name, assets, timeframe, spec, startingCapital }) {
  const capital = startingCapital || 10000;
  const { rows } = await pool.query(`
    INSERT INTO paper_strategies (user_id, name, assets, timeframe, spec, starting_capital, equity, peak_equity)
    VALUES ($1, $2, $3, $4, $5, $6, $6, $6) RETURNING *
  `, [userId, name, JSON.stringify(assets || []), timeframe, JSON.stringify(spec || {}), capital]);
  return rows[0];
}

async function getPaperStrategiesByUserId(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM paper_strategies WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

async function getPaperStrategyById(userId, id) {
  const { rows } = await pool.query(
    'SELECT * FROM paper_strategies WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rows[0] || null;
}

async function getAllLivePaperStrategies() {
  const { rows } = await pool.query("SELECT * FROM paper_strategies WHERE status = 'live'");
  return rows;
}

async function updatePaperStrategySpec(id, { assets, timeframe, spec, version, parentVersionId }) {
  const { rows } = await pool.query(`
    UPDATE paper_strategies
    SET assets = $2, timeframe = $3, spec = $4, version = $5, parent_version_id = $6
    WHERE id = $1 RETURNING *
  `, [id, JSON.stringify(assets), timeframe, JSON.stringify(spec), version, parentVersionId]);
  return rows[0];
}

async function updatePaperStrategyStatus(userId, id, status) {
  const { rows } = await pool.query(
    "UPDATE paper_strategies SET status = $3 WHERE id = $1 AND user_id = $2 RETURNING *",
    [id, userId, status]
  );
  return rows[0] || null;
}

async function updatePaperStrategyEquity(id, equity) {
  await pool.query(
    'UPDATE paper_strategies SET equity = $2, peak_equity = GREATEST(peak_equity, $2) WHERE id = $1',
    [id, equity]
  );
}

// maxDrawdownPct = null disables auto-pause for this strategy.
async function updatePaperStrategyRisk(userId, id, maxDrawdownPct) {
  const { rows } = await pool.query(
    'UPDATE paper_strategies SET max_drawdown_pct = $3 WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId, maxDrawdownPct]
  );
  return rows[0] || null;
}

async function deletePaperStrategy(userId, id) {
  await pool.query('DELETE FROM paper_strategies WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ─── Strategy Chat ─────────────────────────────────────────
async function addStrategyChatMessage(strategyId, role, content) {
  const { rows } = await pool.query(`
    INSERT INTO strategy_chat_messages (strategy_id, role, content)
    VALUES ($1, $2, $3) RETURNING *
  `, [strategyId, role, content]);
  return rows[0];
}

async function getStrategyChatMessages(strategyId) {
  const { rows } = await pool.query(
    'SELECT * FROM strategy_chat_messages WHERE strategy_id = $1 ORDER BY created_at ASC',
    [strategyId]
  );
  return rows;
}

// ─── Backtest Runs ─────────────────────────────────────────
async function createBacktestRun(strategyId, { version, dateRangeStart, dateRangeEnd, metrics, equityCurve }) {
  const { rows } = await pool.query(`
    INSERT INTO paper_backtest_runs (strategy_id, version, date_range_start, date_range_end, metrics, equity_curve)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [strategyId, version, dateRangeStart, dateRangeEnd, JSON.stringify(metrics), JSON.stringify(equityCurve)]);
  return rows[0];
}

async function getBacktestRunsByStrategyId(strategyId) {
  const { rows } = await pool.query(
    'SELECT * FROM paper_backtest_runs WHERE strategy_id = $1 ORDER BY created_at DESC',
    [strategyId]
  );
  return rows;
}

// ─── Paper Positions ────────────────────────────────────────
async function openPaperPosition(strategyId, { asset, side, entryPrice, qty, leverage, openedAt }) {
  const { rows } = await pool.query(`
    INSERT INTO paper_positions (strategy_id, asset, side, entry_price, qty, leverage, peak_price, opened_at, status)
    VALUES ($1, $2, $3, $4, $5, $6, $4, $7, 'open') RETURNING *
  `, [strategyId, asset, side, entryPrice, qty, leverage, openedAt]);
  return rows[0];
}

async function updatePaperPositionPeak(id, peakPrice) {
  await pool.query('UPDATE paper_positions SET peak_price = $2 WHERE id = $1', [id, peakPrice]);
}

async function closePaperPosition(id, { exitPrice, pnl, closedAt }) {
  const { rows } = await pool.query(`
    UPDATE paper_positions SET exit_price = $2, pnl = $3, closed_at = $4, status = 'closed'
    WHERE id = $1 RETURNING *
  `, [id, exitPrice, pnl, closedAt]);
  return rows[0];
}

async function getOpenPaperPositions(strategyId) {
  const { rows } = await pool.query(
    "SELECT * FROM paper_positions WHERE strategy_id = $1 AND status = 'open'",
    [strategyId]
  );
  return rows;
}

async function getPaperPositionsByStrategyId(strategyId) {
  const { rows } = await pool.query(
    'SELECT * FROM paper_positions WHERE strategy_id = $1 ORDER BY opened_at DESC',
    [strategyId]
  );
  return rows;
}

// ─── Equity Snapshots ────────────────────────────────────────
async function addPaperEquitySnapshot(strategyId, equityUsd) {
  await pool.query(
    'INSERT INTO paper_equity_snapshots (strategy_id, equity_usd) VALUES ($1, $2)',
    [strategyId, equityUsd]
  );
}

async function getPaperEquitySnapshots(strategyId) {
  const { rows } = await pool.query(
    'SELECT * FROM paper_equity_snapshots WHERE strategy_id = $1 ORDER BY recorded_at ASC',
    [strategyId]
  );
  return rows;
}

// ─── Live engine per-asset candle tracking ─────────────────
// Ensures each closed candle is acted on exactly once per strategy+asset,
// matching the backtest engine's one-decision-per-bar semantics.
async function getLastProcessedCandleTime(strategyId, asset) {
  const { rows } = await pool.query(
    'SELECT last_candle_time FROM paper_asset_state WHERE strategy_id = $1 AND asset = $2',
    [strategyId, asset]
  );
  return rows[0] ? parseInt(rows[0].last_candle_time) : null;
}

async function setLastProcessedCandleTime(strategyId, asset, candleTime) {
  await pool.query(`
    INSERT INTO paper_asset_state (strategy_id, asset, last_candle_time)
    VALUES ($1, $2, $3)
    ON CONFLICT (strategy_id, asset) DO UPDATE SET last_candle_time = EXCLUDED.last_candle_time
  `, [strategyId, asset, candleTime]);
}

module.exports = {
  initDB,
  createUser,
  getUserByEmail,
  getAllUsers,
  saveExchange,
  getAllExchanges,
  getExchangeById,
  deleteExchange,
  saveDailySnapshot,
  getSnapshotsByExchangeId,
  upsertShareLink,
  getShareLinkByUserId,
  getShareLinkByToken,
  deleteShareLink,
  createTelegramLinkCode,
  consumeTelegramLinkCode,
  upsertTelegramLink,
  getTelegramLinkByUserId,
  deleteTelegramLink,
  getUserIdByTelegramChatId,
  createPriceAlert,
  getPriceAlertsByUserId,
  getAllActivePriceAlerts,
  deletePriceAlert,
  markAlertTriggered,
  createPaperStrategy,
  getPaperStrategiesByUserId,
  getPaperStrategyById,
  getAllLivePaperStrategies,
  updatePaperStrategySpec,
  updatePaperStrategyStatus,
  updatePaperStrategyEquity,
  updatePaperStrategyRisk,
  deletePaperStrategy,
  addStrategyChatMessage,
  getStrategyChatMessages,
  createBacktestRun,
  getBacktestRunsByStrategyId,
  openPaperPosition,
  closePaperPosition,
  getOpenPaperPositions,
  getPaperPositionsByStrategyId,
  addPaperEquitySnapshot,
  getPaperEquitySnapshots,
  getLastProcessedCandleTime,
  setLastProcessedCandleTime,
  updatePaperPositionPeak
};
