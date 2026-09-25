// CFB EXTREME-SPREAD SGP CAP (2026-09-25).
// Rutgers -42.5 + Over 56.5 (Howard @ Rutgers) quoted +233 while FanDuel's real
// SGP was +151: the measured CFB table's top bucket (14.5+ -> 1.17) is an
// average and under-prices the tail. CFB spread+total SGPs at |spread| >=
// FOOTBALL_SGP_MAX_SPREAD_NCAAF (default 28) now decline.
//
// Run: node --test test/cfb-sgp-spread-cap.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const mk = (id, ev, sport, extra) => Object.assign({
  lineId: id, sport, oddsApiSport: sport, pxEventId: ev,
  homeTeam: 'Rutgers', awayTeam: 'Howard', startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
}, extra);
const NCAAF = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl';
const LINES = {};
function pair(key, sport, spread) {
  const ev = 'E-' + key;
  LINES[key + '-s'] = mk(key + '-s', ev, sport, { marketType: 'spread', teamName: 'Rutgers', selection: 'home', oddsApiSelection: 'home', line: spread, marketName: 'Spread' });
  LINES[key + '-t'] = mk(key + '-t', ev, sport, { marketType: 'total', selection: 'over', oddsApiSelection: 'over', line: 56.5, marketName: 'Total Points' });
  LINES[key + '-s'].oddsApiMarket = 'spreads'; LINES[key + '-t'].oddsApiMarket = 'totals';
  return [key + '-s', key + '-t'];
}
for (const li of Object.values(LINES)) li.oddsApiMarket = li.marketType;
const orig = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = orig; });

function withOpen(fn, cap) {
  const p = { en: config.pricing.footballSgpEnabled, c: config.pricing.sgpAllowedCombos, cap: config.pricing.footballSgpMaxSpreadNcaaf };
  config.pricing.footballSgpEnabled = true;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  if (cap !== undefined) config.pricing.footballSgpMaxSpreadNcaaf = cap;
  try { return fn(); } finally {
    config.pricing.footballSgpEnabled = p.en; config.pricing.sgpAllowedCombos = p.c; config.pricing.footballSgpMaxSpreadNcaaf = p.cap;
  }
}
const decline = (ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);

test('default cap is 28', () => {
  assert.strictEqual(config.pricing.footballSgpMaxSpreadNcaaf, 28);
});

test('CFB -42.5 spread + total declines as football_sgp_spread_too_large', () => {
  const ids = pair('big', NCAAF, -42.5);
  withOpen(() => {
    const d = decline(ids);
    assert.ok(d && d.declined);
    assert.strictEqual(d.reason, 'football_sgp_spread_too_large', JSON.stringify(d));
  });
});

test('exactly at the cap declines; just below does not hit this guard', () => {
  const at = pair('at', NCAAF, -28), below = pair('below', NCAAF, -27.5);
  withOpen(() => {
    assert.strictEqual(decline(at).reason, 'football_sgp_spread_too_large');
    const d = decline(below);
    assert.notStrictEqual(d && d.reason, 'football_sgp_spread_too_large');
    assert.notStrictEqual(d && d.reason, 'football_sgp_blocked', 'a measured 14.5+ pair below the cap still prices');
  });
});

test('NFL is untouched by the CFB cap (NFL is measured independent)', () => {
  const ids = pair('nfl', NFL, -30.5);
  withOpen(() => {
    const d = decline(ids);
    assert.notStrictEqual(d && d.reason, 'football_sgp_spread_too_large');
  });
});

test('cap 0 disables the guard', () => {
  const ids = pair('off', NCAAF, -42.5);
  withOpen(() => {
    const d = decline(ids);
    assert.notStrictEqual(d && d.reason, 'football_sgp_spread_too_large');
  }, 0);
});
