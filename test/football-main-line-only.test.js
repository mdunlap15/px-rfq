// NFL/CFB GAME LINES — MAIN NUMBER ONLY (operator directive 2026-10-01).
//
// The single-leg order-book posters (nfl_game_cycle.py / cfb_cycle.py →
// nfl_pre_post.py) list ONE number per point-bearing game market: the
// consensus main. px-rfq registered PX's whole bundled alt ladder (~43 spread /
// ~35 total points per game). These tests pin: main kept, alts dropped (full
// game, 1H, Q1, team totals; NFL + CFB), moneyline untouched, unknown main →
// market skipped, on-demand alt refused, kill-switch restores the ladder,
// non-football unchanged.
//
// Run: node --test test/football-main-line-only.test.js

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const fml = require('../services/football-main-line');
const lm = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const nflConsensus = require('../services/nfl-consensus');
const { config } = require('../config');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

const NFL = 'americanfootball_nfl';
const CFB = 'americanfootball_ncaaf';
const HOME = 'Kansas City Chiefs';
const AWAY = 'Denver Broncos';

// odds-feed consensus shape (buildConsensusSpread/Totals/TeamTotals): spread
// `line` is the HOME point.
function oddsEvt() {
  return {
    markets: {
      h2h: { home: {}, away: {} },
      spreads: { line: -3.5, home: { point: -3.5 }, away: { point: 3.5 } },
      totals: { line: 44.5 },
      spreads_h1: { line: -1.5 },
      totals_h1: { line: 22 },
      spreads_q1: { line: -0.5 },
      totals_q1: { line: 9.5 },
      team_totals: { home: { line: 24.5 }, away: { line: 20.5 } },
    },
  };
}

let saved;
let seq = 0;
beforeEach(() => {
  saved = {
    gem: oddsFeed.getEventMarkets,
    nfl: nflConsensus.getMainLineSync,
    flag: config.pricing.footballGameMainOnly,
  };
  oddsFeed.getEventMarkets = () => oddsEvt();
  nflConsensus.getMainLineSync = () => null; // cold board → odds-feed fallback
  config.pricing.footballGameMainOnly = true;
});
afterEach(() => {
  oddsFeed.getEventMarkets = saved.gem;
  nflConsensus.getMainLineSync = saved.nfl;
  config.pricing.footballGameMainOnly = saved.flag;
});

function info(sport, oddsApiMarket, marketType, oddsApiSelection, line) {
  return {
    sport, oddsApiSport: sport, pxEventId: 'ev-' + sport, pxEventName: `${AWAY} @ ${HOME}`,
    marketType, oddsApiMarket, oddsApiSelection, selection: oddsApiSelection,
    line, homeTeam: HOME, awayTeam: AWAY, startTime: new Date(Date.now() + 3600e3).toISOString(),
  };
}
function seed(i, opts) {
  const id = `fml-test-${++seq}-${Date.now()}`;
  lm._setSeedLine(id, i, opts);
  return lm.lookupLine(id);
}

for (const sport of [NFL, CFB]) {
  test(`${sport}: full-game spread/total keep MAIN, drop alts`, () => {
    assert.ok(seed(info(sport, 'spreads', 'spread', 'home', -3.5)), 'home main');
    assert.ok(seed(info(sport, 'spreads', 'spread', 'away', 3.5)), 'away main (same number, other side)');
    assert.strictEqual(seed(info(sport, 'spreads', 'spread', 'home', -7.5)), null, 'alt spread dropped');
    assert.strictEqual(seed(info(sport, 'spreads', 'spread', 'away', -3.5)), null, 'opposite-sign same magnitude is an ALT');
    assert.ok(seed(info(sport, 'totals', 'total', 'over', 44.5)));
    assert.ok(seed(info(sport, 'totals', 'total', 'under', 44.5)));
    assert.strictEqual(seed(info(sport, 'totals', 'total', 'over', 47.5)), null, 'alt total dropped');
  });

  test(`${sport}: 1H and Q1 period markets keep MAIN, drop alts`, () => {
    assert.ok(seed(info(sport, 'spreads_h1', 'first_half_spread', 'home', -1.5)));
    assert.strictEqual(seed(info(sport, 'spreads_h1', 'first_half_spread', 'home', -2.5)), null);
    assert.ok(seed(info(sport, 'totals_h1', 'first_half_total', 'over', 22)));
    assert.strictEqual(seed(info(sport, 'totals_h1', 'first_half_total', 'over', 23.5)), null);
    assert.ok(seed(info(sport, 'spreads_q1', 'quarter_1_spread', 'away', 0.5)));
    assert.strictEqual(seed(info(sport, 'spreads_q1', 'quarter_1_spread', 'away', 1.5)), null);
    assert.ok(seed(info(sport, 'totals_q1', 'quarter_1_total', 'under', 9.5)));
    assert.strictEqual(seed(info(sport, 'totals_q1', 'quarter_1_total', 'under', 10.5)), null);
  });

  test(`${sport}: team totals keep each team's MAIN, drop alts`, () => {
    assert.ok(seed(info(sport, 'team_totals', 'team_total', 'home_over', 24.5)));
    assert.ok(seed(info(sport, 'team_totals', 'team_total', 'away_under', 20.5)));
    assert.strictEqual(seed(info(sport, 'team_totals', 'team_total', 'home_over', 20.5)), null, "away's main is an alt for home");
    assert.strictEqual(seed(info(sport, 'team_totals', 'team_total', 'away_over', 21.5)), null);
  });

  test(`${sport}: moneyline untouched`, () => {
    assert.ok(seed(info(sport, 'h2h', 'moneyline', 'home', null)));
    assert.ok(seed(info(sport, 'h2h_h1', 'first_half_moneyline', 'away', null)));
  });
}

test('nfl-consensus main (poster method) takes precedence over odds-feed modal line', () => {
  nflConsensus.getMainLineSync = (sport, h, a, type, team) => {
    if (type === 'spread') return -3;
    if (type === 'team_total') return team === HOME ? 23.5 : null;
    return null;
  };
  assert.ok(seed(info(NFL, 'spreads', 'spread', 'home', -3)));
  assert.strictEqual(seed(info(NFL, 'spreads', 'spread', 'home', -3.5)), null, 'odds-feed number is now an alt');
  assert.ok(seed(info(NFL, 'team_totals', 'team_total', 'home_over', 23.5)));
  assert.ok(seed(info(NFL, 'team_totals', 'team_total', 'away_over', 20.5)), 'away falls back to odds-feed');
});

test('unknown main → market registers NOTHING (fail closed); moneyline still registers', () => {
  oddsFeed.getEventMarkets = () => ({ markets: { h2h: {}, spreads: { line: null }, totals: {} } });
  assert.strictEqual(seed(info(NFL, 'spreads', 'spread', 'home', -3.5)), null);
  assert.strictEqual(seed(info(NFL, 'totals', 'total', 'over', 44.5)), null);
  assert.strictEqual(seed(info(NFL, 'team_totals', 'team_total', 'home_over', 24.5)), null);
  oddsFeed.getEventMarkets = () => null;
  assert.strictEqual(seed(info(CFB, 'spreads_q1', 'quarter_1_spread', 'home', -0.5)), null);
  assert.ok(seed(info(CFB, 'h2h', 'moneyline', 'home', null)));
});

test('PX point choice: exact, else nearest within 0.5 if unique, else none', () => {
  assert.deepStrictEqual(fml.choosePxPoint(44.5, [43.5, 44.5, 45.5]), { point: 44.5 });
  assert.deepStrictEqual(fml.choosePxPoint(44, [42.5, 44.5, 46.5]), { point: 44.5 });
  assert.strictEqual(fml.choosePxPoint(44, [43.5, 44.5]), null, 'tie fails closed');
  assert.strictEqual(fml.choosePxPoint(44, [42.5, 45.5]), null, 'nothing within 0.5');
  assert.strictEqual(fml.choosePxPoint(null, [44]), null);
  // through the seed: PX posts 44.5 only near a 44 main
  oddsFeed.getEventMarkets = () => ({ markets: { totals: { line: 44 } } });
  const px = { totals: [41.5, 44.5, 47.5] };
  assert.ok(seed(info(NFL, 'totals', 'total', 'over', 44.5), { pxPointsByFamily: px }));
  assert.strictEqual(seed(info(NFL, 'totals', 'total', 'over', 41.5), { pxPointsByFamily: px }), null);
  // without PX points (cache restore / virtual) only an EXACT main restores
  assert.strictEqual(seed(info(NFL, 'totals', 'total', 'over', 44.5)), null);
});

test('_footballPxPointsByFamily builds home-perspective spread points + per-team totals', () => {
  const parsed = [
    { marketType: 'spread', teamName: HOME, line: -3.5 },
    { marketType: 'spread', teamName: AWAY, line: 3.5 },
    { marketType: 'spread', teamName: AWAY, line: -1.5 },
    { marketType: 'total', selection: 'over', line: 44.5 },
    { marketType: 'moneyline', teamName: HOME, line: null },
  ];
  const m = lm._footballPxPointsByFamily(parsed, NFL, HOME, AWAY);
  assert.deepStrictEqual(m.spreads.sort(), [-3.5, -3.5, 1.5].sort());
  assert.deepStrictEqual(m.totals, [44.5]);
  assert.strictEqual(m.h2h, undefined);
  assert.strictEqual(lm._footballPxPointsByFamily(parsed, 'basketball_nba', HOME, AWAY), null);
  assert.strictEqual(lm._footballPxPointsByFamily(parsed, 'americanfootball_cfl', HOME, AWAY), null, 'CFL unchanged');
});

test('kill-switch false restores the full ladder', () => {
  config.pricing.footballGameMainOnly = false;
  assert.ok(seed(info(NFL, 'spreads', 'spread', 'home', -10.5)));
  assert.ok(seed(info(CFB, 'totals_h1', 'first_half_total', 'over', 30.5)));
  oddsFeed.getEventMarkets = () => null;
  assert.ok(seed(info(CFB, 'team_totals', 'team_total', 'home_over', 40.5)), 'no main needed when off');
});

test('kill-switch is a runtime-config bool key wired to FOOTBALL_GAME_MAIN_ONLY', () => {
  const rc = fs.readFileSync(path.join(__dirname, '..', 'services', 'runtime-config.js'), 'utf8');
  assert.ok(/key: 'footballGameMainOnly', path: 'footballGameMainOnly', type: 'bool'[^\n]*env: 'FOOTBALL_GAME_MAIN_ONLY'/.test(rc));
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  assert.ok(cfg.includes("footballGameMainOnly: process.env.FOOTBALL_GAME_MAIN_ONLY !== 'false'"), 'default ON, literal false disables');
});

test('non-football sports and CFL are unchanged (alts still register)', () => {
  oddsFeed.getEventMarkets = () => ({ markets: { spreads: { line: -1.5 }, totals: { line: 8.5 } } });
  assert.ok(seed(info('baseball_mlb', 'spreads', 'spread', 'home', 1.5)));
  assert.ok(seed(info('basketball_nba', 'totals', 'total', 'over', 230.5)));
  assert.ok(seed(info('americanfootball_cfl', 'spreads', 'spread', 'home', -9.5)));
});

test('on-demand resolve + cache restore consult the gate BEFORE inserting', () => {
  const onDemandInsert = SRC.indexOf('lineIndex[lineId] = foundInfo;');
  const onDemandGate = SRC.lastIndexOf('_footballMainRefusal(foundInfo', onDemandInsert);
  assert.ok(onDemandGate > -1 && onDemandGate < onDemandInsert, 'on-demand (incl. virtual alt registration) refuses before inserting');
  assert.ok(SRC.lastIndexOf('reason: _fbRefusal', onDemandInsert) > onDemandGate, 'refusal is recorded as a resolve failure (decline)');
  const restore = SRC.indexOf('lineIndex[lineId] = cached;');
  const restoreGate = SRC.lastIndexOf('_footballMainRefusal(cached)', restore);
  assert.ok(restoreGate > -1 && restoreGate < restore, 'cache restore refuses before inserting');
  // seed main loop passes PX's posted points; hydration goes through _setSeedLine too
  assert.ok(SRC.includes('}, { pxPointsByFamily: fbPxPoints });'));
});

test('on-demand: a football alt is refused, the main admitted (helper level)', () => {
  const parsed = [
    { marketType: 'total', selection: 'over', line: 44.5 },
    { marketType: 'total', selection: 'over', line: 51.5 },
  ];
  const px = lm._footballPxPointsByFamily(parsed, NFL, HOME, AWAY);
  assert.strictEqual(lm._footballMainRefusal(info(NFL, 'totals', 'total', 'over', 51.5), px), 'football_alt_line');
  assert.strictEqual(lm._footballMainRefusal(info(NFL, 'totals', 'total', 'over', 44.5), px), null);
  // virtual registration: no PX points → exact only
  assert.strictEqual(lm._footballMainRefusal(Object.assign(info(NFL, 'totals', 'total', 'over', 47.5), { virtualRegistration: true })), 'football_alt_line');
});

test('nfl-consensus: team-total MAIN per team = median of main-key points snapped to .5 (poster team_totals())', () => {
  const book = (k, pts) => ({ key: k, markets: [{ key: 'team_totals', outcomes: pts.flatMap(([team, p]) => [
    { name: 'Over', description: team, point: p, price: -110 },
    { name: 'Under', description: team, point: p, price: -110 },
  ]) }] });
  const board = nflConsensus.buildBoard({ home_team: HOME, away_team: AWAY, bookmakers: [
    book('a', [[HOME, 24.5], [AWAY, 20.5]]), book('b', [[HOME, 24.5], [AWAY, 20.5]]), book('c', [[HOME, 25.5], [AWAY, 21]]),
  ] }, { minBooks: 1 });
  assert.deepStrictEqual(board.markets.team_total.teamMainLines, { [HOME]: 24.5, [AWAY]: 20.5 });
});
