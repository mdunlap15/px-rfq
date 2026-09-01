'use strict';

// Cover for the 2026-08-31 sweep-cost work.
//
// The per-event supplements (1st-half, team totals) are AWAITED inside
// fetchOddsForSport, so they ran on every sweep for every eligible sport: one
// NFL slate is ~260 calls, NCAAF ~100, at 3-way concurrency with no pacing.
// Measured that day: 360 calls per cycle attaching h2h+0 spread+0 total+0 with
// 103 apiFails — the largest consumer of TOA request frequency, buying nothing,
// while the MAIN markets that actually gate pricing went stale.
//
// The backoff is PRODUCTIVITY-based, not a flat TTL, and that distinction is
// load-bearing: each fetch REBUILDS the parsed cache from scratch, so skipping
// a supplement that WAS attaching markets would silently drop them out of the
// cache. Backing off only when it attaches nothing means there is never
// anything to lose.

const test = require('node:test');
const assert = require('node:assert');

const of = require('../services/odds-feed');

// ------------------------------------------------- productivity backoff

test('a supplement is due on first sight', () => {
  assert.strictEqual(of._supplementDue('sport_a', 'h1'), true);
});

test('a PRODUCTIVE supplement throttles to the min interval, not every sweep', () => {
  // Revised 2026-09-01 (operator TOA credit audit): re-running a SUCCESSFUL
  // per-event supplement on every 150s tick measured ~60k TOA credits/hour on
  // NCAAF H1/Q1 alone — the majority of a 107k/hr account-wide burn that was
  // 429-starving every other consumer of the shared key. A success now waits
  // SUPPLEMENT_MIN_INTERVAL. Coverage is preserved by carry-forward instead
  // (see the carry-forward tests below), NOT by re-fetching constantly.
  assert.strictEqual(of._supplementDue('sport_prod', 'h1'), true, 'first sight must run');
  of._noteSupplementResult('sport_prod', 'h1', 5);
  assert.strictEqual(of._supplementDue('sport_prod', 'h1'), false,
    'a success must throttle — this is the credit-burn fix');
  const st = of.getSupplementState()['sport_prod|h1'];
  assert.strictEqual(st.dryStreak, 0, 'a success is not a dry run');
  assert.strictEqual(st.backingOff, false, 'throttled is not the same as backing off');
  assert.ok(st.nextProbeInSec > 0, 'must schedule a re-run');
});

test('a DRY supplement backs off after the streak', () => {
  const S = 'sport_dry';
  assert.strictEqual(of._supplementDue(S, 'h1'), true);
  of._noteSupplementResult(S, 'h1', 0);                // dry 1
  const afterOne = of.getSupplementState()[S + '|h1'];
  assert.strictEqual(afterOne.backingOff, false, 'one dry run is not yet the long backoff');
  of._noteSupplementResult(S, 'h1', 0);                // dry 2 -> threshold
  assert.strictEqual(of._supplementDue(S, 'h1'), false, 'must back off once it is reliably dry');

  const st = of.getSupplementState()[S + '|h1'];
  assert.strictEqual(st.backingOff, true);
  assert.ok(st.nextProbeInSec > afterOne.nextProbeInSec,
    'the dry-streak backoff must be LONGER than the ordinary min interval');
  assert.ok(st.nextProbeInSec > 0, 'must schedule a re-probe, not retire permanently');
});

test('one productive run RESETS the backoff — it can always come back', () => {
  const S = 'sport_recover';
  of._noteSupplementResult(S, 'h1', 0);
  of._noteSupplementResult(S, 'h1', 0);
  assert.strictEqual(of._supplementDue(S, 'h1'), false, 'backed off');
  const backedOff = of.getSupplementState()[S + '|h1'].nextProbeInSec;
  of._noteSupplementResult(S, 'h1', 3);                // a probe found markets
  const recovered = of.getSupplementState()[S + '|h1'];
  assert.strictEqual(recovered.backingOff, false, 'a productive probe must clear the backoff');
  assert.strictEqual(recovered.dryStreak, 0);
  assert.ok(recovered.nextProbeInSec < backedOff,
    'recovered cadence must be the short min interval, not the long backoff');
});

test('an ERRORING supplement counts as dry, so failures also back off', () => {
  const S = 'sport_err';
  of._noteSupplementResult(S, 'h1', 0);
  of._noteSupplementResult(S, 'h1', 0);
  assert.strictEqual(of._supplementDue(S, 'h1'), false,
    '103 apiFails/cycle must not keep costing the frequency budget');
});

test('backoff is per (sport, supplement) — one dry family cannot mute another', () => {
  of._noteSupplementResult('shared_sport', 'h1', 0);
  of._noteSupplementResult('shared_sport', 'h1', 0);
  assert.strictEqual(of._supplementDue('shared_sport', 'h1'), false);
  assert.strictEqual(of._supplementDue('shared_sport', 'team_totals'), true,
    'team_totals must be unaffected by h1 backing off');
  assert.strictEqual(of._supplementDue('other_sport', 'h1'), true,
    'another sport must be unaffected');
});

// ------------------------------------------------------- attach counting

test('_countSupplementedMarkets counts attached markets, incl. array-valued events', () => {
  const parsed = {
    a: { markets: { h2h_h1: {}, spreads_h1: {} } },
    b: { markets: {} },
    c: [{ markets: { h2h_h1: {} } }, { markets: { totals_h1: {} } }],  // doubleheader shape
    d: null,
  };
  assert.strictEqual(of._countSupplementedMarkets(parsed, ['h2h_h1', 'spreads_h1', 'totals_h1']), 4);
  assert.strictEqual(of._countSupplementedMarkets(parsed, ['team_totals']), 0);
  assert.strictEqual(of._countSupplementedMarkets(null, ['h2h_h1']), 0, 'must be null-safe');
  assert.strictEqual(of._countSupplementedMarkets({}, ['h2h_h1']), 0);
});

// ------------------------------------------------------- cold-sport skip

test('a live sport is never skipped', () => {
  for (let i = 0; i < 5; i++) of._noteSportEventCount('live_sport', 25);
  assert.strictEqual(of._isColdSport('live_sport'), false);
  assert.ok(!of.getColdSports().some((c) => c.sport === 'live_sport'));
});

test('a sport that repeatedly returns ZERO events goes cold', () => {
  const S = 'cold_sport';
  of._noteSportEventCount(S, 0);
  of._noteSportEventCount(S, 0);
  assert.strictEqual(of._isColdSport(S), false, 'two empties is not enough');
  of._noteSportEventCount(S, 0);                       // streak 3 = threshold
  assert.ok(of.getColdSports().some((c) => c.sport === S), 'must be reported as cold');
});

test('one non-empty fetch immediately un-colds a sport', () => {
  const S = 'returning_sport';
  for (let i = 0; i < 5; i++) of._noteSportEventCount(S, 0);
  assert.ok(of.getColdSports().some((c) => c.sport === S));
  of._noteSportEventCount(S, 12);                      // season started
  assert.strictEqual(of._isColdSport(S), false, 'must resume the moment events appear');
  assert.ok(!of.getColdSports().some((c) => c.sport === S));
});

test('a FAILED fetch must never mark a sport cold', () => {
  // This is the dangerous direction: during the 429 storm every sport threw.
  // If a throw counted as "empty", a frequency blip would permanently retire
  // live sports. The sweep only calls _noteSportEventCount on success, so a
  // sport that never reports stays at streak 0.
  const S = 'never_reported';
  assert.strictEqual(of._isColdSport(S), false);
  assert.ok(!of.getColdSports().some((c) => c.sport === S));
});


// ------------------------------------------------------- carry-forward
//
// The supplement throttle above is only safe BECAUSE of this. fetchOddsForSport
// REPLACES oddsCache[sport] wholesale on every fetch, so a market the throttled
// supplement did not re-attach this cycle is simply gone. Without carry-forward,
// throttling NCAAF H1 to a 10-minute interval would decline every H1 leg for up
// to 10 minutes out of every 10.

test('carry-forward restores supplement markets a throttled cycle did not refetch', () => {
  const snap = { 'A@B|e1': { at: Date.now(), markets: { h2h_h1: { x: 1 }, totals_h1: { y: 2 } } } };
  const parsed = { 'A@B': [{ eventId: 'e1', commenceTime: new Date(Date.now() + 6 * 3600e3).toISOString(),
    markets: { h2h: { base: true } } }] };
  const r = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r.restored, 2, 'both held markets restored');
  assert.strictEqual(parsed['A@B'][0].markets.h2h_h1.x, 1);
  assert.ok(parsed['A@B'][0].markets.h2h, 'base markets untouched');
});

test('carry-forward NEVER overwrites a fresh attach with stale data', () => {
  const snap = { 'A@B|e1': { at: Date.now(), markets: { h2h_h1: { stale: true } } } };
  const parsed = { 'A@B': [{ eventId: 'e1', commenceTime: new Date(Date.now() + 6 * 3600e3).toISOString(),
    markets: { h2h_h1: { fresh: true } } }] };
  const r = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r.restored, 0, 'nothing restored — the fresh attach wins');
  assert.deepStrictEqual(parsed['A@B'][0].markets.h2h_h1, { fresh: true });
});

test('carry-forward keys on eventId so doubleheaders do not cross-contaminate', () => {
  const soon = new Date(Date.now() + 6 * 3600e3).toISOString();
  const snap = { 'A@B|g1': { at: Date.now(), markets: { totals_h1: { game: 1 } } } };
  const parsed = { 'A@B': [
    { eventId: 'g1', commenceTime: soon, markets: {} },
    { eventId: 'g2', commenceTime: soon, markets: {} },   // nightcap must NOT inherit game 1
  ] };
  of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(parsed['A@B'][0].markets.totals_h1.game, 1);
  assert.strictEqual(parsed['A@B'][1].markets.totals_h1, undefined,
    'game 2 must not receive game 1 markets');
});

test('carry-forward is safe on empty/missing inputs', () => {
  assert.strictEqual(of._carryForwardSupplements('s', {}, {}).restored, 0);
  assert.strictEqual(of._carryForwardSupplements('s', null, null).restored, 0);
  assert.strictEqual(
    of._carryForwardSupplements('s', { k: null }, { 'k|': { at: Date.now(), markets: { h2h_h1: {} } } }).restored, 0);
});

test('the supplement key list covers the markets that are attached post-parse', () => {
  const keys = of.SUPPLEMENT_MARKET_KEYS || [];
  for (const k of ['h2h_h1', 'spreads_h1', 'totals_h1', 'team_totals', 'btts']) {
    assert.ok(keys.includes(k), `${k} must be carried forward or the throttle drops it`);
  }
});

// ------------------------------------ carry-forward AGE BOUND (review fix)
//
// The first cut of carry-forward re-attached the SAME object every cycle with
// no timestamp, while oddsCache[sport].fetchedAt is re-stamped on every
// replace and isStale() measures only fetchedAt. A 40-minute-old 1H line
// therefore read as FRESH at every gate. This repo had already been bitten by
// exactly this and fixed it the same way — see BOVADA_TENNIS_REAPPLY_MAX_AGE_MS
// ("the re-apply stamps fetchedAt, which would otherwise launder the age").

const HOUR = 3600e3;
const future = () => new Date(Date.now() + 6 * HOUR).toISOString();

test('a fresh snapshot is carried forward', () => {
  const snap = { 'A@B|e1': { at: Date.now(), markets: { h2h_h1: { p: 1 } } } };
  const parsed = { 'A@B': [{ eventId: 'e1', commenceTime: future(), markets: {} }] };
  const r = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r.restored, 1);
  assert.strictEqual(r.expired, 0);
});

test('a market older than the carry bound is DROPPED, not laundered as fresh', () => {
  const snap = { 'A@B|e1': { at: Date.now() - 40 * 60000, markets: { h2h_h1: { p: 1 } } } };
  const parsed = { 'A@B': [{ eventId: 'e1', commenceTime: future(), markets: {} }] };
  const r = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r.restored, 0, 'must NOT re-attach a stale market');
  assert.strictEqual(r.expired, 1, 'and must count the drop');
  assert.strictEqual(parsed['A@B'][0].markets.h2h_h1, undefined,
    'the supplement must fail CLOSED once past the bound');
});

test('the age clock does NOT restart on each carry — it cannot self-chain forever', () => {
  // Cycle 1: carried, stamped with its true age.
  const mkt = { p: 1 };
  const t0 = Date.now() - 15 * 60000;
  let snap = { 'A@B|e1': { at: t0, markets: { h2h_h1: mkt } } };
  let parsed = { 'A@B': [{ eventId: 'e1', commenceTime: future(), markets: {} }] };
  assert.strictEqual(of._carryForwardSupplements('s', parsed, snap).restored, 1);
  assert.ok(mkt.__cfFirstAt, 'first carry must stamp the original age');

  // Cycle 2: a NEW snapshot taken now would look fresh, but the market
  // remembers when it was actually last real.
  snap = { 'A@B|e1': { at: Date.now(), markets: { h2h_h1: mkt } } };
  parsed = { 'A@B': [{ eventId: 'e1', commenceTime: future(), markets: {} }] };
  const r = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r.restored, 1, 'still inside the bound at 15min');

  // Push it past the bound and it must expire despite a fresh snapshot stamp.
  mkt.__cfFirstAt = Date.now() - 45 * 60000;
  parsed = { 'A@B': [{ eventId: 'e1', commenceTime: future(), markets: {} }] };
  const r2 = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r2.restored, 0, 'a re-snapshot must not reset the clock');
  assert.strictEqual(r2.expired, 1);
});

test('carry-forward never resurrects a market for an event that has STARTED', () => {
  // Both suppliers fail closed on a started event; carry-forward must not
  // reverse that guard.
  const snap = { 'A@B|e1': { at: Date.now(), markets: { h2h_h1: { p: 1 } } } };
  const parsed = { 'A@B': [{ eventId: 'e1', commenceTime: new Date(Date.now() - 60000).toISOString(), markets: {} }] };
  const r = of._carryForwardSupplements('s', parsed, snap);
  assert.strictEqual(r.restored, 0, 'a started event must not receive carried markets');
});

test('SUPPLEMENT_MARKET_KEYS uses CACHE names, so MLB F5 is actually covered', () => {
  // The first cut listed the TOA WIRE keys (h2h_1st_5_innings), which never
  // appear in the cache — F5 was silently unprotected.
  const keys = of.SUPPLEMENT_MARKET_KEYS || [];
  for (const k of ['h2h_f5', 'spreads_f5', 'totals_f5']) {
    assert.ok(keys.includes(k), `${k} missing — MLB F5 would not be carried forward`);
  }
  for (const k of keys) {
    assert.ok(!/_1st_5_innings$/.test(k), `${k} is a TOA wire key, not a cache market name`);
  }
});
