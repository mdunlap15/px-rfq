/**
 * Estimate fair values for the fills restored after the 2026-09-25 Supabase outage.
 *
 * BACKGROUND: scripts/_restore_outage_fills_2026-09-25.js re-inserted 34 fills PX
 * booked while our writes were failing (~07:00-16:30 UTC). They were rebuilt from
 * PX + line_cache, so they carry NO meta.fairParlayProb / offeredImpliedProb and
 * no per-leg fairProb — every calibration and expected-profit view drops them,
 * although they hold -$10.7K of P&L (incl. the 9/25 CFB blowout same-game losses).
 *
 * METHOD (per restored row, dry-run by default):
 *   - leg fairProb   = fairProb of the SAME lineId on the quote NEAREST IN TIME to
 *                      the fill (parlay_orders.quoted_at, either side, within
 *                      --window-hours). Quotes during the outage were not persisted
 *                      either, so the nearest quote is often hours away — the gap
 *                      is recorded per leg and surfaced in the table.
 *   - same-game fair = a group of legs on one PX event was priced with a
 *                      correlation factor, not as independent legs. It is taken
 *                      from the nearest quote holding exactly that group (its
 *                      fairParlayProb / product of its leg fairs). No such quote ->
 *                      leg fairs are still written but fairParlayProb is NOT.
 *   - offeredImpliedProb = exact, from confirmed_odds (SP-side; bettor = -odds).
 *   Marks meta.fairEstimated=true, meta.fairEstimateSource, per-leg fairEstimated,
 *   and the gaps, so every consumer can tell an estimate from a quote-time fair.
 *
 * GUARDS (explicit; NODE_ENV / NODE_TEST_CONTEXT are never consulted):
 *   - Writes only with the literal argv flag --apply; otherwise the Supabase client
 *     is wrapped so insert/update/upsert/delete THROW.
 *   - Does NOT require services/db or services/order-tracker (fire-and-forget writes).
 *   - --apply backs up every row first, then a per-row UPDATE of legs / meta /
 *     fair_parlay_prob only (never an upsert), and only on rows still lacking a
 *     quote-time fair. Rows already estimated are skipped unless --recompute.
 *   - The running trader holds these orders in memory; if it re-saves one before
 *     its next restart it can overwrite the estimate. Re-run the dry-run after the
 *     next deploy: rows that kept their estimate report 'already_estimated'.
 *
 * Usage:
 *   node scripts/_estimate_restored_fairs.js                  # dry-run on restoredFrom='px-outage-2026-09-25'
 *   node scripts/_estimate_restored_fairs.js --ids a,b        # dry-run on given ids
 *   node scripts/_estimate_restored_fairs.js --apply          # write
 *   [--window-hours 36] [--recompute] [--json out.json]
 */
const RESTORED_FROM = 'px-outage-2026-09-25';
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);
const HOUR = 3600e3;

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

/** Bettor-side implied prob of our SP-side confirmed odds (SP -596 = bettor +596). */
function offeredProbFromConfirmedOdds(confirmedOdds) {
  const b = -Number(confirmedOdds);
  if (!Number.isFinite(b) || Math.abs(b) < 100) return null;
  const dec = b > 0 ? 1 + b / 100 : 1 + 100 / -b;
  return Math.round((1 / dec) * 100000) / 100000;
}

const rowLegs = r => {
  const a = Array.isArray(r.legs) ? r.legs : [];
  const b = Array.isArray(r.meta?.legs) ? r.meta.legs : [];
  return a.length >= b.length ? a : b;
};
const okProb = p => Number.isFinite(Number(p)) && p > 0 && p < 1;
const tsMs = v => (v ? Date.parse(v) : NaN);

/** Groups of legs sharing a PX event, keyed by event id -> sorted lineIds. */
function sameGameGroups(legs) {
  const by = new Map();
  for (const l of legs) {
    const ev = l.pxEventId ?? l.sport_event_id;
    if (ev == null) continue;
    if (!by.has(String(ev))) by.set(String(ev), []);
    by.get(String(ev)).push(l.lineId || l.line_id);
  }
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([ev, ids]) => ({ ev, lineIds: ids.slice().sort() }));
}

/**
 * Nearest usable fair for one lineId among candidate quote rows. Skips the fill
 * itself, other estimates, and legs without a usable fairProb. Pure — exported.
 */
function nearestLegFair(lineId, tMs, candidates, excludeIds = new Set()) {
  let best = null;
  for (const r of candidates) {
    if (excludeIds.has(r.parlay_id) || r.meta?.fairEstimated || r.meta?.pxBackfill) continue;
    const q = tsMs(r.quoted_at);
    if (!Number.isFinite(q)) continue;
    const l = rowLegs(r).find(x => (x.lineId || x.line_id) === lineId && !x.fairEstimated && okProb(x.fairProb));
    if (!l) continue;
    const gap = Math.abs(q - tMs);
    if (!best || gap < best.gapMs) best = { fairProb: Number(l.fairProb), parlayId: r.parlay_id, quotedAt: r.quoted_at, gapMs: gap };
  }
  return best;
}

/**
 * Nearest quote whose ONLY same-game group is exactly `group` -> its fair-side
 * multiplier (fairParlayProb / product of its leg fairs). Pure — exported.
 */
function nearestGroupFactor(group, tMs, candidates, excludeIds = new Set()) {
  let best = null;
  for (const r of candidates) {
    if (excludeIds.has(r.parlay_id) || r.meta?.fairEstimated || r.meta?.pxBackfill) continue;
    const legs = rowLegs(r);
    const groups = sameGameGroups(legs);
    if (groups.length !== 1 || groups[0].lineIds.join('|') !== group.lineIds.join('|')) continue;
    const fp = Number(r.meta?.fairParlayProb ?? r.fair_parlay_prob);
    if (!okProb(fp) || !legs.every(l => okProb(l.fairProb))) continue;
    const factor = fp / legs.reduce((a, l) => a * Number(l.fairProb), 1);
    const q = tsMs(r.quoted_at);
    if (!Number.isFinite(q) || !(factor > 0)) continue;
    const gap = Math.abs(q - tMs);
    if (!best || gap < best.gapMs) best = { factor, parlayId: r.parlay_id, quotedAt: r.quoted_at, gapMs: gap };
  }
  return best;
}

/** Build the estimate for one restored row from pre-fetched candidates. Pure — exported. */
function buildEstimate(row, legCandidates, groupCandidates) {
  const tMs = tsMs(row.confirmed_at);
  const exclude = new Set([row.parlay_id]);
  const legs = rowLegs(row);
  const missing = [];
  const outLegs = legs.map(l => {
    const id = l.lineId || l.line_id;
    const hit = nearestLegFair(id, tMs, legCandidates[id] || [], exclude);
    if (!hit) { missing.push(id); return { ...l }; }
    return {
      ...l,
      fairProb: Math.round(hit.fairProb * 10000) / 10000,
      fairEstimated: true,
      fairEstimateFrom: { parlayId: hit.parlayId, quotedAt: hit.quotedAt, gapMin: Math.round(hit.gapMs / 60000) },
    };
  });
  const groups = sameGameGroups(legs).map(g => {
    const hit = nearestGroupFactor(g, tMs, groupCandidates[g.lineIds.join('|')] || [], exclude);
    return { ev: g.ev, lineIds: g.lineIds, factor: hit ? Math.round(hit.factor * 10000) / 10000 : null,
      from: hit ? { parlayId: hit.parlayId, quotedAt: hit.quotedAt, gapMin: Math.round(hit.gapMs / 60000) } : null };
  });
  const allLegs = missing.length === 0;
  const allGroups = groups.every(g => g.factor != null);
  let fairParlayProb = null;
  if (allLegs && allGroups) {
    const p = outLegs.reduce((a, l) => a * l.fairProb, 1) * groups.reduce((a, g) => a * g.factor, 1);
    fairParlayProb = Math.round(Math.max(0.001, Math.min(0.99, p)) * 100000) / 100000;
  }
  const gaps = outLegs.filter(l => l.fairEstimateFrom).map(l => l.fairEstimateFrom.gapMin)
    .concat(groups.filter(g => g.from).map(g => g.from.gapMin));
  return {
    parlayId: row.parlay_id,
    legs: outLegs,
    groups,
    missingLegs: missing,
    fairParlayProb,
    offeredImpliedProb: offeredProbFromConfirmedOdds(row.confirmed_odds),
    maxGapMin: gaps.length ? Math.max(...gaps) : null,
    status: !allLegs ? 'partial_missing_legs' : !allGroups ? 'partial_missing_sgp_factor' : 'complete',
  };
}

// Quotes whose legs contain ALL of lineIds (jsonb containment, server-side), the
// nearest few on each side of tMs within the window. SELECT only.
async function fetchCandidates(sb, lineIds, tMs, windowHours) {
  const lo = new Date(tMs - windowHours * HOUR).toISOString();
  const hi = new Date(tMs + windowHours * HOUR).toISOString();
  const t = new Date(tMs).toISOString();
  const filt = JSON.stringify(lineIds.map(lineId => ({ lineId })));
  const sel = 'parlay_id,status,quoted_at,fair_parlay_prob,legs,meta';
  const before = await sb.from('parlay_orders').select(sel).contains('legs', filt)
    .gte('quoted_at', lo).lte('quoted_at', t).order('quoted_at', { ascending: false }).limit(10);
  if (before.error) throw new Error(`candidate query (before) for ${lineIds.join('+')}: ${before.error.message}`);
  const after = await sb.from('parlay_orders').select(sel).contains('legs', filt)
    .gte('quoted_at', t).lte('quoted_at', hi).order('quoted_at', { ascending: true }).limit(10);
  if (after.error) throw new Error(`candidate query (after) for ${lineIds.join('+')}: ${after.error.message}`);
  return [...(before.data || []), ...(after.data || [])];
}

function parseArgs(argv) {
  const out = { apply: argv.includes('--apply'), recompute: argv.includes('--recompute'), ids: null, windowHours: 36, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ids') out.ids = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--window-hours') out.windowHours = Number(argv[++i]) || out.windowHours;
    else if (argv[i] === '--json') out.json = argv[++i];
  }
  return out;
}

async function main() {
  const fs = require('fs');
  const path = require('path');
  const args = parseArgs(process.argv.slice(2));
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
  const sb = guardedClient(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY), args.apply);

  console.log(`=== Estimate fairs for restored outage fills ===`);
  console.log(`MODE: ${args.apply ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} | window ±${args.windowHours}h\n`);

  const sel = 'parlay_id,status,confirmed_at,confirmed_odds,confirmed_stake,pnl,fair_parlay_prob,legs,meta';
  let q = sb.from('parlay_orders').select(sel);
  q = args.ids ? q.in('parlay_id', args.ids) : q.eq('meta->>restoredFrom', RESTORED_FROM);
  const { data: rows, error } = await q;
  if (error) throw new Error(`load restored rows: ${error.message}`);
  const targets = [], skipped = [];
  for (const r of rows || []) {
    if (r.meta?.fairEstimated && !args.recompute) skipped.push([r.parlay_id, 'already_estimated']);
    else if (!r.meta?.fairEstimated && okProb(r.meta?.fairParlayProb)) skipped.push([r.parlay_id, 'has_quote_time_fair']);
    else if (!Number.isFinite(tsMs(r.confirmed_at))) skipped.push([r.parlay_id, 'no_confirmed_at']);
    else targets.push(r);
  }
  console.log(`rows: ${(rows || []).length} | to estimate: ${targets.length} | skipped: ${skipped.length}`);
  skipped.forEach(([id, why]) => console.log(`  skip ${id} (${why})`));

  // Candidate quotes per lineId and per same-game group, fetched once each.
  const legCandidates = {}, groupCandidates = {};
  for (const r of targets) {
    const tMs = tsMs(r.confirmed_at);
    const legs = rowLegs(r);
    for (const l of legs) {
      const id = l.lineId || l.line_id;
      if (!id) continue;
      const got = await fetchCandidates(sb, [id], tMs, args.windowHours);
      legCandidates[id] = (legCandidates[id] || []).concat(got);
    }
    // A same-game group's factor needs a quote holding ALL of its legs.
    for (const g of sameGameGroups(legs)) {
      const key = g.lineIds.join('|');
      const got = await fetchCandidates(sb, g.lineIds, tMs, args.windowHours);
      groupCandidates[key] = (groupCandidates[key] || []).concat(got);
    }
  }

  const plans = targets.map(r => ({ row: r, est: buildEstimate(r, legCandidates, groupCandidates) }));
  console.table(plans.map(({ row, est }) => ({
    parlay: row.parlay_id.slice(0, 13),
    status: row.status,
    risk: Number(row.confirmed_stake).toFixed(0),
    pnl: row.pnl == null ? '-' : Number(row.pnl).toFixed(0),
    legs: `${est.legs.length - est.missingLegs.length}/${est.legs.length}`,
    sgp: est.groups.length ? est.groups.map(g => (g.factor == null ? '?' : g.factor.toFixed(3))).join(',') : '-',
    fairEst: est.fairParlayProb == null ? '-' : est.fairParlayProb.toFixed(4),
    offered: est.offeredImpliedProb == null ? '-' : est.offeredImpliedProb.toFixed(4),
    maxGapMin: est.maxGapMin ?? '-',
    result: est.status,
  })));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ generatedAt: new Date().toISOString(), plans: plans.map(p => p.est) }, null, 2));

  if (!args.apply) { console.log('\nDRY-RUN complete — nothing written. Re-run with --apply to write.'); return; }
  const writable = plans.filter(p => p.est.legs.some(l => l.fairEstimated));
  if (!writable.length) { console.log('\nNothing to apply.'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', `_estimate_restored_fairs_backup_${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(writable.map(p => p.row), null, 2));
  console.log(`\nBacked up ${writable.length} rows -> ${backupPath}`);

  let ok = 0, failed = 0;
  for (const { row, est } of writable) {
    const meta = {
      ...(row.meta || {}),
      legs: est.legs,
      fairEstimated: true,
      fairEstimateSource: 'nearest_quote_same_lineId',
      fairEstimateStatus: est.status,
      fairEstimateMaxGapMin: est.maxGapMin,
      fairEstimateSgpFactors: est.groups,
      fairEstimatedAt: new Date().toISOString(),
      offeredImpliedProb: est.offeredImpliedProb,
      offeredImpliedProbSource: 'confirmed_odds',
    };
    if (est.fairParlayProb != null) meta.fairParlayProb = est.fairParlayProb;
    const patch = { legs: est.legs, meta };
    if (est.fairParlayProb != null) patch.fair_parlay_prob = est.fairParlayProb;
    let upd = sb.from('parlay_orders').update(patch).eq('parlay_id', row.parlay_id);
    // Never overwrite a quote-time fair that appeared since the read.
    upd = row.meta?.fairEstimated ? upd : upd.is('fair_parlay_prob', null);
    const { data, error } = await upd.select('parlay_id');
    if (error || !data || !data.length) { failed++; console.log(`  FAIL ${row.parlay_id}: ${error ? error.message : 'row changed since read — skipped'}`); }
    else { ok++; }
  }
  console.log(`\nApplied ${ok}, failed/skipped ${failed}.`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => { console.error('ESTIMATE FAILED:', e.stack || e.message); process.exit(1); });
}

module.exports = { buildEstimate, nearestLegFair, nearestGroupFactor, sameGameGroups, offeredProbFromConfirmedOdds, guardedClient, parseArgs, RESTORED_FROM };
