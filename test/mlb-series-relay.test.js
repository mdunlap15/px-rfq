// MLB series RELAY (2026-10-04): the trader prices series legs off the order
// book's own consensus, published by ~/mlb_series_consensus.py to kv_store
// 'mlb_series_consensus'. And — operator, verbatim — "it's very important we
// not be quoting series prices while games of the given series are in play."
// Run: node --test test/mlb-series-relay.test.js

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const cons = require('../services/mlb-series-consensus');
const seriesWindow = require('../services/series-window');
const pricer = require('../services/pricer');

const H = 3600e3;
const nowS = () => Math.floor(Date.now() / 1000);
// Real record from ~/cons_mlb_series.json, 2026-10-04.
const RAYS_YANKS = { teams: ['rays', 'yankees'], books: { betonline: { yankees: 170, rays: -195 }, bovada: { yankees: 162, rays: -197 }, draftkings: { rays: -190, yankees: 160 } },
  n: 3, raw: { rays: -195, yankees: 162 }, fair: { rays: 0.634749, yankees: 0.365251 }, fair_lo: { rays: 0.630102, yankees: 0.359099 }, gap_pp: 1.08, decline: null };

function relay(ageSec = 60, srcAgeSec = 120, series = { 'rays|yankees': RAYS_YANKS }) {
  cons.__setRelayForTest({ ts: nowS() - ageSec, src_ts: nowS() - srcAgeSec, series, books_read: ['betonline', 'bovada', 'draftkings'] });
}
function line(team, startMs) {
  return { sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'series_winner', oddsApiMarket: 'series_winner',
    teamName: `${team} (Series)`, homeTeam: 'Tampa Bay Rays', awayTeam: 'New York Yankees',
    startTime: new Date(startMs).toISOString(), startTimeMs: startMs };
}
function reset() { cons.__resetForTest(); seriesWindow.__resetForTest(); }

test('a fresh relay IS the consensus: same books, fair and board time as the order book', () => {
  reset(); relay(60, 120);
  const c = cons.getConsensus();
  assert.strictEqual(c.via, 'relay');
  const r = c.series['rays|yankees'];
  assert.strictEqual(r.n, 3);
  assert.deepStrictEqual(r.fair, RAYS_YANKS.fair);
  assert.ok(Math.abs(r.boardAtMs - (Date.now() - 120e3)) < 2000, 'board time = the OLDEST counted source, not the publish time');
  const q = cons.getQuoteForLine(line('New York Yankees', Date.now() + 20 * H));
  assert.strictEqual(q.ok, true, JSON.stringify(q));
  assert.strictEqual(q.fairProb, 0.365251);
});

test('a stale relay is ignored (falls back to our own sources — none here → no record)', () => {
  reset(); relay(30 * 60, 30 * 60);
  assert.notStrictEqual(cons.getConsensus().via, 'relay');
  assert.strictEqual(cons.getQuoteForLine(line('New York Yankees', Date.now() + 20 * H)).ok, false);
});

test('a relay decline is honoured', () => {
  reset(); relay(60, 120, { 'rays|yankees': Object.assign({}, RAYS_YANKS, { decline: 'only 2 book(s) < 3' }) });
  assert.strictEqual(cons.getQuoteForLine(line('New York Yankees', Date.now() + 20 * H)).ok, false);
});

// ---------------------------------------------------------------- in play

test('IN PLAY: a game of the series that has started blocks pricing even with a fresh relay', () => {
  reset(); relay(30, 30);
  const li = line('New York Yankees', Date.now() - 40 * 60e3);   // series start = the game now in progress
  assert.strictEqual(pricer.getSeriesFairProb(li), null);
});

test('IN PLAY: ESPN showing the game live keeps it dark past the 8h time fallback', () => {
  reset();
  const start = Date.now() - 10 * H;                               // a very long rain delay
  const li = line('New York Yankees', Date.now() + 20 * H);
  const games = [{ startMs: start, home: 'Tampa Bay Rays', away: 'New York Yankees' }];
  const live = () => ({ completed: false, state: 'in' });
  assert.strictEqual(seriesWindow.isClosed(li, { games, espnLookup: live }), true);
  assert.strictEqual(seriesWindow.isClosed(li, { games, espnLookup: () => null }), false, 'no ESPN record → the 8h fallback has passed');
});

test('IN PLAY: without ESPN, a game is presumed live for 8 hours', () => {
  reset();
  const li = line('New York Yankees', Date.now() + 20 * H);
  const games = [{ startMs: Date.now() - 6 * H, home: 'Tampa Bay Rays', away: 'New York Yankees' }];
  assert.strictEqual(seriesWindow.isClosed(li, { games, espnLookup: () => null }), true);
  assert.ok(seriesWindow.MAX_GAME_MS >= 8 * H);
});

test('after a final, a relay whose oldest source predates the end stays dark; a newer one reopens', () => {
  reset();
  const li = line('New York Yankees', Date.now() + 20 * H);
  const games = [{ startMs: Date.now() - 4 * H, home: 'Tampa Bay Rays', away: 'New York Yankees' }];
  const fin = () => ({ completed: true, state: 'post' });
  const t0 = Date.now();
  // final first seen now; a board whose oldest source is 2 min old predates it
  assert.strictEqual(seriesWindow.isPriceable(li, { now: t0, games, espnLookup: fin, boardAtMs: t0 - 120e3 }), false);
  const later = t0 + seriesWindow.RELIST_GRACE_MS + 60e3;
  assert.strictEqual(seriesWindow.isPriceable(li, { now: later, games, espnLookup: fin, boardAtMs: later - 30e3 }), true);
});
