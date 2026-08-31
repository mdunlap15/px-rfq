'use strict';

// Regression cover for the 2026-08-24 prop blackout.
//
// config.js builds propLaunchAllowlist as a Set. The /config/runtime registry
// types it 'strList', whose parser yields an ARRAY. Writing that Array over
// the Set left `.size` undefined and `.has` missing, so all three consumers
// read the allowlist as EMPTY:
//
//   services/line-manager.js:2427   propAllowlist.size > 0     (pre-seed gate)
//   services/line-manager.js:2479   propAllowlist.has(...)     (pre-seed member)
//   services/line-manager.js:3902   allowlist.has(...)         (on-demand RFQ)
//
// Every player prop stopped registering at 2026-08-24T00:23:17Z and stayed
// dark for 8 days. Nothing errored, nothing logged, and /config/runtime kept
// displaying a populated 21-entry allowlist — which is why it survived a
// coverage review that read the allowlist and pronounced it healthy.
//
// The override is PERSISTED, so the hydrate() path is the one that matters:
// without the fix, every restart re-applied the Array.

const test = require('node:test');
const assert = require('node:assert');

const { config } = require('../config');

// SAFETY — READ BEFORE EDITING THIS FILE.
// runtime-config PERSISTS every set() into the Supabase `kv_store` row
// `runtime_config_overrides`, which is the SAME row production hydrates from
// at boot. A test calling rtc.set() against a live DB handle would silently
// rewrite live trading config — and _persist swallows its own errors, so it
// would leave no trace. Neutralise persistence by seeding require.cache with
// a stub that has no saveKV/loadKV, before runtime-config lazily binds the
// real module in getDb(). node --test gives each file its own process, so
// this cannot leak into other suites.
const _dbPath = require.resolve('../services/db');
require.cache[_dbPath] = {
  id: _dbPath, filename: _dbPath, loaded: true, children: [], paths: [],
  exports: {}, // no saveKV -> _persist returns early; no loadKV -> _loadOverrides returns {}
};

const rtc = require('../services/runtime-config');

test('GUARD: persistence is stubbed out — this suite must never write live config', () => {
  const db = require('../services/db');
  assert.strictEqual(typeof db.saveKV, 'undefined',
    'db stub lost: rtc.set() would write to the production runtime_config_overrides row');
});

const KEY = 'propLaunchAllowlist';
const ENTRIES = ['baseball_mlb.hitter_hr', 'basketball_wnba.points', 'basketball_wnba.threes_made'];

function restore(orig) { config.pricing[KEY] = orig; }

test('config builds the allowlist as a Set — the premise of the bug', () => {
  assert.ok(config.pricing[KEY] instanceof Set,
    'if this ever stops being a Set, revisit _write and _propAllowlistSet');
});

test('an Array override is coerced back to a Set, not written raw', async () => {
  const orig = config.pricing[KEY];
  try {
    config.pricing[KEY] = new Set(['seed.value']);
    const res = await rtc.set(KEY, ENTRIES.join(','));
    assert.ok(res.ok, `set should succeed: ${res.error || ''}`);

    const live = config.pricing[KEY];
    assert.ok(live instanceof Set, 'MUST stay a Set — an Array silently empties every consumer');
    assert.strictEqual(live.size, 3, '.size must work (pre-seed gate reads it)');
    for (const e of ENTRIES) {
      assert.ok(live.has(e), `.has() must work for ${e} (membership + on-demand bridge read it)`);
    }
  } finally { restore(orig); }
});

test('the exact 8/24 failure shape: .size and .has on the written value', async () => {
  // Reproduces the precise expressions from the three call sites.
  const orig = config.pricing[KEY];
  try {
    config.pricing[KEY] = new Set(['x']);
    await rtc.set(KEY, ENTRIES.join(','));
    const a = config.pricing[KEY];

    assert.notStrictEqual(a.size, undefined, '`.size` was undefined — this is what broke the gate');
    assert.ok(a.size > 0, 'line-manager.js:2427 `propAllowlist.size > 0` must be TRUE');
    assert.strictEqual(typeof a.has, 'function', 'line-manager.js:2479/3902 need .has()');
    assert.ok(a.has('basketball_wnba.points'), 'WNBA points was explicitly meant to stay ON');
    assert.ok(a.has('basketball_wnba.threes_made'), 'WNBA threes was explicitly meant to stay ON');
  } finally { restore(orig); }
});

test('a JSON-array override is coerced too', async () => {
  const orig = config.pricing[KEY];
  try {
    config.pricing[KEY] = new Set(['x']);
    const res = await rtc.set(KEY, JSON.stringify(ENTRIES));
    assert.ok(res.ok, res.error || '');
    assert.ok(config.pricing[KEY] instanceof Set, 'JSON-array input must coerce as well');
    assert.strictEqual(config.pricing[KEY].size, 3);
  } finally { restore(orig); }
});

test('non-Set keys are untouched — coercion must not corrupt normal values', async () => {
  const orig = config.pricing.maxRiskPerParlay;
  try {
    const res = await rtc.set('maxRiskPerParlay', 750);
    assert.ok(res.ok, res.error || '');
    assert.strictEqual(config.pricing.maxRiskPerParlay, 750, 'numbers must pass through unchanged');
  } finally { config.pricing.maxRiskPerParlay = orig; }
});

test('an Array-typed key stays an Array — only Sets are coerced', async () => {
  const orig = config.pricing.sgpAllowedCombos;
  try {
    config.pricing.sgpAllowedCombos = ['spread_total'];
    const res = await rtc.set('sgpAllowedCombos', 'spread_total,ml_total');
    assert.ok(res.ok, res.error || '');
    assert.ok(Array.isArray(config.pricing.sgpAllowedCombos),
      'a key config builds as an Array must NOT be promoted to a Set');
  } finally { config.pricing.sgpAllowedCombos = orig; }
});

test('an empty override still yields a Set, so consumers fail closed not crash', async () => {
  const orig = config.pricing[KEY];
  try {
    config.pricing[KEY] = new Set(['x']);
    await rtc.set(KEY, '');
    const live = config.pricing[KEY];
    assert.ok(live instanceof Set, 'empty must still be a Set');
    assert.strictEqual(live.size, 0, 'and genuinely empty — an empty allowlist is a real choice');
  } finally { restore(orig); }
});
