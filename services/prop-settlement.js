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

// Prop families we can grade off a box score. Strikeouts were absent until
// 2026-08-23: box-score.js has understood pitcher K all along, but this job's
// allowlist excluded them, so prop_settlements held 15,674 rows and ZERO
// strikeout legs -- i.e. the leg-level calibration could not look at the one
// family whose ticket-level P&L was soft (z -1.75).
const HIT = new Set(['hitter_hr', 'hitter_hits', 'hitter_total_bases', 'hitter_rbi_runs']);
const GRADEABLE = new Set([...HIT, 'pitcher_strikeouts']);
const STATSAPI = 'https://statsapi.mlb.com/api/v1';
const BOX_TTL_MS = 6 * 60 * 60 * 1000; // box scores for a final game don't change

// in-process box-score index cache: date -> { at, idx: { normName -> {gamePk, team, H, HR, RBI, TB} } }
const _boxCache = {};

// matched_parlays K legs carry market='player_strikeouts' with propType=null, so
// the generic player_ strip yields 'strikeouts' while every other consumer keys on
// 'pitcher_strikeouts' (box-score.js documents this as the one irregular case).
// Canonicalise here or the allowlist silently never matches.
const _PT_ALIAS = { strikeouts: 'pitcher_strikeouts' };
function _propType(l) {
  const raw = String(l.propType || (l.market || '').replace(/^player_/, ''));
  return _PT_ALIAS[raw] || raw;
}
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
          const nm = _norm(p.person && p.person.fullName);
          if (!nm) continue;
          const bat = p.stats && p.stats.batting;
          const pit = p.stats && p.stats.pitching;
          const batted = bat && Object.keys(bat).length && (bat.atBats > 0 || bat.plateAppearances > 0);
          // An AL starter never bats, so the old batting-only gate skipped every
          // pitcher outright -- K props were unsettleable even once allowlisted.
          const pitched = pit && Object.keys(pit).length && (pit.battersFaced > 0 || pit.outs > 0);
          if (!batted && !pitched) continue;
          // Merge batting+pitching for a two-way player, but only within the SAME
          // game: on a doubleheader date the same name appears twice and merging
          // across games would fuse two box scores. Different game => replace,
          // preserving the previous last-wins behaviour.
          const prev = idx[nm];
          const e = (prev && prev.gamePk === g.gamePk) ? prev : { gamePk: g.gamePk, team: teamId };
          if (batted) { e.H = bat.hits || 0; e.HR = bat.homeRuns || 0; e.RBI = bat.rbi || 0; e.TB = bat.totalBases || 0; }
          // pit.strikeOuts is Ks THROWN; bat.strikeOuts is Ks taken at the plate.
          // Reading the batting field here would grade every K prop off the wrong stat.
          if (pitched) { e.K = pit.strikeOuts || 0; }
          idx[nm] = e;
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
  if (!GRADEABLE.has(pt)) return null;
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
      const lineNum = Number(leg.line);
      const need = Math.ceil(lineNum); // over L -> stat >= ceil(L)
      let val;
      if (pt === 'hitter_hr') val = st.HR;
      else if (pt === 'hitter_hits') val = st.H;
      else if (pt === 'hitter_total_bases') val = st.TB;
      else if (pt === 'hitter_rbi_runs') val = st.RBI;
      else if (pt === 'pitcher_strikeouts') val = st.K;
      else return null;
      // A name can match a position player who never pitched (K undefined). Fall
      // through to the next date index rather than declaring the leg ungradeable.
      if (val == null) continue;

      // SIDE-AWARE grading. This used to hardcode `val >= need`, i.e. it graded
      // every leg as an OVER — which inverted parlay_won for every UNDER leg
      // (~6.5% of hitter props) and fed /prop-correlation the opposite of truth.
      // On the half-point lines props almost always carry, over and under are
      // exact complements (no push), so under-win is simply !over-win.
      const sideRaw = String(leg.selection || '').toLowerCase();
      // Absent selection (legacy matched_parlays rows written before the
      // recordMatchedParlay fix) => assume OVER, the dominant side, and flag it
      // so calibration can exclude guessed rows. `no` is the anytime-prop under.
      const isUnder = sideRaw === 'under' || sideRaw === 'no';
      const sideKnown = sideRaw === 'over' || sideRaw === 'under' || sideRaw === 'yes' || sideRaw === 'no';
      const overWin = val >= need;
      // Integer lines CAN push (val === line). Half-point lines never do.
      const isPush = Number.isInteger(lineNum) && val === lineNum;
      const win = isPush ? false : (isUnder ? !overWin : overWin);
      return { win, push: isPush, gamePk: st.gamePk, team: st.team, val, need, side: isUnder ? 'under' : 'over', sideKnown };
    }
  }
  return null;
}

// Classifies over the GRADED legs only. A partial row gets a 'PARTIAL/' scope
// prefix so its combo key can never collide with a fully graded combo and
// silently dilute the correlation table.
function _classify(legs, results, fullyGraded) {
  const games = new Set(results.map((r) => r.gamePk));
  const teams = new Set(results.map((r) => r.team));
  const sameGame = games.size === 1;
  const sameTeam = teams.size === 1;
  const pts = legs.map(_propType).sort();
  let scope = sameGame ? (sameTeam ? 'SAME-G/SAME-TM' : 'SAME-G/OPP-TM') : 'CROSS';
  if (fullyGraded === false) scope = 'PARTIAL/' + scope;
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
  // PARTIAL GRADING. This used to demand that EVERY leg be a gradeable prop, so a
  // strikeouts+moneyline ticket was dropped whole -- and cross-game prop+moneyline
  // is exactly where the 2026 damage concentrated (-$15,151 over 102 tickets).
  // Now one gradeable prop leg admits the ticket; ungradeable legs are recorded
  // with won:null and the row is marked partial. Leg-level calibration only ever
  // reads individual legs, so a partially graded ticket is fully usable to it,
  // while parlay_won (which correlation needs) is withheld unless ALL legs graded.
  const cand = rows.filter((r) => {
    const legs = r.legs || [];
    if (legs.length < 2 || legs.length > 8) return false;
    return legs.some((l) => l.sport === 'baseball_mlb' && GRADEABLE.has(_propType(l)));
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
    // undefined = not a gradeable prop (a moneyline leg, by design).
    // null      = gradeable prop we could not resolve (name miss, game not final).
    const results = legs.map((l) => (l.sport === 'baseball_mlb' && GRADEABLE.has(_propType(l)))
      ? _settleLeg(l, indexes) : undefined);
    const gradedAt = [];
    results.forEach((x, i) => { if (x != null) gradedAt.push(i); });
    if (!gradedAt.length) { unsettleable++; continue; }
    const fullyGraded = results.every((x) => x != null);
    const cls = _classify(gradedAt.map((i) => legs[i]), gradedAt.map((i) => results[i]), fullyGraded);
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
      leg_results: legs.map((l, i) => (results[i] != null
        ? { player: l.team, propType: _propType(l), line: l.line, side: results[i].side, sideKnown: results[i].sideKnown, stat: results[i].val, won: results[i].win, graded: true }
        : { player: l.team, propType: _propType(l), line: l.line, market: l.market || null, stat: null, won: null, graded: false })),
      // Withheld on a partial row: a joint outcome is undefined when a leg is
      // ungraded, and /prop-correlation counts a falsy parlay_won as a LOSS.
      parlay_won: fullyGraded ? results.every((x) => x.win) : null,
      source: 'mlb-statsapi',
    });
  }

  let written = 0;
  if (!dryRun && settlements.length) {
    // Dedupe by parlay_id: matched_parlays can carry the same parlay twice
    // (duplicate matched events), and Postgres rejects a single upsert
    // statement that touches the same conflict key twice ("ON CONFLICT DO
    // UPDATE command cannot affect row a second time"). Keep the last
    // occurrence — same parlay, same box scores, identical settlement.
    const byId = new Map();
    for (const s of settlements) byId.set(s.parlay_id, s);
    const unique = [...byId.values()];
    if (unique.length !== settlements.length) {
      log.info('PropSettle', `deduped ${settlements.length - unique.length} duplicate parlay_id rows before upsert`);
    }
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
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
  // Composition, so a dry run can be inspected before it writes and so a silent
  // coverage regression (a family dropping to zero legs) is visible on the
  // operator endpoint rather than only in the table.
  const legsByType = {}; let partial = 0, gradedLegs = 0, ungradedLegs = 0;
  for (const st of settlements) {
    if (st.parlay_won == null) partial++;
    for (const lr of st.leg_results) {
      if (lr.won == null) { ungradedLegs++; continue; }
      gradedLegs++;
      legsByType[lr.propType] = (legsByType[lr.propType] || 0) + 1;
    }
  }
  return { ok: true, candidates: cand.length, settled: settlements.length, unsettleable, written, dryRun,
    partialRows: partial, gradedLegs, ungradedLegs, legsByType };
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
    if (r.parlay_won == null) continue; // partial row: not a joint observation
    for (const lr of (r.leg_results || [])) {
      if (lr.won == null) continue; // ungraded leg contributes no marginal rate
      margTot[lr.propType] = (margTot[lr.propType] || 0) + 1;
      if (lr.won) margWin[lr.propType] = (margWin[lr.propType] || 0) + 1;
    }
  }
  const margRate = {};
  for (const pt of Object.keys(margTot)) margRate[pt] = margWin[pt] / margTot[pt];

  const byCombo = {};
  for (const r of rows) {
    if (r.parlay_won == null) continue; // partial row: joint outcome undefined
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

/**
 * LEG-LEVEL PRICE CALIBRATION.
 *
 * The question ticket P&L cannot answer. A parlay's result is one observation
 * driven by every leg at once, and its size is leveraged: over the 2026 season
 * five strikeout tickets carried the entire -$16,885 deficit, so a 2pp pricing
 * error is invisible under that variance. This pairs each INDIVIDUAL leg's fair
 * probability at quote time with its realized box-score outcome, giving
 * thousands of near-independent Bernoulli trials instead.
 *
 * For each prop family: did the legs we priced at p% actually hit p% of the time?
 *   expected wins = sum(p_i)      var = sum(p_i * (1 - p_i))
 *   z = (wins - expected) / sqrt(var)
 * A real mispricing is a persistent SIGNED gap -- 'our HR overs are 2.4pp cheap'
 * -- which points at the fair to correct. Noise wanders around zero.
 *
 * Only our own tickets calibrate: prop_settlements also carries other SPs'
 * parlays (market intelligence), which have realized outcomes but no fair of ours.
 */
async function getLegCalibration(opts = {}) {
  const days = opts.days || 60;
  const minN = opts.minN || 25;
  const sb = db.getClient();
  if (!sb) return { ok: false, error: 'no supabase client' };
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

  let rows;
  try {
    rows = await _pageAll(() => sb.from('prop_settlements')
      .select('parlay_id,matched_at,leg_results,we_quoted,sport')
      .eq('sport', 'baseball_mlb').eq('we_quoted', true)
      .gte('matched_at', sinceIso), 60000);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!rows.length) return { ok: true, windowDays: days, families: [], note: 'no settled rows for our own tickets yet — POST /settle-props' };

  // Join our quote-time fair from parlay_orders.legs[].fairProb.
  const ids = [...new Set(rows.map((r) => r.parlay_id))];
  const orders = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('parlay_orders').select('parlay_id,legs').in('parlay_id', ids.slice(i, i + 200));
    if (error) return { ok: false, error: error.message };
    for (const o of data) orders.set(o.parlay_id, o.legs || []);
  }

  const fams = {};
  let matched = 0, unmatched = 0;
  for (const r of rows) {
    const legs = orders.get(r.parlay_id);
    if (!legs) continue;
    for (const lr of (r.leg_results || [])) {
      if (lr.won == null) continue;              // ungraded leg
      if (lr.sideKnown === false) continue;      // side was guessed, not recorded
      // Match on family + line + player. Line disambiguates a player appearing
      // twice; player name guards against two legs sharing a family and line.
      const m = legs.find((l) => _propType(l) === lr.propType
        && Number(l.line) === Number(lr.line)
        && _norm(l.team) === _norm(lr.player));
      if (!m || m.fairProb == null) { unmatched++; continue; }
      const p = Number(m.fairProb);
      if (!(p > 0 && p < 1)) { unmatched++; continue; }
      matched++;
      const key = lr.propType + '.' + (lr.side || 'over');
      const f = fams[key] || (fams[key] = { key, propType: lr.propType, side: lr.side || 'over', n: 0, wins: 0, expWins: 0, varSum: 0 });
      f.n++; f.expWins += p; f.varSum += p * (1 - p);
      if (lr.won) f.wins++;
    }
  }

  // Float noise turns an exact zero into -0, which renders as '-0.00pp' and
  // reads as a small underprice. Collapse it.
  const r2 = (x) => { const v = +Number(x).toFixed(2); return v === 0 ? 0 : v; };
  const families = Object.values(fams).filter((f) => f.n >= minN).map((f) => {
    const sd = Math.sqrt(f.varSum);
    const meanFair = f.expWins / f.n;
    const realized = f.wins / f.n;
    return {
      family: f.key, propType: f.propType, side: f.side, legs: f.n,
      meanFairPct: r2(meanFair * 100),
      realizedPct: r2(realized * 100),
      // Positive => the side we quoted hit MORE than we priced, i.e. we sold it
      // too cheap and the bettor was getting the better of it.
      diffPp: r2((realized - meanFair) * 100),
      z: sd > 0 ? r2((f.wins - f.expWins) / sd) : null,
    };
  }).sort((a, b) => b.legs - a.legs);

  return { ok: true, windowDays: days, minN, legsScored: matched, legsUnmatched: unmatched, families };
}
module.exports = { settleRecent, getCalibration, getLegCalibration, __settleLeg: _settleLeg, __propType: _propType };
