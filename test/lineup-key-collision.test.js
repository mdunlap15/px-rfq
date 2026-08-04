// Lineup cache keying — the 2026-08-04 fill outage.
//
// The cache used to key on `${eventKey}|${YYYY-MM-DD}`. An ET evening game
// rolls into the NEXT UTC date, so it shared a key with the following
// afternoon's game against the same opponent. Both games wrote every refresh,
// each overwriting the other's pitchers, which scored as a lineup change and
// re-armed the 3-minute decline grace forever. Three marquee MLB games sat in
// grace for 13.7 hours and we passed on $80.8K of matched volume in 3 hours.
//
// Run: npm test   (or: node --test test/lineup-key-collision.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const of = require('../services/odds-feed');

const MLB = 'baseball_mlb';
const upd = (...a) => of.__updateLineupState(MLB, ...a);
const fresh = (h, a, t) => of.checkLineupFreshness(MLB, h, a, t);
const reset = () => of.__resetLineupCache();

// The exact pair that wedged production.
const HOME = 'Chicago Cubs', AWAY = 'Los Angeles Dodgers';
const GAME1 = '2026-08-05T00:06:00Z';   // tonight, ET evening -> next UTC date
const GAME2 = '2026-08-05T18:21:00Z';   // tomorrow afternoon, SAME UTC date

test('the two games of a series do NOT share a cache entry', () => {
  reset();
  upd(HOME, AWAY, GAME1, 'Javier Assad', 'Tarik Skubal');
  upd(HOME, AWAY, GAME2, 'Shota Imanaga', 'Eric Lauer');
  const keys = Object.keys(of.getLineupCache()[MLB]);
  assert.equal(keys.length, 2, 'each game needs its own key, got: ' + keys.join(' , '));
});

test('writing both games repeatedly never fires a lineup change', () => {
  reset();
  // Simulate many odds refreshes, each writing BOTH games (this is exactly
  // what the refresh loop does: it iterates every event in the map).
  for (let i = 0; i < 25; i++) {
    upd(HOME, AWAY, GAME1, 'Javier Assad', 'Tarik Skubal');
    upd(HOME, AWAY, GAME2, 'Shota Imanaga', 'Eric Lauer');
  }
  assert.equal(fresh(HOME, AWAY, GAME1), null, 'game 1 must not be in grace');
  assert.equal(fresh(HOME, AWAY, GAME2), null, 'game 2 must not be in grace');
  const entries = Object.values(of.getLineupCache()[MLB]);
  assert.ok(entries.every(e => e.lastChangeAt === null), 'no entry should have a change stamp');
});

test('each game keeps its OWN starters, not the other game\'s', () => {
  reset();
  upd(HOME, AWAY, GAME1, 'Javier Assad', 'Tarik Skubal');
  upd(HOME, AWAY, GAME2, 'Shota Imanaga', 'Eric Lauer');
  assert.equal(of.getPitcherSide(MLB, HOME, AWAY, GAME1, 'Javier Assad'), 'home');
  assert.equal(of.getPitcherSide(MLB, HOME, AWAY, GAME2, 'Shota Imanaga'), 'home');
  // Game 2's pitcher must NOT resolve against game 1.
  assert.equal(of.getPitcherSide(MLB, HOME, AWAY, GAME1, 'Shota Imanaga'), null);
});

test('a source with NO starter data cannot blank a known starter', () => {
  reset();
  upd(HOME, AWAY, GAME1, 'Javier Assad', 'Tarik Skubal');
  // The odds-feed writer runs for MLB but extractStarter finds nothing in a
  // bare TOA "Chicago Cubs" string, so it contributes null for every game.
  upd(HOME, AWAY, GAME1, null, null);
  assert.equal(fresh(HOME, AWAY, GAME1), null, 'null from a source gap is not a scratch');
  const e = Object.values(of.getLineupCache()[MLB])[0];
  assert.equal(e.homeStarter, 'Javier Assad', 'known starter must survive a null write');
  assert.equal(e.awayStarter, 'Tarik Skubal');
});

test('alternating real and null writes never re-arms the grace', () => {
  reset();
  for (let i = 0; i < 25; i++) {
    upd(HOME, AWAY, GAME1, 'Shota Imanaga', 'Eric Lauer');  // StatsAPI
    upd(HOME, AWAY, GAME1, null, null);                      // odds feed on TOA
  }
  assert.equal(fresh(HOME, AWAY, GAME1), null);
});

test('a REAL starter swap is still detected and still declines', () => {
  reset();
  upd(HOME, AWAY, GAME1, 'Javier Assad', 'Tarik Skubal');
  upd(HOME, AWAY, GAME1, 'Shota Imanaga', 'Tarik Skubal');   // genuine scratch
  const st = fresh(HOME, AWAY, GAME1);
  assert.ok(st && st.changed, 'a real swap must still trip the guard');
  assert.match(st.detail, /Javier Assad → Shota Imanaga/);
});

test('a first-time starter fill is not treated as a swap', () => {
  reset();
  upd(HOME, AWAY, GAME1, null, null);
  upd(HOME, AWAY, GAME1, 'Shota Imanaga', 'Eric Lauer');
  assert.equal(fresh(HOME, AWAY, GAME1), null, 'null -> name is a first fill, not a change');
});

test('two writers whose start times differ by minutes hit the SAME game', () => {
  reset();
  // odds feed says 00:06Z, MLB StatsAPI says 00:10Z for the same game.
  upd(HOME, AWAY, '2026-08-05T00:06:00Z', 'Shota Imanaga', 'Eric Lauer');
  upd(HOME, AWAY, '2026-08-05T00:10:00Z', 'Shota Imanaga', 'Eric Lauer');
  assert.equal(Object.keys(of.getLineupCache()[MLB]).length, 1, 'minor jitter must not split a game');
  assert.equal(fresh(HOME, AWAY, '2026-08-05T00:06:00Z'), null);
});

test('a doubleheader (~3h apart) still gets two entries', () => {
  reset();
  upd(HOME, AWAY, '2026-08-05T17:05:00Z', 'Pitcher One', 'Pitcher Two');
  upd(HOME, AWAY, '2026-08-05T20:40:00Z', 'Pitcher Three', 'Pitcher Four');
  assert.equal(Object.keys(of.getLineupCache()[MLB]).length, 2);
  assert.equal(fresh(HOME, AWAY, '2026-08-05T17:05:00Z'), null);
  assert.equal(fresh(HOME, AWAY, '2026-08-05T20:40:00Z'), null);
});

test('different team pairs never collide', () => {
  reset();
  upd('Houston Astros', 'Toronto Blue Jays', GAME1, 'Hunter Brown', 'Dylan Cease');
  upd(HOME, AWAY, GAME1, 'Shota Imanaga', 'Eric Lauer');
  assert.equal(Object.keys(of.getLineupCache()[MLB]).length, 2);
  assert.equal(fresh(HOME, AWAY, GAME1), null);
  assert.equal(fresh('Houston Astros', 'Toronto Blue Jays', GAME1), null);
});
