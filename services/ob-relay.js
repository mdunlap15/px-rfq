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
let _map = {};             // line_id -> [fair, ts, source]
let _loadedAt = 0;
let _timer = null;
let _inflight = false;
const _stats = { polls: 0, pollErrors: 0, lastError: null, entries: 0, used: 0, complement: 0, adverseOverride: 0 };

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

function _fresh(entry, nowS) {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const f = Number(entry[0]), ts = Number(entry[1]);
  if (!(f > 0 && f < 1) || !Number.isFinite(ts)) return null;
  const age = nowS - ts;
  if (age < -60 || age > maxAgeSec()) return null;
  return { fair: f, ageSec: Math.max(0, Math.round(age)), source: entry[2] || null };
}

/**
 * The order book's fair for this leg, or null. { fair, ageSec, source, via }
 * via = 'direct' (same line_id) | 'complement' (1 − the other side's fair).
 */
function getFair(lineId) {
  if (!enabled() || !lineId) return null;
  const nowS = Date.now() / 1000;
  const d = _fresh(_map[lineId], nowS);
  if (d) return { ...d, via: 'direct' };
  _rebuildSiblings();
  const sib = _siblings.get(lineId);
  if (sib) {
    const s = _fresh(_map[sib], nowS);
    if (s) return { fair: 1 - s.fair, ageSec: s.ageSec, source: s.source, via: 'complement', sibling: sib };
  }
  return null;
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
    const r = await client.from('kv_store').select('value').eq('key', KEY).maybeSingle();
    _stats.polls++;
    if (r.error) throw new Error(r.error.message);
    const v = r.data && r.data.value;
    if (v && typeof v === 'object') { _map = v; _stats.entries = Object.keys(v).length; _loadedAt = Date.now(); }
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
  return {
    enabled: enabled(), maxAgeSec: maxAgeSec(), maxGapPp: maxGap(),
    loadedAgeSec: _loadedAt ? Math.round((Date.now() - _loadedAt) / 1000) : null,
    fresh, bySource, siblings: _siblings.size / 2, ..._stats,
  };
}

function __setForTest(map, opts = {}) {
  _map = map || {}; _loadedAt = Date.now();
  if (opts.siblings) { _siblings = new Map(opts.siblings); _sibAt = Date.now(); _sibSize = opts.size != null ? opts.size : 0; }
}
function __resetForTest() { _map = {}; _siblings = new Map(); _sibAt = 0; _sibSize = -1; for (const k of Object.keys(_stats)) if (typeof _stats[k] === 'number') _stats[k] = 0; }

module.exports = { getFair, resolve, poll, start, getStatus, _groupKey, __setForTest, __resetForTest, KEY };
