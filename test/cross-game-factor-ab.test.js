// CROSS-GAME SELECTION FACTOR A/B (2026-11-02).
//
// Bettors hit 1.167x our fair [1.08, 1.26] (z 4.75) on cross-game game-line
// parlays with joint fair >= 20% and no NCAAF / NBA leg. The factor arm
// multiplies the parlay FAIR and the OFFERED price by mult[legs], defers to the
// 2-leg factor wherever that block is in scope, and never touches same-game or
// player-prop parlays. Arm is a pure function of parlayId.
// Run: node --test test/cross-game-factor-ab.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const LINES = {};
let seq = 0;
let FAIR = 0.5;
function ml(sport = 'baseball_mlb', ev) {
  const id = 'xgf-' + (++seq); ev = ev || ('XGF-E' + seq);
  LINES[id] = { lineId: id, sport, oddsApiSport: sport, marketType: 'moneyline', oddsApiMarket: 'h2h', teamName: 'Home ' + ev,
    selection: 'home', oddsApiSelection: 'home', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
    startTime: FUTURE, startTimeMs: Date.parse(FUTURE) };
  return id;
}
const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => FAIR;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 3000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    twoLegWidenPercent: 0, mlPairTrimPercent: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, nhlPropEarlyGatePercent: 0,
    legDriftCorrectionPercent: 0, footballCeilingPercent: 0, nbaCeilingPercent: 0, twoLegFactorPercent: 0,
    crossGameFactorPercent: 0, crossGameFactorMult2: 1.10, crossGameFactorMult3: 1.12, crossGameFactorMult4: 1.12,
    crossGameFactorMinFair: 0.20, crossGameFactorExcludeSports: ['americanfootball_ncaaf', 'basketball_nba'] }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
  FAIR = 0.5;
}
let pid = 0;
async function price(ids, parlayId) {
  parlayId = parlayId || ('xgf-p' + (++pid));
  const r = await pricer.priceParlay(ids, { parlayId });
  try { orderTracker.releasePending(parlayId); } catch (_) {}
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.getLastPriceFailure && pricer.getLastPriceFailure()));
  return r.meta;
}

test('config defaults: LIVE at 50%, x1.10 / 1.12 / 1.12, min fair 20%, NCAAF + NBA + politics excluded', () => {
  const p = config.pricing;
  assert.deepStrictEqual([p.crossGameFactorPercent, p.crossGameFactorMult2, p.crossGameFactorMult3, p.crossGameFactorMult4, p.crossGameFactorMinFair],
    [50, 1.10, 1.12, 1.12, 0.20]);
  assert.deepStrictEqual(p.crossGameFactorExcludeSports, ['americanfootball_ncaaf', 'basketball_nba', 'politics']);
});

test('factor arm: fair AND offered x mult[legs] vs control; same relative margin; Rule 2 holds', async () => {
  stub();
  try {
    for (const [n, mult, fair] of [[2, 1.10, 0.5], [3, 1.12, 0.65], [4, 1.12, 0.7]]) {
      FAIR = fair;
      const mk = () => Array.from({ length: n }, () => ml());
      config.pricing.crossGameFactorPercent = 0;
      const ctl = await price(mk());
      assert.ok(ctl.fairParlayProb >= 0.20, `${n}L fixture fair ${ctl.fairParlayProb}`);
      assert.strictEqual(ctl.xgFactorArm, null);
      config.pricing.crossGameFactorPercent = 100;
      const m = await price(mk());
      assert.strictEqual(m.xgFactorArm, 'factor', `${n}L arm`);
      assert.strictEqual(m.xgFactorApplied, true);
      assert.strictEqual(m.xgFactorMult, mult, `${n}L mult`);
      assert.ok(Math.abs(m.xgFactorPreFair - ctl.fairParlayProb) < 2e-5, 'pre-fair = raw product');
      assert.ok(Math.abs(m.fairParlayProb - ctl.fairParlayProb * mult) < 2e-5, `${n}L fair ${m.fairParlayProb} vs ${ctl.fairParlayProb * mult}`);
      assert.ok(Math.abs(m.offeredImpliedProb - ctl.offeredImpliedProb * mult) < 2e-4, `${n}L offered ${m.offeredImpliedProb} vs ${ctl.offeredImpliedProb * mult}`);
      assert.ok(Math.abs(m.offeredImpliedProb / m.fairParlayProb - ctl.offeredImpliedProb / ctl.fairParlayProb) < 2e-3, 'margin over the new fair unchanged');
      const prod = m.legs.reduce((p, l) => p * l.legConfirmProb, 1);
      assert.ok(Math.abs(prod - m.offeredImpliedProb) < 1e-4, 'Rule 2: per-leg confirm probs multiply to the final price');
    }
  } finally { restore(); }
});

test('out of scope at 100%: joint fair < 20%, an excluded-sport leg, a player prop, same-game', async () => {
  stub({ crossGameFactorPercent: 100 });
  try {
    FAIR = 0.4;   // 0.16 joint
    assert.strictEqual((await price([ml(), ml()])).xgFactorArm, null, 'fair 16%');
    FAIR = 0.5;
    assert.strictEqual((await price([ml(), ml('basketball_nba')])).xgFactorArm, null, 'NBA leg');
    assert.strictEqual((await price([ml('americanfootball_ncaaf'), ml()])).xgFactorArm, null, 'NCAAF leg');
    assert.strictEqual((await price([ml('icehockey_nhl'), ml()])).xgFactorArm, 'factor', 'other sport mixes are in scope');
    // A player prop that PRICES (inside the MLB prop maturity window) is out of scope.
    const soon = new Date(Date.now() + 5 * 3600e3).toISOString();
    const p = ml(); Object.assign(LINES[p], { playerName: 'Aaron Judge', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits',
      selection: 'over', oddsApiSelection: 'Over', line: 0.5, teamName: 'over', startTime: soon, startTimeMs: Date.parse(soon) });
    const pm = await price([p, ml()]);
    assert.strictEqual(pm.xgFactorArm, null, 'prop leg never factored');
  } finally { restore(); }
});

test('same-game parlay is never factored', async () => {
  stub({ crossGameFactorPercent: 100 });
  try {
    FAIR = 0.5;
    const a = ml('baseball_mlb', 'XGF-SG'); const b = ml('baseball_mlb', 'XGF-SG');
    LINES[b].marketType = 'total'; LINES[b].oddsApiMarket = 'totals'; LINES[b].selection = 'over'; LINES[b].oddsApiSelection = 'Over'; LINES[b].line = 8.5; LINES[b].teamName = 'over';
    const r = await pricer.priceParlay([a, b], { parlayId: 'xgf-sg' });
    try { orderTracker.releasePending('xgf-sg'); } catch (_) {}
    assert.ok(!r || r.meta.xgFactorArm == null, 'same-game out of scope');
  } finally { restore(); }
});

test('defers to the 2-leg factor wherever it is in scope (either arm): never stacks, its control arm untouched', async () => {
  stub({ crossGameFactorPercent: 100, twoLegFactorPercent: 50 });
  try {
    FAIR = Math.sqrt(0.36);   // joint 36% = inside the 2lf band
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const m = await price([ml(), ml()], 'xgf-2lf-' + i);
      seen.add(m.twoLegFactorArm);
      assert.strictEqual(m.xgFactorArm, null, '2lf in scope -> cross-game factor out of scope');
      if (m.twoLegFactorArm === 'control') assert.ok(Math.abs(m.fairParlayProb - 0.36) < 2e-5, 'control fair untouched');
    }
    assert.deepStrictEqual([...seen].sort(), ['control', 'factor']);
    FAIR = 0.5;   // joint 25%: below the 2lf band -> cross-game factor applies
    assert.strictEqual((await price([ml(), ml()])).xgFactorApplied, true);
  } finally { restore(); }
});

test('50%: both arms occur, control untouched, arm is a pure function of parlayId; the 2-leg widen skips a factored quote', async () => {
  stub({ crossGameFactorPercent: 50 });
  try {
    const arms = new Set();
    for (let i = 0; i < 24; i++) {
      const m = await price([ml(), ml()], 'xgf-arm-' + i);
      arms.add(m.xgFactorArm);
      if (m.xgFactorArm === 'control') { assert.strictEqual(m.xgFactorApplied, false); assert.ok(Math.abs(m.fairParlayProb - 0.25) < 2e-5); }
    }
    assert.deepStrictEqual([...arms].sort(), ['control', 'factor']);
    const a = await price([ml(), ml()], 'xgf-same'), b = await price([ml(), ml()], 'xgf-same');
    assert.strictEqual(a.xgFactorArm, b.xgFactorArm);
    Object.assign(config.pricing, { crossGameFactorPercent: 100, twoLegWidenPercent: 100, twoLegWidenMinFair: 0.20 });
    const w = await price([ml(), ml()]);
    assert.strictEqual(w.xgFactorApplied, true);
    assert.notStrictEqual(w.twoLegWidenApplied, true, 'the widen skips a factored quote');
  } finally { restore(); }
});

test('confirm: a factored quote (cross-game OR 2-leg) confirms on unchanged odds — the reprice is compared on the pre-factor fair', async () => {
  stub({ crossGameFactorPercent: 100, confirmationDriftThreshold: 0.04 });
  try {
    FAIR = 0.5;
    const q = await price([ml(), ml()], 'xgf-cf1');
    assert.strictEqual(q.xgFactorApplied, true);
    const v = await pricer.validateForConfirmation('xgf-cf1', q);
    assert.strictEqual(v.valid, true, JSON.stringify(v.reason));
    Object.assign(config.pricing, { crossGameFactorPercent: 0, twoLegFactorPercent: 100 });
    FAIR = 0.6;   // joint 36% -> 2-leg factor x1.10
    const q2 = await price([ml(), ml()], 'xgf-cf2');
    assert.strictEqual(q2.twoLegFactorApplied, true);
    const v2 = await pricer.validateForConfirmation('xgf-cf2', q2);
    assert.strictEqual(v2.valid, true, '2-leg factor arm used to reject "price drift 9.1%": ' + JSON.stringify(v2.reason));
    FAIR = 0.63;  // a real move against us (+10% on the joint) must still reject
    const v3 = await pricer.validateForConfirmation('xgf-cf2', q2);
    assert.strictEqual(v3.valid, false, 'a genuine adverse move still rejects');
  } finally { restore(); }
});
