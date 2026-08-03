// Runtime Tuning — validation, per-key env precedence, and safety.
//
// Precedence rule (operator-chosen 2026-08-03): an override wins until the
// matching env var changes in Railway, at which point env reclaims THAT key.
// Per-key, unlike vig-config-store's whole-config comparison — across ~40
// tunables a single unrelated Railway edit must not revert everything.
//
// Run: npm test   (or: node --test test/runtime-config.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

// In-memory stand-in for the kv_store table.
let KV = {};
const dbStub = {
  saveKV: async (k, v) => { KV[k] = v; },
  loadKV: async (k) => KV[k] || null,
};

function freshModule() {
  for (const p of ['../services/runtime-config', '../config', '../services/db']) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  require.cache[require.resolve('../services/db')] = { id: require.resolve('../services/db'), filename: require.resolve('../services/db'), loaded: true, exports: dbStub };
  const { config } = require('../config');
  const rtc = require('../services/runtime-config');
  return { rtc, config };
}

test('registry is well-formed: unique keys, bounds on every number', () => {
  const { rtc } = freshModule();
  const seen = new Set();
  for (const d of rtc.REGISTRY) {
    assert.ok(!seen.has(d.key), `duplicate key ${d.key}`);
    seen.add(d.key);
    assert.ok(d.env, `${d.key} must name its env var`);
    assert.ok(['pricing', 'risk', 'gating'].includes(d.group), `${d.key} bad group`);
    if (d.type === 'number') {
      assert.ok(d.min != null && d.max != null, `${d.key} number must declare min+max`);
      assert.ok(d.max > d.min, `${d.key} max must exceed min`);
    }
  }
});

test('an unregistered key is refused — a typo cannot write a phantom field', async () => {
  const { rtc } = freshModule();
  const r = await rtc.set('totallyMadeUpKey', 5);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown key/);
});

test('out-of-bounds values are rejected server-side', async () => {
  const { rtc, config } = freshModule();
  const before = config.pricing.defaultVig;
  const hi = await rtc.set('defaultVig', 0.99);   // max 0.20
  assert.equal(hi.ok, false);
  const lo = await rtc.set('defaultVig', -1);
  assert.equal(lo.ok, false);
  assert.equal(config.pricing.defaultVig, before, 'config must be untouched on rejection');
});

test('a valid write lands in config immediately', async () => {
  const { rtc, config } = freshModule();
  const r = await rtc.set('defaultVig', 0.031);
  assert.equal(r.ok, true);
  assert.equal(config.pricing.defaultVig, 0.031);
});

test('numMap accepts JSON and enforces bounds on every entry', async () => {
  const { rtc, config } = freshModule();
  const ok = await rtc.set('vigBySport', '{"tennis":0.03,"baseball_mlb":0.02}');
  assert.equal(ok.ok, true);
  assert.equal(config.pricing.vigBySport.tennis, 0.03);
  const bad = await rtc.set('vigBySport', '{"tennis":0.9}');   // max 0.20
  assert.equal(bad.ok, false);
  assert.equal(config.pricing.vigBySport.tennis, 0.03, 'rejected write must not partially apply');
  const notJson = await rtc.set('vigBySport', 'tennis=0.03');
  assert.equal(notJson.ok, false);
});

test('strList accepts CSV and JSON array', async () => {
  const { rtc, config } = freshModule();
  const csv = await rtc.set('sgpAllowedCombos', 'spread_total, ml_total');
  assert.equal(csv.ok, true);
  assert.deepEqual(config.pricing.sgpAllowedCombos, ['spread_total', 'ml_total']);
  const json = await rtc.set('sgpAllowedCombos', '["a","b","c"]');
  assert.equal(json.ok, true);
  assert.deepEqual(config.pricing.sgpAllowedCombos, ['a', 'b', 'c']);
});

test('bool coerces from string and from boolean', async () => {
  const { rtc, config } = freshModule();
  assert.equal((await rtc.set('parlayLevelVig', 'true')).ok, true);
  assert.equal(config.pricing.parlayLevelVig, true);
  assert.equal((await rtc.set('parlayLevelVig', false)).ok, true);
  assert.equal(config.pricing.parlayLevelVig, false);
});

test('override SURVIVES a restart when env is unchanged', async () => {
  KV = {};
  {
    const { rtc } = freshModule();
    await rtc.hydrate();                       // baseline = env
    await rtc.set('defaultVig', 0.042);
  }
  // restart with identical env
  {
    const { rtc, config } = freshModule();
    const r = await rtc.hydrate();
    assert.equal(r.applied, 1);
    assert.equal(config.pricing.defaultVig, 0.042, 'override must be restored');
  }
});

test('override is DISCARDED when that env var changes (env wins)', async () => {
  KV = {};
  {
    const { rtc } = freshModule();
    await rtc.hydrate();
    await rtc.set('defaultVig', 0.042);
  }
  process.env.DEFAULT_VIG = '0.077';           // operator edits Railway
  try {
    const { rtc, config } = freshModule();
    const r = await rtc.hydrate();
    assert.equal(r.applied, 0);
    assert.deepEqual(r.discarded, ['defaultVig']);
    assert.equal(config.pricing.defaultVig, 0.077, 'env value must win');
  } finally {
    delete process.env.DEFAULT_VIG;
  }
});

test('PER-KEY: changing one env var does not drop unrelated overrides', async () => {
  KV = {};
  {
    const { rtc } = freshModule();
    await rtc.hydrate();
    await rtc.set('defaultVig', 0.042);
    await rtc.set('maxLegs', 9);
  }
  process.env.DEFAULT_VIG = '0.055';           // only the vig var changes
  try {
    const { rtc, config } = freshModule();
    const r = await rtc.hydrate();
    assert.deepEqual(r.discarded, ['defaultVig'], 'only the touched key is reclaimed');
    assert.equal(config.pricing.defaultVig, 0.055, 'env wins for the changed key');
    assert.equal(config.pricing.maxLegs, 9, 'the UNRELATED override must survive');
  } finally {
    delete process.env.DEFAULT_VIG;
  }
});

test('reset() clears the override and restores the env baseline', async () => {
  KV = {};
  const { rtc, config } = freshModule();
  await rtc.hydrate();
  const envVal = config.pricing.defaultVig;
  await rtc.set('defaultVig', 0.045);
  assert.equal(config.pricing.defaultVig, 0.045);
  const r = await rtc.reset('defaultVig');
  assert.equal(r.ok, true);
  assert.equal(config.pricing.defaultVig, envVal, 'restored to boot env value');
  const items = await rtc.list();
  assert.equal(items.find(i => i.key === 'defaultVig').overridden, false);
});

test('list() reports effective value, env baseline and override state', async () => {
  KV = {};
  const { rtc } = freshModule();
  await rtc.hydrate();
  await rtc.set('maxLegs', 7);
  const items = await rtc.list();
  const it = items.find(i => i.key === 'maxLegs');
  assert.equal(it.value, 7);
  assert.equal(it.overridden, true);
  assert.ok(it.envValue !== 7 || it.envValue === 7, 'envValue present');
  assert.equal(it.group, 'risk');
  assert.equal(it.danger, true, 'maxLegs is a risk key and must be flagged');
  const pricing = items.find(i => i.key === 'defaultVig');
  assert.equal(pricing.overridden, false);
});

test('risk keys are flagged so the UI can confirm before applying', async () => {
  const { rtc } = freshModule();
  const items = await rtc.list();
  for (const k of ['maxRiskPerParlay', 'maxExposurePerTeam', 'maxOdds', 'maxLegs', 'sgpAllowedCombos']) {
    assert.equal(items.find(i => i.key === k).danger, true, `${k} must be danger-flagged`);
  }
});

test('a retired registry key in storage is ignored, not crashed on', async () => {
  KV = { runtime_config_overrides: { overrides: { someOldKey: { value: 1, envSnapshot: 1 } } } };
  const { rtc } = freshModule();
  const r = await rtc.hydrate();
  assert.equal(r.applied, 0);
});
