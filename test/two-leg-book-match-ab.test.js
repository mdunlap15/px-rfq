// 2-leg book-match A/B (2026-11-10). Run: node --test test/two-leg-book-match-ab.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { config } = require('../config');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const pricer = require('../services/pricer');
const calib = require('../services/fair-calibration');

const KEYS = ['twoLegBookMatchPercent', 'twoLegBookMatchMinEdgePct', 'crossGameFactorPercent', 'crossGameWidenPercent', 'twoLegFactorPercent',
  'twoLegWidenPercent', 'calibEnabled', 'calibFloorMult', 'calibMinMarginPct', 'minTheoEdgePct', 'maxRiskPerParlay', 'maxOdds',
  'maxExposurePerTeam', 'maxExposurePerGame', 'maxRawExposurePerTeam'];
const saved = {};
const stubs = {};
function setup(o = {}) {
  for (const k of KEYS) saved[k] = config.pricing[k];
  Object.assign(config.pricing, { twoLegBookMatchPercent: 50, twoLegBookMatchMinEdgePct: 1, crossGameFactorPercent: 0, crossGameWidenPercent: 0,
    twoLegFactorPercent: 0, twoLegWidenPercent: 0, calibEnabled: true, calibFloorMult: 1.1, calibMinMarginPct: 8, minTheoEdgePct: 0,
    maxRiskPerParlay: 3000, maxOdds: 50000, maxExposurePerTeam: 1e9, maxExposurePerGame: 1e9, maxRawExposurePerTeam: 1e9 }, o);
  calib.__setCellsForTest(new Map());
  for (const k of ['getFairProb', 'isStaleForEvent', 'isEventStalePreGame', 'getFanDuelOdds', 'getDraftKingsOdds', 'getPinnacleOdds']) stubs[k] = oddsFeed[k];
  stubs.lookup = lineManager.lookupLine;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.isStaleForEvent = () => false;
  if (stubs.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  oddsFeed.getPinnacleOdds = () => null;
}
function teardown() {
  for (const k of KEYS) config.pricing[k] = saved[k];
  for (const [k, v] of Object.entries(stubs)) if (k !== 'lookup') oddsFeed[k] = v;
  lineManager.lookupLine = stubs.lookup;
  for (const id of Object.keys(LINES)) { try { require('../services/order-tracker').releaseQuoteReservations(id); } catch (_) {} }
}
function market(fair, fd, dk) {
  oddsFeed.getFairProb = () => fair;
  oddsFeed.getFanDuelOdds = () => fd;
  oddsFeed.getDraftKingsOdds = () => dk;
}

const START = new Date(Date.now() + 6 * 3600e3).toISOString();
const LINES = {};
function mkLine(ev) {
  const id = 'bm-' + ev;
  LINES[id] = { lineId: id, sport: 'icehockey_nhl', marketType: 'moneyline', teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
    oddsApiMarket: 'h2h', oddsApiSport: 'icehockey_nhl', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev, startTime: START, startTimeMs: Date.parse(START) };
  return id;
}
const armOf = (pid) => (crypto.createHash('md5').update('bm2:' + pid).digest().readUInt32BE(0) % 100) < 50 ? 'match' : 'control';
function pid(arm, tag) { for (let i = 0; ; i++) { const p = `bm-${tag}-${i}`; if (armOf(p) === arm) return p; } }
const imp = (a) => a > 0 ? 100 / (a + 100) : -a / (-a + 100);
async function quote(ids, parlayId) {
  const r = await pricer.priceParlay(ids, { parlayId });
  assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
  return r.meta;
}

test('match arm: offered = the more generous of FD / DK parlay; control keeps its (wider) price', async () => {
  setup();
  try {
    market(0.6, -160, -165);
    const ids = [mkLine('A1'), mkLine('A2')];
    const m = await quote(ids, pid('match', 'a'));
    assert.strictEqual(m.twoLegBookMatchArm, 'match');
    assert.strictEqual(m.twoLegBookMatch.book, 'fanduel');
    assert.ok(Math.abs(m.offeredImpliedProb - imp(-160) ** 2) < 1e-4, `offered ${m.offeredImpliedProb} vs FD ${imp(-160) ** 2}`);
    assert.ok(m.twoLegBookMatch.preProb > m.offeredImpliedProb, 'control price was wider than the books');
    assert.ok(Math.abs(m.fairParlayProb - 0.36) < 1e-6, 'fair untouched');
    const c = await quote(ids, pid('control', 'a'));
    assert.strictEqual(c.twoLegBookMatchArm, 'control');
    assert.ok(Math.abs(c.offeredImpliedProb - m.twoLegBookMatch.preProb) < 1e-4, 'control = the match arm pre-price');
    assert.ok(c.offeredImpliedProb >= 0.36 * 1.1 * 1.08 - 1e-6, 'control still floored by calibration');
  } finally { teardown(); }
});

test('match arm never quotes below raw fair x (1 + min edge)', async () => {
  setup();
  try {
    market(0.6, -140, -145);                       // books 0.340 / 0.350 < fair 0.36
    const m = await quote([mkLine('B1'), mkLine('B2')], pid('match', 'b'));
    assert.ok(Math.abs(m.offeredImpliedProb - 0.36 * 1.01) < 1e-4, 'floored at fair + 1%: ' + m.offeredImpliedProb);
    assert.strictEqual(m.twoLegBookMatch.floorBound, true);
  } finally { teardown(); }
});

test('scope: same-game, 3 legs, no book price, or percent 0 -> no arm', async () => {
  setup();
  try {
    market(0.6, -160, -165);
    const sg = mkLine('C1'); LINES['bm-C1b'] = { ...LINES[sg], lineId: 'bm-C1b', marketType: 'total', oddsApiMarket: 'totals', selection: 'over', oddsApiSelection: 'Over', line: 5.5, teamName: 'Over' };
    const r = await pricer.priceParlay([sg, 'bm-C1b'], { parlayId: pid('match', 'c') });
    if (r) assert.strictEqual(r.meta.twoLegBookMatchArm, null, 'same-game out of scope');
    const three = await quote([mkLine('C2'), mkLine('C3'), mkLine('C4')], pid('match', 'c3'));
    assert.strictEqual(three.twoLegBookMatchArm, null);
    market(0.6, null, null);
    const nb = await quote([mkLine('C5'), mkLine('C6')], pid('match', 'c5'));
    assert.strictEqual(nb.twoLegBookMatchArm, null, 'no book parlay -> out of scope');
    market(0.6, -160, -165);
    config.pricing.twoLegBookMatchPercent = 0;
    const off = await quote([mkLine('C7'), mkLine('C8')], pid('match', 'c7'));
    assert.strictEqual(off.twoLegBookMatchArm, null);
  } finally { teardown(); }
});

test('confirm reprice accepts a match-arm fill whose control price is past 50%', async () => {
  setup();
  try {
    market(0.68, -220, -230);                      // raw 0.4624; control floor 0.549 (> 50%); books 0.4727
    const ids = [mkLine('D1'), mkLine('D2')];
    const m = await quote(ids, pid('match', 'd'));
    assert.ok(m.offeredImpliedProb < 0.5, 'match arm quotes under 50%');
    const c = await pricer.priceParlay(ids, { parlayId: pid('control', 'd') });
    assert.strictEqual(c, null, 'control declines (negative odds)');
    const v = await pricer.validateForConfirmation(pid('match', 'd'), m);
    assert.strictEqual(v.valid, true, 'confirm accepted: ' + v.reason);
  } finally { teardown(); }
});
