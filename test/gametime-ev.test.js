// Game-time EV + closed-hole chart filter (2026-10-13). Operator: EV should be
// "what it was at gametime", not at fill; and the Rolling P&L vs EV chart needs
// a toggle that hides shapes we no longer write.
// Run: node --test test/gametime-ev.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const ot = require('../services/order-tracker');
const pricer = require('../services/pricer');
const gametime = require('../services/gametime-ev');
const { config } = require('../config');

function order(legs, fill, q = 0.3, risk = 700) {
  return { parlayId: 'gt-' + Math.round(fill * 1e6), status: 'confirmed', confirmedStake: risk, fairParlayProb: fill,
    meta: { legs, offeredImpliedProb: q, fairParlayProb: fill } };
}

test('combine: ticket fair = fill fair x product(game-time / fill) over captured legs; SGP factor preserved', () => {
  // fill fair 0.30 = 0.5 x 0.5 x 1.2 (correlation factor)
  const o = order([{ lineId: 'a', fairProb: 0.5 }, { lineId: 'b', fairProb: 0.5 }], 0.30);
  const c = gametime.combine(o, { a: { fair: 0.55 }, b: { fair: null, reason: 'missed' } });
  assert.ok(Math.abs(c.fairProb - 0.33) < 1e-9, `got ${c.fairProb}`);
  assert.strictEqual(c.coverage, 0.5);
  const S = 700 * 0.3 / 0.7;
  assert.ok(Math.abs(c.ev - ((1 - 0.33) * S - 0.33 * 700)) < 0.01);
  // EV at the fill fair equals the stored-EV convention
  assert.ok(Math.abs(gametime.evAt(o, 0.30) - ((0.7) * S - 0.3 * 700)) < 1e-9);
});

test('EV live: periodic reads, fast lane near start, freeze 90 s before each leg, never in-play, then game time', async () => {
  const now = Date.parse('2026-10-13T20:00:00Z');
  const o = order([
    { lineId: 'L1', fairProb: 0.50, startTime: new Date(now + 60e3).toISOString() },        // starts in 1 min -> inside the 90 s freeze lead
    { lineId: 'L2', fairProb: 0.40, startTime: new Date(now + 2 * 3600e3).toISOString() },  // 2h out -> live
  ], 0.20);
  const saved = { open: ot.getOpenConfirmedOrders, cand: ot.getEvLiveCandidates, price: pricer.priceParlay };
  let l2 = 0.40, reads = { L1: 0, L2: 0 };
  ot.getOpenConfirmedOrders = () => [o]; ot.getEvLiveCandidates = () => [o];
  pricer.priceParlay = (ids, opts) => {
    assert.ok(opts && opts.fairOnly, 'EV-live reads use fairOnly');
    reads[ids[0]]++;
    return { fairOnly: true, legs: [{ lineId: ids[0], fairProb: ids[0] === 'L1' ? 0.56 : l2, fairSource: 'ob_direct', ageSec: 12 }] };
  };
  try {
    await gametime.tick(now);
    assert.strictEqual(o.meta.evLive.legs.L1.frozen, true, 'L1 inside the freeze lead: read once and frozen');
    assert.strictEqual(o.meta.evLive.legs.L1.fair, 0.56);
    assert.strictEqual(o.meta.evLive.legs.L2.frozen, false, 'L2 2h out: live');
    assert.ok(Math.abs(o.meta.evLive.fairProb - 0.20 * 0.56 / 0.50) < 1e-6, 'EV live combines the reads so far');
    assert.ok(!o.meta.gameTime || !o.meta.gameTime.finalizedAt);
    await gametime.tick(now + 60e3);
    assert.deepStrictEqual(reads, { L1: 1, L2: 1 }, 'not due: no re-read inside 300 s; a frozen leg is never re-read');
    l2 = 0.42;
    await gametime.tick(now + 6 * 60e3);
    assert.strictEqual(o.meta.evLive.legs.L2.fair, 0.42, 're-read every 300 s');
    l2 = 0.43;
    const st2 = now + 2 * 3600e3;
    await gametime.tick(st2 - 20 * 60e3);
    await gametime.tick(st2 - 19 * 60e3);
    assert.strictEqual(reads.L2, 4, 'fast lane: every tick inside 30 min of start');
    l2 = 0.99;                                       // the in-play price must never land
    await gametime.tick(st2 - 60e3);
    assert.strictEqual(o.meta.evLive.legs.L2.frozen, true);
    assert.strictEqual(o.meta.evLive.legs.L2.fair, 0.43, 'frozen at the last pre-start read, no new read at freeze');
    await gametime.tick(st2 + 30 * 60e3);
    assert.strictEqual(o.meta.evLive.legs.L2.fair, 0.43, 'never graded in-play');
    assert.ok(o.meta.gameTime && o.meta.gameTime.finalizedAt, 'all legs frozen -> game time');
    assert.ok(Math.abs(o.meta.gameTime.fairProb - 0.20 * (0.56 / 0.50) * (0.43 / 0.40)) < 1e-6);
    assert.strictEqual(o.meta.gameTime.coverage, 1);
    assert.strictEqual(o.meta.gameTime.legs.L2.fillFair, 0.40);
  } finally { ot.getOpenConfirmedOrders = saved.open; ot.getEvLiveCandidates = saved.cand; pricer.priceParlay = saved.price; }
});

test('EV live: a leg first seen after start + grace is missed and counts at its fill fair', async () => {
  const now = Date.parse('2026-10-13T20:00:00Z');
  const o = order([{ lineId: 'M1', fairProb: 0.5, startTime: new Date(now - 10 * 60e3).toISOString() },
    { lineId: 'M2', fairProb: 0.5, startTime: new Date(now + 30e3).toISOString() }], 0.25);
  const saved = { open: ot.getOpenConfirmedOrders, cand: ot.getEvLiveCandidates, price: pricer.priceParlay };
  ot.getOpenConfirmedOrders = () => [o]; ot.getEvLiveCandidates = () => [o];
  pricer.priceParlay = (ids) => ({ fairOnly: true, legs: [{ lineId: ids[0], fairProb: 0.6 }] });
  try {
    await gametime.tick(now);
    assert.match(o.meta.evLive.legs.M1.reason, /missed/);
    assert.ok(o.meta.gameTime.finalizedAt);
    assert.strictEqual(o.meta.gameTime.coverage, 0.5);
    assert.ok(Math.abs(o.meta.gameTime.fairProb - 0.25 * 0.6 / 0.5) < 1e-6);
  } finally { ot.getOpenConfirmedOrders = saved.open; ot.getEvLiveCandidates = saved.cand; pricer.priceParlay = saved.price; }
});

test('openBookSummary: EV fill vs EV live over open fills that have been graded', () => {
  const a = order([{ lineId: 'S1', fairProb: 0.5 }], 0.3); a.expectedValue = 40; a.meta.evLive = { ev: 25, coverage: 1, legs: {} };
  const b = order([{ lineId: 'S2', fairProb: 0.5 }], 0.3); b.expectedValue = 10;                       // not graded yet
  const saved = ot.getOpenConfirmedOrders;
  ot.getOpenConfirmedOrders = () => [a, b];
  try {
    const s = gametime.openBookSummary();
    assert.deepStrictEqual([s.openFills, s.graded, s.unread, s.evFill, s.evFillGraded, s.evLive, s.change], [2, 1, 1, 50, 40, 25, -15]);
  } finally { ot.getOpenConfirmedOrders = saved; }
});

test('gameTimeEvFor precedence: re-read at start > closing line > fill EV', () => {
  const base = { confirmedStake: 700, fairParlayProb: 0.25, meta: { offeredImpliedProb: 0.3 } };
  const legsClose = [{ fairProb: 0.5, closingImpliedProb: 0.55 }, { fairProb: 0.5, closingImpliedProb: 0.5 }];
  const g1 = gametime.gameTimeEvFor({ ...base, meta: { ...base.meta, gameTime: { finalizedAt: 'x', ev: -12.5 } }, legs: legsClose }, 5);
  assert.deepStrictEqual([g1.source, g1.ev], ['gametime', -12.5]);
  const g2 = gametime.gameTimeEvFor({ ...base, legs: legsClose }, 5);
  assert.strictEqual(g2.source, 'close');
  assert.ok(Math.abs(g2.ev - gametime.evAt(base, 0.25 * 1.1)) < 1e-9);
  const g3 = gametime.gameTimeEvFor({ ...base, legs: [{ fairProb: 0.5 }] }, 5);
  assert.deepStrictEqual([g3.source, g3.ev], ['fill', 5]);
});

test('priceParlay fairOnly: a stale near-start leg returns its fair WITH its age instead of declining', async () => {
  const start = new Date(Date.now() + 30 * 60e3).toISOString();
  const li = { lineId: 'fo1', sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb', marketType: 'moneyline', oddsApiMarket: 'h2h',
    teamName: 'Home', selection: 'home', oddsApiSelection: 'home', homeTeam: 'Home', awayTeam: 'Away', pxEventId: 'FO-E',
    startTime: start, startTimeMs: Date.parse(start) };
  const saved = { lookup: lineManager.lookupLine, fair: oddsFeed.getFairProb, age: oddsFeed.getLegOddsAgeSec, stale: oddsFeed.isStaleForEvent, pre: oddsFeed.isEventStalePreGame, cfg: { ...config.pricing } };
  lineManager.lookupLine = (id) => (id === 'fo1' ? li : null);
  oddsFeed.getFairProb = () => 0.62;
  oddsFeed.getLegOddsAgeSec = () => 900;              // 15 min old, inside 30 min of start
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  Object.assign(config.pricing, { obRelayEnabled: false, freshGateEnabled: true, freshGateWindowMin: 180, freshGateMaxAgeSec: 120 });
  try {
    const normal = await pricer.priceParlay(['fo1', 'fo1'], { parlayId: 'fo-normal' });
    assert.strictEqual(normal, null, 'the quote path declines it');
    assert.strictEqual(pricer.getLastPriceFailure().reason, 'stale_near_start');
    const r = await pricer.priceParlay(['fo1'], { fairOnly: true, skipTemplateRamp: true });
    assert.ok(r && r.fairOnly);
    assert.strictEqual(r.legs[0].fairProb, 0.62);
    assert.strictEqual(r.legs[0].ageSec, 900);
  } finally {
    lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.getLegOddsAgeSec = saved.age;
    oddsFeed.isStaleForEvent = saved.stale; if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre;
    for (const k of Object.keys(config.pricing)) if (!(k in saved.cfg)) delete config.pricing[k];
    Object.assign(config.pricing, saved.cfg);
  }
});

test('closedHoleOf: shapes we no longer write, judged against CURRENT config', () => {
  const cfb = (line) => ({ legs: [
    { sport: 'americanfootball_ncaaf', market: 'spread', line, pxEventId: 7 },
    { sport: 'americanfootball_ncaaf', market: 'total', line: 56.5, pxEventId: 7 }], meta: {} });
  assert.strictEqual(ot.closedHoleOf(cfb(-42.5)), 'cfb_blowout_sgp');
  assert.strictEqual(ot.closedHoleOf(cfb(-10.5)), null, 'small-spread CFB SGP still quotes');
  const k = { legs: [{ sport: 'baseball_mlb', market: 'player_strikeouts', pxEventId: 1 }, { sport: 'baseball_mlb', market: 'moneyline', pxEventId: 2 }], meta: {} };
  const saved = config.pricing.pitcherKPropsEnabled;
  config.pricing.pitcherKPropsEnabled = false;
  assert.strictEqual(ot.closedHoleOf(k), 'strikeout_props');
  config.pricing.pitcherKPropsEnabled = true;
  assert.strictEqual(ot.closedHoleOf(k), null, 're-opened shape is no longer "closed"');
  config.pricing.pitcherKPropsEnabled = saved;
  const nhl = { legs: [{ sport: 'icehockey_nhl', market: 'moneyline', pxEventId: 9 }, { sport: 'icehockey_nhl', market: 'total', pxEventId: 9 }], meta: {} };
  const savedB = config.pricing.sgpBlockedSports;
  config.pricing.sgpBlockedSports = ['icehockey_nhl'];
  assert.strictEqual(ot.closedHoleOf(nhl), 'blocked_sport_sgp');
  config.pricing.sgpBlockedSports = savedB;
  assert.strictEqual(ot.closedHoleOf({ legs: [{ sport: 'baseball_mlb', market: 'moneyline', pxEventId: 3 }], meta: {} }), null);
});

test('getEvCurve: excludeClosed drops closed-hole tickets and reports them; game-time series present', () => {
  const id = 'gt-cfb-' + Date.now(), uuid = id + '-u';
  const legs = [
    { lineId: id + 'a', team: 'Rutgers', market: 'spread', line: -42.5, sport: 'americanfootball_ncaaf', fairProb: 0.5, pxEventId: 'GT-CFB' },
    { lineId: id + 'b', team: 'Over', market: 'total', line: 56.5, sport: 'americanfootball_ncaaf', fairProb: 0.55, pxEventId: 'GT-CFB' }];
  ot.recordQuote(id, legs, 233, 6000, 0.32, { legs });
  ot.recordConfirmation(id, uuid, -233, 5811);
  ot.recordSettlement(uuid, 'lost', -5811, { trusted: true });
  const all = ot.getEvCurve(30);
  const ex = ot.getEvCurve(30, 1200, { excludeClosed: true });
  assert.strictEqual(all.n - ex.n, ex.excluded.n);
  assert.ok(ex.excluded.byHole.cfb_blowout_sgp && ex.excluded.byHole.cfb_blowout_sgp.n >= 1);
  assert.ok(Math.abs((all.realized - ex.realized) - ex.excluded.pnl) < 0.01, 'excluded P&L accounts for the difference');
  assert.ok(all.gameTimeSources && Number.isFinite(all.gameTimeEv));
  assert.ok(all.points.every(p => Number.isFinite(p.gt)));
});

test('getEvLeakSummary: per-leg families with each leg OWN $ move, coverage, and open-book EV fill vs EV live', () => {
  const id = 'leak-' + Date.now(), uuid = id + '-u';
  const legs = [
    { lineId: id + 'p', team: 'P', market: 'player_shots_on_goal', sport: 'icehockey_nhl', selection: 'over', fairProb: 0.5, pxEventId: 'LK1', startTime: new Date(Date.now() + 3600e3).toISOString() },
    { lineId: id + 'g', team: 'G', market: 'moneyline', sport: 'icehockey_nhl', selection: 'home', fairProb: 0.6, pxEventId: 'LK2', startTime: new Date(Date.now() + 3600e3).toISOString() }];
  ot.recordQuote(id, legs, 300, 5000, 0.3, { legs });
  ot.recordConfirmation(id, uuid, -300, 900);
  const o = ot.findByParlayId(id);
  o.expectedValue = 30; o.meta.expectedValue = 30;
  // only the prop leg moved; the game leg did not
  o.meta.gameTime = { finalizedAt: new Date().toISOString(), ev: 10, coverage: 1, legs: { [id + 'p']: { fair: 0.55, evDelta: 20, frozen: true }, [id + 'g']: { fair: 0.6, evDelta: 0, frozen: true } } };
  const s = ot.getEvLeakSummary(1);
  assert.ok(s.finalized >= 1);
  const prop = s.families.find(f => f.key === 'icehockey_nhl|player_shots_on_goal|over|near');
  const game = s.families.find(f => f.key === 'icehockey_nhl|moneyline|fav|near');
  assert.ok(prop && game, JSON.stringify(s.families.map(f => f.key)));
  assert.strictEqual(prop.evLeak, 20, 'the leg that moved carries the $');
  assert.strictEqual(game.evLeak, 0, 'a leg that never moved is not blamed');
  assert.strictEqual(prop.meanDriftPct, 10);
  assert.ok(s.fullCoverage.tickets >= 1);
  assert.ok(s.openBook && 'evLive' in s.openBook);
});

test('EV live keeps grading a ticket that settled EARLY (bettor already lost) until its last leg freezes', async () => {
  const id = 'early-' + Date.now(), uuid = id + '-u';
  const now = Date.now();
  const legs = [
    { lineId: id + 'a', team: 'A', market: 'moneyline', sport: 'icehockey_nhl', selection: 'home', fairProb: 0.5, pxEventId: 'EA', startTime: new Date(now - 3 * 3600e3).toISOString() },
    { lineId: id + 'b', team: 'B', market: 'moneyline', sport: 'icehockey_nhl', selection: 'home', fairProb: 0.4, pxEventId: 'EB', startTime: new Date(now + 10 * 60e3).toISOString() }];
  ot.recordQuote(id, legs, 400, 5000, 0.2, { legs, offeredImpliedProb: 0.21 });
  ot.recordConfirmation(id, uuid, -400, 500);
  ot.recordLegSettlement(uuid, { line_id: id + 'a', settlement_status: 'lost' }, { persist: false });
  ot.recordSettlement(uuid, 'won', 125, { trusted: true });          // settled early: leg b has not started
  const o = ot.findByParlayId(id);
  assert.ok(String(o.status).startsWith('settled_'));
  assert.ok(ot.getEvLiveCandidates(now).includes(o), 'a recently settled, not-finalized ticket is still an EV-live candidate');
  const savedPrice = pricer.priceParlay;
  pricer.priceParlay = (ids) => ({ fairOnly: true, legs: [{ lineId: ids[0], fairProb: 0.44 }] });
  try {
    await gametime.tick(now);
    assert.strictEqual(o.meta.evLive.legs[id + 'b'].fair, 0.44, 'the late leg is graded after the early settlement');
  } finally { pricer.priceParlay = savedPrice; }
});
