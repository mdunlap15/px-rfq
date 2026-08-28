// Tests for the BetOnline golf ±0.5 matchup board.
//
// The market this feeds is a TIES-COUNT ±0.5 spread. Every other matchup feed
// available to us (DataGolf and the books it aggregates) is TIES-VOID, and the
// measured single-round tie rate is 9.3% — so a leg priced off the wrong basis
// gives away ~9pp against a 1-2pp parlay margin. These tests lock the parse and
// the fail-closed reads that keep that from happening silently.
//
// Run: npm test   (or: node --test test/betonline-golf-matchups.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const bo = require('../services/betonline-golf-matchups');

// A real row, verbatim from the live board 2026-08-27.
const REAL_ROW = [
  'Tomorrow,', '1:24 PM', '7221 -', 'Ludvig Aberg', '7222 -', 'Scottie Scheffler',
  'Spread', '+0.5', '+117', '-0.5', '-150', 'Moneyline', '+149', '-180',
].join('\n');

// ------------------------------------------------------------------ parseRow

test('parseRow: reads both players, both ±0.5 sides and the odds', () => {
  const r = bo.parseRow(REAL_ROW);
  assert.ok(r, 'should parse');
  assert.deepStrictEqual(r.players, ['Ludvig Aberg', 'Scottie Scheffler']);
  assert.strictEqual(r.spread[0].handicap, '+0.5');
  assert.strictEqual(r.spread[0].american, 117);
  assert.strictEqual(r.spread[1].handicap, '-0.5');
  assert.strictEqual(r.spread[1].american, -150);
});

test('parseRow: de-vigs to a proper 2-way (fairs sum to 1)', () => {
  const r = bo.parseRow(REAL_ROW);
  const sum = r.spread[0].fair + r.spread[1].fair;
  assert.ok(Math.abs(sum - 1) < 1e-9, `fairs must sum to 1, got ${sum}`);
  // Scheffler -0.5 measured at 56.6%
  assert.ok(Math.abs(r.spread[1].fair - 0.566) < 0.002, `got ${r.spread[1].fair}`);
  assert.ok(r.holdPct > 5 && r.holdPct < 8, `hold ${r.holdPct}% should be a sane book margin`);
});

test('parseRow: keeps the moneyline for the tie-rate cross-check', () => {
  assert.deepStrictEqual(bo.parseRow(REAL_ROW).moneylineAmerican, [149, -180]);
});

test('parseRow: a row with no Spread block returns null, not a partial', () => {
  const noSpread = 'Tomorrow,\n1:24 PM\n7221 -\nLudvig Aberg\n7222 -\nScottie Scheffler\nMoneyline\n+149\n-180';
  assert.strictEqual(bo.parseRow(noSpread), null);
});

test('THE TRAP: a handicap that is not ±0.5 is refused', () => {
  // A different handicap is a different product; pricing it as ±0.5 would be
  // silently wrong rather than an error.
  const wrong = REAL_ROW.replace('+0.5', '+1.5').replace('-0.5', '-1.5');
  assert.strictEqual(bo.parseRow(wrong), null);
});

test('THE TRAP: both sides on the SAME side of the handicap is refused', () => {
  const bad = REAL_ROW.replace('-0.5', '+0.5');
  assert.strictEqual(bo.parseRow(bad), null, 'not a valid 2-way');
});

test('parseRow: an absurd overround is refused', () => {
  const bad = REAL_ROW.replace('+117', '-500').replace('-150', '-500');
  assert.strictEqual(bo.parseRow(bad), null);
});

test('parseRow: a row with only one player is refused', () => {
  const one = 'Tomorrow,\n1:24 PM\n7221 -\nLudvig Aberg\nSpread\n+0.5\n+117\n-0.5\n-150';
  assert.strictEqual(bo.parseRow(one), null);
});

// ------------------------------------------------------------ impliedTieRate

test('impliedTieRate: recovers ~9% from the spread-vs-moneyline gap', () => {
  const rows = [bo.parseRow(REAL_ROW)];
  const t = bo.impliedTieRate(rows);
  assert.ok(t > 0.06 && t < 0.13, `expected a single-round tie rate near 9%, got ${(100 * t).toFixed(1)}%`);
});

test('impliedTieRate: null when no moneyline is present to compare against', () => {
  const r = bo.parseRow(REAL_ROW);
  r.moneylineAmerican = null;
  assert.strictEqual(bo.impliedTieRate([r]), null);
});

// ---------------------------------------------------------------- normName

test('normName: accents and punctuation do not break matching', () => {
  assert.strictEqual(bo.normName('Vinícius Júnior'), bo.normName('Vinicius Junior'));
  assert.strictEqual(bo.normName('Matt Fitzpatrick '), 'matt fitzpatrick');
});

// -------------------------------------------------- getSpreadFairSync (hot path)

const BOARD = [bo.parseRow(REAL_ROW), bo.parseRow(
  'Tomorrow,\n11:12 AM\n7201 -\nKristoffer Reitan\n7202 -\nRussell Henley\nSpread\n+0.5\n+102\n-0.5\n-133\nMoneyline\n+133\n-160')];

test('getSpreadFairSync: resolves the correct side for each player', () => {
  bo._setBoardForTest(BOARD);
  const sch = bo.getSpreadFairSync('Scottie Scheffler', 'Ludvig Aberg');
  const abe = bo.getSpreadFairSync('Ludvig Aberg', 'Scottie Scheffler');
  assert.strictEqual(sch.handicap, '-0.5');
  assert.strictEqual(abe.handicap, '+0.5');
  assert.ok(Math.abs(sch.fairProb + abe.fairProb - 1) < 1e-9, 'the two sides must complement');
});

test('getSpreadFairSync: unknown player fails closed', () => {
  bo._setBoardForTest(BOARD);
  assert.strictEqual(bo.getSpreadFairSync('Tiger Woods', 'Ludvig Aberg'), null);
});

test('THE TRAP: the opponent must match too — a right player in the WRONG pairing is refused', () => {
  bo._setBoardForTest(BOARD);
  // Both are on the board, but not against each other. Pricing this off
  // whichever row happened to contain the player is the Magomedov failure.
  assert.strictEqual(bo.getSpreadFairSync('Scottie Scheffler', 'Russell Henley'), null);
});

test('THE TRAP: a stale board fails closed rather than quoting old prices', () => {
  bo._setBoardForTest(BOARD, Date.now() - 60 * 60000); // 60 min, past the 45 default
  assert.strictEqual(bo.getSpreadFairSync('Scottie Scheffler', 'Ludvig Aberg'), null);
});

test('getSpreadFairSync: a fresh board inside max age prices normally', () => {
  bo._setBoardForTest(BOARD, Date.now() - 5 * 60000);
  assert.ok(bo.getSpreadFairSync('Scottie Scheffler', 'Ludvig Aberg'));
});

test('THE TRAP: a duplicated pairing is ambiguous and fails closed', () => {
  bo._setBoardForTest([...BOARD, bo.parseRow(REAL_ROW)]);
  assert.strictEqual(bo.getSpreadFairSync('Scottie Scheffler', 'Ludvig Aberg'), null);
});

test('getSpreadFairSync: no board at all fails closed', () => {
  bo._setBoardForTest(null);
  assert.strictEqual(bo.getSpreadFairSync('Scottie Scheffler', 'Ludvig Aberg'), null);
});

test('config ships the kill-switch OFF by default', () => {
  const saved = process.env.BETONLINE_GOLF_ENABLED;
  delete process.env.BETONLINE_GOLF_ENABLED;
  delete require.cache[require.resolve('../config')];
  const { config } = require('../config');
  assert.strictEqual(config.betonlineGolf.enabled, false, 'a new money path must be opt-in');
  if (saved != null) process.env.BETONLINE_GOLF_ENABLED = saved;
  delete require.cache[require.resolve('../config')];
});
