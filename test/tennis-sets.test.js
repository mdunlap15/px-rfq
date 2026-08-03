// Tennis SETS markets — parsing, best-of-3 semantics, and the same-match block.
//
// PX posts four per match (probe 2026-08-03, ATP Montreal). Two of them are the
// BTTS/MoV shape trap:
//   "1st Set Moneyline"                 type='moneyline'  -> would parse as the
//                                       MATCH moneyline (contains "Moneyline")
//   "Total Sets" line 2.5               type='total'      -> would parse as
//                                       Total GAMES (real lines 20.5-27.5)
//   "<Player> To Win At Least One Set"  type='moneyline', selections YES/NO,
//                                       player ONLY in the market name
//
// Run: npm test   (or: node --test test/tennis-sets.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const px = require('../services/prophetx');
const pricer = require('../services/pricer');

// PX nests selections as an array OF GROUPS (array of arrays), not a flat list.
const yesNo = () => [
  { line_id: 'L-yes', name: 'Yes' },
  { line_id: 'L-no', name: 'No' },
];
const mkt = (name, type, selections, extra = {}) =>
  Object.assign({ name, type, selections: [selections || yesNo()] }, extra);

// ---------------------------------------------------------------------------
// PARSING
// ---------------------------------------------------------------------------
test('"<Player> To Win At Least One Set" parses to its own type with the player', () => {
  const out = px.parseMarketSelections(mkt('Sho Shimabukuro To Win At Least One Set', 'moneyline'));
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.marketType, 'set_win_at_least_one');
    assert.equal(r.playerName, 'Sho Shimabukuro', 'player comes from the market NAME');
  }
  assert.deepEqual(out.map(r => r.selection).sort(), ['no', 'yes']);
});

test('accented and hyphenated player names survive', () => {
  for (const who of ['Marin Čilić', 'Duncan Chan', 'Jan-Lennard Struff', "Sean O'Brien"]) {
    const out = px.parseMarketSelections(mkt(who + ' To Win At Least One Set', 'moneyline'));
    assert.equal(out[0].playerName, who, who);
  }
});

test('"1st Set Moneyline" does NOT parse as the match moneyline', () => {
  for (const name of ['1st Set Moneyline', 'First Set Moneyline', 'Set 1 Moneyline']) {
    const out = px.parseMarketSelections(mkt(name, 'moneyline', [
      { line_id: 'a', name: 'Player A', competitor_id: 1 },
      { line_id: 'b', name: 'Player B', competitor_id: 2 },
    ]));
    assert.ok(out.length, name + ' produced no selections');
    for (const r of out) {
      assert.equal(r.marketType, 'first_set_moneyline',
        name + ' must NOT be typed plain moneyline — that prices one set off the match line');
    }
  }
});

test('"Total Sets" does NOT parse as Total Games', () => {
  const out = px.parseMarketSelections(mkt('Total Sets', 'total', [
    { line_id: 'o', name: 'Over 2.5', line: 2.5 },
    { line_id: 'u', name: 'Under 2.5', line: 2.5 },
  ]));
  assert.ok(out.length);
  for (const r of out) {
    assert.equal(r.marketType, 'total_sets',
      'a 2.5 SETS line priced as a GAMES total (real lines 20.5-27.5) is nonsense');
  }
});

test('LATER sets are deliberately left unclassified — we have no source', () => {
  for (const name of ['2nd Set Moneyline', '3rd Set Moneyline', 'Set 2 Moneyline']) {
    const out = px.parseMarketSelections(mkt(name, 'moneyline', [
      { line_id: 'a', name: 'Player A', competitor_id: 1 },
      { line_id: 'b', name: 'Player B', competitor_id: 2 },
    ]));
    for (const r of out) {
      assert.notEqual(r.marketType, 'first_set_moneyline', name + ' must not claim the 1st-set type');
    }
  }
});

test('the match moneyline itself is untouched', () => {
  const out = px.parseMarketSelections(mkt('Moneyline', 'moneyline', [
    { line_id: 'a', name: 'Player A', competitor_id: 1 },
    { line_id: 'b', name: 'Player B', competitor_id: 2 },
  ]));
  for (const r of out) assert.equal(r.marketType, 'moneyline');
});

test('a fight MoV market is not mistaken for a set market', () => {
  const out = px.parseMarketSelections(mkt('Usman To Win By Decision', 'moneyline'));
  for (const r of out) assert.equal(r.marketType, 'mov_dec');
});

// ---------------------------------------------------------------------------
// SAME-MATCH BLOCK
// ---------------------------------------------------------------------------
const leg = (marketType, over = {}) => Object.assign({
  pxEventId: 'EV1', marketType, selection: 'yes', playerName: 'Player A',
  teamName: 'Player A', sport: 'tennis', line: null,
}, over);

function declineOf(legInfos) {
  // shouldDecline takes resolved legs; the set block reads lineInfo shape.
  return pricer.shouldDecline(legInfos.map(li => ({ lineInfo: li })), 100);
}

test('BLOCKED: at-least-one-set + match moneyline on the same match (nested)', () => {
  const r = declineOf([leg('set_win_at_least_one'), leg('moneyline', { selection: 'home' })]);
  assert.equal(r.declined, true);
  assert.equal(r.reason, 'tennis_sets_sgp_blocked');
});

test('BLOCKED: total sets over + at-least-one-set (over 2.5 IMPLIES both won a set)', () => {
  const r = declineOf([leg('total_sets', { selection: 'over', line: 2.5 }), leg('set_win_at_least_one')]);
  assert.equal(r.declined, true);
  assert.equal(r.reason, 'tennis_sets_sgp_blocked');
});

test('BLOCKED: 1st set moneyline + match moneyline', () => {
  const r = declineOf([leg('first_set_moneyline', { selection: 'home' }), leg('moneyline', { selection: 'home' })]);
  assert.equal(r.declined, true);
  assert.equal(r.reason, 'tennis_sets_sgp_blocked');
});

test('BLOCKED: two set markets against each other', () => {
  const r = declineOf([leg('first_set_moneyline'), leg('total_sets', { selection: 'under', line: 2.5 })]);
  assert.equal(r.declined, true);
  assert.equal(r.reason, 'tennis_sets_sgp_blocked');
});

test('BLOCKED: the two players\' at-least-one-set legs on one match', () => {
  const r = declineOf([
    leg('set_win_at_least_one', { playerName: 'Player A' }),
    leg('set_win_at_least_one', { playerName: 'Player B' }),
  ]);
  assert.equal(r.declined, true);
  assert.equal(r.reason, 'tennis_sets_sgp_blocked');
});

test('ALLOWED: set markets on DIFFERENT matches are independent', () => {
  const r = declineOf([
    leg('set_win_at_least_one', { pxEventId: 'EV1' }),
    leg('set_win_at_least_one', { pxEventId: 'EV2', playerName: 'Player C' }),
  ]);
  assert.notEqual(r && r.reason, 'tennis_sets_sgp_blocked');
});

test('ALLOWED: a single set leg has nothing to correlate with', () => {
  const r = declineOf([leg('set_win_at_least_one')]);
  assert.notEqual(r && r.reason, 'tennis_sets_sgp_blocked');
});

test('the block does not rely on SGP_ALLOWED_COMBOS — forcing a combo in still declines', () => {
  const { config } = require('../config');
  const prev = config.pricing.sgpAllowedCombos;
  try {
    config.pricing.sgpAllowedCombos = [
      'spread_total', 'ml_total', 'set_win_at_least_one_moneyline',
      'total_sets_set_win_at_least_one', 'first_set_moneyline_moneyline',
    ];
    const r = declineOf([leg('set_win_at_least_one'), leg('moneyline', { selection: 'home' })]);
    assert.equal(r.declined, true, 'must still decline with the combos allowed');
    assert.equal(r.reason, 'tennis_sets_sgp_blocked');
  } finally {
    config.pricing.sgpAllowedCombos = prev;
  }
});
