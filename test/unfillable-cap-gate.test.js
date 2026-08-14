// Unfillable-within-cap gate (2026-08-13).
//
// THE BUG IT FIXES: max_risk on the wire is the BETTOR's stake cap (PX Rule 3),
// derived from our risk cap as risk * p/(1-p) — and the offer builder floors
// that at $1. So whenever our risk cap converts to a sub-$1 stake cap, the
// smallest stake PX can book ALREADY breaches our cap: we publish an offer we
// are mathematically certain to reject at confirm.
//
// MEASURED 2026-08-13 (the three rejects that prompted this): 3-leg HR-over
// parlays at +11048 and +14821 under a $50 prop cap. True stake cap $0.45,
// floored to $1, and a $1 stake at +11048 costs us $110. All three were
// quoted, accepted by the bettor, then rejected by us — advertise-and-decline
// (PX Rule 2) plus a wasted round trip.
//
// The gate declines these at QUOTE time. This file pins the arithmetic; the
// production wiring is a decline inside priceParlay's offer build.
//
// Run: npm test   (or: node --test test/unfillable-cap-gate.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');

// Mirror of the production rule: given our RISK cap and the offered implied
// prob, what stake cap goes on the wire, and is it fillable at PX's minimum?
function stakeCapFor(riskCap, offeredProb) {
  return riskCap * offeredProb / (1 - offeredProb);
}
function isUnfillable(riskCap, offeredProb, minStake = config.pricing.pxMinStake) {
  return riskCap > 0 && stakeCapFor(riskCap, offeredProb) < minStake;
}
// Our risk if PX books exactly minStake at these odds.
function riskAtMinStake(offeredProb, minStake = config.pricing.pxMinStake) {
  return minStake * (1 / offeredProb - 1);
}

test('config ships pxMinStake at the $1 wire floor the offer builder uses', () => {
  assert.equal(config.pricing.pxMinStake, 1);
});

test('the measured case: 3-leg HR-over at +11048 under a $50 cap is unfillable', () => {
  const p = 100 / (11048 + 100); // ≈ 0.897%
  const stakeCap = stakeCapFor(50, p);
  assert.ok(stakeCap < 1, `true stake cap must round below the $1 floor, got $${stakeCap.toFixed(2)}`);
  assert.ok(isUnfillable(50, p), 'must be declined at quote time');
  // And the reason it matters: the minimum bookable stake blows the cap ~2x.
  const risk = riskAtMinStake(p);
  assert.ok(risk > 100 && risk < 120, `a $1 stake should risk ~$110, got $${risk.toFixed(0)}`);
  assert.ok(risk > 50, 'the smallest possible fill already exceeds the $50 cap — hence the certain reject');
});

test('the same parlay is perfectly quotable once the cap is $3,000', () => {
  const p = 100 / (11048 + 100);
  assert.equal(isUnfillable(3000, p), false);
  assert.ok(stakeCapFor(3000, p) > 25, 'a $3K cap supports a real stake at +11048');
});

test('the gate is scoped to small-cap x long-odds, not ordinary flow', () => {
  // $3,000 prop cap: needs beyond +300000 to bite — i.e. never in practice.
  assert.equal(isUnfillable(3000, 100 / (50000 + 100)), false, '+50000 at a $3K cap is still fillable');
  // $15 experimental-SGP cap: starts biting past ~+1500, which is real.
  assert.equal(isUnfillable(15, 100 / (1000 + 100)), false, '+1000 at a $15 cap is fillable');
  assert.equal(isUnfillable(15, 100 / (2000 + 100)), true, '+2000 at a $15 cap is NOT');
  // Ordinary MLB/tennis prices are never touched at any sane cap.
  for (const odds of [-200, 100, 250, 600]) {
    const p = odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
    assert.equal(isUnfillable(50, p), false, `${odds} at a $50 cap must stay quotable`);
  }
});

test('a zero/absent cap disables the gate (cap 0 = uncapped)', () => {
  assert.equal(isUnfillable(0, 0.009), false);
});

// --- END-TO-END: the production wiring, not just the arithmetic -------------
// Review 2026-08-14 caught that the arithmetic tests above would all stay green
// if someone deleted the decline block inside priceParlay. This drives the real
// function through a stubbed line index and asserts the decline actually fires.
test('priceParlay DECLINES a long-odds parlay whose prop cap cannot be filled', async () => {
  const lineManager = require('../services/line-manager');
  const pricer = require('../services/pricer');
  const oddsFeed = require('../services/odds-feed');

  const FUTURE = new Date(Date.now() + 6 * 3600e3).toISOString();
  // Three HR-over legs at ~20% each (a real +400-ish HR price) -> parlay
  // fair ~0.8%, which is the measured +11048 shape and clears the 0.1%
  // minimum-probability floor so the CAP gate is what fires.
  const LINES = {};
  for (const id of ['hr-a', 'hr-b', 'hr-c']) {
    LINES[id] = {
      lineId: id, sport: 'baseball_mlb', marketType: 'player_hitter_hr',
      teamName: 'Slugger ' + id, playerName: 'Slugger ' + id, line: 0.5,
      selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'player_hitter_hr',
      oddsApiSport: 'baseball_mlb', homeTeam: 'Home', awayTeam: 'Away',
      pxEventId: 'E-' + id, startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
    };
  }
  const origLookup = lineManager.lookupLine;
  const origFair = oddsFeed.getFairProb;
  const origStale = oddsFeed.isStaleForEvent;
  const origPropCap = config.pricing.maxRiskPerParlayWithProp;
  const origMaxOdds = config.pricing.maxOdds;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.20;
  oddsFeed.isStaleForEvent = () => false;
  config.pricing.maxRiskPerParlayWithProp = 50; // the setting that produced the measured rejects
  // Lift the odds ceiling so the CAP gate is unambiguously what declines
  // (the local .env caps at +1500; the measured parlays quoted at +11048).
  config.pricing.maxOdds = 50000;
  try {
    const res = await pricer.priceParlay(['hr-a', 'hr-b', 'hr-c']);
    assert.equal(res, null, 'must decline rather than publish an offer it will reject at confirm');
    const f = pricer.getLastPriceFailure ? pricer.getLastPriceFailure() : pricer.priceParlay._lastFailure;
    assert.equal(f && f.reason, 'unfillable within risk cap',
      'decline reason must name the gate, got: ' + JSON.stringify(f));
  } finally {
    lineManager.lookupLine = origLookup;
    oddsFeed.getFairProb = origFair;
    oddsFeed.isStaleForEvent = origStale;
    config.pricing.maxRiskPerParlayWithProp = origPropCap;
    config.pricing.maxOdds = origMaxOdds;
  }
});

test('the boundary is exact: stake cap == minStake still quotes', () => {
  // Choose p so the stake cap lands exactly on $1 for a $50 risk cap.
  const p = 1 / (1 + 50); // stakeCap = 50 * p/(1-p) = 1
  assert.ok(Math.abs(stakeCapFor(50, p) - 1) < 1e-9);
  assert.equal(isUnfillable(50, p), false, 'exactly-at-minimum must be allowed, not declined');
});
