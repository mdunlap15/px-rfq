'use strict';

// College team-name matching (2026-09-06).
//
// PX names a college team by SCHOOL alone ("Oregon"); The Odds API appends the
// mascot ("Oregon Ducks"). Substring containment then collides, because one
// school's name is a prefix of another's:
//
//   "Oregon"  -> Oregon Ducks | Oregon State Beavers            (2 candidates)
//   "Alabama" -> Alabama Crimson Tide | South Alabama Jaguars   (2)
//   "Texas"   -> Longhorns | A&M | State | Tech | North Texas   (5)
//
// matchTeamName's ambiguity guard correctly refuses to guess, so the event goes
// dark. MEASURED against the live TOA board: 12 of 48 PX College Football
// events were unmatchable this way — Oklahoma at Michigan, Ohio State at Texas,
// Alabama at Kentucky among them — and event_match_gap was the single largest
// category of CFB decline volume (150,926 instances over three days).
//
// The fix is two rules, college-only:
//   ANCHORING          — one name must be a WORD-BOUNDED prefix of the other
//   SHORTEST REMAINDER — fewest leftover words wins; a tie still fails closed
//
// Anchoring also closes a hole in the OTHER direction. With the correct school
// absent from the board, "Houston" was the sole substring match for "Sam
// Houston State Bearkats" — one candidate, so the ambiguity guard never fired
// and we would have priced a different school's game.

const test = require('node:test');
const assert = require('node:assert');

const lm = require('../services/line-manager');
const M = lm.matchTeamName;
const NCAAF = 'americanfootball_ncaaf';

// The live TOA board, 2026-09-06.
const BOARD = [
  'Alabama Crimson Tide', 'South Alabama Jaguars',
  'Oregon Ducks', 'Oregon State Beavers',
  'Ohio Bobcats', 'Ohio State Buckeyes',
  'Texas Longhorns', 'Texas A&M Aggies', 'Texas State Bobcats',
  'Texas Tech Red Raiders', 'North Texas Mean Green',
  'Michigan Wolverines', 'Michigan State Spartans', 'Eastern Michigan Eagles',
  'Georgia Bulldogs', 'Georgia State Panthers', 'Georgia Tech Yellow Jackets',
  'Georgia Southern Eagles',
  'East Carolina Pirates', 'Boise State Broncos', 'Nebraska Cornhuskers',
  'Sam Houston State Bearkats',
];

test('a bare school name resolves to its own program, not a longer one', () => {
  for (const [px, want] of [
    ['Alabama', 'Alabama Crimson Tide'],
    ['Oregon', 'Oregon Ducks'],
    ['Ohio', 'Ohio Bobcats'],
    ['Texas', 'Texas Longhorns'],
    ['Michigan', 'Michigan Wolverines'],
    ['Georgia', 'Georgia Bulldogs'],
  ]) {
    assert.strictEqual(M(px, BOARD, NCAAF), want, `${px} must resolve to ${want}`);
  }
});

test('the longer school still resolves to itself', () => {
  // The rule must not collapse "Oregon State" into "Oregon Ducks".
  for (const [px, want] of [
    ['Oregon State', 'Oregon State Beavers'],
    ['Ohio State', 'Ohio State Buckeyes'],
    ['Texas State', 'Texas State Bobcats'],
    ['Texas Tech', 'Texas Tech Red Raiders'],
    ['Michigan State', 'Michigan State Spartans'],
    ['Georgia Tech', 'Georgia Tech Yellow Jackets'],
  ]) {
    assert.strictEqual(M(px, BOARD, NCAAF), want, `${px} must resolve to ${want}`);
  }
});

test('unambiguous schools are unaffected', () => {
  assert.strictEqual(M('East Carolina', BOARD, NCAAF), 'East Carolina Pirates');
  assert.strictEqual(M('Boise State', BOARD, NCAAF), 'Boise State Broncos');
  assert.strictEqual(M('Nebraska', BOARD, NCAAF), 'Nebraska Cornhuskers');
});

test('an UNANCHORED lone candidate is REFUSED, not accepted', () => {
  // The wrong-school hole. "Houston" is contained in "Sam Houston State
  // Bearkats" but is not a prefix of it. Exactly one substring candidate, so
  // the old ambiguity guard passed it straight through.
  assert.strictEqual(M('Houston', BOARD, NCAAF), null,
    'Houston must not bind to Sam Houston State');
  // ...and a school that is genuinely absent stays absent.
  assert.strictEqual(M('Connecticut', BOARD, NCAAF), null);
});

test('a genuine tie on remainder length still fails closed', () => {
  const pool = ['Carolina Panthers', 'Carolina Hurricanes'];
  assert.strictEqual(M('Carolina', pool, NCAAF), null,
    'two anchored candidates with equal remainder are ambiguous');
});

test('exact matches short-circuit regardless of sport', () => {
  assert.strictEqual(M('Oregon Ducks', BOARD, NCAAF), 'Oregon Ducks');
});

// --------------------------------------------------------- pro regression
//
// Anchoring must NOT apply without a college sport key: several sports supply
// a bare MASCOT ("Cardinals"), which is a suffix rather than a prefix and
// matches perfectly well under the existing rules.

const PRO = ['Arizona Cardinals', 'Carolina Panthers', 'Boston Red Sox',
  'Chicago White Sox', 'New York Yankees', 'New York Mets', 'Inter Miami CF'];

test('pro matching is unchanged when no sport key is passed', () => {
  assert.strictEqual(M('Cardinals', PRO), 'Arizona Cardinals');
  assert.strictEqual(M('Red Sox', PRO), 'Boston Red Sox');
  assert.strictEqual(M('White Sox', PRO), 'Chicago White Sox');
  assert.strictEqual(M('Inter Miami', PRO), 'Inter Miami CF');
});

test('pro ambiguity still fails closed', () => {
  assert.strictEqual(M('New York', PRO), null, 'Yankees vs Mets stays ambiguous');
});

test('a non-college sport key does not enable anchoring', () => {
  assert.strictEqual(M('Cardinals', PRO, 'baseball_mlb'), 'Arizona Cardinals',
    'anchoring must be scoped to ncaa* only');
});

// ------------------------------------------------------- rivalry via side

test('resolveHomeAwaySide handles a same-prefix rivalry', () => {
  if (typeof lm.resolveHomeAwaySide !== 'function') return; // not exported
  assert.strictEqual(
    lm.resolveHomeAwaySide('Oregon', 'Oregon Ducks', 'Oregon State Beavers'), 'home');
  assert.strictEqual(
    lm.resolveHomeAwaySide('Oregon State', 'Oregon Ducks', 'Oregon State Beavers'), 'away');
  // and a real tie is still refused
  assert.strictEqual(
    lm.resolveHomeAwaySide('New York', 'New York Yankees', 'New York Mets'), null);
});
