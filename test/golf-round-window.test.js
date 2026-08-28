// Golf outright quoting window: 19:00 ET → next round's first tee.
//
// Tee times come from DataGolf's FULL FIELD, not PX matchups. PX posts only a
// subset of pairings, so its earliest tee is an upper bound on the round start
// — measured 2026-08-28 at the TOUR Championship, the field starts 11:00
// (Cameron Young, in no PX pairing) while PX's earliest matchup is 11:12.
//
// The rule spans midnight, so the tests below pin the boundary cases rather
// than the easy midday one.
//
// Run: npm test   (or: node --test test/golf-round-window.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

process.env.GOLF_OUTRIGHT_WINDOW_ENABLED = 'true';
delete require.cache[require.resolve('../config')];
const w = require('../services/golf-round-window');

// TOUR Championship, EDT (UTC-4).
const R2_TEE = Date.UTC(2026, 7, 28, 15, 0);   // 11:00 ET Fri 28th
const R3_TEE = Date.UTC(2026, 7, 29, 15, 0);   // 11:00 ET Sat 29th
const ET = (y, m, d, h, mi) => Date.UTC(y, m, d, h + 4, mi); // ET → UTC in EDT

const openAt = (ms, tees = [R2_TEE, R3_TEE]) => {
  w._setCacheForTest(tees, ms, 2);   // cache stamped fresh at the test instant
  return w.getWindow(ms);
};

test('teeToMs converts course-local + tz_offset to UTC', () => {
  // 11:00 local with tz_offset -14400 (UTC-4) is 15:00 UTC.
  assert.strictEqual(w.teeToMs('2026-08-28 11:00', -14400), Date.UTC(2026, 7, 28, 15, 0));
});

test('teeToMs refuses an unparseable tee time (fails closed upstream)', () => {
  assert.strictEqual(w.teeToMs('', -14400), null);
  assert.strictEqual(w.teeToMs('2026-08-28 11:00', undefined), null);
});

test('CLOSED during the round', () => {
  const r = openAt(ET(2026, 7, 28, 11, 30));      // 11:30 ET, field away at 11:00
  assert.strictEqual(r.open, false);
});

test('OPEN in the evening after the round', () => {
  assert.strictEqual(openAt(ET(2026, 7, 28, 20, 0)).open, true);
});

test('THE MIDNIGHT CASE: still open after midnight, before the next tee', () => {
  // 00:30 ET Saturday. The window opened at 19:00 ET Friday — a naive
  // "is it after 7pm today" check reads false here and would stop quoting
  // during exactly the hours the operator wants us live.
  assert.strictEqual(openAt(ET(2026, 7, 29, 0, 30)).open, true);
});

test('THE ANCHORING CASE: closed mid-round even when tomorrow tees are published', () => {
  // 11:30 ET Saturday, R3 under way since 11:00. If "next tee" were anchored to
  // NOW, Saturday's 11:00 would already be past and the next tee would be
  // Sunday's — reading OPEN through the whole round. Anchoring to the last
  // 19:00 boundary keeps Saturday's 11:00 in view.
  const sun = Date.UTC(2026, 7, 30, 15, 0);
  const r = openAt(ET(2026, 7, 29, 11, 30), [R2_TEE, R3_TEE, sun]);
  assert.strictEqual(r.open, false, 'must stay closed while the round is being played');
});

test('boundary: open one minute before the first tee, closed one minute after', () => {
  assert.strictEqual(openAt(ET(2026, 7, 29, 10, 59)).open, true);
  assert.strictEqual(openAt(ET(2026, 7, 29, 11, 1)).open, false);
});

test('open at exactly 19:00 ET', () => {
  assert.strictEqual(openAt(ET(2026, 7, 28, 19, 0)).open, true);
});

test('no tee published after the boundary leaves the window open', () => {
  // Final round finished; nothing scheduled beyond it.
  assert.strictEqual(openAt(ET(2026, 7, 30, 21, 0), [R2_TEE, R3_TEE]).open, true);
});

// ------------------------------------------------------------- fail closed

test('FAILS CLOSED with no field data', () => {
  w._setCacheForTest(null);
  const r = w.getWindow(ET(2026, 7, 28, 20, 0));
  assert.strictEqual(r.open, false);
  assert.match(r.reason, /no field data/i);
});

test('FAILS CLOSED on stale field data', () => {
  const now = ET(2026, 7, 28, 20, 0);
  w._setCacheForTest([R2_TEE, R3_TEE], now - 5 * 3600 * 1000, 2);  // 5h old vs 180min max
  const r = w.getWindow(now);
  assert.strictEqual(r.open, false);
  assert.match(r.reason, /stale/i);
});

test('disabled means no gating at all — never accidentally blocks quoting', () => {
  const saved = process.env.GOLF_OUTRIGHT_WINDOW_ENABLED;
  try {
    delete process.env.GOLF_OUTRIGHT_WINDOW_ENABLED;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/golf-round-window')];
    const w2 = require('../services/golf-round-window');
    w2._setCacheForTest(null);                       // even with NO data
    const r = w2.getWindow(ET(2026, 7, 28, 11, 30)); // even mid-round
    assert.strictEqual(r.open, true);
    assert.strictEqual(r.enabled, false);
  } finally {
    if (saved != null) process.env.GOLF_OUTRIGHT_WINDOW_ENABLED = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../services/golf-round-window')];
  }
});
