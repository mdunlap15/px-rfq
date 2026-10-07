const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const log = require('./logger');
const { DbCircuitBreaker, isTransientResult } = require('./db-breaker');

let supabase = null;

// ---------------------------------------------------------------------------
// CIRCUIT BREAKER + RETRY SPOOL (2026-10-03 Supabase outage)
// ---------------------------------------------------------------------------
// Every Supabase request goes through _breaker.fetch (handed to createClient as
// global.fetch below), so it gets a hard client-side timeout and fails FAST
// while the breaker is open. See services/db-breaker.js for the state machine.
//
// Writes that matter are not lost while it is open: saveOrder (confirmed /
// settled / orphaned / anything with an orderUuid), saveMatchedParlay and
// critical KV writes go to a bounded in-memory RETRY SPOOL and are replayed,
// paced, once a half-open probe succeeds. Unfilled quotes / rejects are
// spooled as DROPPABLE (evicted first when the spool is full); declines and
// SGP audits keep their own bounded batch buffers. The spool is in-memory: a
// restart while it holds rows loses them (logged at shutdown is not possible
// on Railway SIGKILL) — the PX reconcile at boot re-derives confirmed/settled
// orders from PX REST, which is the backstop for exactly that case.
function _envNum(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}
let _breaker = new DbCircuitBreaker();
function _wireBreaker(b) {
  b.onStateChange(ev => {
    if (ev.to === 'open') {
      log.error('DB', `Circuit breaker OPEN (${ev.reason}) — Supabase calls fail fast for ${ev.state.retryInSec}s; ${_spool.size} row(s) spooled`);
    } else if (ev.to === 'closed') {
      log.warn('DB', `Circuit breaker CLOSED (${ev.reason}) — draining ${_spool.size} spooled row(s) at <=${_spoolDrainPerSec()}/s`);
      _ensureDrainTimer();
    }
  });
}
let _testClient = null; // test hook: a client wired to a fake fetch (never the network)

// TEST-RUNNER KILL SWITCH.
//
// Several tests (fill-count-race, creator-blocklist, odds-tie-sign) exercise the
// REAL order-tracker rather than a stub, and order-tracker persists through
// db.saveOrder. With a populated .env that wrote straight into PRODUCTION
// Supabase: `npm test` created parlays race-1..race-4 as live 'confirmed' rows,
// which then hydrated at every boot and showed up on the dashboard as four
// $100 open positions worth $400 of phantom deployed risk. Found 2026-08-05
// after the operator asked what they were; they had been re-appearing on every
// restart because saveOrder upserts on parlay_id.
//
// Node's test runner exports NODE_TEST_CONTEXT, which catches `node --test`
// directly as well as `npm test` — the direct invocation is how these rows were
// actually created, so keying only on an npm script would not have caught it.
// NODE_ENV=test is honoured as a second signal for other runners.
//
// Returning null here routes every call down the already-supported
// "no credentials configured" path (`const db = getClient(); if (!db) return;`),
// which every function in this file already handles. Tests get a hermetic
// no-op DB instead of the production one.
// 2026-09-27: `node --test --test-isolation=none` runs every test file in the
// PARENT process, where NODE_TEST_CONTEXT is NOT set — a review run that way
// wrote 14 fake parlay_orders rows (9 'confirmed') to production. The parent's
// execArgv still carries '--test' (exact match: `node --watch` children inherit
// other '--test-*' flags, so a prefix match would disable the DB in dev). A
// plain `node test/foo.test.js` is caught by the entry-file name.
const _entry = (require.main && require.main.filename) || process.argv[1] || '';
const IS_TEST_RUN = !!process.env.NODE_TEST_CONTEXT
  || process.env.NODE_ENV === 'test'
  || process.execArgv.includes('--test')
  || /[\\/]test[\\/][^\\/]+\.test\.js$/i.test(_entry);
let _warnedTestRun = false;

function getClient() {
  if (_testClient) return _testClient;
  if (IS_TEST_RUN) {
    if (!_warnedTestRun) {
      _warnedTestRun = true;
      log.warn('DB', 'Test run detected — Supabase disabled. No reads or writes will touch the real database.');
    }
    return null;
  }
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (url && key) {
      // global.fetch = the circuit breaker: hard timeout + fail-fast when open
      // for EVERY request made through this client, including the direct
      // db.getClient() call sites in index.js / order-tracker.
      supabase = createClient(url, key, { global: { fetch: _breaker.fetch } });
      log.info('DB', 'Supabase client initialized (circuit breaker armed)');
    }
  }
  return supabase;
}

function isEnabled() {
  if (_testClient) return true;
  if (IS_TEST_RUN) return false;
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/** True when Supabase is configured AND a request issued now would reach the network. */
function isAvailable() {
  return isEnabled() && _breaker.canAttempt();
}
function getBreaker() { return _breaker; }

// --- retry spool ------------------------------------------------------------
// Map preserves insertion order -> oldest first. Keyed so the same order saved
// ten times while the DB is down occupies ONE slot (latest state wins).
const _spool = new Map();
const _spoolStats = {
  enqueued: 0, replaced: 0, drained: 0, replayRespooled: 0,
  droppedDroppable: 0, droppedCritical: 0, lastDrainAt: null,
};
let _spoolSeq = 0;
let _drainTimer = null;
let _draining = false;
function _spoolMax() { return _envNum('DB_SPOOL_MAX', 5000); }
function _spoolCriticalMax() { return _envNum('DB_SPOOL_CRITICAL_MAX', 50000); }
function _spoolDrainPerSec() { return _envNum('DB_SPOOL_DRAIN_PER_SEC', 20); }

function _spoolPut(key, kind, critical, payload, opts = {}) {
  const prev = _spool.get(key);
  if (prev) {
    // A replay that failed must never clobber a NEWER payload spooled while it
    // was in flight.
    if (opts.ifAbsent) return;
    _spool.delete(key);
    _spoolStats.replaced++;
    critical = critical || prev.critical; // never downgrade (quoted -> confirmed upgrades)
  } else {
    _spoolStats.enqueued++;
  }
  _spool.set(key, { key, kind, critical: !!critical, payload, enqueuedAt: Date.now() });
  _enforceSpoolCap();
  _ensureDrainTimer();
}

function _spoolCounts() {
  let critical = 0;
  for (const e of _spool.values()) if (e.critical) critical++;
  return { total: _spool.size, critical, droppable: _spool.size - critical };
}

function _enforceSpoolCap() {
  const max = _spoolMax();
  if (_spool.size > max) {
    // Oldest DROPPABLE rows go first; critical rows are never evicted here.
    for (const [k, e] of _spool) {
      if (_spool.size <= max) break;
      if (!e.critical) { _spool.delete(k); _spoolStats.droppedDroppable++; }
    }
  }
  const cmax = _spoolCriticalMax();
  let { critical } = _spoolCounts();
  if (critical > cmax) {
    for (const [k, e] of _spool) {
      if (critical <= cmax) break;
      if (e.critical) {
        _spool.delete(k); critical--; _spoolStats.droppedCritical++;
        log.error('DB', `RETRY SPOOL OVERFLOW: dropped critical ${e.kind} ${k} (critical cap ${cmax}) — reconcile from PX after recovery`);
      }
    }
  }
}

let _drainTimerEnabled = true; // tests drive _drainOnce() by hand
function _ensureDrainTimer() {
  if (!_drainTimerEnabled || _drainTimer || _spool.size === 0) return;
  _drainTimer = setInterval(() => { _drainOnce().catch(() => {}); }, 1000);
  if (_drainTimer.unref) _drainTimer.unref();
}
function _stopDrainTimer() {
  if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
}

async function _replay(entry) {
  const o = { fromSpool: true };
  switch (entry.kind) {
    case 'order': return (await saveOrder(entry.payload, o)) !== 'spooled';
    case 'matched': return (await _insertMatchedRow(entry.payload, o)) !== 'spooled';
    case 'kv': return (await saveKV(entry.payload.key, entry.payload.value, { ...o, critical: entry.critical })).spooled !== true;
    default: return true;
  }
}

/**
 * Replay up to `maxRows` spooled writes (default DB_SPOOL_DRAIN_PER_SEC), critical
 * first. The 1s drain timer calls this, so the rate is paced at <= maxRows/s.
 * While the breaker is open nothing is sent; when the backoff elapses the first
 * replay IS the half-open probe. Returns the number of rows replayed.
 */
async function _drainOnce(maxRows) {
  const limit = maxRows || _spoolDrainPerSec();
  if (_draining) return 0;
  if (_spool.size === 0) { _stopDrainTimer(); return 0; }
  if (!_breaker.canAttempt()) return 0;
  _draining = true;
  let n = 0;
  try {
    const batch = [];
    for (const e of _spool.values()) { if (e.critical) { batch.push(e); if (batch.length >= limit) break; } }
    if (batch.length < limit) {
      for (const e of _spool.values()) { if (!e.critical) { batch.push(e); if (batch.length >= limit) break; } }
    }
    for (const e of batch) {
      if (!_breaker.canAttempt()) break;
      if (_spool.get(e.key) !== e) continue; // replaced/evicted meanwhile
      _spool.delete(e.key);
      let done = false;
      try { done = await _replay(e); } catch (_) { done = false; }
      if (done) { n++; _spoolStats.drained++; }
      else {
        _spoolStats.replayRespooled++;
        if (!_spool.has(e.key)) _spool.set(e.key, e); // keep it (replay fns normally re-spool themselves)
        break; // the DB failed again — stop this tick, the breaker decides when to retry
      }
    }
    if (n) _spoolStats.lastDrainAt = new Date().toISOString();
  } finally {
    _draining = false;
    if (_spool.size === 0) _stopDrainTimer();
  }
  if (n) log.info('DB', `Retry spool: replayed ${n} row(s), ${_spool.size} remaining`);
  return n;
}

/**
 * Flush the retry spool before the process exits (SIGTERM on every deploy).
 *
 * The spool is in-memory, so a deploy while it held rows LOST them: on
 * 2026-10-04 the 1:09pm push dropped the fills confirmed 12:45-1:07pm (the
 * write flood had the breaker open), and with no parlay_orders row those fills
 * were invisible to P&L and exposure. Drains critical-first as fast as the DB
 * answers until empty or the deadline. Whatever critical rows are still held
 * (DB down) are written to the LOG as one `[SpoolLost]` line each — Railway
 * keeps the logs of a removed deployment, so the order is recoverable
 * (scripts/_restore_lost_orders.js) instead of gone.
 */
async function flushSpoolForShutdown(deadlineMs = 20000) {
  const t0 = Date.now();
  const before = _spoolCounts();
  let drained = 0;
  _stopDrainTimer();
  // An open breaker does NOT end the flush: the process is exiting, so the
  // backoff has no future traffic to protect. Force up to SHUTDOWN_PROBES
  // half-open probes (the first replay is the probe), spaced ~2s, inside the
  // deadline. Before 2026-10-07 the loop broke on the first canAttempt()=false
  // and a SIGTERM inside a 10-min backoff wrote nothing.
  const maxProbes = 3;
  let forced = 0;
  while (_spool.size > 0 && Date.now() - t0 < deadlineMs) {
    if (!_breaker.canAttempt()) {
      if (forced >= maxProbes) break;
      if (forced > 0) {
        const wait = Math.min(2000, deadlineMs - (Date.now() - t0));
        if (wait <= 0) break;
        await new Promise(r => setTimeout(r, wait));
      }
      forced++;
      if (typeof _breaker.expireBackoff === 'function') _breaker.expireBackoff();
      if (!_breaker.canAttempt()) break;   // half-open with a probe already in flight
    }
    if (_draining) { await new Promise(r => setTimeout(r, 50)); continue; }
    const n = await _drainOnce(50);
    drained += n;
    if (n === 0) await new Promise(r => setTimeout(r, 100));
  }
  const lost = [];
  for (const e of _spool.values()) {
    if (!e.critical) continue;
    lost.push(e);
    try {
      const p = e.payload || {};
      const rec = e.kind === 'order' ? {
        kind: 'order', parlayId: p.parlayId, status: p.status, orderUuid: p.orderUuid || null,
        offeredOdds: p.offeredOdds ?? null, fairParlayProb: p.fairParlayProb ?? null,
        vig: (p.meta && p.meta.vig) ?? p.vig ?? null, maxRisk: p.maxRisk ?? null,
        confirmedOdds: p.confirmedOdds ?? null, confirmedStake: p.confirmedStake ?? null,
        quotedAt: p.quotedAt || null, confirmedAt: p.confirmedAt || null, pnl: p.pnl ?? null,
        legs: (p.legs || (p.meta && p.meta.legs) || []).map(l => ({
          lineId: l.lineId, team: l.team, market: l.market, line: l.line, selection: l.selection,
          fairProb: l.fairProb, pinnacleOdds: l.pinnacleOdds, fanduelOdds: l.fanduelOdds,
          draftkingsOdds: l.draftkingsOdds, legVig: l.legVig, legOfferedProb: l.legOfferedProb,
        })),
      } : { kind: e.kind, key: e.key, payload: p };
      log.error('SpoolLost', JSON.stringify(rec));
    } catch (_) { log.error('SpoolLost', `${e.kind} ${e.key} (unserializable)`); }
  }
  const res = { before, drained, remaining: _spoolCounts(), lostCritical: lost.length, ms: Date.now() - t0 };
  (lost.length ? log.error : log.info)('DB', `Shutdown spool flush: drained ${drained}, ${res.remaining.total} left (${lost.length} critical logged as [SpoolLost]) in ${res.ms}ms`);
  return res;
}

// --- quote persistence sampling ----------------------------------------------
// Unfilled quotes were ~half of every parlay_orders write (recordQuote +
// updateOrderLatency = 2 upserts per quote) and almost nothing reads them
// row-by-row: every analytic that needs OUR odds on a parlay someone filled
// reads a row that is written anyway when the quote is matched / confirmed /
// rejected / settled (recordMatchedParlay saves the quote with
// meta.matchedByOtherSp / matchedTieUnclaimed). The rest is a denominator, so
// a deterministic hash SAMPLE carries it: meta.persistWeight = 1/rate and
// quoteRowWeight() lets count-style analytics reweight (Horvitz–Thompson).
// QUOTE_PERSIST_SAMPLE=1 restores persist-every-quote; 0 persists none.
const _quoteStats = { skipped: 0, sampled: 0, otherWrites: 0 };
function quotePersistSampleRate() {
  const raw = process.env.QUOTE_PERSIST_SAMPLE;
  if (raw == null || raw === '') return 0.05;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.05;
  return Math.min(1, Math.max(0, n));
}
function isQuoteSampled(parlayId, rate = quotePersistSampleRate()) {
  if (rate >= 1) return true;
  if (rate <= 0 || !parlayId) return false;
  const h = crypto.createHash('md5').update('qp:' + String(parlayId)).digest();
  return h.readUInt32BE(0) / 0x100000000 < rate;
}
/** An 'unfilled quote' write: still status 'quoted' and nothing has happened to it yet. */
function isUnfilledQuoteWrite(order) {
  if (!order || order.status !== 'quoted') return false;
  if (order.orderUuid != null || order.confirmedAt) return false;
  const m = order.meta || {};
  return !(m.matchedByOtherSp || m.matchedTieUnclaimed || m.pxMatchedAfterReject
    || m.exposureOverrideOnMatch || m.persistAlways);
}
/** Count weight of a persisted parlay_orders row (1 unless it is a sampled unfilled quote). */
function quoteRowWeight(row) {
  const w = row && row.meta && Number(row.meta.persistWeight);
  return Number.isFinite(w) && w >= 1 ? w : 1;
}
function _isCriticalOrder(order) {
  if (!order) return false;
  const st = String(order.status || '');
  return st === 'confirmed' || st.startsWith('settled_') || st === 'orphaned'
    || order.orderUuid != null || !!order.confirmedAt;
}

_wireBreaker(_breaker);

// ---------------------------------------------------------------------------
// PARLAY ORDERS
// ---------------------------------------------------------------------------

/**
 * Upsert one parlay_orders row. Returns 'saved' | 'skipped' (unsampled
 * unfilled quote) | 'spooled' (DB unavailable — queued for replay) | 'error'
 * (permanent failure, logged) | 'disabled' (no DB / blocked by a guard).
 */
// UNCHANGED-ROW SKIP (2026-10-04). 734K Supabase requests in 10.5h (~19/s,
// 363K GET + 350K POST on parlay_orders) after the breaker deploy, against
// only ~47K quotes: periodic reconcile loops (reconcileGhostConfirmed and
// friends) re-save the same confirmed/settled orders every cycle, and each
// such save does a guard READ and an upsert — saturating the Small instance
// at NFL peak (a 1-row read hit the statement timeout). A row identical to
// the last one we successfully wrote for that parlay is skipped before any
// DB call. The memo is cleared on any failure so a retry always writes.
const _lastSavedHash = new Map();            // parlayId -> sha1 of the last successfully written row
const LAST_SAVED_MAX = 50000;
const _saveStats = { unchangedSkipped: 0, written: 0 };
const _saveCallers = new Map();              // sampled call site -> count
function _noteCaller() {
  if (Math.random() > 0.02) return;          // ~2% sample keeps stack capture cheap
  const frame = String(new Error().stack || '').split('\n')[3] || '?';
  const m = frame.match(/at (?:async )?(\S+) .*[\\/]([^\\/]+:\d+)/);
  const k = m ? `${m[1]} ${m[2]}` : frame.trim().slice(0, 80);
  _saveCallers.set(k, (_saveCallers.get(k) || 0) + 1);
}
function getSaveOrderStats() {
  return Object.assign({}, _saveStats, { memo: _lastSavedHash.size,
    topCallersSampled2pct: [..._saveCallers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) });
}

async function saveOrder(order, opts = {}) {
  const db = getClient();
  if (!db || !order || !order.parlayId) return 'disabled';
  _noteCaller();

  // Unfilled quotes: deterministic sample only (see quotePersistSampleRate).
  let persistWeight = null;
  if (isUnfilledQuoteWrite(order)) {
    const rate = quotePersistSampleRate();
    if (!isQuoteSampled(order.parlayId, rate)) { _quoteStats.skipped++; return 'skipped'; }
    _quoteStats.sampled++;
    persistWeight = rate > 0 && rate < 1 ? Math.round((1 / rate) * 1e6) / 1e6 : null;
  } else {
    _quoteStats.otherWrites++;
  }

  const spoolKey = 'order:' + order.parlayId;
  const critical = _isCriticalOrder(order);
  const spoolIt = () => {
    // The spool holds the live order OBJECT, so a replay writes its latest state.
    _spoolPut(spoolKey, 'order', critical, order, { ifAbsent: !!opts.fromSpool });
    return 'spooled';
  };
  if (!_breaker.canAttempt()) return spoolIt();

  try {
    // Stash pxProfit, expectedValue, and CLV fields inside meta (no dedicated
    // columns — keeps schema stable while persisting these derived fields).
    const metaWithExtras = { ...(order.meta || {}) };
    if (order.pxProfit != null) metaWithExtras.pxProfit = order.pxProfit;
    if (order.expectedValue != null) metaWithExtras.expectedValue = order.expectedValue;
    if (order.closingImpliedProb != null) metaWithExtras.closingImpliedProb = order.closingImpliedProb;
    if (order.clvDelta != null) metaWithExtras.clvDelta = order.clvDelta;
    // Sample weight lives on the ROW only; a later deterministic write (match,
    // confirm, settle) carries no weight because that row is no longer sampled.
    if (persistWeight != null) metaWithExtras.persistWeight = persistWeight;
    else delete metaWithExtras.persistWeight;

    const row = {
      parlay_id: order.parlayId,
      status: order.status,
      legs: order.legs || order.meta?.legs || [],
      offered_odds: order.offeredOdds,
      fair_parlay_prob: order.fairParlayProb,
      max_risk: order.maxRisk,
      vig: order.meta?.vig || order.vig,
      confirmed_odds: order.confirmedOdds,
      confirmed_stake: order.confirmedStake,
      order_uuid: order.orderUuid,
      pnl: order.pnl,
      settlement_result: order.settlementResult,
      quoted_at: order.quotedAt,
      confirmed_at: order.confirmedAt,
      settled_at: order.settledAt,
      meta: metaWithExtras,
    };

    let rowHash = null;
    try { rowHash = crypto.createHash('sha1').update(JSON.stringify(row)).digest('base64'); } catch (_) { /* unhashable → always write */ }
    if (rowHash && _lastSavedHash.get(order.parlayId) === rowHash) {
      _saveStats.unchangedSkipped++;
      return 'unchanged';
    }

    // Guard: never let a reconstructed order overwrite a pxBackfill record.
    // The PX backfill is verified ground-truth data from the PX team's export.
    // Reconstructed orders are skeleton records from PX REST with incomplete data.
    if (metaWithExtras.reconstructed) {
      const guardRes = await db
        .from('parlay_orders')
        .select('meta')
        .eq('parlay_id', order.parlayId)
        .maybeSingle();
      // The guard read failed because the DB is unreachable: spool rather than
      // blindly upserting past a guard we could not evaluate.
      if (isTransientResult(guardRes)) return spoolIt();
      const existing = guardRes.data;
      if (existing?.meta?.pxBackfill) {
        log.debug('DB', `Blocked saveOrder for ${order.parlayId} — reconstructed cannot overwrite pxBackfill`);
        return 'disabled';
      }
    }

    // Guard: never let a periodic reconcile revert a deliberately-ORPHANED
    // row back to 'confirmed'. The pre-cutover stuck-'confirmed' backlog
    // (PX wiped it at the 2026-06-16 CFTC migration, settlement
    // unrecoverable) was orphaned to a terminal status by
    // scripts/_orphan_precutover_confirmed.js. The live tracker may still
    // hold such an order in memory as 'confirmed' (loaded before the
    // orphan) and reconcileGhostConfirmed re-saves it every cycle — block
    // that here, where the DB is the source of truth for orphan state.
    // Scoped to status==='confirmed' writes so it adds no read to the
    // settlement hot path. See memory pnl-reconciliation-phantom-rows.
    if (row.status === 'confirmed') {
      const guardRes = await db
        .from('parlay_orders')
        .select('status, meta')
        .eq('parlay_id', order.parlayId)
        .maybeSingle();
      if (isTransientResult(guardRes)) return spoolIt();
      const existing = guardRes.data;
      if (existing && (existing.status === 'orphaned' || existing.meta?.orphaned)) {
        log.debug('DB', `Blocked saveOrder for ${order.parlayId} — cannot revert orphaned row to confirmed`);
        return 'disabled';
      }
    }

    // Preserve the ORIGINAL settled_at. On restart, reconstructed orders lose
    // their in-memory settledAt, so recordSettlement re-stamps now() — which
    // made weeks-old settled parlays jump to the restart time on every reboot
    // (settled_at drifting forward each poll). A settlement time is fixed once
    // recorded (correcting the RESULT must not move the TIME), so keep the
    // earliest settled_at the DB already holds for this parlay.
    if (row.status && row.status.startsWith('settled_') && row.settled_at) {
      try {
        const { data: prev } = await db
          .from('parlay_orders')
          .select('settled_at')
          .eq('parlay_id', order.parlayId)
          .maybeSingle();
        if (prev && prev.settled_at) {
          const exMs = Date.parse(prev.settled_at);
          const newMs = Date.parse(row.settled_at);
          if (Number.isFinite(exMs) && (!Number.isFinite(newMs) || exMs < newMs)) {
            row.settled_at = prev.settled_at; // keep the original (earlier) timestamp
          }
        }
      } catch (_) { /* best-effort; fall through to the upsert */ }
    }

    const upRes = await db
      .from('parlay_orders')
      .upsert(row, { onConflict: 'parlay_id' });
    const { error } = upRes;

    if (error) _lastSavedHash.delete(order.parlayId);
    else if (rowHash) {
      if (_lastSavedHash.size >= LAST_SAVED_MAX) _lastSavedHash.delete(_lastSavedHash.keys().next().value);
      _lastSavedHash.set(order.parlayId, rowHash);
      _saveStats.written++;
    }
    if (error && isTransientResult(upRes)) {
      return spoolIt();
    } else if (error) {
      log.error('DB', `Failed to save order ${order.parlayId}: ${error.message}`);
      return 'error';
    } else if (order.status === 'confirmed') {
      // Belt-and-suspenders for the signature cooldown: EVERY code path
      // that confirms a parlay must end up calling saveOrder() to persist
      // the row. Hooking here guarantees the cooldown lock is armed
      // regardless of which upstream path (recordConfirmation, order.matched
      // side-channel, importPxBookedOrder, settlement repair, etc.) wrote
      // the status. The explicit lockSignature() calls in order-tracker.js
      // remain (faster — arm BEFORE the DB write completes) but this catch-
      // all closes any hook-coverage gaps.
      try {
        const sigCd = require('./sig-cooldown');
        sigCd.lockSignature(row.legs, order.parlayId);
      } catch (_) { /* observability path must never break DB writes */ }
    }
    return 'saved';
  } catch (err) {
    log.error('DB', `saveOrder error: ${err.message}`);
    // An unexpected throw on a critical row must not silently lose it.
    if (critical) return spoolIt();
    return 'error';
  }
}

// Outcome of the most recent loadOrders(): order-tracker reads it to tell an
// EMPTY book from a book it could not load (DB down at boot), and schedules a
// deferred merge-load in the second case instead of trading on zero exposure
// state forever.
let _lastOrdersLoad = { ok: null, at: null, rows: 0, error: null };
function getLastOrdersLoad() { return { ..._lastOrdersLoad }; }

async function loadOrders(limit = 100) {
  const db = getClient();
  if (!db) {
    log.warn('DB', 'loadOrders: no Supabase client available');
    return [];
  }
  let gaveUpPages = 0;
  let aborted = null;

  // Load only settled + confirmed orders on startup. The 50K+ "quoted" rows
  // (unfilled RFQs) don't affect P&L, exposure, or positions and cause
  // Supabase free-tier timeouts when sorting/paginating the full table.
  // New quotes from the current session are tracked in memory.
  const PAGE_SIZE = 1000;
  const MAX_PAGE_RETRIES = 4;
  const all = [];
  const startMs = Date.now();
  let pagesFetched = 0;
  // Per-status row counts so we can compare to a head count and detect
  // silent partial loads (e.g. Supabase timeouts mid-pagination).
  const perStatus = {};
  const STATUSES = ['confirmed', 'settled_won', 'settled_lost', 'settled_push', 'rejected'];
  try {
    for (const status of STATUSES) {
      if (aborted) break;
      // Get authoritative count first so we know if pagination got truncated.
      let expected = null;
      try {
        const { count, error: cErr } = await db
          .from('parlay_orders')
          .select('*', { count: 'exact', head: true })
          .eq('status', status);
        if (!cErr) expected = count;
      } catch (_) { /* count is best-effort */ }

      let offset = 0;
      let loaded = 0;
      while (offset < limit - all.length) {
        const pageSize = Math.min(PAGE_SIZE, limit - all.length - offset);

        // Retry loop: Supabase free-tier occasionally times out individual
        // page queries. Previously a single failure would `break` out of the
        // while loop and silently drop the rest of this status's rows,
        // producing a biased subset (e.g. all losses + some wins → fake
        // negative P&L on restart). Retry with exponential backoff and only
        // give up after MAX_PAGE_RETRIES.
        let data = null;
        let lastError = null;
        for (let attempt = 0; attempt < MAX_PAGE_RETRIES; attempt++) {
          const result = await db
            .from('parlay_orders')
            .select('*')
            .eq('status', status)
            .order('parlay_id', { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (!result.error) {
            data = result.data;
            lastError = null;
            break;
          }
          lastError = result.error;
          // DB unreachable (breaker open / timeouts): stop the whole load NOW.
          // Retrying every page of a 200K-row cap against a dead DB was ~200
          // pages x 4 retries x backoff per status — an hour-long boot stall.
          if (isTransientResult(result) && !_breaker.canAttempt()) { aborted = result.error.message; break; }
          log.warn('DB', `loadOrders ${status} offset ${offset} attempt ${attempt + 1}/${MAX_PAGE_RETRIES} failed: ${result.error.message}`);
          // Exponential backoff: 250ms, 500ms, 1s, 2s
          await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
        }
        if (aborted) break;
        if (lastError) {
          gaveUpPages++;
          // After exhausting retries, log loudly. Do NOT break — try the
          // next page anyway. A single bad page shouldn't poison the
          // whole status. Worst case we still log the gap below.
          log.error('DB', `loadOrders ${status} offset ${offset}: gave up after ${MAX_PAGE_RETRIES} retries (${lastError.message})`);
          offset += pageSize;
          continue;
        }
        if (!data || data.length === 0) break;
        all.push(...data);
        loaded += data.length;
        pagesFetched++;
        if (data.length < pageSize) break;
        offset += pageSize;
      }
      perStatus[status] = loaded;

      // Drift detection: if we know the expected count and loaded fewer
      // rows, that's a partial load. Log loudly so this doesn't silently
      // corrupt P&L the way it did 2026-04-15 (loaded 180/675 wins, P&L
      // showed -$8,871 instead of +$7,536).
      if (expected != null && loaded < expected) {
        log.error('DB', `loadOrders PARTIAL LOAD for ${status}: got ${loaded} rows, expected ${expected} (missing ${expected - loaded})`);
      }
    }
    if (aborted) {
      log.error('DB', `loadOrders ABORTED — database unavailable (${aborted}); ${all.length} rows loaded before abort. A deferred merge-load will retry.`);
      _lastOrdersLoad = { ok: false, at: new Date().toISOString(), rows: all.length, error: aborted };
      return all.map(_rowToOrder);
    }
    _lastOrdersLoad = { ok: gaveUpPages === 0, at: new Date().toISOString(), rows: all.length, error: gaveUpPages ? `${gaveUpPages} page(s) failed` : null };
    log.info('DB', `loadOrders: ${all.length} rows in ${pagesFetched} pages (${Date.now() - startMs}ms) — ${JSON.stringify(perStatus)}`);

    // Convert DB rows back to order format
    return all.map(_rowToOrder);
  } catch (err) {
    log.error('DB', `loadOrders error: ${err.message}`);
    _lastOrdersLoad = { ok: false, at: new Date().toISOString(), rows: 0, error: err.message };
    return [];
  }
}

// Row → order object. Shared by loadOrders and loadRecentQuotedOrders so the
// two can never drift in shape.
function _rowToOrder(row) {
  return {
    parlayId: row.parlay_id,
    status: row.status,
    legs: row.legs,
    offeredOdds: row.offered_odds,
    fairParlayProb: row.fair_parlay_prob ? Number(row.fair_parlay_prob) : null,
    maxRisk: row.max_risk ? Number(row.max_risk) : null,
    vig: row.vig ? Number(row.vig) : null,
    confirmedOdds: row.confirmed_odds ? Number(row.confirmed_odds) : null,
    confirmedStake: row.confirmed_stake ? Number(row.confirmed_stake) : null,
    orderUuid: row.order_uuid,
    pnl: row.pnl != null ? Number(row.pnl) : null,
    settlementResult: row.settlement_result,
    quotedAt: row.quoted_at,
    confirmedAt: row.confirmed_at,
    settledAt: row.settled_at,
    meta: row.meta || {},
  };
}

/**
 * Load RECENT unfilled 'quoted' orders so the dashboard's All Quotes table
 * survives a restart.
 *
 * loadOrders() deliberately excludes status='quoted': historically there were
 * 50K+ unfilled rows and paginating them timed out Supabase's free tier, so
 * unfilled quotes lived ONLY in memory for the session. Every redeploy then
 * erased the day's quote history from the UI — on 2026-07-14, 125 of the day's
 * 158 parlays were 'quoted' and vanished from the table after a restart
 * (operator report).
 *
 * The timeout risk is REAL but is a function of WINDOW, not of the status.
 * Measured 2026-07-15: 24h=126 rows, 48h=243 rows (969ms, fine), 72h=1189,
 * but a 7-DAY count still times out (returns null). So this is hard-bounded by
 * BOTH a time window and a row cap, and any failure is swallowed — a missing
 * quote history is cosmetic, and must never block boot.
 *
 * These rows are for DISPLAY. loadFromDb tags them meta.hydratedQuote so they
 * are excluded from `openQuotes` (they expired long ago) and from the
 * creator-blocklist sweep (nothing to release).
 */
async function loadRecentQuotedOrders(hours = 48, cap = 5000) {
  const db = getClient();
  if (!db) return [];
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const startMs = Date.now();
  try {
    const { data, error } = await db
      .from('parlay_orders')
      .select('*')
      .eq('status', 'quoted')
      .gte('quoted_at', sinceIso)
      .order('quoted_at', { ascending: false })
      .limit(cap);
    if (error) {
      log.warn('DB', `loadRecentQuotedOrders failed (non-fatal, quote history will start empty): ${error.message}`);
      return [];
    }
    const rows = data || [];
    if (rows.length >= cap) {
      log.warn('DB', `loadRecentQuotedOrders hit cap ${cap} over ${hours}h — older quotes in the window are omitted`);
    }
    log.info('DB', `loadRecentQuotedOrders: ${rows.length} unfilled quotes from last ${hours}h (${Date.now() - startMs}ms)`);
    return rows.map(_rowToOrder);
  } catch (err) {
    log.warn('DB', `loadRecentQuotedOrders threw (non-fatal): ${err.message}`);
    return [];
  }
}

/**
 * Load specific orders by parlay_id from Supabase.
 * Returns a map { parlayId: orderObject } for orders that exist in the DB.
 * Used by fullPxReconcile to preserve pricing data (offeredOdds, fairParlayProb,
 * etc.) that would otherwise be lost when reconstructing from PX REST.
 */
async function loadOrdersByParlayIds(parlayIds) {
  return (await loadOrdersByParlayIdsChecked(parlayIds)).rows;
}

/**
 * Same read, but also returns `checked`: the parlay ids whose chunk was READ
 * successfully. An id in `checked` with no row is a CONFIRMED absence; an id
 * outside it is unknown (DB unreachable / query failed). Callers that act on
 * "no row" (importing a PX fill the tracker never persisted) must use this —
 * a failed read must never look like an absent row, or a skeleton would be
 * saved over the real one.
 */
async function loadOrdersByParlayIdsChecked(parlayIds) {
  const client = getClient();
  const checked = new Set();
  if (!client || !parlayIds || parlayIds.length === 0) return { rows: {}, checked };

  const result = {};
  // Supabase IN filter has practical limits; chunk to 500
  const CHUNK = 500;
  try {
    for (let i = 0; i < parlayIds.length; i += CHUNK) {
      const chunk = parlayIds.slice(i, i + CHUNK);
      const { data, error } = await client
        .from('parlay_orders')
        .select('*')
        .in('parlay_id', chunk);
      if (error) {
        log.warn('DB', `loadOrdersByParlayIds chunk failed: ${error.message}`);
        continue;
      }
      for (const id of chunk) checked.add(id);
      for (const row of (data || [])) {
        result[row.parlay_id] = {
          parlayId: row.parlay_id,
          status: row.status,
          legs: row.legs,
          offeredOdds: row.offered_odds,
          fairParlayProb: row.fair_parlay_prob ? Number(row.fair_parlay_prob) : null,
          maxRisk: row.max_risk ? Number(row.max_risk) : null,
          vig: row.vig ? Number(row.vig) : null,
          confirmedOdds: row.confirmed_odds ? Number(row.confirmed_odds) : null,
          confirmedStake: row.confirmed_stake ? Number(row.confirmed_stake) : null,
          orderUuid: row.order_uuid,
          pnl: row.pnl != null ? Number(row.pnl) : null,
          settlementResult: row.settlement_result,
          quotedAt: row.quoted_at,
          confirmedAt: row.confirmed_at,
          settledAt: row.settled_at,
          meta: row.meta || {},
        };
      }
    }
  } catch (err) {
    log.warn('DB', `loadOrdersByParlayIds error: ${err.message}`);
  }
  return { rows: result, checked };
}

// ---------------------------------------------------------------------------
// MATCHED PARLAYS
// ---------------------------------------------------------------------------

// matched_odds / our_odds are INTEGER columns, but PX occasionally reports a
// computed decimal on the broadcast channel (observed 2026-08-22: -1019.82 on
// a 4-leg match). Postgres rejects the whole row with
//   invalid input syntax for type integer: "1019.82"
// and because saveMatchedParlay only logs the error, the row is dropped
// silently -- we lose that fill from market intelligence entirely.
//
// American odds are integers by convention, so rounding is the faithful
// representation, not a lossy workaround: at these magnitudes one unit is far
// below the resolution anything downstream uses. Rounding here rather than
// widening the column keeps existing rows and queries untouched.
function _intOdds(v) {
  if (v == null) return null;
  // Number('') and Number('   ') are 0, not NaN -- an empty string would be
  // written as odds of ZERO, which is worse than the crash it replaced:
  // it corrupts market intelligence silently instead of loudly. Reject any
  // value that is not a non-blank numeric.
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// matched_parlays rows are market intelligence we cannot re-derive later (PX
// does not replay order.matched), so they are CRITICAL in the retry spool.
async function saveMatchedParlay(entry) {
  const db = getClient();
  if (!db || !entry) return 'disabled';

  try {
    const row = {
      parlay_id: entry.parlayId,
      matched_odds: _intOdds(entry.matchedAmericanOdds),
      matched_stake: entry.matchedStake,
      legs: entry.legs || [],
      we_quoted: entry.weQuoted || false,
      our_odds: _intOdds(entry.ourAmericanOdds),
      outcome: entry.outcome,
      matched_at: entry.matchedAt,
    };
    return await _insertMatchedRow(row, {});
  } catch (err) {
    log.error('DB', `saveMatchedParlay error: ${err.message}`);
    return 'error';
  }
}

async function _insertMatchedRow(row, opts = {}) {
  const db = getClient();
  if (!db) return 'disabled';
  // Each matched event is its own spool slot (insert, not upsert). The key is
  // fixed per row object so a failed replay re-uses its slot.
  if (!row.__spoolKey) Object.defineProperty(row, '__spoolKey', { value: `matched:${row.parlay_id}:${++_spoolSeq}`, enumerable: false });
  const spoolIt = () => { _spoolPut(row.__spoolKey, 'matched', true, row, { ifAbsent: !!opts.fromSpool }); return 'spooled'; };
  if (!_breaker.canAttempt()) return spoolIt();
  try {
    const res = await db.from('matched_parlays').insert(row);
    if (res.error && isTransientResult(res)) return spoolIt();
    if (res.error) {
      log.error('DB', `Failed to save matched parlay: ${res.error.message}`);
      return 'error';
    }
    return 'saved';
  } catch (err) {
    log.error('DB', `saveMatchedParlay error: ${err.message}`);
    return spoolIt();
  }
}

async function loadMatchedParlays(limit = 200) {
  const db = getClient();
  if (!db) return [];
  const PAGE_SIZE = 1000;
  const all = [];
  try {
    let offset = 0;
    while (offset < limit) {
      const pageSize = Math.min(PAGE_SIZE, limit - offset);
      const { data, error } = await db
        .from('matched_parlays')
        .select('*')
        .order('matched_at', { ascending: false, nullsFirst: false })
        .order('parlay_id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) {
        log.error('DB', `Failed to load matched parlays (page at offset ${offset}): ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    return all.map(row => ({
      parlayId: row.parlay_id,
      matchedAmericanOdds: row.matched_odds,
      matchedStake: row.matched_stake ? Number(row.matched_stake) : null,
      legs: row.legs || [],
      weQuoted: row.we_quoted,
      ourAmericanOdds: row.our_odds,
      outcome: row.outcome,
      matchedAt: row.matched_at,
      legCount: (row.legs || []).length,
    }));
  } catch (err) {
    log.error('DB', `loadMatchedParlays error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// DECLINES — persistent record of every declined RFQ
// ---------------------------------------------------------------------------

async function saveDecline(entry) {
  const db = getClient();
  if (!db) return;
  try {
    const row = {
      parlay_id: entry.parlayId || null,
      reason: entry.reason || 'unknown',
      detail: entry.detail || null,
      known_legs: entry.knownLegs || [],
      unknown_line_ids: entry.unknownLineIds || [],
      unknown_details: entry.unknownDetails || [],
      // NEW: structured per-leg unknown categorization (sport, category,
      // propType, playerName, marketName, line, eventName, etc.). Was
      // built in memory at decline-time but never persisted; needed for
      // /unknown-legs-breakdown analytics. Run this SQL once before the
      // next deploy:
      //   ALTER TABLE declines ADD COLUMN unknown_categories JSONB;
      // The insert silently no-ops on rows where the column doesn't
      // exist (Supabase rejects with "column does not exist" — gated
      // behind the same warn-once guard as the original saveDecline).
      unknown_categories: entry.unknownCategories || [],
      is_limit: !!entry.isLimit,
      declined_at: entry.declinedAt || new Date().toISOString(),
    };
    // BATCHED (2026-09-25). One HTTP insert per decline was ~330 requests/min
    // into a ~140M-row table during the outage that left Supabase 522ing.
    // Rows are buffered and flushed as one multi-row insert every
    // DECLINE_FLUSH_MS (default 10s) or once DECLINE_FLUSH_MAX rows queue.
    _declineBuf.push(row);
    if (_declineBuf.length > _DECLINE_BUF_CAP) {
      // Supabase unreachable: drop the OLDEST rather than grow without bound.
      _declineDropped += _declineBuf.length - _DECLINE_BUF_CAP;
      _declineBuf.splice(0, _declineBuf.length - _DECLINE_BUF_CAP);
    }
    if (_declineBuf.length >= _DECLINE_FLUSH_MAX) flushDeclines().catch(() => {});
    else _ensureDeclineTimer();
  } catch (err) {
    _reportSaveDeclineError(err.message, '');
  }
}

const _declineBuf = [];
let _declineDropped = 0;
let _declineFlushing = false;
let _declineTimer = null;
const _DECLINE_FLUSH_MS = Number(process.env.DECLINE_FLUSH_MS) > 0 ? Number(process.env.DECLINE_FLUSH_MS) : 10000;
const _DECLINE_FLUSH_MAX = Number(process.env.DECLINE_FLUSH_MAX) > 0 ? Number(process.env.DECLINE_FLUSH_MAX) : 500;
const _DECLINE_BUF_CAP = 20000;
function _ensureDeclineTimer() {
  if (_declineTimer) return;
  _declineTimer = setTimeout(() => { _declineTimer = null; flushDeclines().catch(() => {}); }, _DECLINE_FLUSH_MS);
  if (_declineTimer.unref) _declineTimer.unref();
}
async function flushDeclines() {
  const db = getClient();
  if (!db || _declineFlushing || !_declineBuf.length) return 0;
  // Breaker open: hold the (bounded) buffer — no network — and retry on the
  // next tick. Declines are droppable: the buffer cap evicts the oldest.
  if (!_breaker.canAttempt()) { _ensureDeclineTimer(); return 0; }
  _declineFlushing = true;
  let written = 0;
  try {
    while (_declineBuf.length) {
      const batch = _declineBuf.splice(0, _DECLINE_FLUSH_MAX);
      const res = await db.from('declines').insert(batch);
      const { error } = res;
      if (error && isTransientResult(res)) {
        // DB unreachable: put the batch back (front) instead of dropping it,
        // then stop — the breaker decides when the next attempt goes out.
        _declineBuf.unshift(...batch);
        if (_declineBuf.length > _DECLINE_BUF_CAP) {
          _declineDropped += _declineBuf.length - _DECLINE_BUF_CAP;
          _declineBuf.splice(0, _declineBuf.length - _DECLINE_BUF_CAP);
        }
        _reportSaveDeclineError(error.message, '');
        break;
      }
      if (error) {
        _reportSaveDeclineError(error.message, "(run the SQL migration to create 'declines' table / add missing column)");
        _declineDropped += batch.length;   // fire-and-forget semantics, as before: never retry-storm
        break;
      }
      written += batch.length;
    }
  } catch (err) {
    _reportSaveDeclineError(err.message, '');
  } finally {
    _declineFlushing = false;
    if (_declineBuf.length) _ensureDeclineTimer();
  }
  return written;
}
function getDeclineWriteStats() {
  return { buffered: _declineBuf.length, dropped: _declineDropped, flushMs: _DECLINE_FLUSH_MS, flushMax: _DECLINE_FLUSH_MAX };
}

// Schema errors (missing table/column) are permanent for the process lifetime,
// so we warn ONCE and suppress thereafter. But a genuine transient failure
// (Supabase outage, network) must NOT be silenced forever — otherwise a real
// data-integrity hole goes invisible. Throttle non-schema errors to once/60s.
function _isSchemaError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('does not exist') || m.includes('could not find') ||
         m.includes('schema cache') || m.includes('column') || m.includes('relation');
}
function _reportSaveDeclineError(msg, hint) {
  if (_isSchemaError(msg)) {
    if (!saveDecline._schemaWarned) {
      log.error('DB', `saveDecline schema error ${hint}: ${msg}`);
      saveDecline._schemaWarned = true;
    }
    return;
  }
  const now = Date.now();
  if (!saveDecline._lastErrAt || now - saveDecline._lastErrAt > 60_000) {
    log.error('DB', `saveDecline error: ${msg}`);
    saveDecline._lastErrAt = now;
  }
}

async function loadDeclines(limit = 2000, opts = {}) {
  const db = getClient();
  if (!db) return [];
  const PAGE_SIZE = 1000;
  const all = [];
  // Optional date range filter — without this the query scans the full
  // declines table from newest first, which hits Supabase's statement
  // timeout once the table grows past ~10k rows. Callers that only need
  // recent declines (e.g. /prop-performance windowing on last N days)
  // should pass `fromIso` to bound the scan.
  const fromIso = opts.fromIso || null;
  try {
    let offset = 0;
    while (offset < limit) {
      const pageSize = Math.min(PAGE_SIZE, limit - offset);
      let query = db
        .from('declines')
        .select('*')
        .order('declined_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true });
      if (fromIso) query = query.gte('declined_at', fromIso);
      const { data, error } = await query.range(offset, offset + pageSize - 1);
      if (error) {
        log.warn('DB', `loadDeclines failed (table may not exist yet): ${error.message}`);
        return [];
      }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    return all.map(row => ({
      parlayId: row.parlay_id,
      reason: row.reason,
      detail: row.detail,
      knownLegs: row.known_legs || [],
      unknownLineIds: row.unknown_line_ids || [],
      unknownDetails: row.unknown_details || [],
      // unknown_categories may be missing on older rows (column was
      // added later) — default to empty array so consumers can iterate.
      unknownCategories: row.unknown_categories || [],
      isLimit: !!row.is_limit,
      declinedAt: row.declined_at,
    }));
  } catch (err) {
    log.error('DB', `loadDeclines error: ${err.message}`);
    return [];
  }
}

async function lookupDecline(parlayId) {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('declines')
      .select('reason, detail')
      .eq('parlay_id', parlayId)
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return { reason: data[0].reason, detail: data[0].detail };
  } catch (err) {
    return null;
  }
}

async function countOrders() {
  const db = getClient();
  if (!db) return null;
  try {
    // Total rows
    const { count: total, error: e1 } = await db
      .from('parlay_orders')
      .select('*', { count: 'exact', head: true });
    if (e1) { log.error('DB', `countOrders total failed: ${e1.message}`); return null; }
    // Settled rows
    const { count: settled, error: e2 } = await db
      .from('parlay_orders')
      .select('*', { count: 'exact', head: true })
      .like('status', 'settled_%');
    if (e2) { log.error('DB', `countOrders settled failed: ${e2.message}`); return null; }
    // Confirmed rows
    const { count: confirmed, error: e3 } = await db
      .from('parlay_orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'confirmed');
    if (e3) { log.error('DB', `countOrders confirmed failed: ${e3.message}`); return null; }
    // Breakdown by settled_won/lost/push/void
    const breakdown = {};
    for (const s of ['settled_won', 'settled_lost', 'settled_push', 'settled_void']) {
      const { count } = await db
        .from('parlay_orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', s);
      breakdown[s] = count || 0;
    }
    return { total, settled, confirmed, breakdown };
  } catch (err) {
    log.error('DB', `countOrders error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// LINE CACHE — persistent lineId → team/market mapping
// ---------------------------------------------------------------------------

/**
 * Persist the lineIndex to Supabase so historical line_ids survive restarts
 * even after PX purges events from the mm namespace (changed lines only — see
 * DIFF-ONLY below).
 *
 * @param {Object} lineIndex - { lineId: { sport, pxEventId, teamName, ... } }
 */
// DIFF-ONLY (2026-10-03). This used to upsert the WHOLE index — every line,
// in 500-row chunks — on every 2-minute seed, i.e. ~720 full-table rewrites a
// day of rows that had not changed, and it kept doing so into a dying DB.
// Now: a fingerprint per line_id (the row minus updated_at) is kept in memory
// and only NEW or CHANGED rows are upserted. A full re-save still runs every
// LINE_CACHE_FULL_RESAVE_HOURS (default 6) so updated_at stays roughly fresh
// (nothing reads it today) and a missed write self-heals. Fingerprints are
// recorded only for chunks that actually landed, so a failed chunk is retried
// on the next seed. Skipped entirely while the breaker is open.
const _lineCacheFp = new Map();
let _lineCacheLastFullAt = 0;
const _lineCacheStats = { lastAt: null, lastRows: 0, lastChanged: 0, lastFull: false, totalUpserted: 0, skippedOpen: 0, savedRequests: 0 };
function _lineCacheRow(lineId, info) {
  return {
    line_id: lineId,
    sport: info.sport || null,
    px_event_id: info.pxEventId || null,
    px_event_name: info.pxEventName || null,
    market_type: info.marketType || null,
    market_name: info.marketName || null,
    is_dnb: !!info.isDNB,
    selection: info.selection || info.oddsApiSelection || null,
    team_name: info.teamName || null,
    line: info.line != null ? info.line : null,
    home_team: info.homeTeam || null,
    away_team: info.awayTeam || null,
    odds_api_sport: info.oddsApiSport || info.sport || null,
    odds_api_market: info.oddsApiMarket || null,
    odds_api_selection: info.oddsApiSelection || null,
    competitor_id: info.competitorId || null,
    start_time: info.startTime || null,
  };
}
async function saveLineCache(lineIndex, opts = {}) {
  const db = getClient();
  if (!db) return;

  const entries = Object.entries(lineIndex || {});
  if (entries.length === 0) return;
  if (!_breaker.canAttempt()) { _lineCacheStats.skippedOpen++; return; }

  const fullEveryMs = _envNum('LINE_CACHE_FULL_RESAVE_HOURS', 6) * 3600 * 1000;
  const full = !!opts.full || (Date.now() - _lineCacheLastFullAt) >= fullEveryMs;
  const now = new Date().toISOString();
  const pending = []; // [{ row, fp }]
  const liveIds = new Set();
  for (const [lineId, info] of entries) {
    liveIds.add(lineId);
    const row = _lineCacheRow(lineId, info || {});
    const fp = JSON.stringify(row);
    if (full || _lineCacheFp.get(lineId) !== fp) pending.push({ row, fp });
  }
  // Bound the fingerprint map to the live index.
  for (const k of _lineCacheFp.keys()) if (!liveIds.has(k)) _lineCacheFp.delete(k);

  const CHUNK = 500;
  _lineCacheStats.lastAt = now;
  _lineCacheStats.lastRows = entries.length;
  _lineCacheStats.lastChanged = pending.length;
  _lineCacheStats.lastFull = full;
  _lineCacheStats.savedRequests += Math.ceil(entries.length / CHUNK) - Math.ceil(pending.length / CHUNK);
  if (pending.length === 0) return;

  let saved = 0;
  try {
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      const { error } = await db
        .from('line_cache')
        .upsert(chunk.map(p => ({ ...p.row, updated_at: now })), { onConflict: 'line_id' });
      if (error) {
        if (!saveLineCache._warned) {
          log.error('DB', `saveLineCache failed (run the SQL migration to create 'line_cache' table): ${error.message}`);
          saveLineCache._warned = true;
        }
        return;
      }
      for (const p of chunk) _lineCacheFp.set(p.row.line_id, p.fp);
      saved += chunk.length;
    }
    _lineCacheStats.totalUpserted += saved;
    if (full) _lineCacheLastFullAt = Date.now();
    log.info('DB', `saveLineCache: upserted ${saved}/${entries.length} lines (${full ? 'full re-save' : 'changed only'})`);
  } catch (err) {
    if (!saveLineCache._warned) {
      log.error('DB', `saveLineCache error: ${err.message}`);
      saveLineCache._warned = true;
    }
  }
}

/**
 * Look up a single lineId from the persistent cache.
 * Returns the same shape as lineIndex entries, or null.
 */
async function loadLineCacheEntry(lineId) {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('line_cache')
      .select('*')
      .eq('line_id', lineId)
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const row = data[0];
    return {
      sport: row.sport,
      pxEventId: row.px_event_id,
      pxEventName: row.px_event_name,
      marketType: row.market_type,
      marketName: row.market_name,
      isDNB: !!row.is_dnb,
      selection: row.selection,
      teamName: row.team_name,
      line: row.line != null ? Number(row.line) : null,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      oddsApiSport: row.odds_api_sport,
      oddsApiMarket: row.odds_api_market,
      oddsApiSelection: row.odds_api_selection,
      competitorId: row.competitor_id,
      startTime: row.start_time,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Bulk-load multiple lineIds from the persistent cache.
 * Returns a map { lineId: info }.
 */
async function loadLineCacheBulk(lineIds) {
  const db = getClient();
  if (!db) return {};
  if (!lineIds || lineIds.length === 0) return {};

  const result = {};
  const CHUNK = 200;
  try {
    for (let i = 0; i < lineIds.length; i += CHUNK) {
      const chunk = lineIds.slice(i, i + CHUNK);
      const { data, error } = await db
        .from('line_cache')
        .select('*')
        .in('line_id', chunk);
      if (error) {
        log.warn('DB', `loadLineCacheBulk failed: ${error.message}`);
        break;
      }
      for (const row of data || []) {
        result[row.line_id] = {
          sport: row.sport,
          pxEventId: row.px_event_id,
          pxEventName: row.px_event_name,
          marketType: row.market_type,
          marketName: row.market_name,
          isDNB: !!row.is_dnb,
          selection: row.selection,
          teamName: row.team_name,
          line: row.line != null ? Number(row.line) : null,
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          oddsApiSport: row.odds_api_sport,
          oddsApiMarket: row.odds_api_market,
          oddsApiSelection: row.odds_api_selection,
          competitorId: row.competitor_id,
          startTime: row.start_time,
        };
      }
    }
  } catch (err) {
    log.warn('DB', `loadLineCacheBulk error: ${err.message}`);
  }
  return result;
}

/**
 * Bulk-load ALL line_cache entries with a recent start_time. Used at
 * boot to hydrate lineIndex BEFORE seedAllLines runs, so PX RFQs that
 * arrive during the 30-90s seed window can still be priced (against
 * the hydrated marketType/selection/line metadata + the freshly-fetched
 * oddsCache for fair-prob). Without hydration, the lineIndex starts
 * empty on every Railway redeploy and ~minute of RFQs decline as
 * "unknown legs."
 *
 * Filters to start_time > now - maxAgeDays so we don't load yesterday's
 * already-played events. Default 1 day catches everything from
 * tonight's slate without dragging in stale finished games.
 *
 * Returns { lineId: info } map matching the in-memory lineIndex shape.
 */
async function loadAllRecentLineCache(maxAgeDays = 1) {
  const db = getClient();
  if (!db) return {};
  // Cutoff filters to lines whose start_time is in the future or recent
  // past. Hydrating yesterday's finished games clutters the Lines tab
  // with stale entries that never get re-registered (PX no longer
  // emits markets for settled events). Default 6 hours back catches
  // in-progress games (started up to ~6h ago, still on the books)
  // while excluding finished games. Caller can override via maxAgeDays.
  // Calling convention preserved for back-compat — maxAgeDays > 1
  // maps to extended history (rare).
  const lookbackMs = maxAgeDays >= 1 ? Math.min(maxAgeDays * 24, 6) * 3600 * 1000 : 6 * 3600 * 1000;
  const cutoff = new Date(Date.now() - lookbackMs).toISOString();
  const result = {};
  let propRowsSkipped = 0;
  try {
    // Supabase paginates at 1000 rows by default — page through with
    // range() until we get an empty page or hit a large safety cap.
    const PAGE = 1000;
    let from = 0;
    const MAX_PAGES = 20; // safety: 20 × 1000 = 20k rows
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await db
        .from('line_cache')
        .select('*')
        .gte('start_time', cutoff)
        .range(from, from + PAGE - 1);
      if (error) {
        log.warn('DB', `loadAllRecentLineCache page ${page} failed: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      for (const row of data) {
        // Skip player prop rows — line_cache doesn't store the prop
        // bridge's fair-prob fields (fairProbOver, fairProbUnder,
        // booksWithBothSides, etc.), so hydrated prop lines would
        // appear in the Lines tab with null fair-prob and decline at
        // quote time. Prop lines re-register on-demand via
        // resolveUnknownLine when PX RFQs them — no hydration needed.
        if (row.market_type && /^player_/.test(row.market_type)) {
          propRowsSkipped++;
          continue;
        }
        result[row.line_id] = {
          sport: row.sport,
          pxEventId: row.px_event_id,
          pxEventName: row.px_event_name,
          marketType: row.market_type,
          marketName: row.market_name,
          isDNB: !!row.is_dnb,
          selection: row.selection,
          teamName: row.team_name,
          line: row.line != null ? Number(row.line) : null,
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          oddsApiSport: row.odds_api_sport,
          oddsApiMarket: row.odds_api_market,
          oddsApiSelection: row.odds_api_selection,
          competitorId: row.competitor_id,
          startTime: row.start_time,
        };
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    log.info('DB', `loadAllRecentLineCache: hydrated ${Object.keys(result).length} game-line rows, skipped ${propRowsSkipped} prop rows (start_time > ${cutoff})`);
  } catch (err) {
    log.warn('DB', `loadAllRecentLineCache error: ${err.message}`);
  }
  return result;
}

/**
 * Look up line_cache entries by px_event_id. Returns one representative
 * entry per event (any line for that event — we just need homeTeam/awayTeam).
 * Returns { eventId: info }.
 */
async function loadLineCacheByEventIds(eventIds) {
  const db = getClient();
  if (!db) return {};
  if (!eventIds || eventIds.length === 0) return {};

  const result = {};
  const CHUNK = 200;
  try {
    // Convert to strings since px_event_id may be stored as text
    const ids = eventIds.map(String);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data, error } = await db
        .from('line_cache')
        .select('*')
        .in('px_event_id', chunk);
      if (error) {
        log.warn('DB', `loadLineCacheByEventIds failed: ${error.message}`);
        break;
      }
      for (const row of data || []) {
        const eid = row.px_event_id;
        // Keep first match per event (we just need home/away team)
        if (result[eid]) continue;
        result[eid] = {
          sport: row.sport,
          pxEventId: row.px_event_id,
          pxEventName: row.px_event_name,
          marketType: row.market_type,
          teamName: row.team_name,
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          startTime: row.start_time,
          oddsApiSport: row.odds_api_sport,
        };
      }
    }
  } catch (err) {
    log.warn('DB', `loadLineCacheByEventIds error: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// DAILY P&L — query settled orders grouped by settlement date
// ---------------------------------------------------------------------------

async function getDailyPnL(days = 30, opts = {}) {
  const db = getClient();
  if (!db) return [];

  // groupBy selects which column buckets a row into a day:
  //   - 'settled_at' (default): date the outcome landed — matches the
  //     prior behaviour and the settlement-centric P&L view.
  //   - 'quoted_at': date the offer was made — matches the dashboard's
  //     Daily Volume & P&L chart, which groups by quote date so the
  //     forensic "what happened on April 18" question lines up with
  //     what the operator sees.
  const groupBy = opts.groupBy === 'quoted_at' ? 'quoted_at' : 'settled_at';

  try {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    // Paginate past Supabase's default 1,000-row ceiling. At ~150 fills/day
    // of confirmed volume, ~30 days of settled rows easily exceeds that
    // limit; prior behaviour silently truncated at whichever 10-ish days
    // filled the first page.
    const PAGE_SIZE = 1000;
    const MAX_PAGE_RETRIES = 4;
    const MAX_ROWS = 50000;
    const rows = [];
    let offset = 0;
    while (rows.length < MAX_ROWS) {
      const pageSize = Math.min(PAGE_SIZE, MAX_ROWS - rows.length);
      let pageData = null;
      let lastError = null;
      for (let attempt = 0; attempt < MAX_PAGE_RETRIES; attempt++) {
        const result = await db.from('parlay_orders')
          .select('parlay_id, status, pnl, confirmed_stake, offered_odds, settled_at, quoted_at')
          .like('status', 'settled_%')
          .gte(groupBy, cutoff)
          .order(groupBy, { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (!result.error) { pageData = result.data; lastError = null; break; }
        lastError = result.error;
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
      }
      if (lastError) {
        log.warn('DB', `getDailyPnL offset ${offset}: gave up after ${MAX_PAGE_RETRIES} retries: ${lastError.message}`);
        break;
      }
      if (!pageData || pageData.length === 0) break;
      for (const row of pageData) rows.push(row);
      if (pageData.length < pageSize) break;
      offset += pageSize;
    }
    if (rows.length === 0) return [];

    // Group by ET day (YYYY-MM-DD, America/New_York) using the selected
    // column. Was server-local (= UTC on Railway), which split the
    // operator's evening into "tomorrow": an 11:02pm ET settlement is
    // 3:02am UTC next day, so rows displayed with ET times grouped under
    // a date the operator hadn't reached yet (reported 2026-06-11). The
    // dashboard's quote-side bucketing (etDayKey) was already ET —
    // settled-side now matches.
    const byDay = {};
    for (const row of rows) {
      const bucketTs = row[groupBy];
      if (!bucketTs) continue;
      const day = new Date(bucketTs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD (ET)
      if (!byDay[day]) byDay[day] = { date: day, pnl: 0, wins: 0, losses: 0, pushes: 0, risk: 0, fills: 0 };
      const d = byDay[day];
      d.pnl += (row.pnl || 0);
      d.fills++;
      if (row.status === 'settled_won') d.wins++;    // SP won (bettor lost parlay)
      else if (row.status === 'settled_lost') d.losses++;  // SP lost (bettor won parlay)
      else d.pushes++;
      d.risk += (row.confirmed_stake || 0);
    }

    return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    log.warn('DB', `getDailyPnL error: ${err.message}`);
    return [];
  }
}

/**
 * Load fully-hydrated orders for a date range. Read-only forensic
 * endpoint — pulls everything needed to decompose a single day's P&L
 * by sport, parlay structure, shared legs, counterparty, etc. Paginated
 * with retries matching loadFillBucketRowsSince's pattern so it can pull
 * days that blow past Supabase's default 1,000-row ceiling.
 *
 * groupBy: 'quoted_at' (default) or 'settled_at' — which timestamp
 * column drives the range filter.
 */
async function loadOrdersInDateRange(fromIso, toIso, opts = {}) {
  const db = getClient();
  if (!db) return [];
  const groupBy = opts.groupBy === 'settled_at' ? 'settled_at' : 'quoted_at';
  const statusFilter = opts.status; // optional — e.g. 'settled_lost'
  // Optional JSONB legs filter — server-side narrows the result to
  // parlays containing a specific market type (e.g. 'player_strikeouts'
  // for K-prop visibility). Avoids loading 25,000+ rows just to filter
  // 100 K-prop parlays client-side, which was timing out /prop-performance
  // at 60s+. Uses the PostgREST `or` filter with `cs` (contains) to
  // match either {market: X} or {marketType: X} since legs use both
  // shapes depending on the registration path.
  const legMarket = opts.legMarketEquals; // string or null
  const PAGE_SIZE = 1000;
  const MAX_PAGE_RETRIES = 4;
  const MAX_ROWS = opts.maxRows || 10000;
  const rows = [];
  let offset = 0;
  const startMs = Date.now();
  try {
    while (rows.length < MAX_ROWS) {
      const pageSize = Math.min(PAGE_SIZE, MAX_ROWS - rows.length);
      let pageData = null;
      let lastError = null;
      for (let attempt = 0; attempt < MAX_PAGE_RETRIES; attempt++) {
        let query = db.from('parlay_orders')
          .select('parlay_id, status, legs, offered_odds, confirmed_odds, confirmed_stake, max_risk, fair_parlay_prob, pnl, quoted_at, confirmed_at, settled_at, settlement_result, order_uuid, meta')
          .gte(groupBy, fromIso)
          .lte(groupBy, toIso);
        if (statusFilter) query = query.eq('status', statusFilter);
        if (legMarket) {
          query = query.or(
            `legs.cs.[{"market":"${legMarket}"}],legs.cs.[{"marketType":"${legMarket}"}]`
          );
        }
        const result = await query.order(groupBy, { ascending: true }).range(offset, offset + pageSize - 1);
        if (!result.error) { pageData = result.data; lastError = null; break; }
        lastError = result.error;
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
      }
      if (lastError) {
        log.warn('DB', `loadOrdersInDateRange offset ${offset}: gave up after ${MAX_PAGE_RETRIES} retries: ${lastError.message}`);
        break;
      }
      if (!pageData || pageData.length === 0) break;
      for (const row of pageData) rows.push(row);
      if (pageData.length < pageSize) break;
      offset += pageSize;
    }
    log.info('DB', `loadOrdersInDateRange ${fromIso}..${toIso} (${groupBy}${statusFilter ? ',' + statusFilter : ''}${legMarket ? ',leg=' + legMarket : ''}): ${rows.length} rows (${Date.now() - startMs}ms)`);
    return rows;
  } catch (err) {
    log.warn('DB', `loadOrdersInDateRange error: ${err.message}`);
    return rows;
  }
}

/**
 * Load minimal order fields needed to reconstruct fill-bucket events
 * over a historical window. Pulls every parlay_orders row with
 * quoted_at >= cutoff, so it includes 'quoted' rows (unfilled RFQs)
 * that loadOrders() intentionally skips.
 *
 * Returns rows shaped as { parlayId, quotedAt, confirmedAt, status, legs }.
 * Paginated with retries; caps at 'cap' rows to bound memory / boot time.
 */
// ---------------------------------------------------------------------------
// KEYSET PAGINATION
//
// OFFSET pagination collapses on these tables. Postgres has to walk and discard
// every row before the offset on EVERY page, so cost grows with depth. Measured
// against prod 2026-08-22 on `declines` (7-day window, 1000-row pages):
//
//     offset=0       737ms
//     offset=60000   788ms
//     offset=100000 2413ms
//     offset=140000 5801ms   <-- and climbing as the table grows
//
// That is the 689s loadDeclinesSince and the loadFillBucketRowsSince statement
// timeouts at offset 113000+. Keyset pagination reads the SAME data in flat
// ~250-540ms per page at any depth (12000 rows in 3.7s).
//
// The composite tiebreak is REQUIRED, not defensive. A cursor on the timestamp
// alone silently drops rows that share it, and ties are common here: a 3000-row
// sample of `declines` had 248 repeated timestamps, up to 5 rows deep. The
// PostgREST `or()` below expresses true (ts, id) keyset ordering, verified
// against prod to return zero overlap with the preceding page.
async function _pageKeyset(opts) {
  const {
    table, cols, tsCol, idCol, gteTs, ascending = true,
    cap = 200000, pageSize = 1000, label = table, maxRetries = 4,
    // Test seam only: production callers omit this and get the real client.
    client,
  } = opts;
  const db = client || getClient();
  if (!db) return [];
  const all = [];
  const startMs = Date.now();
  let cursor = null; // { ts, id } of the last row returned

  while (all.length < cap) {
    const want = Math.min(pageSize, cap - all.length);
    let data = null;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let q = db.from(table).select(cols).gte(tsCol, gteTs);
      if (cursor) {
        // Rows strictly beyond the cursor in the sort order, plus rows at the
        // SAME timestamp with a later id -- which is what keeps ties intact.
        const cmp = ascending ? 'gt' : 'lt';
        q = q.or(
          `${tsCol}.${cmp}."${cursor.ts}",`
          + `and(${tsCol}.eq."${cursor.ts}",${idCol}.gt."${cursor.id}")`
        );
      }
      const result = await q
        .order(tsCol, { ascending })
        .order(idCol, { ascending: true })
        .limit(want);
      if (!result.error) { data = result.data; lastError = null; break; }
      lastError = result.error;
      log.warn('DB', `${label} keyset page attempt ${attempt + 1}/${maxRetries} failed: ${result.error.message}`);
      await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
    }

    if (lastError) {
      // Partial data is still useful to callers; they log and degrade.
      log.error('DB', `${label}: gave up after ${maxRetries} retries (${all.length} rows so far)`);
      break;
    }
    if (!data || data.length === 0) break;

    all.push(...data);
    const last = data[data.length - 1];
    const nextTs = last[tsCol];
    const nextId = last[idCol];
    // Without a usable cursor we would re-request page 1 forever.
    if (nextTs == null || nextId == null) {
      log.warn('DB', `${label}: row missing ${tsCol}/${idCol}; stopping to avoid a paging loop`);
      break;
    }
    cursor = { ts: nextTs, id: nextId };
    if (data.length < want) break;
  }

  log.info('DB', `${label}: ${all.length} rows (${Date.now() - startMs}ms, keyset)`);
  if (all.length >= cap) log.warn('DB', `${label} hit cap ${cap} — history may be incomplete`);
  return all;
}
async function loadFillBucketRowsSince(cutoffIso, cap = 200000) {
  try {
    const rows = await _pageKeyset({
      table: 'parlay_orders',
      // persist_weight: sample weight of an unfilled quote (QUOTE_PERSIST_SAMPLE),
      // read as a JSON path so the (large) meta column is not pulled.
      cols: 'parlay_id, status, legs, quoted_at, confirmed_at, persist_weight:meta->persistWeight',
      tsCol: 'quoted_at',
      idCol: 'parlay_id',
      gteTs: cutoffIso,
      ascending: true,
      cap,
      label: 'loadFillBucketRowsSince',
    });
    return rows.map(row => ({
      parlayId: row.parlay_id,
      status: row.status,
      legs: row.legs || [],
      quotedAt: row.quoted_at,
      confirmedAt: row.confirmed_at,
      meta: row.persist_weight != null ? { persistWeight: Number(row.persist_weight) } : undefined,
    }));
  } catch (err) {
    log.error('DB', `loadFillBucketRowsSince error: ${err.message}`);
    return [];
  }
}

async function getTotalPnL() {
  const db = getClient();
  if (!db) return null;

  // Reuse getDailyPnL (paginated, retried, settled_at-bounded — verified at
  // scale, ~70 day rows in <3s) and sum its day buckets. The old single
  // unpaginated select silently truncated to Supabase's ~1,000-row default
  // (understating the total by ~$15K vs the true ~$22K), and at the current
  // settled-row count the unindexed `like('status','settled_%')` full scan
  // exceeds the statement timeout and returns null entirely. 400 days covers
  // all history (settlement data starts ~2026-04).
  try {
    const days = await getDailyPnL(400, { groupBy: 'settled_at' });
    if (!Array.isArray(days)) return null;
    return days.reduce((sum, d) => sum + (Number(d.pnl) || 0), 0);
  } catch (err) {
    log.warn('DB', `getTotalPnL error: ${err.message}`);
    return null;
  }
}

/**
 * Persist a web-push subscription so it survives Railway redeploys.
 * Subscriptions were previously in-memory only (services/push.js), so
 * every redeploy silently dropped every subscription and notifications
 * stopped firing until the operator re-enabled them in the browser.
 *
 * Table schema (run in Supabase SQL editor once):
 *
 *   create table if not exists push_subscriptions (
 *     endpoint text primary key,
 *     subscription jsonb not null,
 *     created_at timestamptz default now()
 *   );
 *   alter table push_subscriptions enable row level security;
 *
 * Then to add per-endpoint mute persistence (one-time, run separately so
 * existing deployments without the column degrade gracefully):
 *
 *   alter table push_subscriptions add column muted_categories jsonb;
 *
 * The save/load helpers below silently no-op on the muted_categories
 * column if it doesn't exist yet — same warn-once pattern as the
 * declines.unknown_categories migration.
 */
async function savePushSubscription(sub, mutedCategories) {
  if (!isEnabled() || !sub || !sub.endpoint) return;
  const db = getClient();
  const payload = { endpoint: sub.endpoint, subscription: sub };
  // Include muted_categories if the caller passed it (e.g. setMutedCategories
  // upserts the whole row to avoid a first-time-subscribe race where a bare
  // UPDATE would match zero rows because the insert hasn't landed yet).
  if (Array.isArray(mutedCategories)) payload.muted_categories = mutedCategories;
  try {
    let { error } = await db.from('push_subscriptions').upsert(payload, { onConflict: 'endpoint' });
    // If the migration hasn't been run yet the muted_categories column
    // won't exist — retry without it so subscription persistence still
    // works. The mute prefs just won't survive restarts until the column
    // is added (warning already logged from loadPushSubscriptions).
    if (error && /muted_categories/i.test(error.message) && 'muted_categories' in payload) {
      delete payload.muted_categories;
      ({ error } = await db.from('push_subscriptions').upsert(payload, { onConflict: 'endpoint' }));
    }
    if (error) log.warn('DB', `savePushSubscription error: ${error.message}`);
  } catch (err) {
    log.warn('DB', `savePushSubscription exception: ${err.message}`);
  }
}

async function loadPushSubscriptions() {
  if (!isEnabled()) return [];
  const db = getClient();
  try {
    // Try to read muted_categories too. If the column doesn't exist yet
    // (operator hasn't run the migration), fall back to a column-less read
    // so subscription hydration still works. Mute prefs simply stay empty
    // until the column is added + repopulated by the client's next toggle.
    let { data, error } = await db.from('push_subscriptions').select('subscription, muted_categories');
    if (error && /muted_categories/i.test(error.message)) {
      if (!loadPushSubscriptions._mutedWarned) {
        log.warn('DB', 'push_subscriptions.muted_categories column missing — run: ALTER TABLE push_subscriptions ADD COLUMN muted_categories JSONB; (mute prefs will not persist until then)');
        loadPushSubscriptions._mutedWarned = true;
      }
      ({ data, error } = await db.from('push_subscriptions').select('subscription'));
    }
    if (error) {
      log.warn('DB', `loadPushSubscriptions error: ${error.message}`);
      return [];
    }
    return (data || [])
      .map(r => ({ subscription: r.subscription, mutedCategories: Array.isArray(r.muted_categories) ? r.muted_categories : null }))
      .filter(r => r.subscription && r.subscription.endpoint);
  } catch (err) {
    log.warn('DB', `loadPushSubscriptions exception: ${err.message}`);
    return [];
  }
}

/**
 * SGP Phase-0 audit log. Inserts one row per same-game-correlation
 * decline so we can analyze the shape distribution before designing
 * Phase-1 pricing. Silent no-op if the table doesn't exist (warn-once,
 * caller is gated by SGP_SHADOW_LOGGING env anyway).
 *
 * One-time SQL migration (run in Supabase SQL editor):
 *
 *   CREATE TABLE IF NOT EXISTS sgp_audit (
 *     parlay_id TEXT PRIMARY KEY,
 *     seen_at TIMESTAMPTZ DEFAULT NOW(),
 *     decline_reason TEXT NOT NULL,
 *     px_event_id TEXT,
 *     leg_count INT,
 *     prop_count INT,
 *     other_count INT,
 *     combo_signature TEXT,
 *     legs JSONB
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_sgp_audit_seen_at ON sgp_audit (seen_at DESC);
 *   CREATE INDEX IF NOT EXISTS idx_sgp_audit_combo_signature ON sgp_audit (combo_signature);
 */
// BATCHED (2026-10-03). One HTTP upsert per same-game decline: with shadow
// logging on, that is one request for every SGP decline (~200K/day at the
// measured decline volume) — the largest single writer in the book. Rows are
// buffered by parlay_id (a re-declined RFQ replaces its row, which also keeps a
// multi-row upsert from touching one key twice) and flushed as one upsert every
// SGP_AUDIT_FLUSH_MS (default 10s) or at SGP_AUDIT_FLUSH_MAX rows. Droppable:
// bounded at SGP_AUDIT_BUF_CAP (5000, oldest dropped) and held — not sent —
// while the breaker is open.
const _sgpBuf = new Map();
const _sgpStats = { flushed: 0, dropped: 0, flushes: 0 };
let _sgpTimer = null;
let _sgpFlushing = false;
let _sgpStripHash = false;
function _sgpFlushMs() { return _envNum('SGP_AUDIT_FLUSH_MS', 10_000); }
function _sgpFlushMax() { return _envNum('SGP_AUDIT_FLUSH_MAX', 500); }
function _sgpBufCap() { return _envNum('SGP_AUDIT_BUF_CAP', 5000); }

async function saveSgpAudit(row) {
  if (!isEnabled() || !row || !row.parlay_id) return;
  if (_sgpBuf.has(row.parlay_id)) _sgpBuf.delete(row.parlay_id);
  _sgpBuf.set(row.parlay_id, row);
  const cap = _sgpBufCap();
  while (_sgpBuf.size > cap) {
    _sgpBuf.delete(_sgpBuf.keys().next().value);
    _sgpStats.dropped++;
  }
  if (_sgpBuf.size >= _sgpFlushMax()) flushSgpAudits().catch(() => {});
  else _ensureSgpTimer();
}
function _ensureSgpTimer() {
  if (_sgpTimer) return;
  _sgpTimer = setTimeout(() => { _sgpTimer = null; flushSgpAudits().catch(() => {}); }, _sgpFlushMs());
  if (_sgpTimer.unref) _sgpTimer.unref();
}
async function flushSgpAudits() {
  const db = getClient();
  if (!db || _sgpFlushing || _sgpBuf.size === 0) return 0;
  if (!_breaker.canAttempt()) { _ensureSgpTimer(); return 0; }
  _sgpFlushing = true;
  let written = 0;
  try {
    while (_sgpBuf.size) {
      const max = _sgpFlushMax();
      const batch = [];
      for (const [k, r] of _sgpBuf) { batch.push(r); _sgpBuf.delete(k); if (batch.length >= max) break; }
      const rows = _sgpStripHash ? batch.map(({ leg_hash, ...rest }) => rest) : batch;
      let res = await db.from('sgp_audit').upsert(rows, { onConflict: 'parlay_id' });
      if (res.error && isTransientResult(res)) {
        for (const r of batch) if (!_sgpBuf.has(r.parlay_id)) _sgpBuf.set(r.parlay_id, r);
        break;
      }
      if (res.error) {
        // Two possible "table missing" strings depending on client version.
        const msg = res.error.message || '';
        const missing = /sgp_audit/i.test(msg) && (/does not exist/i.test(msg) || /not find the table/i.test(msg));
        if (missing) {
          if (!saveSgpAudit._warned) {
            log.warn('DB', 'sgp_audit table missing — run the CREATE TABLE migration in db.js comments; SGP shadow logging is no-op until then');
            saveSgpAudit._warned = true;
          }
          _sgpStats.dropped += batch.length;
          continue;
        }
        // leg_hash column not yet added (scripts/sgp_stage0_ops.sql) — strip it
        // from now on and retry this batch once.
        if (/leg_hash/i.test(msg) && !_sgpStripHash) {
          log.warn('DB', 'sgp_audit.leg_hash column missing — run scripts/sgp_stage0_ops.sql to enable dedup-aware demand counting; logging without it');
          _sgpStripHash = true;
          res = await db.from('sgp_audit').upsert(batch.map(({ leg_hash, ...rest }) => rest), { onConflict: 'parlay_id' });
          if (!res.error) { written += batch.length; continue; }
        }
        log.warn('DB', `saveSgpAudit batch error: ${res.error.message}`);
        _sgpStats.dropped += batch.length;
        break;
      }
      written += batch.length;
    }
  } catch (err) {
    log.warn('DB', `saveSgpAudit flush exception: ${err.message}`);
  } finally {
    _sgpFlushing = false;
    _sgpStats.flushes++;
    _sgpStats.flushed += written;
    if (_sgpBuf.size) _ensureSgpTimer();
  }
  return written;
}

/**
 * Persist per-endpoint mute prefs. Called by push.setMutedCategories
 * whenever the client toggles a category. Silently no-ops if the
 * muted_categories column hasn't been added yet (warn-once via the
 * loadPushSubscriptions warning above).
 */
async function savePushMutePrefs(endpoint, mutedCategories) {
  if (!isEnabled() || !endpoint) return;
  const db = getClient();
  try {
    const arr = Array.isArray(mutedCategories) ? mutedCategories : [];
    const { error } = await db.from('push_subscriptions').update({
      muted_categories: arr,
    }).eq('endpoint', endpoint);
    if (error) {
      // Column-missing → quiet no-op (already warned at load time).
      if (/muted_categories/i.test(error.message)) return;
      log.warn('DB', `savePushMutePrefs error: ${error.message}`);
    }
  } catch (err) {
    log.warn('DB', `savePushMutePrefs exception: ${err.message}`);
  }
}

async function deletePushSubscription(endpoint) {
  if (!isEnabled() || !endpoint) return;
  const db = getClient();
  try {
    const { error } = await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) log.warn('DB', `deletePushSubscription error: ${error.message}`);
  } catch (err) {
    log.warn('DB', `deletePushSubscription exception: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// KEY-VALUE STORE
// ---------------------------------------------------------------------------
// Generic JSONB store for small pieces of state that need to survive
// service restarts but don't warrant a dedicated table. One row per key.
//
// Schema expected:
//   create table if not exists kv_store (
//     key         text primary key,
//     value       jsonb not null,
//     updated_at  timestamptz default now()
//   );
//
// First used for the BetOnline Zurich manual-upload cache — operator
// uploads once, cache survives Railway redeploys without re-posting.

/**
 * Upsert one kv_store row. Returns { ok:true } on success, otherwise
 * { ok:false, transient, spooled, error }.
 *
 * opts.critical — when the DB is unreachable, queue the write in the retry
 *   spool (latest value per key wins) instead of dropping it. Use ONLY for
 *   whole-value state with last-write-wins semantics (e.g. the pause flag).
 *   NEVER for state that was hydrated from the DB and merged in memory: if its
 *   boot load failed, the in-memory copy is partial and a replay would CLOBBER
 *   the stored value (the creator-blocklist clobber class). Those owners
 *   (creator-blocklist, runtime-config) run their own load-then-persist retry.
 */
async function saveKV(key, value, opts = {}) {
  const db = getClient();
  if (!db) return { ok: false, disabled: true };
  const spoolIt = () => {
    _spoolPut('kv:' + key, 'kv', true, { key, value }, { ifAbsent: !!opts.fromSpool });
    return { ok: false, transient: true, spooled: true };
  };
  if (!_breaker.canAttempt()) {
    if (opts.critical) return spoolIt();
    return { ok: false, transient: true, spooled: false, error: 'database circuit breaker open' };
  }
  try {
    const res = await db
      .from('kv_store')
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (res.error) {
      const transient = isTransientResult(res);
      log.warn('DB', `saveKV(${key}) error: ${res.error.message}`);
      if (transient && opts.critical) return spoolIt();
      return { ok: false, transient, spooled: false, error: res.error.message };
    }
    return { ok: true };
  } catch (err) {
    log.warn('DB', `saveKV(${key}) exception: ${err.message}`);
    if (opts.critical) return spoolIt();
    return { ok: false, transient: true, spooled: false, error: err.message };
  }
}

/**
 * Read one kv_store value, DISTINGUISHING "absent" from "could not read":
 *   { ok:true, value }          value is null when the row does not exist
 *   { ok:true, value:null, disabled:true }  no DB configured (memory-only mode)
 *   { ok:false, error, transient }          read failed — the caller must not
 *                                           treat this as "empty"
 */
async function loadKVStrict(key) {
  const db = getClient();
  if (!db) return { ok: true, value: null, disabled: true };
  try {
    const res = await db
      .from('kv_store')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (res.error) {
      log.warn('DB', `loadKV(${key}) error: ${res.error.message}`);
      return { ok: false, error: res.error.message, transient: isTransientResult(res) };
    }
    return { ok: true, value: (res.data && res.data.value) || null };
  } catch (err) {
    log.warn('DB', `loadKV(${key}) exception: ${err.message}`);
    return { ok: false, error: err.message, transient: true };
  }
}

async function loadKV(key) {
  const r = await loadKVStrict(key);
  return r.ok ? (r.value || null) : null;
}

// ---------------------------------------------------------------------------
// CLOSING LINES (SGP roadmap Stage 0 item 7)
// ---------------------------------------------------------------------------
// Write-through persistence for odds-feed's closing-line snapshots — the
// in-memory cache dies on every deploy, which silently destroys CLV history.
// Table (see scripts/sgp_stage0_ops.sql):
//   closing_lines(cache_key text primary key, sport text, home_team text,
//     away_team text, commence_time timestamptz, captured_at timestamptz,
//     snapshot jsonb)
// Errors propagate to the caller (capture logs warn-once until the table
// exists).
async function saveClosingLine(cacheKey, snap) {
  const db = getClient();
  if (!db) return;
  const { error } = await db.from('closing_lines').upsert({
    cache_key: cacheKey,
    sport: snap.sport || null,
    home_team: snap.homeTeam || null,
    away_team: snap.awayTeam || null,
    commence_time: snap.commenceTime || null,
    captured_at: snap.capturedAt || new Date().toISOString(),
    snapshot: snap,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// PLAYER-PROP SHADOW QUOTES (Phase 1 — observation-only logging)
// ---------------------------------------------------------------------------
// Persists what we WOULD have priced for pitcher_strikeouts legs that
// arrived in PX RFQs. Used to validate the prop matching pipeline + book
// coverage before flipping to real quoting in Phase 2.
//
// Schema (run manually in Supabase SQL editor before this writes):
//   CREATE TABLE prop_shadow_quotes (
//     id BIGSERIAL PRIMARY KEY,
//     parlay_id TEXT,
//     line_id TEXT,
//     px_event_id TEXT,
//     market_name TEXT,
//     player_name TEXT,
//     line NUMERIC,
//     prop_type TEXT,
//     source TEXT,                 -- 'sharpapi' | 'theoddsapi' (added in TOA fallback commit)
//     fair_prob_over NUMERIC,
//     fair_prob_under NUMERIC,
//     books_with_both_sides INT,
//     books TEXT[],
//     resolved_event_id TEXT,
//     match_error TEXT,
//     match_stages TEXT[],
//     recorded_at TIMESTAMPTZ DEFAULT now()
//   );
//   -- One-time migration if upgrading from the no-source schema:
//   --   ALTER TABLE prop_shadow_quotes ADD COLUMN source TEXT;
// Read counterpart for prop_shadow_quotes — used by /prop-shadow to
// inspect Phase-1 shadow rows by propType (e.g. NBA 'points', MLB
// 'pitcher_strikeouts'). Returns at most `limit` rows newest-first.
async function loadPropShadowQuotes({ propType, fromIso, limit } = {}) {
  const db = getClient();
  if (!db) return [];
  let q = db.from('prop_shadow_quotes').select('*').order('recorded_at', { ascending: false });
  if (propType) q = q.eq('prop_type', propType);
  if (fromIso) q = q.gte('recorded_at', fromIso);
  q = q.limit(Math.min(5000, limit || 500));
  const { data, error } = await q;
  if (error) {
    log.error('DB', `loadPropShadowQuotes failed: ${error.message}`);
    return [];
  }
  return data || [];
}

async function savePropShadowQuote(entry) {
  const db = getClient();
  if (!db) return;
  try {
    const row = {
      parlay_id: entry.parlayId || null,
      line_id: entry.lineId || null,
      px_event_id: entry.pxEventId || null,
      market_name: entry.marketName || null,
      player_name: entry.playerName || null,
      line: entry.line != null ? entry.line : null,
      prop_type: entry.propType || null,
      source: entry.source || null,
      fair_prob_over: entry.fairProbOver != null ? entry.fairProbOver : null,
      fair_prob_under: entry.fairProbUnder != null ? entry.fairProbUnder : null,
      books_with_both_sides: entry.booksWithBothSides != null ? entry.booksWithBothSides : null,
      books: entry.books || null,
      resolved_event_id: entry.resolvedEventId || null,
      match_error: entry.matchError || null,
      match_stages: entry.matchStages || null,
      recorded_at: entry.recordedAt || new Date().toISOString(),
    };
    const { error } = await db.from('prop_shadow_quotes').insert(row);
    if (error && !savePropShadowQuote._warned) {
      log.error('DB', `savePropShadowQuote failed (run the SQL migration to create 'prop_shadow_quotes' table): ${error.message}`);
      savePropShadowQuote._warned = true;
    }
  } catch (err) {
    if (!savePropShadowQuote._warned) {
      log.error('DB', `savePropShadowQuote error: ${err.message}`);
      savePropShadowQuote._warned = true;
    }
  }
}

// ---------------------------------------------------------------------------
// PERSISTENT ROLLUP HELPERS — used by order-tracker's 7-day window cache.
// ---------------------------------------------------------------------------
// Streamlined readers that pull a date-windowed slice of declines /
// matched_parlays for cross-referencing. Default to paginating with retries
// up to MAX_ROWS so a busy week doesn't get silently truncated.

async function loadDeclinesSince(fromIso, opts = {}) {
  // DESC so that when the row count exceeds maxRows we keep the MOST RECENT
  // declines. Truncating the other way drops today's -- the ones the dashboard
  // actually reads.
  try {
    return await _pageKeyset({
      table: 'declines',
      cols: opts.cols || 'parlay_id, reason, declined_at, is_limit, known_legs',
      tsCol: 'declined_at',
      idCol: 'parlay_id',
      gteTs: fromIso,
      ascending: false,
      cap: opts.maxRows || 200000,
      label: `loadDeclinesSince ${fromIso}`,
    });
  } catch (err) {
    log.warn('DB', `loadDeclinesSince error: ${err.message}`);
    return [];
  }
}
async function getDeclinesRollup7d(fromIso) {
  const client = getClient();
  if (!client) return null;
  try {
    const [r, h, m] = await Promise.all([
      client.rpc('declines_rollup', { from_ts: fromIso }),
      client.rpc('declines_leg_histogram', { from_ts: fromIso }),
      client.rpc('matched_missed_rollup', { from_ts: fromIso }),
    ]);
    const err = r.error || h.error || m.error;
    if (err) {
      log.warn('DB', `getDeclinesRollup7d RPC unavailable (${err.message}) — falling back to JS aggregation`);
      return null;
    }
    return { rollup: r.data || [], histogram: h.data || [], missed: m.data || [] };
  } catch (err) {
    log.warn('DB', `getDeclinesRollup7d error: ${err.message} — falling back`);
    return null;
  }
}

async function loadMatchedParlaysSince(fromIso, opts = {}) {
  const client = getClient();
  if (!client) return [];
  const PAGE_SIZE = 1000;
  const MAX_PAGE_RETRIES = 4;
  const MAX_ROWS = opts.maxRows || 50000;
  const all = [];
  let offset = 0;
  const start = Date.now();
  try {
    while (all.length < MAX_ROWS) {
      const pageSize = Math.min(PAGE_SIZE, MAX_ROWS - all.length);
      let data = null;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_PAGE_RETRIES; attempt++) {
        let q = client
          .from('matched_parlays')
          .select('parlay_id, matched_stake, matched_odds, legs, we_quoted, matched_at')
          .gte('matched_at', fromIso);
        if (opts.weQuoted != null) q = q.eq('we_quoted', !!opts.weQuoted);
        const result = await q
          .order('matched_at', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (!result.error) { data = result.data; lastErr = null; break; }
        lastErr = result.error;
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
      }
      if (lastErr) {
        log.warn('DB', `loadMatchedParlaysSince offset ${offset}: ${lastErr.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    log.info('DB', `loadMatchedParlaysSince ${fromIso}: ${all.length} rows (${Date.now() - start}ms)`);
    return all;
  } catch (err) {
    log.warn('DB', `loadMatchedParlaysSince error: ${err.message}`);
    return all;
  }
}

// ---------------------------------------------------------------------------
// BOOT PROBE + HEALTH
// ---------------------------------------------------------------------------
/**
 * One cheap read before the boot sequence's ~12 sequential DB hydrations. If
 * Supabase does not answer within DB_BOOT_PROBE_MS (default 5s) the breaker is
 * forced OPEN, so every boot read fails fast instead of each one burning a
 * full timeout (or, pre-breaker, ~20s to a Cloudflare 522) in series.
 */
async function bootProbe() {
  const db = getClient();
  if (!db) return { skipped: true };
  const ms = _envNum('DB_BOOT_PROBE_MS', 5000);
  const t0 = Date.now();
  let timer = null;
  try {
    const res = await Promise.race([
      db.from('kv_store').select('key').limit(1),
      new Promise(resolve => { timer = setTimeout(() => resolve({ error: { message: `no answer within ${ms}ms` }, status: 0 }), ms); if (timer.unref) timer.unref(); }),
    ]);
    if (res && res.error && isTransientResult(res)) {
      _breaker.forceOpen(`boot probe failed: ${res.error.message}`);
      log.error('DB', `Boot probe FAILED (${res.error.message}) — breaker forced open; boot hydrations will fail fast and use fallbacks`);
      return { ok: false, ms: Date.now() - t0, error: res.error.message };
    }
    log.info('DB', `Boot probe OK (${Date.now() - t0}ms)`);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    _breaker.forceOpen(`boot probe threw: ${err.message}`);
    return { ok: false, ms: Date.now() - t0, error: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Breaker + spool + write-volume state for /status and /health. */
function getHealth({ brief = false } = {}) {
  const b = _breaker.snapshot();
  const counts = _spoolCounts();
  if (brief) {
    return { enabled: isEnabled(), state: b.state, retryInSec: b.retryInSec, spooled: counts.total, spooledCritical: counts.critical, droppedCritical: _spoolStats.droppedCritical };
  }
  let oldest = null;
  for (const e of _spool.values()) { oldest = e.enqueuedAt; break; }
  return {
    enabled: isEnabled(),
    breaker: b,
    spool: {
      ...counts,
      oldestAgeSec: oldest ? Math.round((Date.now() - oldest) / 1000) : null,
      max: _spoolMax(), criticalMax: _spoolCriticalMax(), drainPerSec: _spoolDrainPerSec(),
      ..._spoolStats,
    },
    writes: {
      quotePersistSample: quotePersistSampleRate(),
      quotes: { ..._quoteStats },
      saveOrder: getSaveOrderStats(),
      declines: getDeclineWriteStats(),
      sgpAudit: { buffered: _sgpBuf.size, ..._sgpStats },
      lineCache: { ..._lineCacheStats, fingerprints: _lineCacheFp.size },
    },
    lastOrdersLoad: getLastOrdersLoad(),
  };
}

// Test hooks — never used by production code.
function __setTestClient(client, breaker) {
  _testClient = client || null;
  if (breaker) { _breaker = breaker; _wireBreaker(_breaker); }
}
function __resetForTest() {
  _lastSavedHash.clear(); _saveStats.unchangedSkipped = 0; _saveStats.written = 0; _saveCallers.clear();
  _testClient = null;
  _spool.clear();
  _stopDrainTimer();
  for (const k of Object.keys(_spoolStats)) _spoolStats[k] = k === 'lastDrainAt' ? null : 0;
  for (const k of Object.keys(_quoteStats)) _quoteStats[k] = 0;
  _sgpBuf.clear();
  _lineCacheFp.clear();
  _lineCacheLastFullAt = 0;
  _declineBuf.length = 0;
  _breaker = new DbCircuitBreaker();
  _wireBreaker(_breaker);
}
function __setDrainTimerEnabled(on) { _drainTimerEnabled = !!on; if (!on) _stopDrainTimer(); }
function __spoolEntries() { return [..._spool.values()].map(e => ({ key: e.key, kind: e.kind, critical: e.critical })); }

module.exports = {
  flushSpoolForShutdown,
  loadOrdersByParlayIdsChecked,
  isAvailable,
  getBreaker,
  getHealth,
  bootProbe,
  getLastOrdersLoad,
  loadKVStrict,
  flushSgpAudits,
  quotePersistSampleRate,
  isQuoteSampled,
  isUnfilledQuoteWrite,
  quoteRowWeight,
  _drainOnce,
  __setTestClient,
  __resetForTest,
  __spoolEntries,
  __setDrainTimerEnabled,
  // Test seam: keyset pager, exercised with a fake client in
  // test/keyset-pagination.test.js (ties, cap, retry, loop guard).
  _pageKeyset,
  // Test seam: the integer-column coercion that keeps a decimal from PX
  // silently dropping a whole matched_parlays row.
  _intOdds,
  getClient,
  isEnabled,
  saveOrder,
  loadOrders,
  loadRecentQuotedOrders,
  loadOrdersByParlayIds,
  loadFillBucketRowsSince,
  countOrders,
  saveMatchedParlay,
  loadMatchedParlays,
  loadMatchedParlaysSince,
  saveDecline,
  flushDeclines,
  getDeclineWriteStats,
  loadDeclines,
  loadDeclinesSince,
  getDeclinesRollup7d,
  lookupDecline,
  savePropShadowQuote,
  loadPropShadowQuotes,
  saveKV,
  loadKV,
  getSaveOrderStats,
  saveClosingLine,
  saveLineCache,
  loadLineCacheEntry,
  loadLineCacheBulk,
  loadAllRecentLineCache,
  loadLineCacheByEventIds,
  getDailyPnL,
  getTotalPnL,
  loadOrdersInDateRange,
  savePushSubscription,
  loadPushSubscriptions,
  deletePushSubscription,
  savePushMutePrefs,
  saveSgpAudit,
};
