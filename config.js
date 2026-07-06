require('dotenv').config({ path: __dirname + '/.env' });

// Parse an env SCOPE/exposure cap that supports "0 = disabled/unlimited".
// Unlike `parseFloat(env) || N` — where "0" is falsy and silently reverts to the
// default N — this preserves an explicit 0 (and any valid number), falling back
// to `dflt` only when the var is unset/blank/non-numeric (negatives are invalid).
// This is the footgun that hard-declined every prop parlay on 2026-06-11: the
// operator set MAX_PROP_RISK_PER_GAME=0 to "disable" the cap and it silently
// became 600, so a $6000 worst-case charge tripped "$0 + $6000 > $600" on the
// first parlay of every game. Applied ONLY to scope caps whose gates already
// treat <=0 as "disabled/allow-all" (verified: checkExposureLimits,
// checkGameExposure, checkPlayerExposure, checkSeriesExposure, checkPropGameCaps).
// NOT used for per-parlay CHARGE caps (maxRiskPerParlay*, maxRiskSgpExperimental,
// maxSeriesRiskPerParlay) — those have use-site `|| N` floors and 0 is not a
// meaningful "disable" there, so the falsy-|| is benign (0 -> safe default, never
// a block).
function _capNum(envVal, dflt) {
  const x = parseFloat(envVal);
  return (Number.isFinite(x) && x >= 0) ? x : dflt;
}

const config = {
  px: {
    baseUrl: process.env.PX_BASE_URL || 'https://cash.api.prophetx.co',
    accessKey: process.env.PX_ACCESS_KEY,
    secretKey: process.env.PX_SECRET_KEY,
    tokenTtlMinutes: 9,
  },
  oddsApi: {
    baseUrl: 'https://api.sharpapi.io/api/v1',
    apiKey: process.env.SHARP_ODDS_API_KEY || process.env.ODDS_API_KEY,
    cacheTtlMinutes: parseInt(process.env.ODDS_CACHE_TTL_MINUTES) || 5,
  },
  dataGolf: {
    apiKey: process.env.DATAGOLF_API_KEY,
    baseUrl: 'https://feeds.datagolf.com',
  },
  pricing: {
    defaultVig: parseFloat(process.env.DEFAULT_VIG) || 0.015,
    // Per-sport vig overrides. Keyed by odds-feed sport key.
    // Falls back to defaultVig if sport not listed.
    // Bootstrapped from VIG_BY_SPORT env var (JSON-encoded map) so values
    // survive Railway redeploys. Still adjustable at runtime via POST
    // /config/vig — runtime POSTs override the env-var defaults until the
    // next restart, at which point the env-var values take over again.
    vigBySport: (() => {
      if (!process.env.VIG_BY_SPORT) return {};
      try {
        const parsed = JSON.parse(process.env.VIG_BY_SPORT);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        console.warn('VIG_BY_SPORT must be a JSON object — got', typeof parsed, '— ignoring');
        return {};
      } catch (e) {
        console.warn('Invalid VIG_BY_SPORT JSON, ignoring:', e.message);
        return {};
      }
    })(),
    // Heavy-favorite vig ramp. For legs with fairProb > 0.5, vig is computed as:
    //   vig = max(vigFavoriteFloor, baseVig + vigFavoriteSlope * (fairProb - 0.5))
    // Tunable at runtime via Railway env vars without code changes.
    // Slope 0.075 default: matches old 2.5% step at p=0.70, exceeds it everywhere
    // above, and adds meaningful bite in the long tail (4% at p=0.90, 4.4% at p=0.95).
    // Floor 0 (off) by default — set e.g. 0.02 to enforce a 2% minimum on favorite legs.
    vigFavoriteSlope: parseFloat(process.env.VIG_FAVORITE_SLOPE) || 0.075,
    vigFavoriteFloor: parseFloat(process.env.VIG_FAVORITE_FLOOR) || 0,
    // Minimum per-leg vig for series_winner legs (NBA/NHL playoff
    // series). DK charges ~4-5% per-leg on these and we're typically
    // the only SP quoting them on PX — so we can widen our spread
    // without losing flow. Applied as a floor on top of the normal
    // baseVig + favorite ramp, so extreme favorites still pay more.
    // Default 0.05 (5%); tunable via VIG_SERIES_MIN env var.
    vigSeriesMin: parseFloat(process.env.VIG_SERIES_MIN) || 0.05,
    // Pitcher strikeouts prop floor — minimum per-leg vig applied to
    // marketType='player_strikeouts' legs. Skips the favorite-slope
    // ramp that game-line legs use because props don't have favorites
    // in the team-line sense. Lowered 0.03 -> 0.02 on 2026-06-24 after
    // RCA found prop quotes ran a median ~8% / K-SGP 14-16% margin vs
    // fair and won 0 of 549 fills (uncompetitive). NOTE: this floor only
    // BINDS when it exceeds the per-sport base vig — if DEFAULT_VIG /
    // VIG_BY_SPORT for the sport is already >= this, base vig drives the
    // price and lowering the floor is a no-op. Tune DEFAULT_VIG too.
    vigPropFloor: parseFloat(process.env.VIG_PROP_FLOOR) || 0.02,
    // Threshold on NBA series_winner favorite pricing. If our fair prob
    // for an NBA series_winner favorite exceeds this cutoff (default
    // -250 = 250/350 = 0.7143 fair prob), we quote at DK's posted book
    // price directly instead of our de-vigged-plus-vig number — avoids
    // drifting out of market on extreme favorites where our ramp would
    // produce an uncompetitive line. Applies to series_winner only;
    // series_spread and series_total pass through normally.
    // Tightened -1000 → -500 → -250 over iterations as we measured
    // heavy favorites as a meaningful chunk of NBA series bleed.
    // Tunable via NBA_SERIES_FAV_CAP_ODDS env var.
    nbaSeriesFavoriteCapAmericanOdds: parseInt(process.env.NBA_SERIES_FAV_CAP_ODDS) || -250,
    // Heavy-favorite MONEYLINE decline caps, per sport. A parlay with a
    // moneyline leg whose fair prob exceeds the sport's threshold is declined
    // (originally a guard against a PX sign-flip that overpaid heavy chalk).
    // JSON map: sport -> American odds cap (negative). Threshold prob =
    // |cap|/(|cap|+100). Absent sport OR value 0 = NO cap (allow all). Was
    // hardcoded (NBA -300, tennis/MMA -450); defaults preserve those exactly.
    // Loosen via HEAVY_FAV_ML_CAP_BY_SPORT to run the overpay test — e.g.
    //   {"tennis":-600,"mma_mixed_martial_arts":-600}
    // (merges over defaults, so NBA stays -300). Set a sport to 0 to remove
    // its cap entirely once the test clears it.
    heavyFavMlCapBySport: (() => {
      const defaults = { basketball_nba: -300, tennis: -450, mma_mixed_martial_arts: -450 };
      const raw = process.env.HEAVY_FAV_ML_CAP_BY_SPORT;
      if (!raw || !raw.trim()) return defaults;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out = { ...defaults };
          for (const [k, v] of Object.entries(parsed)) {
            const n = parseFloat(v);
            if (Number.isFinite(n)) out[k] = n; // 0 allowed = disable cap for that sport
          }
          return out;
        }
      } catch (e) { /* bad JSON — fall through to defaults */ }
      return defaults;
    })(),
    // Cap the favorite side's share of the book's overround during
    // 2-way de-vig. Proportional de-vig (share = favImplied/sumImplied)
    // over-corrects heavy favorites — on DK -3000/+1300 it strips ~4pp
    // off the favorite and leaves our fair ~15pp looser than DK posts.
    // Capping at 0.5 is the standard "additive margin" method: each side
    // absorbs at most half the overround. Only binds once favorite
    // implied share exceeds the cap (i.e., any 2-way with a meaningful
    // favorite); coinflips are unaffected. Tunable via
    // DEVIG_FAV_MAX_SHARE env var — lower values (0.3-0.4) bias harder
    // toward DK's posted on heavy favs.
    devigFavMaxShare: parseFloat(process.env.DEVIG_FAV_MAX_SHARE) || 0.5,
    // Minimum per-leg vig for MMA legs (moneyline + total rounds).
    // MMA is a low-competition market on PX and DK's per-leg vig is
    // ~4-5%; we can widen without losing flow. Applied as a floor on
    // top of the normal baseVig + favorite ramp. Tunable via
    // VIG_MMA_MIN env var.
    vigMmaMin: parseFloat(process.env.VIG_MMA_MIN) || 0.03,
    // Minimum per-leg vig for golf_matchups when sourcing fair from
    // DataGolf (i.e., when no operator manual upload exists for the
    // specific player+round). DataGolf publishes near-fair de-vigged
    // probabilities, so the default base vig produces ~0.7% pair vig
    // — too tight on a market where DataGolf's model has meaningful
    // uncertainty round-to-round. Mike caught this 2026-05-14 on R2
    // PGA Championship matchups quoted pre-upload at -106/+103 ties.
    //
    // Floor applies ONLY to DataGolf-sourced legs; manual uploads
    // (via /betonline-zurich/upload) use bookPriceOverride and bypass
    // vig entirely. Set 0 to disable the floor.
    //
    // 0.04 starting recommendation (= 4% per side, ~2% pair vig on
    // coinflip matchups). Tune up if win-rate stays elevated.
    vigGolfMatchupMin: parseFloat(process.env.VIG_GOLF_MATCHUP_MIN) || 0.04,
    // First-5-innings (F5) min per-leg vig. The settlement analysis found F5
    // totals under-won by 7.6pp and F5 run lines by 12.8pp — our fair runs
    // optimistic on this thin sub-market. Floors the vig on any first_5_*
    // leg. Default 0 (no change); recommended activation ~0.05 (5%) — F5 is
    // low volume, so a wide floor costs little and closes the leak.
    vigF5Min: parseFloat(process.env.VIG_F5_MIN) || 0,
    // Full-game spread / run-line min per-leg vig. Run lines under-won by
    // 3.9pp and were ~99% softer than sharp-book consensus (spread de-vig
    // fair ~4pp optimistic). Floors vig on market==='spread' legs. Default 0;
    // recommended activation ~0.025 (2.5%).
    vigSpreadMin: parseFloat(process.env.VIG_SPREAD_MIN) || 0,
    // Minimum PAIR overround for SINGLE-LEG golf-matchup offers (operator
    // 2026-06-04: "18 ticks minimum", e.g. -109 vs -109 on a coinflip). The
    // raw-book quote path (BetOnline/Bovada round matchups) can run near-pickem,
    // well under our per-leg floor, and the 1-tick sweetener narrows it further.
    // This guarantees a minimum total margin: golf-single-leg.js floors each
    // side at fair + (this / 2), so the offered pair sums to >= 1 + this. Only
    // widens — book lines already wider than the floor keep their price. 0.043 =>
    // -109/-109 on a 50/50. 0 disables. Single-leg book only (not RFQ pricing).
    golfMatchupMinPairVig: parseFloat(process.env.VIG_GOLF_MATCHUP_MIN_PAIR) || 0.043,
    // Single-leg-account matchup sweetener — applied ONLY to the second
    // (single-leg) PX account when posting golf matchup wagers via
    // services/golf-single-leg.js. Independent of the parlay SP vig stack
    // above so Mike can quote matchups WIDE on the single-leg book without
    // disturbing parlay-SP pricing.
    //
    // Formula: offered_implied = fair_implied × (1 + GOLF_SL_MATCHUP_SWEETENER_PCT)
    // applied symmetrically per side. Reference: Caesars typically posts
    // matchups around -125 / -105 on a 50/50 fair, which is ~7% markup
    // per side / ~6.8% pair vig. Default 0.07 produces that shape.
    //
    // Bypasses pricer.computeSingleLegQuote entirely when this is > 0 AND
    // the line is sport=golf_matchups. When set to 0, falls back to the
    // shared computeSingleLegQuote path (useful if Mike wants to disable
    // the override and let the parlay-SP vig stack apply).
    golfSlMatchupSweetenerPct: parseFloat(process.env.GOLF_SL_MATCHUP_SWEETENER_PCT) || 0.07,
    // Single-leg "1-tick sweetener" (operator request 2026-06-03). On the
    // single-leg book ONLY, post N PX odds-ladder rungs BETTER than the
    // auto/book price on each side to attract action — we hold the complement.
    // 1 → a -110/-110 book becomes -109/-109 offered (we hold +109 on both
    // sides). 0 disables. RFQ parlay-SP pricing is unaffected. Manual per-line
    // overrides are NOT sweetened (the operator typed the exact price they want).
    // Applied in services/golf-single-leg.js:_computeOffered, the single source
    // of both the displayed "Our Offered" and the posted complement.
    golfSlSweetenTicks: (() => {
      const n = parseInt(process.env.GOLF_SL_SWEETEN_TICKS, 10);
      return Number.isInteger(n) && n >= 0 ? n : 1;
    })(),
    // Longshot vig widening: add extra vig on low-PARLAY-fair-prob quotes
    // (long odds). Per-leg favorite ramp only fires above fairProb 0.5 —
    // it doesn't help multi-leg parlays made of dog legs, which hit a low
    // parlay-product fair prob without any single leg triggering the ramp.
    // Observed (2026-04-23): our parlay offer avg sits +0.76pp above fair
    // while Pinnacle averages +1.11pp on comparable parlays, with the
    // biggest gap in the low-prob region. Bettors are less price-sensitive
    // on long odds — an extra 20¢ on a +500 offer is invisible to them
    // but is meaningful EV for us.
    //
    // Formula: if parlayFairProb < threshold, add a linear ramp that
    // peaks at maxAdd when parlayFairProb → 0:
    //   ramp = maxAdd * (1 - parlayFairProb / threshold)
    //
    // Sample with threshold=0.25, maxAdd=0.010:
    //   parlayFair=0.05 → +0.8pp vig
    //   parlayFair=0.10 → +0.6pp
    //   parlayFair=0.15 → +0.4pp
    //   parlayFair=0.20 → +0.2pp
    //   parlayFair≥0.25 → 0 (no change)
    //
    // Applied in both parlay-level and per-leg modes. Set maxAdd=0 to
    // disable. Tunable via VIG_LONGSHOT_THRESHOLD and VIG_LONGSHOT_MAX_ADD.
    vigLongshotThreshold: parseFloat(process.env.VIG_LONGSHOT_THRESHOLD) || 0.25,
    vigLongshotMaxAdd: parseFloat(process.env.VIG_LONGSHOT_MAX_ADD) || 0.010,
    // Fixed pp floor on distance from fair (parlay-level). MAX-gates the
    // final offered_implied_prob against (fair_parlay_prob + VIG_MIN_PP/100).
    // Closes the longshot gap where multiplicative vig collapses to ~0pp
    // at low fair probs (e.g., parlayFair=2% × 5% relative vig = 0.1pp
    // distance — books carry +1-2pp+ in same zone). 0 disables (default).
    vigMinPp: (() => {
      const v = parseFloat(process.env.VIG_MIN_PP);
      if (!Number.isFinite(v) || v < 0) return 0;
      return v;
    })(),
    // Minimum theoretical edge gate. After all pricing adjustments, if our
    // final edge (offeredImplied − fairParlayProb) / fairParlayProb × 100 is
    // below this floor, decline rather than quote. Calibration data shows that
    // ≤1% theo-edge quotes are systematically money-losing (z=−4.33 in the
    // +501–1000 range): model estimation error consumes the margin.
    // Default 0 = disabled. Set MIN_THEO_EDGE_PCT=1.0 to cut the low-edge tail.
    minTheoEdgePct: (() => {
      const v = parseFloat(process.env.MIN_THEO_EDGE_PCT);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    })(),
    // Cross-sport additive vig bump. When legs span 2+ different sports,
    // adds this many pp to the final offered implied prob. Bettors who
    // combine MLB+NBA or MLB+NBA+NHL show multi-sport expertise and produce
    // worse-than-model outcomes (z=−2.66 to −2.90). A small bump covers
    // the correlation blind spot. Default 0 = disabled.
    // Set CROSS_SPORT_VIG_BUMP_PP=0.5 to add 0.5pp on multi-sport parlays.
    crossSportVigBumpPp: (() => {
      const v = parseFloat(process.env.CROSS_SPORT_VIG_BUMP_PP);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    })(),
    // Fair-prob multiplier markup. Mirrors how Pinnacle / DK / FD price
    // parlays — the pp distance from fair grows linearly with fair_prob
    // because their markup is applied as a fraction of fair_prob rather
    // than (1 - vig) on payout. Our existing payout-based vig formula
    // produces a roughly FLAT pp-distance curve across fair (or even
    // slightly decreasing); books slope upward.
    //
    // When vigFairMultiplier > 0, after computing offeredImpliedProb via
    // the existing payout formula, we compute a candidate offered prob
    // as fair × (1 + vigFairMultiplier) and take the MAX of the two.
    // Means at LOW fair the existing longshot ramp still dominates;
    // at HIGH fair (where the payout formula gives a tiny pp gap) the
    // multiplier kicks in and produces a Pinnacle-shaped curve.
    //
    // Sample with vigFairMultiplier=0.04:
    //   fair=10% → multiplier offered = 10.4% → +0.4pp
    //   fair=20% → multiplier offered = 20.8% → +0.8pp
    //   fair=40% → multiplier offered = 41.6% → +1.6pp
    //
    // Default 0 = disabled (current behavior). Tunable via
    // VIG_FAIR_MULTIPLIER env var.
    vigFairMultiplier: parseFloat(process.env.VIG_FAIR_MULTIPLIER) || 0,
    // Heavy-favorite fair markup. Per-leg fair-shaped widening that
    // fires only when a leg's fair_prob exceeds vigHeavyFavThreshold.
    // Applied as MAX(payout-vig offered, fair × (1 + markup)) on
    // qualifying legs. Mirrors the VIG_FAIR_MULTIPLIER MAX gate but is
    // per-leg and gated to chalk; gives DK-retail-like markup on
    // -300+ favorite legs without affecting coinflip or longshot legs.
    //
    // Why exists: payout-vig markup on chalky legs is microscopic
    // because payout is small (-400 fav has payout 0.25, so 5% vig
    // = 1.25pp shift). Worse, the payout-vig pp-distance is geometrically
    // FLAT — distance ≈ p·(1-p)·v peaks at a coinflip and shrinks toward
    // both ends, so the favorite-slope ramp can't bend the curve upward.
    // Books apply markup as a fraction of fair_prob (offered = p·(1+m)),
    // giving distance = p·m — linear and RISING with p, matching the
    // Single-Leg chart's book curves. This knob reproduces that shape.
    //
    // Tuning: distance ≈ fair_prob × markup once above threshold. To match
    // Pinnacle (~+1.7pp at a median ~0.65 favorite) set markup ≈ 0.027 and
    // LOWER the threshold to ~0.50 so it covers the whole favorite range
    // (not just chalk) — that is the fix for the flat tennis curve.
    // Note: also marks up high-prob player-prop legs; dial back via a
    // prop exclusion if favorite-heavy prop parlays stop filling.
    // Default 0 = disabled (Railway env is the live lever).
    vigHeavyFavFairMarkup: parseFloat(process.env.VIG_HEAVY_FAV_FAIR_MARKUP) || 0,
    vigHeavyFavThreshold: parseFloat(process.env.VIG_HEAVY_FAV_THRESHOLD) || 0.70,
    // UPPER fair-prob cap on the generic heavy-fav markup. Above this fair
    // prob the markup is SKIPPED — extreme chalk is where (a) our de-vig
    // already tends to under-rate the favorite (the >0.85 bucket where Pin/DK
    // sit BELOW our fair), so adding margin double-counts, and (b) a markup
    // can push the price past PX's reject threshold. Without this cap the
    // markup applied to any leg above the threshold up to 0.99 — the exact
    // safety gap that made VIG_HEAVY_FAV_FAIR_MARKUP unsafe to enable env-only.
    // Default 0.85. Set to 1 to disable the cap (old behavior).
    vigHeavyFavFairCap: parseFloat(process.env.VIG_HEAVY_FAV_FAIR_CAP) || 0.85,
    // Soccer Draw-No-Bet favorite markup. SCOPED to DNB legs only (PX
    // "Moneyline (2 Way)" / "Draw No Bet" — lineInfo.isDNB). Same fair-shaped
    // mechanism as vigHeavyFavFairMarkup (offered = p·(1+m), MAX-gated so it
    // can only WIDEN), but a separate knob so we can charge real margin on DNB
    // favorites without re-rating every NBA/MLB/tennis chalk leg.
    //
    // Why exists: DNB favorites are where the payout-multiplicative vig is most
    // impotent — a 5-leg all-favorite DNB parlay (e.g. Japan/Argentina/France/
    // England/Colombia, fair 47%) priced out at +103 with only ~0.96%/leg
    // effective margin while FanDuel's DNB betslip carried ~5.5%/leg. Our FAIR
    // was correct (it matches Pinnacle's actual de-vigged DNB market); the leak
    // was margin, not probability. This knob takes the margin on the implied
    // prob so it actually bites as fair→1. Root-cause: 3-agent workflow
    // 2026-06-20 (parlay 019ee30e), see memory soccer-dnb-undervig-rootcause.
    //
    // Tuning: distance ≈ fair_prob × markup per leg, compounding across legs.
    // Simulated against parlay 019ee30e: 0.035→quote ~-121, 0.04→~-127,
    // 0.05→~-138 (all inside FD's -154, all +EV vs the +103 that got picked
    // off). Recommended start VIG_DNB_FAV_MARKUP=0.04. Threshold 0.55 covers
    // the whole favorite range (not just chalk) since DNB dogs are rare on PX.
    // Default 0 = disabled — the code deploy is a no-op until this env is set.
    vigDnbFavMarkup: parseFloat(process.env.VIG_DNB_FAV_MARKUP) || 0,
    vigDnbFavThreshold: parseFloat(process.env.VIG_DNB_FAV_THRESHOLD) || 0.55,
    // UPPER fair-prob cap on the DNB markup. Higher than the generic cap
    // (0.92 vs 0.85) because DNB favorites legitimately run hot — the leak is
    // real all the way up the DNB favorite range — but still guards the most
    // extreme DNB chalk against reject risk. The sim that calibrated 0.04
    // (parlay 019ee30e) had no leg above ~0.85, so 0.92 leaves headroom and is
    // a safety backstop, not an active constraint at the recommended markup.
    // Default 0.92. Set to 1 to disable.
    vigDnbFavCap: parseFloat(process.env.VIG_DNB_FAV_CAP) || 0.92,
    // Chalk-stack parlay surcharge. Parlay-level fair-shaped widening
    // that fires only when EVERY leg of a multi-leg parlay is a
    // favorite (fair_prob > vigChalkStackLegThreshold) AND the parlay's
    // combined fair exceeds vigChalkStackParlayThreshold (parlay isn't
    // a longshot). Applied via MAX gate after VIG_FAIR_MULTIPLIER.
    //
    // Why exists: stacking 3-4 heavy favorites compounds to a
    // near-coinflip parlay; bettors love this shape and books charge
    // an outsized chalk-stack premium (DK +101 where our fair-driven
    // pricing produces +120). This knob lets us approach DK-style
    // pricing on chalk stacks without touching single-leg quotes or
    // mixed parlays. Default 0 = disabled.
    vigChalkStackSurcharge: parseFloat(process.env.VIG_CHALK_STACK_SURCHARGE) || 0,
    vigChalkStackLegThreshold: parseFloat(process.env.VIG_CHALK_STACK_LEG_THRESHOLD) || 0.60,
    vigChalkStackParlayThreshold: parseFloat(process.env.VIG_CHALK_STACK_PARLAY_THRESHOLD) || 0.25,
    // Per-leg-count vig multiplier. Applied parlay-level AFTER all per-leg
    // and chalk-stack adds, multiplying the effective vig (offered/fair − 1)
    // by a leg-count scaling factor. Closes the structural underpricing on
    // 4+ leg parlays where variance scales nonlinearly with leg count: a
    // single bad leg torches many wins, and Pinnacle's per-$ wagered edge
    // grows visibly with leg count in the boxed low-fair-prob region of
    // the Parlay Pricing chart. Verified 2026-05-02 7-day rolling P&L by
    // leg count: 4-leg net −$398 (longshot bombs) and 6-leg net −$237
    // (chalk stacks slipping past the no-stacking-surcharge default).
    //
    // Map keys are leg counts; missing keys default to 1.0 (no change).
    // Override live via VIG_BY_LEG_COUNT JSON env var.
    //
    // Defaults updated 2026-07-03 from the settlement analysis:
    //   - Added "3":1.15 — 3-leg parlays were the worst leg-count bucket
    //     (z=-2.62, -$13K) yet got NO leg-count premium (map started at 4).
    //   - Added 9-12 — MAX_LEGS=12 allows 9-12 leg parlays but the exact-key
    //     lookup fell through to ×1.0 for them (zero variance premium on the
    //     highest-variance tickets). 9-12 fill at ~0% anyway, so this is
    //     free tail insurance on the rare one that does.
    //   - Raised 5-8 (1.5/1.75/2/2.5 -> 2/2.75/3.5/4.5): the 5-leg band
    //     under-won by 6pp; Pinnacle's per-$ edge scales super-linearly with
    //     leg count in the boxed region.
    vigByLegCount: (() => {
      const defaults = { 3: 1.15, 4: 1.25, 5: 2.0, 6: 2.75, 7: 3.5, 8: 4.5, 9: 5.5, 10: 6.5, 11: 7.5, 12: 8.5 };
      try {
        const raw = process.env.VIG_BY_LEG_COUNT;
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(parsed)) {
            const n = parseInt(k, 10);
            const m = parseFloat(v);
            if (Number.isFinite(n) && Number.isFinite(m) && m >= 0) out[n] = m;
          }
          return Object.keys(out).length ? out : defaults;
        }
      } catch (e) { /* bad JSON — fall through to defaults */ }
      return defaults;
    })(),
    // Template-exposure ramp: penalizes bets whose canonical parlay signature
    // (sorted team+market+line tuple) has already confirmed N times inside a
    // rolling window. Catches the April 18 failure mode: multiple bettors
    // stacking the IDENTICAL parlay — a hidden correlation dimension the
    // existing team/event exposure caps can't see. See
    // services/template-exposure.js for mechanism + empirical derivation.
    //
    // Defaults calibrated from 9-day (Apr 14-22) counterfactual analysis:
    // blocking the 4th+ same-template bet would have avoided $5,443 in
    // losses at a cost of $64 in foregone wins across the window.
    //
    // Tier adds are ADDITIVE to the base vig (same units as vigLongshotMaxAdd).
    // Capped downstream in the pricer at 0.20 so they can't stack runaway.
    templateRampEnabled:
      process.env.TEMPLATE_RAMP_ENABLED !== 'false' && process.env.TEMPLATE_RAMP_ENABLED !== '0',
    templateRampWindowHours: parseFloat(process.env.TEMPLATE_RAMP_WINDOW_HOURS) || 24,
    templateRampTier2Add: parseFloat(process.env.TEMPLATE_RAMP_TIER2_ADD) || 0.0025,  // +0.25pp on 2nd bet
    templateRampTier3Add: parseFloat(process.env.TEMPLATE_RAMP_TIER3_ADD) || 0.010,   // +1.00pp on 3rd
    templateRampTier4Add: parseFloat(process.env.TEMPLATE_RAMP_TIER4_ADD) || 0.030,   // +3.00pp on 4th
    templateRampDeclineAt: parseInt(process.env.TEMPLATE_RAMP_DECLINE_AT) || 4,       // decline 5th+ bet (priorCount >= 4)
    // DOLLAR-aggregate cap per signature. The count cap above (declineAt) and
    // the cooldown below are count/time-aware but DOLLAR-blind: up to
    // (declineAt) spaced-out copies of one signature can each carry full stake
    // before the count cap bites. The May-06 forensic (4× "Total Runs Over 9 |
    // Over 9" at ~$2,750 each = $11k on one signature, all won) showed the
    // residual: the count cap declined the 4th, but copies 1-3 (~$8.2k) still
    // landed. This caps the in-window AGGREGATE confirmed+pending stake on a
    // signature — once prior copies sum to >= this, further RFQs on the SAME
    // signature decline regardless of count or timing. The FIRST bet on a
    // signature is always allowed (priorCount==0 bypasses). Set 0 to disable.
    // Recommended start ~2000-3000 (a 2nd identical multi-leg ticket above this
    // is the copy-flood pattern, not organic flow). Default 0 = off (operator
    // sets the live lever, like the other ramp knobs' magnitudes).
    templateRampMaxStake: parseFloat(process.env.TEMPLATE_RAMP_MAX_STAKE) || 0,
    // Short-window cooldown: decline any RFQ on a signature whose most
    // recent confirmation landed within the last N seconds, regardless of
    // counterparty. Layers on top of the 24h decline-at-N tier — closes
    // the timing race where multiple bettors copy the same parlay seconds
    // apart, before the per-template ramp's confirm-feedback can catch up.
    // Set to 0 to disable.
    templateRampCooldownSeconds: parseInt(process.env.TEMPLATE_RAMP_COOLDOWN_SECONDS) || 60,
    // Per-TEAM cooldown — broader gate than the template (same-signature)
    // cooldown above. Triggers when any single team in a new RFQ was already
    // present in a recently-confirmed parlay, regardless of the other legs.
    // Closes the bot pattern Mike caught 2026-05-13: same target team
    // (Seattle Storm) rotated across multiple parlays in 30 seconds, paired
    // with different 2nd legs (Det -4, then Det -4, then Cle +4). The
    // signature-level cooldown didn't catch it because the leg-sets differed.
    // Defaults to templateRampCooldownSeconds if TEAM_COOLDOWN_SECONDS is
    // unset, so operators who already tuned the template cooldown get the
    // team cooldown for free at the same window. Set 0 to disable.
    teamCooldownSeconds: (() => {
      const explicit = parseInt(process.env.TEAM_COOLDOWN_SECONDS);
      if (Number.isFinite(explicit) && explicit >= 0) return explicit;
      return parseInt(process.env.TEMPLATE_RAMP_COOLDOWN_SECONDS) || 60;
    })(),
    // On-demand line resolution at RFQ time.
    // TRUE  (default, legacy): when an RFQ has legs we haven't seeded,
    //   AWAIT resolveUnknownLine() for each unknown leg before pricing.
    //   This lets us quote the RFQ if the resolve succeeds — but it costs
    //   ~50-150ms inline per slow resolve, which loses timestamp
    //   tiebreakers against SPs whose cache is warm.
    // FALSE (fast mode): KICK OFF resolveUnknownLine() async (fire-and-
    //   forget) so the cache gets warmed for the NEXT RFQ on the same
    //   line, but DECLINE this RFQ immediately (no inline wait). p95
    //   latency drops from ~96ms to <5ms; we miss the very first RFQ
    //   on each new line as unknown_legs, but subsequent RFQs on the
    //   same line price normally once the async resolve completes.
    //
    // Set RESOLVE_INLINE_ON_RFQ=false to enable fast mode.
    resolveInlineOnRfq:
      process.env.RESOLVE_INLINE_ON_RFQ !== 'false' && process.env.RESOLVE_INLINE_ON_RFQ !== '0',
    // Wall-clock cap on the entire resolveUnknownLine await batch. Prevents
    // the pxFetch 401-retry chain (refreshSession + login + retry ≈ 3×10s)
    // from consuming 29-30s of the RFQ window. After this deadline the leg
    // resolves null and the RFQ declines as unknown_line — same outcome but
    // in 2s instead of 30s. Default 2000ms. Tune via RESOLVE_INLINE_TIMEOUT_MS.
    resolveInlineTimeoutMs: (() => {
      const v = parseInt(process.env.RESOLVE_INLINE_TIMEOUT_MS);
      return Number.isFinite(v) && v > 0 ? v : 2000;
    })(),
    // Large-parlay team freeze: when a confirmed parlay's SP-side stake
    // exceeds `largeParlayFreezeSize`, freeze every team in that parlay
    // for `largeParlayFreezeSeconds`. New RFQs touching any of those
    // teams are declined as 'large_team_freeze' until the freeze expires
    // OR an operator clears it manually via POST /admin/clear-team-freeze.
    //
    // Stricter version of teamCooldownSeconds (which fires on every confirm
    // regardless of size). Gives the operator a review window before more
    // exposure can pile onto teams that just took a big fill — useful
    // when a sharp / bot lands a $5K+ parlay and you want to evaluate
    // whether to keep quoting that template.
    //
    // Both knobs default to 0 = disabled. Set both > 0 to activate.
    //   LARGE_PARLAY_FREEZE_SIZE     — minimum SP-stake threshold (USD)
    //   LARGE_PARLAY_FREEZE_SECONDS  — freeze window length
    largeParlayFreezeSize: (() => {
      const v = parseFloat(process.env.LARGE_PARLAY_FREEZE_SIZE);
      if (!Number.isFinite(v) || v < 0) return 0;
      return v;
    })(),
    largeParlayFreezeSeconds: (() => {
      const v = parseInt(process.env.LARGE_PARLAY_FREEZE_SECONDS);
      if (!Number.isFinite(v) || v < 0) return 0;
      return v;
    })(),
    // Block alt-spread quoting on listed sports. An "alt spread" is any
    // spread leg whose line value differs from the primary line:
    //   - MLB:  primary run line is always ±1.5 → anything else is alt
    //   - NHL:  primary puck line is always ±1.5 → anything else is alt
    //   - NBA:  primary spread varies per game → use lineInfo.onDemand=true
    //           (PX RFQ asked for a line that wasn't pre-registered, virtually
    //           registered by the line-manager — strong proxy for "alt")
    //
    // Comma-separated list of sport keys. Default blocks NBA/MLB/NHL based on
    // Apr 25 forensic review showing red-box (low-fair-prob) parlays —
    // disproportionately built from alt-spread legs — were the entire
    // P&L drag (-$4.9k of the -$84% red-box bleed). Set to empty string
    // ("") to disable the block, or change the list to widen / narrow it.
    blockAltSpreadSports: (process.env.BLOCK_ALT_SPREAD_SPORTS == null
      ? 'baseball_mlb,icehockey_nhl,basketball_nba'
      : process.env.BLOCK_ALT_SPREAD_SPORTS
    ).split(',').map(s => s.trim()).filter(Boolean),
    // NBA-specific carve-out within the alt-spread block: even when NBA is in
    // blockAltSpreadSports, allow alt-spread legs whose line is within
    // ±N points of the primary spread (in home-team perspective) AND has
    // book coverage in our alt-lines cache. Default 2.0 — operator wants
    // "if main is Team A −5, allow Team A −3..−7 (and equivalent dog
    // sides)" but block anything farther OR anything we'd have to derive
    // ourselves (no books reported it).
    nbaAltSpreadMaxDistance: parseFloat(process.env.NBA_ALT_SPREAD_MAX_DISTANCE) || 2.0,
    // Same idea as nbaAltSpreadMaxDistance but for the totals market.
    // If primary NBA total is O/U 215.5, allow alt totals 213.5 / 214 /
    // 214.5 / 215 / 216 / 216.5 / 217 / 217.5 (within ±2). Block farther
    // alts. Like the spread carve-out, also requires book coverage in
    // our altLines cache — no derived/inferred lines.
    nbaAltTotalMaxDistance: parseFloat(process.env.NBA_ALT_TOTAL_MAX_DISTANCE) || 2.0,
    // MLB alt run-line allowed |line| values. Discrete allowlist (not a
    // distance from primary) because a distance check of 1.0 would also
    // pull in 2.5, which is too aggressive.
    // Comma-separated env override; values are absolute (sign-agnostic).
    // 2026-05-01: Mike expanded to include 1.0 ("MLB and NHL spreads of
    // ±0.5, ±1.0, ±1.5"). Non-primary alts still require book coverage
    // in the alt-spread cache; primary ±1.5 passes without coverage check.
    mlbAllowedRunLines: (process.env.MLB_ALLOWED_RUN_LINES || '0.5,1.0,1.5')
      .split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n)),
    // NHL alt puck-line allowed |line| values. Same pattern as MLB run
    // lines — primary is ±1.5; ±0.5 and ±1.0 are alts with book-coverage
    // gating. Without this allowlist, all NHL alt puck-lines decline as
    // 'icehockey_nhl alt spread' (a hard block from blockAltSpreadSports).
    // 2026-05-01 unblocked NHL alt-spreads in this range per Mike's request
    // — was previously the dominant decline category (~4,500/day).
    nhlAllowedPuckLines: (process.env.NHL_ALLOWED_PUCK_LINES || '0.5,1.0,1.5')
      .split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n)),
    // MLB alt-total max distance from primary (default ±1.5 in any 0.5
    // step). E.g. primary 7.5 → allow 6.0/6.5/7.0/7.5/8.0/8.5/9.0.
    // Also requires book coverage in the altTotals cache.
    mlbAltTotalMaxDistance: parseFloat(process.env.MLB_ALT_TOTAL_MAX_DISTANCE) || 1.5,
    // v2 pricing engine: shadow-mode by default. When enabled, runs the
    // unified calibration-corrected + correlation-aware + EV-targeted
    // pipeline alongside v1 and logs the comparison. Does NOT affect
    // live offers until pricingV2Live is true.
    //
    // Two flags so we can ship code without behavior change:
    //   pricingV2Enabled — compute v2 alongside v1, log deltas (observation mode)
    //   pricingV2Live    — use v2 as the authoritative offer (A/B or cutover)
    //
    // Knobs:
    //   pricingV2TargetEdge — single vig parameter replacing the v1 stack
    //   pricingV2KSigma     — conservative uncertainty shift (0.5 = half-sigma)
    pricingV2Enabled:
      process.env.PRICING_V2_ENABLED === 'true' || process.env.PRICING_V2_ENABLED === '1',
    pricingV2Live:
      process.env.PRICING_V2_LIVE === 'true' || process.env.PRICING_V2_LIVE === '1',
    pricingV2TargetEdge: parseFloat(process.env.PRICING_V2_TARGET_EDGE) || 0.02,
    pricingV2KSigma: parseFloat(process.env.PRICING_V2_K_SIGMA) || 0.5,
    // A/B split control. pricingV2Live is the master kill-switch (false =
    // v2 never overrides v1, regardless of arm). pricingV2LivePercent is
    // the fraction of parlays (0-100) whose parlayId-hash falls in the
    // v2 arm. At 0, the master flag is a no-op; at 100, every parlay is
    // v2-arm. Assignment is ALWAYS recorded in meta.abArm even when
    // master is off, so analytics can attribute shadow records by arm.
    pricingV2LivePercent: (() => {
      const v = parseInt(process.env.PRICING_V2_LIVE_PERCENT);
      if (!Number.isFinite(v) || v < 0) return 0;
      if (v > 100) return 100;
      return v;
    })(),
    // Safety net: decline any total leg where our de-vigged fair diverges
    // from the simple book consensus (mean of Pin/DK/FD implied probs) by
    // more than the threshold. Backstop for the getBookPairsForTotals fix
    // in case another feed-shape edge case slips through. Limited to
    // 'total' and 'run_line' market types — the scope where the Apr-24
    // CLE @ TOR U 8.5 bug was observed (our fair 90.36% vs books 55.5%).
    // Enabled by default so fresh deploys are protected. Set
    // DECLINE_ANOMALOUS_TOTALS=false to disable; tune threshold via
    // DECLINE_ANOMALOUS_TOTALS_THRESHOLD (default 0.10 = 10pp).
    declineAnomalousTotalsEnabled:
      process.env.DECLINE_ANOMALOUS_TOTALS !== 'false' && process.env.DECLINE_ANOMALOUS_TOTALS !== '0',
    declineAnomalousTotalsThreshold: parseFloat(process.env.DECLINE_ANOMALOUS_TOTALS_THRESHOLD) || 0.10,
    // Moneyline equivalent of the totals anomaly gate. Catches the
    // staleness scenario where our cache age is within STALE_PRICE_MINUTES
    // but the underlying SharpAPI feed is delayed against live DK / FD /
    // Pin movements (especially on late lineup news in MLB / NBA /
    // injury-driven NFL ML moves). When our fair implied prob deviates
    // from the average of available book implied probs by more than
    // threshold, decline rather than offer a stale price.
    //
    // Tighter default than totals (0.05 = 5pp vs 0.10 = 10pp) because
    // moneyline implied probs cluster harder around fair than totals do
    // — a 5pp deviation on ML is unambiguous staleness; for totals 10pp
    // can still be legitimately within model variance.
    //
    // Set DECLINE_ANOMALOUS_MONEYLINE=false to disable; tune via
    // DECLINE_ANOMALOUS_MONEYLINE_THRESHOLD env var.
    declineAnomalousMoneylineEnabled:
      process.env.DECLINE_ANOMALOUS_MONEYLINE !== 'false' && process.env.DECLINE_ANOMALOUS_MONEYLINE !== '0',
    declineAnomalousMoneylineThreshold: parseFloat(process.env.DECLINE_ANOMALOUS_MONEYLINE_THRESHOLD) || 0.05,
    // Defensive decline on team_total legs. Original bug (2026-04-23
    // ATL Over 4.5 mispricing via buildConsensusTeamTotals pairing
    // mismatched Over/Under lines) was fixed at the root in commit
    // 5ad919f — getBookPairsForTeamTotals now keys on (book, side, line)
    // so Over/Under can only pair at matching lines.
    //
    // External validation (2026-04-23, 4 sides across NYY/BOS and LAD/SF):
    // our de-vigged fair now sits within ±2pp of FanDuel's fair on every
    // tested market — normal book-consensus noise, down from the pre-fix
    // ~10pp bias.
    //
    // Default flipped to FALSE here (re-enable serving) after verification.
    // Leaving the env var as an opt-in circuit breaker — set
    // DECLINE_TEAM_TOTALS=true to re-enable the defensive decline if we
    // discover a new team_total bug class.
    declineTeamTotals:
      process.env.DECLINE_TEAM_TOTALS === 'true' || process.env.DECLINE_TEAM_TOTALS === '1',
    // A/B-testable pricing mode for parlays. When true, vig is applied
    // ONCE at the parlay level using the MAX per-leg effective rate, rather
    // than compounded per-leg. Per-leg compounding penalizes multi-leg
    // parlays (a 5-leg at 2% per leg = 4.2% effective parlay vig), which
    // shows up in our data as a sharp win-rate drop at 4+ legs (28%→14%→9%).
    // Parlay-level application preserves sport-aware pricing + favorite
    // ramp (via the MAX leg's rate) while eliminating the compounding tax.
    // Toggle at runtime via POST /config/vig {parlayLevelVig:true|false}.
    parlayLevelVig: process.env.PARLAY_LEVEL_VIG === 'true' || process.env.PARLAY_LEVEL_VIG === '1',
    maxRiskPerParlay: parseFloat(process.env.MAX_RISK_PER_PARLAY) || 500,
    // Quote-time exposure checks use max_risk × otherProb as the "pending"
    // risk estimate per outstanding RFQ — but bettors essentially never
    // wager the full max. Historical fills on this cluster: median 1.7% of
    // max_risk, p90 ~14%, p99 ~62%. Without a discount, 2-3 simultaneous
    // quotes on the same team can fill up a $4k team limit in pending
    // reservations alone and block further RFQs whose actual expected risk
    // would be trivially small. This factor scales the pending + new-risk
    // numbers at check time only; confirmed exposure (real stakes) is
    // never discounted. Default 0.20 covers the p90 of historical fill
    // sizes with modest margin. 1.0 disables the discount (pre-existing
    // behavior). Tunable via PENDING_RESERVATION_DISCOUNT env var.
    pendingReservationDiscount: (() => {
      const v = parseFloat(process.env.PENDING_RESERVATION_DISCOUNT);
      if (!Number.isFinite(v) || v <= 0 || v > 1) return 0.20;
      return v;
    })(),
    maxLegs: parseInt(process.env.MAX_LEGS) || 8,
    // How many days out we'll quote games for. Governs the odds-feed warm
    // horizon: events starting beyond this window are skipped for alt-line
    // pre-warming and the DK game-line supplement (main-market ML + props
    // still register off whatever the odds source returns, but anything
    // further out won't get its supplemental coverage warmed). Expressed in
    // DAYS for operator intuition; converted to hours internally.
    //   QUOTE_HORIZON_DAYS=2  → default, ~same-day + next-day (48h)
    //   QUOTE_HORIZON_DAYS=4  → quote up to 4 days ahead (e.g. WC weeks)
    // Live-tunable in Railway (redeploy required to take effect).
    quoteHorizonHours: (() => {
      const days = parseFloat(process.env.QUOTE_HORIZON_DAYS);
      if (!Number.isFinite(days) || days <= 0) return 48; // 2 days default
      return Math.round(days * 24);
    })(),
    stalePriceMinutes: parseInt(process.env.STALE_PRICE_MINUTES) || 5,
    // Per-sport override for stale threshold (minutes). Tighter for fast-moving
    // markets (MMA/boxing move on news; NFL moves on injury reports), looser
    // for slow Odds-API fallback sports that refresh less often.
    // Falls back to stalePriceMinutes if sport not listed.
    // Mergeable via STALE_PRICE_MINUTES_BY_SPORT JSON env var so Mike can
    // tune live without a redeploy.
    stalePriceMinutesBySport: (() => {
      const defaults = {
        'mma_mixed_martial_arts': 3,
        'boxing_boxing': 3,
        'americanfootball_nfl': 4,
        'americanfootball_ncaaf': 4,
        'basketball_ncaab': 5,
        'tennis': 4,
        'basketball_wnba': 5,
        'golf_pga_championship': 5,
        // MLB game-line moves on lineup news / scratches / weather within the
        // 10-min default. Verified 2026-05-02 ATL @ COL: cached Pin -168 while
        // live had moved to -199 (~7pp implied jump) on lineup news. Tighten to
        // 3 min so the next move triggers a re-fetch before the next RFQ.
        'baseball_mlb': 3,
        // Golf matchups come from DataGolf and only refresh on the main 10-min
        // cycle (not in the SharpAPI delta or Odds-API fast-refresh loops), so
        // the effective worst-case cache age is ~10 min + fetch time. A 25-min
        // threshold gives a 15-min buffer over the refresh interval — matchup
        // lines between comparable golfers are stable enough that a somewhat
        // older consensus is still tradeable.
        'golf_matchups': 25,
      };
      try {
        const raw = process.env.STALE_PRICE_MINUTES_BY_SPORT;
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return { ...defaults, ...parsed };
      } catch (e) {
        // bad JSON — fall through to defaults
      }
      return defaults;
    })(),
    // Confirmation-time re-price drift threshold. If current fair prob drifts
    // by more than this fraction from the original quote, reject the confirm.
    confirmationDriftThreshold: parseFloat(process.env.CONFIRMATION_DRIFT_THRESHOLD) || 0.03,
    offerValidSeconds: parseInt(process.env.OFFER_VALID_SECONDS) || 60,
    // Prop-containing parlays get a shorter offer validity: prop prices move
    // on lineup/usage news faster than team lines, and 60s of free option
    // time on a prop quote is a pick-off window. (SGP roadmap Stage 0.)
    offerValidSecondsProp: parseInt(process.env.OFFER_VALID_SECONDS_PROP) || 30,
    // Prop-leg staleness gate (replaces the hardcoded 15-min STALE_MS in
    // pricer's prop_stale check). DEFAULT PRESERVES the old 900s behavior —
    // adversarial review caught that a tighter default is incoherent with
    // the SHIPPED cadence defaults (TOA prop TTL 300s, refresh-ahead 180s,
    // line-refresh interval default 10 min): lineInfo.propFetchedAt is a
    // SEED-TIME snapshot, so worst-case healthy age = TTL + refresh
    // interval + seed duration, which exceeds any tight gate on defaults —
    // mass prop_stale declines AND fail-closed confirm walk-aways.
    // Tighten ONLY as a package via Railway env:
    //   STALE_PROP_SECONDS=420 + TOA_PROP_TTL_SECONDS=150 +
    //   TOA_PROP_REFRESH_AHEAD_SECONDS=90 + REFRESH_INTERVAL_MINUTES=2
    // (gate must exceed TTL + refresh interval + ~90s seed, with headroom).
    stalePropSeconds: parseInt(process.env.STALE_PROP_SECONDS) || 900,
    maxExposurePerTeam: _capNum(process.env.MAX_EXPOSURE_PER_TEAM, 5000),
    // Raw vs probability-weighted per-team exposure measurement (PRIMARY cap).
    //
    // FALSE (default, 2026-05-14): per-team exposure counted each parlay leg's
    //   contribution as `payout × P(other legs win)`. A 4-leg parlay at
    //   $5K max risk where the other 3 legs combined to ~25% fair contributed
    //   only ~$1.25K to its team's bucket. Tolerates more parlays per team
    //   before the cap binds — favors fill velocity.
    // TRUE  (2026-05-13 experiment, reverted 2026-05-14): each parlay
    //   contributes its FULL `payout` (= max_risk) to every team it
    //   touches. Simpler/more conservative but with MAX_RISK_PER_PARLAY=7000
    //   it effectively gates at 1 parlay per team and was choking fill
    //   velocity. Operator preferred to revert primary measurement to
    //   weighted and use a separate RAW HARD-CAP for the worst-case bound.
    //
    // The raw hard-cap (`maxRawExposurePerTeam`) below operates
    // INDEPENDENTLY of this flag — both gates are applied.
    useRawPerTeamExposure:
      process.env.USE_RAW_PER_TEAM_EXPOSURE === 'true' || process.env.USE_RAW_PER_TEAM_EXPOSURE === '1',
    // Raw HARD CAP on per-team exposure — additional safety brake beyond
    // the (weighted) `maxExposurePerTeam` cap. Each parlay's full
    // `payout` (un-weighted) is summed per team; if the running total
    // (confirmed + pending × discount + new) exceeds this number, the
    // parlay is declined regardless of whether the weighted cap passed.
    //
    // Use when you want to keep weighted measurement (for fill velocity)
    // but bound worst-case directional concentration. Set 0 to disable.
    //
    // Recommended sizing relative to MAX_RISK_PER_PARLAY:
    //   3× → allows 3 fully-exposed parlays per team
    //   4× → allows ~4 parlays per team
    // With MAX_RISK_PER_PARLAY=7000, $25K-$30K is a sensible starting
    // bound. Tune via MAX_RAW_EXPOSURE_PER_TEAM env var.
    maxRawExposurePerTeam: (() => {
      const v = parseFloat(process.env.MAX_RAW_EXPOSURE_PER_TEAM);
      if (!Number.isFinite(v) || v < 0) return 0;
      return v;
    })(),
    // Per-team exposure overrides. JSON map of team/fighter name → cap dollars.
    // Looked up FIRST during exposure checks; falls back to maxExposurePerTeam
    // when a team has no entry. Use this to tighten exposure on specific
    // teams/fighters (e.g. a few MMA chalk favorites already in multiple
    // parlays) without lowering the global cap that protects every other
    // team in every other sport.
    //
    // Lookup is case-insensitive after the same normalizeExposureKey
    // canonicalization the exposure map itself uses, so spelling
    // variations resolve consistently. Names not normalizable (empty
    // strings) are ignored.
    //
    // Example:
    //   EXPOSURE_OVERRIDES_PER_TEAM={"Islam Makhachev":500,"Alex Pereira":500}
    //
    // Set/edit on Railway without a code push.
    exposureOverridesPerTeam: (() => {
      const raw = process.env.EXPOSURE_OVERRIDES_PER_TEAM;
      if (!raw || !raw.trim()) return {};
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out = {};
        for (const [name, cap] of Object.entries(parsed)) {
          const num = parseFloat(cap);
          if (Number.isFinite(num) && num > 0) out[name] = num;
        }
        return out;
      } catch (e) {
        // Bad JSON — log via console (logger not available at config-load time)
        console.warn(`[config] EXPOSURE_OVERRIDES_PER_TEAM is not valid JSON: ${e.message}`);
        return {};
      }
    })(),
    // Per-team RAW HARD-CAP overrides. Same shape as exposureOverridesPerTeam
    // but consulted by the independent raw hard-cap gate (MAX_RAW_EXPOSURE_PER_TEAM).
    // Lets you tighten the gross-exposure cap on a single team without lowering
    // the global default. Example:
    //   RAW_EXPOSURE_OVERRIDES_PER_TEAM={"New York Knicks":3000}
    rawExposureOverridesPerTeam: (() => {
      const raw = process.env.RAW_EXPOSURE_OVERRIDES_PER_TEAM;
      if (!raw || !raw.trim()) return {};
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out = {};
        for (const [name, cap] of Object.entries(parsed)) {
          const num = parseFloat(cap);
          if (Number.isFinite(num) && num > 0) out[name] = num;
        }
        return out;
      } catch (e) {
        console.warn(`[config] RAW_EXPOSURE_OVERRIDES_PER_TEAM is not valid JSON: ${e.message}`);
        return {};
      }
    })(),
    // Max number of currently-open parlays from the SAME creator that may
    // share a single leg. Defends against one bettor laddering many
    // 2-leg parlays with a constant anchor leg + rotating second leg
    // (the SIGNATURE cooldown rotates with the second leg, so without
    // this gate one creator can accumulate concentrated exposure on
    // a single outcome — see 2026-05-20 Knicks ML stack: 5 parlays from
    // one creator, $15.1K gross risk, -$303 EV from line moves). 0
    // disables; default 2 (one initial bet + one follow-up allowed,
    // 3rd+ sharing the same leg is declined).
    maxParlaysPerCreatorLeg: (() => {
      const v = parseInt(process.env.MAX_PARLAYS_PER_CREATOR_LEG, 10);
      if (!Number.isFinite(v) || v < 0) return 2;
      return v;
    })(),
    // Phase 2 prop quoting caps — applies to ANY parlay containing one
    // or more player_prop legs (NBA points/rebounds/assists/threes,
    // NHL shots_on_goal, MLB pitcher_strikeouts, etc.). Game-line-only
    // parlays use the standard MAX_RISK_PER_PARLAY ($4000). Tunable via
    // env vars.
    maxRiskPerParlayWithProp: parseFloat(process.env.MAX_RISK_PER_PARLAY_WITH_PROP) || 50,
    // DEPRECATED 2026-05-01: pitcher_strikeouts is now governed by the
    // unified MAX_EXPOSURE_PER_PLAYER_* system. This var is kept for
    // backward-compat reads (some legacy logs / instrumentation still
    // reference it) but does NOT drive quote-time gating anymore.
    // Configure MLB pitcher caps via MAX_EXPOSURE_PER_PLAYER_BY_SPORT
    // (e.g. {"baseball_mlb": 2000}) or MAX_EXPOSURE_PER_PLAYER_DEFAULT.
    maxExposurePerPitcher: parseFloat(process.env.MAX_EXPOSURE_PER_PITCHER) || 500,
    // Per-player aggregate exposure cap, keyed by sport. Sums SP-risk
    // across ALL parlays containing ANY prop leg featuring that player,
    // regardless of prop type — so CJ McCollum points + rebounds +
    // threes parlays all roll up to one McCollum line. Critical for
    // cross-prop concentration where one star anchors many tickets.
    // Tunable via MAX_EXPOSURE_PER_PLAYER_BY_SPORT (JSON map). Falls
    // back to MAX_EXPOSURE_PER_PLAYER_DEFAULT for sports not listed.
    maxExposurePerPlayerBySport: (() => {
      if (!process.env.MAX_EXPOSURE_PER_PLAYER_BY_SPORT) {
        return { 'basketball_nba': 200, 'icehockey_nhl': 200 };
      }
      try {
        const parsed = JSON.parse(process.env.MAX_EXPOSURE_PER_PLAYER_BY_SPORT);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return { 'basketball_nba': 200, 'icehockey_nhl': 200 };
      } catch (e) {
        return { 'basketball_nba': 200, 'icehockey_nhl': 200 };
      }
    })(),
    maxExposurePerPlayerDefault: _capNum(process.env.MAX_EXPOSURE_PER_PLAYER_DEFAULT, 200),
    // Minimum number of books with both sides required for a prop leg
    // to be quotable. Below this, decline the parlay (insufficient
    // de-vig confidence — single-book or near-single-book pricing is
    // just re-quoting that book's vigged line). DK+FD = 2 sharp books
    // is sufficient; default lowered from 3 to 2 (2026-06-24).
    propMinBooksWithBothSides: parseInt(process.env.PROP_MIN_BOOKS_WITH_BOTH_SIDES) || 2,
    // "Book-mirror" sweetener for one-sided binary MLB hitter props
    // (hitter_hr, hitter_rbi_runs): quote the OVER at the book's RAW posted
    // price minus this fraction (sweeter for the counterparty), via
    // bookPriceOverride — no de-vig+vig. Prefer the real DK number (scraper) as
    // the basis, fall back to the feed's raw posted consensus. Raised
    // 0.5% -> 3% on 2026-06-24: these legs BYPASS the vig path entirely, so
    // the sweetener is the ONLY competitiveness lever on them — at 0.5% we
    // inherited nearly the book's full over-juice and won 0 fills. 3% still
    // leaves positive margin vs fair on typical book juice; push toward 5%
    // with fill-rate monitoring. Set 0 for a pure match.
    propBookMirrorSweetener: process.env.PROP_BOOK_MIRROR_SWEETENER !== undefined
      ? parseFloat(process.env.PROP_BOOK_MIRROR_SWEETENER) : 0.03,
    // Max distance (in stat units) the requested prop line can sit
    // from the primary line for that (player, propType) before we
    // decline. Default ±2 — restricts quoting to near-primary alts
    // where book coverage is dense and bettor edge from "deep alt"
    // mispricing is bounded. Set 0 to allow only primary; set very
    // large (e.g. 99) to disable the cap.
    //
    // Primary line is determined by the line value with the most
    // bookmaker coverage in TOA's per-event response (most books
    // posting both sides → that's the line they all anchor on).
    propAltLineMaxDistance: parseFloat(process.env.PROP_ALT_LINE_MAX_DISTANCE) || 2.0,
    // Heavy-favorite floor protection on prop fair probs. Proportional
    // de-vig systematically underestimates the true prob on lopsided
    // 2-way prop markets — books' vigged price already captures
    // information the de-vig can't recover. When the de-vigged side prob
    // exceeds propHeavyFavFloorThresh (heavy favorite), floor it at the
    // average book vigged implied minus propHeavyFavFloorBuffer, so we
    // never quote below the books' own implied estimates of the true
    // probability. Verified 2026-05-03 hitter_hits leak: Heliot Ramos
    // Over 0.5 priced at -194 (66% fair) while books had -200 (~67%
    // vigged) — we were giving away 5+pp on every heavy-fav prop quote.
    //
    // Set propHeavyFavFloorBuffer high (e.g. 0.05) to disable the floor
    // by making it always lower than the de-vig.
    propHeavyFavFloorThresh: parseFloat(process.env.PROP_HEAVY_FAV_FLOOR_THRESH) || 0.60,
    propHeavyFavFloorBuffer: parseFloat(process.env.PROP_HEAVY_FAV_FLOOR_BUFFER) || 0.005,
    // Master allowlist for live prop quoting. Comma-separated list of
    // "${sport}.${propType}" pairs. Only props in this allowlist are
    // resolved live and quoted; everything else falls into the existing
    // shadow / decline-as-unknown path. Empty allowlist = current
    // behavior (no live prop quoting). Examples:
    //   PROP_LAUNCH_ALLOWLIST="basketball_nba.points"
    //   PROP_LAUNCH_ALLOWLIST="basketball_nba.points,basketball_nba.rebounds,basketball_nba.assists,basketball_nba.threes_made,icehockey_nhl.shots_on_goal"
    propLaunchAllowlist: new Set(
      (process.env.PROP_LAUNCH_ALLOWLIST || '')
        .split(',').map(s => s.trim()).filter(Boolean)
    ),
    // Books we trust as a single source for prop pricing. When a prop
    // lookup returns exactly 1 book with both sides AND that book is on
    // this list, shouldDecline rule (b) accepts the leg instead of
    // declining for low confidence. Applies to BOTH K-prop AND the
    // Phase-2 launch props (player_points/rebounds/assists/threes/
    // shots_on_goal/hitter_*). Default list: Pinnacle (sharpest book
    // overall), FanDuel + DraftKings (US prop pricing leaders), BetMGM
    // (large US book, generally sharp), BetRivers (smaller but a
    // frequent sole-book on alt lines DK/FD don't post). Tunable via
    // PROP_TRUSTED_SINGLE_BOOKS (comma-separated, lowercase book keys).
    propTrustedSingleBooks: (process.env.PROP_TRUSTED_SINGLE_BOOKS || 'pinnacle,fanduel,draftkings,betmgm,betrivers')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // Assumed per-side book overround used by the TOA one-sided prop
    // fallback (HR, RBIs at line=0.5 — markets where books only post the
    // over because the under is heavy chalk at -1000+). The fair_prob
    // estimate = avg-of-book-over-implied ÷ (1 + overround). Smaller
    // values are conservative (smaller haircut → smaller fair → tighter
    // offer, less competitive). Larger values lower fair more (more
    // bettor-favorable offer, more risk if estimate too high). Default
    // 0.08 (~typical BetOnline/William Hill overround on HR markets).
    toaOneSidedPropOverround: (() => {
      const v = parseFloat(process.env.TOA_ONE_SIDED_PROP_OVERROUND);
      if (!Number.isFinite(v) || v < 0) return 0.08;
      return v;
    })(),
    // (Removed 2026-05-13) MAX_GROSS_PORTFOLIO_RISK — operator confirmed
    // the per-team / per-game / per-player concentration caps cover the
    // intended risk control, and a portfolio-wide gross-stake ceiling was
    // throttling fully-diversified quoting at peak hours. Per-team etc.
    // caps still active in checkExposureLimits / checkGameExposure /
    // checkPlayerExposure. Re-add this field if absolute-tail bounding is
    // ever needed again.

    // Periodic refresh of fair probs for PRE-GAME legs on confirmed parlays.
    // refreshLiveOdds handles in-progress legs only; without this, the
    // dashboard Risk Simulation and other consumers read fair probs frozen
    // at QUOTE TIME for legs whose markets may have moved since.
    //
    // When true (default), order-tracker.refreshPreGameOdds runs every 60s
    // alongside refreshLiveOdds; it re-projects oddsFeed.getFairProb onto
    // each pre-game leg as `currentFairProb`, preserving the original
    // `fairProb` for audit. legEffectiveProb prefers liveFairProb >
    // currentFairProb > fairProb.
    refreshPreGameOddsEnabled: process.env.REFRESH_PRE_GAME_ODDS !== '0',
    // Per-event aggregate cap. Sums SP-risk across ALL legs touching one
    // pxEventId (regardless of team or market), preventing two-sided
    // event stacking that the per-team cap can't see — e.g. Lakers spread
    // on parlay 1 + Hawks spread on parlay 2 + Over total on parlay 3,
    // each below team cap but together overconcentrated on the LAL @ ATL
    // game. Critical as alt-spread coverage expands: more breakpoints =
    // more ways to load up on one event.
    // Tunable via MAX_EXPOSURE_PER_GAME env var. Set 0 to disable.
    maxExposurePerGame: _capNum(process.env.MAX_EXPOSURE_PER_GAME, 5000),
    // Tighter risk caps for parlays containing series_* markets. Series
    // bets tie up bankroll for weeks until the series settles, so we
    // limit both per-parlay SP risk and aggregate per-series-event
    // exposure. Applied only when at least one leg is a series market.
    maxSeriesRiskPerParlay: parseFloat(process.env.MAX_SERIES_RISK_PER_PARLAY) || 500,
    maxSeriesGrossExposure: _capNum(process.env.MAX_SERIES_GROSS_EXPOSURE, 1000),

    // Consensus-floor guardrail. When our offered implied prob on a single
    // leg would land more than this many percentage points BELOW the
    // Pin/FD/DK consensus implied prob (i.e. we'd be more bettor-friendly
    // than market by a wide margin), clamp our offer up to consensus −
    // threshold. Protects against fair-prob plumbing bugs (selection flips,
    // wrong market mapping) where our internal fair lands far from the
    // actual market — without this clamp, we'd offer +266 on a line the
    // market prices at -128. Default 8pp; set to 0 to disable. Skipped
    // when no Pin/FD/DK price is available for the leg.
    priceFloorVsConsensusPp: parseFloat(process.env.PRICE_FLOOR_VS_CONSENSUS_PP) || 8,

    // PARLAY-LEVEL consensus cap (anti heavy-favorite-stacking leak, 2026-06-25).
    // The per-leg floor above subtracts priceFloorVsConsensusPp PER LEG and then
    // COMPOUNDS, so an N-leg parlay can be offered ~N×pp more generous than the
    // sharp Pin/FD/DK consensus parlay price — i.e. we beat the (already-vigged)
    // book on every leg and the gap stacks with leg count. Scan 2026-06-25: 70%
    // of fills were offered more generous than consensus, worst on tennis/MMA and
    // multi-leg chalk stacks. This caps TOTAL parlay generosity vs the raw
    // consensus product at a single bound regardless of leg count: offered implied
    // is floored at (Π consensus_leg) − this many pp. Because the consensus is
    // vigged, staying within ~1pp of it still leaves us well above the de-vigged
    // true fair (we keep margin) while never being exploitably more generous than
    // the books. Default 1.0pp; raise for more bettor value, lower (toward 0) to
    // match the books exactly. 0 disables. Tunable via PRICE_FLOOR_VS_CONSENSUS_PARLAY_PP.
    priceFloorVsConsensusParlayPp: process.env.PRICE_FLOOR_VS_CONSENSUS_PARLAY_PP !== undefined
      ? parseFloat(process.env.PRICE_FLOOR_VS_CONSENSUS_PARLAY_PP) : 1.0,
    // Tighter parlay-consensus cap for CHALK STACKS (every leg a favorite at
    // consensus implied >= vigChalkStackLegThreshold). Heavy-favorite stacks are
    // the adverse-selection vector (sharps pick our most-generous chalk offers)
    // AND the spot where our proportional de-vig most underrates the favorites —
    // so we don't give bettor value there. Default 0 ⇒ floor at the consensus
    // parlay price (we match the vigged books, never beat them, but the vig keeps
    // us +EV). Set to a small positive pp (e.g. 0.5) to allow a sliver of chalk
    // competitiveness. Tunable via PRICE_FLOOR_VS_CONSENSUS_PARLAY_CHALK_PP.
    priceFloorVsConsensusParlayChalkPp: process.env.PRICE_FLOOR_VS_CONSENSUS_PARLAY_CHALK_PP !== undefined
      ? parseFloat(process.env.PRICE_FLOOR_VS_CONSENSUS_PARLAY_CHALK_PP) : 0.0,

    // Same-game parlay (SGP) handling. Historically all SGPs were blocked
    // because a multiplicative correlation "boost" (+3-15%) caused PX to
    // reject with "invalid estimated prices" on any offer we pushed above
    // their internal SGP model. Now: allow specific market-pair combos,
    // applying a wider per-leg vig (sgpVigMultiplier × normal vig) instead
    // of a boost. PX accepts wider vig; it doesn't accept upward price
    // corrections vs their model.
    //
    // SGP_ALLOWED_COMBOS: comma-separated list of combo keys.
    //   'spread_total'  — spread + total on same game (moderate correlation)
    //   'ml_total'      — moneyline + total (strong correlation, −37% ROI historically)
    //   'ml_spread'     — still blocked by correlation rules regardless (highly correlated)
    //   empty string    — explicitly disables ALL SGP combos
    //   unset           — falls back to legacy default 'spread_total'
    //
    // The explicit-empty handling matters: setting SGP_ALLOWED_COMBOS=""
    // on Railway should mean "block every SGP", not "fall back to allowing
    // spread_total". Distinguish unset (undefined) from explicitly empty
    // ('') so the env var can actually disable SGPs. K-prop carve-outs
    // (kprop_ml, kprop_kprop) are auto-included downstream regardless.
    sgpAllowedCombos: (process.env.SGP_ALLOWED_COMBOS != null
      ? process.env.SGP_ALLOWED_COMBOS
      : 'spread_total'
    ).split(',').map(s => s.trim()).filter(Boolean),
    // ---- SGP EXPERIMENTAL TIER (correlated-prop combo rollout) ----
    // New, more-correlated combo classes (starting with 'prop_nested')
    // launch in a small-test tier: a much tighter per-ticket cap, a daily
    // filled-risk budget per class, and a weekly realized-P&L stop-loss
    // that auto-darks the class at runtime. Existing parlay types are
    // untouched by construction: all risk caps compose by min() and these
    // apply only to parlays whose sgpCombo is in experimentalSgpCombos.
    // A class still ALSO needs its SGP_ALLOWED_COMBOS entry to quote at
    // all — experimental membership only adds the tighter limits.
    experimentalSgpCombos: new Set((process.env.SGP_EXPERIMENTAL_COMBOS != null
      ? process.env.SGP_EXPERIMENTAL_COMBOS
      : 'prop_nested,prop_prop_xteam'
    ).split(',').map(s => s.trim()).filter(Boolean)),
    // Stage 2 cross-team prop pairs: additive band-top dependence charge.
    // q_fair = min(p1·p2 + φ·√(p1q1·p2q2), min(p1,p2)) with φ at the TOP of
    // the structurally-plausible band for cross-team binaries (shared park/
    // weather/pace common factor). Band-top is the no-regret price: a fully
    // informed counterparty faces ≤0 EV anywhere in φ∈[0,φmax]; the cost is
    // fill rate on genuinely-independent pairs, not EV. Lower only with
    // oracle/CLV evidence, never raise on a hunch.
    sgpPropXTeamPhiMax: Number.isFinite(parseFloat(process.env.SGP_PROP_XTEAM_PHI_MAX))
      ? parseFloat(process.env.SGP_PROP_XTEAM_PHI_MAX)
      : 0.15,
    maxRiskSgpExperimental: parseFloat(process.env.MAX_RISK_SGP_EXPERIMENTAL) || 15,
    sgpExperimentDailyBudget: parseFloat(process.env.SGP_EXPERIMENT_DAILY_BUDGET) || 150,
    sgpExperimentWeeklyStopLoss: parseFloat(process.env.SGP_EXPERIMENT_WEEKLY_STOP_LOSS) || 300,
    // Script-aware per-game prop exposure caps (SGP roadmap Stage 0 item 4):
    // (a) per-(pxEventId, team, side) prop risk — bounds one-directional
    //     game-script stacking across DIFFERENT players;
    // (b) total prop risk per game regardless of direction — the blunt
    //     bound no script mapping can evade.
    maxPropTeamSideRisk: _capNum(process.env.MAX_PROP_TEAM_SIDE_RISK, 300),
    maxPropRiskPerGame: _capNum(process.env.MAX_PROP_RISK_PER_GAME, 600),
    // Concurrent same-market payout cap (correlated-tail control). Total OPEN
    // payout across every parlay holding a leg of one prop marketType on the
    // same ET slate-day — the bound that stops a league-wide HR/goalscorer day
    // (many independent tickets, different players/games, cashing together)
    // from producing a large red day. Per-player/per-game/per-creator caps
    // can't see this cross-game, cross-counterparty concentration. Default 0
    // (disabled). Size it from your peak historical single-slate same-market
    // payout; a starting point is a few × MAX_RISK_PER_PARLAY_WITH_PROP.
    maxConcurrentMarketPayout: _capNum(process.env.MAX_CONCURRENT_MARKET_PAYOUT, 0),
    // Multiplier applied to per-leg effective vig when pricing an SGP.
    // 2.0 = double the normal vig on each leg of the SGP. Tunable while
    // we gather acceptance + ROI data on re-enabled SGPs.
    sgpVigMultiplier: parseFloat(process.env.SGP_VIG_MULTIPLIER) || 2.0,
    // Prop-specific SGP vig multiplier. Decouples the per-leg vig blow-up on
    // PLAYER-PROP legs of an SGP from the game-line SGP multiplier above, so
    // K-prop / prop-prop same-game tickets can be priced competitively
    // WITHOUT loosening spread_total / ml_total game-line SGPs. Defaults to
    // sgpVigMultiplier (no behavior change unless SGP_PROP_VIG_MULTIPLIER is
    // set), because lowering it weakens the deliberate correlation charge on
    // K-prop/xteam pairs (see pricer.js comment ~L1506 "don't hand attackers
    // a preferred template") — opt in explicitly. RCA 2026-06-24 found
    // K-prop SGPs quoting 14-16% over fair (floor/base vig x 2.0); set
    // SGP_PROP_VIG_MULTIPLIER=1.5 to chase those fills while retaining a
    // correlation buffer. nested pairs already skip the SGP vig entirely.
    sgpPropVigMultiplier: parseFloat(process.env.SGP_PROP_VIG_MULTIPLIER)
      || parseFloat(process.env.SGP_VIG_MULTIPLIER) || 2.0,
    // Phase 2 K-prop + same-team ML SGP correlation boost. Empirically
    // calibrated from DK SGP pricing on 3 MLB combos (Guardians/Cardinals/
    // Rays + their pitcher's K-Over): DK applies 10-19% discount (avg
    // 14.5%); FD applies 17-33% (avg 24.3%). Default 0.15 splits the
    // difference toward DK-side (less aggressive correlation cost). The
    // boost MULTIPLIES fairParlayProb upward — bettor gets shorter odds,
    // matching how books charge the bettor for positive correlation.
    sgpPropMlCorrBoost: parseFloat(process.env.SGP_PROP_ML_CORR_BOOST) || 0.15,
    // SGP correlation adjustment factors. The naive product of leg fair
    // probs understates the true joint probability for positively-
    // correlated combos (spread-fav + over, or spread-dog + under) and
    // overstates for negatively-correlated combos (fav + under, dog +
    // over). Applied as a multiplier to the joint fair prob BEFORE vig.
    // Unlike a post-vig offered-price boost (which PX rejected with
    // "invalid estimated prices"), this adjusts the INPUT fair prob —
    // mathematically identical to what every major book does internally,
    // and within PX's accepted pricing model.
    //
    // Empirical FD SGP discount is ~25-30% on spread+total pairs we've
    // observed; start conservative at 1.15 / 0.90 and tune up based on
    // acceptance + ROI data. Set POSITIVE=1 and NEGATIVE=1 to disable.
    sgpCorrelationPositive: parseFloat(process.env.SGP_CORRELATION_POSITIVE) || 1.15,
    sgpCorrelationNegative: parseFloat(process.env.SGP_CORRELATION_NEGATIVE) || 0.90,
    // Per-combo correlation factors. The legacy single sgpCorrelationPositive
    // applied only to spread_total. Operator caught SGP fill rate at 0%
    // across all combo types, including ml_total which gets sgpVigMultiplier
    // applied on TOP of zero correlation discount — pricing every ml+total
    // SGP looser than fair AND wider with vig, double-disadvantage.
    //
    // Lookup precedence (in pricer.js):
    //   1. Directional key for spread_total (e.g. 'spread_fav_over')
    //      — pricer detects spread side (line < 0 = fav, > 0 = dog) and
    //        total side (selection over/under) and tries this key first
    //   2. Un-directed combo key ('spread_total', 'ml_total')
    //   3. Legacy sgpCorrelationPositive (spread_total only, when even
    //      the un-directed key isn't configured)
    //
    // Defaults calibrated 2026-05-07 from FanDuel's actual SGP-builder
    // prices on 4 sample SGPs (Nationals ml+total, Rays spread+total
    // dog+under, Yankees spread+total fav+over, Habs ml+total in NHL).
    // Implied factors back-calculated from FD vs naive product:
    //
    //   ml_total              MLB winning+over: ~1.18 → set 1.15
    //                         NHL winning+over: ~1.07 (lower variance)
    //                         Single value used; bias toward MLB sample.
    //   spread_total          Un-directed fallback: 1.15 (compromise)
    //   spread_fav_over       Strong positive correlation (blowout = high
    //                         total): observed 1.30
    //   spread_dog_under      Weak positive correlation (close low-margin
    //                         games tend low-total too): observed 1.02
    //   spread_fav_under      Negative correlation (fav blows out usually
    //                         scores high) — bettor edge here, set 0.95
    //   spread_dog_over       Negative correlation (dog upset rare and
    //                         not necessarily high-scoring): set 0.95
    //   ml_spread             Not listed; correlation rules already block
    //                         this combo (anti-arb) regardless of pricing
    //   3+leg combos          Handled separately via
    //                         sgpCorrelation3PlusByCombo
    //
    // All overridable via SGP_CORRELATION_BY_COMBO env JSON map.
    sgpCorrelationByCombo: (() => {
      const defaults = {
        spread_total: 1.15,
        ml_total: 1.15,
        spread_fav_over: 1.30,
        spread_dog_under: 1.02,
        spread_fav_under: 0.95,
        spread_dog_over: 0.95,
      };
      const raw = process.env.SGP_CORRELATION_BY_COMBO;
      if (!raw || !raw.trim()) return defaults;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const out = { ...defaults };
          for (const [k, v] of Object.entries(parsed)) {
            const num = parseFloat(v);
            if (Number.isFinite(num) && num > 0) out[k] = num;
          }
          return out;
        }
      } catch (e) { /* fall through to defaults */ }
      return defaults;
    })(),
    // 3+ legs same-event SGP correlation factors. Previously these
    // combinations got NO correlation discount because the 2-leg detector
    // skipped them (legs.length === 2 gate). Operator confirmed 2026-05-07
    // that those parlays were systematically under-charging vs true
    // correlated likelihood.
    //
    // Factor lookup uses a sorted-market signature, e.g.:
    //   moneyline + spread + total      → 'ml_spread_total'
    //   moneyline + 2× total (alt lines) → 'ml_total_total'
    //   moneyline + spread + 2× total    → 'ml_spread_total_total'
    //   anything else                    → 'default'
    //
    // Defaults are conservative starting points (no empirical calibration
    // yet — needs DK/FD SGP price observations to refine):
    //   ml_spread_total: 1.20 — slightly more than either 2-leg ml_total
    //                    (1.10) or spread_total (1.15) since adding a 3rd
    //                    correlated leg compounds correlation but not
    //                    multiplicatively (which would be 1.10×1.15=1.265).
    //   default:         1.15 — fallback for unrecognized combos and 4+leg
    //                    same-event SGPs.
    //
    // Same JSON env-var override pattern as sgpCorrelationByCombo.
    sgpCorrelation3PlusByCombo: (() => {
      const defaults = { ml_spread_total: 1.20, default: 1.15 };
      const raw = process.env.SGP_CORRELATION_3PLUS_BY_COMBO;
      if (!raw || !raw.trim()) return defaults;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const out = { ...defaults };
          for (const [k, v] of Object.entries(parsed)) {
            const num = parseFloat(v);
            if (Number.isFinite(num) && num > 0) out[k] = num;
          }
          return out;
        }
      } catch (e) { /* fall through to defaults */ }
      return defaults;
    })(),
    // Cross-game same-market correlation. JSON map: marketType -> per-extra-
    // game boost factor (>1) applied to the parlay fair prob when the parlay
    // stacks that market + same side across MULTIPLE DIFFERENT games (positive
    // correlation via the shared slate environment — the leak behind
    // correlated blow-up days). Boost = factor^(distinctGames-1), capped by
    // crossGameCorrMaxBoost. Empty default = OFF (no change). SAME-game
    // clusters are handled by the SGP correlation path, not this. Conservative
    // starting point (cross-game is weaker than same-game):
    //   {"player_hitter_hr":1.08,"player_goalscorer":1.08,"total":1.05,
    //    "first_5_innings_total":1.05}
    // Calibrate against realized multi-same-market win rates before widening.
    crossGameCorrByMarket: (() => {
      try {
        const parsed = JSON.parse(process.env.CROSS_GAME_CORR_BY_MARKET || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out = {};
          for (const [k, v] of Object.entries(parsed)) {
            const num = parseFloat(v);
            if (Number.isFinite(num) && num > 0) out[k] = num;
          }
          return out;
        }
      } catch (e) { /* bad JSON — off */ }
      return {};
    })(),
    crossGameCorrMaxBoost: parseFloat(process.env.CROSS_GAME_CORR_MAX_BOOST) || 2.0,
    // startingBankroll anchors the account-based P&L calculation
    // (balance − starting). If env var is NOT set, leave as null so the
    // dashboard falls back to the tracker's runningPnL (derived from
    // real settled outcomes, not an arbitrary anchor).
    startingBankroll: process.env.STARTING_BANKROLL != null && process.env.STARTING_BANKROLL !== ''
      ? parseFloat(process.env.STARTING_BANKROLL)
      : null,
    maxOdds: parseInt(process.env.MAX_ODDS) || 1500,
  },
  supportedSports: (process.env.SUPPORTED_SPORTS || 'basketball_nba,basketball_ncaab,basketball_wnba,baseball_mlb,icehockey_nhl,tennis,soccer,soccer_usa_mls,soccer_epl,soccer_mexico_ligamx,soccer_brazil_campeonato,soccer_conmebol_libertadores')
    .split(',').map(s => s.trim()),
  // Maps our sport keys to ProphetX sport_name values
  // Note: NBA and NCAAB both map to 'Basketball' — line manager handles both
  // Note: MLS and EPL both map to 'Soccer' — line manager tries all matching keys
  sportNameMap: {
    'basketball_nba': 'Basketball',
    'basketball_ncaab': 'Basketball',
    'basketball_wnba': 'Basketball',
    'baseball_mlb': 'Baseball',
    'icehockey_nhl': 'Ice Hockey',
    'tennis': 'Tennis',
    'americanfootball_nfl': 'American Football',
    'americanfootball_ncaaf': 'American Football',
    'soccer': 'Soccer',
    'soccer_usa_mls': 'Soccer',
    'soccer_epl': 'Soccer',
    'soccer_uefa_champs_league': 'Soccer',
    'soccer_uefa_europa_league': 'Soccer',
    'soccer_spain_la_liga': 'Soccer',
    'soccer_italy_serie_a': 'Soccer',
    'soccer_germany_bundesliga': 'Soccer',
    'soccer_france_ligue_one': 'Soccer',
    'soccer_usa_nwsl': 'Soccer',
    'soccer_mexico_ligamx': 'Soccer',
    'soccer_brazil_campeonato': 'Soccer',
    'soccer_conmebol_libertadores': 'Soccer',
    'soccer_efl_champ': 'Soccer',
    'golf_pga_championship': 'Golf',
    'golf_matchups': 'Golf',
    // PX uses 'MMA' (short form) as sport_name, not 'Mixed Martial Arts'.
    // Getting this wrong silently blocks every MMA event in seedAllLines
    // because pxSportNames.includes(event.sport_name) returns false.
    'mma_mixed_martial_arts': 'MMA',
    'boxing_boxing': 'Boxing',
  },
  server: {
    port: parseInt(process.env.PORT) || 3001,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 10,
};

/**
 * Get effective bankroll — auto-populated from live PX balance at startup
 * and every refresh cycle. Used only for display/P&L anchoring now that the
 * percent-based exposure caps have been removed.
 */
function getBankroll() {
  return config.pricing.liveBankroll || 0;
}

// Validate required config
function validate() {
  const missing = [];
  if (!config.px.accessKey) missing.push('PX_ACCESS_KEY');
  if (!config.px.secretKey) missing.push('PX_SECRET_KEY');
  // The Odds API is the primary (and, since SharpAPI was retired 2026-06-17,
  // the sole) odds source — require ITS key. SharpAPI's key is now optional
  // (legacy overlap-window fallback only), so it no longer blocks boot.
  if (!process.env.THE_ODDS_API_KEY) missing.push('THE_ODDS_API_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  // Sanity-check env values for the "name leaked into value" typo class:
  // operator types `VAR=value1,value2` as the VALUE in Railway, not just
  // `value1,value2`. The leaked prefix breaks any parser that splits on
  // delimiter and expects clean tokens. Caught operator-side 2026-05-01:
  // PROP_LAUNCH_ALLOWLIST first entry was the literal string
  // 'PROP_LAUNCH_ALLOWLIST=basketball_nba.points' instead of just
  // 'basketball_nba.points', silently breaking the points-prop allowlist
  // gate. Walk all process.env keys and warn on any value starting with
  // its own key followed by '='. Also catches surrounding-quote and
  // leading-equals typos as a side effect.
  const warnings = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val !== 'string' || val.length === 0) continue;
    // Common shape: "VAR=foo,bar" pasted as the value of VAR
    if (val.startsWith(key + '=')) {
      const cleaned = val.slice(key.length + 1);
      warnings.push({
        type: 'name_leaked',
        key,
        rawValue: val.length > 80 ? val.slice(0, 77) + '...' : val,
        suggestedValue: cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned,
      });
    }
    // Surrounding single/double quotes — Railway often does NOT strip
    // these (some platforms do). Warn so operator can decide.
    else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      // Ignore short legitimate values like '0', and obvious empty strings
      if (val.length > 2) {
        warnings.push({
          type: 'wrapping_quotes',
          key,
          rawValue: val.length > 80 ? val.slice(0, 77) + '...' : val,
          suggestedValue: val.slice(1, -1),
        });
      }
    }
    // Leading '=' — operator pasted "=value" by accident
    else if (val.startsWith('=')) {
      warnings.push({
        type: 'leading_equals',
        key,
        rawValue: val.length > 80 ? val.slice(0, 77) + '...' : val,
        suggestedValue: val.slice(1),
      });
    }
  }
  if (warnings.length > 0) {
    // Log via console (logger may not be ready at config-load time)
    for (const w of warnings) {
      console.warn(
        `[config] ENV TYPO WARNING (${w.type}) for ${w.key}: value starts with "${w.key}=" or is wrapped in quotes. ` +
        `Got: ${JSON.stringify(w.rawValue)}. Suggested fix: set value to ${JSON.stringify(w.suggestedValue)}`
      );
    }
  }
  return { warnings };
}

module.exports = { config, validate, getBankroll };
