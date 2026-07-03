'use strict';
// Resolve soccer player-prop legs (World Cup goalscorer / SoT / assists) from
// ESPN box scores once their game is FINAL. Sibling to box-score.js (MLB) —
// same fail-safe philosophy, different sport/stat vocabulary and a dynamic
// ESPN league path (soccer competitions aren't a single fixed league like
// baseball/mlb; the league segment comes from espnResult.league, e.g.
// 'soccer/fifa.world', 'soccer/eng.1').
//
// Never touches realized P&L, pricing, or quoting — only sets leg.inferredResult
// (same field checkLegResults already sets for every other market, which the
// dashboard's getLegResult()/isParlayAlreadyDead() already use to drive the
// leg icon and lock the parlay's win-prob). Fail-safe: any uncertainty
// (unsupported stat, player not matched, fetch error) -> null, leave for PX.
//
// ESPN summary payload source (verified 2026-07-02 against real WC games):
//   rosters[].roster[].stats[] -> per-game totalGoals / shotsOnTarget /
//   goalAssists per player, keyed by name — same {name, value} shape family
//   as MLB's roster stats, no separate plays-parsing needed (unlike MLB
//   doubles/triples, ESPN gives soccer per-player season^H^Hgame totals
//   directly on the roster entry).
const fetch = require('node-fetch');
const log = require('./logger');

const nameKey = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
// NOTE: unlike MLB's "Jr."/"Sr." SUFFIX stripping, a name like "Vinícius
// Júnior" is NOT affected — "júnior" normalizes to the 6-letter word
// "junior", which the \b(jr|sr|...)\b word-boundary regex does not match
// (it only strips the exact short tokens "jr"/"sr"/"ii"/"iii"/"iv").

// espnId -> { nameKey: {goals, sot, assists} } | null. Final games are
// immutable, so cache indefinitely (per process) — also dedupes fetches
// across every leg on the same final game.
const _box = {};

async function fetchBox(espnId, leagueLabel) {
  if (espnId == null || !leagueLabel) return null;
  if (Object.prototype.hasOwnProperty.call(_box, espnId)) return _box[espnId];
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${leagueLabel}/summary?event=${encodeURIComponent(espnId)}`;
    const r = await fetch(url, { timeout: 12000 });
    if (!r.ok) return null; // don't cache transient failures — retry next cycle
    const d = await r.json();
    const players = {};
    for (const team of (d.rosters || [])) {
      for (const pl of (team.roster || [])) {
        const ath = pl.athlete || {};
        const name = nameKey(ath.displayName || ath.fullName);
        if (!name) continue;
        const g = {}; for (const s of (pl.stats || [])) g[s.name] = Number(s.value);
        players[name] = {
          goals: Number.isFinite(g.totalGoals) ? g.totalGoals : 0,
          sot: Number.isFinite(g.shotsOnTarget) ? g.shotsOnTarget : 0,
          assists: Number.isFinite(g.goalAssists) ? g.goalAssists : 0,
        };
      }
    }
    if (!Object.keys(players).length) return null; // parsed nothing -> retry next cycle
    _box[espnId] = players;
    return players;
  } catch (e) { log.warn('SoccerBoxScore', `fetch ${espnId}: ${e.message}`); return null; }
}

// Find a player's line: exact key, else unique last-name+first-initial.
function lookup(players, player) {
  const k = nameKey(player);
  if (players[k]) return players[k];
  const parts = k.split(' ');
  if (parts.length < 2 || !parts[0]) return null;
  const last = parts[parts.length - 1], init = parts[0][0];
  const cands = Object.keys(players).filter((mk) => { const mp = mk.split(' '); return mp.length >= 2 && mp[mp.length - 1] === last && mp[0][0] === init; });
  return cands.length === 1 ? players[cands[0]] : null; // fail-safe: ambiguous -> no match
}

// This app's canonical soccer propType strings (see _classifySoccerProp /
// _propMarketType in line-manager.js — market = 'player_' + propType for
// all of these, no irregular case like MLB's pitcher_strikeouts).
const SUPPORTED_PROP_TYPES = new Set(['goalscorer', 'sot_1', 'sot_2', 'assists']);

function statSupported(propType) {
  return SUPPORTED_PROP_TYPES.has(String(propType || ''));
}

// The player's actual value for a propType, or null if unresolvable.
// sot_1/sot_2 share the same underlying "shots on target" count — they only
// differ in the LINE registered on the leg (0.5 vs 1.5), which the caller
// compares separately; this just returns the raw stat.
function statValue(box, player, propType) {
  if (!box) return null;
  const p = lookup(box, player);
  if (!p) return null;
  switch (String(propType || '')) {
    case 'goalscorer': return p.goals;
    case 'sot_1':
    case 'sot_2': return p.sot;
    case 'assists': return p.assists;
    default: return null;
  }
}

// Inverse of line-manager.js's _propMarketType for soccer props
// ('player_goalscorer' -> 'goalscorer', 'player_sot_1' -> 'sot_1', etc.).
function marketToPropType(market) {
  if (typeof market === 'string' && market.startsWith('player_')) return market.slice('player_'.length);
  return null;
}

module.exports = { fetchBox, statSupported, statValue, marketToPropType };
