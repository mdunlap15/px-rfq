// Near-start freshness gate (2026-10-06). Operator: "for markets that can move
// a lot in the final few hours and minutes before start times, we simply cannot
// have delays of more than a minute or two" — "We have to get this fixed."
// Run: node --test test/fresh-gate.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const obRelay = require('../services/ob-relay');
const pricer = require('../services/pricer');
const { config } = require('../config');

const L = {};
function ml(id, ev, minsToStart, extra = {}) {
  const st = new Date(Date.now() + minsToStart * 60e3).toISOString();
  L[id] = Object.assign({ lineId: id, sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home', homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
    pxEventId: ev, startTime: st, startTimeMs: Date.parse(st) }, extra);
  return id;
}
const saved = {};
function stub(ageOf) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.age = oddsFeed.getLegOddsAgeSec; saved.cap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds; saved.en = config.pricing.freshGateEnabled; saved.relay = config.pricing.obRelayEnabled;
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.getFairProb = () => 0.5;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  oddsFeed.getLegOddsAgeSec = (li) => ageOf(li.lineId);
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000; config.pricing.freshGateEnabled = true;
  config.pricing.obRelayEnabled = true;
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre; oddsFeed.getLegOddsAgeSec = saved.age;
  config.pricing.maxRiskPerParlay = saved.cap; config.pricing.maxOdds = saved.maxOdds;
  config.pricing.freshGateEnabled = saved.en; config.pricing.obRelayEnabled = saved.relay; obRelay.__resetForTest();
}
async function attempt(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  return r;
}

test('inside 3h: odds older than 2 min decline (stale_near_start); 2 min or fresher prices', async () => {
  const a = ml('fg-a', 'F1', 60), b = ml('fg-b', 'F2', 600);
  stub(id => (id === 'fg-a' ? 300 : 30));
  try {
    assert.strictEqual(await attempt([a, b], 'fg-1'), null);
    assert.strictEqual(pricer.priceParlay._lastFailure.reason, 'stale_near_start');
  } finally { restore(); }
  stub(id => (id === 'fg-a' ? 90 : 30));
  try { assert.ok(await attempt([a, b], 'fg-2'), 'a 90s-old leg prices'); } finally { restore(); }
});

test('beyond the window the gate does not apply (existing staleness limits govern)', async () => {
  const a = ml('fg-c', 'F3', 300), b = ml('fg-d', 'F4', 600);
  stub(() => 500);
  try { assert.ok(await attempt([a, b], 'fg-3')); } finally { restore(); }
});

test('unknown odds age near the start declines', async () => {
  const a = ml('fg-e', 'F5', 30), b = ml('fg-f', 'F6', 600);
  stub(id => (id === 'fg-e' ? null : 10));
  try { assert.strictEqual(await attempt([a, b], 'fg-4'), null); } finally { restore(); }
});

test('a fresh order-book relay fair satisfies the gate even when our own feed is stale', async () => {
  const a = ml('fg-g', 'F7', 45), b = ml('fg-h', 'F8', 600);
  stub(id => (id === 'fg-g' ? 900 : 10));
  obRelay.__setForTest({ 'fg-g': [0.5, Math.floor(Date.now() / 1000) - 20, 'mlb_line_guard', 0.51] });
  try {
    const r = await attempt([a, b], 'fg-5');
    assert.ok(r, JSON.stringify(pricer.priceParlay._lastFailure));
    assert.strictEqual(r.meta.legs.find(l => l.lineId === a).fairSource, 'ob_direct');
  } finally { restore(); }
});

test('slow-moving markets are exempt (MLB series)', async () => {
  const a = ml('fg-i', 'F9', 30, { marketType: 'series_winner' }), b = ml('fg-j', 'F10', 600);
  stub(() => 900);
  try {
    const r = await attempt([a, b], 'fg-6');
    if (!r) assert.notStrictEqual(pricer.priceParlay._lastFailure.reason, 'stale_near_start', 'exempt from THIS gate');
  } finally { restore(); }
});

test('kill switch and defaults', async () => {
  assert.strictEqual(config.pricing.freshGateWindowMin, 180);
  assert.strictEqual(config.pricing.freshGateMaxAgeSec, 120);
  const a = ml('fg-k', 'F11', 30), b = ml('fg-l', 'F12', 600);
  stub(() => 900);
  config.pricing.freshGateEnabled = false;
  try { assert.ok(await attempt([a, b], 'fg-7')); } finally { restore(); }
});

test('golf matchups have no trustworthy odds age (DataGolf boards are snapshots) -> declined near the start', () => {
  const of = require('../services/odds-feed');
  assert.strictEqual(of.getLegOddsAgeSec({ sport: 'golf_matchups', oddsApiSport: 'golf_matchups', marketType: 'moneyline' }), null);
});

// ---- supplement markets age by their OWN fetch (2026-10-07) -----------------
// The sport cache is re-stamped on every bulk refresh while F5 / H1 / team
// totals / BTTS blocks are carried forward up to 20 min, so reading the sport
// age passed a 15-min-old F5 line as fresh.
function withCache(sport, events, fn) {
  const of = require('../services/odds-feed');
  of.__setOddsCacheForTest(sport, { fetchedAt: Date.now() - 20e3, events });
  try { return fn(of); } finally { of.__setOddsCacheForTest(sport, null); }
}
const evKey = (h, a) => require('../services/odds-feed').normalizeEventKey(h, a);
const LI = (om, extra = {}) => Object.assign({ sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'x', oddsApiMarket: om,
  homeTeam: 'Supp Home', awayTeam: 'Supp Away', startTime: new Date(Date.now() + 3600e3).toISOString(), oddsApiSelection: 'home' }, extra);

test('a carried-forward supplement block with no fetch stamp has UNKNOWN age (not the sport age)', () => {
  withCache('baseball_mlb', { [evKey('Supp Home', 'Supp Away')]: { homeTeam: 'Supp Home', awayTeam: 'Supp Away', commenceTime: LI('h2h').startTime,
    markets: { h2h: { home: {}, away: {} }, h2h_f5: { home: {}, away: {} } } } }, (of) => {
    assert.strictEqual(of.getLegOddsAgeSec(LI('h2h_f5')), null);
    const main = of.getLegOddsAgeSec(LI('h2h'));
    assert.ok(main >= 19 && main <= 21, 'bulk market keeps the sport age: ' + main);
  });
});

test('a supplement block ages by its own fetchedAt; merge keeps older alt points older', () => {
  const of = require('../services/odds-feed');
  const old = of.__mergeSupplementedMarketForTest(null, { line: 4.5, byLine: { '4.5': {}, '5.5': {} } });
  old.fetchedAt = Date.now() - 600e3; old.byLineAt = { '4.5': old.fetchedAt, '5.5': old.fetchedAt };
  const merged = of.__mergeSupplementedMarketForTest(old, { line: 4.5, byLine: { '4.5': {} }, over: { point: 4.5 }, under: { point: 4.5 } });
  assert.ok(Date.now() - merged.fetchedAt < 1000);
  assert.ok(Date.now() - merged.byLineAt['4.5'] < 1000, 'refetched point is fresh');
  assert.ok(Date.now() - merged.byLineAt['5.5'] >= 599e3, 'carried point keeps its old time');
  withCache('baseball_mlb', { [evKey('Supp Home', 'Supp Away')]: { homeTeam: 'Supp Home', awayTeam: 'Supp Away', commenceTime: LI('h2h').startTime,
    markets: { totals_f5: merged } } }, (o) => {
    assert.ok(o.getLegOddsAgeSec(LI('totals_f5', { line: 4.5, oddsApiSelection: 'over' })) <= 1);
    assert.ok(o.getLegOddsAgeSec(LI('totals_f5', { line: 5.5, oddsApiSelection: 'over' })) >= 599, 'alt point reads its own age');
    assert.strictEqual(o.getLegOddsAgeSec(LI('totals_f5', { line: 6.5, oddsApiSelection: 'over' })), null, 'unknown point = unknown age');
  });
});

test('RFI and other seed-time fairs age by propFetchedAt', () => {
  const of = require('../services/odds-feed');
  const a = of.getLegOddsAgeSec({ marketType: 'run_first_inning', oddsApiMarket: 'totals_1st_1_innings', propFetchedAt: Date.now() - 400e3 });
  assert.ok(a >= 399 && a <= 401);
  assert.strictEqual(of.getLegOddsAgeSec({ marketType: 'run_first_inning', oddsApiMarket: 'totals_1st_1_innings' }), null);
});
