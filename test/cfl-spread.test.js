// CFL spreads: PX types them 'sup_moneyline' with the handicap ONLY in the name.
//
// Verified live 2026-08-29 (Toronto @ Saskatchewan): market type='sup_moneyline',
// name "Spread", selections "SAS -4.5" / "TOR +4.5", and sel.line = 0 on BOTH.
// NFL/NCAAF use type='spread' with a real sel.line, which is why only the
// leagues PX models this way were dark — CFL had moneylines and ZERO spreads.
//
// Falling through to the generic spread path would register line 0 and, because
// `0 < 0` is false, tag BOTH sides 'underdog': a -4.5 spread priced as a
// pick'em, on the wrong side.
//
// Run: npm test  (or: node --test test/cfl-spread.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const px = require('../services/prophetx');

const spreadMkt = (sels) => ({ type: 'sup_moneyline', name: 'Spread', line: 0, selections: [sels] });

test('THE BUG: handicap is read from the NAME, not sel.line', () => {
  const out = px.parseMarketSelections(spreadMkt([
    { name: 'SAS -4.5', line: 0, odds: 100, line_id: 'a' },
    { name: 'TOR +4.5', line: 0, odds: null, line_id: 'b' },
  ]));
  assert.strictEqual(out.length, 2);
  const sas = out.find(o => o.teamName === 'SAS');
  const tor = out.find(o => o.teamName === 'TOR');
  assert.strictEqual(sas.line, -4.5, 'sel.line is 0 — the real line is in the name');
  assert.strictEqual(tor.line, 4.5);
  assert.strictEqual(sas.selection, 'favorite');
  assert.strictEqual(tor.selection, 'underdog', 'both sides must NOT be underdog');
  for (const o of out) assert.strictEqual(o.marketType, 'spread');
});

test('a one-sided price still registers the line (odds null is normal)', () => {
  // TOR came back with odds:null on the live board — an empty book side, not a
  // reason to withhold the line.
  const out = px.parseMarketSelections(spreadMkt([
    { name: 'BC -6.5', line: 0, odds: -110, line_id: 'a' },
    { name: 'OTT +6.5', line: 0, odds: null, line_id: 'b' },
  ]));
  assert.strictEqual(out.length, 2);
});

test('FAILS CLOSED: only one side parseable registers nothing', () => {
  const out = px.parseMarketSelections(spreadMkt([
    { name: 'SAS -4.5', line: 0, odds: 100, line_id: 'a' },
    { name: 'Toronto Argonauts', line: 0, odds: 100, line_id: 'b' },
  ]));
  // Falls through to the generic path rather than registering a half spread.
  assert.ok(!out.some(o => o.line === -4.5 && out.length === 1),
    'must not emit a lone side with a real handicap');
});

test('FAILS CLOSED: same-sign handicaps are refused', () => {
  const out = px.parseMarketSelections(spreadMkt([
    { name: 'SAS -4.5', line: 0, odds: 100, line_id: 'a' },
    { name: 'TOR -4.5', line: 0, odds: 100, line_id: 'b' },
  ]));
  assert.ok(!(out.length === 2 && out.every(o => o.line === -4.5)),
    'a two-favorite spread is impossible and must not register as parsed');
});

test('NO REGRESSION: a real type=spread market is untouched', () => {
  const out = px.parseMarketSelections({
    type: 'spread', name: 'Spread',
    selections: [[
      { name: 'Detroit Lions', line: -7.5, odds: -110, line_id: 'a' },
      { name: 'New Orleans Saints', line: 7.5, odds: -110, line_id: 'b' },
    ]],
  });
  const det = out.find(o => /Detroit/.test(o.teamName));
  assert.strictEqual(det.line, -7.5);
  assert.strictEqual(det.selection, 'favorite');
});

test('"BC" resolves to British Columbia Lions — it is NOT a substring of the club name', () => {
  // sas/saskatchewan, tor/toronto and ott/ottawa all fall out of the substring
  // matcher. "BC" does not, so without an override that side silently failed to
  // resolve and the spread registered ONE-SIDED.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');
  assert.match(src, /'bc':\s*'British Columbia Lions'/, 'BC override must exist');
  assert.ok(!'british columbia lions'.includes('bc'), 'proving substring matching cannot resolve it');
});
