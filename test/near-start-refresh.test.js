// Near-start refresh (2026-10-07). Operator: near the start "we simply cannot
// have delays of more than a minute or two" — then "build that": keep the
// inputs inside the freshness-gate window <= ~60s old so those markets quote
// instead of declining. Pins:
//   1. the prop re-price re-runs the SEED's prop pass and only updates lines
//      already registered (never adds/removes; only a strictly newer fetch wins)
//   2. a seed swap cannot regress a refreshed price
//   3. one batched TOA request per event, split into per-market cache entries;
//      a market absent from the response is stored empty, a failed request
//      writes nothing
//   4. selection: near-start only, exempt/golf skipped, active events first,
//      fresh inputs skipped; the per-pass request budget holds
// Stubbed I/O only — never the network or production Supabase.
// Run: node --test test/near-start-refresh.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const px = require('../services/prophetx');
const oddsFeed = require('../services/odds-feed');
const injuries = require('../services/football-injuries');
const db = require('../services/db');
const nsr = require('../services/near-start-refresh');
const { config } = require('../config');

// ------------------------------------------------------------ seed harness
const SPORT = 'americanfootball_nfl';
const SCHED = new Date(Date.now() + 45 * 60e3).toISOString();
const grp = (arr) => [arr];
const PX_EVENT = {
  event_id: 88001, name: 'Denver Broncos at Kansas City Chiefs', sport_name: 'American Football',
  scheduled: SCHED, status: 'not_started',
  competitors: [{ id: 201, name: 'Kansas City Chiefs', side: 'home' }, { id: 202, name: 'Denver Broncos', side: 'away' }],
};
const ou = (id, pt) => ({ line: pt, selections: grp([
  { line_id: `${id}-o-${pt}`, name: `Over ${pt}`, line: pt },
  { line_id: `${id}-u-${pt}`, name: `Under ${pt}`, line: pt },
]) });
const pxMarkets = () => [
  { id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
    { line_id: 'ml-kc', name: 'Kansas City Chiefs', competitor_id: 201 },
    { line_id: 'ml-den', name: 'Denver Broncos', competitor_id: 202 },
  ]) },
  { id: 13, name: 'Travis Kelce Total Receptions', type: 'total', market_lines: [ou('nsr-rec', 5.5)] },
];
const ALLOW = new Set([SPORT + '.receptions']);

// The lookup the seed AND the refresh call; tests swap what it returns.
let LOOKUP = { over: 0.52, under: 0.48, books: 4, fetchedAt: Date.now() - 600e3 };
const lookup = async (sport, key) => (key === 'player_receptions' && LOOKUP ? {
  fairProbOver: LOOKUP.over, fairProbUnder: LOOKUP.under, booksWithBothSides: LOOKUP.books,
  books: ['draftkings', 'fanduel', 'betmgm', 'caesars'], fetchedAt: LOOKUP.fetchedAt } : null);

const saved = [];
function patch(obj, key, val) { saved.push([obj, key, obj[key]]); obj[key] = val; }
function unpatch() { for (const [o, k, v] of saved.splice(0).reverse()) o[k] = v; injuries._setFetcher(null); }
function stubIo() {
  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [PX_EVENT]);
  patch(px, 'fetchMarkets', async () => pxMarkets());
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => [
    { sport: SPORT, homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', commenceTime: SCHED }]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT
    ? { homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', commenceTime: SCHED, markets: { h2h: {} } } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', lookup);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  patch(config.pricing, 'propLaunchAllowlist', ALLOW);
  patch(config.pricing, 'footballPropInjuryGate', false);
  if (config.sportNameMap[SPORT] !== 'American Football') patch(config.sportNameMap, SPORT, 'American Football');
  injuries._setFetcher(async () => null);
}
let _seeded = false;
async function seed() {
  if (!_seeded) { _seeded = true; await lineManager.seedAllLines(); } else { await lineManager.refreshLines(); }
}

// ------------------------------------------------------------ 1. re-price in place
test('refreshPropsForEvent re-prices a registered prop off a NEWER fetch, registration untouched', async () => {
  stubIo();
  try {
    LOOKUP = { over: 0.52, under: 0.48, books: 4, fetchedAt: Date.now() - 600e3 };
    await seed();
    const before = lineManager.__debugGetLineIndex()['nsr-rec-o-5.5'];
    assert.ok(before, 'seed registered the line');
    assert.ok(lineManager.__propSeedCtxForTest().has('88001'), 'seed stored the prop context');
    const t1 = Date.now() - 5e3;
    LOOKUP = { over: 0.60, under: 0.40, books: 4, fetchedAt: t1 };
    const r = await lineManager.refreshPropsForEvent(88001);
    assert.ok(r.updated >= 2, JSON.stringify(r));
    const over = lineManager.__debugGetLineIndex()['nsr-rec-o-5.5'];
    const under = lineManager.__debugGetLineIndex()['nsr-rec-u-5.5'];
    assert.equal(over.fairProb, 0.60); assert.equal(under.fairProb, 0.40);
    assert.equal(over.propFetchedAt, t1);
    assert.notStrictEqual(over, before, 'swapped object, not mutated');
    for (const f of ['marketType', 'line', 'selection', 'pxEventId', 'playerName', 'oddsApiMarket']) assert.deepEqual(over[f], before[f], f);
    assert.equal(before.fairProb, 0.52, 'an in-flight holder of the old object keeps a consistent snapshot');
  } finally { unpatch(); }
});

test('an OLDER (or equal) fetch never replaces a price; a pass that no longer prices leaves the line alone', async () => {
  stubIo();
  try {
    const cur = lineManager.__debugGetLineIndex()['nsr-rec-o-5.5'];
    LOOKUP = { over: 0.30, under: 0.70, books: 4, fetchedAt: cur.propFetchedAt - 1000 };
    await lineManager.refreshPropsForEvent(88001);
    assert.equal(lineManager.__debugGetLineIndex()['nsr-rec-o-5.5'].fairProb, cur.fairProb);
    LOOKUP = null;                                   // books pulled the market
    const r = await lineManager.refreshPropsForEvent(88001);
    assert.equal(r.updated, 0);
    assert.equal(lineManager.__debugGetLineIndex()['nsr-rec-o-5.5'].propFetchedAt, cur.propFetchedAt,
      'keeps its OLD fetch time -> the freshness gate declines it');
  } finally { unpatch(); }
});

test('refresh never ADDS a line the seed did not register', async () => {
  stubIo();
  try {
    LOOKUP = { over: 0.6, under: 0.4, books: 4, fetchedAt: Date.now() };
    const n = Object.keys(lineManager.__debugGetLineIndex()).length;
    delete lineManager.__debugGetLineIndex()['nsr-rec-u-5.5'];
    await lineManager.refreshPropsForEvent(88001);
    assert.ok(!lineManager.__debugGetLineIndex()['nsr-rec-u-5.5']);
    assert.equal(Object.keys(lineManager.__debugGetLineIndex()).length, n - 1);
    assert.deepEqual(await lineManager.refreshPropsForEvent(99999), { updated: 0, considered: 0, reason: 'no_seed_ctx' });
  } finally { unpatch(); }
});

// ------------------------------------------------------------ 2. seed swap
test('a seed swap cannot regress a refreshed price', () => {
  const base = { marketType: 'player_receptions', selection: 'over', line: 5.5, pxEventId: 1 };
  const staged = { a: Object.assign({}, base, { fairProb: 0.5, propFetchedAt: 1000 }) };
  const live = { a: Object.assign({}, base, { fairProb: 0.6, propFetchedAt: 2000 }) };
  assert.equal(lineManager.__keepNewerPropPricingForTest(staged, live), 1);
  assert.equal(staged.a.fairProb, 0.6); assert.equal(staged.a.propFetchedAt, 2000);
  const staged2 = { a: Object.assign({}, base, { fairProb: 0.7, propFetchedAt: 3000 }) };
  assert.equal(lineManager.__keepNewerPropPricingForTest(staged2, live), 0, 'a newer seed price wins');
  const moved = { a: Object.assign({}, base, { line: 6.5, fairProb: 0.4, propFetchedAt: 1 }) };
  lineManager.__keepNewerPropPricingForTest(moved, live);
  assert.equal(moved.a.fairProb, 0.4, 'a different line is never overwritten');
});

// ------------------------------------------------------------ 3. batched fetch
const EVS = [{ id: 'toa-ev-1', home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: SCHED }];
test('one batched request per event, split into per-market cache entries; absent market stored empty', async () => {
  process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';
  const urls = [];
  const get = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({
    id: 'toa-ev-1', home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos',
    bookmakers: [
      { key: 'draftkings', markets: [{ key: 'player_receptions', outcomes: [1] }, { key: 'player_pass_yds', outcomes: [2] }] },
      { key: 'fanduel', markets: [{ key: 'player_receptions', outcomes: [3] }] },
    ] }) }; };
  const r = await oddsFeed.refreshPropOddsForEvent(SPORT, { homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', startTime: SCHED },
    ['player_receptions', 'player_pass_yds', 'player_rush_yds', 'player_receptions'], { getEvents: async () => EVS, get });
  assert.equal(r.ok, true); assert.equal(r.requests, 1); assert.equal(r.refreshed, 3);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /markets=player_receptions,player_pass_yds,player_rush_yds&/);
  const rec = oddsFeed.__getToaPropOddsCacheForTest(`${SPORT}:toa-ev-1:player_receptions`);
  assert.equal(rec.bookmakers.length, 2);
  assert.ok(rec.bookmakers.every(b => b.markets.every(m => m.key === 'player_receptions')));
  assert.ok(Date.now() - rec.fetchedAt < 1000);
  assert.equal(oddsFeed.__getToaPropOddsCacheForTest(`${SPORT}:toa-ev-1:player_pass_yds`).bookmakers.length, 1);
  assert.equal(oddsFeed.__getToaPropOddsCacheForTest(`${SPORT}:toa-ev-1:player_rush_yds`).bookmakers.length, 0,
    'absent market stored EMPTY, never left at its older price');
});

test('a failed batch writes nothing; an unmatched event makes no request', async () => {
  process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';
  oddsFeed.__setToaPropOddsCacheForTest(`${SPORT}:toa-ev-1:player_sacks`, { fetchedAt: 123, bookmakers: ['old'] });
  const r = await oddsFeed.refreshPropOddsForEvent(SPORT, { homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', startTime: SCHED },
    ['player_sacks'], { getEvents: async () => EVS, get: async () => ({ ok: false, status: 429 }) });
  assert.equal(r.ok, false);
  assert.equal(oddsFeed.__getToaPropOddsCacheForTest(`${SPORT}:toa-ev-1:player_sacks`).fetchedAt, 123);
  let called = 0;
  const r2 = await oddsFeed.refreshPropOddsForEvent(SPORT, { homeTeam: 'Miami Dolphins', awayTeam: 'Buffalo Bills', startTime: SCHED },
    ['player_sacks'], { getEvents: async () => EVS, get: async () => { called++; return { ok: true, json: async () => ({}) }; } });
  assert.equal(r2.reason, 'no_event_match'); assert.equal(called, 0);
});

// ------------------------------------------------------------ 4. selection + budget
const NOW = Date.parse('2026-10-11T16:00:00Z');
const at = (min) => new Date(NOW + min * 60e3).toISOString();
const S = { enabled: true, tickSec: 45, targetAgeSec: 60, maxRequests: 30, windowMin: 180 };
function idx() {
  const L = (id, o) => [id, Object.assign({ lineId: id, sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', homeTeam: 'H' + o.ev, awayTeam: 'A' + o.ev }, o)];
  return Object.fromEntries([
    L('p1', { pxEventId: 'E1', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits', startTime: at(90), propFetchedAt: NOW - 400e3 }),
    L('p1b', { pxEventId: 'E1', marketType: 'player_hitter_hr', oddsApiMarket: 'batter_home_runs', startTime: at(90), propFetchedAt: NOW - 100e3 }),
    L('p2', { pxEventId: 'E2', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits', startTime: at(30), propFetchedAt: NOW - 200e3 }),
    L('p3', { pxEventId: 'E3', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits', startTime: at(60), propFetchedAt: NOW - 20e3 }),
    L('far', { pxEventId: 'E4', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits', startTime: at(400), propFetchedAt: 0 }),
    L('gone', { pxEventId: 'E5', marketType: 'player_hitter_hits', oddsApiMarket: 'batter_hits', startTime: at(-5), propFetchedAt: 0 }),
    L('ser', { pxEventId: 'E6', marketType: 'series_winner', oddsApiMarket: 'series_winner', startTime: at(30) }),
    L('golf', { pxEventId: 'E7', sport: 'golf_matchups', oddsApiSport: 'golf_matchups', marketType: 'moneyline', oddsApiMarket: 'h2h', startTime: at(30) }),
    L('f5', { pxEventId: 'E2', marketType: 'first_5_innings_total', oddsApiMarket: 'totals_f5', startTime: at(30) }),
    L('ml', { pxEventId: 'E8', sport: 'icehockey_nhl', oddsApiSport: 'icehockey_nhl', marketType: 'moneyline', oddsApiMarket: 'h2h', startTime: at(100) }),
  ]);
}

test('plan: near-start only, exempt + golf skipped, fresh props skipped, active first then stalest', () => {
  const p = nsr.plan(idx(), { settings: S, exempt: ['mov_', 'series_winner', 'outright_', 'golf_outrights'], activeEvents: new Map([['E2', NOW]]) }, NOW);
  assert.deepEqual(p.props.map(g => g.pxEventId), ['E2', 'E1'], 'E3 is fresh (20s), E4 too far, E5 started');
  assert.deepEqual([...p.props[1].markets].sort(), ['batter_hits', 'batter_home_runs'], 'one batch carries every market of the event');
  assert.deepEqual(p.supps.map(g => [...g.markets]), [['totals_f5']]);
  assert.deepEqual(p.sports.sort(), ['baseball_mlb', 'icehockey_nhl'], 'golf + series never trigger a main refresh');
  const noActive = nsr.plan(idx(), { settings: S, exempt: [], activeEvents: new Map() }, NOW);
  assert.equal(noActive.props[0].pxEventId, 'E1', 'without activity the STALEST goes first');
});

test('runOnce honours the per-pass request budget and skips sports whose main cache is fresh', async () => {
  nsr.__resetForTest();
  const calls = { main: [], props: [], reprice: [], supp: 0 };
  const fakeOdds = {
    _toaCooldownRemainingMs: () => 0,
    getCacheAge: (sp) => (sp === 'icehockey_nhl' ? 0.5 : 3),          // NHL 30s old -> fresh
    fetchOddsForSport: async (sp) => { calls.main.push(sp); },
    refreshPropOddsForEvent: async (sp, ev, mk) => { calls.props.push(ev.homeTeam); return { ok: true, requests: 1 }; },
    refreshNearStartSupplements: async () => { calls.supp++; return { ok: true, requests: 1 }; },
  };
  const fakeLm = { __debugGetLineIndex: () => idx(), refreshPropsForEvent: async (id) => { calls.reprice.push(id); return { updated: 2 }; } };
  const realNow = Date.now; Date.now = () => NOW;
  try {
    const out = await nsr.runOnce({ settings: Object.assign({}, S, { maxRequests: 2 }), oddsFeed: fakeOdds, lineManager: fakeLm, activeEvents: new Map() });
    assert.deepEqual(calls.main, ['baseball_mlb'], 'NHL main cache 30s old: no fetch');
    assert.equal(calls.props.length, 1, 'budget of 2 = 1 main + 1 prop event');
    assert.equal(out.budgetHit, true);
    assert.equal(calls.supp, 0);
    assert.deepEqual(calls.reprice, ['E1']);
    assert.equal(out.propLinesUpdated, 2);
  } finally { Date.now = realNow; }
});

test('runOnce stops at a TOA cooldown and is single-flight', async () => {
  nsr.__resetForTest();
  let n = 0;
  const fakeOdds = { _toaCooldownRemainingMs: () => 5000, getCacheAge: () => 9, fetchOddsForSport: async () => { n++; },
    refreshPropOddsForEvent: async () => { n++; return { ok: true, requests: 1 }; }, refreshNearStartSupplements: async () => { n++; return {}; } };
  const fakeLm = { __debugGetLineIndex: () => idx(), refreshPropsForEvent: async () => ({}) };
  const realNow = Date.now; Date.now = () => NOW;
  try {
    const out = await nsr.runOnce({ settings: S, oddsFeed: fakeOdds, lineManager: fakeLm, activeEvents: new Map() });
    assert.equal(n, 0); assert.equal(out.cooldown, true);
    let release;
    let first = true;
    const slow = { ...fakeOdds, _toaCooldownRemainingMs: () => 0,
      fetchOddsForSport: () => (first ? (first = false, new Promise(r => { release = r; })) : Promise.resolve()) };
    const p1 = nsr.runOnce({ settings: S, oddsFeed: slow, lineManager: fakeLm, activeEvents: new Map() });
    const p2 = await nsr.runOnce({ settings: S, oddsFeed: slow, lineManager: fakeLm, activeEvents: new Map() });
    assert.equal(p2.skipped, 'busy');
    release(); await p1;
  } finally { Date.now = realNow; }
});
