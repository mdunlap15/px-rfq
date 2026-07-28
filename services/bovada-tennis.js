/**
 * Bovada tennis game-lines source (moneyline / game spread / total).
 *
 * WHY THIS EXISTS
 * ---------------
 * Tennis went dark repeatedly (35h on 2026-07-21, 17h on 07-23, and all of
 * 07-26) because both existing sources fail for the tournaments PX actually
 * lists:
 *
 *   - The Odds API: catalogs only Slams and Masters-level events. Verified
 *     2026-07-26 — all 41 TOA tennis keys were INACTIVE, and there is no key
 *     at all for ATP Washington, ATP Los Cabos or WTA Washington, which was
 *     the entire 30-event PX slate for the week. TOA can never cover these.
 *   - DK scraper: works locally (41/41 matches with h2h+totals+spreads) but
 *     returns EMPTY from Railway — the same Akamai/datacenter-IP gating that
 *     forced the golf-outright paste path. Prod tennis cache sat at 0 events
 *     for 18+ hours while the scrape succeeded from a laptop.
 *
 * Bovada's coupon endpoint is plain HTTPS JSON — no Puppeteer, no browser
 * challenge, no Akamai gate — so it runs server-side on Railway. Verified
 * 2026-07-26: 115 tennis events, each carrying Moneyline + Game Spread +
 * Total, matching PX's slate name-for-name (Norrie/Kovacevic,
 * Shapovalov/Hijikata, Brooksby/Moutet, ...).
 *
 * SINGLE-BOOK CAVEAT: this is one book, so the "fair" is a 2-way de-vig of
 * Bovada's own two sides, not a multi-book consensus. Same basis the DK
 * tennis merge already uses (books:1). It is a coverage source of last
 * resort — odds-feed merges it ADDITIVELY, so a TOA multi-book consensus or
 * a DK board always wins when either exists.
 *
 * One network call covers the whole sport (the coupon embeds all three
 * markets), so there is no per-event fan-out and no rate-limit exposure.
 */

const log = require('./logger');

const COUPON_URL = 'https://www.bovada.lv/services/sports/event/coupon/events/A/description/tennis'
  + '?marketFilterId=def&preMatchOnly=true&lang=en';
const FETCH_TIMEOUT_MS = Number(process.env.BOVADA_TENNIS_TIMEOUT_MS) || 15000;

let _fetch;
function fetchFn() {
  if (!_fetch) _fetch = global.fetch ? global.fetch.bind(global) : require('node-fetch');
  return _fetch;
}

const amerToProb = (a) => {
  if (a == null) return null;
  if (a === 'EVEN' || a === 'even') return 0.5;
  const n = typeof a === 'string' ? parseInt(a, 10) : a;
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
};
const toAmer = (a) => {
  if (a == null) return null;
  if (a === 'EVEN' || a === 'even') return 100;
  const n = typeof a === 'string' ? parseInt(a, 10) : a;
  return Number.isFinite(n) ? n : null;
};
const toLine = (h) => {
  if (h == null) return null;
  const n = typeof h === 'string' ? parseFloat(h) : h;
  return Number.isFinite(n) ? n : null;
};
/** Proportional 2-way de-vig — matches odds-feed's convention for 2-way markets. */
function devig2(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  const t = a + b;
  if (!(t > 0)) return null;
  return { a: a / t, b: b / t };
}

/**
 * Fetch and parse Bovada's tennis coupon.
 * Returns { games: [...], fetchedAt } shaped like dk-scraper.fetchDkGameLines
 * so odds-feed can merge it with the same code path.
 *   game = { homeTeam, awayTeam, startTime, eventId, started,
 *            h2h:{home,away}, totalsByLine:{}, spreadsByLine:{} }
 * Never throws — returns { games: [] } on any failure so a bad Bovada
 * response can never break the refresh cycle.
 */
async function fetchBovadaTennis() {
  const started = Date.now();
  let body;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetchFn()(COUPON_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.bovada.lv/sports',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    body = await r.json();
  } catch (err) {
    log.warn('BovadaTennis', `fetch failed: ${err.message}`);
    return { games: [], fetchedAt: Date.now(), error: err.message };
  } finally {
    clearTimeout(timer);
  }

  const events = [];
  for (const grp of (Array.isArray(body) ? body : [])) {
    for (const e of (grp.events || [])) events.push(e);
  }

  const now = Date.now();
  const games = [];
  let skippedNoPair = 0, skippedLive = 0;

  for (const e of events) {
    // Home/away come from the competitors array, NOT the description string —
    // Bovada writes "A vs B" where A is the HOME side, but relying on the
    // string would break on any name containing " vs ".
    const comps = e.competitors || [];
    const homeC = comps.find(c => c.home === true);
    const awayC = comps.find(c => c.home === false);
    if (!homeC || !awayC || !homeC.name || !awayC.name) { skippedNoPair++; continue; }

    const startMs = Number(e.startTime) || null;
    const isLive = !!e.live || (startMs != null && startMs <= now);
    if (isLive) { skippedLive++; continue; } // never surface in-play prices

    const g = {
      homeTeam: String(homeC.name).trim(),
      awayTeam: String(awayC.name).trim(),
      startTime: startMs ? new Date(startMs).toISOString() : null,
      eventId: String(e.id || ''),
      started: false,
      h2h: null,
      totalsByLine: {},
      spreadsByLine: {},
    };

    for (const dg of (e.displayGroups || [])) {
      for (const m of (dg.markets || [])) {
        // Match-level only. Bovada also publishes set/game markets; those are
        // different products and must not be merged into game lines.
        const per = (m.period && (m.period.abbreviation || m.period.description)) || '';
        if (per !== 'MT' && per !== 'Match') continue;
        const desc = String(m.description || '');
        const outs = m.outcomes || [];

        if (desc === 'Moneyline') {
          const h = outs.find(o => o.type === 'H'), a = outs.find(o => o.type === 'A');
          const ha = toAmer(h && h.price && h.price.american);
          const aa = toAmer(a && a.price && a.price.american);
          const hp = amerToProb(ha), ap = amerToProb(aa);
          const fair = devig2(hp, ap);
          if (fair) {
            g.h2h = {
              home: { americanOdds: ha, impliedProb: hp, fairProb: fair.a },
              away: { americanOdds: aa, impliedProb: ap, fairProb: fair.b },
            };
          }
        } else if (desc === 'Total') {
          const ov = outs.find(o => o.type === 'O'), un = outs.find(o => o.type === 'U');
          const line = toLine(ov && ov.price && ov.price.handicap);
          const oa = toAmer(ov && ov.price && ov.price.american);
          const ua = toAmer(un && un.price && un.price.american);
          const op = amerToProb(oa), up = amerToProb(ua);
          const fair = devig2(op, up);
          if (line != null && fair) {
            g.totalsByLine[String(line)] = {
              line,
              over: { americanOdds: oa, impliedProb: op, fairProb: fair.a },
              under: { americanOdds: ua, impliedProb: up, fairProb: fair.b },
            };
          }
        } else if (desc === 'Game Spread') {
          const h = outs.find(o => o.type === 'H'), a = outs.find(o => o.type === 'A');
          // Key by the HOME side's signed handicap, matching the
          // "'home|'+line" convention odds-feed's tennis spread block expects.
          const line = toLine(h && h.price && h.price.handicap);
          const ha = toAmer(h && h.price && h.price.american);
          const aa = toAmer(a && a.price && a.price.american);
          const hp = amerToProb(ha), ap = amerToProb(aa);
          const fair = devig2(hp, ap);
          if (line != null && fair) {
            g.spreadsByLine[String(line)] = {
              line,
              home: { americanOdds: ha, impliedProb: hp, fairProb: fair.a },
              away: { americanOdds: aa, impliedProb: ap, fairProb: fair.b },
            };
          }
        }
      }
    }

    if (!g.h2h) continue; // a game with no moneyline is not usable
    games.push(g);
  }

  log.info('BovadaTennis', `${games.length} pre-match games (${events.length} coupon events, `
    + `skipped ${skippedLive} live + ${skippedNoPair} unpaired) in ${Date.now() - started}ms`);
  return { games, fetchedAt: Date.now() };
}

// Last successful board, kept so odds-feed can RE-APPLY it after a wholesale
// oddsCache['tennis'] replacement without paying another network round-trip.
// Without this the merge loses a race it can never win: fetchOddsForSport
// replaces the whole tennis cache object every refresh cycle, destroying the
// merged events, and the fire-and-forget re-merge only refills them some
// seconds later — producing an observed 17 -> 369 -> 16 sawtooth where RFQs
// landing in a trough decline "no fair value" despite the line being
// registered.
let _lastBoard = null;
function rememberBoard(b) {
  if (b && Array.isArray(b.games) && b.games.length) _lastBoard = b;
  return b;
}
/** Last good board, or null. Age-checked by the caller. */
function getLastBoard() { return _lastBoard; }

module.exports = {
  fetchBovadaTennis,
  rememberBoard,
  getLastBoard,
  __devig2: devig2,
  __amerToProb: amerToProb,
};
