// PX "top 25 unpriced" additions (2026-10-06), mirroring the order book's own
// market maps (poster-service mlb_props_cycle PROPK / nfl_game_cycle PROPKEY):
// MLB pitcher outs / hits allowed / earned runs / walks, NFL solo tackles /
// tackles & assists / sacks, and rushing & receiving yards (classifier only —
// allowlisted once the order book lists it too).
// Run: node --test test/px-market-additions.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const ws = require('../services/websocket');
const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');

test('MLB pitcher counting props classify to their own families and keep the player name', () => {
  const cases = {
    'Gerrit Cole Total Outs Recorded': 'pitcher_outs',
    'Tyler Glasnow Hits Allowed': 'pitcher_hits_allowed',
    'Max Fried Total Earned Runs Allowed': 'pitcher_earned_runs',
    'Spencer Strider Walks Allowed': 'pitcher_walks',
  };
  for (const [n, t] of Object.entries(cases)) {
    assert.strictEqual(ws._classifyMlbProp(n), t, n);
    assert.strictEqual(ws._extractPlayerNameFromPropMarket(n), n.split(' ').slice(0, 2).join(' '), n);
  }
  assert.strictEqual(ws._classifyMlbProp('Freddie Freeman Total Hits'), 'hitter_hits', 'hitter hits untouched');
  assert.strictEqual(ws._classifyMlbProp('Shohei Ohtani Total Pitching Strikeouts'), 'pitcher_strikeouts');
});

test('NFL defensive props + rushing & receiving yards classify; composites still fail closed', () => {
  assert.strictEqual(ws._classifyFootballProp('Micah Parsons Total Tackles & Assists'), 'tackles_assists');
  assert.strictEqual(ws._classifyFootballProp('Fred Warner Total Tackles'), 'solo_tackles');
  assert.strictEqual(ws._classifyFootballProp('T.J. Watt Total Sacks'), 'sacks');
  assert.strictEqual(ws._classifyFootballProp('James Cook Total Rushing & Receiving Yards'), 'rush_rec_yards');
  assert.strictEqual(ws._classifyFootballProp('Josh Allen Total Passing & Rushing Yards'), 'pass_rush_yards');
  assert.strictEqual(ws._classifyFootballProp('Jalen Hurts Total Rushing Yards'), 'rushing_yards', 'single stat untouched');
  assert.strictEqual(ws._classifyFootballProp('Cook & Allen Total Rushing & Receiving Yards'), null, 'two-player composite');
  assert.strictEqual(ws._extractPlayerNameFromPropMarket('James Cook Total Rushing & Receiving Yards'), 'James Cook');
  assert.strictEqual(ws._extractPlayerNameFromPropMarket('Micah Parsons Total Tackles & Assists'), 'Micah Parsons');
});

test('a pitcher counting prop is never parlayed same-game, whatever the combo allowlist says', () => {
  const FUT = new Date(Date.now() + 6 * 3600e3).toISOString();
  const LINES = {
    po: { lineId: 'po', sport: 'baseball_mlb', marketType: 'player_pitcher_outs', playerName: 'Gerrit Cole', pxEventId: 77, line: 17.5, selection: 'over', startTime: FUT },
    hh: { lineId: 'hh', sport: 'baseball_mlb', marketType: 'player_hitter_hits', playerName: 'Rafael Devers', pxEventId: 77, line: 0.5, selection: 'over', startTime: FUT },
    xg: { lineId: 'xg', sport: 'baseball_mlb', marketType: 'player_hitter_hits', playerName: 'Aaron Judge', pxEventId: 88, line: 0.5, selection: 'over', startTime: FUT },
  };
  const orig = lineManager.lookupLine;
  lineManager.lookupLine = (id) => LINES[id] || null;
  try {
    const same = pricer.shouldDecline([{ line_id: 'po' }, { line_id: 'hh' }], null);
    assert.ok(same && same.declined); assert.strictEqual(same.reason, 'pitcher_prop_same_game');
    const cross = pricer.shouldDecline([{ line_id: 'po' }, { line_id: 'xg' }], null);
    assert.notStrictEqual(cross && cross.reason, 'pitcher_prop_same_game', 'cross-game is not this guard');
  } finally { lineManager.lookupLine = orig; }
});

test('soccer "(90 Min)" 3-way markets are no longer skipped at seed; NHL "(60 Min)" still is', () => {
  const lm = require('../services/line-manager');
  const m = (name) => ({ type: 'moneyline', name });
  assert.strictEqual(lm._skipUnsupported3Way('soccer_epl', m('Arsenal FC to Win (90 Min)')), false);
  assert.strictEqual(lm._skipUnsupported3Way('soccer_usa_mls', m('Draw (90 Min)')), false);
  assert.strictEqual(lm._skipUnsupported3Way('icehockey_nhl', m('Boston Bruins To Win (60 Min)')), true);
  assert.strictEqual(lm._skipUnsupported3Way('soccer_epl', m('Arsenal FC to Win (45 Min)')), true, 'period-qualified stays out');
  assert.strictEqual(lm._skipUnsupported3Way('soccer_epl', m('Moneyline (2 Way)')), false, 'not a 3-way sub-market');
});
