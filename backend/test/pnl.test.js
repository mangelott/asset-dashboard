const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeRealizedPnl } = require('../utils/pnl');

test('single buy then full sell at a profit', () => {
  const trades = [
    { side: 'buy', qty: 10, price: 100 },
    { side: 'sell', qty: 10, price: 120 }
  ];
  const [buy, sell] = computeRealizedPnl(trades);
  assert.equal(buy.pnl, null);
  assert.equal(buy.pnlPct, null);
  assert.equal(sell.pnl, 200); // (120 - 100) * 10
  assert.equal(sell.pnlPct, 20); // 20%
});

test('single buy then full sell at a loss', () => {
  const trades = [
    { side: 'buy', qty: 10, price: 100 },
    { side: 'sell', qty: 10, price: 80 }
  ];
  const [, sell] = computeRealizedPnl(trades);
  assert.equal(sell.pnl, -200);
  assert.equal(sell.pnlPct, -20);
});

test('weighted average cost across multiple buys at different prices', () => {
  const trades = [
    { side: 'buy', qty: 10, price: 100 },  // cost=1000, qty=10
    { side: 'buy', qty: 10, price: 200 },  // cost=3000, qty=20 -> avgCost=150
    { side: 'sell', qty: 5, price: 180 }
  ];
  const [, , sell] = computeRealizedPnl(trades);
  assert.equal(sell.pnl, 150); // (180 - 150) * 5
  assert.equal(sell.pnlPct, 20); // (180-150)/150 * 100
});

test('partial sell preserves the average cost basis for the remainder', () => {
  const trades = [
    { side: 'buy', qty: 10, price: 100 },
    { side: 'buy', qty: 10, price: 200 },  // avgCost = 150
    { side: 'sell', qty: 5, price: 180 },  // partial sell at avgCost=150
    { side: 'sell', qty: 15, price: 160 }  // remaining qty, avgCost must still be 150
  ];
  const [, , , lastSell] = computeRealizedPnl(trades);
  assert.equal(lastSell.pnl, 150); // (160 - 150) * 15
});

test('re-entry after a full exit resets the cost basis (no bleed from prior round-trip)', () => {
  const trades = [
    { side: 'buy', qty: 10, price: 100 },
    { side: 'sell', qty: 10, price: 110 }, // full exit, cost/qty back to 0
    { side: 'buy', qty: 5, price: 90 },
    { side: 'sell', qty: 5, price: 100 }
  ];
  const results = computeRealizedPnl(trades);
  assert.equal(results[1].pnl, 100); // (110-100)*10
  assert.equal(results[3].pnl, 50);  // (100-90)*5 — must use the NEW cost basis, not blended with the old
});

test('sell with no prior position does not throw and reports a zero-cost-basis pnl', () => {
  // Documents current behavior for out-of-order/incomplete trade history rather
  // than prescribing it as economically correct.
  const trades = [{ side: 'sell', qty: 5, price: 100 }];
  const [sell] = computeRealizedPnl(trades);
  assert.equal(sell.pnl, 500); // (100 - 0) * 5
  assert.equal(sell.pnlPct, 0); // avgCost is 0, so pct is defined as 0, not Infinity/NaN
});
