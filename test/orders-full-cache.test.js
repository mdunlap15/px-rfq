// /orders full-history cache (2026-09-25): only the UNCAPPED call is cached, so the
// dashboard's live poll (?settled=400) always reflects current open positions.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('cache applies only when ?settled is absent', () => {
  assert.ok(/const _cacheable = req\.query\.settled == null && _ordersFullCacheMs > 0;/.test(SRC));
});
test('cache is keyed on limit and bounded by the TTL', () => {
  assert.ok(/_ordersFullCache\.key === limit\s*\r?\n\s*&& Date\.now\(\) - _ordersFullCache\.at < _ordersFullCacheMs/.test(SRC));
});
test('TTL defaults to 60s and 0 disables', () => {
  assert.ok(/parseInt\(process\.env\.ORDERS_FULL_CACHE_MS, 10\);\s*\r?\n\s*return Number\.isFinite\(v\) && v >= 0 \? v : 60000;/.test(SRC));
});
