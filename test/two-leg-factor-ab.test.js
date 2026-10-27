// 2-LEG SELECTION FACTOR A/B (2026-10-26).
//
// 2-leg parlays with joint fair in [30%, 50%) hit 1.15x the product of their leg
// fairs over 30 days (z 2.2, 292 accounts) while 3+ legs graded 1.00: bettors
// select 2-leg combinations that beat the independent product. The factor arm
// multiplies the parlay FAIR and the OFFERED price by the same mult, so EV at
// fill / EV live carry the measured selection and the margin over that honest
// fair is unchanged. Ships DARK; arm is a pure function of parlayId.
// Run: node --test test/two-leg-factor-ab.test.js
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
let FAIR = 0.6;
function ml(sport = 'baseball_mlb') {
  const id = 'tlf-' + (++seq), ev = 'TLF-E' + seq;
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
    twoLegWidenPercent: 0, mlPairTrimPercent: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, legDriftCorrectionPercent: 0, footballCeilingPercent: 0,
    twoLegFactorPercent: 0, twoLegFactorMult: 1.10, twoLegFactorMinFair: 0.30, twoLegFactorMaxFair: 0.50 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
  FAIR = 0.6;
}
let pid = 0;
async function price(ids, parlayId) {
  parlayId = parlayId || ('tlf-p' + (++pid));
  const r = await pricer.priceParlay(ids, { parlayId });
  try { orderTracker.releasePending(parlayId); } catch (_) {}
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.getLastPriceFailure && pricer.getLastPriceFailure()));
  return r.meta;
}

test('config defaults: DARK, x1.10 on joint fair [0.30, 0.50)', () => {
  const p = config.pricing;
  assert.deepStrictEqual([p.twoLegFactorPercent, p.twoLegFactorMult, p.twoLegFactorMinFair, p.twoLegFactorMaxFair], [0, 1.10, 0.30, 0.50]);
});

test('factor arm: fair AND offered x1.10 vs control on the same shape; margin over the new fair unchanged', async () => {
  stub();
  try {
    const ctl = await price([ml(), ml()]);                                  // dark = control price
    assert.ok(ctl.fairParlayProb >= 0.30 && ctl.fairParlayProb < 0.50, `fixture fair ${ctl.fairParlayProb} in band`);
    assert.strictEqual(ctl.twoLegFactorArm, null);
    config.pricing.twoLegFactorPercent = 100;
    const m = await price([ml(), ml()]);
    assert.strictEqual(m.twoLegFactorArm, 'factor');
    assert.strictEqual(m.twoLegFactorApplied, true);
    assert.ok(Math.abs(m.twoLegFactorPreFair - ctl.fairParlayProb) < 1e-6, 'pre-fair = the raw product');
    assert.ok(Math.abs(m.fairParlayProb - ctl.fairParlayProb * 1.10) < 1e-6, `fair ${m.fairParlayProb} vs ${ctl.fairParlayProb * 1.10}`);
    assert.ok(Math.abs(m.offeredImpliedProb - ctl.offeredImpliedProb * 1.10) < 2e-4, `offered ${m.offeredImpliedProb} vs ${ctl.offeredImpliedProb * 1.10}`);
    assert.ok(Math.abs(m.offeredImpliedProb / m.fairParlayProb - ctl.offeredImpliedProb / ctl.fairParlayProb) < 2e-3, 'same relative margin over the (new) fair');
    const prod = m.legs.reduce((p, l) => p * l.legConfirmProb, 1);
    assert.ok(Math.abs(prod - m.offeredImpliedProb) < 1e-4, 'Rule 2: per-leg confirm probs multiply to the final price');
  } finally { restore(); }
});

test('out of scope even at 100%: joint fair below 30%, and 3 legs', async () => {
  stub({ twoLegFactorPercent: 100 });
  try {
    FAIR = 0.5;   // 0.25 joint
    assert.strictEqual((await price([ml(), ml()])).twoLegFactorArm, null, 'fair 25%');
    FAIR = 0.75;  // 3 legs 0.42 joint
    assert.strictEqual((await price([ml(), ml(), ml()])).twoLegFactorArm, null, '3 legs');
  } finally { restore(); }
});

test('50%: both arms occur, control untouched, arm is a pure function of parlayId; never stacks with the 2-leg widen', async () => {
  stub({ twoLegFactorPercent: 50 });
  try {
    const arms = new Set();
    for (let i = 0; i < 24; i++) {
      const m = await price([ml(), ml()], 'tlf-arm-' + i);
      arms.add(m.twoLegFactorArm);
      if (m.twoLegFactorArm === 'control') assert.strictEqual(m.twoLegFactorApplied, false);
    }
    assert.deepStrictEqual([...arms].sort(), ['control', 'factor']);
    const a = await price([ml(), ml()], 'tlf-same'), b = await price([ml(), ml()], 'tlf-same');
    assert.strictEqual(a.twoLegFactorArm, b.twoLegFactorArm);
    config.pricing.twoLegFactorPercent = 100; config.pricing.twoLegWidenPercent = 100;
    const w = await price([ml(), ml()]);
    assert.strictEqual(w.twoLegFactorApplied, true);
    assert.notStrictEqual(w.twoLegWidenApplied, true, 'the widen skips a factored quote');
  } finally { restore(); }
});

test('top of the band: a factored price above 50% DECLINES (negative odds) instead of quoting below the honest fair; control still quotes', async () => {
  stub();
  try {
    FAIR = Math.sqrt(0.45);   // joint fair 45% -> x1.10 = 49.5% fair, offered > 50%
    const ctl = await price([ml(), ml()]);
    assert.ok(ctl.offeredImpliedProb < 0.5, 'control quotes it today');
    config.pricing.twoLegFactorPercent = 100;
    const r = await pricer.priceParlay([ml(), ml()], { parlayId: 'tlf-top' });
    try { orderTracker.releasePending('tlf-top'); } catch (_) {}
    assert.strictEqual(r, null);
    assert.strictEqual(pricer.getLastPriceFailure().reason, 'negative odds');
  } finally { restore(); }
});
