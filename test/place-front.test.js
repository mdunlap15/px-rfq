// Placement front (place-front.js) + shared manual-offers module + supervisor.
// No network: px-single is stubbed, the "main app" is a local stub server.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { createManualOffers, makeAdminAuth } = require('../services/manual-offers');
const { createFront } = require('../place-front');
const { createSupervisor } = require('../services/place-front-supervisor');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const LADDER = [-200, -150, -110, -105, 100, 105, 110, 150, 200];

function stubPxs(over = {}) {
  const calls = { place: [], cancelWager: [], cancelMarket: [], cancelEvent: [], balance: 0, ladder: 0 };
  const pxs = {
    calls,
    fetchOddsLadder: async () => { calls.ladder++; return LADDER; },
    fetchBalance: async () => { calls.balance++; return { balance: 1000, unmatched_wager_balance: 100, unmatched_wager_balance_status: 'succeed' }; },
    placeMultipleWagers: async (batch) => { calls.place.push(batch); return { succeed_wagers: batch.map(o => ({ external_id: o.external_id, wager_id: 'w_' + o.external_id })), failed_wagers: [] }; },
    cancelWager: async (id) => { calls.cancelWager.push(id); return {}; },
    cancelWagersByMarket: async (e, m) => { calls.cancelMarket.push([e, m]); return {}; },
    cancelWagersByEvent: async (e) => { calls.cancelEvent.push(e); return {}; },
    _tokenCache: () => ({ token: '<set>', time: Date.now() }),
    ...over,
  };
  return pxs;
}

function offers(n, stake = 1) {
  return Array.from({ length: n }, (_, i) => ({ line_id: 'L' + i, odds: 110, stake, external_id: 'claude_t_' + i }));
}

function listen(server) {
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data != null) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', c => (s += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, text: s, json: j }); });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

function basic(u, p) { return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'); }

async function startStubMain() {
  const seen = [];
  const srv = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => (b += c));
    rq.on('end', () => {
      seen.push({ method: rq.method, url: rq.url, body: b, auth: rq.headers.authorization || null });
      rs.setHeader('x-main', 'yes');
      if (rq.url === '/teapot') { rs.statusCode = 418; return rs.end('short and stout'); }
      rs.setHeader('content-type', 'application/json');
      rs.end(JSON.stringify({ main: true, url: rq.url, method: rq.method, body: b }));
    });
  });
  const port = await listen(srv);
  return { srv, port, seen };
}

async function startFront({ mainPort, env = {}, pxs }) {
  const manual = createManualOffers({ log: quiet, loadPxs: () => pxs, env: { MANUAL_PACE_MS: '20', ...env } });
  const auth = makeAdminAuth({ ...env }, null);
  const front = createFront({ manual, auth, mainPort, log: quiet });
  const port = await listen(front.server);
  return { front, port, manual };
}

function closeAll(...servers) {
  return Promise.all(servers.map(s => new Promise(r => { try { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); } catch (_) { r(); } })));
}

test('front: place (live + dry) and cancel are served by the shared module with px-single stubbed', async () => {
  const main = await startStubMain();
  const pxs = stubPxs();
  const { front, port } = await startFront({ mainPort: main.port, pxs });
  try {
    const dry = await req(port, 'POST', '/admin/offers/place', { offers: offers(3), dryRun: true });
    assert.strictEqual(dry.status, 200);
    assert.deepStrictEqual(dry.json, { ok: true, dryRun: true, offers: 3, totalStake: 3, balance: { cash: 1000, unmatched: 100, headroom: 49900 } });
    assert.strictEqual(pxs.calls.place.length, 0, 'dry run places nothing');

    const live = await req(port, 'POST', '/admin/offers/place', { offers: offers(25) });
    assert.strictEqual(live.status, 200);
    assert.strictEqual(live.json.ok, true);
    assert.strictEqual(live.json.placed, 25);
    assert.strictEqual(live.json.failed, 0);
    assert.strictEqual(live.json.succeed_wagers.length, 25);
    assert.deepStrictEqual(live.json.failed_wagers, []);
    assert.deepStrictEqual(pxs.calls.place.map(b => b.length), [20, 5], 'batched by 20');

    const bad = await req(port, 'POST', '/admin/offers/place', { offers: [] });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(bad.json, { ok: false, error: 'body.offers must be a non-empty array' });

    const off = await req(port, 'POST', '/admin/offers/place', { offers: [{ line_id: 'x', odds: 111, stake: 5, external_id: 'e1' }] });
    assert.strictEqual(off.status, 400);
    assert.deepStrictEqual(off.json, { ok: false, error: 'off-ladder odds', details: [{ external_id: 'e1', odds: 111 }] });

    const big = await req(port, 'POST', '/admin/offers/place', { offers: [{ line_id: 'x', odds: 110, stake: 25000, external_id: 'e1' }, { line_id: 'y', odds: 110, stake: 25000, external_id: 'e2' }] });
    assert.strictEqual(big.status, 409);
    assert.strictEqual(big.json.error, 'total stake 50000 exceeds headroom 49900');

    const c1 = await req(port, 'POST', '/admin/offers/cancel', { wager_ids: ['a', 'b'] });
    assert.deepStrictEqual(c1.json, { ok: true, wagers: [{ wager_id: 'a', ok: true }, { wager_id: 'b', ok: true }] });
    const c2 = await req(port, 'POST', '/admin/offers/cancel', { markets: [{ event_id: 1, market_id: 2 }] });
    assert.deepStrictEqual(c2.json, { ok: true, markets: [{ event_id: 1, market_id: 2, ok: true }] });
    const c3 = await req(port, 'POST', '/admin/offers/cancel', { event_id: 77 });
    assert.deepStrictEqual(c3.json, { ok: true, event_id: 77, cancelled_event: true });
    const c4 = await req(port, 'POST', '/admin/offers/cancel', {});
    assert.strictEqual(c4.status, 400);
    assert.deepStrictEqual(pxs.calls.cancelWager, ['a', 'b']);
    assert.deepStrictEqual(pxs.calls.cancelEvent, [77]);
    assert.strictEqual(main.seen.length, 0, 'placement/cancel never reach the main app');

    const st = await req(port, 'GET', '/admin/offers/front-stats');
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.json.front, true);
    assert.ok(st.json.placement.all.n >= 5);
    assert.ok(Number.isFinite(st.json.placement.all.p50_ms));
  } finally { await closeAll(front.server, main.srv); front.agent.destroy(); }
});

test('front: every other path is proxied to main (method, body, status, headers)', async () => {
  const main = await startStubMain();
  const { front, port } = await startFront({ mainPort: main.port, pxs: stubPxs() });
  try {
    const h = await req(port, 'GET', '/health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.json.main, true);
    assert.strictEqual(h.headers['x-main'], 'yes');
    const p = await req(port, 'POST', '/admin/pause?x=1', { a: 1 });
    assert.deepStrictEqual(p.json, { main: true, url: '/admin/pause?x=1', method: 'POST', body: '{"a":1}' });
    const g = await req(port, 'GET', '/admin/offers/place');    // GET is not a placement route
    assert.strictEqual(g.json.main, true);
    const t = await req(port, 'GET', '/teapot');
    assert.strictEqual(t.status, 418);
    assert.strictEqual(t.text, 'short and stout');
  } finally { await closeAll(front.server, main.srv); front.agent.destroy(); }
});

test('front: 503 for proxied paths while main is down, placement still works', async () => {
  const tmp = http.createServer(); const deadPort = await listen(tmp); await closeAll(tmp);
  const pxs = stubPxs();
  const { front, port } = await startFront({ mainPort: deadPort, pxs });
  try {
    const h = await req(port, 'GET', '/health');
    assert.strictEqual(h.status, 503);
    assert.strictEqual(h.json.ok, false);
    const pl = await req(port, 'POST', '/admin/offers/place', { offers: offers(2) });
    assert.strictEqual(pl.status, 200);
    assert.strictEqual(pl.json.placed, 2);
  } finally { await closeAll(front.server); front.agent.destroy(); }
});

test('front: Basic auth is required on /admin/offers/* (same roles as index.js)', async () => {
  const main = await startStubMain();
  const env = { AUTH_USERNAME: 'mike', AUTH_PASSWORD: 'pw', AUTH_FULL_VIEWERS: 'carl:cpw', AUTH_VIEWERS: 'bob:bpw' };
  const pxs = stubPxs();
  const { front, port } = await startFront({ mainPort: main.port, pxs, env });
  try {
    const none = await req(port, 'POST', '/admin/offers/place', { offers: offers(1), dryRun: true });
    assert.strictEqual(none.status, 401);
    assert.strictEqual(none.text, 'Authentication required');
    assert.match(none.headers['www-authenticate'], /Basic realm="ProphetX SP"/);
    const wrong = await req(port, 'POST', '/admin/offers/place', { offers: offers(1), dryRun: true }, { authorization: basic('mike', 'nope') });
    assert.strictEqual(wrong.status, 401);
    const viewer = await req(port, 'POST', '/admin/offers/cancel', { event_id: 1 }, { authorization: basic('bob', 'bpw') });
    assert.strictEqual(viewer.status, 403);
    const fv = await req(port, 'POST', '/admin/offers/place', { offers: offers(1), dryRun: true }, { authorization: basic('carl', 'cpw') });
    assert.strictEqual(fv.status, 403);
    assert.strictEqual(fv.text, 'Forbidden — read-only account');
    const fvStats = await req(port, 'GET', '/admin/offers/front-stats', null, { authorization: basic('carl', 'cpw') });
    assert.strictEqual(fvStats.status, 200);
    const noStats = await req(port, 'GET', '/admin/offers/front-stats');
    assert.strictEqual(noStats.status, 401);
    const admin = await req(port, 'POST', '/admin/offers/place', { offers: offers(1), dryRun: true }, { authorization: basic('mike', 'pw') });
    assert.strictEqual(admin.status, 200);
    assert.strictEqual(pxs.calls.cancelEvent.length, 0, 'refused requests never reach px-single');
    // proxied paths are NOT authenticated by the front: the main app decides
    const prox = await req(port, 'GET', '/status');
    assert.strictEqual(prox.json.main, true);
  } finally { await closeAll(front.server, main.srv); front.agent.destroy(); }
});

test('pacing: first batch not delayed when idle; later batches paced; next request waits only the remainder', async () => {
  let clock = 1_000_000;
  const waits = [];
  const fakeSleep = async (ms) => { waits.push(ms); clock += ms; };
  const pxs = stubPxs({ placeMultipleWagers: async (b) => { clock += 50; return { succeed_wagers: b, failed_wagers: [] }; } });
  const m = createManualOffers({ log: quiet, loadPxs: () => pxs, env: { MANUAL_PACE_MS: '700' }, now: () => clock, sleep: fakeSleep });
  const res = () => { const r = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; return r; };

  const r1 = res();
  await m.place({ body: { offers: offers(45) } }, r1);
  assert.strictEqual(r1.body.placed, 45);
  assert.deepStrictEqual(waits, [700, 700], 'idle: batch 1 immediate, batches 2 and 3 each sleep 700 ms');

  // 100 ms later a second request: its first batch waits only the remaining 600 ms
  waits.length = 0; clock += 100;
  const r2 = res();
  await m.place({ body: { offers: offers(5) } }, r2);
  assert.deepStrictEqual(waits, [600]);

  // long idle: no wait at all
  waits.length = 0; clock += 10_000;
  await m.place({ body: { offers: offers(5) } }, res());
  assert.deepStrictEqual(waits, []);

  // cancels share the same pacer: idle first cancel immediate, second paced
  waits.length = 0; clock += 10_000;
  const rc = res();
  await m.cancel({ body: { wager_ids: ['a', 'b'] } }, rc);
  assert.deepStrictEqual(waits, [700]);

  // dry runs never touch the pacer
  waits.length = 0;
  await m.place({ body: { offers: offers(3), dryRun: true } }, res());
  assert.deepStrictEqual(waits, []);
});

test('pacing: two concurrent idle requests are spaced, not fired together', async () => {
  const starts = [];
  const pxs = stubPxs({ placeMultipleWagers: async (b) => { starts.push(Date.now()); return { succeed_wagers: b, failed_wagers: [] }; } });
  const m = createManualOffers({ log: quiet, loadPxs: () => pxs, env: { MANUAL_PACE_MS: '150' } });
  const res = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  await Promise.all([m.place({ body: { offers: offers(2) } }, res()), m.place({ body: { offers: offers(2) } }, res())]);
  assert.strictEqual(starts.length, 2);
  assert.ok(Math.abs(starts[1] - starts[0]) >= 140, `spaced by the pace (got ${starts[1] - starts[0]} ms)`);
});

test('ladder + balance: concurrent only with a fresh token; error priority unchanged', async () => {
  let order = [];
  const slow = (tag, v, ms) => async () => { order.push(tag + ':start'); await new Promise(r => setTimeout(r, ms)); order.push(tag + ':end'); return v; };
  const bal = { balance: 1000, unmatched_wager_balance: 0, unmatched_wager_balance_status: 'succeed' };
  const res = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

  // fresh token -> overlapped
  let pxs = stubPxs({ fetchOddsLadder: slow('L', LADDER, 40), fetchBalance: slow('B', bal, 40) });
  let m = createManualOffers({ log: quiet, loadPxs: () => pxs });
  await m.place({ body: { offers: offers(1), dryRun: true } }, res());
  assert.deepStrictEqual(order.slice(0, 2), ['L:start', 'B:start']);

  // no token -> serial (ladder first, it does the login)
  order = [];
  pxs = stubPxs({ fetchOddsLadder: slow('L', LADDER, 20), fetchBalance: slow('B', bal, 20), _tokenCache: () => ({ token: null, time: 0 }) });
  m = createManualOffers({ log: quiet, loadPxs: () => pxs });
  await m.place({ body: { offers: offers(1), dryRun: true } }, res());
  assert.deepStrictEqual(order, ['L:start', 'L:end', 'B:start', 'B:end']);

  // both fail: the ladder error is reported (as the serial code did)
  pxs = stubPxs({ fetchOddsLadder: async () => { throw new Error('ladder boom'); }, fetchBalance: async () => { throw new Error('balance boom'); } });
  m = createManualOffers({ log: quiet, loadPxs: () => pxs });
  let r = res(); await m.place({ body: { offers: offers(1) } }, r);
  assert.strictEqual(r.statusCode, 500); assert.strictEqual(r.body.error, 'ladder boom');

  // off-ladder beats a balance failure (400, not 500)
  pxs = stubPxs({ fetchBalance: async () => { throw new Error('balance boom'); } });
  m = createManualOffers({ log: quiet, loadPxs: () => pxs });
  r = res(); await m.place({ body: { offers: [{ line_id: 'x', odds: 111, stake: 1, external_id: 'e' }] } }, r);
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(r.body.error, 'off-ladder odds');

  // balance fails alone -> 500 with its message
  r = res(); await m.place({ body: { offers: offers(1) } }, r);
  assert.strictEqual(r.statusCode, 500); assert.strictEqual(r.body.error, 'balance boom');
});

function fakeFork() {
  const kids = [];
  const fork = () => { const c = new EventEmitter(); c.pid = 1000 + kids.length; c.kill = () => { c.killed = true; }; kids.push(c); return c; };
  return { fork, kids };
}

test('supervisor: a crashed front is restarted; 3 crashes in 60 s -> fallback, no more restarts', async () => {
  let t = 0; const ff = fakeFork(); let fallbacks = 0;
  const sup = createSupervisor({ log: quiet, fork: ff.fork, now: () => t, port: 3001, mainPort: 8099, restartMs: 0, onFallback: () => fallbacks++ });
  sup.start();
  assert.strictEqual(ff.kids.length, 1);
  ff.kids[0].emit('exit', 1, null); t += 1000;
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(ff.kids.length, 2, 'restarted');
  assert.strictEqual(sup.mode(), 'front');
  ff.kids[1].emit('exit', 1, null); t += 1000;
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(ff.kids.length, 3);
  ff.kids[2].emit('exit', null, 'SIGKILL');
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(sup.mode(), 'fallback');
  assert.strictEqual(sup.active(), false);
  assert.strictEqual(fallbacks, 1);
  assert.strictEqual(ff.kids.length, 3, 'never restarted after fallback');
});

test('supervisor: crashes spread beyond the window never fall back; shutdown stops restarts', async () => {
  let t = 0; const ff = fakeFork(); let fallbacks = 0;
  const sup = createSupervisor({ log: quiet, fork: ff.fork, now: () => t, port: 3001, mainPort: 8099, restartMs: 0, onFallback: () => fallbacks++ });
  sup.start();
  for (let i = 0; i < 5; i++) { ff.kids[ff.kids.length - 1].emit('exit', 1, null); t += 40_000; await new Promise(r => setTimeout(r, 5)); }
  assert.strictEqual(fallbacks, 0);
  assert.strictEqual(sup.mode(), 'front');
  const n = ff.kids.length;
  sup.markStopping();
  ff.kids[n - 1].emit('exit', 0, 'SIGTERM');
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(ff.kids.length, n, 'no restart while shutting down');
  assert.strictEqual(fallbacks, 0);
});

test('supervisor: real child process that dies at once -> fallback after 3 exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  const script = path.join(dir, 'die.js');
  fs.writeFileSync(script, 'process.exit(3);\n');
  let fellBack = null;
  const done = new Promise(r => { fellBack = r; });
  const sup = createSupervisor({ log: quiet, script, port: 3001, mainPort: 8099, restartMs: 10, onFallback: () => fellBack(true) });
  sup.start();
  let timer = null;
  const ok = await Promise.race([done, new Promise(r => { timer = setTimeout(() => r(false), 15000); })]);
  clearTimeout(timer);
  assert.strictEqual(ok, true, 'fallback fired');
  assert.strictEqual(sup.state().starts, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
