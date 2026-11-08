// Measured fair calibration (2026-11-08, operator: "I need highly accurate EV
// fill and EV live numbers" / "expand margins even if it makes us less
// competitive").
//
// Why. From 7/19 to 11/8, EV at fill summed to +$33.6K while realized P&L was
// -$43.5K. Over 7,520 settled tickets bettors hit 1.075x our joint fair
// (z 3.3). EV = our margin over OUR fair, and that fair is beaten by more than
// the ~1.2%-of-risk margin, so every EV number started too high. EV live
// inherited the same error, because it scales the fill fair by leg moves.
//
// What this does. From our own settled won/lost tickets (no voided leg, RAW
// pre-factor fair) it measures bettor hits / sum(fair) per segment. Segments
// are hierarchical, and each level is shrunk toward its parent with a prior of
// `calibPriorHits` expected hits:
//   all -> kind (game|prop, sgp|xg) -> +legs (1|2|3|4+) -> +sport -> +size
// Size (our risk at confirm) is known only at confirm, so:
//   * PRICING uses the segment without size. The calibrated fair is
//     raw x max(1, mult), and the offer is floored at
//     calFair x (1 + calibMinMarginPct/100). It only ever makes a quote LESS
//     generous. fairParlayProb itself is untouched, so the confirm drift
//     checks still compare like with like.
//   * EV FILL uses the full segment incl. size, clamped to
//     [calibMinMult, calibMaxMult], so a segment that grades in our favour
//     also reads honestly. meta.evFair = raw x mult; meta.expectedValue is
//     computed off evFair; meta.expectedValueModel keeps the old number.
//   * EV LIVE (gametime-ev) scales meta.evFair by the legs' moves.
// The multiplier is measured against the RAW fair, so it REPLACES the
// cross-game / 2-leg selection factors for EV rather than stacking on them.

const { config } = require('../config');
const log = require('./logger');

let _cells = new Map();   // key -> { h, e, v, n }
let _builtAt = null;
let _nOrders = 0;

const SPORT_GROUP = [
  [/^americanfootball_nfl/, 'nfl'], [/^americanfootball_ncaaf/, 'ncaaf'], [/^americanfootball/, 'football_other'],
  [/^basketball_nba/, 'nba'], [/^basketball_wnba/, 'wnba'], [/^basketball/, 'basketball_other'],
  [/^icehockey/, 'nhl'], [/^baseball/, 'mlb'], [/^tennis/, 'tennis'], [/^soccer/, 'soccer'],
  [/^golf/, 'golf'], [/^mma|^boxing/, 'combat'],
];
function sportGroup(s) {
  s = String(s || '');
  for (const [re, g] of SPORT_GROUP) if (re.test(s)) return g;
  return s ? 'other' : 'unknown';
}

function _legFields(l) {
  const li = l && l.lineInfo ? l.lineInfo : l || {};
  return { sport: li.sport, market: li.marketType || li.market || l.marketType || l.market, player: li.playerName || l.playerName, ev: li.pxEventId || l.pxEventId };
}

/** Segment path for a set of legs (+ optional our-risk stake). Pure. */
function segmentPath(legs, stake) {
  const L = (legs || []).map(_legFields);
  const evs = L.map(x => x.ev).filter(Boolean);
  const sgp = new Set(evs).size < evs.length;
  const prop = L.some(x => x.player || /^player_/.test(String(x.market || '')));
  const kind = (prop ? 'prop' : 'game') + (sgp ? '-sgp' : '-xg');
  const n = L.length;
  const legsB = n >= 4 ? '4+' : String(Math.max(1, n));
  const groups = [...new Set(L.map(x => sportGroup(x.sport)))];
  const sport = groups.length === 1 ? groups[0] : 'multi';
  const path = ['all', kind, kind + '|' + legsB, kind + '|' + legsB + '|' + sport];
  if (stake != null && Number.isFinite(Number(stake))) {
    const s = Number(stake);
    const sz = s >= 1000 ? '1000+' : s >= 500 ? '500-1000' : s >= 200 ? '200-500' : '<200';
    path.push(path[3] + '|' + sz);
  }
  return path;
}

function _rawFair(o) {
  const m = o.meta || {};
  if (m.calib && m.calib.rawFair > 0) return Number(m.calib.rawFair);
  if (m.xgFactorApplied && m.xgFactorPreFair > 0) return Number(m.xgFactorPreFair);
  if (m.twoLegFactorApplied && m.twoLegFactorPreFair > 0) return Number(m.twoLegFactorPreFair);
  const f = Number(o.fairParlayProb != null ? o.fairParlayProb : m.fairParlayProb);
  return Number.isFinite(f) && f > 0 && f < 1 ? f : null;
}
function _hasVoidLeg(o) {
  const legs = o.legs || (o.meta && o.meta.legs) || [];
  return legs.some(l => /void|push|cancel/i.test(String(l.settlementStatus || l.settlement_status || '')));
}

/** Build cells from orders (pure; exported for tests). */
function buildCells(orders) {
  const cells = new Map();
  let n = 0;
  for (const o of orders || []) {
    if (o.status !== 'settled_won' && o.status !== 'settled_lost') continue;
    if (_hasVoidLeg(o)) continue;
    const f = _rawFair(o);
    if (f == null) continue;
    const legs = o.legs || (o.meta && o.meta.legs) || [];
    if (!legs.length) continue;
    const hit = o.status === 'settled_lost' ? 1 : 0;   // settled_lost = the bettor won
    n++;
    for (const k of segmentPath(legs, o.confirmedStake)) {
      const c = cells.get(k) || { h: 0, e: 0, v: 0, n: 0 };
      c.h += hit; c.e += f; c.v += f * (1 - f); c.n++;
      cells.set(k, c);
    }
  }
  return { cells, n };
}

function refresh(nowMs = Date.now()) {
  try {
    const days = Number(config.pricing.calibDays) || 120;
    const ot = require('./order-tracker');
    const orders = ot.getConfirmedOrdersSince ? ot.getConfirmedOrdersSince(nowMs - days * 864e5) : [];
    const r = buildCells(orders);
    _cells = r.cells; _nOrders = r.n;
    _builtAt = new Date(nowMs).toISOString();
    // Re-stamp EV fill / EV live on every fill in the window with the new table.
    if (ot.recalibrateEv && p_enabled()) {
      const n = ot.recalibrateEv(nowMs - days * 864e5);
      log.info('FairCalib', `rebuilt from ${_nOrders} settled tickets; EV re-stamped on ${n} fills`);
    }
  } catch (e) {
    log.warn('FairCalib', `refresh failed: ${e.message}`);
  }
}
function p_enabled() { return (config.pricing || {}).calibEnabled !== false; }
function _ensure() {
  if (_builtAt === 'test') return;
  if (!_builtAt || Date.now() - Date.parse(_builtAt) > 10 * 60e3) refresh();
}

/**
 * Shrunk hit-ratio multiplier along a segment path.
 * Each level: m = (h + K*parent) / (e + K), K = prior in expected hits.
 */
function multiplierFor(path, cells) {
  if (!cells) { _ensure(); cells = _cells; }
  const K = Math.max(1, Number(config.pricing.calibPriorHits) || 40);
  let m = 1, used = 'prior';
  for (const k of path) {
    const c = cells.get(k);
    if (!c || !(c.e > 0)) break;
    m = (c.h + K * m) / (c.e + K);
    used = k;
  }
  return { mult: m, key: used };
}

function _clamp(m, lo, hi) { return Math.min(hi, Math.max(lo, m)); }
/**
 * Book-wide floor on the multiplier (calibFloorMult, default 1.10). Walk-forward
 * test 2026-11-08 (train 120d before each week, test the week, 5,965 tickets
 * Aug 4-Nov 7): $ the EV missed realized P&L by = raw fair +$54.1K (z 1.95),
 * segments alone +$46.3K, flat x1.10 +$11.0K, max(x1.10, segment) +$5.7K
 * (z 0.19; 1 SD of pure noise = $29.8K). Segments that graded in our favour did
 * not hold out of sample; the bias is book-wide selection.
 */
function floorMult() { const v = Number((config.pricing || {}).calibFloorMult); return Number.isFinite(v) && v > 0 ? v : 1.10; }

/**
 * Quote-time calibration. Returns null when disabled. raw = pre-factor joint fair.
 * { mult (>= 1), key, rawFair, calFair, floorProb }
 */
function forQuote(legs, rawFair) {
  const p = config.pricing || {};
  if (p.calibEnabled === false || !(rawFair > 0 && rawFair < 1)) return null;
  const { mult, key } = multiplierFor(segmentPath(legs));
  const m = _clamp(Math.max(mult, floorMult()), 1, Number(p.calibMaxMult) || 1.5);
  const calFair = Math.min(0.99, rawFair * m);
  const margin = Number.isFinite(Number(p.calibMinMarginPct)) ? Number(p.calibMinMarginPct) : 8;
  return { mult: m, rawMult: mult, key, rawFair, calFair, floorProb: Math.min(0.99, calFair * (1 + margin / 100)), minMarginPct: margin };
}

/**
 * EV-time calibration incl. size. Returns { mult, key, evFair } or null.
 * Clamped both ways so a segment in our favour also reads honestly.
 */
function forEv(legs, rawFair, stake) {
  const p = config.pricing || {};
  if (p.calibEnabled === false || !(rawFair > 0 && rawFair < 1)) return null;
  const { mult, key } = multiplierFor(segmentPath(legs, stake));
  const m = _clamp(Math.max(mult, floorMult()), Number(p.calibMinMult) || 0.8, Number(p.calibMaxMult) || 1.5);
  return { mult: m, key, evFair: Math.min(0.99, rawFair * m) };
}

/** Raw (pre-factor) fair of an order, for callers outside this module. */
function rawFairOf(o) { return _rawFair(o); }

function summary() {
  _ensure();
  const rows = [];
  for (const [k, c] of _cells) {
    if (k.split('|').length > 3) continue;   // kind / legs / sport levels only
    const { mult } = multiplierFor(k === 'all' ? ['all'] : ['all', ...k.split('|').map((_, i, a) => a.slice(0, i + 1).join('|'))], _cells);
    rows.push({ key: k, n: c.n, hits: c.h, expected: Math.round(c.e * 10) / 10, ratio: Math.round(c.h / c.e * 1000) / 1000,
      z: c.v > 0 ? Math.round((c.h - c.e) / Math.sqrt(c.v) * 100) / 100 : null, shrunkMult: Math.round(mult * 1000) / 1000 });
  }
  rows.sort((a, b) => b.n - a.n);
  const p = config.pricing || {};
  return { enabled: p.calibEnabled !== false, builtAt: _builtAt, tickets: _nOrders, days: p.calibDays, priorHits: p.calibPriorHits,
    minMarginPct: p.calibMinMarginPct, floorMult: floorMult(), minMult: p.calibMinMult, maxMult: p.calibMaxMult, segments: rows.slice(0, 80) };
}

function __setCellsForTest(cells) { _cells = cells; _builtAt = 'test'; }

module.exports = { segmentPath, sportGroup, buildCells, refresh, multiplierFor, forQuote, forEv, rawFairOf, summary, __setCellsForTest };
