const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDrawdownPct } = require('../services/paperTradingEngine');

test('computeDrawdownPct is 0 when equity is at or above the peak', () => {
  assert.equal(computeDrawdownPct(10000, 10000), 0);
  assert.equal(computeDrawdownPct(10000, 12000), -20); // negative = new high, not a drawdown
});

test('computeDrawdownPct reports the percentage fallen from the peak', () => {
  assert.equal(computeDrawdownPct(10000, 7500), 25);
  assert.equal(computeDrawdownPct(20000, 15000), 25);
});

test('computeDrawdownPct does not divide by zero when peak is 0', () => {
  assert.equal(computeDrawdownPct(0, -100), 0);
});
