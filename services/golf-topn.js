// ============================================================================
// golf-topn.js — Top 5/10/20 (INCLUDING TIES) fair values for PARLAY quoting
// ============================================================================
// PX settles finishing-position outrights TIES INCLUDED ("Top 5 Finish (Ties
// Included)"). DataGolf CANNOT price these: it converts book odds to the
// DEAD-HEAT basis. Proven on The Open 2026-07-14 — same book, same market, same
// moment:
//     Scheffler "Top 5 (Including Ties)" on DK's site : +144  (41.0%)
//     DataGolf's `draftkings` field, market=top_5     : +178  (36.0%)
//     field sums  DK site 7.96 vs DataGolf 6.27  (nominal 5)
// All ~150 players ran 23-27% low. So top-N MUST come from DK's own board, which
// posts the ties-included market verbatim. That is what this module does.
//
// ---------------------------------------------------------------------------
// THE DE-VIG PROBLEM, AND HOW WE SOLVE IT
// ---------------------------------------------------------------------------
// DK's ties board is RAW (carries overround). To get a fair we must normalize
// the field to its true sum T = E[# players finishing top-N including ties].
// T is NOT N: ties add players (T > N), and the uplift is not directly
// observable. Guessing it is unsafe — too low underprices (we get picked off).
//
// We DERIVE it instead, using DataGolf's dead-heat feed as a calibration
// constant (never as a price):
//     a dead-heat field sums to EXACTLY N by construction
//       => book_overround = (book's dead-heat RAW sum) / N
//     overround is a property of the BOOK's pricing, not the tie convention,
//     so it carries to that same book's ties board:
//       => T = (ties RAW sum) / book_overround
// On The Open this yields T(top_5) = 7.96 x 5 / 6.27 = 6.35 and
// T(top_10) = 14.54 x 10 / 11.80 = 12.32 — i.e. ties add ~1.35 players at top-5
// and ~2.3 at top-10. Ties being MORE common deeper is exactly right, and is a
// genuine independent check on the derivation.
//
// Both sums are measured over the SAME player intersection, or the ratio is
// meaningless.
//
// De-vig itself is POWER (odds-ratio), not multiplicative: multiplicative
// normalization has a heavy favorite-longshot bias (measured -4.98pp on
// favorites / +8.56pp on longshots on this very feed).
//
// ---------------------------------------------------------------------------
// WHY THIS IS A BACKGROUND CACHE
// ---------------------------------------------------------------------------
// The DK scrape is Puppeteer and took ~142s for one tournament. It can NEVER sit
// on the RFQ hot path. warmTopN() refreshes on a timer; the pricer only ever
// does a sync cache read (getTopNFairProbSync) and FAILS CLOSED — cold, stale,
// unmatched player, or a failed T derivation all return null and the leg
// declines. A missed fill is free; a mispriced fill is not.
//
// Coverage note: DK served Winner + Top 5 + Top 10 for The Open but NO Top 20
// and NO Make Cut. Top 20 simply won't price until DK posts it (we never
// register it). make_cut stays on DataGolf (binary — no dead-heat ambiguity).
// ============================================================================

const log = require('./logger');
const dkScraper = require('./dk-scraper');
const dataGolf = require('./datagolf');

const TOPN_MARKETS = { outright_top_5: { dk: 'top_5', dg: 'top_5', n: 5 }, outright_top_10: { dk: 'top_10', dg: 'top_10', n: 10 }, outright_top_20: { dk: 'top_20', dg: 'top_20', n: 20 } };
// WARM cadence: how often we kick a fresh DK scrape.
const TTL_MS = (Number(process.env.GOLF_TOPN_TTL_MIN) || 30) * 60 * 1000;
// READ tolerance: how old a board may be and still PRICE. Deliberately much
// larger than TTL_MS and tracked separately — conflating the two made top-N go
// DEAD for a ~2.5min window every cycle: the board expired at TTL, but the
// re-scrape takes ~150s (Puppeteer), so every read in between returned null and
// declined. Operator hit exactly this (board 33min old vs a 30min TTL → Top 5
// parlay "No Offers Available"). A worse failure — a scrape that keeps failing —
// would have pinned top-N off indefinitely.
// Safe because these are 4-day tournament outrights: the board barely moves
// pre-event, so a 3h-old ties board is a far better price than no price. The
// hard freshness floor stays — beyond this we still fail CLOSED.
const MAX_AGE_MS = (Number(process.env.GOLF_TOPN_MAX_AGE_MIN) || 180) * 60 * 1000;
const MIN_PLAYERS = 30;         // a partial field makes normalization invalid
// Sanity band on the derived tie uplift T/N. Ties can only ADD players (T >= N),
// and an uplift beyond ~1.6 means the derivation broke (bad scrape, mismatched
// player sets, DK repricing mid-scrape) rather than a real tie structure.
const UPLIFT_MIN = 1.0, UPLIFT_MAX = 1.6;

let _cache = { at: 0, bySlug: {} };  // slug -> { tournament, eventName, markets: { outright_top_5: {T, uplift, k, players: Map} } }
let _inflight = null;

// PX tournament name -> DK league slug. PX says "2026 The Open"; DK's slug is
// "the-open-championship", so a naive slugify does NOT work. Operator-extendable
// via GOLF_DK_SLUG_MAP (JSON, e.g. {"the open":"the-open-championship"}).
const DEFAULT_SLUG_MAP = {
  'the open': 'the-open-championship',
  'the open championship': 'the-open-championship',
  'british open': 'the-open-championship',
  'the masters': 'the-masters',
  'masters tournament': 'the-masters',
  'pga championship': 'pga-championship',
  'us open': 'us-open',
  'the players championship': 'the-players-championship',
  'the memorial tournament': 'the-memorial-tournament',
};
function _slugMap() {
  let extra = {};
  try { extra = JSON.parse(process.env.GOLF_DK_SLUG_MAP || '{}'); } catch (_) { /* ignore bad JSON */ }
  return { ...DEFAULT_SLUG_MAP, ...extra };
}
const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const _normName = s => dataGolf._normalizeOutrightName(s);

/** PX tournament name ("2026 The Open") -> DK slug, or null. */
function resolveDkSlug(tournamentName) {
  const t = _norm(tournamentName).replace(/^\d{4}\s+/, '').trim(); // drop leading year
  if (!t) return null;
  const map = _slugMap();
  if (map[t]) return map[t];
  for (const [k, v] of Object.entries(map)) if (t.includes(k) || k.includes(t)) return v;
  return null;
}

const _aImpl = a => { if (a == null || a === '') return null; const n = Number(a); if (!isFinite(n) || n === 0) return null; return n >= 0 ? 100 / (n + 100) : (-n) / (-n + 100); };

/** Power-normalize a field so Σ pᵢ^k = target; returns k (null if unbracketable). */
function _solvePower(probs, target) {
  const ps = probs.filter(p => p > 0 && p < 1);
  if (!ps.length || !(target > 0)) return null;
  const sum = k => ps.reduce((s, p) => s + Math.pow(p, k), 0);
  let lo = 0.05, hi = 12;
  if ((sum(lo) - target) * (sum(hi) - target) > 0) return null;
  for (let i = 0; i < 80; i++) { const k = (lo + hi) / 2; if (sum(k) > target) lo = k; else hi = k; }
  return (lo + hi) / 2;
}

/**
 * Build one market's ties-included fair board.
 * dkSel: DK's scraped selections [{playerName, americanOdds}] (ties-included, RAW)
 * anchor: dataGolf.fetchDeadHeatAnchor for the SAME book+market (dead-heat, RAW)
 * Returns { T, uplift, k, players: Map(normName -> fairProb) } or null.
 */
function _buildTopNMarket(dkSel, anchor, n, label) {
  const dkByName = new Map();
  for (const s of dkSel) {
    const p = _aImpl(s.americanOdds);
    if (p != null && p > 0 && p < 1) dkByName.set(_normName(s.playerName), p);
  }
  // Intersection ONLY — summing different player sets makes the ratio garbage.
  let tiesRaw = 0, dhRaw = 0, matched = 0;
  for (const [name, p] of dkByName) {
    const dh = anchor.byName.get(name);
    if (dh == null) continue;
    tiesRaw += p; dhRaw += dh; matched++;
  }
  if (matched < MIN_PLAYERS) { log.warn('GolfTopN', `${label}: only ${matched} players intersect DK↔DataGolf — refusing`); return null; }
  const overround = dhRaw / n;              // dead-heat FAIR sum is exactly n
  if (!(overround > 1.0001)) { log.warn('GolfTopN', `${label}: implausible overround ${overround.toFixed(3)} — refusing`); return null; }
  const T = tiesRaw / overround;            // ties-included FAIR sum
  const uplift = T / n;
  if (!(uplift >= UPLIFT_MIN && uplift <= UPLIFT_MAX)) {
    log.warn('GolfTopN', `${label}: derived tie uplift ${uplift.toFixed(3)} outside [${UPLIFT_MIN}, ${UPLIFT_MAX}] — refusing (derivation broke)`);
    return null;
  }
  // Normalize the FULL DK field (not just the intersection) to T.
  const all = Array.from(dkByName.values());
  const k = _solvePower(all, T);
  if (k == null) { log.warn('GolfTopN', `${label}: power normalization failed`); return null; }
  const players = new Map();
  for (const [name, p] of dkByName) players.set(name, Math.pow(p, k));
  log.info('GolfTopN', `${label}: tiesRaw=${tiesRaw.toFixed(2)} dhRaw=${dhRaw.toFixed(2)} (n=${matched}) → overround x${overround.toFixed(3)}, T=${T.toFixed(2)} (uplift x${uplift.toFixed(3)}), k=${k.toFixed(3)}, ${players.size} players`);
  return { T, uplift, k, overround, players };
}

/**
 * Refresh the DK ties-included top-N board for one tournament.
 * SLOW (~142s, Puppeteer) — background only.
 */
async function warmTopNForSlug(slug, tournamentName, { force = false } = {}) {
  const dk = await dkScraper.fetchGolfOutrights(slug, { force });
  const out = { tournament: tournamentName, slug, eventName: null, markets: {} };
  for (const [mt, cfg] of Object.entries(TOPN_MARKETS)) {
    const dkM = (dk.markets || []).find(m => m.marketType === cfg.dk);
    if (!dkM || !dkM.selections || dkM.selections.length < MIN_PLAYERS) continue;
    // Guard the basis: DK must be serving the "(Including Ties)" variant. If DK
    // ever renames or posts a plain (dead-heat) Top N, the scraper's loose
    // /top[\s-]?5\b/ regex would match it and we'd silently price the wrong
    // basis — the exact bug that started this. Require the name to say so.
    const nm = String(dkM.marketName || dkM.name || '');
    // DK is INCONSISTENT about this label — verified against the live page
    // 2026-07-15: "Top 5 (Including Ties)" and "Top 10 (Including Ties)" are
    // spelled out, but "Top 20 (Inc. Ties)" / "Top 30 (Inc. Ties)" abbreviate.
    // Matching only /includ\w*/ silently threw away every Top 20 board as
    // "basis unverified". Still REJECTS a bare "Top 20"/"Top 20 Finish" — those
    // carry no ties qualifier and would be the dead-heat basis, which is the
    // whole thing this guard exists to catch.
    if (!/includ\w*\s+ties|\binc\.?\s+ties/i.test(nm)) {
      log.warn('GolfTopN', `${slug} ${cfg.dk}: DK market "${nm}" does not say "Including Ties" — refusing (basis unverified)`);
      continue;
    }
    // The anchor must be the SAME tournament on the SAME book, else the
    // overround ratio is meaningless. Try each tour and keep only an anchor
    // whose event name matches this tournament — never assume 'pga'.
    let anchor = null;
    for (const tour of ['pga', 'euro', 'alt']) {
      const a = await dataGolf.fetchDeadHeatAnchor(tour, cfg.dg, 'draftkings');
      if (!a || !_norm(a.eventName)) continue;
      const words = _norm(tournamentName).replace(/^\d{4}\s+/, '').split(' ').filter(w => w.length > 2);
      if (words.length && words.every(w => _norm(a.eventName).includes(w))) { anchor = a; break; }
    }
    if (!anchor) { log.warn('GolfTopN', `${slug} ${cfg.dk}: no DataGolf dead-heat anchor matching "${tournamentName}" on any tour — refusing`); continue; }
    const built = _buildTopNMarket(dkM.selections, anchor, cfg.n, `${slug}/${cfg.dk}`);
    if (built) { out.markets[mt] = built; out.eventName = anchor.eventName; }
  }
  return out;
}

/**
 * Warm every tournament PX currently lists a top-N board for.
 * `tournaments`: [{ tournamentName }]. Single-flight; TTL-gated.
 */
async function warmTopN(tournaments, { force = false } = {}) {
  if (!force && Date.now() - _cache.at < TTL_MS && Object.keys(_cache.bySlug).length) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const bySlug = {};
    const seen = new Set();
    let freshMarkets = false;   // true only if a scrape actually returned markets
    for (const t of (tournaments || [])) {
      const slug = resolveDkSlug(t.tournamentName);
      if (!slug) { log.warn('GolfTopN', `No DK slug for "${t.tournamentName}" — top-N will not quote (add to GOLF_DK_SLUG_MAP)`); continue; }
      if (seen.has(slug)) continue;
      seen.add(slug);
      // NEVER let an empty/failed scrape destroy a good board. Previously this
      // assigned the result unconditionally and then stamped _cache.at = now, so
      // one bad DK scrape replaced a working board with { markets: {} } that
      // still looked FRESH — /golf-topn reported priceable:true, ageMs 46min,
      // markets:{} while every top-N leg silently declined no_fair_value
      // (operator caught this live 2026-07-16; it is also why an earlier
      // "top_5 priced 0/156" reading was real and I wrongly dismissed it).
      // A stale-but-real board is strictly better than an empty one: these are
      // 4-day tournament outrights that barely move, and MAX_AGE_MS still
      // enforces the hard freshness floor.
      let built = null;
      try { built = await warmTopNForSlug(slug, t.tournamentName, { force }); }
      catch (e) { log.warn('GolfTopN', `warm ${slug} failed: ${e.message}`); }
      const gotMarkets = built && built.markets && Object.keys(built.markets).length > 0;
      const prev = _cache.bySlug[slug];
      const prevHadMarkets = prev && prev.markets && Object.keys(prev.markets).length > 0;
      if (gotMarkets) {
        bySlug[slug] = built;
        freshMarkets = true;
      } else if (prevHadMarkets) {
        bySlug[slug] = prev; // KEEP the last good board; do NOT regress to empty
        log.warn('GolfTopN', `${slug}: scrape returned NO top-N markets — keeping previous board (${Object.keys(prev.markets).join(',')}). It will AGE OUT normally; top-N declines once past MAX_AGE.`);
      } else {
        log.warn('GolfTopN', `${slug}: scrape returned NO top-N markets and no previous board — top-N will DECLINE until a scrape succeeds`);
      }
    }
    // Advance the freshness stamp ONLY on a genuinely fresh scrape. Retaining a
    // previous board must NOT re-stamp it: otherwise a persistently failing
    // scrape would refresh `at` every cycle and serve a stale board forever,
    // defeating MAX_AGE. Retained boards keep their original age and expire.
    _cache = { at: freshMarkets ? Date.now() : _cache.at, bySlug };
    const summary = Object.entries(bySlug).map(([s, b]) => `${s}:[${Object.keys(b.markets).join(',') || 'none'}]`).join(' ');
    const heldMarkets = Object.values(bySlug).some(b => b && b.markets && Object.keys(b.markets).length > 0);
    log.info('GolfTopN', `Warmed ${Object.keys(bySlug).length} tournament(s): ${summary || 'none'}`
      + (heldMarkets ? (freshMarkets ? '' : '  (retained previous board — scrape returned nothing)')
                     : '  ** NO MARKETS — top-N DECLINING **'));
    return _cache;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * SYNC fair for a top-N leg. Pure cache read — safe on the RFQ hot path.
 * FAILS CLOSED (null ⇒ decline) on: cold/expired cache, no DK slug, market not
 * served by DK, or player not on the board.
 */
function getTopNFairProbSync(playerName, marketType, tournamentName) {
  if (!TOPN_MARKETS[marketType]) return null;
  // MAX_AGE_MS, not TTL_MS — see the constant. TTL only governs when we kick a
  // re-scrape; a board between TTL and MAX_AGE is still perfectly priceable and
  // a re-warm is already in flight. Beyond MAX_AGE we fail closed.
  if (!_cache.at || Date.now() - _cache.at > MAX_AGE_MS) return null;
  const slug = resolveDkSlug(tournamentName);
  if (!slug) return null;
  const board = _cache.bySlug[slug];
  if (!board) return null;
  const mkt = board.markets[marketType];
  if (!mkt) return null;
  const p = mkt.players.get(_normName(playerName));
  if (p == null || !(p > 0 && p < 1)) return null;
  return { fairProb: p, basis: `DK "Including Ties" board, power-de-vigged to derived T=${mkt.T.toFixed(2)} (uplift x${mkt.uplift.toFixed(3)})`, eventName: board.eventName, T: mkt.T, uplift: mkt.uplift };
}

function __debugCache() {
  // priceable must mean "top-N legs can actually price RIGHT NOW", i.e. we hold
  // real markets AND they're within MAX_AGE. Reporting it on age alone made a
  // dead board (markets:{}) advertise priceable:true for 3h while every leg
  // declined — the operator had to spot the empty `markets` by eye.
  // marketCount is surfaced so an outage is obvious at a glance.
  const _marketCount = Object.values(_cache.bySlug || {})
    .reduce((n, b) => n + ((b && b.markets) ? Object.keys(b.markets).length : 0), 0);
  return { at: _cache.at, ageMs: _cache.at ? Date.now() - _cache.at : null, ttlMs: TTL_MS, maxAgeMs: MAX_AGE_MS,
    marketCount: _marketCount,
    priceable: !!(_cache.at && _marketCount > 0 && Date.now() - _cache.at <= MAX_AGE_MS),
    bySlug: Object.fromEntries(Object.entries(_cache.bySlug).map(([s, b]) => [s, {
      tournament: b.tournament, eventName: b.eventName,
      markets: Object.fromEntries(Object.entries(b.markets).map(([m, x]) => [m, { T: x.T, uplift: x.uplift, k: x.k, overround: x.overround, players: x.players.size }])),
    }])) };
}

module.exports = { warmTopN, warmTopNForSlug, getTopNFairProbSync, resolveDkSlug, __debugCache, _buildTopNMarket };
