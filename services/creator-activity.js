/**
 * CREATOR ACTIVITY / QUOTE-FISHER DETECTION
 *
 * WHY. A 4-agent audit (2026-08-03) found that 79.7% of a 30-day quote sample
 * — 114,308 of 143,388 rows — came from two days and four zero-fill creators,
 * with creator 06294316 alone firing 116,176 RFQs for ZERO fills. Worse, their
 * share was collinear with the very axis being measured (7% of the cheapest
 * price band, 97% of the most expensive), because spam grids also trigger our
 * defensive markup. Every fill-rate and price-elasticity number computed over
 * that denominator was therefore measuring WHO WAS ASKING, not whether anyone
 * accepted. A "5x fill-rate cliff" evaporated once these were removed.
 *
 * THE FLAG MUST NOT BE DEFINED BY THE OUTCOME. Filtering on "creators with
 * zero fills" is endogenous — it conditions on the dependent variable, so any
 * elasticity measured afterwards is circular (the auditor flagged this on
 * their own analysis). So classification here uses only signals observable at
 * QUOTE TIME and independent of whether anything ever fills:
 *
 *   1. REQUEST RATE. The fisher sustains ~2,890 RFQs/hour; genuine
 *      counterparties are orders of magnitude below that.
 *   2. GRID RE-FIRE. Fishers re-send the same leg signature every few minutes
 *      to re-price a grid. Humans rarely re-request an identical ticket.
 *
 * Both are properties of the REQUEST STREAM, not of our fills, so a flag built
 * from them can legitimately be used as an exclusion in fill-rate analysis.
 *
 * In-memory and rolling: a restart re-learns within one window. That is
 * deliberate — persisting a verdict would let a one-off burst brand a creator
 * permanently, and the flag is stamped onto each quote as it is made, so the
 * historical record is already durable in parlay_orders.meta.
 */

const { config } = require('../config');
const log = require('./logger');

// Sliding window of RFQ timestamps per creator.
const _events = new Map();   // creatorId -> number[] (ms timestamps, ascending)
// Recent leg-signature timestamps per creator, for grid-refire detection.
const _sigs = new Map();     // creatorId -> Map<sig, number[]>

const WINDOW_MS = () => (Number(config.pricing.fisherWindowMinutes) || 60) * 60 * 1000;
const RATE_PER_HOUR = () => (Number(config.pricing.fisherRfqPerHour) || 400);
const REFIRE_MIN = () => (Number(config.pricing.fisherRefireCount) || 4);
const ENABLED = () => config.pricing.fisherDetectionEnabled !== false;

const MAX_TRACKED_CREATORS = 5000;   // hard bound; evict coldest when exceeded
const MAX_SIGS_PER_CREATOR = 400;

function _prune(arr, cutoff) {
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  return i ? arr.slice(i) : arr;
}

function _evictIfHuge() {
  if (_events.size <= MAX_TRACKED_CREATORS) return;
  // Evict the creators with the oldest most-recent activity.
  const entries = [..._events.entries()]
    .map(([k, v]) => [k, v.length ? v[v.length - 1] : 0])
    .sort((a, b) => a[1] - b[1]);
  const drop = entries.slice(0, Math.ceil(entries.length * 0.2));
  for (const [k] of drop) { _events.delete(k); _sigs.delete(k); }
}

/**
 * Record one RFQ. Call on EVERY inbound RFQ, before any decline logic, so the
 * rate reflects what was actually asked of us rather than what we chose to
 * quote. `legSig` is any stable signature of the requested legs.
 * Returns the creator's current activity snapshot.
 */
function recordRfq(creatorId, legSig, nowMs) {
  const now = nowMs || Date.now();
  if (!creatorId) return { rfqPerHour: 0, refires: 0, fisher: false };
  const cid = String(creatorId);
  const cutoff = now - WINDOW_MS();

  let arr = _events.get(cid) || [];
  arr = _prune(arr, cutoff);
  arr.push(now);
  _events.set(cid, arr);
  _evictIfHuge();

  let refires = 0;
  if (legSig) {
    let m = _sigs.get(cid);
    if (!m) { m = new Map(); _sigs.set(cid, m); }
    let ts = _prune(m.get(legSig) || [], cutoff);
    ts.push(now);
    m.set(legSig, ts);
    refires = ts.length;
    if (m.size > MAX_SIGS_PER_CREATOR) {
      // drop the least-recently-seen signatures
      const sorted = [...m.entries()].sort((a, b) => (a[1][a[1].length - 1] || 0) - (b[1][b[1].length - 1] || 0));
      for (const [k] of sorted.slice(0, Math.ceil(m.size * 0.25))) m.delete(k);
    }
  }

  return _snapshot(cid, now, refires);
}

function _snapshot(cid, now, refires) {
  const arr = _prune(_events.get(cid) || [], now - WINDOW_MS());
  const spanH = WINDOW_MS() / 3600000;
  const rfqPerHour = arr.length / spanH;
  let maxRefire = refires || 0;
  if (maxRefire === 0) {
    const m = _sigs.get(cid);
    if (m) for (const ts of m.values()) if (ts.length > maxRefire) maxRefire = ts.length;
  }
  const byRate = rfqPerHour >= RATE_PER_HOUR();
  const byRefire = maxRefire >= REFIRE_MIN() && rfqPerHour >= RATE_PER_HOUR() / 4;
  return {
    creatorId: cid,
    rfqCount: arr.length,
    rfqPerHour: Math.round(rfqPerHour),
    refires: maxRefire,
    fisher: ENABLED() && (byRate || byRefire),
    reason: !ENABLED() ? 'disabled' : byRate ? 'rate' : byRefire ? 'grid-refire' : null,
  };
}

/** Read-only classification; does not record an event. */
function classify(creatorId, nowMs) {
  if (!creatorId) return { fisher: false, rfqPerHour: 0, refires: 0, reason: null };
  return _snapshot(String(creatorId), nowMs || Date.now(), 0);
}

/** Is this creator currently behaving like a quote-fisher? */
function isFisher(creatorId) { return classify(creatorId).fisher; }

/** Snapshot for /market-intel and the dashboard. */
function stats(limit = 25) {
  const now = Date.now();
  const out = [];
  for (const cid of _events.keys()) out.push(_snapshot(cid, now, 0));
  out.sort((a, b) => b.rfqPerHour - a.rfqPerHour);
  const fishers = out.filter(o => o.fisher);
  return {
    enabled: ENABLED(),
    thresholds: { rfqPerHour: RATE_PER_HOUR(), refireCount: REFIRE_MIN(), windowMinutes: WINDOW_MS() / 60000 },
    trackedCreators: out.length,
    fisherCount: fishers.length,
    fisherRfqShare: out.length
      ? Math.round(1000 * fishers.reduce((s, o) => s + o.rfqCount, 0)
        / Math.max(1, out.reduce((s, o) => s + o.rfqCount, 0))) / 10
      : 0,
    top: out.slice(0, limit),
  };
}

function __resetForTest() { _events.clear(); _sigs.clear(); }

module.exports = { recordRfq, classify, isFisher, stats, __resetForTest };
