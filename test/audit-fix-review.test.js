// REGRESSIONS FROM THE 2026-09-27 REVIEW OF THE AUDIT FIXES.
//
// Each test pins one confirmed review finding:
//  1. services/db.js stayed pointed at PRODUCTION under
//     `node --test --test-isolation=none` (NODE_TEST_CONTEXT unset in the parent
//     process); a review run that way wrote 14 fake parlay_orders rows.
//  2. With PITCHER_K_PROPS_ENABLED off, a "... Total Pitching Strikeouts" lineId
//     fell through the dedicated on-demand K branch into VIRTUAL registration as
//     an MLB game alt-total.
//  3. backfillSgpCorrelation re-priced football spread+total tickets stored at
//     the measured 1.00 off the generic grid (1.15).
//  4. The settlement poll's leg-status saves ('confirmed' snapshots) raced the
//     settled save and could revert the Supabase row.
//  5. meta.pnlSource ('derived_void_reduced:*') survived PX confirming the
//     number and a re-settlement.
//  6. A baseball doubleheader game whose close was never captured read its
//     sibling's close (12h window).
//
// Run: node --test test/audit-fix-review.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const db = require('../services/db');
const orderTracker = require('../services/order-tracker');

test('0. this test file itself runs with the database disabled', () => {
  assert.strictEqual(db.isEnabled(), false);
});

test('1. db.js is disabled under node --test --test-isolation=none (in-process runner)', () => {
  const probe = path.join(__dirname, 'fixtures', 'db-guard-probe.cjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;   // exactly the parent-process condition
  delete env.NODE_ENV;
  const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', probe], { cwd: REPO, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, 'probe failed — db enabled in an in-process test run:\n' + (r.stdout || '') + (r.stderr || ''));
});

test('2. K props off: a pitching-strikeouts lineId is claimed and declined, never virtual-registered', async () => {
  process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  const oddsFeed = require('../services/odds-feed');
  const lineManager = require('../services/line-manager');
  const px = require('../services/prophetx');
  const { config } = require('../config');
  const SPORT = 'baseball_mlb';
  const SCHED = new Date(Date.now() + 3 * 3600e3).toISOString();
  const EVENT_ID = 77123999;
  const grp = (a) => [a];
  const PX_EVENT = {
    event_id: EVENT_ID, name: 'Cleveland Guardians at Detroit Tigers', sport_name: 'Baseball',
    scheduled: SCHED, status: 'not_started',
    competitors: [{ id: 501, name: 'Detroit Tigers', side: 'home' }, { id: 502, name: 'Cleveland Guardians', side: 'away' }],
  };
  const markets = () => [
    { id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
      { line_id: 'vv-ml-det', name: 'Detroit Tigers', display_name: 'Detroit Tigers', competitor_id: 501 },
      { line_id: 'vv-ml-cle', name: 'Cleveland Guardians', display_name: 'Cleveland Guardians', competitor_id: 502 },
    ]) },
    { id: 3, name: 'Total Runs', type: 'total', market_lines: [
      { line: 7.5, selections: grp([{ line_id: 'vv-tot-o', name: 'Over 7.5', line: 7.5 }, { line_id: 'vv-tot-u', name: 'Under 7.5', line: 7.5 }]) },
    ] },
    { id: 21, name: 'Tarik Skubal Total Pitching Strikeouts', type: 'total', market_lines: [
      { line: 7.5, selections: grp([{ line_id: 'vv-sk-o', name: 'Over 7.5', line: 7.5 }, { line_id: 'vv-sk-u', name: 'Under 7.5', line: 7.5 }]) },
    ] },
  ];
  const saved = [];
  const patch = (o, k, v) => { saved.push([o, k, o[k]]); o[k] = v; };
  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [PX_EVENT]);
  patch(px, 'fetchMarkets', async () => markets());
  patch(px, 'getSupportedLines', async () => []);
  const registered = [];
  patch(px, 'registerSupportedLines', async (ids) => { registered.push(...ids); });
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => [{ sport: SPORT, homeTeam: 'Detroit Tigers', awayTeam: 'Cleveland Guardians', commenceTime: SCHED }]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT ? {
    homeTeam: 'Detroit Tigers', awayTeam: 'Cleveland Guardians', commenceTime: SCHED,
    markets: {
      h2h: [{ name: 'Detroit Tigers', price: -150 }, { name: 'Cleveland Guardians', price: 130 }],
      totals: { over: { point: 7.5, price: -110 }, under: { point: 7.5, price: -110 } },
    },
  } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  const kFair = async () => ({ fairProbOver: 0.4, fairProbUnder: 0.6, booksWithBothSides: 5, books: ['pinnacle', 'draftkings', 'fanduel'], method: 'count_dist', fetchedAt: Date.now() });
  patch(oddsFeed, 'lookupPlayerStrikeoutPropFromTheOddsApi', kFair);
  patch(oddsFeed, 'lookupPlayerStrikeoutProp', kFair);
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', kFair);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  patch(config.pricing, 'pitcherKPropsEnabled', false);
  patch(config.pricing, 'propLaunchAllowlist', new Set([]));
  if (config.sportNameMap[SPORT] !== 'Baseball') patch(config.sportNameMap, SPORT, 'Baseball');
  try {
    await lineManager.seedAllLines();
    assert.ok(!lineManager.__debugGetLineIndex()['vv-sk-o'], 'K not seeded');
    const r = await lineManager.resolveUnknownLine({ line_id: 'vv-sk-o', sport_event_id: EVENT_ID, line: 7.5 });
    assert.strictEqual(r, null, 'K lineId must not resolve (it would have become a game alt-total)');
    assert.ok(!lineManager.__debugGetLineIndex()['vv-sk-o'], 'K lineId must not enter the index');
    assert.ok(!registered.includes('vv-sk-o'), 'K lineId must not be registered with PX');
    const f = lineManager.getResolveFailure && lineManager.getResolveFailure('vv-sk-o');
    assert.strictEqual(f && f.reason, 'k_props_disabled');
  } finally {
    for (const [o, k, v] of saved.reverse()) o[k] = v;
    global.fetch = realFetch;
  }
});

test('3. backfill never re-prices football spread+total off the generic grid', async () => {
  const lineManager = require('../services/line-manager');
  const oddsFeed = require('../services/odds-feed');
  const pricer = require('../services/pricer');
  const { config } = require('../config');
  const CFB = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl';
  const FUTURE = new Date(Date.now() + 20 * 3600e3).toISOString();
  const base = (id, ev, sport, extra) => Object.assign({ lineId: id, sport, oddsApiSport: sport, pxEventId: ev,
    homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, startTime: FUTURE, startTimeMs: Date.parse(FUTURE), marketName: 'Spread' }, extra);
  const spread = (id, ev, sport, line, side) => base(id, ev, sport, { marketType: 'spread', line, selection: side, oddsApiSelection: side, oddsApiMarket: 'spreads', teamName: (side === 'home' ? 'Home ' : 'Away ') + ev });
  const total = (id, ev, sport, line, sel) => base(id, ev, sport, { marketType: 'total', line, selection: sel, oddsApiSelection: sel, oddsApiMarket: 'totals', marketName: 'Total Points' });
  const LINES = {
    'bf-a-s': spread('bf-a-s', 'BF1', CFB, 13.5, 'away'), 'bf-a-t': total('bf-a-t', 'BF1', CFB, 43.5, 'over'),  // dog+over 13.5 -> 1.00
    'bf-b-s': spread('bf-b-s', 'BF2', CFB, -21, 'home'), 'bf-b-t': total('bf-b-t', 'BF2', CFB, 58.5, 'under'),  // fav+under 21 -> 1.00
    'bf-c-s': spread('bf-c-s', 'BF3', CFB, -21, 'home'), 'bf-c-t': total('bf-c-t', 'BF3', CFB, 58.5, 'over'),   // fav+over 21 -> bucket
    'bf-d-s': spread('bf-d-s', 'BF4', NFL, -7, 'home'), 'bf-d-t': total('bf-d-t', 'BF4', NFL, 44.5, 'over'),    // NFL -> 1.00
  };
  const saved = { lookup: lineManager.lookupLine, fair: oddsFeed.getFairProb, stale: oddsFeed.isStaleForEvent, stalePre: oddsFeed.isEventStalePreGame,
    combos: config.pricing.sgpAllowedCombos, grid: config.pricing.sgpCorrelationByCombo, cap: config.pricing.maxRiskPerParlay,
    maxOdds: config.pricing.maxOdds, fb: config.pricing.footballSgpEnabled };
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.50;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  config.pricing.sgpCorrelationByCombo = { spread_total: 1.15, ml_total: 1.15, spread_fav_over: 1.30, spread_dog_under: 1.08, spread_fav_under: 1.08, spread_dog_over: 1.08 };
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000; config.pricing.footballSgpEnabled = true;
  try {
    for (const [ids, pid] of [[['bf-a-s', 'bf-a-t'], 'bf-a'], [['bf-b-s', 'bf-b-t'], 'bf-b'], [['bf-c-s', 'bf-c-t'], 'bf-c'], [['bf-d-s', 'bf-d-t'], 'bf-d']]) {
      const res = await pricer.priceParlay(ids, { parlayId: pid });
      try { orderTracker.releasePending(pid); } catch (_) { /* best effort */ }
      assert.ok(res && res.meta, pid + ' must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
      orderTracker.recordQuote(pid, res.meta.legs, res.meta.americanOdds, res.meta.maxRisk, res.meta.fairParlayProb, res.meta);
    }
    const bf = await orderTracker.backfillSgpCorrelation({ dryRun: true });
    const touched = (bf.sample || []).filter(x => /^bf-[abcd]$/.test(x.parlayId) && x.fairAfter != null && Math.abs(x.fairAfter - x.fairBefore) > 1e-9);
    assert.deepStrictEqual(touched.map(x => x.parlayId), [], 'no football ticket may be re-priced: ' + JSON.stringify(touched));
  } finally {
    lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
    if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
    config.pricing.sgpAllowedCombos = saved.combos; config.pricing.sgpCorrelationByCombo = saved.grid;
    config.pricing.maxRiskPerParlay = saved.cap; config.pricing.maxOdds = saved.maxOdds; config.pricing.footballSgpEnabled = saved.fb;
  }
});

test('4. settlement poll persists ONE settled row — no confirmed-status save can race it', async () => {
  const calls = [];
  const realSave = db.saveOrder;
  db.saveOrder = async (o) => { calls.push(o.status); };
  try {
    const legs = [
      { lineId: 'sq-a', line_id: 'sq-a', pxEventId: 1, fairProb: 0.55, market: 'total', sport: 'baseball_mlb', startTime: '2026-07-08T22:35:00Z' },
      { lineId: 'sq-b', line_id: 'sq-b', pxEventId: 2, fairProb: 0.49, market: 'total', sport: 'baseball_mlb', startTime: '2026-07-08T22:35:00Z' },
    ];
    orderTracker.recordQuote('seq-1', legs, 249, 5000, 0.2, { legs });
    orderTracker.recordConfirmation('seq-1', 'seq-uuid-1', -249, 747);
    calls.length = 0;
    await orderTracker.pollOrderSettlements({ fetchOrders: async () => [{
      order_uuid: 'seq-uuid-1', p_id: 'seq-1', settlement_status: 'won', profit: 300,
      legs: [{ line_id: 'sq-a', settlement_status: 'lost' }, { line_id: 'sq-b', settlement_status: 'won' }],
    }] });
    assert.ok(calls.length >= 1, 'the settlement was saved');
    assert.ok(!calls.includes('confirmed'), 'no confirmed-status snapshot may be saved during the settle: ' + JSON.stringify(calls));
    const o = orderTracker.findByParlayId('seq-1');
    assert.strictEqual(o.status, 'settled_won');
    assert.ok((o.legs || []).some(l => (l.settlementStatus || l.settlement_status) === 'lost'), 'leg statuses applied in memory (and carried by the settled save)');
  } finally { db.saveOrder = realSave; }
});

test('5. the void-reduced estimate label is cleared once PX confirms or re-settles', async () => {
  const PAST = '2026-07-08T22:35:00Z';
  const leg = (lineId, pxEventId, fairProb, st, extra = {}) => ({ lineId, line_id: lineId, pxEventId, fairProb, settlementStatus: st, settlement_status: st,
    team: 'T-' + lineId, market: 'total', sport: 'baseball_mlb', startTime: PAST, ...extra });
  const L = (sfx) => [leg('ps-tt' + sfx, 10078672, 0.5541, 'won', { market: 'team_total' }), leg('ps-o10' + sfx, 10078665, 0.4943, 'push')];
  let seq = 0;
  const book = (legs) => { const id = 'pnlsrc-' + (++seq), uuid = 'pnlsrc-uuid-' + seq;
    orderTracker.recordQuote(id, legs, 249, 5000, 0.2, { legs }); orderTracker.recordConfirmation(id, uuid, -249, 747); return { id, uuid }; };
  const keeper = book([leg('pk1', 1, 0.5, null), leg('pk2', 2, 0.5, null)]);
  const keeperRow = { order_uuid: keeper.uuid, p_id: keeper.id, settlement_status: 'tbd', profit: null, legs: [] };
  const pxRow = (uuid, id, status, profit, sfx) => ({ order_uuid: uuid, p_id: id, settlement_status: status, profit,
    legs: [{ line_id: 'ps-tt' + sfx, settlement_status: 'won' }, { line_id: 'ps-o10' + sfx, settlement_status: 'push' }] });

  const a = book(L('A'));
  orderTracker.recordSettlement(a.uuid, 'lost', 0, { trusted: true });
  let o = orderTracker.findByParlayId(a.id);
  assert.match(o.meta.pnlSource || '', /^derived_void_reduced/, 'estimate is labelled while it is an estimate');
  await orderTracker.pollOrderSettlements({ fetchOrders: async () => [keeperRow, pxRow(a.uuid, a.id, 'lost', Math.round(o.pnl * 100) / 100, 'A')] });
  o = orderTracker.findByParlayId(a.id);
  assert.strictEqual(o.meta.pnlSource, undefined, 'PX reporting the same profit makes it PX-sourced');

  const b = book(L('B'));
  orderTracker.recordSettlement(b.uuid, 'lost', 0, { trusted: true });
  await orderTracker.pollOrderSettlements({ fetchOrders: async () => [keeperRow, pxRow(b.uuid, b.id, 'won', 300, 'B')] });
  o = orderTracker.findByParlayId(b.id);
  assert.strictEqual(o.status, 'settled_won');
  assert.strictEqual(o.meta.pnlSource, undefined, 're-settlement drops the stale label');
});

test('6. baseball doubleheader: a game with no captured close does NOT read its sibling', () => {
  const oddsFeed = require('../services/odds-feed');
  const HOME = 'New York Yankees', AWAY = 'Boston Red Sox';
  const key = `${HOME.toLowerCase()}|${AWAY.toLowerCase()}`;
  const mk = (eventId, commenceTime, p) => ({ homeTeam: HOME, awayTeam: AWAY, commenceTime, eventId,
    markets: { h2h: { home: { fairProb: p }, away: { fairProb: 1 - p } } } });
  const S = 'baseball_mlb_dhtest';
  const D1 = '2026-09-20T17:05:00Z', D2 = '2026-09-20T20:40:00Z';
  oddsFeed.__debugSetCache(S, { fetchedAt: Date.now(), events: { [key]: [mk('toa-d1', D1, 0.55)] } });
  const realNow = Date.now;
  Date.now = () => new Date(D1).getTime() + 5 * 60e3;
  try { oddsFeed.captureClosingLines(); } finally { Date.now = realNow; oddsFeed.__debugSetCache(S, null); }
  assert.ok(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, null, D1), 'game 1 finds its own close');
  assert.strictEqual(oddsFeed.getClosingLineSnapshot(S, HOME, AWAY, null, D2), null, 'game 2 (3.6h later) gets no close, not game 1\'s');
});
