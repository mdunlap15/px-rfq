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
// Coverage note: DK serves Winner + Top 5 + Top 10 + Top 20 for The Open (Top
// 20 lazy-loads behind a tab — see dk-scraper _clickLazyGolfTabs). make_cut
// stays on DataGolf (binary — no dead-heat ambiguity).
//
// TWO name-matching failure modes were live here on 2026-07-16, both fixed:
//   1. dk-scraper parsed odds with a naked Number(), so DK's U+2212 minus made
//      every ODDS-ON favorite NaN → dropped. Invisible until players go
//      negative mid-tournament; then Top 20 lost its 9 shortest prices (5.9
//      units), the derived uplift fell to 0.911 (< 1.0, impossible), and the
//      board failed closed. Fixed in dk-scraper via _dkParseAmerican.
//   2. DK and DataGolf disagree on given names (DK "Daniel Brown" vs DG "Dan
//      Brown"). Exact-match dropped those from the overround intersection,
//      biasing it. Fixed via _anchorProb (surname + unique first-name prefix).
// Both narrowed the DK↔DataGolf intersection, and BOTH bit Top 20 hardest
// because that field carries the most probability in the shortlist tail.
// ============================================================================

const log = require('./logger');
const dkScraper = require('./dk-scraper');
const dataGolf = require('./datagolf');

const TOPN_MARKETS = { outright_top_5: { dk: 'top_5', dg: 'top_5', n: 5 }, outright_top_10: { dk: 'top_10', dg: 'top_10', n: 10 }, outright_top_20: { dk: 'top_20', dg: 'top_20', n: 20 } };

// ---------------------------------------------------------------------------
// MAKE-THE-CUT from DK's one-sided board.
//
// DataGolf (the normal make_cut source, real 2-way de-vig) STOPS OFFERING
// make-cut boards once the tournament goes live ("Make-cut boards: none
// offered" from R1 onward) — exactly when the operator wants to quote it. DK
// keeps a live make-cut board, but MAKE-SIDE ONLY, so 2-way de-vig is
// impossible.
//
// A one-sided cut board still has a hard field constraint, the same trick as
// top-N: the cut is "top N and ties", so Σ P(make) over the WHOLE field =
// E[# making the cut] = N + E[extra from ties at Nth place]. That target is
// KNOWN (unlike top-N's T, which needs the dead-heat anchor to derive), so we
// power-normalize DK's raw make-side field straight to it. Power, not
// proportional — cut boards are favorite-heavy and proportional de-vig
// underrates favorites (measured -4.15pp favs; see services/datagolf.js).
//
// The cut RULE varies by tournament and getting it wrong shifts every fair by
// ~N_wrong/N_true, so an unknown slug FAILS CLOSED rather than guessing:
// only slugs in DEFAULT_CUT_N_MAP / GOLF_CUT_N_MAP price. (The Open = top 70
// and ties; PGA Champ = 70; US Open = 60; Masters = 50; regular PGA/DP World
// Tour events = 65.)
// GOLF_CUT_TIE_EXTRA is E[extra players tied at the cut line], default 1.5 —
// a ±1.5 error in T moves fairs ~2% relative, small next to the ~10% overround
// this normalization removes and the 12% golf-outright vig floor.
// ---------------------------------------------------------------------------
const DEFAULT_CUT_N_MAP = {
  'the-open-championship': 70,
  'pga-championship': 70,
  'us-open': 60,
  'the-masters': 50,
  'the-players-championship': 65,
  'the-memorial-tournament': 65,
};
function _cutNFor(slug) {
  let extra = {};
  try { extra = JSON.parse(process.env.GOLF_CUT_N_MAP || '{}'); } catch (_) { /* ignore bad JSON */ }
  const map = { ...DEFAULT_CUT_N_MAP, ...extra };
  const n = Number(map[slug]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const CUT_TIE_EXTRA = Number(process.env.GOLF_CUT_TIE_EXTRA) || 1.5;
// Sanity band on the one-sided board's raw overround (rawSum / T). Below 1.0
// means the board sums UNDER the cut count — impossible for a vig-carrying
// make-side board (it's how the U+2212 favorite-drop bug announced itself on
// top_20). Above 1.35 means the field is missing players or DK repriced
// mid-scrape.
const CUT_OVERROUND_MIN = 1.0001, CUT_OVERROUND_MAX = 1.35;
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

// Operator paste boards get a longer freshness ceiling than scraped boards —
// the operator pastes deliberately and stops via the kill-switch, so we don't
// force a re-paste on the tight scrape MAX_AGE. Default 12h; beyond it, fail
// closed so a forgotten paste can't quote day-old odds.
const MANUAL_MAX_AGE_MS = (Number(process.env.GOLF_OUTRIGHT_PASTE_MAX_AGE_MIN) || 720) * 60 * 1000;

let _cache = { at: 0, bySlug: {} };  // slug -> { tournament, eventName, markets: { outright_top_5: {T, uplift, k, players: Map} }, manual? }

// ---------------------------------------------------------------------------
// PASTE-BOARD PERSISTENCE
//
// The operator's DK "(Including Ties)" paste is the AUTHORITATIVE outright
// board and it lived only in memory, so every Railway deploy silently wiped it
// while ~430 outright lines stayed registered with PX. That leaves us
// advertising markets we cannot price: getTopNFairProbSync returns null and
// every outright leg declines. On 2026-08-05 it had to be hand-re-pasted three
// times in one day.
//
// Only MANUAL (pasted) boards are persisted. Scraped boards rebuild themselves
// on the warm cycle; the paste cannot, which is the whole problem.
//
// `players` is a Map, so it is serialized to a plain object and rebuilt on load.
//
// CRITICAL: the restored board keeps its ORIGINAL `at` timestamp. Restoring it
// as "now" would let a deploy silently rejuvenate a stale board and quote a
// finished tournament — the exact failure GOLF_OUTRIGHT_MAX_AGE_MIN exists to
// prevent. A board that was already too old stays too old and fails closed.
const _KV_KEY = 'golf_topn_paste_board';

function _serializeCache() {
  const bySlug = {};
  for (const [slug, b] of Object.entries(_cache.bySlug || {})) {
    if (!b || !b.manual) continue;              // scraped boards re-warm on their own
    const markets = {};
    for (const [mt, m] of Object.entries(b.markets || {})) {
      if (!m || !m.players) continue;
      markets[mt] = {
        T: m.T, uplift: m.uplift, k: m.k, overround: m.overround, source: m.source,
        players: Object.fromEntries(m.players),
      };
    }
    if (Object.keys(markets).length) {
      bySlug[slug] = { tournament: b.tournament, eventName: b.eventName, manual: true, markets };
    }
  }
  return Object.keys(bySlug).length ? { at: _cache.at, bySlug } : null;
}

async function persistPasteBoard() {
  try {
    const payload = _serializeCache();
    if (!payload) return false;
    const db = require('./db');
    await db.saveKV(_KV_KEY, payload);
    log.info('GolfTopN', `Persisted paste board (${Object.keys(payload.bySlug).join(', ')}) — survives redeploys`);
    return true;
  } catch (e) {
    log.warn('GolfTopN', `persistPasteBoard failed: ${e.message}`);
    return false;
  }
}

/**
 * Rehydrate the operator's pasted board at boot. Never clobbers a board that is
 * already loaded (a scrape or a fresh paste that landed first wins), and never
 * resurrects one that is already past MANUAL_MAX_AGE_MS.
 */
async function restorePasteBoard() {
  try {
    const db = require('./db');
    const saved = await db.loadKV(_KV_KEY);
    if (!saved || !saved.bySlug || !Object.keys(saved.bySlug).length) return false;
    const ageMs = Date.now() - Number(saved.at || 0);
    if (!(Number(saved.at) > 0) || ageMs > MANUAL_MAX_AGE_MS) {
      log.info('GolfTopN', `Stored paste board is ${(ageMs / 3600000).toFixed(1)}h old (limit ${(MANUAL_MAX_AGE_MS / 3600000).toFixed(0)}h) — NOT restoring; re-paste to quote outrights`);
      return false;
    }
    if (Object.keys(_cache.bySlug || {}).length) {
      log.info('GolfTopN', 'A board is already loaded — skipping restore');
      return false;
    }
    const bySlug = {};
    for (const [slug, b] of Object.entries(saved.bySlug)) {
      const markets = {};
      for (const [mt, m] of Object.entries(b.markets || {})) {
        const players = new Map();
        for (const [name, p] of Object.entries(m.players || {})) {
          const v = Number(p);
          if (v > 0 && v < 1) players.set(name, v);   // re-validate; never trust stored junk
        }
        if (players.size) markets[mt] = { T: m.T, uplift: m.uplift, k: m.k, overround: m.overround, source: m.source || 'paste', players };
      }
      if (Object.keys(markets).length) bySlug[slug] = { tournament: b.tournament, eventName: b.eventName, manual: true, markets };
    }
    if (!Object.keys(bySlug).length) return false;
    _cache = { at: Number(saved.at), bySlug };       // ORIGINAL timestamp, not now
    const counts = Object.entries(bySlug).map(([s, b]) =>
      s + ':' + Object.entries(b.markets).map(([m, x]) => m + '=' + x.players.size).join(',')).join(' | ');
    log.info('GolfTopN', `Restored pasted outright board from DB (${(ageMs / 60000).toFixed(0)}min old): ${counts}`);
    return true;
  } catch (e) {
    log.warn('GolfTopN', `restorePasteBoard failed: ${e.message}`);
    return false;
  }
}
let _inflight = null;
// Last-attempt telemetry, exposed via /golf-topn. The warm is fire-and-forget
// from the seed, so when it dies on prod the ONLY trace is a log line inside
// Railway — from the outside an outage is indistinguishable from "DK has no
// boards". (Cost us ~15h of top-N downtime at The Open R1: the scrape was
// failing every cycle and /golf-topn could only show the board getting older.)
const _lastWarm = { at: null, ok: null, error: null, tookMs: null, scrape: {} }; // scrape: slug -> {keys, selections}

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
  const t = _norm(tournamentName).replace(/^\d{4}\b\s*/, '').trim(); // drop leading year
  // Must look like a tournament NAME: at least one letter and enough of it to
  // identify something. Without the length floor the substring loop below is
  // catastrophic — `k.includes(t)` means a single letter "a" matches "the
  // masters" and resolves to a major's board. Also stops a bare "2026" (whose
  // year-strip leaves nothing meaningful) from slugifying to "2026".
  if (!t || t.length < 4 || !/[a-z]/.test(t)) return null;
  const map = _slugMap();
  if (map[t]) return map[t];
  for (const [k, v] of Object.entries(map)) if (t.includes(k) || k.includes(t)) return v;
  // SLUGIFY FALLBACK. The map exists because slugify does NOT work for majors
  // ("The Open" -> the-open-championship), but it is exception-only: it holds
  // 9 majors/flagships and nothing else, so before this EVERY ordinary PGA
  // event ("Wyndham Championship", "RBC Canadian Open") resolved to null and
  // could never register a top-N line. That silently capped outright coverage
  // to majors, against the operator directive to quote outrights for ALL
  // tournaments.
  //
  // Safe by construction:
  //  - PASTE path: the slug is only a cache key, and ingest + lookup both
  //    derive it here, so they agree by definition.
  //  - SCRAPE path: a wrong slug 404s into an empty board, which fails closed
  //    exactly like the null it replaces. A wrong slug cannot produce a WRONG
  //    price, only no price.
  // Exceptions still win — the map is consulted first.
  const slug = t.replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9-]{2,}$/.test(slug) ? slug : null;
}

const _aImpl = a => { if (a == null || a === '') return null; const n = Number(a); if (!isFinite(n) || n === 0) return null; return n >= 0 ? 100 / (n + 100) : (-n) / (-n + 100); };

// ---------------------------------------------------------------------------
// DK ↔ DataGolf name reconciliation.
//
// The books disagree on GIVEN names: DK "Daniel Brown" vs DataGolf "Dan Brown",
// "John Keefer" vs "Johnny Keefer", "Nicolas Echavarria" vs "Nico Echavarria".
// Exact-match dropped 9 of 147 players from the intersection (live, 2026-07-16).
//
// That is not cosmetic. `overround = dhRaw / n` is only meaningful when dhRaw
// covers the WHOLE field — a dead-heat board sums to exactly n by construction.
// Every unmatched player silently removes his probability from dhRaw, biasing
// the overround DOWN. Top 20 is where it bites: those 9 carried ~2 units (Dan
// Brown alone is +150 ≈ 40% to make the top 20), so dhRaw came in at 18.88 vs
// n=20 → overround 0.944 → the >1.0001 guard refused the board. The guard was
// RIGHT; the matching was wrong. Top 5/10 survived only because the same 9 are
// cheap that shallow — i.e. their overrounds were quietly biased too.
//
// Match on surname + a first-name PREFIX relation (dan⊂daniel, nico⊂nicolas,
// john⊂johnny), and only when exactly ONE candidate fits. Ambiguity must never
// guess: this field has two Fitzpatricks and two Hojgaards, and pairing the
// wrong brother would corrupt a real player's price.
// ---------------------------------------------------------------------------
function _splitName(n) {
  const parts = String(n || '').split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') };  // "de castro piera" stays intact
}

function _anchorByLast(anchor) {
  if (anchor._byLast) return anchor._byLast;
  const idx = new Map();
  for (const [k, v] of anchor.byName) {
    const s = _splitName(k);
    if (!s) continue;
    if (!idx.has(s.last)) idx.set(s.last, []);
    idx.get(s.last).push({ first: s.first, prob: v });
  }
  Object.defineProperty(anchor, '_byLast', { value: idx, enumerable: false });
  return idx;
}

/** Dead-heat prob for a DK name, or null. Exact first, then unique-nickname. */
function _anchorProb(anchor, dkName) {
  const exact = anchor.byName.get(dkName);
  if (exact != null) return exact;
  const s = _splitName(dkName);
  if (!s) return null;
  const cands = _anchorByLast(anchor).get(s.last);
  if (!cands || cands.length === 0) return null;
  const fits = cands.filter(c => c.first === s.first
    || c.first.startsWith(s.first) || s.first.startsWith(c.first));
  if (fits.length !== 1) return null; // 0 = no match, 2+ = ambiguous → never guess
  return fits[0].prob;
}

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
  const unmatched = [];
  for (const [name, p] of dkByName) {
    const dh = _anchorProb(anchor, name);
    if (dh == null) { unmatched.push(name); continue; }
    tiesRaw += p; dhRaw += dh; matched++;
  }
  // Surface what fell out. An unmatched player is not free — he silently
  // biases the overround (see _anchorProb). If this list ever grows, the
  // derivation is drifting and the board should be distrusted.
  if (unmatched.length) {
    log.warn('GolfTopN', `${label}: ${unmatched.length}/${dkByName.size} DK players have no DataGolf counterpart `
      + `(${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? ', …' : ''}) — their probability is missing from the overround`);
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
 * Build the make-cut market from DK's one-sided make board by power-normalizing
 * the whole field to T = cutN + tie extra. No DataGolf anchor involved.
 */
function _buildCutMarket(dkSel, cutN, label) {
  const dkByName = new Map();
  for (const s of dkSel) {
    const p = _aImpl(s.americanOdds);
    if (p != null && p > 0 && p < 1) dkByName.set(_normName(s.playerName), p);
  }
  if (dkByName.size < MIN_PLAYERS) { log.warn('GolfTopN', `${label}: only ${dkByName.size} priced players — refusing`); return null; }
  const T = cutN + CUT_TIE_EXTRA;
  let rawSum = 0;
  for (const p of dkByName.values()) rawSum += p;
  const overround = rawSum / T;
  if (!(overround >= CUT_OVERROUND_MIN && overround <= CUT_OVERROUND_MAX)) {
    log.warn('GolfTopN', `${label}: raw make-side sum ${rawSum.toFixed(2)} vs T=${T} → overround x${overround.toFixed(3)} outside [${CUT_OVERROUND_MIN}, ${CUT_OVERROUND_MAX}] — refusing (missing players or wrong cut rule)`);
    return null;
  }
  const k = _solvePower(Array.from(dkByName.values()), T);
  if (k == null) { log.warn('GolfTopN', `${label}: power normalization failed`); return null; }
  const players = new Map();
  for (const [name, p] of dkByName) players.set(name, Math.pow(p, k));
  log.info('GolfTopN', `${label}: make-side rawSum=${rawSum.toFixed(2)} → T=${T} (cut ${cutN} + ${CUT_TIE_EXTRA} ties), overround x${overround.toFixed(3)}, k=${k.toFixed(3)}, ${players.size} players`);
  return { T, uplift: T / cutN, k, overround, players };
}

/**
 * Refresh the DK ties-included top-N board for one tournament.
 * SLOW (~142s, Puppeteer) — background only.
 */
async function warmTopNForSlug(slug, tournamentName, { force = false } = {}) {
  const dk = await dkScraper.fetchGolfOutrights(slug, { force });
  // Record the raw scrape shape even when the board build below refuses —
  // distinguishes "scrape came back empty" from "scrape fine, guard tripped".
  _lastWarm.scrape[slug] = (dk.markets || []).map(m => `${m.marketType}:${(m.selections || []).length}`).join(',') || 'EMPTY';
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
  // MAKE-CUT — separate path from top-N on purpose: no ties-name guard (DK
  // names it "To Make the Cut"; there IS no dead-heat variant of a binary
  // market to mistake it for) and no DataGolf anchor (the normalization
  // target is the cut rule itself). Unknown cut rule → fails closed above.
  const cutM = (dk.markets || []).find(m => m.marketType === 'make_cut');
  const cutN = _cutNFor(slug);
  if (cutM && cutM.selections && cutM.selections.length >= MIN_PLAYERS) {
    if (!cutN) {
      log.warn('GolfTopN', `${slug} make_cut: no cut rule configured (GOLF_CUT_N_MAP) — refusing to guess; make_cut stays on DataGolf only`);
    } else {
      const built = _buildCutMarket(cutM.selections, cutN, `${slug}/make_cut`);
      if (built) {
        out.markets.outright_make_cut = built;
        // eventName normally comes from the DataGolf anchor; if only the cut
        // board built (e.g. DK dropped top-N late in a tournament), fall back
        // to the tournament name so the board isn't unaddressable.
        if (!out.eventName) out.eventName = tournamentName;
      }
    }
  }
  return out;
}

/**
 * Warm every tournament PX currently lists a top-N board for.
 * `tournaments`: [{ tournamentName }]. Single-flight; TTL-gated.
 */
// A warm should never take longer than the DK scrape (~45-150s) plus slack.
// Past this, treat the in-flight warm as HUNG (Puppeteer launch or
// browser.close() wedged on Railway — both observed) and abandon it so the
// next call starts a fresh scrape instead of returning the stuck promise
// forever. Without this, ONE hung scrape kills top-N until the process
// restarts (operator hit exactly this between The Open R2/R3, 2026-07-17:
// lastWarm.at frozen, ok=null, board empty, every outright RFQ declining).
const WARM_MAX_RUN_MS = (Number(process.env.GOLF_TOPN_WARM_MAX_RUN_SEC) || 240) * 1000;
let _inflightStarted = 0;

async function warmTopN(tournaments, { force = false } = {}) {
  // NEVER let a scrape clobber a fresh operator paste board — the paste is
  // authoritative (operator rule 2026-07-18) and the prod scrape is unreliable.
  const manualFresh = Object.values(_cache.bySlug || {}).some(b => b && b.manual)
    && _cache.at && Date.now() - _cache.at < MANUAL_MAX_AGE_MS;
  if (manualFresh) return _cache;
  if (!force && Date.now() - _cache.at < TTL_MS && Object.keys(_cache.bySlug).length) return _cache;
  // Return the running warm ONLY if it hasn't overrun — otherwise abandon the
  // hung one and fall through to start a fresh scrape.
  if (_inflight && Date.now() - _inflightStarted < WARM_MAX_RUN_MS) return _inflight;
  _inflightStarted = Date.now();
  const _p = (async () => {
    const warmStarted = Date.now();
    _lastWarm.at = new Date().toISOString();
    _lastWarm.ok = null; _lastWarm.error = null; _lastWarm.tookMs = null; _lastWarm.scrape = {};
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
      catch (e) {
        // First error wins — it's almost always the root cause (a Puppeteer
        // launch failure repeats identically for every slug).
        if (!_lastWarm.error) _lastWarm.error = e.message;
        log.warn('GolfTopN', `warm ${slug} failed: ${e.message}`);
      }
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
    _lastWarm.ok = freshMarkets;
    _lastWarm.tookMs = Date.now() - warmStarted;
    _cache = { at: freshMarkets ? Date.now() : _cache.at, bySlug };
    const summary = Object.entries(bySlug).map(([s, b]) => `${s}:[${Object.keys(b.markets).join(',') || 'none'}]`).join(' ');
    const heldMarkets = Object.values(bySlug).some(b => b && b.markets && Object.keys(b.markets).length > 0);
    log.info('GolfTopN', `Warmed ${Object.keys(bySlug).length} tournament(s): ${summary || 'none'}`
      + (heldMarkets ? (freshMarkets ? '' : '  (retained previous board — scrape returned nothing)')
                     : '  ** NO MARKETS — top-N DECLINING **'));
    return _cache;
  })();
  _inflight = _p;
  // Only clear if we're still the current warm — if this one overran and was
  // abandoned, a newer warm now owns _inflight and must not be clobbered.
  _p.finally(() => { if (_inflight === _p) _inflight = null; });
  return _p;
}

/**
 * SYNC fair for a top-N leg. Pure cache read — safe on the RFQ hot path.
 * FAILS CLOSED (null ⇒ decline) on: cold/expired cache, no DK slug, market not
 * served by DK, or player not on the board.
 */
function getTopNFairProbSync(playerName, marketType, tournamentName) {
  const isCut = marketType === 'outright_make_cut';
  // outright_win is priceable ONLY from a manual paste board (the scrape/anchor
  // path never built a winner market). TOPN_MARKETS covers top_5/10/20.
  const isWin = marketType === 'outright_win';
  if (!TOPN_MARKETS[marketType] && !isCut && !isWin) return null;
  const slug = resolveDkSlug(tournamentName);
  if (!slug) return null;
  const board = _cache.bySlug[slug];
  if (!board) return null;
  const mkt = board.markets[marketType];
  if (!mkt) return null;
  // Paste boards carry their OWN (longer) freshness ceiling: the operator
  // pastes deliberately and stops via the kill-switch, so we don't force a
  // re-paste every MAX_AGE. Scraped boards keep the tight MAX_AGE. A win market
  // ONLY comes from a paste, so it always uses the manual ceiling.
  const ceiling = (board.manual || isWin) ? MANUAL_MAX_AGE_MS : MAX_AGE_MS;
  if (!_cache.at || Date.now() - _cache.at > ceiling) return null;
  const p = mkt.players.get(_normName(playerName));
  if (p == null || !(p > 0 && p < 1)) return null;
  const basis = board.manual
    ? `operator DK "Including Ties" paste (raw implied, mirror)`
    : isCut
      ? `DK live make-side board, power-normalized to T=${mkt.T.toFixed(1)} (cut + ties)`
      : `DK "Including Ties" board, power-de-vigged to derived T=${mkt.T.toFixed(2)} (uplift x${mkt.uplift.toFixed(3)})`;
  return { fairProb: p, basis, eventName: board.eventName, T: mkt.T, uplift: mkt.uplift, manual: !!board.manual };
}

// American -> implied prob (paste values are American ints incl. U+2212).
const _aImplPaste = a => { const n = Number(a); if (!isFinite(n) || n === 0) return null; return n >= 0 ? 100 / (n + 100) : (-n) / (-n + 100); };

// Parse the operator's DK outright "(Including Ties)" paste into
// { winner, top5, top10, top20 } player->americanOdds maps. Structure: a main
// block (rows = player then Winner/Top5/Top10 numbers; deep-tail rows drop
// Winner -> 2 numbers = Top5/Top10), then a "Top 20 (Including Ties)" block
// (rows = player then ONE number). Numbers may carry U+2212. Parse by counting
// numbers per row, never by fixed column (operator format note 2026-07-18).
function parseDkOutrightPaste(text) {
  const rawLines = String(text || '').replace(/−/g, '-').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const isNum = (l) => /^[+-]?\d{2,6}$/.test(l);
  const isTop20Header = (l) => /^top\s*20\s*\(including ties\)/i.test(l);
  const isOddsHeader = (l) => /outright winner|top\s*\d+\s*\(including ties\)|including ties/i.test(l);
  const out = { winner: {}, top5: {}, top10: {}, top20: {} };
  let section = 'main', i = 0;
  while (i < rawLines.length && isOddsHeader(rawLines[i]) && !isTop20Header(rawLines[i])) i++;
  while (i < rawLines.length) {
    const line = rawLines[i];
    if (isTop20Header(line)) { section = 'top20'; i++; continue; }
    if (isOddsHeader(line) || isNum(line)) { i++; continue; }
    const player = line; const nums = []; let j = i + 1;
    while (j < rawLines.length && isNum(rawLines[j])) { nums.push(parseInt(rawLines[j], 10)); j++; }
    i = j;
    if (section === 'top20') { if (nums.length >= 1) out.top20[player] = nums[0]; }
    else if (nums.length === 3) { out.winner[player] = nums[0]; out.top5[player] = nums[1]; out.top10[player] = nums[2]; }
    else if (nums.length === 2) { out.top5[player] = nums[0]; out.top10[player] = nums[1]; }
    else if (nums.length === 1) { out.winner[player] = nums[0]; }
  }
  return out;
}

/**
 * Ingest an operator DK "(Including Ties)" paste as the AUTHORITATIVE outright
 * board (operator rule 2026-07-18: mirror the paste, not the scrape — the prod
 * scrape is Akamai-gated/unreliable). Stores RAW DK implied per player per
 * market (winner/top5/10/20); the pricer mirrors it with only a small cushion
 * (option B). Marks the board manual so warmTopN won't clobber it with a scrape.
 * Returns per-market player counts.
 */
function ingestPaste(text, tournamentName) {
  const slug = resolveDkSlug(tournamentName);
  if (!slug) throw new Error(`no DK slug for "${tournamentName}" — add to GOLF_DK_SLUG_MAP`);
  const parsed = parseDkOutrightPaste(text);
  const marketMap = { outright_win: parsed.winner, outright_top_5: parsed.top5, outright_top_10: parsed.top10, outright_top_20: parsed.top20 };
  const markets = {};
  const counts = {};
  for (const [mt, odds] of Object.entries(marketMap)) {
    const players = new Map();
    for (const [name, american] of Object.entries(odds || {})) {
      const p = _aImplPaste(american);
      if (p == null || !(p > 0 && p < 1)) continue;
      players.set(_normName(name), p);
    }
    if (players.size) { markets[mt] = { players, source: 'paste' }; counts[mt] = players.size; }
  }
  if (!Object.keys(markets).length) throw new Error('paste parsed to zero priceable markets — check format');
  _cache = {
    at: Date.now(),
    bySlug: { [slug]: { tournament: tournamentName, eventName: tournamentName, markets, manual: true } },
  };
  log.info('GolfTopN', `Ingested operator paste for ${slug}: ${Object.entries(counts).map(([k, v]) => k + '=' + v).join(' ')}`);
  // NOTE: persistence is the CALLER's job (POST /golf-outrights/paste awaits
  // persistPasteBoard so it can report `persisted` honestly). Kept out of here
  // so this stays synchronous and a DB hiccup can never fail a paste that is
  // already in memory and pricing. Any new caller must persist explicitly.
  return { slug, counts };
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
    lastWarm: { ..._lastWarm },
    bySlug: Object.fromEntries(Object.entries(_cache.bySlug).map(([s, b]) => [s, {
      tournament: b.tournament, eventName: b.eventName,
      markets: Object.fromEntries(Object.entries(b.markets).map(([m, x]) => [m, { T: x.T, uplift: x.uplift, k: x.k, overround: x.overround, players: x.players.size }])),
    }])) };
}

module.exports = { warmTopN, warmTopNForSlug, getTopNFairProbSync, ingestPaste, parseDkOutrightPaste, resolveDkSlug, __debugCache, _buildTopNMarket, __anchorProb: _anchorProb, persistPasteBoard, restorePasteBoard, __setCacheForTest: (c) => { _cache = c; }, __getCacheForTest: () => _cache };
