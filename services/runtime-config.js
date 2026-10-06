/**
 * RUNTIME TUNING — adjust model/risk/gating config without a Railway deploy.
 *
 * Generalises services/vig-config-store.js (which does the same job for the
 * vig table alone) to a registry of tunable keys spanning pricing, risk caps
 * and gating.
 *
 * PRECEDENCE (operator-chosen 2026-08-03): "override wins until env changes".
 *   1. At boot config.pricing is populated purely from env. We snapshot each
 *      registered key's value as that key's ENV BASELINE.
 *   2. We load the persisted overrides. Each carries the env baseline in force
 *      when it was written. For EACH KEY independently: if the current env
 *      baseline still matches, APPLY the override; if it changed (someone
 *      edited that var in Railway), DISCARD that key's override — env wins.
 *
 * PER-KEY, deliberately. vig-config-store compares the whole vig config, so
 * editing ANY vig var in Railway drops ALL Config-tab vig edits. That is
 * tolerable for one small table; across ~40 tunables it would mean a single
 * unrelated Railway edit silently reverting everything the operator had set.
 * Here a Railway change only reclaims the key it actually touched.
 *
 * SAFETY. Every key declares bounds, and `danger: true` marks the ones that can
 * expose real money (risk caps, odds/legs limits). Out-of-bounds values are
 * rejected server-side — the UI is not the gate. Nothing here can create a new
 * config key: an unregistered key is refused, so a typo cannot silently write a
 * field the pricer never reads.
 *
 * Persistence is write-behind (2026-10-03): set()/reset() apply in memory and
 * respond even when Supabase is down; see "persistence" below for the
 * load-before-persist rule and the DB-down boot fallback.
 */

const { config } = require('../config');
const log = require('./logger');

const KV_KEY = 'runtime_config_overrides';

let _db = null;
function getDb() {
  if (_db === null) { try { _db = require('./db'); } catch (_) { _db = false; } }
  return _db || null;
}

// --- type coercion / validation -------------------------------------------
const T = {
  number: {
    parse: (v) => (v === '' || v == null ? null : Number(v)),
    valid: (v, d) => Number.isFinite(v) && (d.min == null || v >= d.min) && (d.max == null || v <= d.max),
    describe: (d) => `number${d.min != null ? ` >= ${d.min}` : ''}${d.max != null ? ` <= ${d.max}` : ''}`,
  },
  bool: {
    parse: (v) => (typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true' || String(v) === '1'),
    valid: (v) => typeof v === 'boolean',
    describe: () => 'true / false',
  },
  // JSON object of name -> number (vigBySport, vigByLegCount, caps by sport...)
  numMap: {
    parse: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
    valid: (v, d) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      return Object.values(v).every(x => Number.isFinite(Number(x))
        && (d.min == null || Number(x) >= d.min) && (d.max == null || Number(x) <= d.max));
    },
    describe: (d) => `JSON map of name -> number${d.min != null ? ` in [${d.min}, ${d.max}]` : ''}`,
  },
  // array of strings, accepted as CSV or JSON array
  strList: {
    parse: (v) => (Array.isArray(v) ? v
      : String(v).trim().startsWith('[') ? JSON.parse(v)
      : String(v).split(',').map(s => s.trim()).filter(Boolean)),
    valid: (v) => Array.isArray(v) && v.every(x => typeof x === 'string'),
    describe: () => 'comma-separated list (or JSON array)',
  },
};

/**
 * THE REGISTRY. `path` is relative to config.pricing unless it starts with '@',
 * which means top-level `config`. Only keys listed here are tunable.
 */
const REGISTRY = [
  // ---------------- PRICING ----------------
  { key: 'defaultVig', path: 'defaultVig', type: 'number', min: 0, max: 0.2, group: 'pricing', env: 'DEFAULT_VIG',
    label: 'Default vig', help: 'Base per-leg vig when a sport has no override.' },
  { key: 'vigBySport', path: 'vigBySport', type: 'numMap', min: 0, max: 0.2, group: 'pricing', env: 'VIG_BY_SPORT',
    label: 'Vig by sport', help: 'Per-sport vig overriding the default. NOTE: shadowed per-market by vigBySportMarket — check that map before concluding a sport edit took effect.' },
  // Registered so the highest-precedence vig knob is live-editable. Without a
  // row here it would be env-only, meaning the ONLY way to widen a narrowed
  // market mid-bleed is a Railway edit + redeploy — a restart during peak,
  // which is exactly what the push-timing rule exists to avoid.
  { key: 'vigBySportMarket', path: 'vigBySportMarket', type: 'numMap', min: 0.0001, max: 0.2, group: 'pricing', env: 'VIG_BY_SPORT_MARKET',
    label: 'Vig by sport+market', help: 'Keys "<sport>.<marketType>" (e.g. baseball_mlb.total). Takes PRECEDENCE over Vig by sport. Base vig only — prop/MMA/golf floors and the favorite ramp still layer on top. NOTE: on markets with Pinnacle/FD/DK coverage the consensus floor (PRICE_FLOOR_VS_CONSENSUS_PP) usually sets the price, so this knob is inert there; it reaches a price mainly on legs with no book consensus.' },
  { key: 'vigByLegCount', path: 'vigByLegCount', type: 'numMap', min: 0.1, max: 10, group: 'pricing', env: 'VIG_BY_LEG_COUNT',
    label: 'Vig multiplier by leg count', help: 'MULTIPLIER on vig per leg count. Measured 2026-08-03: this drives most of the price gap vs sharp on 5+ leg tickets.' },
  { key: 'parlayLevelVig', path: 'parlayLevelVig', type: 'bool', group: 'pricing', env: 'PARLAY_LEVEL_VIG',
    label: 'Parlay-level vig', help: 'Apply max per-leg vig once instead of compounding per leg.' },
  { key: 'vigFairMultiplier', path: 'vigFairMultiplier', type: 'number', min: 0, max: 0.2, group: 'pricing', env: 'VIG_FAIR_MULTIPLIER', label: 'Vig fair multiplier' },
  { key: 'vigFavoriteSlope', path: 'vigFavoriteSlope', type: 'number', min: 0, max: 2, group: 'pricing', env: 'VIG_FAVORITE_SLOPE', label: 'Favourite vig slope' },
  { key: 'vigFavoriteFloor', path: 'vigFavoriteFloor', type: 'number', min: 0, max: 1, group: 'pricing', env: 'VIG_FAVORITE_FLOOR', label: 'Favourite vig floor' },
  { key: 'vigLongshotThreshold', path: 'vigLongshotThreshold', type: 'number', min: 0, max: 1, group: 'pricing', env: 'VIG_LONGSHOT_THRESHOLD', label: 'Longshot threshold' },
  { key: 'vigLongshotMaxAdd', path: 'vigLongshotMaxAdd', type: 'number', min: 0, max: 0.5, group: 'pricing', env: 'VIG_LONGSHOT_MAX_ADD', label: 'Longshot max add' },
  { key: 'vigMmaMin', path: 'vigMmaMin', type: 'number', min: 0, max: 0.5, group: 'pricing', env: 'VIG_MMA_MIN', label: 'MMA min vig' },
  { key: 'vigPropFloor', path: 'vigPropFloor', type: 'number', min: 0, max: 0.5, group: 'pricing', env: 'VIG_PROP_FLOOR', label: 'Prop vig floor' },
  { key: 'vigSeriesMin', path: 'vigSeriesMin', type: 'number', min: 0, max: 0.5, group: 'pricing', env: 'VIG_SERIES_MIN', label: 'Series min vig' },
  { key: 'vigHeavyFavThreshold', path: 'vigHeavyFavThreshold', type: 'number', min: 0, max: 1, group: 'pricing', env: 'VIG_HEAVY_FAV_THRESHOLD', label: 'Heavy-fav threshold' },
  { key: 'vigHeavyFavFairMarkup', path: 'vigHeavyFavFairMarkup', type: 'number', min: 0, max: 0.5, group: 'pricing', env: 'VIG_HEAVY_FAV_FAIR_MARKUP', label: 'Heavy-fav fair markup' },
  { key: 'vigChalkStackSurcharge', path: 'vigChalkStackSurcharge', type: 'number', min: 0, max: 0.5, group: 'pricing', env: 'VIG_CHALK_STACK_SURCHARGE', label: 'Chalk-stack surcharge' },
  { key: 'priceFloorVsConsensusPp', path: 'priceFloorVsConsensusPp', type: 'number', min: 0, max: 10, group: 'pricing', env: 'PRICE_FLOOR_VS_CONSENSUS_PP',
    label: 'Price floor vs consensus (pp)', help: 'Clamp: never quote more than this far below consensus.' },
  { key: 'devigFavMaxShare', path: 'devigFavMaxShare', type: 'number', min: 0, max: 1, group: 'pricing', env: 'DEVIG_FAV_MAX_SHARE', label: 'De-vig favourite max share' },
  { key: 'confirmationDriftThreshold', path: 'confirmationDriftThreshold', type: 'number', min: 0, max: 1, group: 'pricing', env: 'CONFIRMATION_DRIFT_THRESHOLD',
    label: 'Confirm drift threshold', help: 'Reject a confirm if our price moved more than this since the quote.' },

  // ---------------- RISK (danger) ----------------
  { key: 'maxRiskPerParlay', path: 'maxRiskPerParlay', type: 'number', min: 0, max: 100000, group: 'risk', danger: true, env: 'MAX_RISK_PER_PARLAY', label: 'Max risk per parlay' },
  { key: 'maxRiskPerParlayWithProp', path: 'maxRiskPerParlayWithProp', type: 'number', min: 0, max: 100000, group: 'risk', danger: true, env: 'MAX_RISK_PER_PARLAY_WITH_PROP', label: 'Max risk per parlay (with prop)' },
  { key: 'footballGameMainOnly', path: 'footballGameMainOnly', type: 'bool', group: 'gating', danger: true, env: 'FOOTBALL_GAME_MAIN_ONLY', label: 'NFL/CFB game lines: register MAIN number only (no alt ladder)' },
  { key: 'mlbSeriesEnabled', path: 'mlbSeriesEnabled', type: 'bool', group: 'gating', danger: true, env: 'MLB_SERIES_ENABLED', label: 'Quote MLB playoff series markets' },
  { key: 'maxSeriesGrossExposure', path: 'maxSeriesGrossExposure', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_SERIES_GROSS_EXPOSURE', label: 'Max gross risk per series event' },
  { key: 'maxSeriesRiskPerParlay', path: 'maxSeriesRiskPerParlay', type: 'number', min: 0, max: 100000, group: 'risk', danger: true, env: 'MAX_SERIES_RISK_PER_PARLAY', label: 'Max series risk per parlay' },
  { key: 'maxExposurePerTeam', path: 'maxExposurePerTeam', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_TEAM', label: 'Max exposure per team (weighted)' },
  { key: 'maxRawExposurePerTeam', path: 'maxRawExposurePerTeam', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_RAW_EXPOSURE_PER_TEAM', label: 'Max RAW exposure per team (0 = off)' },
  { key: 'maxExposurePerGame', path: 'maxExposurePerGame', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_GAME', label: 'Max exposure per game' },
  { key: 'maxExposurePerPlayerDefault', path: 'maxExposurePerPlayerDefault', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_PLAYER_DEFAULT', label: 'Max exposure per player (default)' },
  { key: 'maxExposurePerPlayerBySport', path: 'maxExposurePerPlayerBySport', type: 'numMap', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_PLAYER_BY_SPORT', label: 'Max exposure per player by sport' },
  // Registered 2026-08-14. These two were env-only, so the 8/14 prop-blackout
  // (every prop RFQ declining on an empty line) could only be corrected by a
  // Railway edit + redeploy — a restart during live hours. Every cap that can
  // dark a market must be adjustable without one.
  { key: 'maxExposurePerLeg', path: 'maxExposurePerLeg', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_LEG',
    label: 'Max exposure per line/selection (0 = off)', help: 'RAW worst-case payout on one line-day. Enforced exactly at confirm; quote time only darks an already-full line.' },
  { key: 'maxExposurePerLegProp', path: 'maxExposurePerLegProp', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_LEG_PROP',
    label: 'Max exposure per PROP line (0 = use the shared cap)', help: 'Tighter ceiling for player-prop lines; min() with the shared per-line cap.' },
  { key: 'maxOdds', path: 'maxOdds', type: 'number', min: 100, max: 1000000, group: 'risk', danger: true, env: 'MAX_ODDS', label: 'Max offered odds (American)' },
  { key: 'maxLegs', path: 'maxLegs', type: 'number', min: 1, max: 20, group: 'risk', danger: true, env: 'MAX_LEGS', label: 'Max legs' },
  { key: 'useRawPerTeamExposure', path: 'useRawPerTeamExposure', type: 'bool', group: 'risk', danger: true, env: 'USE_RAW_PER_TEAM_EXPOSURE', label: 'Use RAW per-team exposure as primary cap' },
  { key: 'largeParlayFreezeSize', path: 'largeParlayFreezeSize', type: 'number', min: 0, max: 20, group: 'risk', danger: true, env: 'LARGE_PARLAY_FREEZE_SIZE', label: 'Large-parlay freeze size' },
  { key: 'largeParlayFreezeSeconds', path: 'largeParlayFreezeSeconds', type: 'number', min: 0, max: 86400, group: 'risk', danger: true, env: 'LARGE_PARLAY_FREEZE_SECONDS', label: 'Large-parlay freeze seconds' },
  { key: 'teamCooldownSeconds', path: 'teamCooldownSeconds', type: 'number', min: 0, max: 86400, group: 'risk', env: 'TEAM_COOLDOWN_SECONDS', label: 'Team cooldown seconds' },
  { key: 'pendingReservationDiscount', path: 'pendingReservationDiscount', type: 'number', min: 0, max: 1, group: 'risk', env: 'PENDING_RESERVATION_DISCOUNT', label: 'Pending reservation discount (INERT)',
    help: 'INERT since 2026-09-26: team/game caps read confirmed + in-flight confirms only, and confirms are charged at 100%. Changing this does nothing.' },

  // ---------------- GATING ----------------
  { key: 'sgpAllowedCombos', path: 'sgpAllowedCombos', type: 'strList', group: 'gating', danger: true, env: 'SGP_ALLOWED_COMBOS',
    label: 'SGP allowed combos', help: 'Which same-game combos may quote at all. Removing one stops those parlays entirely.' },
  // Registered 2026-09-28 with the NHL SGP block so a sport can be re-opened
  // (or another blocked) without a Railway edit — that restarts the trader.
  { key: 'sgpBlockedSports', path: 'sgpBlockedSports', type: 'strList', group: 'gating', danger: true, env: 'SGP_BLOCKED_SPORTS',
    label: 'SGP blocked sports', help: 'Sport keys (e.g. icehockey_nhl) on which NO same-game parlay quotes, whatever SGP allowed combos says. Declines as sgp_sport_blocked with combo=/dir=/markets= in the detail for demand monitoring. Empty = no sport blocked (re-opens them to the combo allowlist).' },
  { key: 'sgpCorrelationByCombo', path: 'sgpCorrelationByCombo', type: 'numMap', min: 0.1, max: 5, group: 'gating', danger: true, env: 'SGP_CORRELATION_BY_COMBO',
    label: 'SGP correlation by combo', help: 'Multiplier on fair for 2-leg same-game. Values below 1.00 are FLOORED to 1.00 at pricing (the grid never quotes below independent). NOTE 2026-08-03: Railway sets spread_fav_under / spread_dog_over to 1.08 (code defaults 1.00 since 2026-09-27, were 0.95). Settled data says current calibration is fine (z=+0.30) — do not "restore" on fill-rate grounds.' },
  { key: 'sgpCorrelation3PlusByCombo', path: 'sgpCorrelation3PlusByCombo', type: 'numMap', min: 0.1, max: 5, group: 'gating', danger: true, env: 'SGP_CORRELATION_3PLUS_BY_COMBO', label: 'SGP correlation (3+ legs)', help: 'Values below 1.00 are FLOORED to 1.00 at pricing.' },
  { key: 'sgpVigMultiplier', path: 'sgpVigMultiplier', type: 'number', min: 0.1, max: 10, group: 'gating', env: 'SGP_VIG_MULTIPLIER', label: 'SGP vig multiplier' },
  { key: 'sgpPropMlCorrBoost', path: 'sgpPropMlCorrBoost', type: 'number', min: 0, max: 2, group: 'gating', env: 'SGP_PROP_ML_CORR_BOOST', label: 'SGP prop+ML correlation boost' },
  { key: 'propLaunchAllowlist', path: 'propLaunchAllowlist', type: 'strList', group: 'gating', danger: true, env: 'PROP_LAUNCH_ALLOWLIST',
    label: 'Prop launch allowlist', help: '<sport>.<propType> keys allowed to quote. Not listed = never registers.' },
  { key: 'propMinBooksWithBothSides', path: 'propMinBooksWithBothSides', type: 'number', min: 1, max: 10, group: 'gating', env: 'PROP_MIN_BOOKS_WITH_BOTH_SIDES', label: 'Prop min books (both sides)' },
  { key: 'tennisSetsMinBooks', path: 'tennisSetsMinBooks', type: 'number', min: 1, max: 6, group: 'gating', env: 'TENNIS_SETS_MIN_BOOKS',
    label: 'Tennis sets min books', help: 'Minimum books quoting a tennis SET market (1st-set ML / total sets / win-a-set) before it prices. Set boards are the thinnest we quote — alternate_set_totals is often a single book.' },
  { key: 'stalePriceMinutes', path: 'stalePriceMinutes', type: 'number', min: 1, max: 240, group: 'gating', danger: true, env: 'STALE_PRICE_MINUTES',
    label: 'Stale price minutes', help: 'Decline if the odds cache is older than this. Raising it quotes off staler prices.' },
  // Registered 2026-09-26 so a per-sport stale threshold can be changed without
  // a Railway edit — that edit restarted the trader at peak CFB Saturday.
  // ⚠ A runtime edit REPLACES the whole map: a sport left out falls back to
  // Stale price minutes (10), i.e. LOOSER. Always send the full map.
  { key: 'stalePriceMinutesBySport', path: 'stalePriceMinutesBySport', type: 'numMap', min: 1, max: 240, group: 'gating', danger: true, env: 'STALE_PRICE_MINUTES_BY_SPORT',
    label: 'Stale price minutes by sport', help: 'Per-sport stale threshold (minutes). Edit the FULL map — a sport you drop falls back to Stale price minutes (looser).' },
  // Pair-trim A/B splits (2026-10-01): runtime so an arm can start or stop
  // without a Railway edit (= restart). Read per RFQ in pricer.js.
  { key: 'mlPairTrimPercent', path: 'mlPairTrimPercent', type: 'number', min: 0, max: 100, group: 'pricing', env: 'ML_PAIR_TRIM_PERCENT', label: 'MLB ML-pair trim A/B % (0 = dark)' },
  { key: 'obRelayEnabled', path: 'obRelayEnabled', type: 'bool', group: 'pricing', env: 'OB_RELAY_ENABLED', label: 'Use the order-book fair relay for parlay legs' },
  { key: 'obRelayMaxAgeSec', path: 'obRelayMaxAgeSec', type: 'number', min: 30, max: 3600, group: 'pricing', env: 'OB_RELAY_MAX_AGE_SEC', label: 'Order-book relay: max fair age, seconds' },
  { key: 'obRelayMaxGapPp', path: 'obRelayMaxGapPp', type: 'number', min: 0.005, max: 0.5, group: 'pricing', env: 'OB_RELAY_MAX_GAP_PP', label: 'Order-book relay: own fair wins if more adverse by more than (prob)' },
  { key: 'confirmAdverseDriftThreshold', path: 'confirmAdverseDriftThreshold', type: 'number', min: 0, max: 1, group: 'pricing', env: 'CONFIRM_ADVERSE_DRIFT', label: 'Confirm: reject if fair moved against us by more than (fraction; 0 = off)' },
  { key: 'cfbWidenPercent', path: 'cfbWidenPercent', type: 'number', min: 0, max: 100, group: 'pricing', env: 'CFB_WIDEN_PERCENT', label: 'CFB SGP / 4+ leg widen A/B % (0 = dark)' },
  { key: 'cfbWidenRelPct', path: 'cfbWidenRelPct', type: 'number', min: 0.1, max: 10, group: 'pricing', env: 'CFB_WIDEN_REL_PCT', label: 'CFB widen arm: relative price add, %' },
  { key: 'hrPairTrimPercent', path: 'hrPairTrimPercent', type: 'number', min: 0, max: 100, group: 'pricing', env: 'HR_PAIR_TRIM_PERCENT', label: 'MLB HR-pair trim A/B % (0 = dark)' },
  // Parlay consensus floors (2026-10-03): runtime so the CFB competitiveness
  // lever moves without a restart. Units are percentage POINTS (same as the
  // per-leg floor). 0 disables the floor.
  { key: 'priceFloorVsConsensusParlayPp', path: 'priceFloorVsConsensusParlayPp', type: 'number', min: 0, max: 10, group: 'pricing', env: 'PRICE_FLOOR_VS_CONSENSUS_PARLAY_PP', label: 'Parlay price floor vs consensus (pp)' },
  { key: 'priceFloorVsConsensusParlayChalkPp', path: 'priceFloorVsConsensusParlayChalkPp', type: 'number', min: 0, max: 10, group: 'pricing', env: 'PRICE_FLOOR_VS_CONSENSUS_PARLAY_CHALK_PP', label: 'Chalk-parlay price floor vs consensus (pp)' },
  { key: 'dedupMaxRequotes', path: 'dedupMaxRequotes', type: 'number', min: 0, max: 10, group: 'gating', env: 'DEDUP_MAX_REQUOTES',
    label: 'Dedup max re-quotes', help: 'Identical re-sends re-priced per leg-set inside the 5s window (preview then place). 0 = decline every repeat (pre-2026-09-26 behaviour).' },
  { key: 'stalePropSeconds', path: 'stalePropSeconds', type: 'number', min: 30, max: 7200, group: 'gating', danger: true, env: 'STALE_PROP_SECONDS', label: 'Stale prop seconds' },

  // Registered 2026-09-26 (same reason as the stale map). {} = no league cap.
  { key: 'propNetExposureBySport', path: 'propNetExposureBySport', type: 'numMap', min: 0, max: 1000000, group: 'risk', danger: true, env: 'PROP_NET_EXPOSURE_BY_SPORT',
    label: 'Prop net exposure by sport', help: 'League-wide net player-prop cap per sport key. {} = no cap. Each new ticket is charged its FULL per-ticket prop cap, so a value below a few multiples of Max risk per parlay (props) declines everything.' },

  // UFC MoV RFQ legs (2026-10-03): the order-book floor and the mirror knob.
  { key: 'movRfqMinYesOdds', path: 'movRfqMinYesOdds', type: 'number', min: 100, max: 100000, group: 'gating', danger: true, env: 'MOV_RFQ_MIN_YES_ODDS',
    label: 'UFC MoV min YES odds', help: 'A MoV YES leg registers/quotes only while Bovada YES >= this (American). 300 = the order-book poster NO <= -300 floor.' },
  { key: 'movBookMirrorSweetener', path: 'movBookMirrorSweetener', type: 'number', min: 0, max: 0.2, group: 'pricing', danger: true, env: 'MOV_BOOK_MIRROR_SWEETENER',
    label: 'UFC MoV mirror sweetener', help: 'Offered = Bovada raw YES implied × (1 − this). 0 = exact order-book price.' },
  { key: 'golfOutrightsParlayEnabled', path: 'golfOutrightsParlayEnabled', type: 'bool', group: 'gating', danger: true, env: 'GOLF_OUTRIGHTS_PARLAY_ENABLED',
    label: 'Golf outrights in parlays', help: 'Register golf outright (win/top 5/10/20) legs so PX can send outright RFQs. Needs a loaded DK ties-included board (POST /golf-outrights/paste) or top-N legs fail closed.' },
  { key: 'tennisSetsEnabled', path: 'tennisSetsEnabled', type: 'bool', group: 'gating', danger: true, env: 'TENNIS_SETS_ENABLED',
    label: 'Tennis Sets markets', help: 'Register PX 1st Set ML / Total Sets / To Win At Least One Set. Best-of-3 only (source fails closed otherwise). Same-match parlays of these are hard-blocked. Ships OFF.' },

  // ---- quote-fisher detection (measurement only — nothing declines on it) ----
  { key: 'fisherDetectionEnabled', path: 'fisherDetectionEnabled', type: 'bool', group: 'gating', env: 'FISHER_DETECTION_ENABLED',
    label: 'Quote-fisher detection', help: 'Stamps meta.fisher on each quote so fill-rate analysis can exclude spam. Classifies from the REQUEST STREAM only, never from fills.' },
  { key: 'fisherRfqPerHour', path: 'fisherRfqPerHour', type: 'number', min: 10, max: 100000, group: 'gating', env: 'FISHER_RFQ_PER_HOUR',
    label: 'Fisher threshold (RFQs/hour)', help: 'The known fisher sustains ~2,890/h; genuine counterparties are far below.' },
  { key: 'fisherRefireCount', path: 'fisherRefireCount', type: 'number', min: 2, max: 100, group: 'gating', env: 'FISHER_REFIRE_COUNT',
    label: 'Fisher threshold (grid re-fires)', help: 'Identical leg signature re-requested this many times inside the window.' },
  { key: 'fisherWindowMinutes', path: 'fisherWindowMinutes', type: 'number', min: 5, max: 1440, group: 'gating', env: 'FISHER_WINDOW_MINUTES', label: 'Fisher window (minutes)' },
];

const BY_KEY = new Map(REGISTRY.map(d => [d.key, d]));

function _read(def) {
  const root = def.path.startsWith('@') ? config : config.pricing;
  const p = def.path.replace(/^@/, '');
  return root[p];
}
function _write(def, value) {
  const root = def.path.startsWith('@') ? config : config.pricing;
  const p = def.path.replace(/^@/, '');
  // PRESERVE THE SHAPE config.js BUILT. config.js builds some keys as a Set
  // (propLaunchAllowlist, experimentalSgpCombos) but strList.parse yields an
  // Array. Writing an Array over a Set leaves `.size` undefined and `.has`
  // missing, so every consumer silently reads the collection as EMPTY —
  // no error, no log, and /config/runtime still displays a full list.
  //
  // On 2026-08-24T00:23Z an allowlist edit through this path did exactly that
  // and took ALL player-prop registration dark for 8 days: the pre-seed gate
  // (`propAllowlist.size > 0`), the pre-seed membership test and the on-demand
  // RFQ bridge (`allowlist.has(...)`) all failed at once, while /status kept
  // reporting a populated 21-entry allowlist.
  //
  // This runs on the hydrate() path too, which is the one that matters: the
  // override is persisted, so without this every restart re-applied the Array.
  if (root[p] instanceof Set && Array.isArray(value)) {
    root[p] = new Set(value);
    return;
  }
  root[p] = value;
}
function _stable(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {}));
  }
  return JSON.stringify(v ?? null);
}

// env baseline per key, captured at boot BEFORE overrides are applied
let _envBaseline = null;
function _snapshotEnv() {
  const out = {};
  for (const d of REGISTRY) out[d.key] = _read(d);
  return out;
}

// --- persistence (2026-10-03 rework) ----------------------------------------
// The overrides map is held IN MEMORY (`_overrides`) and is the authority for
// list()/set()/reset(); Supabase is a write-behind copy.
//
// Before this, set() did a DB read-modify-write and AWAITED it, and list()
// read the DB on every GET. During the 2026-10-03 outage POST /config/runtime
// hung ~20s and surfaced as "upstream error" through Railway's edge, GET hung
// outright — and the read half of the read-modify-write returned {} when the
// DB was down, so the eventual write would have replaced EVERY persisted
// override with just the one key being set.
//
// Now:
//   - set()/reset() apply in memory and respond; the persist is awaited for at
//     most PERSIST_WAIT_MS and otherwise continues in the background
//     (`persisted: 'pending'` in the response).
//   - Nothing is ever persisted until a REAL DB read has been merged
//     (`_loaded`), so a DB-down boot can never clobber the stored overrides.
//   - A failed boot load applies the last-known-good fallback (state-snapshot
//     file on a Railway volume, else RUNTIME_CONFIG_FALLBACK env JSON) and a
//     background retry merges the stored overrides once the DB answers —
//     skipping keys the operator set in this process (`_touched`).
let _overrides = {};
let _loaded = false;
let _dirty = false;
let _mutations = 0;
let _source = 'none';
const _touched = new Set();
let _retryTimer = null;
let _persisting = null;
const PERSIST_WAIT_MS = Number(process.env.RUNTIME_CONFIG_PERSIST_WAIT_MS) > 0 ? Number(process.env.RUNTIME_CONFIG_PERSIST_WAIT_MS) : 1500;
const RETRY_MS = Number(process.env.RUNTIME_CONFIG_RETRY_MS) > 0 ? Number(process.env.RUNTIME_CONFIG_RETRY_MS) : 30_000;

function _snapshot() {
  try { return require('./state-snapshot'); } catch (_) { return null; }
}

async function _strictLoad(db) {
  try {
    if (typeof db.loadKVStrict === 'function') return await db.loadKVStrict(KV_KEY);
    return { ok: true, value: await db.loadKV(KV_KEY) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _applyEntries(entries, { skipTouched }) {
  let applied = 0; const discarded = []; const keep = {};
  for (const [key, entry] of Object.entries(entries || {})) {
    const def = BY_KEY.get(key);
    if (!def || !entry) continue;                       // key retired from the registry
    if (skipTouched && _touched.has(key)) continue;     // operator set it this process — theirs wins
    if (_stable(entry.envSnapshot) !== _stable(_envBaseline[key])) {
      discarded.push(key);                              // Railway changed this var → env wins
      continue;
    }
    _write(def, entry.value);
    keep[key] = entry;
    applied++;
  }
  return { applied, discarded, keep };
}

// Merge a REAL DB read into memory. Pure (never persists) — callers persist.
function _mergeLoaded(rec) {
  const stored = (rec && rec.overrides) || {};
  // A fallback-applied key the DB does not hold: the DB is authoritative, so
  // restore the env baseline (unless the operator set it this process).
  for (const key of Object.keys(_overrides)) {
    if (_touched.has(key) || Object.prototype.hasOwnProperty.call(stored, key)) continue;
    const def = BY_KEY.get(key);
    if (def) _write(def, _envBaseline[key]);
    delete _overrides[key];
  }
  const r = _applyEntries(stored, { skipTouched: true });
  for (const [k, v] of Object.entries(r.keep)) _overrides[k] = v;
  if (r.discarded.length) {
    log.info('RuntimeConfig', `Discarded ${r.discarded.length} override(s) whose env changed in Railway: ${r.discarded.join(', ')}`);
    _dirty = true; _mutations++;
  }
  if (r.applied) log.info('RuntimeConfig', `Applied ${r.applied} persisted runtime override(s)`);
  _loaded = true;
  _source = 'db';
  const snap = _snapshot();
  if (snap) snap.write('runtime-config', { overrides: _overrides });
  return { ...r, hadRecord: !!(rec && rec.overrides) };
}

function _applyFallback() {
  const snap = _snapshot();
  const fromFile = snap && snap.read('runtime-config');
  let entries = null; let source = null;
  if (fromFile && fromFile.data && fromFile.data.overrides) {
    entries = fromFile.data.overrides; source = `snapshot(${fromFile.savedAt || '?'})`;
  } else if (process.env.RUNTIME_CONFIG_FALLBACK) {
    // Plain { key: value } JSON, operator-maintained. Validated through the
    // registry exactly like a POST; an invalid entry is skipped, never applied.
    try {
      const raw = JSON.parse(process.env.RUNTIME_CONFIG_FALLBACK);
      entries = {};
      for (const [key, rawValue] of Object.entries(raw || {})) {
        const def = BY_KEY.get(key);
        if (!def) continue;
        const t = T[def.type];
        let value;
        try { value = t.parse(rawValue); } catch (_) { continue; }
        if (!t.valid(value, def)) { log.warn('RuntimeConfig', `RUNTIME_CONFIG_FALLBACK: invalid ${key} skipped`); continue; }
        entries[key] = { value, envSnapshot: _envBaseline[key], updatedAt: null };
      }
      source = 'env RUNTIME_CONFIG_FALLBACK';
    } catch (e) {
      log.error('RuntimeConfig', `RUNTIME_CONFIG_FALLBACK is not valid JSON — ignored: ${e.message}`);
    }
  }
  if (!entries) return { applied: 0, discarded: [], source: null };
  const r = _applyEntries(entries, { skipTouched: true });
  for (const [k, v] of Object.entries(r.keep)) _overrides[k] = v;
  _source = source;
  log.warn('RuntimeConfig', `DB unavailable at boot — applied ${r.applied} override(s) from ${source}; the stored overrides will be merged when Supabase answers`);
  return { applied: r.applied, discarded: r.discarded, source };
}

function _scheduleRetry() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(async () => {
    _retryTimer = null;
    try { await _retryTick(); } catch (_) { /* rescheduled below */ }
    if (!_loaded || _dirty) _scheduleRetry();
  }, RETRY_MS);
  if (_retryTimer.unref) _retryTimer.unref();
}

async function _retryTick() {
  const db = getDb();
  if (!db) return;
  if (!_loaded) {
    const r = await _strictLoad(db);
    if (!r.ok) return;
    _mergeLoaded(r.value);
    log.info('RuntimeConfig', 'Deferred hydrate: stored overrides merged after the DB came back');
  }
  if (_dirty) await _persistNow();
}

// Single-flight persist of the whole in-memory map. Resolves true when the DB
// holds the current map, false when it could not be written (retry scheduled).
function _persistNow() {
  if (_persisting) return _persisting;
  _persisting = (async () => {
    const db = getDb();
    if (!db || typeof db.saveKV !== 'function') { _dirty = false; return true; }
    if (!_loaded) {
      const r = await _strictLoad(db);
      if (!r.ok) { _scheduleRetry(); return false; }
      _mergeLoaded(r.value);
    }
    for (let i = 0; i < 3 && _dirty; i++) {
      const gen = _mutations;
      let res;
      try { res = await db.saveKV(KV_KEY, { overrides: { ..._overrides }, updatedAt: new Date().toISOString() }); }
      catch (e) { res = { ok: false, error: e.message }; }
      // Legacy/stub saveKV resolves undefined on success.
      const ok = res === undefined || res === null || res.ok !== false;
      if (!ok) { _scheduleRetry(); return false; }
      if (gen === _mutations) _dirty = false;
    }
    const snap = _snapshot();
    if (snap) snap.write('runtime-config', { overrides: _overrides });
    return !_dirty;
  })().finally(() => { _persisting = null; });
  return _persisting;
}

// Await the persist for at most PERSIST_WAIT_MS so an HTTP handler always responds.
async function _persistBounded() {
  let timer = null;
  try {
    return await Promise.race([
      _persistNow(),
      new Promise(resolve => { timer = setTimeout(() => resolve('pending'), PERSIST_WAIT_MS); if (timer.unref) timer.unref(); }),
    ]);
  } catch (_) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Boot hook. Capture env baseline, then apply persisted overrides per key. */
async function hydrate() {
  _envBaseline = _snapshotEnv();
  const db = getDb();
  if (!db || typeof db.loadKV !== 'function') return { applied: 0, reason: 'no-db' };

  const r = await _strictLoad(db);
  if (!r.ok) {
    const fb = _applyFallback();
    _scheduleRetry();
    return { applied: fb.applied, discarded: fb.discarded, fallback: fb.source, reason: `load-failed: ${r.error}` };
  }
  const m = _mergeLoaded(r.value);
  if (_dirty) await _persistBounded();
  if (!m.hadRecord) return { applied: 0, reason: 'none' };
  return { applied: m.applied, discarded: m.discarded, reason: 'ok' };
}

/** Persistence health for /status. */
function getPersistenceState() {
  return { loaded: _loaded, dirty: _dirty, source: _source, overrideCount: Object.keys(_overrides).length, touchedThisProcess: [..._touched] };
}

/**
 * Apply + persist a single key. Returns { ok, error?, key, value, persisted }.
 * Validation is server-side and authoritative — the UI is not the gate.
 * The value is LIVE when this returns, whether or not the DB write landed.
 */
async function set(key, rawValue) {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown key '${key}' (not in the runtime-tuning registry)` };
  const t = T[def.type];
  let value;
  try { value = t.parse(rawValue); } catch (e) { return { ok: false, error: `could not parse as ${def.type}: ${e.message}` }; }
  if (!t.valid(value, def)) return { ok: false, error: `invalid value for ${key}; expected ${t.describe(def)}` };

  if (!_envBaseline) _envBaseline = _snapshotEnv();
  const before = _read(def);
  _write(def, value);
  _touched.add(key);
  _overrides[key] = { value, envSnapshot: _envBaseline[key], updatedAt: new Date().toISOString() };
  _dirty = true; _mutations++;
  const persisted = await _persistBounded();

  log.info('RuntimeConfig', `${key}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`
    + (def.danger ? '  [RISK KEY]' : '') + (persisted === true ? '' : `  [persist ${persisted === 'pending' ? 'pending' : 'deferred — DB unavailable'}]`));
  return { ok: true, key, value, previous: before, persisted };
}

/** Drop an override and restore the boot env baseline for that key. */
async function reset(key) {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown key '${key}'` };
  if (!_envBaseline) _envBaseline = _snapshotEnv();
  _write(def, _envBaseline[key]);
  _touched.add(key);
  delete _overrides[key];
  _dirty = true; _mutations++;
  const persisted = await _persistBounded();
  log.info('RuntimeConfig', `${key}: override cleared, restored env baseline ${JSON.stringify(_envBaseline[key])}`);
  return { ok: true, key, value: _envBaseline[key], persisted };
}

/** Current state of every tunable, for the dashboard. */
async function list() {
  if (!_envBaseline) _envBaseline = _snapshotEnv();
  const overrides = _overrides; // in-memory — GET /config/runtime never waits on the DB
  return REGISTRY.map(d => {
    const effective = _read(d);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, d.key)
      && _stable(effective) !== _stable(_envBaseline[d.key]);
    return {
      key: d.key,
      group: d.group,
      label: d.label || d.key,
      help: d.help || null,
      type: d.type,
      min: d.min ?? null,
      max: d.max ?? null,
      danger: !!d.danger,
      env: d.env,
      value: effective,
      envValue: _envBaseline[d.key],
      overridden,
      updatedAt: overrides[d.key]?.updatedAt || null,
      expects: T[d.type].describe(d),
    };
  });
}

module.exports = { hydrate, set, reset, list, getPersistenceState, KV_KEY, REGISTRY, __T: T };
