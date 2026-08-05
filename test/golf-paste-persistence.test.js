// Golf outright paste board must survive a redeploy.
//
// The operator's DK "(Including Ties)" paste is the AUTHORITATIVE outright board
// and it lived only in memory. Every Railway deploy wiped it while ~430 outright
// lines stayed registered with PX, so we advertised markets we could not price
// and every outright leg declined. On 2026-08-05 it needed hand-re-pasting three
// times in one day.
//
// The subtle requirement is the timestamp: a restored board keeps its ORIGINAL
// `at`. Restoring as "now" would let a deploy silently rejuvenate a stale board
// and quote a finished tournament — exactly what the age ceiling exists to stop.
//
// Run: npm test   (or: node --test test/golf-paste-persistence.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

// db is a hermetic no-op under the test runner (services/db.js IS_TEST_RUN), so
// stub the KV pair in the module cache to exercise the real round-trip.
const dbPath = require.resolve('../services/db');
const db = require('../services/db');
let _kv = {};
db.saveKV = async (k, v) => { _kv[k] = JSON.parse(JSON.stringify(v)); };
db.loadKV = async (k) => (_kv[k] ? JSON.parse(JSON.stringify(_kv[k])) : null);
require.cache[dbPath].exports = db;

const topN = require('../services/golf-topn');

const MANUAL_MAX_AGE_MS = (Number(process.env.GOLF_OUTRIGHT_PASTE_MAX_AGE_MIN) || 720) * 60 * 1000;

function board(at) {
  return {
    at,
    bySlug: {
      'wyndham-championship': {
        tournament: '2026 Wyndham Championship',
        eventName: '2026 Wyndham Championship',
        manual: true,
        markets: {
          outright_win: { source: 'paste', players: new Map([['cameron young', 0.1099], ['billy horschel', 0.05]]) },
          outright_top_5: { source: 'paste', players: new Map([['cameron young', 0.35], ['billy horschel', 0.2]]) },
        },
      },
    },
  };
}
const reset = () => { _kv = {}; topN.__setCacheForTest({ at: 0, bySlug: {} }); };

test('a pasted board round-trips through the KV store', async () => {
  reset();
  const at = Date.now() - 5 * 60 * 1000;
  topN.__setCacheForTest(board(at));
  assert.equal(await topN.persistPasteBoard(), true);

  topN.__setCacheForTest({ at: 0, bySlug: {} });          // simulate the redeploy
  assert.equal(await topN.restorePasteBoard(), true);

  const c = topN.__getCacheForTest();
  const m = c.bySlug['wyndham-championship'].markets;
  assert.equal(Object.keys(m).length, 2);
  assert.ok(m.outright_win.players instanceof Map, 'players must come back as a Map');
  assert.equal(m.outright_win.players.get('cameron young'), 0.1099);
  assert.equal(m.outright_top_5.players.size, 2);
  assert.equal(c.bySlug['wyndham-championship'].manual, true);
});

test('the restored board keeps its ORIGINAL timestamp, not now', async () => {
  reset();
  const at = Date.now() - 3 * 60 * 60 * 1000;             // 3h old
  topN.__setCacheForTest(board(at));
  await topN.persistPasteBoard();
  topN.__setCacheForTest({ at: 0, bySlug: {} });
  await topN.restorePasteBoard();
  const c = topN.__getCacheForTest();
  assert.equal(c.at, at, 'a deploy must not rejuvenate a board');
  assert.ok(Date.now() - c.at > 2.9 * 3600e3, 'age must still read ~3h');
});

test('a board past the age ceiling is REFUSED, not restored', async () => {
  reset();
  topN.__setCacheForTest(board(Date.now() - (MANUAL_MAX_AGE_MS + 60 * 60 * 1000)));
  await topN.persistPasteBoard();
  topN.__setCacheForTest({ at: 0, bySlug: {} });
  assert.equal(await topN.restorePasteBoard(), false, 'stale board must fail closed');
  assert.equal(Object.keys(topN.__getCacheForTest().bySlug).length, 0);
});

test('restore never clobbers a board that is already loaded', async () => {
  reset();
  topN.__setCacheForTest(board(Date.now() - 60000));
  await topN.persistPasteBoard();
  const live = board(Date.now());
  live.bySlug['wyndham-championship'].markets.outright_win.players = new Map([['fresh player', 0.5]]);
  topN.__setCacheForTest(live);
  assert.equal(await topN.restorePasteBoard(), false);
  assert.ok(topN.__getCacheForTest().bySlug['wyndham-championship'].markets.outright_win.players.has('fresh player'),
    'a live board must win over a stored one');
});

test('scraped (non-manual) boards are NOT persisted — they re-warm themselves', async () => {
  reset();
  const b = board(Date.now());
  b.bySlug['wyndham-championship'].manual = false;
  topN.__setCacheForTest(b);
  assert.equal(await topN.persistPasteBoard(), false);
  assert.equal(_kv['golf_topn_paste_board'], undefined);
});

test('nothing to persist returns false rather than writing an empty board', async () => {
  reset();
  assert.equal(await topN.persistPasteBoard(), false);
  assert.equal(await topN.restorePasteBoard(), false, 'restoring nothing is a no-op');
});

test('out-of-range stored probabilities are dropped on restore', async () => {
  reset();
  const at = Date.now() - 60000;
  topN.__setCacheForTest(board(at));
  await topN.persistPasteBoard();
  // corrupt the stored payload the way bad data would look
  _kv['golf_topn_paste_board'].bySlug['wyndham-championship'].markets.outright_win.players = {
    'good player': 0.25, 'bad zero': 0, 'bad one': 1, 'bad neg': -0.1, 'bad nan': 'x',
  };
  topN.__setCacheForTest({ at: 0, bySlug: {} });
  assert.equal(await topN.restorePasteBoard(), true);
  const p = topN.__getCacheForTest().bySlug['wyndham-championship'].markets.outright_win.players;
  assert.equal(p.size, 1, 'only the valid probability survives');
  assert.equal(p.get('good player'), 0.25);
});
