// Mass-removal circuit breaker for the PX supported-lines reconcile.
//
// A transient upstream failure (odds outage, empty PX event fetch, one bad
// seed) makes every registered line look "stale" for one cycle. Without a
// breaker the reconcile would REMOVE the entire supported set and re-register
// it next cycle — a burst-shaped write storm against PX and a window where
// every RFQ declines as unknown. Legitimate churn is incremental; wiping >60%
// of a non-trivial set in ONE pass is an outage signature.
//
// The reconcile also keeps skipped ids in the tracked set when the breaker
// fires, so removal is RETRIED next cycle rather than silently forgotten.
//
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const lm = require('../services/line-manager');
const fires = lm._removalBreakerFires;

test('fires on an outage signature: most of a large set removed at once', () => {
  assert.equal(fires(3000, 2900, 60), true, '97% removal must trip it');
  assert.equal(fires(3000, 1900, 60), true, '63% removal must trip it');
});

test('does NOT fire on normal slate churn', () => {
  assert.equal(fires(3000, 900, 60), false, '30% (a slate rolling over) is normal');
  assert.equal(fires(3000, 1800, 60), false, 'exactly 60% is the boundary — not over it');
  assert.equal(fires(5000, 0, 60), false, 'nothing to remove');
});

test('small sets are exempt — early boot and off-season are legitimately lumpy', () => {
  assert.equal(fires(199, 199, 60), false, 'full wipe of a tiny set is recoverable');
  assert.equal(fires(50, 50, 60), false);
  assert.equal(fires(200, 190, 60), true, 'at the 200 threshold the breaker arms');
});

test('pct=100 disables the breaker entirely', () => {
  assert.equal(fires(5000, 5000, 100), false);
});

test('bad pct falls back to the 60 default', () => {
  assert.equal(fires(1000, 700, 0), true, '70% > default 60');
  assert.equal(fires(1000, 500, NaN), false, '50% < default 60');
  assert.equal(fires(1000, 700, -5), true);
});
