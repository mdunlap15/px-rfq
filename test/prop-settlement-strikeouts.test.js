// Strikeout legs must settle, and partially-graded tickets must not corrupt the
// correlation table.
//
// Until 2026-08-23 prop_settlements held 15,674 rows and ZERO strikeout legs:
// box-score.js had understood pitcher K all along, but this job's allowlist
// excluded them — so the leg-level calibration could not look at the one family
// whose ticket-level P&L was soft. Three separate things had to be true before a
// K leg could grade, and each is locked below.

const test = require('node:test');
const assert = require('node:assert');
const ps = require('../services/prop-settlement');

// One index entry per player, shaped as _buildDateIndex writes it.
const IDX = {
  'chris paddack': { gamePk: 1, team: 10, K: 7 },              // pitcher, never bats
  'pete alonso': { gamePk: 1, team: 11, H: 2, HR: 1, RBI: 3, TB: 5 },
  'shohei ohtani': { gamePk: 1, team: 12, H: 1, HR: 0, RBI: 0, TB: 1, K: 9 }, // two-way
};
const leg = (o) => Object.assign({ sport: 'baseball_mlb', selection: 'over' }, o);

test('propType canonicalises player_strikeouts -> pitcher_strikeouts', () => {
  // matched_parlays K legs carry propType:null, so the generic player_ strip
  // yields "strikeouts" while every other consumer keys on "pitcher_strikeouts".
  // Miss this and the allowlist silently never matches.
  assert.strictEqual(ps.__propType({ market: 'player_strikeouts', propType: null }), 'pitcher_strikeouts');
  assert.strictEqual(ps.__propType({ market: 'player_hitter_hr', propType: null }), 'hitter_hr');
  assert.strictEqual(ps.__propType({ propType: 'hitter_hits' }), 'hitter_hits');
});

test('a strikeout OVER grades off the pitching line', () => {
  const r = ps.__settleLeg(leg({ market: 'player_strikeouts', team: 'Chris Paddack', line: 4.5 }), [IDX]);
  assert.ok(r, 'pitcher must be gradeable');
  assert.strictEqual(r.val, 7);
  assert.strictEqual(r.win, true);   // 7 >= 5
});

test('a strikeout UNDER is the complement, not a second over', () => {
  const r = ps.__settleLeg(
    leg({ market: 'player_strikeouts', team: 'Chris Paddack', line: 4.5, selection: 'under' }), [IDX]);
  assert.strictEqual(r.side, 'under');
  assert.strictEqual(r.win, false);  // 7 Ks: the under loses
});

test('an integer strikeout line pushes rather than winning', () => {
  const r = ps.__settleLeg(leg({ market: 'player_strikeouts', team: 'Chris Paddack', line: 7 }), [IDX]);
  assert.strictEqual(r.push, true);
  assert.strictEqual(r.win, false);
});

test('a two-way player is graded on Ks THROWN, not Ks taken at the plate', () => {
  // bat.strikeOuts and pit.strikeOuts are different stats sharing a name. Reading
  // the batting field would grade every K prop off the wrong number.
  const r = ps.__settleLeg(leg({ market: 'player_strikeouts', team: 'Shohei Ohtani', line: 6.5 }), [IDX]);
  assert.strictEqual(r.val, 9, 'must read pitching K');
  // ...and his hitter props still resolve off the batting line.
  const h = ps.__settleLeg(leg({ market: 'player_hitter_hr', team: 'Shohei Ohtani', line: 0.5 }), [IDX]);
  assert.strictEqual(h.val, 0);
  assert.strictEqual(h.win, false);
});

test('a K leg for a position player who never pitched is ungradeable, not a false 0', () => {
  // Alonso is in the index with no K field. Grading him at 0 would score the
  // under as a win on a game he never pitched.
  const r = ps.__settleLeg(leg({ market: 'player_strikeouts', team: 'Pete Alonso', line: 4.5 }), [IDX]);
  assert.strictEqual(r, null);
});

test('a K leg falls through to the next date index instead of failing closed', () => {
  // Doubleheaders and late finals mean the right box score may be in the
  // adjacent day's index. A name hit with no K must keep looking.
  const stale = { 'chris paddack': { gamePk: 99, team: 10, H: 0 } }; // batting-only row
  const r = ps.__settleLeg(leg({ market: 'player_strikeouts', team: 'Chris Paddack', line: 4.5 }), [stale, IDX]);
  assert.ok(r, 'should resolve from the second index');
  assert.strictEqual(r.val, 7);
});

test('hitter families still grade exactly as before', () => {
  const hr = ps.__settleLeg(leg({ market: 'player_hitter_hr', team: 'Pete Alonso', line: 0.5 }), [IDX]);
  assert.strictEqual(hr.win, true);
  const tb = ps.__settleLeg(leg({ market: 'player_hitter_total_bases', team: 'Pete Alonso', line: 5.5 }), [IDX]);
  assert.strictEqual(tb.win, false); // 5 TB vs need 6
  const rbi = ps.__settleLeg(leg({ market: 'player_hitter_rbi_runs', team: 'Pete Alonso', line: 2.5 }), [IDX]);
  assert.strictEqual(rbi.win, true);
});

test('a non-gradeable market is still refused outright', () => {
  assert.strictEqual(ps.__settleLeg(leg({ market: 'moneyline', team: 'Pete Alonso', line: null }), [IDX]), null);
});
