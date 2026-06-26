/**
 * READ-ONLY diagnostic for the stuck-'confirmed' parlay_orders backlog.
 *
 * Pulls every status='confirmed' row from Supabase, pulls PX's order feed,
 * and cross-references to answer:
 *   - How deep does PX's feed go (count + date range)?
 *   - How many backlog rows match PX by order_uuid? by p_id (parlay_id)?
 *   - For matched rows, what does PX say (settlement_status breakdown)?
 *   - How many are aged-out (absent from the feed entirely)?
 *   - Of the aged-out, how many carry our own leg settlement data
 *     (recoverable by leg-inference) vs nothing?
 *
 * Writes NOTHING. Dumps a JSON summary to _confirmed_backlog_diag.json.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const px = require('../services/prophetx');
const { createClient } = require('@supabase/supabase-js');

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function ts(v) {
  // PX timestamps are sometimes unix-seconds, sometimes ISO. Normalize to ms.
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

async function loadConfirmed() {
  const rows = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supa
      .from('parlay_orders')
      .select('parlay_id, status, order_uuid, confirmed_stake, confirmed_odds, confirmed_at, settled_at, pnl, settlement_result, legs, meta')
      .eq('status', 'confirmed')
      .order('confirmed_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`supabase confirmed page @${offset}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

function legHasResult(row) {
  const legs = (row.legs && row.legs.length ? row.legs : (row.meta && row.meta.legs)) || [];
  let known = 0;
  for (const l of legs) {
    const r = l.settlementStatus || l.settlement_status || l.inferredResult;
    if (r && r !== 'pending' && r !== 'unknown') known++;
  }
  return { legCount: legs.length, knownLegs: known };
}

(async () => {
  console.log('=== Confirmed backlog diagnostic (READ-ONLY) ===\n');

  // 1. Supabase confirmed backlog
  const confirmed = await loadConfirmed();
  let sumStake = 0, withUuid = 0, phantom = 0;
  let oldest = Infinity, newest = -Infinity;
  for (const r of confirmed) {
    sumStake += Number(r.confirmed_stake || 0);
    if (r.order_uuid) withUuid++;
    if (r.meta && r.meta.phantom) phantom++;
    const t = ts(r.confirmed_at);
    if (t != null) { oldest = Math.min(oldest, t); newest = Math.max(newest, t); }
  }
  console.log(`Supabase status='confirmed' rows : ${confirmed.length}`);
  console.log(`  sum(confirmed_stake)           : $${sumStake.toFixed(2)}`);
  console.log(`  with order_uuid                : ${withUuid} (${(100*withUuid/confirmed.length).toFixed(1)}%)`);
  console.log(`  meta.phantom already flagged   : ${phantom}`);
  console.log(`  confirmed_at range             : ${iso(oldest)}  ->  ${iso(newest)}`);

  const FIVE_DAYS = 5 * 864e5;
  const now = Date.now();
  const over5d = confirmed.filter(r => { const t = ts(r.confirmed_at); return t != null && (now - t) > FIVE_DAYS; });
  console.log(`  >5 days old                    : ${over5d.length}`);

  // 2. PX feed
  console.log('\nFetching PX order feed (limit 12000)...');
  const pxOrders = await px.fetchOrders(12000);
  console.log(`PX feed returned               : ${pxOrders.length} orders`);
  // sample shape
  if (pxOrders.length) {
    console.log('  sample PX order keys         :', Object.keys(pxOrders[0]).join(', '));
  }
  const pxByUuid = new Map(), pxByPid = new Map();
  const pxStatusCounts = {}, pxSettlementCounts = {};
  let pxOldest = Infinity, pxNewest = -Infinity;
  for (const o of pxOrders) {
    const uuid = o.order_uuid || o.orderUuid;
    const pid = o.p_id || o.parlay_id || o.parlayId;
    if (uuid) pxByUuid.set(uuid, o);
    if (pid && !pxByPid.has(pid)) pxByPid.set(pid, o);
    const st = (o.status || '').toLowerCase();
    pxStatusCounts[st] = (pxStatusCounts[st] || 0) + 1;
    const ss = (o.settlement_status || o.settlementStatus || '(none)').toLowerCase();
    pxSettlementCounts[ss] = (pxSettlementCounts[ss] || 0) + 1;
    const t = ts(o.created_at || o.updated_at);
    if (t != null) { pxOldest = Math.min(pxOldest, t); pxNewest = Math.max(pxNewest, t); }
  }
  console.log('  PX status breakdown          :', JSON.stringify(pxStatusCounts));
  console.log('  PX settlement breakdown      :', JSON.stringify(pxSettlementCounts));
  console.log(`  PX feed date range (created) : ${iso(pxOldest)}  ->  ${iso(pxNewest)}`);

  // 3. Cross-reference backlog against PX feed
  let matchUuid = 0, matchPid = 0, noMatch = 0;
  const matchedSettlement = {};   // PX settlement_status for matched backlog rows
  const matchedPxStatus = {};
  const agedOut = [];             // confirmed rows absent from PX feed
  for (const r of confirmed) {
    let pxo = (r.order_uuid && pxByUuid.get(r.order_uuid)) || pxByPid.get(r.parlay_id) || null;
    if (pxo) {
      if (r.order_uuid && pxByUuid.get(r.order_uuid)) matchUuid++; else matchPid++;
      const st = (pxo.status || '').toLowerCase();
      const ss = (pxo.settlement_status || pxo.settlementStatus || '(none)').toLowerCase();
      matchedPxStatus[st] = (matchedPxStatus[st] || 0) + 1;
      matchedSettlement[ss] = (matchedSettlement[ss] || 0) + 1;
    } else {
      noMatch++;
      agedOut.push(r);
    }
  }
  console.log('\n--- Cross-reference (backlog vs PX feed) ---');
  console.log(`  matched by order_uuid        : ${matchUuid}`);
  console.log(`  matched by parlay_id only    : ${matchPid}`);
  console.log(`  NOT in PX feed (aged out)    : ${noMatch}`);
  console.log('  matched -> PX status         :', JSON.stringify(matchedPxStatus));
  console.log('  matched -> PX settlement     :', JSON.stringify(matchedSettlement));

  // 4. Aged-out: recoverability via our own leg data
  let agedWithAllLegs = 0, agedWithSomeLegs = 0, agedNoLegs = 0, agedSumStake = 0;
  let agedOldest = Infinity, agedNewest = -Infinity;
  for (const r of agedOut) {
    agedSumStake += Number(r.confirmed_stake || 0);
    const { legCount, knownLegs } = legHasResult(r);
    if (legCount > 0 && knownLegs === legCount) agedWithAllLegs++;
    else if (knownLegs > 0) agedWithSomeLegs++;
    else agedNoLegs++;
    const t = ts(r.confirmed_at);
    if (t != null) { agedOldest = Math.min(agedOldest, t); agedNewest = Math.max(agedNewest, t); }
  }
  console.log('\n--- Aged-out recoverability (our leg data) ---');
  console.log(`  aged-out rows                : ${agedOut.length}  ($${agedSumStake.toFixed(2)})`);
  console.log(`  date range                   : ${iso(agedOldest)} -> ${iso(agedNewest)}`);
  console.log(`  all legs have a result       : ${agedWithAllLegs}`);
  console.log(`  some legs have a result      : ${agedWithSomeLegs}`);
  console.log(`  no leg result at all         : ${agedNoLegs}`);

  // Sample 8 matched + 5 aged-out parlay_ids for manual inspection
  const sampleMatched = confirmed.filter(r => (r.order_uuid && pxByUuid.get(r.order_uuid)) || pxByPid.get(r.parlay_id)).slice(0, 8).map(r => {
    const pxo = (r.order_uuid && pxByUuid.get(r.order_uuid)) || pxByPid.get(r.parlay_id);
    return { parlay_id: r.parlay_id, confirmed_at: r.confirmed_at, stake: r.confirmed_stake,
             px_status: pxo.status, px_settlement: pxo.settlement_status, px_profit: pxo.profit };
  });

  require('fs').writeFileSync(__dirname + '/../_confirmed_backlog_diag.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    confirmedCount: confirmed.length, sumStake, withUuid, phantom, over5d: over5d.length,
    confirmedRange: [iso(oldest), iso(newest)],
    pxFeedCount: pxOrders.length, pxStatusCounts, pxSettlementCounts, pxRange: [iso(pxOldest), iso(pxNewest)],
    matchUuid, matchPid, noMatch, matchedPxStatus, matchedSettlement,
    agedOut: { count: agedOut.length, sumStake: agedSumStake, range: [iso(agedOldest), iso(agedNewest)],
               allLegs: agedWithAllLegs, someLegs: agedWithSomeLegs, noLegs: agedNoLegs },
    sampleMatched,
  }, null, 2));
  console.log('\nWrote _confirmed_backlog_diag.json');
  console.log('Sample matched rows:'); console.table(sampleMatched);
  process.exit(0);
})().catch(e => { console.error('DIAG FAILED:', e.message); process.exit(1); });
