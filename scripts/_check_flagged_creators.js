// Daily activity check for watched/flagged counterparties.
//
// Queries parlay_orders for new fills from the WATCHED creator_ids within
// the last N hours (default 24). Prints any hits with stake + status. Used
// inside the daily EOD routine to surface return-of-bleeder activity.
//
// Watched creators come from the 2026-05-24 counterparty review:
//   - 8ae89056-ec9... — 3 fills / $12,289 stake / -$3,780 SP P&L (-30.8% ROI)
//   - 48d465be-e22... — 4 fills / $8,126 stake / -$1,106 SP P&L (-13.6%)
//
// Add or remove watched IDs by editing WATCHED below. Both must be the
// full UUID; only the prefix was shown in the report.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/_check_flagged_creators.js [--hours N] [--min-stake $]
//   default: --hours 24 --min-stake 0

require('dotenv').config();
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('SUPABASE_URL/KEY needed'); process.exit(1); }

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  return args[i + 1];
}
const HOURS = Number(flag('--hours', 24));
const MIN_STAKE = Number(flag('--min-stake', 0));

// PostgREST JSONB filter needs the full meta.creatorId value. The
// counterparty report only showed prefixes — we resolve them to full UUIDs
// by querying for any parlay_orders row whose meta->>creatorId STARTS WITH
// the prefix. This is the only fan-out that requires two round-trips; once
// resolved, subsequent runs can use the cached full UUID.
const WATCHED_PREFIXES = [
  { prefix: '8ae89056', note: '3 fills / $12,289 stake / -$3,780 SP P&L on 5/20–5/23 (-30.8% SP ROI)' },
  { prefix: '48d465be', note: '4 fills / $8,126 stake / -$1,106 SP P&L on 5/20–5/23 (-13.6% SP ROI)' },
];

async function fetchAll(query) {
  const seen = new Set();
  const all = [];
  let offset = 0;
  while (true) {
    const url = SUPA_URL + '/rest/v1/parlay_orders?' + query
      + '&order=quoted_at.desc&limit=1000&offset=' + offset;
    const r = await fetch(url, { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } });
    if (!r.ok) { console.error('Fetch error', r.status, await r.text()); break; }
    const page = await r.json();
    for (const row of page) {
      if (row.parlay_id != null && seen.has(row.parlay_id)) continue;
      if (row.parlay_id != null) seen.add(row.parlay_id);
      all.push(row);
    }
    if (page.length < 1000) break;
    offset += 1000;
    if (offset > 50000) break;
  }
  return all;
}

function fmt$(n) {
  if (n == null) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + '$' + (abs >= 1000 ? Math.round(abs).toLocaleString() : abs.toFixed(0));
}

(async () => {
  const sinceMs = Date.now() - HOURS * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  // Pull all parlay_orders within window. Filtering on meta->>creatorId
  // via PostgREST forces a sequential scan and times out on multi-day
  // windows. Use the quoted_at index, then filter creator_id in code.
  const rowsAll = await fetchAll(
    'select=parlay_id,quoted_at,status,offered_odds,confirmed_stake,legs,pnl,meta'
    + '&quoted_at=gte.' + encodeURIComponent(sinceIso)
  );
  const rows = rowsAll.filter(r => r.meta && r.meta.creatorId);

  console.log(`Flagged-creator activity check — last ${HOURS}h (since ${sinceIso})`);
  console.log(`Watched: ${WATCHED_PREFIXES.map(w => w.prefix).join(', ')}`);
  console.log(`Scanned ${rows.length} creator-tagged parlays in window.`);
  console.log('');

  let anyHits = false;
  for (const { prefix, note } of WATCHED_PREFIXES) {
    const hits = rows.filter(r => {
      const cid = r.meta && r.meta.creatorId;
      if (!cid || !cid.startsWith(prefix)) return false;
      // Only count actual fills — 'quoted' rows are RFQs we priced but
      // the bettor went elsewhere (not a fill from this creator).
      const isFill = r.status === 'confirmed' || (r.status && r.status.startsWith('settled_'));
      if (!isFill) return false;
      return (Number(r.confirmed_stake) || 0) >= MIN_STAKE;
    });
    if (hits.length === 0) {
      console.log(`  [${prefix}] No new activity. (${note})`);
      continue;
    }
    anyHits = true;
    const totalStake = hits.reduce((s, h) => s + (Number(h.confirmed_stake) || 0), 0);
    const settled = hits.filter(h => h.status && h.status.startsWith('settled_'));
    const spWon = settled.filter(h => h.status === 'settled_won').length;
    const spLost = settled.filter(h => h.status === 'settled_lost').length;
    const pending = hits.length - settled.length;
    const realized = settled.reduce((s, h) => s + (Number(h.pnl) || 0), 0);
    console.log(`  🚨 [${prefix}] ${hits.length} new fill(s), total stake ${fmt$(totalStake)} (${spWon}W / ${spLost}L / ${pending} pending; settled P&L ${fmt$(realized)})`);
    console.log(`     Context: ${note}`);
    for (const h of hits.slice(0, 5)) {
      const legCount = Array.isArray(h.legs) ? h.legs.length : '?';
      const oddsStr = h.offered_odds != null ? (h.offered_odds >= 0 ? '+' : '') + h.offered_odds : '-';
      const statusStr = h.status === 'settled_won' ? 'SP WON'
                       : h.status === 'settled_lost' ? 'SP LOST'
                       : h.status === 'confirmed' ? 'PENDING' : (h.status || '?');
      console.log(`       · ${h.quoted_at.slice(0, 19).replace('T', ' ')} UTC  stake ${fmt$(Number(h.confirmed_stake))}  odds ${oddsStr}  ${legCount} legs  ${statusStr}  pnl ${fmt$(Number(h.pnl))}`);
    }
    if (hits.length > 5) console.log(`       · ... and ${hits.length - 5} more`);
  }

  if (!anyHits) {
    console.log('');
    console.log('No flagged-creator activity in the window. ✓');
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
