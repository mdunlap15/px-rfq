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

test('tick: a leg is read inside the lead window, a leg past start+grace is recorded missed, then the ticket finalizes', async () => {
  const now = Date.parse('2026-10-13T20:00:00Z');
  const o = order([
    { lineId: 'L1', fairProb: 0.50, startTime: new Date(now + 60e3).toISOString() },        // starts in 1 min -> read now
    { lineId: 'L2', fairProb: 0.40, startTime: new Date(now + 2 * 3600e3).toISOString() },  // 2h -> later
  ], 0.20);
  const saved = { open: ot.getOpenConfirmedOrders, price: pricer.priceParlay };
  ot.getOpenConfirmedOrders = () => [o];
  pricer.priceParlay = (ids, opts) => {
    assert.ok(opts && opts.fairOnly, 'game-time reads use fairOnly');
    return { fairOnly: true, legs: [{ lineId: ids[0], fairProb: ids[0] === 'L1' ? 0.56 : 0.40, fairSource: 'ob_direct', ageSec: 12 }] };
  };
  try {
    await gametime.tick(now);
    assert.strictEqual(o.meta.gameTime.legs.L1.fair, 0.56);
    assert.strictEqual(o.meta.gameTime.legs.L1.src, 'ob_direct');
    assert.ok(!o.meta.gameTime.legs.L2, 'not yet inside the lead window');
    assert.ok(!o.meta.gameTime.finalizedAt);
    // the trader "was down" across L2's start: first seen 10 min after it
    await gametime.tick(now + 2 * 3600e3 + 10 * 60e3);
    assert.strictEqual(o.meta.gameTime.legs.L2.fair, null);
    assert.match(o.meta.gameTime.legs.L2.reason, /missed/);
    assert.ok(o.meta.gameTime.finalizedAt, 'finalized once every leg has an entry');
    assert.ok(Math.abs(o.meta.gameTime.fairProb - 0.20 * 0.56 / 0.50) < 1e-6);
    assert.strictEqual(o.meta.gameTime.coverage, 0.5);
  } finally { ot.getOpenConfirmedOrders = saved.open; pricer.priceParlay = saved.price; }
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
