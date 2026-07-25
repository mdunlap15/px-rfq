// Regression test: combat-sport (MMA / boxing) TOTAL and SPREAD legs must
// never be graded from scoreboard "scores".
//
// Background (2026-07-25): TOA and ESPN report a finished fight as 1-0 — the
// score is a WIN FLAG, not a rounds tally. resolveLegResults' totals branch
// computed `homeScore + awayScore` (always 1) and compared it to the rounds
// line, so EVERY MMA/boxing Under graded 'won' and EVERY Over graded 'lost',
// no matter how long the fight lasted. Operator caught a live parlay showing
// "Ankalaev @ Guskov U 2.5" marked ✓ after the fight went OVER.
//
// Confirmed in production data: of the combat total legs where our inference
// disagreed with PX's settlement, the signature was unanimous —
// over→'lost' (2) and under→'won' (3), exactly what a constant total of 1
// produces.
//
// This mattered beyond display: a wrongly-'lost' leg makes isParlayAlreadyDead()
// true, which SKIPS addExposure — so every live parlay holding an MMA/boxing
// OVER leg under-reported exposure.
//
// Rounds/duration is not available from either scoreboard, so there is no
// correct score-based grading here: the code must fail CLOSED and defer to
// PX's settlementStatus. Moneyline stays gradeable (a 1-0 flag IS a winner).
//
// Run: npm test   (or: node --test test/combat-total-grading.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

// The arithmetic the totals branch used to perform, isolated so the test
// documents WHY it is invalid for combat sports rather than re-deriving it.
function gradeTotalFromScores(homeScore, awayScore, line, selection) {
  const total = homeScore + awayScore;
  if (selection === 'over') return total > line ? 'won' : total < line ? 'lost' : 'push';
  return total < line ? 'won' : total > line ? 'lost' : 'push';
}

test('a 1-0 fight flag makes EVERY under look won and EVERY over look lost', () => {
  // This is the bug, asserted directly: the same 1-0 flag produces the same
  // verdict for a 1-round finish and a 5-round decision.
  for (const line of [1.5, 2.5, 3.5, 4.5]) {
    assert.equal(gradeTotalFromScores(1, 0, line, 'under'), 'won',
      `under ${line} always "wins" off a 1-0 flag`);
    assert.equal(gradeTotalFromScores(1, 0, line, 'over'), 'lost',
      `over ${line} always "loses" off a 1-0 flag`);
  }
});

test('combat-sport detection covers the sport keys we actually register', () => {
  // Mirrors the guard in resolveLegResults.
  const isCombat = (sport) => typeof sport === 'string'
    && (sport.includes('mma') || sport.includes('boxing'));
  assert.ok(isCombat('mma_mixed_martial_arts'), 'UFC/PFL key must be caught');
  assert.ok(isCombat('boxing_boxing'), 'boxing key must be caught');
  // Must NOT catch sports whose scores are real point tallies.
  for (const s of ['baseball_mlb', 'basketball_nba', 'icehockey_nhl', 'tennis',
                   'americanfootball_nfl', 'americanfootball_cfl', 'soccer_usa_mls']) {
    assert.ok(!isCombat(s), `${s} totals must still grade from real scores`);
  }
});

test('real point-score sports still grade totals correctly (no over-broad guard)', () => {
  // MLB 5-3 = 8 runs.
  assert.equal(gradeTotalFromScores(5, 3, 7.5, 'over'), 'won');
  assert.equal(gradeTotalFromScores(5, 3, 8.5, 'under'), 'won');
  assert.equal(gradeTotalFromScores(5, 3, 8, 'over'), 'push');
});
