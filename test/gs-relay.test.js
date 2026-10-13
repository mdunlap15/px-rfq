// Soccer anytime-goalscorer legs priced from the order book's px_gs_fairs relay
// (operator 2026-10-13): fair YES = (FD + DK implied)/2 / 1.10; NO = 1 - fair_yes.
const { test } = require('node:test');
const assert = require('node:assert');
const gs = require('../services/gs-relay');
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
const pricer = require('../services/pricer');
const { config } = require('../config');

const NOW = Date.now();
const row = (ageSec, fairs) => ({ ts: NOW / 1000 - ageSec, fairs });
const FAIRS = {
  'gs-a-yes': { player: 'Harry Kane', side: 'yes', fair_yes: 0.40, eid: '901' },
  'gs-a-no': { player: 'Harry Kane', side: 'NO', fair_yes: 0.40, eid: '901' },
  'gs-b-yes': { player: 'Erling Haaland', side: 'YES', fair_yes: 0.50, eid: '902' },
  'gs-c-yes': { player: 'Bukayo Saka', side: 'yes', fair_yes: 0.30, eid: '901' },
};

test('getFair: YES = fair_yes, NO = 1 - fair_yes (side from the entry name)', () => {
  gs.__setForTest(row(30, FAIRS));
  assert.equal(gs.getFair('gs-a-yes', NOW).fair, 0.40);
  assert.ok(Math.abs(gs.getFair('gs-a-no', NOW).fair - 0.60) < 1e-12);
  assert.equal(gs.getFair('gs-a-no', NOW).side, 'no');
});

test('getFair: missing row, stale row, missing line, bad side/fair all decline', () => {
  gs.__setForTest(null);
  assert.equal(gs.getFair('gs-a-yes', NOW).reason, 'gs_relay_missing');
  gs.__setForTest(row(601, FAIRS));
  assert.equal(gs.getFair('gs-a-yes', NOW).reason, 'gs_relay_stale');
  gs.__setForTest(row(30, FAIRS));
  assert.equal(gs.getFair('nope', NOW).reason, 'gs_line_unpriced');
  gs.__setForTest(row(30, { x: { side: 'maybe', fair_yes: 0.4 }, y: { side: 'yes', fair_yes: 1.2 } }));
  assert.equal(gs.getFair('x', NOW).ok, false);
  assert.equal(gs.getFair('y', NOW).ok, false);
  gs.__setForTest({ fairs: FAIRS });
  assert.equal(gs.getFair('gs-a-yes', NOW).reason, 'gs_relay_no_ts');
});

// ---- pricer integration ----
const LINES = {};
const origLookup = lineManager.lookupLine;
const o1 = oddsFeed.isStaleForEvent, o2 = oddsFeed.isEventStalePreGame;
lineManager.lookupLine = (id) => LINES[id] || origLookup(id);
oddsFeed.isStaleForEvent = () => false;
oddsFeed.isEventStalePreGame = () => false;
process.on('exit', () => { lineManager.lookupLine = origLookup; oddsFeed.isStaleForEvent = o1; oddsFeed.isEventStalePreGame = o2; });
const start = new Date(NOW + 5 * 3600e3).toISOString();
const gl = (id, player, eid, sel) => ({
  lineId: id, sport: 'soccer_epl', oddsApiSport: 'soccer_epl', pxEventId: eid, pxEventName: `M${eid}`,
  marketType: 'player_goalscorer', marketName: `${player} To Score a Goal`, selection: sel, oddsApiSelection: sel,
  teamName: player, playerName: player, propType: 'goalscorer', line: 0.5, homeTeam: 'H' + eid, awayTeam: 'A' + eid,
  oddsApiMarket: 'player_goal_scorer_anytime', startTime: start, startTimeMs: Date.parse(start),
  fairProb: 0.99, bookPriceOverride: 0.99, propFetchedAt: NOW - 3600e3,
});
Object.assign(LINES, {
  'gs-a-yes': gl('gs-a-yes', 'Harry Kane', 901, 'over'),
  'gs-a-no': gl('gs-a-no', 'Harry Kane', 901, 'under'),
  'gs-b-yes': gl('gs-b-yes', 'Erling Haaland', 902, 'over'),
  'gs-c-yes': gl('gs-c-yes', 'Bukayo Saka', 901, 'over'),
});

test('shouldDecline: two goalscorers on one match decline goalscorer_same_match', () => {
  gs.__setForTest(row(30, FAIRS));
  const d = pricer.shouldDecline([{ line_id: 'gs-a-yes' }, { line_id: 'gs-c-yes' }], null);
  assert.equal(d && d.declined, true);
  assert.equal(d.reason, 'goalscorer_same_match');
});

test('priceParlay: stale relay declines a goalscorer leg (never falls back to the seeded override)', async () => {
  gs.__setForTest(row(900, FAIRS));
  const r = await pricer.priceParlay(['gs-a-yes', 'gs-b-yes']);
  assert.equal(r, null);
  const f = pricer.priceParlay._lastFailure;
  assert.ok(/gs_relay_stale|goalscorer/.test(JSON.stringify(f)), JSON.stringify(f));
});

test('priceParlay: missing relay declines', async () => {
  gs.__setForTest(null);
  const r = await pricer.priceParlay(['gs-a-no', 'gs-b-yes']);
  assert.equal(r, null);
  assert.ok(/gs_relay_missing/.test(JSON.stringify(pricer.priceParlay._lastFailure)), JSON.stringify(pricer.priceParlay._lastFailure));
});

test('priceParlay: fresh relay prices with fair = product of relay fairs (YES x NO)', async () => {
  if (!(config.pricing.maxRiskPerParlay >= 500)) config.pricing.maxRiskPerParlay = 500;
  gs.__setForTest(row(30, FAIRS));
  const r = await pricer.priceParlay(['gs-a-no', 'gs-b-yes']);
  assert.ok(r && r.offer, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
  assert.ok(Math.abs(r.meta.fairParlayProb - 0.60 * 0.50) < 1e-6, `fair ${r.meta.fairParlayProb}`);
});

test('shouldDecline: goalscorer + that match result leg declines', () => {
  gs.__setForTest(row(30, FAIRS));
  LINES['ml-901'] = Object.assign({}, gl('ml-901', 'H901', 901, 'home'), { marketType: 'moneyline', oddsApiMarket: 'h2h', propType: undefined, playerName: null });
  const d = pricer.shouldDecline([{ line_id: 'gs-a-yes' }, { line_id: 'ml-901' }], null);
  assert.equal(d && d.reason, 'goalscorer_same_match');
});
