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

test('boundary is closeAt (tee minus lead), NOT the tee itself', () => {
  // Superseded the original "open one minute before the tee" assertion when the
  // 30min lead landed: 10:59 is now INSIDE the buffer and must be shut. That is
  // the point of the buffer — de-registration is not instantaneous.
  assert.strictEqual(openAt(ET(2026, 7, 29, 10, 29)).open, true,  'just before closeAt');
  assert.strictEqual(openAt(ET(2026, 7, 29, 10, 31)).open, false, 'just after closeAt');
  assert.strictEqual(openAt(ET(2026, 7, 29, 10, 59)).open, false, 'inside the buffer, before the tee');
  assert.strictEqual(openAt(ET(2026, 7, 29, 11, 1)).open, false,  'after the tee');
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

// ------------------------------------------------- close-early lead time

test('closes leadMinutes BEFORE the tee, not at it', () => {
  // Default lead is 30min. R3 tees 11:00 ET Sat, so the window must shut 10:30.
  const R3 = Date.UTC(2026, 7, 29, 15, 0);        // 11:00 ET Sat
  const at = (ms) => { w._setCacheForTest([R3], ms, 2); return w.getWindow(ms); };
  assert.strictEqual(at(ET(2026, 7, 29, 10, 25)).open, true,  '10:25 still open');
  assert.strictEqual(at(ET(2026, 7, 29, 10, 35)).open, false, '10:35 must be shut — inside the 30min buffer');
  assert.strictEqual(at(ET(2026, 7, 29, 10, 59)).open, false, 'and certainly not right at the tee');
});

test('closeAt is reported so the operator can see when quoting stops', () => {
  const R3 = Date.UTC(2026, 7, 29, 15, 0);
  w._setCacheForTest([R3], ET(2026, 7, 29, 2, 0), 2);
  const r = w.getWindow(ET(2026, 7, 29, 2, 0));
  assert.strictEqual(r.closeAt, R3 - 30 * 60000);
  assert.strictEqual(r.leadMinutes, 30);
});

// ------------------------------------------- backstop when no tee is published

// The tour posts the next round's tee sheet only after the current round is
// scored, so an evening with no future tee time is NORMAL and must stay open.
// But it must not stay open FOREVER — that is how outrights leak into live
// play. Default backstop is 12h from the 19:00 open, i.e. 07:00 ET.
test('no published tee: open through the evening, shut by the backstop', () => {
  // Only tee on record is THIS morning's R3, i.e. before the 19:00 open.
  const R3 = Date.UTC(2026, 7, 29, 15, 55);       // 11:55 ET Sat
  const at = (ms) => { w._setCacheForTest([R3], ms, 3); return w.getWindow(ms); };

  const evening = at(ET(2026, 7, 29, 20, 0));     // 20:00 ET Sat
  assert.strictEqual(evening.open, true, 'evening after the open must quote');
  assert.strictEqual(evening.nextStart, null, 'precondition: no tee after lastOpen');
  assert.strictEqual(evening.backstop, true, 'and it must say it is on the backstop');

  assert.strictEqual(at(ET(2026, 7, 30, 6, 30)).open, true,  '06:30 ET still inside 12h');
  assert.strictEqual(at(ET(2026, 7, 30, 7, 30)).open, false, '07:30 ET is past the backstop — must be shut');
  assert.strictEqual(at(ET(2026, 7, 30, 11, 0)).open, false, 'and it must not reopen into live play');
});

test('a published tee still wins over the backstop', () => {
  // Backstop must not loosen the normal path: an R4 tee at 09:00 ET closes the
  // window at 08:30, hours before the 07:00-next-day backstop would have.
  const R4 = Date.UTC(2026, 7, 30, 13, 0);        // 09:00 ET Sun
  const at = (ms) => { w._setCacheForTest([R4], ms, 3); return w.getWindow(ms); };
  const r = at(ET(2026, 7, 29, 20, 0));
  assert.strictEqual(r.open, true);
  assert.ok(!r.backstop, 'not a backstop decision when a tee is known');
  assert.strictEqual(r.closeAt, R4 - 30 * 60000);
  assert.strictEqual(at(ET(2026, 7, 30, 8, 45)).open, false, '08:45 is inside the 30min lead');
});
