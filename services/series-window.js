/**
 * MLB playoff SERIES quote window.
 *
 * Operator directive 2026-09-29 (revising 9/28's "off at Game 1"): "The wild
 * card series are still in play. It's OK to quote them. We just shouldn't be
 * quoting any while games from them are in play."
 *
 * So a series market is:
 *   - CLOSED while any game between the two teams is in progress — from its
 *     first pitch until ESPN reports it final (fallback: MLB_SERIES_GAME_MAX_HOURS
 *     after first pitch when ESPN can't see the game);
 *   - for PRICING, additionally closed until the DK series board has been
 *     scraped at least MLB_SERIES_RELIST_GRACE_MIN after the most recent game
 *     ended. Right after a final, the cached DK price is the PRE-game price —
 *     quoting it would hand the bettor the result of the game just played.
 *
 * Game start times come from the caller (the PX series event's own start —
 * PX moves it to the next game — plus every same-matchup MLB game still in the
 * line index). DK's series startEventDate is ROUND-level and is ignored.
 */
const MAX_GAME_MS = (Number(process.env.MLB_SERIES_GAME_MAX_HOURS) || 5) * 3600e3;
const RELIST_GRACE_MS = (Number(process.env.MLB_SERIES_RELIST_GRACE_MIN) || 5) * 60e3;

// `${pairKey}|${startMs}` -> ms we first saw ESPN report the game final.
const _finalSeen = new Map();

function _norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(series\)/ig, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Order-independent key for a matchup; null when either side is missing. */
function pairKey(a, b) {
  const x = _norm(a), y = _norm(b);
  if (!x || !y) return null;
  return [x, y].sort().join('|');
}

function isMlbSeriesLine(info) {
  if (!info) return false;
  const sport = String(info.sport || info.oddsApiSport || '').toLowerCase();
  const mt = String(info.marketType || '');
  return sport === 'baseball_mlb' && mt.startsWith('series_');
}

function _defaultEspnLookup(g) {
  try {
    const espn = require('./espn-scores');
    return espn.getEspnGameResult('baseball_mlb', g.home, g.away, new Date(g.startMs).toISOString());
  } catch (_) { return null; }
}

/**
 * State of the matchup's games at `now`:
 *   { inPlay: bool, lastEndMs: ms|null, unknownStart: bool }
 * `games` = [{ startMs, home, away }]; the series line's own start is added.
 */
function matchupState(info, { now = Date.now(), games = [], espnLookup = _defaultEspnLookup } = {}) {
  const key = pairKey(info && info.homeTeam, info && info.awayTeam);
  const own = info ? (Number.isFinite(info.startTimeMs) ? info.startTimeMs : Date.parse(info.startTime)) : NaN;
  const all = [...(games || [])];
  if (Number.isFinite(own)) all.push({ startMs: own, home: info.homeTeam, away: info.awayTeam });
  const seen = new Set();
  let inPlay = false, lastEndMs = null;
  for (const g of all) {
    if (!g || !Number.isFinite(g.startMs) || seen.has(g.startMs)) continue;
    seen.add(g.startMs);
    if (g.startMs > now) continue;                       // not started
    const fk = key + '|' + g.startMs;
    let endMs = _finalSeen.get(fk);
    if (endMs == null) {
      const r = espnLookup ? espnLookup(g) : null;
      if (r && r.completed) { endMs = now; _finalSeen.set(fk, endMs); }
    }
    if (endMs == null && now - g.startMs >= MAX_GAME_MS) endMs = g.startMs + MAX_GAME_MS;
    if (endMs == null) { inPlay = true; continue; }
    if (lastEndMs == null || endMs > lastEndMs) lastEndMs = endMs;
  }
  return { inPlay, lastEndMs, unknownStart: !Number.isFinite(own) };
}

/** Registration gate: closed while a game is in play (or the start is unknown). */
function isClosed(info, opts = {}) {
  if (!isMlbSeriesLine(info)) return false;
  const st = matchupState(info, opts);
  return st.unknownStart || st.inPlay;
}

/**
 * Pricing gate: registration gate + the DK board must post-date the most
 * recent game's end by RELIST_GRACE_MS. `boardAtMs` = when the DK board was
 * scraped (null → closed).
 */
function isPriceable(info, { boardAtMs, ...opts } = {}) {
  if (!isMlbSeriesLine(info)) return true;
  const st = matchupState(info, opts);
  if (st.unknownStart || st.inPlay) return false;
  if (st.lastEndMs != null) {
    if (!Number.isFinite(boardAtMs) || boardAtMs < st.lastEndMs + RELIST_GRACE_MS) return false;
  }
  return true;
}

function getState() {
  const out = {};
  for (const [k, ms] of _finalSeen) out[k] = { finalSeenAt: new Date(ms).toISOString() };
  return out;
}

// Kept for boot-order compatibility (index.js awaits it); nothing persisted now.
async function hydrate() { return 0; }

function __resetForTest() { _finalSeen.clear(); }

module.exports = {
  pairKey,
  isMlbSeriesLine,
  matchupState,
  isClosed,
  isPriceable,
  hydrate,
  getState,
  MAX_GAME_MS,
  RELIST_GRACE_MS,
  __resetForTest,
};
