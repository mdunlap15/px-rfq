// Regression: book comparisons must use the SAME PRODUCT we quote.
//
// PX soccer moneyline is 2-way DRAW-NO-BET; books post 3-way, where the draw
// holds ~25-30% of the probability mass. Comparing our DNB quote to a raw 3-way
// home price is a product mismatch, not a price difference. Measured
// 2026-08-03: median parlay gap for soccer/moneyline read +9.98pp against
// -0.46..+2.63pp for every other market family; using the stored
// pinnacleDNBProb collapses it to +1.61pp.
//
// Two shipped consequences this pins:
//  1. The "dramatic undercut" sanity guard built bookCompound from raw 3-way
//     prices. Those imply a LOWER prob than DNB, so bookCompound came out too
//     small, `ratio = offered / bookCompound` too large, and the guard could
//     not fire — failing OPEN on the product we price thinnest.
//  2. isDNB alone is not a sufficient test: PX frequently names a DNB market
//     plainly "Moneyline" and the flag stays false.
//
// Run: npm test   (or: node --test test/dnb-book-comparator.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const pricer = require('../services/pricer');

const impl = pricer.__bookImpliedForLeg;

const leg = (over) => Object.assign({
  pinnacleOdds: -110,          // 3-way home price, ~52.4%
  pinnacleDNBProb: 0.66,       // renormalised DNB prob for the same side
  lineInfo: { sport: 'soccer_epl', marketType: 'moneyline', isDNB: false },
}, over);

test('soccer h2h uses the DNB prob even when isDNB is FALSE', () => {
  // The core defect: PX names many DNB markets plainly "Moneyline".
  const v = impl(leg(), 'pinnacleOdds', 'pinnacleDNBProb');
  assert.equal(v, 0.66, 'must use the DNB prob, not the 3-way price');
});

test('soccer h2h with isDNB true also uses the DNB prob', () => {
  const v = impl(leg({ lineInfo: { sport: 'soccer', marketType: 'moneyline', isDNB: true } }),
    'pinnacleOdds', 'pinnacleDNBProb');
  assert.equal(v, 0.66);
});

test('every soccer league prefix is covered, not just "soccer"', () => {
  for (const sport of ['soccer', 'soccer_epl', 'soccer_usa_mls', 'soccer_brazil_campeonato',
    'soccer_uefa_champs_league', 'soccer_fifa_world_cup']) {
    const v = impl(leg({ lineInfo: { sport, marketType: 'moneyline', isDNB: false } }),
      'pinnacleOdds', 'pinnacleDNBProb');
    assert.equal(v, 0.66, sport + ' must resolve to the DNB prob');
  }
});

test('oddsApiMarket h2h also counts as the moneyline product', () => {
  const v = impl(leg({ lineInfo: { sport: 'soccer', oddsApiMarket: 'h2h', isDNB: false } }),
    'pinnacleOdds', 'pinnacleDNBProb');
  assert.equal(v, 0.66);
});

test('soccer TOTALS and SPREADS are NOT draw-no-bet — raw price stands', () => {
  for (const marketType of ['total', 'spread']) {
    const v = impl(leg({ lineInfo: { sport: 'soccer_epl', marketType, isDNB: false } }),
      'pinnacleOdds', 'pinnacleDNBProb');
    assert.ok(Math.abs(v - 0.5238) < 0.001, marketType + ' must use the raw price');
  }
});

test('non-soccer moneyline is unaffected', () => {
  const v = impl(leg({ lineInfo: { sport: 'baseball_mlb', marketType: 'moneyline', isDNB: false } }),
    'pinnacleOdds', 'pinnacleDNBProb');
  assert.ok(Math.abs(v - 0.5238) < 0.001, 'MLB must use the raw price');
});

test('falls back to the raw price when no DNB prob was stored', () => {
  const v = impl(leg({ pinnacleDNBProb: null }), 'pinnacleOdds', 'pinnacleDNBProb');
  assert.ok(Math.abs(v - 0.5238) < 0.001, 'no DNB prob available -> raw, never null');
});

test('null odds and null leg do not throw', () => {
  assert.equal(impl(leg({ pinnacleOdds: null, pinnacleDNBProb: null }), 'pinnacleOdds', 'pinnacleDNBProb'), null);
  assert.equal(impl(null, 'pinnacleOdds', 'pinnacleDNBProb'), null);
});

test('works for FanDuel and DraftKings fields too', () => {
  const l = leg({ fanduelOdds: -105, fanduelDNBProb: 0.63, draftkingsOdds: 120, draftkingsDNBProb: 0.61 });
  assert.equal(impl(l, 'fanduelOdds', 'fanduelDNBProb'), 0.63);
  assert.equal(impl(l, 'draftkingsOdds', 'draftkingsDNBProb'), 0.61);
});

test('THE BUG: 3-way understates the DNB prob, which disabled the undercut guard', () => {
  // A 3-way home price always implies LESS probability than the DNB
  // equivalent, because the draw carries mass the DNB market removes.
  const threeWay = impl(leg({ lineInfo: { sport: 'baseball_mlb', marketType: 'moneyline' } }),
    'pinnacleOdds', 'pinnacleDNBProb');            // raw path
  const dnb = impl(leg(), 'pinnacleOdds', 'pinnacleDNBProb');  // soccer path
  assert.ok(dnb > threeWay, 'DNB prob must exceed the raw 3-way implied');
  // bookCompound is a PRODUCT of these, so on a 2-leg soccer parlay the raw
  // version is (0.5238/0.66)^2 = ~63% of the correct value — enough to keep
  // `ratio` above the 0.60 sanity floor and silence the guard.
  const ratioDistortion = Math.pow(threeWay / dnb, 2);
  assert.ok(ratioDistortion < 0.7, 'raw compound is materially too small: ' + ratioDistortion.toFixed(3));
});
