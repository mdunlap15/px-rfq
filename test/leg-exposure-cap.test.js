// Per-LINE exposure cap.
//
// WHY IT EXISTS: the team, game, player and pitcher caps all key on an ENTITY.
// A counterparty that pairs ONE repeated line with many DIFFERENT partners lands
// in a fresh team bucket and a fresh game bucket on every ticket, so none of
// them ever binds while the repeated line concentrates unchecked.
//
// Measured 2026-08-05, creator f88b95dc: 998 quotes over 573 distinct leg-sets,
// a single line (Kamilla Cardoso rebounds 7.5) present in 357 of them, $3,654 of
// raw risk on one pitcher's strikeout line across 8 tickets, and $3,744 of open
// risk resting on ~3 prop outcomes. No existing cap came close to binding.
//
// The decisive test here is `the pattern the existing caps miss` — it asserts
// the team and game caps stay silent on exactly the shape the leg cap catches.
//
// Run: npm test   (or: node --test test/leg-exposure-cap.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const ot = require('../services/order-tracker');
const { config } = require('../config');

const DAY = '2026-08-05T23:00:00Z';
// A leg as the pricer hands it to the checkers (lineInfo flattened on top).
function leg(o) {
  return Object.assign({
    lineId: null, teamName: null, marketType: 'moneyline', line: null,
    fairProb: 0.5, startTime: DAY, pxEventId: 'E1', homeTeam: 'H', awayTeam: 'A',
  }, o);
}
const CAP = 1500;
// Quote-time projections are scaled by pendingReservationDiscount (prod: 0.2)
// exactly as checkGameExposure does — most quotes never fill, so reserving full
// risk for each would block everything. CONFIRMED exposure is NOT discounted,
// and that is the term that actually concentrated in the case this cap targets.
// Tests below use a small cap so the arithmetic stays readable.
const DISC = config.pricing.pendingReservationDiscount;
const SMALL = 300;

// ---------------------------------------------------------------- key shape
test('legExposureKey prefers PX lineId and is scoped to the game date', () => {
  const k = ot.legExposureKey(leg({ lineId: 'abc123' }));
  assert.ok(k.startsWith('L:abc123|'), 'lineId should drive the key, got ' + k);
  assert.ok(k.endsWith('|2026-08-05'), 'key must carry the date, got ' + k);
  // same line, later day => different bucket
  const k2 = ot.legExposureKey(leg({ lineId: 'abc123', startTime: '2026-08-06T23:00:00Z' }));
  assert.notEqual(k, k2);
});

test('legExposureKey falls back to team|market|line when lineId is absent', () => {
  const k = ot.legExposureKey(leg({ teamName: 'Kamilla Cardoso', marketType: 'player_rebounds', line: 7.5 }));
  assert.ok(k.startsWith('S:'), 'expected synthetic key, got ' + k);
  assert.ok(/cardoso/i.test(k) && k.includes('player_rebounds') && k.includes('7.5'), k);
  // different LINE on the same player is a DIFFERENT bucket (7.5 vs 8 are distinct bets)
  const k8 = ot.legExposureKey(leg({ teamName: 'Kamilla Cardoso', marketType: 'player_rebounds', line: 8 }));
  assert.notEqual(k, k8);
});

test('legExposureKey returns null when there is nothing to key on', () => {
  assert.equal(ot.legExposureKey(null), null);
  assert.equal(ot.legExposureKey(leg({ teamName: '', marketType: '' })), null);
});

// ------------------------------------------------------------- cap behaviour
test('cap of 0 disables the check entirely', () => {
  const legs = [leg({ lineId: 'x' }), leg({ lineId: 'y' })];
  assert.equal(ot.checkLegExposure(legs, 999999, 0).allowed, true);
  assert.equal(ot.checkLegExposure(legs, 999999, null).allowed, true);
});

test('a single ticket under the cap is allowed', () => {
  const legs = [leg({ lineId: 'solo-a' }), leg({ lineId: 'solo-b' })];
  // weighted risk per leg = 400 * 0.5 = 200, well under 1500
  assert.equal(ot.checkLegExposure(legs, 400, CAP).allowed, true);
});

test('one ticket that alone exceeds the cap is declined', () => {
  const legs = [leg({ lineId: 'big-a' }), leg({ lineId: 'big-b' })];
  // weighted raw = 5000 * 0.5 = 2500; effective = 2500 * DISC
  const r = ot.checkLegExposure(legs, 5000, SMALL);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Line .* > max/);
  assert.equal(r.limit, SMALL);
  assert.ok(r.wouldBe > SMALL);
  assert.equal(r.newRiskRaw, 2500, 'raw weighted risk is reported undiscounted');
});

test('quote-time risk is scaled by pendingReservationDiscount, like the game cap', () => {
  // Pins the semantic: 2 legs, payout P -> raw weighted 0.5P, effective 0.5P*DISC.
  const legs = [leg({ lineId: 'disc-a' }), leg({ lineId: 'disc-b' })];
  const P = 5000;
  const rawWeighted = P * 0.5;
  const effective = rawWeighted * DISC;
  // just under the effective figure -> declines; just over -> allowed
  assert.equal(ot.checkLegExposure(legs, P, effective * 0.99).allowed, false);
  assert.equal(ot.checkLegExposure(legs, P, effective * 1.01).allowed, true);
  assert.equal(ot.checkLegExposure(legs, P, effective * 0.99).reservationDiscount, DISC);
});

test('risk is WEIGHTED by the other legs, not raw', () => {
  // Same payout, but a longer parlay puts less risk on any ONE line, because we
  // only lose if every other leg also lands. Raw accounting would double-count.
  const two = [leg({ lineId: 'w1' }), leg({ lineId: 'w2', fairProb: 0.5 })];
  const three = [leg({ lineId: 'w1' }), leg({ lineId: 'w2', fairProb: 0.5 }), leg({ lineId: 'w3', fairProb: 0.5 })];
  const payout = 5000;
  // 2-leg: 0.5*5000*DISC ; 3-leg: 0.25*5000*DISC — half as much on any one line
  const cap = 0.375 * payout * DISC;           // between the two
  assert.equal(ot.checkLegExposure(two, payout, cap).allowed, false, '2-leg concentrates more');
  assert.equal(ot.checkLegExposure(three, payout, cap).allowed, true, '3-leg spreads the risk');
});

// --------------------------------------------------- pending accumulation
test('in-flight quotes accumulate, so a burst cannot slip through', () => {
  ot.releasePending('burst-1'); ot.releasePending('burst-2'); ot.releasePending('burst-3');
  const key = ot.legExposureKey(leg({ lineId: 'burst-line' }));
  const mk = (id) => ot.reservePending(id, {
    expiresAt: Date.now() + 120000,
    teamKeys: [], gameKeys: [], pitcherKeys: [],
    legKeys: [{ key, risk: 700 }],
  });
  const legs = [leg({ lineId: 'burst-line' }), leg({ lineId: 'partner' })];
  const P = 1000;
  const newEff = P * 0.5 * DISC;               // this quote's contribution
  const perRes = 700 * DISC;                   // each in-flight reservation's
  const cap = newEff + perRes * 1.5;           // room for ONE, not two
  mk('burst-1');
  assert.equal(ot.getPendingLegRisk(key), 700, 'raw pending is tracked undiscounted');
  assert.equal(ot.checkLegExposure(legs, P, cap).allowed, true, 'one in-flight quote fits');
  mk('burst-2');
  assert.equal(ot.getPendingLegRisk(key), 1400);
  const r = ot.checkLegExposure(legs, P, cap);
  assert.equal(r.allowed, false, 'second in-flight quote must push it over');
  assert.equal(r.legKey, key);
  ot.releasePending('burst-1'); ot.releasePending('burst-2');
  assert.equal(ot.getPendingLegRisk(key), 0, 'release must fully unwind the index');
  assert.equal(ot.checkLegExposure(legs, P, cap).allowed, true);
});

test('releasing a reservation that was never made is a no-op', () => {
  ot.releasePending('never-existed');
  assert.equal(ot.getPendingLegRisk('L:nope|2026-08-05'), 0);
});

// ------------------------------------------- THE PATTERN THE OTHER CAPS MISS
test('the pattern the existing caps miss: one repeated line, many partners', () => {
  // Reproduces creator f88b95dc: the SAME prop line paired with a DIFFERENT team
  // in a DIFFERENT game every time. Team and game buckets never concentrate.
  const PROP = { lineId: 'cardoso-reb-75', teamName: 'Kamilla Cardoso', marketType: 'player_rebounds', line: 7.5 };
  const propKey = ot.legExposureKey(leg(PROP));
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = 'spread-' + i;
    ids.push(id);
    ot.releasePending(id);
    ot.reservePending(id, {
      expiresAt: Date.now() + 120000,
      // each ticket lands in its OWN team and game bucket — those never stack
      teamKeys: [{ key: 'team' + i + '|E' + i + '|2026-08-05', risk: 500, rawRisk: 1000 }],
      gameKeys: [{ key: 'E' + i + '|2026-08-05', risk: 500 }],
      pitcherKeys: [],
      legKeys: [{ key: propKey, risk: 500 }],   // ...but the PROP line does
    });
  }
  // Team and game caps see only 500 per bucket — nowhere near their 5000/12000 limits.
  assert.ok(ot.getPendingTeamRisk('team0|E0|2026-08-05') <= 500, 'team bucket stays small');
  assert.ok(ot.getPendingGameRisk('E0|2026-08-05') <= 500, 'game bucket stays small');
  // The leg bucket, however, has accumulated 2000 and is over the cap.
  assert.equal(ot.getPendingLegRisk(propKey), 2000);
  const next = [leg(PROP), leg({ lineId: 'yet-another-partner', pxEventId: 'E9' })];
  // cap sized so the four accumulated reservations alone blow through it
  const cap = 2000 * DISC * 0.8;
  const r = ot.checkLegExposure(next, 400, cap);
  assert.equal(r.allowed, false, 'the leg cap must catch what team/game caps cannot');
  assert.match(r.legLabel, /Cardoso/);
  for (const id of ids) ot.releasePending(id);
});

// --------------------------------------------------------- open-order map
test('buildOpenLegRiskMap returns a Map and ignores unconfirmed quotes', () => {
  const id = 'openmap-quote-only';
  ot.recordQuote(id, [{ line_id: 'openmap-line', fairProb: 0.5, startTime: DAY }], 150, 100, 0.4, {});
  const m = ot.buildOpenLegRiskMap();
  assert.ok(m instanceof Map);
  const k = ot.legExposureKey(leg({ lineId: 'openmap-line' }));
  assert.ok(!m.has(k), 'a quote that never confirmed must not consume line capacity');
});

// ------------------------------------------------------------------ config
test('config ships the cap with the measured default', () => {
  assert.equal(config.pricing.maxExposurePerLeg, 1500,
    'default is sized to the measured p99 of per-line-per-day weighted exposure ($1,527)');
});

test('the decline reason is a recognised limit reason', () => {
  // Must be in LIMIT_REASONS or the dashboard banner silently filters it out —
  // the exact gap that hid series and per-parlay-risk declines previously.
  const src = require('fs').readFileSync(require.resolve('../services/order-tracker'), 'utf8');
  assert.ok(/LIMIT_REASONS = new Set\(\[[\s\S]*?'leg exposure limit'/.test(src), 'missing from LIMIT_REASONS');
  assert.ok(/RISK_LIMIT_REASONS = new Set\(\[[\s\S]*?'leg exposure limit'/.test(src), 'missing from RISK_LIMIT_REASONS');
});
