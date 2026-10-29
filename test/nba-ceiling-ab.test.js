// NBA MULTI-LEG MARGIN CEILING A/B (2026-10-28).
//
// The football ceiling (test/football-ceiling-ab.test.js) applied to NBA
// cross-game game-line parlays. Measured 10/21-10/27 on network fills: winners
// at fair +0.4% / +1.4% / +3.0% (3 / 4-5 / 6+ legs) vs ours +5.0% / +7.9% /
// +22.6%. No NBA calibration yet this season, so scope starts at 4 legs and the
// same consensus guard applies. Ships DARK; the arm is a pure function of parlayId.
// Run: node --test test/nba-ceiling-ab.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const NBA = 'basketball_nba', NFL = 'americanfootball_nfl';
const LINES = {};
let seq = 0;
function ml(sport, opts = {}) {
  const id = 'nbac-' + (++seq), ev = opts.ev || ('NBAC-E' + seq);
  LINES[id] = {
    lineId: id, sport, oddsApiSport: sport, marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
    homeTeam: (opts.flip ? 'FLIP ' : 'Home ') + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
    startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
  };
  return id;
}
function prop(sport) {
  const id = ml(sport);
  Object.assign(LINES[id], { marketType: 'player_points', oddsApiMarket: 'player_points', playerName: 'P' + id, selection: 'over', oddsApiSelection: 'over', line: 22.5 });
  return id;
}
const legs = (n, sport = NBA) => Array.from({ length: n }, () => ml(sport));

const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.pin = oddsFeed.getPinnacleOdds; saved.fd = oddsFeed.getFanDuelOdds; saved.dk = oddsFeed.getDraftKingsOdds;
  saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.5;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  // -110 consensus on every leg (2.4pp over the 50% fair); "FLIP" = -120 (4.5pp,
  // past the 4pp guard, inside the 5pp moneyline anomaly decline).
  const book = (sport, home) => String(home).startsWith('FLIP') ? -120 : -110;
  oddsFeed.getPinnacleOdds = book; oddsFeed.getFanDuelOdds = book; oddsFeed.getDraftKingsOdds = book;
  Object.assign(config.pricing, { maxRiskPerParlay: 3000, maxRiskPerParlayWithProp: 3000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    cfbWidenPercent: 0, twoLegWidenPercent: 0, twoLegFactorPercent: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, legDriftCorrectionPercent: 0,
    footballCeilingPercent: 0,
    nbaCeilingPercent: 0, nbaCeilingMinLegs: 4, nbaCeiling3LegPct: 3, nbaCeiling45LegPct: 4, nbaCeiling6LegPct: 8,
    nbaCeilingMinEdgePct: 2, nbaCeilingMaxLegGapPp: 4 }, extra);
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
  oddsFeed.getPinnacleOdds = saved.pin; oddsFeed.getFanDuelOdds = saved.fd; oddsFeed.getDraftKingsOdds = saved.dk;
  for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
  Object.assign(config.pricing, saved.cfg);
}
let pidSeq = 0;
async function price(ids, pid) {
  pid = pid || ('nbac-p' + (++pidSeq));
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.getLastPriceFailure && pricer.getLastPriceFailure()));
  return r.meta;
}
const rel = m => m.offeredImpliedProb / m.fairParlayProb - 1;

test('config defaults: DARK; min 4 legs; ceilings 3 / 4 / 8%, min edge 2%, guard 4pp', () => {
  const p = config.pricing;
  assert.deepStrictEqual([p.nbaCeilingPercent, p.nbaCeilingMinLegs, p.nbaCeiling3LegPct, p.nbaCeiling45LegPct, p.nbaCeiling6LegPct, p.nbaCeilingMinEdgePct, p.nbaCeilingMaxLegGapPp],
    [0, 4, 3, 4, 8, 2, 4]);
});

test('dark: an in-scope NBA 4-leg prices as today with no arm', async () => {
  stub();
  try {
    const m = await price(legs(4));
    assert.strictEqual(m.nbaCeilArm, null);
    assert.strictEqual(m.nbaCeilApplied, false);
    assert.ok(rel(m) > 0.04, `today's 4-leg margin ${(100 * rel(m)).toFixed(2)}% is above the 4% ceiling (else this test proves nothing)`);
  } finally { restore(); }
});

test('ceiling arm: 4 / 5 / 6 legs are capped at fair x 1.04 / 1.04 / 1.08 — more generous, fair untouched, Rule 2 holds', async () => {
  stub({ nbaCeilingPercent: 100 });
  try {
    for (const [n, cap] of [[4, 0.04], [5, 0.04], [6, 0.08]]) {
      const m = await price(legs(n));
      assert.strictEqual(m.nbaCeilArm, 'ceiling', `${n} legs`);
      assert.strictEqual(m.nbaCeilApplied, true, `${n} legs must bind (today's margin is above the cap)`);
      assert.ok(rel(m) <= cap + 1e-9 && rel(m) > cap - 5e-4, `${n} legs: margin ${(100 * rel(m)).toFixed(4)}% should be ~${100 * cap}%`);
      assert.ok(m.nbaCeilPreProb > m.offeredImpliedProb, 'pre-ceiling price was less generous');
      assert.strictEqual(m.nbaCeilPct, 100 * cap);
      config.pricing.nbaCeilingPercent = 0;
      const dark = await price(legs(n));
      config.pricing.nbaCeilingPercent = 100;
      assert.ok(Math.abs(m.fairParlayProb - dark.fairParlayProb) < 1e-9, 'fair untouched (confirm drift keys on it)');
      const prod = m.legs.reduce((p, l) => p * l.legConfirmProb, 1);
      assert.ok(Math.abs(prod - m.offeredImpliedProb) < 1e-4, `Π legConfirmProb ${prod} vs ${m.offeredImpliedProb}`);
    }
  } finally { restore(); }
});

test('3 legs: out of scope at the default min of 4; in scope at 3% when min legs = 3', async () => {
  stub({ nbaCeilingPercent: 100 });
  try {
    assert.strictEqual((await price(legs(3))).nbaCeilArm, null);
    config.pricing.nbaCeilingMinLegs = 3;
    const m = await price(legs(3));
    assert.strictEqual(m.nbaCeilArm, 'ceiling');
    if (m.nbaCeilApplied) assert.ok(Math.abs(rel(m) - 0.03) < 5e-4, `margin ${(100 * rel(m)).toFixed(4)}%`);
    else assert.ok(rel(m) <= 0.03 + 1e-9);
  } finally { restore(); }
});

test('never below fair x (1 + min edge): a 1% ceiling still quotes at +2%', async () => {
  stub({ nbaCeilingPercent: 100, nbaCeiling45LegPct: 1, nbaCeilingMinEdgePct: 2 });
  try {
    const m = await price(legs(4));
    assert.ok(Math.abs(rel(m) - 0.02) < 1e-6, `margin ${(100 * rel(m)).toFixed(4)}%`);
  } finally { restore(); }
});

test('consensus guard: one leg whose fair is far under its books -> no ceiling', async () => {
  stub({ nbaCeilingPercent: 100 });
  try {
    const m = await price([ml(NBA), ml(NBA), ml(NBA, { flip: true }), ml(NBA)]);
    assert.strictEqual(m.nbaCeilArm, 'ceiling');
    assert.strictEqual(m.nbaCeilApplied, false);
    assert.strictEqual(m.nbaCeilSkip, 'consensus_guard');
    assert.ok(rel(m) > 0.04, 'keeps the floor-set price');
  } finally { restore(); }
});

test('out of scope even at 100%: NFL, NBA+NFL mix, a player prop, same-game', async () => {
  stub({ nbaCeilingPercent: 100 });
  try {
    assert.strictEqual((await price(legs(4, NFL))).nbaCeilArm, null, 'NFL');
    assert.strictEqual((await price([ml(NBA), ml(NBA), ml(NBA), ml(NFL)])).nbaCeilArm, null, 'NBA + NFL');
    assert.strictEqual((await price([ml(NBA), ml(NBA), ml(NBA), prop(NBA)])).nbaCeilArm, null, 'prop leg');
    const ev = 'NBAC-SG' + (++seq);
    const tot = ml(NBA, { ev });
    Object.assign(LINES[tot], { marketType: 'total', oddsApiMarket: 'totals', selection: 'over', oddsApiSelection: 'over', line: 224.5 });
    const r = await pricer.priceParlay([tot, ml(NBA, { ev }), ml(NBA), ml(NBA)], { parlayId: 'nbac-sgp' });
    try { orderTracker.releasePending('nbac-sgp'); } catch (_) {}
    if (r && r.meta) assert.strictEqual(r.meta.nbaCeilArm, null, 'same-game');
  } finally { restore(); }
});

test('50%: both arms occur; control quotes exactly the dark price; arm is a pure function of parlayId', async () => {
  stub();
  try {
    const darkRel = rel(await price(legs(4)));
    config.pricing.nbaCeilingPercent = 50;
    const arms = new Set();
    for (let i = 0; i < 24; i++) {
      const m = await price(legs(4), 'nbac-arm-' + i);
      arms.add(m.nbaCeilArm);
      if (m.nbaCeilArm === 'control') assert.ok(Math.abs(rel(m) - darkRel) < 1e-9 && !m.nbaCeilApplied, 'control untouched');
    }
    assert.deepStrictEqual([...arms].sort(), ['ceiling', 'control']);
    const a = await price(legs(4), 'nbac-same'), b = await price(legs(4), 'nbac-same');
    assert.strictEqual(a.nbaCeilArm, b.nbaCeilArm);
  } finally { restore(); }
});

test('independent of the football ceiling: an NBA 4-leg gets no football arm and vice versa', async () => {
  stub({ nbaCeilingPercent: 100, footballCeilingPercent: 100 });
  try {
    const n = await price(legs(4));
    assert.strictEqual(n.fbCeilArm, null);
    assert.strictEqual(n.nbaCeilArm, 'ceiling');
    const f = await price(legs(4, NFL));
    assert.strictEqual(f.nbaCeilArm, null);
    assert.strictEqual(f.fbCeilArm, 'ceiling');
  } finally { restore(); }
});
