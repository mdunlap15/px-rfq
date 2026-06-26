// Regression tests for the creator-ID blocklist confirm-time gate.
//
// Incident (2026-06-26): blocked creator 45628ef7-dbdb-46f9-b143-3f47822a9013
// got a confirmed fill (parlay 019f0227-63b4-7705-a412-e11710cbfa8d, quoted
// 04:19:23, confirmed 04:19:42 — ~19s apart) even though meta.creatorId was
// stamped at quote time. Root cause: blocklist hydration ran fire-and-forget
// AFTER websocket.connect and behind slow Puppeteer pre-warms, so the in-memory
// _blocked cache was EMPTY when both the RFQ and the confirm arrived. Every gate
// decides via that cache, so both failed open.
//
// Fix under test: creator-blocklist.ensureFresh() self-heals a cold/stale cache
// (bounded), and resolveConfirmBlock() runs it before deciding — meta first,
// bounded REST fallback second. These tests prove the confirm gate now rejects
// a blocked creator FROM A COLD CACHE both when meta.creatorId is present and
// when it must be resolved via REST, and that the hot-path safety bounds hold.
//
// Run: npm test   (or: node --test test/creator-blocklist.test.js)

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const db = require('../services/db');
const blocklist = require('../services/creator-blocklist');

const BLOCKED = '45628ef7-dbdb-46f9-b143-3f47822a9013'; // the real incident creator
const INNOCENT = '00000000-0000-0000-0000-000000000000';

const _origLoadKV = db.loadKV;
// IMPORTANT: stub saveKV too. add()/remove() call _persist() → db.saveKV, and
// without a stub the test writes its (empty/test) blocklist to the REAL Supabase
// kv_store, wiping production entries. (This happened 2026-06-26: a test run
// clobbered the live 6-entry blocklist down to 1.) beforeEach installs a no-op;
// afterEach restores the real one.
const _origSaveKV = db.saveKV;

// Build a kv_store payload shaped like the persisted blocklist row.
function kvWith(...creatorIds) {
  return {
    entries: creatorIds.map(creatorId => ({
      creatorId,
      reason: 'sharp',
      addedAt: '2026-05-20T00:00:00.000Z',
    })),
    updatedAt: '2026-05-20T00:00:00.000Z',
  };
}

// Replace db.loadKV with a counting mock. creator-blocklist holds a reference to
// the shared db module object and calls db.loadKV at call time, so mutating the
// property here is picked up.
function mockLoadKV(impl) {
  const calls = { count: 0 };
  db.loadKV = async (...args) => { calls.count++; return impl(...args); };
  return calls;
}

beforeEach(() => {
  // Never let a test persist to the real kv_store (see _origSaveKV note above).
  db.saveKV = async () => {};
  blocklist.__resetForTest(); // cold-boot state: empty + uninitialized
});

afterEach(() => {
  db.loadKV = _origLoadKV;
  db.saveKV = _origSaveKV;
  blocklist.__resetForTest();
});

// --- Core root-cause: a cold cache fails open until ensureFresh repopulates ---

test('cold cache reports NOT blocked (reproduces the fail-open), ensureFresh fixes it', async () => {
  mockLoadKV(() => kvWith(BLOCKED));

  // This is the exact bug: on a cold boot isBlocked() returns false for a
  // creator that IS persisted, so both gates wave the order through.
  assert.equal(blocklist.isBlocked(BLOCKED), false, 'cold cache should fail open before refresh');

  await blocklist.ensureFresh();

  assert.equal(blocklist.isBlocked(BLOCKED), true, 'ensureFresh must self-heal the cold cache');
});

// --- The exact incident: meta.creatorId present, cache cold at confirm time ---

test('resolveConfirmBlock rejects with meta.creatorId present even when cache is cold', async () => {
  mockLoadKV(() => kvWith(BLOCKED));

  let restCalled = false;
  const verdict = await blocklist.resolveConfirmBlock({
    metaCreatorId: BLOCKED,
    fetchLiveCreatorId: async () => { restCalled = true; return 'should-not-be-used'; },
  });

  assert.equal(verdict.blocked, true, 'must reject the blocked creator');
  assert.equal(verdict.via, 'meta', 'should decide via meta, not REST');
  assert.equal(verdict.creatorId, BLOCKED);
  assert.equal(restCalled, false, 'must not pay the REST round-trip when meta has the id');
});

// --- The meta-omitted path: REST must resolve the id, cache cold ---

test('resolveConfirmBlock rejects via REST when meta lacks the id (cold cache)', async () => {
  mockLoadKV(() => kvWith(BLOCKED));

  let restCalled = false;
  const verdict = await blocklist.resolveConfirmBlock({
    metaCreatorId: null,
    fetchLiveCreatorId: async () => { restCalled = true; return BLOCKED; },
  });

  assert.equal(restCalled, true, 'must resolve creator live when meta lacks it');
  assert.equal(verdict.via, 'rest');
  assert.equal(verdict.blocked, true, 'must reject the REST-resolved blocked creator');
  assert.equal(verdict.creatorId, BLOCKED);
});

// --- Gap-plug preserved: no REST round-trip when there is nobody to block ---

test('resolveConfirmBlock skips REST when the blocklist is empty', async () => {
  mockLoadKV(() => kvWith()); // empty list — a real "no blocked creators" load

  let restCalled = false;
  const verdict = await blocklist.resolveConfirmBlock({
    metaCreatorId: null,
    fetchLiveCreatorId: async () => { restCalled = true; return 'whoever'; },
  });

  assert.equal(restCalled, false, 'no REST when there is nobody to block');
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.via, null);
});

// --- No false positives: a non-blocked creator passes ---

test('resolveConfirmBlock allows a non-blocked creator through', async () => {
  mockLoadKV(() => kvWith(BLOCKED));

  const verdict = await blocklist.resolveConfirmBlock({
    metaCreatorId: INNOCENT,
    fetchLiveCreatorId: async () => INNOCENT,
  });

  assert.equal(verdict.blocked, false);
  assert.equal(verdict.via, 'meta');
});

// --- Hot-path safety: ensureFresh is bounded, never hangs on a slow Supabase ---

test('ensureFresh resolves within the timeout even if loadKV hangs forever', async () => {
  mockLoadKV(() => new Promise(() => {})); // never resolves

  const start = Date.now();
  await blocklist.ensureFresh(); // must not hang
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1500, `ensureFresh should bound to ~800ms, took ${elapsed}ms`);
  assert.equal(blocklist.isBlocked(BLOCKED), false, 'no data loaded on timeout — stays as-is');
});

// --- Steady-state perf: fresh cache means no extra DB round-trips ---

test('ensureFresh does not re-hit the DB while the cache is fresh', async () => {
  const calls = mockLoadKV(() => kvWith(BLOCKED));

  await blocklist.ensureFresh();
  assert.equal(calls.count, 1, 'first ensureFresh loads');

  await blocklist.ensureFresh();
  assert.equal(calls.count, 1, 'second ensureFresh within maxAge must not re-load');
});

// --- Post-block sweep: add() rejects the creator's still-open resting quotes ---

test('add() sweeps the blocked creator\'s open quotes and releases their exposure', async () => {
  mockLoadKV(() => kvWith()); // start empty so add() is a genuine new block
  const orderTracker = require('../services/order-tracker');

  // Two resting quotes from the soon-to-be-blocked creator, one from an innocent.
  orderTracker.recordQuote('sweep-blk-1', [{ team: 'X', market: 'spread', sport: 'baseball_mlb' }],
    100, 50, 0.45, { creatorId: BLOCKED });
  orderTracker.recordQuote('sweep-blk-2', [{ team: 'Y', market: 'total', sport: 'baseball_mlb' }],
    120, 75, 0.40, { creatorId: BLOCKED });
  orderTracker.recordQuote('sweep-ok-1', [{ team: 'Z', market: 'spread', sport: 'baseball_mlb' }],
    110, 60, 0.42, { creatorId: INNOCENT });

  const result = await blocklist.add(BLOCKED, 'sharp');

  assert.equal(result.added, true);
  assert.ok(result.sweep, 'add() should return a sweep summary');
  assert.equal(result.sweep.swept, 2, 'both blocked-creator open quotes are swept');
  assert.equal(result.sweep.riskReleased, 125, 'released risk = 50 + 75');
  assert.deepEqual(result.sweep.parlayIds.sort(), ['sweep-blk-1', 'sweep-blk-2']);
});

// --- A transient null load must NOT mark the cache fresh (no fail-open-but-fresh) ---

test('a null/error load does not satisfy freshness — a later ensureFresh retries', async () => {
  let phase = 0;
  db.loadKV = async () => {
    phase++;
    return phase === 1 ? null : kvWith(BLOCKED); // first call "errors", second succeeds
  };

  await blocklist.ensureFresh();
  assert.equal(blocklist.isBlocked(BLOCKED), false, 'null load leaves cache empty');

  await blocklist.ensureFresh();
  assert.equal(blocklist.isBlocked(BLOCKED), true, 'retry must load real data (null did not mark fresh)');
});
