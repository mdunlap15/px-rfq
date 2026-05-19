// Rev 6: Mike's third personal $5K distribution to Rick.
//
// 2026-05-19T03:59:00Z (23:59 ET on 2026-05-18). Cumulative Mike→Rick
// personal distributions now $12,500 ($2,500 rev-4 + $5,000 rev-5 + $5,000
// rev-6). PX cash untouched; ownership shifts inside the partnership.
//
// MULTI-TIER COHORT (first time we need it):
//   - 3 parlays from rev-4 era are STILL open at rev-6 cutoff → must
//     settle at rev-4 postRatio (0.62924 / 0.37076). Stored as
//     legacyCohorts[0] so the /bankroll formula gives them the right ratio.
//   - 23 parlays confirmed under rev-5 are still open at rev-6 cutoff →
//     settle at rev-5 postRatio (0.69983 / 0.30017). Stored as the
//     standard preCohortIds with preRatio = rev-5 postRatio.
//   - Everything confirmed after the rev-6 cutoff → settles at the new
//     post-rev-6 ratio.
//
// Baseline (snapshotMike/Rick): replay rev-5 books to the rev-6 cutoff —
// settled parlays between rev-5 and rev-6 cutoffs, split by rev-5 cohort
// (preRatio for those in rev-5 preCohortIds, postRatio for the rest).
// Path-dependent and accurate.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SNAPSHOT_AT = '2026-05-19T03:59:00.000Z';   // 23:59 ET on 2026-05-18
const TRANSFER    = 5000;                          // Mike -> Rick personal

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // 1. Load rev-5 snapshot
  const { data: kv } = await sb.from('kv_store').select('value').eq('key', 'bankroll_state').single();
  const rev5 = kv.value;
  if (rev5.version !== 5) { console.error('Expected rev-5, got rev-' + rev5.version); process.exit(1); }
  console.log('Rev-5 baseline:');
  console.log('  snapshotMike:', rev5.snapshotMike, 'snapshotRick:', rev5.snapshotRick);
  console.log('  preRatio :', rev5.preRatio);
  console.log('  postRatio:', rev5.postRatio);

  // 2. Replay rev-5 books to rev-6 cutoff
  const rev5PreIds = new Set(rev5.preCohortIds);
  const settled = [];
  {
    let offset = 0;
    while (true) {
      const { data } = await sb.from('parlay_orders')
        .select('parlay_id, pnl, status, settled_at')
        .gte('settled_at', rev5.snapshotAt)
        .lte('settled_at', SNAPSHOT_AT)
        .in('status', ['settled_won','settled_lost','settled_push'])
        .order('settled_at', { ascending: true })
        .range(offset, offset+999);
      if (!data || !data.length) break;
      settled.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  let prePnl = 0, postPnl = 0, preN = 0, postN = 0;
  for (const r of settled) {
    const p = Number(r.pnl) || 0;
    if (rev5PreIds.has(r.parlay_id)) { prePnl += p; preN++; }
    else                              { postPnl += p; postN++; }
  }
  const mikeAtCutoff = rev5.snapshotMike + rev5.preRatio.mike * prePnl + rev5.postRatio.mike * postPnl;
  const rickAtCutoff = rev5.snapshotRick + rev5.preRatio.rick * prePnl + rev5.postRatio.rick * postPnl;
  console.log('\nReplay rev-5 → rev-6 cutoff:');
  console.log('  settled:', settled.length, '(pre:', preN, 'post:', postN, ')');
  console.log('  prePnl: $' + prePnl.toFixed(2), 'postPnl: $' + postPnl.toFixed(2));
  console.log('  Mike at cutoff (pre-transfer):', mikeAtCutoff.toFixed(2));
  console.log('  Rick at cutoff (pre-transfer):', rickAtCutoff.toFixed(2));

  // 3. Apply $5K Mike→Rick transfer (Mike buys Rick's stake; Mike's share UP)
  const MIKE_POST = mikeAtCutoff + TRANSFER;
  const RICK_POST = rickAtCutoff - TRANSFER;
  const SNAPSHOT_EQUITY = MIKE_POST + RICK_POST;
  console.log('\nAfter $5K transfer:');
  console.log('  Mike post: $' + MIKE_POST.toFixed(2));
  console.log('  Rick post: $' + RICK_POST.toFixed(2));
  console.log('  Total:     $' + SNAPSHOT_EQUITY.toFixed(2));

  // 4. Identify legacy stragglers (rev-5 preCohortIds still open at rev-6 cutoff).
  //    They were quoted under rev-4 postRatio → carry that ratio forward via legacyCohorts.
  const rev5PreList = rev5.preCohortIds;
  const { data: legacyCheck } = await sb.from('parlay_orders')
    .select('parlay_id, status, settled_at, confirmed_stake')
    .in('parlay_id', rev5PreList);
  const legacyStillOpen = (legacyCheck || []).filter(r =>
    r.status === 'confirmed' || (r.settled_at && r.settled_at > SNAPSHOT_AT)
  );
  console.log('\nLegacy stragglers (rev-4-era, still open at rev-6 cutoff):', legacyStillOpen.length);
  for (const r of legacyStillOpen) console.log('  -', r.parlay_id, 'stake $' + Number(r.confirmed_stake).toFixed(2));

  // 5. Rev-6 pre-cohort = parlays confirmed under rev-5 (between rev-5 and rev-6
  //    cutoffs) still open at the rev-6 cutoff. These split at rev-5's postRatio.
  const { data: between } = await sb.from('parlay_orders')
    .select('parlay_id, confirmed_at, status, settled_at, confirmed_stake')
    .gte('confirmed_at', rev5.snapshotAt)
    .lte('confirmed_at', SNAPSHOT_AT);
  const newOpens = (between || []).filter(r =>
    r.status === 'confirmed' || (r.settled_at && r.settled_at > SNAPSHOT_AT)
  );
  const preCohortIds = newOpens.map(r => r.parlay_id);
  const preCohortStake = newOpens.reduce((s, r) => s + (Number(r.confirmed_stake) || 0), 0);
  console.log('\nRev-6 pre-cohort (rev-5-era opens):', preCohortIds.length, 'stake $' + preCohortStake.toFixed(2));

  // 6. Build rev-6 snapshot
  const PRE_RATIO  = { mike: rev5.postRatio.mike, rick: rev5.postRatio.rick }; // = rev-5 postRatio
  const POST_RATIO = {
    mike: MIKE_POST / SNAPSHOT_EQUITY,
    rick: RICK_POST / SNAPSHOT_EQUITY,
  };

  const snapshot = {
    version: 6,
    snapshotAt: SNAPSHOT_AT,
    snapshotEquity: Math.round(SNAPSHOT_EQUITY * 100) / 100,
    snapshotMike:   Math.round(MIKE_POST       * 100) / 100,
    snapshotRick:   Math.round(RICK_POST       * 100) / 100,
    preCohortIds,
    preCohortStakeAtSnapshot: Math.round(preCohortStake * 100) / 100,
    preRatio:  PRE_RATIO,
    postRatio: POST_RATIO,
    // Multi-tier: rev-4-era stragglers carry their original ratio so they
    // split correctly when they finally settle.
    legacyCohorts: legacyStillOpen.length > 0 ? [
      {
        ids: legacyStillOpen.map(r => r.parlay_id),
        ratio: { mike: 0.6292382202394549, rick: 0.3707617797605451 }, // rev-4 postRatio
        note: 'rev-4 postRatio carryover: parlays placed before 2026-05-18T03:59:00Z that were still open at rev-6 cutoff',
      },
    ] : [],
    pendingWithdrawal: null,
    capitalEvents: [
      ...(rev5.capitalEvents || []),
      {
        type: 'external_transfer',
        from: 'mike',
        to: 'rick',
        amount: TRANSFER,
        at: SNAPSHOT_AT,
        note: 'Mike paid Rick another $5,000 from a personal account. PX untouched; ownership shifts in-account. Cumulative Mike→Rick personal = $12,500.',
      },
    ],
    supersedes: [
      ...(rev5.supersedes || []),
      { version: 5, note: 'rev-5 $5,000 transfer; superseded by rev-6 $5,000 retro to 23:59 ET 5/18' },
    ],
    notes: 'Rev 6: Mike\'s third $5K personal distribution to Rick, retroactive to 23:59 ET on 2026-05-18. First multi-tier snapshot: 3 rev-4-era stragglers carried in legacyCohorts (0.62924/0.37076), 23 rev-5-era opens in preCohortIds (rev-5 postRatio 0.69983/0.30017), new postRatio applies to anything confirmed after rev-6 cutoff.',
  };

  console.log('\nRev-6 snapshot summary:');
  console.log('  version:', snapshot.version, 'at', snapshot.snapshotAt);
  console.log('  equity: $' + snapshot.snapshotEquity);
  console.log('  mike: $' + snapshot.snapshotMike, '(' + (snapshot.postRatio.mike*100).toFixed(3) + '%)');
  console.log('  rick: $' + snapshot.snapshotRick, '(' + (snapshot.postRatio.rick*100).toFixed(3) + '%)');
  console.log('  legacyCohorts:', (snapshot.legacyCohorts || []).map(c => `${c.ids.length} ids @ ${(c.ratio.mike*100).toFixed(3)}/${(c.ratio.rick*100).toFixed(3)}`));
  console.log('  preCohort:', snapshot.preCohortIds.length, 'ids @', (snapshot.preRatio.mike*100).toFixed(3) + '/' + (snapshot.preRatio.rick*100).toFixed(3));
  console.log('  postRatio:', (snapshot.postRatio.mike*100).toFixed(3) + '/' + (snapshot.postRatio.rick*100).toFixed(3));

  if (process.argv.includes('--dry-run')) {
    console.log('\n[dry-run] not writing to kv_store');
    return;
  }

  const { error } = await sb.from('kv_store').upsert({
    key: 'bankroll_state',
    value: snapshot,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (error) { console.error('Upsert error:', error.message); process.exit(1); }
  console.log('\n✓ Saved rev-6 to kv_store["bankroll_state"]');

  const { data: check } = await sb.from('kv_store').select('value').eq('key', 'bankroll_state').single();
  console.log('  verified version:', check.value.version);
  console.log('  verified preCohortIds count:', check.value.preCohortIds.length);
  console.log('  verified legacyCohorts:', (check.value.legacyCohorts || []).length);
})();
