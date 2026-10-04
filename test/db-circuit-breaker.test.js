// Supabase circuit breaker, retry spool, quote sampling and write-volume cuts.
//
// Incident 2026-10-03: Supabase (Small compute) went unhealthy for ~13h while
// the trader kept writing — every call hanging ~20s to a Cloudflare 522 — so
// it never recovered (568K requests/24h, 162K gateway errors). These tests pin
// the breaker state machine with an injected clock + fake fetch, and drive the
// REAL supabase-js client through it against a fake transport. Nothing here
// touches the network or production Supabase: the client points at
// http://db.test and every request is answered by fakeFetch below.
//
// Run: npm test   (or: node --test test/db-circuit-breaker.test.js)

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('@supabase/supabase-js');
const { DbCircuitBreaker, isTransientResult } = require('../services/db-breaker');
const db = require('../services/db');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function jsonResponse(status, body) {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

// A programmable transport. mode: 'ok' | '522' | 'throw' | 'hang' | '500' | '400'
function makeTransport() {
  const tr = {
    mode: 'ok',
    calls: [],
    kv: {}, // fake kv_store for GETs on /kv_store
    fetch: async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const body = init.body ? (() => { try { return JSON.parse(init.body); } catch (_) { return init.body; } })() : null;
      tr.calls.push({ method, url: String(url), body });
      switch (tr.mode) {
        case '522': return new Response('error code: 522', { status: 522 });
        case '500': return jsonResponse(500, { message: 'canceling statement due to statement timeout', code: '57014' });
        case '400': return jsonResponse(400, { message: 'column "nope" does not exist', code: '42703' });
        case 'throw': throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
        case 'hang': return new Promise((_, rej) => {
          if (init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
        default: {
          if (method === 'GET' && /\/kv_store/.test(String(url))) {
            const m = String(url).match(/key=eq\.([^&]+)/);
            const k = m ? decodeURIComponent(m[1]) : null;
            const v = k && tr.kv[k] !== undefined ? [{ value: tr.kv[k] }] : [];
            return jsonResponse(200, v);
          }
          if (method === 'POST' && /\/kv_store/.test(String(url))) {
            const rows = Array.isArray(body) ? body : [body];
            for (const r of rows) tr.kv[r.key] = r.value;
            return new Response(null, { status: 201 });
          }
          if (method === 'GET') return jsonResponse(200, []);
          return new Response(null, { status: 201 });
        }
      }
    },
    writes(table) {
      return tr.calls.filter(c => c.method !== 'GET' && c.method !== 'HEAD' && c.url.includes(`/rest/v1/${table}`));
    },
  };
  return tr;
}

function wire(opts = {}) {
  const tr = makeTransport();
  const now = clock();
  const breaker = new DbCircuitBreaker({
    failThreshold: 3, windowMs: 60_000, baseOpenMs: 60_000, maxOpenMs: 600_000,
    writeTimeoutMs: opts.timeoutMs || 200, readTimeoutMs: opts.timeoutMs || 200,
    now, fetchImpl: tr.fetch,
  });
  const client = createClient('http://db.test', 'test-key', {
    global: { fetch: breaker.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  db.__setTestClient(client, breaker);
  return { tr, now, breaker, client };
}

const ENV_KEYS = ['QUOTE_PERSIST_SAMPLE', 'DB_SPOOL_MAX', 'DB_SPOOL_CRITICAL_MAX', 'LINE_CACHE_FULL_RESAVE_HOURS'];
const savedEnv = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  db.__resetForTest();
  db.__setDrainTimerEnabled(false);
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  db.__resetForTest();
  db.__setDrainTimerEnabled(true);
});

function confirmedOrder(id, extra = {}) {
  return {
    parlayId: id, status: 'confirmed', legs: [{ lineId: 'L1' }], offeredOdds: 250, maxRisk: 100,
    fairParlayProb: 0.25, confirmedOdds: -250, confirmedStake: 40, orderUuid: `u-${id}`,
    quotedAt: '2026-10-03T12:00:00Z', confirmedAt: '2026-10-03T12:00:05Z', meta: {}, ...extra,
  };
}
function quote(id, extra = {}) {
  return { parlayId: id, status: 'quoted', legs: [{ lineId: 'L1' }], offeredOdds: 250, maxRisk: 100, fairParlayProb: 0.25, quotedAt: '2026-10-03T12:00:00Z', meta: {}, ...extra };
}
// Find parlay ids that are (not) in the deterministic quote sample.
function idsBySample(want, n, rate = db.quotePersistSampleRate()) {
  const out = [];
  for (let i = 0; out.length < n && i < 100000; i++) {
    const id = `pid-${want ? 's' : 'u'}-${i}`;
    if (db.isQuoteSampled(id, rate) === want) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. state machine (pure)
// ---------------------------------------------------------------------------
test('breaker OPENS after N consecutive outage failures and then fails FAST with no network', async () => {
  const tr = makeTransport(); tr.mode = '522';
  const now = clock();
  const b = new DbCircuitBreaker({ failThreshold: 5, now, fetchImpl: tr.fetch, writeTimeoutMs: 1000, readTimeoutMs: 1000 });
  for (let i = 0; i < 5; i++) {
    const res = await b.fetch('http://db.test/rest/v1/parlay_orders', { method: 'POST' });
    assert.equal(res.status, 522);
  }
  assert.equal(b.state, 'open');
  const before = tr.calls.length;
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/parlay_orders', { method: 'POST' }), e => e.name === 'DbCircuitOpen');
  assert.equal(tr.calls.length, before, 'an open breaker must not touch the network');
  assert.equal(b.snapshot().totals.fastFailed, 1);
});

test('blips among healthy traffic do NOT trip (consecutive count resets on success; ratio < 50%)', async () => {
  const tr = makeTransport();
  const b = new DbCircuitBreaker({ failThreshold: 5, now: clock(), fetchImpl: tr.fetch });
  tr.mode = 'throw';
  for (let i = 0; i < 4; i++) await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  tr.mode = 'ok';
  for (let i = 0; i < 10; i++) await b.fetch('http://db.test/rest/v1/x', {});
  tr.mode = 'throw';
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  assert.equal(b.state, 'closed');
});

test('a mostly-dead window trips even with interleaved successes (>= N failures AND >= 50%)', async () => {
  const tr = makeTransport();
  const b = new DbCircuitBreaker({ failThreshold: 5, now: clock(), fetchImpl: tr.fetch });
  for (let i = 0; i < 5; i++) {
    tr.mode = 'throw'; await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
    if (b.state === 'open') break;
    tr.mode = 'ok'; await b.fetch('http://db.test/rest/v1/x', {});
  }
  assert.equal(b.state, 'open', '5 failures / 9 requests in 60s must trip');
});

test('a query-level 500 (statement timeout) and a 4xx are NOT outage failures', async () => {
  const tr = makeTransport();
  const b = new DbCircuitBreaker({ failThreshold: 3, now: clock(), fetchImpl: tr.fetch });
  tr.mode = '500';
  for (let i = 0; i < 6; i++) await b.fetch('http://db.test/rest/v1/x', {});
  tr.mode = '400';
  for (let i = 0; i < 6; i++) await b.fetch('http://db.test/rest/v1/x', {});
  assert.equal(b.state, 'closed');
});

test('hard client-side timeout: a hung request rejects as DbTimeout and counts as a failure', async () => {
  const tr = makeTransport(); tr.mode = 'hang';
  const b = new DbCircuitBreaker({ failThreshold: 2, now: clock(), fetchImpl: tr.fetch, writeTimeoutMs: 60, readTimeoutMs: 60 });
  const t0 = Date.now();
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', { method: 'POST' }), e => e.name === 'DbTimeout');
  assert.ok(Date.now() - t0 < 1000, 'must not wait anywhere near the ~20s Cloudflare hang');
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}), e => e.name === 'DbTimeout');
  assert.equal(b.state, 'open');
  assert.equal(b.snapshot().totals.timeouts, 2);
});

test('HALF-OPEN: after the backoff exactly one probe goes out; others still fail fast', async () => {
  const tr = makeTransport(); tr.mode = 'throw';
  const now = clock();
  const b = new DbCircuitBreaker({ failThreshold: 2, baseOpenMs: 60_000, now, fetchImpl: tr.fetch });
  for (let i = 0; i < 2; i++) await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  assert.equal(b.state, 'open');
  now.advance(59_000);
  assert.equal(b.canAttempt(), false);
  now.advance(2_000);
  assert.equal(b.canAttempt(), true);
  tr.mode = 'hang';
  const before = tr.calls.length;
  const probe = b.fetch('http://db.test/rest/v1/x', {}).catch(e => e);
  assert.equal(b.state, 'half_open');
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}), e => e.name === 'DbCircuitOpen');
  assert.equal(tr.calls.length, before + 1, 'only the probe reached the network');
  await probe;
});

test('probe success CLOSES (and notifies listeners); probe failure re-opens with DOUBLED backoff, capped', async () => {
  const tr = makeTransport(); tr.mode = 'throw';
  const now = clock();
  const b = new DbCircuitBreaker({ failThreshold: 1, baseOpenMs: 60_000, maxOpenMs: 200_000, now, fetchImpl: tr.fetch });
  const events = [];
  b.onStateChange(e => events.push(`${e.from}->${e.to}`));
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  assert.equal(b.openUntil - now(), 60_000);
  now.advance(60_000);
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {})); // failed probe
  assert.equal(b.state, 'open');
  assert.equal(b.openUntil - now(), 120_000, 'backoff doubles');
  now.advance(120_000);
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  assert.equal(b.openUntil - now(), 200_000, 'capped at maxOpenMs');
  now.advance(200_000);
  tr.mode = 'ok';
  const res = await b.fetch('http://db.test/rest/v1/x', {});
  assert.equal(res.ok, true);
  assert.equal(b.state, 'closed');
  assert.ok(events.includes('half_open->closed'));
});

test('backoff level resets once the breaker has stayed closed for a full max window', async () => {
  const tr = makeTransport();
  const now = clock();
  const b = new DbCircuitBreaker({ failThreshold: 1, baseOpenMs: 1000, maxOpenMs: 10_000, now, fetchImpl: tr.fetch });
  tr.mode = 'throw';
  await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  now.advance(1000); await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));  // level 1
  now.advance(2000); tr.mode = 'ok'; await b.fetch('http://db.test/rest/v1/x', {});         // closes
  tr.mode = 'throw'; await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));   // flap → escalates
  assert.equal(b.openUntil - now(), 4000, 'a re-trip soon after closing escalates');
  now.advance(4000); tr.mode = 'ok'; await b.fetch('http://db.test/rest/v1/x', {});
  now.advance(10_001);
  tr.mode = 'throw'; await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  assert.equal(b.openUntil - now(), 1000, 'after a full max window closed, back to the base backoff');
});

test('isTransientResult: status 0 / gateway 5xx are transient; 400 and query 500 are not', () => {
  assert.equal(isTransientResult({ error: { message: 'x' }, status: 0 }), true);
  assert.equal(isTransientResult({ error: { message: 'x' }, status: 522 }), true);
  assert.equal(isTransientResult({ error: { message: 'x' }, status: 400 }), false);
  assert.equal(isTransientResult({ error: { message: 'x' }, status: 500 }), false);
  assert.equal(isTransientResult({ error: null, status: 0 }), false);
});

// ---------------------------------------------------------------------------
// 2. real supabase-js client through the breaker
// ---------------------------------------------------------------------------
test('supabase-js surfaces an open breaker as { error, status:0 } — callers take their existing unavailable path', async () => {
  const { tr, breaker, client } = wire();
  tr.mode = 'throw';
  for (let i = 0; i < 3; i++) await client.from('parlay_orders').select('*').limit(1);
  assert.equal(breaker.state, 'open');
  const res = await client.from('parlay_orders').select('*').limit(1);
  assert.equal(res.status, 0);
  assert.match(res.error.message, /DbCircuitOpen/);
  assert.equal(await db.loadKV('anything'), null);
  const strict = await db.loadKVStrict('anything');
  assert.equal(strict.ok, false, 'strict read must report "could not read", never "empty"');
});

test('while OPEN: confirmed orders + matched parlays SPOOL as critical, no network', async () => {
  const { tr, breaker } = wire();
  breaker.forceOpen('test');
  const n0 = tr.calls.length;
  assert.equal(await db.saveOrder(confirmedOrder('c1')), 'spooled');
  assert.equal(await db.saveMatchedParlay({ parlayId: 'm1', matchedAmericanOdds: 300, matchedStake: 50, legs: [], outcome: 'other_sp', matchedAt: '2026-10-03T12:00:00Z' }), 'spooled');
  assert.equal(tr.calls.length, n0);
  const entries = db.__spoolEntries();
  assert.deepEqual(entries.map(e => [e.kind, e.critical]), [['order', true], ['matched', true]]);
});

test('the same order saved repeatedly while down occupies ONE spool slot and upgrades to critical', async () => {
  const { breaker } = wire();
  process.env.QUOTE_PERSIST_SAMPLE = '1';
  breaker.forceOpen('test');
  const o = quote('q-up');
  await db.saveOrder(o);
  assert.equal(db.__spoolEntries()[0].critical, false);
  Object.assign(o, confirmedOrder('q-up'));
  await db.saveOrder(o);
  await db.saveOrder(o);
  const e = db.__spoolEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].critical, true);
});

test('spool cap evicts the oldest DROPPABLE rows first and never a critical row', async () => {
  const { breaker } = wire();
  process.env.QUOTE_PERSIST_SAMPLE = '1';
  process.env.DB_SPOOL_MAX = '5';
  breaker.forceOpen('test');
  await db.saveOrder(confirmedOrder('c-a'));
  for (let i = 0; i < 6; i++) await db.saveOrder(quote(`q-${i}`));
  await db.saveOrder(confirmedOrder('c-b'));
  await db.saveOrder(confirmedOrder('c-c'));
  await db.saveOrder(confirmedOrder('c-d'));
  await db.saveOrder(confirmedOrder('c-e'));
  await db.saveOrder(confirmedOrder('c-f')); // 6 criticals > cap 5: still all kept
  const keys = db.__spoolEntries().map(e => e.key);
  for (const c of ['c-a', 'c-b', 'c-c', 'c-d', 'c-e', 'c-f']) assert.ok(keys.includes(`order:${c}`), `critical ${c} must survive`);
  assert.equal(keys.filter(k => k.startsWith('order:q-')).length, 0, 'droppables evicted once criticals fill the cap');
  const h = db.getHealth();
  assert.equal(h.spool.droppedCritical, 0);
  assert.ok(h.spool.droppedDroppable >= 6);
});

test('critical rows are only ever dropped past the separate critical cap, and that is counted loudly', async () => {
  const { breaker } = wire();
  process.env.DB_SPOOL_MAX = '2';
  process.env.DB_SPOOL_CRITICAL_MAX = '3';
  breaker.forceOpen('test');
  for (let i = 0; i < 5; i++) await db.saveOrder(confirmedOrder(`cc-${i}`));
  assert.equal(db.__spoolEntries().length, 3);
  assert.equal(db.getHealth().spool.droppedCritical, 2);
});

test('DRAIN: after recovery replays critical first, paced at <= N rows per tick, then droppables', async () => {
  const { tr, now, breaker } = wire();
  process.env.QUOTE_PERSIST_SAMPLE = '1';
  tr.mode = 'throw';
  for (let i = 0; i < 3; i++) await db.saveOrder(quote(`dq-${i}`));       // trips (3 failures) → spooled droppable
  assert.equal(breaker.state, 'open');
  for (let i = 0; i < 25; i++) await db.saveOrder(confirmedOrder(`dc-${i}`, { orderUuid: null, status: 'settled_won', confirmedAt: '2026-10-03T12:00:05Z' }));
  assert.equal(db.__spoolEntries().length, 28);

  assert.equal(await db._drainOnce(20), 0, 'nothing is sent while the backoff runs');
  now.advance(60_001);
  tr.mode = 'ok';
  const n0 = tr.writes('parlay_orders').length;
  const n = await db._drainOnce(20);
  assert.equal(n, 20, 'paced: one tick replays at most 20 rows');
  assert.equal(breaker.state, 'closed', 'the first replay was the half-open probe');
  const replayed = tr.writes('parlay_orders').slice(n0).map(c => c.body.parlay_id);
  assert.ok(replayed.every(id => id.startsWith('dc-')), 'critical rows drain before droppable ones');
  assert.equal(db.__spoolEntries().length, 8);
  await db._drainOnce(20);
  assert.equal(db.__spoolEntries().length, 0);
  assert.equal(db.getHealth().spool.drained, 28);
});

test('a replay that hits the DB down again keeps the row (never loses a fill) and stops the tick', async () => {
  const { tr, now, breaker } = wire();
  breaker.forceOpen('test');
  await db.saveOrder(confirmedOrder('keep-1'));
  await db.saveOrder(confirmedOrder('keep-2'));
  now.advance(60_001);
  tr.mode = '522';
  const n = await db._drainOnce(20);
  assert.equal(n, 0);
  assert.equal(breaker.state, 'open');
  assert.deepEqual(db.__spoolEntries().map(e => e.key).sort(), ['order:keep-1', 'order:keep-2']);
});

test('matched parlays replay as inserts; KV critical writes are latest-value-wins', async () => {
  const { tr, now, breaker } = wire();
  breaker.forceOpen('test');
  await db.saveMatchedParlay({ parlayId: 'mx', matchedAmericanOdds: 300, matchedStake: 50, legs: [], outcome: 'other_sp', matchedAt: '2026-10-03T12:00:00Z' });
  await db.saveKV('websocket_paused_state', { paused: true }, { critical: true });
  await db.saveKV('websocket_paused_state', { paused: false }, { critical: true });
  const nonCritical = await db.saveKV('golf_board', { x: 1 });
  assert.equal(nonCritical.spooled, false, 'non-critical KV writes are not spooled');
  assert.equal(db.__spoolEntries().length, 2);
  now.advance(60_001);
  await db._drainOnce(20);
  assert.equal(tr.writes('matched_parlays').length, 1);
  assert.deepEqual(tr.kv.websocket_paused_state, { paused: false });
});

test('declines are HELD (not dropped, no network) while open and flushed after recovery', async () => {
  const { tr, now, breaker } = wire();
  breaker.forceOpen('test');
  await db.saveDecline({ parlayId: 'd1', reason: 'stale odds' });
  await db.saveDecline({ parlayId: 'd2', reason: 'stale odds' });
  assert.equal(await db.flushDeclines(), 0);
  assert.equal(tr.writes('declines').length, 0);
  assert.equal(db.getDeclineWriteStats().buffered, 2);
  now.advance(60_001);
  assert.equal(await db.flushDeclines(), 2);
  assert.equal(tr.writes('declines').length, 1, 'one multi-row insert');
  assert.equal(db.getDeclineWriteStats().dropped, 0);
});

test('a transient decline-flush failure puts the batch back instead of dropping it', async () => {
  const { tr } = wire();
  await db.saveDecline({ parlayId: 'd1', reason: 'x' });
  tr.mode = '522';
  assert.equal(await db.flushDeclines(), 0);
  assert.equal(db.getDeclineWriteStats().buffered, 1);
  assert.equal(db.getDeclineWriteStats().dropped, 0);
});

test('loadOrders ABORTS immediately when the DB is unreachable and reports ok:false', async () => {
  const { tr, breaker } = wire();
  tr.mode = 'throw';
  const t0 = Date.now();
  const rows = await db.loadOrders(200000);
  assert.ok(Date.now() - t0 < 5000, 'must not page 200 x 4 retries against a dead DB');
  assert.equal(rows.length, 0);
  assert.equal(db.getLastOrdersLoad().ok, false);
  assert.equal(breaker.state, 'open');
});

test('bootProbe forces the breaker open when Supabase does not answer', async () => {
  const { tr, breaker } = wire();
  tr.mode = 'hang';
  process.env.DB_BOOT_PROBE_MS = '50';
  try {
    const r = await db.bootProbe();
    assert.equal(r.ok, false);
    assert.equal(breaker.state, 'open');
  } finally { delete process.env.DB_BOOT_PROBE_MS; }
});

// ---------------------------------------------------------------------------
// 3. write-volume cuts
// ---------------------------------------------------------------------------
test('quote sampling is deterministic and ~QUOTE_PERSIST_SAMPLE of quotes (default 5%)', () => {
  delete process.env.QUOTE_PERSIST_SAMPLE;
  assert.equal(db.quotePersistSampleRate(), 0.05);
  let hits = 0;
  for (let i = 0; i < 20000; i++) if (db.isQuoteSampled(`p-${i}`)) hits++;
  assert.ok(hits > 850 && hits < 1150, `expected ~1000/20000, got ${hits}`);
  assert.equal(db.isQuoteSampled('abc'), db.isQuoteSampled('abc'));
  assert.equal(db.isQuoteSampled('abc', 0), false);
  assert.equal(db.isQuoteSampled('abc', 1), true);
  process.env.QUOTE_PERSIST_SAMPLE = 'junk';
  assert.equal(db.quotePersistSampleRate(), 0.05);
});

test('an UNSAMPLED unfilled quote is never written; a sampled one is written ONCE-weighted (meta.persistWeight = 1/rate)', async () => {
  const { tr } = wire();
  delete process.env.QUOTE_PERSIST_SAMPLE;
  const [u] = idsBySample(false, 1);
  const [s] = idsBySample(true, 1);
  assert.equal(await db.saveOrder(quote(u)), 'skipped');
  assert.equal(tr.writes('parlay_orders').length, 0);
  assert.equal(await db.saveOrder(quote(s)), 'saved');
  const w = tr.writes('parlay_orders');
  assert.equal(w.length, 1);
  assert.equal(w[0].body.meta.persistWeight, 20);
  assert.equal(db.quoteRowWeight({ meta: { persistWeight: 20 } }), 20);
  assert.equal(db.quoteRowWeight({ meta: {} }), 1);
  assert.equal(db.getHealth().writes.quotes.skipped, 1);
});

test('a quote is ALWAYS persisted once something happens to it (matched / confirmed / rejected), with no sample weight', async () => {
  const { tr } = wire();
  delete process.env.QUOTE_PERSIST_SAMPLE;
  const ids = idsBySample(false, 4);
  assert.equal(await db.saveOrder(quote(ids[0], { meta: { matchedByOtherSp: { matchedOdds: 300 } } })), 'saved');
  assert.equal(await db.saveOrder(quote(ids[1], { meta: { matchedTieUnclaimed: { matchedOdds: 250 } } })), 'saved');
  assert.equal(await db.saveOrder(confirmedOrder(ids[2])), 'saved');
  assert.equal(await db.saveOrder({ ...quote(ids[3]), status: 'rejected' }), 'saved');
  const w = tr.writes('parlay_orders');
  assert.ok(w.length >= 4);
  for (const c of w) if (c.body && c.body.meta) assert.equal(c.body.meta.persistWeight, undefined);
});

test('QUOTE_PERSIST_SAMPLE=1 restores persist-every-quote (no weight); 0 persists none', async () => {
  const { tr } = wire();
  process.env.QUOTE_PERSIST_SAMPLE = '1';
  for (let i = 0; i < 5; i++) await db.saveOrder(quote(`all-${i}`));
  assert.equal(tr.writes('parlay_orders').length, 5);
  assert.equal(tr.writes('parlay_orders')[0].body.meta.persistWeight, undefined);
  process.env.QUOTE_PERSIST_SAMPLE = '0';
  for (let i = 0; i < 5; i++) await db.saveOrder(quote(`none-${i}`));
  assert.equal(tr.writes('parlay_orders').length, 5);
});

test('line_cache is DIFF-ONLY: an unchanged index costs zero requests; one changed line upserts one row', async () => {
  const { tr } = wire();
  process.env.LINE_CACHE_FULL_RESAVE_HOURS = '1000';
  const idx = {};
  for (let i = 0; i < 1200; i++) idx[`L${i}`] = { sport: 'baseball_mlb', pxEventId: `E${i % 30}`, marketType: 'total', line: 8.5, teamName: 'Over' };
  await db.saveLineCache(idx, { full: true });
  assert.equal(tr.writes('line_cache').length, 3, '1200 rows / 500 per chunk on the first (full) save');
  await db.saveLineCache(idx);
  assert.equal(tr.writes('line_cache').length, 3, 'nothing changed → no request');
  idx.L7 = { ...idx.L7, line: 9 };
  idx.NEW = { sport: 'baseball_mlb', pxEventId: 'E1', marketType: 'total', line: 7.5 };
  await db.saveLineCache(idx);
  const w = tr.writes('line_cache');
  assert.equal(w.length, 4);
  assert.deepEqual(w[3].body.map(r => r.line_id).sort(), ['L7', 'NEW']);
});

test('line_cache: a failed chunk is retried on the next seed (fingerprints only recorded on success)', async () => {
  const { tr, breaker } = wire();
  process.env.LINE_CACHE_FULL_RESAVE_HOURS = '1000';
  const idx = { A: { sport: 's', line: 1 }, B: { sport: 's', line: 2 } };
  tr.mode = '400';
  await db.saveLineCache(idx);
  tr.mode = 'ok';
  await db.saveLineCache(idx);
  const w = tr.writes('line_cache');
  assert.equal(w[w.length - 1].body.length, 2);
  breaker.forceOpen('test');
  const n = tr.calls.length;
  idx.C = { sport: 's', line: 3 };
  await db.saveLineCache(idx);
  assert.equal(tr.calls.length, n, 'skipped entirely while the breaker is open');
});

test('SGP audits are BATCHED: many declines → one multi-row upsert, deduped by parlay_id', async () => {
  const { tr } = wire();
  await db.saveSgpAudit({ parlay_id: 's1', legs: [] });
  await db.saveSgpAudit({ parlay_id: 's2', legs: [] });
  await db.saveSgpAudit({ parlay_id: 's1', legs: [{ x: 1 }] });
  assert.equal(tr.writes('sgp_audit').length, 0, 'buffered, not one request per decline');
  await db.flushSgpAudits();
  const w = tr.writes('sgp_audit');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].body.map(r => r.parlay_id).sort(), ['s1', 's2']);
});

test('/status payload carries breaker, spool and write-volume state', async () => {
  const { breaker } = wire();
  breaker.forceOpen('boot probe failed: test');
  await db.saveOrder(confirmedOrder('st-1'));
  const h = db.getHealth();
  assert.equal(h.breaker.state, 'open');
  assert.equal(h.spool.critical, 1);
  assert.ok(h.breaker.retryInSec > 0);
  assert.ok('quotePersistSample' in h.writes);
  const brief = db.getHealth({ brief: true });
  assert.deepEqual(Object.keys(brief).sort(), ['droppedCritical', 'enabled', 'retryInSec', 'spooled', 'spooledCritical', 'state']);
});

test('the CONSECUTIVE rule trips on its own: 5 straight failures after a healthy minute (window ratio < 50%)', async () => {
  const tr = makeTransport();
  const b = new DbCircuitBreaker({ failThreshold: 5, now: clock(), fetchImpl: tr.fetch });
  for (let i = 0; i < 20; i++) await b.fetch('http://db.test/rest/v1/x', {});
  tr.mode = 'throw';
  for (let i = 0; i < 5; i++) await assert.rejects(() => b.fetch('http://db.test/rest/v1/x', {}));
  assert.equal(b.state, 'open', '5/25 is only 20% of the window — the consecutive rule must trip it');
});
