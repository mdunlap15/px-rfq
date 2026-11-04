// Per-arm read-out for any pricer A/B that stamps meta.<name>Arm (2026-11-04,
// built with the cross-game widen A/B: `GET /ab-arm-metrics?arm=xgWidenArm`).
// Pure function over parlay_orders rows so it is testable without the DB.
//
// Per arm: quotes (sampled unfilled quotes re-weighted by db.quoteRowWeight),
// real fills (order_uuid on a confirmed row, or settled — same gate as
// /v2-ab-metrics), fill rate, risk, EV at fill, EV live (the /ev-fill-live
// convention: frozen game-time EV, else the current EV live when it covers a
// leg, else the closing-line EV, else EV fill — `evLiveSources` counts each),
// settled P&L, and calibration: bettor hits vs the sum of fair on settled
// won/lost tickets with no voided leg. Fair for calibration is the RAW joint
// fair (xgFactorPreFair / twoLegFactorPreFair when a selection factor
// multiplied it), as the factor docs require.

const ARM_KEY_RE = /^[A-Za-z0-9]{1,40}Arm$/;

function isRealFill(r) {
  return (r.status === 'confirmed' && r.order_uuid != null)
    || (typeof r.status === 'string' && r.status.startsWith('settled_'));
}

function rawFair(r) {
  const m = r.meta || {};
  if (m.xgFactorApplied && m.xgFactorPreFair > 0) return Number(m.xgFactorPreFair);
  if (m.twoLegFactorApplied && m.twoLegFactorPreFair > 0) return Number(m.twoLegFactorPreFair);
  const f = r.fair_parlay_prob != null ? Number(r.fair_parlay_prob) : Number(m.fairParlayProb);
  return Number.isFinite(f) && f > 0 && f < 1 ? f : null;
}

function hasVoidLeg(r) {
  const legs = (r.meta && r.meta.legs) || r.legs || [];
  return legs.some(l => /void|push|cancel/i.test(String(l.settlementStatus || l.settlement_status || l.status || '')));
}

function evLiveOf(r) {
  const m = r.meta || {};
  if (m.gameTime && m.gameTime.finalizedAt && Number.isFinite(m.gameTime.ev)) return { ev: m.gameTime.ev, src: 'gametime' };
  if (m.evLive && Number.isFinite(m.evLive.ev) && m.evLive.coverage > 0) return { ev: m.evLive.ev, src: 'live' };
  const f = Number(m.expectedValue);
  if (!Number.isFinite(f)) return null;
  // order-shaped view of the DB row for gametime-ev (camelCase fields).
  const o = { meta: m, legs: r.legs, fairParlayProb: r.fair_parlay_prob, confirmedStake: r.confirmed_stake };
  const g = require('./gametime-ev').gameTimeEvFor(o, f);
  return g.source === 'close' && Number.isFinite(g.ev) ? { ev: g.ev, src: 'close' } : { ev: f, src: 'fill' };
}

function summarizeArms(rows, armKey, quoteRowWeight = () => 1) {
  if (!ARM_KEY_RE.test(String(armKey || ''))) throw new Error('arm must look like <name>Arm');
  const r2 = v => Math.round(v * 100) / 100;
  const out = {};
  for (const r of rows || []) {
    const arm = r.meta && r.meta[armKey];
    if (arm == null) continue;
    const a = out[arm] || (out[arm] = { quotes: 0, fills: 0, risk: 0, evFill: 0, evLive: 0,
      evLiveSources: { gametime: 0, live: 0, close: 0, fill: 0 }, settledN: 0, pnl: 0, settledRisk: 0,
      calibN: 0, hits: 0, expHits: 0, _var: 0, _mSum: 0, _mW: 0 });
    const w = quoteRowWeight(r);
    a.quotes += w;
    const fair = rawFair(r);
    const off = Number(r.meta.offeredImpliedProb);
    if (fair && off > 0) { a._mSum += w * (off / fair - 1); a._mW += w; }
    if (!isRealFill(r)) continue;
    const risk = Number(r.confirmed_stake) || 0;
    a.fills++; a.risk += risk;
    const evf = Number(r.meta.expectedValue);
    if (Number.isFinite(evf)) a.evFill += evf;
    const el = evLiveOf(r);
    if (el) { a.evLive += el.ev; a.evLiveSources[el.src]++; }
    if (typeof r.status === 'string' && r.status.startsWith('settled_')) {
      a.settledN++; a.pnl += Number(r.pnl) || 0; a.settledRisk += risk;
      if ((r.status === 'settled_won' || r.status === 'settled_lost') && fair && !hasVoidLeg(r)) {
        a.calibN++; a.expHits += fair; a._var += fair * (1 - fair);
        if (r.status === 'settled_lost') a.hits++;   // settled_lost = the bettor won
      }
    }
  }
  for (const a of Object.values(out)) {
    a.quotes = Math.round(a.quotes);
    a.fillRatePct = a.quotes > 0 ? Math.round(10000 * a.fills / a.quotes) / 100 : null;
    a.avgMarginOverFairPct = a._mW > 0 ? Math.round(10000 * a._mSum / a._mW) / 100 : null;
    a.evFillPerRiskPct = a.risk > 0 ? Math.round(10000 * a.evFill / a.risk) / 100 : null;
    a.pnlPerRiskPct = a.settledRisk > 0 ? Math.round(10000 * a.pnl / a.settledRisk) / 100 : null;
    a.hitsOverFair = a.expHits > 0 ? Math.round(1000 * a.hits / a.expHits) / 1000 : null;
    a.hitsZ = a._var > 0 ? Math.round(100 * (a.hits - a.expHits) / Math.sqrt(a._var)) / 100 : null;
    a.expHits = Math.round(a.expHits * 10) / 10;
    for (const k of ['risk', 'evFill', 'evLive', 'pnl', 'settledRisk']) a[k] = r2(a[k]);
    delete a._var; delete a._mSum; delete a._mW;
  }
  return out;
}

module.exports = { summarizeArms, isRealFill, rawFair, ARM_KEY_RE };
