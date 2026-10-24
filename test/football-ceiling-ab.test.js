// FOOTBALL MULTI-LEG MARGIN CEILING A/B (2026-10-24).
//
// Operator: "narrow our margins on the sports where we are losing ... just as
// long as we are still getting positive EV." On NFL / CFB cross-game game-line
// parlays of 3+ legs the winning network price sat at fair +1-12% while ours sat
// at +5-40% (the leg-count ladder multiplies the whole margin), and our own fills
// there ran in our favour. The ceiling arm caps offered at fair x (1 + ceiling),
// never below fair x (1 + min edge), only when every leg's fair is near its book
// consensus. Ships DARK; the arm is a pure function of parlayId.
// Harness: fresh lines per call (pending exposure / template ramp key on legs).
// Run: node --test test/football-ceiling-ab.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
const NCAAF = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl';
const LINES = {};
let seq = 0;
function ml(sport, opts = {}) {
  const id = 'fbc-' + (++seq), ev = opts.ev || ('FBC-E' + seq);
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
  Object.assign(LINES[id], { marketType: 'player_pass_yds', oddsApiMarket: 'player_pass_yds', playerName: 'P' + id, selection: 'over', oddsApiSelection: 'over', line: 250.5 });
  return id;
}
const legs = (n, sport = NFL) => Array.from({ length: n }, () => ml(sport));

const saved = {};
function stub(extra = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.pin = oddsFeed.getPinnacleOdds; saved.fd = oddsFeed.getFanDuelOdds; saved.dk = oddsFeed.getDraftKingsOdds;
  saved.cfg = { ...config.pricing };
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.5;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  // Book consensus -110 on every leg (raw implied 52.38%, 2.4pp over the 50% fair) —
  // which also arms the consensus floors, as in production. A "FLIP" home team = the
  // books price that side at -120 (54.5%, 4.5pp over our fair): past the 4pp guard but
  // inside the 5pp moneyline anomaly decline, i.e. the band only the guard covers.
  const book = (sport, home) => String(home).startsWith('FLIP') ? -120 : -110;
  oddsFeed.getPinnacleOdds = book; oddsFeed.getFanDuelOdds = book; oddsFeed.getDraftKingsOdds = book;
  Object.assign(config.pricing, { maxRiskPerParlay: 3000, maxRiskPerParlayWithProp: 3000, maxOdds: 50000, obRelayEnabled: false, freshGateEnabled: false,
    cfbWidenPercent: 0, twoLegWidenPercent: 0, propBookCapPercent: 0, nbaPropEarlyGatePercent: 0, legDriftCorrectionPercent: 0,
    footballCeilingPercent: 0, footballCeiling3LegPct: 4, footballCeiling45LegPct: 6, footballCeiling6LegPct: 10,
    footballCeilingMinEdgePct: 2, footballCeilingMaxLegGapPp: 4 }, extra);
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
  pid = pid || ('fbc-p' + (++pidSeq));
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.getLastPriceFailure && pricer.getLastPriceFailure()));
  return r.meta;
}
const rel = m => m.offeredImpliedProb / m.fairParlayProb - 1;

test('config defaults: DARK; ceilings 4 / 6 / 10%, min edge 2%, guard 4pp', () => {
  const p = config.pricing;
  assert.deepStrictEqual([p.footballCeilingPercent, p.footballCeiling3LegPct, p.footballCeiling45LegPct, p.footballCeiling6LegPct, p.footballCeilingMinEdgePct, p.footballCeilingMaxLegGapPp],
    [0, 4, 6, 10, 2, 4]);
});

test('dark: an in-scope NFL 4-leg prices as today with no arm', async () => {
  stub();
  try {
    const m = await price(legs(4));
    assert.strictEqual(m.fbCeilArm, null);
    assert.strictEqual(m.fbCeilApplied, false);
    assert.ok(rel(m) > 0.06, `today's 4-leg margin ${(100 * rel(m)).toFixed(2)}% is above the 6% ceiling (else this test proves nothing)`);
  } finally { restore(); }
});

test('ceiling arm: 3 / 4 / 6 legs are capped at fair x 1.04 / 1.06 / 1.10 — more generous, fair untouched', async () => {
  stub({ footballCeilingPercent: 100 });
  try {
    for (const [n, cap] of [[3, 0.04], [4, 0.06], [6, 0.10]]) {
      const ids = legs(n, n === 4 ? NCAAF : NFL);
      const m = await price(ids);
      assert.strictEqual(m.fbCeilArm, 'ceiling', `${n} legs`);
      if (m.fbCeilApplied) {
        // published American odds round to an integer, so long parlays land a hair under the cap
        assert.ok(rel(m) <= cap + 1e-9 && rel(m) > cap - 5e-4, `${n} legs: margin ${(100 * rel(m)).toFixed(4)}% should be ~${100 * cap}%`);
        assert.ok(m.fbCeilPreProb > m.offeredImpliedProb, 'pre-ceiling price was less generous');
        assert.strictEqual(m.fbCeilPct, 100 * cap);
      } else {
        assert.ok(rel(m) <= cap + 1e-9, `${n} legs: not applied only when already inside the ceiling`);
      }
      config.pricing.footballCeilingPercent = 0;
      const dark = await price(legs(n, n === 4 ? NCAAF : NFL));
      config.pricing.footballCeilingPercent = 100;
      assert.ok(Math.abs(m.fairParlayProb - dark.fairParlayProb) < 1e-9, 'fair untouched (confirm drift keys on it)');
      // Rule 2: per-leg confirm probs still multiply to the final price
      const prod = m.legs.reduce((p, l) => p * l.legConfirmProb, 1);
      assert.ok(Math.abs(prod - m.offeredImpliedProb) < 1e-4, `Π legConfirmProb ${prod} vs ${m.offeredImpliedProb}`);
    }
    const m4 = await price(legs(4));
    assert.strictEqual(m4.fbCeilApplied, true, 'the 4-leg case must bind (today it sits above 6%)');
  } finally { restore(); }
});

test('never below fair x (1 + min edge): a 1% ceiling still quotes at +2%', async () => {
  stub({ footballCeilingPercent: 100, footballCeiling45LegPct: 1, footballCeilingMinEdgePct: 2 });
  try {
    const m = await price(legs(4));
    assert.ok(Math.abs(rel(m) - 0.02) < 1e-6, `margin ${(100 * rel(m)).toFixed(4)}%`);
  } finally { restore(); }
});

test('consensus guard: one leg whose fair is far under its books (a flipped selection) -> no ceiling', async () => {
  stub({ footballCeilingPercent: 100 });
  try {
    const ids = [ml(NFL), ml(NFL), ml(NFL, { flip: true }), ml(NFL)];
    const m = await price(ids);
    assert.strictEqual(m.fbCeilArm, 'ceiling');
    assert.strictEqual(m.fbCeilApplied, false);
    assert.strictEqual(m.fbCeilSkip, 'consensus_guard');
    assert.ok(rel(m) > 0.06, 'keeps the floor-set price');
  } finally { restore(); }
});

test('out of scope even at 100%: 2 legs, NBA, mixed NFL+CFB, a player prop, same-game', async () => {
  stub({ footballCeilingPercent: 100 });
  try {
    assert.strictEqual((await price(legs(2))).fbCeilArm, null, '2 legs');
    assert.strictEqual((await price(legs(4, 'basketball_nba'))).fbCeilArm, null, 'NBA');
    assert.strictEqual((await price([ml(NFL), ml(NFL), ml(NCAAF), ml(NCAAF)])).fbCeilArm, null, 'NFL + CFB');
    assert.strictEqual((await price([ml(NFL), ml(NFL), prop(NFL)])).fbCeilArm, null, 'prop leg');
    const ev = 'FBC-SG' + (++seq);
    const sg = [ml(NFL, { ev }), ml(NFL), ml(NFL)];
    LINES[sg[0]].marketType = 'total'; LINES[sg[0]].oddsApiMarket = 'totals'; LINES[sg[0]].selection = 'over'; LINES[sg[0]].oddsApiSelection = 'over'; LINES[sg[0]].line = 44.5;
    const sgId = ml(NFL, { ev });
    const r = await pricer.priceParlay([sg[0], sgId, sg[1], sg[2]], { parlayId: 'fbc-sgp' });
    try { orderTracker.releasePending('fbc-sgp'); } catch (_) {}
    if (r && r.meta) assert.strictEqual(r.meta.fbCeilArm, null, 'same-game');
  } finally { restore(); }
});

test('50%: both arms occur; control quotes exactly the dark price; arm is a pure function of parlayId', async () => {
  stub({ footballCeilingPercent: 50 });
  try {
    const arms = new Set();
    for (let i = 0; i < 24; i++) {
      const m = await price(legs(4), 'fbc-arm-' + i);
      arms.add(m.fbCeilArm);
      if (m.fbCeilArm === 'control') assert.ok(rel(m) > 0.06 && !m.fbCeilApplied, 'control untouched');
    }
    assert.deepStrictEqual([...arms].sort(), ['ceiling', 'control']);
    const a = await price(legs(4), 'fbc-same'), b = await price(legs(4), 'fbc-same');
    assert.strictEqual(a.fbCeilArm, b.fbCeilArm);
  } finally { restore(); }
});

test('never stacks with the CFB widen: a ceilinged CFB 4-leg is not re-widened', async () => {
  stub({ footballCeilingPercent: 100, cfbWidenPercent: 100, cfbWidenRelPct: 2 });
  try {
    const m = await price(legs(4, NCAAF));
    assert.strictEqual(m.fbCeilApplied, true);
    assert.strictEqual(m.cfbWidenApplied, false);
    assert.ok(Math.abs(rel(m) - 0.06) < 1e-6);
  } finally { restore(); }
});
