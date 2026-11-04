// /ab-arm-metrics read-out (2026-11-04, cross-game widen A/B).
// Run: node --test test/ab-arm-metrics.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeArms } = require('../services/ab-arm-metrics');

const row = (arm, o = {}) => ({ status: 'quoted', order_uuid: null, confirmed_stake: null, pnl: null, fair_parlay_prob: 0.25,
  ...o, meta: { xgWidenArm: arm, offeredImpliedProb: 0.265, ...(o.meta || {}) } });

test('groups by arm, re-weights sampled quotes, counts only real fills, calibrates on raw fair', () => {
  const rows = [
    row('control', { meta: { persistWeight: 20 } }),                           // sampled unfilled quote = 20
    row('control', { status: 'confirmed', order_uuid: null }),                 // won the bid, not booked: not a fill
    row('control', { status: 'settled_lost', order_uuid: 'u1', confirmed_stake: 300, pnl: -300,
      meta: { expectedValue: 4, xgFactorApplied: true, xgFactorPreFair: 0.25, offeredImpliedProb: 0.30 } }),
    row('control', { status: 'settled_won', order_uuid: 'u2', confirmed_stake: 300, pnl: 100,
      meta: { expectedValue: 4, gameTime: { finalizedAt: 'x', ev: -2 } } }),
    row('widen', { status: 'settled_won', order_uuid: 'u3', confirmed_stake: 100, pnl: 40,
      meta: { expectedValue: 9, legs: [{ settlementStatus: 'void' }] } }),
    row('widen', { status: 'confirmed', order_uuid: 'u4', confirmed_stake: 50, meta: { expectedValue: 1, evLive: { ev: 7, coverage: 0 } } }),
    row('widen', { status: 'confirmed', order_uuid: 'u5', confirmed_stake: 50, meta: { expectedValue: 1, evLive: { ev: 3, coverage: 0.5 } } }),
    row(null), { status: 'quoted', meta: {} },
  ];
  const w = r => (r.meta && r.meta.persistWeight) || 1;
  const s = summarizeArms(rows, 'xgWidenArm', w);
  assert.deepStrictEqual(Object.keys(s).sort(), ['control', 'widen']);
  const c = s.control;
  assert.strictEqual(c.quotes, 23);
  assert.strictEqual(c.fills, 2);
  assert.strictEqual(c.risk, 600);
  assert.strictEqual(c.evFill, 8);
  assert.strictEqual(c.evLive, 2);   // -2 frozen game-time + 4 fill fallback
  assert.deepStrictEqual(c.evLiveSources, { gametime: 1, live: 0, close: 0, fill: 1 });
  assert.strictEqual(c.pnl, -200);
  assert.strictEqual(c.calibN, 2);
  assert.strictEqual(c.hits, 1);     // settled_lost = the bettor won
  assert.strictEqual(c.expHits, 0.5);
  assert.strictEqual(s.widen.calibN, 0, 'a voided leg leaves calibration');
  assert.strictEqual(s.widen.settledN, 1);
  assert.deepStrictEqual(s.widen.evLiveSources, { gametime: 0, live: 1, close: 0, fill: 2 }, 'a coverage-0 EV live is not a read');
  assert.strictEqual(s.widen.evLive, 9 + 1 + 3);
});

test('rejects an arm key that is not <name>Arm', () => {
  assert.throws(() => summarizeArms([], 'status'));
  assert.throws(() => summarizeArms([], 'x;drop'));
});
