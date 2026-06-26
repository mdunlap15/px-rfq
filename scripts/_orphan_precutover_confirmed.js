/**
 * Backfill: orphan the pre-cutover stuck-'confirmed' parlay_orders backlog.
 *
 * BACKGROUND (investigated 2026-06-26):
 *   The CFTC migration on 2026-06-16 moved the SP to a fresh production
 *   account (cash.api.prophetx.co). PX's /parlay/sp/orders/ feed only
 *   contains orders from the cutover forward — every pre-cutover order
 *   404s on a direct GET and is absent from the paginated feed. The
 *   reconcile pipeline (fullPxReconcile / pollOrderSettlements /
 *   reconcileGhostConfirmed) is PX-feed-driven, so once the cutover wiped
 *   these orders from the feed, ~1,346 rows that were still 'confirmed'
 *   could never be settled — they only ever get meta.phantom flagged while
 *   status stays 'confirmed', inflating DB-status-based open-risk reports.
 *
 *   Their settlement is UNRECOVERABLE:
 *     - PX has no record post-migration (direct GET 404).
 *     - Stored pricing is unreliable: 1,296/1,346 carry confirmed_odds in
 *       positive/bettor-side convention (≈ offered_odds), so deriving P&L
 *       would inject ~$2.26M of garbage into a ledger that currently
 *       reconciles to PX. Leg-inference outcomes are also biased.
 *
 *   DECISION (operator, 2026-06-26): close/orphan them. Set a terminal
 *   non-settled status that drops out of both P&L (queries filter
 *   like('status','settled_%')) AND open-risk/positions (status!='confirmed'),
 *   WITHOUT fabricating settlement P&L. 'orphaned' is the established
 *   terminal status (see memory pnl-reconciliation-phantom-rows) — it is
 *   also excluded from loadOrders()'s STATUSES list, so orphaned rows never
 *   reload into the tracker on restart.
 *
 * SAFETY:
 *   - DRY-RUN by default. Pass --apply to write.
 *   - Backs up every full candidate row to a timestamped JSON before writing.
 *   - Only orphans confirmed_at < CUTOFF (2026-06-16) AND absent from the
 *     live PX feed — double-gated so a transient feed hiccup can never
 *     orphan a genuinely-open recent position.
 *   - Idempotent: only touches status='confirmed'; re-runs are no-ops once
 *     orphaned. Per-row UPDATE (status + meta only) — never an upsert that
 *     could clobber other columns.
 *   - To restore: set status back to meta.origStatus for the orphaned ids.
 *
 * DURABILITY: the db.saveOrder guard (shipped alongside this) blocks the
 *   live tracker from reverting an orphaned row back to 'confirmed'. Deploy
 *   that guard before --apply so the running instance can't undo the write.
 *
 * Usage:
 *   node scripts/_orphan_precutover_confirmed.js            # dry-run
 *   node scripts/_orphan_precutover_confirmed.js --apply    # write
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const px = require('../services/prophetx');
const { createClient } = require('@supabase/supabase-js');
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const APPLY = process.argv.includes('--apply');
const CUTOFF_ISO = '2026-06-16T00:00:00.000Z';   // CFTC migration boundary
const CUTOFF_MS = Date.parse(CUTOFF_ISO);

function ts(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v); return Number.isNaN(t) ? null : t;
}

// Mirror reconcileSettlements leg-derivation — for a forensic outcome label
// only. Does NOT drive status or P&L (orphaned rows carry no P&L).
function deriveResult(row) {
  const legsA = Array.isArray(row.legs) ? row.legs : [];
  const legsB = Array.isArray(row.meta?.legs) ? row.meta.legs : [];
  const primary = legsA.length >= legsB.length ? legsA : legsB;
  if (primary.length === 0) return { result: 'undetermined', coverage: '0/0' };
  const statuses = [];
  for (let i = 0; i < primary.length; i++) {
    const p = primary[i];
    const lid = p.lineId || p.line_id, tm = p.team || p.teamName;
    let st = null;
    for (const src of [legsA, legsB]) {
      let l = src[i];
      if (!l || ((l.lineId || l.line_id) !== lid && (l.team || l.teamName) !== tm)) {
        l = src.find(x => (x.lineId || x.line_id) === lid) || src.find(x => (x.team || x.teamName) === tm) || src[i];
      }
      const s = l && (l.settlementStatus || l.settlement_status);
      if (s) { st = s; break; }
    }
    if (!st) for (const src of [legsA, legsB]) { const l = src[i]; if (l && l.inferredResult) { st = l.inferredResult; break; } }
    if (st) statuses.push(st);
  }
  const cov = `${statuses.length}/${primary.length}`;
  const full = statuses.length === primary.length && statuses.length > 0;
  if (statuses.some(s => s === 'lost')) return { result: 'won', coverage: cov };
  if (full && statuses.every(s => s === 'won')) return { result: 'lost', coverage: cov };
  if (full && statuses.every(s => s === 'push' || s === 'void')) return { result: 'push', coverage: cov };
  return { result: 'undetermined', coverage: cov };
}

async function loadConfirmed() {
  const rows = []; const PAGE = 1000; let off = 0;
  while (true) {
    const { data, error } = await supa.from('parlay_orders')
      .select('*').eq('status', 'confirmed')
      .order('confirmed_at', { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw new Error(`load confirmed @${off}: ${error.message}`);
    if (!data || !data.length) break;
    rows.push(...data); if (data.length < PAGE) break; off += PAGE;
  }
  return rows;
}

(async () => {
  console.log(`=== Orphan pre-cutover stuck-'confirmed' backlog ===`);
  console.log(`MODE: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  const confirmed = await loadConfirmed();
  const pxOrders = await px.fetchOrders(12000);
  const pxByUuid = new Set(pxOrders.map(o => o.order_uuid).filter(Boolean));
  const pxByPid = new Set(pxOrders.map(o => o.p_id || o.parlay_id).filter(Boolean));
  console.log(`Loaded ${confirmed.length} confirmed rows; PX feed has ${pxOrders.length} orders.`);

  // Candidate = confirmed_at < CUTOFF AND absent from PX feed (double-gated).
  const candidates = [];
  const inFeedButOld = [];      // shouldn't happen — assert
  const recentKept = [];        // post-cutover, left alone
  for (const r of confirmed) {
    const t = ts(r.confirmed_at);
    const inFeed = (r.order_uuid && pxByUuid.has(r.order_uuid)) || pxByPid.has(r.parlay_id);
    const preCutover = t != null && t < CUTOFF_MS;
    if (preCutover && !inFeed) candidates.push(r);
    else if (preCutover && inFeed) inFeedButOld.push(r);
    else recentKept.push(r);
  }

  console.log(`\nCandidates to orphan (pre-cutover & not in PX feed): ${candidates.length}`);
  console.log(`Left untouched (post-cutover / in PX feed)         : ${recentKept.length}`);
  if (inFeedButOld.length) {
    console.log(`⚠ pre-cutover BUT present in PX feed (SKIPPED, investigate): ${inFeedButOld.length}`);
    console.log('   ', inFeedButOld.slice(0, 5).map(r => r.parlay_id).join(', '));
  }
  if (candidates.length === 0) { console.log('\nNothing to do.'); process.exit(0); }

  // Forensic outcome distribution + stake (P&L is NOT booked — informational).
  const dist = { won: 0, lost: 0, push: 0, undetermined: 0 };
  let sumStake = 0, oldest = Infinity, newest = -Infinity;
  for (const r of candidates) {
    const d = deriveResult(r); dist[d.result]++;
    sumStake += Number(r.confirmed_stake || 0);
    const t = ts(r.confirmed_at); if (t != null) { oldest = Math.min(oldest, t); newest = Math.max(newest, t); }
  }
  console.log(`\nCandidate confirmed_at range : ${new Date(oldest).toISOString()} -> ${new Date(newest).toISOString()}`);
  console.log(`Candidate sum(confirmed_stake): $${sumStake.toFixed(2)} (NOT booked to P&L — orphaned rows carry no pnl)`);
  console.log(`Leg-inferred outcome labels  : ${JSON.stringify(dist)}  (forensic only, stored in meta)`);

  const sample = candidates.slice(0, 12).map(r => {
    const d = deriveResult(r);
    return { parlay_id: r.parlay_id, confirmed_at: r.confirmed_at, stake: r.confirmed_stake,
             leg_inferred: d.result, coverage: d.coverage, phantom: !!(r.meta && r.meta.phantom) };
  });
  console.log('\nSample candidates:'); console.table(sample);

  if (!APPLY) {
    fs.writeFileSync(__dirname + '/../_orphan_precutover_PREVIEW.json', JSON.stringify({
      generatedAt: new Date().toISOString(), candidateCount: candidates.length,
      sumStake, dist, range: [new Date(oldest).toISOString(), new Date(newest).toISOString()],
      sampleParlayIds: candidates.slice(0, 40).map(r => r.parlay_id), sample,
    }, null, 2));
    console.log('\nDRY-RUN complete. Wrote _orphan_precutover_PREVIEW.json. Re-run with --apply to write.');
    process.exit(0);
  }

  // ---- APPLY ----
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = __dirname + `/../_orphaned_precutover_backup_${stamp}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(candidates, null, 2));
  console.log(`\nBacked up ${candidates.length} full rows -> ${backupPath}`);

  const orphanedAt = new Date().toISOString();
  let done = 0, failed = 0, skipped = 0;
  for (const r of candidates) {
    // Idempotency guard (in case of partial prior run / race).
    if (r.status === 'orphaned' || (r.meta && r.meta.orphaned)) { skipped++; continue; }
    const d = deriveResult(r);
    const meta = {
      ...(r.meta || {}),
      orphaned: true,
      origStatus: r.status,                       // 'confirmed'
      orphanReason: 'pre-cutover-px-wiped-2026-06-16',
      orphanedAt,
      orphanBackfill: '_orphan_precutover_confirmed',
      legInferredResult: d.result,                // forensic only
      legInferredCoverage: d.coverage,
    };
    const { error } = await supa.from('parlay_orders')
      .update({ status: 'orphaned', meta }).eq('parlay_id', r.parlay_id);
    if (error) { failed++; if (failed <= 5) console.log(`  FAIL ${r.parlay_id}: ${error.message}`); }
    else { done++; if (done % 200 === 0) console.log(`  ...${done}/${candidates.length}`); }
  }
  console.log(`\nApplied: ${done} orphaned, ${skipped} already-orphaned, ${failed} failed.`);

  // Verify post-state
  const { count: confCount } = await supa.from('parlay_orders').select('*', { count: 'exact', head: true }).eq('status', 'confirmed');
  const { count: orphCount } = await supa.from('parlay_orders').select('*', { count: 'exact', head: true }).eq('status', 'orphaned');
  console.log(`Post-state: status='confirmed' now ${confCount}, status='orphaned' now ${orphCount}.`);
  console.log(`Restore command if needed: set status=meta.origStatus for ids in ${backupPath}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('BACKFILL FAILED:', e.stack || e.message); process.exit(1); });
