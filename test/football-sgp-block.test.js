// Regression tests: football correlation guards (NFL_CFB_READINESS_2026-08-05.md,
// "Correlation rules that MUST land before football SGPs").
//
// Three explicit pre-passes in pricer.shouldDecline, none of which may depend
// on the generic SGP gate (that gate declines most of these today only because
// no key in SGP_ALLOWED_COMBOS happens to match — incidental protection that
// evaporates the moment someone adds a combo key; the MoV/tennis lesson):
//
//   football_sgp_blocked        — every same-pxEventId football pair; released
//                                 ONLY by config.pricing.footballSgpEnabled === true
//   football_period_sgp_blocked — UNCONDITIONAL; the measured trap is a
//                                 "Second Half Moneyline" leg whose marketType
//                                 is silently the full-game string 'moneyline'
//                                 (would price at ~2x true — measured end-to-end)
//   football_futures_nested     — UNCONDITIONAL; keyed on TEAM/PLAYER, not
//                                 pxEventId. PX futures (SB/AFC/NFC/MVP/win
//                                 totals) are DISTINCT competitor-less events,
//                                 so "KC win Super Bowl + KC win AFC" is
//                                 invisible to every pxEventId-keyed gate.
//
// Legs are passed RAW ({line_id}) exactly as PX sends them, because the guard
// resolving raw legs is the whole point: the golf nesting guard silently never
// fired in production for weeks by reading a pre-resolved shape that only
// existed in tests.
//
// Run: node --test test/football-sgp-block.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

const PRESEASON = 'americanfootball_nfl_preseason';
const NFL = 'americanfootball_nfl';

// --- Fake line index -------------------------------------------------------
// Game A (event 800) = CAR @ ARI preseason, the measured 14-market shape.
// Game B (event 801) = LAC @ HOU preseason. Game C (event 802) = a KC game.
// Futures = distinct competitor-less events, one team/player per market
// (SB 950, AFC 951, MVP 952, win totals 953, OPOY 954, no-identity 955).
const GAME_A = 800, GAME_B = 801, GAME_C = 802;
const LINES = {
  // -- Game A: full-game legs
  'gA-ml':     { sport: PRESEASON, pxEventId: GAME_A, marketType: 'moneyline', selection: 'home', teamName: 'Arizona Cardinals', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Moneyline', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  'gA-spread': { sport: PRESEASON, pxEventId: GAME_A, marketType: 'spread', selection: 'home', line: -1.5, teamName: 'Arizona Cardinals', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Spread', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  'gA-total':  { sport: PRESEASON, pxEventId: GAME_A, marketType: 'total', selection: 'over', line: 35.5, teamName: 'Over', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Total Points', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  // Full-game total whose name carries the OT-INCLUSIVE qualifier — must NOT
  // be mistaken for a period market.
  'gA-total-inclot': { sport: PRESEASON, pxEventId: GAME_A, marketType: 'total', selection: 'over', line: 35.5, teamName: 'Over', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Total Points (Incl. Overtime)', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  // -- Game A: period legs, one per detection channel
  // THE measured trap: marketType is the full-game string, only the NAME says 2H.
  'gA-2h-ml':  { sport: PRESEASON, pxEventId: GAME_A, marketType: 'moneyline', selection: 'home', teamName: 'Arizona Cardinals', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Second Half Moneyline', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  // Correctly retagged marketType, deliberately BLAND name — marketType channel.
  'gA-1h-spread': { sport: PRESEASON, pxEventId: GAME_A, marketType: 'first_half_spread', selection: 'home', line: -0.5, teamName: 'Arizona Cardinals', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Spread', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  // Period identified ONLY by the pxEventName suffix — pxEventName channel.
  'gA-2h-ev':  { sport: PRESEASON, pxEventId: GAME_A, marketType: 'total', selection: 'under', line: 16.5, teamName: 'Under', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Total Points', pxEventName: 'Carolina Panthers at Arizona Cardinals - Second Half' },
  'gA-1q-ml':  { sport: PRESEASON, pxEventId: GAME_A, marketType: 'moneyline', selection: 'away', teamName: 'Carolina Panthers', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: '1st Quarter Moneyline', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  'gA-ot-ml':  { sport: PRESEASON, pxEventId: GAME_A, marketType: 'moneyline', selection: 'home', teamName: 'Arizona Cardinals', homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', marketName: 'Overtime Moneyline', pxEventName: 'Carolina Panthers at Arizona Cardinals' },
  // -- Game B
  'gB-ml':     { sport: PRESEASON, pxEventId: GAME_B, marketType: 'moneyline', selection: 'home', teamName: 'Houston Texans', homeTeam: 'Houston Texans', awayTeam: 'Los Angeles Chargers', marketName: 'Moneyline', pxEventName: 'Los Angeles Chargers at Houston Texans' },
  'gB-total':  { sport: PRESEASON, pxEventId: GAME_B, marketType: 'total', selection: 'over', line: 36.5, teamName: 'Over', homeTeam: 'Houston Texans', awayTeam: 'Los Angeles Chargers', marketName: 'Total Points', pxEventName: 'Los Angeles Chargers at Houston Texans' },
  'gB-2h-ml':  { sport: PRESEASON, pxEventId: GAME_B, marketType: 'moneyline', selection: 'home', teamName: 'Houston Texans', homeTeam: 'Houston Texans', awayTeam: 'Los Angeles Chargers', marketName: 'Second Half Moneyline', pxEventName: 'Los Angeles Chargers at Houston Texans' },
  // -- Game C: a regular game involving KC (for the futures+game-leg case)
  'gC-kc-ml':  { sport: NFL, pxEventId: GAME_C, marketType: 'moneyline', selection: 'home', teamName: 'Kansas City Chiefs', homeTeam: 'Kansas City Chiefs', awayTeam: 'Los Angeles Rams', marketName: 'Moneyline', pxEventName: 'Los Angeles Rams at Kansas City Chiefs' },
  // -- Futures: competitor-less, one market per team/player, DISTINCT events.
  // PX abbreviates ("KC Chiefs") — the guard must still collide it with the
  // full form via the nickname token.
  'fut-kc-sb':   { sport: NFL, pxEventId: 950, marketType: 'outright', selection: 'yes', teamName: 'KC Chiefs', homeTeam: null, awayTeam: null, marketName: 'KC Chiefs', pxEventName: 'NFL - Super Bowl Winner' },
  'fut-nyg-sb':  { sport: NFL, pxEventId: 950, marketType: 'outright', selection: 'yes', teamName: 'New York Giants', homeTeam: null, awayTeam: null, marketName: 'New York Giants', pxEventName: 'NFL - Super Bowl Winner' },
  'fut-kc-afc':  { sport: NFL, pxEventId: 951, marketType: 'outright', selection: 'yes', teamName: 'Kansas City Chiefs', homeTeam: null, awayTeam: null, marketName: 'Kansas City Chiefs', pxEventName: 'NFL - AFC Conference Winner' },
  'fut-buf-afc': { sport: NFL, pxEventId: 951, marketType: 'outright', selection: 'yes', teamName: 'Buffalo Bills', homeTeam: null, awayTeam: null, marketName: 'Buffalo Bills', pxEventName: 'NFL - AFC Conference Winner' },
  'fut-nyj-afc': { sport: NFL, pxEventId: 951, marketType: 'outright', selection: 'yes', teamName: 'New York Jets', homeTeam: null, awayTeam: null, marketName: 'New York Jets', pxEventName: 'NFL - AFC Conference Winner' },
  // Win total registered with a GAME-ish marketType — competitor-less shape
  // must still mark it futures, and the market-noise words ("Wins Over 10.5")
  // must not poison the identity tokens.
  'fut-kc-wt':   { sport: NFL, pxEventId: 953, marketType: 'total', selection: 'over', line: 10.5, teamName: 'Kansas City Chiefs', homeTeam: null, awayTeam: null, marketName: 'Kansas City Chiefs Regular Season Wins Over 10.5', pxEventName: 'NFL - Win Totals' },
  // Player futures. OPOY's name matches NO futures token and its marketType is
  // 'moneyline' (the sup_moneyline trap) — competitor-less detection only.
  'fut-mahomes-mvp':  { sport: NFL, pxEventId: 952, marketType: 'outright', selection: 'yes', playerName: 'Patrick Mahomes', teamName: 'Patrick Mahomes', homeTeam: null, awayTeam: null, marketName: 'Patrick Mahomes', pxEventName: 'NFL - MVP' },
  'fut-mahomes-opoy': { sport: NFL, pxEventId: 954, marketType: 'moneyline', selection: 'yes', playerName: 'Patrick Mahomes', teamName: 'Patrick Mahomes', homeTeam: null, awayTeam: null, marketName: 'Patrick Mahomes', pxEventName: 'NFL - Offensive Player of the Year' },
  // Futures-shaped leg with NO resolvable team/player identity.
  'fut-noid':    { sport: NFL, pxEventId: 955, marketType: 'outright', selection: 'yes', teamName: null, playerName: null, homeTeam: null, awayTeam: null, marketName: 'To Win The North Division', pxEventName: 'NFL - Division Winners' },
};
// startTime far in the future so the "event started" gate never interferes.
const FUTURE = new Date(Date.now() + 72 * 3600e3).toISOString();
for (const li of Object.values(LINES)) { li.startTime = FUTURE; li.startTimeMs = Date.parse(FUTURE); li.oddsApiSport = li.sport; li.oddsApiMarket = li.marketType; li.oddsApiSelection = li.selection; }

const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });

const legs = (...ids) => ids.map(id => ({ line_id: id }));
const declineOf = (...ids) => pricer.shouldDecline(legs(...ids), null);

const FOOTBALL_REASONS = new Set(['football_sgp_blocked', 'football_period_sgp_blocked', 'football_futures_nested']);
const assertNotFootballBlocked = (d, label) => {
  assert.ok(!d || d.declined !== true || !FOOTBALL_REASONS.has(d.reason),
    `${label} must not hit a football guard (got ${d && d.reason})`);
};

// Knob mutation helpers. footballSgpEnabled does not exist in config.js yet
// (the entry is owned by another agent) — absence IS the production default
// under test, so restore by deleting.
const withKnob = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(config.pricing, 'footballSgpEnabled');
  const prev = config.pricing.footballSgpEnabled;
  config.pricing.footballSgpEnabled = value;
  try { return fn(); } finally {
    if (had) config.pricing.footballSgpEnabled = prev;
    else delete config.pricing.footballSgpEnabled;
  }
};

// --- Block 1: football_sgp_blocked (same event, env-releasable) ------------

test('same-game football ML + total declines with the knob ABSENT (absence-safe: undefined = blocked)', () => {
  // Force the knob out of config entirely — integration order with the
  // config.js entry is not guaranteed, and the guard must block when the
  // property simply does not exist.
  const had = Object.prototype.hasOwnProperty.call(config.pricing, 'footballSgpEnabled');
  const prev = config.pricing.footballSgpEnabled;
  delete config.pricing.footballSgpEnabled;
  try {
    const d = declineOf('gA-ml', 'gA-total');
    assert.equal(d.declined, true);
    assert.equal(d.reason, 'football_sgp_blocked');
  } finally {
    if (had) config.pricing.footballSgpEnabled = prev;
  }
});

test('same-game football spread + total declines (spread_total IS in default SGP_ALLOWED_COMBOS — the block must not care)', () => {
  const d = declineOf('gA-spread', 'gA-total');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_sgp_blocked');
});

test('block holds when football combos are force-added to SGP_ALLOWED_COMBOS', () => {
  const before = [...(config.pricing.sgpAllowedCombos || [])];
  try {
    config.pricing.sgpAllowedCombos = [...before, 'ml_total', 'spread_total', 'ml_spread', 'unclassified'];
    for (const pair of [['gA-ml', 'gA-total'], ['gA-spread', 'gA-total'], ['gA-ml', 'gA-spread']]) {
      const d = declineOf(...pair);
      assert.equal(d.declined, true, `${pair.join(' + ')} must decline regardless of the combo list`);
      assert.equal(d.reason, 'football_sgp_blocked');
    }
  } finally {
    config.pricing.sgpAllowedCombos = before;
  }
});

test('footballSgpEnabled=false blocks; the STRING "true" also blocks (only literal true releases)', () => {
  for (const v of [false, 'true', 1, 'yes']) {
    withKnob(v, () => {
      const d = declineOf('gA-ml', 'gA-total');
      assert.equal(d.declined, true, `knob=${JSON.stringify(v)} must still block`);
      assert.equal(d.reason, 'football_sgp_blocked');
    });
  }
});

test('footballSgpEnabled=true releases the blanket same-game block', () => {
  withKnob(true, () => {
    // spread_total is in default SGP_ALLOWED_COMBOS, so with the blanket block
    // released this pair must clear ALL football guards (it may still decline
    // downstream for non-football reasons — exposure etc.).
    assertNotFootballBlocked(declineOf('gA-spread', 'gA-total'), 'released spread+total');
    const d = declineOf('gA-ml', 'gA-total');
    assert.notEqual(d.reason, 'football_sgp_blocked', 'released ml+total must not hit the blanket block (generic gate may still decline it as ml_total)');
  });
});

test('a cross-game leg does not rescue a parlay containing a same-game football pair', () => {
  const d = declineOf('gA-ml', 'gA-total', 'gB-ml');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_sgp_blocked');
});

// --- Block 2: football_period_sgp_blocked (unconditional) -------------------

test('THE measured trap: "Second Half Moneyline" with full-game marketType + full-game total declines', () => {
  const d = declineOf('gA-2h-ml', 'gA-total');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('period block survives footballSgpEnabled=true AND force-allowed combos (never releasable)', () => {
  const before = [...(config.pricing.sgpAllowedCombos || [])];
  try {
    config.pricing.sgpAllowedCombos = [...before, 'ml_total', 'spread_total', 'ml_spread', 'unclassified'];
    withKnob(true, () => {
      for (const pair of [['gA-2h-ml', 'gA-total'], ['gA-1h-spread', 'gA-ml'], ['gA-1q-ml', 'gA-total']]) {
        const d = declineOf(...pair);
        assert.equal(d.declined, true, `${pair.join(' + ')} must decline with the flag on`);
        assert.equal(d.reason, 'football_period_sgp_blocked');
      }
    });
  } finally {
    config.pricing.sgpAllowedCombos = before;
  }
});

test('period detected via retagged marketType alone (bland market name)', () => {
  const d = declineOf('gA-1h-spread', 'gA-ml');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('period detected via pxEventName alone (event-name suffix carries the period)', () => {
  const d = declineOf('gA-2h-ev', 'gA-ml');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('quarter leg + full-game leg declines', () => {
  const d = declineOf('gA-1q-ml', 'gA-total');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('overtime market + full-game leg declines', () => {
  const d = declineOf('gA-ot-ml', 'gA-ml');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('two period legs same game decline (period vs period is nested too)', () => {
  const d = declineOf('gA-2h-ml', 'gA-1h-spread');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('"Total Points (Incl. Overtime)" is a FULL-GAME qualifier, not a period market', () => {
  // Same-event pairing with the blanket block released: if the incl-OT total
  // were misread as a period leg this would return football_period_sgp_blocked.
  withKnob(true, () => {
    const d = declineOf('gA-total-inclot', 'gA-ml');
    assert.notEqual(d && d.reason, 'football_period_sgp_blocked', 'OT-inclusive full-game total must not trip the period guard');
  });
  // And cross-game it must clear everything football.
  assertNotFootballBlocked(declineOf('gA-total-inclot', 'gB-ml'), 'incl-OT total cross-game');
});

test('a cross-game leg does not rescue a parlay containing a same-game period pair', () => {
  const d = declineOf('gA-2h-ml', 'gA-total', 'gB-ml');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_period_sgp_blocked');
});

test('a lone period leg is NOT period-blocked (nothing same-game to nest with)', () => {
  assertNotFootballBlocked(declineOf('gA-2h-ml'), 'lone period leg');
});

test('period leg + CROSS-game leg is not football-blocked (nesting is same-event only)', () => {
  assertNotFootballBlocked(declineOf('gA-2h-ml', 'gB-ml'), 'period + other game');
});

// --- Block 3: football_futures_nested (team/player-keyed, unconditional) ----

test('SAME TEAM across distinct futures events declines: "KC Chiefs" SB + "Kansas City Chiefs" AFC (abbreviation must still collide)', () => {
  const d = declineOf('fut-kc-sb', 'fut-kc-afc');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_futures_nested');
});

test('SB + win total on one team declines (win-total noise words must not hide the team)', () => {
  const d = declineOf('fut-kc-sb', 'fut-kc-wt');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_futures_nested');
});

test('same PLAYER across futures events declines (MVP + OPOY), incl. the competitor-less-only detection path', () => {
  const d = declineOf('fut-mahomes-mvp', 'fut-mahomes-opoy');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_futures_nested');
});

test('futures block survives footballSgpEnabled=true AND force-allowed combos (never releasable)', () => {
  const before = [...(config.pricing.sgpAllowedCombos || [])];
  try {
    config.pricing.sgpAllowedCombos = [...before, 'ml_total', 'spread_total', 'unclassified'];
    withKnob(true, () => {
      const d = declineOf('fut-kc-sb', 'fut-kc-afc');
      assert.equal(d.declined, true);
      assert.equal(d.reason, 'football_futures_nested');
    });
  } finally {
    config.pricing.sgpAllowedCombos = before;
  }
});

test('futures leg with NO resolvable identity in a multi-futures parlay fails CLOSED', () => {
  const d = declineOf('fut-noid', 'fut-kc-sb');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'football_futures_nested');
});

test('DIFFERENT teams across distinct futures events stay allowed (KC SB + BUF AFC)', () => {
  assertNotFootballBlocked(declineOf('fut-kc-sb', 'fut-buf-afc'), 'KC SB + BUF AFC');
});

test('shared-CITY different teams stay allowed (NY Giants SB + NY Jets AFC — city tokens must not collide)', () => {
  assertNotFootballBlocked(declineOf('fut-nyg-sb', 'fut-nyj-afc'), 'NYG SB + NYJ AFC');
});

test('futures leg + a regular GAME leg on the same team is not futures-blocked (guard is futures-vs-futures only)', () => {
  const d = declineOf('fut-kc-sb', 'gC-kc-ml');
  assert.notEqual(d && d.reason, 'football_futures_nested', 'futures + game leg is outside the futures guard');
});

test('a single futures leg is not blocked by any football guard', () => {
  assertNotFootballBlocked(declineOf('fut-kc-sb'), 'lone futures leg');
});

// --- Cross-game football parlays must survive -------------------------------

test('cross-game football parlay is NOT football-blocked (different events are independent)', () => {
  assertNotFootballBlocked(declineOf('gA-ml', 'gB-ml'), 'cross-game ML + ML');
  assertNotFootballBlocked(declineOf('gA-spread', 'gB-total'), 'cross-game spread + total');
});

test('a single football leg is not blocked (nothing to correlate with)', () => {
  assertNotFootballBlocked(declineOf('gA-ml'), 'lone football ML');
});
