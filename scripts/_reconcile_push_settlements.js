/**
 * Reconcile won-with-a-push parlay settlements against ProphetX.
 *
 * BACKGROUND (2026-09-27 pricing audit): 15 parlays whose surviving legs all WON
 * but one leg PUSHED are booked settled_push / pnl 0, and the audit asked whether
 * they should be reduced-odds bettor wins (our loss, ~$2,890 in total — $2,226 of
 * it on 01a09baf). The measured PX rule (services/parlay-settlement.js) says the
 * booking is right: all 15 contain a same-game group, and PX voids the WHOLE
 * parlay when a leg pushes in one (15/15), while the 191 won-with-a-push parlays
 * with no same-game group all settled 'lost' at a reduced payout (191/191). The
 * sixteenth id, 019f43af, is the opposite case: no same-game group, booked
 * -$747 (full risk) because no PX profit ever arrived; the rule prices it at
 * -$229.01. This script asks PX for the ground truth on all of them.
 *
 * WHAT IT DOES (dry-run by default)
 *   1. SELECTs the target rows from parlay_orders.
 *   2. Pages PX /parlay/sp/orders/ (GET only — the same call fullPxReconcile makes
 *      at every boot) and finds each order by order_uuid, then parlay_id.
 *   3. Prints, per row: ours (status/pnl), PX (settlement_status/profit), what the
 *      measured PX rule predicts, and the reduced-odds figure the audit assumed.
 *   4. CORRECTED = PX's own settlement_status + profit — PX's ledger is the cash.
 *      The rule and audit columns are context only and are NEVER written.
 *
 * WRITES happen only with --apply, and only for rows where PX's status/profit
 * differs from ours. A row PX reports settled but with NO profit on a non-refund
 * status is left alone (we do not write an estimate as if it were PX's number).
 *
 * GUARDS (explicit; NODE_ENV / NODE_TEST_CONTEXT are never consulted):
 *   - Writes are enabled by the literal argv flag --apply and nothing else.
 *   - Without it the Supabase client is wrapped so insert/update/upsert/delete THROW.
 *   - Does NOT require services/db or services/order-tracker, whose fire-and-forget
 *     saveOrder calls would write to production from a script.
 *   - --apply backs up every row it will touch to a JSON file first, then issues a
 *     per-row UPDATE of status / pnl / settlement_result / meta only (never an
 *     upsert), conditioned on the row's status being unchanged since the read.
 *   - A running trader holds these orders in memory. Its boot-time fullPxReconcile
 *     already applies "PX status + profit wins" to every order in PX's feed, so a
 *     row that still disagrees after many deploys is either missing from the feed
 *     or has no PX profit — expect this script to report 'none' for most rows.
 *
 * Usage:
 *   node scripts/_reconcile_push_settlements.js                   # dry-run, built-in ids
 *   node scripts/_reconcile_push_settlements.js --ids a,b,c       # dry-run, given ids
 *   node scripts/_reconcile_push_settlements.js --ids-file f.txt  # one id per line
 *   node scripts/_reconcile_push_settlements.js --apply           # write PX-authoritative fixes
 *   [--px-limit 12000] [--json out.json]
 */
const ps = require('../services/parlay-settlement');

// Won + push, same-game group in the parlay, booked settled_push / pnl 0.
const WON_WITH_PUSH_BOOKED_PUSH = [
  '019f4320-6e0c-7f20-b869-1621d201a44a',
  '019f5333-13d8-77fe-920b-4a9ea89b4f6d',
  '019f5779-ddf2-7813-a63b-2c78908aa1fc',
  '019f63f5-b789-7545-a10f-d365e0c60a32',
  '019f8a4d-f91c-7a68-8b8c-d47cb90c120d',
  '019fb274-cc26-77ac-ba2f-d482c90e7066',
  '019fb504-5d7c-7f09-aa22-2327af78ac4e',
  '019fb531-c3b7-774c-8a69-581b7d616801',
  '01a08721-4f67-74a1-b112-971ac057d5e9',
  '01a08889-b962-7076-a770-d342b204d5c1',
  '01a09112-25ab-72b0-996f-1ec1d76732c2',
  '01a09baf-119c-771d-9067-b31d2530dbbf',
  '01a09bc3-7cc2-790b-a6db-086ba26a4e69',
  '01a0b5cb-5f25-79e0-96dc-d75b03a18974',
  '01a0deab-5872-76af-9aa4-9f386bc18736',
];
// Won + push, NO same-game group, booked settled_lost at FULL risk with no PX profit.
const LOST_WITH_PUSH_FULL_STAKE = ['019f43af-76e0-7df0-9978-4335a547d8ab'];
const DEFAULT_IDS = [...WON_WITH_PUSH_BOOKED_PUSH, ...LOST_WITH_PUSH_FULL_STAKE];

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);
const round2 = x => Math.round(Number(x) * 100) / 100;
const num = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/** Supabase client whose write methods throw unless writes were explicitly allowed. */
function guardedClient(sb, allowWrites) {
  return {
    from(table) {
      const q = sb.from(table);
      if (allowWrites) return q;
      return new Proxy(q, {
        get(target, prop) {
          if (WRITE_METHODS.has(prop)) {
            return () => { throw new Error(`dry-run: refused ${String(prop)} on ${table} (pass --apply to write)`); };
          }
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
}

/** Our legs with PX's per-leg settlement_status overlaid by line_id. */
function mergedLegs(row, pxOrder) {
  const a = Array.isArray(row.legs) ? row.legs : [];
  const b = Array.isArray(row.meta?.legs) ? row.meta.legs : [];
  const ours = a.length >= b.length ? a : b;
  const pxLegs = Array.isArray(pxOrder?.legs) ? pxOrder.legs : [];
  return ours.map(l => {
    const p = pxLegs.find(x => x.line_id && x.line_id === (l.lineId || l.line_id));
    return p && p.settlement_status ? { ...l, settlementStatus: p.settlement_status, settlement_status: p.settlement_status } : l;
  });
}

/**
 * Decide what (if anything) to correct for one row. Pure — exported for tests.
 * action: 'none' | 'update' | 'px_missing' | 'px_not_settled' | 'px_no_profit'
 */
function planRow(row, pxOrder) {
  const legs = mergedLegs(row, pxOrder);
  const rule = ps.expectedPxSettlement(legs);
  const red = ps.reducedPayoutLoss({ legs, confirmedOdds: row.confirmed_odds, confirmedStake: row.confirmed_stake });
  const plan = {
    parlayId: row.parlay_id,
    ours: { status: row.status, pnl: num(row.pnl) },
    px: null,
    rule: { result: rule.result, basis: rule.basis, sameGame: rule.sameGame },
    // What the audit assumed: a bettor win at reduced odds.
    auditHypothesisPnl: red && red.voidLegs > 0 ? -red.loss : null,
    corrected: null,
    action: 'none',
  };
  if (!pxOrder) { plan.action = 'px_missing'; return plan; }
  const pxStatus = String(pxOrder.settlement_status || '').toLowerCase();
  const pxProfit = num(pxOrder.profit);
  plan.px = { status: pxStatus || null, profit: pxProfit, orderStatus: pxOrder.status || null };
  if (!['won', 'lost', 'push', 'void'].includes(pxStatus)) { plan.action = 'px_not_settled'; return plan; }
  // A refund carries no profit; any other terminal status must come with one.
  const pxPnl = pxProfit != null ? pxProfit : (pxStatus === 'push' || pxStatus === 'void' ? 0 : null);
  if (pxPnl == null) { plan.action = 'px_no_profit'; return plan; }
  plan.corrected = { status: `settled_${pxStatus}`, pnl: round2(pxPnl), settlementResult: pxStatus };
  const agrees = plan.corrected.status === plan.ours.status
    && plan.ours.pnl != null && Math.abs(plan.corrected.pnl - plan.ours.pnl) <= 0.01;
  plan.action = agrees ? 'none' : 'update';
  return plan;
}

function parseArgs(argv) {
  const out = { apply: argv.includes('--apply'), ids: null, pxLimit: 12000, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ids') out.ids = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--ids-file') out.idsFile = argv[++i];
    else if (argv[i] === '--px-limit') out.pxLimit = parseInt(argv[++i], 10) || out.pxLimit;
    else if (argv[i] === '--json') out.json = argv[++i];
  }
  return out;
}

async function main() {
  const fs = require('fs');
  const path = require('path');
  const args = parseArgs(process.argv.slice(2));
  let ids = args.ids;
  if (args.idsFile) ids = fs.readFileSync(args.idsFile, 'utf8').split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (!ids || !ids.length) ids = DEFAULT_IDS;

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
  const sb = guardedClient(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY), args.apply);
  const px = require('../services/prophetx'); // GET-only use below (fetchOrders)

  console.log(`=== Reconcile won-with-a-push settlements vs ProphetX ===`);
  console.log(`MODE: ${args.apply ? 'APPLY (will write PX-authoritative corrections)' : 'DRY-RUN (no writes)'} | ${ids.length} parlay ids\n`);

  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from('parlay_orders')
      .select('parlay_id,status,order_uuid,confirmed_stake,confirmed_odds,pnl,settlement_result,settled_at,legs,meta')
      .in('parlay_id', ids.slice(i, i + 100));
    if (error) throw new Error(`load parlay_orders: ${error.message}`);
    rows.push(...(data || []));
  }
  const missingRows = ids.filter(id => !rows.some(r => r.parlay_id === id));
  if (missingRows.length) console.log(`⚠ not in parlay_orders: ${missingRows.join(', ')}`);

  const pxOrders = await px.fetchOrders(args.pxLimit);
  if (!pxOrders.length) throw new Error('PX returned no orders — refusing to plan against an empty feed');
  const byUuid = new Map(), byPid = new Map();
  for (const o of pxOrders) {
    if (o.order_uuid) byUuid.set(o.order_uuid, o);
    const pid = o.p_id || o.parlay_id;
    if (pid && !byPid.has(pid)) byPid.set(pid, o);
  }
  console.log(`PX feed: ${pxOrders.length} orders\n`);

  const plans = rows.map(r => planRow(r, (r.order_uuid && byUuid.get(r.order_uuid)) || byPid.get(r.parlay_id) || null));
  const fmt = v => (v == null ? '-' : typeof v === 'number' ? v.toFixed(2) : String(v));
  console.table(plans.map(p => ({
    parlay: p.parlayId.slice(0, 13),
    ours: `${p.ours.status} ${fmt(p.ours.pnl)}`,
    px: p.px ? `${p.px.status || '-'} ${fmt(p.px.profit)}` : 'NOT FOUND',
    rule: `${p.rule.result || '-'} (${p.rule.basis})`,
    auditHyp: fmt(p.auditHypothesisPnl),
    corrected: p.corrected ? `${p.corrected.status} ${fmt(p.corrected.pnl)}` : '-',
    action: p.action,
  })));
  const tally = plans.reduce((a, p) => { a[p.action] = (a[p.action] || 0) + 1; return a; }, {});
  const delta = plans.filter(p => p.action === 'update').reduce((a, p) => a + (p.corrected.pnl - (p.ours.pnl || 0)), 0);
  console.log(`\nactions: ${JSON.stringify(tally)} | P&L change if applied: ${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`);
  const ruleBreaks = plans.filter(p => p.px && p.rule.result && p.px.status && p.rule.result !== (p.px.status === 'void' ? 'push' : p.px.status));
  if (ruleBreaks.length) console.log(`⚠ PX broke the measured rule on: ${ruleBreaks.map(p => p.parlayId).join(', ')} — update services/parlay-settlement.js`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ generatedAt: new Date().toISOString(), apply: args.apply, plans }, null, 2));

  const updates = plans.filter(p => p.action === 'update');
  if (!args.apply) { console.log('\nDRY-RUN complete — nothing written. Re-run with --apply to write the "update" rows.'); return; }
  if (!updates.length) { console.log('\nNothing to apply.'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', `_reconcile_push_backup_${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows.filter(r => updates.some(u => u.parlayId === r.parlay_id)), null, 2));
  console.log(`\nBacked up ${updates.length} rows -> ${backupPath}`);

  let ok = 0, failed = 0;
  for (const u of updates) {
    const row = rows.find(r => r.parlay_id === u.parlayId);
    const meta = {
      ...(row.meta || {}),
      pxProfit: u.corrected.pnl,
      settlementBasis: u.rule.basis,
      settlementReconciledAt: new Date().toISOString(),
      settlementReconciledBy: '_reconcile_push_settlements',
      settlementReconciledFrom: { status: row.status, pnl: num(row.pnl) },
    };
    delete meta.pnlSource;
    const { data, error } = await sb.from('parlay_orders')
      .update({ status: u.corrected.status, pnl: u.corrected.pnl, settlement_result: u.corrected.settlementResult, meta })
      .eq('parlay_id', u.parlayId).eq('status', row.status)
      .select('parlay_id');
    if (error || !data || !data.length) { failed++; console.log(`  FAIL ${u.parlayId}: ${error ? error.message : 'row changed since read — skipped'}`); }
    else { ok++; console.log(`  ${u.parlayId}: ${row.status} ${num(row.pnl)} -> ${u.corrected.status} ${u.corrected.pnl}`); }
  }
  console.log(`\nApplied ${ok}, failed/skipped ${failed}. Restart the trader (or let its next fullPxReconcile run) so its in-memory copy matches.`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => { console.error('RECONCILE FAILED:', e.stack || e.message); process.exit(1); });
}

module.exports = { planRow, mergedLegs, guardedClient, parseArgs, DEFAULT_IDS, WON_WITH_PUSH_BOOKED_PUSH, LOST_WITH_PUSH_FULL_STAKE };
