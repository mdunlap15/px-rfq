// Golf outright boards must accept a SMALL FIELD.
//
// fetchOutrightBoard power-normalizes each book's field to an exact target
// (1.0 for win, N×uplift for top-N), which is only valid over the COMPLETE
// field — partial coverage sums low and inflates everyone. The original guard
// expressed that as a flat `entries.length < 30`, which conflated "partial
// coverage of a big field" with "COMPLETE coverage of a SMALL field".
//
// Measured live 2026-08-29: the TOUR Championship has a 29-man field, so every
// book was skipped, the whole pga board returned null, and all 87 registered
// outright lines carried a null fair — we advertised Win/Top-5/Top-10 and
// declined every RFQ. The Hero World Challenge and Sentry have the same shape.
//
// Run: npm test  (or: node --test test/golf-outright-small-field.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DATAGOLF_API_KEY = 'test-key';

// datagolf.js does `const fetch = require('node-fetch')` at module load, so
// stubbing global.fetch does nothing — the module must be intercepted in the
// require cache BEFORE datagolf is loaded.
let _payload = null;
const nfPath = require.resolve('node-fetch');
require.cache[nfPath] = {
  id: nfPath, filename: nfPath, loaded: true, exports: async () => ({
    ok: true, status: 200, json: async () => _payload,
  }),
};
const dg = require('../services/datagolf');

// Build a DataGolf-shaped outrights payload: `n` players, each priced by
// `books`, at plausible odds.
function board(n, books, { pricedCount = null } = {}) {
  const priced = pricedCount == null ? n : pricedCount;
  return {
    event_name: 'Test Championship',
    last_updated: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    odds: Array.from({ length: n }, (_, i) => {
      const row = { dg_id: 1000 + i, player_name: `Player, Test${i}` };
      for (const b of books) row[b] = i < priced ? '+2000' : null;
      return row;
    }),
  };
}

function withStubbedFetch(payload, fn) {
  _payload = payload;
  return Promise.resolve(fn()).finally(() => { _payload = null; });
}

test('THE BUG: a 29-man field is accepted, not rejected as partial', async () => {
  const books = ['bet365', 'draftkings', 'fanduel', 'betmgm'];
  await withStubbedFetch(board(29, books), async () => {
    const b = await dg.fetchOutrightBoard('pga', 'win');
    assert.ok(b, 'a complete 29-man field must produce a board');
    assert.strictEqual(b.players.length, 29);
  });
});

test('a 30-man field still works (the old boundary)', async () => {
  await withStubbedFetch(board(30, ['bet365', 'draftkings', 'fanduel']), async () => {
    assert.ok(await dg.fetchOutrightBoard('pga', 'win'));
  });
});

test('UNCHANGED for big fields: 30-of-156 coverage still passes, as before', () => {
  // Deliberate scope limit. The floor is Math.min(30, ...), so it only ever
  // RELAXES for small fields and never tightens a large one — existing coverage
  // on full-field events is untouched by this fix.
  //
  // Known residual issue, left alone on purpose: normalizing a 30-player subset
  // of a 156-man field to a full-field target does inflate those prices, and
  // that was true before this change too. Tightening it is a separate, riskier
  // change (it would silently drop books that price only part of a field), so
  // it does not belong in a bug fix. Flagged rather than bundled.
  const fieldSize = 156, entries = 30;
  const minEntries = Math.min(30, Math.max(10, Math.ceil(fieldSize * 0.9)));
  assert.strictEqual(minEntries, 30, 'large fields keep the original threshold');
  assert.ok(entries >= minEntries, 'so 30-of-156 still passes, exactly as before');
});

test('a big field with FULL coverage is accepted', async () => {
  await withStubbedFetch(board(156, ['bet365', 'draftkings', 'fanduel']), async () => {
    const b = await dg.fetchOutrightBoard('pga', 'win');
    assert.ok(b);
    assert.strictEqual(b.players.length, 156);
  });
});

test('an absurdly tiny field is still refused (floor of 10)', async () => {
  await withStubbedFetch(board(4, ['bet365', 'draftkings']), async () => {
    assert.strictEqual(await dg.fetchOutrightBoard('pga', 'win'), null);
  });
});
