// Per-sport same-game block — `sgp_sport_blocked` (2026-09-28).
//
// Operator directive: "Do not allow any NHL SGPs for now. Let's monitor those
// to determine what combo allowances and SGP discount rates we need to apply."
//
// config.pricing.sgpBlockedSports (env SGP_BLOCKED_SPORTS; unset -> NHL,
// '' -> none; runtime key sgpBlockedSports). Locked here:
//   * an NHL same-game group declines as sgp_sport_blocked EVEN WHEN its combo
//     is in SGP_ALLOWED_COMBOS — the block is a pre-pass, not an allowlist
//     entry, so no combo key can re-open it (the mov_sgp_blocked lesson);
//   * cross-game NHL parlays still clear the gate;
//   * MLB same-game is untouched;
//   * a runtime edit to [] re-opens NHL to the ordinary combo gate, and the list
//     is read per RFQ (another sport can be blocked the same way);
//   * the decline detail carries parseable combo=/dir=/markets= tokens that
//     reach the persisted declines row, because monitoring is half the order.
//
// Legs are RAW {line_id}, exactly as PX sends them.
//
// Run: node --test test/sgp-sport-block.test.js

// Belt-and-braces over db.js's own test-run guard: never reach Supabase.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const pricer = require('../services/pricer');
const orderTracker = require('../services/order-tracker');
const db = require('../services/db');
const rtc = require('../services/runtime-config');
const { config } = require('../config');

const NHL = 'icehockey_nhl', MLB = 'baseball_mlb';
const FUTURE = new Date(Date.now() + 30 * 3600e3).toISOString();
const LINES = {};
function add(id, sport, ev, home, away, extra) {
  LINES[id] = Object.assign({
    lineId: id, sport, oddsApiSport: sport, pxEventId: ev,
    homeTeam: home, awayTeam: away,
    startTime: FUTURE, startTimeMs: Date.parse(FUTURE),
  }, extra);
  const li = LINES[id];
  li.oddsApiMarket = li.oddsApiMarket || li.marketType;
  li.oddsApiSelection = li.oddsApiSelection || li.selection;
}
// NHL game 1: Devils @ Rangers
add('n1-ml',   NHL, 'N1', 'New York Rangers', 'New Jersey Devils', { marketType: 'moneyline', selection: 'home', teamName: 'New York Rangers' });
add('n1-pl',   NHL, 'N1', 'New York Rangers', 'New Jersey Devils', { marketType: 'spread', selection: 'home', teamName: 'New York Rangers', line: -1.5 });
add('n1-pl-d', NHL, 'N1', 'New York Rangers', 'New Jersey Devils', { marketType: 'spread', selection: 'away', teamName: 'New Jersey Devils', line: 1.5 });
add('n1-o',    NHL, 'N1', 'New York Rangers', 'New Jersey Devils', { marketType: 'total', selection: 'over', teamName: 'Over', line: 5.5 });
add('n1-u',    NHL, 'N1', 'New York Rangers', 'New Jersey Devils', { marketType: 'total', selection: 'under', teamName: 'Under', line: 5.5 });
add('n1-sog',  NHL, 'N1', 'New York Rangers', 'New Jersey Devils', { marketType: 'player_shots_on_goal', selection: 'over', playerName: 'Artemi Panarin', teamName: 'Artemi Panarin', line: 2.5, fairProb: 0.52, booksWithBothSides: 4, propBooks: ['fanduel', 'draftkings', 'betmgm', 'pinnacle'] });
// NHL game 2: Bruins @ Maple Leafs
add('n2-ml',   NHL, 'N2', 'Toronto Maple Leafs', 'Boston Bruins', { marketType: 'moneyline', selection: 'home', teamName: 'Toronto Maple Leafs' });
add('n2-o',    NHL, 'N2', 'Toronto Maple Leafs', 'Boston Bruins', { marketType: 'total', selection: 'over', teamName: 'Over', line: 6.5 });
// MLB game 1: Yankees @ Red Sox; MLB game 2: Mets @ Braves
add('m1-ml',   MLB, 'M1', 'Boston Red Sox', 'New York Yankees', { marketType: 'moneyline', selection: 'home', teamName: 'Boston Red Sox' });
add('m1-o',    MLB, 'M1', 'Boston Red Sox', 'New York Yankees', { marketType: 'total', selection: 'over', teamName: 'Over', line: 8.5 });
add('m2-ml',   MLB, 'M2', 'Atlanta Braves', 'New York Mets', { marketType: 'moneyline', selection: 'home', teamName: 'Atlanta Braves' });
// Golf outright field event: two DIFFERENT players share one pxEventId.
add('g-a', 'golf_outrights', 'G1', null, null, { marketType: 'outright_top_10', selection: 'yes', playerName: 'Scottie Scheffler', teamName: 'Scottie Scheffler' });
add('g-b', 'golf_outrights', 'G1', null, null, { marketType: 'outright_top_10', selection: 'yes', playerName: 'Rory McIlroy', teamName: 'Rory McIlroy' });

const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
// The fixture totals ARE the primary lines (the MLB alt-total guard asks).
const PRIMARY_TOTAL = { N1: 5.5, N2: 6.5, M1: 8.5 };
const origPrimaryTotal = lineManager.getPrimaryTotalLine;
lineManager.getPrimaryTotalLine = (ev) => (PRIMARY_TOTAL[ev] != null ? PRIMARY_TOTAL[ev] : null);
process.on('exit', () => {
  lineManager.lookupLine = origLookup;
  lineManager.getPrimaryTotalLine = origPrimaryTotal;
});

const decline = (...ids) => pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);
const EVERY_COMBO = ['spread_total', 'ml_total', 'ml_spread', 'prop_nested', 'prop_prop_xteam', 'unclassified', 'prop_total', '3plus'];

function withPricing(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = config.pricing[k]; config.pricing[k] = over[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) config.pricing[k] = saved[k]; }
}
const tok = (detail, name) => {
  const m = String(detail || '').match(new RegExp(`\\b${name}=([^ ]+)`));
  return m ? m[1] : null;
};

// --- config parsing ----------------------------------------------------------

function freshConfigWithEnv(value) {
  const key = require.resolve('../config');
  const savedEntry = require.cache[key];
  const savedEnv = process.env.SGP_BLOCKED_SPORTS;
  if (value === undefined) delete process.env.SGP_BLOCKED_SPORTS;
  else process.env.SGP_BLOCKED_SPORTS = value;
  try {
    delete require.cache[key];
    return require('../config').config.pricing.sgpBlockedSports;
  } finally {
    // Put the ORIGINAL module back so every other module keeps sharing one config.
    require.cache[key] = savedEntry;
    if (savedEnv === undefined) delete process.env.SGP_BLOCKED_SPORTS;
    else process.env.SGP_BLOCKED_SPORTS = savedEnv;
  }
}

test('SGP_BLOCKED_SPORTS unset -> NHL is blocked by default', () => {
  assert.deepStrictEqual(freshConfigWithEnv(undefined), ['icehockey_nhl']);
});

test('SGP_BLOCKED_SPORTS="" -> NO sport blocked (explicit empty is not "fall back to default")', () => {
  assert.deepStrictEqual(freshConfigWithEnv(''), []);
});

test('SGP_BLOCKED_SPORTS is trimmed and lower-cased', () => {
  assert.deepStrictEqual(freshConfigWithEnv(' icehockey_nhl , Basketball_NBA ,'), ['icehockey_nhl', 'basketball_nba']);
});

test('sgpBlockedSports is a registered runtime key (strList, gating, danger)', () => {
  const def = rtc.REGISTRY.find(d => d.key === 'sgpBlockedSports');
  assert.ok(def, 'must be runtime-editable so NHL can re-open without a restart');
  assert.strictEqual(def.type, 'strList');
  assert.strictEqual(def.group, 'gating');
  assert.strictEqual(def.danger, true);
  assert.strictEqual(def.env, 'SGP_BLOCKED_SPORTS');
  assert.strictEqual(def.path, 'sgpBlockedSports');
});

// --- NHL same-game: always declines, whatever the combo list says -----------

test('NHL ML + total same game declines sgp_sport_blocked even with ml_total/spread_total allowed', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    const d = decline('n1-ml', 'n1-o');
    assert.strictEqual(d.declined, true);
    assert.strictEqual(d.reason, 'sgp_sport_blocked', JSON.stringify(d));
    assert.strictEqual(tok(d.detail, 'combo'), 'ml_total');
    assert.strictEqual(tok(d.detail, 'markets'), 'moneyline+total');
    assert.strictEqual(tok(d.detail, 'sport'), 'icehockey_nhl');
    assert.strictEqual(tok(d.detail, 'event'), 'N1');
    assert.match(tok(d.detail, 'dir'), /^(fav|dog|unk)_over$/);
  });
});

test('NHL puck line + total declines with the directional key the grid uses', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    const fav = decline('n1-pl', 'n1-o');
    assert.strictEqual(fav.reason, 'sgp_sport_blocked');
    assert.strictEqual(tok(fav.detail, 'combo'), 'spread_total');
    assert.strictEqual(tok(fav.detail, 'dir'), 'fav_over');
    const dog = decline('n1-pl-d', 'n1-u');
    assert.strictEqual(tok(dog.detail, 'dir'), 'dog_under');
  });
});

test('block holds with EVERY combo key force-added (no allowlist entry re-opens it)', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: EVERY_COMBO }, () => {
    for (const pair of [['n1-ml', 'n1-o'], ['n1-pl', 'n1-o'], ['n1-ml', 'n1-pl'], ['n1-sog', 'n1-o'], ['n1-ml', 'n1-pl', 'n1-o']]) {
      const d = decline(...pair);
      assert.strictEqual(d.declined, true, `${pair.join(' + ')} must decline`);
      assert.strictEqual(d.reason, 'sgp_sport_blocked', `${pair.join(' + ')}: ${JSON.stringify(d)}`);
    }
  });
});

test('combo classification in the detail: ml_spread / prop_total / 3plus', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total'] }, () => {
    const mlSpread = decline('n1-ml', 'n1-pl');
    assert.strictEqual(tok(mlSpread.detail, 'combo'), 'ml_spread');
    assert.strictEqual(tok(mlSpread.detail, 'dir'), 'same_side');
    const prop = decline('n1-sog', 'n1-o');
    // Beats prop_correlation_same_game: the sport block runs first, so NHL
    // prop SGP demand is counted under the same reason as game-line SGPs.
    assert.strictEqual(prop.reason, 'sgp_sport_blocked');
    assert.strictEqual(tok(prop.detail, 'combo'), 'prop_total');
    const three = decline('n1-ml', 'n1-pl', 'n1-o');
    assert.strictEqual(tok(three.detail, 'combo'), '3plus');
    assert.strictEqual(tok(three.detail, 'legs'), '3');
  });
});

test('an NHL SGP riding with an unrelated cross-game leg still declines', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    const d = decline('m2-ml', 'n1-ml', 'n1-o', 'n2-ml');
    assert.strictEqual(d.reason, 'sgp_sport_blocked');
    assert.strictEqual(tok(d.detail, 'event'), 'N1');
  });
});

// --- what must still quote -------------------------------------------------------

test('NHL CROSS-game parlay still clears the gate (the block is same-game only)', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    const d = decline('n1-ml', 'n2-o');
    assert.strictEqual(d.declined, false, JSON.stringify(d));
    assert.strictEqual(d.sgpCombo, null);
  });
});

test('MLB same-game ML + total is unaffected (quotes as ml_total when allowed)', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    const d = decline('m1-ml', 'm1-o');
    assert.strictEqual(d.declined, false, JSON.stringify(d));
    assert.strictEqual(d.sgpCombo, 'ml_total');
  });
});

test('MLB same-game still answers to the ordinary combo gate (not the sport block)', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total'] }, () => {
    const d = decline('m1-ml', 'm1-o');
    assert.strictEqual(d.declined, true);
    assert.strictEqual(d.reason, 'SGP not allowed');
  });
});

test('MLB SGP + NHL cross-game leg quotes (only the blocked sport\'s same-game groups count)', () => {
  withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    const d = decline('m1-ml', 'm1-o', 'n1-ml');
    assert.strictEqual(d.declined, false, JSON.stringify(d));
    assert.strictEqual(d.sgpCombo, 'ml_total');
  });
});

test('golf outright "events" are not same-game even if golf_outrights is listed', () => {
  withPricing({ sgpBlockedSports: ['golf_outrights'] }, () => {
    const d = decline('g-a', 'g-b');
    assert.notStrictEqual(d && d.reason, 'sgp_sport_blocked', JSON.stringify(d));
  });
});

// --- runtime re-open ------------------------------------------------------------

test('runtime edit to an EMPTY list re-opens NHL SGPs to the ordinary combo gate', async () => {
  const saved = config.pricing.sgpBlockedSports;
  const savedCombos = config.pricing.sgpAllowedCombos;
  config.pricing.sgpAllowedCombos = ['spread_total', 'ml_total'];
  try {
    config.pricing.sgpBlockedSports = ['icehockey_nhl'];
    assert.strictEqual(decline('n1-ml', 'n1-o').reason, 'sgp_sport_blocked');

    const r = await rtc.set('sgpBlockedSports', '');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(config.pricing.sgpBlockedSports, []);
    const open = decline('n1-ml', 'n1-o');
    assert.strictEqual(open.declined, false, JSON.stringify(open));
    assert.strictEqual(open.sgpCombo, 'ml_total');

    // Re-opened means "back under the allowlist", not "anything goes".
    config.pricing.sgpAllowedCombos = ['spread_total'];
    assert.strictEqual(decline('n1-ml', 'n1-o').reason, 'SGP not allowed');

    const back = await rtc.set('sgpBlockedSports', 'icehockey_nhl');
    assert.strictEqual(back.ok, true);
    assert.strictEqual(decline('n1-ml', 'n1-o').reason, 'sgp_sport_blocked');
  } finally {
    config.pricing.sgpBlockedSports = saved;
    config.pricing.sgpAllowedCombos = savedCombos;
  }
});

test('the list is read per RFQ: blocking MLB instead re-opens NHL and blocks MLB', () => {
  withPricing({ sgpBlockedSports: ['baseball_mlb'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
    assert.strictEqual(decline('m1-ml', 'm1-o').reason, 'sgp_sport_blocked');
    const nhl = decline('n1-ml', 'n1-o');
    assert.strictEqual(nhl.declined, false, JSON.stringify(nhl));
  });
});

// --- monitoring: the tokens reach the persisted declines row ---------------------

test('the decline row persisted to `declines` carries reason + the combo tokens', () => {
  const origSave = db.saveDecline;
  const rows = [];
  db.saveDecline = async (entry) => { rows.push(entry); };
  try {
    withPricing({ sgpBlockedSports: ['icehockey_nhl'], sgpAllowedCombos: ['spread_total', 'ml_total'] }, () => {
      const d = decline('n1-pl', 'n1-o');
      // Same call shape websocket.js uses on the RFQ path.
      orderTracker.recordDecline(d.reason, { parlayId: 'test-sgp-sport-block', legs: [{}, {}], knownLegs: [], declineDetail: d.detail });
    });
  } finally {
    db.saveDecline = origSave;
  }
  assert.strictEqual(rows.length, 1, 'sgp_sport_blocked must not be in the persist skip-list');
  assert.strictEqual(rows[0].reason, 'sgp_sport_blocked');
  assert.strictEqual(rows[0].parlayId, 'test-sgp-sport-block');
  assert.strictEqual(tok(rows[0].detail, 'combo'), 'spread_total');
  assert.strictEqual(tok(rows[0].detail, 'dir'), 'fav_over');
});
