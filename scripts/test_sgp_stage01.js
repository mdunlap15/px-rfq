/**
 * SGP Stage 0+1 test suite — gates, exact pricing, confirm symmetry,
 * experiment tier, prop game caps, bounded confirm fail-open.
 *
 * Run: SGP_ALLOWED_COMBOS="spread_total,prop_nested" node scripts/test_sgp_stage01.js
 * (run again WITHOUT prop_nested in SGP_ALLOWED_COMBOS to verify dark mode)
 *
 * Local-only: injects synthetic lineInfos via __debugGetLineIndex and stubs
 * the sport-level odds staleness (no odds cache locally). Never touches PX
 * or Supabase writes.
 */
process.env.SGP_EXPERIMENTAL_COMBOS = process.env.SGP_EXPERIMENTAL_COMBOS || 'prop_nested';
// GS⇒SoT1 is settlement-verification-gated (cross-feed grading) — enable for
// the rule-logic tests; a dedicated case below verifies default-off.
process.env.SGP_NESTED_SOCCER_GS_SOT = 'true';
// Stub KV persistence to in-memory BEFORE anything touches the guard —
// the local .env points at the production Supabase, and an early version
// of this suite leaked its stop-loss test state into the live kv_store.
const db = require('../services/db');
const _kv = {};
db.saveKV = async (k, v) => { _kv[k] = v; };
db.loadKV = async (k) => _kv[k] || null;
// shouldDecline fire-and-forgets sgp_audit rows on same-player / SGP-not-
// allowed declines — stub so synthetic test shapes never pollute the
// production demand-counting table when SGP_SHADOW_LOGGING is on.
db.saveSgpAudit = async () => {};
const lineManager = require('../services/line-manager');
const oddsFeed = require('../services/odds-feed');
oddsFeed.isStale = () => false;
oddsFeed.isEventStalePreGame = () => false;
const pricer = require('../services/pricer');
const sgpGuard = require('../services/sgp-guard');
const { config } = require('../config');

const idx = lineManager.__debugGetLineIndex();
const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
const fresh = Date.now() - 60 * 1000;
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

function mk(id, { sport = 'soccer', eventId, player, propType, implied, line = 0.5, selection = 'over', marketType }) {
  idx[id] = {
    sport, pxEventId: eventId, pxEventName: 'Testland at Mockico',
    marketType: marketType || ('player_' + propType), marketName: `${player} ${propType}`,
    selection, teamName: player, line, homeTeam: 'Mockico', awayTeam: 'Testland',
    oddsApiSport: sport, startTime: future, playerName: player, propType,
    fairProb: implied, fairProbOver: implied, fairProbUnder: 1 - implied,
    booksWithBothSides: 3, propBooks: ['fanduel', 'draftkings', 'pinnacle'],
    propSource: 'toa-one-sided', propFetchedAt: fresh,
  };
}

(async () => {
  const nestedOn = (config.pricing.sgpAllowedCombos || []).includes('prop_nested');
  console.log(`=== SGP Stage 0+1 suite (prop_nested ${nestedOn ? 'ENABLED' : 'DARK'}) ===\n`);

  // --- fixtures ---
  mk('gs',   { eventId: 1, player: 'Raúl Jiménez', propType: 'goalscorer', implied: 0.40 });
  mk('sot1', { eventId: 1, player: 'Raul Jimenez', propType: 'sot_1', implied: 0.78 });
  mk('sot2', { eventId: 1, player: 'Raúl Jiménez', propType: 'sot_2', implied: 0.30 });
  mk('ast',  { eventId: 1, player: 'Raúl Jiménez', propType: 'assists', implied: 0.25 });
  mk('hr',   { sport: 'baseball_mlb', eventId: 2, player: 'Aaron Judge', propType: 'hitter_hr', implied: 0.12 });
  mk('hit',  { sport: 'baseball_mlb', eventId: 2, player: 'Aaron Judge', propType: 'hitter_hits', implied: 0.78 });
  mk('tb45', { sport: 'baseball_mlb', eventId: 2, player: 'Aaron Judge', propType: 'hitter_total_bases', implied: 0.10, line: 4.5 });
  mk('nhl_g', { sport: 'icehockey_nhl', eventId: 3, player: 'A Matthews', propType: 'goals', implied: 0.35 });
  mk('nhl_p', { sport: 'icehockey_nhl', eventId: 3, player: 'A Matthews', propType: 'points', implied: 0.62 });
  mk('th3',  { sport: 'basketball_nba', eventId: 4, player: 'S Curry', propType: 'threes_made', implied: 0.45, line: 3.5 });
  mk('pts10',{ sport: 'basketball_nba', eventId: 4, player: 'S Curry', propType: 'points', implied: 0.90, line: 10.5 });
  mk('pts25',{ sport: 'basketball_nba', eventId: 4, player: 'S Curry', propType: 'points', implied: 0.50, line: 24.5 });
  mk('pts10u',{ sport: 'basketball_nba', eventId: 4, player: 'S Curry', propType: 'points', implied: 0.10, line: 10.5, selection: 'under' });
  mk('pts25u',{ sport: 'basketball_nba', eventId: 4, player: 'S Curry', propType: 'points', implied: 0.50, line: 24.5, selection: 'under' });
  mk('k65',  { sport: 'baseball_mlb', eventId: 5, player: 'T Skubal', propType: 'pitcher_strikeouts', implied: 0.45, line: 6.5, marketType: 'player_strikeouts' });
  mk('k45',  { sport: 'baseball_mlb', eventId: 5, player: 'T Skubal', propType: 'pitcher_strikeouts', implied: 0.80, line: 4.5, marketType: 'player_strikeouts' });
  mk('gs_bad',   { eventId: 6, player: 'Bad Feed', propType: 'goalscorer', implied: 0.60 });
  mk('sot1_bad', { eventId: 6, player: 'Bad Feed', propType: 'sot_1', implied: 0.40 });
  mk('gs_b', { eventId: 1, player: 'Alexis Vega', propType: 'goalscorer', implied: 0.27 });

  const dc = (ids) => pricer.shouldDecline(ids.map(l => ({ line_id: l })), 't-' + ids.join('-'));
  const price = async (ids, opts = {}) => {
    const d = dc(ids);
    if (d.declined) return { declined: d };
    return { priced: await pricer.priceParlay(ids.map(l => ({ line_id: l })), { resolvedLineInfos: d.resolvedLineInfos, sgpCombo: d.sgpCombo, parlayId: 't', ...opts }), d };
  };

  // --- 1. gates ---
  console.log('--- gates ---');
  const gateCases = [
    ['gs+sot1 (GS⇒SoT1+)', ['gs', 'sot1'], true],
    ['hr+hit (HR⇒hit)', ['hr', 'hit'], true],
    ['nhl goals+points', ['nhl_g', 'nhl_p'], true],
    ['nba threes3.5+pts10.5', ['th3', 'pts10'], true],
    ['nba pts ladder over 24.5+10.5', ['pts25', 'pts10'], true],
    ['gs+sot2 (NOT implied)', ['gs', 'sot2'], false],
    ['gs+assists (not in table)', ['gs', 'ast'], false],
    ['hr+tb4.5 (line too high)', ['hr', 'tb45'], false],
    ['nba threes+pts25.5 (3*4-0.5=11.5 < 24.5)', ['th3', 'pts25'], false],
    ['under-side pts ladder (overs only)', ['pts25u', 'pts10u'], false],
    ['mixed-side pts (over+under)', ['pts25', 'pts10u'], false],
    ['K ladder (excluded propType)', ['k65', 'k45'], false],
    ['two-player same-game props (gs+gs_b)', ['gs', 'gs_b'], false],
    ['3 same-game legs (gs+sot1+ast)', ['gs', 'sot1', 'ast'], false],
  ];
  for (const [name, ids, expectAllowed] of gateCases) {
    const r = dc(ids);
    const allowed = !r.declined && r.sgpCombo === 'prop_nested';
    if (nestedOn) check(name, allowed === expectAllowed, r.declined ? r.reason : 'combo=' + r.sgpCombo);
    else check(name + ' [dark]', r.declined === true, 'dark mode must decline everything');
  }

  if (nestedOn) {
    // --- 2. pricing ---
    console.log('--- pricing ---');
    const p1 = await price(['gs', 'sot1']);
    check('exact collapse fair=0.40', p1.priced && p1.priced.meta.fairParlayProb === 0.4, p1.priced ? String(p1.priced.meta.fairParlayProb) : 'null');
    check('nestedPairs=1 stamped', p1.priced && p1.priced.meta.nestedPairs === 1);
    check('experimental cap binds', p1.priced && p1.priced.offer.max_risk <= (config.pricing.maxRiskSgpExperimental || 15), p1.priced && String(p1.priced.offer.max_risk));
    const p1c = await pricer.priceParlay([{ line_id: 'gs' }, { line_id: 'sot1' }]); // confirm path: NO opts
    check('confirm symmetry (no-opts reprice)', p1c && p1c.meta.fairParlayProb === p1.priced.meta.fairParlayProb);
    const pBad = await price(['gs_bad', 'sot1_bad']);
    check('feed-inconsistency fails closed', !pBad.declined && pBad.priced === null
      && /nested pair inconsistent/.test((pricer.priceParlay._lastFailure || {}).reason || ''),
      JSON.stringify(pricer.priceParlay._lastFailure || {}).substring(0, 80));

    // --- 2b. all-override nested pair (WC book-mirror legs) in BOTH vig modes ---
    // Without the parlay-level fix, an all-override nested pair priced at the
    // naive product of mirrors — the exact correlated gift Stage 1 closes.
    mk('gs_ov',   { eventId: 7, player: 'Mirror Man', propType: 'goalscorer', implied: 0.40 });
    mk('sot1_ov', { eventId: 7, player: 'Mirror Man', propType: 'sot_1', implied: 0.78 });
    idx['gs_ov'].bookPriceOverride = 0.42;   // raw posted × (1-sweetener)
    idx['sot1_ov'].bookPriceOverride = 0.83;
    for (const mode of [false, true]) {
      config.pricing.parlayLevelVig = mode;
      const pv = await price(['gs_ov', 'sot1_ov']);
      const offered = pv.priced ? (pv.priced.offer.odds > 0 ? 100 / (pv.priced.offer.odds + 100) : -pv.priced.offer.odds / (-pv.priced.offer.odds + 100)) : null;
      // EXACT (review fix): the offered-side multiplier divides out the weak
      // leg's OVERRIDE contribution, so the pair prices at mirror(strong) =
      // 0.42 exactly (±1 American tick of rounding), never the naive product
      // of mirrors (0.42×0.83 = 0.349) and not 0.42×(1−s)(1+overround).
      check(`all-override nested EXACT mirror(strong) (parlayLevelVig=${mode})`,
        offered != null && Math.abs(offered - 0.42) < 0.005,
        offered != null ? (offered * 100).toFixed(2) + '% vs 42.00%' : 'null');
    }
    config.pricing.parlayLevelVig = false;

    // RBI/Runs conflation (review fix): hitter_rbi_runs maps BOTH RBIs and
    // Runs Scored, so a same-player "ladder" there is NOT an implication.
    mk('rbi15', { sport: 'baseball_mlb', eventId: 8, player: 'Liner Upper', propType: 'hitter_rbi_runs', implied: 0.18, line: 1.5 });
    mk('rbi05', { sport: 'baseball_mlb', eventId: 8, player: 'Liner Upper', propType: 'hitter_rbi_runs', implied: 0.55, line: 0.5 });
    const rbiLadder = dc(['rbi15', 'rbi05']);
    check('hitter_rbi_runs ladder excluded (conflated stat)', rbiLadder.declined === true, rbiLadder.reason);

    // GS⇒SoT1 settlement gate: with the env flag OFF the pair must decline
    // (cross-feed grading unverified); SoT2⇒SoT1 (same-feed) stays allowed.
    delete process.env.SGP_NESTED_SOCCER_GS_SOT;
    const gsGated = dc(['gs', 'sot1']);
    check('GS+SoT1 declines until settlement-verified (flag off)', gsGated.declined === true, gsGated.reason);
    const sotLadder = dc(['sot2', 'sot1']);
    check('SoT2+SoT1 unaffected by the GS gate', !sotLadder.declined && sotLadder.sgpCombo === 'prop_nested', sotLadder.declined ? sotLadder.reason : 'combo=' + sotLadder.sgpCombo);
    process.env.SGP_NESTED_SOCCER_GS_SOT = 'true';

    // --- Stage 2: cross-team pairs (prop_prop_xteam) ---
    const xteamOn = (config.pricing.sgpAllowedCombos || []).includes('prop_prop_xteam');
    if (xteamOn) {
      console.log('--- stage 2: cross-team pairs ---');
      const roster = require('../services/roster');
      roster.__setTestMap('baseball_mlb', [
        ['Aaron Judge', 'Mockico Reds'],   // home side below
        ['Bobby Witt Jr.', 'Testland Blues'], // away side
        ['Giancarlo Stanton', 'Mockico Reds'], // same team as Judge
      ]);
      const mkX = (id, player, implied) => { mk(id, { sport: 'baseball_mlb', eventId: 9, player, propType: 'hitter_hr', implied, line: 0.5 });
        idx[id].homeTeam = 'Mockico Reds'; idx[id].awayTeam = 'Testland Blues'; };
      mkX('xj', 'Aaron Judge', 0.20);
      mkX('xw', 'Bobby Witt Jr.', 0.10);
      mkX('xs', 'Giancarlo Stanton', 0.12);
      mk('xu', { sport: 'baseball_mlb', eventId: 9, player: 'Unknown Rookie', propType: 'hitter_hr', implied: 0.08, line: 0.5 });
      idx['xu'].homeTeam = 'Mockico Reds'; idx['xu'].awayTeam = 'Testland Blues';

      const xOk = dc(['xj', 'xw']);
      check('cross-team HR+HR allowed', !xOk.declined && xOk.sgpCombo === 'prop_prop_xteam', xOk.declined ? xOk.reason : 'combo=' + xOk.sgpCombo);
      const xSame = dc(['xj', 'xs']);
      check('SAME-team HR+HR still declined (Stage 3)', xSame.declined === true, xSame.reason);
      const xUnk = dc(['xj', 'xu']);
      check('unresolved player fails closed', xUnk.declined === true, xUnk.reason);

      if (!xOk.declined) {
        // Price a favorites-style pair (hits 1+ shapes): the 20%/10% HR pair
        // correctly hits the book's global +1500 max-odds cap — deep HR+HR
        // longshots stay cap-bound by existing policy.
        const mkH = (id, player, implied) => { mk(id, { sport: 'baseball_mlb', eventId: 9, player, propType: 'hitter_hits', implied, line: 0.5 });
          idx[id].homeTeam = 'Mockico Reds'; idx[id].awayTeam = 'Testland Blues'; };
        mkH('xh1', 'Aaron Judge', 0.65);
        mkH('xh2', 'Bobby Witt Jr.', 0.60);
        const xh = dc(['xh1', 'xh2']);
        const px2 = xh.declined ? null : await pricer.priceParlay([{ line_id: 'xh1' }, { line_id: 'xh2' }], { resolvedLineInfos: xh.resolvedLineInfos, sgpCombo: xh.sgpCombo, parlayId: 't' });
        if (px2) {
          // band-top: joint = min(0.39 + 0.15*sqrt(.65*.35*.6*.4), 0.60) ≈ 0.4250
          const expect = 0.65 * 0.6 + 0.15 * Math.sqrt(0.65 * 0.35 * 0.6 * 0.4);
          check('band-top fair ≈ ' + expect.toFixed(4), Math.abs(px2.meta.fairParlayProb - expect) < 0.001, String(px2.meta.fairParlayProb));
          check('xteamPairs stamped', px2.meta.xteamPairs === 1);
          check('experimental cap binds (xteam)', px2.offer.max_risk <= (config.pricing.maxRiskSgpExperimental || 15), String(px2.offer.max_risk));
          const px2c = await pricer.priceParlay([{ line_id: 'xh1' }, { line_id: 'xh2' }]); // confirm path: no opts
          check('xteam confirm symmetry', px2c && px2c.meta.fairParlayProb === px2.meta.fairParlayProb);
          // Fréchet cap case: two heavy favorites where naive+lift exceeds min(p1,p2)
          mkX('xf1', 'Aaron Judge', 0.92); mkX('xf2', 'Bobby Witt Jr.', 0.93);
          const xf = dc(['xf1', 'xf2']);
          if (!xf.declined) {
            const pf = await pricer.priceParlay([{ line_id: 'xf1' }, { line_id: 'xf2' }], { resolvedLineInfos: xf.resolvedLineInfos, sgpCombo: xf.sgpCombo, parlayId: 't' });
            check('Fréchet cap binds at min(p1,p2)', pf === null || pf.meta.fairParlayProb <= 0.92 + 1e-9, pf ? String(pf.meta.fairParlayProb) : 'null(negative-odds decline ok)');
          } else { check('Fréchet cap case reachable', false, xf.reason); }
        } else {
          check('xteam pair priced', false, JSON.stringify(pricer.priceParlay._lastFailure || {}).substring(0, 100));
        }
      }
    }

    // --- 3. experiment ledger + game caps (unit-level) ---
    console.log('--- sgp-guard ---');
    await sgpGuard.rebuild([]); // clean slate
    const mkOrder = (stake, combo, eventId = 1, side = 'over') => ({
      status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedStake: stake,
      meta: { sgpCombo: combo, legs: [{ market: 'player_goalscorer', pxEventId: eventId, startTime: future, selection: side, pxEventName: 'T@M' }] },
    });
    check('experiment allowed under budget', sgpGuard.checkExperiment('prop_nested', 15).allowed);
    for (let i = 0; i < 9; i++) sgpGuard.recordFill(mkOrder(15, 'prop_nested'));
    check('budget used $135/150 still allows $15', sgpGuard.checkExperiment('prop_nested', 15).allowed);
    check('budget blocks next $16', !sgpGuard.checkExperiment('prop_nested', 16).allowed);
    sgpGuard.recordFill(mkOrder(15, 'prop_nested'));
    check('budget exhausted $150/150 blocks $15', !sgpGuard.checkExperiment('prop_nested', 15).allowed);
    check('non-experimental combo unaffected', sgpGuard.checkExperiment('spread_total', 500).allowed);
    // stop-loss
    await sgpGuard.rebuild([]);
    sgpGuard.recordSettlement({ meta: { sgpCombo: 'prop_nested' }, pnl: -301 });
    check('stop-loss auto-darks at -$301', sgpGuard.isDark('prop_nested'));
    check('dark combo declines', !sgpGuard.checkExperiment('prop_nested', 1).allowed);
    check('resetDark clears', sgpGuard.resetDark('prop_nested') && !sgpGuard.isDark('prop_nested'));
    // prop game caps
    await sgpGuard.rebuild([]);
    for (let i = 0; i < 6; i++) sgpGuard.recordFill(mkOrder(50, null, 99, 'over')); // $300 over-side on game 99
    const side = sgpGuard.checkPropGameCaps([{ lineInfo: idx['gs'], }, ], 50); // game 1 fresh — fine
    check('fresh game passes side cap', side.allowed);
    const legGame99 = [{ lineInfo: { ...idx['gs'], pxEventId: 99 } }];
    const sideBlocked = sgpGuard.checkPropGameCaps(legGame99, 50);
    check('side cap blocks at $300+$50 over', !sideBlocked.allowed && sideBlocked.scope === 'game_side', JSON.stringify(sideBlocked).substring(0, 90));
    for (let i = 0; i < 6; i++) sgpGuard.recordFill(mkOrder(50, null, 99, 'under')); // +$300 under side → total $600
    const totBlocked = sgpGuard.checkPropGameCaps([{ lineInfo: { ...idx['gs'], pxEventId: 99, selection: 'under' } }], 10);
    check('total game cap blocks at $600+$10', !totBlocked.allowed && totBlocked.scope === 'game_total', JSON.stringify(totBlocked).substring(0, 90));

    // --- 4. bounded confirm fail-open ---
    console.log('--- confirm fail-open bounds ---');
    delete idx['gs']; // simulate index churn: leg vanished
    const meta = { legs: [{ lineId: 'gs', market: 'player_goalscorer' }, { lineId: 'sot1', market: 'player_sot_1' }], fairParlayProb: 0.4, quotedAtMs: Date.now() - 10 * 1000 };
    const v1 = await pricer.validateForConfirmation('t', meta);
    check('churn + young quote → accept on original', v1.valid === true, v1.reason);
    const metaOld = { ...meta, quotedAtMs: Date.now() - 30 * 60 * 1000 };
    const v2 = await pricer.validateForConfirmation('t', metaOld);
    check('churn + stale quote → reject', v2.valid === false, v2.reason);
    mk('gs', { eventId: 1, player: 'Raúl Jiménez', propType: 'goalscorer', implied: 0.40 });
    idx['gs'].propFetchedAt = Date.now() - 60 * 60 * 1000; // stale prop → reprice fails with prop_stale
    const v3 = await pricer.validateForConfirmation('t', meta);
    check('non-churn failure (stale prop) → reject', v3.valid === false, v3.reason);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(1); });
