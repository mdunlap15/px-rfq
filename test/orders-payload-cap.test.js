// /orders settled-row cap (Railway cost fix, 2026-08-07).
//
// getRecentOrders "always include settled and confirmed" made /orders ship
// EVERY settled order ever loaded — measured 10,474 rows / 60MB decompressed /
// 5MB gzipped, serialized and gzipped every ~10s per open dashboard. The new
// opts.settledLimit caps SETTLED rows (most recent first); OPEN (confirmed)
// orders are never capped — they are the live book. No cap passed = old
// behavior, so viewer.html and scripts are untouched.
//
// Run: npm test   (db is a hermetic no-op under the test runner)

const { test } = require('node:test');
const assert = require('node:assert');
const ot = require('../services/order-tracker');

function mkSettled(i) {
  const id = 'cap-settled-' + i, uuid = 'cap-uuid-' + i;
  ot.recordQuote(id, [{ line_id: 'L-' + id }], 150, 100, 0.4, {});
  ot.recordConfirmation(id, uuid, 150, 100);
  ot.recordSettlement(uuid, 'won', null, { trusted: true });
}
function mkConfirmed(i) {
  const id = 'cap-open-' + i;
  ot.recordQuote(id, [{ line_id: 'L-' + id }], 150, 100, 0.4, {});
  ot.recordConfirmation(id, 'cap-open-uuid-' + i, 150, 100);
}

test('settledLimit caps settled rows but never open (confirmed) rows', () => {
  for (let i = 0; i < 6; i++) mkSettled(i);
  for (let i = 0; i < 3; i++) mkConfirmed(i);

  const capped = ot.getRecentOrders(50, { settledLimit: 2 });
  const settled = capped.filter(o => String(o.parlayId).startsWith('cap-settled-') && String(o.status).startsWith('settled_'));
  const open = capped.filter(o => String(o.parlayId).startsWith('cap-open-') && o.status === 'confirmed');
  assert.equal(settled.length, 2, 'settled rows must be capped at settledLimit');
  assert.equal(open.length, 3, 'open orders must NEVER be capped — they are the live book');
});

test('no settledLimit preserves the old include-everything behavior', () => {
  const all = ot.getRecentOrders(50);
  const settled = all.filter(o => String(o.parlayId).startsWith('cap-settled-'));
  assert.equal(settled.length, 6, 'back-compat: uncapped call returns all settled');
});

test('a non-numeric or zero settledLimit means uncapped', () => {
  assert.equal(ot.getRecentOrders(50, { settledLimit: 0 }).filter(o => String(o.parlayId).startsWith('cap-settled-')).length, 6);
  assert.equal(ot.getRecentOrders(50, { settledLimit: NaN }).filter(o => String(o.parlayId).startsWith('cap-settled-')).length, 6);
  assert.equal(ot.getRecentOrders(50, {}).filter(o => String(o.parlayId).startsWith('cap-settled-')).length, 6);
});
