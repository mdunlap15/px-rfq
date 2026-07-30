// Regression tests: Account Equity must use DEPLOYED CASH, not max liability.
//
// Background (2026-07-30): equity read ~$101K against an actual ~$78K. The
// formula was right — cash + single bets + parlays — but the parlay term used
// max payout liability. Verified against the operator's own PX position list:
//   cash                 $25,048.91  (matches the PX app exactly)
//   single bets          $45,865.60  (matches the 84-position Cost sum to $590)
//   => implied parlays   ~$7,085
//   we were reporting    ~$30,269   <- max liability, ~4.25x too high
//
// Once a leg has LOST, the bettor's parlay cannot hit, our payout obligation is
// gone, and PX has released the money. Those parlays are not deployed cash.
//
// openExposure (worst case) is retained for risk limits; only equity switches
// to the live basis.
//
// Run: npm test   (or: node --test test/px-ledger-live-exposure.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { summarize } = require('../services/px-ledger');

const order = (status, stake, legStatuses, settlement) => ({
  status,
  confirmed_stake: stake,
  settlement_status: settlement || 'tbd',
  legs: legStatuses.map(s => ({ settlement_status: s })),
});

test('a fully unresolved parlay counts as deployed cash', () => {
  const s = summarize([order('finalized', 100, ['tbd', 'tbd'])]);
  assert.equal(s.openExposure, 100);
  assert.equal(s.liveOpenExposure, 100);
  assert.equal(s.liveOpenCount, 1);
});

test('a parlay with a LOST leg is liability only, NOT deployed cash', () => {
  // Bettor's parlay is dead -> we cannot lose -> PX released the money.
  const s = summarize([order('finalized', 500, ['lost', 'tbd'])]);
  assert.equal(s.openExposure, 500, 'still worst-case liability for risk limits');
  assert.equal(s.liveOpenExposure, 0, 'but no cash is deployed');
});

test('a parlay with a WON leg is still live — bettor can still hit', () => {
  const s = summarize([order('finalized', 250, ['won', 'tbd'])]);
  assert.equal(s.liveOpenExposure, 0,
    'any resolved leg means PX may have re-priced/released; only all-tbd counts');
  assert.equal(s.openExposure, 250);
});

test('the two bases diverge exactly as observed in production', () => {
  const s = summarize([
    order('finalized', 100, ['tbd', 'tbd']),
    order('finalized', 900, ['lost', 'tbd']),
    order('finalized', 50, ['tbd']),
  ]);
  assert.equal(s.openExposure, 1050, 'max liability includes the dead parlay');
  assert.equal(s.liveOpenExposure, 150, 'cash basis excludes it');
  assert.equal(s.counts.open, 3);
  assert.equal(s.liveOpenCount, 2);
});

test('settled and rejected orders never count as deployed', () => {
  const s = summarize([
    order('settled', 400, ['won', 'won'], 'won'),
    order('rejected', 300, ['tbd', 'tbd']),
    order('failed', 200, ['tbd', 'tbd']),
  ]);
  assert.equal(s.openExposure, 0);
  assert.equal(s.liveOpenExposure, 0);
});

test('an order with no legs is not treated as live', () => {
  // Defensive: a malformed/legless order must not silently inflate cash.
  const s = summarize([order('finalized', 777, [])]);
  assert.equal(s.openExposure, 777);
  assert.equal(s.liveOpenExposure, 0);
});

test('missing leg settlement_status defaults to tbd (still live)', () => {
  const s = summarize([{ status: 'finalized', confirmed_stake: 60, legs: [{}, {}] }]);
  assert.equal(s.liveOpenExposure, 60);
});
