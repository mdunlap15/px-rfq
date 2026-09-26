// TEAM / GAME CAP REWORK + DEDUP RE-QUOTE (2026-09-26).
//
// 1. Phantom reservations. Every open quote reserved the full max risk
//    ($6,000) against its teams and game, counted at the 0.1 discount, so ~10
//    open quotes darked a team with ~$0 real exposure (Texas dark 13:25–16:00Z,
//    202 network parlays / $38.1K at <= $240 confirmed). Now the quote screen
//    reads confirmed + in-flight CONFIRMS only, the offer's max_risk is capped
//    at the remaining headroom, and the confirm check is EXACT (it used to
//    discount the confirming ticket ×0.1 too, so the "hard" cap was soft).
// 2. Dedup. The identical re-send ~3s after a preview is the real order
//    (filled 128/704 vs 3/704 for the preview), so it is re-priced instead of
//    declined; only re-sends beyond DEDUP_MAX_REQUOTES decline.
//
// Run: node --test test/team-cap-reservations.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const orderTracker = require('../services/order-tracker');
const templateExposure = require('../services/template-exposure');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const pricer = require('../services/pricer');
const { config } = require('../config');

const START = new Date(Date.now() + 6 * 3600e3).toISOString();
let evSeq = 0;
function leg(team, ev, fairProb = 0.5) {
  const lineInfo = { teamName: team, pxEventId: ev, startTime: START, homeTeam: team, awayTeam: 'Opp ' + ev, fairProb };
  return { team, fairProb, lineInfo, pxEventId: ev, startTime: START };
}
function freshPair() {
  const n = ++evSeq;
  return [leg('Team' + n + 'A', 'TC-EV' + n + 'a'), leg('Team' + n + 'B', 'TC-EV' + n + 'b')];
}

const KEYS = ['maxRawExposurePerTeam', 'maxExposurePerTeam', 'maxExposurePerGame', 'useRawPerTeamExposure',
  'exposureOverridesPerTeam', 'rawExposureOverridesPerTeam', 'dedupMaxRequotes', 'maxRiskPerParlay', 'maxOdds'];
const saved = {};
function setCaps() {
  for (const k of KEYS) saved[k] = config.pricing[k];
  config.pricing.maxRawExposurePerTeam = 6000;
  config.pricing.maxExposurePerTeam = 8500;
  config.pricing.maxExposurePerGame = 15000;
  config.pricing.useRawPerTeamExposure = false;
  config.pricing.exposureOverridesPerTeam = {};
  config.pricing.rawExposureOverridesPerTeam = {};
  config.pricing.dedupMaxRequotes = 1;
}
function restore() { for (const k of KEYS) config.pricing[k] = saved[k]; }

test('REGRESSION: 30 open quote reservations no longer dark a team with no real exposure', () => {
  setCaps();
  try {
    const legs = freshPair();
    for (let i = 0; i < 30; i++) {
      orderTracker.reservePending('tc-phantom-' + i, orderTracker.buildPendingReservation(legs, 6000, 60));
    }
    const team = orderTracker.checkExposureLimits(legs, 6000, 8500, { mode: 'quote' });
    assert.strictEqual(team.allowed, true, 'quote screen must ignore quote-time reservations: ' + team.reason);
    const game = orderTracker.checkGameExposure(legs, 6000, 15000, { mode: 'quote' });
    assert.strictEqual(game.allowed, true, 'game screen too: ' + game.reason);
    // Default mode is quote (callers that pass no opts get the screen, not exact).
    assert.strictEqual(orderTracker.checkExposureLimits(legs, 6000, 8500).allowed, true);
    for (let i = 0; i < 30; i++) orderTracker.releasePending('tc-phantom-' + i);
  } finally { restore(); }
});

test('confirm mode is EXACT on the raw hard cap (no discount on the confirming ticket)', () => {
  setCaps();
  try {
    const legs = freshPair();
    orderTracker.reserveConfirmingExposure('tc-c1', legs, 5000);
    const over = orderTracker.checkExposureLimits(legs, 1500, 8500, { mode: 'confirm' });
    assert.strictEqual(over.allowed, false, '5000 in flight + 1500 actual > 6000 must reject');
    assert.strictEqual(over.violations[0].capType, 'raw_hard');
    assert.strictEqual(over.violations[0].wouldBe, 6500);
    const under = orderTracker.checkExposureLimits(legs, 900, 8500, { mode: 'confirm' });
    assert.strictEqual(under.allowed, true, '5000 + 900 = 5900 <= 6000 passes');
    const self = orderTracker.checkExposureLimits(legs, 1500, 8500, { mode: 'confirm', excludeParlayId: 'tc-c1' });
    assert.strictEqual(self.allowed, true, 'a ticket never counts against itself');
    orderTracker.releaseConfirmingExposure('tc-c1');
    assert.strictEqual(orderTracker.checkExposureLimits(legs, 1500, 8500, { mode: 'confirm' }).allowed, true, 'release clears it');
  } finally { restore(); }
});

test('in-flight confirms close the race: the second confirm on a team sees the first', () => {
  setCaps();
  try {
    const legs = freshPair();
    assert.strictEqual(orderTracker.checkExposureLimits(legs, 4000, 8500, { mode: 'confirm', excludeParlayId: 'tc-r1' }).allowed, true);
    orderTracker.reserveConfirmingExposure('tc-r1', legs, 4000);
    const second = orderTracker.checkExposureLimits(legs, 3000, 8500, { mode: 'confirm', excludeParlayId: 'tc-r2' });
    assert.strictEqual(second.allowed, false, '4000 + 3000 > 6000');
    orderTracker.releaseConfirmingExposure('tc-r1');
  } finally { restore(); }
});

test('quote mode darks a team only once it is actually full (>=)', () => {
  setCaps();
  try {
    const legs = freshPair();
    orderTracker.reserveConfirmingExposure('tc-full', legs, 5999);
    assert.strictEqual(orderTracker.checkExposureLimits(legs, 6000, 8500, { mode: 'quote' }).allowed, true, '$1 of headroom still quotes');
    orderTracker.reserveConfirmingExposure('tc-full', legs, 6000);
    const full = orderTracker.checkExposureLimits(legs, 6000, 8500, { mode: 'quote' });
    assert.strictEqual(full.allowed, false, 'full team stops quoting');
    assert.match(full.reason, /raw-hard/);
    orderTracker.releaseConfirmingExposure('tc-full');
  } finally { restore(); }
});

test('game cap: confirm exact, quote screen ignores quote reservations', () => {
  setCaps();
  try {
    const legs = freshPair();
    // weighted game charge per leg = risk × otherProb (0.5)
    orderTracker.reserveConfirmingExposure('tc-g1', legs, 20000);   // 10,000 weighted on each game
    assert.strictEqual(orderTracker.checkGameExposure(legs, 12000, 15000, { mode: 'confirm' }).allowed, false, '10000 + 6000 > 15000');
    assert.strictEqual(orderTracker.checkGameExposure(legs, 8000, 15000, { mode: 'confirm' }).allowed, true, '10000 + 4000 <= 15000');
    orderTracker.releaseConfirmingExposure('tc-g1');
  } finally { restore(); }
});

test('headroom: offer max_risk is capped at what the tightest cap can still absorb', () => {
  setCaps();
  try {
    const legs = freshPair();
    assert.ok(orderTracker.getExposureHeadroom(legs, { maxPerTeam: 8500, maxPerGame: 15000 }).maxRisk >= 6000, 'empty book: raw cap binds at 6000');
    orderTracker.reserveConfirmingExposure('tc-h1', legs, 5000);
    const hr = orderTracker.getExposureHeadroom(legs, { maxPerTeam: 8500, maxPerGame: 15000 });
    assert.ok(Math.abs(hr.maxRisk - 1000) < 1e-6, `raw 6000 - 5000 = 1000, got ${hr.maxRisk}`);
    assert.strictEqual(hr.binding, 'raw_hard');
    // Weighted primary binds when the raw cap is off: (1000 - 5000×0.5) < 0 → 0.
    config.pricing.maxRawExposurePerTeam = 0;
    const w = orderTracker.getExposureHeadroom(legs, { maxPerTeam: 3000, maxPerGame: 0 });
    assert.ok(Math.abs(w.maxRisk - 1000) < 1e-6, `(3000 - 2500) / 0.5 = 1000, got ${w.maxRisk}`);
    assert.strictEqual(w.binding, 'team');
    orderTracker.releaseConfirmingExposure('tc-h1');
  } finally { restore(); }
});

// --- priceParlay integration: headroom reaches the offer, never the confirm reprice ---
const LINES = {};
function mkLine(ev) {
  const id = 'tc-line-' + ev;
  LINES[id] = {
    lineId: id, sport: 'baseball_mlb', marketType: 'moneyline',
    teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home',
    oddsApiMarket: 'h2h', oddsApiSport: 'baseball_mlb',
    homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev,
    pxEventId: ev, startTime: START, startTimeMs: Date.parse(START),
  };
  return id;
}
function stubPricing() {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb;
  saved.stale = oddsFeed.isStaleForEvent; saved.stalePre = oddsFeed.isEventStalePreGame;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.getFairProb = () => 0.4;
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlay = 3000;
  config.pricing.maxOdds = 50000;
}
function unstubPricing() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair;
  oddsFeed.isStaleForEvent = saved.stale; if (saved.stalePre) oddsFeed.isEventStalePreGame = saved.stalePre;
}
const infoLegs = (ids) => ids.map(id => ({ team: LINES[id].teamName, fairProb: 0.4, lineInfo: LINES[id] }));

test('priceParlay caps the offered max_risk at headroom; the confirm reprice ignores it', async () => {
  setCaps(); stubPricing();
  try {
    const ids = [mkLine('TCP1'), mkLine('TCP2')];
    orderTracker.reserveConfirmingExposure('tc-p-conf', infoLegs(ids), 5500);
    const q = await pricer.priceParlay(ids, { parlayId: 'tc-p-q' });
    try { orderTracker.releasePending('tc-p-q'); templateExposure.releasePending('tc-p-q'); } catch (_) {}
    assert.ok(q && q.meta, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
    assert.ok(q.meta.maxRisk <= 500 + 1e-6, `max_risk must be capped at 6000 - 5500 = 500, got ${q.meta.maxRisk}`);
    assert.strictEqual(q.meta.exposureHeadroomBinding, 'raw_hard');
    const r = await pricer.priceParlay(ids, { skipTemplateRamp: true });
    assert.ok(r && r.meta, 'confirm reprice must still price');
    assert.strictEqual(r.meta.exposureHeadroom, null, 'no headroom on the confirm reprice');
    assert.strictEqual(r.meta.maxRisk, 3000);
    orderTracker.reserveConfirmingExposure('tc-p-conf', infoLegs(ids), 6000);
    const full = await pricer.priceParlay(ids, { parlayId: 'tc-p-full' });
    assert.strictEqual(full, null, 'a full team does not quote');
    assert.strictEqual(pricer.priceParlay._lastFailure.reason, 'team exposure limit');
    orderTracker.releaseConfirmingExposure('tc-p-conf');
  } finally { unstubPricing(); restore(); }
});

// --- dedup ---
test('dedup: the first identical re-send is re-priced, the next one declines', () => {
  setCaps(); stubPricing();
  try {
    const ids = [mkLine('TCD1'), mkLine('TCD2')];
    const rfqLegs = ids.map(id => ({ line_id: id }));
    orderTracker.recordParlaySignature(ids.map(id => ({ lineId: id })), 'tc-d-preview');
    const d1 = orderTracker.checkRecentDuplicate(rfqLegs);
    assert.deepStrictEqual([d1.priorParlayId, d1.requotes], ['tc-d-preview', 0]);
    const s1 = pricer.shouldDecline(rfqLegs, 'tc-d-place');
    assert.notStrictEqual(s1 && s1.reason, 'duplicate parlay', 'the placement re-send must not dedup-decline');
    orderTracker.recordParlaySignature(ids.map(id => ({ lineId: id })), 'tc-d-place');
    const s2 = pricer.shouldDecline(rfqLegs, 'tc-d-third');
    assert.strictEqual(s2 && s2.reason, 'duplicate parlay', 'a third copy inside the window is flood-guarded');
    config.pricing.dedupMaxRequotes = 0;
    const ids0 = [mkLine('TCD3'), mkLine('TCD4')];
    orderTracker.recordParlaySignature(ids0.map(id => ({ lineId: id })), 'tc-d0');
    assert.strictEqual(pricer.shouldDecline(ids0.map(id => ({ line_id: id })), 'x').reason, 'duplicate parlay',
      'DEDUP_MAX_REQUOTES=0 restores decline-every-repeat');
  } finally { unstubPricing(); restore(); }
});

test('releaseQuoteReservations frees the superseded quote’s exposure and template slots', () => {
  setCaps();
  try {
    const legs = freshPair();
    orderTracker.reservePending('tc-rel', orderTracker.buildPendingReservation(legs, 6000, 60));
    const k = orderTracker.buildPendingReservation(legs, 6000, 60).teamKeys[0].key;
    assert.ok(orderTracker.getPendingTeamRisk(k) > 0, 'precondition: exposure pending reserved');
    const tLegs = legs.map(l => ({ team: l.team, market: 'moneyline', line: null }));
    templateExposure.getRampDecision(tLegs, { parlayId: 'tc-rel', estStake: 100 });
    assert.strictEqual(templateExposure.getExposure(tLegs).pendingCount, 1, 'precondition: template slot reserved');
    orderTracker.releaseQuoteReservations('tc-rel');
    assert.strictEqual(templateExposure.getExposure(tLegs).pendingCount, 0, 'template pending slot released');
    assert.strictEqual(orderTracker.getPendingTeamRisk(k), 0, 'exposure pending released');
  } finally { restore(); }
});

// =====================================================================
// Adversarial-review regressions (2026-09-26)
// =====================================================================

// Meta-shaped leg as recordQuote / handleConfirm see it.
function metaLeg(id, team, ev, extra = {}) {
  return Object.assign({ lineId: id, team, teamName: team, pxEventId: ev, startTime: START,
    fairProb: 0.5, market: 'moneyline', marketType: 'moneyline', selection: 'home',
    homeTeam: team, awayTeam: 'Opp ' + ev }, extra);
}
const asCheck = (metaLegs) => metaLegs.map(l => ({ ...l, lineInfo: l, team: l.team, fairProb: l.fairProb }));

test('REAL confirmed exposure (recordConfirmation -> accumulator) drives the caps and headroom', () => {
  setCaps();
  try {
    const legs = [metaLeg('rc-a', 'RealA', 'RC-EV1'), metaLeg('rc-b', 'RealB', 'RC-EV2')];
    orderTracker.recordQuote('tc-real-1', legs, 100, 5000, 0.25, { legs });
    orderTracker.recordConfirmation('tc-real-1', 'tc-uuid-real-1', -100, 5000);
    const chk = asCheck(legs);
    assert.strictEqual(orderTracker.checkExposureLimits(chk, 1500, 8500, { mode: 'confirm' }).allowed, false, '5000 booked + 1500 > 6000');
    assert.strictEqual(orderTracker.checkExposureLimits(chk, 1000, 8500, { mode: 'confirm' }).allowed, true, '5000 + 1000 lands exactly on the cap (>)');
    const hr = orderTracker.getExposureHeadroom(chk, { maxPerTeam: 8500, maxPerGame: 15000 });
    assert.ok(Math.abs(hr.maxRisk - 1000) < 1e-6, 'headroom reads the booked 5000: ' + hr.maxRisk);
  } finally { restore(); }
});

test('a confirm reservation stops counting once its order has landed (no double count)', () => {
  setCaps();
  try {
    const legs = [metaLeg('dc-a', 'DblA', 'DC-EV1'), metaLeg('dc-b', 'DblB', 'DC-EV2')];
    const chk = asCheck(legs);
    orderTracker.recordQuote('tc-dbl', legs, 100, 4000, 0.25, { legs });
    orderTracker.reserveConfirmingExposure('tc-dbl', chk, 4000);          // e.g. acceptUnknown hold keeps it
    orderTracker.recordConfirmation('tc-dbl', 'tc-uuid-dbl', -100, 4000);  // lands in the accumulator
    const other = orderTracker.checkExposureLimits(chk, 1500, 8500, { mode: 'confirm', excludeParlayId: 'tc-other' });
    assert.strictEqual(other.allowed, true, '4000 once + 1500 = 5500 <= 6000, not 9500: ' + other.reason);
    orderTracker.releaseConfirmingExposure('tc-dbl');
  } finally { restore(); }
});

test('game cap: quote mode ignores quote reservations and darks only a full game; confirm boundary is >', () => {
  setCaps();
  try {
    const legs = freshPair();
    for (let i = 0; i < 40; i++) orderTracker.reservePending('tc-gq-' + i, orderTracker.buildPendingReservation(legs, 6000, 60));
    assert.strictEqual(orderTracker.checkGameExposure(legs, 6000, 15000, { mode: 'quote' }).allowed, true, '40 open quotes do not dark the game');
    orderTracker.reserveConfirmingExposure('tc-gq-c', legs, 20000);          // 10,000 weighted per game
    assert.strictEqual(orderTracker.checkGameExposure(legs, 10000, 15000, { mode: 'confirm' }).allowed, true, '10000 + 5000 lands exactly on the cap');
    assert.strictEqual(orderTracker.checkGameExposure(legs, 10002, 15000, { mode: 'confirm' }).allowed, false, 'a dollar over rejects');
    orderTracker.reserveConfirmingExposure('tc-gq-c', legs, 30000);          // 15,000 weighted = full
    assert.strictEqual(orderTracker.checkGameExposure(legs, 0, 15000, { mode: 'quote' }).allowed, false, 'a full game stops quoting');
    orderTracker.releaseConfirmingExposure('tc-gq-c');
    for (let i = 0; i < 40; i++) orderTracker.releasePending('tc-gq-' + i);
  } finally { restore(); }
});

test('game cap charges same-game legs in ONE market:selection bucket as a SUM (as the book lands them)', () => {
  setCaps();
  try {
    config.pricing.maxRawExposurePerTeam = 0;
    const ev = 'TC-SGB';
    const legs = [
      metaLeg('sg-a', 'Player A', ev, { market: 'player_hitter_hits', marketType: 'player_hitter_hits', selection: 'over', fairProb: 0.6 }),
      metaLeg('sg-b', 'Player B', ev, { market: 'player_hitter_hits', marketType: 'player_hitter_hits', selection: 'over', fairProb: 0.6 }),
    ];
    const chk = asCheck(legs);
    // each leg charges risk x 0.6; same bucket -> 1.2 per $ of risk
    const hr = orderTracker.getExposureHeadroom(chk, { maxPerTeam: 0, maxPerGame: 2500 });
    assert.ok(Math.abs(hr.maxRisk - 2500 / 1.2) < 1e-6, 'game headroom = 2500 / 1.2, got ' + hr.maxRisk + ' (' + hr.binding + ')');
    assert.strictEqual(orderTracker.checkGameExposure(chk, 2500 / 1.2 + 5, 2500, { mode: 'confirm' }).allowed, false, 'the summed charge is what the check enforces');
    assert.strictEqual(orderTracker.checkGameExposure(chk, 2500 / 1.2 - 5, 2500, { mode: 'confirm' }).allowed, true);
  } finally { restore(); }
});

test('headroom honours per-team raw overrides and the game dimension', () => {
  setCaps();
  try {
    const legs = freshPair();
    config.pricing.rawExposureOverridesPerTeam = { [legs[0].team]: 2000 };
    const hr = orderTracker.getExposureHeadroom(legs, { maxPerTeam: 8500, maxPerGame: 15000 });
    assert.strictEqual(hr.maxRisk, 2000, 'raw override tightens the offer');
    assert.strictEqual(hr.binding, 'raw_hard');
    config.pricing.rawExposureOverridesPerTeam = {};
    config.pricing.maxRawExposurePerTeam = 0;
    const g = orderTracker.getExposureHeadroom(legs, { maxPerTeam: 0, maxPerGame: 900 });
    assert.ok(Math.abs(g.maxRisk - 1800) < 1e-6, 'game 900 / 0.5 = 1800, got ' + g.maxRisk);
    assert.strictEqual(g.binding, 'game');
  } finally { restore(); }
});

test('full-game TOTALS: headroom and the quote screen read the key the book writes', async () => {
  setCaps(); stubPricing();
  try {
    const ev = 'TC-TOT';
    const tid = 'tc-line-total-' + ev;
    // NHL, not MLB: MLB alt totals hit the unrelated 'alt-total blocked' gate first.
    LINES[tid] = { lineId: tid, sport: 'icehockey_nhl', marketType: 'total', line: 6.5,
      teamName: 'over', selection: 'over', oddsApiSelection: 'over', oddsApiMarket: 'totals', oddsApiSport: 'icehockey_nhl',
      homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev, startTime: START, startTimeMs: Date.parse(START) };
    const q1 = await pricer.priceParlay([tid, mkLine('TC-TOT2')], { parlayId: 'tc-tot-q1' });
    try { orderTracker.releasePending('tc-tot-q1'); templateExposure.releasePending('tc-tot-q1'); } catch (_) {}
    assert.ok(q1 && q1.meta, 'prices: ' + JSON.stringify(pricer.priceParlay._lastFailure));
    const booked = q1.meta.legs.find(l => l.lineId === tid).team;
    assert.strictEqual(booked, 'Over (Away TC-TOT @ Home TC-TOT)', 'meta label unchanged by the refactor');
    orderTracker.reserveConfirmingExposure('tc-tot-conf', asCheck(q1.meta.legs), 5500);
    const q2 = await pricer.priceParlay([tid, mkLine('TC-TOT3')], { parlayId: 'tc-tot-q2' });
    try { orderTracker.releasePending('tc-tot-q2'); templateExposure.releasePending('tc-tot-q2'); } catch (_) {}
    assert.ok(q2 && q2.meta.maxRisk <= 500 + 1e-6, 'totals bucket at 5500/6000 must cap max_risk at 500, got ' + (q2 && q2.meta.maxRisk));
    orderTracker.reserveConfirmingExposure('tc-tot-conf', asCheck(q1.meta.legs), 6000);
    const d = pricer.shouldDecline([{ line_id: tid }, { line_id: mkLine('TC-TOT4') }], 'tc-tot-sd');
    assert.strictEqual(d && d.reason, 'team exposure limit', 'a full totals bucket stops quoting: ' + JSON.stringify(d));
    orderTracker.releaseConfirmingExposure('tc-tot-conf');
  } finally { unstubPricing(); restore(); }
});

test('offer stake cap is floored from the published odds, so a max-stake fill never exceeds max risk', async () => {
  setCaps(); stubPricing();
  try {
    for (let k = 0; k < 6; k++) {
      const ids = [mkLine('TCS' + k + 'a'), mkLine('TCS' + k + 'b'), mkLine('TCS' + k + 'c')];
      orderTracker.reserveConfirmingExposure('tc-sc-' + k, infoLegs(ids), 5000 + 97 * k);
      const r = await pricer.priceParlay(ids, { parlayId: 'tc-sc-q' + k });
      try { orderTracker.releasePending('tc-sc-q' + k); templateExposure.releasePending('tc-sc-q' + k); } catch (_) {}
      assert.ok(r, 'prices: ' + JSON.stringify(pricer.priceParlay._lastFailure));
      const am = r.offer.odds;
      const perStake = am > 0 ? am / 100 : 100 / Math.abs(am);
      assert.ok(r.offer.max_risk * perStake <= r.meta.maxRisk + 1e-6,
        'stake ' + r.offer.max_risk + ' x ' + perStake + ' must be <= max risk ' + r.meta.maxRisk);
      orderTracker.releaseConfirmingExposure('tc-sc-' + k);
    }
  } finally { unstubPricing(); restore(); }
});

test('confirm reprice (validateForConfirmation) passes when THIS ticket takes the team to its cap', async () => {
  setCaps(); stubPricing();
  try {
    const ids = [mkLine('TCV1'), mkLine('TCV2')];
    const q = await pricer.priceParlay(ids, { parlayId: 'tc-v-q' });
    try { orderTracker.releasePending('tc-v-q'); templateExposure.releasePending('tc-v-q'); } catch (_) {}
    assert.ok(q && q.meta);
    // handleConfirm order: exact checks pass -> reserveConfirmingExposure(own stake) -> validateForConfirmation
    orderTracker.reserveConfirmingExposure('tc-v-q', infoLegs(ids), 6000);
    const v = await pricer.validateForConfirmation('tc-v-q', q.meta);
    assert.ok(v && v.valid !== false, 'the reprice must not re-run the cap: ' + JSON.stringify(v));
    orderTracker.releaseConfirmingExposure('tc-v-q');
  } finally { unstubPricing(); restore(); }
});

test('in-flight confirm lane: a second confirm of the same signature is blocked until the first exits', () => {
  const tLegs = [{ team: 'LaneA', market: 'moneyline', line: null }, { team: 'LaneB', market: 'moneyline', line: null }];
  const saveCd = config.pricing.templateRampCooldownSeconds;
  config.pricing.templateRampCooldownSeconds = 60;
  try {
    assert.strictEqual(templateExposure.checkConfirmCooldown(tLegs, 'lane-1').block, false);
    templateExposure.reserveConfirmingSignature(tLegs, 'lane-1');
    assert.strictEqual(templateExposure.checkConfirmCooldown(tLegs, 'lane-1').block, false, 'never blocks itself');
    const b = templateExposure.checkConfirmCooldown(tLegs, 'lane-2');
    assert.strictEqual(b.block, true, 'concurrent confirm of the same parlay is rejected');
    assert.match(b.reason, /inflight/);
    templateExposure.releaseConfirmingSignature('lane-1');
    assert.strictEqual(templateExposure.checkConfirmCooldown(tLegs, 'lane-2').block, false, 'released on exit');
  } finally { config.pricing.templateRampCooldownSeconds = saveCd; }
});

test('another SP filling our quoted RFQ releases its quote reservations', () => {
  setCaps();
  try {
    const legs = [metaLeg('os-a', 'OspA', 'OS-EV1'), metaLeg('os-b', 'OspB', 'OS-EV2')];
    orderTracker.recordQuote('tc-osp', legs, 250, 6000, 0.25, { legs });
    const res = orderTracker.buildPendingReservation(asCheck(legs), 6000, 60);
    orderTracker.reservePending('tc-osp', res);
    const k = res.teamKeys[0].key;
    assert.ok(orderTracker.getPendingTeamRisk(k) > 0);
    orderTracker.recordMatchedParlay('tc-osp', -180, 900, legs.map(l => ({ line_id: l.lineId })), null); // not our price
    assert.strictEqual(orderTracker.getPendingTeamRisk(k), 0, 'released on other_sp');
  } finally { restore(); }
});

test('a TIE on order.matched past a cap does not raise the loud override (most likely another SP)', () => {
  setCaps();
  try {
    const legs = [metaLeg('ti-a', 'TieA', 'TI-EV1'), metaLeg('ti-b', 'TieB', 'TI-EV2')];
    orderTracker.recordQuote('tc-tie', legs, 264, 3000, 0.25, { legs, maxRisk: 3000 });
    orderTracker.reserveConfirmingExposure('tc-tie-other', asCheck(legs), 5800);
    orderTracker.recordMatchedParlay('tc-tie', -264, 4000, legs.map(l => ({ line_id: l.lineId })), null);
    const o = orderTracker.findByParlayId('tc-tie');
    assert.ok(o, 'order exists');
    assert.ok(!(o.meta && o.meta.exposureOverrideOnMatch), 'no [EXPOSURE OVERRIDE] on a tie');
    orderTracker.releaseConfirmingExposure('tc-tie-other');
  } finally { restore(); }
});

test('dedup: DEDUP_MAX_REQUOTES defaults to 1, 0 is honoured, and the signature carries the creator', () => {
  const prev = process.env.DEDUP_MAX_REQUOTES;
  // Keep the ORIGINAL config module: services lazily require('../config'), so
  // leaving a fresh instance cached would split config objects for later tests.
  const cfgPath = require.resolve('../config');
  const origCfg = require.cache[cfgPath];
  try {
    delete process.env.DEDUP_MAX_REQUOTES;
    delete require.cache[require.resolve('../config')];
    assert.strictEqual(require('../config').config.pricing.dedupMaxRequotes, 1);
    process.env.DEDUP_MAX_REQUOTES = '0';
    delete require.cache[require.resolve('../config')];
    assert.strictEqual(require('../config').config.pricing.dedupMaxRequotes, 0);
  } finally {
    if (prev == null) delete process.env.DEDUP_MAX_REQUOTES; else process.env.DEDUP_MAX_REQUOTES = prev;
    require.cache[cfgPath] = origCfg;
  }
  assert.strictEqual(require('../config').config, config, 'original config module restored');
  orderTracker.recordParlaySignature([{ lineId: 'cr-1' }, { lineId: 'cr-2' }], 'tc-cr-p', 'creator-abc');
  const d = orderTracker.checkRecentDuplicate([{ line_id: 'cr-1' }, { line_id: 'cr-2' }]);
  assert.strictEqual(d.priorCreatorId, 'creator-abc');
});

test('quote mode charges NO increment on the weighted cap either (size is bounded by headroom instead)', () => {
  setCaps();
  try {
    const legs = freshPair();
    orderTracker.reserveConfirmingExposure('tc-qw', legs, 5000);   // 2,500 weighted on each team
    // A 4,000 weighted cap has 1,500 of room: the quote must go out (headroom
    // sizes it to 3,000 of risk), not be declined for a speculative $6,000 ticket.
    assert.strictEqual(orderTracker.checkExposureLimits(legs, 6000, 4000, { mode: 'quote' }).allowed, true);
    const hr = orderTracker.getExposureHeadroom(legs, { maxPerTeam: 4000, maxPerGame: 0 });
    assert.ok(Math.abs(hr.maxRisk - 1000) < 1e-6, 'raw 6000-5000 binds before weighted (4000-2500)/0.5=3000: ' + hr.maxRisk);
    orderTracker.releaseConfirmingExposure('tc-qw');
  } finally { restore(); }
});
