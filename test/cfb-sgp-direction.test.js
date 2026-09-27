// CFB same-game spread+total correlation is DIRECTIONAL (2026-09-27).
//
// The measured buckets (1.05 at 7.5+ climbing to 1.25 at 35+) are the
// fav-covers + over / dog-covers + under cell. The OPPOSITE pair — fav covers
// + under, dog covers + over — measures 0.66-0.96 at 7.5+ on the same 9,465
// games (clamps to 1.00) and 1.054-1.057 at 0-3.5 (where the same direction is
// 0.942 and clamps). Until this fix pricer.js passed only the spread SIZE to
// footballSgpFactor, so every fav+under / dog+over paid the full same-direction
// bucket and every 0-3.5 opposite pair got 1.00.
//
// These run through the REAL pricing path (priceParlay -> meta
// .sgpCorrelationFactor) and the REAL decline path (shouldDecline), because
// the defect lived in the caller: the module could have been direction-aware
// and the pricer would still have thrown the direction away.
//
// Run: node --test test/cfb-sgp-direction.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const CFB = 'americanfootball_ncaaf';
const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const base = (id, ev, extra) => Object.assign({
  lineId: id, sport: CFB, oddsApiSport: CFB, pxEventId: ev,
  homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
  startTime: FUTURE, startTimeMs: Date.parse(FUTURE), marketName: 'Spread',
}, extra);
const spread = (id, ev, line, side) => base(id, ev, {
  marketType: 'spread', line, selection: side, oddsApiSelection: side, oddsApiMarket: 'spreads',
  teamName: (side === 'home' ? 'Home ' : 'Away ') + ev,
});
const total = (id, ev, line, sel) => base(id, ev, {
  marketType: 'total', line, selection: sel, oddsApiSelection: sel, oddsApiMarket: 'totals', marketName: 'Total Points',
});

const LINES = {
  // 7.5+ : fav -21 with each side of the total, and the dog +21 with each
  'fav21-s': spread('fav21-s', 'G1', -21, 'home'), 'fav21-o': total('fav21-o', 'G1', 58.5, 'over'),
  'fav21u-s': spread('fav21u-s', 'G2', -21, 'home'), 'fav21u-u': total('fav21u-u', 'G2', 58.5, 'under'),
  'dog21-s': spread('dog21-s', 'G3', 21, 'away'), 'dog21-u': total('dog21-u', 'G3', 58.5, 'under'),
  'dog21o-s': spread('dog21o-s', 'G4', 21, 'away'), 'dog21o-o': total('dog21o-o', 'G4', 58.5, 'over'),
  // 7.5-14.5 : the audit's "nearly inert" bucket still moves 1.05 -> 1.00
  'fav10u-s': spread('fav10u-s', 'G5', -10, 'home'), 'fav10u-u': total('fav10u-u', 'G5', 49.5, 'under'),
  // 0-3.5 : opposite is the POSITIVE direction here
  'dog2o-s': spread('dog2o-s', 'G6', 2.5, 'away'), 'dog2o-o': total('dog2o-o', 'G6', 52.5, 'over'),
  'fav2o-s': spread('fav2o-s', 'G7', -2.5, 'home'), 'fav2o-o': total('fav2o-o', 'G7', 52.5, 'over'),
  // unreadable total side -> the dearer direction (same as before the fix)
  'favq-s': spread('favq-s', 'G8', -21, 'home'), 'favq-t': total('favq-t', 'G8', 58.5, undefined),
  // cap: -42.5 in the (now 1.00) opposite direction must STILL decline
  'cap-s': spread('cap-s', 'G9', -42.5, 'home'), 'cap-u': total('cap-u', 'G9', 56.5, 'under'),
};

const saved = {};
function stub() {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent; saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.combos = config.pricing.sgpAllowedCombos; saved.grid = config.pricing.sgpCorrelationByCombo;
  saved.cap = config.pricing.maxRiskPerParlay; saved.maxOdds = config.pricing.maxOdds;
  saved.fbEnabled = config.pricing.footballSgpEnabled;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.50;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  // Production-shaped grid: football must take precedence over it in BOTH
  // directions (the grid's spread_fav_under would otherwise hand fav+under an
  // MLB-derived number).
  config.pricing.sgpCorrelationByCombo = { spread_total: 1.15, ml_total: 1.15, spread_fav_over: 1.30, spread_dog_under: 1.08, spread_fav_under: 1.08, spread_dog_over: 1.08 };
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000;
  config.pricing.footballSgpEnabled = true;
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale; if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.sgpAllowedCombos = saved.combos; config.pricing.sgpCorrelationByCombo = saved.grid;
  config.pricing.maxRiskPerParlay = saved.cap; config.pricing.maxOdds = saved.maxOdds;
  config.pricing.footballSgpEnabled = saved.fbEnabled;
}
async function factorOf(ids, pid) {
  const res = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta.sgpCorrelationFactor;
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: expected ${b}, got ${a}`);

test('priceParlay: fav -21 + OVER keeps the 21-28 bucket (1.17)', async () => {
  stub();
  try { close(await factorOf(['fav21-s', 'fav21-o'], 'cfbdir-1'), 1.17, 'fav+over'); } finally { restore(); }
});

test('priceParlay: fav -21 + UNDER is the opposite direction -> 1.00, not 1.17', async () => {
  // measured 0.831 [0.766, 0.894] at 21-28 -> clamp
  stub();
  try { close(await factorOf(['fav21u-s', 'fav21u-u'], 'cfbdir-2'), 1, 'fav+under'); } finally { restore(); }
});

test('priceParlay: dog +21 + UNDER is same-direction (1.17); dog +21 + OVER is opposite (1.00)', async () => {
  stub();
  try {
    close(await factorOf(['dog21-s', 'dog21-u'], 'cfbdir-3'), 1.17, 'dog+under');
    close(await factorOf(['dog21o-s', 'dog21o-o'], 'cfbdir-4'), 1, 'dog+over');
  } finally { restore(); }
});

test('priceParlay: fav -10 + under drops from 1.05 to 1.00', async () => {
  // measured 0.956 [0.919, 0.993] at 7.5-14.5
  stub();
  try { close(await factorOf(['fav10u-s', 'fav10u-u'], 'cfbdir-5'), 1, 'fav -10 + under'); } finally { restore(); }
});

test('priceParlay: at 0-3.5 the OPPOSITE pair is charged 1.06 and the same direction stays 1.00', async () => {
  // dog+over 1.054 [1.004, 1.100]; fav+over 0.942 [0.892, 0.996] -> clamp
  stub();
  try {
    close(await factorOf(['dog2o-s', 'dog2o-o'], 'cfbdir-6'), 1.06, 'dog +2.5 + over');
    close(await factorOf(['fav2o-s', 'fav2o-o'], 'cfbdir-7'), 1, 'fav -2.5 + over');
  } finally { restore(); }
});

test('priceParlay: an unreadable total side falls back to the dearer direction (the old 1.17)', async () => {
  stub();
  try { close(await factorOf(['favq-s', 'favq-t'], 'cfbdir-8'), 1.17, 'fav -21 + unknown side'); } finally { restore(); }
});

test('the decline path computes the same direction-aware factor', () => {
  const P = pricer.__footballSideTotalPair;
  assert.strictEqual(P([LINES['fav21-s'], LINES['fav21-o']]).factor, 1.17);
  assert.strictEqual(P([LINES['fav21u-u'], LINES['fav21u-s']]).factor, 1);
  assert.strictEqual(P([LINES['dog2o-s'], LINES['dog2o-o']]).factor, 1.06);
  assert.strictEqual(P([LINES['favq-s'], LINES['favq-t']]).factor, 1.17);
  // basis still names the league — the 28+ cap keys on it
  assert.match(P([LINES['fav21u-s'], LINES['fav21u-u']]).basis, /^ncaaf\.spread_total .*fav_under opposite-direction/);
});

test('the 28+ cap is untouched: an opposite-direction -42.5 pair still declines', () => {
  stub();
  try {
    const d = pricer.shouldDecline([{ line_id: 'cap-s' }, { line_id: 'cap-u' }], null);
    assert.ok(d && d.declined, JSON.stringify(d));
    assert.strictEqual(d.reason, 'football_sgp_spread_too_large');
  } finally { restore(); }
});
