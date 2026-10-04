// reconcileGhostConfirmed must persist an order only when its phantom state or
// reason CHANGES (2026-10-04: re-stamping phantomMarkedAt every pass rewrote
// thousands of already-phantom orders per cycle, ~47 Supabase req/s).
const { test } = require('node:test');
const assert = require('node:assert');
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'order-tracker.js'), 'utf8').replace(/\r\n/g, '\n');

test('every phantomMarkedAt stamp in reconcileGhostConfirmed sits behind a change guard', () => {
  const i = src.indexOf('async function reconcileGhostConfirmed(');
  const j = src.indexOf('\nasync function ', i + 10);
  const body = src.slice(i, j > 0 ? j : undefined);
  const stamps = body.split('order.meta.phantomMarkedAt = new Date().toISOString();').length - 1;
  const guards = (body.match(/if \(!\(wasAlreadyPhantom && order\.meta\.phantomReason === reason\)\) \{/g) || []).length;
  assert.strictEqual(stamps, 2);
  assert.strictEqual(guards, 2, 'each phantom stamp must be inside the unchanged-state guard');
  assert.match(body, /if \(order\.meta\.pxStatusMismatch !== pxStatus\) \{/);
});
