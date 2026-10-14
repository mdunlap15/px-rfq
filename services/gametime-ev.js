/**
 * Game-time EV (2026-10-13).
 *
 * Operator: EV should be defined "not [as] what EV was at fill time but what it
 * was at gametime, because as we've seen with the PX order book measurements of
 * EV filled and EV live, the EV live is often much lower than when filled."
 *
 * For every open fill, each leg's fair is re-read just before THAT leg's start
 * (GAMETIME_EV_LEAD_SEC, default 120 s) with the quote path's own leg-fair
 * resolution (pricer.priceParlay(..., {fairOnly:true}) — order-book relay,
 * calibration, mirrors; staleness recorded as the input's age, not declined).
 * When every leg has a snapshot (or has been missed — e.g. the trader was
 * restarted across its start), the ticket gets:
 *
 *   meta.gameTime = { legs: {lineId: {fair, fillFair, src, ageSec, minsToStart, at} | {fair:null, reason}},
 *                     fairProb, ev, coverage, finalizedAt }
 *
 * fairProb = fill fairParlayProb x PRODUCT(gameTimeLegFair / fillLegFair) over the
 * legs that were captured — so the SGP correlation factor and any parlay-level
 * fair adjustment carried at fill are preserved, and an uncaptured leg counts at
 * its fill fair (coverage says how much of the ticket was actually re-read).
 * ev uses the SAME stake/odds as meta.expectedValue: (1-p)*S - p*R with
 * S = R*q/(1-q), q = meta.offeredImpliedProb.
 *
 * Settlement fallback (order-tracker / /ev-curve): a ticket with no meta.gameTime
 * uses the closing-line snapshot (leg.closingImpliedProb, main ML/spread/total
 * only) when every leg has one, else its fill EV — and /ev-curve reports how
 * many tickets came from each source.
 *
 * Persisted on every leg snapshot (so a restart keeps what was read) and at
 * finalize. Never throws; never on the
 * RFQ hot path (its own timer).
 */
const log = require('./logger');

const _stats = { ticks: 0, legsCaptured: 0, legsMissed: 0, legsFailed: 0, finalized: 0, saved: 0, lastError: null, lastTickAt: null };
let _timer = null;
let _running = false;

const enabled = () => process.env.GAMETIME_EV_ENABLED !== 'false';
const leadMs = () => Math.max(30, Number(process.env.GAMETIME_EV_LEAD_SEC) || 120) * 1000;
// A leg first seen this long AFTER its start can no longer be re-read (the line
// de-registers at start) — it is recorded as missed.
const graceMs = () => Math.max(30, Number(process.env.GAMETIME_EV_GRACE_SEC) || 90) * 1000;

function _round(x, d = 5) { return x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d; }

/** EV on our side for bettor-win prob p, same convention as meta.expectedValue. */
function evAt(order, p) {
  const risk = Number(order.confirmedStake) || 0;
  const q = Number(order.meta && order.meta.offeredImpliedProb);
  if (!(risk > 0) || !(q > 0 && q < 1) || !(p >= 0 && p <= 1)) return null;
  const stake = risk * q / (1 - q);
  return (1 - p) * stake - p * risk;
}

/** Combine leg snapshots into the ticket's game-time fair (see header). */
function combine(order, gtLegs) {
  const legs = (order.meta && order.meta.legs) || [];
  const fill = Number(order.fairParlayProb != null ? order.fairParlayProb : order.meta && order.meta.fairParlayProb);
  if (!(fill > 0 && fill < 1) || !legs.length) return null;
  let ratio = 1, captured = 0;
  for (const l of legs) {
    const g = gtLegs[l.lineId];
    if (g && g.fair > 0 && g.fair < 1 && l.fairProb > 0 && l.fairProb < 1) { ratio *= g.fair / l.fairProb; captured++; }
  }
  const p = Math.min(0.999, Math.max(0.000001, fill * ratio));
  return { fairProb: _round(p, 6), ev: _round(evAt(order, p), 2), coverage: _round(captured / legs.length, 3) };
}

async function _snapLeg(leg) {
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
  _stats.ticks++; _stats.lastTickAt = new Date(nowMs).toISOString();
  try {
    const orderTracker = require('./order-tracker');
    const open = orderTracker.getOpenConfirmedOrders ? orderTracker.getOpenConfirmedOrders() : [];
    for (const order of open) {
      const legs = (order.meta && order.meta.legs) || [];
      if (!legs.length || (order.meta.gameTime && order.meta.gameTime.finalizedAt)) continue;
      const gt = order.meta.gameTime || (order.meta.gameTime = { legs: {} });
      let changed = false;
      for (const l of legs) {
        if (!l.lineId || gt.legs[l.lineId]) continue;
        const start = Date.parse(l.startTime || '');
        if (!Number.isFinite(start)) { gt.legs[l.lineId] = { fair: null, reason: 'no start time' }; changed = true; continue; }
        const until = start - nowMs;
        if (until > leadMs()) continue;                       // not yet
        if (until < -graceMs()) {                             // started before we could read it
          gt.legs[l.lineId] = { fair: null, reason: 'missed (started before snapshot)', fillFair: l.fairProb != null ? l.fairProb : null };
          _stats.legsMissed++; changed = true; continue;
        }
        const s = await _snapLeg(l);
        gt.legs[l.lineId] = Object.assign(s, { fillFair: l.fairProb != null ? l.fairProb : null, minsToStart: _round(until / 60000, 2), at: new Date(nowMs).toISOString() });
        if (s.fair != null) _stats.legsCaptured++; else _stats.legsFailed++;
        changed = true;
      }
      if (legs.every(l => !l.lineId || gt.legs[l.lineId])) {
        const c = combine(order, gt.legs);
        if (c) Object.assign(gt, c);
        gt.finalizedAt = new Date(nowMs).toISOString();
        _stats.finalized++;
        try { require('./db').saveOrder(order).then(() => { _stats.saved++; }).catch(() => {}); } catch (_) { /* best effort */ }
      } else if (changed) {
        // partial: persist so a restart keeps the legs already read
        try { require('./db').saveOrder(order).catch(() => {}); } catch (_) { /* best effort */ }
      }
    }
  } catch (e) {
    _stats.lastError = e.message;
    log.debug('GameTimeEV', `tick failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer || !enabled()) return;
  const sec = Math.max(20, Number(process.env.GAMETIME_EV_SEC) || 45);
  _timer = setInterval(() => { tick().catch(() => {}); }, sec * 1000);
  if (_timer.unref) _timer.unref();
}

function getStatus() { return { enabled: enabled(), leadSec: leadMs() / 1000, graceSec: graceMs() / 1000, running: _running, ..._stats }; }

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

module.exports = { tick, start, getStatus, combine, evAt, gameTimeEvFor };
