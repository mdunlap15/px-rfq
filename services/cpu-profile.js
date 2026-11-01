'use strict';
// In-process CPU sampling profiler (2026-11-01). px-rfq saturates its event
// loop at big kickoffs (LoopLag p50 300-475ms, single 57s stall) and every
// Order Book placement queues behind it. This samples the V8 profiler for N
// seconds and reduces the profile to the top functions by self and inclusive
// time, so the hot paths can be found in production rather than guessed.
//
// - capture(sec): one profile at a time; returns the summary.
// - maybeAuto(loopLag): called from the LoopLag interval; when p99 is at or
//   above CPU_AUTOPROFILE_P99_MS (default 400) and no auto profile ran in the
//   last CPU_AUTOPROFILE_GAP_MIN (default 15), captures CPU_AUTOPROFILE_SEC
//   (default 30) and logs the top lines. CPU_AUTOPROFILE=0 turns it off.
// - recent(): the last few summaries, newest first.
//
// Overhead: the sampling profiler at 1ms intervals costs a few percent of CPU
// while it runs, and nothing when idle.

const inspector = require('inspector');
const log = require('./logger');

const _recent = [];
let _busy = false;
let _lastAuto = 0;

function _envNum(k, d) { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; }

function _short(url) {
  if (!url) return '';
  const i = url.lastIndexOf('/px-rfq/'); // local paths
  let u = i >= 0 ? url.slice(i + 8) : url;
  u = u.replace(/^file:\/\//, '').replace(/^\/app\//, '');
  return u;
}

function summarize(profile, top = 40) {
  const nodes = new Map();
  for (const n of profile.nodes || []) nodes.set(n.id, n);
  const parent = new Map();
  for (const n of nodes.values()) for (const c of (n.children || [])) parent.set(c, n.id);
  const selfUs = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  let totalUs = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, deltas[i] || 0);
    totalUs += d;
    selfUs.set(samples[i], (selfUs.get(samples[i]) || 0) + d);
  }
  const keyOf = (n) => {
    const cf = n.callFrame || {};
    const fn = cf.functionName || '(anonymous)';
    const u = _short(cf.url);
    return u ? `${fn} ${u}:${(cf.lineNumber || 0) + 1}` : fn;
  };
  const selfBy = new Map();
  const inclBy = new Map();
  const fileBy = new Map();
  for (const [id, us] of selfUs) {
    const n = nodes.get(id);
    if (!n) continue;
    const k = keyOf(n);
    selfBy.set(k, (selfBy.get(k) || 0) + us);
    const f = _short((n.callFrame || {}).url) || (n.callFrame || {}).functionName || '?';
    fileBy.set(f, (fileBy.get(f) || 0) + us);
    // inclusive: credit each distinct function on the stack once
    const seen = new Set();
    let cur = id;
    while (cur != null) {
      const cn = nodes.get(cur);
      if (!cn) break;
      const ck = keyOf(cn);
      if (!seen.has(ck)) { seen.add(ck); inclBy.set(ck, (inclBy.get(ck) || 0) + us); }
      cur = parent.get(cur);
    }
  }
  const pct = (us) => totalUs ? Math.round(1000 * us / totalUs) / 10 : 0;
  const rank = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, us]) => ({ fn: k, ms: Math.round(us / 1000), pct: pct(us) }));
  const idleUs = selfBy.get('(idle)') || 0;
  return {
    wallMs: Math.round(totalUs / 1000),
    busyPct: Math.round(1000 * (totalUs - idleUs) / (totalUs || 1)) / 10,
    gcPct: pct(selfBy.get('(garbage collector)') || 0),
    topSelf: rank(selfBy, top),
    topInclusive: rank(inclBy, top),
    topFiles: rank(fileBy, 20),
  };
}

function _post(session, method, params) {
  return new Promise((resolve, reject) => session.post(method, params || {}, (err, res) => err ? reject(err) : resolve(res)));
}

async function capture(sec = 20, reason = 'manual') {
  if (_busy) throw new Error('a profile is already running');
  _busy = true;
  const session = new inspector.Session();
  const startedAt = new Date().toISOString();
  try {
    session.connect();
    await _post(session, 'Profiler.enable');
    await _post(session, 'Profiler.setSamplingInterval', { interval: 1000 });
    await _post(session, 'Profiler.start');
    await new Promise(r => setTimeout(r, Math.min(120, Math.max(2, sec)) * 1000));
    const { profile } = await _post(session, 'Profiler.stop');
    const s = { startedAt, sec, reason, ...summarize(profile) };
    _recent.unshift(s);
    if (_recent.length > 6) _recent.length = 6;
    return s;
  } finally {
    try { session.disconnect(); } catch (_) { /* ignore */ }
    _busy = false;
  }
}

function logSummary(s, n = 15) {
  log.info('CpuProfile', `${s.reason} ${s.sec}s from ${s.startedAt}: busy ${s.busyPct}% gc ${s.gcPct}% (wall ${s.wallMs}ms)`);
  for (const r of s.topSelf.slice(0, n)) log.info('CpuProfile', `self ${r.pct}% ${r.ms}ms ${r.fn}`);
  for (const r of s.topInclusive.slice(0, n)) log.info('CpuProfile', `incl ${r.pct}% ${r.ms}ms ${r.fn}`);
  for (const r of s.topFiles.slice(0, 10)) log.info('CpuProfile', `file ${r.pct}% ${r.ms}ms ${r.fn}`);
}

function maybeAuto(loopLag) {
  if (process.env.CPU_AUTOPROFILE === '0' || !loopLag || _busy) return false;
  const p99 = _envNum('CPU_AUTOPROFILE_P99_MS', 400);
  const gap = _envNum('CPU_AUTOPROFILE_GAP_MIN', 15) * 60 * 1000;
  if ((loopLag.p99_ms || 0) < p99 && (loopLag.p50_ms || 0) < p99 / 4) return false;
  if (Date.now() - _lastAuto < gap) return false;
  _lastAuto = Date.now();
  const sec = _envNum('CPU_AUTOPROFILE_SEC', 30);
  capture(sec, `auto (loop p50 ${loopLag.p50_ms}ms p99 ${loopLag.p99_ms}ms)`)
    .then(s => logSummary(s))
    .catch(e => log.warn('CpuProfile', 'auto profile failed: ' + e.message));
  return true;
}

function recent() { return _recent.slice(); }

module.exports = { capture, summarize, maybeAuto, recent, logSummary };
