// Leg-level price calibration, and the guard that keeps partially-graded rows
// out of the correlation table.
//
// Relaxing the settlement gate to admit prop+moneyline tickets means a row can
// now carry ungraded legs. /prop-correlation counts `if (r.parlay_won) b.win++`,
// so a null parlay_won reads as a LOSS — admitting partial rows without a guard
// would have silently biased every correlation factor downward.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../services/db');
const ps = require('../services/prop-settlement');

// Minimal chainable stand-in for the supabase client: every filter returns
// `this`, `.range()` resolves the page, and the builder is thenable so the
// `.in()` lookup can be awaited directly.
function fakeClient(tables) {
  return {
    from(name) {
      const rows = tables[name] || [];
      const b = {
        select() { return b; },
        eq() { return b; },
        gte() { return b; },
        in() { return b; },
        order() { return b; },
        limit() { return b; },
        range(from, to) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return b;
    },
  };
}
function withDb(tables, fn) {
  const orig = db.getClient;
  db.getClient = () => fakeClient(tables);
  return Promise.resolve(fn()).finally(() => { db.getClient = orig; });
}

const legRes = (propType, line, player, won, side) =>
  ({ propType, line, player, won, side: side || 'over', sideKnown: true, graded: won != null, stat: 1 });

test('a partial row is excluded from correlation combos and marginal rates', async () => {
  const settlements = [
    // Two fully graded same-game rows: one win, one loss -> 50% realized.
    { parlay_id: 'a', combo: 'SAME-G/OPP-TM | hitter_hr+hitter_hr', same_game: true, leg_count: 2,
      prop_types: ['hitter_hr', 'hitter_hr'], matched_odds: 300, matched_stake: 10, parlay_won: true,
      leg_results: [legRes('hitter_hr', 0.5, 'A', true), legRes('hitter_hr', 0.5, 'B', true)] },
    { parlay_id: 'b', combo: 'SAME-G/OPP-TM | hitter_hr+hitter_hr', same_game: true, leg_count: 2,
      prop_types: ['hitter_hr', 'hitter_hr'], matched_odds: 300, matched_stake: 10, parlay_won: false,
      leg_results: [legRes('hitter_hr', 0.5, 'C', true), legRes('hitter_hr', 0.5, 'D', false)] },
    // A PARTIAL row on the same combo key shape. parlay_won is null because a
    // moneyline leg could not be graded. It must not count as a loss.
    { parlay_id: 'c', combo: 'PARTIAL/SAME-G/OPP-TM | hitter_hr', same_game: true, leg_count: 2,
      prop_types: ['hitter_hr'], matched_odds: 300, matched_stake: 10, parlay_won: null,
      leg_results: [legRes('hitter_hr', 0.5, 'E', true), { propType: 'moneyline', won: null, graded: false }] },
  ];
  await withDb({ prop_settlements: settlements }, async () => {
    const out = await ps.getCalibration({ days: 60, minN: 1 });
    assert.ok(out.ok);
    const combos = Object.fromEntries(out.combos.map((c) => [c.combo, c]));
    assert.ok(!Object.keys(combos).some((k) => k.startsWith('PARTIAL/')), 'partial rows must not form combos');
    const g = combos['SAME-G/OPP-TM | hitter_hr+hitter_hr'];
    assert.strictEqual(g.n, 2, 'the partial row must not inflate n');
    assert.strictEqual(g.realizedWinPct, 50);
    // Marginal rate: only the 4 legs on fully graded rows (3 wins) count.
    assert.strictEqual(out.marginalRates.hitter_hr, 75);
    assert.strictEqual(out.marginalRates.moneyline, undefined);
  });
});

test('calibration compares our fair to realized, per family and side', async () => {
  // 100 HR overs priced at exactly 30%, of which 30 hit -> perfectly calibrated.
  const settlements = [], orders = [];
  for (let i = 0; i < 100; i++) {
    const won = i < 30;
    settlements.push({ parlay_id: 'p' + i, matched_at: new Date().toISOString(), we_quoted: true,
      sport: 'baseball_mlb', leg_results: [legRes('hitter_hr', 0.5, 'Player ' + i, won)] });
    orders.push({ parlay_id: 'p' + i,
      legs: [{ market: 'player_hitter_hr', team: 'Player ' + i, line: 0.5, fairProb: 0.30 }] });
  }
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 10 });
    assert.ok(out.ok);
    assert.strictEqual(out.legsScored, 100);
    const f = out.families.find((x) => x.family === 'hitter_hr.over');
    assert.strictEqual(f.legs, 100);
    assert.strictEqual(f.meanFairPct, 30);
    assert.strictEqual(f.realizedPct, 30);
    assert.strictEqual(f.diffPp, 0);
    assert.strictEqual(f.z, 0);
  });
});

test('a real underprice surfaces as a positive signed gap with a large z', async () => {
  // Priced at 30%, actually hit 45% -> we sold the side 15pp too cheap.
  const settlements = [], orders = [];
  for (let i = 0; i < 200; i++) {
    const won = i < 90;
    settlements.push({ parlay_id: 'q' + i, matched_at: new Date().toISOString(), we_quoted: true,
      sport: 'baseball_mlb', leg_results: [legRes('pitcher_strikeouts', 4.5, 'Pitcher ' + i, won)] });
    orders.push({ parlay_id: 'q' + i,
      legs: [{ market: 'player_strikeouts', team: 'Pitcher ' + i, line: 4.5, fairProb: 0.30 }] });
  }
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 10 });
    const f = out.families.find((x) => x.family === 'pitcher_strikeouts.over');
    assert.strictEqual(f.legs, 200);
    assert.strictEqual(f.diffPp, 15);
    assert.ok(f.z > 4, `expected a decisive z, got ${f.z}`);
  });
});

test('ungraded legs and guessed sides are excluded from scoring', async () => {
  const settlements = [{ parlay_id: 'r1', matched_at: new Date().toISOString(), we_quoted: true,
    sport: 'baseball_mlb', leg_results: [
      legRes('hitter_hr', 0.5, 'Kept', true),
      { propType: 'moneyline', won: null, graded: false },                       // ungraded
      { propType: 'hitter_hits', line: 0.5, player: 'Guessed', won: true, sideKnown: false, side: 'over' },
    ] }];
  const orders = [{ parlay_id: 'r1', legs: [
    { market: 'player_hitter_hr', team: 'Kept', line: 0.5, fairProb: 0.3 },
    { market: 'moneyline', team: 'X', line: null, fairProb: 0.5 },
    { market: 'player_hitter_hits', team: 'Guessed', line: 0.5, fairProb: 0.6 },
  ] }];
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 1 });
    assert.strictEqual(out.legsScored, 1, 'only the graded, side-known prop leg counts');
    assert.strictEqual(out.families.length, 1);
    assert.strictEqual(out.families[0].family, 'hitter_hr.over');
  });
});

test('a leg whose fair cannot be joined is reported, not silently dropped', async () => {
  const settlements = [{ parlay_id: 's1', matched_at: new Date().toISOString(), we_quoted: true,
    sport: 'baseball_mlb', leg_results: [legRes('hitter_hr', 0.5, 'Nobody', true)] }];
  const orders = [{ parlay_id: 's1', legs: [{ market: 'player_hitter_hr', team: 'Someone Else', line: 0.5, fairProb: 0.3 }] }];
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 1 });
    assert.strictEqual(out.legsScored, 0);
    assert.strictEqual(out.legsUnmatched, 1, 'an unjoinable leg must be counted, so coverage is visible');
  });
});

test('over and under are scored as separate families', async () => {
  // They are different prices with different errors; pooling them would let an
  // over underprice cancel an under overprice.
  const settlements = [], orders = [];
  for (let i = 0; i < 60; i++) {
    const side = i % 2 ? 'under' : 'over';
    settlements.push({ parlay_id: 't' + i, matched_at: new Date().toISOString(), we_quoted: true,
      sport: 'baseball_mlb', leg_results: [legRes('pitcher_strikeouts', 5.5, 'P' + i, i < 30, side)] });
    orders.push({ parlay_id: 't' + i,
      legs: [{ market: 'player_strikeouts', team: 'P' + i, line: 5.5, fairProb: 0.5 }] });
  }
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 5 });
    const keys = out.families.map((f) => f.family).sort();
    assert.deepStrictEqual(keys, ['pitcher_strikeouts.over', 'pitcher_strikeouts.under']);
  });
});

test('a guessed side is recovered from our own order, and the outcome re-derived', async () => {
  // Most matched_parlays rows predate the selection fix, so the settler assumed
  // OVER and flagged sideKnown:false. `won` on those rows is computed against the
  // guess, so an actual UNDER is recorded inverted. We hold the order we wrote,
  // and our selection is authoritative — so take the side from there and
  // re-derive the result from stat vs line.
  const settlements = [{ parlay_id: 'u1', matched_at: new Date().toISOString(), we_quoted: true,
    sport: 'baseball_mlb', leg_results: [
      // Pitcher threw 3 Ks on a 4.5 line. Recorded as over/won:false (the guess).
      { propType: 'pitcher_strikeouts', line: 4.5, player: 'Under Guy', stat: 3,
        side: 'over', sideKnown: false, won: false, graded: true },
      // Threw 9 on 4.5. Guess happens to be right.
      { propType: 'pitcher_strikeouts', line: 4.5, player: 'Over Guy', stat: 9,
        side: 'over', sideKnown: false, won: true, graded: true },
    ] }];
  const orders = [{ parlay_id: 'u1', legs: [
    { market: 'player_strikeouts', team: 'Under Guy', line: 4.5, selection: 'under', fairProb: 0.5 },
    { market: 'player_strikeouts', team: 'Over Guy', line: 4.5, selection: 'over', fairProb: 0.5 },
  ] }];
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 1 });
    assert.strictEqual(out.legsScored, 2);
    assert.strictEqual(out.sidesRecoveredFromOrder, 2);
    const under = out.families.find((f) => f.family === 'pitcher_strikeouts.under');
    const over = out.families.find((f) => f.family === 'pitcher_strikeouts.over');
    assert.ok(under, 'the under leg must be re-filed under its true side');
    // 3 Ks vs a 4.5 line: the under WON, though the row said won:false.
    assert.strictEqual(under.realizedPct, 100, 'outcome must be re-derived, not trusted');
    assert.strictEqual(over.realizedPct, 100);
  });
});

test('a leg with no recorded side anywhere is still dropped, and counted', async () => {
  const settlements = [{ parlay_id: 'v1', matched_at: new Date().toISOString(), we_quoted: true,
    sport: 'baseball_mlb', leg_results: [
      { propType: 'pitcher_strikeouts', line: 4.5, player: 'Nobody Knows', stat: 6,
        side: 'over', sideKnown: false, won: true, graded: true }] }];
  const orders = [{ parlay_id: 'v1',
    legs: [{ market: 'player_strikeouts', team: 'Nobody Knows', line: 4.5, fairProb: 0.5 }] }]; // no selection
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 1 });
    assert.strictEqual(out.legsScored, 0);
    assert.strictEqual(out.legsDroppedUnknownSide, 1);
  });
});

test('recovery respects a push on an integer line', async () => {
  const settlements = [{ parlay_id: 'w1', matched_at: new Date().toISOString(), we_quoted: true,
    sport: 'baseball_mlb', leg_results: [
      { propType: 'pitcher_strikeouts', line: 6, player: 'Push Guy', stat: 6,
        side: 'over', sideKnown: false, won: true, graded: true }] }];
  const orders = [{ parlay_id: 'w1',
    legs: [{ market: 'player_strikeouts', team: 'Push Guy', line: 6, selection: 'under', fairProb: 0.5 }] }];
  await withDb({ prop_settlements: settlements, parlay_orders: orders }, async () => {
    const out = await ps.getLegCalibration({ days: 60, minN: 1 });
    const f = out.families.find((x) => x.family === 'pitcher_strikeouts.under');
    assert.strictEqual(f.realizedPct, 0, 'exactly on an integer line is a push, not an under win');
  });
});
