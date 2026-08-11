// DK segregates MMA by league page: /leagues/mma/ufc carries numbered cards
// ONLY, and Tuesday Dana White's Contender Series lives on its own slug —
// scraping the UFC page silently returns zero DWCS fighters (found
// 2026-08-11: 5 fights registered on PX, 0 on the MoV board). The MoV scrape
// must walk BOTH pages by default, overridable via DK_MMA_URLS.
//
// Run: npm test   (or: node --test test/mov-league-urls.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { _movLeagueUrls } = require('../services/dk-scraper');

test('default league list covers UFC and Contender Series', () => {
  delete process.env.DK_MMA_URLS;
  const urls = _movLeagueUrls();
  assert.ok(urls.some(u => /\/leagues\/mma\/ufc$/.test(u)), 'must include the UFC page');
  assert.ok(urls.some(u => /contender-series/.test(u)), 'must include the Contender Series page');
  assert.equal(urls.length, 2);
});

test('DK_MMA_URLS env overrides the whole list (comma-separated, trimmed)', () => {
  process.env.DK_MMA_URLS = ' https://sportsbook.draftkings.com/leagues/mma/pfl , https://sportsbook.draftkings.com/leagues/mma/ufc ';
  try {
    const urls = _movLeagueUrls();
    assert.deepEqual(urls, [
      'https://sportsbook.draftkings.com/leagues/mma/pfl',
      'https://sportsbook.draftkings.com/leagues/mma/ufc',
    ]);
  } finally {
    delete process.env.DK_MMA_URLS;
  }
});

test('empty env falls back to the default list', () => {
  process.env.DK_MMA_URLS = '   ';
  try {
    assert.equal(_movLeagueUrls().length, 2);
  } finally {
    delete process.env.DK_MMA_URLS;
  }
});
