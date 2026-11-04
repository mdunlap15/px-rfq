// US election races as parlay legs (2026-11-02), a port of the order book's
// poster-service/election_cycle.py. Locked here:
//   * fair = mean of the Kalshi and Polymarket mids, with the poster's declines
//     (unreadable venue, spread, venue gap, Kalshi pair sum, fair window);
//   * leg mapping across both candidates' markets, and offered q = (f+e)/(1+e),
//     i.e. exactly MIN_EV per $ we risk;
//   * steam hold, fill hold, max read age, takedown at ELEC_STOP_UTC;
//   * registration gate (unmapped race / past stop never enters the index);
//   * one election leg per parlay; per-race cap;
//   * priceParlay prices election legs off the mirror, never vig.
//
// Run: node --test test/election-rfq.test.js

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// The production default ELEC_STOP_UTC (2026-11-03T22:00Z) is in the past once
// election day ends, which put every pricing test past the takedown and turned
// the suite red. Pin it a week ahead of NOW; the takedown test sets its own.
if (!process.env.ELEC_STOP_UTC) process.env.ELEC_STOP_UTC = new Date(Date.now() + 7 * 864e5).toISOString();

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const election = require('../services/election');
const lineManager = require('../services/line-manager');
const orderTracker = require('../services/order-tracker');
const pricer = require('../services/pricer');
const { config } = require('../config');

const MAP = { races: [
  { eid: 101, name: 'Florida Senate Winner', rk: 'senate:florida', cands: [
    { px_name: 'Ashley Moody (R)', px_market_id: 1, kalshi: 'FL-R', poly_id: '901' },
    { px_name: 'Angie Nixon (D)', px_market_id: 2, kalshi: 'FL-D', poly_id: '902' } ] },
  { eid: 202, name: 'Iowa Senate Winner', rk: 'senate:iowa', cands: [
    { px_name: 'Josh Turek (D)', px_market_id: 3, kalshi: 'IA-D', poly_id: '903' },
    { px_name: 'Jim Carlin (R)', px_market_id: 4, kalshi: 'IA-R', poly_id: '904' } ] },
] };
const mapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elec-')), 'map.json');
fs.writeFileSync(mapFile, JSON.stringify(MAP));

// Kalshi FL-R mid 0.80, Poly 0.82 -> fair A 0.81; Iowa A mid 0.50 / 0.51 -> 0.505.
function goodK() { return { 'FL-R': [0.79, 0.81], 'FL-D': [0.19, 0.21], 'IA-D': [0.49, 0.51], 'IA-R': [0.49, 0.51] }; }
function goodP() { return { 901: [0.81, 0.83], 903: [0.50, 0.52] }; }

function reset(now = Date.now()) {
  election._resetForTest(mapFile);
  election.applyRead(goodK(), goodP(), now);
}
const leg = (eid, name, selection) => ({ sport: 'politics', marketType: 'election_winner', pxEventId: eid, marketName: name, selection });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('raceFair: mean of the two mids when every poster rule passes', () => {
  reset();
  const r = election.raceFair(MAP.races[0], goodK(), goodP());
  assert.strictEqual(r.why, null);
  assert.ok(close(r.fair, 0.81));
});

test('raceFair: each poster decline', () => {
  const r = MAP.races[0];
  const K = goodK(), P = goodP();
  assert.match(election.raceFair(r, { ...K, 'FL-D': undefined }, P).why, /kalshi unreadable/);
  assert.match(election.raceFair(r, K, {}).why, /polymarket unreadable/);
  assert.match(election.raceFair(r, { ...K, 'FL-R': [0.78, 0.82] }, P).why, /kalshi spread/);
  assert.match(election.raceFair(r, K, { 901: [0.80, 0.84] }).why, /polymarket spread/);
  assert.match(election.raceFair(r, K, { 901: [0.83, 0.85] }).why, /venues disagree/);   // 0.80 vs 0.84 = 4pp > 2pp
  assert.match(election.raceFair(r, { ...K, 'FL-D': [0.29, 0.31] }, P).why, /kalshi pair sums/);
  assert.match(election.raceFair(r, { 'FL-R': [0.94, 0.96], 'FL-D': [0.04, 0.06] }, { 901: [0.94, 0.96] }).why, /outside window/);
});

test('getElectionQuote: four legs map onto fair A, offered = (f+e)/(1+e) = EV e per $ risked', () => {
  reset();
  const e = election.cfg().minEv;
  const cases = [
    [leg(101, 'Ashley Moody (R)', 'yes'), 0.81],
    [leg(101, 'Ashley Moody (R)', 'no'), 0.19],
    [leg(101, 'Angie Nixon (D)', 'yes'), 0.19],
    [leg(101, 'Angie Nixon (D)', 'no'), 0.81],
  ];
  for (const [li, f] of cases) {
    const q = election.getElectionQuote(li);
    assert.ok(q.ok, JSON.stringify(q));
    assert.ok(close(q.fairProb, f), `${li.marketName} ${li.selection}: fair ${q.fairProb} vs ${f}`);
    assert.ok(close(q.bookPriceOverride, (f + e) / (1 + e)));
    // We hold the other side. Bettor stake s at implied q => we risk s(1-q)/q.
    const s = 100, R = s * (1 - q.bookPriceOverride) / q.bookPriceOverride;
    const ev = ((1 - f) * s - f * R) / R;
    assert.ok(close(ev, e, 1e-9), `EV per $ risked ${ev} vs ${e}`);
    assert.ok(q.bookPriceOverride > f, 'never quoted at or below fair');
  }
});

test('getElectionQuote: unmapped race / unknown candidate declines', () => {
  reset();
  assert.strictEqual(election.getElectionQuote(leg(999, 'Ashley Moody (R)', 'yes')).reason, 'election_race_unmapped');
  assert.strictEqual(election.getElectionQuote(leg(101, 'Someone Else', 'yes')).reason, 'election_race_unmapped');
});

test('a declined race does not quote', () => {
  election._resetForTest(mapFile);
  election.applyRead(goodK(), { 901: [0.83, 0.85], 903: [0.50, 0.52] });
  const q = election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes'));
  assert.strictEqual(q.reason, 'election_declined');
  assert.ok(election.getElectionQuote(leg(202, 'Josh Turek (D)', 'yes')).ok, 'the other race is unaffected');
});

test('a read older than ELEC_RFQ_MAX_AGE_SEC declines', () => {
  const t0 = Date.now();
  reset(t0);
  const age = election.cfg().maxAgeSec;
  assert.ok(election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes'), t0 + (age - 1) * 1000).ok);
  assert.strictEqual(election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes'), t0 + (age + 1) * 1000).reason, 'election_stale');
});

test('steam: fair moving >= STEAM_PP inside the window darks the race for STEAM_HOLD_S', () => {
  const t0 = Date.now();
  reset(t0);
  const c = election.cfg();
  // +2pp: below the 3pp steam threshold
  election.applyRead({ ...goodK(), 'FL-R': [0.81, 0.83], 'FL-D': [0.17, 0.19] }, { 901: [0.83, 0.85], 903: [0.50, 0.52] }, t0 + 10e3);
  assert.ok(election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes'), t0 + 11e3).ok);
  // +3pp from the first read
  election.applyRead({ ...goodK(), 'FL-R': [0.82, 0.84], 'FL-D': [0.16, 0.18] }, { 901: [0.84, 0.86], 903: [0.50, 0.52] }, t0 + 20e3);
  const q = election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes'), t0 + 21e3);
  assert.strictEqual(q.reason, 'election_hold');
  assert.match(q.detail, /steam/);
  assert.ok(election.getElectionQuote(leg(202, 'Josh Turek (D)', 'yes'), t0 + 21e3).ok, 'steam is per race');
  // Hold expires; keep reads fresh and flat.
  const after = t0 + 20e3 + c.steamHoldS * 1000 + 1000;
  election.applyRead({ ...goodK(), 'FL-R': [0.82, 0.84], 'FL-D': [0.16, 0.18] }, { 901: [0.84, 0.86], 903: [0.50, 0.52] }, after - 500);
  assert.ok(election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes'), after).ok, 'quotes again after the hold');
});

test('fill hold: confirmed risk growing on a race darks it for ELEC_FILL_HOLD_S', () => {
  const t0 = Date.now();
  reset(t0);
  election.noteRisk(101, 0, t0);
  election.noteRisk(101, 400, t0 + 1000);
  const q = election.getElectionQuote(leg(101, 'Angie Nixon (D)', 'yes'), t0 + 2000);
  assert.strictEqual(q.reason, 'election_hold');
  assert.match(q.detail, /fill/);
  election.applyRead(goodK(), goodP(), t0 + election.cfg().holdS * 1000 + 1500);
  assert.ok(election.getElectionQuote(leg(101, 'Angie Nixon (D)', 'yes'), t0 + election.cfg().holdS * 1000 + 2000).ok);
});

test('takedown: past ELEC_STOP_UTC nothing prices or registers', () => {
  reset();
  const prev = process.env.ELEC_STOP_UTC;
  process.env.ELEC_STOP_UTC = new Date(Date.now() - 60e3).toISOString();
  try {
    assert.strictEqual(election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes')).reason, 'election_stopped');
    assert.strictEqual(election.registrationRefusal(leg(101, 'Ashley Moody (R)', 'yes')), 'election_stopped');
  } finally { if (prev == null) delete process.env.ELEC_STOP_UTC; else process.env.ELEC_STOP_UTC = prev; }
  assert.strictEqual(election.registrationRefusal(leg(101, 'Ashley Moody (R)', 'yes')), null);
});

test('kill-switch ELEC_RFQ_ENABLED=false refuses registration and pricing', () => {
  reset();
  process.env.ELEC_RFQ_ENABLED = 'false';
  try {
    assert.strictEqual(election.registrationRefusal(leg(101, 'Ashley Moody (R)', 'yes')), 'election_disabled');
    assert.strictEqual(election.getElectionQuote(leg(101, 'Ashley Moody (R)', 'yes')).reason, 'election_disabled');
  } finally { delete process.env.ELEC_RFQ_ENABLED; }
});

test('registration: an unmapped race or an unknown side does not enter the index', () => {
  reset();
  assert.strictEqual(election.registrationRefusal(leg(999, 'Ashley Moody (R)', 'yes')), 'election_race_unmapped');
  assert.strictEqual(election.registrationRefusal(leg(101, 'Ashley Moody (R)', 'maybe')), 'election_side_unknown');
  const idx = lineManager.__debugGetLineIndex();
  // Through the restore path (_setSeedLine is what cache hydration uses).
  assert.strictEqual(typeof lineManager.lookupLine, 'function');
  assert.ok(!idx['never-registered']);
});

// ---------------------------------------------------------------- pricer
const LINES = {};
const origLookup = lineManager.lookupLine;
lineManager.lookupLine = (id) => LINES[id] || null;
process.on('exit', () => { lineManager.lookupLine = origLookup; });
const START = new Date(Date.now() + 8 * 86400e3).toISOString();
function addLine(id, eid, name, selection) {
  LINES[id] = Object.assign(leg(eid, name, selection), { lineId: id, teamName: name, playerName: name, startTime: START, startTimeMs: Date.parse(START), election: true, pxEventName: 'race ' + eid });
}
addLine('fl-moody-yes', 101, 'Ashley Moody (R)', 'yes');
addLine('fl-nixon-yes', 101, 'Angie Nixon (D)', 'yes');
addLine('ia-turek-yes', 202, 'Josh Turek (D)', 'yes');

test('shouldDecline: two election legs decline (different races AND same race)', () => {
  reset();
  for (const ids of [['fl-moody-yes', 'ia-turek-yes'], ['fl-moody-yes', 'fl-nixon-yes']]) {
    const r = pricer.shouldDecline(ids.map(id => ({ line_id: id })), null);
    assert.ok(r && r.declined, ids.join('+'));
    assert.strictEqual(r.reason, 'election_multi_leg');
  }
});

test('shouldDecline: per-race cap counts confirmed risk + one full ticket', () => {
  reset();
  const orig = orderTracker.getElectionRiskByRace;
  const cap = election.cfg().maxRaceRisk, ticket = election.cfg().maxRiskPerParlay;
  try {
    orderTracker.getElectionRiskByRace = () => ({ 101: cap - ticket + 1 });
    const r = pricer.shouldDecline([{ line_id: 'fl-moody-yes' }], null);
    assert.ok(r && r.declined);
    assert.strictEqual(r.reason, 'election_race_cap');
    orderTracker.getElectionRiskByRace = () => ({ 101: cap - ticket });
    const r2 = pricer.shouldDecline([{ line_id: 'fl-moody-yes' }], null);
    assert.ok(!(r2 && r2.reason === 'election_race_cap'), String(r2 && r2.reason));
  } finally { orderTracker.getElectionRiskByRace = orig; }
});

test('priceParlay: election legs price off the mirror (no vig), fair = Kalshi/Poly fair', async () => {
  reset();
  if (!(config.pricing.maxRiskPerParlay >= 500)) config.pricing.maxRiskPerParlay = 500;
  const r = await pricer.priceParlay(['fl-nixon-yes', 'ia-turek-yes']);
  assert.ok(r && r.offer, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
  const e = election.cfg().minEv;
  const qN = (0.19 + e) / (1 + e), qT = (0.505 + e) / (1 + e);
  assert.ok(Math.abs(r.meta.fairParlayProb - 0.19 * 0.505) < 1e-4, `fair ${r.meta.fairParlayProb}`);
  const legs = r.meta.legs;
  assert.ok(legs.every(l => l.legVig === 0), 'mirror legs carry no vig');
  const offered = 100 / (r.offer.odds + 100);
  assert.ok(offered >= qN * qT - 2e-4, `offered ${offered} must not be more generous than ${qN * qT}`);
  assert.ok(r.maxRisk <= election.cfg().maxRiskPerParlay + 1e-6 || r.offer.max_risk <= election.cfg().maxRiskPerParlay + 1e-6,
    'election cap bounds the ticket');
});

test('priceParlay: a held race fails closed with the reason', async () => {
  const t0 = Date.now();
  reset(t0);
  election.noteRisk(202, 0, t0); election.noteRisk(202, 300, t0 + 1);
  const r = await pricer.priceParlay(['fl-nixon-yes', 'ia-turek-yes']);
  assert.strictEqual(r, null);
  assert.match(pricer.priceParlay._lastFailure.detail, /election_hold/);
});

test('registration: a real PX race board registers YES+NO on both candidates; ambiguous/unmapped do not', async () => {
  reset();
  const px = require('../services/prophetx');
  const orig = px.fetchMarkets;
  // PX shape, 2026-11-02 Florida Senate: one line_id per side, several price rows per side.
  const board = [
    { name: 'Ashley Moody (R)', selections: [[{ name: 'YES', line_id: 'm-y', odds: -910 }, { name: 'YES', line_id: 'm-y', odds: -1500 }], [{ name: 'NO', line_id: 'm-n', odds: 900 }]] },
    { name: 'Angie Nixon (D)', selections: [[{ name: 'YES', line_id: 'n-y', odds: 385 }], [{ name: 'NO', line_id: 'n-n', odds: -880 }, { name: 'NO', line_id: 'n-n2', odds: -1550 }]] },
    { name: 'Write-in', selections: [[{ name: 'YES', line_id: 'w-y' }], [{ name: 'NO', line_id: 'w-n' }]] },
  ];
  let reads = 0;
  px.fetchMarkets = async () => { reads++; return board; };
  const idx = lineManager.__debugGetLineIndex();
  try {
    const n = await lineManager._registerElectionEvent({ event_id: 101, name: 'Florida Senate Winner', scheduled: START, sport_name: 'Politics', sub_type: 'outrights' });
    assert.strictEqual(n, 2, 'Moody YES+NO; Nixon has two NO line_ids (ambiguous) -> skipped; write-in unmapped');
    assert.strictEqual(idx['m-y'].selection, 'yes');
    assert.strictEqual(idx['m-n'].marketType, 'election_winner');
    assert.ok(!idx['n-y'] && !idx['w-y']);
    assert.strictEqual(await lineManager._registerElectionEvent({ event_id: 999, name: 'Unmapped' }), 0);
    assert.strictEqual(reads, 1, 'no PX read for an unmapped race');
  } finally {
    px.fetchMarkets = orig;
    for (const k of ['m-y', 'm-n', 'n-y', 'n-n', 'w-y', 'w-n']) delete idx[k];
  }
});
