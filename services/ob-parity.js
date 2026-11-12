/**
 * ORDER-BOOK PARITY (2026-11-11).
 *
 * Operator: "I want us to be using the exact same [sourcing and monitoring as
 * the PX order book] for PX RFQs as much as possible" — the order book's rules
 * as of 2026-11-11 (px-methodology-2026-11-11.md, RFQ_OB_PARITY_PLAN.md), with
 * the operator's decisions: windows mirrored exactly for PROPS, SOCCER and
 * TENNIS (game lines keep RFQ's wider windows), start cutoffs everywhere, the
 * order book's per-leg price as the base of every in-scope leg, RFQ's own caps.
 *
 * The translation used throughout: the order book backs side O at an ask, so
 * its taker holds side X at that price. An RFQ bettor holding X on a parlay leg
 * is in the SAME position against us. So a leg's offered prob q (bettor side X,
 * fair f) is what our order book would charge that taker, and the order book's
 * listing limits ("nothing at +300 or longer") are on ITS side, O — i.e. they
 * bind when the bettor's side X is the heavy favourite.
 *
 * Scope: NFL, CFB, NBA, NHL, tennis, soccer. Everything else (MLB, NCAAB, MMA,
 * golf, politics, …) is untouched. Every rule is a runtime key; obParityEnabled
 * is the master switch. Nothing here runs on fairOnly reads (EV live / game-time
 * EV are measurements).
 */
const { config } = require('../config');

function P() { return config.pricing || {}; }
function on() { return P().obParityEnabled !== false; }

// ---- classification ----------------------------------------------------
function family(li) {
  const s = String((li && (li.sport || li.oddsApiSport)) || '');
  if (s === 'americanfootball_nfl' || s === 'americanfootball_nfl_preseason') return 'nfl';
  if (s === 'americanfootball_ncaaf') return 'cfb';
  if (s === 'basketball_nba') return 'nba';
  if (s === 'icehockey_nhl') return 'nhl';
  if (s === 'tennis' || s.startsWith('tennis_')) return 'tennis';
  if (s.startsWith('soccer')) return 'soccer';
  return null;
}
const isProp = (li) => /^(player_|pitcher_|hitter_|batter_)/.test(String((li && li.marketType) || ''));
const TD = new Set(['player_anytime_td', 'player_1st_td', 'player_last_td']);
const GOAL = new Set(['player_goal_scorer', 'player_goals', 'player_goal_scorer_anytime', 'player_goalscorer']);
const isTd = (li) => TD.has(String(li.marketType || ''));
const isGoalScorer = (li) => GOAL.has(String(li.marketType || ''));
const isDefensive = (li) => /tackle|sack|defensive/.test(String(li.marketType || ''));
const isQ1 = (li) => /_q1$|_1q$/.test(String(li.oddsApiMarket || '')) || /\b(1st quarter|1q|q1)\b/i.test(String(li.marketName || ''));
const sel = (li) => String((li && (li.oddsApiSelection || li.selection)) || '').toLowerCase();

function minsToStart(li, nowMs) {
  const ms = Date.parse((li && li.startTime) || '');
  return Number.isFinite(ms) ? (ms - (nowMs || Date.now())) / 60000 : null;
}

// ---- start cutoffs (seconds before the listed start) --------------------
const DEFAULT_CUTOFF = { nfl: 30, cfb: 120, nba: 30, nhl: 30, ncaab: 30, tennis: 900, soccer: 300, q1: 900 };
function cutoffSec(li) {
  const m = Object.assign({}, DEFAULT_CUTOFF, P().obStartCutoffSec || {});
  const fam = family(li) || (String(li.sport || '') === 'basketball_ncaab' ? 'ncaab' : null);
  if (!fam) return null;
  // NFL / CFB 1Q lines come down at T-15.
  if ((fam === 'nfl' || fam === 'cfb') && isQ1(li)) return Math.max(m[fam] || 0, m.q1 || 0);
  return m[fam] != null ? Number(m[fam]) : null;
}

// ---- listing windows (minutes before start; null = no window) -----------
// Mirrored exactly for props, soccer and tennis (operator decision 2026-11-11).
const DEFAULT_WINDOWS = {
  nfl_props: 360, nfl_td: 720, nfl_defensive: 90,
  cfb_props: 120,
  nba_props: 20,
  nhl_props: 60, nhl_goal: 120,
  soccer: 30,
  tennis: 180,
};
function windowMin(li) {
  const w = Object.assign({}, DEFAULT_WINDOWS, P().obWindows || {});
  const fam = family(li);
  if (!fam) return null;
  if (fam === 'soccer') return w.soccer;
  if (fam === 'tennis') return w.tennis;
  if (!isProp(li)) return null;
  if (fam === 'nfl') return isTd(li) ? w.nfl_td : isDefensive(li) ? w.nfl_defensive : w.nfl_props;
  if (fam === 'cfb') return w.cfb_props;
  if (fam === 'nba') return w.nba_props;
  if (fam === 'nhl') return isGoalScorer(li) ? w.nhl_goal : w.nhl_props;
  return null;
}

// ---- registration refusals (deterministic, so PX stops sending) ---------
// Returns a reason string or null. Time windows here re-evaluate every seed
// (build-then-swap), so a line enters at T-window and stays until it starts.
function registrationRefusal(info, nowMs) {
  if (!on() || !info) return null;
  const fam = family(info);
  if (!fam) return null;
  const mt = String(info.marketType || '');
  if (P().obMarketScopeEnabled !== false) {
    // Tennis total games is OFF on the order book.
    if (fam === 'tennis' && mt === 'total') return 'ob_market_off';
    // NHL game markets on the order book: ML, main total, 3-way NO, period ML, OT NO.
    if (fam === 'nhl' && !isProp(info) && (mt === 'spread' || mt === 'team_total')) return 'ob_market_off';
    if (fam === 'nhl' && mt === 'total' && info.oddsApiMarket && info.oddsApiMarket !== 'totals') return 'ob_market_off';   // period totals
    // Soccer on the order book: 3-way NO, DNB, main spread, main total, BTTS.
    if (fam === 'soccer' && !isProp(info) && (mt === 'double_chance' || mt === 'team_total')) return 'ob_market_off';
    // Soccer 3-way: the order book lists only the NO, so the bettor may take only YES.
    if (fam === 'soccer' && (mt === 'soccer_win_3way' || mt === 'soccer_draw_3way') && /^no/.test(sel(info))) return 'ob_market_off';
  }
  if (P().obWindowsEnabled !== false) {
    const w = windowMin(info);
    if (w != null && w > 0) {
      const m = minsToStart(info, nowMs);
      if (m == null) return 'ob_window_unknown_start';
      if (m > w) return 'ob_window';
    }
  }
  return null;
}

// ---- per-leg gates at pricing time -------------------------------------
// ctx: { fairProb, nowMs }. Returns {reason, detail} or null.
function legGate(li, ctx) {
  if (!on() || !li) return null;
  const fam = family(li);
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  const m = minsToStart(li, nowMs);
  // Start cutoff (also NCAAB, which has no other rule here).
  if (P().obCutoffEnabled !== false) {
    const c = cutoffSec(li);
    if (c != null && c > 0 && m != null && m > 0 && m * 60 < c) {
      return { reason: 'ob_start_cutoff', detail: `starts in ${Math.round(m * 60)}s — inside the order book's ${c}s cutoff` };
    }
  }
  if (!fam) return null;
  const reg = registrationRefusal(li, nowMs);
  if (reg) return { reason: reg, detail: reg === 'ob_window' ? `starts in ${Math.round(m)} min — outside the order book's ${windowMin(li)} min window` : `${li.marketType} ${sel(li)} not listed by the order book` };
  if (P().obEligibilityEnabled === false) return null;
  const f = ctx && ctx.fairProb;
  if (f > 0 && f < 1) {
    // Odds limits are on the order book's side O (1 − f for the bettor's X).
    const mt = String(li.marketType || '');
    const lim = (pO, label) => (1 - f) < pO ? { reason: 'ob_odds_limit', detail: `bettor side ${(f * 100).toFixed(1)}% — order book does not list the other side past ${label}` } : null;
    let g = null;
    if (fam === 'nhl' && !isProp(li)) g = lim(0.25 + 1e-9, '+300');                       // nothing at +300 or longer
    else if (fam === 'tennis') g = lim(mt === 'moneyline' ? 0.20 : 0.25, mt === 'moneyline' ? '+400' : '+300');
    else if (fam === 'soccer' && !isProp(li)) g = lim(0.20, '+400');
    else if (fam === 'cfb' && !isProp(li)) {
      g = lim(1 / 9, '+800');
      if (!g && mt === 'moneyline' && Math.min(f, 1 - f) < 0.20) g = { reason: 'ob_odds_limit', detail: 'CFB moneyline with the dog past +400 — order book declines the whole market' };
    } else if (fam === 'nba' && isProp(li) && /^(yes|no)$/.test(sel(li))) {
      if (sel(li) === 'no') g = { reason: 'ob_market_off', detail: 'NBA yes/no prop: order book lists only the NO' };
      else g = lim(0.25, '+300');
    }
    if (g) return g;
    // TD / goal scorer: order book lays the NO only at -300 or deeper = bettor YES at +300 or longer.
    if ((isTd(li) || (fam === 'nhl' && isGoalScorer(li))) && f > 0.25) {
      return { reason: 'ob_odds_limit', detail: `scorer YES fair ${(f * 100).toFixed(1)}% — order book lists the NO only at -300 or deeper` };
    }
  }
  // Book minimums at our exact point (props).
  if (isProp(li)) {
    const need = (fam === 'cfb') ? 4 : (fam === 'nba') ? 4 : (fam === 'nhl') ? 5 : null;
    if (need != null) {
      const n = Math.max(Number(li.booksWithBothSides) || 0, Number(li.propBooks) || 0);
      const known = li.booksWithBothSides != null || li.propBooks != null;
      if (known && n < need) return { reason: 'ob_min_books', detail: `${n} books at our point, order book requires ${need}` };
    }
  }
  if (P().obFillHoldEnabled !== false) {
    const h = holdFor(li, nowMs);
    if (h) return { reason: 'ob_fill_hold', detail: `held ${Math.round((h - nowMs) / 1000)}s more after a large fill on this ${isProp(li) && li.playerName ? 'player' : 'line'}` };
  }
  return null;
}

// ---- per-leg ask (the order book's price for this single bet) -----------
// args: { li, f (fair), raw (bettor-side raw consensus implied or null),
//         vigged (RFQ's own per-leg fair×vig, used where the order book's rule
//         is "raw mirror" but no raw is available, e.g. props) }
// Returns { q, rule } or null (leg out of scope → RFQ pricing unchanged).
function legAsk({ li, f, raw, vigged }) {
  if (!on() || P().obLegAskEnabled === false || !li || !(f > 0 && f < 1)) return null;
  const fam = family(li);
  if (!fam) return null;
  const mt = String(li.marketType || '');
  const p = P();
  const evFloor = (e) => (f + e) / (1 + e);
  const rawOk = raw > 0 && raw < 1;
  let q, rule;
  if (fam === 'nba') {
    // "every leg priced at the shortest rung carrying 4% EV" — moved either way.
    const e = (p.obNbaMinEvPct != null ? p.obNbaMinEvPct : 4) / 100;
    q = evFloor(e); rule = 'nba_ev4';
  } else if (fam === 'soccer') {
    const e = (p.obSoccerMinEvPct != null ? p.obSoccerMinEvPct : 1.2) / 100;
    if (mt === 'soccer_win_3way' || mt === 'soccer_draw_3way') { q = rawOk ? raw : null; rule = 'soccer_3way_mirror'; }
    else { q = Math.max(rawOk ? raw : (vigged || 0), evFloor(e)); rule = 'soccer_ev1.2'; }
  } else if (fam === 'tennis') {
    if (mt === 'spread') return null;                       // tennis game-spread block already prices it (6% / 8%)
    const give = (p.obTennisGiveBackPp != null ? p.obTennisGiveBackPp : 0.5) / 100;
    q = rawOk ? raw - give : vigged; rule = 'tennis_mirror_give0.5';
  } else if (fam === 'nhl') {
    if (isProp(li)) {
      q = vigged;
      if (sel(li) === 'under') q = (q || f) + (p.obNhlOverLengthenPp != null ? p.obNhlOverLengthenPp : 3) / 100;
      rule = sel(li) === 'under' ? 'nhl_prop_over_lengthened' : 'nhl_prop';
    } else { q = rawOk ? raw : vigged; rule = 'nhl_mirror'; }
  } else { // nfl / cfb
    if (isProp(li)) { q = vigged; rule = fam + '_prop'; }
    else {
      const conc = (p.obFootballConcessionPp != null ? p.obFootballConcessionPp : 1) / 100;
      q = rawOk ? raw - conc : vigged; rule = fam + '_mirror_conc';
    }
  }
  if (!(q > 0)) return null;
  q = Math.max(q, f);                                      // never shorter than fair
  if (!(q < 0.99)) return null;
  return { q, rule };
}

// TD / anytime-goal scorer YES (registration mirror legs): the order book lays
// the NO at the mirror of the books' YES, lengthened 3pp when the NO is between
// -999 and -300 — i.e. the bettor's YES costs raw + 3pp there.
function scorerYesAsk(li, raw, f) {
  if (!on() || P().obLegAskEnabled === false) return null;
  if (!(raw > 0 && raw < 1)) return null;
  if (!(isTd(li) || (family(li) === 'nhl' && isGoalScorer(li)))) return null;
  let q = raw;
  if (raw >= 1 / 11 && raw <= 0.25) q = raw + (P().obScorerLengthenPp != null ? P().obScorerLengthenPp : 3) / 100;
  if (f > 0 && q < f) q = f;
  return q < 0.99 ? q : null;
}

// Per-ticket risk caps (RFQ's own caps, mirroring the order book's numbers):
// football legs whose order-book side is past +300 (bettor X >= 75%) → $500.
function ticketCaps(pricedLegs) {
  if (!on() || P().obEligibilityEnabled === false) return [];
  const out = [];
  const cap = P().obLongshotSideCapUsd != null ? P().obLongshotSideCapUsd : 500;
  if (cap > 0 && (pricedLegs || []).some(l => {
    const fam = family(l.lineInfo);
    return (fam === 'nfl' || fam === 'cfb') && l.fairProb >= 0.75;
  })) out.push({ cap, reason: 'ob_longshot_side_cap' });
  return out;
}

// ---- large-fill hold (the order book's only fill hold) -------------------
// >= obFillHoldUsd of our confirmed leg risk on one line (props: one player)
// inside obFillHoldWindowSec → that line / player declines for obFillHoldSec.
const _fills = new Map();   // key -> [{t, risk}]
const _holds = new Map();   // key -> until ms
function _keys(li) {
  const ks = [];
  if (li && li.lineId != null) ks.push('L:' + li.lineId);
  if (li && isProp(li) && li.playerName) ks.push('P:' + (li.sport || '') + '|' + String(li.playerName).toLowerCase());
  return ks;
}
function recordFill(legs, ticketRisk, nowMs) {
  if (!on() || P().obFillHoldEnabled === false) return [];
  const now = nowMs || Date.now();
  const p = P();
  const thr = p.obFillHoldUsd != null ? p.obFillHoldUsd : 1000;
  const win = (p.obFillHoldWindowSec != null ? p.obFillHoldWindowSec : 120) * 1000;
  const hold = (p.obFillHoldSec != null ? p.obFillHoldSec : 300) * 1000;
  const held = [];
  const fairs = (legs || []).map(l => Number(l.fairProb) || 0);
  (legs || []).forEach((l, i) => {
    const li = l.lineInfo || l;
    if (!family(li)) return;
    // Leg risk = ticket risk × P(other legs win) — the same attribution the
    // per-line exposure uses: what this line's outcome actually decides.
    const others = fairs.reduce((p2, x, j) => (j === i || !(x > 0)) ? p2 : p2 * x, 1);
    const risk = (Number(ticketRisk) || 0) * others;
    for (const k of _keys(li)) {
      const arr = (_fills.get(k) || []).filter(x => now - x.t <= win);
      arr.push({ t: now, risk });
      _fills.set(k, arr);
      const sum = arr.reduce((s, x) => s + x.risk, 0);
      if (sum >= thr) { _holds.set(k, now + hold); held.push(k); }
    }
  });
  return held;
}
function holdFor(li, nowMs) {
  const now = nowMs || Date.now();
  let until = 0;
  for (const k of _keys(li)) {
    const u = _holds.get(k);
    if (u && u > now && u > until) until = u;
  }
  return until || null;
}
function _resetForTest() { _fills.clear(); _holds.clear(); }

function status() {
  const now = Date.now();
  const holds = [...(_holds.entries())].filter(([, u]) => u > now).map(([k, u]) => ({ key: k, secLeft: Math.round((u - now) / 1000) }));
  return {
    enabled: on(),
    cutoffSec: Object.assign({}, DEFAULT_CUTOFF, P().obStartCutoffSec || {}),
    windowsMin: Object.assign({}, DEFAULT_WINDOWS, P().obWindows || {}),
    holds,
  };
}

module.exports = {
  family, isProp, cutoffSec, windowMin, registrationRefusal, legGate, legAsk, scorerYesAsk,
  ticketCaps, recordFill, holdFor, status, _resetForTest,
  DEFAULT_CUTOFF, DEFAULT_WINDOWS,
};
