// NFL/football consensus sourcing (2026-08-21), ported from the operator's PX
// Order Book methodology so RFQ pricing and the single-leg book agree on where
// a football number comes from.
//
// The rules under test, all operator-specified:
//   * per-side consensus = MEDIAN of per-book RAW implied probs (vig retained)
//   * >= 2 books carrying that exact line, else DECLINE (never price off one
//     book — an outlier once set a soft price and a taker picked us off)
//   * main line = median of the books' MAIN-key point, snapped to 0.5
//   * over/under and home/away paired at the SAME line before de-vig
//
// Plus the one RFQ adaptation: the operator's consensus RETAINS vig, but
// priceParlay multiplies FAIR probs, so every pair is de-vigged here.
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const nc = require('../services/nfl-consensus');

test('impliedFromAmerican matches the operator formula on both signs', () => {
  assert.ok(Math.abs(nc.impliedFromAmerican(100) - 0.5) < 1e-12);
  assert.ok(Math.abs(nc.impliedFromAmerican(-110) - (110 / 210)) < 1e-12);
  assert.ok(Math.abs(nc.impliedFromAmerican(150) - (100 / 250)) < 1e-12);
  assert.equal(nc.impliedFromAmerican(0), null);
  assert.equal(nc.impliedFromAmerican('nope'), null);
});

test('americanFromImplied round-trips away from the even-money boundary', () => {
  for (const a of [-200, -110, 150, 633]) {
    assert.equal(nc.americanFromImplied(nc.impliedFromAmerican(a)), a);
  }
});

test('even money is ambiguous by construction: +100 and -100 are both 50%', () => {
  // Not a defect — p=0.5 has two valid American spellings. The converter picks
  // the negative one; anything comparing prices must compare PROBABILITIES.
  assert.equal(nc.impliedFromAmerican(100), 0.5);
  assert.equal(nc.impliedFromAmerican(-100), 0.5);
  assert.equal(nc.americanFromImplied(0.5), -100);
});

test('median: odd takes middle, even takes mean of middle two', () => {
  assert.equal(nc.median([3, 1, 2]), 2);
  assert.equal(nc.median([1, 2, 3, 4]), 2.5);
  assert.equal(nc.median([]), null);
});

test('consensusSide medians the implied probs and counts books', () => {
  // -110, -110, -120 → medians to the -110 implied
  const c = nc.consensusSide([-110, -110, -120]);
  assert.equal(c.books, 3);
  assert.ok(Math.abs(c.p - (110 / 210)) < 1e-12);
});

test('HARD RULE: a single book declines rather than prices', () => {
  assert.equal(nc.consensusSide([-110]), null, 'one book must decline');
  assert.ok(nc.consensusSide([-110, -105]), 'two books price');
});

test('consensusSide drops unparseable prices before the min-book count', () => {
  assert.equal(nc.consensusSide([-110, 'x', 0]), null, 'only one usable price left');
});

test('deVigPair removes the overround and sums to 1', () => {
  const a = nc.impliedFromAmerican(-110); // .5238
  const r = nc.deVigPair(a, a);
  assert.ok(Math.abs(r.a - 0.5) < 1e-12);
  assert.ok(Math.abs(r.a + r.b - 1) < 1e-12);
  assert.ok(Math.abs(r.overround - 2 * a) < 1e-12, 'overround is reported for diagnostics');
});

test('deVigPair keeps the favourite the favourite', () => {
  const fav = nc.impliedFromAmerican(-200);
  const dog = nc.impliedFromAmerican(160);
  const r = nc.deVigPair(fav, dog);
  assert.ok(r.a > r.b);
  assert.ok(Math.abs(r.a + r.b - 1) < 1e-12);
});

test('pickMainLine medians and snaps to the nearest 0.5', () => {
  assert.equal(nc.pickMainLine([44, 44.5, 44.5]), 44.5);
  assert.equal(nc.pickMainLine([43.8, 44.1]), 44);      // 43.95 → 44
  assert.equal(nc.pickMainLine([]), null, 'no main-key points → decline');
});

// --- buildBoard -----------------------------------------------------------

const mkBook = (key, markets) => ({ key, markets });
const payload = (bookmakers) => ({
  home_team: 'Pittsburgh Steelers', away_team: 'New York Jets', bookmakers,
});

test('builds a de-vigged moneyline from two books', () => {
  const b = nc.buildBoard(payload([
    mkBook('pinnacle', [{ key: 'h2h', outcomes: [
      { name: 'Pittsburgh Steelers', price: -140 }, { name: 'New York Jets', price: 120 }] }]),
    mkBook('draftkings', [{ key: 'h2h', outcomes: [
      { name: 'Pittsburgh Steelers', price: -145 }, { name: 'New York Jets', price: 125 }] }]),
  ]));
  const ml = b.markets.moneyline.lines.ml;
  assert.ok(Math.abs(ml.fair.home + ml.fair.away - 1) < 1e-12, 'fair sums to 1');
  assert.ok(ml.raw.home + ml.raw.away > 1, 'raw retains vig');
  assert.equal(ml.books.home, 2);
});

test('a one-book market is dropped entirely', () => {
  const b = nc.buildBoard(payload([
    mkBook('pinnacle', [{ key: 'h2h', outcomes: [
      { name: 'Pittsburgh Steelers', price: -140 }, { name: 'New York Jets', price: 120 }] }]),
  ]));
  assert.equal(b, null, 'nothing priceable from a single book');
});

test('a one-SIDED market is dropped (cannot de-vig)', () => {
  const b = nc.buildBoard(payload([
    mkBook('pinnacle', [{ key: 'h2h', outcomes: [{ name: 'Pittsburgh Steelers', price: -140 }] }]),
    mkBook('draftkings', [{ key: 'h2h', outcomes: [{ name: 'Pittsburgh Steelers', price: -145 }] }]),
  ]));
  assert.equal(b, null);
});

test('spreads pair on the HOME point so -3.5 and +3.5 land in one bucket', () => {
  const sp = (h, a) => ({ key: 'spreads', outcomes: [
    { name: 'Pittsburgh Steelers', price: h, point: -3.5 },
    { name: 'New York Jets', price: a, point: 3.5 }] });
  const b = nc.buildBoard(payload([mkBook('pinnacle', [sp(-110, -110)]), mkBook('fanduel', [sp(-108, -112)])]));
  const lines = b.markets.spread.lines;
  assert.deepEqual(Object.keys(lines), ['-3.5'], 'one bucket, not two');
  assert.ok(Math.abs(lines['-3.5'].fair.home + lines['-3.5'].fair.away - 1) < 1e-12);
  assert.equal(b.markets.spread.mainLine, -3.5);
});

test('team totals pair per team AND per line — a middle is not a pair', () => {
  // The real TOA shape seen 2026-08-21: Over 18.5 / Under 19.5 on one book.
  const tt = (overPrice, underPrice, overPt, underPt) => ({ key: 'team_totals', outcomes: [
    { name: 'Over', description: 'New York Jets', price: overPrice, point: overPt },
    { name: 'Under', description: 'New York Jets', price: underPrice, point: underPt }] });
  const middled = nc.buildBoard(payload([
    mkBook('fanduel', [tt(-122, -122, 18.5, 19.5)]),
    mkBook('betmgm', [tt(-120, -120, 18.5, 19.5)]),
  ]));
  assert.equal(middled, null, 'mismatched points must NOT be de-vigged together');

  const matched = nc.buildBoard(payload([
    mkBook('fanduel', [tt(-115, -105, 18.5, 18.5)]),
    mkBook('betmgm', [tt(-110, -110, 18.5, 18.5)]),
  ]));
  const row = matched.markets.team_total.lines['New York Jets|18.5'];
  assert.ok(row, 'same-line team total prices');
  assert.ok(Math.abs(row.fair['New York Jets|over'] + row.fair['New York Jets|under'] - 1) < 1e-12);
});

test('alternate ladder does not move the main line', () => {
  const main = { key: 'totals', outcomes: [
    { name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -110, point: 44.5 }] };
  const alt = { key: 'alternate_totals', outcomes: [
    { name: 'Over', price: 200, point: 51.5 }, { name: 'Under', price: -260, point: 51.5 }] };
  const b = nc.buildBoard(payload([mkBook('pinnacle', [main, alt]), mkBook('draftkings', [main, alt])]));
  assert.equal(b.markets.total.mainLine, 44.5, 'alt ladder excluded from main-line median');
  assert.ok(b.markets.total.lines['51.5'], 'but the alt line is still priceable');
});

test('quarter markets are carried through with their own marketType', () => {
  const b = nc.buildBoard(payload([
    mkBook('fanduel', [{ key: 'h2h_q1', outcomes: [
      { name: 'Pittsburgh Steelers', price: -130 }, { name: 'New York Jets', price: 110 }] }]),
    mkBook('betrivers', [{ key: 'h2h_q1', outcomes: [
      { name: 'Pittsburgh Steelers', price: -125 }, { name: 'New York Jets', price: 105 }] }]),
  ]));
  assert.ok(b.markets.first_quarter_moneyline, 'q1 moneyline is sourced');
  assert.ok(!b.markets.moneyline, 'and does not leak into the full-game bucket');
});

test('getNflFairSync fails closed on a stale board', () => {
  nc.__clearCacheForTest();
  nc.__setCacheForTest('americanfootball_nfl_preseason|new york jets@pittsburgh steelers', {
    at: Date.now() - 24 * 3600 * 1000,
    board: { home: 'Pittsburgh Steelers', away: 'New York Jets', markets: {
      moneyline: { mainLine: null, lines: { ml: {
        sides: ['home', 'away'], raw: { home: 0.6, away: 0.45 },
        fair: { home: 0.571, away: 0.429 }, books: { home: 3, away: 3 }, overround: 1.05 } } } } },
  });
  const r = nc.getNflFairSync('americanfootball_nfl_preseason',
    'Pittsburgh Steelers', 'New York Jets', 'moneyline', 'home');
  assert.equal(r, null, 'a day-old board must decline');
});

test('getNflFairSync returns the DE-VIGGED prob, not the raw mirror', () => {
  nc.__clearCacheForTest();
  nc.__setCacheForTest('americanfootball_nfl_preseason|new york jets@pittsburgh steelers', {
    at: Date.now(),
    board: { home: 'Pittsburgh Steelers', away: 'New York Jets', markets: {
      moneyline: { mainLine: null, lines: { ml: {
        sides: ['home', 'away'], raw: { home: 0.6, away: 0.45 },
        fair: { home: 0.5714, away: 0.4286 }, books: { home: 3, away: 3 }, overround: 1.05 } } } } },
  });
  const r = nc.getNflFairSync('americanfootball_nfl_preseason',
    'Pittsburgh Steelers', 'New York Jets', 'moneyline', 'home');
  assert.ok(Math.abs(r.fairProb - 0.5714) < 1e-9);
  assert.ok(Math.abs(r.rawProb - 0.6) < 1e-9, 'raw mirror kept for diagnostics');
  assert.ok(/de-vigged/.test(r.basis));
});

test('non-football sports are never served by this module', () => {
  assert.equal(nc.isFootball('baseball_mlb'), false);
  assert.equal(nc.getNflFairSync('baseball_mlb', 'a', 'b', 'moneyline', 'home'), null);
  assert.ok(nc.isFootball('americanfootball_nfl'));
  assert.ok(nc.isFootball('americanfootball_nfl_preseason'));
});
