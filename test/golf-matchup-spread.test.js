// PX golf matchup ±0.5 SPREAD parsing.
//
// PX posts TWO markets per matchup: a ties-VOID moneyline and this ±0.5 spread
// where ties COUNT. Measured tie rate 9.3%, so mixing the two bases gives away
// ~9pp on the +0.5 side against a 1-2pp parlay margin.
//
// Two shape traps make this market unusually easy to get silently wrong:
//   1. sel.line is 0 on BOTH sides — the handicap lives only in the selection
//      name, so a generic spread parser registers line 0 and (because
//      `undefined < 0` is false) tags BOTH sides 'underdog'.
//   2. Selections are abbreviated codes of INCONSISTENT length ("SCH", "REIT")
//      and the full names appear only in the market name.
//
// Run: npm test   (or: node --test test/golf-matchup-spread.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const px = require('../services/prophetx');

const mkt = (name, sels) => ({ type: 'sup_moneyline', name, selections: [sels] });

// ------------------------------------------------------------- happy path

test('parses both sides with full names, signed handicaps and round', () => {
  const out = px.parseMarketSelections(mkt(
    'Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup) - Spread',
    [{ name: 'SCH -0.5', line: 0, odds: -148, line_id: 'a' },
     { name: 'ABE +0.5', line: 0, odds: 118, line_id: 'b' }]));
  assert.strictEqual(out.length, 2);
  const sch = out.find(o => o.teamName === 'Scottie Scheffler');
  const abe = out.find(o => o.teamName === 'Ludvig Aberg');
  assert.ok(sch && abe, 'both abbreviations must resolve to full names');
  assert.strictEqual(sch.marketType, 'golf_matchup_spread');
  assert.strictEqual(sch.line, -0.5, 'handicap must come from the NAME — sel.line is 0');
  assert.strictEqual(abe.line, 0.5);
  assert.strictEqual(sch.selection, 'favorite');
  assert.strictEqual(abe.selection, 'underdog');
  assert.strictEqual(sch.roundNum, 2);
});

test('a 4-char abbreviation resolves (length is inconsistent)', () => {
  const out = px.parseMarketSelections(mkt(
    'Kristoffer Reitan vs. Russell Henley (Round 2 Matchup) - Spread',
    [{ name: 'HEN -0.5', line: 0, odds: -132, line_id: 'a' },
     { name: 'REIT +0.5', line: 0, odds: 103, line_id: 'b' }]));
  assert.strictEqual(out.length, 2);
  assert.ok(out.find(o => o.teamName === 'Kristoffer Reitan' && o.line === 0.5));
});

test('marketType is NEVER moneyline or spread', () => {
  const out = px.parseMarketSelections(mkt(
    'Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup) - Spread',
    [{ name: 'SCH -0.5', line: 0, odds: -148, line_id: 'a' },
     { name: 'ABE +0.5', line: 0, odds: 118, line_id: 'b' }]));
  for (const o of out) {
    // 'moneyline' would alias the ties-VOID sibling on the same event and be
    // priced off DataGolf. 'spread' would route it through the alt-spread
    // blocks and let classifySgpCombo read a same-pairing pair as 'ml_spread'.
    assert.strictEqual(o.marketType, 'golf_matchup_spread');
  }
});

// ------------------------------------------------ fail-closed (the whole point)

test('REAL PX DATA BUG: market name names a DIFFERENT pairing than its selections', () => {
  // Captured live 2026-08-27. PX served this market inside event "Alex
  // Fitzpatrick vs. Patrick Cantlay", but NAMED it for Clark/Rose. The
  // selections (CAN/FIT at -127/-102) match BetOnline's Cantlay/Fitzpatrick
  // line, so the odds are right and the NAME is wrong. Registering it would
  // attach real prices to a pairing we cannot verify.
  const out = px.parseMarketSelections(mkt(
    'Wyndham Clark vs. Justin Rose (Round 2 Matchup) - Spread',
    [{ name: 'CAN -0.5', line: 0, odds: -127, line_id: 'a' },
     { name: 'FIT +0.5', line: 0, odds: -102, line_id: 'b' }]));
  assert.deepStrictEqual(out, [], 'must decline the whole market, not register a partial');
});

test('a same-surname pairing is ambiguous and registers nothing', () => {
  // Matt vs Alex Fitzpatrick is a real possible pairing; "FIT" cannot pick one.
  const out = px.parseMarketSelections(mkt(
    'Matt Fitzpatrick vs. Alex Fitzpatrick (Round 2 Matchup) - Spread',
    [{ name: 'FIT -0.5', line: 0, odds: -120, line_id: 'a' },
     { name: 'FIT +0.5', line: 0, odds: 100, line_id: 'b' }]));
  assert.deepStrictEqual(out, []);
});

test('both sides on the same side of the handicap registers nothing', () => {
  const out = px.parseMarketSelections(mkt(
    'Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup) - Spread',
    [{ name: 'SCH -0.5', line: 0, odds: -148, line_id: 'a' },
     { name: 'ABE -0.5', line: 0, odds: 118, line_id: 'b' }]));
  assert.deepStrictEqual(out, []);
});

test('only one resolvable side registers nothing (no partial matchups)', () => {
  const out = px.parseMarketSelections(mkt(
    'Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup) - Spread',
    [{ name: 'SCH -0.5', line: 0, odds: -148, line_id: 'a' },
     { name: 'ZZZ +0.5', line: 0, odds: 118, line_id: 'b' }]));
  assert.deepStrictEqual(out, []);
});

test('the ties-void moneyline sibling is NOT claimed by this branch', () => {
  // Same event, no " - Spread" suffix, type=moneyline, full-name selections.
  const out = px.parseMarketSelections({
    type: 'moneyline',
    name: 'Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup)',
    selections: [[{ name: 'Scottie Scheffler', line: 0, odds: -182, line_id: 'a' },
                  { name: 'Ludvig Aberg', line: 0, odds: 164, line_id: 'b' }]],
  });
  for (const o of out) assert.notStrictEqual(o.marketType, 'golf_matchup_spread');
});

// ------------------------------------------------------------- the resolver

test('resolveGolfAbbrev: surname prefix wins', () => {
  assert.strictEqual(px.resolveGolfAbbrev('SCH', ['Ludvig Aberg', 'Scottie Scheffler']), 'Scottie Scheffler');
  assert.strictEqual(px.resolveGolfAbbrev('MAC', ['Tom Kim', 'Robert MacIntyre']), 'Robert MacIntyre');
});

test('resolveGolfAbbrev: a multi-token surname still resolves off the last token', () => {
  assert.strictEqual(px.resolveGolfAbbrev('LEE', ['Min Woo Lee', 'Viktor Hovland']), 'Min Woo Lee');
});

test('resolveGolfAbbrev: ambiguity returns null and does NOT fall through to a looser tier', () => {
  assert.strictEqual(px.resolveGolfAbbrev('FIT', ['Matt Fitzpatrick', 'Alex Fitzpatrick']), null);
  assert.strictEqual(px.resolveGolfAbbrev('KIM', ['Si Woo Kim', 'Tom Kim']), null);
});

test('resolveGolfAbbrev: unknown code returns null', () => {
  assert.strictEqual(px.resolveGolfAbbrev('ZZZ', ['Ludvig Aberg', 'Scottie Scheffler']), null);
});

test('resolveGolfAbbrev: accents do not break matching', () => {
  assert.strictEqual(px.resolveGolfAbbrev('ABE', ['Ludvig Åberg', 'Scottie Scheffler']), 'Ludvig Åberg');
});

test('GOLF_MATCHUP_SPREAD_RE: does not match the moneyline sibling or other sup_moneyline markets', () => {
  const re = px.GOLF_MATCHUP_SPREAD_RE;
  assert.ok(re.test('Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup) - Spread'));
  assert.ok(!re.test('Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup)'), 'moneyline sibling');
  assert.ok(!re.test('Series Game Spread'), 'series sup_moneyline');
  assert.ok(!re.test('Spread'), 'soccer asian handicap');
  assert.ok(!re.test('To Advance To The Next Round'), 'advance market');
});
