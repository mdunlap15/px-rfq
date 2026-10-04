// DB-down resilience of operator state: runtime config + creator blocklist.
//
// Incident 2026-10-03: during a ~13h Supabase outage, POST /config/runtime
// hung (the handler awaited a DB read-modify-write) and returned "upstream
// error" through Railway's edge; GET /config/runtime hung; and a restart
// booted with an EMPTY creator blocklist and NO runtime overrides.
//
// Pinned here:
//   - set()/list() respond with the DB hung or down, value live in memory
//   - a DB-down boot applies the last-known-good fallback
//   - nothing is persisted before a REAL DB load (no clobber of stored state)
//   - writes made while down reach the DB, merged, once it answers
//
// No network, no production Supabase: the real supabase-js client points at
// http://db.test through the circuit breaker with a fake transport.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('@supabase/supabase-js');
const { DbCircuitBreaker } = require('../services/db-breaker');
const db = require('../services/db');

function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function makeTransport() {
  const tr = {
    mode: 'ok', calls: [], kv: {},
    fetch: async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : null;
      tr.calls.push({ method, url: String(url), body });
      if (tr.mode === 'throw') throw new TypeError('fetch failed');
      if (tr.mode === 'hang') {
        return new Promise((_, rej) => {
          if (init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      if (/\/kv_store/.test(String(url))) {
        if (method === 'GET') {
          const m = String(url).match(/key=eq\.([^&]+)/);
          const k = m ? decodeURIComponent(m[1]) : null;
          return new Response(JSON.stringify(k && tr.kv[k] !== undefined ? [{ value: tr.kv[k] }] : []), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        for (const r of (Array.isArray(body) ? body : [body])) tr.kv[r.key] = r.value;
        return new Response(null, { status: 201 });
      }
      return new Response(method === 'GET' ? '[]' : null, { status: method === 'GET' ? 200 : 201 });
    },
    kvWrites(key) { return tr.calls.filter(c => c.method === 'POST' && c.url.includes('/kv_store') && c.body && c.body.key === key); },
  };
  return tr;
}

function wire({ timeoutMs = 200 } = {}) {
  const tr = makeTransport();
  const now = clock();
  const breaker = new DbCircuitBreaker({ failThreshold: 3, baseOpenMs: 60_000, writeTimeoutMs: timeoutMs, readTimeoutMs: timeoutMs, now, fetchImpl: tr.fetch });
  const client = createClient('http://db.test', 'test-key', { global: { fetch: breaker.fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  db.__setTestClient(client, breaker);
  return { tr, now, breaker };
}

const ENV = ['RUNTIME_CONFIG_PERSIST_WAIT_MS', 'RUNTIME_CONFIG_RETRY_MS', 'RUNTIME_CONFIG_FALLBACK', 'CREATOR_BLOCKLIST_FALLBACK', 'STATE_SNAPSHOT_DIR'];
const saved = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.STATE_SNAPSHOT_DIR;
  db.__resetForTest();
  db.__setDrainTimerEnabled(false);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  db.__resetForTest();
  db.__setDrainTimerEnabled(true);
});

// runtime-config reads its timing env at module load → fresh copy per test,
// sharing the (test-wired) db module.
function freshRtc() {
  for (const p of ['../services/runtime-config', '../config']) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  const { config } = require('../config');
  const rtc = require('../services/runtime-config');
  return { rtc, config };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// runtime config
// ---------------------------------------------------------------------------
test('runtime-config set() RESPONDS fast with the DB HUNG — value live, persist pending', async () => {
  const { tr } = wire({ timeoutMs: 5000 });
  tr.mode = 'hang';
  process.env.RUNTIME_CONFIG_PERSIST_WAIT_MS = '100';
  const { rtc, config } = freshRtc();
  const t0 = Date.now();
  const r = await rtc.set('maxLegs', 6);
  const ms = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.persisted, 'pending');
  assert.ok(ms < 1000, `set() took ${ms}ms with the DB hung`);
  assert.equal(config.pricing.maxLegs, 6, 'the value is live before the DB answers');
  const t1 = Date.now();
  const items = await rtc.list();
  assert.ok(Date.now() - t1 < 100, 'GET /config/runtime must not wait on the DB');
  assert.equal(items.find(i => i.key === 'maxLegs').overridden, true);
});

test('runtime-config set() RESPONDS with the breaker OPEN (fail fast, persisted:false)', async () => {
  const { breaker, tr } = wire();
  breaker.forceOpen('test');
  const { rtc, config } = freshRtc();
  const r = await rtc.set('maxLegs', 5);
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.equal(config.pricing.maxLegs, 5);
  assert.equal(tr.kvWrites('runtime_config_overrides').length, 0);
});

test('DB-down boot: RUNTIME_CONFIG_FALLBACK applies; a set while down NEVER clobbers the stored overrides; both merge on recovery', async () => {
  const { tr, now, breaker } = wire();
  process.env.RUNTIME_CONFIG_RETRY_MS = '20';
  const { rtc, config } = freshRtc();
  const envLegs = config.pricing.maxLegs;
  const envVig = config.pricing.defaultVig;
  // What production has stored: an override on maxLegs written at today's env baseline.
  tr.kv.runtime_config_overrides = { overrides: { maxLegs: { value: 4, envSnapshot: envLegs, updatedAt: 'x' } } };
  process.env.RUNTIME_CONFIG_FALLBACK = JSON.stringify({ maxLegs: 3, maxOdds: 'not-a-number' });

  breaker.forceOpen('boot probe failed');
  const h = await rtc.hydrate();
  assert.match(h.reason, /load-failed/);
  assert.equal(h.fallback, 'env RUNTIME_CONFIG_FALLBACK');
  assert.equal(config.pricing.maxLegs, 3, 'last-known-good fallback applied at a DB-down boot');

  const s = await rtc.set('defaultVig', 0.033);
  assert.equal(s.ok, true);
  assert.equal(config.pricing.defaultVig, 0.033);
  assert.equal(tr.kvWrites('runtime_config_overrides').length, 0, 'no write before a real DB load — it would clobber maxLegs');
  assert.notEqual(envVig, 0.033);

  // Supabase answers again.
  now.advance(60_001);
  for (let i = 0; i < 50 && tr.kvWrites('runtime_config_overrides').length === 0; i++) await sleep(20);
  const writes = tr.kvWrites('runtime_config_overrides');
  assert.ok(writes.length >= 1, 'the deferred retry persists once the DB is back');
  const stored = tr.kv.runtime_config_overrides.overrides;
  assert.equal(stored.maxLegs.value, 4, 'the stored override survived (not clobbered)');
  assert.equal(stored.defaultVig.value, 0.033, 'the outage-time set reached the DB');
  assert.equal(config.pricing.maxLegs, 4, 'the DB value supersedes the fallback once loaded');
  assert.equal(rtc.getPersistenceState().loaded, true);
  assert.equal(rtc.getPersistenceState().dirty, false);
});

test('a key the operator set during the outage is NOT overwritten by the late DB merge', async () => {
  const { tr, now, breaker } = wire();
  process.env.RUNTIME_CONFIG_RETRY_MS = '20';
  const { rtc, config } = freshRtc();
  tr.kv.runtime_config_overrides = { overrides: { maxLegs: { value: 4, envSnapshot: config.pricing.maxLegs, updatedAt: 'x' } } };
  breaker.forceOpen('down');
  await rtc.hydrate();
  await rtc.set('maxLegs', 7);
  now.advance(60_001);
  for (let i = 0; i < 50 && tr.kvWrites('runtime_config_overrides').length === 0; i++) await sleep(20);
  assert.equal(config.pricing.maxLegs, 7);
  assert.equal(tr.kv.runtime_config_overrides.overrides.maxLegs.value, 7);
});

// ---------------------------------------------------------------------------
// creator blocklist
// ---------------------------------------------------------------------------
function freshBlocklist() {
  const bl = require('../services/creator-blocklist');
  bl.__resetForTest();
  return bl;
}

test('DB-down boot: CREATOR_BLOCKLIST_FALLBACK arms the gate instead of booting EMPTY', async () => {
  const { breaker } = wire();
  breaker.forceOpen('boot probe failed');
  process.env.CREATOR_BLOCKLIST_FALLBACK = 'aaa-1, bbb-2';
  const bl = freshBlocklist();
  try {
    await bl.restoreFromPersistence();
    assert.equal(bl.isBlocked('aaa-1'), true);
    assert.equal(bl.isBlocked('bbb-2'), true);
    assert.equal(bl.getPersistenceState().source, 'env-fallback');
  } finally { bl.__resetForTest(); }
});

test('block made during the outage is live at once, never clobbers the stored list, and merges on recovery', async () => {
  const { tr, now, breaker } = wire();
  tr.kv.creator_blocklist = { entries: [
    { creatorId: 'zzz-9', reason: 'sharp', addedAt: '2026-09-01T00:00:00Z' },
    { creatorId: 'aaa-1', reason: 'sharp', addedAt: '2026-09-01T00:00:00Z' },
  ] };
  breaker.forceOpen('boot probe failed');
  process.env.CREATOR_BLOCKLIST_FALLBACK = 'aaa-1,bbb-2';
  const bl = freshBlocklist();
  try {
    await bl.restoreFromPersistence();
    await bl.add('ccc-3', 'blocked during outage');
    assert.equal(bl.isBlocked('ccc-3'), true, 'the RFQ/confirm gates see the block immediately');
    assert.equal(tr.kvWrites('creator_blocklist').length, 0, 'never persist before a real load (clobber guard)');
    assert.equal(bl.getPersistenceState().pendingOps, 1);

    now.advance(60_001);               // Supabase answers again
    await bl.__refresh();              // the 30s refresh timer's load
    for (let i = 0; i < 50 && tr.kvWrites('creator_blocklist').length === 0; i++) await sleep(10);
    const ids = tr.kv.creator_blocklist.entries.map(e => e.creatorId).sort();
    assert.deepEqual(ids, ['aaa-1', 'ccc-3', 'zzz-9'], 'stored list + outage block; the fallback-only id is dropped (DB authoritative)');
    assert.equal(bl.isBlocked('zzz-9'), true);
    assert.equal(bl.isBlocked('bbb-2'), false);
    assert.equal(bl.getPersistenceState().pendingOps, 0);
    assert.equal(bl.getPersistenceState().source, 'db');
  } finally { bl.__resetForTest(); }
});

test('an UNBLOCK made during the outage is not undone by the next refresh', async () => {
  const { tr, now, breaker } = wire();
  tr.kv.creator_blocklist = { entries: [{ creatorId: 'zzz-9', reason: 'sharp', addedAt: '2026-09-01T00:00:00Z' }] };
  const bl = freshBlocklist();
  try {
    await bl.restoreFromPersistence();       // real load (DB up)
    assert.equal(bl.isBlocked('zzz-9'), true);
    breaker.forceOpen('outage');
    await bl.remove('zzz-9');
    assert.equal(bl.isBlocked('zzz-9'), false);
    now.advance(60_001);
    tr.mode = 'ok';
    await bl.__refresh();                    // loads the STALE stored list (still has zzz-9)…
    assert.equal(bl.isBlocked('zzz-9'), false, '…but the pending unblock is re-applied on top');
    for (let i = 0; i < 50 && bl.getPersistenceState().pendingOps > 0; i++) await sleep(10);
    assert.deepEqual(tr.kv.creator_blocklist.entries, []);
  } finally { bl.__resetForTest(); }
});

test('fallbackEnvValue() is the copy-paste value for CREATOR_BLOCKLIST_FALLBACK', () => {
  const bl = freshBlocklist();
  try {
    bl.__setForTest([{ creatorId: 'x1' }, { creatorId: 'x2' }]);
    assert.deepEqual(bl.fallbackEnvValue().split(',').sort(), ['x1', 'x2']);
  } finally { bl.__resetForTest(); }
});

test('state-snapshot: last-known-good file round-trips and is the preferred fallback', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxrfq-snap-'));
  process.env.STATE_SNAPSHOT_DIR = dir;
  const snap = require('../services/state-snapshot');
  try {
    assert.equal(snap.write('creator-blocklist', { entries: [{ creatorId: 'file-1', reason: 'r', addedAt: 'a' }] }), true);
    assert.equal(snap.read('creator-blocklist').data.entries[0].creatorId, 'file-1');
    const { breaker } = wire();
    breaker.forceOpen('down');
    process.env.CREATOR_BLOCKLIST_FALLBACK = 'env-1';
    const bl = freshBlocklist();
    try {
      await bl.restoreFromPersistence();
      assert.equal(bl.isBlocked('file-1'), true);
      assert.equal(bl.isBlocked('env-1'), false, 'the automatic snapshot is fresher than the env list');
      assert.equal(bl.getPersistenceState().source, 'snapshot');
    } finally { bl.__resetForTest(); }
    delete process.env.STATE_SNAPSHOT_DIR;
    assert.equal(snap.read('creator-blocklist'), null, 'unset dir = disabled');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A BLIP: the read fails but a write would succeed. The breaker is closed, so
// only the load-before-persist rule stands between a partial in-memory copy and
// the stored row.
test('runtime-config: a failed read never lets a write through, even when the write would succeed', async () => {
  const dbPath = require.resolve('../services/db');
  const realEntry = require.cache[dbPath];
  const writes = [];
  const stub = {
    loadKVStrict: async () => ({ ok: false, error: 'timeout', transient: true }),
    loadKV: async () => null,
    saveKV: async (k, v) => { writes.push(v); return { ok: true }; },
  };
  for (const p of ['../services/runtime-config', '../config']) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };
  try {
    const rtc = require('../services/runtime-config');
    await rtc.hydrate();
    const r = await rtc.set('maxLegs', 6);
    assert.equal(r.ok, true);
    assert.equal(r.persisted, false);
    assert.equal(writes.length, 0, 'persisting before a real load would replace every stored override with this one key');
  } finally {
    require.cache[dbPath] = realEntry;
    for (const p of ['../services/runtime-config', '../config']) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  }
});

test('blocklist: a failed read never lets a write through, even when the write would succeed', async () => {
  const orig = { loadKV: db.loadKV, loadKVStrict: db.loadKVStrict, saveKV: db.saveKV };
  const writes = [];
  db.loadKV = async () => null;
  db.loadKVStrict = async () => ({ ok: false, error: 'timeout', transient: true });
  db.saveKV = async (k, v) => { writes.push(v); return { ok: true }; };
  delete process.env.CREATOR_BLOCKLIST_FALLBACK;
  const bl = freshBlocklist();
  try {
    await bl.restoreFromPersistence();
    await bl.add('blip-1', 'during a blip');
    assert.equal(bl.isBlocked('blip-1'), true);
    assert.equal(writes.length, 0, 'a 1-entry list written now would wipe the stored blocklist (2026-06-26 clobber)');
    assert.equal(bl.getPersistenceState().pendingOps, 1);
  } finally {
    Object.assign(db, orig);
    bl.__resetForTest();
  }
});
