// /orders cache. 2026-09-25: only the uncapped call was cached. 2026-11-01: EVERY
// (limit, settled) variant is cached — the portfolio-tracker's uncached
// ?settled=40000 (~121MB) froze the trader's event loop 30-61s at a time at the
// NFL 1pm kickoff. Deep variants keep the 60s TTL; shallow live polls get 10s so
// open-position live state stays fresh.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const HANDLER = SRC.slice(SRC.indexOf("app.get('/orders'"), SRC.indexOf("app.get('/orders'") + 6000);

test('every variant is cached, keyed on limit AND settled', () => {
  assert.ok(/const _key = limit \+ '\|' \+ \(Number\.isFinite\(_settled\) \? _settled : 'all'\);/.test(SRC));
  assert.ok(!/_cacheable = req\.query\.settled == null/.test(SRC), 'the settled-absent-only gate is gone');
});

test('deep variants (no cap or cap above ORDERS_DEEP_SETTLED) use the full TTL; shallow ones the capped TTL', () => {
  assert.ok(/const _deep = !\(Number\.isFinite\(_settled\) && _settled > 0\) \|\| _settled > _ordersDeepSettled;/.test(SRC));
  assert.ok(/const _ttl = _deep \? _ordersFullCacheMs : _ordersCappedCacheMs;/.test(SRC));
});

test('TTL defaults: deep 60s, shallow 10s, deep threshold 2000; 0 disables', () => {
  assert.ok(/parseInt\(process\.env\.ORDERS_FULL_CACHE_MS, 10\);\s*\r?\n\s*return Number\.isFinite\(v\) && v >= 0 \? v : 60000;/.test(SRC));
  assert.ok(/parseInt\(process\.env\.ORDERS_CAPPED_CACHE_MS, 10\);\s*\r?\n\s*return Number\.isFinite\(v\) && v >= 0 \? v : 10000;/.test(SRC));
  assert.ok(/parseInt\(process\.env\.ORDERS_DEEP_SETTLED, 10\) \|\| 2000/.test(SRC));
  assert.ok(/const _hit = _ttl > 0 \? _ordersCache\.get\(_key\) : null;/.test(HANDLER));
  assert.ok(/if \(_ttl > 0\) \{/.test(HANDLER));
});

test('a hit is served only inside the TTL, and the cache stays bounded', () => {
  assert.ok(/if \(_hit && Date\.now\(\) - _hit\.at < _ttl\)/.test(HANDLER));
  assert.ok(/if \(_ordersCache\.size > 8\) _ordersCache\.delete/.test(HANDLER));
});

test('the cached body is exactly what is sent on a miss', () => {
  assert.ok(/const body = JSON\.stringify\(_payload\);/.test(HANDLER));
  assert.ok(/_ordersCache\.set\(_key, \{ at: Date\.now\(\), body \}\);/.test(HANDLER));
  assert.ok(/res\.type\('application\/json'\)\.send\(body\);/.test(HANDLER));
});
