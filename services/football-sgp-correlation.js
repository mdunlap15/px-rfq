'use strict';

/**
 * Football same-game correlation factors — side (spread/moneyline) + game total.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `sgpCorrelationByCombo` is a flat, SPORT-AGNOSTIC grid back-calculated from a
 * handful of FanDuel MLB/NHL samples. Football same-game parlays were blocked
 * outright (`football_sgp_blocked`) on the grounds that "no calibrated football
 * correlation factors exist" and a guessed factor is worse than a block.
 *
 * They exist now. These numbers are MEASURED — not modelled, and deliberately
 * NOT reverse-engineered from a book's own SGP price (which bakes in the book's
 * margin and would import it straight into our fair value).
 *
 * METHOD — for each historical game take the CLOSING consensus spread and total
 * and the final score, then compute the joint multiplier
 *
 *     M = P(A and B) / (P(A) * P(B))
 *
 * which is exactly the quantity that multiplies our independent fair parlay
 * probability. M = 1.00 means independent pricing is already correct. 95% CIs
 * are bootstrapped (4,000 resamples). Pushes on either leg are excluded.
 *
 * NFL — 7,245 games, 1999-2025, nflverse closing spread_line / total_line.
 * CFB — 7,676 games, 2006-2025, cfbfastR multi-book consensus (median across
 *       books) joined to final scores.
 *
 * NFL                                       M       95% CI
 *   fav covers + over                     1.004   [0.979, 1.028]
 *   fav covers + under                    0.996   [0.972, 1.020]
 *   fav ML + over                         1.005   [0.988, 1.021]
 *   dog ML + under                        1.009   [0.976, 1.041]
 *
 * EVERY NFL confidence interval contains 1.000. Over 27 seasons NFL side+total
 * is statistically indistinguishable from INDEPENDENT. The widely-repeated
 * "favourite covers, therefore the over hits 52.5%" does not replicate on
 * closing lines — measured P(over | fav covered) = 49.7%.
 *
 * CFB                                       M       95% CI
 *   fav covers + over                     1.067   [1.044, 1.090]
 *   fav covers + under                    0.934   [0.910, 0.956]
 *   dog covers + under                    1.064   [1.042, 1.085]
 *   dog covers + over                     0.935   [0.913, 0.958]
 *   fav ML + over                         1.015   [1.002, 1.028]
 *
 * !! THE HEADLINE CFB NUMBER IS AN ARTEFACT OF AGGREGATION. Split by spread:
 *
 * CFB spread+total, by spread size          M       95% CI
 *    0   - 3.5                            1.006   [0.952, 1.058]
 *    3.5 - 7.5                            1.030   [0.981, 1.083]
 *    7.5 - 14.5                           1.004   [0.955, 1.053]
 *   14.5 +                                1.169   [1.131, 1.209]
 *
 * Below two touchdowns there is NO correlation. Above it the joint probability
 * runs ~17% above the independent product — blowout game script (garbage-time
 * scoring, running clock, backups) genuinely couples the side to the total.
 * That bucket is ~32% of CFB games, so pricing it at independence is a real and
 * frequently-hit underprice; equally, a single aggregate 1.067 would OVERprice
 * the other 68% while still UNDERpricing this one. Hence spread conditioning.
 *
 * CFB moneyline+total stays ~1.02 even at big spreads, because a huge favourite
 * winning outright carries almost no information (P = 93.8% at 14.5+).
 *
 * DESIGN RULES
 * ------------
 *  * CLAMPED AT >= 1.00, never below. The negative-correlation directions
 *    (fav+under at 0.934) are real, but honouring them would make our quote
 *    CHEAPER than independent. Clamping leaves us merely uncompetitive there
 *    instead of exposed. Asymmetric on purpose.
 *  * Returns null — not 1 — when the combo is not one we measured, so the caller
 *    can distinguish "measured as independent" from "no calibration" and fall
 *    through to whatever it would otherwise have done.
 *  * A missing or unparseable spread line on a spread+total pair falls back to
 *    the WIDEST bucket. The spread is the input that decides between 1.00 and
 *    1.17; if we cannot read it, assuming the small-spread value would
 *    underprice exactly the bucket that matters.
 *  * CFL and any other americanfootball_* league returns null — not measured.
 *  * Every threshold and factor is overridable via FOOTBALL_SGP_CORRELATION
 *    (JSON), but the defaults ARE the measurement: an override is a deliberate
 *    departure from it, not tuning.
 */

const log = require('./logger');

// Measured defaults. `spreadBuckets` is consulted first for spread_total and
// wins whenever a bucket matches.
const DEFAULTS = {
  nfl: {
    // Every NFL CI contains 1.000 — independent pricing IS the calibration.
    spread_total: 1.00,
    ml_total: 1.00,
    spreadBuckets: [
      // Kept so the shape matches CFB and a future re-measure has a home.
      // 7.5+ measured 1.045 CI [0.988, 1.104] — CI contains 1, so NOT applied.
      { minSpread: 0, factor: 1.00 },
    ],
  },
  ncaaf: {
    spread_total: 1.00,   // used only if the bucket lookup somehow misses
    ml_total: 1.02,       // measured 1.015 CI [1.002, 1.028], rounded up
    spreadBuckets: [
      { minSpread: 14.5, factor: 1.17 },  // measured 1.169 CI [1.131, 1.209]
      { minSpread: 0, factor: 1.00 },     // 0-14.5: three buckets, all CIs contain 1
    ],
  },
};

function _leagueOf(sport) {
  const s = String(sport || '').toLowerCase();
  if (!s.startsWith('americanfootball')) return null;
  if (s.includes('ncaaf') || s.includes('college')) return 'ncaaf';
  if (s.includes('nfl')) return 'nfl';
  return null;   // CFL and anything else: NOT measured, fail closed
}

let _overrideCache;
function _table() {
  if (_overrideCache !== undefined) return _overrideCache;
  _overrideCache = DEFAULTS;
  const raw = process.env.FOOTBALL_SGP_CORRELATION;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _overrideCache = {
          nfl: { ...DEFAULTS.nfl, ...(parsed.nfl || {}) },
          ncaaf: { ...DEFAULTS.ncaaf, ...(parsed.ncaaf || {}) },
        };
        log.info('Pricing', 'FOOTBALL_SGP_CORRELATION override applied');
      }
    } catch (err) {
      log.warn('Pricing', `FOOTBALL_SGP_CORRELATION is not valid JSON (${err.message}) — using measured defaults`);
    }
  }
  return _overrideCache;
}

// Test seam: the table is cached because it is read on the RFQ hot path.
function _resetForTest() { _overrideCache = undefined; }

/**
 * @param {object}  a
 * @param {string}  a.sport        odds sport key, e.g. 'americanfootball_ncaaf'
 * @param {string}  a.combo        'spread_total' | 'ml_total'
 * @param {number} [a.spreadLine]  the bettor's spread; negative = they took the
 *                                 favourite. Only consulted for spread_total.
 * @returns {{factor:number, basis:string}|null} null when not calibrated.
 */
function footballSgpFactor({ sport, combo, spreadLine } = {}) {
  const league = _leagueOf(sport);
  if (!league) return null;
  const t = _table()[league];
  if (!t) return null;

  if (combo === 'ml_total') {
    const f = Number(t.ml_total);
    if (!Number.isFinite(f)) return null;
    return { factor: Math.max(1, f), basis: `${league}.ml_total` };
  }

  if (combo !== 'spread_total') return null;

  const buckets = Array.isArray(t.spreadBuckets) ? t.spreadBuckets : [];
  if (!buckets.length) {
    const f = Number(t.spread_total);
    return Number.isFinite(f)
      ? { factor: Math.max(1, f), basis: `${league}.spread_total` }
      : null;
  }
  // Descending, so the first match is the tightest applicable bucket.
  const sorted = buckets.slice().sort((x, y) => (Number(y.minSpread) || 0) - (Number(x.minSpread) || 0));

  const n = Number(spreadLine);
  let mag, note;
  if (Number.isFinite(n) && n !== 0) {
    mag = Math.abs(n);
    note = `spread ${mag}`;
  } else {
    mag = Infinity;                       // fail toward the expensive side
    note = 'spread unknown -> widest bucket';
  }
  for (const b of sorted) {
    if (mag >= (Number(b.minSpread) || 0)) {
      const f = Number(b.factor);
      if (!Number.isFinite(f)) return null;
      return {
        factor: Math.max(1, f),
        basis: `${league}.spread_total (${note}, >=${b.minSpread})`,
      };
    }
  }
  return null;
}

module.exports = { footballSgpFactor, _leagueOf, _resetForTest, DEFAULTS };
