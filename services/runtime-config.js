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
 * Best-effort persistence: if Supabase is down we still apply in memory and
 * simply do not survive the next restart (same degradation as vig-config-store).
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
    label: 'Vig by sport', help: 'Per-sport vig overriding the default.' },
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
  { key: 'priceFloorVsConsensusPp', path: 'priceFloorVsConsensusPp', type: 'number', min: 0, max: 1, group: 'pricing', env: 'PRICE_FLOOR_VS_CONSENSUS_PP',
    label: 'Price floor vs consensus (pp)', help: 'Clamp: never quote more than this far below consensus.' },
  { key: 'devigFavMaxShare', path: 'devigFavMaxShare', type: 'number', min: 0, max: 1, group: 'pricing', env: 'DEVIG_FAV_MAX_SHARE', label: 'De-vig favourite max share' },
  { key: 'confirmationDriftThreshold', path: 'confirmationDriftThreshold', type: 'number', min: 0, max: 1, group: 'pricing', env: 'CONFIRMATION_DRIFT_THRESHOLD',
    label: 'Confirm drift threshold', help: 'Reject a confirm if our price moved more than this since the quote.' },

  // ---------------- RISK (danger) ----------------
  { key: 'maxRiskPerParlay', path: 'maxRiskPerParlay', type: 'number', min: 0, max: 100000, group: 'risk', danger: true, env: 'MAX_RISK_PER_PARLAY', label: 'Max risk per parlay' },
  { key: 'maxRiskPerParlayWithProp', path: 'maxRiskPerParlayWithProp', type: 'number', min: 0, max: 100000, group: 'risk', danger: true, env: 'MAX_RISK_PER_PARLAY_WITH_PROP', label: 'Max risk per parlay (with prop)' },
  { key: 'maxSeriesRiskPerParlay', path: 'maxSeriesRiskPerParlay', type: 'number', min: 0, max: 100000, group: 'risk', danger: true, env: 'MAX_SERIES_RISK_PER_PARLAY', label: 'Max series risk per parlay' },
  { key: 'maxExposurePerTeam', path: 'maxExposurePerTeam', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_TEAM', label: 'Max exposure per team (weighted)' },
  { key: 'maxRawExposurePerTeam', path: 'maxRawExposurePerTeam', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_RAW_EXPOSURE_PER_TEAM', label: 'Max RAW exposure per team (0 = off)' },
  { key: 'maxExposurePerGame', path: 'maxExposurePerGame', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_GAME', label: 'Max exposure per game' },
  { key: 'maxExposurePerPlayerDefault', path: 'maxExposurePerPlayerDefault', type: 'number', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_PLAYER_DEFAULT', label: 'Max exposure per player (default)' },
  { key: 'maxExposurePerPlayerBySport', path: 'maxExposurePerPlayerBySport', type: 'numMap', min: 0, max: 1000000, group: 'risk', danger: true, env: 'MAX_EXPOSURE_PER_PLAYER_BY_SPORT', label: 'Max exposure per player by sport' },
  { key: 'maxOdds', path: 'maxOdds', type: 'number', min: 100, max: 1000000, group: 'risk', danger: true, env: 'MAX_ODDS', label: 'Max offered odds (American)' },
  { key: 'maxLegs', path: 'maxLegs', type: 'number', min: 1, max: 20, group: 'risk', danger: true, env: 'MAX_LEGS', label: 'Max legs' },
  { key: 'useRawPerTeamExposure', path: 'useRawPerTeamExposure', type: 'bool', group: 'risk', danger: true, env: 'USE_RAW_PER_TEAM_EXPOSURE', label: 'Use RAW per-team exposure as primary cap' },
  { key: 'largeParlayFreezeSize', path: 'largeParlayFreezeSize', type: 'number', min: 0, max: 20, group: 'risk', danger: true, env: 'LARGE_PARLAY_FREEZE_SIZE', label: 'Large-parlay freeze size' },
  { key: 'largeParlayFreezeSeconds', path: 'largeParlayFreezeSeconds', type: 'number', min: 0, max: 86400, group: 'risk', danger: true, env: 'LARGE_PARLAY_FREEZE_SECONDS', label: 'Large-parlay freeze seconds' },
  { key: 'teamCooldownSeconds', path: 'teamCooldownSeconds', type: 'number', min: 0, max: 86400, group: 'risk', env: 'TEAM_COOLDOWN_SECONDS', label: 'Team cooldown seconds' },
  { key: 'pendingReservationDiscount', path: 'pendingReservationDiscount', type: 'number', min: 0, max: 1, group: 'risk', env: 'PENDING_RESERVATION_DISCOUNT', label: 'Pending reservation discount' },

  // ---------------- GATING ----------------
  { key: 'sgpAllowedCombos', path: 'sgpAllowedCombos', type: 'strList', group: 'gating', danger: true, env: 'SGP_ALLOWED_COMBOS',
    label: 'SGP allowed combos', help: 'Which same-game combos may quote at all. Removing one stops those parlays entirely.' },
  { key: 'sgpCorrelationByCombo', path: 'sgpCorrelationByCombo', type: 'numMap', min: 0.1, max: 5, group: 'gating', danger: true, env: 'SGP_CORRELATION_BY_COMBO',
    label: 'SGP correlation by combo', help: 'Multiplier on fair for 2-leg same-game. NOTE 2026-08-03: Railway sets spread_fav_under / spread_dog_over to 1.08 where code defaults are 0.95 (opposite sign). Settled data says current calibration is fine (z=+0.30) — do not "restore" on fill-rate grounds.' },
  { key: 'sgpCorrelation3PlusByCombo', path: 'sgpCorrelation3PlusByCombo', type: 'numMap', min: 0.1, max: 5, group: 'gating', danger: true, env: 'SGP_CORRELATION_3PLUS_BY_COMBO', label: 'SGP correlation (3+ legs)' },
  { key: 'sgpVigMultiplier', path: 'sgpVigMultiplier', type: 'number', min: 0.1, max: 10, group: 'gating', env: 'SGP_VIG_MULTIPLIER', label: 'SGP vig multiplier' },
  { key: 'sgpPropMlCorrBoost', path: 'sgpPropMlCorrBoost', type: 'number', min: 0, max: 2, group: 'gating', env: 'SGP_PROP_ML_CORR_BOOST', label: 'SGP prop+ML correlation boost' },
  { key: 'propLaunchAllowlist', path: 'propLaunchAllowlist', type: 'strList', group: 'gating', danger: true, env: 'PROP_LAUNCH_ALLOWLIST',
    label: 'Prop launch allowlist', help: '<sport>.<propType> keys allowed to quote. Not listed = never registers.' },
  { key: 'propMinBooksWithBothSides', path: 'propMinBooksWithBothSides', type: 'number', min: 1, max: 10, group: 'gating', env: 'PROP_MIN_BOOKS_WITH_BOTH_SIDES', label: 'Prop min books (both sides)' },
  { key: 'tennisSetsMinBooks', path: 'tennisSetsMinBooks', type: 'number', min: 1, max: 6, group: 'gating', env: 'TENNIS_SETS_MIN_BOOKS',
    label: 'Tennis sets min books', help: 'Minimum books quoting a tennis SET market (1st-set ML / total sets / win-a-set) before it prices. Set boards are the thinnest we quote — alternate_set_totals is often a single book.' },
  { key: 'stalePriceMinutes', path: 'stalePriceMinutes', type: 'number', min: 1, max: 240, group: 'gating', danger: true, env: 'STALE_PRICE_MINUTES',
    label: 'Stale price minutes', help: 'Decline if the odds cache is older than this. Raising it quotes off staler prices.' },
  { key: 'stalePropSeconds', path: 'stalePropSeconds', type: 'number', min: 30, max: 7200, group: 'gating', danger: true, env: 'STALE_PROP_SECONDS', label: 'Stale prop seconds' },

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

/** Boot hook. Capture env baseline, then apply persisted overrides per key. */
async function hydrate() {
  _envBaseline = _snapshotEnv();
  const db = getDb();
  if (!db || typeof db.loadKV !== 'function') return { applied: 0, reason: 'no-db' };

  let rec;
  try { rec = await db.loadKV(KV_KEY); } catch (e) { return { applied: 0, reason: `load-failed: ${e.message}` }; }
  if (!rec || !rec.overrides) return { applied: 0, reason: 'none' };

  let applied = 0; const discarded = [];
  const keep = {};
  for (const [key, entry] of Object.entries(rec.overrides)) {
    const def = BY_KEY.get(key);
    if (!def || !entry) continue;                       // key retired from the registry
    if (_stable(entry.envSnapshot) !== _stable(_envBaseline[key])) {
      discarded.push(key);                              // Railway changed this var → env wins
      continue;
    }
    _write(def, entry.value);
    keep[key] = entry;
    applied++;
  }
  if (discarded.length) {
    log.info('RuntimeConfig', `Discarded ${discarded.length} override(s) whose env changed in Railway: ${discarded.join(', ')}`);
    try { await db.saveKV(KV_KEY, { overrides: keep, updatedAt: new Date().toISOString() }); } catch (_) {}
  }
  if (applied) log.info('RuntimeConfig', `Applied ${applied} persisted runtime override(s)`);
  return { applied, discarded, reason: 'ok' };
}

async function _persist(overrides) {
  const db = getDb();
  if (!db || typeof db.saveKV !== 'function') return;
  try { await db.saveKV(KV_KEY, { overrides, updatedAt: new Date().toISOString() }); } catch (_) {}
}
async function _loadOverrides() {
  const db = getDb();
  if (!db || typeof db.loadKV !== 'function') return {};
  try { const rec = await db.loadKV(KV_KEY); return (rec && rec.overrides) || {}; } catch (_) { return {}; }
}

/**
 * Apply + persist a single key. Returns { ok, error?, key, value }.
 * Validation is server-side and authoritative — the UI is not the gate.
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

  const overrides = await _loadOverrides();
  overrides[key] = { value, envSnapshot: _envBaseline[key], updatedAt: new Date().toISOString() };
  await _persist(overrides);

  log.info('RuntimeConfig', `${key}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`
    + (def.danger ? '  [RISK KEY]' : ''));
  return { ok: true, key, value, previous: before };
}

/** Drop an override and restore the boot env baseline for that key. */
async function reset(key) {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown key '${key}'` };
  if (!_envBaseline) _envBaseline = _snapshotEnv();
  _write(def, _envBaseline[key]);
  const overrides = await _loadOverrides();
  delete overrides[key];
  await _persist(overrides);
  log.info('RuntimeConfig', `${key}: override cleared, restored env baseline ${JSON.stringify(_envBaseline[key])}`);
  return { ok: true, key, value: _envBaseline[key] };
}

/** Current state of every tunable, for the dashboard. */
async function list() {
  if (!_envBaseline) _envBaseline = _snapshotEnv();
  const overrides = await _loadOverrides();
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

module.exports = { hydrate, set, reset, list, KV_KEY, REGISTRY, __T: T };
