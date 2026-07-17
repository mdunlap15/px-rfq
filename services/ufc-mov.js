// ============================================================================
// ufc-mov.js — UFC Method-of-Victory fair values for PARLAY quoting
// ============================================================================
// PX posts FOUR per-fighter method markets, all typed 'moneyline' with YES/NO
// selections (live probe 2026-07-17, Usman/Du Plessis):
//     "<Fighter> To Win By KO/TKO/DQ"        -> mov_ko
//     "<Fighter> To Win By Submission"       -> mov_sub
//     "<Fighter> To Win By Decision"         -> mov_dec
//     "<Fighter> To Win Inside The Distance" -> mov_itd   (KO + SUB composite)
//
// SOURCE: DraftKings only. SharpAPI's method_of_victory feed DIED 2026-07-11
// and returns an EMPTY board rather than an error — anything built on it fails
// silently. See dk-scraper.fetchUfcMethodOfVictory for the scrape and its
// hard-won traps.
//
// ---------------------------------------------------------------------------
// THE DE-VIG
// ---------------------------------------------------------------------------
// One fight = SIX priced outcomes (2 fighters x KO/SUB/DEC) plus an unpriced
// draw. The vig lives across the WHOLE 6-way — DK's six sum to ~110-120%
// (measured 119.7% on Du Plessis/Usman). De-vigging a single fighter's three
// methods in isolation is therefore WRONG; normalize the fight's six together.
//
// Target sum is 1 - P(draw), not 1: the draw is a real 7th outcome DK doesn't
// price. UFC draws run ~0.5% (MOV_DRAW_PROB). Normalizing to 1.0 instead would
// inflate every YES fair by ~0.5% — conservative when we lay YES, but it makes
// the NO side (1 - YES) too cheap, and we quote both. So use the honest target.
//
// POWER (odds-ratio) de-vig, NOT proportional. A method board spans +110 to
// +3500 on one card — the widest favorite-longshot range of any market we
// price. Proportional normalization systematically underrates the favorite and
// overrates the longshot; on golf make-cut (same favorite-heavy shape) that
// bias measured -4.15pp on favorites vs -0.83pp for power. Underrating a
// favorite means quoting its YES too CHEAP — the one error that costs money.
//
// ITD is DERIVED, never sourced: P(A inside distance) = P(A by KO) + P(A by
// SUB) exactly, because the methods are mutually exclusive. DK has no ITD
// market, and a composite from another book is a documented trap ("KO/TKO, DQ
// or Submission" once masqueraded as a -115 submission vs a real +325).
//
// ---------------------------------------------------------------------------
// NAME MATCHING — fail safe, never guess
// ---------------------------------------------------------------------------
// Surname keys COLLIDE: one card carried BOTH Abus Magomedov and Shara
// Magomedov, and surname keying stamped Abus's prices onto Shara's markets.
// We key on a sorted-token signature of the FULL name, with a token-SUBSET
// fallback for middle names (DK "Jose Delgado" vs PX "Jose Miguel Delgado" is
// the same fighter; {abus,magomedov} is NOT a subset of {shara,magomedov}, so
// the collision still fails closed).
//
// ---------------------------------------------------------------------------
// WHY A BACKGROUND CACHE
// ---------------------------------------------------------------------------
// The scrape walks one page per fight (~3-5 min). It can NEVER sit on the RFQ
// hot path. warmMovBoards() refreshes on a timer; the pricer only ever does a
// sync cache read (getMovFairSync) and FAILS CLOSED — cold board, stale board,
// unknown fighter, or a broken de-vig all return null and the leg declines.
// A missed fill is free; a mispriced fill is not.
// ============================================================================

const log = require('./logger');
const dkScraper = require('./dk-scraper');

// READ tolerance: how old a board may be and still price. Method lines move far
// less than a live golf board (these are pre-fight prices on a card days out),
// but they must still go stale eventually rather than serve a dead board.
const MAX_AGE_MS = (Number(process.env.MOV_MAX_AGE_MIN) || 180) * 60 * 1000;
// WARM cadence: how often we kick a fresh scrape.
const TTL_MS = (Number(process.env.MOV_TTL_MIN) || 45) * 60 * 1000;
// UFC draws are rare (~0.5%). This is the 7th outcome DK never prices.
const DRAW_PROB = Number(process.env.MOV_DRAW_PROB ?? 0.005);
// A fight must carry a full 6-way to be priced. A partial board (DK missing a
// method) makes the normalization target meaningless — fail closed instead.
const REQUIRED_OUTCOMES = 6;
// Sanity band on the raw 6-way sum. Below 1.0 is impossible for a vig-carrying
// board (it's how the U+2212 favorite-drop bug announced itself on golf
// top_20); above 1.45 means the scrape mixed markets or DK repriced mid-walk.
const OVERROUND_MIN = 1.0001, OVERROUND_MAX = 1.45;

let _cache = { at: 0, byFight: {} }; // slug -> { fighters: Map(sig -> {name, tokens, KO, SUB, DEC}) }
let _inflight = null;

const _aImpl = (a) => {
  if (a == null || a === '') return null;
  const n = Number(a);
  if (!isFinite(n) || n === 0) return null;
  return n >= 0 ? 100 / (n + 100) : (-n) / (-n + 100);
};

/** Accent-stripped lowercase tokens, 1-char tokens and suffixes dropped. */
function _tokens(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !/^(jr|sr|ii|iii|iv)$/.test(t));
}
/** Order-insensitive full-name signature. */
function _sig(name) { return _tokens(name).slice().sort().join(' '); }

/**
 * Power-normalize a field so sum(p^k) = target. Returns k, or null if the
 * target isn't bracketable. Same bisection as golf-topn's _solvePower.
 */
function _solvePower(probs, target) {
  const f = (k) => probs.reduce((s, p) => s + Math.pow(p, k), 0) - target;
  let lo = 0.2, hi = 5;
  if (f(lo) * f(hi) > 0) return null; // target outside achievable range
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Build one fight's de-vigged method board from DK's raw per-fighter prices.
 * Returns { fighters: Map(sig -> {name, tokens, ko, sub, dec, itd}) } or null.
 */
function _buildFight(slug, dkFighters) {
  if (!Array.isArray(dkFighters) || dkFighters.length !== 2) {
    log.debug('UfcMov', `${slug}: ${dkFighters ? dkFighters.length : 0} fighters (need exactly 2) — skipping`);
    return null;
  }
  // Collect the 6 outcomes in a fixed order so the normalized values map back.
  const slots = [];
  for (const f of dkFighters) {
    for (const m of ['KO', 'SUB', 'DEC']) {
      const p = _aImpl(f[m]);
      if (p == null || !(p > 0 && p < 1)) {
        log.debug('UfcMov', `${slug}: ${f.name} has no ${m} price — fight not priceable (partial board)`);
        return null;
      }
      slots.push({ fighter: f.name, method: m, raw: p });
    }
  }
  if (slots.length !== REQUIRED_OUTCOMES) return null;

  const rawSum = slots.reduce((s, x) => s + x.raw, 0);
  const target = 1 - DRAW_PROB;
  const overround = rawSum / target;
  if (!(overround >= OVERROUND_MIN && overround <= OVERROUND_MAX)) {
    log.warn('UfcMov', `${slug}: raw 6-way sum ${rawSum.toFixed(3)} → overround x${overround.toFixed(3)} outside [${OVERROUND_MIN}, ${OVERROUND_MAX}] — refusing`);
    return null;
  }
  const k = _solvePower(slots.map(s => s.raw), target);
  if (k == null) {
    log.warn('UfcMov', `${slug}: power normalization failed — refusing`);
    return null;
  }

  const fighters = new Map();
  for (const s of slots) {
    const sig = _sig(s.fighter);
    if (!fighters.has(sig)) fighters.set(sig, { name: s.fighter, tokens: _tokens(s.fighter), ko: null, sub: null, dec: null, itd: null });
    fighters.get(sig)[s.method.toLowerCase()] = Math.pow(s.raw, k);
  }
  // ITD is exact: KO and SUB are mutually exclusive.
  for (const rec of fighters.values()) {
    if (rec.ko != null && rec.sub != null) rec.itd = rec.ko + rec.sub;
  }
  log.info('UfcMov', `${slug}: rawSum=${rawSum.toFixed(3)} → overround x${overround.toFixed(3)}, k=${k.toFixed(3)}, `
    + [...fighters.values()].map(f => `${f.name.split(' ').pop()} ko=${(f.ko * 100).toFixed(1)}%/sub=${(f.sub * 100).toFixed(1)}%/dec=${(f.dec * 100).toFixed(1)}%`).join('  '));
  return { fighters };
}

/**
 * Refresh every UFC method board. Single-flight; TTL-gated.
 * NEVER regresses a good board to empty on a failed scrape (same rule as
 * golf-topn: a stale-but-real board beats no board, and MAX_AGE still applies).
 */
async function warmMovBoards({ force = false } = {}) {
  if (!force && Date.now() - _cache.at < TTL_MS && Object.keys(_cache.byFight).length) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    let data = null;
    try {
      data = await dkScraper.fetchUfcMethodOfVictory({ force });
    } catch (err) {
      log.warn('UfcMov', `warm failed: ${err.message} — keeping previous board (ages out via MAX_AGE)`);
      return _cache;
    }
    const byFight = {};
    let built = 0;
    for (const f of ((data && data.fights) || [])) {
      const b = _buildFight(f.slug, f.fighters);
      if (b) { byFight[f.slug] = b; built++; }
    }
    if (built === 0) {
      log.warn('UfcMov', 'scrape produced NO priceable fights — keeping previous board');
      return _cache;
    }
    _cache = { at: Date.now(), byFight };
    log.info('UfcMov', `Warmed ${built} fight(s) with full 6-way method boards`);
    return _cache;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * Sync fair for one fighter+method. Hot-path safe. Fails CLOSED.
 *
 * `opponentName` is REQUIRED: it scopes the lookup to the one fight, which is
 * what makes a surname collision across the card impossible to hit.
 * Returns { fairProb, basis, fighter } or null.
 */
function getMovFairSync(fighterName, method, opponentName) {
  const field = { mov_ko: 'ko', mov_sub: 'sub', mov_dec: 'dec', mov_itd: 'itd' }[method];
  if (!field) return null;
  if (!_cache.at || Date.now() - _cache.at > MAX_AGE_MS) return null;
  const fSig = _sig(fighterName), oSig = _sig(opponentName);
  if (!fSig || !oSig) return null;
  const fTok = _tokens(fighterName), oTok = _tokens(opponentName);

  for (const [slug, board] of Object.entries(_cache.byFight)) {
    const recs = [...board.fighters.values()];
    if (recs.length !== 2) continue;
    // Resolve BOTH names within this fight; a fight matches only if each PX
    // name maps to a different DK fighter (exact signature, or token-subset
    // either direction to tolerate middle names).
    const match = (tok, sig, rec) => {
      if (_sig(rec.name) === sig) return true;
      const a = new Set(rec.tokens), b = new Set(tok);
      const subset = (x, y) => [...x].every(t => y.has(t));
      return (subset(a, b) || subset(b, a)) && Math.min(a.size, b.size) >= 2;
    };
    const fHits = recs.filter(r => match(fTok, fSig, r));
    const oHits = recs.filter(r => match(oTok, oSig, r));
    if (fHits.length !== 1 || oHits.length !== 1) continue;   // ambiguous → skip
    if (fHits[0] === oHits[0]) continue;                       // both mapped to one fighter → skip
    const p = fHits[0][field];
    if (p == null || !(p > 0 && p < 1)) return null;
    return {
      fairProb: p,
      basis: `DK 6-way method board, power-de-vigged to ${(1 - DRAW_PROB).toFixed(3)} (draw carve ${DRAW_PROB})`,
      fighter: fHits[0].name,
      slug,
    };
  }
  return null;
}

/**
 * Fair for a registered PX MoV line. Hot-path safe; never throws.
 *
 * lineInfo carries the fighter in playerName and BOTH competitors in
 * homeTeam/awayTeam — we hand the pair to getMovFairSync so the lookup is
 * scoped to one fight, which is what makes a same-surname collision elsewhere
 * on the card unreachable. Returns the fair for the leg's SIDE (yes/no).
 */
function getMovFairForLine(lineInfo) {
  try {
    if (!lineInfo || !MOV_TYPES.has(lineInfo.marketType)) return null;
    const fighter = lineInfo.playerName || lineInfo.teamName;
    if (!fighter) return null;
    const fSig = _sig(fighter);
    // Opponent = whichever competitor isn't the fighter.
    const home = lineInfo.homeTeam, away = lineInfo.awayTeam;
    let opponent = null;
    if (home && away) opponent = (_sig(home) === fSig) ? away : (_sig(away) === fSig ? home : null);
    if (!opponent) {
      // Signature mismatch (PX "Levi Rodrigues Jr." vs competitor spelling):
      // fall back to token-subset against both competitors.
      const fTok = new Set(_tokens(fighter));
      const sub = (a, b) => [...a].every(t => b.has(t));
      const hTok = new Set(_tokens(home || '')), aTok = new Set(_tokens(away || ''));
      if (hTok.size && (sub(fTok, hTok) || sub(hTok, fTok))) opponent = away;
      else if (aTok.size && (sub(fTok, aTok) || sub(aTok, fTok))) opponent = home;
    }
    if (!opponent) return null; // can't scope the fight → fail closed
    const hit = getMovFairSync(fighter, lineInfo.marketType, opponent);
    if (!hit) return null;
    const side = String(lineInfo.selection || '').toLowerCase();
    const p = side === 'no' ? 1 - hit.fairProb : hit.fairProb;
    if (!(p > 0 && p < 1)) return null;
    return { ...hit, fairProb: p };
  } catch (err) {
    log.warn('UfcMov', `getMovFairForLine threw: ${err.message}`);
    return null;
  }
}

const MOV_TYPES = new Set(['mov_ko', 'mov_sub', 'mov_dec', 'mov_itd']);

function __debugCache() {
  const fights = Object.entries(_cache.byFight).map(([slug, b]) => ({
    slug,
    fighters: [...b.fighters.values()].map(f => ({
      name: f.name,
      ko: f.ko != null ? Number((f.ko * 100).toFixed(2)) : null,
      sub: f.sub != null ? Number((f.sub * 100).toFixed(2)) : null,
      dec: f.dec != null ? Number((f.dec * 100).toFixed(2)) : null,
      itd: f.itd != null ? Number((f.itd * 100).toFixed(2)) : null,
    })),
  }));
  return {
    at: _cache.at || null,
    ageMs: _cache.at ? Date.now() - _cache.at : null,
    ttlMs: TTL_MS,
    maxAgeMs: MAX_AGE_MS,
    drawProb: DRAW_PROB,
    fightCount: fights.length,
    // priceable must mean "a MoV leg can actually price RIGHT NOW"
    priceable: !!(_cache.at && fights.length > 0 && Date.now() - _cache.at <= MAX_AGE_MS),
    fights,
  };
}

module.exports = { warmMovBoards, getMovFairSync, getMovFairForLine, __debugCache, _sig, _tokens, _buildFight };
