// FIRST-TD CLOSED-FIELD NORMALISATION (2026-09-10).
//
// First TD scorer is a CLOSED field: exactly one of the ~33 outcomes (every
// player plus "No Touchdown") occurs, so each book's sum of YES implied probs
// IS its overround — measured 1.36 on 49ers@Rams. The one-sided prop path used
// to back out an assumed 8% per outcome, leaving every first-TD fair ~25% too
// high (the quote is a raw book-mirror, so this is the FAIR driving EV and
// risk, not the price). The field is now power-normalised to 1.0 per book, the
// golf outright-win method, and the player's normalised prob averaged across
// books whose field is complete.
//
// Run: node --test test/first-td-field-normalization.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const of = require('../services/odds-feed');
const { powerNormalize } = require('../services/futures-outrights');
const { config } = require('../config');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'odds-feed.js'), 'utf8');

const F = of._closedFieldNormalizedFair;

// A synthetic first-TD board shaped like 49ers@Rams at DraftKings: 32 players
// plus "No Touchdown", summing to 1.36. McCaffrey at +500 (0.1667 raw).
function board(sum = 1.36) {
  const raw = [0.1667, 0.1667, 0.1111, 0.1000, 0.0909, 0.0769, 0.0769, 0.0667, 0.0588, 0.0500,
    0.0476, 0.0435, 0.0400, 0.0385, 0.0357, 0.0333, 0.0303, 0.0286, 0.0270, 0.0250,
    0.0233, 0.0217, 0.0200, 0.0182, 0.0164, 0.0149, 0.0133, 0.0118, 0.0100, 0.0091,
    0.0083, 0.0071, 0.0066];
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map(p => p * sum / s);              // rescale to the requested overround
}

test('a complete 1.36-sum field normalises to 1.0 and pulls the favourite well below raw/1.08', () => {
  const field = board(1.36);
  const raw = field[0];                            // the favourite's own price
  const r = F({ draftkings: field }, { draftkings: raw });
  assert.ok(r, 'a complete field must normalise');
  assert.strictEqual(r.books, 1);
  assert.ok(Math.abs(r.avgFieldSum - 1.36) < 1e-6);
  // Σ p^k = 1 by construction
  const k = powerNormalize(field, 1.0);
  const sumNorm = field.reduce((a, p) => a + Math.pow(p, k), 0);
  assert.ok(Math.abs(sumNorm - 1) < 1e-6, 'the normalised field sums to 1');
  assert.ok(Math.abs(r.fair - Math.pow(raw, k)) < 1e-12, 'the player fair is exactly the power-normalised price');
  const assumed = raw / 1.08;
  assert.ok(r.fair < assumed, `normalised ${r.fair.toFixed(4)} must be below the assumed-8% ${assumed.toFixed(4)}`);
  // a 36% overround field: the favourite lands roughly 20-30% below raw
  assert.ok(r.fair > raw * 0.62 && r.fair < raw * 0.85, `favourite fair ${r.fair.toFixed(4)} vs raw ${raw.toFixed(4)}`);
});

test('books are averaged; a book whose field is incomplete or off-band is skipped, not averaged in', () => {
  const full = board(1.36), rich = board(1.50);
  const raw = full[0], rawRich = rich[0];
  const r = F(
    { dk: full, fd: rich, thin: full.slice(0, 6), broken: full.map(p => p * 3) },
    { dk: raw, fd: rawRich, thin: raw, broken: raw * 3 },
  );
  assert.strictEqual(r.books, 2, 'dk + fd qualify; thin (6 outcomes) and broken (sum 4.08) do not');
  assert.ok(Math.abs(r.avgFieldSum - 1.43) < 1e-6);
});

test('a book where the player price is not part of the field is skipped', () => {
  const field = board(1.36);
  const r = F({ dk: field }, { dk: 0.4321 });
  assert.strictEqual(r, null, 'normalising a price against a field it is not in would be nonsense');
});

test('no qualifying book → null, so the caller falls back to the assumed-overround path', () => {
  assert.strictEqual(F({}, { dk: 0.2 }), null);
  assert.strictEqual(F(null, { dk: 0.2 }), null);
  assert.strictEqual(F({ dk: board(1.36) }, {}), null);
  assert.strictEqual(F({ dk: board(1.02) }, { dk: board(1.02)[0] }), null, 'sum 1.02 is below the 1.05 floor — not a real overround');
});

test('config: first TD is the only closed-field market by default; anytime TD is NOT', () => {
  assert.deepStrictEqual(config.pricing.closedFieldOneSidedMarkets, ['player_1st_td']);
  assert.ok(!config.pricing.closedFieldOneSidedMarkets.includes('player_anytime_td'),
    'anytime TD is an OPEN field (several players score) and must keep the per-outcome overround');
});

test('the one-sided path consults the closed set and reports what it did', () => {
  const at = SRC.indexOf('async function lookupTheOddsApiPlayerPropOneSided(');
  const body = SRC.slice(at, at + 6000);
  assert.ok(/closedSet\.has\(marketKey\) && std\.fieldYesByBook/.test(body), 'normalises only closed markets that carry a field');
  assert.ok(/oneSidedFieldNormalized: !!cf/.test(body), 'the result says whether normalisation applied');
  assert.ok(/oneSidedAssumedVig: cf \? null : assumedVig/.test(body), 'assumed vig is reported only when it was used');
  // the field is collected for lineless markets only, before the player filter
  assert.ok(/const fieldYesByBook = line == null \? \{\} : null;/.test(SRC));
  assert.ok(/if \(!\/\^\(yes\|over\)\$\/i\.test\(String\(o\.name \|\| ''\)\)\) continue;/.test(SRC), 'only YES/Over outcomes enter the field');
});
