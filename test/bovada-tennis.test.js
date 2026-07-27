// Regression tests for the Bovada tennis parser — the server-side tennis
// backstop.
//
// Background (2026-07-26): tennis went dark repeatedly because neither
// existing source can cover PX's slate. TOA catalogs only Slams/Masters —
// all 41 tennis keys were inactive and there is no key at all for ATP
// Washington / ATP Los Cabos / WTA Washington, which was the entire 30-event
// PX slate. The DK Puppeteer scrape returns 41/41 matches locally but EMPTY
// from Railway (Akamai/datacenter-IP gating, same problem that forced the
// golf-outright paste path), so prod tennis sat at 0 cached events for 18+
// hours while quoting only deferred moneyline shells.
//
// Bovada's coupon endpoint is plain HTTPS JSON and works in production.
//
// These tests use a fixture captured from the live response so they are
// deterministic and never touch the network.
//
// Run: npm test   (or: node --test test/bovada-tennis.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const bt = require('../services/bovada-tennis');

test('2-way de-vig removes the overround and preserves the favourite', () => {
  // Norrie -150 / Kovacevic +125 -> raw 60.0% + 44.4% = 104.4% overround.
  const p = bt.__amerToProb;
  const home = p(-150), away = p(125);
  assert.ok(home + away > 1, 'raw book prices must carry an overround');
  const fair = bt.__devig2(home, away);
  assert.ok(Math.abs(fair.a + fair.b - 1) < 1e-9, 'de-vigged pair must sum to exactly 1');
  assert.ok(fair.a > fair.b, 'the -150 side must remain the favourite');
  assert.ok(Math.abs(fair.a - 0.574) < 0.002, `Norrie fair ~57.4%, got ${(fair.a * 100).toFixed(1)}%`);
});

test('american-odds conversion handles both signs and EVEN', () => {
  const p = bt.__amerToProb;
  assert.ok(Math.abs(p(-500) - 0.8333) < 0.001, '-500 -> 83.3%');
  assert.ok(Math.abs(p(375) - 0.2105) < 0.001, '+375 -> 21.1%');
  assert.equal(p('EVEN'), 0.5);
  assert.equal(p(null), null);
  assert.equal(p(0), null, 'zero is not a valid american price');
});

test('de-vig rejects malformed input rather than emitting a bogus fair', () => {
  assert.equal(bt.__devig2(null, 0.5), null);
  assert.equal(bt.__devig2(0, 0.5), null);
  assert.equal(bt.__devig2(0.5, undefined), null);
});

test('a lopsided favourite still de-vigs to a sane fair', () => {
  // Kwon -500 / Winter +375 — the shape that must not blow past 1.0.
  const p = bt.__amerToProb;
  const fair = bt.__devig2(p(-500), p(375));
  assert.ok(fair.a > 0 && fair.a < 1 && fair.b > 0 && fair.b < 1, 'both sides in (0,1)');
  assert.ok(Math.abs(fair.a - 0.798) < 0.002, `Kwon fair ~79.8%, got ${(fair.a * 100).toFixed(1)}%`);
});
