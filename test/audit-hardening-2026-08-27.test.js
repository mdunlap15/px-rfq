// Regression tests for the three defensive fixes from the 2026-08-27 CFTC
// terminology audit. All three are pre-existing single points of failure that
// happen to be triggered by a PX field rename, but are not specific to it —
// any upstream shape change reaches them the same way.
//
// 1. legLineId  — a leg object whose id field is missing must NOT become the
//    lookup key. The old `leg.line_id || leg.lineId || leg` returned the OBJECT,
//    which is truthy, so every `if (!lineId)` guard passed and caches keyed on
//    '[object Object]'.
// 2. _seedSwapBreakerFires — seedAllLines is build-then-swap; a collapsed parse
//    would WIPE a working line index and take the book dark with no exception.
// 3. The confirm handler must fail CLOSED when stake/odds are unreadable.
//    `const ourRisk = confirmedStake || 0` made undefined indistinguishable
//    from a legitimate zero, and 0 risk makes every confirm-time cap a no-op.
//
// Run: npm test   (or: node --test test/audit-hardening-2026-08-27.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const { legLineId } = require('../services/leg-id');
const lineManager = require('../services/line-manager');

// ---------------------------------------------------------------- legLineId

test('legLineId: reads line_id off a normal PX leg', () => {
  assert.strictEqual(legLineId({ line_id: 'abc123' }), 'abc123');
});

test('legLineId: reads our internal lineId spelling', () => {
  assert.strictEqual(legLineId({ lineId: 'def456' }), 'def456');
});

test('legLineId: line_id wins when both are present', () => {
  assert.strictEqual(legLineId({ line_id: 'px', lineId: 'ours' }), 'px');
});

test('legLineId: a bare string id passes through (what the old || leg tail served)', () => {
  assert.strictEqual(legLineId('rawid'), 'rawid');
});

test('legLineId: a numeric id passes through', () => {
  assert.strictEqual(legLineId(12345), 12345);
});

test('THE BUG: a leg object with no id returns null, never the object itself', () => {
  const leg = { strike_id: 'cftc-spelling', selection: 'over' };
  const got = legLineId(leg);
  assert.strictEqual(got, null, 'must not fall back to the leg object');
  assert.notStrictEqual(got, leg, 'must not be the leg object itself');
  // The precise failure this prevents: an object key stringifies to a single
  // shared bucket, so every distinct unknown leg collides into one cache entry.
  assert.notStrictEqual(String(got), '[object Object]');
});

test('THE BUG: a truthy object never survives an `if (!lineId)` guard', () => {
  const leg = { quantity: 100 };            // no id field at all
  const lineId = legLineId(leg);
  assert.ok(!lineId, 'guard must reject it');
});

test('legLineId: null / undefined / empty object all return null', () => {
  assert.strictEqual(legLineId(null), null);
  assert.strictEqual(legLineId(undefined), null);
  assert.strictEqual(legLineId({}), null);
});

test('legLineId: a nested object id is refused rather than used as a key', () => {
  assert.strictEqual(legLineId({ line_id: { nested: true } }), null);
});

test('legLineId: does NOT yet accept strike_id — that must land with the `line` fix', () => {
  // Deliberate. Accepting strike_id alone would let selections through with a
  // null strike, and `undefined < 0` is false, tagging every spread selection
  // 'underdog' — a wrong-side registration that misprices rather than declines.
  assert.strictEqual(legLineId({ strike_id: 'x' }), null);
});

// ------------------------------------------------- seed swap circuit breaker

const fires = lineManager._seedSwapBreakerFires;

test('seed breaker: cold start (no previous index) always swaps', () => {
  assert.strictEqual(fires(0, 0, 10, 200), false);
  assert.strictEqual(fires(0, 5000, 10, 200), false);
});

test('seed breaker: a small previous book is exempt (legitimately lumpy)', () => {
  assert.strictEqual(fires(150, 0, 10, 200), false);
});

test('THE BUG: a collapsed parse must NOT replace a working index', () => {
  assert.strictEqual(fires(6000, 0, 10, 200), true, 'zero lines vs 6000 live must fire');
  assert.strictEqual(fires(6000, 50, 10, 200), true, 'a 99% collapse must fire');
});

test('seed breaker: normal churn swaps normally', () => {
  assert.strictEqual(fires(6000, 5800, 10, 200), false);
  assert.strictEqual(fires(6000, 3000, 10, 200), false, 'even a 50% slate rollover is legitimate');
});

test('seed breaker: exactly at the threshold does not fire', () => {
  assert.strictEqual(fires(1000, 100, 10, 200), false, '10% of 1000 is not < 10%');
  assert.strictEqual(fires(1000, 99, 10, 200), true);
});

test('seed breaker: SEED_SWAP_BREAKER_PCT=0 disables it', () => {
  assert.strictEqual(fires(6000, 0, 0, 200), false);
});

test('seed breaker: a malformed pct falls back to the 10% default', () => {
  assert.strictEqual(fires(6000, 0, undefined, 200), true);
  assert.strictEqual(fires(6000, 0, 'abc', 200), true);
});

// ------------------------------------------- confirm fail-closed (money read)
//
// These drive the REAL predicate the handler calls, imported from websocket.js.
// An earlier version of this file hand-copied the logic, which meant the guard
// could be deleted outright and the suite would still pass — worthless as a
// regression test, and actively dangerous because a green suite is the gate for
// the unattended 1am auto-push. Requiring websocket.js from a test is already
// established practice (test/football-lines.test.js) and has no connect
// side effect at module load.

const { _confirmMoneyIsReadable: confirmMoneyIsReadable } = require('../services/websocket');

test('confirm guard: a normal legacy payload is accepted', () => {
  assert.strictEqual(confirmMoneyIsReadable(1774, -1774), true);
});

test('THE BUG: a payload missing stake/odds is REJECTED, not treated as risk 0', () => {
  // This is the CFTC shape (quantity/price) but the guard is shape-agnostic:
  // anything unreadable fails closed.
  assert.strictEqual(confirmMoneyIsReadable(undefined, undefined), false);
  assert.strictEqual(confirmMoneyIsReadable(undefined, -1774), false);
  assert.strictEqual(confirmMoneyIsReadable(1774, undefined), false);
});

test('confirm guard: risk 0 can never pass a cap check trivially again', () => {
  // The exact failure: `0 > maxRisk` is false, so a $50,000 confirm on a
  // $500-capped parlay was accepted silently.
  const ourRisk = 0, maxRisk = 500;
  assert.strictEqual(ourRisk > maxRisk, false, 'this is why 0 must never be reached');
  assert.strictEqual(confirmMoneyIsReadable(0, -1774), false, 'so 0 is refused up front');
});

test('confirm guard: NaN and non-numeric strings are refused', () => {
  assert.strictEqual(confirmMoneyIsReadable(NaN, -110), false);
  assert.strictEqual(confirmMoneyIsReadable('abc', -110), false);
  assert.strictEqual(confirmMoneyIsReadable(100, 'xyz'), false);
});

test('confirm guard: a numeric string stake still works (PX has sent both)', () => {
  assert.strictEqual(confirmMoneyIsReadable('1774', '-1774'), true);
});

test('confirm guard: negative stake is refused', () => {
  assert.strictEqual(confirmMoneyIsReadable(-50, -110), false);
});
