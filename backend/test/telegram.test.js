const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const telegram = require('../services/telegram');

// TELEGRAM_BOT_TOKEN is unset in this environment, so sendMessage() no-ops
// (logs and returns) instead of hitting the network — safe for testing the
// command-routing logic in handleUpdate() without a real bot or DB.

function fakeUpdate(text, chatId = 123) {
  return { message: { chat: { id: chatId }, text } };
}

test('handleUpdate ignores updates with no message text', async () => {
  await assert.doesNotReject(telegram.handleUpdate({}));
  await assert.doesNotReject(telegram.handleUpdate({ message: {} }));
});

test('handleUpdate on an unlinked chat replies without calling any handler', async () => {
  const original = db.getUserIdByTelegramChatId;
  db.getUserIdByTelegramChatId = async () => null;
  try {
    let called = false;
    await telegram.handleUpdate(fakeUpdate('/saldo'), { getGlobalBalance: async () => { called = true; return 0; } });
    assert.equal(called, false);
  } finally {
    db.getUserIdByTelegramChatId = original;
  }
});

test('handleUpdate routes /saldo to getGlobalBalance for the linked user', async () => {
  const original = db.getUserIdByTelegramChatId;
  db.getUserIdByTelegramChatId = async (chatId) => (chatId === '123' ? 42 : null);
  try {
    let receivedUserId = null;
    await telegram.handleUpdate(fakeUpdate('/saldo'), {
      getGlobalBalance: async (userId) => { receivedUserId = userId; return 1234.56; }
    });
    assert.equal(receivedUserId, 42);
  } finally {
    db.getUserIdByTelegramChatId = original;
  }
});

test('handleUpdate routes /estrategias to listLiveStrategies for the linked user', async () => {
  const original = db.getUserIdByTelegramChatId;
  db.getUserIdByTelegramChatId = async () => 42;
  try {
    let called = false;
    await telegram.handleUpdate(fakeUpdate('/estrategias'), {
      listLiveStrategies: async (userId) => { called = true; assert.equal(userId, 42); return []; }
    });
    assert.equal(called, true);
  } finally {
    db.getUserIdByTelegramChatId = original;
  }
});

test('handleUpdate parses "/pausar <name>" and passes the trimmed name through', async () => {
  const original = db.getUserIdByTelegramChatId;
  db.getUserIdByTelegramChatId = async () => 42;
  try {
    let receivedArgs = null;
    await telegram.handleUpdate(fakeUpdate('/pausar   RSI Dip Buyer  '), {
      pauseStrategyByName: async (userId, name) => { receivedArgs = { userId, name }; return null; }
    });
    assert.deepEqual(receivedArgs, { userId: 42, name: 'RSI Dip Buyer' });
  } finally {
    db.getUserIdByTelegramChatId = original;
  }
});

test('handleUpdate does not treat plain (non-command) chatter as a command', async () => {
  const original = db.getUserIdByTelegramChatId;
  let lookupCalled = false;
  db.getUserIdByTelegramChatId = async () => { lookupCalled = true; return 42; };
  try {
    await telegram.handleUpdate(fakeUpdate('hello there'));
    assert.equal(lookupCalled, false); // never even resolves the linked user for non-command text
  } finally {
    db.getUserIdByTelegramChatId = original;
  }
});
