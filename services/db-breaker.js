// DATABASE CIRCUIT BREAKER — the single choke point for every Supabase request.
//
// INCIDENT 2026-10-03: the Supabase project (Small compute) went UNHEALTHY for
// ~13h. The trader kept writing — every quote, matched parlay, SGP audit,
// decline batch and the full line_cache on every 2-min seed — and each call
// hung ~20s to a Cloudflare 522, so the instance never got room to recover
// (568K API requests/24h, 162K gateway errors). Side effects: the runtime
// config POST awaited the DB and 502'd through Railway's edge, and a restart
// during the outage booted with an empty creator blocklist and no runtime
// overrides.
//
// This module wraps `fetch` and is handed to supabase-js as `global.fetch`
// (services/db.js), so EVERY request — the helpers in db.js AND the ~25 call
// sites in index.js / order-tracker / prop-settlement / sig-cooldown that use
// db.getClient() directly — passes through it. No call site can bypass it.
//
// STATE MACHINE
//   CLOSED     requests go out with a hard client-side timeout (writes 8s,
//              reads 12s). An outage-class failure (network error, timeout,
//              HTTP 502/503/504/520-530) is recorded; a success resets the
//              consecutive count.
//              TRIP when consecutive failures >= DB_BREAKER_FAILURES (5), OR
//              when the rolling DB_BREAKER_WINDOW_MS (60s) holds >= that many
//              failures AND they are >= 50% of the window's requests (so a
//              trickle of successes in a mostly-dead window cannot hold it
//              closed, but 5 blips among 500 good requests cannot trip it).
//   OPEN       every request fails FAST — no network — with a DbCircuitOpen
//              error. postgrest-js turns a thrown fetch into
//              `{ data:null, error:{ message:'DbCircuitOpen: ...' }, status:0 }`,
//              so every existing caller takes its existing "unavailable" path
//              (null / [] / logged error) with zero code changes.
//              Backoff: DB_BREAKER_OPEN_MS (60s) doubling per consecutive trip
//              up to DB_BREAKER_MAX_OPEN_MS (10 min). The level resets once
//              the breaker has stayed closed for a full max window.
//   HALF_OPEN  after the backoff, exactly ONE request is let through as a
//              probe; all others keep failing fast while it is in flight.
//              Success -> CLOSED (listeners notified: db.js drains its retry
//              spool, paced). Failure -> OPEN at the next backoff level.
//
// WHAT COUNTS AS A FAILURE. Only signals that the DATABASE is unreachable:
// thrown fetch errors (incl. our timeout) and gateway/origin 5xx. A plain 500
// is NOT counted — PostgREST returns 500 for query-level errors such as a
// statement timeout on one heavy analytics query, and a slow dashboard click
// must not dark every write. 4xx (bad request, schema errors) means the DB
// answered, so it counts as a success for breaker purposes.
//
// The response BODY is read inside the timeout window and re-wrapped, so a
// server that sends headers and then stalls the body cannot hang a caller.

'use strict';

const OUTAGE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function _envNum(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function _named(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

// Parse "https://x.supabase.co/rest/v1/parlay_orders?select=..." -> 'parlay_orders'.
function _tableOf(url) {
  try {
    const m = String(url).match(/\/rest\/v1\/(rpc\/)?([^/?#]+)/);
    if (m) return (m[1] ? 'rpc:' : '') + m[2];
  } catch (_) { /* fall through */ }
  return 'other';
}

class DbCircuitBreaker {
  constructor(opts = {}) {
    this.failThreshold = opts.failThreshold ?? _envNum('DB_BREAKER_FAILURES', 5);
    this.windowMs = opts.windowMs ?? _envNum('DB_BREAKER_WINDOW_MS', 60_000);
    this.baseOpenMs = opts.baseOpenMs ?? _envNum('DB_BREAKER_OPEN_MS', 60_000);
    this.maxOpenMs = opts.maxOpenMs ?? _envNum('DB_BREAKER_MAX_OPEN_MS', 600_000);
    this.writeTimeoutMs = opts.writeTimeoutMs ?? _envNum('DB_TIMEOUT_MS', 8_000);
    this.readTimeoutMs = opts.readTimeoutMs ?? _envNum('DB_READ_TIMEOUT_MS', 12_000);
    this.now = opts.now || Date.now;
    this.fetchImpl = opts.fetchImpl || ((url, init) => fetch(url, init));
    this._listeners = [];
    this.reset();
    // Bound so supabase-js can call it unbound.
    this.fetch = this.fetch.bind(this);
  }

  reset() {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.level = 0;               // backoff exponent
    this.openedAt = null;
    this.openUntil = null;
    this.lastClosedAt = null;
    this.probeInFlight = false;
    this.lastError = null;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.tripCount = 0;
    this._window = [];            // [{ t, ok }]
    this.totals = { requests: 0, ok: 0, failures: 0, timeouts: 0, fastFailed: 0, probes: 0, outageStatus: 0 };
    this.byTable = {};            // 'GET parlay_orders' -> count
    this._minuteBuckets = new Map(); // epochMinute -> count (last 60)
  }

  onStateChange(fn) { if (typeof fn === 'function') this._listeners.push(fn); }

  _emit(from, to, reason) {
    for (const fn of this._listeners) {
      try { fn({ from, to, reason, state: this.snapshot() }); } catch (_) { /* listener must never break the breaker */ }
    }
  }

  /** True when a request issued now would actually reach the network. */
  canAttempt() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') return this.now() >= this.openUntil;
    return !this.probeInFlight; // half_open
  }

  isOpen() { return this.state !== 'closed'; }

  /** Trip immediately (boot probe failed, operator action). */
  forceOpen(reason) {
    this._trip(reason || 'forced', true);
  }

  _currentBackoffMs() {
    return Math.min(this.baseOpenMs * Math.pow(2, this.level), this.maxOpenMs);
  }

  _trip(reason, fromHalfOpen) {
    const t = this.now();
    const prev = this.state;
    if (fromHalfOpen || prev !== 'closed') {
      // Probe failed / re-trip while not closed: escalate.
      if (this.openedAt != null) this.level = Math.min(this.level + 1, 30);
    } else if (this.lastClosedAt != null && (t - this.lastClosedAt) < this.maxOpenMs) {
      // Flapping: it closed recently and failed again — escalate.
      this.level = Math.min(this.level + 1, 30);
    } else {
      this.level = 0;
    }
    this.state = 'open';
    this.openedAt = t;
    this.openUntil = t + this._currentBackoffMs();
    this.probeInFlight = false;
    this.tripCount++;
    this.consecutiveFailures = 0;
    this._window = [];
    if (prev !== 'open') this._emit(prev, 'open', reason);
  }

  _close() {
    const prev = this.state;
    this.state = 'closed';
    this.lastClosedAt = this.now();
    this.openedAt = null;
    this.openUntil = null;
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    this._window = [];
    if (prev !== 'closed') this._emit(prev, 'closed', 'probe succeeded');
  }

  _admit() {
    if (this.state === 'closed') return 'go';
    if (this.state === 'open') {
      if (this.now() < this.openUntil) return 'reject';
      this.state = 'half_open';
      this.probeInFlight = true;
      return 'probe';
    }
    // half_open
    if (this.probeInFlight) return 'reject';
    this.probeInFlight = true;
    return 'probe';
  }

  _pushWindow(ok) {
    const t = this.now();
    this._window.push({ t, ok });
    const cutoff = t - this.windowMs;
    while (this._window.length && this._window[0].t < cutoff) this._window.shift();
    if (this._window.length > 5000) this._window.splice(0, this._window.length - 5000);
  }

  _recordSuccess(kind) {
    this.totals.ok++;
    this.lastSuccessAt = this.now();
    if (kind === 'probe') { this._close(); return; }
    if (this.state !== 'closed') return; // a straggler that started before the trip
    this.consecutiveFailures = 0;
    this._pushWindow(true);
  }

  _recordFailure(kind, reason) {
    this.totals.failures++;
    this.lastFailureAt = this.now();
    this.lastError = reason;
    if (kind === 'probe') { this._trip(`probe failed: ${reason}`, true); return; }
    if (this.state !== 'closed') return;
    this.consecutiveFailures++;
    this._pushWindow(false);
    if (this.consecutiveFailures >= this.failThreshold) {
      this._trip(`${this.consecutiveFailures} consecutive failures (last: ${reason})`);
      return;
    }
    const fails = this._window.filter(e => !e.ok).length;
    if (fails >= this.failThreshold && fails / this._window.length >= 0.5) {
      this._trip(`${fails}/${this._window.length} requests failed within ${Math.round(this.windowMs / 1000)}s (last: ${reason})`);
    }
  }

  _count(method, url) {
    this.totals.requests++;
    const key = `${method} ${_tableOf(url)}`;
    this.byTable[key] = (this.byTable[key] || 0) + 1;
    const minute = Math.floor(this.now() / 60_000);
    this._minuteBuckets.set(minute, (this._minuteBuckets.get(minute) || 0) + 1);
    if (this._minuteBuckets.size > 61) {
      for (const k of this._minuteBuckets.keys()) {
        if (k < minute - 60) this._minuteBuckets.delete(k);
      }
    }
  }

  /** Requests that actually went to the network over the last N minutes, per minute. */
  ratePerMinute(minutes) {
    const nowMin = Math.floor(this.now() / 60_000);
    let sum = 0;
    for (let m = nowMin - minutes + 1; m <= nowMin; m++) sum += this._minuteBuckets.get(m) || 0;
    return Math.round((sum / minutes) * 10) / 10;
  }

  async fetch(url, init = {}) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const decision = this._admit();
    if (decision === 'reject') {
      this.totals.fastFailed++;
      const secs = this.openUntil != null ? Math.max(0, Math.ceil((this.openUntil - this.now()) / 1000)) : 0;
      throw _named('DbCircuitOpen', `database circuit breaker is ${this.state} (retry in ~${secs}s; last error: ${this.lastError || 'n/a'})`);
    }
    if (decision === 'probe') this.totals.probes++;
    this._count(method, url);

    const timeoutMs = (method === 'GET' || method === 'HEAD') ? this.readTimeoutMs : this.writeTimeoutMs;
    const controller = new AbortController();
    const callerSignal = init && init.signal;
    let timedOut = false;
    let onCallerAbort = null;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else {
        onCallerAbort = () => controller.abort(callerSignal.reason);
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (timer.unref) timer.unref();

    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      // Read the body INSIDE the timeout window, then hand back a fresh
      // Response so postgrest-js can read it again without a second hang.
      let body = null;
      if (method !== 'HEAD' && !NULL_BODY_STATUSES.has(res.status)) body = await res.arrayBuffer();
      const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      if (OUTAGE_STATUSES.has(res.status)) {
        this.totals.outageStatus++;
        this._recordFailure(decision, `HTTP ${res.status}`);
      } else {
        this._recordSuccess(decision);
      }
      return out;
    } catch (err) {
      if (timedOut) {
        this.totals.timeouts++;
        this._recordFailure(decision, `timeout after ${timeoutMs}ms (${method} ${_tableOf(url)})`);
        throw _named('DbTimeout', `Supabase request exceeded ${timeoutMs}ms (${method} ${_tableOf(url)})`);
      }
      if (callerSignal && callerSignal.aborted) {
        // Caller cancelled — says nothing about DB health. Release a probe slot.
        if (decision === 'probe') this.probeInFlight = false;
        throw err;
      }
      this._recordFailure(decision, `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`);
      throw err;
    } finally {
      clearTimeout(timer);
      if (onCallerAbort && callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  snapshot() {
    const t = this.now();
    const topTables = Object.entries(this.byTable).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([k, n]) => ({ endpoint: k, requests: n }));
    return {
      state: this.state,
      canAttempt: this.canAttempt(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      openUntil: this.openUntil ? new Date(this.openUntil).toISOString() : null,
      retryInSec: this.openUntil ? Math.max(0, Math.ceil((this.openUntil - t) / 1000)) : null,
      backoffLevel: this.level,
      nextBackoffSec: Math.round(this._currentBackoffMs() / 1000),
      tripCount: this.tripCount,
      lastError: this.lastError,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      totals: { ...this.totals },
      requestsPerMin: { last1: this.ratePerMinute(1), last5: this.ratePerMinute(5), last60: this.ratePerMinute(60) },
      topEndpoints: topTables,
      config: {
        failThreshold: this.failThreshold, windowMs: this.windowMs,
        baseOpenMs: this.baseOpenMs, maxOpenMs: this.maxOpenMs,
        writeTimeoutMs: this.writeTimeoutMs, readTimeoutMs: this.readTimeoutMs,
      },
    };
  }
}

/**
 * True when a postgrest result failed because the DATABASE was unreachable
 * (breaker open, timeout, network, gateway 5xx) — i.e. the write should be
 * retried later — as opposed to a permanent/query error (bad column, constraint).
 * postgrest-js reports a thrown fetch as status 0.
 */
function isTransientResult(result) {
  if (!result || !result.error) return false;
  if (result.status === 0 || result.status == null) return true;
  return OUTAGE_STATUSES.has(result.status);
}

module.exports = { DbCircuitBreaker, isTransientResult, OUTAGE_STATUSES, _tableOf };
