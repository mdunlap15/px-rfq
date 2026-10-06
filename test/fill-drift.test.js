// Fill drift (2026-10-06): after an accepted confirm, the legs are re-priced at
// +5 / +30 min and the bettor-side fair change is stored on meta.fillDrift.
// Run: node --test test/fill-drift.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test, mock } = require('node:test');
const assert = require('node:assert');

const pricer = require('../services/pricer');
const orderTracker = require('../services/order-tracker');
const fillDrift = require('../services/fill-drift');

function order(id) {
  return {
    parlayId: id, fairParlayProb: 0.25, confirmedAt: '2026-10-06T16:00:00Z',
    meta: { fairParlayProb: 0.25, legs: [
      { lineId: 'A', market: 'player_reception_yds', sport: 'americanfootball_nfl', fairProb: 0.5, inputAgeSec: 1500 },
      { lineId: 'B', market: 'spread', sport: 'americanfootball_nfl', fairProb: 0.5, inputAgeSec: 60 },
    ] },
  };
}

test('track: snapshots at +5 and +30 min, drift = bettor fair now / at quote − 1, one save at the end', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const o = order('fd-1');
  const origFind = orderTracker.findByParlayId, origPrice = pricer.priceParlay;
  const db = require('../services/db'); const origSave = db.saveOrder;
  let saves = 0;
  orderTracker.findByParlayId = () => o;
  db.saveOrder = async () => { saves++; return 'ok'; };
  let call = 0;
  pricer.priceParlay = async () => {
    call++;
    const a = call === 1 ? 0.55 : 0.6;               // leg A moves against us
    return { meta: { fairParlayProb: a * 0.5, legs: [{ lineId: 'A', fairProb: a }, { lineId: 'B', fairProb: 0.5 }] } };
  };
  try {
    fillDrift.track('fd-1');
    assert.strictEqual(o.meta.fillDrift.quotedFair, 0.25);
    assert.deepStrictEqual(o.meta.fillDrift.inputAgeSec.map(x => x.ageSec), [1500, 60]);
    t.mock.timers.tick(5 * 60e3); await new Promise(setImmediate);
    assert.ok(Math.abs(o.meta.fillDrift.m5.drift - 0.1) < 1e-4, JSON.stringify(o.meta.fillDrift.m5));
    assert.strictEqual(o.meta.fillDrift.m5.legs[0].drift, 0.1);
    assert.strictEqual(saves, 0, 'no write until the last checkpoint');
    t.mock.timers.tick(25 * 60e3); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.ok(Math.abs(o.meta.fillDrift.m30.drift - 0.2) < 1e-4);
    assert.strictEqual(saves, 1, 'exactly one save per fill');
    assert.strictEqual(fillDrift.getStats().pending, 0);
  } finally {
    orderTracker.findByParlayId = origFind; pricer.priceParlay = origPrice; db.saveOrder = origSave;
  }
});

test('a failed re-price records the reason, never throws', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const o = order('fd-2');
  const origFind = orderTracker.findByParlayId, origPrice = pricer.priceParlay;
  orderTracker.findByParlayId = () => o;
  pricer.priceParlay = async () => { pricer.priceParlay._lastFailure = { reason: 'event started' }; return null; };
  const origLast = pricer.getLastPriceFailure;
  try {
    fillDrift.track('fd-2');
    t.mock.timers.tick(5 * 60e3); await new Promise(setImmediate);
    assert.ok(o.meta.fillDrift.m5.reason, JSON.stringify(o.meta.fillDrift.m5));
    assert.strictEqual(o.meta.fillDrift.m5.fair, undefined);
  } finally {
    orderTracker.findByParlayId = origFind; pricer.priceParlay = origPrice;
    t.mock.timers.tick(30 * 60e3);
  }
});

test('summarize buckets legs by sport, prop vs game, input age; drift > 2% counts as against us', () => {
  const o = order('fd-3');
  o.meta.fillDrift = {
    inputAgeSec: [{ lineId: 'A', ageSec: 1500 }, { lineId: 'B', ageSec: 60 }],
    m5: { fair: 0.3, legs: [{ lineId: 'A', drift: 0.1 }, { lineId: 'B', drift: -0.01 }] },
    m30: { fair: 0.3, legs: [{ lineId: 'A', drift: 0.12 }, { lineId: 'B', drift: 0 }] },
  };
  const s = fillDrift.summarize([o]);
  assert.strictEqual(s.fills, 1);
  const prop = s.rows.find(r => r.family === 'prop');
  const game = s.rows.find(r => r.family === 'game');
  assert.strictEqual(prop.inputAge, '15-30m');
  assert.strictEqual(prop.meanDrift5Pct, 10);
  assert.strictEqual(prop.shareAgainst2pct5, 1);
  assert.strictEqual(game.inputAge, '<=2m');
  assert.strictEqual(game.shareAgainst2pct5, 0);
});
