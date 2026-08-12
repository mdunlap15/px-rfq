// Football (NFL/preseason/NCAAF/CFL) line registration + prop plumbing.
//
// Locks the NFL_CFB_READINESS_2026-08-05.md fixes that live in
// services/line-manager.js and services/websocket.js:
//
//   T1.4  — TOTAL_BOUNDS_BY_SPORT / MAX_SPREAD_BY_SPORT football entries
//   T2.x  — substring team-match ambiguity (exactly one match or fail) and the
//           abbreviation-aware team-total side resolution. The measured
//           collision: PX abbreviates football team totals ("ARI: Team Total
//           Points" / "CAR: Team Total Points") and "CAR" is a substring of
//           BOTH "CARolina" and "CARdinals" — both registered as Arizona.
//   T3.x  — football prop plumbing: classifier + misroute fixes (an NBA
//           classifier that reads "To" as turnovers, an NHL classifier that
//           reads "Field Goals Made" as goals), YES→over remap, one-sided
//           book-mirror registration, and the marketType registration
//           assertion (the BTTS/MoV/tennis-sets trap, fourth occurrence).
//   T1.8  — advertise-and-decline: football lines with no consensus market
//           behind them (team totals / H1 before their supplement, 2H always)
//           must fail closed AT REGISTRATION (PX Rule 2 surface).
//
// The seed scenarios drive the REAL seedAllLines/refreshLines loop — real
// px.parseMarketSelections, real matching, real registration guards — with
// px/oddsFeed/db stubbed at the module boundary, mirroring how
// test/mov-sgp-block.test.js stubs the line index rather than re-imagining
// the production shapes.
//
// Run: node --test test/football-lines.test.js

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const ws = require('../services/websocket');
const px = require('../services/prophetx');
const oddsFeed = require('../services/odds-feed');
const db = require('../services/db');
const { config } = require('../config');

const SPORT = 'americanfootball_nfl_preseason';

// ---------------------------------------------------------------------------
// T1.4 — line bounds
// ---------------------------------------------------------------------------

test('football totals bounds: NFL/preseason [30,65], NCAAF [30,90], CFL [35,70]', () => {
  const ok = lineManager._isValidFullGameLine;
  for (const s of ['americanfootball_nfl', 'americanfootball_nfl_preseason']) {
    assert.equal(ok(s, 'total', 43.5), true, s + ' 43.5 in bounds');
    assert.equal(ok(s, 'total', 16.5), false, s + ' 2H-sized 16.5 rejected');
    assert.equal(ok(s, 'total', 71.5), false, s + ' 71.5 rejected');
  }
  assert.equal(ok('americanfootball_ncaaf', 'total', 75.5), true, 'CFB shootout total');
  assert.equal(ok('americanfootball_ncaaf', 'total', 95.5), false);
  assert.equal(ok('americanfootball_cfl', 'total', 50.5), true);
  assert.equal(ok('americanfootball_cfl', 'total', 30.5), false);
});

test('football spread bounds: nfl/preseason 21, ncaaf 45, cfl 30', () => {
  const ok = lineManager._isValidFullGameLine;
  assert.equal(ok('americanfootball_nfl', 'spread', -17.5), true);
  assert.equal(ok('americanfootball_nfl', 'spread', -24.5), false);
  assert.equal(ok('americanfootball_nfl_preseason', 'spread', 2.5), true);
  assert.equal(ok('americanfootball_nfl_preseason', 'spread', 27.5), false);
  assert.equal(ok('americanfootball_ncaaf', 'spread', -38.5), true);
  assert.equal(ok('americanfootball_ncaaf', 'spread', -49.5), false);
  assert.equal(ok('americanfootball_cfl', 'spread', -22.5), true);
  assert.equal(ok('americanfootball_cfl', 'spread', -33.5), false);
});

test('team_total keeps permissive bounds (NFL team totals sit ~14-30)', () => {
  assert.equal(lineManager._isValidFullGameLine(SPORT, 'team_total', 21.5), true);
  assert.equal(lineManager._isValidFullGameLine(SPORT, 'team_total', 17.5), true);
});

// ---------------------------------------------------------------------------
// Substring-containment ambiguity (matchTeamName)
// ---------------------------------------------------------------------------

test('matchTeamName: "CAR" is ambiguous vs Cardinals+Carolina → null, never first-hit', () => {
  // Before the fix this returned whichever name the odds cache listed first
  // ("CAR" ⊂ "CARdinals" and ⊂ "CARolina").
  assert.equal(lineManager.matchTeamName('CAR', ['Arizona Cardinals', 'Carolina Panthers']), null);
  assert.equal(lineManager.matchTeamName('CAR', ['Carolina Panthers', 'Arizona Cardinals']), null,
    'must be order-independent');
});

test('matchTeamName: unique substring still resolves', () => {
  assert.equal(lineManager.matchTeamName('Cardinals', ['Arizona Cardinals', 'Carolina Panthers']),
    'Arizona Cardinals');
  assert.equal(lineManager.matchTeamName('ARI', ['Arizona Cardinals', 'Carolina Panthers']),
    'Arizona Cardinals', '"ARI" ⊂ ARIzona only — unambiguous');
});

test('matchTeamName: bare CFB school names fail closed instead of first-hit (Michigan trap)', () => {
  const teams = ['Michigan Wolverines', 'Central Michigan Chippewas', 'Eastern Michigan Eagles'];
  assert.equal(lineManager.matchTeamName('Michigan', teams), null,
    'ambiguous school name must go dark, not resolve by cache order');
  assert.equal(lineManager.matchTeamName('Michigan Wolverines', teams), 'Michigan Wolverines',
    'school + mascot stays exact');
});

test('matchTeamName: last-N-words regression — Red Sox still resolves next to White Sox', () => {
  assert.equal(lineManager.matchTeamName('Red Sox', ['Boston Red Sox', 'Chicago White Sox']),
    'Boston Red Sox');
});

// ---------------------------------------------------------------------------
// Abbreviation-aware team-total side resolution (the mandated ARI/CAR test)
// ---------------------------------------------------------------------------

test('team-total sides: ARI and CAR MUST resolve to different teams', () => {
  const side = lineManager._resolveTeamTotalSide;
  // Arizona home (the real 2026-08-06 preseason orientation)
  assert.equal(side('ARI', 'Arizona Cardinals', 'Carolina Panthers'), 'home');
  assert.equal(side('CAR', 'Arizona Cardinals', 'Carolina Panthers'), 'away',
    'the measured collision: CAR matched Cardinals via substring and stamped BOTH team totals on Arizona');
  // Flipped orientation — must follow the teams, not the argument slots
  assert.equal(side('ARI', 'Carolina Panthers', 'Arizona Cardinals'), 'away');
  assert.equal(side('CAR', 'Carolina Panthers', 'Arizona Cardinals'), 'home');
});

test('team-total sides: unresolvably ambiguous abbreviation fails closed', () => {
  assert.equal(lineManager._resolveTeamTotalSide('NEW', 'New York Giants', 'New England Patriots'), null,
    '"NEW" prefixes both — must return null, not home-by-check-order');
});

test('team-total sides: existing sports regressions hold', () => {
  const side = lineManager._resolveTeamTotalSide;
  assert.equal(side('SJ', 'San Jose Sharks', 'Vegas Golden Knights'), 'home');
  assert.equal(side('VAN', 'Calgary Flames', 'Vancouver Canucks'), 'away');
  assert.equal(side('Phillies', 'Philadelphia Phillies', 'New York Mets'), 'home');
  assert.equal(side('Philadelphia Phillies', 'Philadelphia Phillies', 'New York Mets'), 'home');
});

// ---------------------------------------------------------------------------
// Classifier misroutes (measured) + football classifier
// ---------------------------------------------------------------------------

test('MEASURED MISROUTE FIXES: football names return null from other sports\' classifiers', () => {
  // classifyNbaProp read the word "To" via /\btos?\b/ → 'turnovers'
  assert.equal(ws._classifyNbaProp('Bijan Robinson To Score a Touchdown'), null);
  // classifyNhlProp read "Field Goals Made" → 'goals'
  assert.equal(ws._classifyNhlProp('Justin Tucker Field Goals Made'), null);
  // classifyMlbProp read "To Score" → 'hitter_other'
  assert.equal(ws._classifyMlbProp('Jeremiah Love To Score a Touchdown'), null);
  // A few more football shapes that must not classify elsewhere
  assert.equal(ws._classifyNbaProp('Patrick Mahomes Passing Yards'), null);
  assert.equal(ws._classifyMlbProp('Bijan Robinson Rushing Yards'), null);
  assert.equal(ws._classifyNhlProp('Ja\'Marr Chase Receptions'), null);
});

test('NBA classifier: own-sport names unchanged', () => {
  assert.equal(ws._classifyNbaProp('LeBron James Total Points'), 'points');
  assert.equal(ws._classifyNbaProp('Nikola Jokic Total Rebounds'), 'rebounds');
  assert.equal(ws._classifyNbaProp('Jalen Brunson Turnovers'), 'turnovers');
  assert.equal(ws._classifyNbaProp('Stephen Curry Made Threes'), 'threes_made');
  assert.equal(ws._classifyNbaProp('Nikola Jokic Points + Rebounds + Assists'), 'pra_combo');
  assert.equal(ws._classifyNbaProp('Russell Westbrook Triple Double'), 'triple_double');
  // NBA "Field Goals Made" is a REAL NBA stat — must stay in the NBA bucket
  // (the field-goal null guard is NHL-only).
  assert.equal(ws._classifyNbaProp('Jayson Tatum Field Goals Made'), 'other_nba_prop');
});

test('NHL classifier: own-sport names unchanged', () => {
  assert.equal(ws._classifyNhlProp('Auston Matthews Shots on Goal'), 'shots_on_goal');
  assert.equal(ws._classifyNhlProp('Leon Draisaitl Goals'), 'goals');
  assert.equal(ws._classifyNhlProp('Connor McDavid Total Points'), 'points');
  assert.equal(ws._classifyNhlProp('Igor Shesterkin Goalie Saves'), 'saves');
});

test('MLB classifier: own-sport names unchanged', () => {
  assert.equal(ws._classifyMlbProp('Tarik Skubal Pitching Strikeouts'), 'pitcher_strikeouts');
  assert.equal(ws._classifyMlbProp('Aaron Judge Home Runs'), 'hitter_hr');
  assert.equal(ws._classifyMlbProp('Mookie Betts Total Bases'), 'hitter_total_bases');
  assert.equal(ws._classifyMlbProp('Randy Arozarena Total Hits, Runs & RBIs'), 'hitter_other');
  assert.equal(ws._classifyMlbProp('Freddie Freeman Hits + Runs + RBIs'), 'hitter_hits_runs_rbis');
  // "To Score a Run" is a real MLB shape and keeps its old bucket
  assert.equal(ws._classifyMlbProp('Juan Soto Runs Scored'), 'hitter_rbi_runs');
});

test('football classifier: anytime TD routes, composites and game markets do not', () => {
  assert.equal(ws._classifyFootballProp('Bijan Robinson To Score a Touchdown'), 'anytime_td');
  assert.equal(ws._classifyFootballProp('Jeremiah Love To Score A Touchdown?'), 'anytime_td',
    'PX posts the market with a trailing question mark');
  // Multi-player OR market is unpriceable by construction — must NOT classify
  assert.equal(ws._classifyFootballProp('Kenny Pickett or Carson Beck To Throw An Interception?'), null);
  // Single-player INT gets a visibility bucket (no TOA mapping → never registers)
  assert.equal(ws._classifyFootballProp('Kenny Pickett To Throw An Interception?'), 'interception_thrown');
  assert.equal(ws._classifyFootballProp('Justin Tucker Field Goals Made'), 'field_goals_made');
  // Game markets must return null so the prop routers skip them
  assert.equal(ws._classifyFootballProp('Moneyline'), null);
  assert.equal(ws._classifyFootballProp('Total Points'), null);
  assert.equal(ws._classifyFootballProp('ARI: Team Total Points'), null);
  assert.equal(ws._classifyFootballProp('Second Half Total Points'), null);
});

test('player-name extraction handles the TD phrasing', () => {
  assert.equal(ws._extractPlayerNameFromPropMarket('Bijan Robinson To Score a Touchdown'), 'Bijan Robinson');
  assert.equal(ws._extractPlayerNameFromPropMarket('Jeremiah Love To Score A Touchdown?'), 'Jeremiah Love');
});

// ---------------------------------------------------------------------------
// Prop plumbing constants + registration-safety assertion
// ---------------------------------------------------------------------------

test('football prop → TOA map carries anytime_td ONLY (nothing else has a source)', () => {
  assert.deepEqual(lineManager._FOOTBALL_PROP_TO_TOA_MARKET, { anytime_td: 'player_anytime_td' });
  assert.deepEqual(lineManager._footballPropCtx('anytime_td'),
    { propType: 'anytime_td', line: 0.5, toaLine: null },
    'anytime = Over 0.5 registered, NULL TOA query line (outcomes carry no point)');
  assert.equal(lineManager._footballPropCtx('passing_yards'), null, 'unmapped props fail closed');
});

test('registration assertion: game marketTypes are forbidden for football props', () => {
  for (const bad of ['moneyline', 'spread', 'total', 'team_total', 'sup_moneyline', '', null, undefined]) {
    assert.equal(lineManager._footballPropRegistrationSafe(bad), false, `'${bad}' must be refused`);
  }
  assert.equal(lineManager._footballPropRegistrationSafe('player_anytime_td'), true);
  assert.equal(lineManager._propMarketType('anytime_td'), 'player_anytime_td',
    'the football propType can only ever produce a player_* marketType');
});

test('registration assertion is ABSENCE-SAFE: missing prophetx helper fails closed', () => {
  const orig = px.isFootballPropMarketTypeSafe;
  try {
    px.isFootballPropMarketTypeSafe = undefined;
    assert.equal(lineManager._footballPropRegistrationSafe('player_anytime_td'), false,
      'integration order is not guaranteed — no helper, no football prop registration');
  } finally {
    px.isFootballPropMarketTypeSafe = orig;
  }
});

// ---------------------------------------------------------------------------
// End-to-end seed scenarios (REAL seedAllLines / refreshLines, stubbed I/O)
// ---------------------------------------------------------------------------

const SCHED = new Date(Date.now() + 24 * 3600e3).toISOString();
const grp = (arr) => [arr];

const PX_EVENT = {
  event_id: 19453,
  name: 'Carolina Panthers at Arizona Cardinals',
  sport_name: 'American Football',
  scheduled: SCHED,
  status: 'not_started',
  competitors: [
    { id: 101, name: 'Arizona Cardinals', side: 'home' },
    { id: 102, name: 'Carolina Panthers', side: 'away' },
  ],
};

// The FULL measured market shape from the 2026-08-06 preseason probe:
// full game ML/spread/total, both team totals (PX-abbreviated), 2H, 1Q,
// and the two sup_moneyline props.
function pxMarketsFixture() {
  return [
    { id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
      { line_id: 'ml-ari', name: 'Arizona Cardinals', display_name: 'Arizona Cardinals', competitor_id: 101 },
      { line_id: 'ml-car', name: 'Carolina Panthers', display_name: 'Carolina Panthers', competitor_id: 102 },
    ]) },
    { id: 2, name: 'Spread', type: 'spread', market_lines: [
      { line: -2.5, selections: grp([
        { line_id: 'sp-ari', name: 'Arizona Cardinals -2.5', line: -2.5, competitor_id: 101 },
        { line_id: 'sp-car', name: 'Carolina Panthers +2.5', line: 2.5, competitor_id: 102 },
      ]) },
    ] },
    { id: 3, name: 'Total Points', type: 'total', market_lines: [
      { line: 43.5, selections: grp([
        { line_id: 'tot-o', name: 'Over 43.5', line: 43.5 },
        { line_id: 'tot-u', name: 'Under 43.5', line: 43.5 },
      ]) },
    ] },
    { id: 4, name: 'ARI: Team Total Points', type: 'total', market_lines: [
      { line: 21.5, selections: grp([
        { line_id: 'tt-ari-o', name: 'Over 21.5', line: 21.5 },
        { line_id: 'tt-ari-u', name: 'Under 21.5', line: 21.5 },
      ]) },
    ] },
    { id: 5, name: 'CAR: Team Total Points', type: 'total', market_lines: [
      { line: 17.5, selections: grp([
        { line_id: 'tt-car-o', name: 'Over 17.5', line: 17.5 },
        { line_id: 'tt-car-u', name: 'Under 17.5', line: 17.5 },
      ]) },
    ] },
    // The measured 2x-mispricing landmine: 2H total 35.5 collides with the
    // full-game ladder. Must never register.
    { id: 6, name: 'Second Half Total Points', type: 'total', market_lines: [
      { line: 35.5, selections: grp([
        { line_id: '2h-o', name: 'Over 35.5', line: 35.5 },
        { line_id: '2h-u', name: 'Under 35.5', line: 35.5 },
      ]) },
    ] },
    { id: 7, name: '1st Quarter Moneyline', type: 'moneyline', selections: grp([
      { line_id: '1q-ari', name: 'Arizona Cardinals', competitor_id: 101 },
      { line_id: '1q-car', name: 'Carolina Panthers', competitor_id: 102 },
    ]) },
    { id: 8, name: 'Jeremiah Love To Score a Touchdown', type: 'sup_moneyline', selections: grp([
      { line_id: 'td-yes', name: 'Yes' },
      { line_id: 'td-no', name: 'No' },
    ]) },
    { id: 9, name: 'Kenny Pickett or Carson Beck To Throw An Interception?', type: 'sup_moneyline', selections: grp([
      { line_id: 'int-yes', name: 'Yes' },
      { line_id: 'int-no', name: 'No' },
    ]) },
  ];
}

let _seededOnce = false;

async function runSeed({ oddsMarkets, allowlist, propLookup, propOneSided, dropPxHelper } = {}) {
  const saved = [];
  const patch = (obj, key, val) => { saved.push([obj, key, obj[key]]); obj[key] = val; };

  const oddsEvt = {
    homeTeam: 'Arizona Cardinals',
    awayTeam: 'Carolina Panthers',
    commenceTime: SCHED,
    markets: oddsMarkets,
  };

  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [PX_EVENT]);
  patch(px, 'fetchMarkets', async () => pxMarketsFixture());
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => [
    { sport: SPORT, homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers', commenceTime: SCHED },
  ]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT ? oddsEvt : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', propLookup || (async () => null));
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', propOneSided || (async () => null));
  if (allowlist) patch(config.pricing, 'propLaunchAllowlist', allowlist);
  if (dropPxHelper) patch(px, 'isFootballPropMarketTypeSafe', undefined);
  // Belt-and-braces vs parallel config edits: the seed only sees the event if
  // the sportNameMap entry exists.
  if (config.sportNameMap[SPORT] !== 'American Football') {
    patch(config.sportNameMap, SPORT, 'American Football');
  }

  try {
    if (!_seededOnce) {
      _seededOnce = true;
      await lineManager.seedAllLines();
    } else {
      await lineManager.refreshLines(); // build-then-swap = clean index per scenario
    }
    // Return a copy — the live object mutates on later scenarios.
    return Object.assign({}, lineManager.__debugGetLineIndex());
  } finally {
    for (const [obj, key, val] of saved.reverse()) obj[key] = val;
  }
}

test('seed: full-game ML/spread/total register; 2H, 1Q, team totals (no consensus), props (no allowlist) do not', async () => {
  const idx = await runSeed({ oddsMarkets: { h2h: {}, spreads: {}, totals: {} } });

  // Full-game lines with odds coverage register (T1.8 scope check)
  assert.ok(idx['ml-ari'] && idx['ml-car'], 'moneyline registers both sides');
  assert.equal(idx['ml-ari'].oddsApiSelection, 'home');
  assert.equal(idx['ml-car'].oddsApiSelection, 'away');
  assert.equal(idx['ml-ari'].sport, SPORT);
  assert.ok(idx['sp-ari'] && idx['sp-car'], 'spread registers both sides');
  assert.equal(idx['sp-ari'].oddsApiSelection, 'home');
  assert.equal(idx['sp-car'].oddsApiSelection, 'away');
  assert.ok(idx['tot-o'] && idx['tot-u'], 'total registers both sides');
  assert.equal(idx['tot-o'].oddsApiMarket, 'totals');

  // The 2x-mispricing landmine: no Second Half line may EVER register
  assert.ok(!idx['2h-o'] && !idx['2h-u'], 'Second Half total must not register');
  for (const li of Object.values(idx)) {
    assert.ok(!/second\s*half/i.test(li.marketName || ''), 'no registered line may be a 2H market');
  }
  // Quarters excluded
  assert.ok(!idx['1q-ari'] && !idx['1q-car'], '1Q moneyline must not register');

  // T1.8: team totals have NO team_totals consensus market → fail closed at
  // registration (advertise-and-decline is a PX Rule 2 violation)
  assert.ok(!idx['tt-ari-o'] && !idx['tt-ari-u'] && !idx['tt-car-o'] && !idx['tt-car-u'],
    'team totals must not register without a team_totals consensus market');

  // Props: allowlist has no football entries → nothing registers
  assert.ok(!idx['td-yes'] && !idx['td-no'], 'anytime TD must not register with empty allowlist');
  assert.ok(!idx['int-yes'] && !idx['int-no'], 'OR-of-two-QBs market must never register');
});

test('seed: T1.8 fails ALL football lines closed when the odds event is missing entirely', async () => {
  const saved = [];
  const patch = (obj, key, val) => { saved.push([obj, key, obj[key]]); obj[key] = val; };
  try {
    // Odds cache has the teams (so matching succeeds) but getEventMarkets
    // returns markets-less events — nothing may register.
    const idx = await runSeed({ oddsMarkets: undefined });
    const footballLines = Object.values(idx).filter(li => (li.sport || '').startsWith('americanfootball'));
    assert.equal(footballLines.length, 0,
      'a football line with no consensus market behind it must not be advertised to PX');
  } finally {
    for (const [obj, key, val] of saved.reverse()) obj[key] = val;
  }
});

test('seed: team totals register on DIFFERENT teams once team_totals consensus exists (ARI/CAR collision)', async () => {
  const idx = await runSeed({ oddsMarkets: { h2h: {}, spreads: {}, totals: {}, team_totals: {} } });

  assert.ok(idx['tt-ari-o'] && idx['tt-ari-u'], 'ARI team total registers with consensus present');
  assert.ok(idx['tt-car-o'] && idx['tt-car-u'], 'CAR team total registers with consensus present');

  // The mandated collision test: ARI and CAR MUST resolve to different teams.
  assert.equal(idx['tt-ari-o'].teamName, 'Arizona Cardinals');
  assert.equal(idx['tt-car-o'].teamName, 'Carolina Panthers');
  assert.notEqual(idx['tt-ari-o'].teamName, idx['tt-car-o'].teamName,
    'measured bug: both team totals registered as Arizona (CAR ⊂ CARdinals)');
  assert.equal(idx['tt-ari-o'].oddsApiSelection, 'home_over');
  assert.equal(idx['tt-ari-u'].oddsApiSelection, 'home_under');
  assert.equal(idx['tt-car-o'].oddsApiSelection, 'away_over');
  assert.equal(idx['tt-car-u'].oddsApiSelection, 'away_under');
  assert.equal(idx['tt-ari-o'].line, 21.5);
  assert.equal(idx['tt-car-o'].line, 17.5);
});

test('seed: allowlisted anytime TD registers YES→over only, book-mirrored, marketType player_anytime_td', async () => {
  const raw = 0.45;
  const idx = await runSeed({
    oddsMarkets: { h2h: {}, spreads: {}, totals: {} },
    allowlist: new Set([SPORT + '.anytime_td']),
    propOneSided: async (sport, marketKey, ctx, playerName, line) => {
      assert.equal(sport, SPORT, 'football props source under their own sport key');
      assert.equal(marketKey, 'player_anytime_td');
      assert.equal(line, null, 'anytime markets must query TOA with a NULL line (outcomes carry no point)');
      assert.equal(playerName, 'Jeremiah Love');
      return {
        fairProbOver: 0.42,
        oneSidedSource: 'toa-one-sided',
        oneSidedRawAvgImplied: raw,
        books: ['draftkings', 'fanduel'],
        fetchedAt: Date.now(),
      };
    },
  });

  const td = idx['td-yes'];
  assert.ok(td, 'YES side registers when allowlisted and one-sided consensus exists');
  assert.equal(td.marketType, 'player_anytime_td');
  assert.ok(!['moneyline', 'spread', 'total', 'team_total'].includes(td.marketType),
    'the registration assertion: a football prop may never carry a game marketType');
  assert.equal(td.selection, 'over', 'YES remaps to over');
  assert.equal(td.line, 0.5, 'anytime semantics register at 0.5');
  assert.equal(td.playerName, 'Jeremiah Love');
  assert.equal(td.propType, 'anytime_td');
  assert.equal(td.propSource, 'toa-one-sided');
  const sweet = config.pricing.propBookMirrorSweetener != null ? config.pricing.propBookMirrorSweetener : 0.005;
  assert.ok(Math.abs(td.bookPriceOverride - raw * (1 - sweet)) < 1e-9,
    'book-mirror: quote the RAW posted consensus minus the sweetener');

  assert.ok(!idx['td-no'], 'NO side of a one-sided vigged market must stay unregistered');
  assert.ok(!idx['int-yes'] && !idx['int-no'], 'multi-player composite still never registers');
});

test('seed: anytime TD fails closed when no book consensus returns', async () => {
  const idx = await runSeed({
    oddsMarkets: { h2h: {}, spreads: {}, totals: {} },
    allowlist: new Set([SPORT + '.anytime_td']),
    propLookup: async () => null,
    propOneSided: async () => null,
  });
  assert.ok(!idx['td-yes'] && !idx['td-no'], 'no source → no registration → clean decline');
  assert.ok(idx['ml-ari'], 'game lines unaffected');
});

test('ADVERSARIAL seed: prophetx marketType-safety helper missing → football props fail closed end-to-end', async () => {
  const idx = await runSeed({
    oddsMarkets: { h2h: {}, spreads: {}, totals: {} },
    allowlist: new Set([SPORT + '.anytime_td']),
    dropPxHelper: true,
    propOneSided: async () => ({
      fairProbOver: 0.42,
      oneSidedSource: 'toa-one-sided',
      oneSidedRawAvgImplied: 0.45,
      books: ['draftkings', 'fanduel'],
      fetchedAt: Date.now(),
    }),
  });
  assert.ok(!idx['td-yes'] && !idx['td-no'],
    'with the assertion helper absent the router must refuse to register any football prop');
  assert.ok(idx['ml-ari'], 'game lines unaffected by the prop assertion');
});
