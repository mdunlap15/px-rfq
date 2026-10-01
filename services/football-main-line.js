// ============================================================================
// football-main-line.js — NFL/CFB game lines register the MAIN NUMBER ONLY
// ============================================================================
// Operator directive 2026-10-01: "make NFL/CFB RFQ game lines match the order
// book". The single-leg posters (nfl_game_cycle.py / cfb_cycle.py →
// nfl_pre_post.py) list ONE number per point-bearing game market: the
// consensus MAIN, i.e. the median of each book's MAIN-key point snapped to .5
// (nfl_pre_post.py line_mkt() / team_totals()), never the alt ladder — mains
// filled at -0.6% vs -3.1% on alts there. px-rfq registered PX's whole bundled
// ladder (~43 spread / ~35 total points per game in prod), so it was quoting
// the exact points the order book deliberately refuses.
//
// Scope: americanfootball_nfl, americanfootball_nfl_preseason,
// americanfootball_ncaaf. CFL is deliberately NOT included (no poster runs it).
// Markets: every point-bearing GAME market, keyed by the odds-feed market key
// the line prices against — spreads/totals/team_totals, *_h1, *_q1. Moneylines
// and player props are untouched (they carry no game point, or have their own
// one-line-per-player rule).
//
// MAIN source, in order:
//   1. services/nfl-consensus fresh board mainLine — a port of the posters'
//      exact method (median of main-key points, snapped to .5).
//   2. odds-feed consensus market line (most-quoted book line).
//   Neither → the market registers NOTHING (fail closed).
// PX point choice: the PX point equal to main; else the nearest PX point if it
// is within 0.5 and unique (a tie between main±0.5 fails closed); else none.
// When PX's posted points are unknown (cache restore, virtual registration)
// only an EXACT main match is admitted.
//
// Kill-switch: config.pricing.footballGameMainOnly (env FOOTBALL_GAME_MAIN_ONLY,
// default ON, literal 'false' restores the ladder; runtime key of same name).
// ============================================================================

const MAIN_ONLY_SPORTS = new Set([
  'americanfootball_nfl',
  'americanfootball_nfl_preseason',
  'americanfootball_ncaaf',
]);

// odds-feed market key -> { kind, nflType } (nflType = nfl-consensus board type)
const POINT_MARKETS = {
  spreads:     { kind: 'spread', nflType: 'spread' },
  spreads_h1:  { kind: 'spread', nflType: 'first_half_spread' },
  spreads_q1:  { kind: 'spread', nflType: 'quarter_1_spread' },
  totals:      { kind: 'total',  nflType: 'total' },
  totals_h1:   { kind: 'total',  nflType: 'first_half_total' },
  totals_q1:   { kind: 'total',  nflType: 'quarter_1_total' },
  team_totals: { kind: 'team_total', nflType: 'team_total' },
};

const EPS = 1e-9;

function enabled(cfg) {
  const p = cfg && cfg.pricing;
  return !(p && p.footballGameMainOnly === false);
}

function inScope(info) {
  if (!info) return false;
  const sport = info.sport || info.oddsApiSport;
  if (!MAIN_ONLY_SPORTS.has(sport)) return false;
  return !!POINT_MARKETS[info.oddsApiMarket];
}

/**
 * Family key + comparable point for one line. Spreads are converted to the
 * HOME perspective so both sides of one number share a point; team totals
 * carry the team side in the family key.
 * Returns null when the line can't be placed (fails closed upstream).
 */
function familyPoint(info) {
  const pm = POINT_MARKETS[info.oddsApiMarket];
  if (!pm) return null;
  const line = Number(info.line);
  if (info.line == null || !Number.isFinite(line)) return null;
  const sel = String(info.oddsApiSelection || info.selection || '').toLowerCase();
  if (pm.kind === 'spread') {
    if (sel !== 'home' && sel !== 'away') return null;
    return { family: info.oddsApiMarket, point: sel === 'home' ? line : -line };
  }
  if (pm.kind === 'total') return { family: info.oddsApiMarket, point: line };
  // team_total: 'home_over' / 'away_under'
  const side = sel.startsWith('home') ? 'home' : sel.startsWith('away') ? 'away' : null;
  if (!side) return null;
  return { family: `${info.oddsApiMarket}|${side}`, point: line, side };
}

/**
 * The consensus MAIN point for this line's market, or null (=> fail closed).
 *   nflMain(sport, home, away, nflType, team) — nfl-consensus getMainLineSync
 *   oddsEvt — odds-feed getEventMarkets() result for the game
 */
function mainPointFor(info, { nflMain, oddsEvt } = {}) {
  const pm = POINT_MARKETS[info.oddsApiMarket];
  if (!pm) return null;
  const fp = familyPoint(info);
  if (!fp) return null;
  const sport = info.oddsApiSport || info.sport;
  const team = pm.kind === 'team_total' ? (fp.side === 'home' ? info.homeTeam : info.awayTeam) : undefined;
  if (typeof nflMain === 'function') {
    try {
      const L = nflMain(sport, info.homeTeam, info.awayTeam, pm.nflType, team);
      if (Number.isFinite(L)) return L;
    } catch (_) { /* fall through to odds-feed */ }
  }
  const mkt = oddsEvt && oddsEvt.markets ? oddsEvt.markets[info.oddsApiMarket] : null;
  if (!mkt) return null;
  if (pm.kind === 'team_total') {
    const L = mkt[fp.side] ? Number(mkt[fp.side].line) : NaN;
    return Number.isFinite(L) ? L : null;
  }
  let L = Number(mkt.line);
  if (!Number.isFinite(L) && pm.kind === 'spread' && mkt.home) L = Number(mkt.home.point);
  return Number.isFinite(L) ? L : null;
}

/**
 * Pick the PX point that represents `main` among PX's posted points.
 * Exact → it. Else nearest within 0.5 if unique. Else null.
 * pxPoints null/empty → exact-only (returns main; caller compares exactly).
 */
function choosePxPoint(main, pxPoints) {
  if (!Number.isFinite(main)) return null;
  const pts = Array.isArray(pxPoints) ? [...new Set(pxPoints.filter(Number.isFinite))] : null;
  if (!pts || pts.length === 0) return { point: main, exactOnly: true };
  if (pts.some(p => Math.abs(p - main) < EPS)) return { point: main };
  let best = null, bestD = Infinity, tie = false;
  for (const p of pts) {
    const d = Math.abs(p - main);
    if (d < bestD - EPS) { best = p; bestD = d; tie = false; }
    else if (Math.abs(d - bestD) < EPS) tie = true;
  }
  if (best == null || bestD > 0.5 + EPS || tie) return null;
  return { point: best };
}

/**
 * Admission decision for one line.
 *   opts.pxPoints — PX's posted points for this line's family (same space as
 *                   familyPoint().point); omit when unknown → exact-only.
 * Returns { ok: true } or { ok: false, reason, main?, point? }.
 */
function admit(info, cfg, opts = {}) {
  if (!enabled(cfg) || !inScope(info)) return { ok: true };
  const fp = familyPoint(info);
  if (!fp) return { ok: false, reason: 'football_main_unplaceable' };
  const main = mainPointFor(info, opts);
  if (main == null) return { ok: false, reason: 'football_main_unknown' };
  const pick = choosePxPoint(main, opts.pxPoints);
  if (!pick) return { ok: false, reason: 'football_main_not_posted', main, point: fp.point };
  if (Math.abs(fp.point - pick.point) < EPS) return { ok: true, main };
  return { ok: false, reason: 'football_alt_line', main, point: fp.point };
}

module.exports = {
  MAIN_ONLY_SPORTS,
  POINT_MARKETS,
  enabled,
  inScope,
  familyPoint,
  mainPointFor,
  choosePxPoint,
  admit,
};
