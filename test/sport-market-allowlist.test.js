// PER-SPORT MARKET ALLOWLIST (2026-09-09).
//
// First use: the Champions League league phase (`soccer_uefa_champs_league`)
// is TOTALS-ONLY — operator directive when the key was added to
// SUPPORTED_SPORTS. Soccer totals are the one soccer market measured
// calibrated (z≈0); spreads (z=3.04, −$5.3K) and DNB favourites (z=3.45) were
// the June leak, and the Champions League is where favourites are heaviest.
//
// The gate must hold at EVERY path into the line index — seed, on-demand
// resolve, cache restore — because a line in the index is a line PX is told
// we support, and a registered line is an RFQ we will be asked to price.
//
// Run: node --test test/sport-market-allowlist.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lm = require('../services/line-manager');
const { config } = require('../config');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

const UCL = 'soccer_uefa_champs_league';

test('default: the Champions League league phase admits ONLY full-game totals', () => {
  assert.deepStrictEqual(config.pricing.sportMarketAllowlist, { [UCL]: ['total'] });
  assert.strictEqual(lm._sportMarketAllowed(UCL, 'total'), true);
  for (const mt of ['moneyline', 'spread', 'team_total', 'btts', 'first_half_total', 'player_goalscorer', 'advance', 'double_chance']) {
    assert.strictEqual(lm._sportMarketAllowed(UCL, mt), false, `${mt} must be refused for the Champions League`);
  }
});

test('a sport with no entry is unrestricted; malformed inputs fail OPEN for unlisted sports only', () => {
  for (const s of ['soccer_epl', 'soccer_usa_mls', 'baseball_mlb', 'tennis', 'americanfootball_nfl']) {
    for (const mt of ['moneyline', 'spread', 'total', 'btts']) assert.strictEqual(lm._sportMarketAllowed(s, mt), true, `${s}/${mt}`);
  }
  assert.strictEqual(lm._sportMarketAllowed(undefined, 'spread'), true, 'no sport → cannot restrict');
  assert.strictEqual(lm._sportMarketAllowed(UCL, undefined), false, 'a listed sport with an unknown market is refused');
});

test('the seed insert refuses a disallowed market and inserts an allowed one', () => {
  const spreadId = 'test-ucl-spread-' + Date.now();
  const totalId = 'test-ucl-total-' + Date.now();
  const spread = lm._setSeedLine(spreadId, { sport: UCL, oddsApiSport: UCL, marketType: 'spread', teamName: 'Real Madrid', line: -1.5 });
  const total = lm._setSeedLine(totalId, { sport: UCL, oddsApiSport: UCL, marketType: 'total', teamName: 'Total Goals', line: 2.5, selection: 'over' });
  assert.strictEqual(spread._marketDenied, true, 'the info is returned flagged so callers can chain on it');
  assert.strictEqual(lm.lookupLine(spreadId), null, 'a Champions League SPREAD must never enter the index');
  assert.ok(lm.lookupLine(totalId), 'a Champions League TOTAL does');
  assert.strictEqual(lm.lookupLine(totalId).lineId, totalId);
});

test('the on-demand and cache-restore paths consult the same gate', () => {
  // on-demand resolveUnknownLine: refuse before `lineIndex[lineId] = foundInfo`
  const onDemand = SRC.indexOf("reason: 'market_not_allowed_for_sport'");
  const onDemandInsert = SRC.indexOf('lineIndex[lineId] = foundInfo;');
  assert.ok(onDemand > -1 && onDemandInsert > -1 && onDemand < onDemandInsert, 'on-demand refuses BEFORE inserting');
  // lookupLineAsync: refuse a cached (pre-restriction) line before restoring it
  const restore = SRC.indexOf('lineIndex[lineId] = cached;');
  const restoreGate = SRC.lastIndexOf('_sportMarketAllowed(cached.sport || cached.oddsApiSport, cached.marketType)', restore);
  assert.ok(restore > -1 && restoreGate > -1 && restoreGate < restore, 'cache restore refuses BEFORE inserting');
  // primaries: a denied info never becomes a primary
  assert.ok(/function _trackPrimaryForIndex\(lineInfo\) \{\n[^\n]*\n[^\n]*\n[^\n]*\n\s*if \(lineInfo && lineInfo\._marketDenied\) return;/.test(SRC), '_trackPrimaryForIndex ignores denied infos');
});

test('an env override replaces the default and clamps to arrays of strings', () => {
  const prev = config.pricing.sportMarketAllowlist;
  try {
    config.pricing.sportMarketAllowlist = { [UCL]: ['total', 'btts'], soccer_epl: ['total'] };
    assert.strictEqual(lm._sportMarketAllowed(UCL, 'btts'), true);
    assert.strictEqual(lm._sportMarketAllowed('soccer_epl', 'spread'), false);
    assert.strictEqual(lm._sportMarketAllowed('soccer_usa_mls', 'spread'), true, 'unlisted stays unrestricted');
    config.pricing.sportMarketAllowlist = null;
    assert.strictEqual(lm._sportMarketAllowed(UCL, 'spread'), true, 'no map at all → unrestricted');
  } finally {
    config.pricing.sportMarketAllowlist = prev;
  }
});
