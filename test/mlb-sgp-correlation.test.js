// MLB same-game side+total: measured correlation factors, gated precedence
// over the sport-agnostic SGP_CORRELATION_BY_COMBO grid.
//
// The grid applies ml_total 1.15 and spread_fav_over 1.30 to MLB, numbers
// "back-calculated from 4 FanDuel samples". Measured from historical lines +
// Retrosheet scores over the COMPLETE 2024 and 2025 seasons (4,911 games —
// services/mlb-sgp-correlation.js carries the tables and CIs):
//
//   * moneyline+total is small and DIRECTIONAL, the opposite of the grid's
//     intuition: fav+under 1.030, dog+over 1.047, and the other two directions
//     anti-correlated (clamp). The grid's flat 1.15 charged most on fav+over,
//     the one direction that is actually anti-correlated (0.968).
//   * run-line+total is conditioned on the game TOTAL — covering -1.5 in a
//     7-run game REQUIRES the over; in an 11-run game it does not.
//
// Why gated (MLB_SGP_CORRELATION_MEASURED), unlike football: MLB same-game is
// LIVE today, so precedence changes prices on $52K/wk of contested volume.
// That is the operator's switch, not a deploy side effect.
//
// Run: node --test test/mlb-sgp-correlation.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const mlb = require('../services/mlb-sgp-correlation');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const F = mlb.mlbSgpFactor;
const MLB = 'baseball_mlb';

// ---------------------------------------------------------------- the table

test('ml_total is DIRECTIONAL: fav+under and dog+over carry a small uplift, the other two clamp', () => {
  const f = (side, sel) => F({ sport: MLB, combo: 'ml_total', mlSide: side, totalSelection: sel }).factor;
  assert.strictEqual(f('fav', 'under'), 1.03, 'measured 1.030 [1.008, 1.052]');
  assert.strictEqual(f('dog', 'over'), 1.05, 'measured 1.047 [1.011, 1.083]');
  assert.strictEqual(f('fav', 'over'), 1.00, 'measured 0.968 — anti-correlated, clamps');
  assert.strictEqual(f('dog', 'under'), 1.00, 'measured 0.956 — anti-correlated, clamps');
});

test('ml_total with an unknown side or selection fails toward the TIGHTEST entry', () => {
  assert.strictEqual(F({ sport: MLB, combo: 'ml_total' }).factor, 1.05);
  assert.strictEqual(F({ sport: MLB, combo: 'ml_total', mlSide: 'fav' }).factor, 1.05);
  assert.strictEqual(F({ sport: MLB, combo: 'ml_total', totalSelection: 'under' }).factor, 1.05);
  assert.strictEqual(F({ sport: MLB, combo: 'ml_total', mlSide: 'nope', totalSelection: 'over' }).factor, 1.05);
});

test('run line fav+over is conditioned on the game total', () => {
  const at = (tot) => F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: tot, totalSelection: 'over' }).factor;
  assert.strictEqual(at(6.5), 1.13);
  assert.strictEqual(at(7.5), 1.13, 'boundary inclusive');
  assert.strictEqual(at(8), 1.07);
  assert.strictEqual(at(9), 1.07, 'boundary inclusive');
  assert.strictEqual(at(9.5), 1.00, 'measured 1.014 [0.937, 1.089] — CI contains 1, so 1.00 not the point estimate');
  assert.strictEqual(at(11), 1.00);
});

test('the other three run-line directions: dog+under small uplift, negatives clamp to 1', () => {
  const f = (sl, sel) => F({ sport: MLB, combo: 'spread_total', spreadLine: sl, totalLine: 8.5, totalSelection: sel }).factor;
  assert.strictEqual(f(1.5, 'under'), 1.05, 'measured 1.051 [1.028, 1.075]');
  assert.strictEqual(f(-1.5, 'under'), 1.00, 'measured 0.931 — clamps, never cheaper than independent');
  assert.strictEqual(f(1.5, 'over'), 1.00, 'measured 0.945 — clamps');
});

test('an unreadable total or direction on the run line fails toward the EXPENSIVE side', () => {
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: null, totalSelection: 'over' }).factor, 1.13);
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: 'x', totalSelection: 'over' }).factor, 1.13);
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: null, totalLine: 7, totalSelection: null }).factor, 1.13);
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: 0, totalLine: 8.5, totalSelection: '' }).factor, 1.07);
});

test('non-MLB sports and unknown combos return null, not 1', () => {
  assert.strictEqual(F({ sport: 'basketball_nba', combo: 'ml_total', mlSide: 'fav', totalSelection: 'under' }), null);
  assert.strictEqual(F({ sport: 'americanfootball_nfl', combo: 'spread_total', spreadLine: -7, totalLine: 45, totalSelection: 'over' }), null);
  assert.strictEqual(F({ sport: MLB, combo: 'ml_spread' }), null);
  assert.strictEqual(F({}), null);
});

test('overrides apply but are still clamped at >= 1.00; malformed JSON falls back', () => {
  const prev = process.env.MLB_SGP_CORRELATION;
  try {
    process.env.MLB_SGP_CORRELATION = JSON.stringify({ ml: { dog_over: { factor: 0.9 } }, spread: { dog_under: { factor: 1.2 } } });
    mlb._resetForTest();
    assert.strictEqual(F({ sport: MLB, combo: 'ml_total', mlSide: 'dog', totalSelection: 'over' }).factor, 1, 'below-1 override clamps');
    assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: 1.5, totalLine: 8.5, totalSelection: 'under' }).factor, 1.2);
    process.env.MLB_SGP_CORRELATION = '{nope';
    mlb._resetForTest();
    assert.strictEqual(F({ sport: MLB, combo: 'ml_total', mlSide: 'dog', totalSelection: 'over' }).factor, 1.05);
    assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: 7, totalSelection: 'over' }).factor, 1.13);
  } finally {
    if (prev === undefined) delete process.env.MLB_SGP_CORRELATION; else process.env.MLB_SGP_CORRELATION = prev;
    mlb._resetForTest();
  }
});

// ------------------------------------------- precedence, end to end

const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const base = (id, ev, extra) => Object.assign({
  lineId: id, sport: MLB, oddsApiSport: MLB, pxEventId: ev,
  homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, teamName: 'Home ' + ev,
  startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
}, extra);
const LINES = {
  'rl-fav': base('rl-fav', 'G1', { marketType: 'spread', line: -1.5, selection: 'home', oddsApiSelection: 'home', oddsApiMarket: 'spreads' }),
  'tot-o7': base('tot-o7', 'G1', { marketType: 'total', line: 7, selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'totals' }),
  'ml-h': base('ml-h', 'G2', { marketType: 'moneyline', selection: 'home', oddsApiSelection: 'home', oddsApiMarket: 'h2h' }),   // stubbed fair 0.60 -> fav
  'tot-o8': base('tot-o8', 'G2', { marketType: 'total', line: 8.5, selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'totals' }),
  'ml-a': base('ml-a', 'G3', { marketType: 'moneyline', selection: 'away', oddsApiSelection: 'away', oddsApiMarket: 'h2h', teamName: 'Away G3' }), // stubbed fair 0.40 -> dog
  'tot-o9': base('tot-o9', 'G3', { marketType: 'total', line: 9, selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'totals' }),
};
const saved = {};
function stub() {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent; saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.combos = config.pricing.sgpAllowedCombos; saved.grid = config.pricing.sgpCorrelationByCombo;
  saved.flag = config.pricing.mlbSgpCorrelationMeasured; saved.cap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds;
  lineManager.lookupLine = (id) => LINES[id] || null;
  // moneyline legs get a side: home 0.60 (favourite), away 0.40 (dog); totals 0.50
  oddsFeed.getFairProb = (sport, home, away, market, sel) => (market === 'h2h' ? (sel === 'home' ? 0.60 : 0.40) : 0.50);
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  // the production grid values, so the test proves precedence over them
  config.pricing.sgpCorrelationByCombo = { spread_total: 1.15, ml_total: 1.15, spread_fav_over: 1.30, spread_dog_under: 1.08, spread_fav_under: 1.08, spread_dog_over: 1.08 };
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000;
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale; if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.sgpAllowedCombos = saved.combos; config.pricing.sgpCorrelationByCombo = saved.grid;
  config.pricing.mlbSgpCorrelationMeasured = saved.flag; config.pricing.maxRiskPerParlay = saved.cap;
  config.pricing.maxOdds = saved.maxOdds;
}
async function price(ids, pid) {
  const res = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta;
}

test('flag OFF: the grid still applies to MLB (1.30 on fav+over, 1.15 on ml_total)', async () => {
  stub();
  try {
    config.pricing.mlbSgpCorrelationMeasured = false;
    const a = await price(['rl-fav', 'tot-o7'], 'mlb-off-1');
    assert.ok(Math.abs(a.sgpCorrelationFactor - 1.30) < 1e-9, `grid fav_over 1.30 expected, got ${a.sgpCorrelationFactor}`);
    const b = await price(['ml-h', 'tot-o8'], 'mlb-off-2');
    assert.ok(Math.abs(b.sgpCorrelationFactor - 1.15) < 1e-9, `grid ml_total 1.15 expected, got ${b.sgpCorrelationFactor}`);
  } finally { restore(); }
});

test('flag ON: the measured table takes precedence — 1.13 at a 7 total; ml_total by the ML leg\'s SIDE', async () => {
  stub();
  try {
    config.pricing.mlbSgpCorrelationMeasured = true;
    const a = await price(['rl-fav', 'tot-o7'], 'mlb-on-1');
    assert.ok(Math.abs(a.sgpCorrelationFactor - 1.13) < 1e-9, `measured low-total fav_over 1.13 expected, got ${a.sgpCorrelationFactor}`);
    // favourite ML (fair 0.60) + over: anti-correlated -> clamps to 1.00
    const b = await price(['ml-h', 'tot-o8'], 'mlb-on-2');
    assert.strictEqual(b.sgpCorrelationFactor, 1, `fav+over is anti-correlated (0.968) and must clamp to 1, got ${b.sgpCorrelationFactor}`);
    // dog ML (fair 0.40) + over: the measured 1.047 -> 1.05
    const c = await price(['ml-a', 'tot-o9'], 'mlb-on-3');
    assert.ok(Math.abs(c.sgpCorrelationFactor - 1.05) < 1e-9, `dog+over 1.05 expected, got ${c.sgpCorrelationFactor}`);
  } finally { restore(); }
});

test('flag ON never touches the doubled SGP vig — only the correlation factor moves', async () => {
  stub();
  try {
    config.pricing.mlbSgpCorrelationMeasured = false;
    const off = await price(['ml-h', 'tot-o8'], 'mlb-vig-off');
    config.pricing.mlbSgpCorrelationMeasured = true;
    const on = await price(['ml-h', 'tot-o8'], 'mlb-vig-on');
    assert.strictEqual(on.sgpVigMultiplier, off.sgpVigMultiplier, 'the 2x SGP vig multiplier is untouched');
    assert.ok(on.offeredImpliedProb < off.offeredImpliedProb, 'removing a phantom 1.15 makes the quote cheaper for the bettor');
    assert.ok(on.offeredImpliedProb > on.fairParlayProb, '...but the ticket still carries margin');
  } finally { restore(); }
});

test('config: ships with the switch OFF', () => {
  assert.strictEqual(config.pricing.mlbSgpCorrelationMeasured, false);
});
