// Every leg must read its OWN game's closing line.
//
// captureClosingLines keys a snapshot `sport|home|away|<odds-feed eventId>`,
// but the settlement path looked it up with the PX event id. The exact match
// never hit, and the fallback returned the FIRST snapshot for the team pair —
// so MLB series games 2-4 and doubleheader game 2 all read game 1's close
// (~37% of unique legs), contaminating every clvDelta and /clv-report.
// The lookup now resolves by the leg's start time: closest commenceTime within
// 12h, otherwise no close at all (never another game's).
//
// Run: npm test   (db is a hermetic no-op under the test runner)

const { test } = require('node:test');
const assert = require('node:assert');
const oddsFeed = require('../services/odds-feed');
const ot = require('../services/order-tracker');

const MIN = 60e3;
const HOME = 'New York Yankees', AWAY = 'Boston Red Sox';
const key = `${HOME.toLowerCase()}|${AWAY.toLowerCase()}`;

const mkEvent = (eventId, commenceTime, homeProb) => ({
  homeTeam: HOME, awayTeam: AWAY, commenceTime, eventId,
  markets: { h2h: { home: { fairProb: homeProb }, away: { fairProb: 1 - homeProb } } },
});

// Run captureClosingLines as if the clock read `nowIso`, against a board
// holding `events` for the pair. The cache is cleared afterwards so a later
// capture in this file cannot pick these events up.
function captureAt(sport, nowIso, events) {
  oddsFeed.__debugSetCache(sport, { fetchedAt: Date.now(), events: { [key]: events } });
  const realNow = Date.now;
  Date.now = () => new Date(nowIso).getTime();
  try { return oddsFeed.captureClosingLines(); } finally {
    Date.now = realNow;
    oddsFeed.__debugSetCache(sport, null);
  }
}

const plus = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();
const closeHome = (snap) => (snap && snap.markets.h2h ? snap.markets.h2h.home : null);

// A three-game series: Sat night, Sun afternoon, Mon night. The board carries
// all three (as TOA's does), so each capture pass sees future games too.
const G1 = '2026-09-26T23:10:00Z', G2 = '2026-09-27T17:35:00Z', G3 = '2026-09-28T23:05:00Z';
const SERIES = [mkEvent('toa-g1', G1, 0.40), mkEvent('toa-g2', G2, 0.62), mkEvent('toa-g3', G3, 0.51)];

test('series on consecutive days: each leg gets its own game\'s close', () => {
  const S = '__clv_series';
  for (const g of [G1, G2, G3]) captureAt(S, plus(g, 5 * MIN), SERIES);
  // Settlement passes the PX id (a different id space) and the PX start, which
  // jitters a few minutes from TOA's commence_time.
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-10079241', plus(G1, 3 * MIN))), 0.40);
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-10079242', plus(G2, -4 * MIN))), 0.62,
    'game 2 read another game\'s close — the reported bug');
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-10079243', G3)), 0.51);
});

test('doubleheader: game 2 (3.5h later) gets its own close', () => {
  const S = '__clv_dh';
  const D1 = '2026-09-20T17:05:00Z', D2 = '2026-09-20T20:40:00Z';
  const board = [mkEvent('toa-d1', D1, 0.55), mkEvent('toa-d2', D2, 0.48)];
  captureAt(S, plus(D1, 5 * MIN), board);
  captureAt(S, plus(D2, 5 * MIN), board);
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-dh-1', D1)), 0.55);
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-dh-2', D2)), 0.48);
});

test('resolution does not depend on capture order', () => {
  const S = '__clv_order';
  // Captured later game FIRST — a "first" or "last" snapshot rule fails one way.
  captureAt(S, plus(G2, 5 * MIN), [mkEvent('toa-g2', G2, 0.62)]);
  captureAt(S, plus(G1, 5 * MIN), [mkEvent('toa-g1', G1, 0.40)]);
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-a', G1)), 0.40);
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-b', G2)), 0.62);
});

test('a game whose close was never captured gets NO close, not a neighbour\'s', () => {
  const S = '__clv_missing';
  captureAt(S, plus(G1, 5 * MIN), SERIES); // only game 1 ever captured
  assert.strictEqual(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-10079242', G2), null,
    'game 2 (18h later) must not read game 1\'s close');
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-10079241', G1)), 0.40);
});

test('no start time and no id → null, never an arbitrary first snapshot', () => {
  const S = '__clv_notime';
  for (const g of [G1, G2]) captureAt(S, plus(g, 5 * MIN), SERIES);
  assert.strictEqual(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-x', null), null);
  assert.strictEqual(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-x', 'not a date'), null);
});

test('the odds-feed event id the snapshot is keyed on still matches exactly', () => {
  const S = '__clv_exact';
  for (const g of [G1, G2]) captureAt(S, plus(g, 5 * MIN), SERIES);
  // Same id on both sides → exact hit, no start time needed.
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'toa-g2', null)), 0.62);
});

test('a snapshot keyed with an empty event id (old key shape) still resolves', () => {
  const S = '__clv_legacy';
  const ev = mkEvent(undefined, G2, 0.62); // key `sport|home|away|` — no id
  captureAt(S, plus(G2, 5 * MIN), [ev]);
  assert.strictEqual(closeHome(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, 'px-10079242', G2)), 0.62);
});

test('settlement stamps each leg with its own game\'s close and clvDelta', () => {
  const S = '__clv_settle';
  for (const g of [G1, G2]) captureAt(S, plus(g, 5 * MIN), SERIES);
  const settle = (id, pxEventId, startTime, offered) => {
    const leg = { sport: S, homeTeam: HOME, awayTeam: AWAY, market: 'moneyline', selection: 'home', pxEventId, startTime };
    ot.recordQuote(id, [leg], 150, 100, 0.4, { offeredImpliedProb: offered });
    ot.recordConfirmation(id, 'uuid-' + id, 150, 100);
    return ot.recordSettlement('uuid-' + id, 'won', null, { trusted: true });
  };
  const o1 = settle('clv-g1', 'px-10079241', G1, 0.45);
  const o2 = settle('clv-g2', 'px-10079242', G2, 0.65);
  assert.strictEqual(o1.legs[0].closingImpliedProb, 0.40);
  assert.strictEqual(o2.legs[0].closingImpliedProb, 0.62, 'game 2 leg read game 1\'s close');
  assert.strictEqual(o1.clvDelta, 0.05);
  assert.strictEqual(o2.clvDelta, 0.03);
});
