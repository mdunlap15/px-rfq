// CROSS-GAME WIDEN A/B (2026-11-04). Operator: "set up the cross-game widen A/B
// at 50%" — test of "widen our spreads, win fewer fills, but win at profitable
// numbers". Widen arm = offered implied prob x (1 + crossGameWidenRelPct/100) on
// every cross-game parlay (2+ legs, no two on one event, no excluded-sport leg).
// Fair untouched, arm a pure function of parlayId, independent of the
// cross-game FACTOR arm, never stacks on a ceiling or another widen.
// Run: node --test test/cross-game-widen-ab.test.js
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
  const id = 'xgw-' + (++seq); ev = ev || ('XGW-E' + seq);
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
    legDriftCorrectionPercent: 0, footballCeilingPercent: 0, nbaCeilingPercent: 0, twoLegFactorPercent: 0, cfbWidenPercent: 0,
    crossGameFactorPercent: 0, crossGameWidenPercent: 0, crossGameWidenRelPct: 6, crossGameWidenExcludeSports: ['politics'] }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
  FAIR = 0.5;
}
let pid = 0;
async function priceRaw(ids, parlayId) {
  const r = await pricer.priceParlay(ids, parlayId === undefined ? {} : { parlayId });
  try { if (parlayId) orderTracker.releasePending(parlayId); } catch (_) {}
  return r;
}
async function price(ids, parlayId) {
  parlayId = parlayId || ('xgw-p' + (++pid));
  const r = await priceRaw(ids, parlayId);
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.getLastPriceFailure && pricer.getLastPriceFailure()));
  return r;
}

test('config defaults: LIVE at 50%, +6% relative, politics excluded; runtime keys registered', () => {
  const p = config.pricing;
  assert.deepStrictEqual([p.crossGameWidenPercent, p.crossGameWidenRelPct, p.crossGameWidenExcludeSports],
    [50, 6, ['politics']]);
  const reg = require('../services/runtime-config');
  const keys = JSON.stringify(reg.REGISTRY.map(e => e.key));
  for (const k of ['crossGameWidenPercent', 'crossGameWidenRelPct', 'crossGameWidenExcludeSports']) assert.ok(keys.includes(k), k);
});

test('dark at 0: no arm, no widen', async () => {
  stub({ crossGameWidenPercent: 0 });
  try {
    const m = (await price([ml(), ml()])).meta;
    assert.strictEqual(m.xgWidenArm, null);
    assert.strictEqual(m.xgWidenApplied, false);
  } finally { restore(); }
});

test('widen arm: offered x 1.06 exactly, published odds move with it, fair untouched, pre-widen = the control price', async () => {
  for (const n of [2, 3, 5]) {
    FAIR = 0.6;
    stub({ crossGameWidenPercent: 0 });
    let c; const ids = Array.from({ length: n }, () => ml());
    try { c = await price(ids, 'xgw-c' + n); } finally { restore(); }
    FAIR = 0.6;
    stub({ crossGameWidenPercent: 100 });
    let w;
    try { w = await price(ids, 'xgw-w' + n); } finally { restore(); }
    assert.strictEqual(w.meta.xgWidenArm, 'widen');
    assert.strictEqual(w.meta.xgWidenApplied, true);
    assert.strictEqual(w.meta.xgWidenRelPct, 6);
    assert.ok(Math.abs(w.meta.xgWidenPreProb - c.meta.offeredImpliedProb) < 1e-4, `${n}L pre-widen ${w.meta.xgWidenPreProb} vs control ${c.meta.offeredImpliedProb}`);
    assert.ok(Math.abs(w.meta.offeredImpliedProb / c.meta.offeredImpliedProb - 1.06) < 1e-3, `${n}L ratio ${w.meta.offeredImpliedProb / c.meta.offeredImpliedProb}`);
    assert.ok(Math.abs(w.meta.fairParlayProb - c.meta.fairParlayProb) < 1e-12, 'fair untouched');
    assert.ok(w.offer.odds < c.offer.odds, `published odds shorter: ${w.offer.odds} vs ${c.offer.odds}`);
  }
});

test('rel pct is read per call', async () => {
  FAIR = 0.6;
  stub({ crossGameWidenPercent: 100, crossGameWidenRelPct: 10 });
  try {
    const m = (await price([ml(), ml()])).meta;
    assert.ok(Math.abs(m.offeredImpliedProb / m.xgWidenPreProb - 1.10) < 1e-3);
  } finally { restore(); }
});

test('scope: single leg, same-game, an excluded-sport leg, no parlayId (confirm reprice) and fairOnly reads are never widened', async () => {
  stub({ crossGameWidenPercent: 100, sgpAllowedCombos: ['ml_total', 'spread_total'] });
  try {
    FAIR = 0.4;
    const one = await priceRaw([ml()], 'xgw-one');
    if (one && one.meta) assert.strictEqual(one.meta.xgWidenArm, null, 'single leg');
    FAIR = 0.5;
    const a = ml('baseball_mlb', 'XGW-SG'); const b = ml('baseball_mlb', 'XGW-SG');
    Object.assign(LINES[b], { marketType: 'total', oddsApiMarket: 'totals', selection: 'over', oddsApiSelection: 'Over', line: 8.5, teamName: 'over' });
    const sg = await priceRaw([a, b], 'xgw-sg');
    assert.ok(!sg || sg.meta.xgWidenArm == null, 'same-game out of scope');
    config.pricing.crossGameWidenExcludeSports = ['icehockey_nhl'];
    const ex = (await price([ml(), ml('icehockey_nhl')])).meta;
    assert.strictEqual(ex.xgWidenArm, null, 'excluded sport on any leg');
    config.pricing.crossGameWidenExcludeSports = ['politics'];
    const nopid = await priceRaw([ml(), ml()]);
    assert.ok(nopid && nopid.meta);
    assert.strictEqual(nopid.meta.xgWidenArm, null, 'no parlayId -> no arm (the confirm reprice)');
    const fo = await pricer.priceParlay([ml(), ml()], { parlayId: 'xgw-fo', fairOnly: true });
    assert.ok(!fo || !fo.meta || fo.meta.xgWidenArm == null, 'fairOnly (EV live) never widened');
  } finally { restore(); }
});

test('50%: both arms occur, control quotes exactly the dark price, arm is a pure function of parlayId', async () => {
  FAIR = 0.6;
  stub({ crossGameWidenPercent: 0 });
  let dark;
  const ids = [ml(), ml()];
  try { dark = (await price(ids, 'xgw-dark')).meta.offeredImpliedProb; } finally { restore(); }
  stub({ crossGameWidenPercent: 50 }); FAIR = 0.6;   // restore() reset it
  try {
    const arms = new Set();
    for (let i = 0; i < 30; i++) {
      const m = (await price(ids, 'xgw-arm-' + i)).meta;
      arms.add(m.xgWidenArm);
      if (m.xgWidenArm === 'control') {
        assert.strictEqual(m.xgWidenApplied, false);
        assert.ok(Math.abs(m.offeredImpliedProb - dark) < 1e-9, `control untouched: ${m.offeredImpliedProb} vs ${dark}`);
      } else assert.ok(Math.abs(m.offeredImpliedProb / dark - 1.06) < 1e-3, `widen ${m.offeredImpliedProb} vs ${dark}`);
    }
    assert.deepStrictEqual([...arms].sort(), ['control', 'widen']);
    const a = (await price(ids, 'xgw-same')).meta.xgWidenArm, b = (await price(ids, 'xgw-same')).meta.xgWidenArm;
    assert.strictEqual(a, b);
  } finally { restore(); }
});

test('independent of the cross-game factor arm: both apply on one ticket, widen on top of the factored price', async () => {
  FAIR = 0.5;   // joint 25%: cross-game factor in scope (>= 20%), 2-leg factor not
  stub({ crossGameWidenPercent: 0, crossGameFactorPercent: 100, crossGameFactorMult2: 1.10 });
  let f;
  try { f = (await price([ml(), ml()], 'xgw-f')).meta; } finally { restore(); }
  stub({ crossGameWidenPercent: 100, crossGameFactorPercent: 100, crossGameFactorMult2: 1.10 });
  try {
    const m = (await price([ml(), ml()], 'xgw-fw')).meta;
    assert.strictEqual(m.xgFactorApplied, true);
    assert.strictEqual(m.xgWidenApplied, true);
    assert.ok(Math.abs(m.xgWidenPreProb - f.offeredImpliedProb) < 1e-4, 'pre-widen = the factored price');
    assert.ok(Math.abs(m.offeredImpliedProb / f.offeredImpliedProb - 1.06) < 1e-3);
    // salts differ: across parlayIds the two arms are not the same assignment
    Object.assign(config.pricing, { crossGameWidenPercent: 50, crossGameFactorPercent: 50 });
    const pairs = new Set();
    for (let i = 0; i < 40; i++) { const r = (await price([ml(), ml()], 'xgw-2x2-' + i)).meta; pairs.add(r.xgFactorArm + '/' + r.xgWidenArm); }
    assert.strictEqual(pairs.size, 4, 'all four cells of the 2x2 occur: ' + [...pairs]);
  } finally { restore(); }
});

// Deferral is by SCOPE, in EITHER arm of the other experiment: at 1% the other
// experiment puts nearly every ticket in its CONTROL arm, and those must stay
// unwidened too, or that experiment's control is contaminated.
for (const [name, extra, legs, fair] of [
  ['2-leg widen', { twoLegWidenPercent: 1 }, () => [ml(), ml()], 0.62],
  ['CFB widen (4+ legs)', { cfbWidenPercent: 1 }, () => [1, 2, 3, 4].map(() => ml('americanfootball_ncaaf')), 0.8],
  ['NBA ceiling', { nbaCeilingPercent: 1 }, () => [1, 2, 3, 4].map(() => ml('basketball_nba')), 0.7],
  ['football ceiling', { footballCeilingPercent: 1 }, () => [1, 2, 3].map(() => ml('americanfootball_nfl')), 0.65],
]) {
  test(`defers to the ${name} wherever it is in scope, either arm`, async () => {
    FAIR = fair;
    stub({ crossGameWidenPercent: 100, ...extra });
    try {
      for (let i = 0; i < 6; i++) {
        const m = (await price(legs(), `xgw-def-${name}-${i}`)).meta;
        const other = m.twoLegWidenArm || m.cfbWidenArm || m.nbaCeilArm || m.fbCeilArm;
        assert.ok(other, `${name} assigned an arm`);
        assert.strictEqual(m.xgWidenArm, null, `${name} ${other} arm -> out of widen scope`);
        assert.strictEqual(m.xgWidenApplied, false);
      }
    } finally { restore(); }
  });
}

test('without a configured rel pct the arm falls back to +6%', async () => {
  FAIR = 0.6;
  stub({ crossGameWidenPercent: 100, crossGameWidenRelPct: 0 });
  try {
    const m = (await price([ml(), ml()])).meta;
    assert.strictEqual(m.xgWidenRelPct, 6);
    assert.ok(Math.abs(m.offeredImpliedProb / m.xgWidenPreProb - 1.06) < 1e-3);
  } finally { restore(); }
});

test('arm boundary: bucket == percent is CONTROL (strict <)', async () => {
  const crypto = require('crypto');
  let id = null;
  for (let i = 0; i < 5000 && !id; i++) {
    const c = 'xgw-edge-' + i;
    if (crypto.createHash('md5').update('xgw:' + c).digest().readUInt32BE(0) % 100 === 50) id = c;
  }
  assert.ok(id);
  FAIR = 0.6;
  stub({ crossGameWidenPercent: 50 });
  try { assert.strictEqual((await price([ml(), ml()], id)).meta.xgWidenArm, 'control'); } finally { restore(); }
});

test('confirm: a widened quote confirms (reprice compares fair, which the widen never touches); a real adverse move still rejects', async () => {
  FAIR = 0.6;
  stub({ crossGameWidenPercent: 100, confirmationDriftThreshold: 0.04 });
  try {
    const q = (await price([ml(), ml()], 'xgw-cf')).meta;
    assert.strictEqual(q.xgWidenApplied, true);
    const v = await pricer.validateForConfirmation('xgw-cf', q);
    assert.strictEqual(v.valid, true, JSON.stringify(v.reason));
    FAIR = 0.64;
    const v2 = await pricer.validateForConfirmation('xgw-cf', q);
    assert.strictEqual(v2.valid, false, 'adverse move rejects');
  } finally { restore(); }
});
