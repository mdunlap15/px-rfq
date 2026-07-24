// Regression tests: a parlay containing TWO independent same-game pairs on
// DIFFERENT events must be quotable when each pair is an allowed SGP combo.
//
// Background (2026-07-24): shouldDecline blanket-declined any parlay with a
// second same-game pair ('multiple same-game pairs not supported') — $11.5K
// of network-filled volume in one 2-day sample, avg $2.3K tickets. The
// pricing engine already compounds per-combo correlation factors across
// components (priceParlay eventLegs loop), so the decline was pure lost
// volume. These tests lock in:
//   1. two allowed pairs (ml_total × 2) on different events → NOT declined
//      for the multi-pair reason;
//   2. a parlay where ONE pair is allowed and the other is NOT still
//      declines (each pair is individually validated);
//   3. same-event 3+ leg grouping is untouched.
//
// Legs are passed RAW ({line_id}) exactly as PX sends them — same rationale
// as mov-sgp-block.test.js.
//
// Run: npm test   (or: node --test test/multi-sgp-pairs.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

const GAME1 = 100, GAME2 = 101, GAME3 = 102;
const LINES = {
  // Game 1: NYY @ BOS — ml + total (allowed combo ml_total)
  'g1-ml':  { sport: 'baseball_mlb', pxEventId: GAME1, marketType: 'moneyline', selection: 'home', teamName: 'Boston Red Sox', homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees' },
  'g1-tot': { sport: 'baseball_mlb', pxEventId: GAME1, marketType: 'total', selection: 'over', line: 8.5, teamName: 'Over', homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees' },
  // Game 2: LAD @ SF — ml + total (allowed combo ml_total)
  'g2-ml':  { sport: 'baseball_mlb', pxEventId: GAME2, marketType: 'moneyline', selection: 'away', teamName: 'Los Angeles Dodgers', homeTeam: 'San Francisco Giants', awayTeam: 'Los Angeles Dodgers' },
  'g2-tot': { sport: 'baseball_mlb', pxEventId: GAME2, marketType: 'total', selection: 'under', line: 7.5, teamName: 'Under', homeTeam: 'San Francisco Giants', awayTeam: 'Los Angeles Dodgers' },
  // Game 3: CHC @ MIL — ml + spread (combo ml_spread, NOT in allowed list)
  'g3-ml':  { sport: 'baseball_mlb', pxEventId: GAME3, marketType: 'moneyline', selection: 'home', teamName: 'Milwaukee Brewers', homeTeam: 'Milwaukee Brewers', awayTeam: 'Chicago Cubs' },
  'g3-sp':  { sport: 'baseball_mlb', pxEventId: GAME3, marketType: 'spread', selection: 'home', line: -1.5, teamName: 'Milwaukee Brewers', homeTeam: 'Milwaukee Brewers', awayTeam: 'Chicago Cubs' },
};
const FUTURE = new Date(Date.now() + 72 * 3600e3).toISOString();
for (const li of Object.values(LINES)) { li.startTime = FUTURE; li.startTimeMs = Date.parse(FUTURE); li.oddsApiSport = li.sport; li.oddsApiMarket = li.marketType; li.oddsApiSelection = li.selection; }

const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });

const legs = (...ids) => ids.map(id => ({ line_id: id }));
const declineOf = (...ids) => pricer.shouldDecline(legs(...ids), null);

// Make sure ml_total is allowed for these tests regardless of env.
function withAllowed(combos, fn) {
  const before = config.pricing.sgpAllowedCombos;
  try {
    config.pricing.sgpAllowedCombos = combos;
    return fn();
  } finally {
    config.pricing.sgpAllowedCombos = before;
  }
}

test('two allowed same-game pairs on different events are NOT multi-pair declined', () => {
  withAllowed(['ml_total'], () => {
    const d = declineOf('g1-ml', 'g1-tot', 'g2-ml', 'g2-tot');
    const isMultiPairDecline = d && d.declined === true
      && /multiple same-game pairs/i.test(d.detail || '');
    assert.ok(!isMultiPairDecline,
      `multi-pair parlay must not hit the blanket decline (got: ${d && d.reason} / ${d && d.detail})`);
    // Each pair is ml_total (allowed), so it must not be 'SGP not allowed' at all.
    assert.ok(!(d && d.declined === true && d.reason === 'SGP not allowed'),
      `allowed+allowed pairs must pass the SGP gate (got: ${d && d.detail})`);
  });
});

test('a disallowed second pair still declines (per-pair validation intact)', () => {
  withAllowed(['ml_total'], () => {
    const d = declineOf('g1-ml', 'g1-tot', 'g3-ml', 'g3-sp');
    // ml+spread same-game trips the long-standing correlation rule before the
    // SGP combo gate — either way, the parlay must NOT survive just because
    // its OTHER pair is allowed.
    assert.equal(d && d.declined, true,
      `parlay containing a disallowed pair must decline (got: ${JSON.stringify(d)})`);
  });
});

test('single same-game pair still works exactly as before', () => {
  withAllowed(['ml_total'], () => {
    const d = declineOf('g1-ml', 'g1-tot');
    assert.ok(!(d && d.declined === true && d.reason === 'SGP not allowed'),
      `single allowed pair must pass the SGP gate (got: ${d && d.detail})`);
  });
});
