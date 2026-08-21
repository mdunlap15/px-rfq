const { config } = require('../config');

// Memoized websocket module reference. The Phase-2 prop bridge inside
// resolveUnknownLine pulls classifiers + name extractor from websocket
// via require('./websocket'). The require call has lookup overhead on
// every RFQ — caching it here saves ~30-80μs per prop-leg RFQ.
// Initialized lazily on first call to avoid the line-manager ↔
// websocket circular import at module-load time.
let _wsModule = null;
function _getWsModule() {
  if (_wsModule === null) {
    try { _wsModule = require('./websocket'); }
    catch (e) { _wsModule = false; } // sentinel for "tried, failed"
  }
  return _wsModule || null;
}

// Module-level prop-type → TOA market key maps for the bridge. Lifted
// out of the inner closure (was re-created on every prop RFQ) to avoid
// the per-call object construction.
const _NBA_PROP_TO_TOA_MARKET = {
  points: 'player_points',
  rebounds: 'player_rebounds',
  assists: 'player_assists',
  threes_made: 'player_threes',
  // Added 2026-05-17 after silent-decline audit showed ~25% of basketball
  // player_prop unknowns were blocks/steals/PRA combos with no TOA mapping
  // (classifier returned the propType but lookup short-circuited at
  // `toaMarketKey = undefined`).
  //
  // pra_combo maps to the 3-stat TOA market. The classifyNbaProp pra_combo
  // bucket also includes 2-stat combos (PR / PA / RA), which will silently
  // fail the TOA lookup (no_line_match — PRA line ≠ 2-stat line) and decline
  // cleanly via insufficient_books. Acceptable for now; a sub-classifier for
  // 2-stat combos can come later if the volume justifies it.
  blocks: 'player_blocks',
  steals: 'player_steals',
  pra_combo: 'player_points_rebounds_assists',
};
const _NHL_PROP_TO_TOA_MARKET = {
  shots_on_goal: 'player_shots_on_goal',
  // Phase-2 NHL props — bridge wired but each requires explicit entry in
  // PROP_LAUNCH_ALLOWLIST (e.g. "icehockey_nhl.points") to actually quote.
  // Saves intentionally omitted: TOA NHL save coverage is uneven and
  // high per-stat variance (one save flips a 28.5 line) makes it a poor
  // first prop to enable.
  points:   'player_points',
  goals:    'player_goals',
  assists:  'player_assists',
};
// MLB hitter props. classifyMlbProp's bucket names map to TOA's
// batter_* market keys. Operator chose to enable the high-volume hitter
// markets (44% hits, 36% HR per 24h prop-flow sample) — pitcher_other
// stays unmapped (varies too much: outs recorded vs IP vs walks).
// pitcher_strikeouts has its own bridge (lookupPlayerStrikeoutProp +
// lookupPlayerStrikeoutPropFromTheOddsApi), not routed here.
const _MLB_PROP_TO_TOA_MARKET = {
  pitcher_strikeouts: 'pitcher_strikeouts',
  hitter_hits: 'batter_hits',
  hitter_hr: 'batter_home_runs',
  hitter_total_bases: 'batter_total_bases',
  hitter_rbi_runs: 'batter_rbis',
  hitter_stolen_bases: 'batter_stolen_bases',
  hitter_hits_runs_rbis: 'batter_hits_runs_rbis',
};
// Map a propType to the internal lineIndex marketType. Almost everything uses
// the 'player_<propType>' convention, but K-props MUST register as
// 'player_strikeouts' (NOT 'player_pitcher_strikeouts'): the K-prop carve-outs
// (pricer.js kprop_kprop/kprop_ml + same-game exemption ~L3182, classifySgpCombo
// ~L3489), the per-pitcher exposure tracking (order-tracker player_strikeouts),
// and the dedicated K bridge (~L1139) ALL key on 'player_strikeouts'. The generic
// prop pre-seed grew a K-prop path (TOA map entry, commit 80a382e) that emitted
// 'player_pitcher_strikeouts', silently breaking every K carve-out so opposing-
// starter K-K parlays declined as prop_correlation_same_game instead of quoting
// (regression caught 2026-06-25). Normalize at the source so all paths agree.
function _propMarketType(propType) {
  if (propType === 'pitcher_strikeouts') return 'player_strikeouts';
  return 'player_' + propType;
}
// World Cup / international soccer player props. PX posts these as
// one-sided YES/NO markets ("<Player> To Score a Goal", "<Player> To Have
// At Least 1/2 Shot(s) On Target", "<Player> To Give Assist"). TOA carries
// them under the dedicated tournament key (FD/DK/BetRivers coverage
// verified live 2026-06-11) even though our soccer EVENTS match under the
// generic SharpAPI 'soccer' key — so prop lookups pass _SOCCER_PROP_TOA_SPORT
// explicitly. The classifier also derives the TOA line: anytime markets are
// Over 0.5; "At Least N SoT" = Over N-0.5.
const _SOCCER_PROP_TO_TOA_MARKET = {
  goalscorer: 'player_goal_scorer_anytime',
  sot_1: 'player_shots_on_target',
  sot_2: 'player_shots_on_target',
  assists: 'player_assists',
};
// Football (NFL/preseason/NCAAF) player props. PX posts anytime-TD as a
// lineless YES/NO market ("<Player> To Score a Touchdown", type
// 'sup_moneyline') — same shape as the soccer goalscorer/assists props.
// TOA's player_anytime_td outcomes carry NO point and use side name "Yes",
// so registration is line 0.5 (anytime semantics) with a NULL TOA query
// line, mirroring _classifySoccerProp's anytime handling. anytime_td is the
// ONLY mapped market: TOA's measured football prop coverage is
// player_anytime_td on 2 books for regular-season NFL and ZERO player_*
// keys for preseason/NCAAF, so everything else classifies for decline
// visibility but never maps → never registers. Launch remains fully gated
// by PROP_LAUNCH_ALLOWLIST (no americanfootball entries yet = dark).
const _FOOTBALL_PROP_TO_TOA_MARKET = {
  anytime_td: 'player_anytime_td',
};
// Line semantics for lineless football YES/NO props (parallel to the
// {line, toaLine} object _classifySoccerProp returns). Null for any
// propType we don't price — callers must fail closed on null.
function _footballPropCtx(propType) {
  if (propType === 'anytime_td') return { propType, line: 0.5, toaLine: null };
  return null;
}
// Registration-safety assertion for football player props (the BTTS/MoV/
// tennis-sets marketType trap, fourth occurrence — see prophetx.js
// isFootballPropMarketTypeSafe). PX types football props 'sup_moneyline';
// a football prop that registered carrying a full-game marketType
// {moneyline, spread, total, team_total} would turn prop+total into an
// ALLOWED ml_total priced off the team line. Every football prop
// registration path must pass this and REFUSE the line when false.
// Absence-safe: if the prophetx helper hasn't landed (parallel
// integration), football props fail CLOSED — nothing registers unvalidated.
function _footballPropRegistrationSafe(marketType) {
  if (typeof px.isFootballPropMarketTypeSafe !== 'function') return false;
  return px.isFootballPropMarketTypeSafe(marketType);
}
const _SOCCER_PROP_TOA_SPORT = 'soccer_fifa_world_cup';
// Map a PX soccer sport key to the source sport key for player-prop lookups.
// The generic 'soccer' key (SharpAPI-era events; today = World Cup) resolves to
// the dedicated tournament key; league-specific keys (soccer_usa_mls,
// soccer_epl, …) pass through unchanged so their props source under their own
// key when a source has coverage. Generalizes the former hardcoded WC-only
// assumption. NOTE: TOA carries almost no MLS props (single-soft-book
// goalscorer only), so MLS is sourced from the DK scraper (see
// scripts/dk-soccer-props.js / the soccer-prop scraper source) rather than TOA;
// this mapping governs the TOA-sourced leagues.
function _soccerPropToaSport(sportKey) {
  if (!sportKey || sportKey === 'soccer') return _SOCCER_PROP_TOA_SPORT;
  return sportKey;
}
// `line` is what we register on the lineInfo (0.5 = anytime semantics);
// `toaLine` is what the TOA outcome filter needs: anytime markets
// (goal_scorer_anytime, assists) carry NO point on their outcomes, so the
// query must pass null or the point check matches nothing. SoT outcomes
// genuinely carry points (0.5 / 1.5 / 2.5).
function _classifySoccerProp(marketName) {
  const n = String(marketName || '');
  if (/\bto score a goal$/i.test(n)) return { propType: 'goalscorer', line: 0.5, toaLine: null };
  const m = /\bto have at least (\d+) shots? on target$/i.exec(n);
  if (m) {
    const k = Number(m[1]);
    return (k === 1 || k === 2) ? { propType: 'sot_' + k, line: k - 0.5, toaLine: k - 0.5 } : null;
  }
  if (/\bto give (?:an? )?assist$/i.test(n)) return { propType: 'assists', line: 0.5, toaLine: null };
  // Deliberately unmatched: "To Score Or Give Assist" (no book source),
  // "To Have At Least N Shot(s)" without "On Target" (total shots — books
  // don't post it).
  return null;
}
const log = require('./logger');
const px = require('./prophetx');
const oddsFeed = require('./odds-feed');
const nflConsensus = require('./nfl-consensus');
const dataGolf = require('./datagolf');
const golfTopN = require('./golf-topn');
const ufcMov = require('./ufc-mov');
const db = require('./db');
// Lazy require for orderTracker to avoid circular dependency
let orderTracker = null;
function getOrderTracker() {
  if (!orderTracker) orderTracker = require('./order-tracker');
  return orderTracker;
}

// ---------------------------------------------------------------------------
// LINE INDEX — maps PX line_id → metadata + Odds API match
// ---------------------------------------------------------------------------
// { [lineId]: { sport, pxEventId, pxEventName, marketType, selection,
//               teamName, line, homeTeam, awayTeam,
//               oddsApiSport, oddsApiMarket, oddsApiSelection } }
const lineIndex = {};

// Cold-start gate for Supabase hydration. Flipped true after the first
// seedAllLines completes. Hydration only runs on cold boot (when
// lineIndex hasn't been authoritatively seeded yet); periodic
// refreshLines cycles skip it so the per-sport stale-event cutoff in
// seed stays authoritative and finished games don't bleed back in
// from line_cache.
let _hasSeededOnce = false;

// PX RULE 1 (Anthony 2026-06-25): the PX "supported lines" set must mirror ONLY
// the lines we can actually quote, and stay in sync. We track the set we last
// told PX about so each seed cycle can DIFF (add new, remove dropped) instead of
// the old append-only POST that let settled/started/dropped lines linger as
// "supported" forever and then decline at RFQ time. Seeded from PX's live set on
// first boot so historical accumulation gets pruned by the first diff.
let _lastRegisteredLineIds = new Set();
// One-time-per-boot guard for the historical supported-lines reconcile. Must be
// its OWN flag, not a `_lastRegisteredLineIds.size === 0` check: on-demand
// resolveUnknownLine registrations can fire (and add to the set) BEFORE the
// first seed runs, which would defeat a size-based gate and skip the reconcile.
let _supportedReconcileDone = false;

// Build-then-swap support for refreshLines (warm refresh).
// During a periodic refresh, seedAllLines writes into _seedIndexTarget /
// _seedPrimaryTarget instead of the live lineIndex / primaryByEvent. Live
// lineIndex keeps serving RFQ lookups — and cache write-throughs from
// resolveUnknownLine / lookupLineAsync — for the entire seed window. At
// the end of seed, contents swap atomically (single synchronous block,
// no awaits) so no RFQ handler can observe an empty or partial state.
//
// On COLD START both targets are null and seed writes go directly to live —
// preserves the existing behaviour where line_cache hydration pre-fills
// lineIndex synchronously before any RFQ can race against it.
//
// Safety: the data stored in lineIndex is routing metadata (sport, market,
// selection, team, line value, startTime). Actual pricing odds live in
// oddsCache (services/odds-feed.js) and are subject to their own staleness
// check (STALE_PRICE_MINUTES). Serving RFQs against the previous-refresh
// lineIndex cannot produce stale prices: line_ids are immutable per market,
// and pricer.shouldDecline catches event-started lines via startTime.
let _seedIndexTarget = null;
let _seedPrimaryTarget = null;

// Seed-side line writer. Routes to staging during warm refresh, to live
// otherwise. Returns the stored info so callers can chain
// _trackPrimaryForIndex without re-reading.
function _setSeedLine(lineId, info) {
  // Stamp the id ON the object (2026-08-13). legExposureKey(lineInfo) reads
  // li.lineId to build its 'L:<id>|<day>' key; registered infos never carried
  // the field, so every QUOTE-TIME per-line exposure check fell to the
  // 'S:team|market|line' fallback while the OPEN-risk map (built from meta
  // legs, which DO carry lineId) used 'L:' keys. The keys never matched →
  // open risk was invisible at quote time → the per-line cap fired ZERO
  // times in production and an $8.7K same-line stack (Shelton/Swiatek
  // doubles, 2026-08-12) sailed through a $1,500 cap.
  info.lineId = lineId;
  (_seedIndexTarget || lineIndex)[lineId] = info;
  return info;
}

// O(1) reverse index for getPrimarySpreadHomePoint / getPrimaryTotalLine.
// Without this, those helpers do Object.values(lineIndex) which is O(N=~1200)
// per call. Called per leg in shouldDecline → significant hot-path cost on
// NBA-heavy parlays (Apr 26 latency regression: p50 1.0ms → 1.9ms after
// the NBA alt-spread carve-out shipped). Indexed by pxEventId, stores the
// SHORTEST lineId we saw for each (event, market) primary so lookups are
// constant-time.
//   { [pxEventId]: { spread: lineInfo|null, total: lineInfo|null } }
// Maintained alongside lineIndex via _trackPrimaryForIndex() — every
// insertion into lineIndex flows through this hook.
const primaryByEvent = {};

function _trackPrimaryForIndex(lineInfo) {
  if (!lineInfo) return;
  if (lineInfo.onDemand === true) return;
  const eid = lineInfo.pxEventId;
  if (eid == null) return;
  const mt = lineInfo.marketType;
  if (mt !== 'spread' && mt !== 'total') return;
  // Route to staging during warm refresh, to live otherwise. Reads of the
  // current slot also go through `target` so within-seed comparisons see
  // a consistent view (the staging primary set, not the previous-refresh
  // live one).
  const target = _seedPrimaryTarget || primaryByEvent;
  if (!target[eid]) target[eid] = { spread: null, total: null };

  // Bug 2026-04-27: previous "first-seen wins" heuristic let alt spreads
  // get locked in as primary if PX seeded them before the main spread —
  // observed Spurs -25.5 + Knicks -20.5 alt parlays passing through
  // isBlockedAltSpread because their false-primary made the +/- 2.0
  // distance check trivially true (alt == "primary").
  //
  // Fix: prefer the SMALLEST-magnitude line as primary. The actual main
  // spread is always the line closest to zero (e.g. NBA -3.5 main, alt
  // ladder runs out to -25.5 in 1-pt increments). Replacing on smaller
  // magnitude means even if PX seeds alts first, the main eventually
  // wins as soon as it's registered.
  //
  // For totals: same logic — though the "smallest" framing is less
  // intuitive (totals are positive numbers, not signed). Use abs(line)
  // for both. NBA totals primary is ~220, alts run 200-240; the "main"
  // is the line with the most book consensus, which is typically the
  // median, not the smallest. So for totals we keep first-seen for now
  // — the spread bug was the operator-observed one.
  const newLine = Number(lineInfo.line);
  if (!Number.isFinite(newLine)) return;
  const newAbs = Math.abs(newLine);
  if (newAbs === 0) return; // line=0 isn't a real spread/total

  if (mt === 'spread') {
    const cur = target[eid].spread;
    const curAbs = cur ? Math.abs(Number(cur.line) || Infinity) : Infinity;
    if (newAbs < curAbs) target[eid].spread = lineInfo;
  }
  if (mt === 'total') {
    // Totals: same bug class as spreads (first-seen could be an alt
    // seeded before the main), but "smallest wins" doesn't translate —
    // totals are positive and the main is near-median, not near-zero.
    //
    // Fix: track ALL seen total lines per event, then getPrimaryTotalLine
    // returns the median. With ≥3 alts seeded, the median converges to
    // the main quickly (alt ladders cluster symmetrically around the
    // main). With <3 known lines, fall back to first-seen.
    if (!target[eid].total) target[eid].total = lineInfo;
    if (!target[eid].seenTotalLines) target[eid].seenTotalLines = new Set();
    target[eid].seenTotalLines.add(newAbs);
  }
}

// Reverse lookup: PX event_id → event metadata
const eventIndex = {};

// Tournament ID → name/sport lookup
const tournamentIndex = {};

// Stats from last seed
let lastSeedStats = null;

// ---------------------------------------------------------------------------
// SPORT-AWARE LINE BOUNDS — reject sub-game/prop totals and spreads
// ---------------------------------------------------------------------------
const TOTAL_BOUNDS_BY_SPORT = {
  'basketball_nba': [180, 300],
  'basketball_ncaab': [100, 200],
  'basketball_wnba': [130, 200],
  'icehockey_nhl': [4, 9],
  'baseball_mlb': [6.5, 15],
  'soccer': [0.5, 7],
  'soccer_usa_mls': [0.5, 7],
  'soccer_epl': [0.5, 7],
  'soccer_uefa_champs_league': [0.5, 7],
  'soccer_uefa_europa_league': [0.5, 7],
  'soccer_spain_la_liga': [0.5, 7],
  'soccer_italy_serie_a': [0.5, 7],
  'soccer_germany_bundesliga': [0.5, 7],
  'soccer_france_ligue_one': [0.5, 7],
  'soccer_usa_nwsl': [0.5, 7],
  // MMA total rounds — 3-round prelims have 1.5/2.5 lines, 5-round
  // main events add 3.5/4.5. Range [0.5, 5.5] covers every DK-posted
  // rounds line.
  'mma_mixed_martial_arts': [0.5, 5.5],
  'soccer_mexico_ligamx': [0.5, 7],
  'soccer_brazil_campeonato': [0.5, 7],
  'soccer_conmebol_libertadores': [0.5, 7],
  'tennis': [15, 40],
  // Football (NFL_CFB_READINESS T1.4). NOTE: bounds are NOT a substitute for
  // the second-half seed exclusion — [30, 65] rejects the harmless 2H 16.5/
  // 17.5 lines and ACCEPTS the dangerous 2H 35.5 (which collides with the
  // full-game ladder). The name filter + parser retag are the real defence;
  // this is the sanity net for prop/period totals that slip type detection.
  'americanfootball_nfl': [30, 65],
  'americanfootball_nfl_preseason': [30, 65],
  'americanfootball_ncaaf': [30, 90],
  'americanfootball_cfl': [35, 70],
};
// Max plausible alt-spread line per sport. PX bettors commonly play alt
// lines out to ±4 or ±5 for hockey/baseball (e.g. Rangers -3.5 puck line,
// Dodgers -4.5 run line). Previous bounds of 3 for NHL and MLB excluded
// these entirely — ~350 NHL alt-spread RFQs/hour were silently declining
// because the ENTIRE market bundle was rejected whenever its first
// market_line happened to exceed 3. Widened to 5 for those sports.
const MAX_SPREAD_BY_SPORT = {
  'basketball_nba': 30,
  'basketball_ncaab': 40,
  'basketball_wnba': 30,
  'icehockey_nhl': 5,
  'baseball_mlb': 5,
  'soccer': 5,
  'soccer_usa_mls': 5,
  'soccer_epl': 5,
  'soccer_uefa_champs_league': 5,
  'soccer_uefa_europa_league': 5,
  'soccer_spain_la_liga': 5,
  'soccer_italy_serie_a': 5,
  'soccer_germany_bundesliga': 5,
  'soccer_france_ligue_one': 5,
  'soccer_usa_nwsl': 5,
  'soccer_mexico_ligamx': 5,
  'soccer_brazil_campeonato': 5,
  'soccer_conmebol_libertadores': 5,
  'tennis': 10,
  // Football (NFL_CFB_READINESS T1.4). NFL spreads top out ~17-20 (widest
  // posted alt ladders included); NCAAF mismatches genuinely reach the 40s.
  // These also feed the virtual-registration maxSpread gate — the DISTANCE
  // gate there (MAX_ALT_DEVIATION) deliberately has no football entries, so
  // props cannot ride these wider bounds into an alt-spread registration.
  'americanfootball_nfl': 21,
  'americanfootball_nfl_preseason': 21,
  'americanfootball_ncaaf': 45,
  'americanfootball_cfl': 30,
};

/**
 * Returns true if `line` is within the plausible full-game range for the
 * given sport+markettype. Returns true (accept) for markets/sports without
 * defined bounds. `marketType` = 'total', 'spread', or 'team_total'.
 * F5 markets should be excluded by the caller.
 *
 * team_total lines are always much lower than full-game totals (e.g. MLB
 * team total 3.5-4.5 runs vs full-game 8.5-10) so they get their own
 * lenient bounds. Bypass the check entirely with a permissive range —
 * parseMarketSelections already distinguishes them by name.
 */
function isValidFullGameLine(sport, marketType, line) {
  if (line == null) return true;
  const absLine = Math.abs(line);
  if (marketType === 'team_total') {
    // Team totals are naturally low. Accept 0 to 15 (covers everything from
    // hockey 0.5-goal team totals to NBA 130-point team totals ... wait,
    // NBA team totals are 100+, so widen). Use a very permissive range.
    return absLine >= 0 && absLine <= 200;
  }
  if (marketType === 'total') {
    const bounds = TOTAL_BOUNDS_BY_SPORT[sport];
    if (bounds) return absLine >= bounds[0] && absLine <= bounds[1];
    // Fallback: reject obviously sub-game totals
    return absLine > 2.5;
  }
  if (marketType === 'spread') {
    const max = MAX_SPREAD_BY_SPORT[sport];
    if (max != null) return absLine <= max;
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// TEAM NAME MATCHING
// ---------------------------------------------------------------------------

// Known overrides for team name mismatches between PX and The Odds API
// Add entries here if matching fails for specific teams
const TEAM_NAME_OVERRIDES = {
  // PFL: PX and TOA disagree on this fighter's surname. Same fight either way
  // — same opponent (Tyson Pedro), same card, same 2026-07-26T03:00 start —
  // and getEventMarkets requires BOTH names to resolve to one event, so this
  // maps the non-Pedro side of a single real fight, not a different bout.
  'rafael xavier': 'Rafael Alves',
  // CFL: PX spells the club out, TOA abbreviates (verified 2026-07-24).
  'british columbia lions': 'BC Lions',
  // Argentine Primera (verified against TOA 2026-07-24). Most PX club
  // prefixes (CA/SC/CR) fall out of the substring matcher fine — these two
  // do not:
  //   • "CA Unión" has no TOA substring overlap with "Union Santa Fe".
  //   • "AA Estudiantes" is Asociación Atlética Estudiantes (RÍO CUARTO),
  //     but the substring matcher resolved it to plain "Estudiantes" — a
  //     DIFFERENT club (La Plata). Confirmed by fixture time: PX's
  //     "CA Tigre at AA Estudiantes" 07-25 17:45 is TOA's "CA Tigre BA @
  //     Estudiantes de Río Cuarto" at the same minute, while "Estudiantes"
  //     plays Independiente on 07-26. Without this override we'd resolve
  //     the wrong club (the event lookup then failed closed, but a
  //     same-name pairing could have priced the wrong game).
  'ca union': 'Union Santa Fe',
  'aa estudiantes': 'Estudiantes de Río Cuarto',
  // SharpAPI abbreviates some NHL city names
  'washington capitals': 'WAS Capitals',
  'columbus blue jackets': 'CBJ Blue Jackets',
  'montreal canadiens': 'MTL Canadiens',
  'new jersey devils': 'NJ Devils',
  'san jose sharks': 'SJ Sharks',
  'los angeles kings': 'LA Kings',
};

function normalizeTeamName(name) {
  // Strip diacritics first (Godínez → Godinez, São Paulo → Sao Paulo) so
  // ASCII-only feeds can match international/combat-sport names. Without
  // NFD-decomposition + combining-mark removal, every accented fighter name
  // silently drops through the matcher (the í character is not in
  // [a-z0-9 ] so the previous regex would just delete it, corrupting the
  // name to "godnez").
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Resolve a team_total "hint" (extracted from market name) to home/away side.
 * Team total markets on PX are named things like "SJ: Team Total Goals" or
 * "Philadelphia Phillies Team Total Runs". The prefix before "Team Total" is
 * the team, but it may be an abbreviation, initials, or full name. This
 * function tries several strategies in order of confidence.
 *
 * Returns 'home', 'away', or null.
 */
function resolveTeamTotalSide(hint, homeTeam, awayTeam) {
  if (!hint) return null;
  const normHint = normalizeTeamName(hint);
  if (!normHint) return null;

  // Explicit side labels
  if (normHint === 'home') return 'home';
  if (normHint === 'away') return 'away';

  const normHome = normalizeTeamName(homeTeam);
  const normAway = normalizeTeamName(awayTeam);

  // Exact normalized match
  if (normHint === normHome) return 'home';
  if (normHint === normAway) return 'away';

  // Check TEAM_NAME_OVERRIDES forward and reverse (handles things like
  // "MTL Canadiens" ↔ "Montreal Canadiens").
  for (const [k, v] of Object.entries(TEAM_NAME_OVERRIDES)) {
    const normK = normalizeTeamName(k);
    const normV = normalizeTeamName(v);
    if (normHome === normK || normHome === normV) {
      if (normHint === normK || normHint === normV) return 'home';
      if (normV.includes(normHint) || normK.includes(normHint)) return 'home';
    }
    if (normAway === normK || normAway === normV) {
      if (normHint === normK || normHint === normV) return 'away';
      if (normV.includes(normHint) || normK.includes(normHint)) return 'away';
    }
  }

  // Substring: full team name contains the hint (or vice versa).
  // BOTH-SIDES AMBIGUITY CHECK (NFL_CFB_READINESS): home was checked first
  // and returned immediately, so a hint contained in BOTH competitors always
  // resolved to home. Measured collision on the 2026-08-06 preseason probe:
  // PX abbreviates team totals ("ARI: Team Total Points" / "CAR: Team Total
  // Points"), and "CAR" is a substring of both "CARolina" and "CARdinals" —
  // both team totals registered as Arizona. When both sides substring-hit,
  // fall through to the abbreviation strategies below (more specific — they
  // resolve CAR→Carolina via first-word prefix); if nothing disambiguates,
  // the final return null fails the line closed instead of guessing.
  {
    const homeSub = normHome.includes(normHint) || normHint.includes(normHome);
    const awaySub = normAway.includes(normHint) || normHint.includes(normAway);
    if (homeSub && !awaySub) return 'home';
    if (awaySub && !homeSub) return 'away';
  }

  // Abbreviation / initials matching. Sports use three different
  // abbreviation conventions and we need to handle all of them:
  //
  //   1. All-word initials: "SJS" (San Jose Sharks), "CBJ" (Columbus
  //      Blue Jackets), "NYY" (New York Yankees)
  //   2. First-N-word prefix initials: "SJ" (San Jose), "LA" (Los
  //      Angeles), "NY" (New York), "GS" (Golden State)
  //   3. First-N-char chunk: "VAN" (Vancouver), "MON"/"MTL" (Montreal),
  //      "PHI" (Philadelphia)
  function allWordInitials(name) {
    return normalizeTeamName(name).split(/\s+/).map(w => w[0] || '').join('');
  }
  function firstNWordInitials(name, n) {
    return normalizeTeamName(name).split(/\s+/).slice(0, n).map(w => w[0] || '').join('');
  }
  function firstWordChunk(name, n) {
    const norm = normalizeTeamName(name);
    return norm.replace(/\s/g, '').slice(0, n);
  }
  const hintCompact = normHint.replace(/\s/g, '');

  // Every abbreviation strategy below resolves ONLY when exactly one side
  // matches. A double-hit (e.g. "NEW" against New York + New England via
  // first-word chunk) falls through to the next strategy rather than
  // returning the home side by check order; a hint no strategy uniquely
  // resolves returns null and the line fails closed.
  const _uniqueSide = (homeHit, awayHit) => (homeHit && !awayHit) ? 'home' : (awayHit && !homeHit) ? 'away' : null;

  // Strategy 1: all-word initials
  {
    const side = _uniqueSide(
      hintCompact === allWordInitials(homeTeam),
      hintCompact === allWordInitials(awayTeam));
    if (side) return side;
  }

  // Strategy 2: first-N-word prefix initials where N = hint length
  if (hintCompact.length >= 2 && hintCompact.length <= 4) {
    const side = _uniqueSide(
      firstNWordInitials(homeTeam, hintCompact.length) === hintCompact,
      firstNWordInitials(awayTeam, hintCompact.length) === hintCompact);
    if (side) return side;
  }

  // Strategy 3: first-N-chars of first word
  for (const n of [5, 4, 3]) {
    if (hintCompact.length !== n) continue;
    const side = _uniqueSide(
      firstWordChunk(homeTeam, n) === hintCompact,
      firstWordChunk(awayTeam, n) === hintCompact);
    if (side) return side;
  }

  // Last-word match (e.g., "Phillies" vs "Philadelphia Phillies")
  const homeLast = normHome.split(/\s+/).pop();
  const awayLast = normAway.split(/\s+/).pop();
  {
    const side = _uniqueSide(normHint === homeLast, normHint === awayLast);
    if (side) return side;
  }

  return null;
}

/**
 * Resolve the display-friendly team name for a parsed selection.
 *
 * Most market types (moneyline, spread, F5/H1 variants) carry the full
 * team name in `sel.teamName` because parseMarketSelections lifts it
 * from the selection text. team_total is the exception: PX names those
 * markets like "CLE: Team Total Points" or "TOR Team Total Runs", so
 * the parsed teamName is just the abbreviated prefix ("CLE", "TOR").
 *
 * Storing the abbreviation as `lineIndex[lineId].teamName` propagated
 * to the dashboard's parlay-detail "Team / Selection" column, where
 * mid-parlay legs read like "CLE" alongside fully-named legs like
 * "Atlanta Braves -1.5". For team_total legs, swap the abbreviation
 * for the matched event's full home/away team name (we already
 * resolved the side via resolveTeamTotalSide for selection routing).
 *
 * Falls through to sel.teamName for every other market type — those
 * already carry the canonical name.
 */
function resolveDisplayTeamName(sel, matchedHome, matchedAway) {
  if (sel && sel.marketType === 'team_total') {
    const side = resolveTeamTotalSide(sel.teamName, matchedHome, matchedAway);
    if (side === 'home') return matchedHome;
    if (side === 'away') return matchedAway;
  }
  return sel ? sel.teamName : null;
}

/**
 * Try to match a PX team name to an Odds API team name.
 * Strategies: exact, contains, override map.
 */
function matchTeamName(pxName, oddsApiNames) {
  const norm = normalizeTeamName(pxName);

  // Check override map
  if (TEAM_NAME_OVERRIDES[norm]) {
    const override = TEAM_NAME_OVERRIDES[norm];
    const match = oddsApiNames.find(n => normalizeTeamName(n) === normalizeTeamName(override));
    if (match) return match;
  }

  // Exact normalized match
  const exact = oddsApiNames.find(n => normalizeTeamName(n) === norm);
  if (exact) return exact;

  // Substring: PX name contains Odds API name or vice versa.
  // AMBIGUITY-GUARDED: this branch used to return the FIRST hit, which is
  // candidate-array-order-dependent and measurably wrong — "CAR" matched
  // "Arizona Cardinals" (substring of "Cardinals") before "Carolina
  // Panthers" ever got looked at, and bare CFB school names ("Michigan",
  // "Texas") resolved to whichever directional variant the odds cache
  // happened to list first. Mirror the last-N-words discipline below:
  // exactly one distinct match or fall through (last-N-words may still
  // resolve it; otherwise null = fail closed, leg goes dark instead of
  // pricing the wrong team).
  const subMatches = [];
  for (const oaName of oddsApiNames) {
    const oaNorm = normalizeTeamName(oaName);
    if (norm.includes(oaNorm) || oaNorm.includes(norm)) {
      if (!subMatches.some(n => normalizeTeamName(n) === oaNorm)) subMatches.push(oaName);
    }
  }
  if (subMatches.length === 1) return subMatches[0];

  // Last N words match (e.g., "Red Sox" matches "Boston Red Sox")
  const pxWords = norm.split(/\s+/);
  // Try last 2 words first (handles "Red Sox" vs "White Sox"), then last 1 word
  for (const n of [2, 1]) {
    if (pxWords.length < n + 1) continue; // Need at least n+1 words (city + name)
    const pxTail = pxWords.slice(-n).join(' ');
    if (pxTail.length < 4) continue;
    const matches = oddsApiNames.filter(name => {
      const words = normalizeTeamName(name).split(/\s+/);
      if (words.length < n) return false;
      return words.slice(-n).join(' ') === pxTail;
    });
    if (matches.length === 1) return matches[0];
  }

  return null;
}

/**
 * Resolve a PX selection's team name to 'home' | 'away' | null.
 *
 * THE TRAP THIS EXISTS TO CLOSE (found live in prod 2026-08-18): every call
 * site used to test the home candidate alone, then fall back to testing the
 * away candidate alone. Both of matchTeamName's ambiguity guards are COUNTING
 * guards -- `subMatches.length === 1` and `matches.length === 1` -- so a
 * ONE-ELEMENT candidate array satisfies them unconditionally. Any fuzzy
 * overlap with the side under test therefore wins outright, and because home
 * was always tested first, an AWAY team that merely shares a suffix with the
 * home team registered as 'home'.
 *
 * Measured on the live board: PX event 90104379, "Atlanta United FC at
 * Minnesota United FC". BOTH moneyline lines carried oddsApiSelection='home'
 * and BOTH quoted fairProb 0.7061 (-260) -- the away side priced at the home
 * side's number. It resolved on the last-2-words branch, tail "united fc".
 * The guards never engaged because each was asked about a single candidate.
 *
 * This FAILS OPEN: it registers a line and quotes it. Harm direction depends
 * on which club is the favourite. In the measured case the away side was the
 * dog, so the bad price is one no bettor wants. The mirror case -- an away
 * FAVOURITE -- offers a ~70% team at the ~30% side's price, which is the shape
 * that loses money. English football is dense with the collision ("* City FC",
 * "* Town FC", "* United FC"), so expanding there would arm it.
 *
 * Passing BOTH candidates lets the real guards do their job: an unambiguous
 * winner resolves, a genuine tie returns null and the leg fails closed.
 */
function resolveHomeAwaySide(pxTeamName, matchedHome, matchedAway) {
  if (!pxTeamName || !matchedHome || !matchedAway) return null;
  // Degenerate feed data -- cannot attribute a side, so don't guess.
  if (normalizeTeamName(matchedHome) === normalizeTeamName(matchedAway)) return null;
  const matched = matchTeamName(pxTeamName, [matchedHome, matchedAway]);
  if (!matched) return null;
  if (matched === matchedHome) return 'home';
  if (matched === matchedAway) return 'away';
  return null;
}

// ---------------------------------------------------------------------------
// MARKET TYPE MAPPING
// ---------------------------------------------------------------------------

// PX market.type → Odds API market key
const MARKET_TYPE_MAP = {
  'moneyline': 'h2h',
  // Knockout qualification ("To Advance To The Next Round"). Maps to h2h
  // because P(advance) IS the DNB probability derived from the 3-way — see
  // ADVANCE_MARKET_RE. The pricer's DNB branch keys on oddsApiMarket==='h2h'.
  'advance': 'h2h',
  'spread': 'spreads',
  'total': 'totals',
  'team_total': 'team_totals',
  'btts': 'btts',
  'both_teams_to_score': 'btts',
  // Method of victory — identity-mapped: the fair comes from services/ufc-mov
  // (DK 6-way board), not from an odds-feed market key, but oddsApiMarket must
  // be set or the registration gate below drops the selection.
  // Tennis SET markets — identity-mapped for the same reason as MoV below: the
  // fair comes from the sets block on the cached tennis event (written by
  // pinnacle-tennis / the TOA overlay under these exact keys), not from a
  // generic odds-feed market, but oddsApiMarket MUST be set or the registration
  // gate drops the selection.
  'first_set_moneyline': 'first_set_moneyline',
  'total_sets': 'total_sets',
  'set_win_at_least_one': 'set_win_at_least_one',
  'mov_ko': 'mov_ko',
  'mov_sub': 'mov_sub',
  'mov_dec': 'mov_dec',
  'mov_itd': 'mov_itd',
  'double_chance': 'double_chance',
  // First 5 Innings (MLB) — PX market.type guesses; adjust based on decline-audit log
  'first_5_innings_moneyline': 'h2h_f5',
  'first_five_innings_moneyline': 'h2h_f5',
  'first_5_innings_run_line': 'spreads_f5',
  'first_five_innings_run_line': 'spreads_f5',
  'first_5_innings_total': 'totals_f5',
  'first_5_innings_total_runs': 'totals_f5',
  'first_five_innings_total': 'totals_f5',
  // First Half (NBA) — PX market.type guesses; adjust based on decline-audit log
  'first_half_moneyline': 'h2h_h1',
  '1st_half_moneyline': 'h2h_h1',
  'first_half_spread': 'spreads_h1',
  '1st_half_spread': 'spreads_h1',
  'first_half_total': 'totals_h1',
  '1st_half_total': 'totals_h1',
  'first_half_total_points': 'totals_h1',
  '1st_half_total_points': 'totals_h1',
};

const F5_MARKET_TYPES = [
  'first_5_innings_moneyline',
  'first_five_innings_moneyline',
  'first_5_innings_run_line',
  'first_five_innings_run_line',
  'first_5_innings_total',
  'first_5_innings_total_runs',
  'first_five_innings_total',
];

const FIRST_HALF_MARKET_TYPES = [
  'first_half_moneyline',
  '1st_half_moneyline',
  'first_half_spread',
  '1st_half_spread',
  'first_half_total',
  '1st_half_total',
  'first_half_total_points',
  '1st_half_total_points',
];

// Sports whose team-total markets we inline-source at seed time (team totals
// live only on TOA's per-event endpoint; see oddsFeed.ensureTeamTotals). NBA/
// NHL are offseason now but wired for their return.
const TEAM_TOTAL_SEED_SPORTS = new Set(['baseball_mlb', 'basketball_nba', 'icehockey_nhl']);

// ---------------------------------------------------------------------------
// GOLF OUTRIGHTS — parlay leg registration
// ---------------------------------------------------------------------------
// Kill-switch: unset/false ⇒ not a single outright line registers, so PX never
// sends us an outright RFQ and nothing about golf changes.
// Read from config on EVERY seed rather than captured once at module load, so
// the Runtime Tuning tab can flip it without a redeploy. config.js still
// derives the default from GOLF_OUTRIGHTS_PARLAY_ENABLED, so env behaviour is
// unchanged.
const golfOutrightsEnabled = () => config.pricing.golfOutrightsParlayEnabled !== false;

// Classify the market from the PX EVENT name (the event names the market; each
// market inside it is one player). Mirrors golf-outrights.js's PX_EVENT_PATTERNS.
// top_20 before top_10 before top_5 so "Top 20" can't be shadowed by /top.?2/.
// ---------------------------------------------------------------------------
// SOCCER "TO ADVANCE TO THE NEXT ROUND" (knockout qualification)
// ---------------------------------------------------------------------------
// PX market: name "To Advance To The Next Round", type 'sup_moneyline',
// selections named by COMPETITOR ABBREVIATION ("ENG"/"ARG") with NO
// competitor_id — so they must be mapped against the event's competitors.
// px.parseMarketSelections returns 0 selections for it (it only understands
// team-named moneylines), hence the dedicated parser below.
//
// PRICING: reuses the existing DNB fair — no new odds source. In a knockout,
// "advance" == "win including ET/penalties", so with w+a+d = 1:
//     P(adv) = w + d*[w/(w+a)] = w*(w+a+d)/(w+a) = w/(w+a) = DNB
// i.e. advance is EXACTLY the draw-no-bet probability, provided ET/pens track
// 90-min relative strength. PX's own book agrees to within a tick
// (ML 2-Way ENG -117/ARG +116 vs Advance ENG -118/ARG +115, 2026-07-15).
//
// KNOWN MODEL RISK: penalties are closer to a coin-flip than 90-min strength
// implies, so the true P(adv|draw) sits between 0.5 and DNB. DNB therefore
// slightly OVERSTATES the favourite (conservative for us — we quote its YES
// rich) and slightly UNDERSTATES the underdog (we'd quote its YES cheap).
// ADVANCE_UNDERDOG_SHADE_PP nudges the underdog side up to cover that; set 0 to
// price pure DNB.
const ADVANCE_MARKET_RE = /to\s+advance\s+to\s+the\s+next\s+round|to\s+advance\b|to\s+qualify\b/i;

// "Both Teams To Score". PX types this `moneyline` (live probe 2026-07-16),
// so the seed's name allowlist — which demands a type='moneyline' market be
// NAMED like a moneyline ("Moneyline (2 Way)", "Draw No Bet", ...) — rejected
// it before registration. Same carve-out shape as ADVANCE_MARKET_RE above.
// Anchored so a half/period variant ("Both Teams to Score - 1st Half") can't
// ride the full-game BTTS consensus; that market has its own fair we don't
// carry. parseMarketSelections retags marketType='btts' for these.
// UFC Method of Victory. Like BTTS, PX types these 'moneyline', so the seed's
// fullGameNames allowlist (which demands a type='moneyline' market be NAMED
// like a moneyline) rejects them before registration. parseMarketSelections
// retags marketType to mov_ko / mov_sub / mov_dec / mov_itd and puts the
// fighter in playerName.
const MOV_MARKET_RE = /\bto\s+win\s+(?:by\s+(?:ko\/tko(?:\/dq)?|submission|decision)|inside\s+the\s+distance)\s*$/i;
const MOV_MARKET_TYPES = ['mov_ko', 'mov_sub', 'mov_dec', 'mov_itd'];

const BTTS_MARKET_RE = /^both\s+teams\s+to\s+score\b/i;
const BTTS_PERIOD_RE = /\b(1st|2nd|first|second)\s*(half|period)\b|\bhalf\b|\bperiod\b/i;

/**
 * Parse PX's advance market into our selection shape.
 * Maps each selection to home/away by matching its name against the event's
 * competitor ABBREVIATION first, then full name. Returns [] if either side
 * can't be resolved — fail closed rather than guess which team advances.
 */
function _parseAdvanceSelections(market, homeComp, awayComp) {
  if (!homeComp || !awayComp) return [];
  const flat = [];
  for (const g of (market.selections || [])) { if (Array.isArray(g)) flat.push(...g); else flat.push(g); }
  const norm = s => String(s || '').trim().toLowerCase();
  const match = (selName) => {
    const n = norm(selName);
    if (!n) return null;
    if (n === norm(homeComp.abbreviation) || n === norm(homeComp.name)) return { side: 'home', comp: homeComp };
    if (n === norm(awayComp.abbreviation) || n === norm(awayComp.name)) return { side: 'away', comp: awayComp };
    return null;
  };
  const out = []; const seen = new Set();
  for (const sel of flat) {
    if (!sel || !sel.line_id || seen.has(sel.line_id)) continue;
    const m = match(sel.name);
    if (!m) continue;
    seen.add(sel.line_id);
    out.push({
      lineId: sel.line_id,
      marketType: 'advance',
      selection: m.side,          // 'home' | 'away' — drives the DNB lookup
      teamName: m.comp.name,      // real team name, not the abbreviation
      line: null,
      competitorId: m.comp.id,
      outcomeName: m.comp.name,
    });
  }
  // Both sides or nothing: a one-sided advance market means our mapping failed.
  return out.length === 2 ? out : [];
}

const GOLF_OUTRIGHT_EVENT_PATTERNS = [
  { key: 'outright_make_cut', re: /make\s*(?:\/\s*miss\s*)?(?:the\s+)?cut|miss\s*(?:the\s+)?cut/i },
  { key: 'outright_top_20',   re: /top[\s-]?20\b/i },
  { key: 'outright_top_10',   re: /top[\s-]?10\b/i },
  { key: 'outright_top_5',    re: /top[\s-]?5\b/i },
  { key: 'outright_win',      re: /tournament\s+winner|outright\s+winner|to\s+win\s+(?:the\s+)?tournament|^winner$/i },
];
function classifyGolfOutrightEvent(name) {
  for (const p of GOLF_OUTRIGHT_EVENT_PATTERNS) if (p.re.test(name || '')) return p.key;
  return null;
}

/**
 * Register one PX golf outright event's player markets as parlay lines.
 *
 * YES-SIDE ONLY for win/top_5/top_10/top_20 (operator directive 2026-07-14):
 * the counterparty gets YES. We never register the NO line for those, so PX
 * cannot build us a NO-side leg. (pricer's guard rejects a NO leg too, in case
 * PX ever sends one against an unregistered line.)
 *
 * make_cut registers BOTH sides — it's the one binary market here with a real,
 * two-sided book quote behind it (make+miss), so its NO side is priced off the
 * same power de-vig rather than an inferred complement.
 *
 * Returns the number of lines registered.
 */
// Top 5/10/20 are priced ONLY from DK's "(Including Ties)" board
// (services/golf-topn.js) — PX settles ties-included and DataGolf publishes
// top-N on the DEAD-HEAT basis (~25% LOW). That constraint lives in PRICING,
// which fails closed, NOT in registration.
//
// This used to gate registration on the DK board being warm ("so PX can't send
// a leg we'd decline"). That was wrong and actively harmful: the DK scrape takes
// ~150s while seeds run every ~2 min, so during any cold window the gate skipped
// top-N, and because seedAllLines is build-then-swap, skipping DELETES the lines
// from the live index. Result: top-N registration FLAPPED (registered → wiped →
// registered) on every boot and any scrape hiccup, PX stopped sending those
// RFQs, and it surfaced as "we aren't quoting Top 5" (operator, 2026-07-15).
// A missing line is far worse than a declined RFQ: we lose the RFQ entirely and
// PX's supported set churns.
//
// It was also inconsistent — make_cut registers all 156 players even though only
// ~97 can price (the rest lack 2 two-sided books). Registration means "PX may
// ask us"; pricing decides whether we answer. getTopNFairProbSync returns null
// on a cold/stale/absent board and the leg declines cleanly.

async function _registerGolfOutrightEvent(event) {
  const marketType = classifyGolfOutrightEvent(event.name);
  if (!marketType) return 0; // novelty outright ("Will anyone shoot 59") — skip
  // PX names outright events "<tournament> - <market>", e.g.
  //   "2026 The Open - Tournament Winner" / "... - To Make The Cut".
  // DataGolf's event_name is the tournament ALONE ("The Open Championship"),
  // so the market suffix must be stripped before matching or EVERY leg fails
  // to price (the words "Tournament"/"Winner"/"Cut" appear in no DG name) and
  // we silently decline the whole feature. Take the part before the first " - ".
  const tournamentName = String(event.name || '').split(/\s+-\s+/)[0].trim() || String(event.name || '');
  let markets;
  try { markets = await px.fetchMarkets(event.event_id); }
  catch (err) { log.warn('Lines', `Golf outright get_markets ${event.event_id} failed: ${err.message}`); return 0; }
  if (!Array.isArray(markets)) return 0;

  const bothSides = marketType === 'outright_make_cut';
  let n = 0;
  for (const market of markets) {
    const playerName = String(market.name || '').trim();
    if (!playerName) continue;
    const flat = [];
    for (const g of (market.selections || [])) { if (Array.isArray(g)) flat.push(...g); else flat.push(g); }
    for (const sel of flat) {
      if (!sel || !sel.line_id) continue;
      const isYes = /^yes$/i.test(String(sel.name || '').trim());
      const isNo = /^no$/i.test(String(sel.name || '').trim());
      if (!isYes && !isNo) continue;
      if (isNo && !bothSides) continue; // YES-only for win/top_N
      // MUST go through _setSeedLine, NOT lineIndex directly: during a warm
      // refresh seedAllLines stages into _seedIndexTarget and then WIPES the
      // live lineIndex and replaces it with that staging object. A direct write
      // here is silently deleted at the end of every seed — which is exactly
      // why golf outrights registered 0 lines in production despite the code
      // running (operator report 2026-07-15).
      _setSeedLine(sel.line_id, {
        lineId: sel.line_id,
        sport: 'golf_outrights',
        pxEventId: event.event_id,
        pxEventName: event.name,
        marketType,
        marketName: market.name,
        selection: isYes ? 'yes' : 'no',
        playerName,
        teamName: playerName,
        // No home/away — outright events have competitors: []. Downstream code
        // must never assume a two-team shape for sport 'golf_outrights'.
        homeTeam: null,
        awayTeam: null,
        line: null,
        startTime: event.scheduled || null,
        // Tournament ONLY (no market suffix) — this is what matches DataGolf's
        // event_name. pxEventName keeps the full PX string for display/debug.
        tournamentName,
        golfOutright: true,
      });
      n++;
    }
  }
  log.info('Lines', `Golf outright registered: ${event.name} → ${n} lines (${marketType}, ${bothSides ? 'YES+NO' : 'YES only'})`);
  return n;
}

// Pitcher strikeouts prop detection.
//
// PX uses market.type='total' for these — same as game totals — and
// disambiguates only via market.name like "Dustin May Total Pitching
// Strikeouts". Returns true for pitcher K markets, false for hitter K
// markets ("Batting Strikeouts" — separate market, handled later).
//
// Catches PX's standard "Pitching Strikeouts" form plus less-common
// "K's Thrown" / "Strikeouts Thrown" variants.
function isPitcherStrikeoutMarket(name) {
  if (!name) return false;
  if (/batting\s+strike/i.test(name)) return false; // explicit hitter exclusion
  if (/pitching\s+strike/i.test(name)) return true;
  if (/\bk'?s?\s+thrown\b/i.test(name)) return true;
  if (/strike\s*outs?\s+thrown\b/i.test(name)) return true;
  return false;
}

// Extract pitcher name from a K-prop market name. PX format is typically
// "<Player Name> Total Pitching Strikeouts" — strip the trailing stat
// phrase. Final cleanup pass strips any leftover "Total" word so future
// PX naming variants don't bleed through.
function extractPitcherNameFromKMarket(name) {
  if (!name) return null;
  let stripped = String(name)
    .replace(/\s+(?:total\s+)?pitching\s+strike\s*outs?$/i, '')
    .replace(/\s+(?:total\s+)?strike\s*outs?\s+thrown$/i, '')
    .replace(/\s+(?:total\s+)?k'?s?\s+thrown$/i, '')
    .trim();
  stripped = stripped.replace(/\s+total$/i, '').trim();
  return stripped || null;
}

// ---------------------------------------------------------------------------
// SEEDING
// ---------------------------------------------------------------------------

/**
 * Seed all lines from ProphetX, match to Odds API, register supported lines.
 *
 * Flow:
 * 1. Fetch all PX sport events
 * 2. Filter to supported sports
 * 3. Fetch markets for each event
 * 4. Parse line_ids from markets
 * 5. Match each line to Odds API event/market
 * 6. Register matched lines with PX
 */
/**
 * Mass-removal circuit breaker decision. Fires when one reconcile pass would
 * remove more than `pct`% of a non-trivial tracked set — the signature of a
 * transient upstream outage (odds gap, empty PX fetch), not a schedule change.
 * Small sets (<200) are exempt: early-boot and off-season churn is legitimately
 * lumpy and wiping 50 lines is recoverable in one cycle anyway.
 */
function _removalBreakerFires(trackedSize, removeCount, pct) {
  if (!(trackedSize >= 200)) return false;
  if (!(removeCount > 0)) return false;
  const p = Number(pct) > 0 ? Number(pct) : 60;
  if (p >= 100) return false;                 // 100 = breaker disabled
  return removeCount / trackedSize > p / 100;
}

async function seedAllLines() {
  log.info('Lines', '=== Starting line seed ===');
  log.info('Lines', '[golf-debug] seedAllLines starting — golf bypass code v2 is live');

  // 0. Hydrate lineIndex from Supabase BEFORE the slow seed loop runs.
  // The seed itself takes 30-90s (PX fetch + per-event market parse +
  // matching). Without hydration, every Railway redeploy clears the
  // in-memory lineIndex and ~minute of RFQs decline as "unknown legs"
  // until seed completes. Hydration takes <2s and immediately makes
  // every recent-event line in line_cache priceable. Seed then
  // overwrites stale entries with fresh data and adds new entries.
  //
  // Only runs on COLD START (the first seed of the process). On
  // subsequent refreshLines() cycles, the seed is fast (warm odds caches)
  // and there's no gap to bridge — re-hydrating would re-introduce
  // entries from games that just finished but haven't aged out of
  // Supabase yet (line_cache uses 6h cutoff vs the per-sport cutoff
  // applied below in seed). Cold-start gating keeps the seed
  // authoritative on every periodic refresh.
  if (!_hasSeededOnce && Object.keys(lineIndex).length === 0) {
    try {
      const hydrated = await db.loadAllRecentLineCache(1);
      let count = 0;
      for (const [lineId, info] of Object.entries(hydrated)) {
        _setSeedLine(lineId, info);
        _trackPrimaryForIndex(info);
        count++;
      }
      if (count > 0) {
        log.info('Lines', `Hydrated ${count} lines from Supabase line_cache before seed (cold start)`);
      }
    } catch (err) {
      log.warn('Lines', `Line cache hydration failed (non-fatal): ${err.message}`);
    }
  }

  // 1. Fetch PX events
  const allEvents = await px.fetchSportEvents();
  const pxSportNames = Object.values(config.sportNameMap);
  const golfEventCount = allEvents.filter(e => e.sport_name === 'Golf').length;
  log.info('Lines', `[golf-debug] PX returned ${allEvents.length} total events, ${golfEventCount} with sport_name="Golf"`);

  // Build tournament + event index from ALL events (not just supported)
  for (const e of allEvents) {
    if (e.tournament_id) {
      tournamentIndex[e.tournament_id] = {
        name: e.tournament_name || e.tournament?.name || e.sport_name,
        sport: e.sport_name,
      };
    }
    // Store ALL events for name resolution (even ones we don't support)
    if (e.event_id) {
      eventIndex[e.event_id] = eventIndex[e.event_id] || {
        name: e.name,
        sport: null,
        sportName: e.sport_name,
        competitors: e.competitors,
        scheduled: e.scheduled,
      };
    }
  }
  log.info('Lines', `Built indexes: ${Object.keys(tournamentIndex).length} tournaments, ${Object.keys(eventIndex).length} events`);

  // 2. Filter to supported sports (accept any non-settled status).
  // Also drop events whose scheduled start is more than the per-sport
  // post-game cutoff in the past. PX can take many hours to mark a
  // finished game as 'settled', and during that window we'd otherwise
  // keep yesterday's F5/spread/total lines in our index, polluting the
  // dashboard and wasting the Supabase line-cache budget.
  //
  // Cutoffs sized to typical game length + buffer for OT / extras / late
  // finishes. Golf is exempt (multi-day tournaments — Round 1 scheduled
  // on Thursday is still relevant Sunday).
  const POST_GAME_CUTOFF_HOURS_BY_SPORT = {
    'Baseball':   5,   // MLB ~3.5hr typical; extras can push to 5+
    'Basketball': 4,   // NBA/WNBA/NCAAB ~2.5hr typical; OT pushes
    'Hockey':     4,   // NHL ~2.5hr; OT/SO buffer
    'Tennis':     6,   // matches occasionally run long
    'Soccer':     3,   // ~2hr typical
    'MMA':        7,   // multi-fight cards
    'Boxing':     7,   // same
    'Football':   4,   // NFL/NCAAF ~3.5hr
    'Golf':       9999, // multi-day tournaments — never filter on scheduled
  };
  const DEFAULT_CUTOFF_HOURS = 6;
  const nowMs = Date.now();
  let droppedAsStale = 0;
  const events = allEvents.filter(e => {
    if (!pxSportNames.includes(e.sport_name)) return false;
    if (e.status && e.status === 'settled') return false;
    // Golf OUTRIGHTS legitimately carry competitors: [] — PX models them as one
    // event per market ("2026 The Open - Tournament Winner") whose MARKETS are
    // the players, not a two-competitor matchup. This <2 guard silently dropped
    // them before the main loop, so _registerGolfOutrightEvent never ran and the
    // Lines table showed zero outrights (operator report 2026-07-15).
    const _isGolfOutright = e.sport_name === 'Golf' && e.sub_type === 'outrights';
    if (!_isGolfOutright && (!e.competitors || e.competitors.length < 2)) return false;
    if (e.scheduled) {
      const startMs = new Date(e.scheduled).getTime();
      const cutoffHours = POST_GAME_CUTOFF_HOURS_BY_SPORT[e.sport_name] ?? DEFAULT_CUTOFF_HOURS;
      const cutoffMs = nowMs - cutoffHours * 3600 * 1000;
      if (Number.isFinite(startMs) && startMs < cutoffMs) {
        droppedAsStale++;
        return false;
      }
    }
    return true;
  });
  log.info('Lines', `Found ${events.length} supported sport events (of ${allEvents.length} total; dropped ${droppedAsStale} past per-sport stale cutoff)`);

  // Get all Odds API cached events for matching
  const oddsApiEvents = oddsFeed.getAllCachedEvents();

  let totalLines = 0;
  let matchedLines = 0;
  let unmatchedEvents = [];
  // Golf-seed trace counters. Populated during the main event loop so
  // we can inspect drop points without trawling Railway logs. Exposed
  // in the /refresh-lines response via lastSeedStats.
  const golfTrace = {
    eventsFiltered: 0,       // golf events that passed the outer pxSportNames filter
    bypassFired: 0,          // event-level bypass set matchedHome from competitors
    marketsFound: 0,         // golf markets returned by PX fetchMarkets
    marketsPassedFilter: 0,  // golf markets that survived mainMarkets filter
    selectionsParsed: 0,     // individual selections across golf markets
    selectionsSkipped: 0,    // selections that got `continue` at the oddsApiSelection check
    linesRegistered: 0,      // golf lines that made it into lineIndex
    sampleEventName: null,
    sampleMarketName: null,
    sampleSelectionTeam: null,
  };

  // 3-4. Fetch markets and parse for each event
  // Kick the DK ties-included top-N warm for EVERY golf tournament PX lists,
  // in ONE call. Fire-and-forget: the DK scrape is Puppeteer (~142s/tournament)
  // and must never block seeding or the RFQ path. It's one call rather than
  // per-event because warmTopN is single-flight — per-event calls would collapse
  // into the first one and starve every other tournament.
  // Cold-start is BY DESIGN: the first seed registers only win/make_cut, and the
  // next seed (REFRESH_INTERVAL_MINUTES) picks up top-N once the board lands.
  // Fail-closed beats a fast wrong price.
  if (golfOutrightsEnabled()) {
    const golfTournaments = [...new Set(events
      .filter(e => e.sport_name === 'Golf' && e.sub_type === 'outrights')
      .map(e => String(e.name || '').split(/\s+-\s+/)[0].trim())
      .filter(Boolean))].map(tournamentName => ({ tournamentName }));
    if (golfTournaments.length) {
      golfTopN.warmTopN(golfTournaments).catch(err => {
        log.warn('Lines', `Golf top-N warm swallowed error: ${err.message}`);
      });
    }
  }

  // Kick the UFC method-of-victory warm when PX lists any MMA event. Same
  // shape and same reasoning as the golf top-N warm above: the DK scrape walks
  // one page per fight (~3-5 min), so it is fire-and-forget and must never
  // block seeding or the RFQ path. Cold-start is BY DESIGN — the first seed
  // registers MoV lines that decline until the board lands, and the next seed
  // cycle prices them. TTL-gated + single-flight inside warmMovBoards, so
  // calling it every seed is cheap.
  if (events.some(e => /mma|mixed martial/i.test(e.sport_name || ''))) {
    ufcMov.warmMovBoards().catch(err => {
      log.warn('Lines', `UFC MoV warm swallowed error: ${err.message}`);
    });
  }

  for (const event of events) {
    const _isGolfTrace = event.sport_name === 'Golf';
    if (_isGolfTrace) {
      golfTrace.eventsFiltered++;
      if (!golfTrace.sampleEventName) golfTrace.sampleEventName = event.name;
    }
    // Determine sport key(s) — some PX sport names map to multiple keys
    // (e.g., "Basketball" → basketball_nba AND basketball_ncaab,
    // "Soccer" → soccer + soccer_epl + soccer_germany_bundesliga + ...).
    //
    // ORDER MATTERS: the matching loop below breaks on the FIRST sport
    // key whose cache contains a matching team-name pair, which means
    // the generic catch-all key wins over league-specific keys when
    // both have entries for the same match. That mis-registers
    // today's EPL/Bundesliga/Serie A matches under sport='soccer' so
    // they don't appear in the league-specific dashboard filter.
    //
    // Sort to put generic / catch-all keys LAST. Heuristic: keys whose
    // name has no underscore-suffix (e.g. 'soccer', 'tennis') are
    // generic; keys with a suffix ('soccer_epl', 'tennis_atp_madrid')
    // are specific. Specific keys win the matching race.
    const _isGenericKey = (k) => !k.includes('_') || k === 'mma_mixed_martial_arts' || k === 'boxing_boxing';
    const possibleSportKeys = Object.entries(config.sportNameMap)
      .filter(([k, v]) => v === event.sport_name)
      .map(([k]) => k)
      .sort((a, b) => {
        const aGen = _isGenericKey(a) ? 1 : 0;
        const bGen = _isGenericKey(b) ? 1 : 0;
        return aGen - bGen; // generic last
      });
    if (possibleSportKeys.length === 0) continue;

    // We'll determine the actual sport key by which one has a matching Odds API event
    let sportKey = possibleSportKeys[0]; // default to first match (now most-specific)

    // NOTE: eventIndex[event.event_id] is stored AFTER the team-matching loop
    // below (was previously stored here with the DEFAULT sportKey). PX lumps
    // NBA/WNBA/NCAAB under sport_name="Basketball", so storing before matching
    // pinned every basketball event to the default (basketball_nba) in the
    // eventIndex even when matching corrected sportKey to basketball_wnba — which
    // is how WNBA props ended up tagged basketball_nba in matched_parlays
    // (getEventInfo → eventSport → decline-time sport on unregistered legs).
    // Fixed 2026-06-25.

    // Extract home/away from PX event
    // Tennis/soccer may use different side labels or just have 2 competitors without home/away
    let homeComp = event.competitors.find(c => c.side === 'home');
    let awayComp = event.competitors.find(c => c.side === 'away');
    // Fallback: use first two competitors if no home/away labels
    if (!homeComp && !awayComp && event.competitors.length >= 2) {
      homeComp = event.competitors[0];
      awayComp = event.competitors[1];
    }
    // Golf OUTRIGHTS (Tournament Winner / Top 5-10-20 / To Make The Cut).
    // These are the reason this branch exists: PX models them as an event with
    // competitors: [] and sub_type "outrights", where EACH MARKET IS ONE PLAYER
    // with YES/NO selections. They therefore die on the !homeComp check below —
    // which is why no golf outright leg has ever been registered or quoted.
    // Registered YES-side only (operator directive): the counterparty takes YES.
    if (golfOutrightsEnabled() && event.sport_name === 'Golf' && event.sub_type === 'outrights') {
      try {
        // Warm the DataGolf boards so the RFQ hot path only does a sync cache
        // read. No-ops inside its TTL, so calling per-event is cheap.
        await dataGolf.warmGolfOutrightBoards();
        const n = await _registerGolfOutrightEvent(event);
        golfTrace.outrightLinesRegistered = (golfTrace.outrightLinesRegistered || 0) + n;
      } catch (err) {
        log.warn('Lines', `Golf outright registration failed for ${event.name}: ${err.message}`);
      }
      continue;
    }

    if (!homeComp || !awayComp) {
      log.debug('Lines', `Skipping ${event.name}: missing competitors`);
      continue;
    }

    // 5. Try to match to Odds API event — try all possible sport keys
    let matchedHome = null, matchedAway = null, matchedOddsEvent = null;

    for (const tryKey of possibleSportKeys) {
      const allOddsTeams = oddsApiEvents
        .filter(e => e.sport === tryKey)
        .flatMap(e => [e.homeTeam, e.awayTeam]);
      const uniqueTeams = [...new Set(allOddsTeams)];

      const tryHome = matchTeamName(homeComp.name, uniqueTeams);
      const tryAway = matchTeamName(awayComp.name, uniqueTeams);

      if (tryHome && tryAway) {
        // Verify this pair exists — use scheduled time for back-to-back/doubleheader matching
        const pxTime = event.scheduled || null;
        const oddsEvt = oddsFeed.getEventMarkets(tryKey, tryHome, tryAway, pxTime)
          || oddsFeed.getEventMarkets(tryKey, tryAway, tryHome, pxTime);
        if (oddsEvt) {
          matchedHome = tryHome;
          matchedAway = tryAway;
          matchedOddsEvent = oddsEvt;
          sportKey = tryKey; // Use the sport key that matched
          break;
        }
      }
    }

    // Second pass: try SharpAPI /events index (broader team name coverage)
    if (!matchedHome || !matchedAway) {
      for (const tryKey of possibleSportKeys) {
        const sharpEvents = oddsFeed.getSharpEvents(tryKey);
        if (!sharpEvents || sharpEvents.length === 0) continue;
        const sharpTeams = [...new Set(sharpEvents.flatMap(e => [e.homeTeam, e.awayTeam]))];
        const tryHome = matchTeamName(homeComp.name, sharpTeams);
        const tryAway = matchTeamName(awayComp.name, sharpTeams);
        if (tryHome && tryAway) {
          // Look up odds using SharpAPI's canonical team names
          const pxTime = event.scheduled || null;
          const oddsEvt = oddsFeed.getEventMarkets(tryKey, tryHome, tryAway, pxTime)
            || oddsFeed.getEventMarkets(tryKey, tryAway, tryHome, pxTime);
          if (oddsEvt) {
            matchedHome = tryHome;
            matchedAway = tryAway;
            matchedOddsEvent = oddsEvt;
            sportKey = tryKey;
            log.debug('Lines', `Matched via events index: ${homeComp.name} → ${tryHome}, ${awayComp.name} → ${tryAway}`);
            break;
          }
        }
      }
    }

    // Series-winner events (NHL-style: a separate PX event named
    // "Series Winner - X vs Y" rather than a sub-market of the game).
    // We price these against the DK scraper cache, not the odds feed,
    // so skip the odds-api match and use competitor names directly.
    const isSeriesEvent = /^\s*series\s*winner\b/i.test(event.name || '');
    // Golf events where our odds cache didn't cover the pair. DataGolf
    // covers individual 1v1 matchups but NOT team pairs (Zurich Classic
    // is the one PGA event per year that's team-format). BetOnline
    // manual-upload cache supplies the fair, and pricer's cascade hits
    // it via lookupZurichMatchupFairProb. Register from PX competitor
    // names directly so the line lives in our index; if pricing still
    // fails at RFQ time, we decline cleanly — no harm done.
    const isGolfEvent = event.sport_name === 'Golf';
    // Near-term fallback registration for team-sport events that failed odds
    // matching. 2026-07-23: five real MLB games (MIN@CLE, KC@DET, ARI@STL,
    // TB@TOR, SD@ATL) sat unregistered ALL DAY — other SPs filled ~$43K on
    // them while every RFQ here declined 'unknown legs'. Root cause: the odds
    // cache intermittently lacks a real game (TOA 429 freq-limit leaves a
    // stale/partial event list), and an unmatched event was simply skipped —
    // permanently dark until the cache happened to heal. For events starting
    // within the next 48h on a supported sport with two real competitors,
    // that's almost certainly a data glitch, not an unpriceable event: so
    // register the lines with PX's own competitor names (matchDeferred).
    // Pricing then works whenever ANY fair source resolves (bulk cache after
    // it heals, alt-line per-event fetch, async event-id resolution); if none
    // does, the RFQ declines 'no fair value' — same net decline as before,
    // but self-healing instead of permanently dark.
    const _schedMs = event.scheduled ? Date.parse(event.scheduled) : NaN;
    const _isNearTerm = Number.isFinite(_schedMs)
      && _schedMs > Date.now()
      && _schedMs - Date.now() < 48 * 60 * 60 * 1000;
    if (!matchedHome || !matchedAway) {
      if (isSeriesEvent) {
        matchedHome = homeComp.name;
        matchedAway = awayComp.name;
      } else if (isGolfEvent) {
        matchedHome = homeComp.name;
        matchedAway = awayComp.name;
        sportKey = 'golf_matchups';
        golfTrace.bypassFired++;
        log.info('Lines', `[golf-debug] Event-level bypass fired: ${event.name} → home="${matchedHome}" away="${matchedAway}" sportKey="${sportKey}"`);
      } else if (_isNearTerm && possibleSportKeys.length === 1 && sportKey && homeComp.name && awayComp.name) {
        // Single-key sports only (baseball_mlb, tennis, mma, boxing): a
        // multi-key sport_name (Basketball → nba/wnba/ncaab, Soccer → many)
        // can't be safely keyed without an odds-cache match, and a wrong key
        // poisons vig-by-sport + dashboards. MLB — the sport that went dark —
        // is single-key.
        matchedHome = homeComp.name;
        matchedAway = awayComp.name;
        log.warn('Lines', `Deferred-match registration: "${event.name}" (${sportKey}, starts ${event.scheduled}) — no odds-cache event matched; registering with PX names so RFQs can price via per-event/alt-line fallbacks instead of going dark`);
        unmatchedEvents.push({
          pxEvent: event.name,
          pxHome: homeComp.name,
          pxAway: awayComp.name,
          deferred: true,
        });
      } else {
        unmatchedEvents.push({
          pxEvent: event.name,
          pxHome: homeComp.name,
          pxAway: awayComp.name,
        });
        continue;
      }
    }

    // Verify this home/away pair exists as an actual Odds API event.
    // Deferred-match events (near-term single-key games the odds cache is
    // missing, registered above with PX names) are exempt — the whole point
    // is to register them WITHOUT an odds-cache event and let RFQ-time
    // fallbacks price them.
    const _isDeferredMatch = _isNearTerm && possibleSportKeys.length === 1
      && !matchedOddsEvent && !isSeriesEvent && !isGolfEvent;
    const pxScheduled = event.scheduled || null;
    const oddsEvent = matchedOddsEvent || oddsFeed.getEventMarkets(sportKey, matchedHome, matchedAway, pxScheduled);
    if (!oddsEvent && !isSeriesEvent && !isGolfEvent && !_isDeferredMatch) {
      const oddsEventReversed = oddsFeed.getEventMarkets(sportKey, matchedAway, matchedHome, pxScheduled);
      if (!oddsEventReversed) {
        unmatchedEvents.push({
          pxEvent: event.name,
          reason: 'Team names matched but no Odds API event found',
          matchedHome,
          matchedAway,
        });
        continue;
      }
      // Swap for correct orientation
      const temp = matchedHome;
      // Note: we'll handle the swap in line indexing below
    }
    if (_isDeferredMatch && !oddsEvent) {
      log.warn('Lines', `Deferred-match registration (post-name-match): "${event.name}" (${sportKey}) — teams resolved but no odds-cache event; registering with deferred pricing fallbacks`);
    }

    // Store event metadata with the FINAL (team-matched) sportKey. Only matched
    // events reach here — unmatched events `continue` above and never enter the
    // index, so getEventInfo returns null (→ 'unknown') for them rather than the
    // wrong basketball_nba default. This is what makes WNBA events resolve to
    // basketball_wnba everywhere downstream (eventSport, decline categories,
    // matched_parlays). (Moved from before the matching loop, 2026-06-25.)
    eventIndex[event.event_id] = {
      name: event.name,
      sport: sportKey,
      sportName: event.sport_name,
      competitors: event.competitors,
      scheduled: event.scheduled,
    };

    // Just-in-time alt-line warm. Fire-and-forget so the per-event fetch
    // overlaps with the markets fetch below instead of waiting up to 15s
    // for the periodic warm loop to pick up this event. The JIT function
    // dedupes via altLinesCache TTL + in-flight map, and throttles via
    // its own concurrency queue, so firing unconditionally per event is
    // safe — already-fresh entries return in O(1) with no API call.
    if (matchedHome && matchedAway && sportKey) {
      oddsFeed.warmEventAltLinesJIT({
        sport: sportKey,
        homeTeam: matchedHome,
        awayTeam: matchedAway,
        commenceTime: pxScheduled,
      }).catch(err => {
        log.debug('Lines', `JIT warm (seed) swallowed error: ${err.message}`);
      });
    }

    // Fetch PX markets
    let markets;
    try {
      markets = await px.fetchMarkets(event.event_id);
    } catch (err) {
      log.error('Lines', `Failed to fetch markets for ${event.name}: ${err.message}`);
      continue;
    }
    if (_isGolfTrace) {
      golfTrace.marketsFound += markets.length;
      if (!golfTrace.sampleMarketName && markets[0]) golfTrace.sampleMarketName = `${markets[0].name} (type=${markets[0].type})`;
    }

    // Filter to FULL-GAME main markets only.
    // Exclude: first half, first quarter, period, inning, player props
    // Exclude: sub-game markets (halves/quarters/periods/innings) and player
    // props. Standalone prop keywords (strikeouts, pitching, milestones, etc.)
    // ensure we reject props even when "Total" appears in the name with
    // intervening words (e.g. "Total Pitching Strikeouts Milestones").
    const excludePatterns = /first quarter|1st quarter|second half|2nd half|2nd quarter|3rd quarter|4th quarter|1st period|2nd period|3rd period|1st inning|2nd inning|3rd inning|overtime|player|milestones|strikeouts?|pitching|batting|hits|doubles\b|triples?|errors|walks|stolen bases?|rbis?|home runs?\b|outs recorded|innings pitched|at bats?|put outs?|fouls|cards|bookings|yellow cards?|red cards?|offsides?|crosses|clearances|throw.?ins?|tackles|shots|total earned|total block|total point[^s]|total rebound|total assist|total steal|total made|total rush|total recei|total passing|1st set|first set|2nd set|second set|set winner|set spread|set total|set moneyline|to win at least|to win without|to win in straight|to win first set|to win the first set|winning margin|will there be a tiebreak|set betting|correct score|race to \d/i;

    const fullGameNames = {
      moneyline: ['Moneyline', 'Moneyline (2 Way)', 'Moneyline (2-Way)', 'Moneyline (Regulation)', 'Draw No Bet'],
      spread: ['Spread', 'Run Line', 'Puck Line', 'Spread (Regular Time)', 'Game Spread', 'Point Spread'],
      total: ['Total', 'Total Points', 'Points', 'Total Runs', 'Total Goals', 'Total Goals (Regular Time)', 'Total Rounds', 'Rounds'],
      team_total: ['Team Total', 'Team Total Points', 'Team Total Runs', 'Team Total Goals', 'Home Total', 'Away Total'],
    };

    // F5 markets (PX uses market.type === 'moneyline'/'spread'/'total' but
    // distinguishes via market.name). Allow these through the filter.
    const f5NamePattern = /1st[-\s]?5th.*inning|first\s*5\s*inning|first\s*five\s*innings/i;
    const h1NamePattern = /first\s*half|1st\s*half/i;

    // Combat sports (MMA, Boxing) historically only had moneyline
    // in our odds feeds. MMA now gets Total Rounds from the DK scraper
    // (services/dk-scraper.fetchMmaFightOdds) merged into the cache —
    // so MMA can register 'total' markets. Boxing still moneyline only.
    const isMmaSport = sportKey === 'mma_mixed_martial_arts';
    const isBoxingSport = sportKey === 'boxing_boxing';
    const isCombatSport = isBoxingSport; // only boxing keeps the ML-only restriction
    // Golf matchups are H2H moneyline only. PX labels the market name
    // "Tournament Matchup" / "Round 1 Matchup" rather than "Moneyline",
    // so the name-allowlist filter below drops them. Flag here so we
    // can bypass the name filter just for this sport without loosening
    // anything else.
    const isGolfSport = sportKey === 'golf_matchups';

    // Series markets (winner/spread/total-games) are priced from the DK
    // scraper cache rather than the odds feed. Allow them through the
    // seed filter when the market name matches. PX uses its standard
    // moneyline/spread/total types for these — we distinguish by name
    // and retag marketType in the per-selection loop below.
    const seriesWinnerNamePat = /\bseries\s*winner\b/i;
    const seriesSpreadNamePat = /\bseries\s*(spread|handicap)\b|\bseries\b[^.]*\bspread\b/i;
    const seriesTotalNamePat  = /\bseries\s*total\b|\btotal\s*games\b|\bseries\b[^.]*\btotal\b/i;

    const mainMarkets = markets.filter(m => {
      const name = m.name || '';
      const isSeriesWinner = seriesWinnerNamePat.test(name);
      const isSeriesSpread = seriesSpreadNamePat.test(name);
      const isSeriesTotal  = !isSeriesSpread && seriesTotalNamePat.test(name);
      const isSeriesMarket = isSeriesWinner || isSeriesSpread || isSeriesTotal;
      const supportedBase = isCombatSport
        ? ['moneyline']
        : isMmaSport
          ? ['moneyline', 'total']
          : isGolfSport
            ? ['moneyline']
            : ['moneyline', 'spread', 'total', 'team_total', 'btts', 'both_teams_to_score', 'double_chance'];
      // Series markets include PX's 'sup_moneyline' type (Series Game Spread,
      // Series Total Games — live probe 2026-04-18). Let those through the
      // supportedBase check; parseMarketSelections retags them to 'spread'
      // or 'total' so selection parsing works.
      const isSupSeries = m.type === 'sup_moneyline' && (isSeriesSpread || isSeriesTotal);
      // Soccer asian-handicap spreads use type='sup_moneyline' with
      // name "Spread (Regular Time)". Verified 2026-05-03: every EPL,
      // UCL, La Liga, Serie A, Bundesliga, etc. spread market on PX
      // rides this combo. Without this carve-out, supportedBase gate
      // rejects every soccer spread → zero spread lines for sub-leagues
      // like EPL/UCL despite ML/total working fine. parseMarketSelections
      // retags marketType='spread' for these so downstream lookup works.
      const isSoccerSupSpread = m.type === 'sup_moneyline'
        && !isSeriesMarket
        && /soccer|fifa/i.test(sportKey || '')
        && /^spread\b/i.test(m.name || '');
      // "To Advance To The Next Round" — knockout qualification, also
      // type='sup_moneyline'. Same carve-out shape as the asian-handicap spread
      // above. Priced off our EXISTING DNB fair, which is not an approximation:
      // in a knockout, advancing == winning incl. ET/pens, so
      //   P(adv) = w + d*[w/(w+a)] = w*(w+a+d)/(w+a) = w/(w+a) = DNB   (since w+a+d=1)
      // PX's own book confirms it — Moneyline (2 Way) ENG -117/ARG +116 vs
      // To Advance ENG -118/ARG +115, one tick apart (verified 2026-07-15).
      const isSoccerAdvance = m.type === 'sup_moneyline'
        && !isSeriesMarket
        && /soccer|fifa/i.test(sportKey || '')
        && ADVANCE_MARKET_RE.test(m.name || '');
      // "Both Teams To Score" — PX types it 'moneyline', so it clears
      // supportedBase but would then die on the fullGameNames allowlist for
      // 'moneyline' (it isn't named like a moneyline). Full-game market, so
      // bypass that name check the same way advance does.
      const isSoccerBtts = /soccer|fifa/i.test(sportKey || '')
        && m.type === 'moneyline'
        && BTTS_MARKET_RE.test(name)
        && !BTTS_PERIOD_RE.test(name);
      // MMA method-of-victory — full-fight market, same bypass shape as BTTS.
      const isMmaMov = isMmaSport && m.type === 'moneyline' && MOV_MARKET_RE.test(name);
      if (!isSupSeries && !isSoccerSupSpread && !isSoccerAdvance && !supportedBase.includes(m.type) && !F5_MARKET_TYPES.includes(m.type) && !FIRST_HALF_MARKET_TYPES.includes(m.type)) return false;
      // Advance bypasses the sub-game/prop name filter below ("Next Round"
      // would otherwise look prop-ish) — it is a full-event market.
      if (isSoccerAdvance) return true;
      if (isSoccerBtts) return true;
      if (isMmaMov) return true;
      // Series markets bypass the sub-game/prop filter and the name-
      // allowlist + bounds checks. Each variant must match one of:
      //   Series Winner      → type='moneyline'
      //   Series Spread      → type='spread' OR 'sup_moneyline'
      //   Series Total Games → type='total'   OR 'sup_moneyline'
      if (isSeriesMarket) {
        if (isSeriesWinner && m.type === 'moneyline') return true;
        if (isSeriesSpread && (m.type === 'spread' || m.type === 'sup_moneyline')) return true;
        if (isSeriesTotal  && (m.type === 'total'  || m.type === 'sup_moneyline')) return true;
        return false;
      }
      // Exclude anything matching half/quarter/prop patterns
      // TENNIS SETS carve-out, KILL-SWITCHED OFF BY DEFAULT.
      // excludePatterns deliberately rejects "1st set", "set moneyline" and
      // "to win at least", which is what has kept PX's four Sets markets
      // unregistered. When config.pricing.tennisSetsEnabled is on we admit
      // exactly three market NAMES — anchored, so "2nd Set Moneyline",
      // "Set Betting", "Correct Score" and every other set derivative stay
      // excluded (we have no source for them). Shipped dark on the golf-
      // outrights pattern: the source, parsing and same-match block are all in
      // place, but nothing registers until the flag is flipped.
      const isTennisSetsMarket = (sportKey === 'tennis')
        && config.pricing.tennisSetsEnabled
        && (/^(?:1st|first)\s+set\s+moneyline\s*$/i.test(m.name || '')
          || /^set\s*1\s+moneyline\s*$/i.test(m.name || '')
          || /^total\s+sets\s*$/i.test(m.name || '')
          || /\bto\s+win\s+at\s+least\s+(?:one|1)\s+set\s*$/i.test(m.name || ''));
      // ⚠ FOOTBALL 1st QUARTER is deliberately still excluded here. TOA does
      // serve h2h_q1 (and services/nfl-consensus sources it), so the fair value
      // is available — but PX types "1st Quarter Moneyline" as plain
      // `moneyline`, "1st Quarter Spread" as `spread` and "1st Quarter Total
      // Points" as `total` (probe 2026-08-21, Jets @ Steelers). That is the
      // BTTS/MoV trap: relaxing this line alone would let a Q1 leg parse as a
      // FULL-GAME leg and be priced off the full-game line. Q1 needs a
      // name-based retag in parseMarketSelections to first_quarter_* FIRST;
      // only then is admitting it here safe.
      if (!isTennisSetsMarket && excludePatterns.test(m.name)) return false;
      // Allow F5 markets by name pattern
      const isF5 = f5NamePattern.test(m.name || '');
      const isH1 = h1NamePattern.test(m.name || '') || FIRST_HALF_MARKET_TYPES.includes(m.type);
      // Name filter: previously required EXACT match against a fixed whitelist
      // which rejected alt-line markets like "Alternate Spread +3.5" — costing
      // us thousands of unknown-leg declines per day. Relaxed to substring
      // match: the market name must CONTAIN one of the canonical full-game
      // names (e.g. "Alternate Spread" contains "Spread"). Player props still
      // fail because their names don't contain "Spread", "Moneyline", etc.
      // Additional safety comes from excludePatterns (above) and sport-aware
      // line bounds (below).
      // Golf markets on PX use names like "Tournament Matchup" or
      // "Round 1 Matchup" — none contain "Moneyline". Since the sport
      // is already gated to moneyline-only via supportedBase above,
      // no further name check is needed for golf.
      if (!isF5 && !isH1 && !isGolfSport && !isTennisSetsMarket) {
        // Set markets are exempt: "<Player> To Win At Least One Set" is PX
        // type 'moneyline' but contains none of the canonical moneyline names,
        // so the substring allowlist rejects it. isTennisSetsMarket is already
        // an anchored whitelist of exactly three market names, so it is a
        // tighter gate than this one, not a looser one.
        const allowed = fullGameNames[m.type];
        if (allowed) {
          const nameL = (m.name || '').toLowerCase();
          const matches = allowed.some(a => nameL.includes(a.toLowerCase()));
          if (!matches) return false;
        }
      }
      // Exclude sub-game totals/spreads and prop markets via sport-aware bounds.
      // F5 markets bypass (MLB F5 totals are ~4-5, spreads ~1.5).
      //
      // IMPORTANT: PX bundles alt lines inside market.market_lines, so a
      // single spread market can contain lines from ±0.5 to ±6.5. Previously
      // this check read parsed[0].line and rejected the entire market if
      // THAT one happened to be out of bounds — silently losing all the
      // reasonable alt lines bundled in the same market. Fixed: accept the
      // market if ANY selection has a line inside the sport's bounds. The
      // individual selection-level bound check (below, inside the
      // registration loop) filters out the out-of-range alt lines one-by-one.
      //
      // Use parsed sel.marketType (not raw m.type) so team_total markets
      // (which PX types as 'total' but parser upgrades to 'team_total') get
      // the correct permissive bounds.
      if ((m.type === 'total' || m.type === 'spread') && !isF5 && !isH1) {
        const parsed = px.parseMarketSelections(m);
        if (parsed.length === 0) return false;
        const anyInBounds = parsed.some(p => isValidFullGameLine(sportKey, p.marketType || m.type, p.line));
        if (!anyInBounds) {
          log.debug('Lines', `Rejecting ${m.type} market (no lines in bounds) for ${sportKey}: ${m.name}`);
          return false;
        }
      }
      return true;
    });

    for (const market of mainMarkets) {
      // Detect PX 3-way moneyline sub-markets like "Arsenal Football Club To Win
      // (90 Min)" which are yes/no propositions on a 3-way outcome. We don't
      // currently support quoting these — skip them entirely so they don't leak
      // into the moneyline path where they'd be mispriced as 2-way team bets.
      // The regular 2-way market is "Moneyline (2 Way)" with team selections.
      if (market.type === 'moneyline' && /\bto win\b.*\(.*min.*\)|^draw\s*\(.*min.*\)/i.test(market.name || '')) {
        log.debug('Lines', `Skipping PX 3-way sub-market at seed: ${market.name}`);
        continue;
      }
      // K-prop seed branch — MLB pitcher_strikeouts. PX tags these as
      // type='total' with the player name embedded in market.name (e.g.
      // "Cole Ragans Total Pitching Strikeouts"). Process them BEFORE the
      // standard total path so K-prop lines (4.5–8.5) don't get filtered
      // by the MLB game-total bounds check (which expects 5-15 for game
      // totals), and so they register with marketType='player_strikeouts'
      // instead of 'total'. Sync SharpAPI lookup only — TOA escalation
      // happens via the on-demand resolveUnknownLine path for any K-prop
      // RFQ lineId we miss here. Pre-seeding moves visible K-prop coverage
      // from "only previously RFQ'd" (~23) to "every K-prop SharpAPI knows
      // about" (~60+) so the Lines tab reflects actual quotability.
      if (sportKey === 'baseball_mlb' && market.type === 'total' && isPitcherStrikeoutMarket(market.name || '')) {
        const playerName = extractPitcherNameFromKMarket(market.name);
        if (!playerName) {
          log.debug('Lines', `K-prop seed: name extract failed for "${market.name}"`);
          continue;
        }
        const eventCtx = { homeTeam: matchedHome, awayTeam: matchedAway, startTime: event.scheduled || null };
        const parsedK = px.parseMarketSelections(market);
        let registered = 0;
        // Confidence gate: ≥2 books with both sides, OR 1 trusted book.
        // Same shape as resolveUnknownLine.
        const trustedSet = (config.pricing && config.pricing.propTrustedSingleBooks) || [];
        const usableFair = (l) => l && l.fairProbOver != null && l.fairProbUnder != null;
        const isHighConfidence = (l) => {
          if (!usableFair(l)) return false;
          const both = l.booksWithBothSides || 0;
          if (both >= 2) return true;
          const books = l.books || [];
          return both === 1 && books.some(b => trustedSet.includes(String(b).toLowerCase()));
        };
        for (const sel of parsedK) {
          totalLines++;
          // TOA-primary: operator's Hobby SharpAPI tier has limited K-prop
          // coverage (DK + FD only), so most pitchers fail the ≥2-book gate
          // and don't register at seed time. TOA's market data has 4-8
          // books per K-prop line and registers far more pitchers up-front.
          // SharpAPI stays as a fallback for the rare case TOA misses.
          let lookup = await oddsFeed.lookupPlayerStrikeoutPropFromTheOddsApi(
            sportKey, eventCtx, playerName, sel.line,
          );
          let propSource = 'theoddsapi';
          if (!isHighConfidence(lookup)) {
            const sharp = oddsFeed.lookupPlayerStrikeoutProp(sportKey, eventCtx, playerName, sel.line);
            if (isHighConfidence(sharp)) {
              lookup = sharp;
              propSource = 'sharpapi';
            } else if (usableFair(sharp) && !usableFair(lookup)) {
              // Both sub-threshold — prefer the one that at least has fairs.
              lookup = sharp;
              propSource = 'sharpapi';
            }
          }
          if (!isHighConfidence(lookup)) continue;
          const fairProb = sel.selection === 'over' ? lookup.fairProbOver : lookup.fairProbUnder;
          const info = _setSeedLine(sel.lineId, {
            sport: sportKey,
            pxEventId: event.event_id,
            pxEventName: event.name,
            marketType: 'player_strikeouts',
            marketName: market.name,
            selection: sel.selection,
            teamName: playerName, // dashboards display "team" — use pitcher name
            line: sel.line,
            homeTeam: matchedHome,
            awayTeam: matchedAway,
            oddsApiSport: sportKey,
            oddsApiMarket: 'player_strikeouts',
            oddsApiSelection: sel.selection,
            startTime: event.scheduled || null,
            playerName,
            fairProb,
            fairProbOver: lookup.fairProbOver,
            fairProbUnder: lookup.fairProbUnder,
            booksWithBothSides: lookup.booksWithBothSides,
            propBooks: lookup.books,
            propSource,
            propFetchedAt: lookup.fetchedAt || Date.now(),
          });
          _trackPrimaryForIndex(info);
          matchedLines++;
          registered++;
        }
        if (registered > 0) {
          log.debug('Lines', `K-prop seed: ${playerName} registered ${registered} lines`);
        }
        continue; // K-prop market done — skip standard processing
      }
      // "To Advance To The Next Round" needs its own parser: px's returns 0
      // selections for it (outcomes are bare abbreviations "ENG"/"ARG" with no
      // competitor_id, not team-named like a normal moneyline).
      const _isAdvanceMkt = market.type === 'sup_moneyline'
        && /soccer|fifa/i.test(sportKey || '')
        && ADVANCE_MARKET_RE.test(market.name || '');
      const parsed = _isAdvanceMkt
        ? _parseAdvanceSelections(market, homeComp, awayComp)
        : px.parseMarketSelections(market);
      if (_isAdvanceMkt) {
        log.info('Lines', `Advance market "${market.name}" (${event.name}) → ${parsed.length} selections`);
      }
      if (isGolfSport) {
        log.info('Lines', `[golf-debug] Parsed market "${market.name}" type=${market.type} → ${parsed.length} selections`);
        golfTrace.marketsPassedFilter++;
        golfTrace.selectionsParsed += parsed.length;
        if (!golfTrace.sampleSelectionTeam && parsed[0]) golfTrace.sampleSelectionTeam = parsed[0].teamName;
      }
      // Detect 2-way / Draw No Bet soccer moneylines.
      // PX labels the 2-way soccer ML market as "Moneyline (2 Way)".
      // Also catch explicit "Draw No Bet" / "DNB" / "Moneyline 2W" variants.
      // Advance is draw-no-bet BY CONSTRUCTION (P(adv) = w/(w+a)), so flag it
      // too — otherwise the pricer would compare our 2-way offer against a
      // 3-way book fair and the leg would price ~35% low.
      const isDNB = (market.type === 'moneyline' && /\b2\s*[\s\-_]?way\b|draw\s*no\s*bet|\bdnb\b|\b2w\b/i.test(market.name || ''))
        || (market.type === 'sup_moneyline' && ADVANCE_MARKET_RE.test(market.name || ''));
      const mName = market.name || '';
      const isSeriesWinnerMarket = seriesWinnerNamePat.test(mName);
      const isSeriesSpreadMarket = seriesSpreadNamePat.test(mName);
      const isSeriesTotalMarket  = !isSeriesSpreadMarket && seriesTotalNamePat.test(mName);
      const isSeriesMarket = isSeriesWinnerMarket || isSeriesSpreadMarket || isSeriesTotalMarket;

      for (const sel of parsed) {
        totalLines++;
        // Tag series selections so downstream (pricer) routes them to
        // the DK scraper cache instead of oddsFeed. Series markets are
        // structurally identical to moneyline/spread/total but we use a
        // distinct marketType so the pricer takes the DK path.
        if (isSeriesWinnerMarket && sel.marketType === 'moneyline') {
          sel.marketType = 'series_winner';
        } else if (isSeriesSpreadMarket && sel.marketType === 'spread') {
          sel.marketType = 'series_spread';
        } else if (isSeriesTotalMarket && sel.marketType === 'total' && sportKey !== 'tennis') {
          // Tennis "Total Games" markets match seriesTotalNamePat but
          // they are MATCH-LEVEL totals (over/under games in the match),
          // not playoff series totals. Keep them as marketType 'total'
          // so they route to the standard totals-cache lookup path
          // (TOA caches as 'totals'). Without this carve-out, tennis
          // total-games legs get registered as series_total and look
          // for fair probs in a cache key (series_total) that doesn't
          // exist for tennis — every line returns null fair.
          sel.marketType = 'series_total';
        }

        // Per-selection bounds check for spread/total/team_total alt lines.
        // The market-level filter above accepts the market if ANY selection
        // is in bounds; this check rejects the individual out-of-range ones
        // (e.g. Rangers -6.5 puck line) while keeping sibling in-range
        // alts registered. team_total uses permissive bounds (see
        // isValidFullGameLine) since their lines are naturally low.
        // Series markets bypass entirely — series spread lines (±1.5, ±2.5
        // games) are valid by definition, and series totals (5.5-7.5 games)
        // fall far below full-game total bounds but are also valid.
        const selMarketType = ['spread', 'total', 'team_total'].includes(sel.marketType) ? sel.marketType : null;
        if (selMarketType && !isSeriesMarket && !isValidFullGameLine(sportKey, selMarketType, sel.line)) {
          continue;
        }

        // Determine Odds API selection mapping
        let oddsApiSelection = null;
        let oddsApiMarket = MARKET_TYPE_MAP[sel.marketType];

        if (sel.marketType === 'series_winner') {
          // Series-winner: same team→home/away mapping as moneyline.
          // Team names in PX selections sometimes carry a "(Series)"
          // suffix (e.g. "Cleveland Cavaliers (Series)"); strip it
          // before matching. Keep the suffix on the stored teamName
          // so the pricer can recognize the leg type via name, too.
          const cleanTeam = (sel.teamName || '').replace(/\s*\(series\)\s*/ig, '').trim();
          if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'home') {
            oddsApiSelection = 'home';
          } else if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'away') {
            oddsApiSelection = 'away';
          }
          // series_winner has no oddsApiMarket (not in MARKET_TYPE_MAP);
          // set a sentinel so the !oddsApiMarket gate below doesn't
          // reject it. Pricer skips oddsFeed for this marketType.
          oddsApiMarket = 'series_winner';
        } else if (sel.marketType === 'series_spread') {
          // Series-spread: team→home/away plus a signed line (PX stores
          // negative for favorite, positive for underdog). Pricer uses
          // teamName + line sign to query the DK scraper cache.
          const cleanTeam = (sel.teamName || '').replace(/\s*\(series\)\s*/ig, '').trim();
          if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
          else if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
          oddsApiMarket = 'series_spread';
        } else if (sel.marketType === 'series_total') {
          // Series-total: over/under on total games played in the series.
          // Pricer uses home+away team names (from lineInfo) + line +
          // over/under to query DK.
          oddsApiSelection = sel.selection; // 'over' or 'under'
          oddsApiMarket = 'series_total';
        } else if (sel.marketType === 'advance') {
          // "To Advance To The Next Round". _parseAdvanceSelections already
          // resolved each side to 'home'/'away' against the event competitors
          // (PX names these selections by ABBREVIATION — "ENG"/"ARG" — with no
          // competitor_id, so the moneyline branch's matchTeamName cannot do
          // it). Without this branch oddsApiSelection stays null and every
          // advance selection is silently dropped by the gate below.
          // oddsApiMarket is already 'h2h' via MARKET_TYPE_MAP; combined with
          // isDNB the pricer renormalises the 3-way to 2-way, which IS
          // P(advance).
          oddsApiSelection = sel.selection; // 'home' | 'away'
        } else if (sel.marketType === 'moneyline') {
          // Reject YES/NO selections — these are PX-tagged 'moneyline' but
          // are actually yes/no prop markets ("Player To Win At Least One
          // Set", etc.). matchTeamName's substring fallback would treat
          // 'NO' as a partial match for any opponent containing 'no' in
          // their name (Mannarino, Brunson, Hovland, etc.), silently
          // registering a worthless YES/NO prop as a moneyline leg.
          if (/^(yes|no)$/i.test((sel.teamName || '').trim())) continue;
          // Match team to home/away
          if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
            oddsApiSelection = 'home';
          } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
            oddsApiSelection = 'away';
          }
        } else if (sel.marketType === 'spread') {
          // Match by team name against home and away explicitly. Do NOT fall
          // back to guessing — previously a loose substring check on the last
          // word of home team name would misclassify e.g. "AS Monaco FC" as
          // home of "Paris FC" (because both contain 'FC'), causing us to
          // price the WRONG team's spread. If neither side matches, leave
          // selection null so the leg is rejected as unresolvable.
          if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
            oddsApiSelection = 'home';
          } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
            oddsApiSelection = 'away';
          }
        } else if (sel.marketType === 'total') {
          oddsApiSelection = sel.selection; // 'over' or 'under'
        } else if (sel.marketType === 'team_total') {
          // Determine home/away from team hint extracted from market name.
          // parseMarketSelections populates sel.teamName with the parsed
          // prefix (e.g. "SJ" from "SJ: Team Total Goals") — not the
          // selection's over/under text. resolveTeamTotalSide handles
          // exact, substring, initials, and first-N-char matching.
          const teamSide = resolveTeamTotalSide(sel.teamName, matchedHome, matchedAway);
          if (!teamSide) continue; // Skip if we can't determine the side
          oddsApiSelection = teamSide + '_' + (sel.selection || 'over'); // "home_over", "away_under", etc.
        } else if (sel.marketType === 'btts' || sel.marketType === 'both_teams_to_score') {
          // Yes/No selection from parseMarketSelections
          oddsApiSelection = (sel.selection || '').toLowerCase();
        } else if (MOV_MARKET_TYPES.includes(sel.marketType)) {
          // Method of victory — YES/NO on a per-fighter market. The fighter is
          // in sel.playerName (parsed from the market NAME; the selections are
          // just YES/NO). Do NOT run team matching here: matching the fighter
          // to a competitor would resolve to home/away and the pricer would
          // then read the leg as a straight moneyline.
          oddsApiSelection = (sel.selection || '').toLowerCase();
        } else if (sel.marketType === 'first_set_moneyline') {
          // Two-competitor market: resolve to home/away like any moneyline.
          if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
          else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
        } else if (sel.marketType === 'total_sets') {
          oddsApiSelection = sel.selection;              // 'over' | 'under'
        } else if (sel.marketType === 'set_win_at_least_one') {
          // YES/NO on a per-PLAYER market — the player is in sel.playerName,
          // parsed from the market NAME (selections are literally YES/NO).
          // Resolve which SIDE of the match that player is, so the pricer can
          // read the right half of the set_win_at_least_one market. Same trap
          // as MoV: do NOT let the YES/NO text reach team matching.
          const who = sel.playerName || sel.teamName;
          if (resolveHomeAwaySide(who, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home_' + (sel.selection || '');
          else if (resolveHomeAwaySide(who, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away_' + (sel.selection || '');
        } else if (sel.marketType === 'double_chance') {
          // '1X', 'X2', or '12' selection
          oddsApiSelection = sel.selection;
        } else if (F5_MARKET_TYPES.includes(sel.marketType)) {
          // First 5 Innings — same selection logic as full-game for h2h/spreads/totals
          if (sel.marketType.includes('moneyline')) {
            if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
            else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
          } else if (sel.marketType.includes('run_line')) {
            // Explicit home/away match only — no substring fallback.
            if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
              oddsApiSelection = 'home';
            } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
              oddsApiSelection = 'away';
            }
          } else if (sel.marketType.includes('total')) {
            oddsApiSelection = sel.selection; // 'over' or 'under'
          }
        } else if (FIRST_HALF_MARKET_TYPES.includes(sel.marketType)) {
          // First Half (NBA) — same selection logic as full-game for h2h/spreads/totals
          if (sel.marketType.includes('moneyline')) {
            if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
            else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
          } else if (sel.marketType.includes('spread')) {
            if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
              oddsApiSelection = 'home';
            } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
              oddsApiSelection = 'away';
            }
          } else if (sel.marketType.includes('total')) {
            oddsApiSelection = sel.selection; // 'over' or 'under'
          }
        }

        if (!oddsApiSelection || !oddsApiMarket) {
          if (isGolfSport) {
            log.warn('Lines', `[golf-debug] Skipping selection: team="${sel.teamName}" market=${sel.marketType} oddsApiSelection=${oddsApiSelection} oddsApiMarket=${oddsApiMarket}`);
            golfTrace.selectionsSkipped++;
          }
          continue;
        }

        // Register line — fair value check happens at RFQ pricing time
        // For moneylines, verify fair value exists now
        // For spreads/totals, register all alternate lines (fair value available for primary line)
        matchedLines++;
        // Get event start time — PX's event.scheduled is authoritative (PX owns
        // the game clock for the games we're quoting on). SharpAPI's
        // event_start_time is unreliable for games that haven't loaded yet —
        // it defaults to midnight UTC which is 8pm ET the PREVIOUS day, causing
        // false "event started" declines all day until SharpAPI loads real
        // tip-off times. Fall back to odds cache only if PX has no scheduled.
        // Golf matchups: parse the round from the PX event name
        // ("R1 RBC Heritage" → round 1; no R-prefix → tournament). Use
        // the round-aware cache accessor so we price a round RFQ against
        // round odds, not against the tournament-long h2h.
        let oddsEvt;
        let golfRoundNum = null;
        let golfMatchupType = null;
        if (sportKey === 'golf_matchups') {
          const nameRoundMatch = /\bR(?:ound\s*)?([1-4])\b/i.exec(event.name || '');
          golfRoundNum = nameRoundMatch ? parseInt(nameRoundMatch[1], 10) : null;
          golfMatchupType = golfRoundNum ? 'round' : 'tournament';
          oddsEvt = oddsFeed.getGolfMatchupEvent(matchedHome, matchedAway, golfRoundNum);
          // If the round-specific lookup failed but a tournament entry
          // exists (or vice versa), don't silently fall through to the
          // wrong-type entry. Leave oddsEvt null so the line is skipped.
        } else {
          oddsEvt = oddsFeed.getEventMarkets(sportKey, matchedHome, matchedAway, pxScheduled);
        }
        const startTime = event.scheduled || oddsEvt?.commenceTime || null;

        // Tennis spread/total lines only register when the matched odds event
        // actually CARRIES that market. When TOA has an active tournament it
        // serves h2h+spreads+totals and everything registers as before — but
        // in TOA's off-weeks tennis is DK-merged MONEYLINE-ONLY
        // (mergeDkTennisMatches), and registering spread/total lines with no
        // odds behind them means lines PX advertises that we decline 100% of
        // the time — exactly the supported-lines-sync compliance violation
        // (PX Rule 2) the 5b33e36 work closed. Fail closed at registration.
        if (sportKey === 'tennis'
            && (oddsApiMarket === 'spreads' || oddsApiMarket === 'totals')
            && !(oddsEvt && oddsEvt.markets && oddsEvt.markets[oddsApiMarket])) {
          continue;
        }

        // Football (NFL/preseason/NCAAF/CFL) — T1.8, same PX Rule 2 posture
        // as the tennis guard above but for EVERY market key: PX posts 14+
        // markets per football event (1Q/1H/2H, both team totals, ...) while
        // our consensus sources cover full-game h2h/spreads/totals only —
        // the measured priceable slice is ~10 of ~50 line_ids. Registering
        // the rest advertises lines we then decline 100% of the time. Fail
        // closed at registration: a football line registers ONLY when the
        // matched odds event carries the exact odds-feed market key it
        // would price against. Team totals / H1 self-heal the moment their
        // supplement lands in the cache (markets.team_totals / markets.
        // h2h_h1 appear → next seed registers them); full-game ml/spread/
        // total with odds coverage register exactly as before.
        if (sportKey.startsWith('americanfootball')
            && !(oddsEvt && oddsEvt.markets && oddsEvt.markets[oddsApiMarket])) {
          continue;
        }

        if (isGolfSport) golfTrace.linesRegistered++;
        const info = _setSeedLine(sel.lineId, {
          sport: sportKey,
          pxEventId: event.event_id,
          pxEventName: event.name,
          marketType: sel.marketType,
          marketName: market.name,
          isDNB,
          selection: oddsApiSelection,
          teamName: resolveDisplayTeamName(sel, matchedHome, matchedAway),
          // Carried for markets whose subject is a PERSON parsed out of the
          // market NAME rather than a competitor — currently MoV ("<Fighter>
          // To Win By KO/TKO/DQ"). ufc-mov keys the fair on it. Undefined for
          // every other market type, which is harmless.
          playerName: sel.playerName || null,
          line: sel.line,
          homeTeam: matchedHome,
          awayTeam: matchedAway,
          oddsApiSport: sportKey,
          oddsApiMarket,
          oddsApiSelection,
          competitorId: sel.competitorId,
          startTime,
          // Golf-specific metadata from DataGolf (tournament name, round).
          // Undefined for non-golf sports — harmless to always copy.
          tournamentName: oddsEvt?.eventName || null,
          roundNum: golfRoundNum ?? oddsEvt?.roundNum ?? null,
          matchupType: golfMatchupType ?? oddsEvt?.matchupType ?? null,
        });
        _trackPrimaryForIndex(info);
      }
    }

    // ----- PRE-SEED PLAYER PROPS -----
    // PX returns prop markets in fetchMarkets, but the mainMarkets filter
    // above excludes them (gametype only). Without pre-seed, props only
    // register via resolveUnknownLine when bettors RFQ specific players —
    // and most RFQs decline as "unknown legs" before that bridge fires
    // (we caught 106K such declines/day). Pre-seeding mirrors the
    // on-demand bridge at seed time so all eligible props live in the
    // index from boot, converting unknown-legs declines into real
    // priced/declined-with-fair-prob outcomes.
    //
    // Cost: ~1 TOA per-event-per-market call per refresh cycle on top of
    // the existing fetch — within Hobby quota at typical volume. Each
    // call's response is cached so multi-player markets only fetch once.
    try {
      const propAllowlist = (config.pricing && config.pricing.propLaunchAllowlist) || new Set();
      if (propAllowlist.size > 0 && (matchedHome && matchedAway)) {
        const ws = _getWsModule();
        const minBooks = (config.pricing && config.pricing.propMinBooksWithBothSides) || 3;
        const trustedSet = (config.pricing && config.pricing.propTrustedSingleBooks) || [];
        for (const market of markets) {
          if (!market || !market.name) continue;
          let propType = null;
          let toaMarketKey = null;
          // Soccer props need extra context the other sports don't: the
          // classifier-derived TOA line (PX posts them lineless as YES/NO)
          // and the dedicated TOA sport key for lookups.
          let soccerProp = null;
          // Football anytime-TD props share the soccer lineless YES/NO shape
          // but keep their own ctx variable: they source under their OWN
          // sport key (no _soccerPropToaSport remap) and must never take the
          // DK soccer/MLB scraper fallbacks.
          let footballProp = null;
          if (ws) {
            if (sportKey.includes('basketball')) {
              propType = ws._classifyNbaProp(market.name);
              toaMarketKey = _NBA_PROP_TO_TOA_MARKET[propType];
            } else if (sportKey.includes('hockey')) {
              propType = ws._classifyNhlProp(market.name);
              toaMarketKey = _NHL_PROP_TO_TOA_MARKET[propType];
            } else if (sportKey === 'baseball_mlb') {
              propType = ws._classifyMlbProp(market.name);
              toaMarketKey = _MLB_PROP_TO_TOA_MARKET[propType];
            } else if (sportKey === 'soccer' || sportKey.startsWith('soccer_')) {
              soccerProp = _classifySoccerProp(market.name);
              if (soccerProp) {
                propType = soccerProp.propType;
                toaMarketKey = _SOCCER_PROP_TO_TOA_MARKET[propType];
              }
            } else if (sportKey.startsWith('americanfootball')) {
              // Keep in lockstep with the on-demand router branch in
              // resolveUnknownLine. typeof-guarded: fail closed (no football
              // props) if the websocket classifier hasn't landed.
              propType = (typeof ws._classifyFootballProp === 'function')
                ? ws._classifyFootballProp(market.name) : null;
              footballProp = _footballPropCtx(propType);
              toaMarketKey = footballProp ? _FOOTBALL_PROP_TO_TOA_MARKET[propType] : null;
            }
          }
          if (!propType || !toaMarketKey) continue;
          // Registration-safety assertion: a football prop line may never
          // carry a full-game marketType (fails closed, logged — see
          // _footballPropRegistrationSafe).
          if (sportKey.startsWith('americanfootball')
              && !_footballPropRegistrationSafe(_propMarketType(propType))) {
            log.error('Lines', `Football prop assertion: refusing to register "${market.name}" — marketType '${_propMarketType(propType)}' is not a safe player_* type`);
            continue;
          }
          if (!propAllowlist.has(sportKey + '.' + propType)) continue;
          const playerName = ws ? ws._extractPlayerNameFromPropMarket(market.name) : null;
          if (!playerName) continue;

          // Parse PX selections (over + under for this player at the line).
          let parsedProp = [];
          try { parsedProp = px.parseMarketSelections(market) || []; } catch { continue; }
          if (parsedProp.length === 0) continue;

          // Soccer + football props post as YES/NO with no line on PX.
          // Register the YES side only, mapped to over at the classifier-
          // derived line (anytime = 0.5, "At Least 2 SoT" = 1.5). The NO
          // side of a one-sided vigged market is +EV for the bettor by
          // construction — leave those line_ids unknown so they decline.
          // Null-safe on the ctx line: a lineless anytime market defaults
          // to 0.5 so the byLine grouping below can never silently drop it.
          const linelessProp = soccerProp || footballProp;
          if (linelessProp) {
            parsedProp = parsedProp
              .filter(s => String(s.outcomeName || s.teamName || '').toUpperCase() === 'YES')
              .map(s => Object.assign({}, s, { selection: 'over', line: (linelessProp.line != null ? linelessProp.line : 0.5) }));
            if (parsedProp.length === 0) continue;
          }

          // Group selections by line value. Each distinct line gets its
          // OWN TOA lookup + DK-scraper fallback + minBooks gate so the
          // per-line fair probabilities are correct.
          //
          // Why this matters: PX bundles every alt line for a player's
          // prop into ONE market (e.g. Mike Trout Total Bases contains
          // 0.5, 1.5, and 2.5 over/under selections). Previously a single
          // `sampleLine` was used for one TOA lookup and the resulting
          // fairProbOver / fairProbUnder were propagated to every alt —
          // so quotes on Trout's 1.5 Under inherited the 0.5-line fair
          // (~0.43) when the true 1.5-line fair was ~0.64. Bettors
          // exploited the 20+ pp delta. Audit found the same pattern
          // across NBA points / rebounds / assists. Fix is one-and-the-
          // same: lookup per line, register per line. (Fixed 2026-05-11.)
          //
          // Cost is bounded: TOA prop odds are cached per (sport, event,
          // market) so N distinct lines on the same market = 1 HTTP +
          // N de-vig passes. The same applies to DK scraper hits.
          const byLine = new Map();
          for (const sel of parsedProp) {
            if (!sel.lineId) continue;
            if (sel.selection !== 'over' && sel.selection !== 'under') continue;
            if (sel.line == null) continue;
            if (!byLine.has(sel.line)) byLine.set(sel.line, []);
            byLine.get(sel.line).push(sel);
          }

          for (const [thisLine, sels] of byLine) {
            // Soccer/football anytime markets must query TOA with line=null
            // (their outcomes carry no point); SoT queries its real point.
            const toaQueryLine = linelessProp ? linelessProp.toaLine : thisLine;
            let lookup = null;
            try {
              lookup = await oddsFeed.lookupTheOddsApiPlayerProp(
                soccerProp ? _soccerPropToaSport(sportKey) : sportKey, toaMarketKey,
                { homeTeam: matchedHome, awayTeam: matchedAway, startTime: event.scheduled || null },
                playerName, toaQueryLine,
              );
            } catch (err) {
              log.debug('Lines', `Pre-seed prop lookup error for ${playerName} ${propType} ${thisLine}: ${err.message}`);
              // Fall through to DK scraper — don't continue here
            }

            // DK scraper fallback: when TOA returns no/insufficient data,
            // hit the DK player-prop scraper cache. Operator directive
            // 2026-05-03: every prop type in the allowlist must have a
            // scraper backstop. Same pattern as the MLB F5 DK scraper —
            // single-book DK is treated as authoritative for the prop
            // since DK's player-prop coverage is the broadest in the
            // industry. The DK scraper IS lazy-loaded the first time —
            // first call per refresh cycle takes ~20-30s but every
            // subsequent prop in the same cycle reuses the cached scrape.
            // Fallback is scoped to THIS specific line value.
            const toaInsufficient = !lookup
              || lookup.fairProbOver == null
              || lookup.fairProbUnder == null
              || ((lookup.booksWithBothSides || 0) < minBooks
                  && !((lookup.books || []).some(b => trustedSet.includes(String(b).toLowerCase()))));
            // Soccer + football skip the DK pair-scraper fallback — there's
            // no DK soccer/football prop scrape config, and these markets
            // are one-sided anyway (handled by the TOA one-sided path
            // below). For football this also keeps a Puppeteer scrape off
            // the seed path.
            if (toaInsufficient && !soccerProp && !footballProp) {
              try {
                const dk = require('./dk-scraper');
                if (typeof dk.fetchDkPlayerProps === 'function') {
                  // Fire-and-await: we want the data this cycle. The 15-min
                  // cache TTL inside the scraper means subsequent calls
                  // reuse the same scrape result.
                  await dk.fetchDkPlayerProps(sportKey).catch((e) => {
                    log.debug('Lines', `DK ${sportKey} player-prop scrape failed: ${e.message}`);
                  });
                }
                const dkHit = dk.lookupDkPlayerPropFairProb(sportKey, propType, playerName, thisLine);
                if (dkHit && dkHit.fairProbOver != null && dkHit.fairProbUnder != null) {
                  lookup = dkHit;
                }
              } catch (err) {
                log.debug('Lines', `DK player-prop fallback error for ${playerName} ${propType} ${thisLine}: ${err.message}`);
              }
            }
            // Tertiary fallback: one-sided lookup for MLB hitter binary
            // props (line=0.5 or ladder positions 1.5/2.5).
            //
            // Triggers in TWO cases:
            //  (i)  2-sided lookup failed entirely (TOA + pair-DK both empty).
            //  (ii) 2-sided lookup succeeded but DK is NOT in the paired
            //       consensus — non-DK paired books (BetMGM, BetOnline,
            //       BetRivers) frequently drift 5-7pp implied prob from DK
            //       on hitter binary props. Prefer DK's one-sided ladder
            //       price in this case.
            //
            // Two sources, tried in order:
            //  1. TOA one-sided (`batter_home_runs`, `batter_rbis`, etc.
            //     when books only post the over). Multi-book consensus
            //     across whoever TOA returns (BetOnline + William Hill on
            //     typical Hobby tier; +Pinnacle/etc. on paid). Operator
            //     directive 2026-05-22 after audit confirmed TOA HR market
            //     is 100% one-sided on 2 books — no DK scraping needed.
            //  2. DK scraper milestone ladder (fallback when TOA empty).
            //     Single-book DK. Requires DK scraper to capture the
            //     "Home Runs Milestones" market.
            //
            // Hitter-binary only — over/under props (NBA points, NHL shots,
            // MLB strikeouts) still require a true 2-sided pair.
            const oneSidedEligible = (sportKey === 'baseball_mlb'
              && ['hitter_hits', 'hitter_hr', 'hitter_total_bases', 'hitter_rbi_runs'].includes(propType))
              // Soccer goalscorer/SoT/assists are one-sided by construction
              // (books post only the YES/over side).
              || !!soccerProp
              // Football anytime-TD is Yes-only at every book (measured:
              // player_anytime_td, 2 books, no under anywhere) — the
              // two-sided path can never satisfy booksWithBothSides.
              || (!!footballProp && propType === 'anytime_td');
            let oneSidedHit = null;       // { source, impliedOver, books[], fetchedAt }
            if (oneSidedEligible) {
              const lookupHasDk = lookup && Array.isArray(lookup.books)
                && lookup.books.some(b => String(b).toLowerCase() === 'draftkings');
              const lookupMissing = !lookup || lookup.fairProbOver == null || lookup.fairProbUnder == null;
              if (lookupMissing || !lookupHasDk) {
                // Try TOA one-sided first (multi-book).
                try {
                  const toaOs = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
                    soccerProp ? _soccerPropToaSport(sportKey) : sportKey, toaMarketKey,
                    { homeTeam: matchedHome, awayTeam: matchedAway, startTime: event.scheduled || null },
                    playerName, toaQueryLine,
                  );
                  if (toaOs && toaOs.fairProbOver != null && toaOs.oneSidedSource === 'toa-one-sided') {
                    oneSidedHit = {
                      source: 'toa-one-sided',
                      impliedOver: toaOs.fairProbOver,  // overround-adjusted (drives EV/risk)
                      rawImpliedOver: (toaOs.oneSidedRawAvgImplied != null ? toaOs.oneSidedRawAvgImplied : toaOs.fairProbOver), // raw posted avg (book-mirror basis)
                      books: toaOs.books || [],
                      fetchedAt: toaOs.fetchedAt || Date.now(),
                    };
                  }
                } catch (err) {
                  log.debug('Lines', `TOA one-sided lookup error for ${playerName} ${propType} ${thisLine}: ${err.message}`);
                }
                // Fall back to DK scraper if TOA one-sided didn't return.
                // (MLB only — there's no DK soccer/football prop scrape.)
                if (!oneSidedHit && !soccerProp && !footballProp) {
                  try {
                    const dk = require('./dk-scraper');
                    if (typeof dk.lookupDkPlayerPropOneSidedFairProb === 'function') {
                      const dkOs = dk.lookupDkPlayerPropOneSidedFairProb(sportKey, propType, playerName, thisLine);
                      if (dkOs) {
                        const dkOver = dkOs.side === 'over' ? dkOs.impliedProb : (1 - dkOs.impliedProb);
                        oneSidedHit = {
                          source: 'dk-scraper-one-sided',
                          impliedOver: dkOver,  // raw DK implied
                          rawImpliedOver: dkOver, // raw DK posted (book-mirror basis)
                          books: ['draftkings'],
                          fetchedAt: dkOs.fetchedAt || Date.now(),
                        };
                      }
                    }
                  } catch (err) {
                    log.debug('Lines', `DK one-sided lookup error for ${playerName} ${propType} ${thisLine}: ${err.message}`);
                  }
                }
              }
            }

            if (oneSidedHit) {
              // fairOver = overround-adjusted estimate; drives EV/risk weighting.
              const fairOver = oneSidedHit.impliedOver;
              const fairUnder = 1 - fairOver;
              // HR book-mirror (operator 2026-06-10): quote the OVER at the
              // book's RAW posted price minus a small sweetener (sweeter for the
              // counterparty), via bookPriceOverride — pricer quotes it directly,
              // bypassing de-vig+vig, so we inherit the book's margin (minus the
              // sweetener) instead of guessing a one-sided de-vig. Prefer the
              // real DK number (scraper) as the basis; fall back to the raw
              // posted consensus the one-sided source already returned. HR only.
              let overBookPriceOverride = null;
              // Soccer + football-anytime-TD one-sided props use the same
              // operator-approved book-mirror as MLB hitter binaries: quote
              // the books' RAW posted consensus minus the sweetener,
              // inheriting their (large) anytime-market margin instead of
              // guessing a one-sided de-vig. Multi-book TOA raw average is
              // the basis — no DK preference step (no DK soccer/football
              // scrape exists).
              if (propType === 'hitter_hr' || propType === 'hitter_rbi_runs' || soccerProp || footballProp) {
                let mirrorRawOver = oneSidedHit.rawImpliedOver;
                let mirrorSource = oneSidedHit.source;
                if (!soccerProp && !footballProp && oneSidedHit.source !== 'dk-scraper-one-sided') {
                  try {
                    const dk = require('./dk-scraper');
                    if (typeof dk.lookupDkPlayerPropOneSidedFairProb === 'function') {
                      const dkOs = dk.lookupDkPlayerPropOneSidedFairProb(sportKey, propType, playerName, thisLine);
                      if (dkOs) {
                        const dkOver = dkOs.side === 'over' ? dkOs.impliedProb : (1 - dkOs.impliedProb);
                        if (dkOver > 0 && dkOver < 1) { mirrorRawOver = dkOver; mirrorSource = 'dk-scraper-one-sided'; }
                      }
                    }
                  } catch (_) { /* DK scraper unavailable — use feed raw posted */ }
                }
                const sweet = (config.pricing && config.pricing.propBookMirrorSweetener != null)
                  ? config.pricing.propBookMirrorSweetener : 0.005;
                if (mirrorRawOver != null && mirrorRawOver > 0 && mirrorRawOver < 1) {
                  overBookPriceOverride = Math.max(0.005, Math.min(0.98, mirrorRawOver * (1 - sweet)));
                  log.debug('Lines', `${propType} book-mirror ${playerName}: raw ${(mirrorRawOver * 100).toFixed(1)}% (${mirrorSource}) -> quote ${(overBookPriceOverride * 100).toFixed(1)}% (sweetener ${(sweet * 100).toFixed(2)}%)`);
                }
              }
              for (const sel of sels) {
                // OVER side ONLY (operator 2026-06-12). One-sided props have
                // no posted under at any book — the under we used to register
                // was a derived complement (1 − overround-adjusted over) with
                // an ASSUMED 8% haircut, the weakest-grounded price in the
                // book, and its flow self-selects sharp (nobody parlays "no
                // HR" recreationally). Under line_ids now stay unregistered
                // and decline as unknown legs — same posture as WC soccer
                // props (YES only). Two-sided-priced props (real posted
                // unders) are unaffected: this is the one-sided path only.
                if (sel.selection !== 'over') continue;
                const fairProb = fairOver;
                _setSeedLine(sel.lineId, {
                  sport: sportKey,
                  pxEventId: event.event_id,
                  pxEventName: event.name,
                  marketType: _propMarketType(propType),
                  marketName: market.name,
                  selection: sel.selection,
                  teamName: playerName,
                  line: sel.line,
                  homeTeam: matchedHome,
                  awayTeam: matchedAway,
                  // Soccer props resolve against the dedicated TOA tournament
                  // key even though the event matched under generic 'soccer'.
                  oddsApiSport: soccerProp ? _soccerPropToaSport(sportKey) : sportKey,
                  oddsApiMarket: toaMarketKey,
                  oddsApiSelection: sel.selection,
                  startTime: event.scheduled || null,
                  playerName,
                  propType,
                  fairProb,
                  fairProbOver: fairOver,
                  fairProbUnder: fairUnder,
                  booksWithBothSides: 0,
                  bookPriceOverride: overBookPriceOverride,
                  propBooks: oneSidedHit.books,
                  propSource: oneSidedHit.source,
                  propFetchedAt: oneSidedHit.fetchedAt || Date.now(),
                });
                totalLines++;
                matchedLines++;
              }
              continue; // skip the standard two-sided registration path below
            }

            if (!lookup || lookup.fairProbOver == null || lookup.fairProbUnder == null) continue;
            const both = lookup.booksWithBothSides || 0;
            const trustedAlone = both === 1 && (lookup.books || []).some(b => trustedSet.includes(String(b).toLowerCase()));
            if (both < minBooks && !trustedAlone) continue;

            // Register BOTH sides at THIS line — bettors will RFQ either
            // over or under and both lineIds need to be in the index ahead
            // of time. Each sel.lineId in `sels` is unique (PX uses one
            // lineId per (line, side) pair).
            for (const sel of sels) {
              // HR unders are NEVER offered (operator 2026-06-12) — not even
              // when a book genuinely posts both sides (~20 players/slate
              // carry real two-sided HR data and slipped past the one-sided-
              // path removal). 'No HR' flow self-selects sharp regardless of
              // the price basis.
              if (propType === 'hitter_hr' && sel.selection === 'under') continue;
              const fairProb = sel.selection === 'over' ? lookup.fairProbOver : lookup.fairProbUnder;
              _setSeedLine(sel.lineId, {
                sport: sportKey,
                pxEventId: event.event_id,
                pxEventName: event.name,
                marketType: _propMarketType(propType),
                marketName: market.name,
                selection: sel.selection,
                teamName: playerName,
                line: sel.line,
                homeTeam: matchedHome,
                awayTeam: matchedAway,
                oddsApiSport: sportKey,
                oddsApiMarket: toaMarketKey,
                oddsApiSelection: sel.selection,
                startTime: event.scheduled || null,
                playerName,
                propType,
                fairProb,
                fairProbOver: lookup.fairProbOver,
                fairProbUnder: lookup.fairProbUnder,
                booksWithBothSides: lookup.booksWithBothSides,
                propBooks: lookup.books,
                propSource: lookup.source || 'theoddsapi',
                propFetchedAt: lookup.fetchedAt || Date.now(),
              });
              totalLines++;
              matchedLines++;
            }
          }
        }
      }
    } catch (err) {
      log.warn('Lines', `Pre-seed props pass error for ${event.name}: ${err.message}`);
    }

    // ----- PRE-SEED RFI (Run First Inning / 1st Inning Total Runs) -----
    // PX posts this MLB game-level YES/NO market as "1st Inning Total Runs"
    // (type sup_moneyline): selection "Over 0.5" = YES (a run scores in the
    // 1st), "Under 0.5" = NO. Fair from oddsFeed.getRfiFair (TOA
    // totals_1st_1_innings, per-book physical-2-way de-vig then average).
    // Unlike one-sided props we have a REAL de-vigged 2-way fair, so register
    // BOTH sides with fairProb (Over=yesFair, Under=noFair) and let the normal
    // de-vig->vig pipeline price them (participates in leg-count/SGP
    // amplification), with the vigRfiMin margin floor. Gated by
    // config.rfi.enabled; fail-closed when getRfiFair returns null (no books /
    // started / unresolved). The atomic seed rebuild self-heals staleness — a
    // game only carries RFI lines in a cycle where getRfiFair succeeded.
    // NOTE (v1): same-game correlation (RFI-YES vs the game/F5 Over) is NOT yet
    // penalized — bounded for now by the prop-sized stake cap on RFI parlays.
    if (config.rfi && config.rfi.enabled && sportKey === 'baseball_mlb' && matchedHome && matchedAway) {
      try {
        const rfiMarket = markets.find(m => m && /1st\s*inning\s*total\s*runs/i.test(m.name || ''));
        if (rfiMarket && Array.isArray(rfiMarket.selections)) {
          // One stable line_id per side; PX repeats each side across order-book
          // depth entries that share a line_id. Read the side from the name.
          let overLineId = null, underLineId = null;
          for (const group of rfiMarket.selections) {
            for (const sel of (Array.isArray(group) ? group : [group])) {
              if (!sel || !sel.line_id) continue;
              const nm = String(sel.name || sel.display_name || '').toLowerCase();
              if (/^over/.test(nm) && !overLineId) overLineId = sel.line_id;
              else if (/^under/.test(nm) && !underLineId) underLineId = sel.line_id;
            }
          }
          if (overLineId && underLineId) {
            const rfi = await oddsFeed.getRfiFair('baseball_mlb', matchedHome, matchedAway, event.scheduled || null);
            if (rfi && rfi.yesFair > 0 && rfi.yesFair < 1 && rfi.noFair > 0 && rfi.noFair < 1) {
              const sides = [
                { lineId: overLineId, selection: 'over', teamName: 'Over 0.5', fairProb: rfi.yesFair },
                { lineId: underLineId, selection: 'under', teamName: 'Under 0.5', fairProb: rfi.noFair },
              ];
              for (const sd of sides) {
                _setSeedLine(sd.lineId, {
                  sport: sportKey,
                  pxEventId: event.event_id,
                  pxEventName: event.name,
                  marketType: 'run_first_inning',
                  marketName: rfiMarket.name,
                  selection: sd.selection,
                  teamName: sd.teamName,
                  line: 0.5,
                  homeTeam: matchedHome,
                  awayTeam: matchedAway,
                  oddsApiSport: 'baseball_mlb',
                  oddsApiMarket: 'totals_1st_1_innings',
                  oddsApiSelection: sd.selection,
                  startTime: event.scheduled || null,
                  fairProb: sd.fairProb,
                  fairProbOver: rfi.yesFair,
                  fairProbUnder: rfi.noFair,
                  rfiBooks: rfi.books,
                  propFetchedAt: rfi.fetchedAt || Date.now(),
                });
                totalLines++;
                matchedLines++;
              }
              log.debug('Lines', `RFI seeded ${event.name}: YES ${(rfi.yesFair * 100).toFixed(1)}% / NO ${(rfi.noFair * 100).toFixed(1)}% (${rfi.books} books)`);
            }
          }
        }
      } catch (err) {
        log.warn('Lines', `RFI pre-seed error for ${event.name}: ${err.message}`);
      }
    }

    // ----- PRE-SEED TEAM TOTALS (guaranteed cache population) -----
    // PX's team-total markets already register through the main-market loop
    // above (they pass the filter; parser upgrades PX 'total'→'team_total'),
    // but they price via getFairProb reading oddsCache[...].markets.team_totals
    // — and the background supplementTeamTotals was silently failing under
    // prod load, leaving that cache empty so every team-total RFQ declined
    // "no fair value" (why we effectively never quoted them). Fetch inline
    // here per game so the cache reliably carries the consensus (primary + alt
    // lines via byLine) for the already-registered PX lines. ensureTeamTotals
    // is single-flighted + TTL-cached in odds-feed, so this is cheap and
    // shares work with the refresh-cycle supplement. Fail-open.
    if (TEAM_TOTAL_SEED_SPORTS.has(sportKey) && matchedHome && matchedAway) {
      try {
        await oddsFeed.ensureTeamTotals(sportKey, matchedHome, matchedAway, event.scheduled || null);
      } catch (err) {
        log.warn('Lines', `team-total pre-seed error for ${event.name}: ${err.message}`);
      }
    }

    // ----- PRE-SEED BTTS (same guarantee, same reason) -----
    // PX's "Both Teams To Score" registers through the main-market loop above
    // (parser now detects it by name — PX types it 'moneyline'), but it prices
    // via getFairProb reading oddsCache[...].markets.btts. Rely on the
    // refresh-cycle supplement alone and BTTS inherits the exact failure the
    // team-total pre-seed above exists to fix: silent gap → empty cache →
    // every BTTS RFQ declines "no fair value". ensureBtts is single-flighted
    // + TTL-cached and self-gates on BTTS_SPORTS, so this is cheap and shares
    // work with the supplement. Fail-open.
    if (matchedHome && matchedAway) {
      try {
        await oddsFeed.ensureBtts(sportKey, matchedHome, matchedAway, event.scheduled || null);
      } catch (err) {
        log.warn('Lines', `btts pre-seed error for ${event.name}: ${err.message}`);
      }
    }

    // ----- PRE-SEED FOOTBALL CONSENSUS (same guarantee, same reason) -----
    // services/nfl-consensus reads a SYNC cache on the RFQ hot path, so a game
    // whose board was never warmed prices off nothing. Warming here — the same
    // place team_totals and BTTS are warmed — is what makes the wider region
    // set and 9-book median actually reach a quote. Single-flighted, TTL-cached
    // and internally paced (~1 req/s) because TOA rate-limits on request
    // FREQUENCY and a 429 reads downstream as "no coverage", not as an error.
    // Fail-open: a miss leaves the board cold and the pricer falls through to
    // the legacy odds path for this cycle.
    if (nflConsensus.isFootball(sportKey) && matchedHome && matchedAway) {
      try {
        await nflConsensus.ensureNflConsensus(sportKey, matchedHome, matchedAway, event.scheduled || null);
      } catch (err) {
        log.warn('Lines', `football consensus pre-seed error for ${event.name}: ${err.message}`);
      }
    }

    // Small delay to avoid hammering PX API
    await new Promise(r => setTimeout(r, 100));
  }

  // Log unmatched events
  if (unmatchedEvents.length > 0) {
    log.warn('Lines', `${unmatchedEvents.length} events could not be matched to Odds API:`);
    for (const ue of unmatchedEvents) {
      log.warn('Lines', `  ${ue.pxEvent}: ${ue.reason || `home=${ue.pxHome}→${ue.matchedHome || 'NO MATCH'}, away=${ue.pxAway}→${ue.matchedAway || 'NO MATCH'}`}`);
    }
  }


  // 6a. Atomic build-then-swap. If we built into staging objects this run
  // (warm refresh: _seedIndexTarget is set), replace the live lineIndex /
  // primaryByEvent contents with the staging contents now — before
  // registerSupportedLines so PX RFQs that arrive immediately after
  // registration find their entries in the LIVE index.
  //
  // JS is single-threaded; this entire block executes synchronously between
  // any two RFQ handlers, so no caller observes a partial state. We mutate
  // contents in place (rather than reassign) because the module-level
  // `const` bindings forbid reassignment and because outside callers
  // (e.g. /health/coverage, /coverage-audit, getLineSummary) may have
  // captured the reference.
  //
  // Cold start: _seedIndexTarget is null and this block is a no-op (seed
  // wrote directly to live as before).
  if (_seedIndexTarget && _seedPrimaryTarget) {
    for (const k of Object.keys(lineIndex)) delete lineIndex[k];
    Object.assign(lineIndex, _seedIndexTarget);
    for (const k of Object.keys(primaryByEvent)) delete primaryByEvent[k];
    Object.assign(primaryByEvent, _seedPrimaryTarget);
    _seedIndexTarget = null;
    _seedPrimaryTarget = null;
  }

  // 6b. Sync our PX "supported lines" set. RULE 1 (Anthony 2026-06-25): the set
  // must contain ONLY lines we can actually quote and be kept in sync. The old
  // code POSTed the whole index every cycle and NEVER removed anything, so
  // settled/started/dropped lines stayed "supported" forever and then declined
  // at RFQ time. Now: exclude already-started events, then DIFF against the last
  // set we registered (add new, remove dropped).
  const _nowMs = Date.now();
  const lineIds = Object.keys(lineIndex).filter(k => {
    const li = lineIndex[k];
    if (!li) return false;
    const startMs = li.startTimeMs || (li.startTime ? Date.parse(li.startTime) : NaN);
    if (Number.isFinite(startMs) && startMs <= _nowMs) return false; // event started — not quotable
    return true;
  });
  // First boot: MERGE PX's live supported set into the tracking set so the diff
  // below prunes lines accumulated by the old append-only registration (~20k+
  // stale lines observed 2026-06-25). Runs once per boot, gated by its own flag
  // (size check would be defeated by on-demand regs firing before first seed).
  // Merge (not overwrite) so any on-demand lines already added survive.
  if (!_supportedReconcileDone) {
    _supportedReconcileDone = true;
    try {
      const existing = await px.getSupportedLines(100000); // paginated (token cursor)
      let added = 0;
      for (const e of (Array.isArray(existing) ? existing : [])) {
        const id = (typeof e === 'string' ? e : (e && (e.line_id || e.lineId)));
        if (id && !_lastRegisteredLineIds.has(id)) { _lastRegisteredLineIds.add(id); added++; }
      }
      log.info('Lines', `Loaded ${added} existing PX supported lines for reconciliation (total tracked ${_lastRegisteredLineIds.size})`);
    } catch (err) {
      log.warn('Lines', `Could not fetch existing PX supported lines (skipping historical prune this boot): ${err.message}`);
    }
  }
  const _newSet = new Set(lineIds);
  const _toAdd = lineIds.filter(id => !_lastRegisteredLineIds.has(id));
  let _toRemove = [..._lastRegisteredLineIds].filter(id => !_newSet.has(id));
  // MASS-REMOVAL CIRCUIT BREAKER. A transient upstream failure (odds outage,
  // empty PX event fetch, one bad seed) makes every line "stale" for one
  // cycle; without a breaker this pass would REMOVE the whole supported set
  // and re-register it next cycle — a burst-shaped write storm against PX and
  // a window where every RFQ declines as unknown. Legitimate churn is
  // incremental (a slate rolling over removes a fraction); wiping >60% of a
  // non-trivial set in ONE pass is an outage signature, not a schedule.
  // Skipping keeps quoting on the old set for a cycle (stale-price gates
  // still protect pricing) and retries next reconcile. Genuine mass turnover
  // (e.g. sport season flips) clears in a few cycles as the fraction drops,
  // or set LINE_REMOVE_BREAKER_PCT=100 to disable.
  const _breakerPct = Number(process.env.LINE_REMOVE_BREAKER_PCT) > 0
    ? Number(process.env.LINE_REMOVE_BREAKER_PCT) : 60;
  let _breakerFired = false;
  if (_removalBreakerFires(_lastRegisteredLineIds.size, _toRemove.length, _breakerPct)) {
    log.error('Lines', `BREAKER: reconcile wants to remove ${_toRemove.length}/${_lastRegisteredLineIds.size} supported lines (>${_breakerPct}%) in one pass — looks like a transient outage, not a schedule change. Skipping removals this cycle (additions still apply).`);
    _breakerFired = true;
    _toRemove = [];
  }
  try {
    if (_toAdd.length > 0) {
      await px.registerSupportedLines(_toAdd);
      log.info('Lines', `Registered ${_toAdd.length} new supported lines with ProphetX`);
    }
    if (_toRemove.length > 0) {
      await px.removeSupportedLines(_toRemove);
      log.info('Lines', `Removed ${_toRemove.length} stale supported lines from ProphetX`);
    }
    // Advance only on success. When the breaker skipped removals, keep the
    // skipped ids IN the tracked set — advancing to _newSet alone would
    // forget lines still registered at PX (permanent drift the boot-time
    // reconcile only heals on restart) and next cycle would never retry.
    _lastRegisteredLineIds = _breakerFired
      ? new Set([..._newSet, ..._lastRegisteredLineIds])
      : _newSet;
    if (_toAdd.length === 0 && _toRemove.length === 0) {
      log.debug('Lines', `Supported-lines set unchanged (${_newSet.size} lines)`);
    }
  } catch (err) {
    log.error('Lines', `Failed to sync supported lines: ${err.message}`);
    // Leave _lastRegisteredLineIds unchanged so next cycle retries the full diff.
  }

  lastSeedStats = {
    timestamp: new Date().toISOString(),
    totalEvents: events.length,
    totalLines,
    matchedLines,
    registeredLines: lineIds.length,
    unmatchedEvents: unmatchedEvents.length,
    // Detail sample so /status shows WHICH events failed matching — the 7/23
    // five-dark-MLB-games incident was invisible because only the count
    // surfaced. `deferred: true` entries did register (with pricing
    // fallbacks); entries without it were skipped entirely.
    unmatchedEventDetails: unmatchedEvents.slice(0, 25),
    golfTrace,
  };

  log.info('Lines', `=== Seed complete: ${events.length} events, ${totalLines} lines parsed, ${matchedLines} matched, ${lineIds.length} registered ===`);

  // Persist lineIndex to Supabase so historical line_ids survive restarts
  db.saveLineCache(lineIndex).catch(err => {
    log.warn('Lines', `saveLineCache failed: ${err.message}`);
  });

  // Mark cold start complete — subsequent refreshLines cycles skip
  // Supabase hydration so the per-sport stale-event cutoff in seed
  // stays authoritative.
  _hasSeededOnce = true;

  return lastSeedStats;
}

// ---------------------------------------------------------------------------
// LOOKUPS
// ---------------------------------------------------------------------------

function __debugGetLineIndex() {
  return lineIndex;
}

function lookupLine(lineId) {
  const info = lineIndex[lineId];
  if (!info) return null;
  // Parse startTime once per line lifetime. Hot-path callers (shouldDecline,
  // priceParlay) read startTimeMs directly — avoids re-parsing the ISO string
  // on every RFQ. `undefined` = never computed, `null` = missing startTime,
  // `NaN` = invalid, number = valid ms.
  if (info.startTimeMs === undefined) {
    info.startTimeMs = info.startTime ? Date.parse(info.startTime) : null;
  }
  return info;
}

// ===========================================================================
// Manual disable: operator-controlled per-line and per-event blocklist.
// Use case: a sportsbook pulls lines on a game (rain delay, late scratch,
// etc) but our cache still shows stale prices. Pausing the entire service
// is too heavy. Instead the operator clicks "Disable" in the Lines table
// drill-down to make a specific line (or whole event) auto-decline at the
// pricer level.
//
// Persistence: in-memory Sets are the source of truth at runtime. After
// each mutation we fire-and-forget a write to Supabase kv_store so the
// disable survives Railway redeploys (every push to main restarts the
// service). hydrateDisabledFromDb() is called once at startup to repopulate
// the Sets from kv_store. Operator caught 2026-05-09 that an MMA event
// they had disabled re-enabled itself after a redeploy — pre-fix the
// disabled state was wiped on every restart.
// ===========================================================================
const KV_DISABLED_LINES = 'disabled_line_ids';
const KV_DISABLED_PX_EVENTS = 'disabled_px_event_ids';

const disabledLineIds = new Set();
const disabledPxEventIds = new Set();

let _db = null;
function _getDb() {
  if (_db === null) {
    try { _db = require('./db'); }
    catch (_) { _db = false; }
  }
  return _db || null;
}

function _persistDisabledLines() {
  const db = _getDb();
  if (!db || typeof db.saveKV !== 'function') return;
  // Fire-and-forget. Failures log a warning inside saveKV; the in-memory
  // Set is unaffected so the disable still works for this process lifetime.
  db.saveKV(KV_DISABLED_LINES, Array.from(disabledLineIds))
    .catch(() => { /* logged by saveKV */ });
}

function _persistDisabledPxEvents() {
  const db = _getDb();
  if (!db || typeof db.saveKV !== 'function') return;
  db.saveKV(KV_DISABLED_PX_EVENTS, Array.from(disabledPxEventIds))
    .catch(() => { /* logged by saveKV */ });
}

/**
 * Restore disabled lines + events from kv_store. Called once at startup
 * before WebSocket connects so the first RFQs after restart respect the
 * operator's prior disable selections. Best-effort — DB outage logs a
 * warning and the service continues with empty Sets.
 */
async function hydrateDisabledFromDb() {
  const db = _getDb();
  if (!db || typeof db.loadKV !== 'function') return { lines: 0, events: 0 };
  try {
    const [lines, events] = await Promise.all([
      db.loadKV(KV_DISABLED_LINES).catch(() => null),
      db.loadKV(KV_DISABLED_PX_EVENTS).catch(() => null),
    ]);
    if (Array.isArray(lines)) {
      for (const id of lines) if (id) disabledLineIds.add(String(id));
    }
    if (Array.isArray(events)) {
      for (const id of events) if (id) disabledPxEventIds.add(String(id));
    }
    return { lines: disabledLineIds.size, events: disabledPxEventIds.size };
  } catch (_) {
    return { lines: 0, events: 0 };
  }
}

function isLineDisabled(lineId) {
  if (!lineId) return false;
  if (disabledLineIds.has(String(lineId))) return true;
  // Event-level disable cascades to every line under that pxEventId
  const info = lineIndex[lineId];
  if (info && info.pxEventId != null && disabledPxEventIds.has(String(info.pxEventId))) return true;
  return false;
}

function isPxEventDisabled(pxEventId) {
  return pxEventId != null && disabledPxEventIds.has(String(pxEventId));
}

function disableLine(lineId) {
  if (!lineId) return false;
  disabledLineIds.add(String(lineId));
  _persistDisabledLines();
  return true;
}

function enableLine(lineId) {
  if (!lineId) return false;
  const removed = disabledLineIds.delete(String(lineId));
  if (removed) _persistDisabledLines();
  return removed;
}

function disablePxEvent(pxEventId) {
  if (pxEventId == null) return false;
  disabledPxEventIds.add(String(pxEventId));
  _persistDisabledPxEvents();
  return true;
}

function enablePxEvent(pxEventId) {
  if (pxEventId == null) return false;
  const removed = disabledPxEventIds.delete(String(pxEventId));
  if (removed) _persistDisabledPxEvents();
  return removed;
}

function getDisabledSnapshot() {
  return {
    disabledLineIds: Array.from(disabledLineIds),
    disabledPxEventIds: Array.from(disabledPxEventIds),
  };
}

// ===========================================================================
// Manual line-odds override: operator-set fixed offered odds for a specific
// lineId. When an RFQ leg matches a line with an override, the pricer uses
// the override American odds directly (converted to implied prob via
// bookPriceOverride) instead of the model's fair × vig. Same persistence
// pattern as the disabled-lines blocklist — kv_store + boot-time hydrate.
//
// Use case: operator sees the model's fair_prob has drifted on a specific
// matchup (stale odds source, mid-game state mismatch, etc.) and wants to
// hand-fix the offered price without disabling the line entirely. Override
// stays in place until cleared via /admin/clear-line-odds.
// ===========================================================================
const KV_MANUAL_LINE_ODDS = 'manual_line_odds';

// lineId → American odds (number, integer). Persisted as JSON object
// {lineId: americanOdds, ...} in kv_store.
const manualLineOdds = new Map();

function _persistManualLineOdds() {
  const db = _getDb();
  if (!db || typeof db.saveKV !== 'function') return;
  const obj = {};
  for (const [lineId, odds] of manualLineOdds) obj[lineId] = odds;
  db.saveKV(KV_MANUAL_LINE_ODDS, obj).catch(() => { /* logged inside saveKV */ });
}

async function hydrateManualLineOddsFromDb() {
  const db = _getDb();
  if (!db || typeof db.loadKV !== 'function') return { count: 0 };
  try {
    const stored = await db.loadKV(KV_MANUAL_LINE_ODDS).catch(() => null);
    if (stored && typeof stored === 'object') {
      for (const [lineId, odds] of Object.entries(stored)) {
        const n = Number(odds);
        if (lineId && Number.isFinite(n) && n !== 0) {
          manualLineOdds.set(String(lineId), Math.round(n));
        }
      }
    }
    return { count: manualLineOdds.size };
  } catch (_) {
    return { count: 0 };
  }
}

function getManualLineOdds(lineId) {
  if (!lineId) return null;
  const v = manualLineOdds.get(String(lineId));
  return v != null ? v : null;
}

function hasManualLineOdds(lineId) {
  return lineId != null && manualLineOdds.has(String(lineId));
}

function setManualLineOdds(lineId, americanOdds) {
  if (!lineId) return false;
  const n = Number(americanOdds);
  if (!Number.isFinite(n) || n === 0) return false;
  // Reject odds in the (-99, 99) gap — not a valid American odds value.
  if (n > -100 && n < 100) return false;
  manualLineOdds.set(String(lineId), Math.round(n));
  _persistManualLineOdds();
  return true;
}

function clearManualLineOdds(lineId) {
  if (!lineId) return false;
  const removed = manualLineOdds.delete(String(lineId));
  if (removed) _persistManualLineOdds();
  return removed;
}

function getManualLineOddsSnapshot() {
  const out = {};
  for (const [k, v] of manualLineOdds) out[k] = v;
  return out;
}

/**
 * Async lookupLine that falls back to the persistent Supabase cache
 * when the in-memory lineIndex doesn't have the lineId.
 * Use this for enrichment paths that can await.
 */
async function lookupLineAsync(lineId) {
  if (lineIndex[lineId]) return lineIndex[lineId];
  // Fall back to persistent cache
  const cached = await db.loadLineCacheEntry(lineId);
  if (cached) {
    // Populate in-memory index so subsequent sync lookups hit
    cached.lineId = lineId; // legExposureKey needs it — see _setSeedLine
    lineIndex[lineId] = cached;
    _trackPrimaryForIndex(cached);
    log.debug('Lines', `lookupLineAsync: resolved ${lineId} from Supabase cache → ${cached.teamName}`);
  }
  return cached;
}

// Track in-flight resolution attempts to avoid duplicate work / rate limiting
const inFlightResolutions = new Map(); // lineId -> Promise
// Cache events we've already fetched markets for to avoid re-fetching
const resolvedEventMarkets = new Map(); // eventId -> { time, markets }
const RESOLVED_MARKET_TTL_MS = 60 * 1000; // 60s

// Per-lineId resolution-failure history. Replaces the singleton
// resolveUnknownLine._lastFailure (kept as alias for back-compat) which
// was getting clobbered by concurrent resolveUnknownLine calls — when a
// parlay had multiple unknown legs all racing through Promise.all, only
// the last writer's failure survived, so the categorization step in
// websocket.js saw `resolveReason=null` for 99.9% of MLB alt-spread
// declines. With a per-lineId map, each leg can look up its own failure
// reliably regardless of sibling races.
//
// Bounded via FIFO eviction at FAILURES_BY_LINE_ID_CAP entries to avoid
// unbounded growth; declines table already persists the resolveReason
// alongside each leg, so we only need this map alive long enough to span
// resolveUnknownLine → categorization (~milliseconds, same tick).
const _failuresByLineId = new Map();
const FAILURES_BY_LINE_ID_CAP = 10000;
function _recordResolveFailure(lineId, failure) {
  if (!lineId || !failure) return;
  // FIFO eviction: Map preserves insertion order. If we delete-then-set
  // an existing key, it moves to the most-recent slot.
  if (_failuresByLineId.has(lineId)) _failuresByLineId.delete(lineId);
  _failuresByLineId.set(lineId, failure);
  if (_failuresByLineId.size > FAILURES_BY_LINE_ID_CAP) {
    const firstKey = _failuresByLineId.keys().next().value;
    _failuresByLineId.delete(firstKey);
  }
  // Keep singleton alias for back-compat (logging code at line 2444
  // reads _lastFailure?.reason).
  resolveUnknownLine._lastFailure = failure;
}
function _getResolveFailure(lineId) {
  return _failuresByLineId.get(lineId) || null;
}

/**
 * On-demand registration: when an RFQ references a line we don't know,
 * attempt to fetch the event's markets from PX, locate the line, build
 * its metadata, and register it. Returns the line info or null on failure.
 *
 * This enables alt-line quoting without pre-registering every possible
 * spread/total during startup seeding.
 */
async function resolveUnknownLine(rfqLeg) {
  const lineId = rfqLeg.line_id || rfqLeg.lineId || rfqLeg;
  if (!lineId) return null;
  if (lineIndex[lineId]) {
    // Already resolved — any failure record from an earlier attempt is moot.
    _failuresByLineId.delete(lineId);
    return lineIndex[lineId];
  }

  // Clear stale failure state at the START of each call. _lastFailure is
  // kept as a back-compat alias of the most-recently-recorded failure;
  // the authoritative state now lives in the per-lineId map
  // _failuresByLineId. Clearing the singleton keeps lineId-unguarded
  // readers from getting stale data.
  resolveUnknownLine._lastFailure = null;

  // DELIBERATELY NOT deleting _failuresByLineId[lineId] here (2026-08-18).
  //
  // It used to be wiped synchronously at this point, "so the categorization
  // step doesn't see a stale entry if we succeed this time". That reasoning
  // was sound but the placement was not: the record is only re-written after
  // an awaited px.fetchMarkets ~50-150ms later, and BOTH readers run
  // synchronously in the meantime, so they read the hole rather than the
  // truth. Two things broke:
  //
  //   1. TELEMETRY. websocket.js fires this function WITHOUT awaiting for
  //      known-failing legs, then immediately categorizes the decline off
  //      getResolveFailure(). It got null every time — measured resolveReason
  //      null on 6,937/6,953 MLB legs over 14 days — so declines fell through
  //      to a line-VALUE heuristic and were labelled by guesswork. That is
  //      what made 'baseball_low_line_ambiguous' (and sub_game / alt_spread /
  //      alt_total / other_line) report as alt run-lines and game totals when
  //      ~100% of them are player props. 107/107 sampled line_ids had already
  //      been seen CORRECTLY labelled earlier the same day.
  //
  //   2. LATENCY, the one that actually costs money. The getFail(lid) probe
  //      in websocket.js decides fire-and-forget vs AWAIT precisely so we
  //      don't block an RFQ on a line we already know fails (operator
  //      incident 2026-06-07: the prop flood collapsed win rate 62% -> ~5%
  //      through exactly this latency). Wiping the record at entry makes a
  //      repeat offender look unseen again for the duration of the fetch, so
  //      concurrent RFQs on that line get re-AWAITED — silently defeating the
  //      fast path in the flood conditions it was built for.
  //
  // The record is now cleared where the original reasoning actually applies:
  // on the SUCCESS path (below), which is the only case that can strand a
  // stale entry. Failure paths call _recordResolveFailure, which overwrites.
  // This also fixes the in-flight variant: a concurrent duplicate call used
  // to wipe a record the in-flight promise had already written, then return
  // early at the inFlightResolutions check without ever rewriting it.

  // Sample log: capture RFQ leg shape (first 20 unknown legs only)
  if (!resolveUnknownLine._sampleCount) resolveUnknownLine._sampleCount = 0;
  if (resolveUnknownLine._sampleCount < 20 && typeof rfqLeg === 'object') {
    resolveUnknownLine._sampleCount++;
    log.debug('Lines', `RFQ leg sample #${resolveUnknownLine._sampleCount}: keys=${Object.keys(rfqLeg).join(',')} line=${rfqLeg.line} origin=${rfqLeg.origin_market_line}`);
  }

  // Reuse in-flight resolution
  if (inFlightResolutions.has(lineId)) {
    return inFlightResolutions.get(lineId);
  }

  const eventId = rfqLeg.sport_event_id;
  if (!eventId) {
    log.debug('Lines', `Cannot resolve ${lineId}: no sport_event_id in RFQ leg`);
    _recordResolveFailure(lineId, { lineId, reason: 'no_event_id' });
    return null;
  }

  const event = eventIndex[eventId];
  if (!event) {
    log.debug('Lines', `Cannot resolve ${lineId}: unknown event ${eventId}`);
    _recordResolveFailure(lineId, { lineId, reason: 'unknown_event', eventId });
    return null;
  }

  // Determine sport key. Generic catch-all keys (e.g. 'soccer') are
  // sorted LAST so league-specific keys (soccer_epl, soccer_germany_*)
  // win the matching race when both have an entry for the same event.
  // See seedAllLines for the full rationale.
  const _isGenericKey = (k) => !k.includes('_') || k === 'mma_mixed_martial_arts' || k === 'boxing_boxing';
  const possibleSportKeys = Object.entries(config.sportNameMap)
    .filter(([k, v]) => v === event.sportName)
    .map(([k]) => k)
    .sort((a, b) => (_isGenericKey(a) ? 1 : 0) - (_isGenericKey(b) ? 1 : 0));
  if (possibleSportKeys.length === 0) return null;

  // Identify home/away teams (reuse same logic as seed)
  let homeComp = (event.competitors || []).find(c => c.side === 'home');
  let awayComp = (event.competitors || []).find(c => c.side === 'away');
  if ((!homeComp || !awayComp) && (event.competitors || []).length >= 2) {
    homeComp = event.competitors[0];
    awayComp = event.competitors[1];
  }
  if (!homeComp || !awayComp) return null;

  // Try to match teams to odds feed for one of the possible sport keys
  const oddsApiEvents = oddsFeed.getAllCachedEvents();
  let matchedHome = null, matchedAway = null, sportKey = possibleSportKeys[0];
  for (const tryKey of possibleSportKeys) {
    const uniqueTeams = [...new Set(oddsApiEvents.filter(e => e.sport === tryKey).flatMap(e => [e.homeTeam, e.awayTeam]))];
    const tryHome = matchTeamName(homeComp.name, uniqueTeams);
    const tryAway = matchTeamName(awayComp.name, uniqueTeams);
    if (tryHome && tryAway) {
      const pxTime = event.scheduled || null;
      const oddsEvt = oddsFeed.getEventMarkets(tryKey, tryHome, tryAway, pxTime) || oddsFeed.getEventMarkets(tryKey, tryAway, tryHome, pxTime);
      if (oddsEvt) {
        matchedHome = tryHome;
        matchedAway = tryAway;
        sportKey = tryKey;
        break;
      }
    }
  }

  // Tennis tournament-aware fallback. The generic 'tennis' bucket merges
  // all tournaments; on rare occasions an event lands in a per-tournament
  // cache slot (tennis_atp_french_open, tennis_wta_strasbourg, etc.) but
  // not in the generic bucket — or the team name matches differently in
  // one bucket than another. Scan all 'tennis_*' cache keys before giving
  // up. fetchDynamicSports writes per-tournament slots since 2026-05-20.
  if ((!matchedHome || !matchedAway) && possibleSportKeys.includes('tennis')) {
    const tennisTourKeys = oddsFeed.getCachedSportKeysWithPrefix
      ? oddsFeed.getCachedSportKeysWithPrefix('tennis_')
      : [];
    for (const tourKey of tennisTourKeys) {
      const uniqueTeams = [...new Set(oddsApiEvents.filter(e => e.sport === tourKey).flatMap(e => [e.homeTeam, e.awayTeam]))];
      if (uniqueTeams.length === 0) continue;
      const tryHome = matchTeamName(homeComp.name, uniqueTeams);
      const tryAway = matchTeamName(awayComp.name, uniqueTeams);
      if (!tryHome || !tryAway) continue;
      const pxTime = event.scheduled || null;
      const oddsEvt = oddsFeed.getEventMarkets(tourKey, tryHome, tryAway, pxTime)
        || oddsFeed.getEventMarkets(tourKey, tryAway, tryHome, pxTime);
      if (oddsEvt) {
        matchedHome = tryHome;
        matchedAway = tryAway;
        // Keep sportKey as 'tennis' so downstream code paths (vig
        // calibration, line-cache, etc.) stay sport-keyed correctly.
        // We're just borrowing the per-tournament cache for the lookup.
        sportKey = 'tennis';
        log.debug('Lines', `Resolved ${lineId} via per-tournament tennis cache: ${tourKey} (${tryHome} vs ${tryAway})`);
        break;
      }
    }
  }

  // Second pass: try SharpAPI /events index (broader team name coverage)
  // Mirrors the seed-time fallback for events with non-standard team names.
  if (!matchedHome || !matchedAway) {
    for (const tryKey of possibleSportKeys) {
      const sharpEvents = oddsFeed.getSharpEvents(tryKey);
      if (!sharpEvents || sharpEvents.length === 0) continue;
      const sharpTeams = [...new Set(sharpEvents.flatMap(e => [e.homeTeam, e.awayTeam]))];
      const tryHome = matchTeamName(homeComp.name, sharpTeams);
      const tryAway = matchTeamName(awayComp.name, sharpTeams);
      if (tryHome && tryAway) {
        const pxTime = event.scheduled || null;
        const oddsEvt = oddsFeed.getEventMarkets(tryKey, tryHome, tryAway, pxTime)
          || oddsFeed.getEventMarkets(tryKey, tryAway, tryHome, pxTime);
        if (oddsEvt) {
          matchedHome = tryHome;
          matchedAway = tryAway;
          sportKey = tryKey;
          log.debug('Lines', `On-demand matched via events index: ${homeComp.name} → ${tryHome}, ${awayComp.name} → ${tryAway}`);
          break;
        }
      }
    }
  }
  if (!matchedHome || !matchedAway) {
    // Series-winner events (NHL-style separate PX event named
    // "Series Winner - X vs Y") won't match odds-feed game events
    // because no game event exists for just the series. Skip the
    // match requirement and use competitor names directly — pricer
    // will route this leg to the DK scraper cache.
    if (/^\s*series\s*winner\b/i.test(event.name || '')) {
      matchedHome = homeComp.name;
      matchedAway = awayComp.name;
      sportKey = possibleSportKeys[0];
    } else {
      // Log what we tried to match for debugging
      const sportKeys = possibleSportKeys.join(',');
      const pxHome = homeComp?.name || '?';
      const pxAway = awayComp?.name || '?';
      const oddsApiEvents = oddsFeed.getAllCachedEvents();
      const sportsAvail = possibleSportKeys.map(k => {
        const evts = oddsApiEvents.filter(e => e.sport === k);
        return k + ':' + evts.length;
      }).join(', ');
      log.info('Lines', `Cannot resolve ${lineId}: no odds feed match for "${event.name}" (PX: ${pxHome} vs ${pxAway}, sports: [${sportsAvail}], keys: ${sportKeys})`);
      _recordResolveFailure(lineId, { lineId, reason: 'no_odds_match', eventName: event.name, sport: event.sport || event.sportName, pxHome, pxAway, sportKeys, sportsAvail });
      return null;
    }
  }

  const promise = (async () => {
    try {
      // Fetch markets for this event (cached briefly to avoid re-fetching on chains of RFQs)
      const now = Date.now();
      let cached = resolvedEventMarkets.get(eventId);
      let markets;
      if (cached && now - cached.time < RESOLVED_MARKET_TTL_MS) {
        markets = cached.markets;
      } else {
        markets = await px.fetchMarkets(eventId);
        resolvedEventMarkets.set(eventId, { time: now, markets });
      }

      // First pass: find which market contains this line_id (any type)
      // so we can log unsupported market types for diagnostics.
      const SUPPORTED_TYPES = ['moneyline', 'spread', 'total', 'team_total', 'btts', 'both_teams_to_score', 'double_chance', 'series_winner', 'series_spread', 'series_total', 'sup_moneyline', ...MOV_MARKET_TYPES, ...F5_MARKET_TYPES, ...FIRST_HALF_MARKET_TYPES];
      // Series markets (winner/spread/total) are structurally
      // moneyline/spread/total but named "Series Winner/Spread/Total
      // Games". resolveUnknownLine accepts the regular PX types and
      // detects by name pattern below.
      const seriesWinnerNamePat = /\bseries\s*winner\b/i;
      const seriesSpreadNamePat = /\bseries\s*(spread|handicap)\b|\bseries\b[^.]*\bspread\b/i;
      const seriesTotalNamePat  = /\bseries\s*total\b|\btotal\s*games\b|\bseries\b[^.]*\btotal\b/i;
      let unsupportedMarketInfo = null;
      for (const market of markets || []) {
        if (SUPPORTED_TYPES.includes(market.type)) continue;
        // Walk the market structure generically to find the line_id
        const selections = [];
        if (market.selections) {
          for (const sg of market.selections) for (const s of sg) if (s.line_id) selections.push(s);
        }
        if (market.market_lines) {
          for (const ml of market.market_lines) {
            for (const sg of (ml.selections || [])) for (const s of sg) if (s.line_id) selections.push(s);
          }
        }
        if (selections.some(s => s.line_id === lineId)) {
          unsupportedMarketInfo = {
            marketType: market.type,
            marketName: market.name,
            eventName: event.name,
            sport: sportKey,
          };
          break;
        }
      }
      if (unsupportedMarketInfo) {
        log.info('Lines', `Unsupported market type: ${unsupportedMarketInfo.marketType} / "${unsupportedMarketInfo.marketName}" (${unsupportedMarketInfo.sport}, ${unsupportedMarketInfo.eventName})`);
        getOrderTracker().recordUnsupportedMarket(unsupportedMarketInfo);
        _recordResolveFailure(lineId, { lineId, reason: 'unsupported_market_type', ...unsupportedMarketInfo });
        return null;
      }

      // Find the line in the markets
      let foundInfo = null;
      // Track whether the line_id was found in ANY PX market (even if we
      // couldn't use it — e.g. out-of-bounds line, player prop total).
      // When set, virtual registration is blocked: PX already told us what
      // this line_id is, and we must not override that with heuristics.
      let lineFoundInPxMarket = false;
      // F5 name pattern — detect F5 markets by name since PX uses
      // market.type='spread'/'total' for them (distinguishes only via name)
      const f5NamePat = /1st[-\s]?5th.*inning|first\s*5\s*inning|first\s*five\s*innings|f5\b/i;
      const h1NamePat = /first\s*half|1st\s*half/i;
      // Sub-game name pattern — halves, quarters, periods, innings.
      // These markets come through with supported types (spread/total/moneyline)
      // but the market.name identifies them as sub-game. We must NOT register
      // them as full-game markets because their lines can coincidentally match
      // full-game primaries (e.g. NBA 1st-half spread 5.5 vs full-game 5.5),
      // leading to mispriced offers. Mirror the seed-time excludePatterns.
      // F5 is exempt (handled via its own marketType above).
      // H1 (first half) is also exempt — handled via FIRST_HALF_MARKET_TYPES.
      const subGameNamePat = /second half|2nd half|first quarter|1st quarter|2nd quarter|3rd quarter|4th quarter|1st period|2nd period|3rd period|1st inning|2nd inning|3rd inning|overtime/i;
      // Player prop name pattern: markets named after a player (e.g.
      // "LeBron James Made Threes", "Patrick Mahomes Passing Yards") that
      // PX tags with a supported type like "total" or "spread". These MUST
      // NOT be treated as full-game markets. Pattern matches common prop
      // keywords that appear alongside player names.
      const playerPropNamePat = /\b(?:made|attempted|assists|rebounds|steals|blocks|turnovers|points|passing|rushing|receiving|tackles|sacks|completions|interceptions|touchdowns|yards|shots|saves|hits|runs|rbis?|strikeouts|walks|home runs|goals|pim|faceoffs?|aces|double faults|games won|milestones|pitching|batting|earned|fantasy|doubles?|triples?|errors|stolen bases?|outs recorded|innings pitched|at bats?|put outs?|fouls|cards|bookings|offsides?|crosses|clearances|throw.?ins?)\b/i;
      for (const market of markets || []) {
        if (!SUPPORTED_TYPES.includes(market.type)) continue;

        // M1: Pitcher strikeouts prop. PX tags these as type='total' but
        // the market name reveals it's a player K prop. Route to the prop
        // fair-prob lookup (services/odds-feed.js lookupPlayerStrikeoutProp)
        // instead of the standard game-total resolver. Falls through to
        // the next market if the lineId isn't in this one.
        //
        // After M1 lands, shouldDecline gates these legs with a temporary
        // 'prop_pricing_not_ready' reason. Vig structure + decline rules
        // come in M2/M3 before live quoting.
        if (market.type === 'total' && isPitcherStrikeoutMarket(market.name || '')) {
          const parsedK = px.parseMarketSelections(market);
          const matchingK = parsedK.find(s => s.lineId === lineId);
          if (matchingK) {
            const playerName = extractPitcherNameFromKMarket(market.name);
            if (!playerName) {
              log.warn('Lines', `K-prop name extract failed: "${market.name}" (lineId ${lineId})`);
              _recordResolveFailure(lineId, {
                lineId,
                reason: 'k_prop_name_extract_failed',
                marketType: 'player_strikeouts',
                marketName: market.name,
                sport: sportKey,
                eventName: event.name,
              });
              return null;
            }
            const eventCtx = {
              homeTeam: matchedHome,
              awayTeam: matchedAway,
              startTime: event.scheduled || null,
            };
            // Try SharpAPI first (sync cache hit), fall back to TOA when
            // the SharpAPI result is either missing OR low-confidence.
            // Previously we only escalated on missing-fair (lookup
            // returned null fair_prob_over). That meant alt K-prop lines
            // where SharpAPI had only a single non-trusted book (e.g.
            // BetRivers alone on Suarez 3.5) silently used SharpAPI's
            // narrow result and got rejected downstream by shouldDecline
            // rule (b), even though TOA could have returned 5+ books for
            // the same line. Now we escalate when book count is < 2 AND
            // the single book isn't on the trusted-alone list.
            // TOA-primary lookup (operator preference 2026-05-18). SharpAPI
            // Hobby tier carries only 1-2 books on most K-prop lines, so
            // SharpAPI rarely clears the ≥2-book gate. TOA has 4-8 books
            // per K-prop line and is broader coverage in general. SharpAPI
            // remains as a safety fallback for the rare case TOA misses.
            const usableFair = (l) => l && l.fairProbOver != null && l.fairProbUnder != null;
            const trustedSet = (config.pricing && config.pricing.propTrustedSingleBooks) || [];
            const isHighConfidence = (l) => {
              if (!usableFair(l)) return false;
              const both = l.booksWithBothSides || 0;
              if (both >= 2) return true;
              const books = l.books || [];
              return both === 1 && books.some(b => trustedSet.includes(String(b).toLowerCase()));
            };
            let lookup = await oddsFeed.lookupPlayerStrikeoutPropFromTheOddsApi(
              sportKey, eventCtx, playerName, matchingK.line,
            );
            let propSource = 'theoddsapi';
            if (!isHighConfidence(lookup)) {
              const sharp = oddsFeed.lookupPlayerStrikeoutProp(
                sportKey, eventCtx, playerName, matchingK.line,
              );
              if (sharp && usableFair(sharp)) {
                const toaBoth = (lookup && lookup.booksWithBothSides) || 0;
                const sharpBoth = sharp.booksWithBothSides || 0;
                // Prefer SharpAPI if it has more books OR TOA produced no
                // usable fairs at all.
                if (!usableFair(lookup) || sharpBoth > toaBoth) {
                  lookup = sharp;
                  propSource = 'sharpapi';
                }
              }
            }
            const fairProb = matchingK.selection === 'over'
              ? (lookup && lookup.fairProbOver != null ? lookup.fairProbOver : null)
              : (lookup && lookup.fairProbUnder != null ? lookup.fairProbUnder : null);
            foundInfo = {
              sport: sportKey,
              pxEventId: eventId,
              pxEventName: event.name,
              marketType: 'player_strikeouts',
              marketName: market.name,
              selection: matchingK.selection,
              teamName: playerName, // dashboards display "team" — use pitcher name
              line: matchingK.line,
              homeTeam: matchedHome,
              awayTeam: matchedAway,
              oddsApiSport: sportKey,
              oddsApiMarket: 'player_strikeouts',
              oddsApiSelection: matchingK.selection,
              startTime: event.scheduled || null,
              onDemand: true,
              // Prop-specific metadata
              playerName,
              fairProb,
              fairProbOver: lookup && lookup.fairProbOver != null ? lookup.fairProbOver : null,
              fairProbUnder: lookup && lookup.fairProbUnder != null ? lookup.fairProbUnder : null,
              booksWithBothSides: lookup && lookup.booksWithBothSides != null ? lookup.booksWithBothSides : null,
              propBooks: lookup && lookup.books ? lookup.books : null,
              propSource,
              propFetchedAt: lookup && lookup.fetchedAt ? lookup.fetchedAt : Date.now(),
              propMatchError: lookup && lookup.error ? lookup.error : null,
              propMatchStages: lookup && lookup.stages ? lookup.stages : null,
            };
            lineFoundInPxMarket = true;
            break; // exit markets loop — foundInfo will be stored at line ~1680
          }
          // lineId not in this K-prop market — continue to next market
          continue;
        }

        // Reject sub-game markets (halves/quarters/periods) by name BEFORE
        // the bounds check. F5 is exempt because it has its own marketType.
        const isF5ByName = f5NamePat.test(market.name || '');
        const isH1ByName = h1NamePat.test(market.name || '') || FIRST_HALF_MARKET_TYPES.includes(market.type);
        if (!isF5ByName && !isH1ByName && subGameNamePat.test(market.name || '')) {
          // Check if the lineId is actually in this market — if so, we've
          // identified the request as a sub-game bet and should decline
          // cleanly with a specific reason.
          const parsedSub = px.parseMarketSelections(market);
          if (parsedSub.some(s => s.lineId === lineId)) {
            log.info('Lines', `Declined sub-game market: ${market.type} / "${market.name}" (${event.name})`);
            _recordResolveFailure(lineId, {
              lineId,
              reason: 'sub_game_market',
              marketType: market.type,
              marketName: market.name,
              sport: sportKey,
              eventName: event.name,
            });
            return null;
          }
          // Otherwise skip this market and keep searching
          continue;
        }
        // Reject player prop markets — PX often tags these with a supported
        // type (e.g. "total") but the name reveals it's a player stat market.
        // Must check BEFORE the per-selection loop so we don't register a
        // "LeBron James Made Threes O 1.5" as a game total or alt spread.
        //
        // IMPORTANT: Skip this check for known full-game market names like
        // "Total Points", "Total Runs", "Total Goals", "Point Spread", etc.
        // These contain generic words (points, runs, goals) that also appear
        // in playerPropNamePat, causing thousands of false-positive declines
        // on legitimate alt spread/total lines.
        const fullGameNamePat = /^(?:total|spread|moneyline|run line|puck line|point spread|alternate|alt |game spread|team total|draw no bet|both teams|double chance)/i;
        if (playerPropNamePat.test(market.name || '') && !fullGameNamePat.test(market.name || '')) {
          const parsedProp = px.parseMarketSelections(market);
          if (parsedProp.some(s => s.lineId === lineId)) {
            // Phase-2 prop launch bridge: classify the prop, check the
            // launch allowlist, and try the live TOA lookup before
            // falling through to the existing decline path. Empty
            // allowlist = identical behavior to before (decline as
            // player_prop_market). When allowlist is populated, eligible
            // prop legs become quotable here.
            //
            // Use module-cached websocket reference + lifted prop-type
            // maps (see top of file). Saves ~30-80μs per prop RFQ by
            // skipping the per-call require lookup + object literal.
            let propType = null;
            let toaMarketKey = null;
            let nameExtractor = null;
            const ws = _getWsModule();
            if (ws) {
              nameExtractor = ws._extractPlayerNameFromPropMarket;
              if (sportKey.includes('basketball')) {
                propType = ws._classifyNbaProp(market.name);
                toaMarketKey = _NBA_PROP_TO_TOA_MARKET[propType];
              } else if (sportKey.includes('hockey')) {
                propType = ws._classifyNhlProp(market.name);
                toaMarketKey = _NHL_PROP_TO_TOA_MARKET[propType];
              } else if (sportKey === 'baseball_mlb') {
                // pitcher_strikeouts has its own dedicated bridge above
                // (services/odds-feed.js lookupPlayerStrikeoutProp + TOA
                // fallback). Other MLB hitter prop types — hits, home
                // runs, total bases, RBIs — flow through the generic
                // Phase-2 bridge using TOA's batter_* market keys.
                propType = ws._classifyMlbProp(market.name);
                toaMarketKey = _MLB_PROP_TO_TOA_MARKET[propType];
              } else if (sportKey.startsWith('americanfootball')) {
                // Lockstep with the pre-seed router branch. Football
                // anytime-TD is lineless + Yes-only, so this on-demand
                // two-sided lookup fails closed (booksWithBothSides=0 →
                // decline) — one-sided registration happens at seed time,
                // exactly like the golf/MoV cold-start posture. The branch
                // exists so seed and on-demand can never classify the same
                // market differently, and declines get propType visibility.
                propType = (typeof ws._classifyFootballProp === 'function')
                  ? ws._classifyFootballProp(market.name) : null;
                toaMarketKey = propType ? _FOOTBALL_PROP_TO_TOA_MARKET[propType] : undefined;
              }
            }
            // Registration-safety assertion (football only): a football prop
            // may never proceed carrying a full-game marketType. Fails
            // closed → falls through to the standard prop decline below.
            if (sportKey.startsWith('americanfootball') && propType && toaMarketKey
                && !_footballPropRegistrationSafe(_propMarketType(propType))) {
              log.error('Lines', `Football prop assertion (on-demand): refusing "${market.name}" — marketType '${_propMarketType(propType)}' is not a safe player_* type`);
              propType = null;
              toaMarketKey = null;
            }
            const allowlist = (config.pricing && config.pricing.propLaunchAllowlist) || new Set();
            const allowKey = sportKey + '.' + propType;
            const allowed = propType && toaMarketKey && allowlist.has(allowKey);

            if (allowed) {
              const matchingProp = parsedProp.find(s => s.lineId === lineId);
              const playerName = nameExtractor ? nameExtractor(market.name) : null;
              if (matchingProp && playerName) {
                const eventCtx = {
                  homeTeam: matchedHome,
                  awayTeam: matchedAway,
                  startTime: event.scheduled || null,
                };
                let lookup = null;
                try {
                  lookup = await oddsFeed.lookupTheOddsApiPlayerProp(
                    sportKey, toaMarketKey, eventCtx, playerName, matchingProp.line,
                  );
                } catch (err) {
                  log.warn('Lines', `Phase-2 prop lookup error for ${playerName} ${propType} ${matchingProp.line}: ${err.message}`);
                }
                const minBooks = (config.pricing && config.pricing.propMinBooksWithBothSides) || 3;
                // trustedAlone fallback: a single trusted book (Pin/FD/DK/
                // BetMGM/BetRivers per config.propTrustedSingleBooks) with
                // BOTH sides at the exact line is enough to register, even
                // when total booksWithBothSides falls below minBooks. Mirrors
                // the pre-seed loop's gate (line-manager.js:~1414) so the
                // on-demand path doesn't silently decline sparse-coverage
                // alt lines that the pre-seed would have accepted. (Closed
                // 2026-05-11 — Trout/Neto 1.5 TB RFQs were declining here
                // after the per-line fix exposed the asymmetry between
                // pre-seed and on-demand gates.)
                const trustedSet = (config.pricing && config.pricing.propTrustedSingleBooks) || [];
                const lookupBoth = (lookup && lookup.booksWithBothSides) || 0;
                const lookupHasTrustedSingle = lookup
                  && lookupBoth === 1
                  && (lookup.books || []).some(b => trustedSet.includes(String(b).toLowerCase()));
                const usable = lookup
                  && lookup.fairProbOver != null
                  && lookup.fairProbUnder != null
                  && (lookupBoth >= minBooks || lookupHasTrustedSingle);
                if (usable) {
                  const fairProb = matchingProp.selection === 'over'
                    ? lookup.fairProbOver
                    : lookup.fairProbUnder;
                  foundInfo = {
                    sport: sportKey,
                    pxEventId: eventId,
                    pxEventName: event.name,
                    marketType: _propMarketType(propType),
                    marketName: market.name,
                    selection: matchingProp.selection,
                    teamName: playerName, // dashboards display "team" — use player name
                    line: matchingProp.line,
                    homeTeam: matchedHome,
                    awayTeam: matchedAway,
                    oddsApiSport: sportKey,
                    oddsApiMarket: toaMarketKey,
                    oddsApiSelection: matchingProp.selection,
                    startTime: event.scheduled || null,
                    onDemand: true,
                    playerName,
                    propType,
                    fairProb,
                    fairProbOver: lookup.fairProbOver,
                    fairProbUnder: lookup.fairProbUnder,
                    booksWithBothSides: lookup.booksWithBothSides,
                    propBooks: lookup.books,
                    propSource: 'theoddsapi',
                    propFetchedAt: lookup.fetchedAt || Date.now(),
                  };
                  lineFoundInPxMarket = true;
                  log.info('Lines', `Phase-2 prop registered: ${playerName} ${propType} ${matchingProp.selection} ${matchingProp.line} (${lookup.booksWithBothSides} books, fair=${fairProb.toFixed(4)})`);
                  break; // exit markets loop — foundInfo will be stored downstream
                }
                // One-sided fallback for MLB hitter binary props (HR, hits, TB, RBIs).
                // The 2-sided lookup above fails for batter_home_runs because books only
                // post the Over side — matched.length > 0 but fairProbUnder is null.
                // Mirror the pre-seed's one-sided path (line-manager.js:~1613) so
                // RFQs for players not yet pre-seeded (e.g. props posted after the last
                // refresh cycle) can register on-demand instead of declining.
                // Under side is intentionally excluded: "no HR" flow self-selects sharp.
                const _phase2OneSidedEligible = (sportKey === 'baseball_mlb'
                  && ['hitter_hits', 'hitter_hr', 'hitter_total_bases', 'hitter_rbi_runs'].includes(propType));
                if (_phase2OneSidedEligible && matchingProp.selection === 'over') {
                  let _oneSidedHit = null;
                  try {
                    const _toaOs = await oddsFeed.lookupTheOddsApiPlayerPropOneSided(
                      sportKey, toaMarketKey, eventCtx, playerName, matchingProp.line,
                    );
                    if (_toaOs && _toaOs.fairProbOver != null && _toaOs.oneSidedSource === 'toa-one-sided') {
                      _oneSidedHit = {
                        source: 'toa-one-sided',
                        impliedOver: _toaOs.fairProbOver,
                        rawImpliedOver: _toaOs.oneSidedRawAvgImplied != null
                          ? _toaOs.oneSidedRawAvgImplied : _toaOs.fairProbOver,
                        books: _toaOs.books || [],
                        fetchedAt: _toaOs.fetchedAt || Date.now(),
                      };
                    }
                  } catch (_err) {
                    log.debug('Lines', `Phase-2 one-sided lookup error for ${playerName} ${propType} ${matchingProp.line}: ${_err.message}`);
                  }
                  // DK scraper fallback when TOA one-sided is empty — covers the
                  // hitters TOA's thin free-tier books omit (e.g. Bobby Witt Jr.).
                  // Mirrors the pre-seed DK one-sided path (line-manager.js:~1639).
                  if (!_oneSidedHit) {
                    try {
                      const dk = require('./dk-scraper');
                      if (typeof dk.lookupDkPlayerPropOneSidedFairProb === 'function') {
                        const _dkOs = dk.lookupDkPlayerPropOneSidedFairProb(
                          sportKey, propType, playerName, matchingProp.line,
                        );
                        if (_dkOs) {
                          const _dkOver = _dkOs.side === 'over' ? _dkOs.impliedProb : (1 - _dkOs.impliedProb);
                          if (_dkOver > 0 && _dkOver < 1) {
                            _oneSidedHit = {
                              source: 'dk-scraper-one-sided',
                              impliedOver: _dkOver,
                              rawImpliedOver: _dkOver,
                              books: ['draftkings'],
                              fetchedAt: _dkOs.fetchedAt || Date.now(),
                            };
                          }
                        }
                      }
                    } catch (_dkErr) {
                      log.debug('Lines', `Phase-2 DK one-sided lookup error for ${playerName} ${propType} ${matchingProp.line}: ${_dkErr.message}`);
                    }
                  }
                  if (_oneSidedHit) {
                    const _fairOver = _oneSidedHit.impliedOver;
                    let _bookPriceOverride = null;
                    if (propType === 'hitter_hr' || propType === 'hitter_rbi_runs') {
                      const _raw = _oneSidedHit.rawImpliedOver;
                      const _sweet = (config.pricing && config.pricing.propBookMirrorSweetener != null)
                        ? config.pricing.propBookMirrorSweetener : 0.005;
                      if (_raw != null && _raw > 0 && _raw < 1) {
                        _bookPriceOverride = Math.max(0.005, Math.min(0.98, _raw * (1 - _sweet)));
                      }
                    }
                    foundInfo = {
                      sport: sportKey,
                      pxEventId: eventId,
                      pxEventName: event.name,
                      marketType: _propMarketType(propType),
                      marketName: market.name,
                      selection: 'over',
                      teamName: playerName,
                      line: matchingProp.line,
                      homeTeam: matchedHome,
                      awayTeam: matchedAway,
                      oddsApiSport: sportKey,
                      oddsApiMarket: toaMarketKey,
                      oddsApiSelection: 'over',
                      startTime: event.scheduled || null,
                      onDemand: true,
                      playerName,
                      propType,
                      fairProb: _fairOver,
                      fairProbOver: _fairOver,
                      fairProbUnder: 1 - _fairOver,
                      booksWithBothSides: 0,
                      bookPriceOverride: _bookPriceOverride,
                      propBooks: _oneSidedHit.books,
                      propSource: _oneSidedHit.source,
                      propFetchedAt: _oneSidedHit.fetchedAt || Date.now(),
                    };
                    lineFoundInPxMarket = true;
                    log.info('Lines', `Phase-2 one-sided prop registered: ${playerName} ${propType} over ${matchingProp.line} (fair=${_fairOver.toFixed(4)}, books=${_oneSidedHit.books.join(',')})`);
                    break;
                  }
                }
                // Lookup failed or insufficient books — log + fall through to decline.
                // "insufficient_books" now means: BOTH below minBooks AND no
                // trusted single book with both sides (the trustedAlone gate
                // above will have already accepted the latter).
                const reason = !lookup ? 'lookup_null'
                  : lookup.error ? lookup.error
                  : lookupBoth < minBooks ? `insufficient_books(${lookupBoth}<${minBooks},no_trusted_single)`
                  : 'no_fair_prob';
                log.info('Lines', `Phase-2 prop declined for ${playerName} ${propType} ${matchingProp.line}: ${reason}`);
              }
            }

            log.info('Lines', `Declined player prop market: ${market.type} / "${market.name}" (${event.name})`);
            _recordResolveFailure(lineId, {
              lineId,
              reason: 'player_prop_market',
              marketType: market.type,
              marketName: market.name,
              sport: sportKey,
              eventName: event.name,
            });
            return null;
          }
          continue;
        }
        // Reject sub-game/prop totals and spreads by sport-aware bounds.
        // F5 markets must be exempt — detect by NAME, not type, because PX
        // uses type='spread' / 'total' for F5 (only name distinguishes).
        // IMPORTANT: Previously we checked parsed[0].line and rejected the
        // ENTIRE market if that one line was out of bounds. PX bundles alt
        // lines inside market_lines, so a single spread market can contain
        // lines from -6.5 to +6.5. The first-line check would silently drop
        // the whole bundle — including the in-range alt we were trying to
        // resolve — causing thousands of spurious "line_not_in_markets"
        // failures per day. Fixed: defer the bound check to the specific
        // selection whose lineId matches. The matching branch below checks
        // sel.line against the sport bounds and rejects only that one.
        const isF5Market = f5NamePat.test(market.name || '');
        const parsed = px.parseMarketSelections(market);
        const mName = market.name || '';
        const isSeriesWinnerMarket = seriesWinnerNamePat.test(mName);
        const isSeriesSpreadMarket = seriesSpreadNamePat.test(mName);
        const isSeriesTotalMarket  = !isSeriesSpreadMarket && seriesTotalNamePat.test(mName);
        const isSeriesMarket = isSeriesWinnerMarket || isSeriesSpreadMarket || isSeriesTotalMarket;
        for (const sel of parsed) {
          if (sel.lineId !== lineId) continue;
          // Retag series selections so the pricer routes them to DK.
          if (isSeriesWinnerMarket && sel.marketType === 'moneyline') {
            sel.marketType = 'series_winner';
          } else if (isSeriesSpreadMarket && sel.marketType === 'spread') {
            sel.marketType = 'series_spread';
          } else if (isSeriesTotalMarket && sel.marketType === 'total' && sportKey !== 'tennis') {
            // Tennis "Total Games" → keep as 'total' (match-level). See
            // matching carve-out at line 902 — same reason: tennis match
            // totals route to the standard 'totals' cache, not the series
            // cache (which has no tennis data).
            sel.marketType = 'series_total';
          }
          // Per-selection bound check: rejects the specific out-of-range
          // alt line the RFQ asked about (e.g. Rangers -6.5) while leaving
          // siblings like Rangers -1.5 intact for future resolves. Series
          // markets bypass — series spreads/totals intentionally use lines
          // outside normal full-game bounds.
          if ((sel.marketType === 'total' || sel.marketType === 'spread') && !isF5Market && !isH1ByName && !isSeriesMarket) {
            if (!isValidFullGameLine(sportKey, sel.marketType, sel.line)) {
              log.debug('Lines', `resolveUnknownLine: rejecting out-of-bounds selection ${sel.marketType} ${sel.line} for ${sportKey}: ${market.name}`);
              lineFoundInPxMarket = true; // Line exists in PX — block virtual registration
              _recordResolveFailure(lineId, { lineId, reason: 'out_of_bounds_line', sport: sportKey, marketType: sel.marketType, line: sel.line, marketName: market.name });
              continue;
            }
          }
          // Determine oddsApiSelection
          let oddsApiSelection = null;
          let oddsApiMarket = MARKET_TYPE_MAP[sel.marketType];
          if (sel.marketType === 'series_winner') {
            const cleanTeam = (sel.teamName || '').replace(/\s*\(series\)\s*/ig, '').trim();
            if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
            else if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
            oddsApiMarket = 'series_winner';
          } else if (sel.marketType === 'series_spread') {
            const cleanTeam = (sel.teamName || '').replace(/\s*\(series\)\s*/ig, '').trim();
            if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
            else if (resolveHomeAwaySide(cleanTeam, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
            oddsApiMarket = 'series_spread';
          } else if (sel.marketType === 'series_total') {
            oddsApiSelection = sel.selection; // 'over' or 'under'
            oddsApiMarket = 'series_total';
          } else if (sel.marketType === 'moneyline') {
            // Reject YES/NO selections (see seed-path comment ~line 1148).
            if (/^(yes|no)$/i.test((sel.teamName || '').trim())) {
              lineFoundInPxMarket = true;
              _recordResolveFailure(lineId, {
                lineId, reason: 'yes_no_prop_misclassified_as_moneyline',
                marketType: market.type, marketName: market.name,
                sport: sportKey, eventName: event.name,
              });
              continue;
            }
            if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
            else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
          } else if (sel.marketType === 'spread') {
            // Explicit home/away match only — no substring fallback (see seed path).
            if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
              oddsApiSelection = 'home';
            } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
              oddsApiSelection = 'away';
            }
          } else if (sel.marketType === 'total') {
            oddsApiSelection = sel.selection;
          } else if (sel.marketType === 'team_total') {
            const teamSide = resolveTeamTotalSide(sel.teamName, matchedHome, matchedAway);
            if (!teamSide) continue;
            oddsApiSelection = teamSide + '_' + (sel.selection || 'over');
          } else if (sel.marketType === 'btts' || sel.marketType === 'both_teams_to_score') {
            oddsApiSelection = (sel.selection || '').toLowerCase();
          } else if (sel.marketType === 'double_chance') {
            oddsApiSelection = sel.selection;
          } else if (F5_MARKET_TYPES.includes(sel.marketType)) {
            if (sel.marketType.includes('moneyline')) {
              if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
              else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
            } else if (sel.marketType.includes('run_line')) {
              // Explicit home/away match only — no substring fallback.
              if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
                oddsApiSelection = 'home';
              } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
                oddsApiSelection = 'away';
              }
            } else if (sel.marketType.includes('total')) {
              oddsApiSelection = sel.selection;
            }
          } else if (FIRST_HALF_MARKET_TYPES.includes(sel.marketType)) {
            if (sel.marketType.includes('moneyline')) {
              if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') oddsApiSelection = 'home';
              else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') oddsApiSelection = 'away';
            } else if (sel.marketType.includes('spread')) {
              if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'home') {
                oddsApiSelection = 'home';
              } else if (resolveHomeAwaySide(sel.teamName, matchedHome, matchedAway) === 'away') {
                oddsApiSelection = 'away';
              }
            } else if (sel.marketType.includes('total')) {
              oddsApiSelection = sel.selection;
            }
          }
          if (!oddsApiSelection || !oddsApiMarket) {
            lineFoundInPxMarket = true; // Line exists in PX — block virtual registration
            continue;
          }

          const pxTime = event.scheduled || null;
          // Golf matchups: route through the round-aware accessor so we
          // don't confuse a round RFQ with a tournament matchup.
          let oddsEvt;
          let golfRoundNum = null;
          let golfMatchupType = null;
          if (sportKey === 'golf_matchups') {
            const nameRoundMatch = /\bR(?:ound\s*)?([1-4])\b/i.exec(event.name || '');
            golfRoundNum = nameRoundMatch ? parseInt(nameRoundMatch[1], 10) : null;
            golfMatchupType = golfRoundNum ? 'round' : 'tournament';
            oddsEvt = oddsFeed.getGolfMatchupEvent(matchedHome, matchedAway, golfRoundNum);
          } else {
            oddsEvt = oddsFeed.getEventMarkets(sportKey, matchedHome, matchedAway, pxTime);
          }
          // PX scheduled is authoritative; odds cache is unreliable (midnight UTC placeholder).
          const startTime = event.scheduled || oddsEvt?.commenceTime || null;

          // Skip PX 3-way sub-markets ("Arsenal To Win (90 Min)") — we don't
          // support them and the parser would fail to map Yes/No to home/away.
          if (market.type === 'moneyline' && /\bto win\b.*\(.*min.*\)|^draw\s*\(.*min.*\)/i.test(market.name || '')) {
            log.info('Lines', `Skipping PX 3-way sub-market on-demand: ${market.name}`);
            _recordResolveFailure(lineId, {
              lineId, reason: 'unsupported_market_type',
              marketType: market.type, marketName: market.name,
              sport: sportKey, eventName: event.name,
            });
            continue;
          }
          const onDemandDNB = market.type === 'moneyline' && /\b2\s*[\s\-_]?way\b|draw\s*no\s*bet|\bdnb\b|\b2w\b/i.test(market.name || '');
          foundInfo = {
            sport: sportKey,
            pxEventId: eventId,
            pxEventName: event.name,
            marketType: sel.marketType,
            marketName: market.name,
            isDNB: onDemandDNB,
            selection: oddsApiSelection,
            teamName: resolveDisplayTeamName(sel, matchedHome, matchedAway),
            line: sel.line,
            homeTeam: matchedHome,
            awayTeam: matchedAway,
            oddsApiSport: sportKey,
            oddsApiMarket,
            oddsApiSelection,
            competitorId: sel.competitorId,
            startTime,
            onDemand: true,
            // Golf-specific metadata from DataGolf cache
            tournamentName: oddsEvt?.eventName || null,
            roundNum: golfRoundNum ?? oddsEvt?.roundNum ?? null,
            matchupType: golfMatchupType ?? oddsEvt?.matchupType ?? null,
          };
          break;
        }
        if (foundInfo) break;
      }

      if (!foundInfo) {
        // Log what market types we DID find for this event (helps diagnose player props etc.)
        const foundTypes = (markets || []).map(m => m.type).filter(Boolean);
        const marketNames = (markets || []).map(m => m.name).filter(Boolean).slice(0, 5);

        // If the line_id was found in a PX market but rejected (out-of-bounds,
        // unmappable selection, player prop total, etc.), do NOT fall through
        // to virtual registration. PX already told us what this line is — the
        // heuristic would misidentify it (e.g. player prop O 1.5 → alt spread).
        if (lineFoundInPxMarket) {
          log.info('Lines', `Blocking virtual registration for line ${lineId}: found in PX market but rejected (${(_getResolveFailure(lineId) || resolveUnknownLine._lastFailure)?.reason || 'unknown'}). Event: ${event.name}`);
          return null;
        }

        // --- Virtual registration fallback ---
        // PX fetchMarkets often omits the specific alt-line the RFQ referenced.
        // If we have the event matched (home/away teams + sport) AND the RFQ leg
        // carries a numeric line, we can infer market type from context and
        // register a "virtual" entry so the pricer can fetch alt-line odds on
        // demand from The Odds API.
        const rfqLine = rfqLeg.line != null ? Number(rfqLeg.line) : null;
        if (matchedHome && matchedAway && rfqLine != null && !isNaN(rfqLine)) {
          // Determine market type from what we know about the event and the
          // line value. Strategy: look at existing registered lines for this
          // event to decide if this is a spread or total.
          const existingForEvent = Object.values(lineIndex).filter(
            li => li.pxEventId === eventId
          );
          const hasSpread = existingForEvent.some(li => li.marketType === 'spread');
          const hasTotal = existingForEvent.some(li => li.marketType === 'total');
          const primarySpread = existingForEvent.find(li => li.marketType === 'spread');
          const primaryTotal = existingForEvent.find(li => li.marketType === 'total');

          // Heuristic: totals have large abs values (e.g. 8.5 runs, 220.5 pts),
          // spreads have small abs values. Use sport-aware thresholds.
          const absLine = Math.abs(rfqLine);
          let inferredType = null;
          let inferredSelection = null;
          let inferredTeam = null;
          let inferredOddsMarket = null;

          // If we have a primary spread registered, compare magnitude.
          // Require the line to be within a sport-aware distance of the
          // primary spread. Without this, player prop lines (e.g. pitcher
          // K's O/U 4.5) that happen to fall within MAX_SPREAD_BY_SPORT
          // get misidentified as alt spreads. PX fetchMarkets often omits
          // player prop markets entirely, so the name-based check above
          // never fires — virtual registration is the last line of defense.
          if (hasSpread && primarySpread) {
            const primaryAbsSpread = Math.abs(primarySpread.line || 0);
            const maxSpread = MAX_SPREAD_BY_SPORT[sportKey] || 15;
            // Max deviation from primary: sport-aware. NBA/NCAAB alt spreads
            // can deviate ±15+, but MLB/NHL/soccer rarely deviate more than
            // ±3 from the primary run/puck line.
            // Only basketball and football get virtual alt spread registration
            // by *distance*. MLB uses a discrete allowlist instead.
            // FOOTBALL IS DELIBERATELY ABSENT (removed 2026-08-07, NFL
            // readiness audit). The rfq leg carries NO name here — only
            // lineId + line — so this inference cannot tell an alt spread
            // from a player prop. With NFL primary spreads at ~3-7, a
            // receptions 4.5 or pass-TDs 1.5 prop lands inside any usable
            // deviation window and would register as an "alt spread" priced
            // off the SPREAD LADDER — the same 2x-mispricing class as the
            // second-half trap. Football alt spreads therefore stay dark
            // until a name-carrying path exists; the entries that used to be
            // here (nfl/ncaaf: 15) were speculative, written before any
            // football quoting existed.
            // WATCH (October): basketball has the same shape — an NBA
            // rebounds 8.5 prop sits within ±20 of a typical spread. It was
            // built for NBA and has run there, but re-verify prop leakage
            // when the season opens.
            const MAX_ALT_DEVIATION = {
              'basketball_nba': 20, 'basketball_ncaab': 20, 'basketball_wnba': 20,
            };
            const maxDeviation = MAX_ALT_DEVIATION[sportKey] ?? 0;
            const deviation = Math.abs(absLine - primaryAbsSpread);
            // MLB-specific: allow values from the discrete allowlist
            // (default ±0.5 and ±1.5). Pricer enforces book coverage on
            // non-primary alts; we just need to virtually register so
            // the leg can reach the pricer in the first place.
            let mlbAllowed = false;
            if (sportKey === 'baseball_mlb') {
              const allowed = config.pricing.mlbAllowedRunLines || [0.5, 1.5];
              mlbAllowed = allowed.some(v => Math.abs(absLine - v) < 0.001);
            }
            if ((absLine <= maxSpread && deviation <= maxDeviation) || mlbAllowed) {
              inferredType = 'spread';
              // For spreads: negative line = favorite, positive = underdog.
              // Map to home/away using the primary spread's polarity.
              if (rfqLine < 0) {
                // Favorite side — same team as whoever has negative primary spread
                inferredSelection = primarySpread.oddsApiSelection || 'home';
                inferredTeam = primarySpread.teamName;
              } else {
                // Underdog side — opposite of the favorite
                const oppSel = primarySpread.oddsApiSelection === 'home' ? 'away' : 'home';
                inferredSelection = oppSel;
                inferredTeam = oppSel === 'home' ? matchedHome : matchedAway;
              }
              inferredOddsMarket = 'spreads';
            }
          }

          // If we didn't infer spread, check if it's a total
          if (!inferredType && hasTotal && primaryTotal) {
            const primaryAbsTotal = Math.abs(primaryTotal.line || 0);
            // Sport-aware tolerance:
            //   MLB: ±config.pricing.mlbAltTotalMaxDistance (default 1.5)
            //   Other sports: legacy 0.3x–2.0x heuristic
            let withinTolerance;
            if (sportKey === 'baseball_mlb') {
              const maxDist = config.pricing.mlbAltTotalMaxDistance || 1.5;
              withinTolerance = Math.abs(absLine - primaryAbsTotal) <= maxDist + 0.001;
            } else {
              withinTolerance = absLine >= primaryAbsTotal * 0.3 && absLine <= primaryAbsTotal * 2.0;
            }
            if (withinTolerance) {
              // Determine over/under by walking ALL of PX's markets for this
              // event (not gated by SUPPORTED_TYPES) and finding the lineId.
              // PX may register alt-total markets under a non-supported
              // market.type (e.g. 'alt_total') that the regular seed/walk
              // skips — but parseMarketSelections still extracts the side.
              let altSelection = null;
              for (const market of markets || []) {
                try {
                  const sels = px.parseMarketSelections(market);
                  const match = sels.find(s => s.lineId === lineId);
                  if (match && (match.selection === 'over' || match.selection === 'under')) {
                    altSelection = match.selection;
                    break;
                  }
                } catch (_) { /* skip unparseable market */ }
              }
              if (altSelection) {
                inferredType = 'total';
                inferredSelection = altSelection;
                inferredOddsMarket = 'totals';
              } else {
                log.debug('Lines', `Alt-total virtual reg: cannot determine over/under for ${event.name} line ${rfqLine} — lineId not found in any PX market selection`);
              }
            }
          }

          // Fallback: if no primary data in lineIndex, check odds feed
          // for a primary spread and require proximity to it.
          if (!inferredType && !hasSpread && !hasTotal) {
            const maxSpread = MAX_SPREAD_BY_SPORT[sportKey] || 15;
            if (absLine <= maxSpread) {
              // Without a primary spread in lineIndex, consult odds feed.
              // Require the line to be within sport-aware deviation of the
              // odds feed's primary spread to avoid misidentifying player
              // props as alt spreads.
              const pxTime = event.scheduled || null;
              const oddsEvt = oddsFeed.getEventMarkets(sportKey, matchedHome, matchedAway, pxTime);
              if (oddsEvt?.markets?.spreads) {
                const primaryHomePoint = oddsEvt.markets.spreads.home?.point;
                if (primaryHomePoint != null) {
                  const MAX_ALT_DEV_FALLBACK = {
                    'basketball_nba': 20, 'basketball_ncaab': 20, 'basketball_wnba': 20,
                    'americanfootball_nfl': 15, 'americanfootball_ncaaf': 15,
                  };
                  const maxDev = MAX_ALT_DEV_FALLBACK[sportKey] ?? 0;
                  const primaryAbs = Math.abs(primaryHomePoint);
                  const dev = Math.abs(absLine - primaryAbs);
                  if (dev > maxDev) {
                    log.info('Lines', `Virtual registration blocked: line ${rfqLine} deviates ${dev.toFixed(1)} from primary spread ${primaryHomePoint} (max ${maxDev}) for ${sportKey}. Likely player prop.`);
                  } else {
                    inferredType = 'spread';
                    const homeIsFav = primaryHomePoint < 0;
                    if (rfqLine < 0) {
                      inferredSelection = homeIsFav ? 'home' : 'away';
                      inferredTeam = homeIsFav ? matchedHome : matchedAway;
                    } else {
                      inferredSelection = homeIsFav ? 'away' : 'home';
                      inferredTeam = homeIsFav ? matchedAway : matchedHome;
                    }
                    inferredOddsMarket = 'spreads';
                  }
                }
              }
            }
          }

          if (inferredType === 'spread' && inferredSelection && inferredTeam) {
            const pxTime = event.scheduled || null;
            const oddsEvt = oddsFeed.getEventMarkets(sportKey, matchedHome, matchedAway, pxTime);
            const startTime = event.scheduled || oddsEvt?.commenceTime || null;

            foundInfo = {
              sport: sportKey,
              pxEventId: eventId,
              pxEventName: event.name,
              marketType: 'spread',
              marketName: `Virtual Alt Spread ${rfqLine}`,
              selection: inferredSelection,
              teamName: inferredTeam,
              line: rfqLine,
              homeTeam: matchedHome,
              awayTeam: matchedAway,
              oddsApiSport: sportKey,
              oddsApiMarket: 'spreads',
              oddsApiSelection: inferredSelection,
              startTime,
              onDemand: true,
              virtualRegistration: true,
            };
            log.info('Lines', `Virtual registration: ${sportKey} spread ${inferredTeam} ${rfqLine} for ${event.name} (line_id ${lineId} not in PX markets)`);
          } else if (inferredType === 'total' && (inferredSelection === 'over' || inferredSelection === 'under')) {
            const pxTime = event.scheduled || null;
            const oddsEvt = oddsFeed.getEventMarkets(sportKey, matchedHome, matchedAway, pxTime);
            const startTime = event.scheduled || oddsEvt?.commenceTime || null;

            foundInfo = {
              sport: sportKey,
              pxEventId: eventId,
              pxEventName: event.name,
              marketType: 'total',
              marketName: `Virtual Alt Total ${Math.abs(rfqLine)} ${inferredSelection}`,
              selection: inferredSelection,
              teamName: null,
              line: Math.abs(rfqLine),
              homeTeam: matchedHome,
              awayTeam: matchedAway,
              oddsApiSport: sportKey,
              oddsApiMarket: 'totals',
              oddsApiSelection: inferredSelection,
              startTime,
              onDemand: true,
              virtualRegistration: true,
            };
            log.info('Lines', `Virtual registration: ${sportKey} alt-total ${inferredSelection} ${Math.abs(rfqLine)} for ${event.name}`);
          }
        }

        if (!foundInfo) {
          log.debug('Lines', `Could not locate line ${lineId} in event ${eventId} markets (types found: ${foundTypes.join(',')}; names: ${marketNames.join(', ')}). RFQ leg: line=${rfqLeg.line}, keys=${Object.keys(rfqLeg).join(',')}`);
          _recordResolveFailure(lineId, { lineId, reason: 'line_not_in_markets', eventName: event.name, sport: sportKey, marketTypesFound: foundTypes, marketNamesFound: marketNames });
          return null;
        }
      }

      // Add to index locally
      foundInfo.lineId = lineId; // legExposureKey needs it — see _setSeedLine
      lineIndex[lineId] = foundInfo;
      _trackPrimaryForIndex(foundInfo);
      log.info('Lines', `On-demand registered ${sportKey}/${foundInfo.marketType} line for ${foundInfo.teamName} ${foundInfo.line != null ? foundInfo.line : ''} (${event.name})`);

      // Fire-and-forget PX registration — the RFQ we're responding to already
      // has the line_id, so we don't need to wait for PX to acknowledge.
      // Track it in the supported-set mirror so the next seed diff doesn't churn
      // it (and prunes it later if it stops being quotable). RULE 1 sync.
      _lastRegisteredLineIds.add(lineId);
      px.registerSupportedLines([lineId]).catch(err => {
        log.warn('Lines', `PX registration of ${lineId} failed: ${err.message}`);
      });

      // Fire-and-forget JIT alt-line warm. The current RFQ is already being
      // priced (its leg resolved via the primary-cache path or will on-demand
      // fetch inline), but the NEXT RFQ touching this same event will get a
      // warm cache hit instead of paying an on-demand fetch. Deduped internally
      // by the JIT function's in-flight map + TTL check.
      oddsFeed.warmEventAltLinesJIT({
        sport: foundInfo.sport,
        homeTeam: foundInfo.homeTeam,
        awayTeam: foundInfo.awayTeam,
        commenceTime: foundInfo.startTime,
      }).catch(err => {
        log.debug('Lines', `JIT warm (resolveUnknown) swallowed error: ${err.message}`);
      });

      // Resolved. Drop any failure record from an earlier attempt so the
      // decline categorizer can never read a stale entry for a line that is
      // now registered. This is the clear that used to sit at function entry.
      _failuresByLineId.delete(lineId);
      return foundInfo;
    } finally {
      inFlightResolutions.delete(lineId);
    }
  })();

  inFlightResolutions.set(lineId, promise);
  return promise;
}

function getRegisteredLineIds() {
  return Object.keys(lineIndex);
}

function getStats() {
  return lastSeedStats;
}

function getLineCount() {
  return Object.keys(lineIndex).length;
}

/**
 * Get a summary of lines by sport and market type.
 */
function getLineSummary() {
  const summary = {};
  for (const [lineId, info] of Object.entries(lineIndex)) {
    const key = `${info.sport}/${info.marketType}`;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// REFRESH
// ---------------------------------------------------------------------------

/**
 * Diagnostic: trace golf matchup matching step by step.
 * Returns a report showing exactly where each PX golf event matches or fails.
 */
async function debugGolfMatching() {
  const allEvents = await px.fetchSportEvents();
  const golfEvents = allEvents.filter(e =>
    e.sport_name === 'Golf' &&
    e.competitors && e.competitors.length >= 2 &&
    (!e.status || e.status !== 'settled')
  );

  const oddsApiEvents = oddsFeed.getAllCachedEvents();
  const golfOddsEvents = oddsApiEvents.filter(e => e.sport === 'golf_matchups');

  const possibleSportKeys = Object.entries(config.sportNameMap)
    .filter(([k, v]) => v === 'Golf')
    .map(([k]) => k);

  const report = {
    pxGolfEventsTotal: golfEvents.length,
    dataGolfEventsInCache: golfOddsEvents.length,
    possibleSportKeys,
    uniqueDataGolfPlayers: [...new Set(golfOddsEvents.flatMap(e => [e.homeTeam, e.awayTeam]))].sort(),
    eventResults: [],
  };

  for (const event of golfEvents.slice(0, 10)) {
    let homeComp = event.competitors.find(c => c.side === 'home');
    let awayComp = event.competitors.find(c => c.side === 'away');
    if (!homeComp && !awayComp && event.competitors.length >= 2) {
      homeComp = event.competitors[0];
      awayComp = event.competitors[1];
    }

    const result = {
      pxEvent: event.name,
      pxHome: homeComp?.name,
      pxAway: awayComp?.name,
      scheduled: event.scheduled,
      steps: {},
    };

    for (const tryKey of possibleSportKeys) {
      const allOddsTeams = oddsApiEvents
        .filter(e => e.sport === tryKey)
        .flatMap(e => [e.homeTeam, e.awayTeam]);
      const uniqueTeams = [...new Set(allOddsTeams)];

      result.steps[tryKey] = {
        oddsTeamCount: uniqueTeams.length,
        homeMatch: matchTeamName(homeComp?.name, uniqueTeams),
        awayMatch: matchTeamName(awayComp?.name, uniqueTeams),
      };

      const tryHome = result.steps[tryKey].homeMatch;
      const tryAway = result.steps[tryKey].awayMatch;

      if (tryHome && tryAway) {
        const pxTime = event.scheduled || null;
        const oddsEvt = oddsFeed.getEventMarkets(tryKey, tryHome, tryAway, pxTime);
        const oddsEvtRev = oddsFeed.getEventMarkets(tryKey, tryAway, tryHome, pxTime);
        result.steps[tryKey].getEventMarkets = {
          forward: oddsEvt ? { homeTeam: oddsEvt.homeTeam, awayTeam: oddsEvt.awayTeam, markets: Object.keys(oddsEvt.markets || {}) } : null,
          reverse: oddsEvtRev ? { homeTeam: oddsEvtRev.homeTeam, awayTeam: oddsEvtRev.awayTeam, markets: Object.keys(oddsEvtRev.markets || {}) } : null,
        };
        result.steps[tryKey].matched = !!(oddsEvt || oddsEvtRev);
      } else {
        result.steps[tryKey].matched = false;
      }
    }

    // Also try fetching PX markets for this event
    try {
      const markets = await px.fetchMarkets(event.event_id);
      result.pxMarkets = markets.map(m => ({ type: m.type, name: m.name, lineCount: (m.market_lines || []).length }));
    } catch (err) {
      result.pxMarkets = `Error: ${err.message}`;
    }

    report.eventResults.push(result);
  }

  return report;
}

/**
 * Re-seed lines (warm refresh, build-then-swap).
 *
 * Builds a fresh lineIndex/primaryByEvent in staging objects while the live
 * objects keep serving RFQ lookups and on-demand cache write-throughs. When
 * seed completes (inside seedAllLines, right before px.registerSupportedLines),
 * staging contents replace live contents in a single synchronous block —
 * atomic from any other code's perspective because JS is single-threaded.
 *
 * Eliminates the 10-90s window where the previous clear-then-rebuild design
 * had RFQs declining as "unknown legs" and the /health/coverage banner
 * flagging false-positive gaps mid-refresh.
 *
 * Safety: lineIndex stores routing metadata only (sport / market / selection
 * / team / line / startTime). Actual pricing odds come from oddsCache with
 * its own staleness gate (STALE_PRICE_MINUTES). Serving RFQs against
 * previous-refresh routing entries cannot produce stale pricing — line_ids
 * are immutable per market, and pricer.shouldDecline catches event-started
 * lines via startTime regardless of how recently they were registered.
 *
 * If seed throws, the targets are cleared in the catch so subsequent cache
 * write-throughs don't accidentally write into an abandoned staging object;
 * the live index remains intact (we never swapped) so RFQs keep working off
 * the prior refresh's data until the next cycle succeeds.
 */
async function refreshLines() {
  log.info('Lines', 'Refreshing all lines (build-then-swap)...');
  _seedIndexTarget = {};
  _seedPrimaryTarget = {};
  try {
    return await seedAllLines();
  } catch (err) {
    // Seed failed mid-build. The swap-block inside seedAllLines never ran,
    // so live lineIndex/primaryByEvent are untouched. Just clear the
    // staging targets so any post-failure cache write-through (e.g. a
    // resolveUnknownLine that races in right after the throw) writes to
    // live and not to the dead staging object.
    _seedIndexTarget = null;
    _seedPrimaryTarget = null;
    throw err;
  }
}

/**
 * Resolve a tournament_id to a human-readable name.
 */
function getTournamentName(tournamentId) {
  const t = tournamentIndex[tournamentId];
  return t ? `${t.name} (${t.sport})` : null;
}

/**
 * Resolve a sport_event_id to event name.
 */
function getEventName(eventId) {
  const e = eventIndex[eventId];
  return e ? e.name : null;
}

/**
 * Get full event info for a sport_event_id (sport, name, competitors, scheduled).
 */
function getEventInfo(eventId) {
  return eventIndex[eventId] || null;
}

/**
 * Find the primary total line for a given pxEventId. Returns the
 * absolute over/under value (e.g., 215.5 for an NBA game with O/U
 * 215.5). Used by the alt-total block for NBA: a leg's distance from
 * this value determines whether it's an allowed near-primary alt or
 * a banned far-out alt.
 *
 * "Primary" = the total line the line manager pre-registered from the
 * SharpAPI feed (onDemand=false). Excludes virtually-registered
 * (onDemand=true) entries. Returns null when no primary total is
 * registered for the event.
 *
 * Both over and under selections share the same line value, so we
 * just take the first non-onDemand total leg we find.
 */
function getPrimaryTotalLine(pxEventId) {
  if (pxEventId == null) return null;
  const slot = primaryByEvent[pxEventId];
  if (!slot) return null;
  // Prefer median of all seen totals when we have ≥3 lines for this
  // event. Median converges to the main even when PX seeded alts
  // before the main (the bug we fixed for spreads, applied here too
  // with a different — more robust — heuristic). Fall back to first-
  // seen for sparse events with <3 lines.
  const seenSet = slot.seenTotalLines;
  if (seenSet && seenSet.size >= 3) {
    const sorted = [...seenSet].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
  if (!slot.total) return null;
  const li = slot.total;
  if (li.line == null || !Number.isFinite(Number(li.line))) return null;
  return Math.abs(Number(li.line));
}

/**
 * Find the primary spread line for a given pxEventId, expressed in
 * home-team perspective (signed). Used by the alt-spread block for
 * NBA: a leg's distance from this value determines whether it's an
 * allowed near-primary alt or a banned far-out alt.
 *
 * "Primary" = the spread leg the line manager pre-registered from the
 * SharpAPI feed (onDemand=false). Excludes virtually-registered
 * (onDemand=true) entries that came from RFQ-driven on-demand fetches.
 *
 * Returns null when:
 *   - No spread line registered for this event yet
 *   - All registered spreads are onDemand=true (no primary anchor)
 *   - eventId is null/undefined
 *
 * For NBA games we expect exactly one primary spread per event; if
 * multiple are found (unusual), returns the first non-onDemand match.
 */
function getPrimarySpreadHomePoint(pxEventId) {
  if (pxEventId == null) return null;
  const slot = primaryByEvent[pxEventId];
  if (!slot || !slot.spread) return null;
  const li = slot.spread;
  if (li.line == null || !Number.isFinite(Number(li.line))) return null;
  const lineNum = Number(li.line);
  if (li.oddsApiSelection === 'home' || li.selection === 'home') return lineNum;
  if (li.oddsApiSelection === 'away' || li.selection === 'away') return -lineNum;
  log.debug('Lines', `getPrimarySpreadHomePoint: unknown selection on primary spread for event ${pxEventId} — assuming home-perspective. line=${lineNum}`);
  return lineNum;
}

module.exports = {
  seedAllLines,
  refreshLines,
  lookupLine,
  // Exported for test/line-removal-breaker.test.js
  _removalBreakerFires,
  lookupLineAsync,
  __debugGetLineIndex,
  // Exposed for tests + one-off audits of side attribution (see
  // test/home-away-side-assignment.test.js and the 2026-08-18 prod sweep).
  __debugResolveHomeAwaySide: resolveHomeAwaySide,
  resolveUnknownLine,
  getResolveFailure: _getResolveFailure,
  getResolveFailuresSnapshot: () => Array.from(_failuresByLineId.entries()),
  getRegisteredLineIds,
  getStats,
  getLineCount,
  getLineSummary,
  matchTeamName,
  normalizeTeamName,
  getTournamentName,
  getEventName,
  getEventInfo,
  getPrimarySpreadHomePoint,
  getPrimaryTotalLine,
  debugGolfMatching,
  // Exported for test/football-lines.test.js
  _isValidFullGameLine: isValidFullGameLine,
  _resolveTeamTotalSide: resolveTeamTotalSide,
  _FOOTBALL_PROP_TO_TOA_MARKET,
  _footballPropCtx,
  _footballPropRegistrationSafe,
  _propMarketType,
  // Manual disable controls
  isLineDisabled,
  isPxEventDisabled,
  disableLine,
  enableLine,
  disablePxEvent,
  enablePxEvent,
  getDisabledSnapshot,
  hydrateDisabledFromDb,
  // Manual line-odds override
  getManualLineOdds,
  hasManualLineOdds,
  setManualLineOdds,
  clearManualLineOdds,
  getManualLineOddsSnapshot,
  hydrateManualLineOddsFromDb,
};
