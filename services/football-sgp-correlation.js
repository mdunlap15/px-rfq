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
 *   (ORIGINAL 7,676-game measurement; superseded 2026-09-25, see spreadBuckets)
 *    0   - 3.5                            1.006   [0.952, 1.058]
 *    3.5 - 7.5                            1.030   [0.981, 1.083]
 *    7.5 - 14.5                           1.004   [0.955, 1.053]
 *   14.5 +                                1.169   [1.131, 1.209]
 *
 * RE-MEASURED 2026-09-25, 9,465 games, finer split of the tail:
 *    0   - 3.5                            0.942   [0.892, 0.996]  (clamped to 1)
 *    3.5 - 7.5                            1.021   [0.975, 1.067]
 *    7.5 - 14.5                           1.050   [1.008, 1.091]
 *   14.5 - 21                             1.112   [1.061, 1.164]
 *   21   - 28                             1.165   [1.104, 1.229]
 *   28   - 35                             1.239   [1.156, 1.329]
 *   35 +                                  1.251   [1.171, 1.338]
 * The coupling rises steadily with the spread; one 14.5+ number over-charged
 * 14.5-21 and under-charged 28+ by ~7%.
 *
 * !! THOSE NUMBERS ARE ONE DIRECTION. Every bucket above is fav covers + over.
 * The OPPOSITE pairs — fav covers + under, dog covers + over — are a different
 * cell of the same 2x2 table and run the other way. RE-MEASURED 2026-09-27 on
 * the same 9,465 games (scripts/_cfb_sgp_bucket_measure.py; 4,000 resamples):
 *
 * CFB spread+total     dog+under (same dir)    fav+under (opp)         dog+over (opp)
 *    0   - 3.5          0.947 [0.898, 0.997]   1.057 [1.003, 1.110]   1.054 [1.003, 1.104]
 *    3.5 - 7.5          1.018 [0.978, 1.059]   0.981 [0.938, 1.024]   0.980 [0.937, 1.024]
 *    7.5 - 14.5         1.045 [1.005, 1.084]   0.956 [0.918, 0.995]   0.949 [0.906, 0.994]
 *   14.5 - 21           1.116 [1.065, 1.170]   0.892 [0.841, 0.940]   0.880 [0.823, 0.932]
 *   21   - 28           1.177 [1.111, 1.244]   0.831 [0.766, 0.894]   0.827 [0.760, 0.891]
 *   28   - 35           1.234 [1.149, 1.320]   0.766 [0.683, 0.852]   0.761 [0.675, 0.844]
 *   35 +                1.310 [1.210, 1.414]   0.663 [0.558, 0.770]   0.769 [0.691, 0.841]
 * A blowout couples "favourite covers" to "over"; it DE-couples it from
 * "under". Until 2026-09-27 the lookup read only |spread|, so fav+under and
 * dog+over paid the full 1.05-1.25 same-direction bucket although they
 * measure 0.66-0.96 at 7.5+ (i.e. clamp to 1.00). The one place the opposite
 * pair is POSITIVE is the 0-3.5 bucket, where it now pays 1.06 instead of 1.00.
 * dog+under tracks fav+over within 0.012 everywhere EXCEPT 35+ (1.310 vs
 * 1.251 — closing totals there go over 57% of the time, so the two cells'
 * marginals drift apart). That bucket sits behind the 28+ decline
 * (FOOTBALL_SGP_MAX_SPREAD_NCAAF); lifting that cap would price dog+under at
 * 35+ ~5% cheap on this table.
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
 *  * DIRECTION comes from the legs: the spread sign is the bettor's side
 *    (negative = took the favourite) and the total leg's selection is
 *    over/under. When either is unreadable the bucket charges the MORE
 *    expensive of its two directions — the same-direction factor everywhere
 *    at 3.5+ (the pre-2026-09-27 behaviour), 1.06 at 0-3.5.
 *  * A bucket without `oppositeFactor` (NFL; a FOOTBALL_SGP_CORRELATION
 *    override written before 2026-09-27) prices both directions at `factor`,
 *    i.e. direction-blind exactly as before.
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
    // RE-MEASURED 2026-09-25 on 9,465 games (cfbfastR multi-book median closing
    // lines joined to final scores; reproduces the old 14.5+ aggregate: 1.167 vs
    // 1.169). The old single 14.5+ bucket (1.17) was an AVERAGE that under-charged
    // the tail: Rutgers -42.5 + O56.5 quoted +233 vs FanDuel's real SGP +151.
    //
    // `factor` = SAME direction (fav covers + over / dog covers + under), the
    // cell each bucket was measured on. `oppositeFactor` = fav covers + under /
    // dog covers + over (2026-09-27, same games; the larger of the two cells,
    // clamped). Bucket i covers [minSpread_i, minSpread_i-1), matching the
    // measurement's lo <= |spread| < hi.
    spreadBuckets: [
      { minSpread: 35, factor: 1.25, oppositeFactor: 1.00 },   // 1.251 [1.171, 1.338] n=501 (40+: 1.265 [1.152, 1.391]); opp 0.663 / 0.769 (dog+under 1.310 — see header)
      { minSpread: 28, factor: 1.24, oppositeFactor: 1.00 },   // 1.239 [1.156, 1.329] n=574; opp 0.766 / 0.761
      { minSpread: 21, factor: 1.17, oppositeFactor: 1.00 },   // 1.165 [1.104, 1.229] n=946; opp 0.831 / 0.827
      { minSpread: 14.5, factor: 1.11, oppositeFactor: 1.00 }, // 1.112 [1.061, 1.164] n=1432; opp 0.892 / 0.880
      { minSpread: 7.5, factor: 1.05, oppositeFactor: 1.00 },  // 1.050 [1.008, 1.091] n=2362 (was 1.004, CI contained 1); opp 0.956 / 0.949
      { minSpread: 3.5, factor: 1.00, oppositeFactor: 1.00 },  // 1.021 [0.975, 1.067] n=2156; opp 0.981 / 0.980 — every CI contains 1
      { minSpread: 0, factor: 1.00, oppositeFactor: 1.06 },    // 0.942 [0.892, 0.996] n=1494 -> clamp; opp 1.057 [1.003, 1.110] / 1.054 [1.003, 1.104]
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
 * @param {string} [a.totalSelection] 'over' | 'under' — the total leg's side.
 *                                 Only consulted for spread_total; with the
 *                                 spread sign it picks same vs opposite direction.
 * @returns {{factor:number, basis:string}|null} null when not calibrated.
 */
function footballSgpFactor({ sport, combo, spreadLine, totalSelection } = {}) {
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
  let mag, note, side = null;
  if (Number.isFinite(n) && n !== 0) {
    mag = Math.abs(n);
    note = `spread ${mag}`;
    side = n < 0 ? 'fav' : 'dog';
  } else {
    mag = Infinity;                       // fail toward the expensive side
    note = 'spread unknown -> widest bucket';
  }
  const sel = String(totalSelection || '').toLowerCase();
  const tot = sel === 'over' || sel === 'under' ? sel : null;
  // fav+over and dog+under are the SAME direction (the favourite's blowout
  // lifts the total); fav+under and dog+over are the opposite pair.
  const dir = side && tot ? `${side}_${tot}` : null;
  const same = dir ? (dir === 'fav_over' || dir === 'dog_under') : null;
  for (const b of sorted) {
    if (mag >= (Number(b.minSpread) || 0)) {
      const f = Number(b.factor);
      if (!Number.isFinite(f)) return null;
      // No (or unreadable) oppositeFactor = direction-blind, as before.
      const o = b.oppositeFactor == null ? NaN : Number(b.oppositeFactor);
      const opp = Number.isFinite(o) ? o : f;
      let use, dnote;
      if (same === true) { use = f; dnote = `${dir} same-direction`; }
      else if (same === false) { use = opp; dnote = `${dir} opposite-direction`; }
      else { use = Math.max(f, opp); dnote = 'direction unknown -> dearer of both'; }
      return {
        factor: Math.max(1, use),
        basis: `${league}.spread_total (${note}, >=${b.minSpread}, ${dnote})`,
      };
    }
  }
  return null;
}

module.exports = { footballSgpFactor, _leagueOf, _resetForTest, DEFAULTS };
