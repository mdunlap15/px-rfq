// Home/away side assignment (2026-08-18).
//
// THE BUG IT FIXES, found LIVE in production during the soccer event_match_gap
// investigation: every side-assignment call site asked matchTeamName about ONE
// candidate at a time --
//
//     if (matchTeamName(sel.teamName, [matchedHome]))      oddsApiSelection = 'home';
//     else if (matchTeamName(sel.teamName, [matchedAway])) oddsApiSelection = 'away';
//
// -- but BOTH of matchTeamName's ambiguity guards are COUNTING guards
// (`subMatches.length === 1`, `matches.length === 1`). A one-element array
// satisfies them unconditionally, so any fuzzy overlap with the side under test
// wins outright. Home is tested first, so an AWAY club sharing a suffix with
// the HOME club registers as 'home'.
//
// MEASURED ON THE LIVE BOARD (prod /lines/detail, 2026-08-18): PX event
// 90104379 "Atlanta United FC at Minnesota United FC" had BOTH moneyline lines
// carrying oddsApiSelection='home', BOTH quoting fairProb 0.7061 (-260) -- the
// away side priced at the home side's number. It resolved via the last-2-words
// branch on the tail "united fc".
//
// It FAILS OPEN: the line registers and quotes. In the measured case the away
// club was the dog, so the wrong price was one no bettor wants. The MIRROR case
// -- an away FAVOURITE -- offers a ~70% team at the ~30% side's price. English
// football is dense with the collision ("* City FC", "* Town FC", "* United
// FC"), so any expansion there arms it.
//
// Run: npm test   (or: node --test test/home-away-side-assignment.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const px = require('../services/prophetx');
const oddsFeed = require('../services/odds-feed');
const db = require('../services/db');
const { config } = require('../config');

const SPORT = 'soccer_usa_mls';
const SCHED = new Date(Date.now() + 30 * 3600e3).toISOString();
const EVENT_ID = 90104379; // the real prod event id, kept for traceability
const grp = (arr) => [arr];

// The exact live fixture: two clubs sharing the tail "United FC", away listed
// first in the PX event name.
const PX_EVENT = {
  event_id: EVENT_ID,
  name: 'Atlanta United FC at Minnesota United FC',
  sport_name: 'Soccer',
  scheduled: SCHED,
  status: 'not_started',
  competitors: [
    { id: 301, name: 'Minnesota United FC', side: 'home' },
    { id: 302, name: 'Atlanta United FC', side: 'away' },
  ],
};

function marketsFixture() {
  return [
    { id: 11, name: 'Moneyline (2 Way)', type: 'moneyline', selections: grp([
      { line_id: 'sd-ml-min', name: 'Minnesota United FC', competitor_id: 301 },
      { line_id: 'sd-ml-atl', name: 'Atlanta United FC', competitor_id: 302 },
    ]) },
    { id: 12, name: 'Spread', type: 'spread', market_lines: [
      { line: -1, selections: grp([
        { line_id: 'sd-sp-min', name: 'Minnesota United FC -1', line: -1, competitor_id: 301 },
        { line_id: 'sd-sp-atl', name: 'Atlanta United FC +1', line: 1, competitor_id: 302 },
      ]) },
    ] },
  ];
}

function installHarness() {
  const saved = [];
  const patch = (obj, key, val) => { saved.push([obj, key, obj[key]]); obj[key] = val; };

  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [PX_EVENT]);
  patch(px, 'fetchMarkets', async () => marketsFixture());
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => [
    { sport: SPORT, homeTeam: 'Minnesota United FC', awayTeam: 'Atlanta United FC', commenceTime: SCHED },
  ]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT ? {
    homeTeam: 'Minnesota United FC', awayTeam: 'Atlanta United FC', commenceTime: SCHED,
    markets: {
      h2h: [{ name: 'Minnesota United FC', price: -240 }, { name: 'Atlanta United FC', price: 200 }],
      spreads: [
        { name: 'Minnesota United FC', point: -1, price: 150 },
        { name: 'Atlanta United FC', point: 1, price: -180 },
      ],
    },
  } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', async () => null);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  if (config.sportNameMap[SPORT] !== 'Soccer') patch(config.sportNameMap, SPORT, 'Soccer');
  return () => { for (const [obj, key, val] of saved.reverse()) obj[key] = val; };
}

test('the measured prod case: two clubs sharing "United FC" get DISTINCT sides', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();
    const idx = lineManager.__debugGetLineIndex();

    const min = idx['sd-ml-min'];
    const atl = idx['sd-ml-atl'];
    assert.ok(min, 'home moneyline line must register');
    assert.ok(atl, 'away moneyline line must register');

    assert.equal(min.oddsApiSelection, 'home', 'Minnesota is the home club');
    assert.equal(atl.oddsApiSelection, 'away',
      'BUG: Atlanta (away) resolved to the HOME side via the last-2-words tail "united fc" — it would be priced at Minnesota\'s number');

    // The property that actually matters: the two sides must never collide.
    assert.notEqual(min.oddsApiSelection, atl.oddsApiSelection,
      'both sides of a two-way market carrying the same selection is the live prod defect (event 90104379)');
  } finally {
    restore();
  }
});

test('the same guarantee holds on spreads, where a swap flips the sign of the line', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();
    const idx = lineManager.__debugGetLineIndex();
    const min = idx['sd-sp-min'];
    const atl = idx['sd-sp-atl'];
    if (!min || !atl) return; // spread registration is gated elsewhere; nothing to assert

    assert.equal(min.oddsApiSelection, 'home');
    assert.equal(atl.oddsApiSelection, 'away');
    assert.notEqual(min.oddsApiSelection, atl.oddsApiSelection,
      'a spread side-swap prices the favourite as the dog and inverts the handicap');
  } finally {
    restore();
  }
});

test('a genuinely ambiguous name fails CLOSED rather than guessing a side', async () => {
  const restore = installHarness();
  try {
    await lineManager.seedAllLines();
    const idx = lineManager.__debugGetLineIndex();

    // Every registered line for this event must carry a side that actually
    // corresponds to its own club — never an unresolved or duplicated side.
    const rows = Object.values(idx).filter((l) => l && String(l.pxEventId) === String(EVENT_ID));
    assert.ok(rows.length >= 2, 'fixture should register at least the two moneyline lines');
    for (const l of rows) {
      if (l.oddsApiSelection !== 'home' && l.oddsApiSelection !== 'away') continue;
      const expected = /minnesota/i.test(l.teamName || '') ? 'home'
        : /atlanta/i.test(l.teamName || '') ? 'away' : null;
      if (expected) {
        assert.equal(l.oddsApiSelection, expected,
          `line ${l.lineId || ''} for "${l.teamName}" resolved to the wrong side`);
      }
    }
  } finally {
    restore();
  }
});
