// Backfill creator_id onto every parlay_orders row by walking PX's
// /parlay/sp/orders/ REST endpoint.
//
// PX exposes creator_id (the only counterparty identifier) on RFQ events
// AND on REST order responses. We started capturing it on RFQ payloads on
// 2026-05-19, but every historical parlay_orders row is missing it because
// we previously dropped the field in handleRFQ. This script walks PX's
// full order history (px.fetchOrders handles token pagination internally)
// and writes meta.creatorId onto every parlay_orders row where it's
// currently absent, so per-counterparty P&L / sharp-detection analytics
// cover the full dataset, not just orders quoted after the deploy.
//
// Match key: PX's p_id maps to our parlay_orders.parlay_id (stable across
// confirm/settle events).
//
// Idempotent: rows that already have meta.creatorId are skipped.
//
// Usage:
//   node scripts/_backfill_creator_ids.js [--limit N] [--dry-run]
//
// Defaults to 50,000 PX orders — covers many months of history.

require('dotenv').config();
const px = require('../services/prophetx');
const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT_IDX = args.indexOf('--limit');
const LIMIT = LIMIT_IDX >= 0 ? parseInt(args[LIMIT_IDX + 1]) || 50000 : 50000;

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  await px.login();

  console.log(`Backfill plan: walk up to ${LIMIT.toLocaleString()} PX orders${DRY_RUN ? ' (DRY-RUN)' : ''}`);

  // 1. Pull PX orders. fetchOrders handles token-based pagination and returns
  // the union of all pages up to `limit`.
  console.log('Fetching PX orders (may take ~30-60s for large limits)...');
  const startedAt = Date.now();
  const orders = await px.fetchOrders(LIMIT);
  console.log(`  fetched ${orders.length.toLocaleString()} PX orders in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  // Build parlay_id → creator_id. PX returns the same p_id multiple times
  // (one row per status change: quoted, confirmed, settled), so collapse to
  // the unique set. creator_id is identical across all rows for a given p_id.
  const creatorByParlay = new Map();
  let withCreator = 0;
  for (const o of orders) {
    const pid = o.p_id || o.parlay_id;
    const cid = o.creator_id;
    if (pid && cid) {
      if (!creatorByParlay.has(pid)) {
        creatorByParlay.set(pid, cid);
        withCreator++;
      }
    }
  }
  console.log(`  ${creatorByParlay.size.toLocaleString()} unique parlay→creator pairs (${withCreator.toLocaleString()} with creator_id populated)`);

  if (creatorByParlay.size === 0) {
    console.log('No data to backfill. Exiting.');
    return;
  }

  // 2. For each chunk, fetch matching parlay_orders rows and decide which need updates.
  const parlayIds = Array.from(creatorByParlay.keys());
  // Smaller chunk size — Supabase's .in() with UUIDs hits URL length / socket
  // timeout issues around 200+ values. 100 is well under the safe ceiling.
  const CHUNK = 100;
  let scanned = 0, alreadyHad = 0, missingInDb = 0;
  const updates = [];

  for (let i = 0; i < parlayIds.length; i += CHUNK) {
    const slice = parlayIds.slice(i, i + CHUNK);
    // Retry on transient network failures (Supabase free-tier sockets drop
    // intermittently). Three attempts with backoff before giving up.
    let rows = null, error = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await sb.from('parlay_orders')
        .select('parlay_id, meta')
        .in('parlay_id', slice)
        .then(r => r, e => ({ error: e }));
      if (!result.error) { rows = result.data; error = null; break; }
      error = result.error;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
    if (error) {
      console.warn(`  chunk ${Math.floor(i / CHUNK)} read failed after 3 attempts: ${error.message}`);
      continue;
    }
    const foundIds = new Set((rows || []).map(r => r.parlay_id));
    for (const pid of slice) if (!foundIds.has(pid)) missingInDb++;

    for (const row of rows || []) {
      scanned++;
      const cid = creatorByParlay.get(row.parlay_id);
      if (!cid) continue;
      const existing = row.meta && (row.meta.creatorId || row.meta.creator_id);
      if (existing) { alreadyHad++; continue; }
      const newMeta = { ...(row.meta || {}), creatorId: cid };
      updates.push({ parlay_id: row.parlay_id, meta: newMeta });
    }
  }
  console.log(`\nDB scan:`);
  console.log(`  ${scanned.toLocaleString()} parlay_orders rows visited`);
  console.log(`  ${alreadyHad.toLocaleString()} already had creator_id (skipped)`);
  console.log(`  ${missingInDb.toLocaleString()} PX parlay_ids not in our parlay_orders table`);
  console.log(`  ${updates.length.toLocaleString()} rows to update`);

  if (DRY_RUN) {
    console.log('\n[dry-run] not writing. Sample:');
    for (const u of updates.slice(0, 5)) console.log('  ', u.parlay_id, '→', u.meta.creatorId);
    return;
  }

  if (updates.length === 0) {
    console.log('\nNothing to update. Exiting.');
    return;
  }

  // 3. Apply updates. PostgREST has no bulk-update-by-different-value, so
  // one UPDATE per row. Throttle to 10 concurrent.
  console.log(`\nApplying ${updates.length.toLocaleString()} updates...`);
  const WAVE = 10;
  let updated = 0;
  let failed = 0;
  for (let i = 0; i < updates.length; i += WAVE) {
    const wave = updates.slice(i, i + WAVE);
    const results = await Promise.all(wave.map(u =>
      sb.from('parlay_orders').update({ meta: u.meta }).eq('parlay_id', u.parlay_id)
        .then(r => r, e => ({ error: e }))
    ));
    for (const r of results) {
      if (r.error) failed++;
      else updated++;
    }
    if (updated % 500 === 0 || i + WAVE >= updates.length) {
      const pct = ((updated + failed) / updates.length * 100).toFixed(1);
      console.log(`  ${(updated + failed).toLocaleString()}/${updates.length.toLocaleString()} (${pct}%, ${failed} failures)`);
    }
  }
  console.log(`\n✓ Backfill complete: ${updated.toLocaleString()} rows updated, ${failed} failures`);
})().catch(err => { console.error('FATAL:', err.message); console.error(err.stack); process.exit(1); });
