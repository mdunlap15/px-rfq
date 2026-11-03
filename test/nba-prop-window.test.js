// NBA prop listing window (2026-11-02, operator: "set our NBA props to T-25 like
// we do with the PX order book"). NBA player props register only inside
// nbaPropTMinusMinutes of tip; the pricer declines one outside it anyway.
// Run: node --test test/nba-prop-window.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const L = {};
let seq = 0;
function prop(sport, minsOut, market = 'player_points') {
  const id = 'npw-' + (++seq), ev = 'NPW-E' + seq, st = new Date(Date.now() + minsOut * 60e3).toISOString();
  L[id] = { lineId: id, sport, oddsApiSport: sport, marketType: market, oddsApiMarket: market, propType: market.replace('player_', ''),
    playerName: 'P' + seq, teamName: 'P' + seq, selection: 'over', oddsApiSelection: 'over', line: 20.5, homeTeam: 'H' + ev, awayTeam: 'A' + ev,
    pxEventId: ev, startTime: st, startTimeMs: Date.parse(st), propFetchedAt: Date.now(), fairProb: 0.5 };
  return id;
}
function game(minsOut) {
  const id = 'npw-' + (++seq), ev = 'NPW-E' + seq, st = new Date(Date.now() + minsOut * 60e3).toISOString();
  L[id] = { lineId: id, sport: 'basketball_nba', oddsApiSport: 'basketball_nba', marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'H' + ev, selection: 'home', homeTeam: 'H' + ev, awayTeam: 'A' + ev, pxEventId: ev, startTime: st, startTimeMs: Date.parse(st), fairProb: 0.5 };
  return id;
}
const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.stale = oddsFeed.isStaleForEvent; saved.pre = oddsFeed.isEventStalePreGame; saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 6000, maxRiskPerParlayWithProp: 6000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    mlbPropMaxHoursBeforeStart: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, nhlPropEarlyGatePercent: 0, nbaPropTMinusMinutes: 25 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.isStaleForEvent = saved.stale; if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
async function run(ids, pid, opts = {}) {
  const r = await pricer.priceParlay(ids, { parlayId: pid, ...opts });
  try { orderTracker.releasePending(pid); } catch (_) {}
  return r;
}

test('default window is T-25', () => {
  const v = require('../config').config.pricing.nbaPropTMinusMinutes;
  assert.strictEqual(process.env.NBA_PROP_TMINUS_MINUTES ? Number(process.env.NBA_PROP_TMINUS_MINUTES) : 25, v);
});

test('registration window: NBA opens at T-25, closed at T-26 and on an unknown tip; other sports and 0 = off are open', () => {
  stub();
  try {
    const at = (m) => new Date(Date.now() + m * 60e3).toISOString();
    assert.strictEqual(lineManager._nbaPropWindowOpen('basketball_nba', at(24)), true);
    assert.strictEqual(lineManager._nbaPropWindowOpen('basketball_nba', at(26)), false);
    assert.strictEqual(lineManager._nbaPropWindowOpen('basketball_nba', null), false);
    assert.strictEqual(lineManager._nbaPropWindowOpen('basketball_wnba', at(600)), true);
    assert.strictEqual(lineManager._nbaPropWindowOpen('basketball_ncaab', at(600)), true);
    config.pricing.nbaPropTMinusMinutes = 0;
    assert.strictEqual(lineManager._nbaPropWindowOpen('basketball_nba', at(600)), true);
  } finally { restore(); }
});

test('pricer: an NBA prop leg beyond T-25 declines nba_prop_window; inside it prices', async () => {
  stub();
  try {
    assert.strictEqual(await run([prop('basketball_nba', 40), prop('basketball_nba', 20)], 'npw-1'), null);
    assert.strictEqual(pricer.getLastPriceFailure().reason, 'nba_prop_window');
    const r = await run([prop('basketball_nba', 20), prop('basketball_nba', 20)], 'npw-2');
    assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
  } finally { restore(); }
});

test('pricer: NBA game lines, WNBA props and fairOnly reads are never gated; 0 turns it off', async () => {
  stub();
  try {
    const g = await run([game(600), game(600)], 'npw-3');
    if (!g) assert.notStrictEqual(pricer.getLastPriceFailure().reason, 'nba_prop_window');
    assert.ok(await run([prop('basketball_wnba', 600), prop('basketball_wnba', 600)], 'npw-4'), JSON.stringify(pricer.getLastPriceFailure()));
    const fo = await pricer.priceParlay([prop('basketball_nba', 600)], { fairOnly: true });
    assert.ok(fo, 'fairOnly (EV live) read must not be gated: ' + JSON.stringify(pricer.getLastPriceFailure()));
    config.pricing.nbaPropTMinusMinutes = 0;
    assert.ok(await run([prop('basketball_nba', 600), prop('basketball_nba', 600)], 'npw-5'), JSON.stringify(pricer.getLastPriceFailure()));
  } finally { restore(); }
});
