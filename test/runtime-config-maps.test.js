// stalePriceMinutesBySport and propNetExposureBySport are runtime-tunable
// (2026-09-26): changing either through Railway restarted the trader twice at
// peak CFB Saturday. Both consumers read config.pricing per call, so a runtime
// write takes effect on the next RFQ.
//
// Run: node --test test/runtime-config-maps.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

test('both maps are registered as runtime numMap keys with their env names', () => {
  const src = fs.readFileSync(require.resolve('../services/runtime-config'), 'utf8');
  for (const [k, env] of [['stalePriceMinutesBySport', 'STALE_PRICE_MINUTES_BY_SPORT'], ['propNetExposureBySport', 'PROP_NET_EXPOSURE_BY_SPORT']]) {
    const re = new RegExp(`key: '${k}', path: '${k}', type: 'numMap'[^}]*env: '${env}'`);
    assert.ok(re.test(src), `${k} registered as numMap bound to ${env}`);
  }
});

test('consumers read config.pricing at call time (no module-load capture)', () => {
  const odds = fs.readFileSync(require.resolve('../services/odds-feed'), 'utf8');
  assert.ok(/config\.pricing\.stalePriceMinutesBySport \|\| \{\}/.test(odds));
  const pricer = fs.readFileSync(require.resolve('../services/pricer'), 'utf8');
  assert.ok(/config\.pricing\.propNetExposureBySport \|\| \{\}/.test(pricer));
});
