// The per-leg consensus floor must read the book price for the REQUESTED
// point on every spread/total family, not only full-game (2026-10-03 audit:
// ATL F5 +0.5/+1.5/+2.5 all floored to FD -148 off the F5 main line).
// Run: node --test test/consensus-floor-point.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const of = require('../services/odds-feed');

const spreadMkt = { line: -0.5, home: { point: -0.5 }, away: { point: 0.5 } };
const totalMkt = { line: 4.5 };

for (const mt of ['spreads', 'spreads_f5', 'spreads_h1', 'spreads_q1']) {
  test(`${mt}: main point matches, alt points do not`, () => {
    assert.strictEqual(of.lineMatchesPrimary(spreadMkt, mt, -0.5, 'home'), true);
    assert.strictEqual(of.lineMatchesPrimary(spreadMkt, mt, -1.5, 'home'), false);
    assert.strictEqual(of.lineMatchesPrimary(spreadMkt, mt, 2.5, 'away'), false);
    assert.strictEqual(of.lineMatchesPrimary(spreadMkt, mt, -0.5, 'away'), false, 'same magnitude, wrong direction');
  });
}
for (const mt of ['totals', 'totals_f5', 'totals_h1', 'totals_q1']) {
  test(`${mt}: main point matches, alt points do not`, () => {
    assert.strictEqual(of.lineMatchesPrimary(totalMkt, mt, 4.5, 'over'), true);
    assert.strictEqual(of.lineMatchesPrimary(totalMkt, mt, 5.5, 'over'), false);
    assert.strictEqual(of.lineMatchesPrimary(totalMkt, mt, null, 'over'), false);
  });
}
test('point-less markets are unaffected', () => {
  for (const mt of ['h2h', 'h2h_f5', 'h2h_h1']) assert.strictEqual(of.lineMatchesPrimary({}, mt, null, 'home'), true);
});
