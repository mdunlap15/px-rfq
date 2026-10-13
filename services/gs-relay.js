/**
 * Soccer anytime-goalscorer fair relay (2026-10-13).
 *
 * Operator rule (same as the single-leg order book): fair YES = average of the
 * FanDuel and DraftKings anytime-goalscorer implied probabilities (probability
 * space) / 1.10. A YES leg's fair = fair_yes; a NO leg's fair = 1 - fair_yes.
 * Only players quoted by BOTH books.
 *
 * The order book's laptop scheduler (gs_auto) publishes
 *   kv_store['px_gs_fairs'] = {ts, fairs: {line_id: {player, side, fair_yes, no_ask, yes_ask, eid}}}
 * This module polls that row (one small kv read every GS_RELAY_POLL_SEC through
 * the DB breaker) and answers getFair(lineId). The side comes from the entry
 * (derived from PX's selection NAME by the publisher), never from outcome_id.
 *
 * FAIL CLOSED: no row, a row older than GS_RELAY_MAX_AGE_SEC (600), a missing
 * line, or an out-of-range fair => null => the pricer declines the leg.
 */
const log = require('./logger');

const KEY = 'px_gs_fairs';
let _row = null;          // { ts, fairs }
let _timer = null;
let _inflight = false;
const _stats = { polls: 0, pollErrors: 0, lastError: null, entries: 0, used: 0, declined: 0 };

function enabled() { return process.env.GS_RELAY_ENABLED !== 'false'; }
function maxAgeSec() { return Number(process.env.GS_RELAY_MAX_AGE_SEC) || 600; }
// Leg margin (operator 2026-10-13: "Use the same 10% YES margin in the RFQ feed"),
// matching the single-leg board (gs_auto/gs_lib.py):
//   bettor takes YES (we hold NO): offered = GS_BOOK_MARGIN * fair_yes (= the books' avg YES)
//   bettor takes NO  (we hold YES): offered = 1 - fair_yes / (1 + GS_LEG_YES_EV)
function bookMargin() { const v = Number(process.env.GS_BOOK_MARGIN); return v > 0 ? v : 1.10; }
function legYesEv() { const r = process.env.GS_LEG_YES_EV; const v = Number(r); return (r != null && r !== '' && Number.isFinite(v) && v >= 0) ? v : 0.10; }
function clampP(p) { return Math.min(0.999, Math.max(0.001, p)); }
function offeredProb(fairYes, side) {
  if (side === 'yes') return clampP(fairYes * bookMargin());
  if (side === 'no') return clampP(1 - fairYes / (1 + legYesEv()));
  return null;
}

function _tsSec(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts > 1e12 ? ts / 1000 : ts;
  const n = Number(ts);
  if (Number.isFinite(n)) return n > 1e12 ? n / 1000 : n;
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p / 1000 : NaN;
}

/**
 * { ok:true, fair, side, player, eid, ageSec } or { ok:false, reason }.
 */
function getFair(lineId, nowMs = Date.now()) {
  if (!enabled()) return { ok: false, reason: 'gs_relay_disabled' };
  if (!_row || typeof _row !== 'object' || !_row.fairs) return { ok: false, reason: 'gs_relay_missing' };
  const ts = _tsSec(_row.ts);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'gs_relay_no_ts' };
  const age = nowMs / 1000 - ts;
  if (age > maxAgeSec() || age < -120) return { ok: false, reason: 'gs_relay_stale', detail: `${Math.round(age)}s old` };
  const e = _row.fairs[lineId];
  if (!e || typeof e !== 'object') return { ok: false, reason: 'gs_line_unpriced' };
  const fy = Number(e.fair_yes);
  if (!(fy > 0 && fy < 1)) return { ok: false, reason: 'gs_bad_fair' };
  const side = String(e.side || '').trim().toLowerCase();
  let fair;
  if (side === 'yes') fair = fy;
  else if (side === 'no') fair = 1 - fy;
  else return { ok: false, reason: 'gs_bad_side', detail: String(e.side) };
  const offered = offeredProb(fy, side);
  return { ok: true, fair, offered, side, player: e.player || null, eid: e.eid != null ? String(e.eid) : null, ageSec: Math.max(0, Math.round(age)) };
}

function isGoalscorerLine(li) {
  if (!li) return false;
  const s = String(li.sport || li.oddsApiSport || '');
  if (!(s === 'soccer' || s.startsWith('soccer_'))) return false;
  return li.marketType === 'player_goalscorer';
}

async function poll() {
  if (_inflight) return;
  _inflight = true;
  try {
    const db = require('./db');
    if (!db.isAvailable || !db.isAvailable()) return;
    const client = db.getClient();
    if (!client) return;
    const r = await client.from('kv_store').select('value').eq('key', KEY).maybeSingle();
    _stats.polls++;
    if (r.error) throw new Error(r.error.message);
    const v = r.data && r.data.value;
    if (v && typeof v === 'object') { _row = v; _stats.entries = v.fairs ? Object.keys(v.fairs).length : 0; }
    else { _row = null; _stats.entries = 0; }
  } catch (e) {
    _stats.pollErrors++; _stats.lastError = e.message;
  } finally {
    _inflight = false;
  }
}

function start() {
  if (_timer) return;
  const sec = Math.max(10, Number(process.env.GS_RELAY_POLL_SEC) || 30);
  poll().catch(() => {});
  _timer = setInterval(() => poll().catch(() => {}), sec * 1000);
  if (_timer.unref) _timer.unref();
  log.info('GsRelay', `polling kv ${KEY} every ${sec}s (max age ${maxAgeSec()}s)`);
}

function getStatus() {
  const ts = _row ? _tsSec(_row.ts) : NaN;
  return { enabled: enabled(), key: KEY, entries: _stats.entries, ageSec: Number.isFinite(ts) ? Math.round(Date.now() / 1000 - ts) : null, ..._stats };
}

function noteUsed() { _stats.used++; }
function noteDeclined() { _stats.declined++; }
function __setForTest(row) { _row = row; }

module.exports = { KEY, getFair, offeredProb, isGoalscorerLine, poll, start, getStatus, noteUsed, noteDeclined, __setForTest };
