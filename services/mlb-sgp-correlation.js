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
 * SAMPLE: 4,911 games — the COMPLETE 2024 and 2025 regular seasons (measured
 * 2026-09-09; 45 unmatched, opening-week overseas series and doubleheader
 * edge cases). Three cuts were run as the data landed (2,073 → 3,284 → 4,911
 * games); the run-line shape never moved, and the only conclusion that
 * changed is that moneyline+total's small DIRECTIONAL structure cleared
 * significance on the full sample (it was inside noise at 3,284).
 *
 * MLB moneyline + total (n=4,703)          M       95% CI
 *   fav ML + over                         0.968   [0.944, 0.992]  -> clamp
 *   fav ML + under                        1.030   [1.008, 1.052]
 *   dog ML + over                         1.047   [1.011, 1.083]
 *   dog ML + under                        0.956   [0.924, 0.989]  -> clamp
 * The structure is the OPPOSITE of the intuition the grid encodes: a
 * favourite winning leans UNDER (they win pitchers' duels 3-1) and a dog
 * winning leans OVER (upsets are shootouts). There is no favourite-over
 * coupling to charge for — the grid's flat 1.15 was charging most on the one
 * direction that is actually anti-correlated.
 *
 * MLB run line (±1.5) + total (n=4,687)    M       95% CI
 *   fav covers + over                     1.074   [1.039, 1.109]
 *   dog covers + under                    1.051   [1.028, 1.075]
 *   fav covers + under                    0.931   [0.898, 0.964]  -> clamp
 *   dog covers + over                     0.945   [0.920, 0.971]  -> clamp
 *
 * fav covers + over, BY GAME TOTAL:
 *   total <= 7.5                          1.125   [1.056, 1.196]
 *   total 8-9                             1.069   [1.023, 1.116]
 *   total >= 9.5                          1.014   [0.937, 1.089]  -> clamp
 * Mechanically sensible: covering -1.5 in a 7-run game REQUIRES the over; in an
 * 11-run game it does not. A single spread_fav_over number is wrong in both
 * directions — too cheap at low totals, too rich at high ones.
 *
 * fav covers + over, BY FAVOURITE STRENGTH (ML): heavy 1.103, moderate 1.147,
 * slight 1.065 — non-monotonic, so not a usable conditioning dimension. The
 * TOTAL is monotonic and mechanically motivated; the table splits on it only.
 *
 * DESIGN RULES (identical to the football module)
 * ----------------------------------------------
 *  * Clamped at >= 1.00. The negative directions are real but honouring them
 *    would make our quote cheaper than independent; clamping leaves us merely
 *    uncompetitive there rather than exposed.
 *  * Factors are rounded UP from the point estimate (1.125 -> 1.13), never
 *    down; a bucket whose CI contains 1.000 is 1.00, not its point estimate.
 *  * Returns null when not calibrated, so the caller can fall through.
 *  * An unreadable total, side or selection falls back to the TIGHTEST
 *    applicable entry (fail toward the expensive side).
 *  * Gated by MLB_SGP_CORRELATION_MEASURED='true' (config.pricing
 *    .mlbSgpCorrelationMeasured); when off, the generic grid keeps applying.
 *    The switch is explicit because it changes live MLB SGP prices.
 *  * MLB_SGP_CORRELATION (JSON) overrides the table; the defaults ARE the
 *    measurement — an override is a deliberate departure, not tuning.
 */

const log = require('./logger');

const DEFAULTS = {
  // moneyline + total, keyed <mlSide>_<totalSelection>
  ml: {
    fav_over: { factor: 1.00 },          // measured 0.968 [0.944, 0.992] -> clamp
    fav_under: { factor: 1.03 },         // measured 1.030 [1.008, 1.052]
    dog_over: { factor: 1.05 },          // measured 1.047 [1.011, 1.083]
    dog_under: { factor: 1.00 },         // measured 0.956 [0.924, 0.989] -> clamp
  },
  // run line + total, keyed <rlSide>_<totalSelection>; fav_over is conditioned
  // on the game total, buckets consulted lowest maxTotal first.
  spread: {
    fav_over: { buckets: [
      { maxTotal: 7.5, factor: 1.13 },   // measured 1.125 [1.056, 1.196]
      { maxTotal: 9.0, factor: 1.07 },   // measured 1.069 [1.023, 1.116]
      { maxTotal: Infinity, factor: 1.00 }, // measured 1.014 [0.937, 1.089] -> CI contains 1
    ] },
    dog_under: { factor: 1.05 },         // measured 1.051 [1.028, 1.075]
    fav_under: { factor: 1.00 },         // measured 0.931 -> clamp
    dog_over: { factor: 1.00 },          // measured 0.945 -> clamp
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
          ml: { ...DEFAULTS.ml, ...(p.ml || {}) },
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

const _maxFactor = (group) => Math.max(...Object.values(group).map(e =>
  Array.isArray(e.buckets) ? Math.max(...e.buckets.map(b => Number(b.factor) || 1)) : (Number(e.factor) || 1)));

/**
 * @param {object}  a
 * @param {string}  a.sport           'baseball_mlb' (anything else -> null)
 * @param {string}  a.combo           'spread_total' | 'ml_total'
 * @param {number} [a.spreadLine]     bettor's run line; negative = took the favourite
 * @param {string} [a.mlSide]         'fav' | 'dog' — the moneyline leg's side (ml_total only)
 * @param {number} [a.totalLine]      the game total
 * @param {string} [a.totalSelection] 'over' | 'under'
 * @returns {{factor:number, basis:string}|null}
 */
function mlbSgpFactor({ sport, combo, spreadLine, mlSide, totalLine, totalSelection } = {}) {
  if (String(sport || '') !== 'baseball_mlb') return null;
  const t = _table();
  const sel = String(totalSelection || '').toLowerCase();
  const tot = sel === 'over' || sel === 'under' ? sel : null;

  if (combo === 'ml_total') {
    const side = mlSide === 'fav' || mlSide === 'dog' ? mlSide : null;
    if (!side || !tot) {
      // Unknown direction: the tightest entry in the group.
      return { factor: Math.max(1, _maxFactor(t.ml)), basis: 'mlb.ml_total (direction unknown -> tightest)' };
    }
    const e = t.ml[`${side}_${tot}`];
    const f = e ? Number(e.factor) : NaN;
    return Number.isFinite(f) ? { factor: Math.max(1, f), basis: `mlb.ml_total ${side}_${tot}` } : null;
  }

  if (combo !== 'spread_total') return null;

  const sl = Number(spreadLine);
  const side = Number.isFinite(sl) && sl !== 0 ? (sl < 0 ? 'fav' : 'dog') : null;
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
