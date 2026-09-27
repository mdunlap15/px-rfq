/**
 * How ProphetX grades a parlay once its legs resolve — MEASURED, not assumed.
 *
 * PX rule (SP perspective, i.e. the `settlement_status` PX reports to us):
 *   1. any leg LOST                        -> 'won'  (bettor loses the stake; pushes irrelevant)
 *   2. else every leg void/push            -> 'push' (stake refunded)
 *   3. else a void leg AND the parlay has a SAME-GAME group
 *      (2+ legs on one PX sport_event_id)  -> 'push' — PX VOIDS THE WHOLE PARLAY,
 *      even when the void leg is on a different game than the same-game pair
 *   4. else a void leg, no same-game group -> 'lost' at REDUCED odds: PX divides out
 *      each void leg's per-leg probability (the `price_probability.lines[].probability`
 *      we sent at confirm, whose product is the parlay price — PX Rule 2) and rounds
 *      the new price to an integer American price AGAINST the bettor
 *   5. else every leg won                  -> 'lost' (full payout = our whole risk)
 *
 * Evidence (parlay_orders 6/1–9/26, audited 2026-09-27): of 206 won-with-a-void
 * parlays, 15/15 containing a same-game group settled 'push' with profit 0, and
 * 191/191 with none settled 'lost' at a reduced payout. On the 140 post-6/26 ones
 * with a PX profit, rule 4 reproduces PX's profit to the CENT on 113 (81%) and to
 * within ~1–4% on the rest. Rule 3 is why the "15 won-with-a-push tickets booked as
 * push/$0" are not a bookkeeping error: PX's own order record says push — the
 * settlement poll and every boot's fullPxReconcile re-book any row whose status or
 * profit disagrees with PX's, and never touched them (scripts/
 * _reconcile_push_settlements.js checks it directly). PX's per-leg probabilities
 * only reconcile to the parlay price for non-SGP parlays (Rule 2), so there is
 * nothing PX could divide out of a correlated same-game price.
 * Untested corner: golf outright legs share one PX event per market, so a golf
 * parlay counts as "same-game" here — no voided golf leg has been observed yet.
 *
 * Pure: no requires, no I/O — safe to load from scripts and tests.
 */

const VOID_RE = /push|void|cancel|refund/;

/**
 * 'won' | 'lost' | 'void' | null for one leg. PX's settlement_status wins over our
 * scraped inferredResult; `pxOnly` ignores inferredResult entirely.
 */
function legOutcome(leg, opts = {}) {
  if (!leg) return null;
  let s = leg.settlementStatus || leg.settlement_status || null;
  if (!s && !opts.pxOnly) s = leg.inferredResult || null;
  if (!s) return null;
  s = String(s).toLowerCase();
  if (s === 'won' || s === 'win' || s.startsWith('won')) return 'won';
  if (s === 'lost' || s === 'loss' || s.startsWith('lost')) return 'lost';
  if (VOID_RE.test(s)) return 'void';
  return null; // tbd / pending / unknown vocabulary — not resolved
}

/** True when 2+ legs share a PX sport_event_id — PX's notion of a same-game group. */
function hasSameGameGroup(legs) {
  const seen = new Set();
  for (const l of legs || []) {
    const ev = l && (l.pxEventId ?? l.sport_event_id);
    if (ev == null || ev === '') continue;
    const k = String(ev);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * The settlement PX's rule predicts from leg outcomes.
 * Returns { result: 'won'|'lost'|'push'|null, basis, voidLegs, sameGame }.
 * result is null (basis 'incomplete') until the legs determine it.
 */
function expectedPxSettlement(legs, opts = {}) {
  const list = Array.isArray(legs) ? legs : [];
  const outcomes = list.map(l => legOutcome(l, opts));
  const sameGame = hasSameGameGroup(list);
  const voidLegs = outcomes.filter(o => o === 'void').length;
  const out = (result, basis) => ({ result, basis, voidLegs, sameGame });
  if (!list.length) return out(null, 'no_legs');
  if (outcomes.includes('lost')) return out('won', 'any_leg_lost');
  if (outcomes.some(o => o == null)) return out(null, 'incomplete');
  if (voidLegs === list.length) return out('push', 'all_legs_void');
  if (voidLegs > 0) return sameGame ? out('push', 'same_game_void') : out('lost', 'void_reduced');
  return out('lost', 'all_legs_won');
}

// Bettor's decimal odds from our SP-side confirmedOdds (SP -249 = bettor +249).
function bettorDecimal(confirmedOdds) {
  const b = -Number(confirmedOdds);
  if (!Number.isFinite(b) || Math.abs(b) < 100) return null;
  return b > 0 ? 1 + b / 100 : 1 + 100 / -b;
}

/**
 * The per-leg probabilities websocket.js sends PX at confirm: the leg bases
 * (bookPriceOverride ?? fairProb) geometrically scaled so their product is the
 * bettor-side implied prob of confirmedOdds. MIRRORS pricer.distributeLegProbs
 * (test/push-settlement-mapping.test.js pins the two together). Falls back to the
 * quote-time legConfirmProb when a base is unusable; null if neither is.
 */
function confirmLegProbs(legs, confirmedOdds) {
  const list = Array.isArray(legs) ? legs : [];
  const n = list.length;
  const D = bettorDecimal(confirmedOdds);
  const base = list.map(l => {
    const p = l && (l.bookPriceOverride != null ? l.bookPriceOverride : l.fairProb);
    return p > 0 && p < 1 ? Number(p) : null;
  });
  if (n && D && base.every(p => p != null)) {
    const target = 1 / D;
    const raw = base.reduce((a, p) => a * p, 1);
    const scale = Math.pow(target / raw, 1 / n);
    const out = base.map(p => Math.min(0.999999, Math.max(1e-6, p * scale)));
    if (n > 1) {
      const prefix = out.slice(0, -1).reduce((a, p) => a * p, 1);
      if (prefix > 0) out[n - 1] = Math.min(0.999999, Math.max(1e-6, target / prefix));
    } else {
      out[0] = Math.min(0.999999, Math.max(1e-6, target));
    }
    return { probs: out, method: 'confirm_distribution' };
  }
  const stored = list.map(l => (l && l.legConfirmProb > 0 && l.legConfirmProb < 1 ? Number(l.legConfirmProb) : null));
  if (n && stored.every(p => p != null)) return { probs: stored, method: 'stored_leg_confirm' };
  return null;
}

// PX re-prices a reduced parlay to an integer American price, rounded AGAINST the
// bettor (+108.87 -> +108, -571.6 -> -572). Measured: 113/140 cent-exact with it,
// 21/140 without.
function roundDecimalAgainstBettor(dec) {
  if (!(dec > 1)) return 1;
  if (dec >= 2) return 1 + Math.floor((dec - 1) * 100 + 1e-9) / 100;
  return 1 + 100 / Math.ceil(100 / (dec - 1) - 1e-9);
}

/**
 * OUR loss (positive dollars) when the bettor wins a parlay whose void legs PX
 * dropped (rule 4). With no void leg this is exactly confirmedStake. Returns
 * { loss, voidLegs, method } or null when the stake/odds or the void legs' per-leg
 * probabilities are unusable (caller keeps its own fallback).
 */
function reducedPayoutLoss({ legs, confirmedOdds, confirmedStake } = {}) {
  const R = Number(confirmedStake);
  const D = bettorDecimal(confirmedOdds);
  if (!(R > 0) || !D) return null;
  const S = R / (D - 1); // bettor's stake: R = S x (D - 1)
  const list = Array.isArray(legs) ? legs : [];
  const voidIdx = [];
  list.forEach((l, i) => { if (legOutcome(l) === 'void') voidIdx.push(i); });
  if (!voidIdx.length) return { loss: Math.round(R * 100) / 100, voidLegs: 0, method: 'full' };
  if (voidIdx.length === list.length) return { loss: 0, voidLegs: voidIdx.length, method: 'all_void' };
  const cp = confirmLegProbs(list, confirmedOdds);
  if (!cp) return null;
  let pv = 1;
  for (const i of voidIdx) pv *= cp.probs[i];
  const reduced = roundDecimalAgainstBettor(Math.max(1, D * pv));
  const loss = Math.round(S * (reduced - 1) * 100) / 100;
  return { loss: Math.min(loss, Math.round(R * 100) / 100), voidLegs: voidIdx.length, method: cp.method };
}

module.exports = {
  legOutcome,
  hasSameGameGroup,
  expectedPxSettlement,
  bettorDecimal,
  confirmLegProbs,
  roundDecimalAgainstBettor,
  reducedPayoutLoss,
};
