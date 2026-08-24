#!/usr/bin/env node
/**
 * Operational health monitor — quote rates, fill rates, decline mix, and the
 * specific markets touched by a parameter change.
 *
 * Built 2026-08-23 after a day of parameter changes (prop risk cap 6000->3000,
 * strikeouts and WNBA rebounds/assists de-allowlisted, F5 min-book floor, F5
 * book-list widening, in-play event guard). Several of those cut volume ON
 * PURPOSE, so the question is never "did volume fall" but "did the RIGHT volume
 * fall, and did anything else move that we did not intend".
 *
 *   node scripts/monitor-health.js [--days 2] [--baseline 7] [--json]
 *
 * Compares a RECENT window against a BASELINE window that ends where the recent
 * one begins, and prints per-sport and per-market quote/fill rates plus the
 * decline mix. Read-only: touches parlay_orders and declines, writes nothing.
 *
 * Caveats baked in deliberately:
 *  - Fill rate here is fills/quotes, which is dominated by RFQs nobody filled.
 *    It is a CHANGE detector, not a measure of competitiveness. For "how often
 *    do we win an auction that cleared" you need matched_parlays.we_quoted.
 *  - A parlay counts under every sport and market it touches, so rows overlap
 *    and do not sum to the total.
 *  - Windows are by quoted_at. Fills settle later, so the newest hours always
 *    look slightly under-filled; keep --days >= 2 or expect a low bias.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const argv = process.argv.slice(2);
const argNum = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const DAYS = argNum('--days', 2);
const BASE = argNum('--baseline', 7);
const AS_JSON = argv.includes('--json');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Supabase occasionally throws a Cloudflare 525 on a cold connection; a bare
// query failure would otherwise read as "zero quotes", which is exactly the
// alarm this tool exists to raise. Retry before believing a zero.
async function retry(fn, label) {
  let lastErr = null;
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fn();
      if (!r.error) return r;
      lastErr = r.error;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, a)));
  }
  throw new Error(`${label}: ${(lastErr && lastErr.message) || 'unknown'}`);
}

async function pageOrders(fromIso, toIso) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 400; p++) {
    const r = await retry(() => {
      let b = sb.from('parlay_orders')
        .select('parlay_id,status,legs,confirmed_stake,quoted_at,meta')
        .gte('quoted_at', fromIso).lt('quoted_at', toIso);
      if (cursor) b = b.gt('quoted_at', cursor);
      return b.order('quoted_at').limit(1000);
    }, 'parlay_orders');
    if (!r.data.length) break;
    out.push(...r.data);
    cursor = r.data[r.data.length - 1].quoted_at;
    if (r.data.length < 1000) break;
  }
  return out;
}

const SPORT = (l) => {
  const s = String(l.sport || '');
  if (s.startsWith('golf')) return 'golf';
  if (s.startsWith('mma')) return 'mma';
  if (s.startsWith('soccer')) return 'soccer';
  return s || '?';
};
const MARKET = (l) => l.market || l.marketType || '?';
const isFilled = (r) => r.status === 'confirmed' || String(r.status).startsWith('settled');

// Explicit expectations from the 2026-08-23 parameter changes. A silent
// regression here looks exactly like normal volume drift, so assert it rather
// than eyeball the tables. `since` guards each one so a window that predates
// the change does not report a false failure.
const ASSERTIONS = [
  { label: 'strikeout props not quoted', since: '2026-08-23T23:38:00Z',
    test: (rows) => countLegs(rows, (l) => MARKET(l) === 'player_strikeouts'),
    want: 0, why: 'removed from PROP_LAUNCH_ALLOWLIST 2026-08-23' },
  { label: 'WNBA rebounds not quoted', since: '2026-08-24T00:05:00Z',
    test: (rows) => countLegs(rows, (l) => MARKET(l) === 'player_rebounds' && l.sport === 'basketball_wnba'),
    want: 0, why: 'removed from PROP_LAUNCH_ALLOWLIST 2026-08-24' },
  { label: 'WNBA assists not quoted', since: '2026-08-24T00:05:00Z',
    test: (rows) => countLegs(rows, (l) => MARKET(l) === 'player_assists' && l.sport === 'basketball_wnba'),
    want: 0, why: 'removed from PROP_LAUNCH_ALLOWLIST 2026-08-24' },
  { label: 'no prop fill over the $3,000 cap', since: '2026-08-23T23:30:00Z',
    test: (rows) => rows.filter((r) => isFilled(r)
      && (r.legs || []).some((l) => String(MARKET(l)).startsWith('player_'))
      && Number(r.confirmed_stake || 0) > 3000).length,
    want: 0, why: 'MAX_RISK_PER_PARLAY_WITH_PROP lowered 6000 -> 3000' },
  // F5 should SHRINK, not vanish: the min-book floor declines thin markets
  // while the widened book list should keep most games priceable. Zero would
  // mean the widening failed and the floor is rejecting everything.
  { label: 'F5 still quoting (reduced, not dead)', since: '2026-08-23T23:23:00Z',
    test: (rows) => countLegs(rows, (l) => String(MARKET(l)).startsWith('first_5_innings')),
    wantMin: 1, why: 'F5_MIN_BOOKS=2 + widened book list, deployed 2026-08-23' },
];
function countLegs(rows, pred) {
  let n = 0;
  for (const r of rows) if ((r.legs || []).some(pred)) n++;
  return n;
}
function runAssertions(rows, windowFromIso) {
  const out = [];
  for (const a of ASSERTIONS) {
    if (windowFromIso < a.since) { out.push({ ...a, skipped: true }); continue; }
    const got = a.test(rows);
    const ok = a.want != null ? got === a.want : got >= a.wantMin;
    out.push({ ...a, got, ok });
  }
  return out;
}

function summarise(rows, hours) {
  const bySport = {}, byMarket = {};
  let fills = 0, risk = 0, maxPropRisk = 0;
  for (const r of rows) {
    const filled = isFilled(r);
    if (filled) { fills++; risk += Number(r.confirmed_stake || 0); }
    const legs = r.legs || [];
    if (filled && legs.some((l) => String(MARKET(l)).startsWith('player_'))) {
      maxPropRisk = Math.max(maxPropRisk, Number(r.confirmed_stake || 0));
    }
    for (const s of new Set(legs.map(SPORT))) {
      const e = (bySport[s] = bySport[s] || { q: 0, f: 0 });
      e.q++; if (filled) e.f++;
    }
    for (const m of new Set(legs.map(MARKET))) {
      const e = (byMarket[m] = byMarket[m] || { q: 0, f: 0 });
      e.q++; if (filled) e.f++;
    }
  }
  return {
    quotes: rows.length, fills, risk: Math.round(risk),
    fillRate: rows.length ? fills / rows.length : 0,
    quotesPerHour: rows.length / hours,
    maxPropRisk: Math.round(maxPropRisk),
    bySport, byMarket,
  };
}

async function declineMix(fromIso, toIso, cap = 60000) {
  // PostgREST caps a response at 1,000 rows regardless of .limit(), so the
  // obvious single-shot `.limit(20000)` silently returns 1,000 and the mix
  // becomes "the newest 1,000 declines" while looking like the whole window.
  // Page it properly, keyset on declined_at, and report honestly when the cap
  // is what stopped us.
  const mix = {};
  let cursor = null, sampled = 0, hitCap = false;
  for (let p = 0; p < 400; p++) {
    const r = await retry(() => {
      let b = sb.from('declines').select('reason,declined_at')
        .gte('declined_at', fromIso).lt('declined_at', toIso);
      if (cursor) b = b.lt('declined_at', cursor);
      return b.order('declined_at', { ascending: false }).limit(1000);
    }, 'declines');
    if (!r.data.length) break;
    for (const d of r.data) mix[d.reason || 'unknown'] = (mix[d.reason || 'unknown'] || 0) + 1;
    sampled += r.data.length;
    cursor = r.data[r.data.length - 1].declined_at;
    if (r.data.length < 1000) break;
    if (sampled >= cap) { hitCap = true; break; }
  }
  return { sampled, mix, truncated: hitCap };
}

(async () => {
  const now = Date.now();
  const recentFrom = new Date(now - DAYS * 864e5).toISOString();
  const baseFrom = new Date(now - (DAYS + BASE) * 864e5).toISOString();
  const nowIso = new Date(now).toISOString();

  const [recentRows, baseRows] = [await pageOrders(recentFrom, nowIso), await pageOrders(baseFrom, recentFrom)];
  const recent = summarise(recentRows, DAYS * 24);
  const base = summarise(baseRows, BASE * 24);
  const dec = await declineMix(recentFrom, nowIso).catch((e) => ({ error: e.message }));

  const asserts = runAssertions(recentRows, recentFrom);
  const failed = asserts.filter((a) => a.ok === false);

  if (AS_JSON) {
    console.log(JSON.stringify({ recentFrom, baseFrom, recent, base, declines: dec,
      assertions: asserts, failedCount: failed.length }, null, 1));
    process.exitCode = failed.length ? 2 : 0;
    return;
  }

  const pct = (x) => (x * 100).toFixed(2) + '%';
  const delta = (a, b) => {
    if (!b) return a ? '  NEW' : '    —';
    const d = (a / b - 1) * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(0) + '%';
  };
  console.log(`RECENT   ${recentFrom.slice(0, 16)} -> now        (${DAYS}d)`);
  console.log(`BASELINE ${baseFrom.slice(0, 16)} -> ${recentFrom.slice(0, 16)} (${BASE}d)\n`);
  console.log('                        recent        baseline      change');
  console.log(`  quotes/hour   ${recent.quotesPerHour.toFixed(0).padStart(12)} ${base.quotesPerHour.toFixed(0).padStart(13)}   ${delta(recent.quotesPerHour, base.quotesPerHour)}`);
  console.log(`  fills/hour    ${(recent.fills / (DAYS * 24)).toFixed(1).padStart(12)} ${(base.fills / (BASE * 24)).toFixed(1).padStart(13)}   ${delta(recent.fills / (DAYS * 24), base.fills / (BASE * 24))}`);
  console.log(`  fill rate     ${pct(recent.fillRate).padStart(12)} ${pct(base.fillRate).padStart(13)}   ${delta(recent.fillRate, base.fillRate)}`);
  console.log(`  risk/hour     ${('$' + Math.round(recent.risk / (DAYS * 24))).padStart(12)} ${('$' + Math.round(base.risk / (BASE * 24))).padStart(13)}   ${delta(recent.risk / (DAYS * 24), base.risk / (BASE * 24))}`);
  console.log(`  max prop risk ${('$' + recent.maxPropRisk).padStart(12)} ${('$' + base.maxPropRisk).padStart(13)}   (cap is MAX_RISK_PER_PARLAY_WITH_PROP)`);

  const table = (title, rKey, bKey, min) => {
    console.log(`\n  ${title}`);
    console.log('    key                          q/hr recent   q/hr base   change   fillRate r/b');
    const keys = [...new Set([...Object.keys(rKey), ...Object.keys(bKey)])];
    const scored = keys.map((k) => {
      const r = rKey[k] || { q: 0, f: 0 }, b = bKey[k] || { q: 0, f: 0 };
      return { k, rq: r.q / (DAYS * 24), bq: b.q / (BASE * 24), rf: r.q ? r.f / r.q : 0, bf: b.q ? b.f / b.q : 0 };
    }).filter((x) => x.rq >= min || x.bq >= min)
      .sort((a, b) => (b.bq - b.rq) - (a.bq - a.rq)); // biggest DROP first
    for (const x of scored.slice(0, 14)) {
      console.log(`    ${x.k.slice(0, 28).padEnd(28)} ${x.rq.toFixed(1).padStart(9)} ${x.bq.toFixed(1).padStart(11)}   ${delta(x.rq, x.bq).padStart(6)}   ${pct(x.rf).padStart(7)} / ${pct(x.bf)}`);
    }
  };
  table('BY SPORT (biggest volume drop first)', recent.bySport, base.bySport, 0.2);
  table('BY MARKET (biggest volume drop first)', recent.byMarket, base.byMarket, 0.5);

  console.log('\n  DECLINE MIX (recent window)');
  if (dec.error) { console.log('    declines read failed:', dec.error); }
  else {
    const tot = Object.values(dec.mix).reduce((a, b) => a + b, 0) || 1;
    for (const [r, n] of Object.entries(dec.mix).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(n).padStart(7)} (${(n / tot * 100).toFixed(1).padStart(5)}%)  ${r}`);
    }
    console.log(`    (${dec.sampled.toLocaleString()} declines read${dec.truncated ? ' — CAPPED, shares are of the sample not the window' : ' — complete window'})`);
  }

  console.log('');
  console.log('  POST-CHANGE ASSERTIONS');
  for (const a of asserts) {
    if (a.skipped) { console.log(`    SKIP  ${a.label.padEnd(38)} (window starts before the change)`); continue; }
    const tag = a.ok ? 'PASS' : 'FAIL';
    const want = a.want != null ? `want ${a.want}` : `want >= ${a.wantMin}`;
    console.log(`    ${tag}  ${a.label.padEnd(38)} got ${String(a.got).padStart(5)}  ${want}`);
    if (!a.ok) console.log(`          ^ ${a.why}`);
  }
  if (failed.length) {
    console.log('');
    console.log(`  *** ${failed.length} ASSERTION(S) FAILED — a parameter change is not holding ***`);
    process.exitCode = 2;
  }
})().catch((e) => { console.error('MONITOR FAILED:', e.message); process.exit(1); });
