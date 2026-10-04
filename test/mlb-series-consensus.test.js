// MLB playoff SERIES WINNER legs on the ORDER-BOOK methodology (2026-10-04).
//
// Operator: "we should be quoting MLB playoff series prices in between games of
// the series" + "I don't want to derive any of our own lines; I want ours to
// always be direct references to the lines of sportsbooks" + "use the
// methodology we use for the order book lines".
//
// Reference (read-only): ~/mlb_series_consensus.py (sources + rules),
// ~/mlb_series_post.py price_pair() (pricing), ~/dk-mlb-series.js,
// ~/bo-mlb-series.js. Fixtures are REAL captures from 2026-10-04 ~00:55 ET:
// one DK XHR body, one BetOnline page text, one Bovada coupon. On those three,
// the consensus reproduces ~/cons_mlb_series.json (the Python builder's output
// from the same minute) number for number.
//
// Run: node --test test/mlb-series-consensus.test.js

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
for (const k of ['SERIES_MIN_BOOKS', 'SERIES_MIN_BOOKS_PAIRS', 'SERIES_MAX_GAP_PP', 'SERIES_OVR_LO', 'SERIES_OVR_HI',
  'SERIES_SRC_MAX_AGE_S', 'SERIES_MIN_EV', 'SERIES_MAX_SUM', 'SERIES_MAX_ASK', 'SERIES_WORST_BOOK_CLAMP']) delete process.env[k];

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('../services/mlb-series-consensus');
const dk = require('../services/dk-scraper');
const seriesWindow = require('../services/series-window');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FIX = path.join(__dirname, 'fixtures');
const DK_XHR = JSON.parse(fs.readFileSync(path.join(FIX, 'dk-mlb-series-xhr-2026-10-04.json'), 'utf8'));
const BO_TEXT = fs.readFileSync(path.join(FIX, 'betonline-mlb-series-2026-10-04.txt'), 'utf8');
const BOV = JSON.parse(fs.readFileSync(path.join(FIX, 'bovada-mlb-series-coupon-2026-10-04.json'), 'utf8'));

const H = 3600e3;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function dkBoard() {
  const markets = {}, events = {};
  dk.extractMlbSeriesMarkets(DK_XHR, markets, events);
  return { via: 'fixture', url: 'fixture', markets: dk.buildMlbSeriesMarkets(markets, events) };
}
function perBookFromFixtures() {
  const drops = [];
  return {
    draftkings: C.srcDk(dkBoard(), drops, { year: 2026 }),
    betonline: C.srcBo({ matchups: C.parseBoText(BO_TEXT) }, drops),
    bovada: C.srcBovada(BOV, drops),
  };
}
function installFixtures(at = Date.now()) {
  const pb = perBookFromFixtures();
  for (const b of C.BOOKS) C.__setSourceForTest(b, pb[b], at);
}

// ---------------------------------------------------------------- 1. sources
test('DK: the live XHR yields the four Division Series, U+2212 normalised, keyed by club', () => {
  const board = dkBoard();
  assert.equal(board.markets.length, 4);
  assert.ok(board.markets.every(m => m.marketType === 'Series Winner' && m.selections.length === 2));
  assert.ok(board.markets.every(m => m.selections.every(s => !/−/.test(s.odds))));
  const pairs = C.srcDk(board, [], { year: 2026 });
  assert.deepEqual(pairs, {
    'braves|dodgers': { dodgers: -350, braves: 280 },
    'brewers|padres': { brewers: -310, padres: 250 },
    'guardians|white sox': { 'white sox': -190, guardians: 160 },
    'rays|yankees': { rays: -190, yankees: 160 },
  });
});

test('DK: zero markets is a source ERROR; suspended / other-season / duplicate claims are dropped', () => {
  assert.throws(() => C.srcDk({ markets: [], via: 'none' }), /0 Series Winner markets/);
  const m = (name, sels, extra = {}) => Object.assign({ name, marketType: 'Series Winner', selections: sels }, extra);
  const drops = [];
  const out = C.srcDk({ markets: [
    m('MLB 2026 - LA Dodgers vs ATL Braves - Series Winner', [{ team: 'LA Dodgers', odds: '-350' }, { team: 'ATL Braves', odds: '+280' }], { suspended: true }),
    m('MLB 2025 - TB Rays vs NY Yankees - Series Winner', [{ team: 'TB Rays', odds: '-190' }, { team: 'NY Yankees', odds: '+160' }]),
    m('MLB 2026 - CLE Guardians vs CHI White Sox - Series Winner', [{ team: 'CHI White Sox', odds: '-190' }, { team: 'CLE Guardians', odds: '+160' }]),
    m('MLB 2026 - CLE Guardians vs CHI White Sox (dup) - Series Winner', [{ team: 'CHI White Sox', odds: '-185' }, { team: 'CLE Guardians', odds: '+155' }]),
    m('MLB 2026 - MIL Brewers vs SD Padres - Series Winner', [{ team: 'MIL Brewers', odds: '-310' }, { team: 'SD Padres', odds: '+250' }]),
  ] }, drops, { year: 2026 });
  assert.deepEqual(Object.keys(out), ['brewers|padres']);
  assert.ok(drops.some(d => /suspended/.test(d)) && drops.some(d => /not this season/.test(d)) && drops.some(d => /2 markets claim guardians\|white sox/.test(d)), drops.join(' / '));
  // A suspended SELECTION is dropped at capture (the script's write()), which
  // leaves a one-sided market that never counts.
  const x = JSON.parse(JSON.stringify(DK_XHR));
  x.selections.find(s => s.label === 'SD Padres').isSuspended = true;
  const mk = {}, ev = {};
  dk.extractMlbSeriesMarkets(x, mk, ev);
  const pairs = C.srcDk({ markets: dk.buildMlbSeriesMarkets(mk, ev) }, [], { year: 2026 });
  assert.equal(pairs['brewers|padres'], undefined);
  assert.equal(Object.keys(pairs).length, 3);
});

test('BetOnline: the live page text parses to its three priced series; only "Series Price" rows count', () => {
  const rows = C.parseBoText(BO_TEXT);
  assert.deepEqual(rows, [
    { a: 'Braves Series Price', b: 'Dodgers Series Price', ml: { a: 324, b: -410 } },
    { a: 'White Sox Series Price', b: 'Guardians Series Price', ml: { a: -185, b: 161 } },
    { a: 'Yankees Series Price', b: 'Rays Series Price', ml: { a: 165, b: -190 } },
  ]);
  // The same page family lists single-game moneylines — never a series price.
  const out = C.srcBo({ matchups: rows.concat([{ a: 'Brewers', b: 'Padres', ml: { a: -150, b: 130 } }]) });
  assert.deepEqual(Object.keys(out).sort(), ['braves|dodgers', 'guardians|white sox', 'rays|yankees']);
  assert.throws(() => C.srcBo({ matchups: [] }), /0 priced pairings/);
});

test('Bovada: the live coupon yields four series; live events and suspended markets are skipped', () => {
  const out = C.srcBovada(BOV);
  assert.deepEqual(out['braves|dodgers'], { braves: 275, dodgers: -350 });
  assert.deepEqual(out['rays|yankees'], { yankees: 162, rays: -197 });
  assert.equal(Object.keys(out).length, 4);
  const doctored = JSON.parse(JSON.stringify(BOV));
  doctored[0].events[0].live = true;                                      // Padres @ Brewers
  doctored[0].events[1].displayGroups[0].markets.find(m => m.description === 'Series Winner').status = 'S';
  const drops = [];
  const d = C.srcBovada(doctored, drops);
  assert.deepEqual(Object.keys(d).sort(), ['braves|dodgers', 'rays|yankees']);
  assert.equal(drops.length, 2);
  // A group outside "Series Prices > Playoff Series" is not read at all.
  const other = JSON.parse(JSON.stringify(BOV));
  other[0].path = [{ description: 'MLB Futures' }];
  assert.deepEqual(C.srcBovada(other), {});
});

test('team keys: White Sox and Red Sox are different clubs; suffixes stripped first; a bare "Sox" is no club', () => {
  assert.equal(C.teamKey('Chicago White Sox (Series)'), 'white sox');
  assert.equal(C.teamKey('White Sox Series Price'), 'white sox');
  assert.equal(C.teamKey('CHI White Sox'), 'white sox');
  assert.equal(C.teamKey('BOS Red Sox'), 'red sox');
  assert.equal(C.teamKey('Sox'), '');
  assert.equal(C.teamKey('Toronto Blue Jays'), 'blue jays');
  assert.equal(C.pairKey('Chicago White Sox', 'Boston Red Sox'), 'red sox|white sox');
  assert.equal(C.pairKey('Chicago White Sox', 'CHI White Sox'), '', 'same club twice');
});

// ---------------------------------------------------------------- 2. consensus rules
test('consensus on the live fixtures reproduces the Python builder (cons_mlb_series.json)', () => {
  const { series } = C.consensus(perBookFromFixtures(), { minBooksPairs: {} });
  const bd = series['braves|dodgers'];
  assert.equal(bd.n, 3);
  assert.deepEqual(bd.raw, { braves: 280, dodgers: -350 });
  assert.deepEqual(bd.fair, { braves: 0.252809, dodgers: 0.747191 });
  assert.deepEqual(bd.fair_lo, { braves: 0.226828, dodgers: 0.744681 });
  assert.equal(bd.gap_pp, 2.849);
  assert.equal(bd.decline, null);
  assert.deepEqual(series['guardians|white sox'].fair, { guardians: 0.371166, 'white sox': 0.628834 });
  assert.deepEqual(series['guardians|white sox'].fair_lo, { guardians: 0.369898, 'white sox': 0.628234 });
  assert.deepEqual(series['rays|yankees'].raw, { rays: -190, yankees: 162 });
  assert.deepEqual(series['rays|yankees'].fair_lo, { rays: 0.630102, yankees: 0.365251 });
  // BetOnline had no Padres/Brewers price: 2 books < 3 -> declined.
  assert.equal(series['brewers|padres'].n, 2);
  assert.match(series['brewers|padres'].decline, /^only 2 book\(s\) \(bovada,draftkings\) < 3$/);
});

test('min books: SERIES_MIN_BOOKS and the per-pair SERIES_MIN_BOOKS_PAIRS override (the order book runs brewers|padres:2)', () => {
  process.env.SERIES_MIN_BOOKS_PAIRS = 'rays|yankees:2,brewers|padres:2';
  try {
    const { series } = C.consensus(perBookFromFixtures());
    assert.equal(series['brewers|padres'].decline, null);
    // two books: the median is the AVERAGE of the two (statistics.median)
    assert.ok(close(series['brewers|padres'].fair.brewers, 0.725753));
  } finally { delete process.env.SERIES_MIN_BOOKS_PAIRS; }
  process.env.SERIES_MIN_BOOKS = '4';
  try {
    const { series } = C.consensus(perBookFromFixtures());
    assert.ok(Object.values(series).every(r => /< 4$/.test(r.decline)));
  } finally { delete process.env.SERIES_MIN_BOOKS; }
});

test('overround outside [1.01, 1.12] drops that book for the pair (and can push it under the floor)', () => {
  const pb = {
    a: { 'rays|yankees': { rays: -190, yankees: 162 } },
    b: { 'rays|yankees': { rays: -190, yankees: 160 } },
    c: { 'rays|yankees': { rays: -105, yankees: -105 } },      // 1.024 ok
    d: { 'rays|yankees': { rays: 150, yankees: 150 } },        // 0.80 -> rejected
    e: { 'rays|yankees': { rays: -300, yankees: -150 } },      // 1.35 -> rejected
  };
  const { series, rejected } = C.consensus(pb, { minBooksPairs: {}, maxGapPp: 50 });
  assert.equal(series['rays|yankees'].n, 3);
  assert.deepEqual(Object.keys(rejected['rays|yankees']).sort(), ['d', 'e']);
  const { series: s2 } = C.consensus({ a: pb.a, d: pb.d, e: pb.e }, { minBooksPairs: {} });
  assert.match(s2['rays|yankees'].decline, /only 1 book/);
});

test('books disagreeing by more than 3pp decline; fair_lo is the least favourable book per side; median is the middle book', () => {
  const pb = {
    a: { 'cubs|padres': { padres: -120, cubs: 100 } },
    b: { 'cubs|padres': { padres: -125, cubs: 105 } },
    c: { 'cubs|padres': { padres: -140, cubs: 120 } },
  };
  const fa = ['a', 'b', 'c'].map(k => { const q = pb[k]['cubs|padres']; const ia = C.imp(q.cubs), ib = C.imp(q.padres); return ia / (ia + ib); });
  const { series } = C.consensus(pb, { minBooksPairs: {} });
  const r = series['cubs|padres'];
  assert.ok(close(r.fair.cubs, [...fa].sort()[1]), 'median of three = the middle book');
  assert.ok(close(r.fair_lo.cubs, Math.min(...fa)));
  assert.ok(close(r.fair_lo.padres, Math.min(...fa.map(x => 1 - x))));
  const gap = 100 * (Math.max(...fa) - Math.min(...fa));
  assert.ok(gap > 3);
  assert.match(r.decline, /books disagree by/);
  // raw = median RAW implied in probability space, back to American
  assert.equal(r.raw.cubs, C.am([C.imp(100), C.imp(105), C.imp(120)].sort()[1]));
});

test('source age: a source older than SERIES_SRC_MAX_AGE_S does not count; the series board time is the OLDEST counted source', () => {
  const now = Date.now();
  const pb = perBookFromFixtures();
  C.__setSourceForTest('draftkings', pb.draftkings, now - 30e3);
  C.__setSourceForTest('betonline', pb.betonline, now - 11 * 60e3);   // past 600 s
  C.__setSourceForTest('bovada', pb.bovada, now - 90e3);
  const c = C.getConsensus(now);
  assert.deepEqual(c.booksRead, ['bovada', 'draftkings']);
  assert.match(c.series['guardians|white sox'].decline, /only 2 book/);
  C.__setSourceForTest('betonline', pb.betonline, now - 5 * 60e3);
  const c2 = C.getConsensus(now);
  assert.equal(c2.series['guardians|white sox'].decline, null);
  assert.equal(c2.series['guardians|white sox'].boardAtMs, now - 5 * 60e3);
  C.__resetForTest();
});

test('a ZERO-market DK scrape clears the book immediately (it is an error, never "DK has no series")', () => {
  installFixtures();
  C.__recordForTest('draftkings', { markets: [], via: 'none', url: 'x' });
  const st = C.getStatus();
  assert.equal(st.sources.draftkings.counted, false);
  assert.match(st.sources.draftkings.error, /0 Series Winner markets/);
  assert.match(st.series['guardians|white sox'].decline, /only 2 book/);
  C.__resetForTest();
});

// ---------------------------------------------------------------- 3. pricing (price_pair translated)
const rec = (o) => C.consensus(o, { minBooksPairs: {}, maxGapPp: 50 }).series[Object.keys(Object.values(o)[0])[0]];

test('price: offered = the median RAW implied of the bettor side (a direct book reference); fair = the median fair', () => {
  const { series } = C.consensus(perBookFromFixtures(), { minBooksPairs: {} });
  const g = C.priceLeg(series['guardians|white sox'], 'guardians');
  assert.ok(g.ok);
  assert.equal(g.bound, 'raw_mirror');
  assert.ok(close(g.offeredProb, C.imp(160)));
  assert.ok(close(g.fairProb, 0.371166));
  const w = C.priceLeg(series['guardians|white sox'], 'white sox');
  assert.ok(close(w.offeredProb, C.imp(-190)));
  assert.ok(w.offeredProb > w.fairProb && g.offeredProb > g.fairProb, 'the mirror keeps the books\' margin');
});

test('price: never better for the bettor than the MOST favourable book\'s fair for that side (1 - fair_lo of ours)', () => {
  // Book c thinks the Cubs are much likelier than the median; the raw median
  // implied for the Cubs sits BELOW c's fair. Offered is raised to c's fair.
  const r = rec({
    a: { 'cubs|padres': { padres: -130, cubs: 110 } },
    b: { 'cubs|padres': { padres: -130, cubs: 110 } },
    c: { 'cubs|padres': { padres: 110, cubs: -130 } },
  });
  const q = C.priceLeg(r, 'cubs', { minEv: 0 });
  assert.ok(q.ok);
  assert.equal(q.bound, 'worst_book_fair');
  assert.ok(close(q.offeredProb, 1 - r.fair_lo.padres));
  assert.ok(q.offeredProb > C.imp(r.raw.cubs));
  // SERIES_WORST_BOOK_CLAMP=0 falls back to the median fair (the raw already beats it here)
  const q0 = C.priceLeg(r, 'cubs', { minEv: 0, worstBookClamp: false });
  assert.equal(q0.bound, 'raw_mirror');
});

test('price: the 1% minimum edge — max of the poster\'s EV on our stake and fair x (1 + e)', () => {
  // A thin, tight market: raw barely over fair.
  const r = rec({
    a: { 'rays|yankees': { rays: -118, yankees: 104 } },
    b: { 'rays|yankees': { rays: -118, yankees: 104 } },
    c: { 'rays|yankees': { rays: -118, yankees: 104 } },
  });
  // At the default 1% the raw mirror already clears it: on a proportional
  // de-vig, raw/fair = the book's overround (>= 1.01, and the 97% pair ceiling
  // demands >= 3%), so the floor only binds on disagreeing books. Exercise the
  // mechanism with a 6% edge, where it binds on both sides.
  for (const side of ['rays', 'yankees']) {
    const f = r.fair[side];
    const q1 = C.priceLeg(r, side);
    assert.ok(q1.ok && q1.offeredProb >= Math.max((f + 0.01) / 1.01, f * 1.01) - 1e-12);
    const e = 0.06;
    const q = C.priceLeg(r, side, { minEv: e });
    assert.ok(q.ok, side + ' ' + q.reason);
    assert.equal(q.bound, 'min_ev');
    const exact = (f + e) / (1 + e), stated = f * (1 + e);
    assert.ok(close(q.offeredProb, Math.max(exact, stated), 1e-12), `${side} ${q.offeredProb}`);
    // our EV per $ risked (= the poster's EV on its own stake) is at least e
    assert.ok((q.offeredProb - f) / (1 - q.offeredProb) >= e - 1e-9);
    // and the bettor-stake reading fair x (1 + e) holds too
    assert.ok(q.offeredProb >= f * (1 + e) - 1e-12);
  }
  // the favourite binds on fair x (1+e), the dog on the poster's exact form
  const fr = r.fair.rays, fy = r.fair.yankees;
  assert.ok(fr * 1.06 > (fr + 0.06) / 1.06 && (fy + 0.06) / 1.06 > fy * 1.06);
  // with the edge floor off, the raw mirror stands
  const q0 = C.priceLeg(r, 'yankees', { minEv: 0 });
  assert.ok(close(q0.offeredProb, C.imp(104)));
});

test('price: our side asking +300 or longer is not quoted (house longshot rule) — Dodgers -350 declines, Braves quotes', () => {
  const { series } = C.consensus(perBookFromFixtures(), { minBooksPairs: {} });
  const d = C.priceLeg(series['braves|dodgers'], 'dodgers');
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'mlb_series_longshot_side');
  const b = C.priceLeg(series['braves|dodgers'], 'braves');
  assert.ok(b.ok);
  assert.ok(close(b.offeredProb, C.imp(280)));
  assert.equal(b.ourAsk, -280);
});

test('price: a raw mirror past the 97% pair ceiling declines; a declined record declines', () => {
  const r = rec({
    a: { 'cubs|padres': { padres: -106, cubs: -104 } },     // overround 1.0244 -> mirror sum 97.6%
    b: { 'cubs|padres': { padres: -106, cubs: -104 } },
    c: { 'cubs|padres': { padres: -106, cubs: -104 } },
  });
  assert.equal(r.decline, null, 'the consensus admits it (overround >= 1.01)');
  assert.equal(C.priceLeg(r, 'cubs').reason, 'mlb_series_pair_ceiling');
  assert.equal(C.priceLeg(r, 'cubs', { maxSum: 0.98 }).ok, true);
  const { series } = C.consensus(perBookFromFixtures(), { minBooksPairs: {} });
  assert.equal(C.priceLeg(series['brewers|padres'], 'padres').reason, 'mlb_series_consensus_declined');
});

// ---------------------------------------------------------------- 4. pricer wiring + window
const MLB = 'baseball_mlb';
function seriesLine(team, home, away, startMs, extra = {}) {
  return Object.assign({
    sport: MLB, oddsApiSport: MLB, marketType: 'series_winner', oddsApiMarket: 'series_winner',
    teamName: `${team} (Series)`, homeTeam: home, awayTeam: away,
    startTime: new Date(startMs).toISOString(), startTimeMs: startMs,
  }, extra);
}

test('getQuoteForLine: matchup-scoped (White Sox vs Red Sox finds nothing), side must be in the pair', () => {
  installFixtures();
  const ok = C.getQuoteForLine(seriesLine('Cleveland Guardians', 'Cleveland Guardians', 'Chicago White Sox', Date.now() + 5 * H));
  assert.ok(ok.ok);
  assert.ok(close(ok.bookPriceOverride, C.imp(160)));
  assert.equal(ok.basis, 'mlb_series_consensus');
  assert.equal(C.getQuoteForLine(seriesLine('Chicago White Sox', 'Chicago White Sox', 'Boston Red Sox', Date.now() + 5 * H)).reason, 'mlb_series_no_record');
  assert.equal(C.getQuoteForLine(seriesLine('Boston Red Sox', 'Cleveland Guardians', 'Chicago White Sox', Date.now() + 5 * H)).reason, 'mlb_series_side_unmatched');
  C.__resetForTest();
});

test('window: after a final the series reopens only once EVERY counted book was read after the end (+grace)', () => {
  seriesWindow.__resetForTest();
  const now = Date.now();
  const idx = lineManager.__debugGetLineIndex();
  // Game 2 started 5h08m ago; with no ESPN it ends at first pitch + 5h = 8 min ago.
  const start = now - seriesWindow.MAX_GAME_MS - 8 * 60e3;
  idx.__t_g2 = { sport: MLB, marketType: 'moneyline', homeTeam: 'Cleveland Guardians', awayTeam: 'Chicago White Sox', startTime: new Date(start).toISOString() };
  const li = seriesLine('Cleveland Guardians', 'Cleveland Guardians', 'Chicago White Sox', now + 20 * H);
  const pb = perBookFromFixtures();
  try {
    for (const b of C.BOOKS) C.__setSourceForTest(b, pb[b], now - 60e3);         // all read after end + grace
    assert.equal(pricer.mlbSeriesQuotable(li, now), true);
    C.__setSourceForTest('betonline', pb.betonline, now - 9 * 60e3);             // fresh, but PRE-final
    assert.equal(pricer.mlbSeriesQuotable(li, now), false, 'one pre-game book keeps the series dark');
    assert.equal(pricer.getSeriesFairProb(li), null);
    // in play: dark regardless of the board
    idx.__t_g2.startTime = new Date(now - 30 * 60e3).toISOString();
    for (const b of C.BOOKS) C.__setSourceForTest(b, pb[b], now - 60e3);
    assert.equal(pricer.mlbSeriesQuotable(li, now), false);
  } finally { delete idx.__t_g2; C.__resetForTest(); seriesWindow.__resetForTest(); }
});

// priceParlay end-to-end
const LINES = {};
const origLookup = lineManager.lookupLine;
const origStale = oddsFeed.isStaleForEvent, origStalePre = oddsFeed.isEventStalePreGame;
lineManager.lookupLine = (id) => LINES[id] || origLookup(id);
oddsFeed.isStaleForEvent = () => false;
oddsFeed.isEventStalePreGame = () => false;
process.on('exit', () => { lineManager.lookupLine = origLookup; oddsFeed.isStaleForEvent = origStale; oddsFeed.isEventStalePreGame = origStalePre; });

function addLines() {
  if (!(config.pricing.maxRiskPerParlay >= 500)) config.pricing.maxRiskPerParlay = 500;
  if (!(config.pricing.maxSeriesRiskPerParlay >= 500)) config.pricing.maxSeriesRiskPerParlay = 500;
  const t = Date.now() + 20 * H;
  Object.assign(LINES, {
    'ser-cle': Object.assign(seriesLine('Cleveland Guardians', 'Cleveland Guardians', 'Chicago White Sox', t), { lineId: 'ser-cle', pxEventId: 'S-CLE', selection: 'home', oddsApiSelection: 'home' }),
    'ser-nyy': Object.assign(seriesLine('New York Yankees', 'Tampa Bay Rays', 'New York Yankees', t), { lineId: 'ser-nyy', pxEventId: 'S-TB', selection: 'away', oddsApiSelection: 'away' }),
    'ser-sd': Object.assign(seriesLine('San Diego Padres', 'Milwaukee Brewers', 'San Diego Padres', t), { lineId: 'ser-sd', pxEventId: 'S-MIL', selection: 'away', oddsApiSelection: 'away' }),
  });
}

test('priceParlay: a two-series parlay offers the product of the two book mirrors (no vig on top); fair = consensus product', async () => {
  seriesWindow.__resetForTest();
  installFixtures();
  addLines();
  const r = await pricer.priceParlay(['ser-cle', 'ser-nyy']);
  assert.ok(r && r.offer, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
  const mirror = C.imp(160) * C.imp(162);
  const off = r.offer.odds > 0 ? 100 / (r.offer.odds + 100) : -r.offer.odds / (-r.offer.odds + 100);
  assert.ok(Math.abs(off - mirror) < 2e-3, `offered ${off} (${r.offer.odds}) vs mirror product ${mirror}`);
  assert.ok(off >= mirror - 1e-3, 'never materially better for the bettor than the books');
  assert.ok(close(r.meta.fairParlayProb, 0.371166 * 0.365469, 1e-5), String(r.meta.fairParlayProb));
  C.__resetForTest();
});

test('priceParlay: a series the consensus declines fails closed with the consensus reason', async () => {
  seriesWindow.__resetForTest();
  installFixtures();
  addLines();
  const r = await pricer.priceParlay(['ser-cle', 'ser-sd']);
  assert.equal(r, null);
  assert.equal(pricer.priceParlay._lastFailure.reason, 'no_fair_value');
  assert.match(pricer.priceParlay._lastFailure.detail, /mlb_series_consensus_declined \(only 2 book/);
  C.__resetForTest();
  const r2 = await pricer.priceParlay(['ser-cle', 'ser-nyy']);
  assert.equal(r2, null, 'cold consensus -> no price');
  assert.match(pricer.priceParlay._lastFailure.detail, /mlb_series_no_record/);
});

test('status: per-series books, fair, raw, fair_lo, gap, decline, age and the RFQ quote per side', () => {
  installFixtures(Date.now() - 42e3);
  const st = C.getStatus();
  const g = st.series['guardians|white sox'];
  assert.equal(g.n, 3);
  assert.deepEqual(Object.keys(g.books).sort(), ['betonline', 'bovada', 'draftkings']);
  assert.ok(g.ageSec >= 41 && g.ageSec <= 44);
  assert.equal(g.rfqQuote.guardians.offeredAmerican, 160);
  assert.equal(st.series['braves|dodgers'].rfqQuote.dodgers.declined, 'mlb_series_longshot_side');
  assert.match(st.series['brewers|padres'].decline, /only 2/);
  assert.ok(st.sources.bovada.counted);
  C.__resetForTest();
});

test('kill switch: mlbSeriesEnabled=false prices nothing even with a full consensus', () => {
  seriesWindow.__resetForTest();
  installFixtures();
  const prev = config.pricing.mlbSeriesEnabled;
  config.pricing.mlbSeriesEnabled = false;
  try {
    assert.equal(pricer.getSeriesFairProb(seriesLine('Cleveland Guardians', 'Cleveland Guardians', 'Chicago White Sox', Date.now() + 5 * H)), null);
  } finally { config.pricing.mlbSeriesEnabled = prev; C.__resetForTest(); }
});
