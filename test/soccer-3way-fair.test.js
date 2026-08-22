// The h2h_3way selection routing in getFairProb.
//
// This is the layer where a mistake costs ~17pp: PX posts each 3-way outcome
// as its own YES/NO market, and the fair must come from the TRUE 3-way board
// (home/draw/away summing to 1), never from markets.h2h, which is a
// draw-no-bet basis -- P(home | no draw), materially higher than P(home).
//
// Measured live 2026-08-22 (Man Utd @ Hull City): 3-way home 9.51% vs DNB home
// 12.77% on the same match.

const test = require('node:test');
const assert = require('node:assert');
const oddsFeed = require('../services/odds-feed');

const SPORT = '__test_soccer_3way';
const HOME = 'Hull City', AWAY = 'Manchester United';
const START = new Date(Date.now() + 48 * 3600e3).toISOString();

// Both bases installed on ONE event, exactly as the ingest writes them, so a
// test can prove the two are not confused for each other.
// The cache keys events by "home|away" (lowercased) and maps to an ARRAY,
// which is how doubleheaders are held. Matching that shape exactly matters:
// a plausible-looking flat array silently resolves to no event and every
// lookup returns null, which would make these tests vacuously "pass" if they
// asserted only on nulls.
oddsFeed.__debugSetCache(SPORT, {
  fetchedAt: Date.now(),
  events: { [`${HOME.toLowerCase()}|${AWAY.toLowerCase()}`]: [{
    homeTeam: HOME, awayTeam: AWAY, commenceTime: START, eventId: 'test-3way-1',
    markets: {
      h2h: { home: { fairProb: 0.1277 }, away: { fairProb: 0.8723 }, books: 3 },
      h2h_3way: {
        home: { fairProb: 0.0951 },
        draw: { fairProb: 0.1739 },
        away: { fairProb: 0.7310 },
        books: 3, source: 'toa-3way-power',
      },
    },
  }] },
});

const fair = (sel, mkt = 'h2h_3way') =>
  oddsFeed.getFairProb(SPORT, HOME, AWAY, mkt, sel, START);

test('routes each 3-way outcome to its own probability', () => {
  assert.strictEqual(fair('home'), 0.0951);
  assert.strictEqual(fair('draw'), 0.1739);
  assert.strictEqual(fair('away'), 0.7310);
});

test('the three outcomes sum to 1', () => {
  const s = fair('home') + fair('draw') + fair('away');
  assert.ok(Math.abs(s - 1) < 1e-9, `sum was ${s}`);
});

test('NO sides are the exact complement of their own outcome', () => {
  assert.ok(Math.abs(fair('no_home') - (1 - 0.0951)) < 1e-12);
  assert.ok(Math.abs(fair('no_draw') - (1 - 0.1739)) < 1e-12);
  assert.ok(Math.abs(fair('no_away') - (1 - 0.7310)) < 1e-12);
});

test('a 3-way win leg is NOT priced off the draw-no-bet board', () => {
  // The whole point of storing them separately. If these ever coincide, the
  // separation has been undone somewhere upstream.
  const threeWayHome = fair('home');
  const dnbHome = fair('home', 'h2h');
  assert.notStrictEqual(threeWayHome, dnbHome);
  assert.ok(dnbHome > threeWayHome,
    'draw-no-bet must exceed the outright win probability');
});

test('unknown selections fail closed rather than guessing a side', () => {
  for (const bad of ['yes', 'no', 'over', '1X', 'sideways', '', null, undefined]) {
    assert.strictEqual(fair(bad), null, `expected null for ${String(bad)}`);
  }
});

test('a missing 3-way block returns null, it does not fall back to h2h', () => {
  const S2 = '__test_soccer_no3way';
  oddsFeed.__debugSetCache(S2, {
    fetchedAt: Date.now(),
    events: { [`${HOME.toLowerCase()}|${AWAY.toLowerCase()}`]: [{
      homeTeam: HOME, awayTeam: AWAY, commenceTime: START, eventId: 'test-3way-2',
      markets: { h2h: { home: { fairProb: 0.1277 }, away: { fairProb: 0.8723 } } },
    }] },
  });
  assert.strictEqual(
    oddsFeed.getFairProb(S2, HOME, AWAY, 'h2h_3way', 'home', START), null);
});
