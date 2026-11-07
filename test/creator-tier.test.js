// Per-creator ticket-size tiers (2026-11-07). Run: node --test test/creator-tier.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');
const tier = require('../services/creator-tier');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const pricer = require('../services/pricer');

const KEYS = ['creatorTierEnabled', 'creatorTierNewMaxRisk', 'creatorTierSharpMaxRisk', 'creatorTierTrustMinSettled',
  'creatorTierSharpMinN', 'creatorTierSharpZ', 'maxRiskPerParlay', 'maxOdds', 'maxExposurePerTeam', 'maxExposurePerGame',
  'maxRawExposurePerTeam'];
const saved = {};
function setCfg() {
  for (const k of KEYS) saved[k] = config.pricing[k];
  Object.assign(config.pricing, { creatorTierEnabled: true, creatorTierNewMaxRisk: 500, creatorTierSharpMaxRisk: 100,
    creatorTierTrustMinSettled: 10, creatorTierSharpMinN: 10, creatorTierSharpZ: 1.5 });
}
function restore() { for (const k of KEYS) config.pricing[k] = saved[k]; }

// n settled tickets at fair f for creator c, `hits` of which the bettor won.
function tickets(c, n, hits, f = 0.25, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({ status: i < hits ? 'settled_lost' : 'settled_won', fairParlayProb: f,
    pnl: i < hits ? -100 : 30, meta: { creatorId: c, ...(extra.meta || {}) }, legs: extra.legs || [] }));
}

test('buildStats: won/lost only, no voided leg, raw fair from a selection factor, bettor hit = settled_lost', () => {
  const st = tier.buildStats([
    ...tickets('a', 4, 1),
    { status: 'settled_push', fairParlayProb: 0.3, meta: { creatorId: 'a' } },
    { status: 'confirmed', fairParlayProb: 0.3, meta: { creatorId: 'a' } },
    ...tickets('a', 1, 1, 0.25, { legs: [{ settlementStatus: 'void' }] }),
    { status: 'settled_won', fairParlayProb: 0.33, meta: { creatorId: 'a', xgFactorApplied: true, xgFactorPreFair: 0.3 } },
    { status: 'settled_won', fairParlayProb: 0.3, meta: {} },
  ]);
  const a = st.get('a');
  assert.strictEqual(a.n, 5);
  assert.strictEqual(a.hits, 1);
  assert.ok(Math.abs(a.exp - (4 * 0.25 + 0.3)) < 1e-9, 'raw (pre-factor) fair used: ' + a.exp);
  assert.strictEqual(st.size, 1, 'no creator id = not counted');
});

test('tierFor: unknown/new capped, sharp capped harder, trusted uncapped, switch off = no cap', () => {
  setCfg();
  try {
    const st = tier.buildStats([
      ...tickets('new', 9, 2),
      ...tickets('fair', 40, 10),          // hits = expected -> trusted
      ...tickets('sharp', 20, 12),         // 12 vs 5 expected, z ~ 3.6
      ...tickets('lucky', 9, 9),           // hot but too few to judge -> still just new
    ]);
    assert.deepStrictEqual([tier.tierFor(null, st).tier, tier.tierFor(null, st).cap], ['unknown', 500]);
    assert.deepStrictEqual([tier.tierFor('never', st).tier, tier.tierFor('never', st).cap], ['new', 500]);
    assert.deepStrictEqual([tier.tierFor('new', st).tier, tier.tierFor('new', st).cap], ['new', 500]);
    assert.deepStrictEqual([tier.tierFor('lucky', st).tier, tier.tierFor('lucky', st).cap], ['new', 500]);
    assert.deepStrictEqual([tier.tierFor('fair', st).tier, tier.tierFor('fair', st).cap], ['trusted', Infinity]);
    assert.deepStrictEqual([tier.tierFor('sharp', st).tier, tier.tierFor('sharp', st).cap], ['sharp', 100]);
    config.pricing.creatorTierSharpZ = 5;
    assert.strictEqual(tier.tierFor('sharp', st).tier, 'trusted', 'z threshold is read live');
    config.pricing.creatorTierEnabled = false;
    assert.strictEqual(tier.tierFor(null, st).cap, Infinity);
  } finally { restore(); }
});

// --- priceParlay integration: the tier reaches the offer's max_risk, never the confirm reprice ---
const START = new Date(Date.now() + 6 * 3600e3).toISOString();
const LINES = {};
function mkLine(ev) {
  const id = 'ct-line-' + ev;
  LINES[id] = { lineId: id, sport: 'baseball_mlb', marketType: 'moneyline', teamName: 'Home ' + ev, selection: 'home',
    oddsApiSelection: 'home', oddsApiMarket: 'h2h', oddsApiSport: 'baseball_mlb', homeTeam: 'Home ' + ev,
    awayTeam: 'Away ' + ev, pxEventId: ev, startTime: START, startTimeMs: Date.parse(START) };
  return id;
}

test('priceParlay: known new/sharp creator caps max_risk; trusted and unknown do not; reprice ignores it', async () => {
  setCfg();
  const s = { lookup: lineManager.lookupLine, fair: oddsFeed.getFairProb, stale: oddsFeed.isStaleForEvent, pre: oddsFeed.isEventStalePreGame };
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.4;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { maxRiskPerParlay: 3000, maxOdds: 50000, maxExposurePerTeam: 1e9, maxExposurePerGame: 1e9, maxRawExposurePerTeam: 1e9 });
  tier.__setStatsForTest(tier.buildStats([...tickets('ok', 40, 10), ...tickets('shp', 20, 12)]));
  try {
    const ids = [mkLine('CT1'), mkLine('CT2')];
    const q = async (o) => { const r = await pricer.priceParlay(ids, o); assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure)); return r.meta; };
    const nw = await q({ parlayId: 'ct-new', creatorId: 'brand-new' });
    assert.ok(nw.maxRisk <= 500 + 1e-6, 'new creator capped at 500, got ' + nw.maxRisk);
    assert.strictEqual(nw.creatorTier.tier, 'new');
    const sh = await q({ parlayId: 'ct-shp', creatorId: 'shp' });
    assert.ok(sh.maxRisk <= 100 + 1e-6, 'sharp creator capped at 100, got ' + sh.maxRisk);
    const ok = await q({ parlayId: 'ct-ok', creatorId: 'ok' });
    assert.strictEqual(ok.maxRisk, 3000, 'trusted creator keeps the configured cap');
    const unk = await q({ parlayId: 'ct-unk' });
    assert.strictEqual(unk.maxRisk, 3000, 'unknown at quote time is sized at confirm, not here');
    assert.strictEqual(unk.creatorTier, null);
    const rep = await q({ skipTemplateRamp: true, creatorId: 'brand-new' });
    assert.strictEqual(rep.maxRisk, 3000, 'the confirm reprice never applies the tier');
  } finally {
    lineManager.lookupLine = s.lookup; oddsFeed.getFairProb = s.fair; oddsFeed.isStaleForEvent = s.stale;
    if (s.pre) oddsFeed.isEventStalePreGame = s.pre;
    for (const id of Object.keys(LINES)) { try { require('../services/order-tracker').releaseQuoteReservations(id); } catch (_) {} }
    restore();
  }
});
