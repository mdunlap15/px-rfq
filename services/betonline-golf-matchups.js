'use strict';
/**
 * BetOnline golf ROUND MATCHUP board — the ±0.5 spread source.
 *
 * WHY THIS EXISTS
 * PX posts two markets per golf matchup:
 *   1. "<A> vs. <B> (Round N Matchup)"            type=moneyline     — TIES VOID
 *   2. "<A> vs. <B> (Round N Matchup) - Spread"   type=sup_moneyline — ±0.5, TIES COUNT
 * They are DIFFERENT PRODUCTS. Every widely-available matchup feed (DataGolf,
 * and the books it aggregates) publishes the ties-VOID price. Measured
 * 2026-08-27, the single-round tie probability is 9.3% (range 8.1-9.9%,
 * independently confirmed at 9.2% from PX's own two markets). Pricing the
 * ±0.5 spread off a ties-void fair therefore UNDERPRICES the +0.5 side by
 * ~9pp — against a total parlay margin of 1-2pp. This module exists so the
 * spread is priced off a ±0.5 board, same basis, no conversion.
 *
 * A useful side effect: the ±0.5 market never voids on a tie, which removes
 * the void-leg artifact that corrupted the golf calibration numbers (golf was
 * 22.6% of void-affected tickets — i.e. roughly the tie rate compounded).
 *
 * SCRAPING NOTES (both were load-bearing; a bare Puppeteer launch fails)
 *   1. BetOnline serves a stripped ~1090-char shell to DETECTED AUTOMATION.
 *      `--disable-blink-features=AutomationControlled` plus masking
 *      navigator.webdriver is what makes the real page render. Without it the
 *      page 200s and looks alive while containing zero odds — a silent empty.
 *   2. The deep link DOES NOT HYDRATE. Loading the round URL directly renders
 *      the homepage. You must let the SPA boot and then CLICK the round's own
 *      nav link. Navigating straight to the URL and parsing yields nothing.
 * Both failure modes look identical from the outside (page loads, no data), so
 * the fetch below treats "board parsed but empty" as an ERROR, never as "no
 * matchups today".
 *
 * Cost is ~40s per scrape, so this is warmed in the BACKGROUND and read
 * synchronously on the RFQ hot path — same shape as services/golf-topn.js.
 * TTL (warm cadence) and MAX_AGE (read tolerance) are deliberately separate:
 * conflating them made top-N go dead for ~2.5min every cycle because the board
 * expired at TTL while the re-scrape was still running.
 */
const log = require('./logger');
const { config } = require('../config');

let _puppeteer = null;
function puppeteer() {
  if (!_puppeteer) _puppeteer = require('puppeteer');
  return _puppeteer;
}

const NAV_TIMEOUT_MS = 60000;
// Entry point for round discovery when no explicit URL is configured.
const GOLF_INDEX_URL = 'https://www.betonline.ag/sportsbook/golf';

let _board = null;      // { at, url, rows: [...] }
let _inFlight = null;
let _lastError = null;
let _consecutiveFailures = 0;

const imp = (o) => {
  const n = Number(o);
  if (!Number.isFinite(n) || n === 0) return null;
  return n >= 0 ? 100 / (n + 100) : -n / (-n + 100);
};

/** Strip accents/punctuation so "Vinícius" and "Vinicius" compare equal. */
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse one scraped row's text into a matchup.
 * Row text (newline separated) looks like:
 *   Tomorrow, | 11:12 AM | 7201 - | Kristoffer Reitan | 7202 - | Russell Henley
 *   | Spread | +0.5 | +102 | -0.5 | -133 | Moneyline | +133 | -160
 * Returns null (never a partial) if any required piece is missing — a
 * half-parsed matchup priced as if whole is worse than no quote.
 */
function parseRow(text) {
  const t = String(text).split('\n').map(s => s.trim()).filter(Boolean);
  const players = [];
  for (let i = 0; i < t.length; i++) {
    if (/^\d{3,5}\s*-$/.test(t[i]) && t[i + 1] && /[a-z]/i.test(t[i + 1])) {
      players.push({ id: t[i].replace(/\D/g, ''), name: t[i + 1] });
    }
  }
  if (players.length !== 2) return null;

  const si = t.findIndex(x => /^spread$/i.test(x));
  const mi = t.findIndex(x => /^moneyline$/i.test(x));
  if (si < 0) return null;

  // Spread block: handicap, odds, handicap, odds — in player order.
  const sp = t.slice(si + 1, mi > si ? mi : si + 5);
  if (sp.length < 4) return null;
  const h1 = sp[0], o1 = sp[1], h2 = sp[2], o2 = sp[3];
  if (!/^[+-]0\.5$/.test(h1) || !/^[+-]0\.5$/.test(h2)) return null;
  if (h1 === h2) return null;                       // must be opposite sides
  const so1 = imp(o1), so2 = imp(o2);
  if (so1 == null || so2 == null) return null;

  // Moneyline block is optional — used only for the tie-rate sanity check.
  let ml1 = null, ml2 = null;
  if (mi > 0 && t[mi + 1] && t[mi + 2]) { ml1 = Number(t[mi + 1]); ml2 = Number(t[mi + 2]); }

  const hold = so1 + so2;
  if (!(hold > 1) || hold > 1.25) return null;      // sane 2-way overround only
  return {
    players: [players[0].name, players[1].name],
    ids: [players[0].id, players[1].id],
    spread: [
      { player: players[0].name, handicap: h1, american: Number(o1), raw: so1, fair: so1 / hold },
      { player: players[1].name, handicap: h2, american: Number(o2), raw: so2, fair: so2 / hold },
    ],
    holdPct: (hold - 1) * 100,
    moneylineAmerican: (ml1 != null && ml2 != null) ? [ml1, ml2] : null,
  };
}

/** The tie rate implied by this board's own spread-vs-moneyline gap. Pure sanity check. */
function impliedTieRate(rows) {
  const ts = [];
  for (const r of rows) {
    if (!r.moneylineAmerican) continue;
    const [m1, m2] = r.moneylineAmerican.map(imp);
    if (m1 == null || m2 == null) continue;
    const mh = m1 + m2;
    const favIdx = r.spread[0].handicap === '-0.5' ? 0 : 1;
    const mlFav = (favIdx === 0 ? m1 : m2) / mh;
    const t = mlFav > 0 ? 1 - (r.spread[favIdx].fair / mlFav) : NaN;
    if (Number.isFinite(t)) ts.push(t);
  }
  if (!ts.length) return null;
  ts.sort((a, b) => a - b);
  return ts[ts.length >> 1];
}


/**
 * Parse an OPERATOR PASTE of a round matchup board.
 *
 * Exists because the scraped book and PX construct DIFFERENT pairings for the
 * same round. Measured 2026-08-29 R3: only 2 of 14 scraped pairings matched
 * PX's, so 12 matchups were registered-but-unpriceable. Round 2 matched 14/14
 * because both sides used tee-time groupings; from R3 the books build their own
 * head-to-heads (PX even lists one player in two matchups, which a tee-time
 * pairing cannot do). No amount of scraping fixes that — only a board built on
 * the SAME pairings PX uses will price them, and the operator can supply it.
 *
 * Block format (repeating, whitespace-trimmed):
 *   ROUND <N> MATCHUP - <TOURNAMENT>
 *   <date>            e.g. 08/29
 *   <time>            e.g. 11:19
 *   <player 1>
 *   <player 2>
 *   <moneyline 1>     ties-void
 *   <moneyline 2>
 *   <handicap 1>      +0.5 / -0.5
 *   <spread odds 1>
 *   <handicap 2>
 *   <spread odds 2>
 *
 * Returns { round, rows } or throws. Rows use the SAME shape as the scraper so
 * every downstream consumer is unchanged.
 */
function parsePasteText(text) {
  const t = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const rows = [];
  let round = null;
  for (let i = 0; i < t.length; i++) {
    const hdr = /^ROUND\s+(\d+)\s+MATCHUP/i.exec(t[i]);
    if (!hdr) continue;
    const r = parseInt(hdr[1], 10);
    if (round == null) round = r;
    else if (round !== r) throw new Error(`paste mixes rounds ${round} and ${r} — refusing`);
    const b = t.slice(i + 1, i + 11);
    if (b.length < 10) continue;
    const [, , p1, p2, ml1, ml2, h1, o1, h2, o2] = b;
    // Reuse the scraper's own row parser so paste and scrape cannot diverge in
    // de-vig, validation or field names — one definition, two sources.
    const row = parseRow([
      '', '', '7001 -', p1, '7002 -', p2,
      'Spread', h1, o1, h2, o2, 'Moneyline', ml1, ml2,
    ].join('\n'));
    if (row) rows.push(row);
  }
  if (!rows.length) throw new Error('no matchups parsed from paste');
  return { round, rows };
}

/**
 * Install an operator-pasted board. Takes PRIORITY over the scrape: the
 * operator pastes deliberately, from the book whose pairings actually match
 * PX's, so a later scrape must not silently replace it.
 */
function loadPaste(text) {
  const { round, rows } = parsePasteText(text);
  const tie = impliedTieRate(rows);
  // Same basis gate the scraper applies. A board outside this band is probably
  // not the ties-COUNT +/-0.5 product, and pricing PX's spread off a ties-void
  // board gives away ~9pp on the +0.5 side.
  if (tie != null && (tie < 0.04 || tie > 0.16)) {
    throw new Error(`implied tie rate ${(100 * tie).toFixed(1)}% outside the 4-16% band — refusing (is this really a +/-0.5 board?)`);
  }
  _board = { at: Date.now(), url: 'operator-paste', round, rows, source: 'paste' };
  _lastError = null;
  log.info('BoGolf', `Paste accepted: ${rows.length} matchups, round ${round}` +
    (tie != null ? `, implied tie rate ${(100 * tie).toFixed(1)}%` : ''));
  return { round, matchups: rows.length, impliedTieRate: tie };
}

async function _scrape({ round = null, url = null } = {}) {
  let resolvedUrl = url;
  let resolvedRound = round;
  const browser = await puppeteer().launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      // Load-bearing: without this BetOnline serves a stripped shell with no odds.
      '--disable-blink-features=AutomationControlled',
      '--window-size=1600,1400',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });
    await page.setViewport({ width: 1600, height: 1400 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ROUND SUBSTITUTION rather than discovery. Measured 2026-08-28: the ONLY
    // page that hydrates its nav is a valid round URL itself — the homepage,
    // /sportsbook, /sportsbook/golf and the tournament's fed-ex-events page all
    // render chrome with ZERO board links, so there is no neutral page to
    // discover from. The round number is the only part of the URL that changes
    // between rounds, so swap it in directly: the configured URL becomes a
    // per-TOURNAMENT setting and rounds advance on their own.
    let entry = url;
    if (entry && round != null) {
      const swapped = entry.replace(/round-\d+/i, `round-${round}`);
      if (swapped !== entry) log.info('BoGolf', `Round ${round}: ${entry} -> ${swapped}`);
      entry = swapped;
    }
    await page.goto(entry || GOLF_INDEX_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    await new Promise(r => setTimeout(r, 10000));

    // Enumerate every round link the SPA rendered. Discovery beats slugifying
    // the tournament name: PX says "2026 The Open" while the book's slug is
    // "the-open-championship", so a slugifier is wrong exactly when it matters
    // (the same trap GOLF_DK_SLUG_MAP exists to paper over for DK).
    // Match ONLY the round BOARD link: exactly two segments after /golf/.
    // The page also renders one link per matchup
    // (/sportsbook/golf/fedex-round-2/game/491114549), and a looser pattern
    // matches all 14 of those instead — which then reads as "14 tournaments"
    // and aborts. Note the board slug is `fed-ex-round-2` while the game links
    // use `fedex-round-2`, so the segment count is the reliable discriminator,
    // not the slug spelling.
    const links = await page.evaluate(() => [...document.querySelectorAll('a')]
      .map(a => a.getAttribute('href') || '')
      .filter(h => /^\/sportsbook\/golf\/[^/]*round-\d+\/[^/?#]+$/i.test(h)));
    const seen = [...new Set(links)];
    const parseRound = (h) => { const m = /round-(\d+)/i.exec(h); return m ? parseInt(m[1], 10) : null; };

    let target = null;
    if (round != null) {
      // The loaded round page renders exactly its own board link. Requiring it
      // to match the round we asked for is what catches a silently wrong page
      // (a round that does not exist yet redirects rather than 404ing).
      const exact = seen.filter(h => parseRound(h) === round);
      if (exact.length === 1) target = exact[0];
      else if (exact.length > 1) {
        throw new Error(`round ${round} matched ${exact.length} boards (${exact.join(', ')}) — set BETONLINE_GOLF_URL to disambiguate`);
      }
    }
    if (!target && url) {
      const want = (entry.split('/sportsbook/')[1] || '').split(/[?#]/)[0];
      target = seen.find(h => h.includes(want)) || null;
    } else if (!target && round != null) {
      const cands = seen.filter(h => parseRound(h) === round);
      // More than one tournament could be running (PGA + Champions/Euro). Refuse
      // to guess — quoting one tournament's board against another's pairings
      // would fail the both-players lookup anyway, but silently and late.
      if (cands.length === 1) target = cands[0];
      else if (cands.length > 1) {
        throw new Error(`round ${round} matched ${cands.length} tournaments (${cands.join(', ')}) — set BETONLINE_GOLF_URL to disambiguate`);
      }
    }
    if (!target) {
      throw new Error(`no BetOnline link found for round ${round == null ? '(unspecified)' : round}` +
        (seen.length ? ` — saw: ${seen.slice(0, 6).join(', ')}` : ' — the golf section rendered no round links at all'));
    }

    // The deep link does NOT hydrate — the SPA must route via its own nav link.
    const clicked = await page.evaluate((h) => {
      const a = [...document.querySelectorAll('a')].find(x => (x.getAttribute('href') || '') === h);
      if (a) { a.click(); return true; }
      return false;
    }, target);
    if (!clicked) throw new Error(`found link ${target} but could not click it`);
    resolvedUrl = target.startsWith('http') ? target : `https://www.betonline.ag${target}`;
    resolvedRound = parseRound(target);
    await new Promise(r => setTimeout(r, 12000));
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await new Promise(r => setTimeout(r, 1000));
    }

    const raw = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/game/"]')) {
        const t = (a.innerText || '').trim();
        if (!/\d{3,5}\s*-/.test(t)) continue;
        out.push(t);
      }
      return out;
    });
    const rows = raw.map(parseRow).filter(Boolean);
    return { rows, rawCount: raw.length, resolvedUrl, resolvedRound };
  } finally {
    try { await browser.close(); } catch (_) { /* best effort */ }
  }
}

/**
 * Fetch (and cache) the board. Background use only — ~40s.
 * Throws on an empty parse: "loaded but no matchups" is indistinguishable from
 * the two silent-failure modes above, so it must never be cached as a miss.
 */
async function fetchBoard({ force = false, round = null } = {}) {
  const cfg = config.betonlineGolf || {};
  const url = cfg.url || null;   // optional now — absent means DISCOVER the round link
  const ttlMs = (cfg.ttlMinutes || 10) * 60000;
  // A board for a DIFFERENT round is not merely stale, it is wrong: pairings
  // are re-drawn every round, so it must be refetched even inside the TTL.
  // An operator paste OUTRANKS the scrape while it is fresh — it is the board
  // whose pairings actually match PX's. Its own max-age knob is deliberately
  // longer than the scrape TTL: the operator pastes intentionally and stops via
  // the kill switch, so we must not force a re-paste on a scrape cadence.
  if (_board && _board.source === 'paste') {
    const pasteMaxMs = (cfg.pasteMaxAgeMinutes || 720) * 60000;
    const sameRound = round == null || _board.round == null || _board.round === round;
    if (sameRound && Date.now() - _board.at < pasteMaxMs) return _board;
  }
  const roundMismatch = round != null && _board && _board.round != null && _board.round !== round;
  if (!force && !roundMismatch && _board && Date.now() - _board.at < ttlMs) return _board;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    const started = Date.now();
    try {
      const { rows, rawCount, resolvedUrl, resolvedRound } = await _scrape({ round, url });
      if (!rows.length) {
        throw new Error(`board parsed 0 matchups from ${rawCount} candidate rows — treat as scrape failure, not an empty slate`);
      }
      const tie = impliedTieRate(rows);
      _board = { at: Date.now(), url: resolvedUrl || url, round: resolvedRound, rows };
      _lastError = null;
      _consecutiveFailures = 0;
      log.info('BoGolf', `Board: ${rows.length} matchups (round ${resolvedRound == null ? '?' : resolvedRound}) in ${((Date.now() - started) / 1000).toFixed(0)}s` +
        (tie != null ? ` · implied tie rate ${(100 * tie).toFixed(1)}%` : ''));
      // A tie rate far outside the measured 8-11% band means the two markets
      // are not what we think they are — surface it rather than quoting blind.
      if (tie != null && (tie < 0.04 || tie > 0.16)) {
        log.warn('BoGolf', `Implied tie rate ${(100 * tie).toFixed(1)}% is outside the measured 8-11% band — verify the board is really ±0.5 vs ties-void`);
      }
      return _board;
    } catch (err) {
      _consecutiveFailures++;
      _lastError = err.message;
      log.error('BoGolf', `Board fetch failed (${_consecutiveFailures} consecutive): ${err.message}`);
      return null;                      // keep any previous board; age gates it
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * SYNC hot-path read. Returns the ±0.5 fair for `player` against `opponent`,
 * or null. FAILS CLOSED on a cold, stale, unknown or ambiguous board.
 * Scoped to the ONE matchup containing both names, so a shared surname cannot
 * pull the wrong row (the failure that stamped one Magomedov's prices onto the
 * other on the MoV board).
 */
function getSpreadFairSync(player, opponent, round) {
  if (!_board || !player || !opponent) return null;
  const cfg = config.betonlineGolf || {};
  const maxAgeMs = (cfg.maxAgeMinutes || 45) * 60000;
  if (Date.now() - _board.at > maxAgeMs) return null;    // stale → decline
  // ROUND MUST MATCH. Pairings are re-drawn every round, so an R3 board against
  // an R2 leg is not "slightly stale" — it is a different tournament draw. The
  // both-players lookup below would usually miss anyway, but usually is not a
  // guarantee: a pairing CAN repeat across rounds, and then we would quote
  // yesterday's price on today's market. Fail closed instead.
  if (round != null && _board.round != null && _board.round !== round) return null;

  const p = normName(player), o = normName(opponent);
  const matches = _board.rows.filter(r => {
    const [a, b] = r.players.map(normName);
    return (a === p && b === o) || (a === o && b === p);
  });
  if (matches.length !== 1) return null;                 // 0 = unknown, >1 = ambiguous
  const row = matches[0];
  const side = row.spread.find(s => normName(s.player) === p);
  if (!side || !(side.fair > 0) || !(side.fair < 1)) return null;
  return {
    fairProb: side.fair,
    rawImplied: side.raw,
    americanOdds: side.american,
    handicap: side.handicap,
    opponent: row.players.find(n => normName(n) !== p) || null,
    boardAgeMs: Date.now() - _board.at,
    source: 'betonline_spread_0.5',
  };
}

function getStatus() {
  const cfg = config.betonlineGolf || {};
  return {
    enabled: !!cfg.enabled,
    url: cfg.url || null,
    loaded: !!_board,
    matchups: _board ? _board.rows.length : 0,
    ageMinutes: _board ? +((Date.now() - _board.at) / 60000).toFixed(1) : null,
    maxAgeMinutes: cfg.maxAgeMinutes || 45,
    round: _board ? _board.round : null,
    source: _board ? (_board.source || 'scrape') : null,
    resolvedUrl: _board ? _board.url : null,
    priceable: !!(_board && Date.now() - _board.at <= (cfg.maxAgeMinutes || 45) * 60000),
    impliedTieRate: _board ? impliedTieRate(_board.rows) : null,
    lastError: _lastError,
    consecutiveFailures: _consecutiveFailures,
    rows: _board ? _board.rows.map(r => ({
      players: r.players,
      spread: r.spread.map(s => `${s.player} ${s.handicap} ${s.american > 0 ? '+' : ''}${s.american} (fair ${(100 * s.fair).toFixed(1)}%)`),
      holdPct: +r.holdPct.toFixed(2),
    })) : [],
  };
}

module.exports = {
  fetchBoard,
  parsePasteText,
  loadPaste,
  getSpreadFairSync,
  getStatus,
  // test seams
  parseRow,
  impliedTieRate,
  normName,
  // Inject a board so the sync hot-path read (staleness, ambiguity, unknown
  // player) is testable without a 40s scrape. Test-only.
  _setBoardForTest: (rows, at) => { _board = rows ? { at: at || Date.now(), url: 'test', rows } : null; },
};
