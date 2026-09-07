// Football same-game side+total: measured correlation factors, and the narrow
// release of the football_sgp_blocked guard that lets them quote.
//
// The factors are MEASURED (services/football-sgp-correlation.js carries the
// tables, sample sizes and CIs): 7,245 NFL games 1999-2025 and 7,676 CFB games
// 2006-2025, closing consensus spread+total vs final score.
//
// Two things must hold and neither is obvious from reading the pricer:
//
//   1. CFB spread+total is NOT one number. Aggregate M = 1.067, but that is an
//      artefact — under 14.5 the CI contains 1.000 and at 14.5+ it is 1.169
//      [1.131, 1.209]. A single aggregate would simultaneously overprice 68% of
//      CFB games and underprice the 32% that matter. The spread-size split is
//      therefore load-bearing, not a refinement.
//
//   2. Flipping FOOTBALL_SGP_ENABLED must release ONLY the measured shape.
//      Everything else same-game football — player props above all — has no
//      calibration behind it, and the guard is the only thing standing between
//      the flag and a guessed factor. The block's own comment warns that
//      relying on the generic SGP combo gate is incidental protection that
//      evaporates when someone adds a combo key (the MoV/tennis lesson), so
//      these assert the explicit guard with combos FORCE-ALLOWED.
//
// Run: node --test test/football-sgp-correlation.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const fbCorr = require('../services/football-sgp-correlation');
const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

const F = fbCorr.footballSgpFactor;
const NFL = 'americanfootball_nfl';
const CFB = 'americanfootball_ncaaf';

// ---------------------------------------------------------------- the table

test('NFL side+total is measured INDEPENDENT at every spread', () => {
  // Every NFL CI contains 1.000 across 27 seasons. A factor > 1 here would be
  // an invented discount, which is what the block existed to prevent.
  for (const spread of [-1.5, -3, -7, -10, -14, -21, 3, 7]) {
    assert.strictEqual(F({ sport: NFL, combo: 'spread_total', spreadLine: spread }).factor, 1,
      `NFL spread ${spread} must price independent`);
  }
  assert.strictEqual(F({ sport: NFL, combo: 'ml_total' }).factor, 1);
});

test('CFB spread+total is 1.00 below 14.5 and 1.17 at or above it', () => {
  for (const spread of [-1.5, -3, -7, -10, -14, 13.5]) {
    assert.strictEqual(F({ sport: CFB, combo: 'spread_total', spreadLine: spread }).factor, 1,
      `CFB spread ${spread} is in a bucket whose CI contains 1.000`);
  }
  for (const spread of [-14.5, -17, -21, -35, 24.5]) {
    assert.strictEqual(F({ sport: CFB, combo: 'spread_total', spreadLine: spread }).factor, 1.17,
      `CFB spread ${spread} is the measured 1.169 blowout bucket`);
  }
});

test('the bucket boundary is inclusive at 14.5', () => {
  assert.strictEqual(F({ sport: CFB, combo: 'spread_total', spreadLine: -14 }).factor, 1);
  assert.strictEqual(F({ sport: CFB, combo: 'spread_total', spreadLine: -14.5 }).factor, 1.17);
});

test('CFB ml_total carries only the small measured uplift', () => {
  // 1.015 [1.002, 1.028] — a huge favourite winning outright carries almost no
  // information (P = 93.8% at 14.5+), so this must NOT inherit the 1.17.
  assert.strictEqual(F({ sport: CFB, combo: 'ml_total' }).factor, 1.02);
});

test('an unreadable spread falls back to the WIDEST bucket, not the narrowest', () => {
  // Failing toward 1.00 would underprice exactly the bucket that matters.
  for (const bad of [undefined, null, NaN, 0, 'x']) {
    assert.strictEqual(F({ sport: CFB, combo: 'spread_total', spreadLine: bad }).factor, 1.17,
      `spread ${String(bad)} must fail toward the expensive side`);
  }
});

test('uncalibrated leagues and combos return null, not 1', () => {
  // null lets the caller distinguish "measured as independent" from "never
  // measured" — the CFL has no measurement behind it and must stay blocked.
  assert.strictEqual(F({ sport: 'americanfootball_cfl', combo: 'spread_total', spreadLine: -7 }), null);
  assert.strictEqual(F({ sport: 'baseball_mlb', combo: 'spread_total', spreadLine: -1.5 }), null);
  assert.strictEqual(F({ sport: CFB, combo: 'ml_spread', spreadLine: -3 }), null);
  assert.strictEqual(F({ sport: '', combo: 'spread_total' }), null);
  assert.strictEqual(F({}), null);
});

test('factors are clamped at >= 1.00 even when an override goes below', () => {
  // The negative directions are real (CFB fav+under measured 0.934) but
  // honouring them would make our quote CHEAPER than independent.
  const prev = process.env.FOOTBALL_SGP_CORRELATION;
  process.env.FOOTBALL_SGP_CORRELATION = JSON.stringify({ ncaaf: { ml_total: 0.85 } });
  fbCorr._resetForTest();
  try {
    assert.strictEqual(F({ sport: CFB, combo: 'ml_total' }).factor, 1);
  } finally {
    if (prev === undefined) delete process.env.FOOTBALL_SGP_CORRELATION;
    else process.env.FOOTBALL_SGP_CORRELATION = prev;
    fbCorr._resetForTest();
  }
});

test('a malformed override falls back to the measurement instead of throwing', () => {
  const prev = process.env.FOOTBALL_SGP_CORRELATION;
  process.env.FOOTBALL_SGP_CORRELATION = '{not json';
  fbCorr._resetForTest();
  try {
    assert.strictEqual(F({ sport: CFB, combo: 'spread_total', spreadLine: -21 }).factor, 1.17);
  } finally {
    if (prev === undefined) delete process.env.FOOTBALL_SGP_CORRELATION;
    else process.env.FOOTBALL_SGP_CORRELATION = prev;
    fbCorr._resetForTest();
  }
});

// ------------------------------------------------- what the flag releases

const P = pricer.__footballSideTotalPair;
const leg = (o) => ({ sport: CFB, pxEventId: 700, ...o });

test('the released shape is exactly one side leg + one game total', () => {
  assert.ok(P([leg({ marketType: 'spread', line: -21 }), leg({ marketType: 'total', selection: 'over' })]));
  assert.ok(P([leg({ marketType: 'moneyline' }), leg({ marketType: 'total', selection: 'under' })]));
  assert.ok(P([leg({ sport: NFL, marketType: 'spread', line: -7 }), leg({ sport: NFL, marketType: 'total' })]));
});

test('the combo and spread bucket survive leg ORDER', () => {
  const a = P([leg({ marketType: 'total' }), leg({ marketType: 'spread', line: -21 })]);
  const b = P([leg({ marketType: 'spread', line: -21 }), leg({ marketType: 'total' })]);
  assert.strictEqual(a.combo, 'spread_total');
  assert.strictEqual(a.factor, 1.17);
  assert.deepStrictEqual(a.factor, b.factor);
});

test('every UNMEASURED same-game football shape is refused', () => {
  const cases = {
    'player prop + spread': [leg({ marketType: 'player_pass_yds', playerName: 'QB' }), leg({ marketType: 'spread', line: -7 })],
    'two player props': [leg({ marketType: 'player_pass_yds' }), leg({ marketType: 'player_rec_yds' })],
    'side + side': [leg({ marketType: 'spread', line: -7 }), leg({ marketType: 'moneyline' })],
    'two totals (alt lines)': [leg({ marketType: 'total', line: 51.5 }), leg({ marketType: 'total', line: 55.5 })],
    'team total + spread': [leg({ marketType: 'team_total' }), leg({ marketType: 'spread', line: -7 })],
    'three legs': [leg({ marketType: 'spread', line: -7 }), leg({ marketType: 'total' }), leg({ marketType: 'moneyline' })],
    'one leg': [leg({ marketType: 'spread', line: -7 })],
    'CFL': [leg({ sport: 'americanfootball_cfl', marketType: 'spread', line: -7 }), leg({ sport: 'americanfootball_cfl', marketType: 'total' })],
    'first-half total': [leg({ marketType: 'spread', line: -7 }), leg({ marketType: 'first_half_total', marketName: 'First Half Total Points' })],
    'period leg typed as full game': [leg({ marketType: 'spread', line: -7 }), leg({ marketType: 'total', marketName: 'Second Half Total Points' })],
    'non-football': [leg({ sport: 'baseball_mlb', marketType: 'spread', line: -1.5 }), leg({ sport: 'baseball_mlb', marketType: 'total' })],
    // PX types markets misleadingly — BTTS arrives as 'moneyline', "Second Half
    // Total Points" as plain 'total'. A prop wearing a game-market type must
    // still be refused, so the guard keys on playerName as well as marketType.
    'prop disguised as the game total': [leg({ marketType: 'spread', line: -7 }), leg({ marketType: 'total', playerName: 'Ty Simpson', line: 250.5 })],
    'prop disguised as the side': [leg({ marketType: 'moneyline', playerName: 'Ty Simpson' }), leg({ marketType: 'total' })],
  };
  for (const [label, ls] of Object.entries(cases)) {
    assert.strictEqual(P(ls), null, `${label} has no calibrated factor and must stay blocked`);
  }
});

// ------------------------------------------- the guard, end to end via PX legs

const GAME = 810;
const FUTURE = new Date(Date.now() + 72 * 3600e3).toISOString();
const LINES = {
  'cfb-spread': { sport: CFB, pxEventId: GAME, marketType: 'spread', selection: 'home', line: -21, teamName: 'Alabama', homeTeam: 'Alabama', awayTeam: 'Western Kentucky', marketName: 'Spread' },
  'cfb-total': { sport: CFB, pxEventId: GAME, marketType: 'total', selection: 'over', line: 60.5, homeTeam: 'Alabama', awayTeam: 'Western Kentucky', marketName: 'Total Points' },
  'cfb-prop': { sport: CFB, pxEventId: GAME, marketType: 'player_pass_yds', selection: 'over', line: 250.5, playerName: 'Ty Simpson', homeTeam: 'Alabama', awayTeam: 'Western Kentucky', marketName: 'Passing Yards' },
};
for (const li of Object.values(LINES)) {
  li.startTime = FUTURE; li.startTimeMs = Date.parse(FUTURE);
  li.oddsApiSport = li.sport; li.oddsApiMarket = li.marketType; li.oddsApiSelection = li.selection;
}
const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });

const declineOf = (...ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);

function withFlag(enabled, fn) {
  const prevFlag = config.pricing.footballSgpEnabled;
  const prevCombos = config.pricing.sgpAllowedCombos;
  config.pricing.footballSgpEnabled = enabled;
  // FORCE-ALLOW the combos so these assert the explicit football guard rather
  // than the incidental protection of the combo allowlist.
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  try { return fn(); } finally {
    config.pricing.footballSgpEnabled = prevFlag;
    config.pricing.sgpAllowedCombos = prevCombos;
  }
}

test('with the flag OFF, a CFB side+total pair is football_sgp_blocked', () => {
  const d = withFlag(false, () => declineOf('cfb-spread', 'cfb-total'));
  assert.strictEqual(d.declined, true);
  assert.strictEqual(d.reason, 'football_sgp_blocked');
});

test('with the flag ON, that pair is no longer football-blocked', () => {
  const d = withFlag(true, () => declineOf('cfb-spread', 'cfb-total'));
  assert.notStrictEqual(d && d.reason, 'football_sgp_blocked');
});

test('with the flag ON, a prop pairing is STILL football_sgp_blocked', () => {
  // The flag must not become a blanket football-SGP switch: prop game-script
  // coupling is an order of magnitude larger than side+total and uncalibrated.
  for (const other of ['cfb-spread', 'cfb-total']) {
    const d = withFlag(true, () => declineOf('cfb-prop', other));
    assert.strictEqual(d.declined, true, `prop + ${other} must decline`);
    assert.strictEqual(d.reason, 'football_sgp_blocked');
    assert.match(d.detail, /no calibrated correlation factor/);
  }
});

test('with the flag ON, a 3-leg same-game stack is STILL blocked', () => {
  const d = withFlag(true, () => declineOf('cfb-spread', 'cfb-total', 'cfb-prop'));
  assert.strictEqual(d.declined, true);
  assert.strictEqual(d.reason, 'football_sgp_blocked');
});
