// Creator-ID blocklist for adverse-selection defense.
//
// PX exposes `creator_id` on every RFQ. When the operator identifies a
// sharp (consistent +bettor-ROI across N≥20 fills), they can add the
// creator_id to this blocklist. handleRFQ checks the in-memory Set and
// declines RFQs from blocked creators BEFORE pricing — so we don't waste
// latency on quotes we'd never want filled.
//
// Persistence: kv_store['creator_blocklist'] (Supabase) survives Railway
// redeploys. In-memory Set is hot-reloaded every 30s in case another
// process / endpoint mutates the kv row directly.
//
// Storage shape (kv_store value):
//   {
//     entries: [
//       { creatorId: 'uuid', reason: 'free-text', addedAt: ISO },
//       ...
//     ],
//     updatedAt: ISO,
//   }
//
// Public API:
//   isBlocked(creatorId)         — sync check, hot path
//   list()                        — full entries array for dashboard
//   add(creatorId, reason)        — add (idempotent) + persist
//   remove(creatorId)             — remove + persist
//   restoreFromPersistence()      — boot hook
//   __refresh()                   — manual cache refresh (test hook)
const log = require('./logger');
const db = require('./db');

const KV_KEY = 'creator_blocklist';
const REFRESH_INTERVAL_MS = 30 * 1000;
// Hard ceiling on any on-demand refresh (ensureFresh) so the confirm hot path
// can NEVER hang on a slow Supabase. Mirrors the 800ms bound the confirm-time
// PX creator-lookup already uses. (2026-06-10: an unbounded fetch on the
// confirm path froze every fill for ~2h.)
const ENSURE_FRESH_TIMEOUT_MS = 800;

// In-memory state
let _blocked = new Map(); // creatorId -> { reason, addedAt }
let _lastRefreshAt = 0;
let _refreshTimer = null;
let _initialized = false;
let _inflightLoad = null; // coalesces concurrent ensureFresh() loads onto one DB round-trip

// DB-DOWN SAFETY (2026-10-03 outage). A restart while Supabase was unreachable
// booted with an EMPTY blocklist. Three rules now:
//   1. Never persist until a REAL DB load has landed (`_loadedOnce`). The
//      in-memory list after a failed boot load is a fallback/partial copy, and
//      writing it would CLOBBER the stored list — the 2026-06-26 clobber bug,
//      reintroduced by any spool/retry that replays a write made while down.
//   2. Operator add/remove while the DB is unavailable takes effect in memory
//      IMMEDIATELY (the RFQ + confirm gates see it) and is kept in
//      `_pendingOps`, re-applied on top of every load until a persist lands —
//      so the 30s refresh cannot silently undo a block made during an outage.
//   3. A failed boot load falls back to the last-known-good list: the
//      state-snapshot file (STATE_SNAPSHOT_DIR on a Railway volume), else the
//      operator-maintained CREATOR_BLOCKLIST_FALLBACK env ids. The first real
//      DB load replaces the fallback (the DB is authoritative).
let _loadedOnce = false;
let _pendingOps = []; // [{ op:'add'|'remove', id, reason, addedAt }]
let _source = 'none'; // 'db' | 'snapshot' | 'env-fallback' | 'none'
let _flushing = null;

function _snapshot() {
  try { return require('./state-snapshot'); } catch (_) { return null; }
}

function _applyOps(entries) {
  const m = new Map();
  for (const e of entries || []) if (e && e.creatorId) m.set(String(e.creatorId), e);
  for (const op of _pendingOps) {
    if (op.op === 'add') {
      const prev = m.get(op.id);
      m.set(op.id, { creatorId: op.id, reason: op.reason || (prev && prev.reason) || '', addedAt: (prev && prev.addedAt) || op.addedAt });
    } else if (op.op === 'remove') {
      m.delete(op.id);
    }
  }
  return [...m.values()];
}

// Called after every successful DB read: merge pending local ops, mark loaded,
// refresh the snapshot, and push pending ops to the DB.
function _onLoaded(entries) {
  _hydrate(_applyOps(entries));
  _loadedOnce = true;
  _source = 'db';
  if (_pendingOps.length) _flushPending().catch(() => {});
  else _writeSnapshot();
}

function _writeSnapshot() {
  const snap = _snapshot();
  if (snap) snap.write('creator-blocklist', { entries: list() });
}

function _fallbackEntries() {
  const snap = _snapshot();
  const fromFile = snap && snap.read('creator-blocklist');
  if (fromFile && fromFile.data && Array.isArray(fromFile.data.entries) && fromFile.data.entries.length) {
    return { entries: fromFile.data.entries, source: 'snapshot', savedAt: fromFile.savedAt };
  }
  const raw = process.env.CREATOR_BLOCKLIST_FALLBACK || '';
  const ids = raw.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
  if (ids.length) {
    const at = new Date().toISOString();
    return { entries: ids.map(id => ({ creatorId: id, reason: 'CREATOR_BLOCKLIST_FALLBACK (DB unavailable at boot)', addedAt: at })), source: 'env-fallback' };
  }
  return null;
}

/** Copy-paste value for the CREATOR_BLOCKLIST_FALLBACK env var (current list). */
function fallbackEnvValue() {
  return list().map(e => e.creatorId).join(',');
}

function getPersistenceState() {
  return { source: _source, loadedOnce: _loadedOnce, pendingOps: _pendingOps.length, entries: _blocked.size, lastRefreshAt: _lastRefreshAt ? new Date(_lastRefreshAt).toISOString() : null };
}

function _hydrate(entries) {
  const next = new Map();
  for (const e of entries || []) {
    if (e && e.creatorId) {
      next.set(String(e.creatorId), {
        reason: e.reason || '',
        addedAt: e.addedAt || new Date().toISOString(),
      });
    }
  }
  _blocked = next;
  _lastRefreshAt = Date.now();
}

// Single source of truth for "pull the kv row into the in-memory cache".
// Returns true ONLY when real data was loaded. db.loadKV() swallows errors and
// returns null, so a null here is AMBIGUOUS (transient DB error vs. an absent
// row) — in both cases we must NOT mark the cache fresh, or a boot-time blip
// would leave us fail-open-but-"fresh" for the next 30s. Keeping the prior
// snapshot and returning false lets restoreFromPersistence retry and lets
// ensureFresh() keep trying on each confirm until a real load lands. An empty
// `entries: []` IS a real load (operator cleared the list) and marks fresh.
async function _load() {
  const stored = await db.loadKV(KV_KEY);
  if (stored && Array.isArray(stored.entries)) {
    _onLoaded(stored.entries);
    return true;
  }
  return false;
}

// Strict variant for the write path: distinguishes "row absent" (a real, empty
// load — safe to create) from "could not read" (never persist). Falls back to
// the loadKV semantics when the db module has no strict reader.
async function _loadStrict() {
  if (typeof db.loadKVStrict === 'function') {
    const r = await db.loadKVStrict(KV_KEY);
    if (!r || !r.ok) return false;
    const entries = r.value && Array.isArray(r.value.entries) ? r.value.entries : [];
    _onLoaded(entries);
    return true;
  }
  return _load();
}

// Persist the pending ops. Never writes before a real load (rule 1). Resolves
// true when the DB now holds the in-memory list.
function _flushPending() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    if (!_loadedOnce) {
      let ok = false;
      try { ok = await _loadStrict(); } catch (_) { ok = false; }
      if (!ok) return false;          // _onLoaded re-entered us if it succeeded
      if (!_pendingOps.length) return true;
    }
    const opsAtWrite = _pendingOps.length;
    let res;
    try {
      res = await db.saveKV(KV_KEY, { entries: list(), updatedAt: new Date().toISOString() });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    // Legacy/stub saveKV resolves undefined on success.
    const ok = res === undefined || res === null || res.ok !== false;
    if (!ok) {
      log.warn('CreatorBlocklist', `Persist deferred (DB unavailable) — ${_pendingOps.length} change(s) held in memory and re-applied until the DB answers`);
      return false;
    }
    _pendingOps.splice(0, opsAtWrite);
    _writeSnapshot();
    return true;
  })().finally(() => { _flushing = null; });
  return _flushing;
}

async function restoreFromPersistence() {
  if (_initialized) return;
  _initialized = true;
  // Retry the initial load — a transient Supabase blip at boot must NOT leave
  // the blocklist permanently empty (fail-open) until the first 30s refresh.
  // ensureFresh() on the confirm path is the backstop, but loading here arms
  // the RFQ-time gate from the very first RFQ.
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      loaded = await _load();
    } catch (err) {
      log.warn('CreatorBlocklist', `Hydrate attempt ${attempt}/3 threw: ${err.message}`);
    }
    if (!loaded && attempt < 3) await new Promise(r => setTimeout(r, 250 * attempt));
  }
  if (loaded) {
    log.info('CreatorBlocklist', `Hydrated ${_blocked.size} entries from Supabase kv_store`);
  } else {
    const fb = _fallbackEntries();
    if (fb) {
      _hydrate(_applyOps(fb.entries));
      // Deliberately NOT fresh: ensureFresh()/the 30s timer keep trying the DB,
      // and the first real load replaces this list.
      _lastRefreshAt = 0;
      _source = fb.source;
      log.error('CreatorBlocklist', `Hydrate failed after 3 attempts — using LAST-KNOWN-GOOD fallback (${fb.source}${fb.savedAt ? ` saved ${fb.savedAt}` : ''}): ${_blocked.size} entr${_blocked.size === 1 ? 'y' : 'ies'}; the DB list replaces it on the first successful load`);
    } else {
      log.error('CreatorBlocklist', 'Hydrate failed after 3 attempts and NO fallback is configured (set CREATOR_BLOCKLIST_FALLBACK or STATE_SNAPSHOT_DIR) — starting EMPTY; ensureFresh() will retry at confirm time');
    }
  }
  // Periodic refresh in case kv was mutated out-of-band. Doesn't await —
  // first call to isBlocked() during refresh just uses the previous snapshot.
  if (!_refreshTimer) {
    _refreshTimer = setInterval(async () => {
      try { await _load(); } catch (_) { /* swallow — keep prior snapshot */ }
    }, REFRESH_INTERVAL_MS);
    _refreshTimer.unref && _refreshTimer.unref();
  }
}

// On-demand, bounded cache refresh used by the confirm-time gate — the LAST
// line of defense before a wager lands. Returns immediately (no DB) when the
// cache was loaded within maxAgeMs; otherwise pulls the kv row, racing a hard
// timeout so it can never hang the confirm hot path. Never throws.
//
// WHY THIS EXISTS: both blocklist gates decide via the in-memory _blocked map.
// On a cold boot that map is empty until restoreFromPersistence + the 30s timer
// populate it, so a blocked creator can slip BOTH the RFQ-time and confirm-time
// gates inside the boot window (root cause of the 2026-06-26 slip — creator
// 45628ef7 quoted+filled ~19s apart, both while the cache was still empty).
// Calling ensureFresh() at confirm time self-heals that window.
async function ensureFresh(maxAgeMs = REFRESH_INTERVAL_MS) {
  // Key freshness purely off the last SUCCESSFUL load, not _initialized: any
  // loader (boot hook, 30s timer, or a prior ensureFresh) advances
  // _lastRefreshAt, and in the degraded path where restoreFromPersistence
  // failed, ensureFresh is the only loader — gating on _initialized there would
  // re-hit the DB on every confirm.
  if (_lastRefreshAt && (Date.now() - _lastRefreshAt) <= maxAgeMs) return;
  if (!_inflightLoad) {
    _inflightLoad = (async () => {
      try {
        await Promise.race([
          _load(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('blocklist refresh timeout')), ENSURE_FRESH_TIMEOUT_MS)),
        ]);
      } finally {
        _inflightLoad = null;
      }
    })();
  }
  try { await _inflightLoad; } catch (_) { /* timeout / DB error — keep prior snapshot, fail open */ }
}

// Confirm-time blocklist decision — the single gate the confirm handler calls.
// Refreshes a cold/stale cache first (ensureFresh), THEN resolves the
// counterparty: meta first (stamped at quote time), bounded REST fallback
// second (PX returns creator_id on the live order even when it was omitted on
// the RFQ). Bounded throughout; never throws.
//
// metaCreatorId      — creator id stamped on the order at quote time, or null.
// fetchLiveCreatorId — async () => (creatorId|null); the caller's bounded PX
//                      lookup, only invoked when meta lacks the id AND the
//                      blocklist is non-empty (someone to actually block).
// Returns { blocked, creatorId, via } where via ∈ 'meta' | 'rest' | null —
// `via` lets the caller log which path caught (or cleared) the order.
async function resolveConfirmBlock({ metaCreatorId, fetchLiveCreatorId } = {}) {
  await ensureFresh();
  let creatorId = metaCreatorId || null;
  let via = creatorId ? 'meta' : null;
  if (!creatorId && _blocked.size > 0 && typeof fetchLiveCreatorId === 'function') {
    try {
      const liveCid = await fetchLiveCreatorId();
      if (liveCid) { creatorId = String(liveCid); via = 'rest'; }
    } catch (_) { /* caller logs; proceed without the live id (fail open) */ }
  }
  return { blocked: !!(creatorId && isBlocked(creatorId)), creatorId, via };
}

function isBlocked(creatorId) {
  if (!creatorId) return false;
  return _blocked.has(String(creatorId));
}

function getEntry(creatorId) {
  if (!creatorId) return null;
  return _blocked.get(String(creatorId)) || null;
}

function list() {
  const out = [];
  for (const [creatorId, meta] of _blocked.entries()) {
    out.push({ creatorId, reason: meta.reason, addedAt: meta.addedAt });
  }
  // Newest first for the dashboard.
  out.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  return out;
}

// Record a local mutation and try to persist it. Never throws; the mutation is
// already live in memory, and stays pending until a write lands.
async function _persist(op) {
  if (op) _pendingOps.push(op);
  try { await _flushPending(); } catch (_) { /* held in _pendingOps */ }
}

async function add(creatorId, reason) {
  if (!creatorId) throw new Error('creatorId required');
  const id = String(creatorId);
  const existing = _blocked.get(id);
  if (existing) {
    // Idempotent: update reason if a new one was given, else no-op.
    if (reason && reason !== existing.reason) {
      _blocked.set(id, { ...existing, reason });
      await _persist({ op: 'add', id, reason, addedAt: existing.addedAt });
      return { added: false, updated: true };
    }
    return { added: false, updated: false };
  }
  const addedAt = new Date().toISOString();
  _blocked.set(id, {
    reason: reason || '',
    addedAt,
  });
  await _persist({ op: 'add', id, reason: reason || '', addedAt });
  log.info('CreatorBlocklist', `Blocked ${id} (reason: ${reason || '<none>'})`);
  // Post-block sweep: PX exposes no offer-retract API, so our already-resting
  // quotes from this creator stay live in PX's book until they expire or a
  // confirm arrives. The confirm-time gate now rejects those confirms, so they
  // can't FILL — but they're still holding reserved exposure. Sweep them now to
  // free that budget immediately and leave an explicit audit (would have caught
  // the 4fc8c778 2026-06-17 same-day-block cluster). Off the hot path; never
  // throws. Lazy require avoids a load-order cycle with order-tracker.
  const sweep = _sweepOpenOrders(id, reason);
  return { added: true, updated: false, sweep };
}

// Reject + release exposure on this creator's still-open quotes. Returns a
// summary { swept, parlayIds, riskReleased }; safe no-op if order-tracker isn't
// available. Never throws — blocking must succeed even if the sweep can't run.
function _sweepOpenOrders(id, reason) {
  try {
    const orderTracker = require('./order-tracker');
    if (typeof orderTracker.sweepOpenOrdersByCreator === 'function') {
      return orderTracker.sweepOpenOrdersByCreator(
        id, reason ? `creator blocked: ${reason}` : 'creator blocked — swept');
    }
  } catch (err) {
    log.warn('CreatorBlocklist', `Post-block sweep failed for ${id}: ${err.message}`);
  }
  return { swept: 0, parlayIds: [], riskReleased: 0 };
}

async function remove(creatorId) {
  if (!creatorId) throw new Error('creatorId required');
  const id = String(creatorId);
  if (!_blocked.has(id)) return { removed: false };
  _blocked.delete(id);
  await _persist({ op: 'remove', id });
  log.info('CreatorBlocklist', `Unblocked ${id}`);
  return { removed: true };
}

// Test hook — bypass the timer.
async function __refresh() {
  try { await _load(); } catch (_) {}
}

// Test hook — let unit tests inject state without a real DB.
function __setForTest(entries, opts = {}) {
  _hydrate(entries);
  _initialized = true;
  // Injected state stands in for a DB load unless the test says otherwise.
  _loadedOnce = opts.loadedOnce !== false;
}

// Test hook — force the module back to cold-boot state (empty + uninitialized)
// so a test can exercise the ensureFresh()/cold-cache self-heal path.
function __resetForTest() {
  _blocked = new Map();
  _lastRefreshAt = 0;
  _initialized = false;
  _inflightLoad = null;
  _loadedOnce = false;
  _pendingOps = [];
  _source = 'none';
  _flushing = null;
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

module.exports = {
  restoreFromPersistence,
  isBlocked,
  getEntry,
  list,
  add,
  remove,
  ensureFresh,
  resolveConfirmBlock,
  fallbackEnvValue,
  getPersistenceState,
  __refresh,
  __setForTest,
  __resetForTest,
};
