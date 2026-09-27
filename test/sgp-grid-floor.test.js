// The sport-agnostic SGP correlation GRID never prices below independent.
//
// config.pricing.sgpCorrelationByCombo is merged env-onto-defaults, and the
// defaults carried spread_fav_under 0.95 / spread_dog_over 0.95 — a same-game
// parlay priced CHEAPER than the independent product. Prod env sets both to
// 1.08, so they were dormant, but any partial replacement of the env JSON (or
// a runtime edit — the numMap validator accepts down to 0.1) reverted them to
// 0.95 on live quotes. The measured football and MLB tables already clamp at
// >= 1.00; the grid did not.
//
// Fix (2026-09-27 audit): the two defaults are 1.00, and pricer.js floors
// EVERY grid-sourced factor (directional, un-directed, legacy
// sgpCorrelationPositive, 3+ leg) at 1.00 at the point of use. Factors above 1
// are untouched, and which combos may quote is untouched.
//
// Run: node --test test/sgp-grid-floor.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

// ------------------------------------------------------------ config defaults

// Load a FRESH copy of config.js under a given env value, without disturbing
// the instance every service already holds (config.js is side-effect free).
function freshConfig(envVal) {
  const key = require.resolve('../config');
  const cached = require.cache[key];
  const prev = process.env.SGP_CORRELATION_BY_COMBO;
  try {
    if (envVal === undefined) delete process.env.SGP_CORRELATION_BY_COMBO;
    else process.env.SGP_CORRELATION_BY_COMBO = envVal;
    delete require.cache[key];
    return require('../config').config;
  } finally {
    require.cache[key] = cached;
    if (prev === undefined) delete process.env.SGP_CORRELATION_BY_COMBO;
    else process.env.SGP_CORRELATION_BY_COMBO = prev;
  }
}

test('config: the two negative-direction defaults are 1.00, not 0.95', () => {
  const g = freshConfig(undefined).pricing.sgpCorrelationByCombo;
  assert.strictEqual(g.spread_fav_under, 1, 'spread_fav_under default');
  assert.strictEqual(g.spread_dog_over, 1, 'spread_dog_over default');
  // the positive defaults are untouched
  assert.strictEqual(g.spread_fav_over, 1.30);
  assert.strictEqual(g.spread_dog_under, 1.02);
  assert.strictEqual(g.spread_total, 1.15);
  assert.strictEqual(g.ml_total, 1.15);
});

test('config: a PARTIAL env JSON that omits the two keys no longer reverts them below 1', () => {
  // The exact failure mode: an operator re-sets SGP_CORRELATION_BY_COMBO with
  // only the keys they meant to change, and the merge silently restores the
  // omitted defaults.
  const g = freshConfig(JSON.stringify({ spread_total: 1.10, ml_total: 1.10 })).pricing.sgpCorrelationByCombo;
  assert.strictEqual(g.spread_total, 1.10, 'the override applies');
  assert.ok(g.spread_fav_under >= 1, `spread_fav_under reverted to ${g.spread_fav_under}`);
  assert.ok(g.spread_dog_over >= 1, `spread_dog_over reverted to ${g.spread_dog_over}`);
});

// ------------------------------------------------------ pricing, end to end

const MLB = 'baseball_mlb';
const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const base = (id, ev, extra) => Object.assign({
  lineId: id, sport: MLB, oddsApiSport: MLB, pxEventId: ev,
  homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, teamName: 'Home ' + ev,
  startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
}, extra);
const spread = (id, ev, line, sel) => base(id, ev, {
  marketType: 'spread', line, selection: sel, oddsApiSelection: sel, oddsApiMarket: 'spreads',
  teamName: (sel === 'home' ? 'Home ' : 'Away ') + ev,
});
const total = (id, ev, sel) => base(id, ev, {
  marketType: 'total', line: 8.5, selection: sel, oddsApiSelection: sel, oddsApiMarket: 'totals',
});
const ml = (id, ev) => base(id, ev, {
  marketType: 'moneyline', selection: 'home', oddsApiSelection: 'home', oddsApiMarket: 'h2h',
});
const LINES = {
  'fu-s': spread('fu-s', 'G1', -1.5, 'home'), 'fu-t': total('fu-t', 'G1', 'under'),   // fav + under
  'do-s': spread('do-s', 'G2', 1.5, 'away'),  'do-t': total('do-t', 'G2', 'over'),    // dog + over
  'fo-s': spread('fo-s', 'G3', -1.5, 'home'), 'fo-t': total('fo-t', 'G3', 'over'),    // fav + over
  'mt-m': ml('mt-m', 'G4'),                   'mt-t': total('mt-t', 'G4', 'over'),    // ml + total
  'x3-m': ml('x3-m', 'G5'), 'x3-s': spread('x3-s', 'G5', -1.5, 'home'), 'x3-t': total('x3-t', 'G5', 'over'),
};
// Stubbed fairs: every spread/total leg 0.50, every moneyline 0.60. So the
// independent product is 0.25 for spread+total and 0.30 for ml+total.
const IND_ST = 0.25;
const IND_MT = 0.30;

const saved = {};
function stub(grid, extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent; saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.combos = config.pricing.sgpAllowedCombos; saved.grid = config.pricing.sgpCorrelationByCombo;
  saved.grid3 = config.pricing.sgpCorrelation3PlusByCombo; saved.pos = config.pricing.sgpCorrelationPositive;
  saved.flag = config.pricing.mlbSgpCorrelationMeasured; saved.cap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = (sport, home, away, market) => (market === 'h2h' ? 0.60 : 0.50);
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  // MLB measured table OFF so the GRID is what prices (it is the grid under test)
  config.pricing.mlbSgpCorrelationMeasured = false;
  config.pricing.sgpCorrelationByCombo = grid;
  if ('pos' in extra) config.pricing.sgpCorrelationPositive = extra.pos;
  if ('grid3' in extra) config.pricing.sgpCorrelation3PlusByCombo = extra.grid3;
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000;
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale; if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.sgpAllowedCombos = saved.combos; config.pricing.sgpCorrelationByCombo = saved.grid;
  config.pricing.sgpCorrelation3PlusByCombo = saved.grid3; config.pricing.sgpCorrelationPositive = saved.pos;
  config.pricing.mlbSgpCorrelationMeasured = saved.flag; config.pricing.maxRiskPerParlay = saved.cap;
  config.pricing.maxOdds = saved.maxOdds;
}
async function price(ids, pid) {
  const res = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a DIRECTIONAL grid factor of 0.95 is floored: fair >= the independent product', async () => {
  stub({ spread_total: 1.15, ml_total: 1.15, spread_fav_over: 1.30, spread_dog_under: 1.02, spread_fav_under: 0.95, spread_dog_over: 0.95 });
  try {
    for (const [ids, pid] of [[['fu-s', 'fu-t'], 'grid-fu'], [['do-s', 'do-t'], 'grid-do']]) {
      const m = await price(ids, pid);
      assert.ok(m.fairParlayProb >= IND_ST - 1e-12,
        `${pid}: fair ${m.fairParlayProb} is BELOW the independent product ${IND_ST}`);
      assert.strictEqual(m.sgpCorrelationFactor, 1, `${pid}: 0.95 must floor to 1, got ${m.sgpCorrelationFactor}`);
      assert.notStrictEqual(m.sgpCorrelationSign, 'negative');
      assert.ok(m.offeredImpliedProb > m.fairParlayProb, `${pid}: the quote still carries margin`);
    }
  } finally { restore(); }
});

test('a factor ABOVE 1 still applies unchanged: 1.08 on the same directions, 1.30 on fav+over', async () => {
  stub({ spread_total: 1.15, ml_total: 1.15, spread_fav_over: 1.30, spread_dog_under: 1.02, spread_fav_under: 1.08, spread_dog_over: 1.08 });
  try {
    const fu = await price(['fu-s', 'fu-t'], 'grid-fu-108');
    assert.ok(near(fu.sgpCorrelationFactor, 1.08), `fav+under 1.08 expected, got ${fu.sgpCorrelationFactor}`);
    assert.ok(near(fu.fairParlayProb, IND_ST * 1.08), `fair ${fu.fairParlayProb} vs ${IND_ST * 1.08}`);
    const d = await price(['do-s', 'do-t'], 'grid-do-108');
    assert.ok(near(d.sgpCorrelationFactor, 1.08), `dog+over 1.08 expected, got ${d.sgpCorrelationFactor}`);
    const fo = await price(['fo-s', 'fo-t'], 'grid-fo-130');
    assert.ok(near(fo.sgpCorrelationFactor, 1.30), `fav+over 1.30 expected, got ${fo.sgpCorrelationFactor}`);
  } finally { restore(); }
});

test('the SHIPPED defaults price fav+under / dog+over at exactly independent', async () => {
  stub(freshConfig(undefined).pricing.sgpCorrelationByCombo);
  try {
    const m = await price(['fu-s', 'fu-t'], 'grid-default-fu');
    assert.strictEqual(m.sgpCorrelationFactor, 1);
    assert.ok(near(m.fairParlayProb, IND_ST), `fair ${m.fairParlayProb} vs independent ${IND_ST}`);
  } finally { restore(); }
});

test('UN-DIRECTED grid keys below 1 are floored too (spread_total, ml_total)', async () => {
  // No directional keys, so spread+total falls to the un-directed key.
  stub({ spread_total: 0.9, ml_total: 0.9 });
  try {
    const st = await price(['fo-s', 'fo-t'], 'grid-undirected-st');
    assert.strictEqual(st.sgpCorrelationFactor, 1, `spread_total 0.9 must floor, got ${st.sgpCorrelationFactor}`);
    assert.ok(st.fairParlayProb >= IND_ST - 1e-12, `fair ${st.fairParlayProb} below ${IND_ST}`);
    const mt = await price(['mt-m', 'mt-t'], 'grid-undirected-mt');
    assert.strictEqual(mt.sgpCorrelationFactor, 1, `ml_total 0.9 must floor, got ${mt.sgpCorrelationFactor}`);
    assert.ok(mt.fairParlayProb >= IND_MT - 1e-12, `fair ${mt.fairParlayProb} below ${IND_MT}`);
  } finally { restore(); }
});

test('the LEGACY sgpCorrelationPositive fallback below 1 is floored', async () => {
  // Grid empty -> spread_total falls through to the legacy single factor.
  stub({}, { pos: 0.9 });
  try {
    const m = await price(['fo-s', 'fo-t'], 'grid-legacy');
    assert.strictEqual(m.sgpCorrelationFactor, 1, `legacy 0.9 must floor, got ${m.sgpCorrelationFactor}`);
    assert.ok(m.fairParlayProb >= IND_ST - 1e-12);
  } finally { restore(); }
});

test('the 3+ leg grid (sgpCorrelation3PlusByCombo) is floored; values above 1 still apply', async () => {
  const ids = ['x3-m', 'x3-s', 'x3-t'];
  const ind = 0.60 * 0.50 * 0.50;
  stub({}, { grid3: { ml_spread_total: 0.9, default: 0.9 } });
  try {
    const m = await price(ids, 'grid-3p-low');
    assert.strictEqual(m.sgpCorrelationFactor, 1, `3+ leg 0.9 must floor, got ${m.sgpCorrelationFactor}`);
    assert.ok(m.fairParlayProb >= ind - 1e-12, `fair ${m.fairParlayProb} below ${ind}`);
  } finally { restore(); }
  stub({}, { grid3: { ml_spread_total: 1.2, default: 1.15 } });
  try {
    const m = await price(ids, 'grid-3p-high');
    assert.ok(near(m.sgpCorrelationFactor, 1.2), `3+ leg 1.20 expected, got ${m.sgpCorrelationFactor}`);
  } finally { restore(); }
});

// ------------------------------------------- legacy backfill mirrors the floor

test('backfillSgpCorrelation (dry run) never writes a grid factor below 1', async () => {
  const prevGrid = config.pricing.sgpCorrelationByCombo;
  const legs = [{ pxEventId: 'BF1', market: 'spread' }, { pxEventId: 'BF1', market: 'total' }];
  try {
    orderTracker.recordQuote('grid-bf-low', legs, 300, 100, 0.25, { isSGP: true });
    config.pricing.sgpCorrelationByCombo = { spread_total: 0.9 };
    const low = await orderTracker.backfillSgpCorrelation({ dryRun: true });
    const hitLow = (low.sample || []).find(s => s.parlayId === 'grid-bf-low');
    assert.ok(!hitLow, `0.9 must floor to 1 (no backfill), got ${JSON.stringify(hitLow)}`);
    config.pricing.sgpCorrelationByCombo = { spread_total: 1.08 };
    const high = await orderTracker.backfillSgpCorrelation({ dryRun: true });
    const hitHigh = (high.sample || []).find(s => s.parlayId === 'grid-bf-low');
    assert.ok(hitHigh && near(hitHigh.factor, 1.08), `1.08 still backfills, got ${JSON.stringify(hitHigh)}`);
  } finally {
    config.pricing.sgpCorrelationByCombo = prevGrid;
    try { orderTracker.releasePending('grid-bf-low'); } catch (_) {}
  }
});
