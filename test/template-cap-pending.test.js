// Template cap counts CONFIRMED bets + confirms IN FLIGHT, never open quotes
// (2026-10-01). Declines read "template_cap: 4 prior bets (0 confirmed + 4
// pending)" — previews, re-sends, fishers and quotes lost to other SPs blocked
// shapes nobody had bet ($730K of network fills 9/10–9/30). The cap is now
// bounded at CONFIRM (checkConfirmCooldown), as the 9/26 team caps are.
// Run: node --test test/template-cap-pending.test.js

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const te = require('../services/template-exposure');
const { config } = require('../config');

let n = 0;
// Unique team names per test so the per-team cooldown / signature state never leak.
function legsFor() {
  n++;
  return [
    { team: `Alpha${n} Team`, market: 'moneyline', line: null },
    { team: `Beta${n} Team`, market: 'moneyline', line: null },
  ];
}
const OLD = () => Date.now() - 3600e3;   // confirmed an hour ago: outside every cooldown

test('open quotes alone never trip the cap', () => {
  const legs = legsFor();
  for (let i = 0; i < 10; i++) te.reservePending(legs, `q-${n}-${i}`, 500);
  const d = te.getRampDecision(legs, {});
  assert.strictEqual(d.decline, false, d.reason || '');
  assert.strictEqual(d.extraVig, 0, 'no ramp tier from quotes nobody has bet');
});

test('confirmed bets still trip the cap at the configured count', () => {
  const legs = legsFor();
  const at = config.pricing.templateRampDeclineAt;
  for (let i = 0; i < at; i++) te.recordConfirmation(legs, `c-${n}-${i}`, 100, OLD());
  const d = te.getRampDecision(legs, {});
  assert.strictEqual(d.decline, true);
  assert.match(d.reason, /template_cap: \d+ prior bets .*confirmed .* confirming; \d+ open quotes not counted/);
});

test('confirms in flight count toward the quote-time cap', () => {
  const legs = legsFor();
  const at = config.pricing.templateRampDeclineAt;
  for (let i = 0; i < at - 1; i++) te.recordConfirmation(legs, `c-${n}-${i}`, 100, OLD());
  te.reserveConfirmingSignature(legs, `inflight-${n}`);
  try {
    assert.strictEqual(te.getRampDecision(legs, {}).decline, true);
  } finally { te.releaseConfirmingSignature(`inflight-${n}`); }
});

test('ramp tiers follow confirmed bets, not quotes', () => {
  const legs = legsFor();
  te.recordConfirmation(legs, `c-${n}-0`, 100, OLD());
  for (let i = 0; i < 5; i++) te.reservePending(legs, `q-${n}-${i}`, 500);
  const d = te.getRampDecision(legs, {});
  assert.strictEqual(d.decline, false);
  assert.strictEqual(d.extraVig, config.pricing.templateRampTier2Add);
});

test('CONFIRM enforces the count cap even with the cooldown off', () => {
  const legs = legsFor();
  const at = config.pricing.templateRampDeclineAt;
  for (let i = 0; i < at; i++) te.recordConfirmation(legs, `c-${n}-${i}`, 100, OLD());
  const prev = config.pricing.templateRampCooldownSeconds;
  config.pricing.templateRampCooldownSeconds = 0;
  try {
    const r = te.checkConfirmCooldown(legs, `new-${n}`);
    assert.strictEqual(r.block, true);
    assert.match(r.reason, /template_cap_at_confirm/);
  } finally { config.pricing.templateRampCooldownSeconds = prev; }
});

test('CONFIRM below the cap passes; a re-run of a recorded parlay never self-blocks', () => {
  const legs = legsFor();
  const at = config.pricing.templateRampDeclineAt;
  for (let i = 0; i < at - 1; i++) te.recordConfirmation(legs, `c-${n}-${i}`, 100, OLD());
  assert.strictEqual(te.checkConfirmCooldown(legs, `new-${n}`).block, false);
  te.recordConfirmation(legs, `c-${n}-last`, 100, OLD());
  assert.strictEqual(te.checkConfirmCooldown(legs, `c-${n}-last`).block, false, 'self excluded');
});

test('the in-flight double-fill guard holds even with the cooldown off', () => {
  const legs = legsFor();
  te.recordConfirmation(legs, `c-${n}-0`, 100, OLD());
  const prev = config.pricing.templateRampCooldownSeconds;
  config.pricing.templateRampCooldownSeconds = 0;
  te.reserveConfirmingSignature(legs, `a-${n}`);
  try {
    assert.strictEqual(te.checkConfirmCooldown(legs, `b-${n}`).block, true);
  } finally {
    te.releaseConfirmingSignature(`a-${n}`);
    config.pricing.templateRampCooldownSeconds = prev;
  }
});
