'use strict';
// Resolve MLB player-prop legs from ESPN box scores once their game is FINAL.
// PX leaves a prop 'open' (In Progress) until it grades the parlay itself,
// which can lag hours after the game ends. This reads the final box score,
// looks up the player's actual stat, and decides won/lost so the dashboard
// shows the correct leg icon and the parlay's win-prob locks to 100% the
// moment any bettor leg has definitively missed (order-tracker's existing
// isParlayAlreadyDead / getLegResult client logic already does this off
// leg.inferredResult — this module is the missing MLB-prop resolver that
// feeds it; team markets are already handled in checkLegResults).
//
// Never touches realized P&L (still comes from PX settlement), pricing, or
// quoting — this only sets leg.inferredResult. Fail-safe: any uncertainty
// (unsupported stat, player not matched, fetch error) -> return null and
// leave the leg for PX to grade.
//
// Ported from the working portfolio-tracker implementation. Divergence: this
// app's `hitter_rbi_runs` propType maps to a single stat (TOA batter_rbis =
// plain RBI), NOT the "H+R+RBI" combo the reference used for a similarly-
// named field — see line-manager.js:57-63 and websocket.js:170-187 for why
// combo props are deliberately routed elsewhere (hitter_other) and never
// reach this resolver. Resolution here keys on this app's own canonical
// propType strings (hitter_hr / hitter_hits / hitter_total_bases /
// hitter_rbi_runs / pitcher_strikeouts) rather than free-text regex on a
// human-readable stat label, since order.legs already carries those exact
// strings (see _propMarketType in line-manager.js) — no fuzzy matching needed.
//
// Sources within the ESPN summary payload:
//   rosters[].roster[].stats  -> per-game homeRuns / hits / RBIs / stolenBases (+ id->name)
//   boxscore.players[] grid   -> R (runs) and pitching K; backfills HR/H/RBI if rosters missed
//   plays[]                   -> doubles / triples per batter (for Doubles + Total Bases)
const fetch = require('node-fetch');
const log = require('./logger');

const nameKey = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const n0 = (v) => (Number.isFinite(v) ? v : 0);

// espnId -> { bat:{nameKey:{HR,H,R,RBI,SB,doubles,triples}}, pit:{nameKey:{K}} } | null.
// Final games never change, so cache the parsed box indefinitely (per process).
// Also naturally dedupes fetches — every leg on the same final game shares
// this cache, so a slate with 10 legs on one game still fetches once.
const _box = {};

async function fetchBox(espnId, sport = 'baseball', league = 'mlb') {
  if (espnId == null) return null;
  if (Object.prototype.hasOwnProperty.call(_box, espnId)) return _box[espnId];
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/summary?event=${encodeURIComponent(espnId)}`;
    const r = await fetch(url, { timeout: 12000 });
    if (!r.ok) return null; // don't cache transient failures — retry next cycle
    const d = await r.json();
    const bat = {}, pit = {}, idName = {};
    const B = (name) => (bat[name] = bat[name] || {});

    // 1) rosters: per-game HR / hits / RBIs / stolenBases (+ athlete id -> name).
    for (const team of (d.rosters || [])) {
      for (const pl of (team.roster || [])) {
        const ath = pl.athlete || {};
        const name = nameKey(ath.displayName || ath.fullName);
        if (!name) continue;
        if (ath.id != null) idName[String(ath.id)] = name;
        const g = {}; for (const s of (pl.stats || [])) g[s.name] = Number(s.value);
        const b = B(name);
        if (Number.isFinite(g.homeRuns)) b.HR = g.homeRuns;
        if (Number.isFinite(g.hits)) b.H = g.hits;
        if (Number.isFinite(g.RBIs)) b.RBI = g.RBIs;
        if (Number.isFinite(g.stolenBases)) b.SB = g.stolenBases;
        b.doubles = b.doubles || 0; b.triples = b.triples || 0; // default 0, filled from plays below
      }
    }
    // 2) boxscore grid: R (runs, unused directly here but kept for parity /
    // future H+R+RBI support) and pitching K. Backfill HR/H/RBI if rosters missed.
    for (const team of ((d.boxscore && d.boxscore.players) || [])) {
      for (const grp of (team.statistics || [])) {
        const labels = grp.labels || [];
        const gname = String(grp.name || grp.type || '').toLowerCase();
        const isBat = /bat/.test(gname), isPitch = /pitch/.test(gname);
        if (!isBat && !isPitch) continue;
        const val = (st, lab) => { const i = labels.indexOf(lab); if (i < 0) return null; const x = Number(String(st[i]).replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : null; };
        for (const a of (grp.athletes || [])) {
          const name = nameKey(a.athlete && a.athlete.displayName);
          if (!name) continue;
          const st = a.stats || [];
          if (isBat) { const b = B(name); if (b.R == null) b.R = val(st, 'R'); if (b.H == null) b.H = val(st, 'H'); if (b.HR == null) b.HR = val(st, 'HR'); if (b.RBI == null) b.RBI = val(st, 'RBI'); }
          else { const k = val(st, 'K'); if (k != null) pit[name] = { K: k }; }
        }
      }
    }
    // 3) plays: count doubles / triples per BATTER (participant id -> name).
    for (const p of (d.plays || [])) {
      const t = (p.type || {}).type;
      if (t !== 'double' && t !== 'triple') continue;
      const bp = (p.participants || []).find((x) => x.type === 'batter');
      const name = bp && bp.athlete && idName[String(bp.athlete.id)];
      if (!name) continue;
      const b = B(name);
      if (t === 'double') b.doubles = (b.doubles || 0) + 1; else b.triples = (b.triples || 0) + 1;
    }

    if (!Object.keys(bat).length && !Object.keys(pit).length) return null; // parsed nothing -> retry next cycle
    _box[espnId] = { bat, pit };
    return _box[espnId];
  } catch (e) { log.warn('BoxScore', `fetch ${espnId}: ${e.message}`); return null; }
}

// Find a player's line in a group map: exact key, else unique last-name+first-initial.
function lookup(map, player) {
  const k = nameKey(player);
  if (map[k]) return map[k];
  const parts = k.split(' ');
  if (parts.length < 2 || !parts[0]) return null;
  const last = parts[parts.length - 1], init = parts[0][0];
  const cands = Object.keys(map).filter((mk) => { const mp = mk.split(' '); return mp.length >= 2 && mp[mp.length - 1] === last && mp[0][0] === init; });
  return cands.length === 1 ? map[cands[0]] : null; // fail-safe: ambiguous -> no match
}

// This app's canonical propType strings (see line-manager.js _propMarketType
// and its inverse below) — the ONLY stats this resolver will grade. Anything
// else (hitter_other, pra_combo, etc.) is deliberately left for PX to settle.
const SUPPORTED_PROP_TYPES = new Set([
  'hitter_hr', 'hitter_hits', 'hitter_total_bases', 'hitter_rbi_runs', 'pitcher_strikeouts',
]);

function statSupported(propType) {
  return SUPPORTED_PROP_TYPES.has(String(propType || ''));
}

// The player's actual value for a propType, or null if unresolvable.
function statValue(box, player, propType) {
  if (!box) return null;
  const b = lookup(box.bat, player);
  const pit = lookup(box.pit, player);
  switch (String(propType || '')) {
    case 'hitter_hr': return b && b.HR != null ? b.HR : null;
    case 'hitter_hits': return b && b.H != null ? b.H : null;
    case 'hitter_rbi_runs': return b && b.RBI != null ? b.RBI : null; // plain RBI in this app
    case 'hitter_total_bases': return b ? (n0(b.H) + n0(b.doubles) + 2 * n0(b.triples) + 3 * n0(b.HR)) : null; // TB = 1B+2·2B+3·3B+4·HR
    case 'pitcher_strikeouts': return pit && pit.K != null ? pit.K : null;
    default: return null;
  }
}

// Inverse of line-manager.js's _propMarketType('hitter_hr') -> 'player_hitter_hr'
// (and 'pitcher_strikeouts' -> 'player_strikeouts', the one irregular case).
function marketToPropType(market) {
  if (market === 'player_strikeouts') return 'pitcher_strikeouts';
  if (typeof market === 'string' && market.startsWith('player_')) return market.slice('player_'.length);
  return null;
}

module.exports = { fetchBox, statSupported, statValue, marketToPropType };
