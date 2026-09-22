// FOOTBALL 48h NEAR-WINDOW (operator directive 2026-09-21):
// "I do not want to quote NFL and CFB parlays until 48 hours out of each."
//
// A football EVENT does not register until within FOOTBALL_TMINUS_HOURS (48h)
// of kickoff — gating the whole event (game lines AND props), tighter than
// MAX_DAYS_AHEAD. Enforced at BOTH index entry points (seed filter + on-demand
// resolve) so an RFQ cannot re-register a far-out football line the seed
// skipped — the same "gate only the seed" half-fix that let de-registered golf
// spreads come back on demand. All PX football shares sport_name
// 'American Football'; the floor applies to all of it.
//
// The filter/resolve gates are embedded in seedAllLines/resolveUnknownLine, so
// these lock the shape at the source (repo convention, cf. sport-market-allowlist).
//
// Run: node --test test/football-tminus-window.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

test('the window const exists, defaults to 48h, and reads FOOTBALL_TMINUS_HOURS', () => {
  const at = SRC.indexOf('const FOOTBALL_TMINUS_HOURS');
  assert.ok(at > -1, 'const present');
  const body = SRC.slice(at, at + 220);
  assert.ok(/parseFloat\(process\.env\.FOOTBALL_TMINUS_HOURS\)/.test(body), 'reads the env');
  assert.ok(/: 48;/.test(body), 'defaults to 48');
  assert.ok(/> 0 \? v : 48/.test(body), 'rejects 0/negative/blank → 48');
});

test('the SEED filter drops American Football events beyond the window', () => {
  // one-sided forward gate, hours-based, incrementing its own counter
  assert.ok(/e\.sport_name === 'American Football' && Number\.isFinite\(startMs\)\s*\r?\n?\s*&& startMs > nowMs \+ FOOTBALL_TMINUS_HOURS \* 3600000/.test(SRC),
    'seed forward-window predicate present');
  assert.ok(/droppedFootballFar\+\+;/.test(SRC), 'increments the football-far counter');
  assert.ok(/\$\{droppedFootballFar\} football beyond \$\{FOOTBALL_TMINUS_HOURS\}h/.test(SRC),
    'seed summary logs the football drop count');
});

test('the ON-DEMAND resolve applies the same window (keyed on event.sportName)', () => {
  assert.ok(/event\.sportName === 'American Football' && Number\.isFinite\(_st\)\s*\r?\n?\s*&& _st > Date\.now\(\) \+ FOOTBALL_TMINUS_HOURS \* 3600000/.test(SRC),
    'on-demand forward-window predicate present');
  assert.ok(/reason: 'football_beyond_tminus'/.test(SRC), 'records a distinct decline reason');
});

test('it is a FORWARD gate only — it never touches past/in-progress events', () => {
  // both sites compare start > now + window (strictly forward); no lower bound
  const seedGate = SRC.indexOf("e.sport_name === 'American Football'");
  const seedSlice = SRC.slice(seedGate, seedGate + 200);
  assert.ok(/startMs > nowMs \+/.test(seedSlice) && !/startMs < /.test(seedSlice),
    'seed gate is one-sided forward');
});

test('the football window is independent of MAX_DAYS_AHEAD (a separate, tighter cap)', () => {
  // both caps coexist in the seed filter; the football one is additional
  assert.ok(/startMs > nowMs \+ MAX_DAYS_AHEAD \* 86400000/.test(SRC), 'MAX_DAYS_AHEAD cap still present');
  assert.ok(SRC.indexOf('FOOTBALL_TMINUS_HOURS * 3600000') > SRC.indexOf('MAX_DAYS_AHEAD * 86400000'),
    'football near-window sits alongside the far cap');
});
