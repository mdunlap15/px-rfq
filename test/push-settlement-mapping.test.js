// How ProphetX grades a parlay with a void/push leg — and how we book it.
//
// The 2026-09-27 audit flagged 15 "won-with-a-push" tickets booked settled_push
// with pnl 0 and proposed re-booking them as reduced-odds bettor wins. The data
// says the booking is RIGHT: all 15 contain a same-game group, and PX voids the
// WHOLE parlay when any leg pushes in one (15/15), while the 191 won-with-a-push
// parlays with no same-game group all settled 'lost' at a reduced payout (191/191).
// These tests pin that rule so nobody "fixes" the 15 into a loss that PX never
// charged us.
//
// The real defect was the other side: a 'lost' settlement arriving with NO PX
// profit fell back to -confirmedStake even when a leg had pushed — 019f43af was
// booked -$747 for what the rule prices at -$229.01. Now it is sized from the
// per-leg probabilities we sent PX at confirm (cent-exact on 81% of the 140
// post-6/26 won-with-a-push tickets PX reported a profit for).
//
// Fixtures are real parlay_orders rows (ids in the test names).
// Run: node --test test/push-settlement-mapping.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const ps = require('../services/parlay-settlement');
const ot = require('../services/order-tracker');
const pricer = require('../services/pricer');

const PAST = '2026-07-08T22:35:00Z';
const leg = (lineId, pxEventId, fairProb, settlementStatus, extra = {}) => ({
  lineId, line_id: lineId, pxEventId, fairProb, settlementStatus, settlement_status: settlementStatus,
  team: 'T-' + lineId, market: 'total', sport: 'baseball_mlb', startTime: PAST, ...extra,
});

// 019f43af-76e0: MLB team total (won) + a DIFFERENT game's total 10 (push). No
// same-game group. R=$747 at SP -249 (bettor +249, stake $300). No PX profit arrived.
const L_019f43af = () => [
  leg('a-orioles-tt', 10078672, 0.5541, 'won', { market: 'team_total' }),
  leg('a-hou-was-o10', 10078665, 0.4943, 'push'),
];
// 01a09baf-119c: 3 NFL moneylines (won) + Raiders total 40 (PUSH) on the SAME game
// as the Raiders ML. R=$5,120.92 at SP -543. PX: push, profit 0.
const L_01a09baf = () => [
  leg('b-pit-ml', 19464, 0.7209, 'won', { market: 'moneyline', sport: 'americanfootball_nfl' }),
  leg('b-cin-ml', 19459, 0.6401, 'won', { market: 'moneyline', sport: 'americanfootball_nfl' }),
  leg('b-lv-ml', 19467, 0.5975, 'won', { market: 'moneyline', sport: 'americanfootball_nfl' }),
  leg('b-lv-o40', 19467, 0.5103, 'push', { sport: 'americanfootball_nfl' }),
];
// 01a09112-25ab: Cubs ML + Cubs game over 8 (both won — the same-game pair) and a
// push on ANOTHER game (Rockies@Tigers u8). PX still voided the whole parlay.
const L_01a09112 = () => [
  leg('c-chc-ml', 10079494, 0.6384, 'won', { market: 'moneyline' }),
  leg('c-chc-o8', 10079494, 0.516, 'won'),
  leg('c-col-det-u8', 10079496, 0.5023, 'push'),
];

// ---------------------------------------------------------------------------
// The measured PX rule
// ---------------------------------------------------------------------------

test('rule: a lost leg with a push and NO same-game group -> SP won (17/17 since 9/26)', () => {
  const r = ps.expectedPxSettlement([leg('x', 1, 0.5, 'lost'), leg('y', 3, 0.5, 'push'), leg('z', 2, 0.5, 'won')]);
  assert.equal(r.result, 'won');
  assert.equal(r.basis, 'any_leg_lost');
});

// 2026-10-07: PX settled push on 20/20 parlays holding a same-game group + a
// void leg + a LOST leg (no counterexample in 608 settlements since 9/26). The
// old rule ranked any_leg_lost first, and reconcileSettlements re-booked those
// PX pushes as SP wins every ~5 min, fighting the settlement poll.
// 01a10790-e190: GB@TB over 39.5 + GB -3 on the SAME game; GB won by 3 (push).
const L_01a10790 = () => [
  leg('d-gb-tb-o395', 50001, 0.4885, 'lost', { sport: 'americanfootball_nfl' }),
  leg('d-gb-m3', 50001, 0.4964, 'push', { market: 'spread', sport: 'americanfootball_nfl' }),
];
// 01a10333-d23e: Braves ML + over 8 on Braves@Dodgers (8 runs: push), Rays ML, Padres ML.
const L_01a10333 = () => [
  leg('e-atl-ml', 60001, 0.3353, 'lost', { market: 'moneyline' }),
  leg('e-atl-lad-o8', 60001, 0.5148, 'push'),
  leg('e-tb-ml', 60002, 0.5523, 'won', { market: 'moneyline' }),
  leg('e-sd-ml', 60003, 0.3508, 'lost', { market: 'moneyline' }),
];

test('rule: a push in a parlay holding a same-game group voids it EVEN WHEN a leg lost (01a10790, 01a10333)', () => {
  for (const legs of [L_01a10790(), L_01a10333()]) {
    const r = ps.expectedPxSettlement(legs);
    assert.equal(r.result, 'push');
    assert.equal(r.basis, 'same_game_void');
  }
  // the void leg OUTSIDE the same-game group counts too (4 of the 20)
  const r2 = ps.expectedPxSettlement([leg('p', 1, 0.5, 'won'), leg('q', 1, 0.5, 'lost'), leg('r', 2, 0.5, 'void')]);
  assert.equal(r2.result, 'push');
});

test('PX push on a lost+push same-game parlay is NOT flagged and reconcileSettlements never flips it to won', () => {
  const { id, uuid } = book(L_01a10790(), -302, 145.62);
  ot.recordSettlement(uuid, 'push', 0, { trusted: true });
  let o = ot.findByParlayId(id);
  assert.equal(o.status, 'settled_push');
  assert.equal(o.meta.pxSettlementRuleMismatch, undefined, 'PX push here IS the rule');
  ot.reconcileSettlements();
  o = ot.findByParlayId(id);
  assert.equal(o.status, 'settled_push', 'reconcile must not derive "won" over PX');
  assert.equal(o.pnl, 0);
});

test('rule: won + push with NO same-game group -> SP lost at reduced odds (191/191 measured)', () => {
  const r = ps.expectedPxSettlement(L_019f43af());
  assert.equal(r.result, 'lost');
  assert.equal(r.basis, 'void_reduced');
  assert.equal(r.voidLegs, 1);
});

test('rule: won + push INSIDE a same-game group -> PX voids the whole parlay (01a09baf)', () => {
  const r = ps.expectedPxSettlement(L_01a09baf());
  assert.equal(r.result, 'push');
  assert.equal(r.basis, 'same_game_void');
});

test('rule: the void leg need not be in the same-game group — any SGP in the parlay voids it (01a09112)', () => {
  const r = ps.expectedPxSettlement(L_01a09112());
  assert.equal(r.sameGame, true);
  assert.equal(r.result, 'push');
  assert.equal(r.basis, 'same_game_void');
});

test('rule: all won -> SP lost full; all void -> push; unresolved -> null', () => {
  assert.equal(ps.expectedPxSettlement([leg('x', 1, 0.5, 'won'), leg('y', 1, 0.5, 'won')]).basis, 'all_legs_won');
  assert.equal(ps.expectedPxSettlement([leg('x', 1, 0.5, 'push'), leg('y', 2, 0.5, 'void')]).result, 'push');
  const inc = ps.expectedPxSettlement([leg('x', 1, 0.5, 'won'), leg('y', 2, 0.5, null)]);
  assert.equal(inc.result, null);
  assert.equal(inc.basis, 'incomplete');
});

test('pxOnly ignores our scraped inferredResult', () => {
  const legs = [leg('x', 1, 0.5, 'won'), { lineId: 'y', pxEventId: 2, fairProb: 0.5, inferredResult: 'push' }];
  assert.equal(ps.expectedPxSettlement(legs).result, 'lost');
  assert.equal(ps.expectedPxSettlement(legs, { pxOnly: true }).result, null);
});

test('same-game detection keys on PX sport_event_id, ignoring missing ids', () => {
  assert.equal(ps.hasSameGameGroup([{ pxEventId: 1 }, { pxEventId: 2 }]), false);
  assert.equal(ps.hasSameGameGroup([{ pxEventId: 1 }, { sport_event_id: 1 }]), true);
  assert.equal(ps.hasSameGameGroup([{ pxEventId: null }, { pxEventId: null }]), false);
});

// ---------------------------------------------------------------------------
// Reduced payout = PX's own number (real PX profits)
// ---------------------------------------------------------------------------

test('reduced payout reproduces PX to the cent: 019f23f8 (PX profit -181.00)', () => {
  const r = ps.reducedPayoutLoss({
    legs: [leg('s', 90086990, 0.6751, 'won'), leg('c', 90086989, 0.5519, 'push'), leg('w', 90086991, 0.5071, 'won')],
    confirmedOdds: -400, confirmedStake: 400,
  });
  assert.equal(r.loss, 181.00);
  assert.equal(r.method, 'confirm_distribution');
});

test('reduced payout reproduces PX to the cent: 019f20c8 (PX profit -27.00)', () => {
  const r = ps.reducedPayoutLoss({
    legs: [leg('s', 90086990, 0.6429, 'won'), leg('p', 90086989, 0.4104, 'push'), leg('a', 90086991, 0.6987, 'won')],
    confirmedOdds: -393, confirmedStake: 98.25,
  });
  assert.equal(r.loss, 27.00);
});

test('reduced payout with two pushes and a short price: 019f224c (PX profit -0.87)', () => {
  const r = ps.reducedPayoutLoss({
    legs: [leg('col', 90086993, 0.828, 'won'), leg('arg', 90086992, 0.944, 'push'), leg('egy', 90086994, 0.5747, 'push')],
    confirmedOdds: -105, confirmedStake: 5.25,
  });
  assert.equal(r.loss, 0.87);
  assert.equal(r.voidLegs, 2);
});

test('no void leg -> the loss is exactly our risk; all void -> 0', () => {
  assert.equal(ps.reducedPayoutLoss({ legs: [leg('x', 1, 0.5, 'won'), leg('y', 2, 0.5, 'won')], confirmedOdds: -300, confirmedStake: 90 }).loss, 90);
  assert.equal(ps.reducedPayoutLoss({ legs: [leg('x', 1, 0.5, 'push'), leg('y', 2, 0.5, 'push')], confirmedOdds: -300, confirmedStake: 90 }).loss, 0);
});

test('unusable stake/odds or leg probs -> null (caller keeps its fallback)', () => {
  assert.equal(ps.reducedPayoutLoss({ legs: L_019f43af(), confirmedOdds: 50, confirmedStake: 747 }), null);
  assert.equal(ps.reducedPayoutLoss({ legs: L_019f43af(), confirmedOdds: -249, confirmedStake: 0 }), null);
  const noProb = L_019f43af().map(l => ({ ...l, fairProb: null }));
  assert.equal(ps.reducedPayoutLoss({ legs: noProb, confirmedOdds: -249, confirmedStake: 747 }), null);
  // ...but the stored quote-time legConfirmProb is an accepted second source
  const stored = L_019f43af().map((l, i) => ({ ...l, fairProb: null, legConfirmProb: [0.566988, 0.505756][i] }));
  assert.equal(ps.reducedPayoutLoss({ legs: stored, confirmedOdds: -249, confirmedStake: 747 }).method, 'stored_leg_confirm');
});

test('confirm-time leg probs mirror pricer.distributeLegProbs (what websocket.js sends PX)', () => {
  for (const [base, odds] of [[[0.5541, 0.4943], -249], [[0.6751, 0.5519, 0.5071], -400], [[0.828, 0.944, 0.5747], -105], [[0.31], 180]]) {
    const b = -odds;
    const target = 1 / (b > 0 ? 1 + b / 100 : 1 + 100 / -b);
    const mine = ps.confirmLegProbs(base.map(p => ({ fairProb: p })), odds).probs;
    const theirs = pricer.distributeLegProbs(base, target);
    mine.forEach((p, i) => assert.ok(Math.abs(p - theirs[i]) < 1e-12, `leg ${i}: ${p} vs ${theirs[i]}`));
  }
});

// ---------------------------------------------------------------------------
// recordSettlement — the booking
// ---------------------------------------------------------------------------

let seq = 0;
function book(legs, confirmedOdds, confirmedStake) {
  const id = 'push-map-' + (++seq), uuid = 'push-map-uuid-' + seq;
  ot.recordQuote(id, legs, -confirmedOdds, 5000, 0.2, { legs });
  ot.recordConfirmation(id, uuid, confirmedOdds, confirmedStake);
  return { id, uuid };
}

test('019f43af: SP lost with a push leg and NO PX profit books the reduced payout, not -stake', () => {
  const { id, uuid } = book(L_019f43af(), -249, 747);
  ot.recordSettlement(uuid, 'lost', 0, { trusted: true });
  const o = ot.findByParlayId(id);
  assert.equal(o.status, 'settled_lost');
  assert.ok(Math.abs(o.pnl - -229.01) < 0.005, `pnl ${o.pnl} — was -747 before the fix`);
  assert.match(o.meta.pnlSource, /^derived_void_reduced/);
  assert.equal(o.meta.settlementBasis, 'void_reduced');
  assert.equal(o.meta.pxSettlementRuleMismatch, undefined);
});

test('SP lost WITH a PX profit: PX is authoritative, no estimate stamped', () => {
  const { id, uuid } = book(L_019f43af(), -249, 747);
  ot.recordSettlement(uuid, 'lost', -229.01, { trusted: true });
  const o = ot.findByParlayId(id);
  assert.equal(o.pnl, -229.01);
  assert.equal(o.meta.pnlSource, undefined);
});

test('SP lost with no void leg and no PX profit still books -stake (unchanged)', () => {
  const legs = [leg('n1', 501, 0.55, 'won'), leg('n2', 502, 0.5, 'won')];
  const { id, uuid } = book(legs, -250, 300);
  ot.recordSettlement(uuid, 'lost', 0, { trusted: true });
  const o = ot.findByParlayId(id);
  assert.equal(o.pnl, -300);
  assert.equal(o.meta.pnlSource, undefined);
  assert.equal(o.meta.settlementBasis, 'all_legs_won');
});

test('01a09baf: PX push on a same-game won+push parlay stays push/$0 — the refund PX actually made', () => {
  const { id, uuid } = book(L_01a09baf(), -543, 5120.92);
  ot.recordSettlement(uuid, 'push', 0, { trusted: true });
  const o = ot.findByParlayId(id);
  assert.equal(o.status, 'settled_push');
  assert.equal(o.pnl, 0);
  assert.equal(o.meta.settlementBasis, 'same_game_void');
  assert.equal(o.meta.pxSettlementRuleMismatch, undefined, 'PX push here IS the rule, not an anomaly');
});

test('01a09112: push elsewhere in a parlay holding a same-game pair is also a clean same_game_void', () => {
  const { id, uuid } = book(L_01a09112(), -465, 71.89);
  ot.recordSettlement(uuid, 'push', 0, { trusted: true });
  const o = ot.findByParlayId(id);
  assert.equal(o.pnl, 0);
  assert.equal(o.meta.settlementBasis, 'same_game_void');
  assert.equal(o.meta.pxSettlementRuleMismatch, undefined);
});

test('a PX result that BREAKS the rule is booked as PX says but flagged', () => {
  // PX 'push' on a won+push parlay with no same-game group has never been seen
  // (0/191); if it happens, record PX's cash outcome and surface it.
  const { id, uuid } = book(L_019f43af(), -249, 747);
  ot.recordSettlement(uuid, 'push', 0, { trusted: true });
  const o = ot.findByParlayId(id);
  assert.equal(o.status, 'settled_push');
  assert.equal(o.pnl, 0);
  assert.deepEqual(o.meta.pxSettlementRuleMismatch, { expected: 'lost', basis: 'void_reduced', got: 'push' });
});

test('settlement poll backfills PX leg statuses BEFORE settling, so a profit-less lost is sized right', async () => {
  // Our copy has NO leg statuses yet; PX's order carries them. The poll used to
  // settle first and backfill after, so the fallback could not see the push.
  const bare = L_019f43af().map(l => ({ ...l, settlementStatus: undefined, settlement_status: undefined }));
  const { id, uuid } = book(bare, -249, 747);
  const fakePx = {
    fetchOrders: async () => [{
      order_uuid: uuid, p_id: id, settlement_status: 'lost', profit: null,
      legs: [
        { line_id: 'a-orioles-tt', settlement_status: 'won' },
        { line_id: 'a-hou-was-o10', settlement_status: 'push' },
      ],
    }],
  };
  await ot.pollOrderSettlements(fakePx);
  const o = ot.findByParlayId(id);
  assert.equal(o.status, 'settled_lost');
  assert.ok(Math.abs(o.pnl - -229.01) < 0.005, `pnl ${o.pnl}`);
  assert.equal(o.meta.settlementBasis, 'void_reduced');
});
