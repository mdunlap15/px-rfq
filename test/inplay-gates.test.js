// Regression tests for the in-play safeguards (2026-08-10 audit):
//
// 1. Golf OUTRIGHTS are pre-tournament only in BOTH gates. shouldDecline was
//    fixed 2026-07-30 but priceParlay kept the superseded live exemption —
//    and the confirm path runs ONLY priceParlay, so a pre-start outright
//    quote could be honored at confirm after play began.
// 2. ESPN early-actual-start veto (liveStartVetoSports, default tennis):
//    tennis matches start EARLY when the prior match on the court ends fast,
//    so the scheduled-time gate alone can quote a live match. Fails OPEN when
//    ESPN has no match (scheduled gate still governs).
// 3. validateForConfirmation's index-churn accept must re-check started:
//    started lines are exactly what the refresh prunes from the index, so
//    churn and event-start correlate — the accept path needs its own gate.
//
// Run: npm test   (or: node --test test/inplay-gates.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const lineManager = require('../services/line-manager');
const espnScores = require('../services/espn-scores');
const pricer = require('../services/pricer');
const { config } = require('../config');

const FUTURE = new Date(Date.now() + 30 * 60e3).toISOString();      // 30 min out
const FAR_FUTURE = new Date(Date.now() + 72 * 3600e3).toISOString();
const PAST = new Date(Date.now() - 2 * 3600e3).toISOString();       // started 2h ago

function mk(over) {
  const li = Object.assign({
    sport: 'baseball_mlb', marketType: 'moneyline', selection: 'home',
    teamName: 'Home Team', homeTeam: 'Home Team', awayTeam: 'Away Team',
    pxEventId: 100, startTime: FAR_FUTURE,
  }, over);
  li.startTimeMs = li.startTime == null ? null : Date.parse(li.startTime);
  li.oddsApiSport = li.oddsApiSport || li.sport;
  li.oddsApiMarket = li.marketType;
  li.oddsApiSelection = li.selection;
  return li;
}

const LINES = {
  'outright-started': mk({ sport: 'golf_outrights', marketType: 'outright_top_10', selection: 'yes', teamName: 'Scottie Scheffler', playerName: 'Scottie Scheffler', homeTeam: null, awayTeam: null, pxEventId: 200, startTime: PAST }),
  'outright-future':  mk({ sport: 'golf_outrights', marketType: 'outright_top_10', selection: 'yes', teamName: 'Rory McIlroy', playerName: 'Rory McIlroy', homeTeam: null, awayTeam: null, pxEventId: 201, startTime: FAR_FUTURE }),
  'tennis-early':     mk({ sport: 'tennis', teamName: 'Iga Swiatek', homeTeam: 'Iga Swiatek', awayTeam: 'Aryna Sabalenka', pxEventId: 300, startTime: FUTURE }),
  'tennis-normal':    mk({ sport: 'tennis', teamName: 'Carlos Alcaraz', homeTeam: 'Carlos Alcaraz', awayTeam: 'Jannik Sinner', pxEventId: 301, startTime: FUTURE }),
  'mlb-future':       mk({ pxEventId: 400 }),
};

const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
const origLive = espnScores.isMatchLive;
process.on('exit', () => { lineManager.lookupLine = origLookup; espnScores.isMatchLive = origLive; });

// ESPN stub: only Swiatek/Sabalenka is live-early.
espnScores.isMatchLive = (sport, home) => sport === 'tennis' && home === 'Iga Swiatek';

const legs = (...ids) => ids.map(id => ({ line_id: id }));

// --- 1. golf outrights: pre-tournament only, BOTH gates ---------------------

test('shouldDecline declines a started golf outright leg', async () => {
  const d = await pricer.shouldDecline(legs('outright-started', 'mlb-future'), null);
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'event started');
});

test('priceParlay declines a started golf outright leg (confirm-path gate)', async () => {
  const p = await pricer.priceParlay(['outright-started']);
  assert.equal(p, null);
  assert.equal(pricer.priceParlay._lastFailure.reason, 'event started');
});

test('a pre-tournament golf outright leg passes both started gates', async () => {
  const d = await pricer.shouldDecline(legs('outright-future'), null);
  assert.notEqual(d.reason, 'event started');
  await pricer.priceParlay(['outright-future']);
  const f = pricer.priceParlay._lastFailure;
  assert.ok(!f || f.reason !== 'event started', `unexpected: ${f && f.reason}`);
});

// --- 2. ESPN early-actual-start veto (tennis) -------------------------------

test('default config vetoes tennis only', () => {
  assert.deepEqual(config.pricing.liveStartVetoSports, ['tennis']);
});

test('tennis leg live-per-ESPN before scheduled start declines in shouldDecline', async () => {
  const d = await pricer.shouldDecline(legs('tennis-early'), null);
  assert.equal(d.declined, true);
  assert.equal(d.reason, 'event started');
  assert.match(d.detail, /ESPN/);
});

test('tennis leg live-per-ESPN declines in priceParlay (confirm path)', async () => {
  const p = await pricer.priceParlay(['tennis-early']);
  assert.equal(p, null);
  assert.equal(pricer.priceParlay._lastFailure.reason, 'event started');
});

test('tennis leg with no ESPN live match fails OPEN (scheduled gate governs)', async () => {
  const d = await pricer.shouldDecline(legs('tennis-normal'), null);
  assert.notEqual(d.reason, 'event started');
});

test('non-veto sports skip the ESPN check entirely', async () => {
  // Even a lying stub that reports EVERYTHING live must not touch MLB legs.
  const prev = espnScores.isMatchLive;
  espnScores.isMatchLive = () => true;
  try {
    const d = await pricer.shouldDecline(legs('mlb-future'), null);
    assert.notEqual(d.reason, 'event started');
  } finally {
    espnScores.isMatchLive = prev;
  }
});

// --- 3. churn-accept started re-check ---------------------------------------

function churnMeta(legMetas) {
  return {
    quotedAtMs: Date.now() - 20e3, // 20s old — well within budget
    legs: legMetas,
  };
}

test('index churn + started leg fails CLOSED at confirm', async () => {
  // lineId not in the index → priceParlay fails, churn detection fires.
  const meta = churnMeta([
    { lineId: 'gone-1', team: 'Iga Swiatek', market: 'moneyline', sport: 'tennis', startTime: PAST },
  ]);
  const v = await pricer.validateForConfirmation('t-churn-started', meta);
  assert.equal(v.valid, false);
  assert.match(v.reason, /event started/);
});

test('index churn + missing startTime fails CLOSED (cannot verify)', async () => {
  const meta = churnMeta([
    { lineId: 'gone-2', team: 'Mystery Leg', market: 'moneyline', sport: 'baseball_mlb', startTime: null },
  ]);
  const v = await pricer.validateForConfirmation('t-churn-nostart', meta);
  assert.equal(v.valid, false);
  assert.match(v.reason, /event started/);
});

test('index churn + all legs pre-start still accepts on original quote', async () => {
  const meta = churnMeta([
    { lineId: 'gone-3', team: 'Home Team', market: 'moneyline', sport: 'baseball_mlb', startTime: FAR_FUTURE },
  ]);
  const v = await pricer.validateForConfirmation('t-churn-clean', meta);
  assert.equal(v.valid, true);
  assert.match(v.reason, /index churn/);
});

test('index churn + golf matchup leg (null startTime by design) still accepts', async () => {
  const meta = churnMeta([
    { lineId: 'gone-4', team: 'Scheffler vs Rahm', market: 'moneyline', sport: 'golf_matchups', startTime: null },
  ]);
  const v = await pricer.validateForConfirmation('t-churn-golf', meta);
  assert.equal(v.valid, true);
  assert.match(v.reason, /index churn/);
});
