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

// Called by the /api/telegram/webhook route for each incoming update.
async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const match = message.text.match(/^\/start\s+([a-f0-9]+)$/i);

  if (match) {
    const code = match[1];
    const userId = await db.consumeTelegramLinkCode(code);
    if (userId) {
      await db.upsertTelegramLink(userId, String(chatId));
      await sendMessage(chatId, '✅ Conta ligada com sucesso! Vais receber os teus alertas aqui.');
    } else {
      await sendMessage(chatId, '⚠️ Este link já expirou ou é inválido. Gera um novo a partir da app.');
    }
    return;
  }

  if (message.text === '/start') {
    await sendMessage(chatId, 'Olá! Para ligar este chat à tua conta assetfol.io, usa o link "Ligar ao Telegram" nas definições de Alertas da app.');
  }
}

module.exports = { isConfigured, getBotUsername, sendMessage, notifyUser, createLinkInvite, handleUpdate };
