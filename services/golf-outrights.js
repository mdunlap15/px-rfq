// ============================================================================
// golf-outrights.js — Bulk-post YES offers on PX golf outright markets
// (Top 1 / 5 / 10 / 20 / Make Cut), priced from DraftKings + sweetener.
// ============================================================================
// Why DK and not DataGolf: DataGolf's outright odds use "dead-heat" settlement
// rules, while PX settles "ties included." The two produce materially different
// fair probabilities, so DataGolf is not a substitute — we must scrape DK.
//
// Pricing model (per Mike's existing workflow):
//   offered_implied = dk_implied × (1 + GOLF_OUTRIGHTS_SWEETENER)
//   We post YES offers only (= responding to NO requests from PX bettors).
//
// Reuses:
//   - services/px-single.js for ALL PX I/O (second account, isolated session)
//   - services/dk-scraper.js → fetchGolfOutrights(slug) for DK odds
//
// State (Supabase tables — see scripts/_golf_outrights_schema.sql):
//   golf_outright_tournaments  — slug → DK URL (operator-managed)
//   golf_outright_config       — per (player, market) row: risk_amount, enabled
//   golf_outright_wagers       — runtime state of posted wagers
//
// All operations no-op cleanly when GOLF_OUTRIGHTS_ENABLED is unset.
// ============================================================================

const log = require('./logger');
const pxSingle = require('./px-single');
const dkScraper = require('./dk-scraper');
const db = require('./db');

const TBL_TOURN  = 'golf_outright_tournaments';
const TBL_CONFIG = 'golf_outright_config';
const TBL_WAGERS = 'golf_outright_wagers';

function _cfg() {
  return {
    enabled: String(process.env.GOLF_OUTRIGHTS_ENABLED || '').toLowerCase() === 'true',
    sweetener: Number(process.env.GOLF_OUTRIGHTS_SWEETENER) || 0.01,
    refreshMin: Number(process.env.GOLF_OUTRIGHTS_REFRESH_MINUTES) || 10,
    driftPp: Number(process.env.GOLF_OUTRIGHTS_DRIFT_PP) || 2,
  };
}
function isEnabled() { return _cfg().enabled; }

const aImpl = a => { if (a == null || a === '') return null; const n = Number(a); if (!isFinite(n) || n === 0) return null; return n >= 0 ? 100 / (n + 100) : (-n) / (-n + 100); };
const americanFromImplied = p => {
  if (!isFinite(p) || p <= 0 || p >= 1) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round((1 / p - 1) * 100);
};

// Normalize player names for fuzzy DK↔PX matching. Lowercase, strip diacritics,
// drop periods/apostrophes/dashes, collapse whitespace. Mirrors the DataGolf
// approach used in the matchup pipeline.
function _normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// PX data model for outrights: EACH PLAYER IS ITS OWN MARKET inside an
// EVENT that names the market_type. Verified 2026-06-02 on The Memorial:
//   event.name = "2026 the Memorial Tournament... - Tournament Winner"
//     market.name = "Rickie Fowler"   selections = [YES, NO]
//     market.name = "Jordan Spieth"   selections = [YES, NO]
//     ... (72 player markets total)
//
// So we classify market_type from the EVENT name (not the market name),
// use market.name as player_name, and grab the YES selection's line_id.
const PX_EVENT_PATTERNS = [
  { key: 'top_1',    re: /tournament\s+winner|outright\s+winner|to\s+win\s+(?:the\s+)?tournament|^winner$/i },
  { key: 'top_5',    re: /top[\s-]?5(?:\s+finish)?/i },
  { key: 'top_10',   re: /top[\s-]?10(?:\s+finish)?/i },
  { key: 'top_20',   re: /top[\s-]?20(?:\s+finish)?/i },
  { key: 'make_cut', re: /make.*cut|miss.*cut/i },
];
function classifyPxEventName(name) {
  for (const p of PX_EVENT_PATTERNS) if (p.re.test(name || '')) return p.key;
  return null;
}

// ---------------------------------------------------------------------------
// Tournaments (operator-managed)
// ---------------------------------------------------------------------------
async function listTournaments() {
  const sb = db.getClient && db.getClient();
  if (!sb) throw new Error('Supabase not available');
  const { data, error } = await sb.from(TBL_TOURN).select('*').order('created_at', { ascending: false });
  if (error) throw new Error('listTournaments: ' + error.message);
  return data || [];
}
async function upsertTournament({ dk_slug, dk_url, tournament_name, enabled = true, notes = null }) {
  const sb = db.getClient();
  if (!dk_slug && dk_url) {
    // Extract slug from URL: /leagues/golf/<slug>?...
    const m = String(dk_url).match(/\/leagues\/golf\/([^/?#]+)/i);
    if (m) dk_slug = m[1];
  }
  if (!dk_slug || !dk_url) throw new Error('upsertTournament: dk_slug + dk_url required');
  const row = { dk_slug, dk_url, tournament_name, enabled: !!enabled, notes };
  const { error } = await sb.from(TBL_TOURN).upsert(row, { onConflict: 'dk_slug' });
  if (error) throw new Error('upsertTournament: ' + error.message);
  return { ok: true, dk_slug };
}
async function deleteTournament(dk_slug) {
  const sb = db.getClient();
  const { error } = await sb.from(TBL_TOURN).delete().eq('dk_slug', dk_slug);
  if (error) throw new Error('deleteTournament: ' + error.message);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Discovery: scrape DK + match to PX outright lines + upsert config
// ---------------------------------------------------------------------------

// For a given DK player name + market_type, find the matching PX line_id from
// the SINGLE-LEG account's events. Returns { px_line_id, px_event_id, px_market_id }
// or null. Caches the per-tournament PX market scan to avoid N×M calls.
async function _pxMarketsFor(slug) {
  const events = await pxSingle.fetchSportEvents();
  // Match tournament by slug — DK slugs like "the-memorial-tournament" tend to
  // appear normalized in PX event names. Use loose contains-all-words match.
  const slugWords = String(slug).split('-').filter(w => w.length > 2);
  const golfEvents = events.filter(e => String(e.sport_name || '').toLowerCase().includes('golf'));
  const matched = golfEvents.filter(e => {
    const n = String(e.name || '').toLowerCase();
    return slugWords.every(w => n.includes(w.toLowerCase()));
  });
  if (!matched.length) return { eventCount: 0, byMarketType: {} };
  // PX model: event_name carries the market_type ("...Tournament Winner",
  // "...Top 5 Finish"). Each market inside is one player as a YES/NO pair.
  const byMarketType = {}; // 'top_1' -> [{ player_name, line_id, event_id, market_id }, ...]
  let eventsScanned = 0;
  for (const evt of matched) {
    const mtype = classifyPxEventName(evt.name);
    if (!mtype) continue; // novelty event ("Will Any Player Be Bogey Free…") etc.
    eventsScanned++;
    let mkts;
    try { mkts = await pxSingle.fetchMarkets(evt.event_id); }
    catch (e) { log.warn('GolfOut', `PX get_markets ${evt.event_id} failed: ${e.message}`); continue; }
    if (!byMarketType[mtype]) byMarketType[mtype] = [];
    for (const mkt of mkts) {
      const playerName = String(mkt.name || '').trim();
      if (!playerName) continue;
      // Flatten selections + find the YES one (case-insensitive).
      const flat = [];
      if (Array.isArray(mkt.selections)) {
        for (const g of mkt.selections) {
          if (Array.isArray(g)) flat.push(...g);
          else flat.push(g);
        }
      }
      const yesSel = flat.find(s => s && /^yes$/i.test(String(s.name || '').trim()));
      if (!yesSel || !yesSel.line_id) continue;
      // Also grab the NO selection's line_id — needed to post the NO side (we hold
      // NO; the counterparty backs YES). Markets are YES/NO pairs, but tolerate a
      // missing NO selection (skips only the NO-side post for that row).
      const noSel = flat.find(s => s && /^no$/i.test(String(s.name || '').trim()));
      byMarketType[mtype].push({
        player_name: playerName,
        player_norm: _normName(playerName),
        line_id: yesSel.line_id,
        no_line_id: (noSel && noSel.line_id) ? noSel.line_id : null,
        event_id: evt.event_id,
        market_id: mkt.id,
      });
    }
  }
  return { eventCount: eventsScanned, byMarketType };
}

async function syncTournament(dk_slug, opts = {}) {
  const sb = db.getClient();
  if (!sb) throw new Error('Supabase not available');
  const { data: tRow, error: tErr } = await sb.from(TBL_TOURN).select('*').eq('dk_slug', dk_slug).maybeSingle();
  if (tErr) throw new Error('syncTournament select: ' + tErr.message);
  if (!tRow) throw new Error('syncTournament: tournament not registered: ' + dk_slug);

  // 1. Scrape DK. `force` (manual Sync) bypasses the 15-min scraper cache so the
  // operator always sees current DK state; the worker omits it to stay cached.
  let dk;
  try { dk = await dkScraper.fetchGolfOutrights(dk_slug, { force: !!opts.force }); }
  catch (e) { throw new Error('DK scrape failed: ' + e.message); }
  // Scraper diagnostics — surfaced in the return so the UI shows exactly what DK
  // served. Distinguishes "DK hasn't posted Top 5/10/20 yet" from "we hit the
  // wrong subcategory tab" (nothing seen) from "regex miss" (seen but uncategorized).
  const diag = {
    captured_keys: dk.capturedKeys || [],
    seen_market_names: dk.seenMarketNames || [],
    uncategorized: dk.uncategorizedMarketNames || [],
  };
  if (!dk.markets || !dk.markets.length) {
    return { ok: true, dk_slug, dk_markets: 0, px_events: 0, upserted: 0, ...diag, warning: 'DK returned no categorizable outright markets — wrong slug or no outrights up yet' };
  }

  // 2. Build PX line lookup (one fetch per tournament)
  const px = await _pxMarketsFor(dk_slug);

  // 3. For each (DK market × DK player), find PX line + upsert config
  const { sweetener } = _cfg();
  const upserts = [];
  let dkSelections = 0, pxMatched = 0;
  for (const dkMkt of dk.markets) {
    const pxList = px.byMarketType[dkMkt.marketType] || [];
    const pxByNorm = new Map();
    for (const p of pxList) pxByNorm.set(p.player_norm, p);
    for (const sel of dkMkt.selections) {
      dkSelections++;
      const dkImpl = aImpl(sel.americanOdds);
      if (dkImpl == null) continue;
      const offeredImpl = Math.min(0.99, dkImpl * (1 + sweetener));
      const offeredAm = americanFromImplied(offeredImpl);
      const pxMatch = pxByNorm.get(_normName(sel.playerName));
      if (pxMatch) pxMatched++;
      upserts.push({
        dk_slug,
        market_type: dkMkt.marketType,
        player_name: sel.playerName,
        side: 'yes',
        px_line_id: pxMatch ? pxMatch.line_id : null,
        px_no_line_id: pxMatch ? pxMatch.no_line_id : null,
        px_event_id: pxMatch ? pxMatch.event_id : null,
        px_market_id: pxMatch ? pxMatch.market_id : null,
        dk_american_odds: sel.americanOdds,
        dk_implied: Math.round(dkImpl * 100000) / 100000,
        offered_implied: Math.round(offeredImpl * 100000) / 100000,
        offered_american: offeredAm,
      });
    }
  }

  // Upsert in chunks (Supabase limits payload size)
  let upserted = 0;
  for (let i = 0; i < upserts.length; i += 500) {
    const chunk = upserts.slice(i, i + 500);
    const { error } = await sb.from(TBL_CONFIG).upsert(chunk, {
      onConflict: 'dk_slug,market_type,player_name,side',
      ignoreDuplicates: false,
    });
    if (error) throw new Error('upsert chunk: ' + error.message);
    upserted += chunk.length;
  }
  // Touch tournament last_scraped_at
  await sb.from(TBL_TOURN).update({ last_scraped_at: new Date().toISOString() }).eq('dk_slug', dk_slug);

  return {
    ok: true,
    dk_slug,
    dk_markets: dk.markets.length,
    dk_selections: dkSelections,
    px_events: px.eventCount,
    px_matched_selections: pxMatched,
    upserted,
    ...diag,
  };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------
async function _activeWagersByConfigId() {
  const sb = db.getClient();
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, config_id, px_line_id, posted_odds, posted_dk_implied, status')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('activeWagers: ' + error.message);
  const byCfg = new Map();
  for (const w of (data || [])) {
    if (w.config_id != null && !byCfg.has(w.config_id)) byCfg.set(w.config_id, w);
  }
  return byCfg;
}

// Build the PX order for one config row, honoring post_side. THE single place the
// side math lives, so both postEnabled and repostOne are guaranteed consistent.
//   post_side 'no'  (default) = LAY THE FIELD: post on the NO line at the
//      complement of our offered YES price, so the counterparty backs YES at the
//      offered price (e.g. McIlroy offered YES +193 -> we post NO -193; cp gets
//      YES +193). This is the +EV book side.
//   post_side 'yes'          = BACK THE PLAYER: post on the YES line at the
//      offered price; the counterparty backs NO and we hold the player's YES.
// Returns { ok, side, lineId, odds } or { ok:false, reason }.
function _buildOutrightOrder(row, ladder) {
  const side = (row.post_side === 'yes') ? 'yes' : 'no';
  // Effective offered YES price: a manual override (operator-typed) if set, else
  // the auto price (DK american x (1 + sweetener)). The override is always the
  // YES price a counterparty pays; the side toggle decides how it's realized
  // (NO = post the complement on the NO line so the cp backs YES at this price).
  const manual = (row.manual_offered_american != null && Number(row.manual_offered_american) !== 0) ? Number(row.manual_offered_american) : null;
  const offImpl = manual != null ? aImpl(manual) : Number(row.offered_implied);
  if (!(offImpl > 0 && offImpl < 1)) return { ok: false, reason: 'no offered price' };
  const offAmerican = manual != null ? manual : Number(row.offered_american);
  let lineId, rawAmerican;
  if (side === 'yes') {
    lineId = row.px_line_id;
    rawAmerican = offAmerican;
    if (!lineId) return { ok: false, reason: 'no PX yes line' };
    if (!isFinite(rawAmerican)) return { ok: false, reason: 'no offered price' };
  } else {
    lineId = row.px_no_line_id;
    rawAmerican = americanFromImplied(1 - offImpl);
    if (!lineId) return { ok: false, reason: 'no PX no line (re-sync after migration)' };
    if (rawAmerican == null) return { ok: false, reason: 'no-side odds out of range' };
  }
  const snapped = pxSingle.snapToLadder(rawAmerican, ladder);
  return { ok: true, side, lineId, odds: snapped, isOverride: manual != null };
}

// Place a batch of orders on PX and record the resulting wagers. Shared by
// postEnabled (bulk) and repostOne (single). Returns { posted, errors }.
async function _placeAndRecord(orders) {
  const sb = db.getClient();
  let posted = 0; const errors = []; const wagerRows = [];
  for (let i = 0; i < orders.length; i += 20) {
    const batch = orders.slice(i, i + 20);
    let resp;
    try { resp = await pxSingle.placeMultipleWagers(batch.map(o => ({ line_id: o.line_id, odds: o.odds, stake: o.stake, external_id: o.external_id }))); }
    catch (e) { errors.push('batch error: ' + e.message); continue; }
    for (const w of (resp.succeed_wagers || [])) {
      const m = batch.find(o => o.external_id === w.external_id);
      if (!m) continue;
      const wagerId = w.wager_id || w.id || null;
      if (!wagerId) {
        // PX claimed success but gave no id to track/cancel — same "posted but
        // not on book" failure mode guarded in the single-leg bot. Don't record.
        errors.push((m.external_id) + ': succeeded with no wager_id — verify on PX');
        continue;
      }
      posted++;
      wagerRows.push({
        wager_id: wagerId,
        config_id: m._config_id,
        dk_slug: m._dk_slug,
        px_line_id: m.line_id,
        px_event_id: m._event_id,
        external_id: m.external_id,
        posted_odds: m.odds,
        posted_stake: m.stake,
        posted_dk_implied: m._dk_implied,
        status: w.matching_status || 'posted',
        posted_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
    }
    for (const f of (resp.failed_wagers || [])) {
      const idx = f.index != null ? f.index : -1;
      const ext = idx >= 0 && idx < batch.length ? batch[idx].external_id : null;
      errors.push((ext || '?') + ': ' + (f.message || f.error || 'unknown'));
    }
  }
  if (wagerRows.length) {
    const { error: insErr } = await sb.from(TBL_WAGERS).upsert(wagerRows, { onConflict: 'wager_id' });
    if (insErr) errors.push('wagers upsert: ' + insErr.message);
  }
  return { posted, errors };
}

async function postEnabled(opts = {}) {
  const sb = db.getClient();
  // Which rows: opts.only (config ids) = post exactly those SELECTED rows
  // (ignores the enabled flag — selection is the explicit intent); otherwise
  // every enabled + risk-set row. opts.dryRun = build the plan, place NOTHING.
  // (PX line presence is checked per-row in _buildOutrightOrder, since the
  // required line depends on post_side.)
  let q = sb.from(TBL_CONFIG).select('*').not('risk_amount', 'is', null).gt('risk_amount', 0).not('offered_american', 'is', null);
  if (Array.isArray(opts.only) && opts.only.length) q = q.in('id', opts.only);
  else q = q.eq('enabled', true);
  const { data: cfgRows, error } = await q;
  if (error) throw new Error('postEnabled select: ' + error.message);
  if (!cfgRows || !cfgRows.length) return { posted: 0, skipped: 0, errors: [], dryRun: !!opts.dryRun, plan: [], detail: (Array.isArray(opts.only) && opts.only.length) ? 'no selected rows ready' : 'no enabled+ready rows' };

  const active = await _activeWagersByConfigId();
  const ladder = await pxSingle.fetchOddsLadder();

  const orders = []; const skipped = [];
  for (const row of cfgRows) {
    if (active.has(row.id)) { skipped.push({ id: row.id, reason: 'already-posted' }); continue; }
    const b = _buildOutrightOrder(row, ladder);
    if (!b.ok) { skipped.push({ id: row.id, reason: b.reason }); continue; }
    orders.push({
      _config_id: row.id,
      _dk_slug: row.dk_slug,
      _dk_implied: Number(row.dk_implied),
      _event_id: row.px_event_id,
      _player: row.player_name,
      _market: row.market_type,
      _side: b.side,
      line_id: b.lineId,
      odds: b.odds,
      stake: Number(row.risk_amount),
      external_id: 'go_' + row.id + '_' + Date.now(),
    });
  }
  // Dry-run: return the exact plan without touching PX (powers the confirm modal).
  if (opts.dryRun) {
    return {
      ok: true, dryRun: true,
      plan: orders.map(o => ({ config_id: o._config_id, player_name: o._player, market_type: o._market, side: o._side, odds: o.odds, stake: o.stake })),
      skipped: skipped.length, skippedDetail: skipped,
    };
  }
  if (!orders.length) return { posted: 0, skipped: skipped.length, errors: [], skippedDetail: skipped };

  const { posted, errors } = await _placeAndRecord(orders);
  return { posted, skipped: skipped.length, errors, skippedDetail: skipped };
}

// Cancel a single resting wager by PX wager_id (per-line Cancel button).
async function cancelOne(wagerId) {
  const sb = db.getClient();
  if (!wagerId) throw new Error('wager_id required');
  await pxSingle.cancelWager(wagerId);
  await sb.from(TBL_WAGERS).update({
    status: 'cancelled', status_detail: 'manual cancel (single)',
    cancelled_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  }).eq('wager_id', wagerId);
  return { ok: true, cancelled: wagerId };
}

// Edit-risk on a live offer: cancel this row's active wager(s) and repost at the
// current config (new stake/side). PX can't change a resting stake in place, so
// this is the cancel+repost path behind the per-line "Update" button.
async function repostOne(configId) {
  const sb = db.getClient();
  if (configId == null) throw new Error('config_id required');
  const { data: row, error: rErr } = await sb.from(TBL_CONFIG).select('*').eq('id', configId).maybeSingle();
  if (rErr) throw new Error('repostOne select: ' + rErr.message);
  if (!row) throw new Error('config row not found: ' + configId);

  let cancelled = 0; const errors = [];
  const { data: act } = await sb.from(TBL_WAGERS).select('wager_id').eq('config_id', configId).in('status', ['posted', 'partially_matched']);
  for (const w of (act || [])) {
    try {
      await pxSingle.cancelWager(w.wager_id);
      await sb.from(TBL_WAGERS).update({ status: 'cancelled', status_detail: 'edit-risk repost', cancelled_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('wager_id', w.wager_id);
      cancelled++;
    } catch (e) { errors.push('cancel ' + w.wager_id + ': ' + e.message); }
  }

  if (!row.enabled) return { ok: true, cancelled, posted: 0, errors, detail: 'row disabled — cancelled only' };
  if (!(Number(row.risk_amount) > 0)) return { ok: true, cancelled, posted: 0, errors, detail: 'no risk set — cancelled only' };
  const ladder = await pxSingle.fetchOddsLadder();
  const b = _buildOutrightOrder(row, ladder);
  if (!b.ok) return { ok: true, cancelled, posted: 0, errors: errors.concat(b.reason) };
  const order = {
    _config_id: row.id, _dk_slug: row.dk_slug, _dk_implied: Number(row.dk_implied),
    _event_id: row.px_event_id, line_id: b.lineId, odds: b.odds,
    stake: Number(row.risk_amount), external_id: 'go_' + row.id + '_' + Date.now(),
  };
  const { posted, errors: postErrs } = await _placeAndRecord([order]);
  return { ok: true, cancelled, posted, errors: errors.concat(postErrs) };
}

async function cancelAll() {
  const sb = db.getClient();
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, px_line_id')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('cancelAll select: ' + error.message);
  let cancelled = 0; const errors = [];
  for (const w of (data || [])) {
    try {
      await pxSingle.cancelWager(w.wager_id);
      cancelled++;
      await sb.from(TBL_WAGERS).update({ status: 'cancelled', cancelled_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('wager_id', w.wager_id);
    } catch (e) { errors.push(w.wager_id + ': ' + e.message); }
  }
  return { cancelled, errors };
}

// Drift detection: for each active wager, recompute the current DK implied,
// compare to posted_dk_implied. If shifted by > driftPp, cancel + repost on
// next postEnabled cycle.
async function refreshDrift() {
  const { driftPp, sweetener } = _cfg();
  const sb = db.getClient();
  const { data: wagers, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, config_id, posted_dk_implied')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('refreshDrift select: ' + error.message);
  if (!wagers || !wagers.length) return { drifted: 0, errors: [] };

  // Pull current DK implied per config row
  const cfgIds = wagers.map(w => w.config_id).filter(Boolean);
  if (!cfgIds.length) return { drifted: 0, errors: [] };
  const { data: cfgRows, error: cErr } = await sb.from(TBL_CONFIG)
    .select('id, dk_implied, manual_offered_american')
    .in('id', cfgIds);
  if (cErr) throw new Error('refreshDrift cfg: ' + cErr.message);
  const cfgById = new Map((cfgRows || []).map(r => [r.id, r]));

  let drifted = 0; const errors = [];
  for (const w of wagers) {
    const cfg = cfgById.get(w.config_id);
    if (!cfg || cfg.dk_implied == null) continue;
    // Manually-priced offers ignore DK drift — the operator set the price on
    // purpose, so don't pull it just because DK moved.
    if (cfg.manual_offered_american != null && Number(cfg.manual_offered_american) !== 0) continue;
    const driftPpNow = Math.abs((Number(cfg.dk_implied) - Number(w.posted_dk_implied)) * 100);
    if (driftPpNow >= driftPp) {
      try {
        await pxSingle.cancelWager(w.wager_id);
        await sb.from(TBL_WAGERS).update({
          status: 'cancelled',
          status_detail: `DK drift ${driftPpNow.toFixed(2)}pp >= ${driftPp}pp`,
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
  const [tRes, cRes, wRes] = await Promise.all([
    sb.from(TBL_TOURN).select('*').order('created_at', { ascending: false }),
    sb.from(TBL_CONFIG).select('*').order('dk_slug').order('market_type').order('player_name'),
    sb.from(TBL_WAGERS).select('*').in('status', ['posted', 'partially_matched']),
  ]);
  if (tRes.error) return { error: 'tournaments: ' + tRes.error.message };
  if (cRes.error) return { error: 'config: ' + cRes.error.message };
  if (wRes.error) return { error: 'wagers: ' + wRes.error.message };
  const wagerByCfg = new Map();
  for (const w of (wRes.data || [])) {
    if (!wagerByCfg.has(w.config_id)) wagerByCfg.set(w.config_id, []);
    wagerByCfg.get(w.config_id).push(w);
  }
  // Tag each active wager with the side it represents (compare its line_id to the
  // row's NO line) so the UI can label live offers YES/NO without extra columns.
  const enriched = (cRes.data || []).map(r => {
    const aw = (wagerByCfg.get(r.id) || []).map(w => ({
      ...w,
      side: (w.px_line_id != null && r.px_no_line_id != null && String(w.px_line_id) === String(r.px_no_line_id)) ? 'no' : 'yes',
    }));
    return { ...r, active_wagers: aw };
  });
  return {
    tournaments: tRes.data || [],
    config: enriched,
    totalActive: (wRes.data || []).length,
  };
}

async function updateConfig(updates) {
  const sb = db.getClient();
  if (!Array.isArray(updates) || !updates.length) return { updated: 0 };
  let updated = 0; const errors = [];
  for (const u of updates) {
    if (!u.id) { errors.push('missing id'); continue; }
    const patch = {};
    if (u.risk_amount !== undefined) patch.risk_amount = u.risk_amount === null ? null : Number(u.risk_amount);
    if (u.enabled !== undefined) patch.enabled = !!u.enabled;
    if (u.notes !== undefined) patch.notes = u.notes ? String(u.notes) : null;
    if (u.post_side !== undefined) patch.post_side = (u.post_side === 'yes') ? 'yes' : 'no';
    if (u.manual_offered_american !== undefined) {
      // YES price the operator wants to offer. null/0/blank → auto. Round to int.
      const n = u.manual_offered_american === null ? null : Number(u.manual_offered_american);
      patch.manual_offered_american = (n != null && isFinite(n) && n !== 0) ? Math.round(n) : null;
    }
    if (Object.keys(patch).length === 0) continue;
    let { error } = await sb.from(TBL_CONFIG).update(patch).eq('id', u.id);
    // Graceful degrade: if manual_offered_american column doesn't exist yet, still
    // persist the rest so the edit isn't lost.
    if (error && /manual_offered_american|column/i.test(error.message) && 'manual_offered_american' in patch) {
      const { manual_offered_american, ...rest } = patch;
      error = Object.keys(rest).length ? (await sb.from(TBL_CONFIG).update(rest).eq('id', u.id)).error : null;
      if (!error) errors.push(u.id + ': offer override not saved (run scripts/_golf_outrights_manual_offer_column.sql)');
    }
    if (error) errors.push(u.id + ': ' + error.message);
    else updated++;
  }
  return { updated, errors };
}

// ---------------------------------------------------------------------------
// Lifecycle worker
// ---------------------------------------------------------------------------
let _workerHandle = null;
// Posting is MANUAL by design — same operator decision + incident history as the
// Golf Single-Leg bot (2026-06-03): an unconditional postEnabled() on every tick
// re-posts an offer the moment a prior one fills (the line is empty again), which
// is the fill-and-repost runaway loop that racked up unintended plays. The worker
// still syncs DK/PX and cancels stale/drifted offers, but it NEVER auto-posts
// unless GOLF_OUTRIGHTS_WORKER_AUTOPOST=true is explicitly set. Leave it unset.
// Offers are placed only by an explicit "Post All" / "Repost" button click.
function _workerAutopostEnabled() {
  return String(process.env.GOLF_OUTRIGHTS_WORKER_AUTOPOST || '').toLowerCase() === 'true';
}
async function _workerTick() {
  if (!isEnabled()) return;
  try {
    const sb = db.getClient();
    const { data: tourns } = await sb.from(TBL_TOURN).select('dk_slug').eq('enabled', true);
    for (const t of (tourns || [])) {
      try { await syncTournament(t.dk_slug); }
      catch (e) { log.warn('GolfOut', `sync ${t.dk_slug}: ${e.message}`); }
    }
    await refreshDrift();
    if (_workerAutopostEnabled()) {
      await postEnabled(); // re-post drift-cancelled / newly enabled rows (opt-in)
    }
    log.debug('GolfOut', `worker tick ok (${(tourns || []).length} tournaments, autopost=${_workerAutopostEnabled()})`);
  } catch (e) {
    log.error('GolfOut', 'worker tick error: ' + e.message);
  }
}

function startWorker() {
  if (!isEnabled()) { log.info('GolfOut', 'GOLF_OUTRIGHTS_ENABLED not true — worker disabled'); return; }
  if (_workerHandle) return;
  const { refreshMin } = _cfg();
  const intervalMs = Math.max(1, refreshMin) * 60 * 1000;
  log.info('GolfOut', `Starting outright worker (every ${refreshMin}min)`);
  setTimeout(() => { _workerTick().catch(() => {}); }, 20_000);
  _workerHandle = setInterval(() => { _workerTick().catch(() => {}); }, intervalMs);
}
function stopWorker() { if (_workerHandle) { clearInterval(_workerHandle); _workerHandle = null; } }

module.exports = {
  isEnabled,
  listTournaments,
  upsertTournament,
  deleteTournament,
  syncTournament,
  loadState,
  postEnabled,
  cancelAll,
  cancelOne,
  repostOne,
  refreshDrift,
  updateConfig,
  startWorker,
  stopWorker,
};
