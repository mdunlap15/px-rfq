// LAST-KNOWN-GOOD STATE SNAPSHOTS for a DB-down boot (2026-10-03 outage).
//
// A restart while Supabase was unreachable booted with an EMPTY creator
// blocklist and NO runtime overrides, because both live only in kv_store.
// Two fallbacks, read ONLY when the DB load fails at boot and superseded the
// moment a real DB load succeeds:
//
//  1. A JSON snapshot file per state under STATE_SNAPSHOT_DIR, rewritten after
//     every successful DB load / persist. Automatic and always current — but
//     ONLY useful when STATE_SNAPSHOT_DIR is on a Railway VOLUME (mount one,
//     e.g. at /data, and set STATE_SNAPSHOT_DIR=/data). The container's own
//     filesystem (incl. /tmp) is wiped on every deploy/restart, so without a
//     volume this layer is a no-op by design (unset = disabled). Trade-off: a
//     Railway service with a volume cannot do overlapping zero-downtime
//     deploys — each deploy has a few seconds of downtime while the volume is
//     re-attached.
//
//  2. Operator-maintained env vars (CREATOR_BLOCKLIST_FALLBACK,
//     RUNTIME_CONFIG_FALLBACK) — see the owning modules. Survive anything,
//     but are only as fresh as the operator keeps them (a Railway env edit
//     restarts the trader, so update them off-peak).
//
// Never throws; every failure degrades to "no snapshot".

'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

function _dir() {
  const d = process.env.STATE_SNAPSHOT_DIR;
  return d && String(d).trim() ? String(d).trim() : null;
}

function _file(name) {
  const d = _dir();
  if (!d) return null;
  return path.join(d, `px-rfq-${String(name).replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function enabled() { return !!_dir(); }

/** Write { savedAt, data } atomically (tmp + rename). Returns true on success. */
function write(name, data) {
  const f = _file(name);
  if (!f) return false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), data }));
    fs.renameSync(tmp, f);
    return true;
  } catch (err) {
    if (!write._warned) {
      log.warn('Snapshot', `state snapshot write failed (${f}): ${err.message}`);
      write._warned = true;
    }
    return false;
  }
}

/** Returns { savedAt, data } or null. */
function read(name) {
  const f = _file(name);
  if (!f) return null;
  try {
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) return null;
    return parsed;
  } catch (err) {
    log.warn('Snapshot', `state snapshot read failed (${f}): ${err.message}`);
    return null;
  }
}

module.exports = { enabled, write, read };
