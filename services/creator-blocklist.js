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

// In-memory state
let _blocked = new Map(); // creatorId -> { reason, addedAt }
let _lastRefreshAt = 0;
let _refreshTimer = null;
let _initialized = false;

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

async function restoreFromPersistence() {
  if (_initialized) return;
  _initialized = true;
  try {
    const stored = await db.loadKV(KV_KEY);
    _hydrate(stored && stored.entries);
    log.info('CreatorBlocklist', `Hydrated ${_blocked.size} entries from Supabase kv_store`);
  } catch (err) {
    log.warn('CreatorBlocklist', `Hydrate failed (non-fatal, starting empty): ${err.message}`);
  }
  // Periodic refresh in case kv was mutated out-of-band. Doesn't await —
  // first call to isBlocked() during refresh just uses the previous snapshot.
  if (!_refreshTimer) {
    _refreshTimer = setInterval(async () => {
      try {
        const stored = await db.loadKV(KV_KEY);
        _hydrate(stored && stored.entries);
      } catch (_) { /* swallow — keep prior snapshot */ }
    }, REFRESH_INTERVAL_MS);
    _refreshTimer.unref && _refreshTimer.unref();
  }
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

async function _persist() {
  const payload = {
    entries: list(),
    updatedAt: new Date().toISOString(),
  };
  await db.saveKV(KV_KEY, payload);
}

async function add(creatorId, reason) {
  if (!creatorId) throw new Error('creatorId required');
  const id = String(creatorId);
  const existing = _blocked.get(id);
  if (existing) {
    // Idempotent: update reason if a new one was given, else no-op.
    if (reason && reason !== existing.reason) {
      _blocked.set(id, { ...existing, reason });
      await _persist();
      return { added: false, updated: true };
    }
    return { added: false, updated: false };
  }
  _blocked.set(id, {
    reason: reason || '',
    addedAt: new Date().toISOString(),
  });
  await _persist();
  log.info('CreatorBlocklist', `Blocked ${id} (reason: ${reason || '<none>'})`);
  return { added: true, updated: false };
}

async function remove(creatorId) {
  if (!creatorId) throw new Error('creatorId required');
  const id = String(creatorId);
  if (!_blocked.has(id)) return { removed: false };
  _blocked.delete(id);
  await _persist();
  log.info('CreatorBlocklist', `Unblocked ${id}`);
  return { removed: true };
}

// Test hook — bypass the timer.
async function __refresh() {
  try {
    const stored = await db.loadKV(KV_KEY);
    _hydrate(stored && stored.entries);
  } catch (_) {}
}

// Test hook — let unit tests inject state without a real DB.
function __setForTest(entries) {
  _hydrate(entries);
  _initialized = true;
}

module.exports = {
  restoreFromPersistence,
  isBlocked,
  getEntry,
  list,
  add,
  remove,
  __refresh,
  __setForTest,
};
