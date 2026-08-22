// Uses Node's global fetch (undici). Keep-alive pool, TCP_NODELAY, and HTTP/2
// support come from services/httpClient which configures the global dispatcher
// at process bootstrap. Migrated from node-fetch@2 for S3 of latency plan.
const { config } = require('../config');
const log = require('./logger');
const bovadaAltScraper = require('./bovada-alt-scraper');

// AbortController is a Node.js global — used by abortableFetch below to cancel
// slow Odds API calls instead of just ignoring the promise. This actually
// frees the underlying socket so keep-alive doesn't reuse a hung connection.

// ---------------------------------------------------------------------------
// ODDS API FETCH TIMEOUT HELPER (Option E of latency plan)
// ---------------------------------------------------------------------------
// Bounds the tail on Odds API calls used during RFQ pricing. Without this,
// a stuck request can hang for 10+ seconds (observed live in production),
// blocking the RFQ response well past any useful window. With AbortController
// we actually cancel the underlying socket instead of just ignoring the
// promise, which prevents socket leaks and frees the keep-alive connection.
//
// Default 500ms is enough for normal calls but tight enough to kill real
// hangs. Operator can tune via TOA_FETCH_TIMEOUT_MS — drop lower (200-300ms)
// when the auction race is tight, raise during stable periods, or set to 0
// to disable the timeout entirely.
const ODDS_API_FETCH_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.TOA_FETCH_TIMEOUT_MS, 10);
  if (raw === 0) return 0; // explicit disable
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 500;
})();

// ---------------------------------------------------------------------------
// GLOBAL TOA RATE GATE
// ---------------------------------------------------------------------------
// All requests to the-odds-api.com go through this gate so no single code
// path can cause a 429 storm by itself. Three callers previously had their
// own ad-hoc throttling (alt-line pre-warm: WARM_CONCURRENCY=2/120ms per
// worker) but on-demand alt-line fetches and prop background refreshes had
// none. When all 75 prop cache entries hit their refresh-ahead threshold
// simultaneously (15 MLB games × 5 prop types), they fired 75 concurrent
// TOA calls and collided with the alt-line pre-warm and main-market fetches.
//
// Env knobs (no Railway restart needed — read at boot):
//   TOA_MIN_INTERVAL_MS  (default 50)  — min ms between starting each request
//   TOA_MAX_CONCURRENT   (default 4)   — max in-flight TOA calls at once
//
// Throughput: 4 concurrent × (1000ms / 50ms) = ~80 req/s sustained. Well
// under any TOA tier's rate limit while still keeping warm cycles fast.
// The existing WARM_REQUEST_DELAY_MS/WARM_CONCURRENCY per-worker sleeps are
// harmless with the gate in place — they just add extra spacing on top.
const _TOA_MIN_INTERVAL_MS = parseInt(process.env.TOA_MIN_INTERVAL_MS) || 50;
const _TOA_MAX_CONCURRENT  = parseInt(process.env.TOA_MAX_CONCURRENT)  || 4;
let   _toaInFlight = 0;
const _toaQueue    = [];

function _drainToaQueue() {
  while (_toaQueue.length && _toaInFlight < _TOA_MAX_CONCURRENT) {
    _toaInFlight++;
    _toaQueue.shift()(); // resolve the waiter → that caller proceeds
  }
}
function _toaAcquire() {
  return new Promise(resolve => { _toaQueue.push(resolve); _drainToaQueue(); });
}
function _toaRelease() {
  _toaInFlight--;
  setTimeout(_drainToaQueue, _TOA_MIN_INTERVAL_MS);
}

async function abortableFetch(url, options, timeoutMs) {
  const isToa = typeof url === 'string' && url.includes('the-odds-api.com');
  if (isToa) await _toaAcquire();
  const t = timeoutMs != null ? timeoutMs : ODDS_API_FETCH_TIMEOUT_MS;
  try {
    // 0 disables the timeout entirely
    if (!t || t <= 0) return await fetch(url, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), t);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (isToa) _toaRelease();
  }
}

// ---------------------------------------------------------------------------
// UTF-8-SAFE JSON HELPER
// ---------------------------------------------------------------------------
// `await resp.json()` on the global fetch (undici) has been observed to
// silently mis-decode UTF-8 bodies as Latin-1 in some Node + undici
// version combos when the upstream Content-Type omits an explicit
// charset and the body is gzipped. Empirical case (April 2026, Railway):
// The Odds API returned "Atlético Madrid" as bytes 41 74 6c c3 a9 ...
// (correct UTF-8 for é), but the in-memory cache held two characters
// 'Ã' (U+00C3) + '©' (U+00A9) — the classic UTF-8-as-Latin-1 mojibake.
// Locally on Node 24 the same code path produced clean é (U+00E9),
// so the fault is implementation-version-specific rather than logical.
//
// safeJsonFetch sidesteps the issue by reading raw bytes and explicitly
// decoding as UTF-8 via TextDecoder before JSON.parse. Use this in any
// fetch path that handles upstream-provided strings (team names,
// fighter names, tournament names) where a 1-byte mis-decode silently
// breaks downstream string matching.
async function safeJsonFetch(resp) {
  const buf = await resp.arrayBuffer();
  if (buf.byteLength === 0) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// IN-MEMORY CACHE
// ---------------------------------------------------------------------------
// Structure: { [league]: { fetchedAt, events: { [eventKey]: { ... } } } }
const oddsCache = {};
// Live (in-play) odds cache — only populated when in-progress games need refreshing
const liveOddsCache = {};
// Delta tracking — last fetch timestamp per sport for /odds/delta calls
const lastDeltaTimestamp = {};

// When Kalshi is the fallback floor (Pinnacle unavailable), widen by 2%
// because Kalshi trades at razor-thin exchange margins
const KALSHI_BUFFER = 0.02;

// SharpAPI events index — for improved PX-to-odds team name matching
// { [sport]: { fetchedAt, events: [{ eventId, homeTeam, awayTeam, startTime }] } }
const sharpEventsIndex = {};

// Player-prop rows cache — kept SEPARATE from oddsCache so the existing
// moneyline/spread/total de-vig pipeline isn't disturbed. Phase 1 of the
// pitcher-strikeouts shadow-pricing experiment populates this with raw
// SharpAPI rows; lookup is on-demand by event + player + line.
//
// Structure:
//   propRowsCache[sport][marketType] = [
//     { event_id, home_team, away_team, event_start_time,
//       sportsbook, player_name, line, selection ('Over'|'Under'),
//       odds_american, odds_probability, ... }, ...
//   ]
//
// Lookup helper: getPropRows(sport, marketType, filterFn) — returns the
// array filtered, or [] if cache empty. We don't pre-index by event/
// player because prop volume per refresh is small (~hundreds of rows
// per market) and PX RFQ rate is bounded — a linear scan is fine.
const propRowsCache = {};

// Set of SharpAPI market_type values that are PROPS (not core line markets).
// Rows with these market_types are partitioned out of the main rows[] array
// before the de-vig grouping step so the existing pipeline doesn't see them.
// Update when adding a new prop market to fetchOddsForSport's marketTypesList.
const PROP_MARKET_TYPES = new Set([
  'player_strikeouts', // pitcher Ks (Phase 1 shadow target). Player_name
                       // distinguishes pitcher (" Thrown" suffix) vs batter
                       // (" Recorded" suffix) sides within the same market.
  'player_points',     // NBA player points (Phase 1 shadow target).
                       // Single-stat per-player Over/Under. Player_name is
                       // typically the player's full name with no suffix.
]);

// Lineup tracking — MLB starting pitchers, NHL starting goalies.
// SharpAPI appends starter name in parens to team_name: "New York Yankees (Gerrit Cole)"
// We capture these per refresh and diff against the prior refresh to detect
// lineup changes (scratches, late swaps). When a change is detected, the
// event's odds are considered "in motion" for a grace window so the pricer
// can decline until the books re-stabilize.
//
// Structure:
//   lineupCache[sport][lineupKey] = {
//     homeStarter: string|null,
//     awayStarter: string|null,
//     seenAt: timestamp,
//     lastChangeAt: timestamp|null,
//     commenceMs: timestamp,
//     lastChangeDetail: string|null,
//   }
// lineupKey = `${normalizedEventKey}|${ISO commence time}` — ONE ENTRY PER GAME.
// It used to be `|${YYYY-MM-DD}`, which collided the two games of a series
// (an ET evening game shares a UTC date with the next afternoon's game) and
// wedged the grace window open indefinitely. See _resolveLineupKey.
const lineupCache = {};
const LINEUP_GRACE_MS = 3 * 60 * 1000; // decline for 3 minutes after a change
// Two writes land on the same game if their starts are within this window.
// Cross-source start times differ by minutes; the tightest real gap between
// two games of one pair (a doubleheader) is ~3h, so 2h separates them cleanly.
const LINEUP_SAME_GAME_MS = 2 * 60 * 60 * 1000;
const LINEUP_PRUNE_MS = 48 * 60 * 60 * 1000; // forget games that started >48h ago

// Closing line snapshots. Keyed by normalized event key (home|away). Captured
// once per event when the event's commenceTime crosses into the past. Stores
// the final Pinnacle + consensus per-market fair probs as a snapshot for CLV
// analysis. Persisted only in memory — lost on restart.
// {
//   [eventKey]: {
//     sport, homeTeam, awayTeam, commenceTime, capturedAt,
//     markets: {
//       h2h:     { home, away },  // implied probs
//       spreads: { line, home, away },
//       totals:  { line, over, under },
//     },
//     pinnacle: { ... same structure ... },
//   }
// }
const closingLinesCache = {};

// SharpAPI league/sport keys mapping
const LEAGUE_MAP = {
  'basketball_nba': { param: 'league', value: 'nba' },
  'baseball_mlb': { param: 'league', value: 'mlb' },
  'icehockey_nhl': { param: 'league', value: 'nhl' },
  'soccer': { param: 'sport', value: 'soccer' },
  'mma_mixed_martial_arts': { param: 'league', value: 'ufc' },
  // Tennis: TOA dynamic discovery is primary, SharpAPI is fallback when TOA
  // returns 0 events (e.g. Pinnacle/FD/DK haven't posted Madrid Open prelims).
  // SharpAPI now carries Caesars/DK/FD/BetMGM rows on tennis; comment that
  // SharpAPI had "zero bookmaker odds" is stale as of 2026-05-01.
  'tennis': { param: 'sport', value: 'tennis' },
};

// Bookmakers for The Odds API — Pinnacle (sharpest), DraftKings, FanDuel
const ODDS_API_BOOKMAKERS = 'pinnacle,draftkings,fanduel';

// Expanded bookmakers for alt-line fetching only — more books = more alt line values.
// Primary pricing is NOT affected (uses ODDS_API_BOOKMAKERS via SharpAPI consensus).
// Minimum 2 books required per alt line to ensure de-vig accuracy.
const ALT_LINES_BOOKMAKERS = 'pinnacle,draftkings,fanduel,bovada,betonlineag,betrivers,williamhill_us,unibet_us,superbook,betmgm,espnbet,hardrockbet,fliff,betus,lowvig,pointsbetus,wynnbet';
const ALT_LINES_MIN_BOOKS = 2; // Require at least 2 books for each alt line value
// …unless Pinnacle is the sole book. Pinnacle is sharp enough that we trust
// its line/price alone when no other book has posted that alt. Tennis alt
// totals, for example, only come from Pinnacle among the books we poll.
const ALT_LINES_PINNACLE_ALONE_OK = true;

// Sports that use The Odds API as fallback (SharpAPI free tier doesn't cover them)
const ODDS_API_FALLBACK = {
  'tennis': {
    // Tennis tournaments rotate — discover active ones dynamically
    dynamic: true,
    sportPrefix: 'tennis_',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'basketball_ncaab': {
    oddsApiSport: 'basketball_ncaab',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // NBA Summer League. PX runs a full July slate (9 games on 2026-07-16) tagged
  // sport_name='Basketball' with REAL NBA team names, so they resolve to a
  // Basketball sportKey — but basketball_nba is OUT OF SEASON and TOA returns 0
  // events for it, so every Summer League game failed team-matching and was
  // dropped. TOA carries them under a separate ACTIVE key
  // (basketball_nba_summer_league, active=true while basketball_nba is
  // active=false). NOT flipGated: SharpAPI is retired and never had this league,
  // so TOA is the only source — gating it behind TOA_PRIMARY_SPORTS would just
  // leave it dark.
  // Verified 2026-07-16: 8 events, 9 books each (FD/DK/Fanatics/Bovada),
  // h2h+spreads+totals, and TOA team names match PX EXACTLY (no override map
  // needed).
  'basketball_nba_summer_league': {
    oddsApiSport: 'basketball_nba_summer_league',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // Canadian Football League (added 2026-07-24). PX lists CFL games as
  // sport_name='American Football' with tournament_name='CFL' — they resolved
  // only to nfl/ncaab keys (whose caches are offseason futures), so every CFL
  // game failed team-matching and was dropped. TOA's americanfootball_cfl key
  // is ACTIVE in summer (verified 2026-07-24: all 3 PX-listed games, 22 books
  // incl. DK/FD, h2h+spreads+totals; team names match PX except
  // 'British Columbia Lions' vs TOA 'BC Lions' — last-word matching handles
  // it). Not flipGated: SharpAPI is retired and never carried CFL.
  'americanfootball_cfl': {
    oddsApiSport: 'americanfootball_cfl',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // NFL preseason (added 2026-08-12). TOA serves preseason under a SEPARATE
  // active key — americanfootball_nfl's ~272 cached events are the September
  // regular season, so August preseason games had no odds and every one
  // failed team-matching (prod unmatchedEventDetails named the 8/6 game).
  // Kept as its own key deliberately: merging preseason events into the
  // americanfootball_nfl cache would arm the virtual-registration alt-spread
  // trap (MAX_ALT_DEVIATION=15 under the nfl key registers any prop leg with
  // a line ≤15 as an alt spread); under a distinct key that lookup misses and
  // fails closed. Team names match PX byte-identically ("Carolina Panthers").
  // Not flipGated: SharpAPI is retired and never carried preseason.
  'americanfootball_nfl_preseason': {
    oddsApiSport: 'americanfootball_nfl_preseason',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'americanfootball_nfl': {
    oddsApiSport: 'americanfootball_nfl',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'americanfootball_ncaaf': {
    oddsApiSport: 'americanfootball_ncaaf',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'basketball_wnba': {
    oddsApiSport: 'basketball_wnba',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_usa_mls': {
    oddsApiSport: 'soccer_usa_mls',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_epl': {
    oddsApiSport: 'soccer_epl',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_uefa_champs_league': {
    oddsApiSport: 'soccer_uefa_champs_league',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_uefa_europa_league': {
    oddsApiSport: 'soccer_uefa_europa_league',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_spain_la_liga': {
    oddsApiSport: 'soccer_spain_la_liga',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_italy_serie_a': {
    oddsApiSport: 'soccer_italy_serie_a',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_germany_bundesliga': {
    oddsApiSport: 'soccer_germany_bundesliga',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_france_ligue_one': {
    oddsApiSport: 'soccer_france_ligue_one',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_usa_nwsl': {
    oddsApiSport: 'soccer_usa_nwsl',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_mexico_ligamx': {
    oddsApiSport: 'soccer_mexico_ligamx',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_brazil_campeonato': {
    oddsApiSport: 'soccer_brazil_campeonato',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'soccer_conmebol_libertadores': {
    // TOA's real key has 'copa' in it — the old value silently 404'd
    // (SharpAPI-removal audit: one of the two dead soccer keys).
    oddsApiSport: 'soccer_conmebol_copa_libertadores',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // Argentine Primera División (added 2026-07-24). PX runs a steady slate
  // (tournament_name='Argentinian Primera Division', 6-7 games/wk) that
  // showed up as ~$5.6K of network-filled 'unknown legs' misses in a 2-day
  // market-intel sample — the league was simply never wired.
  'soccer_argentina_primera_division': {
    oddsApiSport: 'soccer_argentina_primera_division',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // English Championship (EFL Championship — second tier below EPL).
  // Added 2026-05-11 after operator caught Hull City @ Millwall registered
  // under the generic 'soccer' bucket with fairProb=null because SharpAPI's
  // generic-soccer feed doesn't surface Championship games. Routing it
  // through The Odds API as a dedicated league key gives us h2h/spreads/
  // totals coverage and lets line-manager prefer it over generic soccer.
  'soccer_efl_champ': {
    oddsApiSport: 'soccer_efl_champ',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // English League One and UEFA Champions League QUALIFICATION (added
  // 2026-08-22). Both were added to SUPPORTED_SPORTS on 2026-08-21 but NOT
  // here, and this map is what actually authorizes a fetch: fetchOddsForSport
  // returns early for any sport with no entry, so neither league ever issued
  // a single request. The symptom was eventCount 0 / ageMinutes null, which
  // is indistinguishable at a glance from "fetched, found nothing" -- compare
  // basketball_ncaab, which reports eventCount 0 with a REAL age because it
  // does get fetched. Verified against the live TOA board: League One returns
  // 11 fixtures, UCL qualification 7.
  //
  // Adding a key to SUPPORTED_SPORTS is NOT enough to make it quote. It needs
  // an entry here too, or it silently goes dark.
  'soccer_england_league1': {
    oddsApiSport: 'soccer_england_league1',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // NOTE: distinct from 'soccer_uefa_champs_league' above -- that is the
  // league phase, which starts in September. August fixtures live under the
  // qualification key. Both must stay registered across the changeover.
  'soccer_uefa_champs_league_qualification': {
    oddsApiSport: 'soccer_uefa_champs_league_qualification',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // Golf and combat sports — h2h only (no spreads/totals on these markets)
  'golf_pga_championship': {
    oddsApiSport: 'golf_pga_championship',
    markets: 'h2h,outrights',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  'boxing_boxing': {
    oddsApiSport: 'boxing_boxing',
    markets: 'h2h',
    bookmakers: ODDS_API_BOOKMAKERS,
  },
  // -------------------------------------------------------------------------
  // FLIP-GATED ENTRIES (SharpAPI-removal audit). These sports stay
  // SharpAPI-primary until listed in the TOA_PRIMARY_SPORTS env var — the
  // plain ODDS_API_FALLBACK dispatch ignores entries with flipGated:true,
  // and the TOA-primary block in fetchOddsForSport routes them instead.
  // Flip one sport at a time (env change = restart), 48h soak each, MLB
  // last (F5 + pitcher-feed + tightest stale gate).
  // -------------------------------------------------------------------------
  'basketball_nba': {
    oddsApiSport: 'basketball_nba',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
    flipGated: true,
  },
  'icehockey_nhl': {
    oddsApiSport: 'icehockey_nhl',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
    flipGated: true,
  },
  'baseball_mlb': {
    oddsApiSport: 'baseball_mlb',
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
    flipGated: true,
  },
  // MMA returns to TOA when flipped (it predated the move to SharpAPI).
  // Long-tail small-card breadth is accepted loss; the DK scraper merge
  // (mergeDkMmaFights) backstops major cards.
  'mma_mixed_martial_arts': {
    oddsApiSport: 'mma_mixed_martial_arts',
    markets: 'h2h,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
    flipGated: true,
  },
  // Generic soccer (incl. World Cup team lines — SharpAPI's single 'soccer'
  // feed today). Dynamic discovery over TOA's soccer_* keys, CURATED via
  // TOA_SOCCER_KEYS (uncurated, club season historically exposes ~53 active
  // keys — a quota footgun). Club leagues with their own dedicated entries
  // above are excluded here to avoid double-fetching.
  'soccer': {
    dynamic: true,
    sportPrefix: 'soccer_',
    // Default: World Cup only — MLS/Brazil/Libertadores already fetch via
    // their own dedicated entries above (the discovery filter excludes
    // dedicated keys anyway, so listing them here is a harmless no-op).
    keyAllowlist: () => new Set((process.env.TOA_SOCCER_KEYS
      || 'soccer_fifa_world_cup')
      .split(',').map(s => s.trim()).filter(Boolean)),
    markets: 'h2h,spreads,totals',
    bookmakers: ODDS_API_BOOKMAKERS,
    flipGated: true,
  },
};

// SharpAPI-removal flip switch (audit): sports listed here route to TOA
// ahead of their LEAGUE_MAP SharpAPI path. Flip one sport at a time via
// Railway env; example full set after migration:
//   TOA_PRIMARY_SPORTS=basketball_nba,icehockey_nhl,mma_mixed_martial_arts,soccer,baseball_mlb
function _isToaPrimary(sport) {
  // SharpAPI retired 2026-06-17: TOA is primary for ALL flip-gated sports by
  // default. TOA_PRIMARY_SPORTS was the one-sport-at-a-time migration toggle
  // (flip a sport to TOA while Sharp was still primary) and is now optional:
  //   - unset/empty (the new normal): every flip-gated sport is TOA-primary
  //   - set (legacy): TOA-primary restricted to the listed sports
  const raw = (process.env.TOA_PRIMARY_SPORTS || '').trim();
  if (!raw) return true;
  return raw.split(',').map(s => s.trim()).includes(sport);
}

// TOA quota alarm (SharpAPI-removal audit): once TOA is the only odds
// source, quota exhaustion = the whole book goes dark (it has already
// caused one fill drought). Alarm loudly (log.error + push) when remaining
// credits cross the threshold; once per hour to avoid spam. Wire every
// x-requests-remaining header read through this.
const TOA_QUOTA_ALARM_THRESHOLD = parseInt(process.env.TOA_QUOTA_ALARM_THRESHOLD) || 2000000;
let _toaQuotaAlarmAt = 0;
function _checkToaQuota(remaining) {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return;
  if (r < TOA_QUOTA_ALARM_THRESHOLD && Date.now() - _toaQuotaAlarmAt > 3600 * 1000) {
    _toaQuotaAlarmAt = Date.now();
    log.error('OddsFeed', `TOA QUOTA ALARM: ${r.toLocaleString()} credits remaining (< ${TOA_QUOTA_ALARM_THRESHOLD.toLocaleString()}) — at burn this risks a book-wide dark-out at cycle end`);
    try { require('./push').notifyConnectionState('toa-quota', `TOA credits low: ${r.toLocaleString()} remaining`); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// SHARPAPI CLIENT
// ---------------------------------------------------------------------------

// SharpAPI fully retired 2026-06-25 (operator cancelled the subscription).
// Hard kill-switch: SharpAPI is NO LONGER A SOURCE FOR ANYTHING. Every odds
// path resolves from The Odds API (TOA) + the DK/FD scrapers. This helper is
// the single gate every former Sharp call-site checks: it stays false unless
// SHARPAPI_ENABLED is explicitly set to 'true' (emergency re-enable only), so
// even if a stale SHARP_ODDS_API_KEY lingers in the environment, no Sharp
// request is ever issued — the overlap-window fall-throughs all fail closed
// to TOA (stale gates decline if TOA is empty). Replaces the scattered
// `process.env.SHARP_ODDS_API_KEY` presence checks that previously let Sharp
// run whenever the key happened to be set.
function _sharpEnabled() {
  return process.env.SHARPAPI_ENABLED === 'true' && !!process.env.SHARP_ODDS_API_KEY;
}

/**
 * Fetch odds for a single league from SharpAPI.
 * Gets moneyline, spread, and total markets from all available books,
 * then de-vigs by averaging across books.
 */
async function fetchOddsForSport(sport, opts) {
  opts = opts || {};
  const liveMode = !!opts.live;
  // DataGolf integration for golf matchups — handled separately
  if (sport === 'golf_matchups') {
    if (liveMode) return null;
    const datagolf = require('./datagolf');
    const result = await datagolf.fetchGolfMatchupsCache();
    oddsCache[sport] = { fetchedAt: result.fetchedAt, events: result.events };
    return result.events;
  }
  // Tennis: TOA dynamic discovery is primary (Pinnacle/FD/DK), but TOA's
  // tournament coverage lags overnight — Madrid Open prelims at 7am ET were
  // returning 0 events from TOA while SharpAPI had Caesars/DK/FD/BetMGM rows.
  // Try TOA first, fall through to SharpAPI when TOA empty.
  if (sport === 'tennis') {
    if (liveMode) return null;
    const toaResult = await fetchFromTheOddsApi(sport);
    // fetchDynamicSports REPLACES oddsCache['tennis'] wholesale when TOA has
    // active tournaments, which destroys every Bovada/DK event merged in since
    // the last cycle. Re-apply the last Bovada board SYNCHRONOUSLY here — no
    // network, just re-merging cached data — so coverage never dips between
    // the overwrite and the next async merge. Without this the cache sawtooths
    // (observed 17 -> 369 -> 16) and RFQs landing in a trough decline "no fair
    // value" on lines that ARE registered.
    if (toaResult && Object.keys(toaResult).length > 0) {
      // Pinnacle first — merge order IS source priority (neither merge clobbers
      // an already-covered pair), and Pinnacle is the sharper board with the
      // only real half-point ladder.
      try { await mergePinnacleTennisMatches({ reapply: true }); }
      catch (err) { log.warn('OddsFeed', `Pinnacle tennis re-apply failed: ${err.message}`); }
      try { await mergeBovadaTennisMatches({ reapply: true }); }
      catch (err) { log.warn('OddsFeed', `Bovada tennis re-apply failed: ${err.message}`); }
      return toaResult;
    }
    // SharpAPI retired (2026-06-25): TOA is authoritative for tennis. Return
    // whatever TOA gave (possibly empty) and let the staleness gate decline
    // (fail closed) — never fall through to a Sharp call.
    if (!_sharpEnabled()) return toaResult || {};
    log.info('OddsFeed', 'Tennis TOA returned 0 events — falling through to SharpAPI (SHARPAPI_ENABLED override)');
    // fall through to SharpAPI path below
  } else if (ODDS_API_FALLBACK[sport] && ODDS_API_FALLBACK[sport].flipGated && _isToaPrimary(sport)) {
    // SharpAPI retired (2026-06-25): TOA is the sole source for these sports.
    // Return TOA's result (possibly empty → stale gates decline, fail closed);
    // never fall through to a Sharp call unless SHARPAPI_ENABLED is set.
    if (liveMode) return null;
    try {
      const toaResult = await fetchFromTheOddsApi(sport);
      if (toaResult && Object.keys(toaResult).length > 0) return toaResult;
      if (!_sharpEnabled()) return toaResult || {};
      log.warn('OddsFeed', `${sport}: TOA-primary returned 0 events — falling through to SharpAPI (SHARPAPI_ENABLED override)`);
    } catch (err) {
      if (!_sharpEnabled()) throw err;
      log.warn('OddsFeed', `${sport}: TOA-primary fetch failed (${err.message}) — falling through to SharpAPI (SHARPAPI_ENABLED override)`);
    }
    // fall through to SharpAPI path below
  } else if (ODDS_API_FALLBACK[sport] && !ODDS_API_FALLBACK[sport].flipGated) {
    if (liveMode) {
      // Live odds for Odds-API-fallback sports not implemented yet
      return null;
    }
    return fetchFromTheOddsApi(sport);
  }

  // SharpAPI fully retired (2026-06-25). This block is the legacy Sharp /odds
  // fetch; with every configured sport routed through TOA above it is already
  // unreachable, but guard it anyway so a future routing change can never
  // silently resurrect a Sharp call. Fail closed to empty (stale gate handles
  // the rest). Set SHARPAPI_ENABLED=true to override in an emergency.
  if (!_sharpEnabled()) {
    log.debug('OddsFeed', `${sport}: SharpAPI disabled (retired) — returning empty, TOA is authoritative`);
    return {};
  }

  const mapping = LEAGUE_MAP[sport];
  if (!mapping) throw new Error(`Unknown sport: ${sport}`);

  // Market types vary by sport. SharpAPI's /odds endpoint caps `limit` at
  // 200 per request; we paginate with `cursor` until meta.pagination.has_more
  // is false to drain each market. Splitting by market type still helps
  // because of the tier request-rate limit (Hobby = 120/min) — a single
  // drained fetch per market is much cheaper than a single multi-market
  // fetch that then re-pages through everything.
  //
  // PROP_MARKET_TYPES: any market_type fetched here that should NOT flow
  // through the core de-vig pipeline (which expects moneyline / spread /
  // total shapes). Prop rows are partitioned into propRowsCache for the
  // shadow-pricing path. Update both this set AND marketTypesList when
  // adding a new prop market.
  const marketTypesList = {
    'baseball_mlb': ['moneyline', 'run_line', 'total_runs', 'team_total', '1st_5_innings_moneyline', '1st_5_innings_run_line', 'player_strikeouts'],
    'icehockey_nhl': ['moneyline', 'puck_line', 'total_goals', 'team_total'],
    'basketball_nba': ['moneyline', 'point_spread', 'total_points', 'team_total', 'player_points'],
    'tennis': ['moneyline', 'point_spread', 'total_points'],
    'soccer': ['moneyline', 'point_spread', 'total_goals', 'team_total'],
    'mma_mixed_martial_arts': ['moneyline'],
  }[sport] || ['moneyline', 'point_spread', 'total_points', 'team_total'];

  log.info('OddsFeed', `Fetching ${liveMode ? 'LIVE ' : ''}${mapping.value} odds from SharpAPI (${marketTypesList.length} market types)...`);

  // Fetch each market type separately and paginate with `cursor` until
  // meta.pagination.has_more is false. Hard safety cap on pages so a bad
  // cursor can never cause an infinite loop.
  const PAGE_LIMIT = 200; // SharpAPI /odds max per request
  const MAX_PAGES_PER_MARKET = 50; // safety: 50 × 200 = 10k rows
  const rows = [];
  const marketBreakdown = {};
  for (const mt of marketTypesList) {
    const baseUrl = `${config.oddsApi.baseUrl}/odds`
      + `?${mapping.param}=${mapping.value}`
      + `&market=${mt}`
      + `&live=${liveMode ? 'true' : 'false'}`
      + `&limit=${PAGE_LIMIT}`;
    let cursor = null;
    let pages = 0;
    let mtRowCount = 0;
    const mtEvents = new Set();
    const mtBooks = new Set();
    let errorState = null;
    while (pages < MAX_PAGES_PER_MARKET) {
      const url = cursor ? `${baseUrl}&cursor=${encodeURIComponent(cursor)}` : baseUrl;
      try {
        const resp = await fetch(url, {
          headers: { 'X-API-Key': config.oddsApi.apiKey },
        });
        if (!resp.ok) {
          const text = await resp.text();
          log.warn('OddsFeed', `SharpAPI ${resp.status} for ${mapping.value}/${mt} (page ${pages + 1}): ${text.substring(0, 100)}`);
          errorState = resp.status;
          break;
        }
        const body = await safeJsonFetch(resp);
        const mtRows = body.data || [];
        rows.push(...mtRows);
        mtRowCount += mtRows.length;
        for (const r of mtRows) {
          if (r.event_id) mtEvents.add(r.event_id);
          if (r.sportsbook) mtBooks.add(r.sportsbook);
        }
        pages++;
        const pagination = body.meta && body.meta.pagination;
        if (!pagination || !pagination.has_more || !pagination.next_cursor) break;
        cursor = pagination.next_cursor;
      } catch (err) {
        log.warn('OddsFeed', `Fetch error for ${mapping.value}/${mt} (page ${pages + 1}): ${err.message}`);
        errorState = err.message;
        break;
      }
    }
    if (pages >= MAX_PAGES_PER_MARKET) {
      log.warn('OddsFeed', `Hit ${MAX_PAGES_PER_MARKET}-page safety cap for ${mapping.value}/${mt} — possible pagination loop`);
    }
    marketBreakdown[mt] = {
      rows: mtRowCount,
      events: mtEvents.size,
      books: mtBooks.size,
      pages,
      ...(errorState != null ? { error: errorState } : {}),
    };
    log.debug('OddsFeed', `  ${mt}: ${mtRowCount} rows across ${pages} page(s)`);
  }
  // Compact one-line breakdown: "moneyline=450r/15e/4b/3p, team_total=0r/0e/0b/1p(EMPTY), ..."
  const breakdownStr = Object.entries(marketBreakdown)
    .map(([mt, b]) => {
      const flag = b.error ? `(ERR:${b.error})` : (b.rows === 0 ? '(EMPTY)' : '');
      return `${mt}=${b.rows}r/${b.events}e/${b.books}b/${b.pages}p${flag}`;
    })
    .join(', ');
  log.info('OddsFeed', `SharpAPI ${mapping.value} breakdown: ${breakdownStr}`);
  log.info('OddsFeed', `Got ${rows.length} total odds rows for ${mapping.value} across ${marketTypesList.length} markets`);

  // Partition prop rows out of the main pipeline. The downstream de-vig +
  // line-manager seeding code only knows how to handle moneyline / spread /
  // total / team_total shapes; prop rows would either be silently dropped
  // or cause warnings. Keep them in propRowsCache for the shadow-pricing
  // path (services/websocket.js → odds-feed.lookupPlayerStrikeoutProp).
  const propRows = [];
  const coreRows = [];
  for (const row of rows) {
    if (row && PROP_MARKET_TYPES.has(row.market_type)) propRows.push(row);
    else coreRows.push(row);
  }
  if (propRows.length > 0) {
    if (!propRowsCache[sport]) propRowsCache[sport] = {};
    // Group props by market_type so callers can query "all
    // player_strikeouts rows for sport=X" with one map lookup.
    // Apply cleanTeamName here so SharpAPI's abbreviated names
    // (e.g. "BOS Red Sox") are canonicalized to PX-compatible
    // forms before the cache stores them — avoids needing the
    // matcher to handle both forms.
    const byMt = {};
    for (const r of propRows) {
      if (!byMt[r.market_type]) byMt[r.market_type] = [];
      byMt[r.market_type].push({
        ...r,
        home_team: cleanTeamName(r.home_team),
        away_team: cleanTeamName(r.away_team),
      });
    }
    propRowsCache[sport] = { ...propRowsCache[sport], ...byMt, fetchedAt: Date.now() };
    const mtSummary = Object.entries(byMt)
      .map(([mt, arr]) => `${mt}=${arr.length}`)
      .join(', ');
    log.info('OddsFeed', `Cached ${propRows.length} prop rows for ${mapping.value} (${mtSummary})`);
  }
  // Use coreRows (non-prop) for the existing grouping pipeline.
  const groupingRows = coreRows;

  // Group by event, then by market+selection to de-vig across books
  const eventMap = {};
  // SharpAPI's MLB feed sometimes returns sub-game data as SEPARATE events
  // with team names carrying a sub-game suffix ("Washington first 5
  // innings"). These pollute the cache as phantom entries that don't
  // merge with the proper full-game event, and their data lands in the
  // wrong market slots (e.g. markets.totals instead of markets.totals_f5).
  // Verified 2026-05-03 Milwaukee/Washington: a phantom entry under team
  // name "Washington first 5 innings" carried a `totals` market with all
  // rawOdds=null, while the proper Mil/Was game entry simply had no F5
  // markets. Drop these phantom rows at ingestion — real F5 coverage
  // comes via SharpAPI's own '1st_5_innings_*' market_type rows on the
  // proper event AND the TOA F5 supplement; phantom rows just corrupt
  // the cache and never carry useful data.
  const SUB_GAME_TEAM_SUFFIX = /\b(first\s+5\s+innings|1st\s+5\s+innings|first\s+half|1st\s+half|first\s+quarter|1st\s+quarter|first\s+period|1st\s+period|\d{4}\s+1st\s+round\s+series|\d{4}\s+2nd\s+round\s+series|\d{4}\s+conference\s+(?:semifinals?|finals?))\b/i;
  let phantomDropped = 0;
  for (const row of groupingRows) {
    if (SUB_GAME_TEAM_SUFFIX.test(row.home_team || '') || SUB_GAME_TEAM_SUFFIX.test(row.away_team || '')) {
      phantomDropped++;
      continue;
    }
    const eventId = row.event_id;
    if (!eventMap[eventId]) {
      eventMap[eventId] = {
        homeTeam: cleanTeamName(row.home_team),
        awayTeam: cleanTeamName(row.away_team),
        // Capture raw names for lineup tracking (SharpAPI appends starter
        // info in parens: "New York Yankees (Gerrit Cole)"). First non-null
        // raw name wins — SharpAPI is consistent within a single fetch.
        rawHomeTeam: row.home_team,
        rawAwayTeam: row.away_team,
        commenceTime: row.event_start_time,
        eventId,
        odds: [], // collect all odds rows
      };
    }
    eventMap[eventId].odds.push(row);
  }
  if (phantomDropped > 0) {
    log.info('OddsFeed', `Dropped ${phantomDropped} phantom sub-game rows (team name carrying F5/H1/Q1/P1 suffix) for ${sport}`);
  }

  // Cross-book home/away normalization. Different books occasionally disagree
  // on which team is home — most common in MMA (neutral-site fights, no real
  // home), but seen sporadically in MLB doubleheaders / international games
  // too. eventMap[eid].homeTeam is locked from the FIRST row's home_team, so
  // any subsequent row whose home_team matches eventMap.awayTeam is in the
  // OPPOSITE orientation and its selection_type is mislabeled relative to
  // our authoritative event sides. Without normalization, getBookPairs keys
  // by selection_type and averages the wrong sides together — visible
  // 2026-05-05 on UFC Fight Night card: Stephens (true ~77% fav at -340)
  // priced with fair=27% because half the books labeled King Green as home
  // and their "home" rows got averaged into our home (Stephens) bucket.
  //
  // Flip selection_type per swapped row (home↔away, home_over↔away_over,
  // etc.) AND negate signed line/point on spread rows so a "home -1.5" row
  // arriving in opposite-orientation correctly becomes "away +1.5" relative
  // to our event sides.
  const SELECTION_FLIP_MAP = {
    home: 'away', away: 'home',
    home_over: 'away_over', home_under: 'away_under',
    away_over: 'home_over', away_under: 'home_under',
  };
  const SPREAD_TYPES = new Set(['run_line', 'puck_line', 'point_spread']);
  let flippedRows = 0;
  for (const ev of Object.values(eventMap)) {
    const evHome = cleanTeamName(ev.homeTeam || '');
    const evAway = cleanTeamName(ev.awayTeam || '');
    if (!evHome || !evAway) continue;
    for (const row of ev.odds) {
      const rowHome = cleanTeamName(row.home_team || '');
      const rowAway = cleanTeamName(row.away_team || '');
      if (!rowHome || !rowAway) continue;
      if (rowHome === evHome && rowAway === evAway) continue; // already aligned
      if (rowHome === evAway && rowAway === evHome) {
        // Row is in opposite orientation — flip its labels in-place.
        if (row.selection_type && SELECTION_FLIP_MAP[row.selection_type]) {
          row.selection_type = SELECTION_FLIP_MAP[row.selection_type];
        }
        if (SPREAD_TYPES.has(row.market_type) && row.point != null) {
          row.point = -row.point;
        }
        // Realign the row's home_team / away_team for downstream code that
        // may key off either field (e.g., team_total selection construction).
        row.home_team = ev.homeTeam;
        row.away_team = ev.awayTeam;
        flippedRows++;
      }
    }
  }
  if (flippedRows > 0) {
    log.info('OddsFeed', `Cross-book home/away normalization: flipped ${flippedRows} row(s) for ${sport} (books disagreed on home assignment)`);
  }

  // Update lineup cache for MLB (pitchers) / NHL (goalies). Runs before
  // consensus building so downstream log output includes any detected change.
  if (!liveMode && (sport === 'baseball_mlb' || sport === 'icehockey_nhl')) {
    for (const ev of Object.values(eventMap)) {
      const homeStarter = extractStarter(ev.rawHomeTeam);
      const awayStarter = extractStarter(ev.rawAwayTeam);
      updateLineupState(sport, ev.homeTeam, ev.awayTeam, ev.commenceTime, homeStarter, awayStarter);
    }
  }

  // Merge single-book events (e.g. Kalshi) into matching multi-book events.
  // SharpAPI sometimes groups Kalshi under a separate event_id because Kalshi uses
  // abbreviated team names (e.g. "Chicago WS" instead of "Chicago White Sox").
  // This step merges those orphan events by fuzzy team name + date matching.
  {
    const eventIds = Object.keys(eventMap);
    // Identify "main" events (2+ books) and "orphan" events (1 book)
    const mainEvents = [];
    const orphanEvents = [];
    for (const eid of eventIds) {
      const ev = eventMap[eid];
      const books = new Set(ev.odds.map(r => r.sportsbook));
      if (books.size >= 2) mainEvents.push(eid);
      else orphanEvents.push(eid);
    }

    if (orphanEvents.length > 0 && mainEvents.length > 0) {
      // Build lookup of main event team names (normalized last-word matching)
      const getLastWords = (name) => {
        const words = normalizeTeamName(name).split(/\s+/);
        return words.slice(-2).join(' '); // last 2 words e.g. "white sox", "blue jays"
      };
      const getLastWord = (name) => {
        const words = normalizeTeamName(name).split(/\s+/);
        return words[words.length - 1]; // last word e.g. "sox", "jays"
      };

      let mergedOrphans = 0;
      for (const orphanId of orphanEvents) {
        const orphan = eventMap[orphanId];
        const orphanDate = orphan.commenceTime ? new Date(orphan.commenceTime).toISOString().substring(0, 10) : '';
        const oHomeLast = getLastWords(orphan.homeTeam);
        const oAwayLast = getLastWords(orphan.awayTeam);
        const oHomeSingle = getLastWord(orphan.homeTeam);
        const oAwaySingle = getLastWord(orphan.awayTeam);

        let bestMatch = null;
        let bestMatchSwapped = false;
        for (const mainId of mainEvents) {
          const main = eventMap[mainId];
          const mainDate = main.commenceTime ? new Date(main.commenceTime).toISOString().substring(0, 10) : '';
          // Date must match (or one is missing)
          if (orphanDate && mainDate && orphanDate !== mainDate) continue;

          const mHomeLast = getLastWords(main.homeTeam);
          const mAwayLast = getLastWords(main.awayTeam);
          const mHomeSingle = getLastWord(main.homeTeam);
          const mAwaySingle = getLastWord(main.awayTeam);

          // Try exact normalized match first
          const exactMatch = normalizeEventKey(orphan.homeTeam, orphan.awayTeam) ===
                             normalizeEventKey(main.homeTeam, main.awayTeam);
          // Try last-2-words match (handles "Chicago White Sox" vs "Chicago WS" where WS doesn't match)
          // Try last-word match (handles "Athletics" vs "A's" — both have last word issues)
          // Try containment (handles "san francisco giants" contains "giants")
          const homeMatch = exactMatch ||
            mHomeLast === oHomeLast ||
            mHomeSingle === oHomeSingle ||
            normalizeTeamName(main.homeTeam).includes(normalizeTeamName(orphan.homeTeam)) ||
            normalizeTeamName(orphan.homeTeam).includes(normalizeTeamName(main.homeTeam));
          const awayMatch = exactMatch ||
            mAwayLast === oAwayLast ||
            mAwaySingle === oAwaySingle ||
            normalizeTeamName(main.awayTeam).includes(normalizeTeamName(orphan.awayTeam)) ||
            normalizeTeamName(orphan.awayTeam).includes(normalizeTeamName(main.awayTeam));
          // Also try swapped home/away (Kalshi sometimes flips them)
          const homeMatchSwap = mHomeLast === oAwayLast || mHomeSingle === oAwaySingle ||
            normalizeTeamName(main.homeTeam).includes(normalizeTeamName(orphan.awayTeam)) ||
            normalizeTeamName(orphan.awayTeam).includes(normalizeTeamName(main.homeTeam));
          const awayMatchSwap = mAwayLast === oHomeLast || mAwaySingle === oHomeSingle ||
            normalizeTeamName(main.awayTeam).includes(normalizeTeamName(orphan.homeTeam)) ||
            normalizeTeamName(orphan.homeTeam).includes(normalizeTeamName(main.awayTeam));

          if (homeMatch && awayMatch) {
            bestMatch = mainId;
            bestMatchSwapped = false;
            break;
          }
          if (homeMatchSwap && awayMatchSwap) {
            bestMatch = mainId;
            bestMatchSwapped = true;
            break;
          }
        }

        if (bestMatch) {
          // Merge orphan odds into main event.
          // If the match was via swapped home/away, flip selection_type
          // so "home"/"away" align with the main event's perspective.
          // Without this, Kalshi's "home" odds (which refer to the orphan's
          // home = main's away) get averaged into the wrong side of the
          // consensus, corrupting fair probabilities.
          const SWAP_MAP = {
            'home': 'away', 'away': 'home',
            'home_over': 'away_over', 'home_under': 'away_under',
            'away_over': 'home_over', 'away_under': 'home_under',
          };
          for (const row of orphan.odds) {
            if (bestMatchSwapped) {
              if (row.selection_type && SWAP_MAP[row.selection_type]) {
                row.selection_type = SWAP_MAP[row.selection_type];
              }
              // Negate spread points when swapping (home -1.5 ↔ away +1.5)
              const isSpread = ['run_line', 'puck_line', 'point_spread'].includes(row.market_type);
              if (isSpread && row.point != null) {
                row.point = -row.point;
              }
            }
            eventMap[bestMatch].odds.push(row);
          }
          delete eventMap[orphanId];
          mergedOrphans++;
          if (bestMatchSwapped) {
            log.info('OddsFeed', `Merged swapped orphan ${orphan.homeTeam}/${orphan.awayTeam} → main ${eventMap[bestMatch].homeTeam}/${eventMap[bestMatch].awayTeam} (flipped selection_type)`);
          }
        }
      }
      if (mergedOrphans > 0) {
        log.info('OddsFeed', `Merged ${mergedOrphans} single-book events into main events for ${mapping.value}`);
      }
    }
  }

  // Supplement with Pinnacle odds from The Odds API
  // Pinnacle events have different IDs, so match by team names and merge.
  // Rows that don't match an existing SharpAPI event become NEW events —
  // this guarantees Pinnacle coverage even when SharpAPI's 50-row cap drops
  // events from the response.
  if (PINNACLE_SPORT_MAP[sport]) {
    const pinnacleRows = await fetchPinnacleRows(sport);
    if (pinnacleRows.length > 0) {
      // Match Odds API events to SharpAPI events by team key + DATE.
      // CRITICAL: do NOT use a dateless fallback. When The Odds API returns
      // multiple events for the same team matchup on different dates (today +
      // tomorrow), a dateless fallback merges tomorrow's odds into today's
      // SharpAPI event, corrupting the cached values. Concrete case: Reds @
      // Angels had a -190 fanduel for today and -132 for tomorrow; both got
      // pushed into the same _rawOdds array, and byBook last-write-wins made
      // tomorrow's (wrong) values overwrite today's (correct) values.
      const teamDateToEventId = {};
      for (const [eid, ev] of Object.entries(eventMap)) {
        const key = normalizeEventKey(ev.homeTeam, ev.awayTeam);
        const date = ev.commenceTime ? new Date(ev.commenceTime).toISOString().substring(0, 10) : '';
        if (date) teamDateToEventId[key + '|' + date] = eid;
      }

      // Group Pinnacle rows by event (key + date) so we can create new events
      // for unmatched groups.
      const pinGroups = {};
      for (const row of pinnacleRows) {
        const home = cleanTeamName(row.home_team);
        const away = cleanTeamName(row.away_team);
        const key = normalizeEventKey(home, away);
        const rowDate = row.event_start_time ? new Date(row.event_start_time).toISOString().substring(0, 10) : '';
        const groupKey = key + '|' + rowDate;
        if (!pinGroups[groupKey]) {
          pinGroups[groupKey] = {
            home, away, key, rowDate,
            commenceTime: row.event_start_time,
            rows: [],
          };
        }
        pinGroups[groupKey].rows.push(row);
      }

      let merged = 0, created = 0;
      for (const [groupKey, group] of Object.entries(pinGroups)) {
        // Strictly require a date-specific match. If SharpAPI doesn't have
        // the same matchup on the same date, create a synthetic event for
        // the Odds API data rather than merging into a different date.
        const matchedId = group.rowDate ? teamDateToEventId[group.key + '|' + group.rowDate] : null;
        if (matchedId && eventMap[matchedId]) {
          // Merge into existing SharpAPI event
          for (const row of group.rows) eventMap[matchedId].odds.push(row);
          merged += group.rows.length;
        } else {
          // No matching SharpAPI event — create a NEW event from Pinnacle data.
          // Use a synthetic event_id prefixed with 'pin_' to avoid collisions.
          const synEventId = 'pin_' + group.key + '_' + group.rowDate;
          eventMap[synEventId] = {
            homeTeam: group.home,
            awayTeam: group.away,
            commenceTime: group.commenceTime,
            eventId: synEventId,
            odds: group.rows,
          };
          created++;
        }
      }
      log.info('OddsFeed', `Pinnacle: merged ${merged} rows, created ${created} new events for ${mapping.value}`);
    }
  }

  // Consolidate events that describe the same physical game. SharpAPI can
  // return the same matchup under different event_ids across its per-
  // market-type queries (e.g. moneyline event_id differs from totals
  // event_id), and the Odds-API supplement may also create a synthetic
  // event if SharpAPI's event_id wasn't the one in teamDateToEventId.
  // Result: same game appears twice in eventMap, with markets split
  // between entries — bettor RFQs miss h2h/totals depending on which
  // entry wins the cache lookup. Merge any events sharing the same
  // (normalizedKey, commence date) into the first one seen.
  {
    const byKeyDate = {};
    const toDelete = [];
    // Use the alias map so abbreviation/full-name pairs like "BOS Red Sox"
    // and "Boston Red Sox" collapse to the same consolidation key.
    const aliasedKey = (home, away) =>
      applyTeamAlias(normalizeTeamName(home)) + '|' + applyTeamAlias(normalizeTeamName(away));
    for (const [eid, ev] of Object.entries(eventMap)) {
      const key = aliasedKey(ev.homeTeam, ev.awayTeam);
      const date = ev.commenceTime ? new Date(ev.commenceTime).toISOString().substring(0, 10) : '';
      if (!date) continue;
      const kd = key + '|' + date;
      if (byKeyDate[kd] == null) {
        byKeyDate[kd] = eid;
      } else {
        const primary = eventMap[byKeyDate[kd]];
        // Merge odds rows from the duplicate into the primary entry,
        // preserving row-level book/market_type data. Downstream parse
        // step de-dups via getBookPairs so identical rows don't inflate
        // consensus counts.
        for (const row of (ev.odds || [])) primary.odds.push(row);
        toDelete.push(eid);
      }
    }
    for (const eid of toDelete) delete eventMap[eid];
    if (toDelete.length > 0) {
      log.info('OddsFeed', `Consolidated ${toDelete.length} duplicate ${mapping.value} events (merged into primary entries)`);
    }
  }

  // Parse into our cache format
  // Store as array per team pair to handle back-to-back series and doubleheaders
  const parsed = {};
  for (const [eventId, event] of Object.entries(eventMap)) {
    const key = normalizeEventKey(event.homeTeam, event.awayTeam);
    const markets = {};

    // Process moneyline
    const mlBooks = getBookPairs(event.odds, 'moneyline');
    if (mlBooks.length > 0) {
      markets.h2h = buildConsensusMoneyline(mlBooks);
    }

    // Process spread (point_spread / run_line / puck_line)
    const spreadTypes = ['point_spread', 'run_line', 'puck_line'];
    const spreadOdds = event.odds.filter(r => spreadTypes.includes(r.market_type));
    const spreadBooks = getBookPairs(spreadOdds, null);
    if (spreadBooks.length > 0) {
      markets.spreads = buildConsensusSpread(spreadBooks);
    }

    // Process totals (total_points / total_runs / total_goals)
    const totalTypes = ['total_points', 'total_runs', 'total_goals'];
    const totalOdds = event.odds.filter(r => totalTypes.includes(r.market_type));
    const totalBooks = getBookPairsForTotals(totalOdds);
    if (totalBooks.length > 0) {
      markets.totals = buildConsensusTotals(totalBooks);
    }

    // Process team totals
    const teamTotalOdds = event.odds.filter(r => r.market_type === 'team_total');
    if (teamTotalOdds.length > 0) {
      const teamTotalBooks = getBookPairsForTeamTotals(teamTotalOdds);
      if (teamTotalBooks.length > 0) {
        const tt = buildConsensusTeamTotals(teamTotalBooks);
        if (tt) markets.team_totals = tt;
      }
    }

    // F5 markets (MLB only) — SharpAPI returns them under '1st_5_innings_*'
    // naming. Totals aren't populated by SharpAPI currently; those come
    // from The Odds API via supplementMlbF5Markets. We just attach what
    // SharpAPI has here (h2h_f5, spreads_f5) so the primary feed covers
    // moneyline/run-line F5 without waiting for the Odds-API supplement.
    if (sport === 'baseball_mlb') {
      const mlF5Books = getBookPairs(event.odds, '1st_5_innings_moneyline');
      if (mlF5Books.length > 0) {
        const m = buildConsensusMoneyline(mlF5Books);
        if (m) markets.h2h_f5 = m;
      }
      const spreadF5Odds = event.odds.filter(r => r.market_type === '1st_5_innings_run_line');
      const spreadF5Books = getBookPairs(spreadF5Odds, null);
      if (spreadF5Books.length > 0) {
        const s = buildConsensusSpread(spreadF5Books);
        if (s) markets.spreads_f5 = s;
      }
    }

    if (Object.keys(markets).length > 0) {
      if (!parsed[key]) parsed[key] = [];
      parsed[key].push({
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        commenceTime: event.commenceTime,
        eventId,
        markets,
        _rawOdds: event.odds, // preserved for delta merging
      });
    }
  }

  const targetCache = liveMode ? liveOddsCache : oddsCache;
  targetCache[sport] = {
    fetchedAt: Date.now(),
    events: parsed,
  };

  // Set delta timestamp for incremental updates
  if (!liveMode && LEAGUE_MAP[sport]) {
    lastDeltaTimestamp[sport] = new Date().toISOString();
  }

  // Per-sport post-parse supplements (F5 / H1 / team totals / DK backstop).
  // HOISTED into _runPostParseSupplements (SharpAPI-removal audit): these
  // used to live only in this Sharp parse branch, so flipping a sport to
  // TOA-primary silently killed F5/H1/team-total quoting for it.
  if (!liveMode) {
    await _runPostParseSupplements(sport, parsed);
  }

  log.info('OddsFeed', `Cached ${Object.keys(parsed).length} ${liveMode ? 'LIVE ' : ''}events for ${mapping.value}`);
  return parsed;
}

// Sub-game + backstop supplements, shared by BOTH parse paths (SharpAPI and
// fetchFromTheOddsApi). All data here is TOA/DK-sourced already — only the
// INVOCATION used to be Sharp-branch-only.
//
// DK game-line scraper fallback rationale (operator directive 2026-05-03):
// any time the primary feed returns events lacking proper game-line markets
// (the Kalshi-only-stub pattern), the DK scraper backstop fills the gap.
// Sports need a GAME_LINE_CONFIGS entry in dk-scraper.js. NOTE: fill-only —
// it enriches cached events, it cannot create them.
const DK_GAME_LINE_SPORTS = new Set([
  'basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'basketball_wnba', 'tennis',
  'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_usa_mls',
  'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
  'soccer_brazil_campeonato', 'soccer_mexico_ligamx', 'soccer_usa_nwsl',
]);

// Sports whose refresh cycle warms 1st-Half markets (h2h_h1/spreads_h1/
// totals_h1). These keys are PER-EVENT-endpoint only — the bulk /odds
// endpoint 422s on them (same trap as F5/team_totals/BTTS) — so they ride
// supplementH1Markets. TOA serves the *_h1 keys for football too (measured
// on the 2026-08-06 preseason event), not just NBA; the supplement was
// previously hardcoded basketball_nba in both its gate and its URL.
// H1_SUPPLEMENT_SPORTS env overrides the whole set.
const H1_SUPPLEMENT_SPORTS = new Set(
  (process.env.H1_SUPPLEMENT_SPORTS
    || 'basketball_nba,americanfootball_nfl,americanfootball_nfl_preseason,americanfootball_ncaaf')
    .split(',').map(s => s.trim()).filter(Boolean)
);
// 1st-QUARTER add-on (2026-08-21). Same per-event-endpoint trap as H1, and
// TOA serves h2h_q1/spreads_q1/totals_q1 for football (verified on a
// not-started preseason event: 42 books, 20 market keys incl. all three).
// Football only — Q2-Q4 have no source, so we never ask for them. Riding the
// H1 supplement rather than adding a second per-event call matters: TOA rate-
// limits on request FREQUENCY, so one call carrying both sets is strictly
// cheaper than two.
const Q1_SUPPLEMENT_SPORTS = new Set(
  (process.env.Q1_SUPPLEMENT_SPORTS
    || 'americanfootball_nfl,americanfootball_nfl_preseason,americanfootball_ncaaf')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// Log/retry label: keeps the NBA strings byte-identical to the pre-
// generalization implementation (dashboards and log greps key on them).
const _h1Label = (sport) => sport === 'basketball_nba' ? 'NBA H1' : `${sport} H1`;

// MLB probable pitchers via the official MLB Stats API (free, keyless).
// SharpAPI-removal audit: pitcher identity used to arrive embedded in
// SharpAPI's team strings; the TOA path carries NO starter info, which
// would silently disable BOTH the lineup-change decline grace AND
// getPitcherSide (the kprop_ml same-team SGP carve-out). Active only when
// SharpAPI isn't feeding lineups (sport flipped to TOA-primary, or no
// Sharp key at all) so two writers with different name formats can't
// ping-pong the change-detection grace. NHL goalies remain a known gap
// post-Sharp (offseason; revisit before October).
let _mlbPitcherFetchAt = 0;
async function _refreshMlbProbablePitchers() {
  if (Date.now() - _mlbPitcherFetchAt < 60 * 1000) return; // ≤1 pull/min
  _mlbPitcherFetchAt = Date.now();
  const now = new Date(Date.now() - 4 * 3600 * 1000); // ET-ish window; DST drift only widens it
  const d1 = now.toISOString().substring(0, 10);
  const d2 = new Date(now.getTime() + 86400000).toISOString().substring(0, 10);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${d1}&endDate=${d2}&hydrate=probablePitcher`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MLB StatsAPI schedule ${resp.status}`);
  const data = await safeJsonFetch(resp);
  let updated = 0;
  for (const day of (data.dates || [])) {
    for (const g of (day.games || [])) {
      const home = g.teams && g.teams.home, away = g.teams && g.teams.away;
      if (!home || !away || !home.team || !away.team || !home.team.name || !away.team.name) continue;
      const hp = (home.probablePitcher && home.probablePitcher.fullName) || null;
      const ap = (away.probablePitcher && away.probablePitcher.fullName) || null;
      if (!hp && !ap) continue;
      updateLineupState('baseball_mlb', home.team.name, away.team.name, g.gameDate, hp, ap);
      updated++;
    }
  }
  log.debug('OddsFeed', `MLB probable pitchers from StatsAPI: ${updated} games`);
}

async function _runPostParseSupplements(sport, parsed) {
  // First-5-Innings markets for MLB (separate from full-game)
  if (sport === 'baseball_mlb') {
    try {
      await supplementMlbF5Markets(parsed);
    } catch (err) {
      log.warn('OddsFeed', `MLB F5 supplement failed: ${err.message}`);
    }
    _scheduleSupplementRetry(sport, 'MLB F5', supplementMlbF5Markets, parsed);
    // Pitcher feed — TOA is the sole lineup source now that SharpAPI is
    // retired (always runs; the Sharp lineup feed no longer exists).
    if (_isToaPrimary('baseball_mlb') || !_sharpEnabled()) {
      try {
        await _refreshMlbProbablePitchers();
      } catch (err) {
        log.warn('OddsFeed', `MLB probable-pitcher refresh failed: ${err.message}`);
      }
    }
  }

  if (DK_GAME_LINE_SPORTS.has(sport)) {
    try {
      await _supplementDkGameLines(parsed, sport);
    } catch (err) {
      log.warn('OddsFeed', `${sport} DK game-line supplement failed: ${err.message}`);
    }
  }

  // 1st-Half markets (separate from full-game) — NBA + football.
  if (H1_SUPPLEMENT_SPORTS.has(sport)) {
    try {
      await supplementH1Markets(parsed, sport);
    } catch (err) {
      log.warn('OddsFeed', `${_h1Label(sport)} supplement failed: ${err.message}`);
    }
    _scheduleSupplementRetry(sport, _h1Label(sport), supplementH1Markets, parsed, sport);
  }

  // Team totals for NBA/MLB/NHL (gap-fill from TOA on the refresh cycle).
  if (['basketball_nba', 'baseball_mlb', 'icehockey_nhl'].includes(sport)) {
    try {
      await supplementTeamTotals(parsed, sport);
    } catch (err) {
      log.warn('OddsFeed', `${sport} team_totals supplement failed: ${err.message}`);
    }
    _scheduleSupplementRetry(sport, `${sport} team_totals`, supplementTeamTotals, parsed, sport);
  }

  // BTTS for soccer. Per-event only — the bulk endpoint 422s on `btts`.
  if (BTTS_SPORTS.has(sport)) {
    try {
      await supplementBtts(parsed, sport);
    } catch (err) {
      log.warn('OddsFeed', `${sport} btts supplement failed: ${err.message}`);
    }
    _scheduleSupplementRetry(sport, `${sport} btts`, supplementBtts, parsed, sport);
  }
}

// Merge a freshly-supplemented sub-game market (h2h_f5/spreads_f5/
// totals_f5/h2h_h1/spreads_h1/totals_h1) into the existing cache entry
// without losing byLine entries that were populated by an earlier
// build (typically SharpAPI's '1st_5_innings_run_line' rows that the
// main parse stored before the per-event TOA supplement ran).
//
// Without this merge, the supplement OVERWRITES ev.markets.spreads_f5
// with TOA data only — and TOA's per-event response often contains
// only Pinnacle's pick-em (line=0) for thinner-volume games, while
// SharpAPI had BetMGM at the standard ±0.5. Result: PX RFQs at ±0.5
// returned null even though the data was in cache moments earlier.
//
// Strategy: prefer the FRESH (TOA) market as the base — its primary
// home/away/line is more reliable since TOA reaches more sharp books.
// Then union the byLine maps from both, with fresh winning on any
// line both sides happen to cover. SharpAPI-only lines (e.g. BetMGM
// ±0.5 when TOA only had Pinnacle line=0) are preserved.
function _mergeSupplementedMarket(existing, fresh) {
  if (!existing) return fresh;
  if (!fresh) return existing;
  const mergedByLine = { ...(existing.byLine || {}), ...(fresh.byLine || {}) };
  return { ...fresh, byLine: mergedByLine };
}

// Per-event TOA supplements (F5 / H1 / team_totals) are best-effort on
// the primary refresh cycle — if resolveOddsApiEventId misses for an
// event, or TOA returns a transient 4xx/5xx, that event's supplemented
// markets are silently skipped. Until the next full refresh (default
// 10 min), the affected game's H1 / F5 / team_total RFQs decline as
// "no fair value." Operator caught Lakers @ Rockets 2026-05-01: H1 ML
// nulled in the dashboard for the entire window between two refresh
// cycles even though TOA had the data and a manual /refresh-odds
// recovered it instantly.
//
// This helper schedules background retries at 60s / 120s / 240s after
// the initial supplement run. Each retry calls the same supplement
// function on the SAME parsed-events reference. The supplement's
// "skip events that already have all 3 markets" check (inside each
// supplement) makes this idempotent — successful events are skipped
// instantly; only still-missing events get a TOA call.
//
// If the cache is wholesale-replaced before a retry fires (next
// refresh cycle started), the retry is skipped — the new cycle's own
// retry chain takes over for the new events. Stale references are
// detected by checking that oddsCache[sport].events still === the
// captured parsed reference.
//
// Retry telemetry exposed via _supplementRetryStats (read by /status).
const _supplementRetryStats = {
  scheduled: 0,
  fired: 0,
  skippedStale: 0,
  failed: 0,
  succeeded: 0,
};
function _scheduleSupplementRetry(sport, supplementName, supplementFn, ...args) {
  const delaysMs = [60_000, 120_000, 240_000];
  const initialEventsRef = oddsCache[sport]?.events;
  if (!initialEventsRef) return;
  let attempt = 0;
  function next() {
    if (attempt >= delaysMs.length) return;
    _supplementRetryStats.scheduled++;
    setTimeout(async () => {
      _supplementRetryStats.fired++;
      // Stale-reference check: skip if the cache has been replaced by
      // a newer refresh cycle since this retry was scheduled. The new
      // cycle owns its own retry chain.
      if (oddsCache[sport]?.events !== initialEventsRef) {
        _supplementRetryStats.skippedStale++;
        return;
      }
      try {
        await supplementFn(...args);
        _supplementRetryStats.succeeded++;
        log.debug('OddsFeed', `${supplementName} retry attempt ${attempt + 1}/${delaysMs.length} complete`);
      } catch (err) {
        _supplementRetryStats.failed++;
        log.warn('OddsFeed', `${supplementName} retry attempt ${attempt + 1} failed: ${err.message}`);
      }
      attempt++;
      next();
    }, delaysMs[attempt]);
  }
  next();
}

function getSupplementRetryStats() {
  return { ..._supplementRetryStats };
}

/**
 * Fetch First-5-Innings (F5) markets for MLB from The Odds API and attach them
 * to the existing event cache as separate market types: h2h_f5, spreads_f5, totals_f5.
 * These are independent from full-game markets and need their own pricing.
 */
/**
 * Fuzzy lookup into a parsedEvents map (keyed by normalizeEventKey) that
 * falls back to last-word team-name matching. Handles the SharpAPI /
 * Odds-API abbreviation gap (e.g. SharpAPI's "A's", "Chicago WS" vs
 * Odds-API's "Oakland Athletics", "Chicago White Sox") that otherwise
 * silently breaks F5/H1 supplement matching.
 */
function findParsedEntryFuzzy(parsedEvents, home, away) {
  const exact = parsedEvents[normalizeEventKey(cleanTeamName(home), cleanTeamName(away))];
  if (exact) return exact;
  const lw = (name) => (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).pop() || '';
  const homeLW = lw(home), awayLW = lw(away);
  if (!homeLW || !awayLW) return null;
  for (const entry of Object.values(parsedEvents)) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const eh = lw(ev.homeTeam), ea = lw(ev.awayTeam);
      if ((eh === homeLW && ea === awayLW) || (eh === awayLW && ea === homeLW)) return entry;
    }
  }
  return null;
}

// DK game-line scraper fallback. Identifies events in the parsed cache
// that lack full game-line markets (no h2h, OR h2h is Kalshi-only stub
// with no per-book raw rows) and fills them from DK's scraper. Strictly
// additive — only writes markets that aren't already populated, so
// SharpAPI's primary data takes precedence when available.
async function _supplementDkGameLines(parsedEvents, sport) {
  const candidates = [];
  for (const entry of Object.values(parsedEvents)) {
    const events = Array.isArray(entry) ? entry : [entry];
    for (const ev of events) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      // Phantom / sub-game team-name suffix already filtered at ingestion.
      // Skip events that have full coverage from primary
      // (h2h with valid raw rows + spreads + totals).
      const m = ev.markets || {};
      const hasFullCoverage = m.h2h && m.h2h.home && (m.h2h.home.rawOdds != null || m.h2h.home.fairProb != null)
                            && m.spreads && m.totals;
      if (hasFullCoverage) continue;
      // Skip far-future events to limit work. Tracks the operator quote
      // horizon (QUOTE_HORIZON_DAYS) so raising the lever also widens DK
      // game-line supplement coverage, not just alt-line warming.
      const startMs = ev.commenceTime ? new Date(ev.commenceTime).getTime() : null;
      if (startMs != null && !isNaN(startMs)) {
        const hoursUntil = (startMs - Date.now()) / 3600000;
        if (hoursUntil > config.pricing.quoteHorizonHours || hoursUntil < -1) continue;
      }
      candidates.push(ev);
    }
  }
  if (candidates.length === 0) return;

  log.info('OddsFeed', `${sport} DK game-line supplement: ${candidates.length} events lack full coverage — invoking scraper`);
  let scrape;
  try {
    const dk = require('./dk-scraper');
    if (typeof dk.fetchDkGameLines !== 'function') return;
    scrape = await dk.fetchDkGameLines(sport);
  } catch (err) {
    log.warn('OddsFeed', `DK ${sport} game-line scrape failed: ${err.message}`);
    return;
  }
  if (!scrape || !Array.isArray(scrape.games) || scrape.games.length === 0) {
    log.warn('OddsFeed', `DK ${sport} game-line scrape returned no games`);
    return;
  }

  const dk = require('./dk-scraper');
  let applied = 0;
  for (const ev of candidates) {
    const gMatch = dk.lookupDkGameLines(sport, ev.homeTeam, ev.awayTeam);
    if (!gMatch) continue;
    const flipped = !!gMatch._flipped;
    if (!ev.markets) ev.markets = {};

    // h2h
    if (!ev.markets.h2h && gMatch.h2h) {
      const dkHome = flipped ? gMatch.h2h.away : gMatch.h2h.home;
      const dkAway = flipped ? gMatch.h2h.home : gMatch.h2h.away;
      ev.markets.h2h = {
        home: { rawOdds: dkHome.americanOdds, impliedProb: dkHome.impliedProb, fairProb: dkHome.fairProb, displayFairProb: dkHome.fairProb },
        away: { rawOdds: dkAway.americanOdds, impliedProb: dkAway.impliedProb, fairProb: dkAway.fairProb, displayFairProb: dkAway.fairProb },
        books: 1,
        draftkings: { home: dkHome.americanOdds, away: dkAway.americanOdds },
      };
    }

    // Spreads — pick primary (median line) + populate byLine for alts
    const sLines = Object.keys(gMatch.spreadsByLine || {});
    if (!ev.markets.spreads && sLines.length > 0) {
      const sortedLines = sLines.map(parseFloat).sort((a, b) => Math.abs(a) - Math.abs(b));
      const primaryLine = sortedLines[0];
      const primary = gMatch.spreadsByLine[String(primaryLine)] || gMatch.spreadsByLine[sLines[0]];
      const dkHome = flipped ? primary.away : primary.home;
      const dkAway = flipped ? primary.home : primary.away;
      const homeLine = flipped ? -primary.line : primary.line;
      ev.markets.spreads = {
        home: { rawOdds: dkHome.americanOdds, point: homeLine, impliedProb: dkHome.impliedProb, fairProb: dkHome.fairProb, displayFairProb: dkHome.fairProb },
        away: { rawOdds: dkAway.americanOdds, point: -homeLine, impliedProb: dkAway.impliedProb, fairProb: dkAway.fairProb, displayFairProb: dkAway.fairProb },
        line: homeLine,
        books: 1,
        byLine: {},
        draftkings: { home: dkHome.americanOdds, away: dkAway.americanOdds },
      };
      // byLine for alts (signed-line keyed for spreads)
      for (const [lk, ln] of Object.entries(gMatch.spreadsByLine)) {
        const sH = flipped ? ln.away : ln.home;
        const sA = flipped ? ln.home : ln.away;
        const signedHome = flipped ? -ln.line : ln.line;
        ev.markets.spreads.byLine['home|' + signedHome] = { fairProb: sH.fairProb };
        ev.markets.spreads.byLine['away|' + (-signedHome)] = { fairProb: sA.fairProb };
      }
    }

    // Totals — primary line + byLine for alts
    const tLines = Object.keys(gMatch.totalsByLine || {});
    if (!ev.markets.totals && tLines.length > 0) {
      const sortedLines = tLines.map(parseFloat).sort((a, b) => a - b);
      const primaryLine = sortedLines[Math.floor(sortedLines.length / 2)];
      const primary = gMatch.totalsByLine[String(primaryLine)] || gMatch.totalsByLine[tLines[0]];
      ev.markets.totals = {
        over: { rawOdds: primary.over.americanOdds, point: primary.line, impliedProb: primary.over.impliedProb, fairProb: primary.over.fairProb, displayFairProb: primary.over.fairProb },
        under: { rawOdds: primary.under.americanOdds, point: primary.line, impliedProb: primary.under.impliedProb, fairProb: primary.under.fairProb, displayFairProb: primary.under.fairProb },
        line: primary.line,
        books: 1,
        byLine: {},
        draftkings: { over: primary.over.americanOdds, under: primary.under.americanOdds },
      };
      for (const [lk, ln] of Object.entries(gMatch.totalsByLine)) {
        ev.markets.totals.byLine[lk] = { line: ln.line, over: { fairProb: ln.over.fairProb }, under: { fairProb: ln.under.fairProb } };
      }
    }

    // Team totals — per-team byLine
    if (!ev.markets.team_totals && (Object.keys(gMatch.teamTotalsByLine?.home || {}).length > 0 || Object.keys(gMatch.teamTotalsByLine?.away || {}).length > 0)) {
      const homeBucket = flipped ? gMatch.teamTotalsByLine.away : gMatch.teamTotalsByLine.home;
      const awayBucket = flipped ? gMatch.teamTotalsByLine.home : gMatch.teamTotalsByLine.away;
      const buildSide = (bucket) => {
        const lines = Object.keys(bucket || {});
        if (lines.length === 0) return null;
        const sortedLines = lines.map(parseFloat).sort((a, b) => a - b);
        const primaryLine = sortedLines[Math.floor(sortedLines.length / 2)];
        const primary = bucket[String(primaryLine)] || bucket[lines[0]];
        const byLine = {};
        for (const [lk, ln] of Object.entries(bucket)) {
          byLine[lk] = { line: ln.line, over: { fairProb: ln.over.fairProb }, under: { fairProb: ln.under.fairProb } };
        }
        return {
          line: primary.line,
          over: { rawOdds: primary.over.americanOdds, fairProb: primary.over.fairProb, displayFairProb: primary.over.fairProb },
          under: { rawOdds: primary.under.americanOdds, fairProb: primary.under.fairProb, displayFairProb: primary.under.fairProb },
          byLine,
        };
      };
      const homeTT = buildSide(homeBucket);
      const awayTT = buildSide(awayBucket);
      if (homeTT || awayTT) {
        ev.markets.team_totals = { books: 1 };
        if (homeTT) ev.markets.team_totals.home = homeTT;
        if (awayTT) ev.markets.team_totals.away = awayTT;
      }
    }
    applied++;
  }
  log.info('OddsFeed', `${sport} DK game-line supplement applied: ${applied}/${candidates.length} events filled`);
}

async function supplementMlbF5Markets(parsedEvents) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return;

  // IMPORTANT: The Odds API's bulk /odds endpoint does NOT support F5
  // market keys (h2h_1st_5_innings etc.) — returns 422 INVALID_MARKET.
  // F5 markets live on the per-event endpoint /events/{id}/odds.
  // Loop all parsed events and fetch F5 per-event (bounded concurrency).
  // Still cheap vs our quota (15-ish MLB games per cycle).

  // Collect candidate events (skip any that already have all 3 F5 markets).
  const candidates = [];
  for (const entry of Object.values(parsedEvents)) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (ev.markets && ev.markets.h2h_f5 && ev.markets.spreads_f5 && ev.markets.totals_f5) continue;
      candidates.push(ev);
    }
  }
  if (candidates.length === 0) {
    log.info('OddsFeed', 'MLB F5 supplement: no candidates');
    return;
  }

  let h2hCount = 0, spreadCount = 0, totalCount = 0, calls = 0, matchFails = 0, apiFails = 0;
  const CONCURRENCY = 3;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const ev = candidates[idx++];
      const resolved = await resolveOddsApiEventId('baseball_mlb', ev.homeTeam, ev.awayTeam, ev.commenceTime);
      if (!resolved) { matchFails++; continue; }

      const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${resolved.eventId}/odds`
        + `?apiKey=${theOddsApiKey}`
        + `&regions=us,eu`
        + `&markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings`
        + `&bookmakers=pinnacle,draftkings,fanduel`
        + `&oddsFormat=american`;

      try {
        const resp = await fetch(url);
        calls++;
        if (!resp.ok) { apiFails++; continue; }
        const data = await resp.json();

        const h2hPairs = [], spreadPairs = [], totalPairs = [];
        for (const book of (data.bookmakers || [])) {
          for (const m of (book.markets || [])) {
            if (m.key === 'h2h_1st_5_innings') {
              const homeOut = m.outcomes?.find(o => o.name === data.home_team);
              const awayOut = m.outcomes?.find(o => o.name === data.away_team);
              if (homeOut && awayOut) {
                h2hPairs.push({
                  book: book.key,
                  home: { odds_probability: americanToImpliedProb(homeOut.price), odds_american: homeOut.price },
                  away: { odds_probability: americanToImpliedProb(awayOut.price), odds_american: awayOut.price },
                });
              }
            } else if (m.key === 'spreads_1st_5_innings') {
              const homeOut = m.outcomes?.find(o => o.name === data.home_team);
              const awayOut = m.outcomes?.find(o => o.name === data.away_team);
              if (homeOut && awayOut) {
                spreadPairs.push({
                  book: book.key,
                  home: { odds_probability: americanToImpliedProb(homeOut.price), odds_american: homeOut.price, point: homeOut.point, line: homeOut.point },
                  away: { odds_probability: americanToImpliedProb(awayOut.price), odds_american: awayOut.price, point: awayOut.point, line: awayOut.point },
                });
              }
            } else if (m.key === 'totals_1st_5_innings') {
              const over = m.outcomes?.find(o => o.name === 'Over');
              const under = m.outcomes?.find(o => o.name === 'Under');
              if (over && under) {
                totalPairs.push({
                  book: book.key,
                  over: { odds_probability: americanToImpliedProb(over.price), odds_american: over.price, point: over.point, line: over.point },
                  under: { odds_probability: americanToImpliedProb(under.price), odds_american: under.price, point: under.point, line: under.point },
                });
              }
            }
          }
        }

        if (h2hPairs.length > 0) {
          const mk = buildConsensusMoneyline(h2hPairs);
          if (mk) { ev.markets.h2h_f5 = _mergeSupplementedMarket(ev.markets.h2h_f5, mk); h2hCount++; }
        }
        if (spreadPairs.length > 0) {
          const sp = buildConsensusSpread(spreadPairs);
          if (sp) { ev.markets.spreads_f5 = _mergeSupplementedMarket(ev.markets.spreads_f5, sp); spreadCount++; }
        }
        if (totalPairs.length > 0) {
          ev.markets.totals_f5 = _mergeSupplementedMarket(ev.markets.totals_f5, buildConsensusTotals(totalPairs));
          totalCount++;
        }
      } catch (err) {
        apiFails++;
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, candidates.length); i++) workers.push(worker());
  await Promise.all(workers);
  log.info('OddsFeed', `MLB F5 supplement (per-event): ${calls}/${candidates.length} calls, h2h+${h2hCount} spread+${spreadCount} total+${totalCount}, matchFails=${matchFails} apiFails=${apiFails}`);

  // DK scraper fallback: if any MLB events STILL lack h2h_f5 after the
  // TOA per-event supplement, scrape DK directly. DK posts F5 markets
  // on every MLB game hours before SharpAPI/TOA list them — verified
  // 2026-05-03 with Sunday afternoon games (Tampa@Toronto, Detroit@Boston,
  // SF@SD, Seattle@Atlanta) where SharpAPI returned only Kalshi-only
  // h2h stubs and TOA's events list didn't include them yet, but DK had
  // full F5 markets posted. Operator's directive: 100% F5 coverage on
  // MLB regardless of upstream API gaps.
  const stillMissingF5 = [];
  for (const entry of Object.values(parsedEvents)) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (ev.markets && ev.markets.h2h_f5) continue;
      stillMissingF5.push(ev);
    }
  }
  if (stillMissingF5.length === 0) return;

  log.info('OddsFeed', `MLB F5: ${stillMissingF5.length} events still lack F5 after TOA supplement — invoking DK scraper`);
  let dkScrape;
  try {
    const dk = require('./dk-scraper');
    dkScrape = await dk.fetchMlbF5Odds();
  } catch (err) {
    log.warn('OddsFeed', `DK MLB F5 scrape failed: ${err.message}`);
    return;
  }
  if (!dkScrape || !Array.isArray(dkScrape.games) || dkScrape.games.length === 0) {
    log.warn('OddsFeed', 'DK MLB F5 scrape returned no games');
    return;
  }

  // Index DK games by normalized team-pair for matching
  const lwLast = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).pop() || '';
  const dkByPair = {};
  for (const g of dkScrape.games) {
    if (!g.homeTeam || !g.awayTeam) continue;
    const k1 = `${lwLast(g.homeTeam)}|${lwLast(g.awayTeam)}`;
    const k2 = `${lwLast(g.awayTeam)}|${lwLast(g.homeTeam)}`;
    dkByPair[k1] = g;
    dkByPair[k2] = { ...g, _flipped: true };
  }

  let dkApplied = 0;
  for (const ev of stillMissingF5) {
    const key = `${lwLast(ev.homeTeam)}|${lwLast(ev.awayTeam)}`;
    const g = dkByPair[key];
    if (!g) continue;

    if (!ev.markets) ev.markets = {};
    // h2h_f5 — flip home/away if DK orientation is opposite
    const flipMl = !!g._flipped;
    const dkHome = flipMl ? g.h2h.away : g.h2h.home;
    const dkAway = flipMl ? g.h2h.home : g.h2h.away;
    ev.markets.h2h_f5 = {
      home: { rawOdds: dkHome.americanOdds, impliedProb: dkHome.impliedProb, fairProb: dkHome.fairProb, displayFairProb: dkHome.fairProb },
      away: { rawOdds: dkAway.americanOdds, impliedProb: dkAway.impliedProb, fairProb: dkAway.fairProb, displayFairProb: dkAway.fairProb },
      books: 1,
      draftkings: { home: dkHome.americanOdds, away: dkAway.americanOdds },
    };
    if (g.spreads) {
      const spHome = flipMl ? g.spreads.away : g.spreads.home;
      const spAway = flipMl ? g.spreads.home : g.spreads.away;
      ev.markets.spreads_f5 = {
        home: { rawOdds: spHome.americanOdds, point: spHome.line, impliedProb: spHome.impliedProb, fairProb: spHome.fairProb, displayFairProb: spHome.fairProb },
        away: { rawOdds: spAway.americanOdds, point: spAway.line, impliedProb: spAway.impliedProb, fairProb: spAway.fairProb, displayFairProb: spAway.fairProb },
        line: spHome.line,
        books: 1,
        draftkings: { home: spHome.americanOdds, away: spAway.americanOdds },
      };
    }
    const totalLines = Object.keys(g.totalsByLine || {});
    if (totalLines.length > 0) {
      // Pick the line closest to median as primary
      const sorted = totalLines.map(parseFloat).sort((a, b) => a - b);
      const primaryLine = sorted[Math.floor(sorted.length / 2)];
      const primary = g.totalsByLine[String(primaryLine)] || g.totalsByLine[totalLines[0]];
      if (primary) {
        ev.markets.totals_f5 = {
          over: { rawOdds: primary.over.americanOdds, point: primary.line, impliedProb: primary.over.impliedProb, fairProb: primary.over.fairProb, displayFairProb: primary.over.fairProb },
          under: { rawOdds: primary.under.americanOdds, point: primary.line, impliedProb: primary.under.impliedProb, fairProb: primary.under.fairProb, displayFairProb: primary.under.fairProb },
          line: primary.line,
          books: 1,
          draftkings: { over: primary.over.americanOdds, under: primary.under.americanOdds },
        };
      }
    }
    dkApplied++;
  }
  log.info('OddsFeed', `MLB F5 DK scrape applied: ${dkApplied} of ${stillMissingF5.length} missing events filled`);
}

// ---------------------------------------------------------------------------
// RFI (Run First Inning) — YRFI / NRFI fair-value sourcing
// ---------------------------------------------------------------------------
// "Run First Inning" = did >=1 run score in the 1st inning of an MLB game.
// This is the FIRST-INNING TOTAL, not a game line. YES ("a run scores in the
// 1st") == the book's OVER 0.5 on the 1st-inning total; NO == UNDER 0.5.
// Mirrors the Kalshi maker's RFI sourcing.
//
// Source: The Odds API market key `totals_1st_1_innings`, PER-EVENT endpoint
// only (the bulk /odds feed 422s on this key — same gotcha as F5). Regions and
// books are widened (config.rfi.regions / .bookmakers) because DraftKings
// posts NO 1st-inning total at all and many games are served ONLY by us2 books
// (williamhill_us / betrivers / betparx) — a narrow/sharp-only set covers
// ~2/13 games, the wide set covers the full slate. Pinnacle is the sharp
// anchor when present but often absent.
//
// De-vig: for each book, take OVER and UNDER at point 0.5 exactly, require a
// physical two-way (impliedOver + impliedUnder >= 1 — drops one-sided/stale
// quotes), proportionally de-vig that book's own 2-way (yesFair_book =
// impliedOver / (impliedOver + impliedUnder)), then AVERAGE yesFair across all
// qualifying books. Each book is de-vigged independently, so extra soft books
// only pull the average toward consensus (breadth is safe here).
//
// Fail-closed: returns null (never a fabricated fair) if the game has started
// or its start time is unknown, the event can't be resolved, the API errors,
// fewer than config.rfi.minBooks qualifying books, or the averaged fair isn't
// strictly in (0,1). This is read-only sourcing — safe to call regardless of
// config.rfi.enabled (that flag gates registration/quoting/writes, not this).
async function getRfiFair(sport, homeTeam, awayTeam, commenceTime) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return null;
  if (sport && sport !== 'baseball_mlb') return null; // RFI is MLB-only

  // Fail-closed if the game has started or its start time is unknown.
  const startMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null;

  const resolved = await resolveOddsApiEventId('baseball_mlb', homeTeam, awayTeam, commenceTime);
  if (!resolved || !resolved.eventId) return null;

  const { regions, bookmakers, minBooks } = config.rfi;
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${resolved.eventId}/odds`
    + `?apiKey=${theOddsApiKey}`
    + `&regions=${regions}`
    + `&markets=totals_1st_1_innings`
    + `&bookmakers=${bookmakers}`
    + `&oddsFormat=american`;

  let data;
  try {
    const resp = await abortableFetch(url);
    if (!resp.ok) return null;
    data = await safeJsonFetch(resp);
  } catch (err) {
    return null;
  }
  if (!data) return null;

  // Per-book physical-two-way de-vig at the 0.5 line.
  const perBook = [];
  for (const book of (data.bookmakers || [])) {
    for (const m of (book.markets || [])) {
      if (m.key !== 'totals_1st_1_innings') continue;
      const over = (m.outcomes || []).find(o => o.name === 'Over' && Number(o.point) === 0.5);
      const under = (m.outcomes || []).find(o => o.name === 'Under' && Number(o.point) === 0.5);
      if (!over || !under) continue;
      const impOver = americanToImpliedProb(over.price);
      const impUnder = americanToImpliedProb(under.price);
      if (!(impOver + impUnder >= 1)) continue; // physical 2-way only
      const yesFairBook = deVig2Way(impOver, impUnder)[0];
      if (!(yesFairBook > 0 && yesFairBook < 1)) continue;
      perBook.push({ book: book.key, overAmerican: over.price, underAmerican: under.price, yesFair: yesFairBook });
    }
  }

  if (perBook.length < minBooks) return null; // fail-closed — no qualifying book
  const yesFair = avg(perBook.map(b => b.yesFair));
  if (!(yesFair > 0 && yesFair < 1)) return null;

  return {
    market: 'run_first_inning',
    line: 0.5,
    yesFair,
    noFair: 1 - yesFair,
    books: perBook.length,
    perBook,
    eventId: resolved.eventId,
    homeTeam: data.home_team || homeTeam,
    awayTeam: data.away_team || awayTeam,
    commenceTime,
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// TEAM TOTALS — deterministic per-event sourcing.
//
// Team totals live ONLY on TOA's per-event endpoint (the bulk /odds endpoint
// 422s on team_totals, same as F5/H1). The background supplementTeamTotals
// ran during the odds refresh under heavy concurrency using a plain, un-timed
// fetch(); in prod it silently attached nothing (verified 2026-07-12: 15/15
// MLB games missing team_totals in cache while TOA carried full data for all
// of them on pinnacle/dk/fd). Result: PX team-total RFQs declined "no fair
// value" and we effectively never quoted them.
//
// ensureTeamTotals is the single reliable path both the refresh supplement AND
// the line-manager seed loop call. It is timeout-bounded (abortableFetch,
// can't hang), single-flighted (a burst of concurrent callers for one game
// shares one fetch), and TTL-cached (a fresh cached consensus is re-attached
// to the — possibly just-rebuilt — cache event objects without re-fetching,
// which closes the gap between the ~3-min odds refresh rebuilding the cache
// and the seed cadence). Fail-open: a miss leaves the game without team_totals
// for this cycle (no worse than today). Fail-closed on started/unknown-start
// games (we don't quote team totals live).
// ---------------------------------------------------------------------------
// Football joined 2026-08-21: PX posts BOTH team totals on every NFL event
// (27 markets across one not-started slate) and TOA serves team_totals +
// alternate_team_totals for preseason. Until football was in this set the
// per-event fetch never ran, so oddsEvt.markets.team_totals stayed empty and
// the T1.8 football fail-closed guard in line-manager correctly refused to
// register the lines. Adding it here is what lets that guard pass honestly.
const TEAM_TOTAL_SPORTS = new Set([
  'baseball_mlb', 'basketball_nba', 'icehockey_nhl',
  'americanfootball_nfl', 'americanfootball_nfl_preseason', 'americanfootball_ncaaf',
]);
const TEAM_TOTAL_BOOKMAKERS = process.env.TEAM_TOTAL_BOOKMAKERS || 'pinnacle,draftkings,fanduel,betmgm';
const TEAM_TOTAL_TTL_MS = (parseInt(process.env.TEAM_TOTAL_TTL_SECONDS) || 240) * 1000;
const _teamTotalCache = {};    // key -> { at, tt|null, toaHome, toaAway }
const _teamTotalInflight = {}; // key -> Promise

// ---------------------------------------------------------------------------
// BTTS (Both Teams To Score) — soccer.
//
// SAME endpoint gotcha as team_totals / F5 / H1: the BULK /odds endpoint
// rejects it outright ("Markets not supported by this endpoint: btts",
// INVALID_MARKET, probed 2026-07-16). btts lives ONLY on the per-event
// endpoint. This is why the btts parser in fetchFromTheOddsApi — which scans
// the bulk response for `m.key === 'btts'` — has never once matched: it is
// dead code on a payload that cannot contain the market.
//
// Coverage probe 2026-07-16 (Toronto FC @ CF Montréal, regions=us,eu): 8
// two-sided books — fanduel, draftkings, betmgm, betrivers, williamhill,
// pinnacle, onexbet, matchbook. Pinnacle and matchbook are eu-region, so
// dropping to regions=us would lose the sharpest book here; keep us,eu.
// Quota is a non-issue: 1 credit per region per event against 15.6M
// remaining, and the TTL below collapses the 2-min refresh cadence.
//
// Unlike team_totals, BTTS is ORIENTATION-FREE: Yes/No means the same thing
// regardless of which side the cache stored as home, so the attach can't
// mis-assign a side the way a home/away team total could.
// ---------------------------------------------------------------------------
// Deliberately MLS-only by default, NOT every soccer key. btts is per-event,
// so each extra league multiplies calls against the SAME TOA key the main
// bulk odds path uses — and that key enforces a request-FREQUENCY limit
// distinct from quota (429 EXCEEDED_FREQ_LIMIT, hit while probing this on
// 2026-07-16). A 429 storm would degrade the markets we already quote, so
// widen this one league at a time via BTTS_SPORTS after watching the
// `btts supplement:` attach ratio hold up.
const BTTS_SPORTS = new Set(
  (process.env.BTTS_SPORTS || 'soccer_usa_mls')
    .split(',').map(s => s.trim()).filter(Boolean)
);
// PER-SPORT bookmaker override. Some competitions are only quoted by books
// outside the default sharp-ish list, and pulling those books into the GLOBAL
// list would drag them into the MLS/EPL consensuses too -- degrading markets
// that price well in order to add a competition that prices badly.
//
// Measured 2026-08-22 on UEFA Champions League qualification: PX posts BTTS on
// 6 of 7 ties, but TOA carries it only from sportsbet / onexbet / virginbet /
// livescorebet -- no Pinnacle, DK, FD or Matchbook. Overrounds run 7.1-8.8%,
// i.e. above the >6% "different class" threshold the 2-way consensus filter
// uses, so this is a knowingly softer basis confined to one competition.
// Format: {"soccer_uefa_champs_league":"sportsbet,onexbet"}
const BTTS_BOOKMAKERS_BY_SPORT = (() => {
  const out = {};
  try {
    const raw = JSON.parse(process.env.BTTS_BOOKMAKERS_BY_SPORT || '{}');
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
  } catch (err) {
    log.warn('OddsFeed', `BTTS_BOOKMAKERS_BY_SPORT is not valid JSON — ignoring: ${err.message}`);
  }
  return out;
})();
function _bttsBooksFor(sport) {
  return BTTS_BOOKMAKERS_BY_SPORT[sport] || BTTS_BOOKMAKERS;
}
const BTTS_BOOKMAKERS = process.env.BTTS_BOOKMAKERS
  || 'pinnacle,draftkings,fanduel,betmgm,betrivers,williamhill,matchbook';
const BTTS_TTL_MS = (parseInt(process.env.BTTS_TTL_SECONDS) || 240) * 1000;
const BTTS_MIN_BOOKS = parseInt(process.env.BTTS_MIN_BOOKS) || 2;
// Gap between per-event calls in the supplement fan-out. The TOA key enforces
// a request-FREQUENCY limit; an unpaced burst of ~21 events returned 429s for
// roughly a third of the slate on the first probe. Those 429s are invisible
// unless you look — they present as "this game has no BTTS", not as an error.
// 250ms × ~21 MLS games ≈ 5s per cycle — free on a 2-min background refresh,
// and cheap insurance against the freq limit. Any game still missed rides the
// _scheduleSupplementRetry chain (60/120/240s); transient failures are NOT
// cached as misses, so those retries actually refill the gap.
const BTTS_FETCH_SPACING_MS = parseInt(process.env.BTTS_FETCH_SPACING_MS) || 250;
const _bttsCache = {};    // key -> { at, btts|null, toaHome, toaAway }
const _bttsInflight = {}; // key -> Promise
const _bttsStats = { transientFails: 0, attached: 0, candidates: 0, lastRunAt: null };

function _attachBttsToCache(sport, toaHome, toaAway, btts) {
  const cache = oddsCache[sport];
  if (!cache || !cache.events || !btts) return 0;
  let attached = 0;
  const keys = new Set([normalizeEventKey(toaHome, toaAway), normalizeEventKey(toaAway, toaHome)]);
  for (const key of keys) {
    const entry = cache.events[key];
    if (!entry) continue;
    for (const ev of (Array.isArray(entry) ? entry : [entry])) {
      if (!ev || !ev.markets) continue;
      // Orientation-free (see header) — no home/away remap needed.
      ev.markets.btts = btts;
      attached++;
    }
  }
  return attached;
}

/**
 * Fetch + de-vig BTTS for one game and attach it to the odds cache.
 * Mirrors ensureTeamTotals: timeout-bounded, single-flighted, TTL-cached,
 * fail-closed on started/unknown-start games.
 */
async function ensureBtts(sport, homeTeam, awayTeam, commenceTime) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey || !BTTS_SPORTS.has(sport)) return null;
  const startMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null; // fail-closed on started/unknown

  const key = `${sport}|${normalizeEventKey(homeTeam, awayTeam)}`;
  const now = Date.now();
  const cached = _bttsCache[key];
  if (cached && (now - cached.at) < BTTS_TTL_MS) {
    // Re-attach: the odds cache may have been rebuilt since we fetched.
    if (cached.btts) _attachBttsToCache(sport, cached.toaHome, cached.toaAway, cached.btts);
    return cached.btts;
  }
  if (_bttsInflight[key]) return _bttsInflight[key];

  _bttsInflight[key] = (async () => {
    try {
      const resolved = await resolveOddsApiEventId(sport, homeTeam, awayTeam, commenceTime);
      if (!resolved || !resolved.eventId) { _bttsCache[key] = { at: now, btts: null }; return null; }

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${resolved.eventId}/odds`
        + `?apiKey=${theOddsApiKey}`
        + `&regions=us,eu`
        + `&markets=btts`
        + `&bookmakers=${_bttsBooksFor(sport)}`
        + `&oddsFormat=american`;

      let data;
      try {
        const resp = await abortableFetch(url);
        if (!resp.ok) {
          // A 429 (EXCEEDED_FREQ_LIMIT — this key rate-limits by request
          // frequency, not just quota) or a 5xx is TRANSIENT. Caching it as a
          // miss would blind the game for a full TTL and, worse, read as
          // "books don't post BTTS for this game" — which is exactly how a
          // fetch failure masquerades as a coverage gap. Leave it uncached so
          // the next cycle retries; only a genuine 4xx answer is cached.
          if (resp.status === 429 || resp.status >= 500) {
            _bttsStats.transientFails++;
            return null;
          }
          _bttsCache[key] = { at: now, btts: null };
          return null;
        }
        data = await safeJsonFetch(resp);
      } catch (err) {
        // Transient (timeout / network): do NOT cache the miss — retry next call.
        if (err && err.name === 'AbortError') {
          toaStaleServeStats.fetchTimeouts++;
          toaStaleServeStats.lastFetchTimeoutAt = new Date().toISOString();
        }
        _bttsStats.transientFails++;
        return null;
      }
      if (!data) return null;

      // One de-vigged pair per two-sided book, then average the fairs —
      // same shape the (unreachable) bulk parser built, so the pricer's
      // existing markets.btts lookup reads this unchanged.
      const fairYes = [], fairNo = [];
      const rawYes = [], rawNo = [];
      const books = [];
      for (const book of (data.bookmakers || [])) {
        const m = (book.markets || []).find(x => x.key === 'btts');
        if (!m) continue;
        const yes = (m.outcomes || []).find(o => /^yes$/i.test(o.name || ''));
        const no  = (m.outcomes || []).find(o => /^no$/i.test(o.name || ''));
        if (!yes || !no) continue; // one-sided book can't be de-vigged — skip
        const pY = americanToImpliedProb(yes.price);
        const pN = americanToImpliedProb(no.price);
        if (!(pY > 0) || !(pN > 0)) continue;
        const [fy, fn] = deVig2Way(pY, pN);
        if (!(fy > 0) || !(fn > 0)) continue;
        fairYes.push(fy); fairNo.push(fn);
        rawYes.push(yes.price); rawNo.push(no.price);
        books.push(book.key);
      }
      // DEDUPE IDENTICAL PRICE PAIRS before counting. Retail skins share one
      // trading desk and post byte-identical prices (measured: virginbet and
      // livescorebet both -185/+128 on Celtic @ LASK). Counting them twice
      // makes BTTS_MIN_BOOKS fiction -- two 'books' can be one opinion -- and
      // double-weights that opinion in the average. Keep the first occurrence
      // of each distinct (yes,no) pair.
      const _seenPair = new Set();
      const keepIdx = [];
      for (let i = 0; i < books.length; i++) {
        const sig = `${rawYes[i]}|${rawNo[i]}`;
        if (_seenPair.has(sig)) continue;
        _seenPair.add(sig);
        keepIdx.push(i);
      }
      if (keepIdx.length < books.length) {
        const dropped = books.filter((_, i) => !keepIdx.includes(i));
        log.debug('OddsFeed', `btts ${sport}: dropped ${dropped.length} duplicate-price book(s) [${dropped.join(',')}]`);
      }
      const _fy = keepIdx.map(i => fairYes[i]);
      const _fn = keepIdx.map(i => fairNo[i]);
      const _ry = keepIdx.map(i => rawYes[i]);
      const _rn = keepIdx.map(i => rawNo[i]);
      const _bk = keepIdx.map(i => books[i]);
      fairYes.length = 0; fairYes.push(..._fy);
      fairNo.length = 0;  fairNo.push(..._fn);
      rawYes.length = 0;  rawYes.push(..._ry);
      rawNo.length = 0;   rawNo.push(..._rn);
      books.length = 0;   books.push(..._bk);

      // Thin boards are noise — fail closed rather than quote off one book.
      if (books.length < BTTS_MIN_BOOKS) { _bttsCache[key] = { at: now, btts: null }; return null; }

      const dvYes = avg(fairYes), dvNo = avg(fairNo);
      if (!(dvYes > 0) || !(dvNo > 0)) { _bttsCache[key] = { at: now, btts: null }; return null; }
      const btts = {
        yes: { rawOdds: rawYes[0], impliedProb: americanToImpliedProb(rawYes[0]), fairProb: dvYes, displayFairProb: dvYes },
        no:  { rawOdds: rawNo[0],  impliedProb: americanToImpliedProb(rawNo[0]),  fairProb: dvNo,  displayFairProb: dvNo },
        books: books.length,
      };

      _bttsCache[key] = { at: now, btts, toaHome: data.home_team, toaAway: data.away_team };
      _attachBttsToCache(sport, data.home_team, data.away_team, btts);
      return btts;
    } finally {
      delete _bttsInflight[key];
    }
  })();
  return _bttsInflight[key];
}

/**
 * Refresh-cycle gap-fill for BTTS, mirroring supplementTeamTotals.
 */
async function supplementBtts(parsedEvents, sport) {
  if (!process.env.THE_ODDS_API_KEY || !BTTS_SPORTS.has(sport)) return;
  const candidates = [];
  for (const entry of Object.values(parsedEvents)) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (ev.markets && ev.markets.btts) continue; // still-fresh TTL re-attach
      candidates.push(ev);
    }
  }
  if (candidates.length === 0) return;

  // Warm the shared per-sport TOA events-list cache with ONE call before
  // fanning out. Without this the first N workers all miss the empty cache and
  // fire identical events-list requests simultaneously — a self-inflicted
  // thundering herd that 429s itself (observed 2026-07-16).
  const first = candidates[0];
  try {
    await resolveOddsApiEventId(sport, first.homeTeam, first.awayTeam, first.commenceTime);
  } catch (_) { /* non-fatal: workers will retry through their own path */ }

  const before = _bttsStats.transientFails;
  let attached = 0;
  // Serial + spaced, NOT concurrent. This runs on the background refresh
  // cycle, never the RFQ hot path, so latency here is free — whereas a 429
  // silently costs a whole game's BTTS coverage.
  for (const ev of candidates) {
    const b = await ensureBtts(sport, ev.homeTeam, ev.awayTeam, ev.commenceTime);
    if (b) attached++;
    if (BTTS_FETCH_SPACING_MS > 0) await new Promise(r => setTimeout(r, BTTS_FETCH_SPACING_MS));
  }
  const transient = _bttsStats.transientFails - before;
  _bttsStats.attached = attached;
  _bttsStats.candidates = candidates.length;
  _bttsStats.lastRunAt = new Date().toISOString();
  // Surface transient failures explicitly: a low attach ratio with transient>0
  // is a rate-limit problem (retry/pace), NOT missing book coverage.
  log.info('OddsFeed', `${sport} btts supplement: ${attached}/${candidates.length} attached`
    + (transient ? ` (${transient} transient fetch failures — rate limit, not coverage)` : ''));
}

// Attach a team-total consensus (keyed to TOA's home/away) onto every cached
// event object for this matchup, in that event's OWN orientation so getFairProb
// reads market[side] correctly (getEventMarkets handles caller-orientation
// flipping on reverse-bucket reads). Returns how many event objects it touched.
function _attachTeamTotalsToCache(sport, toaHome, toaAway, tt) {
  const cache = oddsCache[sport];
  if (!cache || !cache.events || !tt) return 0;
  const nH = normalizeTeamName(toaHome), nA = normalizeTeamName(toaAway);
  let attached = 0;
  const keys = new Set([normalizeEventKey(toaHome, toaAway), normalizeEventKey(toaAway, toaHome)]);
  for (const key of keys) {
    const entry = cache.events[key];
    if (!entry) continue;
    for (const ev of (Array.isArray(entry) ? entry : [entry])) {
      if (!ev || !ev.markets) continue;
      const evH = normalizeTeamName(ev.homeTeam);
      let home, away;
      if (evH === nH) { home = tt.home; away = tt.away; }        // same orientation
      else if (evH === nA) { home = tt.away; away = tt.home; }   // event stored reversed vs TOA
      else continue;                                            // name mismatch — don't guess
      const block = { books: tt.books || 1 };
      if (home) block.home = home;
      if (away) block.away = away;
      if (block.home || block.away) { ev.markets.team_totals = block; attached++; }
    }
  }
  return attached;
}

async function ensureTeamTotals(sport, homeTeam, awayTeam, commenceTime) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey || !TEAM_TOTAL_SPORTS.has(sport)) return null;
  const startMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null; // fail-closed on started/unknown

  const key = `${sport}|${normalizeEventKey(homeTeam, awayTeam)}`;
  const now = Date.now();
  const cached = _teamTotalCache[key];
  if (cached && (now - cached.at) < TEAM_TOTAL_TTL_MS) {
    // Re-attach: the odds cache may have been rebuilt since we fetched, which
    // would have dropped the consensus. Cheap, no network.
    if (cached.tt) _attachTeamTotalsToCache(sport, cached.toaHome, cached.toaAway, cached.tt);
    return cached.tt;
  }
  if (_teamTotalInflight[key]) return _teamTotalInflight[key];

  _teamTotalInflight[key] = (async () => {
    try {
      const resolved = await resolveOddsApiEventId(sport, homeTeam, awayTeam, commenceTime);
      if (!resolved || !resolved.eventId) { _teamTotalCache[key] = { at: now, tt: null }; return null; }

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${resolved.eventId}/odds`
        + `?apiKey=${theOddsApiKey}`
        + `&regions=us,eu`
        + `&markets=team_totals,alternate_team_totals`
        + `&bookmakers=${TEAM_TOTAL_BOOKMAKERS}`
        + `&oddsFormat=american`;

      let data;
      try {
        const resp = await abortableFetch(url);
        if (!resp.ok) { _teamTotalCache[key] = { at: now, tt: null }; return null; }
        data = await safeJsonFetch(resp);
      } catch (err) {
        // Transient (timeout / network): do NOT cache the miss — retry next call.
        if (err && err.name === 'AbortError') {
          toaStaleServeStats.fetchTimeouts++;
          toaStaleServeStats.lastFetchTimeoutAt = new Date().toISOString();
        }
        return null;
      }
      if (!data) return null;

      // Build bookPairs — one per (book × teamSide × line) with {over,under}
      // at the SAME line. Mirrors getBookPairsForTeamTotals' line-keyed pairing.
      const bookPairs = [];
      for (const book of (data.bookmakers || [])) {
        for (const m of (book.markets || [])) {
          if (m.key !== 'team_totals' && m.key !== 'alternate_team_totals') continue;
          const byTeamLine = {};
          for (const o of (m.outcomes || [])) {
            const team = o.description;
            if (!team || o.point == null) continue;
            const tlKey = team + '|' + o.point;
            if (!byTeamLine[tlKey]) byTeamLine[tlKey] = { team, line: o.point };
            const leg = { odds_probability: americanToImpliedProb(o.price), odds_american: o.price, line: o.point };
            if (o.name === 'Over') byTeamLine[tlKey].over = leg;
            else if (o.name === 'Under') byTeamLine[tlKey].under = leg;
          }
          for (const entry of Object.values(byTeamLine)) {
            if (!entry.over || !entry.under) continue;
            let teamSide = null;
            if (entry.team === data.home_team) teamSide = 'home';
            else if (entry.team === data.away_team) teamSide = 'away';
            else continue;
            bookPairs.push({ book: book.key, teamSide, over: entry.over, under: entry.under });
          }
        }
      }
      if (bookPairs.length === 0) { _teamTotalCache[key] = { at: now, tt: null }; return null; }

      const tt = buildConsensusTeamTotals(bookPairs);
      if (!tt || (!tt.home && !tt.away)) { _teamTotalCache[key] = { at: now, tt: null }; return null; }
      tt.books = new Set(bookPairs.map(b => b.book)).size;

      _teamTotalCache[key] = { at: now, tt, toaHome: data.home_team, toaAway: data.away_team };
      _attachTeamTotalsToCache(sport, data.home_team, data.away_team, tt);
      return tt;
    } finally {
      delete _teamTotalInflight[key];
    }
  })();
  return _teamTotalInflight[key];
}

/**
 * Fetch 1st-Half markets from The Odds API and attach them to the
 * existing event cache as: h2h_h1, spreads_h1, totals_h1. Sports gated
 * by H1_SUPPLEMENT_SPORTS (NBA + football); `sport` defaults to
 * basketball_nba so any stale caller keeps the original behavior.
 *
 * IMPORTANT: Same endpoint gotcha as F5 and team_totals — the bulk
 * /odds endpoint returns 422 INVALID_MARKET for h2h_h1/spreads_h1/
 * totals_h1. Verified via probe 2026-04-22:
 *   "Markets not supported by this endpoint: h2h_h1, spreads_h1, totals_h1"
 * This is why the previous bulk-endpoint implementation produced zero
 * 1H data for months. H1 markets live on the per-event endpoint.
 */
async function supplementH1Markets(parsedEvents, sport = 'basketball_nba') {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return;
  const label = _h1Label(sport);

  // Collect candidates — skip events already populated with H1 data.
  const candidates = [];
  for (const entry of Object.values(parsedEvents)) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const _needQ1 = Q1_SUPPLEMENT_SPORTS.has(sport)
        && !(ev.markets && ev.markets.h2h_q1 && ev.markets.spreads_q1 && ev.markets.totals_q1);
      if (ev.markets && ev.markets.h2h_h1 && ev.markets.spreads_h1 && ev.markets.totals_h1 && !_needQ1) continue;
      candidates.push(ev);
    }
  }
  if (candidates.length === 0) {
    log.info('OddsFeed', `${label} supplement: no candidates`);
    return;
  }

  let calls = 0, matchFails = 0, apiFails = 0;
  let h2hCount = 0, spreadCount = 0, totalCount = 0;
  const CONCURRENCY = 3;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const ev = candidates[idx++];
      const resolved = await resolveOddsApiEventId(sport, ev.homeTeam, ev.awayTeam, ev.commenceTime);
      if (!resolved) { matchFails++; continue; }

      const url = `https://api.the-odds-api.com/v4/sports/${resolved.oddsApiSport || sport}/events/${resolved.eventId}/odds`
        + `?apiKey=${theOddsApiKey}`
        + `&regions=us,eu`
        + `&markets=h2h_h1,spreads_h1,totals_h1${Q1_SUPPLEMENT_SPORTS.has(sport) ? ',h2h_q1,spreads_q1,totals_q1' : ''}`
        + `&bookmakers=pinnacle,draftkings,fanduel`
        + `&oddsFormat=american`;

      try {
        const resp = await fetch(url);
        calls++;
        if (!resp.ok) { apiFails++; continue; }
        const data = await resp.json();

        const mlPairs = [], spreadPairs = [], totalPairs = [];
        const q1MlPairs = [], q1SpreadPairs = [], q1TotalPairs = [];
        for (const book of (data.bookmakers || [])) {
          for (const m of (book.markets || [])) {
            if (m.key === 'h2h_q1' || m.key === 'spreads_q1' || m.key === 'totals_q1') {
              // 1st quarter — identical pair shapes to H1, kept in their own
              // accumulators so a Q1 price can never be folded into an H1
              // consensus (they are different markets with similar numbers).
              if (m.key === 'h2h_q1') {
                const home = m.outcomes?.find(o => o.name === data.home_team);
                const away = m.outcomes?.find(o => o.name === data.away_team);
                if (home && away) q1MlPairs.push({ book: book.key,
                  home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price },
                  away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price } });
              } else if (m.key === 'spreads_q1') {
                const home = m.outcomes?.find(o => o.name === data.home_team);
                const away = m.outcomes?.find(o => o.name === data.away_team);
                if (home && away) q1SpreadPairs.push({ book: book.key,
                  home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price, point: home.point, line: home.point },
                  away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price, point: away.point, line: away.point } });
              } else {
                const over = m.outcomes?.find(o => o.name === 'Over');
                const under = m.outcomes?.find(o => o.name === 'Under');
                if (over && under) q1TotalPairs.push({ book: book.key,
                  over: { odds_probability: americanToImpliedProb(over.price), odds_american: over.price, point: over.point, line: over.point },
                  under: { odds_probability: americanToImpliedProb(under.price), odds_american: under.price, point: under.point, line: under.point } });
              }
            } else if (m.key === 'h2h_h1') {
              const home = m.outcomes?.find(o => o.name === data.home_team);
              const away = m.outcomes?.find(o => o.name === data.away_team);
              if (home && away) {
                mlPairs.push({
                  book: book.key,
                  home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price },
                  away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price },
                });
              }
            } else if (m.key === 'spreads_h1') {
              const home = m.outcomes?.find(o => o.name === data.home_team);
              const away = m.outcomes?.find(o => o.name === data.away_team);
              if (home && away) {
                spreadPairs.push({
                  book: book.key,
                  home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price, point: home.point, line: home.point },
                  away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price, point: away.point, line: away.point },
                });
              }
            } else if (m.key === 'totals_h1') {
              const over = m.outcomes?.find(o => o.name === 'Over');
              const under = m.outcomes?.find(o => o.name === 'Under');
              if (over && under) {
                totalPairs.push({
                  book: book.key,
                  over: { odds_probability: americanToImpliedProb(over.price), odds_american: over.price, point: over.point, line: over.point },
                  under: { odds_probability: americanToImpliedProb(under.price), odds_american: under.price, point: under.point, line: under.point },
                });
              }
            }
          }
        }

        if (mlPairs.length > 0) {
          const mk = buildConsensusMoneyline(mlPairs);
          if (mk) { ev.markets.h2h_h1 = _mergeSupplementedMarket(ev.markets.h2h_h1, mk); h2hCount++; }
        }
        if (spreadPairs.length > 0) {
          const sp = buildConsensusSpread(spreadPairs);
          if (sp) { ev.markets.spreads_h1 = _mergeSupplementedMarket(ev.markets.spreads_h1, sp); spreadCount++; }
        }
        if (q1MlPairs.length > 0) {
          const mk = buildConsensusMoneyline(q1MlPairs);
          if (mk) ev.markets.h2h_q1 = _mergeSupplementedMarket(ev.markets.h2h_q1, mk);
        }
        if (q1SpreadPairs.length > 0) {
          const sp = buildConsensusSpread(q1SpreadPairs);
          if (sp) ev.markets.spreads_q1 = _mergeSupplementedMarket(ev.markets.spreads_q1, sp);
        }
        if (q1TotalPairs.length > 0) {
          ev.markets.totals_q1 = _mergeSupplementedMarket(ev.markets.totals_q1, buildConsensusTotals(q1TotalPairs));
        }
        if (totalPairs.length > 0) {
          ev.markets.totals_h1 = _mergeSupplementedMarket(ev.markets.totals_h1, buildConsensusTotals(totalPairs));
          totalCount++;
        }
      } catch (err) {
        apiFails++;
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, candidates.length); i++) workers.push(worker());
  await Promise.all(workers);
  log.info('OddsFeed', `${label} supplement (per-event): ${calls}/${candidates.length} calls, h2h+${h2hCount} spread+${spreadCount} total+${totalCount}, matchFails=${matchFails} apiFails=${apiFails}`);
}

/**
 * Fetch team_totals markets from The Odds API and attach them to the
 * existing event cache as `markets.team_totals`. Used as a gap-fill for
 * SharpAPI's Hobby plan which does not currently return team_total data
 * for NBA/MLB/NHL despite those being requested. Called per-sport on the
 * primary refresh cycle so the data is pre-warmed in the cache; RFQ
 * pricing paths pay zero incremental latency vs. full-game totals.
 *
 * The Odds API team_totals payload shape (per outcome):
 *   { name: 'Over'|'Under', description: '<Team Name>', price: <american>, point: <line> }
 * We group outcomes by description (team) into over/under pairs, then
 * emit one bookPair per (book, teamSide) for buildConsensusTeamTotals.
 */
async function supplementTeamTotals(parsedEvents, sport) {
  if (!process.env.THE_ODDS_API_KEY || !TEAM_TOTAL_SPORTS.has(sport)) return;

  // Delegate to ensureTeamTotals (the single reliable path — abortableFetch,
  // single-flight, TTL cache, cache-attach). This replaces the former plain-
  // fetch() loop that silently attached nothing under prod load. Skip events
  // that already carry team_totals (e.g. a still-fresh TTL re-attach).
  const candidates = [];
  for (const entry of Object.values(parsedEvents)) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (ev.markets && ev.markets.team_totals) continue;
      candidates.push(ev);
    }
  }
  if (candidates.length === 0) return;

  let attached = 0;
  const CONCURRENCY = 3;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const ev = candidates[idx++];
      // ensureTeamTotals attaches onto oddsCache[sport] events by matchup
      // lookup; during the refresh oddsCache[sport].events IS `parsedEvents`
      // (same reference), so these candidate objects get populated directly.
      const tt = await ensureTeamTotals(sport, ev.homeTeam, ev.awayTeam, ev.commenceTime);
      if (tt) attached++;
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, candidates.length); i++) workers.push(worker());
  await Promise.all(workers);
  log.info('OddsFeed', `${sport} team_totals supplement: ${attached}/${candidates.length} attached (via ensureTeamTotals)`);
}

// ---------------------------------------------------------------------------
// PINNACLE SUPPLEMENT — fetch Pinnacle odds from The Odds API and convert
// to SharpAPI-format rows so they merge into the multi-book de-vig
// ---------------------------------------------------------------------------

// Maps our sport keys to The Odds API sport keys for Pinnacle supplement
const PINNACLE_SPORT_MAP = {
  'basketball_nba': 'basketball_nba',
  'baseball_mlb': 'baseball_mlb',
  'icehockey_nhl': 'icehockey_nhl',
  // Soccer leagues — The Odds API uses per-league sport keys that match our
  // internal ones 1:1. Adds Pinnacle + DK + FD as supplement books on top of
  // SharpAPI's DK/FD-only coverage. Pinnacle is widely considered the sharpest
  // book for soccer, so including it meaningfully tightens fair-prob estimates.
  // If a league has no active Pinnacle coverage for a given cycle, fetchPinnacleRows
  // returns [] and the merge is a no-op — safe to add speculatively.
  'soccer_epl': 'soccer_epl',
  'soccer_spain_la_liga': 'soccer_spain_la_liga',
  'soccer_italy_serie_a': 'soccer_italy_serie_a',
  'soccer_germany_bundesliga': 'soccer_germany_bundesliga',
  'soccer_france_ligue_one': 'soccer_france_ligue_one',
  'soccer_uefa_champs_league': 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league': 'soccer_uefa_europa_league',
  'soccer_usa_mls': 'soccer_usa_mls',
  'soccer_usa_nwsl': 'soccer_usa_nwsl',
  'soccer_mexico_ligamx': 'soccer_mexico_ligamx',
  'soccer_brazil_campeonato': 'soccer_brazil_campeonato',
  'soccer_conmebol_libertadores': 'soccer_conmebol_libertadores',
  // MMA — Pinnacle posts UFC/major MMA events, adds a sharper reference to
  // the existing SharpAPI-only coverage plus the DK scraper total_rounds market.
  'mma_mixed_martial_arts': 'mma_mixed_martial_arts',
  // Tennis intentionally omitted: The Odds API uses per-tournament sport keys
  // (tennis_atp_french_open, tennis_atp_us_open, etc.) rather than a generic
  // "tennis" key, so a 1:1 map doesn't work without tournament-aware routing.
};

// Market key mapping: The Odds API market → SharpAPI market_type (per sport)
function oddsApiToSharpMarket(marketKey, sport) {
  if (marketKey === 'h2h') return 'moneyline';
  if (marketKey === 'spreads') {
    if (sport === 'baseball_mlb') return 'run_line';
    if (sport === 'icehockey_nhl') return 'puck_line';
    return 'point_spread';
  }
  if (marketKey === 'totals') {
    if (sport === 'baseball_mlb') return 'total_runs';
    if (sport === 'icehockey_nhl') return 'total_goals';
    return 'total_points';
  }
  return null;
}

/**
 * Fetch Pinnacle + FanDuel odds from The Odds API and convert to SharpAPI-format rows.
 * Supplements SharpAPI data to ensure Pinnacle and FanDuel coverage for display.
 * Returns array of rows compatible with SharpAPI's format, or empty array on failure.
 */
async function fetchPinnacleRows(sport) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  const oddsApiSport = PINNACLE_SPORT_MAP[sport];
  if (!theOddsApiKey || !oddsApiSport) return [];

  // Fetch Pinnacle + DraftKings + FanDuel from The Odds API — these supplement
  // SharpAPI's (often incomplete) coverage so we have guaranteed book data for
  // all games regardless of SharpAPI's 50-row cap.
  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds`
    + `?apiKey=${theOddsApiKey}`
    + `&regions=us,eu`
    + `&markets=h2h,spreads,totals`
    + `&bookmakers=pinnacle,draftkings,fanduel`
    + `&oddsFormat=american`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn('OddsFeed', `Odds API supplement fetch failed (${resp.status}) for ${sport}`);
      return [];
    }

    const remaining = resp.headers.get('x-requests-remaining');
    _checkToaQuota(remaining);
    const used = resp.headers.get('x-requests-used');
    if (remaining != null) {
      log.info('OddsFeed', `The Odds API usage (supplement): ${used} used, ${remaining} remaining`);
    }

    const events = await safeJsonFetch(resp);
    const rows = [];

    for (const event of events) {
      // Process ALL bookmakers, not just Pinnacle
      for (const book of (event.bookmakers || [])) {
        const bookKey = book.key; // 'pinnacle', 'draftkings', 'fanduel'
        for (const market of (book.markets || [])) {
          const marketType = oddsApiToSharpMarket(market.key, sport);
          if (!marketType) continue;

          for (const outcome of (market.outcomes || [])) {
            const isHome = outcome.name === event.home_team;
            const isAway = outcome.name === event.away_team;
            const isOver = outcome.name === 'Over';
            const isUnder = outcome.name === 'Under';

            let selectionType;
            if (market.key === 'totals') {
              selectionType = isOver ? 'over' : isUnder ? 'under' : null;
            } else {
              selectionType = isHome ? 'home' : isAway ? 'away' : null;
            }
            if (!selectionType) continue;

            rows.push({
              event_id: event.id,
              home_team: event.home_team,
              away_team: event.away_team,
              event_start_time: event.commence_time,
              sportsbook: bookKey,
              market_type: marketType,
              selection_type: selectionType,
              odds_american: outcome.price,
              odds_probability: americanToImpliedProb(outcome.price),
              line: outcome.point != null ? outcome.point : null,
            });
          }
        }
      }
    }

    // Count rows per book for logging
    const byBook = {};
    for (const r of rows) byBook[r.sportsbook] = (byBook[r.sportsbook] || 0) + 1;
    log.info('OddsFeed', `Odds API supplement: ${rows.length} rows for ${sport} (${events.length} events) — ${JSON.stringify(byBook)}`);
    return rows;
  } catch (err) {
    log.warn('OddsFeed', `Odds API supplement fetch error for ${sport}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// THE ODDS API FALLBACK (for sports SharpAPI free tier doesn't cover)
// ---------------------------------------------------------------------------

/**
 * Fetch odds for dynamic sports (e.g., tennis) where tournament keys change.
 * Discovers active tournaments from The Odds API, fetches odds for each,
 * and merges all events into the cache under the generic sport key.
 */
async function fetchDynamicSports(sport, fallback, apiKey) {
  // Step 1: discover active tournaments matching the prefix
  const sportsResp = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
  if (!sportsResp.ok) throw new Error(`The Odds API sports list: ${sportsResp.status}`);
  const allSports = await safeJsonFetch(sportsResp);
  let activeTournaments = allSports.filter(s => s.key.startsWith(fallback.sportPrefix) && s.active);
  // Optional curation (generic soccer): only fetch allowlisted keys —
  // uncurated soccer_* can be ~50 keys in club season, a quota footgun.
  // Keys with their own dedicated ODDS_API_FALLBACK entry are excluded
  // regardless, to avoid double-fetching into two cache slots.
  if (typeof fallback.keyAllowlist === 'function') {
    const allow = fallback.keyAllowlist();
    activeTournaments = activeTournaments.filter(s => allow.has(s.key));
    // Keys with their own dedicated (non-gated) ODDS_API_FALLBACK entry are
    // already fetched into their own cache slot — exclude them here so an
    // over-broad allowlist can't double-fetch.
    activeTournaments = activeTournaments.filter(s => !(ODDS_API_FALLBACK[s.key] && !ODDS_API_FALLBACK[s.key].flipGated));
  }

  if (activeTournaments.length === 0) {
    log.warn('OddsFeed', `No active ${sport} tournaments found on The Odds API`);
    return {};
  }
  log.info('OddsFeed', `Found ${activeTournaments.length} active ${sport} tournaments: ${activeTournaments.map(t => t.key).join(', ')}`);

  // Step 2: fetch odds for each active tournament. Track each event's
  // sourceTournament so we can debug "which tournament was this event
  // from?" later — invaluable when an event registers under one cache key
  // but the resolve path tries another. Also enables per-tournament
  // cache slots (oddsCache['tennis_atp_french_open']) that the line-
  // manager can fall back to when the generic sport-level lookup fails.
  const allEvents = [];
  const eventsByTournament = new Map(); // tourKey -> [event, ...]
  for (const tournament of activeTournaments) {
    const url = `https://api.the-odds-api.com/v4/sports/${tournament.key}/odds`
      + `?apiKey=${apiKey}`
      + `&regions=us,eu`
      + `&markets=${fallback.markets}`
      + `&bookmakers=${fallback.bookmakers}`
      + `&oddsFormat=american`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn('OddsFeed', `The Odds API ${resp.status} for ${tournament.key}`);
        continue;
      }
      const remaining = resp.headers.get('x-requests-remaining');
    _checkToaQuota(remaining);
      if (remaining != null) log.debug('OddsFeed', `The Odds API: ${remaining} requests remaining`);
      const events = await safeJsonFetch(resp);
      // Tag each event with its source tournament for traceability.
      for (const ev of events) ev._sourceTournament = tournament.key;
      allEvents.push(...events);
      eventsByTournament.set(tournament.key, events);
      log.info('OddsFeed', `Got ${events.length} events from ${tournament.key}`);
    } catch (err) {
      log.warn('OddsFeed', `Failed to fetch ${tournament.key}: ${err.message}`);
    }
  }

  log.info('OddsFeed', `Total ${sport} events across all tournaments: ${allEvents.length}`);

  // Step 3: parse into cache format (same as regular fetchFromTheOddsApi)
  const parsed = {};
  const parsedByTournament = new Map(); // tourKey -> { key: entry }
  for (const event of allEvents) {
    const key = normalizeEventKey(event.home_team, event.away_team);
    const allBooks = event.bookmakers || [];
    if (allBooks.length === 0) continue;

    const markets = {};

    // Moneyline (h2h)
    const mlPairs = [];
    for (const book of allBooks) {
      const mlMarket = book.markets?.find(m => m.key === 'h2h');
      if (!mlMarket) continue;
      const home = mlMarket.outcomes?.find(o => o.name === event.home_team);
      const away = mlMarket.outcomes?.find(o => o.name === event.away_team);
      if (home && away) {
        mlPairs.push({
          book: book.key,
          home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price },
          away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price },
        });
      }
    }
    if (mlPairs.length > 0) {
      markets.h2h = buildConsensusMoneyline(mlPairs);
    }

    // Spreads (game handicaps for tennis)
    const spreadPairs = [];
    for (const book of allBooks) {
      const sMarket = book.markets?.find(m => m.key === 'spreads');
      if (!sMarket) continue;
      const home = sMarket.outcomes?.find(o => o.name === event.home_team);
      const away = sMarket.outcomes?.find(o => o.name === event.away_team);
      if (home && away) {
        spreadPairs.push({
          book: book.key,
          home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price, point: home.point, line: home.point },
          away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price, point: away.point, line: away.point },
        });
      }
    }
    if (spreadPairs.length > 0) {
      markets.spreads = buildConsensusSpread(spreadPairs);
    }

    // Totals (total games for tennis)
    const totalPairs = [];
    for (const book of allBooks) {
      const tMarket = book.markets?.find(m => m.key === 'totals');
      if (!tMarket) continue;
      const over = tMarket.outcomes?.find(o => o.name === 'Over');
      const under = tMarket.outcomes?.find(o => o.name === 'Under');
      if (over && under) {
        totalPairs.push({
          book: book.key,
          over: { odds_probability: americanToImpliedProb(over.price), odds_american: over.price, point: over.point, line: over.point },
          under: { odds_probability: americanToImpliedProb(under.price), odds_american: under.price, point: under.point, line: under.point },
        });
      }
    }
    if (totalPairs.length > 0) {
      markets.totals = buildConsensusTotals(totalPairs);
    }

    if (Object.keys(markets).length > 0) {
      const entry = {
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        markets,
        // Tournament traceability — line-manager / debug endpoints can
        // see which sport_<tournament> bucket this came from.
        sourceTournament: event._sourceTournament || null,
      };
      parsed[key] = entry;
      // Per-tournament parallel cache. Same event content, but indexed
      // under the explicit TOA sport key (e.g. tennis_atp_french_open)
      // so a line-manager fallback can scan tennis_* keys when the
      // generic 'tennis' lookup misses.
      const tk = event._sourceTournament;
      if (tk) {
        if (!parsedByTournament.has(tk)) parsedByTournament.set(tk, {});
        parsedByTournament.get(tk)[key] = entry;
      }
    }
  }

  // Store in cache under the generic sport key (existing behaviour)
  oddsCache[sport] = {
    events: parsed,
    fetchedAt: Date.now(),
    perTournamentCounts: Object.fromEntries(
      [...parsedByTournament.entries()].map(([tk, evs]) => [tk, Object.keys(evs).length])
    ),
  };

  // Also write per-tournament cache entries. Same events as the generic
  // bucket but indexed by their TOA sport key. line-manager's resolve
  // path scans these when the generic key doesn't have an event.
  for (const [tourKey, tourEvents] of parsedByTournament.entries()) {
    oddsCache[tourKey] = {
      events: tourEvents,
      fetchedAt: Date.now(),
      sourceTournament: tourKey,
      parentSport: sport,
    };
  }

  // Refresh-time diagnostic: log per-tournament event counts so the
  // operator can see in Railway logs which tournaments are populated.
  if (parsedByTournament.size > 0) {
    const summary = [...parsedByTournament.entries()]
      .map(([tk, evs]) => `${tk}=${Object.keys(evs).length}`)
      .join(', ');
    log.info('OddsFeed', `${sport} per-tournament cache populated: ${summary}`);
  }

  // Duplicate-event audit: log WARN if two cache entries represent the
  // same game under different team-name strings. This is the signature
  // of the April 2026 Red Sox bug — SharpAPI stored "BOS Red Sox vs
  // New York Yankees" while The Odds API stored "Boston Red Sox vs
  // New York Yankees" for the SAME game, producing two cache keys
  // that the closest-by-time matcher couldn't merge. Catching this at
  // ingest gives us a chance to add an entry to TEAM_ABBREV_TO_CANONICAL
  // before any RFQs get mispriced.
  auditCacheForDuplicateEvents(sport);

  return parsed;
}

// Helpers + main loop for the duplicate-event audit.
function _teamTail(name) {
  // Last 1-2 tokens, lowercased. "BOS Red Sox" and "Boston Red Sox"
  // both → "red sox"; "Chicago White Sox" → "white sox" (not confused
  // with Red Sox). Singletons fall through to just their one token.
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return '';
  return toks.slice(-2).join(' ').toLowerCase();
}
function auditCacheForDuplicateEvents(sport) {
  const cache = oddsCache[sport];
  if (!cache || !cache.events) return;
  // Group events by (home-tail, away-tail, date) — collisions under
  // different full names signal a naming-variant bug.
  const groups = {};
  for (const [key, entry] of Object.entries(cache.events)) {
    const list = Array.isArray(entry) ? entry : [entry];
    for (const ev of list) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const date = ev.commenceTime ? String(ev.commenceTime).substring(0, 10) : 'nodate';
      const groupKey = _teamTail(ev.homeTeam) + '|' + _teamTail(ev.awayTeam) + '|' + date;
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push({ cacheKey: key, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
    }
  }
  for (const [gk, members] of Object.entries(groups)) {
    if (members.length < 2) continue;
    // Only warn if at least two members have DIFFERENT full team-name
    // strings (otherwise it's just the same event under one key, fine).
    const distinct = new Set(members.map(m => m.homeTeam + '|' + m.awayTeam));
    if (distinct.size < 2) continue;
    const detail = members.map(m => `"${m.homeTeam}" vs "${m.awayTeam}"`).join(' AND ');
    log.warn('OddsFeed', `Duplicate-event bug detected in ${sport} cache — same game cached under different team-name variants: ${detail}. Add entries to TEAM_ABBREV_TO_CANONICAL to collapse.`);
  }
}

async function fetchFromTheOddsApi(sport) {
  const fallback = ODDS_API_FALLBACK[sport];
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) {
    throw new Error(`No THE_ODDS_API_KEY set for fallback sport ${sport}`);
  }

  // Dynamic sports (e.g., tennis) — discover active tournaments first
  if (fallback.dynamic) {
    return fetchDynamicSports(sport, fallback, theOddsApiKey);
  }

  const url = `https://api.the-odds-api.com/v4/sports/${fallback.oddsApiSport}/odds`
    + `?apiKey=${theOddsApiKey}`
    + `&regions=us,eu`
    + `&markets=${fallback.markets}`
    + `&bookmakers=${fallback.bookmakers}`
    + `&oddsFormat=american`;

  log.info('OddsFeed', `Fetching ${sport} from The Odds API (fallback)...`);

  // TOA rate-limits by request FREQUENCY (429 EXCEEDED_FREQ_LIMIT), separate
  // from quota — the same trap the BTTS supplement hit. The refresh loop fires
  // ~17 sport fetches per cycle plus prop/per-event calls on the same key, so
  // intermittent 429s are routine. Without a retry, a 429 threw, the loop
  // skipped the sport for a whole cycle, and the cache silently served the
  // prior (possibly partial) event list — the mechanism behind sports going
  // stale and real games missing from the cache at seed time (5 MLB games
  // dark all day 2026-07-23, ~$43K of network fills missed). One bounded
  // retry after a short backoff absorbs the transient collisions.
  let resp = await fetch(url);
  if (resp.status === 429) {
    log.warn('OddsFeed', `TOA 429 (freq limit) for ${sport} — retrying once in 3s`);
    await new Promise(r => setTimeout(r, 3000));
    resp = await fetch(url);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`The Odds API ${resp.status} for ${sport}: ${text}`);
  }

  const remaining = resp.headers.get('x-requests-remaining');
    _checkToaQuota(remaining);
  const used = resp.headers.get('x-requests-used');
  if (remaining != null) {
    log.info('OddsFeed', `The Odds API usage: ${used} used, ${remaining} remaining`);
  }

  const events = await safeJsonFetch(resp);
  log.info('OddsFeed', `Got ${events.length} events for ${sport} from The Odds API`);

  // Parse into same cache format as SharpAPI
  const parsed = {};
  for (const event of events) {
    const key = normalizeEventKey(event.home_team, event.away_team);
    // Collect all books' odds and build consensus
    const allBooks = event.bookmakers || [];
    if (allBooks.length === 0) continue;

    const markets = {};

    // Moneyline (h2h)
    const mlPairs = [];
    for (const book of allBooks) {
      const mlMarket = book.markets?.find(m => m.key === 'h2h');
      if (!mlMarket) continue;
      const home = mlMarket.outcomes?.find(o => o.name === event.home_team);
      const away = mlMarket.outcomes?.find(o => o.name === event.away_team);
      if (home && away) {
        mlPairs.push({
          book: book.key,
          home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price },
          away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price },
        });
      }
    }
    if (mlPairs.length > 0) {
      // PRICING PARITY with the SharpAPI consensus path (SharpAPI-removal
      // audit): (1) drop high-vig books from the averaging input via
      // filterSharpBooks — without it a Saba-class feed corrupts the
      // unweighted mean exactly as it did on the Sharp path pre-filter;
      // (2) Pinnacle floor on ALL favorites (>=0.50, not 0.65) — the Sharp
      // path lowered this after the Padres-at-60% Saba-pollution incident.
      // Kalshi excluded from averaging; display columns keep every book.
      const avgPairs = filterSharpBooks(
        excludeKalshiFromConsensus(mlPairs),
        bp => [bp.home.odds_probability, bp.away.odds_probability],
        'toa-moneyline'
      );
      const fairHome = [], fairAway = [];
      for (const p of avgPairs) {
        const [fh, fa] = deVig2Way(p.home.odds_probability, p.away.odds_probability);
        fairHome.push(fh);
        fairAway.push(fa);
      }
      // Use de-vigged Pinnacle (not raw implied) to avoid double-vig.
      // Kalshi NOT used as fallback floor — operator intent: reference only.
      const pinPair = mlPairs.find(p => p.book === 'pinnacle');
      const pinFairH = pinPair ? deVig2Way(pinPair.home.odds_probability, pinPair.away.odds_probability)[0] : 0;
      const pinFairA = pinPair ? deVig2Way(pinPair.home.odds_probability, pinPair.away.odds_probability)[1] : 0;
      const dvH = avg(fairHome), dvA = avg(fairAway);
      const flrH = pinPair ? pinFairH : 0;
      const flrA = pinPair ? pinFairA : 0;
      const maxHome = dvH >= 0.50 ? Math.max(dvH, flrH) : dvH;
      const maxAway = dvA >= 0.50 ? Math.max(dvA, flrA) : dvA;
      // Find named books for per-book display columns (previously unpopulated
      // in this fallback path — dashboard book columns were always blank).
      const findBook = (name) => mlPairs.find(p => p.book === name);
      const pinBook = findBook('pinnacle');
      const fdBook = findBook('fanduel');
      const dkBook = findBook('draftkings');
      const klBook = findBook('kalshi');
      markets.h2h = {
        home: { rawOdds: mlPairs[0].home.odds_american, impliedProb: mlPairs[0].home.odds_probability, fairProb: maxHome, displayFairProb: avg(fairHome) },
        away: { rawOdds: mlPairs[0].away.odds_american, impliedProb: mlPairs[0].away.odds_probability, fairProb: maxAway, displayFairProb: avg(fairAway) },
        books: mlPairs.length,
        pinnacle: pinBook ? { home: pinBook.home.odds_american, away: pinBook.away.odds_american } : null,
        fanduel: fdBook ? { home: fdBook.home.odds_american, away: fdBook.away.odds_american } : null,
        draftkings: dkBook ? { home: dkBook.home.odds_american, away: dkBook.away.odds_american } : null,
        kalshi: klBook ? { home: klBook.home.odds_american, away: klBook.away.odds_american } : null,
      };
    }

    // --- 3-WAY moneyline (home / draw / away) ---
    //
    // markets.h2h above deliberately DROPS the draw and 2-way de-vigs the
    // home/away pair, which is the right input for PX's "Moneyline (2 Way)"
    // draw-no-bet product. But PX ALSO posts the true 3-way as separate
    // markets -- "<Team> to Win (90 Min)" and "Draw (90 Min)" -- and those
    // cannot be priced off a DNB number: a DNB home price is P(home | no
    // draw), which is materially higher than P(home). Quoting one as the
    // other would systematically overprice every home/away win leg.
    //
    // So store the 3-way separately rather than changing h2h. Nothing reads
    // this yet; it exists so the 3-way markets have a correct basis to price
    // from. Measured on the live board (Bristol City @ Birmingham City,
    // 2026-08-22): raw 56.52/28.57/22.22 summing to 107.32% de-vigs to
    // 54.15/26.00/19.85. The DNB home number for the same game is ~73%,
    // which is why these must not be interchanged.
    const threeWay = [];
    for (const book of allBooks) {
      const mk = book.markets?.find(m => m.key === 'h2h');
      if (!mk) continue;
      const h = mk.outcomes?.find(o => o.name === event.home_team);
      const a = mk.outcomes?.find(o => o.name === event.away_team);
      const d = mk.outcomes?.find(o => String(o.name).toLowerCase() === 'draw');
      // No draw outcome means this is a genuine 2-way sport, not a soccer
      // book that happens to be missing one leg -- skip silently.
      if (!h || !a || !d) continue;
      const ph = americanToImpliedProb(h.price);
      const pd = americanToImpliedProb(d.price);
      const pa = americanToImpliedProb(a.price);
      const fair = deVig3WayPower(ph, pd, pa);
      if (!fair) continue;
      threeWay.push({ book: book.key, fair, raw: { home: h.price, draw: d.price, away: a.price } });
    }
    if (threeWay.length > 0) {
      // Same book-quality filter the 2-way consensus uses, so a high-vig
      // outlier cannot drag the 3-way mean where it cannot drag the 2-way.
      const kept = filterSharpBooks(
        excludeKalshiFromConsensus(threeWay),
        t => [t.fair[0], t.fair[2]],
        'toa-moneyline-3way'
      );
      const use = kept.length > 0 ? kept : threeWay;
      const pick = (i) => avg(use.map(t => t.fair[i]));
      markets.h2h_3way = {
        home: { fairProb: pick(0), rawOdds: use[0].raw.home },
        draw: { fairProb: pick(1), rawOdds: use[0].raw.draw },
        away: { fairProb: pick(2), rawOdds: use[0].raw.away },
        books: use.length,
        source: 'toa-3way-power',
      };
    }

    // Spreads — line-aware consensus. Tag each book's pair with its posted
    // line so buildConsensusSpread keys de-vig BY LINE (modal line = primary,
    // every other posted line preserved in byLine for alt-line RFQs). The
    // previous hand-rolled block de-vigged across ALL books regardless of
    // point and stamped the result with the FIRST book's line — so a +1.5 RFQ
    // could be priced off a blend of pick-em and +1.5 books. buildConsensusSpread
    // already carries the same parity logic (filterSharpBooks + 0.50 Pin floor),
    // so this is a clean swap that matches the tennis/dynamic path.
    const spreadPairs = [];
    for (const book of allBooks) {
      const sMarket = book.markets?.find(m => m.key === 'spreads');
      if (!sMarket) continue;
      const home = sMarket.outcomes?.find(o => o.name === event.home_team);
      const away = sMarket.outcomes?.find(o => o.name === event.away_team);
      if (home && away) {
        spreadPairs.push({
          book: book.key,
          home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price, point: home.point, line: home.point },
          away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price, point: away.point, line: away.point },
        });
      }
    }
    if (spreadPairs.length > 0) {
      markets.spreads = buildConsensusSpread(spreadPairs);
    }

    // Totals — line-aware consensus. Tag each book's pair with its posted
    // line so buildConsensusTotals keys de-vig BY LINE. The previous block
    // de-vigged across ALL books regardless of point and labeled the result
    // with the FIRST book's line — root cause of the TB@LAD Under 7.5 quoted
    // off a blend of 7.0/7.5 books. buildConsensusTotals already carries the
    // same parity logic (filterSharpBooks + 0.50 Pin floor), so this is a
    // clean swap that matches the tennis/dynamic path.
    const totalPairs = [];
    for (const book of allBooks) {
      const tMarket = book.markets?.find(m => m.key === 'totals');
      if (!tMarket) continue;
      const over = tMarket.outcomes?.find(o => o.name === 'Over');
      const under = tMarket.outcomes?.find(o => o.name === 'Under');
      if (over && under) {
        totalPairs.push({
          book: book.key,
          over: { odds_probability: americanToImpliedProb(over.price), odds_american: over.price, point: over.point, line: over.point },
          under: { odds_probability: americanToImpliedProb(under.price), odds_american: under.price, point: under.point, line: under.point },
        });
      }
    }
    if (totalPairs.length > 0) {
      markets.totals = buildConsensusTotals(totalPairs);
    }

    // BTTS (Both Teams To Score) — simple 2-way Yes/No
    const bttsPairs = [];
    for (const book of allBooks) {
      const bMarket = book.markets?.find(m => m.key === 'btts');
      if (!bMarket) continue;
      const yes = bMarket.outcomes?.find(o => o.name === 'Yes');
      const no = bMarket.outcomes?.find(o => o.name === 'No');
      if (yes && no) {
        bttsPairs.push({
          yes: { odds_probability: americanToImpliedProb(yes.price), odds_american: yes.price },
          no: { odds_probability: americanToImpliedProb(no.price), odds_american: no.price },
        });
      }
    }
    if (bttsPairs.length > 0) {
      const fairYes = [], fairNo = [];
      for (const p of bttsPairs) {
        const [fy, fn] = deVig2Way(p.yes.odds_probability, p.no.odds_probability);
        fairYes.push(fy);
        fairNo.push(fn);
      }
      const dvYes = avg(fairYes), dvNo = avg(fairNo);
      markets.btts = {
        yes: { rawOdds: bttsPairs[0].yes.odds_american, impliedProb: bttsPairs[0].yes.odds_probability, fairProb: dvYes, displayFairProb: dvYes },
        no: { rawOdds: bttsPairs[0].no.odds_american, impliedProb: bttsPairs[0].no.odds_probability, fairProb: dvNo, displayFairProb: dvNo },
        books: bttsPairs.length,
      };
    }

    // Double Chance — 3-way (1X, X2, 12)
    const dcPairs = [];
    for (const book of allBooks) {
      const dMarket = book.markets?.find(m => m.key === 'double_chance');
      if (!dMarket) continue;
      // Outcome names from The Odds API: "Home/Draw", "Away/Draw", "Home/Away"
      // Some books use: "1X", "X2", "12"
      const outcomes = dMarket.outcomes || [];
      const find = (patterns) => outcomes.find(o => {
        const name = (o.name || '').toLowerCase().replace(/\s+/g, '');
        return patterns.some(p => name === p || name.includes(p));
      });
      const oneX = find(['1x', 'homeordraw', 'home/draw', 'homedraw', event.home_team?.toLowerCase() + '/draw']);
      const xTwo = find(['x2', 'awayordraw', 'away/draw', 'awaydraw', 'draw/' + event.away_team?.toLowerCase()]);
      const oneTwo = find(['12', 'homeoraway', 'home/away', 'homeaway', event.home_team?.toLowerCase() + '/' + event.away_team?.toLowerCase()]);
      if (oneX && xTwo && oneTwo) {
        dcPairs.push({
          oneX: { odds_probability: americanToImpliedProb(oneX.price), odds_american: oneX.price },
          xTwo: { odds_probability: americanToImpliedProb(xTwo.price), odds_american: xTwo.price },
          oneTwo: { odds_probability: americanToImpliedProb(oneTwo.price), odds_american: oneTwo.price },
        });
      }
    }
    if (dcPairs.length > 0) {
      const fair1X = [], fairX2 = [], fair12 = [];
      for (const p of dcPairs) {
        const [f1x, fx2, f12] = deVigDoubleChance(p.oneX.odds_probability, p.xTwo.odds_probability, p.oneTwo.odds_probability);
        fair1X.push(f1x);
        fairX2.push(fx2);
        fair12.push(f12);
      }
      const dv1X = avg(fair1X), dvX2 = avg(fairX2), dv12 = avg(fair12);
      markets.double_chance = {
        '1X': { rawOdds: dcPairs[0].oneX.odds_american, impliedProb: dcPairs[0].oneX.odds_probability, fairProb: dv1X, displayFairProb: dv1X },
        'X2': { rawOdds: dcPairs[0].xTwo.odds_american, impliedProb: dcPairs[0].xTwo.odds_probability, fairProb: dvX2, displayFairProb: dvX2 },
        '12': { rawOdds: dcPairs[0].oneTwo.odds_american, impliedProb: dcPairs[0].oneTwo.odds_probability, fairProb: dv12, displayFairProb: dv12 },
        books: dcPairs.length,
      };
    }

    if (Object.keys(markets).length > 0) {
      if (!parsed[key]) parsed[key] = [];
      parsed[key].push({
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        eventId: event.id,
        markets,
      });
    }
  }

  oddsCache[sport] = { fetchedAt: Date.now(), events: parsed };
  const totalEvents = Object.values(parsed).reduce((s, arr) => s + arr.length, 0);
  log.info('OddsFeed', `Cached ${totalEvents} events (${Object.keys(parsed).length} matchups) for ${sport} (The Odds API fallback)`);
  // Audit: same check as SharpAPI path (see auditCacheForDuplicateEvents).
  auditCacheForDuplicateEvents(sport);
  // Sub-game/backstop supplements (F5/H1/team totals/DK) — hoisted shared
  // step so TOA-primary sports keep them (SharpAPI-removal audit).
  await _runPostParseSupplements(sport, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// CONSENSUS BUILDERS — de-vig each book, then average fair probs
// ---------------------------------------------------------------------------

/**
 * Group odds rows into book-level pairs (home+away for the same book).
 */
function getBookPairs(odds, marketType) {
  const filtered = marketType ? odds.filter(r => r.market_type === marketType) : odds;
  // Key by (book, signed_home_line, selection_type) for spreads, OR
  // (book, '', selection_type) for moneylines/markets without a line.
  // The signed_home_line is the line FROM HOME'S PERSPECTIVE: home rows
  // use row.line directly; away rows use -row.line so they pair with the
  // home record that represents the same logical spread.
  //
  // Why this matters (root cause of 2026-05-11 F5 RL mispricing): when
  // SharpAPI returns multiple alt-line spread rows for the same book in
  // the primary feed (verified on MLB 1st_5_innings_run_line — Pinnacle
  // posts +0.5, +1.5 etc. in the same response), the prior keying by
  // (book, selection_type) only let the last-written row OVERWRITE
  // earlier ones. Home could end up holding BAL+0.5 while away held
  // NYY+1.5 — across-line mis-pairing. The downstream de-vig in
  // buildConsensusSpread then produced near-50/50 garbage instead of
  // Pinnacle's actual ~42/58 split.
  //
  // Same root cause that was previously fixed in getBookPairsForTotals
  // (commit 5ad919f) and getBookPairsForTeamTotals — but never applied
  // here. Aligning the keying scheme now.
  const byKey = {};
  for (const row of filtered) {
    let homeSignedLine = '';
    if (row.line != null) {
      if (row.selection_type === 'home') homeSignedLine = row.line;
      else if (row.selection_type === 'away') homeSignedLine = -row.line;
      else homeSignedLine = row.line; // 'draw' etc. — bucketed by raw line
    }
    const bookKey = row.sportsbook + '|' + homeSignedLine;
    if (!byKey[bookKey]) byKey[bookKey] = { book: row.sportsbook };
    byKey[bookKey][row.selection_type] = row;
  }
  // Only return entries with both home and away populated.
  return Object.values(byKey)
    .filter(o => o.home && o.away)
    .map(o => ({ book: o.book, home: o.home, away: o.away }));
}

function getBookPairsForTotals(odds) {
  // Key by (sportsbook, LINE) so Over at line X only pairs with Under at
  // line X from the same book. Port of the 5ad919f team_total fix — the
  // commit message flagged this function as having the same latent bug.
  //
  // Root-cause fix for 2026-04-24 CLE @ TOR U 8.5 mispricing
  // (parlay 019dc030, our fair 90.36% vs book consensus 55.5% — 35pp error).
  // Prior version keyed by (sportsbook, selection_type) only, so when
  // SharpAPI included alt total rows in the primary feed for one book
  // (observed on MLB totals — a single feed response can include
  // Over/Under at 7.5, 8, 8.5, 9), the last-written `under` row
  // overwrote earlier ones — producing e.g. Over 8.5 paired with
  // Under 6.5, de-vigging to a 90%/10% split when the true primary
  // was ~55%/45%.
  //
  // Rows without a `line` field are dropped — can't pair safely.
  // Books that post only one side at a given line are silently dropped
  // rather than mispaired.
  const byKey = {};
  for (const row of odds) {
    if (row.line == null) continue;
    const dir = row.selection_type;
    if (dir !== 'over' && dir !== 'under') continue;
    const key = `${row.sportsbook}|${row.line}`;
    if (!byKey[key]) byKey[key] = { book: row.sportsbook, line: row.line };
    byKey[key][dir] = row;
  }
  return Object.values(byKey).filter(p => p.over && p.under);
}

/**
 * Group team_total odds by sportsbook and team side (home/away).
 * SharpAPI team_total selection_type: "home_over", "home_under", "away_over", "away_under"
 */
function getBookPairsForTeamTotals(odds) {
  // Key by (book, side, LINE) to guarantee Over/Under pair at the SAME
  // line per book.
  //
  // Root-cause fix for 2026-04-23 ATL Braves mispricing
  // (parlay 019dbae7-632b-7647): prior version keyed by (book, side)
  // only, so when a book posted multiple alt lines for one team
  // (common on FanDuel MLB team_totals — a single feed response can
  // include Under 4.5, 5.5, 6.5 for the same team), the last-written
  // `under` row overwrote earlier ones. Over 4.5 (-136) ended up
  // paired with Under 6.5 (-225), producing a 127% overround.
  // Proportional de-vig then assigned ~45% to the Over side when
  // real FanDuel-fair was ~55% — a ~10pp miss in the losing direction.
  //
  // With line-keyed pairing, each line gets its own over/under pair
  // (matching by same-book same-line). Only pairs where BOTH Over and
  // Under exist at that line flow downstream to buildConsensusTeamTotals.
  const byKey = {};
  for (const row of odds) {
    // Determine team side and direction from selection_type
    const st = row.selection_type || '';
    let side, dir;
    if (st.includes('home') && st.includes('over')) { side = 'home'; dir = 'over'; }
    else if (st.includes('home') && st.includes('under')) { side = 'home'; dir = 'under'; }
    else if (st.includes('away') && st.includes('over')) { side = 'away'; dir = 'over'; }
    else if (st.includes('away') && st.includes('under')) { side = 'away'; dir = 'under'; }
    else {
      // Fallback: try selection field
      const sel = (row.selection || '').toLowerCase();
      if (sel.includes('over')) dir = 'over';
      else if (sel.includes('under')) dir = 'under';
      else continue;
      // Determine side from home/away team name match
      side = row.selection_type === 'home' ? 'home' : row.selection_type === 'away' ? 'away' : null;
      if (!side) continue;
    }
    // Need a line to pair safely. Rows without line would conflate
    // multiple alt lines into one pair (the original bug).
    if (row.line == null) continue;
    const key = `${row.sportsbook}|${side}|${row.line}`;
    if (!byKey[key]) {
      byKey[key] = { book: row.sportsbook, teamSide: side, line: row.line };
    }
    byKey[key][dir] = row;
  }
  // Keep only entries where BOTH sides of the same line exist. Books
  // that post only one side at a line (rare, but possible mid-update)
  // are silently dropped rather than mispaired.
  return Object.values(byKey).filter(p => p.over && p.under);
}

/**
 * Build consensus for team totals — one over/under pair per team side.
 */
function buildConsensusTeamTotals(bookPairs) {
  const result = {};
  for (const side of ['home', 'away']) {
    const sidePairs = bookPairs.filter(bp => bp.teamSide === side);
    if (sidePairs.length === 0) continue;

    // Find primary line
    const lineCounts = {};
    for (const bp of sidePairs) {
      const line = bp.over.line;
      if (line != null) lineCounts[line] = (lineCounts[line] || 0) + 1;
    }
    const primaryLine = parseFloat(Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0]?.[0]);
    if (isNaN(primaryLine)) continue;
    const matching = sidePairs.filter(bp => bp.over.line === primaryLine);
    if (matching.length === 0) continue;

    // Exclude Kalshi from team-total averaging for the same reason as
    // moneyline/spread/total consensus (prediction-market thinness).
    const avgSet = excludeKalshiFromConsensus(matching);
    const devigged = { over: [], under: [] };
    for (const { over, under } of avgSet) {
      const [fo, fu] = deVig2Way(over.odds_probability, under.odds_probability);
      devigged.over.push(fo);
      devigged.under.push(fu);
    }
    const dvOver = avg(devigged.over);
    const dvUnder = avg(devigged.under);
    const pinBook = matching.find(bp => bp.book === 'pinnacle');
    // Floor at Pinnacle's DE-VIGGED fair prob (not raw) to avoid double-vig.
    const pinFairO = pinBook ? deVig2Way(pinBook.over.odds_probability, pinBook.under.odds_probability)[0] : 0;
    const pinFairU = pinBook ? deVig2Way(pinBook.over.odds_probability, pinBook.under.odds_probability)[1] : 0;

    // Build per-line consensus alongside the primary so getFairProb can
    // resolve alt team_total RFQs (PX often asks for ±1 line off primary
    // — e.g. cached primary 4.5, PX wants 5.5). Without byLine, those
    // RFQs return null fair-prob even when DK/FD posted the alt.
    const byLineEntries = {};
    const linesPresent = [...new Set(sidePairs.map(bp => bp.over.line).filter(l => l != null))];
    for (const altLine of linesPresent) {
      const altMatching = sidePairs.filter(bp => bp.over.line === altLine);
      if (altMatching.length === 0) continue;
      const altAvgSet = excludeKalshiFromConsensus(altMatching);
      const altDevigged = { over: [], under: [] };
      for (const { over, under } of altAvgSet) {
        const [fo, fu] = deVig2Way(over.odds_probability, under.odds_probability);
        altDevigged.over.push(fo);
        altDevigged.under.push(fu);
      }
      const altDvOver = avg(altDevigged.over);
      const altDvUnder = avg(altDevigged.under);
      const altPinBook = altMatching.find(bp => bp.book === 'pinnacle');
      const altPinFairO = altPinBook ? deVig2Way(altPinBook.over.odds_probability, altPinBook.under.odds_probability)[0] : 0;
      const altPinFairU = altPinBook ? deVig2Way(altPinBook.over.odds_probability, altPinBook.under.odds_probability)[1] : 0;
      byLineEntries[String(altLine)] = {
        line: altLine,
        over: {
          rawOdds: altMatching[0].over.odds_american,
          impliedProb: altMatching[0].over.odds_probability,
          fairProb: altDvOver >= 0.65 ? Math.max(altDvOver, altPinFairO) : altDvOver,
          displayFairProb: altDvOver,
        },
        under: {
          rawOdds: altMatching[0].under.odds_american,
          impliedProb: altMatching[0].under.odds_probability,
          fairProb: altDvUnder >= 0.65 ? Math.max(altDvUnder, altPinFairU) : altDvUnder,
          displayFairProb: altDvUnder,
        },
        books: altMatching.length,
      };
    }

    result[side] = {
      over: {
        rawOdds: matching[0].over.odds_american,
        impliedProb: matching[0].over.odds_probability,
        fairProb: dvOver >= 0.65 ? Math.max(dvOver, pinFairO) : dvOver,
        displayFairProb: dvOver,
      },
      under: {
        rawOdds: matching[0].under.odds_american,
        impliedProb: matching[0].under.odds_probability,
        fairProb: dvUnder >= 0.65 ? Math.max(dvUnder, pinFairU) : dvUnder,
        displayFairProb: dvUnder,
      },
      line: primaryLine,
      books: matching.length,
      pinnacle: pinBook ? { over: pinBook.over.odds_american, under: pinBook.under.odds_american } : null,
      // byLine is keyed by stringified line value so getFairProb's lookup
      // (`market[side].byLine[String(absLine)]`) finds it without a Number
      // round-trip. Populated only when the supplement saw multiple lines
      // for this team (alt market_keys returned data) — empty for single-
      // line consensus, which is the common case.
      byLine: byLineEntries,
    };
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Drop Kalshi from consensus-averaging input. Kalshi is a prediction
 * market with thin volume on sports and often leaves prices orphaned
 * on the wrong side for hours — leading to the Guardians −142 market
 * vs Kalshi +130 disagreement (15pp) that pulled our fair to ~50/50
 * when real market was ~59/41. Operator intent: Kalshi is reference
 * only. Preserved in allBooks so the dashboard's Kalshi column still
 * populates as an eyeball-comparison reference, but NOT used for any
 * pricing input (averaging or fallback floor). Defensive fallback:
 * if Kalshi is the ONLY book in bookPairs, keep it rather than
 * averaging an empty set.
 */
function excludeKalshiFromConsensus(bookPairs) {
  const filtered = bookPairs.filter(bp => bp.book !== 'kalshi');
  return filtered.length > 0 ? filtered : bookPairs;
}

function buildConsensusMoneyline(bookPairs) {
  // Preserve ALL books for display attribution (pinnacle/fd/dk/kalshi fields
  // are always populated from the full list so the dashboard can show every
  // book's raw odds regardless of its vig).
  const allBooks = bookPairs;

  // Filter high-vig books out of the averaging input. Prevents Saba-class
  // Asian bookmaking feeds from corrupting the de-vigged consensus mean
  // via unweighted averaging. See filterSharpBooks for rationale.
  // Also exclude Kalshi — prediction-market thinness, see helper above.
  const sharpBooks = filterSharpBooks(
    excludeKalshiFromConsensus(bookPairs),
    bp => [bp.home.odds_probability, bp.away.odds_probability],
    'moneyline'
  );

  // Compute de-vigged consensus across FILTERED books (for display as "Fair")
  const devigged = { home: [], away: [] };
  for (const { home, away } of sharpBooks) {
    const [fh, fa] = deVig2Way(home.odds_probability, away.odds_probability);
    devigged.home.push(fh);
    devigged.away.push(fa);
  }
  const dvHome = avg(devigged.home);
  const dvAway = avg(devigged.away);

  // For PRICING: use de-vigged consensus as fair value for normal legs.
  // On ANY favorite side (fairProb >= 0.50), floor at Pinnacle's DE-VIGGED
  // fair prob (not raw implied — raw contains Pin's vig, which would double-
  // vig when we apply ours on top). Threshold lowered from 0.65 to 0.50
  // after observing Padres (~60% fair) get dragged to 54% by Saba pollution
  // — the old threshold meant any favorite between 50-65% had no floor
  // protection at all. Extending to all favorites makes Pin an effective
  // lower bound whenever Pin is present in the event.
  const pinBook = allBooks.find(bp => bp.book === 'pinnacle');
  const fdBook = allBooks.find(bp => bp.book === 'fanduel');
  const klBook = allBooks.find(bp => bp.book === 'kalshi');
  const pinFairHome = pinBook ? deVig2Way(pinBook.home.odds_probability, pinBook.away.odds_probability)[0] : 0;
  const pinFairAway = pinBook ? deVig2Way(pinBook.home.odds_probability, pinBook.away.odds_probability)[1] : 0;
  // Pinnacle floor only. Kalshi no longer used as fallback floor —
  // operator intent: reference/display only, not a pricing input.
  const floorHome = pinBook ? pinFairHome : 0;
  const floorAway = pinBook ? pinFairAway : 0;
  const pricingHome = dvHome >= 0.50 ? Math.max(dvHome, floorHome) : dvHome;
  const pricingAway = dvAway >= 0.50 ? Math.max(dvAway, floorAway) : dvAway;

  const pinnacle = pinBook ? {
    home: pinBook.home.odds_american,
    away: pinBook.away.odds_american,
  } : null;
  const fanduel = fdBook ? {
    home: fdBook.home.odds_american,
    away: fdBook.away.odds_american,
  } : null;
  const kalshi = klBook ? {
    home: klBook.home.odds_american,
    away: klBook.away.odds_american,
  } : null;
  return {
    home: {
      rawOdds: bookPairs[0].home.odds_american,
      impliedProb: bookPairs[0].home.odds_probability,
      fairProb: pricingHome,
      displayFairProb: dvHome,    // de-vigged consensus — used for FAIR column
    },
    away: {
      rawOdds: bookPairs[0].away.odds_american,
      impliedProb: bookPairs[0].away.odds_probability,
      fairProb: pricingAway,
      displayFairProb: dvAway,
    },
    books: bookPairs.length,
    pinnacle,
    fanduel,
    kalshi,
    draftkings: (() => {
      const dkBook = bookPairs.find(bp => bp.book === 'draftkings');
      return dkBook ? { home: dkBook.home.odds_american, away: dkBook.away.odds_american } : null;
    })(),
  };
}

function buildConsensusSpread(bookPairs) {
  // Use the most common line across books
  const lineCounts = {};
  for (const { home } of bookPairs) {
    const line = home.line;
    if (line != null) lineCounts[line] = (lineCounts[line] || 0) + 1;
  }
  const primaryLine = Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pLine = parseFloat(primaryLine);

  // Filter to books with this line
  const matching = bookPairs.filter(bp => bp.home.line === pLine);
  if (matching.length === 0) return null;

  // Filter high-vig books out of the averaging input (see
  // filterSharpBooks rationale in buildConsensusMoneyline). Kalshi
  // also excluded — see excludeKalshiFromConsensus doc.
  const sharpMatching = filterSharpBooks(
    excludeKalshiFromConsensus(matching),
    bp => [bp.home.odds_probability, bp.away.odds_probability],
    'spread'
  );

  // De-vigged consensus for display
  const devigged = { home: [], away: [] };
  for (const { home, away } of sharpMatching) {
    const [fh, fa] = deVig2Way(home.odds_probability, away.odds_probability);
    devigged.home.push(fh);
    devigged.away.push(fa);
  }
  const dvHome = avg(devigged.home);
  const dvAway = avg(devigged.away);

  const pinBook = matching.find(bp => bp.book === 'pinnacle');
  const fdBook = matching.find(bp => bp.book === 'fanduel');
  // Floor at Pinnacle's DE-VIGGED fair prob (not raw implied) — raw would
  // include Pinnacle's vig and cause double-vig when we apply ours on top.
  // Threshold lowered from 0.65 to 0.50 so any favorite side gets floored
  // against Pin's de-vigged prob whenever Pin is present.
  // Kalshi no longer used as fallback floor — reference only per operator intent.
  const pinFairHomeS = pinBook ? deVig2Way(pinBook.home.odds_probability, pinBook.away.odds_probability)[0] : 0;
  const pinFairAwayS = pinBook ? deVig2Way(pinBook.home.odds_probability, pinBook.away.odds_probability)[1] : 0;
  const floorHomeS = pinBook ? pinFairHomeS : 0;
  const floorAwayS = pinBook ? pinFairAwayS : 0;
  const pricingHome = dvHome >= 0.50 ? Math.max(dvHome, floorHomeS) : dvHome;
  const pricingAway = dvAway >= 0.50 ? Math.max(dvAway, floorAwayS) : dvAway;

  const pinnacle = pinBook ? {
    home: pinBook.home.odds_american,
    away: pinBook.away.odds_american,
  } : null;
  const fanduel = fdBook ? {
    home: fdBook.home.odds_american,
    away: fdBook.away.odds_american,
  } : null;
  const klBook = matching.find(bp => bp.book === 'kalshi');
  const kalshi = klBook ? {
    home: klBook.home.odds_american,
    away: klBook.away.odds_american,
  } : null;
  const dkBookS = matching.find(bp => bp.book === 'draftkings');
  const draftkings = dkBookS ? {
    home: dkBookS.home.odds_american,
    away: dkBookS.away.odds_american,
  } : null;
  // Build per-line consensus alongside the primary so getFairProb can
  // resolve alt spread RFQs (PX often asks for ±0.5 F5 RL when the
  // cached primary is 0 from Pinnacle's pick-em — DK/FD post ±0.5 as
  // their primary). Without byLine, those RFQs fall through to
  // altLinesCache which doesn't include line=0.5 because TOA's
  // alternate_spreads market only posts ±1, ±2, etc. (not ±0.5).
  //
  // Key shape: "home|<signed_line>" / "away|<signed_line>" — matches
  // the lookup convention in getFairProb's spreads byLine fast-path.
  const byLineEntries = {};
  const linesPresent = [...new Set(bookPairs.map(bp => bp.home.line).filter(l => l != null))];
  for (const altLine of linesPresent) {
    const altMatching = bookPairs.filter(bp => bp.home.line === altLine);
    if (altMatching.length === 0) continue;
    const altSharp = filterSharpBooks(
      excludeKalshiFromConsensus(altMatching),
      bp => [bp.home.odds_probability, bp.away.odds_probability],
      'spread'
    );
    if (altSharp.length === 0) continue;
    const altDevigged = { home: [], away: [] };
    for (const { home, away } of altSharp) {
      const [fh, fa] = deVig2Way(home.odds_probability, away.odds_probability);
      altDevigged.home.push(fh);
      altDevigged.away.push(fa);
    }
    const altDvHome = avg(altDevigged.home);
    const altDvAway = avg(altDevigged.away);
    const altPinBook = altMatching.find(bp => bp.book === 'pinnacle');
    const altPinHome = altPinBook ? deVig2Way(altPinBook.home.odds_probability, altPinBook.away.odds_probability)[0] : 0;
    const altPinAway = altPinBook ? deVig2Way(altPinBook.home.odds_probability, altPinBook.away.odds_probability)[1] : 0;
    const altPricingHome = altDvHome >= 0.50 ? Math.max(altDvHome, altPinHome) : altDvHome;
    const altPricingAway = altDvAway >= 0.50 ? Math.max(altDvAway, altPinAway) : altDvAway;
    // Home gets the line as posted; away gets the negated line.
    byLineEntries['home|' + altLine] = {
      line: altLine,
      fairProb: altPricingHome,
      displayFairProb: altDvHome,
      books: altMatching.length,
    };
    byLineEntries['away|' + (-altLine)] = {
      line: -altLine,
      fairProb: altPricingAway,
      displayFairProb: altDvAway,
      books: altMatching.length,
    };
  }

  return {
    home: {
      rawOdds: matching[0].home.odds_american,
      point: pLine,
      impliedProb: matching[0].home.odds_probability,
      fairProb: pricingHome,
      displayFairProb: dvHome,
    },
    away: {
      rawOdds: matching[0].away.odds_american,
      point: -pLine,
      impliedProb: matching[0].away.odds_probability,
      fairProb: pricingAway,
      displayFairProb: dvAway,
    },
    line: pLine,
    books: matching.length,
    pinnacle,
    fanduel,
    kalshi,
    draftkings,
    byLine: byLineEntries,
  };
}

// Compute the de-vigged consensus + book-level details for ONE specific
// totals line. Shared between primary and byLine computation. Returns null
// if no books posted this line.
function buildTotalsForLine(bookPairs, pLine) {
  const matching = bookPairs.filter(bp => bp.over.line === pLine);
  if (matching.length === 0) return null;

  // Exclude Kalshi from averaging (see excludeKalshiFromConsensus doc).
  const sharpMatching = filterSharpBooks(
    excludeKalshiFromConsensus(matching),
    bp => [bp.over.odds_probability, bp.under.odds_probability],
    'total'
  );

  const devigged = { over: [], under: [] };
  for (const { over, under } of sharpMatching) {
    const [fo, fu] = deVig2Way(over.odds_probability, under.odds_probability);
    devigged.over.push(fo);
    devigged.under.push(fu);
  }
  const dvOver = avg(devigged.over);
  const dvUnder = avg(devigged.under);

  const pinBook = matching.find(bp => bp.book === 'pinnacle');
  const klBookT = matching.find(bp => bp.book === 'kalshi');
  const pinFairOver = pinBook ? deVig2Way(pinBook.over.odds_probability, pinBook.under.odds_probability)[0] : 0;
  const pinFairUnder = pinBook ? deVig2Way(pinBook.over.odds_probability, pinBook.under.odds_probability)[1] : 0;
  // Pinnacle floor only. Kalshi no longer used as fallback floor.
  const floorOver = pinBook ? pinFairOver : 0;
  const floorUnder = pinBook ? pinFairUnder : 0;
  const pricingOver = dvOver >= 0.50 ? Math.max(dvOver, floorOver) : dvOver;
  const pricingUnder = dvUnder >= 0.50 ? Math.max(dvUnder, floorUnder) : dvUnder;

  const fdBook = matching.find(bp => bp.book === 'fanduel');
  const dkBook = matching.find(bp => bp.book === 'draftkings');

  return {
    over: {
      rawOdds: matching[0].over.odds_american,
      point: pLine,
      impliedProb: matching[0].over.odds_probability,
      fairProb: pricingOver,
      displayFairProb: dvOver,
    },
    under: {
      rawOdds: matching[0].under.odds_american,
      point: pLine,
      impliedProb: matching[0].under.odds_probability,
      fairProb: pricingUnder,
      displayFairProb: dvUnder,
    },
    line: pLine,
    books: matching.length,
    pinnacle: pinBook ? { over: pinBook.over.odds_american, under: pinBook.under.odds_american } : null,
    fanduel: fdBook ? { over: fdBook.over.odds_american, under: fdBook.under.odds_american } : null,
    kalshi: klBookT ? { over: klBookT.over.odds_american, under: klBookT.under.odds_american } : null,
    draftkings: dkBook ? { over: dkBook.over.odds_american, under: dkBook.under.odds_american } : null,
  };
}

function buildConsensusTotals(bookPairs) {
  // Tally distinct lines. The "primary" is the most-common line across
  // books; but we also preserve consensus for every OTHER line in `byLine`
  // so RFQs that reference a minority line (e.g., Pinnacle's integer 8
  // when the majority is 8.5) can be priced without a network fetch.
  const lineCounts = {};
  for (const { over } of bookPairs) {
    const line = over.line;
    if (line != null) lineCounts[line] = (lineCounts[line] || 0) + 1;
  }
  const entries = Object.entries(lineCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  const primaryLine = parseFloat(entries[0][0]);
  const primary = buildTotalsForLine(bookPairs, primaryLine);
  if (!primary) return null;

  const byLine = {};
  for (const [lineStr] of entries) {
    const ln = parseFloat(lineStr);
    const entry = buildTotalsForLine(bookPairs, ln);
    if (entry) byLine[String(ln)] = entry;
  }

  return { ...primary, byLine };
}

// ---------------------------------------------------------------------------
// DE-VIG
// ---------------------------------------------------------------------------

// Power (odds-ratio) de-vig for a 3-way market: home / draw / away.
//
// Soccer books do NOT spread their margin evenly across the three outcomes --
// they load it on the longshots (the draw and the underdog). Proportional
// de-vig therefore underrates the favourite, the same bias measured on the
// structurally identical golf make-cut board (-4.15pp proportional vs -0.83pp
// power) and on the UFC 6-way method-of-victory board. Power normalisation
// solves for the exponent k where sum(p_i^k) == 1, which shrinks longshots
// harder than favourites and matches book behaviour.
//
// Returns [home, draw, away] summing to 1, or null if any input is unusable.
// Falls back to proportional when no root exists in the bracket, which is the
// same conservative behaviour deVig2WayPower uses in services/datagolf.js.
function deVig3WayPower(pHome, pDraw, pAway) {
  const ps = [pHome, pDraw, pAway];
  if (!ps.every(p => typeof p === 'number' && p > 0 && p < 1)) return null;
  const f = (k) => ps.reduce((acc, p) => acc + Math.pow(p, k), 0) - 1;
  let lo = 0.2, hi = 8;
  if (f(lo) * f(hi) > 0) {
    const t = ps[0] + ps[1] + ps[2];
    return t > 0 ? ps.map(p => p / t) : null;
  }
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (f(k) > 0) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const out = ps.map(p => Math.pow(p, k));
  const sum = out[0] + out[1] + out[2];
  if (!(sum > 0)) return null;
  return out.map(v => v / sum);
}

function deVig2Way(prob1, prob2) {
  const total = prob1 + prob2;
  if (total === 0) return [0.5, 0.5];
  return [prob1 / total, prob2 / total];
}

// Max per-book 2-way vig tolerated in the consensus average. Books above
// this threshold (Asian square-bookmaking feeds like Saba, some retail
// outliers) systematically drag averaged fair probs away from sharp values.
// Pinnacle runs ~2%, FD/DK run 4-5%, anything > 6% is in a different class
// of bookmaking and shouldn't be weighted equally with majors.
const MAX_BOOK_VIG = 0.06;

/**
 * Filter bookPairs to keep only books whose 2-way implied prob sum is
 * within the MAX_BOOK_VIG threshold. The shape of each entry depends on
 * the caller: `getFields` returns `[sideA, sideB]` probability values.
 *
 * If filtering would leave zero books, falls back to the original list
 * (never return an empty set — better to have a noisy fair than no fair
 * at all). Logs dropped books for auditability.
 */
function filterSharpBooks(bookPairs, getFields, label) {
  if (!bookPairs || bookPairs.length === 0) return bookPairs;
  const kept = [];
  const dropped = [];
  for (const bp of bookPairs) {
    const [a, b] = getFields(bp);
    if (a == null || b == null) { kept.push(bp); continue; }
    const vig = (a + b) - 1;
    if (vig > MAX_BOOK_VIG) {
      dropped.push({ book: bp.book, vig: +(vig * 100).toFixed(1) });
    } else {
      kept.push(bp);
    }
  }
  if (kept.length === 0) {
    // All books failed the vig cap — last resort, keep everything rather
    // than fabricate a null. The Pin-floor below will still protect us
    // if Pinnacle is present with any vig level.
    if (dropped.length > 0) {
      log.debug('OddsFeed', `filterSharpBooks(${label}): all ${dropped.length} books exceeded ${(MAX_BOOK_VIG*100).toFixed(0)}% vig — keeping all as fallback`);
    }
    return bookPairs;
  }
  if (dropped.length > 0) {
    log.debug('OddsFeed', `filterSharpBooks(${label}): dropped ${dropped.length} high-vig books: ${dropped.map(d => d.book + '(' + d.vig + '%)').join(', ')}`);
  }
  return kept;
}

/**
 * De-vig a Double Chance 3-way market.
 * Double Chance outcomes are 1X (home or draw), X2 (draw or away), 12 (home or away).
 * Each outcome covers 2 of the 3 possible results, so fair probabilities sum to 2.0.
 * Vig-adjusted: divide each by (sum / 2).
 */
function deVigDoubleChance(p1X, pX2, p12) {
  const total = p1X + pX2 + p12;
  if (total === 0) return [0.5, 0.5, 0.5];
  const scale = total / 2;
  return [p1X / scale, pX2 / scale, p12 / scale];
}

function americanToImpliedProb(odds) {
  if (odds >= 100) return 100 / (odds + 100);
  if (odds <= -100) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 0.5;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// ALT LINES CACHE — on-demand fetched from The Odds API event endpoint
// ---------------------------------------------------------------------------
// { 'eventKey': { fetchedAt, altSpreads: { [line]: { home, away } }, altTotals: { [line]: { over, under } } } }
const altLinesCache = {};
// 10 min TTL. Earlier today this was bumped to 30 min as a latency optimization
// (fewer cache misses → fewer on-demand Odds API fetches). Real-world observation
// showed this correlated with a confirmation drought: 0 successful matches in 2
// hours after the bump, vs normal ~4% confirm rate. Stale alt lines beyond 10
// minutes apparently make our offered prices uncompetitive enough that bettors
// consistently pick other SPs. Reverted to 10 min — accepts a latency cost
// (more cache misses) in exchange for fresher prices that stay in the running.
//
// The 60s warm loop and boot pre-warm (both added in 0caa4d3) remain — they
// fetch MORE often, not less. No fill-rate risk from those.
const ALT_LINES_TTL_MS = 10 * 60 * 1000;
// Refresh-ahead window for alt-lines cache. When a cached entry is
// older than this but younger than ALT_LINES_TTL_MS, return the cached
// value AND fire a background refresh (fire-and-forget). Eliminates
// the synchronous block-on-fetch latency tail that was driving the
// pricer's price_phase2 P95 to ~40ms after Phase-C launch.
const ALT_LINES_REFRESH_AHEAD_MS = 7 * 60 * 1000;

/**
 * Fetch alternate spreads and totals for a specific event from The Odds API.
 * Uses the event-specific endpoint which supports alt markets from Pinnacle.
 */
// Cache for The Odds API event ID lookups (sport → { fetchedAt, events: [{id, home, away}] })
const oddsApiEventIdCache = {};
const ODDS_API_EVENT_ID_TTL_MS = 30 * 60 * 1000; // 30 min

// Team-name aliases for SharpAPI's Kalshi-style abbreviations. Keys are
// the NORMALIZED form of the SharpAPI name (lowercased, accent-stripped,
// punctuation removed by normalizeTeamName). Values are the canonical
// full names as they appear in The Odds API events feed (also normalized).
//
// Only add entries here for abbreviations that our generic matcher
// (exact / substring / last-N-words) can't resolve. Observed real-world
// failures from /alt-lines-stats unmatchedSamples.
const ODDS_API_TEAM_ALIASES = {
  // MLB — SharpAPI uses compressed forms when a feed falls back to Kalshi
  'chicago ws': 'chicago white sox',
  'as': 'oakland athletics',         // "A's" → normalized "as" → needs mapping
  'oakland as': 'oakland athletics', // belt-and-suspenders
  'bos red sox': 'boston red sox',   // SharpAPI occasionally uses city-abbreviation form
  // NHL city-abbreviation overrides — mirrors TEAM_NAME_OVERRIDES in
  // line-manager.js for the reverse direction. Kept in sync so warming
  // succeeds even when SharpAPI uses the abbreviation form.
  'was capitals': 'washington capitals',
  'cbj blue jackets': 'columbus blue jackets',
  'mtl canadiens': 'montreal canadiens',
  'nj devils': 'new jersey devils',
  'sj sharks': 'san jose sharks',
  'la kings': 'los angeles kings',
};

function applyTeamAlias(normalizedName) {
  return ODDS_API_TEAM_ALIASES[normalizedName] || normalizedName;
}

/**
 * Resolve The Odds API event ID for a given home/away pair.
 * SharpAPI event IDs are NOT The Odds API event IDs, so we must look up
 * the event list from The Odds API and match by team name.
 *
 * Previously used naive toLowerCase().trim() for matching, which silently
 * failed on accented names ("Montréal Canadiens" vs "Montreal Canadiens"),
 * abbreviations ("LA Clippers" vs "Los Angeles Clippers"), and compressed
 * forms ("NY Yankees" vs "New York Yankees"). Evidence: /alt-lines-stats
 * showed 0-of-10 warm fetches succeeding for NHL/MLB candidates.
 *
 * @param {string} targetTime optional ISO — disambiguates doubleheaders.
 */
async function resolveOddsApiEventId(sport, homeTeam, awayTeam, targetTime) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return null;

  const oddsApiSportMap = {
    'basketball_nba': 'basketball_nba',
    'basketball_ncaab': 'basketball_ncaab',
    'basketball_wnba': 'basketball_wnba',
    'baseball_mlb': 'baseball_mlb',
    'icehockey_nhl': 'icehockey_nhl',
    'soccer_usa_mls': 'soccer_usa_mls',
    'soccer_epl': 'soccer_epl',
    'soccer_spain_la_liga': 'soccer_spain_la_liga',
    'soccer_germany_bundesliga': 'soccer_germany_bundesliga',
    'soccer_italy_serie_a': 'soccer_italy_serie_a',
    'soccer_france_ligue_one': 'soccer_france_ligue_one',
    // TOA renamed 'soccer_uefa_champions' → 'soccer_uefa_champs_league'
    // at some point. The old key now returns "UNKNOWN_SPORT" 404,
    // breaking event-ID resolution for every UCL candidate. Fixed
    // 2026-05-05.
    'soccer_uefa_champs_league': 'soccer_uefa_champs_league',
    'soccer_uefa_europa_league': 'soccer_uefa_europa_league',
    // MMA: SharpAPI is moneyline-only and the DK scraper occasionally
    // misses Total Rounds for fights that aren't on /leagues/mma/ufc
    // (Bellator/PFL/regional cards, or UFC fights that lazy-loaded
    // poorly). Enabling event-ID resolution lets fetchAltLines pull
    // totals from TOA's mma_mixed_martial_arts feed (Pinnacle+DK+FD)
    // so getFairProbAsync can backstop Total Rounds quotes.
    'mma_mixed_martial_arts': 'mma_mixed_martial_arts',
    // Football (added 2026-08-12): required for the H1 per-event supplement
    // (supplementH1Markets) to resolve TOA event ids — absent keys made it
    // count every football event as a matchFail and attach nothing. Also
    // enables on-demand TOA alt-line fetches for football (PX posts alt
    // spreads/totals the primary book allowlist doesn't carry).
    'americanfootball_nfl_preseason': 'americanfootball_nfl_preseason',
    'americanfootball_nfl': 'americanfootball_nfl',
    'americanfootball_ncaaf': 'americanfootball_ncaaf',
  };
  // Dynamic sports (e.g. tennis) use tournament-specific Odds API keys that
  // rotate over time. For these, we discover active tournaments and fetch
  // events per tournament, tagging each event with its own sport key. Static
  // sports use the map above directly.
  const fallback = ODDS_API_FALLBACK[sport];
  const isDynamic = !!(fallback && fallback.dynamic && fallback.sportPrefix);
  const oddsApiSport = oddsApiSportMap[sport];
  if (!oddsApiSport && !isDynamic) return null;

  // Check cache
  const cached = oddsApiEventIdCache[sport];
  if (!cached || (Date.now() - cached.fetchedAt) > ODDS_API_EVENT_ID_TTL_MS) {
    try {
      let events = [];
      if (isDynamic) {
        // Discover active tournaments, then fetch events for each. Tag each
        // event with its tournament sport key so fetchAltLines can build the
        // correct /v4/sports/{key}/events/{id}/odds URL.
        const sportsResp = await abortableFetch(
          `https://api.the-odds-api.com/v4/sports/?apiKey=${theOddsApiKey}`
        );
        if (!sportsResp.ok) {
          log.warn('OddsFeed', `Odds API sports list failed (${sportsResp.status}) for ${sport}`);
          return null;
        }
        const allSports = await sportsResp.json();
        let active = allSports.filter(s => s.key.startsWith(fallback.sportPrefix) && s.active);
        // Mirror fetchDynamicSports' curation (line ~2144): without it this
        // event-ID discovery fans out to EVERY active soccer_* key (~35 in club
        // season) — 35 sequential /events fetches per resolve, several timing
        // out, which bogs down the refresh cycle and leaves the generic 'soccer'
        // (World Cup) cache perpetually stale. Restrict to the allowlisted keys,
        // and drop keys that have their own dedicated non-flip-gated fallback
        // entry (already discovered under their own cache slot).
        if (typeof fallback.keyAllowlist === 'function') {
          const allow = fallback.keyAllowlist();
          active = active.filter(s => allow.has(s.key)
            && !(ODDS_API_FALLBACK[s.key] && !ODDS_API_FALLBACK[s.key].flipGated));
        }
        for (const t of active) {
          try {
            const r = await abortableFetch(
              `https://api.the-odds-api.com/v4/sports/${t.key}/events?apiKey=${theOddsApiKey}`
            );
            if (!r.ok) continue;
            const data = await r.json();
            for (const e of (data || [])) {
              events.push({
                id: e.id,
                home: e.home_team,
                away: e.away_team,
                commence: e.commence_time,
                oddsApiSport: t.key,
              });
            }
          } catch (err) {
            log.warn('OddsFeed', `Odds API events fetch failed for ${t.key}: ${err.message}`);
          }
        }
        log.debug('OddsFeed', `Cached ${events.length} Odds API event IDs across ${active.length} ${sport} tournaments`);
      } else {
        // Static path — single sport key
        const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/events?apiKey=${theOddsApiKey}`;
        const resp = await abortableFetch(url);
        if (!resp.ok) {
          log.warn('OddsFeed', `Odds API events list failed (${resp.status}) for ${sport}`);
          return null;
        }
        const data = await resp.json();
        events = (data || []).map(e => ({
          id: e.id,
          home: e.home_team,
          away: e.away_team,
          commence: e.commence_time,
          oddsApiSport,
        }));
        log.debug('OddsFeed', `Cached ${events.length} Odds API event IDs for ${sport}`);
      }
      oddsApiEventIdCache[sport] = { fetchedAt: Date.now(), events };
    } catch (err) {
      log.warn('OddsFeed', `Odds API events list error for ${sport}: ${err.message}`);
      return null;
    }
  }

  // Robust team-name matcher — handles accents, abbreviations, word-tail
  // equality. Matches the strategy used elsewhere in the codebase
  // (line-manager.js matchTeamName) rather than the naive substring we had.
  function teamsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Substring (handles "Rays" vs "Tampa Bay Rays")
    if (a.includes(b) || b.includes(a)) return true;
    const aWords = a.split(/\s+/);
    const bWords = b.split(/\s+/);
    // Last-2-words equality (handles "Red Sox" vs "Boston Red Sox",
    // "White Sox" vs "Chicago White Sox" — disambiguates two Sox teams)
    if (aWords.length >= 2 && bWords.length >= 2) {
      const aT = aWords.slice(-2).join(' ');
      const bT = bWords.slice(-2).join(' ');
      if (aT === bT && aT.length >= 5) return true;
    }
    // Last-word equality (handles "LA Clippers" vs "Los Angeles Clippers",
    // "NY Yankees" vs "New York Yankees"). Require ≥4 chars to avoid "fc"
    // / "sc" / "utd" false positives on soccer clubs.
    const aLast = aWords[aWords.length - 1];
    const bLast = bWords[bWords.length - 1];
    if (aLast && bLast && aLast === bLast && aLast.length >= 4) return true;
    return false;
  }

  // Normalize then apply alias map. Alias maps known SharpAPI abbreviations
  // (e.g. "chicago ws") to canonical Odds API names (e.g. "chicago white sox")
  // so the downstream exact/substring/word-tail matcher can resolve them.
  // Applied to BOTH sides — if either side happens to use the abbreviation,
  // the match still succeeds.
  const normHome = applyTeamAlias(normalizeTeamName(homeTeam));
  const normAway = applyTeamAlias(normalizeTeamName(awayTeam));
  const events = oddsApiEventIdCache[sport]?.events || [];
  const matches = [];
  for (const e of events) {
    const eHome = applyTeamAlias(normalizeTeamName(e.home));
    const eAway = applyTeamAlias(normalizeTeamName(e.away));
    // SharpAPI and The Odds API occasionally disagree on which team is home
    // (observed: Chicago White Sox @ Athletics, Blue Jays @ Diamondbacks —
    // the two feeds flip the designation). Same physical game either way, so
    // match in either orientation. Orientation doesn't affect alt-line data
    // because the alt-line cache is keyed by the event ID we return.
    const straight = teamsMatch(eHome, normHome) && teamsMatch(eAway, normAway);
    const flipped  = teamsMatch(eHome, normAway) && teamsMatch(eAway, normHome);
    if (straight || flipped) {
      matches.push(e);
    }
  }

  if (matches.length === 0) {
    log.debug('OddsFeed', `No Odds API event match for ${homeTeam} vs ${awayTeam} in ${sport} (${events.length} candidates)`);
    return null;
  }

  // Disambiguate by commence time when multiple candidates (doubleheaders
  // or back-to-back same-matchup events). Pick the one closest to the
  // target time; if no target, default to first match.
  let chosen = matches[0];
  if (targetTime && matches.length > 1) {
    const targetMs = new Date(targetTime).getTime();
    if (!isNaN(targetMs)) {
      chosen = matches.reduce((best, e) => {
        const bMs = new Date(best.commence).getTime();
        const eMs = new Date(e.commence).getTime();
        if (isNaN(eMs)) return best;
        if (isNaN(bMs)) return e;
        return Math.abs(eMs - targetMs) < Math.abs(bMs - targetMs) ? e : best;
      }, matches[0]);
    }
  }

  // For dynamic sports, each cached event carries its own tournament sport
  // key. Fall back to the static map value for non-dynamic sports.
  return { eventId: chosen.id, oddsApiSport: chosen.oddsApiSport || oddsApiSport };
}

async function fetchAltLines(sport, homeTeam, awayTeam, targetTime) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return null;

  const key = normalizeEventKey(homeTeam, awayTeam);

  // Refresh-ahead check on cache.
  //   age < REFRESH_AHEAD     → return cached, no refresh
  //   REFRESH_AHEAD ≤ age < TTL → return cached AND fire background refresh
  //   age ≥ TTL                → cache miss; do the fetch synchronously
  // The 'refreshing' bool gates concurrent refreshes for the same key
  // so 5 simultaneous RFQs hitting a stale entry only spawn ONE refresh.
  const cached = altLinesCache[key];
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < ALT_LINES_REFRESH_AHEAD_MS) return cached;
    if (age < ALT_LINES_TTL_MS) {
      if (!cached.refreshing) {
        cached.refreshing = true;
        // Fire-and-forget background refresh that bypasses the cache
        // gate via the internal _doAltLinesFetch helper. Result writes
        // back into altLinesCache directly. Refreshing flag clears in
        // finally{} so even on failure we don't deadlock.
        Promise.resolve().then(() =>
          _doAltLinesFetch(sport, homeTeam, awayTeam, targetTime, key)
            .catch(err => log.warn('OddsFeed', `Alt-lines bg refresh failed for ${key}: ${err.message}`))
            .finally(() => {
              const c = altLinesCache[key];
              if (c) c.refreshing = false;
            })
        );
      }
      return cached;
    }
  }
  return _doAltLinesFetch(sport, homeTeam, awayTeam, targetTime, key);
}

// Internal: actual TOA alt-lines fetch + cache write. Called by both
// the synchronous block-on-miss path and the background refresh-ahead
// path inside fetchAltLines. Bypasses any cache gate — caller is
// responsible for deciding when to invoke.
async function _doAltLinesFetch(sport, homeTeam, awayTeam, targetTime, key) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return null;

  // Resolve The Odds API event ID (SharpAPI IDs are different). targetTime
  // disambiguates same-matchup doubleheaders / back-to-backs.
  const resolved = await resolveOddsApiEventId(sport, homeTeam, awayTeam, targetTime);
  if (!resolved) {
    log.debug('OddsFeed', `Cannot fetch alt lines for ${homeTeam} vs ${awayTeam}: no Odds API event ID`);
    return null;
  }
  const { eventId, oddsApiSport } = resolved;

  // MLB events get F5 alt markets appended. PX registers F5 alt total
  // lines (3, 3.5, 4, 5, 5.5) that the bulk supplement doesn't cover
  // — without these, every off-primary F5 total RFQ declines with
  // "no totals_f5 quote".
  const mlbF5Markets = sport === 'baseball_mlb'
    ? ',alternate_spreads_1st_5_innings,alternate_totals_1st_5_innings'
    : '';
  // NBA H1 alt markets. PX RFQs occasionally include integer first-half
  // spreads (e.g. OKC -6 first_half_spread) that no book's PRIMARY h1
  // line carries — main books only quote half-points (-5.5, -6.5) on
  // h1 to avoid pushes. Pinnacle and Bovada DO carry integer h1 alts
  // for select lines via alternate_spreads_h1 / alternate_totals_h1.
  // H2 deliberately NOT included: H2 lines come back on the board at
  // halftime and move very fast live; cache TTL is too long to keep
  // up with halftime volatility, risking stale-quote losses.
  const nbaH1Markets = sport === 'basketball_nba'
    ? ',alternate_spreads_h1,alternate_totals_h1'
    : '';
  // Include the PRIMARY totals market alongside alternate_totals so lines
  // that are a book's primary (e.g. Pinnacle's integer MLB 8) — and thus
  // not listed in alternate_totals — still land in the altTotals cache.
  // Books that skip integer totals in their alt list won't cover Over 8
  // otherwise.
  //
  // MMA: TOA's mma_mixed_martial_arts feed exposes Total Rounds via the
  // standard `totals` market key but doesn't carry alternate_spreads /
  // alternate_totals (MMA has no spreads, and total-rounds alts aren't
  // a TOA market type). Requesting them returns 422 INVALID_MARKET, so
  // we trim to just `totals` for MMA.
  const isMma = sport === 'mma_mixed_martial_arts';
  const marketsParam = isMma
    ? 'totals'
    : `totals,alternate_spreads,alternate_totals${mlbF5Markets}${nbaH1Markets}`;
  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/events/${eventId}/odds`
    + `?apiKey=${theOddsApiKey}`
    + `&regions=us,eu`
    + `&markets=${marketsParam}`
    + `&bookmakers=${ALT_LINES_BOOKMAKERS}`
    + `&oddsFormat=american`;

  log.info('OddsFeed', `Fetching alt lines for ${homeTeam} vs ${awayTeam}...`);

  try {
    const resp = await abortableFetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      log.warn('OddsFeed', `Alt lines fetch failed (${resp.status}): ${text.substring(0, 100)}`);
      return null;
    }

    const data = await resp.json();
    // refreshing:false on every fresh write so the refresh-ahead gate
    // in fetchAltLines treats the new entry as "not currently being
    // refreshed" — without this flag the recursive bg refresh path
    // could see leftover refreshing=true and skip subsequent refreshes.
    const result = { fetchedAt: Date.now(), refreshing: false, altSpreads: {}, altTotals: {}, altSpreadsF5: {}, altTotalsF5: {}, altSpreadsH1: {}, altTotalsH1: {} };

    for (const book of (data.bookmakers || [])) {
      for (const market of (book.markets || [])) {
        if (market.key === 'alternate_spreads_1st_5_innings') {
          // F5 alt spreads. Same signed-home-point keying as full-game
          // alternate_spreads. Reuses the home/away team-name matching
          // block just below via a helper to avoid duplication.
          for (const o of (market.outcomes || [])) {
            const normOutcome = normalizeTeamName(o.name);
            const normHome = normalizeTeamName(homeTeam);
            const normAway = normalizeTeamName(awayTeam);
            const normDataHome = data.home_team ? normalizeTeamName(data.home_team) : '';
            const homeMatch = normOutcome === normHome || normOutcome === normDataHome
              || normHome.includes(normOutcome) || normOutcome.includes(normHome)
              || (normDataHome && (normDataHome.includes(normOutcome) || normOutcome.includes(normDataHome)));
            const awayMatch = normOutcome === normAway
              || normAway.includes(normOutcome) || normOutcome.includes(normAway);
            if (homeMatch === awayMatch) continue;
            const isHome = homeMatch;
            const homePoint = isHome ? o.point : -o.point;
            const lineKey = String(homePoint);
            if (!result.altSpreadsF5[lineKey]) {
              result.altSpreadsF5[lineKey] = { probs: [], books: new Set(), byBook: {}, homePoint };
            }
            const prob = americanToImpliedProb(o.price);
            result.altSpreadsF5[lineKey].probs.push({ isHome, prob, point: o.point });
            result.altSpreadsF5[lineKey].books.add(book.key);
            if (!result.altSpreadsF5[lineKey].byBook[book.key]) result.altSpreadsF5[lineKey].byBook[book.key] = {};
            result.altSpreadsF5[lineKey].byBook[book.key][isHome ? 'home' : 'away'] = o.price;
          }
          continue;
        }
        if (market.key === 'alternate_totals_1st_5_innings') {
          for (const o of (market.outcomes || [])) {
            const lineKey = o.point;
            if (!result.altTotalsF5[lineKey]) {
              result.altTotalsF5[lineKey] = { probs: [], books: new Set(), byBook: {} };
            }
            const isOver = o.name === 'Over';
            const prob = americanToImpliedProb(o.price);
            result.altTotalsF5[lineKey].probs.push({ isOver, prob });
            result.altTotalsF5[lineKey].books.add(book.key);
            if (!result.altTotalsF5[lineKey].byBook[book.key]) result.altTotalsF5[lineKey].byBook[book.key] = {};
            result.altTotalsF5[lineKey].byBook[book.key][isOver ? 'over' : 'under'] = o.price;
          }
          continue;
        }
        if (market.key === 'alternate_spreads_h1') {
          // NBA H1 alt spreads. Same signed-home-point keying as full-game
          // alternate_spreads. Routed to altSpreadsH1 so consumers querying
          // marketType='spreads_h1' don't collide with full-game alts.
          for (const o of (market.outcomes || [])) {
            const normOutcome = normalizeTeamName(o.name);
            const normHome = normalizeTeamName(homeTeam);
            const normAway = normalizeTeamName(awayTeam);
            const normDataHome = data.home_team ? normalizeTeamName(data.home_team) : '';
            const homeMatch = normOutcome === normHome || normOutcome === normDataHome
              || normHome.includes(normOutcome) || normOutcome.includes(normHome)
              || (normDataHome && (normDataHome.includes(normOutcome) || normOutcome.includes(normDataHome)));
            const awayMatch = normOutcome === normAway
              || normAway.includes(normOutcome) || normOutcome.includes(normAway);
            if (homeMatch === awayMatch) continue;
            const isHome = homeMatch;
            const homePoint = isHome ? o.point : -o.point;
            const lineKey = String(homePoint);
            if (!result.altSpreadsH1[lineKey]) {
              result.altSpreadsH1[lineKey] = { probs: [], books: new Set(), byBook: {}, homePoint };
            }
            const prob = americanToImpliedProb(o.price);
            result.altSpreadsH1[lineKey].probs.push({ isHome, prob, point: o.point });
            result.altSpreadsH1[lineKey].books.add(book.key);
            if (!result.altSpreadsH1[lineKey].byBook[book.key]) result.altSpreadsH1[lineKey].byBook[book.key] = {};
            result.altSpreadsH1[lineKey].byBook[book.key][isHome ? 'home' : 'away'] = o.price;
          }
          continue;
        }
        if (market.key === 'alternate_totals_h1') {
          for (const o of (market.outcomes || [])) {
            const lineKey = o.point;
            if (!result.altTotalsH1[lineKey]) {
              result.altTotalsH1[lineKey] = { probs: [], books: new Set(), byBook: {} };
            }
            const isOver = o.name === 'Over';
            const prob = americanToImpliedProb(o.price);
            result.altTotalsH1[lineKey].probs.push({ isOver, prob });
            result.altTotalsH1[lineKey].books.add(book.key);
            if (!result.altTotalsH1[lineKey].byBook[book.key]) result.altTotalsH1[lineKey].byBook[book.key] = {};
            result.altTotalsH1[lineKey].byBook[book.key][isOver ? 'over' : 'under'] = o.price;
          }
          continue;
        }
        if (market.key === 'alternate_spreads') {
          // CRITICAL: key by SIGNED home point, not abs. Otherwise both
          // "home -1.5 / away +1.5" and "home +1.5 / away -1.5" (two
          // distinct bets) collapse into the same bucket[1.5], letting
          // the last-written byBook price overwrite the other direction.
          //
          // The observed-in-production bug: FanDuel's "Bournemouth -1.5"
          // (heavy underdog winning by 2+, +1500) overwrote its
          // "Bournemouth +1.5" (underdog getting 1.5, should be ~-140)
          // in the abs-keyed bucket, dragging consensus fair ~15pp below
          // Pinnacle and producing a +461 quote where the true parlay
          // price was +287. Sign flips on spread alts are dangerous —
          // keep the two directions strictly separate.
          for (const o of (market.outcomes || [])) {
            // Use fuzzy matching for team names — exact match fails when
            // The Odds API returns a slightly different name (e.g.,
            // "LA Clippers" vs "Los Angeles Clippers"). A silent mismatch
            // would flip EVERY home_point sign in the cache, catastrophically
            // swapping home/away probs for all alt spreads in this game.
            const normOutcome = normalizeTeamName(o.name);
            const normHome = normalizeTeamName(homeTeam);
            const normAway = normalizeTeamName(awayTeam);
            const normDataHome = data.home_team ? normalizeTeamName(data.home_team) : '';
            const homeMatch = normOutcome === normHome || normOutcome === normDataHome
              || normHome.includes(normOutcome) || normOutcome.includes(normHome)
              || (normDataHome && (normDataHome.includes(normOutcome) || normOutcome.includes(normDataHome)));
            const awayMatch = normOutcome === normAway
              || normAway.includes(normOutcome) || normOutcome.includes(normAway);
            // If both or neither side matches, skip — ambiguous classification
            // would silently flip signs on every alt spread for this game.
            if (homeMatch === awayMatch) {
              if (homeMatch) log.warn('OddsFeed', `Alt spread ambiguous team: "${o.name}" matches both home "${homeTeam}" and away "${awayTeam}" — skipping outcome`);
              continue;
            }
            const isHome = homeMatch;
            // Compute home_point: the signed spread from the HOME team's
            // perspective. For a home outcome it's just o.point; for an
            // away outcome it's the negation (same bet, opposite side).
            const homePoint = isHome ? o.point : -o.point;
            const lineKey = String(homePoint); // signed string key: "-1.5", "1.5", "0", etc.
            if (!result.altSpreads[lineKey]) {
              result.altSpreads[lineKey] = { probs: [], books: new Set(), byBook: {}, homePoint };
            }
            const prob = americanToImpliedProb(o.price);
            result.altSpreads[lineKey].probs.push({ isHome, prob, point: o.point });
            result.altSpreads[lineKey].books.add(book.key);
            // Per-book raw odds so the dashboard can display actual
            // Pinnacle/DK/FD values for this specific alt line.
            if (!result.altSpreads[lineKey].byBook[book.key]) {
              result.altSpreads[lineKey].byBook[book.key] = {};
            }
            result.altSpreads[lineKey].byBook[book.key][isHome ? 'home' : 'away'] = o.price;
          }
        } else if (market.key === 'alternate_totals' || market.key === 'totals') {
          // `totals` is each book's primary; `alternate_totals` is its alts.
          // Merged into the same altTotals map since consumers (getFairProb)
          // don't care whether a line is a book's primary or alt — only that
          // we have enough book coverage to de-vig. Adding `totals` here is
          // what surfaces integer MLB totals that skip alternate_totals on
          // many US books (e.g. Pinnacle's primary MLB total is integer 8,
          // and it's NOT re-listed in Pinnacle's alternate_totals).
          for (const o of (market.outcomes || [])) {
            const lineKey = o.point;
            if (!result.altTotals[lineKey]) {
              result.altTotals[lineKey] = { probs: [], books: new Set(), byBook: {} };
            }
            const isOver = o.name === 'Over';
            const prob = americanToImpliedProb(o.price);
            result.altTotals[lineKey].probs.push({ isOver, prob });
            result.altTotals[lineKey].books.add(book.key);
            if (!result.altTotals[lineKey].byBook[book.key]) {
              result.altTotals[lineKey].byBook[book.key] = {};
            }
            result.altTotals[lineKey].byBook[book.key][isOver ? 'over' : 'under'] = o.price;
          }
        }
      }
    }

    // De-vig each line — require minimum number of books for accuracy.
    // Preserve byBook raw odds through the consolidation so per-book
    // accessors can look up the exact alt line even when consensus is too
    // thin to de-vig.
    // Accept gate: ≥ MIN_BOOKS, OR Pinnacle alone (sharp enough to trust).
    const hasPinnacle = (byBook) => !!byBook.pinnacle;
    const bookCountOk = (bookCount, byBook) =>
      bookCount >= ALT_LINES_MIN_BOOKS ||
      (ALT_LINES_PINNACLE_ALONE_OK && bookCount >= 1 && hasPinnacle(byBook));

    let skippedThinSpreads = 0, skippedThinTotals = 0;
    for (const [lineKey, lineData] of Object.entries(result.altSpreads)) {
      const bookCount = lineData.books.size;
      const byBook = lineData.byBook;
      const homeProbs = lineData.probs.filter(p => p.isHome).map(p => p.prob);
      const awayProbs = lineData.probs.filter(p => !p.isHome).map(p => p.prob);
      if (homeProbs.length > 0 && awayProbs.length > 0 && bookCountOk(bookCount, byBook)) {
        const [fh, fa] = deVig2Way(avg(homeProbs), avg(awayProbs));
        result.altSpreads[lineKey] = { home: fh, away: fa, books: bookCount, byBook };
      } else {
        if (homeProbs.length > 0 && awayProbs.length > 0) skippedThinSpreads++;
        // Keep a stub with only byBook so accessors can still return per-book
        // raw odds even when the consensus is too thin to de-vig.
        if (Object.keys(byBook).length > 0) {
          result.altSpreads[lineKey] = { home: null, away: null, books: bookCount, byBook };
        } else {
          delete result.altSpreads[lineKey];
        }
      }
    }

    for (const [lineKey, lineData] of Object.entries(result.altTotals)) {
      const bookCount = lineData.books.size;
      const byBook = lineData.byBook;
      const overProbs = lineData.probs.filter(p => p.isOver).map(p => p.prob);
      const underProbs = lineData.probs.filter(p => !p.isOver).map(p => p.prob);
      if (overProbs.length > 0 && underProbs.length > 0 && bookCountOk(bookCount, byBook)) {
        const [fo, fu] = deVig2Way(avg(overProbs), avg(underProbs));
        result.altTotals[lineKey] = { over: fo, under: fu, books: bookCount, byBook };
      } else {
        if (overProbs.length > 0 && underProbs.length > 0) skippedThinTotals++;
        if (Object.keys(byBook).length > 0) {
          result.altTotals[lineKey] = { over: null, under: null, books: bookCount, byBook };
        } else {
          delete result.altTotals[lineKey];
        }
      }
    }

    // F5 alt spreads + totals (MLB only). Identical consolidation as
    // the full-game loops above — de-vig per line with the same
    // min-books + Pinnacle-alone gate, keep byBook stubs for missing
    // consensus so per-book accessors still resolve.
    //
    // PINNACLE PREFERENCE (added 2026-05-11): when Pinnacle is in byBook
    // with both sides, de-vig from Pinnacle ALONE rather than averaging
    // probs across every book TheOddsAPI returned. Root cause for the
    // F5 RL mispricing: recreational books (BetMGM, BetRivers, etc.)
    // often disagree with Pinnacle by 5-10pp on F5 spreads — likely
    // because they model F5-specific starter-pitcher dynamics differently
    // — and the wide-book average drags fair toward 50/50, sometimes
    // inverting the favorite direction (e.g. TBR @ TOR: Pin had TOR -0.5
    // de-vig at 54.8% fair, but multi-book average pulled it to 44.66%).
    // Pinnacle is our authoritative sharp signal; mirror what the primary
    // feed's buildConsensusSpread already does via filterSharpBooks +
    // Pinnacle floor. Falls back to multi-book average when Pin is absent.
    const altPinAlone = (byBook) => {
      const p = byBook && byBook.pinnacle;
      if (!p || p.home == null || p.away == null) return null;
      const ph = americanToImpliedProb(p.home);
      const pa = americanToImpliedProb(p.away);
      if (ph == null || pa == null) return null;
      return deVig2Way(ph, pa);
    };
    const altPinAloneTotal = (byBook) => {
      const p = byBook && byBook.pinnacle;
      if (!p || p.over == null || p.under == null) return null;
      const po = americanToImpliedProb(p.over);
      const pu = americanToImpliedProb(p.under);
      if (po == null || pu == null) return null;
      return deVig2Way(po, pu);
    };
    for (const [lineKey, lineData] of Object.entries(result.altSpreadsF5)) {
      const bookCount = lineData.books.size;
      const byBook = lineData.byBook;
      const homeProbs = lineData.probs.filter(p => p.isHome).map(p => p.prob);
      const awayProbs = lineData.probs.filter(p => !p.isHome).map(p => p.prob);
      if (homeProbs.length > 0 && awayProbs.length > 0 && bookCountOk(bookCount, byBook)) {
        const pinPair = altPinAlone(byBook);
        const [fh, fa] = pinPair || deVig2Way(avg(homeProbs), avg(awayProbs));
        result.altSpreadsF5[lineKey] = { home: fh, away: fa, books: bookCount, byBook };
      } else if (Object.keys(byBook).length > 0) {
        result.altSpreadsF5[lineKey] = { home: null, away: null, books: bookCount, byBook };
      } else {
        delete result.altSpreadsF5[lineKey];
      }
    }
    for (const [lineKey, lineData] of Object.entries(result.altTotalsF5)) {
      const bookCount = lineData.books.size;
      const byBook = lineData.byBook;
      const overProbs = lineData.probs.filter(p => p.isOver).map(p => p.prob);
      const underProbs = lineData.probs.filter(p => !p.isOver).map(p => p.prob);
      if (overProbs.length > 0 && underProbs.length > 0 && bookCountOk(bookCount, byBook)) {
        const pinPair = altPinAloneTotal(byBook);
        const [fo, fu] = pinPair || deVig2Way(avg(overProbs), avg(underProbs));
        result.altTotalsF5[lineKey] = { over: fo, under: fu, books: bookCount, byBook };
      } else if (Object.keys(byBook).length > 0) {
        result.altTotalsF5[lineKey] = { over: null, under: null, books: bookCount, byBook };
      } else {
        delete result.altTotalsF5[lineKey];
      }
    }
    // NBA H1 alt spreads + totals. Same consolidation as the F5 loops —
    // de-vig per line with the same min-books + Pinnacle-alone gate, keep
    // byBook stubs for missing consensus so per-book accessors still resolve.
    // Same Pinnacle-preference as F5 above.
    for (const [lineKey, lineData] of Object.entries(result.altSpreadsH1)) {
      const bookCount = lineData.books.size;
      const byBook = lineData.byBook;
      const homeProbs = lineData.probs.filter(p => p.isHome).map(p => p.prob);
      const awayProbs = lineData.probs.filter(p => !p.isHome).map(p => p.prob);
      if (homeProbs.length > 0 && awayProbs.length > 0 && bookCountOk(bookCount, byBook)) {
        const pinPair = altPinAlone(byBook);
        const [fh, fa] = pinPair || deVig2Way(avg(homeProbs), avg(awayProbs));
        result.altSpreadsH1[lineKey] = { home: fh, away: fa, books: bookCount, byBook };
      } else if (Object.keys(byBook).length > 0) {
        result.altSpreadsH1[lineKey] = { home: null, away: null, books: bookCount, byBook };
      } else {
        delete result.altSpreadsH1[lineKey];
      }
    }
    for (const [lineKey, lineData] of Object.entries(result.altTotalsH1)) {
      const bookCount = lineData.books.size;
      const byBook = lineData.byBook;
      const overProbs = lineData.probs.filter(p => p.isOver).map(p => p.prob);
      const underProbs = lineData.probs.filter(p => !p.isOver).map(p => p.prob);
      if (overProbs.length > 0 && underProbs.length > 0 && bookCountOk(bookCount, byBook)) {
        const pinPair = altPinAloneTotal(byBook);
        const [fo, fu] = pinPair || deVig2Way(avg(overProbs), avg(underProbs));
        result.altTotalsH1[lineKey] = { over: fo, under: fu, books: bookCount, byBook };
      } else if (Object.keys(byBook).length > 0) {
        result.altTotalsH1[lineKey] = { over: null, under: null, books: bookCount, byBook };
      } else {
        delete result.altTotalsH1[lineKey];
      }
    }

    altLinesCache[key] = result;
    const skippedNote = (skippedThinSpreads + skippedThinTotals) > 0 ? ` (skipped ${skippedThinSpreads} spreads + ${skippedThinTotals} totals with <${ALT_LINES_MIN_BOOKS} books)` : '';
    const f5Note = (Object.keys(result.altSpreadsF5).length || Object.keys(result.altTotalsF5).length) > 0
      ? `, F5: ${Object.keys(result.altSpreadsF5).length} spreads + ${Object.keys(result.altTotalsF5).length} totals`
      : '';
    const h1Note = (Object.keys(result.altSpreadsH1).length || Object.keys(result.altTotalsH1).length) > 0
      ? `, H1: ${Object.keys(result.altSpreadsH1).length} spreads + ${Object.keys(result.altTotalsH1).length} totals`
      : '';
    log.info('OddsFeed', `Cached alt lines: ${Object.keys(result.altSpreads).length} spreads, ${Object.keys(result.altTotals).length} totals${f5Note}${h1Note}${skippedNote}`);
    return result;
  } catch (err) {
    log.error('OddsFeed', `Alt lines error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// ALT LINES PRE-WARMING — speculatively fetch alt lines for all registered
// events so on-demand fetch during RFQ is rare. This moves the latency cost
// off the critical path.
// ---------------------------------------------------------------------------

// Sports that publish alt spread/total markets on The Odds API AND
// are safe to aggressively pre-warm at every odds refresh cycle.
// Tennis stays in (thin alt coverage but cheap to fetch; helps RFQs
// on non-primary sets).
//
// 2026-04-22: major soccer leagues added to pre-warm. Soccer alt-line
// on-demand fetches were the single biggest remaining contributor to
// `decline → price` p95 latency (50-500ms on first RFQ per event
// before the on-demand populated the cache). Pre-warming moves that
// cost from the RFQ hot path to the 30s background refresh loop,
// bringing soccer alt RFQs from ~200ms p50 to near-zero.
//
// Minor/niche soccer leagues (Liga MX, Brasileirão, Libertadores,
// NWSL) stay on-demand only to cap API cost — flow there is thin
// and the pre-warm quota would mostly be wasted. Strict-safety
// gating still applies to ALL soccer (see isStrictAltSanitySport).
const SPORTS_WITH_ALT_MARKETS = new Set([
  'basketball_nba', 'basketball_ncaab', 'basketball_wnba',
  'baseball_mlb',
  'icehockey_nhl',
  'americanfootball_nfl', 'americanfootball_ncaaf',
  'tennis',
  // Major soccer leagues — pre-warmed as of 2026-04-22
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_germany_bundesliga',
  'soccer_france_ligue_one',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_usa_mls',
]);

// Sports with strict-safety alt-line handling (tighter lineDiff
// threshold, min-book requirement, reverse sanity). These are sports
// with thin alt-line book coverage where an alt-as-primary mispricing
// would be high-impact. Soccer in particular had a history of alt-
// line confusion incidents that spawned the strict-mode safeguards.
//
// Membership is NOT tied to pre-warm state — soccer is both strict
// AND pre-warmed now. Keep this set explicit rather than deriving
// from other sets so the safety intent stays readable.
//
// Generic 'soccer' key + niche leagues stay on-demand and strict.
const SPORTS_WITH_ONDEMAND_ALT_MARKETS = new Set([
  'soccer',
  'soccer_usa_mls',
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_germany_bundesliga',
  'soccer_france_ligue_one',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  // Niche leagues: stay on-demand only (not added to pre-warm above)
  'soccer_mexico_ligamx',
  'soccer_brazil_campeonato',
  'soccer_conmebol_libertadores',
  'soccer_usa_nwsl',
]);

// True when either gate (pre-warm or on-demand) applies. Use in
// runtime code paths (getFairProb, fetchAltLines callers); use the
// narrower SPORTS_WITH_ALT_MARKETS for pre-warm scheduling only.
function sportSupportsAltLines(sport) {
  return SPORTS_WITH_ALT_MARKETS.has(sport) || SPORTS_WITH_ONDEMAND_ALT_MARKETS.has(sport);
}

// Safety-sensitive sports get tighter lineDiff sanity gates and a
// minimum-book requirement on alt-line acceptance. Mispricing an
// alt line as primary is one of the worst bug classes we've hit
// (NHL spreads, MLB totals) — soccer has the same risk profile with
// even thinner book coverage on some leagues.
function isStrictAltSanitySport(sport) {
  return SPORTS_WITH_ONDEMAND_ALT_MARKETS.has(sport);
}

// Strict-mode lineDiff threshold: if |alt_line - primary_line| >=
// this value, run the sanity check (direction makes sense, alt
// fair is within plausible range). Default is 2.0; soccer is 1.0
// because EPL goals span a narrow range (2-4 typical) so even a
// 1-goal move between primary and alt is material.
function altSanityLineDiffThreshold(sport) {
  return isStrictAltSanitySport(sport) ? 1.0 : 2.0;
}

// Maximum distance |alt - primary| we'll quote on for strict-mode
// sports. Beyond this, the alt is too far from primary to trust —
// even if the alt cache has data, the de-vig can be wildly off on
// extreme tails. Soccer cap is 3 goals (e.g. primary 2.5 max alt
// 5.5); anything beyond declines.
function altMaxLineDistance(sport) {
  return isStrictAltSanitySport(sport) ? 3.0 : Infinity;
}

// Only pre-warm events starting within this window — avoids wasting API calls
// on events days in the future that the bettor almost certainly won't RFQ.
// Operator-tunable via QUOTE_HORIZON_DAYS (config.pricing.quoteHorizonHours);
// default 48h (~same-day + next-day). Raise it to quote further out (e.g. WC).
const WARM_EVENT_MAX_HOURS_AHEAD = config.pricing.quoteHorizonHours;

// Concurrency limit: at most N alt-line fetches in flight simultaneously.
// Keeps us from burying The Odds API rate limiter.
const WARM_CONCURRENCY = 2;
// Inter-request delay inside each warm worker. The Odds API rate-limits
// (per-key token bucket) and a startup burst across sports × MLB's new
// F5 alt markets was producing 8+ "Requests are too frequent" 429s per
// warm cycle. 120ms throttle caps each worker at ~8 req/s; with
// WARM_CONCURRENCY=2 per sport and ~4 sports warming, peak is ~65 req/s
// globally — well under the Odds API ~100 req/s ceiling while still
// completing a full sport warm in under 30s.
const WARM_REQUEST_DELAY_MS = 120;

// Last warm stats (for /alt-lines-cache-stats)
let _lastWarmStats = null;

/**
 * Pre-warm alt-line cache for all registered events in a sport.
 * Skips events already fresh in cache (< ALT_LINES_TTL_MS old) to avoid
 * duplicate work. Events with commenceTime more than N hours out are
 * also skipped — bettor demand is concentrated in the next 1-2 days.
 *
 * Runs with bounded concurrency so The Odds API isn't hammered.
 */
// Sports where SharpAPI is the primary feed but occasionally returns
// events without an h2h market (e.g. books haven't posted moneylines
// yet even though spreads/totals are up). We backfill via The Odds
// API on each refresh cycle so the pricer always has a moneyline to
// quote against, at the cost of ~1 Odds API call per sport per cycle.
const H2H_BACKFILL_SPORTS = new Set(['baseball_mlb', 'basketball_nba', 'icehockey_nhl']);

/**
 * Merge DK-scraped MMA fight odds into oddsCache['mma_mixed_martial_arts'].
 * The Odds API typically only carries 2-3 of a UFC Fight Night card's ~12
 * fights; DK carries all of them. We pull the DK scraper's parsed fight
 * list and, for each fight not already in the cache (matched by fighter
 * last-word pairs), inject a new event entry with markets.h2h populated.
 * After this runs, the line-manager seed picks them up and registers
 * moneylines with PX, unlocking RFQ routing for the full card.
 */
/**
 * Pull DK's in-play markets for a sport and write them into liveOddsCache.
 * Replaces anything SharpAPI's live fetch populated (DK is preferred over
 * SharpAPI for in-play because of coverage + speed on top-4 US books).
 * Events keyed by normalized (home, away) pair so getLiveFairProb works.
 */
async function mergeDkLiveOdds(sport) {
  const dk = require('./dk-scraper');
  let live;
  try {
    live = await dk.fetchLiveMarkets(sport);
  } catch (err) {
    log.warn('OddsFeed', `DK live fetch failed for ${sport}: ${err.message}`);
    return { merged: 0, sport, err: err.message };
  }
  if (!live || !Array.isArray(live.events) || live.events.length === 0) {
    return { merged: 0, sport };
  }
  // Build events map keyed by pair, keeping arrays for doubleheaders.
  const events = {};
  for (const ev of live.events) {
    if (!ev.homeTeam || !ev.awayTeam) continue;
    const key = normalizeEventKey(ev.homeTeam, ev.awayTeam);
    // Remap markets from dk-scraper shape into what oddsFeed.getLiveFairProb expects.
    // dk-scraper emits markets: { h2h, totals: { [line]: {...}, _primary } }.
    // liveOddsCache expects the same shape as oddsCache events — we mirror it.
    const entry = {
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      commenceTime: ev.commenceTime,
      eventId: 'dk-live-' + ev.eventId,
      markets: ev.markets || {},
    };
    if (!events[key]) events[key] = [];
    events[key].push(entry);
  }
  if (!liveOddsCache[sport]) liveOddsCache[sport] = {};
  liveOddsCache[sport] = {
    fetchedAt: Date.now(),
    events,
  };
  log.info('OddsFeed', `DK live merge ${sport}: ${live.events.length} in-progress events cached`);
  return { merged: live.events.length, sport };
}

// Odds-API sport keys for the live in-play fetch. Same endpoint as pre-game —
// `commence_time < now` naturally returns in-progress events, at no extra cost.
const ODDS_API_LIVE_SPORTS = {
  basketball_nba: 'basketball_nba',
  baseball_mlb: 'baseball_mlb',
  icehockey_nhl: 'icehockey_nhl',
  americanfootball_nfl: 'americanfootball_nfl',
};

/**
 * Pull in-play markets from The Odds API (Pinnacle + DK + FD) and write them
 * into liveOddsCache in the shape getLiveFairProb expects. Replaces the DK
 * Puppeteer scraper for live odds — same coverage, no Akamai fragility, no
 * browser overhead. Same quota cost as pre-game Odds API calls.
 *
 * Filters events to in-progress (commence_time in past, <6h elapsed) before
 * writing. De-vigs each book's 2-way pair, then averages fair probs across
 * books for each market/line.
 */
async function mergeOddsApiLive(sport) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  const apiSport = ODDS_API_LIVE_SPORTS[sport];
  if (!apiKey || !apiSport) return { merged: 0, sport };

  const url = `https://api.the-odds-api.com/v4/sports/${apiSport}/odds`
    + `?apiKey=${apiKey}`
    + `&regions=us,eu`
    + `&markets=h2h,spreads,totals`
    + `&bookmakers=pinnacle,draftkings,fanduel`
    + `&oddsFormat=american`;

  let events;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn('OddsFeed', `Odds API live fetch failed (${resp.status}) for ${sport}`);
      return { merged: 0, sport };
    }
    const remaining = resp.headers.get('x-requests-remaining');
    _checkToaQuota(remaining);
    const used = resp.headers.get('x-requests-used');
    if (remaining != null) log.debug('OddsFeed', `Odds API live usage: ${used} used, ${remaining} remaining`);
    events = await resp.json();
  } catch (err) {
    log.warn('OddsFeed', `Odds API live fetch error for ${sport}: ${err.message}`);
    return { merged: 0, sport };
  }

  const now = Date.now();
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const inProgress = (events || []).filter(ev => {
    const t = ev.commence_time ? new Date(ev.commence_time).getTime() : null;
    if (!t || isNaN(t)) return false;
    const elapsed = now - t;
    return elapsed >= 0 && elapsed < SIX_HOURS_MS;
  });

  if (inProgress.length === 0) {
    return { merged: 0, sport };
  }

  const cacheEvents = {};
  for (const ev of inProgress) {
    const home = ev.home_team;
    const away = ev.away_team;
    if (!home || !away) continue;
    const markets = {};

    // --- Moneyline (h2h) ---
    const mlFair = { home: [], away: [] };
    for (const book of (ev.bookmakers || [])) {
      const m = (book.markets || []).find(x => x.key === 'h2h');
      if (!m) continue;
      const h = (m.outcomes || []).find(o => o.name === home);
      const a = (m.outcomes || []).find(o => o.name === away);
      if (!h || !a) continue;
      const hp = americanToImpliedProb(h.price);
      const ap = americanToImpliedProb(a.price);
      if (!hp || !ap) continue;
      const [fh, fa] = deVig2Way(hp, ap);
      mlFair.home.push(fh);
      mlFair.away.push(fa);
    }
    if (mlFair.home.length > 0) {
      const fh = avg(mlFair.home), fa = avg(mlFair.away);
      markets.h2h = {
        home: { fairProb: fh, displayFairProb: fh },
        away: { fairProb: fa, displayFairProb: fa },
        books: mlFair.home.length,
        source: 'odds-api-live',
      };
    }

    // --- Spreads (keyed by line magnitude) ---
    // Books may carry slightly different magnitudes (e.g. Pin -8.5, DK -9).
    // Store each magnitude as its own line entry — the consumer does an
    // exact-line lookup and falls back to `_primary` if the leg's line
    // isn't present. home/away preserve bookmaker's sign-of-home convention.
    const spreadsByLine = {};
    for (const book of (ev.bookmakers || [])) {
      const m = (book.markets || []).find(x => x.key === 'spreads');
      if (!m) continue;
      const h = (m.outcomes || []).find(o => o.name === home);
      const a = (m.outcomes || []).find(o => o.name === away);
      if (!h || !a || h.point == null || a.point == null) continue;
      const line = Math.abs(Number(h.point));
      if (!Number.isFinite(line)) continue;
      const hp = americanToImpliedProb(h.price);
      const ap = americanToImpliedProb(a.price);
      if (!hp || !ap) continue;
      const [fh, fa] = deVig2Way(hp, ap);
      if (!spreadsByLine[line]) spreadsByLine[line] = { home: [], away: [] };
      spreadsByLine[line].home.push(fh);
      spreadsByLine[line].away.push(fa);
    }
    const spreads = {};
    let spreadPrimary = null;
    let spreadPrimaryBooks = 0;
    for (const [line, bucket] of Object.entries(spreadsByLine)) {
      const fh = avg(bucket.home), fa = avg(bucket.away);
      spreads[line] = {
        line: parseFloat(line),
        home: { fairProb: fh, displayFairProb: fh },
        away: { fairProb: fa, displayFairProb: fa },
        books: bucket.home.length,
        source: 'odds-api-live',
      };
      if (bucket.home.length > spreadPrimaryBooks) {
        spreadPrimaryBooks = bucket.home.length;
        spreadPrimary = parseFloat(line);
      }
    }
    if (spreadPrimary != null) {
      spreads._primary = spreadPrimary;
      markets.spreads = spreads;
    }

    // --- Totals (keyed by line) ---
    const totalsByLine = {};
    for (const book of (ev.bookmakers || [])) {
      const m = (book.markets || []).find(x => x.key === 'totals');
      if (!m) continue;
      const ov = (m.outcomes || []).find(o => o.name === 'Over');
      const un = (m.outcomes || []).find(o => o.name === 'Under');
      if (!ov || !un || ov.point == null) continue;
      const line = Number(ov.point);
      if (!Number.isFinite(line)) continue;
      const op = americanToImpliedProb(ov.price);
      const up = americanToImpliedProb(un.price);
      if (!op || !up) continue;
      const [fo, fu] = deVig2Way(op, up);
      if (!totalsByLine[line]) totalsByLine[line] = { over: [], under: [] };
      totalsByLine[line].over.push(fo);
      totalsByLine[line].under.push(fu);
    }
    const totals = {};
    let totalsPrimary = null;
    let totalsPrimaryBooks = 0;
    for (const [line, bucket] of Object.entries(totalsByLine)) {
      const fo = avg(bucket.over), fu = avg(bucket.under);
      totals[line] = {
        line: parseFloat(line),
        over: { fairProb: fo, displayFairProb: fo },
        under: { fairProb: fu, displayFairProb: fu },
        books: bucket.over.length,
        source: 'odds-api-live',
      };
      if (bucket.over.length > totalsPrimaryBooks) {
        totalsPrimaryBooks = bucket.over.length;
        totalsPrimary = parseFloat(line);
      }
    }
    if (totalsPrimary != null) {
      totals._primary = totalsPrimary;
      markets.totals = totals;
    }

    if (!markets.h2h && !markets.spreads && !markets.totals) continue;

    const key = normalizeEventKey(home, away);
    const entry = {
      homeTeam: home,
      awayTeam: away,
      commenceTime: ev.commence_time,
      eventId: 'oddsapi-live-' + ev.id,
      markets,
    };
    if (!cacheEvents[key]) cacheEvents[key] = [];
    cacheEvents[key].push(entry);
  }

  const evCount = Object.values(cacheEvents).reduce((s, arr) => s + arr.length, 0);
  if (evCount === 0) return { merged: 0, sport };

  liveOddsCache[sport] = { fetchedAt: Date.now(), events: cacheEvents };
  const mlN = Object.values(cacheEvents).flat().filter(e => e.markets.h2h).length;
  const spN = Object.values(cacheEvents).flat().filter(e => e.markets.spreads).length;
  const toN = Object.values(cacheEvents).flat().filter(e => e.markets.totals).length;
  log.info('OddsFeed', `Odds API live ${sport}: ${evCount} events (h2h:${mlN} spreads:${spN} totals:${toN})`);
  return { merged: evCount, sport };
}

/**
 * Merge DK tennis moneylines into oddsCache['tennis'].
 *
 * WHY DK: tennis odds come exclusively from TOA's dynamic tournament keys,
 * and TOA only ever lists majors + Masters-level events. In any off-week
 * (post-Wimbledon, 2026-07-17: all 41 TOA tennis keys inactive) the tour is
 * playing 250-level events TOA has never heard of — PX listed 17 matches
 * across ATP Gstaad/Bastad/Umag + WTA Iasi/Athens while our tennis cache had
 * zero events, so every tennis RFQ declined as an unknown leg. DK's
 * sportsbook carries all of them (per-tournament league pages discovered from
 * the /leagues/tennis hub; see dk-scraper GAME_LINE_CONFIGS.tennis).
 *
 * ADDITIVE ONLY: an existing cache pair (from TOA when a covered tournament
 * is active) always wins — multi-book consensus beats a single-book de-vig.
 * Live matches (started=true) never merge; their prices move per point.
 * Moneyline only for now: the league pages' default payload carries no Game
 * Spread / Total Games markets, so PX tennis spread/total legs keep declining
 * (they did before too — no regression).
 */
async function mergeDkTennisMatches() {
  const dk = require('./dk-scraper');
  let data;
  try {
    data = await dk.fetchDkGameLines('tennis');
  } catch (err) {
    log.warn('OddsFeed', `DK tennis fetch failed: ${err.message}`);
    return { merged: 0, added: 0, err: err.message };
  }
  if (!data || !Array.isArray(data.games) || data.games.length === 0) return { merged: 0, added: 0 };

  const sport = 'tennis';
  if (!oddsCache[sport]) oddsCache[sport] = { fetchedAt: Date.now(), events: {} };
  const cache = oddsCache[sport];

  // Same last-word fuzzy pair index as the MMA merge — DK and PX/TOA can
  // disagree on given-name spelling, but tennis surnames are stable.
  const lw = (n) => (n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).pop() || '';
  const existingPairs = new Set();
  for (const entry of Object.values(cache.events || {})) {
    for (const ev of (Array.isArray(entry) ? entry : [entry])) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const a = lw(ev.homeTeam), b = lw(ev.awayTeam);
      if (a && b) { existingPairs.add(a + '|' + b); existingPairs.add(b + '|' + a); }
    }
  }

  // Build a totals/spreads cache block from the scraper's per-line map. The
  // scrape already de-vigged each line (fairProb on over/under & home/away);
  // we reshape into the {primary + byLine} form getFairProb reads (primary =
  // the middle line so the pricer's line-match falls back sensibly). Returns
  // null when DK served no lines (e.g. 250-level matches with no Game Spread).
  const buildTotalsBlock = (byLineData) => {
    const arr = Object.values(byLineData || {}).filter(t => t && t.over && t.under && t.over.fairProb > 0 && t.under.fairProb > 0).sort((a, b) => a.line - b.line);
    if (!arr.length) return null;
    const mk = (o, ln) => ({ rawOdds: o.americanOdds, impliedProb: o.impliedProb, fairProb: o.fairProb, displayFairProb: o.fairProb, line: ln });
    const byLine = {};
    for (const t of arr) byLine[String(t.line)] = { line: t.line, over: mk(t.over, t.line), under: mk(t.under, t.line) };
    const primary = arr[Math.floor(arr.length / 2)];
    return { line: primary.line, over: mk(primary.over, primary.line), under: mk(primary.under, primary.line), byLine, books: 1, pinnacle: null, fanduel: null, kalshi: null, dkScraped: true };
  };
  const buildSpreadsBlock = (byLineData) => {
    const arr = Object.values(byLineData || {}).filter(s => s && s.home && s.away && s.home.fairProb > 0 && s.away.fairProb > 0).sort((a, b) => Math.abs(a.line) - Math.abs(b.line));
    if (!arr.length) return null;
    const mk = (o, ln) => ({ rawOdds: o.americanOdds, impliedProb: o.impliedProb, fairProb: o.fairProb, displayFairProb: o.fairProb, line: ln });
    // byLine must use getFairProb's signed-selection key format
    // (`'home|'+signedHomeLine`, `'away|'+signedAwayLine` -> { fairProb }),
    // NOT a bare line key — that's what buildConsensusSpread emits and what
    // getFairProb's spread alt-line path looks up. `s.line` is DK's home line
    // (signed); the away line is its negation.
    const byLine = {};
    for (const s of arr) {
      byLine['home|' + s.line] = { fairProb: s.home.fairProb };
      byLine['away|' + (-s.line)] = { fairProb: s.away.fairProb };
    }
    const primary = arr[0]; // tightest handicap as primary
    return { line: primary.line, home: mk(primary.home, primary.line), away: mk(primary.away, primary.line), byLine, books: 1, pinnacle: null, fanduel: null, kalshi: null, dkScraped: true };
  };

  // Index existing DK-SCRAPED events by fuzzy pair so re-runs UPDATE them in
  // place instead of skipping. The original merge skipped every already-known
  // pair and only stamped cache.fetchedAt when added > 0 — so after the boot
  // merge populated the cache, every later cycle added 0, odds never moved,
  // freshness never advanced, and the 4-min tennis stale gate declined 100%
  // of tennis RFQs while the scrape itself was working fine (dark 35h on
  // 7/21 and 17h on 7/23). TOA-sourced events are still never clobbered —
  // update-in-place applies ONLY to events this merge created (dk-tennis-*).
  const dkEventByPair = {};
  for (const entry of Object.values(cache.events || {})) {
    for (const ev of (Array.isArray(entry) ? entry : [entry])) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (!String(ev.eventId || '').startsWith('dk-tennis-')) continue;
      const a = lw(ev.homeTeam), b = lw(ev.awayTeam);
      if (a && b) { dkEventByPair[a + '|' + b] = ev; dkEventByPair[b + '|' + a] = ev; }
    }
  }

  let added = 0, updated = 0, skippedLive = 0, skippedExisting = 0, withTot = 0, withSp = 0;
  for (const g of data.games) {
    if (!g.homeTeam || !g.awayTeam || !g.h2h || !g.h2h.home || !g.h2h.away) continue;
    if (g.started) { skippedLive++; continue; }
    if (!(g.h2h.home.fairProb > 0) || !(g.h2h.away.fairProb > 0)) continue;
    const p1 = lw(g.homeTeam), p2 = lw(g.awayTeam);
    if (!p1 || !p2) continue;
    const dkExisting = dkEventByPair[p1 + '|' + p2];
    if (dkExisting) {
      // Refresh the DK-scraped event's odds in place (orientation-aware: the
      // cached event may store the pair flipped vs this scrape run).
      const sameOrientation = lw(dkExisting.homeTeam) === p1;
      const h = sameOrientation ? g.h2h.home : g.h2h.away;
      const a = sameOrientation ? g.h2h.away : g.h2h.home;
      const mkSide = (o) => ({ rawOdds: o.americanOdds, impliedProb: o.impliedProb, fairProb: o.fairProb, displayFairProb: o.fairProb });
      dkExisting.markets = dkExisting.markets || {};
      dkExisting.markets.h2h = {
        home: mkSide(h), away: mkSide(a), books: 1,
        pinnacle: null, fanduel: null,
        draftkings: { home: h.americanOdds, away: a.americanOdds },
        kalshi: null, dkScraped: true,
      };
      const totBlock2 = buildTotalsBlock(g.totalsByLine);
      const spBlock2 = buildSpreadsBlock(g.spreadsByLine);
      // Note: totals/spreads blocks are built in the scrape run's orientation.
      // Totals are side-symmetric (over/under). Spreads for a flipped pair
      // would need sign inversion — skip the update in that rare case and
      // keep the prior block rather than store a wrong-signed one.
      if (totBlock2) { dkExisting.markets.totals = totBlock2; }
      if (spBlock2 && sameOrientation) { dkExisting.markets.spreads = spBlock2; }
      if (g.startTime) dkExisting.commenceTime = g.startTime;
      updated++;
      continue;
    }
    if (existingPairs.has(p1 + '|' + p2)) { skippedExisting++; continue; }

    const key = normalizeEventKey(g.homeTeam, g.awayTeam);
    const markets = {
      h2h: {
        home: { rawOdds: g.h2h.home.americanOdds, impliedProb: g.h2h.home.impliedProb, fairProb: g.h2h.home.fairProb, displayFairProb: g.h2h.home.fairProb },
        away: { rawOdds: g.h2h.away.americanOdds, impliedProb: g.h2h.away.impliedProb, fairProb: g.h2h.away.fairProb, displayFairProb: g.h2h.away.fairProb },
        books: 1,
        pinnacle: null, fanduel: null,
        draftkings: { home: g.h2h.home.americanOdds, away: g.h2h.away.americanOdds },
        kalshi: null,
        dkScraped: true,
      },
    };
    const totBlock = buildTotalsBlock(g.totalsByLine);
    if (totBlock) { markets.totals = totBlock; withTot++; }
    const spBlock = buildSpreadsBlock(g.spreadsByLine);
    if (spBlock) { markets.spreads = spBlock; withSp++; }
    const newEvent = {
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      commenceTime: g.startTime || null,
      eventId: 'dk-tennis-' + g.eventId,
      markets,
    };
    if (!cache.events[key]) cache.events[key] = [];
    if (Array.isArray(cache.events[key])) cache.events[key].push(newEvent);
    else cache.events[key] = [cache.events[key], newEvent];
    existingPairs.add(p1 + '|' + p2); existingPairs.add(p2 + '|' + p1);
    added++;
  }
  // Stamp freshness whenever the scrape produced a usable board — updates
  // count as much as adds. (added>0-only stamping was the tennis-dark bug.)
  if (added > 0 || updated > 0) cache.fetchedAt = Date.now();
  log.info('OddsFeed', `Tennis DK merge: added ${added}, updated ${updated} (${withTot} w/totals, ${withSp} w/spreads), skipped ${skippedLive} live + ${skippedExisting} toa-covered (DK games: ${data.games.length})`);
  return { merged: added + updated, added, updated };
}

/**
 * Bovada tennis merge — the SERVER-SIDE tennis backstop.
 *
 * Runs after mergeDkTennisMatches and is strictly ADDITIVE: it only creates
 * events for player pairs no existing source already covers, so a TOA
 * multi-book consensus or a DK board always wins. Bovada is one book, so its
 * "fair" is a 2-way de-vig of its own two sides (books:1) — same basis the DK
 * tennis merge uses.
 *
 * It exists because the other two sources structurally cannot cover PX's
 * tennis slate: TOA catalogs only Slams/Masters (all 41 keys inactive on
 * 2026-07-26, with no key at all for ATP Washington / Los Cabos / WTA
 * Washington — the entire 30-event slate), and the DK Puppeteer scrape
 * returns EMPTY from Railway's datacenter IP while succeeding locally.
 * Bovada's coupon is plain HTTPS JSON, so it actually runs in production.
 */
const BOVADA_TENNIS_REAPPLY_MAX_AGE_MS =
  (Number(process.env.BOVADA_TENNIS_REAPPLY_MAX_AGE_MIN) || 20) * 60 * 1000;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.reapply] When true, re-merge the LAST fetched board
 *   instead of hitting the network. Used immediately after a wholesale
 *   oddsCache['tennis'] replacement so merged events survive the overwrite.
 */
async function mergeBovadaTennisMatches(opts = {}) {
  const bov = require('./bovada-tennis');
  let data;
  if (opts.reapply) {
    data = bov.getLastBoard();
    // Refuse to re-apply a board old enough to be misleading — better to have
    // no tennis odds than stale ones the stale-price gate can't see through
    // (the re-apply stamps fetchedAt, which would otherwise launder the age).
    if (!data || (Date.now() - (data.fetchedAt || 0)) > BOVADA_TENNIS_REAPPLY_MAX_AGE_MS) {
      return { added: 0, updated: 0, reapplied: false };
    }
  } else {
    try {
      data = bov.rememberBoard(await bov.fetchBovadaTennis());
    } catch (err) {
      log.warn('OddsFeed', `Bovada tennis fetch failed: ${err.message}`);
      return { added: 0, updated: 0, err: err.message };
    }
  }
  return _mergeTennisBoard(data, {
    sourceLabel: 'Bovada', idPrefix: 'bov-tennis-', flagKey: 'bovadaScraped', withPinnacle: false,
  });
}

/**
 * Pinnacle tennis merge — same contract as the Bovada one above.
 *
 * Runs BEFORE Bovada in the refresh cycle so it claims each pair first: the
 * shared merge never clobbers an already-covered pair, so merge order IS
 * source priority, and Pinnacle is both sharper and the only source carrying a
 * real half-point ladder (Bovada posts one integer spread + one total).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.reapply] Re-merge the LAST fetched board instead of
 *   hitting the network — same wholesale-overwrite survival trick as Bovada.
 */
async function mergePinnacleTennisMatches(opts = {}) {
  const pin = require('./pinnacle-tennis');
  let data;
  if (opts.reapply) {
    data = pin.getLastBoard();
    if (!data || (Date.now() - (data.fetchedAt || 0)) > BOVADA_TENNIS_REAPPLY_MAX_AGE_MS) {
      return { added: 0, updated: 0, reapplied: false };
    }
  } else {
    try {
      data = pin.rememberBoard(await pin.fetchPinnacleTennis());
    } catch (err) {
      log.warn('OddsFeed', `Pinnacle tennis fetch failed: ${err.message}`);
      return { added: 0, updated: 0, err: err.message };
    }
  }
  // withPinnacle: these ARE Pinnacle's prices, so populate the `pinnacle` field
  // the dashboard column and the de-vig favourite floor both read. Bovada must
  // not (its prices are not Pinnacle's).
  return _mergeTennisBoard(data, {
    sourceLabel: 'Pinnacle', idPrefix: 'pin-tennis-', flagKey: 'pinnacleScraped', withPinnacle: true,
  });
}

/**
 * Shared merge body for single-book tennis boards (Bovada, Pinnacle).
 *
 * Both sources produce the same { games: [...] } shape, and the merge rules —
 * never clobber a richer source, refresh our own prior entry in place, key
 * spreads by the signed HOME handicap — are identical. Keeping one
 * implementation means a fix to the sawtooth/staleness handling applies to
 * both instead of silently diverging.
 */
/**
 * Overlay TOA-sourced tennis SET markets onto already-cached tennis events.
 *
 * ENRICHMENT, NOT AN ADDITIVE MERGE. TOA's set feed carries only h2h_s1 /
 * alternate_set_totals / alternate_set_spreads — no match moneyline, spread or
 * total — so a TOA-sets game cannot stand alone as a cache event. It attaches to
 * an event another source (Pinnacle/Bovada/TOA bulk) already put there, and does
 * nothing when there is no host event.
 *
 * SOURCE PRIORITY, per the 2026-08-04 audit:
 *   - TOA wins when it has >= 2 books: a real multi-book consensus beats a
 *     single-book quote.
 *   - Pinnacle keeps the market otherwise. Its set board is a genuine two-sided
 *     sharp quote and it covers 83.6% of matches including ATP Challenger and
 *     ITF events for which TOA has no sport key at all, whereas TOA's set-totals
 *     "consensus" is frequently ONE retail book (BetRivers) and prices Over 2.5
 *     about 1.07pp high vs Pinnacle (t=-3.50).
 *
 * ORIENTATION: TOA's home/away can be flipped relative to the cached event, so
 * every market is re-oriented on the surname pair before it is written. Getting
 * this wrong silently swaps the two players' prices.
 */
async function mergeToaTennisSets() {
  const src = require('./toa-tennis-sets');
  let data;
  try {
    data = src.rememberBoard(await src.fetchSlate());
  } catch (err) {
    log.warn('OddsFeed', `TOA tennis sets fetch failed: ${err.message}`);
    return { attached: 0, err: err.message };
  }
  if (!data || !Array.isArray(data.games) || !data.games.length) return { attached: 0 };

  const cache = oddsCache['tennis'];
  if (!cache || !cache.events) return { attached: 0, reason: 'no tennis cache' };

  const sn = src.__surname;
  const byPair = new Map();
  for (const entry of Object.values(cache.events)) {
    for (const ev of (Array.isArray(entry) ? entry : [entry])) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const k = [sn(ev.homeTeam), sn(ev.awayTeam)].sort().join('|');
      if (k && !byPair.has(k)) byPair.set(k, ev);
    }
  }

  const mk = (p, line) => ({ rawOdds: null, impliedProb: p, fairProb: p, displayFairProb: p, line: line ?? null });
  let attached = 0, noHost = 0, keptPinnacle = 0;

  for (const g of data.games) {
    const k = [sn(g.homeTeam), sn(g.awayTeam)].sort().join('|');
    const ev = byPair.get(k);
    if (!ev) { noHost++; continue; }
    if (!ev.markets) ev.markets = {};
    // TOA's "home" may be the cached event's away side.
    const flip = sn(ev.homeTeam) !== sn(g.homeTeam);
    const pick = (o, side) => (flip ? (side === 'home' ? o.away : o.home) : (side === 'home' ? o.home : o.away));
    const s = g.sets;
    let touched = false;

    const better = (existing, books) => {
      if (!existing) return true;                 // nothing there yet
      if (existing.toaSets) return true;          // refresh our own prior overlay
      return (books || 0) >= 2;                   // else only a real consensus wins
    };

    if (s.firstSetMl && better(ev.markets.first_set_moneyline, s.books.firstSetMl)) {
      const h = pick(s.firstSetMl, 'home'), a = pick(s.firstSetMl, 'away');
      if (h && a) {
        ev.markets.first_set_moneyline = {
          home: mk(h.fairProb), away: mk(a.fairProb),
          books: s.books.firstSetMl || 1, pinnacle: null, fanduel: null, kalshi: null, toaSets: true,
        };
        touched = true;
      }
    }
    if (s.totalSets && better(ev.markets.total_sets, s.books.totalSets)) {
      ev.markets.total_sets = {
        line: 2.5, over: mk(s.totalSets.over.fairProb, 2.5), under: mk(s.totalSets.under.fairProb, 2.5),
        byLine: { '2.5': { line: 2.5, over: mk(s.totalSets.over.fairProb, 2.5), under: mk(s.totalSets.under.fairProb, 2.5) } },
        books: s.books.totalSets || 1, pinnacle: null, fanduel: null, kalshi: null, toaSets: true,
      };
      touched = true;
    }
    if (s.atLeastOneSet && better(ev.markets.set_win_at_least_one, s.books.atLeastOneSet)) {
      // Each side may be independently missing — a book posts only ONE spread
      // direction, so one player often has no direct price. Preserve whichever
      // side the existing (Pinnacle) market already had rather than dropping it.
      const prev = ev.markets.set_win_at_least_one || {};
      const h = pick(s.atLeastOneSet, 'home'), a = pick(s.atLeastOneSet, 'away');
      const next = {
        home: h ? mk(h.fairProb) : prev.home || null,
        away: a ? mk(a.fairProb) : prev.away || null,
        books: s.books.atLeastOneSet || 1, pinnacle: null, fanduel: null, kalshi: null, toaSets: true,
      };
      if (next.home || next.away) { ev.markets.set_win_at_least_one = next; touched = true; }
    }
    if (touched) { attached++; } else { keptPinnacle++; }
  }

  if (attached) cache.fetchedAt = Date.now();
  log.info('OddsFeed', `TOA tennis sets: attached to ${attached} event(s), `
    + `${keptPinnacle} kept existing source, ${noHost} had no cached host event `
    + `(TOA games: ${data.games.length})`);
  return { attached, keptPinnacle, noHost };
}

function _mergeTennisBoard(data, { sourceLabel, idPrefix, flagKey, withPinnacle }) {
  if (!data || !Array.isArray(data.games) || data.games.length === 0) return { added: 0, updated: 0 };

  const sport = 'tennis';
  if (!oddsCache[sport]) oddsCache[sport] = { fetchedAt: Date.now(), events: {} };
  const cache = oddsCache[sport];

  const lw = (n) => (n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).pop() || '';
  const existingPairs = new Set();
  const ownEventByPair = {};
  for (const entry of Object.values(cache.events || {})) {
    for (const ev of (Array.isArray(entry) ? entry : [entry])) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const a = lw(ev.homeTeam), b = lw(ev.awayTeam);
      if (!a || !b) continue;
      existingPairs.add(a + '|' + b); existingPairs.add(b + '|' + a);
      if (String(ev.eventId || '').startsWith(idPrefix)) {
        ownEventByPair[a + '|' + b] = ev; ownEventByPair[b + '|' + a] = ev;
      }
    }
  }

  const mk = (o, ln) => ({ rawOdds: o.americanOdds, impliedProb: o.impliedProb, fairProb: o.fairProb, displayFairProb: o.fairProb, line: ln });
  const totalsBlock = (byLineData) => {
    const arr = Object.values(byLineData || {}).filter(t => t && t.over && t.under && t.over.fairProb > 0 && t.under.fairProb > 0).sort((a, b) => a.line - b.line);
    if (!arr.length) return null;
    const byLine = {};
    for (const t of arr) byLine[String(t.line)] = { line: t.line, over: mk(t.over, t.line), under: mk(t.under, t.line) };
    const p = arr[Math.floor(arr.length / 2)];
    return {
      line: p.line, over: mk(p.over, p.line), under: mk(p.under, p.line), byLine, books: 1,
      pinnacle: withPinnacle ? { over: p.over.americanOdds, under: p.under.americanOdds } : null,
      fanduel: null, kalshi: null, [flagKey]: true,
    };
  };
  const spreadsBlock = (byLineData) => {
    const arr = Object.values(byLineData || {}).filter(s => s && s.home && s.away && s.home.fairProb > 0 && s.away.fairProb > 0).sort((a, b) => Math.abs(a.line) - Math.abs(b.line));
    if (!arr.length) return null;
    // Same signed-selection key format buildConsensusSpread emits and
    // getFairProb's alt-line path looks up — a bare line key would never match.
    const byLine = {};
    for (const s of arr) {
      byLine['home|' + s.line] = { fairProb: s.home.fairProb };
      byLine['away|' + (-s.line)] = { fairProb: s.away.fairProb };
    }
    const p = arr[0];
    return {
      line: p.line, home: mk(p.home, p.line), away: mk(p.away, p.line), byLine, books: 1,
      pinnacle: withPinnacle ? { home: p.home.americanOdds, away: p.away.americanOdds } : null,
      fanduel: null, kalshi: null, [flagKey]: true,
    };
  };

  let added = 0, updated = 0, skippedCovered = 0, withTot = 0, withSp = 0, withSetsMerged = 0;
  for (const g of data.games) {
    if (!g.homeTeam || !g.awayTeam || !g.h2h) continue;
    const a = lw(g.homeTeam), b = lw(g.awayTeam);
    if (!a || !b) continue;

    const markets = {
      h2h: {
        home: mk(g.h2h.home, null), away: mk(g.h2h.away, null),
        books: 1,
        pinnacle: withPinnacle ? { home: g.h2h.home.americanOdds, away: g.h2h.away.americanOdds } : null,
        fanduel: null, kalshi: null, [flagKey]: true,
      },
    };
    const tb = totalsBlock(g.totalsByLine); if (tb) { markets.totals = tb; withTot++; }
    const sb = spreadsBlock(g.spreadsByLine); if (sb) { markets.spreads = sb; withSp++; }

    // TENNIS SETS markets (Pinnacle only — Bovada carries no sets board, and
    // the source fails closed on anything that is not best-of-3). Kept under
    // their own market keys so nothing can confuse a SETS total (2.5) with the
    // GAMES total (20.5-27.5) or a first-set winner with the match winner.
    if (g.sets) {
      if (g.sets.firstSetMl) {
        markets.first_set_moneyline = {
          home: mk(g.sets.firstSetMl.home, null), away: mk(g.sets.firstSetMl.away, null),
          books: 1,
          pinnacle: withPinnacle ? { home: g.sets.firstSetMl.home.americanOdds, away: g.sets.firstSetMl.away.americanOdds } : null,
          fanduel: null, kalshi: null, [flagKey]: true,
        };
      }
      if (g.sets.totalSets) {
        const t = g.sets.totalSets;
        markets.total_sets = {
          line: t.line, over: mk(t.over, t.line), under: mk(t.under, t.line),
          byLine: { [String(t.line)]: { line: t.line, over: mk(t.over, t.line), under: mk(t.under, t.line) } },
          books: 1,
          pinnacle: withPinnacle ? { over: t.over.americanOdds, under: t.under.americanOdds } : null,
          fanduel: null, kalshi: null, [flagKey]: true,
        };
      }
      if (g.sets.atLeastOneSet) {
        markets.set_win_at_least_one = {
          home: mk(g.sets.atLeastOneSet.home, null), away: mk(g.sets.atLeastOneSet.away, null),
          books: 1,
          pinnacle: withPinnacle ? { home: g.sets.atLeastOneSet.home.americanOdds, away: g.sets.atLeastOneSet.away.americanOdds } : null,
          fanduel: null, kalshi: null, [flagKey]: true,
        };
      }
      markets._setsMeta = { format: g.sets.format, consistency: g.sets.consistency };
      withSetsMerged++;
    }

    // Refresh our own prior entry in place (keeps freshness advancing across
    // cycles — the bug that kept the DK tennis merge permanently stale).
    const own = ownEventByPair[a + '|' + b];
    if (own) {
      if (lw(own.homeTeam) === a) {
        own.markets = markets;
        if (g.startTime) own.commenceTime = g.startTime;
        updated++;
      }
      continue;
    }
    // Never clobber a TOA/DK-covered pair.
    if (existingPairs.has(a + '|' + b)) { skippedCovered++; continue; }

    const key = normalizeEventKey(g.homeTeam, g.awayTeam);
    const newEvent = {
      homeTeam: g.homeTeam, awayTeam: g.awayTeam,
      commenceTime: g.startTime || null,
      eventId: idPrefix + g.eventId,
      markets,
    };
    if (!cache.events[key]) cache.events[key] = [];
    if (Array.isArray(cache.events[key])) cache.events[key].push(newEvent);
    else cache.events[key] = [cache.events[key], newEvent];
    existingPairs.add(a + '|' + b); existingPairs.add(b + '|' + a);
    ownEventByPair[a + '|' + b] = newEvent; ownEventByPair[b + '|' + a] = newEvent;
    added++;
  }

  if (added > 0 || updated > 0) cache.fetchedAt = Date.now();
  log.info('OddsFeed', `${sourceLabel} tennis merge: added ${added}, updated ${updated} (${withTot} w/totals, `
    + `${withSp} w/spreads, ${withSetsMerged} w/sets), skipped ${skippedCovered} already-covered `
    + `(${sourceLabel} games: ${data.games.length})`);
  return { added, updated };
}

async function mergeDkMmaFights() {
  const dk = require('./dk-scraper');
  let fightData;
  try {
    fightData = await dk.fetchMmaFightOdds();
  } catch (err) {
    log.warn('OddsFeed', `DK MMA fetch failed: ${err.message}`);
    return { merged: 0, added: 0, err: err.message };
  }
  if (!fightData || !fightData.fights || fightData.fights.length === 0) {
    return { merged: 0, added: 0 };
  }
  const sport = 'mma_mixed_martial_arts';
  if (!oddsCache[sport]) oddsCache[sport] = { fetchedAt: Date.now(), events: {} };
  const cache = oddsCache[sport];

  // Build fuzzy lookup over existing cache events by last-word fighter pair.
  // We also keep a handle to the existing event object so we can graft DK
  // totals onto SharpAPI-seeded h2h entries (SharpAPI MMA feed is moneyline-
  // only, so without enrichment totals would silently 404).
  const lw = (n) => (n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).pop() || '';
  // CRITICAL: a single fight pair can produce MULTIPLE cache entries when
  // SharpAPI and DK disagree on home/away ordering — they end up as two
  // events under different normalizeEventKey results (e.g. both
  // "Gorimbo vs Micallef" AND "Micallef vs Gorimbo" present in
  // cache.events at the same time). The line-manager binds to whichever
  // the seed picked first — usually the SharpAPI h2h-only one. If we
  // only enrich ONE entry, the other stays bare and getFairProb returns
  // null on totals lookups against the line-manager's chosen orientation.
  // So we collect ALL events per pair (array) and enrich every one.
  const existingByPair = new Map(); // "a|b" → event[]
  for (const entry of Object.values(cache.events || {})) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      const a = lw(ev.homeTeam), b = lw(ev.awayTeam);
      if (!a || !b) continue;
      const key1 = a + '|' + b;
      const key2 = b + '|' + a;
      if (!existingByPair.has(key1)) existingByPair.set(key1, []);
      if (!existingByPair.has(key2)) existingByPair.set(key2, []);
      const list1 = existingByPair.get(key1);
      const list2 = existingByPair.get(key2);
      if (!list1.includes(ev)) list1.push(ev);
      if (!list2.includes(ev)) list2.push(ev);
    }
  }

  // Helper: build the markets.totals block from a DK fight's totals array.
  function buildTotalsBlock(totals) {
    if (!Array.isArray(totals) || totals.length === 0) return null;
    // Pick a primary line — prefer the middle (median fight duration:
    // 3-round ≈ 2.5, 5-round ≈ 4.5). Remaining lines become alt.
    const sorted = [...totals].sort((a, b) => a.line - b.line);
    const primary = sorted[Math.floor(sorted.length / 2)];
    // byLine map keyed by string-line so getFairProb's fast path
    // (services/odds-feed.js — `if (marketType === 'totals' && market.byLine)`)
    // can resolve PX alt-line requests without depending on altLinesCache,
    // which is empty for MMA (not in SPORTS_WITH_ALT_MARKETS).
    const byLine = {};
    for (const t of sorted) {
      byLine[String(t.line)] = {
        line: t.line,
        over: { rawOdds: t.over.americanOdds, impliedProb: t.over.impliedProb, fairProb: t.over.fairProb, displayFairProb: t.over.fairProb },
        under: { rawOdds: t.under.americanOdds, impliedProb: t.under.impliedProb, fairProb: t.under.fairProb, displayFairProb: t.under.fairProb },
        books: 1,
      };
    }
    return {
      line: primary.line,
      over: {
        rawOdds: primary.over.americanOdds, impliedProb: primary.over.impliedProb,
        fairProb: primary.over.fairProb, displayFairProb: primary.over.fairProb,
      },
      under: {
        rawOdds: primary.under.americanOdds, impliedProb: primary.under.impliedProb,
        fairProb: primary.under.fairProb, displayFairProb: primary.under.fairProb,
      },
      books: 1,
      byLine,
      alt: sorted.map(t => ({
        line: t.line,
        over: { rawOdds: t.over.americanOdds, impliedProb: t.over.impliedProb, fairProb: t.over.fairProb, displayFairProb: t.over.fairProb },
        under: { rawOdds: t.under.americanOdds, impliedProb: t.under.impliedProb, fairProb: t.under.fairProb, displayFairProb: t.under.fairProb },
      })),
      pinnacle: null, fanduel: null,
      draftkings: { line: primary.line, over: primary.over.americanOdds, under: primary.under.americanOdds },
      kalshi: null,
      dkScraped: true,
    };
  }

  let added = 0, enriched = 0, skipped = 0;
  for (const fight of fightData.fights) {
    if (!fight.fighters || fight.fighters.length !== 2) continue;
    const [f1, f2] = fight.fighters;
    const p1 = lw(f1.fighter), p2 = lw(f2.fighter);
    if (!p1 || !p2) continue;
    // existingByPair returns an ARRAY of events for this pair — usually
    // 1, but 2 when SharpAPI + DK ingest produced different home/away
    // orderings (separate cache entries for the same fight). We need
    // to enrich EVERY entry so whichever orientation the line-manager
    // bound to also has totals.
    const existingList = existingByPair.get(p1 + '|' + p2) || existingByPair.get(p2 + '|' + p1) || [];
    if (existingList.length > 0) {
      const block = buildTotalsBlock(fight.totals);
      let didEnrich = false;
      for (const existing of existingList) {
        if (!existing.markets) existing.markets = {};
        if (!existing.markets.totals && block) {
          existing.markets.totals = block;
          didEnrich = true;
        }
      }
      if (didEnrich) enriched++;
      else skipped++;
      continue;
    }
    // DK doesn't label home/away for MMA (it's a neutral-site fight); use
    // the first fighter as 'home' arbitrarily. line-manager's seed matches
    // teamName→competitor by exact/substring anyway.
    const homeTeam = f1.fighter, awayTeam = f2.fighter;
    const key = normalizeEventKey(homeTeam, awayTeam);
    const markets = {
      h2h: {
        home: {
          rawOdds: f1.americanOdds, impliedProb: f1.impliedProb,
          fairProb: f1.fairProb, displayFairProb: f1.fairProb,
        },
        away: {
          rawOdds: f2.americanOdds, impliedProb: f2.impliedProb,
          fairProb: f2.fairProb, displayFairProb: f2.fairProb,
        },
        books: 1,
        pinnacle: null, fanduel: null,
        draftkings: { home: f1.americanOdds, away: f2.americanOdds },
        kalshi: null,
        dkScraped: true,
      },
    };
    const totalsBlock = buildTotalsBlock(fight.totals);
    if (totalsBlock) markets.totals = totalsBlock;
    const newEvent = {
      homeTeam, awayTeam,
      commenceTime: fight.startTime || null,
      eventId: 'dk-mma-' + fight.eventId,
      markets,
    };
    if (!cache.events[key]) cache.events[key] = [];
    if (Array.isArray(cache.events[key])) cache.events[key].push(newEvent);
    else cache.events[key] = [cache.events[key], newEvent];
    added++;
  }
  cache.fetchedAt = Date.now();
  log.info('OddsFeed', `MMA DK merge: added ${added}, enriched-totals ${enriched}, skipped ${skipped} (total DK fights: ${fightData.fights.length})`);

  // TOA backstop: any cache event still missing markets.totals after the
  // DK enrichment pass gets a per-event TOA fetch into altLinesCache.
  // Reasons a fight ends up here: SharpAPI seeded the h2h but DK's
  // /leagues/mma/ufc page didn't surface it (Bellator/PFL/regional cards
  // or a lazy-load miss), or DK got the fight but no Total Rounds
  // markets fired XHRs. Without this, getFairProbAsync would call
  // fetchAltLines per RFQ and resolveOddsApiEventId would have nothing
  // (now fixed), but pre-warming here lets /lines/detail show coverage
  // immediately and avoids a cold per-RFQ TOA fetch hop.
  const toBackstop = [];
  for (const entry of Object.values(cache.events || {})) {
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (ev.markets && ev.markets.totals) continue;
      toBackstop.push(ev);
    }
  }
  let backstopHits = 0, backstopAttempts = 0;
  if (toBackstop.length > 0 && process.env.THE_ODDS_API_KEY) {
    backstopAttempts = toBackstop.length;
    await Promise.allSettled(toBackstop.map(async (ev) => {
      try {
        const r = await fetchAltLines(sport, ev.homeTeam, ev.awayTeam, ev.commenceTime);
        if (r && r.altTotals && Object.keys(r.altTotals).length > 0) backstopHits++;
      } catch (err) {
        log.debug('OddsFeed', `MMA TOA backstop failed for ${ev.homeTeam} vs ${ev.awayTeam}: ${err.message}`);
      }
    }));
    log.info('OddsFeed', `MMA TOA totals backstop: ${backstopHits}/${backstopAttempts} events backfilled into altLinesCache`);
  }

  return { added, enriched, skipped, backstopHits, backstopAttempts, total: fightData.fights.length };
}

async function backfillMissingH2h(sport) {
  if (!H2H_BACKFILL_SPORTS.has(sport)) return null;
  const cache = oddsCache[sport];
  if (!cache || !cache.events) return null;

  const missing = [];
  for (const [key, entry] of Object.entries(cache.events)) {
    const events = Array.isArray(entry) ? entry : [entry];
    for (const ev of events) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (ev.markets && ev.markets.h2h && ev.markets.h2h.home && ev.markets.h2h.away) continue;
      missing.push({ key, ev });
    }
  }
  if (missing.length === 0) return { sport, missing: 0, filled: 0 };

  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return { sport, missing: missing.length, filled: 0, err: 'no THE_ODDS_API_KEY' };

  const oddsApiSport = PINNACLE_SPORT_MAP[sport] || sport;
  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds`
    + `?apiKey=${theOddsApiKey}&regions=us,eu&markets=h2h&oddsFormat=american`;

  let filled = 0;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return { sport, missing: missing.length, filled: 0, err: `The Odds API ${resp.status}: ${text.slice(0, 120)}` };
    }
    const apiEvents = await resp.json();

    // Index apiEvents by normalized team-pair key (both directions).
    const byKey = {};
    for (const e of apiEvents) {
      const k = normalizeEventKey(e.home_team, e.away_team);
      const kRev = normalizeEventKey(e.away_team, e.home_team);
      byKey[k] = e;
      byKey[kRev] = e;
    }

    for (const { ev } of missing) {
      const apiEvent = byKey[normalizeEventKey(ev.homeTeam, ev.awayTeam)]
                   || byKey[normalizeEventKey(ev.awayTeam, ev.homeTeam)];
      if (!apiEvent) continue;

      // Collect h2h pairs from every book.
      const mlPairs = [];
      for (const book of (apiEvent.bookmakers || [])) {
        const mk = book.markets?.find(m => m.key === 'h2h');
        if (!mk) continue;
        const home = mk.outcomes?.find(o => o.name === apiEvent.home_team);
        const away = mk.outcomes?.find(o => o.name === apiEvent.away_team);
        if (home && away) {
          mlPairs.push({
            book: book.key,
            home: { odds_probability: americanToImpliedProb(home.price), odds_american: home.price },
            away: { odds_probability: americanToImpliedProb(away.price), odds_american: away.price },
          });
        }
      }
      if (mlPairs.length === 0) continue;

      // Align apiEvent home/away to OUR event's home/away orientation —
      // the odds-api sometimes swaps sides vs SharpAPI. If swapped, flip.
      const apiHomeMatchesOurHome = apiEvent.home_team.toLowerCase().includes(ev.homeTeam.toLowerCase().split(' ').pop())
                                  || ev.homeTeam.toLowerCase().includes(apiEvent.home_team.toLowerCase().split(' ').pop());
      const getOur = (pairSide) => apiHomeMatchesOurHome ? pairSide : (pairSide === 'home' ? 'away' : 'home');

      const fairHome = [], fairAway = [];
      for (const p of mlPairs) {
        const [fh, fa] = deVig2Way(p.home.odds_probability, p.away.odds_probability);
        fairHome.push(apiHomeMatchesOurHome ? fh : fa);
        fairAway.push(apiHomeMatchesOurHome ? fa : fh);
      }
      const pinBook = mlPairs.find(p => p.book === 'pinnacle');
      const fdBook = mlPairs.find(p => p.book === 'fanduel');
      const dkBook = mlPairs.find(p => p.book === 'draftkings');
      const dvH = avg(fairHome), dvA = avg(fairAway);

      ev.markets = ev.markets || {};
      ev.markets.h2h = {
        home: {
          rawOdds: apiHomeMatchesOurHome ? mlPairs[0].home.odds_american : mlPairs[0].away.odds_american,
          impliedProb: apiHomeMatchesOurHome ? mlPairs[0].home.odds_probability : mlPairs[0].away.odds_probability,
          fairProb: dvH,
          displayFairProb: dvH,
        },
        away: {
          rawOdds: apiHomeMatchesOurHome ? mlPairs[0].away.odds_american : mlPairs[0].home.odds_american,
          impliedProb: apiHomeMatchesOurHome ? mlPairs[0].away.odds_probability : mlPairs[0].home.odds_probability,
          fairProb: dvA,
          displayFairProb: dvA,
        },
        books: mlPairs.length,
        pinnacle: pinBook ? { home: apiHomeMatchesOurHome ? pinBook.home.odds_american : pinBook.away.odds_american, away: apiHomeMatchesOurHome ? pinBook.away.odds_american : pinBook.home.odds_american } : null,
        fanduel: fdBook ? { home: apiHomeMatchesOurHome ? fdBook.home.odds_american : fdBook.away.odds_american, away: apiHomeMatchesOurHome ? fdBook.away.odds_american : fdBook.home.odds_american } : null,
        draftkings: dkBook ? { home: apiHomeMatchesOurHome ? dkBook.home.odds_american : dkBook.away.odds_american, away: apiHomeMatchesOurHome ? dkBook.away.odds_american : dkBook.home.odds_american } : null,
        kalshi: null,
        backfilled: true,
      };
      filled++;
    }

    log.info('OddsFeed', `H2H backfill ${sport}: filled ${filled}/${missing.length} missing events from The Odds API`);
    return { sport, missing: missing.length, filled };
  } catch (err) {
    log.warn('OddsFeed', `H2H backfill ${sport} failed: ${err.message}`);
    return { sport, missing: missing.length, filled, err: err.message };
  }
}

/**
 * Fallback event-list discovery via The Odds API. Used by warmAltLines
 * when the SharpAPI-populated oddsCache for a sport is empty (e.g.
 * SharpAPI Hobby tier doesn't return UCL/UEL events at all but TOA
 * does). Returns an array of { homeTeam, awayTeam, commenceTime } for
 * upcoming events. Empty array on any failure — caller treats that as
 * "nothing to warm" and bails gracefully.
 */
async function _listEventsFromToa(sport) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return [];
  // Map our internal sport key → TOA sport key. Most are identical;
  // the override map handles legacy mismatches.
  const fallback = ODDS_API_FALLBACK[sport];
  // Dynamic-tournament sports (tennis) handled by their existing path
  // inside resolveOddsApiEventId — no static event list to query here.
  if (fallback && fallback.dynamic) return [];
  const oddsApiSport = (fallback && fallback.oddsApiSport)
    || SCORES_API_KEY_OVERRIDES[sport]
    || sport;
  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/events?apiKey=${theOddsApiKey}`;
  try {
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) {
      log.debug('OddsFeed', `_listEventsFromToa ${sport}: HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return data.map(e => ({
      homeTeam: e.home_team,
      awayTeam: e.away_team,
      commenceTime: e.commence_time,
    })).filter(e => e.homeTeam && e.awayTeam);
  } catch (err) {
    log.debug('OddsFeed', `_listEventsFromToa ${sport} error: ${err.message}`);
    return [];
  }
}

async function warmAltLines(sport) {
  if (!SPORTS_WITH_ALT_MARKETS.has(sport)) return { skipped: 'no alt markets' };

  // Fallback path: if SharpAPI's oddsCache has no events for this sport
  // (e.g. UCL/UEL on Hobby tier), discover events directly from The
  // Odds API. Without this fallback, warmAltLines silently bails for
  // every sport SharpAPI doesn't cover — leaving alt-line cache empty
  // and forcing every RFQ to pay on-demand-fetch latency or decline.
  const cache = oddsCache[sport];
  let toaDiscovered = false;
  let toaEvents = null;
  if (!cache || !cache.events || Object.keys(cache.events).length === 0) {
    toaEvents = await _listEventsFromToa(sport);
    if (toaEvents.length === 0) {
      return { skipped: 'no event cache (SharpAPI empty + TOA returned 0 events)' };
    }
    toaDiscovered = true;
    log.info('OddsFeed', `warmAltLines ${sport}: SharpAPI cache empty, discovered ${toaEvents.length} events via TOA`);
  }

  const now = Date.now();
  const cutoffMs = now + WARM_EVENT_MAX_HOURS_AHEAD * 3600 * 1000;

  // Collect candidate events: home/away pairs with near-term commenceTime
  // and not already fresh in alt-line cache.
  //
  // Skip PX's conditional playoff events ("Game 3: Boston", "Boston 2026
  // 1st Round series", etc.) — these aren't individual books' events and
  // The Odds API has no matching record. Warming would burn API quota
  // noMatch'ing them every cycle.
  const conditionalPlayoffPattern =
    /(^|\s)game\s*\d+\s*:|\d{4}\s+\w+\s+round|\bseries\s*$/i;
  // Dedupe by team-pair across sibling cache entries. SharpAPI's MLB feed
  // commonly creates 2-3 entries per matchup (real start time + midnight
  // UTC placeholder + Kalshi-stub). Without dedupe, warmAltLines calls
  // resolveOddsApiEventId twice for the same pair, doubling the noMatch
  // count when TOA doesn't have the matchup. Verified 2026-05-03 MLB:
  // unmatchedSamples included Tampa/Toronto and Atlanta/Seattle each
  // listed twice. Pick the candidate with the most reliable commenceTime
  // (later/non-midnight-UTC if multiple available) so resolveOddsApiEventId
  // can disambiguate doubleheaders correctly.
  const candidatesByPair = {};
  // Source list: either SharpAPI cache (normal path) or TOA event list
  // (fallback when SharpAPI doesn't cover this sport). Same dedup +
  // filtering downstream regardless of source.
  const eventSourceList = toaDiscovered
    ? toaEvents.map(e => [null, e])  // shape match for the iterator below
    : Object.entries(cache.events);
  for (const [, entry] of eventSourceList) {
    const events = Array.isArray(entry) ? entry : [entry];
    for (const ev of events) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue;
      if (conditionalPlayoffPattern.test(ev.homeTeam) ||
          conditionalPlayoffPattern.test(ev.awayTeam)) continue;
      const startMs = ev.commenceTime ? new Date(ev.commenceTime).getTime() : null;
      if (startMs && !isNaN(startMs)) {
        if (startMs < now) continue;              // already started
        if (startMs > cutoffMs) continue;         // too far out
      }
      const altKey = normalizeEventKey(ev.homeTeam, ev.awayTeam);
      const altCached = altLinesCache[altKey];
      if (altCached && (now - altCached.fetchedAt) < ALT_LINES_TTL_MS) continue;
      const candidate = {
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        commenceTime: ev.commenceTime || null,
      };
      // Prefer non-midnight-UTC commenceTime when deduping (real start
      // time disambiguates doubleheaders for resolveOddsApiEventId).
      const isMidnightUtc = (s) => typeof s === 'string' && s.endsWith('T00:00:00Z');
      const existing = candidatesByPair[altKey];
      if (!existing) {
        candidatesByPair[altKey] = candidate;
      } else if (isMidnightUtc(existing.commenceTime) && !isMidnightUtc(candidate.commenceTime)) {
        candidatesByPair[altKey] = candidate; // upgrade to real time
      }
    }
  }
  const candidates = Object.values(candidatesByPair);

  if (candidates.length === 0) {
    return { sport, candidates: 0, fetched: 0, noMatch: 0, errors: 0 };
  }

  let fetched = 0, errors = 0, noMatch = 0;
  const unmatched = []; // up to 5 samples — used to diagnose matching gaps
  // Bounded-concurrency worker pool. Each worker waits WARM_REQUEST_DELAY_MS
  // between its own fetches to throttle against Odds API's 429 ("Requests
  // are too frequent"). The first iteration skips the sleep.
  let idx = 0;
  async function worker() {
    let iter = 0;
    while (idx < candidates.length) {
      if (iter++ > 0) await new Promise(r => setTimeout(r, WARM_REQUEST_DELAY_MS));
      const i = idx++;
      const c = candidates[i];
      try {
        // Pre-check: does resolveOddsApiEventId find a match? If not, we
        // know the fetch would fail for a matching reason vs an API error.
        // This lets the stats separate "no match" from "API call failed".
        const resolved = await resolveOddsApiEventId(sport, c.homeTeam, c.awayTeam, c.commenceTime);
        if (!resolved) {
          noMatch++;
          if (unmatched.length < 5) unmatched.push(`${c.homeTeam} vs ${c.awayTeam}`);
          continue;
        }
        const r = await fetchAltLines(sport, c.homeTeam, c.awayTeam, c.commenceTime);
        if (r) fetched++;
        else errors++; // resolved but fetch returned nothing (API error, empty response)
      } catch (err) {
        errors++;
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(WARM_CONCURRENCY, candidates.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const stats = {
    sport,
    candidates: candidates.length,
    fetched,
    noMatch,
    errors,
    unmatchedSamples: unmatched,
    completedAt: new Date().toISOString(),
  };
  _lastWarmStats = _lastWarmStats || {};
  _lastWarmStats[sport] = stats;
  log.info('OddsFeed', `Alt-line warm ${sport}: ${fetched}/${candidates.length} fetched (${noMatch} no-match, ${errors} errors)`);
  return stats;
}

/**
 * Warm alt lines for every sport that has alt markets, in parallel.
 * Returns when all sport-level warms complete (or a per-sport error is caught).
 * Used both at boot (pre-WebSocket) and from the 60s periodic loop.
 */
async function warmAllSports() {
  const sports = [...SPORTS_WITH_ALT_MARKETS].filter(s =>
    (config.supportedSports || []).includes(s)
  );
  const settle = await Promise.allSettled(sports.map(s =>
    warmAltLines(s).catch(err => {
      log.warn('OddsFeed', `Warm loop error for ${s}: ${err.message}`);
      return null;
    })
  ));
  return settle.map((r, i) => ({ sport: sports[i], ok: r.status === 'fulfilled', result: r.value }));
}

// Periodic-warm loop handle so callers (and tests) can start/stop it cleanly.
let _warmLoopTimer = null;
// 15s interval (tightened from 30s 2026-04-22). Bounds the window between a
// newly-registered PX event and its first alt-line warm — i.e., the window
// where the first RFQ touching a non-primary line pays on-demand fetch
// latency. TTL gating (ALT_LINES_TTL_MS = 10 min) means events already
// warm get skipped, so the tighter interval doesn't meaningfully multiply
// API quota — it just shortens the new-event coverage gap. With soccer now
// in the pre-warm set (see SPORTS_WITH_ALT_MARKETS), 15s is a better
// match to how quickly soccer RFQ flow can hit a freshly-registered game.
// Tightened 15s → 8s (2026-05-13): the warm loop is the safety net that
// catches events PX has registered but resolveUnknownLine hasn't yet
// touched. Shorter interval = newer events get pre-warmed faster.
// TTL gating (10 min) means fresh entries skip the actual fetch, so the
// effective Odds API cost increase is limited to new-event coverage.
const WARM_LOOP_INTERVAL_MS = parseInt(process.env.WARM_LOOP_INTERVAL_MS) || 8 * 1000;

/**
 * Start the background warm loop. Safe to call multiple times — second calls
 * are no-ops. Runs warmAllSports every WARM_LOOP_INTERVAL_MS (60s).
 * Deploy-survival: warmAltLines skips events already fresh under ALT_LINES_TTL_MS,
 * so the loop doesn't hammer The Odds API after the initial population.
 */
function startAltLineWarmLoop() {
  if (_warmLoopTimer) return;
  _warmLoopTimer = setInterval(() => {
    warmAllSports().catch(err => {
      log.warn('OddsFeed', `Alt-line warm loop failed: ${err.message}`);
    });
  }, WARM_LOOP_INTERVAL_MS);
  log.info('OddsFeed', `Alt-line warm loop started (every ${WARM_LOOP_INTERVAL_MS / 1000}s)`);
}

// ---------------------------------------------------------------------------
// Pinnacle line-verify cache warmer
// ---------------------------------------------------------------------------
// Pre-warms _pinVerifyCache entries before their 30s TTL expires so RFQs
// with primary spread/total legs never pay the 20-30ms cold-cache fetch
// inline. Sequential across (sport, market) combos with inter-request
// pacing to stay well under Odds API's token bucket.
//
// Without this, the first primary spread/total RFQ per (sport, market)
// per 30s window paid the full verify fetch — manifesting as a p95 spike
// while p50 stayed fast. The pricer's verifyLineWithPinnacle sits behind
// Promise.all alongside getFairProbAsync, so its cost hits every RFQ
// whose line matches the cached primary (which is most primary-line
// RFQs — the common case).
//
// Scope: only the (sport, market) combos we actually serve. Derives from
// PINNACLE_SPORT_MAP ∩ supportedSports × {spreads, totals}.
let _pinVerifyWarmTimer = null;
const PIN_VERIFY_WARM_INTERVAL_MS = 20 * 1000; // 20s inside 30s TTL
const PIN_VERIFY_WARM_DELAY_MS = 120;          // inter-request pacing

// Demand-aware gating. Only warm combos that have been touched by an
// RFQ's verifyLineWithPinnacle call in the last N minutes. Quiet combos
// (e.g. MMA with 73 events but zero RFQs this hour) stop consuming
// Odds API quota. Newly-active combos pay one cold-cache verify (~20ms)
// on the first RFQ after a cold period — acceptable trade vs. the
// ~60-75% quota reduction when most leagues sit idle.
const PIN_VERIFY_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
const _pinVerifyRfqTouch = {}; // comboKey -> last-RFQ timestamp

// Core sports always stay in the warm rotation regardless of recent
// RFQ activity. These are our primary volume drivers — we accept the
// 6 fetches / 20s cost for them to avoid ever paying cold-verify on a
// primary-line RFQ in an active league. Everything NOT in this set
// goes demand-aware (soccer niche leagues, MMA, etc.). Cost: ~18
// fetches/min always-on; still ~80% below the pre-patch baseline.
const _pinVerifyAlwaysWarmSports = new Set([
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
]);

// Persistent-error cooldown. If a combo fails N cycles in a row, park
// it for 10 min — typically means Pinnacle doesn't cover that sport/
// market on The Odds API's event-list endpoint (verified for NWSL,
// Libertadores). Saves wasted fetches without permanently blocking
// retries in case coverage returns.
const PIN_VERIFY_ERROR_COOLDOWN_MS = 10 * 60 * 1000;
const PIN_VERIFY_ERROR_THRESHOLD = 3;
const _pinVerifyErrorStreak = {}; // comboKey -> { count, cooldownStartAt }

const _pinVerifyWarmStats = {
  cyclesRun: 0,
  cyclesCompletedAt: null,
  lastCycleMs: null,
  totalFetches: 0,
  totalSkippedFresh: 0,
  totalSkippedInactive: 0,
  totalSkippedErrorCooldown: 0,
  totalErrors: 0,
  perCombo: {}, // `${sport}|${market}` -> { fetched, skippedFresh, skippedInactive, errors, lastFetchedAt, lastRfqAt, errorStreak, cooldownUntil }
};

// Called from verifyLineWithPinnacle on every hot-path invocation so the
// warm loop knows which combos are actually serving RFQs.
function _touchPinVerifyCombo(comboKey) {
  _pinVerifyRfqTouch[comboKey] = Date.now();
}

async function _runPinVerifyWarmCycle() {
  const t0 = Date.now();
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return;

  const supported = new Set(config.supportedSports || []);
  const combos = [];
  for (const [ourSport, apiSport] of Object.entries(PINNACLE_SPORT_MAP)) {
    if (!supported.has(ourSport)) continue;
    combos.push({ apiSport, market: 'spreads' });
    combos.push({ apiSport, market: 'totals' });
  }
  // Sequential with inter-request pacing. Effective rate ~8 req/s per
  // warm cycle, well under Odds API's ~100 req/s ceiling.
  for (let i = 0; i < combos.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, PIN_VERIFY_WARM_DELAY_MS));
    const { apiSport, market } = combos[i];
    const comboKey = apiSport + '|' + market;
    const stats = _pinVerifyWarmStats.perCombo[comboKey] || {
      fetched: 0, skippedFresh: 0, skippedInactive: 0, errors: 0,
      lastFetchedAt: null, lastRfqAt: null, errorStreak: 0, cooldownUntil: null,
    };
    const now = Date.now();

    // Gate A: error cooldown. If we've seen N consecutive failures, park
    // this combo for PIN_VERIFY_ERROR_COOLDOWN_MS before trying again.
    const err = _pinVerifyErrorStreak[comboKey];
    if (err && err.cooldownStartAt && (now - err.cooldownStartAt) < PIN_VERIFY_ERROR_COOLDOWN_MS) {
      _pinVerifyWarmStats.totalSkippedErrorCooldown++;
      stats.cooldownUntil = new Date(err.cooldownStartAt + PIN_VERIFY_ERROR_COOLDOWN_MS).toISOString();
      _pinVerifyWarmStats.perCombo[comboKey] = stats;
      continue;
    }
    // Cooldown expired or never triggered — clear any stale state.
    if (err && err.cooldownStartAt && (now - err.cooldownStartAt) >= PIN_VERIFY_ERROR_COOLDOWN_MS) {
      delete _pinVerifyErrorStreak[comboKey];
      stats.cooldownUntil = null;
    }

    // Gate B: demand activity. Skip combos that haven't served an RFQ
    // in the activity window. First-time combos get one grace cycle so
    // the cache is populated before any RFQ lands; thereafter they must
    // earn continued warming via RFQ traffic.
    //
    // Always-warm core sports (NBA/MLB/NHL) bypass this gate — we
    // accept the fetch cost to guarantee no cold-verify tails for
    // primary volume drivers. They still get Gate A (error cooldown)
    // and Gate C (skip-if-very-fresh).
    const lastRfq = _pinVerifyRfqTouch[comboKey];
    stats.lastRfqAt = lastRfq ? new Date(lastRfq).toISOString() : null;
    // `apiSport` value happens to equal our internal sport key for the
    // always-warm trio; Pinnacle mapping is identity for those.
    const isAlwaysWarm = _pinVerifyAlwaysWarmSports.has(apiSport);
    const hasEverWarmed = stats.fetched > 0;
    if (!isAlwaysWarm && hasEverWarmed && (!lastRfq || (now - lastRfq) > PIN_VERIFY_ACTIVITY_WINDOW_MS)) {
      stats.skippedInactive++;
      _pinVerifyWarmStats.totalSkippedInactive++;
      _pinVerifyWarmStats.perCombo[comboKey] = stats;
      continue;
    }

    // Gate C: skip if entry was refreshed very recently. With 20s cycle
    // + 30s TTL, refresh when age >= 10s to keep cache always ≥ 10s
    // from expiry when an RFQ hits.
    const cached = _pinVerifyCache[comboKey];
    if (cached && (now - cached.fetchedAt) < 10 * 1000) {
      stats.skippedFresh++;
      _pinVerifyWarmStats.totalSkippedFresh++;
      _pinVerifyWarmStats.perCombo[comboKey] = stats;
      continue;
    }

    try {
      const events = await _fetchPinVerifyEvents(apiSport, market, theOddsApiKey);
      if (events) {
        stats.fetched++;
        stats.lastFetchedAt = new Date().toISOString();
        stats.errorStreak = 0;
        _pinVerifyWarmStats.totalFetches++;
        delete _pinVerifyErrorStreak[comboKey]; // success clears any streak
      } else {
        stats.errors++;
        stats.errorStreak = (stats.errorStreak || 0) + 1;
        _pinVerifyWarmStats.totalErrors++;
        // Track consecutive errors. Trip cooldown on threshold.
        const streak = (_pinVerifyErrorStreak[comboKey] || { count: 0 }).count + 1;
        _pinVerifyErrorStreak[comboKey] = {
          count: streak,
          cooldownStartAt: streak >= PIN_VERIFY_ERROR_THRESHOLD ? Date.now() : null,
        };
        if (streak >= PIN_VERIFY_ERROR_THRESHOLD) {
          stats.cooldownUntil = new Date(Date.now() + PIN_VERIFY_ERROR_COOLDOWN_MS).toISOString();
          log.info('OddsFeed', `Pin verify cooldown ${comboKey} (${streak} consecutive errors)`);
        }
      }
    } catch (e) {
      stats.errors++;
      stats.errorStreak = (stats.errorStreak || 0) + 1;
      _pinVerifyWarmStats.totalErrors++;
    }
    _pinVerifyWarmStats.perCombo[comboKey] = stats;
  }
  _pinVerifyWarmStats.cyclesRun++;
  _pinVerifyWarmStats.lastCycleMs = Date.now() - t0;
  _pinVerifyWarmStats.cyclesCompletedAt = new Date().toISOString();
}

function startPinVerifyWarmLoop() {
  if (_pinVerifyWarmTimer) return;
  // Fire immediate cycle so cache is populated before any RFQ arrives.
  _runPinVerifyWarmCycle().catch(err => {
    log.warn('OddsFeed', `Pin verify initial warm failed: ${err.message}`);
  });
  _pinVerifyWarmTimer = setInterval(() => {
    _runPinVerifyWarmCycle().catch(err => {
      log.warn('OddsFeed', `Pin verify warm loop failed: ${err.message}`);
    });
  }, PIN_VERIFY_WARM_INTERVAL_MS);
  log.info('OddsFeed', `Pin verify warm loop started (every ${PIN_VERIFY_WARM_INTERVAL_MS / 1000}s)`);
}

function getPinVerifyWarmStats() {
  // Snapshot cache state for visibility
  const now = Date.now();
  const cacheEntries = Object.entries(_pinVerifyCache).map(([k, v]) => ({
    comboKey: k,
    ageSec: Math.round((now - v.fetchedAt) / 1000),
    eventCount: (v.events || []).length,
  }));
  return {
    ..._pinVerifyWarmStats,
    intervalMs: PIN_VERIFY_WARM_INTERVAL_MS,
    cacheSize: Object.keys(_pinVerifyCache).length,
    cacheEntries,
  };
}

// Bovada scraper loop. Runs every 2 min — matches the primary odds
// cycle. Per-event cache TTL inside the scraper (10 min) means most
// calls are cheap skip operations. First run at startup populates
// cache before any alt-line RFQs arrive.
let _bovadaLoopTimer = null;
const BOVADA_LOOP_INTERVAL_MS = 2 * 60 * 1000;
function startBovadaAltLoop() {
  if (_bovadaLoopTimer) return;
  // Initial refresh fire-and-forget — errors logged by the scraper
  bovadaAltScraper.refreshAll().catch(err => {
    log.warn('OddsFeed', `Bovada initial refresh failed: ${err.message}`);
  });
  _bovadaLoopTimer = setInterval(() => {
    bovadaAltScraper.refreshAll().catch(err => {
      log.warn('OddsFeed', `Bovada refresh loop failed: ${err.message}`);
    });
  }, BOVADA_LOOP_INTERVAL_MS);
  log.info('OddsFeed', `Bovada alt-line loop started (every ${BOVADA_LOOP_INTERVAL_MS / 1000}s)`);
}

// ---------------------------------------------------------------------------
// Just-in-time (JIT) single-event warm
// ---------------------------------------------------------------------------
// Called by line-manager when a new PX event is registered (either during
// seed or on-demand via resolveUnknownLine). Fires a single-event alt-line
// fetch immediately rather than waiting up to WARM_LOOP_INTERVAL_MS (15s)
// for the periodic sweep to discover it.
//
// Safety rails:
//   - Dedupes against in-flight warms (per-event key) so repeated calls
//     from seed + resolveUnknownLine + rapid reseeds coalesce.
//   - Skips when altLinesCache has a fresh entry (< ALT_LINES_TTL_MS).
//   - Skips events outside the warm window (already started / too far out).
//   - Throttled by a global concurrency cap (JIT_WARM_CONCURRENCY) so a
//     large seed doesn't burst-call resolveOddsApiEventId + fetchAltLines
//     in parallel and 429 the Odds API.
//
// Fire-and-forget contract: callers don't await — they pass through the
// promise (or ignore it) and let the queue drain in background.
//
// Bumped 2 → 5 (2026-05-13): at concurrency 2, a fresh seed of ~200
// events takes ~200×RTT/2 ≈ 5s to fully drain, during which RFQs on
// not-yet-warmed events stall ~40ms in getFairProbAsync. Bumping to 5
// shaves the drain time to ~2s. The Odds API quota cost is unchanged —
// same total fetches, just dispatched in larger parallel waves. TOA's
// per-account rate limit handles 5-wide concurrency comfortably.
const JIT_WARM_CONCURRENCY = parseInt(process.env.JIT_WARM_CONCURRENCY) || 5;
const _jitInFlight = new Map(); // normalizedKey -> Promise
let _jitRunning = 0;
const _jitPending = []; // [{task, resolve, reject}]
const _jitStats = {
  fired: 0, skippedFresh: 0, skippedNoAltSport: 0,
  skippedStarted: 0, skippedTooFar: 0, skippedMissingFields: 0,
  deduped: 0, fetched: 0, noMatch: 0, errors: 0,
  lastFiredAt: null,
};

function _drainJitQueue() {
  while (_jitRunning < JIT_WARM_CONCURRENCY && _jitPending.length > 0) {
    const { task, resolve, reject } = _jitPending.shift();
    _jitRunning++;
    task()
      .then(resolve, reject)
      .finally(() => {
        _jitRunning--;
        _drainJitQueue();
      });
  }
}

function _runQueuedJit(task) {
  return new Promise((resolve, reject) => {
    _jitPending.push({ task, resolve, reject });
    _drainJitQueue();
  });
}

/**
 * Warm alt-line cache for a single event immediately. Idempotent and
 * safely callable from any registration path. Returns a promise the
 * caller may ignore (fire-and-forget).
 *
 * @param {object} args
 * @param {string} args.sport        Odds API sport key (e.g. 'basketball_nba')
 * @param {string} args.homeTeam     Odds API canonical home team
 * @param {string} args.awayTeam     Odds API canonical away team
 * @param {string|null} args.commenceTime ISO-8601 or null
 */
function warmEventAltLinesJIT({ sport, homeTeam, awayTeam, commenceTime }) {
  if (!sport || !homeTeam || !awayTeam) {
    _jitStats.skippedMissingFields++;
    return Promise.resolve({ status: 'skipped_missing_fields' });
  }
  // Same gate as warmAltLines — only sports we actually pre-warm have
  // meaningful alt-line coverage. On-demand sports (soccer niche leagues)
  // also welcome the JIT since they aren't on the periodic sweep.
  if (!sportSupportsAltLines(sport)) {
    _jitStats.skippedNoAltSport++;
    return Promise.resolve({ status: 'skipped_no_alt_sport', sport });
  }
  const now = Date.now();
  const startMs = commenceTime ? new Date(commenceTime).getTime() : null;
  if (startMs && !isNaN(startMs)) {
    if (startMs < now) {
      _jitStats.skippedStarted++;
      return Promise.resolve({ status: 'skipped_started' });
    }
    if (startMs > now + WARM_EVENT_MAX_HOURS_AHEAD * 3600 * 1000) {
      _jitStats.skippedTooFar++;
      return Promise.resolve({ status: 'skipped_too_far' });
    }
  }
  const key = normalizeEventKey(homeTeam, awayTeam);
  const cached = altLinesCache[key];
  if (cached && (now - cached.fetchedAt) < ALT_LINES_TTL_MS) {
    _jitStats.skippedFresh++;
    return Promise.resolve({ status: 'skipped_fresh', key });
  }
  const pending = _jitInFlight.get(key);
  if (pending) {
    _jitStats.deduped++;
    return pending;
  }

  const promise = _runQueuedJit(async () => {
    _jitStats.fired++;
    _jitStats.lastFiredAt = new Date().toISOString();
    try {
      // Pre-check match so stats can distinguish "Odds API doesn't have
      // this event" from "fetch errored."
      const resolved = await resolveOddsApiEventId(sport, homeTeam, awayTeam, commenceTime);
      if (!resolved) {
        _jitStats.noMatch++;
        return { status: 'no_match', key, sport };
      }
      const r = await fetchAltLines(sport, homeTeam, awayTeam, commenceTime);
      if (r) {
        _jitStats.fetched++;
        log.debug('OddsFeed', `JIT warm: ${sport} ${awayTeam} @ ${homeTeam} fetched (${_jitStats.fetched} total)`);
        return { status: 'fetched', key, sport };
      }
      _jitStats.errors++;
      return { status: 'empty', key, sport };
    } catch (err) {
      _jitStats.errors++;
      log.warn('OddsFeed', `JIT warm failed for ${homeTeam} vs ${awayTeam}: ${err.message}`);
      return { status: 'error', key, sport, error: err.message };
    }
  }).finally(() => {
    _jitInFlight.delete(key);
  });

  _jitInFlight.set(key, promise);
  return promise;
}

function getJitWarmStats() {
  return {
    ..._jitStats,
    concurrencyCap: JIT_WARM_CONCURRENCY,
    inFlight: _jitRunning,
    queued: _jitPending.length,
    inFlightKeys: _jitInFlight.size,
  };
}

function getAltLinesWarmStats() {
  const cacheSize = Object.keys(altLinesCache).length;
  // Compute staleness distribution
  const now = Date.now();
  let fresh = 0, stale = 0;
  for (const entry of Object.values(altLinesCache)) {
    if ((now - entry.fetchedAt) < ALT_LINES_TTL_MS) fresh++;
    else stale++;
  }
  return {
    cacheSize,
    fresh,
    stale,
    ttlMinutes: ALT_LINES_TTL_MS / 60000,
    lastWarmBySport: _lastWarmStats || {},
  };
}

// ---------------------------------------------------------------------------
// CACHE LOOKUP
// ---------------------------------------------------------------------------

/**
 * Get fair probability — sync version, uses cached data only.
 * @param {string} targetTime - optional ISO timestamp for time-aware matching
 */
function getFairProb(sport, homeTeam, awayTeam, marketType, selection, line, targetTime) {
  let event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  // Reversed-orientation fallback — some cache entries (notably DK-scraped
  // MMA fights) are stored under (fighterA, fighterB) while the line-manager
  // registered them as (fighterB, fighterA) based on PX's competitor order.
  // If the forward lookup misses, try reversed and flip home/away semantics
  // so the selection still resolves correctly.
  let orientationFlipped = false;
  if (!event) {
    event = getEventMarkets(sport, awayTeam, homeTeam, targetTime);
    if (event) orientationFlipped = true;
  }
  if (!event) {
    // Last-resort fallback: SharpAPI primary cache doesn't have this
    // game (event not yet cached, team-name mismatch, sport gap), but
    // TOA-populated altLinesCache might. Operator caught 2026-04-27:
    // MLB integer totals like O 8 declining as "no fair value" because
    // SharpAPI Hobby tier doesn't return Pinnacle's primary integer 8,
    // and the early `event == null` exit short-circuited the alt path.
    //
    // Only applies to spreads/totals (where alt cache exists) and
    // requires a non-null line (lookup needs the line value).
    if (line != null && (marketType === 'spreads' || marketType === 'totals')) {
      const altProb = getAltLineFairProb(
        normalizeEventKey(homeTeam, awayTeam), marketType, selection, line
      );
      if (altProb != null && altProb > 0 && altProb < 1) return altProb;
    }
    return null;
  }

  // Flip selection when we found the event under reversed orientation.
  // - h2h / moneyline: home↔away
  // - spreads: home↔away + sign of line flips (home -3 ↔ away +3). We
  //   invert `line` here so downstream alt-line matching stays correct.
  // - totals: over/under are team-agnostic, no change
  // - team_totals: home_over↔away_over, home_under↔away_under
  if (orientationFlipped) {
    if (marketType === 'h2h') {
      selection = selection === 'home' ? 'away' : selection === 'away' ? 'home' : selection;
    } else if (marketType === 'spreads') {
      selection = selection === 'home' ? 'away' : selection === 'away' ? 'home' : selection;
      if (line != null) line = -line;
    } else if (marketType === 'team_totals') {
      if (selection && selection.startsWith('home_')) selection = 'away_' + selection.slice(5);
      else if (selection && selection.startsWith('away_')) selection = 'home_' + selection.slice(5);
    }
  }

  const market = event.markets[marketType];
  if (!market) {
    // Primary cache miss for F5 spread/total. Fall through to the alt
    // cache (may have been populated by fetchAltLines). If alt data
    // isn't there either, getFairProbAsync will trigger the per-event
    // fetch and retry — this path just handles warm-cache alt hits.
    if ((marketType === 'spreads_f5' || marketType === 'totals_f5') && line != null) {
      const altKey = normalizeEventKey(homeTeam, awayTeam);
      return getAltLineFairProb(altKey, marketType, selection, line);
    }
    return null;
  }

  // ---- TENNIS SET MARKETS -------------------------------------------------
  // Resolved here rather than falling through the h2h/spreads/totals ladder
  // below, which has no notion of them and would return null — i.e. every set
  // RFQ would decline "no fair value" despite the fair sitting in the cache.
  // The orientation flip above does not cover these keys either, so each
  // handles it inline; getting that wrong silently swaps the two players.
  if (marketType === 'first_set_moneyline') {
    const side = orientationFlipped
      ? (selection === 'home' ? 'away' : selection === 'away' ? 'home' : selection)
      : selection;
    const o = market[side];
    return (o && o.fairProb > 0 && o.fairProb < 1) ? o.fairProb : null;
  }
  if (marketType === 'total_sets') {
    // PX lists exactly one line (2.5). Refuse anything else rather than
    // pricing a different total off it.
    if (line != null && Number(line) !== 2.5) return null;
    const o = market[selection];               // 'over' | 'under'
    return (o && o.fairProb > 0 && o.fairProb < 1) ? o.fairProb : null;
  }
  if (marketType === 'set_win_at_least_one') {
    // selection is '<side>_<yes|no>'. The stored fairProb is that player's
    // P(wins >= 1 set); NO is its exact complement (they get swept).
    const parts = String(selection || '').split('_');
    let side = parts[0], yn = parts[1];
    if (orientationFlipped) side = side === 'home' ? 'away' : side === 'away' ? 'home' : side;
    const o = market[side];
    if (!o || !(o.fairProb > 0 && o.fairProb < 1)) return null;
    return yn === 'no' ? 1 - o.fairProb : o.fairProb;
  }

  if (marketType === 'spreads' || marketType === 'totals' || marketType === 'spreads_f5' || marketType === 'totals_f5') {
    // CRITICAL: spreads/totals (full-game OR F5) MUST have a line value
    // to price correctly. Without a line, we can't distinguish Over 4.5
    // from Over 5.5 — returning the primary fair prob would be
    // catastrophically wrong for alt lines. (Root cause of +377
    // mispricing on full-game Over 4.5 + Under 5.5 parlay, 2026-04-12;
    // and the current F5 totals_f5 5.5 alt-line decline cluster.)
    if (line == null) {
      log.warn('OddsFeed', `getFairProb: null line for ${marketType} ${selection} ${homeTeam} vs ${awayTeam} — declining to avoid primary-line contamination`);
      return null;
    }

    if (market.line != null) {
      const absLine = Math.abs(line);
      const lineDiff = Math.abs(Math.abs(market.line) - absLine);
      if (lineDiff > 0.01) {
        // Strict-mode distance guard: for soccer (and other ondemand-alt
        // sports), decline outright if the alt line is too far from
        // primary. The further out on the tail, the less reliable the
        // de-vigged fair, and correlation to primary weakens — sanity
        // checks may not catch a bad one.
        const maxDist = altMaxLineDistance(sport);
        if (lineDiff > maxDist) {
          log.warn('OddsFeed', `Alt ${marketType} distance guard: |${line} - ${market.line}| = ${lineDiff.toFixed(1)} > max ${maxDist} for ${sport} ${homeTeam} vs ${awayTeam} — declining`);
          return null;
        }
        // Line magnitude doesn't match primary. First try the per-line
        // consensus in market.byLine — populated by buildConsensusTotals
        // for every distinct line across books, so minority lines (e.g.
        // Pinnacle's integer 8 when majority is 8.5) resolve without a
        // network fetch. Applies to totals AND F5/H1 sub-game totals;
        // the supplement that builds totals_f5/totals_h1 also populates
        // byLine. Spreads have signed home_point bucketing via
        // getAltLineFairProb instead.
        if ((marketType === 'totals' || marketType === 'totals_f5' || marketType === 'totals_h1') && market.byLine) {
          const byLineEntry = market.byLine[String(absLine)];
          if (byLineEntry) {
            const sideProb = selection === 'over' ? byLineEntry.over?.fairProb : byLineEntry.under?.fairProb;
            if (sideProb != null && sideProb > 0 && sideProb < 1) return sideProb;
          }
        }
        // For spreads / spreads_f5 / spreads_h1: check the per-line
        // consensus map populated by buildConsensusSpread. Same pattern
        // as the totals byLine fast-path above. Captures the case where
        // different books post different primary lines (Pinnacle line=0
        // pick-em, DK/FD line=±0.5 standard) and we'd otherwise lose
        // the non-modal-line data when collapsing to a single primary.
        if ((marketType === 'spreads' || marketType === 'spreads_f5' || marketType === 'spreads_h1') && market.byLine) {
          const sideKey = selection + '|' + line; // signed-line key
          const byLineEntry = market.byLine[sideKey];
          if (byLineEntry) {
            const sideProb = byLineEntry.fairProb;
            if (sideProb != null && sideProb > 0 && sideProb < 1) return sideProb;
          }
        }
        // Pass the SIGNED line so getAltLineFairProb can route to the correct
        // signed home_point bucket (critical: sign flips on alt spreads).
        const key = normalizeEventKey(homeTeam, awayTeam);
        const altProb = getAltLineFairProb(key, marketType, selection, line);
        if (altProb != null) {
          // Strict-mode sport check: require ≥ 2 books for the alt line.
          // The Odds API soccer alt coverage is thin on Hobby tier; a
          // single-book alt fair is too noisy to trust. This inspects
          // the raw cache entry, which carries books + byBook from
          // ingestion.
          if (isStrictAltSanitySport(sport)) {
            const altEntry = getAltLineCacheEntry(key, marketType, selection, line);
            const bookCount = altEntry ? altEntry.books : 0;
            if (bookCount < 2) {
              log.warn('OddsFeed', `Alt ${marketType} strict-book check: ${sport} ${selection} ${line} has only ${bookCount} book(s) — declining (min 2)`);
              return null;
            }
          }
          // Sanity: for totals far from primary, verify direction makes sense.
          // Over a low total (e.g. 4.5 when primary is 8.5) should be a heavy
          // favorite (fairProb >= 0.60). Under a low total should be an underdog.
          // Vice versa for high totals.  If violated, the alt line data may be
          // corrupted (swapped over/under, wrong point, stale cache).
          const sanityThreshold = altSanityLineDiffThreshold(sport);
          if (marketType === 'totals' && lineDiff >= sanityThreshold) {
            const expectHigh = (selection === 'over' && line < market.line) || (selection === 'under' && line > market.line);
            if (expectHigh && altProb < 0.55) {
              log.warn('OddsFeed', `Alt total sanity FAIL: ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} — expected heavy favorite, got underdog. Declining.`);
              return null;
            }
            // Strict sports also enforce the reverse: over-a-high-total
            // should be an underdog (fairProb < 0.45) when we're clearly
            // out on the tail. Catches swapped-side bugs where the alt
            // cache returns the fair for the OPPOSITE direction.
            if (isStrictAltSanitySport(sport)) {
              const expectLow = (selection === 'over' && line > market.line) || (selection === 'under' && line < market.line);
              if (expectLow && altProb > 0.55) {
                log.warn('OddsFeed', `Alt total strict sanity FAIL: ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} — expected underdog, got favorite. Declining.`);
                return null;
              }
            }
          }
          // Sanity: for alt spreads far from primary, verify direction makes sense.
          // If primary home spread is -5.5 and we're pricing home -0.5 (easier to
          // cover), the fair prob should be HIGHER than the primary. If it's lower,
          // the alt line data may have sign-flipped home/away probs.
          if (marketType === 'spreads' && lineDiff >= 2.0) {
            const primaryProb = selection === 'home' ? market.home?.fairProb : market.away?.fairProb;
            if (primaryProb != null) {
              // "Easier to cover" = smaller absolute handicap for the team
              const absAlt = Math.abs(line);
              const absPrimary = Math.abs(market.line);
              const easierToCover = (selection === 'home')
                ? (line > market.line) // home -0.5 is easier than home -5.5
                : (line < market.line); // away +0.5 is easier than away +5.5
              if (easierToCover && altProb < primaryProb - 0.05) {
                log.warn('OddsFeed', `Alt spread sanity FAIL: ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} < primary=${primaryProb.toFixed(4)} — easier line should have higher prob. Declining.`);
                return null;
              }
              if (!easierToCover && altProb > primaryProb + 0.05) {
                log.warn('OddsFeed', `Alt spread sanity FAIL: ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} > primary=${primaryProb.toFixed(4)} — harder line should have lower prob. Declining.`);
                return null;
              }
            }
          }
          return altProb;
        }
        return null;
      }

      // Magnitude matches — verify spread DIRECTION is correct.
      // For spreads: if selection is 'home', the cached home point should have the
      // same sign as the requested line. E.g., if home is -1.5 (favorite) but
      // request is +1.5, the bettor wants the alt side, not the primary.
      if (marketType === 'spreads' && line !== 0) {
        const cachedPoint = selection === 'home' ? market.home?.point : market.away?.point;
        if (cachedPoint != null && Math.sign(cachedPoint) !== Math.sign(line)) {
          // Direction mismatch — requested +1.5 but team is -1.5 (or vice versa)
          // Treat as alt line, not primary
          log.info('OddsFeed', `Spread direction mismatch: ${selection} cached ${cachedPoint} vs requested ${line} for ${homeTeam} vs ${awayTeam}`);
          const key = normalizeEventKey(homeTeam, awayTeam);
          const altProb = getAltLineFairProb(key, marketType, selection, line);
          if (altProb != null) return altProb;
          return null; // no alt line data — decline
        }
      }
    } else {
      // market.line is null — can't verify if request matches primary.
      // Route to alt lines; if not cached, decline rather than risk
      // returning an unverified primary fair prob.
      log.warn('OddsFeed', `getFairProb: market.line is null for ${marketType}, requested line=${line} — trying alt lines only`);
      const key = normalizeEventKey(homeTeam, awayTeam);
      const altProb = getAltLineFairProb(key, marketType, selection, line);
      if (altProb != null) return altProb;
      return null;
    }
  }

  if (marketType === 'h2h') {
    // Sanity check: fair must be within 25pp of the side's rawOdds-implied
    // probability. Vig only displaces implied from fair by ~3-10pp; a 25pp+
    // gap means the cache has the WRONG side's fair attached to this side
    // (orientation flip / consensus-build sides mixed). Symptom that
    // triggered this guard: 5/5/2026 MMA card showed Jeremy Stephens fair
    // 26.6% while books had him at -340 (~77% implied) — would've quoted
    // him at +254 instead of -340. Returning null here forces the line to
    // decline at quote time and surfaces as fair=null in the Lines tab.
    const sideData = selection === 'home' ? market.home : selection === 'away' ? market.away : null;
    const fp = sideData?.fairProb || null;
    if (fp == null) return null;
    const am = sideData?.rawOdds;
    if (am != null && Number.isFinite(Number(am)) && Number(am) !== 0) {
      const a = Number(am);
      const impliedFromBooks = a > 0 ? 100 / (a + 100) : -a / (-a + 100);
      if (Math.abs(impliedFromBooks - fp) > 0.25) {
        log.warn('OddsFeed', `h2h fair-vs-rawOdds mismatch: ${homeTeam} vs ${awayTeam} ${selection} fairProb=${fp.toFixed(3)} but rawOdds=${a} implies ${impliedFromBooks.toFixed(3)} — returning null (likely orientation/consensus inversion)`);
        return null;
      }
    }
    return fp;
  } else if (marketType === 'spreads') {
    if (selection === 'home') return market.home?.fairProb || null;
    if (selection === 'away') return market.away?.fairProb || null;
  } else if (marketType === 'totals') {
    if (selection === 'over') return market.over?.fairProb || null;
    if (selection === 'under') return market.under?.fairProb || null;
  } else if (marketType === 'team_totals') {
    // Selection is compound: "home_over", "home_under", "away_over", "away_under"
    const parts = selection.split('_');
    const side = parts[0]; // "home" or "away"
    const dir = parts[1];  // "over" or "under"
    const teamData = market[side];
    if (!teamData) return null;
    // Require a line match against the cached primary OR a per-line
    // entry in byLine. Without this, an alt team-total registered by
    // PX (e.g. Lakers Over 114.5) would receive the primary line's
    // fair prob (e.g. Over 115.5) — wrong enough to leak money
    // systematically. Same safeguard rationale as totals/spreads above.
    // Line 0.01 tolerance for float noise.
    if (line == null) {
      log.warn('OddsFeed', `getFairProb: null line for team_totals ${side}_${dir} ${homeTeam} vs ${awayTeam} — declining`);
      return null;
    }
    if (teamData.line != null && Math.abs(teamData.line - line) > 0.01) {
      // Primary line doesn't match — check per-line consensus map. The
      // supplement now fetches alternate_team_totals from TOA and
      // buildConsensusTeamTotals stores each (team, line) consensus
      // under teamData.byLine[lineStr]. Picks up Cavaliers +112 / +112.5
      // alts that PX RFQs even when our primary is +111.5.
      if (teamData.byLine) {
        const altEntry = teamData.byLine[String(line)];
        if (altEntry) {
          if (dir === 'over') return altEntry.over?.fairProb || null;
          if (dir === 'under') return altEntry.under?.fairProb || null;
        }
      }
      return null;
    }
    if (dir === 'over') return teamData.over?.fairProb || null;
    if (dir === 'under') return teamData.under?.fairProb || null;
  } else if (marketType === 'h2h_3way') {
    // True 3-way board: home / draw / away, summing to 1. NOT interchangeable
    // with markets.h2h, which is a draw-no-bet basis -- see the ingest note.
    // PX posts each outcome as its own YES/NO market, so the NO side is the
    // complement of that single outcome (NOT the other two summed, though
    // they are equal by construction since the triple normalises to 1).
    if (selection === 'home' || selection === 'draw' || selection === 'away') {
      const p = market[selection]?.fairProb;
      return (typeof p === 'number' && p > 0 && p < 1) ? p : null;
    }
    const neg = /^no_(home|draw|away)$/.exec(selection || '');
    if (neg) {
      const p = market[neg[1]]?.fairProb;
      return (typeof p === 'number' && p > 0 && p < 1) ? 1 - p : null;
    }
    return null;
  } else if (marketType === 'btts') {
    if (selection === 'yes') return market.yes?.fairProb || null;
    if (selection === 'no') return market.no?.fairProb || null;
  } else if (marketType === 'double_chance') {
    // Selection: '1X' (home or draw), 'X2' (draw or away), '12' (home or away)
    if (market[selection]) return market[selection].fairProb || null;
  } else if (marketType === 'h2h_f5' || marketType === 'spreads_f5') {
    if (selection === 'home') return market.home?.fairProb || null;
    if (selection === 'away') return market.away?.fairProb || null;
  } else if (marketType === 'totals_f5') {
    if (selection === 'over') return market.over?.fairProb || null;
    if (selection === 'under') return market.under?.fairProb || null;
  } else if (marketType === 'h2h_h1' || marketType === 'spreads_h1') {
    if (selection === 'home') return market.home?.fairProb || null;
    if (selection === 'away') return market.away?.fairProb || null;
  } else if (marketType === 'totals_h1') {
    if (selection === 'over') return market.over?.fairProb || null;
    if (selection === 'under') return market.under?.fairProb || null;
  }

  return null;
}

/**
 * Get de-vigged consensus fair prob for display (different from pricing fairProb
 * which uses Pinnacle raw). Returns the displayFairProb or falls back to fairProb.
 */
function getDisplayFairProb(sport, homeTeam, awayTeam, marketType, selection, line, targetTime) {
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event) return null;
  const market = event.markets[marketType];
  if (!market) return null;

  // For spreads/totals, require the requested line to match the cached primary.
  // If it doesn't match (e.g. requested -0.5 but cache has -0.25), return null
  // so the dashboard shows a dash rather than the wrong line's fair value.
  // If line is null for spreads/totals, decline — can't verify match.
  if (marketType === 'spreads' || marketType === 'totals') {
    if (line == null || market.line == null) return null;
    if (Math.abs(Math.abs(market.line) - Math.abs(line)) > 0.01) return null;
  }

  if (marketType === 'h2h') {
    if (selection === 'home') return market.home?.displayFairProb || market.home?.fairProb || null;
    if (selection === 'away') return market.away?.displayFairProb || market.away?.fairProb || null;
  } else if (marketType === 'spreads') {
    if (selection === 'home') return market.home?.displayFairProb || market.home?.fairProb || null;
    if (selection === 'away') return market.away?.displayFairProb || market.away?.fairProb || null;
  } else if (marketType === 'totals') {
    if (selection === 'over') return market.over?.displayFairProb || market.over?.fairProb || null;
    if (selection === 'under') return market.under?.displayFairProb || market.under?.fairProb || null;
  } else if (marketType === 'team_totals') {
    const parts = selection.split('_');
    const teamData = market[parts[0]];
    if (!teamData) return null;
    const dir = parts[1];
    // Line-match check parallels getFairProb (line 4619): if the requested
    // line doesn't match the cached primary, fall back to byLine alts or
    // return null. Without this, a leg with line 103.5 received the primary
    // line's displayFairProb (e.g. 113.5) — wrong number on the FAIR column.
    if (line == null) return null;
    if (teamData.line != null && Math.abs(teamData.line - line) > 0.01) {
      if (teamData.byLine) {
        const altEntry = teamData.byLine[String(line)];
        if (altEntry) {
          if (dir === 'over') return altEntry.over?.displayFairProb || altEntry.over?.fairProb || null;
          if (dir === 'under') return altEntry.under?.displayFairProb || altEntry.under?.fairProb || null;
        }
      }
      return null;
    }
    if (dir === 'over') return teamData.over?.displayFairProb || teamData.over?.fairProb || null;
    if (dir === 'under') return teamData.under?.displayFairProb || teamData.under?.fairProb || null;
  } else if (marketType === 'h2h_h1' || marketType === 'spreads_h1') {
    if (selection === 'home') return market.home?.displayFairProb || market.home?.fairProb || null;
    if (selection === 'away') return market.away?.displayFairProb || market.away?.fairProb || null;
  } else if (marketType === 'totals_h1') {
    if (selection === 'over') return market.over?.displayFairProb || market.over?.fairProb || null;
    if (selection === 'under') return market.under?.displayFairProb || market.under?.fairProb || null;
  }
  return null;
}

/**
 * Get Pinnacle's raw American odds for a specific selection.
 * Returns the odds integer or null if Pinnacle data not available.
 */
/**
 * Returns true if the caller-requested line matches the market's primary
 * cached line. When they don't match, the per-book raw odds stored on the
 * primary line are for a DIFFERENT betting product (e.g. Arsenal -1.25 vs
 * Arsenal -1) and must NOT be reported to the caller — doing so corrupts
 * competitor comparisons. Callers should return null in that case.
 *
 * h2h (moneyline) and team_totals have no line — always match.
 */
function lineMatchesPrimary(market, marketType, requestedLine, selection) {
  if (marketType !== 'spreads' && marketType !== 'totals') return true;
  if (requestedLine == null) return false; // null line → can't verify match, route to alt
  if (market.line == null) return false;

  // Magnitude match first
  const magMatch = Math.abs(Math.abs(market.line) - Math.abs(requestedLine)) < 0.01;
  if (!magMatch) return false;

  // For spreads, also verify DIRECTION. Two spreads with the same magnitude
  // but different signs are different markets (e.g. Arsenal -1.5 vs Arsenal +1.5
  // is the same event but two distinct bets — home at point=-1.5 vs home at
  // point=+1.5). The primary cache holds a specific direction; if the RFQ
  // wants the other one, the per-book odds stored on the primary are for the
  // WRONG side and must not be returned. Route to alt-line cache instead.
  if (marketType === 'spreads' && requestedLine !== 0 && selection) {
    const cachedPoint = selection === 'home' ? market.home?.point : market.away?.point;
    if (cachedPoint != null && Math.sign(cachedPoint) !== Math.sign(requestedLine)) {
      return false;
    }
  }
  return true;
}

function getPinnacleOdds(sport, homeTeam, awayTeam, marketType, selection, targetTime, line) {
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event) return null;

  const market = event.markets[marketType];
  if (!market) return null;

  if (marketType === 'team_totals') {
    const parts = selection.split('_');
    const teamData = market[parts[0]];
    if (!teamData || !teamData.pinnacle) return null;
    if (parts[1] === 'over') return teamData.pinnacle.over || null;
    if (parts[1] === 'under') return teamData.pinnacle.under || null;
    return null;
  }

  if (!lineMatchesPrimary(market, marketType, line, selection)) {
    // Primary line doesn't match — try the alt-line per-book cache.
    return getAltLineBookOdds(homeTeam, awayTeam, marketType, selection, line, 'pinnacle');
  }
  if (!market.pinnacle) return null;
  if (marketType === 'h2h' || marketType === 'spreads'
      || marketType === 'h2h_h1' || marketType === 'spreads_h1'
      || marketType === 'h2h_f5' || marketType === 'spreads_f5') {
    if (selection === 'home') return market.pinnacle.home || null;
    if (selection === 'away') return market.pinnacle.away || null;
  } else if (marketType === 'totals' || marketType === 'totals_h1' || marketType === 'totals_f5') {
    if (selection === 'over') return market.pinnacle.over || null;
    if (selection === 'under') return market.pinnacle.under || null;
  }
  return null;
}

/**
 * Derive Draw No Bet (2-way) fair probability from 3-way h2h odds.
 * Removes the draw and renormalizes: DNB_home = P(home) / (P(home) + P(away))
 */
function getDNBFairProb(sport, homeTeam, awayTeam, selection, targetTime) {
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event) return null;

  const market = event.markets['h2h'];
  if (!market || !market.home?.fairProb || !market.away?.fairProb) return null;

  const pHome = market.home.fairProb;
  const pAway = market.away.fairProb;
  const total = pHome + pAway;
  if (total <= 0) return null;

  if (selection === 'home') return pHome / total;
  if (selection === 'away') return pAway / total;
  return null;
}

function getFanDuelOdds(sport, homeTeam, awayTeam, marketType, selection, targetTime, line) {
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event) return null;

  const market = event.markets[marketType];
  if (!market) return null;

  if (marketType === 'team_totals') {
    // Team totals don't store FanDuel separately in current implementation
    return null;
  }

  if (!lineMatchesPrimary(market, marketType, line, selection)) {
    return getAltLineBookOdds(homeTeam, awayTeam, marketType, selection, line, 'fanduel');
  }
  if (!market.fanduel) return null;
  if (marketType === 'h2h' || marketType === 'spreads'
      || marketType === 'h2h_h1' || marketType === 'spreads_h1'
      || marketType === 'h2h_f5' || marketType === 'spreads_f5') {
    if (selection === 'home') return market.fanduel.home || null;
    if (selection === 'away') return market.fanduel.away || null;
  } else if (marketType === 'totals' || marketType === 'totals_h1' || marketType === 'totals_f5') {
    if (selection === 'over') return market.fanduel.over || null;
    if (selection === 'under') return market.fanduel.under || null;
  }
  return null;
}

function getKalshiOdds(sport, homeTeam, awayTeam, marketType, selection, targetTime, line) {
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event) return null;

  const market = event.markets[marketType];
  if (!market) return null;

  if (marketType === 'team_totals') return null;

  if (!lineMatchesPrimary(market, marketType, line, selection)) {
    return getAltLineBookOdds(homeTeam, awayTeam, marketType, selection, line, 'kalshi');
  }
  if (!market.kalshi) return null;
  if (marketType === 'h2h' || marketType === 'spreads'
      || marketType === 'h2h_h1' || marketType === 'spreads_h1'
      || marketType === 'h2h_f5' || marketType === 'spreads_f5') {
    if (selection === 'home') return market.kalshi.home || null;
    if (selection === 'away') return market.kalshi.away || null;
  } else if (marketType === 'totals' || marketType === 'totals_h1' || marketType === 'totals_f5') {
    if (selection === 'over') return market.kalshi.over || null;
    if (selection === 'under') return market.kalshi.under || null;
  }
  return null;
}

function getDraftKingsOdds(sport, homeTeam, awayTeam, marketType, selection, targetTime, line) {
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event) return null;

  const market = event.markets[marketType];
  if (!market) return null;

  if (marketType === 'team_totals') return null;

  if (!lineMatchesPrimary(market, marketType, line, selection)) {
    return getAltLineBookOdds(homeTeam, awayTeam, marketType, selection, line, 'draftkings');
  }
  if (!market.draftkings) return null;
  if (marketType === 'h2h' || marketType === 'spreads'
      || marketType === 'h2h_h1' || marketType === 'spreads_h1'
      || marketType === 'h2h_f5' || marketType === 'spreads_f5') {
    if (selection === 'home') return market.draftkings.home || null;
    if (selection === 'away') return market.draftkings.away || null;
  } else if (marketType === 'totals' || marketType === 'totals_h1' || marketType === 'totals_f5') {
    if (selection === 'over') return market.draftkings.over || null;
    if (selection === 'under') return market.draftkings.under || null;
  }
  return null;
}

/**
 * Verify a spread/total line hasn't moved by spot-checking Pinnacle's current line.
 * Only called when the requested line matches our cached primary (the dangerous case).
 * Returns { ok: true } if line is confirmed, or { ok: false, currentLine } if moved.
 */
// Per-(sport, market) cache for verifyLineWithPinnacle's full events-list fetch.
// Key: `${oddsApiSport}|${market}` (market is "spreads" or "totals").
// Value: { fetchedAt, events } — events is the raw array from The Odds API.
//
// Why this matters: previously every spread/total RFQ made a fresh HTTPS
// call to The Odds API to verify the primary line. That's 20-30ms added to
// decline→price on every such RFQ. With a modest TTL we answer from cache
// instantly for most RFQs; a few per 30s window still pay the network cost.
//
// TTL calibration: line verifications are catching BIG moves (>1 point
// diff). Primary lines rarely move that much in 30 seconds — the stalePriceMinutes
// guard elsewhere catches slower drift. So 30s stale is safe for this check.
//
// If a single request is in flight, concurrent callers wait on its promise
// (inFlight map) — prevents N simultaneous RFQs from all firing duplicate
// fetches at once.
const _pinVerifyCache = {};
const _pinVerifyInFlight = {};
const PIN_VERIFY_TTL_MS = 30 * 1000;

// Stretched TTL accepted for the fast-fail path. The PIN_VERIFY_TTL_MS (30s)
// is the threshold for "definitely fresh"; entries older than that but
// under FAST_FAIL_STALE_OK_MS (10 min) are served back if the warmer
// is mid-fetch — better than blocking the RFQ for a TOA RTT.
const PIN_VERIFY_FAST_FAIL_STALE_OK_MS = 10 * 60 * 1000;
let _pinVerifyFastFailStats = { stale_served: 0, miss_skipped: 0, hits: 0 };

async function _fetchPinVerifyEvents(oddsApiSport, market, theOddsApiKey) {
  const cacheKey = oddsApiSport + '|' + market;
  const cached = _pinVerifyCache[cacheKey];
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) < PIN_VERIFY_TTL_MS) {
    _pinVerifyFastFailStats.hits++;
    return cached.events;
  }
  // Coalesce concurrent fetches on the same key.
  if (_pinVerifyInFlight[cacheKey]) {
    // 2026-05-13: don't await an in-flight fetch on the RFQ hot path. If
    // the warmer / a sibling RFQ already kicked off a fetch, we serve
    // stale-or-null and let the in-flight request populate cache for the
    // NEXT call. The await was costing 30-55ms p95 phase2 stalls on MLB/
    // NHL verify (sports that ARE in the always-warm set but where the
    // cycle hadn't completed before this RFQ landed).
    if (process.env.PINNACLE_VERIFY_FAST_FAIL_ON_MISS !== '0') {
      if (cached && (now - cached.fetchedAt) < PIN_VERIFY_FAST_FAIL_STALE_OK_MS) {
        _pinVerifyFastFailStats.stale_served++;
        return cached.events;
      }
      _pinVerifyFastFailStats.miss_skipped++;
      return null; // verifyLineWithPinnacle falls through to { ok: true } allow
    }
    return _pinVerifyInFlight[cacheKey];
  }
  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds`
    + `?apiKey=${theOddsApiKey}`
    + `&regions=eu`
    + `&markets=${market}`
    + `&bookmakers=pinnacle`
    + `&oddsFormat=american`;
  const promise = (async () => {
    try {
      const resp = await abortableFetch(url);
      if (!resp.ok) return null;
      const events = await resp.json();
      _pinVerifyCache[cacheKey] = { fetchedAt: Date.now(), events };
      return events;
    } catch (err) {
      log.debug('OddsFeed', `Pin verify events fetch failed: ${err.message}`);
      return null;
    } finally {
      delete _pinVerifyInFlight[cacheKey];
    }
  })();
  _pinVerifyInFlight[cacheKey] = promise;
  // 2026-05-13 hot-path bypass: don't await the fresh fetch — fire and
  // forget so the cache populates for the NEXT RFQ. Serve stale data if
  // we have it (within FAST_FAIL_STALE_OK_MS), else return null which
  // verifyLineWithPinnacle treats as "allow (can't verify)". The verify
  // is a safety check for >1pt line drift; accepting a 30s-10min stale
  // view is preferable to losing the auction by waiting 40ms.
  if (process.env.PINNACLE_VERIFY_FAST_FAIL_ON_MISS !== '0') {
    promise.catch(() => { /* warm-only; ignore errors */ });
    if (cached && (now - cached.fetchedAt) < PIN_VERIFY_FAST_FAIL_STALE_OK_MS) {
      _pinVerifyFastFailStats.stale_served++;
      return cached.events;
    }
    _pinVerifyFastFailStats.miss_skipped++;
    return null;
  }
  return promise;
}

function getPinVerifyFastFailStats() { return { ..._pinVerifyFastFailStats }; }

async function verifyLineWithPinnacle(sport, homeTeam, awayTeam, marketType, cachedLine) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  const oddsApiSport = PINNACLE_SPORT_MAP[sport] || ODDS_API_FALLBACK[sport]?.oddsApiSport;
  if (!theOddsApiKey || !oddsApiSport) return { ok: true }; // can't verify, allow

  try {
    const market = marketType === 'spreads' ? 'spreads' : 'totals';
    // Mark this combo as RFQ-active so the warm loop keeps it hot.
    // Quiet combos get demoted out of the warm rotation after
    // PIN_VERIFY_ACTIVITY_WINDOW_MS; this call brings them back in.
    if (typeof _touchPinVerifyCombo === 'function') {
      _touchPinVerifyCombo(oddsApiSport + '|' + market);
    }
    const events = await _fetchPinVerifyEvents(oddsApiSport, market, theOddsApiKey);
    if (!events) return { ok: true }; // fetch failed, allow

    // Find matching event
    const key = normalizeEventKey(homeTeam, awayTeam);
    for (const event of events) {
      const eventKey = normalizeEventKey(event.home_team, event.away_team);
      if (eventKey !== key) continue;

      const pinnacle = event.bookmakers?.find(b => b.key === 'pinnacle');
      if (!pinnacle) return { ok: true }; // no Pinnacle data, allow

      const mkt = pinnacle.markets?.find(m => m.key === market);
      if (!mkt || !mkt.outcomes || mkt.outcomes.length < 2) return { ok: true };

      const pinLine = mkt.outcomes[0]?.point;
      if (pinLine == null) return { ok: true };

      const lineDiff = Math.abs(Math.abs(pinLine) - Math.abs(cachedLine));
      if (lineDiff > 1.0) {
        log.warn('OddsFeed', `Spread line moved! Cached: ${cachedLine}, Pinnacle now: ${pinLine} (diff: ${lineDiff}) for ${homeTeam} vs ${awayTeam}`);
        return { ok: false, currentLine: pinLine, cachedLine, diff: lineDiff };
      }
      return { ok: true, currentLine: pinLine };
    }
    return { ok: true }; // event not found on Pinnacle, allow
  } catch (err) {
    log.debug('OddsFeed', `Pinnacle line verify failed: ${err.message}`);
    return { ok: true }; // error, allow
  }
}

/**
 * Get fair probability — async version. Falls back to on-demand alt line fetch.
 */
/**
 * Sync fast-path for alt-line fair-prob lookups. Returns a fair prob if
 * the alt-lines cache has a fresh entry covering (marketType, selection,
 * line) AND all sanity/strict-mode gates pass. Returns null otherwise —
 * callers must fall through to getFairProbAsync, which handles
 * cache-miss refetch, Bovada fallback, and non-spread/total market types.
 *
 * Why this exists: getFairProbAsync always does `await fetchAltLines(...)`
 * even when altLinesCache has the entry. The await resolves in O(1) but
 * the microtask hop + scheduling still costs 5-50ms under load depending
 * on event-loop pressure. Pricing an alt-line leg on a warm cache was
 * measured at 30-60ms (p95 62ms) before this path; the sync version
 * collapses that to sub-1ms. Primary-line legs already had this via
 * getFairProb — this extends the same treatment to alts.
 *
 * Sanity checks mirror getFairProbAsync exactly so behaviour is
 * identical on the success path. Any failing check returns null (not
 * a decline) so the caller can still try the async path for
 * completeness — e.g., sanity fail on stale sync data might pass once
 * the async refetch brings fresh numbers.
 */
// Per-reason counter for sync alt-line hit/miss paths. Lets us diagnose
// which miss class drives the RFQs that still fall through to the async
// path (cache stale vs line_not_cached vs sanity gates). Each call
// increments exactly one counter. `not_applicable` covers market types
// sync can't answer for (h2h, h1 variants, team_totals) — those are
// expected misses that route to the async Bovada fallback, not
// regressions. `last_miss_*` buckets a rolling sample of recent
// non-hit legs for hands-on debugging without burning log volume.
const _altSyncStats = {
  hit: 0,
  not_applicable: 0,
  cache_empty: 0,
  cache_stale: 0,
  distance_guard: 0,
  line_not_cached: 0,
  min_books_gate: 0,
  totals_sanity_fail: 0,
  spreads_sanity_fail: 0,
  lastHitAt: null,
  lastMissAt: null,
  recentMisses: [], // { reason, sport, home, away, marketType, selection, line, at }
};
function _recordAltSyncMiss(reason, ctx) {
  _altSyncStats[reason]++;
  _altSyncStats.lastMissAt = new Date().toISOString();
  // Keep last 20 misses for quick inspection
  _altSyncStats.recentMisses.push({ reason, ...ctx, at: _altSyncStats.lastMissAt });
  if (_altSyncStats.recentMisses.length > 20) _altSyncStats.recentMisses.shift();
}

function getAltLineFairProbSync(sport, homeTeam, awayTeam, marketType, selection, line, targetTime) {
  // Only spread/total (incl. F5) have alt-line caches. Other market
  // types (h1 variants, team_totals) flow through getFairProbAsync to
  // the Bovada fallback and must not short-circuit here.
  const isSpreadOrTotal = marketType === 'spreads' || marketType === 'totals'
                         || marketType === 'spreads_f5' || marketType === 'totals_f5';
  if (!isSpreadOrTotal || line == null) {
    _altSyncStats.not_applicable++;
    return null;
  }

  const ctx = { sport, home: homeTeam, away: awayTeam, marketType, selection, line };
  const key = normalizeEventKey(homeTeam, awayTeam);
  const cached = altLinesCache[key];
  if (!cached) { _recordAltSyncMiss('cache_empty', ctx); return null; }
  const cacheAge = Date.now() - cached.fetchedAt;
  if (cacheAge >= ALT_LINES_TTL_MS) {
    _recordAltSyncMiss('cache_stale', { ...ctx, ageMs: cacheAge });
    return null;
  }
  // Stale-but-usable: use the cached value AND fire a background refresh.
  // Without this, the cached entry would expire in the background and
  // the next sync caller would miss → fall through to async fetch with
  // 30-60ms HTTP latency. Firing the refresh proactively keeps the sync
  // path cache-warm. Gated by 'refreshing' bool so concurrent callers
  // don't dispatch multiple parallel refreshes for the same key.
  if (cacheAge >= ALT_LINES_REFRESH_AHEAD_MS && !cached.refreshing) {
    cached.refreshing = true;
    Promise.resolve().then(() =>
      _doAltLinesFetch(sport, homeTeam, awayTeam, targetTime, key)
        .catch(err => log.warn('OddsFeed', `Alt-lines bg refresh (sync-path) failed for ${key}: ${err.message}`))
        .finally(() => {
          const c = altLinesCache[key];
          if (c) c.refreshing = false;
        })
    );
  }

  // Distance guard (strict-mode) — mirrors async path line-by-line.
  const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
  const primaryMarket = event ? event.markets[marketType] : null;
  if (primaryMarket?.line != null) {
    const lineDiff0 = Math.abs(Math.abs(primaryMarket.line) - Math.abs(line));
    const maxDist = altMaxLineDistance(sport);
    if (lineDiff0 > maxDist) {
      _recordAltSyncMiss('distance_guard', { ...ctx, primary: primaryMarket.line, diff: lineDiff0 });
      return null;
    }
  }

  const altProb = getAltLineFairProb(key, marketType, selection, line);
  if (altProb == null) { _recordAltSyncMiss('line_not_cached', ctx); return null; }

  // Strict-mode min-book gate
  if (isStrictAltSanitySport(sport)) {
    const altEntry = getAltLineCacheEntry(key, marketType, selection, line);
    const bookCount = altEntry ? altEntry.books : 0;
    if (bookCount < 2) {
      _recordAltSyncMiss('min_books_gate', { ...ctx, books: bookCount });
      return null;
    }
  }

  // Directional sanity checks (mirror async path)
  const market = event ? event.markets[marketType] : null;
  const sanityThreshold = altSanityLineDiffThreshold(sport);
  if (marketType === 'totals' && market?.line != null) {
    const lineDiff = Math.abs(Math.abs(market.line) - Math.abs(line));
    if (lineDiff >= sanityThreshold) {
      const expectHigh = (selection === 'over' && line < market.line) || (selection === 'under' && line > market.line);
      if (expectHigh && altProb < 0.55) {
        _recordAltSyncMiss('totals_sanity_fail', { ...ctx, primary: market.line, altProb });
        return null;
      }
      if (isStrictAltSanitySport(sport)) {
        const expectLow = (selection === 'over' && line > market.line) || (selection === 'under' && line < market.line);
        if (expectLow && altProb > 0.55) {
          _recordAltSyncMiss('totals_sanity_fail', { ...ctx, primary: market.line, altProb, strict: true });
          return null;
        }
      }
    }
  }
  if (marketType === 'spreads' && market?.line != null) {
    const lineDiff = Math.abs(Math.abs(market.line) - Math.abs(line));
    if (lineDiff >= 2.0) {
      const primaryProb = selection === 'home' ? market.home?.fairProb : market.away?.fairProb;
      if (primaryProb != null) {
        const easierToCover = (selection === 'home')
          ? (line > market.line)
          : (line < market.line);
        if (easierToCover && altProb < primaryProb - 0.05) {
          _recordAltSyncMiss('spreads_sanity_fail', { ...ctx, primary: market.line, altProb, primaryProb });
          return null;
        }
        if (!easierToCover && altProb > primaryProb + 0.05) {
          _recordAltSyncMiss('spreads_sanity_fail', { ...ctx, primary: market.line, altProb, primaryProb });
          return null;
        }
      }
    }
  }

  _altSyncStats.hit++;
  _altSyncStats.lastHitAt = new Date().toISOString();
  return altProb;
}

function getAltSyncStats() {
  const totalMisses = _altSyncStats.cache_empty + _altSyncStats.cache_stale
    + _altSyncStats.distance_guard + _altSyncStats.line_not_cached
    + _altSyncStats.min_books_gate + _altSyncStats.totals_sanity_fail
    + _altSyncStats.spreads_sanity_fail;
  const totalCalls = _altSyncStats.hit + _altSyncStats.not_applicable + totalMisses;
  return {
    ..._altSyncStats,
    totalCalls,
    totalMisses,
    hitRateOfApplicable: (_altSyncStats.hit + totalMisses) > 0
      ? _altSyncStats.hit / (_altSyncStats.hit + totalMisses)
      : null,
  };
}

async function getFairProbAsync(sport, homeTeam, awayTeam, marketType, selection, line, targetTime) {
  // Try sync first
  const syncResult = getFairProb(sport, homeTeam, awayTeam, marketType, selection, line, targetTime);
  if (syncResult != null) return syncResult;

  // If it's a spread/total (full-game OR F5) with a line mismatch, try
  // fetching alt lines. For F5, the per-event fetchAltLines call now
  // includes alternate_spreads_1st_5_innings + alternate_totals_1st_5_innings
  // so RFQs for non-primary F5 lines (e.g. O 5.5 when DK primary is 4.5)
  // can still be priced. NOTE: earlier iteration added a 150ms timeout
  // here which regressed p95/p99 and caused +308 price failures because
  // the warm cycle wasn't effectively populating the cache. Reverted to
  // unconditional await until warming is debugged / cache hit rate is
  // high enough for a timeout to be safe.
  const isSpreadOrTotal = marketType === 'spreads' || marketType === 'totals'
                         || marketType === 'spreads_f5' || marketType === 'totals_f5';
  if (isSpreadOrTotal && line != null) {
    const event = getEventMarkets(sport, homeTeam, awayTeam, targetTime);
    // For F5, an event with NO primary F5 market can still have alts —
    // SharpAPI may skip F5 but the Odds API alt endpoint carries them.
    // So we proceed to fetchAltLines even when the event has no F5
    // primary cached, as long as we have an event record at all.
    if (event || marketType === 'spreads_f5' || marketType === 'totals_f5') {
      // Strict-mode distance guard BEFORE network fetch, so we don't
      // burn an API call on an out-of-range line we'd decline anyway.
      // Only applies when we have the primary market cached (need
      // market.line to compute distance). F5 fallthrough skips this
      // since market can be null.
      const primaryMarket = event ? event.markets[marketType] : null;
      if (primaryMarket?.line != null) {
        const lineDiff0 = Math.abs(Math.abs(primaryMarket.line) - Math.abs(line));
        const maxDist = altMaxLineDistance(sport);
        if (lineDiff0 > maxDist) {
          log.warn('OddsFeed', `Alt ${marketType} distance guard (async): |${line} - ${primaryMarket.line}| = ${lineDiff0.toFixed(1)} > max ${maxDist} for ${sport} — declining`);
          return null;
        }
      }
      await fetchAltLines(sport, homeTeam, awayTeam, targetTime);
      const key = normalizeEventKey(homeTeam, awayTeam);
      // Pass SIGNED line (not abs) so alt-line lookup routes to the correct
      // signed home_point bucket.
      const altProb = getAltLineFairProb(key, marketType, selection, line);
      if (altProb != null) {
        // Strict-mode min-book gate: require ≥ 2 books for sports
        // with thin alt coverage (soccer). Single-book alt fair is
        // too noisy to quote on.
        if (isStrictAltSanitySport(sport)) {
          const altEntry = getAltLineCacheEntry(key, marketType, selection, line);
          const bookCount = altEntry ? altEntry.books : 0;
          if (bookCount < 2) {
            log.warn('OddsFeed', `Alt ${marketType} strict-book check (async): ${sport} ${selection} ${line} has only ${bookCount} book(s) — declining (min 2)`);
            return null;
          }
        }
        // Same directional sanity checks as getFairProb (see comments there).
        // `event` may be null for F5 fallthrough (no primary market cached);
        // skip the sanity block in that case — F5 line ranges are narrow
        // and rarely trigger the lineDiff >= 2.0 guard anyway.
        const market = event ? event.markets[marketType] : null;
        const sanityThreshold = altSanityLineDiffThreshold(sport);
        if (marketType === 'totals' && market?.line != null) {
          const lineDiff = Math.abs(Math.abs(market.line) - Math.abs(line));
          if (lineDiff >= sanityThreshold) {
            const expectHigh = (selection === 'over' && line < market.line) || (selection === 'under' && line > market.line);
            if (expectHigh && altProb < 0.55) {
              log.warn('OddsFeed', `Alt total sanity FAIL (async): ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} — declining`);
              return null;
            }
            // Strict-mode reverse sanity: expect-low directions should
            // actually be underdogs. Catches swapped-side bugs.
            if (isStrictAltSanitySport(sport)) {
              const expectLow = (selection === 'over' && line > market.line) || (selection === 'under' && line < market.line);
              if (expectLow && altProb > 0.55) {
                log.warn('OddsFeed', `Alt total strict sanity FAIL (async): ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} — expected underdog, got favorite. Declining.`);
                return null;
              }
            }
          }
        }
        if (marketType === 'spreads' && market?.line != null) {
          const lineDiff = Math.abs(Math.abs(market.line) - Math.abs(line));
          if (lineDiff >= 2.0) {
            const primaryProb = selection === 'home' ? market.home?.fairProb : market.away?.fairProb;
            if (primaryProb != null) {
              const easierToCover = (selection === 'home')
                ? (line > market.line)
                : (line < market.line);
              if (easierToCover && altProb < primaryProb - 0.05) {
                log.warn('OddsFeed', `Alt spread sanity FAIL (async): ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} < primary=${primaryProb.toFixed(4)} — declining`);
                return null;
              }
              if (!easierToCover && altProb > primaryProb + 0.05) {
                log.warn('OddsFeed', `Alt spread sanity FAIL (async): ${selection} ${line} (primary ${market.line}) fair=${altProb.toFixed(4)} > primary=${primaryProb.toFixed(4)} — declining`);
                return null;
              }
            }
          }
        }
      }
      return altProb;
    }
  }

  // ---- BOVADA FALLBACK ----
  // Last resort when The Odds API and SharpAPI caches don't cover the
  // RFQ leg. Targets markets Odds API can't serve on its per-event
  // endpoint (verified 422 INVALID_MARKET for alternate_spreads_h1,
  // alternate_totals_h1, alternate_team_totals). Bovada exposes all
  // of these via its public coupon API; scraper maintains a cache
  // refreshed every 2 min.
  //
  // Only consulted after every other cache/fetch path has returned
  // null. Fail-closed: cache miss / stale returns null, which cascades
  // up to a decline at pricer — never a mispriced quote.
  try {
    const bovadaQuery = mapMarketTypeToBovada(marketType, selection, homeTeam, awayTeam);
    if (bovadaQuery) {
      const fair = bovadaAltScraper.lookupFairProb({
        sport, homeTeam, awayTeam,
        period: bovadaQuery.period,
        marketType: bovadaQuery.marketType,
        selection: bovadaQuery.selection,
        line: bovadaQuery.line != null ? bovadaQuery.line : line,
        teamName: bovadaQuery.teamName,
      });
      if (fair != null) {
        log.info('OddsFeed', `Bovada fallback hit: ${sport} ${marketType}/${selection}/line=${line} -> ${(fair*100).toFixed(2)}%`);
        return fair;
      }
    }
  } catch (err) {
    log.warn('OddsFeed', `Bovada fallback error: ${err.message}`);
  }

  return null;
}

/**
 * Translate our internal marketType + selection to the shape
 * bovadaAltScraper.lookupFairProb expects. Returns null for market
 * types Bovada doesn't cover (anything not h1/p1/p2/p3/f5/i1 period
 * and not team_total).
 */
function mapMarketTypeToBovada(marketType, selection, homeTeam, awayTeam) {
  // Full-game (period='game')
  if (marketType === 'h2h')     return { period: 'game', marketType: 'h2h',    selection };
  if (marketType === 'spreads') return { period: 'game', marketType: 'spread', selection };
  if (marketType === 'totals')  return { period: 'game', marketType: 'total',  selection };

  // NBA First Half
  if (marketType === 'h2h_h1')     return { period: 'h1', marketType: 'h2h',    selection };
  if (marketType === 'spreads_h1') return { period: 'h1', marketType: 'spread', selection };
  if (marketType === 'totals_h1')  return { period: 'h1', marketType: 'total',  selection };

  // MLB First 5 Innings
  if (marketType === 'h2h_f5')     return { period: 'f5', marketType: 'h2h',    selection };
  if (marketType === 'spreads_f5') return { period: 'f5', marketType: 'spread', selection };
  if (marketType === 'totals_f5')  return { period: 'f5', marketType: 'total',  selection };

  // team_totals: selection is compound 'home_over' / 'away_under' etc.
  // Decompose into (side, direction) and map side→teamName.
  if (marketType === 'team_totals') {
    const parts = (selection || '').split('_');
    if (parts.length !== 2) return null;
    const [side, direction] = parts;
    if (direction !== 'over' && direction !== 'under') return null;
    const teamName = side === 'home' ? homeTeam : side === 'away' ? awayTeam : null;
    if (!teamName) return null;
    return {
      period: 'game',
      marketType: 'team_total',
      selection: direction,
      teamName,
    };
  }

  // Not a market type Bovada covers
  return null;
}

/**
 * Compute the signed home_point for a spread leg given the bettor's
 * team-perspective line and selection.
 *
 *   Leg: "Arsenal -1.5" (home favored)         → selection=home, line=-1.5 → home_point = -1.5
 *   Leg: "Bournemouth +1.5" (away getting 1.5) → selection=away, line=+1.5 → home_point = -1.5
 *   Leg: "Arsenal +1.5" (home getting 1.5)     → selection=home, line=+1.5 → home_point = +1.5
 *   Leg: "Bournemouth -1.5" (away by 2+)       → selection=away, line=-1.5 → home_point = +1.5
 *
 * The first two legs are opposite sides of the same market and share home_point=-1.5.
 * The last two are opposite sides of a different market at home_point=+1.5. Keying
 * altSpreads by signed home_point keeps these two bets strictly separated.
 */
function spreadHomePoint(line, selection) {
  if (line == null) return null;
  if (selection === 'home') return line;
  if (selection === 'away') return -line;
  return null;
}

/**
 * Look up the raw alt-line cache entry for a (marketType, line) pair.
 * Returns { home|away|over|under (fair), books, byBook, ... } or null
 * when no entry exists. Used by the strict-mode book-count gate so
 * we can reject single-book alts before pricing on them.
 */
function getAltLineCacheEntry(eventKey, marketType, selection, line) {
  const alt = altLinesCache[eventKey];
  if (!alt) return null;
  const isF5 = marketType === 'spreads_f5' || marketType === 'totals_f5';
  const isH1 = marketType === 'spreads_h1' || marketType === 'totals_h1';
  if (marketType === 'spreads' || marketType === 'spreads_f5' || marketType === 'spreads_h1') {
    const homePoint = spreadHomePoint(line, selection);
    if (homePoint == null) return null;
    const bucket = isH1 ? alt.altSpreadsH1 : (isF5 ? alt.altSpreadsF5 : alt.altSpreads);
    return bucket?.[String(homePoint)] || null;
  }
  if (marketType === 'totals' || marketType === 'totals_f5' || marketType === 'totals_h1') {
    const bucket = isH1 ? alt.altTotalsH1 : (isF5 ? alt.altTotalsF5 : alt.altTotals);
    return bucket?.[Math.abs(line)] || null;
  }
  return null;
}

/**
 * Look up a fair prob from the alt lines cache.
 * For spreads, `line` MUST be the signed team-perspective line (not abs) so
 * we can route to the correct signed home_point bucket.
 */
function getAltLineFairProb(eventKey, marketType, selection, line) {
  const alt = altLinesCache[eventKey];
  if (!alt) {
    log.debug('AltLine', `MISS cache: ${eventKey} ${marketType} ${selection} line=${line} — no alt cache entry`);
    return null;
  }

  // Route F5 alt markets to altSpreadsF5 / altTotalsF5 buckets (MLB only).
  // Route H1 alt markets to altSpreadsH1 / altTotalsH1 buckets (NBA only).
  const isF5 = marketType === 'spreads_f5' || marketType === 'totals_f5';
  const isH1 = marketType === 'spreads_h1' || marketType === 'totals_h1';
  if (marketType === 'spreads' || marketType === 'spreads_f5' || marketType === 'spreads_h1') {
    const homePoint = spreadHomePoint(line, selection);
    if (homePoint == null) {
      log.debug('AltLine', `MISS homePoint null: ${eventKey} ${selection} line=${line}`);
      return null;
    }
    const lineKey = String(homePoint);
    const bucket = isH1 ? alt.altSpreadsH1 : (isF5 ? alt.altSpreadsF5 : alt.altSpreads);
    const lineData = bucket?.[lineKey];
    if (!lineData) {
      const availableKeys = Object.keys(bucket || {}).slice(0, 10).join(', ');
      log.debug('AltLine', `MISS ${marketType}: ${eventKey} ${selection} line=${line} homePoint=${lineKey} — not in cache. Available: [${availableKeys}]`);
      return null;
    }
    const fairProb = selection === 'home' ? (lineData.home || null) : (selection === 'away' ? (lineData.away || null) : null);
    log.debug('AltLine', `HIT ${marketType}: ${eventKey} ${selection} line=${line} homePoint=${lineKey} fair=${fairProb?.toFixed(4) ?? 'null'} books=${lineData.books}`);
    return fairProb;
  } else if (marketType === 'totals' || marketType === 'totals_f5' || marketType === 'totals_h1') {
    const bucket = isH1 ? alt.altTotalsH1 : (isF5 ? alt.altTotalsF5 : alt.altTotals);
    const lineData = bucket?.[Math.abs(line)];
    if (!lineData) {
      const availableKeys = Object.keys(bucket || {}).slice(0, 10).join(', ');
      log.debug('AltLine', `MISS ${marketType}: ${eventKey} ${selection} line=${line} — not in cache. Available: [${availableKeys}]`);
      return null;
    }
    const fairProb = selection === 'over' ? (lineData.over || null) : (selection === 'under' ? (lineData.under || null) : null);
    log.debug('AltLine', `HIT ${marketType}: ${eventKey} ${selection} line=${line} fair=${fairProb?.toFixed(4) ?? 'null'} books=${lineData.books}`);
    return fairProb;
  }

  return null;
}

/**
 * Tennis totals fallback: when the requested line isn't cached as an
 * exact match, try to recover a fair prob from nearby cached lines.
 *
 * Two recovery modes (in priority order):
 *   1. INTERPOLATE — bracketing cached lines exist within ±1.0 on both
 *      sides. Linearly interpolates fair prob between them. No vig bump
 *      because the math is sound (small offsets on a near-linear region).
 *   2. SNAP — only one neighbor is available, within ±0.5. Use that
 *      line's fair prob and signal a 3pp vig bump to compensate for
 *      directional drift (true U 23.5 fair > U 23.0 fair, etc.).
 *
 * Returns { fairProb, vigBump } on success, null otherwise. Tennis-only;
 * called by pricer.js as a last-resort fallback after the standard
 * primary + alt-line + byLine paths all return null.
 *
 * Why tennis only: book coverage on tennis totals is unusually sparse
 * (Pinnacle often posts integer totals only to avoid pushes; DK/FD post
 * sporadic half-points). PX is more generous with line offerings than
 * the underlying market is. Other sports have denser book coverage and
 * don't benefit from this approximation.
 */
function getTennisTotalsFallback(homeTeam, awayTeam, selection, line) {
  if (line == null || !Number.isFinite(line)) return null;
  if (selection !== 'over' && selection !== 'under') return null;
  const eventKey = normalizeEventKey(homeTeam, awayTeam);
  const alt = altLinesCache[eventKey];
  if (!alt || !alt.altTotals) return null;
  const requested = Math.abs(line);
  // Build sorted list of (lineValue, fair) pairs for this selection.
  const points = [];
  for (const [lk, ld] of Object.entries(alt.altTotals)) {
    const lv = parseFloat(lk);
    if (!Number.isFinite(lv)) continue;
    const fair = selection === 'over' ? ld.over : ld.under;
    if (fair == null || fair <= 0 || fair >= 1) continue;
    points.push({ line: lv, fair });
  }
  if (points.length === 0) return null;
  points.sort((a, b) => a.line - b.line);

  // Bracket: largest cached line below requested, smallest above.
  let lower = null, upper = null;
  for (const p of points) {
    if (p.line < requested) {
      if (!lower || p.line > lower.line) lower = p;
    } else if (p.line > requested) {
      if (!upper || p.line < upper.line) upper = p;
    } else {
      // Exact match — caller's fast path should have hit, but be safe.
      return { fairProb: p.fair, vigBump: 0 };
    }
  }

  // INTERPOLATE: both neighbors within ±1.0 of requested.
  if (lower && upper && (requested - lower.line) <= 1.0 && (upper.line - requested) <= 1.0) {
    const t = (requested - lower.line) / (upper.line - lower.line);
    const fair = lower.fair + t * (upper.fair - lower.fair);
    if (fair > 0 && fair < 1) {
      log.info('OddsFeed', `Tennis totals INTERP: ${selection} ${requested} ← ${lower.line}(${lower.fair.toFixed(4)})↔${upper.line}(${upper.fair.toFixed(4)}) → ${fair.toFixed(4)}`);
      return { fairProb: fair, vigBump: 0 };
    }
  }

  // SNAP: only one neighbor within ±0.5; bump vig to absorb the gap.
  let snap = null;
  if (lower && (requested - lower.line) <= 0.5) snap = lower;
  if (upper && (upper.line - requested) <= 0.5) {
    if (!snap || (upper.line - requested) < (requested - snap.line)) snap = upper;
  }
  if (snap) {
    log.info('OddsFeed', `Tennis totals SNAP: ${selection} ${requested} ← ${snap.line}(${snap.fair.toFixed(4)}) +3% vig bump`);
    return { fairProb: snap.fair, vigBump: 0.03 };
  }

  return null;
}

/**
 * Look up a specific book's raw American odds for a cached alt line.
 * Returns null if the alt line isn't cached, the book didn't post it,
 * or the requested selection wasn't covered. Used by getPinnacleOdds
 * and siblings to supply accurate competitor comparison values when
 * the PX RFQ line differs from the primary cached line.
 *
 * For spreads, `line` MUST be the signed team-perspective line.
 */
function getAltLineBookOdds(homeTeam, awayTeam, marketType, selection, line, book) {
  if (!homeTeam || !awayTeam || line == null || !book) return null;
  const eventKey = normalizeEventKey(homeTeam, awayTeam);
  const alt = altLinesCache[eventKey];
  if (!alt) return null;

  let lineData;
  if (marketType === 'spreads' || marketType === 'spreads_h1') {
    const homePoint = spreadHomePoint(line, selection);
    if (homePoint == null) return null;
    const bucket = marketType === 'spreads_h1' ? alt.altSpreadsH1 : alt.altSpreads;
    lineData = bucket?.[String(homePoint)];
  } else if (marketType === 'totals' || marketType === 'totals_h1') {
    const bucket = marketType === 'totals_h1' ? alt.altTotalsH1 : alt.altTotals;
    lineData = bucket?.[Math.abs(line)];
  } else {
    return null;
  }

  if (!lineData || !lineData.byBook) return null;
  const bookOdds = lineData.byBook[book];
  if (!bookOdds) return null;

  if (marketType === 'spreads' || marketType === 'spreads_h1') {
    if (selection === 'home') return bookOdds.home != null ? bookOdds.home : null;
    if (selection === 'away') return bookOdds.away != null ? bookOdds.away : null;
  } else if (marketType === 'totals' || marketType === 'totals_h1') {
    if (selection === 'over') return bookOdds.over != null ? bookOdds.over : null;
    if (selection === 'under') return bookOdds.under != null ? bookOdds.under : null;
  }
  return null;
}

/**
 * Get event markets, optionally matching by time for back-to-back/doubleheaders.
 * @param {string} targetTime - ISO timestamp to match closest event (optional)
 */
function getLiveEventMarkets(sport, homeTeam, awayTeam, targetTime) {
  const sportCache = liveOddsCache[sport];
  if (!sportCache || !sportCache.events) return null;
  // Primary: exact pair match.
  const key = normalizeEventKey(homeTeam, awayTeam);
  let events = sportCache.events[key];
  // Fallback 1: flipped orientation (live feed may have stored
  // as away@home while caller passes home/away).
  if (!events || events.length === 0) {
    const flipped = normalizeEventKey(awayTeam, homeTeam);
    events = sportCache.events[flipped];
  }
  // Fallback 2: fuzzy match across all cached events in this sport.
  // Handles abbreviation mismatches (e.g. caller "Oakland Athletics" vs
  // live-cache "Athletics"). Matches on last-word equality which is
  // sufficient for our single-sport context.
  if (!events || events.length === 0) {
    const hNorm = normalizeTeamName(homeTeam);
    const aNorm = normalizeTeamName(awayTeam);
    const hLast = (hNorm.split(' ').pop() || '').toLowerCase();
    const aLast = (aNorm.split(' ').pop() || '').toLowerCase();
    for (const [k, list] of Object.entries(sportCache.events)) {
      for (const ev of (list || [])) {
        const ehLast = (normalizeTeamName(ev.homeTeam || '').split(' ').pop() || '').toLowerCase();
        const eaLast = (normalizeTeamName(ev.awayTeam || '').split(' ').pop() || '').toLowerCase();
        if ((ehLast === hLast && eaLast === aLast)
            || (ehLast === aLast && eaLast === hLast)) {
          events = [ev];
          break;
        }
      }
      if (events && events.length > 0) break;
    }
  }
  if (!events || events.length === 0) return null;
  if (events.length === 1 || !targetTime) return events[0];
  const targetMs = new Date(targetTime).getTime();
  if (isNaN(targetMs)) return events[0];
  let closest = events[0];
  let closestDiff = Infinity;
  for (const ev of events) {
    const evMs = new Date(ev.commenceTime).getTime();
    if (isNaN(evMs)) continue;
    const diff = Math.abs(evMs - targetMs);
    if (diff < closestDiff) { closestDiff = diff; closest = ev; }
  }
  return closest;
}

/**
 * Get LIVE fair prob from liveOddsCache. Returns null if no live data available
 * (caller should fall back to pre-game fair prob).
 */
function getLiveFairProb(sport, homeTeam, awayTeam, marketType, selection, line, targetTime) {
  // Accept both Odds-API naming ('h2h' / 'spreads' / 'totals') and PX
  // naming ('moneyline' / 'spread' / 'total'). refreshLiveOdds pulls
  // from leg.market which uses PX names; other callers use Odds-API
  // names. Translate to the internal h2h/spreads/totals scheme.
  if (marketType === 'moneyline') marketType = 'h2h';
  else if (marketType === 'spread') marketType = 'spreads';
  else if (marketType === 'total') marketType = 'totals';
  const event = getLiveEventMarkets(sport, homeTeam, awayTeam, targetTime);
  if (!event || !event.markets) return null;
  // Detect orientation flip. If the found event's home/away are swapped
  // vs. our caller's args, swap the selection for home/away markets.
  let sel = selection;
  let lookupLine = line;
  const evHomeLast = (normalizeTeamName(event.homeTeam || '').split(' ').pop() || '').toLowerCase();
  const callerHomeLast = (normalizeTeamName(homeTeam || '').split(' ').pop() || '').toLowerCase();
  const flipped = evHomeLast && callerHomeLast && evHomeLast !== callerHomeLast;
  if (flipped) {
    if (marketType === 'h2h' || marketType === 'spreads') {
      sel = selection === 'home' ? 'away' : selection === 'away' ? 'home' : selection;
      if (marketType === 'spreads' && lookupLine != null) lookupLine = -lookupLine;
    }
  }

  const m = event.markets;
  if (marketType === 'h2h' && m.h2h) {
    const pick = sel === 'home' ? m.h2h.home : m.h2h.away;
    return pick && pick.fairProb ? pick.fairProb : null;
  }
  if (marketType === 'spreads' && m.spreads) {
    // Exact-line match first; fall back to the current primary line if the
    // leg's line isn't present. Mirrors the totals behavior below — in-play
    // odds sources typically publish only the current spread, so mid-game
    // the original pre-game line (e.g. -9 when live is -14) isn't there.
    // The primary's fair prob is still more accurate than the stale pre-game
    // one for exposure tracking purposes.
    let group = lookupLine != null ? m.spreads[Math.abs(lookupLine)] : null;
    if (!group && m.spreads._primary != null) group = m.spreads[m.spreads._primary];
    if (!group) return null;
    const pick = sel === 'home' ? group.home : group.away;
    return pick && pick.fairProb ? pick.fairProb : null;
  }
  if (marketType === 'totals' && m.totals) {
    // DK live totals may not have the exact line we registered. Pick
    // the primary (current line) when caller's line is missing from
    // the live cache — still more accurate than pre-game.
    let group = m.totals[line];
    if (!group && m.totals._primary != null) group = m.totals[m.totals._primary];
    if (!group) return null;
    const pick = selection === 'over' ? group.over : group.under;
    return pick && pick.fairProb ? pick.fairProb : null;
  }
  return null;
}

function getLiveCacheStatus() {
  const status = {};
  for (const [sport, cache] of Object.entries(liveOddsCache)) {
    const totalEvents = Object.values(cache.events).reduce((s, arr) => s + arr.length, 0);
    status[sport] = {
      eventCount: totalEvents,
      ageMinutes: Math.round((Date.now() - cache.fetchedAt) / (1000 * 60) * 10) / 10,
    };
  }
  return status;
}

/**
 * Golf matchup lookup. DataGolf publishes BOTH round_matchups (R1/R2/R3/R4
 * specific) and tournament_matchups (full 72-hole head-to-heads) — often
 * for the same two players. These have materially different fair probs,
 * so we cannot price a round RFQ against tournament odds or vice versa.
 *
 * Each cache entry is tagged with matchupType ('round' | 'tournament') and,
 * for rounds, roundNum (1-4). Caller passes the desired roundNum (null =>
 * tournament) and we filter the array to the single matching entry.
 */
function getGolfMatchupEvent(homeTeam, awayTeam, roundNum) {
  const cache = oddsCache['golf_matchups'];
  if (!cache || !cache.events) return null;
  const key = normalizeEventKey(homeTeam, awayTeam);
  const entry = cache.events[key];
  if (!entry) return null;
  const events = Array.isArray(entry) ? entry : [entry];
  if (events.length === 0) return null;
  const isTournament = roundNum == null;
  // Prefer an entry whose matchupType + roundNum match the request.
  const match = events.find(e => {
    if (isTournament) return e.matchupType === 'tournament' || e.roundNum == null;
    return e.matchupType === 'round' && e.roundNum === roundNum;
  });
  return match || null;
}

// Markets attached by per-event TOA supplements (supplementMlbF5Markets,
// supplementH1Markets, supplementTeamTotals). These don't conflict
// across sibling cache entries because they're MARKET TYPES not present
// on the primary feed. When a sport's cache holds multiple entries for
// the same matchup — either same-key siblings (back-to-backs, generic-
// time vs real-time entries) OR reverse-key siblings (SharpAPI feed
// stores home/away reversed from TOA, common for NBA/NHL/MLB) — the
// supplement may write these markets to a sibling entry that PX doesn't
// match against, causing /lines/detail to show null fair-prob even
// though the data is in cache one entry away. Union them across all
// siblings so the consumer sees them regardless of which entry the
// closest-by-time + correct-orientation lookup picks.
const _MERGEABLE_SUPP_MARKETS = [
  'h2h_h1', 'spreads_h1', 'totals_h1',          // NBA / NCAAB H1
  'h2h_f5', 'spreads_f5', 'totals_f5',          // MLB F5
  'team_totals',                                 // NBA / MLB / NHL
];

/**
 * True when a candidate odds event is close enough in time to the PX line it
 * would price, i.e. plausibly the SAME fixture. Fails OPEN (true) when either
 * time is missing or unparseable — we never reject a match on absent data, only
 * on a confirmed large gap. maxHours defaults to 36 (see config comment).
 */
function _withinMatchWindow(targetTime, eventTime, maxHours) {
  if (targetTime == null || targetTime === '' || eventTime == null || eventTime === '') return true;
  const t = new Date(targetTime).getTime();
  const e = new Date(eventTime).getTime();
  if (isNaN(t) || isNaN(e)) return true;
  const cap = (Number(maxHours) > 0 ? Number(maxHours) : 36) * 3600 * 1000;
  return Math.abs(e - t) <= cap;
}

function getEventMarkets(sport, homeTeam, awayTeam, targetTime) {
  const sportCache = oddsCache[sport];
  if (!sportCache) return null;
  const key = normalizeEventKey(homeTeam, awayTeam);
  const reverseKey = normalizeEventKey(awayTeam, homeTeam);
  const fwdEntry = sportCache.events[key];
  const revEntry = (reverseKey !== key) ? sportCache.events[reverseKey] : null;
  const fwdEvents = fwdEntry ? (Array.isArray(fwdEntry) ? fwdEntry : [fwdEntry]) : [];
  const revEvents = revEntry ? (Array.isArray(revEntry) ? revEntry : [revEntry]) : [];
  if (fwdEvents.length === 0 && revEvents.length === 0) return null;

  // Cross-orientation closest-by-time selection. SharpAPI's MLB feed
  // periodically stores home/away reversed vs PX/TOA on the same matchup.
  // Without considering both buckets when picking `closest`, a line
  // registered with PX's orientation that has no forward-bucket match for
  // the right time will silently fall back to whatever stale or future
  // event happens to be in the forward bucket. Verified 2026-05-02 ATL @
  // COL: forward bucket (COL|ATL) only contained Saturday's afternoon
  // game; tonight's game was in the reverse bucket (ATL|COL), and every
  // RFQ on tonight's game was priced against tomorrow's data.
  //
  // Each candidate is tagged with `flipped: true` when sourced from the
  // reverse bucket so the final market block can be flipped back to the
  // caller's orientation before returning.
  const candidates = [
    ...fwdEvents.map(ev => ({ ev, flipped: false })),
    ...revEvents.map(ev => ({ ev, flipped: true })),
  ];

  let closestC = candidates[0];
  if (candidates.length > 1 && targetTime) {
    const targetMs = new Date(targetTime).getTime();
    if (!isNaN(targetMs)) {
      let closestDiff = Infinity;
      for (const c of candidates) {
        const evMs = new Date(c.ev.commenceTime).getTime();
        if (isNaN(evMs)) continue;
        const diff = Math.abs(evMs - targetMs);
        if (diff < closestDiff) { closestDiff = diff; closestC = c; }
      }
    }
  }

  const closest = closestC.ev;

  // COMMENCE-TIME PROXIMITY GUARD. The selection above picks the closest
  // candidate by time, but with NO ceiling — and a SINGLE candidate never
  // consults time at all. So a leg can bind to an event days or weeks away and
  // price off it silently, fresh cache, no stale flag:
  //   - NFL preseason (Aug) shares a team pair with the SAME teams' regular-
  //     season fixture (Sep). 4 of the Aug 13-17 preseason games do; each would
  //     bind to the September event and quote off regular-season odds.
  //   - The 2026-07-23 incident (5 mid-series MLB games dark) is the same code
  //     path — a mid-series game matching the wrong day's event.
  // Legitimate matches sit within a few hours of the PX start (timezone,
  // posted-vs-actual jitter); a doubleheader is ~3h, a back-to-back ~24h; the
  // preseason collision is ~5 WEEKS. So a generous ceiling separates them
  // cleanly. When the only candidate is too far off, return null (leg declines)
  // rather than price off the wrong game. Skipped when targetTime is absent.
  // Golf is exempt: a tournament "event" legitimately spans ~4 days, so a
  // round-4 matchup's PX start can sit 3+ days from the tournament-start odds
  // event. Golf also has no weekly same-pair collision to guard against.
  const timeGuarded = typeof sport === 'string' && !sport.startsWith('golf');
  if (timeGuarded && targetTime && !_withinMatchWindow(targetTime, closest.commenceTime, config.oddsMatchMaxDeltaHours)) {
    const dh = Math.round(Math.abs(new Date(closest.commenceTime).getTime() - new Date(targetTime).getTime()) / 3600000);
    log.debug('OddsFeed', `Event match rejected for ${homeTeam} v ${awayTeam} (${sport}): nearest odds event ${dh}h from PX start — wrong fixture`);
    return null;
  }

  const flippedBucket = closestC.flipped;
  const sameBucket = flippedBucket ? revEvents : fwdEvents;
  const oppositeBucket = flippedBucket ? fwdEvents : revEvents;

  // Same-bucket sibling merge (no orientation flip — siblings share the
  // chosen bucket's orientation).
  let merged = _mergeSameKeySiblings(sameBucket, closest);

  // Opposite-bucket supplement merge (orientation flipped). These markets
  // are in the OPPOSITE orientation from `closest`, so flip them once now
  // to align with closest. If we end up flipping the entire result below
  // (because closest came from the reverse bucket), they get flipped a
  // second time — net zero, returning to their cache-native orientation,
  // which equals the caller's orientation by definition.
  if (oppositeBucket.length > 0) {
    const baseMarkets = (merged && merged.markets) || (closest && closest.markets) || {};
    for (const ev of oppositeBucket) {
      if (!ev || !ev.markets) continue;
      for (const k of _MERGEABLE_SUPP_MARKETS) {
        if (!ev.markets[k]) continue;
        if (baseMarkets[k]) continue;
        if (!merged) merged = { ...closest, markets: { ...(closest.markets || {}) } };
        if (merged.markets[k]) continue;
        merged.markets[k] = _flipMarketOrientation(k, ev.markets[k]);
      }
    }
  }

  let result = merged || closest;

  // If `closest` came from the reverse bucket, flip every market block
  // (primary + supplementals) so the caller receives data in the orientation
  // they requested. Updates homeTeam/awayTeam labels to the caller's order
  // and tags the event with _orientationFlipped for downstream debugging.
  if (flippedBucket) {
    const flippedMarkets = {};
    for (const [mk, m] of Object.entries(result.markets || {})) {
      flippedMarkets[mk] = _flipMarketOrientation(mk, m);
    }
    result = {
      ...result,
      homeTeam,
      awayTeam,
      markets: flippedMarkets,
      _orientationFlipped: true,
    };
  }

  return result;
}

// Build a merged event view: keep `closest` as the base, then union in
// any _MERGEABLE_SUPP_MARKETS that same-key sibling entries have but
// `closest` doesn't. Returns the original `closest` (no copy) when no
// merging applies — preserves existing reference semantics. Otherwise
// returns a shallow copy with a new .markets object so we don't mutate
// the cache entry.
function _mergeSameKeySiblings(events, closest) {
  if (!closest || events.length < 2) return null;
  let merged = null;
  for (const ev of events) {
    if (ev === closest || !ev || !ev.markets) continue;
    for (const k of _MERGEABLE_SUPP_MARKETS) {
      if (ev.markets[k] && !(closest.markets && closest.markets[k]) && !(merged && merged.markets[k])) {
        if (!merged) merged = { ...closest, markets: { ...(closest.markets || {}) } };
        merged.markets[k] = ev.markets[k];
      }
    }
  }

  // Special case for team_totals: union byLine maps across all sibling
  // entries even when the closest already has team_totals. NBA / MLB /
  // NHL caches frequently hold multiple sibling entries for the same
  // matchup at different commenceTime stamps (real time + midnight UTC
  // placeholders), each with DIFFERENT primary lines (e.g. closest has
  // Lakers 99.5, sibling has Lakers 98.5). Without this union, a line
  // requested for the sibling's primary lands on the closest entry's
  // byLine + primary check, returns null, and the operator's Lines tab
  // shows fair=null even though the data exists one cache entry away.
  // Verified 2026-05-03 NBA Lakers/OKC: team_total line=98.5 had
  // fair=null because closest entry's primary was 99.5; the 98.5 data
  // sat in a sibling commenceTime entry.
  if (closest.markets && closest.markets.team_totals) {
    const closestTT = closest.markets.team_totals;
    let unionedTT = null;
    for (const side of ['home', 'away']) {
      const closestSide = closestTT[side];
      if (!closestSide) continue;
      // Build the union byLine map: start from closest's byLine, fold in
      // closest's own primary as a byLine entry too, then union sibling
      // entries' byLine + their primaries.
      const unionByLine = { ...(closestSide.byLine || {}) };
      if (closestSide.line != null && !unionByLine[String(closestSide.line)]) {
        unionByLine[String(closestSide.line)] = {
          line: closestSide.line,
          over: closestSide.over,
          under: closestSide.under,
        };
      }
      for (const ev of events) {
        if (ev === closest || !ev || !ev.markets || !ev.markets.team_totals) continue;
        const sibSide = ev.markets.team_totals[side];
        if (!sibSide) continue;
        // Fold sibling's byLine entries
        if (sibSide.byLine) {
          for (const [lk, le] of Object.entries(sibSide.byLine)) {
            if (!unionByLine[lk]) unionByLine[lk] = le;
          }
        }
        // Fold sibling's primary line
        if (sibSide.line != null && !unionByLine[String(sibSide.line)]) {
          unionByLine[String(sibSide.line)] = {
            line: sibSide.line,
            over: sibSide.over,
            under: sibSide.under,
          };
        }
      }
      // Only mutate if we actually expanded
      if (Object.keys(unionByLine).length > Object.keys(closestSide.byLine || {}).length) {
        if (!unionedTT) unionedTT = { ...closestTT };
        unionedTT[side] = { ...closestSide, byLine: unionByLine };
      }
    }
    if (unionedTT) {
      if (!merged) merged = { ...closest, markets: { ...(closest.markets || {}) } };
      merged.markets.team_totals = unionedTT;
    }
  }

  return merged;
}

// Flip a supplemented-market block when it was sourced from a reverse-
// orientation cache entry. h2h/h2h_f5/h2h_h1: swap home<->away.
// spreads/spreads_f5/spreads_h1: swap home<->away AND negate point/line
// on each side (home -1.5 ↔ away +1.5). team_totals: swap home<->away
// (over/under per side stay symmetric). totals/totals_f5/totals_h1:
// over/under are team-agnostic, no flip needed.
//
// Primary h2h/spreads/totals were added 2026-05-02 alongside the cross-
// orientation closest-by-time selection in getEventMarkets — without
// these branches, the orientation flip on a reverse-bucket result would
// leave the primary markets in the wrong orientation.
function _flipMarketOrientation(marketType, market) {
  if (!market) return market;
  if (marketType === 'totals' || marketType === 'totals_h1' || marketType === 'totals_f5') return market;

  // Per-book sub-blocks (pinnacle/fanduel/draftkings/kalshi) carry their
  // own {home, away} structure. When the consensus (m.home/m.away) is
  // flipped, these sub-blocks MUST flip too — otherwise getPinnacleOdds /
  // getFanDuelOdds / etc. read the wrong side after the orientation swap
  // and the dashboard's PIN/FD/DK columns show the OPPOSITE fighter's
  // raw price (operator-confirmed 2026-05-06 on UFC card: Carpenter fair
  // 37%, MY ODDS +154 correct, but PIN −178 / DK −180 were Ochoa's
  // prices). For h2h: simple home↔away swap. For spreads: also need to
  // think about what's stored — per-book sub-blocks for spreads typically
  // carry American odds at the canonical home line, so a home/away swap
  // alone aligns them; the per-side .line/.point lives in m.home/m.away
  // (already flipped above).
  function flipSideMap(b) {
    if (!b || typeof b !== 'object') return b;
    return { ...b, home: b.away, away: b.home };
  }
  function flipBooks(m) {
    const out = { ...m };
    if (m.pinnacle)    out.pinnacle    = flipSideMap(m.pinnacle);
    if (m.fanduel)     out.fanduel     = flipSideMap(m.fanduel);
    if (m.draftkings)  out.draftkings  = flipSideMap(m.draftkings);
    if (m.kalshi)      out.kalshi      = flipSideMap(m.kalshi);
    return out;
  }

  if (marketType === 'h2h' || marketType === 'h2h_h1' || marketType === 'h2h_f5') {
    return flipBooks({ ...market, home: market.away, away: market.home });
  }
  if (marketType === 'spreads' || marketType === 'spreads_h1' || marketType === 'spreads_f5') {
    // Side `.point` is the spread for that specific team (Bruins +1.5,
    // Rangers -1.5) — it travels with the team across orientation flips
    // and must NOT be negated. Only `market.line` (canonical, from-home
    // perspective) needs negation since the home team identity changes.
    return flipBooks({
      ...market,
      home: market.away,
      away: market.home,
      line: market.line != null ? -market.line : null,
    });
  }
  if (marketType === 'team_totals') {
    return flipBooks({ ...market, home: market.away, away: market.home });
  }
  return market;
}

function getCacheAge(sport) {
  const sportCache = oddsCache[sport];
  if (!sportCache) return Infinity;
  return (Date.now() - sportCache.fetchedAt) / 1000 / 60;
}

function isStale(sport) {
  const perSport = config.pricing.stalePriceMinutesBySport || {};
  const threshold = perSport[sport] != null ? perSport[sport] : config.pricing.stalePriceMinutes;
  return getCacheAge(sport) > threshold;
}

function getStaleThreshold(sport) {
  const perSport = config.pricing.stalePriceMinutesBySport || {};
  return perSport[sport] != null ? perSport[sport] : config.pricing.stalePriceMinutes;
}

/**
 * Event-aware staleness gate. The flat per-sport threshold (isStale) is right
 * for imminent games but needlessly strict for far-out ones: lines barely move
 * on a match 20h away, yet a 5-min soccer threshold declines a perfectly
 * quotable World Cup game whenever the refresh cycle runs a touch slow. For
 * events starting beyond STALE_FAR_OUT_HOURS, allow a relaxed cache age
 * (STALE_FAR_OUT_MINUTES). Imminent games are UNAFFECTED here and stay governed
 * by the normal threshold + the tighter isEventStalePreGame guard. Falls back
 * to plain isStale when startTime is missing/unparseable (fail-safe).
 */
function isStaleForEvent(sport, startTime) {
  if (!isStale(sport)) return false; // fresh by the normal per-sport threshold
  if (!startTime) return true;
  const hoursToStart = (new Date(startTime).getTime() - Date.now()) / 3600e3;
  const farOutHours = config.pricing.staleFarOutHours;
  if (!Number.isFinite(hoursToStart) || !(farOutHours > 0) || hoursToStart < farOutHours) return true;
  return getCacheAge(sport) > (config.pricing.staleFarOutMinutes || getStaleThreshold(sport));
}

/**
 * Pre-game closing-line guard. When an event starts within PREGAME_WINDOW_MIN,
 * sportsbooks move the line hard on late news (scratches, weather, scratches).
 * Our cached odds can be stale even when the sport-level cache passes isStale.
 *
 * Returns true if the caller should REFUSE to quote because the cache is too
 * stale for a game that's about to start.
 *
 * Rule: if startTime is within 30 min, require cache age ≤ 2 min.
 * Otherwise falls back to the normal per-sport threshold.
 */
function isEventStalePreGame(sport, startTime) {
  if (!startTime) return false;
  const startMs = new Date(startTime).getTime();
  if (isNaN(startMs)) return false;
  const minsToStart = (startMs - Date.now()) / 60000;
  if (minsToStart < 0 || minsToStart > 10) return false; // not in window
  // Within 10 min of tip-off — tighten to 3 min cache age
  return getCacheAge(sport) > 3;
}

// ---------------------------------------------------------------------------
// DELTA UPDATES — incremental odds changes from SharpAPI /odds/delta
// ---------------------------------------------------------------------------

/**
 * Rebuild consensus markets from raw odds rows for a single event.
 * Used by mergeDeltas to update only affected events.
 */
function rebuildEventConsensus(rawOdds) {
  const markets = {};

  const mlBooks = getBookPairs(rawOdds, 'moneyline');
  if (mlBooks.length > 0) markets.h2h = buildConsensusMoneyline(mlBooks);

  const spreadTypes = ['point_spread', 'run_line', 'puck_line'];
  const spreadOdds = rawOdds.filter(r => spreadTypes.includes(r.market_type));
  const spreadBooks = getBookPairs(spreadOdds, null);
  if (spreadBooks.length > 0) markets.spreads = buildConsensusSpread(spreadBooks);

  const totalTypes = ['total_points', 'total_runs', 'total_goals'];
  const totalOdds = rawOdds.filter(r => totalTypes.includes(r.market_type));
  const totalBooks = getBookPairsForTotals(totalOdds);
  if (totalBooks.length > 0) markets.totals = buildConsensusTotals(totalBooks);

  const teamTotalOdds = rawOdds.filter(r => r.market_type === 'team_total');
  if (teamTotalOdds.length > 0) {
    const teamTotalBooks = getBookPairsForTeamTotals(teamTotalOdds);
    if (teamTotalBooks.length > 0) {
      const tt = buildConsensusTeamTotals(teamTotalBooks);
      if (tt) markets.team_totals = tt;
    }
  }

  return markets;
}

/**
 * Merge delta rows into existing cache for a sport.
 * Finds affected events, updates their raw odds, and rebuilds consensus.
 */
function mergeDeltas(sport, deltaRows) {
  const sportCache = oddsCache[sport];
  if (!sportCache) return 0;

  // Group deltas by event_id
  const deltaByEvent = {};
  for (const row of deltaRows) {
    const eid = row.event_id;
    if (!deltaByEvent[eid]) deltaByEvent[eid] = [];
    deltaByEvent[eid].push(row);
  }

  let updated = 0;
  for (const [eventId, rows] of Object.entries(deltaByEvent)) {
    const homeTeam = cleanTeamName(rows[0].home_team || '');
    const awayTeam = cleanTeamName(rows[0].away_team || '');
    const key = normalizeEventKey(homeTeam, awayTeam);

    // Find existing event in cache
    const entry = sportCache.events[key];
    if (!entry) continue; // new event — skip, next full refresh picks it up

    const events = Array.isArray(entry) ? entry : [entry];
    // Match by eventId AND verify commence time is on the same day
    const deltaDate = rows[0].event_start_time ? new Date(rows[0].event_start_time).toISOString().substring(0, 10) : null;
    const existing = events.find(e => {
      if (e.eventId !== eventId) return false;
      if (!deltaDate) return true; // no date to verify, accept
      const cacheDate = e.commenceTime ? new Date(e.commenceTime).toISOString().substring(0, 10) : null;
      return !cacheDate || cacheDate === deltaDate;
    });
    if (!existing || !existing._rawOdds) continue;

    // Merge: replace/add rows matching by sportsbook + market_type + selection_type
    for (const deltaRow of rows) {
      const idx = existing._rawOdds.findIndex(r =>
        r.sportsbook === deltaRow.sportsbook &&
        r.market_type === deltaRow.market_type &&
        r.selection_type === deltaRow.selection_type
      );
      if (idx >= 0) {
        existing._rawOdds[idx] = deltaRow;
      } else {
        existing._rawOdds.push(deltaRow);
      }
    }

    // Rebuild consensus from updated raw odds
    existing.markets = rebuildEventConsensus(existing._rawOdds);
    updated++;
  }

  if (updated > 0) {
    sportCache.fetchedAt = Date.now();
    log.info('OddsFeed', `Delta merged: ${updated} events updated for ${sport}`);
  }
  return updated;
}

/**
 * Fetch odds changes since last timestamp for a sport.
 * Falls back to full fetch if no previous timestamp or on error.
 */
async function fetchOddsDelta(sport) {
  const mapping = LEAGUE_MAP[sport];
  if (!mapping) return null;

  const since = lastDeltaTimestamp[sport];
  if (!since) {
    // No previous fetch — do a full fetch to establish baseline
    log.debug('OddsFeed', `No delta baseline for ${sport}, doing full fetch`);
    return fetchOddsForSport(sport);
  }

  // Split delta by market type and paginate each until drained. Same
  // reasoning as fetchOddsForSport: /odds/delta caps `limit` at 200 and
  // returns meta.pagination.has_more + next_offset; we loop until empty.
  const marketTypesList = {
    'baseball_mlb': ['moneyline', 'run_line', 'total_runs', 'team_total', '1st_5_innings_moneyline', '1st_5_innings_run_line'],
    'icehockey_nhl': ['moneyline', 'puck_line', 'total_goals', 'team_total'],
    'basketball_nba': ['moneyline', 'point_spread', 'total_points', 'team_total'],
    'soccer': ['moneyline', 'point_spread', 'total_goals', 'team_total'],
  }[sport] || ['moneyline', 'point_spread', 'total_points', 'team_total'];

  const PAGE_LIMIT = 200;
  const MAX_PAGES_PER_MARKET = 50;
  const rows = [];
  let anyFailed = false;
  for (const mt of marketTypesList) {
    const baseUrl = `${config.oddsApi.baseUrl}/odds/delta`
      + `?${mapping.param}=${mapping.value}`
      + `&market=${mt}`
      + `&since=${encodeURIComponent(since)}`
      + `&limit=${PAGE_LIMIT}`;
    let offset = 0;
    let pages = 0;
    while (pages < MAX_PAGES_PER_MARKET) {
      const url = offset === 0 ? baseUrl : `${baseUrl}&offset=${offset}`;
      try {
        const resp = await fetch(url, {
          headers: { 'X-API-Key': config.oddsApi.apiKey },
        });
        if (!resp.ok) {
          log.warn('OddsFeed', `Delta fetch failed (${resp.status}) for ${sport}/${mt} (page ${pages + 1})`);
          anyFailed = true;
          break;
        }
        const body = await safeJsonFetch(resp);
        const mtRows = body.data || [];
        rows.push(...mtRows);
        pages++;
        const pagination = body.meta && body.meta.pagination;
        if (!pagination || !pagination.has_more) break;
        offset = pagination.next_offset != null ? pagination.next_offset : offset + mtRows.length;
        if (mtRows.length === 0) break; // defensive: no progress
      } catch (err) {
        log.warn('OddsFeed', `Delta fetch error for ${sport}/${mt} (page ${pages + 1}): ${err.message}`);
        anyFailed = true;
        break;
      }
    }
    if (pages >= MAX_PAGES_PER_MARKET) {
      log.warn('OddsFeed', `Hit ${MAX_PAGES_PER_MARKET}-page safety cap for ${sport}/${mt} delta — possible pagination loop`);
    }
  }

  // If everything failed, fall back to full fetch
  if (anyFailed && rows.length === 0) {
    log.warn('OddsFeed', `All delta fetches failed for ${sport}, falling back to full`);
    return fetchOddsForSport(sport);
  }

  try {
    lastDeltaTimestamp[sport] = new Date().toISOString();
    // Bump fetchedAt on every successful delta poll, even when zero rows
    // changed. Without this, staleness was measuring "time since last
    // price move" instead of "time since last successful refresh check"
    // — late at night when NBA/MLB lines stop moving for 7-8 minutes,
    // the cache was being classified stale despite the 30s delta loop
    // happily polling and confirming nothing had changed. Verified
    // 2026-05-02: NBA Cavaliers ML and player_hitter_hits parlays
    // declined as "stale 5m / 4m" while delta polls were succeeding
    // every 30s with zero rows.
    if (oddsCache[sport]) {
      oddsCache[sport].fetchedAt = Date.now();
    }
    if (rows.length === 0) {
      log.debug('OddsFeed', `No delta changes for ${sport}`);
      return null;
    }
    log.info('OddsFeed', `Delta: ${rows.length} changed rows for ${mapping.value}`);
    mergeDeltas(sport, rows);
    return oddsCache[sport]?.events;
  } catch (err) {
    log.warn('OddsFeed', `Delta merge error for ${sport}: ${err.message}, falling back to full`);
    return fetchOddsForSport(sport);
  }
}

/**
 * Run delta updates for all SharpAPI sports (not Odds API fallback sports).
 */
async function refreshAllSportsDelta() {
  // SharpAPI retired (2026-06-25): the /odds/delta endpoint is Sharp-only.
  // With Sharp disabled, skip delta entirely — the full TOA refresh
  // (refreshAllSports) is the sole source and already covers every sport.
  if (!_sharpEnabled()) return;
  let mmaTouched = false;
  for (const sport of Object.keys(LEAGUE_MAP)) {
    try {
      await fetchOddsDelta(sport);
      if (sport === 'mma_mixed_martial_arts') mmaTouched = true;
    } catch (err) {
      log.warn('OddsFeed', `Delta refresh failed for ${sport}: ${err.message}`);
    }
  }
  // SharpAPI delta refresh can ADD MMA events under SharpAPI naming
  // ("Steve Erceg vs Tim Elliott") even when the DK-merged variant
  // ("Stephen Erceg vs Tim Elliott") already has totals. Without
  // re-merging, the new SharpAPI-named entry stays h2h-only and the
  // line-manager's lookup against that orientation returns null fair —
  // operator caught Tim Elliott vs Steve Erceg O 2.5 declining as
  // "no totals quote" minutes after the dashboard had shown valid
  // odds. mergeDkMmaFights uses DK's own 15-min cache so re-running
  // is cheap (cache hit, just iterates the events). Fire-and-forget.
  if (mmaTouched) {
    mergeDkMmaFights().catch(err => {
      log.warn('OddsFeed', `Post-delta DK MMA merge failed: ${err.message}`);
    });
  }
}

async function refreshEventsIndex() {
  // SharpAPI retired (2026-06-25): always build the events index from TOA's
  // free /events endpoint. The Sharp-events branch below is dead unless
  // SHARPAPI_ENABLED is explicitly set.
  const sharpKeyPresent = _sharpEnabled();
  for (const sport of Object.keys(LEAGUE_MAP)) {
    // SharpAPI-removal audit: flipped (or keyless) sports build the events
    // index from TOA's free /events endpoint instead — line-manager's
    // name-matching keeps working without the Sharp subscription. Generic
    // 'soccer' has no single TOA key; its events arrive via the curated
    // dynamic odds fetch and matching falls back to the odds cache itself.
    if (!sharpKeyPresent || _isToaPrimary(sport)) {
      try {
        const entry = ODDS_API_FALLBACK[sport];
        if (!entry || entry.dynamic || !entry.oddsApiSport) continue; // dynamic/generic — odds-cache matching covers it
        // _listEventsFromToa takes the INTERNAL key and resolves the TOA
        // key itself; returns {homeTeam, awayTeam, commenceTime} (no id).
        const toaEvents = await _listEventsFromToa(sport);
        if (toaEvents && toaEvents.length) {
          sharpEventsIndex[sport] = {
            fetchedAt: Date.now(),
            events: toaEvents.map(e => ({
              eventId: null, // TOA events list carries no Sharp-style id; matching is by name+time
              homeTeam: cleanTeamName(e.homeTeam || ''),
              awayTeam: cleanTeamName(e.awayTeam || ''),
              startTime: e.commenceTime,
            })).filter(e => e.homeTeam && e.awayTeam),
          };
          log.info('OddsFeed', `Events index (TOA): ${sharpEventsIndex[sport].events.length} events for ${sport}`);
        }
      } catch (err) {
        log.warn('OddsFeed', `TOA events index failed for ${sport}: ${err.message}`);
      }
      continue;
    }
    try {
      const mapping = LEAGUE_MAP[sport];
      const url = `${config.oddsApi.baseUrl}/events`
        + `?${mapping.param}=${mapping.value}`
        + `&live=false&limit=200`;
      const resp = await fetch(url, {
        headers: { 'X-API-Key': config.oddsApi.apiKey },
      });
      if (!resp.ok) continue;
      const body = await safeJsonFetch(resp);
      const events = body.data || [];
      sharpEventsIndex[sport] = {
        fetchedAt: Date.now(),
        events: events.map(e => ({
          eventId: e.event_id || e.id,
          homeTeam: cleanTeamName(e.home_team || ''),
          awayTeam: cleanTeamName(e.away_team || ''),
          startTime: e.event_start_time || e.start_time,
        })).filter(e => e.homeTeam && e.awayTeam),
      };
      log.info('OddsFeed', `Events index: ${sharpEventsIndex[sport].events.length} events for ${sport}`);
    } catch (err) {
      log.warn('OddsFeed', `Events index failed for ${sport}: ${err.message}`);
    }
  }
}

function getSharpEvents(sport) {
  return sharpEventsIndex[sport]?.events || [];
}

// Stale-sport watchdog state: sport -> last alert ms (throttle to 1/15min).
const _staleAlertAt = {};
const STALE_ALERT_AGE_MS = 30 * 60 * 1000;
const STALE_ALERT_THROTTLE_MS = 15 * 60 * 1000;
function _alertStaleSports() {
  const now = Date.now();
  for (const [sport, cache] of Object.entries(oddsCache)) {
    if (!cache || !cache.fetchedAt) continue;
    const evCount = Object.keys(cache.events || {}).length;
    if (evCount === 0) continue; // empty cache = sport legitimately idle
    const age = now - cache.fetchedAt;
    if (age < STALE_ALERT_AGE_MS) continue;
    if (_staleAlertAt[sport] && now - _staleAlertAt[sport] < STALE_ALERT_THROTTLE_MS) continue;
    _staleAlertAt[sport] = now;
    log.error('OddsFeed', `STALE-SPORT ALERT: ${sport} cache is ${Math.round(age / 60000)} min old with ${evCount} events — every RFQ on this sport is being declined by the stale-price gate. Pipeline for this sport is likely dead (TOA inactive/429s or DK scrape failing).`);
  }
}

async function refreshAllSports() {
  // Refresh events index first — line-manager uses it for matching
  await refreshEventsIndex();

  const results = {};
  // Build the list: configured sports + golf_matchups if DataGolf key is set
  const sportsToRefresh = [...config.supportedSports];
  if (config.dataGolf && config.dataGolf.apiKey && !sportsToRefresh.includes('golf_matchups')) {
    sportsToRefresh.push('golf_matchups');
  }
  for (const sport of sportsToRefresh) {
    try {
      const events = await fetchOddsForSport(sport);
      results[sport] = { ok: true, events: Object.keys(events || {}).length };
    } catch (err) {
      log.error('OddsFeed', `Failed to fetch ${sport}: ${err.message}`);
      results[sport] = { ok: false, error: err.message };
    }
    // 500ms spacing (was 300) — TOA rate-limits by request frequency and this
    // loop shares the key with prop refreshes and per-event supplements.
    await new Promise(r => setTimeout(r, 500));
  }

  // Loud staleness watchdog. A sport whose cache has events but hasn't
  // successfully refreshed in >30 min is silently declining 100% of its RFQs
  // via the stale-price gate — tennis sat dark 35h (7/21) and 17h (7/23)
  // before anyone noticed, and nothing in the logs distinguished "quiet
  // sport" from "dead pipeline". log.error once per sport per 15 min so it
  // shows up in Railway logs / alerting without spamming.
  _alertStaleSports();

  // Fire-and-forget alt-line pre-warm per sport — don't block the main refresh
  // cycle on this. Keeps the critical RFQ path hitting cache instead of The
  // Odds API network round-trip.
  for (const sport of sportsToRefresh) {
    if (!SPORTS_WITH_ALT_MARKETS.has(sport)) continue;
    warmAltLines(sport).catch(err => {
      log.warn('OddsFeed', `Alt-line warm failed for ${sport}: ${err.message}`);
    });
  }

  // Fire-and-forget h2h backfill for SharpAPI-primary sports where some
  // events lack moneyline data. One bulk Odds API call per sport —
  // cheap relative to the per-event alt-line fetches.
  for (const sport of sportsToRefresh) {
    if (!H2H_BACKFILL_SPORTS.has(sport)) continue;
    backfillMissingH2h(sport).catch(err => {
      log.warn('OddsFeed', `H2H backfill failed for ${sport}: ${err.message}`);
    });
  }

  // Fire-and-forget DK MMA merge — covers UFC Fight Night prelims that
  // The Odds API routinely misses. Adds ~15s of Puppeteer fetch on a
  // 15-min cache, so negligible load.
  if (sportsToRefresh.includes('mma_mixed_martial_arts')) {
    mergeDkMmaFights().catch(err => {
      log.warn('OddsFeed', `DK MMA merge failed: ${err.message}`);
    });
  }

  // Fire-and-forget DK tennis merge — covers the 250-level tournaments TOA
  // never lists (all 41 TOA tennis keys go inactive between big events, and
  // tennis goes completely dark without this). Additive-only: when a TOA
  // tournament IS active its multi-book consensus wins. Same 15-min DK cache
  // economics as the MMA merge above.
  if (sportsToRefresh.includes('tennis')) {
    // Chained, never parallel: each merge must see the previous one's events
    // so it only fills genuine gaps. Order IS priority — neither clobbers an
    // already-covered pair.
    //   DK       — richest board when it works, but Akamai-gated on Railway,
    //              so in production it usually contributes nothing.
    //   Pinnacle — sharpest book AND the only source with a real half-point
    //              ladder (game spreads +/-1.5..4.5, totals 20.5..26.5). Plain
    //              HTTPS JSON, so it actually runs in prod. Probed 2026-08-01:
    //              84 pre-match games, 83 with spreads, 82 with totals.
    //   Bovada   — last-resort coverage. Carries the markets but posts a single
    //              integer game spread and one total, so on a PX half-point
    //              ladder it contributes almost no quotable lines by itself.
    mergeDkTennisMatches()
      .catch(err => { log.warn('OddsFeed', `DK tennis merge failed: ${err.message}`); })
      .then(() => mergePinnacleTennisMatches())
      .catch(err => { log.warn('OddsFeed', `Pinnacle tennis merge failed: ${err.message}`); })
      .then(() => mergeBovadaTennisMatches())
      .catch(err => { log.warn('OddsFeed', `Bovada tennis merge failed: ${err.message}`); })
      // LAST, and only when the sets feature is on. This is an ENRICHMENT pass
      // that attaches set markets to events the merges above created, so it must
      // run after them or it finds no host events. Gated because the per-event
      // fan-out costs one paced TOA call per match.
      .then(() => (config.pricing.tennisSetsEnabled ? mergeToaTennisSets() : null))
      .catch(err => { log.warn('OddsFeed', `TOA tennis sets overlay failed: ${err.message}`); });
  }

  return results;
}

function getCacheStatus() {
  const status = {};
  // Include golf_matchups (DataGolf) alongside configured sports
  const sports = [...config.supportedSports];
  if (oddsCache['golf_matchups'] && !sports.includes('golf_matchups')) {
    sports.push('golf_matchups');
  }
  for (const sport of sports) {
    const cache = oddsCache[sport];
    const totalEvents = cache ? Object.values(cache.events).reduce((s, entry) => s + (Array.isArray(entry) ? entry.length : 1), 0) : 0;
    status[sport] = cache ? {
      eventCount: totalEvents,
      ageMinutes: Math.round(getCacheAge(sport) * 10) / 10,
      stale: isStale(sport),
    } : { eventCount: 0, ageMinutes: null, stale: true };
  }
  return status;
}

function __debugGetCache(sport) {
  return oddsCache[sport] || null;
}

// TEST SEAM ONLY. Lets a test install a synthetic cache entry so the
// selection-routing branches of getFairProb can be exercised without a live
// fetch. Never called from production code -- a mis-mapped selection is the
// ~17pp bug class (3-way win priced off the draw-no-bet board), so those
// branches need coverage that does not depend on the network.
function __debugSetCache(sport, entry) {
  oddsCache[sport] = entry;
}

// ---------------------------------------------------------------------------
// CLOSING LINE CAPTURE — snapshots Pinnacle + consensus fair probs for every
// event the moment its commenceTime crosses into the past. Used for CLV
// analysis at settlement time. Idempotent — only captures a given event once.
// ---------------------------------------------------------------------------

const CLOSING_CAPTURE_WINDOW_MS = 20 * 60 * 1000; // capture within 20min of commence

function captureClosingLines() {
  const now = Date.now();
  let captured = 0;
  for (const sport of Object.keys(oddsCache)) {
    const cache = oddsCache[sport];
    if (!cache || !cache.events) continue;
    for (const [key, entry] of Object.entries(cache.events)) {
      const events = Array.isArray(entry) ? entry : [entry];
      for (const event of events) {
        if (!event || !event.homeTeam || !event.commenceTime) continue;
        const startMs = new Date(event.commenceTime).getTime();
        if (isNaN(startMs)) continue;
        // Only capture events whose commenceTime is in the past but within
        // the capture window. Events more than 20 min past commence are
        // already "closed" enough — don't overwrite.
        const age = now - startMs;
        if (age < 0) continue; // not yet started
        if (age > CLOSING_CAPTURE_WINDOW_MS) continue; // already past window
        const cacheKey = sport + '|' + key + '|' + (event.eventId || '');
        if (closingLinesCache[cacheKey]) continue; // already captured
        // Snapshot the relevant markets
        const m = event.markets || {};
        const snap = {
          sport,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          commenceTime: event.commenceTime,
          capturedAt: new Date().toISOString(),
          markets: {},
          pinnacle: {},
        };
        if (m.h2h) {
          snap.markets.h2h = {
            home: m.h2h.home?.fairProb || null,
            away: m.h2h.away?.fairProb || null,
            homeDisplayFair: m.h2h.home?.displayFairProb || null,
            awayDisplayFair: m.h2h.away?.displayFairProb || null,
          };
          if (m.h2h.pinnacle) {
            snap.pinnacle.h2h = {
              home: m.h2h.pinnacle.home,
              away: m.h2h.pinnacle.away,
            };
          }
        }
        if (m.spreads) {
          snap.markets.spreads = {
            line: m.spreads.line,
            home: m.spreads.home?.fairProb || null,
            away: m.spreads.away?.fairProb || null,
          };
          if (m.spreads.pinnacle) {
            snap.pinnacle.spreads = {
              line: m.spreads.line,
              home: m.spreads.pinnacle.home,
              away: m.spreads.pinnacle.away,
            };
          }
        }
        if (m.totals) {
          snap.markets.totals = {
            line: m.totals.line,
            over: m.totals.over?.fairProb || null,
            under: m.totals.under?.fairProb || null,
          };
          if (m.totals.pinnacle) {
            snap.pinnacle.totals = {
              line: m.totals.line,
              over: m.totals.pinnacle.over,
              under: m.totals.pinnacle.under,
            };
          }
        }
        closingLinesCache[cacheKey] = snap;
        captured++;
        // Write-through persistence (SGP roadmap Stage 0 item 7): the
        // in-memory cache is wiped on every deploy, which silently destroys
        // CLV history — the master adverse-selection instrument for the
        // SGP rollout. Requires the closing_lines table (ops SQL); fails
        // silently (warn-once) until it exists. Fire-and-forget.
        try {
          const db = require('./db');
          if (typeof db.saveClosingLine === 'function') {
            db.saveClosingLine(cacheKey, snap).catch(err => {
              if (!captureClosingLines._persistWarned) {
                log.warn('CLV', `closing-line persist failed (logged once — run the closing_lines ops SQL?): ${err.message}`);
                captureClosingLines._persistWarned = true;
              }
            });
          }
        } catch (_) { /* persistence must never break capture */ }
      }
    }
  }
  if (captured > 0) log.info('CLV', `Captured ${captured} closing line snapshot(s) (total cached: ${Object.keys(closingLinesCache).length})`);
  return { captured, total: Object.keys(closingLinesCache).length };
}

/**
 * Look up a closing line snapshot by event key. Tries primary key first,
 * then falls back to any matching sport + event key.
 */
function getClosingLineSnapshot(sport, homeTeam, awayTeam, pxEventId) {
  const key = normalizeEventKey(homeTeam, awayTeam);
  // Try exact match first
  const exactKey = sport + '|' + key + '|' + (pxEventId || '');
  if (closingLinesCache[exactKey]) return closingLinesCache[exactKey];
  // Fallback: any snapshot matching sport + team key
  const prefix = sport + '|' + key + '|';
  for (const k of Object.keys(closingLinesCache)) {
    if (k.startsWith(prefix)) return closingLinesCache[k];
  }
  return null;
}

function getClosingLinesStatus() {
  return {
    total: Object.keys(closingLinesCache).length,
    sports: (() => {
      const bySport = {};
      for (const snap of Object.values(closingLinesCache)) {
        bySport[snap.sport] = (bySport[snap.sport] || 0) + 1;
      }
      return bySport;
    })(),
  };
}

function getAllCachedEvents() {
  const all = [];
  for (const sport of Object.keys(oddsCache)) {
    const cache = oddsCache[sport];
    if (!cache || !cache.events) continue;
    for (const [key, entry] of Object.entries(cache.events)) {
      // SharpAPI stores arrays (for doubleheaders), Odds API stores single objects
      const events = Array.isArray(entry) ? entry : [entry];
      for (const event of events) {
        if (!event || !event.homeTeam) continue;
        all.push({
          sport,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          markets: event.markets ? Object.keys(event.markets) : [],
          commenceTime: event.commenceTime,
        });
      }
    }
  }
  return all;
}

// Return the list of cached sport keys whose name starts with `prefix`.
// Used by line-manager's tennis fallback to scan tennis_atp_*, tennis_wta_*
// cache slots written by fetchDynamicSports. Generic-sport lookups (e.g.
// 'tennis') sometimes miss events that DO exist in a per-tournament slot,
// either because the dynamic merge wrote stale data to the generic bucket
// or because TOA returned a name variant that only matched in one slot.
function getCachedSportKeysWithPrefix(prefix) {
  if (!prefix) return [];
  return Object.keys(oddsCache).filter(k => k.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function normalizeEventKey(homeTeam, awayTeam) {
  return `${normalizeTeamName(homeTeam)}|${normalizeTeamName(awayTeam)}`;
}

function normalizeTeamName(name) {
  // NFD-decompose + strip combining marks so diacritics (São, Godínez, Peña)
  // collapse to their ASCII equivalents. Without this, accented characters
  // are deleted outright by the [^a-z0-9 ] filter, corrupting names like
  // "Godínez" → "godnez" and silently breaking every MMA/Soccer matcher
  // that compares against an ASCII-only SharpAPI or TheOddsAPI feed.
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // "&" is a REAL word, not punctuation. The [^a-z0-9 ] filter below deletes
    // it outright, which both loses the word and leaves a double space that
    // defeats substring comparison. TOA spells these clubs out ("Brighton and
    // Hove Albion") while PX uses the ampersand ("Brighton & Hove Albion FC"),
    // so the two never matched and the whole fixture went dark (measured
    // against the live TOA board 2026-08-22). Collapse runs of whitespace for
    // the same reason -- an interior double space is invisible but fatal to
    // .includes().
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// SharpAPI sometimes returns team names with a city abbreviation prefix
// (e.g. "BOS Red Sox") instead of the full city name ("Boston Red Sox")
// that The Odds API, PX, and everything else uses. Without canonicalization
// the same game ends up stored in the cache under TWO different keys —
// "bos red sox|new york yankees" and "boston red sox|new york yankees" —
// and the closest-by-time doubleheader matcher can't work across them.
//
// Observed consequence: April 2026, Red Sox @ Yankees 2-game series.
// SharpAPI cached tonight's game as "BOS Red Sox"; Odds API cached
// tomorrow's game as "Boston Red Sox". Line-manager asked for tonight's
// fair prob with homeTeam="Boston Red Sox"; cache returned tomorrow's
// entry. Red Sox fair came back as 0.421 (tomorrow's pitcher) when the
// correct value for tonight was 0.537. Every parlay with a Red Sox leg
// was priced ~12pp wrong, giving the bettor a ~20% EV edge.
//
// This map lists every team we've observed SharpAPI abbreviate. Extend
// as new offenders appear. Keys + values are raw (pre-lowercase) so
// cleanTeamName runs before normalizeTeamName.
const TEAM_ABBREV_TO_CANONICAL = {
  // MLB
  'BOS Red Sox': 'Boston Red Sox',
  'TOR Blue Jays': 'Toronto Blue Jays',
  // SharpAPI uses "Chicago WS" while TOA + PX use "Chicago White Sox".
  // Without canonicalization, F5 / team_totals supplements run against
  // the SharpAPI-keyed entry (with "Chicago WS") and PX matches against
  // the TOA-keyed entry (with "Chicago White Sox") — null fair-prob on
  // F5 ML / spread / total. Operator-flagged 2026-05-01.
  'Chicago WS': 'Chicago White Sox',
  // Oakland Athletics — three observed variants across feeds:
  //   - SharpAPI: "A's"
  //   - The Odds API: "Oakland Athletics"
  //   - PX (and team's own marketing post-relocation): "Athletics"
  // Without canonicalization, the cache holds three separate entries
  // for tonight's Cleveland @ Athletics game and supplements (F5,
  // team_totals) land on whichever entry resolved the TOA event ID,
  // not the "Athletics"-keyed entry PX matches against. Operator-
  // flagged 2026-05-01: F5 ML / team-total nulls for the A's game.
  // Map all three variants to the PX-side spelling so they collapse
  // into one cache key.
  "A's": 'Athletics',
  'Oakland Athletics': 'Athletics',
  // NHL
  'VGK Golden Knights': 'Vegas Golden Knights',
  'LA Kings': 'Los Angeles Kings',
  // NBA short-name variants. SharpAPI sometimes drops the mascot
  // ("Minnesota" instead of "Minnesota Timberwolves") and sometimes
  // truncates mid-word ("Los Angeles L" → Lakers). PX uses canonical
  // full names. Without canonicalization, the cache holds two-three
  // entries per game and supplements (H1, team_totals, series_*) land
  // on whichever SharpAPI returned, while PX matches the full-name
  // entry. Verified 2026-05-03 via /odds-events scan: Min/SAS,
  // PHI/NYK, LAL/OKC pairs each had 2-3 duplicate cache entries.
  // Only unambiguous cities included here — "Los Angeles" alone could
  // mean Lakers or Clippers, so it's NOT mapped (kept as-is so the
  // matcher uses substring/last-word logic to disambiguate).
  'Minnesota': 'Minnesota Timberwolves',
  'San Antonio': 'San Antonio Spurs',
  'Philadelphia': 'Philadelphia 76ers',
  'Los Angeles L': 'Los Angeles Lakers',

  // Soccer short-vs-full club name variants. Verified 2026-05-03 via
  // /odds-events scan: each pair created two cache entries for the
  // same fixture, dropping fair-prob coverage to zero on whichever
  // entry PX matched against the operator wasn't using.
  //
  // Italy (Serie A):
  'Verona': 'Hellas Verona',
  // Spain (La Liga / Segunda):
  'Oviedo': 'Real Oviedo',
  // Argentina (Primera Division):
  'Rivadavia': 'Independiente Rivadavia',
  'CA Aldosivi': 'Aldosivi',
  'Racing Cordoba': 'Racing de Cordoba',
  // Extend here: add any short-vs-full soccer variants we find in /odds-events
  // duplicate-pair scans. Tennis last-name-only and MMA name-spelling drift
  // need fuzzy matching, not canonicalization — separate effort.
};

/**
 * Clean team names from SharpAPI (removes pitcher info like "(TBD)")
 * and canonicalize known abbreviation-prefixed names so they collide
 * with the Odds API / PX full-name versions in the cache.
 */
function cleanTeamName(name) {
  const stripped = (name || '')
    // Trailing parenthetical (MLB starter, e.g. "Yankees (Cole)"). Existing.
    .replace(/\s*\([^)]*\)\s*$/, '')
    // Leading "Game N:" / "Game N -" prefix that SharpAPI prepends to
    // team names during NBA/NHL playoff series. Without this strip the
    // cached awayTeam ends up as "Game 5: Minnesota Timberwolves",
    // which breaks resolveOddsApiEventId() in the H1 / F5 / team-totals
    // supplements (TOA has the canonical name "Minnesota Timberwolves",
    // not the prefixed form). Result: supplement silently skips the
    // event, markets.h2h_h1 never populated, RFQs for that event's
    // playoff H1/F5/team-total markets decline as "no fair value".
    // Operator-flagged 2026-04-27 (Nuggets H1 ML decline screenshot).
    .replace(/^Game\s+\d+\s*[:\-]\s*/i, '')
    .trim();
  return TEAM_ABBREV_TO_CANONICAL[stripped] || stripped;
}

/**
 * Extract starter name (MLB pitcher / NHL goalie) from a SharpAPI team name.
 * SharpAPI format: "New York Yankees (Gerrit Cole)" → "Gerrit Cole"
 * Returns null if no starter listed or if the starter is "TBD" / blank.
 */
function extractStarter(name) {
  if (!name) return null;
  const m = name.match(/\(([^)]+)\)\s*$/);
  if (!m) return null;
  const s = m[1].trim();
  if (!s || /^tbd$/i.test(s) || /^tba$/i.test(s)) return null;
  return s;
}

/**
 * Resolve the lineup cache entry for ONE game.
 *
 * The key is `${normalizedEventKey}|${ISO commence time}` — the exact start,
 * NOT a date bucket. Keying on `${eventKey}|${YYYY-MM-DD}` (what this used to
 * do) COLLIDES the two games of a series: an ET evening game rolls into the
 * next UTC date and lands on the same date as the following afternoon's game.
 * Both games then shared one entry, so every refresh overwrote game A's
 * pitchers with game B's, `updateLineupState` scored that as a lineup change,
 * and the 3-minute grace was re-armed forever. Measured 2026-08-04: Cubs/
 * Dodgers 00:06Z + 18:21Z, Astros/Blue Jays 00:10Z + 18:11Z and Rockies/Rays
 * 00:41Z + 19:11Z were each stuck in grace for 13.7 HOURS, declining every
 * parlay touching them ($80.8K of matched volume passed on in 3 hours).
 *
 * Because the two writers get commence times from different sources — the odds
 * feed's `ev.commenceTime` and the MLB StatsAPI's `g.gameDate` — an exact key
 * match is not safe either. So resolution is NEAREST-START within
 * LINEUP_SAME_GAME_MS, which is the same closest-commenceTime rule the odds
 * cache already uses for same-day series. Cross-source start times agree to
 * within minutes; the tightest real gap between two games of one pair (a
 * doubleheader) is ~3h, so the 2h window separates games cleanly while
 * absorbing source jitter.
 *
 * Returns the resolved key, or null when there is no match and create=false.
 */
function _resolveLineupKey(bucket, homeTeam, awayTeam, commenceTime, create) {
  const eventKey = normalizeEventKey(homeTeam, awayTeam);
  const prefix = `${eventKey}|`;
  const ms = commenceTime ? new Date(commenceTime).getTime() : NaN;
  if (!isFinite(ms)) {
    // No usable start time: fall back to a single slot for the pair so we
    // degrade to the old (coarse) behaviour rather than dropping the entry.
    const k = `${prefix}unknown`;
    return (bucket[k] || create) ? k : null;
  }
  let bestKey = null, bestDelta = Infinity;
  for (const k of Object.keys(bucket)) {
    if (!k.startsWith(prefix)) continue;
    const e = bucket[k];
    if (!e || !isFinite(e.commenceMs)) continue;
    const d = Math.abs(e.commenceMs - ms);
    if (d < bestDelta) { bestDelta = d; bestKey = k; }
  }
  if (bestKey && bestDelta <= LINEUP_SAME_GAME_MS) return bestKey;
  return create ? `${prefix}${new Date(ms).toISOString()}` : null;
}

/**
 * Drop entries for games that started well in the past. Without this the cache
 * grows without bound — every game ever seen keeps its own key now that keys
 * are per-game rather than per-day.
 */
function _pruneLineupCache(bucket, now) {
  for (const k of Object.keys(bucket)) {
    const e = bucket[k];
    if (e && isFinite(e.commenceMs) && now - e.commenceMs > LINEUP_PRUNE_MS) delete bucket[k];
  }
}

/**
 * Update lineup cache for a single event. Detects changes in starting
 * pitcher/goalie and stamps lastChangeAt when one is seen. Called during
 * the odds refresh flow for MLB and NHL only.
 *
 * A "change" is ONLY a real name replacing a DIFFERENT real name. Two other
 * transitions are deliberately NOT changes:
 *   null → name  is the first time a source told us who is starting.
 *   name → null  is a source GAP, not a scratch. This matters because the odds
 *                feed writer still runs for MLB but `extractStarter` only ever
 *                finds a pitcher in SharpAPI-style "Team (Pitcher)" strings;
 *                TOA sends a bare "Chicago Cubs", so it contributes null for
 *                every game. Treating that as a scratch let a source with no
 *                lineup data at all repeatedly blank out the StatsAPI pitcher
 *                and re-arm the grace window — the second half of the same
 *                2026-08-04 outage.
 */
function updateLineupState(sport, homeTeam, awayTeam, commenceTime, homeStarter, awayStarter) {
  if (!lineupCache[sport]) lineupCache[sport] = {};
  const bucket = lineupCache[sport];
  const now = Date.now();
  const key = _resolveLineupKey(bucket, homeTeam, awayTeam, commenceTime, true);
  const prior = bucket[key];
  const commenceMs = commenceTime ? new Date(commenceTime).getTime() : NaN;

  if (!prior) {
    // First time seeing this game — just stash the baseline (no change event)
    bucket[key] = {
      homeStarter,
      awayStarter,
      commenceMs,
      seenAt: now,
      lastChangeAt: null,
      lastChangeDetail: null,
    };
    _pruneLineupCache(bucket, now);
    return;
  }

  // Only a real→different-real swap counts. See the doc comment above.
  const swapped = (before, after) => !!before && !!after && before !== after;
  const homeDiff = swapped(prior.homeStarter, homeStarter);
  const awayDiff = swapped(prior.awayStarter, awayStarter);

  if (homeDiff || awayDiff) {
    const parts = [];
    if (homeDiff) parts.push(`${homeTeam}: ${prior.homeStarter} → ${homeStarter}`);
    if (awayDiff) parts.push(`${awayTeam}: ${prior.awayStarter} → ${awayStarter}`);
    const detail = parts.join('; ');
    log.info('Lineup', `${sport} lineup change detected — ${detail}`);
    bucket[key] = {
      homeStarter,
      awayStarter,
      commenceMs: isFinite(commenceMs) ? commenceMs : prior.commenceMs,
      seenAt: now,
      lastChangeAt: now,
      lastChangeDetail: detail,
    };
  } else {
    // No change — refresh seenAt but preserve lastChangeAt so the grace
    // window continues to count from the original change time. Never let a
    // null overwrite a known starter (that is the source-gap case).
    if (homeStarter) prior.homeStarter = homeStarter;
    if (awayStarter) prior.awayStarter = awayStarter;
    if (isFinite(commenceMs)) prior.commenceMs = commenceMs;
    prior.seenAt = now;
  }
}

/**
 * Check whether an event's lineup recently changed (within grace window).
 * Returns { changed: true, ageMs, detail } if within grace, else null.
 * Used by the pricer to decline MLB/NHL legs for a few minutes after a
 * starter swap so the books have time to re-price.
 *
 * Non-MLB/NHL sports always return null (not tracked).
 */
function checkLineupFreshness(sport, homeTeam, awayTeam, commenceTime) {
  if (sport !== 'baseball_mlb' && sport !== 'icehockey_nhl') return null;
  const bucket = lineupCache[sport];
  if (!bucket) return null;
  const key = _resolveLineupKey(bucket, homeTeam, awayTeam, commenceTime, false);
  const entry = key && bucket[key];
  if (!entry || !entry.lastChangeAt) return null;
  const ageMs = Date.now() - entry.lastChangeAt;
  if (ageMs >= LINEUP_GRACE_MS) return null;
  return { changed: true, ageMs, detail: entry.lastChangeDetail };
}

/**
 * Debug accessor — return the full lineup cache for /lineups endpoint.
 */
function getLineupCache() {
  return lineupCache;
}

/**
 * Determine which side of a game a pitcher is on. Returns 'home' or
 * 'away' if the pitcher is the listed starter on that side, else null.
 * Used by the K-prop + ML SGP combo gate to verify the ML leg matches
 * the pitcher's team (allowed) vs the opposing team (blocked — that
 * combo is anti-correlated and a weird bet).
 */
function getPitcherSide(sport, homeTeam, awayTeam, commenceTime, playerName) {
  if (!playerName) return null;
  const bucket = lineupCache[sport];
  if (!bucket) return null;
  const key = _resolveLineupKey(bucket, homeTeam, awayTeam, commenceTime, false);
  const entry = key && bucket[key];
  if (!entry) return null;
  // Diacritic-insensitive comparison (PX may send "Randy Vásquez" while
  // SharpAPI lineup has "Randy Vasquez"). Mirror the prop-matcher's
  // normalization.
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const target = norm(playerName);
  if (entry.homeStarter && norm(entry.homeStarter) === target) return 'home';
  if (entry.awayStarter && norm(entry.awayStarter) === target) return 'away';
  return null;
}

// ---------------------------------------------------------------------------
// SCORES — fetch game results from The Odds API for early win detection
// ---------------------------------------------------------------------------

const scoresCache = {}; // { sport: { fetchedAt, games: [{ homeTeam, awayTeam, commenceTime, completed, homeScore, awayScore }] } }
const SCORES_TTL_MS = 30 * 1000; // 30s cache — pairs with checkLegResults running every 30s. Bounds TOA hit rate while keeping completion latency low.

// Cache of active sport keys discovered from The Odds API's /v4/sports/.
// Used to expand 'soccer' (generic) into per-league fetches. The list
// rarely changes; 6h TTL is plenty.
let _activeSportsCache = { fetchedAt: 0, keys: [] };
const ACTIVE_SPORTS_TTL_MS = 6 * 60 * 60 * 1000;

// Internal-key → Odds-API-key overrides. Most of our sport keys match
// The Odds API 1:1, but a few are wrong / use different naming:
//   - soccer_conmebol_libertadores → soccer_conmebol_copa_libertadores
//     (audited Apr 26: Odds API uses the longer 'copa' form)
// Add new entries here when /audit-scores reveals more drift; missing
// keys silently 404 and cause stuck-pending status circles in the UI.
const SCORES_API_KEY_OVERRIDES = {
  'soccer_conmebol_libertadores': 'soccer_conmebol_copa_libertadores',
};

async function _getActiveSportsList() {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return [];
  if (Date.now() - _activeSportsCache.fetchedAt < ACTIVE_SPORTS_TTL_MS && _activeSportsCache.keys.length > 0) {
    return _activeSportsCache.keys;
  }
  try {
    const resp = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${theOddsApiKey}`);
    if (!resp.ok) return _activeSportsCache.keys;
    const all = await safeJsonFetch(resp);
    const keys = (all || []).filter(s => s.active).map(s => s.key);
    _activeSportsCache = { fetchedAt: Date.now(), keys };
    log.debug('Scores', `Discovered ${keys.length} active sport keys on The Odds API`);
    return keys;
  } catch (err) {
    log.warn('Scores', `Failed to fetch active sports list: ${err.message}`);
    return _activeSportsCache.keys;
  }
}

/**
 * Fetch scores for a sport from The Odds API.
 * Returns array of completed/in-progress games with scores.
 */
async function fetchScores(sport) {
  const theOddsApiKey = process.env.THE_ODDS_API_KEY;
  if (!theOddsApiKey) return [];

  // Check cache
  const cached = scoresCache[sport];
  if (cached && (Date.now() - cached.fetchedAt) < SCORES_TTL_MS) {
    return cached.games;
  }

  // Generic 'soccer' has no Odds API scores endpoint — only league-
  // specific keys do (soccer_epl, soccer_fa_cup, soccer_uefa_*, etc.).
  // Line-manager tags many soccer legs with 'soccer' (generic) because
  // SharpAPI returns all soccer events under that bucket and it's
  // tried first in sportNameMap order. Without this expansion,
  // fetchScores('soccer') 404s silently and no soccer leg ever resolves
  // a score. Operator-visible (Apr 26):
  //   - EPL Leeds @ Chelsea finished but parlay status stayed grey
  //   - FA Cup match also missed (initially missed by my hardcoded list
  //     because PINNACLE_SPORT_MAP only had 12 of 53 active soccer keys)
  //
  // Use dynamic discovery (active soccer_* keys from /v4/sports/) so
  // the aggregation auto-covers any soccer league The Odds API supports
  // — FA Cup, Coppa Italia, DFB-Pokal, J-League, K-League, etc. — without
  // hardcoding. Same pattern available for any other generic key (e.g.
  // tennis is already handled separately via ODDS_API_FALLBACK.dynamic).
  if (sport === 'soccer') {
    const allActive = await _getActiveSportsList();
    const soccerLeagues = allActive.filter(k => k.startsWith('soccer_'));
    let allGames = [];
    for (const league of soccerLeagues) {
      try {
        const games = await fetchScores(league);
        if (games && games.length > 0) allGames = allGames.concat(games);
      } catch (_) { /* per-league failure shouldn't block others */ }
    }
    scoresCache[sport] = { fetchedAt: Date.now(), games: allGames };
    log.debug('Scores', `Cached ${allGames.length} aggregated soccer scores from ${soccerLeagues.length} active leagues (dynamic)`);
    return allGames;
  }

  const parseGames = (data) => (data || []).map(g => ({
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    commenceTime: g.commence_time,
    completed: g.completed || false,
    homeScore: g.scores?.find(s => s.name === g.home_team)?.score != null ? Number(g.scores.find(s => s.name === g.home_team).score) : null,
    awayScore: g.scores?.find(s => s.name === g.away_team)?.score != null ? Number(g.scores.find(s => s.name === g.away_team).score) : null,
  }));

  try {
    // Dynamic sports (tennis) need tournament discovery — The Odds API
    // doesn't have a generic 'tennis' scores endpoint.
    const fallback = ODDS_API_FALLBACK[sport];
    if (fallback && fallback.dynamic && fallback.sportPrefix) {
      const sportsResp = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${theOddsApiKey}`);
      if (!sportsResp.ok) return cached?.games || [];
      const allSports = await sportsResp.json();
      const active = allSports.filter(s => s.key.startsWith(fallback.sportPrefix) && s.active);
      if (active.length === 0) return cached?.games || [];

      let allGames = [];
      for (const tournament of active) {
        const url = `https://api.the-odds-api.com/v4/sports/${tournament.key}/scores/?apiKey=${theOddsApiKey}&daysFrom=1`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          allGames = allGames.concat(parseGames(data));
        }
      }
      scoresCache[sport] = { fetchedAt: Date.now(), games: allGames };
      log.debug('Scores', `Cached ${allGames.length} scores for ${sport} from ${active.length} tournaments (${allGames.filter(g => g.completed).length} completed)`);
      return allGames;
    }

    // Standard sports — direct fetch. Translate via SCORES_API_KEY_OVERRIDES
    // for any sport key whose Odds API name doesn't match our internal one
    // (e.g. soccer_conmebol_libertadores → soccer_conmebol_copa_libertadores).
    const apiSport = SCORES_API_KEY_OVERRIDES[sport] || sport;
    const url = `https://api.the-odds-api.com/v4/sports/${apiSport}/scores/?apiKey=${theOddsApiKey}&daysFrom=1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      log.debug('Scores', `Failed to fetch scores for ${sport}: ${resp.status}`);
      return cached?.games || [];
    }

    const games = parseGames(await resp.json());
    scoresCache[sport] = { fetchedAt: Date.now(), games };
    log.debug('Scores', `Cached ${games.length} scores for ${sport} (${games.filter(g => g.completed).length} completed)`);
    return games;
  } catch (err) {
    log.error('Scores', `Error fetching scores for ${sport}: ${err.message}`);
    return cached?.games || [];
  }
}

/**
 * Get game result for a specific matchup.
 * Returns { completed, homeScore, awayScore, winner: 'home'|'away'|'tie'|null } or null.
 */
async function getGameResult(sport, homeTeam, awayTeam, startTime) {
  // ESPN scoreboard is the primary score source — covers every supported
  // sport, updates within ~30s of real-time, free, no quota burn. The TOA
  // /scores fallback below catches any sport ESPN doesn't have a league
  // path for (or any single missed game where ESPN's team names didn't
  // match our normalization). Sync read against the in-memory cache the
  // ESPN poller fills in the background — never makes a network call.
  try {
    const espnScores = require('./espn-scores');
    // Pass startTime so ESPN disambiguates same-team back-to-back days
    // (e.g. Blue Jays played 5/2 + 5/3 — without time-match the cache
    // would return whichever game it sees first, flipping a resolved
    // leg's status).
    const espnHit = espnScores.getEspnGameResult(sport, homeTeam, awayTeam, startTime);
    if (espnHit && espnHit.completed) return espnHit;
    // Hit but not completed yet — fall through to TOA in case TOA has
    // a result ESPN hasn't marked completed yet.
  } catch (_) { /* espn-scores unavailable — fall through */ }

  const games = await fetchScores(sport);
  if (games.length === 0) return null;
  return _matchScoreGame(games, homeTeam, awayTeam, startTime);
}

/**
 * Pure matcher: find `games` entry for this matchup and return its result in
 * the CALLER's home/away orientation. Extracted from getGameResult so the
 * orientation logic is unit-testable without a network round-trip (the
 * flipped-feed inversion bug shipped precisely because nothing covered it).
 * Exported as _matchScoreGame for tests; not part of the public API.
 */
function _matchScoreGame(games, homeTeam, awayTeam, startTime) {
  // Match by team names (normalize for comparison)
  const normHome = normalizeTeamName(homeTeam);
  const normAway = normalizeTeamName(awayTeam);
  const targetTime = startTime ? new Date(startTime).getTime() : null;

  let bestMatch = null;
  let bestDiff = Infinity;
  // Whether the chosen match is stored in the OPPOSITE home/away orientation
  // from the caller's. MUST be tracked, not just used to accept the match:
  // see the flip-back below.
  let bestFlipped = false;

  for (const g of games) {
    const gHome = normalizeTeamName(g.homeTeam);
    const gAway = normalizeTeamName(g.awayTeam);

    // Check both orderings
    const match = (gHome.includes(normHome) || normHome.includes(gHome)) &&
                  (gAway.includes(normAway) || normAway.includes(gAway));
    const matchReverse = (gHome.includes(normAway) || normAway.includes(gHome)) &&
                         (gAway.includes(normHome) || normHome.includes(gAway));

    if (!match && !matchReverse) continue;
    // Prefer the forward reading when BOTH orderings match (self-matching
    // name pairs) — only treat as flipped when reverse is the sole match.
    const flipped = !match && matchReverse;

    // If multiple matches (doubleheader), pick closest by time
    if (targetTime && g.commenceTime) {
      const diff = Math.abs(new Date(g.commenceTime).getTime() - targetTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = g;
        bestFlipped = flipped;
      }
    } else {
      bestMatch = g;
      bestFlipped = flipped;
    }
  }

  if (!bestMatch) return null;
  if (bestMatch.homeScore == null || bestMatch.awayScore == null) {
    return { completed: bestMatch.completed, homeScore: null, awayScore: null, winner: null };
  }

  // Re-orient to the CALLER's home/away before deriving anything. This block
  // accepted a reverse-orientation match but then reported winner/scores in
  // the FEED's orientation — silently INVERTING every result whose feed
  // orientation differed from ours. MMA/boxing have no true home/away, so
  // sources disagree routinely: on 2026-07-25 TOA listed
  // "Ponzinibbio (home) vs Patterson (away)" while our line had Patterson as
  // home, so Patterson's WIN graded as a LOSS (same for Sola, Said). The
  // operator saw settled parlays whose legs showed ✗ yet were charged as SP
  // losses. P&L itself was safe (PX settlementStatus is authoritative in
  // reconcileSettlements), but inferredResult also drives isParlayAlreadyDead
  // — which RELEASES EXPOSURE on a live parlay — and the dashboard's leg
  // marks, which deliberately prefer inferredResult over PX on disagreement.
  // espn-scores.getEspnGameResult already did this correctly (bestFlipped);
  // this is the TOA-fallback twin of that logic.
  const homeScore = bestFlipped ? bestMatch.awayScore : bestMatch.homeScore;
  const awayScore = bestFlipped ? bestMatch.homeScore : bestMatch.awayScore;

  let winner = null;
  if (homeScore > awayScore) winner = 'home';
  else if (awayScore > homeScore) winner = 'away';
  else winner = 'tie';

  return {
    completed: bestMatch.completed,
    homeScore,
    awayScore,
    winner,
  };
}

// ---------------------------------------------------------------------------
// PLAYER-PROP LOOKUP (Phase 1 shadow-pricing)
// ---------------------------------------------------------------------------
// Find SharpAPI player_strikeouts rows that match a PX leg's pitcher name +
// line value. Used by services/websocket.js shadow-pricing hook to log what
// we WOULD have priced — does NOT affect quote/decline behavior.
//
// Inputs:
//   sport          'baseball_mlb'
//   pxEventInfo    { homeTeam, awayTeam, startTime, ... } from line-manager
//                  (used to disambiguate which SharpAPI event_id this PX
//                  leg belongs to — PX and SharpAPI use different event ids)
//   playerName     extracted from PX market name e.g. "Tarik Skubal" parsed
//                  out of "Tarik Skubal Pitching Strikeouts"
//   line           numeric line value (e.g. 6.5)
//
// Returns:
//   {
//     matchedRows:    [...all SharpAPI rows matching player+line for this event],
//     books:          ['draftkings', 'fanduel'],
//     sides:          { over: [...], under: [...] }, // by selection
//     fairProbOver:   de-vigged fair P(Over) across books, or null,
//     fairProbUnder:  de-vigged fair P(Under) across books, or null,
//     resolvedEventId: SharpAPI event_id we matched against,
//   }
//   or null if no match found (for any reason — log the reason via stage).
function lookupPlayerStrikeoutProp(sport, pxEventInfo, playerName, line) {
  const stages = []; // for debug visibility into why a lookup failed
  if (!sport || !pxEventInfo || !playerName) {
    return { error: 'missing_input', stages: ['precondition'] };
  }
  const sportCache = propRowsCache[sport];
  if (!sportCache || !sportCache.player_strikeouts) {
    return { error: 'no_prop_cache', stages: ['cache_empty'] };
  }
  const allRows = sportCache.player_strikeouts;
  stages.push(`cache:${allRows.length}rows`);

  // Step 1: filter by event. SharpAPI event_id won't match PX's
  // sport_event_id, so match by home/away team + start time proximity.
  // Use normalizeTeamName + last-2-words matching to handle the
  // "BOS Red Sox" vs "Boston Red Sox" case (cleanTeamName at cache
  // time should already canonicalize this, but keep last-words
  // fallback for any abbrevs not in TEAM_ABBREV_TO_CANONICAL).
  const lastWords = (name, n = 2) => {
    const words = normalizeTeamName(name).split(/\s+/).filter(Boolean);
    return words.slice(-n).join(' ');
  };
  const pxHomeKey = lastWords(pxEventInfo.homeTeam || '');
  const pxAwayKey = lastWords(pxEventInfo.awayTeam || '');
  const pxStartMs = pxEventInfo.startTime ? Date.parse(pxEventInfo.startTime) : null;
  // Always surface PX teams in stages — makes "no_event_match" failures
  // self-debuggable from the persisted shadow log without needing to
  // cross-reference px_event_id back to the event mapping.
  stages.push(`px:${pxEventInfo.awayTeam || '?'}@${pxEventInfo.homeTeam || '?'}`);
  const teamMatchRows = allRows.filter(r => {
    const rh = lastWords(r.home_team || '');
    const ra = lastWords(r.away_team || '');
    // Bidirectional — SharpAPI sometimes flips home/away.
    return (rh === pxHomeKey && ra === pxAwayKey) ||
           (rh === pxAwayKey && ra === pxHomeKey);
  });
  stages.push(`team_match:${teamMatchRows.length}`);
  if (teamMatchRows.length === 0) {
    // Surface the available SharpAPI events so we can tell at a glance
    // whether the cache simply doesn't have prop data for this game (PX
    // game outside SharpAPI's prop slate) vs a team-name-matching bug.
    const availableEvents = [...new Set(allRows.map(r => `${r.away_team}@${r.home_team}`))];
    stages.push(`available:${availableEvents.join('|')}`);
    return { error: 'no_event_match', stages, availableEvents };
  }

  // If we have multiple events matching (doubleheader), narrow by start time
  let eventRows = teamMatchRows;
  if (pxStartMs) {
    const eventIds = [...new Set(teamMatchRows.map(r => r.event_id))];
    if (eventIds.length > 1) {
      // Pick event whose start time is closest to PX leg's start time
      const eventsByDist = eventIds.map(eid => {
        const sample = teamMatchRows.find(r => r.event_id === eid);
        const eMs = sample.event_start_time ? Date.parse(sample.event_start_time) : 0;
        return { eid, dist: Math.abs(eMs - pxStartMs) };
      }).sort((a, b) => a.dist - b.dist);
      const bestId = eventsByDist[0].eid;
      eventRows = teamMatchRows.filter(r => r.event_id === bestId);
      stages.push(`dh_resolve:${eventsByDist.length}->${bestId}`);
    }
  }
  const resolvedEventId = eventRows[0].event_id;

  // Step 2: filter by player_name. SharpAPI appends side-disambiguation
  // suffixes: "Tarik Skubal Thrown" (pitcher), "Aaron Judge Recorded"
  // (batter K). Strip the suffix before matching. Also strip diacritics
  // — PX sends "Randy Vásquez" but SharpAPI returns "Randy Vasquez".
  const stripDiacritics = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normPlayer = stripDiacritics(playerName).toLowerCase().trim();
  const matchedRows = eventRows.filter(r => {
    const raw = stripDiacritics(r.player_name || '').toLowerCase();
    const stripped = raw.replace(/\s*-\s*total$/, '').replace(/\s+(thrown|recorded)$/, '').trim();
    // Tolerant match — substring both directions in case of formatting drift
    return stripped === normPlayer || stripped.includes(normPlayer) || normPlayer.includes(stripped);
  });
  stages.push(`player_match:${matchedRows.length}`);
  if (matchedRows.length === 0) {
    return { error: 'no_player_match', stages, resolvedEventId,
             samplePlayers: [...new Set(eventRows.map(r => r.player_name))].slice(0, 5) };
  }

  // Step 3: filter by line value (allow tiny float fuzz)
  const lineRows = line == null ? matchedRows : matchedRows.filter(r => Math.abs((r.line || 0) - line) < 0.01);
  stages.push(`line_match:${lineRows.length}`);
  if (lineRows.length === 0) {
    return { error: 'no_line_match', stages, resolvedEventId,
             sampleLines: [...new Set(matchedRows.map(r => r.line))].slice(0, 8) };
  }

  // Step 4: split by side and compute de-vigged fair probs across books.
  const overRows = lineRows.filter(r => /over/i.test(r.selection || r.selection_type || ''));
  const underRows = lineRows.filter(r => /under/i.test(r.selection || r.selection_type || ''));
  const books = [...new Set(lineRows.map(r => r.sportsbook).filter(Boolean))];
  // Surface side-availability per book so it's easy to see which side is
  // missing when books_with_both_sides=0. Common pattern: low-line K
  // props (Anthony Kay 3.5) only have Over priced because Under is too
  // long-shot to be open.
  stages.push(`sides:over=${overRows.length},under=${underRows.length}`);

  // Per-book de-vig: pair Over/Under from the same book, devig with the
  // existing 2-way helper, then average fair probs across books.
  // NOTE: deVig2Way returns an ARRAY [fair1, fair2], not an object.
  const fairProbsOver = [];
  const fairProbsUnder = [];
  const viggedProbsOver = [];
  const viggedProbsUnder = [];
  for (const book of books) {
    const o = overRows.find(r => r.sportsbook === book);
    const u = underRows.find(r => r.sportsbook === book);
    if (!o || !u) continue;
    const oProb = americanToImpliedProb(o.odds_american);
    const uProb = americanToImpliedProb(u.odds_american);
    if (oProb == null || uProb == null) continue;
    viggedProbsOver.push(oProb);
    viggedProbsUnder.push(uProb);
    const dv = deVig2Way(oProb, uProb);
    if (Array.isArray(dv) && dv.length === 2 && Number.isFinite(dv[0]) && Number.isFinite(dv[1])) {
      fairProbsOver.push(dv[0]);
      fairProbsUnder.push(dv[1]);
    }
  }
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const { fairProbOver, fairProbUnder } = _applyPropHeavyFavFloor(
    avg(fairProbsOver), avg(fairProbsUnder),
    avg(viggedProbsOver), avg(viggedProbsUnder)
  );

  return {
    matchedRows: lineRows,
    books,
    sides: { over: overRows, under: underRows },
    fairProbOver,
    fairProbUnder,
    booksWithBothSides: fairProbsOver.length, // count of books that had both Over+Under
    resolvedEventId,
    fetchedAt: sportCache.fetchedAt || null, // for downstream stale checks
    stages,
  };
}

// Heavy-favorite floor for prop fair probs. Proportional de-vig systematically
// underestimates the true prob on lopsided 2-way prop markets (the books'
// vigged price already captures information the proportional split can't
// recover — e.g. hitter Over 0.5 hits at -200 / +160 vigged-implied
// 67%/38%, summed 105% overround → naive de-vig over = 67/105 = 64%, but
// the true prob is closer to the vigged 67% because the bookmaker's line
// reflects player batting average, lineup spot, weather, etc. that the
// de-vig can't see). Floor each side's fair at avg book vigged minus a
// small buffer when the side is a heavy favorite (>threshold). Symmetric:
// fires for either Over or Under, whichever side is the heavy fav.
//
// Returns { fairProbOver, fairProbUnder } with the floor applied (or
// passes through unchanged on non-heavy-fav legs).
function _applyPropHeavyFavFloor(devigOver, devigUnder, viggedOver, viggedUnder) {
  const cfg = require('../config').config;
  const thresh = (cfg && cfg.pricing && cfg.pricing.propHeavyFavFloorThresh) || 0.60;
  const buffer = (cfg && cfg.pricing && cfg.pricing.propHeavyFavFloorBuffer) || 0.005;
  let outOver = devigOver, outUnder = devigUnder;
  if (devigOver != null && viggedOver != null && devigOver > thresh) {
    const floor = viggedOver - buffer;
    if (floor > devigOver) outOver = floor;
  }
  if (devigUnder != null && viggedUnder != null && devigUnder > thresh) {
    const floor = viggedUnder - buffer;
    if (floor > devigUnder) outUnder = floor;
  }
  return { fairProbOver: outOver, fairProbUnder: outUnder };
}

// ---------------------------------------------------------------------------
// NBA PLAYER POINTS PROP LOOKUP (Phase 1 shadow-pricing target)
// ---------------------------------------------------------------------------
// Mirror of lookupPlayerStrikeoutProp but for SharpAPI's player_points
// market_type. NBA player names don't carry the " Thrown" / " Recorded"
// suffix that K-props have, so the player-name match is straightforward.
// Returns the same shape: { fairProbOver, fairProbUnder, books,
// booksWithBothSides, resolvedEventId, fetchedAt, stages, error?, ... }.
function lookupPlayerPointsProp(sport, pxEventInfo, playerName, line) {
  const stages = [];
  if (!sport || !pxEventInfo || !playerName) {
    return { error: 'missing_input', stages: ['precondition'] };
  }
  const sportCache = propRowsCache[sport];
  if (!sportCache || !sportCache.player_points) {
    return { error: 'no_prop_cache', stages: ['cache_empty'] };
  }
  const allRows = sportCache.player_points;
  stages.push(`cache:${allRows.length}rows`);

  // Step 1: filter by event — match on home/away team last-2-words +
  // start-time proximity for back-to-backs (rare in NBA but possible).
  const lastWords = (name, n = 2) => {
    const words = normalizeTeamName(name).split(/\s+/).filter(Boolean);
    return words.slice(-n).join(' ');
  };
  const pxHomeKey = lastWords(pxEventInfo.homeTeam || '');
  const pxAwayKey = lastWords(pxEventInfo.awayTeam || '');
  const pxStartMs = pxEventInfo.startTime ? Date.parse(pxEventInfo.startTime) : null;
  stages.push(`px:${pxEventInfo.awayTeam || '?'}@${pxEventInfo.homeTeam || '?'}`);
  const teamMatchRows = allRows.filter(r => {
    const rh = lastWords(r.home_team || '');
    const ra = lastWords(r.away_team || '');
    return (rh === pxHomeKey && ra === pxAwayKey) ||
           (rh === pxAwayKey && ra === pxHomeKey);
  });
  stages.push(`team_match:${teamMatchRows.length}`);
  if (teamMatchRows.length === 0) {
    const availableEvents = [...new Set(allRows.map(r => `${r.away_team}@${r.home_team}`))];
    stages.push(`available:${availableEvents.slice(0, 8).join('|')}`);
    return { error: 'no_event_match', stages, availableEvents };
  }

  // Multi-event narrowing (uncommon for NBA single-game, but defensive).
  let eventRows = teamMatchRows;
  if (pxStartMs) {
    const eventIds = [...new Set(teamMatchRows.map(r => r.event_id))];
    if (eventIds.length > 1) {
      const eventsByDist = eventIds.map(eid => {
        const sample = teamMatchRows.find(r => r.event_id === eid);
        const eMs = sample.event_start_time ? Date.parse(sample.event_start_time) : 0;
        return { eid, dist: Math.abs(eMs - pxStartMs) };
      }).sort((a, b) => a.dist - b.dist);
      const bestId = eventsByDist[0].eid;
      eventRows = teamMatchRows.filter(r => r.event_id === bestId);
      stages.push(`multi_event_resolve:${eventsByDist.length}->${bestId}`);
    }
  }
  const resolvedEventId = eventRows[0].event_id;

  // Step 2: filter by player_name. NBA names are typically full + clean
  // (e.g. "LeBron James"). Strip diacritics ("Nikola Jokić" → "Nikola
  // Jokic") since SharpAPI may not preserve them. Tolerant substring
  // match in both directions to handle Jr./III suffix differences.
  const stripDiacritics = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normPlayer = stripDiacritics(playerName).toLowerCase().trim();
  const matchedRows = eventRows.filter(r => {
    const stripped = stripDiacritics(r.player_name || '').toLowerCase().trim();
    return stripped === normPlayer ||
           stripped.includes(normPlayer) ||
           normPlayer.includes(stripped);
  });
  stages.push(`player_match:${matchedRows.length}`);
  if (matchedRows.length === 0) {
    return { error: 'no_player_match', stages, resolvedEventId,
             samplePlayers: [...new Set(eventRows.map(r => r.player_name))].slice(0, 5) };
  }

  // Step 3: filter by line value (allow tiny float fuzz)
  const lineRows = line == null ? matchedRows : matchedRows.filter(r => Math.abs((r.line || 0) - line) < 0.01);
  stages.push(`line_match:${lineRows.length}`);
  if (lineRows.length === 0) {
    return { error: 'no_line_match', stages, resolvedEventId,
             sampleLines: [...new Set(matchedRows.map(r => r.line))].slice(0, 8) };
  }

  // Step 4: split by side and per-book de-vig
  const overRows = lineRows.filter(r => /over/i.test(r.selection || r.selection_type || ''));
  const underRows = lineRows.filter(r => /under/i.test(r.selection || r.selection_type || ''));
  const books = [...new Set(lineRows.map(r => r.sportsbook).filter(Boolean))];
  stages.push(`sides:over=${overRows.length},under=${underRows.length}`);

  const fairProbsOver = [];
  const fairProbsUnder = [];
  const viggedProbsOver = [];
  const viggedProbsUnder = [];
  for (const book of books) {
    const o = overRows.find(r => r.sportsbook === book);
    const u = underRows.find(r => r.sportsbook === book);
    if (!o || !u) continue;
    const oProb = americanToImpliedProb(o.odds_american);
    const uProb = americanToImpliedProb(u.odds_american);
    if (oProb == null || uProb == null) continue;
    viggedProbsOver.push(oProb);
    viggedProbsUnder.push(uProb);
    const dv = deVig2Way(oProb, uProb);
    if (Array.isArray(dv) && dv.length === 2 && Number.isFinite(dv[0]) && Number.isFinite(dv[1])) {
      fairProbsOver.push(dv[0]);
      fairProbsUnder.push(dv[1]);
    }
  }
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const { fairProbOver, fairProbUnder } = _applyPropHeavyFavFloor(
    avg(fairProbsOver), avg(fairProbsUnder),
    avg(viggedProbsOver), avg(viggedProbsUnder)
  );

  return {
    matchedRows: lineRows,
    books,
    sides: { over: overRows, under: underRows },
    fairProbOver,
    fairProbUnder,
    booksWithBothSides: fairProbsOver.length,
    resolvedEventId,
    fetchedAt: sportCache.fetchedAt || null,
    stages,
  };
}

// ---------------------------------------------------------------------------
// THE ODDS API FALLBACK for player props (Phase 1 supplemental source)
// ---------------------------------------------------------------------------
// SharpAPI Hobby tier exposes pitcher_strikeouts for only ~4 of ~15 MLB
// games per slate (filter logic unclear — possibly top-N by liquidity).
// The Odds API has full coverage from 4-5 books for the games SharpAPI
// misses, so we fall back to it on no_event_match.
//
// Cost: TOA charges ~1 credit per market×region×event. With aggressive
// caching (5min TTL on events list + per-event odds), a typical day's
// MLB slate uses well under 100 credits — fits comfortably in the free
// 500/mo tier or the $30/mo 20K-credit tier.
// Env-tunable (SGP roadmap Stage 0): the prop staleness gate
// (STALE_PROP_SECONDS, default 420s) and this cadence ship as a package —
// the gate must exceed TTL + line-refresh interval + seed duration or
// healthy RFQs decline. Recommended production pair: TTL 150s / refresh-
// ahead 90s with the 420s gate. Quota: ~2x prop-endpoint credits vs the
// old 5-min TTL — 22M+ remaining as of 2026-06-11, ample headroom.
const TOA_PROP_TTL_MS = (parseInt(process.env.TOA_PROP_TTL_SECONDS) || 300) * 1000;
// Refresh-ahead window: when a cached entry is OLDER than this but
// still YOUNGER than TOA_PROP_TTL_MS, return the cached value
// immediately AND fire a background refresh (fire-and-forget). This
// eliminates the synchronous cache-miss latency (100-150ms HTTP RTT)
// for any prop with traffic > 1 hit per (TTL - REFRESH_AHEAD) window.
// Without this, the prop bridge blocks on a fresh fetch every 5min
// per (sport, event, market), driving phase-2 P95 to ~40ms and P99
// past 100ms — measurable in /latency-breakdown.
const TOA_PROP_REFRESH_AHEAD_MS = (parseInt(process.env.TOA_PROP_REFRESH_AHEAD_SECONDS) || 180) * 1000;
const toaEventsCache = {};   // { sportKey: { fetchedAt, events: [...], refreshing: bool } }
const toaPropOddsCache = {}; // { `${sport}:${eventId}:${marketKey}`: { fetchedAt, refreshing: bool, ...respBody } }
// Single-flight map for the BLOCKING cache-miss fetch path. Coalesces
// concurrent misses for the same event+market onto one in-flight fetch so a
// burst of RFQs for the same game's props (a fisher grid, or a popular game at
// first quote) can't spawn N identical blocking TOA fetches — the storm that
// timed out TOA and starved inline prop resolution in the 2026-07-10 drought.
const _propOddsInflight = {}; // cacheKey -> Promise

// Diagnostics on TOA staleness — incremented every time we serve cached
// data past TTL because refresh failed. Lets operators spot ongoing TOA
// outages via /status without hunting log lines. Reset on service restart.
const toaStaleServeStats = {
  events: 0,            // count of stale events fetches
  propOdds: 0,          // count of stale per-event prop-odds fetches
  lastStaleEventsAt: null,
  lastStalePropOddsAt: null,
  maxStaleAgeMin: 0,    // largest age of stale data we've served since boot
  // 2026-05-12: track fetch timeouts separately from other refresh failures.
  // Was previously lumped into the generic "TOA per-event odds error" log
  // line, making it hard to see when latency tail was driven by TOA stalls
  // vs. legitimate quota/HTTP failures.
  fetchTimeouts: 0,
  lastFetchTimeoutAt: null,
};
function getToaStaleServeStats() { return { ...toaStaleServeStats }; }

// Map our internal sport keys to TOA sport keys. They happen to match
// for MLB but kept explicit for future expansion.
const TOA_SPORT_KEYS = {
  'baseball_mlb': 'baseball_mlb',
  'basketball_nba': 'basketball_nba',
};

// Internal: do the actual TOA events fetch + cache write. Used by both
// the synchronous cache-miss block path and the background refresh-ahead
// path inside _getTheOddsApiEvents.
async function _refreshTheOddsApiEvents(sportKey) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${apiKey}`;
  try {
    const resp = await abortableFetch(url);
    if (!resp.ok) {
      log.warn('OddsFeed', `TOA events fetch failed: ${resp.status}`);
      if (toaEventsCache[sportKey]) toaEventsCache[sportKey].refreshing = false;
      return null;
    }
    const events = await resp.json();
    if (!Array.isArray(events)) {
      if (toaEventsCache[sportKey]) toaEventsCache[sportKey].refreshing = false;
      return null;
    }
    toaEventsCache[sportKey] = { fetchedAt: Date.now(), events, refreshing: false };
    return events;
  } catch (err) {
    if (err.name === 'AbortError') {
      toaStaleServeStats.fetchTimeouts++;
      toaStaleServeStats.lastFetchTimeoutAt = new Date().toISOString();
      log.warn('OddsFeed', `TOA events fetch timeout (${ODDS_API_FETCH_TIMEOUT_MS}ms): ${sportKey}`);
    } else {
      log.warn('OddsFeed', `TOA events error: ${err.message}`);
    }
    if (toaEventsCache[sportKey]) toaEventsCache[sportKey].refreshing = false;
    return null;
  }
}

async function _getTheOddsApiEvents(sport) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return null;
  const sportKey = TOA_SPORT_KEYS[sport] || sport;
  const now = Date.now();
  const cached = toaEventsCache[sportKey];
  // Fresh: return immediately, no refresh
  if (cached && (now - cached.fetchedAt) < TOA_PROP_REFRESH_AHEAD_MS) return cached.events;
  // Stale-but-usable: return cached AND fire background refresh
  if (cached && (now - cached.fetchedAt) < TOA_PROP_TTL_MS) {
    if (!cached.refreshing) {
      cached.refreshing = true;
      _refreshTheOddsApiEvents(sportKey).catch(() => {
        if (toaEventsCache[sportKey]) toaEventsCache[sportKey].refreshing = false;
      });
    }
    return cached.events;
  }
  // Cache miss or fully expired: block on fetch. On failure, fall back to
  // the stale cached entry if we have one — keeps the SP quoting through
  // TOA outages (quota exhaustion / network errors / TOA-side incidents)
  // rather than going dark on every prop and alt-line leg.
  const events = await _refreshTheOddsApiEvents(sportKey);
  if (events != null) return events;
  if (cached) {
    const ageMin = Math.round((now - cached.fetchedAt) / 60000);
    toaStaleServeStats.events++;
    toaStaleServeStats.lastStaleEventsAt = new Date().toISOString();
    if (ageMin > toaStaleServeStats.maxStaleAgeMin) toaStaleServeStats.maxStaleAgeMin = ageMin;
    log.warn('OddsFeed', `TOA events refresh failed for ${sportKey}; serving stale cache (${ageMin}min old, ${cached.events?.length || 0} events)`);
    return cached.events;
  }
  return null;
}

// Internal: TOA per-event prop-odds fetch + cache write. Same dual-use
// pattern as _refreshTheOddsApiEvents.
// Regions for per-event prop odds. Default 'us,us2,eu' (operator opted in
// 2026-07-08) — pulls the us2 books (betrivers/betparx/williamhill) + eu, which
// materially improves the strikeout-distribution fit and all prop de-vigs.
// TRADE-OFF: TOA bills per market × per region, so this is ~3× the prop credit
// cost of 'us' alone. If quota runs tight (prop fairs going null → declines),
// dial back with TOA_PROP_REGIONS=us in Railway.
const _TOA_PROP_REGIONS = process.env.TOA_PROP_REGIONS || 'us,us2,eu';

async function _refreshTheOddsApiPropOdds(sport, eventId, marketKey) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  const sportKey = TOA_SPORT_KEYS[sport] || sport;
  const cacheKey = `${sportKey}:${eventId}:${marketKey}`;
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds`
    + `?apiKey=${apiKey}&regions=${_TOA_PROP_REGIONS}&markets=${marketKey}&oddsFormat=american`;
  try {
    const resp = await abortableFetch(url);
    if (!resp.ok) {
      log.warn('OddsFeed', `TOA per-event odds failed (${eventId}/${marketKey}): ${resp.status}`);
      if (toaPropOddsCache[cacheKey]) toaPropOddsCache[cacheKey].refreshing = false;
      return null;
    }
    const data = await resp.json();
    toaPropOddsCache[cacheKey] = { fetchedAt: Date.now(), refreshing: false, ...data };
    return toaPropOddsCache[cacheKey];
  } catch (err) {
    if (err.name === 'AbortError') {
      toaStaleServeStats.fetchTimeouts++;
      toaStaleServeStats.lastFetchTimeoutAt = new Date().toISOString();
      log.warn('OddsFeed', `TOA per-event odds timeout (${ODDS_API_FETCH_TIMEOUT_MS}ms): ${cacheKey}`);
    } else {
      log.warn('OddsFeed', `TOA per-event odds error: ${err.message}`);
    }
    if (toaPropOddsCache[cacheKey]) toaPropOddsCache[cacheKey].refreshing = false;
    return null;
  }
}

async function _getTheOddsApiPropOdds(sport, eventId, marketKey) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return null;
  const sportKey = TOA_SPORT_KEYS[sport] || sport;
  const cacheKey = `${sportKey}:${eventId}:${marketKey}`;
  const now = Date.now();
  const cached = toaPropOddsCache[cacheKey];
  // Fresh: return immediately, no refresh
  if (cached && (now - cached.fetchedAt) < TOA_PROP_REFRESH_AHEAD_MS) return cached;
  // Stale-but-usable: return cached AND fire background refresh
  if (cached && (now - cached.fetchedAt) < TOA_PROP_TTL_MS) {
    if (!cached.refreshing) {
      cached.refreshing = true;
      _refreshTheOddsApiPropOdds(sport, eventId, marketKey).catch(() => {
        if (toaPropOddsCache[cacheKey]) toaPropOddsCache[cacheKey].refreshing = false;
      });
    }
    return cached;
  }
  // Cache miss or fully expired: block on fetch. On failure, fall back to
  // the stale cached entry rather than returning null. Critical during TOA
  // quota exhaustion or upstream incidents — without this, every prop and
  // alt-line leg silently goes nullProb and the SP quotes nothing.
  // Diagnosed 2026-05-12 after a multi-hour fill drought traced to TOA
  // quota exhaustion: prop fairs went null as TTL expired with refresh
  // failing, priceParlay declined every prop-touching parlay, and confirm-
  // time revalidations also failed (the cannot-reprice cascade).
  //
  // Trade-off: stale prop fairs may misprice during long outages (player
  // injuries, lineup changes, etc. invalidate cached data over hours).
  // Operator should manually /pause if a TOA outage extends past their
  // comfort threshold. Better to quote on stale data than not quote.
  // Single-flight: coalesce concurrent misses for this cacheKey onto ONE
  // fetch (see _propOddsInflight). The whole burst shares the result; on
  // failure they all fall through to the stale-serve below.
  if (!_propOddsInflight[cacheKey]) {
    _propOddsInflight[cacheKey] = _refreshTheOddsApiPropOdds(sport, eventId, marketKey)
      .finally(() => { delete _propOddsInflight[cacheKey]; });
  }
  let refreshed = null;
  try { refreshed = await _propOddsInflight[cacheKey]; } catch (_) { refreshed = null; }
  if (refreshed != null) return refreshed;
  if (cached) {
    const ageMin = Math.round((now - cached.fetchedAt) / 60000);
    toaStaleServeStats.propOdds++;
    toaStaleServeStats.lastStalePropOddsAt = new Date().toISOString();
    if (ageMin > toaStaleServeStats.maxStaleAgeMin) toaStaleServeStats.maxStaleAgeMin = ageMin;
    log.warn('OddsFeed', `TOA prop refresh failed (${cacheKey}); serving stale cache ${ageMin}min old`);
    return cached;
  }
  return null;
}

// ── Player-name normalization + matching (TOA description vs PX name) ──
// Rules (measured against live TOA boards, NFL readiness doc 2026-08-05):
// - Hyphens normalize to SPACES, never to nothing: PX "Jaxon Smith Njigba"
//   must equal TOA "Jaxon Smith-Njigba" ('smithnjigba' would match neither).
// - Jr/Sr are decorative — books disagree on them for the SAME player, so
//   they are dropped: 'Travis Etienne' == 'Travis Etienne Jr.'.
// - Roman-numeral suffixes (II/III/IV/V) are DISTINGUISHING — the NFL has
//   both a Michael Carter and a Michael Carter II. Kept in a separate field
//   compared strictly, so present-vs-absent fails closed to no-match (the
//   base-name substring fallback could never see the difference).
// - D/ST rows ("49ers D/ST") are team units, not players — they match
//   nothing (parts = null).
function _normPlayerNameParts(s) {
  const raw = String(s || '');
  if (/d\s*\/\s*st/i.test(raw)) return null;
  const base = raw.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return null;
  const words = base.split(' ');
  let gen = '';
  // Peel suffixes from the end; "John Smith Jr II" sheds both. Never consume
  // the whole name — a lone "V" stays a name, not a suffix.
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last === 'jr' || last === 'sr') { words.pop(); continue; }
    if (/^(ii|iii|iv|v)$/.test(last)) { gen = last; words.pop(); continue; }
    break;
  }
  return { base: words.join(' '), gen };
}
// Accepts raw strings or pre-computed parts (pass parts for the hot side of
// a loop so the PX name is normalized once).
function _playerNamesMatch(a, b) {
  const pa = (a && typeof a === 'object') ? a : _normPlayerNameParts(a);
  const pb = (b && typeof b === 'object') ? b : _normPlayerNameParts(b);
  if (!pa || !pb) return false;
  if (pa.gen !== pb.gen) return false;
  return pa.base === pb.base || pa.base.includes(pb.base) || pb.base.includes(pa.base);
}

// Generic TOA player-prop lookup. Works for any TOA market key with
// player Over/Under outcomes shaped as {description: playerName, name:
// 'Over'|'Under', point: line, price: american}. Used by the wrappers
// below for pitcher_strikeouts, player_points, player_rebounds,
// player_assists, player_threes, etc.
//
// Returns the standard shape:
//   { fairProbOver, fairProbUnder, books, booksWithBothSides,
//     resolvedEventId, matchedRows, stages }
// or { error, stages, ... } on failure.
async function lookupTheOddsApiPlayerProp(sport, marketKey, pxEventInfo, playerName, line) {
  const stages = [];
  if (!sport || !marketKey || !pxEventInfo || !playerName) {
    return { error: 'missing_input', stages: ['precondition'] };
  }
  if (!process.env.THE_ODDS_API_KEY) {
    return { error: 'toa_key_missing', stages: ['no_api_key'] };
  }

  const events = await _getTheOddsApiEvents(sport);
  if (!events) return { error: 'toa_events_fail', stages: ['events_fetch_failed'] };
  stages.push(`toa_events:${events.length}`);

  const lastWords = (name, n = 2) => {
    const words = normalizeTeamName(name).split(/\s+/).filter(Boolean);
    return words.slice(-n).join(' ');
  };
  const pxHomeKey = lastWords(pxEventInfo.homeTeam || '');
  const pxAwayKey = lastWords(pxEventInfo.awayTeam || '');
  stages.push(`px:${pxEventInfo.awayTeam || '?'}@${pxEventInfo.homeTeam || '?'}`);
  const matchingEvents = events.filter(e => {
    const eh = lastWords(e.home_team || '');
    const ea = lastWords(e.away_team || '');
    return (eh === pxHomeKey && ea === pxAwayKey) ||
           (eh === pxAwayKey && ea === pxHomeKey);
  });
  stages.push(`event_match:${matchingEvents.length}`);
  if (matchingEvents.length === 0) {
    return { error: 'no_event_match', stages,
             availableEvents: events.slice(0, 8).map(e => `${e.away_team}@${e.home_team}`) };
  }

  // Disambiguate doubleheaders/back-to-backs by start-time proximity.
  const pxStartMs = pxEventInfo.startTime ? Date.parse(pxEventInfo.startTime) : null;
  let event = matchingEvents[0];
  if (pxStartMs && matchingEvents.length > 1) {
    matchingEvents.sort((a, b) =>
      Math.abs(Date.parse(a.commence_time) - pxStartMs) -
      Math.abs(Date.parse(b.commence_time) - pxStartMs));
    event = matchingEvents[0];
  }

  const odds = await _getTheOddsApiPropOdds(sport, event.id, marketKey);
  if (!odds) return { error: 'toa_odds_fetch_fail', stages, resolvedEventId: event.id };
  const bookmakers = odds.bookmakers || [];
  stages.push(`books_in_resp:${bookmakers.length}`);

  // Player matching via the module-level _normPlayerNameParts/_playerNamesMatch
  // (hyphen⇒space, Jr/Sr dropped, II/III/IV/V compared strictly, D/ST dropped).
  const normParts = _normPlayerNameParts(playerName);
  const matched = []; // {book, side, point, price}  (exact requested line)
  const allRows = []; // {book, side, point, price}  (ALL of the player's lines — distribution fit)
  for (const bk of bookmakers) {
    const market = (bk.markets || []).find(m => m.key === marketKey);
    if (!market) continue;
    for (const o of (market.outcomes || [])) {
      if (!_playerNamesMatch(normParts, o.description)) continue;
      // Lineless (anytime) markets carry NO point on any outcome. Accepting
      // only pointful rows here made the allRows-empty early-return below fire
      // for every anytime lookup (Yes rows sat in `matched` but never reached
      // allRows) — the 3d45fca regression that silently killed the live
      // soccer.goalscorer/soccer.assists allowlist entries for ~4 weeks.
      // Pointful requests (line != null) keep the strict o.point gate.
      if ((o.point != null || line == null) && Number.isFinite(o.price)) {
        allRows.push({ book: bk.key, side: o.name, point: o.point != null ? o.point : null, price: o.price });
      }
      const lineOk = line == null || Math.abs((o.point || 0) - line) < 0.01;
      if (lineOk) matched.push({ book: bk.key, side: o.name, point: o.point, price: o.price });
    }
  }
  stages.push(`player_line_match:${matched.length},all_rows:${allRows.length}`);

  // Identify the primary line for this player (line with the most book
  // coverage = the consensus anchor) so we can reject deep alts that
  // are exploit-vulnerable. Books only post the primary at ~-110/-110;
  // the deeper the alt the thinner the coverage AND the more sensitive
  // to thin de-vig errors.
  //
  // The cap is propAltLineMaxDistance (default ±2 stat units). Set to
  // a very large value to disable; set to 0 to allow only the primary.
  if (line != null) {
    const cfgConfig = require('../config').config;
    const maxDist = cfgConfig && cfgConfig.pricing && cfgConfig.pricing.propAltLineMaxDistance;
    if (maxDist != null && Number.isFinite(maxDist)) {
      const lineCounts = {};
      for (const bk of bookmakers) {
        const market = (bk.markets || []).find(m => m.key === marketKey);
        if (!market) continue;
        for (const o of (market.outcomes || [])) {
          if (!_playerNamesMatch(normParts, o.description) || o.point == null) continue;
          const k = String(o.point);
          lineCounts[k] = (lineCounts[k] || 0) + 1;
        }
      }
      let primaryLine = null;
      let primaryCount = 0;
      for (const [k, n] of Object.entries(lineCounts)) {
        if (n > primaryCount) { primaryLine = parseFloat(k); primaryCount = n; }
      }
      if (primaryLine != null) {
        const dist = Math.abs(line - primaryLine);
        stages.push(`primary_line:${primaryLine},dist:${dist.toFixed(1)},max:${maxDist}`);
        if (dist > maxDist) {
          return {
            error: 'alt_line_too_far',
            stages, resolvedEventId: event.id,
            requestedLine: line,
            primaryLine,
            distance: dist,
            maxDistance: maxDist,
          };
        }
      }
    }
  }

  // No rows at ALL for this player → genuinely unmatched. (Exact-line-empty is
  // still OK for count props: the distribution fit below prices the requested
  // line from the player's other lines, within the alt-line-distance guard.)
  // matchedRows rides along even on error: for a lineless request the one-
  // sided wrapper can recover from matched Yes rows (see the wrapper's guard)
  // instead of turning a priceable board into a decline.
  if (allRows.length === 0) {
    return { error: 'no_player_or_line_match', stages, resolvedEventId: event.id,
             matchedRows: matched,
             fetchedAt: odds.fetchedAt || null,
             samplePlayers: [...new Set(
               bookmakers.flatMap(bk =>
                 (bk.markets || []).flatMap(m =>
                   (m.outcomes || []).map(o => o.description))).filter(Boolean))].slice(0, 5) };
  }

  // Per-book Over/Under devig
  const overByBook = {};
  const underByBook = {};
  for (const m of matched) {
    if (/over/i.test(m.side)) overByBook[m.book] = m;
    else if (/under/i.test(m.side)) underByBook[m.book] = m;
  }
  const books = [...new Set(matched.map(m => m.book))];
  stages.push(`sides:over=${Object.keys(overByBook).length},under=${Object.keys(underByBook).length}`);

  const fairProbsOver = [];
  const fairProbsUnder = [];
  const viggedProbsOver = [];
  const viggedProbsUnder = [];
  for (const book of books) {
    const o = overByBook[book];
    const u = underByBook[book];
    if (!o || !u) continue;
    const oProb = americanToImpliedProb(o.price);
    const uProb = americanToImpliedProb(u.price);
    if (oProb == null || uProb == null) continue;
    viggedProbsOver.push(oProb);
    viggedProbsUnder.push(uProb);
    const dv = deVig2Way(oProb, uProb);
    if (Array.isArray(dv) && dv.length === 2 && Number.isFinite(dv[0]) && Number.isFinite(dv[1])) {
      fairProbsOver.push(dv[0]);
      fairProbsUnder.push(dv[1]);
    }
  }
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  let { fairProbOver, fairProbUnder } = _applyPropHeavyFavFloor(
    avg(fairProbsOver), avg(fairProbsUnder),
    avg(viggedProbsOver), avg(viggedProbsUnder)
  );
  const exactLineFairOver = fairProbOver;
  let method = 'exact_line_devig';
  let impliedMean = null;
  let distBooks = 0;

  // Count-prop distribution fair: for count markets (hits, total bases, points,
  // rebounds, assists, threes, blocks, steals, PRA, shots on goal, strikeouts),
  // recover the player's mean from EVERY book's line and evaluate at the
  // requested line instead of de-vigging only the exact (often soft-retail)
  // line — the fix for the off-consensus-line underprice that cost ~$4.4K on
  // strikeouts. Exact-line de-vig above is the fallback. Gated by
  // countPropDistFair; heavy-fav floor re-applied to the distribution fair.
  const phi = _countPropDispersion(marketKey);
  if (phi != null && line != null && config.pricing.countPropDistFair !== false) {
    const dist = _countDistFairOver(_buildTwoSidedPropQuotes(allRows), line, phi);
    if (dist && dist.fairOver > 0 && dist.fairOver < 1) {
      const floored = _applyPropHeavyFavFloor(dist.fairOver, 1 - dist.fairOver, avg(viggedProbsOver), avg(viggedProbsUnder));
      fairProbOver = floored.fairProbOver;
      fairProbUnder = floored.fairProbUnder;
      method = 'count_dist';
      impliedMean = dist.muAgg;
      distBooks = dist.muBooks;
      stages.push(`dist:muBooks=${dist.muBooks},mu=${dist.muAgg.toFixed(2)}`);
    }
  }

  return {
    matchedRows: matched,
    books,
    fairProbOver,
    fairProbUnder,
    booksWithBothSides: method === 'count_dist' ? distBooks : fairProbsOver.length,
    method,
    impliedMean,
    exactLineFairOver,
    resolvedEventId: event.id,
    fetchedAt: odds.fetchedAt || null,
    stages,
  };
}

/**
 * TOA one-sided player-prop lookup. Same event/player matching as
 * lookupTheOddsApiPlayerProp, but when books only post the OVER side
 * (typical for HR/RBI binary props where the under is heavy chalk at
 * -1000+ and books don't bother quoting it), this returns a fair_prob
 * estimate based on the multi-book over-side average MINUS an assumed
 * per-side overround haircut.
 *
 * Use case: MLB hitter_hr + hitter_rbi_runs at line=0.5. TOA's
 * `batter_home_runs` and `batter_rbis` markets are 100% one-sided
 * (verified 2026-05-22) — the 2-sided pipeline drops them. This
 * fallback uses the over-side data multi-book (BetOnline + William
 * Hill, plus Pinnacle when present) to estimate fair instead of
 * scraping DK.
 *
 * Returns same shape as the 2-sided function:
 *   { fairProbOver, fairProbUnder, books, booksWithBothSides: 0,
 *     oneSidedSource: 'toa-one-sided', resolvedEventId, stages }
 * Or { error, stages, ... } on failure.
 */
async function lookupTheOddsApiPlayerPropOneSided(sport, marketKey, pxEventInfo, playerName, line) {
  // Reuse the standard lookup to get the matched rows + per-book over
  // prices, then bypass the de-vig step and apply an assumed-overround
  // haircut instead.
  const std = await lookupTheOddsApiPlayerProp(sport, marketKey, pxEventInfo, playerName, line);
  // If standard lookup already produced a fair (paired data available),
  // we still prefer that — return the result unchanged. Callers should
  // try one-sided only when standard returned null fair.
  if (std && std.fairProbOver != null && std.fairProbUnder != null) {
    return std;
  }
  // If the standard lookup hard-errored (no event match, alt line too
  // far, etc.) propagate the error — one-sided can't recover those.
  // ONE exception, deliberately narrow (fail-closed everywhere else): a
  // lineless (anytime) request that matched player rows but produced no
  // pointful allRows is NOT a hard failure — those Yes rows are exactly
  // what this wrapper prices. Belt-and-braces with the allRows fix in the
  // standard lookup so a revert of either alone can't resurrect 3d45fca.
  if (std && std.error) {
    const recoverable = line == null
      && std.error === 'no_player_or_line_match'
      && Array.isArray(std.matchedRows) && std.matchedRows.length > 0;
    if (!recoverable) return std;
  }
  if (!std || !Array.isArray(std.matchedRows) || std.matchedRows.length === 0) {
    return { error: 'no_one_sided_data', stages: (std && std.stages) || [] };
  }
  // Collect over-side implied probs per book. Anytime markets (soccer
  // player_goal_scorer_anytime / player_assists variants) post the backed
  // side as "Yes" instead of "Over" — same semantics, accept both.
  const overByBook = {};
  for (const m of std.matchedRows) {
    if (/over|yes/i.test(m.side) && overByBook[m.book] == null) {
      const p = americanToImpliedProb(m.price);
      if (p != null && p > 0 && p < 1) overByBook[m.book] = p;
    }
  }
  const overImps = Object.values(overByBook);
  if (overImps.length === 0) {
    return { error: 'no_one_sided_over_data', stages: std.stages || [] };
  }
  const cfg = require('../config').config;
  const assumedVig = (cfg && cfg.pricing && cfg.pricing.toaOneSidedPropOverround) || 0.08;
  // Average implied across books, then divide by (1 + assumedVig) to
  // back out the assumed overround. Conservative estimate: under-shoot
  // vig (smaller haircut) → smaller fair → tighter offer.
  const avgImp = overImps.reduce((a, b) => a + b, 0) / overImps.length;
  const fairProbOver = Math.max(0.005, Math.min(0.95, avgImp / (1 + assumedVig)));
  const fairProbUnder = 1 - fairProbOver;
  const books = Object.keys(overByBook);
  return {
    matchedRows: std.matchedRows,
    books,
    fairProbOver,
    fairProbUnder,
    booksWithBothSides: 0,
    oneSidedSource: 'toa-one-sided',
    oneSidedBookCount: books.length,
    oneSidedRawAvgImplied: avgImp,
    oneSidedAssumedVig: assumedVig,
    resolvedEventId: std.resolvedEventId,
    fetchedAt: std.fetchedAt || null,
    stages: (std.stages || []).concat(['one_sided_over_only:' + overImps.length + 'books']),
  };
}

// ── Count-prop distribution (negative-binomial; Poisson at phi=1) ──
// Prices a count-prop OVER at ANY line from books posting DIFFERENT lines:
// recover each book's implied mean from its own posted line, aggregate
// (sharp-weighted), then evaluate the over at the requested line. Fixes the
// off-consensus-line underprice (books posting the sharp line a half-unit away
// used to be discarded, leaving only soft retail books → ~6-8pp pickoff — the
// leak that cost the operator ~$4.4K on strikeouts). Applies to strikeouts,
// hits, total bases, points, rebounds, assists, threes, blocks, steals, PRA,
// shots on goal. phi = variance/mean overdispersion (>=1). Lanczos logGamma.
function _countLogGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - _countLogGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function _countPmf(k, mu, phi) {
  if (mu <= 0) return k === 0 ? 1 : 0;
  if (phi <= 1.0001) return Math.exp(k * Math.log(mu) - mu - _countLogGamma(k + 1)); // Poisson
  const p = 1 / phi, r = mu / (phi - 1); // NB: mean mu, variance mu*phi
  return Math.exp(_countLogGamma(k + r) - _countLogGamma(r) - _countLogGamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
}
function _pCountAtLeast(n, mu, phi) {
  if (n <= 0) return 1;
  let cdf = 0;
  for (let k = 0; k < n; k++) cdf += _countPmf(k, mu, phi);
  return Math.max(1e-6, Math.min(1 - 1e-6, 1 - cdf));
}
// Invert: mean mu such that P(count >= n | mu, phi) == pOver. Monotonic in mu.
function _recoverCountMu(n, pOver, phi) {
  if (!(pOver > 0 && pOver < 1) || !(n >= 1)) return null;
  let lo = 0.02, hi = 60;
  if (_pCountAtLeast(n, lo, phi) > pOver) return lo;
  if (_pCountAtLeast(n, hi, phi) < pOver) return hi;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (_pCountAtLeast(n, mid, phi) < pOver) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// Sharp-book weights for aggregating the recovered mean across books.
const _PROP_SHARP_WEIGHTS = { pinnacle: 3, draftkings: 2, fanduel: 2, betmgm: 1.5, williamhill_us: 1.5, betonlineag: 1.5, caesars: 1.5, betrivers: 1.25 };
// Per-TOA-market overdispersion (variance/mean). A market present here is a
// COUNT prop eligible for the distribution fit; absent markets keep exact-line
// de-vig. pitcher_strikeouts pulls from config so STRIKEOUT_DISPERSION still
// tunes it. Higher phi = higher-variance count (points/TB/PRA) → fatter tails.
function _countPropDispersion(marketKey) {
  const kDisp = (config.pricing && config.pricing.strikeoutDispersion) || 1.15;
  // PURE COUNTS ONLY. A negative-binomial models a count of events; it does
  // NOT model a WEIGHTED sum. total_bases (single=1..HR=4) is a weighted sum —
  // the NB fit diverged up to ~7pp from the exact-line de-vig and cross-checked
  // WORSE (verified 2026-07-08), so total_bases stays on exact-line de-vig.
  // hits+runs+RBIs and PRA are sums of unit counts → still count-like, kept.
  const M = {
    pitcher_strikeouts: kDisp,
    // batter_hits_runs_rbis and batter_total_bases intentionally absent —
    // correlated/weighted compound stats, poor NB fit → exact-line de-vig.
    batter_hits: 1.05,
    batter_stolen_bases: 1.05, batter_runs_scored: 1.05, batter_rbis: 1.15,
    player_points: 1.25, player_rebounds: 1.15, player_assists: 1.2,
    player_threes: 1.1, player_blocks: 1.05, player_steals: 1.05,
    player_points_rebounds_assists: 1.3, player_shots_on_goal: 1.2, player_goals: 1.05,
  };
  return M[marketKey] != null ? M[marketKey] : null;
}
// Build per-(book, line) two-sided quotes and de-vig each → [{book, point, pOver}].
function _buildTwoSidedPropQuotes(rows) {
  const byKey = {};
  for (const r of rows) {
    if (r.point == null || !Number.isFinite(r.price)) continue;
    const k = `${r.book}|${r.point}`;
    const slot = byKey[k] || (byKey[k] = { book: r.book, point: r.point });
    if (/over/i.test(r.side)) slot.over = r.price;
    else if (/under/i.test(r.side)) slot.under = r.price;
  }
  const quotes = [];
  for (const q of Object.values(byKey)) {
    if (q.over == null || q.under == null) continue;
    const oProb = americanToImpliedProb(q.over), uProb = americanToImpliedProb(q.under);
    if (oProb == null || uProb == null) continue;
    const dv = deVig2Way(oProb, uProb);
    if (Array.isArray(dv) && Number.isFinite(dv[0])) quotes.push({ book: q.book, point: q.point, pOver: dv[0] });
  }
  return quotes;
}
// Distribution fair for the OVER at requestedLine from two-sided quotes across
// all lines (half-integer only). Returns {fairOver, muAgg, muBooks} or null.
function _countDistFairOver(quotes, requestedLine, phi) {
  let muW = 0, wSum = 0, muBooks = 0;
  for (const q of quotes) {
    if (Math.abs(Math.abs(q.point % 1) - 0.5) > 0.01) continue; // X.5 lines only
    const mu = _recoverCountMu(Math.round(q.point + 0.5), q.pOver, phi);
    if (mu == null) continue;
    const w = _PROP_SHARP_WEIGHTS[String(q.book).toLowerCase()] || 1;
    muW += w * mu; wSum += w; muBooks++;
  }
  if (wSum === 0) return null;
  const muAgg = muW / wSum;
  const fairOver = requestedLine != null ? _pCountAtLeast(Math.round(requestedLine + 0.5), muAgg, phi) : null;
  return { fairOver, muAgg, muBooks };
}

// TOA equivalent of lookupPlayerStrikeoutProp. Returns the same shape
// so the websocket caller can swap them transparently. Async because
// TOA requires HTTP calls (cached, but not pre-warmed).
async function lookupPlayerStrikeoutPropFromTheOddsApi(sport, pxEventInfo, playerName, line) {
  const stages = [];
  if (!sport || !pxEventInfo || !playerName) {
    return { error: 'missing_input', stages: ['precondition'] };
  }
  if (!process.env.THE_ODDS_API_KEY) {
    return { error: 'toa_key_missing', stages: ['no_api_key'] };
  }

  const events = await _getTheOddsApiEvents(sport);
  if (!events) return { error: 'toa_events_fail', stages: ['events_fetch_failed'] };
  stages.push(`toa_events:${events.length}`);

  // Match event by team last-words (same approach as SharpAPI helper).
  const lastWords = (name, n = 2) => {
    const words = normalizeTeamName(name).split(/\s+/).filter(Boolean);
    return words.slice(-n).join(' ');
  };
  const pxHomeKey = lastWords(pxEventInfo.homeTeam || '');
  const pxAwayKey = lastWords(pxEventInfo.awayTeam || '');
  stages.push(`px:${pxEventInfo.awayTeam || '?'}@${pxEventInfo.homeTeam || '?'}`);
  const matchingEvents = events.filter(e => {
    const eh = lastWords(e.home_team || '');
    const ea = lastWords(e.away_team || '');
    return (eh === pxHomeKey && ea === pxAwayKey) ||
           (eh === pxAwayKey && ea === pxHomeKey);
  });
  stages.push(`event_match:${matchingEvents.length}`);
  if (matchingEvents.length === 0) {
    return { error: 'no_event_match', stages,
             availableEvents: events.slice(0, 8).map(e => `${e.away_team}@${e.home_team}`) };
  }

  // Disambiguate doubleheaders by start-time proximity.
  const pxStartMs = pxEventInfo.startTime ? Date.parse(pxEventInfo.startTime) : null;
  let event = matchingEvents[0];
  if (pxStartMs && matchingEvents.length > 1) {
    matchingEvents.sort((a, b) =>
      Math.abs(Date.parse(a.commence_time) - pxStartMs) -
      Math.abs(Date.parse(b.commence_time) - pxStartMs));
    event = matchingEvents[0];
  }

  const odds = await _getTheOddsApiPropOdds(sport, event.id, 'pitcher_strikeouts');
  if (!odds) return { error: 'toa_odds_fetch_fail', stages, resolvedEventId: event.id };
  const bookmakers = odds.bookmakers || [];
  stages.push(`books_in_resp:${bookmakers.length}`);

  // Filter outcomes by player name (description field). Collect ALL of the
  // player's posted lines/prices (NOT just PX's exact line) — the distribution
  // fit below uses every book's own line, so a sharp book at 7.5 informs the
  // fair at PX's 6.5. TOA's "description" is clean (no Thrown/Recorded suffix).
  const stripDiacritics = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normPlayer = stripDiacritics(playerName).toLowerCase().trim();
  const allRows = []; // {book, side, point, price}
  for (const bk of bookmakers) {
    const market = (bk.markets || []).find(m => m.key === 'pitcher_strikeouts');
    if (!market) continue;
    for (const o of (market.outcomes || [])) {
      const outcomePlayer = stripDiacritics(o.description || '').toLowerCase().trim();
      const playerOk = outcomePlayer === normPlayer ||
                       outcomePlayer.includes(normPlayer) ||
                       normPlayer.includes(outcomePlayer);
      if (playerOk && o.point != null && Number.isFinite(o.price)) {
        allRows.push({ book: bk.key, side: o.name, point: o.point, price: o.price });
      }
    }
  }
  stages.push(`player_rows:${allRows.length}`);
  if (allRows.length === 0) {
    return { error: 'no_player_or_line_match', stages, resolvedEventId: event.id,
             samplePlayers: [...new Set(
               bookmakers.flatMap(bk =>
                 (bk.markets || []).flatMap(m =>
                   (m.outcomes || []).map(o => o.description))).filter(Boolean))].slice(0, 5) };
  }

  // Group into per-(book, line) two-sided quotes and de-vig each independently.
  const byBookLine = {}; // `${book}|${point}` -> { book, point, over, under }
  for (const r of allRows) {
    const k = `${r.book}|${r.point}`;
    const slot = byBookLine[k] || (byBookLine[k] = { book: r.book, point: r.point });
    if (/over/i.test(r.side)) slot.over = r.price;
    else if (/under/i.test(r.side)) slot.under = r.price;
  }
  const quotes = []; // { book, point, pOver }  (one per two-sided book/line)
  for (const q of Object.values(byBookLine)) {
    if (q.over == null || q.under == null) continue;
    const oProb = americanToImpliedProb(q.over);
    const uProb = americanToImpliedProb(q.under);
    if (oProb == null || uProb == null) continue;
    const dv = deVig2Way(oProb, uProb);
    if (Array.isArray(dv) && Number.isFinite(dv[0])) quotes.push({ book: q.book, point: q.point, pOver: dv[0] });
  }
  const books = [...new Set(quotes.map(q => q.book))];
  stages.push(`two_sided_quotes:${quotes.length}`);

  // Exact-line de-vig at PX's requested line — cross-check + fallback.
  const exactAt = line != null ? quotes.filter(q => Math.abs(q.point - line) < 0.01) : quotes;
  const exactFairOver = exactAt.length ? exactAt.reduce((s, q) => s + q.pOver, 0) / exactAt.length : null;

  // Distribution fit (shared count-prop helper): recover each quote's mean Ks
  // from its OWN line, aggregate sharp-weighted, evaluate at PX's line.
  const phi = _countPropDispersion('pitcher_strikeouts');
  const dist = _countDistFairOver(quotes, line, phi);
  const muAgg = dist ? dist.muAgg : null;
  const muBooks = dist ? dist.muBooks : 0;
  const distFairOver = dist ? dist.fairOver : null;
  stages.push(`dist:muBooks=${muBooks},mu=${muAgg != null ? muAgg.toFixed(2) : '-'}`);

  // Use the distribution fair when enabled and valid; else fall back to the
  // exact-line de-vig (which itself falls back to null → caller declines).
  const useDist = (config.pricing && config.pricing.countPropDistFair !== false)
    && distFairOver != null && distFairOver > 0 && distFairOver < 1;
  const fairProbOver = useDist ? distFairOver : exactFairOver;
  const fairProbUnder = fairProbOver != null ? 1 - fairProbOver : null;

  return {
    matchedRows: allRows,
    books,
    fairProbOver,
    fairProbUnder,
    // booksWithBothSides drives the caller's minBooks gate. Under the dist
    // method, all books contributing a mean-K estimate count (even if posted
    // at a nearby line); under fallback, only books at the exact line.
    booksWithBothSides: useDist ? muBooks : exactAt.length,
    method: useDist ? 'count_dist' : 'exact_line_devig',
    impliedMeanKs: muAgg,
    impliedMean: muAgg,
    exactLineFairOver: exactFairOver,
    exactLineBooks: exactAt.length,
    resolvedEventId: event.id,
    fetchedAt: odds.fetchedAt || null, // for downstream stale checks
    stages,
  };
}

// Debug: dump the prop cache for inspection
function getPropRowsCacheStatus() {
  const out = {};
  for (const [sport, mtMap] of Object.entries(propRowsCache)) {
    out[sport] = {};
    for (const [mt, arr] of Object.entries(mtMap)) {
      if (mt === 'fetchedAt') { out[sport].fetchedAt = arr; continue; }
      out[sport][mt] = {
        rowCount: arr.length,
        eventCount: new Set(arr.map(r => r.event_id)).size,
        bookCount: new Set(arr.map(r => r.sportsbook)).size,
        books: [...new Set(arr.map(r => r.sportsbook))],
      };
    }
  }
  return out;
}

module.exports = {
  fetchOddsForSport,
  refreshAllSports,
  getFairProb,
  getFairProbAsync,
  getAltLineFairProbSync,
  getAltSyncStats,
  verifyLineWithPinnacle,
  getPinnacleOdds,
  getDisplayFairProb,
  getFanDuelOdds,
  getKalshiOdds,
  getDraftKingsOdds,
  getDNBFairProb,
  fetchAltLines,
  // Exported for services/nfl-consensus.js, which resolves a TOA event id
  // before its per-event board fetch. Omitted on the football build, so
  // EVERY football consensus pre-seed threw "not a function" (fixed 2026-08-22).
  resolveOddsApiEventId,
  backfillMissingH2h,
  mergeDkMmaFights,
  mergeDkTennisMatches,
  mergeDkLiveOdds,
  mergeOddsApiLive,
  warmAltLines,
  warmAllSports,
  warmEventAltLinesJIT,
  startAltLineWarmLoop,
  startBovadaAltLoop,
  startPinVerifyWarmLoop,
  getAltLinesWarmStats,
  getJitWarmStats,
  getSupplementRetryStats,
  getPinVerifyWarmStats,
  getPinVerifyFastFailStats,
  getEventMarkets,
  _withinMatchWindow,
  getGolfMatchupEvent,
  getLiveEventMarkets,
  getLiveFairProb,
  getLiveCacheStatus,
  getCacheAge,
  isStale,
  isStaleForEvent,
  getStaleThreshold,
  isEventStalePreGame,
  getCacheStatus,
  getToaStaleServeStats,
  getAllCachedEvents,
  getCachedSportKeysWithPrefix,
  __debugGetCache,
  __debugSetCache,
  captureClosingLines,
  getClosingLineSnapshot,
  getClosingLinesStatus,
  getSharpEvents,
  refreshAllSportsDelta,
  normalizeTeamName,
  deVig2Way,
  deVig3WayPower,
  americanToImpliedProb,
  getRfiFair,
  ensureTeamTotals,
  ensureBtts,
  // Internal consensus builders exposed for unit testing / debug (pure fns).
  buildConsensusTotals,
  buildConsensusSpread,
  fetchScores,
  getGameResult,
  // Test seam for the score-orientation logic (see game-result-orientation.test.js).
  _matchScoreGame,
  // Tennis backstop — exported so it can be verified end-to-end and triggered
  // manually when the slate changes mid-cycle.
  mergeBovadaTennisMatches,
  mergePinnacleTennisMatches,
  mergeToaTennisSets,
  checkLineupFreshness,
  getLineupCache,
  getPitcherSide,
  // Test hooks for the lineup cache. updateLineupState is driven by the odds
  // refresh in prod; tests need to drive it directly to prove that the two
  // games of a series no longer collide onto one key.
  __updateLineupState: updateLineupState,
  __resetLineupCache: (sport) => { if (sport) delete lineupCache[sport]; else for (const k of Object.keys(lineupCache)) delete lineupCache[k]; },
  __debugGetAltLinesCache: () => altLinesCache,
  normalizeEventKey,
  getAltLineCacheEntry,
  getTennisTotalsFallback,
  // Phase 1 player-prop shadow pricing
  lookupPlayerStrikeoutProp,
  lookupPlayerStrikeoutPropFromTheOddsApi,
  lookupTheOddsApiPlayerProp,
  lookupTheOddsApiPlayerPropOneSided,
  lookupPlayerPointsProp,
  getPropRowsCacheStatus,
  // Football build test seams (test/football-odds-feed.test.js): fixture
  // tests drive the REAL functions; these expose the config surfaces they
  // assert against. Not for production callers.
  supplementH1Markets,
  _normPlayerNameParts,
  _playerNamesMatch,
  __H1_SUPPLEMENT_SPORTS: H1_SUPPLEMENT_SPORTS,
  __ODDS_API_FALLBACK: ODDS_API_FALLBACK,
  _bttsBooksFor,
};

