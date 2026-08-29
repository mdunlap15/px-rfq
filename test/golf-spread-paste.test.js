// Operator paste of the ±0.5 round matchup board.
//
// Needed because the scraped book and PX build DIFFERENT pairings from R3 on.
// Measured 2026-08-29: only 2 of 14 scraped pairings matched PX's, so 12
// matchups were registered but unpriceable. R2 matched 14/14 because both used
// tee-time groupings; from R3 each book constructs its own head-to-heads (PX
// even lists one player in two matchups, which a tee-time pairing cannot do).
// Scraping cannot fix that — only a board on PX's own pairings can.
//
// Run: npm test  (or: node --test test/golf-spread-paste.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const bo = require('../services/betonline-golf-matchups');

const BLOCK = (round, p1, p2, ml1, ml2, h1, o1, h2, o2) =>
  [`ROUND ${round} MATCHUP - TOUR CHAMPIONSHIP`, '08/29', '11:19', p1, p2, ml1, ml2, h1, o1, h2, o2].join('\n');

// Real rows from the operator's 2026-08-29 R3 paste.
const REAL = [
  BLOCK(3, 'Viktor Hovland', 'Matt Fitzpatrick', '-118', '-112', '-0.5', '+112', '+0.5', '-142'),
  BLOCK(3, 'Collin Morikawa', 'Scottie Scheffler', '+153', '-194', '+0.5', '+122', '-0.5', '-153'),
  BLOCK(3, 'Min Woo Lee', 'Alex Fitzpatrick', '-115', '-115', '+0.5', '-145', '-0.5', '+115'),
].join('\n');

test('parses the operator paste format', () => {
  const { round, rows } = bo.parsePasteText(REAL);
  assert.strictEqual(round, 3);
  assert.strictEqual(rows.length, 3);
});

test('the handicap comes from the paste, and sides are opposite', () => {
  const { rows } = bo.parsePasteText(REAL);
  const m = rows.find(r => r.players.includes('Scottie Scheffler'));
  const sch = m.spread.find(s => s.player === 'Scottie Scheffler');
  const mor = m.spread.find(s => s.player === 'Collin Morikawa');
  assert.strictEqual(sch.handicap, '-0.5');
  assert.strictEqual(mor.handicap, '+0.5');
  assert.ok(Math.abs(sch.fair + mor.fair - 1) < 1e-9, 'de-vigged sides must complement');
  // Cross-checked by hand against the paste: Scheffler -0.5 ≈ 57.3%.
  assert.ok(Math.abs(sch.fair - 0.573) < 0.002, `got ${sch.fair}`);
});

test('loadPaste installs the board and marks it source=paste', () => {
  const out = bo.loadPaste(REAL);
  assert.strictEqual(out.round, 3);
  assert.strictEqual(out.matchups, 3);
  const st = bo.getStatus();
  assert.strictEqual(st.source, 'paste');
  assert.strictEqual(st.round, 3);
});

test('pasted board prices a pairing the SCRAPE did not have', () => {
  bo.loadPaste(REAL);
  // Scheffler v Morikawa is a PX pairing the scraped board lacked entirely.
  const hit = bo.getSpreadFairSync('Scottie Scheffler', 'Collin Morikawa', 3);
  assert.ok(hit, 'must price from the paste');
  assert.strictEqual(hit.handicap, '-0.5');
});

test('round is still enforced against a pasted board', () => {
  bo.loadPaste(REAL);
  assert.strictEqual(bo.getSpreadFairSync('Scottie Scheffler', 'Collin Morikawa', 4), null,
    'an R4 leg must not price off an R3 paste');
});

test('THE BASIS GATE: a ties-VOID board is refused', () => {
  // Same pairings but the "spread" prices equal the moneyline — i.e. no tie
  // mass, so this is not the ±0.5 product. Pricing PX's spread off it would
  // give away ~9pp on the +0.5 side.
  const void_ = BLOCK(3, 'A Player', 'B Player', '-118', '-112', '-0.5', '-118', '+0.5', '-112');
  assert.throws(() => bo.loadPaste(void_), /tie rate/i);
});

test('a paste mixing rounds is refused outright', () => {
  const mixed = [
    BLOCK(3, 'A One', 'B One', '-115', '-115', '+0.5', '-145', '-0.5', '+115'),
    BLOCK(4, 'C One', 'D One', '-115', '-115', '+0.5', '-145', '-0.5', '+115'),
  ].join('\n');
  assert.throws(() => bo.parsePasteText(mixed), /mixes rounds/i);
});

test('empty or junk text throws rather than installing an empty board', () => {
  assert.throws(() => bo.parsePasteText('hello world'), /no matchups/i);
});
