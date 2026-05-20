// Passive confirm-rate watch.
//
// Compares the trailing 1 hour's confirm count + total quote count against
// the same UTC hour exactly 7 days ago. Output is one line — short enough
// for a scheduled-task notification, long enough to spot a regime change.
//
// Sample output:
//   2026-05-20 04:30Z  this 1h: 0/371 (0.00%)  same 1h last wk: 8/812 (0.99%)  DOWN 8 confirms · 4.2σ
//
// Args: none. Reads Supabase from .env.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
  const wkAgoNow = new Date(now.getTime() - 7 * 86400 * 1000);
  const wkAgoOneHourAgo = new Date(wkAgoNow.getTime() - 3600 * 1000);

  const headCount = async (table, col, start, end, opts = {}) => {
    let q = sb.from(table).select('*', { count: opts.exact ? 'exact' : 'estimated', head: true })
      .gte(col, start.toISOString()).lt(col, end.toISOString());
    if (opts.statusIn) q = q.in('status', opts.statusIn);
    const { count, error } = await q;
    return error ? null : (count || 0);
  };

  const [nowQ, nowC, wkQ, wkC] = await Promise.all([
    headCount('parlay_orders', 'quoted_at', oneHourAgo, now),
    headCount('parlay_orders', 'confirmed_at', oneHourAgo, now, { statusIn: ['confirmed','settled_won','settled_lost','settled_push'] }),
    headCount('parlay_orders', 'quoted_at', wkAgoOneHourAgo, wkAgoNow),
    headCount('parlay_orders', 'confirmed_at', wkAgoOneHourAgo, wkAgoNow, { statusIn: ['confirmed','settled_won','settled_lost','settled_push'] }),
  ]);

  const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(2) + '%' : '—');
  // Simple Poisson z-score: how many sigmas below baseline expectation
  // (baseline = wk-ago confirm rate × this hour's quote count).
  const expected = wkQ > 0 ? (wkC / wkQ) * nowQ : null;
  const sigma = expected != null && expected > 0 ? (nowC - expected) / Math.sqrt(expected) : null;

  const tag = (() => {
    if (nowC > wkC) return 'UP';
    if (expected != null && nowC < expected && sigma != null && sigma <= -2) return 'DOWN-significant';
    if (nowC === 0 && expected != null && expected >= 3) return 'ZERO';
    return 'normal';
  })();

  const ts = now.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const line = `${ts}  this 1h: ${nowC}/${nowQ} (${pct(nowC,nowQ)})  same 1h last wk: ${wkC}/${wkQ} (${pct(wkC,wkQ)})  ${tag}${sigma!=null?'  z=' + sigma.toFixed(1):''}`;
  console.log(line);

  // Non-zero exit if regime is significantly bad — lets a scheduled task
  // surface only the abnormal pings without spamming on normal hours.
  if (tag === 'DOWN-significant' || tag === 'ZERO') process.exit(2);
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
