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
let _lastRefreshAt = null;
let _lastErrors = {};
let _timer = null;

function _norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.'`]/g, '').replace(/\s+/g, ' ').trim();
}

function _normTeam(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
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
      log.debug('Roster', `${leaguePath} team ${t.id} roster failed: ${e.message}`);
    }
  }
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
      // replace a good map (fail toward the existing data).
      if (map.size >= 50) {
        _maps[sport] = map;
        delete _lastErrors[sport];
      } else {
        _lastErrors[sport] = `refresh returned only ${map.size} players — kept previous map`;
        log.warn('Roster', `${sport}: ${_lastErrors[sport]}`);
      }
    } catch (err) {
      _lastErrors[sport] = err.message;
      log.warn('Roster', `${sport} refresh failed: ${err.message}`);
    }
  }
  _lastRefreshAt = Date.now();
  log.info('Roster', `refreshed: ${Object.entries(_maps).map(([s, m]) => s + '=' + m.size).join(', ') || 'none'}`);
}

function startPolling() {
  if (_timer) return;
  refresh().catch(() => {});
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
    lastRefreshAt: _lastRefreshAt ? new Date(_lastRefreshAt).toISOString() : null,
    errors: _lastErrors,
    refreshHours: REFRESH_HOURS,
  };
}

// Test hook: inject a synthetic map (suite must not hit the network).
function __setTestMap(sport, entries) {
  const map = new Map();
  for (const [player, teamName] of entries) map.set(_norm(player), { teamName, ambiguous: false });
  _maps[sport] = map;
}

module.exports = { refresh, startPolling, getPlayerTeam, getPlayerSide, getStatus, __setTestMap };
