// Pitcher-strikeout UNDER price (2026-09-27 pricing audit).
//
// The audit's K finding: K-under legs were calibrated (0.98x fair) while the
// K fair was an exact-line de-vig, then won 1.11x fair once the strikeout-count
// DISTRIBUTION fair shipped on 7/8 and 1.32x over 8/6-8/24 — 146 wins vs 122.3
// expected over 219 unique legs, ratio 1.19 [95% CI 1.08, 1.31], z=3.3. Cause:
// odds-feed set the under to `1 - distOver`, and the fit overstates P(over), so
// the under inherited the error. Account ac90ac6d put $58.8K of risk on it.
// K props were switched OFF (PITCHER_K_PROPS_ENABLED) — stopped, not fixed.
//
// This locks the fix that must be in place before K props are re-enabled:
//   1. under = max(1 - distOver, 1 - exactLineOver) — never cheaper than the
//      books' own de-vigged under at PX's line. The OVER is untouched (it keeps
//      the distribution fair, the off-consensus-line underprice fix).
//   2. a K-under fair calibration of 1.19 via PROP_FAIR_CALIBRATION, shipped as
//      a CODE DEFAULT that MERGES under the env — prod sets that env
//      (player_hitter_hr.over), and it used to REPLACE the whole map, which
//      would have dropped a code default silently.
//   3. with PITCHER_K_PROPS_ENABLED off nothing registers — on EVERY path,
//      including the generic allowlist pre-seed, which the kill-switch did not
//      cover before.
//
// The odds-feed scenarios drive the REAL lookup functions against a stubbed
// fetch (TOA-shaped fixtures); the seed scenarios drive the REAL
// seedAllLines/refreshLines/resolveUnknownLine with px/oddsFeed/db stubbed at
// the module boundary (same idiom as test/football-lines.test.js).
//
// Run: node --test test/k-under-fair.test.js

process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert');

const oddsFeed = require('../services/odds-feed');
const lineManager = require('../services/line-manager');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const px = require('../services/prophetx');
const db = require('../services/db');
const { config } = require('../config');

// --- fetch stub (TOA) -------------------------------------------------------
const routes = [];
const route = (all, payload) => routes.push({ all, payload });
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  for (const r of routes) {
    if (r.all.every(s => u.includes(s))) {
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(r.payload)) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
process.on('exit', () => { global.fetch = realFetch; });

const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
const ou = (desc, point, over, under) => [
  { name: 'Over', description: desc, point, price: over },
  { name: 'Under', description: desc, point, price: under },
];
// Skubal: the sharp books (pinnacle/dk/fd) post 6.5; two softer books post
// PX's 5.5. The distribution fit lifts the 5.5 over ABOVE the books' own
// exact-line over — the shape that left the under cheap. Bibee: the fit's
// 7.5 under is already the richer one, so the floor must not move it.
const kBoard = (key) => ({
  id: 'mlbk1', home_team: 'Detroit Tigers', away_team: 'Cleveland Guardians',
  bookmakers: [
    { key: 'pinnacle', markets: [{ key, outcomes: [...ou('Tarik Skubal', 6.5, 100, -120), ...ou('Tanner Bibee', 6.5, -105, -115)] }] },
    { key: 'draftkings', markets: [{ key, outcomes: [...ou('Tarik Skubal', 6.5, -105, -115), ...ou('Tanner Bibee', 6.5, 100, -120)] }] },
    { key: 'fanduel', markets: [{ key, outcomes: [...ou('Tarik Skubal', 6.5, 100, -125), ...ou('Tanner Bibee', 6.5, -102, -118)] }] },
    { key: 'betrivers', markets: [{ key, outcomes: [...ou('Tarik Skubal', 5.5, -150, 120), ...ou('Tanner Bibee', 7.5, -110, -110)] }] },
    { key: 'williamhill_us', markets: [{ key, outcomes: [...ou('Tarik Skubal', 5.5, -145, 115), ...ou('Tanner Bibee', 7.5, -105, -115)] }] },
  ],
});
route(['/v4/sports/baseball_mlb/events?'], [
  { id: 'mlbk1', home_team: 'Detroit Tigers', away_team: 'Cleveland Guardians', commence_time: FUTURE },
]);
route(['/events/mlbk1/odds', 'markets=pitcher_strikeouts'], kBoard('pitcher_strikeouts'));
// The same shape on a NON-strikeout count market (NBA points) — the floor is
// strikeouts-only, so it must leave this under at 1 - distOver.
route(['/v4/sports/basketball_nba/events?'], [
  { id: 'nbak1', home_team: 'Boston Celtics', away_team: 'Miami Heat', commence_time: FUTURE },
]);
route(['/events/nbak1/odds', 'markets=player_points'], {
  id: 'nbak1', home_team: 'Boston Celtics', away_team: 'Miami Heat',
  bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'player_points', outcomes: ou('Jayson Tatum', 24.5, -125, 105) }] },
    { key: 'draftkings', markets: [{ key: 'player_points', outcomes: ou('Jayson Tatum', 24.5, -120, 100) }] },
    { key: 'fanduel', markets: [{ key: 'player_points', outcomes: ou('Jayson Tatum', 24.5, -122, 102) }] },
    { key: 'betrivers', markets: [{ key: 'player_points', outcomes: ou('Jayson Tatum', 25.5, 125, -150) }] },
    { key: 'williamhill_us', markets: [{ key: 'player_points', outcomes: ou('Jayson Tatum', 25.5, 120, -145) }] },
  ],
});

const mlbInfo = { homeTeam: 'Detroit Tigers', awayTeam: 'Cleveland Guardians', startTime: FUTURE };
const nbaInfo = { homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', startTime: FUTURE };
const kLookup = (player, line) => oddsFeed.lookupPlayerStrikeoutPropFromTheOddsApi('baseball_mlb', mlbInfo, player, line);
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

// GOLDEN over fairs, captured from the pre-fix code on this exact fixture. The
// fix must not move a single over price.
const GOLDEN_OVER = {
  'Tarik Skubal|5.5': 0.6099617428852108,
  'Tarik Skubal|4.5': 0.7519083737428631,
  'Tarik Skubal|6.5': 0.4616838119913089,
  'Tanner Bibee|7.5': 0.388714385462811,
};

// ---------------------------------------------------------------------------
// 1. Dedicated K bridge (lookupPlayerStrikeoutPropFromTheOddsApi)
// ---------------------------------------------------------------------------

test('K under: a distribution fair that OVERSTATES the over gets the exact-line under (max)', async () => {
  const r = await kLookup('Tarik Skubal', 5.5);
  assert.ok(!r.error, `lookup errored: ${r.error} (${r.stages})`);
  assert.equal(r.method, 'count_dist', 'fixture must exercise the distribution fair');
  // The defect's shape: the fit's over sits above the books' own exact-line over.
  assert.ok(r.fairProbOver > r.exactLineFairOver,
    `fixture must have distOver ${r.fairProbOver} > exactOver ${r.exactLineFairOver}`);
  // The fix: the under is the books' exact-line under, NOT 1 - distOver.
  assert.ok(near(r.fairProbUnder, 1 - r.exactLineFairOver),
    `under ${r.fairProbUnder} must be the exact-line under ${1 - r.exactLineFairOver}`);
  assert.ok(r.fairProbUnder > 1 - r.fairProbOver + 0.04,
    'the under must be materially richer than the inherited 1 - distOver (0.390 -> 0.436 here)');
});

test('K OVER is unchanged — it keeps the distribution fair on every line (golden, pre-fix values)', async () => {
  for (const [key, want] of Object.entries(GOLDEN_OVER)) {
    const [player, line] = key.split('|');
    const r = await kLookup(player, Number(line));
    assert.strictEqual(r.fairProbOver, want, `${key}: over moved (${r.fairProbOver} vs golden ${want})`);
    assert.equal(r.method, 'count_dist', `${key}: over must stay on the distribution fair`);
  }
});

test('K under: when the fit\'s under is already the richer one, the floor leaves it alone', async () => {
  for (const [player, line] of [['Tanner Bibee', 7.5], ['Tarik Skubal', 6.5]]) {
    const r = await kLookup(player, line);
    assert.ok(r.exactLineFairOver != null && r.fairProbOver < r.exactLineFairOver,
      `${player} ${line}: fixture must have distOver < exactOver`);
    assert.ok(near(r.fairProbUnder, 1 - r.fairProbOver), `${player} ${line}: under must stay 1 - distOver`);
  }
});

test('K under: no book at PX\'s exact line → nothing to floor against, under = 1 - distOver', async () => {
  const r = await kLookup('Tarik Skubal', 4.5);
  assert.strictEqual(r.exactLineFairOver, null);
  assert.equal(r.method, 'count_dist');
  assert.ok(near(r.fairProbUnder, 1 - r.fairProbOver));
});

test('K under: with the distribution fit OFF (COUNT_PROP_DIST_FAIR=false) the exact-line pair is untouched', async () => {
  const saved = config.pricing.countPropDistFair;
  config.pricing.countPropDistFair = false;
  try {
    const r = await kLookup('Tarik Skubal', 5.5);
    assert.equal(r.method, 'exact_line_devig');
    assert.strictEqual(r.fairProbOver, r.exactLineFairOver);
    assert.ok(near(r.fairProbUnder, 1 - r.exactLineFairOver));
  } finally {
    config.pricing.countPropDistFair = saved;
  }
});

test('_strikeoutUnderFair: pure max(1 - over, 1 - exact), fail-safe on missing inputs', () => {
  const f = oddsFeed._strikeoutUnderFair;
  assert.equal(typeof f, 'function');
  assert.strictEqual(f(null, 0.5), null, 'no over → no under (caller declines)');
  assert.ok(near(f(0.61, 0.56), 0.44), 'exact-line under wins when richer');
  assert.ok(near(f(0.39, 0.49), 0.61), 'distribution under wins when richer');
  assert.ok(near(f(0.61, null), 0.39), 'no exact line → 1 - over');
  assert.ok(near(f(0.61, 0), 0.39), 'a degenerate exact over is ignored, not trusted');
  assert.ok(near(f(0.61, 1), 0.39), 'a degenerate exact over is ignored, not trusted');
});

// ---------------------------------------------------------------------------
// 2. Generic prop bridge (lookupTheOddsApiPlayerProp) — the allowlist path
// ---------------------------------------------------------------------------

test('generic bridge, pitcher_strikeouts: the under is floored at the exact-line under too', async () => {
  const r = await oddsFeed.lookupTheOddsApiPlayerProp('baseball_mlb', 'pitcher_strikeouts', mlbInfo, 'Tarik Skubal', 5.5);
  assert.ok(!r.error, `lookup errored: ${r.error} (${r.stages})`);
  assert.equal(r.method, 'count_dist');
  assert.ok(r.fairProbOver > r.exactLineFairOver, 'fixture: distOver above exactOver');
  assert.ok(r.fairProbUnder >= 1 - r.exactLineFairOver - 1e-12,
    `under ${r.fairProbUnder} must not sit below the exact-line under ${1 - r.exactLineFairOver}`);
  assert.ok(r.fairProbUnder > 1 - r.fairProbOver + 0.04, 'and it must actually have moved off 1 - distOver');
});

test('generic bridge, NON-strikeout count prop (NBA points): unchanged, under stays 1 - distOver', async () => {
  const r = await oddsFeed.lookupTheOddsApiPlayerProp('basketball_nba', 'player_points', nbaInfo, 'Jayson Tatum', 25.5);
  assert.ok(!r.error, `lookup errored: ${r.error} (${r.stages})`);
  assert.equal(r.method, 'count_dist');
  assert.ok(r.exactLineFairOver != null && r.fairProbOver > r.exactLineFairOver,
    `fixture must have distOver ${r.fairProbOver} > exactOver ${r.exactLineFairOver} (else this proves nothing)`);
  assert.ok(near(r.fairProbUnder, 1 - r.fairProbOver),
    'the floor is strikeouts-only — no measured under leak elsewhere, so no price change there');
});

// ---------------------------------------------------------------------------
// 3. PROP_FAIR_CALIBRATION: K-under default MERGES under the env
// ---------------------------------------------------------------------------

// Re-evaluate config.js under a given env, then put the ORIGINAL module back in
// the require cache so lazy `require('../config')` calls inside services keep
// seeing the instance every other scenario patches.
function loadConfigWith(envVal) {
  const key = require.resolve('../config');
  const orig = require.cache[key];
  const saved = process.env.PROP_FAIR_CALIBRATION;
  if (envVal === undefined) delete process.env.PROP_FAIR_CALIBRATION;
  else process.env.PROP_FAIR_CALIBRATION = envVal;
  delete require.cache[key];
  try {
    return require('../config').config.pricing.propFairCalibration;
  } finally {
    if (saved === undefined) delete process.env.PROP_FAIR_CALIBRATION;
    else process.env.PROP_FAIR_CALIBRATION = saved;
    require.cache[key] = orig;
  }
}

test('calibration: the code ships player_strikeouts.under = 1.19 with no env', () => {
  const m = loadConfigWith(undefined);
  assert.strictEqual(m['player_strikeouts.under'], 1.19);
  assert.strictEqual(m['player_strikeouts.over'], undefined, 'the over is NOT calibrated');
});

test('calibration: the PROD env (player_hitter_hr.over) MERGES with the K-under default — env does not replace it', () => {
  const m = loadConfigWith(JSON.stringify({ 'player_hitter_hr.over': 0.93 }));
  assert.strictEqual(m['player_hitter_hr.over'], 0.93, 'env key honoured');
  assert.strictEqual(m['player_strikeouts.under'], 1.19,
    'a default that the prod env silently replaced would never reach a price');
});

test('calibration: the env wins PER KEY — 1 switches the default off, another value overrides it', () => {
  assert.strictEqual(loadConfigWith(JSON.stringify({ 'player_strikeouts.under': 1 }))['player_strikeouts.under'], 1);
  assert.strictEqual(loadConfigWith(JSON.stringify({ 'player_strikeouts.under': 1.1 }))['player_strikeouts.under'], 1.1);
  // Out-of-bounds / malformed entries are dropped, so the default survives them.
  assert.strictEqual(loadConfigWith(JSON.stringify({ 'player_strikeouts.under': 3 }))['player_strikeouts.under'], 1.19);
  assert.strictEqual(loadConfigWith('{not json')['player_strikeouts.under'], 1.19);
});

// ---------------------------------------------------------------------------
// 4. The pricer applies it to a K-UNDER leg only (real priceParlay)
// ---------------------------------------------------------------------------

const PFUT = new Date(Date.now() + 5 * 3600e3).toISOString();
const kLine = (id, ev, sel, fair) => ({
  lineId: id, sport: 'baseball_mlb', marketType: 'player_strikeouts',
  teamName: 'Pitcher ' + id, playerName: 'Pitcher ' + id, line: 5.5,
  selection: sel, oddsApiSelection: sel, oddsApiMarket: 'player_strikeouts', oddsApiSport: 'baseball_mlb',
  homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev,
  startTime: PFUT, startTimeMs: Date.parse(PFUT),
  fairProb: fair, fairProbOver: sel === 'over' ? fair : 1 - fair, fairProbUnder: sel === 'under' ? fair : 1 - fair,
  booksWithBothSides: 5, propBooks: ['pinnacle', 'draftkings', 'fanduel'], propSource: 'theoddsapi', propFetchedAt: Date.now(),
});
const PLINES = {
  'k-under-a': kLine('k-under-a', 'KE1', 'under', 0.44),
  'k-over-b': kLine('k-over-b', 'KE2', 'over', 0.47),
};

async function priceK(ids, parlayId) {
  const saved = {
    lookup: lineManager.lookupLine, fair: oddsFeed.getFairProb, stale: oddsFeed.isStaleForEvent,
    stalePre: oddsFeed.isEventStalePreGame, propCap: config.pricing.maxRiskPerParlayWithProp,
    parlayCap: config.pricing.maxRiskPerParlay, maxOdds: config.pricing.maxOdds,
  };
  lineManager.lookupLine = (id) => PLINES[id] || null;
  oddsFeed.getFairProb = () => null;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlayWithProp = 3000;
  config.pricing.maxRiskPerParlay = 3000;
  config.pricing.maxOdds = 50000;
  try {
    const res = await pricer.priceParlay(ids, { parlayId });
    assert.ok(res && res.meta, 'must price (failure: ' + JSON.stringify(pricer.priceParlay._lastFailure) + ')');
    return res.meta;
  } finally {
    try { orderTracker.releasePending(parlayId); } catch (_) { /* best effort */ }
    lineManager.lookupLine = saved.lookup;
    oddsFeed.getFairProb = saved.fair;
    oddsFeed.isStaleForEvent = saved.stale;
    if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
    config.pricing.maxRiskPerParlayWithProp = saved.propCap;
    config.pricing.maxRiskPerParlay = saved.parlayCap;
    config.pricing.maxOdds = saved.maxOdds;
  }
}

test('pricer: the K-UNDER leg fair is lifted by 1.19, the K-OVER leg is not', async () => {
  const saved = config.pricing.propFairCalibration;
  // The live config object as the module loaded it: prod-shaped env merge.
  config.pricing.propFairCalibration = loadConfigWith(JSON.stringify({ 'player_hitter_hr.over': 0.93 }));
  try {
    const m = await priceK(['k-under-a', 'k-over-b'], 'k-cal-1');
    const cal = [].concat(m.propFairCalibs || []);
    assert.equal(cal.length, 1, `exactly the under leg is calibrated, got ${JSON.stringify(cal)}`);
    assert.strictEqual(cal[0].mult, 1.19);
    assert.ok(near(cal[0].from, 0.44, 1e-4) && near(cal[0].to, 0.5236, 1e-4), `0.44 -> 0.5236, got ${JSON.stringify(cal[0])}`);
    // It reaches the parlay fair: 0.44 x 1.19 x 0.47 (independent cross-game legs).
    assert.ok(near(m.fairParlayProb, 0.44 * 1.19 * 0.47, 1e-4),
      `fairParlayProb ${m.fairParlayProb} should be ${(0.44 * 1.19 * 0.47).toFixed(5)}`);
    // Env switch-off: the same parlay prices on the raw under fair.
    config.pricing.propFairCalibration = loadConfigWith(JSON.stringify({ 'player_strikeouts.under': 1 }));
    const off = await priceK(['k-under-a', 'k-over-b'], 'k-cal-2');
    assert.equal([].concat(off.propFairCalibs || []).length, 0);
    assert.ok(near(off.fairParlayProb, 0.44 * 0.47, 1e-4));
    assert.ok(m.offeredImpliedProb > off.offeredImpliedProb, 'the calibrated under quotes SHORTER (less generous) odds');
  } finally {
    config.pricing.propFairCalibration = saved;
  }
});

// ---------------------------------------------------------------------------
// 5. Kill-switch: with PITCHER_K_PROPS_ENABLED off, NO K line registers
// ---------------------------------------------------------------------------

const SPORT = 'baseball_mlb';
const SCHED = new Date(Date.now() + 3 * 3600e3).toISOString();
const EVENT_ID = 77123401;
const grp = (arr) => [arr];
const PX_EVENT = {
  event_id: EVENT_ID,
  name: 'Cleveland Guardians at Detroit Tigers',
  sport_name: 'Baseball',
  scheduled: SCHED,
  status: 'not_started',
  competitors: [
    { id: 501, name: 'Detroit Tigers', side: 'home' },
    { id: 502, name: 'Cleveland Guardians', side: 'away' },
  ],
};
function pxMarkets() {
  return [
    { id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
      { line_id: 'kk-ml-det', name: 'Detroit Tigers', display_name: 'Detroit Tigers', competitor_id: 501 },
      { line_id: 'kk-ml-cle', name: 'Cleveland Guardians', display_name: 'Cleveland Guardians', competitor_id: 502 },
    ]) },
    // PX's live K phrasing — the dedicated K branches key on it.
    { id: 21, name: 'Tarik Skubal Total Pitching Strikeouts', type: 'total', market_lines: [
      { line: 5.5, selections: grp([
        { line_id: 'kk-sk-o', name: 'Over 5.5', line: 5.5 },
        { line_id: 'kk-sk-u', name: 'Under 5.5', line: 5.5 },
      ]) },
    ] },
    // A K name the dedicated on-demand branch does NOT recognise (it only
    // knows "Pitching Strikeouts" / "... Thrown"), but the generic MLB prop
    // classifier maps to pitcher_strikeouts — the generic bridge's K route.
    { id: 22, name: 'Tanner Bibee Strikeouts Recorded', type: 'total', market_lines: [
      { line: 6.5, selections: grp([
        { line_id: 'kk-bb-o', name: 'Over 6.5', line: 6.5 },
        { line_id: 'kk-bb-u', name: 'Under 6.5', line: 6.5 },
      ]) },
    ] },
  ];
}
const K_IDS = ['kk-sk-o', 'kk-sk-u', 'kk-bb-o', 'kk-bb-u'];
const K_ALLOW = ['baseball_mlb.pitcher_strikeouts'];
const kFair = async () => ({
  fairProbOver: 0.61, fairProbUnder: 0.4355, booksWithBothSides: 5,
  books: ['pinnacle', 'draftkings', 'fanduel', 'betrivers', 'williamhill_us'],
  method: 'count_dist', fetchedAt: Date.now(),
});

let _seeded = false;
async function withSeed({ kEnabled, allowlist }, fn) {
  const saved = [];
  const patch = (obj, key, val) => { saved.push([obj, key, obj[key]]); obj[key] = val; };
  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [PX_EVENT]);
  patch(px, 'fetchMarkets', async () => pxMarkets());
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => [
    { sport: SPORT, homeTeam: 'Detroit Tigers', awayTeam: 'Cleveland Guardians', commenceTime: SCHED },
  ]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT ? {
    homeTeam: 'Detroit Tigers', awayTeam: 'Cleveland Guardians', commenceTime: SCHED,
    markets: { h2h: [{ name: 'Detroit Tigers', price: -150 }, { name: 'Cleveland Guardians', price: 130 }] },
  } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  // Every K source returns a high-confidence fair, so the ONLY thing standing
  // between the market and the index is the kill-switch.
  patch(oddsFeed, 'lookupPlayerStrikeoutPropFromTheOddsApi', kFair);
  patch(oddsFeed, 'lookupPlayerStrikeoutProp', kFair);
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', kFair);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  patch(config.pricing, 'pitcherKPropsEnabled', kEnabled);
  patch(config.pricing, 'propLaunchAllowlist', new Set(allowlist || []));
  if (config.sportNameMap[SPORT] !== 'Baseball') patch(config.sportNameMap, SPORT, 'Baseball');
  try {
    if (!_seeded) { _seeded = true; await lineManager.seedAllLines(); } else { await lineManager.refreshLines(); }
    return await fn(lineManager.__debugGetLineIndex());
  } finally {
    for (const [obj, key, val] of saved.reverse()) obj[key] = val;
  }
}
const kLinesIn = (idx) => Object.values(idx).filter(l => l && l.marketType === 'player_strikeouts');

// Sanity (non-vacuous harness): with K props ON the same fixture DOES register
// K lines at seed — through the generic allowlist pre-seed, the only live seed
// path for K (the dedicated seed branch never sees a K market: the
// mainMarkets excludePatterns drop "strikeouts"/"pitching" names first).
test('kill-switch sanity: K props ON + allowlisted → the seed registers every K line (the harness can register)', async () => {
  await withSeed({ kEnabled: true, allowlist: K_ALLOW }, (idx) => {
    assert.ok(idx['kk-ml-det'], 'the game line registers (event matched)');
    for (const id of K_IDS) {
      assert.ok(idx[id], `${id} must register when K props are on`);
      assert.equal(idx[id].marketType, 'player_strikeouts');
    }
    assert.strictEqual(idx['kk-sk-u'].fairProb, 0.4355, 'the under registers the bridge\'s under fair');
  });
});

test('kill-switch: K props OFF, allowlist empty → no K line registers', async () => {
  await withSeed({ kEnabled: false }, (idx) => {
    assert.ok(idx['kk-ml-det'], 'the game line still registers');
    assert.deepEqual(kLinesIn(idx).map(l => l.lineId), []);
    for (const id of K_IDS) assert.ok(!idx[id], `${id} must not register`);
  });
});

test('kill-switch: K props OFF but baseball_mlb.pitcher_strikeouts ALLOWLISTED → still no K line (generic pre-seed gated)', async () => {
  await withSeed({ kEnabled: false, allowlist: K_ALLOW }, (idx) => {
    assert.ok(idx['kk-ml-det'], 'the game line still registers');
    assert.deepEqual(kLinesIn(idx).map(l => l.lineId), [],
      'the generic allowlist pre-seed must honour PITCHER_K_PROPS_ENABLED — the allowlist alone never re-opens K props');
  });
});

test('kill-switch sanity: K props ON → a K lineId the seed skipped DOES resolve on demand (both K routes)', async () => {
  await withSeed({ kEnabled: true, allowlist: K_ALLOW }, async () => {
    // Clear the seeded K lines so the on-demand bridges have to do the work.
    const idx = lineManager.__debugGetLineIndex();
    for (const id of K_IDS) delete idx[id];
    for (const id of ['kk-sk-u', 'kk-bb-u']) {
      const r = await lineManager.resolveUnknownLine({ line_id: id, sport_event_id: EVENT_ID, line: id === 'kk-sk-u' ? 5.5 : 6.5 });
      assert.ok(r && r.marketType === 'player_strikeouts', `${id} must resolve on demand with K props on (got ${JSON.stringify(r && r.marketType)})`);
    }
  });
});

test('kill-switch: K props OFF → no K lineId resolves on demand, via the dedicated OR the generic bridge', async () => {
  await withSeed({ kEnabled: false, allowlist: K_ALLOW }, async () => {
    for (const id of K_IDS) {
      assert.ok(!lineManager.__debugGetLineIndex()[id], `${id} must not be seeded`);
      const r = await lineManager.resolveUnknownLine({ line_id: id, sport_event_id: EVENT_ID, line: id.startsWith('kk-sk') ? 5.5 : 6.5 });
      assert.ok(!r || r.marketType !== 'player_strikeouts', `${id} resolved on demand with K props off`);
      assert.ok(!lineManager.__debugGetLineIndex()[id], `${id} must not enter the index`);
    }
  });
});
