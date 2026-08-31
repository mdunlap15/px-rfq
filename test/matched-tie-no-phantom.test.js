'use strict';

// Regression: an odds TIE on order.matched must never be promoted to a fill.
//
// PX broadcasts order.matched to EVERY SP that quoted, so a matched price
// equal to ours is NOT proof we won — another SP can take the same price
// first. recordMatchedParlay nonetheless promoted a bare tie to
// status='confirmed' and stamped confirmedOdds/confirmedStake. Because no
// order_uuid ever arrives for a parlay we did not win, those rows never
// settle: they sat in the book as permanent open "fills".
//
// Measured 2026-08-31 before the fix: 742 such rows since 6/1 carrying
// $88,363 of nominal risk we never held. 100% of them were inside
// ODDS_TIE_TOL — max |confirmed - offered| = 5, not one above it, with the
// distribution piling up at the tolerance boundary (delta 5: 232, delta 1:
// 79). They inflated fill counts by 10.9% overall and 42% of post-8/24
// "confirms", and the ghost-sweep had to chase each one afterwards to release
// exposure and flag meta.phantom.
//
// A tie that WAS ours is not lost: recordConfirmation reconciles
// 'tied_lost' -> 'won' when the orderUuid arrives.

const { test } = require('node:test');
const assert = require('node:assert');

const ot = require('../services/order-tracker');

const LEGS = [{ line_id: 'L-tie', team: 'X', market: 'spread', sport: 'baseball_mlb' }];

function quote(id, offeredOdds) {
  ot.recordQuote(id, LEGS, offeredOdds, 100, 0.4, {});
}
function read(id) {
  return ot.getRecentOrders(500).find((o) => (o.parlayId || o.parlay_id) === id) || null;
}

// matchedOdds is SP-side; bettor-side is its negation. offered is bettor-side.
// So to sit `delta` away from an offer of +150, pass -(150 + delta).
const spSideFor = (bettorOdds) => -bettorOdds;

test('a TIE without an orderUuid is NOT promoted to confirmed', () => {
  const id = 'tie-no-promote-1';
  quote(id, 150);
  const res = ot.recordMatchedParlay(id, spSideFor(153), 250, LEGS, null);

  assert.strictEqual(res.outcome, 'tied_lost', 'a tie we cannot claim is tied_lost');
  const o = read(id);
  assert.ok(o, 'order should still exist');
  assert.strictEqual(o.status, 'quoted', 'MUST stay quoted — this is the phantom generator');
  assert.ok(!o.confirmedOdds, 'must not stamp confirmedOdds');
  assert.ok(!o.confirmedStake, 'must not stamp confirmedStake');
  assert.ok(!o.confirmedAt, 'must not stamp confirmedAt');
});

test('the unclaimed tie is still recorded as diagnostics, not silently dropped', () => {
  const id = 'tie-diag-1';
  quote(id, 150);
  ot.recordMatchedParlay(id, spSideFor(154), 300, LEGS, null);
  const o = read(id);
  const d = o.meta && o.meta.matchedTieUnclaimed;
  assert.ok(d, 'must record matchedTieUnclaimed so the tie stays visible');
  assert.strictEqual(d.ourOfferedOdds, 150);
  assert.strictEqual(d.matchedOddsBettorSide, 154);
  assert.strictEqual(d.oddsDelta, 4, 'delta is bettor-side comparable');
  assert.strictEqual(d.matchedStake, 300);
});

test('every delta inside ODDS_TIE_TOL stays unpromoted — the whole 742 band', () => {
  // The observed phantoms spanned deltas 1..5 with none above 5. Pin the
  // entire band, not just one sample.
  for (const delta of [1, 2, 3, 4, 5]) {
    const id = 'tie-band-' + delta;
    quote(id, 200);
    const res = ot.recordMatchedParlay(id, spSideFor(200 + delta), 100, LEGS, null);
    assert.strictEqual(res.outcome, 'tied_lost', `delta ${delta} must be tied_lost`);
    assert.strictEqual(read(id).status, 'quoted', `delta ${delta} must not promote`);
  }
});

test('a CANONICAL win (orderUuid present) still promotes — fix must not break real fills', () => {
  const id = 'canonical-win-1';
  quote(id, 150);
  ot.recordFinalized(id, 'uuid-' + id, {});      // canonical signal arrives first
  const res = ot.recordMatchedParlay(id, spSideFor(152), 275, LEGS, null);

  assert.strictEqual(res.outcome, 'won', 'a canonical win is still a win');
  const o = read(id);
  assert.strictEqual(o.status, 'confirmed', 'a real fill MUST still be promoted');
  assert.ok(o.confirmedOdds != null, 'and must still carry confirmedOdds');
  assert.strictEqual(o.confirmedStake, 275);
  assert.ok(o.confirmedAt, 'and confirmedAt');
});

test('an already-confirmed order is treated as a canonical win', () => {
  // hasCanonicalWin also covers status==='confirmed' — a second matched
  // broadcast must not regress a real fill back to quoted.
  const id = 'already-confirmed-1';
  quote(id, 150);
  ot.recordConfirmation(id, 'uuid-' + id, 150, 100);
  const before = read(id).status;
  ot.recordMatchedParlay(id, spSideFor(151), 100, LEGS, null);
  assert.strictEqual(read(id).status, before, 'must not downgrade a confirmed order');
});

test('a NON-tie is other_sp and is still not promoted', () => {
  const id = 'other-sp-1';
  quote(id, 150);
  const res = ot.recordMatchedParlay(id, spSideFor(220), 400, LEGS, null);
  assert.strictEqual(res.outcome, 'other_sp', 'outbid by a different price');
  const o = read(id);
  assert.strictEqual(o.status, 'quoted');
  assert.ok(o.meta && o.meta.matchedByOtherSp, 'outbid diagnostics still recorded');
});

test('a REJECTED order is never resurrected by a tie', () => {
  const id = 'rejected-stays-1';
  quote(id, 150);
  const o0 = read(id);
  o0.status = 'rejected';
  o0.rejectionReason = 'max_risk';
  ot.recordMatchedParlay(id, spSideFor(151), 9999, LEGS, null);
  assert.strictEqual(read(id).status, 'rejected', 'our own limit decision must stand');
});
