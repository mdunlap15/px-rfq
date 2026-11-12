// Order-book parity (2026-11-11). Run: node --test test/ob-parity.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');
const ob = require('../services/ob-parity');
const oddsFeed = require('../services/odds-feed');
const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const calib = require('../services/fair-calibration');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const li = (o) => Object.assign({ lineId: 'x', sport: 'basketball_nba', marketType: 'moneyline', oddsApiSelection: 'home', oddsApiMarket: 'h2h', startTime: inMin(600) }, o);

// ---- per-leg ask ---------------------------------------------------------
test('legAsk: NBA = exactly 4% EV on our side, moved either way; never below fair', () => {
  const f = 0.55;
  const a = ob.legAsk({ li: li({}), f, raw: 0.70, vigged: 0.6 });
  assert.ok(near(a.q, (f + 0.04) / 1.04), 'q = (f + e)/(1 + e) regardless of raw / vig');
  assert.strictEqual(a.rule, 'nba_ev4');
  // EV on our side at that price is exactly 4%: (q - f)/(1 - q)
  assert.ok(near((a.q - f) / (1 - a.q), 0.04, 1e-12));
});

test('legAsk: NFL / CFB game lines = raw mirror minus the 1pp concession, floored at fair', () => {
  const a = ob.legAsk({ li: li({ sport: 'americanfootball_nfl' }), f: 0.50, raw: 0.5238, vigged: 0.51 });
  assert.ok(near(a.q, 0.5138, 1e-9));
  const b = ob.legAsk({ li: li({ sport: 'americanfootball_ncaaf' }), f: 0.52, raw: 0.525, vigged: 0.53 });
  assert.ok(near(b.q, 0.52), 'raw - concession below fair -> fair');
  const c = ob.legAsk({ li: li({ sport: 'americanfootball_nfl' }), f: 0.5, raw: null, vigged: 0.512 });
  assert.ok(near(c.q, 0.512), 'no book raw -> RFQ per-leg vig');
});

test('legAsk: tennis raw - 0.5pp; tennis spreads left to their own block; NHL raw mirror; NHL prop under +3pp', () => {
  assert.ok(near(ob.legAsk({ li: li({ sport: 'tennis' }), f: 0.6, raw: 0.63 }).q, 0.625));
  assert.strictEqual(ob.legAsk({ li: li({ sport: 'tennis', marketType: 'spread' }), f: 0.6, raw: 0.63 }), null);
  assert.ok(near(ob.legAsk({ li: li({ sport: 'icehockey_nhl' }), f: 0.55, raw: 0.57 }).q, 0.57));
  const u = ob.legAsk({ li: li({ sport: 'icehockey_nhl', marketType: 'player_shots_on_goal', oddsApiSelection: 'under' }), f: 0.5, vigged: 0.51 });
  assert.ok(near(u.q, 0.54));
  const o = ob.legAsk({ li: li({ sport: 'icehockey_nhl', marketType: 'player_shots_on_goal', oddsApiSelection: 'over' }), f: 0.5, vigged: 0.51 });
  assert.ok(near(o.q, 0.51));
});

test('legAsk: soccer two-way >= 1.2% EV over the mirror; 3-way YES = exact consensus mirror; out-of-scope sport -> null', () => {
  const s = ob.legAsk({ li: li({ sport: 'soccer_epl' }), f: 0.5, raw: 0.501 });
  assert.ok(near(s.q, (0.5 + 0.012) / 1.012), 'EV floor binds above a thin mirror');
  assert.ok(near(ob.legAsk({ li: li({ sport: 'soccer_epl', marketType: 'soccer_win_3way' }), f: 0.4, raw: 0.43 }).q, 0.43));
  assert.strictEqual(ob.legAsk({ li: li({ sport: 'baseball_mlb' }), f: 0.5, raw: 0.52 }), null);
  config.pricing.obLegAskEnabled = false;
  try { assert.strictEqual(ob.legAsk({ li: li({}), f: 0.5 }), null); } finally { config.pricing.obLegAskEnabled = true; }
});

test('scorerYesAsk: TD / NHL goal YES between +300 and +999 costs raw + 3pp; deeper keeps raw; never below fair', () => {
  const td = li({ sport: 'americanfootball_nfl', marketType: 'player_anytime_td', oddsApiSelection: 'over' });
  assert.ok(near(ob.scorerYesAsk(td, 0.20, 0.18), 0.23));
  assert.ok(near(ob.scorerYesAsk(td, 0.05, 0.04), 0.05), 'past +999: no lengthening');
  assert.ok(near(ob.scorerYesAsk(li({ sport: 'icehockey_nhl', marketType: 'player_goal_scorer' }), 0.2, 0.25), 0.25), 'fair clamp');
  assert.strictEqual(ob.scorerYesAsk(li({ sport: 'basketball_nba', marketType: 'player_points' }), 0.2, 0.2), null);
});

// ---- gates -----------------------------------------------------------------
test('start cutoffs: NFL/NBA/NHL 30s, CFB 2 min, soccer 5 min, tennis 15 min, NFL 1Q 15 min; MLB none', () => {
  const g = (o, m) => ob.legGate(li(Object.assign({ startTime: inMin(m) }, o)), { fairProb: 0.5 });
  assert.strictEqual(g({ sport: 'americanfootball_nfl' }, 0.4).reason, 'ob_start_cutoff');
  assert.strictEqual(g({ sport: 'americanfootball_nfl' }, 0.6), null);
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf' }, 1.5).reason, 'ob_start_cutoff');
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf' }, 2.5), null);
  assert.strictEqual(g({ sport: 'soccer_epl' }, 4).reason, 'ob_start_cutoff');
  assert.strictEqual(g({ sport: 'tennis' }, 14).reason, 'ob_start_cutoff');
  assert.strictEqual(g({ sport: 'tennis' }, 16), null);
  assert.strictEqual(g({ sport: 'americanfootball_nfl', oddsApiMarket: 'spreads_q1' }, 14).reason, 'ob_start_cutoff');
  assert.strictEqual(g({ sport: 'americanfootball_nfl', oddsApiMarket: 'spreads_q1' }, 16), null);
  assert.strictEqual(g({ sport: 'basketball_ncaab' }, 0.3).reason, 'ob_start_cutoff');
  assert.strictEqual(g({ sport: 'baseball_mlb' }, 0.3), null);
});

test('windows: props / soccer / tennis exactly the order book; game lines unwindowed', () => {
  const g = (o, m, f = 0.4) => ob.legGate(li(Object.assign({ startTime: inMin(m) }, o)), { fairProb: f });
  assert.strictEqual(g({ marketType: 'player_points', oddsApiSelection: 'over' }, 25).reason, 'ob_window');
  assert.strictEqual(g({ marketType: 'player_points', oddsApiSelection: 'over' }, 15), null);
  assert.strictEqual(g({ sport: 'soccer_epl' }, 35).reason, 'ob_window');
  assert.strictEqual(g({ sport: 'soccer_epl' }, 25), null);
  assert.strictEqual(g({ sport: 'tennis' }, 200).reason, 'ob_window');
  assert.strictEqual(g({ sport: 'americanfootball_nfl', marketType: 'player_pass_yds', oddsApiSelection: 'over' }, 370).reason, 'ob_window');
  assert.strictEqual(g({ sport: 'americanfootball_nfl', marketType: 'player_pass_yds', oddsApiSelection: 'over' }, 350), null);
  assert.strictEqual(g({ sport: 'americanfootball_nfl', marketType: 'player_sacks', oddsApiSelection: 'over' }, 100).reason, 'ob_window');
  assert.strictEqual(g({ sport: 'americanfootball_nfl', marketType: 'player_anytime_td', oddsApiSelection: 'over' }, 700, 0.2), null);
  assert.strictEqual(g({ sport: 'icehockey_nhl', marketType: 'player_shots_on_goal', oddsApiSelection: 'over', propBooks: 6 }, 70).reason, 'ob_window');
  assert.strictEqual(g({}, 2000), null, 'NBA game line 33h out: no window');
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf' }, 2000), null);
  assert.strictEqual(ob.legGate(li({ sport: 'soccer_epl', startTime: null }), { fairProb: 0.4 }).reason, 'ob_window_unknown_start', 'unknown start fails closed');
  config.pricing.obWindows = { soccer: 60 };
  try { assert.strictEqual(g({ sport: 'soccer_epl' }, 35), null, 'runtime map merges over defaults'); } finally { config.pricing.obWindows = {}; }
});

test('odds limits are on the order book side (bettor heavy favourite)', () => {
  const g = (o, f) => ob.legGate(li(Object.assign({ startTime: inMin(200) }, o)), { fairProb: f });
  assert.strictEqual(g({ sport: 'icehockey_nhl' }, 0.76).reason, 'ob_odds_limit');
  assert.strictEqual(g({ sport: 'icehockey_nhl' }, 0.75).reason, 'ob_odds_limit', '+300 exactly is out');
  assert.strictEqual(g({ sport: 'icehockey_nhl' }, 0.74), null);
  assert.strictEqual(g({ sport: 'tennis', startTime: inMin(60) }, 0.81).reason, 'ob_odds_limit');
  assert.strictEqual(g({ sport: 'tennis', startTime: inMin(60) }, 0.79), null);
  assert.strictEqual(g({ sport: 'tennis', marketType: 'first_set_moneyline', startTime: inMin(60) }, 0.76).reason, 'ob_odds_limit');
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf', marketType: 'spread' }, 0.90).reason, 'ob_odds_limit');
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf', marketType: 'spread' }, 0.88), null);
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf' }, 0.18).reason, 'ob_odds_limit', 'CFB ML with the dog past +400 declines either side');
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf' }, 0.82).reason, 'ob_odds_limit');
  assert.strictEqual(g({ sport: 'americanfootball_nfl', marketType: 'player_anytime_td', oddsApiSelection: 'over', startTime: inMin(100) }, 0.30).reason, 'ob_odds_limit');
  assert.strictEqual(g({ sport: 'americanfootball_nfl', marketType: 'player_anytime_td', oddsApiSelection: 'over', startTime: inMin(100) }, 0.24), null);
  assert.strictEqual(g({ sport: 'basketball_nba' }, 0.9), null, 'NBA game lines: no odds limit');
});

test('prop book minimums at our point: CFB 4, NBA 4, NHL 5; unknown count does not gate', () => {
  const g = (o) => ob.legGate(li(Object.assign({ startTime: inMin(10), oddsApiSelection: 'over' }, o)), { fairProb: 0.5 });
  assert.strictEqual(g({ sport: 'icehockey_nhl', marketType: 'player_points', booksWithBothSides: 4 }).reason, 'ob_min_books');
  assert.strictEqual(g({ sport: 'icehockey_nhl', marketType: 'player_points', booksWithBothSides: 5 }), null);
  assert.strictEqual(g({ marketType: 'player_points', booksWithBothSides: 3 }).reason, 'ob_min_books');
  assert.strictEqual(g({ marketType: 'player_points', booksWithBothSides: 0, propBooks: 4 }), null, 'one-sided count');
  assert.strictEqual(g({ sport: 'americanfootball_ncaaf', marketType: 'player_pass_yds', booksWithBothSides: 3 }).reason, 'ob_min_books');
  assert.strictEqual(g({ marketType: 'player_points' }), null);
});

test('registration scope: tennis total games, NHL puck line / team / period totals, soccer double chance / team totals / 3-way NO', () => {
  const r = (o) => ob.registrationRefusal(li(Object.assign({ startTime: inMin(10) }, o)));
  assert.strictEqual(r({ sport: 'tennis', marketType: 'total' }), 'ob_market_off');
  assert.strictEqual(r({ sport: 'tennis', marketType: 'total_sets' }), null);
  assert.strictEqual(r({ sport: 'icehockey_nhl', marketType: 'spread' }), 'ob_market_off');
  assert.strictEqual(r({ sport: 'icehockey_nhl', marketType: 'team_total' }), 'ob_market_off');
  assert.strictEqual(r({ sport: 'icehockey_nhl', marketType: 'total', oddsApiMarket: 'totals_p1' }), 'ob_market_off');
  assert.strictEqual(r({ sport: 'icehockey_nhl', marketType: 'total', oddsApiMarket: 'totals' }), null);
  assert.strictEqual(r({ sport: 'soccer_epl', marketType: 'double_chance' }), 'ob_market_off');
  assert.strictEqual(r({ sport: 'soccer_epl', marketType: 'soccer_win_3way', oddsApiSelection: 'no_home' }), 'ob_market_off');
  assert.strictEqual(r({ sport: 'soccer_epl', marketType: 'soccer_win_3way', oddsApiSelection: 'home' }), null);
  assert.strictEqual(r({ sport: 'baseball_mlb', marketType: 'spread' }), null);
  config.pricing.obParityEnabled = false;
  try { assert.strictEqual(r({ sport: 'tennis', marketType: 'total' }), null, 'master switch'); } finally { config.pricing.obParityEnabled = true; }
});

test('large-fill hold: >= $1,000 of leg risk on a line inside 120 s holds it (and a prop player) for 5 min', () => {
  ob._resetForTest();
  const t0 = Date.parse('2026-11-11T20:00:00Z');
  const a = li({ lineId: 'A' }), b = li({ lineId: 'B', marketType: 'player_points', playerName: 'Jay Doe' });
  // 2 legs at 0.5: leg risk = ticket risk x 0.5
  assert.deepStrictEqual(ob.recordFill([{ lineInfo: a, fairProb: 0.5 }, { lineInfo: b, fairProb: 0.5 }], 1800, t0), []);
  const held = ob.recordFill([{ lineInfo: a, fairProb: 0.5 }, { lineInfo: li({ lineId: 'C' }), fairProb: 0.5 }], 300, t0 + 60e3);
  assert.deepStrictEqual(held, ['L:A'], '900 + 150 >= 1000 on A only');
  assert.ok(ob.holdFor(a, t0 + 100e3));
  assert.strictEqual(ob.legGate(Object.assign({}, a, { startTime: new Date(t0 + 600 * 60000).toISOString() }), { fairProb: 0.5, nowMs: t0 + 100e3 }).reason, 'ob_fill_hold');
  assert.strictEqual(ob.holdFor(a, t0 + 60e3 + 301e3), null, 'hold expires');
  // outside the window the earlier fill no longer counts
  ob._resetForTest();
  ob.recordFill([{ lineInfo: b, fairProb: 0.5 }, { lineInfo: a, fairProb: 0.5 }], 1800, t0);
  assert.deepStrictEqual(ob.recordFill([{ lineInfo: b, fairProb: 0.5 }, { lineInfo: a, fairProb: 0.5 }], 400, t0 + 121e3), []);
  // a prop hold covers every line of that player
  const held2 = ob.recordFill([{ lineInfo: b, fairProb: 0.5 }, { lineInfo: a, fairProb: 0.5 }], 2000, t0 + 130e3);
  assert.ok(held2.includes('P:basketball_nba|jay doe'));
  assert.ok(ob.holdFor(li({ lineId: 'Z', marketType: 'player_rebounds', playerName: 'Jay Doe' }), t0 + 140e3));
  ob._resetForTest();
});

test('ticket cap: a football leg >= 75% caps the ticket at $500', () => {
  assert.deepStrictEqual(ob.ticketCaps([{ lineInfo: li({ sport: 'americanfootball_ncaaf' }), fairProb: 0.8 }]).map(c => c.cap), [500]);
  assert.deepStrictEqual(ob.ticketCaps([{ lineInfo: li({ sport: 'americanfootball_nfl' }), fairProb: 0.7 }]), []);
  assert.deepStrictEqual(ob.ticketCaps([{ lineInfo: li({}), fairProb: 0.9 }]), []);
});

// ---- order-book fair method (odds-feed builders) -----------------------------
const imp = (a) => a > 0 ? 100 / (a + 100) : -a / (-a + 100);
const pair = (book, h, a) => ({ book, home: { odds_probability: imp(h), odds_american: h }, away: { odds_probability: imp(a), odds_american: a } });

test('fair method: median of per-book de-vig, one vote per distinct price, >= 3 books else Pinnacle', () => {
  const books = [pair('draftkings', -120, 100), pair('fanduel', -120, 100), pair('betmgm', -130, 110), pair('caesars', -110, -110), pair('pinnacle', -125, 112)];
  const r = oddsFeed._obFairPair(books, b => b.home.odds_probability, b => b.away.odds_probability, 'basketball_nba');
  assert.strictEqual(r.n, 4, 'DK and FD post the same pair: one vote');
  const dv = (h, a) => imp(h) / (imp(h) + imp(a));
  const vals = [dv(-120, 100), dv(-130, 110), dv(-110, -110), dv(-125, 112)].sort((x, y) => x - y);
  assert.ok(near(r.a, (vals[1] + vals[2]) / 2, 1e-12), 'median, not mean');
  const thin = oddsFeed._obFairPair([pair('draftkings', -120, 100), pair('pinnacle', -125, 112)], b => b.home.odds_probability, b => b.away.odds_probability, 'basketball_nba');
  assert.strictEqual(thin.method, 'pinnacle');
  assert.ok(near(thin.a, dv(-125, 112), 1e-12));
  const none = oddsFeed._obFairPair([pair('draftkings', -120, 100), pair('fanduel', -125, 105)], b => b.home.odds_probability, b => b.away.odds_probability, 'basketball_nba');
  assert.strictEqual(none.decline, true, 'two books, no Pinnacle: decline');
  assert.strictEqual(oddsFeed._obFairPair(books, b => b.home.odds_probability, b => b.away.odds_probability, 'baseball_mlb'), null, 'MLB untouched');
  assert.strictEqual(oddsFeed._obFairPair([pair('a', -120, 100), pair('b', -125, 105)], b => b.home.odds_probability, b => b.away.odds_probability, 'tennis').method, 'consensus', 'tennis needs 2');
});

test('fair method: Shin on a lopsided pair; NHL Pinnacle anchor + 2pp gap decline; CFB sharp composite; soccer less generous', () => {
  const g = [b => b.home.odds_probability, b => b.away.odds_probability];
  const lop = oddsFeed._obFairPair([pair('pinnacle', -600, 420)], ...g, 'basketball_nba');
  const prop = imp(-600) / (imp(-600) + imp(420));
  assert.ok(lop.a > prop, 'Shin gives the favourite more than proportional');
  const nhl = [pair('pinnacle', -150, 135), pair('draftkings', -140, 120), pair('fanduel', -142, 122), pair('betmgm', -145, 125)];
  const n1 = oddsFeed._obFairPair(nhl, ...g, 'icehockey_nhl');
  assert.strictEqual(n1.method, 'nhl_pin_anchor');
  const nhlGap = [pair('pinnacle', -200, 175), pair('draftkings', -140, 120), pair('fanduel', -142, 122), pair('betmgm', -145, 125)];
  assert.strictEqual(oddsFeed._obFairPair(nhlGap, ...g, 'icehockey_nhl').decline, true);
  const cfb = [pair('pinnacle', -150, 130), pair('betonlineag', -155, 135), pair('caesars', -170, 150), pair('betmgm', -175, 150), pair('bovada', -180, 155)];
  const c1 = oddsFeed._obFairPair(cfb, ...g, 'americanfootball_ncaaf');
  assert.strictEqual(c1.method, 'cfb_sharp_composite');
  const soc = [pair('pinnacle', -150, 130), pair('draftkings', -120, 100), pair('fanduel', -118, -102), pair('betmgm', -122, 102)];
  const s1 = oddsFeed._obFairPair(soc, ...g, 'soccer_epl');
  assert.strictEqual(s1.method, 'soccer_less_generous');
  assert.ok(s1.a + s1.b > 1, 'each side takes the higher of the two');
});

test('fair method in the builder: legacy fair kept as fairProbPreOb; switch off restores legacy; declined -> null fair', () => {
  const books = [pair('draftkings', -120, 100), pair('fanduel', -125, 105), pair('betmgm', -130, 110)];
  const on = oddsFeed.buildConsensusMoneyline(books, 'basketball_nba');
  assert.strictEqual(on.home.obFairMethod, 'consensus');
  assert.ok(on.home.fairProbPreOb > 0 && on.home.fairProb !== on.home.fairProbPreOb);
  config.pricing.obFairMethod = false;
  try {
    const off = oddsFeed.buildConsensusMoneyline(books, 'basketball_nba');
    assert.strictEqual(off.home.obFairMethod, undefined);
    assert.ok(near(off.home.fairProb, on.home.fairProbPreOb));
  } finally { config.pricing.obFairMethod = true; }
  const thin = oddsFeed.buildConsensusMoneyline(books.slice(0, 2), 'basketball_nba');
  assert.strictEqual(thin.home.fairProb, null);
  const legacy = oddsFeed.buildConsensusMoneyline(books.slice(0, 2));
  assert.ok(legacy.home.fairProb > 0, 'no sport -> legacy');
});

// ---- priceParlay integration --------------------------------------------------
const KEYS = ['twoLegBookMatchPercent', 'xgBookMatchPercent', 'crossGameFactorPercent', 'crossGameWidenPercent', 'twoLegFactorPercent', 'twoLegWidenPercent',
  'calibEnabled', 'minTheoEdgePct', 'maxRiskPerParlay', 'maxOdds', 'maxExposurePerTeam', 'maxExposurePerGame', 'maxRawExposurePerTeam', 'nbaCeilingPercent',
  'vigByLegCount', 'freshGateEnabled'];
const saved = {}, stubs = {};
const LINES = {};
function setup(o = {}) {
  for (const k of KEYS) saved[k] = config.pricing[k];
  Object.assign(config.pricing, { twoLegBookMatchPercent: 0, xgBookMatchPercent: 0, crossGameFactorPercent: 0, crossGameWidenPercent: 0, twoLegFactorPercent: 0,
    twoLegWidenPercent: 0, calibEnabled: false, minTheoEdgePct: 0, maxRiskPerParlay: 3000, maxOdds: 50000, maxExposurePerTeam: 1e9,
    maxExposurePerGame: 1e9, maxRawExposurePerTeam: 1e9, nbaCeilingPercent: 0, vigByLegCount: { 3: 1.5, 4: 2 }, freshGateEnabled: false }, o);
  calib.__setCellsForTest(new Map());
  for (const k of ['getFairProb', 'isStaleForEvent', 'isEventStalePreGame', 'getFanDuelOdds', 'getDraftKingsOdds', 'getPinnacleOdds']) stubs[k] = oddsFeed[k];
  stubs.lookup = lineManager.lookupLine;
  lineManager.lookupLine = (id) => LINES[id] || null;
  oddsFeed.isStaleForEvent = () => false;
  if (stubs.isEventStalePreGame) oddsFeed.isEventStalePreGame = () => false;
  oddsFeed.getPinnacleOdds = () => null;
}
function teardown() {
  for (const k of KEYS) config.pricing[k] = saved[k];
  for (const [k, v] of Object.entries(stubs)) if (k !== 'lookup') oddsFeed[k] = v;
  lineManager.lookupLine = stubs.lookup;
}
function mk(ev, sport, mins) {
  const id = 'obp-' + ev;
  const st = inMin(mins);
  LINES[id] = { lineId: id, sport, marketType: 'moneyline', teamName: 'Home ' + ev, selection: 'home', oddsApiSelection: 'home', oddsApiMarket: 'h2h',
    oddsApiSport: sport, homeTeam: 'Home ' + ev, awayTeam: 'Away ' + ev, pxEventId: ev, startTime: st, startTimeMs: Date.parse(st) };
  return id;
}

test('priceParlay: a 4-leg NBA cross-game parlay = product of the 4% EV asks; leg-count ladder no longer stacks', async () => {
  setup();
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const ids = ['N1', 'N2', 'N3', 'N4'].map(e => mk(e, 'basketball_nba', 300));
    const r = await pricer.priceParlay(ids, { parlayId: 'obp-nba-1' });
    assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
    const q = (0.5 + 0.04) / 1.04;
    assert.ok(near(r.meta.offeredImpliedProb, q ** 4, 2e-5), `${r.meta.offeredImpliedProb} vs ${q ** 4}`);
    assert.strictEqual(r.meta.obAskLegs, 4);
    assert.strictEqual(r.meta.legs[0].obAsk.rule, 'nba_ev4');
    assert.ok(near(r.meta.fairParlayProb, 0.0625, 1e-6), 'fair untouched');
    config.pricing.obParityEnabled = false;
    const legacy = await pricer.priceParlay(ids, { parlayId: 'obp-nba-1' });
    config.pricing.obParityEnabled = true;
    assert.ok(legacy.meta.offeredImpliedProb > r.meta.offeredImpliedProb, 'legacy x2 leg-count ladder was wider');
    assert.strictEqual(legacy.meta.obAskLegs, 0);
  } finally { teardown(); }
});

test('priceParlay: a leg inside the order book cutoff / outside its window declines with the ob reason; MLB legs keep RFQ pricing', async () => {
  setup();
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const r = await pricer.priceParlay([mk('C1', 'americanfootball_ncaaf', 1.5), mk('C2', 'basketball_nba', 300)], { parlayId: 'obp-c' });
    assert.strictEqual(r, null);
    assert.strictEqual(pricer.priceParlay._lastFailure.reason, 'ob_start_cutoff');
    const s = await pricer.priceParlay([mk('S1', 'soccer_epl', 90), mk('S2', 'basketball_nba', 300)], { parlayId: 'obp-s' });
    assert.strictEqual(s, null);
    assert.strictEqual(pricer.priceParlay._lastFailure.reason, 'ob_window');
    const m = await pricer.priceParlay([mk('M1', 'baseball_mlb', 300), mk('M2', 'basketball_nba', 300)], { parlayId: 'obp-m' });
    assert.ok(m && m.meta);
    assert.strictEqual(m.meta.obAskLegs, 1, 'only the NBA leg takes the order-book ask');
    // fairOnly reads are never gated
    const fo = await pricer.priceParlay([mk('C3', 'americanfootball_ncaaf', 1.5)], { fairOnly: true });
    assert.ok(fo && fo.fairOnly);
  } finally { teardown(); }
});

test('confirm: rejects when the re-priced EV fell below +0.5%, not a quote deliberately below it with no move', async () => {
  setup();
  try {
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const ids = ['V1', 'V2'].map(e => mk(e, 'basketball_nba', 300));
    oddsFeed.getFairProb = () => 0.5;
    const q = await pricer.priceParlay(ids, { parlayId: 'obp-v' });
    const legs = ids.map(id => ({ lineId: id }));
    const meta = Object.assign({}, q.meta, { legs: q.meta.legs });
    // fair moved against us so EV on the quote drops under 0.5% (but under the 1.5% adverse drift and 4% symmetric)
    const q0 = meta.offeredImpliedProb;
    const fNew = Math.sqrt(q0 - 0.004 * (1 - q0));
    oddsFeed.getFairProb = () => fNew;
    const saveAdv = config.pricing.confirmAdverseDriftThreshold;
    const saveDrift = config.pricing.confirmationDriftThreshold;
    config.pricing.confirmAdverseDriftThreshold = 0.5;
    config.pricing.confirmationDriftThreshold = 0.5;
    try {
      const v = await pricer.validateForConfirmation('obp-v', Object.assign({}, meta, { legs: ids.map(id => ({ lineId: id, fairProb: 0.5, startTime: LINES[id].startTime })) }));
      assert.strictEqual(v.valid, false, JSON.stringify(v.reason));
      assert.match(v.reason, /ob ev floor/);
      // a quote priced at EV 0.3% (below the floor) with NO fair move confirms
      oddsFeed.getFairProb = () => 0.5;
      const low = Object.assign({}, meta, { offeredImpliedProb: 0.25 + 0.003 * 0.75, legs: ids.map(id => ({ lineId: id, fairProb: 0.5, startTime: LINES[id].startTime })) });
      const v2 = await pricer.validateForConfirmation('obp-v', low);
      assert.strictEqual(v2.valid, true, JSON.stringify(v2.reason));
    } finally {
      config.pricing.confirmAdverseDriftThreshold = saveAdv;
      config.pricing.confirmationDriftThreshold = saveDrift;
    }
  } finally { teardown(); }
});

test('registration: the seed insert refuses a line the order book does not list, and admits it inside its window', () => {
  const t = Date.now();
  const far = lineManager._setSeedLine('obp-reg-far-' + t, { sport: 'soccer_epl', oddsApiSport: 'soccer_epl', marketType: 'total', selection: 'over', line: 2.5, startTime: inMin(120) });
  assert.strictEqual(far._marketDenied, true);
  assert.strictEqual(lineManager.lookupLine('obp-reg-far-' + t), null);
  lineManager._setSeedLine('obp-reg-near-' + t, { sport: 'soccer_epl', oddsApiSport: 'soccer_epl', marketType: 'total', selection: 'over', line: 2.5, startTime: inMin(20) });
  assert.ok(lineManager.lookupLine('obp-reg-near-' + t), 'inside T-30 it registers');
  const tg = lineManager._setSeedLine('obp-reg-tg-' + t, { sport: 'tennis', oddsApiSport: 'tennis', marketType: 'total', selection: 'over', line: 21.5, startTime: inMin(60) });
  assert.strictEqual(tg._marketDenied, true, 'tennis total games off');
});

test('calibration floor: kept on 2-leg all-OB parlays, skipped (EV-only) on 3+ legs', async () => {
  setup({ calibEnabled: true });
  const fm = config.pricing.calibFloorMult, mm = config.pricing.calibMinMarginPct;
  config.pricing.calibFloorMult = 1.1; config.pricing.calibMinMarginPct = 8;
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const q = (0.5 + 0.04) / 1.04;
    const three = await pricer.priceParlay(['K1', 'K2', 'K3'].map(e => mk(e, 'basketball_nba', 300)), { parlayId: 'obp-k3' });
    assert.ok(three && three.meta, JSON.stringify(pricer.priceParlay._lastFailure));
    assert.ok(near(three.meta.offeredImpliedProb, q ** 3, 2e-5), 'no calibration floor on 3 legs: ' + three.meta.offeredImpliedProb);
    assert.strictEqual(three.meta.calib.skipped, 'ob_parity');
    const two = await pricer.priceParlay(['K4', 'K5'].map(e => mk(e, 'basketball_nba', 300)), { parlayId: 'obp-k2' });
    assert.ok(two.meta.offeredImpliedProb >= 0.25 * 1.1 * 1.08 - 1e-6, '2 legs keep the floor: ' + two.meta.offeredImpliedProb);
  } finally { config.pricing.calibFloorMult = fm; config.pricing.calibMinMarginPct = mm; teardown(); }
});

test('relay ask / hold (poster-service extension, read back-compatibly): ask prices the leg, hold declines it', async () => {
  const obRelay = require('../services/ob-relay');
  setup();
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const a = mk('R1', 'basketball_nba', 300), b = mk('R2', 'basketball_nba', 300);
    const now = Date.now() / 1000;
    obRelay.__setForTest({ [a]: [0.5, now, 'nba_cycle', 0.5, 0.535] });
    const r = await pricer.priceParlay([a, b], { parlayId: 'obp-r' });
    assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
    assert.strictEqual(r.meta.legs[0].obAsk.rule, 'ob_relay_ask');
    assert.ok(near(r.meta.legs[0].obAsk.q, 0.535, 1e-9));
    assert.strictEqual(r.meta.legs[1].obAsk.rule, 'nba_ev4', 'no relay entry -> ported rule');
    obRelay.__setForTest({ [a]: [0.5, now, 'nba_line_guard', 0.5, null, now + 120] });
    const h = await pricer.priceParlay([a, b], { parlayId: 'obp-r2' });
    assert.strictEqual(h, null);
    assert.strictEqual(pricer.priceParlay._lastFailure.reason, 'ob_hold');
    obRelay.__setForTest({ [a]: [0.5, now, 'nba_line_guard', 0.5, null, now - 5] });
    assert.ok(await pricer.priceParlay([a, b], { parlayId: 'obp-r3' }), 'expired hold');
    obRelay.__setForTest({ [a]: [0.5, now, 'old_poster'] });
    const old = await pricer.priceParlay([a, b], { parlayId: 'obp-r4' });
    assert.strictEqual(old.meta.legs[0].obAsk.rule, 'nba_ev4', '3-element entries still read');
  } finally { obRelay.__resetForTest(); teardown(); }
});

test('order-book resting-offer asks (kv px_rfq_asks): a taker on B pays 1 - m of our offer on A; stale ignored', async () => {
  const obRelay = require('../services/ob-relay');
  setup();
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const a = mk('A1', 'basketball_nba', 300), b = mk('A2', 'basketball_nba', 300);
    const sibA = 'obp-A1-away';
    const now = Date.now() / 1000;
    // our resting offer on the AWAY line at +115 (m = 100/215) -> a taker on HOME pays 1 - m = 0.5349
    obRelay.__setForTest({}, { asks: { [sibA]: [100 / 215, now - 20, 'nba_cycle'] }, siblings: [[a, sibA], [sibA, a]], size: Object.keys(lineManager.__debugGetLineIndex() || {}).length });
    assert.ok(near(obRelay.getAsk(a), 1 - 100 / 215, 1e-12));
    assert.strictEqual(obRelay.getAsk(sibA), null, 'no offer on the home side -> no ask for an away taker');
    const r = await pricer.priceParlay([a, b], { parlayId: 'obp-ask' });
    assert.ok(r && r.meta, JSON.stringify(pricer.priceParlay._lastFailure));
    assert.strictEqual(r.meta.legs[0].obAsk.rule, 'ob_relay_ask');
    assert.ok(near(r.meta.legs[0].obAsk.q, 1 - 100 / 215, 1e-5));
    // an ask below fair is floored at fair
    obRelay.__setForTest({}, { asks: { [sibA]: [0.6, now, 'x'] }, siblings: [[a, sibA], [sibA, a]], size: Object.keys(lineManager.__debugGetLineIndex() || {}).length });
    const f = await pricer.priceParlay([a, b], { parlayId: 'obp-ask2' });
    assert.ok(near(f.meta.legs[0].obAsk.q, 0.5, 1e-9), 'never below fair');
    // stale ask -> ported rule
    obRelay.__setForTest({}, { asks: { [sibA]: [100 / 215, now - 10000, 'x'] }, siblings: [[a, sibA], [sibA, a]], size: Object.keys(lineManager.__debugGetLineIndex() || {}).length });
    const st = await pricer.priceParlay([a, b], { parlayId: 'obp-ask3' });
    assert.strictEqual(st.meta.legs[0].obAsk.rule, 'nba_ev4');
  } finally { obRelay.__resetForTest(); teardown(); }
});

test('order-book holds (kv px_rfq_holds): line, sibling, event, player (+rush scope); stale snapshot ignored', async () => {
  const obRelay = require('../services/ob-relay');
  setup();
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const a = mk('H1', 'basketball_nba', 300), b = mk('H2', 'basketball_nba', 300);
    const sib = 'obp-H1-away';
    const now = Date.now() / 1000;
    const idxSize = () => Object.keys(lineManager.__debugGetLineIndex() || {}).length;
    const S = { siblings: [[a, sib], [sib, a]], size: 0 };
    const run = async (holds, holdsTs) => {
      obRelay.__setForTest({}, Object.assign({ holds, holdsTs }, S, { size: idxSize() }));
      return pricer.priceParlay([a, b], { parlayId: 'obp-h' + Math.random() });
    };
    for (const k of [a, sib, 'e:H1']) {
      assert.strictEqual(await run({ [k]: [now + 120, 'g'] }), null, k);
      assert.strictEqual(pricer.priceParlay._lastFailure.reason, 'ob_hold', k);
    }
    assert.ok(await run({ [a]: [now - 1, 'g'] }), 'expired hold');
    assert.ok(await run({ 'e:H9': [now + 120, 'g'] }), 'other event');
    assert.ok(await run({ [a]: [now + 120, 'g'] }, now - 1000), 'stale snapshot is not trusted');
    // player holds
    const li = { pxEventId: 'E7', playerName: "Ja'Marr Chase Jr.", marketType: 'player_reception_yds' };
    obRelay.__setForTest({}, { holds: { 'p:E7|jamarrchase': [now + 60, 'nfl'] } });
    assert.ok(obRelay.getHold('zz', li), 'player key normalised like nfl_player_hold.norm');
    obRelay.__setForTest({}, { holds: { 'p:E7|jamarrchase|rush': [now + 60, 'nfl'] } });
    assert.strictEqual(obRelay.getHold('zz', li), null, 'rush-only hold skips receiving yards');
    assert.ok(obRelay.getHold('zz', Object.assign({}, li, { marketType: 'player_rush_yds' })), 'rush-only hold blocks rushing');
    // fairOnly reads are never held
    obRelay.__setForTest({}, Object.assign({ holds: { [a]: [now + 120, 'g'] } }, S));
    assert.ok(await pricer.priceParlay([a], { fairOnly: true }), 'fairOnly not gated');
  } finally { obRelay.__resetForTest(); teardown(); }
});

test('cross-game widen is retired on tickets priced at the order book asks (stays on legacy-priced tickets)', async () => {
  setup({ crossGameWidenPercent: 100 });
  const rel = config.pricing.crossGameWidenRelPct;
  config.pricing.crossGameWidenRelPct = 6;
  try {
    oddsFeed.getFairProb = () => 0.5;
    oddsFeed.getFanDuelOdds = () => -110;
    oddsFeed.getDraftKingsOdds = () => -110;
    const q = (0.5 + 0.04) / 1.04;
    const r = await pricer.priceParlay(['W1', 'W2', 'W3'].map(e => mk(e, 'basketball_nba', 300)), { parlayId: 'obp-w' });
    assert.strictEqual(r.meta.xgWidenArm, null);
    assert.ok(near(r.meta.offeredImpliedProb, q ** 3, 2e-5));
    const m = await pricer.priceParlay(['W4', 'W5', 'W6'].map(e => mk(e, 'baseball_mlb', 300)), { parlayId: 'obp-w2' });
    assert.strictEqual(m.meta.xgWidenArm, 'widen', 'MLB is out of parity scope, widen unchanged');
  } finally { config.pricing.crossGameWidenRelPct = rel; teardown(); }
});
