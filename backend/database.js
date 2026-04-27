const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'crypto-dashboard.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE,
    total_value_usdt REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exchanges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    passphrase TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migração — adiciona coluna passphrase se não existir
try {
  db.exec(`ALTER TABLE exchanges ADD COLUMN passphrase TEXT DEFAULT ''`);
} catch (e) { }

// Snapshots
function saveDailySnapshot(date, totalValueUsdt) {
  const stmt = db.prepare(`
    INSERT INTO daily_snapshots (date, total_value_usdt)
    VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET total_value_usdt = excluded.total_value_usdt
  `);
  return stmt.run(date, totalValueUsdt);
}

function getAllSnapshots() {
  return db.prepare('SELECT * FROM daily_snapshots ORDER BY date ASC').all();
}

// Exchanges
function saveExchange(id, name, type, apiKey, apiSecret, passphrase = '') {
  const stmt = db.prepare(`
    INSERT INTO exchanges (id, name, type, api_key, api_secret, passphrase)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      api_key = excluded.api_key,
      api_secret = excluded.api_secret,
      passphrase = excluded.passphrase
  `);
  return stmt.run(id, name, type, apiKey, apiSecret, passphrase);
}

function getAllExchanges() {
  return db.prepare('SELECT id, name, type FROM exchanges').all();
}

function getExchangeById(id) {
  return db.prepare('SELECT * FROM exchanges WHERE id = ?').get(id);
}

function deleteExchange(id) {
  return db.prepare('DELETE FROM exchanges WHERE id = ?').run(id);
}

module.exports = {
  saveDailySnapshot,
  getAllSnapshots,
  saveExchange,
  getAllExchanges,
  getExchangeById,
  deleteExchange
};