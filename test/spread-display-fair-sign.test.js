// FAIR column on alt spread legs must show THAT line's fair, not the primary's.
//
// Live report 2026-08-22, parlay 01a02a90: a Dodgers +1.5 leg displayed FAIR
// -106 while Pinnacle/FD/DK showed -478/-520/-528 and our own offer was -374.
// Pricing was correct throughout (fairProb 0.7832); the dashboard was rendering
// displayFairProb 0.5156 -- the fair for Dodgers MINUS 1.5. The old check
// compared |cached| to |requested|, and |-1.5| === |+1.5|.

const test = require('node:test');
const assert = require('node:assert');
const oddsFeed = require('../services/odds-feed');

const SPORT = '__test_spread_sign';
const HOME = 'Los Angeles Dodgers', AWAY = 'Pittsburgh Pirates';
const START = new Date(Date.now() + 12 * 3600e3).toISOString();

// Primary run line is HOME -1.5 (Dodgers laying), with the +1.5 side carried
// in byLine, exactly as buildConsensusSpread writes it.
oddsFeed.__debugSetCache(SPORT, {
  fetchedAt: Date.now(),
  events: { [`${HOME.toLowerCase()}|${AWAY.toLowerCase()}`]: [{
    homeTeam: HOME, awayTeam: AWAY, commenceTime: START, eventId: 'sign-1',
    markets: {
      spreads: {
        line: -1.5,
        home: { point: -1.5, fairProb: 0.5156, displayFairProb: 0.5156 },
        away: { point: 1.5, fairProb: 0.4844, displayFairProb: 0.4844 },
        byLine: {
          'home|1.5': { line: 1.5, fairProb: 0.7832, displayFairProb: 0.7990 },
          'away|-1.5': { line: -1.5, fairProb: 0.2168, displayFairProb: 0.2010 },
        },
        books: 3,
      },
    },
  }] },
});

const disp = (sel, line) =>
  oddsFeed.getDisplayFairProb(SPORT, HOME, AWAY, 'spreads', sel, line, START);

test('home +1.5 does NOT return the home -1.5 fair', () => {
  const v = disp('home', 1.5);
  assert.notStrictEqual(v, 0.5156, 'returned the OPPOSITE run line — this is the reported bug');
  assert.strictEqual(v, 0.7990);
});

test('home -1.5 (the actual primary) still returns the primary fair', () => {
  assert.strictEqual(disp('home', -1.5), 0.5156);
});

test('away side resolves by its own signed line', () => {
  assert.strictEqual(disp('away', 1.5), 0.4844);   // away primary
  assert.strictEqual(disp('away', -1.5), 0.2010);  // away alt via byLine
});

test('a line with no byLine entry fails closed to a dash', () => {
  // Better an empty FAIR cell than a confidently wrong number.
  assert.strictEqual(disp('home', 2.5), null);
  assert.strictEqual(disp('away', 3.5), null);
});

test('the displayed fair is directionally sane vs the books', () => {
  // Dodgers +1.5 must be a big favourite (books -478/-520/-528 ~ 83%), and
  // Dodgers -1.5 near a coin flip. If these ever invert, the sign handling
  // has regressed.
  const plus = disp('home', 1.5), minus = disp('home', -1.5);
  assert.ok(plus > 0.7, `+1.5 should be a heavy favourite, got ${plus}`);
  assert.ok(minus < 0.6, `-1.5 should be near even, got ${minus}`);
  assert.ok(plus > minus);
});
