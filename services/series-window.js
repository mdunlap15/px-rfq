/**
 * MLB playoff SERIES quote window.
 *
 * Operator directive 2026-09-28: "Let's also quote MLB wild card series
 * markets. $1.5K stakes. Make sure they come off the board at the start of
 * Game 1's of each series."
 *
 * A series market is open ONLY until the first pitch of Game 1 of that
 * series, and never reopens. None of the obvious signals is enough on its
 * own:
 *   - DK's series event `startEventDate` is ROUND-level: all four 2026 Wild
 *     Card series carry 2026-09-29T18:00Z even though Game 1s run 18:00Z,
 *     21:00Z, 00:00Z and 02:00Z. Using it closes three series 3-8h early.
 *   - PX's series event start equals Game 1's start today, and the generic
 *     started-event gate declines on it, BUT PX advances a series event's
 *     start to the next game (that is how NBA/NHL series kept quoting between
 *     games). Once that happens the generic gate re-opens the series.
 * So the close time is LATCHED: the earliest start ever observed for the
 * matchup (the PX series event's own start, and the start of any same-matchup
 * MLB game in the line index), kept as a running minimum that can only move
 * EARLIER, and persisted to kv_store so a restart between games cannot lose
 * it. Unknown/unparseable start → closed (fail closed).
 *
 * Scope: baseball_mlb series_* lines only. NBA/NHL series keep their
 * between-games quoting behaviour.
 */
const log = require('./logger');

const KV_KEY = 'mlb_series_first_start';
// A latch older than this is dropped at hydrate/persist time: two teams meet
// at most once per postseason, and next year's series must not inherit it.
const LATCH_RETENTION_MS = 45 * 24 * 3600 * 1000;

const _firstStart = new Map(); // pairKey -> earliest start ms observed
let _persistTimer = null;

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

function _schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const db = require('./db');
      const now = Date.now();
      const out = {};
      for (const [k, ms] of _firstStart) {
        if (now - ms < LATCH_RETENTION_MS) out[k] = new Date(ms).toISOString();
      }
      Promise.resolve(db.saveKV(KV_KEY, out)).catch(() => {});
    } catch (_) { /* persistence is best-effort; the in-memory latch still holds */ }
  }, 2000);
  if (_persistTimer.unref) _persistTimer.unref();
}

/** Record an observed start for a matchup. Only ever moves the latch EARLIER. */
function noteStart(a, b, start) {
  const key = pairKey(a, b);
  const ms = typeof start === 'number' ? start : Date.parse(start);
  if (!key || !Number.isFinite(ms)) return null;
  const prev = _firstStart.get(key);
  if (prev == null || ms < prev) {
    _firstStart.set(key, ms);
    _schedulePersist();
  }
  return _firstStart.get(key);
}

/**
 * Close time (ms) for an MLB series line: min(series event start, earliest
 * same-matchup game start supplied by the caller, latched minimum). Records
 * what it sees. Returns null when nothing parseable is known.
 */
function closeAtMs(info, extraStarts = []) {
  if (!info) return null;
  const a = info.homeTeam, b = info.awayTeam;
  const candidates = [info.startTimeMs, info.startTime, ...(extraStarts || [])];
  for (const c of candidates) {
    if (c == null) continue;
    noteStart(a, b, c);
  }
  const key = pairKey(a, b);
  return key ? (_firstStart.get(key) ?? null) : null;
}

/**
 * True when an MLB series line must not quote / register. Non-MLB-series
 * lines always return false. Fails CLOSED on an unknown close time.
 */
function isClosed(info, { now = Date.now(), extraStarts = [] } = {}) {
  if (!isMlbSeriesLine(info)) return false;
  const closeAt = closeAtMs(info, extraStarts);
  if (closeAt == null) return true;
  return now >= closeAt;
}

async function hydrate() {
  try {
    const db = require('./db');
    const saved = await db.loadKV(KV_KEY);
    if (!saved || typeof saved !== 'object') return 0;
    const now = Date.now();
    let n = 0;
    for (const [key, iso] of Object.entries(saved)) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms) || now - ms >= LATCH_RETENTION_MS) continue;
      const prev = _firstStart.get(key);
      if (prev == null || ms < prev) _firstStart.set(key, ms);
      n++;
    }
    if (n) log.info('SeriesWindow', `Hydrated ${n} MLB series close latch(es) from kv_store`);
    return n;
  } catch (err) {
    log.warn('SeriesWindow', `hydrate failed (latch starts empty): ${err.message}`);
    return 0;
  }
}

function getState(now = Date.now()) {
  const out = {};
  for (const [k, ms] of _firstStart) {
    out[k] = { closesAt: new Date(ms).toISOString(), closed: now >= ms };
  }
  return out;
}

function __resetForTest() {
  _firstStart.clear();
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
}

module.exports = {
  pairKey,
  isMlbSeriesLine,
  noteStart,
  closeAtMs,
  isClosed,
  hydrate,
  getState,
  KV_KEY,
  __resetForTest,
};
