const test = require('node:test');
const assert = require('node:assert');
const { _intOdds } = require('../services/db');

// matched_odds / our_odds are INTEGER columns. Postgres rejects a decimal
// outright and saveMatchedParlay only logs, so the row vanishes from market
// intelligence with no trace beyond one error line.
test('rounds the decimal PX actually sent (2026-08-22 prod)', () => {
  assert.strictEqual(_intOdds(-1019.82), -1020);
});

test('leaves ordinary integer odds untouched', () => {
  for (const v of [-110, 150, -4255, 3308, 0]) {
    assert.strictEqual(_intOdds(v), v);
  }
});

test('rounds toward nearest on both signs', () => {
  assert.strictEqual(_intOdds(120.4), 120);
  assert.strictEqual(_intOdds(120.6), 121);
  assert.strictEqual(_intOdds(-843.5), -843); // Math.round: -843.5 -> -843
});

test('coerces numeric strings, since PX sends odds as strings on some paths', () => {
  assert.strictEqual(_intOdds('-1019.82'), -1020);
  assert.strictEqual(_intOdds('265'), 265);
});

test('null and unusable values become null, never NaN', () => {
  // NaN would serialize as null anyway, but an explicit null keeps the
  // failure legible instead of writing a silent zero.
  for (const v of [null, undefined, '', 'n/a', NaN, Infinity]) {
    assert.strictEqual(_intOdds(v), null, `expected null for ${String(v)}`);
  }
});
