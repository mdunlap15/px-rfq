// Regression tests: soccer 3-way legs must NEVER be parlayed same-match.
//
// PX posts the 3-way as separate YES/NO markets -- "<Team> to Win (90 Min)"
// x2 and "Draw (90 Min)" -- alongside the draw-no-bet "Moneyline (2 Way)",
// the spread and double chance. Every same-match pairing among those is
// mutually exclusive or nested:
//
//   Home to Win + Draw            -> mutually exclusive, TRUE P = 0
//   Home to Win + Away to Win      -> mutually exclusive, TRUE P = 0
//   Home to Win + Home DNB         -> nested (DNB is P(home | no draw))
//   Home to Win + Home -0.5 spread -> the same event by another name
//   Home to Win + 1X double chance -> nested
//
// Independent multiplication prices a P=0 parlay as if it were live, which is
// the worst shape available: only a counterparty who noticed will take it,
// and it can never win.
//
// Like the MoV block, the guard is EXPLICIT and UNCONDITIONAL rather than a
// reliance on the generic SGP gate. The adversarial cases below force these
// combos INTO SGP_ALLOWED_COMBOS and assert it still declines.
//
// Legs are passed RAW ({line_id}) exactly as PX sends them, because resolving
// raw legs is the whole point -- the golf nesting guard silently never fired
// in production for weeks by reading a pre-resolved shape that only existed
// in tests.

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

const MATCH1 = 800, MATCH2 = 801;
const HOME = 'Birmingham City FC', AWAY = 'Bristol City FC';
const base = { sport: 'soccer_efl_champ', homeTeam: HOME, awayTeam: AWAY };

const LINES = {
  'h-win':   { ...base, pxEventId: MATCH1, marketType: 'soccer_win_3way',  selection: 'yes', teamName: HOME },
  'h-win-no':{ ...base, pxEventId: MATCH1, marketType: 'soccer_win_3way',  selection: 'no',  teamName: HOME },
  'a-win':   { ...base, pxEventId: MATCH1, marketType: 'soccer_win_3way',  selection: 'yes', teamName: AWAY },
  'draw':    { ...base, pxEventId: MATCH1, marketType: 'soccer_draw_3way', selection: 'yes', teamName: null },
  'h-dnb':   { ...base, pxEventId: MATCH1, marketType: 'moneyline', selection: 'home', teamName: HOME },
  'h-spread':{ ...base, pxEventId: MATCH1, marketType: 'spread', selection: 'home', line: -0.5, teamName: HOME },
  'tot':     { ...base, pxEventId: MATCH1, marketType: 'total', selection: 'over', line: 2.5, teamName: 'Total Goals' },
  'dc-1x':   { ...base, pxEventId: MATCH1, marketType: 'double_chance', selection: '1X', teamName: HOME },
  // A DIFFERENT match — cross-match 3-way parlays must still be allowed.
  'm2-h-win':{ ...base, pxEventId: MATCH2, marketType: 'soccer_win_3way', selection: 'yes', teamName: 'Leeds United FC', homeTeam: 'Leeds United FC', awayTeam: 'Hull City AFC' },
  'm2-draw': { ...base, pxEventId: MATCH2, marketType: 'soccer_draw_3way', selection: 'yes', teamName: null, homeTeam: 'Leeds United FC', awayTeam: 'Hull City AFC' },
};
const FUTURE = new Date(Date.now() + 72 * 3600e3).toISOString();
for (const li of Object.values(LINES)) {
  li.startTime = FUTURE; li.startTimeMs = Date.parse(FUTURE);
  li.oddsApiSport = li.sport; li.oddsApiMarket = li.marketType; li.oddsApiSelection = li.selection;
}

const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });

const legs = (...ids) => ids.map(id => ({ line_id: id }));
const declineOf = (...ids) => pricer.shouldDecline(legs(...ids), null);
const BLOCK = 'soccer_3way_sgp_blocked';

test('Home to Win + Draw declines (mutually exclusive, true P = 0)', () => {
  const d = declineOf('h-win', 'draw');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('Home to Win + Away to Win declines (only one side wins)', () => {
  const d = declineOf('h-win', 'a-win');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('Home to Win + same-match draw-no-bet moneyline declines (nested)', () => {
  // The dangerous one: DNB is P(home | no draw), so the joint is P(home), not
  // the product. Multiplying understates it and quotes far too long a price.
  const d = declineOf('h-win', 'h-dnb');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('Home to Win + same-match spread declines (same event, renamed)', () => {
  const d = declineOf('h-win', 'h-spread');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('Home to Win + same-match double chance declines (nested)', () => {
  const d = declineOf('h-win', 'dc-1x');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('Home to Win + same-match total declines (goals and result are correlated)', () => {
  const d = declineOf('h-win', 'tot');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('the NO side is blocked too (the guard keys on market, not side)', () => {
  const d = declineOf('h-win-no', 'draw');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

test('Draw + same-match spread declines', () => {
  const d = declineOf('draw', 'h-spread');
  assert.equal(d.declined, true);
  assert.equal(d.reason, BLOCK);
});

// --- the block must not depend on the combo allowlist ----------------------

test('still declines when the combo is forced INTO SGP_ALLOWED_COMBOS', () => {
  const orig = config.sgpAllowedCombos;
  try {
    config.sgpAllowedCombos = ['spread_total', 'ml_total', 'ml_spread',
      'soccer_win_3way_moneyline', 'soccer_win_3way_soccer_draw_3way', 'unclassified'];
    for (const pair of [['h-win', 'draw'], ['h-win', 'h-dnb'], ['h-win', 'a-win']]) {
      const d = declineOf(...pair);
      assert.equal(d.declined, true, `${pair.join(' + ')} must still decline`);
      assert.equal(d.reason, BLOCK, `${pair.join(' + ')} must decline via the explicit guard`);
    }
  } finally {
    config.sgpAllowedCombos = orig;
  }
});

// --- cross-match must remain quotable --------------------------------------

test('CROSS-match 3-way parlay is allowed (different events are independent)', () => {
  const d = declineOf('h-win', 'm2-h-win');
  assert.notEqual(d && d.reason, BLOCK);
});

test('CROSS-match win + draw is allowed', () => {
  const d = declineOf('h-win', 'm2-draw');
  assert.notEqual(d && d.reason, BLOCK);
});

test('a lone 3-way leg is not blocked by the SGP guard', () => {
  const d = declineOf('h-win');
  assert.notEqual(d && d.reason, BLOCK);
});
