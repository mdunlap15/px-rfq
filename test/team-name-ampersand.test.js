const test = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');

// Ground truth captured from the live TOA boards on 2026-08-22. PX writes the
// ampersand and a club suffix; TOA spells "and" out and drops the suffix.
const EPL_TOA_TEAMS = [
  'Manchester United', 'Hull City', 'Crystal Palace', 'Everton', 'Sunderland',
  'Ipswich Town', 'Leeds United', 'Nottingham Forest', 'Tottenham Hotspur',
  'Brentford', 'Aston Villa', 'Brighton and Hove Albion', 'Bournemouth',
  'Manchester City', 'Liverpool', 'Newcastle United', 'Chelsea', 'Fulham',
  'Arsenal',
];

test('normalizeTeamName renders & as the word "and"', () => {
  for (const norm of [lineManager.normalizeTeamName, oddsFeed.normalizeTeamName]) {
    assert.strictEqual(norm('Brighton & Hove Albion'), 'brighton and hove albion');
    // Both feeds must land on the SAME string or nothing downstream matches.
    assert.strictEqual(norm('Brighton & Hove Albion'), norm('Brighton and Hove Albion'));
  }
});

test('normalizeTeamName collapses interior whitespace', () => {
  // An interior double space is invisible in logs but fatal to .includes().
  assert.strictEqual(lineManager.normalizeTeamName('Aston   Villa  FC'), 'aston villa fc');
});

test('normalizeTeamName still strips diacritics (regression guard)', () => {
  assert.strictEqual(lineManager.normalizeTeamName('Fenerbahçe SK'), 'fenerbahce sk');
  assert.strictEqual(lineManager.normalizeTeamName('São Paulo'), 'sao paulo');
});

test('the live Brighton fixture resolves both sides', () => {
  const m = lineManager.matchTeamName;
  // Before the & fix this returned null and took the whole fixture dark.
  assert.strictEqual(m('Brighton & Hove Albion FC', EPL_TOA_TEAMS), 'Brighton and Hove Albion');
  assert.strictEqual(m('Aston Villa FC', EPL_TOA_TEAMS), 'Aston Villa');
});

test('& normalization does not collapse two distinct clubs onto one', () => {
  const m = lineManager.matchTeamName;
  // Guard the documented "United FC" collision trap: adding a word must not
  // make an ambiguous pair resolve. Both share the tail, so this must stay
  // null (fail closed) rather than pick one.
  assert.strictEqual(m('United FC', ['Atlanta United', 'Minnesota United']), null);
});

// ---------------------------------------------------------------------------
// Routing guard: SUPPORTED_SPORTS alone does NOT authorize an odds fetch.
// fetchOddsForSport returns early for any sport with no ODDS_API_FALLBACK
// entry, so a sport added to config but not to the map goes silently dark
// (eventCount 0 / ageMinutes null). That shipped twice; this catches the third.
// ---------------------------------------------------------------------------
// NOTE: the real list lives at .config.supportedSports. Reading the module
// root yields undefined, which an `|| []` would silently turn into a vacuous
// pass -- this test asserts non-empty below precisely to catch that.
const { config } = require('../config');

test('every configured sport has a TOA fallback entry (or is SharpAPI-only)', () => {
  const fallback = oddsFeed.__ODDS_API_FALLBACK;
  const sports = config.supportedSports;
  // Guard the guard: if this ever reads empty the assertion below is vacuous.
  assert.ok(Array.isArray(sports) && sports.length > 0, 'supportedSports must be a non-empty array');
  const missing = sports.filter(s => !fallback[s]);
  assert.deepStrictEqual(
    missing, [],
    `these sports are in SUPPORTED_SPORTS but have no ODDS_API_FALLBACK entry, `
    + `so fetchOddsForSport will never issue a request for them: ${missing.join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// Wrong-club resolution. These overrides exist because the generic matcher
// resolved a club to a DIFFERENT club, which fails open when the bad pairing
// happens to be a real fixture.
// ---------------------------------------------------------------------------
const LA_LIGA = ['Sevilla', 'Athletic Bilbao', 'Celta Vigo', 'Valencia', 'Real Madrid',
  'Espanyol', 'Villarreal', 'Atlético Madrid', 'Getafe', 'Barcelona', 'Elche CF',
  'Levante', 'CA Osasuna', 'Real Betis', 'Real Sociedad'];
const BUNDESLIGA = ['VfB Stuttgart', 'Bayern Munich', 'TSG Hoffenheim', '1. FC Köln',
  'Bayer Leverkusen', 'RB Leipzig', 'Union Berlin', 'Borussia Dortmund', 'SC Freiburg', 'Augsburg'];

test('Espanyol does not resolve to Barcelona', () => {
  // The PX name contains BOTH club names. Without the override this returned
  // "Barcelona" -- a different club -- and would price Espanyol's line at
  // Barcelona's number whenever that pairing is a real fixture.
  assert.strictEqual(
    lineManager.matchTeamName('RCD Espanyol de Barcelona', LA_LIGA), 'Espanyol');
});

test('plain Barcelona still resolves to Barcelona', () => {
  assert.strictEqual(lineManager.matchTeamName('Barcelona', LA_LIGA), 'Barcelona');
});

test('München resolves to TOA\'s anglicised Munich', () => {
  assert.strictEqual(lineManager.matchTeamName('FC Bayern München', BUNDESLIGA), 'Bayern Munich');
});
