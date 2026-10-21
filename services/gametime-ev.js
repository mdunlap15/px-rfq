/**
 * EV live + game-time EV for RFQ fills (2026-10-13; EV live 2026-10-21).
 *
 * Operator: EV should be judged "at gametime" (10/13), then (10/21): "I would
 * like to start calculating EV at fill and EV live as we do for the order book.
 * We need to be closely watching how much value we leak or gain from fill till
 * gametime." Mirrors the order book's fair_sync semantics:
 *   - EV FILL  = meta.expectedValue, frozen at confirm. Never redefined.
 *   - EV LIVE  = a SECOND number: every open fill's legs re-graded with the quote
 *     path's own leg-fair resolution (pricer.priceParlay(..., {fairOnly:true}) —
 *     order-book relay, calibration, mirrors; the input's age recorded, never
 *     declined), every EV_LIVE_REFRESH_SEC (300 s, the order book's pass), every
 *     tick inside EV_LIVE_FAST_MIN (30) of the leg's start (the order book's
 *     pre-start fast lane).
 *   - FREEZE AT START: a leg stops updating EV_LIVE_FREEZE_LEAD_SEC (90 s, the
 *     order book's FAIR_SYNC_FREEZE_LEAD_S) before ITS scheduled start and is
 *     never graded in-play ("the final EV number for a wager should be the last
 *     EV measure taken prior to the start"). A leg with no read yet is read once
 *     at freeze; one first seen more than GAMETIME_EV_GRACE_SEC after its start
 *     (trader down across it) is 'missed' and counts at its fill fair.
 *
 *   meta.evLive   = { legs: {lineId: {fair, src, ageSec, at, minsToStart, frozen} | {fair:null, reason}},
 *                     fairProb, ev, coverage, updatedAt, frozenAt? }
 *   meta.gameTime = the FROZEN result once every leg is frozen (same shape as
 *                   before: legs with fillFair, fairProb, ev, coverage, finalizedAt)
 *
 * fairProb = fill fairParlayProb x PRODUCT(live leg fair / fill leg fair) over the
 * legs read — the SGP correlation factor and any parlay-level fair adjustment
 * carried at fill are preserved; an unread leg counts at its fill fair
 * (coverage says how much was re-read). ev uses the SAME stake/odds as
 * meta.expectedValue: (1-p)*S - p*R, S = R*q/(1-q), q = meta.offeredImpliedProb.
 *
 * Settlement fallback (/ev-curve): no meta.gameTime -> the closing-line snapshot
 * (main ML/spread/total only) when every leg has one, else the fill EV.
 *
 * Reads are in-memory cache reads (no TOA request unless an alt line misses its
 * cache), capped per tick, nearest start first. Persisted when a leg freezes,
 * on an order's first live read, and otherwise at most every
 * EV_LIVE_PERSIST_MIN (15). Never throws; never on the RFQ hot path.
 */
const log = require('./logger');

const _stats = { ticks: 0, liveReads: 0, readFailures: 0, legsFrozen: 0, legsMissed: 0, finalized: 0, saved: 0, capped: 0,
  lastError: null, lastTickAt: null, lastTickMs: null };
let _timer = null;
let _running = false;

const envNum = (k, d, min = 0) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v >= min ? v : d; };
const enabled = () => process.env.GAMETIME_EV_ENABLED !== 'false';
const freezeLeadMs = () => envNum('EV_LIVE_FREEZE_LEAD_SEC', 90, 0) * 1000;
const refreshMs = () => envNum('EV_LIVE_REFRESH_SEC', 300, 30) * 1000;
const fastWindowMs = () => envNum('EV_LIVE_FAST_MIN', 30, 0) * 60000;
const persistMs = () => envNum('EV_LIVE_PERSIST_MIN', 15, 1) * 60000;
const maxReads = () => envNum('EV_LIVE_MAX_READS', 600, 10);
// A leg first seen this long AFTER its start can no longer be read (the line
// de-registers at start) — recorded as missed.
const graceMs = () => envNum('GAMETIME_EV_GRACE_SEC', 90, 30) * 1000;

function _round(x, d = 5) { return x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d; }

/** EV on our side for bettor-win prob p, same convention as meta.expectedValue. */
function evAt(order, p) {
  const risk = Number(order.confirmedStake) || 0;
  const q = Number(order.meta && order.meta.offeredImpliedProb);
  if (!(risk > 0) || !(q > 0 && q < 1) || !(p >= 0 && p <= 1)) return null;
  const stake = risk * q / (1 - q);
  return (1 - p) * stake - p * risk;
}

/** Combine leg reads into the ticket's fair / EV (see header). */
function combine(order, legReads) {
  const legs = (order.meta && order.meta.legs) || [];
  const fill = Number(order.fairParlayProb != null ? order.fairParlayProb : order.meta && order.meta.fairParlayProb);
  if (!(fill > 0 && fill < 1) || !legs.length) return null;
  let ratio = 1, captured = 0;
  for (const l of legs) {
    const g = legReads[l.lineId];
    if (g && g.fair > 0 && g.fair < 1 && l.fairProb > 0 && l.fairProb < 1) { ratio *= g.fair / l.fairProb; captured++; }
  }
  const p = Math.min(0.999, Math.max(0.000001, fill * ratio));
  return { fairProb: _round(p, 6), ev: _round(evAt(order, p), 2), coverage: _round(captured / legs.length, 3) };
}

async function _readLeg(leg) {
  const pricer = require('./pricer');
  let res = null;
  try { res = await pricer.priceParlay([leg.lineId], { fairOnly: true, skipTemplateRamp: true }); } catch (e) { res = null; }
  const hit = res && res.fairOnly && res.legs && res.legs[0];
  if (!hit || !(hit.fairProb > 0 && hit.fairProb < 1)) {
    const f = pricer.getLastPriceFailure ? pricer.getLastPriceFailure() : null;
    return { fair: null, reason: (f && f.reason) || 'no fair' };
  }
  return { fair: _round(hit.fairProb, 5), src: hit.fairSource || null, mirror: !!hit.mirror, ageSec: hit.ageSec != null ? hit.ageSec : null };
}

/** One pass over open fills. Exported for tests. */
async function tick(nowMs = Date.now()) {
  if (_running) return;
  _running = true;
  const t0 = Date.now();
  _stats.ticks++; _stats.lastTickAt = new Date(nowMs).toISOString();
  try {
    const orderTracker = require('./order-tracker');
    // Open fills AND fills settled in the last 48 h that still have legs to
    // freeze — a ticket that died early on a lost leg keeps being graded, so the
    // leak sample is not only tickets the bettor was still alive on.
    const open = orderTracker.getEvLiveCandidates ? orderTracker.getEvLiveCandidates(nowMs)
      : (orderTracker.getOpenConfirmedOrders ? orderTracker.getOpenConfirmedOrders() : []);
    // Work list of (order, leg) pairs still unfrozen, nearest start first.
    const work = [];
    for (const order of open) {
      const legs = (order.meta && order.meta.legs) || [];
      if (!legs.length || (order.meta.gameTime && order.meta.gameTime.finalizedAt)) continue;
      const lv = order.meta.evLive || (order.meta.evLive = { legs: {} });
      for (const l of legs) {
        if (!l.lineId) continue;
        const cur = lv.legs[l.lineId];
        if (cur && cur.frozen) continue;
        const start = Date.parse(l.startTime || '');
        work.push({ order, leg: l, start, cur });
      }
    }
    work.sort((a, b) => (Number.isFinite(a.start) ? a.start : Infinity) - (Number.isFinite(b.start) ? b.start : Infinity));
    const touched = new Map();   // order -> { froze, firstRead }
    let reads = 0;
    for (const w of work) {
      const { order, leg: l, start, cur } = w;
      const lv = order.meta.evLive;
      const mark = touched.get(order) || { froze: false, firstRead: false, changed: false };
      touched.set(order, mark);
      if (!Number.isFinite(start)) { lv.legs[l.lineId] = { fair: null, reason: 'no start time', frozen: true }; mark.froze = true; continue; }
      const until = start - nowMs;
      if (until <= freezeLeadMs()) {
        // FREEZE: the last pre-start read stands; with none yet, read once now (if the line can still be read).
        if (cur && cur.fair != null) {
          lv.legs[l.lineId] = Object.assign({}, cur, { frozen: true, frozenAt: new Date(nowMs).toISOString() });
        } else if (until < -graceMs()) {
          lv.legs[l.lineId] = { fair: null, reason: 'missed (started before any read)', frozen: true };
          _stats.legsMissed++;
        } else if (reads < maxReads()) {
          const s = await _readLeg(l); reads++; _stats.liveReads++;
          if (s.fair == null) _stats.readFailures++;
          lv.legs[l.lineId] = Object.assign(s, { minsToStart: _round(until / 60000, 2), at: new Date(nowMs).toISOString(), frozen: true });
        } else { _stats.capped++; continue; }
        _stats.legsFrozen++; mark.froze = true; mark.changed = true;
        continue;
      }
      // LIVE: re-read when due — every refresh interval, every tick inside the fast window.
      const lastAt = cur && cur.at ? Date.parse(cur.at) : NaN;
      const interval = until <= fastWindowMs() ? 0 : refreshMs();
      if (Number.isFinite(lastAt) && nowMs - lastAt < interval) continue;
      if (reads >= maxReads()) { _stats.capped++; continue; }
      const s = await _readLeg(l); reads++; _stats.liveReads++;
      if (s.fair == null) {
        _stats.readFailures++;
        // keep the last good read; note why this one failed
        if (cur && cur.fair != null) { cur.lastFailure = s.reason; cur.lastFailureAt = new Date(nowMs).toISOString(); continue; }
      }
      if (!cur) mark.firstRead = true;
      lv.legs[l.lineId] = Object.assign(s, { minsToStart: _round(until / 60000, 2), at: new Date(nowMs).toISOString(), frozen: false });
      mark.changed = true;
    }
    const db = require('./db');
    for (const [order, mark] of touched) {
      const legs = order.meta.legs || [];
      const lv = order.meta.evLive;
      if (mark.changed) {
        const c = combine(order, lv.legs);
        if (c) Object.assign(lv, c);
        lv.updatedAt = new Date(nowMs).toISOString();
      }
      const allFrozen = legs.every(l => !l.lineId || (lv.legs[l.lineId] && lv.legs[l.lineId].frozen));
      if (allFrozen && !(order.meta.gameTime && order.meta.gameTime.finalizedAt)) {
        // GAME TIME = the frozen EV live.
        const gtLegs = {};
        const fillP = Number(order.fairParlayProb != null ? order.fairParlayProb : order.meta.fairParlayProb);
        const evFill = evAt(order, fillP);
        const confMs = Date.parse(order.confirmedAt || '');
        for (const l of legs) {
          if (!l.lineId) continue;
          const r = lv.legs[l.lineId];
          const e = Object.assign({}, r, { fillFair: l.fairProb != null ? l.fairProb : null });
          // PER-LEG LEAK (2026-10-21, operator: "make sure we are not leaking much
          // value on any legs"): drift = game-time fair / fill fair - 1 from the
          // bettor's side (> 0 = moved against us); evDelta = the EV this leg ALONE
          // moved the ticket (> 0 = we lost EV). Fill context kept for attribution.
          if (r && r.fair > 0 && l.fairProb > 0 && Number.isFinite(evFill)) {
            // drift vs the pre-correction fair when a leg-drift correction was applied
            const _pre = (l.legDriftCorr && l.legDriftCorr.preFair > 0) ? l.legDriftCorr.preFair : l.fairProb;
            e.drift = _round(r.fair / _pre - 1, 5);
            const evOne = evAt(order, Math.min(0.999, fillP * r.fair / l.fairProb));
            if (Number.isFinite(evOne)) e.evDelta = _round(evFill - evOne, 2);
          }
          const st = Date.parse(l.startTime || '');
          if (Number.isFinite(st) && Number.isFinite(confMs)) e.hrsToStartAtFill = _round((st - confMs) / 3600000, 2);
          if (l.inputAgeSec != null) e.inputAgeAtFill = l.inputAgeSec;
          if (l.fairSource) e.fairSourceAtFill = l.fairSource;
          gtLegs[l.lineId] = e;
        }
        const c = combine(order, gtLegs) || {};
        order.meta.gameTime = Object.assign({ legs: gtLegs }, c, { finalizedAt: new Date(nowMs).toISOString() });
        lv.frozenAt = order.meta.gameTime.finalizedAt;
        _stats.finalized++;
      }
      const lastPersist = lv.persistedAt ? Date.parse(lv.persistedAt) : 0;
      if (mark.froze || mark.firstRead || (mark.changed && nowMs - lastPersist >= persistMs())) {
        lv.persistedAt = new Date(nowMs).toISOString();
        try { db.saveOrder(order).then(() => { _stats.saved++; }).catch(() => {}); } catch (_) { /* best effort */ }
      }
    }
  } catch (e) {
    _stats.lastError = e.message;
    log.debug('EvLive', `tick failed: ${e.message}`);
  } finally {
    _running = false;
    _stats.lastTickMs = Date.now() - t0;
  }
}

function start() {
  if (_timer || !enabled()) return;
  const sec = Math.max(20, Number(process.env.GAMETIME_EV_SEC) || 45);
  _timer = setInterval(() => { tick().catch(() => {}); }, sec * 1000);
  if (_timer.unref) _timer.unref();
}

function getStatus() {
  return { enabled: enabled(), freezeLeadSec: freezeLeadMs() / 1000, refreshSec: refreshMs() / 1000, fastWindowMin: fastWindowMs() / 60000,
    graceSec: graceMs() / 1000, maxReadsPerTick: maxReads(), running: _running, ..._stats };
}

/**
 * Open-book EV fill vs EV live right now (dashboard header / /rfq-ev-leak).
 * Only fills with an EV-live read count in the live total; `unread` = open fills
 * not yet graded (new since the last tick, or every leg failed to read).
 */
function openBookSummary() {
  const orderTracker = require('./order-tracker');
  const open = orderTracker.getOpenConfirmedOrders ? orderTracker.getOpenConfirmedOrders() : [];
  let n = 0, graded = 0, evFill = 0, evLive = 0, evFillGraded = 0, frozen = 0;
  for (const o of open) {
    const ef = Number(o.expectedValue != null ? o.expectedValue : o.meta && o.meta.expectedValue);
    if (!Number.isFinite(ef)) continue;
    n++; evFill += ef;
    const lv = o.meta && o.meta.evLive;
    if (lv && Number.isFinite(lv.ev) && lv.coverage > 0) { graded++; evLive += lv.ev; evFillGraded += ef; if (lv.frozenAt) frozen++; }
  }
  const r2 = v => Math.round(v * 100) / 100;
  return { openFills: n, graded, unread: n - graded, frozen, evFill: r2(evFill), evFillGraded: r2(evFillGraded), evLive: r2(evLive),
    change: r2(evLive - evFillGraded), changePctOfEvFill: evFillGraded ? r2(100 * (evLive - evFillGraded) / Math.abs(evFillGraded)) : null };
}

/**
 * The game-time EV a settled/open ticket should be charted at, and where it came
 * from: 'gametime' (meta.gameTime, finalized), 'close' (every leg has a closing
 * snapshot), else 'fill'. Used by /ev-curve.
 */
function gameTimeEvFor(order, fillEv) {
  const gt = order.meta && order.meta.gameTime;
  if (gt && gt.finalizedAt && gt.ev != null && Number.isFinite(gt.ev)) return { ev: gt.ev, source: 'gametime', coverage: gt.coverage };
  const legs = (order.legs || (order.meta && order.meta.legs) || []);
  const fill = Number(order.fairParlayProb != null ? order.fairParlayProb : order.meta && order.meta.fairParlayProb);
  if (legs.length && fill > 0 && legs.every(l => l.closingImpliedProb > 0 && l.fairProb > 0)) {
    let ratio = 1;
    for (const l of legs) ratio *= l.closingImpliedProb / l.fairProb;
    const ev = evAt(order, Math.min(0.999, fill * ratio));
    if (ev != null) return { ev, source: 'close', coverage: 1 };
  }
  return { ev: fillEv, source: 'fill', coverage: 0 };
}

module.exports = { tick, start, getStatus, combine, evAt, gameTimeEvFor, openBookSummary };
