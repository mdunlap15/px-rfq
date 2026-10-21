// Leg-drift correction in the pricer (2026-10-21): a family that consistently
// moves against us between our fill and its own start gets its fair raised by
// the measured (shrunk, capped) drift — 'correct' arm only, never on fairOnly
// reads, never more generous. Ships dark.
// Run: node --test test/leg-drift-correction.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const ld = require('../services/leg-drift');
const { config } = require('../config');

const L = {};
let seq = 0;
function sog(hoursOut = 1) {
  const id = 'ldc-' + (++seq), ev = 'LDC-E' + seq, st = new Date(Date.now() + hoursOut * 3600e3).toISOString();
  L[id] = { lineId: id, sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', marketType: 'player_shots_on_goal', oddsApiMarket: 'player_shots_on_goal',
    propType: 'shots_on_goal', playerName: 'P' + seq, teamName: 'P' + seq, selection: 'over', oddsApiSelection: 'over', line: 2.5,
    homeTeam: 'H' + ev, awayTeam: 'A' + ev, pxEventId: ev, startTime: st, startTimeMs: Date.parse(st), propFetchedAt: Date.now(), fairProb: 0.5 };
  return id;
}
const KEY = 'icehockey_nhl|player_shots_on_goal|over|near';
const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.stale = oddsFeed.isStaleForEvent; saved.pre = oddsFeed.isEventStalePreGame; saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 6000, maxRiskPerParlayWithProp: 6000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, legDriftCorrectionPercent: 0, legDriftCorrectionOverrides: {} }, extra);
  ld.__setTableForTest({ corrections: { [KEY]: 1.02 } });
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.isStaleForEvent = saved.stale; if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
  ld.__setTableForTest({});
}
async function price(ids, pid, opts = {}) {
  const r = await pricer.priceParlay(ids, Object.assign({ parlayId: pid }, opts));
  try { orderTracker.releasePending(pid); } catch (_) {}
  return r;
}

test('dark by default: no correction, no arm', async () => {
  stub();
  try {
    const r = await price([sog(), sog()], 'ldc-dark');
    assert.ok(r && r.meta);
    assert.strictEqual(r.meta.legDriftArm, null);
    assert.ok(r.meta.legs.every(l => l.legDriftCorr == null && Math.abs(l.fairProb - 0.5) < 1e-9));
  } finally { restore(); }
});

test('correct arm: the family fair is raised by the measured multiplier, pre-correction fair kept; fair-only reads are never corrected', async () => {
  stub({ legDriftCorrectionPercent: 100 });
  try {
    const r = await price([sog(), sog()], 'ldc-on');
    assert.strictEqual(r.meta.legDriftArm, 'correct');
    for (const l of r.meta.legs) {
      assert.ok(Math.abs(l.fairProb - 0.51) < 1e-4, `fair ${l.fairProb}`);
      assert.deepStrictEqual([l.legDriftCorr.key, l.legDriftCorr.mult, l.legDriftCorr.preFair], [KEY, 1.02, 0.5]);
    }
    const fo = await pricer.priceParlay([sog()], { fairOnly: true, parlayId: 'ldc-fo' });
    assert.ok(Math.abs(fo.legs[0].fairProb - 0.5) < 1e-9, 'the measurement path reads the raw fair');
  } finally { restore(); }
});

test('a family with no correction is untouched and the ticket carries no arm; 50% gives both arms, control unchanged', async () => {
  stub({ legDriftCorrectionPercent: 100 });
  try {
    const far = await price([sog(10), sog(10)], 'ldc-far');      // far horizon: different family, no correction
    assert.strictEqual(far.meta.legDriftArm, null);
    config.pricing.legDriftCorrectionPercent = 50;
    const arms = new Set();
    for (let i = 0; i < 24; i++) {
      const r = await price([sog(), sog()], 'ldc-arm-' + i);
      arms.add(r.meta.legDriftArm);
      if (r.meta.legDriftArm === 'control') assert.ok(r.meta.legs.every(l => Math.abs(l.fairProb - 0.5) < 1e-9 && !l.legDriftCorr));
    }
    assert.deepStrictEqual([...arms].sort(), ['control', 'correct']);
  } finally { restore(); }
});

test('the drift measurement uses the PRE-correction fair (a correction does not erode its own evidence)', () => {
  const now = Date.now();
  const o = { confirmedStake: 500, confirmedAt: new Date(now - 3600e3).toISOString(), meta: { legs: [
    { lineId: 'x1', sport: 'icehockey_nhl', market: 'player_shots_on_goal', selection: 'over', fairProb: 0.51, legDriftCorr: { preFair: 0.5, mult: 1.02 }, startTime: new Date(now).toISOString() }],
    gameTime: { finalizedAt: 'x', legs: { x1: { fair: 0.55 } } } } };
  const rows = ld.collectRows([o], 7, now);
  assert.ok(Math.abs(rows[0].drift - 0.10) < 1e-9, 'drift vs 0.50 (pre-correction), not 0.51');
});
