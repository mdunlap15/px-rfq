// Pricing performance comparison between two ET calendar days.
// Pulls parlay_orders rows by quoted_at within each ET-midnight window
// and reports fill rate, stake-weighted edge, theo EV $, EV per $ wagered,
// median edge, avg legs.
//
// Usage:
//   node scripts/_pricing_compare_days.js <dateA> <dateB> [--through HH:MM]
//   node scripts/_pricing_compare_days.js 2026-05-15 2026-05-22
//   node scripts/_pricing_compare_days.js 2026-05-16 2026-05-23 --through 21:04
//
// Both dates are ET calendar days (assumes EDT, UTC-4 — true for mid-March
// through early November). Each day = [00:00 ET, 24:00 ET) by default.
// --through HH:MM truncates BOTH windows to [00:00, HH:MM) ET for an
// apples-to-apples partial-day comparison when one day is still in progress.

require('dotenv').config();
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPA_URL || !SUPA_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be in env');
  process.exit(1);
}

const args = process.argv.slice(2);
const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
let throughHour = 24, throughMinute = 0;
const throughIdx = args.indexOf('--through');
if (throughIdx >= 0) {
  const v = args[throughIdx + 1];
  if (!v || !/^\d{1,2}:\d{2}$/.test(v)) {
    console.error('--through requires HH:MM (e.g. --through 21:04)');
    process.exit(1);
  }
  [throughHour, throughMinute] = v.split(':').map(Number);
}
// --exclude-sport <name> can be passed multiple times. Filters out parlays
// where ANY leg matches a listed sport (case-insensitive, substring match
// against leg.sport so 'golf' catches 'golf_matchups' etc).
const excludeSports = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exclude-sport' && i + 1 < args.length) {
    excludeSports.push(args[i + 1].toLowerCase());
  }
}
if (dates.length !== 2) {
  console.error('Usage: node scripts/_pricing_compare_days.js <YYYY-MM-DD> <YYYY-MM-DD> [--through HH:MM] [--exclude-sport <name>]...');
  process.exit(1);
}
const [dateA, dateB] = dates;

// ET midnight → UTC ISO. EDT = UTC-4 (May falls in DST window).
// --through HH:MM caps the upper bound; default 24:00 = next-day midnight ET.
function etDayBoundsIso(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0));
  // throughHour=24 → next ET-midnight (4am UTC next day)
  const endUtc = new Date(Date.UTC(y, m - 1, d, 4 + throughHour, throughMinute, 0, 0));
  return { fromIso: startUtc.toISOString(), toIso: endUtc.toISOString() };
}

async function fetchAll(table, query) {
  // Deterministic pagination: ORDER BY parlay_id so offset-based slices
  // don't drift when the table is being written concurrently. Dedupe by
  // parlay_id as a belt-and-suspenders guard (PostgREST occasionally
  // double-returns boundary rows on offset transitions).
  const seen = new Set();
  const all = [];
  let offset = 0;
  while (true) {
    // Order by quoted_at — aligns with the range filter's index so pagination
    // stays fast. parlay_id tiebreaker keeps order deterministic on duplicate
    // timestamps. Dedup by parlay_id below guards against any boundary repeats.
    const url = SUPA_URL + '/rest/v1/' + table + '?' + query
      + '&order=quoted_at.asc,parlay_id.asc&limit=1000&offset=' + offset;
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
    if (offset > 200000) { console.error('Hit safety cap at 200k rows'); break; }
  }
  return all;
}

function amToProb(am) {
  const n = Number(am);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}
function amToDec(am) {
  const n = Number(am);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / -n;
}
function pct(arr, p) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))];
}
function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function computeDay(ymd) {
  const { fromIso, toIso } = etDayBoundsIso(ymd);
  const rawOrders = await fetchAll('parlay_orders',
    'select=parlay_id,quoted_at,status,offered_odds,confirmed_stake,fair_parlay_prob,legs,pnl,settlement_result'
    + '&quoted_at=gte.' + encodeURIComponent(fromIso)
    + '&quoted_at=lt.' + encodeURIComponent(toIso)
  );

  // Apply --exclude-sport filter. Drop parlays where ANY leg's sport
  // matches a listed exclude term (substring, case-insensitive). Both
  // quoted and confirmed counts reflect the post-filter set.
  const orders = excludeSports.length === 0 ? rawOrders : rawOrders.filter(o => {
    const legs = Array.isArray(o.legs) ? o.legs : [];
    for (const l of legs) {
      const s = String(l.sport || '').toLowerCase();
      for (const ex of excludeSports) {
        if (s.includes(ex)) return false;
      }
    }
    return true;
  });

  const quoted = orders.length;
  const isConfirmed = o => o.status === 'confirmed' || (o.status && o.status.startsWith('settled_'));
  const confirmed = orders.filter(isConfirmed);
  const confirmedCount = confirmed.length;
  const fillRatePct = quoted > 0 ? (confirmedCount / quoted * 100) : 0;
  const totalStake = confirmed.reduce((s, o) => s + (Number(o.confirmed_stake) || 0), 0);

  // SP win/loss outcomes on settled parlays. Status field is from SP
  // perspective (verified empirically: pnl is positive on 'settled_won'
  // rows, negative on 'settled_lost' rows). 'settled_won' = SP kept the
  // stake (bettor's parlay missed at least one leg). 'settled_lost' = SP
  // paid out (bettor's parlay hit all legs). Push/void refunds.
  const settled = confirmed.filter(o => o.status && o.status.startsWith('settled_'));
  const stillPending = confirmedCount - settled.length;
  let spWon = 0, spLost = 0, pushVoid = 0;
  let spPnlSum = 0, spWonStake = 0, spLostStake = 0;
  let spWonPnlSum = 0, spLostPnlSum = 0; // diagnostic — verifies status convention
  for (const o of settled) {
    const s = o.status;
    const stake = Number(o.confirmed_stake) || 0;
    const pnl = Number(o.pnl) || 0;
    spPnlSum += pnl;
    if (s === 'settled_won') { spWon++; spWonStake += stake; spWonPnlSum += pnl; }
    else if (s === 'settled_lost') { spLost++; spLostStake += stake; spLostPnlSum += pnl; }
    else { pushVoid++; }
  }
  const decided = spWon + spLost;
  const spWinRatePct = decided > 0 ? (spWon / decided * 100) : null;
  const avgSpWinPnl = spWon > 0 ? spWonPnlSum / spWon : null;
  const avgSpLossPnl = spLost > 0 ? spLostPnlSum / spLost : null;

  // Avg legs (confirmed only)
  const legCounts = confirmed.map(o => {
    if (Array.isArray(o.legs)) return o.legs.length;
    if (typeof o.legs === 'number') return o.legs;
    return null;
  }).filter(n => Number.isFinite(n) && n > 0);
  const avgLegs = mean(legCounts);

  // Per-confirmed edge metrics
  // offeredProb = implied prob from offered American odds (bettor side)
  // fairProb    = our estimate of true win prob
  // SP edge in pp = (offeredProb - fairProb) * 100  (positive = SP has edge)
  // SP theo EV $ = stake * (1 - fairProb * decimal_odds)
  const edgesPp = []; // unweighted
  let stakeWeightedEdgeNumerator = 0;
  let stakeWeightedEdgeDenominator = 0;
  let theoEvDollars = 0;
  let usedStakeForEv = 0;

  for (const o of confirmed) {
    const oddsAm = Number(o.offered_odds);
    const fairProb = Number(o.fair_parlay_prob);
    const stake = Number(o.confirmed_stake);
    if (!Number.isFinite(oddsAm) || !Number.isFinite(fairProb)
      || fairProb <= 0 || fairProb >= 1 || !Number.isFinite(stake) || stake <= 0) continue;
    const offeredProb = amToProb(oddsAm);
    const dec = amToDec(oddsAm);
    if (offeredProb == null || dec == null) continue;
    const edgePp = (offeredProb - fairProb) * 100;
    const evDollar = stake * (1 - fairProb * dec);
    edgesPp.push(edgePp);
    stakeWeightedEdgeNumerator += stake * edgePp;
    stakeWeightedEdgeDenominator += stake;
    theoEvDollars += evDollar;
    usedStakeForEv += stake;
  }

  const stakeWeightedEdgePp = stakeWeightedEdgeDenominator > 0
    ? stakeWeightedEdgeNumerator / stakeWeightedEdgeDenominator : null;
  const evPerDollarPct = usedStakeForEv > 0 ? (theoEvDollars / usedStakeForEv * 100) : null;

  return {
    ymd,
    fromIso, toIso,
    quoted, confirmedCount, fillRatePct,
    totalStake,
    avgLegs,
    nWithFairProb: edgesPp.length,
    stakeWeightedEdgePp,
    medianEdgePp: pct(edgesPp, 50),
    p25EdgePp: pct(edgesPp, 25),
    p75EdgePp: pct(edgesPp, 75),
    theoEvDollars,
    evPerDollarPct,
    settled: settled.length, stillPending,
    spWon, spLost, pushVoid,
    spWinRatePct,
    spPnlSum, spWonStake, spLostStake,
    avgSpWinPnl, avgSpLossPnl,
  };
}

function fmtPct(p, digits = 2) {
  if (p == null) return '   -   ';
  return p.toFixed(digits) + '%';
}
function fmtPp(p, digits = 2) {
  if (p == null) return '   -    ';
  return (p >= 0 ? '+' : '') + p.toFixed(digits) + 'pp';
}
function fmt$(n) {
  if (n == null) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1000) return sign + '$' + Math.round(abs).toLocaleString();
  return sign + '$' + abs.toFixed(0);
}
function delta(a, b, fmt) {
  if (a == null || b == null) return '   -   ';
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  if (fmt === '$') return sign + fmt$(d);
  if (fmt === '%') return sign + d.toFixed(2) + 'pp';
  if (fmt === 'pp') return sign + d.toFixed(2) + 'pp';
  if (fmt === 'n') return sign + d.toFixed(0);
  if (fmt === 'leg') return sign + d.toFixed(2);
  return sign + d.toFixed(2);
}

(async () => {
  console.log('==========================================================================');
  console.log('   PRICING PERFORMANCE COMPARISON  (ET calendar days)');
  console.log('   ' + dateA + '  vs  ' + dateB);
  console.log('==========================================================================');

  const a = await computeDay(dateA);
  const b = await computeDay(dateB);

  console.log('\nWindow (UTC):');
  console.log('  ' + dateA + ':  ' + a.fromIso + '  →  ' + a.toIso);
  console.log('  ' + dateB + ':  ' + b.fromIso + '  →  ' + b.toIso);

  const rows = [
    ['Metric',                    dateA,                                dateB,                                'Δ (B−A)'],
    ['Quoted (RFQs)',             String(a.quoted),                     String(b.quoted),                     delta(a.quoted, b.quoted, 'n')],
    ['Confirmed (fills)',         String(a.confirmedCount),             String(b.confirmedCount),             delta(a.confirmedCount, b.confirmedCount, 'n')],
    ['Fill rate',                 fmtPct(a.fillRatePct, 2),             fmtPct(b.fillRatePct, 2),             delta(a.fillRatePct, b.fillRatePct, '%')],
    ['Avg legs (fills)',          a.avgLegs?.toFixed(2) ?? '-',         b.avgLegs?.toFixed(2) ?? '-',         delta(a.avgLegs, b.avgLegs, 'leg')],
    ['Total stake',               fmt$(a.totalStake),                   fmt$(b.totalStake),                   delta(a.totalStake, b.totalStake, '$')],
    ['Stake-weighted edge',       fmtPp(a.stakeWeightedEdgePp, 2),      fmtPp(b.stakeWeightedEdgePp, 2),      delta(a.stakeWeightedEdgePp, b.stakeWeightedEdgePp, 'pp')],
    ['Median edge (unweighted)',  fmtPp(a.medianEdgePp, 2),             fmtPp(b.medianEdgePp, 2),             delta(a.medianEdgePp, b.medianEdgePp, 'pp')],
    ['Edge p25 / p75',            fmtPp(a.p25EdgePp, 2) + ' / ' + fmtPp(a.p75EdgePp, 2),
                                   fmtPp(b.p25EdgePp, 2) + ' / ' + fmtPp(b.p75EdgePp, 2), ''],
    ['Theo EV (sum $)',           fmt$(a.theoEvDollars),                fmt$(b.theoEvDollars),                delta(a.theoEvDollars, b.theoEvDollars, '$')],
    ['Theo EV / $ wagered',       fmtPct(a.evPerDollarPct, 3),          fmtPct(b.evPerDollarPct, 3),          delta(a.evPerDollarPct, b.evPerDollarPct, '%')],
    ['Sample size (n with fair_prob)', String(a.nWithFairProb),         String(b.nWithFairProb),              delta(a.nWithFairProb, b.nWithFairProb, 'n')],
    ['',                          '',                                   '',                                   ''],
    ['── SETTLEMENT (confirmed) ──', '',                                '',                                   ''],
    ['Settled / Pending',          `${a.settled} / ${a.stillPending}`,  `${b.settled} / ${b.stillPending}`,   ''],
    ['SP won (bettor lost)',       String(a.spWon),                     String(b.spWon),                      delta(a.spWon, b.spWon, 'n')],
    ['SP lost (bettor won)',       String(a.spLost),                    String(b.spLost),                     delta(a.spLost, b.spLost, 'n')],
    ['Push / void',                String(a.pushVoid),                  String(b.pushVoid),                   delta(a.pushVoid, b.pushVoid, 'n')],
    ['SP win rate (decided)',      fmtPct(a.spWinRatePct, 2),           fmtPct(b.spWinRatePct, 2),            delta(a.spWinRatePct, b.spWinRatePct, '%')],
    ['Avg pnl on SP wins',         fmt$(a.avgSpWinPnl),                 fmt$(b.avgSpWinPnl),                  ''],
    ['Avg pnl on SP losses',       fmt$(a.avgSpLossPnl),                fmt$(b.avgSpLossPnl),                 ''],
    ['Realized P&L (settled)',     fmt$(a.spPnlSum),                    fmt$(b.spPnlSum),                     delta(a.spPnlSum, b.spPnlSum, '$')],
  ];

  // Compute col widths
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < 4; i++) {
      widths[i] = Math.max(widths[i], String(row[i]).length);
    }
  }
  console.log('');
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const line = [
      row[0].padEnd(widths[0]),
      row[1].padStart(widths[1]),
      row[2].padStart(widths[2]),
      row[3].padStart(widths[3]),
    ].join('   ');
    console.log('  ' + line);
    if (r === 0) console.log('  ' + '─'.repeat(line.length));
  }

  console.log('\nDefinitions:');
  console.log('  Fill rate            = confirmed / quoted (parlay-level, excludes RFQs that pre-declined)');
  console.log('  Edge (pp)            = offered_implied_prob − fair_parlay_prob  (positive = SP charged vig)');
  console.log('  Stake-weighted edge  = Σ(stake × edge) / Σ(stake)  on confirmed parlays');
  console.log('  Theo EV $            = Σ stake × (1 − fair_prob × decimal_odds)  on confirmed parlays');
  console.log('  EV / $ wagered       = Theo EV $ / total confirmed stake');
  console.log('');
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
