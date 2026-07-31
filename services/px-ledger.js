/**
 * PX-native P&L ledger. Pulls full order history from ProphetX and
 * aggregates realized P&L, open exposure, and net balance impact
 * directly from PX's settlement_status + profit fields.
 *
 * This is the authoritative source of truth for P&L. The in-memory
 * order tracker misses silent losses (PX only emits `order.matched`
 * for SP wins, per Alec's event model), so tracker-derived P&L over-
 * states by the unsettled-loss count × avg stake.
 *
 * Cached because a full paginated fetch (up to ~2100 orders) takes
 * several seconds; dashboard refreshes every minute.
 */
const px = require('./prophetx');
const log = require('./logger');

let cache = null; // { at: ms, summary, ledger }
const CACHE_TTL_MS = 60 * 1000; // 1 min — fresh enough for dashboard polling

async function fetchLedger({ limit = 5000, force = false } = {}) {
  const now = Date.now();
  if (!force && cache && (now - cache.at) < CACHE_TTL_MS) return cache;

  const startedAt = now;
  const orders = await px.fetchOrders(limit);
  const summary = summarize(orders);
  cache = { at: now, summary, ledger: orders, fetchMs: Date.now() - startedAt };
  log.info('PxLedger', `Fetched ${orders.length} PX orders in ${cache.fetchMs}ms — realized $${summary.realizedPnL.toFixed(2)}, open $${summary.openExposure.toFixed(2)}`);
  return cache;
}

/**
 * Aggregate a raw PX orders array into the canonical P&L shape.
 * Pure function (no network) so it's reusable by tests.
 */
function summarize(orders) {
  const byStatus = {};
  const bySettlementStatus = {};
  let realizedPnL = 0;
  let openExposure = 0;  // stakes on unsettled orders = MAX LIABILITY (worst case)
  // Cash still genuinely at risk: open parlays with every leg unresolved. See
  // the allTbd block below for why this differs from openExposure.
  let liveOpenExposure = 0, liveOpenCount = 0;
  let stakesOnWins = 0, stakesOnLosses = 0, stakesOnPushes = 0;
  let profitOnWins = 0, profitOnLosses = 0;
  let countWins = 0, countLosses = 0, countPushes = 0;
  let openCount = 0;

  for (const po of orders) {
    const st = (po.status || '').toLowerCase();
    byStatus[st] = (byStatus[st] || 0) + 1;

    // 'rejected' and 'failed' never debited balance — skip entirely.
    if (st === 'rejected' || st === 'failed') continue;

    const settlementStatus = (po.settlement_status || '').toLowerCase();
    const stake = Number(po.confirmed_stake ?? po.stake ?? po.matched_stake ?? 0);
    const profit = po.profit != null ? Number(po.profit) : null;

    if (st === 'settled') {
      bySettlementStatus[settlementStatus || '(none)'] = (bySettlementStatus[settlementStatus || '(none)'] || 0) + 1;
      if (settlementStatus === 'won') {
        countWins++; stakesOnWins += stake;
        // PX populates profit > 0 on wins (= bettor's wager kept).
        if (profit != null) { profitOnWins += profit; realizedPnL += profit; }
      } else if (settlementStatus === 'lost') {
        countLosses++; stakesOnLosses += stake;
        // PX populates profit < 0 on losses. Fall back to -stake if missing.
        const loss = profit != null ? profit : -stake;
        profitOnLosses += loss; realizedPnL += loss;
      } else if (settlementStatus === 'push') {
        countPushes++; stakesOnPushes += stake;
        // Push = net zero (stake returned).
      }
    } else {
      // finalized (waiting for settlement) or any other non-rejected non-settled
      // status = money locked up in open parlays.
      openCount++;
      openExposure += stake;
      // LIVE subset — every leg still 'tbd', i.e. nothing has resolved yet.
      //
      // openExposure above is MAX LIABILITY, not cash. Once a leg has LOST the
      // bettor's parlay cannot hit, so our payout obligation is gone and PX has
      // effectively released it; counting those still as deployed cash is what
      // made Account Equity read ~$101K against an actual ~$78K (2026-07-30).
      // Splitting them lets equity use "cash genuinely still at risk" while
      // openExposure stays available for risk/limit checks that legitimately
      // want worst-case liability.
      const legs = Array.isArray(po.legs) ? po.legs : [];
      const allTbd = legs.length > 0
        && legs.every(l => String((l && l.settlement_status) || 'tbd').toLowerCase() === 'tbd');
      if (allTbd) { liveOpenExposure += stake; liveOpenCount++; }
    }
  }

  return {
    realizedPnL: round(realizedPnL),
    openExposure: round(openExposure),
    // Deployed-CASH basis (excludes parlays already decided in our favour,
    // whose liability PX has effectively released). Analysis only — Account
    // Equity uses openExposure above; see getCachedLiveOpenExposure().
    liveOpenExposure: round(liveOpenExposure),
    liveOpenCount,
    // Net balance impact vs starting bankroll = realized minus stakes still
    // locked in open parlays (those stakes are currently debited).
    netBalanceImpact: round(realizedPnL - openExposure),
    counts: { wins: countWins, losses: countLosses, pushes: countPushes, open: openCount, totalActive: countWins + countLosses + countPushes + openCount },
    stakes: {
      wins: round(stakesOnWins),
      losses: round(stakesOnLosses),
      pushes: round(stakesOnPushes),
      open: round(openExposure),
      totalSettled: round(stakesOnWins + stakesOnLosses + stakesOnPushes),
    },
    profit: { wins: round(profitOnWins), losses: round(profitOnLosses) },
    statusBreakdown: byStatus,
    settlementStatusBreakdown: bySettlementStatus,
  };
}

function round(n) { return Math.round(n * 100) / 100; }

async function getSummary({ force = false } = {}) {
  const c = await fetchLedger({ force });
  return {
    ...c.summary,
    fetchedAt: new Date(c.at).toISOString(),
    fetchMs: c.fetchMs,
    cacheTtlMs: CACHE_TTL_MS,
    cached: !force && (Date.now() - c.at) < CACHE_TTL_MS,
  };
}

/**
 * Sync, never-fetching accessor — returns the cached PX-native open
 * exposure if a fetch has populated the cache, otherwise null. Used by
 * the /status hot path which can't afford a multi-second blocking PX
 * fetch. Caller is responsible for falling back to a local estimate
 * when this returns null (cold-start scenario).
 */
function getCachedOpenExposure() {
  if (!cache) return null;
  return cache.summary?.openExposure ?? null;
}

/**
 * Sync accessor for the CASH basis — open parlays with every leg unresolved.
 * Preferred over getCachedOpenExposure() wherever deployed CASH is meant, since
 * that one is worst-case liability and includes parlays we can no longer lose.
 *
 * NOTE (2026-07-31): Account Equity does NOT use this — it uses
 * getCachedOpenExposure() (max-liability basis), per the operator-verified
 * /viewer formula. Swapping equity to this cash basis was tried (d26feee) and
 * rejected as understating. Kept for analysis / /px-pnl consumers that genuinely
 * want cash-at-risk. Returns null when the ledger cache is cold.
 */
function getCachedLiveOpenExposure() {
  if (!cache) return null;
  const v = cache.summary?.liveOpenExposure;
  return Number.isFinite(v) ? v : null;
}

module.exports = { fetchLedger, summarize, getSummary, getCachedOpenExposure, getCachedLiveOpenExposure };
