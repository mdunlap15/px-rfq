// Per-family same-game prop correlation (sgpPhiByFamily) + the DK phi back-out.
//
// The pooled phi floor treats every same-game prop pair identically, but
// correlation is prop-family-specific (batter run-producing composites ride the
// game script far harder than strikeouts — DK-implied phi ~0.32 vs ~0.17).
// sgpPhiByFamily keys a sorted family-pair ('batter_batter', 'kprop_total') to
// its own phi; missing key falls back to the pooled floor, so an EMPTY map is
// byte-identical to the old behavior. scripts/dk-sgp-phi.js calibrates the keys.
//
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');

const { sgpPropFamily } = require('../services/pricer');
const { backOutPhi, devigPair, amerToProb } = require('../scripts/dk-sgp-phi');

// ------------------------------------------------------------ family buckets
test('family buckets: kprop / batter / bball / total / prop / other', () => {
  assert.equal(sgpPropFamily({ marketType: 'player_strikeouts' }), 'kprop');
  assert.equal(sgpPropFamily({ marketType: 'player_hitter_hr' }), 'batter');
  assert.equal(sgpPropFamily({ marketType: 'player_hitter_total_bases' }), 'batter');
  assert.equal(sgpPropFamily({ marketType: 'player_points' }), 'bball');
  assert.equal(sgpPropFamily({ marketType: 'player_rebounds' }), 'bball');
  assert.equal(sgpPropFamily({ marketType: 'player_threes_made' }), 'bball');
  assert.equal(sgpPropFamily({ marketType: 'total' }), 'total');
  assert.equal(sgpPropFamily({ marketType: 'player_shots_on_target' }), 'prop');
  assert.equal(sgpPropFamily({ marketType: 'moneyline' }), 'other');
  assert.equal(sgpPropFamily(null), 'other');
});

test('pair keys are order-independent (sorted join)', () => {
  const k1 = [sgpPropFamily({ marketType: 'player_hitter_hr' }), sgpPropFamily({ marketType: 'total' })].sort().join('_');
  const k2 = [sgpPropFamily({ marketType: 'total' }), sgpPropFamily({ marketType: 'player_hitter_hr' })].sort().join('_');
  assert.equal(k1, k2);
  assert.equal(k1, 'batter_total');
});

// ------------------------------------------------------------ config parsing
test('config: empty by default; parses valid keys; enforces bounds and key shape', () => {
  delete process.env.SGP_PHI_BY_FAMILY;
  delete require.cache[require.resolve('../config')];
  assert.deepEqual(require('../config').config.pricing.sgpPhiByFamily, {});

  process.env.SGP_PHI_BY_FAMILY = JSON.stringify({
    'batter_batter': 0.2,      // valid
    'kprop_kprop': 0.08,       // valid
    'batter': 0.2,             // not a pair -> rejected
    'batter_batter_x': 0.2,    // three parts -> rejected
    'bball_bball': 0.9,        // above 0.6 bound -> rejected
    'total_total': -0.1,       // negative -> rejected
  });
  delete require.cache[require.resolve('../config')];
  assert.deepEqual(require('../config').config.pricing.sgpPhiByFamily,
    { 'batter_batter': 0.2, 'kprop_kprop': 0.08 });
  delete process.env.SGP_PHI_BY_FAMILY;
  delete require.cache[require.resolve('../config')];
});

// ---------------------------------------- per-family lookup + pooled fallback
// Mirror of the pricer's pair loop: famKey lookup, fallback to pooled floor.
function pairMultiplier(p1, p2, famKey, phiByFamily, pooledFloor) {
  const pairPhi = Number.isFinite(phiByFamily[famKey]) ? phiByFamily[famKey] : pooledFloor;
  if (pairPhi <= 0) return 1;
  const naive = p1 * p2;
  const jointFair = Math.min(naive + pairPhi * Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2)), Math.min(p1, p2));
  return jointFair > naive ? jointFair / naive : 1;
}

test('a keyed family uses its own phi; unkeyed falls back to the pooled floor', () => {
  const map = { 'batter_batter': 0.30 };
  const keyed = pairMultiplier(0.5, 0.5, 'batter_batter', map, 0.10);
  const fallback = pairMultiplier(0.5, 0.5, 'kprop_kprop', map, 0.10);
  // batter pair: joint = 0.25 + 0.30*0.25 = 0.325 -> x1.30 ; pooled: 0.275 -> x1.10
  assert.ok(Math.abs(keyed - 1.30) < 1e-9, 'got ' + keyed);
  assert.ok(Math.abs(fallback - 1.10) < 1e-9, 'got ' + fallback);
});

test('an EMPTY map reproduces pooled behavior exactly (ship-neutral)', () => {
  for (const [p1, p2] of [[0.5, 0.5], [0.3, 0.6], [0.21, 0.44]]) {
    assert.equal(
      pairMultiplier(p1, p2, 'batter_batter', {}, 0.10),
      pairMultiplier(p1, p2, 'anything_else', {}, 0.10));
  }
});

test('a family key of 0 disables the lift for that family even with a pooled floor', () => {
  const map = { 'kprop_kprop': 0 };
  assert.equal(pairMultiplier(0.5, 0.5, 'kprop_kprop', map, 0.10), 1);
  assert.ok(pairMultiplier(0.5, 0.5, 'batter_batter', map, 0.10) > 1);
});

test('joint fair is capped at min(p1,p2) — a pair can never beat its weakest leg', () => {
  const m = pairMultiplier(0.9, 0.1, 'batter_batter', { 'batter_batter': 0.6 }, 0.10);
  // naive 0.09; band-top would exceed 0.1 -> capped at 0.1 -> x1.111...
  assert.ok(Math.abs(m - 0.1 / 0.09) < 1e-9, 'got ' + m);
});

// ------------------------------------------------------------ phi back-out
test('backOutPhi recovers a known phi exactly when both sides are supplied', () => {
  // Construct: p1=0.55, p2=0.50, phi=0.32
  const p1 = 0.55, p2 = 0.50, phi = 0.32;
  const q = p1 * p2 + phi * Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2));
  const load = 1.04; // proportional pair vig: sides sum to 1.04
  const r = backOutPhi(
    { prob: p1 * load, oppProb: (1 - p1) * load },
    { prob: p2 * load, oppProb: (1 - p2) * load },
    q * load * load          // SGP carries both legs' loads (product assumption)
  );
  assert.ok(Math.abs(r.p1 - p1) < 1e-9 && Math.abs(r.p2 - p2) < 1e-9, 'true de-vig must recover marginals');
  assert.ok(Math.abs(r.phi.product - phi) < 1e-9, 'product-load phi should be exact, got ' + r.phi.product);
});

test('phi is ~stable across vig assumptions (the Kalshi ±0.01 claim, reproduced)', () => {
  const p1 = 0.45, p2 = 0.52, phi = 0.20, load = 1.045;
  const q = p1 * p2 + phi * Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2));
  const r = backOutPhi(
    { prob: p1 * load, oppProb: (1 - p1) * load },
    { prob: p2 * load, oppProb: (1 - p2) * load },
    q * load * load
  );
  assert.ok(r.stable < 0.06, 'product-vs-single spread should be small, got ' + r.stable);
});

test('independent legs back out phi ~= 0', () => {
  const p1 = 0.5, p2 = 0.4, load = 1.05;
  const r = backOutPhi(
    { prob: p1 * load, oppProb: (1 - p1) * load },
    { prob: p2 * load, oppProb: (1 - p2) * load },
    p1 * p2 * load * load
  );
  assert.ok(Math.abs(r.phi.product) < 1e-9, 'got ' + r.phi.product);
});

test('helpers: amerToProb and devigPair basics', () => {
  assert.ok(Math.abs(amerToProb(-110) - 110 / 210) < 1e-9);
  assert.ok(Math.abs(amerToProb('+150') - 0.4) < 1e-9);
  assert.equal(amerToProb('junk'), null);
  assert.ok(Math.abs(devigPair(0.55, 0.55) - 0.5) < 1e-9);
});

test('backOutPhi fails closed on unusable inputs', () => {
  assert.equal(backOutPhi({ prob: null }, { prob: 0.5 }, 0.3), null);
  assert.equal(backOutPhi({ prob: 0.5 }, { prob: 0.5 }, 1.2), null);
});
