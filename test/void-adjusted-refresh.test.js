// Void-adjusted fair freshness (2026-10-21 perf review). It was stamped once at
// settlement — a parlay settled early on a lost leg still had 'tbd' legs, and a
// leg that voided afterwards never reached it (253 of 355 void-leg tickets stale
// or missing, stale in the direction of the outcome).
// Run: node --test test/void-adjusted-refresh.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const ot = require('../services/order-tracker');

test('a leg that voids AFTER an early (any_leg_lost) settlement updates the void-adjusted fair', () => {
  const id = 'va-' + Date.now(), uuid = id + '-u';
  const legs = [
    { lineId: 'va1', team: 'A', market: 'moneyline', fairProb: 0.5, pxEventId: 'VA1' },
    { lineId: 'va2', team: 'B', market: 'moneyline', fairProb: 0.4, pxEventId: 'VA2' },
  ];
  ot.recordQuote(id, legs, 400, 5000, 0.2, { legs });
  ot.recordConfirmation(id, uuid, -400, 1000);
  ot.recordLegSettlement(uuid, { line_id: 'va1', settlement_status: 'lost' }, { persist: false });
  const o = ot.recordSettlement(uuid, 'won', 250, { trusted: true });     // SP won early: va2 still tbd
  assert.strictEqual(o.meta.voidAdjustedFairProb, 0.2, 'no void leg yet -> raw fair');
  ot.recordLegSettlement(uuid, { line_id: 'va2', settlement_status: 'push' }, { persist: false });
  assert.ok(Math.abs(o.meta.voidAdjustedFairProb - 0.5) < 1e-9, `void leg divided out after settlement (got ${o.meta.voidAdjustedFairProb})`);
  assert.strictEqual(o.meta.voidLegCount, 1);
});

test('calibration recomputes from current leg statuses instead of trusting a stale stored value', () => {
  const id = 'va2-' + Date.now(), uuid = id + '-u';
  const legs = [
    { lineId: 'vb1', team: 'A', market: 'moneyline', fairProb: 0.5, pxEventId: 'VB1' },
    { lineId: 'vb2', team: 'B', market: 'moneyline', fairProb: 0.5, pxEventId: 'VB2' },
  ];
  ot.recordQuote(id, legs, 300, 5000, 0.25, { legs });
  ot.recordConfirmation(id, uuid, -300, 1000);
  const o = ot.recordSettlement(uuid, 'won', 330, { trusted: true });
  const band = (cal, b) => ((cal.byBand || []).find(x => x.band === b) || { n: 0 }).n;
  const before = ot.getVoidAdjustedCalibration(30);
  // a leg turns void WITHOUT going through recordLegSettlement; the stored value stays stale at 0.25
  for (const src of [o.meta.legs, o.legs]) for (const l of (src || [])) if (l.lineId === 'vb2') l.settlementStatus = 'push';
  assert.strictEqual(o.meta.voidAdjustedFairProb, 0.25, 'stored value is stale');
  const after = ot.getVoidAdjustedCalibration(30);
  assert.strictEqual(band(after, '0.35-0.6') - band(before, '0.35-0.6'), 1, 'recomputed to 0.5 from the current legs');
  assert.strictEqual(band(before, '0.2-0.35') - band(after, '0.2-0.35'), 1, 'and no longer counted at the stale 0.25');
});

test('the settlement poll applies a late leg void to an ALREADY-settled order and saves only when it moved the fair', async () => {
  const db = require('../services/db');
  const saves = [];
  const savedSave = db.saveOrder;
  db.saveOrder = async (o) => { saves.push(o.parlayId); return 'saved'; };
  try {
    const id = 'vp-' + Date.now(), uuid = id + '-u';
    const legs = [
      { lineId: 'vp1', team: 'A', market: 'moneyline', fairProb: 0.5, pxEventId: 'VP1' },
      { lineId: 'vp2', team: 'B', market: 'moneyline', fairProb: 0.4, pxEventId: 'VP2' }];
    ot.recordQuote(id, legs, 400, 5000, 0.2, { legs });
    ot.recordConfirmation(id, uuid, -400, 1000);
    ot.recordLegSettlement(uuid, { line_id: 'vp1', settlement_status: 'lost' }, { persist: false });
    ot.recordSettlement(uuid, 'won', 250, { trusted: true });
    // the poll only runs while some order is still open
    const oid = 'vp-open-' + Date.now();
    ot.recordQuote(oid, legs, 400, 5000, 0.2, { legs });
    ot.recordConfirmation(oid, oid + '-u', -400, 100);
    const px = { fetchOrders: async () => [
      { order_uuid: uuid, p_id: id, settlement_status: 'won', profit: 250, legs: [{ line_id: 'vp1', settlement_status: 'lost' }, { line_id: 'vp2', settlement_status: 'push' }] }] };
    saves.length = 0;
    await ot.pollOrderSettlements(px);
    const o = ot.findByParlayId(id);
    assert.ok(Math.abs(o.meta.voidAdjustedFairProb - 0.5) < 1e-9, `late void applied (got ${o.meta.voidAdjustedFairProb})`);
    assert.ok(saves.includes(id), 'saved once the fair moved');
    saves.length = 0;
    await ot.pollOrderSettlements(px);
    assert.ok(!saves.includes(id), 'nothing changed -> not saved again');
  } finally { db.saveOrder = savedSave; }
});
