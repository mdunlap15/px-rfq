// Probe for test/audit-fix-review.test.js. Run by that test as
// `node --test --test-isolation=none <this file>` — the in-process runner mode
// that used to leave NODE_TEST_CONTEXT unset and point services/db.js at
// PRODUCTION. Only reads isEnabled(); it never writes, so a regression fails the
// assertion without touching the database.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('db.js is disabled under --test-isolation=none', () => {
  const db = require(path.join(__dirname, '..', '..', 'services', 'db'));
  assert.strictEqual(db.isEnabled(), false, 'services/db.js must be a no-op in any node --test run');
});
