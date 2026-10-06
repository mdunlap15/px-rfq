// RFQ watch list for the order book's line guards (2026-10-06).
// Run: node --test test/rfq-watch.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const rfqWatch = require('../services/rfq-watch');

const H = 3600e3;
function idx(now) {
  const soon = new Date(now + 2 * H).toISOString(), far = new Date(now + 30 * H).toISOString(), past = new Date(now - H).toISOString();
  return {
    n1: { pxEventId: 10, sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', homeTeam: 'Montréal Canadiens', awayTeam: 'Carolina Hurricanes', startTime: soon },
    n2: { pxEventId: 10, sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', homeTeam: 'Montréal Canadiens', awayTeam: 'Carolina Hurricanes', startTime: soon },
    s1: { pxEventId: 20, sport: 'soccer_epl', oddsApiSport: 'soccer_epl', homeTeam: 'Arsenal', awayTeam: 'Leeds United', startTime: soon },
    f1: { pxEventId: 30, sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', homeTeam: 'A', awayTeam: 'B', startTime: far },
    p1: { pxEventId: 40, sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', homeTeam: 'C', awayTeam: 'D', startTime: past },
    q1: { pxEventId: 50, sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', homeTeam: 'E', awayTeam: 'F', startTime: soon },
    g1: { pxEventId: 60, sport: 'golf_matchups', oddsApiSport: 'golf_matchups', homeTeam: 'G', awayTeam: 'H', startTime: soon },
  };
}

test('only events quoted recently, starting within the horizon, in a guarded sport — split per guard profile', () => {
  const now = Date.now();
  const orig = lineManager.__debugGetLineIndex;
  const I = idx(now);
  lineManager.__debugGetLineIndex = () => I;
  rfqWatch.__resetForTest();
  try {
    rfqWatch.touch([I.n1, I.s1, I.f1, I.p1, I.g1]);     // q1 (event 50) never quoted
    const w = rfqWatch.build(now);
    assert.deepStrictEqual(Object.keys(w.nhl), ['10']);
    assert.deepStrictEqual(w.nhl['10'].l, ['n1', 'n2'], 'every registered line of the event, not just the quoted one');
    assert.strictEqual(w.nhl['10'].h, 'Montréal Canadiens', "the Odds API's own team names");
    assert.deepStrictEqual(Object.keys(w.soccer), ['20']);
    assert.deepStrictEqual(Object.keys(w.mlb), [], 'beyond the horizon / already started are excluded');
    assert.ok(!('golf' in w), 'golf has no guard profile');
  } finally { lineManager.__debugGetLineIndex = orig; }
});

test('activity expires after RFQ_WATCH_ACTIVE_MIN', () => {
  const now = Date.now();
  const orig = lineManager.__debugGetLineIndex;
  const I = idx(now);
  lineManager.__debugGetLineIndex = () => I;
  rfqWatch.__resetForTest();
  try {
    rfqWatch.touch([I.n1]);
    assert.deepStrictEqual(Object.keys(rfqWatch.build(now + 31 * 60e3).nhl), []);
  } finally { lineManager.__debugGetLineIndex = orig; }
});

test('profile mapping', () => {
  assert.strictEqual(rfqWatch.PROFILE_OF('soccer_usa_mls'), 'soccer');
  assert.strictEqual(rfqWatch.PROFILE_OF('americanfootball_ncaaf'), 'cfb');
  assert.strictEqual(rfqWatch.PROFILE_OF('americanfootball_nfl'), 'nfl');
  assert.strictEqual(rfqWatch.PROFILE_OF('tennis'), null);
});
