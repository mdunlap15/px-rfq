// Quote-fisher detection — classification from the REQUEST STREAM only.
//
// WHY THIS MUST NOT LOOK AT FILLS. A 2026-08-03 audit found 79.7% of a 30-day
// quote sample (114,308 of 143,388) came from two days and four zero-fill
// creators — creator 06294316 alone fired 116,176 RFQs for ZERO fills — and
// their share was collinear with the price axis (7% of the cheapest band, 97%
// of the most expensive). That manufactured a "5x fill-rate cliff" which
// vanished on removal.
//
// The obvious fix — exclude "creators with zero fills" — is ENDOGENOUS: it
// conditions on the dependent variable, so any elasticity measured afterwards
// is circular. Hence classification here uses only rate and grid re-fire,
// both properties of the inbound stream, observable at quote time.
//
// Run: npm test   (or: node --test test/creator-activity.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const { config } = require('../config');
const ca = require('../services/creator-activity');

const HOUR = 3600000;
function fire(cid, n, opts = {}) {
  ca.__resetForTest();
  const t0 = opts.t0 || Date.now();
  const spread = opts.spreadMs != null ? opts.spreadMs : HOUR;   // spread over an hour
  let last = null;
  for (let i = 0; i < n; i++) {
    const sig = opts.sameSig ? 'SIG' : 'sig' + i;
    last = ca.recordRfq(cid, sig, t0 + Math.floor(i * spread / Math.max(1, n)));
  }
  return last;
}

test('a normal-volume counterparty is NOT flagged', () => {
  const r = fire('human-1', 20);          // 20 RFQs/hour
  assert.equal(r.fisher, false);
  assert.ok(r.rfqPerHour < config.pricing.fisherRfqPerHour);
});

test('a high-rate creator IS flagged, by rate', () => {
  const r = fire('bot-1', 1200);          // 1200 RFQs/hour vs 400 threshold
  assert.equal(r.fisher, true);
  assert.equal(r.reason, 'rate');
});

test('the real fisher profile (~2,890 RFQs/h) is flagged', () => {
  const r = fire('06294316', 2890);
  assert.equal(r.fisher, true);
  assert.ok(r.rfqPerHour >= 2000);
});

test('grid re-fire is caught even below the rate threshold', () => {
  // Same leg signature re-requested repeatedly — the documented fisher pattern
  // (grids re-fired every ~5 min) — at a rate under the outright cap.
  const r = fire('bot-2', 150, { sameSig: true });
  assert.equal(r.refires, 150);
  assert.equal(r.fisher, true);
  assert.equal(r.reason, 'grid-refire');
});

test('a few repeats at LOW volume are not enough to flag', () => {
  const r = fire('human-2', 5, { sameSig: true });
  assert.equal(r.fisher, false, 'a human re-requesting a ticket must not be branded');
});

test('classification never consults fills — no fill data is even accepted', () => {
  // The API surface takes (creatorId, legSig, now) only. If a future change
  // introduced a fills argument this test should be revisited deliberately.
  assert.equal(ca.recordRfq.length, 3);
  assert.equal(ca.classify.length, 2);
});

test('events outside the window age out', () => {
  ca.__resetForTest();
  const t0 = Date.now();
  const windowMs = config.pricing.fisherWindowMinutes * 60000;
  for (let i = 0; i < 1000; i++) ca.recordRfq('bot-3', 'sig' + i, t0);
  assert.equal(ca.classify('bot-3', t0).fisher, true);
  // Two windows later, with nothing new, the burst has aged out entirely.
  const later = t0 + windowMs * 2;
  const c = ca.classify('bot-3', later);
  assert.equal(c.rfqCount, 0);
  assert.equal(c.fisher, false);
});

test('unknown / null creator is never flagged', () => {
  ca.__resetForTest();
  assert.equal(ca.recordRfq(null, 'sig').fisher, false);
  assert.equal(ca.isFisher(null), false);
  assert.equal(ca.isFisher(undefined), false);
});

test('detection can be disabled without losing the rate measurement', () => {
  const prev = config.pricing.fisherDetectionEnabled;
  config.pricing.fisherDetectionEnabled = false;
  try {
    const r = fire('bot-4', 5000);
    assert.equal(r.fisher, false, 'flag suppressed');
    assert.equal(r.reason, 'disabled');
    assert.ok(r.rfqPerHour > 1000, 'but the rate is still measured');
  } finally {
    config.pricing.fisherDetectionEnabled = prev;
  }
});

test('thresholds are live-tunable (Runtime Tuning writes config.pricing)', () => {
  const prev = config.pricing.fisherRfqPerHour;
  try {
    config.pricing.fisherRfqPerHour = 100000;
    assert.equal(fire('bot-5', 2890).fisher, false, 'raised threshold un-flags');
    config.pricing.fisherRfqPerHour = 50;
    assert.equal(fire('bot-6', 200).fisher, true, 'lowered threshold flags');
  } finally {
    config.pricing.fisherRfqPerHour = prev;
  }
});

test('stats() reports the fisher share of request volume', () => {
  ca.__resetForTest();
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) ca.recordRfq('spammer', 'sig' + i, t0);
  for (let i = 0; i < 10; i++) ca.recordRfq('human', 'h' + i, t0);
  const s = ca.stats();
  assert.equal(s.fisherCount, 1);
  assert.ok(s.fisherRfqShare > 99, 'share should be ~99.5%, got ' + s.fisherRfqShare);
  assert.equal(s.top[0].creatorId, 'spammer');
  assert.ok(s.thresholds.rfqPerHour > 0);
});

test('tracking is bounded — a flood of distinct creators cannot grow forever', () => {
  ca.__resetForTest();
  const t0 = Date.now();
  for (let i = 0; i < 6000; i++) ca.recordRfq('c' + i, 'sig', t0 + i);
  assert.ok(ca.stats(1).trackedCreators <= 5000, 'must evict beyond the cap');
});
