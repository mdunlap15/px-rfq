// Tennis registration guard (2026-10-21 perf review). 226 of 234 registered
// tennis moneylines and all 432 first-set / total-sets lines had no odds behind
// them (0 quotes in 1,738 RFQ appearances): Challenger/ITF matches TOA does not
// list, registered by the deferred-match fallback, plus set markets no source
// feeds under TENNIS_TOA_ONLY. PX Rule 2: advertise only lines we can price.
// Pins: (1) a matched match registers only the markets its odds event carries;
// (2) an unmatched tennis match registers nothing; (3) the MLB deferred-match
// fallback (2026-07-23) is untouched.
// Run: node --test test/tennis-registration-guard.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const lineManager = require('../services/line-manager');
const px = require('../services/prophetx');
const oddsFeed = require('../services/odds-feed');
const db = require('../services/db');
const { config } = require('../config');

const SCHED = new Date(Date.now() + 5 * 3600e3).toISOString();
const grp = (arr) => [arr];
const ev = (id, name, sport, home, away) => ({ event_id: id, name, sport_name: sport, scheduled: SCHED, status: 'not_started',
  competitors: [{ id: id * 10 + 1, name: home, side: 'home' }, { id: id * 10 + 2, name: away, side: 'away' }] });
const TEN_OK = ev(9101, 'Carlos Alcaraz at Jannik Sinner', 'Tennis', 'Jannik Sinner', 'Carlos Alcaraz');
const TEN_ITF = ev(9102, 'Adil Kalyanpur at Karan Singh', 'Tennis', 'Karan Singh', 'Adil Kalyanpur');
const MLB_GLITCH = ev(9103, 'Minnesota Twins at Cleveland Guardians', 'Baseball', 'Cleveland Guardians', 'Minnesota Twins');
const ml = (e) => ({ id: 1, name: 'Moneyline', type: 'moneyline', selections: grp([
  { line_id: `${e.event_id}-ml-h`, name: e.competitors[0].name, competitor_id: e.competitors[0].id },
  { line_id: `${e.event_id}-ml-a`, name: e.competitors[1].name, competitor_id: e.competitors[1].id }]) });
const sets = (e) => ({ id: 2, name: 'Total Sets', type: 'total', market_lines: [{ line: 2.5, selections: grp([
  { line_id: `${e.event_id}-ts-o`, name: 'Over 2.5', line: 2.5 }, { line_id: `${e.event_id}-ts-u`, name: 'Under 2.5', line: 2.5 }]) }] });

const saved = [];
function patch(obj, key, val) { saved.push([obj, key, obj[key]]); obj[key] = val; }
function unpatch() { for (const [o, k, v] of saved.splice(0).reverse()) o[k] = v; }

test('tennis registers only markets its odds event carries; unmatched tennis registers nothing; MLB deferred-match still registers', async () => {
  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [TEN_OK, TEN_ITF, MLB_GLITCH]);
  patch(px, 'fetchMarkets', async (eventId) => (eventId === MLB_GLITCH.event_id ? [ml(MLB_GLITCH)] : [ml(eventId === TEN_OK.event_id ? TEN_OK : TEN_ITF), sets(eventId === TEN_OK.event_id ? TEN_OK : TEN_ITF)]));
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  // The odds cache knows the tour-level match (moneyline only — no sets board), not the ITF match, and
  // (glitch) not the MLB game.
  patch(oddsFeed, 'getAllCachedEvents', () => [{ sport: 'tennis', homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz', commenceTime: SCHED }]);
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport, home) => (sport === 'tennis' && /Sinner/.test(home)
    ? { homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz', commenceTime: SCHED, markets: { h2h: { home: { fairProb: 0.55 }, away: { fairProb: 0.45 } } } } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', async () => null);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  patch(config.pricing, 'tennisToaOnly', true);
  if (!config.supportedSports.includes('tennis')) patch(config, 'supportedSports', config.supportedSports.concat(['tennis']));
  if (!config.supportedSports.includes('baseball_mlb')) patch(config, 'supportedSports', config.supportedSports.concat(['baseball_mlb']));
  try {
    await lineManager.seedAllLines();
    const idx = lineManager.__debugGetLineIndex();
    const has = (id) => !!idx[id];
    assert.ok(has('9101-ml-h') && has('9101-ml-a'), 'tour-level moneyline (odds block present) registers');
    assert.ok(!has('9101-ts-o') && !has('9101-ts-u'), 'total sets with no sets block on the odds event does NOT register');
    assert.ok(!has('9102-ml-h') && !has('9102-ml-a') && !has('9102-ts-o'), 'unmatched ITF match registers nothing');
    assert.ok(has('9103-ml-h') && has('9103-ml-a'), 'MLB deferred-match fallback still registers a near-term game the cache missed');
  } finally { unpatch(); }
});

test('grace: a tennis match its tournament briefly dropped keeps the lines it had; after the grace they go. Total sets registers only at 2.5', async () => {
  let cacheUp = true;
  const setsBlock = { over: { fairProb: 0.4 }, under: { fairProb: 0.6 } };
  const ts = (e) => ({ id: 2, name: 'Total Sets', type: 'total', market_lines: [
    { line: 2.5, selections: grp([{ line_id: `${e.event_id}-ts-o`, name: 'Over 2.5', line: 2.5 }, { line_id: `${e.event_id}-ts-u`, name: 'Under 2.5', line: 2.5 }]) },
    { line: 3.5, selections: grp([{ line_id: `${e.event_id}-ts35-o`, name: 'Over 3.5', line: 3.5 }, { line_id: `${e.event_id}-ts35-u`, name: 'Under 3.5', line: 3.5 }]) }] });
  patch(db, 'loadAllRecentLineCache', async () => ({}));
  patch(db, 'saveLineCache', async () => {});
  patch(px, 'fetchSportEvents', async () => [TEN_OK]);
  patch(px, 'fetchMarkets', async () => [ml(TEN_OK), ts(TEN_OK)]);
  patch(px, 'getSupportedLines', async () => []);
  patch(px, 'registerSupportedLines', async () => {});
  patch(px, 'removeSupportedLines', async () => {});
  patch(oddsFeed, 'getAllCachedEvents', () => (cacheUp ? [{ sport: 'tennis', homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz', commenceTime: SCHED }] : []));
  patch(oddsFeed, 'getSharpEvents', () => []);
  patch(oddsFeed, 'getEventMarkets', (sport, home) => (cacheUp && sport === 'tennis' && /Sinner/.test(home)
    ? { homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz', commenceTime: SCHED, markets: { h2h: { home: { fairProb: 0.55 }, away: { fairProb: 0.45 } }, total_sets: setsBlock } } : null));
  patch(oddsFeed, 'warmEventAltLinesJIT', () => Promise.resolve());
  patch(oddsFeed, 'ensureTeamTotals', async () => {});
  patch(oddsFeed, 'ensureBtts', async () => {});
  patch(oddsFeed, 'lookupTheOddsApiPlayerProp', async () => null);
  patch(oddsFeed, 'lookupTheOddsApiPlayerPropOneSided', async () => null);
  patch(config.pricing, 'tennisToaOnly', true);
  const savedGrace = process.env.TENNIS_MATCH_GRACE_MIN;
  try {
    await lineManager.refreshLines();
    let idx = lineManager.__debugGetLineIndex();
    assert.ok(idx['9101-ml-h'] && idx['9101-ts-o'], 'moneyline + total sets 2.5 register');
    assert.ok(!idx['9101-ts35-o'], 'total sets 3.5 never registers (the pricer prices best-of-3 only)');
    cacheUp = false;                                   // the tournament drops out of the cache for a cycle
    await lineManager.refreshLines();
    idx = lineManager.__debugGetLineIndex();
    assert.ok(idx['9101-ml-h'] && idx['9101-ts-o'], 'inside the grace the match keeps its lines');
    process.env.TENNIS_MATCH_GRACE_MIN = '0.000001';  // grace over
    await lineManager.refreshLines();
    idx = lineManager.__debugGetLineIndex();
    assert.ok(!idx['9101-ml-h'], 'after the grace an unmatched tennis match registers nothing');
  } finally {
    if (savedGrace == null) delete process.env.TENNIS_MATCH_GRACE_MIN; else process.env.TENNIS_MATCH_GRACE_MIN = savedGrace;
    unpatch();
  }
});
