// PER-SPORT EVENT ALLOWLIST (2026-09-14). NFL/CFB off until Tue 10am ET, but
// Monday Night Football (PX event 19456) had to quote and NO other NFL game.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lm = require('../services/line-manager');
const { config } = require('../config');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

function withMaps(ev, mk, fn) {
  const pe = config.pricing.sportEventAllowlist, pm = config.pricing.sportMarketAllowlist;
  config.pricing.sportEventAllowlist = ev; config.pricing.sportMarketAllowlist = mk;
  try { return fn(); } finally { config.pricing.sportEventAllowlist = pe; config.pricing.sportMarketAllowlist = pm; }
}
const NFL = 'americanfootball_nfl';

test('only the listed NFL event is admitted; every other NFL event is refused', () => {
  withMaps({ [NFL]: ['19456'] }, {}, () => {
    assert.strictEqual(lm._sportMarketAllowed(NFL, 'spread', 19456), true);
    assert.strictEqual(lm._sportMarketAllowed(NFL, 'player_first_td', '19456'), true);
    assert.strictEqual(lm._sportMarketAllowed(NFL, 'spread', 1700008765), false, 'Lions @ Bills must not load');
    assert.strictEqual(lm._sportMarketAllowed(NFL, 'total', undefined), false, 'unknown event fails closed');
  });
});

test('sports without an entry are untouched, and the market allowlist still applies on top', () => {
  withMaps({ [NFL]: ['19456'] }, { soccer_uefa_champs_league: ['total'] }, () => {
    assert.strictEqual(lm._sportMarketAllowed('baseball_mlb', 'moneyline', 123), true);
    assert.strictEqual(lm._sportMarketAllowed('americanfootball_ncaaf', 'spread', 5), true);
    assert.strictEqual(lm._sportMarketAllowed('soccer_uefa_champs_league', 'spread', 9), false);
  });
  withMaps({ [NFL]: ['19456'] }, { [NFL]: [] }, () => {
    assert.strictEqual(lm._sportMarketAllowed(NFL, 'spread', 19456), false, 'an empty market list still blocks the allowed event');
  });
});

test('the seed writer refuses a non-listed event', () => {
  withMaps({ [NFL]: ['19456'] }, {}, () => {
    const denied = lm._setSeedLine('x-other', { sport: NFL, marketType: 'spread', pxEventId: 1700008765 });
    assert.strictEqual(denied._marketDenied, true);
    const ok = lm._setSeedLine('x-mnf', { sport: NFL, marketType: 'spread', pxEventId: 19456 });
    assert.ok(!ok._marketDenied);
  });
});

test('all three index entry points pass the event id', () => {
  assert.ok(/_sportMarketAllowed\(info\.sport \|\| info\.oddsApiSport, info\.marketType, info\.pxEventId\)/.test(SRC), 'seed');
  assert.ok(/_sportMarketAllowed\(cached\.sport \|\| cached\.oddsApiSport, cached\.marketType, cached\.pxEventId\)/.test(SRC), 'cache restore');
  assert.ok(/_sportMarketAllowed\(sportKey, foundInfo\.marketType, foundInfo\.pxEventId != null \? foundInfo\.pxEventId : eventId\)/.test(SRC), 'on-demand');
});
