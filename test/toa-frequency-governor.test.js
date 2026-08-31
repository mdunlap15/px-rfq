'use strict';

// Regression cover for the 2026-08-31 TOA frequency outage.
//
// What happened: The Odds API rate-limits by request FREQUENCY, separately
// from quota. We sat on 22.5M remaining requests while 26 of 28 sport caches
// went 4.5-9h stale and fills stopped for hours. Two defects combined:
//
//   1. A 429 triggered an immediate 3s retry — the opposite of the correct
//      response to a frequency limit, and ~28 sports x 3s pushed the cycle to
//      167s against a 120s timer.
//   2. refreshAllSports had no single-flight guard, so the timer started a
//      SECOND concurrent sweep on top of the slow one, doubling request rate
//      and causing more 429s. Self-reinforcing.
//
// These tests pin the governor and the guard. They exercise the REAL exported
// functions rather than re-implementing the logic, so a behavioural change in
// odds-feed.js fails here instead of passing a copy of itself.

const test = require('node:test');
const assert = require('node:assert');

const of = require('../services/odds-feed');

test.beforeEach(() => of._resetToaFreqForTest());

// ------------------------------------------------------------- the governor

test('a 429 opens a cooldown instead of retrying immediately', () => {
  assert.strictEqual(of._toaCooldownRemainingMs(), 0, 'starts clear');
  const backoff = of._noteToa429(null);
  assert.ok(backoff >= 5000, `first backoff should be >=5s, got ${backoff}`);
  assert.ok(of._toaCooldownRemainingMs() > 0, 'cooldown must be open after a 429');
  assert.strictEqual(of.getToaFreqState().consecutive429, 1);
});

test('backoff grows exponentially across consecutive 429s', () => {
  const b1 = of._noteToa429(null);
  const b2 = of._noteToa429(null);
  const b3 = of._noteToa429(null);
  assert.ok(b2 > b1, `b2 (${b2}) must exceed b1 (${b1})`);
  assert.ok(b3 > b2, `b3 (${b3}) must exceed b2 (${b2})`);
});

test('backoff is CAPPED so a bad streak cannot self-inflict a long outage', () => {
  let last = 0;
  for (let i = 0; i < 25; i++) last = of._noteToa429(null);
  assert.ok(last <= 120000, `capped at 120s, got ${last}`);
  assert.ok(of._toaCooldownRemainingMs() <= 120000 + 50, 'remaining is capped too');
});

test('Retry-After is honoured when the server sends one', () => {
  const backoff = of._noteToa429('7');
  assert.strictEqual(backoff, 7000, 'should use the 7s the server asked for');
  assert.strictEqual(of.getToaFreqState().lastRetryAfterSec, 7);
});

test('a garbage Retry-After falls back to exponential, never to zero', () => {
  for (const bad of ['', 'soon', '-5', '0', null, undefined]) {
    of._resetToaFreqForTest();
    const backoff = of._noteToa429(bad);
    assert.ok(backoff >= 5000, `Retry-After ${JSON.stringify(bad)} -> ${backoff}, must not collapse the cooldown`);
  }
});

test('a success clears the cooldown so one blip cannot wedge the feed', () => {
  of._noteToa429(null);
  of._noteToa429(null);
  assert.ok(of._toaCooldownRemainingMs() > 0);
  of._noteToaSuccess();
  assert.strictEqual(of._toaCooldownRemainingMs(), 0, 'cooldown cleared');
  assert.strictEqual(of.getToaFreqState().consecutive429, 0, 'streak reset');
});

test('cooldown never goes backwards while still open', () => {
  of._noteToa429('60');
  const afterLong = of._toaCooldownRemainingMs();
  of._noteToa429('1'); // a short Retry-After must not shorten an open cooldown
  assert.ok(of._toaCooldownRemainingMs() >= afterLong - 50,
    'a later short backoff must not cut an already-open longer cooldown');
});

// --------------------------------------------------------- observability

test('governor state is reportable — the outage was invisible for hours', () => {
  of._noteToa429('3');
  const st = of.getToaFreqState();
  for (const k of ['cooldownMsRemaining', 'consecutive429', 'total429', 'skippedInCooldown', 'lastAt']) {
    assert.ok(k in st, `getToaFreqState must report ${k}`);
  }
  assert.strictEqual(st.total429, 1);
  assert.ok(st.lastAt, 'lastAt must be set so staleness is datable');
});

test('refresh stats expose coalescing — proof the guard is doing work', () => {
  const st = of.getRefreshStats();
  for (const k of ['runs', 'coalesced', 'lastMs', 'inFlight']) {
    assert.ok(k in st, `getRefreshStats must report ${k}`);
  }
});

test('getStaleSports returns a sorted list and is safe on a cold cache', () => {
  const stale = of.getStaleSports();
  assert.ok(Array.isArray(stale), 'must always be an array');
  for (let i = 1; i < stale.length; i++) {
    assert.ok(stale[i - 1].ageMinutes >= stale[i].ageMinutes, 'sorted oldest-first');
  }
});

// ------------------------------------------------------- single-flight guard

// These drive the extracted guard with a FAKE sweep. Calling the real
// refreshAllSports here fired ~370 live Odds API requests from the test
// suite — adding frequency load in the exact scenario the guard prevents.

test('concurrent calls COALESCE into exactly one sweep', async () => {
  of._resetRefreshStatsForTest();
  let sweeps = 0;
  const slow = () => { sweeps++; return new Promise((r) => setTimeout(r, 30)); };

  const calls = [of._singleFlight(slow), of._singleFlight(slow), of._singleFlight(slow)];
  // The LATCH is taken synchronously — that is what makes coalescing work even
  // though the sweep body itself is deferred one microtask (deliberate: it
  // routes a synchronous throw through .finally so the latch always releases).
  assert.strictEqual(of.getRefreshStats().inFlight, true, 'latch must be taken synchronously');
  assert.strictEqual(of.getRefreshStats().coalesced, 2, 'callers 2 and 3 must coalesce immediately');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sweeps, 1, 'only ONE sweep may start — two on a frequency-limited key is the outage');

  await Promise.allSettled(calls);
  const after = of.getRefreshStats();
  assert.strictEqual(sweeps, 1, 'still exactly one sweep after settling');
  assert.strictEqual(after.runs, 1, 'one completed run');
  assert.strictEqual(after.coalesced, 2, 'the two piggybacked callers are counted');
  assert.strictEqual(after.inFlight, false, 'latch released');
});

test('all coalesced callers observe the same sweep result', async () => {
  of._resetRefreshStatsForTest();
  const fn = () => new Promise((r) => setTimeout(() => r('swept'), 10));
  const [a, b] = await Promise.all([of._singleFlight(fn), of._singleFlight(fn)]);
  assert.strictEqual(a, 'swept');
  assert.strictEqual(b, 'swept', 'a piggybacked caller must get the real result, not undefined');
});

test('the latch RELEASES when the sweep rejects', async () => {
  // A guard that leaks on error is worse than no guard: the feed would never
  // refresh again until restart.
  of._resetRefreshStatsForTest();
  await Promise.allSettled([of._singleFlight(() => Promise.reject(new Error('boom')))]);
  assert.strictEqual(of.getRefreshStats().inFlight, false, 'must not stay latched after a rejection');

  let ran = 0;
  await of._singleFlight(() => { ran++; return Promise.resolve(); });
  assert.strictEqual(ran, 1, 'a later call must start a NEW sweep');
});

test('the latch RELEASES when the sweep throws synchronously', async () => {
  of._resetRefreshStatsForTest();
  await Promise.allSettled([of._singleFlight(() => { throw new Error('sync boom'); })]);
  assert.strictEqual(of.getRefreshStats().inFlight, false, 'a sync throw must not wedge the latch');

  let ran = 0;
  await of._singleFlight(() => { ran++; return Promise.resolve(); });
  assert.strictEqual(ran, 1, 'feed must recover after a synchronous failure');
});

test('sequential calls do NOT coalesce — the guard must not suppress real refreshes', async () => {
  of._resetRefreshStatsForTest();
  let sweeps = 0;
  const fn = () => { sweeps++; return Promise.resolve(); };
  await of._singleFlight(fn);
  await of._singleFlight(fn);
  assert.strictEqual(sweeps, 2, 'back-to-back sweeps must both run');
  assert.strictEqual(of.getRefreshStats().coalesced, 0, 'nothing was concurrent, so nothing coalesced');
});

// ------------------------------------------------- cooldown WAIT vs SKIP

// The first cut of this fix made the sweep SKIP every sport while a cooldown
// was open. On a restart that left 22 of 27 sports with no data at all — the
// governor reduced coverage instead of reducing request rate. The sweep must
// WAIT out a cooldown, not step over it.

test('_awaitToaCooldown returns immediately when nothing is cooling', async () => {
  of._resetToaFreqForTest();
  const t0 = Date.now();
  const waited = await of._awaitToaCooldown(60000);
  assert.strictEqual(waited, 0, 'no cooldown -> no wait');
  assert.ok(Date.now() - t0 < 50, 'must not sleep when clear');
});

test('_awaitToaCooldown actually waits out an open cooldown', async () => {
  of._resetToaFreqForTest();
  of._noteToa429('0.1'); // 100ms cooldown
  const t0 = Date.now();
  const waited = await of._awaitToaCooldown(60000);
  const elapsed = Date.now() - t0;
  assert.ok(waited > 0, 'must report a real wait');
  assert.ok(elapsed >= 80, `must actually sleep (~100ms), slept ${elapsed}ms`);
  assert.strictEqual(of._toaCooldownRemainingMs(), 0, 'cooldown elapsed');
});

test('_awaitToaCooldown honours the caller budget and never overruns it', async () => {
  of._resetToaFreqForTest();
  of._noteToa429('60'); // 60s cooldown
  const t0 = Date.now();
  const waited = await of._awaitToaCooldown(120); // caller only allows 120ms
  const elapsed = Date.now() - t0;
  assert.ok(waited <= 120, `must not wait beyond the budget, waited ${waited}`);
  assert.ok(elapsed < 1000, `must return promptly, took ${elapsed}ms`);
  assert.ok(of._toaCooldownRemainingMs() > 0, 'cooldown still open — caller falls back to fail-fast');
});

test('_awaitToaCooldown with a spent budget does not sleep', async () => {
  of._resetToaFreqForTest();
  of._noteToa429('60');
  const t0 = Date.now();
  const waited = await of._awaitToaCooldown(0);
  assert.strictEqual(waited, 0, 'zero budget -> zero wait');
  assert.ok(Date.now() - t0 < 50, 'must not sleep on a spent budget');
  assert.strictEqual(await of._awaitToaCooldown(-5), 0, 'negative budget is treated as spent');
});
