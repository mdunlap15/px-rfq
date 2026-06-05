// Rev 7: set Rick's gross stake to a fixed $2,500.
//
// Operator directive (2026-06-04): "Make Rick's gross stake $2500. Starting from
// all parlays confirmed at 1:30am ET 6/4/26, his share of additional P&L will be
// 2500 / 49010.31." So:
//   - Cutoff = 2026-06-04T05:30:00Z (1:30am EDT, UTC-4).
//   - Rick's equity is SET to $2,500 (not a fixed transfer delta — we solve for
//     whatever Mike->Rick adjustment lands Rick at exactly $2,500).
//   - Parlays confirmed >= cutoff split at the new postRatio (Rick = 2500/equity).
//   - Parlays confirmed < cutoff but still open settle at the ratio in force when
//     they were placed (carried via preCohort + legacyCohorts).
//
// THREE-TIER CARRYOVER (chains rev-6 forward):
//   legacyCohorts[0] = rev-6's rev-4-era stragglers still open  -> rev-4 ratio
//   legacyCohorts[1] = rev-6's preCohort (rev-5-era opens) still open -> rev-5 ratio
//   preCohortIds     = rev-6-era opens (confirmed between rev-6 and rev-7 cutoffs,
//                      still open) -> rev-6 postRatio
//   postRatio        = NEW (Rick = 2500 / snapshotEquity) for anything after cutoff
//
// Baseline (snapshotMike/Rick): replay rev-6 books to the rev-7 cutoff, attributing
// each settled parlay's pnl by its rev-6 cohort (legacy-first, then pre, then post)
// — same logic as the /bankroll endpoint. Path-dependent and accurate.
//
// SAFETY: dry-run by DEFAULT. Pass --commit to actually write kv_store. Always run
// without --commit first and eyeball the printed numbers (esp. that the replayed
// equity lands near the stated $49,010.31 and Rick's share near 5.101%).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SNAPSHOT_AT      = '2026-06-04T05:30:00.000Z'; // 1:30am EDT on 2026-06-04
const RICK_TARGET      = 2500;                       // Rick's new gross stake ($)
const STATED_EQUITY    = 49010.31;                   // operator's stated total (sanity check)
const STATED_RICK_SHARE = RICK_TARGET / STATED_EQUITY; // 0.051010 expected
const COMMIT           = process.argv.includes('--commit');
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // 1. Load rev-6 snapshot.
  const { data: kv, error: kvErr } = await sb.from('kv_store').select('value').eq('key', 'bankroll_state').single();
  if (kvErr) { console.error('kv_store read failed:', kvErr.message); process.exit(1); }
  const rev6 = kv.value;
  if (rev6.version !== 6) { console.error('Expected rev-6, got rev-' + rev6.version + '. Aborting — chain a fresh rev on top of the latest.'); process.exit(1); }
  console.log('Rev-6 baseline:');
  console.log('  snapshotMike:', rev6.snapshotMike, 'snapshotRick:', rev6.snapshotRick);
  console.log('  preRatio (rev-5):', rev6.preRatio);
  console.log('  postRatio (rev-6):', rev6.postRatio);
  console.log('  legacyCohorts:', (rev6.legacyCohorts || []).map(c => `${c.ids.length}@${(c.ratio.mike*100).toFixed(3)}/${(c.ratio.rick*100).toFixed(3)}`).join(', ') || 'none');

  const rev6LegacyCohorts = (rev6.legacyCohorts || []).map(c => ({ ids: new Set(c.ids || []), ratio: c.ratio, note: c.note }));
  const rev6PreIds = new Set(rev6.preCohortIds || []);

  // 2. Replay rev-6 books -> rev-7 cutoff. Attribute each settled parlay by its
  //    rev-6 cohort: legacy-first (most specific), then pre, then post. Mirrors
  //    the /bankroll endpoint exactly.
  const settled = [];
  {
    // settled_at is NOT indexed — range/sort queries on it hit Supabase's
    // statement_timeout (full scan). Instead page ALL settled rows by parlay_id
    // (the PK, index-backed → each page is fast) and filter the
    // [rev6.snapshotAt, SNAPSHOT_AT] window in JS. Retry per page for transient
    // timeouts; accumulation below dedupes by parlay_id.
    const startIso = rev6.snapshotAt, endIso = SNAPSHOT_AT, MAX_RETRY = 5;
    let off = 0;
    while (off < 200000) {
      let data = null, err = null;
      for (let a = 0; a < MAX_RETRY; a++) {
        const res = await sb.from('parlay_orders')
          .select('parlay_id, pnl, status, settled_at')
          .like('status', 'settled_%')
          .not('pnl', 'is', null)
          .order('parlay_id', { ascending: true })
          .range(off, off + 999);
        if (!res.error) { data = res.data; err = null; break; }
        err = res.error;
        console.warn(`  settled fetch offset ${off} attempt ${a + 1}/${MAX_RETRY}: ${err.message} — retrying`);
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, a)));
      }
      if (err) { console.error('settled fetch failed after retries:', err.message); process.exit(1); }
      if (!data || !data.length) break;
      for (const r of data) {
        if (r.settled_at && r.settled_at >= startIso && r.settled_at <= endIso) settled.push(r);
      }
      if (data.length < 1000) break;
      off += 1000;
    }
  }
  let mikeDelta = 0, rickDelta = 0;
  let legacyN = 0, preN = 0, postN = 0;
  const _seenParlay = new Set();
  for (const r of settled) {
    if (_seenParlay.has(r.parlay_id)) continue; // guard against boundary dupes
    _seenParlay.add(r.parlay_id);
    const p = Number(r.pnl) || 0;
    let ratio = null, bucket = '';
    for (const lc of rev6LegacyCohorts) {
      if (lc.ids.has(r.parlay_id)) { ratio = lc.ratio; bucket = 'legacy'; break; }
    }
    if (!ratio) {
      if (rev6PreIds.has(r.parlay_id)) { ratio = rev6.preRatio; bucket = 'pre'; }
      else                              { ratio = rev6.postRatio; bucket = 'post'; }
    }
    mikeDelta += ratio.mike * p;
    rickDelta += ratio.rick * p;
    if (bucket === 'legacy') legacyN++; else if (bucket === 'pre') preN++; else postN++;
  }
  const mikeAtCutoff = rev6.snapshotMike + mikeDelta;
  const rickAtCutoff = rev6.snapshotRick + rickDelta;
  const equity = mikeAtCutoff + rickAtCutoff;
  console.log('\nReplay rev-6 -> rev-7 cutoff:');
  console.log('  settled parlays:', settled.length, `(legacy:${legacyN} pre:${preN} post:${postN})`);
  console.log('  Mike at cutoff (pre-adjustment): $' + mikeAtCutoff.toFixed(2));
  console.log('  Rick at cutoff (pre-adjustment): $' + rickAtCutoff.toFixed(2));
  console.log('  Replayed total equity:           $' + equity.toFixed(2));
  console.log('  Operator-stated equity:          $' + STATED_EQUITY.toFixed(2) + '  (drift $' + (equity - STATED_EQUITY).toFixed(2) + ')');
  if (Math.abs(equity - STATED_EQUITY) > 50) {
    console.log('  ⚠ Replayed equity drifts > $50 from your stated $49,010.31 — review before committing.');
  }

  // 3. Set Rick to the target stake; Mike absorbs the rest (total unchanged).
  const RICK_POST = RICK_TARGET;
  const MIKE_POST = equity - RICK_TARGET;
  const impliedTransfer = rickAtCutoff - RICK_TARGET; // Mike buys this much of Rick's stake
  console.log('\nApply fixed target: Rick = $' + RICK_TARGET.toFixed(2));
  console.log('  Implied Mike<-Rick stake purchase: $' + impliedTransfer.toFixed(2) + ' (Mike\'s personal cash to Rick)');
  console.log('  Mike post: $' + MIKE_POST.toFixed(2));
  console.log('  Rick post: $' + RICK_POST.toFixed(2));

  const POST_RATIO = { mike: MIKE_POST / equity, rick: RICK_POST / equity };
  console.log('  New postRatio: mike ' + (POST_RATIO.mike*100).toFixed(4) + '% / rick ' + (POST_RATIO.rick*100).toFixed(4) + '%');
  console.log('  (you expected Rick ' + (STATED_RICK_SHARE*100).toFixed(4) + '% = 2500/49010.31)');

  // 4. Carry forward rev-6's still-open cohorts. A parlay is "still open at the
  //    cutoff" if it's confirmed (unsettled) OR settled after the cutoff.
  const isOpenAtCutoff = (r) => r.status === 'confirmed' || (r.settled_at && r.settled_at > SNAPSHOT_AT);

  // 4a. rev-6 legacy tiers (rev-4 stragglers) still open -> carry at their ratio.
  const newLegacy = [];
  for (const lc of rev6LegacyCohorts) {
    const ids = [...lc.ids];
    if (!ids.length) continue;
    const { data } = await sb.from('parlay_orders').select('parlay_id, status, settled_at').in('parlay_id', ids);
    const stillOpen = (data || []).filter(isOpenAtCutoff).map(r => r.parlay_id);
    if (stillOpen.length) {
      newLegacy.push({ ids: stillOpen, ratio: lc.ratio, note: (lc.note || 'rev-6 legacy') + ' (carried into rev-7)' });
      console.log('\nCarry legacy tier @ ' + (lc.ratio.mike*100).toFixed(3) + '/' + (lc.ratio.rick*100).toFixed(3) + ':', stillOpen.length, 'still open');
    }
  }

  // 4b. rev-6 preCohort (rev-5-era opens) still open -> new legacy tier at rev-6.preRatio.
  let preStillOpen = [];
  if (rev6.preCohortIds && rev6.preCohortIds.length) {
    const { data } = await sb.from('parlay_orders').select('parlay_id, status, settled_at').in('parlay_id', rev6.preCohortIds);
    preStillOpen = (data || []).filter(isOpenAtCutoff).map(r => r.parlay_id);
    if (preStillOpen.length) {
      newLegacy.push({ ids: preStillOpen, ratio: rev6.preRatio, note: 'rev-5-era opens (was rev-6 preCohort), carried into rev-7 at rev-5 postRatio' });
      console.log('Carry rev-5 tier @ ' + (rev6.preRatio.mike*100).toFixed(3) + '/' + (rev6.preRatio.rick*100).toFixed(3) + ':', preStillOpen.length, 'still open');
    }
  }

  // 5. rev-7 preCohort = parlays confirmed [rev-6 cutoff, rev-7 cutoff) still open.
  //    They were placed under rev-6 postRatio -> preRatio = rev6.postRatio.
  const between = [];
  {
    let offset = 0;
    while (true) {
      const { data, error } = await sb.from('parlay_orders')
        .select('parlay_id, confirmed_at, status, settled_at, confirmed_stake')
        .gte('confirmed_at', rev6.snapshotAt)
        .lt('confirmed_at', SNAPSHOT_AT)
        .order('confirmed_at', { ascending: true })
        .range(offset, offset + 999);
      if (error) { console.error('between fetch:', error.message); process.exit(1); }
      if (!data || !data.length) break;
      between.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  const newOpens = between.filter(isOpenAtCutoff);
  const preCohortIds = newOpens.map(r => r.parlay_id);
  const preCohortStake = newOpens.reduce((s, r) => s + (Number(r.confirmed_stake) || 0), 0);
  console.log('\nRev-7 preCohort (rev-6-era opens, @ ' + (rev6.postRatio.mike*100).toFixed(3) + '/' + (rev6.postRatio.rick*100).toFixed(3) + '):', preCohortIds.length, 'stake $' + preCohortStake.toFixed(2));

  // 6. Build rev-7 snapshot.
  const snapshot = {
    version: 7,
    snapshotAt: SNAPSHOT_AT,
    snapshotEquity: r2(equity),
    snapshotMike:   r2(MIKE_POST),
    snapshotRick:   r2(RICK_POST),
    preCohortIds,
    preCohortStakeAtSnapshot: r2(preCohortStake),
    preRatio:  { mike: rev6.postRatio.mike, rick: rev6.postRatio.rick }, // rev-6 postRatio
    postRatio: POST_RATIO,
    legacyCohorts: newLegacy.map(c => ({ ids: c.ids, ratio: c.ratio, note: c.note })),
    pendingWithdrawal: null,
    capitalEvents: [
      ...(rev6.capitalEvents || []),
      {
        type: 'set_stake',
        from: 'rick',
        to: 'mike',
        amount: r2(impliedTransfer),
        at: SNAPSHOT_AT,
        note: 'Operator set Rick\'s gross stake to $2,500 (down from ~$' + rickAtCutoff.toFixed(0) + '). Mike bought the difference with personal cash; PX/total untouched.',
      },
    ],
    supersedes: [
      ...(rev6.supersedes || []),
      { version: 6, note: 'rev-6 superseded by rev-7 set-stake (Rick -> $2,500) effective 1:30am ET 6/4' },
    ],
    notes: 'Rev 7: Rick gross stake set to $2,500 effective 1:30am ET (05:30Z) 2026-06-04. preCohort = rev-6-era opens at rev-6 postRatio; legacyCohorts carry the still-open rev-4 + rev-5 tiers at their original ratios; new postRatio (Rick = 2500/equity) applies to anything confirmed at/after the cutoff.',
  };

  console.log('\n=== Rev-7 snapshot ===');
  console.log('  version 7 @ ' + snapshot.snapshotAt);
  console.log('  equity $' + snapshot.snapshotEquity + ' | mike $' + snapshot.snapshotMike + ' (' + (POST_RATIO.mike*100).toFixed(3) + '%) | rick $' + snapshot.snapshotRick + ' (' + (POST_RATIO.rick*100).toFixed(3) + '%)');
  console.log('  preCohort ' + preCohortIds.length + ' @ ' + (snapshot.preRatio.mike*100).toFixed(3) + '/' + (snapshot.preRatio.rick*100).toFixed(3));
  console.log('  legacyCohorts: ' + snapshot.legacyCohorts.map(c => `${c.ids.length}@${(c.ratio.mike*100).toFixed(3)}/${(c.ratio.rick*100).toFixed(3)}`).join(', '));

  if (!COMMIT) {
    console.log('\n[dry-run] Pass --commit to write kv_store["bankroll_state"]. Review the numbers above first.');
    return;
  }
  const { error } = await sb.from('kv_store').upsert({ key: 'bankroll_state', value: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) { console.error('Upsert error:', error.message); process.exit(1); }
  console.log('\n✓ Saved rev-7 to kv_store["bankroll_state"]');
  const { data: check } = await sb.from('kv_store').select('value').eq('key', 'bankroll_state').single();
  console.log('  verified version:', check.value.version, '| rick $' + check.value.snapshotRick + ' (' + (check.value.postRatio.rick*100).toFixed(3) + '%)');
})();
