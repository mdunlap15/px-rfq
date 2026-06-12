/**
 * SGP guard — script-aware prop exposure caps + the experimental-combo
 * risk tier (SGP roadmap Stage 0, items 4/5 of the hardening package).
 *
 * Two jobs, both fail-closed and both enforced at QUOTE time (pricer.
 * shouldDecline) AND re-checked at CONFIRM time (websocket.handleConfirm):
 *
 * 1. PROP GAME-SCRIPT CAPS. The per-team/per-player exposure system nets
 *    by (market):(selection), so N ≤$50 tickets on N *different* players
 *    all long the same game script aggregate unbounded (red-team attack
 *    3B). Two ledgers close this:
 *      - per-(game, selection-side) prop risk (`maxPropTeamSideRisk`,
 *        default $300): bounds one-directional stacking (all-overs on a
 *        game = the dominant script attack). NOTE: the roadmap's
 *        per-(game, TEAM, side) refinement needs player→team identity,
 *        which doesn't exist until the Stage-2 roster service — this is
 *        the honest Stage-0 approximation (side only).
 *      - TOTAL prop risk per game (`maxPropRiskPerGame`, default $600):
 *        the blunt bound no script mapping can evade.
 *
 * 2. EXPERIMENTAL-COMBO TIER. Combos in config.pricing.experimentalSgpCombos
 *    (e.g. 'prop_nested') run as small tests: per-class daily filled-risk
 *    budget (`sgpExperimentDailyBudget`), and a rolling-week realized-P&L
 *    stop-loss (`sgpExperimentWeeklyStopLoss`) that AUTO-DARKS the class
 *    at runtime (declines all further quotes) and persists the dark state
 *    via db.saveKV so restarts don't resurrect a stopped class. The
 *    per-ticket cap itself lives in priceParlay's candidateCaps + the
 *    confirm-time cap mirror.
 *
 * State is in-memory, rebuilt at boot from order-tracker's loaded orders
 * (rebuild()) and maintained by recordFill()/recordSettlement() hooks.
 * All date bucketing uses ET (UTC-4) to match the operator's day.
 */
const log = require('./logger');
const { config } = require('../config');

const AUTO_DARK_KV_KEY = 'sgp_experiment_auto_dark';

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
// gameKey -> { total, bySide: { over: n, under: n, ... }, name }
let propGameRisk = new Map();
// combo -> { day: 'YYYY-MM-DD', filledRisk: n }
let comboDaily = new Map();
// combo -> [{ atMs, pnl }] rolling window of settled results
let comboPnl = new Map();
// combos auto-darked by stop-loss (persisted)
let autoDark = new Set();

const PNL_WINDOW_MS = 7 * 24 * 3600 * 1000;

function _etDay(ts) {
  // DST-aware ET day (review fix: a fixed UTC-4 drifts the daily-budget
  // boundary to 1am ET during standard time). en-CA gives YYYY-MM-DD.
  const d = ts ? new Date(ts) : new Date();
  try {
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  } catch (_) {
    return new Date(d.getTime() - 4 * 3600 * 1000).toISOString().substring(0, 10);
  }
}

// Match order-tracker's game-key convention (checkGameExposure):
// eventId + '|' + gameDate, with a synthetic fallback.
function _gameKey(li) {
  const eventId = li.pxEventId;
  const gameDate = li.startTime ? new Date(li.startTime).toISOString().substring(0, 10) : '';
  if (eventId) return eventId + '|' + gameDate;
  return 'syn_' + String((li.homeTeam || '') + (li.awayTeam || '')).toLowerCase().replace(/[^a-z0-9]/g, '') + '|' + (gameDate || 'noevent');
}

function _isPropLeg(l) {
  return /^player_/.test(String(l.market || l.marketType || ''));
}

function _sideOf(l) {
  // Normalize the backed direction. YES-style one-sided props register as
  // selection 'over'; anything unrecognized buckets as 'other' (still capped).
  const s = String(l.selection || l.oddsApiSelection || '').toLowerCase();
  if (s === 'over' || s === 'yes') return 'over';
  if (s === 'under' || s === 'no') return 'under';
  return s || 'other';
}

// ---------------------------------------------------------------------------
// PROP GAME-SCRIPT CAPS
// ---------------------------------------------------------------------------

/**
 * Quote/confirm-time gate. `legs` = resolvedLegs-style array (each having
 * lineInfo or being a flat leg object); `addRisk` = the risk this parlay
 * would add (worst case = its per-parlay cap at quote time, actual ourRisk
 * at confirm time). Charges the FULL addRisk to every game that has at
 * least one prop leg in this parlay (conservative — a parlay's max payout
 * is at stake regardless of which leg's game "caused" it).
 */
function checkPropGameCaps(legs, addRisk) {
  const perSideCap = config.pricing.maxPropTeamSideRisk || 0;
  const perGameCap = config.pricing.maxPropRiskPerGame || 0;
  if (perSideCap <= 0 && perGameCap <= 0) return { allowed: true };
  const seen = new Set();
  for (const leg of legs || []) {
    const li = leg.lineInfo || leg;
    if (!_isPropLeg(li)) continue;
    const key = _gameKey(li);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = propGameRisk.get(key) || { total: 0, bySide: {}, name: li.pxEventName || key };
    const side = _sideOf(li);
    const sideRisk = (entry.bySide[side] || 0) + addRisk;
    const totalRisk = entry.total + addRisk;
    if (perGameCap > 0 && totalRisk > perGameCap) {
      return {
        allowed: false,
        reason: `prop game cap: "${entry.name}" total prop risk $${Math.round(entry.total)} + $${Math.round(addRisk)} > max $${perGameCap}`,
        wouldBe: totalRisk, limit: perGameCap, scope: 'game_total',
      };
    }
    if (perSideCap > 0 && sideRisk > perSideCap) {
      return {
        allowed: false,
        reason: `prop side cap: "${entry.name}" ${side}-side prop risk $${Math.round(entry.bySide[side] || 0)} + $${Math.round(addRisk)} > max $${perSideCap}`,
        wouldBe: sideRisk, limit: perSideCap, scope: 'game_side',
      };
    }
  }
  return { allowed: true };
}

function _addPropGameRisk(order) {
  const legs = (order.meta && order.meta.legs) || [];
  const risk = Number(order.confirmedStake) || 0;
  if (risk <= 0) return;
  const seen = new Set();
  for (const l of legs) {
    if (!_isPropLeg(l)) continue;
    const key = _gameKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = propGameRisk.get(key) || { total: 0, bySide: {}, name: l.pxEventName || (l.awayTeam && l.homeTeam ? `${l.awayTeam} @ ${l.homeTeam}` : key) };
    const side = _sideOf(l);
    entry.total += risk;
    entry.bySide[side] = (entry.bySide[side] || 0) + risk;
    propGameRisk.set(key, entry);
  }
}

// ---------------------------------------------------------------------------
// EXPERIMENTAL-COMBO TIER
// ---------------------------------------------------------------------------

function isExperimental(combo) {
  return !!(combo && config.pricing.experimentalSgpCombos
    && config.pricing.experimentalSgpCombos.has(combo));
}

function isDark(combo) {
  return autoDark.has(combo);
}

/** Quote/confirm-time gate for an experimental combo. */
function checkExperiment(combo, addRisk) {
  if (!isExperimental(combo)) return { allowed: true };
  if (autoDark.has(combo)) {
    return { allowed: false, reason: `combo '${combo}' auto-darked by weekly stop-loss — re-enable via /sgp-experiments/reset`, scope: 'auto_dark' };
  }
  const budget = config.pricing.sgpExperimentDailyBudget || 0;
  if (budget <= 0) return { allowed: true };
  const today = _etDay();
  const d = comboDaily.get(combo);
  const used = (d && d.day === today) ? d.filledRisk : 0;
  if (used + addRisk > budget) {
    return {
      allowed: false,
      reason: `combo '${combo}' daily budget: filled $${Math.round(used)} + $${Math.round(addRisk)} > $${budget}`,
      wouldBe: used + addRisk, limit: budget, scope: 'daily_budget',
    };
  }
  return { allowed: true };
}

/** Called after a confirm is ACCEPTED (websocket, post-recordConfirmation). */
function recordFill(order) {
  try {
    _addPropGameRisk(order);
    const combo = order.meta && order.meta.sgpCombo;
    if (isExperimental(combo)) {
      const today = _etDay(order.confirmedAt);
      const d = comboDaily.get(combo);
      if (d && d.day === today) d.filledRisk += Number(order.confirmedStake) || 0;
      else comboDaily.set(combo, { day: today, filledRisk: Number(order.confirmedStake) || 0 });
      log.info('SGP-Guard', `experimental fill: ${combo} +$${order.confirmedStake} (today $${Math.round(comboDaily.get(combo).filledRisk)}/${config.pricing.sgpExperimentDailyBudget})`);
    }
  } catch (err) {
    log.warn('SGP-Guard', `recordFill failed: ${err.message}`);
  }
}

/** Called on settlement (order-tracker hook). Checks the stop-loss. */
function recordSettlement(order) {
  try {
    const combo = order && order.meta && order.meta.sgpCombo;
    if (!isExperimental(combo)) return;
    if (order.pnl == null) return;
    const arr = comboPnl.get(combo) || [];
    arr.push({ atMs: Date.now(), pnl: Number(order.pnl) || 0 });
    comboPnl.set(combo, arr);
    _checkStopLoss(combo);
  } catch (err) {
    log.warn('SGP-Guard', `recordSettlement failed: ${err.message}`);
  }
}

function _weekPnl(combo) {
  const cutoff = Date.now() - PNL_WINDOW_MS;
  const arr = (comboPnl.get(combo) || []).filter(e => e.atMs >= cutoff);
  comboPnl.set(combo, arr); // prune old entries while we're here
  return arr.reduce((s, e) => s + e.pnl, 0);
}

function _checkStopLoss(combo) {
  const stop = config.pricing.sgpExperimentWeeklyStopLoss || 0;
  if (stop <= 0 || autoDark.has(combo)) return;
  const pnl = _weekPnl(combo);
  if (pnl <= -stop) {
    autoDark.add(combo);
    log.error('SGP-Guard', `STOP-LOSS: combo '${combo}' rolling-week P&L $${Math.round(pnl)} breached -$${stop} — AUTO-DARKED (all further quotes decline)`);
    try { require('./push').notifyConnectionState('sgp-stop-loss', `${combo} auto-darked: week P&L $${Math.round(pnl)}`); } catch (_) {}
    _persistAutoDark();
  }
}

function _persistAutoDark() {
  try {
    const db = require('./db');
    db.saveKV(AUTO_DARK_KV_KEY, { combos: [...autoDark], updatedAt: new Date().toISOString() })
      .catch(err => log.warn('SGP-Guard', `persist auto-dark failed: ${err.message}`));
  } catch (_) { /* best-effort */ }
}

/** Operator lever: clear a combo's dark state (via /sgp-experiments/reset).
 * Also clears the combo's rolling P&L window — without that, the next
 * settlement (even a WIN) re-trips the stop while cumulative week P&L is
 * still below the threshold, making the lever inert (review fix). The
 * operator reviewed the breach; the clock restarts. */
function resetDark(combo) {
  const was = autoDark.delete(combo);
  comboPnl.delete(combo);
  if (was) _persistAutoDark();
  return was;
}

/** Fail-closed lever for boot-path failures: dark every experimental combo
 * (used by index.js when rebuild() itself throws). */
function failClosed(reason) {
  autoDark = new Set([...(config.pricing.experimentalSgpCombos || []), ...autoDark]);
  log.error('SGP-Guard', `failClosed(${reason}): experimental combos darkened — /sgp-experiments/reset to re-enable`);
}

// ---------------------------------------------------------------------------
// BOOT REBUILD
// ---------------------------------------------------------------------------

/**
 * Rebuild ledgers from order-tracker's loaded orders + persisted dark set.
 * Call once at startup AFTER orderTracker.loadFromDb. Idempotent.
 * - prop game risk: from ACTIVE (status='confirmed') orders — settled
 *   games no longer carry script exposure.
 * - daily budget: today's confirmed-or-settled experimental fills.
 * - weekly P&L: last 7 days of settled experimental orders.
 */
async function rebuild(orders) {
  propGameRisk = new Map();
  comboDaily = new Map();
  comboPnl = new Map();
  const today = _etDay();
  const weekCutoff = Date.now() - PNL_WINDOW_MS;
  for (const order of orders || []) {
    if (!order || !order.meta) continue;
    const combo = order.meta.sgpCombo;
    if (order.status === 'confirmed') _addPropGameRisk(order);
    if (isExperimental(combo)) {
      if (order.confirmedAt && _etDay(order.confirmedAt) === today
          && (order.status === 'confirmed' || String(order.status || '').startsWith('settled_'))) {
        const d = comboDaily.get(combo) || { day: today, filledRisk: 0 };
        d.filledRisk += Number(order.confirmedStake) || 0;
        comboDaily.set(combo, d);
      }
      if (String(order.status || '').startsWith('settled_') && order.pnl != null) {
        const atMs = order.settledAt ? new Date(order.settledAt).getTime() : Date.now();
        if (atMs >= weekCutoff) {
          const arr = comboPnl.get(combo) || [];
          arr.push({ atMs, pnl: Number(order.pnl) || 0 });
          comboPnl.set(combo, arr);
        }
      }
    }
  }
  try {
    const db = require('./db');
    const row = await db.loadKV(AUTO_DARK_KV_KEY);
    if (row && Array.isArray(row.combos)) {
      autoDark = new Set(row.combos);
      if (autoDark.size) log.warn('SGP-Guard', `loaded persisted auto-dark combos: ${[...autoDark].join(', ')}`);
    }
    // row === null is ambiguous (no key yet vs read failure swallowed by
    // loadKV) — loadKV warns internally on errors; a fresh deploy has no
    // key, which is the common benign case. Genuine throw → fail closed.
  } catch (err) {
    // FAIL CLOSED (review fix): a stop-lossed combo must not resurrect
    // because Supabase was unreachable at boot. Dark ALL experimental
    // combos until an operator reset or a successful future load.
    autoDark = new Set(config.pricing.experimentalSgpCombos || []);
    log.error('SGP-Guard', `auto-dark load FAILED — failing closed: all experimental combos darkened until /sgp-experiments/reset (${err.message})`);
  }
  // Re-evaluate stop-losses against rebuilt P&L (covers a breach that
  // happened while we were down).
  for (const combo of comboPnl.keys()) _checkStopLoss(combo);
  log.info('SGP-Guard', `rebuilt: ${propGameRisk.size} games with prop risk, ${comboDaily.size} combos with today fills, dark=[${[...autoDark].join(',') || 'none'}]`);
}

function getStatus() {
  const games = {};
  for (const [k, v] of propGameRisk) games[k] = { name: v.name, total: Math.round(v.total), bySide: v.bySide };
  const experiments = {};
  const combos = new Set([
    ...(config.pricing.experimentalSgpCombos || []),
    ...comboDaily.keys(), ...comboPnl.keys(), ...autoDark,
  ]);
  for (const combo of combos) {
    const d = comboDaily.get(combo);
    experiments[combo] = {
      experimental: isExperimental(combo),
      dark: autoDark.has(combo),
      todayFilledRisk: (d && d.day === _etDay()) ? Math.round(d.filledRisk) : 0,
      dailyBudget: config.pricing.sgpExperimentDailyBudget,
      weekPnl: Math.round(_weekPnl(combo) * 100) / 100,
      weeklyStopLoss: -(config.pricing.sgpExperimentWeeklyStopLoss || 0),
      perTicketCap: config.pricing.maxRiskSgpExperimental,
    };
  }
  return {
    experiments,
    propGameRisk: games,
    caps: {
      maxPropTeamSideRisk: config.pricing.maxPropTeamSideRisk,
      maxPropRiskPerGame: config.pricing.maxPropRiskPerGame,
    },
  };
}

module.exports = {
  checkPropGameCaps,
  checkExperiment,
  isExperimental,
  isDark,
  recordFill,
  recordSettlement,
  rebuild,
  resetDark,
  failClosed,
  getStatus,
};
