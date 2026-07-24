// Regression tests: a real fill is counted EXACTLY ONCE no matter which event
// carries the orderUuid first.
//
// Background (2026-07-24): PX's order.finalized event routinely races the
// accept-POST response. recordFinalized stamped order.orderUuid directly, so
// recordConfirmation's uuid-presence gate skipped all fill counting —
// sessionFills read 0 forever, the Win Rate heatmap fill buckets stayed 0,
// and market-intel weWon read 2 while 73 real fills sat in the DB. The fix
// centralizes counting in _countFillOnce with an explicit meta.fillCounted
// idempotence flag.
//
// Run: npm test   (or: node --test test/fill-count-race.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const ot = require('../services/order-tracker');

function freshParlay(id) {
  ot.recordQuote(id, [{ line_id: 'L-' + id }], 150, 100, 0.4, {});
}

test('finalized-first then confirm counts the fill exactly once', () => {
  const before = ot.getStats().sessionFills;
  freshParlay('race-1');
  ot.recordFinalized('race-1', 'uuid-race-1', {});
  ot.recordConfirmation('race-1', 'uuid-race-1', 150, 100);
  const after = ot.getStats().sessionFills;
  assert.equal(after - before, 1,
    `finalized→confirm must count once (got +${after - before})`);
});

test('confirm-first then finalized counts the fill exactly once', () => {
  const before = ot.getStats().sessionFills;
  freshParlay('race-2');
  ot.recordConfirmation('race-2', 'uuid-race-2', 150, 100);
  ot.recordFinalized('race-2', 'uuid-race-2', {});
  const after = ot.getStats().sessionFills;
  assert.equal(after - before, 1,
    `confirm→finalized must count once (got +${after - before})`);
});

test('duplicate confirms do not double-count', () => {
  const before = ot.getStats().sessionFills;
  freshParlay('race-3');
  ot.recordConfirmation('race-3', 'uuid-race-3', 150, 100);
  ot.recordConfirmation('race-3', 'uuid-race-3', 150, 100);
  ot.recordFinalized('race-3', 'uuid-race-3', {});
  const after = ot.getStats().sessionFills;
  assert.equal(after - before, 1,
    `duplicate events must count once (got +${after - before})`);
});

test('a confirm with NO uuid does not count (bettor still in review)', () => {
  const before = ot.getStats().sessionFills;
  freshParlay('race-4');
  ot.recordConfirmation('race-4', null, 150, 100);
  const after = ot.getStats().sessionFills;
  assert.equal(after - before, 0,
    `uuid-less confirm must not count (got +${after - before})`);
});
