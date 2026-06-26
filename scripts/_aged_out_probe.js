/**
 * READ-ONLY. Two questions:
 *  (1) Can PX return a PRE-CUTOVER order at all? Test a direct per-uuid GET
 *      and a status-filtered deep page against an aged-out uuid.
 *  (2) If we must fall back to OUR leg data, what would leg-inference settle
 *      the 1346 aged-out rows to, and what's the net P&L impact?
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const px = require('../services/prophetx');
const { createClient } = require('@supabase/supabase-js');
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function americanOddsToProfit(odds, stake) {
  odds = Number(odds); stake = Number(stake);
  if (!odds || !stake) return 0;
  if (odds >= 100) return stake * odds / 100;
  if (odds <= -100) return stake * 100 / Math.abs(odds);
  return 0;
}

// Mirror reconcileSettlements leg-derivation exactly.
function deriveResult(row) {
  const legsA = Array.isArray(row.legs) ? row.legs : [];
  const legsB = Array.isArray(row.meta?.legs) ? row.meta.legs : [];
  const primary = legsA.length >= legsB.length ? legsA : legsB;
  if (primary.length === 0) return { result: null, reason: 'no-legs' };
  const statuses = [];
  for (let i = 0; i < primary.length; i++) {
    const p = primary[i];
    const lid = p.lineId || p.line_id;
    const tm = p.team || p.teamName;
    let st = null;
    for (const src of [legsA, legsB]) {
      let l = src[i];
      if (!l || ((l.lineId || l.line_id) !== lid && (l.team || l.teamName) !== tm)) {
        l = src.find(x => (x.lineId || x.line_id) === lid) || src.find(x => (x.team || x.teamName) === tm) || src[i];
      }
      const s = l && (l.settlementStatus || l.settlement_status);
      if (s) { st = s; break; }
    }
    if (!st) {
      for (const src of [legsA, legsB]) {
        const l = src[i];
        if (l && l.inferredResult) { st = l.inferredResult; break; }
      }
    }
    if (st) statuses.push(st);
  }
  const full = statuses.length === primary.length && statuses.length > 0;
  const anyLost = statuses.some(s => s === 'lost');
  const allWon = full && statuses.every(s => s === 'won');
  const allPush = full && statuses.every(s => s === 'push' || s === 'void');
  if (anyLost) return { result: 'won', reason: 'any-leg-lost', coverage: `${statuses.length}/${primary.length}` };
  if (allWon) return { result: 'lost', reason: 'all-legs-won', coverage: `${statuses.length}/${primary.length}` };
  if (allPush) return { result: 'push', reason: 'all-legs-push', coverage: `${statuses.length}/${primary.length}` };
  return { result: null, reason: full ? 'mixed-won-push' : 'incomplete', coverage: `${statuses.length}/${primary.length}` };
}

async function loadConfirmed() {
  const rows = []; const PAGE = 1000; let off = 0;
  while (true) {
    const { data, error } = await supa.from('parlay_orders')
      .select('parlay_id, order_uuid, confirmed_stake, confirmed_odds, confirmed_at, legs, meta')
      .eq('status', 'confirmed').order('confirmed_at', { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    rows.push(...data); if (data.length < PAGE) break; off += PAGE;
  }
  return rows;
}

(async () => {
  const confirmed = await loadConfirmed();
  const pxOrders = await px.fetchOrders(12000);
  const pxByUuid = new Set(pxOrders.map(o => o.order_uuid).filter(Boolean));

  const aged = confirmed.filter(r => !(r.order_uuid && pxByUuid.has(r.order_uuid)));
  const agedWithUuid = aged.filter(r => r.order_uuid);
  const inFeed = confirmed.find(r => r.order_uuid && pxByUuid.has(r.order_uuid));

  console.log(`aged-out=${aged.length}, aged-with-uuid=${agedWithUuid.length}, in-feed-sample=${inFeed?.parlay_id}`);

  // (1a) Direct per-uuid GET — does PX expose a single-order resource that
  // reaches further than the paginated feed? Test in-feed (should resolve if
  // the endpoint exists) then an aged-out/pre-cutover uuid (the real test).
  const testUuids = [
    ['in-feed', inFeed?.order_uuid],
    ['aged-out', agedWithUuid[0]?.order_uuid],
  ];
  for (const [label, uuid] of testUuids) {
    if (!uuid) { console.log(`  GET ${label}: (no uuid)`); continue; }
    for (const path of [`/parlay/sp/orders/${uuid}`, `/parlay/sp/orders/${uuid}/`, `/parlay/sp/orders/?order_uuid=${uuid}`]) {
      try {
        const r = await px.pxFetch(path);
        const o = r?.data?.order || r?.data?.orders?.[0] || r?.data || r;
        const st = o?.status, ss = o?.settlement_status;
        console.log(`  GET ${path}  -> OK (status=${st}/${ss})`);
      } catch (e) {
        console.log(`  GET ${path}  -> ${e.message.split(':').slice(0,2).join(':').slice(0,90)}`);
      }
    }
  }

  // (1b) status filter depth — does ?status=settled page deeper than the cutover?
  try {
    const settledFeed = await px.fetchOrders(12000, 'settled');
    const dates = settledFeed.map(o => o.updated_at).filter(Boolean).sort();
    console.log(`  ?status=settled returned ${settledFeed.length}; oldest updated_at=${dates[0]}`);
  } catch (e) { console.log('  status=settled fetch failed:', e.message); }

  // (2) Leg-inference outcome + P&L impact for aged-out
  const dist = { won: 0, lost: 0, push: 0, undetermined: 0 };
  const reasonDist = {};
  let pnlWon = 0, pnlLost = 0, n = 0;
  let undeterminedStake = 0;
  for (const r of aged) {
    const d = deriveResult(r);
    reasonDist[d.reason] = (reasonDist[d.reason] || 0) + 1;
    if (d.result === 'won') { dist.won++; pnlWon += americanOddsToProfit(r.confirmed_odds, r.confirmed_stake); }
    else if (d.result === 'lost') { dist.lost++; pnlLost += -Number(r.confirmed_stake || 0); }
    else if (d.result === 'push') { dist.push++; }
    else { dist.undetermined++; undeterminedStake += Number(r.confirmed_stake || 0); }
    n++;
  }
  console.log('\n--- Leg-inference on aged-out rows ---');
  console.log('  outcome dist :', JSON.stringify(dist));
  console.log('  reason dist  :', JSON.stringify(reasonDist));
  console.log(`  derived P&L  : won +$${pnlWon.toFixed(2)}, lost $${pnlLost.toFixed(2)}, NET $${(pnlWon + pnlLost).toFixed(2)}`);
  console.log(`  undetermined : ${dist.undetermined} rows ($${undeterminedStake.toFixed(2)} stake) — cannot settle, flag only`);
  process.exit(0);
})().catch(e => { console.error('PROBE FAILED:', e.stack || e.message); process.exit(1); });
