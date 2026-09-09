'use strict';

/**
 * MLB same-game correlation factors — side (run line / moneyline) + game total.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The production grid (`SGP_CORRELATION_BY_COMBO`) applies ml_total 1.15 and
 * spread_fav_over 1.30 to MLB. Those numbers were "back-calculated from 4
 * FanDuel samples" and never measured against outcomes. Measured over the last
 * 7 days (2026-09-02..09) they cost us $52K/wk of network fills we lost at a
 * 3.6-3.8pp median gap, winning 0.13% of ml_total contests and 0.02% of
 * spread_total contests — while the handful we did win ran +34% ROI, which is
 * what pricing a phantom correlation looks like from the inside.
 *
 * METHOD — same as services/football-sgp-correlation.js. For each game take
 * the last pre-game consensus run line / moneyline / total (The Odds API
 * historical snapshots at 16:00Z and 22:30Z, median across ~10 US books, the
 * later snapshot winning per game) and the Retrosheet final score, then
 *
 *     M = P(A and B) / (P(A) * P(B))
 *
 * the exact quantity that multiplies our independent fair parlay probability.
 * 95% CIs bootstrapped (6,000 resamples); pushes on either leg excluded.
 *
 * SAMPLE: 3,284 games — the full 2024 season plus 2025 through May 27
 * (measured 2026-09-09; 30 unmatched, all opening-week overseas series). The
 * 2024-only run (2,073 games) gave the same shape; adding 2025 tightened every
 * CI and moved no conclusion. Re-measure with the rest of 2025 when convenient,
 * but nothing below is sitting on the edge of significance.
 *
 * MLB moneyline + total (n=3,145)          M       95% CI
 *   fav ML + over                         0.980   [0.950, 1.010]
 *   fav ML + under                        1.018   [0.991, 1.046]
 *   dog ML + over                         1.030   [0.986, 1.076]
 *   dog ML + under                        0.972   [0.931, 1.014]
 * EVERY CI contains 1.000 — MLB moneyline+total is INDEPENDENT, like the NFL.
 * (If anything a favourite winning leans UNDER: favourites win pitchers'
 * duels 3-1. There is no favourite-over coupling to charge for.)
 *
 * MLB run line (±1.5) + total (n=3,132)    M       95% CI
 *   fav covers + over                     1.066   [1.024, 1.108]
 *   dog covers + under                    1.047   [1.017, 1.077]
 *   fav covers + under                    0.940   [0.902, 0.980]
 *   dog covers + over                     0.949   [0.916, 0.983]
 *
 * fav covers + over, BY GAME TOTAL:
 *   total <= 7.5                          1.135   [1.059, 1.213]
 *   total 8-9                             1.062   [1.005, 1.118]
 *   total >= 9.5                          0.953   [0.854, 1.051]  -> clamp
 * Mechanically sensible: covering -1.5 in a 7-run game REQUIRES the over; in an
 * 11-run game it does not. A single spread_fav_over number is wrong in both
 * directions — too cheap at low totals, too rich at high ones.
 *
 * fav covers + over, BY FAVOURITE STRENGTH (ML): heavy 1.100, moderate 1.103,
 * slight 1.093 — flat. The TOTAL is the conditioning dimension, not the price
 * of the favourite, so the table does not split on it.
 *
 * DESIGN RULES (identical to the football module)
 * ----------------------------------------------
 *  * Clamped at >= 1.00. The negative directions are real but honouring them
 *    would make our quote cheaper than independent; clamping leaves us merely
 *    uncompetitive there rather than exposed.
 *  * Returns null when not calibrated, so the caller can fall through.
 *  * An unreadable total or selection on a spread_total pair falls back to the
 *    WIDEST bucket (fail toward the expensive side).
 *  * Gated by MLB_SGP_CORRELATION_MEASURED='true' (config.pricing
 *    .mlbSgpCorrelationMeasured); when off, the generic grid keeps applying.
 *    The switch is explicit because it changes live MLB SGP prices.
 *  * MLB_SGP_CORRELATION (JSON) overrides the table; the defaults ARE the
 *    measurement — an override is a deliberate departure, not tuning.
 */

const log = require('./logger');

const DEFAULTS = {
  ml_total: 1.00,
  // spread_total, keyed by bettor direction. fav_over is conditioned on the
  // game total; buckets are consulted highest-minTotal first.
  spread: {
    fav_over: { buckets: [
      { maxTotal: 7.5, factor: 1.14 },   // measured 1.135 [1.059, 1.213]
      { maxTotal: 9.0, factor: 1.06 },   // measured 1.062 [1.005, 1.118]
      { maxTotal: Infinity, factor: 1.00 }, // measured 0.953 [0.854, 1.051] -> clamp
    ] },
    dog_under: { factor: 1.05 },         // measured 1.047 [1.017, 1.077]
    fav_under: { factor: 1.00 },         // measured 0.940 -> clamp
    dog_over: { factor: 1.00 },          // measured 0.949 -> clamp
  },
};

let _cache;
function _table() {
  if (_cache !== undefined) return _cache;
  _cache = DEFAULTS;
  const raw = process.env.MLB_SGP_CORRELATION;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        _cache = {
          ml_total: p.ml_total != null ? p.ml_total : DEFAULTS.ml_total,
          spread: { ...DEFAULTS.spread, ...(p.spread || {}) },
        };
        log.info('Pricing', 'MLB_SGP_CORRELATION override applied');
      }
    } catch (err) {
      log.warn('Pricing', `MLB_SGP_CORRELATION is not valid JSON (${err.message}) — using measured defaults`);
    }
  }
  return _cache;
}
function _resetForTest() { _cache = undefined; }

/**
 * @param {object}  a
 * @param {string}  a.sport           'baseball_mlb' (anything else -> null)
 * @param {string}  a.combo           'spread_total' | 'ml_total'
 * @param {number} [a.spreadLine]     bettor's run line; negative = took the favourite
 * @param {number} [a.totalLine]      the game total
 * @param {string} [a.totalSelection] 'over' | 'under'
 * @returns {{factor:number, basis:string}|null}
 */
function mlbSgpFactor({ sport, combo, spreadLine, totalLine, totalSelection } = {}) {
  if (String(sport || '') !== 'baseball_mlb') return null;
  const t = _table();

  if (combo === 'ml_total') {
    const f = Number(t.ml_total);
    return Number.isFinite(f) ? { factor: Math.max(1, f), basis: 'mlb.ml_total' } : null;
  }
  if (combo !== 'spread_total') return null;

  const sl = Number(spreadLine);
  const side = Number.isFinite(sl) && sl !== 0 ? (sl < 0 ? 'fav' : 'dog') : null;
  const sel = String(totalSelection || '').toLowerCase();
  const tot = sel === 'over' || sel === 'under' ? sel : null;

  // Unknown direction: fail toward the expensive side — the fav_over table.
  const key = side && tot ? `${side}_${tot}` : 'fav_over';
  const entry = t.spread[key];
  if (!entry) return null;

  if (Array.isArray(entry.buckets)) {
    const tl = totalLine == null ? NaN : Number(totalLine);
    // Unknown total -> the tightest (most expensive) bucket.
    const use = Number.isFinite(tl) && tl > 0 ? tl : 0;
    const sorted = entry.buckets.slice().sort((x, y) => (Number(x.maxTotal) || Infinity) - (Number(y.maxTotal) || Infinity));
    for (const b of sorted) {
      if (use <= (Number(b.maxTotal) || Infinity)) {
        const f = Number(b.factor);
        if (!Number.isFinite(f)) return null;
        return { factor: Math.max(1, f), basis: `mlb.spread_total ${key} (total ${Number.isFinite(tl) ? tl : 'unknown->tightest'}, <=${b.maxTotal})` };
      }
    }
    return null;
  }
  const f = Number(entry.factor);
  return Number.isFinite(f) ? { factor: Math.max(1, f), basis: `mlb.spread_total ${key}` } : null;
}

module.exports = { mlbSgpFactor, _resetForTest, DEFAULTS };
