// Unfillable-within-cap gate (2026-08-13).
//
// THE BUG IT FIXES: max_risk on the wire is the BETTOR's stake cap (PX Rule 3),
// derived from our risk cap as risk * p/(1-p) — and the offer builder floors
// that at $1. So whenever our risk cap converts to a sub-$1 stake cap, the
// smallest stake PX can book ALREADY breaches our cap: we publish an offer we
// are mathematically certain to reject at confirm.
//
// MEASURED 2026-08-13 (the three rejects that prompted this): 3-leg HR-over
// parlays at +11048 and +14821 under a $50 prop cap. True stake cap $0.45,
// floored to $1, and a $1 stake at +11048 costs us $110. All three were
// quoted, accepted by the bettor, then rejected by us — advertise-and-decline
// (PX Rule 2) plus a wasted round trip.
//
// The gate declines these at QUOTE time. This file pins the arithmetic; the
// production wiring is a decline inside priceParlay's offer build.
//
// Run: npm test   (or: node --test test/unfillable-cap-gate.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');

// Mirror of the production rule: given our RISK cap and the offered implied
// prob, what stake cap goes on the wire, and is it fillable at PX's minimum?
function stakeCapFor(riskCap, offeredProb) {
  return riskCap * offeredProb / (1 - offeredProb);
}
function isUnfillable(riskCap, offeredProb, minStake = config.pricing.pxMinStake) {
  return riskCap > 0 && stakeCapFor(riskCap, offeredProb) < minStake;
}
// Our risk if PX books exactly minStake at these odds.
function riskAtMinStake(offeredProb, minStake = config.pricing.pxMinStake) {
  return minStake * (1 / offeredProb - 1);
}

test('config ships pxMinStake at the $1 wire floor the offer builder uses', () => {
  assert.equal(config.pricing.pxMinStake, 1);
});

test('the measured case: 3-leg HR-over at +11048 under a $50 cap is unfillable', () => {
  const p = 100 / (11048 + 100); // ≈ 0.897%
  const stakeCap = stakeCapFor(50, p);
  assert.ok(stakeCap < 1, `true stake cap must round below the $1 floor, got $${stakeCap.toFixed(2)}`);
  assert.ok(isUnfillable(50, p), 'must be declined at quote time');
  // And the reason it matters: the minimum bookable stake blows the cap ~2x.
  const risk = riskAtMinStake(p);
  assert.ok(risk > 100 && risk < 120, `a $1 stake should risk ~$110, got $${risk.toFixed(0)}`);
  assert.ok(risk > 50, 'the smallest possible fill already exceeds the $50 cap — hence the certain reject');
});

test('the same parlay is perfectly quotable once the cap is $3,000', () => {
  const p = 100 / (11048 + 100);
  assert.equal(isUnfillable(3000, p), false);
  assert.ok(stakeCapFor(3000, p) > 25, 'a $3K cap supports a real stake at +11048');
});

test('the gate is scoped to small-cap x long-odds, not ordinary flow', () => {
  // $3,000 prop cap: needs beyond +300000 to bite — i.e. never in practice.
  assert.equal(isUnfillable(3000, 100 / (50000 + 100)), false, '+50000 at a $3K cap is still fillable');
  // $15 experimental-SGP cap: starts biting past ~+1500, which is real.
  assert.equal(isUnfillable(15, 100 / (1000 + 100)), false, '+1000 at a $15 cap is fillable');
  assert.equal(isUnfillable(15, 100 / (2000 + 100)), true, '+2000 at a $15 cap is NOT');
  // Ordinary MLB/tennis prices are never touched at any sane cap.
  for (const odds of [-200, 100, 250, 600]) {
    const p = odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
    assert.equal(isUnfillable(50, p), false, `${odds} at a $50 cap must stay quotable`);
  }
});

test('a zero/absent cap disables the gate (cap 0 = uncapped)', () => {
  assert.equal(isUnfillable(0, 0.009), false);
});

test('the boundary is exact: stake cap == minStake still quotes', () => {
  // Choose p so the stake cap lands exactly on $1 for a $50 risk cap.
  const p = 1 / (1 + 50); // stakeCap = 50 * p/(1-p) = 1
  assert.ok(Math.abs(stakeCapFor(50, p) - 1) < 1e-9);
  assert.equal(isUnfillable(50, p), false, 'exactly-at-minimum must be allowed, not declined');
});
