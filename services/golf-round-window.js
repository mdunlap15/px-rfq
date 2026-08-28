'use strict';
/**
 * Golf outright QUOTING WINDOW.
 *
 * Operator directive 2026-08-28: quote golf outrights from 19:00 ET each day a
 * tournament is in play, until the start of the next day's round — and not
 * while a round is being played. Between rounds the field is static and the
 * board is stable; once players are on the course, outright prices move with
 * live scoring that our board does not see.
 *
 * TEE TIMES COME FROM THE FULL FIELD, NOT FROM PX MATCHUPS. PX posts only a
 * subset of pairings, so its earliest tee time is an UPPER BOUND on the round
 * start. Measured 2026-08-28 at the TOUR Championship: DataGolf's full field
 * starts 11:00 (Cameron Young, in no PX pairing) while PX's earliest matchup is
 * 11:12 — twelve minutes of quoting with a player already on the course. On a
 * 156-player event where PX posts ~14 matchups that gap is hours, so this reads
 * DataGolf /field-updates, which carries a teetime for every player.
 *
 * THE RULE (spans midnight, which is why it is not a naive "is it after 7pm"):
 *   lastOpen  = the most recent 19:00 ET at or before now
 *   nextStart = the earliest tee time strictly AFTER lastOpen
 *   open      = now < nextStart   (or nextStart unknown)
 *
 * Anchoring nextStart to lastOpen rather than to `now` is the load-bearing
 * part. Anchored to `now`, at 11:30 — mid-round — today's 11:00 tee is already
 * past, so the "next" tee becomes TOMORROW's and the window reads open through
 * the whole round. Anchored to lastOpen it still sees today's 11:00 and
 * correctly reads closed.
 *
 * Fails CLOSED: no field data, a stale board, or an unparseable tee time all
 * mean "do not quote". Missing volume is cheap; quoting outrights blind during
 * live play is the thing being prevented.
 */
const log = require('./logger');
const { config } = require('../config');

let _cache = null;      // { at, currentRound, eventName, tees: [ms], tzOffsetSec }
let _inFlight = null;
let _lastError = null;

/** The most recent HH:MM ET at or before `nowMs`, as epoch ms. */
function lastEtBoundary(nowMs, hhmm) {
  const [h, m] = String(hhmm || '19:00').split(':').map(Number);
  // Read "now" in ET so the boundary is built from the ET calendar day, which
  // is what makes this DST-correct without hardcoding an offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  const etHour = Number(p.hour), etMin = Number(p.minute);
  // Offset between ET and UTC right now, derived rather than assumed.
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), etHour, etMin);
  const offsetMs = asUtc - (Math.floor(nowMs / 60000) * 60000);
  let boundary = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, m) - offsetMs;
  if (boundary > nowMs) boundary -= 24 * 3600 * 1000;   // not reached today → yesterday's
  return boundary;
}

/** "2026-08-28 11:00" in course-local time + tz_offset seconds → epoch ms. */
function teeToMs(teetime, tzOffsetSec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(teetime || ''));
  if (!m) return null;
  const localAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = Number(tzOffsetSec);
  if (!Number.isFinite(off)) return null;
  return localAsUtc - off * 1000;      // local - offset = true UTC
}

async function refresh({ force = false } = {}) {
  const cfg = config.golfOutrightWindow || {};
  const ttlMs = (cfg.ttlMinutes || 15) * 60000;
  if (!force && _cache && Date.now() - _cache.at < ttlMs) return _cache;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const base = config.dataGolf.baseUrl, key = config.dataGolf.apiKey;
      if (!key) throw new Error('no DATAGOLF_API_KEY');
      const tour = cfg.tour || 'pga';
      const r = await fetch(`${base}/field-updates?tour=${tour}&file_format=json&key=${key}`);
      if (!r.ok) throw new Error(`field-updates HTTP ${r.status}`);
      const d = await r.json();
      const tz = d.tz_offset;
      const tees = [];
      for (const p of (d.field || [])) {
        for (const t of (p.teetimes || [])) {
          const ms = teeToMs(t.teetime, tz);
          if (ms != null) tees.push(ms);
        }
      }
      if (!tees.length) throw new Error(`no tee times in field-updates (event="${d.event_name}", field=${(d.field || []).length})`);
      _cache = { at: Date.now(), currentRound: d.current_round, eventName: d.event_name, tees, tzOffsetSec: tz };
      _lastError = null;
      return _cache;
    } catch (err) {
      _lastError = err.message;
      log.warn('GolfWindow', `field-updates refresh failed: ${err.message}`);
      return null;          // keep any previous cache; age is checked on read
    } finally { _inFlight = null; }
  })();
  return _inFlight;
}

/**
 * Is the golf-outright quoting window open at `nowMs`?
 * Pure read of the cache — safe on the RFQ hot path.
 */
function getWindow(nowMs = Date.now()) {
  const cfg = config.golfOutrightWindow || {};
  if (!cfg.enabled) return { open: true, reason: 'window disabled — no gating', enabled: false };

  const maxAgeMs = (cfg.maxAgeMinutes || 180) * 60000;
  if (!_cache) return { open: false, reason: 'no field data — failing closed', enabled: true };
  if (nowMs - _cache.at > maxAgeMs) {
    return { open: false, reason: `field data ${Math.round((nowMs - _cache.at) / 60000)}min stale — failing closed`, enabled: true };
  }

  const lastOpen = lastEtBoundary(nowMs, cfg.openEt || '19:00');
  // Earliest tee AFTER the window opened. Anchoring to lastOpen (not to now) is
  // what keeps a mid-round check from skipping ahead to tomorrow's tee time.
  let nextStart = null;
  for (const t of _cache.tees) {
    if (t > lastOpen && (nextStart == null || t < nextStart)) nextStart = t;
  }
  if (nextStart == null) {
    return {
      open: true, enabled: true, lastOpen, nextStart: null,
      reason: `open since ${new Date(lastOpen).toISOString()} — no tee time published after it`,
      currentRound: _cache.currentRound, eventName: _cache.eventName,
    };
  }
  const open = nowMs < nextStart;
  return {
    open, enabled: true, lastOpen, nextStart,
    currentRound: _cache.currentRound, eventName: _cache.eventName,
    reason: open
      ? `open — next round starts ${new Date(nextStart).toISOString()}`
      : `closed — round started ${new Date(nextStart).toISOString()}, reopens ${new Date(lastEtBoundary(nowMs, cfg.openEt || '19:00') + 24 * 3600 * 1000).toISOString()}`,
  };
}

const isOpen = (nowMs) => getWindow(nowMs).open;

function getStatus() {
  const w = getWindow();
  return {
    ...w,
    lastOpenEt: w.lastOpen ? new Date(w.lastOpen).toLocaleString('en-US', { timeZone: 'America/New_York' }) : null,
    nextStartEt: w.nextStart ? new Date(w.nextStart).toLocaleString('en-US', { timeZone: 'America/New_York' }) : null,
    fieldTeeTimes: _cache ? _cache.tees.length : 0,
    ageMinutes: _cache ? +((Date.now() - _cache.at) / 60000).toFixed(1) : null,
    lastError: _lastError,
  };
}

module.exports = {
  refresh, getWindow, isOpen, getStatus,
  // test seams
  lastEtBoundary, teeToMs,
  _setCacheForTest: (tees, at, currentRound) => { _cache = tees ? { at: at || Date.now(), tees, currentRound: currentRound || 1, eventName: 'test', tzOffsetSec: -14400 } : null; },
};
