// Restore parlay fills that ProphetX recorded during the 2026-09-25 Supabase outage
// (writes failed ~07:00-16:30 UTC) and that never reached parlay_orders.
// Operator-approved 2026-09-25 ("approve the reconcile").
//
// Source of truth: ProphetX /parlay/sp/orders (dumped read-only to px_orders_dump.json).
// Legs are rebuilt from Supabase line_cache (all 90 legs resolved). Only inserts rows
// whose parlay_id is ABSENT from parlay_orders; never overwrites. Rows are written as
// 'confirmed'; the trader's settlement poll settles the finished ones off PX.
//
// Usage: node scripts/_restore_outage_fills_2026-09-25.js <px_orders_dump.json> [--apply]
require('dotenv').config();
process.env.LOG_LEVEL = 'warn';
const db = require('../services/db');
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const dumpPath = process.argv[2];
  const apply = process.argv.includes('--apply');
  const px = require(require('path').resolve(dumpPath));
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const cand = px.filter(o => o.p_id && o.order_uuid && !['rejected', 'failed'].includes(o.status));
  const have = new Set();
  for (let i = 0; i < cand.length; i += 100) {
    const r = await sb.from('parlay_orders').select('parlay_id').in('parlay_id', cand.slice(i, i + 100).map(o => o.p_id));
    if (r.error) throw r.error;
    r.data.forEach(x => have.add(x.parlay_id));
  }
  const missing = cand.filter(o => !have.has(o.p_id));
  const lc = await db.loadLineCacheBulk([...new Set(missing.flatMap(o => (o.legs || []).map(l => l.line_id)))]);

  const rows = [];
  for (const o of missing) {
    const legs = (o.legs || []).map(l => {
      const c = lc[l.line_id] || {};
      let team = c.teamName || '?';
      if (c.marketType === 'total' && c.homeTeam && c.awayTeam) team = `${team} (${c.awayTeam} @ ${c.homeTeam})`;
      return {
        lineId: l.line_id, sport: c.sport || c.oddsApiSport || 'unknown', team, teamName: c.teamName || team,
        market: c.marketType || null, marketType: c.marketType || null, line: c.marketType === 'moneyline' ? null : (l.line ?? c.line ?? null),
        selection: c.selection || c.oddsApiSelection || null, homeTeam: c.homeTeam || null, awayTeam: c.awayTeam || null,
        playerName: c.playerName || null, pxEventId: l.sport_event_id || c.pxEventId || null,
        pxEventName: c.pxEventName || null, startTime: c.startTime || null,
        settlementStatus: l.settlement_status || null, settlement_status: l.settlement_status || null,
      };
    });
    if (legs.some(l => l.team === '?')) { console.log('SKIP (unresolved leg)', o.p_id); continue; }
    rows.push({
      parlay_id: o.p_id, status: 'confirmed', order_uuid: o.order_uuid,
      confirmed_stake: Number(o.confirmed_stake), confirmed_odds: Number(o.confirmed_odds),
      offered_odds: -Number(o.confirmed_odds),
      confirmed_at: new Date(o.updated_at * 1000).toISOString(),
      legs,
      meta: { reconstructed: true, restoredFrom: 'px-outage-2026-09-25', creatorId: o.creator_id, legs },
    });
  }
  console.log(`missing ${missing.length} | restorable ${rows.length} | risk $${rows.reduce((a, r) => a + r.confirmed_stake, 0).toFixed(0)}`);
  rows.slice(0, 3).forEach(r => console.log('  e.g.', r.parlay_id.slice(0, 13), r.legs.map(l => l.team + ' ' + l.marketType + (l.line != null ? ' ' + l.line : '')).join(' + ')));
  if (!apply) { console.log('dry run — pass --apply to write'); process.exit(0); }
  const r = await sb.from('parlay_orders').insert(rows);
  if (r.error) { console.log('INSERT ERR', r.error.message); process.exit(1); }
  console.log(`inserted ${rows.length} rows`);
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
