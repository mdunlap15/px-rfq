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
  };
}

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
  const exempt = deps.exempt || EXEMPT();
  const active = deps.activeEvents || new Map();
  const sports = new Set();
  const props = new Map();   // pxEventId -> { sport, homeTeam, awayTeam, startTime, markets:Set, oldest }
  const supps = new Map();   // sport|home|away|start -> { sport, homeTeam, awayTeam, startTime, markets:Set, pxEventId }
  for (const li of Object.values(index || {})) {
    if (!li || !li.startTime) continue;
    const st = li.startTimeMs || Date.parse(li.startTime);
    if (!Number.isFinite(st) || st <= nowMs || st > horizon) continue;
    const mt = String(li.marketType || ''), sp = String(li.sport || '');
    if (exempt.some(x => mt.startsWith(x) || sp === x || sp.startsWith(x))) continue;
    if (sp.startsWith('golf')) continue;    // DataGolf snapshots: no faster source to pull
    const oSport = li.oddsApiSport || li.sport;
    const om = String(li.oddsApiMarket || '');
    if (/^player_/.test(mt)) {
      if (!li.pxEventId || !om) continue;
      const k = String(li.pxEventId);
      const g = props.get(k) || { pxEventId: k, sport: oSport, homeTeam: li.homeTeam, awayTeam: li.awayTeam,
        startTime: li.startTime, startMs: st, markets: new Set(), oldest: Infinity };
      g.markets.add(om);
      g.oldest = Math.min(g.oldest, li.propFetchedAt || 0);
      props.set(k, g);
    } else if (SUPP_KEYS.has(om)) {
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
  const propList = [...props.values()]
    .filter(g => !(nowMs - g.oldest <= s.targetAgeSec * 1000))
    .sort((a, b) => prio(a) - prio(b) || a.oldest - b.oldest || a.startMs - b.startMs);
  const suppList = [...supps.values()].sort((a, b) => prio(a) - prio(b) || a.startMs - b.startMs);
  return { sports: [...sports], props: propList, supps: suppList };
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
  const out = { mainSports: [], propEvents: 0, propLinesUpdated: 0, suppEvents: 0, requests: 0, budgetHit: false, cooldown: false };
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
      log.info('NearStart', `pass: ${out.requests} TOA req — main [${out.mainSports.join(',')}], props ${out.propEvents} events / ${out.propLinesUpdated} lines re-priced, supplements ${out.suppEvents} events${out.budgetHit ? ' (BUDGET HIT)' : ''}${out.cooldown ? ' (TOA cooldown)' : ''} in ${stats.lastPassMs}ms`);
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
