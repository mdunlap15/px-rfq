// Counterparty (creator_id) performance report — fetches /creators/stats
// from the running service and presents a sortable summary.
//
// Usage:
//   node scripts/_creator_report.js [--days N] [--min N] [--sort col] [--top N]
//
// Defaults: --days 60 --min 5 --sort bettorRoi --top 25

require('dotenv').config();
const URL = process.env.PROD_URL || 'https://prophetx-rfq-production-6781.up.railway.app';
const USER = process.env.AUTH_USERNAME;
const PASS = process.env.AUTH_PASSWORD;
if (!USER || !PASS) { console.error('AUTH_USERNAME/PASSWORD needed'); process.exit(1); }

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  return args[i + 1];
}
const days = Number(flag('--days', 60));
const min = Number(flag('--min', 5));
const sort = flag('--sort', 'bettorRoi');
const top = Number(flag('--top', 25));

function fmt$(n, d = 0) {
  if (n == null) return '   -';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + '$' + (abs >= 1000 ? Math.round(abs).toLocaleString() : abs.toFixed(d));
}
function pct(p, d = 1) { return p == null ? '  -  ' : (p >= 0 ? '+' : '') + (p * 100).toFixed(d) + '%'; }
function pctPos(p, d = 1) { return p == null ? '  -  ' : (p * 100).toFixed(d) + '%'; }

(async () => {
  const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
  const url = `${URL}/creators/stats?days=${days}&min=${min}&refresh=1`;
  console.log(`Fetching ${url}`);
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) { console.error('HTTP', r.status, await r.text()); process.exit(1); }
  const data = await r.json();

  console.log('');
  console.log('='.repeat(140));
  console.log(`  COUNTERPARTY PERFORMANCE — last ${data.days} days, min ${data.minFills} fills`);
  console.log(`  Source: ${URL} · As-of ${data.asOfUtc}`);
  console.log('='.repeat(140));

  const creators = data.creators || [];
  if (creators.length === 0) { console.log('\n  No creators above threshold.'); return; }

  // Sort
  const sortFns = {
    bettorRoi:    (a, b) => (b.bettorRoi || 0) - (a.bettorRoi || 0),
    spRoi:        (a, b) => (b.spRoi || 0) - (a.spRoi || 0),
    fills:        (a, b) => (b.fills || 0) - (a.fills || 0),
    totalStake:   (a, b) => (b.totalStake || 0) - (a.totalStake || 0),
    pnl:          (a, b) => (b.pnl || 0) - (a.pnl || 0),
    bettorHitRate:(a, b) => (b.bettorHitRate || 0) - (a.bettorHitRate || 0),
    lastSeen:     (a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0),
  };
  const sortFn = sortFns[sort] || sortFns.bettorRoi;
  creators.sort(sortFn);

  // Totals
  const totals = creators.reduce((t, c) => ({
    fills: t.fills + (c.fills || 0),
    settled: t.settled + (c.settled || 0),
    wins: t.wins + (c.wins || 0),
    losses: t.losses + (c.losses || 0),
    pushes: t.pushes + (c.pushes || 0),
    totalStake: t.totalStake + (c.totalStake || 0),
    pnl: t.pnl + (c.pnl || 0),
  }), { fills: 0, settled: 0, wins: 0, losses: 0, pushes: 0, totalStake: 0, pnl: 0 });
  const overallBettorHitRate = totals.settled > 0 ? totals.losses / (totals.wins + totals.losses) : 0;
  // SP perspective: wins = SP wins (bettor loses), losses = SP loses (bettor wins)
  // For BETTOR perspective: bettor hits = SP losses
  const overallSpRoi = totals.totalStake > 0 ? totals.pnl / totals.totalStake : 0;
  const overallBettorRoi = -overallSpRoi;

  console.log('');
  console.log(`  Sorted by: ${sort} desc (top ${Math.min(top, creators.length)} of ${creators.length} creators)`);
  console.log('');
  console.log('  ' + 'CreatorID (short)'.padEnd(14)
    + ' Fills'.padStart(7)
    + ' Settl'.padStart(7)
    + '  W/L/P'.padStart(11)
    + '  TotStake'.padStart(11)
    + '  SP P&L'.padStart(10)
    + '  SP ROI'.padStart(9)
    + ' BetROI'.padStart(8)
    + ' BetHit%'.padStart(9)
    + '  First'.padStart(7)
    + '  Last'.padStart(7));
  console.log('  ' + '─'.repeat(110));

  const slice = creators.slice(0, top);
  for (const c of slice) {
    const idShort = (c.creatorId || '(no-id)').slice(0, 12);
    const wlp = `${c.wins}/${c.losses}/${c.pushes}`;
    const firstD = c.firstSeen ? new Date(c.firstSeen).toISOString().slice(5, 10) : '   -';
    const lastD = c.lastSeen ? new Date(c.lastSeen).toISOString().slice(5, 10) : '   -';
    // Highlight sharps: bettor ROI > 0 with enough fills
    const isSharp = c.bettorRoi > 0 && c.fills >= 10;
    const flag = isSharp ? ' 🔥' : '';
    console.log('  ' + idShort.padEnd(14)
      + String(c.fills).padStart(7)
      + String(c.settled).padStart(7)
      + ('  ' + wlp).padStart(11)
      + fmt$(c.totalStake).padStart(11)
      + fmt$(c.pnl).padStart(10)
      + pct(c.spRoi != null ? c.spRoi : (c.totalStake > 0 ? c.pnl / c.totalStake : null)).padStart(9)
      + pct(c.bettorRoi).padStart(8)
      + pctPos(c.bettorHitRate).padStart(9)
      + ('  ' + firstD).padStart(7)
      + ('  ' + lastD).padStart(7)
      + flag);
  }

  console.log('');
  console.log('  ' + '─'.repeat(110));
  console.log(`  TOTALS:           ${String(totals.fills).padStart(7)}${String(totals.settled).padStart(7)}  ${totals.wins}/${totals.losses}/${totals.pushes}`
    + `  ${fmt$(totals.totalStake)}  ${fmt$(totals.pnl)}  ${pct(overallSpRoi)}  ${pct(overallBettorRoi)}  ${pctPos(overallBettorHitRate)}`);

  // Sharps callout
  const sharps = creators.filter(c => c.bettorRoi > 0 && c.fills >= 10);
  if (sharps.length > 0) {
    console.log('');
    console.log(`  🔥 ${sharps.length} sharp counterparty(ies) (bettor ROI > 0 with ≥10 fills):`);
    sharps.sort((a, b) => (b.bettorRoi || 0) - (a.bettorRoi || 0));
    for (const s of sharps.slice(0, 20)) {
      console.log(`     ${s.creatorId.slice(0, 12)}  fills=${s.fills}  stake=${fmt$(s.totalStake)}  SP pnl=${fmt$(s.pnl)}  bettorROI=${pct(s.bettorRoi)}  hit%=${pctPos(s.bettorHitRate)}`);
    }
  }

  // Top stake exposure callout
  const stakeSorted = [...creators].sort((a, b) => (b.totalStake || 0) - (a.totalStake || 0));
  console.log('');
  console.log(`  Top 10 by total stake (volume concentration):`);
  for (const c of stakeSorted.slice(0, 10)) {
    console.log(`     ${c.creatorId.slice(0, 12)}  fills=${c.fills}  stake=${fmt$(c.totalStake)}  SP pnl=${fmt$(c.pnl)}  bettorROI=${pct(c.bettorRoi)}`);
  }

  console.log('');
  console.log('  Definitions:');
  console.log('    SP P&L           = realized P&L for us on settled parlays (positive = we won net)');
  console.log('    SP ROI / Bet ROI = P&L / total stake; bettor ROI = -SP ROI');
  console.log('    Bet Hit%         = fraction of decided parlays where the bettor won (= SP lost)');
  console.log('    🔥 sharp flag    = bettor ROI > 0 with ≥10 fills (high-confidence positive expectation for bettor)');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
