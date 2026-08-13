// In-memory daily P&L rollup (2026-08-13). The Supabase-paginated
// db.getDailyPnL took ~139s at days=400, so the dashboard's authoritative
// series ~never arrived and the Daily P&L chart's "All" range silently
// showed only the capped /orders fallback (~5 weeks). The rollup must match
// db.getDailyPnL's row shape and ET bucketing exactly — the client zeroes
// buffer P&L and overwrites from these rows.
//
// Fixtures use ABSOLUTE dates with a huge `days` window (cutoff never bites)
// so they are not date-bombs; only the cutoff test uses relative dates.
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const { _rollupDailyPnL } = require('../services/order-tracker');

const WIDE = 100000; // days — effectively no cutoff
const mk = (over) => Object.assign({
  status: 'settled_won', pnl: 10, confirmedStake: 100,
  settledAt: '2026-08-10T18:00:00Z', quotedAt: '2026-08-10T15:00:00Z',
}, over);

test('rolls settled rows into ET days with the db.getDailyPnL shape', () => {
  const rows = _rollupDailyPnL([
    mk({ pnl: 25, settledAt: '2026-08-10T18:00:00Z' }),                          // 2pm ET Aug 10
    mk({ status: 'settled_lost', pnl: -40, settledAt: '2026-08-10T20:00:00Z' }), // Aug 10
    mk({ status: 'settled_push', pnl: 0, settledAt: '2026-08-11T01:00:00Z' }),   // 9pm ET Aug 10!
  ], WIDE, 'settled_at');
  assert.equal(rows.length, 1, 'all three are the same ET day: ' + JSON.stringify(rows.map(r => r.date)));
  const r = rows[0];
  assert.equal(r.date, '2026-08-10');
  assert.equal(r.pnl, -15);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.pushes, 1);
  assert.equal(r.fills, 3);
  assert.equal(r.risk, 300);
});

test('ET midnight boundary: a 03:00Z settlement buckets to the PRIOR ET day', () => {
  const rows = _rollupDailyPnL([mk({ settledAt: '2026-08-11T03:00:00Z' })], WIDE, 'settled_at');
  assert.equal(rows[0].date, '2026-08-10');
});

test('groupBy quoted_at buckets by quote day; non-settled and no-timestamp rows drop', () => {
  const rows = _rollupDailyPnL([
    mk({ quotedAt: '2026-08-09T15:00:00Z' }),
    mk({ status: 'confirmed' }),             // not settled — excluded
    mk({ settledAt: null, quotedAt: null }), // no timestamp — excluded
  ], WIDE, 'quoted_at');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-08-09');
  assert.equal(rows[0].fills, 1);
});

test('cutoff excludes rows older than the window (relative dates — no date-bomb)', () => {
  const recent = new Date(Date.now() - 2 * 86400e3).toISOString();
  const old = new Date(Date.now() - 45 * 86400e3).toISOString();
  const rows = _rollupDailyPnL([mk({ settledAt: recent }), mk({ settledAt: old })], 30, 'settled_at');
  assert.equal(rows.reduce((s, r) => s + r.fills, 0), 1, 'only the 2-day-old row survives a 30d window');
});

test('rows come back ascending by date', () => {
  const rows = _rollupDailyPnL([
    mk({ settledAt: '2026-08-11T18:00:00Z' }),
    mk({ settledAt: '2026-08-09T18:00:00Z' }),
    mk({ settledAt: '2026-08-10T18:00:00Z' }),
  ], WIDE, 'settled_at');
  assert.deepEqual(rows.map(r => r.date), ['2026-08-09', '2026-08-10', '2026-08-11']);
});
