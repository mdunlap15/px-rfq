// resolveUnknownLine failure-record race (2026-08-18).
//
// THE BUG IT FIXES: resolveUnknownLine used to `_failuresByLineId.delete(lineId)`
// synchronously at function entry, but only re-record the failure AFTER an
// awaited px.fetchMarkets (~50-150ms later). Both readers of that map run
// synchronously in the gap, so they read a hole instead of the truth.
//
// Two consequences, one cosmetic and one expensive:
//
//   1. TELEMETRY. websocket.js fires resolveUnknownLine WITHOUT awaiting for
//      known-failing legs, then categorizes the decline off getResolveFailure().
//      It got null every time (measured: resolveReason null on 6,937/6,953 MLB
//      legs over 14 days), so declines fell through to a line-VALUE heuristic
//      and were labelled by guesswork -- which is why 'baseball_low_line_
//      ambiguous' reported alt run-lines when ~100% of it is player props.
//
//   2. LATENCY. The getFail(lid) probe in websocket.js chooses fire-and-forget
//      over AWAIT precisely so an RFQ never blocks on a line already known to
//      fail (operator incident 2026-06-07: prop flood collapsed win rate
//      62% -> ~5% via that latency). Wiping the record at entry makes a repeat
//      offender look unseen again for the whole fetch window, so concurrent
//      RFQs on that line get re-awaited -- defeating the fast path in exactly
//      the flood conditions it exists for.
//
// The fix moves the clear to the SUCCESS path, the only case that can strand a
// stale entry. These tests drive the REAL resolveUnknownLine against a seeded
// index with stubbed I/O; they fail if someone reinstates the entry-time delete.
//
// Run: npm test   (or: node --test test/resolve-failure-race.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const px = require('../services/prophetx');
const oddsFeed = require('../services/odds-feed');
const db = require('../services/db');
const { config } = require('../config');

const SPORT = 'americanfootball_nfl_preseason';
const SCHED = new Date(Date.now() + 24 * 3600e3).toISOString();
const EVENT_ID = 77771;
// A SECOND event exists purely to defeat the 60s resolvedEventMarkets cache
// (line-manager.js:2941, hardcoded and module-private). Without it the second
// resolve attempt reads cached markets, never awaits, and re-records the
// failure in the same tick -- which masks the very race under test.
const EVENT_ID_2 = 77772;
const grp = (arr) => [arr];

const PX_EVENT = {
  event_id: EVENT_ID,
  name: 'Carolina Panthers at Arizona Cardinals',
  sport_name: 'American Football',
  scheduled: SCHED,
  status: 'not_started',
  competitors: [
    { id: 101, name: 'Arizona Cardinals', side: 'home' },
    { id: 102, name: 'Carolina Panthers', side: 'away' },
  ],
};

const PX_EVENT_2 = {
  event_id: EVENT_ID_2,
  name: 'Chicago Bears at Denver Broncos',
  sport_name: 'American Football',
  scheduled: SCHED,
  status: 'not_started',
  competitors: [
    { id: 201, name: 'Denver Broncos', side: 'home' },
    { id: 202, name: 'Chicago Bears', side: 'away' },
  ],
};

function marketsFixture() {
  return [
    { id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
      { line_id: 'race-ml-ari', name: 'Arizona Cardinals', competitor_id: 101 },
      { line_id: 'race-ml-car', name: 'Carolina Panthers', competitor_id: 102 },
    ]) },
    { id: 3, name: 'Total Points', type: 'total', market_lines: [
      { line: 43.5, selections: grp([
        { line_id: 'race-tot-o', name: 'Over 43.5', line: 43.5 },
        { line_id: 'race-tot-u', name: 'Under 43.5', line: 43.5 },
      ]) },
    ] },
  ];
}

// Patch every I/O boundary the seed + resolve path touches, run the real
// seedAllLines, and hand back a restore fn. Mirrors test/football-lines.test.js.
function installHarness() {
  const saved = [];
  const patch = (obj, key, val) => { saved.push([obj, key, obj[key]]); obj[key] = val; };

  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [PX_EVENT, PX_EVENT_2]);
  patch(px, 'fetchMarkets', async () => marketsFixture());
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => [
    { sport: SPORT, homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', commenceTime: SCHED },
    { sport: SPORT, homeTeam: 'Denver Broncos', awayTeam: 'Chicago Bears', commenceTime: SCHED },
  ]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT ? {
    homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', commenceTime: SCHED,
    markets: { h2h: [{ name: 'Arizona Cardinals', price: -140 }, { name: 'Carolina Panthers', price: 120 }] },
  } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', async () => null);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  if (config.sportNameMap[SPORT] !== 'American Football') {
    patch(config.sportNameMap, SPORT, 'American Football');
  }
  return () => { for (const [obj, key, val] of saved.reverse()) obj[key] = val; };
}

test('a cached failure SURVIVES a concurrent non-awaited re-resolve (the race)', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();

    const LID = 'race-never-in-markets';
    const leg = { line_id: LID, sport_event_id: EVENT_ID, line: 2.5 };

    // First attempt: the event is known, so this takes the SLOW async path
    // (fetchMarkets) and ends in a recorded failure.
    await lineManager.resolveUnknownLine(leg);
    const first = lineManager.getResolveFailure(LID);
    assert.ok(first, 'first attempt must leave a failure record');
    assert.ok(first.reason, `record must carry a reason, got ${JSON.stringify(first)}`);

    // THE REGRESSION GUARD. Fire the retry the way websocket.js does for a
    // known-failing leg: no await. Point it at the OTHER event so the markets
    // cache misses and the fetch genuinely suspends -- that pending fetch is
    // the window in which prod's categorizer reads. Hold it open with a gate
    // so the assertion is deterministic rather than microtask-timing luck.
    let release;
    const gate = new Promise((r) => { release = r; });
    px.fetchMarkets = async () => { await gate; return marketsFixture(); };

    const inflight = lineManager.resolveUnknownLine({ line_id: LID, sport_event_id: EVENT_ID_2, line: 2.5 });
    await null; // let the async fn run up to its first real await (the gated fetch)

    const during = lineManager.getResolveFailure(LID);
    assert.ok(during, 'BUG: record wiped at entry - categorizer reads null and falls back to the line-value heuristic');
    assert.equal(during.reason, first.reason, 'the surviving record must still be the real reason');

    release();
    await inflight;
    assert.ok(lineManager.getResolveFailure(LID), 'the retry must leave a record behind too');
  } finally {
    restore();
  }
});

test('the known-failure fast path stays armed across repeated attempts', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();
    const LID = 'race-repeat-offender';
    const leg = { line_id: LID, sport_event_id: EVENT_ID, line: 7.5 };
    await lineManager.resolveUnknownLine(leg);

    // websocket.js: `if (getFail(lid)) { fire-and-forget } else { AWAIT }`.
    // Simulate 5 back-to-back RFQs touching the same dead line; every one must
    // see the cached failure, i.e. none may be pushed onto the await path.
    for (let i = 0; i < 5; i++) {
      assert.ok(lineManager.getResolveFailure(LID),
        `RFQ #${i + 1} must still see the cached failure (would otherwise block the RFQ on a known-dead line)`);
      lineManager.resolveUnknownLine(leg).catch(() => {});
    }
  } finally {
    restore();
  }
});

test('an in-flight duplicate does not wipe the record it is about to rewrite', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();
    const LID = 'race-inflight-dupe';
    const leg = { line_id: LID, sport_event_id: EVENT_ID, line: 3.5 };
    await lineManager.resolveUnknownLine(leg);
    assert.ok(lineManager.getResolveFailure(LID), 'precondition: a record exists');

    // Two concurrent calls: the second short-circuits on inFlightResolutions
    // and previously returned early WITHOUT ever rewriting the record it wiped.
    const a = lineManager.resolveUnknownLine(leg);
    const b = lineManager.resolveUnknownLine(leg);
    assert.ok(lineManager.getResolveFailure(LID), 'record must survive both concurrent entries');
    await Promise.all([a, b]);
    assert.ok(lineManager.getResolveFailure(LID), 'record must survive after both settle');
  } finally {
    restore();
  }
});

test('a resolved line never leaves a failure record for the categorizer', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();

    // The case the entry-time delete was written for: the success path writes
    // to lineIndex but not to _failuresByLineId, so a stale record could
    // outlive the failure it described. Now cleared on success instead.
    const LID = 'race-ml-ari';
    const idx = lineManager.__debugGetLineIndex();
    assert.ok(idx[LID], 'precondition: the seed registered this line');

    const res = await lineManager.resolveUnknownLine({ line_id: LID, sport_event_id: EVENT_ID });
    assert.ok(res, 'a registered line must resolve');
    assert.equal(lineManager.getResolveFailure(LID), null,
      'a resolved line must never leave a failure record for the categorizer to read');
  } finally {
    restore();
  }
});
