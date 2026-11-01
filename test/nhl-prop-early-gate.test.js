// NHL early-prop timing A/B (2026-11-01). The NBA gate's twin: the gate arm
// declines a parlay with an NHL prop leg more than nhlPropEarlyGateHours before
// puck drop; control prices normally and records meta.nhlPropGateArm. Ships
// LIVE at 50% (the evidence: creator 5d7881da's early NHL shots-on-goal parlays,
// fair drift +29% toward the bettor, z 9.1).
// Run: node --test test/nhl-prop-early-gate.test.js
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
function prop(sport, hoursOut, market = 'player_shots_on_goal') {
  const id = 'nhg-' + (++seq), ev = 'NHG-E' + seq, st = new Date(Date.now() + hoursOut * 3600e3).toISOString();
  L[id] = { lineId: id, sport, oddsApiSport: sport, marketType: market, oddsApiMarket: market, propType: market.replace('player_', ''),
    playerName: 'P' + seq, teamName: 'P' + seq, selection: 'over', oddsApiSelection: 'over', line: 2.5, homeTeam: 'H' + ev, awayTeam: 'A' + ev,
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
    mlbPropMaxHoursBeforeStart: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, legDriftCorrectionPercent: 0,
    nhlPropEarlyGatePercent: 0, nhlPropEarlyGateHours: 8 }, extra);
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

test('defaults: LIVE at 50%, 8h', () => {
  assert.strictEqual(config.pricing.nhlPropEarlyGatePercent, 50);
  assert.strictEqual(config.pricing.nhlPropEarlyGateHours, 8);
});

test('dark (0%): an early NHL prop parlay prices and carries no arm', async () => {
  stub();
  try {
    const r = await run([prop('icehockey_nhl', 12), prop('icehockey_nhl', 12)], 'nhg-dark');
    assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
    assert.strictEqual(r.meta.nhlPropGateArm, null);
  } finally { restore(); }
});

test('gate arm declines an NHL prop leg beyond the gate; inside the gate it prices with no arm', async () => {
  stub({ nhlPropEarlyGatePercent: 100 });
  try {
    assert.strictEqual(await run([prop('icehockey_nhl', 12), prop('icehockey_nhl', 12)], 'nhg-g1'), null);
    assert.strictEqual(pricer.getLastPriceFailure().reason, 'nhl_prop_early_ab');
    const near = await run([prop('icehockey_nhl', 3), prop('icehockey_nhl', 3)], 'nhg-g2');
    assert.ok(near && near.meta, 'inside 8h: not gated');
    assert.strictEqual(near.meta.nhlPropGateArm, null);
  } finally { restore(); }
});

test('only NHL props: an NBA prop or an NHL game line 12h out is never gated by it', async () => {
  stub({ nhlPropEarlyGatePercent: 100 });
  try {
    const gl = prop('icehockey_nhl', 12, 'moneyline');
    L[gl].oddsApiMarket = 'h2h'; L[gl].selection = 'home'; L[gl].oddsApiSelection = 'home'; delete L[gl].playerName;
    const savedFair = oddsFeed.getFairProb;
    oddsFeed.getFairProb = () => 0.5;
    try {
      const r = await run([gl, prop('basketball_nba', 12, 'player_points')], 'nhg-o1');
      assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
      assert.strictEqual(r.meta.nhlPropGateArm, null);
    } finally { oddsFeed.getFairProb = savedFair; }
  } finally { restore(); }
});

test('50%: both arms occur, control prices and is tagged, the arm is a pure function of parlayId', async () => {
  stub({ nhlPropEarlyGatePercent: 50 });
  try {
    const seen = new Set();
    for (let i = 0; i < 24; i++) {
      const r = await run([prop('icehockey_nhl', 12), prop('icehockey_nhl', 12)], 'nhg-arm-' + i);
      seen.add(r ? r.meta.nhlPropGateArm : 'gate');
    }
    assert.deepStrictEqual([...seen].sort(), ['control', 'gate']);
    const a = await run([prop('icehockey_nhl', 12), prop('icehockey_nhl', 12)], 'nhg-same');
    const b = await run([prop('icehockey_nhl', 12), prop('icehockey_nhl', 12)], 'nhg-same');
    assert.strictEqual(!!a, !!b);
  } finally { restore(); }
});

test('hours key: with a 16h gate a 12h NHL prop prices', async () => {
  stub({ nhlPropEarlyGatePercent: 100, nhlPropEarlyGateHours: 16 });
  try {
    const r = await run([prop('icehockey_nhl', 12), prop('icehockey_nhl', 12)], 'nhg-16h');
    assert.ok(r && r.meta, JSON.stringify(pricer.getLastPriceFailure()));
    assert.strictEqual(r.meta.nhlPropGateArm, null);
  } finally { restore(); }
});
