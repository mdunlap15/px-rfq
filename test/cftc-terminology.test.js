'use strict';

// ProphetX CFTC terminology migration (deadline 2026-09-03).
//
// PX is renaming its API vocabulary: Wager->Order, Odds->Price, Stake->Quantity,
// Line->Strike, won/lost->profit/loss. Opt-in on the partner/MM surface is the
// `X-CFTC-Terminology: true` header; the parlay SP surface additionally exposes
// a CFTC-by-default tier at /parlay/sp/v2/*.
//
// MEASURED 2026-09-01, live prod, the SAME order on both tiers:
//   /parlay/sp/orders/        confirmed_odds=-230   confirmed_stake=112.33
//   /parlay/sp/v2/orders/     confirmed_price=-230  confirmed_quantity=112.33
//   /parlay/sp/supported-lines      200   /parlay/sp/v2/supported-lines  404
//   /parlay/sp/v2/supported-strikes 200 -> { supported_strikes: [...] }
//
// We normalise NEW -> LEGACY once at the pxFetch ingest boundary rather than
// renaming ~40 read sites. That choice is what dissolves the coupling hazard
// documented at services/leg-id.js:27: strike_id and strike cannot arrive
// separately, so there is no window where a selection has an id but a null
// line — the state where `undefined < 0` is false and every spread side
// registers as 'underdog' (a mispriced quote, not a clean decline).
//
// It also means no novel status string can ever be constructed: without
// normalisation a 'profit' settlement would pass order-tracker's tbd/requested
// blacklist, miss both bogus-settlement guards, and write status
// 'settled_profit' — which satisfies every startsWith('settled_') check but
// matches nothing in services/db.js STATUSES, so those rows would never reload
// from Supabase and realized P&L would report 0.

const test = require('node:test');
const assert = require('node:assert');

const px = require('../services/prophetx');

// ------------------------------------------------------- key normalisation

test('the measured v2 parlay order shape normalises to legacy', () => {
  const payload = { data: { orders: [{
    confirmed_price: -230, confirmed_quantity: 112.33, settled_price: -110,
    settlement_status: 'profit',
    legs: [{ strike_id: 'abc', strike: -1.5, origin_market_strike: 'x', settlement_status: 'loss' }],
  }] } };
  px.normalizeCftcPayload(payload);
  const o = payload.data.orders[0];
  assert.strictEqual(o.confirmed_odds, -230);
  assert.strictEqual(o.confirmed_stake, 112.33);
  assert.strictEqual(o.settled_odds, -110);
  assert.strictEqual(o.settlement_status, 'won', 'profit -> won');
  assert.strictEqual(o.legs[0].line_id, 'abc');
  assert.strictEqual(o.legs[0].line, -1.5);
  assert.strictEqual(o.legs[0].origin_market_line, 'x');
  assert.strictEqual(o.legs[0].settlement_status, 'lost', 'loss -> lost');
});

test('a legacy payload is left byte-identical', () => {
  const payload = { data: { orders: [{ confirmed_odds: -230, confirmed_stake: 1, settlement_status: 'won',
    legs: [{ line_id: 'a', line: -1.5 }] }] } };
  const before = JSON.stringify(payload);
  px.normalizeCftcPayload(payload);
  assert.strictEqual(JSON.stringify(payload), before, 'must be a no-op on legacy vocabulary');
});

test('a legacy key present alongside a new one is NEVER clobbered', () => {
  // Only gaps are filled. If PX ever ships both, the legacy value wins because
  // that is what every downstream reader was written against.
  const payload = { line_id: 'legacy', strike_id: 'new', line: -3, strike: -7 };
  px.normalizeCftcPayload(payload);
  assert.strictEqual(payload.line_id, 'legacy');
  assert.strictEqual(payload.line, -3);
});

test('supported_strikes normalises — an empty read means "prune everything"', () => {
  // getSupportedLines reading only the legacy key under v2 would return [],
  // and an empty supported-line set reads as a prune instruction, not an error.
  const payload = { data: { supported_strikes: [{ strike_id: 'x' }, { strike_id: 'y' }], token: 't' } };
  px.normalizeCftcPayload(payload);
  assert.strictEqual(payload.data.supported_lines.length, 2);
  assert.strictEqual(payload.data.supported_lines[0].line_id, 'x');
});

test('balance rename normalises — reading only the legacy key breaks the cap OPEN', () => {
  const payload = { data: { balance: 100, unmatched_order_balance: 42, unmatched_order_balance_status: 'succeed' } };
  px.normalizeCftcPayload(payload);
  assert.strictEqual(payload.data.unmatched_wager_balance, 42);
  assert.strictEqual(payload.data.unmatched_wager_balance_status, 'succeed');
});

// ------------------------------------------------------------ enum mapping

test('only profit/loss are remapped; push and passthroughs are untouched', () => {
  for (const [input, expected] of [
    ['profit', 'won'], ['loss', 'lost'], ['push', 'push'],
    ['draw', 'draw'], ['no_result', 'no_result'], ['tbd', 'tbd'],
    ['manually_lost', 'manually_lost'], ['manually_won', 'manually_won'],
    ['won', 'won'], ['lost', 'lost'],
  ]) {
    const p = { settlement_status: input };
    px.normalizeCftcPayload(p);
    assert.strictEqual(p.settlement_status, expected, `${input} -> ${expected}`);
  }
});

test('enum mapping is confined to status FIELDS, not any string anywhere', () => {
  // 'profit' is a real numeric field name on PX orders; a blind value sweep
  // would corrupt unrelated data.
  const p = { profit: 12.5, note: 'profit', settlement_status: 'profit' };
  px.normalizeCftcPayload(p);
  assert.strictEqual(p.profit, 12.5, 'the profit AMOUNT field must be untouched');
  assert.strictEqual(p.note, 'profit', 'unrelated strings must be untouched');
  assert.strictEqual(p.settlement_status, 'won');
});

// --------------------------------------------------------------- safety

test('generic price/quantity are deliberately NOT remapped', () => {
  // The doc maps odds->price and stake->quantity, but bare `price`/`quantity`
  // appear in unrelated PX contexts. Only the specific compound keys we
  // actually read are mapped; a blind rename would corrupt real data.
  const p = { price: 5, quantity: 9 };
  px.normalizeCftcPayload(p);
  assert.strictEqual(p.odds, undefined, 'bare price must not become odds');
  assert.strictEqual(p.stake, undefined, 'bare quantity must not become stake');
});

test('normalisation never throws, whatever it is handed', () => {
  for (const bad of [null, undefined, 42, 'str', true, [], {}, [[[]]]]) {
    assert.doesNotThrow(() => px.normalizeCftcPayload(bad), `threw on ${JSON.stringify(bad)}`);
  }
});

test('a cyclic payload terminates instead of hanging the RFQ path', () => {
  const a = { strike_id: 'x' }; a.self = a;
  assert.doesNotThrow(() => px.normalizeCftcPayload(a));
  assert.strictEqual(a.line_id, 'x');
});

test('arrays and deep nesting are walked', () => {
  const p = { a: [{ b: [{ c: { strike_id: 'deep' } }] }] };
  px.normalizeCftcPayload(p);
  assert.strictEqual(p.a[0].b[0].c.line_id, 'deep');
});

test('the same object returned, mutated in place — callers keep their reference', () => {
  const p = { strike_id: 'x' };
  assert.strictEqual(px.normalizeCftcPayload(p), p);
});

test('normalisation is observable', () => {
  const st = px.getCftcNormalizerStats();
  for (const k of ['payloads', 'keysRenamed', 'statusesMapped']) {
    assert.ok(k in st, `stats must report ${k}`);
  }
});

// ----------------------------------------------- the coupling that matters

test('strike_id and strike normalise TOGETHER — the leg-id.js:27 hazard', () => {
  // The deferral at services/leg-id.js:27 exists because accepting strike_id
  // WITHOUT the matching line->strike fix lets a selection through with a null
  // line, and `undefined < 0` is false — tagging every spread side 'underdog'.
  // Normalising at ingest makes that state unreachable: both arrive or neither.
  const sel = { strike_id: 'abc', strike: -2.5 };
  px.normalizeCftcPayload(sel);
  assert.ok(sel.line_id, 'id present');
  assert.ok(Number.isFinite(sel.line), 'and the line is present with it — never an id without a line');
  assert.strictEqual(sel.line < 0, true);
});

// ------------------------------ spread-side fail-closed (independent bug)
//
// Found during this audit and fixed regardless of the migration:
// services/prophetx.js derived side as `line < 0 ? 'favorite' : 'underdog'`.
// `undefined < 0` is FALSE, so a null/absent line tagged EVERY spread side
// 'underdog' — and nothing downstream catches it, because line-manager returns
// true for a null line and the pricer SKIPS the exact-line lookup. The result
// is a mispriced quote rather than a clean decline. Measured 24/24 spread
// sides mis-tagged against a payload whose line field was absent.

const fs = require('fs');
const path = require('path');
const PXSRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'prophetx.js'), 'utf8');

test('no spread-side derivation may fall through to underdog on a null line', () => {
  // Any remaining bare `line < 0 ? 'favorite' : 'underdog'` must be preceded by
  // a finite-check guard; the two that were not are now Number.isFinite-gated.
  const bare = PXSRC.match(/^\s*selection = .*\blegLine < 0\b.*'underdog'/gm) || [];
  const bareSel = PXSRC.match(/^\s*selection = sel\.line < 0 \? 'favorite' : 'underdog'/gm) || [];
  assert.strictEqual(bare.length, 0, 'legLine side derivation must be finite-guarded');
  assert.strictEqual(bareSel.length, 0, 'sel.line side derivation must be finite-guarded');
  assert.ok(/Number\.isFinite\(Number\(sel\.line\)\)/.test(PXSRC), 'sel.line guard present');
  assert.ok(/Number\.isFinite\(Number\(legLine\)\)/.test(PXSRC), 'legLine guard present');
});

test('the balance headroom cap fails CLOSED when the status key is absent', () => {
  // Reading only the legacy key under CFTC vocabulary yields unmatched=0,
  // which makes headroom look MAXIMAL — and the one guard that would catch it
  // was itself skipped when the status key was missing.
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(/unmatched_wager_balance \?\? bal\.unmatched_order_balance/.test(IDX),
    'unmatched balance must read both vocabularies');
  assert.ok(/unmatchedStatus == null/.test(IDX),
    'an absent status must refuse, not silently skip the freshness guard');
});

test('the normaliser is actually WIRED into the pxFetch ingest boundary', () => {
  // Testing normalizeCftcPayload in isolation proves nothing if no call site
  // uses it. A mutation that unwired it from pxFetch passed every other test
  // in this file — the same "helper exists but nobody calls it" gap that took
  // three hot paths off the TOA rate gate.
  assert.ok(/return normalizeCftcPayload\(await resp\.json\(\)/.test(PXSRC),
    'pxFetch must normalise every response — a bare `return resp.json()` bypasses the whole migration layer');
  assert.ok(!/^\s*return resp\.json\(\);\s*$/m.test(PXSRC),
    'no un-normalised resp.json() return may remain in the PX client');
});

// -------------------------------------------- endpoint-scoped renames
//
// Two renames are correct on SOME routes and corrupting on others, so they
// cannot live in the global map. Found by the 2026-09-03 cross-app audit,
// which measured on the production account:
//   /partner/mm/get_wager_histories     header IGNORED (byte-identical)
//   /partner/v2/mm/get_wager_histories  header HONOURED — `orders`, legacy
//                                       keys REMOVED (a rename, not an alias)
//   /partner/v4/mm/get_order_history    CFTC by default, no header
// The v2 tier is where this app reads wager history (index.js:4508), so it is
// the one that matters.

test('container key orders->wagers applies on the wager-history route', () => {
  const p = { data: { orders: [{ wager_id: 'w1' }] } };
  px.normalizeCftcPayload(p, '/partner/v2/mm/get_wager_histories');
  assert.strictEqual(p.data.wagers.length, 1,
    'index.js:4515 reads d.wagers — an unmapped container silently yields []');
});

test('orders->wagers must NOT apply on the parlay surface', () => {
  // The parlay API returns `orders` NATIVELY and always has. A global
  // container rename would stamp a bogus `wagers` alias on every parlay
  // response.
  const p = { data: { orders: [{ confirmed_price: -110 }] } };
  px.normalizeCftcPayload(p, '/parlay/sp/v2/orders/');
  assert.strictEqual('wagers' in p.data, false, 'no bogus alias on the parlay surface');
  assert.strictEqual(p.data.orders[0].confirmed_odds, -110, 'but field mapping still applies');
});

test('bare price/quantity map ONLY on the markets routes', () => {
  // On /v2/mm/get_markets selections these ARE the renames of odds/stake.
  const mk = { data: { markets: [{ selections: [{ price: -150, quantity: 100 }] }] } };
  px.normalizeCftcPayload(mk, '/partner/v2/mm/get_markets');
  const sel = mk.data.markets[0].selections[0];
  assert.strictEqual(sel.odds, -150);
  assert.strictEqual(sel.stake, 100);

  // Anywhere else they are unrelated fields and must be left alone.
  const other = { data: { price: 5, quantity: 9 } };
  px.normalizeCftcPayload(other, '/partner/mm/get_balance');
  assert.strictEqual('odds' in other.data, false, 'a global bare rename would corrupt real data');
  assert.strictEqual('stake' in other.data, false);
});

test('matched_bets container maps on the trades route', () => {
  const p = { data: { trades: [{ bet_id: 'b1' }] } };
  px.normalizeCftcPayload(p, '/partner/mm/get_matched_bets');
  assert.strictEqual(p.data.matched_bets.length, 1);
});

test('the endpoint argument is threaded from pxFetch, not dropped', () => {
  assert.ok(/normalizeCftcPayload\(await resp\.json\(\), endpoint\)/.test(PXSRC),
    'pxFetch must pass its endpoint or every endpoint-scoped map is dead code');
});

test('no endpoint argument still applies the safe global map', () => {
  const p = { strike_id: 'x', settlement_status: 'profit' };
  px.normalizeCftcPayload(p);
  assert.strictEqual(p.line_id, 'x');
  assert.strictEqual(p.settlement_status, 'won');
});

test('wager ROWS get price->odds and quantity->stake, like markets', () => {
  // Caught by simulating the flip against the laptop poster fleet: without
  // this a resting offer normalises with odds undefined, and the relist
  // prices off nothing.
  const p = { data: { orders: [{ order_id: 'w1', price: -110, quantity: 550,
    filled_quantity: 250, open_quantity: 300 }] } };
  px.normalizeCftcPayload(p, '/partner/v2/mm/get_wager_histories');
  const w = p.data.wagers[0];
  assert.strictEqual(w.odds, -110, 'price -> odds on wager rows');
  assert.strictEqual(w.stake, 550, 'quantity -> stake on wager rows');
  assert.strictEqual(w.matched_stake, 250);
  assert.strictEqual(w.unmatched_stake, 300);
  assert.strictEqual(w.wager_id, 'w1');
});
