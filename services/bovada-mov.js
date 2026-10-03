// ============================================================================
// bovada-mov.js — UFC method-of-victory board from BOVADA, for RFQ MoV legs
// ============================================================================
// Operator directive 2026-10-03: "We should be quoting (1-sided) UFC MoV lines.
// Use the methodology we use for the order book lines." Standing principle:
// "I don't want to derive any of our own lines; I want ours to always be direct
// references to the lines of sportsbooks, adjusted as we may choose."
//
// REFERENCE = the order-book chain (read-only; never run from here):
//   C:/Users/mdunl/ufc_mov_board_bov.py  stager  (source, parse, floor, fair)
//   C:/Users/mdunl/ufc_mov_post.py       poster  (name guard, floor assert)
//   C:/Users/mdunl/dwcs_mov_cycle.py     cycle   (MOV_FLOOR=-300)
//   C:/Users/mdunl/px_post_client.py     devig_n_shin (ported below, exact)
//
// THE ORDER BOOK'S POSITION, AND OURS
//   The poster lays the NO of "<Fighter> To Win By <method>" at NO = -(Bovada
//   YES), only when that NO is -300 or deeper (Bovada YES >= +300). In a parlay
//   the counterparty takes the YES leg and we hold the NO — the same position.
//   So the RFQ leg is YES-only, its offered probability is Bovada's RAW YES
//   implied probability (the price the poster's NO mirrors), and it quotes only
//   while that YES is >= MOV_RFQ_MIN_YES_ODDS (default +300).
//
// FAIR (EV / risk / exposure only — never the price): the stager's 6-way n-way
//   SHIN de-vig of KO/SUB/DEC x 2 fighters (exclusive + ~exhaustive field), and
//   ITD fair = KO + SUB. A fight missing any of the six has NO fair (the stager
//   blanks it); the RFQ leg then DECLINES — a parlay needs a fair to size risk.
//
// PARSING = the stager's method_of() and attribution, with three deliberate
// tightenings, each of which can only turn a quote into a refusal:
//   1. "Bout Specials" markets are excluded outright. The stager excludes them
//      only from the FAIR (2026-09-25); in staging they collide with the
//      straight "Wins by" rows as duplicate-disagreements. The directive is
//      straight quotes only, so they never enter the board here.
//   2. The ITD composite test reads 'ko' as a TOKEN, not a substring. The
//      stager's `'ko' in s and 'submission' in s` fires on any fighter whose
//      NAME contains "ko": on the 2026-10-03 card "Roman Kopylov Wins by
//      Submission" classifies as ITD. There it only produced a refusal (it
//      collided with the real ITD row), but on a card without an ITD row it
//      would mirror a SUBMISSION price onto the ITD market.
//   3. Fighter attribution needs a UNIQUE winner: a full-name hit for exactly
//      one fighter, else a surname hit for exactly one. The stager takes the
//      first fighter that hits, which assigns a shared surname to the home side.
//   Also: an outcome Bovada marks non-open (status != 'O') is skipped.
//
// ONE CALL PER REFRESH: the coupon with marketFilterId=all carries the full
// per-event market set. Verified 2026-10-03 (Gautier vs Kopylov): its MoV
// markets are identical to the per-event v2 endpoint the stager walks, so the
// per-fight fan-out is unnecessary. Plain HTTPS JSON — no Puppeteer.
// ============================================================================

const log = require('./logger');

const COUPON_URL = 'https://www.bovada.lv/services/sports/event/coupon/events/A/description/ufc-mma'
  + '?marketFilterId=all&preMatchOnly=true&lang=en';

const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const TIMEOUT_MS = () => envNum('MOV_BOVADA_TIMEOUT_MS', 15000);
const TTL_MS = () => envNum('MOV_BOVADA_TTL_SEC', 120) * 1000;
// READ tolerance for PRICING. Past it MoV legs fail closed.
const MAX_AGE_MS = () => envNum('MOV_BOVADA_MAX_AGE_MIN', 30) * 60 * 1000;
// How old a board may be and still steer REGISTRATION (floor/refusal). Longer
// than MAX_AGE on purpose: registration must not flap on a missed refresh.
const REG_MAX_AGE_MS = () => envNum('MOV_BOVADA_REG_MAX_AGE_MIN', 360) * 60 * 1000;
// The stager's MOV_WINDOW_H: only fights starting within this many hours.
const WINDOW_MS = () => envNum('MOV_RFQ_WINDOW_H', 26) * 3600 * 1000;

const METHODS = ['KO', 'SUB', 'DEC', 'ITD'];
const MT_TO_METHOD = { mov_ko: 'KO', mov_sub: 'SUB', mov_dec: 'DEC', mov_itd: 'ITD' };

// ---------------------------------------------------------------------------
// helpers — ports of the stager's
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'jnr', 'snr']);
/** stager surname(): last token with Jr./Sr./II... popped. Keeps U+FFFD / '?'. */
function surname(full) {
  const t = norm(full).split(/\s+/).filter(Boolean).map(x => x.replace(/[.,]/g, ''));
  while (t.length > 1 && SUFFIX.has(t[t.length - 1])) t.pop();
  return t.length ? t[t.length - 1] : '';
}
/** stager _fuzzy_eq: PX mojibakes accents to U+FFFD; treat it / '?' as a one-char wildcard. */
function fuzzyEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== y && x !== '\uFFFD' && y !== '\uFFFD' && x !== '?' && y !== '?') return false;
  }
  return true;
}
/** Accent-stripped lowercase tokens, 1-char and suffix tokens dropped (ufc-mov's _tokens). */
function tokens(name) {
  return norm(name).replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 1 && !SUFFIX.has(t));
}
const sig = (name) => tokens(name).slice().sort().join(' ');

/** stager prob(): American -> implied. */
function prob(o) {
  return o < 0 ? Math.abs(o) / (Math.abs(o) + 100) : 100 / (o + 100);
}
/** Python 3 round() — half to even — so the DEC synth matches the stager to the unit. */
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
/** stager price parse: 'EVEN' -> 100, '+250' -> 250, junk -> null. */
function parseAmerican(od) {
  if (od == null || od === '') return null;
  if (String(od).toUpperCase() === 'EVEN') return 100;
  const n = parseInt(String(od).replace('+', ''), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * EXACT port of px_post_client.devig_n_shin(probs, total=1.0, _iter=90).
 * n-way Shin for a mutually exclusive field: z bisected so sum(p)=1, then
 * scaled by total. Fail-safe proportional scaling when S<=1 or z can't bracket.
 */
function devigNShin(probs, total = 1.0, iters = 90) {
  let q;
  try {
    q = (probs || []).filter(x => x != null && Number(x) > 0).map(Number);
  } catch (_) { return null; }
  if (q.some(x => !Number.isFinite(x))) return null;
  if (q.length < 2) return null;
  const S = q.reduce((a, b) => a + b, 0);
  if (S <= 1.0) return q.map(x => x * total / S);
  const psum = (z) => q.reduce((s, x) => s + (Math.sqrt(z * z + 4 * (1 - z) * x * x / S) - z) / (2 * (1 - z)), 0);
  let lo = 1e-9, hi = 0.999;
  if (psum(hi) > 1) return q.map(x => x * total / S);
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    if (psum(mid) > 1) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2;
  const p = q.map(x => (Math.sqrt(z * z + 4 * (1 - z) * x * x / S) - z) / (2 * (1 - z)));
  const t = p.reduce((a, b) => a + b, 0);
  return t > 0 ? p.map(x => x * total / t) : q.map(x => x * total / S);
}

/**
 * stager method_of(), with the token fix for the ITD composite (header note 2).
 * Returns 'KO' | 'SUB' | 'DEC' | 'DECU' | 'DECS' | 'ITD' | null.
 */
function methodOf(sel) {
  const s = norm(sel);
  if (s.includes('double chance')) return null;
  if (s.includes(' in round') || s.includes(' round ')) return null;
  // "Fight Winner - Inside The Distance Only X" is CONDITIONAL — not the ITD contract.
  if (s.includes('fight winner')) return null;
  if (s.includes('inside distance') || s.includes('inside the distance')) return 'ITD';
  const toks = s.replace(/,/g, ' ').replace(/\//g, ' ').split(/\s+/).filter(Boolean);
  const hasKo = toks.includes('ko') || toks.includes('tko');
  if (s.includes('ko/tko, dq or submission') || (hasKo && s.includes('submission'))) return 'ITD';
  if (s.includes('technical decision')) return null;
  if (s.includes('unanimous decision')) return 'DECU';
  if (s.includes('split or majority decision') || s.includes('split decision') || s.includes('majority decision')) return 'DECS';
  if (s.includes('submission')) return 'SUB';
  if (hasKo || s.includes('knockout')) return 'KO';
  if (s.includes('points') || s.includes('decision')) return 'DEC';
  return null;
}

/** Unique-winner fighter attribution (header note 3). */
function attribute(text, h, a) {
  const tl = norm(text);
  const full = [h, a].filter(f => tl.includes(norm(f)));
  if (full.length === 1) return full[0];
  if (full.length > 1) return null;
  const words = new Set(tl.split(/\s+/));
  const sur = [h, a].filter(f => {
    const pp = norm(f).split(/\s+/);
    return pp.length >= 2 && words.has(surname(f));
  });
  return sur.length === 1 ? sur[0] : null;
}

const distinct = (qs) => new Set(qs.map(q => q.od)).size;

/**
 * Build one fight's board from a Bovada coupon event. Pure.
 * Returns { eventId, description, home, away, startTimeMs, fighters, fair, refusals, movOutcomes }.
 *   fighters[name][METHOD] = { american, implied, source } | { refused: reason }
 *   fair = { [name]: {KO,SUB,DEC,ITD} } | null
 */
function buildFight(ev) {
  const desc = String(ev.description || '');
  const parts = desc.split(' vs ').map(x => x.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [h, a] = parts;
  const raw = new Map();            // `${fighter}|${meth}` -> [{text, od}]
  const push = (f, m, q) => { const k = f + '|' + m; if (!raw.has(k)) raw.set(k, []); raw.get(k).push(q); };
  let movOutcomes = 0;
  for (const dg of (ev.displayGroups || [])) {
    for (const m of (dg.markets || [])) {
      const md = norm(m.description || '');
      if (md.includes('bout specials')) continue;              // combination bets — never straight quotes
      const isMovish = ['method of victory', 'wins by', 'to win by', 'how will'].some(k => md.includes(k));
      for (const o of (m.outcomes || [])) {
        if (o.status != null && o.status !== 'O') continue;    // suspended / closed outcome
        const od = parseAmerican((o.price || {}).american);
        if (od == null) continue;
        const sel = String(o.description || '');
        const text = isMovish ? sel : ((m.description || '') + ' ' + sel);
        const meth = methodOf(text);
        if (!meth) continue;
        const fighter = attribute(text, h, a);
        if (!fighter) continue;
        push(fighter, meth, { text: text.slice(0, 60), od, market: m.description || '' });
        movOutcomes++;
      }
    }
  }
  if (!movOutcomes) return { eventId: String(ev.id), description: desc, home: h, away: a, startTimeMs: Number(ev.startTime) || null, fighters: {}, fair: null, refusals: [], movOutcomes: 0 };

  const refusals = [];
  // DEC = bare quote, else UD + split/majority (probability sum) — stager synth.
  for (const f of [h, a]) {
    const qu = raw.get(f + '|DECU');
    if (!qu || raw.has(f + '|DEC')) continue;
    if (distinct(qu) > 1) { refusals.push(`${f} DEC: UD duplicate-quote disagreement`); continue; }
    const qs = raw.get(f + '|DECS') || [];
    if (qs.length && distinct(qs) > 1) { refusals.push(`${f} DEC: split/majority duplicate-quote disagreement`); continue; }
    const pd = prob(qu[0].od) + (qs.length ? prob(qs[0].od) : 0);
    if (!(pd > 0 && pd < 1)) continue;
    const am = pd > 0.5 ? pyRound(-100 * pd / (1 - pd)) : pyRound(100 * (1 - pd) / pd);
    raw.set(f + '|DEC', [{ text: 'synth UD+SMD', od: am, market: 'synth' }]);
  }

  // FAIR — straight quotes only, 6-way Shin, ITD = KO + SUB.
  const straight = (qs) => (qs && qs.length && distinct(qs) === 1) ? prob(qs[0].od) : null;
  const field = {};
  for (const f of [h, a]) {
    for (const m of ['KO', 'SUB']) { const v = straight(raw.get(f + '|' + m)); if (v != null) field[f + '|' + m] = v; }
    let dec = straight((raw.get(f + '|DEC') || []).filter(q => q.text !== 'synth UD+SMD'));
    if (dec == null) {
      const du = straight(raw.get(f + '|DECU'));
      const ds = raw.get(f + '|DECS') ? straight(raw.get(f + '|DECS')) : 0.0;
      dec = (du != null && ds != null) ? du + ds : null;
    }
    if (dec != null) field[f + '|DEC'] = dec;
  }
  const keys = [h, a].flatMap(f => ['KO', 'SUB', 'DEC'].map(m => f + '|' + m));
  let fair = null;
  if (keys.every(k => k in field)) {
    let fr = null;
    try { fr = devigNShin(keys.map(k => field[k]), 1.0); } catch (_) { fr = null; }
    if (fr && fr.length === keys.length) {
      const fd = {};
      keys.forEach((k, i) => { fd[k] = fr[i]; });
      fair = {};
      for (const f of [h, a]) {
        fair[f] = { KO: fd[f + '|KO'], SUB: fd[f + '|SUB'], DEC: fd[f + '|DEC'], ITD: fd[f + '|KO'] + fd[f + '|SUB'] };
      }
    }
  }

  // Per-market YES quotes — the stager's staging loop minus the floor (the
  // floor is applied at read time so it stays runtime-tunable).
  const fighters = {};
  for (const f of [h, a]) {
    fighters[f] = {};
    for (const m of METHODS) {
      const qs = raw.get(f + '|' + m);
      if (!qs || !qs.length) continue;
      if (distinct(qs) > 1) {
        fighters[f][m] = { refused: 'duplicate-quote disagreement: ' + qs.map(q => q.od).join('/') };
        refusals.push(`${f} ${m}: duplicate-quote disagreement (${qs.map(q => q.od).join(' / ')})`);
        continue;
      }
      fighters[f][m] = { american: qs[0].od, implied: prob(qs[0].od), source: qs[0].text };
    }
  }
  return { eventId: String(ev.id), description: desc, home: h, away: a, startTimeMs: Number(ev.startTime) || null, fighters, fair, refusals, movOutcomes };
}

/** Parse a whole coupon body. Pure. Pre-match only; fights already started are dropped. */
function parseCoupon(body, { nowMs = Date.now() } = {}) {
  const fights = {};
  for (const grp of (Array.isArray(body) ? body : [])) {
    for (const ev of (grp.events || [])) {
      if (!ev || !ev.id) continue;
      if (ev.live === true) continue;
      if (Number(ev.startTime) && Number(ev.startTime) <= nowMs) continue;
      const b = buildFight(ev);
      if (b && b.movOutcomes > 0) fights[b.eventId] = b;
    }
  }
  return fights;
}

// ---------------------------------------------------------------------------
// cache + warm (background only — never on the RFQ hot path)
// ---------------------------------------------------------------------------
let _cache = { at: 0, fights: {} };
let _inflight = null;
let _lastError = null;
let _fetch;
function fetchFn() {
  if (!_fetch) _fetch = global.fetch ? global.fetch.bind(global) : require('node-fetch');
  return _fetch;
}

async function warm({ force = false } = {}) {
  if (!force && _cache.at && Date.now() - _cache.at < TTL_MS()) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS());
    let body;
    try {
      const r = await fetchFn()(COUPON_URL, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.bovada.lv/sports',
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.json();
    } catch (err) {
      _lastError = err.message;
      log.warn('BovadaMov', `fetch failed: ${err.message} — keeping previous board (ages out via MOV_BOVADA_MAX_AGE_MIN)`);
      return _cache;
    } finally {
      clearTimeout(timer);
    }
    const fights = parseCoupon(body);
    _lastError = null;
    // An EMPTY parse is a real state (no MoV props posted yet) — stamp it so
    // registration knows the board is live, but keep it distinguishable.
    _cache = { at: Date.now(), fights };
    log.info('BovadaMov', `Board: ${Object.keys(fights).length} fight(s) with MoV props, ${Object.values(fights).filter(f => f.fair).length} with a complete 6-way fair`);
    return _cache;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/** Test/ops hook: install a parsed board (or a raw coupon body) as the cache. */
function ingestCoupon(body, { nowMs = Date.now(), at = Date.now() } = {}) {
  _cache = { at, fights: parseCoupon(body, { nowMs }) };
  return _cache;
}
function __setCache(c) { _cache = c; }

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------
/** One PX name vs one Bovada fighter, scoped to that bout. */
function nameMatch(pxName, bovName, bovOther) {
  if (sig(pxName) && sig(pxName) === sig(bovName)) return 'strong';
  const a = new Set(tokens(pxName)), b = new Set(tokens(bovName));
  const sub = (x, y) => [...x].every(t => y.has(t));
  if (Math.min(a.size, b.size) >= 2 && (sub(a, b) || sub(b, a))) return 'strong';
  // First-name / nickname difference (poster 2026-10-03: Bovada "Michael
  // Parkin" vs PX "Mick Parkin"). Accepted ONLY when the surname is unique in
  // the bout — a surname both fighters share never matches this way.
  const s = surname(pxName);
  if (s && fuzzyEq(s, surname(bovName)) && !fuzzyEq(s, surname(bovOther))) return 'surname';
  return null;
}

/**
 * Resolve a PX fighter + opponent to exactly one Bovada fight.
 * Returns { fight, side } | { error }.
 */
function findFight(fighter, opponent, { startTimeMs = null, cache = _cache } = {}) {
  const hits = [];
  for (const f of Object.values(cache.fights || {})) {
    const fh = nameMatch(fighter, f.home, f.away), fa = nameMatch(fighter, f.away, f.home);
    const oh = nameMatch(opponent, f.home, f.away), oa = nameMatch(opponent, f.away, f.home);
    let side = null, strong = false;
    if (fh && !fa && oa && !oh) { side = f.home; strong = fh === 'strong' || oa === 'strong'; }
    else if (fa && !fh && oh && !oa) { side = f.away; strong = fa === 'strong' || oh === 'strong'; }
    if (!side || !strong) continue;   // at least one name must match on more than a surname
    if (startTimeMs && f.startTimeMs && Math.abs(startTimeMs - f.startTimeMs) > 12 * 3600 * 1000) continue;
    hits.push({ fight: f, side });
  }
  if (hits.length === 1) return hits[0];
  return { error: hits.length ? 'mov_fight_ambiguous' : 'mov_fight_not_on_board' };
}

/** PX fighter + opponent from a registered MoV lineInfo (same rule as ufc-mov). */
function fighterAndOpponent(li) {
  const fighter = li.playerName || li.teamName;
  if (!fighter) return null;
  const fSig = sig(fighter), home = li.homeTeam, away = li.awayTeam;
  let opponent = null;
  if (home && away) opponent = sig(home) === fSig ? away : (sig(away) === fSig ? home : null);
  if (!opponent) {
    const fTok = new Set(tokens(fighter));
    const sub = (a, b) => [...a].every(t => b.has(t));
    const hTok = new Set(tokens(home || '')), aTok = new Set(tokens(away || ''));
    if (hTok.size && (sub(fTok, hTok) || sub(hTok, fTok))) opponent = away;
    else if (aTok.size && (sub(fTok, aTok) || sub(aTok, fTok))) opponent = home;
  }
  return opponent ? { fighter, opponent } : null;
}

const pricing = () => { try { return require('../config').config.pricing || {}; } catch (_) { return {}; } };
const minYes = () => { const v = Number(pricing().movRfqMinYesOdds); return Number.isFinite(v) && v >= 100 ? v : 300; };
const sweetener = () => { const v = Number(pricing().movBookMirrorSweetener); return Number.isFinite(v) && v >= 0 && v < 0.5 ? v : 0; };
const floorAtFair = () => String(process.env.MOV_MIRROR_FLOOR_AT_FAIR || '').toLowerCase() !== 'false';

/** Start-window check shared by registration and pricing. */
function windowRefusal(li, nowMs) {
  const st = Date.parse(li && li.startTime);
  if (!Number.isFinite(st)) return 'mov_start_unknown';          // fail closed
  if (st - nowMs > WINDOW_MS()) return 'mov_beyond_window';
  return null;
}

/**
 * Quote for a registered MoV leg. Hot-path safe (sync cache read), never throws.
 * Returns { ok:true, fairProb, bookPriceOverride, yesAmerican, rawImplied, basis, ... }
 *      or { ok:false, reason, detail }.
 */
function getQuoteForLine(li, { nowMs = Date.now() } = {}) {
  try {
    const meth = li && MT_TO_METHOD[li.marketType];
    if (!meth) return { ok: false, reason: 'mov_not_mov' };
    if (String(li.selection || '').toLowerCase() !== 'yes') return { ok: false, reason: 'mov_no_side', detail: 'MoV is YES-only (we hold the NO, like the order book)' };
    const w = windowRefusal(li, nowMs);
    if (w) return { ok: false, reason: w };
    if (Date.parse(li.startTime) <= nowMs) return { ok: false, reason: 'mov_started' };
    if (!_cache.at) return { ok: false, reason: 'mov_board_cold' };
    const age = nowMs - _cache.at;
    if (age > MAX_AGE_MS()) return { ok: false, reason: 'mov_board_stale', detail: `Bovada board ${Math.round(age / 60000)}min old` };
    const fo = fighterAndOpponent(li);
    if (!fo) return { ok: false, reason: 'mov_fighter_unresolved' };
    const hit = findFight(fo.fighter, fo.opponent, { startTimeMs: Date.parse(li.startTime) || null });
    if (hit.error) return { ok: false, reason: hit.error };
    const q = hit.fight.fighters[hit.side] && hit.fight.fighters[hit.side][meth];
    if (!q) return { ok: false, reason: 'mov_no_quote', detail: `Bovada has no straight ${meth} quote for ${hit.side}` };
    if (q.refused) return { ok: false, reason: 'mov_quote_refused', detail: q.refused };
    const floor = minYes();
    if (!(q.american >= floor)) return { ok: false, reason: 'mov_below_floor', detail: `Bovada YES ${q.american > 0 ? '+' : ''}${q.american} < +${floor}` };
    const fair = hit.fight.fair && hit.fight.fair[hit.side] && hit.fight.fair[hit.side][meth];
    if (!(fair > 0 && fair < 1)) return { ok: false, reason: 'mov_no_fair', detail: 'incomplete 6-way field on Bovada — no fair to size risk' };
    let offered = q.implied * (1 - sweetener());
    let clampedToFair = false;
    if (floorAtFair() && offered < fair) { offered = fair; clampedToFair = true; }
    if (!(offered > 0 && offered < 1)) return { ok: false, reason: 'mov_bad_price' };
    return {
      ok: true,
      fairProb: fair,
      bookPriceOverride: offered,
      rawImplied: q.implied,
      yesAmerican: q.american,
      clampedToFair,
      fighter: hit.side,
      bovadaEventId: hit.fight.eventId,
      basis: `Bovada YES ${q.american > 0 ? '+' : ''}${q.american} mirror${sweetener() ? ` x(1-${sweetener()})` : ''}; fair = 6-way Shin${meth === 'ITD' ? ' KO+SUB' : ''}`,
    };
  } catch (err) {
    log.warn('BovadaMov', `getQuoteForLine threw: ${err.message}`);
    return { ok: false, reason: 'mov_error', detail: err.message };
  }
}

/**
 * Registration gate for a MoV line (all index entry points). Returns a refusal
 * reason, or null to register. Deterministic inputs refuse (NO side, outside
 * the window, Bovada's YES below the floor, an ambiguous/refused quote);
 * TRANSIENT board state never does — a cold/very old board or a fight Bovada
 * hasn't posted props for registers and lets PRICING fail closed, because
 * seedAllLines is build-then-swap and a skipped line is deleted from PX's
 * supported set (the golf top-N flap).
 */
function registrationRefusal(li, { nowMs = Date.now() } = {}) {
  if (!li || !MT_TO_METHOD[li.marketType]) return null;
  if (String(li.selection || '').toLowerCase() !== 'yes') return 'mov_no_side';
  const w = windowRefusal(li, nowMs);
  if (w) return w;
  if (!_cache.at || nowMs - _cache.at > REG_MAX_AGE_MS()) return null;
  const fo = fighterAndOpponent(li);
  if (!fo) return null;
  const hit = findFight(fo.fighter, fo.opponent, { startTimeMs: Date.parse(li.startTime) || null });
  if (hit.error === 'mov_fight_ambiguous') return 'mov_fight_ambiguous';
  if (hit.error) return null;
  const q = hit.fight.fighters[hit.side] && hit.fight.fighters[hit.side][MT_TO_METHOD[li.marketType]];
  if (!q) return null;
  if (q.refused) return 'mov_quote_refused';
  if (!(q.american >= minYes())) return 'mov_below_floor';
  return null;
}

function __debug({ nowMs = Date.now() } = {}) {
  const floor = minYes();
  const fights = Object.values(_cache.fights).sort((x, y) => (x.startTimeMs || 0) - (y.startTimeMs || 0)).map(f => {
    const hrs = f.startTimeMs ? (f.startTimeMs - nowMs) / 3.6e6 : null;
    const fighters = {};
    const eligibleYes = [];
    for (const [name, ms] of Object.entries(f.fighters)) {
      fighters[name] = {};
      for (const m of METHODS) {
        const q = ms[m];
        const fair = f.fair && f.fair[name] ? f.fair[name][m] : null;
        if (!q) continue;
        fighters[name][m] = q.refused ? { refused: q.refused } : {
          yes: q.american, rawImpliedPct: +(q.implied * 100).toFixed(2),
          fairPct: fair != null ? +(fair * 100).toFixed(2) : null,
          eligible: q.american >= floor,
        };
        if (!q.refused && q.american >= floor && hrs != null && hrs * 3.6e6 <= WINDOW_MS()) {
          eligibleYes.push({ fighter: name, method: m, yes: q.american, fairPct: fair != null ? +(fair * 100).toFixed(2) : null });
        }
      }
    }
    return {
      eventId: f.eventId, fight: f.description, startsInHours: hrs != null ? +hrs.toFixed(2) : null,
      inWindow: hrs != null && hrs > 0 && hrs * 3.6e6 <= WINDOW_MS(),
      completeFair: !!f.fair, fighters, eligibleYes, refusals: f.refusals,
    };
  });
  const ageMs = _cache.at ? nowMs - _cache.at : null;
  return {
    source: 'bovada', url: COUPON_URL,
    at: _cache.at || null, ageMs, ttlMs: TTL_MS(), maxAgeMs: MAX_AGE_MS(), windowHours: WINDOW_MS() / 3.6e6,
    minYesOdds: floor, mirrorSweetener: sweetener(), mirrorFloorAtFair: floorAtFair(),
    lastError: _lastError,
    priceable: !!(_cache.at && ageMs <= MAX_AGE_MS() && fights.some(f => f.eligibleYes.length && f.completeFair)),
    fightCount: fights.length,
    fights,
  };
}

module.exports = {
  warm, ingestCoupon, parseCoupon, buildFight, getQuoteForLine, registrationRefusal,
  findFight, methodOf, attribute, devigNShin, prob, pyRound, surname, fuzzyEq, __debug, __setCache,
  MT_TO_METHOD, COUPON_URL,
};
