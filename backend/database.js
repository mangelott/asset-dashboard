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
  getSnapshotsByExchangeId
};
