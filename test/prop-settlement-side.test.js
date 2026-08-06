// prop-settlement._settleLeg must grade the SIDE the counterparty took.
//
// It used to hardcode `val >= need`, i.e. it graded every leg as an OVER — so
// parlay_won came out inverted for every UNDER leg (~6.5% of hitter props) and
// /prop-correlation was fed the opposite of truth for them. On the half-point
// lines props almost always carry, over and under are exact complements, so
// under-win is simply !over-win.
//
// Run: npm test   (or: node --test test/prop-settlement-side.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const ps = require('../services/prop-settlement');
const settle = ps.__settleLeg;

// One box-score index: Aaron Judge hit 1 HR / 2 H / 4 TB / 3 RBI.
const IDX = [{ 'aaron judge': { HR: 1, H: 2, TB: 4, RBI: 3, gamePk: 777, team: 'NYY' } }];
const leg = (o) => Object.assign({ team: 'Aaron Judge', propType: 'hitter_hr', line: 0.5, selection: 'over' }, o);

test('an OVER that hits wins (unchanged behaviour)', () => {
  const r = settle(leg({ propType: 'hitter_hr', line: 0.5, selection: 'over' }), IDX);
  assert.equal(r.win, true);   // 1 HR >= 1
  assert.equal(r.side, 'over');
  assert.equal(r.sideKnown, true);
});

test('an UNDER on the SAME outcome is the exact complement', () => {
  const over = settle(leg({ propType: 'hitter_hr', line: 0.5, selection: 'over' }), IDX);
  const under = settle(leg({ propType: 'hitter_hr', line: 0.5, selection: 'under' }), IDX);
  assert.equal(over.win, true);
  assert.equal(under.win, false, 'under 0.5 HR must LOSE when he hit one — this is the bug');
  assert.equal(under.side, 'under');
});

test('an UNDER that hits wins', () => {
  // Judge had 2 hits; under 2.5 hits => 2 < 3 => win
  const r = settle(leg({ propType: 'hitter_hits', line: 2.5, selection: 'under' }), IDX);
  assert.equal(r.win, true);
  assert.equal(r.side, 'under');
});

test('an UNDER that busts loses', () => {
  // Judge had 4 total bases; under 3.5 TB => 4 < 4 is false => lose
  const r = settle(leg({ propType: 'hitter_total_bases', line: 3.5, selection: 'under' }), IDX);
  assert.equal(r.win, false);
});

test('"yes" grades as over, "no" grades as under (anytime-prop wording)', () => {
  assert.equal(settle(leg({ propType: 'hitter_hr', line: 0.5, selection: 'yes' }), IDX).win, true);
  assert.equal(settle(leg({ propType: 'hitter_hr', line: 0.5, selection: 'no' }), IDX).win, false);
  assert.equal(settle(leg({ propType: 'hitter_hr', line: 0.5, selection: 'no' }), IDX).side, 'under');
});

test('absent selection assumes OVER and flags sideKnown=false', () => {
  // Legacy matched_parlays rows carry no selection. Assume the dominant side
  // but mark it so calibration can exclude guessed rows.
  const r = settle(leg({ propType: 'hitter_hr', line: 0.5, selection: undefined }), IDX);
  assert.equal(r.win, true, 'assumed over');
  assert.equal(r.side, 'over');
  assert.equal(r.sideKnown, false, 'must flag that the side was guessed');
});

test('an integer-line exact match is a push, not a silent win/loss', () => {
  // Judge had exactly 2 hits; over 2 (integer) is a push.
  const r = settle(leg({ propType: 'hitter_hits', line: 2, selection: 'over' }), IDX);
  assert.equal(r.push, true);
  assert.equal(r.win, false, 'a push is not a win');
});

test('a non-hitter prop returns null (out of scope)', () => {
  assert.equal(settle(leg({ propType: 'pitcher_strikeouts', line: 5.5 }), IDX), null);
});

test('an unknown player returns null rather than guessing', () => {
  assert.equal(settle(leg({ team: 'Nobody Here', propType: 'hitter_hr', line: 0.5 }), IDX), null);
});
