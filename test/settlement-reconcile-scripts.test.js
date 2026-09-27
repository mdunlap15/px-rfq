// Pure logic + write guards of the two 2026-09-27 bookkeeping scripts:
//   scripts/_reconcile_push_settlements.js  (won-with-a-push rows vs PX)
//   scripts/_estimate_restored_fairs.js     (fairs for the 9/25 outage restores)
// Requiring a script never runs it (main() is behind require.main), and neither
// script loads services/db or services/order-tracker, so nothing here can write.
//
// Run: node --test test/settlement-reconcile-scripts.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const rec = require('../scripts/_reconcile_push_settlements');
const est = require('../scripts/_estimate_restored_fairs');

const leg = (lineId, pxEventId, fairProb, settlementStatus) =>
  ({ lineId, pxEventId, fairProb, settlementStatus, settlement_status: settlementStatus });

// 01a09baf: 3 NFL MLs won + Raiders total PUSH on the Raiders ML's game.
const row09baf = () => ({
  parlay_id: '01a09baf-119c-771d-9067-b31d2530dbbf', status: 'settled_push', pnl: 0,
  confirmed_odds: -543, confirmed_stake: 5120.92,
  legs: [leg('pit', 19464, 0.7209, 'won'), leg('cin', 19459, 0.6401, 'won'), leg('lv', 19467, 0.5975, 'won'), leg('lvo40', 19467, 0.5103, 'push')],
  meta: {},
});
// 019f43af: team total won + other game's total PUSH, booked -747 with no PX profit.
const row43af = () => ({
  parlay_id: '019f43af-76e0-7df0-9978-4335a547d8ab', status: 'settled_lost', pnl: -747,
  confirmed_odds: -249, confirmed_stake: 747,
  legs: [leg('bal-tt', 10078672, 0.5541, 'won'), leg('hou-o10', 10078665, 0.4943, 'push')],
  meta: {},
});

test('the built-in id list is the 15 same-game push rows + 019f43af', () => {
  assert.equal(rec.WON_WITH_PUSH_BOOKED_PUSH.length, 15);
  assert.deepEqual(rec.LOST_WITH_PUSH_FULL_STAKE, ['019f43af-76e0-7df0-9978-4335a547d8ab']);
  assert.equal(new Set(rec.DEFAULT_IDS).size, 16);
});

test('PX agrees (push, profit 0) -> nothing to do; the audit figure is shown, not written', () => {
  const p = rec.planRow(row09baf(), { settlement_status: 'push', profit: 0, legs: [] });
  assert.equal(p.action, 'none');
  assert.equal(p.rule.basis, 'same_game_void');
  assert.ok(Math.abs(p.auditHypothesisPnl - -2225.67) < 0.01, `audit hypothesis ${p.auditHypothesisPnl}`);
});

test('PX push with a null profit is a refund, not a missing number', () => {
  assert.equal(rec.planRow(row09baf(), { settlement_status: 'push', profit: null }).action, 'none');
});

test('PX disagrees -> corrected is PX\'s own status and profit', () => {
  const p = rec.planRow(row09baf(), { settlement_status: 'lost', profit: -2225.67 });
  assert.equal(p.action, 'update');
  assert.deepEqual(p.corrected, { status: 'settled_lost', pnl: -2225.67, settlementResult: 'lost' });
});

test('019f43af: PX reduced profit -> update; PX full stake -> none; PX no profit -> never write an estimate', () => {
  assert.equal(rec.planRow(row43af(), { settlement_status: 'lost', profit: -229.01 }).action, 'update');
  assert.equal(rec.planRow(row43af(), { settlement_status: 'lost', profit: -747 }).action, 'none');
  const p = rec.planRow(row43af(), { settlement_status: 'lost', profit: null });
  assert.equal(p.action, 'px_no_profit');
  assert.equal(p.corrected, null);
  assert.ok(Math.abs(p.auditHypothesisPnl - -229.01) < 0.005);
});

test('missing / unsettled PX order -> reported, never corrected', () => {
  assert.equal(rec.planRow(row43af(), null).action, 'px_missing');
  assert.equal(rec.planRow(row43af(), { settlement_status: 'tbd' }).action, 'px_not_settled');
});

test('PX leg statuses override ours when planning', () => {
  const r = row43af();
  r.legs[1] = { ...r.legs[1], settlementStatus: undefined, settlement_status: undefined };
  const merged = rec.mergedLegs(r, { legs: [{ line_id: 'hou-o10', settlement_status: 'push' }] });
  assert.equal(merged[1].settlementStatus, 'push');
  assert.equal(rec.planRow(r, { settlement_status: 'lost', profit: -229.01, legs: [{ line_id: 'hou-o10', settlement_status: 'push' }] }).rule.basis, 'void_reduced');
});

test('write guard: without --apply every write method throws; reads pass through', () => {
  const calls = [];
  const fake = { from: () => ({ select: () => calls.push('select') && 'sel', update: () => calls.push('update') }) };
  for (const guarded of [rec.guardedClient(fake, false), est.guardedClient(fake, false)]) {
    assert.equal(guarded.from('parlay_orders').select('*'), 'sel');
    for (const m of ['update', 'insert', 'upsert', 'delete']) {
      assert.throws(() => guarded.from('parlay_orders')[m]({}), /dry-run: refused/);
    }
  }
  assert.ok(!calls.includes('update'), 'the underlying update must never be reached in dry-run');
  rec.guardedClient(fake, true).from('parlay_orders').update({});
  assert.ok(calls.includes('update'));
});

test('--apply is read from argv only', () => {
  assert.equal(rec.parseArgs([]).apply, false);
  assert.equal(rec.parseArgs(['--ids', 'a,b']).apply, false);
  assert.equal(rec.parseArgs(['--apply']).apply, true);
  assert.equal(est.parseArgs(['--recompute']).apply, false);
});

// ---------------------------------------------------------------------------
// restored-fair estimates
// ---------------------------------------------------------------------------

const T = '2026-09-25T14:59:53Z';
const q = (parlay_id, quoted_at, legs, meta = {}) => ({ parlay_id, quoted_at, legs, meta });

test('offered prob comes from confirmed odds exactly (SP -596 = bettor +596)', () => {
  assert.equal(est.offeredProbFromConfirmedOdds(-596), Math.round(100 / 696 * 100000) / 100000);
  assert.equal(est.offeredProbFromConfirmedOdds(150), Math.round(0.6 * 100000) / 100000);
  assert.equal(est.offeredProbFromConfirmedOdds(50), null);
});

test('leg fair = nearest quote on the same lineId, either side; skips the fill, estimates and restores', () => {
  const cands = [
    q('far-before', '2026-09-25T06:00:00Z', [leg('L1', 1, 0.40)]),
    q('near-after', '2026-09-25T16:40:00Z', [leg('L1', 1, 0.44)]),
    q('self', T, [leg('L1', 1, 0.99)]),
    q('estimated', '2026-09-25T15:00:00Z', [leg('L1', 1, 0.98)], { fairEstimated: true }),
    q('restored', '2026-09-25T15:01:00Z', [leg('L1', 1, 0.97)], { pxBackfill: true }),
  ];
  const hit = est.nearestLegFair('L1', Date.parse(T), cands, new Set(['self']));
  assert.equal(hit.parlayId, 'near-after');
  assert.equal(hit.fairProb, 0.44);
});

test('cross-game row: fair = product of leg estimates, gaps recorded', () => {
  const row = { parlay_id: 'R1', confirmed_at: T, confirmed_odds: -500, legs: [leg('A', 1, null, 'won'), leg('B', 2, null, 'won')], meta: {} };
  const legC = { A: [q('qa', '2026-09-25T16:40:00Z', [leg('A', 1, 0.5)])], B: [q('qb', '2026-09-25T06:30:00Z', [leg('B', 2, 0.4)])] };
  const e = est.buildEstimate(row, legC, {});
  assert.equal(e.status, 'complete');
  assert.equal(e.fairParlayProb, 0.2);
  assert.equal(e.maxGapMin, Math.round((Date.parse(T) - Date.parse('2026-09-25T06:30:00Z')) / 60000));
  assert.ok(e.legs.every(l => l.fairEstimated === true));
});

test('same-game group takes its correlation factor from a quote holding exactly that group', () => {
  // Rutgers -42.5 + O56.5 shape: the pricer charged a factor, not independence.
  const row = { parlay_id: 'R2', confirmed_at: T, confirmed_odds: -233, legs: [leg('SP', 9, null, 'won'), leg('TO', 9, null, 'won')], meta: {} };
  const legC = { SP: [q('q1', '2026-09-25T05:00:00Z', [leg('SP', 9, 0.5)])], TO: [q('q2', '2026-09-25T05:00:00Z', [leg('TO', 9, 0.5)])] };
  const groupQuote = q('sgp', '2026-09-25T04:00:00Z', [leg('SP', 9, 0.5), leg('TO', 9, 0.5)], { fairParlayProb: 0.2925 }); // 0.25 x 1.17
  const decoy = q('two-groups', '2026-09-25T14:00:00Z', [leg('SP', 9, 0.5), leg('TO', 9, 0.5), leg('X', 7, 0.5), leg('Y', 7, 0.5)], { fairParlayProb: 0.1 });
  const e = est.buildEstimate(row, legC, { 'SP|TO': [decoy, groupQuote] });
  assert.equal(e.groups[0].factor, 1.17);
  assert.equal(e.groups[0].from.parlayId, 'sgp');
  assert.equal(e.fairParlayProb, 0.2925);
});

test('no quote for the group factor -> leg fairs only, fairParlayProb left null', () => {
  const row = { parlay_id: 'R3', confirmed_at: T, confirmed_odds: -233, legs: [leg('SP', 9, null, 'won'), leg('TO', 9, null, 'won')], meta: {} };
  const legC = { SP: [q('q1', '2026-09-25T05:00:00Z', [leg('SP', 9, 0.5)])], TO: [q('q2', '2026-09-25T05:00:00Z', [leg('TO', 9, 0.5)])] };
  const e = est.buildEstimate(row, legC, {});
  assert.equal(e.status, 'partial_missing_sgp_factor');
  assert.equal(e.fairParlayProb, null);
  assert.ok(e.legs.every(l => l.fairProb === 0.5));
});

test('a leg with no quote in the window -> partial, fairParlayProb null', () => {
  const row = { parlay_id: 'R4', confirmed_at: T, confirmed_odds: -300, legs: [leg('A', 1, null, 'won'), leg('Z', 2, null, 'won')], meta: {} };
  const e = est.buildEstimate(row, { A: [q('qa', T, [leg('A', 1, 0.5)])] }, {});
  assert.equal(e.status, 'partial_missing_legs');
  assert.deepEqual(e.missingLegs, ['Z']);
  assert.equal(e.fairParlayProb, null);
});
