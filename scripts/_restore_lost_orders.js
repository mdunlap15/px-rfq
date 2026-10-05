// Restore parlay_orders rows for FILLED PX orders the trader never persisted.
//
// Why (2026-10-04): orders confirmed while Supabase was overloaded (10/3 outage,
// and the 10/4 write flood) sat in the in-memory retry spool and died with the
// next restart. With no parlay_orders row the settlement poll skips them as
// "never quoted by us", so they are missing from P&L, and the dashboard shows
// them with no prices. 45 fills / $18.7K risk / -$2,510 PX profit on 10/4.
//
// Every field comes from a record, never a model:
//   - PX order (GET /px-orders on prod): legs, odds, stake, uuid, settlement, profit
//   - Railway logs of the deployment that took the fill: "[RFQ] Offered:" (our
//     offered odds, parlay fair, vig, quote time) and "[Confirm] Received" (time)
//   - line_cache: leg labels
//   - per-leg book prices / fair: the NEAREST persisted quote (same lineId,
//     within ±60 min) — the same feed snapshot the trader priced from. Checked
//     against the logged parlay fair (meta.restore.fairCheck).
// Rows are INSERT-ONLY (ignoreDuplicates) — an existing row is never touched.
//
//   node scripts/_restore_lost_orders.js            # dry run (reads only)
//   node scripts/_restore_lost_orders.js --apply    # insert the rows
//   ... --only <parlayId>[,<parlayId>]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const env = require(path.join(ROOT, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(ROOT, '.env')));
const sb = require(path.join(ROOT, 'node_modules/@supabase/supabase-js')).createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const BASE = 'https://prophetx-rfq-production-6781.up.railway.app';
const AUTH = 'Basic ' + Buffer.from((env.AUTH_USERNAME || 'mike') + ':' + env.AUTH_PASSWORD).toString('base64');
const APPLY = process.argv.includes('--apply');
const onlyArg = process.argv[process.argv.indexOf('--only') + 1];
const ONLY = process.argv.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null;
const LEG_WINDOW_MS = 60 * 60e3;

const uuidMs = id => parseInt(String(id || '').replace(/-/g, '').slice(0, 12), 16);
const iso = ms => (ms ? new Date(ms).toISOString() : null);

function railway(args) {
  try {
    return execFileSync('railway', args, { cwd: ROOT, encoding: 'utf8', timeout: 150000, stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  } catch (e) { return String(e.stdout || ''); }
}

function deployments() {
  const out = railway(['deployment', 'list', '--limit', '60']);
  const deps = [];
  for (const m of out.matchAll(/([0-9a-f-]{36}) \| \w+ \| (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d)/g)) {
    deps.push({ id: m[1], at: Date.parse(m[2].replace(' ', 'T').replace(' ', '')) });
  }
  return deps.sort((a, b) => a.at - b.at);
}

function logFacts(depIds, pid) {
  for (const dep of depIds) {
    const txt = railway(['logs', dep, '--filter', `"${pid}"`, '--lines', '50']);
    const off = txt.match(/^(\S+) \[RFQ\] Offered: parlay=[^,]+, odds=(-?\d+), fair=([\d.]+), vig=([\d.]+)/m);
    const conf = txt.match(/^(\S+) \[Confirm\] Received: parlay=[^,]+, order=[^,]+, odds=(-?\d+), stake=\$([\d.]+)/m);
    if (off || conf) {
      return {
        deployment: dep,
        quotedAt: off ? off[1] : null,
        offeredOdds: off ? Number(off[2]) : null,
        fair: off ? Number(off[3]) : null,
        vig: off ? Number(off[4]) : null,
        confirmedAt: conf ? conf[1] : null,
      };
    }
  }
  return null;
}

async function nearestQuotedLeg(lineId, atMs) {
  const r = await sb.from('parlay_orders').select('parlay_id,quoted_at,legs')
    .gte('quoted_at', iso(atMs - LEG_WINDOW_MS)).lte('quoted_at', iso(atMs + LEG_WINDOW_MS))
    .filter('legs', 'cs', JSON.stringify([{ lineId }])).limit(200);
  if (r.error || !r.data || !r.data.length) return null;
  let best = null;
  for (const row of r.data) {
    const dt = Math.abs(Date.parse(row.quoted_at) - atMs);
    const leg = (row.legs || []).find(l => l.lineId === lineId);
    if (leg && leg.fairProb != null && (!best || dt < best.dt)) best = { dt, row, leg };
  }
  return best;
}

async function lineCache(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const r = await sb.from('line_cache').select('*').in('line_id', ids.slice(i, i + 100));
    for (const x of r.data || []) out[x.line_id] = x;
  }
  return out;
}

(async () => {
  const px = await fetch(BASE + '/px-orders?limit=500&include=all', { headers: { authorization: AUTH } }).then(r => r.json());
  const all = [...(px.settled || []), ...(px.tbd || []), ...(px.open || [])]
    .filter(o => o.p_id && Number(o.confirmed_stake) > 0 && !['rejected', 'failed'].includes(o.status));
  const have = new Set();
  const ids = [...new Set(all.map(o => o.p_id))];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await sb.from('parlay_orders').select('parlay_id').in('parlay_id', ids.slice(i, i + 100));
    if (r.error) throw new Error('parlay_orders read: ' + r.error.message);
    for (const x of r.data) have.add(x.parlay_id);
  }
  let lost = all.filter(o => !have.has(o.p_id)).sort((a, b) => uuidMs(a.p_id) - uuidMs(b.p_id));
  if (ONLY) lost = lost.filter(o => ONLY.has(o.p_id) || ONLY.has(o.order_uuid));
  console.log(`PX filled orders scanned: ${all.length}; with no parlay_orders row: ${lost.length}${APPLY ? '' : '  (DRY RUN)'}`);

  const deps = deployments();
  const lc = await lineCache([...new Set(lost.flatMap(o => (o.legs || []).map(l => l.line_id)))]);
  const rows = [];
  for (const o of lost) {
    const t = uuidMs(o.p_id);
    // the deployment live at fill time, then its predecessor (overlap on deploy)
    const live = deps.filter(d => d.at <= t).slice(-2).reverse().map(d => d.id);
    const lf = logFacts(live, o.p_id);
    const quotedMs = lf && lf.quotedAt ? Date.parse(lf.quotedAt) : t;
    const legs = [];
    let fairProd = 1, fairComplete = true;
    for (const l of o.legs || []) {
      const c = lc[l.line_id];
      const near = await nearestQuotedLeg(l.line_id, quotedMs);
      const q = near ? near.leg : {};
      const leg = {
        ...q,
        lineId: l.line_id,
        team: q.team || (c && c.team_name) || `line ${String(l.line_id).slice(0, 8)}`,
        market: q.market || (c && c.market_type) || null,
        marketName: q.marketName || (c && c.market_name) || null,
        selection: q.selection || (c && c.selection) || null,
        line: q.line !== undefined ? q.line : (c && c.line != null ? Number(c.line) : (l.line ?? null)),
        sport: q.sport || (c && c.sport) || null,
        homeTeam: q.homeTeam || (c && c.home_team) || null,
        awayTeam: q.awayTeam || (c && c.away_team) || null,
        startTime: q.startTime || (c && c.start_time) || null,
        pxEventId: q.pxEventId || (c && c.px_event_id) || l.sport_event_id || null,
        pxEventName: q.pxEventName || (c && c.px_event_name) || null,
        settlementStatus: l.settlement_status,
        settlement_status: l.settlement_status,
        restoredFrom: near ? { parlayId: near.row.parlay_id, quotedAt: near.row.quoted_at, dtSec: Math.round(near.dt / 1000) } : null,
      };
      delete leg.inferredResult;
      if (near && q.fairProb != null) fairProd *= Number(q.fairProb); else fairComplete = false;
      legs.push(leg);
    }
    const ss = String(o.settlement_status || '').toLowerCase();
    const settled = o.status === 'settled' && ['won', 'lost', 'push'].includes(ss);
    const pnl = settled ? (ss === 'push' ? 0 : Number(o.profit ?? 0)) : null;
    const fair = lf && lf.fair != null ? lf.fair : (fairComplete ? Math.round(fairProd * 1e5) / 1e5 : null);
    const fairCheck = lf && lf.fair && fairComplete ? Math.round((fairProd / lf.fair) * 1e4) / 1e4 : null;
    const offeredOdds = lf && lf.offeredOdds != null ? lf.offeredOdds : -Number(o.confirmed_odds);
    const row = {
      parlay_id: o.p_id,
      status: settled ? `settled_${ss}` : 'confirmed',
      legs,
      offered_odds: offeredOdds,
      fair_parlay_prob: fair,
      max_risk: null,
      vig: lf ? lf.vig : null,
      confirmed_odds: Number(o.confirmed_odds),
      confirmed_stake: Number(o.confirmed_stake),
      order_uuid: o.order_uuid,
      pnl,
      settlement_result: settled ? ss : null,
      quoted_at: lf && lf.quotedAt ? lf.quotedAt : null,
      confirmed_at: (lf && lf.confirmedAt) || iso(uuidMs(o.order_uuid) || t),
      settled_at: settled && o.settled_at ? iso(Number(o.settled_at) * 1000) : null,
      meta: {
        legs, vig: lf ? lf.vig : null, fairParlayProb: fair, americanOdds: offeredOdds,
        creatorId: o.creator_id || null,
        ...(settled && ss !== 'push' ? { pxProfit: Number(o.profit ?? 0) } : {}),
        restored: true,
        restore: {
          at: new Date().toISOString(), script: 'scripts/_restore_lost_orders.js',
          log: lf ? { deployment: lf.deployment, quotedAt: lf.quotedAt, confirmedAt: lf.confirmedAt } : null,
          legsFromNearestQuote: legs.filter(l => l.restoredFrom).length, legs: legs.length, fairCheck,
        },
      },
    };
    rows.push(row);
    const legTxt = legs.map(l => `${l.team}${l.line != null && l.market !== 'moneyline' ? ' ' + l.line : ''} ${l.market || '?'}${l.restoredFrom ? ` [pin ${l.pinnacleOdds ?? '-'} fd ${l.fanduelOdds ?? '-'} dk ${l.draftkingsOdds ?? '-'} fair ${l.fairProb} @${l.restoredFrom.dtSec}s]` : ' [no quote]'}`).join(' + ');
    console.log(`${iso(t).slice(5, 16)} ${o.p_id} ${row.status.padEnd(12)} risk $${row.confirmed_stake} odds +${offeredOdds} fair ${fair ?? '-'} vig ${row.vig ?? '-'} chk ${fairCheck ?? '-'} pnl ${pnl ?? '-'} log ${lf ? 'yes' : 'NO'}\n    ${legTxt}`);
  }
  const s = rows.filter(r => r.pnl != null);
  console.log(`\n${rows.length} rows; settled ${s.length} P&L ${s.reduce((a, r) => a + r.pnl, 0).toFixed(2)}; open ${rows.length - s.length}; with log facts ${rows.filter(r => r.meta.restore.log).length}; legs restored ${rows.reduce((a, r) => a + r.meta.restore.legsFromNearestQuote, 0)}/${rows.reduce((a, r) => a + r.legs.length, 0)}`);
  if (!APPLY) return;
  const r = await sb.from('parlay_orders').upsert(rows, { onConflict: 'parlay_id', ignoreDuplicates: true }).select('parlay_id');
  if (r.error) throw new Error('insert: ' + r.error.message);
  console.log(`inserted ${r.data.length} rows`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
