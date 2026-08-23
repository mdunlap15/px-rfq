// F5 markets must not be priced off a single book.
//
// Measured 2026-05-19..08-23: first_5_innings_moneyline came in -$12,584 against
// +$1,255 expected (z -2.82) and first_5_innings_total -$6,450 against +$499
// (z -2.19) — -$20,788 between them, second only to strikeouts.
//
// Cause, probed live on TOA 2026-08-23: the supplement hard-requested exactly
// three books, and PINNACLE DOES NOT QUOTE F5 MONEYLINE AT ALL (0/5 events),
// so that market was FanDuel plus an occasional DraftKings. TOA actually
// carries 13 books on F5 h2h. On our own quoted legs, 0% ever carried all three
// named books and the F5 run line carried exactly one 74% of the time.

const test = require('node:test');
const assert = require('node:assert');

// The module reads F5_BOOKMAKERS / F5_MIN_BOOKS at load, so each case needs a
// fresh require under its own env.
function freshModule(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const m = require('../services/odds-feed');
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return m;
}

test('the default floor is 2 books, and 0 disables it', () => {
  // parseInt('0') is 0, which is falsy — a `|| 2` default would silently turn
  // the OFF switch back on. The explicit Number.isFinite check prevents that.
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '' }).__debugF5Config().minBooks, 2);
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '0' }).__debugF5Config().minBooks, 0);
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '3' }).__debugF5Config().minBooks, 3);
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: 'garbage' }).__debugF5Config().minBooks, 2);
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '-1' }).__debugF5Config().minBooks, 2);
});

test('no bookmakers filter by default, so every book in the region is used', () => {
  // The old hard-coded list was the whole problem — it asked for three books,
  // one of which does not quote the market.
  assert.strictEqual(freshModule({ F5_BOOKMAKERS: '' }).__debugF5Config().bookmakers, '');
  assert.strictEqual(
    freshModule({ F5_BOOKMAKERS: 'pinnacle,fanduel' }).__debugF5Config().bookmakers,
    'pinnacle,fanduel');
});

test('the request URL omits the bookmakers param when unset', () => {
  const m = freshModule({ F5_BOOKMAKERS: '' });
  const url = m.__debugF5Url('evt123', 'KEY');
  assert.ok(!/bookmakers=/.test(url), 'must not send an empty bookmakers filter');
  assert.ok(/markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings/.test(url));
  assert.ok(/regions=us,eu/.test(url));
});

test('the request URL includes an explicit list when set', () => {
  const m = freshModule({ F5_BOOKMAKERS: 'pinnacle,betmgm' });
  assert.ok(/bookmakers=pinnacle,betmgm/.test(m.__debugF5Url('evt123', 'KEY')));
});

test('a one-book market is rejected at the default floor', () => {
  const m = freshModule({ F5_MIN_BOOKS: '2' });
  assert.strictEqual(m.__debugF5Accepts(1), false, 'one book is not a consensus');
  assert.strictEqual(m.__debugF5Accepts(2), true);
  assert.strictEqual(m.__debugF5Accepts(5), true);
  assert.strictEqual(m.__debugF5Accepts(0), false);
});

test('the floor can be turned off to restore the old behaviour', () => {
  const m = freshModule({ F5_MIN_BOOKS: '0' });
  assert.strictEqual(m.__debugF5Accepts(1), true);
});

test('the DK single-book fallback is skipped whenever the floor exceeds one', () => {
  // Otherwise the floor is cosmetic: every event the floor rejects falls
  // through to a scrape that sets books:1 and gets priced off one book anyway.
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '2' }).__debugF5DkFallbackAllowed(), false);
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '3' }).__debugF5DkFallbackAllowed(), false);
  // F5_MIN_BOOKS=1 restores the original "100% coverage" directive.
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '1' }).__debugF5DkFallbackAllowed(), true);
  assert.strictEqual(freshModule({ F5_MIN_BOOKS: '0' }).__debugF5DkFallbackAllowed(), true);
});
