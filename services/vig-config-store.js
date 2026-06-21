/**
 * Vig-config persistence
 *
 * Makes the Config-tab "Vig by Sport" edits (per-sport vig, default vig, and
 * the parlay-level-vig toggle — everything POST /config/vig changes) SURVIVE
 * restarts. Before this, /config/vig only mutated config.pricing in memory, so
 * a redeploy/restart wiped any Config-tab change back to the Railway env value
 * — which (correctly) made the operator not trust the table.
 *
 * PRECEDENCE — Railway env stays authoritative when you touch it:
 *   1. On boot, config.pricing is first populated from env (VIG_BY_SPORT /
 *      DEFAULT_VIG / PARLAY_LEVEL_VIG). We snapshot that as the ENV BASELINE.
 *   2. We then load the persisted override record. It carries the env baseline
 *      that was in effect when it was written. If the CURRENT env baseline
 *      matches that stored snapshot (Railway untouched since), we APPLY the
 *      override. If the env baseline CHANGED (operator edited ANY vig value in
 *      Railway), we DISCARD the override — env wins — and clear the record so
 *      the next Config-tab edit re-baselines against the new env.
 *
 * Net behavior:
 *   - Config-tab edits persist across restarts.
 *   - Changing any vig value in Railway resets Config-tab overrides on the next
 *     boot (Railway wins). A Railway change is never silently shadowed.
 *   NOTE: the env-change check is whole-config, so editing ANY vig env var in
 *   Railway (even one sport) discards ALL current Config-tab vig overrides.
 *   That's the deliberate, predictable rule.
 *
 * Best-effort: every DB call degrades to env-only behavior if Supabase is down
 * (matches the pre-existing in-memory behavior — no worse than today).
 */

const { config } = require('../config');
const log = require('./logger');

const KV_KEY = 'vig_config_overrides';

let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./db'); } catch (_) { _db = false; }
  }
  return _db || null;
}

// Env-derived config captured at boot (BEFORE any override is applied).
// Used both to detect Railway env changes and to stamp persisted records.
let _envBaseline = null;

function _snapshot() {
  return {
    vigBySport: { ...(config.pricing.vigBySport || {}) },
    defaultVig: config.pricing.defaultVig,
    parlayLevelVig: !!config.pricing.parlayLevelVig,
  };
}

// Stable JSON (sorted vigBySport keys) for order-independent deep-equality.
function _stable(s) {
  if (!s) return '';
  const vbs = s.vigBySport || {};
  const sorted = Object.keys(vbs).sort().reduce((o, k) => { o[k] = vbs[k]; return o; }, {});
  return JSON.stringify({ vigBySport: sorted, defaultVig: s.defaultVig ?? null, parlayLevelVig: !!s.parlayLevelVig });
}

/**
 * Boot hook. Capture the env baseline (config.pricing is pure-env at this point
 * in the startup sequence), then apply the persisted override iff the env
 * baseline is unchanged since the override was written.
 * Returns { applied, discarded?, reason }.
 */
async function hydrate() {
  _envBaseline = _snapshot();
  const db = getDb();
  if (!db || typeof db.loadKV !== 'function') return { applied: false, reason: 'no-db' };

  let rec;
  try { rec = await db.loadKV(KV_KEY); } catch (e) { return { applied: false, reason: `load-failed: ${e.message}` }; }
  if (!rec || !rec.override) return { applied: false, reason: 'none' };

  if (_stable(rec.envSnapshot) !== _stable(_envBaseline)) {
    // Railway vig env changed since the override was written → env wins.
    log.info('VigConfig', 'Railway vig env changed since last Config-tab override — discarding persisted overrides (env is authoritative)');
    try { await db.saveKV(KV_KEY, null); } catch (_) {}
    return { applied: false, discarded: true, reason: 'env-changed' };
  }

  const o = rec.override;
  if (o.vigBySport && typeof o.vigBySport === 'object') config.pricing.vigBySport = { ...o.vigBySport };
  if (o.defaultVig != null && !isNaN(o.defaultVig)) config.pricing.defaultVig = o.defaultVig;
  if (typeof o.parlayLevelVig === 'boolean') config.pricing.parlayLevelVig = o.parlayLevelVig;
  log.info('VigConfig', `Applied persisted Config-tab vig overrides (saved ${rec.updatedAt || '?'})`);
  return { applied: true, reason: 'ok' };
}

/**
 * Called from POST /config/vig AFTER the in-memory mutation. Persists the
 * current effective vig config, stamped with the env baseline so the next boot
 * can detect a Railway change. Fire-and-forget; safe if the DB is down.
 *
 * If hydrate() never ran (no DB at boot), _envBaseline is captured lazily here
 * from the current state — the record then matches env, so on a later boot with
 * a working DB it applies cleanly unless env has since changed.
 */
function persist() {
  const db = getDb();
  if (!db || typeof db.saveKV !== 'function') return;
  if (!_envBaseline) _envBaseline = _snapshot();
  const rec = {
    override: _snapshot(),
    envSnapshot: _envBaseline,
    updatedAt: new Date().toISOString(),
  };
  db.saveKV(KV_KEY, rec).catch(() => { /* logged inside saveKV */ });
}

module.exports = { hydrate, persist, KV_KEY };
