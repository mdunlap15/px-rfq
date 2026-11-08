// Per-creator ticket-size tiers (2026-11-07, operator: "make the changes we need
// to be able to win").
//
// Why. Since 2026-07-19 our tickets of $500+ risk lost $45K while those under
// $500 made +$2.7K; five creators alone were -$46.9K and the rest of the $500+
// book was flat. Other SPs' large game-line tickets graded PROFITABLE over the
// same weeks (bettors hit 0.75-0.89x their price), so the leak is who we size
// up, not size itself. Replayed over Apr-Nov settled fills (stats only from
// tickets settled before each confirm): new < 10 settled -> $500, sharp
// (>= 10 settled, z >= 1.5) -> $100 turned Jul 19-now from -$42.2K to -$15.7K,
// with the prop $500 cap -$8.9K; Apr-Jul 18 stayed positive.
//
// Tier from this creator's settled won/lost tickets (no voided leg) in the
// in-memory book: z = (bettor hits - sum fair) / sqrt(sum fair(1-fair)).
//   sharp   n >= sharpMinN and z >= sharpZ        -> creatorTierSharpMaxRisk
//   new     n <  trustMinSettled (incl. unknown)  -> creatorTierNewMaxRisk
//   trusted otherwise                              -> no extra cap
// Fair = the RAW joint fair (factor pre-fair when a selection factor applied).
// Applied as one more candidate cap at quote time (when PX sends creator_id)
// and at confirm (creator resolved via meta / REST; unresolvable = 'new').

const { config } = require('../config');
const log = require('./logger');

let _stats = new Map();   // creatorId -> { n, hits, exp, var, pnl }
let _builtAt = null;
let _timer = null;

function _rawFair(o) {
  const m = o.meta || {};
  if (m.xgFactorApplied && m.xgFactorPreFair > 0) return Number(m.xgFactorPreFair);
  if (m.twoLegFactorApplied && m.twoLegFactorPreFair > 0) return Number(m.twoLegFactorPreFair);
  const f = Number(o.fairParlayProb != null ? o.fairParlayProb : m.fairParlayProb);
  return Number.isFinite(f) && f > 0 && f < 1 ? f : null;
}

function _hasVoidLeg(o) {
  const legs = o.legs || (o.meta && o.meta.legs) || [];
  return legs.some(l => /void|push|cancel/i.test(String(l.settlementStatus || l.settlement_status || '')));
}

function _creatorOf(o) {
  const m = o.meta || {};
  return m.creatorId || m.creator_id || null;
}

/** Build per-creator stats from an array of orders (pure; exported for tests). */
function buildStats(orders) {
  const st = new Map();
  for (const o of orders || []) {
    if (o.status !== 'settled_won' && o.status !== 'settled_lost') continue;
    const c = _creatorOf(o);
    if (!c || _hasVoidLeg(o)) continue;
    const f = _rawFair(o);
    if (f == null) continue;
    const s = st.get(c) || { n: 0, hits: 0, exp: 0, var: 0, pnl: 0 };
    s.n++; s.exp += f; s.var += f * (1 - f);
    if (o.status === 'settled_lost') s.hits++;   // settled_lost = the bettor won
    s.pnl += Number(o.pnl) || 0;
    st.set(c, s);
  }
  return st;
}

function refresh(nowMs = Date.now()) {
  try {
    const days = Number(config.pricing.creatorTierDays) || 365;
    const orderTracker = require('./order-tracker');
    const orders = orderTracker.getConfirmedOrdersSince ? orderTracker.getConfirmedOrdersSince(nowMs - days * 864e5) : [];
    _stats = buildStats(orders);
    _builtAt = new Date(nowMs).toISOString();
  } catch (e) {
    log.warn('CreatorTier', `refresh failed: ${e.message}`);
  }
}

/** Tier + extra risk cap (Infinity = none) for a creator id (null = unknown). */
function tierFor(creatorId, stats) {
  const p = config.pricing || {};
  if (p.creatorTierEnabled === false) return { tier: 'off', cap: Infinity };
  if (!stats) {
    // Lazy first build (and a stale-table backstop) so a boot never sizes
    // every creator as new while waiting for the timer.
    if (!_builtAt || (_builtAt !== 'test' && Date.now() - Date.parse(_builtAt) > 30 * 60e3)) refresh();
    stats = _stats;
  }
  const s = creatorId ? stats.get(String(creatorId)) : null;
  const n = s ? s.n : 0;
  const z = s && s.var > 0 ? (s.hits - s.exp) / Math.sqrt(s.var) : 0;
  const ex = Array.isArray(p.creatorTierExempt) ? p.creatorTierExempt : [];
  if (creatorId && ex.some(e => e && String(creatorId).startsWith(String(e)))) return { tier: 'exempt', cap: Infinity, n, z };
  const sharpMinN = Number(p.creatorTierSharpMinN) || 10;
  const sharpZ = Number.isFinite(Number(p.creatorTierSharpZ)) ? Number(p.creatorTierSharpZ) : 1.5;
  if (n >= sharpMinN && z >= sharpZ) return { tier: 'sharp', cap: Number(p.creatorTierSharpMaxRisk) || 100, n, z };
  if (n < (Number(p.creatorTierTrustMinSettled) || 10)) return { tier: creatorId ? 'new' : 'unknown', cap: Number(p.creatorTierNewMaxRisk) || 500, n, z };
  return { tier: 'trusted', cap: Infinity, n, z };
}

function start() {
  if (_timer) return;
  setTimeout(() => refresh(), 90e3).unref?.();
  _timer = setInterval(() => refresh(), 10 * 60e3);
  if (_timer.unref) _timer.unref();
}

function summary() {
  const counts = { sharp: 0, trusted: 0, new: 0, exempt: 0 };
  for (const c of _stats.keys()) counts[tierFor(c).tier] = (counts[tierFor(c).tier] || 0) + 1;
  const p = config.pricing || {};
  return { enabled: p.creatorTierEnabled !== false, builtAt: _builtAt, creators: _stats.size, counts,
    newMaxRisk: p.creatorTierNewMaxRisk, sharpMaxRisk: p.creatorTierSharpMaxRisk,
    exempt: p.creatorTierExempt || [], trustMinSettled: p.creatorTierTrustMinSettled, sharpMinN: p.creatorTierSharpMinN, sharpZ: p.creatorTierSharpZ };
}

function __setStatsForTest(m) { _stats = m; _builtAt = 'test'; }

module.exports = { buildStats, refresh, tierFor, start, summary, __setStatsForTest };
