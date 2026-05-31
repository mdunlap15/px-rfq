// ============================================================================
// golf-single-leg.js — Bulk-post golf matchup offers from the SECOND PX account
// ============================================================================
// Reuses:
//   - services/px-single.js for ALL PX I/O (second account, isolated session)
//   - services/line-manager.lookupLine() for fair_prob lookup (the parlay SP's
//     odds index has the same global line_ids and already computes golf-matchup
//     fair_prob the same way Mike wanted)
//   - services/pricer.computeSingleLegQuote() for the offered-odds calc
//     (same VIG_GOLF_MATCHUP_MIN floor / fair-multiplier / heavy-fav markup
//     the RFQ path uses — Mike's explicit ask: "same path and parameters as
//     the RFQs golf matchups rules")
//
// State lives in two Supabase tables (see scripts/_golf_single_leg_schema.sql):
//   golf_single_leg_config   — per-side preferences (risk_amount, enabled)
//   golf_single_leg_wagers   — runtime state of posted wagers
//
// Top-level operations:
//   discoverAndSyncConfig()  → fetch PX events/markets, upsert config rows
//                              for each new matchup side (enabled=false)
//   loadState()              → return {matchups, config, activeWagers} for UI
//   postEnabled()            → post offers for every enabled+risk-set side
//   cancelAll()              → cancel every posted wager (and DB-mark)
//   cancelStale()            → cancel wagers for matchups that disappeared
//                              from PX or are within tee-off cutoff
//   refreshDrift()           → for each active wager, recompute fair; if it
//                              drifted >= driftPp implied, cancel + repost
//   startWorker()            → setInterval the discover→drift→cancelStale loop
//
// All operations no-op cleanly when GOLF_SINGLE_LEG_ENABLED is unset.
// ============================================================================

const log = require('./logger');
const config = require('../config');
const pxSingle = require('./px-single');
const lineManager = require('./line-manager');
const pricer = require('./pricer');
const db = require('./db');

const TBL_CONFIG = 'golf_single_leg_config';
const TBL_WAGERS = 'golf_single_leg_wagers';

function _cfg() {
  return {
    enabled: String(process.env.GOLF_SINGLE_LEG_ENABLED || '').toLowerCase() === 'true',
    driftPp: Number(process.env.GOLF_SINGLE_LEG_DRIFT_PP) || 5,
    refreshMin: Number(process.env.GOLF_SINGLE_LEG_REFRESH_MINUTES) || 5,
    teeOffCutoffMin: Number(process.env.GOLF_SINGLE_LEG_CANCEL_BEFORE_TEEOFF_MINUTES) || 10,
  };
}
function isEnabled() { return _cfg().enabled; }

// ---------------------------------------------------------------------------
// Discovery: pull PX events from the SINGLE-LEG account, filter to golf,
// fetch markets per event, extract matchup sides into a normalized list.
// ---------------------------------------------------------------------------
function _looksLikeGolfEvent(evt) {
  const sport = String(evt.sport_name || '').toLowerCase();
  return sport.includes('golf');
}

function _isMatchupMarket(market) {
  const name = String(market.name || '').toLowerCase();
  const sub = String(market.sub_type || '').toLowerCase();
  if (sub === 'moneyline' && name.includes('matchup')) return true;
  if (name.includes('matchup') && !name.includes('group')) return true;
  return false;
}

function _flattenSelections(selections) {
  const out = [];
  if (!Array.isArray(selections)) return out;
  for (const g of selections) {
    if (Array.isArray(g)) out.push(...g);
    else out.push(g);
  }
  return out;
}

function _parseRoundNum(name) {
  if (!name) return null;
  const m = String(name).match(/round\s+(\d+)|\(r(\d+)/i);
  if (m) return parseInt(m[1] || m[2], 10);
  return null;
}

async function discoverGolfMatchups() {
  const events = await pxSingle.fetchSportEvents();
  const golfEvents = events.filter(_looksLikeGolfEvent);
  const out = []; // [{event_id, tournament_name, scheduled, market_id, market_name, round_num, sides:[{line_id, side_name, opponent_name, competitor_id}, ...]}]
  for (const evt of golfEvents) {
    let markets;
    try { markets = await pxSingle.fetchMarkets(evt.event_id); }
    catch (e) { log.warn('GolfSL', `get_markets ${evt.event_id} failed: ${e.message}`); continue; }
    for (const mkt of markets) {
      if (!_isMatchupMarket(mkt)) continue;
      const sels = _flattenSelections(mkt.selections);
      if (sels.length < 2) continue;
      const sides = sels.filter(s => s && s.line_id).map(s => ({
        line_id: s.line_id,
        side_name: s.name || s.display_name || '?',
        competitor_id: s.competitor_id,
      }));
      // Compute opponent names (the OTHER side of the matchup)
      for (const s of sides) {
        const opp = sides.find(o => o.line_id !== s.line_id);
        s.opponent_name = opp ? opp.side_name : null;
      }
      out.push({
        event_id: evt.event_id,
        tournament_name: evt.tournament_name || '',
        scheduled: evt.scheduled || null,
        market_id: mkt.id,
        market_name: mkt.name || '',
        round_num: _parseRoundNum(mkt.name) || _parseRoundNum(evt.name),
        sides,
      });
    }
  }
  return out;
}

// Upsert discovered matchups into golf_single_leg_config. New sides land
// with enabled=false / risk_amount=null per Mike's spec (no default risk —
// nothing posts unless he explicitly configures it). Existing rows keep
// user preferences; we only touch the descriptive fields.
async function syncConfig(matchups) {
  const sb = db.getClient && db.getClient();
  if (!sb) throw new Error('GolfSL: Supabase client not available');
  const rows = [];
  for (const m of matchups) {
    for (const s of m.sides) {
      rows.push({
        line_id: s.line_id,
        event_id: m.event_id,
        market_id: m.market_id,
        tournament_name: m.tournament_name,
        matchup_name: m.market_name,
        side_name: s.side_name,
        side_opponent: s.opponent_name,
        round_num: m.round_num,
      });
    }
  }
  if (!rows.length) return { upserted: 0 };
  // Upsert on line_id — only descriptive fields written; risk_amount + enabled
  // are user-controlled and we don't overwrite them after first insert.
  const { error } = await sb.from(TBL_CONFIG).upsert(rows, {
    onConflict: 'line_id',
    ignoreDuplicates: false,
  });
  if (error) throw new Error('syncConfig upsert: ' + error.message);
  return { upserted: rows.length };
}

// ---------------------------------------------------------------------------
// Pricing — get fair_prob for a line, then compute offered via the same
// path the RFQ pricer uses for single-leg golf matchups.
// ---------------------------------------------------------------------------
function _fairForLine(lineId) {
  const info = lineManager.lookupLine(lineId);
  if (!info) return { fair: null, reason: 'line not in parlay-SP index' };
  const fp = Number(info.fairProb);
  if (!isFinite(fp) || fp <= 0 || fp >= 1) return { fair: null, reason: 'no fair_prob on line' };
  // Honor the manual-upload override if present (bookPriceOverride bypasses vig
  // entirely — Mike's golf-matchup workflow already populates this).
  if (info.bookPriceOverride != null) {
    return { fair: fp, override: Number(info.bookPriceOverride), sport: info.sport, marketType: info.marketType };
  }
  return { fair: fp, sport: info.sport || 'golf_matchups', marketType: info.marketType || 'moneyline' };
}

function _americanFromImplied(p) {
  if (!isFinite(p) || p <= 0 || p >= 1) return null;
  // Standard conversion. positive_odds = (1/p - 1) * 100, negative = -100*p/(1-p)
  return p >= 0.5
    ? Math.round(-100 * p / (1 - p))
    : Math.round((1 / p - 1) * 100);
}

function _impliedFromAmerican(a) {
  a = Number(a); if (!isFinite(a)) return null;
  return a >= 0 ? 100 / (a + 100) : (-a) / (-a + 100);
}

function _computeOffered(lineId) {
  const f = _fairForLine(lineId);
  if (!f.fair) return { ok: false, reason: f.reason };
  // If override is set, just use it (Mike's manual upload pricing).
  if (f.override != null && f.override > 0 && f.override < 1) {
    return { ok: true, fair: f.fair, offeredProb: f.override, americanOdds: _americanFromImplied(f.override), source: 'override' };
  }
  // Otherwise route through the standard single-leg quote path.
  let q;
  try { q = pricer.computeSingleLegQuote(f.fair, f.sport, f.marketType); }
  catch (e) { return { ok: false, reason: 'computeSingleLegQuote: ' + e.message }; }
  if (!q || q.americanOdds == null) return { ok: false, reason: 'single-leg-quote returned null' };
  return {
    ok: true,
    fair: f.fair,
    offeredProb: q.impliedProb,
    americanOdds: q.americanOdds,
    vig: q.vig,
    source: 'computeSingleLegQuote',
  };
}

// ---------------------------------------------------------------------------
// Posting — read enabled rows, compute offered, snap to ladder, place wagers
// in batches of 20.
// ---------------------------------------------------------------------------
async function _activeWagersByLine() {
  const sb = db.getClient();
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, line_id, posted_odds, posted_stake, posted_fair_prob, status, posted_at')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('_activeWagersByLine: ' + error.message);
  const byLine = new Map();
  for (const w of (data || [])) {
    if (!byLine.has(w.line_id)) byLine.set(w.line_id, []);
    byLine.get(w.line_id).push(w);
  }
  return byLine;
}

async function postEnabled(opts = {}) {
  const sb = db.getClient();
  // Fetch enabled & risk-configured rows
  const { data: cfgRows, error } = await sb.from(TBL_CONFIG)
    .select('*')
    .eq('enabled', true)
    .not('risk_amount', 'is', null)
    .gt('risk_amount', 0);
  if (error) throw new Error('postEnabled select: ' + error.message);
  if (!cfgRows || cfgRows.length === 0) return { posted: 0, skipped: 0, errors: [], detail: 'no enabled+risk-set rows' };

  // Skip lines that already have an active wager
  const activeByLine = await _activeWagersByLine();
  const ladder = await pxSingle.fetchOddsLadder();

  const orders = [];
  const skipped = [];
  for (const row of cfgRows) {
    if (activeByLine.has(row.line_id)) { skipped.push({ line_id: row.line_id, reason: 'already-posted' }); continue; }
    const q = _computeOffered(row.line_id);
    if (!q.ok) { skipped.push({ line_id: row.line_id, reason: q.reason }); continue; }
    const snapped = pxSingle.snapToLadder(q.americanOdds, ladder);
    orders.push({
      line_id: row.line_id,
      odds: snapped,
      stake: Number(row.risk_amount),
      external_id: 'gsl_' + row.line_id.slice(0, 8) + '_' + Date.now(),
      _meta: { fair: q.fair, side_name: row.side_name, matchup: row.matchup_name },
    });
  }
  if (!orders.length) return { posted: 0, skipped: skipped.length, errors: [], skippedDetail: skipped };

  // Batch up to 20 per PX call
  let posted = 0;
  const errors = [];
  const wagerRows = [];
  for (let i = 0; i < orders.length; i += 20) {
    const batch = orders.slice(i, i + 20);
    let resp;
    try { resp = await pxSingle.placeMultipleWagers(batch.map(o => ({ line_id: o.line_id, odds: o.odds, stake: o.stake, external_id: o.external_id }))); }
    catch (e) { errors.push('batch error: ' + e.message); continue; }
    for (const w of resp.succeed_wagers) {
      const matching = batch.find(o => o.external_id === w.external_id);
      if (!matching) continue;
      posted++;
      wagerRows.push({
        wager_id: w.wager_id || w.id,
        line_id: matching.line_id,
        event_id: cfgRows.find(c => c.line_id === matching.line_id)?.event_id,
        external_id: matching.external_id,
        posted_odds: matching.odds,
        posted_stake: matching.stake,
        posted_fair_prob: matching._meta.fair,
        status: w.matching_status || 'posted',
        status_detail: null,
        posted_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
    }
    for (const f of resp.failed_wagers) {
      const idx = f.index != null ? f.index : -1;
      const ext = idx >= 0 && idx < batch.length ? batch[idx].external_id : null;
      errors.push((ext || '?') + ': ' + (f.message || f.error || 'unknown'));
    }
  }
  // Persist new wagers
  if (wagerRows.length) {
    const { error: insErr } = await sb.from(TBL_WAGERS).upsert(wagerRows, { onConflict: 'wager_id' });
    if (insErr) errors.push('wagers upsert: ' + insErr.message);
  }
  return { posted, skipped: skipped.length, errors, skippedDetail: skipped };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
async function cancelAll() {
  const sb = db.getClient();
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, line_id')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('cancelAll select: ' + error.message);
  let cancelled = 0;
  const errors = [];
  for (const w of (data || [])) {
    try {
      await pxSingle.cancelWager(w.wager_id);
      cancelled++;
      await sb.from(TBL_WAGERS).update({ status: 'cancelled', cancelled_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('wager_id', w.wager_id);
    } catch (e) { errors.push(w.wager_id + ': ' + e.message); }
  }
  return { cancelled, errors };
}

async function cancelStale(currentLineIdSet) {
  // currentLineIdSet = lines present in the latest PX discovery. Wagers on
  // line_ids NOT in this set are cancelled.
  const sb = db.getClient();
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, line_id')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('cancelStale select: ' + error.message);
  let cancelled = 0;
  const errors = [];
  for (const w of (data || [])) {
    if (currentLineIdSet.has(w.line_id)) continue; // still present
    try {
      await pxSingle.cancelWager(w.wager_id);
      cancelled++;
      await sb.from(TBL_WAGERS).update({ status: 'cancelled', status_detail: 'line removed from PX', cancelled_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('wager_id', w.wager_id);
    } catch (e) { errors.push(w.wager_id + ': ' + e.message); }
  }
  return { cancelled, errors };
}

// For every active wager, recompute fair; if drift >= driftPp implied, cancel
// + repost. (Repost happens on the next postEnabled() call.)
async function refreshDrift() {
  const { driftPp } = _cfg();
  const sb = db.getClient();
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, line_id, posted_fair_prob, posted_odds')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('refreshDrift select: ' + error.message);
  let drifted = 0;
  const errors = [];
  for (const w of (data || [])) {
    const q = _computeOffered(w.line_id);
    if (!q.ok) continue;
    const driftPpNow = Math.abs((q.offeredProb - _impliedFromAmerican(w.posted_odds)) * 100);
    if (driftPpNow >= driftPp) {
      try {
        await pxSingle.cancelWager(w.wager_id);
        await sb.from(TBL_WAGERS).update({
          status: 'cancelled',
          status_detail: `drift ${driftPpNow.toFixed(2)}pp >= ${driftPp}pp`,
          cancelled_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        }).eq('wager_id', w.wager_id);
        drifted++;
      } catch (e) { errors.push(w.wager_id + ': ' + e.message); }
    }
  }
  return { drifted, errors };
}

// ---------------------------------------------------------------------------
// State for UI
// ---------------------------------------------------------------------------
async function loadState() {
  const sb = db.getClient();
  if (!sb) return { error: 'no DB' };
  const [{ data: cfg, error: cfgErr }, { data: wagers, error: wErr }] = await Promise.all([
    sb.from(TBL_CONFIG).select('*').order('tournament_name', { ascending: true }).order('matchup_name', { ascending: true }),
    sb.from(TBL_WAGERS).select('*').in('status', ['posted', 'partially_matched']),
  ]);
  if (cfgErr) return { error: 'config: ' + cfgErr.message };
  if (wErr) return { error: 'wagers: ' + wErr.message };
  // Enrich each config row with current fair + offered (best-effort)
  const enriched = (cfg || []).map(r => {
    const q = _computeOffered(r.line_id);
    return {
      ...r,
      current_fair_prob: q.ok ? q.fair : null,
      current_offered_prob: q.ok ? q.offeredProb : null,
      current_american: q.ok ? q.americanOdds : null,
      fair_unavailable_reason: q.ok ? null : q.reason,
    };
  });
  const activeByLine = new Map();
  for (const w of (wagers || [])) {
    if (!activeByLine.has(w.line_id)) activeByLine.set(w.line_id, []);
    activeByLine.get(w.line_id).push(w);
  }
  for (const r of enriched) {
    r.active_wagers = activeByLine.get(r.line_id) || [];
  }
  return { config: enriched, totalActive: (wagers || []).length };
}

// ---------------------------------------------------------------------------
// User updates to risk_amount / enabled
// ---------------------------------------------------------------------------
async function updateConfig(updates) {
  // updates: [{ line_id, risk_amount?, enabled?, notes? }, ...]
  const sb = db.getClient();
  if (!Array.isArray(updates) || updates.length === 0) return { updated: 0 };
  let updated = 0;
  const errors = [];
  for (const u of updates) {
    if (!u.line_id) { errors.push('missing line_id'); continue; }
    const patch = {};
    if (u.risk_amount !== undefined) patch.risk_amount = u.risk_amount === null ? null : Number(u.risk_amount);
    if (u.enabled !== undefined) patch.enabled = !!u.enabled;
    if (u.notes !== undefined) patch.notes = u.notes ? String(u.notes) : null;
    if (Object.keys(patch).length === 0) continue;
    const { error } = await sb.from(TBL_CONFIG).update(patch).eq('line_id', u.line_id);
    if (error) errors.push(u.line_id + ': ' + error.message);
    else updated++;
  }
  return { updated, errors };
}

// ---------------------------------------------------------------------------
// Lifecycle worker
// ---------------------------------------------------------------------------
let _workerHandle = null;
async function _workerTick() {
  if (!isEnabled()) return;
  try {
    const matchups = await discoverGolfMatchups();
    await syncConfig(matchups);
    const currentLineIds = new Set();
    for (const m of matchups) for (const s of m.sides) currentLineIds.add(s.line_id);
    await cancelStale(currentLineIds);
    await refreshDrift();
    await postEnabled(); // re-post anything cancelled-for-drift or newly enabled
    log.debug('GolfSL', `worker tick ok (${matchups.length} matchups)`);
  } catch (e) {
    log.error('GolfSL', 'worker tick error: ' + e.message);
  }
}

function startWorker() {
  if (!isEnabled()) {
    log.info('GolfSL', 'GOLF_SINGLE_LEG_ENABLED is not true — worker disabled');
    return;
  }
  if (_workerHandle) return;
  const { refreshMin } = _cfg();
  const intervalMs = Math.max(1, refreshMin) * 60 * 1000;
  log.info('GolfSL', `Starting lifecycle worker (every ${refreshMin}min)`);
  // Initial tick after a short delay so app finishes booting
  setTimeout(() => { _workerTick().catch(() => {}); }, 15_000);
  _workerHandle = setInterval(() => { _workerTick().catch(() => {}); }, intervalMs);
}

function stopWorker() {
  if (_workerHandle) { clearInterval(_workerHandle); _workerHandle = null; }
}

module.exports = {
  isEnabled,
  discoverGolfMatchups,
  syncConfig,
  loadState,
  postEnabled,
  cancelAll,
  cancelStale,
  refreshDrift,
  updateConfig,
  startWorker,
  stopWorker,
  // internals exposed for endpoint composability
  _computeOffered,
};
