// Daily VOLUME rollup (2026-08-21). The Daily Volume & P&L table summed its
// count / risk / toWin columns out of the CAPPED /orders payload, and the two
// clients capped it differently — index.html `?settled=400`, viewer.html
// `?settled=800` — with different uncap triggers (desktop on the analytics/lost
// sections, viewer on the settled positions tab). The same day therefore showed
// different totals in the desktop dashboard than in /viewer, and every day past
// the cap was short in BOTH. This rollup runs over the full in-memory orders
// map so both clients render identical, untruncated numbers.
//
// Bucketing MUST match renderOrdersDailyVolume exactly: ET day of
// (confirmedAt || quotedAt), over confirmed AND settled_* rows, skipping
// reconstructed phantoms that carry no quotedAt.
//
// Fixtures use ABSOLUTE dates with a huge `days` window (cutoff never bites)
// so they are not date-bombs; only the cutoff test uses relative dates.
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const { _rollupDailyVolume } = require('../services/order-tracker');

const WIDE = 100000; // days — effectively no cutoff
const mk = (over) => Object.assign({
  status: 'confirmed', confirmedStake: 100, offeredOdds: -200,
  confirmedAt: '2026-08-10T18:00:00Z', quotedAt: '2026-08-10T17:00:00Z',
}, over);

test('buckets confirmed + settled rows into ET days', () => {
  const rows = _rollupDailyVolume([
    mk({ confirmedAt: '2026-08-10T18:00:00Z' }),                        // 2pm ET Aug 10
    mk({ status: 'settled_won', confirmedAt: '2026-08-10T20:00:00Z' }), // Aug 10
    mk({ status: 'settled_lost', confirmedAt: '2026-08-11T01:00:00Z' }),// 9pm ET Aug 10!
  ], WIDE);
  assert.equal(rows.length, 1, 'all three are the same ET day: ' + JSON.stringify(rows.map(r => r.date)));
  assert.equal(rows[0].date, '2026-08-10');
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].risk, 300);
});

test('ET midnight boundary: a 03:00Z fill buckets to the PRIOR ET day', () => {
  const rows = _rollupDailyVolume([mk({ confirmedAt: '2026-08-11T03:00:00Z' })], WIDE);
  assert.equal(rows[0].date, '2026-08-10', '11pm ET Aug 10, not Aug 11');
});

test('toWin matches the client calcSpProfit: stake * 100 / |odds|', () => {
  // -200 → we risk 100 to win 50. +150 → we risk 100 to win 66.67.
  const rows = _rollupDailyVolume([
    mk({ confirmedStake: 100, offeredOdds: -200 }),
    mk({ confirmedStake: 100, offeredOdds: 150 }),
  ], WIDE);
  assert.ok(Math.abs(rows[0].toWin - (50 + 100 * 100 / 150)) < 1e-9,
    'toWin was ' + rows[0].toWin);
});

test('sub-100 odds contribute 0 rather than blowing up', () => {
  const rows = _rollupDailyVolume([mk({ offeredOdds: 5 })], WIDE);
  assert.equal(rows[0].toWin, 0);
  assert.equal(rows[0].count, 1, 'still counted as a fill');
});

test('falls back to quotedAt when confirmedAt is absent', () => {
  const rows = _rollupDailyVolume([
    mk({ confirmedAt: null, quotedAt: '2026-08-12T16:00:00Z' }),
  ], WIDE);
  assert.equal(rows[0].date, '2026-08-12');
});

test('skips rows that are neither confirmed nor settled', () => {
  const rows = _rollupDailyVolume([
    mk({ status: 'quoted' }),
    mk({ status: 'declined' }),
    mk({ status: 'confirmed' }),
  ], WIDE);
  assert.equal(rows[0].count, 1, 'only the confirmed row counts');
});

test('skips reconstructed phantoms with no quotedAt (same guard as the client)', () => {
  const rows = _rollupDailyVolume([
    mk({ quotedAt: null, meta: { reconstructed: true } }),
    mk({}),
  ], WIDE);
  assert.equal(rows[0].count, 1);
});

test('a reconstructed row that DOES carry quotedAt is kept', () => {
  const rows = _rollupDailyVolume([
    mk({ meta: { reconstructed: true } }),
  ], WIDE);
  assert.equal(rows[0].count, 1);
});

test('rows older than the cutoff drop out', () => {
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
  const rows = _rollupDailyVolume([
    mk({ confirmedAt: old }),
    mk({ confirmedAt: recent }),
  ], 7);
  assert.equal(rows.length, 1, 'only the row inside the 7-day window survives');
});

test('unparseable timestamps are skipped, not NaN-bucketed', () => {
  const rows = _rollupDailyVolume([
    mk({ confirmedAt: 'not-a-date', quotedAt: null }),
    mk({}),
  ], WIDE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 1);
});

test('output is sorted ascending by date', () => {
  const rows = _rollupDailyVolume([
    mk({ confirmedAt: '2026-08-12T16:00:00Z' }),
    mk({ confirmedAt: '2026-08-10T16:00:00Z' }),
    mk({ confirmedAt: '2026-08-11T16:00:00Z' }),
  ], WIDE);
  assert.deepEqual(rows.map(r => r.date), ['2026-08-10', '2026-08-11', '2026-08-12']);
});
