// CFB MARGIN-WIDEN A/B (2026-10-05).
//
// The football deep-dive (10/5) found the core NFL / CFB cross-game book priced
// AT the field — consensus floor, frequent exact ties, losses 7-8% relative
// behind — so widening there loses more than it earns. Two CFB buckets were the
// exception: same-game parlays (modelled EV rises with price) and 4+ leg
// parlays (thinnest margin, realized ~0%). This arm adds a RELATIVE margin to
// those quotes only, deterministic per parlayId, recorded whether or not it
// fires. Ships DARK.
//
// Harness note (as ml-pair-trim): priceParlay registers pending exposure and the
// template ramp keys on the leg signature, so loops use fresh lines.
// Run: node --test test/cfb-widen-ab.test.js

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
function ml(id, ev, sport = NCAAF) {
  LINES[id] = {
    lineId: id, sport, oddsApiSport: sport, marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
    homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
    startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
  };
  return id;
}
function sgpPair(key) {
  const ev = 'G-' + key;
  const base = { sport: NCAAF, oddsApiSport: NCAAF, pxEventId: ev, homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE) };
  LINES[key + '-s'] = { ...base, lineId: key + '-s', marketType: 'spread', oddsApiMarket: 'spreads', teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home', line: -3.5, marketName: 'Spread' };
  LINES[key + '-t'] = { ...base, lineId: key + '-t', marketType: 'total', oddsApiMarket: 'totals', selection: 'over', oddsApiSelection: 'over', teamName: 'over', line: 51.5, marketName: 'Total Points' };
  return [key + '-s', key + '-t'];
}
const legs4 = (k, sport = NCAAF) => [0, 1, 2, 3].map(i => ml(`${k}-${i}`, `${k}-E${i}`, sport));

const saved = {};
function stub() {
  saved.lookup = lineManager.lookupLine;
  saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent;
  saved.stalePre = oddsFeed.isEventStalePreGame;
  saved.cap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds;
  saved.pct = config.pricing.cfbWidenPercent;
  saved.rel = config.pricing.cfbWidenRelPct;
  saved.fsgp = config.pricing.footballSgpEnabled;
  saved.combos = config.pricing.sgpAllowedCombos;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.5;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlay = 3000;
  config.pricing.maxOdds = 50000;
  config.pricing.footballSgpEnabled = true;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
}
function restore() {
  lineManager.lookupLine = saved.lookup;
  oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale;
  if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.maxRiskPerParlay = saved.cap;
  config.pricing.maxOdds = saved.maxOdds;
  config.pricing.cfbWidenPercent = saved.pct;
  config.pricing.cfbWidenRelPct = saved.rel;
  config.pricing.footballSgpEnabled = saved.fsgp;
  config.pricing.sgpAllowedCombos = saved.combos;
}
async function price(ids, parlayId, pct, rel) {
  config.pricing.cfbWidenPercent = pct;
  if (rel != null) config.pricing.cfbWidenRelPct = rel;
  const res = await pricer.priceParlay(ids, parlayId ? { parlayId } : {});
  try { if (parlayId) orderTracker.releasePending(parlayId); } catch (_) { /* best effort */ }
  assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
  return res.meta;
}

test('config defaults: DARK, +2% relative', () => {
  assert.strictEqual(config.pricing.cfbWidenPercent, 0, 'ships dark');
  assert.strictEqual(config.pricing.cfbWidenRelPct, 2);
});

test('dark: in-scope CFB 4-leg gets no arm and an untouched price', async () => {
  stub();
  try {
    const m = await price(legs4('dark'), 'w-dark', 0);
    assert.strictEqual(m.cfbWidenArm, null);
    assert.strictEqual(m.cfbWidenApplied, false);
  } finally { restore(); }
});

test('widen arm, 4+ legs: offered = control price × (1 + rel), LESS generous, fair untouched', async () => {
  stub();
  try {
    const ctl = await price(legs4('ctl'), 'w-ctl', 0);
    const m = await price(legs4('wid'), 'w-wid', 100, 3);
    assert.strictEqual(m.cfbWidenArm, 'widen');
    assert.strictEqual(m.cfbWidenScope, 'legs4plus');
    assert.strictEqual(m.cfbWidenApplied, true);
    assert.strictEqual(m.cfbWidenRelPct, 3);
    assert.ok(Math.abs(m.cfbWidenPreProb - ctl.offeredImpliedProb) < 2e-5, 'pre-price = what control would quote');
    assert.ok(Math.abs(m.offeredImpliedProb - m.cfbWidenPreProb * 1.03) < 2e-5,
      `offered ${m.offeredImpliedProb} should be ${(m.cfbWidenPreProb * 1.03).toFixed(5)}`);
    assert.ok(m.offeredImpliedProb > ctl.offeredImpliedProb, 'shorter odds for the bettor');
    assert.ok(Math.abs(m.fairParlayProb - ctl.fairParlayProb) < 1e-9, 'fair untouched (confirm drift keys on it)');
    assert.ok(m.americanOdds < ctl.americanOdds, 'published odds are shorter');
  } finally { restore(); }
});

test('widen arm, same-game CFB spread + total: scope "sgp"', async () => {
  stub();
  try {
    const m = await price(sgpPair('sg1'), 'w-sgp', 100, 2);
    assert.strictEqual(m.cfbWidenScope, 'sgp');
    assert.strictEqual(m.cfbWidenArm, 'widen');
    assert.strictEqual(m.cfbWidenApplied, true);
    assert.ok(Math.abs(m.offeredImpliedProb - m.cfbWidenPreProb * 1.02) < 2e-5);
  } finally { restore(); }
});

test('Rule 2 still reconciles: Π per-leg confirm prob = the widened parlay price', async () => {
  stub();
  try {
    const m = await price(legs4('r2'), 'w-r2', 100, 2);
    const prod = m.legs.reduce((p, l) => p * l.legConfirmProb, 1);
    assert.ok(Math.abs(prod - m.offeredImpliedProb) < 1e-4, `Π legConfirmProb ${prod} vs offered ${m.offeredImpliedProb}`);
  } finally { restore(); }
});

test('OUT OF SCOPE even at 100%: CFB 2- and 3-leg cross-game, NFL 4-leg, mixed CFB+NFL 4-leg', async () => {
  stub();
  try {
    const cases = {
      'CFB 2-leg cross-game': [ml('o2a', 'O2a'), ml('o2b', 'O2b')],
      'CFB 3-leg cross-game': [ml('o3a', 'O3a'), ml('o3b', 'O3b'), ml('o3c', 'O3c')],
      'NFL 4-leg': legs4('onfl', NFL),
      'mixed CFB+NFL 4-leg': [ml('om1', 'OM1'), ml('om2', 'OM2'), ml('om3', 'OM3'), ml('om4', 'OM4', NFL)],
    };
    for (const [label, ids] of Object.entries(cases)) {
      const m = await price(ids, 'w-oos-' + label.replace(/\W+/g, '-'), 100, 5);
      assert.strictEqual(m.cfbWidenArm, null, label + ' must get no arm');
      assert.strictEqual(m.cfbWidenApplied, false, label + ' must not be widened');
    }
  } finally { restore(); }
});

test('assignment is deterministic per parlayId, splits at the percent, control never widens', async () => {
  stub();
  try {
    const a = await price(legs4('det1'), 'w-det-7', 50);
    const b = await price(legs4('det2'), 'w-det-7', 50);
    assert.strictEqual(a.cfbWidenArm, b.cfbWidenArm, 'same parlayId → same arm (confirm reprice lands in it)');
    const arms = { widen: 0, control: 0 };
    for (let i = 0; i < 100; i++) {
      const m = await price(legs4('sp' + i), 'w-split-' + i, 50);
      arms[m.cfbWidenArm]++;
      if (m.cfbWidenArm === 'control') assert.strictEqual(m.cfbWidenApplied, false);
    }
    assert.ok(arms.widen >= 30 && arms.control >= 30, JSON.stringify(arms));
  } finally { restore(); }
});

test('salt "cfbw:" is independent of the ml/hr trim salts', () => {
  const crypto = require('crypto');
  const arm = (salt, pid) => crypto.createHash('md5').update(salt + pid).digest().readUInt32BE(0) % 100 < 50;
  let differ = 0;
  for (let i = 0; i < 200; i++) if (arm('cfbw:', 'x' + i) !== arm('ml:', 'x' + i)) differ++;
  assert.ok(differ > 60, `differed on ${differ}/200`);
});
