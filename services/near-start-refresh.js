// NEAR-START REFRESH (2026-10-07). Operator: near the start "we simply cannot
// have delays of more than a minute or two" — and, once the freshness gate
// (pricer `stale_near_start`, odds <= FRESH_GATE_MAX_AGE_SEC inside
// FRESH_GATE_WINDOW_MIN) went live, "build that": refresh the inputs fast
// enough that near-start markets keep quoting instead of declining.
//
// Every NEAR_START_REFRESH_SEC, for registered lines whose event starts within
// the gate window, re-fetch whatever is older than NEAR_START_TARGET_AGE_SEC:
//   1. MAIN lines — fetchOddsForSport for each sport with a near-start line
//      (the 2-min sweep left MLB/NHL/NBA caches 2-8 min old; their old 30s
//      SharpAPI delta loop is dead).
//   2. PLAYER PROPS — ONE batched TOA request per event for all its registered
//      prop markets (odds-feed.refreshPropOddsForEvent), then the seed's own
//      prop pass re-run for that event (line-manager.refreshPropsForEvent) to
//      re-price lines already in the index. Before: seed-time snapshots off a
//      15-min cache (TOA_PROP_TTL_SECONDS=900), 2-15 min old.
//   3. SUPPLEMENTS — F5 / H1 / Q1 / team totals / BTTS for that game
//      (odds-feed.refreshNearStartSupplements; before: up to a 10-min
//      min-interval + 20-min carry-forward).
// Bounded by NEAR_START_REFRESH_MAX_REQUESTS per pass and the TOA cooldown:
// the key is shared with the order book's posters and limits request
// FREQUENCY, so a pass that runs out of budget leaves the rest stale (the gate
// then declines them) rather than bursting. Events with recent RFQ activity go
// first, then the stalest. Single-flight; never on the RFQ path.
'use strict';

const { config } = require('../config');
const log = require('./logger');

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
function settings() {
  return {
    enabled: process.env.NEAR_START_REFRESH_ENABLED !== 'false',
    tickSec: num(process.env.NEAR_START_REFRESH_SEC, 45),
    targetAgeSec: num(process.env.NEAR_START_TARGET_AGE_SEC, 60),
    maxRequests: num(process.env.NEAR_START_REFRESH_MAX_REQUESTS, 30),
    windowMin: (config.pricing && config.pricing.freshGateWindowMin) || 180,
    // ACTIVE-EVENT PROPS BEYOND THE WINDOW (2026-10-21 perf review; operator:
    // "We need our RFQs lines just as accurate" as the order book's). Prop legs
    // filled off inputs > 120 s old moved +1.64% toward the bettor within 30 min
    // (z 2.4) vs 0.06-0.15% for <= 60 s inputs — and outside the start window a
    // prop's only refresh was the seed's TOA_PROP_TTL (900 s). Props on events
    // RFQ priced in the last RFQ_WATCH_ACTIVE_MIN are now kept <= this target
    // age out to ACTIVE_PROP_HOURS before start, AFTER the near-start work in
    // the same per-pass request budget. 0 hours disables.
    // Runtime keys (no restart): nearStartActivePropHours / nearStartActivePropTargetAgeSec /
    // nearStartActivePropMaxEvents. The far work runs LAST (step 5, after
    // supplements and alt lines), is capped per pass, and never spends the last
    // `reserve` requests — it can never starve the near-start window.
    activePropHours: (() => { const v = config.pricing && config.pricing.nearStartActivePropHours; return Number.isFinite(v) && v >= 0 ? v : 24; })(),
    activePropTargetAgeSec: (config.pricing && config.pricing.nearStartActivePropTargetAgeSec) || 120,
    activePropMaxEvents: (config.pricing && config.pricing.nearStartActivePropMaxEvents) || 8,
  };
}
// pxEventId -> last far refresh ATTEMPT (ms). A far event whose oldest line a
// TOA batch cannot advance (a book that dropped the market, a non-TOA source)
// would otherwise sort first and be re-fetched every pass.
const _farAttempt = new Map();

const EXEMPT = () => (config.pricing && config.pricing.freshGateExempt) || [];
const SUPP_KEYS = new Set(['h2h_f5', 'spreads_f5', 'totals_f5', 'h2h_h1', 'spreads_h1', 'totals_h1',
  'h2h_q1', 'spreads_q1', 'totals_q1', 'team_totals', 'btts']);

const stats = {
  passes: 0, skippedBusy: 0, lastPassAt: null, lastPassMs: null, lastError: null,
  last: null,   // { mainSports, propEvents, propLinesUpdated, suppEvents, requests, budgetHit, cooldown }
  totals: { requests: 0, propLinesUpdated: 0, mainFetches: 0, suppFetches: 0, budgetHits: 0 },
};

/**
 * What the next pass should refresh, from the live line index. Pure (deps
 * injected) so the selection is testable without the network.
 */
function plan(index, deps, nowMs = Date.now()) {
  const s = deps.settings || settings();
  const horizon = nowMs + s.windowMin * 60000;
  const activeHorizon = nowMs + (s.activePropHours || 0) * 3600e3;
  const exempt = deps.exempt || EXEMPT();
  const active = deps.activeEvents || new Map();
  const sports = new Set();
  const props = new Map();   // pxEventId -> { sport, homeTeam, awayTeam, startTime, markets:Set, oldest }
  const supps = new Map();   // sport|home|away|start -> { sport, homeTeam, awayTeam, startTime, markets:Set, pxEventId }
  const alts = new Map();    // sport|home|away|start -> events with spread/total lines (their off-main points read the alt-line cache)
  for (const li of Object.values(index || {})) {
    if (!li || !li.startTime) continue;
    const st = li.startTimeMs || Date.parse(li.startTime);
    if (!Number.isFinite(st) || st <= nowMs) continue;
    const mt = String(li.marketType || ''), sp = String(li.sport || '');
    // Beyond the near-start window only PROPS of RFQ-active events qualify.
    const far = st > horizon;
    if (far && !(/^player_/.test(mt) && st <= activeHorizon && li.pxEventId != null && active.has(String(li.pxEventId)))) continue;
    if (exempt.some(x => mt.startsWith(x) || sp === x || sp.startsWith(x))) continue;
    if (sp.startsWith('golf')) continue;    // DataGolf snapshots: no faster source to pull
    const oSport = li.oddsApiSport || li.sport;
    const om = String(li.oddsApiMarket || '');
    if (/^player_/.test(mt)) {
      if (!li.pxEventId || !om) continue;
      // Lines priced from a relay (soccer goalscorer: px_gs_fairs) gain nothing from a TOA prop fetch.
      if (li.propSource === 'gs-relay' || mt === 'player_goal_scorer' && String(sp).startsWith('soccer')) continue;
      const k = String(li.pxEventId);
      const g = props.get(k) || { pxEventId: k, sport: oSport, homeTeam: li.homeTeam, awayTeam: li.awayTeam,
        startTime: li.startTime, startMs: st, markets: new Set(), oldest: Infinity, far };
      g.markets.add(om);
      g.oldest = Math.min(g.oldest, li.propFetchedAt || 0);
      props.set(k, g);
      continue;
    }
    // Any spread / total (incl. F5 / H1 / Q1) off its main point prices from the
    // event's alt-line cache — refreshed in step 4 of runOnce.
    if (/^(spreads|totals)(_(f5|h1|q1))?$/.test(om)) {
      const k = [oSport, li.homeTeam, li.awayTeam, li.startTime].join('|');
      if (!alts.has(k)) alts.set(k, { pxEventId: String(li.pxEventId || ''), sport: oSport, homeTeam: li.homeTeam,
        awayTeam: li.awayTeam, startTime: li.startTime, startMs: st });
    }
    if (SUPP_KEYS.has(om)) {
      const k = [oSport, li.homeTeam, li.awayTeam, li.startTime].join('|');
      const g = supps.get(k) || { pxEventId: String(li.pxEventId || ''), sport: oSport, homeTeam: li.homeTeam,
        awayTeam: li.awayTeam, startTime: li.startTime, startMs: st, markets: new Set() };
      g.markets.add(om);
      supps.set(k, g);
      sports.add(oSport);
    } else if (mt !== 'run_first_inning') {
      sports.add(oSport);
    }
  }
  const prio = (g) => (active.has(g.pxEventId) ? 0 : 1);
  const _farTarget = (s.activePropTargetAgeSec || 120) * 1000;
  const fresh = (g) => (g.far
    ? nowMs - Math.max(g.oldest, (deps.farAttempt || _farAttempt).get(g.pxEventId) || 0) <= _farTarget
    : nowMs - g.oldest <= s.targetAgeSec * 1000);
  const byAge = (a, b) => prio(a) - prio(b) || a.oldest - b.oldest || a.startMs - b.startMs;
  const groups = [...props.values()].filter(g => !fresh(g));
  const propList = groups.filter(g => !g.far).sort(byAge);
  // Far (beyond-window, RFQ-active) props: their own list, run LAST and capped.
  const farProps = groups.filter(g => g.far).sort((a, b) => a.oldest - b.oldest || a.startMs - b.startMs)
    .slice(0, s.activePropMaxEvents || 8);
  const suppList = [...supps.values()].sort((a, b) => prio(a) - prio(b) || a.startMs - b.startMs);
  const altList = [...alts.values()].sort((a, b) => prio(a) - prio(b) || a.startMs - b.startMs);
  return { sports: [...sports], props: propList, supps: suppList, alts: altList, farProps };
}

let _inFlight = false;
async function runOnce(deps = {}) {
  const s = deps.settings || settings();
  if (!s.enabled) return { skipped: 'disabled' };
  if (_inFlight) { stats.skippedBusy++; return { skipped: 'busy' }; }
  _inFlight = true;
  const t0 = Date.now();
  const oddsFeed = deps.oddsFeed || require('./odds-feed');
  const lineManager = deps.lineManager || require('./line-manager');
  const out = { mainSports: [], propEvents: 0, propLinesUpdated: 0, suppEvents: 0, altEvents: 0, requests: 0, budgetHit: false, cooldown: false };
  try {
    let activeEvents = deps.activeEvents;
    if (!activeEvents) { try { activeEvents = require('./rfq-watch').activeEvents(); } catch (_) { activeEvents = new Map(); } }
    const p = plan(lineManager.__debugGetLineIndex(), { settings: s, activeEvents });
    const budgetLeft = () => s.maxRequests - out.requests;
    const coolingDown = () => {
      const c = typeof oddsFeed._toaCooldownRemainingMs === 'function' ? oddsFeed._toaCooldownRemainingMs() : 0;
      if (c > 0) out.cooldown = true;
      return c > 0;
    };

    // 1. MAIN lines (one bulk request per sport). MLB's bulk fetch also runs
    //    the F5 supplement for every game, so F5 is skipped below for a sport
    //    refreshed here.
    const mainDone = new Set();
    for (const sport of p.sports) {
      if (budgetLeft() <= 0) { out.budgetHit = true; break; }
      if (coolingDown()) break;
      const ageMin = oddsFeed.getCacheAge(sport);
      if (Number.isFinite(ageMin) && ageMin * 60 <= s.targetAgeSec) continue;
      try { await oddsFeed.fetchOddsForSport(sport); } catch (err) { log.debug('NearStart', `main ${sport}: ${err.message}`); }
      out.requests++; mainDone.add(sport); out.mainSports.push(sport);
      stats.totals.mainFetches++;
    }

    // 2. PROPS — one batched request per event, then re-price in place.
    for (const g of p.props) {
      if (budgetLeft() <= 0) { out.budgetHit = true; break; }
      if (coolingDown()) break;
      const r = await oddsFeed.refreshPropOddsForEvent(g.sport,
        { homeTeam: g.homeTeam, awayTeam: g.awayTeam, startTime: g.startTime }, [...g.markets]);
      out.requests += r.requests || 0;
      if (!r.ok) { log.debug('NearStart', `props ${g.pxEventId} ${g.awayTeam}@${g.homeTeam}: ${r.reason}`); continue; }
      out.propEvents++;
      try {
        const u = await lineManager.refreshPropsForEvent(g.pxEventId);
        out.propLinesUpdated += u.updated || 0;
      } catch (err) { log.warn('NearStart', `re-price ${g.pxEventId}: ${err.message}`); }
    }

    // 3. SUPPLEMENTS
    for (const g of p.supps) {
      if (budgetLeft() <= 0) { out.budgetHit = true; break; }
      if (coolingDown()) break;
      const r = await oddsFeed.refreshNearStartSupplements(g.sport, g.homeTeam, g.awayTeam, g.startTime, [...g.markets],
        { maxAgeMs: s.targetAgeSec * 1000, skipF5: mainDone.has(g.sport) });
      out.requests += r.requests || 0;
      if (r.requests) { out.suppEvents++; stats.totals.suppFetches += r.requests; }
    }

    // 4. ALT LINES (2026-10-14) — the per-event alt cache that prices spreads /
    //    totals off the main point; refreshed only where an entry exists (an
    //    alt line is in use) and is older than the target age.
    if (typeof oddsFeed.refreshAltLinesForEvent === 'function') {
      for (const g of (p.alts || [])) {
        if (budgetLeft() <= 0) { out.budgetHit = true; break; }
        if (coolingDown()) break;
        const r = await oddsFeed.refreshAltLinesForEvent(g.sport, g.homeTeam, g.awayTeam, g.startTime, { maxAgeMs: s.targetAgeSec * 1000 });
        out.requests += r.requests || 0;
        if (r.requests) { out.altEvents++; stats.totals.altFetches = (stats.totals.altFetches || 0) + r.requests; }
      }
    }

    // 5. ACTIVE-EVENT PROPS BEYOND THE WINDOW (2026-10-21) — LAST, so the
    //    near-start work above always has first call on the budget; capped per
    //    pass (plan), and never spends the final quarter of the budget, so a
    //    later pass's near-start work cannot be crowded out by a far wave.
    const farReserve = Math.ceil(s.maxRequests / 4);
    const farAttempt = deps.farAttempt || _farAttempt;
    for (const g of (p.farProps || [])) {
      if (budgetLeft() <= farReserve) break;
      if (coolingDown()) break;
      farAttempt.set(g.pxEventId, Date.now());
      const r = await oddsFeed.refreshPropOddsForEvent(g.sport,
        { homeTeam: g.homeTeam, awayTeam: g.awayTeam, startTime: g.startTime }, [...g.markets]);
      out.requests += r.requests || 0;
      if (!r.ok) continue;
      out.farPropEvents = (out.farPropEvents || 0) + 1;
      try {
        const u = await lineManager.refreshPropsForEvent(g.pxEventId);
        out.propLinesUpdated += u.updated || 0;
      } catch (err) { log.warn('NearStart', `re-price ${g.pxEventId}: ${err.message}`); }
    }
    if (farAttempt.size > 2000) { const cut = Date.now() - 6 * 3600e3; for (const [k, t] of farAttempt) if (t < cut) farAttempt.delete(k); }
  } catch (err) {
    stats.lastError = err.message;
    log.warn('NearStart', `pass failed: ${err.message}`);
  } finally {
    _inFlight = false;
    stats.passes++;
    stats.lastPassAt = new Date().toISOString();
    stats.lastPassMs = Date.now() - t0;
    stats.last = out;
    stats.totals.requests += out.requests;
    stats.totals.propLinesUpdated += out.propLinesUpdated;
    if (out.budgetHit) stats.totals.budgetHits++;
    if (out.requests > 0) {
      log.info('NearStart', `pass: ${out.requests} TOA req — main [${out.mainSports.join(',')}], props ${out.propEvents} near-start events + ${out.farPropEvents || 0} active beyond the window / ${out.propLinesUpdated} lines re-priced, supplements ${out.suppEvents} events, alt lines ${out.altEvents} events${out.budgetHit ? ' (BUDGET HIT)' : ''}${out.cooldown ? ' (TOA cooldown)' : ''} in ${stats.lastPassMs}ms`);
    }
  }
  return out;
}

let _timer = null;
function start() {
  const s = settings();
  if (!s.enabled || _timer) return;
  _timer = setInterval(() => { runOnce().catch(() => {}); }, s.tickSec * 1000);
  if (_timer.unref) _timer.unref();
  log.info('NearStart', `near-start refresh every ${s.tickSec}s: inputs older than ${s.targetAgeSec}s, ${s.windowMin} min window, <= ${s.maxRequests} TOA requests/pass`);
}

function getStatus() {
  return Object.assign({ settings: settings(), inFlight: _inFlight }, stats);
}

module.exports = { start, runOnce, plan, getStatus, settings, __resetForTest: () => { _inFlight = false; } };
