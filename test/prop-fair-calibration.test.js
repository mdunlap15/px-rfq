// Per-prop-type-per-side leg-fair calibration.
//
// De-vig inherits the books' favourite-longshot shading, so some prop legs are
// systematically miscalibrated. MEASURED on 930 unique HR-over legs (box-score
// ground truth): our fair 21.2% vs realised 16.3%, ratio 1.30, z=-3.62 — we
// overprice the over. A per-(propType.side) multiplier corrects the leg fair
// before it compounds. Ships OFF (empty map).
//
// This tests the config parsing + the multiplier arithmetic in isolation.
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');

// Mirror of the pricer's application (bookPriceOverride legs are skipped there).
function applyCalib(fairProb, marketType, side, calibMap) {
  if (!calibMap || !(fairProb > 0 && fairProb < 1) || !marketType || !side) return { fairProb, applied: null };
  const mult = calibMap[`${marketType}.${String(side).toLowerCase()}`];
  if (mult == null || mult === 1) return { fairProb, applied: null };
  const adj = Math.min(0.999, Math.max(0.0001, fairProb * mult));
  if (adj === fairProb) return { fairProb, applied: null };
  return { fairProb: adj, applied: { from: fairProb, to: adj, mult } };
}

test('config ships the map EMPTY (off) by default', () => {
  delete process.env.PROP_FAIR_CALIBRATION;
  delete require.cache[require.resolve('../config')];
  const { config } = require('../config');
  assert.deepEqual(config.pricing.propFairCalibration, {});
});

test('config parses valid keys and rejects malformed / out-of-bounds', () => {
  process.env.PROP_FAIR_CALIBRATION = JSON.stringify({
    'hitter_hr.over': 0.82,     // valid
    'bad_key': 0.9,             // no side -> rejected
    'hitter_hr.sideways': 0.9,  // bad side -> rejected
    'x.over': 0.3,              // below 0.5 bound -> rejected
    'y.under': 1.9,             // above 1.5 bound -> rejected
  });
  delete require.cache[require.resolve('../config')];
  const { config } = require('../config');
  assert.deepEqual(config.pricing.propFairCalibration, { 'hitter_hr.over': 0.82 });
  delete process.env.PROP_FAIR_CALIBRATION;
  delete require.cache[require.resolve('../config')];
});

test('shades an HR-over fair down toward the realised rate', () => {
  const r = applyCalib(0.212, 'hitter_hr', 'over', { 'hitter_hr.over': 0.82 });
  assert.ok(Math.abs(r.fairProb - 0.212 * 0.82) < 1e-9);
  assert.ok(r.fairProb < 0.212, 'must lower the over fair');
  assert.equal(r.applied.mult, 0.82);
});

test('only touches the keyed prop AND side', () => {
  const map = { 'hitter_hr.over': 0.82 };
  assert.equal(applyCalib(0.212, 'hitter_hr', 'under', map).applied, null, 'under untouched');
  assert.equal(applyCalib(0.30, 'hitter_hits', 'over', map).applied, null, 'other prop untouched');
  assert.equal(applyCalib(0.212, 'hitter_hr', 'over', map).applied.mult, 0.82, 'over touched');
});

test('a multiplier of exactly 1 is a no-op', () => {
  assert.equal(applyCalib(0.212, 'hitter_hr', 'over', { 'hitter_hr.over': 1 }).applied, null);
});

test('side matching is case-insensitive (OVER == over)', () => {
  const r = applyCalib(0.2, 'hitter_hr', 'OVER', { 'hitter_hr.over': 0.8 });
  assert.ok(r.applied != null && r.applied.mult === 0.8);
});

test('result stays in (0,1) even with an extreme multiplier', () => {
  const hi = applyCalib(0.9, 'x', 'over', { 'x.over': 1.5 });
  assert.ok(hi.fairProb < 1 && hi.fairProb > 0);
  const lo = applyCalib(0.001, 'x', 'over', { 'x.over': 0.5 });
  assert.ok(lo.fairProb > 0 && lo.fairProb < 1);
});

test('an empty map (off) never adjusts anything', () => {
  assert.equal(applyCalib(0.212, 'hitter_hr', 'over', {}).applied, null);
});
