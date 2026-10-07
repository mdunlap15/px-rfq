/**
 * RFQ watch list for the order book's line guards (2026-10-06).
 *
 * Operator: "build the watch mode" — RFQ lines the order book does not hold
 * should be monitored by the SAME guards that monitor the order book. Every
 * ~60 s we publish, per guard profile, the events RFQ has been quoting in the
 * last RFQ_WATCH_ACTIVE_MIN minutes that start within RFQ_WATCH_HOURS:
 *
 *   kv px_rfq_watch_<soccer|nhl|mlb|cfb|nfl> =
 *     { ts, events: { <pxEventId>: { s: oddsApiSport, h: home, a: away, t: startIso, l: [lineIds] } } }
 *
 * h / a are the Odds API's OWN team names (the names our odds feed matched),
 * so the guard can find the Odds API event exactly even for games the order
 * book never posted. The guards add these lines to the pass they already run,
 * grade them read-only (never cancel) and publish both candidate fairs to the
 * relay (ob-relay.js), so a parlay leg on them prices off the order book's
 * method, refreshed at the order book's cadence.
 *
 * Activity-driven on purpose: the guards share the Odds API key with every
 * poster, and the key is frequency-limited — watching every registered event
 * would multiply calls for games nobody is parlaying.
 */
const log = require('./logger');

const PROFILE_OF = (sport) => {
  if (!sport) return null;
  if (sport.startsWith('soccer')) return 'soccer';
  if (sport === 'icehockey_nhl') return 'nhl';
  if (sport === 'baseball_mlb') return 'mlb';
  if (sport === 'americanfootball_ncaaf') return 'cfb';
  if (sport === 'americanfootball_nfl') return 'nfl';
  return null;
};
const PROFILES = ['soccer', 'nhl', 'mlb', 'cfb', 'nfl'];

const _active = new Map();      // pxEventId -> last quoted ms
const _activeAll = new Map();   // same, EVERY sport (near-start refresh priority)
const _lastWritten = {};        // profile -> { sig, at }
const _stats = { writes: 0, writeErrors: 0, lastError: null, watched: {} };
let _timer = null;

const activeMin = () => Math.max(5, Number(process.env.RFQ_WATCH_ACTIVE_MIN) || 30);
const horizonH = () => Math.max(1, Number(process.env.RFQ_WATCH_HOURS) || 8);
const maxEvents = () => Math.max(5, Number(process.env.RFQ_WATCH_MAX_EVENTS) || 40);
const enabled = () => process.env.RFQ_WATCH_ENABLED !== 'false';

/** Called from the pricer for every priced parlay. O(legs); never throws. */
function touch(lineInfos) {
  try {
    const now = Date.now();
    for (const li of lineInfos || []) {
      if (!li || li.pxEventId == null) continue;
      _activeAll.set(String(li.pxEventId), now);
      if (PROFILE_OF(li.oddsApiSport || li.sport)) _active.set(String(li.pxEventId), now);
    }
  } catch (_) { /* never on the hot path's way */ }
}

function build(nowMs = Date.now()) {
  const lineManager = require('./line-manager');
  const idx = lineManager.__debugGetLineIndex ? lineManager.__debugGetLineIndex() : {};
  const cutoff = nowMs - activeMin() * 60e3;
  for (const [eid, t] of _active) if (t < cutoff) _active.delete(eid);
  const byProfile = {};
  for (const p of PROFILES) byProfile[p] = {};
  for (const [lid, li] of Object.entries(idx || {})) {
    if (!li || li.pxEventId == null) continue;
    const eid = String(li.pxEventId);
    if (!_active.has(eid)) continue;
    const prof = PROFILE_OF(li.oddsApiSport || li.sport);
    if (!prof) continue;
    const start = Date.parse(li.startTime || '');
    if (!Number.isFinite(start) || start <= nowMs || start > nowMs + horizonH() * 3600e3) continue;
    const ev = byProfile[prof][eid] || (byProfile[prof][eid] = {
      s: li.oddsApiSport || li.sport, h: li.homeTeam || null, a: li.awayTeam || null, t: new Date(start).toISOString(), l: [],
    });
    ev.l.push(lid);
  }
  for (const p of PROFILES) {
    const evs = Object.entries(byProfile[p]).sort((x, y) => Date.parse(x[1].t) - Date.parse(y[1].t)).slice(0, maxEvents());
    byProfile[p] = Object.fromEntries(evs.map(([eid, e]) => [eid, { ...e, l: e.l.sort() }]));
  }
  return byProfile;
}

async function publish() {
  if (!enabled()) return;
  const db = require('./db');
  if (!db.isAvailable || !db.isAvailable()) return;
  const lists = build();
  for (const p of PROFILES) {
    const events = lists[p];
    _stats.watched[p] = Object.keys(events).length;
    const sig = JSON.stringify(events);
    const prev = _lastWritten[p];
    // Write when the set changes, else a heartbeat every 5 min so the guard can
    // tell a quiet watch list from a dead publisher.
    if (prev && prev.sig === sig && Date.now() - prev.at < 5 * 60e3) continue;
    try {
      const r = await db.saveKV('px_rfq_watch_' + p, { ts: Math.floor(Date.now() / 1000), events });
      if (!r || r.ok === false) throw new Error((r && (r.error && (r.error.message || r.error))) || 'kv not saved');
      _lastWritten[p] = { sig, at: Date.now() };
      _stats.writes++;
    } catch (e) {
      _stats.writeErrors++; _stats.lastError = e.message;
      log.debug('RfqWatch', `publish ${p} failed: ${e.message}`);
    }
  }
}

function start() {
  if (_timer) return;
  const sec = Math.max(30, Number(process.env.RFQ_WATCH_PUBLISH_SEC) || 60);
  _timer = setInterval(() => { publish().catch(() => {}); }, sec * 1000);
  if (_timer.unref) _timer.unref();
}

function getStatus() {
  return { enabled: enabled(), activeEvents: _active.size, activeMin: activeMin(), horizonH: horizonH(), ..._stats };
}

/** pxEventId -> last quoted ms, every sport, within RFQ_WATCH_ACTIVE_MIN. */
function activeEvents(nowMs = Date.now()) {
  const cutoff = nowMs - activeMin() * 60e3;
  for (const [eid, t] of _activeAll) if (t < cutoff) _activeAll.delete(eid);
  return _activeAll;
}

function __resetForTest() { _active.clear(); _activeAll.clear(); for (const k of Object.keys(_lastWritten)) delete _lastWritten[k]; }

module.exports = { touch, activeEvents, build, publish, start, getStatus, PROFILE_OF, __resetForTest };
