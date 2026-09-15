'use strict';
// Shared TOA key + NFL prop coverage fixes (2026-09-14, Broncos @ Chiefs).
//
// Props stayed dark ~40 minutes before kickoff: the single-leg posters share
// the TOA key, the per-event prop fetchers gave up on the first 429, and PX
// dropped a roman-numeral suffix the books kept. These pin all three fixes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const of = require('../services/odds-feed');
const lm = require('../services/line-manager');
const ws = require('../services/websocket');
const OF_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'odds-feed.js'), 'utf8');
const LM_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

test.beforeEach(() => of._resetToaFreqForTest());

const R = (status) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null } });
const noSleep = { sleep: async () => {}, noJitter: true };

// ------------------------------------------------------------ 429 retries
test('a 429 on the prop path is retried and the eventual 200 is returned', async () => {
  const seq = [429, 429, 200]; let calls = 0;
  const resp = await of._toaGetRetrying429('u', undefined, { ...noSleep, retries: 2, fetchFn: async () => R(seq[calls++]) });
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(calls, 3);
  assert.strictEqual(of.getToaFreqState().consecutive429, 0, 'success clears the governor');
});

test('retries are BOUNDED: a persistent 429 returns after retries+1 attempts', async () => {
  let calls = 0;
  const resp = await of._toaGetRetrying429('u', undefined, { ...noSleep, retries: 2, fetchFn: async () => { calls++; return R(429); } });
  assert.strictEqual(resp.status, 429);
  assert.strictEqual(calls, 3);
  assert.ok(of.getToaFreqState().total429 >= 3, 'every 429 is reported to the governor');
});

test('non-429 failures are NOT retried', async () => {
  let calls = 0;
  const resp = await of._toaGetRetrying429('u', undefined, { ...noSleep, fetchFn: async () => { calls++; return R(500); } });
  assert.strictEqual(resp.status, 500);
  assert.strictEqual(calls, 1);
});

test('backoff between retries grows and stays short', async () => {
  const waits = [];
  await of._toaGetRetrying429('u', undefined, { retries: 2, noJitter: true, sleep: async ms => { waits.push(ms); }, fetchFn: async () => R(429) });
  assert.deepStrictEqual(waits, [400, 1000]);
});

test('both per-event prop fetchers go through the 429-aware GET', () => {
  assert.ok(/const resp = await _toaGetRetrying429\(url\);\r?\n\s*if \(!resp\.ok\) \{\r?\n\s*log\.warn\('OddsFeed', `TOA events fetch failed/.test(OF_SRC), 'events list');
  assert.ok(/const resp = await _toaGetRetrying429\(url\);\r?\n\s*if \(!resp\.ok\) \{\r?\n\s*log\.warn\('OddsFeed', `TOA per-event odds failed/.test(OF_SRC), 'per-event prop odds');
});

// ------------------------------------------------------------ PX-anchored name suffixes
const N = of._normPlayerNameParts;
const mk = (names) => names.map(name => ({ name }));

test('Walker: PX TD markets say "III", so his yardage and receptions markets inherit it', () => {
  const gens = lm._footballTdGensByBase(mk([
    'Kenneth Walker III To Score a Touchdown', 'Kenneth Walker III To Score First Touchdown',
    'Kenneth Walker Receiving Yards', 'Kenneth Walker Total Receptions',
  ]), ws, N);
  assert.strictEqual(lm._applyFootballTdSuffix('Kenneth Walker', 'receiving_yards', gens, N), 'Kenneth Walker III');
  assert.strictEqual(lm._applyFootballTdSuffix('Kenneth Walker', 'rushing_yards', gens, N), 'Kenneth Walker III');
});

test('Carter: an unsuffixed TD market blocks the rename, alone or beside a II', () => {
  const both = lm._footballTdGensByBase(mk(['Michael Carter To Score a Touchdown', 'Michael Carter II To Score a Touchdown']), ws, N);
  assert.strictEqual(lm._applyFootballTdSuffix('Michael Carter', 'rushing_yards', both, N), 'Michael Carter');
  const plain = lm._footballTdGensByBase(mk(['Michael Carter To Score a Touchdown']), ws, N);
  assert.strictEqual(lm._applyFootballTdSuffix('Michael Carter', 'rushing_yards', plain, N), 'Michael Carter');
});

test('no TD market for the player means no rename (strict match stays in force)', () => {
  const gens = lm._footballTdGensByBase(mk(['Travis Kelce To Score a Touchdown']), ws, N);
  assert.strictEqual(lm._applyFootballTdSuffix('Kenneth Walker', 'receiving_yards', gens, N), 'Kenneth Walker');
});

test('TD markets and already-suffixed names are never rewritten', () => {
  const gens = lm._footballTdGensByBase(mk(['Kenneth Walker III To Score a Touchdown']), ws, N);
  assert.strictEqual(lm._applyFootballTdSuffix('Kenneth Walker', 'anytime_td', gens, N), 'Kenneth Walker');
  assert.strictEqual(lm._applyFootballTdSuffix('Kenneth Walker III', 'receiving_yards', gens, N), 'Kenneth Walker III');
});

test('the book-board matcher is still strict: no suffix tolerance in odds-feed', () => {
  assert.strictEqual(of._suffixTolerantGen, undefined, 'the rejected book-board fallback must not come back');
  assert.ok(/if \(!_playerNamesMatch\(normParts, o\.description\)\) continue;/.test(OF_SRC));
});

test('the seed applies the PX-anchored suffix before any lookup', () => {
  assert.ok(/_fbTdGens = sportKey\.startsWith\('americanfootball'\)\s*\r?\n?\s*\? _footballTdGensByBase\(markets, ws, oddsFeed\._normPlayerNameParts\)/.test(LM_SRC));
  assert.ok(/_applyFootballTdSuffix\(playerName, propType, _fbTdGens, oddsFeed\._normPlayerNameParts\)/.test(LM_SRC));
});

// ------------------------------------------------------------ new markets
test('the four newly enabled football markets are mapped two-sided', () => {
  const m = lm._FOOTBALL_PROP_TO_TOA_MARKET;
  assert.strictEqual(m.interception_thrown, 'player_pass_interceptions');
  assert.strictEqual(m.field_goals_made, 'player_field_goals');
  assert.strictEqual(m.pass_completions, 'player_pass_completions');
  assert.strictEqual(m.longest_reception, 'player_reception_longest');
  for (const t of ['interception_thrown', 'field_goals_made', 'pass_completions', 'longest_reception']) {
    assert.strictEqual(lm._footballPropCtx(t), null, t + ' carries a real point, not lineless semantics');
  }
});

test('"Longest Reception" is its own market, never a receptions count', () => {
  assert.strictEqual(ws._classifyFootballProp('Rashee Rice Longest Reception'), 'longest_reception');
  assert.strictEqual(ws._extractPlayerNameFromPropMarket('Rashee Rice Longest Reception'), 'Rashee Rice');
  assert.strictEqual(ws._classifyFootballProp('Rashee Rice Total Receptions'), 'receptions');
});
