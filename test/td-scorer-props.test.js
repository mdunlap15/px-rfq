// TOUCHDOWN-SCORER PROPS (anytime TD, first TD) — 2026-09-10.
//
// Operator: "We should be quoting these. It is fine if we are only offering
// the YES side (we get NO)." Both markets are ONE-SIDED at every book (8 and 7
// books on 49ers@Rams, outcomes name:"Yes" + description:<player>), so they
// take the lineless YES-only mirror path anytime TD already had; first TD is
// newly mapped to player_1st_td.
//
// Operator, same message: "We need to make sure they are not parlayable with
// highly correlated other legs though." A TD leg is a player prop with a
// playerName, so the football same-game guard refuses it against ANY other leg
// on the same event — spread, total, moneyline, another TD scorer, the same
// player's first+anytime — even with FOOTBALL_SGP_ENABLED=true, and even with
// the combo allowlist forced open. Cross-game TD legs are independent and are
// not football-blocked. These tests pin all of that.
//
// Run: node --test test/td-scorer-props.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');
const LM_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

const NFL = 'americanfootball_nfl';

test('both TD markets map to their one-sided TOA keys with lineless YES semantics', () => {
  assert.equal(lineManager._FOOTBALL_PROP_TO_TOA_MARKET.anytime_td, 'player_anytime_td');
  assert.equal(lineManager._FOOTBALL_PROP_TO_TOA_MARKET.first_td, 'player_1st_td');
  assert.deepEqual(lineManager._footballPropCtx('anytime_td'), { propType: 'anytime_td', line: 0.5, toaLine: null });
  assert.deepEqual(lineManager._footballPropCtx('first_td'), { propType: 'first_td', line: 0.5, toaLine: null });
  assert.equal(lineManager._propMarketType('first_td'), 'player_first_td', 'a player_* marketType — never a game type');
  assert.equal(lineManager._footballPropRegistrationSafe('player_first_td'), true);
});

test('the seed treats first TD as one-sided (YES mirror), like anytime TD', () => {
  assert.ok(/\(!!footballProp && \(propType === 'anytime_td' \|\| propType === 'first_td'\)\)/.test(LM_SRC),
    'oneSidedEligible must include first_td or the two-sided lookup fails closed and nothing registers');
});

// ------------------------------------------------- same-game correlation

const GAME = 9454, OTHER = 9455;
const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const base = (id, ev, extra) => Object.assign({
  lineId: id, sport: NFL, oddsApiSport: NFL, pxEventId: ev,
  homeTeam: 'Los Angeles Rams', awayTeam: 'San Francisco 49ers',
  startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
}, extra);
const LINES = {
  'cmc-any': base('cmc-any', GAME, { marketType: 'player_anytime_td', playerName: 'Christian McCaffrey', teamName: 'Christian McCaffrey', selection: 'over', oddsApiSelection: 'over', line: 0.5, marketName: 'Christian McCaffrey To Score a Touchdown' }),
  'cmc-first': base('cmc-first', GAME, { marketType: 'player_first_td', playerName: 'Christian McCaffrey', teamName: 'Christian McCaffrey', selection: 'over', oddsApiSelection: 'over', line: 0.5, marketName: 'Christian McCaffrey To Score First Touchdown' }),
  'kittle-any': base('kittle-any', GAME, { marketType: 'player_anytime_td', playerName: 'George Kittle', teamName: 'George Kittle', selection: 'over', oddsApiSelection: 'over', line: 0.5, marketName: 'George Kittle To Score a Touchdown' }),
  'sf-spread': base('sf-spread', GAME, { marketType: 'spread', teamName: 'San Francisco 49ers', selection: 'away', oddsApiSelection: 'away', line: 2.5, marketName: 'Spread' }),
  'game-total': base('game-total', GAME, { marketType: 'total', selection: 'over', oddsApiSelection: 'over', line: 48.5, marketName: 'Total Points' }),
  'lar-ml': base('lar-ml', GAME, { marketType: 'moneyline', teamName: 'Los Angeles Rams', selection: 'home', oddsApiSelection: 'home', marketName: 'Moneyline' }),
  'lar-tt': base('lar-tt', GAME, { marketType: 'team_total', teamName: 'Los Angeles Rams', selection: 'over', oddsApiSelection: 'over', line: 24.5, marketName: 'LAR: Team Total Points' }),
  'other-any': base('other-any', OTHER, { marketType: 'player_anytime_td', playerName: 'Bijan Robinson', teamName: 'Bijan Robinson', selection: 'over', oddsApiSelection: 'over', line: 0.5, homeTeam: 'Pittsburgh Steelers', awayTeam: 'Atlanta Falcons', marketName: 'Bijan Robinson To Score a Touchdown' }),
};
for (const li of Object.values(LINES)) { li.oddsApiMarket = li.marketType; }
const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });
const declineOf = (...ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);

function withFootballOpen(fn) {
  const prevFlag = config.pricing.footballSgpEnabled;
  const prevCombos = config.pricing.sgpAllowedCombos;
  config.pricing.footballSgpEnabled = true;                        // prod value
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total', 'prop_nested', 'prop_prop_xteam']; // prod value
  try { return fn(); } finally {
    config.pricing.footballSgpEnabled = prevFlag;
    config.pricing.sgpAllowedCombos = prevCombos;
  }
}

test('a TD leg is blocked against EVERY other leg on the same game, with football SGPs enabled and combos open', () => {
  const pairs = {
    'anytime TD + spread': ['cmc-any', 'sf-spread'],
    'anytime TD + game total': ['cmc-any', 'game-total'],
    'anytime TD + moneyline': ['cmc-any', 'lar-ml'],
    'anytime TD + team total': ['cmc-any', 'lar-tt'],
    'first TD + spread': ['cmc-first', 'sf-spread'],
    'first TD + game total': ['cmc-first', 'game-total'],
    'two anytime TDs, same game': ['cmc-any', 'kittle-any'],
    'same player, first + anytime': ['cmc-first', 'cmc-any'],
    'TD + side + total stack': ['cmc-any', 'sf-spread', 'game-total'],
  };
  withFootballOpen(() => {
    for (const [label, ids] of Object.entries(pairs)) {
      const d = declineOf(...ids);
      assert.ok(d && d.declined, `${label} must decline`);
      assert.strictEqual(d.reason, 'football_sgp_blocked', `${label}: got ${d.reason} — ${d.detail}`);
    }
  });
});

test('the same-game block does not depend on the flag being off', () => {
  // Flag OFF is the stricter state; the point is that flag ON still blocks.
  const prev = config.pricing.footballSgpEnabled;
  try {
    config.pricing.footballSgpEnabled = false;
    assert.strictEqual(declineOf('cmc-any', 'sf-spread').reason, 'football_sgp_blocked');
  } finally { config.pricing.footballSgpEnabled = prev; }
});

test('TD legs on DIFFERENT games are independent and are not football-blocked', () => {
  withFootballOpen(() => {
    const d = declineOf('cmc-any', 'other-any');
    assert.notStrictEqual(d && d.reason, 'football_sgp_blocked', 'cross-game TD + TD must not be football-blocked: ' + JSON.stringify(d));
    assert.notStrictEqual(d && d.reason, 'football_period_sgp_blocked');
  });
});

test('a registered FIRST-TD leg is not swept up by the novelty-market guard', () => {
  // The novelty pattern contains `first touchdown` to refuse unregistered
  // "First Touchdown" micro-markets priced off the parent game. A REGISTERED
  // player_first_td leg is priced off its own TOA market, so the guard is
  // keyed off marketType and must let it through — otherwise first-TD
  // parlays never quote at all, cross-game included.
  LINES['other-first'] = base('other-first', OTHER, { marketType: 'player_first_td', playerName: 'Bijan Robinson', teamName: 'Bijan Robinson', selection: 'over', oddsApiSelection: 'over', line: 0.5, homeTeam: 'Pittsburgh Steelers', awayTeam: 'Atlanta Falcons', marketName: 'Bijan Robinson To Score First Touchdown', oddsApiMarket: 'player_first_td' });
  withFootballOpen(() => {
    const d = declineOf('cmc-first', 'other-first');          // two first-TD legs, different games
    assert.notStrictEqual(d && d.reason, 'novelty_market', 'registered first-TD legs must not be novelty-declined: ' + JSON.stringify(d));
    assert.notStrictEqual(d && d.reason, 'football_sgp_blocked', 'different games are independent');
  });
  // and an UNREGISTERED "First Touchdown" novelty on a game market still declines
  LINES['novelty-ft'] = base('novelty-ft', OTHER, { marketType: 'moneyline', teamName: 'Atlanta Falcons', selection: 'away', oddsApiSelection: 'away', marketName: 'First Touchdown', homeTeam: 'Pittsburgh Steelers', awayTeam: 'Atlanta Falcons', oddsApiMarket: 'h2h' });
  withFootballOpen(() => {
    assert.strictEqual(declineOf('novelty-ft', 'cmc-any').reason, 'novelty_market', 'the carve-out is keyed on marketType, not on the name');
  });
});
