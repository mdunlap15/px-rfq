// Regression tests: same-tournament golf legs must be priced as CORRELATED.
//
// Root cause of July 2026's entire loss. Golf matchups cost -$8,299 that month
// while the rest of the book made money (July excluding golf: +$1,758). Golf
// legs sit on separate pxEventIds, so every same-game correlation gate treats
// them as independent and multiplies — but 310 of 310 multi-golf tickets shared
// ONE tournament. Same course, same weather, same wave: positively correlated,
// so the true parlay probability is HIGHER than the product and we were
// systematically overpricing our own edge.
//
// Measured (predicted SP win% vs actual, all months):
//   1 leg  76.0% -> 72.5%  (z -0.55)
//   2 legs 73.4% -> 67.1%  (z -1.69)
//   3 legs 87.1% -> 64.0%  (z -4.88)  <- 23pp miss, not variance
//   4 legs 93.2% -> 84.4%  (z -1.98)
//
// Run: npm test   (or: node --test test/golf-correlation.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');

// Mirrors the grouping + compounding in priceParlay.
// MATCHUPS ONLY since 2026-08-11: outright parlays are operator-directed
// pure DK-mirror pricing ("no changes"), and different players' outrights
// are NEGATIVELY correlated (finite winner/top-N slots) — independent
// multiplication already overstates the bettor's joint there.
function golfFactor(legs, perLeg, cap) {
  const byTournament = {};
  for (const l of legs) {
    const sport = String(l.sport || '');
    if (sport !== 'golf_matchups') continue;
    const key = String(l.tournamentName || l.pxEventName || sport).toLowerCase().trim();
    byTournament[key] = (byTournament[key] || 0) + 1;
  }
  let f = 1;
  for (const n of Object.values(byTournament)) if (n >= 2) f *= Math.pow(perLeg, n - 1);
  return Math.min(f, cap);
}
const P = () => config.pricing.golfSameTournamentCorrelation;
const C = () => config.pricing.golfSameTournamentCorrelationCap;
const g = (t) => ({ sport: 'golf_matchups', tournamentName: t });
const o = (t) => ({ sport: 'golf_outrights', tournamentName: t });
const mlb = () => ({ sport: 'baseball_mlb' });

test('a single golf leg is NOT correlated with itself', () => {
  assert.equal(golfFactor([g('Rocket Classic'), mlb(), mlb()], P(), C()), 1);
});

test('two legs in the SAME tournament are correlated', () => {
  const f = golfFactor([g('Rocket Classic'), g('Rocket Classic')], P(), C());
  assert.ok(f > 1, 'must raise the fair probability');
  assert.ok(Math.abs(f - P()) < 1e-9, `expected ${P()}, got ${f}`);
});

test('the factor compounds with each extra same-tournament leg', () => {
  const two = golfFactor([g('RC'), g('RC')], P(), C());
  const three = golfFactor([g('RC'), g('RC'), g('RC')], P(), C());
  const four = golfFactor([g('RC'), g('RC'), g('RC'), g('RC')], P(), C());
  assert.ok(three > two && four > three, 'must grow with leg count — that is the measured signature');
  assert.ok(Math.abs(three - Math.pow(P(), 2)) < 1e-9);
});

test('legs in DIFFERENT tournaments are not cross-correlated', () => {
  // Two pairs: each pair correlated internally, pairs independent of each other.
  const f = golfFactor([g('Rocket Classic'), g('Rocket Classic'), g('Utah Championship'), g('Utah Championship')], P(), C());
  assert.ok(Math.abs(f - Math.pow(P(), 2)) < 1e-9, 'two separate pairs = perLeg^2, not perLeg^3');
  // One leg in each of two tournaments = no correlation at all.
  assert.equal(golfFactor([g('Rocket Classic'), g('Utah Championship')], P(), C()), 1);
});

test('OUTRIGHTS are EXCLUDED from the factor (2026-08-11: mirror pricing + negative cross-player correlation)', () => {
  const f = golfFactor([o('Rocket Classic'), o('Rocket Classic')], P(), C());
  assert.equal(f, 1, 'outright parlays keep pure DK-mirror pricing — no correlation boost');
  // Matchup + outright: only the matchup leg counts, one leg = no factor.
  assert.equal(golfFactor([g('RC'), o('RC')], P(), C()), 1);
  // Two matchups + one outright: the matchup PAIR still fires.
  assert.ok(golfFactor([g('RC'), g('RC'), o('RC')], P(), C()) > 1);
});

test('non-golf legs never trigger it', () => {
  assert.equal(golfFactor([mlb(), mlb(), mlb()], P(), C()), 1);
});

test('the compounded factor is capped', () => {
  const many = Array.from({ length: 12 }, () => g('Rocket Classic'));
  assert.ok(golfFactor(many, P(), C()) <= C(), 'must not extrapolate past the cap');
});

test('correlation RAISES the bettor fair prob, i.e. LOWERS our edge estimate', () => {
  // A 3-leg coinflip golf ticket: naive 12.5%, corrected must be higher.
  const f = golfFactor([g('RC'), g('RC'), g('RC')], P(), C());
  const naive = 0.5 ** 3;
  assert.ok(naive * f > naive, 'the whole point: bettors hit these more often than independence implies');
});
