// Longshot vig floor — VIG_MIN_PP (distance) + VIG_MIN_ROI (return-on-risk),
// applied as a union. The multiplicative vig stack collapses to ~0pp of margin
// on longshots while books carry +1.3-2.4pp there; these floors put a hard
// minimum under the offered price. Both default OFF.
//
// This tests the arithmetic of the floor rule in isolation (the pricer applies
// exactly this Math.max union). Run: npm test
//
//   ROI on risk = (op - fp)/(1 - op) = R  <=>  op = (fp + R)/(1 + R)

const { test } = require('node:test');
const assert = require('node:assert');

// Mirror of the pricer's union rule.
function applyFloor(offered, fair, minPp, minRoi) {
  if (!(fair > 0 && fair < 1) || (minPp <= 0 && minRoi <= 0)) return { offered, add: 0, which: null };
  const ppFloor = minPp > 0 ? fair + minPp / 100 : 0;
  const roiFloor = minRoi > 0 ? (fair + minRoi) / (1 + minRoi) : 0;
  const floor = Math.max(ppFloor, roiFloor);
  if (floor > offered) {
    const capped = Math.min(0.99, floor);
    return { offered: capped, add: capped - offered, which: roiFloor >= ppFloor ? 'roi' : 'pp' };
  }
  return { offered, add: 0, which: null };
}

test('both floors off is a no-op', () => {
  const r = applyFloor(0.021, 0.02, 0, 0);
  assert.equal(r.offered, 0.021);
  assert.equal(r.add, 0);
});

test('pp floor lifts a longshot that priced too close to fair', () => {
  // fair 2%, stack landed at 2.1% (0.1pp). A 0.4pp floor lifts it to 2.4%.
  const r = applyFloor(0.021, 0.02, 0.4, 0);
  assert.ok(Math.abs(r.offered - 0.024) < 1e-9, 'got ' + r.offered);
  assert.equal(r.which, 'pp');
  assert.ok(r.add > 0);
});

test('pp floor never LOWERS an already-wide price', () => {
  // stack already at 3%, well above fair+0.4pp=2.4% -> untouched
  const r = applyFloor(0.03, 0.02, 0.4, 0);
  assert.equal(r.offered, 0.03);
  assert.equal(r.add, 0);
});

test('ROI floor enforces a minimum return on risk', () => {
  // fair 25%, want ROI >= 1% -> op = (0.25 + 0.01)/1.01 = 0.257426
  const r = applyFloor(0.252, 0.25, 0, 0.01);
  const want = (0.25 + 0.01) / 1.01;
  assert.ok(Math.abs(r.offered - want) < 1e-9, 'got ' + r.offered + ' want ' + want);
  assert.equal(r.which, 'roi');
  // verify it actually delivers the target ROI
  const roi = (r.offered - 0.25) / (1 - r.offered);
  assert.ok(Math.abs(roi - 0.01) < 1e-6, 'ROI on risk should be 1%, got ' + roi);
});

test('union takes whichever floor binds harder', () => {
  // Big pp vs small ROI on a longshot -> pp wins.
  //   fair 2%: ppFloor 0.02+0.01=0.03 ; roiFloor (0.02+0.0075)/1.0075=0.0273
  const ppWins = applyFloor(0.02, 0.02, 1.0, 0.0075);
  assert.equal(ppWins.which, 'pp');
  assert.ok(Math.abs(ppWins.offered - 0.03) < 1e-9);
  // Small pp vs bigger ROI on a shorter price -> ROI wins.
  //   fair 40%: ppFloor 0.402 ; roiFloor (0.40+0.01)/1.01=0.40594
  const roiWins = applyFloor(0.40, 0.40, 0.2, 0.01);
  assert.equal(roiWins.which, 'roi');
});

test('for op < ~0.10 the two floors nearly coincide (deep-dive claim)', () => {
  // R and R-as-pp are within ~10% in the longshot zone. Set pp = 100*R and
  // check the two floors land within that tolerance at fair 5%.
  const R = 0.006;
  const pp = applyFloor(0.05, 0.05, 100 * R, 0).offered;
  const roi = applyFloor(0.05, 0.05, 0, R).offered;
  assert.ok(Math.abs(pp - roi) / roi < 0.1, `pp ${pp} vs roi ${roi} should agree within 10%`);
});

test('the add is reported for telemetry', () => {
  const r = applyFloor(0.021, 0.02, 0.4, 0);
  assert.ok(r.add > 0.002 && r.add < 0.004, 'add should be ~0.003, got ' + r.add);
});

test('config ships both knobs OFF by default', () => {
  const { config } = require('../config');
  assert.equal(config.pricing.vigMinPp, 0, 'VIG_MIN_PP must default to 0');
  assert.equal(config.pricing.vigMinRoi, 0, 'VIG_MIN_ROI must default to 0');
});
