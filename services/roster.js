/**
 * Player→team identity service (SGP roadmap Stage 2 prerequisite).
 *
 * The cross-team prop-pair class (prop_prop_xteam) must prove two things
 * the line index cannot: that two prop legs are DIFFERENT humans, and that
 * they're on OPPOSITE teams. For props, lineInfo.teamName is the *player's*
 * name — there is no player→team resolution anywhere else in the codebase.
 *
 * Sources (both free, keyless, verified live 2026-06-12):
 *  - MLB: statsapi.mlb.com — ALL active players w/ currentTeam in ONE call
 *    (~1,200 rows) + one teams call for id→name.
 *  - NBA/WNBA: ESPN site API per-team rosters (site.api.espn.com), ~30
 *    calls per league, same host espn-scores.js already uses.
 *
 * Design rules:
 *  - SYNC lookups against an in-memory map (the pricer hot path calls this
 *    inside shouldDecline). Refresh is async on a timer.
 *  - FAIL CLOSED on ambiguity: if a normalized name maps to players on
 *    more than one team (e.g. two Luis Garcías), lookup returns null and
 *    the caller declines. Identity certainty beats coverage.
 *  - Names normalized with the same diacritic-stripping convention as the
 *    pricer/exposure systems.
 */
const log = require('./logger');

const REFRESH_HOURS = Number(process.env.ROSTER_REFRESH_HOURS) || 6;

// sport -> Map(normPlayer -> { teamName, ambiguous })
const _maps = {};
const _lastGoodRefreshAt = {}; // per-sport, set ONLY when a complete map swaps in
let _lastAttemptAt = null;     // last refresh attempt (success or not)
let _lastErrors = {};
let _timer = null;
// Lookups refuse maps older than this (review fix: staleness was unbounded —
// a wedged refresh would serve pre-trade identity forever; a wrong SIDE
// resolution prices a same-team pair with the small cross-team phi).
const MAX_AGE_HOURS = Number(process.env.ROSTER_MAX_AGE_HOURS) || 24;

function _norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.'`]/g, '').replace(/\s+/g, ' ').trim();
}

function _normTeam(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    // ESPN short-forms a few city names ("LA Clippers") while the odds feeds
    // use full forms ("Los Angeles Clippers") — without this bridge the side
    // matcher fails closed and the class is permanently dead for that team
    // (review fix).
    .replace(/^la /, 'los angeles ');
}

function _fetch() { return require('node-fetch'); }

async function _refreshMlb() {
  const fetch = _fetch();
  const [teamsRes, playersRes] = await Promise.all([
    fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1', { timeout: 15000 }).then(r => r.json()),
    fetch('https://statsapi.mlb.com/api/v1/sports/1/players?season=' + new Date().getFullYear() + '&fields=people,id,fullName,currentTeam,id', { timeout: 20000 }).then(r => r.json()),
  ]);
  const teamById = {};
  for (const t of (teamsRes.teams || [])) teamById[t.id] = t.name;
  const map = new Map();
  for (const p of (playersRes.people || [])) {
    const teamName = p.currentTeam && teamById[p.currentTeam.id];
    if (!teamName || !p.fullName) continue;
    const key = _norm(p.fullName);
    const existing = map.get(key);
    if (existing && existing.teamName !== teamName) existing.ambiguous = true;
    else if (!existing) map.set(key, { teamName, ambiguous: false });
  }
  return map;
}

async function _refreshEspnLeague(sportPath, leaguePath) {
  const fetch = _fetch();
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/${leaguePath}`;
  const teamsRes = await fetch(`${base}/teams?limit=50`, { timeout: 15000 }).then(r => r.json());
  const teams = ((teamsRes.sports || [])[0]?.leagues?.[0]?.teams || []).map(t => t.team).filter(Boolean);
  const map = new Map();
  let failedTeams = 0;
  for (const t of teams) {
    try {
      const ros = await fetch(`${base}/teams/${t.id}/roster`, { timeout: 15000 }).then(r => r.json());
      for (const a of (ros.athletes || [])) {
        const name = a.fullName || a.displayName;
        if (!name) continue;
        const key = _norm(name);
        const existing = map.get(key);
        if (existing && existing.teamName !== t.displayName) existing.ambiguous = true;
        else if (!existing) map.set(key, { teamName: t.displayName, ambiguous: false });
      }
      await new Promise(r => setTimeout(r, 120)); // gentle pacing
    } catch (e) {
      failedTeams++;
      log.warn('Roster', `${leaguePath} team ${t.id} roster failed: ${e.message}`);
    }
  }
  // A PARTIAL map must never replace a complete one (review fix): a missing
  // team silently drops duplicate-name ambiguity protection AND can flip a
  // side resolution to the wrong answer. All-or-nothing per league.
  if (failedTeams > 0) throw new Error(`${failedTeams}/${teams.length} team rosters failed — refusing partial map`);
  return map;
}

async function refresh() {
  const jobs = [
    ['baseball_mlb', _refreshMlb],
    ['basketball_nba', () => _refreshEspnLeague('basketball', 'nba')],
    ['basketball_wnba', () => _refreshEspnLeague('basketball', 'wnba')],
  ];
  for (const [sport, fn] of jobs) {
    try {
      const map = await fn();
      // Refuse suspiciously small results — a half-failed scrape must not
      // replace a good map (fail toward the existing data). Relative floor:
      // a new map must also reach 80% of the previous good map's size
      // (absolute 50 alone would let a 60-player WNBA fragment through).
      const prev = _maps[sport];
      const floor = Math.max(50, prev ? Math.floor(prev.size * 0.8) : 0);
      if (map.size >= floor) {
        _maps[sport] = map;
        _lastGoodRefreshAt[sport] = Date.now(); // ONLY on a complete swap
        delete _lastErrors[sport];
      } else {
        _lastErrors[sport] = `refresh returned only ${map.size} players (floor ${floor}) — kept previous map`;
        log.warn('Roster', `${sport}: ${_lastErrors[sport]}`);
      }
    } catch (err) {
      _lastErrors[sport] = err.message;
      log.warn('Roster', `${sport} refresh failed: ${err.message}`);
    }
  }
  _lastAttemptAt = Date.now();
  log.info('Roster', `refresh attempt done: ${Object.entries(_maps).map(([s, m]) => s + '=' + m.size).join(', ') || 'none'}`);
  _persistMaps(); // fire-and-forget — warm-load kills the restart-window drift
}

// KV persistence: a Railway restart wipes the in-memory maps, and every
// in-flight xteam confirm during the rebuild window would drift-reject
// (fail-closed but lost fills). Warm-loading the last good maps at boot
// removes the window entirely; the age cap still governs usability.
const ROSTER_KV_KEY = 'roster_maps_v1';
function _persistMaps() {
  try {
    const db = require('./db');
    const payload = { savedAt: Date.now(), goodAt: { ..._lastGoodRefreshAt }, sports: {} };
    for (const [sport, map] of Object.entries(_maps)) {
      payload.sports[sport] = [...map.entries()].map(([k, v]) => [k, v.teamName, v.ambiguous ? 1 : 0]);
    }
    db.saveKV(ROSTER_KV_KEY, payload).catch(() => {});
  } catch (_) { /* best-effort */ }
}
async function _warmLoad() {
  try {
    const db = require('./db');
    const row = await db.loadKV(ROSTER_KV_KEY);
    if (!row || !row.sports) return;
    for (const [sport, entries] of Object.entries(row.sports)) {
      if (_maps[sport]) continue; // live refresh already landed — keep it
      const map = new Map();
      for (const [k, teamName, amb] of entries) map.set(k, { teamName, ambiguous: !!amb });
      _maps[sport] = map;
      _lastGoodRefreshAt[sport] = (row.goodAt && row.goodAt[sport]) || row.savedAt;
    }
    log.info('Roster', `warm-loaded persisted maps: ${Object.entries(_maps).map(([s, m]) => s + '=' + m.size).join(', ')}`);
  } catch (err) {
    log.warn('Roster', `warm-load failed (cold start — xteam declines until first refresh): ${err.message}`);
  }
}

function startPolling() {
  if (_timer) return;
  _warmLoad().then(() => refresh()).catch(() => {});
  _timer = setInterval(() => refresh().catch(() => {}), REFRESH_HOURS * 3600 * 1000);
  if (_timer.unref) _timer.unref();
}

/**
 * SYNC: resolve a player to their team name. Returns null when the sport
 * has no map, the player is unknown, or the name is ambiguous (two players,
 * different teams). Callers must treat null as "decline".
 */
function getPlayerTeam(sport, playerName) {
  const map = _maps[sport];
  if (!map) return null;
  // Age cap (review fix): identity older than MAX_AGE_HOURS is refused —
  // a wedged refresh must degrade to declines, never to pre-trade teams.
  const goodAt = _lastGoodRefreshAt[sport];
  if (!goodAt || (Date.now() - goodAt) > MAX_AGE_HOURS * 3600 * 1000) return null;
  const hit = map.get(_norm(playerName));
  if (!hit || hit.ambiguous) return null;
  return hit.teamName;
}

/**
 * SYNC: resolve which SIDE of a game a player is on. Matches the roster
 * team name against the lineInfo's homeTeam/awayTeam using the codebase's
 * standard loose-matching ladder (exact normalized → substring → last-two-
 * words). Returns 'home' | 'away' | null (null ⇒ caller declines).
 */
function getPlayerSide(sport, playerName, homeTeam, awayTeam) {
  const team = getPlayerTeam(sport, playerName);
  if (!team || !homeTeam || !awayTeam) return null;
  const t = _normTeam(team), h = _normTeam(homeTeam), a = _normTeam(awayTeam);
  if (!t || !h || !a) return null;
  const match = (x, y) => {
    if (x === y) return true;
    if (x.includes(y) || y.includes(x)) return true;
    const lw = (s) => s.split(' ').slice(-2).join(' ');
    return lw(x) === lw(y);
  };
  const isHome = match(t, h), isAway = match(t, a);
  if (isHome === isAway) return null; // matched both or neither — ambiguous
  return isHome ? 'home' : 'away';
}

function getStatus() {
  return {
    sports: Object.fromEntries(Object.entries(_maps).map(([s, m]) => [s, m.size])),
    lastGoodRefreshAt: Object.fromEntries(Object.entries(_lastGoodRefreshAt).map(([s, t]) => [s, new Date(t).toISOString()])),
    lastAttemptAt: _lastAttemptAt ? new Date(_lastAttemptAt).toISOString() : null,
    maxAgeHours: MAX_AGE_HOURS,
    errors: _lastErrors,
    refreshHours: REFRESH_HOURS,
  };
}

// Test hook: inject a synthetic map (suite must not hit the network).
function __setTestMap(sport, entries) {
  const map = new Map();
  for (const [player, teamName] of entries) map.set(_norm(player), { teamName, ambiguous: false });
  _maps[sport] = map;
  _lastGoodRefreshAt[sport] = Date.now(); // synthetic maps are "fresh"
}

module.exports = { refresh, startPolling, getPlayerTeam, getPlayerSide, getStatus, __setTestMap };
