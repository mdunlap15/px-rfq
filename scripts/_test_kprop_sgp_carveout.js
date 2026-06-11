// Fixture test: K-prop SGP carve-outs are reachable through shouldDecline.
//
// Regression context: the Phase-2 same-game pre-pass (commit 4564859,
// 2026-04-30) blanket-declined ANY prop leg + same-game leg, which made
// the operator-approved (2026-04-27) M3 carve-outs dead code:
//   1. 2-leg K-prop + same-team ML  (sgpKpropMlSameTeam / kprop_ml)
//   2. opposing-pitcher K-prop + K-prop (sgpKpropOpposing / kprop_kprop)
// The fix exempts all-K-prop event groups from the pre-pass so the
// post-loop carve-out logic decides. This test drives shouldDecline with
// stubbed line-manager/odds-feed/order-tracker fixtures and asserts both
// carve-outs allow, every non-carve-out K combo still declines, and the
// Phase-2 block on non-K props is untouched.
//
// Run from project root: node scripts/_test_kprop_sgp_carveout.js

const Module = require('module');
const path = require('path');

const SVC = (name) => path.resolve(__dirname, '..', 'services', name);

function stubModule(absPath, exports) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exports;
  require.cache[absPath] = m;
}

// ---- fixtures ----------------------------------------------------------

const FUTURE = Date.now() + 3600 * 1000;
const NOW = Date.now();

const mlbBase = {
  sport: 'baseball_mlb', oddsApiSport: 'baseball_mlb',
  homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees',
  pxEventName: 'New York Yankees @ Boston Red Sox', marketName: '',
  pxEventId: 'EV1', startTime: new Date(FUTURE).toISOString(), startTimeMs: FUTURE,
};
const kProp = (player, over) => ({
  ...mlbBase,
  marketType: 'player_strikeouts', playerName: player, teamName: player,
  line: over, selection: 'Over', oddsApiSelection: 'Over',
  fairProb: 0.55, booksWithBothSides: 2, propBooks: ['draftkings', 'fanduel'],
  propFetchedAt: NOW,
});
const LINES = {
  // EV1: NYY @ BOS. Cole pitches for NYY, Bello for BOS.
  K_COLE: kProp('Gerrit Cole', 6.5),
  K_COLE_ALT: { ...kProp('Gerrit Cole', 7.5) },
  K_BELLO: kProp('Brayan Bello', 4.5),
  ML_NYY: { ...mlbBase, marketType: 'moneyline', teamName: 'New York Yankees', selection: 'New York Yankees', oddsApiSelection: 'New York Yankees', line: null },
  ML_BOS: { ...mlbBase, marketType: 'moneyline', teamName: 'Boston Red Sox', selection: 'Boston Red Sox', oddsApiSelection: 'Boston Red Sox', line: null },
  TOT_EV1: { ...mlbBase, marketType: 'total', teamName: 'Over', selection: 'Over', oddsApiSelection: 'Over', line: 8.5 },
  // EV2: different MLB game.
  ML_STL: {
    ...mlbBase, pxEventId: 'EV2', pxEventName: 'Chicago Cubs @ St. Louis Cardinals',
    homeTeam: 'St. Louis Cardinals', awayTeam: 'Chicago Cubs',
    marketType: 'moneyline', teamName: 'St. Louis Cardinals', selection: 'St. Louis Cardinals', oddsApiSelection: 'St. Louis Cardinals', line: null,
  },
  // EV3: NBA game — Phase-2 prop, must stay blanket-blocked.
  NBA_PTS: {
    sport: 'basketball_nba', oddsApiSport: 'basketball_nba',
    homeTeam: 'Denver Nuggets', awayTeam: 'Los Angeles Lakers',
    pxEventName: 'Los Angeles Lakers @ Denver Nuggets', marketName: '',
    pxEventId: 'EV3', startTime: new Date(FUTURE).toISOString(), startTimeMs: FUTURE,
    marketType: 'player_points', playerName: 'LeBron James', teamName: 'LeBron James',
    line: 25.5, selection: 'Over', oddsApiSelection: 'Over',
    fairProb: 0.52, booksWithBothSides: 3, propBooks: ['draftkings', 'fanduel', 'pinnacle'],
    propFetchedAt: NOW, propType: 'points',
  },
  ML_DEN: {
    sport: 'basketball_nba', oddsApiSport: 'basketball_nba',
    homeTeam: 'Denver Nuggets', awayTeam: 'Los Angeles Lakers',
    pxEventName: 'Los Angeles Lakers @ Denver Nuggets', marketName: '',
    pxEventId: 'EV3', startTime: new Date(FUTURE).toISOString(), startTimeMs: FUTURE,
    marketType: 'moneyline', teamName: 'Denver Nuggets', selection: 'Denver Nuggets', oddsApiSelection: 'Denver Nuggets', line: null,
  },
};

const PITCHER_SIDE = {
  'Gerrit Cole': 'New York Yankees',
  'Brayan Bello': 'Boston Red Sox',
};

// ---- stub pricer's service deps BEFORE requiring it ---------------------

const sgpAuditCalls = [];
const noop = () => undefined;
const noopProxy = new Proxy({}, { get: (t, k) => (k === '__esModule' ? false : noop) });

stubModule(SVC('line-manager.js'), {
  lookupLine: (id) => LINES[id] || null,
  isLineDisabled: () => false,
  // TOT_EV1 (8.5) is the primary total, so the alt-total block won't fire.
  getPrimaryTotalLine: () => 8.5,
  getPrimarySpreadLine: () => 1.5,
});
stubModule(SVC('odds-feed.js'), {
  getPitcherSide: (sport, home, away, start, player) => PITCHER_SIDE[player] || null,
  getFairProb: () => 0.5,
});
stubModule(SVC('order-tracker.js'), {
  checkRecentDuplicate: () => null,
  checkExposureLimits: () => ({ allowed: true }),
  checkGameExposure: () => ({ allowed: true }),
  checkSeriesExposure: () => ({ allowed: true }),
  checkPlayerExposure: () => null,
});
stubModule(SVC('sig-cooldown.js'), { checkSignatureCooldown: () => null });
stubModule(SVC('sgp-audit.js'), {
  logSgpDecline: (parlayId, eid, props, others) => sgpAuditCalls.push({ parlayId, eid, props, others }),
  isEnabled: () => false,
  buildComboSignature: () => '',
});
stubModule(SVC('push.js'), { notifyCapHit: noop });
stubModule(SVC('dk-scraper.js'), noopProxy);
stubModule(SVC('betonline-scraper.js'), noopProxy);
stubModule(SVC('template-exposure.js'), noopProxy);
stubModule(SVC('v2.js'), noopProxy);

const { shouldDecline } = require('../services/pricer');

// ---- assertions ----------------------------------------------------------

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (info ? '  — ' + info : ''));
  cond ? pass++ : fail++;
};

// 1. CARVE-OUT 1: 2-leg K-prop + same-team ML → ALLOWED, combo kprop_ml.
const r1 = shouldDecline(['K_COLE', 'ML_NYY'], 'T1');
ok('K-prop + same-team ML allowed (carve-out 1)', r1.declined === false,
  r1.declined ? `declined: ${r1.reason} / ${r1.detail}` : `sgpCombo=${r1.sgpCombo}`);
ok('  …classified as kprop_ml SGP', r1.sgpCombo === 'kprop_ml', `got ${r1.sgpCombo}`);

// 2. K-prop + OPPOSITE-team ML → still declined (not the carve-out).
const r2 = shouldDecline(['K_COLE', 'ML_BOS'], 'T2');
ok('K-prop + opposite-team ML declined', r2.declined === true && r2.reason === 'prop_correlation_same_game',
  `reason=${r2.reason}`);

// 3. CARVE-OUT 2: opposing-pitcher K-prop + K-prop → ALLOWED, combo kprop_kprop.
const r3 = shouldDecline(['K_COLE', 'K_BELLO'], 'T3');
ok('opposing-pitcher K + K allowed (carve-out 2)', r3.declined === false,
  r3.declined ? `declined: ${r3.reason} / ${r3.detail}` : `sgpCombo=${r3.sgpCombo}`);
ok('  …classified as kprop_kprop SGP', r3.sgpCombo === 'kprop_kprop', `got ${r3.sgpCombo}`);

// 4. Same-pitcher K + K → declined in the pre-pass (same-player rule intact).
const r4 = shouldDecline(['K_COLE', 'K_COLE_ALT'], 'T4');
ok('same-pitcher K + K declined (same-player rule)', r4.declined === true && r4.reason === 'prop_correlation_same_player',
  `reason=${r4.reason}`);

// 5. K-prop + same-game TOTAL → declined by post-loop rule (d).
const audits5Before = sgpAuditCalls.length;
const r5 = shouldDecline(['K_COLE', 'TOT_EV1'], 'T5');
ok('K-prop + same-game total declined', r5.declined === true && r5.reason === 'prop_correlation_same_game',
  `reason=${r5.reason}`);
ok('  …and shadow-logged to sgp-audit', sgpAuditCalls.length === audits5Before + 1
  && sgpAuditCalls[sgpAuditCalls.length - 1].parlayId === 'T5');

// 6. Phase-2 block untouched: NBA points prop + same-game ML → declined in pre-pass.
const r6 = shouldDecline(['NBA_PTS', 'ML_DEN'], 'T6');
ok('NBA prop + same-game ML still declined (Phase-2 block intact)',
  r6.declined === true && r6.reason === 'prop_correlation_same_game', `reason=${r6.reason}`);

// 7. K-prop + different-game ML → allowed, no SGP combo.
const r7 = shouldDecline(['K_COLE', 'ML_STL'], 'T7');
ok('K-prop + different-game ML allowed', r7.declined === false,
  r7.declined ? `declined: ${r7.reason} / ${r7.detail}` : '');
ok('  …no SGP combo stamped', r7.sgpCombo == null, `got ${r7.sgpCombo}`);

// 8. 3-leg K + same-team ML + other-game ML → declined (carve-out 1 is 2-leg only).
const r8 = shouldDecline(['K_COLE', 'ML_NYY', 'ML_STL'], 'T8');
ok('3-leg K + same-team ML + other ML declined (carve-out is 2-leg only)',
  r8.declined === true && r8.reason === 'prop_correlation_same_game', `reason=${r8.reason}`);

console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail === 0 ? 0 : 1);
