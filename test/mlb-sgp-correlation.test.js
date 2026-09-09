// MLB same-game side+total: measured correlation factors, gated precedence
// over the sport-agnostic SGP_CORRELATION_BY_COMBO grid.
//
// The grid applies ml_total 1.15 and spread_fav_over 1.30 to MLB, numbers
// "back-calculated from 4 FanDuel samples". Measured from historical lines +
// Retrosheet scores (services/mlb-sgp-correlation.js carries the tables and
// CIs): ml_total is INDEPENDENT (every CI contains 1.000), and run-line+total
// runs 1.00-1.15 depending on the game total — covering -1.5 in a 7-run game
// REQUIRES the over; in an 11-run game it does not.
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

test('ml_total is measured INDEPENDENT', () => {
  assert.strictEqual(F({ sport: MLB, combo: 'ml_total' }).factor, 1);
});

test('run line fav+over is conditioned on the game total', () => {
  const at = (tot) => F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: tot, totalSelection: 'over' }).factor;
  assert.strictEqual(at(6.5), 1.14);
  assert.strictEqual(at(7.5), 1.14, 'boundary inclusive');
  assert.strictEqual(at(8), 1.06);
  assert.strictEqual(at(9), 1.06, 'boundary inclusive');
  assert.strictEqual(at(9.5), 1.00);
  assert.strictEqual(at(11), 1.00);
});

test('the other three run-line directions: dog+under small uplift, negatives clamp to 1', () => {
  const f = (sl, sel) => F({ sport: MLB, combo: 'spread_total', spreadLine: sl, totalLine: 8.5, totalSelection: sel }).factor;
  assert.strictEqual(f(1.5, 'under'), 1.05);
  assert.strictEqual(f(-1.5, 'under'), 1.00, 'measured 0.940 — clamps, never cheaper than independent');
  assert.strictEqual(f(1.5, 'over'), 1.00, 'measured 0.949 — clamps');
});

test('an unreadable total or direction fails toward the EXPENSIVE side', () => {
  // unknown total -> tightest bucket (1.15), not the loosest
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: null, totalSelection: 'over' }).factor, 1.14);
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: 'x', totalSelection: 'over' }).factor, 1.14);
  // unknown side/selection -> the fav_over table (the most expensive direction)
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: null, totalLine: 7, totalSelection: null }).factor, 1.14);
  assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: 0, totalLine: 8.5, totalSelection: '' }).factor, 1.06);
});

test('non-MLB sports and unknown combos return null, not 1', () => {
  assert.strictEqual(F({ sport: 'basketball_nba', combo: 'ml_total' }), null);
  assert.strictEqual(F({ sport: 'americanfootball_nfl', combo: 'spread_total', spreadLine: -7, totalLine: 45, totalSelection: 'over' }), null);
  assert.strictEqual(F({ sport: MLB, combo: 'ml_spread' }), null);
  assert.strictEqual(F({}), null);
});

test('overrides apply but are still clamped at >= 1.00; malformed JSON falls back', () => {
  const prev = process.env.MLB_SGP_CORRELATION;
  try {
    process.env.MLB_SGP_CORRELATION = JSON.stringify({ ml_total: 0.9, spread: { dog_under: { factor: 1.2 } } });
    mlb._resetForTest();
    assert.strictEqual(F({ sport: MLB, combo: 'ml_total' }).factor, 1, 'below-1 override clamps');
    assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: 1.5, totalLine: 8.5, totalSelection: 'under' }).factor, 1.2);
    process.env.MLB_SGP_CORRELATION = '{nope';
    mlb._resetForTest();
    assert.strictEqual(F({ sport: MLB, combo: 'ml_total' }).factor, 1);
    assert.strictEqual(F({ sport: MLB, combo: 'spread_total', spreadLine: -1.5, totalLine: 7, totalSelection: 'over' }).factor, 1.14);
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
  'ml-h': base('ml-h', 'G2', { marketType: 'moneyline', selection: 'home', oddsApiSelection: 'home', oddsApiMarket: 'h2h' }),
  'tot-o8': base('tot-o8', 'G2', { marketType: 'total', line: 8.5, selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'totals' }),
};
const saved = {};
function stub() {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent; saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.combos = config.pricing.sgpAllowedCombos; saved.grid = config.pricing.sgpCorrelationByCombo;
  saved.flag = config.pricing.mlbSgpCorrelationMeasured; saved.cap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.50;
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

test('flag ON: the measured table takes precedence — 1.14 at a 7 total, 1.00 on ml_total', async () => {
  stub();
  try {
    config.pricing.mlbSgpCorrelationMeasured = true;
    const a = await price(['rl-fav', 'tot-o7'], 'mlb-on-1');
    assert.ok(Math.abs(a.sgpCorrelationFactor - 1.14) < 1e-9, `measured low-total fav_over 1.14 expected, got ${a.sgpCorrelationFactor}`);
    const b = await price(['ml-h', 'tot-o8'], 'mlb-on-2');
    assert.strictEqual(b.sgpCorrelationFactor, 1, `measured ml_total is independent, got ${b.sgpCorrelationFactor}`);
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
