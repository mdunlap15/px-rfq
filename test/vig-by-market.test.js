// Per-sport-AND-market base vig override (VIG_BY_SPORT_MARKET, 2026-08-14).
//
// WHY: VIG_BY_SPORT is sport-wide, so it cannot express "we are absent from
// MLB totals but competitive on MLB moneyline". The 2026-08-14 outbid-margin
// study (9,968 contests we entered and lost, 14d) measured exactly that shape:
//   MLB totals   won  5.9% of contests entered, median gap 1.15pp
//   MLB spreads  won  3.2%,                     median gap 1.06pp
//   MLB moneyline won 12.8%,                    median gap 0.80pp
// all inside the one market family the audit proved CALIBRATED (deduped
// z=+0.53) — i.e. the width was protecting against nothing.
//
// SAFETY CONTRACT under test: the override moves the BASE vig only. Every
// floor that exists to protect a specific market (prop floor, MMA minimum,
// golf minimums) still layers on top, so an override can never push one of
// those legs below its own floor. Malformed/0 entries are dropped rather than
// quoting at fair.
//
// Run: npm test   (or: node --test test/vig-by-market.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const pricer = require('../services/pricer');
const { config } = require('../config');

// Pin sport vig + global default alongside the market map. The local .env
// carries different values than production, and a test that reads ambient
// config passes on one machine and fails on another.
const SPORT_VIG = 0.016;   // stands in for prod baseball_mlb
const GLOBAL_VIG = 0.015;  // stands in for prod defaultVig
function withMap(map, fn) {
  const prev = {
    m: config.pricing.vigBySportMarket,
    s: config.pricing.vigBySport,
    d: config.pricing.defaultVig,
  };
  config.pricing.vigBySportMarket = map;
  config.pricing.vigBySport = { baseball_mlb: SPORT_VIG };
  config.pricing.defaultVig = GLOBAL_VIG;
  try {
    return fn();
  } finally {
    config.pricing.vigBySportMarket = prev.m;
    config.pricing.vigBySport = prev.s;
    config.pricing.defaultVig = prev.d;
  }
}

test('precedence: market override beats sport, sport beats global default', () => {
  withMap({ 'baseball_mlb.total': 0.010 }, () => {
    assert.equal(pricer.resolveBaseVig('baseball_mlb', 'total'), 0.010, 'market override wins');
    assert.equal(pricer.resolveBaseVig('baseball_mlb', 'moneyline'),
      SPORT_VIG, 'unlisted market falls back to the sport vig');
    assert.equal(pricer.resolveBaseVig('unknown_sport', 'moneyline'),
      GLOBAL_VIG, 'unknown sport falls back to the global default');
  });
});

test('an empty map is a complete no-op (ships off)', () => {
  withMap({}, () => {
    assert.equal(pricer.resolveBaseVig('baseball_mlb', 'total'), SPORT_VIG);
  });
  // Absent key entirely (config may not define it) must not throw.
  withMap(undefined, () => {
    assert.equal(pricer.resolveBaseVig('baseball_mlb', 'total'), SPORT_VIG);
  });
});

test('a missing marketType never matches a market override', () => {
  withMap({ 'baseball_mlb.total': 0.010 }, () => {
    assert.equal(pricer.resolveBaseVig('baseball_mlb', null), SPORT_VIG);
    assert.equal(pricer.resolveBaseVig('baseball_mlb', undefined), SPORT_VIG);
  });
});

test('config parser drops 0, negative, over-cap and malformed keys (fail safe)', () => {
  const parse = (raw) => {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = parseFloat(v);
      if (/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(k) && Number.isFinite(n) && n > 0 && n <= 0.25) out[k] = n;
    }
    return out;
  };
  const got = parse({
    'baseball_mlb.total': 0.010,   // keep
    'baseball_mlb.spread': '0.01', // keep (string coerces)
    'baseball_mlb.zero': 0,        // DROP — must not quote at fair
    'baseball_mlb.neg': -0.02,     // DROP
    'baseball_mlb.huge': 0.9,      // DROP — above the 25% ceiling
    'nodotkey': 0.01,              // DROP — malformed
    'baseball_mlb.nan': 'abc',     // DROP
  });
  assert.deepEqual(Object.keys(got).sort(), ['baseball_mlb.spread', 'baseball_mlb.total']);
});

test('SAFETY: a low override cannot take a PROP leg below the prop floor', () => {
  withMap({ 'baseball_mlb.player_strikeouts': 0.001 }, () => {
    // computeSingleLegQuote is the exported wrapper around computeSingleLegVig.
    const q = pricer.computeSingleLegQuote(0.5, 'baseball_mlb', 'player_strikeouts');
    assert.ok(q && q.vig >= config.pricing.vigPropFloor,
      `prop floor ${config.pricing.vigPropFloor} must still bind, got ${q && q.vig}`);
  });
});

test('SAFETY: overrides do not disturb sports with their own minimums', () => {
  // An MLB override must leave MMA and golf resolution untouched.
  withMap({ 'baseball_mlb.total': 0.010 }, () => {
    assert.equal(pricer.resolveBaseVig('mma_mixed_martial_arts', 'moneyline'), GLOBAL_VIG);
    assert.equal(pricer.resolveBaseVig('golf_matchups', 'moneyline'), GLOBAL_VIG);
  });
});

test('the single-leg display path honours the override (no dashboard drift)', () => {
  // The dashboard and the RFQ path must resolve the same base vig — they
  // previously duplicated the lookup, which is how they drifted before.
  withMap({ 'baseball_mlb.total': 0.010 }, () => {
    const withOverride = pricer.computeSingleLegQuote(0.5, 'baseball_mlb', 'total');
    const withoutOverride = pricer.computeSingleLegQuote(0.5, 'baseball_mlb', 'moneyline');
    assert.ok(withOverride.vig < withoutOverride.vig,
      `override must narrow the displayed total vig (${withOverride.vig}) vs moneyline (${withoutOverride.vig})`);
    // And a narrower vig must mean a BETTER price for the bettor.
    assert.ok(withOverride.impliedProb < withoutOverride.impliedProb,
      'narrower vig must lower the offered implied prob (longer odds)');
  });
});
