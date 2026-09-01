'use strict';

// Cover for the 2026-09-01 refresh collapse.
//
// odds-feed already had a GLOBAL TOA RATE GATE (_toaAcquire: TOA_MAX_CONCURRENT
// in-flight, TOA_MIN_INTERVAL_MS apart) whose own comment states the invariant:
// "All requests to the-odds-api.com go through this gate so no single code path
// can cause a 429 storm by itself."
//
// The invariant was false. 19 call sites used raw fetch() against 10 using
// abortableFetch, and the three heaviest were all raw: the main sport sweep and
// both per-event burst loops (3 concurrent workers, ~260 calls for one NFL
// slate). Raw fetch() means unlimited concurrency, no pacing, and — because
// node-fetch has no default timeout — no ceiling on how long one call can hang.
//
// Consequences measured that night: 1,040 429s in a session, 2,788 requests
// skipped while cooling, a single sweep taking 287s, and 1 of 22 sports
// quotable. A restart restored 22/22 with 429s back to single digits.
//
// Two defences are pinned here:
//   1. the hot paths go through the gate (and therefore get a timeout)
//   2. a sweep cannot run unbounded — single-flight makes later sweeps coalesce
//      into a slow one, so an unbounded sweep turns one hung fetch into a total
//      refresh outage rather than a single slow cycle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'odds-feed.js'), 'utf8');
const of = require('../services/odds-feed');

// ------------------------------------------------- gate coverage (static)

// These are structural assertions on the source. That is deliberate: the
// failure was a call site quietly NOT using the shared helper, which no
// behavioural test of the helper itself would ever catch.

function bodyOf(fnName) {
  const i = SRC.indexOf(`async function ${fnName}(`);
  assert.notStrictEqual(i, -1, `${fnName} not found — update this test`);
  return SRC.slice(i, i + 9000);
}

test('the main sport sweep fetches through the gate, not raw fetch()', () => {
  const body = bodyOf('fetchFromTheOddsApi');
  assert.ok(/abortableFetch\(url, undefined, TOA_BULK_TIMEOUT_MS\)/.test(body),
    'fetchFromTheOddsApi must use abortableFetch — raw fetch() bypasses pacing AND timeout');
  assert.ok(!/\n  let resp = await fetch\(url\);/.test(body),
    'no raw fetch(url) may remain on the sweep path');
});

test('both per-event burst loops fetch through the gate', () => {
  const hits = SRC.match(/abortableFetch\(url, undefined, TOA_EVENT_TIMEOUT_MS\)/g) || [];
  assert.strictEqual(hits.length, 2,
    `both burst loops (MLB F5 + H1) must be gated, found ${hits.length}`);
  // and neither may still be raw inside the guarded try
  const raw = SRC.match(/_toaCooldownRemainingMs\(\) > 0 \) \{ apiFails\+\+; break; \}\s*\n\s*const resp = await fetch\(/g);
  assert.strictEqual(raw, null, 'a burst loop is still using raw fetch()');
});

test('the bulk timeout is far looser than the 500ms on-demand default', () => {
  // Routing the sweep through abortableFetch with the 500ms default would
  // convert rate-limiting into mass aborts: measured TOA latency is 67-352ms
  // idle and worse under load.
  const m = SRC.match(/TOA_BULK_TIMEOUT_MS\s*=\s*parseInt\([^)]*\)\s*\|\|\s*(\d+)/);
  assert.ok(m, 'TOA_BULK_TIMEOUT_MS must be defined');
  assert.ok(Number(m[1]) >= 5000, `bulk timeout ${m[1]}ms is too tight for the sweep`);
  const e = SRC.match(/TOA_EVENT_TIMEOUT_MS\s*=\s*parseInt\([^)]*\)\s*\|\|\s*(\d+)/);
  assert.ok(e && Number(e[1]) >= 3000, 'per-event timeout too tight');
  // ...but both must still be FINITE. An unbounded fetch is the original bug.
  assert.ok(Number(m[1]) > 0 && Number(e[1]) > 0, 'timeouts must be finite and non-zero');
});

test('the gate itself still caps concurrency and paces requests', () => {
  const c = SRC.match(/_TOA_MAX_CONCURRENT\s*=\s*parseInt\([^)]*\)\s*\|\|\s*(\d+)/);
  const i = SRC.match(/_TOA_MIN_INTERVAL_MS\s*=\s*parseInt\([^)]*\)\s*\|\|\s*(\d+)/);
  assert.ok(c && Number(c[1]) > 0, 'concurrency cap must exist');
  assert.ok(i && Number(i[1]) > 0, 'min interval must exist');
});

// ------------------------------------------------------- sweep deadline

test('a sweep deadline exists and is under the staleness horizon', () => {
  const m = SRC.match(/SWEEP_DEADLINE_MS\s*=\s*Number\([^)]*\|\|\s*(\d+)\)\s*\*\s*60000/);
  assert.ok(m, 'SWEEP_DEADLINE_MS must be defined');
  const mins = Number(m[1]);
  assert.ok(mins > 0, 'deadline must be positive');
  assert.ok(mins <= 10,
    `a ${mins}min deadline is useless — sports expire faster than the sweep revisits them`);
});

test('the deadline stops STARTING sports rather than aborting mid-flight', () => {
  // Aborting a sport mid-write could leave a half-populated cache. The loop
  // must `continue` past unstarted sports and finish cleanly so the
  // single-flight latch always releases.
  assert.ok(/Date\.now\(\) > sweepDeadlineAt.*continue;/s.test(SRC),
    'deadline must skip remaining sports via continue, not throw');
});

test('deadline skips are reported, never silent', () => {
  // A cap that silently truncates coverage reads as "everything refreshed".
  assert.ok(/lastDeadlineSkipped/.test(SRC), 'skipped count must be exposed on refresh stats');
  assert.ok(/hit its .*deadline/.test(SRC), 'must log when the deadline bites');
  const st = of.getRefreshStats();
  assert.ok(st && typeof st === 'object', 'getRefreshStats must still work');
});

// --------------------------------------------- guard the earlier fixes

test('the frequency governor and single-flight guard are still wired', () => {
  // The deadline only prevents an outage BECAUSE single-flight makes later
  // sweeps coalesce. If that guard ever goes, revisit the deadline too.
  assert.strictEqual(typeof of._singleFlight, 'function');
  assert.strictEqual(typeof of._toaCooldownRemainingMs, 'function');
  assert.ok(/if \(_refreshAllInFlight\)/.test(SRC), 'single-flight guard must remain');
});

// ---------------------------------------------- review fixes (2026-09-01)

test('the gate timer starts BEFORE the queue wait, so queue+fetch is bounded', () => {
  // Originally _toaAcquire() was awaited BEFORE the abort timer was created,
  // so timeoutMs bounded only the network call and the QUEUE WAIT was
  // unbounded. Harmless while only background callers used the gate — but the
  // sweep and per-event bursts now share it, so a 500ms RFQ-hot-path caller
  // (alt lines, event resolve, prop odds) could block behind up to
  // TOA_MAX_CONCURRENT bulk fetches at TOA_BULK_TIMEOUT_MS each.
  const i = SRC.indexOf('async function abortableFetch(');
  const body = SRC.slice(i, i + 2600);
  const timerAt = body.indexOf('setTimeout(() => controller.abort()');
  // NOTE: the `t <= 0` fast path legitimately acquires with no timer (the
  // caller asked for no timeout), so scope this to the TIMED path — the
  // acquire that follows the controller.
  const acquireAt = body.indexOf('await _toaAcquire(); held = true;', timerAt);
  assert.ok(timerAt > -1 && acquireAt > -1, 'the timed path must arm a timer and then acquire');
  assert.ok(timerAt < acquireAt,
    'the abort timer must be armed BEFORE the gate acquire, or queue wait is unbounded');
  // and the aborted-wait must be detected after acquiring
  assert.ok(/if \(controller\.signal\.aborted\)/.test(body),
    'must bail if the budget expired while queued');
});

test('the gate slot is released on every exit path, including an aborted queue wait', () => {
  // A leaked slot would permanently deadlock all TOA traffic at
  // TOA_MAX_CONCURRENT, which is a far worse outage than the one being fixed.
  const i = SRC.indexOf('async function abortableFetch(');
  const body = SRC.slice(i, i + 2600);
  assert.ok(/finally\s*\{[^}]*clearTimeout\(timer\);[^}]*if \(held\) _toaRelease\(\);/s.test(body),
    'release must be in a finally that also covers the aborted-wait throw');
  assert.ok(/held = true;/.test(body), 'must track whether the slot was actually acquired');
});

test('the dynamic-sport path is gated too — tennis and soccer were still raw', () => {
  const i = SRC.indexOf('async function fetchDynamicSports(');
  assert.notStrictEqual(i, -1);
  let end = SRC.length;
  const m = /\n(async )?function /g; m.lastIndex = i + 10;
  const nxt = m.exec(SRC); if (nxt) end = nxt.index;
  const body = SRC.slice(i, end);
  assert.strictEqual((body.match(/await fetch\(/g) || []).length, 0,
    'fetchDynamicSports must not use raw fetch — it returns BEFORE the cooldown fail-fast');
  assert.ok((body.match(/abortableFetch/g) || []).length >= 2, 'both of its TOA calls must be gated');
});

test('the deadline carries skipped sports to the FRONT of the next sweep', () => {
  // Without rotation the same tail starves on every pass — and the warn line
  // claimed "first in line next sweep", a fairness property the code lacked.
  assert.ok(/let _deadlineCarry = \[\]/.test(SRC), 'must persist the skipped set');
  assert.ok(/const carried = _deadlineCarry\.filter/.test(SRC), 'must reuse it next sweep');
  assert.ok(/const sweepOrder = \[\.\.\.carried,/.test(SRC), 'carried sports must go FIRST');
  assert.ok(/for \(const sport of sweepOrder\)/.test(SRC), 'the loop must iterate the rotated order');
});

test('golf_matchups is exempt from the deadline — it costs no TOA budget', () => {
  // It is served by DataGolf, is appended LAST to the sweep list, and is the
  // only market with no other refresher: a deadline hit would zero golf lines.
  assert.ok(/const costsToa = sport !== 'golf_matchups'/.test(SRC),
    'non-TOA sports must not be deadline casualties');
  assert.ok(/if \(costsToa && Date\.now\(\) > sweepDeadlineAt\)/.test(SRC));
});

test('a free cold-skip is not miscounted as a deadline casualty', () => {
  const coldAt = SRC.indexOf("skipped: 'cold'");
  const dlAt = SRC.indexOf('if (costsToa && Date.now() > sweepDeadlineAt)');
  assert.ok(coldAt > -1 && dlAt > -1);
  assert.ok(coldAt < dlAt, 'the cold-sport check must run BEFORE the deadline check');
});

test('deadline skips name the sports, not just a count', () => {
  assert.ok(/lastDeadlineSkippedSports/.test(SRC), 'skipped sport names must be exposed');
  assert.ok(/deadlineSkippedNow\.join\(', '\)/.test(SRC), 'and logged by name');
});
