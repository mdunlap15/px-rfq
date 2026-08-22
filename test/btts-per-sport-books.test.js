// Per-sport BTTS bookmaker override.
//
// PX posts BTTS on only three competitions (measured across all 96 match
// events, 2026-08-22): MLS, Premier League, Champions League. We already
// covered the first two. TOA carries UCL-qualification BTTS ONLY from
// sportsbet / onexbet / virginbet / livescorebet -- no Pinnacle, DK, FD or
// Matchbook -- at 7.1-8.8% overround.
//
// Adding those to the GLOBAL BTTS_BOOKMAKERS would pull soft books into the
// MLS and EPL consensuses, degrading markets that price well to gain one that
// prices badly. Hence a per-sport override.

const test = require('node:test');
const assert = require('node:assert');

function freshModule(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  delete require.cache[require.resolve('../services/odds-feed')];
  const m = require('../services/odds-feed');
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return m;
}

test('falls back to the global list when no override is set', () => {
  const m = freshModule({ BTTS_BOOKMAKERS_BY_SPORT: '{}' });
  const global = m._bttsBooksFor('soccer_usa_mls');
  assert.ok(global.includes('pinnacle'), 'default list must keep the sharp anchor');
  assert.strictEqual(m._bttsBooksFor('soccer_uefa_champs_league'), global);
});

test('per-sport override applies only to the named sport', () => {
  const m = freshModule({
    BTTS_BOOKMAKERS_BY_SPORT: JSON.stringify({
      soccer_uefa_champs_league_qualification: 'sportsbet,onexbet,virginbet',
    }),
  });
  assert.strictEqual(
    m._bttsBooksFor('soccer_uefa_champs_league_qualification'),
    'sportsbet,onexbet,virginbet');
  // The markets that already price well must be untouched.
  assert.ok(m._bttsBooksFor('soccer_usa_mls').includes('pinnacle'));
  assert.ok(m._bttsBooksFor('soccer_epl').includes('pinnacle'));
  assert.ok(!m._bttsBooksFor('soccer_epl').includes('sportsbet'));
});

test('malformed JSON is ignored rather than taking BTTS down', () => {
  // A bad env value must degrade to the global list, not throw at module load
  // and not silently blank the bookmaker parameter (which would return every
  // book on the planet).
  const m = freshModule({ BTTS_BOOKMAKERS_BY_SPORT: '{not json' });
  assert.ok(m._bttsBooksFor('soccer_epl').includes('pinnacle'));
});

test('blank or non-string override values are ignored', () => {
  const m = freshModule({
    BTTS_BOOKMAKERS_BY_SPORT: JSON.stringify({ soccer_epl: '   ', soccer_usa_mls: 12 }),
  });
  // Empty would produce "&bookmakers=" — an unfiltered request, not a no-op.
  assert.ok(m._bttsBooksFor('soccer_epl').includes('pinnacle'));
  assert.ok(m._bttsBooksFor('soccer_usa_mls').includes('pinnacle'));
});
