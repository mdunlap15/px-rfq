// PARLAY-SURCHARGE EXEMPTION (2026-09-26, operator: "shift this to be competitive").
//
// All-CFB parlays of 2..4 legs skip the heavy-fav markup, the chalk-stack
// surcharge and the leg-count multiplier. Measured the same day: our CFB margin
// over fair ran ~11% vs the winning SP ~1-3%, while 45d CFB fills are calibrated
// (n=244, z=-0.77, +6.1% ROI). 5+ legs and any parlay with a non-exempt leg keep
// every surcharge. Per-leg vig still applies, so the quote stays above fair.
//
// Run: node --test test/parlay-surcharge-exempt.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const CFB = 'americanfootball_ncaaf';
const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
let seq = 0;
const LINES = {};
function mkLine(sport) {
  const id = `sx-${sport}-${++seq}`;
  const ev = 'SX' + seq;
  LINES[id] = {
    lineId: id, sport, marketType: 'moneyline',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
    oddsApiMarket: 'h2h', oddsApiSport: sport,
    homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
    pxEventId: ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
  };
  return id;
}
const legs = (n, sport = CFB) => Array.from({ length: n }, () => mkLine(sport));

const KEYS = ['maxRiskPerParlay', 'maxOdds', 'vigHeavyFavFairMarkup', 'vigHeavyFavThreshold',
  'vigChalkStackSurcharge', 'vigByLegCount', 'parlaySurchargeExemptSports', 'parlaySurchargeExemptMaxLegs',
  'defaultVig', 'vigBySport', 'vigFavoriteSlope', 'vigFavoriteFloor', 'vigFairMultiplier'];
const saved = {};
function stub(fair) {
  saved.lookup = lineManager.lookupLine;
  saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent;
  saved.stalePre = oddsFeed.isEventStalePreGame;
  for (const k of KEYS) saved[k] = config.pricing[k];
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => fair;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlay = 3000;
  config.pricing.maxOdds = 50000;
  // Production values on 2026-09-26 (the test env default vig of 6% would
  // otherwise MAX-gate over both surcharges and hide them).
  config.pricing.defaultVig = 0.018;
  config.pricing.vigBySport = { americanfootball_ncaaf: 0.005, baseball_mlb: 0.018 };
  config.pricing.vigFavoriteSlope = 0.026;
  config.pricing.vigFavoriteFloor = 0.006;
  config.pricing.vigFairMultiplier = 0.008;
  config.pricing.vigHeavyFavFairMarkup = 0.023;
  config.pricing.vigHeavyFavThreshold = 0.62;
  config.pricing.vigChalkStackSurcharge = 0.048;
  config.pricing.vigByLegCount = { 3: 1.15, 4: 1.25, 5: 2, 6: 2.75 };
  config.pricing.parlaySurchargeExemptSports = [CFB];
  config.pricing.parlaySurchargeExemptMaxLegs = 4;
}
function restore() {
  lineManager.lookupLine = saved.lookup;
  oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale;
  if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  for (const k of KEYS) config.pricing[k] = saved[k];
}
let pid = 0;
async function price(ids) {
  const parlayId = 'sx-p-' + (++pid);
  const res = await pricer.priceParlay(ids, { parlayId });
  try { orderTracker.releasePending(parlayId); } catch (_) { /* best effort */ }
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta;
}
// Same shape priced with the exemption on and off (fresh lines each time so the
// template ramp never sees a repeated signature).
async function onOff(n, sport = CFB) {
  config.pricing.parlaySurchargeExemptSports = [CFB];
  const on = await price(legs(n, sport));
  config.pricing.parlaySurchargeExemptSports = [];
  const off = await price(legs(n, sport));
  config.pricing.parlaySurchargeExemptSports = [CFB];
  return { on, off };
}

test('defaults: CFB exempt up to 4 legs; explicit empty exempts nothing', () => {
  const prev = process.env.PARLAY_SURCHARGE_EXEMPT_SPORTS;
  const load = () => {
    delete require.cache[require.resolve('../config')];
    return require('../config').config.pricing;
  };
  try {
    delete process.env.PARLAY_SURCHARGE_EXEMPT_SPORTS;
    const p = load();
    assert.deepStrictEqual(p.parlaySurchargeExemptSports, [CFB]);
    assert.strictEqual(p.parlaySurchargeExemptMaxLegs, 4);
    process.env.PARLAY_SURCHARGE_EXEMPT_SPORTS = '';
    assert.deepStrictEqual(load().parlaySurchargeExemptSports, [],
      'explicitly empty means NO sport exempt, not the default');
  } finally {
    if (prev == null) delete process.env.PARLAY_SURCHARGE_EXEMPT_SPORTS;
    else process.env.PARLAY_SURCHARGE_EXEMPT_SPORTS = prev;
    delete require.cache[require.resolve('../config')];
  }
});

test('2-leg CFB chalk: heavy-fav + chalk-stack skipped, price cheaper, still above fair', async () => {
  stub(0.66);
  try {
    const { on, off } = await onOff(2);
    assert.strictEqual(on.surchargeExempt, true);
    assert.strictEqual(off.surchargeExempt, false);
    assert.ok(Math.abs(on.fairParlayProb - off.fairParlayProb) < 1e-9, 'fair is untouched');
    assert.ok(off.offeredImpliedProb >= off.fairParlayProb * 1.048 - 1e-6, 'control carries the chalk-stack surcharge');
    assert.ok(on.offeredImpliedProb < off.offeredImpliedProb - 0.005,
      `exempt must be materially cheaper: ${on.offeredImpliedProb} vs ${off.offeredImpliedProb}`);
    assert.ok(on.offeredImpliedProb > on.fairParlayProb, 'per-leg vig keeps the exempt quote above fair');
  } finally { restore(); }
});

test('3- and 4-leg CFB: leg-count multiplier skipped', async () => {
  stub(0.5);
  try {
    for (const n of [3, 4]) {
      const { on, off } = await onOff(n);
      assert.strictEqual(on.surchargeExempt, true, `${n}-leg exempt`);
      assert.ok(on.offeredImpliedProb < off.offeredImpliedProb,
        `${n}-leg exempt cheaper: ${on.offeredImpliedProb} vs ${off.offeredImpliedProb}`);
      assert.ok(on.offeredImpliedProb > on.fairParlayProb, `${n}-leg still above fair`);
    }
  } finally { restore(); }
});

test('5+ legs keep every surcharge (thin, unprofitable history)', async () => {
  stub(0.5);
  try {
    const { on, off } = await onOff(5);
    assert.strictEqual(on.surchargeExempt, false);
    assert.ok(Math.abs(on.offeredImpliedProb / on.fairParlayProb - off.offeredImpliedProb / off.fairParlayProb) < 1e-6,
      '5-leg margin identical with the exemption on or off');
  } finally { restore(); }
});

test('a single non-exempt leg (CFB + MLB) keeps every surcharge', async () => {
  stub(0.66);
  try {
    const m = await price([mkLine(CFB), mkLine('baseball_mlb')]);
    assert.strictEqual(m.surchargeExempt, false);
    assert.ok(m.offeredImpliedProb >= m.fairParlayProb * 1.048 - 1e-6, 'chalk-stack still applies');
  } finally { restore(); }
});

test('other sports are untouched by default (MLB 2-leg chalk)', async () => {
  stub(0.66);
  try {
    const { on, off } = await onOff(2, 'baseball_mlb');
    assert.strictEqual(on.surchargeExempt, false);
    assert.ok(Math.abs(on.offeredImpliedProb / on.fairParlayProb - off.offeredImpliedProb / off.fairParlayProb) < 1e-6);
  } finally { restore(); }
});

test('runtime edits take effect per call: Set shape, max-legs, and empty list', async () => {
  stub(0.5);
  try {
    config.pricing.parlaySurchargeExemptSports = new Set([CFB]);
    assert.strictEqual((await price(legs(3))).surchargeExempt, true, 'a Set (runtime _write shape) works');
    config.pricing.parlaySurchargeExemptMaxLegs = 2;
    assert.strictEqual((await price(legs(3))).surchargeExempt, false, 'max legs 2 excludes a 3-leg');
    config.pricing.parlaySurchargeExemptMaxLegs = 4;
    config.pricing.parlaySurchargeExemptSports = [];
    assert.strictEqual((await price(legs(3))).surchargeExempt, false, 'empty list exempts nothing');
  } finally { restore(); }
});

test('runtime registry exposes the new keys (no restart needed to tune them)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/runtime-config'), 'utf8');
  for (const k of ['parlaySurchargeExemptSports', 'parlaySurchargeExemptMaxLegs', 'stalePriceMinutesBySport', 'propNetExposureBySport']) {
    assert.ok(src.includes(`key: '${k}'`), `${k} registered`);
  }
});
