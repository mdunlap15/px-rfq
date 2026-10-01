// ESPN football AVAILABILITY GATE for player-prop registration (2026-10-01).
//
// Order-book mirror (operator directive 2026-10-01: "use the same methodology
// for RFQs"). The single-leg prop posters (cfb_props_cycle.py, nfl_game_cycle
// via player_status.py) never list a prop on a player ESPN's injury report
// marks Out / Injured Reserve / Doubtful / Suspended / Inactive — NFL inactives
// drop ~90 minutes before kickoff, i.e. INSIDE the prop window, so a board built
// without it quotes players who will not take a snap. "Questionable" is
// deliberately NOT blocked: it is extremely common and would gut the board.
//
// Same posture as the poster:
//   * game resolved from ESPN's scoreboard by BOTH team names, pinned to
//     kickoff (±6h); anything but exactly one match → gate INACTIVE (null);
//   * names keyed by a sorted-token signature (tokens > 1 char, suffixes
//     jr/sr/ii/iii/iv dropped);
//   * FAIL-OPEN: a failed read or unmatched game returns null and the caller
//     registers as before. This gate only ever REMOVES lines.
//
// Reads are cached (scoreboard + summary, ESPN_INJURY_TTL_SECONDS, default
// 300) and timeout-bounded, so a seed of N props on one game costs at most two
// ESPN requests per TTL. Never on the RFQ pricing hot path — registration only.
// Under `node --test` no network call is made unless a fetcher is injected.

const log = require('./logger');

const PATH = { americanfootball_nfl: 'nfl', americanfootball_nfl_preseason: 'nfl', americanfootball_ncaaf: 'college-football' };
const BLOCKING = ['out', 'injured reserve', 'doubtful', 'suspension', 'suspended',
  'physically unable', 'non football', 'did not play', 'inactive'];
const TTL_MS = (parseInt(process.env.ESPN_INJURY_TTL_SECONDS, 10) || 300) * 1000;
const TIMEOUT_MS = 6000;

let _fetcher = null;           // test injection: async (url) => json
const _cache = new Map();      // url -> { at, json }

function _inTest() {
  return !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test'
    || (process.execArgv || []).some(a => a === '--test' || a.startsWith('--test='));
}

async function _get(url) {
  const hit = _cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.json;
  let json = null;
  if (_fetcher) {
    json = await _fetcher(url);
  } else {
    if (_inTest() || typeof fetch !== 'function') return null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) json = await r.json();
    } finally { clearTimeout(t); }
  }
  if (json) _cache.set(url, { at: Date.now(), json });
  return json;
}

function sig(name) {
  const s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return s.split(/[^a-z]+/).filter(t => t.length > 1 && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(t)).sort().join(' ');
}
function _teamToks(name) {
  return new Set(String(name || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length > 1));
}
function isBlockedStatus(status) {
  const s = String(status || '').toLowerCase();
  return BLOCKING.some(b => s.includes(b));
}

// → Map(playerSig → status) of BLOCKED players, or null when the gate is
// inactive (unsupported sport, game not uniquely matched, read failed).
async function getBlockedPlayers(sportKey, awayTeam, homeTeam, scheduled) {
  const path = PATH[sportKey];
  if (!path || !awayTeam || !homeTeam) return null;
  try {
    const sbUrl = path === 'nfl'
      ? 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=200'
      : 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=400';
    const sb = await _get(sbUrl);
    if (!sb) return null;
    const a = _teamToks(awayTeam), h = _teamToks(homeTeam);
    const ko = Date.parse(scheduled || '');
    const hits = [];
    for (const ev of (sb.events || [])) {
      const comp = (ev.competitions || [])[0] || {};
      const teams = (comp.competitors || []).map(c => _teamToks((c.team || {}).displayName));
      const has = (want) => teams.some(t => [...want].some(x => t.has(x)));
      if (!(has(a) && has(h))) continue;
      if (Number.isFinite(ko)) {
        const gd = Date.parse(ev.date || '');
        if (Number.isFinite(gd) && Math.abs(gd - ko) > 6 * 3600e3) continue;
      }
      hits.push(ev.id);
    }
    if (hits.length !== 1) return null;
    const sm = await _get(`https://site.api.espn.com/apis/site/v2/sports/football/${path}/summary?event=${hits[0]}`);
    if (!sm) return null;
    const out = new Map();
    for (const blk of (sm.injuries || [])) {
      for (const it of (blk.injuries || [])) {
        const nm = (it.athlete || {}).displayName;
        if (nm && isBlockedStatus(it.status)) out.set(sig(nm), String(it.status));
      }
    }
    return out;
  } catch (err) {
    log.debug('Injuries', `ESPN availability read failed (${sportKey} ${awayTeam} @ ${homeTeam}): ${err.message}`);
    return null;
  }
}

// Blocked status for one player name, or null.
function statusFor(blocked, playerName) {
  if (!blocked || !playerName) return null;
  return blocked.get(sig(playerName)) || null;
}

module.exports = {
  getBlockedPlayers,
  statusFor,
  isBlockedStatus,
  sig,
  _setFetcher(fn) { _fetcher = fn; _cache.clear(); },
};
