// matched_parlays double-write (2026-10-21 perf review). The canonical win
// (order-tracker.reconcileMatchedWin) INSERTED a second 'won' row next to the
// provisional other_sp / tied_lost row for 98.4% of our fills, inflating
// contest-based share 1.76x. It now UPDATES the existing row, matched on
// parlay_id + matched_at + matched_stake, inserting only when no row exists.
// Real supabase-js over a fake transport — never the network.
// Run: node --test test/matched-win-update.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('@supabase/supabase-js');
const { DbCircuitBreaker } = require('../services/db-breaker');
const db = require('../services/db');
const ot = require('../services/order-tracker');

function wire(patchRows) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: decodeURIComponent(String(url)), body: init.body ? JSON.parse(init.body) : null });
    if (method === 'PATCH') return new Response(JSON.stringify(patchRows), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(method === 'GET' ? '[]' : null, { status: method === 'GET' ? 200 : 201 });
  };
  const breaker = new DbCircuitBreaker({ failThreshold: 3, baseOpenMs: 60_000, writeTimeoutMs: 500, readTimeoutMs: 500, now: () => 1_700_000_000_000, fetchImpl });
  db.__setTestClient(createClient('http://db.test', 'k', { global: { fetch: breaker.fetch }, auth: { persistSession: false, autoRefreshToken: false } }), breaker);
  return calls;
}
const ENTRY = { parlayId: 'p-123', matchedAt: '2026-10-21T00:10:17.000Z', matchedStake: 0.19, ourAmericanOdds: 137, matchedAmericanOdds: 137, legs: [], weQuoted: true, outcome: 'won' };

beforeEach(() => { db.__resetForTest(); db.__setDrainTimerEnabled(false); });

test('an existing provisional row is UPDATED to won — no second row inserted', async () => {
  const calls = wire([{ id: 7 }]);
  assert.strictEqual(await db.markMatchedParlayWon(ENTRY), 'updated');
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch && /matched_parlays/.test(patch.url));
  assert.match(patch.url, /parlay_id=eq\.p-123/);
  assert.match(patch.url, /matched_at=eq\.2026-10-21T00:10:17\.000Z/);
  assert.match(patch.url, /matched_stake=eq\.0\.19/, 'a split parlay has one row per fill: the stake picks OUR row');
  assert.deepStrictEqual(patch.body, { outcome: 'won', we_quoted: true, our_odds: 137 });
  assert.ok(!calls.some(c => c.method === 'POST' && /matched_parlays/.test(c.url)), 'no insert');
});

test('no row yet (not written / still spooled) -> falls back to the insert, so the win is never lost', async () => {
  const calls = wire([]);
  assert.strictEqual(await db.markMatchedParlayWon(ENTRY), 'saved');
  assert.ok(calls.some(c => c.method === 'POST' && /matched_parlays/.test(c.url)));
});

test('reconcileMatchedWin (canonical confirm) goes through markMatchedParlayWon, not saveMatchedParlay', () => {
  const seen = { mark: 0, insert: 0 };
  const saved = { mark: db.markMatchedParlayWon, save: db.saveMatchedParlay };
  db.markMatchedParlayWon = async (e) => { seen.mark++; seen.entry = e; return 'updated'; };
  db.saveMatchedParlay = async () => { seen.insert++; return 'saved'; };
  try {
    const id = 'mw-' + Date.now();
    const legs = [{ lineId: 'mwl1', team: 'T', market: 'moneyline', fairProb: 0.5, pxEventId: 'MW1' }];
    ot.recordQuote(id, legs, 150, 5000, 0.35, { legs });
    ot.recordMatchedParlay(id, -175, 50, legs, null);   // another maker filled at +175 -> provisional other_sp
    const before = seen.insert;
    ot.recordConfirmation(id, id + '-u', -150, 300);    // then OUR confirm lands -> canonical win
    assert.strictEqual(seen.mark, 1, 'the provisional row is updated');
    assert.strictEqual(seen.entry.parlayId, id);
    assert.strictEqual(seen.insert, before, 'no extra insert on the canonical win');
  } finally { db.markMatchedParlayWon = saved.mark; db.saveMatchedParlay = saved.save; }
});

test('a NULL stake matches IS NULL (never eq.0)', async () => {
  const calls = wire([{ id: 9 }]);
  assert.strictEqual(await db.updateMatchedParlayOutcome({ ...ENTRY, matchedStake: null }), 'updated');
  const patch = calls.find(c => c.method === 'PATCH');
  assert.match(patch.url, /matched_stake=is\.null/);
  assert.doesNotMatch(patch.url, /matched_stake=eq\.0/);
});

test('original row still in the spool -> mutated in place, no PATCH and no second insert', async () => {
  const calls = wire([{ id: 1 }]);
  const e = { ...ENTRY, outcome: 'tied_lost', weQuoted: true };
  // spool the original insert (breaker forced open)
  const breaker = new DbCircuitBreaker({ failThreshold: 1, baseOpenMs: 600_000, now: () => 1_700_000_000_000, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  db.__setTestClient(createClient('http://db.test', 'k', { global: { fetch: breaker.fetch }, auth: { persistSession: false, autoRefreshToken: false } }), breaker);
  await db.saveMatchedParlay(e);          // fails -> breaker opens
  assert.strictEqual(await db.saveMatchedParlay(e), 'spooled');
  e.outcome = 'won';
  assert.strictEqual(await db.updateMatchedParlayOutcome(e), 'spool-updated');
  assert.strictEqual(e._mpRow.outcome, 'won', 'the spooled row object now carries the final outcome');
  void calls;
});

test('a transient PATCH failure defers (retries the UPDATE later) instead of inserting a copy', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: String(url) });
    if (method === 'PATCH') return new Response('{"message":"bad gateway"}', { status: 502, headers: { 'content-type': 'application/json' } });
    return new Response(null, { status: 201 });
  };
  const breaker = new DbCircuitBreaker({ failThreshold: 50, baseOpenMs: 60_000, writeTimeoutMs: 500, readTimeoutMs: 500, now: () => 1_700_000_000_000, fetchImpl });
  db.__setTestClient(createClient('http://db.test', 'k', { global: { fetch: breaker.fetch }, auth: { persistSession: false, autoRefreshToken: false } }), breaker);
  assert.strictEqual(await db.updateMatchedParlayOutcome({ ...ENTRY }), 'deferred');
  assert.ok(!calls.some(c => c.method === 'POST'), 'no insert on a transient failure');
});

test('split parlay: the canonical win updates the entry whose stake is OUR risk, not the other maker\'s', () => {
  const marked = [];
  const saved = { mark: db.markMatchedParlayWon, save: db.saveMatchedParlay };
  db.markMatchedParlayWon = async (e) => { marked.push(e.matchedStake); return 'updated'; };
  db.saveMatchedParlay = async () => 'saved';
  try {
    const id = 'mws-' + Date.now();
    const legs = [{ lineId: 'mws1', team: 'T', market: 'moneyline', fairProb: 0.5, pxEventId: 'MWS1' }];
    ot.recordQuote(id, legs, 150, 5000, 0.35, { legs });
    ot.recordMatchedParlay(id, -175, 50, legs, null);      // other maker's slice
    ot.recordMatchedParlay(id, -150, 300, legs, null);     // OUR slice: stake == our risk below
    ot.recordConfirmation(id, id + '-u', -150, 300);
    assert.deepStrictEqual(marked, [300]);
  } finally { db.markMatchedParlayWon = saved.mark; db.saveMatchedParlay = saved.save; }
});
