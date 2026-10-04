// MLB playoff SERIES markets (2026-09-28).
//
// Operator directive: "Let's also quote MLB wild card series markets. $1.5K
// stakes. Make sure they come off the board at the start of Game 1's of each
// series."
//
// Locked here:
//   * DK team matching: "Chicago White Sox" must read the White Sox price, not
//     the Red Sox's ("sox" == "sox" was the old last-word fallback), and an
//     MLB lookup is scoped to its own matchup and to a fresh board;
//   * a series is dark only while one of its games is in play, and prices
//     again only once the DK board post-dates that game (operator 2026-09-29,
//     revising 9/28's "off at Game 1");
//   * DK's round-level startTime (18:00Z for all four series) does NOT close a
//     series whose Game 1 is later;
//   * a series-winner leg can't be parlayed with any leg on a game of the same
//     matchup;
//   * a closed MLB series line is not admitted to the line index.
//
// Run: node --test test/mlb-series.test.js

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const dk = require('../services/dk-scraper');
const seriesWindow = require('../services/series-window');
const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const { config } = require('../config');

const H = 3600e3;
const MLB = 'baseball_mlb';

// DK's live 2026 Wild Card board shape (labels verbatim). The Red Sox series
// is FIRST on purpose: the old last-word fallback matched "Chicago White Sox"
// to it.
function installBoard(at = Date.now(), dkStart = new Date(Date.now() - 1 * H).toISOString()) {
  dk.__setSeriesCacheForTest('mlb', { series: [
    { eventId: 1, eventName: 'AL Wild Card 2026 - NY Yankees vs BOS Red Sox', startTime: dkStart,
      teams: [{ name: 'NY Yankees', fairProb: 0.6018, americanOdds: -170 }, { name: 'BOS Red Sox', fairProb: 0.3982, americanOdds: 140 }] },
    { eventId: 2, eventName: 'NL Wild Card 2026 - SD Padres vs CHI Cubs', startTime: dkStart,
      teams: [{ name: 'SD Padres', fairProb: 0.5290, americanOdds: -120 }, { name: 'CHI Cubs', fairProb: 0.4710, americanOdds: 100 }] },
    { eventId: 3, eventName: 'AL Wild Card 2026 - HOU Astros vs CHI White Sox', startTime: dkStart,
      teams: [{ name: 'HOU Astros', fairProb: 0.5700, americanOdds: -145 }, { name: 'CHI White Sox', fairProb: 0.4300, americanOdds: 125 }] },
  ] }, at);
}

function seriesLine(team, home, away, startMs, extra = {}) {
  return Object.assign({
    sport: MLB, oddsApiSport: MLB, marketType: 'series_winner', oddsApiMarket: 'series_winner',
    teamName: `${team} (Series)`, homeTeam: home, awayTeam: away,
    startTime: new Date(startMs).toISOString(), startTimeMs: startMs,
  }, extra);
}

// The ORDER-BOOK consensus the pricer reads since 2026-10-04 (three books,
// services/mlb-series-consensus.js). White Sox fair 0.43 at every book.
const consensus = require('../services/mlb-series-consensus');
function installConsensus(at = Date.now()) {
  const books = {
    'red sox|yankees': { yankees: -170, 'red sox': 140 },
    'cubs|padres': { padres: -120, cubs: 100 },
    'astros|white sox': { astros: -145, 'white sox': 125 },
  };
  for (const b of consensus.BOOKS) consensus.__setSourceForTest(b, JSON.parse(JSON.stringify(books)), at);
}

function reset() {
  seriesWindow.__resetForTest();
  installBoard();
  installConsensus();
}

// ------------------------------------------------------------ DK matching

test('DK: "Chicago White Sox" reads the White Sox price, never the Red Sox', () => {
  reset();
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'Chicago White Sox').fairProb, 0.43);
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'Boston Red Sox').fairProb, 0.3982);
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'Chicago Cubs').fairProb, 0.471);
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'New York Yankees').fairProb, 0.6018);
});

test('DK: a scoped lookup only answers from its own matchup', () => {
  reset();
  const hit = dk.lookupSeriesFairProb('mlb', 'Chicago White Sox', { homeTeam: 'Chicago White Sox', awayTeam: 'Houston Astros' });
  assert.strictEqual(hit.fairProb, 0.43);
  // Right team, wrong matchup (not on the board) → fail closed.
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'Chicago White Sox', { homeTeam: 'Chicago White Sox', awayTeam: 'Boston Red Sox' }), null);
});

test('DK: a stale board does not price when a max age is given', () => {
  installBoard(Date.now() - 2 * H);
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'Chicago Cubs', { maxAgeMs: 45 * 60e3 }), null);
  assert.ok(dk.lookupSeriesFairProb('mlb', 'Chicago Cubs'), 'no max age → unchanged legacy behaviour');
});

test('DK: an ambiguous bare nickname fails closed instead of guessing', () => {
  reset();
  assert.strictEqual(dk.lookupSeriesFairProb('mlb', 'Sox'), null);
});

test('DK: NBA-style labels still match (regression)', () => {
  dk.__setSeriesCacheForTest('nba', { series: [
    { eventId: 9, eventName: 'CLE Cavaliers vs TOR Raptors', startTime: new Date(Date.now() + H).toISOString(),
      teams: [{ name: 'CLE Cavaliers', fairProb: 0.7 }, { name: 'TOR Raptors', fairProb: 0.3 }] },
  ] });
  assert.strictEqual(dk.lookupSeriesFairProb('nba', 'Cleveland Cavaliers (Series)').fairProb, 0.7);
  assert.strictEqual(dk.lookupSeriesFairProb('nba', 'Toronto Raptors').fairProb, 0.3);
  dk.__setSeriesCacheForTest('nba', null);
});

// ------------------------------------------------------- in-play window
// Operator 2026-09-29: quote series BETWEEN games; dark only while a game of
// the series is in play, and until the DK board post-dates that game's end.

const noEspn = () => null;
const finalEspn = () => ({ completed: true, state: 'post' });
const liveEspn = () => ({ completed: false, state: 'in' });

test('window: open before a game, closed while it is in play, open after it is final', () => {
  seriesWindow.__resetForTest();
  const g1 = Date.now() - 60 * 60e3;
  const li = seriesLine('New York Yankees', 'Boston Red Sox', 'New York Yankees', Date.now() + 20 * H);
  const games = [{ startMs: g1, home: 'New York Yankees', away: 'Boston Red Sox' }];
  assert.strictEqual(seriesWindow.isClosed(li, { games: [], espnLookup: noEspn }), false, 'no game in play');
  assert.strictEqual(seriesWindow.isClosed(li, { games, espnLookup: liveEspn }), true, 'Game 1 live');
  assert.strictEqual(seriesWindow.isClosed(li, { games, espnLookup: noEspn }), true, 'no ESPN yet, within 5h of first pitch');
  assert.strictEqual(seriesWindow.isClosed(li, { games, espnLookup: finalEspn }), false, 'Game 1 final -> open again');
});

test('window: without ESPN a game counts as in play for MAX_GAME_MS, then not', () => {
  seriesWindow.__resetForTest();
  const li = seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() + 20 * H);
  const late = [{ startMs: Date.now() - seriesWindow.MAX_GAME_MS - 60e3, home: 'San Diego Padres', away: 'Chicago Cubs' }];
  assert.strictEqual(seriesWindow.isClosed(li, { games: late, espnLookup: noEspn }), false);
});

test('window: the series line OWN past start counts as a game in play', () => {
  seriesWindow.__resetForTest();
  const li = seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() - 30 * 60e3);
  assert.strictEqual(seriesWindow.isClosed(li, { games: [], espnLookup: noEspn }), true);
});

test('pricing: after a final, the DK board must post-date the end (+grace)', () => {
  seriesWindow.__resetForTest();
  const now = Date.now();
  const li = seriesLine('Houston Astros', 'Chicago White Sox', 'Houston Astros', now + 20 * H);
  const games = [{ startMs: now - 4 * H, home: 'Houston Astros', away: 'Chicago White Sox' }];
  assert.strictEqual(seriesWindow.isPriceable(li, { now, games, espnLookup: finalEspn, boardAtMs: now - 10 * 60e3 }), false,
    'a board scraped before the final is the PRE-game price');
  const later = now + seriesWindow.RELIST_GRACE_MS + 60e3;
  assert.strictEqual(seriesWindow.isPriceable(li, { now: later, games, espnLookup: finalEspn, boardAtMs: later - 30e3 }), true);
  assert.strictEqual(seriesWindow.isPriceable(li, { now: later, games, espnLookup: finalEspn, boardAtMs: null }), false);
});

test('window: unknown start fails CLOSED; non-MLB series are untouched', () => {
  seriesWindow.__resetForTest();
  const li = Object.assign(seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() + H), { startTime: null, startTimeMs: null });
  assert.strictEqual(seriesWindow.isClosed(li, { espnLookup: noEspn }), true);
  const nhl = { sport: 'icehockey_nhl', marketType: 'series_winner', homeTeam: 'A', awayTeam: 'B', startTime: new Date(Date.now() - H).toISOString() };
  assert.strictEqual(seriesWindow.isClosed(nhl), false);
});

// ------------------------------------------------------- getSeriesFairProb

test('pricer: an MLB series with no game in play prices off its own consensus series even after DK round-level start', () => {
  reset();
  const li = seriesLine('Chicago White Sox', 'Chicago White Sox', 'Houston Astros', Date.now() + 3 * H);
  const q = pricer.getSeriesFairProb(li);
  // proportional de-vig of -145/+125: 0.4444 / (0.5918 + 0.4444)
  assert.ok(Math.abs(q.fairProb - (100 / 225) / (145 / 245 + 100 / 225)) < 1e-6, String(q.fairProb));
  // offered = the raw +125 the books post (0.4444), above fair: a direct book reference
  assert.ok(Math.abs(q.bookPriceOverride - 100 / 225) < 1e-9, String(q.bookPriceOverride));
});

test('pricer: in-play / stale / switched-off / non-winner MLB series do not price', () => {
  reset();
  const live = seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() - 60e3);
  assert.strictEqual(pricer.getSeriesFairProb(live), null, 'a game is in play');

  seriesWindow.__resetForTest();
  installConsensus(Date.now() - 11 * 60e3);
  const open = seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() + 3 * H);
  assert.strictEqual(seriesWindow.isClosed(open, { espnLookup: noEspn }), false, 'precondition: no game in play');
  assert.strictEqual(pricer.getSeriesFairProb(open), null, 'every source older than SERIES_SRC_MAX_AGE_S');

  reset();
  const prev = config.pricing.mlbSeriesEnabled;
  config.pricing.mlbSeriesEnabled = false;
  try {
    assert.strictEqual(pricer.getSeriesFairProb(seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() + 3 * H)), null);
  } finally { config.pricing.mlbSeriesEnabled = prev; }

  const spread = seriesLine('Chicago Cubs', 'San Diego Padres', 'Chicago Cubs', Date.now() + 3 * H, { marketType: 'series_spread', oddsApiMarket: 'series_spread', line: 1.5 });
  assert.strictEqual(pricer.getSeriesFairProb(spread), null);
});

// ------------------------------------------------------------ shouldDecline

const LINES = {};
const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
// The fixture total IS the primary line (the MLB alt-total guard asks).
const origPrimaryTotal = lineManager.getPrimaryTotalLine;
lineManager.getPrimaryTotalLine = (ev) => (ev === 'G1' ? 7.5 : null);
process.on('exit', () => { lineManager.lookupLine = origLookup; lineManager.getPrimaryTotalLine = origPrimaryTotal; });
function addLine(id, info) { LINES[id] = Object.assign({ lineId: id, oddsApiSport: info.sport }, info); }

const G1 = Date.now() + 4 * H;
addLine('s-nyy', Object.assign(seriesLine('New York Yankees', 'Boston Red Sox', 'New York Yankees', G1), { pxEventId: 'S1', selection: 'away', oddsApiSelection: 'away' }));
addLine('g-nyy-ml', { sport: MLB, pxEventId: 'G1', marketType: 'moneyline', oddsApiMarket: 'h2h', selection: 'home', oddsApiSelection: 'home',
  teamName: 'New York Yankees', homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', startTime: new Date(G1).toISOString(), startTimeMs: G1 });
addLine('g-nyy-tot', { sport: MLB, pxEventId: 'G1', marketType: 'total', oddsApiMarket: 'totals', selection: 'over', oddsApiSelection: 'over',
  teamName: 'Over', line: 7.5, homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', startTime: new Date(G1).toISOString(), startTimeMs: G1 });
addLine('g-nyy-f5', { sport: MLB, pxEventId: 'G1', marketType: 'first_5_innings_moneyline', oddsApiMarket: 'h2h_1st_5_innings', selection: 'away', oddsApiSelection: 'away',
  teamName: 'Boston Red Sox', homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', startTime: new Date(G1).toISOString(), startTimeMs: G1 });
addLine('g-sd-ml', { sport: MLB, pxEventId: 'G2', marketType: 'moneyline', oddsApiMarket: 'h2h', selection: 'home', oddsApiSelection: 'home',
  teamName: 'San Diego Padres', homeTeam: 'San Diego Padres', awayTeam: 'Chicago Cubs', startTime: new Date(G1 + 2 * H).toISOString(), startTimeMs: G1 + 2 * H });

const decline = (...ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);

test('shouldDecline: series winner + a game leg on the same matchup is blocked (ML, total, F5)', () => {
  seriesWindow.__resetForTest();
  for (const g of ['g-nyy-ml', 'g-nyy-tot', 'g-nyy-f5']) {
    const r = decline('s-nyy', g);
    assert.ok(r && r.declined, `${g}: must decline`);
    assert.strictEqual(r.reason, 'correlated legs', `${g}: ${r.reason} / ${r.detail}`);
    assert.match(r.detail, /series winner \+ individual game/);
  }
});

test('shouldDecline: series winner + a DIFFERENT matchup is not a correlation decline', () => {
  seriesWindow.__resetForTest();
  const r = decline('s-nyy', 'g-sd-ml');
  assert.ok(!(r && r.declined && (r.reason === 'correlated legs' || r.reason === 'series closed')),
    `unexpected: ${r && r.reason} / ${r && r.detail}`);
});

test('shouldDecline: a game in play declines "series closed"; a past series start alone is not "event started"', () => {
  seriesWindow.__resetForTest();
  reset();
  const idx = lineManager.__debugGetLineIndex();
  idx.__t_live = { sport: MLB, marketType: 'moneyline', homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', startTime: new Date(Date.now() - 30 * 60e3).toISOString() };
  try {
    const r = decline('s-nyy', 'g-sd-ml');
    assert.ok(r && r.declined);
    assert.strictEqual(r.reason, 'series closed', r.reason + ' / ' + r.detail);
  } finally { delete idx.__t_live; }
  const prev = LINES['s-nyy'];
  LINES['s-nyy'] = Object.assign({}, prev, { startTime: new Date(Date.now() - 6 * H).toISOString(), startTimeMs: Date.now() - 6 * H });
  try {
    const r2 = decline('s-nyy', 'g-sd-ml');
    assert.ok(!(r2 && r2.declined && r2.reason === 'event started'), String(r2 && r2.reason));
  } finally { LINES['s-nyy'] = prev; }
});

test('shouldDecline: the kill-switch closes MLB series', () => {
  seriesWindow.__resetForTest();
  const prev = config.pricing.mlbSeriesEnabled;
  config.pricing.mlbSeriesEnabled = false;
  try {
    const r = decline('s-nyy', 'g-sd-ml');
    assert.strictEqual(r && r.reason, 'series closed');
  } finally { config.pricing.mlbSeriesEnabled = prev; }
});

// ------------------------------------------------------------ registration

test('line index: an MLB series line is refused only while a game is in play; non-MLB series are admitted', () => {
  seriesWindow.__resetForTest();
  const open = seriesLine('Houston Astros', 'Chicago White Sox', 'Houston Astros', Date.now() + 5 * H);
  assert.strictEqual(lineManager._mlbSeriesAdmissible(open), true);
  const live = seriesLine('Houston Astros', 'Chicago White Sox', 'Houston Astros', Date.now() - 60e3);
  assert.strictEqual(lineManager._mlbSeriesAdmissible(live), false);
  const nhl = { sport: 'icehockey_nhl', marketType: 'series_winner', homeTeam: 'A', awayTeam: 'B', startTime: new Date(Date.now() - H).toISOString() };
  assert.strictEqual(lineManager._mlbSeriesAdmissible(nhl), true);
});

test('line index: an in-progress same-matchup game in the index closes the series; an old meeting does not', () => {
  seriesWindow.__resetForTest();
  const idx = lineManager.__debugGetLineIndex();
  const started = Date.now() - 20 * 60e3;
  idx.__t_g1 = { sport: MLB, marketType: 'moneyline', homeTeam: 'Atlanta Braves', awayTeam: 'Philadelphia Phillies', startTime: new Date(started).toISOString() };
  idx.__t_old = { sport: MLB, marketType: 'moneyline', homeTeam: 'San Diego Padres', awayTeam: 'Chicago Cubs', startTime: new Date(Date.now() - 3 * 24 * H).toISOString() };
  try {
    assert.deepStrictEqual(lineManager.getPairGames(MLB, 'Philadelphia Phillies', 'Atlanta Braves').map(g => g.startMs), [started]);
    assert.deepStrictEqual(lineManager.getPairGames(MLB, 'Chicago Cubs', 'San Diego Padres'), []);
    assert.strictEqual(lineManager._mlbSeriesAdmissible(seriesLine('Atlanta Braves', 'Philadelphia Phillies', 'Atlanta Braves', Date.now() + 22 * H)), false);
    assert.strictEqual(lineManager._mlbSeriesAdmissible(seriesLine('San Diego Padres', 'San Diego Padres', 'Chicago Cubs', Date.now() + 5 * H)), true);
  } finally { delete idx.__t_g1; delete idx.__t_old; }
});

test('pricer: an MLB series lookup is scoped to its matchup (fails closed off-board)', () => {
  reset();
  // The White Sox ARE on the consensus board, but not against the Red Sox.
  const li = seriesLine('Chicago White Sox', 'Chicago White Sox', 'Boston Red Sox', Date.now() + 3 * H);
  assert.strictEqual(pricer.getSeriesFairProb(li), null);
});

test('line index: every entry point (seed, cache restore, on-demand) runs the series gate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');
  // Negated call sites only — the function's own signature is `(info)` too.
  const calls = (src.match(/!_mlbSeriesAdmissible\((info|cached|foundInfo)\)/g) || []).map(x => x.replace(/.*\(|\)/g, ''));
  assert.deepStrictEqual([...new Set(calls)].sort(), ['cached', 'foundInfo', 'info']);
});
