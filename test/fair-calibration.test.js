// Measured fair calibration (2026-11-08). Run: node --test test/fair-calibration.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');
const calib = require('../services/fair-calibration');

const KEYS = ['calibFloorMult', 'calibEnabled', 'calibMinMarginPct', 'calibPriorHits', 'calibMinMult', 'calibMaxMult'];
const saved = {};
function setCfg(o = {}) {
  for (const k of KEYS) saved[k] = config.pricing[k];
  Object.assign(config.pricing, { calibFloorMult: 0.5, calibEnabled: true, calibMinMarginPct: 8, calibPriorHits: 40, calibMinMult: 0.8, calibMaxMult: 1.5 }, o);
}
function restore() { for (const k of KEYS) config.pricing[k] = saved[k]; }

const leg = (sport, ev, extra = {}) => ({ sport, marketType: 'moneyline', pxEventId: ev, ...extra });
// n tickets at fair f, `hits` bettor wins, legs + our risk stake
function tickets(n, hits, f, legs, stake = 100) {
  return Array.from({ length: n }, (_, i) => ({ status: i < hits ? 'settled_lost' : 'settled_won', fairParlayProb: f,
    confirmedStake: stake, legs, meta: {} }));
}

test('segmentPath: kind, legs, sport, size', () => {
  const p = calib.segmentPath([leg('americanfootball_nfl', 'a'), leg('americanfootball_nfl', 'b')], 750);
  assert.deepStrictEqual(p, ['all', 'game-xg', 'game-xg|2', 'game-xg|2|nfl', 'game-xg|2|nfl|500-1000']);
  const q = calib.segmentPath([leg('basketball_nba', 'a', { playerName: 'X' }), leg('icehockey_nhl', 'a'), leg('tennis', 'c'), leg('tennis', 'd')]);
  assert.deepStrictEqual(q, ['all', 'prop-sgp', 'prop-sgp|4+', 'prop-sgp|4+|multi']);
});

test('buildCells: raw pre-factor fair, voided tickets out, settled_lost = bettor hit', () => {
  const L = [leg('tennis', 'a'), leg('tennis', 'b')];
  const { cells, n } = calib.buildCells([
    ...tickets(4, 1, 0.25, L),
    { status: 'settled_won', fairParlayProb: 0.33, confirmedStake: 100, legs: L, meta: { xgFactorApplied: true, xgFactorPreFair: 0.3 } },
    { status: 'settled_lost', fairParlayProb: 0.3, confirmedStake: 100, legs: [{ ...L[0], settlementStatus: 'void' }, L[1]], meta: {} },
    { status: 'confirmed', fairParlayProb: 0.3, confirmedStake: 100, legs: L, meta: {} },
  ]);
  assert.strictEqual(n, 5);
  const c = cells.get('all');
  assert.strictEqual(c.h, 1);
  assert.ok(Math.abs(c.e - 1.3) < 1e-9, 'raw fair used: ' + c.e);
});

test('multiplierFor: shrinks to parent; big beaten segment > 1, thin segment stays near parent', () => {
  setCfg();
  try {
    const NFL = [leg('americanfootball_nfl', 'a'), leg('americanfootball_nfl', 'b')];
    const TEN = [leg('tennis', 'c'), leg('tennis', 'd')];
    const GOLF = [leg('golf_matchups', 'g'), leg('golf_matchups', 'h')];
    const { cells } = calib.buildCells([...tickets(1000, 300, 0.25, NFL), ...tickets(1000, 250, 0.25, TEN), ...tickets(4, 4, 0.25, GOLF)]);
    const nfl = calib.multiplierFor(calib.segmentPath(NFL), cells);
    assert.ok(nfl.mult > 1.15 && nfl.mult < 1.2, 'NFL 1.2 measured, shrunk a bit: ' + nfl.mult);
    const ten = calib.multiplierFor(calib.segmentPath(TEN), cells);
    assert.ok(ten.mult > 0.99 && ten.mult < 1.05, 'tennis calibrated: ' + ten.mult);
    const golf = calib.multiplierFor(calib.segmentPath(GOLF), cells);
    assert.ok(golf.mult < 1.2, 'n=4 cannot move far from its parent: ' + golf.mult);
  } finally { restore(); }
});

test('forQuote: never below 1, floor = calFair x (1 + margin); forEv clamps both ways and uses size', () => {
  setCfg();
  try {
    const NFL = [leg('americanfootball_nfl', 'a'), leg('americanfootball_nfl', 'b')];
    const TEN = [leg('tennis', 'c'), leg('tennis', 'd')];
    calib.__setCellsForTest(calib.buildCells([
      ...tickets(800, 220, 0.25, NFL, 100), ...tickets(400, 160, 0.25, NFL, 1500),   // big tickets beaten harder
      ...tickets(2000, 400, 0.25, TEN),                                              // in our favour (0.8)
    ]).cells);
    const qn = calib.forQuote(NFL, 0.25);
    assert.ok(qn.mult > 1, 'NFL beaten -> mult > 1: ' + qn.mult);
    assert.ok(Math.abs(qn.floorProb - qn.calFair * 1.08) < 1e-12);
    const qt = calib.forQuote(TEN, 0.25);
    assert.strictEqual(qt.mult, 1, 'pricing never makes the fair more generous');
    assert.ok(Math.abs(qt.floorProb - 0.25 * 1.08) < 1e-12);
    const et = calib.forEv(TEN, 0.25, 100);
    assert.ok(et.mult < 1 && et.mult >= 0.8, 'EV reads the favourable segment honestly: ' + et.mult);
    const small = calib.forEv(NFL, 0.25, 100), big = calib.forEv(NFL, 0.25, 1500);
    assert.ok(big.mult > small.mult, `size is a selection signal at confirm: ${big.mult} vs ${small.mult}`);
    config.pricing.calibEnabled = false;
    assert.strictEqual(calib.forQuote(NFL, 0.25), null);
    assert.strictEqual(calib.forEv(NFL, 0.25, 100), null);
  } finally { restore(); }
});

test('priceParlay: offer floored at calibrated fair + margin; fairParlayProb untouched', async () => {
  setCfg({ calibMinMarginPct: 15 });
  const lineManager = require('../services/line-manager');
  const oddsFeed = require('../services/odds-feed');
  const pricer = require('../services/pricer');
  const START = new Date(Date.now() + 6 * 3600e3).toISOString();
  const LINES = {};
  for (const ev of ['FC1', 'FC2']) LINES['fc-' + ev] = { lineId: 'fc-' + ev, sport: 'baseball_mlb', marketType: 'moneyline', teamName: 'Home ' + ev, selection: 'home',
    oddsApiSelection: 'home', oddsApiMarket: 'h2h', oddsApiSport: 'baseball_mlb', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev, startTime: START, startTimeMs: Date.parse(START) };
  const s = { lookup: lineManager.lookupLine, fair: oddsFeed.getFairProb, stale: oddsFeed.isStaleForEvent, pre: oddsFeed.isEventStalePreGame };
  const pc = { maxRiskPerParlay: config.pricing.maxRiskPerParlay, maxOdds: config.pricing.maxOdds, maxExposurePerTeam: config.pricing.maxExposurePerTeam,
    maxExposurePerGame: config.pricing.maxExposurePerGame, maxRawExposurePerTeam: config.pricing.maxRawExposurePerTeam };
  Object.assign(config.pricing, { maxRiskPerParlay: 3000, maxOdds: 50000, maxExposurePerTeam: 1e9, maxExposurePerGame: 1e9, maxRawExposurePerTeam: 1e9 });
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.4;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  const MLB = [leg('baseball_mlb', 'x'), leg('baseball_mlb', 'y')];
  calib.__setCellsForTest(calib.buildCells(tickets(3000, 900, 0.25, MLB)).cells);   // 1.2x
  try {
    const r = await pricer.priceParlay(Object.keys(LINES), { parlayId: 'fc-1' });
    assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
    const m = r.meta;
    assert.ok(m.calib && m.calib.mult > 1.15, 'calibration recorded: ' + JSON.stringify(m.calib));
    assert.ok(m.offeredImpliedProb >= m.calib.calFair * 1.15 - 1e-4, `offer ${m.offeredImpliedProb} >= calFair ${m.calib.calFair} x 1.15`);
    assert.ok(Math.abs(m.fairParlayProb - m.calib.rawFair) < 1e-4 || m.fairParlayProb < m.calib.calFair, 'fairParlayProb not inflated: ' + m.fairParlayProb);
    config.pricing.calibEnabled = false;
    const off = await pricer.priceParlay(Object.keys(LINES), { parlayId: 'fc-2' });
    assert.ok(off && off.meta.offeredImpliedProb < m.offeredImpliedProb, 'switch off restores the old price');
  } finally {
    lineManager.lookupLine = s.lookup; oddsFeed.getFairProb = s.fair; oddsFeed.isStaleForEvent = s.stale;
    if (s.pre) oddsFeed.isEventStalePreGame = s.pre;
    Object.assign(config.pricing, pc);
    for (const id of Object.keys(LINES)) { try { require('../services/order-tracker').releaseQuoteReservations(id); } catch (_) {} }
    restore();
  }
});

test('applyEvCalibration: EV fill off evFair, model EV kept, EV live / game time rebased once', () => {
  setCfg();
  const ot = require('../services/order-tracker');
  const MLB = [leg('baseball_mlb', 'x'), leg('baseball_mlb', 'y')];
  calib.__setCellsForTest(calib.buildCells(tickets(3000, 900, 0.25, MLB)).cells);   // ~1.2x
  try {
    const o = { confirmedStake: 300, confirmedOdds: -300, fairParlayProb: 0.2, legs: MLB,
      meta: { offeredImpliedProb: 0.25, expectedValue: 20, evLive: { fairProb: 0.22, ev: 1 }, gameTime: { fairProb: 0.18, ev: 2, finalizedAt: 'x' } } };
    assert.ok(ot.applyEvCalibration(o));
    const p = o.meta.evFair;
    assert.ok(p > 0.235 && p < 0.245, 'evFair ~ 0.2 x 1.2: ' + p);
    assert.strictEqual(o.meta.expectedValueModel, 20);
    // PX confirmed odds are OUR side (-300): bettor stake $100 on our $300 risk
    assert.ok(Math.abs(o.expectedValue - ((1 - p) * 100 - p * 300)) < 0.01, "EV " + o.expectedValue);
    assert.ok(Math.abs(o.meta.evLive.fairProb - 0.22 * p / 0.2) < 1e-5, 'EV live scaled by new/old fill');
    assert.ok(Math.abs(o.meta.gameTime.fairProb - 0.18 * p / 0.2) < 1e-5);
    const live1 = o.meta.evLive.fairProb;
    ot.applyEvCalibration(o);
    assert.ok(Math.abs(o.meta.evLive.fairProb - live1) < 1e-6, 'no compounding on re-apply');
    assert.strictEqual(o.meta.expectedValueModel, 20, 'model EV not overwritten on re-apply');
  } finally { restore(); }
});

test('calibFloorMult: book-wide floor lifts every segment, EV and pricing alike', () => {
  setCfg({ calibFloorMult: 1.1 });
  try {
    const TEN = [leg('tennis', 'c'), leg('tennis', 'd')];
    calib.__setCellsForTest(calib.buildCells(tickets(2000, 400, 0.25, TEN)).cells);   // 0.8 measured
    assert.ok(Math.abs(calib.forEv(TEN, 0.2, 100).evFair - 0.22) < 1e-12, 'EV never below raw x 1.10');
    const q = calib.forQuote(TEN, 0.2);
    assert.ok(Math.abs(q.calFair - 0.22) < 1e-12 && Math.abs(q.floorProb - 0.22 * 1.08) < 1e-12);
  } finally { restore(); }
});
