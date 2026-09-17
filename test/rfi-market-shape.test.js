// RFI (Run First Inning) seed shape-robustness (2026-09-17).
//
// PX moved the "1st Inning Total Runs" rows under market_lines[].selections
// and dropped the top-level `selections` array. The RFI pre-seed guarded on
// `Array.isArray(rfiMarket.selections)`, which went silently false, so RFI
// registered ZERO lines from ~2026-09-10 while network demand for it grew.
// PX also now bundles a 1.5 line in the same market, so the 0.5 filter is
// load-bearing (RFI is strictly Over/Under 0.5 = "did >=1 run score in the 1st").
// The fix reads the market with px.parseMarketSelections (the prop-seed path)
// and filters to the 0.5 line.
//
// Run: node --test test/rfi-market-shape.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const px = require('../services/prophetx');

const LM_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'line-manager.js'), 'utf8');

// A "1st Inning Total Runs" market in PX's CURRENT shape: rows nested under
// market_lines[].selections (array-of-arrays), a 0.5 line AND a bundled 1.5
// line, each side repeated across order-book depth sharing one line_id.
function rfiMarketCurrentShape() {
  const depth = (name, line, lineId, odds) => odds.map(o => ({
    name, display_name: name, line, display_line: String(line),
    line_id: lineId, odds: o, outcome_id: name.startsWith('over') ? 12 : 13,
  }));
  return {
    id: 1308, name: '1st Inning Total Runs', type: 'total', status: 'open',
    market_lines: [
      { id: 1308, line: 0.5, name: 'Fixed total 0.5', favourite: true, selections: [
        depth('under 0.5', 0.5, 'under-05', [117, 115, 113]),
        depth('over 0.5', 0.5, 'over-05', [-135, -138]),
      ] },
      { id: 1309, line: 1.5, name: 'Fixed total 1.5', favourite: false, selections: [
        depth('under 1.5', 1.5, 'under-15', [-160]),
        depth('over 1.5', 1.5, 'over-15', [135]),
      ] },
    ],
  };
}

// Extract exactly the way the seed block now does.
function extractRfiSides(market) {
  let overLineId = null, underLineId = null;
  let parsed = [];
  try { parsed = px.parseMarketSelections(market) || []; } catch { parsed = []; }
  for (const sel of parsed) {
    if (!sel || !sel.lineId) continue;
    if (sel.line != null && Math.abs(sel.line - 0.5) > 0.01) continue;
    if (sel.selection === 'over' && !overLineId) overLineId = sel.lineId;
    else if (sel.selection === 'under' && !underLineId) underLineId = sel.lineId;
  }
  return { overLineId, underLineId };
}

test('parseMarketSelections yields both RFI sides at the 0.5 line from the current PX shape', () => {
  const { overLineId, underLineId } = extractRfiSides(rfiMarketCurrentShape());
  assert.strictEqual(overLineId, 'over-05');
  assert.strictEqual(underLineId, 'under-05');
});

test('the bundled 1.5 line is never mistaken for RFI', () => {
  const { overLineId, underLineId } = extractRfiSides(rfiMarketCurrentShape());
  assert.notStrictEqual(overLineId, 'over-15');
  assert.notStrictEqual(underLineId, 'under-15');
});

test('the old top-level selections guard is gone; the block parses + filters to 0.5', () => {
  // The exact bug: guarding on Array.isArray(rfiMarket.selections) silently
  // skipped the whole block once PX nested the rows.
  assert.ok(!/if \(rfiMarket && Array\.isArray\(rfiMarket\.selections\)\)/.test(LM_SRC),
    'must NOT guard on the removed top-level selections array');
  const at = LM_SRC.indexOf("const rfiMarket = markets.find(m => m && /1st");
  assert.ok(at > -1, 'RFI market find present');
  const block = LM_SRC.slice(at, at + 1400);
  assert.ok(/px\.parseMarketSelections\(rfiMarket\)/.test(block), 'reads via parseMarketSelections');
  assert.ok(/Math\.abs\(sel\.line - 0\.5\) > 0\.01/.test(block), 'filters to the 0.5 line');
});
