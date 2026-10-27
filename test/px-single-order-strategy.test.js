// order_strategy pass-through (ALO, PX maker/taker fees 2026-11): v4 sends it, unknown values are dropped.
const test = require('node:test');
const assert = require('node:assert');

process.env.PX_V4_WRITES = 'true';
process.env.PX_ACCESS_KEY = process.env.PX_ACCESS_KEY || 'k';
process.env.PX_SECRET_KEY = process.env.PX_SECRET_KEY || 's';
const sent = [];
global.fetch = async (url, opts) => {
  if (/auth\/login/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ data: { access_token: 'x.eyJleHAiOjk5OTk5OTk5OTl9.y', refresh_token: 'r' } }), text: async () => '' };
  }
  sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return { ok: true, status: 200, json: async () => ({ data: { succeed_orders: [] } }), text: async () => '{}' };
};
delete require.cache[require.resolve('../services/px-single')];
const pxs = require('../services/px-single');

test('ALO and fillOrKill reach the v4 body; absent or unknown strategies send no field', async () => {
  await pxs.placeMultipleWagers([
    { line_id: 'L1', odds: 120, stake: 5, external_id: 'a', order_strategy: 'ALO' },
    { line_id: 'L2', odds: 120, stake: 5, external_id: 'b' },
    { line_id: 'L3', odds: 120, stake: 5, external_id: 'c', order_strategy: 'bogus' },
    { line_id: 'L4', odds: 120, stake: 5, external_id: 'd', order_strategy: 'fillOrKill' },
  ]);
  const place = sent.find(s => /submit_multiple_orders/.test(s.url));
  assert.ok(place, 'went to the v4 route');
  const d = place.body.data;
  assert.strictEqual(d[0].order_strategy, 'ALO');
  assert.ok(!('order_strategy' in d[1]));
  assert.ok(!('order_strategy' in d[2]));
  assert.strictEqual(d[3].order_strategy, 'fillOrKill');
  assert.strictEqual(d[0].strike_id, 'L1');
});
