/**
 * Pinnacle tennis game-lines source (moneyline / game spread / total games).
 *
 * WHY THIS EXISTS
 * ---------------
 * PX registers a full ladder per tennis match (game spreads +/-1.5..4.5, total
 * games 20.5..26.5) but our sources could only price a sliver of it:
 *
 *   - The Odds API catalogs only Slam/Masters-level events. Probed 2026-08-01:
 *     the ENTIRE active tennis catalogue was tennis_atp_canadian_open,
 *     tennis_atp_washington_open, tennis_wta_canadian_open. ATP Los Cabos --
 *     which PX was listing -- has no TOA key at all and never will.
 *   - DraftKings posts no game spread and no match total for small tournaments.
 *     Recon 2026-08-01 on Gea/Shapovalov returned moneyline, set winners,
 *     PLAYER total games (12.5), break points and tie-break -- and nothing we
 *     could price PX's ladder from.
 *   - Bovada (services/bovada-tennis.js) carries the markets but posts ONE line
 *     each: a single integer game spread (2) against PX's half-point-only
 *     ladder, so zero spread overlap, and one total. Measured on that match:
 *     4 of 30 registered lines were quotable.
 *
 * Pinnacle carries the real ladder AND is the sharpest tennis book. Its guest
 * API is plain HTTPS JSON -- no Puppeteer, no Akamai gate -- so unlike the DK
 * path it works from Railway (the same reason the Bovada coupon path exists).
 * Two calls cover the whole sport, so there is no per-event fan-out and no
 * rate-limit exposure:
 *     /0.1/sports/33/matchups          ~213 matchups
 *     /0.1/sports/33/markets/straight  ~2400 market rows
 *
 * THE SETS/GAMES TRAP -- the whole reason this file is careful
 * -----------------------------------------------------------
 * Pinnacle models ONE tennis match as TWO matchups:
 *
 *   1633230155  units="Sets"   parentId=null           <- the match
 *   1633246783  units="Games"  parentId=1633230155     <- its games markets
 *
 * The markets feed returns BOTH, and the market `key` is IDENTICAL between
 * them. Measured on Gea/Shapovalov, `s;0;s;1.5` appears twice:
 *
 *   matchupId 1633230155 (Sets)   home 1.5 @ -202 / away -1.5 @ +171
 *   matchupId 1633246783 (Games)  home 1.5 @ -104 / away -1.5 @ -112
 *
 * One is "wins the match by 1.5 SETS", the other "by 1.5 GAMES". Same key,
 * same points value, wildly different prices. Keying on `key` or on `points`
 * silently prices a games spread off a sets line -- a far worse error than the
 * coverage gap this file closes, and an invisible one, since both look like
 * perfectly ordinary 1.5 spreads.
 *
 * Therefore: spreads and totals are read ONLY from the Games child matchup,
 * resolved through matchupId -> units. A market row whose matchupId we cannot
 * resolve to a known matchup is DROPPED, never guessed (52 of 2409 rows on the
 * probe referenced unknown matchups). Totals of 2.5 are sets totals and are
 * excluded by construction, not by a magnitude heuristic.
 *
 * PERIOD: only period 0 (full match) is used. Period 1 is the first set --
 * PX's "1st Set" markets are a different product we do not register.
 *
 * SINGLE-BOOK CAVEAT: like the Bovada path, "fair" here is a 2-way de-vig of
 * Pinnacle's own two sides, not a multi-book consensus. Pinnacle is the sharp
 * reference book, so this is the best single-book basis available -- but
 * odds-feed still merges it ADDITIVELY so a TOA multi-book consensus wins
 * wherever one exists.
 */

const log = require('./logger');

const API_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
// Public key the pinnacle.com web frontend ships to every visitor. Not a
// credential -- overridable in case they rotate it.
const API_KEY = process.env.PINNACLE_API_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
const TENNIS_SPORT_ID = Number(process.env.PINNACLE_TENNIS_SPORT_ID) || 33;
const FETCH_TIMEOUT_MS = Number(process.env.PINNACLE_TENNIS_TIMEOUT_MS) || 15000;

let _fetch;
function fetchFn() {
  if (!_fetch) _fetch = global.fetch ? global.fetch.bind(global) : require('node-fetch');
  return _fetch;
}

const amerToProb = (a) => {
  const n = typeof a === 'string' ? parseInt(a, 10) : a;
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
};

/** Proportional 2-way de-vig — matches odds-feed's convention for 2-way markets. */
function devig2(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  const t = a + b;
  if (!(t > 0)) return null;
  return { a: a / t, b: b / t };
}

async function getJson(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetchFn()(API_BASE + path, {
      signal: ctrl.signal,
      headers: {
        'X-API-Key': API_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.pinnacle.com/',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build { games: [...], fetchedAt } in the same shape as
 * bovada-tennis.fetchBovadaTennis / dk-scraper.fetchDkGameLines so odds-feed
 * merges it through an equivalent code path:
 *   game = { homeTeam, awayTeam, startTime, eventId, started,
 *            h2h:{home,away}, totalsByLine:{}, spreadsByLine:{} }
 * Never throws — returns { games: [] } on any failure so a bad Pinnacle
 * response can never break the refresh cycle.
 */
async function fetchPinnacleTennis() {
  const startedAt = Date.now();
  let matchups, markets;
  try {
    // Sequential, not parallel: two tiny calls, and serialising keeps our
    // footprint on a public endpoint minimal.
    matchups = await getJson(`/sports/${TENNIS_SPORT_ID}/matchups`);
    markets = await getJson(`/sports/${TENNIS_SPORT_ID}/markets/straight`);
  } catch (err) {
    log.warn('PinnacleTennis', `fetch failed: ${err.message}`);
    return { games: [], fetchedAt: Date.now(), error: err.message };
  }
  if (!Array.isArray(matchups) || !Array.isArray(markets)) {
    log.warn('PinnacleTennis', 'unexpected payload shape');
    return { games: [], fetchedAt: Date.now(), error: 'bad shape' };
  }

  // matchupId -> matchup, and parent -> its Games child.
  const byId = new Map();
  for (const m of matchups) if (m && m.id != null) byId.set(m.id, m);
  const gamesChildOf = new Map(); // parentId -> games matchup
  for (const m of matchups) {
    if (m && m.parentId != null && m.units === 'Games') gamesChildOf.set(m.parentId, m);
  }

  // Bucket market rows by matchupId, dropping any we cannot attribute.
  const rowsByMatchup = new Map();
  let unresolved = 0;
  for (const row of markets) {
    if (!row || row.matchupId == null) { unresolved++; continue; }
    if (!byId.has(row.matchupId)) { unresolved++; continue; } // never guess units
    if (row.status && row.status !== 'open') continue;
    if (row.period !== 0) continue; // full match only; period 1 = first set
    if (!rowsByMatchup.has(row.matchupId)) rowsByMatchup.set(row.matchupId, []);
    rowsByMatchup.get(row.matchupId).push(row);
  }

  const now = Date.now();
  const games = [];
  let skippedLive = 0, skippedNoMl = 0, withTot = 0, withSp = 0, noGamesChild = 0;

  for (const parent of matchups) {
    // The real match is the Sets-unit matchup with no parent. Its Games child
    // carries the ladder we actually want.
    if (!parent || parent.parentId != null) continue;
    if (parent.units !== 'Sets') continue;

    const parts = parent.participants || [];
    const homeC = parts.find(p => p.alignment === 'home');
    const awayC = parts.find(p => p.alignment === 'away');
    if (!homeC || !awayC || !homeC.name || !awayC.name) continue;

    const startMs = parent.startTime ? Date.parse(parent.startTime) : NaN;
    const isLive = (parent.isLive === true)
      || (Number.isFinite(startMs) && startMs <= now);
    if (isLive) { skippedLive++; continue; } // never surface in-play prices

    const g = {
      homeTeam: String(homeC.name).trim(),
      awayTeam: String(awayC.name).trim(),
      startTime: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
      eventId: String(parent.id),
      league: (parent.league && parent.league.name) || null,
      started: false,
      h2h: null,
      totalsByLine: {},
      spreadsByLine: {},
    };

    // --- Moneyline: from the PARENT (match winner is unit-agnostic) ---------
    for (const row of (rowsByMatchup.get(parent.id) || [])) {
      if (row.type !== 'moneyline') continue;
      const prices = row.prices || [];
      const h = prices.find(p => p.designation === 'home');
      const a = prices.find(p => p.designation === 'away');
      const hp = amerToProb(h && h.price), ap = amerToProb(a && a.price);
      const fair = devig2(hp, ap);
      if (fair) {
        g.h2h = {
          home: { americanOdds: h.price, impliedProb: hp, fairProb: fair.a },
          away: { americanOdds: a.price, impliedProb: ap, fairProb: fair.b },
        };
      }
      break;
    }
    if (!g.h2h) { skippedNoMl++; continue; } // no moneyline = unusable

    // --- Spreads / totals: ONLY from the Games child ------------------------
    const child = gamesChildOf.get(parent.id);
    if (!child) {
      noGamesChild++;
    } else {
      for (const row of (rowsByMatchup.get(child.id) || [])) {
        const prices = row.prices || [];
        if (row.type === 'spread') {
          const h = prices.find(p => p.designation === 'home');
          const a = prices.find(p => p.designation === 'away');
          if (!h || !a || h.points == null) continue;
          const hp = amerToProb(h.price), ap = amerToProb(a.price);
          const fair = devig2(hp, ap);
          if (!fair) continue;
          // Key by the HOME side's signed handicap — the convention
          // odds-feed's tennis spread block and getFairProb's alt path expect.
          g.spreadsByLine[String(h.points)] = {
            line: h.points,
            home: { americanOdds: h.price, impliedProb: hp, fairProb: fair.a },
            away: { americanOdds: a.price, impliedProb: ap, fairProb: fair.b },
          };
        } else if (row.type === 'total') {
          const ov = prices.find(p => p.designation === 'over');
          const un = prices.find(p => p.designation === 'under');
          if (!ov || !un || ov.points == null) continue;
          const op = amerToProb(ov.price), up = amerToProb(un.price);
          const fair = devig2(op, up);
          if (!fair) continue;
          g.totalsByLine[String(ov.points)] = {
            line: ov.points,
            over: { americanOdds: ov.price, impliedProb: op, fairProb: fair.a },
            under: { americanOdds: un.price, impliedProb: up, fairProb: fair.b },
          };
        }
        // team_total is PLAYER games won — a different product from PX's
        // "Total Games"; deliberately not collected.
      }
    }

    if (Object.keys(g.totalsByLine).length) withTot++;
    if (Object.keys(g.spreadsByLine).length) withSp++;
    games.push(g);
  }

  log.info('PinnacleTennis', `${games.length} pre-match games (${matchups.length} matchups, `
    + `${withTot} w/totals, ${withSp} w/spreads, skipped ${skippedLive} live + ${skippedNoMl} no-ML, `
    + `${noGamesChild} w/o games child, ${unresolved} unattributable market rows) in ${Date.now() - startedAt}ms`);
  return { games, fetchedAt: Date.now() };
}

// Last successful board, kept so odds-feed can RE-APPLY it after a wholesale
// oddsCache['tennis'] replacement without another network round-trip. Same
// sawtooth problem documented in bovada-tennis.js: fetchOddsForSport replaces
// the whole tennis cache object every cycle, destroying merged events, and a
// fire-and-forget re-merge only refills them seconds later — RFQs landing in a
// trough decline "no fair value" despite the line being registered.
let _lastBoard = null;
function rememberBoard(b) {
  if (b && Array.isArray(b.games) && b.games.length) _lastBoard = b;
  return b;
}
/** Last good board, or null. Age-checked by the caller. */
function getLastBoard() { return _lastBoard; }

module.exports = {
  fetchPinnacleTennis,
  rememberBoard,
  getLastBoard,
  __devig2: devig2,
  __amerToProb: amerToProb,
};
