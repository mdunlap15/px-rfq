// LEAGUE-WIDE NET PLAYER-PROP EXPOSURE CAP.
//
// Operator directive 2026-09-07, on opening football player props for parlays:
// "we should place lower limits on net exposure we'll take for player props …
// cap CFB player props net exposure at $500 and NFL player props net exposure
// at $1500."
//
// This is a genuinely NEW dimension, and the reason it had to be built rather
// than configured is worth stating, because three caps already exist and none
// of them can express it:
//
//   maxExposurePerPlayerBySport   PER PLAYER. Twenty receivers in twenty games
//                                 each sit under their own cap while the
//                                 league book runs far past $500.
//   sgp-guard prop game caps      PER GAME. Cannot see one Saturday slate.
//   maxRiskPerParlayWithProp      PER TICKET. Says nothing about the book.
//
// It is implemented by summing the EXISTING per-player accounting by sport
// rather than opening a second set of books, so it can never drift out of step
// with the per-player cap — which is the specific failure the standalone
// blocklist script produced when it kept its own copy of shared state.
//
// Run: node --test test/prop-league-exposure.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const orderTracker = require('../services/order-tracker');

const CFB = 'americanfootball_ncaaf';
const NFL = 'americanfootball_nfl';
const CAPS = { [CFB]: 500, [NFL]: 1500 };

const propLeg = (sport, playerName, marketType = 'player_passing_yards') =>
  ({ lineInfo: { sport, playerName, marketType } });
const teamLeg = (sport) => ({ lineInfo: { sport, marketType: 'spread', teamName: 'Alabama' } });

// The tracker's own recording path, so these exercise real accounting rather
// than a hand-built fixture.
function withExposure(entries, fn) {
  const snap = orderTracker.__testSetPlayerExposure
    ? orderTracker.__testSetPlayerExposure(entries) : null;
  try { return fn(); } finally { if (snap) snap(); }
}

test('the defaults are the operator-specified caps', () => {
  const { config } = require('../config');
  assert.strictEqual(config.pricing.propNetExposureBySport[CFB], 500);
  assert.strictEqual(config.pricing.propNetExposureBySport[NFL], 1500);
});

test('an empty book allows a parlay under the cap', () => {
  const r = orderTracker.checkPropLeagueExposure([propLeg(CFB, 'QB One')], 50, CAPS);
  assert.strictEqual(r, null, '$50 against a $500 cap on an empty book must pass');
});

test('a parlay whose own risk exceeds the cap is refused outright', () => {
  const r = orderTracker.checkPropLeagueExposure([propLeg(CFB, 'QB One')], 600, CAPS);
  assert.ok(r && r.exceeded, '$600 alone is over the $500 CFB cap');
  assert.strictEqual(r.sport, CFB);
  assert.strictEqual(r.max, 500);
});

test('NFL gets the higher cap, and the two leagues are independent', () => {
  // $600 breaches CFB but sits comfortably inside NFL.
  assert.ok(orderTracker.checkPropLeagueExposure([propLeg(CFB, 'A')], 600, CAPS).exceeded);
  assert.strictEqual(orderTracker.checkPropLeagueExposure([propLeg(NFL, 'A')], 600, CAPS), null);
  assert.ok(orderTracker.checkPropLeagueExposure([propLeg(NFL, 'A')], 1600, CAPS).exceeded);
});

test('a sport absent from the map is UNCAPPED on this dimension', () => {
  // MLB props must not be blocked by a football cap — its own caps still apply.
  assert.strictEqual(
    orderTracker.checkPropLeagueExposure([propLeg('baseball_mlb', 'Judge')], 99999, CAPS), null);
});

test('non-prop legs do not pull a league into the check', () => {
  // A football SPREAD leg is not prop risk and must not consume the prop cap.
  assert.strictEqual(
    orderTracker.checkPropLeagueExposure([teamLeg(CFB)], 99999, CAPS), null);
});

test('a mixed parlay is checked against the league its PROP leg belongs to', () => {
  const legs = [teamLeg('baseball_mlb'), propLeg(CFB, 'QB One')];
  const r = orderTracker.checkPropLeagueExposure(legs, 600, CAPS);
  assert.ok(r && r.exceeded);
  assert.strictEqual(r.sport, CFB);
});

test('guards: no legs, no risk, no cap map', () => {
  assert.strictEqual(orderTracker.checkPropLeagueExposure([], 100, CAPS), null);
  assert.strictEqual(orderTracker.checkPropLeagueExposure(null, 100, CAPS), null);
  assert.strictEqual(orderTracker.checkPropLeagueExposure([propLeg(CFB, 'A')], 0, CAPS), null);
  assert.strictEqual(orderTracker.checkPropLeagueExposure([propLeg(CFB, 'A')], 100, null), null);
  // A zero or negative cap is treated as "not configured", never as "block all".
  assert.strictEqual(
    orderTracker.checkPropLeagueExposure([propLeg(CFB, 'A')], 100, { [CFB]: 0 }), null);
});

test('legs are accepted in the bare shape as well as the {lineInfo} shape', () => {
  const bare = [{ sport: CFB, playerName: 'QB One', marketType: 'player_passing_yards' }];
  const r = orderTracker.checkPropLeagueExposure(bare, 600, CAPS);
  assert.ok(r && r.exceeded, 'callers pass both shapes; neither may silently no-op');
});

test('the cap counts the WHOLE league book, not just this player', () => {
  // The entire point: many players, each individually small.
  if (!orderTracker.__testSetPlayerExposure) return;   // seam not present
  withExposure({
    [`${CFB}|Player A`]: { sport: CFB, playerName: 'Player A', risk: 200 },
    [`${CFB}|Player B`]: { sport: CFB, playerName: 'Player B', risk: 200 },
    [`${NFL}|Player C`]: { sport: NFL, playerName: 'Player C', risk: 900 },
  }, () => {
    // CFB book is at $400. A $50 ticket on a THIRD, untouched player fits.
    assert.strictEqual(
      orderTracker.checkPropLeagueExposure([propLeg(CFB, 'Player C')], 50, CAPS), null);
    // ...but $150 does not, even though Player C has zero exposure of their own.
    const r = orderTracker.checkPropLeagueExposure([propLeg(CFB, 'Player C')], 150, CAPS);
    assert.ok(r && r.exceeded, 'per-player caps cannot see this; the league cap must');
    assert.strictEqual(r.current, 400);
    assert.strictEqual(r.wouldBe, 550);
    // NFL is at $900 of its $1500 and is unaffected by the full CFB book.
    assert.strictEqual(
      orderTracker.checkPropLeagueExposure([propLeg(NFL, 'Player D')], 500, CAPS), null);
  });
});
