// Order-book fair relay + adverse-only confirm check (2026-10-06).
// Operator: RFQ and order-book lines should use "the exact same methodologies for
// creating their lines and monitoring for line changes ... use a relay".
// Run: node --test test/ob-relay.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');

const obRelay = require('../services/ob-relay');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const nowS = () => Math.floor(Date.now() / 1000);
const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const LINES = {};
function ml(id, ev, sel = 'home') {
  LINES[id] = { lineId: id, sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'moneyline', oddsApiMarket: 'h2h',
    marketName: 'Moneyline', teamName: (sel === 'home' ? 'Home ' : 'Away ') + ev, selection: sel, oddsApiSelection: sel,
    homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE) };
  return id;
}
const saved = {};
function stub(fair = 0.5) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.stalePre = oddsFeed.isEventStalePreGame; saved.cap = config.pricing.maxRiskPerParlay; saved.maxOdds = config.pricing.maxOdds;
  saved.en = config.pricing.obRelayEnabled; saved.gap = config.pricing.obRelayMaxGapPp; saved.age = config.pricing.obRelayMaxAgeSec;
  saved.adv = config.pricing.confirmAdverseDriftThreshold; saved.cal = config.pricing.propFairCalibration;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => fair;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000;
  config.pricing.obRelayEnabled = true; config.pricing.obRelayMaxGapPp = 0.06; config.pricing.obRelayMaxAgeSec = 300;
  config.pricing.confirmAdverseDriftThreshold = 0.015;
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
  config.pricing.maxRiskPerParlay = saved.cap; config.pricing.maxOdds = saved.maxOdds;
  config.pricing.obRelayEnabled = saved.en; config.pricing.obRelayMaxGapPp = saved.gap; config.pricing.obRelayMaxAgeSec = saved.age;
  config.pricing.confirmAdverseDriftThreshold = saved.adv; config.pricing.propFairCalibration = saved.cal;
  obRelay.__resetForTest();
}
async function price(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
  return r.meta;
}

test('getFair: fresh direct entry used; stale entry ignored', () => {
  stub();
  try {
    obRelay.__setForTest({ L1: [0.42, nowS() - 20, 'cfb_line_guard'], L2: [0.42, nowS() - 4000, 'p'] });
    const d = obRelay.getFair('L1');
    assert.strictEqual(d.fair, 0.42); assert.strictEqual(d.via, 'direct'); assert.strictEqual(d.source, 'cfb_line_guard');
    assert.strictEqual(obRelay.getFair('L2'), null, 'older than obRelayMaxAgeSec');
    config.pricing.obRelayEnabled = false;
    assert.strictEqual(obRelay.getFair('L1'), null, 'kill switch');
  } finally { restore(); }
});

test('two-way sibling: the other side of the same market is 1 − fair', () => {
  stub();
  try {
    obRelay.__setForTest({ AWAY: [0.37, nowS() - 10, 'nfl_pre_post'] }, { siblings: [['HOME', 'AWAY'], ['AWAY', 'HOME']] });
    const c = obRelay.getFair('HOME');
    assert.strictEqual(c.via, 'complement');
    assert.ok(Math.abs(c.fair - 0.63) < 1e-9);
  } finally { restore(); }
});

test('group key pairs home −3.5 with away +3.5 (not with home +3.5); totals pair over/under at the same line', () => {
  const k = (sel, line, mt = 'spread', name = 'Spread') => obRelay._groupKey({ pxEventId: 9, marketType: mt, marketName: name, selection: sel, line });
  assert.strictEqual(k('home', -3.5), k('away', 3.5));
  assert.notStrictEqual(k('home', -3.5), k('home', 3.5));
  assert.strictEqual(k('over', 8.5, 'total', 'Total'), k('under', 8.5, 'total', 'Total'));
  assert.notStrictEqual(k('over', 8.5, 'total', 'Total'), k('over', 9.5, 'total', 'Total'));
});

test('resolve: our own fair wins only when MORE adverse than the relay by more than the gap', () => {
  stub();
  try {
    obRelay.__setForTest({ X: [0.40, nowS() - 5, 'p'] });
    assert.strictEqual(obRelay.resolve('X', 0.43).used, 0.40, 'small gap: the order book fair');
    const r = obRelay.resolve('X', 0.50);
    assert.strictEqual(r.used, 0.50); assert.strictEqual(r.adverseOverride, true);
    assert.strictEqual(obRelay.resolve('X', 0.30).used, 0.40, 'ours more generous: the order book fair');
  } finally { restore(); }
});

test('pricer: a leg the order book priced takes its fair (fairSource ob_direct); others keep ours', async () => {
  stub(0.5);
  try {
    const a = ml('rl-a', 'R1'), b = ml('rl-b', 'R2');
    obRelay.__setForTest({ 'rl-a': [0.53, nowS() - 15, 'mlb_props_cycle'] });
    const m = await price([a, b], 'rl-p1');
    const la = m.legs.find(l => l.lineId === a), lb = m.legs.find(l => l.lineId === b);
    assert.strictEqual(la.fairSource, 'ob_direct'); assert.strictEqual(la.fairProb, 0.53);
    assert.strictEqual(la.obRelay.own, 0.5);
    assert.ok(Math.abs(la.inputAgeSec - 15) <= 2, 'input age is the relay entry age');
    assert.strictEqual(lb.fairSource, 'rfq'); assert.strictEqual(lb.fairProb, 0.5);
    assert.ok(Math.abs(m.fairParlayProb - 0.265) < 1e-6);
  } finally { restore(); }
});

test('pricer: a leg with a measured RFQ calibration multiplier keeps our own fair', async () => {
  stub(0.5);
  try {
    const a = ml('rl-c', 'R3'), b = ml('rl-d', 'R4');
    config.pricing.propFairCalibration = { 'moneyline.home': 1.02 };
    obRelay.__setForTest({ 'rl-c': [0.45, nowS() - 15, 'p'] });
    const m = await price([a, b], 'rl-p2');
    assert.strictEqual(m.legs.find(l => l.lineId === a).fairSource, 'rfq');
  } finally { restore(); }
});

test('confirm: adverse move beyond 1.5% rejects; a move in our favour within the backstop accepts', async () => {
  stub(0.5);
  try {
    const a = ml('cf-a', 'C1'), b = ml('cf-b', 'C2');
    const q = await price([a, b], 'cf-p1');                 // fair 0.25
    obRelay.__setForTest({ 'cf-a': [0.51, nowS() - 5, 'cfb_line_guard'] });   // +2% on one leg
    const bad = await pricer.validateForConfirmation('cf-p1', q);
    assert.strictEqual(bad.valid, false, JSON.stringify(bad.reason));
    assert.match(bad.reason, /adverse move/);
    obRelay.__setForTest({ 'cf-a': [0.49, nowS() - 5, 'cfb_line_guard'] });   // −2%: in our favour
    const ok = await pricer.validateForConfirmation('cf-p1', q);
    assert.strictEqual(ok.valid, true, JSON.stringify(ok.reason));
    config.pricing.confirmAdverseDriftThreshold = 0;
    obRelay.__setForTest({ 'cf-a': [0.51, nowS() - 5, 'p'] });
    assert.strictEqual((await pricer.validateForConfirmation('cf-p1', q)).valid, true, '0 disables the adverse check');
  } finally { restore(); }
});
