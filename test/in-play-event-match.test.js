// A fixture that has NOT started must never be priced off an odds event that
// HAS started. Live in-play prices are not a fair value for a future game.
//
// Measured 2026-08-23, New York Mets at Chicago White Sox: the cache held only
// Saturday's game (commence 23:10Z, then in progress) while PX event 10079241
// was SUNDAY's game 19h later. The White Sox ML ran +441 -> +1255 on Pinnacle
// within an hour as they fell behind, and two parlays confirmed at the extreme
// for $4,451 of our risk. 19h sits inside the 36h proximity ceiling, so that
// guard cannot catch this; and with the correct day's event absent from the
// board, closest-by-time had only the live game to choose from.

const test = require('node:test');
const assert = require('node:assert');
const oddsFeed = require('../services/odds-feed');

const H = 3600e3;
const SPORT = '__test_inplay_mlb';
const HOME = 'Chicago White Sox', AWAY = 'New York Mets';
const key = `${HOME.toLowerCase()}|${AWAY.toLowerCase()}`;

const mkEvent = (commenceTime, homeProb) => ({
  homeTeam: HOME, awayTeam: AWAY, commenceTime,
  markets: { h2h: { home: { fairProb: homeProb }, away: { fairProb: 1 - homeProb }, books: 3 } },
});

const setCache = (events) =>
  oddsFeed.__debugSetCache(SPORT, { fetchedAt: Date.now(), events: { [key]: events } });

const probe = (targetTime) => {
  const m = oddsFeed.getEventMarkets(SPORT, HOME, AWAY, targetTime);
  return m && m.markets && m.markets.h2h ? m.markets.h2h.home.fairProb : null;
};

test('lone in-progress event does NOT price a future fixture', () => {
  // Saturday's game started 4h ago; PX event is Sunday, 19h out.
  setCache([mkEvent(new Date(Date.now() - 4 * H).toISOString(), 0.0835)]);
  assert.strictEqual(probe(new Date(Date.now() + 19 * H).toISOString()), null,
    'priced tomorrow off a live line — the reported bug');
});

test('when both games are cached, the started one is skipped', () => {
  setCache([
    mkEvent(new Date(Date.now() - 4 * H).toISOString(), 0.0835), // live, contaminated
    mkEvent(new Date(Date.now() + 19 * H).toISOString(), 0.2500), // the real fixture
  ]);
  assert.strictEqual(probe(new Date(Date.now() + 19 * H).toISOString()), 0.25);
});

test('a started event is still skipped even when it is CLOSER in time', () => {
  // Closest-by-time alone would take the live game here.
  setCache([
    mkEvent(new Date(Date.now() - 30 * 60e3).toISOString(), 0.0835), // 30m ago
    mkEvent(new Date(Date.now() + 20 * H).toISOString(), 0.2500),
  ]);
  assert.strictEqual(probe(new Date(Date.now() + 1 * H).toISOString()), 0.25);
});

test('a normal pregame match is untouched', () => {
  const t = new Date(Date.now() + 6 * H).toISOString();
  setCache([mkEvent(t, 0.44)]);
  assert.strictEqual(probe(t), 0.44);
});

test('grace absorbs first-pitch jitter (event stamped a few minutes ago)', () => {
  // Posted vs actual first pitch drifts by minutes; that must still match.
  setCache([mkEvent(new Date(Date.now() - 5 * 60e3).toISOString(), 0.44)]);
  assert.strictEqual(probe(new Date(Date.now() + 25 * 60e3).toISOString()), 0.44);
});

test('an already-started PX fixture is unaffected (handled upstream)', () => {
  // Target in the past -> guard does not engage; the started-check declines it.
  const t = new Date(Date.now() - 2 * H).toISOString();
  setCache([mkEvent(new Date(Date.now() - 2 * H).toISOString(), 0.30)]);
  assert.strictEqual(probe(t), 0.30);
});

test('golf is exempt — a tournament event legitimately spans days', () => {
  const G = 'golf_pga';
  const gkey = 'field|field';
  oddsFeed.__debugSetCache(G, { fetchedAt: Date.now(), events: { [gkey]: [{
    homeTeam: 'Field', awayTeam: 'Field',
    commenceTime: new Date(Date.now() - 2 * 24 * H).toISOString(), // R1 was 2 days ago
    markets: { h2h: { home: { fairProb: 0.51 }, away: { fairProb: 0.49 }, books: 2 } },
  }] } });
  const m = oddsFeed.getEventMarkets(G, 'Field', 'Field', new Date(Date.now() + 20 * H).toISOString());
  assert.ok(m && m.markets.h2h, 'golf round-4 matchup must still resolve');
  assert.strictEqual(m.markets.h2h.home.fairProb, 0.51);
});
