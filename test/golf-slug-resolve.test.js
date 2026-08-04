// DK tournament-slug resolution.
//
// resolveDkSlug was MAP-ONLY, and DEFAULT_SLUG_MAP holds 9 majors/flagships and
// nothing else. So every ordinary PGA event ("Wyndham Championship", "RBC
// Canadian Open", "Truist Championship") resolved to null and could never
// register a top-N line — silently capping outright coverage to majors, against
// the directive to quote outrights for ALL tournaments.
//
// The map still wins, because slugify genuinely does NOT work for majors:
// "The Open" -> the-open-championship, not "the-open".
//
// Run: npm test   (or: node --test test/golf-slug-resolve.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const topN = require('../services/golf-topn');

// resolveDkSlug is internal; exercise it through ingestPaste, which throws with
// a distinctive message when the slug cannot be resolved.
const PASTE = ['Cameron Young', '+810', '+186', '+100'].join('\n');
function slugFor(name) {
  try { return topN.ingestPaste(PASTE, name).slug; }
  catch (e) { return 'ERROR: ' + e.message; }
}

test('ordinary PGA events now resolve by slugify', () => {
  assert.equal(slugFor('Wyndham Championship'), 'wyndham-championship');
  assert.equal(slugFor('RBC Canadian Open'), 'rbc-canadian-open');
  assert.equal(slugFor('Truist Championship'), 'truist-championship');
});

test('the leading year is stripped (PX names carry it)', () => {
  assert.equal(slugFor('2026 Wyndham Championship'), 'wyndham-championship');
  assert.equal(slugFor('2026 RBC Canadian Open'), 'rbc-canadian-open');
});

test('MAJORS still take the map, because slugify is wrong for them', () => {
  // "the-open" would 404 on DK; the real slug is the-open-championship.
  assert.equal(slugFor('The Open'), 'the-open-championship');
  assert.equal(slugFor('2026 The Open'), 'the-open-championship');
  assert.equal(slugFor('British Open'), 'the-open-championship');
  assert.equal(slugFor('The Masters'), 'the-masters');
  assert.equal(slugFor('PGA Championship'), 'pga-championship');
});

test('punctuation is normalised away', () => {
  assert.equal(slugFor("Arnold Palmer Invitational"), 'arnold-palmer-invitational');
  assert.equal(slugFor('The Genesis Invitational'), 'the-genesis-invitational');
});

test('junk input still fails closed rather than inventing a slug', () => {
  for (const bad of ['', '   ', '2026', '!!', 'a']) {
    const r = slugFor(bad);
    assert.ok(String(r).startsWith('ERROR'), JSON.stringify(bad) + ' must not resolve, got ' + r);
  }
});

test('a resolved slug is STABLE — ingest and lookup must agree', () => {
  // The paste path uses the slug purely as a cache key, so ingest and lookup
  // deriving it differently would silently orphan the board.
  const s1 = slugFor('2026 Wyndham Championship');
  const s2 = slugFor('Wyndham Championship');
  assert.equal(s1, s2, 'year prefix must not change the key');
  const hit = topN.getTopNFairProbSync('Cameron Young', 'outright_win', 'Wyndham Championship');
  assert.ok(hit && hit.fairProb > 0, 'lookup must find the board ingested under the same name');
  const hit2 = topN.getTopNFairProbSync('Cameron Young', 'outright_win', '2026 Wyndham Championship');
  assert.ok(hit2 && Math.abs(hit2.fairProb - hit.fairProb) < 1e-12,
    'the year-prefixed PX name must reach the same board');
});

test('the mirrored fair is DK raw implied, not a de-vigged number', () => {
  slugFor('Wyndham Championship');
  const hit = topN.getTopNFairProbSync('Cameron Young', 'outright_win', 'Wyndham Championship');
  // +810 -> 100/(810+100) = 0.10989...
  assert.ok(Math.abs(hit.fairProb - (100 / 910)) < 1e-9,
    'must be the raw DK implied — the mirror basis, not a normalised field');
});
