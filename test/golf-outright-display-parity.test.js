// The Lines table must agree with the pricer on golf outrights.
//
// /lines/detail carried `if (!hit && !/^outright_top_/...)` — a guard that
// blocked the DataGolf fallback for top-N ONLY in the display. It dated from
// 2026-07-18 when DataGolf was dropped as a top-N source over the
// dead-heat-vs-ties basis gap; DataGolf was RESTORED as PRIORITY 2 on 07-30
// with the measured ties uplift, and this display was never updated.
//
// Observed live 2026-08-29: all 58 Top 5 / Top 10 rows showed "-" while only
// Tournament Winner appeared to price — even though pricer.js golfOutrightFair
// has no such restriction and those legs were quotable on real RFQs. A display
// that disagrees with the pricer sends you hunting a bug that does not exist.
//
// Run: npm test  (or: node --test test/golf-outright-display-parity.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const pricerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'pricer.js'), 'utf8');

function outrightBlock(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i > -1, `could not locate ${marker}`);
  return src.slice(i, i + 1600);
}

test('the display no longer blocks the DataGolf fallback for top-N', () => {
  const block = outrightBlock(indexSrc, "info.sport === 'golf_outrights'");
  assert.ok(
    !/!\/\^outright_top_\/\.test/.test(block),
    'the outright_top_ guard must be gone — it made Top 5/Top 10 unshowable',
  );
});

test('the pricer has no such restriction (the parity being restored)', () => {
  const block = outrightBlock(pricerSrc, 'function golfOutrightFair');
  assert.ok(!/outright_top_/.test(block), 'pricer must price every outright market type');
  assert.ok(/getOutrightFairProbSync/.test(block), 'pricer falls through to DataGolf');
});

test('both sides consult topN first, then DataGolf — same precedence', () => {
  for (const [label, block] of [
    ['display', outrightBlock(indexSrc, "info.sport === 'golf_outrights'")],
    ['pricer', outrightBlock(pricerSrc, 'function golfOutrightFair')],
  ]) {
    const topNAt = block.indexOf('getTopNFairProbSync');
    const dgAt = block.indexOf('getOutrightFairProbSync');
    assert.ok(topNAt > -1 && dgAt > -1, `${label} must consult both sources`);
    assert.ok(topNAt < dgAt, `${label}: topN (the operator paste) must be tried BEFORE DataGolf`);
  }
});
