// Regression tests: method-of-victory legs must NEVER be parlayed same-fight.
//
// Operator directive (2026-07-17): "Do not allow parlaying of SGPs with method
// of victory lines."
//
// Why this needs a dedicated test rather than trusting the generic SGP gate:
// that gate declines these today only because no key in SGP_ALLOWED_COMBOS
// happens to match a MoV pair. That is an INCIDENTAL protection — the moment
// someone adds a combo key it evaporates, and the failure is silent AND
// expensive. Every same-fight method pair is either mutually exclusive (Usman
// by KO + Usman by SUB cannot both happen; only ONE fighter wins at all) or
// nested (ko ⊂ itd, mov ⊂ moneyline). Independent multiplication would price a
// P=0 parlay as if it were live.
//
// The adversarial cases below force MoV combos INTO SGP_ALLOWED_COMBOS and
// assert the explicit guard still declines — i.e. the block does not depend on
// the combo list at all.
//
// Legs are passed RAW ({line_id}) exactly as PX sends them, because the guard
// resolving raw legs is the whole point: the golf nesting guard silently never
// fired in production for weeks by reading a pre-resolved shape that only
// existed in tests.
//
// Run: npm test   (or: node --test test/mov-sgp-block.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

// --- Fake line index -------------------------------------------------------
// Two fights. Fight 1 (event 900) = Usman vs Du Plessis; fight 2 (event 901) =
// Cannonier vs Duncan. Registered through lineManager's real lookupLine by
// stubbing the index, so the guard exercises the production resolution path.
const FIGHT1 = 900, FIGHT2 = 901;
const LINES = {
  'u-ko':  { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'mov_ko',  selection: 'yes', playerName: 'Kamaru Usman', teamName: 'Kamaru Usman', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'u-sub': { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'mov_sub', selection: 'yes', playerName: 'Kamaru Usman', teamName: 'Kamaru Usman', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'u-itd': { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'mov_itd', selection: 'yes', playerName: 'Kamaru Usman', teamName: 'Kamaru Usman', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'u-dec-no': { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'mov_dec', selection: 'no', playerName: 'Kamaru Usman', teamName: 'Kamaru Usman', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'd-ko':  { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'mov_ko',  selection: 'yes', playerName: 'Dricus Du Plessis', teamName: 'Dricus Du Plessis', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'u-ml':  { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'moneyline', selection: 'away', teamName: 'Kamaru Usman', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'f1-tot': { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT1, marketType: 'total', selection: 'over', line: 2.5, teamName: 'Total Rounds', homeTeam: 'Dricus Du Plessis', awayTeam: 'Kamaru Usman' },
  'c-ko':  { sport: 'mma_mixed_martial_arts', pxEventId: FIGHT2, marketType: 'mov_ko',  selection: 'yes', playerName: 'Jared Cannonier', teamName: 'Jared Cannonier', homeTeam: 'Christian Leroy Duncan', awayTeam: 'Jared Cannonier' },
};
// startTime far in the future so the "event started" gate never interferes.
const FUTURE = new Date(Date.now() + 72 * 3600e3).toISOString();
for (const li of Object.values(LINES)) { li.startTime = FUTURE; li.startTimeMs = Date.parse(FUTURE); li.oddsApiSport = li.sport; li.oddsApiMarket = li.marketType; li.oddsApiSelection = li.selection; }

const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });

const legs = (...ids) => ids.map(id => ({ line_id: id }));
const declineOf = (...ids) => pricer.shouldDecline(legs(...ids), null);

// --- same-fight: every shape must decline ----------------------------------

test('same-fight MoV pair on ONE fighter declines (mutually exclusive: KO and SUB cannot both happen)', () => {
  const d = declineOf('u-ko', 'u-sub');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

test('same-fight MoV pair across BOTH fighters declines (only one fighter wins at all)', () => {
  const d = declineOf('u-ko', 'd-ko');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

test('nested MoV pair declines (ko is a subset of inside-the-distance)', () => {
  const d = declineOf('u-ko', 'u-itd');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

test('MoV + that fighter\'s moneyline declines (mov is nested inside the win)', () => {
  const d = declineOf('u-ko', 'u-ml');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

test('MoV + same-fight total rounds declines (method and duration are correlated)', () => {
  const d = declineOf('u-ko', 'f1-tot');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

test('MoV NO side is blocked same-fight too (the guard keys on market, not side)', () => {
  const d = declineOf('u-dec-no', 'd-ko');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

test('a cross-fight leg does not rescue a parlay that also contains a same-fight MoV pair', () => {
  const d = declineOf('u-ko', 'u-sub', 'c-ko');
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'mov_sgp_blocked');
});

// --- the block must NOT depend on SGP_ALLOWED_COMBOS ------------------------

test('block holds even when MoV combos are force-added to SGP_ALLOWED_COMBOS', () => {
  const before = [...(config.pricing.sgpAllowedCombos || [])];
  try {
    config.pricing.sgpAllowedCombos = [...before, 'mov_ko_mov_sub', 'mov_ko_moneyline', 'unclassified'];
    for (const pair of [['u-ko', 'u-sub'], ['u-ko', 'u-ml'], ['u-ko', 'd-ko']]) {
      const d = declineOf(...pair);
      assert.equal(d.declined, true, `${pair.join(' + ')} must decline regardless of the combo list`);
      assert.equal(d.reason, 'mov_sgp_blocked');
    }
  } finally {
    config.pricing.sgpAllowedCombos = before;
  }
});

// --- cross-fight must survive ----------------------------------------------

test('cross-fight MoV parlay is NOT blocked (different fights are independent)', () => {
  const d = declineOf('u-ko', 'c-ko');
  assert.ok(!d || d.declined !== true || d.reason !== 'mov_sgp_blocked',
    'cross-fight MoV must not hit the same-fight guard');
});

test('a single MoV leg is NOT blocked (nothing to correlate with)', () => {
  const d = declineOf('u-ko');
  assert.ok(!d || d.declined !== true || d.reason !== 'mov_sgp_blocked',
    'a lone MoV leg must not hit the same-fight guard');
});
