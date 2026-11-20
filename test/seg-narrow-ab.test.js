// SEGMENT NARROW A/B (2026-11-20). Operator: "we can safely narrow some of our
// margins in places to pick up a little more volume incrementally while still at
// good margins" -> "Yes" to three scopes (CFB 2-3 leg cross-game, 3+ leg same-game
// ex-NFL, NBA/NCAAB 2-3 leg cross-game). Narrow arm caps offered at RAW fair x
// (1 + segNarrowRelPct/100), AFTER the calibration floor (which would otherwise
// re-raise it), only more generous, only when every leg sits near its book
// consensus. Fair untouched; arm a pure function of parlayId.
// Run: node --test test/seg-narrow-ab.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');
config.pricing.obParityEnabled = false;   // order-book parity has its own tests (test/ob-parity.test.js)

const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const NCAAF = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl', NBA = 'basketball_nba', NCAAB = 'basketball_ncaab', MLB = 'baseball_mlb';
const LINES = {};
let seq = 0;
function ml(sport, opts = {}) {
  const id = 'sgn-' + (++seq), ev = opts.ev || ('SGN-E' + seq);
  LINES[id] = { lineId: id, sport, oddsApiSport: sport, marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
    homeTeam: (opts.flip ? 'FLIP ' : 'Home ') + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
    startTime: FUTURE, startTimeMs: Date.parse(FUTURE) };
  return id;
}
function total(sport, ev) {
  const id = ml(sport, { ev });
  Object.assign(LINES[id], { marketType: 'total', oddsApiMarket: 'totals', selection: 'over', oddsApiSelection: 'Over', line: 8.5, teamName: 'over' });
  return id;
}
function prop(sport) {
  const id = ml(sport);
  Object.assign(LINES[id], { marketType: 'player_pass_yds', oddsApiMarket: 'player_pass_yds', playerName: 'P' + id, selection: 'over', oddsApiSelection: 'over', line: 250.5 });
  return id;
}
const legs = (n, sport) => Array.from({ length: n }, () => ml(sport));

const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.pin = oddsFeed.getPinnacleOdds; saved.fd = oddsFeed.getFanDuelOdds; saved.dk = oddsFeed.getDraftKingsOdds;
  saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.5;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  // Books at -110 (52.4%, 2.4pp over the 50% fair). A "FLIP" home team = -120
  // (54.5%, 4.5pp over our fair): past the 4pp consensus guard.
  const book = (sport, home) => String(home).startsWith('FLIP') ? -120 : -110;
  oddsFeed.getPinnacleOdds = book; oddsFeed.getFanDuelOdds = book; oddsFeed.getDraftKingsOdds = book;
  Object.assign(config.pricing, { maxRiskPerParlay: 3000, maxRiskPerParlayWithProp: 3000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    cfbWidenPercent: 0, twoLegWidenPercent: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, nhlPropEarlyGatePercent: 0, legDriftCorrectionPercent: 0,
    footballCeilingPercent: 0, nbaCeilingPercent: 0, twoLegFactorPercent: 0, crossGameFactorPercent: 0, crossGameWidenPercent: 0,
    twoLegBookMatchPercent: 0, xgBookMatchPercent: 0, mlPairTrimPercent: 0, minTheoEdgePct: 0,
    // Calibration ON with an empty book = the 1.10 floor x (1 + 3%): the control
    // price this test narrows, exactly as in production since 11/17.
    calibEnabled: true, calibFloorMult: 1.10, calibFloorMultProp: 1.04, calibMinMarginPct: 3,
    sgpAllowedCombos: ['ml_total', 'spread_total'], sgpBlockedSports: [],
    segNarrowPercent: 0, segNarrowRelPct: 8, segNarrowScopes: ['cfb_xg', 'sgp3', 'bball_xg'], segNarrowMaxLegGapPp: 4 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  oddsFeed.getPinnacleOdds = saved.pin; oddsFeed.getFanDuelOdds = saved.fd; oddsFeed.getDraftKingsOdds = saved.dk;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
let pidSeq = 0;
async function priceRaw(ids, pid, extraOpts = {}) {
  const r = await pricer.priceParlay(ids, pid === undefined ? { ...extraOpts } : { parlayId: pid, ...extraOpts });
  try { if (pid) orderTracker.releasePending(pid); } catch (_) {}
  return r;
}
async function price(ids, pid) {
  pid = pid || ('sgn-p' + (++pidSeq));
  const r = await priceRaw(ids, pid);
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.getLastPriceFailure && pricer.getLastPriceFailure()));
  return r;
}
// Control vs narrow on the SAME legs (fresh pending state per call).
async function pair(ids, tag, extra = {}) {
  stub({ ...extra, segNarrowPercent: 0 });
  let c; try { c = await price(ids, 'sgn-c-' + tag); } finally { restore(); }
  stub({ ...extra, segNarrowPercent: 100 });
  let w; try { w = await price(ids, 'sgn-n-' + tag); } finally { restore(); }
  return { c, w };
}
const rawOf = m => (m.xgFactorApplied && m.xgFactorPreFair > 0 ? m.xgFactorPreFair
  : m.twoLegFactorApplied && m.twoLegFactorPreFair > 0 ? m.twoLegFactorPreFair : m.fairParlayProb);

test('config defaults: LIVE at 50%, raw fair +8%, three scopes, 4pp guard; runtime keys registered', () => {
  const p = config.pricing;
  assert.deepStrictEqual([p.segNarrowPercent, p.segNarrowRelPct, p.segNarrowScopes, p.segNarrowMaxLegGapPp],
    [50, 8, ['cfb_xg', 'sgp3', 'bball_xg'], 4]);
  const reg = require('../services/runtime-config');
  const keys = reg.REGISTRY.map(e => e.key);
  for (const k of ['segNarrowPercent', 'segNarrowRelPct', 'segNarrowScopes', 'segNarrowMaxLegGapPp']) assert.ok(keys.includes(k), k);
});

test('dark at 0: no arm, no cap', async () => {
  stub();
  try {
    const m = (await price(legs(2, NCAAF))).meta;
    assert.strictEqual(m.segNarrowArm, null);
    assert.strictEqual(m.segNarrowApplied, false);
  } finally { restore(); }
});

test('cfb_xg 2 and 3 legs: narrow arm undercuts the calibration floor to exactly raw fair x 1.08; control = the calibrated price; fair untouched', async () => {
  for (const n of [2, 3]) {
    const { c, w } = await pair(legs(n, NCAAF), 'cfb' + n);
    const raw = rawOf(c.meta);
    assert.ok(c.meta.calib && c.meta.calib.applied, `${n}L control is priced by the calibration floor`);
    assert.ok(Math.abs(c.meta.offeredImpliedProb / raw - 1.10 * 1.03) < 2e-3, `${n}L control ${c.meta.offeredImpliedProb / raw}`);
    assert.strictEqual(w.meta.segNarrowArm, 'narrow');
    assert.strictEqual(w.meta.segNarrowScope, 'cfb_xg');
    assert.strictEqual(w.meta.segNarrowApplied, true);
    assert.strictEqual(w.meta.segNarrowRelPct, 8);
    assert.ok(Math.abs(w.meta.offeredImpliedProb / raw - 1.08) < 1e-3, `${n}L narrow ${w.meta.offeredImpliedProb / raw}`);
    assert.ok(Math.abs(w.meta.segNarrowPreProb - c.meta.offeredImpliedProb) < 1e-4, 'preProb = the control price');
    assert.ok(Math.abs(w.meta.fairParlayProb - c.meta.fairParlayProb) < 1e-12, 'fair untouched');
    assert.ok(w.offer.odds > c.offer.odds, `published odds longer: ${w.offer.odds} vs ${c.offer.odds}`);
    assert.strictEqual(c.meta.segNarrowArm, null, 'dark control carries no arm');
  }
});

test('bball_xg: NBA + NCAAB mix is in scope; under a selection factor the cap is off the RAW fair and the theo-edge gate reads raw', async () => {
  const { c, w } = await pair([ml(NBA), ml(NCAAB)], 'bb', { crossGameFactorPercent: 100, crossGameFactorExcludeSports: ['politics'], minTheoEdgePct: 1.2 });
  assert.strictEqual(w.meta.segNarrowScope, 'bball_xg');
  assert.strictEqual(w.meta.xgFactorApplied, true, 'factor applied (fair x 1.10)');
  const raw = w.meta.xgFactorPreFair;
  assert.ok(Math.abs(w.meta.offeredImpliedProb / raw - 1.08) < 1e-3, `narrow off raw: ${w.meta.offeredImpliedProb / raw}`);
  assert.ok(w.meta.offeredImpliedProb < w.meta.fairParlayProb, 'below the factored fair, yet not declined by the edge gate');
  assert.ok(c.meta.offeredImpliedProb > w.meta.offeredImpliedProb);
});

test('sgp3: 3 legs with a same-game pair (no NFL) is in scope; an NFL leg or only 2 legs is not', async () => {
  const a = ml(MLB, { ev: 'SGN-SG1' }), b = total(MLB, 'SGN-SG1');
  const { c, w } = await pair([a, b, ml(NCAAF)], 'sgp3');
  assert.strictEqual(w.meta.segNarrowScope, 'sgp3');
  assert.strictEqual(w.meta.segNarrowApplied, true);
  assert.ok(Math.abs(w.meta.offeredImpliedProb / w.meta.fairParlayProb - 1.08) < 1e-3, 'cap off the correlated SGP fair');
  assert.ok(c.meta.offeredImpliedProb > w.meta.offeredImpliedProb);
  stub({ segNarrowPercent: 100 });
  try {
    const a2 = ml(MLB, { ev: 'SGN-SG2' }), b2 = total(MLB, 'SGN-SG2');
    const withNfl = await priceRaw([a2, b2, ml(NFL)], 'sgn-sgnfl');
    assert.ok(withNfl && withNfl.meta && withNfl.meta.segNarrowArm == null, 'any NFL leg -> out of scope');
    const a3 = ml(MLB, { ev: 'SGN-SG3' }), b3 = total(MLB, 'SGN-SG3');
    const two = await priceRaw([a3, b3], 'sgn-sg2');
    assert.ok(!two || !two.meta || two.meta.segNarrowArm == null, '2-leg same-game -> out of scope');
  } finally { restore(); }
});

test('out of scope: NFL, 4+ legs, a prop leg, a mixed sport, a scope not listed, no parlayId (confirm reprice), fairOnly', async () => {
  stub({ segNarrowPercent: 100 });
  try {
    const none = async (ids, label, pid) => {
      const r = await priceRaw(ids, pid === undefined ? 'sgn-o' + (++pidSeq) : pid);
      assert.ok(r && r.meta, label + ' must price');
      assert.strictEqual(r.meta.segNarrowArm, null, label);
      assert.strictEqual(r.meta.segNarrowApplied, false, label);
    };
    await none(legs(2, NFL), 'NFL cross-game');
    await none(legs(4, NCAAF), 'CFB 4 legs');
    await none([ml(NCAAF), prop(NCAAF)], 'CFB with a prop leg');
    await none([ml(NCAAF), ml(MLB)], 'CFB + MLB');
    await none([ml(NBA), ml(NBA), ml(NBA), ml(NBA)], 'NBA 4 legs');
    config.pricing.segNarrowScopes = ['sgp3'];
    await none(legs(2, NCAAF), 'cfb_xg removed from the scope list');
    config.pricing.segNarrowScopes = ['cfb_xg', 'sgp3', 'bball_xg'];
    await none(legs(2, NCAAF), 'no parlayId', null);
    const fo = await pricer.priceParlay(legs(2, NCAAF), { parlayId: 'sgn-fo', fairOnly: true });
    assert.ok(!fo || !fo.meta || fo.meta.segNarrowArm == null, 'fairOnly never narrowed');
  } finally { restore(); }
});

test('consensus guard: a leg whose books sit > 4pp over our fair keeps the control price', async () => {
  const ids = [ml(NCAAF, { flip: true }), ml(NCAAF)];
  const { c, w } = await pair(ids, 'guard');
  assert.strictEqual(w.meta.segNarrowArm, 'narrow');
  assert.strictEqual(w.meta.segNarrowSkip, 'consensus_guard');
  assert.strictEqual(w.meta.segNarrowApplied, false);
  assert.ok(Math.abs(w.meta.offeredImpliedProb - c.meta.offeredImpliedProb) < 1e-9);
});

test('only ever more generous: a control price already under the cap is left alone', async () => {
  const { c, w } = await pair(legs(2, NCAAF), 'under', { calibEnabled: false, segNarrowRelPct: 20 });
  assert.strictEqual(w.meta.segNarrowArm, 'narrow');
  assert.strictEqual(w.meta.segNarrowApplied, false);
  assert.ok(Math.abs(w.meta.offeredImpliedProb - c.meta.offeredImpliedProb) < 1e-9);
});

test('50%: both arms occur, control quotes the dark price, arm is a pure function of parlayId', async () => {
  const ids = legs(2, NCAAF);
  stub();
  let dark; try { dark = (await price(ids, 'sgn-dark')).meta.offeredImpliedProb; } finally { restore(); }
  stub({ segNarrowPercent: 50 });
  try {
    const seen = { control: 0, narrow: 0 };
    for (let i = 0; i < 40; i++) {
      const m = (await price(ids, 'sgn-50-' + i)).meta;
      seen[m.segNarrowArm]++;
      if (m.segNarrowArm === 'control') assert.ok(Math.abs(m.offeredImpliedProb - dark) < 1e-9, 'control = dark price');
      const again = (await price(ids, 'sgn-50-' + i)).meta;
      assert.strictEqual(again.segNarrowArm, m.segNarrowArm, 'same parlayId -> same arm');
    }
    assert.ok(seen.control > 5 && seen.narrow > 5, JSON.stringify(seen));
  } finally { restore(); }
});

test('/ab-arm-metrics accepts the arm key', () => {
  const ab = require('../services/ab-arm-metrics');
  const out = ab.summarizeArms([{ status: 'quoted', fair_parlay_prob: 0.25, meta: { segNarrowArm: 'narrow', offeredImpliedProb: 0.27 } }], 'segNarrowArm');
  assert.ok(out.narrow || (out.arms && out.arms.narrow), JSON.stringify(out).slice(0, 200));
});
