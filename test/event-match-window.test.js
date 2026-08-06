// Commence-time proximity guard for odds-event matching.
//
// getEventMarkets picks the closest candidate by time but had NO ceiling, and a
// SINGLE candidate never consulted time at all — so a leg could bind to a
// fixture days or weeks away and price off it silently. The two real cases:
//   - NFL preseason (Aug) binding to the same teams' regular-season game (Sep),
//     ~5 weeks away — 4 of the Aug 13-17 preseason games share a pair.
//   - The 2026-07-23 incident: 5 mid-series MLB games matching the wrong day.
// Legit matches sit within a few hours; a doubleheader ~3h, back-to-back ~24h.
//
// Run: npm test
//
// _withinMatchWindow fails OPEN on missing/unparseable times — we reject only on
// a CONFIRMED large gap, never on absent data.

const { test } = require('node:test');
const assert = require('node:assert');
const of = require('../services/odds-feed');
const w = of._withinMatchWindow;

const base = '2026-08-13T23:00:00Z';
const plus = (h) => new Date(new Date(base).getTime() + h * 3600e3).toISOString();

test('an exact-time match passes', () => {
  assert.equal(w(base, base, 36), true);
});

test('a few hours of jitter passes (timezone / posted-vs-actual)', () => {
  assert.equal(w(base, plus(3), 36), true);
  assert.equal(w(base, plus(-4), 36), true);
});

test('a back-to-back series (~24h) still passes at the default 36h', () => {
  assert.equal(w(base, plus(24), 36), true);
});

test('the preseason->regular-season collision (~5 weeks) is REJECTED', () => {
  assert.equal(w(base, plus(24 * 35), 36), false, 'a September event must not match an August line');
});

test('the mid-series wrong-day case (~48h) is rejected at 36h', () => {
  assert.equal(w(base, plus(48), 36), false);
});

test('the boundary is inclusive', () => {
  assert.equal(w(base, plus(36), 36), true, 'exactly 36h passes');
  assert.equal(w(base, plus(36.5), 36), false, 'just over does not');
});

test('fails OPEN on missing or unparseable times (never reject on absent data)', () => {
  assert.equal(w(null, base, 36), true);
  assert.equal(w(base, null, 36), true);
  assert.equal(w('not a date', base, 36), true);
  assert.equal(w(base, 'garbage', 36), true);
});

test('a non-positive / missing maxHours falls back to the 36h default', () => {
  assert.equal(w(base, plus(35), 0), true, '35h within the 36h fallback');
  assert.equal(w(base, plus(40), undefined), false, '40h beyond the 36h fallback');
  assert.equal(w(base, plus(40), -5), false);
});

test('config exposes the knob with the documented default', () => {
  const { config } = require('../config');
  assert.equal(config.oddsMatchMaxDeltaHours, 36);
});
