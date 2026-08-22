'use strict';

/**
 * Season-long futures / outrights, sourced from The Odds API.
 *
 * PX posts these as an event with `competitors: []` where EACH MARKET IS ONE
 * ENTITY carrying YES/NO selections -- structurally identical to golf
 * outrights (see _registerGolfOutrightEvent in line-manager.js).
 *
 * SCOPE IS DELIBERATELY NARROW, and the reason matters. PX lists 37 futures
 * events (measured 2026-08-22). TOA publishes exactly 10 outright sport keys,
 * of which only THREE map onto something PX sells:
 *
 *   Super Bowl LXI Winner      -> americanfootball_nfl_super_bowl_winner
 *   2026 World Series Winner   -> baseball_mlb_world_series_winner
 *   National Champion 2026/27  -> americanfootball_ncaaf_championship_winner
 *
 * There is NO TOA source for the other 34: NFL/CFB Regular Season Win Totals,
 * Division Winners, AFC/NFC Winner, conference champions, MVP / Heisman /
 * Cy Young / Rookie of the Year, AL/NL Pennant, Make The Playoffs, WNBA
 * Finals, tennis major champions, Premier League Winner or Relegation. Those
 * need a scraped source (the DK Puppeteer path used for golf) and are NOT
 * covered here. Registering them without a source would advertise lines we
 * decline 100% of the time -- the PX Rule 2 problem.
 *
 * BASIS. A winner field is exhaustive and mutually exclusive: exactly one
 * entity wins, so true probabilities sum to EXACTLY 1. Books post it with a
 * large overround -- measured on the live NCAAF board 2026-08-22: fanduel
 * 136.9%, draftkings 140.7%, betmgm 149.8% across 62-137 entries. Each book is
 * POWER-normalized to 1.0 independently, then the normalized fields are
 * averaged. Power rather than proportional for the same reason as the golf
 * make-cut board: proportional underrates favourites (measured -4.15pp), and a
 * 137-entry field is nearly all longshots.
 */

const log = require('./logger');

// PX event name -> TOA outright key. Anchored on distinctive words so a
// renamed season ("Super Bowl LXII") still matches while a DIFFERENT market
// on the same words ("Super Bowl MVP") does not.
const FUTURES_MAP = [
  { re: /\bsuper\s*bowl\b/i, notRe: /\bmvp\b/i, sport: 'americanfootball_nfl_super_bowl_winner', target: 1, label: 'nfl_super_bowl_winner' },
  { re: /\bworld\s*series\s*winner\b/i, sport: 'baseball_mlb_world_series_winner', target: 1, label: 'mlb_world_series_winner' },
  { re: /\bnational\s*champion\b/i, sport: 'americanfootball_ncaaf_championship_winner', target: 1, label: 'ncaaf_championship_winner' },
];

const BOOKS = process.env.FUTURES_BOOKMAKERS
  || 'pinnacle,draftkings,fanduel,betmgm,betrivers,betonlineag';
const REGIONS = process.env.FUTURES_REGIONS || 'us,us2,uk,eu';
const TTL_MS = (parseInt(process.env.FUTURES_TTL_MIN, 10) || 60) * 60 * 1000;
const MAX_AGE_MS = (parseInt(process.env.FUTURES_MAX_AGE_MIN, 10) || 360) * 60 * 1000;
const MIN_BOOKS = parseInt(process.env.FUTURES_MIN_BOOKS, 10) || 2;
const FETCH_TIMEOUT_MS = parseInt(process.env.FUTURES_FETCH_TIMEOUT_MS, 10) || 12000;

const _cache = {};
const _inflight = {};
const _stats = { fetches: 0, ok: 0, transientFails: 0, lastAt: null, lastError: null };

/** Solve for the exponent k where sum(p_i^k) === target. */
function powerNormalize(probs, target) {
  const ps = probs.filter(p => typeof p === 'number' && p > 0 && p < 1);
  if (!ps.length || !(target > 0)) return null;
  const sum = (k) => ps.reduce((s, p) => s + Math.pow(p, k), 0);
  let lo = 0.05, hi = 12;
  if ((sum(lo) - target) * (sum(hi) - target) > 0) return null;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    if (sum(k) > target) lo = k; else hi = k;
  }
  return (lo + hi) / 2;
}

function americanToImplied(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

/** Which TOA outright key (if any) serves this PX futures event name. */
function classifyFuturesEvent(pxEventName) {
  const n = String(pxEventName || '');
  if (!n) return null;
  for (const m of FUTURES_MAP) {
    if (!m.re.test(n)) continue;
    if (m.notRe && m.notRe.test(n)) continue;
    return m;
  }
  return null;
}

// Explicit aliases for the one shape the safe matcher cannot resolve: a
// ONE-word school with a MULTI-word mascot ("Alabama" -> "Alabama Crimson
// Tide"). No heuristic can take these without also taking "Ohio" ->
// "Ohio State Buckeyes", so they are listed by hand instead. Keys and values
// are both normalized before use. Extend via FUTURES_ENTITY_ALIASES as JSON.
const ENTITY_ALIASES = (() => {
  const base = {
    'alabama': 'Alabama Crimson Tide',
  };
  try {
    const extra = JSON.parse(process.env.FUTURES_ENTITY_ALIASES || '{}');
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string' && v.trim()) base[String(k).toLowerCase().trim()] = v.trim();
    }
  } catch (err) {
    log.warn('Futures', `FUTURES_ENTITY_ALIASES is not valid JSON — ignoring: ${err.message}`);
  }
  return base;
})();

function normalizeEntity(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch one outright board and build { entityKey -> fairProb }.
 * Per-book power-normalize to `target`, average across books, then renormalize
 * (averaging normalized fields drifts slightly off target). Fails CLOSED.
 */
async function fetchFuturesBoard(entry) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey || !entry) return null;
  const key = entry.sport;
  const now = Date.now();
  const cached = _cache[key];
  if (cached && (now - cached.at) < TTL_MS) return cached.board;
  if (_inflight[key]) return _inflight[key];

  _inflight[key] = (async () => {
    _stats.fetches++;
    const url = `https://api.the-odds-api.com/v4/sports/${key}/odds`
      + `?apiKey=${apiKey}&regions=${REGIONS}&markets=outrights`
      + `&bookmakers=${BOOKS}&oddsFormat=american`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let data;
    try {
      const resp = await require('node-fetch')(url, { signal: ctrl.signal });
      if (resp.status === 429 || resp.status >= 500) {
        // TRANSIENT. Never cache as a miss -- a 429 is indistinguishable
        // downstream from "this board does not exist", which is exactly how a
        // rate limit masquerades as a coverage gap.
        _stats.transientFails++;
        _stats.lastError = `HTTP ${resp.status}`;
        return cached ? cached.board : null;
      }
      if (!resp.ok) { _cache[key] = { at: now, board: null }; return null; }
      data = await resp.json();
    } catch (err) {
      _stats.transientFails++;
      _stats.lastError = err.message;
      return cached ? cached.board : null;
    } finally { clearTimeout(timer); }

    const ev = Array.isArray(data) ? data[0] : null;
    if (!ev) { _cache[key] = { at: now, board: null }; return null; }

    const perBook = [];
    for (const b of (ev.bookmakers || [])) {
      const m = (b.markets || []).find(x => x.key === 'outrights');
      if (!m || !Array.isArray(m.outcomes) || m.outcomes.length < 2) continue;
      const names = [], probs = [];
      for (const o of m.outcomes) {
        const p = americanToImplied(o.price);
        if (!(p > 0 && p < 1)) continue;
        names.push(o.name); probs.push(p);
      }
      if (probs.length < 2) continue;
      const k = powerNormalize(probs, entry.target);
      if (k == null) continue;
      const pow = probs.map(p => Math.pow(p, k));
      const s = pow.reduce((a, x) => a + x, 0);
      if (!(s > 0)) continue;
      const map = {};
      for (let i = 0; i < names.length; i++) {
        map[normalizeEntity(names[i])] = pow[i] * (entry.target / s);
      }
      perBook.push({ book: b.key, map, raw: probs.reduce((a, x) => a + x, 0) });
    }
    if (perBook.length < MIN_BOOKS) { _cache[key] = { at: now, board: null }; return null; }

    const acc = {};
    for (const pb of perBook) {
      for (const [k2, v] of Object.entries(pb.map)) (acc[k2] = acc[k2] || []).push(v);
    }
    const avgMap = {};
    let total = 0;
    for (const [k2, arr] of Object.entries(acc)) {
      const v = arr.reduce((a, x) => a + x, 0) / arr.length;
      avgMap[k2] = v; total += v;
    }
    if (!(total > 0)) { _cache[key] = { at: now, board: null }; return null; }
    for (const k2 of Object.keys(avgMap)) avgMap[k2] *= (entry.target / total);

    const board = {
      sport: key, label: entry.label, target: entry.target,
      entities: avgMap, books: perBook.length,
      bookKeys: perBook.map(p => p.book),
      overrounds: perBook.map(p => Number(p.raw.toFixed(3))),
      fetchedAt: now,
    };
    _cache[key] = { at: now, board };
    _stats.ok++; _stats.lastAt = new Date(now).toISOString();
    log.info('Futures', `${entry.label}: ${Object.keys(avgMap).length} entities from ${perBook.length} books (raw field sums ${board.overrounds.join(', ')})`);
    return board;
  })().finally(() => { delete _inflight[key]; });

  return _inflight[key];
}

/**
 * Sync fair lookup for the RFQ hot path. Boards are warmed in the background;
 * this NEVER fetches. Fails closed on a cold, stale or unknown board.
 */
function getFuturesFairSync(pxEventName, entityName) {
  const entry = classifyFuturesEvent(pxEventName);
  if (!entry) return null;
  const c = _cache[entry.sport];
  if (!c || !c.board) return null;
  if ((Date.now() - c.at) > MAX_AGE_MS) return null;
  const want = normalizeEntity(entityName);
  if (!want) return null;
  const ents = c.board.entities;
  if (ents[want] != null) return ents[want];
  const alias = ENTITY_ALIASES[want];
  if (alias) {
    const ak = normalizeEntity(alias);
    if (ents[ak] != null) return ents[ak];
  }
  const keys = Object.keys(ents);

  // PX writes the school/city ("Ohio State"); TOA appends the mascot ("Ohio
  // State Buckeyes"). Naive prefix matching is NOT safe here: "Georgia"
  // prefixes both "georgia bulldogs" and "georgia tech yellow jackets", and
  // "Texas" prefixes "texas longhorns", "texas tech red raiders" and "texas a
  // and m aggies". Resolving those to the wrong school would price one team's
  // futures line off another's.
  //
  // So strip the mascot from the TOA side instead and require an EXACT match
  // on what remains. One trailing word first ("oregon ducks" -> "oregon"),
  // then two for multi-word mascots ("notre dame fighting irish" -> "notre
  // dame"). One-word is tried first on purpose: dropping two from "ohio state
  // buckeyes" gives "ohio", which would wrongly claim PX's "Ohio".
  //
  // Every tier requires a UNIQUE hit; ambiguity fails closed.
  const dropTail = (n) => keys.filter(k => {
    const parts = k.split(' ');
    return parts.length > n && parts.slice(0, parts.length - n).join(' ') === want;
  });
  for (const n of [1, 2]) {
    // Only strip n words when `want` itself has at least n. Without this,
    // stripping TWO from "ohio state buckeyes" yields "ohio" and a PX entry of
    // "Ohio" (the Bobcats) silently claims OHIO STATE's probability -- caught
    // by test, and a live board that happens to omit the Bobcats would not
    // have saved us. A one-word PX name should resolve against a one-word
    // mascot; needing two implies the school name has two words too, which
    // contradicts a one-word PX name.
    if (want.split(' ').length < n) continue;
    const hits = dropTail(n);
    if (hits.length === 1) return ents[hits[0]];
    if (hits.length > 1) return null; // genuinely ambiguous -- do not guess
  }
  // NO generic prefix fallback. It cannot be made safe: "Alabama" ->
  // "alabama crimson tide" (1-word school, 2-word mascot) and "Ohio" ->
  // "ohio state buckeyes" (2-word school, 1-word mascot) are structurally
  // IDENTICAL as strings, so any rule that resolves the first also resolves
  // the second -- handing PX's Ohio the Buckeyes' probability. A prefix tier
  // was tried and removed for exactly this.
  //
  // The cost is that a one-word school with a multi-word mascot fails closed
  // and we simply do not quote it. That is the correct direction: declining a
  // futures leg costs one RFQ, pricing the wrong team costs the position.
  return null;
}

async function warmFuturesBoards() {
  const out = [];
  for (const entry of FUTURES_MAP) {
    try {
      const b = await fetchFuturesBoard(entry);
      out.push({ label: entry.label, ok: !!b, entities: b ? Object.keys(b.entities).length : 0 });
    } catch (err) {
      out.push({ label: entry.label, ok: false, error: err.message });
    }
    // TOA limits by request FREQUENCY, not just quota.
    await new Promise(r => setTimeout(r, 1200));
  }
  return out;
}

function __debugState() {
  const out = {};
  for (const [k, v] of Object.entries(_cache)) {
    const ageMin = +((Date.now() - v.at) / 60000).toFixed(1);
    out[k] = v.board
      ? { entities: Object.keys(v.board.entities).length, books: v.board.books,
          bookKeys: v.board.bookKeys, overrounds: v.board.overrounds,
          ageMin, priceable: (Date.now() - v.at) <= MAX_AGE_MS }
      : { entities: 0, ageMin, priceable: false };
  }
  return { boards: out, stats: _stats, mapped: FUTURES_MAP.map(m => m.label) };
}

module.exports = {
  classifyFuturesEvent,
  fetchFuturesBoard,
  getFuturesFairSync,
  warmFuturesBoards,
  normalizeEntity,
  powerNormalize,
  __debugState,
  __FUTURES_MAP: FUTURES_MAP,
  __ENTITY_ALIASES: ENTITY_ALIASES,
  __debugSetBoard: (sport, board, at) => { _cache[sport] = { at: at || Date.now(), board }; },
};
