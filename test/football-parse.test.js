// Regression tests: football market parsing in px.parseMarketSelections.
//
// Three traps, all measured in NFL_CFB_READINESS_2026-08-05.md:
//
// 1. PERIOD COLLISION — PX types "Second Half Total Points" as plain 'total'
//    and its 2H market carries line 35.5, the SAME line as the full-game
//    ladder. Without a retag, a 2H leg is byte-indistinguishable from a
//    full-game leg and prices ~2x wrong (true P(2H under 35.5) ~98-99%).
//    The retag must hold even if the seed's name filter is later relaxed —
//    the marketType can NEVER be a full-game type.
//
// 2. PROP-AS-MONEYLINE — PX types football props 'sup_moneyline' with YES/NO
//    selections and the player only in the market NAME ("Jeremiah Love To
//    Score a Touchdown", event 19453). The BTTS/MoV/tennis-sets shape trap,
//    fourth occurrence: a prop that parses as a moneyline turns prop+total
//    into an ALLOWED ml_total priced off the team line, and YES/NO must never
//    reach team matching.
//
// 3. MULTI-PLAYER COMPOSITES — "Kenny Pickett or Carson Beck To Throw An
//    Interception?" is an OR-of-two-players market no book posts anywhere.
//    It must return ZERO selections so the leg declines, never a parse.
//
// Fixtures use the raw PX market shapes (selections array-of-arrays for
// moneyline/YES-NO, market_lines for spread/total) because the parser reading
// raw shapes is the whole point — a pre-digested fixture would pass while
// production fails.
//
// Run: node --test test/football-parse.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const px = require('../services/prophetx');
const { parseMarketSelections, isFootballPropMarketTypeSafe } = px;

// --- Fixture builders (raw PX shapes) --------------------------------------

// Moneyline-shaped: selections is an array of single-element arrays.
function mlMarket(name, type = 'moneyline') {
  return {
    type,
    name,
    selections: [
      [{ line_id: `${name}:away`, name: 'Carolina Panthers', display_name: 'Carolina Panthers +150', competitor_id: 'c-car' }],
      [{ line_id: `${name}:home`, name: 'Arizona Cardinals', display_name: 'Arizona Cardinals -170', competitor_id: 'c-ari' }],
    ],
  };
}

// Total-shaped: market_lines wrapper, over/under selections per line.
function totalMarket(name, line) {
  return {
    type: 'total',
    name,
    market_lines: [{
      line,
      selections: [
        [{ line_id: `${name}:o${line}`, name: `Over ${line}`, display_name: `Over ${line}`, line }],
        [{ line_id: `${name}:u${line}`, name: `Under ${line}`, display_name: `Under ${line}`, line }],
      ],
    }],
  };
}

// Spread-shaped: market_lines wrapper, signed lines per side.
function spreadMarket(name, absLine) {
  return {
    type: 'spread',
    name,
    market_lines: [{
      line: -absLine,
      selections: [
        [{ line_id: `${name}:fav`, name: 'Arizona Cardinals', display_name: `Arizona Cardinals -${absLine}`, line: -absLine, competitor_id: 'c-ari' }],
        [{ line_id: `${name}:dog`, name: 'Carolina Panthers', display_name: `Carolina Panthers +${absLine}`, line: absLine, competitor_id: 'c-car' }],
      ],
    }],
  };
}

// YES/NO-shaped (props): PX types these 'sup_moneyline'; player is ONLY in
// the market name; selections are literally Yes/No.
function yesNoMarket(name, type = 'sup_moneyline') {
  return {
    type,
    name,
    selections: [
      [{ line_id: `${name}:yes`, name: 'Yes', display_name: 'Yes +200' }],
      [{ line_id: `${name}:no`, name: 'No', display_name: 'No -300' }],
    ],
  };
}

const FULL_GAME_TYPES = new Set(['moneyline', 'spread', 'total', 'team_total']);

// --- 1. Period retags: Second Half ------------------------------------------

test('"Second Half Total Points" @35.5 retags every leg to second_half_total — never plain total', () => {
  const rows = parseMarketSelections(totalMarket('Second Half Total Points', 35.5));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.marketType, 'second_half_total');
    assert.notEqual(r.marketType, 'total');
    assert.equal(r.line, 35.5); // the line the full-game ladder ALSO carries
  }
  assert.deepEqual(rows.map(r => r.selection).sort(), ['over', 'under']);
});

test('"Second Half Moneyline" retags to second_half_moneyline', () => {
  const rows = parseMarketSelections(mlMarket('Second Half Moneyline'));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.marketType, 'second_half_moneyline');
});

test('"Second Half Spread" retags to second_half_spread with favorite/underdog sides', () => {
  const rows = parseMarketSelections(spreadMarket('Second Half Spread', 0.5));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.marketType, 'second_half_spread');
  assert.deepEqual(rows.map(r => r.selection).sort(), ['favorite', 'underdog']);
});

test('"2nd Half Total Points" (numeric ordinal) also retags', () => {
  const rows = parseMarketSelections(totalMarket('2nd Half Total Points', 16.5));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.marketType, 'second_half_total');
});

test('2H alt total delivered FLAT (no market_lines wrapper) fails closed — zero legs, never total', () => {
  const m = {
    type: 'total',
    name: 'Second Half Total Points',
    line: 35.5,
    selections: [
      [{ line_id: 'flat:o', name: 'Over 35.5', display_name: 'Over 35.5', line: 35.5 }],
      [{ line_id: 'flat:u', name: 'Under 35.5', display_name: 'Under 35.5', line: 35.5 }],
    ],
  };
  const rows = parseMarketSelections(m);
  // The invariant is "never marketType total"; today the fail-closed form of
  // that is zero selections (the flat fallback branch deliberately excludes
  // period types, mirroring first-half).
  for (const r of rows) assert.notEqual(r.marketType, 'total');
  assert.equal(rows.length, 0);
});

// --- 1b. Period retags: quarters --------------------------------------------

test('quarter markets retag to quarter_N_* with the quarter number preserved', () => {
  const cases = [
    [mlMarket('1st Quarter Moneyline'), 'quarter_1_moneyline'],
    [spreadMarket('2nd Quarter Spread', 0.5), 'quarter_2_spread'],
    [totalMarket('3rd Quarter Total Points', 10.5), 'quarter_3_total'],
    [totalMarket('4th Quarter Total Points', 10.5), 'quarter_4_total'],
    [mlMarket('First Quarter Moneyline'), 'quarter_1_moneyline'],
  ];
  for (const [market, expected] of cases) {
    const rows = parseMarketSelections(market);
    assert.ok(rows.length > 0, `${market.name} must still parse selections`);
    for (const r of rows) {
      assert.equal(r.marketType, expected, `${market.name} → ${expected}`);
      assert.ok(!FULL_GAME_TYPES.has(r.marketType));
    }
  }
});

test('adversarial: a period team total never steals team_total (or total)', () => {
  // Not yet observed on PX, but the collision is mechanical: the name matches
  // BOTH the team-total pattern and the 2H pattern. The period retag must win
  // (a half team total priced off the full-game team-total consensus is the
  // same 2x bug in team clothing).
  const rows = parseMarketSelections(totalMarket('ARI: Second Half Team Total Points', 17.5));
  for (const r of rows) {
    assert.notEqual(r.marketType, 'team_total');
    assert.notEqual(r.marketType, 'total');
    assert.equal(r.marketType, 'second_half_total');
  }
});

// --- 1c. Regressions: First Half + full game unchanged -----------------------

test('regression: First Half retag unchanged', () => {
  const ml = parseMarketSelections(mlMarket('First Half Moneyline'));
  assert.equal(ml.length, 2);
  for (const r of ml) assert.equal(r.marketType, 'first_half_moneyline');

  const tot = parseMarketSelections(totalMarket('1st Half Total Points', 17.5));
  assert.equal(tot.length, 2);
  for (const r of tot) assert.equal(r.marketType, 'first_half_total');
});

test('regression: full-game markets keep their plain types', () => {
  const ml = parseMarketSelections(mlMarket('Moneyline'));
  assert.equal(ml.length, 2);
  for (const r of ml) assert.equal(r.marketType, 'moneyline');

  const tot = parseMarketSelections(totalMarket('Total Points', 35.5));
  assert.equal(tot.length, 2);
  for (const r of tot) assert.equal(r.marketType, 'total');

  const sp = parseMarketSelections(spreadMarket('Spread', 2.5));
  assert.equal(sp.length, 2);
  for (const r of sp) assert.equal(r.marketType, 'spread');
});

test('regression: PX-abbreviated team total still parses as team_total with the abbreviation hint', () => {
  const rows = parseMarketSelections(totalMarket('ARI: Team Total Points', 21.5));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.marketType, 'team_total');
    assert.equal(r.teamName, 'ARI'); // hint for line-manager side matching
  }
});

// --- 2. Football player props (YES/NO, player only in the NAME) --------------

test('"Jeremiah Love To Score a Touchdown" parses as player_anytime_td with the player lifted from the name', () => {
  const rows = parseMarketSelections(yesNoMarket('Jeremiah Love To Score a Touchdown'));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.marketType, 'player_anytime_td');
    assert.equal(r.playerName, 'Jeremiah Love');
    assert.equal(r.line, null);
    // YES/NO must never surface as a team to be matched.
    assert.ok(['yes', 'no'].includes(r.selection));
    assert.notEqual(r.selection, 'team');
    assert.notEqual(r.teamName.toLowerCase(), 'yes');
    assert.notEqual(r.teamName.toLowerCase(), 'no');
  }
  assert.deepEqual(rows.map(r => r.selection).sort(), ['no', 'yes']);
});

test('trailing question mark variant parses identically', () => {
  const rows = parseMarketSelections(yesNoMarket('Jeremiah Love To Score a Touchdown?'));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.marketType, 'player_anytime_td');
});

test('the branch keys on the NAME, not on type sup_moneyline (survives a PX retype to moneyline)', () => {
  const rows = parseMarketSelections(yesNoMarket('Jeremiah Love To Score a Touchdown', 'moneyline'));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.marketType, 'player_anytime_td');
    // Had this fallen through, the moneyline builder would have emitted
    // teamName 'Yes'/'No' with selection 'unknown' — team matching territory.
    assert.ok(['yes', 'no'].includes(r.selection));
  }
});

test('parsed prop legs pass the registration-safety assertion', () => {
  const rows = parseMarketSelections(yesNoMarket('Jeremiah Love To Score a Touchdown'));
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(isFootballPropMarketTypeSafe(r.marketType), true);
  }
});

// --- 3. Multi-player composites MUST return zero selections ------------------

test('"Kenny Pickett or Carson Beck To Throw An Interception?" returns ZERO selections', () => {
  const rows = parseMarketSelections(yesNoMarket('Kenny Pickett or Carson Beck To Throw An Interception?'));
  assert.deepEqual(rows, []);
});

test('adversarial: multi-player TD market satisfies the anchor but still fails closed', () => {
  const rows = parseMarketSelections(yesNoMarket('Jeremiah Love or Kenny Pickett To Score a Touchdown'));
  assert.deepEqual(rows, []);
});

test('adversarial: multi-player TD typed moneyline never reaches the moneyline builder', () => {
  // Early-return [] matters here: falling through would emit YES/NO legs as
  // moneyline "teams" — safe only by accident (the BTTS lesson).
  const rows = parseMarketSelections(yesNoMarket('Jeremiah Love or Kenny Pickett To Score a Touchdown', 'moneyline'));
  assert.deepEqual(rows, []);
});

test('adversarial: team-unit composite ("D/ST") fails closed', () => {
  const rows = parseMarketSelections(yesNoMarket('Arizona Cardinals D/ST To Score a Touchdown'));
  assert.deepEqual(rows, []);
});

// --- 3b. Branch-ordering regressions (the neighbours keep working) -----------

test('regression: UFC MoV branch is untouched by the football prop branch', () => {
  const rows = parseMarketSelections(yesNoMarket('Kamaru Usman To Win By KO/TKO/DQ', 'moneyline'));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.marketType, 'mov_ko');
    assert.equal(r.playerName, 'Kamaru Usman');
  }
});

test('regression: tennis "To Win At Least One Set" branch is untouched', () => {
  const rows = parseMarketSelections(yesNoMarket('Carlos Alcaraz To Win At Least One Set', 'moneyline'));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.marketType, 'set_win_at_least_one');
});

// --- 4. isFootballPropMarketTypeSafe ----------------------------------------

test('registration assertion rejects every full-game marketType', () => {
  for (const mt of ['moneyline', 'spread', 'total', 'team_total']) {
    assert.equal(isFootballPropMarketTypeSafe(mt), false, mt);
  }
});

test('registration assertion fails CLOSED on absent/blank/unknown types', () => {
  for (const mt of [undefined, null, '', '   ', 42, {}, 'sup_moneyline', 'btts', 'unclassified']) {
    assert.equal(isFootballPropMarketTypeSafe(mt), false, String(mt));
  }
});

test('registration assertion rejects case/whitespace disguises of full-game types', () => {
  for (const mt of ['MONEYLINE', ' Total ', 'Team_Total', 'SPREAD']) {
    assert.equal(isFootballPropMarketTypeSafe(mt), false, mt);
  }
});

test('registration assertion rejects period retags (a prop must never carry one)', () => {
  for (const mt of ['first_half_moneyline', 'second_half_total', 'quarter_1_total', 'quarter_4_spread']) {
    assert.equal(isFootballPropMarketTypeSafe(mt), false, mt);
  }
});

test('registration assertion accepts player_-prefixed prop types only', () => {
  for (const mt of ['player_anytime_td', 'player_pass_yds', 'player_receptions']) {
    assert.equal(isFootballPropMarketTypeSafe(mt), true, mt);
  }
  // The prefix alone is the contract the pricer's prop protections key on —
  // a bare 'player_' or non-prefixed prop name is not a valid prop type.
  assert.equal(isFootballPropMarketTypeSafe('player_'), false);
  assert.equal(isFootballPropMarketTypeSafe('anytime_td'), false);
});

test('adversarial: a full-game leg mislabeled as a prop is caught by the assertion', () => {
  // If registration ever routes a full-game football leg down the prop path,
  // the assertion — not luck — must refuse it.
  const rows = parseMarketSelections(mlMarket('Moneyline'));
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(isFootballPropMarketTypeSafe(r.marketType), false);
  }
});
