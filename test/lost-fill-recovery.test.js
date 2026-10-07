// Lost fills (2026-10-04): fills confirmed while Supabase was unreachable sat in
// the in-memory retry spool and died with the next deploy; with no parlay_orders
// row the settlement poll skipped them as "never quoted by us", so 44 fills /
// -$2,510 were invisible to P&L and exposure. Three fixes, pinned here:
//   1. shutdown flushes the spool (and logs what it cannot write as [SpoolLost])
//   2. a PX fill with a CONFIRMED-absent row is imported — a failed read never is
//   3. an RPC timeout (heavy analytics aggregate) does not trip the breaker
// Fake transport only — never the network or production Supabase.
// Run: node --test test/lost-fill-recovery.test.js

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('@supabase/supabase-js');
const { DbCircuitBreaker } = require('../services/db-breaker');
const db = require('../services/db');
const log = require('../services/logger');
const tracker = require('../services/order-tracker');

function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}
function transport() {
  const tr = {
    mode: 'ok', calls: [], rows: {},
    fetch: async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      tr.calls.push({ method, url: String(url) });
      if (tr.mode === '522') return new Response('error code: 522', { status: 522 });
      if (tr.mode === 'hang' || (tr.mode === 'hang-rpc' && /\/rpc\//.test(String(url)))) {
        return new Promise((_, rej) => init.signal && init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      }
      if (method === 'GET' && /parlay_orders/.test(String(url))) {
        const ids = (decodeURIComponent(String(url)).match(/parlay_id=in\.\(([^)]*)\)/) || [])[1];
        const want = ids ? decodeURIComponent(ids).split(',').map(s => s.replace(/"/g, '')) : [];
        return new Response(JSON.stringify(want.filter(id => tr.rows[id]).map(id => tr.rows[id])), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(null, { status: 201 });
    },
  };
  return tr;
}
function wire(opts = {}) {
  const tr = transport();
  const now = clock();
  const breaker = new DbCircuitBreaker({
    failThreshold: 3, windowMs: 60_000, baseOpenMs: 60_000, maxOpenMs: 600_000,
    writeTimeoutMs: 100, readTimeoutMs: 100, rpcTimeoutMs: opts.rpcTimeoutMs || 100, now, fetchImpl: tr.fetch,
  });
  const client = createClient('http://db.test', 'test-key', { global: { fetch: breaker.fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  db.__setTestClient(client, breaker);
  return { tr, now, breaker };
}
const fill = (id, extra = {}) => ({
  parlayId: id, status: 'confirmed', legs: [{ lineId: 'L1', fairProb: 0.4 }], offeredOdds: 566, fairParlayProb: 0.14,
  confirmedOdds: -566, confirmedStake: 2902.45, orderUuid: `u-${id}`, quotedAt: '2026-10-04T16:18:58Z',
  confirmedAt: '2026-10-04T16:19:03Z', meta: {}, ...extra,
});

beforeEach(() => { db.__resetForTest(); db.__setDrainTimerEnabled(false); });
afterEach(() => { db.__resetForTest(); db.__setDrainTimerEnabled(true); });

async function tripOpen(tr) {
  tr.mode = '522';
  for (let i = 0; i < 3; i++) await db.saveOrder(fill(`trip-${i}`));
}

// ------------------------------------------------------------- 1. shutdown flush
test('shutdown flush writes spooled fills once the DB answers', async () => {
  const { tr, now, breaker } = wire();
  await tripOpen(tr);
  assert.equal(breaker.state, 'open');
  assert.ok(db.__spoolEntries().length >= 3);
  tr.mode = 'ok';
  now.advance(61_000);                       // backoff elapsed → the flush's first write is the probe
  const res = await db.flushSpoolForShutdown(5000);
  assert.equal(res.remaining.total, 0, JSON.stringify(res));
  assert.equal(res.lostCritical, 0);
  assert.ok(res.drained >= 3);
});

test('shutdown flush forces a probe while the breaker is still inside its backoff (2026-10-07: SIGTERM mid-backoff wrote nothing)', async () => {
  const { tr, breaker } = wire();
  await tripOpen(tr);
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.canAttempt(), false, 'backoff NOT elapsed');
  tr.mode = 'ok';                            // DB is back; the breaker does not know yet
  const res = await db.flushSpoolForShutdown(5000);
  assert.equal(res.remaining.total, 0, JSON.stringify(res));
  assert.equal(res.lostCritical, 0);
  assert.ok(res.drained >= 3);
  assert.equal(breaker.state, 'closed');
});

test('forced shutdown probes are bounded: a DB that stays down ends the flush inside the deadline', async () => {
  const { tr } = wire();
  await tripOpen(tr);
  const before = tr.calls.length;
  const t0 = Date.now();
  const orig = log.error; log.error = () => {};
  let res;
  try { res = await db.flushSpoolForShutdown(3000); } finally { log.error = orig; }
  assert.ok(Date.now() - t0 < 3500, 'within the deadline');
  assert.ok(tr.calls.length - before <= 3, `at most 3 probes, saw ${tr.calls.length - before}`);
  assert.equal(res.lostCritical, 3);
});

test('shutdown with the DB still down logs every held fill as [SpoolLost] (recoverable from logs)', async () => {
  const { tr } = wire();
  await tripOpen(tr);
  const lines = [];
  const orig = log.error;
  log.error = (cat, msg) => { lines.push([cat, msg]); };
  try {
    const res = await db.flushSpoolForShutdown(500);
    assert.equal(res.drained, 0);
    assert.equal(res.lostCritical, 3);
  } finally { log.error = orig; }
  const lost = lines.filter(([c]) => c === 'SpoolLost').map(([, m]) => JSON.parse(m));
  assert.equal(lost.length, 3);
  assert.equal(lost[0].kind, 'order');
  assert.equal(lost[0].confirmedStake, 2902.45);
  assert.equal(lost[0].offeredOdds, 566);
  assert.equal(lost[0].legs[0].fairProb, 0.4);
});

test('logger no longer exits on SIGTERM while another handler (the async shutdown) is registered', () => {
  const src = require('fs').readFileSync(require.resolve('../services/logger'), 'utf8');
  assert.match(src, /listenerCount\('SIGTERM'\) <= 1/);
  assert.doesNotMatch(src, /process\.on\('SIGTERM', \(\) => \{ flushNow\(\); process\.exit\(0\); \}\)/);
  const idx = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
  assert.match(idx, /await db\.flushSpoolForShutdown\(/);
});

// ------------------------------------------------------------- 2. import guard
test('a PX fill with a CONFIRMED-absent row is imported; a failed read or a non-fill never is', () => {
  const po = { status: 'settled', settlement_status: 'lost', confirmed_stake: 2571.06 };
  const open = { status: 'finalized', settlement_status: 'tbd', confirmed_stake: 143.62 };
  const rejected = { status: 'rejected', settlement_status: 'tbd', confirmed_stake: null };
  const checked = new Set(['a', 'b', 'c']);
  assert.equal(tracker._shouldImportPxOrder(po, 'a', {}, checked), true);
  assert.equal(tracker._shouldImportPxOrder(open, 'b', {}, checked), true, 'open fills too — they are live exposure');
  assert.equal(tracker._shouldImportPxOrder(rejected, 'c', {}, checked), false, 'our offer, no fill');
  assert.equal(tracker._shouldImportPxOrder(po, 'z', {}, checked), false, 'read failed → unknown → never import');
  assert.equal(tracker._shouldImportPxOrder(po, 'z', { z: { parlayId: 'z' } }, new Set()), true, 'a DB row always imports');
});

test('loadOrdersByParlayIdsChecked: a successful read marks ids checked; a failed read marks none', async () => {
  const { tr } = wire();
  tr.rows.p1 = { parlay_id: 'p1', status: 'confirmed', legs: [], meta: {} };
  const ok = await db.loadOrdersByParlayIdsChecked(['p1', 'p2']);
  assert.ok(ok.rows.p1);
  assert.equal(ok.rows.p2, undefined);
  assert.deepEqual([...ok.checked].sort(), ['p1', 'p2']);
  tr.mode = '522';
  const bad = await db.loadOrdersByParlayIdsChecked(['p3']);
  assert.equal(bad.checked.size, 0, 'a 522 must not read as "no row"');
});

// ------------------------------------------------------------- 3. RPC timeouts
test('an RPC timeout does not count toward tripping the breaker; a write timeout does', async () => {
  const { tr, breaker } = wire({ rpcTimeoutMs: 50 });
  tr.mode = 'hang-rpc';
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => breaker.fetch('http://db.test/rest/v1/rpc/declines_rollup', { method: 'POST', body: '{}' }), e => e.name === 'DbTimeout');
  }
  assert.equal(breaker.state, 'closed', 'five slow aggregates must not open the breaker');
  tr.mode = 'hang';
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => breaker.fetch('http://db.test/rest/v1/parlay_orders', { method: 'POST', body: '{}' }), e => e.name === 'DbTimeout');
  }
  assert.equal(breaker.state, 'open');
});

test('breaker keeps the undici err.cause code on a transport failure (diagnosis of "fetch failed" trips)', async () => {
  const { DbCircuitBreaker: B } = require('../services/db-breaker');
  const br = new B({ failThreshold: 99, fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }); throw e; } });
  await assert.rejects(br.fetch('http://db.test/rest/v1/parlay_orders', { method: 'POST' }));
  assert.match(br.lastError, /fetch failed \[UND_ERR_SOCKET: other side closed\]/);
  assert.equal(br.totals.failureCauses.UND_ERR_SOCKET, 1);
});
