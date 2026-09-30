// NHL opening-week gaps (2026-09-29).
//   1. alt-line cache entries past ALT_LINES_TTL_MS no longer price (getAltLineFairProb
//      is reached directly from getFairProb, not only through the TTL-checked sync path)
//      and no longer feed the consensus floor (getAltLineBookOdds);
//   2. NHL regulation / "(60 Min)" / 3-way and team-total markets never enter the index;
//   3. NHL team totals are no longer fetched;
//   4. NHL full-game lines need NHL_MIN_BOOKS (2) books.
// Run: node --test test/nhl-gaps.test.js

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const of = require('../services/odds-feed');
const lm = require('../services/line-manager');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'odds-feed.js'), 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------ 1. alt age

function seedAlt(key, ageMs) {
  of.__debugGetAltLinesCache()[key] = {
    fetchedAt: Date.now() - ageMs, refreshing: false,
    altSpreads: {}, altTotals: { '6.5': { over: 0.44, under: 0.56, books: 3,
      byBook: { pinnacle: { over: 130, under: -150 }, draftkings: { over: 125, under: -145 } } } },
    altSpreadsF5: {}, altTotalsF5: {}, altSpreadsH1: {}, altTotalsH1: {},
  };
}

test('a fresh alt entry prices; one past the TTL does not', () => {
  const key = of.normalizeEventKey('Colorado Avalanche', 'Los Angeles Kings');
  seedAlt(key, 60e3);
  assert.strictEqual(of.getAltLineFairProb(key, 'totals', 'over', 6.5), 0.44);
  seedAlt(key, 70 * 60e3);                       // the 9/28 observation: 68–91 min old
  assert.strictEqual(of.getAltLineFairProb(key, 'totals', 'over', 6.5), null);
  delete of.__debugGetAltLinesCache()[key];
});

test('a stale alt entry cannot set the consensus floor', () => {
  const key = of.normalizeEventKey('Colorado Avalanche', 'Los Angeles Kings');
  seedAlt(key, 70 * 60e3);
  assert.strictEqual(of.getAltLineBookOdds('Colorado Avalanche', 'Los Angeles Kings', 'totals', 'over', 6.5, 'pinnacle'), null);
  delete of.__debugGetAltLinesCache()[key];
});

test('_altEntryFresh fails closed on a missing/garbage fetchedAt', () => {
  assert.strictEqual(of._altEntryFresh(null), false);
  assert.strictEqual(of._altEntryFresh({ fetchedAt: undefined }), false);
  assert.strictEqual(of._altEntryFresh({ fetchedAt: Date.now() }), true);
});

// ------------------------------------------------ 2. NHL market exclusions

test('NHL regulation / 60-min / 3-way / team-total markets are excluded; full-game are not', () => {
  const out = ['Moneyline (Regulation)', 'Total Goals (Regular Time)', 'Spread (Regular Time)',
    'Moneyline (60 Min)', 'Total Goals (60 Min)', '3-Way Moneyline', 'Team Total Goals', 'Home Total'];
  for (const name of out) assert.strictEqual(lm._nhlExcludedMarket({ name, type: 'moneyline' }), true, name);
  assert.strictEqual(lm._nhlExcludedMarket({ name: 'Anything', type: 'team_total' }), true);
  for (const name of ['Moneyline', 'Puck Line', 'Total Goals', 'Total', 'Spread']) {
    assert.strictEqual(lm._nhlExcludedMarket({ name, type: 'moneyline' }), false, name);
  }
});

test('NHL team_total is refused at the shared admission gate (on-demand + cache restore)', () => {
  assert.strictEqual(lm._sportMarketAllowed('icehockey_nhl', 'team_total', 1), false);
  assert.strictEqual(lm._sportMarketAllowed('icehockey_nhl', 'total', 1), true);
  assert.strictEqual(lm._sportMarketAllowed('baseball_mlb', 'team_total', 1), true);
});

test('the seed filter consults the NHL exclusion', () => {
  const lmSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');
  assert.match(lmSrc, /if \(sportKey === 'icehockey_nhl' && _nhlExcludedMarket\(m\)\) return false;/);
});

// ------------------------------------------------ 3. no NHL team-total fetch

test('NHL team totals are no longer fetched or seeded', () => {
  assert.strictEqual(of.TEAM_TOTAL_SPORTS.has('icehockey_nhl'), false);
  assert.strictEqual(of.TEAM_TOTAL_SPORTS.has('baseball_mlb'), true);
  assert.match(SRC, /if \(TEAM_TOTAL_SPORTS\.has\(sport\) && _supplementDue\(sport, 'team_totals'\)\)/);
  const lmSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8').replace(/\r\n/g, '\n');
  const seed = lmSrc.slice(lmSrc.indexOf('const TEAM_TOTAL_SEED_SPORTS'), lmSrc.indexOf(']);', lmSrc.indexOf('const TEAM_TOTAL_SEED_SPORTS')));
  assert.ok(!seed.includes('icehockey_nhl'));
});

// ------------------------------------------------ 4. NHL book floor

test('NHL full-game lines need at least NHL_MIN_BOOKS books', () => {
  assert.strictEqual(of.NHL_MIN_BOOKS, 2);
  assert.match(SRC, /sport === 'icehockey_nhl' && \(marketType === 'h2h' \|\| marketType === 'spreads' \|\| marketType === 'totals'\)\s*&& Number\.isFinite\(market\.books\) && market\.books < NHL_MIN_BOOKS/);
});
