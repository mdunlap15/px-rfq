// Void-adjusted fair prob — the honest denominator for calibration.
//
// meta.fairParlayProb is the product of ALL priced legs, including ones that
// later VOIDED. PX grades the parlay after DROPPING void legs, so comparing the
// realised outcome against the raw product is biased toward the bettor. Dividing
// out each void leg's own fair recovers the product of the surviving legs.
// This artifact manufactured the golf/soccer "correlation" scares of 2026-08-05.
//
// Run: npm test   (or: node --test test/void-adjusted-calibration.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const ot = require('../services/order-tracker');
const f = ot.computeVoidAdjustedFairProb;

const leg = (fairProb, settlementStatus) => ({ fairProb, settlementStatus });

test('no void legs returns the raw fair unchanged', () => {
  const r = f(0.25, [leg(0.5, 'won'), leg(0.5, 'lost')]);
  assert.equal(r.voidLegs, 0);
  assert.equal(r.prob, 0.25);
});

test('a void leg is divided out, making the surviving parlay MORE likely', () => {
  // priced 0.5 * 0.4 = 0.20; the 0.5 leg voids -> surviving fair is 0.40
  const r = f(0.20, [leg(0.5, 'void'), leg(0.4, 'won')]);
  assert.equal(r.voidLegs, 1);
  assert.ok(Math.abs(r.prob - 0.40) < 1e-9, 'got ' + r.prob);
  assert.ok(r.prob > 0.20, 'the settled parlay is easier than the one we priced');
});

test('push counts as void (half-point pushes, DNB refunds)', () => {
  const r = f(0.30, [leg(0.6, 'push'), leg(0.5, 'lost')]);
  assert.equal(r.voidLegs, 1);
  assert.ok(Math.abs(r.prob - 0.5) < 1e-9);
});

test('cancel / refund wording also counts', () => {
  assert.equal(f(0.3, [leg(0.6, 'cancelled'), leg(0.5, 'won')]).voidLegs, 1);
  assert.equal(f(0.3, [leg(0.6, 'refund'), leg(0.5, 'won')]).voidLegs, 1);
});

test('two void legs both divide out', () => {
  // 0.5 * 0.5 * 0.4 = 0.10; two 0.5 legs void -> surviving 0.40
  const r = f(0.10, [leg(0.5, 'void'), leg(0.5, 'push'), leg(0.4, 'won')]);
  assert.equal(r.voidLegs, 2);
  assert.ok(Math.abs(r.prob - 0.40) < 1e-9, 'got ' + r.prob);
});

test('a void leg with no usable fairProb is counted but not divided out', () => {
  // can't safely divide by an unknown; leave the prob, still flag the void
  const r = f(0.20, [leg(null, 'void'), leg(0.4, 'won')]);
  assert.equal(r.voidLegs, 1);
  assert.equal(r.prob, 0.20);
});

test('the result is clamped below 1', () => {
  // dividing 0.9 by a tiny 0.05 fair would exceed 1
  const r = f(0.9, [leg(0.05, 'void'), leg(0.95, 'won')]);
  assert.ok(r.prob < 1 && r.prob > 0, 'got ' + r.prob);
});

test('unusable raw fair returns null', () => {
  assert.equal(f(0, [leg(0.5, 'void')]), null);
  assert.equal(f(1, [leg(0.5, 'void')]), null);
  assert.equal(f(NaN, [leg(0.5, 'void')]), null);
  assert.equal(f(0.3, []), null);
  assert.equal(f(0.3, null), null);
});

test('reproduces the measured direction of the artifact', () => {
  // On the real book, void tickets were concentrated in golf/soccer and the
  // adjustment always RAISES the model prob (makes the settled parlay look
  // more likely), which SHRINKS the apparent "bettors beat us" gap. Assert the
  // sign: adjusted >= raw whenever a leg voids.
  for (const legFair of [0.2, 0.35, 0.5, 0.7]) {
    const raw = 0.3;
    const r = f(raw, [leg(legFair, 'void'), leg(0.6, 'won')]);
    assert.ok(r.prob >= raw, `adjusted (${r.prob}) must be >= raw (${raw})`);
  }
});
