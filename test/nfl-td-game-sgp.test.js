// NFL anytime-TD + ONE game leg — phase 2 (2026-10-11). 1-3 TD legs + exactly
// one full-game ML / spread / total on the same NFL game -> 'nfl_td_game_sgp',
// priced at the measured factor (97.5% upper bound of joint hits / our
// independent quote, 855 games): own side 1.15 ML / 1.22 spread, two own 1.25 /
// 1.30, 1 TD + over 1.26, 2 TD + over 1.40; opposing side / under 1.00;
// 3 TD all-own and 3 TD + over BLOCKED. Side legs need roster-resolved teams.
// Run: node --test test/nfl-td-game-sgp.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const roster = require('../services/roster');
const pricer = require('../services/pricer');
const { config } = require('../config');

const NFL = 'americanfootball_nfl';
const GAME = 77200;
const FUT = new Date(Date.now() + 20 * 3600e3).toISOString();
const HOME = 'Los Angeles Rams', AWAY = 'San Francisco 49ers';
const L = {};
const base = (id, extra) => (L[id] = Object.assign({ lineId: id, sport: NFL, oddsApiSport: NFL, pxEventId: GAME, homeTeam: HOME, awayTeam: AWAY,
  startTime: FUT, startTimeMs: Date.parse(FUT), propFetchedAt: Date.now() }, extra), id);
const td = (id, player, fair = 0.40, mirror = 0.44) => base(id, { marketType: 'player_anytime_td', oddsApiMarket: 'player_anytime_td',
  playerName: player, teamName: player, selection: 'over', oddsApiSelection: 'over', line: 0.5, marketName: `${player} To Score a Touchdown`,
  fairProb: fair, bookPriceOverride: mirror });
td('cmc', 'Christian McCaffrey'); td('kit', 'George Kittle', 0.33, 0.36); td('aiy', 'Brandon Aiyuk', 0.30, 0.33);
td('nac', 'Puka Nacua', 0.38, 0.41); td('qb', 'Brock Purdy', 0.12, 0.14); td('who', 'Unknown Guy', 0.30, 0.33);
base('sfml', { marketType: 'moneyline', oddsApiMarket: 'h2h', teamName: AWAY, selection: 'away', oddsApiSelection: 'away', marketName: 'Moneyline' });
base('larml', { marketType: 'moneyline', oddsApiMarket: 'h2h', teamName: HOME, selection: 'home', oddsApiSelection: 'home', marketName: 'Moneyline' });
base('sfsp', { marketType: 'spread', oddsApiMarket: 'spreads', teamName: AWAY, selection: 'away', oddsApiSelection: 'away', line: 2.5, marketName: 'Spread' });
base('over', { marketType: 'total', oddsApiMarket: 'totals', teamName: 'Over', selection: 'over', oddsApiSelection: 'over', line: 47.5, marketName: 'Total Points' });
base('under', { marketType: 'total', oddsApiMarket: 'totals', teamName: 'Under', selection: 'under', oddsApiSelection: 'under', line: 47.5, marketName: 'Total Points' });
base('h1ml', { marketType: 'first_half_moneyline', oddsApiMarket: 'h2h_h1', teamName: AWAY, selection: 'away', oddsApiSelection: 'away', marketName: '1st Half Moneyline' });

const saved = {};
function stub({ rosterOn = true } = {}) {
  saved.lookup = lineManager.lookupLine; saved.passer = lineManager.isFootballPasser; saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent; saved.pre = oddsFeed.isEventStalePreGame;
  saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => L[id] || null;
  lineManager.isFootballPasser = (eid, n) => /purdy/i.test(String(n));
  oddsFeed.getFairProb = () => 0.5;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { nflTdSgpEnabled: true, nflTdGameSgpEnabled: true, nflTdGameSgpFactors: null,
    footballSgpEnabled: true, sgpAllowedCombos: ['spread_total', 'ml_total', 'prop_nested', 'prop_prop_xteam'],
    sgpCorrelation3PlusByCombo: { default: 1.25 }, maxRiskPerParlay: 6000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false });
  roster.__setTestMap(NFL, rosterOn ? [['Christian McCaffrey', AWAY], ['George Kittle', AWAY], ['Brandon Aiyuk', AWAY], ['Puka Nacua', HOME], ['Brock Purdy', AWAY]] : []);
}
function restore() {
  lineManager.lookupLine = saved.lookup; lineManager.isFootballPasser = saved.passer; oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale; if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
const dec = (...ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);
const SGP = new Set(['football_sgp_blocked', 'football_period_sgp_blocked', 'prop_correlation_same_game', 'SGP not allowed']);
const blocked = (d) => !!(d && d.declined && SGP.has(d.reason));
async function offered(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid, sgpCombo: 'nfl_td_game_sgp' });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
  return r.meta;
}

test('allowed shapes pass every same-game gate as nfl_td_game_sgp', () => {
  stub();
  try {
    for (const ids of [['cmc', 'sfml'], ['cmc', 'larml'], ['cmc', 'over'], ['cmc', 'under'], ['cmc', 'kit', 'sfsp'],
      ['cmc', 'nac', 'sfml'], ['cmc', 'kit', 'over'], ['cmc', 'kit', 'nac', 'sfml'], ['cmc', 'kit', 'nac', 'under']]) {
      const d = dec(...ids);
      assert.ok(!blocked(d), `${ids.join('+')}: ${d && d.reason} — ${d && d.detail}`);
      if (d && !d.declined) assert.strictEqual(d.sgpCombo, 'nfl_td_game_sgp', ids.join('+'));
    }
  } finally { restore(); }
});

test('blocked: unknown team on a side, 3 TD all-own, 3 TD + over, two game legs, QB, period market, flag off', () => {
  stub();
  try {
    assert.ok(blocked(dec('who', 'sfml')), 'scorer team unknown -> fail closed');
    assert.ok(blocked(dec('cmc', 'kit', 'aiy', 'sfml')), '3 TD all on the side = unmeasured');
    assert.ok(blocked(dec('cmc', 'kit', 'nac', 'over')), '3 TD + over = unmeasured');
    assert.ok(blocked(dec('cmc', 'sfsp', 'over')), 'TD + spread + total');
    assert.ok(blocked(dec('qb', 'sfml')), 'QB TD');
    assert.ok(blocked(dec('cmc', 'h1ml')), '1st-half leg');
    config.pricing.nflTdGameSgpEnabled = false;
    assert.ok(blocked(dec('cmc', 'sfml')), 'flag off');
  } finally { restore(); }
  stub({ rosterOn: false });
  try {
    assert.ok(blocked(dec('cmc', 'sfml')), 'no roster -> side shapes fail closed');
    assert.ok(!blocked(dec('cmc', 'over')), 'totals need no roster');
  } finally { restore(); }
});

test('pricing: the measured factor lifts the OFFERED price by exactly that factor', async () => {
  const cases = [[['cmc', 'sfml'], 1.15], [['cmc', 'larml'], 1.00], [['cmc', 'over'], 1.26], [['cmc', 'under'], 1.00],
    [['cmc', 'kit', 'sfsp'], 1.30], [['cmc', 'kit', 'over'], 1.40], [['cmc', 'nac', 'sfml'], 1.00]];
  for (const [ids, f] of cases) {
    stub();
    try {
      const withF = await offered(ids, 'p2a-' + ids.join(''));
      config.pricing.nflTdGameSgpFactors = { moneyline: { 1: [1, 1], 2: [1, 1, 1], 3: [1, 1, 1, null] }, spread: { 1: [1, 1], 2: [1, 1, 1], 3: [1, 1, 1, null] }, over: { 1: 1, 2: 1, 3: null }, under: { 1: 1, 2: 1, 3: 1 } };
      const noF = await offered(ids, 'p2b-' + ids.join(''));
      const ratio = withF.offeredImpliedProb / noF.offeredImpliedProb;
      assert.ok(Math.abs(ratio - f) < 0.005, `${ids.join('+')}: offered ratio ${ratio.toFixed(4)} vs factor ${f}`);
      assert.ok(Math.abs(withF.fairParlayProb / noF.fairParlayProb - f) < 0.005, `${ids.join('+')}: fair carries the factor too`);
    } finally { restore(); }
  }
});

test('factor overrides are floored at 1.00', async () => {
  stub();
  try {
    config.pricing.nflTdGameSgpFactors = { moneyline: { 1: [0.5, 0.7] } };
    const m = await offered(['cmc', 'sfml'], 'p2-floor');
    config.pricing.nflTdGameSgpFactors = { moneyline: { 1: [1, 1] } };
    const m1 = await offered(['cmc', 'sfml'], 'p2-floor1');
    assert.ok(Math.abs(m.offeredImpliedProb - m1.offeredImpliedProb) < 1e-9, 'a sub-1 override never prices below independent');
  } finally { restore(); }
});

test('nfl_td_game_sgp is experimental by default', () => {
  assert.ok(config.pricing.experimentalSgpCombos.has('nfl_td_game_sgp'));
});
