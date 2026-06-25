// ---------------------------------------------------------------------------
// MLB PROP-PARLAY SETTLEMENT (realized-outcome feedback loop)
// ---------------------------------------------------------------------------
// matched_parlays.outcome only records 'missed'/'other_sp' — never the game
// result — so we have no realized-outcome data to calibrate same-game prop
// correlation factors (see the 2026-06-25 box-score backtest). This module
// closes that gap: it settles MLB hitter-prop parlays against real box scores
// from the free MLB Stats API (statsapi.mlb.com), reconstructs same-game vs
// cross-game (and same-team vs opposite-team) from each player's actual gamePk,
// and persists the result to the `prop_settlements` table. The /prop-correlation
// report then reads that table to produce always-current correlation factors.
//
// Read-mostly: pulls matched_parlays + public box scores, writes ONLY to the
// dedicated prop_settlements table. Never mutates pricing or existing rows.
//
// Settlement is exact for the over side of hitter_hr / hitter_hits /
// hitter_total_bases / hitter_rbi_runs (the registered, over-only prop set).
const log = require('./logger');
const db = require('./db');

const HIT = new Set(['hitter_hr', 'hitter_hits', 'hitter_total_bases', 'hitter_rbi_runs']);
const STATSAPI = 'https://statsapi.mlb.com/api/v1';
const BOX_TTL_MS = 6 * 60 * 60 * 1000; // box scores for a final game don't change

// in-process box-score index cache: date -> { at, idx: { normName -> {gamePk, team, H, HR, RBI, TB} } }
const _boxCache = {};

function _propType(l) { return String(l.propType || (l.market || '').replace(/^player_/, '')); }
function _amToProb(a) { a = Number(a); if (!a) return null; return a > 0 ? 100 / (a + 100) : (-a) / ((-a) + 100); }
function _norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.'`]/g, '').replace(/\s+(jr|sr|iii|ii|iv)$/i, '').replace(/\s+/g, ' ').trim();
}
function _etDate(iso) { return new Date(new Date(iso).getTime() - 4 * 3600 * 1000).toISOString().slice(0, 10); }
function _addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _buildDateIndex(date) {
  const cached = _boxCache[date];
  if (cached && Date.now() - cached.at < BOX_TTL_MS) return cached.idx;
  const idx = {};
  try {
    const sched = await (await fetch(`${STATSAPI}/schedule?sportId=1&date=${date}`)).json();
    const games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];
    for (const g of games) {
      if (!/final|completed|game over/i.test((g.status && g.status.detailedState) || '')) continue;
      let box;
      try { box = await (await fetch(`${STATSAPI}/game/${g.gamePk}/boxscore`)).json(); } catch (_) { continue; }
      for (const side of ['away', 'home']) {
        const ts = box.teams && box.teams[side];
        const teamId = (ts && ts.team && ts.team.id) || (g.gamePk + ':' + side);
        const players = (ts && ts.players) || {};
        for (const pid of Object.keys(players)) {
          const p = players[pid];
          const bat = p.stats && p.stats.batting;
          if (!bat || !Object.keys(bat).length) continue;
          if (!(bat.atBats > 0 || bat.plateAppearances > 0)) continue;
          const nm = _norm(p.person && p.person.fullName);
          if (!nm) continue;
          idx[nm] = { gamePk: g.gamePk, team: teamId, H: bat.hits || 0, HR: bat.homeRuns || 0, RBI: bat.rbi || 0, TB: bat.totalBases || 0 };
        }
      }
      await _sleep(40);
    }
  } catch (_) { /* leave partial */ }
  _boxCache[date] = { at: Date.now(), idx };
  return idx;
}

// returns {win, gamePk, team, val, need} or null (unsettleable)
function _settleLeg(leg, indexes) {
  const pt = _propType(leg);
  if (!HIT.has(pt)) return null;
  const player = _norm(leg.team);
  if (!player) return null;
  for (const idx of indexes) {
    let st = idx[player];
    if (!st) {
      const parts = player.split(' ');
      const last = parts[parts.length - 1], fi = parts[0][0];
      const cand = Object.keys(idx).filter((k) => { const kp = k.split(' '); return kp[kp.length - 1] === last && kp[0][0] === fi; });
      if (cand.length === 1) st = idx[cand[0]];
    }
    if (st) {
      const need = Math.ceil(Number(leg.line)); // over L -> stat >= ceil(L)
      let val;
      if (pt === 'hitter_hr') val = st.HR;
      else if (pt === 'hitter_hits') val = st.H;
      else if (pt === 'hitter_total_bases') val = st.TB;
      else if (pt === 'hitter_rbi_runs') val = st.RBI;
      else return null;
      return { win: val >= need, gamePk: st.gamePk, team: st.team, val, need };
    }
  }
  return null;
}

function _classify(legs, results) {
  const games = new Set(results.map((r) => r.gamePk));
  const teams = new Set(results.map((r) => r.team));
  const sameGame = games.size === 1;
  const sameTeam = teams.size === 1;
  const pts = legs.map(_propType).sort();
  const scope = sameGame ? (sameTeam ? 'SAME-G/SAME-TM' : 'SAME-G/OPP-TM') : 'CROSS';
  return { sameGame, sameTeam, propTypes: pts, combo: scope + ' | ' + pts.join('+') };
}

async function _pageAll(makeQuery, cap) {
  let from = 0; const page = 1000; let all = [];
  while (true) {
    const { data, error } = await makeQuery().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < page || all.length >= (cap || 60000)) break;
    from += page;
  }
  return all;
}

/**
 * Settle MLB hitter-prop parlays whose games have finished, and upsert results
 * into prop_settlements. Idempotent (upsert on parlay_id). Re-settles a rolling
 * window so late finals / corrections are picked up.
 *
 * opts: { sinceDays=14, lagHours=6, dryRun=false }
 *   lagHours — only settle parlays whose matched_at is older than this (games done)
 */
async function settleRecent(opts = {}) {
  const sinceDays = opts.sinceDays || 14;
  const lagHours = opts.lagHours != null ? opts.lagHours : 6;
  const dryRun = !!opts.dryRun;
  const sb = db.getClient();
  if (!sb) return { ok: false, error: 'no supabase client' };

  const sinceIso = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const cutoffIso = new Date(Date.now() - lagHours * 3600000).toISOString();

  const rows = await _pageAll(() => sb.from('matched_parlays')
    .select('parlay_id,matched_odds,matched_stake,legs,we_quoted,matched_at')
    .gte('matched_at', sinceIso).lt('matched_at', cutoffIso).order('matched_at', { ascending: true }), 60000);
  const cand = rows.filter((r) => {
    const legs = r.legs || [];
    return legs.length >= 2 && legs.length <= 6 && legs.every((l) => l.sport === 'baseball_mlb' && HIT.has(_propType(l)));
  });

  // build needed date indexes
  const dates = new Set();
  for (const r of cand) { const d = _etDate(r.matched_at); dates.add(d); dates.add(_addDays(d, -1)); dates.add(_addDays(d, 1)); }
  for (const d of [...dates].sort()) await _buildDateIndex(d);

  const settlements = [];
  let unsettleable = 0;
  for (const r of cand) {
    const legs = r.legs || [];
    const d = _etDate(r.matched_at);
    const indexes = [_boxCache[d] && _boxCache[d].idx || {}, _boxCache[_addDays(d, -1)] && _boxCache[_addDays(d, -1)].idx || {}, _boxCache[_addDays(d, 1)] && _boxCache[_addDays(d, 1)].idx || {}];
    const results = legs.map((l) => _settleLeg(l, indexes));
    if (results.some((x) => x == null)) { unsettleable++; continue; }
    const cls = _classify(legs, results);
    settlements.push({
      parlay_id: r.parlay_id,
      matched_at: r.matched_at,
      sport: 'baseball_mlb',
      combo: cls.combo,
      same_game: cls.sameGame,
      same_team: cls.sameTeam,
      leg_count: legs.length,
      prop_types: cls.propTypes,
      matched_odds: r.matched_odds,
      matched_stake: r.matched_stake,
      we_quoted: !!r.we_quoted,
      leg_results: legs.map((l, i) => ({ player: l.team, propType: _propType(l), line: l.line, stat: results[i].val, won: results[i].win })),
      parlay_won: results.every((x) => x.win),
      source: 'mlb-statsapi',
    });
  }

  let written = 0;
  if (!dryRun && settlements.length) {
    for (let i = 0; i < settlements.length; i += 500) {
      const chunk = settlements.slice(i, i + 500);
      const { error } = await sb.from('prop_settlements').upsert(chunk, { onConflict: 'parlay_id' });
      if (error) {
        const hint = /prop_settlements/.test(error.message) ? ' (run migrations/prop_settlements.sql in Supabase first)' : '';
        log.warn('PropSettle', `upsert failed: ${error.message}${hint}`);
        return { ok: false, error: error.message + hint, candidates: cand.length, settled: settlements.length, unsettleable };
      }
      written += chunk.length;
    }
  }
  log.info('PropSettle', `settled ${settlements.length} parlays (${unsettleable} unsettleable), ${dryRun ? 'DRY-RUN' : 'wrote ' + written} of ${cand.length} candidates`);
  return { ok: true, candidates: cand.length, settled: settlements.length, unsettleable, written, dryRun };
}

/**
 * Read prop_settlements and compute live-calibrated correlation factors per combo.
 * correlation = realized joint win-rate / product of realized marginal leg rates
 * (marginals measured over same-game legs). opts: { days=60, minN=8 }
 */
async function getCalibration(opts = {}) {
  const days = opts.days || 60;
  const minN = opts.minN || 8;
  const sb = db.getClient();
  if (!sb) return { ok: false, error: 'no supabase client' };
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  let rows;
  try {
    rows = await _pageAll(() => sb.from('prop_settlements')
      .select('combo,same_game,leg_count,prop_types,matched_odds,matched_stake,parlay_won,leg_results')
      .gte('matched_at', sinceIso), 60000);
  } catch (err) {
    if (/prop_settlements/.test(err.message)) return { ok: false, error: 'prop_settlements table missing — run migrations/prop_settlements.sql in Supabase, then POST /settle-props' };
    return { ok: false, error: err.message };
  }
  if (!rows.length) return { ok: true, windowDays: days, marginalRates: {}, combos: [], note: 'no settlements yet — POST /settle-props (needs PROP_SETTLEMENT_ENABLED or manual trigger)' };

  // marginal realized leg rates over same-game legs, by propType
  const margWin = {}, margTot = {};
  for (const r of rows) {
    if (!r.same_game) continue;
    for (const lr of (r.leg_results || [])) { margTot[lr.propType] = (margTot[lr.propType] || 0) + 1; if (lr.won) margWin[lr.propType] = (margWin[lr.propType] || 0) + 1; }
  }
  const margRate = {};
  for (const pt of Object.keys(margTot)) margRate[pt] = margWin[pt] / margTot[pt];

  const byCombo = {};
  for (const r of rows) {
    const b = byCombo[r.combo] || (byCombo[r.combo] = { n: 0, win: 0, stake: 0, impliedSum: 0, impliedN: 0 });
    b.n++; if (r.parlay_won) b.win++; b.stake += Number(r.matched_stake || 0);
    const ip = _amToProb(r.matched_odds); if (ip != null) { b.impliedSum += ip; b.impliedN++; }
  }
  const out = [];
  for (const [combo, b] of Object.entries(byCombo)) {
    if (b.n < minN) continue;
    const realJoint = b.win / b.n;
    let indep = null, corr = null;
    if (combo.startsWith('SAME')) {
      const pts = combo.split(' | ')[1].split('+');
      if (pts.every((pt) => margRate[pt] != null)) { indep = pts.reduce((a, pt) => a * margRate[pt], 1); corr = indep > 0 ? realJoint / indep : null; }
    }
    const impl = b.impliedN ? b.impliedSum / b.impliedN : null;
    out.push({
      combo, n: b.n,
      realizedWinPct: +(realJoint * 100).toFixed(1),
      indepProductPct: indep != null ? +(indep * 100).toFixed(1) : null,
      correlationFactor: corr != null ? +corr.toFixed(2) : null,
      impliedWinPct: impl != null ? +(impl * 100).toFixed(1) : null,
      bettorEdgePp: impl != null ? +((realJoint - impl) * 100).toFixed(1) : null,
      stake: Math.round(b.stake),
    });
  }
  out.sort((a, b) => b.n - a.n);
  return { ok: true, windowDays: days, marginalRates: Object.fromEntries(Object.entries(margRate).map(([k, v]) => [k, +(v * 100).toFixed(1)])), combos: out };
}

module.exports = { settleRecent, getCalibration };
