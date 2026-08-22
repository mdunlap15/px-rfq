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
