// 2-LEG WIDEN A/B (2026-10-12). Operator: "build the 2-leg widen A/B".
// 90 days to 10/11: 2-leg parlays with joint fair in [30%, 50%) hit +16% over
// expectation (z 2.48, -$27.9K) while all legs grade calibrated (0.996) — leg
// selection beats our ~5.5% margin in that shape. Widen arm = offered prob x
// (1 + rel%), deterministic per parlayId, recorded whether or not it fires,
// ships DARK, never stacks on the CFB widen.
// Run: node --test test/two-leg-widen-ab.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUT = new Date(Date.now() + 20 * 3600e3).toISOString();
const L = {};
let seq = 0;
function ml(sport = 'baseball_mlb') {
  const id = 'tlw-' + (++seq), ev = 'TLW-E' + seq;
  L[id] = { lineId: id, sport, oddsApiSport: sport, marketType: 'moneyline', oddsApiMarket: 'h2h', teamName: 'Home ' + ev,
    selection: 'home', oddsApiSelection: 'home', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
    startTime: FUT, startTimeMs: Date.parse(FUT) };
  return id;
}
const saved = {};
let FAIR = 0.62;
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.getFairProb = () => FAIR;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 6000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    twoLegWidenPercent: 0, twoLegWidenRelPct: 7, twoLegWidenMinFair: 0.30, twoLegWidenMaxFair: 0.50, cfbWidenPercent: 0 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
async function price(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
  return r.meta;
}

test('dark by default: in-scope 2-leg tickets carry no arm and no widen', async () => {
  stub(); FAIR = 0.62;
  try {
    const m = await price([ml(), ml()], 'tlw-dark');
    assert.strictEqual(m.twoLegWidenArm, null);
    assert.strictEqual(m.twoLegWidenApplied, false);
  } finally { restore(); }
});

test('widen arm: offered x 1.07 exactly, fair untouched, control price recorded', async () => {
  FAIR = 0.62;   // joint 0.3844 — in [0.30, 0.50)
  stub({ twoLegWidenPercent: 100 });
  let w;
  try { w = await price([ml(), ml()], 'tlw-w'); } finally { restore(); }
  assert.strictEqual(w.twoLegWidenArm, 'widen');
  assert.strictEqual(w.twoLegWidenApplied, true);
  assert.ok(Math.abs(w.offeredImpliedProb / w.twoLegWidenPreProb - 1.07) < 1e-3, `ratio ${w.offeredImpliedProb / w.twoLegWidenPreProb}`);
  stub({ twoLegWidenPercent: 0 });
  let c;
  try { c = await price([ml(), ml()], 'tlw-c'); } finally { restore(); }
  assert.ok(Math.abs(c.offeredImpliedProb - w.twoLegWidenPreProb) < 1e-4, 'pre-widen price = the control price');
  assert.ok(Math.abs(c.fairParlayProb - w.fairParlayProb) < 1e-9, 'fair is untouched');
});

test('scope: 3 legs, joint fair below 30% and at/above 50% are never widened', async () => {
  for (const [fair, n] of [[0.62, 3], [0.50, 2], [0.75, 2]]) {
    FAIR = fair;
    stub({ twoLegWidenPercent: 100 });
    try {
      const ids = Array.from({ length: n }, () => ml());
      // joint >= 50% is declined outright (negative bettor odds) — also "not widened"
      const r = await pricer.priceParlay(ids, { parlayId: `tlw-s-${fair}-${n}` });
      try { orderTracker.releasePending(`tlw-s-${fair}-${n}`); } catch (_) {}
      if (r && r.meta) {
        assert.strictEqual(r.meta.twoLegWidenArm, null, `fair ${fair} legs ${n}`);
        assert.strictEqual(r.meta.twoLegWidenApplied, false);
      }
    } finally { restore(); }
  }
});

test('arm is a pure function of parlayId; both arms occur at 50%', async () => {
  FAIR = 0.62;
  stub({ twoLegWidenPercent: 50 });
  try {
    const arms = new Set();
    for (let i = 0; i < 24; i++) arms.add((await price([ml(), ml()], 'tlw-arm-' + i)).twoLegWidenArm);
    assert.deepStrictEqual([...arms].sort(), ['control', 'widen']);
    const a = (await price([ml(), ml()], 'tlw-same')).twoLegWidenArm;
    const b = (await price([ml(), ml()], 'tlw-same')).twoLegWidenArm;
    assert.strictEqual(a, b, 'same parlayId -> same arm (confirm reprice lands in the same arm)');
  } finally { restore(); }
});

test('never stacks on the CFB widen', async () => {
  FAIR = 0.62;
  stub({ twoLegWidenPercent: 100, cfbWidenPercent: 100 });
  try {
    // 2-leg all-CFB cross-game is NOT in CFB-widen scope (sgp or 4+ only), so
    // the 2-leg widen applies; a CFB-widened ticket is never widened again.
    const m = await price([ml('americanfootball_ncaaf'), ml('americanfootball_ncaaf')], 'tlw-cfb');
    assert.ok(!(m.cfbWidenApplied && m.twoLegWidenApplied), 'one widen at most');
  } finally { restore(); }
});
