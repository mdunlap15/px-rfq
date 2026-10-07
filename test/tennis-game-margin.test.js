// Tennis game spread / total games at the ORDER BOOK's margins (2026-10-06).
// Operator: "open tennis spreads and totals with the same margins we use for the
// order book lines" (poster-service tennis_sets_post: raw mirror, never shorter
// than fair, game-spread min EV 6% / 8% dog).
// Run: node --test test/tennis-game-margin.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUT = new Date(Date.now() + 5 * 3600e3).toISOString();
const L = {};
function leg(id, ev, marketType, sel, line) {
  L[id] = { lineId: id, sport: 'tennis', oddsApiSport: 'tennis', marketType, oddsApiMarket: marketType === 'spread' ? 'spreads' : (marketType === 'total' ? 'totals' : 'h2h'),
    selection: sel, oddsApiSelection: sel, line, teamName: sel, homeTeam: 'Player H ' + ev, awayTeam: 'Player A ' + ev,
    pxEventId: ev, startTime: FUT, startTimeMs: Date.parse(FUT) };
  return id;
}
const saved = {};
function stub(fairs, pin = {}) {
  saved.lookup = lineManager.lookupLine; saved.fair = oddsFeed.getFairProb; saved.stale = oddsFeed.isStaleForEvent;
  saved.pre = oddsFeed.isEventStalePreGame; saved.pin = oddsFeed.getPinnacleOdds; saved.cap = config.pricing.maxRiskPerParlay;
  saved.maxOdds = config.pricing.maxOdds; saved.en = config.pricing.tennisGameMarginEnabled; saved.relay = config.pricing.obRelayEnabled;
  lineManager.lookupLine = (id) => L[id] || null;
  oddsFeed.getFairProb = (sport, home, away, market, selection, line) => {
    const id = Object.keys(L).find(k => L[k].homeTeam === home && L[k].oddsApiSelection === selection && L[k].oddsApiMarket === market);
    return fairs[id] != null ? fairs[id] : 0.5;
  };
  oddsFeed.getPinnacleOdds = (...a) => {
    const [sport, home, away, market, selection] = a;
    const id = Object.keys(L).find(k => L[k].homeTeam === home && L[k].oddsApiSelection === selection && L[k].oddsApiMarket === market);
    return pin[id] != null ? pin[id] : null;
  };
  oddsFeed.isStaleForEvent = () => false;
  if (oddsFeed.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  config.pricing.maxRiskPerParlay = 3000; config.pricing.maxOdds = 50000; config.pricing.obRelayEnabled = false;
}
function restore() {
  lineManager.lookupLine = saved.lookup; oddsFeed.getFairProb = saved.fair; oddsFeed.isStaleForEvent = saved.stale;
  if (saved.pre) oddsFeed.isEventStalePreGame = saved.pre; oddsFeed.getPinnacleOdds = saved.pin;
  config.pricing.maxRiskPerParlay = saved.cap; config.pricing.maxOdds = saved.maxOdds;
  config.pricing.tennisGameMarginEnabled = saved.en; config.pricing.obRelayEnabled = saved.relay;
}
async function price(ids, pid) {
  const r = await pricer.priceParlay(ids, { parlayId: pid });
  try { orderTracker.releasePending(pid); } catch (_) {}
  assert.ok(r && r.meta, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
  return r.meta;
}
const near = (a, b) => Math.abs(a - b) < 1e-4;

test('game spread, bettor on the favourite (we hold the dog): >= 8% EV on our side', async () => {
  const a = leg('ts1', 'T1', 'spread', 'home', -3.5), b = leg('ts2', 'T2', 'spread', 'home', -2.5);
  stub({ ts1: 0.55, ts2: 0.45 });
  try {
    const m = await price([a, b], 'tg-1');
    const l1 = m.legs.find(l => l.lineId === a), l2 = m.legs.find(l => l.lineId === b);
    assert.ok(near(l1.bookPriceOverride, (0.55 + 0.08) / 1.08), `fav leg ${l1.bookPriceOverride}`);
    assert.ok(near(l2.bookPriceOverride, (0.45 + 0.06) / 1.06), `dog leg ${l2.bookPriceOverride} (we hold the fav: 6%)`);
  } finally { restore(); }
});

test('game spread: the books\' raw price wins when it is already longer than the EV floor', async () => {
  const a = leg('ts3', 'T3', 'spread', 'home', -3.5), b = leg('ts4', 'T4', 'moneyline', 'home', null);
  stub({ ts3: 0.45, ts4: 0.5 }, { ts3: -160 });           // raw 61.5% > floor 48.1%
  try {
    const m = await price([a, b], 'tg-2');
    assert.ok(near(m.legs.find(l => l.lineId === a).bookPriceOverride, 160 / 260));
    assert.strictEqual(m.legs.find(l => l.lineId === b).bookPriceOverride, null, 'tennis moneyline untouched');
  } finally { restore(); }
});

test('total games: raw mirror, never below fair, no extra EV floor', async () => {
  const a = leg('tt1', 'T5', 'total', 'over', 22.5), b = leg('tt2', 'T6', 'total', 'under', 21.5);
  stub({ tt1: 0.52, tt2: 0.50 }, { tt1: -115 });           // raw 53.5%; tt2 has no book price
  try {
    const m = await price([a, b], 'tg-3');
    assert.ok(near(m.legs.find(l => l.lineId === a).bookPriceOverride, 115 / 215));
    assert.ok(near(m.legs.find(l => l.lineId === b).bookPriceOverride, 0.50), 'no raw → fair (never below it)');
  } finally { restore(); }
});

test('kill switch: tennisGameMarginEnabled=false leaves the legs on the normal vig path', async () => {
  const a = leg('tk1', 'T7', 'spread', 'home', -3.5), b = leg('tk2', 'T8', 'total', 'over', 22.5);
  stub({ tk1: 0.55, tk2: 0.5 });
  config.pricing.tennisGameMarginEnabled = false;
  try {
    const m = await price([a, b], 'tg-4');
    assert.ok(m.legs.every(l => l.bookPriceOverride == null));
  } finally { restore(); }
});
