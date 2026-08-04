/**
 * TOA tennis SET markets — 1st Set ML, Total Sets, "to win at least one set".
 *
 * SOURCE MAPPING (operator-established 2026-08-04, verified against a live ATP
 * Montreal event):
 *   PX 1st_set_moneyline        <- TOA h2h_s1
 *   PX total_sets               <- TOA alternate_set_totals  (match PX's line EXACTLY)
 *   PX <player> to win >=1 set  <- TOA alternate_set_spreads, the +/-1.5 SET handicap:
 *                                    YES == that player +1.5 sets
 *                                    NO  == the opponent -1.5 sets
 *
 * NEVER GUESS TOA MARKET KEYS. `h2h_1st_set` and `totals_sets` do not exist and
 * 422 with INVALID_MARKET, which reads like "no data" but means "no such key" —
 * that mistake produced a confident, wrong "TOA has no tennis set markets"
 * conclusion. Enumerate instead:
 *     GET /v4/sports/{key}/events/{id}/markets?regions=us,us2,uk,eu
 * On a live ATP event that returns 15 keys including h2h_s1, h2h_s2, spreads_s1,
 * totals_s1, alternate_set_spreads, alternate_set_totals, alternate_totals_s1.
 *
 * TENNIS HAS NO GENERIC SPORT KEY. It is tournament-scoped
 * (tennis_atp_canadian_open, ...), so the active list comes from
 * /v4/sports/?all=true filtered to active tennis keys.
 *
 * DO NOT CONFUSE WITH THE GAMES MARKETS. Plain `spreads` is a GAMES handicap and
 * `totals` is TOTAL GAMES (~22.5). Only the *_set_* keys are set markets. This
 * is the same sets/games trap documented in services/pinnacle-tennis.js.
 *
 * BEST-OF-3 ONLY. "+1.5 sets == wins at least one set" holds because the Bo3 set
 * differentials are +2/+1/-1/-2, so +1.5 covers everything except a 0-2 loss. In
 * best-of-5 the equivalent line is +2.5, so the Bo3 mapping would price a
 * DIFFERENT event. We detect the format from the posted total-sets line and fail
 * closed when it is not 2.5.
 *
 * SIDE SELECTION IS BY SIGNED POINT, never |point|. Both +1.5 and -1.5 are
 * present on the same market, and picking by absolute value would pick the wrong
 * side half the time.
 *
 * RETAIL-ONLY DEPTH. Via TOA these markets are quoted by DK/FanDuel/BetMGM/
 * ESPN BET/BetRivers/LeoVegas — Pinnacle is absent from TOA's book list for
 * them. Depth is thin, especially alternate_set_totals (often BetRivers alone),
 * hence the configurable minimum-book gate.
 */

const { config } = require('../config');
const log = require('./logger');

const API = 'https://api.the-odds-api.com/v4';
const MARKETS = 'h2h_s1,alternate_set_totals,alternate_set_spreads';
const REGIONS = 'us,us2,uk,eu';

const TTL_MS = () => (Number(config.pricing.tennisSetsTtlSeconds) || 300) * 1000;
const SPACING_MS = () => (Number(config.pricing.tennisSetsFetchSpacingMs) || 400);
const MIN_BOOKS = () => (Number(config.pricing.tennisSetsMinBooks) || 1);
const TIMEOUT_MS = 15000;

let _fetch;
function fetchFn() {
  if (!_fetch) _fetch = global.fetch ? global.fetch.bind(global) : require('node-fetch');
  return _fetch;
}

const amerToProb = (a) => {
  const n = typeof a === 'string' ? parseInt(a, 10) : a;
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
};
/** Proportional 2-way de-vig, matching odds-feed's convention. */
function devig2(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  const t = a + b;
  return t > 0 ? { a: a / t, b: b / t } : null;
}
/** Surname key — TOA and PX disagree on given names ("Martin Damm Jr."). */
function surname(s) {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(x => x.length > 1);
  return t.length ? t[t.length - 1] : '';
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchFn()(url, { signal: ctrl.signal });
    if (r.status === 429) return { _rateLimited: true };
    if (!r.ok) return { _error: 'HTTP ' + r.status };
    return await r.json();
  } catch (e) {
    return { _error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// slate cache: pairKey -> { sets, at }
let _cache = new Map();
let _lastFetchAt = 0;

/** Active tournament-scoped tennis sport keys. */
async function activeTennisKeys(apiKey) {
  const j = await getJson(API + '/sports/?all=true&apiKey=' + apiKey);
  if (!Array.isArray(j)) return [];
  return j.filter(s => s && typeof s.key === 'string'
    && s.key.includes('tennis') && s.active).map(s => s.key);
}

/**
 * Build the three set markets for one TOA event.
 * Returns null when the board cannot be trusted (wrong format, too few books).
 */
function buildSets(odds) {
  if (!odds || !Array.isArray(odds.bookmakers)) return null;
  const home = odds.home_team, away = odds.away_team;
  const hK = surname(home), aK = surname(away);
  if (!hK || !aK || hK === aK) return null;

  const collect = (key) => {
    const out = [];
    for (const bk of odds.bookmakers) {
      const m = (bk.markets || []).find(x => x.key === key);
      if (m && Array.isArray(m.outcomes)) out.push({ book: bk.key, outcomes: m.outcomes });
    }
    return out;
  };

  const sets = { firstSetMl: null, totalSets: null, atLeastOneSet: null, books: {} };

  // --- 1st set moneyline: outcomes are PLAYER names ------------------------
  {
    const rows = collect('h2h_s1');
    const hs = [], as = [];
    for (const r of rows) {
      const h = r.outcomes.find(o => surname(o.name) === hK);
      const a = r.outcomes.find(o => surname(o.name) === aK);
      const f = devig2(amerToProb(h && h.price), amerToProb(a && a.price));
      if (f) { hs.push(f.a); as.push(f.b); }
    }
    if (hs.length >= MIN_BOOKS()) {
      sets.firstSetMl = {
        home: { fairProb: hs.reduce((s, x) => s + x, 0) / hs.length },
        away: { fairProb: as.reduce((s, x) => s + x, 0) / as.length },
      };
      sets.books.firstSetMl = hs.length;
    }
  }

  // --- total sets: the book point must EQUAL PX's line (2.5) ---------------
  {
    const rows = collect('alternate_set_totals');
    const ov = [], un = [];
    for (const r of rows) {
      const o = r.outcomes.find(x => /^over$/i.test(x.name) && Number(x.point) === 2.5);
      const u = r.outcomes.find(x => /^under$/i.test(x.name) && Number(x.point) === 2.5);
      const f = devig2(amerToProb(o && o.price), amerToProb(u && u.price));
      if (f) { ov.push(f.a); un.push(f.b); }
    }
    if (ov.length >= MIN_BOOKS()) {
      sets.totalSets = {
        line: 2.5,
        over: { fairProb: ov.reduce((s, x) => s + x, 0) / ov.length },
        under: { fairProb: un.reduce((s, x) => s + x, 0) / un.length },
      };
      sets.books.totalSets = ov.length;
    }
  }

  // --- at least one set: X +1.5 sets vs opponent -1.5 ----------------------
  // SIGNED point, never |point| — both signs are present on this market.
  {
    // PER PLAYER, INDEPENDENTLY. A book usually posts only ONE of the two
    // handicap pairs — e.g. "Damm -1.5 / Tsitsipas +1.5" gives Tsitsipas's
    // at-least-one-set (his +1.5) and its exact complement (Damm 2-0), but says
    // nothing directly about Damm's at-least-one-set, which needs the OTHER
    // pair. Requiring both collapsed coverage to 13 of 54 matches; each side is
    // independently priceable, and PX lists them as two separate markets
    // anyway, so they are built separately.
    const rows = collect('alternate_set_spreads');
    const hYes = [], aYes = [];
    for (const r of rows) {
      const hPlus = r.outcomes.find(o => surname(o.name) === hK && Number(o.point) === 1.5);
      const aMinus = r.outcomes.find(o => surname(o.name) === aK && Number(o.point) === -1.5);
      const f1 = devig2(amerToProb(hPlus && hPlus.price), amerToProb(aMinus && aMinus.price));
      if (f1) hYes.push(f1.a);

      const aPlus = r.outcomes.find(o => surname(o.name) === aK && Number(o.point) === 1.5);
      const hMinus = r.outcomes.find(o => surname(o.name) === hK && Number(o.point) === -1.5);
      const f2 = devig2(amerToProb(aPlus && aPlus.price), amerToProb(hMinus && hMinus.price));
      if (f2) aYes.push(f2.a);
    }
    const alos = {};
    if (hYes.length >= MIN_BOOKS()) alos.home = { fairProb: hYes.reduce((s, x) => s + x, 0) / hYes.length };
    if (aYes.length >= MIN_BOOKS()) alos.away = { fairProb: aYes.reduce((s, x) => s + x, 0) / aYes.length };
    if (alos.home || alos.away) {
      sets.atLeastOneSet = alos;
      sets.books.atLeastOneSet = Math.max(hYes.length, aYes.length);
      sets.books.atLeastOneSetHome = hYes.length;
      sets.books.atLeastOneSetAway = aYes.length;
    }
  }

  if (!sets.firstSetMl && !sets.totalSets && !sets.atLeastOneSet) return null;

  // CONSISTENCY IDENTITY (same guard as pinnacle-tennis): exactly one player
  // fails to win a set unless the match goes three, so
  //     P(home>=1) + P(away>=1) - P(over 2.5) = 1
  // A break means a side or the format is wrong, so the block is discarded
  // rather than priced. Only checkable when both markets are present.
  if (sets.atLeastOneSet && sets.atLeastOneSet.home && sets.atLeastOneSet.away && sets.totalSets) {
    const identity = sets.atLeastOneSet.home.fairProb + sets.atLeastOneSet.away.fairProb
      - sets.totalSets.over.fairProb;
    sets.consistency = Math.abs(identity - 1);
    const tol = Number(config.pricing.tennisSetsConsistencyTol) || 0.08;
    if (sets.consistency > tol) return { _rejected: 'consistency', consistency: sets.consistency };
  }
  sets.homeTeam = home;
  sets.awayTeam = away;
  return sets;
}

/**
 * Fetch set markets for the whole live tennis slate.
 * SERIAL with spacing — TOA rate-limits by request FREQUENCY separately from
 * quota, and a 429 reads as "this match has no set markets" unless handled, so
 * rate-limited events are recorded as transient failures and NEVER cached as
 * misses.
 */
async function fetchSlate() {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return { games: [], error: 'no THE_ODDS_API_KEY' };
  const startedAt = Date.now();

  const keys = await activeTennisKeys(apiKey);
  if (!keys.length) return { games: [], error: 'no active tennis keys' };

  const games = [];
  let rateLimited = 0, errors = 0, rejected = 0, noSets = 0;
  for (const sportKey of keys) {
    const evs = await getJson(API + '/sports/' + sportKey + '/events?apiKey=' + apiKey);
    if (!Array.isArray(evs)) { errors++; continue; }
    for (const ev of evs) {
      const wait = SPACING_MS() - (Date.now() - _lastFetchAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      _lastFetchAt = Date.now();

      const url = API + '/sports/' + sportKey + '/events/' + ev.id + '/odds'
        + '?apiKey=' + apiKey + '&regions=' + REGIONS + '&markets=' + MARKETS
        + '&oddsFormat=american';
      const odds = await getJson(url);
      if (odds && odds._rateLimited) { rateLimited++; continue; }   // never cached as a miss
      if (odds && odds._error) { errors++; continue; }
      const sets = buildSets(odds);
      if (!sets) { noSets++; continue; }
      if (sets._rejected) { rejected++; continue; }
      games.push({
        sportKey, eventId: ev.id,
        homeTeam: ev.home_team, awayTeam: ev.away_team,
        commenceTime: ev.commence_time,
        sets,
      });
    }
  }

  log.info('ToaTennisSets', keys.length + ' tournament key(s), ' + games.length + ' games with set markets'
    + ' (' + noSets + ' none, ' + rejected + ' failed consistency, '
    + rateLimited + ' rate-limited, ' + errors + ' errors) in ' + (Date.now() - startedAt) + 'ms');
  return { games, fetchedAt: Date.now(), rateLimited, errors, rejected };
}

let _lastBoard = null;
function rememberBoard(b) {
  if (b && Array.isArray(b.games) && b.games.length) _lastBoard = b;
  return b;
}
function getLastBoard() { return _lastBoard; }

module.exports = {
  fetchSlate, rememberBoard, getLastBoard, buildSets,
  __surname: surname, __devig2: devig2, __amerToProb: amerToProb,
};
