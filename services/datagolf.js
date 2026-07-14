// DataGolf API integration — fetches head-to-head matchup odds from DataGolf's
// betting-tools endpoint. Provides golf matchup coverage for PX parlay quoting.
//
// API key: DATAGOLF_API_KEY env var
// Endpoint: https://feeds.datagolf.com/betting-tools/matchups
// Markets: round_matchups (2-way), tournament_matchups (2-way), 3_balls (3-way)
//
// Data is parsed into odds cache entries under sport key 'golf_matchups', where
// each matchup is a pseudo-event with homeTeam/awayTeam being the two players.

const fetch = require('node-fetch');
const { config } = require('../config');
const log = require('./logger');

// Books to use for de-vig consensus. Excludes 'datagolf' which is their model
// prediction (not a tradeable market quote).
// Pinnacle added — consistently the sharpest book in DataGolf's feed for
// golf matchups and was being silently excluded from the consensus. Its
// inclusion pulls fair values closer to true market consensus.
const CONSENSUS_BOOKS = ['bet365', 'betmgm', 'betonline', 'bovada', 'caesars', 'draftkings', 'fanduel', 'unibet', 'betcris', 'pinnacle'];
const TOURS = ['pga', 'euro', 'alt']; // alt includes LIV

function americanToImpliedProb(odds) {
  if (odds == null) return null;
  const o = Number(odds);
  if (isNaN(o)) return null;
  if (o > 0) return 100 / (o + 100);
  return Math.abs(o) / (Math.abs(o) + 100);
}

function deVig2Way(p1, p2) {
  const total = p1 + p2;
  if (total === 0) return [0.5, 0.5];
  return [p1 / total, p2 / total];
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * DataGolf occasionally returns MULTIPLE match_list entries for the same
 * pairing (different internal source rollups). If we process them
 * independently, one may end up with only a single soft book (e.g.
 * bet365 alone) while another holds the full 7-book spread — and our
 * lookup returns the first entry for a given pair, which can be the
 * thin one. Real-world miss: Scheffler vs Fitzpatrick R4 showed two
 * DG entries, first had bet365-only at Scheffler -138, second had 7
 * books averaging Scheffler ≈ -170. We were quoting off the bet365
 * number (FV -145, ~25 cents softer than market).
 *
 * Fix: merge all match_list entries that refer to the same pairing
 * (by normalized player pair, regardless of p1/p2 ordering) into a
 * single entry whose `odds` map contains every book from every
 * contributing entry. First-seen wins per book so later soft entries
 * can't overwrite a sharper one.
 */
function mergeDuplicatePairings(matchList) {
  if (!Array.isArray(matchList)) return [];
  const merged = new Map(); // canonical-pair-key → merged entry
  for (const entry of matchList) {
    const p1n = normalizeDgPlayerName(entry.p1_player_name);
    const p2n = normalizeDgPlayerName(entry.p2_player_name);
    if (!p1n || !p2n) continue;
    // Canonical key: alphabetically ordered player pair, case-insensitive.
    const [a, b] = [p1n, p2n].map(s => s.toLowerCase()).sort();
    const key = a + '|' + b;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        p1_player_name: entry.p1_player_name,
        p2_player_name: entry.p2_player_name,
        ties: entry.ties,
        odds: { ...(entry.odds || {}) },
      });
      continue;
    }
    // Another entry for the same pairing — merge its odds in. If the
    // new entry has the players in opposite p1/p2 order, swap before
    // merging so p1/p2 remain consistent with the canonical entry.
    const existingP1Norm = normalizeDgPlayerName(existing.p1_player_name).toLowerCase();
    const thisP1Norm = p1n.toLowerCase();
    const swapped = thisP1Norm !== existingP1Norm;
    for (const [book, o] of Object.entries(entry.odds || {})) {
      if (!o || typeof o !== 'object') continue;
      if (existing.odds[book]) continue; // first-seen wins
      existing.odds[book] = swapped ? { p1: o.p2, p2: o.p1 } : { p1: o.p1, p2: o.p2 };
    }
  }
  return Array.from(merged.values());
}

/**
 * Normalize a DataGolf player name: "Im, Sungjae" → "Sungjae Im".
 * Handles edge cases: suffixes (Jr., III), hyphens, accents, single names.
 */
function normalizeDgPlayerName(name) {
  if (!name) return '';
  const s = name.trim();
  if (!s.includes(',')) return s; // already "Firstname Lastname"
  const parts = s.split(',').map(p => p.trim());
  if (parts.length === 2) {
    return parts[1] + ' ' + parts[0]; // "Firstname Lastname"
  }
  // Handle "Lastname, Firstname, Jr." or similar
  return parts.slice(1).join(' ') + ' ' + parts[0];
}

/**
 * Fetch matchups for a specific tour and market type from DataGolf.
 */
async function fetchDgMatchups(tour, market) {
  const apiKey = config.dataGolf.apiKey;
  if (!apiKey) {
    log.warn('DataGolf', 'DATAGOLF_API_KEY not set — skipping fetch');
    return null;
  }
  const url = `${config.dataGolf.baseUrl}/betting-tools/matchups`
    + `?tour=${tour}`
    + `&market=${market}`
    + `&odds_format=american`
    + `&file_format=json`
    + `&key=${apiKey}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn('DataGolf', `Fetch failed (${resp.status}) for ${tour}/${market}`);
      return null;
    }
    const data = await resp.json();
    if (!data || typeof data.match_list === 'string') {
      // DataGolf returns a string message when no matchups are offered
      log.debug('DataGolf', `${tour}/${market}: ${data && data.match_list}`);
      return null;
    }
    return data; // { event_name, last_updated, market, match_list, round_num }
  } catch (err) {
    log.warn('DataGolf', `Fetch error for ${tour}/${market}: ${err.message}`);
    return null;
  }
}

/**
 * Parse a single 2-way matchup into our cache event format.
 * Returns { homeTeam, awayTeam, eventName, roundNum, markets: { h2h: {home, away, books} } }
 * or null if not enough book data.
 *
 * Per-side `byBook` map carries each book's raw American odds — the
 * pricer reads this to quote AT a specific book's posted line
 * (BetOnline preferred, Bovada fallback) instead of de-vigged consensus.
 * Operator decision 2026-05-19: golf matchup spreads off de-vigged
 * consensus end up narrower than any tradeable book; quote at the
 * book's raw posted price to widen the offered spread.
 */
function parseMatchup(entry, eventName, roundNum) {
  const p1Name = normalizeDgPlayerName(entry.p1_player_name);
  const p2Name = normalizeDgPlayerName(entry.p2_player_name);
  if (!p1Name || !p2Name) return null;

  // Collect book pairs (excluding datagolf's own model)
  const p1Probs = [], p2Probs = [];
  const p1Raw = [], p2Raw = [];
  // Per-book raw American odds, indexed by book name. Preserved
  // alongside the de-vigged consensus so the pricer can quote at a
  // specific book's posted line on demand.
  const p1ByBook = {}, p2ByBook = {};
  for (const [book, odds] of Object.entries(entry.odds || {})) {
    if (!CONSENSUS_BOOKS.includes(book)) continue;
    const p1Prob = americanToImpliedProb(odds.p1);
    const p2Prob = americanToImpliedProb(odds.p2);
    if (p1Prob == null || p2Prob == null) continue;
    // ties: void — de-vig as 2-way
    const [fp1, fp2] = deVig2Way(p1Prob, p2Prob);
    p1Probs.push(fp1);
    p2Probs.push(fp2);
    p1Raw.push(Number(odds.p1));
    p2Raw.push(Number(odds.p2));
    p1ByBook[book] = Number(odds.p1);
    p2ByBook[book] = Number(odds.p2);
  }
  if (p1Probs.length === 0) return null; // no tradeable book data

  // Fair probability = de-vigged consensus across sportsbooks only.
  // DataGolf's model predictions are NOT used for pricing — only real
  // tradeable book odds feed into the consensus.
  const dvP1 = avg(p1Probs);
  const dvP2 = avg(p2Probs);

  return {
    homeTeam: p2Name, // p2 → home (consistent arbitrary choice)
    awayTeam: p1Name, // p1 → away
    eventName,
    roundNum,
    p1Name,
    p2Name,
    markets: {
      h2h: {
        home: {
          rawOdds: p2Raw[0] || null,
          impliedProb: avg(p2Raw.map(americanToImpliedProb)),
          fairProb: dvP2,
          displayFairProb: dvP2,
          byBook: p2ByBook, // p2 → home
        },
        away: {
          rawOdds: p1Raw[0] || null,
          impliedProb: avg(p1Raw.map(americanToImpliedProb)),
          fairProb: dvP1,
          displayFairProb: dvP1,
          byBook: p1ByBook, // p1 → away
        },
        books: p1Probs.length,
      },
    },
  };
}

/**
 * Main entry point: fetch golf matchups from DataGolf and build a cache object
 * compatible with our odds cache format.
 * Returns { events: { [normalizedKey]: [matchupEvent] }, fetchedAt }
 */
async function fetchGolfMatchupsCache() {
  const apiKey = config.dataGolf.apiKey;
  if (!apiKey) return { events: {}, fetchedAt: Date.now() };

  const normalizeTeamName = (n) => (n || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const normalizeEventKey = (h, a) => `${normalizeTeamName(h)}|${normalizeTeamName(a)}`;

  const parsed = {};
  let totalMatchups = 0;

  for (const tour of TOURS) {
    // Fetch round_matchups (active tournament rounds)
    const roundData = await fetchDgMatchups(tour, 'round_matchups');
    if (roundData && Array.isArray(roundData.match_list)) {
      const eventName = roundData.event_name || '';
      const roundNum = roundData.round_num || null;
      const mergedRound = mergeDuplicatePairings(roundData.match_list);
      for (const entry of mergedRound) {
        const matchup = parseMatchup(entry, eventName, roundNum);
        if (!matchup) continue;

        // Store in BOTH orderings so order-insensitive lookups work
        const keyAB = normalizeEventKey(matchup.homeTeam, matchup.awayTeam);
        const keyBA = normalizeEventKey(matchup.awayTeam, matchup.homeTeam);

        // Primary entry (p2 as home, p1 as away)
        if (!parsed[keyAB]) parsed[keyAB] = [];
        parsed[keyAB].push({
          homeTeam: matchup.homeTeam,
          awayTeam: matchup.awayTeam,
          commenceTime: null,
          eventName: matchup.eventName,
          roundNum: matchup.roundNum,
          matchupType: 'round',
          markets: matchup.markets,
        });

        // Mirror entry (p1 as home, p2 as away) — swap home/away in h2h
        if (!parsed[keyBA]) parsed[keyBA] = [];
        parsed[keyBA].push({
          homeTeam: matchup.awayTeam,
          awayTeam: matchup.homeTeam,
          commenceTime: null,
          eventName: matchup.eventName,
          roundNum: matchup.roundNum,
          matchupType: 'round',
          markets: {
            h2h: {
              home: matchup.markets.h2h.away, // swapped
              away: matchup.markets.h2h.home, // swapped
              books: matchup.markets.h2h.books,
            },
          },
        });

        totalMatchups++;
      }
    }

    // Fetch tournament_matchups (if active)
    const tournData = await fetchDgMatchups(tour, 'tournament_matchups');
    if (tournData && Array.isArray(tournData.match_list)) {
      const eventName = tournData.event_name || '';
      const mergedTourn = mergeDuplicatePairings(tournData.match_list);
      for (const entry of mergedTourn) {
        const matchup = parseMatchup(entry, eventName, null);
        if (!matchup) continue;
        const keyAB = normalizeEventKey(matchup.homeTeam, matchup.awayTeam);
        const keyBA = normalizeEventKey(matchup.awayTeam, matchup.homeTeam);
        if (!parsed[keyAB]) parsed[keyAB] = [];
        parsed[keyAB].push({
          homeTeam: matchup.homeTeam,
          awayTeam: matchup.awayTeam,
          commenceTime: null,
          eventName: matchup.eventName,
          roundNum: null,
          matchupType: 'tournament',
          markets: matchup.markets,
        });
        if (!parsed[keyBA]) parsed[keyBA] = [];
        parsed[keyBA].push({
          homeTeam: matchup.awayTeam,
          awayTeam: matchup.homeTeam,
          commenceTime: null,
          eventName: matchup.eventName,
          roundNum: null,
          matchupType: 'tournament',
          markets: {
            h2h: {
              home: matchup.markets.h2h.away,
              away: matchup.markets.h2h.home,
              books: matchup.markets.h2h.books,
            },
          },
        });
        totalMatchups++;
      }
    }
  }

  log.info('DataGolf', `Fetched ${totalMatchups} matchups across ${TOURS.length} tours (${Object.keys(parsed).length} cache keys incl mirrors)`);
  return { events: parsed, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// LIVE IN-PLAY PROBABILITIES
//
// DataGolf's /preds/in-play returns per-player live tournament probabilities
// (win, top-5, top-10, etc) computed from current scores + course context +
// remaining holes. For matchup legs that are mid-round, the head-to-head
// live probability isn't directly published, but we can derive a reasonable
// estimate from per-player live scores using a simple stroke-difference
// heuristic that's good enough for win-prob/risk-sim purposes. ESPN doesn't
// compute golf WP at all, so this is the best signal we have for golf
// matchups during live tournament play.
//
// Cached in memory; refreshed on demand by refreshLiveOdds (called every
// 60s server-side). Returns sync from cache after that.
// ---------------------------------------------------------------------------

let _liveStatsCache = null; // { fetchedAt, players: { [normalized name]: { score, holesPlayed, winProb, top5, top10 } } }
const LIVE_STATS_TTL_MS = 60 * 1000;

async function _fetchDgLiveStats(tour) {
  const apiKey = config.dataGolf.apiKey;
  if (!apiKey) return null;
  const url = `${config.dataGolf.baseUrl}/preds/in-play`
    + `?tour=${tour}&dead_heat=no&odds_format=percent&file_format=json&key=${apiKey}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !Array.isArray(data.data)) return null;
    return data.data; // [{ player_name, current_pos, current_score, thru, win, top_5, top_10, ... }]
  } catch (err) {
    log.debug('DataGolf', `Live stats fetch error (${tour}): ${err.message}`);
    return null;
  }
}

function _normalizePlayerKey(name) {
  return normalizeDgPlayerName(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Refresh DataGolf live in-play stats. Aggregates pga + euro + alt tours so
 * any player on any active tour is in the cache. Called by order-tracker's
 * refreshLiveOdds when a golf matchup leg is in-progress.
 */
async function refreshLiveStats() {
  if (!config.dataGolf.apiKey) return null;
  if (_liveStatsCache && Date.now() - _liveStatsCache.fetchedAt < LIVE_STATS_TTL_MS) {
    return _liveStatsCache;
  }
  const tours = ['pga', 'euro', 'alt'];
  const merged = {};
  for (const tour of tours) {
    const rows = await _fetchDgLiveStats(tour);
    if (!rows) continue;
    for (const r of rows) {
      const key = _normalizePlayerKey(r.player_name || '');
      if (!key) continue;
      // First-tour-seen wins; same player rarely appears on two tours
      // simultaneously but if so, pga > euro > alt by iteration order.
      if (merged[key]) continue;
      merged[key] = {
        playerName: r.player_name,
        currentPos: r.current_pos != null ? String(r.current_pos) : null,
        currentScore: r.current_score != null ? Number(r.current_score) : null,
        thru: r.thru != null ? Number(r.thru) : null, // holes played this round
        winProb: typeof r.win === 'number' ? r.win / 100 : null, // DataGolf returns percent
        top5Prob: typeof r.top_5 === 'number' ? r.top_5 / 100 : null,
        top10Prob: typeof r.top_10 === 'number' ? r.top_10 / 100 : null,
        tour,
      };
    }
  }
  if (Object.keys(merged).length === 0) {
    log.debug('DataGolf', 'Live in-play returned no players (no tournaments active)');
  } else {
    log.debug('DataGolf', `Cached live in-play for ${Object.keys(merged).length} players across ${tours.length} tours`);
  }
  _liveStatsCache = { fetchedAt: Date.now(), players: merged };
  return _liveStatsCache;
}

/**
 * Compute live head-to-head probability for a golf matchup leg (Player A
 * vs Player B). Returns the probability that the named `forPlayer` finishes
 * ahead in the current matchup context.
 *
 * Method:
 *   1. If matchupType === 'tournament': use DataGolf's per-player win prob
 *      and renormalize 2-way: P(A) = winA / (winA + winB). This is the
 *      conditional probability that A finishes higher than B given that
 *      one of them wins, but works as a reasonable proxy for tournament-
 *      length matchups where the matchup resolves to "best total score
 *      across the field" semantics.
 *   2. If matchupType === 'round' (single-round H2H): derive from current
 *      scores + holes remaining via a simple stroke-difference heuristic.
 *      DataGolf doesn't publish per-round H2H probs in the in-play feed.
 *      Score-difference model: each remaining hole has stddev ~ 0.5 strokes
 *      (per-pair, since both players play the same course). P(A wins) =
 *      Phi(diff_in_strokes / sqrt(holes_remaining * 0.5)).
 *
 * Returns null when:
 *   - either player isn't in the live cache (not on tour, hasn't teed off)
 *   - both players are completed (round done, no probability needed)
 *
 * Caller can fall back to pre-game fairProb when null.
 */
function getGolfLiveMatchupProb(playerA, playerB, forPlayer, matchupType) {
  const cache = _liveStatsCache;
  if (!cache || !cache.players) return null;
  const a = cache.players[_normalizePlayerKey(playerA)];
  const b = cache.players[_normalizePlayerKey(playerB)];
  if (!a || !b) return null;

  // Tournament matchup: renormalize win probs to 2-way.
  if (matchupType === 'tournament') {
    if (a.winProb == null || b.winProb == null) return null;
    const sum = a.winProb + b.winProb;
    if (sum <= 0) return null;
    const probA = a.winProb / sum;
    const target = _normalizePlayerKey(forPlayer);
    return target === _normalizePlayerKey(playerA) ? probA : (1 - probA);
  }

  // Round matchup: stroke-diff heuristic. A's lead = (B's score) - (A's score)
  // (lower scores are better in golf). Positive lead → A is ahead.
  if (a.currentScore == null || b.currentScore == null) return null;
  const lead = (b.currentScore || 0) - (a.currentScore || 0); // strokes A is ahead
  // Use the deeper-into-round player's `thru` to estimate remaining holes.
  // If neither has teed off (thru=0 for both), probability is 50/50 — bail
  // and let caller fall back to pre-game.
  const maxThru = Math.max(a.thru || 0, b.thru || 0);
  if (maxThru <= 0) return null;
  const remaining = Math.max(0, 18 - maxThru);
  if (remaining === 0) {
    // Round complete — outcome should be known via score, but matchup may
    // also turn on tiebreakers (extra holes / "ties are void"). Treat as
    // strong signal: A wins iff ahead, ties resolve to 0.5.
    const prob = lead > 0 ? 0.99 : lead < 0 ? 0.01 : 0.5;
    const target = _normalizePlayerKey(forPlayer);
    return target === _normalizePlayerKey(playerA) ? prob : (1 - prob);
  }
  // Approximate normal CDF: P(A wins) ≈ Phi(lead / sigma) where sigma scales
  // with sqrt(remaining holes). 0.5 stroke per remaining hole is a
  // reasonable proxy for pair-wise score variance based on PGA round-vs-round
  // standard deviations after factoring out shared course conditions.
  const sigma = Math.sqrt(remaining * 0.5);
  // Inline normal CDF approximation (Abramowitz & Stegun 7.1.26)
  function phi(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804 * Math.exp(-x * x / 2);
    let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  }
  const probA = phi(lead / sigma);
  // Clamp to (0.01, 0.99) so a single bad hole doesn't price a leg at 0%.
  const clampedA = Math.max(0.01, Math.min(0.99, probA));
  const target = _normalizePlayerKey(forPlayer);
  return target === _normalizePlayerKey(playerA) ? clampedA : (1 - clampedA);
}

function __debugLiveStats() {
  return _liveStatsCache;
}

// ---------------------------------------------------------------------------
// MAKE-THE-CUT OUTRIGHTS
//
// DataGolf's /betting-tools/outrights carries the cut market as TWO SEPARATE
// one-sided feeds that are actually the two halves of one 2-way market:
//   market=make_cut → the player MAKES the cut  (YES)
//   market=mc       → the player MISSES the cut (NO)
// Verified 2026-07-14 on The Open: every player's two sides sum to 105-109%
// implied (a normal 2-way overround), e.g. Scheffler make -769 (88.5%) / miss
// +500 (16.7%), and Keith Mitchell is -120 on BOTH sides. Do NOT assume `mc`
// is an alias of `make_cut` — quoting it as the make side inverts the market.
//
// Why DataGolf is valid here when golf-outrights.js says "DK, not DataGolf":
// that rule exists because DataGolf's outrights settle DEAD-HEAT while PX
// settles TIES INCLUDED (PX literally names those events "Top 5 Finish (Ties
// Included)"). Make-the-cut is BINARY — you play the weekend or you don't —
// so no dead-heat adjustment exists and the two are directly comparable. PX's
// cut event carries no ties qualifier ("2026 The Open - To Make The Cut").
//
// De-vig: POWER (odds-ratio), not proportional. Cut boards are dominated by
// heavy favorites, and proportional de-vig has a severe favorite-longshot bias
// because books load nearly all the overround onto the cheap miss side.
// Measured 2026-07-14 vs DataGolf's own (well-calibrated: field sums to 76.7 ≈
// "top 70 and ties") model baseline, n=65 players with >=4 two-sided books:
//   proportional : favs -4.15pp | coinflip -0.81pp | ALL -3.03pp
//   power        : favs -0.83pp | coinflip -0.35pp | ALL -1.54pp   <-- used
//   shin         : favs -2.12pp | coinflip -0.51pp | ALL -2.09pp
// Proportional underrated Scheffler at 84.2% when both DataGolf's model (88.8%)
// and PX's own near-zero-vig book (~89.2%) said ~89. Power gets 87.8%.
//
// Book coverage is thin and NOT what you'd expect (measured on The Open, /156):
//   pointsbet 155, draftkings 154  — make side ONLY, no miss side → unusable
//                                    for 2-way de-vig
//   bet365 115 | betway 99 | unibet 87 | williamhill 68 | betmgm 50 |
//   fanduel 46 | skybet 46 | betonline 41
//   pinnacle 1 (listed in books_offering but effectively absent) | bovada 0
// So Pinnacle/Bovada are NOT usable sources for this market despite being the
// sharpest elsewhere; bet365/betway/unibet carry it.
// ---------------------------------------------------------------------------

// Books quoted on BOTH sides (make + miss) — the only ones we can 2-way de-vig.
// 'datagolf' is deliberately absent: it's their model, not a tradeable quote.
const MAKE_CUT_BOOKS = ['pinnacle', 'betonline', 'bet365', 'betmgm', 'betway', 'fanduel', 'skybet', 'williamhill', 'unibet'];
const MAKE_CUT_TOURS = ['pga', 'euro', 'alt'];
const MAKE_CUT_TTL_MS = 5 * 60 * 1000;

let _makeCutCache = null; // { fetchedAt, boards: [{ tour, eventName, lastUpdated, players: [...] }] }

/**
 * Power (odds-ratio) 2-way de-vig. Solves for k such that
 *   pMake^k + pMiss^k = 1
 * and returns the fair pMake. k > 1 shrinks both sides but shrinks the
 * LONGSHOT proportionally harder, which is what removes the favorite-longshot
 * bias that plain proportional de-vig (p / (p+q)) suffers from.
 *
 * Returns null on degenerate input.
 */
function deVig2WayPower(pMake, pMiss) {
  if (!(pMake > 0 && pMake < 1) || !(pMiss > 0 && pMiss < 1)) return null;
  const f = (k) => Math.pow(pMake, k) + Math.pow(pMiss, k) - 1;
  // Overround (sum>1) ⇒ k>1; underround (sum<1) ⇒ k<1. Bracket generously.
  let lo = 0.2, hi = 8;
  if (f(lo) * f(hi) > 0) return pMake / (pMake + pMiss); // no root — fall back to proportional
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (f(k) > 0) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const a = Math.pow(pMake, k), b = Math.pow(pMiss, k);
  if (!(a + b > 0)) return null;
  return a / (a + b);
}

async function _fetchDgOutrights(tour, market) {
  const apiKey = config.dataGolf.apiKey;
  if (!apiKey) return null;
  const url = `${config.dataGolf.baseUrl}/betting-tools/outrights`
    + `?tour=${tour}&market=${market}&odds_format=american&file_format=json&key=${apiKey}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn('DataGolf', `Outrights fetch failed (${resp.status}) for ${tour}/${market}`);
      return null;
    }
    const data = await resp.json();
    // DataGolf returns a STRING in `odds` when the market isn't offered
    // ("No make_cut bets being offered right now.") — e.g. LIV has no cut.
    if (!data || !Array.isArray(data.odds)) return null;
    return data;
  } catch (err) {
    log.warn('DataGolf', `Outrights fetch error ${tour}/${market}: ${err.message}`);
    return null;
  }
}

/**
 * Build the make-the-cut board for one tour. Joins the make_cut (YES) and
 * mc (MISS) feeds by dg_id, power-de-vigs each book that quotes BOTH sides,
 * and averages to a consensus fair p(make).
 *
 * Returns { tour, eventName, lastUpdated, players: [{ playerName, dgId,
 *   fairProb, books, bookCount, modelProb }] } or null.
 * `modelProb` is DataGolf's own baseline — carried for DIAGNOSTICS ONLY
 * (drift/sanity vs consensus); it never feeds the quoted price.
 */
async function fetchMakeCutBoard(tour) {
  const [makeData, missData] = await Promise.all([
    _fetchDgOutrights(tour, 'make_cut'),
    _fetchDgOutrights(tour, 'mc'),
  ]);
  if (!makeData || !missData) return null;
  const missById = new Map(missData.odds.map(p => [p.dg_id, p]));
  const players = [];
  for (const mk of makeData.odds) {
    const ms = missById.get(mk.dg_id);
    if (!ms) continue;
    const fairs = [];
    const books = {};
    for (const bk of MAKE_CUT_BOOKS) {
      const pMake = americanToImpliedProb(mk[bk]);
      const pMiss = americanToImpliedProb(ms[bk]);
      if (pMake == null || pMiss == null) continue;
      const fair = deVig2WayPower(pMake, pMiss);
      if (fair == null) continue;
      fairs.push(fair);
      books[bk] = { make: Number(mk[bk]), miss: Number(ms[bk]), fair };
    }
    if (!fairs.length) continue;
    players.push({
      playerName: normalizeDgPlayerName(mk.player_name),
      dgId: mk.dg_id,
      fairProb: avg(fairs),
      bookCount: fairs.length,
      books,
      modelProb: (mk.datagolf && mk.datagolf.baseline != null)
        ? americanToImpliedProb(mk.datagolf.baseline) : null,
    });
  }
  if (!players.length) return null;
  return {
    tour,
    eventName: makeData.event_name || '',
    lastUpdated: makeData.last_updated || null,
    players,
  };
}

/**
 * Fetch make-cut boards across all tours, cached for MAKE_CUT_TTL_MS.
 * Tours with no cut market offered (LIV) are simply absent.
 */
async function fetchMakeCutBoards({ force = false } = {}) {
  if (!config.dataGolf.apiKey) return [];
  if (!force && _makeCutCache && Date.now() - _makeCutCache.fetchedAt < MAKE_CUT_TTL_MS) {
    return _makeCutCache.boards;
  }
  const boards = [];
  for (const tour of MAKE_CUT_TOURS) {
    const b = await fetchMakeCutBoard(tour);
    if (b) boards.push(b);
  }
  log.info('DataGolf', `Make-cut boards: ${boards.map(b => `${b.tour}="${b.eventName}" (${b.players.length}p)`).join(', ') || 'none offered'}`);
  _makeCutCache = { fetchedAt: Date.now(), boards };
  return boards;
}

/**
 * Find the make-cut board whose DataGolf event_name matches a tournament.
 * `hints` are free-text strings (dk_slug, tournament_name, PX event name).
 * Match = every >2-char word of ANY hint appears in the DG event name.
 */
async function findMakeCutBoard(hints, opts = {}) {
  const boards = await fetchMakeCutBoards(opts);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const hint of (Array.isArray(hints) ? hints : [hints]).filter(Boolean)) {
    const words = norm(hint).split(' ').filter(w => w.length > 2 && !/^\d{4}$/.test(w));
    if (!words.length) continue;
    for (const b of boards) {
      const en = norm(b.eventName);
      if (words.every(w => en.includes(w))) return b;
    }
  }
  return null;
}

module.exports = {
  fetchGolfMatchupsCache,
  normalizeDgPlayerName,
  refreshLiveStats,
  getGolfLiveMatchupProb,
  __debugLiveStats,
  // make-the-cut outrights
  deVig2WayPower,
  fetchMakeCutBoard,
  fetchMakeCutBoards,
  findMakeCutBoard,
};
