// Per-leg drift from fill to each leg's own start, and the adverse-only family
// correction (2026-10-21). Operator: "make sure we are not leaking much value on
// any legs and correcting for cases where we consistently are".
// Run: node --test test/leg-drift.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const ld = require('../services/leg-drift');
const { config } = require('../config');

const NOW = Date.parse('2026-10-21T20:00:00Z');
function fill(i, legs, hoursAgo = 24) {
  const conf = new Date(NOW - hoursAgo * 3600e3).toISOString();
  const gl = {};
  for (const l of legs) gl[l.lineId] = { fair: l.gt, evDelta: l.evDelta || 1, frozen: true };
  return { confirmedStake: 500, confirmedAt: conf, meta: { legs: legs.map(l => ({ lineId: l.lineId, sport: l.sport || 'icehockey_nhl', market: l.market || 'player_shots_on_goal',
    selection: l.sel || 'over', fairProb: l.fill, startTime: new Date(Date.parse(conf) + (l.hrs || 1) * 3600e3).toISOString() })), gameTime: { finalizedAt: 'x', legs: gl } } };
}

test('family keys: side by selection for totals/props, fav/dog by fill fair for sides, near/far by hours to start', () => {
  assert.strictEqual(ld.familyKey('icehockey_nhl', 'player_shots_on_goal', 'over', 0.55, 1), 'icehockey_nhl|player_shots_on_goal|over|near');
  assert.strictEqual(ld.familyKey('baseball_mlb', 'moneyline', 'home', 0.62, 8), 'baseball_mlb|moneyline|fav|far');
  assert.strictEqual(ld.familyKey('baseball_mlb', 'spread', 'away', 0.41, 2), 'baseball_mlb|spread|dog|near');
});

test('each leg counts ONCE (a leg filled in many parlays is one sample); drift sign: > 0 = against us', () => {
  const orders = [];
  for (let i = 0; i < 5; i++) orders.push(fill(i, [{ lineId: 'same', fill: 0.50, gt: 0.55 }]));   // same leg 5x
  const rows = ld.collectRows(orders, 7, NOW);
  assert.strictEqual(rows.length, 5);
  const s = ld.summarize(rows, { minN: 1, zMin: 0 });
  const f = s.families['icehockey_nhl|player_shots_on_goal|over|near'];
  assert.strictEqual(f.legs, 1, 'distinct legs');
  assert.strictEqual(f.fills, 5);
  assert.strictEqual(f.meanDriftPct, 10);
});

test('correction: only a consistent ADVERSE leak qualifies; shrunk toward 0 and capped', () => {
  const mk = (n, base, spread, sel = 'over') => Array.from({ length: n }, (_, i) =>
    fill(i, [{ lineId: `${sel}-${base}-${i}`, fill: 0.5, gt: 0.5 * (1 + base + ((i % 2) ? spread : -spread)), sel }]));
  // 40 legs drifting +2% +/- 1% against us -> active, shrunk 2% x 40/70 = 1.14%
  let s = ld.summarize(ld.collectRows(mk(40, 0.02, 0.01), 30, NOW), { minN: 30, zMin: 2, maxPct: 3, prior: 30 });
  const k = 'icehockey_nhl|player_shots_on_goal|over|near';
  assert.ok(s.corrections[k] && Math.abs(s.corrections[k] - (1 + 0.02 * 40 / 70)) < 2e-4, JSON.stringify(s.families[k]));
  // favourable drift (moves toward us) never produces a correction
  s = ld.summarize(ld.collectRows(mk(40, -0.02, 0.01), 30, NOW), { minN: 30, zMin: 2 });
  assert.deepStrictEqual(s.corrections, {});
  // too few legs
  s = ld.summarize(ld.collectRows(mk(20, 0.05, 0.01), 30, NOW), { minN: 30, zMin: 2 });
  assert.deepStrictEqual(s.corrections, {});
  // noisy (z < 2): mean +0.5% with +/- 10%
  s = ld.summarize(ld.collectRows(mk(40, 0.005, 0.10), 30, NOW), { minN: 30, zMin: 2 });
  assert.deepStrictEqual(s.corrections, {});
  // huge drift is capped at maxPct
  s = ld.summarize(ld.collectRows(mk(400, 0.20, 0.01), 30, NOW), { minN: 30, zMin: 2, maxPct: 3, prior: 30 });
  assert.ok(Math.abs(s.corrections[k] - 1.03) < 1e-9);
});

test('correctionFor: measured table, operator override pins or disables, never below 1', () => {
  const saved = config.pricing.legDriftCorrectionOverrides;
  ld.__setTableForTest({ corrections: { 'icehockey_nhl|player_shots_on_goal|over|near': 1.012 } });
  const li = { sport: 'icehockey_nhl', marketType: 'player_shots_on_goal', selection: 'over', startTimeMs: NOW + 3600e3 };
  try {
    config.pricing.legDriftCorrectionOverrides = {};
    assert.strictEqual(ld.correctionFor(li, 0.55, NOW).mult, 1.012);
    assert.strictEqual(ld.correctionFor({ ...li, startTimeMs: NOW + 8 * 3600e3 }, 0.55, NOW).mult, 1, 'far horizon is a different family');
    config.pricing.legDriftCorrectionOverrides = { 'icehockey_nhl|player_shots_on_goal|over|near': 0 };
    assert.strictEqual(ld.correctionFor(li, 0.55, NOW).mult, 1, 'override 0 disables');
    config.pricing.legDriftCorrectionOverrides = { 'icehockey_nhl|player_shots_on_goal|over|near': 0.9 };
    assert.strictEqual(ld.correctionFor(li, 0.55, NOW).mult, 1, 'never below 1 (never more generous)');
  } finally { config.pricing.legDriftCorrectionOverrides = saved; ld.__setTableForTest({}); }
});
