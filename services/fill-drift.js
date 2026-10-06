/**
 * Fill drift — how far the market moved against us after a fill (2026-10-06).
 *
 * Operator: "We need to be just as aggressively monitoring the lines we use for
 * the RFQs" as the order book, whose guards re-grade every resting offer ~3x a
 * minute and fair_sync re-grades open positions every 5 min. RFQ never rests an
 * offer (each RFQ is priced fresh, quotes live 60s / 30s props), so the question
 * for RFQ is different: were we priced off data the market had ALREADY left?
 * That shows up as the fair moving against us right after the fill.
 *
 * For every accepted confirm: re-price the same legs at +5 and +30 minutes with
 * the confirm-time reprice call (priceParlay, skipTemplateRamp — no exposure or
 * template side effects) and record the bettor-side fair then vs at the quote.
 * Positive drift = the bettor's side got MORE likely = the market moved against
 * us. Stored on order.meta.fillDrift with each leg's input age at quote time, so
 * pick-offs can be tied to stale inputs. One DB write per fill (after +30m).
 * Timers die with the process — a restart drops in-flight measurements (logged
 * counts on /fill-drift), which is acceptable for a measurement.
 */
const log = require('./logger');

const CHECKPOINTS = [
  { key: 'm5', ms: 5 * 60e3 },
  { key: 'm30', ms: 30 * 60e3 },
];

const _pending = new Map();   // parlayId -> { timers: [], startedAt }
const _stats = { tracked: 0, completed: 0, snapshotFailures: 0, saved: 0 };

function _round(x, d = 5) { return x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d; }

async function _snapshot(order) {
  const pricer = require('./pricer');
  const legIds = (order.meta && order.meta.legs || []).map(l => l.lineId).filter(Boolean);
  if (!legIds.length) return { at: new Date().toISOString(), reason: 'no legs' };
  let res = null;
  try { res = await pricer.priceParlay(legIds, { skipTemplateRamp: true }); } catch (e) { res = null; }
  if (!res || !res.meta) {
    const f = pricer.getLastPriceFailure ? pricer.getLastPriceFailure() : null;
    _stats.snapshotFailures++;
    return { at: new Date().toISOString(), reason: (f && f.reason) || 'reprice failed' };
  }
  const now = res.meta.fairParlayProb;
  const was = order.fairParlayProb != null ? order.fairParlayProb : order.meta.fairParlayProb;
  const legs = (res.meta.legs || []).map(l => {
    const q = (order.meta.legs || []).find(x => x.lineId === l.lineId) || {};
    return {
      lineId: l.lineId,
      fair: _round(l.fairProb, 4),
      drift: q.fairProb > 0 && l.fairProb > 0 ? _round(l.fairProb / q.fairProb - 1, 4) : null,
    };
  });
  return {
    at: new Date().toISOString(),
    fair: _round(now),
    drift: was > 0 && now > 0 ? _round(now / was - 1, 4) : null,
    legs,
  };
}

/** Start measuring a just-accepted fill. Never throws, never blocks the confirm. */
function track(parlayId) {
  try {
    if (!parlayId || _pending.has(parlayId)) return;
    const orderTracker = require('./order-tracker');
    const order = orderTracker.findByParlayId(parlayId);
    if (!order || !order.meta || !Array.isArray(order.meta.legs)) return;
    order.meta.fillDrift = {
      quotedFair: _round(order.fairParlayProb != null ? order.fairParlayProb : order.meta.fairParlayProb),
      inputAgeSec: order.meta.legs.map(l => ({ lineId: l.lineId, market: l.market, ageSec: l.inputAgeSec != null ? l.inputAgeSec : null })),
      confirmedAt: order.confirmedAt || new Date().toISOString(),
    };
    const entry = { timers: [], startedAt: Date.now() };
    _pending.set(parlayId, entry);
    _stats.tracked++;
    CHECKPOINTS.forEach((cp, i) => {
      const t = setTimeout(async () => {
        try {
          const o = orderTracker.findByParlayId(parlayId) || order;
          const snap = await _snapshot(o);
          o.meta.fillDrift = o.meta.fillDrift || {};
          o.meta.fillDrift[cp.key] = snap;
          if (i === CHECKPOINTS.length - 1) {
            _pending.delete(parlayId);
            _stats.completed++;
            try { require('./db').saveOrder(o).then(() => { _stats.saved++; }).catch(() => {}); } catch (_) { /* best effort */ }
          }
        } catch (e) {
          log.debug('FillDrift', `${parlayId} ${cp.key} snapshot threw: ${e.message}`);
          if (i === CHECKPOINTS.length - 1) _pending.delete(parlayId);
        }
      }, cp.ms);
      if (t.unref) t.unref();
      entry.timers.push(t);
    });
  } catch (e) {
    log.debug('FillDrift', `track(${parlayId}) skipped: ${e.message}`);
  }
}

function getStats() { return { ..._stats, pending: _pending.size }; }

/**
 * Aggregate fillDrift rows (from parlay_orders meta). Legs are graded from the
 * bettor's side: drift > 0 = moved against us. Buckets by sport, market family
 * (prop vs game line) and input age at quote.
 */
function summarize(orders) {
  const out = { fills: 0, withM5: 0, withM30: 0, legs: {} };
  const famOf = m => /^player_/.test(m || '') ? 'prop' : /^mov_|^outright|series/.test(m || '') ? 'special' : 'game';
  const ageBucket = s => s == null ? 'unknown' : s <= 120 ? '<=2m' : s <= 300 ? '2-5m' : s <= 900 ? '5-15m' : s <= 1800 ? '15-30m' : '>30m';
  for (const o of orders) {
    const fd = o.meta && o.meta.fillDrift;
    if (!fd) continue;
    out.fills++;
    if (fd.m5 && fd.m5.fair != null) out.withM5++;
    if (fd.m30 && fd.m30.fair != null) out.withM30++;
    const legsMeta = (o.meta.legs || []);
    for (const l of legsMeta) {
      const sport = l.sport || (o.legs || []).find(x => x.lineId === l.lineId)?.sport || '?';
      const age = (fd.inputAgeSec || []).find(x => x.lineId === l.lineId);
      const k = `${sport}|${famOf(l.market)}|${ageBucket(age ? age.ageSec : null)}`;
      const b = out.legs[k] || (out.legs[k] = { n5: 0, sum5: 0, against2_5: 0, n30: 0, sum30: 0, against2_30: 0 });
      const d5 = fd.m5 && (fd.m5.legs || []).find(x => x.lineId === l.lineId);
      const d30 = fd.m30 && (fd.m30.legs || []).find(x => x.lineId === l.lineId);
      if (d5 && d5.drift != null) { b.n5++; b.sum5 += d5.drift; if (d5.drift > 0.02) b.against2_5++; }
      if (d30 && d30.drift != null) { b.n30++; b.sum30 += d30.drift; if (d30.drift > 0.02) b.against2_30++; }
    }
  }
  const rows = Object.entries(out.legs).map(([k, b]) => {
    const [sport, family, age] = k.split('|');
    return {
      sport, family, inputAge: age, legs5: b.n5,
      meanDrift5Pct: b.n5 ? _round(100 * b.sum5 / b.n5, 2) : null,
      shareAgainst2pct5: b.n5 ? _round(b.against2_5 / b.n5, 3) : null,
      legs30: b.n30,
      meanDrift30Pct: b.n30 ? _round(100 * b.sum30 / b.n30, 2) : null,
      shareAgainst2pct30: b.n30 ? _round(b.against2_30 / b.n30, 3) : null,
    };
  }).sort((a, b) => (b.legs5 || 0) - (a.legs5 || 0));
  return { fills: out.fills, withM5: out.withM5, withM30: out.withM30, rows };
}

module.exports = { track, getStats, summarize, _snapshot, CHECKPOINTS };
