'use strict';

// 2026-09-28 wedge: prod odds sat ~60 minutes stale for every sport (14:31Z →
// restart at 16:52Z) while TOA itself answered in 0.18s. Three defects fed one loop:
//
//   1. the TOA gate kept a caller whose budget expired while QUEUED, so every
//      dead waiter still cost a slot turn + TOA_MIN_INTERVAL_MS, and a backlog
//      of them outlived the 500ms budget of every live caller behind it;
//   2. the blocking events-list refresh had no single-flight, so each caller
//      of an expired sport fired its own fetch (314 NFL fetches in 52s);
//   3. nothing stopped the blocking path re-attempting a refresh that had
//      just failed, so every failure re-armed the storm.
//
// Plus the line refresh had no in-flight guard: overlapping seeds reset the
// staging index under each other and de-registered live lines from PX.
//
// No real network: global.fetch is stubbed before any call, and the TOA key is
// a dummy. Runs under plain `node --test` (db.js is a no-op there).

process.env.THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const of = require('../services/odds-feed');

const realFetch = global.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fetch stub that resolves after `ms` unless the request is aborted.
function slowFetch(ms, respond) {
  return (url, opts = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(respond(url)), ms);
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('This operation was aborted'); e.name = 'AbortError';
        reject(e);
      }, { once: true });
    }
  });
}
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const fail500 = () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) });

test.afterEach(() => {
  global.fetch = realFetch;
  of.__resetToaGateForTest();
});

// ------------------------------------------------------------------ gate

test('a caller whose budget expires while queued leaves the queue', async () => {
  of.__resetToaGateForTest();
  // Hold every slot with slow fetches (budget 2s, fetch takes 600ms).
  global.fetch = slowFetch(600, () => okJson([]));
  const max = of.getToaGateState().maxConcurrent;
  const holders = [];
  for (let i = 0; i < max; i++) {
    holders.push(of.abortableFetch('https://api.the-odds-api.com/holder' + i, undefined, 2000));
  }
  // Now queue 40 short-budget callers behind them. They must all time out.
  const shorts = [];
  for (let i = 0; i < 40; i++) {
    shorts.push(of.abortableFetch('https://api.the-odds-api.com/short' + i, undefined, 60)
      .then(() => 'ok', (e) => e.name));
  }
  assert.ok(of.getToaGateState().queued >= 40, 'short callers should be queued behind the holders');
  const outcomes = await Promise.all(shorts);
  assert.ok(outcomes.every((o) => o === 'AbortError'), 'every short caller times out in the queue');
  // THE INVARIANT: with the slots still held, the dead waiters are GONE.
  const st = of.getToaGateState();
  assert.strictEqual(st.queued, 0, `dead waiters must leave the queue (still queued: ${st.queued})`);
  assert.ok(st.abandoned >= 40, `abandoned counter should record them (got ${st.abandoned})`);
  assert.strictEqual(st.inFlight, max, 'the holders still own every slot');
  await Promise.all(holders);
});

test('after a backlog of dead waiters, a live caller is served promptly', async () => {
  of.__resetToaGateForTest();
  global.fetch = slowFetch(300, () => okJson([]));
  const max = of.getToaGateState().maxConcurrent;
  const holders = [];
  for (let i = 0; i < max; i++) holders.push(of.abortableFetch('https://api.the-odds-api.com/h' + i, undefined, 2000));
  // 200 dead waiters. Under the old gate each would take a slot turn and a
  // 50ms drain delay when its turn came — ~2.5s of dead time at 4 slots —
  // so the live caller below (400ms budget) could never be reached.
  const dead = [];
  for (let i = 0; i < 200; i++) dead.push(of.abortableFetch('https://api.the-odds-api.com/d' + i, undefined, 20).catch(() => null));
  await Promise.all(dead);
  global.fetch = slowFetch(10, () => okJson(['live']));
  const live = of.abortableFetch('https://api.the-odds-api.com/live', undefined, 1500);
  const resp = await live;
  assert.strictEqual(resp.ok, true, 'the live caller must get a slot once the holders finish');
  await Promise.all(holders);
});

test('the gate never leaks a slot through an abandoned waiter', async () => {
  of.__resetToaGateForTest();
  global.fetch = slowFetch(50, () => okJson([]));
  const calls = [];
  for (let i = 0; i < 30; i++) calls.push(of.abortableFetch('https://api.the-odds-api.com/x' + i, undefined, i % 2 ? 5 : 3000).catch(() => null));
  await Promise.all(calls);
  await sleep(120);
  const st = of.getToaGateState();
  assert.strictEqual(st.inFlight, 0, 'every slot is returned');
  assert.strictEqual(st.queued, 0);
});

test('non-TOA fetches never enter the gate', async () => {
  of.__resetToaGateForTest();
  global.fetch = slowFetch(5, () => okJson([]));
  await of.abortableFetch('https://example.com/other', undefined, 500);
  assert.strictEqual(of.getToaGateState().abandoned, 0);
  assert.strictEqual(of.getToaGateState().maxQueue, 0);
});

// ------------------------------------------------- events list refresh

test('concurrent callers of an EXPIRED events cache share one fetch', async () => {
  of.__resetToaGateForTest();
  let n = 0;
  global.fetch = slowFetch(40, (url) => { if (url.includes('/events?')) n++; return okJson([{ id: 'e1' }]); });
  of.__setToaEventsCacheForTest('americanfootball_nfl', { fetchedAt: 0, events: [{ id: 'old' }], refreshing: false });
  const results = await Promise.all(Array.from({ length: 25 }, () => of._getTheOddsApiEvents('americanfootball_nfl')));
  assert.strictEqual(n, 1, `25 concurrent callers must share ONE fetch (made ${n})`);
  assert.ok(results.every((r) => Array.isArray(r) && r[0].id === 'e1'));
});

test('a failed events refresh is not re-attempted inside the backoff — stale is served', async () => {
  of.__resetToaGateForTest();
  let n = 0;
  global.fetch = slowFetch(5, () => { n++; return fail500(); });
  of.__setToaEventsCacheForTest('baseball_mlb', { fetchedAt: 0, events: [{ id: 'stale' }], refreshing: false });
  const first = await of._getTheOddsApiEvents('baseball_mlb');
  assert.strictEqual(n, 1);
  assert.strictEqual(first[0].id, 'stale', 'failure falls back to the stale cache');
  for (let i = 0; i < 10; i++) {
    const again = await of._getTheOddsApiEvents('baseball_mlb');
    assert.strictEqual(again[0].id, 'stale');
  }
  assert.strictEqual(n, 1, `no re-fetch inside the failure backoff (made ${n})`);
});

test('a successful refresh clears the failure backoff', async () => {
  of.__resetToaGateForTest();
  let n = 0;
  global.fetch = slowFetch(5, () => { n++; return n === 1 ? fail500() : okJson([{ id: 'fresh' }]); });
  of.__setToaEventsCacheForTest('icehockey_nhl', { fetchedAt: 0, events: [{ id: 'stale' }], refreshing: false });
  await of._getTheOddsApiEvents('icehockey_nhl');           // fails → backoff armed
  of.__resetToaGateForTest();                                // clears fail stamps (simulates backoff expiry)
  of.__setToaEventsCacheForTest('icehockey_nhl', { fetchedAt: 0, events: [{ id: 'stale' }], refreshing: false });
  const r = await of._getTheOddsApiEvents('icehockey_nhl');
  assert.strictEqual(r[0].id, 'fresh');
});

// ------------------------------------------------------- prop odds

test('a failed prop refresh is not re-attempted inside the backoff — stale is served', async () => {
  of.__resetToaGateForTest();
  let n = 0;
  global.fetch = slowFetch(5, () => { n++; return fail500(); });
  const key = 'americanfootball_nfl:ev1:player_pass_yds';
  of.__setToaPropOddsCacheForTest(key, { fetchedAt: 0, refreshing: false, bookmakers: ['stale'] });
  const a = await of._getTheOddsApiPropOdds('americanfootball_nfl', 'ev1', 'player_pass_yds');
  assert.deepStrictEqual(a.bookmakers, ['stale']);
  const burst = await Promise.all(Array.from({ length: 15 }, () => of._getTheOddsApiPropOdds('americanfootball_nfl', 'ev1', 'player_pass_yds')));
  assert.ok(burst.every((b) => b.bookmakers[0] === 'stale'));
  assert.strictEqual(n, 1, `one failed fetch, then stale serves only (made ${n})`);
});

// ------------------------------------------------ line refresh overlap

const LM_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8').replace(/\r\n/g, '\n');

test('refreshLines joins a seed already in flight instead of resetting the staging index', () => {
  const i = LM_SRC.indexOf('async function refreshLines(');
  assert.notStrictEqual(i, -1);
  const body = LM_SRC.slice(i, i + 3000);
  const joinAt = body.indexOf('return cur.promise;');
  const resetAt = body.indexOf('_seedIndexTarget = {};');
  assert.ok(joinAt !== -1, 'an in-flight refresh must be joined');
  assert.ok(resetAt !== -1 && joinAt < resetAt,
    'the join must happen BEFORE the staging index is reset — resetting it under a running seed is the bug');
  // ...and it must be the path a young in-flight seed takes (only a seed past
  // LINE_SEED_MAX_RUN_MS may be abandoned instead of joined).
  assert.ok(/if \(cur\) \{\s*const ageMs = Date\.now\(\) - cur\.startedAt;\s*if \(ageMs < LINE_SEED_MAX_RUN_MS\) \{\s*log\.info\([^\n]*\n\s*return cur\.promise;/.test(body),
    'an in-flight seed younger than LINE_SEED_MAX_RUN_MS must be joined');
  const m = LM_SRC.match(/LINE_SEED_MAX_RUN_MINUTES\);\s*return \(Number\.isFinite\(v\) && v > 0 \? v : (\d+)\) \* 60000;/);
  assert.ok(m && Number(m[1]) >= 15, 'the abandon threshold must sit well above a normal seed (5-25 min under load)');
});

test('an abandoned seed generation cannot swap or sync', () => {
  const i = LM_SRC.indexOf('async function seedAllLines(gen)');
  assert.notStrictEqual(i, -1, 'seedAllLines must take the generation');
  const guard = LM_SRC.indexOf('if (gen != null && gen !== _seedGen)', i);
  const swap = LM_SRC.indexOf('if (_seedIndexTarget && _seedPrimaryTarget) {', i);
  assert.ok(guard !== -1 && swap !== -1 && guard < swap, 'the generation check must precede the swap');
  const lm = require('../services/line-manager');
  const st = lm.getSeedRunState();
  assert.strictEqual(st.inFlight, false);
  assert.ok(st.maxRunMin > 0);
});
