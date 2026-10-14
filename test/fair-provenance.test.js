// Per-leg fair provenance (2026-10-14 EV audit): meta.legs[].provenance records
// how each fair was built, so calibration can be split by method.
// Run: node --test test/fair-provenance.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUT = new Date(Date.now() + 5 * 3600e3).toISOString();
const L = {
  p1: { lineId: 'p1', sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits',
    propType: 'hitter_hits', playerName: 'A', teamName: 'A', selection: 'over', oddsApiSelection: 'over', line: 1.5, homeTeam: 'H1', awayTeam: 'A1',
    pxEventId: 'PV1', startTime: FUT, startTimeMs: Date.parse(FUT), propFetchedAt: Date.now(), fairProb: 0.40,
    propMethod: 'count_dist', propBooks: ['draftkings', 'fanduel', 'pinnacle'], booksWithBothSides: 3, propSource: 'theoddsapi',
    propExactLineFair: 0.42, propImpliedMean: 1.21 },
  p2: { lineId: 'p2', sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'player_hitter_hr', oddsApiMarket: 'batter_home_runs',
    propType: 'hitter_hr', playerName: 'B', teamName: 'B', selection: 'over', oddsApiSelection: 'over', line: 0.5, homeTeam: 'H2', awayTeam: 'A2',
    pxEventId: 'PV2', startTime: FUT, startTimeMs: Date.parse(FUT), propFetchedAt: Date.now(), fairProb: 0.20, propSource: 'theoddsapi' },
};
test('prop legs carry method / books / exact-line fair / calibration multiplier', async () => {
  const saved = { lookup: lineManager.lookupLine, stale: oddsFeed.isStaleForEvent, pre: oddsFeed.isEventStalePreGame, cfg: { ...config.pricing } };
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 6000, maxRiskPerParlayWithProp: 6000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    propFairCalibration: { 'player_hitter_hr.over': 0.93 } });
  try {
    const r = await pricer.priceParlay(['p1', 'p2'], { parlayId: 'pv-1' });
    try { orderTracker.releasePending('pv-1'); } catch (_) {}
    assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
    const [a, b] = r.meta.legs;
    assert.deepStrictEqual({ m: a.provenance.method, n: a.provenance.books, two: a.provenance.twoSided, ex: a.provenance.exactLineFair, mu: a.provenance.mean },
      { m: 'count_dist', n: 3, two: 3, ex: 0.42, mu: 1.21 });
    assert.deepStrictEqual(b.provenance.calib, { mult: 0.93, preFair: 0.2 });
    assert.ok(Math.abs(b.fairProb - 0.186) < 1e-4, 'calibrated fair is what priced');
  } finally {
    lineManager.lookupLine = saved.lookup; oddsFeed.isStaleForEvent = saved.stale; if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
    for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
    Object.assign(config.pricing, saved.cfg);
  }
});
