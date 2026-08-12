// Football (NFL preseason / NFL / NCAAF) odds-feed build — regression tests.
//
// Covers, driving the REAL production functions with stubbed HTTP fixtures:
//  1. T1.2a  americanfootball_nfl_preseason in ODDS_API_FALLBACK (CFL-shaped)
//  2. T1.2b  sportNameMap entry ordered BEFORE americanfootball_nfl
//            (possibleSportKeys derives from map order via stable sort)
//  3. T1.2c  supportedSports code default includes the preseason key
//  4. pricing.footballSgpEnabled defaults false (absence-safe ship-dark flag)
//  5. The point-less "anytime" prop bug (commit 3d45fca): a lineless Yes-only
//     goalscorer board must price through the one-sided wrapper instead of
//     dying on allRows.length===0 — plus a regression proving pointful
//     markets behave unchanged and hard errors still propagate.
//  6. supplementH1Markets generalized from hardcoded basketball_nba to
//     H1_SUPPLEMENT_SPORTS; football URL uses the football sport key while
//     the no-arg call preserves the NBA URL byte-for-byte.
//  7. Player-name matching: hyphen⇒space, Jr/Sr decorative, II/III/IV/V
//     distinguishing (separate field, strict), D/ST dropped.
//
// Fetch is stubbed at global.fetch (odds-feed uses Node's global fetch via
// abortableFetch), so every HTTP-shaped fixture exercises the real parse,
// consensus-build, de-vig, and cache paths.
//
// Run: node --test test/football-odds-feed.test.js

process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

const oddsFeed = require('../services/odds-feed');
const { config } = require('../config');

// --- fetch stub -------------------------------------------------------------
// Routes match by substring pairs (every entry in `all` must appear in the
// URL). Unrouted URLs 404 — fail closed, like a wrong TOA key would.
const fetchLog = [];
const routes = [];
const route = (all, payload) => routes.push({ all, payload });
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  fetchLog.push(u);
  for (const r of routes) {
    if (r.all.every(s => u.includes(s))) {
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(r.payload)) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
process.on('exit', () => { global.fetch = realFetch; });

const FUTURE = new Date(Date.now() + 24 * 3600e3).toISOString();

// --- fixtures ---------------------------------------------------------------

// Lineless Yes-only goalscorer board (the shape that hit the 3d45fca bug).
// Includes a Michael Carter II row so the suffix rule is proven on the real
// lookup path, not just the name-table.
route(['/v4/sports/soccer_usa_mls/events?'], [
  { id: 'mlsev1', home_team: 'Inter Miami CF', away_team: 'Austin FC', commence_time: FUTURE },
]);
route(['/events/mlsev1/odds', 'markets=player_goal_scorer_anytime'], {
  id: 'mlsev1', home_team: 'Inter Miami CF', away_team: 'Austin FC',
  bookmakers: [
    { key: 'draftkings', markets: [{ key: 'player_goal_scorer_anytime', outcomes: [
      { name: 'Yes', description: 'Lionel Messi', price: -150 },
      { name: 'Yes', description: 'Sebastián Driussi', price: 220 },
      { name: 'Yes', description: 'Michael Carter II', price: 400 },
    ] }] },
    { key: 'fanduel', markets: [{ key: 'player_goal_scorer_anytime', outcomes: [
      { name: 'Yes', description: 'Lionel Messi', price: 105 },
    ] }] },
  ],
});

// Pointful player_points board (regression: unchanged behavior). Carries one
// ADVERSARIAL pointless Yes row that must stay out of both row sets.
route(['/v4/sports/basketball_nba/events?'], [
  { id: 'nbaev1', home_team: 'Boston Celtics', away_team: 'Miami Heat', commence_time: FUTURE },
]);
route(['/events/nbaev1/odds', 'markets=player_points'], {
  id: 'nbaev1', home_team: 'Boston Celtics', away_team: 'Miami Heat',
  bookmakers: [
    { key: 'draftkings', markets: [{ key: 'player_points', outcomes: [
      { name: 'Over', description: 'Jayson Tatum', point: 25.5, price: -110 },
      { name: 'Under', description: 'Jayson Tatum', point: 25.5, price: -110 },
      { name: 'Yes', description: 'Jayson Tatum', price: -500 }, // pointless intruder
    ] }] },
    { key: 'pinnacle', markets: [{ key: 'player_points', outcomes: [
      { name: 'Over', description: 'Jayson Tatum', point: 25.5, price: -115 },
      { name: 'Under', description: 'Jayson Tatum', point: 25.5, price: -105 },
    ] }] },
  ],
});

// NFL preseason H1 fixtures (events list resolves the TOA event id, then the
// per-event *_h1 markets attach).
route(['/v4/sports/americanfootball_nfl_preseason/events?'], [
  { id: 'pre1', home_team: 'Arizona Cardinals', away_team: 'Carolina Panthers', commence_time: FUTURE },
]);
const h1Odds = (home, away) => ({
  home_team: home, away_team: away,
  bookmakers: [
    { key: 'pinnacle', markets: [
      { key: 'h2h_h1', outcomes: [
        { name: home, price: -130 }, { name: away, price: 110 },
      ] },
      { key: 'spreads_h1', outcomes: [
        { name: home, point: -1.5, price: -110 }, { name: away, point: 1.5, price: -110 },
      ] },
      { key: 'totals_h1', outcomes: [
        { name: 'Over', point: 17.5, price: -110 }, { name: 'Under', point: 17.5, price: -110 },
      ] },
    ] },
    { key: 'draftkings', markets: [
      { key: 'h2h_h1', outcomes: [
        { name: home, price: -125 }, { name: away, price: 105 },
      ] },
      { key: 'spreads_h1', outcomes: [
        { name: home, point: -1.5, price: -112 }, { name: away, point: 1.5, price: -108 },
      ] },
      { key: 'totals_h1', outcomes: [
        { name: 'Over', point: 17.5, price: -112 }, { name: 'Under', point: 17.5, price: -108 },
      ] },
    ] },
  ],
});
route(['/events/pre1/odds', 'markets=h2h_h1,spreads_h1,totals_h1'],
  h1Odds('Arizona Cardinals', 'Carolina Panthers'));
route(['/events/nbaev1/odds', 'markets=h2h_h1,spreads_h1,totals_h1'],
  h1Odds('Boston Celtics', 'Miami Heat'));

// --- 1-4: config surfaces ---------------------------------------------------

test('ODDS_API_FALLBACK carries americanfootball_nfl_preseason, CFL-shaped', () => {
  const fb = oddsFeed.__ODDS_API_FALLBACK;
  const pre = fb.americanfootball_nfl_preseason;
  assert.ok(pre, 'preseason fallback entry missing');
  assert.equal(pre.oddsApiSport, 'americanfootball_nfl_preseason');
  assert.equal(pre.markets, 'h2h,spreads,totals');
  assert.equal(pre.bookmakers, fb.americanfootball_cfl.bookmakers,
    'must use the same bookmaker allowlist as the CFL block it copies');
  assert.ok(!pre.dynamic && !pre.flipGated, 'must be a static, non-flip-gated entry like CFL');
});

test('sportNameMap maps preseason to American Football and orders it BEFORE americanfootball_nfl', (t) => {
  assert.equal(config.sportNameMap['americanfootball_nfl_preseason'], 'American Football');
  const keys = Object.keys(config.sportNameMap);
  const iPre = keys.indexOf('americanfootball_nfl_preseason');
  const iNfl = keys.indexOf('americanfootball_nfl');
  assert.ok(iPre >= 0 && iNfl >= 0);
  assert.ok(iPre < iNfl,
    'possibleSportKeys derives from map order (stable sort) — preseason must precede nfl');
});

test('supportedSports code default includes americanfootball_nfl_preseason', (t) => {
  if (process.env.SUPPORTED_SPORTS) {
    t.skip('SUPPORTED_SPORTS env set in this environment — code default not observable');
    return;
  }
  assert.ok(config.supportedSports.includes('americanfootball_nfl_preseason'));
});

test('pricing.footballSgpEnabled defaults false (ship-dark, absence-safe)', (t) => {
  if (process.env.FOOTBALL_SGP_ENABLED) {
    t.skip('FOOTBALL_SGP_ENABLED env set in this environment');
    return;
  }
  assert.strictEqual(config.pricing.footballSgpEnabled, false);
});

// --- 5: point-less "anytime" prop bug ---------------------------------------

const mlsInfo = { homeTeam: 'Inter Miami CF', awayTeam: 'Austin FC', startTime: FUTURE };
const nbaInfo = { homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', startTime: FUTURE };

test('lineless anytime market: standard lookup keeps matched Yes rows instead of no_player_or_line_match', async () => {
  const std = await oddsFeed.lookupTheOddsApiPlayerProp(
    'soccer_usa_mls', 'player_goal_scorer_anytime', mlsInfo, 'Lionel Messi', null);
  assert.ok(!std.error, `standard lookup errored: ${std.error} (stages: ${std.stages})`);
  assert.ok(Array.isArray(std.matchedRows) && std.matchedRows.length === 2,
    'both books\' Yes rows must match');
  // Yes-only board has no Over/Under pair — the standard fair stays null and
  // the one-sided wrapper is the pricing path.
  assert.strictEqual(std.fairProbOver, null);
});

test('lineless anytime market: one-sided wrapper returns a price (the soccer.goalscorer fix)', async () => {
  const res = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
    'soccer_usa_mls', 'player_goal_scorer_anytime', mlsInfo, 'Lionel Messi', null);
  assert.ok(!res.error, `wrapper errored: ${res.error} (stages: ${res.stages})`);
  assert.equal(res.oneSidedSource, 'toa-one-sided');
  assert.equal(res.oneSidedBookCount, 2);
  // dk -150 (0.600) + fd +105 (0.488) avg 0.544, /1.08 overround ≈ 0.504
  assert.ok(res.fairProbOver > 0.45 && res.fairProbOver < 0.55,
    `fairProbOver ${res.fairProbOver} outside expected band`);
  assert.equal(res.fairProbUnder, 1 - res.fairProbOver);
});

test('lineless lookup for an unknown player still fails closed', async () => {
  const res = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
    'soccer_usa_mls', 'player_goal_scorer_anytime', mlsInfo, 'Cristiano Ronaldo', null);
  assert.equal(res.error, 'no_player_or_line_match');
});

test('suffix rule holds on the real lookup path: "Michael Carter" must NOT price off "Michael Carter II"', async () => {
  const res = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
    'soccer_usa_mls', 'player_goal_scorer_anytime', mlsInfo, 'Michael Carter', null);
  assert.equal(res.error, 'no_player_or_line_match',
    'present-vs-absent generational suffix must fail closed to no-match');
  const res2 = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
    'soccer_usa_mls', 'player_goal_scorer_anytime', mlsInfo, 'Michael Carter II', null);
  assert.ok(!res2.error, 'exact suffix match must still price');
});

test('regression: pointful market unchanged — prices two-sided, pointless intruder row excluded', async () => {
  const res = await oddsFeed.lookupTheOddsApiPlayerProp(
    'basketball_nba', 'player_points', nbaInfo, 'Jayson Tatum', 25.5);
  assert.ok(!res.error, `pointful lookup errored: ${res.error}`);
  assert.ok(res.fairProbOver > 0.4 && res.fairProbOver < 0.6,
    `fair ${res.fairProbOver} implausible for a -110/-110 & -115/-105 board`);
  assert.equal(res.booksWithBothSides, 2);
  // The pointless Yes row must reach NEITHER row set on a pointful request:
  // matched=4 (2 books × O/U at 25.5), all_rows=4.
  const stage = (res.stages || []).find(s => String(s).startsWith('player_line_match:'));
  assert.equal(stage, 'player_line_match:4,all_rows:4');
});

test('regression: hard errors still propagate through the one-sided wrapper (alt_line_too_far)', async () => {
  const res = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
    'basketball_nba', 'player_points', nbaInfo, 'Jayson Tatum', 35.5);
  assert.equal(res.error, 'alt_line_too_far',
    'the recovery carve-out must be scoped to lineless no_player_or_line_match only');
});

// --- 6: H1 supplement generalization ----------------------------------------

test('H1_SUPPLEMENT_SPORTS default = NBA + the three football keys, nothing else', (t) => {
  if (process.env.H1_SUPPLEMENT_SPORTS) {
    t.skip('H1_SUPPLEMENT_SPORTS env set in this environment');
    return;
  }
  const s = oddsFeed.__H1_SUPPLEMENT_SPORTS;
  assert.deepEqual([...s].sort(), [
    'americanfootball_ncaaf',
    'americanfootball_nfl',
    'americanfootball_nfl_preseason',
    'basketball_nba',
  ].sort());
});

test('supplementH1Markets attaches football H1 markets from the football sport key URL', async () => {
  const ev = {
    homeTeam: 'Arizona Cardinals', awayTeam: 'Carolina Panthers',
    commenceTime: FUTURE, markets: {},
  };
  fetchLog.length = 0;
  await oddsFeed.supplementH1Markets({ 'cardinals|panthers': ev }, 'americanfootball_nfl_preseason');
  assert.ok(ev.markets.h2h_h1, 'h2h_h1 not attached');
  assert.ok(ev.markets.spreads_h1, 'spreads_h1 not attached');
  assert.ok(ev.markets.totals_h1, 'totals_h1 not attached');
  const oddsUrl = fetchLog.find(u => u.includes('/events/pre1/odds'));
  assert.ok(oddsUrl, 'per-event odds URL never fetched');
  assert.ok(oddsUrl.includes('/v4/sports/americanfootball_nfl_preseason/events/pre1/odds'),
    `URL must use the football sport key, got: ${oddsUrl}`);
  assert.ok(oddsUrl.includes('markets=h2h_h1,spreads_h1,totals_h1'));
  assert.ok(oddsUrl.includes('bookmakers=pinnacle,draftkings,fanduel'),
    'book allowlist must match the original NBA implementation');
});

test('supplementH1Markets with no sport arg preserves the NBA URL byte-for-byte', async () => {
  const ev = {
    homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat',
    commenceTime: FUTURE, markets: {},
  };
  fetchLog.length = 0;
  await oddsFeed.supplementH1Markets({ 'celtics|heat': ev }); // legacy call shape
  assert.ok(ev.markets.h2h_h1 && ev.markets.spreads_h1 && ev.markets.totals_h1);
  const oddsUrl = fetchLog.find(u => u.includes('/events/nbaev1/odds'));
  assert.ok(oddsUrl, 'NBA per-event odds URL never fetched');
  assert.ok(oddsUrl.startsWith('https://api.the-odds-api.com/v4/sports/basketball_nba/events/nbaev1/odds'),
    `NBA URL changed: ${oddsUrl}`);
});

// --- 7: player-name table ----------------------------------------------------

const namesMatch = oddsFeed._playerNamesMatch;
const parts = oddsFeed._normPlayerNameParts;

test('name table: hyphen normalizes to space, never to nothing', () => {
  assert.equal(namesMatch('Jaxon Smith Njigba', 'Jaxon Smith-Njigba'), true);
  assert.equal(namesMatch('Smith-Njigba', 'Jaxon Smith Njigba'), true); // partial + hyphen
  assert.equal(parts('Jaxon Smith-Njigba').base, 'jaxon smith njigba');
});

test('name table: Jr/Sr are decorative', () => {
  assert.equal(namesMatch('Travis Etienne', 'Travis Etienne Jr.'), true);
  assert.equal(namesMatch('Travis Etienne Jr.', 'Travis Etienne'), true);
  assert.equal(namesMatch('Odell Beckham Sr.', 'Odell Beckham'), true);
});

test('name table: roman-numeral suffixes are distinguishing, compared in their own field', () => {
  assert.equal(namesMatch('Michael Carter', 'Michael Carter II'), false);
  assert.equal(namesMatch('Michael Carter II', 'Michael Carter'), false);
  assert.equal(namesMatch('Michael Carter II', 'Michael Carter II'), true);
  assert.equal(namesMatch('Kenneth Walker III', 'Kenneth Walker'), false);
  assert.equal(namesMatch('Kenneth Walker III', 'Kenneth Walker III'), true);
  assert.equal(namesMatch('Michael Carter II', 'Michael Carter III'), false);
  // substring fallback must not defeat the suffix field
  assert.equal(namesMatch('Carter', 'Michael Carter II'), false);
  assert.deepEqual(parts('Michael Carter II'), { base: 'michael carter', gen: 'ii' });
});

test('name table: punctuation and diacritics', () => {
  assert.equal(namesMatch('C.J. Stroud', 'CJ Stroud'), true);
  assert.equal(namesMatch("D'Angelo Russell", 'DAngelo Russell'), true);
  assert.equal(namesMatch('Sebastián Driussi', 'Sebastian Driussi'), true);
});

test('name table: D/ST and degenerate inputs match nothing', () => {
  assert.equal(parts('49ers D/ST'), null);
  assert.equal(parts('Cowboys D/ST'), null);
  assert.equal(namesMatch('49ers D/ST', '49ers D/ST'), false); // not even itself
  assert.equal(namesMatch('', 'Lionel Messi'), false);
  assert.equal(namesMatch(null, 'Lionel Messi'), false);
  assert.equal(parts(''), null);
});

test('name table: a lone roman-numeral-looking word is a name, not a suffix', () => {
  assert.deepEqual(parts('V'), { base: 'v', gen: '' });
  assert.equal(namesMatch('William Fuller V', 'William Fuller V'), true);
  assert.equal(namesMatch('William Fuller V', 'William Fuller'), false);
});
