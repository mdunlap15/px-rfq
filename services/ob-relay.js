/**
 * Order-book fair relay (2026-10-06).
 *
 * Operator: "I would like for the RFQs and order book lines to have the exact
 * same methodologies for creating their lines and monitoring for line changes
 * ... use a relay from the order book."
 *
 * The order book (poster-service) writes kv_store['px_rfq_relay'] =
 * {line_id: [fairProb, epoch_s, source]} from two places (poster-service/
 * rfq_relay.py): every poster's fair for the lines it prices, each pass, and
 * every cancel-only line guard's fair for each resting offer, every ~20 s pass.
 * fairProb = P(that line_id's side wins), computed the order book's way (exact
 * point, Pinnacle-primary with a gap guard, sharp composite, the more adverse
 * decides).
 *
 * The pricer asks getFair() for every leg. A fresh relay entry for the leg's own
 * line_id is used directly; otherwise, if the order book priced the OTHER side
 * of the same two-way market, 1 − that fair (PX line_ids are shared between the
 * order book and RFQ — verified 2026-10-06, 318/404 NHL SOG lines matched).
 * Legs the order book does not price keep RFQ's own fair. Polling is one small
 * kv read every OB_RELAY_POLL_SEC through the DB breaker; nothing here is on the
 * RFQ hot path except a Map lookup.
 */
const log = require('./logger');
const { config } = require('../config');

const KEY = 'px_rfq_relay';
// ORDER-BOOK ASKS + HOLDS (2026-11-12, poster-service rfq_relay.py):
//   px_rfq_asks  = {line_id: [m, epoch_s, source]} — m = implied prob of the
//     order book's OWN resting offer ON line_id (the best one for a taker: the
//     highest m). The maker's offer on A creates a takeable price neg(A) on the
//     other side B, so a taker on B pays 1 − m — the RFQ ask for a leg on B.
//     Written by px_post_client.place() at post time and refreshed by the line
//     guards from what they see resting (~20 s).
//   px_rfq_holds = {ts, holds: {key: [until_epoch_s, source]}} — every guard /
//     poster hold file on the poster host, collected and replaced whole (so a
//     released hold disappears). key = a line_id (either side of its market
//     is held), 'e:<px event id>' (whole event), or
//     'p:<px event id>|<norm player>' / '...|rush' (NFL player hold; rush = only
//     rushing markets).
const ASKS_KEY = 'px_rfq_asks';
const HOLDS_KEY = 'px_rfq_holds';
let _asks = {};
let _holds = {};
let _holdsTs = 0;
let _map = {};             // line_id -> [fair, ts, source]
let _loadedAt = 0;
let _timer = null;
let _inflight = false;
const _stats = { polls: 0, pollErrors: 0, lastError: null, entries: 0, used: 0, complement: 0, adverseOverride: 0, askEntries: 0, holdEntries: 0 };

// Two-way sibling lookup over the line index, rebuilt at most every 60 s.
let _sibAt = 0;
let _sibSize = -1;
let _siblings = new Map(); // lineId -> sibling lineId

function enabled() {
  const p = config.pricing || {};
  return p.obRelayEnabled !== false;
}
function maxAgeSec() { return Number((config.pricing || {}).obRelayMaxAgeSec) || 300; }
function maxGap() { return Number((config.pricing || {}).obRelayMaxGapPp) || 0.06; }
function askMaxAgeSec() { return Number((config.pricing || {}).obRelayAskMaxAgeSec) || 300; }
// A holds snapshot older than this is ignored: the list is replaced whole on
// every collection, so it is only trusted while it is being rewritten.
function holdsMaxAgeSec() { return Number((config.pricing || {}).obRelayHoldsMaxAgeSec) || 180; }

function _groupKey(li) {
  if (!li || li.pxEventId == null) return null;
  const mt = String(li.marketType || '');
  const sel = String(li.selection || li.oddsApiSelection || '').toLowerCase();
  let lineKey = li.line == null ? '' : Number(li.line);
  // Spread-like markets pair home −x with away +x: key on the HOME-perspective line.
  if (li.line != null && /spread|run_line|puck|handicap/.test(mt)) {
    if (sel === 'home') lineKey = Number(li.line);
    else if (sel === 'away') lineKey = -Number(li.line);
    else return null;
  }
  return [li.pxEventId, li.marketName || mt, mt, lineKey, li.playerName || ''].join('|');
}

function _rebuildSiblings() {
  try {
    const lineManager = require('./line-manager');
    const idx = lineManager.__debugGetLineIndex ? lineManager.__debugGetLineIndex() : null;
    if (!idx) return;
    const size = Object.keys(idx).length;
    if (Date.now() - _sibAt < 60e3 && size === _sibSize) return;
    const groups = new Map();
    for (const [lid, li] of Object.entries(idx)) {
      const k = _groupKey(li);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(lid);
    }
    const sib = new Map();
    for (const ids of groups.values()) {
      if (ids.length === 2) { sib.set(ids[0], ids[1]); sib.set(ids[1], ids[0]); }
    }
    _siblings = sib; _sibAt = Date.now(); _sibSize = size;
  } catch (e) {
    log.debug('ObRelay', `sibling rebuild failed: ${e.message}`);
  }
}

// Entry = [fair_lo, ts, source, fair_hi]. The guards grade a line against two
// candidate fairs and the order book keeps the LOWER for the side it holds; the
// RFQ book holds the OPPOSITE position when a bettor backs that line, so the
// same "more adverse decides" rule, applied from our side, is fair_hi for this
// line and 1 − fair_lo for the other side. Posters write one fair (lo == hi);
// a 3-element entry predates the split and reads as lo == hi.
// ORDER-BOOK PARITY extension (2026-11-11, read back-compatibly; the posters
// write it once poster-service rfq_relay.py is updated):
//   entry[4] = ask — the implied prob a taker pays on the order book to hold
//              THIS line_id's side (the order book's posted offer on the other
//              side, seen from the taker). RFQ prices a leg on this line at it.
//   entry[5] = holdUntil — epoch s until which a guard holds this line (player
//              hold, book-move, churn, stability wait, cumulative move, large
//              fill). Applies to both sides of the market; RFQ declines.
function _fresh(entry, nowS) {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const lo = Number(entry[0]), ts = Number(entry[1]);
  let hi = entry.length >= 4 ? Number(entry[3]) : lo;
  if (!(lo > 0 && lo < 1) || !Number.isFinite(ts)) return null;
  if (!(hi > 0 && hi < 1) || hi < lo) hi = lo;
  const age = nowS - ts;
  if (age < -60 || age > maxAgeSec()) return null;
  const ask = entry.length >= 5 ? Number(entry[4]) : NaN;
  const holdUntil = entry.length >= 6 ? Number(entry[5]) : NaN;
  return { lo, hi, ageSec: Math.max(0, Math.round(age)), source: entry[2] || null,
    ask: ask > 0 && ask < 1 ? ask : null, holdUntil: Number.isFinite(holdUntil) && holdUntil > nowS ? holdUntil : null };
}

/**
 * The order book's fair for this leg, or null. { fair, ageSec, source, via }
 * via = 'direct' (same line_id) | 'complement' (1 − the other side's fair).
 */
function getFair(lineId) {
  if (!enabled() || !lineId) return null;
  const nowS = Date.now() / 1000;
  const d = _fresh(_map[lineId], nowS);
  if (d) return { fair: d.hi, lo: d.lo, hi: d.hi, ageSec: d.ageSec, source: d.source, via: 'direct', ask: d.ask != null ? d.ask : getAsk(lineId), holdUntil: d.holdUntil };
  _rebuildSiblings();
  const sib = _siblings.get(lineId);
  if (sib) {
    const s = _fresh(_map[sib], nowS);
    if (s) return { fair: 1 - s.lo, lo: 1 - s.hi, hi: 1 - s.lo, ageSec: s.ageSec, source: s.source, via: 'complement', sibling: sib, ask: getAsk(lineId), holdUntil: s.holdUntil };
  }
  return null;
}

/**
 * The order book's price to a TAKER on this line_id (implied prob), or null:
 * a relay entry's own ask (entry[4]) first, else 1 − m of the order book's
 * freshest best resting offer on the OTHER side of this two-way market.
 */
function getAsk(lineId) {
  if (!enabled() || !lineId) return null;
  const nowS = Date.now() / 1000;
  const d = _fresh(_map[lineId], nowS);
  if (d && d.ask != null) return d.ask;
  _rebuildSiblings();
  const sib = _siblings.get(lineId);
  const e = sib ? _asks[sib] : null;
  if (!Array.isArray(e) || e.length < 2) return null;
  const m = Number(e[0]), ts = Number(e[1]);
  if (!(m > 0 && m < 1) || !Number.isFinite(ts)) return null;
  const age = nowS - ts;
  if (age < -60 || age > askMaxAgeSec()) return null;
  return 1 - m;
}

// Port of poster-service nfl_player_hold.norm(): NFD -> ascii, lower, drop
// jr/sr/ii/iii/iv, keep [a-z0-9] only.
function normPlayer(s) {
  let x = String(s || '').normalize('NFD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  x = x.replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '');
  return x.replace(/[^a-z0-9]+/g, '');
}
const _RUSH_MARKETS = new Set(['player_rush_yds', 'player_rush_attempts', 'player_rush_reception_yds', 'player_rush_longest', 'player_pass_rush_yds']);

/**
 * Epoch seconds until which the order book's guards hold this leg, or null.
 * Checks the line, its two-way sibling, its PX event and (props) its player.
 */
function getHold(lineId, li) {
  if (!enabled() || !lineId) return null;
  const nowS = Date.now() / 1000;
  let until = null;
  const take = (v) => {
    const u = Array.isArray(v) ? Number(v[0]) : NaN;
    if (Number.isFinite(u) && u > nowS && (until == null || u > until)) until = u;
  };
  // relay-entry hold (entry[5]) on the line or its sibling
  const d = _fresh(_map[lineId], nowS);
  if (d && d.holdUntil) take([d.holdUntil]);
  _rebuildSiblings();
  const sib = _siblings.get(lineId);
  if (sib) { const s = _fresh(_map[sib], nowS); if (s && s.holdUntil) take([s.holdUntil]); }
  if (_holdsTs && nowS - _holdsTs <= holdsMaxAgeSec()) {
    take(_holds[lineId]);
    if (sib) take(_holds[sib]);
    if (li && li.pxEventId != null) {
      take(_holds['e:' + li.pxEventId]);
      if (li.playerName) {
        const pk = 'p:' + li.pxEventId + '|' + normPlayer(li.playerName);
        take(_holds[pk]);
        if (_RUSH_MARKETS.has(String(li.marketType || ''))) take(_holds[pk + '|rush']);
      }
    }
  }
  return until;
}

/**
 * The fair the pricer should use: the order book's when it has a fresh one,
 * except when RFQ's own fair is MORE adverse (higher bettor-side probability)
 * by more than OB_RELAY_MAX_GAP_PP — a disagreement that size is more likely a
 * stale/mis-keyed entry than a real edge, so the protective number wins.
 */
function resolve(lineId, ownFair) {
  const r = getFair(lineId);
  if (!r) return null;
  let used = r.fair;
  let adverseOverride = false;
  if (ownFair > 0 && ownFair < 1 && ownFair - r.fair > maxGap()) { used = ownFair; adverseOverride = true; }
  _stats.used++;
  if (r.via === 'complement') _stats.complement++;
  if (adverseOverride) _stats.adverseOverride++;
  return { ...r, own: ownFair, used, adverseOverride };
}

async function poll() {
  if (_inflight) return;
  _inflight = true;
  try {
    const db = require('./db');
    if (!db.isAvailable || !db.isAvailable()) return;
    const client = db.getClient();
    if (!client) return;
    const r = await client.from('kv_store').select('key,value').in('key', [KEY, ASKS_KEY, HOLDS_KEY]);
    _stats.polls++;
    if (r.error) throw new Error(r.error.message);
    for (const row of (r.data || [])) {
      const v = row && row.value;
      if (!v || typeof v !== 'object') continue;
      if (row.key === KEY) { _map = v; _stats.entries = Object.keys(v).length; _loadedAt = Date.now(); }
      else if (row.key === ASKS_KEY) { _asks = v; _stats.askEntries = Object.keys(v).length; }
      else if (row.key === HOLDS_KEY) {
        _holds = (v.holds && typeof v.holds === 'object') ? v.holds : {};
        _holdsTs = Number(v.ts) || 0;
        _stats.holdEntries = Object.keys(_holds).length;
      }
    }
  } catch (e) {
    _stats.pollErrors++; _stats.lastError = e.message;
  } finally {
    _inflight = false;
  }
}

function start() {
  if (_timer) return;
  const sec = Math.max(10, Number(process.env.OB_RELAY_POLL_SEC) || 30);
  poll().catch(() => {});
  _timer = setInterval(() => { if (enabled()) poll().catch(() => {}); }, sec * 1000);
  if (_timer.unref) _timer.unref();
}

function getStatus() {
  const nowS = Date.now() / 1000;
  let fresh = 0;
  const bySource = {};
  for (const e of Object.values(_map)) {
    const f = _fresh(e, nowS);
    if (f) { fresh++; const s = String(f.source || '?').split(':')[0]; bySource[s] = (bySource[s] || 0) + 1; }
  }
  let freshAsks = 0;
  for (const e of Object.values(_asks)) if (Array.isArray(e) && nowS - Number(e[1]) <= askMaxAgeSec()) freshAsks++;
  let activeHolds = 0;
  const holdsFresh = !!(_holdsTs && nowS - _holdsTs <= holdsMaxAgeSec());
  if (holdsFresh) for (const v of Object.values(_holds)) if (Array.isArray(v) && Number(v[0]) > nowS) activeHolds++;
  return {
    enabled: enabled(), maxAgeSec: maxAgeSec(), maxGapPp: maxGap(),
    asks: { fresh: freshAsks, maxAgeSec: askMaxAgeSec() },
    holds: { active: activeHolds, snapshotAgeSec: _holdsTs ? Math.round(nowS - _holdsTs) : null, trusted: holdsFresh },
    loadedAgeSec: _loadedAt ? Math.round((Date.now() - _loadedAt) / 1000) : null,
    fresh, bySource, siblings: _siblings.size / 2, ..._stats,
  };
}

function __setForTest(map, opts = {}) {
  _map = map || {}; _loadedAt = Date.now();
  if (opts.asks) _asks = opts.asks;
  if (opts.holds) { _holds = opts.holds; _holdsTs = opts.holdsTs != null ? opts.holdsTs : Date.now() / 1000; }
  if (opts.siblings) { _siblings = new Map(opts.siblings); _sibAt = Date.now(); _sibSize = opts.size != null ? opts.size : 0; }
}
function __resetForTest() { _asks = {}; _holds = {}; _holdsTs = 0; _map = {}; _siblings = new Map(); _sibAt = 0; _sibSize = -1; for (const k of Object.keys(_stats)) if (typeof _stats[k] === 'number') _stats[k] = 0; }

module.exports = { getFair, getAsk, getHold, normPlayer, resolve, poll, start, getStatus, _groupKey, __setForTest, __resetForTest, KEY };
