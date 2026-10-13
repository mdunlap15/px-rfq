// PROP BOOK CAP A/B (2026-10-13). Operator: "build the 2% cap as a split test".
// Cap arm: no prop leg more than propBookCapRelPct % more generous than the
// most generous sportsbook's raw price on its side (lineInfo.propBestRaw).
// Deterministic per parlayId, recorded whether or not it binds, ships DARK.
// Run: node --test test/prop-book-cap.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUT = new Date(Date.now() + 20 * 3600e3).toISOString();
const L = {};
let seq = 0;
function sog(fair, best, sel = 'over') {
  const id = 'pbc-' + (++seq), ev = 'PBC-E' + seq;
  L[id] = { lineId: id, sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', marketType: 'player_shots_on_goal',
    oddsApiMarket: 'player_shots_on_goal', propType: 'shots_on_goal', playerName: 'Player ' + seq, teamName: 'Player ' + seq,
    selection: sel, oddsApiSelection: sel, line: 2.5, homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
    startTime: FUT, startTimeMs: Date.parse(FUT), propFetchedAt: Date.now(),
    fairProb: fair, fairProbOver: sel === 'over' ? fair : 1 - fair, fairProbUnder: sel === 'over' ? 1 - fair : fair,
    propBestRaw: best == null ? null : { [sel]: best } };
  return id;
}
function ml() {
  const id = 'pbc-' + (++seq), ev = 'PBC-E' + seq;
  L[id] = { lineId: id, sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
    pxEventId: ev, startTime: FUT, startTimeMs: Date.parse(FUT) };
  return id;
}
const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.getFairProb = () => 0.55;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 6000, maxRiskPerParlayWithProp: 6000, maxOdds: 50000, obRelayEnabled: false,
    freshGateEnabled: false, propBookCapPercent: 0, propBookCapRelPct: 2, twoLegWidenPercent: 0, cfbWidenPercent: 0 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
async function price(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
  return r.meta;
}

test('dark by default: no arm, no cap', async () => {
  stub();
  try {
    const m = await price([sog(0.50, 0.60), sog(0.50, 0.60)], 'pbc-dark');
    assert.strictEqual(m.propBookCapArm, null);
    assert.strictEqual(m.propBookCapApplied, false);
  } finally { restore(); }
});

test('cap arm: offered lifted by exactly the product of best/(1+rel) over leg offered; fair untouched', async () => {
  stub({ propBookCapPercent: 100 });
  let m, c;
  try {
    m = await price([sog(0.50, 0.56), sog(0.45, 0.50, 'under')], 'pbc-cap');
  } finally { restore(); }
  assert.strictEqual(m.propBookCapArm, 'cap');
  assert.strictEqual(m.propBookCapApplied, true);
  assert.strictEqual(m.propBookCapLegsBound, 2);
  let want = 1;
  for (const l of m.legs) {
    assert.ok(l.bookBestRaw > 0, 'best book price recorded per leg');
    want *= Math.max(1, (l.bookBestRaw / 1.02) / l.legOfferedProb);
  }
  assert.ok(Math.abs(m.offeredImpliedProb / m.propBookCapPreProb - want) < 2e-3, `ratio ${m.offeredImpliedProb / m.propBookCapPreProb} vs ${want}`);
  stub({ propBookCapPercent: 0 });
  try { c = await price([sog(0.50, 0.56), sog(0.45, 0.50, 'under')], 'pbc-ctl'); } finally { restore(); }
  assert.ok(Math.abs(c.offeredImpliedProb - m.propBookCapPreProb) < 1e-4, 'pre-cap price = the control price');
  assert.ok(Math.abs(c.fairParlayProb - m.fairParlayProb) < 1e-9, 'fair is untouched');
});

test('within 2% of the best book: arm recorded, nothing changes', async () => {
  stub({ propBookCapPercent: 100 });
  try {
    // best book just 1% above our leg offer -> target (best/1.02) is BELOW our offer
    const probe = await price([sog(0.50, 0.40), sog(0.50, 0.40)], 'pbc-probe');
    const off = probe.legs[0].legOfferedProb;
    const m = await price([sog(0.50, off * 1.01), sog(0.50, off * 1.01)], 'pbc-near');
    assert.strictEqual(m.propBookCapArm, 'cap');
    assert.strictEqual(m.propBookCapApplied, false);
    assert.strictEqual(m.propBookCapLegsBound, 0);
  } finally { restore(); }
});

test('out of scope: no prop leg with a book price -> arm null; a game leg is never capped', async () => {
  stub({ propBookCapPercent: 100 });
  try {
    assert.strictEqual((await price([ml(), ml()], 'pbc-games')).propBookCapArm, null);
    assert.strictEqual((await price([sog(0.5, null), ml()], 'pbc-nobook')).propBookCapArm, null);
    const mix = await price([sog(0.50, 0.60), ml()], 'pbc-mix');
    assert.strictEqual(mix.propBookCapLegsBound, 1, 'only the prop leg is compared to a book');
  } finally { restore(); }
});

test('arm is a pure function of parlayId; both arms occur at 50%', async () => {
  stub({ propBookCapPercent: 50 });
  try {
    const arms = new Set();
    for (let i = 0; i < 24; i++) arms.add((await price([sog(0.5, 0.6), sog(0.5, 0.6)], 'pbc-arm-' + i)).propBookCapArm);
    assert.deepStrictEqual([...arms].sort(), ['cap', 'control']);
    const a = (await price([sog(0.5, 0.6), sog(0.5, 0.6)], 'pbc-same')).propBookCapArm;
    const b = (await price([sog(0.5, 0.6), sog(0.5, 0.6)], 'pbc-same')).propBookCapArm;
    assert.strictEqual(a, b);
  } finally { restore(); }
});
