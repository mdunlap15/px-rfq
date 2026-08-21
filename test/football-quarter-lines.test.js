// FOOTBALL 1st-QUARTER registration (2026-08-21).
//
// PX posts "1st Quarter Moneyline" / "1st Quarter Spread" / "1st Quarter Total
// Points" for every NFL game and types ALL THREE as plain moneyline/spread/
// total — the same shape that made BTTS and UFC method-of-victory dangerous.
// If a Q1 leg reaches the pricer still typed as a full-game market it is
// priced off the FULL-GAME line, which is the exact 2x mispricing the 2nd-half
// retag was added to prevent (a 2H total of 35.5 priced identically to the
// full-game 35.5 when true P(2H under) is ~98%).
//
// These tests pin the retag, because it is the only type-level defence:
// registered lines never re-enter resolveUnknownLine, where the sub-game name
// pattern lives.
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const px = require('../services/prophetx');

const parse = px.parseMarketSelections;

// PX selection shapes differ by market family: moneyline carries team names,
// spread carries team names + a point, totals carry Over/Under + a line.
const market = (name, type) => {
  let selections;
  if (type === 'total') {
    // PX carries the line INSIDE the selection display name ("Over 10.5").
    selections = [[
      { line_id: 'a', name: 'Over 10.5', display_name: 'Over 10.5', line: 10.5, odds: -110 },
      { line_id: 'b', name: 'Under 10.5', display_name: 'Under 10.5', line: 10.5, odds: -110 },
    ]];
  } else if (type === 'spread') {
    selections = [[
      { line_id: 'a', name: 'Pittsburgh Steelers -1.5', display_name: 'Pittsburgh Steelers -1.5', line: -1.5, odds: -110 },
      { line_id: 'b', name: 'New York Jets +1.5', display_name: 'New York Jets +1.5', line: 1.5, odds: -110 },
    ]];
  } else {
    selections = [[
      { line_id: 'a', name: 'Pittsburgh Steelers', odds: -130 },
      { line_id: 'b', name: 'New York Jets', odds: 110 },
    ]];
  }
  return { id: 1, name, type, selections };
};

const typesOf = (name, type) => {
  const out = parse(market(name, type), 'Pittsburgh Steelers', 'New York Jets') || [];
  return [...new Set(out.map(s => s.marketType))];
};

test('1st Quarter Moneyline does NOT stay a full-game moneyline', () => {
  const t = typesOf('1st Quarter Moneyline', 'moneyline');
  assert.ok(t.length, 'market parsed');
  assert.ok(!t.includes('moneyline'),
    'a Q1 leg typed `moneyline` would be priced off the FULL-GAME line');
  assert.ok(t.includes('quarter_1_moneyline'), 'got: ' + JSON.stringify(t));
});

// CURRENT BEHAVIOUR, pinned deliberately: the parser emits NO selections for
// quarter SPREAD and quarter TOTAL, only for quarter moneyline. Verified by
// contrast — the identical fixture parses fine for the full-game "Total
// Points" and for "NYJ: Team Total Points", so this is the quarter path, not a
// bad fixture.
//
// Consequence: admitting 1st-quarter markets through the seed filter registers
// the MONEYLINE only; Q1 spread/total silently register zero lines. That is
// SAFE (nothing mispriced — the leg simply never exists) but it means the Q1
// spread/total work is not finished, and TOA only carried 1 book for
// spreads_q1/totals_q1 anyway, below the 2-book floor.
//
// If these two ever start returning selections, the assertions below flip and
// the failure is the signal to check that the retag still applies.
test('quarter SPREAD currently yields no selections (documented gap, not a mispricing)', () => {
  const t = typesOf('1st Quarter Spread', 'spread');
  assert.deepEqual(t, [], 'got: ' + JSON.stringify(t));
  assert.ok(typesOf('Spread', 'spread').includes('spread'), 'same fixture parses full-game');
});

test('quarter TOTAL currently yields no selections (documented gap, not a mispricing)', () => {
  const t = typesOf('1st Quarter Total Points', 'total');
  assert.deepEqual(t, [], 'got: ' + JSON.stringify(t));
  assert.ok(typesOf('Total Points', 'total').includes('total'), 'same fixture parses full-game');
});

test('the quarter retag itself keeps quarters distinct when it does fire', () => {
  // Moneyline is the path that produces selections today.
  assert.ok(typesOf('2nd Quarter Moneyline', 'moneyline').includes('quarter_2_moneyline'));
  assert.ok(typesOf('4th Quarter Moneyline', 'moneyline').includes('quarter_4_moneyline'));
  assert.ok(!typesOf('2nd Quarter Moneyline', 'moneyline').includes('quarter_4_moneyline'));
});

test('the full-game markets are untouched by the quarter retag', () => {
  assert.ok(typesOf('Moneyline', 'moneyline').includes('moneyline'));
  assert.ok(typesOf('Total Points', 'total').includes('total'));
  assert.ok(typesOf('Spread', 'spread').includes('spread'));
});

test('first half retags to first_half_*, never a quarter', () => {
  const t = typesOf('First Half Moneyline', 'moneyline');
  assert.ok(t.includes('first_half_moneyline'), 'got: ' + JSON.stringify(t));
  assert.ok(!t.some(x => /^quarter_/.test(x)));
});

test('team totals retag to team_total (PX types them `total`)', () => {
  const t = typesOf('NYJ: Team Total Points', 'total');
  assert.ok(t.includes('team_total'), 'got: ' + JSON.stringify(t));
  assert.ok(!t.includes('total'), 'must not alias the full-game total');
});
