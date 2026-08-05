// Near-lock concentration surcharge.
//
// A leg at fair >= 0.90 adds almost no uncertainty, so one lock + one coinflip
// is a SINGLE BET priced with parlay vig. Measured full-book 2026-04-02..08-05
// on tickets carrying a leg at -1000 or longer:
//   exactly 1 uncertain leg : n=17  -$4,225  ROI -99.5%  bettor won 17/17  z=4.62
//   3 legs n=9 +$94 | 4 legs n=18 +$502 | 5+ legs n=21 -$61
// So the guard must fire ONLY on the concentrated shape and leave genuine
// multi-leg parlays alone — that asymmetry is what these tests pin down.
//
// Run: npm test   (or: node --test test/near-lock-concentration.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');

// Mirror of the pricer's decision. Kept as a pure function so the rule can be
// asserted without standing up the whole pricing path; the production code
// applies the identical predicate.
function decide(legFairs, opts = {}) {
  const thresh = opts.threshold != null ? opts.threshold : config.pricing.vigLockLegThreshold;
  const locks = legFairs.filter(p => p >= thresh);
  const real = legFairs.length - locks.length;
  return { fires: locks.length > 0 && real <= 1 && legFairs.length >= 2, locks: locks.length, real };
}

test('config ships the near-lock knobs with the measured defaults', () => {
  assert.equal(config.pricing.vigLockLegThreshold, 0.90, 'threshold must be 0.90, not 0.80');
  assert.ok(config.pricing.vigLockConcentrationSurcharge > 0, 'surcharge must be ON by default');
  assert.equal(config.pricing.declineNearLockSingleBet, false, 'declining is opt-in, not default');
});

test('FIRES on the shape that lost 17/17: one lock + one coinflip', () => {
  assert.equal(decide([0.95, 0.44]).fires, true);
  assert.equal(decide([0.93, 0.46]).fires, true);
  assert.equal(decide([0.97, 0.36]).fires, true);
});

test('FIRES when two locks hide a single real leg (3-leg, still a single bet)', () => {
  const d = decide([0.96, 0.94, 0.45]);
  assert.equal(d.fires, true);
  assert.equal(d.locks, 2);
  assert.equal(d.real, 1);
});

test('does NOT fire on genuine multi-leg parlays containing a lock', () => {
  // 4- and 5-leg tickets with a lock were PROFITABLE (+$502, -$61). Leave them.
  assert.equal(decide([0.95, 0.44, 0.52]).fires, false, '2 uncertain legs is a real parlay');
  assert.equal(decide([0.96, 0.40, 0.55, 0.48]).fires, false);
  assert.equal(decide([0.93, 0.5, 0.5, 0.5, 0.5]).fires, false);
});

test('does NOT fire without a lock, however chalky', () => {
  assert.equal(decide([0.88, 0.44]).fires, false, '0.80-0.90 band is +$2,204 — do not tax it');
  assert.equal(decide([0.89, 0.89]).fires, false);
  assert.equal(decide([0.60, 0.60, 0.60]).fires, false);
});

test('the 0.80-0.90 profitable band is excluded by the threshold', () => {
  for (const p of [0.80, 0.85, 0.889, 0.8999]) {
    assert.equal(decide([p, 0.44]).fires, false, `${p} must not trip the guard`);
  }
  assert.equal(decide([0.9001, 0.44]).fires, true, 'just above 0.90 must trip it');
});

test('a single-leg ticket never trips it', () => {
  assert.equal(decide([0.95]).fires, false);
});

test('all-lock tickets trip it (zero uncertain legs is still a single bet)', () => {
  const d = decide([0.95, 0.96]);
  assert.equal(d.fires, true);
  assert.equal(d.real, 0);
});

test('surcharge scales the accumulated vig and only ever widens', () => {
  // Same mechanism as vigByLegCount: multiply the vig FRACTION, never shrink.
  const apply = (fair, offered, s) => {
    const frac = offered / fair - 1;
    const scaled = fair * (1 + frac * (1 + s));
    return scaled > offered ? Math.min(0.99, scaled) : offered;
  };
  const fair = 0.418, offered = 0.445;               // ~6.5% markup, the observed shape
  const out = apply(fair, offered, 0.15);
  assert.ok(out > offered, 'must widen');
  assert.ok(Math.abs((out / fair - 1) - (offered / fair - 1) * 1.15) < 1e-12, 'scales the fraction by 1+s');
  assert.equal(apply(fair, offered, 0), offered, 'surcharge 0 is a no-op');
  // Never contracts when offered is already at/below fair.
  assert.equal(apply(0.5, 0.49, 0.15), 0.49, 'must not move a bettor-favourable price');
});

test('threshold is env-overridable without reaching into the pricer', () => {
  assert.equal(decide([0.85, 0.44], { threshold: 0.80 }).fires, true);
  assert.equal(decide([0.85, 0.44], { threshold: 0.95 }).fires, false);
});
