// Per-LINE exposure cap — RAW-dollar semantics (2026-08-13 rework).
//
// WHY IT EXISTS: the team, game, player and pitcher caps all key on an ENTITY.
// A counterparty that pairs ONE repeated line with many DIFFERENT partners lands
// in a fresh team bucket and a fresh game bucket on every ticket, so none of
// them ever binds while the repeated line concentrates unchecked.
//
// WHY IT WAS REWORKED: the original weighted-with-discount basis fired ZERO
// times in production — registered lineInfos carried no lineId (quote-time
// keys never matched the open map), the pending discount let a fresh $5K
// ticket count as ~$350, and probability weighting halved everything again.
// Result: creator dc3945a9 stacked $8,729 on one line pair (Shelton/Swiatek
// doubles, 2026-08-12) through a "$1,500" cap. Operator directive: cap raw
// same-line dollars at $6K, enforced exactly.
//
// SEMANTICS UNDER TEST:
//  - QUOTE mode (team lines): screen on OPEN raw risk only — an RFQ carries
//    no size, and pending reservations hold the generic $5K estimate, so
//    counting either would quote-dark popular lines.
//  - QUOTE mode (prop legs): open + pending + prop-bounded increment (prop
//    estimates are accurate — bounded by maxRiskPerParlayWithProp).
//  - CONFIRM mode: exact — open + in-flight confirms + ACTUAL stake > cap
//    rejects. reserveConfirmingLegRisk closes the check→record race.
//
// Run: npm test   (or: node --test test/leg-exposure-cap.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const ot = require('../services/order-tracker');
const { config } = require('../config');

const DAY = '2026-08-05T23:00:00Z';
const FUT = new Date(Date.now() + 24 * 3600e3).toISOString();
function leg(o) {
  return Object.assign({
    lineId: null, teamName: null, marketType: 'moneyline', line: null,
    fairProb: 0.5, startTime: DAY, pxEventId: 'E1', homeTeam: 'H', awayTeam: 'A',
  }, o);
}
const CAP = 6000;

// ---------------------------------------------------------------- key shape
test('legExposureKey prefers PX lineId and is scoped to the game date', () => {
  const k = ot.legExposureKey(leg({ lineId: 'abc123' }));
  assert.ok(k.startsWith('L:abc123|'), 'lineId should drive the key, got ' + k);
  assert.ok(k.endsWith('|2026-08-05'), 'key must carry the date, got ' + k);
  const k2 = ot.legExposureKey(leg({ lineId: 'abc123', startTime: '2026-08-06T23:00:00Z' }));
  assert.notEqual(k, k2);
});

test('legExposureKey falls back to team|market|line when lineId is absent', () => {
  const k = ot.legExposureKey(leg({ teamName: 'Kamilla Cardoso', marketType: 'player_rebounds', line: 7.5 }));
  assert.ok(k.startsWith('S:'), 'expected synthetic key, got ' + k);
  const k8 = ot.legExposureKey(leg({ teamName: 'Kamilla Cardoso', marketType: 'player_rebounds', line: 8 }));
  assert.notEqual(k, k8);
});

test('legExposureKey returns null when there is nothing to key on', () => {
  assert.equal(ot.legExposureKey(leg({ teamName: '', marketType: '' })), null);
});

// ------------------------------------------------------------- quote mode
test('cap of 0 disables the check entirely', () => {
  const legs = [leg({ lineId: 'x' }), leg({ lineId: 'y' })];
  assert.equal(ot.checkLegExposure(legs, 999999, 0).allowed, true);
  assert.equal(ot.checkLegExposure(legs, 999999, null).allowed, true);
});

test('QUOTE mode, team lines: a fresh line always quotes — size is unknown pre-confirm', () => {
  // Even the generic $5K worst-case estimate must not block an empty line:
  // enforcement of the actual dollars is confirm-time's job.
  const legs = [leg({ lineId: 'fresh-a' }), leg({ lineId: 'fresh-b' })];
  assert.equal(ot.checkLegExposure(legs, 5000, CAP).allowed, true);
});

test('QUOTE mode, team lines: pending reservations do NOT quote-dark a line', () => {
  // Pending carries the generic estimate (~100x a retail fill). Team-line
  // quoting must ignore it — the confirm gate holds the real ceiling.
  const key = ot.legExposureKey(leg({ lineId: 'busy-line' }));
  ot.releasePending('busy-1');
  ot.reservePending('busy-1', {
    expiresAt: Date.now() + 120000,
    teamKeys: [], gameKeys: [], pitcherKeys: [],
    legKeys: [{ key, risk: 5000 }],
  });
  const legs = [leg({ lineId: 'busy-line' }), leg({ lineId: 'busy-partner' })];
  assert.equal(ot.checkLegExposure(legs, 5000, CAP).allowed, true,
    'a single in-flight generic reservation must not block team-line quotes');
  ot.releasePending('busy-1');
});

// ------------------------------------------------------------ confirm mode
test('CONFIRM mode: the Shelton/Swiatek regression — second whale rejected, right-sized allowed', () => {
  // Ticket 1 confirmed $3,731 on lines S1+S2. Ticket 2 asks $4,998 on the
  // SAME lines: 3731 + 4998 = 8729 > 6000 must reject; a $2,200 ticket
  // (5931 <= 6000) must pass. Open risk arrives via a real confirmed order.
  const id = 'shelton-t1';
  ot.recordQuote(id, [
    { line_id: 'shelton-ml', fairProb: 0.661, startTime: FUT },
    { line_id: 'swiatek-ml', fairProb: 0.670, startTime: FUT },
  ], 150, 100, 0.44, {});
  ot.recordConfirmation(id, 'uuid-t1', 113, 3731);

  const t2legs = [
    leg({ lineId: 'shelton-ml', startTime: FUT, fairProb: 0.661 }),
    leg({ lineId: 'swiatek-ml', startTime: FUT, fairProb: 0.670 }),
  ];
  const whale = ot.checkLegExposure(t2legs, 5000, CAP, { mode: 'confirm', actualRisk: 4998 });
  assert.equal(whale.allowed, false, 'the $8.7K stack must now reject: ' + JSON.stringify(whale));
  assert.ok(whale.wouldBe > CAP);
  assert.match(whale.reason, /\[confirm\]/);

  const sized = ot.checkLegExposure(t2legs, 5000, CAP, { mode: 'confirm', actualRisk: 2200 });
  assert.equal(sized.allowed, true, 'a ticket that lands the line at $5,931 stays under the $6K ceiling');
});

test('CONFIRM mode: in-flight confirm reservations close the race window', () => {
  const legs = [leg({ lineId: 'race-a', startTime: FUT }), leg({ lineId: 'race-b', startTime: FUT })];
  // First whale passes and reserves; second whale must see the reservation.
  const first = ot.checkLegExposure(legs, 5000, CAP, { mode: 'confirm', actualRisk: 3800 });
  assert.equal(first.allowed, true);
  ot.reserveConfirmingLegRisk('race-p1', legs, 3800);
  const second = ot.checkLegExposure(legs, 5000, CAP, { mode: 'confirm', actualRisk: 3800 });
  assert.equal(second.allowed, false, 'concurrent confirm must count the in-flight reservation');
  // Release (handler finally) frees the line again.
  ot.releaseConfirmingLegRisk('race-p1');
  const third = ot.checkLegExposure(legs, 5000, CAP, { mode: 'confirm', actualRisk: 3800 });
  assert.equal(third.allowed, true);
});

test('releasing an unknown confirm reservation is a no-op', () => {
  ot.releaseConfirmingLegRisk('never-reserved');
});

// -------------------------------------------------------------- prop path
test('QUOTE mode, prop legs: NO estimate is charged — the blackout regression', () => {
  // 2026-08-14: quote mode used to charge _propRawRisk(estPayout) against the
  // prop line cap. Harmless at a $50 prop parlay cap; catastrophic once the
  // operator raised it to $3,000 — every prop RFQ charged $3,000 against the
  // $1,500 prop line cap and prop quoting went dark (11 declines/15min:
  // "Gerrit Cole player_strikeouts 5.5 open $0 + new $3000 > max $1500").
  // A $50 prop ticket must never be screened as if it were a $3,000 one.
  const PROP = { lineId: 'cole-k-55', teamName: 'Gerrit Cole', marketType: 'player_strikeouts', line: 5.5 };
  const legs = [leg(PROP), leg({ lineId: 'partner', pxEventId: 'E9' })];
  // Fresh line, generic $3,000 worst-case estimate, $1,500 prop cap -> MUST quote.
  assert.equal(ot.checkLegExposure(legs, 3000, 1500).allowed, true,
    'a fresh prop line must quote regardless of the generic estimate');
  // Pending generic reservations must not dark it either.
  const propKey = ot.legExposureKey(leg(PROP));
  ot.releasePending('blackout-1');
  ot.reservePending('blackout-1', {
    expiresAt: Date.now() + 120000,
    teamKeys: [], gameKeys: [], pitcherKeys: [],
    legKeys: [{ key: propKey, risk: 3000 }],
  });
  try {
    assert.equal(ot.checkLegExposure(legs, 3000, 1500).allowed, true,
      'in-flight generic estimates must not dark a prop line at quote time');
  } finally {
    ot.releasePending('blackout-1');
  }
});

test('CONFIRM mode is where prop concentration is enforced (burst guard moved)', () => {
  // The protection did not disappear — it moved to the point where the real
  // stake is known. In-flight confirm reservations cover the same-minute burst
  // the quote-time estimate used to (badly) approximate.
  const PROP = { lineId: 'burst-k-55', teamName: 'Burst Pitcher', marketType: 'player_strikeouts', line: 5.5, startTime: FUT };
  const legs = [leg(PROP), leg({ lineId: 'burst-partner', pxEventId: 'E9', startTime: FUT })];
  const CAPP = 1500;
  assert.equal(ot.checkLegExposure(legs, 3000, CAPP, { mode: 'confirm', actualRisk: 900 }).allowed, true);
  ot.reserveConfirmingLegRisk('burst-p1', legs, 900);
  try {
    const second = ot.checkLegExposure(legs, 3000, CAPP, { mode: 'confirm', actualRisk: 900 });
    assert.equal(second.allowed, false, '900 + 900 > 1500 must reject at confirm');
  } finally {
    ot.releaseConfirmingLegRisk('burst-p1');
  }
});

// --------------------------------------------------------- open-order map
test('buildOpenLegRiskMap accumulates RAW payout and ignores unconfirmed quotes', () => {
  const idQ = 'openmap-quote-only';
  ot.recordQuote(idQ, [{ line_id: 'openmap-line', fairProb: 0.5, startTime: DAY }], 150, 100, 0.4, {});
  const m = ot.buildOpenLegRiskMap();
  assert.ok(m instanceof Map);
  assert.ok(!m.has(ot.legExposureKey(leg({ lineId: 'openmap-line' }))), 'unconfirmed quote must not consume capacity');

  const idC = 'openmap-confirmed';
  ot.recordQuote(idC, [
    { line_id: 'raw-map-a', fairProb: 0.5, startTime: FUT },
    { line_id: 'raw-map-b', fairProb: 0.5, startTime: FUT },
  ], 150, 100, 0.25, {});
  ot.recordConfirmation(idC, 'uuid-raw', 300, 1000);
  const m2 = ot.buildOpenLegRiskMap();
  const kA = ot.legExposureKey(leg({ lineId: 'raw-map-a', startTime: FUT }));
  assert.ok(m2.has(kA), 'confirmed order must appear in the open map');
  assert.ok(Math.abs(m2.get(kA) - 1000) < 1, 'RAW payout, not probability-weighted: got ' + m2.get(kA));
});

// ------------------------------------------------------------------ config
test('config ships the cap at the operator-directed $6K raw ceiling', () => {
  assert.equal(config.pricing.maxExposurePerLeg, 6000,
    'operator directive 2026-08-13: same-line exposure ceiling $6K raw');
});

test('the decline reason is a recognised limit reason', () => {
  const src = require('fs').readFileSync(require.resolve('../services/order-tracker'), 'utf8');
  assert.ok(/LIMIT_REASONS = new Set\(\[[\s\S]*?'leg exposure limit'/.test(src), 'missing from LIMIT_REASONS');
  assert.ok(/RISK_LIMIT_REASONS = new Set\(\[[\s\S]*?'leg exposure limit'/.test(src), 'missing from RISK_LIMIT_REASONS');
});

// ---------------------------------------------- 2026-08-13 review fixes
test('CONFIRM mode excludes the parlay being confirmed (matched-raced-ahead)', () => {
  // order.matched can promote THIS order to confirmed (with uuid via
  // reconcile) before price.confirm.new arrives. The check must not count
  // the ticket against itself.
  const id = 'raced-ahead';
  ot.recordQuote(id, [
    { line_id: 'raced-a', fairProb: 0.5, startTime: FUT },
    { line_id: 'raced-b', fairProb: 0.5, startTime: FUT },
  ], 150, 100, 0.25, {});
  ot.recordConfirmation(id, 'uuid-raced', 200, 2100);
  const legs = [leg({ lineId: 'raced-a', startTime: FUT }), leg({ lineId: 'raced-b', startTime: FUT })];
  // Without exclusion: current 2100 + actual 2100 = 4200 > 4000 -> false reject.
  const withEx = ot.checkLegExposure(legs, 5000, 4000, { mode: 'confirm', actualRisk: 2100, excludeParlayId: id });
  assert.equal(withEx.allowed, true, 'own stake must not double-count: ' + (withEx.reason || ''));
  const withoutEx = ot.checkLegExposure(legs, 5000, 4000, { mode: 'confirm', actualRisk: 2100 });
  assert.equal(withoutEx.allowed, false, 'sanity: absent the exclusion the double-count rejects');
});

test('open map ignores no-uuid matched-promotions (other-SP fills / ties)', () => {
  const id = 'no-uuid-promo';
  ot.recordQuote(id, [{ line_id: 'promo-line', fairProb: 0.5, startTime: FUT }], 150, 100, 0.5, {});
  // Simulate matched-path promotion: confirmed status, stake, NO orderUuid.
  const o = ot.findByParlayId(id);
  o.status = 'confirmed';
  o.confirmedStake = 4000;
  const m = ot.buildOpenLegRiskMap();
  assert.ok(!m.has(ot.legExposureKey(leg({ lineId: 'promo-line', startTime: FUT }))),
    'no-uuid confirms are not PX-verified risk of ours');
});

test('QUOTE mode team screen counts in-flight confirm reservations (reachable screen)', () => {
  const legs = [leg({ lineId: 'screen-a', startTime: FUT }), leg({ lineId: 'screen-b', startTime: FUT })];
  ot.reserveConfirmingLegRisk('screen-p1', legs, 6000);
  const r = ot.checkLegExposure(legs, 5000, 6000);
  assert.equal(r.allowed, false, 'a line filled to the cap by an in-flight confirm must stop quoting');
  ot.releaseConfirmingLegRisk('screen-p1');
  assert.equal(ot.checkLegExposure(legs, 5000, 6000).allowed, true);
});

test('prop lines use the tighter maxExposurePerLegProp ceiling', () => {
  assert.equal(config.pricing.maxExposurePerLegProp, 1500, 'prop line ceiling keeps its own calibration');
  const PROP = { lineId: 'prop-ceiling', teamName: 'Some Player', marketType: 'player_rebounds', line: 7.5, startTime: FUT };
  const partner = leg({ lineId: 'prop-partner', startTime: FUT });
  const id = 'prop-open';
  ot.recordQuote(id, [{ line_id: 'prop-ceiling', fairProb: 0.5, startTime: FUT }], 150, 100, 0.5, {});
  ot.recordConfirmation(id, 'uuid-propc', 200, 1500);
  // Open 1500 on the prop line. The PROP ceiling (1500) must bind even though
  // the team cap passed in is 6000 — at quote time via the full-line screen...
  const q = ot.checkLegExposure([leg(PROP), partner], 5000, 6000);
  assert.equal(q.allowed, false, 'prop ceiling must bind at 1500, not 6000: ' + (q.reason || ''));
  assert.equal(q.limit, 1500);
  // ...and at confirm time against the actual stake.
  const c = ot.checkLegExposure([leg(PROP), partner], 5000, 6000, { mode: 'confirm', actualRisk: 1 });
  assert.equal(c.allowed, false, 'confirm must also enforce the 1500 prop ceiling');
  assert.equal(c.limit, 1500);
});
