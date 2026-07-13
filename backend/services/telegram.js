const axios = require('axios');
const crypto = require('crypto');
const db = require('../database');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

let cachedBotUsername = null;

function isConfigured() {
  return !!BOT_TOKEN;
}

async function getBotUsername() {
  if (!isConfigured()) return null;
  if (cachedBotUsername) return cachedBotUsername;
  const res = await axios.get(`${API_BASE}/getMe`, { timeout: 10000 });
  cachedBotUsername = res.data.result?.username || null;
  return cachedBotUsername;
}

async function sendMessage(chatId, text) {
  if (!isConfigured()) {
    console.error('Telegram: TELEGRAM_BOT_TOKEN not set — skipping message send');
    return;
  }
  try {
    await axios.post(`${API_BASE}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    }, { timeout: 10000 });
  } catch (e) {
    console.error('Telegram sendMessage error:', e.response?.data || e.message);
  }
}

async function notifyUser(userId, text) {
  const link = await db.getTelegramLinkByUserId(userId);
  if (!link) return;
  await sendMessage(link.chat_id, text);
}

// Generates a one-time link code + the deep link URL the user should click
// from the app. The code expires in 10 minutes.
async function createLinkInvite(userId) {
  const username = await getBotUsername();
  if (!username) throw new Error('Telegram bot not configured (missing TELEGRAM_BOT_TOKEN)');
  const code = crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.createTelegramLinkCode(userId, code, expiresAt);
  return { url: `https://t.me/${username}?start=${code}`, expiresInMinutes: 10 };
}

const HELP_TEXT = 'Comandos disponíveis:\n/saldo — saldo total da carteira\n/estrategias — lista as estratégias de Paper Trading ao vivo\n/pausar &lt;nome&gt; — pausa uma estratégia ao vivo';

// Called by the /api/telegram/webhook route for each incoming update.
// `handlers` (optional) supplies the balance/paper-strategy logic that lives in
// index.js, so this module doesn't need to require it back (circular).
async function handleUpdate(update, handlers = {}) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const startMatch = text.match(/^\/start\s+([a-f0-9]+)$/i);

  if (startMatch) {
    const code = startMatch[1];
    const userId = await db.consumeTelegramLinkCode(code);
    if (userId) {
      await db.upsertTelegramLink(userId, String(chatId));
      await sendMessage(chatId, '✅ Conta ligada com sucesso! Vais receber os teus alertas aqui.');
    } else {
      await sendMessage(chatId, '⚠️ Este link já expirou ou é inválido. Gera um novo a partir da app.');
    }
    return;
  }

  if (text === '/start') {
    await sendMessage(chatId, 'Olá! Para ligar este chat à tua conta assetfol.io, usa o link "Ligar ao Telegram" nas definições de Alertas da app.');
    return;
  }

  if (!text.startsWith('/')) return; // ignore plain chatter — only commands are handled below

  const userId = await db.getUserIdByTelegramChatId(String(chatId));
  if (!userId) {
    await sendMessage(chatId, 'Esta conta ainda não está ligada. Usa o link "Ligar ao Telegram" nas definições de Alertas da app.');
    return;
  }

  if (text === '/saldo') {
    if (!handlers.getGlobalBalance) return;
    try {
      const totalUsdt = await handlers.getGlobalBalance(userId);
      await sendMessage(chatId, `💰 Saldo total: $${totalUsdt.toFixed(2)}`);
    } catch (e) {
      await sendMessage(chatId, `⚠️ Não foi possível calcular o saldo agora: ${e.message}`);
    }
    return;
  }

  if (text === '/estrategias') {
    if (!handlers.listLiveStrategies) return;
    const strategies = await handlers.listLiveStrategies(userId);
    if (!strategies.length) {
      await sendMessage(chatId, 'Não tens estratégias de Paper Trading ao vivo neste momento.');
      return;
    }
    const lines = strategies.map(s => {
      const equity = parseFloat(s.equity);
      const startingCapital = parseFloat(s.starting_capital);
      const pnl = equity - startingCapital;
      const pnlPct = startingCapital > 0 ? (pnl / startingCapital) * 100 : 0;
      return `• <b>${s.name}</b>: $${equity.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    });
    await sendMessage(chatId, `📊 Estratégias ao vivo:\n${lines.join('\n')}`);
    return;
  }

  const pauseMatch = text.match(/^\/pausar\s+(.+)$/i);
  if (pauseMatch) {
    if (!handlers.pauseStrategyByName) return;
    const name = pauseMatch[1].trim();
    const result = await handlers.pauseStrategyByName(userId, name);
    await sendMessage(chatId, result
      ? `🛑 Estratégia "${result.name}" pausada.`
      : `Não encontrei nenhuma estratégia ao vivo chamada "${name}".`);
    return;
  }

  if (text === '/help' || text === '/ajuda') {
    await sendMessage(chatId, HELP_TEXT);
    return;
  }

  await sendMessage(chatId, `Comando não reconhecido.\n\n${HELP_TEXT}`);
}

module.exports = { isConfigured, getBotUsername, sendMessage, notifyUser, createLinkInvite, handleUpdate };
