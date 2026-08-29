// Never quote an event more than MAX_DAYS_AHEAD out (operator directive
// 2026-08-29, default 6 days).
//
// Measured that day: 294 NFL lines registered 7-15 days ahead — season-opener
// spreads and totals resting on the book for a fortnight, where our fair moves
// far more than the price does.
//
// TWO properties matter and are easy to get wrong:
//   1. The cap is ONE-SIDED. Golf outrights carry scheduled = R1 tee, which is
//      days in the PAST mid-tournament (358 such lines that day). A two-sided
//      window would silently drop every one.
//   2. BOTH registration paths must be gated. eventIndex deliberately holds ALL
//      events for name resolution, so resolveUnknownLine could re-register a
//      far-future line on demand and undo a seed-only cap.
//
// Run: npm test  (or: node --test test/max-days-ahead.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

const DAY = 86400000;
const capped = (startMs, nowMs, maxDays = 6) => startMs > nowMs + maxDays * DAY;

test('the cap knob exists at module scope with a default of 6', () => {
  assert.match(src, /const MAX_DAYS_AHEAD = \(\(\) => \{/, 'must be module-scoped so BOTH paths can use it');
  assert.match(src, /process\.env\.MAX_DAYS_AHEAD/);
  assert.match(src, /Number\.isFinite\(v\) && v > 0 \? v : 6/, 'default 6 days');
});

test('the seed path applies the cap', () => {
  assert.match(src, /droppedAsTooFar\+\+/, 'seed must count and drop far-future events');
});

test('the ON-DEMAND path applies the cap too', () => {
  assert.match(src, /beyond_max_days_ahead/,
    'resolveUnknownLine must refuse far-future lines — eventIndex holds ALL events');
});

test('an event inside the window is kept', () => {
  const now = Date.UTC(2026, 7, 29, 12, 0);
  assert.strictEqual(capped(now + 0.5 * DAY, now), false, 'today');
  assert.strictEqual(capped(now + 5.9 * DAY, now), false, 'just inside 6d');
});

test('an event beyond the window is dropped', () => {
  const now = Date.UTC(2026, 7, 29, 12, 0);
  assert.strictEqual(capped(now + 6.1 * DAY, now), true, 'just past 6d');
  // The real case: NFL opener 15 days out.
  assert.strictEqual(capped(Date.UTC(2026, 8, 13, 17, 0), now), true, 'NFL 9/13 opener');
});

test('THE ONE-SIDED PROPERTY: past and in-progress events are never dropped', () => {
  const now = Date.UTC(2026, 7, 29, 12, 0);
  // Golf outright scheduled = R1 tee, two days ago, still live.
  assert.strictEqual(capped(Date.UTC(2026, 7, 27, 15, 0), now), false,
    'a golf outright mid-tournament must survive the FORWARD cap');
  assert.strictEqual(capped(now - 1, now), false, 'in-progress');
});

test('the cap is configurable', () => {
  const now = Date.UTC(2026, 7, 29, 12, 0);
  assert.strictEqual(capped(now + 10 * DAY, now, 14), false, 'raised cap keeps it');
  assert.strictEqual(capped(now + 10 * DAY, now, 6), true, 'default cap drops it');
});
