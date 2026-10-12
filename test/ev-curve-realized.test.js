// Rolling P&L vs EV banked — realized P&L must count EVERY settled ticket
// (2026-10-11). Tickets with no stored EV (PX-restored / backfilled rows) were
// skipped P&L and all: the 30d chart read +$7,548 while the book was -$1,957
// (94 such tickets, -$11.4K). Missing EV is now estimated from fair + odds, else
// counted as 0 — the realized line always includes the P&L.
// Run: node --test test/ev-curve-realized.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const ot = require('../services/order-tracker');

let seq = 0;
function settle(confirmedOdds, stake, result, pnlOverride, opts = {}) {
  const id = 'evc-' + (++seq), uuid = 'evc-uuid-' + seq;
  const legs = [{ lineId: 'evl' + seq, team: 'T', market: 'moneyline', fairProb: 0.5, pxEventId: 1 + seq }];
  ot.recordQuote(id, legs, -confirmedOdds, 5000, opts.fair != null ? opts.fair : 0.2, { legs });
  ot.recordConfirmation(id, uuid, confirmedOdds, stake);
  ot.recordSettlement(uuid, result, pnlOverride, { trusted: true });
  const o = ot.findByParlayId(id);
  if (opts.dropEv) { delete o.expectedValue; if (o.meta) delete o.meta.expectedValue; }
  if (opts.dropFair) { o.fairParlayProb = null; }
  return o;
}

test('realized P&L includes tickets with no stored EV; EV is estimated or counted as 0', () => {
  const before = ot.getEvCurve(30);
  const a = settle(-400, 100, 'won', 25);                                   // normal, has EV
  const b = settle(-233, 5811, 'lost', -5811, { dropEv: true, fair: 0.25 }); // no EV, fair known -> estimated
  const c = settle(-211, 4098, 'lost', -4098, { dropEv: true, dropFair: true }); // no EV, no fair -> EV 0
  const after = ot.getEvCurve(30);
  const dPnl = Math.round((after.realized - before.realized) * 100) / 100;
  assert.equal(dPnl, Math.round((a.pnl + b.pnl + c.pnl) * 100) / 100, 'every settled ticket counts in realized P&L');
  assert.equal(after.n - before.n, 3);
  assert.equal(after.skipped - before.skipped, 2);
  assert.equal(after.evEstimated - before.evEstimated, 1);
  assert.equal(after.evMissing - before.evMissing, 1);
  assert.equal(Math.round(after.missingPnl - before.missingPnl), -4098);
});
