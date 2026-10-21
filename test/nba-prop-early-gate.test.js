// NBA early-prop timing A/B (2026-10-21 perf review). Gate arm declines a parlay
// with an NBA prop leg more than nbaPropEarlyGateHours before tip; control
// prices normally and records meta.nbaPropGateArm. Ships dark.
// Run: node --test test/nba-prop-early-gate.test.js
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
function prop(sport, hoursOut, market = 'player_points') {
  const id = 'nbg-' + (++seq), ev = 'NBG-E' + seq, st = new Date(Date.now() + hoursOut * 3600e3).toISOString();
  L[id] = { lineId: id, sport, oddsApiSport: sport, marketType: market, oddsApiMarket: market, propType: market.replace('player_', ''),
    playerName: 'P' + seq, teamName: 'P' + seq, selection: 'over', oddsApiSelection: 'over', line: 20.5, homeTeam: 'H' + ev, awayTeam: 'A' + ev,
    pxEventId: ev, startTime: st, startTimeMs: Date.parse(st), propFetchedAt: Date.now(), fairProb: 0.5 };
  return id;
}
const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.stale = oddsFeed.isStaleForEvent; saved.pre = oddsFeed.isEventStalePreGame; saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 6000, maxRiskPerParlayWithProp: 6000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    mlbPropMaxHoursBeforeStart: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, nbaPropEarlyGateHours: 8 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.isStaleForEvent = saved.stale; if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
async function run(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  return r;
}

test('dark by default: an early NBA prop parlay prices and carries no arm', async () => {
  stub();
  try {
    const r = await run([prop('basketball_nba', 10), prop('basketball_nba', 10)], 'nbg-dark');
    assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
    assert.strictEqual(r.meta.nbaPropGateArm, null);
  } finally { restore(); }
});

test('gate arm declines an NBA prop leg beyond the gate; inside the gate it prices with no arm', async () => {
  stub({ nbaPropEarlyGatePercent: 100 });
  try {
    assert.strictEqual(await run([prop('basketball_nba', 10), prop('basketball_nba', 10)], 'nbg-g1'), null);
    assert.strictEqual(pricer.getLastPriceFailure().reason, 'nba_prop_early_ab');
    const near = await run([prop('basketball_nba', 3), prop('basketball_nba', 3)], 'nbg-g2');
    assert.ok(near && near.meta, 'inside 8h: not gated');
    assert.strictEqual(near.meta.nbaPropGateArm, null);
  } finally { restore(); }
});

test('only NBA props: another sport\'s prop 10h out (WNBA, NHL) is never gated', async () => {
  stub({ nbaPropEarlyGatePercent: 100 });
  try {
    const r = await run([prop('basketball_wnba', 10), prop('icehockey_nhl', 10, 'player_shots_on_goal')], 'nbg-o1');
    assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
    assert.strictEqual(r.meta.nbaPropGateArm, null);
  } finally { restore(); }
});

test('50%: both arms occur, control prices and is tagged, the arm is a pure function of parlayId', async () => {
  stub({ nbaPropEarlyGatePercent: 50 });
  try {
    const seen = new Set();
    for (let i = 0; i < 24; i++) {
      const r = await run([prop('basketball_nba', 10), prop('basketball_nba', 10)], 'nbg-arm-' + i);
      seen.add(r ? r.meta.nbaPropGateArm : 'gate');
    }
    assert.deepStrictEqual([...seen].sort(), ['control', 'gate']);
    const a = await run([prop('basketball_nba', 10), prop('basketball_nba', 10)], 'nbg-same');
    const b = await run([prop('basketball_nba', 10), prop('basketball_nba', 10)], 'nbg-same');
    assert.strictEqual(!!a, !!b);
  } finally { restore(); }
});

test('scope + hours key: an NBA game line 10h out is never gated; with a 12h gate a 10h NBA prop prices', async () => {
  stub({ nbaPropEarlyGatePercent: 100 });
  try {
    const gl = prop('basketball_nba', 10, 'moneyline');
    L[gl].oddsApiMarket = 'h2h'; L[gl].selection = 'home'; L[gl].oddsApiSelection = 'home'; delete L[gl].playerName;
    const oddsFeed2 = require('../services/odds-feed');
    const savedFair = oddsFeed2.getFairProb;
    oddsFeed2.getFairProb = () => 0.5;
    try {
      const r = await run([gl, prop('basketball_wnba', 10)], 'nbg-gl');
      assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
      assert.strictEqual(r.meta.nbaPropGateArm, null);
    } finally { oddsFeed2.getFairProb = savedFair; }
    config.pricing.nbaPropEarlyGateHours = 12;
    const r2 = await run([prop('basketball_nba', 10), prop('basketball_nba', 10)], 'nbg-12h');
    assert.ok(r2 && r2.meta, 'inside a 12h gate: priced');
    assert.strictEqual(r2.meta.nbaPropGateArm, null);
  } finally { restore(); }
});
