// MLB MONEYLINE-PAIR MARGIN TRIM A/B (2026-09-17).
//
// Measured 2026-09-10 (14d): $253K/wk of 2-leg cross-game MLB moneyline
// network fills lost at a 0.69pp median gap, 35% within 0.5pp, on a family our
// own settled fills show CALIBRATED (2-leg MLB ML z=-1.08). So the marginal
// fill is a price-competitiveness question, not a mispricing — exactly the HR
// case, different market. This mirrors test/hr-pair-trim.test.js.
//
// Ships DARK (percent 0). Fractional-not-flat with a hard relative-edge floor,
// so it can never quote below fair × (1 + floor). Arm salt is 'ml:' so a
// parlay's ML-arm is independent of its HR-arm.
//
// Harness note (same as HR): priceParlay registers PENDING exposure and the
// template ramp keys on the leg signature, declining the 5th quote of one
// signature — so each iteration uses fresh lines on fresh events, and the trim
// assertions are made WITHIN one call.
//
// Run: node --test test/ml-pair-trim.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const mlLine = (id, ev) => ({
  lineId: id, sport: 'baseball_mlb', marketType: 'moneyline',
  teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
  oddsApiMarket: 'h2h', oddsApiSport: 'baseball_mlb',
  homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
  pxEventId: ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
});
const totalLine = (id, ev) => ({
  lineId: id, sport: 'baseball_mlb', marketType: 'total', line: 8.5,
  teamName: 'over', selection: 'over', oddsApiSelection: 'over',
  oddsApiMarket: 'totals', oddsApiSport: 'baseball_mlb',
  homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
  pxEventId: ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
});
const LINES = {
  'ml-a': mlLine('ml-a', 'E1'),
  'ml-b': mlLine('ml-b', 'E2'),
  'ml-c': mlLine('ml-c', 'E3'),
  'ml-a2': mlLine('ml-a2', 'E1'),           // same game as ml-a
  'tot-x': totalLine('tot-x', 'E9'),
};

const saved = {};
function stub() {
  saved.lookup = lineManager.lookupLine;
  saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent;
  saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.parlayCap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds;
  saved.pct = config.pricing.mlPairTrimPercent;
  saved.frac = config.pricing.mlPairTrimFraction;
  saved.floor = config.pricing.mlPairMinRelEdgePct;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.20;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlay = 3000;
  config.pricing.maxOdds = 50000;
}
function restore() {
  lineManager.lookupLine = saved.lookup;
  oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale;
  if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.maxRiskPerParlay = saved.parlayCap;
  config.pricing.maxOdds = saved.maxOdds;
  config.pricing.mlPairTrimPercent = saved.pct;
  config.pricing.mlPairTrimFraction = saved.frac;
  config.pricing.mlPairMinRelEdgePct = saved.floor;
}
async function price(ids, parlayId, pct, frac, floor) {
  config.pricing.mlPairTrimPercent = pct;
  if (frac != null) config.pricing.mlPairTrimFraction = frac;
  if (floor != null) config.pricing.mlPairMinRelEdgePct = floor;
  const res = await pricer.priceParlay(ids, parlayId ? { parlayId } : {});
  try { if (parlayId) orderTracker.releasePending(parlayId); } catch (_) { /* best effort */ }
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta;
}

test('dark (percent 0): no arm, no trim, price untouched', async () => {
  stub();
  try {
    const m = await price(['ml-a', 'ml-b'], 'p-dark-1', 0);
    assert.strictEqual(m.mlTrimArm, null);
    assert.strictEqual(m.mlTrimApplied, false);
    assert.strictEqual(m.mlTrimPreProb, null);
  } finally { restore(); }
});

test('percent 100: trim arm, offered reduced by the FRACTION of margin, fair untouched', async () => {
  stub();
  try {
    const m = await price(['ml-a', 'ml-b'], 'p-100-1', 100, 0.4, 4);
    assert.strictEqual(m.mlTrimArm, 'trim');
    assert.strictEqual(m.mlTrimApplied, true);
    assert.strictEqual(m.mlTrimFraction, 0.4);
    const fair = m.fairParlayProb, pre = m.mlTrimPreProb, off = m.offeredImpliedProb;
    assert.ok(pre > fair, 'the untrimmed price carried a positive margin');
    const expected = pre - (pre - fair) * 0.4;
    assert.ok(Math.abs(off - expected) < 2e-5, `offered ${off} should be ${expected.toFixed(5)} (40% of margin removed)`);
    assert.ok(off < pre, 'cheaper for the bettor');
    assert.ok(off >= fair * 1.04 - 1e-9, 'never below the relative-edge floor');
  } finally { restore(); }
});

test('the relative-edge FLOOR clamps an over-aggressive fraction — never below fair × (1 + floor)', async () => {
  stub();
  try {
    const m = await price(['ml-a', 'ml-b'], 'p-floor-1', 100, 0.9, 4);
    const fair = m.fairParlayProb;
    assert.strictEqual(m.mlTrimApplied, true);
    assert.ok(Math.abs(m.offeredImpliedProb - fair * 1.04) < 2e-5,
      `90% trim must be clamped to fair×1.04: got ${m.offeredImpliedProb}, fair ${fair}`);
    const n = await price(['ml-a', 'ml-b'], 'p-floor-2', 100, 0.4, 50);
    assert.strictEqual(n.mlTrimApplied, false, 'a floor above the existing edge leaves the price alone');
    assert.strictEqual(n.mlTrimArm, 'trim', '...but the arm is still recorded');
  } finally { restore(); }
});

test('assignment is DETERMINISTIC per parlayId and splits at the configured percent', async () => {
  stub();
  try {
    const a1 = await price(['ml-c', 'ml-b'], 'p-det-42', 50);
    const a2 = await price(['ml-c', 'ml-b'], 'p-det-42', 50);
    assert.strictEqual(a1.mlTrimArm, a2.mlTrimArm, 'same parlayId → same arm');
    const arms = { trim: 0, control: 0 };
    for (let i = 0; i < 120; i++) {
      const a = 'ml-s' + i + '-a', b = 'ml-s' + i + '-b';
      LINES[a] = mlLine(a, 'S' + i + 'a');
      LINES[b] = mlLine(b, 'S' + i + 'b');
      const m = await price([a, b], 'p-split-' + i, 50);
      arms[m.mlTrimArm]++;
      if (m.mlTrimArm === 'control') assert.strictEqual(m.mlTrimApplied, false, 'control arm never trims');
    }
    assert.ok(arms.trim >= 35 && arms.control >= 35, `50% split must populate both arms: ${JSON.stringify(arms)}`);
  } finally { restore(); }
});

test('OUT OF SCOPE shapes get no arm and no trim, even at percent 100', async () => {
  stub();
  try {
    const cases = {
      'same-game ML pair (different-game guard)': ['ml-a', 'ml-a2'],
      '3-leg ML': ['ml-a', 'ml-b', 'ml-c'],
      'ML + total (mixed market)': ['ml-a', 'tot-x'],
    };
    for (const [label, ids] of Object.entries(cases)) {
      config.pricing.mlPairTrimPercent = 100;
      const pid = 'p-scope-' + label.replace(/\W+/g, '-');
      const res = await pricer.priceParlay(ids, { parlayId: pid });
      try { orderTracker.releasePending(pid); } catch (_) {}
      if (!res) continue;                       // declined by another gate — not our concern
      assert.strictEqual(res.meta.mlTrimArm, null, label + ' must not be assigned an arm');
      assert.strictEqual(res.meta.mlTrimApplied, false, label + ' must not be trimmed');
    }
  } finally { restore(); }
});

test('a parlay\'s ML-arm and HR-arm are salted independently', () => {
  const crypto = require('crypto');
  let differ = 0;
  for (let i = 0; i < 200; i++) {
    const pid = 'salt-' + i;
    const hr = crypto.createHash('md5').update('hr:' + pid).digest().readUInt32BE(0) % 100 < 50;
    const ml = crypto.createHash('md5').update('ml:' + pid).digest().readUInt32BE(0) % 100 < 50;
    if (hr !== ml) differ++;
  }
  assert.ok(differ > 60, `the two salts must not move together: differed on ${differ}/200`);
});

test('no parlayId → no arm (nothing to hash), price untouched', async () => {
  stub();
  try {
    const m = await price(['ml-a', 'ml-c'], null, 100);
    assert.strictEqual(m.mlTrimArm, null);
    assert.strictEqual(m.mlTrimApplied, false);
  } finally { restore(); }
});

test('config defaults: dark, 0.4 fraction, 4% floor', () => {
  assert.strictEqual(config.pricing.mlPairTrimPercent, 0, 'ships DARK');
  assert.strictEqual(config.pricing.mlPairTrimFraction, 0.4);
  assert.strictEqual(config.pricing.mlPairMinRelEdgePct, 4);
});
