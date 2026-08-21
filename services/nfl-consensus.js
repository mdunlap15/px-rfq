// ============================================================================
// nfl-consensus.js — TOA per-event consensus sourcing for FOOTBALL legs
// ============================================================================
// Ported from the operator's PX Order Book sourcing methodology (2026-08-21)
// so RFQ pricing and the single-leg order book agree on where a football
// number comes from. The SOURCING and CONSENSUS MATH match that spec exactly;
// the order book's MARGIN rules (18-point widening, sweetener) are deliberately
// NOT ported — RFQ margin comes from the vig config, favorite ramp and
// consensus floor, and importing a second margin layer would double-count.
//
// THE ONE ADAPTATION THAT MATTERS. The operator's consensus medians each side
// independently and RETAINS book vig — it is a mirror of the two-sided retail
// price, NOT a fair probability. priceParlay multiplies per-leg FAIR probs and
// then applies our own vig, so feeding it a vig-retained mirror would charge
// the book's margin twice and price us out of every contest. Every consensus
// pair is therefore de-vigged here before it leaves this module, and the raw
// (vig-retained) pair is kept alongside it for diagnostics.
//
// WHY IT EXISTS: measured 2026-08-21, 149 NFL preseason parlays filled on the
// network and we quoted only 35 — we were absent from 76% of the contests, not
// outbid in them. Two causes this addresses: thin per-market book coverage
// (the operator found us-only regions return one book or zero on first-half
// markets, which reads as "no source" and declines), and markets we never
// sourced at all (1st quarter, team totals).
//
// REGIONS ARE LOAD-BEARING. us,us2,uk,eu,au — not us, and not us,eu. The rest
// of odds-feed already learned this the hard way for BTTS (pinnacle + matchbook
// are eu-region); football first-half markets are the same shape.
//
// RATE LIMIT, NOT QUOTA. TOA 429s on request FREQUENCY after ~6 unthrottled
// per-event calls (reproduced twice while probing on 2026-08-21). A 429 comes
// back looking exactly like "this game has no such market", so an unpaced burst
// silently reads as missing coverage. Hence one fetch per (sport, event) for
// the whole market set, ~1 req/s pacing, single-flight, TTL cache, and
// transient failures are NEVER cached as misses.
// ============================================================================

const log = require('./logger');
const { config } = require('../config');

// The operator's 9-book universe. Order is not significance — the consensus is
// a median, so every book counts once.
const NFL_BOOKS = (process.env.NFL_CONSENSUS_BOOKMAKERS
  || 'pinnacle,draftkings,fanduel,betmgm,espnbet,betrivers,williamhill_us,betonlineag,bovada')
  .split(',').map(s => s.trim()).filter(Boolean);

const NFL_REGIONS = process.env.NFL_CONSENSUS_REGIONS || 'us,us2,uk,eu,au';

// Market keys pulled in ONE call per event. spreads_q1/totals_q1 are ours, not
// in the operator's list: PX posts "1st Quarter Spread" and "1st Quarter Total
// Points" for every game, and without these two keys those legs register but
// can never price.
const NFL_MARKET_KEYS = (process.env.NFL_CONSENSUS_MARKETS
  || 'h2h,h2h_h1,h2h_q1,spreads,alternate_spreads,spreads_h1,spreads_q1,'
   + 'totals,alternate_totals,totals_h1,totals_q1,team_totals,alternate_team_totals')
  .split(',').map(s => s.trim()).filter(Boolean);

// HARD RULE (operator): never price a live line off a single book. One outlier
// book once set a soft price and a taker picked us off.
const MIN_BOOKS = parseInt(process.env.NFL_CONSENSUS_MIN_BOOKS, 10) || 2;

const TTL_MS = (parseInt(process.env.NFL_CONSENSUS_TTL_SECONDS, 10) || 180) * 1000;
const MAX_AGE_MS = (parseInt(process.env.NFL_CONSENSUS_MAX_AGE_SECONDS, 10) || 600) * 1000;
const FETCH_SPACING_MS = parseInt(process.env.NFL_CONSENSUS_SPACING_MS, 10) || 1000;
const FETCH_TIMEOUT_MS = parseInt(process.env.NFL_CONSENSUS_TIMEOUT_MS, 10) || 12000;

const FOOTBALL_SPORTS = new Set([
  'americanfootball_nfl',
  'americanfootball_nfl_preseason',
  'americanfootball_ncaaf',
]);

// TOA market key -> our internal marketType + segment.
const MARKET_MAP = {
  h2h:                     { type: 'moneyline' },
  h2h_h1:                  { type: 'first_half_moneyline' },
  h2h_q1:                  { type: 'first_quarter_moneyline' },
  spreads:                 { type: 'spread', main: true },
  alternate_spreads:       { type: 'spread' },
  spreads_h1:              { type: 'first_half_spread', main: true },
  spreads_q1:              { type: 'first_quarter_spread', main: true },
  totals:                  { type: 'total', main: true },
  alternate_totals:        { type: 'total' },
  totals_h1:               { type: 'first_half_total', main: true },
  totals_q1:               { type: 'first_quarter_total', main: true },
  team_totals:             { type: 'team_total', main: true },
  alternate_team_totals:   { type: 'team_total' },
};

// ---------------------------------------------------------------------------
// PURE MATH (unit-tested — see test/nfl-consensus.test.js)
// ---------------------------------------------------------------------------

/** American -> RAW implied probability, vig retained. Operator's formula. */
function impliedFromAmerican(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return null;
  return n >= 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

/** Implied probability -> American integer. */
function americanFromImplied(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

/** Median of a numeric array. Even-length takes the mean of the middle two. */
function median(nums) {
  const a = nums.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Consensus for ONE side: median of the per-book RAW implied probabilities.
 * Returns null below MIN_BOOKS — decline beats pricing off one book.
 */
function consensusSide(americanPrices, minBooks = MIN_BOOKS) {
  const probs = americanPrices.map(impliedFromAmerican).filter(p => p != null && p > 0 && p < 1);
  if (probs.length < minBooks) return null;
  return { p: median(probs), books: probs.length };
}

/**
 * Proportional 2-way de-vig of a consensus pair. The operator's consensus is a
 * vig-RETAINED mirror; priceParlay needs a fair, so this is where the two
 * conventions are reconciled. Proportional (not power) to stay consistent with
 * odds-feed.deVig2Way, which every other 2-way team market in this app uses —
 * the power variant is reserved for heavily skewed multi-outcome boards
 * (golf make-cut, UFC MoV) where proportional measurably underrates favorites.
 */
function deVigPair(pA, pB) {
  if (!(pA > 0) || !(pB > 0)) return null;
  const total = pA + pB;
  if (!(total > 0)) return null;
  return { a: pA / total, b: pB / total, overround: total };
}

/**
 * MAIN line for spreads/totals = median of the books' MAIN-key point, snapped
 * to the nearest 0.5. Deliberately ignores the alternate ladder: taking a
 * median across main+alt would drift the "main" line toward whatever the alt
 * ladder happens to be dense at. Null (=> decline) if no main-key points.
 */
function pickMainLine(mainPoints) {
  const m = median(mainPoints);
  if (m == null) return null;
  return Math.round(m * 2) / 2;
}

/**
 * Fold one TOA per-event payload into
 *   { [marketType]: { mainLine, lines: { [line]: { sides, raw, fair } } } }
 *
 * Sides are keyed by a normalized label ('home'/'away' for h2h & spreads,
 * 'over'/'under' for totals, '<team>|over' / '<team>|under' for team totals).
 * Over/under and home/away are ALWAYS paired at the SAME line before de-vig:
 * TOA returns team totals as e.g. Over 18.5 / Under 19.5 on one book, which is
 * a middle, not a two-sided price. De-vigging across mismatched points is the
 * same defect that produced the TB@LAD U7.5 bug on game totals.
 */
function buildBoard(payload, { minBooks = MIN_BOOKS } = {}) {
  if (!payload || !Array.isArray(payload.bookmakers)) return null;
  const home = payload.home_team;
  const away = payload.away_team;

  // marketType -> line -> sideKey -> [american, ...]
  const acc = {};
  // marketType -> [main-key points]
  const mainPoints = {};

  for (const book of payload.bookmakers) {
    for (const m of (book.markets || [])) {
      const map = MARKET_MAP[m.key];
      if (!map) continue;
      const type = map.type;
      for (const o of (m.outcomes || [])) {
        const price = Number(o.price);
        if (!Number.isFinite(price)) continue;

        let sideKey = null;
        let lineKey = null;

        if (type.endsWith('moneyline')) {
          if (o.name === home) sideKey = 'home';
          else if (o.name === away) sideKey = 'away';
          else continue;
          lineKey = 'ml';
        } else if (type === 'team_total') {
          const team = o.description;
          if (!team || o.point == null) continue;
          const side = String(o.name || '').toLowerCase();
          if (side !== 'over' && side !== 'under') continue;
          sideKey = `${team}|${side}`;
          lineKey = `${team}|${o.point}`;
          if (map.main) (mainPoints[`${type}|${team}`] ||= []).push(Number(o.point));
        } else if (type.endsWith('total')) {
          const side = String(o.name || '').toLowerCase();
          if (side !== 'over' && side !== 'under') continue;
          if (o.point == null) continue;
          sideKey = side;
          lineKey = String(o.point);
          if (map.main) (mainPoints[type] ||= []).push(Number(o.point));
        } else if (type.endsWith('spread')) {
          if (o.point == null) continue;
          if (o.name === home) sideKey = 'home';
          else if (o.name === away) sideKey = 'away';
          else continue;
          // Key the pair on the HOME point so home -3.5 and away +3.5 land on
          // the same line bucket.
          const homePoint = sideKey === 'home' ? Number(o.point) : -Number(o.point);
          lineKey = String(homePoint);
          if (map.main && sideKey === 'home') (mainPoints[type] ||= []).push(homePoint);
        } else {
          continue;
        }

        ((acc[type] ||= {})[lineKey] ||= {});
        (acc[type][lineKey][sideKey] ||= []).push(price);
      }
    }
  }

  const out = {};
  for (const [type, byLine] of Object.entries(acc)) {
    const lines = {};
    for (const [lineKey, bySide] of Object.entries(byLine)) {
      const sideKeys = Object.keys(bySide);
      // Identify the two complementary sides for this bucket.
      let pair = null;
      if (sideKeys.includes('home') && sideKeys.includes('away')) pair = ['home', 'away'];
      else if (sideKeys.includes('over') && sideKeys.includes('under')) pair = ['over', 'under'];
      else {
        const over = sideKeys.find(k => k.endsWith('|over'));
        const under = sideKeys.find(k => k.endsWith('|under'));
        if (over && under && over.split('|')[0] === under.split('|')[0]) pair = [over, under];
      }
      if (!pair) continue; // one-sided -> cannot de-vig -> skip

      const cA = consensusSide(bySide[pair[0]], minBooks);
      const cB = consensusSide(bySide[pair[1]], minBooks);
      if (!cA || !cB) continue; // MIN_BOOKS gate — decline beats a 1-book price

      const fair = deVigPair(cA.p, cB.p);
      if (!fair) continue;
      lines[lineKey] = {
        sides: pair,
        raw: { [pair[0]]: cA.p, [pair[1]]: cB.p },          // vig RETAINED (mirror)
        fair: { [pair[0]]: fair.a, [pair[1]]: fair.b },      // de-vigged
        books: { [pair[0]]: cA.books, [pair[1]]: cB.books },
        overround: fair.overround,
      };
    }
    if (!Object.keys(lines).length) continue;
    const mp = type === 'team_total' ? null : pickMainLine(mainPoints[type] || []);
    out[type] = { mainLine: mp, lines };
  }

  if (!Object.keys(out).length) return null;
  return { home, away, markets: out };
}

// ---------------------------------------------------------------------------
// FETCH LAYER — single-flight, TTL-cached, paced, fail-closed
// ---------------------------------------------------------------------------

const _cache = {};     // key -> { at, board|null }
const _inflight = {};  // key -> Promise
let _lastFetchAt = 0;

const _lastFetch = { at: null, ok: null, error: null, sport: null, event: null };

function _key(sport, home, away) {
  return `${sport}|${String(away).toLowerCase()}@${String(home).toLowerCase()}`;
}

function isFootball(sport) { return FOOTBALL_SPORTS.has(sport); }

async function _pace() {
  const since = Date.now() - _lastFetchAt;
  if (since < FETCH_SPACING_MS) {
    await new Promise(r => setTimeout(r, FETCH_SPACING_MS - since));
  }
  _lastFetchAt = Date.now();
}

/**
 * Fetch + cache the consensus board for one football game. Fail-closed on a
 * started or unknown-start game — we do not quote these live.
 */
async function ensureNflConsensus(sport, homeTeam, awayTeam, commenceTime, eventIdHint) {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey || !isFootball(sport)) return null;
  const startMs = commenceTime ? new Date(commenceTime).getTime() : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null;

  const key = _key(sport, homeTeam, awayTeam);
  const now = Date.now();
  const cached = _cache[key];
  if (cached && (now - cached.at) < TTL_MS) return cached.board;
  if (_inflight[key]) return _inflight[key];

  _inflight[key] = (async () => {
    try {
      let eventId = eventIdHint;
      if (!eventId) {
        const oddsFeed = require('./odds-feed');
        const resolved = await oddsFeed.resolveOddsApiEventId(sport, homeTeam, awayTeam, commenceTime);
        eventId = resolved && resolved.eventId;
      }
      if (!eventId) { _cache[key] = { at: now, board: null }; return null; }

      await _pace();
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds`
        + `?apiKey=${apiKey}`
        + `&regions=${NFL_REGIONS}`
        + `&markets=${NFL_MARKET_KEYS.join(',')}`
        + `&bookmakers=${NFL_BOOKS.join(',')}`
        + `&oddsFormat=american`;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let resp, data;
      try {
        resp = await require('node-fetch')(url, { signal: ctrl.signal });
        if (resp.status === 429 || resp.status >= 500) {
          // TRANSIENT — never cache as a miss. A 429 is indistinguishable from
          // "no such market" downstream, which is how unpaced bursts turn into
          // phantom coverage gaps.
          _lastFetch.at = new Date().toISOString();
          _lastFetch.ok = false;
          _lastFetch.error = `HTTP ${resp.status}`;
          log.warn('NflConsensus', `${sport} ${awayTeam}@${homeTeam}: transient HTTP ${resp.status} — not cached`);
          return cached ? cached.board : null;
        }
        if (!resp.ok) { _cache[key] = { at: now, board: null }; return null; }
        data = await resp.json();
      } catch (err) {
        _lastFetch.at = new Date().toISOString();
        _lastFetch.ok = false;
        _lastFetch.error = err.message;
        return cached ? cached.board : null; // transient: keep the old board
      } finally {
        clearTimeout(timer);
      }

      const board = buildBoard(data);
      _cache[key] = { at: Date.now(), board };
      _lastFetch.at = new Date().toISOString();
      _lastFetch.ok = !!board;
      _lastFetch.error = board ? null : 'no priceable markets';
      _lastFetch.sport = sport;
      _lastFetch.event = `${awayTeam} @ ${homeTeam}`;
      if (board) {
        const summary = Object.entries(board.markets)
          .map(([t, m]) => `${t}:${Object.keys(m.lines).length}`).join(' ');
        log.info('NflConsensus', `${sport} ${awayTeam}@${homeTeam} → ${summary}`);
      }
      return board;
    } finally {
      delete _inflight[key];
    }
  })();

  return _inflight[key];
}

/**
 * SYNC cache read for the RFQ hot path. Returns the DE-VIGGED fair probability
 * for one leg, or null (=> caller declines). Never fetches; boards are warmed
 * at line-seed time.
 *
 * `line` is optional for moneylines. For spread/total legs the exact line must
 * be present on the board — we do not interpolate.
 */
function getNflFairSync(sport, homeTeam, awayTeam, marketType, side, line) {
  if (!isFootball(sport)) return null;
  const entry = _cache[_key(sport, homeTeam, awayTeam)];
  if (!entry || !entry.board) return null;
  if (!entry.at || Date.now() - entry.at > MAX_AGE_MS) return null; // fail closed
  const mkt = entry.board.markets[marketType];
  if (!mkt) return null;

  let lineKey;
  if (marketType.endsWith('moneyline')) lineKey = 'ml';
  else if (line == null) return null;
  else lineKey = String(line);

  const row = mkt.lines[lineKey];
  if (!row) return null;
  const p = row.fair[side];
  if (!(p > 0 && p < 1)) return null;
  return {
    fairProb: p,
    rawProb: row.raw[side],
    books: row.books[side],
    mainLine: mkt.mainLine,
    basis: `TOA ${NFL_REGIONS} median consensus over ${row.books[side]} books, proportionally de-vigged (overround ${row.overround.toFixed(3)})`,
  };
}

/**
 * Resolve one PX lineInfo to its (sideKey, lineKey) on the consensus board and
 * return the de-vigged fair. Mirrors ufcMov.getMovFairForLine so the pricer has
 * a single call site and none of the market-shape knowledge.
 *
 * PX side vocabulary varies by market: 'home'/'away' for moneyline+spread,
 * 'over'/'under' for totals, and team totals carry BOTH a team (teamName, often
 * an abbreviation like "NYJ:") and a side, sometimes fused as 'home_over'.
 */
function getNflFairForLine(lineInfo) {
  if (!lineInfo || !isFootball(lineInfo.sport)) return null;
  const li = lineInfo;
  const type = li.marketType;
  const sel = String(li.selection || '').toLowerCase();

  if (type === 'team_total') {
    // side: explicit 'over'/'under', or the fused 'home_over' form.
    let ou = sel.includes('under') ? 'under' : sel.includes('over') ? 'over' : null;
    if (!ou) return null;
    // team: prefer an explicit home/away marker, else match teamName.
    let team = null;
    if (sel.startsWith('home')) team = li.homeTeam;
    else if (sel.startsWith('away')) team = li.awayTeam;
    else if (li.teamSide === 'home') team = li.homeTeam;
    else if (li.teamSide === 'away') team = li.awayTeam;
    if (!team) return null;
    return getNflFairSync(li.sport, li.homeTeam, li.awayTeam, type,
      `${team}|${ou}`, `${team}|${li.line}`);
  }

  if (type.endsWith('total')) {
    const ou = sel === 'over' || sel === 'under' ? sel : null;
    if (!ou) return null;
    return getNflFairSync(li.sport, li.homeTeam, li.awayTeam, type, ou, li.line);
  }

  // moneyline + spread
  let side = null;
  if (sel === 'home' || sel === 'away') side = sel;
  else if (li.teamName && li.homeTeam && li.teamName === li.homeTeam) side = 'home';
  else if (li.teamName && li.awayTeam && li.teamName === li.awayTeam) side = 'away';
  if (!side) return null;

  // Spread line buckets are keyed on the HOME point (see buildBoard), so an
  // away leg at +3.5 must look up -3.5.
  let lineKey;
  if (type.endsWith('moneyline')) lineKey = null;
  else {
    if (li.line == null) return null;
    lineKey = side === 'home' ? Number(li.line) : -Number(li.line);
  }
  return getNflFairSync(li.sport, li.homeTeam, li.awayTeam, type, side, lineKey);
}

/**
 * Is there a FRESH board for this game? The pricer needs to tell two failures
 * apart:
 *   cold board  -> fall through to the legacy odds path (a missing line is
 *                  worse than a declined RFQ — the golf top-N lesson)
 *   fresh board, line below MIN_BOOKS -> DECLINE, because that is the
 *                  operator's hard rule and falling through would price the
 *                  very line the rule exists to refuse.
 */
function hasFreshBoard(sport, homeTeam, awayTeam) {
  if (!isFootball(sport)) return false;
  const e = _cache[_key(sport, homeTeam, awayTeam)];
  return !!(e && e.board && e.at && (Date.now() - e.at) <= MAX_AGE_MS);
}

/**
 * Warm boards for a list of upcoming football games. Called at line-seed time.
 * Serial and paced on purpose — see the rate-limit note in the header; an
 * unpaced fan-out 429s and every 429 reads downstream as "no coverage".
 */
async function warmFootballBoards(games = []) {
  let ok = 0, miss = 0;
  for (const g of games) {
    if (!g || !isFootball(g.sport)) continue;
    try {
      const b = await ensureNflConsensus(g.sport, g.homeTeam, g.awayTeam, g.commenceTime, g.eventId);
      if (b) ok++; else miss++;
    } catch (err) {
      miss++;
      log.warn('NflConsensus', `warm failed ${g.awayTeam}@${g.homeTeam}: ${err.message}`);
    }
  }
  if (ok || miss) log.info('NflConsensus', `warm: ${ok} boards, ${miss} missed`);
  return { ok, miss };
}

function __debugState() {
  return {
    books: NFL_BOOKS,
    regions: NFL_REGIONS,
    markets: NFL_MARKET_KEYS,
    minBooks: MIN_BOOKS,
    ttlMs: TTL_MS,
    maxAgeMs: MAX_AGE_MS,
    lastFetch: _lastFetch,
    cached: Object.entries(_cache).map(([k, v]) => ({
      key: k,
      ageMs: v.at ? Date.now() - v.at : null,
      markets: v.board ? Object.fromEntries(Object.entries(v.board.markets)
        .map(([t, m]) => [t, Object.keys(m.lines).length])) : null,
    })),
  };
}

module.exports = {
  ensureNflConsensus,
  getNflFairSync,
  getNflFairForLine,
  hasFreshBoard,
  warmFootballBoards,
  isFootball,
  buildBoard,
  __debugState,
  // pure helpers exported for tests
  impliedFromAmerican,
  americanFromImplied,
  median,
  consensusSide,
  deVigPair,
  pickMainLine,
  __clearCacheForTest: () => { for (const k in _cache) delete _cache[k]; },
  __setCacheForTest: (k, v) => { _cache[k] = v; },
};
