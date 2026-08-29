// /status must expose every kill switch.
//
// Added 2026-08-29 after golf outrights went dark and the flag's state was not
// readable from outside the process — diagnosing it meant inferring from a
// MISSING counter in the seed trace. A kill switch you cannot read is a kill
// switch you cannot debug, so this test fails if a new one is added to config
// without also being surfaced.
//
// Run: npm test  (or: node --test test/status-kill-switches.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Every gate that can silence a market, and the env var that drives it.
const SWITCHES = [
  ['golfOutrightsParlay', 'GOLF_OUTRIGHTS_PARLAY_ENABLED'],
  ['golfMatchupSpread',   'BETONLINE_GOLF_ENABLED'],
  ['golfOutrightWindow',  'GOLF_OUTRIGHT_WINDOW_ENABLED'],
  ['pitcherKProps',       'PITCHER_K_PROPS_ENABLED'],
  ['telegramAlerts',      'TELEGRAM_ALERTS_ENABLED'],
  ['footballSgp',         'FOOTBALL_SGP_ENABLED'],
  ['sharpApi',            'SHARPAPI_ENABLED'],
  ['rfi',                 'RFI_ENABLED'],
];

test('/status exposes a killSwitches block', () => {
  assert.match(indexSrc, /killSwitches:\s*\{/, 'killSwitches block must exist in /status');
});

for (const [name, env] of SWITCHES) {
  test(`killSwitches surfaces ${name} (${env})`, () => {
    assert.ok(indexSrc.includes(`${name}: {`), `missing killSwitches.${name}`);
    assert.ok(indexSrc.includes(`process.env.${env}`), `${name} must report its raw env var ${env}`);
  });
}

test('each switch reports BOTH the resolved boolean and the raw env', () => {
  // The distinction matters: an unset variable and an explicitly-wrong value
  // ("false", "TRUE", "1") resolve identically but mean different things when
  // you are asking "did someone change this?".
  const block = indexSrc.slice(indexSrc.indexOf('killSwitches: {'));
  const end = block.indexOf('websocket: websocket.getState()');
  const body = block.slice(0, end);
  const onCount = (body.match(/\bon:/g) || []).length;
  const envCount = (body.match(/\benv:/g) || []).length;
  assert.strictEqual(onCount, SWITCHES.length, 'every switch needs an `on`');
  assert.strictEqual(envCount, SWITCHES.length, 'every switch needs an `env`');
});

test('defaults are recorded, and golfOutrightsParlay is the ON-by-default one', () => {
  const body = indexSrc.slice(indexSrc.indexOf('killSwitches: {'));
  assert.ok(body.includes('defaultsTo: true'), 'at least one switch defaults ON');
  const golf = body.slice(body.indexOf('golfOutrightsParlay'), body.indexOf('golfMatchupSpread'));
  assert.ok(golf.includes('defaultsTo: true'), 'golfOutrightsParlay defaults ON — unlike the rest');
});
