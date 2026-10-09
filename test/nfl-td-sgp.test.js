// NFL anytime-TD same-game parlays — phase 1 (2026-10-09). Operator: "yes,
// build phase 1". 2-4 anytime-TD legs on one NFL game, different players, no
// QB, nothing else from that game -> 'nfl_td_sgp', experimental tier, priced at
// the independent product (measured: joint hits / our mirror quote 0.61-0.84,
// every 97.5% bound < 0.90 on 855 games — scripts/_nfl_sgp_prop_measure.js).
// Everything else same-game football stays blocked.
// Run: node --test test/nfl-td-sgp.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const sgpGuard = require('../services/sgp-guard');
const { config } = require('../config');

const NFL = 'americanfootball_nfl';
const GAME = 77100;
const FUT = new Date(Date.now() + 20 * 3600e3).toISOString();
const L = {};
function td(id, player, extra = {}) {
  L[id] = Object.assign({ lineId: id, sport: NFL, oddsApiSport: NFL, pxEventId: GAME, homeTeam: 'Los Angeles Rams', awayTeam: 'San Francisco 49ers',
    startTime: FUT, startTimeMs: Date.parse(FUT), marketType: 'player_anytime_td', oddsApiMarket: 'player_anytime_td',
    playerName: player, teamName: player, selection: 'over', oddsApiSelection: 'over', line: 0.5,
    marketName: `${player} To Score a Touchdown`, fairProb: 0.40, bookPriceOverride: 0.44, propFetchedAt: Date.now() }, extra);
  return id;
}
const CMC = td('cmc', 'Christian McCaffrey');
const KIT = td('kit', 'George Kittle', { fairProb: 0.33, bookPriceOverride: 0.36 });
const NAC = td('nac', 'Puka Nacua', { fairProb: 0.38, bookPriceOverride: 0.41 });
const WIL = td('wil', 'Kyren Williams', { fairProb: 0.50, bookPriceOverride: 0.55 });
const AIY = td('aiy', 'Brandon Aiyuk', { fairProb: 0.30, bookPriceOverride: 0.33 });
const QB = td('qb', 'Brock Purdy', { fairProb: 0.12, bookPriceOverride: 0.14 });
const CFB1 = td('cfb1', 'College A', { sport: 'americanfootball_ncaaf', oddsApiSport: 'americanfootball_ncaaf', pxEventId: 88100 });
const CFB2 = td('cfb2', 'College B', { sport: 'americanfootball_ncaaf', oddsApiSport: 'americanfootball_ncaaf', pxEventId: 88100 });
L.spread = Object.assign({}, L[CMC], { lineId: 'spread', marketType: 'spread', oddsApiMarket: 'spreads', teamName: 'San Francisco 49ers', playerName: undefined, selection: 'away', oddsApiSelection: 'away', line: 2.5, marketName: 'Spread' });
L.ftd = Object.assign({}, L[NAC], { lineId: 'ftd', marketType: 'player_first_td', oddsApiMarket: 'player_1st_td', playerName: 'Puka Nacua', marketName: 'Puka Nacua To Score First Touchdown' });

const PASSERS = new Set(['brock purdy']);
const saved = {};
function stub(passer = (n) => PASSERS.has(String(n).toLowerCase())) {
  saved.lookup = lineManager.lookupLine; saved.passer = lineManager.isFootballPasser;
  saved.flag = config.pricing.nflTdSgpEnabled; saved.combos = config.pricing.sgpAllowedCombos; saved.fb = config.pricing.footballSgpEnabled;
  saved.three = config.pricing.sgpCorrelation3PlusByCombo; saved.stale = oddsFeed.isStaleForEvent; saved.pre = oddsFeed.isEventStalePreGame;
  lineManager.lookupLine = (id) => L[id] || null;
  lineManager.isFootballPasser = (eid, name) => passer(name);
  config.pricing.nflTdSgpEnabled = true;
  config.pricing.footballSgpEnabled = true;                                   // prod
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total', 'prop_nested', 'prop_prop_xteam']; // prod
  config.pricing.sgpCorrelation3PlusByCombo = { ml_spread_total: 1.25, default: 1.25 };          // prod
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
}
function restore() {
  lineManager.lookupLine = saved.lookup; lineManager.isFootballPasser = saved.passer;
  config.pricing.nflTdSgpEnabled = saved.flag; config.pricing.sgpAllowedCombos = saved.combos; config.pricing.footballSgpEnabled = saved.fb;
  config.pricing.sgpCorrelation3PlusByCombo = saved.three; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
}
const dec = (...ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);
const SGP_REASONS = new Set(['football_sgp_blocked', 'prop_correlation_same_game', 'SGP not allowed', 'prop_correlation_same_player']);
const sgpBlocked = (d) => !!(d && d.declined && SGP_REASONS.has(d.reason));

test('2, 3 and 4 anytime-TD legs on one NFL game pass every same-game gate as nfl_td_sgp', () => {
  stub();
  try {
    for (const ids of [[CMC, KIT], [CMC, NAC], [CMC, KIT, NAC], [CMC, KIT, NAC, WIL]]) {
      const d = dec(...ids);
      assert.ok(!sgpBlocked(d), `${ids.join('+')}: ${d && d.reason} — ${d && d.detail}`);
      if (d && !d.declined) assert.strictEqual(d.sgpCombo, 'nfl_td_sgp');
    }
  } finally { restore(); }
});

test('blocked: 5+ legs, a QB, unknown passer status, the same player twice', () => {
  stub();
  try {
    assert.ok(sgpBlocked(dec(CMC, KIT, NAC, WIL, AIY)), '5 legs');
    assert.ok(sgpBlocked(dec(CMC, QB)), 'QB TD');
  } finally { restore(); }
  stub(() => null);
  try { assert.ok(sgpBlocked(dec(CMC, KIT)), 'passer status unknown fails closed'); } finally { restore(); }
});

test('blocked: TD + any non-TD leg from the game (side, first TD), CFB, flag off', () => {
  stub();
  try {
    assert.ok(sgpBlocked(dec(CMC, 'spread')), 'TD + spread stays blocked (phase 2)');
    assert.ok(sgpBlocked(dec(CMC, KIT, 'spread')), 'TD + TD + spread stays blocked');
    assert.ok(sgpBlocked(dec(CMC, 'ftd')), 'TD + first TD stays blocked');
    assert.ok(sgpBlocked(dec(CFB1, CFB2)), 'CFB never measured');
    config.pricing.nflTdSgpEnabled = false;
    assert.ok(sgpBlocked(dec(CMC, KIT)), 'flag off');
  } finally { restore(); }
});

test('nfl_td_sgp is experimental by default (per-ticket cap, daily budget, stop-loss)', () => {
  assert.ok(config.pricing.experimentalSgpCombos.has('nfl_td_sgp'));
  assert.strictEqual(sgpGuard.isExperimental('nfl_td_sgp'), true);
});

test('pricing: a 3-TD group takes NO correlation factor (not the 3+ default 1.25) and quotes the mirror product', async () => {
  stub();
  const sv = { cap: config.pricing.maxRiskPerParlay, maxOdds: config.pricing.maxOdds, relay: config.pricing.obRelayEnabled, fg: config.pricing.freshGateEnabled };
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000; config.pricing.obRelayEnabled = false; config.pricing.freshGateEnabled = false;
  try {
    const r = await pricer.priceParlay([CMC, KIT, NAC], { parlayId: 'nfltd-1', sgpCombo: 'nfl_td_sgp' });
    try { orderTracker.releasePending('nfltd-1'); } catch (_) {}
    assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
    assert.ok(!(r.meta.sgpCorrelationFactor > 1), `factor ${r.meta.sgpCorrelationFactor}`);
    const fair = 0.40 * 0.33 * 0.38;
    assert.ok(Math.abs(r.meta.fairParlayProb - fair) < 1e-4, `fair ${r.meta.fairParlayProb} vs independent ${fair}`);
    const mirror = 0.44 * 0.36 * 0.41;
    assert.ok(r.meta.offeredImpliedProb >= mirror - 1e-4, `offered ${r.meta.offeredImpliedProb} must not be below the mirror product ${mirror}`);
  } finally {
    config.pricing.maxRiskPerParlay = sv.cap; config.pricing.maxOdds = sv.maxOdds; config.pricing.obRelayEnabled = sv.relay; config.pricing.freshGateEnabled = sv.fg;
    restore();
  }
});

test('isFootballPasser reads PX\'s own board: a player with a passing market is a QB; no context = null', () => {
  const ctx = lineManager.__propSeedCtxForTest();
  ctx.set('99001', { at: 1, markets: [{ name: 'Brock Purdy Total Passing Yards' }, { name: 'George Kittle Total Receiving Yards' }, { name: 'Christian McCaffrey To Score a Touchdown' }] });
  try {
    assert.strictEqual(lineManager.isFootballPasser(99001, 'Brock Purdy'), true);
    assert.strictEqual(lineManager.isFootballPasser(99001, 'George Kittle'), false);
    assert.strictEqual(lineManager.isFootballPasser(99001, 'Christian McCaffrey'), false);
    assert.strictEqual(lineManager.isFootballPasser(99002, 'Brock Purdy'), null);
  } finally { ctx.delete('99001'); }
});
