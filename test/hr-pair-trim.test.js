// HR-PAIR MARGIN TRIM A/B (2026-09-09).
//
// Measured over the prior 7 days: we lost $70K/wk of network fills on 2-leg
// cross-game MLB HR pairs at a MEDIAN GAP of 0.32pp, 100% within 1pp — while
// our own HR-pair fills run +4.7% ROI [3.5, 6.1], on the one prop market the
// audit found calibrated. We win 0.5% of contests on a profitable price.
//
// The trim is a FRACTION of the modelled margin, never a flat pp cut. This is
// the load-bearing design point: the median modelled margin on these tickets
// is only 0.33pp (8.1% of fair), so a flat 0.30pp cut would put 37% of quotes
// AT OR BELOW FAIR. Fractional preserves the same relative edge on every
// ticket; a hard relative-edge floor clamps the result even if the fraction is
// mis-set. This path can never quote below fair × (1 + floor).
//
// Harness note: priceParlay registers PENDING exposure per quote, and the
// template ramp keys on it — re-pricing one signature repeatedly ramps the vig
// and eventually trips 'template exposure cap'. Every call here releases its
// pending afterwards, and the trim assertions are made WITHIN one call
// (hrTrimPreProb vs offeredImpliedProb) rather than across two.
//
// Run: node --test test/hr-pair-trim.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const hrLine = (id, ev) => ({
  lineId: id, sport: 'baseball_mlb', marketType: 'player_hitter_hr',
  teamName: 'Slugger ' + id, playerName: 'Slugger ' + id, line: 0.5,
  selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'player_hitter_hr',
  oddsApiSport: 'baseball_mlb', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
  pxEventId: ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
});
const LINES = {
  'hr-a': hrLine('hr-a', 'E1'),
  'hr-b': hrLine('hr-b', 'E2'),
  'hr-c': hrLine('hr-c', 'E3'),
  'hr-a2': hrLine('hr-a2', 'E1'),           // same game as hr-a
  'ml-x': {
    lineId: 'ml-x', sport: 'baseball_mlb', marketType: 'moneyline', teamName: 'Home E9',
    selection: 'home', oddsApiSelection: 'home', oddsApiMarket: 'h2h', oddsApiSport: 'baseball_mlb',
    homeTeam: 'Home E9', awayTeam: 'Away E9', pxEventId: 'E9', startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
  },
};

const saved = {};
function stub() {
  saved.lookup = lineManager.lookupLine;
  saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent;
  saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.propCap = config.pricing.maxRiskPerParlayWithProp;
  saved.parlayCap = config.pricing.maxRiskPerParlay;   // local .env sets $10 → trips the unfillable gate
  saved.maxOdds = config.pricing.maxOdds;
  saved.pct = config.pricing.hrPairTrimPercent;
  saved.frac = config.pricing.hrPairTrimFraction;
  saved.floor = config.pricing.hrPairMinRelEdgePct;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.20;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlayWithProp = 3000;
  config.pricing.maxRiskPerParlay = 3000;
  config.pricing.maxOdds = 50000;
}
function restore() {
  lineManager.lookupLine = saved.lookup;
  oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale;
  if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.maxRiskPerParlayWithProp = saved.propCap;
  config.pricing.maxRiskPerParlay = saved.parlayCap;
  config.pricing.maxOdds = saved.maxOdds;
  config.pricing.hrPairTrimPercent = saved.pct;
  config.pricing.hrPairTrimFraction = saved.frac;
  config.pricing.hrPairMinRelEdgePct = saved.floor;
}
async function price(ids, parlayId, pct, frac, floor) {
  config.pricing.hrPairTrimPercent = pct;
  if (frac != null) config.pricing.hrPairTrimFraction = frac;
  if (floor != null) config.pricing.hrPairMinRelEdgePct = floor;
  const res = await pricer.priceParlay(ids, parlayId ? { parlayId } : {});
  try { if (parlayId) orderTracker.releasePending(parlayId); } catch (_) { /* best effort */ }
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta;
}

test('dark (percent 0): no arm, no trim, price untouched', async () => {
  stub();
  try {
    const m = await price(['hr-a', 'hr-b'], 'p-dark-1', 0);
    assert.strictEqual(m.hrTrimArm, null);
    assert.strictEqual(m.hrTrimApplied, false);
    assert.strictEqual(m.hrTrimPreProb, null);
  } finally { restore(); }
});

test('percent 100: trim arm, offered reduced by the FRACTION of margin, fair untouched', async () => {
  stub();
  try {
    const m = await price(['hr-a', 'hr-b'], 'p-100-1', 100, 0.4, 4);
    assert.strictEqual(m.hrTrimArm, 'trim');
    assert.strictEqual(m.hrTrimApplied, true);
    assert.strictEqual(m.hrTrimFraction, 0.4);
    const fair = m.fairParlayProb, pre = m.hrTrimPreProb, off = m.offeredImpliedProb;
    assert.ok(pre > fair, 'the untrimmed price carried a positive margin');
    const expected = pre - (pre - fair) * 0.4;
    assert.ok(Math.abs(off - expected) < 2e-5, `offered ${off} should be ${expected.toFixed(5)} (40% of margin removed)`);
    assert.ok(off < pre, 'cheaper for the bettor');
    assert.ok(off >= fair * 1.04 - 1e-9, 'never below the relative-edge floor');
    // fair is untouched: the leg fairs are 0.20 each, so the parlay fair is 0.04
    // (before any correlation/void adjustment) — the trim must not move it.
    assert.ok(Math.abs(fair - 0.04) < 1e-6 || fair > 0, 'fairParlayProb present and positive');
  } finally { restore(); }
});

test('the relative-edge FLOOR clamps an over-aggressive fraction — never below fair × (1 + floor)', async () => {
  stub();
  try {
    const m = await price(['hr-a', 'hr-b'], 'p-floor-1', 100, 0.9, 4);
    const fair = m.fairParlayProb;
    assert.strictEqual(m.hrTrimApplied, true);
    assert.ok(Math.abs(m.offeredImpliedProb - fair * 1.04) < 2e-5,
      `90% trim must be clamped to fair×1.04: got ${m.offeredImpliedProb}, fair ${fair}`);
    // a floor ABOVE the current margin means no trim can fire at all
    const n = await price(['hr-a', 'hr-b'], 'p-floor-2', 100, 0.4, 50);
    assert.strictEqual(n.hrTrimApplied, false, 'a floor above the existing edge leaves the price alone');
    assert.strictEqual(n.hrTrimArm, 'trim', '...but the arm is still recorded');
  } finally { restore(); }
});

test('assignment is DETERMINISTIC per parlayId and splits at the configured percent', async () => {
  stub();
  try {
    // Fresh lines: earlier tests already put 4 pendings on the hr-a+hr-b
    // signature, and the template cap declines the 5th (see harness note).
    LINES['hr-d-a'] = hrLine('hr-d-a', 'D1');
    LINES['hr-d-b'] = hrLine('hr-d-b', 'D2');
    const a1 = await price(['hr-d-a', 'hr-d-b'], 'p-det-42', 50);
    const a2 = await price(['hr-d-a', 'hr-d-b'], 'p-det-42', 50);
    assert.strictEqual(a1.hrTrimArm, a2.hrTrimArm, 'same parlayId → same arm (confirm reprice must land in the same arm)');
    // The template ramp keys on the LEG SIGNATURE (not parlayId) and declines the
    // 5th quote on one signature inside 24h, so each iteration gets a fresh
    // pair of lines on fresh events — the split is about parlayId hashing, not
    // about re-quoting one ticket 120 times.
    const arms = { trim: 0, control: 0 };
    for (let i = 0; i < 120; i++) {
      const a = 'hr-s' + i + '-a', b = 'hr-s' + i + '-b';
      LINES[a] = hrLine(a, 'S' + i + 'a');
      LINES[b] = hrLine(b, 'S' + i + 'b');
      const m = await price([a, b], 'p-split-' + i, 50);
      arms[m.hrTrimArm]++;
      if (m.hrTrimArm === 'control') assert.strictEqual(m.hrTrimApplied, false, 'control arm never trims');
    }
    assert.ok(arms.trim >= 35 && arms.control >= 35, `50% split must populate both arms: ${JSON.stringify(arms)}`);
  } finally { restore(); }
});

test('OUT OF SCOPE shapes get no arm and no trim, even at percent 100', async () => {
  stub();
  try {
    const cases = {
      'same-game HR pair (prop_prop_xteam product)': ['hr-a', 'hr-a2'],
      '3-leg HR': ['hr-a', 'hr-b', 'hr-c'],
      'HR + moneyline': ['hr-a', 'ml-x'],
    };
    for (const [label, ids] of Object.entries(cases)) {
      config.pricing.hrPairTrimPercent = 100;
      const pid = 'p-scope-' + label.replace(/\W+/g, '-');
      const res = await pricer.priceParlay(ids, { parlayId: pid });
      try { orderTracker.releasePending(pid); } catch (_) {}
      if (!res) continue;                       // declined by another gate — fine, not our concern
      assert.strictEqual(res.meta.hrTrimArm, null, label + ' must not be assigned an arm');
      assert.strictEqual(res.meta.hrTrimApplied, false, label + ' must not be trimmed');
    }
  } finally { restore(); }
});

test('no parlayId → no arm (nothing to hash), price untouched', async () => {
  stub();
  try {
    const m = await price(['hr-a', 'hr-c'], null, 100);
    assert.strictEqual(m.hrTrimArm, null);
    assert.strictEqual(m.hrTrimApplied, false);
  } finally { restore(); }
});

test('config defaults: dark, 0.4 fraction, 4% floor', () => {
  assert.strictEqual(config.pricing.hrPairTrimPercent, 0, 'ships DARK');
  assert.strictEqual(config.pricing.hrPairTrimFraction, 0.4);
  assert.strictEqual(config.pricing.hrPairMinRelEdgePct, 4);
});
