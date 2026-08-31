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

test('a PRODUCTIVE supplement keeps running every sweep — never backs off', () => {
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(of._supplementDue('sport_prod', 'h1'), true, `sweep ${i} must run`);
    of._noteSupplementResult('sport_prod', 'h1', 5);   // attached markets
  }
  const st = of.getSupplementState()['sport_prod|h1'];
  assert.strictEqual(st.dryStreak, 0);
  assert.strictEqual(st.backingOff, false, 'a supplement that attaches markets must never be skipped');
});

test('a DRY supplement backs off after the streak', () => {
  const S = 'sport_dry';
  assert.strictEqual(of._supplementDue(S, 'h1'), true);
  of._noteSupplementResult(S, 'h1', 0);                // dry 1
  assert.strictEqual(of._supplementDue(S, 'h1'), true, 'one dry run is not enough to back off');
  of._noteSupplementResult(S, 'h1', 0);                // dry 2 -> threshold
  assert.strictEqual(of._supplementDue(S, 'h1'), false, 'must back off once it is reliably dry');

  const st = of.getSupplementState()[S + '|h1'];
  assert.strictEqual(st.backingOff, true);
  assert.ok(st.nextProbeInSec > 0, 'must schedule a re-probe, not retire permanently');
});

test('one productive run RESETS the backoff — it can always come back', () => {
  const S = 'sport_recover';
  of._noteSupplementResult(S, 'h1', 0);
  of._noteSupplementResult(S, 'h1', 0);
  assert.strictEqual(of._supplementDue(S, 'h1'), false, 'backed off');
  of._noteSupplementResult(S, 'h1', 3);                // a probe found markets
  assert.strictEqual(of._supplementDue(S, 'h1'), true, 'must resume immediately');
  assert.strictEqual(of.getSupplementState()[S + '|h1'].backingOff, false);
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
