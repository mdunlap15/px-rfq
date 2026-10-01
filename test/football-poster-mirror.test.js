// ORDER-BOOK MIRROR for NFL/CFB RFQ prop legs (operator directive 2026-10-01).
//
// "For NFL/CFB RFQs we need to be pricing all markets we are for the PX order
// book. Refer to what we're listing there and how we are pricing them and use
// the same methodology for RFQs."
//
// The single-leg posters (outside this repo) are the reference:
//   nfl_game_cycle.py  — NFL props (PROPKEY) + TD-scorer NOs (TDKEY)
//   cfb_props_cycle.py — CFB props + anytime-TD NOs
// Locked here:
//   1. the four NFL families the RFQ book lacked + last TD classify, extract
//      the player and map to the poster's TOA keys;
//   2. the FAIR is the poster's: probability-space median per side, ONE 2-way
//      de-vig (Shin for NFL — reference numbers produced by the poster's own
//      px_post_client.devig2_shin — proportional for CFB), NFL Pinnacle anchor
//      within 4pp; anytime TD = median of raw × T / Σfield;
//   3. registration windows (FOOTBALL_PROP_WINDOWS=poster), the one-line rule
//      shared by the seed and the on-demand bridge, the ESPN availability gate,
//      and the never-shorter-than-fair clamp on the TD mirror.
//
// Run: node --test test/football-poster-mirror.test.js

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lineManager = require('../services/line-manager');
const ws = require('../services/websocket');
const px = require('../services/prophetx');
const oddsFeed = require('../services/odds-feed');
const injuries = require('../services/football-injuries');
const db = require('../services/db');
const { config } = require('../config');

const LM_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const imp = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));

// ---------------------------------------------------------------- 1. markets

test('the four NFL families + last TD classify and extract the player (PX phrasing, nfl_game_cycle SUFP)', () => {
  const C = ws._classifyFootballProp, X = ws._extractPlayerNameFromPropMarket;
  const cases = [
    ['Joe Burrow Total Passing & Rushing Yards', 'pass_rush_yards', 'Joe Burrow'],
    ['Joe Burrow Total Passing + Rushing Yards', 'pass_rush_yards', 'Joe Burrow'],
    ['Joe Burrow Total Passing Attempts', 'pass_attempts', 'Joe Burrow'],
    ['Derrick Henry Total Rushing Attempts', 'rush_attempts', 'Derrick Henry'],
    ['Joe Burrow Longest Pass', 'longest_pass', 'Joe Burrow'],
    ['Khalil Shakir To Score Last Touchdown', 'last_td', 'Khalil Shakir'],
  ];
  for (const [name, type, who] of cases) {
    assert.equal(C(name), type, name);
    assert.equal(X(name), who, name);
  }
  // Unchanged neighbours (ordering traps)
  assert.equal(C('Travis Kelce Longest Reception'), 'longest_reception');
  assert.equal(C('Joe Burrow Passing Yards'), 'passing_yards');
  assert.equal(C('Derrick Henry Rushing Yards'), 'rushing_yards');
  assert.equal(C('Khalil Shakir To Score First Touchdown'), 'first_td');
  // The ampersand carve-out is the STAT phrase only — a two-player composite still fails closed.
  assert.equal(C('Joe Burrow or Jake Browning Total Passing & Rushing Yards'), null);
  assert.equal(C('Joe Burrow & Jake Browning Total Passing & Rushing Yards'), null);
});

test('the new families map to the poster\'s TOA keys; two-sided vs lineless as the poster prices them', () => {
  const M = lineManager._FOOTBALL_PROP_TO_TOA_MARKET;
  assert.equal(M.pass_rush_yards, 'player_pass_rush_yds');
  assert.equal(M.pass_attempts, 'player_pass_attempts');
  assert.equal(M.rush_attempts, 'player_rush_attempts');
  assert.equal(M.longest_pass, 'player_pass_longest_completion', 'player_pass_longest 422s — the key is _completion');
  assert.equal(M.last_td, 'player_last_td');
  for (const t of ['pass_rush_yards', 'pass_attempts', 'rush_attempts', 'longest_pass']) {
    assert.ok(lineManager._FOOTBALL_PROP_TWO_SIDED.has(t), t + ' is two-sided');
    assert.equal(lineManager._footballPropCtx(t), null, t + ' carries a real point');
  }
  assert.deepEqual(lineManager._footballPropCtx('last_td'), { propType: 'last_td', line: 0.5, toaLine: null });
  assert.ok(!lineManager._FOOTBALL_PROP_TWO_SIDED.has('last_td'));
  assert.ok(config.pricing.closedFieldOneSidedMarkets.includes('player_last_td'), 'last TD is a closed field');
  assert.ok(px.isFootballPropMarketTypeSafe('player_pass_rush_yards'));
  assert.ok(px.isFootballPropMarketTypeSafe('player_last_td'));
});

// ---------------------------------------------------------------- 2. fair

test('Shin de-vig reproduces the poster (px_post_client.devig2_shin reference values)', () => {
  const S = oddsFeed._shinDeVig2;
  // [americanA, americanB, python devig2_shin(a, b)[0]]
  for (const [a, b, want] of [[-150, 120, 0.5727272727272728], [-300, 240, 0.7279411764705882],
    [-110, -110, 0.5], [-500, 350, 0.8055555555555555]]) {
    const r = S(imp(a), imp(b));
    assert.ok(close(r[0], want, 1e-9), `${a}/${b}: ${r[0]} vs ${want}`);
    assert.ok(close(r[0] + r[1], 1));
  }
  // Shin rates the favourite ABOVE proportional (why the poster uses it)
  const q1 = imp(-300), q2 = imp(240);
  assert.ok(S(q1, q2)[0] > q1 / (q1 + q2));
});

const BOOKS = { draftkings: [-120, -110], fanduel: [-115, -115], betmgm: [-125, -105], pinnacle: [-118, -108] };
const pairs = (b) => Object.fromEntries(Object.entries(b).map(([k, [o, u]]) => [k, { over: imp(o), under: imp(u) }]));

test('NFL fair = Shin of the prob-space median pair, Pinnacle-anchored within 4pp (nfl_game_cycle.source)', () => {
  const F = oddsFeed._footballPosterPropFair;
  const r = F('americanfootball_nfl', pairs(BOOKS), 0.04);
  // python: pair_fair(-118, -108) — Pinnacle within the gap → Pinnacle's own pair
  assert.equal(r.anchor, 'pinnacle');
  assert.ok(close(r.fairOver, 0.5110268172194777, 1e-9), String(r.fairOver));
  assert.equal(r.devig, 'shin');
  // Stale Pinnacle (> 4pp off) → consensus kept: python pair_fair(am(med A), am(med B))
  const stale = Object.assign({}, BOOKS, { pinnacle: [-200, 160] });
  const r2 = F('americanfootball_nfl', pairs(stale), 0.04);
  assert.equal(r2.anchor, 'consensus(pin_stale)');
  const A = Object.values(stale).map(v => imp(v[0])).sort((x, y) => x - y);
  const B = Object.values(stale).map(v => imp(v[1])).sort((x, y) => x - y);
  const want = oddsFeed._shinDeVig2((A[1] + A[2]) / 2, (B[1] + B[2]) / 2)[0];
  assert.ok(close(r2.fairOver, want), 'median in PROBABILITY space, then Shin');
  // Without Pinnacle: python consensus = 0.5109246640209942 on the original 4 books (pin included in the median)
  const r3 = F('americanfootball_nfl', pairs(BOOKS), 1e-9);   // gap ~0 → anchor refused
  assert.ok(close(r3.fairOver, 0.5109246640209942, 1e-9), String(r3.fairOver));
});

test('CFB fair = PROPORTIONAL de-vig of the median pair, no Pinnacle anchor (cfb_props_cycle)', () => {
  const r = oddsFeed._footballPosterPropFair('americanfootball_ncaaf', pairs(BOOKS), 0.04);
  assert.equal(r.devig, 'proportional');
  assert.equal(r.anchor, 'consensus');
  assert.ok(close(r.fairOver, 0.5102589637505258, 1e-9), String(r.fairOver));
  assert.equal(oddsFeed._footballPosterPropFair('americanfootball_cfl', pairs(BOOKS), 0.04), null,
    'CFL has no poster — legacy fair');
});

// End-to-end through the REAL lookup (fetch stubbed): the poster fair replaces
// the per-book average for football, and FOOTBALL_PROP_FAIR_METHOD=legacy reverts.
const FUTURE = new Date(Date.now() + 3600e3).toISOString();
const realFetch = global.fetch;
const outcomes = (o, u, pt, who) => [
  { name: 'Over', description: who, point: pt, price: o },
  { name: 'Under', description: who, point: pt, price: u },
];
global.fetch = async (url) => {
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(j)) });
  if (u.includes('/v4/sports/americanfootball_nfl/events?')) {
    return ok([{ id: 'nflev1', home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: FUTURE }]);
  }
  if (u.includes('/events/nflev1/odds') && u.includes('player_pass_attempts')) {
    return ok({ bookmakers: Object.entries(BOOKS).map(([k, [o, un]]) => ({
      key: k, markets: [{ key: 'player_pass_attempts', outcomes: outcomes(o, un, 33.5, 'Bo Nix') }],
    })) });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
process.on('exit', () => { global.fetch = realFetch; });

test('lookupTheOddsApiPlayerProp: NFL two-sided props price off the poster fair; legacy reverts', async () => {
  const ctx = { homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', startTime: FUTURE };
  const r = await oddsFeed.lookupTheOddsApiPlayerProp('americanfootball_nfl', 'player_pass_attempts', ctx, 'Bo Nix', 33.5);
  assert.equal(r.booksWithBothSides, 4);
  assert.ok(close(r.fairProbOver, 0.5110268172194777, 1e-9), `poster fair, got ${r.fairProbOver}`);
  assert.equal(r.method, 'poster_shin_pinnacle');
  const saved = config.pricing.footballPropFairMethod;
  try {
    config.pricing.footballPropFairMethod = 'legacy';
    const L = await oddsFeed.lookupTheOddsApiPlayerProp('americanfootball_nfl', 'player_pass_attempts', ctx, 'Bo Nix', 33.5);
    const avg = Object.values(BOOKS).map(([o, u]) => imp(o) / (imp(o) + imp(u))).reduce((a, b) => a + b, 0) / 4;
    assert.ok(close(L.fairProbOver, avg, 1e-12), 'legacy = per-book proportional average');
    assert.equal(L.method, 'exact_line_devig');
  } finally { config.pricing.footballPropFairMethod = saved; }
});

test('anytime TD fair = median over books of raw × T / Σfield (the posters\' TFIELD)', () => {
  const F = oddsFeed._openFieldTdFair;
  // Each book prices the SAME player differently relative to its own field
  // (a uniform rescale is invariant under raw × T / Σ, so it would not test the median).
  const field = (top) => [top].concat(Array.from({ length: 23 }, (_, i) => 0.48 - i * 0.018));
  const dk = field(0.50), fd = field(0.62), mgm = field(0.45);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const r = F({ dk, fd, mgm }, { dk: dk[0], fd: fd[0], mgm: mgm[0] }, 4.10);
  const vals = [dk[0] * 4.1 / sum(dk), fd[0] * 4.1 / sum(fd), mgm[0] * 4.1 / sum(mgm)].sort((a, b) => a - b);
  assert.equal(r.books, 3);
  assert.ok(close(r.fair, vals[1]), 'MEDIAN, not mean');
  // a partial board (6 outcomes) is not a field
  assert.equal(F({ dk: dk.slice(0, 6) }, { dk: dk[0] }, 4.10), null);
  assert.equal(F({ dk }, { dk: 0.333 }, 4.10), null, 'player price must be in the field');
  assert.deepEqual(config.pricing.footballAnytimeTdFieldT,
    { americanfootball_nfl: 4.10, americanfootball_nfl_preseason: 4.10, americanfootball_ncaaf: 5.0 });
});

// ---------------------------------------------------------------- 3. gates

function withCfg(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = config.pricing[k]; config.pricing[k] = patch[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) config.pricing[k] = saved[k]; }
}
const POSTER = {
  americanfootball_nfl: { props: 60, td: 60, monThuProps: 120, monThuTd: 360, late: { receptions: 60 } },
  americanfootball_ncaaf: { props: 120, td: 120 },
};

test('windows: unset → the single global window (pre-mirror behaviour)', () => {
  withCfg({ footballPropWindows: null, footballPropTMinusMinutes: 1440 }, () => {
    const W = lineManager._footballPropWindowMinutes;
    assert.equal(W('americanfootball_nfl', '2026-10-04T17:00:00Z', 'passing_yards'), 1440);
    assert.equal(W('americanfootball_ncaaf', '2026-10-04T17:00:00Z', 'anytime_td'), 1440);
  });
});

test('windows: poster preset — NFL T-60 (Mon/Thu props T-120, TDs T-360, receptions T-60), CFB T-120', () => {
  withCfg({ footballPropWindows: POSTER, footballPropTMinusMinutes: 1440 }, () => {
    const W = lineManager._footballPropWindowMinutes;
    const SUN = '2026-10-04T17:00:00Z';   // Sun 1pm ET
    const MON = '2026-10-06T00:15:00Z';   // Mon 8:15pm ET (UTC Tuesday — the ET weekday decides)
    const THU = '2026-10-02T00:15:00Z';   // Thu 8:15pm ET
    assert.equal(lineManager._etWeekday(Date.parse(MON)), 1, 'MNF is Monday in ET even though UTC says Tuesday');
    assert.equal(W('americanfootball_nfl', SUN, 'passing_yards'), 60);
    assert.equal(W('americanfootball_nfl', SUN, 'anytime_td'), 60);
    assert.equal(W('americanfootball_nfl', MON, 'passing_yards'), 120);
    assert.equal(W('americanfootball_nfl', MON, 'first_td'), 360);
    assert.equal(W('americanfootball_nfl', THU, 'last_td'), 360);
    assert.equal(W('americanfootball_nfl', MON, 'receptions'), 60, 'receptions stay T-60 every day (LATE_SUBS)');
    assert.equal(W('americanfootball_ncaaf', SUN, 'rushing_yards'), 120);
    assert.equal(W('americanfootball_ncaaf', SUN, 'anytime_td'), 120);
    assert.equal(W('americanfootball_cfl', SUN, 'passing_yards'), 1440, 'no poster → global');
  });
});

test('one line per (player, market): best-booked point, ties to the middle, none cleared → null', () => {
  const B = lineManager._footballBestPropPoint;
  assert.equal(B([{ line: 212.5, books: 2 }, { line: 213.5, books: 5 }, { line: 215.5, books: 3 }]), 213.5);
  assert.equal(B([{ line: 19.5, books: 4 }, { line: 20.5, books: 4 }, { line: 21.5, books: 4 }]), 20.5);
  assert.equal(B([{ line: 19.5, books: 0 }, { line: 20.5, books: 0 }]), null);
  assert.equal(B([]), null);
});

test('ON-DEMAND football uses the seed\'s rules: window, ESPN gate, best point, absolute 3-book floor', () => {
  const at = LM_SRC.indexOf('FOOTBALL ON-DEMAND = THE SEED\'S RULES');
  assert.ok(at > -1);
  const body = LM_SRC.slice(at, at + 6000);
  assert.ok(/_footballPropWindowOpen\(sportKey, event\.scheduled, propType\)/.test(body), 'window gate');
  assert.ok(/getBlockedPlayers\(sportKey, matchedAway, matchedHome/.test(body), 'ESPN gate');
  assert.ok(/_footballBestPropPoint\(scored\)/.test(body), 'one-line rule');
  assert.ok(/const minBooks = isFb\s*\?\s*\(\(config\.pricing && config\.pricing\.footballPropMinBooks\) \|\| 3\)/.test(body), 'football floor');
  assert.ok(/const trustedSet = isFb \? \[\] :/.test(body), 'no trusted-book escape for football');
});

test('ESPN availability: Out/IR/Doubtful block, Questionable does not; unmatched game → inactive (null)', async () => {
  const sb = { events: [
    { id: 'g1', date: FUTURE, competitions: [{ competitors: [
      { team: { displayName: 'Kansas City Chiefs' } }, { team: { displayName: 'Denver Broncos' } }] }] },
  ] };
  const sm = { injuries: [{ injuries: [
    { athlete: { displayName: 'Travis Kelce' }, status: 'Out' },
    { athlete: { displayName: 'Courtland Sutton' }, status: 'Questionable' },
    { athlete: { displayName: 'Kenneth Walker III' }, status: 'Doubtful' },
  ] }] };
  injuries._setFetcher(async (url) => (url.includes('scoreboard') ? sb : url.includes('summary?event=g1') ? sm : null));
  try {
    const b = await injuries.getBlockedPlayers('americanfootball_nfl', 'Denver Broncos', 'Kansas City Chiefs', FUTURE);
    assert.equal(injuries.statusFor(b, 'Travis Kelce'), 'Out');
    assert.equal(injuries.statusFor(b, 'Kenneth Walker'), 'Doubtful', 'suffix-insensitive like player_status.sig');
    assert.equal(injuries.statusFor(b, 'Courtland Sutton'), null, 'Questionable is NOT blocked');
    const none = await injuries.getBlockedPlayers('americanfootball_nfl', 'New York Jets', 'Miami Dolphins', FUTURE);
    assert.equal(none, null, 'no unique game → gate inactive (fail-open)');
    assert.equal(await injuries.getBlockedPlayers('americanfootball_cfl', 'A', 'B', FUTURE), null);
  } finally { injuries._setFetcher(null); }
});

// ---------------------------------------------------------------- 4. seed (real seedAllLines, stubbed I/O)

const SPORT = 'americanfootball_nfl';
const SCHED = new Date(Date.now() + 45 * 60e3).toISOString();
const grp = (arr) => [arr];
const PX_EVENT = {
  event_id: 77001, name: 'Denver Broncos at Kansas City Chiefs', sport_name: 'American Football',
  scheduled: SCHED, status: 'not_started',
  competitors: [{ id: 201, name: 'Kansas City Chiefs', side: 'home' }, { id: 202, name: 'Denver Broncos', side: 'away' }],
};
const ou = (id, pt) => ({ line: pt, selections: grp([
  { line_id: `${id}-o-${pt}`, name: `Over ${pt}`, line: pt },
  { line_id: `${id}-u-${pt}`, name: `Under ${pt}`, line: pt },
]) });
function pxMarkets() {
  return [
    { id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
      { line_id: 'ml-kc', name: 'Kansas City Chiefs', competitor_id: 201 },
      { line_id: 'ml-den', name: 'Denver Broncos', competitor_id: 202 },
    ]) },
    { id: 11, name: 'Bo Nix Total Passing Attempts', type: 'total', market_lines: [ou('pa', 32.5), ou('pa', 33.5)] },
    { id: 12, name: 'Bo Nix Total Passing & Rushing Yards', type: 'total', market_lines: [ou('pry', 250.5)] },
    { id: 13, name: 'Travis Kelce Total Receptions', type: 'total', market_lines: [ou('rec', 5.5)] },
    // PX types first/last TD 'moneyline' with YES/NO selections (the generic
    // parse keeps outcomeName, which the lineless YES filter reads).
    { id: 14, name: 'Courtland Sutton To Score Last Touchdown', type: 'moneyline', selections: grp([
      { line_id: 'ltd-yes', name: 'Yes' }, { line_id: 'ltd-no', name: 'No' },
    ]) },
    { id: 15, name: 'Courtland Sutton To Score a Touchdown', type: 'sup_moneyline', selections: grp([
      { line_id: 'atd-yes', name: 'Yes' }, { line_id: 'atd-no', name: 'No' },
    ]) },
  ];
}
let _seeded = false;
async function runSeed({ allowlist, propLookup, propOneSided, injuryFetch, pricing } = {}) {
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
    { sport: SPORT, homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', commenceTime: SCHED }]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport) => (sport === SPORT
    ? { homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos', commenceTime: SCHED, markets: { h2h: {} } } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', propLookup || (async () => null));
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', propOneSided || (async () => null));
  patch(config.pricing, 'propLaunchAllowlist', allowlist);
  for (const [k, v] of Object.entries(pricing || {})) patch(config.pricing, k, v);
  if (config.sportNameMap[SPORT] !== 'American Football') patch(config.sportNameMap, SPORT, 'American Football');
  injuries._setFetcher(injuryFetch || (async () => null));
  try {
    if (!_seeded) { _seeded = true; await lineManager.seedAllLines(); } else { await lineManager.refreshLines(); }
    return Object.assign({}, lineManager.__debugGetLineIndex());
  } finally {
    injuries._setFetcher(null);
    for (const [obj, key, val] of saved.reverse()) obj[key] = val;
  }
}
const ALL = new Set(['pass_attempts', 'pass_rush_yards', 'receptions', 'last_td', 'anytime_td'].map(t => SPORT + '.' + t));
const twoSided = (booksByLine) => async (sport, key, ctx, player, line) => {
  const n = booksByLine[`${key}|${line}`];
  if (!n) return null;
  return { fairProbOver: 0.52, fairProbUnder: 0.48, booksWithBothSides: n, books: ['draftkings', 'fanduel', 'betmgm'] };
};

test('seed: the new NFL families register at the best-booked point only, marketType player_*', async () => {
  const idx = await runSeed({
    allowlist: ALL,
    propLookup: twoSided({ 'player_pass_attempts|32.5': 3, 'player_pass_attempts|33.5': 5, 'player_pass_rush_yds|250.5': 4 }),
  });
  assert.ok(idx['pa-o-33.5'] && idx['pa-u-33.5'], 'best-booked 33.5 registers both sides');
  assert.ok(!idx['pa-o-32.5'] && !idx['pa-u-32.5'], 'the alt 32.5 never registers');
  assert.equal(idx['pa-o-33.5'].marketType, 'player_pass_attempts');
  assert.equal(idx['pa-o-33.5'].playerName, 'Bo Nix');
  assert.equal(idx['pa-o-33.5'].oddsApiMarket, 'player_pass_attempts');
  assert.ok(idx['pry-o-250.5'], 'Total Passing & Rushing Yards registers');
  assert.equal(idx['pry-o-250.5'].marketType, 'player_pass_rush_yards');
  assert.equal(idx['pry-o-250.5'].oddsApiMarket, 'player_pass_rush_yds');
});

test('seed: last TD registers YES only (closed-field one-sided mirror), marketType player_last_td', async () => {
  const idx = await runSeed({
    allowlist: ALL,
    propOneSided: async (sport, key) => (key === 'player_last_td' ? {
      fairProbOver: 0.05, oneSidedSource: 'toa-one-sided', oneSidedRawAvgImplied: 0.08,
      books: ['draftkings', 'fanduel', 'betmgm'], fetchedAt: Date.now() } : null),
  });
  assert.ok(idx['ltd-yes'], 'YES registers');
  assert.ok(!idx['ltd-no'], 'NO never registers');
  assert.equal(idx['ltd-yes'].marketType, 'player_last_td');
  assert.equal(idx['ltd-yes'].selection, 'over');
});

test('seed: TD mirror is never shorter than fair — the sweetened YES is clamped up to fair YES', async () => {
  const idx = await runSeed({
    allowlist: ALL,
    pricing: { propBookMirrorSweetener: 0.02 },
    propOneSided: async (sport, key) => (key === 'player_anytime_td' ? {
      fairProbOver: 0.40, oneSidedSource: 'toa-one-sided', oneSidedRawAvgImplied: 0.401,
      books: ['draftkings', 'fanduel', 'betmgm'], fetchedAt: Date.now() } : null),
  });
  const td = idx['atd-yes'];
  assert.ok(td);
  // raw 0.401 × 0.98 = 0.39298 < fair 0.40 → clamped to 0.40
  assert.ok(close(td.bookPriceOverride, 0.40), String(td.bookPriceOverride));
});

test('seed: ESPN availability gate drops an Out player\'s props; Questionable stays', async () => {
  const sb = { events: [{ id: 'g9', date: SCHED, competitions: [{ competitors: [
    { team: { displayName: 'Kansas City Chiefs' } }, { team: { displayName: 'Denver Broncos' } }] }] }] };
  const sm = { injuries: [{ injuries: [
    { athlete: { displayName: 'Travis Kelce' }, status: 'Out' },
    { athlete: { displayName: 'Bo Nix' }, status: 'Questionable' },
  ] }] };
  const idx = await runSeed({
    allowlist: ALL,
    pricing: { footballPropInjuryGate: true },
    injuryFetch: async (u) => (u.includes('scoreboard') ? sb : u.includes('summary?event=g9') ? sm : null),
    propLookup: twoSided({ 'player_receptions|5.5': 4, 'player_pass_attempts|33.5': 4 }),
  });
  assert.ok(!idx['rec-o-5.5'] && !idx['rec-u-5.5'], 'Kelce (Out) never registers');
  assert.ok(idx['pa-o-33.5'], 'Nix (Questionable) registers');
  // gate off → Kelce registers
  const idx2 = await runSeed({
    allowlist: ALL,
    pricing: { footballPropInjuryGate: false },
    injuryFetch: async (u) => (u.includes('scoreboard') ? sb : u.includes('summary?event=g9') ? sm : null),
    propLookup: twoSided({ 'player_receptions|5.5': 4 }),
  });
  assert.ok(idx2['rec-o-5.5'], 'gate off → registers');
});

test('seed: poster windows — a Sunday NFL prop 45 min out registers; receptions at T-90 does not', async () => {
  const idx = await runSeed({
    allowlist: ALL,
    pricing: { footballPropWindows: POSTER },
    propLookup: twoSided({ 'player_receptions|5.5': 4, 'player_pass_attempts|33.5': 4 }),
  });
  // SCHED is 45 min out → inside T-60 whatever the weekday
  assert.ok(idx['rec-o-5.5'] && idx['pa-o-33.5']);
  const far = new Date(Date.now() + 90 * 60e3).toISOString();
  const dow = lineManager._etWeekday(Date.parse(far));
  const saved = PX_EVENT.scheduled;
  PX_EVENT.scheduled = far;
  try {
    const idx2 = await runSeed({
      allowlist: ALL,
      pricing: { footballPropWindows: POSTER },
      propLookup: twoSided({ 'player_receptions|5.5': 4, 'player_pass_attempts|33.5': 4 }),
    });
    assert.ok(!idx2['rec-o-5.5'], 'receptions is T-60 every day');
    assert.equal(!!idx2['pa-o-33.5'], dow === 1 || dow === 4, 'other props: T-120 on Mon/Thu, T-60 otherwise');
  } finally { PX_EVENT.scheduled = saved; }
});
