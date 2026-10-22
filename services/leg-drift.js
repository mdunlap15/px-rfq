/**
 * Per-leg drift: how far each leg's fair moves between OUR FILL and ITS OWN start,
 * and a correction for families that consistently move against us (2026-10-21).
 *
 * Operator: "I don't want EV calculated off live lines but want to make sure we
 * are closely tracking EV changes of wagers by the start times of the individual
 * legs. I want to be sure we are not leaking much value on any legs and
 * correcting for cases where we consistently are."
 *
 * SOURCE: meta.gameTime.legs (services/gametime-ev.js) — every leg's fair is
 * re-graded with the quote path's own method and FROZEN 90 s before that leg's
 * own scheduled start (never in-play). drift = game-time fair / fill fair - 1,
 * from the bettor's side (> 0 = the leg moved against us after we filled);
 * evDelta = the EV that leg alone moved its ticket.
 *
 * FAMILY = sport | marketType | side | horizon
 *   side    = over / under / yes / no for totals & props; fav / dog (fill fair
 *             >= 0.5) for sides (moneyline / spread / F5 / periods)
 *   horizon = near (< 3 h from start at fill) / far
 * The same leg filled in many parlays shares one game-time fair, so each lineId
 * counts ONCE (its mean drift) — samples are legs, not tickets.
 *
 * CORRECTION (adverse-only, opt-in A/B): a family qualifies when it has >= minN
 * distinct legs, mean drift > 0 and z >= zMin over the last `days`. Its multiplier
 * = 1 + min(maxPct, mean x n / (n + prior)) — shrunk toward 0 and capped — and is
 * applied by the pricer to that family's leg fair (and book-mirror price) at
 * quote time in the 'correct' arm (config.pricing.legDriftCorrectionPercent,
 * arm md5('ldc:'+parlayId)). It can only make a quote LESS generous. Operator
 * overrides (legDriftCorrectionOverrides: {key: mult | 0}) pin or disable a key.
 * The table is recomputed every LEG_DRIFT_REFRESH_MIN (10) from the in-memory
 * order book; the pricer reads it synchronously.
 */
const log = require('./logger');
const { config } = require('../config');

let _table = { builtAt: null, days: null, families: {}, corrections: {} };
let _timer = null;

const HORIZON_SPLIT_H = 3;
function sideOf(market, selection, fillFair) {
  const m = String(market || ''), sel = String(selection || '').toLowerCase();
  if (/^player_|total|btts|run_first_inning|^mov_|outright|make_cut|top_\d/.test(m) || /^(over|under|yes|no)$/.test(sel)) {
    return /^(over|under|yes|no)$/.test(sel) ? sel : (sel.includes('over') ? 'over' : sel.includes('under') ? 'under' : 'x');
  }
  return Number(fillFair) >= 0.5 ? 'fav' : 'dog';
}
function familyKey(sport, market, selection, fillFair, hrsToStart) {
  const hz = Number.isFinite(hrsToStart) ? (hrsToStart < HORIZON_SPLIT_H ? 'near' : 'far') : 'far';
  return `${sport || '?'}|${market || '?'}|${sideOf(market, selection, fillFair)}|${hz}`;
}

/**
 * The EV this leg alone moved its ticket (> 0 = we lost EV), for game-time legs
 * finalized before 2026-10-21, which stored the fair but not evDelta — the same
 * formula gametime-ev applies at finalization. 0 when the order lacks stake/odds.
 */
function _legEvDelta(order, leg, gtFair) {
  const { evAt } = require('./gametime-ev');
  const fillP = Number(order.fairParlayProb != null ? order.fairParlayProb : order.meta && order.meta.fairParlayProb);
  if (!(fillP > 0 && fillP < 1) || !(leg.fairProb > 0) || !(gtFair > 0)) return 0;
  const evFill = evAt(order, fillP);
  const evOne = evAt(order, Math.min(0.999, fillP * gtFair / leg.fairProb));
  return Number.isFinite(evFill) && Number.isFinite(evOne) ? Math.round((evFill - evOne) * 100) / 100 : 0;
}

/** Leg drift rows from orders (pure). One row per fill-leg that has a frozen game-time fair. */
function collectRows(orders, days, nowMs = Date.now()) {
  const cutoff = nowMs - days * 864e5;
  const rows = [];
  for (const o of orders) {
    if (!(o && o.confirmedStake > 0)) continue;
    const t = Date.parse(o.confirmedAt || '');
    if (!Number.isFinite(t) || t < cutoff) continue;
    const gt = o.meta && o.meta.gameTime;
    if (!gt || !gt.finalizedAt || !gt.legs) continue;
    const legs = (o.meta && o.meta.legs) || o.legs || [];
    for (const l of legs) {
      const g = gt.legs[l.lineId];
      // Drift is measured against the fair BEFORE any leg-drift correction, so an
      // applied correction does not erode its own evidence.
      const fillFair = (l.legDriftCorr && l.legDriftCorr.preFair > 0) ? l.legDriftCorr.preFair : l.fairProb;
      if (!g || !(g.fair > 0) || !(fillFair > 0)) continue;
      const st = Date.parse(l.startTime || '');
      const hrs = Number.isFinite(g.hrsToStartAtFill) ? g.hrsToStartAtFill : (Number.isFinite(st) ? (st - t) / 3600000 : NaN);
      rows.push({
        lineId: l.lineId, key: familyKey(l.sport, l.market || l.marketType, l.selection, fillFair, hrs),
        drift: g.fair / fillFair - 1, evDelta: Number.isFinite(g.evDelta) ? g.evDelta : _legEvDelta(o, l, g.fair),
        fairSource: g.fairSourceAtFill || l.fairSource || null, inputAge: g.inputAgeAtFill != null ? g.inputAgeAtFill : (l.inputAgeSec != null ? l.inputAgeSec : null),
        mirror: l.bookPriceOverride != null,
      });
    }
  }
  return rows;
}

/** Family stats + corrections (pure). */
function summarize(rows, opts = {}) {
  const minN = opts.minN != null ? opts.minN : 30, zMin = opts.zMin != null ? opts.zMin : 2;
  const maxPct = (opts.maxPct != null ? opts.maxPct : 3) / 100, prior = opts.prior != null ? opts.prior : 30;
  const fam = {};
  for (const r of rows) {
    const f = fam[r.key] || (fam[r.key] = { fills: 0, evLeak: 0, byLine: new Map(), ob: 0, stale: 0 });
    f.fills++; f.evLeak += r.evDelta;
    if (r.fairSource && /^ob_/.test(r.fairSource)) f.ob++;
    if (r.inputAge != null && r.inputAge > 120) f.stale++;
    const b = f.byLine.get(r.lineId) || { s: 0, n: 0 };
    b.s += r.drift; b.n++; f.byLine.set(r.lineId, b);
  }
  const families = {}, corrections = {};
  const r4 = v => Math.round(v * 1e4) / 1e4, r2 = v => Math.round(v * 100) / 100;
  for (const [key, f] of Object.entries(fam)) {
    const xs = [...f.byLine.values()].map(b => b.s / b.n);
    const n = xs.length;
    const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
    const z = sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
    const active = n >= minN && mean > 0 && z != null && z >= zMin;
    const shrunk = active ? Math.min(maxPct, mean * n / (n + prior)) : 0;
    families[key] = { legs: n, fills: f.fills, meanDriftPct: r2(100 * mean), z: z != null ? r2(z) : null, evLeak: r2(f.evLeak),
      shareObRelay: f.fills ? r2(f.ob / f.fills) : null, shareStaleInput: f.fills ? r2(f.stale / f.fills) : null,
      correctionPct: active ? r2(100 * shrunk) : 0 };
    if (active && shrunk > 0) corrections[key] = r4(1 + shrunk);
  }
  return { families, corrections };
}

/** Recompute the live table from the in-memory order book. */
function refresh(nowMs = Date.now()) {
  try {
    const p = config.pricing || {};
    const days = p.legDriftCorrectionDays || 21;
    const orderTracker = require('./order-tracker');
    const orders = orderTracker.getConfirmedOrdersSince ? orderTracker.getConfirmedOrdersSince(nowMs - days * 864e5) : [];
    const rows = collectRows(orders, days, nowMs);
    const s = summarize(rows, { minN: p.legDriftCorrectionMinN, zMin: p.legDriftCorrectionZ, maxPct: p.legDriftCorrectionMaxPct, prior: p.legDriftCorrectionPrior });
    _table = { builtAt: new Date(nowMs).toISOString(), days, rows: rows.length, families: s.families, corrections: s.corrections };
  } catch (e) {
    log.debug('LegDrift', `refresh failed: ${e.message}`);
  }
  return _table;
}

/**
 * The correction multiplier for one leg at quote time (1 = none). Operator
 * overrides win: a number >= 1 pins it, 0 disables the key. Never < 1.
 */
function correctionFor(lineInfo, fairProb, nowMs = Date.now()) {
  if (!lineInfo) return { mult: 1, key: null };
  const st = lineInfo.startTimeMs != null ? lineInfo.startTimeMs : Date.parse(lineInfo.startTime || '');
  const hrs = Number.isFinite(st) ? (st - nowMs) / 3600000 : NaN;
  const key = familyKey(lineInfo.sport, lineInfo.marketType, lineInfo.selection, fairProb, hrs);
  const ov = (config.pricing && config.pricing.legDriftCorrectionOverrides) || {};
  if (Object.prototype.hasOwnProperty.call(ov, key)) {
    const v = Number(ov[key]);
    return { mult: Number.isFinite(v) && v >= 1 ? Math.min(1.1, v) : 1, key, source: 'override' };
  }
  const m = _table.corrections[key];
  return { mult: m && m > 1 ? m : 1, key, source: m ? 'measured' : null };
}

function start() {
  if (_timer) return;
  const min = Math.max(2, Number(process.env.LEG_DRIFT_REFRESH_MIN) || 10);
  setTimeout(() => refresh(), 60e3).unref?.();
  _timer = setInterval(() => refresh(), min * 60e3);
  if (_timer.unref) _timer.unref();
}

function getTable() { return _table; }
function __setTableForTest(t) { _table = Object.assign({ builtAt: 'test', families: {}, corrections: {} }, t); }

module.exports = { familyKey, sideOf, collectRows, summarize, refresh, correctionFor, start, getTable, __setTableForTest };
