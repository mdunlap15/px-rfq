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
const { config } = require('../config');
const pxSingle = require('./px-single');
const lineManager = require('./line-manager');
const oddsFeed = require('./odds-feed');
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
  // Dedupe by line_id before upserting. PX can return the same matchup
  // market/selection more than once (e.g. a side's line_id appearing in two
  // market entries), which would put duplicate conflict keys in a single
  // upsert and make Postgres throw "ON CONFLICT DO UPDATE command cannot
  // affect row a second time". Last write wins (descriptive fields are
  // identical for a given line_id anyway).
  const byLine = new Map();
  for (const r of rows) byLine.set(r.line_id, r);
  const deduped = Array.from(byLine.values());
  const dupCount = rows.length - deduped.length;
  if (dupCount > 0) log.warn('GolfSL', `syncConfig: collapsed ${dupCount} duplicate line_id row(s) before upsert (${rows.length} → ${deduped.length})`);
  // Upsert on line_id — only descriptive fields written; risk_amount + enabled
  // are user-controlled and we don't overwrite them after first insert.
  const { error } = await sb.from(TBL_CONFIG).upsert(deduped, {
    onConflict: 'line_id',
    ignoreDuplicates: false,
  });
  if (error) throw new Error('syncConfig upsert: ' + error.message);
  return { upserted: deduped.length, duplicatesCollapsed: dupCount };
}

// ---------------------------------------------------------------------------
// Pricing — get fair_prob for a line, then compute offered via the same
// path the RFQ pricer uses for single-leg golf matchups.
// ---------------------------------------------------------------------------
// Look up the de-vigged consensus fair for ONE player in a golf matchup,
// directly from the shared odds cache (DataGolf) by PLAYER NAME — no
// dependency on the parlay-SP line index. This is what the single-leg book
// needs: its PX line_ids live on a different account and are NOT in the
// parlay-SP lineIndex, so the line_id-based lookup always missed ("line not
// in parlay-SP index"). The config row carries the player names, so we key
// off those instead.
function _normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function _lastWord(s) { const p = String(s || '').trim().split(/\s+/); return p.length ? _normName(p[p.length - 1]) : ''; }

function _golfFairByNames(sideName, opponentName, roundNum) {
  if (!sideName || !opponentName) return { fair: null, reason: 'missing player names' };
  try {
    const ev = oddsFeed.getGolfMatchupEvent(sideName, opponentName, roundNum || null);
    if (!ev || !ev.markets || !ev.markets.h2h) {
      return { fair: null, reason: 'odds cache: no entry for ' + sideName + ' vs ' + opponentName + (roundNum ? ' R' + roundNum : '') };
    }
    const h2h = ev.markets.h2h;
    // Cache stores both orientations; match this side's player to the returned
    // event's home/away (normalized, with a last-name fallback for PX-vs-
    // DataGolf name differences like "Alex" vs "Alexander").
    const sN = _normName(sideName);
    let side = null;
    if (sN && sN === _normName(ev.homeTeam)) side = h2h.home;
    else if (sN && sN === _normName(ev.awayTeam)) side = h2h.away;
    else {
      const sL = _lastWord(sideName);
      if (sL && sL === _lastWord(ev.homeTeam)) side = h2h.home;
      else if (sL && sL === _lastWord(ev.awayTeam)) side = h2h.away;
    }
    const fp = side ? Number(side.fairProb) : NaN;
    if (isFinite(fp) && fp > 0 && fp < 1) {
      return { fair: fp, sport: 'golf_matchups', marketType: 'moneyline' };
    }
    return { fair: null, reason: 'cache entry found but could not match "' + sideName + '" to home="' + ev.homeTeam + '"/away="' + ev.awayTeam + '"' };
  } catch (e) {
    return { fair: null, reason: 'cache lookup error: ' + e.message };
  }
}

// ctx (optional): { sideName, opponentName, roundNum } from the single-leg
// config row. Used to price golf matchups by name when the line isn't in the
// parlay-SP index (the normal case for the single-leg account).
function _fairForLine(lineId, ctx) {
  const info = lineManager.lookupLine(lineId);

  // If the line IS in the parlay-SP index, honor its override / stored fair.
  if (info) {
    // Manual-upload override (BetOnline/Bookmaker paste). bookPriceOverride is
    // a per-side price that bypasses vig entirely.
    if (info.bookPriceOverride != null) {
      const fpOverride = Number(info.fairProb);
      return {
        fair: isFinite(fpOverride) && fpOverride > 0 ? fpOverride : 0.5,
        override: Number(info.bookPriceOverride),
        sport: info.sport, marketType: info.marketType,
      };
    }
    // Stored fairProb (player props only — moneyline-shaped markets don't
    // store it at registration).
    const directFp = Number(info.fairProb);
    if (isFinite(directFp) && directFp > 0 && directFp < 1) {
      return { fair: directFp, sport: info.sport, marketType: info.marketType };
    }
    // Index-based golf cache lookup (line happened to be registered with
    // home/away names).
    if (info.sport === 'golf_matchups' && info.homeTeam && info.awayTeam) {
      const byIdx = _golfFairByNames(info.teamName || info.homeTeam, info.teamName === info.awayTeam ? info.homeTeam : info.awayTeam, info.roundNum);
      if (byIdx.fair) return byIdx;
    }
  }

  // Primary path for the single-leg book: price by player name from the config
  // row, independent of the parlay-SP line index.
  if (ctx && ctx.sideName && ctx.opponentName) {
    return _golfFairByNames(ctx.sideName, ctx.opponentName, ctx.roundNum);
  }

  if (!info) return { fair: null, reason: 'line not in parlay-SP index (and no matchup names available)' };
  return { fair: null, reason: 'no fair_prob on line' };
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

// Move an American line `ticks` rungs TOWARD THE BETTOR (sweeten). On the
// American scale, higher payout == numerically larger odds across the whole
// range (-110 < -109 < … < -101 < +101 < +102 …), so "sweeter for the bettor"
// is always the next rung up the sorted ladder. With a PX odds ladder we snap
// to the nearest rung then step up `ticks`; without one (cold cache) we nudge
// by `ticks` integer points — which still gives -110 → -109 for the near-even
// case — skipping the invalid |odds|<100 gap. Returns the sweetened American.
function _sweetenAmerican(american, ladder, ticks) {
  const a = Number(american);
  const n = Number.isInteger(ticks) ? ticks : 1;
  if (!isFinite(a) || a === 0 || n <= 0) return american;
  if (Array.isArray(ladder) && ladder.length) {
    const sorted = ladder.slice().sort((x, y) => x - y);
    let idx = 0, best = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const d = Math.abs(sorted[i] - a);
      if (d < best) { best = d; idx = i; }
    }
    return sorted[Math.min(idx + n, sorted.length - 1)];
  }
  // No ladder: integer nudge toward the bettor, jumping the invalid (-100,100).
  let v = a + n;
  if (v > -100 && v < 100) v = 100;
  return v;
}

// Compute the BACK-THIS-PLAYER price for a single-leg golf matchup row.
//   - `ctx`: { sideName, opponentName, roundNum } for the name-based fair lookup.
//   - `overrideAmerican`: optional manual line (American odds the counterparty
//     pays to back THIS player). When set, it replaces the auto markup price.
// Returns backProb = counterparty's implied price to back this player. The
// price we actually POST on this row's line is the complement of the OPPONENT's
// backProb (computed by the caller via opponent pairing) — see _postedOddsForRow.
function _computeOffered(lineId, ctx, overrideAmerican) {
  const f = _fairForLine(lineId, ctx);
  if (!f.fair) return { ok: false, reason: f.reason };
  // If a bookPriceOverride is set (manual upload path), just use it.
  if (f.override != null && f.override > 0 && f.override < 1) {
    return { ok: true, fair: f.fair, offeredProb: f.override, americanOdds: _americanFromImplied(f.override), backProb: f.override, counterpartyProb: f.override, counterpartyAmerican: _americanFromImplied(f.override), autoAmerican: _americanFromImplied(f.override), isOverride: true, source: 'override' };
  }
  // Single-leg golf-matchup line. The AUTO line uses the SAME pricer the RFQ
  // Lines tab "MY ODDS" column uses (pricer.computeSingleLegQuote) so the two
  // tabs always show identical numbers for the same matchup (operator request
  // 2026-06-04 — was a flat sweetener that diverged: Lines -138 vs SL -144).
  // The operator can OVERRIDE an individual line via the editable "Our Offered"
  // field (manual_offered_american) to widen/adjust it.
  //
  // SIDE CONVENTION: on px-single's place_multiple_wagers, the `odds` we submit
  // on a line_id become OUR OWN position. So "counterparty backs THIS player at
  // backProb" is realized by the wager we post on the OPPONENT's line (we hold
  // the opponent at 1−backProb). The DISPLAY "Our Offered" is backProb (this
  // player's price — favorite negative, dog positive).
  if (f.sport === 'golf_matchups') {
    // Mirror the RFQ Lines-tab MY ODDS cascade EXACTLY (index.js ~10835) so the
    // two tabs show identical lines for the same matchup:
    //   1. getGolfMatchupFairProb → if it returns bookPriceOverride (raw
    //      BetOnline/Bovada posted price from DataGolf, or a manual upload),
    //      quote AT that book price.
    //   2. else computeSingleLegQuote(fairProb) — de-vig + our vig curve.
    // (consensusImplied is null for golf matchups — Pin/FD/DK don't cover the
    // DataGolf golf feed — so we omit it, matching the Lines tab for golf.)
    const synthInfo = {
      sport: 'golf_matchups', marketType: 'moneyline',
      teamName: ctx && ctx.sideName, homeTeam: ctx && ctx.sideName,
      awayTeam: ctx && ctx.opponentName,
      roundNum: (ctx && ctx.roundNum != null) ? ctx.roundNum : null,
      pxEventName: '', marketName: '',
    };
    let fairProb = null, bookPriceOverride = null;
    try {
      const golfRes = pricer.getGolfMatchupFairProb(synthInfo);
      if (golfRes != null && typeof golfRes === 'object') { fairProb = golfRes.fairProb; bookPriceOverride = golfRes.bookPriceOverride; }
      else if (golfRes != null) { fairProb = golfRes; }
    } catch (_) { /* fall through to consensus fair */ }
    // getGolfMatchupFairProb is STRICT (null when no BetOnline/Bovada) — the
    // Lines tab would show blank there, but the SL book still wants to make a
    // market, so fall back to the de-vigged consensus fair we already resolved.
    if (fairProb == null) fairProb = f.fair;

    let autoBackProb;
    let vigUsed = null;
    if (bookPriceOverride != null && bookPriceOverride > 0 && bookPriceOverride < 1) {
      autoBackProb = bookPriceOverride;                       // quote AT book — matches Lines tab
    } else {
      let q;
      try { q = pricer.computeSingleLegQuote(fairProb, 'golf_matchups', 'moneyline'); }
      catch (e) { return { ok: false, reason: 'computeSingleLegQuote: ' + e.message }; }
      if (!q || q.impliedProb == null || !(q.impliedProb > 0 && q.impliedProb < 1)) {
        return { ok: false, reason: 'computeSingleLegQuote returned invalid implied' };
      }
      autoBackProb = q.impliedProb;
      vigUsed = q.vig;
    }
    let autoAmerican = (autoBackProb > 0 && autoBackProb < 1) ? _americanFromImplied(autoBackProb) : null;
    // --- 1-tick sweetener (operator request 2026-06-03) ---------------------
    // Post N PX-ladder rung(s) BETTER than the book/auto price on each side so
    // the single-leg book is more attractive than the source book; we hold the
    // complement. Applies to the AUTO line ONLY — a manual override is the exact
    // price the operator typed, left untouched. Both the displayed "Our Offered"
    // and the posted complement flow from autoBackProb, so sweetening here keeps
    // the display and the actual posting in lockstep. -110/-110 → -109/-109
    // (we hold +109 on both sides). Disable via GOLF_SL_SWEETEN_TICKS=0.
    const sweetenTicks = (config.pricing && Number.isInteger(config.pricing.golfSlSweetenTicks))
      ? config.pricing.golfSlSweetenTicks : 1;
    if (autoAmerican != null && sweetenTicks > 0) {
      let ladder = null;
      try { ladder = pxSingle.getCachedLadder(); } catch (_) { ladder = null; }
      const sweetened = _sweetenAmerican(autoAmerican, ladder, sweetenTicks);
      const sweetProb = _impliedFromAmerican(sweetened);
      if (sweetProb != null && sweetProb > 0 && sweetProb < 1) {
        autoAmerican = sweetened;
        autoBackProb = sweetProb;   // display + posted complement both inherit this
      }
    }
    const ov = Number(overrideAmerican);
    const hasOverride = isFinite(ov) && ov !== 0;
    const backProb = hasOverride ? _impliedFromAmerican(ov) : autoBackProb;
    if (!(backProb > 0 && backProb < 1)) {
      return { ok: false, reason: hasOverride ? ('invalid override odds: ' + overrideAmerican) : 'auto back price out of range' };
    }
    return {
      ok: true,
      fair: f.fair,
      backProb,                                       // counterparty backs THIS player (effective)
      counterpartyProb: backProb,
      counterpartyAmerican: _americanFromImplied(backProb),  // effective line (override or auto)
      autoAmerican,                                   // un-overridden line (UI reference + revert detect)
      isOverride: hasOverride,
      vig: vigUsed,
      source: hasOverride ? 'manual-override' : (bookPriceOverride != null ? 'lines-tab-book' : 'lines-tab-quote'),
    };
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

function _ctxOf(row) {
  return { sideName: row.side_name, opponentName: row.side_opponent, roundNum: row.round_num };
}

// Build a (event_id|market_id) → [rows] map so we can find each row's opponent
// (the OTHER side of the same matchup market).
function _buildMatchupMap(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const k = (r.event_id != null ? r.event_id : '?') + '|' + (r.market_id != null ? r.market_id : '?');
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
function _opponentRow(row, byMatchup) {
  const k = (row.event_id != null ? row.event_id : '?') + '|' + (row.market_id != null ? row.market_id : '?');
  const peers = byMatchup.get(k) || [];
  return peers.find(p => p.line_id !== row.line_id) || null;
}

// The American odds we actually POST on `row`'s line. We hold `row`'s player;
// the counterparty who matches backs the OPPONENT at the opponent's
// back-price, so our held implied = 1 − backProb(opponent). With no overrides
// this equals 1 − (1 − fair_row)(1+s) — identical to the pre-override behavior.
// Returns { ok, american, snapped, fair, postedImplied } or { ok:false, reason }.
function _postedOddsForRow(row, byMatchup, ladder) {
  const opp = _opponentRow(row, byMatchup);
  if (!opp) return { ok: false, reason: 'no opponent row found in matchup' };
  const qOpp = _computeOffered(opp.line_id, _ctxOf(opp), opp.manual_offered_american);
  if (!qOpp.ok || qOpp.backProb == null) return { ok: false, reason: 'opponent unpriced (' + (qOpp.reason || 'no backProb') + ')' };
  const postedImplied = 1 - qOpp.backProb;
  if (!(postedImplied > 0 && postedImplied < 1)) return { ok: false, reason: 'posted implied out of range: ' + postedImplied.toFixed(4) };
  const american = _americanFromImplied(postedImplied);
  if (american == null) return { ok: false, reason: 'posted american conversion failed' };
  const qR = _computeOffered(row.line_id, _ctxOf(row), row.manual_offered_american);
  return { ok: true, american, snapped: ladder ? pxSingle.snapToLadder(american, ladder) : american, fair: qR.ok ? qR.fair : null, postedImplied };
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
  // Load ALL rows to resolve each enabled row's opponent (posted odds are the
  // complement of the opponent's back-price, which honors the opponent's
  // manual override).
  const { data: allRows, error: allErr } = await sb.from(TBL_CONFIG).select('*');
  if (allErr) throw new Error('postEnabled all-rows select: ' + allErr.message);
  const byMatchup = _buildMatchupMap(allRows || cfgRows);

  const orders = [];
  const skipped = [];
  for (const row of cfgRows) {
    if (activeByLine.has(row.line_id)) { skipped.push({ line_id: row.line_id, reason: 'already-posted' }); continue; }
    const p = _postedOddsForRow(row, byMatchup, ladder);
    if (!p.ok) { skipped.push({ line_id: row.line_id, reason: p.reason }); continue; }
    orders.push({
      line_id: row.line_id,
      odds: p.snapped,
      stake: Number(row.risk_amount),
      external_id: 'gsl_' + row.line_id.slice(0, 8) + '_' + Date.now(),
      _meta: { fair: p.fair, side_name: row.side_name, matchup: row.matchup_name },
    });
  }
  if (!orders.length) return { posted: 0, skipped: skipped.length, errors: [], skippedDetail: skipped };

  // Batch up to 20 per PX call
  let posted = 0;
  let suspect = 0; // PX echoed a succeed_wager but with NO wager_id — likely
                   // not actually resting on the book (the "said posted but
                   // not on PX" symptom). Surface loudly instead of pretending.
  const errors = [];
  const placeDetail = []; // per-wager echo for the UI (wager_id/status/odds)
  const wagerRows = [];
  for (let i = 0; i < orders.length; i += 20) {
    const batch = orders.slice(i, i + 20);
    let resp;
    try { resp = await pxSingle.placeMultipleWagers(batch.map(o => ({ line_id: o.line_id, odds: o.odds, stake: o.stake, external_id: o.external_id }))); }
    catch (e) { errors.push('batch error: ' + e.message); continue; }
    log.info('GolfSL', `post batch: ${(resp.succeed_wagers || []).length} succeed, ${(resp.failed_wagers || []).length} failed (sent ${batch.length})`);
    let si = 0;
    for (const w of resp.succeed_wagers) {
      // Prefer external_id match; fall back to positional if PX didn't echo it
      // (so we don't silently drop a real placement we can't re-key).
      let matching = w.external_id ? batch.find(o => o.external_id === w.external_id) : null;
      if (!matching && !w.external_id && si < batch.length) matching = batch[si];
      si++;
      if (!matching) { errors.push('succeed_wager could not be matched to a sent order: ' + JSON.stringify(w).slice(0, 200)); continue; }
      const wagerId = w.wager_id || w.id || w.wagerId || null;
      const status = w.matching_status || w.status || (wagerId ? 'posted' : 'unknown');
      placeDetail.push({ line_id: matching.line_id, wager_id: wagerId, status, odds: matching.odds, stake: matching.stake });
      if (!wagerId) {
        // PX claims success but gave us no id to track/cancel it — this is the
        // exact failure mode behind "posted but not visible on the book".
        suspect++;
        log.warn('GolfSL', `succeed_wager has NO wager_id (status=${status}) — not truly placed? raw: ${JSON.stringify(w).slice(0, 300)}`);
        errors.push((matching.external_id || matching.line_id) + ': succeeded with no wager_id (status=' + status + ') — verify on PX');
        continue; // do NOT record a phantom wager with a null id
      }
      posted++;
      wagerRows.push({
        wager_id: wagerId,
        line_id: matching.line_id,
        event_id: cfgRows.find(c => c.line_id === matching.line_id)?.event_id,
        external_id: matching.external_id,
        posted_odds: matching.odds,
        posted_stake: matching.stake,
        posted_fair_prob: matching._meta.fair,
        status,
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
  // Persist new wagers (only those with real wager_ids)
  if (wagerRows.length) {
    const { error: insErr } = await sb.from(TBL_WAGERS).upsert(wagerRows, { onConflict: 'wager_id' });
    if (insErr) errors.push('wagers upsert: ' + insErr.message);
  }
  if (suspect > 0) log.warn('GolfSL', `${suspect} wager(s) returned success with no wager_id — NOT recorded (likely not on book). Check PX response log above.`);
  return { posted, suspect, skipped: skipped.length, errors, placeDetail, skippedDetail: skipped };
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
  // Load ALL config rows (names + overrides) so we recompute each wager's
  // expected posted odds exactly as postEnabled does (opponent-derived, honoring
  // overrides). Keyed by line_id for the wager → config-row lookup.
  const { data: allRows } = await sb.from(TBL_CONFIG).select('*');
  const byLineId = new Map();
  for (const r of (allRows || [])) byLineId.set(r.line_id, r);
  const byMatchup = _buildMatchupMap(allRows || []);
  const { data, error } = await sb.from(TBL_WAGERS)
    .select('wager_id, line_id, posted_fair_prob, posted_odds')
    .in('status', ['posted', 'partially_matched']);
  if (error) throw new Error('refreshDrift select: ' + error.message);
  let drifted = 0;
  const errors = [];
  for (const w of (data || [])) {
    const row = byLineId.get(w.line_id);
    if (!row) continue; // line no longer in config — cancelStale handles it
    const p = _postedOddsForRow(row, byMatchup, null);
    if (!p.ok) continue;
    const driftPpNow = Math.abs((p.postedImplied - _impliedFromAmerican(w.posted_odds)) * 100);
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
  // Warm the odds-ladder cache (once, if cold) so the 1-tick sweetener in
  // _computeOffered steps on real PX rungs for the DISPLAY too — keeping the
  // shown "Our Offered" in lockstep with what postEnabled() will actually post.
  // Cached 1h; a failure (PX unreachable / feature off) just leaves the
  // sweetener on its ±1 fallback, which is correct for near-even lines anyway.
  try { if (!pxSingle.getCachedLadder()) await pxSingle.fetchOddsLadder(); } catch (_) { /* cold-cache fallback */ }
  // Enrich each config row with current fair + the editable "Our Offered" line
  // (counterparty backs THIS player; override or auto).
  const enriched = (cfg || []).map(r => {
    const q = _computeOffered(r.line_id, { sideName: r.side_name, opponentName: r.side_opponent, roundNum: r.round_num }, r.manual_offered_american);
    const cpProb = q.ok ? (q.counterpartyProb != null ? q.counterpartyProb : q.offeredProb) : null;
    const cpAmer = q.ok ? (q.counterpartyAmerican != null ? q.counterpartyAmerican : q.americanOdds) : null;
    return {
      ...r,
      current_fair_prob: q.ok ? q.fair : null,
      current_offered_prob: cpProb,            // effective line implied (display)
      current_american: cpAmer,                // effective line (override or auto)
      auto_american: q.ok ? (q.autoAmerican != null ? q.autoAmerican : cpAmer) : null, // un-overridden line
      is_override: q.ok ? !!q.isOverride : false,
      offered_source: q.ok ? q.source : null,
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
  // Expose the global default (fraction) so the UI can show it as the
  // per-row placeholder ("blank = default").
  const defaultSweetenerPct = Number(config.pricing.golfSlMatchupSweetenerPct) || 0;
  return { config: enriched, totalActive: (wagers || []).length, defaultSweetenerPct };
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
    if (u.manual_offered_american !== undefined) {
      // Manual line override = American odds a counterparty pays to back this
      // player. null/0/blank → no override (auto markup). Round to integer.
      const n = u.manual_offered_american === null ? null : Number(u.manual_offered_american);
      patch.manual_offered_american = (n != null && isFinite(n) && n !== 0) ? Math.round(n) : null;
    }
    if (Object.keys(patch).length === 0) continue;
    let { error } = await sb.from(TBL_CONFIG).update(patch).eq('line_id', u.line_id);
    // Graceful degrade: if manual_offered_american column doesn't exist yet,
    // still persist risk/enabled/notes so the rest of the edit lands.
    if (error && /manual_offered_american|column/i.test(error.message) && 'manual_offered_american' in patch) {
      const { manual_offered_american, ...rest } = patch;
      error = Object.keys(rest).length ? (await sb.from(TBL_CONFIG).update(rest).eq('line_id', u.line_id)).error : null;
      if (!error) errors.push(u.line_id + ': line override not saved (run scripts/_golf_sl_override_column.sql migration)');
    }
    if (error) errors.push(u.line_id + ': ' + error.message);
    else updated++;
  }
  return { updated, errors };
}

// ---------------------------------------------------------------------------
// Lifecycle worker
// ---------------------------------------------------------------------------
let _workerHandle = null;
// Posting is MANUAL by design (operator decision 2026-06-03): the operator
// sets the Risk $ they want per row and clicks "Post All" to post exactly
// those amounts, once. The worker NEVER auto-posts by default.
//
// Why: 2026-06-03 incident — the worker called postEnabled() every 5-min tick;
// each time an offer got MATCHED the line no longer had a resting wager, so
// the next tick saw it as "empty" and posted AGAIN — a fill-and-repost loop
// that racked up 12 matched plays on a single matchup the operator never
// intended. With autopost OFF the worker still syncs matchups and cancels
// stale/drifted offers, but only an explicit manual "Post All" places offers.
//
// GOLF_SL_WORKER_AUTOPOST=true would restore continuous re-posting (true MM
// behavior). The operator does NOT want this — leave it unset. (There is
// deliberately no exposure cap; amounts are exactly what the operator posts.)
function _workerAutopostEnabled() {
  return String(process.env.GOLF_SL_WORKER_AUTOPOST || '').toLowerCase() === 'true';
}
async function _workerTick() {
  if (!isEnabled()) return;
  try {
    const matchups = await discoverGolfMatchups();
    await syncConfig(matchups);
    const currentLineIds = new Set();
    for (const m of matchups) for (const s of m.sides) currentLineIds.add(s.line_id);
    await cancelStale(currentLineIds);
    await refreshDrift();
    if (_workerAutopostEnabled()) {
      await postEnabled(); // re-post anything cancelled-for-drift or newly enabled
    }
    log.debug('GolfSL', `worker tick ok (${matchups.length} matchups, autopost=${_workerAutopostEnabled()})`);
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
