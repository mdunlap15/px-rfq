// TOA tennis SET markets — mapping, sign conventions, and the best-of-5 guard.
//
// Findings these tests encode (measured over 60 live events, 2026-08-04):
//  - h2h_s1 outcomes are exact PLAYER-NAME strings, never Home/Away.
//  - alternate_set_totals is NOT a ladder: point is 2.5 on 100% of rows.
//  - alternate_set_spreads carries ONLY +/-1.5, and every row has BOTH signs.
//    An |point|==1.5 selector therefore misfires on 100% of rows, handing back
//    the minus side ("wins 2-0") for whichever player sits there.
//  - Each book posts only ONE spread direction, so one book prices only ONE
//    player's at-least-one-set.
//  - Bo5 is the dangerous hole: "+1.5" there means "wins >=2 sets", so the Bo3
//    mapping would quote PX's YES TOO CHEAP on a MORE likely leg.
//
// Run: npm test   (or: node --test test/toa-tennis-sets.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const toa = require('../services/toa-tennis-sets');

const BO3 = 'tennis_atp_canadian_open';

// A realistic single-book payload: one spread DIRECTION only, both signs in it.
function odds(over = {}) {
  const markets = [];
  if (over.h2hS1 !== false) {
    markets.push({ key: 'h2h_s1', outcomes: [
      { name: 'Stefanos Tsitsipas', price: -155 },
      { name: 'Martin Damm Jr.', price: 110 },
    ] });
  }
  if (over.setTotal !== false) {
    markets.push({ key: 'alternate_set_totals', outcomes: [
      { name: 'Over', price: 123, point: 2.5 },
      { name: 'Under', price: -157, point: 2.5 },
    ] });
  }
  if (over.setSpread !== false) {
    markets.push({ key: 'alternate_set_spreads', outcomes: over.spreadOutcomes || [
      { name: 'Stefanos Tsitsipas', price: -525, point: 1.5 },   // Tsitsipas >=1 set
      { name: 'Martin Damm Jr.', price: 300, point: -1.5 },      // Damm wins 2-0
    ] });
  }
  return {
    home_team: 'Stefanos Tsitsipas',
    away_team: 'Martin Damm Jr.',
    // TWO books quoting identical prices: tennisSetsMinBooks default rose to 2
    // (2026-08-06 source-breadth audit), and identical duplicates keep every
    // exact de-vig assertion below unchanged (mean of two equal fairs).
    bookmakers: [
      { key: 'betmgm', markets },
      { key: 'betrivers', markets: JSON.parse(JSON.stringify(markets)) },
    ],
  };
}

test('a SINGLE-book board fails closed at the 2-book default gate', () => {
  const single = odds();
  single.bookmakers = single.bookmakers.slice(0, 1);
  const s = toa.buildSets(single, BO3);
  const priced = s && (s.firstSetMl || s.totalSets || (s.atLeastOneSet && (s.atLeastOneSet.home || s.atLeastOneSet.away)));
  assert.ok(!priced, 'one book must not price any set market (was the pre-audit behavior)');
});

test('1st set moneyline maps from PLAYER-NAME outcomes', () => {
  const s = toa.buildSets(odds(), BO3);
  assert.ok(s.firstSetMl, 'must price');
  // -155 vs +110 -> Tsitsipas (home) is the favourite
  assert.ok(s.firstSetMl.home.fairProb > s.firstSetMl.away.fairProb);
  assert.ok(Math.abs(s.firstSetMl.home.fairProb + s.firstSetMl.away.fairProb - 1) < 1e-12);
});

test('total sets only accepts a 2.5 point', () => {
  const s = toa.buildSets(odds(), BO3);
  assert.equal(s.totalSets.line, 2.5);
  const wrong = odds({ spreadOutcomes: null });
  wrong.bookmakers[0].markets.find(m => m.key === 'alternate_set_totals')
    .outcomes.forEach(o => { o.point = 3.5; });
  const s2 = toa.buildSets(wrong, BO3);
  assert.equal(s2.totalSets, null, 'a 3.5 set total must not be read as PX 2.5');
});

test('at-least-one-set uses the players OWN +1.5, not the minus side', () => {
  const s = toa.buildSets(odds(), BO3);
  assert.ok(s.atLeastOneSet.home, 'Tsitsipas (+1.5 present) must price');
  // -525 / +300 de-vigged -> Tsitsipas ~77%, and it must NOT be the -1.5 side
  assert.ok(s.atLeastOneSet.home.fairProb > 0.7 && s.atLeastOneSet.home.fairProb < 0.85,
    'got ' + s.atLeastOneSet.home.fairProb);
});

test('THE 100% TRAP: a book posting only one direction prices only ONE player', () => {
  // The payload has Tsitsipas +1.5 and Damm -1.5. Damm's at-least-one-set needs
  // the OTHER pair (Damm +1.5 / Tsitsipas -1.5), which this book does not post.
  const s = toa.buildSets(odds(), BO3);
  assert.ok(s.atLeastOneSet.home, 'Tsitsipas priced');
  assert.equal(s.atLeastOneSet.away, undefined,
    'Damm must NOT be priced off his -1.5 — that is "wins 2-0", a different event');
});

test('both directions present prices both players', () => {
  const s = toa.buildSets(odds({ spreadOutcomes: [
    { name: 'Stefanos Tsitsipas', price: -525, point: 1.5 },
    { name: 'Martin Damm Jr.', price: 300, point: -1.5 },
    { name: 'Martin Damm Jr.', price: -180, point: 1.5 },
    { name: 'Stefanos Tsitsipas', price: 145, point: -1.5 },
  ] }), BO3);
  assert.ok(s.atLeastOneSet.home && s.atLeastOneSet.away, 'both sides priced');
  assert.ok(s.atLeastOneSet.home.fairProb > s.atLeastOneSet.away.fairProb,
    'the match favourite is likelier to win a set');
});

// ---------------------------------------------------------------------------
// BEST-OF-5 — the dangerous direction
// ---------------------------------------------------------------------------
test('ATP Slam keys are refused outright', () => {
  for (const k of ['tennis_atp_us_open', 'tennis_atp_wimbledon',
                   'tennis_atp_french_open', 'tennis_atp_aus_open_singles']) {
    const s = toa.buildSets(odds(), k);
    assert.equal(s._rejected, 'best-of-5', k + ' must fail closed');
  }
});

test('WTA Slam keys are NOT refused — women play best-of-3', () => {
  const s = toa.buildSets(odds(), 'tennis_wta_us_open');
  assert.notEqual(s && s._rejected, 'best-of-5');
  assert.ok(s.atLeastOneSet, 'and still prices normally');
});

test('at-least-one-set requires a posted 2.5 total as Bo3 PROOF', () => {
  // The 11-of-60 population with no set total is 100% ATP — exactly where a
  // Slam would turn Bo5 — so absence of the total blocks the mapping.
  const s = toa.buildSets(odds({ setTotal: false }), BO3);
  assert.equal(s.atLeastOneSet, null,
    'no set total => no proof of best-of-3 => must not price at-least-one-set');
  assert.ok(s.firstSetMl, 'but 1st-set ML is format-independent and still prices');
});

test('helpers: signed-point selection and de-vig are sane', () => {
  assert.ok(Math.abs(toa.__amerToProb(100) - 0.5) < 1e-9);
  assert.ok(Math.abs(toa.__amerToProb(-200) - 2 / 3) < 1e-6);
  const d = toa.__devig2(0.6, 0.6);
  assert.ok(Math.abs(d.a - 0.5) < 1e-12);
  assert.equal(toa.__devig2(0, 0.5), null);
});

test('surname matching tolerates suffixes and accents', () => {
  assert.equal(toa.__surname('Martin Damm Jr.'), 'damm');
  assert.equal(toa.__surname('Stefanos Tsitsipas'), 'tsitsipas');
  assert.equal(toa.__surname('Marin Čilić'), 'cilic');
});

test('a malformed payload never throws', () => {
  assert.equal(toa.buildSets(null, BO3), null);
  assert.equal(toa.buildSets({}, BO3), null);
  assert.equal(toa.buildSets({ home_team: 'A', away_team: 'A', bookmakers: [] }, BO3), null);
});
