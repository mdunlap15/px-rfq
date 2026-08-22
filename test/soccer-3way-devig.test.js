const test = require('node:test');
const assert = require('node:assert');
const { deVig3WayPower, americanToImpliedProb } = require('../services/odds-feed');

const sum = a => a.reduce((x, y) => x + y, 0);

test('normalizes a real 3-way board to exactly 1', () => {
  // Bristol City @ Birmingham City, live TOA board 2026-08-22.
  const [h, d, a] = [-130, 250, 350].map(americanToImpliedProb);
  assert.ok(sum([h, d, a]) > 1.07, 'sanity: this board carries ~7% overround');
  const fair = deVig3WayPower(h, d, a);
  assert.ok(Math.abs(sum(fair) - 1) < 1e-9);
});

test('shrinks longshots harder than the favourite (the point of power de-vig)', () => {
  const [h, d, a] = [-130, 250, 350].map(americanToImpliedProb);
  const fair = deVig3WayPower(h, d, a);
  const prop = [h, d, a].map(p => p / sum([h, d, a]));
  // Power must leave the favourite HIGHER than proportional would, and the
  // longest shot LOWER. Proportional's bias is what underrates favourites by
  // ~4pp on structurally identical boards (golf make-cut, UFC method-of-victory).
  assert.ok(fair[0] > prop[0], 'favourite should be higher under power');
  assert.ok(fair[2] < prop[2], 'longest shot should be lower under power');
});

test('a 3-way fair is NOT a draw-no-bet fair', () => {
  // The whole reason h2h_3way is stored separately. P(home) and
  // P(home | no draw) differ by ~17pp on this board; interchanging them would
  // overprice every home-win leg.
  const [h, d, a] = [-130, 250, 350].map(americanToImpliedProb);
  const [fh, , fa] = deVig3WayPower(h, d, a);
  const dnbHome = fh / (fh + fa);
  assert.ok(dnbHome - fh > 0.15, `expected a wide gap, got ${(dnbHome - fh).toFixed(4)}`);
});

test('draw-no-bet derived from the 3-way agrees with a direct 2-way de-vig', () => {
  // Coherence guard: the two bases must describe the same game. Measured live,
  // 72.38% vs 71.49%.
  const [h, d, a] = [-130, 250, 350].map(americanToImpliedProb);
  const [fh, , fa] = deVig3WayPower(h, d, a);
  const fromThree = fh / (fh + fa);
  const fromTwo = h / (h + a);
  assert.ok(Math.abs(fromThree - fromTwo) < 0.02,
    `bases disagree: ${fromThree.toFixed(4)} vs ${fromTwo.toFixed(4)}`);
});

test('handles a balanced board without distortion', () => {
  const p = americanToImpliedProb(200); // three equal +200 legs, 3.9% overround
  const fair = deVig3WayPower(p, p, p);
  for (const v of fair) assert.ok(Math.abs(v - 1 / 3) < 1e-9);
});

test('rejects unusable input rather than inventing a number', () => {
  for (const bad of [
    [0, 0.3, 0.3], [1, 0.3, 0.3], [null, 0.3, 0.3],
    [NaN, 0.3, 0.3], [undefined, 0.3, 0.3], [-0.1, 0.3, 0.3],
  ]) {
    assert.strictEqual(deVig3WayPower(...bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('falls back to proportional when no root exists in the bracket', () => {
  // Degenerate near-certainty board: still returns a normalized triple rather
  // than null, matching deVig2WayPower's conservative fallback.
  const fair = deVig3WayPower(0.999, 0.999, 0.999);
  assert.ok(fair && Math.abs(sum(fair) - 1) < 1e-9);
});
