// Regression: the equal-price ("tie") test must normalise sign conventions.
//
// PX sends order.matched `matched_odds` SP-SIDE, while our own `offeredOdds`
// is BETTOR-SIDE. Comparing them directly made a genuine tie compute as ~-2x
// the price, so `oddsTie` was never true: `tied_lost` was unreachable (2 rows
// all-time, both artifacts) and the tie-break diagnostic sat at n=0 forever,
// while ~2,690 of our OWN wins per 30d were mislabelled `other_sp`.
//
// Real production values (2026-08-03), from meta.matchedByOtherSp:
//     ourOffered=285   raw matchedOdds=-285   old delta=-570
//     ourOffered=2364  raw matchedOdds=-2364  old delta=-4728
// All of those were EXACT ties once normalised.
//
// Run: npm test   (or: node --test test/odds-tie-sign.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { __isOddsTie: isOddsTie, __toBettorSideOdds: toBettorSide } = require('../services/order-tracker');

// Helper mirroring the live call site: raw SP-side in, tie decision out.
const liveTie = (rawMatched, offered) => isOddsTie(toBettorSide(rawMatched), offered);

test('raw SP-side odds normalise to bettor-side', () => {
  assert.equal(toBettorSide(-285), 285);
  assert.equal(toBettorSide(2364), -2364);
  assert.equal(toBettorSide(null), null);
});

test('exact production ties are recognised (the reported bug)', () => {
  // Each pair is a real row that was mislabelled `other_sp` before the fix.
  for (const [raw, offered] of [[-285, 285], [-162, 162], [-2364, 2364], [-12029, 12029], [-5070, 5070]]) {
    assert.ok(liveTie(raw, offered), `raw ${raw} vs offered ${offered} must be a tie`);
  }
});

test('the OLD live formula would have missed every one of them', () => {
  // Documents the defect: |raw - offered| never lands inside the tolerance.
  for (const [raw, offered] of [[-285, 285], [-2364, 2364]]) {
    assert.ok(Math.abs(raw - offered) > 5, 'old formula gives ~2x the price, not ~0');
  }
});

test('a genuine outbid is NOT a tie', () => {
  // We offered +573, another SP won at +780 (bettor-side) -> raw -780.
  assert.equal(liveTie(-780, 573), false);
  assert.equal(liveTie(-320, 302), false);
  assert.equal(liveTie(-2500, 2163), false);
});

test('tolerance absorbs small PX drift but not real gaps', () => {
  assert.ok(liveTie(-290, 285), '5 points apart = still a tie');
  assert.equal(liveTie(-291, 285), false, '6 points apart = not a tie');
});

test('opposite-sign prices are not treated as ties', () => {
  // +100 and -100 are DIFFERENT prices; the old backfill formula called this a
  // tie, which produced the only 2 tied_lost rows that ever existed.
  assert.equal(isOddsTie(-100, 100), false);
});

test('negative (favourite) prices work in both directions', () => {
  // We offered -150; winner also -150 -> raw +150.
  assert.ok(liveTie(150, -150));
  // Winner at -130 vs our -150 is a real loss, not a tie.
  assert.equal(liveTie(130, -150), false);
});

test('null / non-finite inputs never claim a tie', () => {
  assert.equal(isOddsTie(null, 285), false);
  assert.equal(isOddsTie(285, null), false);
  assert.equal(isOddsTie(NaN, 285), false);
  assert.equal(isOddsTie(undefined, undefined), false);
  assert.equal(liveTie(null, 285), false);
});

test('backfill path compares bettor-side values directly', () => {
  // entry.matchedAmericanOdds is ALREADY bettor-side (db.js round-trips it),
  // so it compares straight against offeredOdds — no negation, no addition.
  assert.ok(isOddsTie(285, 285), 'stored +285 vs offered +285 is a tie');
  assert.equal(isOddsTie(780, 573), false, 'stored +780 vs offered +573 is a loss');
});
