const { config, getBankroll } = require('../config');
const log = require('./logger');
const lineManager = require('./line-manager');
const oddsFeed = require('./odds-feed');
const orderTracker = require('./order-tracker');
const dkScraper = require('./dk-scraper');
const ufcMov = require('./ufc-mov');
// UFC method-of-victory market types. PX posts them typed 'moneyline'; the
// parser retags by market NAME (see prophetx.parseMarketSelections).
const MOV_MARKET_TYPES = new Set(['mov_ko', 'mov_sub', 'mov_dec', 'mov_itd']);
// Golf outright markets whose fair is the RAW DK "(Including Ties)" implied
// (operator paste / scrape, option B basis) — these get the thin mirror-cushion
// vig OVERRIDE. make_cut is deliberately excluded: its fair is de-vigged, so it
// keeps the wider vigGolfOutrightMin floor. See the two vig sites below.
const GOLF_RAW_DK_OUTRIGHT_MARKETS = new Set(['outright_win', 'outright_top_5', 'outright_top_10', 'outright_top_20']);
// Runtime kill-switch for golf outright parlay quoting (see shouldDecline).
let _golfOutrightsPaused = false;
function setGolfOutrightsPaused(v) { _golfOutrightsPaused = !!v; return _golfOutrightsPaused; }
function isGolfOutrightsPaused() { return _golfOutrightsPaused; }

/**
 * A book's implied probability for one leg, on the SAME PRODUCT we quote.
 *
 * PX soccer moneyline is 2-way DRAW-NO-BET; books post 3-way, where the draw
 * takes ~25-30% of the probability mass. Comparing our DNB quote against a raw
 * 3-way home price is a product mismatch, not a price difference — measured
 * 2026-08-03, it makes soccer moneyline legs look ~+10pp expensive
 * (median parlay gap soccer/moneyline +9.98pp vs -0.46..+2.63pp for every other
 * market family). Using the stored DNB-renormalised prob collapses that to
 * +1.61pp.
 *
 * `isDNB` ALONE IS NOT SUFFICIENT. It is only set when PX names the market
 * explicitly "2 Way" / "Draw No Bet"; plenty of events just say "Moneyline"
 * and the flag stays false while the product is still DNB. So any soccer h2h
 * leg is treated as DNB-equivalent whenever the renormalised prob exists.
 * (client/index.html compoundParlayOdds has carried this fuller rule for a
 * while — this brings the server in line with it.)
 *
 * Falls back to the raw price when no DNB prob is available, which is correct
 * for every non-soccer market.
 */
function bookImpliedForLeg(leg, oddsField, dnbField) {
  if (!leg) return null;
  const li = leg.lineInfo || leg;
  const isSoccerH2h = typeof li.sport === 'string' && li.sport.startsWith('soccer')
    && (li.marketType === 'moneyline' || li.oddsApiMarket === 'h2h');
  if ((li.isDNB || isSoccerH2h) && leg[dnbField] != null) return leg[dnbField];
  const raw = leg[oddsField];
  return raw == null ? null : oddsFeed.americanToImpliedProb(raw);
}
const pinImplied = (l) => bookImpliedForLeg(l, 'pinnacleOdds', 'pinnacleDNBProb');
const templateExposure = require('./template-exposure');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const v2 = require('./v2');

/**
 * Detect a series-winner leg and look up its fair probability from the
 * DK scraper cache. PX sends these as moneyline legs with team names
 * like "Cleveland Cavaliers (Series)" / "Edmonton Oilers (Series)",
 * which don't match any odds-feed h2h market. Returns null if the leg
 * isn't a series bet or the DK cache doesn't contain the team.
 */
// Decline whenever DK's series event startTime is in the past. That
// field is the NEXT game's tipoff — as long as it's still showing a
// past time, the most recent game has already started and DK hasn't
// relisted the series market yet. A fixed 6h cutoff would incorrectly
// re-enable us for marathon games (multiple OT, rain delays, etc.)
// where DK is NOT going to have relisted by then. The safe signal is
// simply "startTime is still in the past = DK has not moved on to the
// next game yet = we should not quote".

/**
 * Detect whether a leg is an "alt spread" on a sport that's currently
 * blocked. The block list comes from config.pricing.blockAltSpreadSports
 * (env BLOCK_ALT_SPREAD_SPORTS, default "baseball_mlb,icehockey_nhl,
 * basketball_nba"). Returns null if not blocked, or a human-readable
 * reason string if it should be declined.
 *
 * Detection rules per sport:
 *
 *   MLB / NHL — primary run/puck line is always ±1.5. Allow any leg
 *   with |line| === 1.5 (intentionally includes the OPPOSITE-symbol
 *   alt: if primary is Team A −1.5, also allow Team A +1.5 — the
 *   heavy-favorite alt where the same fav gets a head-start instead).
 *   Block any other magnitude (±0.5, ±2.5, etc.).
 *
 *   The opposite-symbol alts route through odds-feed's signed-key
 *   altSpreads cache (keyed by signed home-perspective home_point), so
 *   "Team A +1.5 (away)" lands in bucket "−1.5" and "Team A −1.5
 *   (away)" lands in bucket "+1.5" — strictly different buckets, no
 *   collision risk. See odds-feed.js getAltLineFairProb() and
 *   spreadHomePoint() for the routing.
 *
 *   NBA — primary spread varies per game. Allow legs whose line is
 *   within ±config.pricing.nbaAltSpreadMaxDistance points of the
 *   primary (in home-team perspective), AND which have coverage in
 *   our alt-lines cache (i.e., at least one book reported odds for
 *   this exact line). Block legs farther than the threshold OR with
 *   no book coverage (we'd have to derive odds ourselves — operator
 *   doesn't want that). Primary lines (onDemand=false) always pass.
 *
 *   Other blocked sports — fall back to the onDemand=true proxy
 *   (RFQ asked for a line we hadn't pre-registered → block).
 *
 * Why this exists: Apr 25 forensic showed alt-spread legs concentrated
 * in the low-fair-prob "red box" region where realized EV/$ was -6%;
 * one recurring 2-leg MLB template (Rockies +1.5 + Under) drove ~$5.8k
 * of loss alone. Block is sport-list driven so we can re-enable per
 * sport without a code change.
 */
function isBlockedAltSpread(lineInfo) {
  if (!lineInfo) return null;
  if (lineInfo.marketType !== 'spread') return null;
  const sport = lineInfo.sport || '';
  const blocked = config.pricing.blockAltSpreadSports || [];
  if (!blocked.includes(sport)) return null;
  // Spread legs with no line value are anomalous (probably won't price either).
  // Don't claim "alt" without an actual line to compare against — let the
  // downstream pricing path reject them on its own terms.
  if (lineInfo.line == null) return null;
  const lineNum = Number(lineInfo.line);
  if (!Number.isFinite(lineNum)) return null;
  const absLine = Math.abs(lineNum);
  // NHL: discrete allowlist of |line| values (default ±0.5, ±1.0, ±1.5
  // per Mike 2026-05-01). Mirrors MLB pattern — primary ±1.5 passes
  // without coverage check; non-primary alts require book coverage in
  // the alt-spread cache so we never derive a line ourselves.
  if (sport === 'icehockey_nhl') {
    const allowed = config.pricing.nhlAllowedPuckLines || [0.5, 1.0, 1.5];
    const isAllowed = allowed.some(v => Math.abs(absLine - v) < 0.001);
    if (!isAllowed) {
      return `NHL puck line ${absLine} not in allowed set [${allowed.join(', ')}]`;
    }
    // Primary ±1.5 — no coverage check needed
    if (Math.abs(absLine - 1.5) < 0.001) return null;
    // Non-primary alt — require book coverage
    const sel = lineInfo.oddsApiSelection || lineInfo.selection;
    if (lineInfo.homeTeam && lineInfo.awayTeam) {
      const eventKey = oddsFeed.normalizeEventKey(lineInfo.homeTeam, lineInfo.awayTeam);
      const cacheEntry = oddsFeed.getAltLineCacheEntry(eventKey, 'spreads', sel, lineNum);
      if (!cacheEntry || !cacheEntry.books || cacheEntry.books === 0) {
        return `NHL alt puck line: no book coverage for line ${absLine} (cache miss or 0 books)`;
      }
    } else {
      return `NHL alt puck line: missing team names, can't verify book coverage`;
    }
    return null;
  }
  // MLB: discrete allowlist of |line| values (default ±0.5 and ±1.5).
  // Each non-primary value also requires alt-spread cache book coverage —
  // mirrors the NBA carve-out's coverage gate so we never derive a line
  // ourselves. Primary ±1.5 passes without coverage check.
  if (sport === 'baseball_mlb') {
    const allowed = config.pricing.mlbAllowedRunLines || [0.5, 1.5];
    const isAllowed = allowed.some(v => Math.abs(absLine - v) < 0.001);
    if (!isAllowed) {
      return `MLB run line ${absLine} not in allowed set [${allowed.join(', ')}]`;
    }
    // Primary ±1.5 — no coverage check needed
    if (Math.abs(absLine - 1.5) < 0.001) return null;
    // Non-primary alt — require book coverage
    const sel = lineInfo.oddsApiSelection || lineInfo.selection;
    if (lineInfo.homeTeam && lineInfo.awayTeam) {
      const eventKey = oddsFeed.normalizeEventKey(lineInfo.homeTeam, lineInfo.awayTeam);
      const cacheEntry = oddsFeed.getAltLineCacheEntry(eventKey, 'spreads', sel, lineNum);
      if (!cacheEntry || !cacheEntry.books || cacheEntry.books === 0) {
        return `MLB alt run line: no book coverage for line ${absLine} (cache miss or 0 books)`;
      }
    } else {
      return `MLB alt run line: missing team names, can't verify book coverage`;
    }
    return null;
  }
  // NBA: within-±N alts with book coverage allowed.
  if (sport === 'basketball_nba') {
    // Find primary spread for this event in home-team perspective.
    const primaryHomePoint = lineManager.getPrimarySpreadHomePoint(lineInfo.pxEventId);
    if (primaryHomePoint == null) {
      return `NBA alt: no primary spread registered for event ${lineInfo.pxEventId}`;
    }
    // Convert this leg's line to home-team-signed perspective.
    const sel = lineInfo.oddsApiSelection || lineInfo.selection;
    const legHomePoint = sel === 'home' ? lineNum : -lineNum;
    // If THIS leg IS the primary line, allow without further checks.
    // Same fix class as isBlockedAltTotal (operator-caught Apr 26):
    // `onDemand !== true` was being used as a proxy for "is primary",
    // but PX seeds many alt-spreads as non-on-demand entries during
    // regular seeding — they bypassed the distance check. Use the
    // line-value match against primary as the actual truth signal.
    if (Math.abs(legHomePoint - primaryHomePoint) < 0.001) return null;
    const dist = Math.abs(legHomePoint - primaryHomePoint);
    const maxDist = config.pricing.nbaAltSpreadMaxDistance || 2.0;
    // Tiny floating-point tolerance (NBA spreads come in 0.5 increments
    // so values are exact, but be defensive).
    if (dist > maxDist + 0.001) {
      return `NBA alt outside ±${maxDist} of primary (alt=${legHomePoint}, primary=${primaryHomePoint}, dist=${dist})`;
    }
    // Verify book coverage: only allow alts that came from real books.
    // No derived/inferred lines. Cache miss OR books=0 → block.
    if (lineInfo.homeTeam && lineInfo.awayTeam) {
      const eventKey = oddsFeed.normalizeEventKey(lineInfo.homeTeam, lineInfo.awayTeam);
      const cacheEntry = oddsFeed.getAltLineCacheEntry(eventKey, 'spreads', sel, lineNum);
      if (!cacheEntry || !cacheEntry.books || cacheEntry.books === 0) {
        return `NBA alt: no book coverage for line ${legHomePoint} (cache miss or 0 books)`;
      }
    } else {
      // Without home/away team names we can't look up the cache —
      // conservatively block so we never derive an alt line ourselves.
      return `NBA alt: missing team names, can't verify book coverage`;
    }
    return null; // within range + has book coverage
  }
  // Other blocked sports: fall back to onDemand proxy.
  if (lineInfo.onDemand === true) {
    return `${sport} alt spread (virtually-registered line ${lineNum})`;
  }
  return null;
}

/**
 * Alt-totals carve-out check. Allows alt totals within a sport-specific
 * distance of the primary O/U line AND only if the line has real book
 * coverage in our alt-totals cache (no derived/inferred lines).
 *
 * Sports gated:
 *   - NBA: ±config.pricing.nbaAltTotalMaxDistance (default 2.0)
 *   - MLB: ±config.pricing.mlbAltTotalMaxDistance (default 1.5)
 * Other sports pass through unrestricted (subject to other rules).
 *
 * Returns null when the leg is allowed, or a human-readable reason
 * string when it should be declined.
 */
function isBlockedAltTotal(lineInfo) {
  if (!lineInfo) return null;
  if (lineInfo.marketType !== 'total') return null;
  const sport = lineInfo.sport || '';
  let maxDist;
  let label;
  if (sport === 'basketball_nba') {
    maxDist = config.pricing.nbaAltTotalMaxDistance || 2.0;
    label = 'NBA';
  } else if (sport === 'baseball_mlb') {
    maxDist = config.pricing.mlbAltTotalMaxDistance || 1.5;
    label = 'MLB';
  } else {
    return null;
  }
  // Need a line value to compare
  if (lineInfo.line == null) return null;
  const lineNum = Number(lineInfo.line);
  if (!Number.isFinite(lineNum)) return null;
  const absLine = Math.abs(lineNum);
  // Find primary total for this event
  const primaryTotal = lineManager.getPrimaryTotalLine(lineInfo.pxEventId);
  if (primaryTotal == null) {
    return `${label} alt-total: no primary total registered for event ${lineInfo.pxEventId}`;
  }
  // If THIS leg IS the primary line, allow without further checks.
  if (Math.abs(absLine - primaryTotal) < 0.001) return null;
  // Alt: must be within ±N of primary
  const dist = Math.abs(absLine - primaryTotal);
  if (dist > maxDist + 0.001) {
    return `${label} alt-total outside ±${maxDist} of primary (alt=${absLine}, primary=${primaryTotal}, dist=${dist})`;
  }
  // Verify book coverage exists in alt-totals cache (no derived lines)
  if (lineInfo.homeTeam && lineInfo.awayTeam) {
    const eventKey = oddsFeed.normalizeEventKey(lineInfo.homeTeam, lineInfo.awayTeam);
    const cacheEntry = oddsFeed.getAltLineCacheEntry(eventKey, 'totals', lineInfo.oddsApiSelection || lineInfo.selection, lineNum);
    if (!cacheEntry || !cacheEntry.books || cacheEntry.books === 0) {
      return `${label} alt-total: no book coverage for line ${absLine} (cache miss or 0 books)`;
    }
  } else {
    return `${label} alt-total: missing team names, can't verify book coverage`;
  }
  return null;
}

function getSeriesFairProb(lineInfo) {
  // Detect which series market this leg belongs to. marketType carries
  // the line-manager tag for winner/spread/total; oddsApiMarket is a
  // mirror. We also accept raw PX moneyline legs whose team name still
  // carries a "(Series)" suffix (legacy path for any that slipped
  // through the line-manager retag).
  const teamName = lineInfo?.teamName || '';
  const mt = lineInfo?.marketType;
  const am = lineInfo?.oddsApiMarket;
  const hasSeriesTeamSuffix = /\(series\)/i.test(teamName);
  const isSeriesWinner = mt === 'series_winner' || am === 'series_winner' || (hasSeriesTeamSuffix && (mt === 'moneyline' || !mt));
  const isSeriesSpread = mt === 'series_spread' || am === 'series_spread';
  const isSeriesTotal  = mt === 'series_total'  || am === 'series_total';
  if (!isSeriesWinner && !isSeriesSpread && !isSeriesTotal) return null;

  const sport = (lineInfo.oddsApiSport || lineInfo.sport || '').toLowerCase();
  const sportKey = sport.includes('nba') || sport.includes('basketball') ? 'nba'
                 : sport.includes('nhl') || sport.includes('icehockey') || sport.includes('hockey') ? 'nhl'
                 : null;
  if (!sportKey) return null;
  const bareTeam = teamName.replace(/\s*\(series\)\s*/ig, '').trim();

  let hit = null;
  if (isSeriesWinner) {
    hit = dkScraper.lookupSeriesFairProb(sportKey, bareTeam || teamName);
  } else if (isSeriesSpread) {
    // PX stores spread line as signed (negative for favorite side).
    // DK cache keys each team's leg by (team, |line|, '+'|'-').
    const rawLine = lineInfo.line;
    if (rawLine == null || !Number.isFinite(Number(rawLine))) return null;
    const absLine = Math.abs(Number(rawLine));
    const side = Number(rawLine) < 0 ? '-' : '+';
    hit = dkScraper.lookupSeriesSpreadFairProb(sportKey, bareTeam || teamName, absLine, side);
  } else if (isSeriesTotal) {
    const rawLine = lineInfo.line;
    if (rawLine == null || !Number.isFinite(Number(rawLine))) return null;
    const side = lineInfo.oddsApiSelection || lineInfo.selection;
    hit = dkScraper.lookupSeriesTotalFairProb(sportKey, lineInfo.homeTeam, lineInfo.awayTeam, Number(rawLine), side);
  }
  if (!hit) return null;

  // In-play / cooldown guard: decline if the next game in this series
  // has already started and is still within the cooldown window. Our
  // cached DK odds are pre-game and would give a bettor material edge
  // if the in-game team took an early lead. Once DK's scraper refresh
  // moves startTime forward (post-game to next game), we resume.
  if (hit.startTime) {
    const t = new Date(hit.startTime).getTime();
    if (Number.isFinite(t) && t <= Date.now()) {
      log.debug('Pricing', `Series in-play decline: ${teamName} ${mt || ''} (startTime ${hit.startTime}, ${Math.round((Date.now()-t)/60000)}min ago — DK has not relisted for next game)`);
      return null;
    }
  }

  // NBA series heavy-favorite: beyond the config'd FV cap (default -250),
  // quote DK's offered price directly (no vig) instead of our
  // de-vigged-plus-vig number. Avoids drifting out of market on extreme
  // favorites where our ramp would produce an uncompetitive line.
  // Applies ONLY to series_winner (the "moneyline" of series betting).
  // Series spread and series total pass through normally — those lines
  // are calibrated to ~50/50 and the fav-cap concept doesn't apply.
  if (sportKey === 'nba' && isSeriesWinner) {
    // Convert config'd American odds cap → implied probability threshold.
    // Negative American odds -N → N / (N + 100). Positive odds +N → 100 / (N + 100).
    const capAm = config.pricing.nbaSeriesFavoriteCapAmericanOdds || -250;
    const absCap = Math.abs(capAm);
    const threshProb = capAm < 0 ? absCap / (absCap + 100) : 100 / (absCap + 100);
    if (hit.fairProb > threshProb) {
      let bookDec = hit.decimalOdds;
      if ((!bookDec || bookDec <= 1) && hit.americanOdds != null) {
        bookDec = hit.americanOdds >= 0
          ? 1 + hit.americanOdds / 100
          : 1 + 100 / Math.abs(hit.americanOdds);
      }
      if (bookDec && bookDec > 1) {
        const bookImplied = 1 / bookDec;
        log.info('Pricing', `NBA series heavy fav ${teamName} ${mt || ''} fair ${hit.fairProb.toFixed(4)} > ${capAm} cutoff — using DK book price ${hit.americanOdds} (implied ${bookImplied.toFixed(4)})`);
        return { fairProb: hit.fairProb, bookPriceOverride: bookImplied };
      }
    }
  }
  return hit.fairProb;
}

/**
 * Golf matchup legs: route through the round-aware DataGolf accessor so
 * a round RFQ ("R1 RBC Heritage") is priced against round_matchups odds
 * and a tournament RFQ is priced against tournament_matchups odds. The
 * generic oddsFeed path keys purely on player-pair and would pick
 * whichever entry was pushed to the cache first when both exist — a
 * material mispricing risk.
 *
 * Returns null for non-golf legs; caller falls back to the normal path.
 */
/**
 * Fair prob for a golf outright leg (win / top_5 / top_10 / top_20 / make_cut).
 * Pure sync cache read via datagolf; null ⇒ caller declines the parlay.
 * Never throws — a DataGolf bug must not break the RFQ hot path.
 */
function golfOutrightFair(lineInfo) {
  try {
    const player = lineInfo.playerName || lineInfo.teamName;
    // PRIORITY 1 — the operator's DK "(Including Ties)" paste, when fresh.
    // It is the literal board he prices off, on PX's exact settlement basis,
    // so it outranks any modelled source.
    const topN = require('./golf-topn');
    if (topN.getTopNFairProbSync) {
      const t = topN.getTopNFairProbSync(player, lineInfo.marketType, lineInfo.tournamentName);
      if (t && t.fairProb > 0 && t.fairProb < 1) return t;
    }
    // PRIORITY 2 — DataGolf (restored 2026-07-30, operator directive: quote
    // outrights for EVERY tournament from a reliable source). It carries 11-14
    // books per market for every event pre-tournament, which neither the
    // Railway-blocked DK scrape nor a manual paste can match.
    //
    // The 2026-07-18 removal was specifically about BASIS, not reliability:
    // DataGolf serves top-N dead-heat while PX settles ties-included. That is
    // now corrected inside fetchOutrightBoard via the measured ties uplift
    // (see GOLF_TOPN_TIES_UPLIFT), so top-N no longer prices ~25% cheap.
    // `win` needs no correction — a win is a win, and its field normalizes to
    // an exact 1.0 target.
    const dataGolf = require('./datagolf');
    if (dataGolf.getOutrightFairProbSync) {
      const hit = dataGolf.getOutrightFairProbSync(player, lineInfo.marketType,
        [lineInfo.tournamentName, lineInfo.pxEventName]);
      if (hit && hit.fairProb > 0 && hit.fairProb < 1) return hit;
    }
    return null;
  } catch (err) {
    log.warn('Pricing', `golfOutrightFair threw: ${err.message}`);
    return null;
  }
}

function getGolfMatchupFairProb(lineInfo) {
  const sport = (lineInfo?.oddsApiSport || lineInfo?.sport || '').toLowerCase();
  if (!sport.includes('golf')) return null;
  const mt = lineInfo?.marketType || '';
  if (mt !== 'moneyline') return null; // golf matchups are h2h only

  // Min-margin clamp for a RAW book override. DataGolf's per-book matchup
  // odds are inconsistent — some books post juiced two-way (betcris -115/-115,
  // ~7%), others post generous/near-no-vig (bet365 +100/+110, NEGATIVE
  // overround). Quoting a generous book raw would offer legs tighter than our
  // floor (2026-07-19: 41/42 Open R4 pairings had no betonline/bovada and fell
  // to ~1.4% two-way). This clamps the offered implied UP to at least the
  // payout-vig floor (same PAYOUT-MULTIPLICATIVE convention the de-vig fallback
  // uses in computeSingleLegVig/getEffectiveVig, so ONE constant drives both
  // paths to the same target — vigGolfMatchupMin=0.0909 → -110/-110 coinflip).
  // We NEVER quote a matchup tighter than that, while still keeping a fatter
  // book line when one exists.
  const clampOverride = (fair, override) => {
    if (!(fair > 0 && fair < 1) || override == null) return override;
    const floor = config.pricing.vigGolfMatchupMin || 0;
    const minOffered = 1 / (1 + (1 / fair - 1) * (1 - floor)); // payout-vig floor
    return Math.max(override, Math.min(0.999, minOffered));
  };

  // Resolve roundNum with a parse-from-name fallback. Some golf matchup
  // lines were registered with lineInfo.roundNum=null (older seed paths,
  // or PX event.name fields without "Round N" populated at seed time);
  // the round metadata still lives in pxEventName like "Adam Scott vs.
  // Ryan Gerard (Round 4 Matchup)". Without this fallback, the manual
  // upload lookup would query scope='tournament' and miss the round_N
  // entry, even after the operator has uploaded R4.
  let roundNum = lineInfo?.roundNum ?? null;
  if (roundNum == null) {
    const haystack = `${lineInfo?.pxEventName || ''} ${lineInfo?.marketName || ''}`;
    const m = /\bR(?:ound\s*)?([1-4])\b/i.exec(haystack);
    if (m) roundNum = parseInt(m[1], 10);
  }

  // PRIORITY 1: Manual book upload (operator-supplied Bookmaker / BetOnline
  // odds via /betonline-zurich/upload). When present, this is the
  // operator's authoritative quoting price.
  //
  // Return shape: { fairProb, bookPriceOverride } so priceParlay quotes
  // AT the raw odds (no de-vig + re-add vig). Mirrors the NBA series
  // heavy-favorite pattern (pricer.js:~290).
  const teamName = lineInfo?.teamName || '';
  if (teamName) {
    try {
      const betonlineScraper = require('./betonline-scraper');
      // Pass the opponent so a player who appears in multiple matchups
      // in the same scope (Cadillac R3 had Castillo in two pairings) is
      // priced from the correct matchup, not whichever was uploaded
      // first. Opponent = the OTHER side of this lineInfo's pair.
      const opponent = (lineInfo.teamName === lineInfo.homeTeam)
        ? lineInfo.awayTeam
        : lineInfo.homeTeam;
      const boHit = betonlineScraper.lookupZurichMatchupFairProb(teamName, roundNum, opponent);
      if (boHit && boHit.fairProb != null) {
        const rawAm = boHit.americanOdds;
        let rawImplied = boHit.impliedProb;
        if (rawImplied == null && Number.isFinite(rawAm)) {
          rawImplied = rawAm >= 0 ? 100 / (rawAm + 100) : -rawAm / (-rawAm + 100);
        }
        if (rawImplied != null && rawImplied > 0 && rawImplied < 1) {
          return { fairProb: boHit.fairProb, bookPriceOverride: clampOverride(boHit.fairProb, rawImplied) };
        }
        return boHit.fairProb;
      }
    } catch (_) { /* scraper unavailable — fall through to DataGolf book lookup */ }
  }

  // Raw posted odds from the DataGolf feed. Operator preference 2026-05-19:
  // golf matchup lines off de-vigged consensus end up narrower than any
  // tradeable book (we strip each book's edge before re-applying our own vig);
  // quote at the BOOK's raw posted line instead. Operator directive 2026-07-19:
  // ANY one book is fine for golf — do NOT gate on betonline/bovada only.
  // Gating on 2 books silently dropped 41/42 The Open R4 pairings (only
  // Scheffler/Rahm had BetOnline) and, before the strict-mode removal, killed
  // all matchup quoting. So the priority spans every book DataGolf populates in
  // byBook (see datagolf.CONSENSUS_BOOKS); first present wins, sharp/preferred
  // first. The clampOverride floor makes taking any single book's raw line safe
  // — a generous book (bet365 +100/+110) lifts to -110, a fatter one is kept.
  // fairProb stays the de-vigged consensus across all books (downstream sanity
  // checks only); the quoted price is bookPriceOverride.
  try {
    const oddsFeed = require('./odds-feed');
    const event = oddsFeed.getGolfMatchupEvent(lineInfo.homeTeam, lineInfo.awayTeam, roundNum);
    const h2h = event && event.markets && event.markets.h2h;
    if (h2h) {
      // Pick the side this lineInfo represents. teamName is the player
      // we're betting on; match against the event's homeTeam/awayTeam.
      // Fall back to oddsApiSelection / selection when teamName doesn't
      // resolve uniquely (rare but possible after name normalization).
      let side = null;
      const tn = teamName.toLowerCase();
      if (tn && event.homeTeam && tn === event.homeTeam.toLowerCase()) side = h2h.home;
      else if (tn && event.awayTeam && tn === event.awayTeam.toLowerCase()) side = h2h.away;
      else if (lineInfo.oddsApiSelection === 'home' || lineInfo.selection === 'home') side = h2h.home;
      else if (lineInfo.oddsApiSelection === 'away' || lineInfo.selection === 'away') side = h2h.away;
      if (side && side.fairProb != null && side.fairProb > 0 && side.fairProb < 1) {
        const byBook = side.byBook || {};
        // First book with an odds entry wins — sharp/operator-preferred first,
        // then the rest. Must stay within datagolf.CONSENSUS_BOOKS (the only
        // books populated into byBook). Each value is American odds.
        const priority = ['betonline', 'bovada', 'pinnacle', 'bet365', 'betmgm', 'caesars', 'betcris', 'draftkings', 'fanduel', 'unibet'];
        for (const book of priority) {
          const am = byBook[book];
          if (!Number.isFinite(am)) continue;
          const rawImplied = am >= 0 ? 100 / (am + 100) : -am / (-am + 100);
          if (rawImplied > 0 && rawImplied < 1) {
            return { fairProb: side.fairProb, bookPriceOverride: clampOverride(side.fairProb, rawImplied) };
          }
        }
      }
    }
  } catch (_) { /* odds-feed unavailable — fall through to strict-mode null */ }

  // STRICT MODE: when no Bookmaker manual upload AND no BetOnline /
  // Bovada line in the DataGolf feed, decline. Falling through to the
  // de-vigged consensus produces ~50/50 lines that are tighter than any
  // tradeable book, which the operator explicitly rejected 2026-05-19.
  // priceParlay's golf-matchup branch checks for null and triggers the
  // standard "no fair quote" decline path.
  return null;
}

/**
 * MMA moneyline legs: route directly to the DK scraper cache rather than
 * the shared odds-feed cache. Context: SharpAPI rarely covers MMA h2h
 * reliably, so the DK scraper is the source of truth. DK data IS merged
 * into oddsCache['mma_mixed_martial_arts'] at startup/refresh, but that
 * cache appears to get wiped when SharpAPI's UFC refresh runs with zero
 * matching rows — producing spurious "no h2h quote for X" declines on
 * fights DK clearly has. Bypassing to dkScraper.lookupMmaFairProb makes
 * us resilient to that wipe regardless of whether the merge ran, and
 * mirrors the getSeriesFairProb pattern.
 *
 * Returns null when the leg isn't MMA, isn't moneyline, or the fighter
 * isn't in the DK cache — caller falls back to the oddsFeed path.
 */
function getMmaFairProb(lineInfo) {
  const sport = (lineInfo?.oddsApiSport || lineInfo?.sport || '').toLowerCase();
  if (!sport.includes('mma')) return null;
  // DK cache only covers moneyline (h2h) for MMA — total rounds go via
  // the separate oddsFeed path that the merge ALSO populates.
  const mt = lineInfo?.marketType || '';
  const am = lineInfo?.oddsApiMarket || '';
  if (mt !== 'moneyline' && am !== 'h2h') return null;
  const fighter = lineInfo?.teamName || '';
  if (!fighter) return null;
  // Pass the opponent so the DK lookup can verify both fighters match
  // the PX competitor pair. Opponent is the OTHER side of the matchup
  // — derived from oddsApiSelection when present, else the team that
  // isn't the leg's fighter.
  const home = lineInfo?.homeTeam || '';
  const away = lineInfo?.awayTeam || '';
  let opponent = '';
  const sel = lineInfo?.oddsApiSelection;
  if (sel === 'home') opponent = away;
  else if (sel === 'away') opponent = home;
  else if (home && away) {
    const f = String(fighter).toLowerCase();
    const h = String(home).toLowerCase();
    opponent = f.includes(h) || h.includes(f) ? away : home;
  }
  const hit = dkScraper.lookupMmaFairProb(fighter, opponent);
  if (!hit) return null;
  // In-play guard: decline if the fight has already started. DK's odds
  // are pre-fight and would give a bettor material edge mid-round.
  if (hit.startTime) {
    const t = new Date(hit.startTime).getTime();
    if (Number.isFinite(t) && t <= Date.now()) {
      log.debug('Pricing', `MMA in-play decline: ${fighter} (startTime ${hit.startTime})`);
      return null;
    }
  }
  return hit.fairProb;
}

/**
 * Convert decimal odds to American odds (integer).
 * PX uses American odds throughout its API and per Alec (2026-05-12)
 * accepts integer values only.
 */
function decimalToAmerican(dec) {
  if (!dec || dec <= 1) return 0;
  if (dec >= 2.0) return Math.round((dec - 1) * 100);  // +150, +286, etc.
  return Math.round(-100 / (dec - 1));                   // -200, -150, etc.
}

/**
 * Distribute a parlay's full implied probability across its legs so the PRODUCT
 * of the returned per-leg probabilities EXACTLY equals targetParlayProb.
 *
 * PX requires (Anthony/PX, 2026-06-25) that for non-SGP parlays the per-leg
 * probabilities we report in the offer/confirmation multiply to the parlay's
 * implied probability — otherwise the order is rejected with "Invalid
 * Probability". We apply vig + parlay-level ramps (longshot, leg-count,
 * template) + the SGP correlation multiplier at the PARLAY level, so the raw
 * per-leg FAIR probs (whose product is fairParlayProb) fall short of the offered
 * implied prob by exactly the vig and never reconcile. Geometric scaling keeps
 * each leg's relative weight while folding the entire parlay price into the legs.
 *
 * `legBaseProbs` are the per-leg basis probs (bookPriceOverride if set, else
 * fairProb). Returns an array of nulls if inputs are unusable (caller falls back).
 * The last leg absorbs floating-point residual so the product is bit-exact.
 */
function distributeLegProbs(legBaseProbs, targetParlayProb) {
  const n = Array.isArray(legBaseProbs) ? legBaseProbs.length : 0;
  if (!n || !(targetParlayProb > 0) || !isFinite(targetParlayProb)) {
    return new Array(n).fill(null);
  }
  const base = legBaseProbs.map(p => (p > 0 && p < 1 ? p : null));
  if (base.some(p => p == null)) return new Array(n).fill(null);
  const rawProduct = base.reduce((a, p) => a * p, 1);
  if (!(rawProduct > 0) || !isFinite(rawProduct)) return new Array(n).fill(null);
  const scale = Math.pow(targetParlayProb / rawProduct, 1 / n);
  const out = base.map(p => Math.min(0.999999, Math.max(1e-6, p * scale)));
  // Last leg absorbs rounding so Π(out) === targetParlayProb to machine precision.
  if (n > 1) {
    const prefix = out.slice(0, -1).reduce((a, p) => a * p, 1);
    if (prefix > 0) out[n - 1] = Math.min(0.999999, Math.max(1e-6, targetParlayProb / prefix));
  } else {
    out[0] = Math.min(0.999999, Math.max(1e-6, targetParlayProb));
  }
  return out;
}

/**
 * Compute the consensus implied probability for a leg from Pin/FD/DK
 * (Kalshi excluded — same definition as the Lines tab "CONS" column).
 * Returns null when none of the three books have a price for this leg.
 *
 * Used by the consensus-floor guardrail in priceParlay and computeSingleLegQuote.
 */
function getConsensusImplied(lineInfo) {
  if (!lineInfo) return null;
  const oaSport = lineInfo.oddsApiSport || lineInfo.sport;
  const oaMarket = lineInfo.oddsApiMarket || lineInfo.marketType;
  const sel = lineInfo.oddsApiSelection || lineInfo.selection;
  let pin = null, fd = null, dk = null;
  try { pin = oddsFeed.getPinnacleOdds(oaSport, lineInfo.homeTeam, lineInfo.awayTeam, oaMarket, sel, lineInfo.startTime, lineInfo.line); } catch (_) {}
  try { fd  = oddsFeed.getFanDuelOdds(oaSport, lineInfo.homeTeam, lineInfo.awayTeam, oaMarket, sel, lineInfo.startTime, lineInfo.line); } catch (_) {}
  try { dk  = oddsFeed.getDraftKingsOdds(oaSport, lineInfo.homeTeam, lineInfo.awayTeam, oaMarket, sel, lineInfo.startTime, lineInfo.line); } catch (_) {}
  const implieds = [pin, fd, dk]
    .filter(o => o != null && Number.isFinite(o))
    .map(o => o >= 0 ? 100 / (o + 100) : -o / (-o + 100));
  if (implieds.length === 0) return null;
  return implieds.reduce((a, b) => a + b, 0) / implieds.length;
}

/**
 * Standalone (not-inside-priceParlay) vig computation for a single leg.
 * Mirrors the closures inside priceParlay: base sport vig → favorite ramp
 * → series/MMA floors. Used by the /lines/detail endpoint to show "what
 * would I quote on this single leg if someone asked for it alone?"
 * Not used in the actual pricing path — that stays in priceParlay.
 */
function computeSingleLegVig(fairProb, sport, marketType) {
  if (!(fairProb > 0 && fairProb < 1)) return null;
  const vigBySport = config.pricing.vigBySport || {};
  const baseVig = (sport && vigBySport[sport] != null) ? vigBySport[sport] : config.pricing.defaultVig;
  // Player props: flat floor at vigPropFloor (default 3%). Mirrors the
  // priceParlay-internal getEffectiveVig logic for player_<type> markets.
  if (marketType && /^player_/.test(marketType)) {
    return Math.max(config.pricing.vigPropFloor || 0, baseVig);
  }
  const favSlope = config.pricing.vigFavoriteSlope;
  const favFloor = config.pricing.vigFavoriteFloor;
  const seriesMinVig = config.pricing.vigSeriesMin || 0;
  const mmaMinVig = config.pricing.vigMmaMin || 0;
  let vig;
  if (fairProb <= 0.5) {
    vig = baseVig;
  } else {
    const ramp = baseVig + favSlope * (fairProb - 0.5);
    vig = favFloor > 0 ? Math.max(favFloor, ramp) : ramp;
  }
  if (marketType === 'series_winner' && seriesMinVig > 0) vig = Math.max(vig, seriesMinVig);
  if (sport === 'mma_mixed_martial_arts' && mmaMinVig > 0) vig = Math.max(vig, mmaMinVig);
  // Golf-matchup floor — mirror the priceParlay-internal getEffectiveVig
  // floor so /lines/detail's MY ODDS column matches what RFQ pricing
  // would actually offer. Only relevant when the leg falls through to
  // de-vig+vig (i.e. no Bookmaker manual / BetOnline / Bovada raw price
  // available); when bookPriceOverride is set, vig is bypassed entirely
  // and this floor doesn't fire. Without this, Lines tab displayed
  // ~1.5% pair vig on golf while RFQs would have offered ~2.5% pair.
  const golfMatchupMinVig = config.pricing.vigGolfMatchupMin || 0;
  if (sport === 'golf_matchups' && golfMatchupMinVig > 0) vig = Math.max(vig, golfMatchupMinVig);
  // Golf outrights (option B): win/top_5/top_10/top_20 fairs ARE the RAW DK
  // "(Including Ties)" implied, which already carries DK's full margin — so we
  // OVERRIDE (not Math.max) the 6% default sport vig with exactly the thin
  // mirror cushion, landing our legs ~2% worse than DK's posted price. make_cut
  // is DIFFERENT: its fair is a DE-VIGGED make-side board (power-normalized in
  // golf-topn), so it keeps the wider vigGolfOutrightMin floor — applying the
  // 2% mirror to a de-vigged fair would quote it far too cheap. MUST mirror
  // getEffectiveVig's copy below.
  if (sport === 'golf_outrights') {
    if (GOLF_RAW_DK_OUTRIGHT_MARKETS.has(marketType)) {
      vig = config.pricing.vigGolfOutrightMirror || 0.02;
    } else {
      const golfOutrightMinVig = config.pricing.vigGolfOutrightMin || 0;
      if (golfOutrightMinVig > 0) vig = Math.max(vig, golfOutrightMinVig);
    }
  }
  return vig;
}

/**
 * Given a fair probability + leg metadata, return what we'd quote if this
 * were the ONLY leg of a 1-leg "parlay". Returns { vig, impliedProb,
 * americanOdds } or null if inputs are invalid.
 *
 * Mirrors priceParlay's two-stage pricing exactly so the /lines/detail
 * dashboard display matches what a real RFQ would offer:
 *   1. Compute payout-vig offered: fair → vigged-payout → impliedProb
 *   2. If VIG_FAIR_MULTIPLIER > 0, take MAX of payout-vig offered and
 *      fair × (1 + multiplier). This is the books-shaped curve that
 *      bites at high fair_prob, reproducing Pinnacle-style markup on
 *      chalky legs where the payout formula alone gives microscopic gaps.
 *
 * Without step 2, the dashboard MY ODDS column undersold our actual
 * quote on chalky legs (e.g. soccer slight-favorite spreads showed
 * -130 while the RFQ pipeline would have offered -135).
 */
function computeSingleLegQuote(fairProb, sport, marketType, consensusImplied = null) {
  const vig = computeSingleLegVig(fairProb, sport, marketType);
  if (vig == null) return null;
  const fairDecimal = 1 / fairProb;
  const payout = fairDecimal - 1;
  const viggedPayout = payout * (1 - vig);
  let impliedProb = 1 / (1 + viggedPayout);
  // Apply VIG_FAIR_MULTIPLIER as a fair-shaped floor — same MAX gate
  // priceParlay uses post-payout-vig.
  const fairMult = config.pricing.vigFairMultiplier || 0;
  if (fairMult > 0) {
    const multImplied = fairProb * (1 + fairMult);
    if (multImplied > impliedProb && multImplied < 0.99) {
      impliedProb = multImplied;
    }
  }
  // Heavy-favorite fair markup — same MAX gate priceParlay uses
  // per-leg, so dashboard's single-leg display matches what an RFQ
  // touching this leg would compound to. Chalk-stack surcharge is
  // parlay-level and doesn't apply to single legs by definition.
  const heavyFavMarkup = config.pricing.vigHeavyFavFairMarkup || 0;
  const heavyFavThreshold = config.pricing.vigHeavyFavThreshold || 0.70;
  const heavyFavCap = config.pricing.vigHeavyFavFairCap || 0.85;
  // Mirror priceParlay's cap + prop exclusion so the single-leg display
  // matches the real offer: skip extreme chalk (fp ≥ cap) and player props.
  const isProp = /^(player_|pitcher_|hitter_|batter_)/.test(marketType || '');
  if (heavyFavMarkup > 0 && !isProp && fairProb > heavyFavThreshold && fairProb < heavyFavCap) {
    const heavyImplied = fairProb * (1 + heavyFavMarkup);
    if (heavyImplied > impliedProb && heavyImplied < 0.99) {
      impliedProb = heavyImplied;
    }
  }
  // Consensus floor clamp — final guardrail. If our offered implied is more
  // than priceFloorVsConsensusPp pp BELOW the Pin/FD/DK consensus implied,
  // clamp up to consensus − threshold. Caller supplies consensusImplied to
  // avoid duplicate book lookups; null disables the clamp.
  const floorPp = config.pricing.priceFloorVsConsensusPp || 0;
  if (floorPp > 0 && consensusImplied != null && Number.isFinite(consensusImplied)) {
    const floorImplied = consensusImplied - (floorPp / 100);
    if (impliedProb < floorImplied) {
      impliedProb = Math.min(0.99, Math.max(0.01, floorImplied));
    }
  }
  const decimalOdds = 1 / impliedProb;
  return {
    vig,
    impliedProb,
    americanOdds: decimalToAmerican(decimalOdds),
  };
}

// ---------------------------------------------------------------------------
// PRICING ENGINE
// ---------------------------------------------------------------------------

/**
 * Price a parlay given an array of legs (line_ids from the RFQ).
 *
 * Returns null if the parlay should be declined.
 * Returns an offer object if we can price it.
 */
// NOTE: priceParlay is intentionally NOT declared `async`. An `async`
// function always returns a Promise, which forces the websocket caller
// to `await` it — and `await` always pays one V8 microtask hop (~0.32ms
// p50 measured Apr 26). On the cache-warm fast path (most RFQs), no
// async work is needed inside priceParlay, so returning the result
// SYNCHRONOUSLY skips that microtask cost entirely. The caller does:
//   const r = pricer.priceParlay(...);
//   const result = (r && typeof r.then === 'function') ? await r : r;
// On RFQs that DO need async work (alt-line cache miss or Pinnacle
// verify), priceParlay returns a Promise that resolves to the result.
function priceParlay(legs, opts = {}) {
  priceParlay._lastFailure = null; // clear any prior failure
  // Latency diagnostic — captures function entry to surface in _timings.
  // Lets the websocket layer compute "entry-to-phase1" gap (work before
  // sync validation begins: opts unpacking, top-level config reads,
  // team_total decline loop). Apr 26: 1.27ms p50 total had ~0.31ms of
  // unaccounted time inside priceParlay despite phase1+2+3 only summing
  // to 0.37ms — these markers find where it lives.
  const entryMs = performance.now();
  // Validate leg count
  if (!legs || legs.length === 0) {
    log.debug('Pricing', 'Declined: no legs');
    priceParlay._lastFailure = { reason: 'empty', detail: null, blockerLeg: null };
    return null;
  }
  if (legs.length > config.pricing.maxLegs) {
    log.debug('Pricing', `Declined: ${legs.length} legs exceeds max ${config.pricing.maxLegs}`);
    priceParlay._lastFailure = { reason: 'too many legs', detail: `${legs.length} > max ${config.pricing.maxLegs}`, blockerLeg: null };
    return null;
  }
  // Optional: caller (handleRFQ via shouldDecline) passes a Map of lineId →
  // lineInfo so we skip redundant lookupLine() calls. shouldDecline already
  // validated "unknown legs" and "event started" for these, but we keep the
  // startTime check below as a belt-and-suspenders guard (cheap with
  // startTimeMs pre-computed).
  const preResolved = opts.resolvedLineInfos; // Map<lineId, lineInfo> | undefined

  // Look up and price each leg.
  //
  // --- PARALLELIZED STRUCTURE (Phase A of latency plan) ---
  // Previously every leg ran sequentially — each getFairProbAsync await blocked
  // the next. For N-leg parlays where M legs need alt-line fetches, worst-case
  // pricing time was M × (fetch round-trip). Now:
  //
  //   Phase 1: All cheap sync validation per leg. Bail early on first failure.
  //   Phase 2: Fire getFairProbAsync + verifyLineWithPinnacle for ALL surviving
  //            legs in parallel via Promise.all. Worst-case pricing time caps at
  //            a single fetch round-trip regardless of leg count.
  //   Phase 3: Sync post-processing — check async results, compute book odds,
  //            build pricedLegs array, accumulate fair parlay prob.
  //
  // All original validation, decline reasons, and blocker-leg reporting are
  // preserved — just the two network calls are now parallel instead of serial.
  const pricedLegs = [];
  // Per-leg prop-fair calibration adjustments applied this parlay (telemetry).
  const propFairCalibs = [];
  let fairParlayProb = 1.0;

  // Phase-timing markers. We emit these on the happy path via the
  // result.meta._timings field so the websocket layer can decompose the
  // composite "price" stage. Failure paths (early returns) skip this —
  // only successful offers produce timings.
  const phaseStartMs = performance.now();
  let phase1EndMs = null;
  let phase2EndMs = null;

  // ---------------------------------------------------------------------
  // DEFENSIVE DECLINE: team_total legs
  //
  // Verified 2026-04-23: a confirmed 4-leg parlay (019dbae7-632b-7647)
  // contained an "ATL team_total Over 4.5" leg priced at our fair 45.4%
  // while FanDuel quoted -136 (~55% fair after de-vig). The primary
  // cache for that event held team_total Over at -136 paired with
  // Under at -225 — a 26.9% overround that indicates the consensus
  // builder paired an Over 4.5 with a DIFFERENT-line Under (probably
  // Under 5.5 or 6.5). Proportional de-vig then produced a 45/55
  // split when the real fair was ~55/45, a ~10pp systematic bias on
  // the losing side. Estimated ~7-8pp bettor EV on that parlay.
  //
  // The root cause lives in getBookPairsForTeamTotals /
  // buildConsensusTeamTotals and requires an audit to ensure Over/Under
  // pairs are always same-line same-book. Until that audit lands,
  // decline all team_total legs defensively — no quotes on this market
  // class instead of potentially mispriced ones.
  //
  // Gated behind config flag so we can flip it off once the audit
  // completes without another deploy.
  // ---------------------------------------------------------------------
  if (config.pricing.declineTeamTotals !== false) {
    for (const leg of legs) {
      const lineId = leg.line_id || leg.lineId || leg;
      const lineInfo = (opts.resolvedLineInfos && opts.resolvedLineInfos.get(lineId)) || lineManager.lookupLine(lineId);
      if (lineInfo && (lineInfo.marketType === 'team_total' || lineInfo.oddsApiMarket === 'team_totals')) {
        log.info('Pricing', `Declined: team_total leg on defensive block (${lineInfo.teamName} ${lineInfo.line} — audit pending on consensus pairing)`);
        priceParlay._lastFailure = {
          reason: 'team_total declined',
          detail: `team_total legs declined pending consensus-builder audit (${lineInfo.teamName || '?'} ${lineInfo.line || '?'})`,
          blockerLeg: {
            team: lineInfo.teamName,
            market: lineInfo.marketType,
            line: lineInfo.line,
            sport: lineInfo.sport,
          },
        };
        return null;
      }
    }
  }

  // ------------------------- PHASE 1: Sync validation -------------------------
  const legStates = [];
  const nowMs = Date.now();
  // Per-request cache: isStale / getCacheAge / getStaleThreshold repeat for
  // every leg of a single-sport parlay. Memoize once here.
  const staleCache = {};
  // Event-aware: relaxes the flat per-sport threshold for far-out games (see
  // oddsFeed.isStaleForEvent). Memoize by sport+startTime since two legs on the
  // same sport can have different start times (and thus different far-out
  // relaxation). Imminent games are unaffected + still hit isEventStalePreGame.
  const isStaleCached = (sport, startTime) => {
    // Golf outrights have NO odds-feed cache entry — they are priced from
    // DataGolf (win / make_cut) and DK's ties board (top 5/10), not from the
    // odds feed. So oddsFeed.getCacheAge('golf_outrights') is Infinity and this
    // check declined EVERY outright leg as "stale odds (Infinitym old)" —
    // operator hit exactly this: make-cut and Top 5 parlays both returned
    // "No Offers Available" on PX despite passing shouldDecline.
    // Freshness IS still enforced, by each source's own gate, and both fail
    // CLOSED (null fair ⇒ decline):
    //   win/make_cut → datagolf TTL + GOLF_OUTRIGHT_MAX_AGE_MIN board-age guard
    //   top_5/top_10 → golf-topn board age (GOLF_TOPN_MAX_AGE_MIN)
    if (sport === 'golf_outrights') return false;
    const key = sport + '|' + (startTime || '');
    if (staleCache[key] === undefined) staleCache[key] = oddsFeed.isStaleForEvent(sport, startTime);
    return staleCache[key];
  };
  for (const leg of legs) {
    const lineId = leg.line_id || leg.lineId || leg;
    const lineInfo = (preResolved && preResolved.get(lineId)) || lineManager.lookupLine(lineId);

    if (!lineInfo) {
      log.debug('Pricing', `Declined: unknown line_id ${lineId}`);
      priceParlay._lastFailure = { reason: 'unknown line', detail: null, blockerLeg: null };
      return null;
    }

    const legLabel = `${lineInfo.teamName || '?'} (${lineInfo.marketType || '?'}${lineInfo.line != null ? ' ' + lineInfo.line : ''})`;
    const legDescriptor = {
      team: lineInfo.teamName,
      market: lineInfo.marketType,
      line: lineInfo.line,
      sport: lineInfo.sport,
      homeTeam: lineInfo.homeTeam,
      awayTeam: lineInfo.awayTeam,
    };

    // Check if event has already started — don't quote with stale pre-game odds.
    // Golf matchups exempt (no commenceTime from DataGolf; isStale check covers).
    // Uses pre-computed lineInfo.startTimeMs (cached by lookupLine).
    const isGolfMatchup = lineInfo.sport === 'golf_matchups' || lineInfo.oddsApiSport === 'golf_matchups';
    // Golf outrights quote LIVE — same exemption + rationale as shouldDecline's
    // started check (freshness is the DK board age, not the tournament start).
    const isGolfOutright = lineInfo.sport === 'golf_outrights';
    const startMs = lineInfo.startTimeMs;
    if (startMs != null) {
      if (isNaN(startMs)) {
        log.debug('Pricing', `Declined: invalid startTime for ${lineInfo.teamName} (${lineInfo.startTime})`);
        priceParlay._lastFailure = { reason: 'unknown start time', detail: `${legLabel} has invalid startTime ${lineInfo.startTime}`, blockerLeg: legDescriptor };
        return null;
      }
      if (nowMs > startMs && !isGolfOutright) {
        log.debug('Pricing', `Declined: event already started (${lineInfo.teamName}, started ${lineInfo.startTime})`);
        priceParlay._lastFailure = { reason: 'event started', detail: `${legLabel} already in progress`, blockerLeg: legDescriptor };
        return null;
      }
    } else if (!isGolfMatchup) {
      log.debug('Pricing', `Declined: null startTime for ${lineInfo.teamName} (${lineInfo.sport})`);
      priceParlay._lastFailure = { reason: 'unknown start time', detail: `${legLabel} has no startTime — cannot verify game hasn't started`, blockerLeg: legDescriptor };
      return null;
    }

    // Pre-game window gate for ALL MLB player props (pitcher K + hitter props).
    // The overnight prop market is immature (starter/lineup barely set, thin/soft
    // early books) — a correct fair still comes out wrong from bad input and gets
    // picked off overnight. Decline MLB player-prop legs quoted more than N hours
    // before first pitch. Env MLB_PROP_MAX_HOURS_BEFORE_START (default 10); 0 off.
    const mlbPropMaxHrs = config.pricing.mlbPropMaxHoursBeforeStart;
    if (mlbPropMaxHrs > 0 && lineInfo.sport === 'baseball_mlb'
        && /^player_/.test(lineInfo.marketType || '') && startMs != null && !isNaN(startMs)) {
      const hrsBefore = (startMs - nowMs) / 3600000;
      if (hrsBefore > mlbPropMaxHrs) {
        log.debug('Pricing', `Declined: MLB prop too early (${hrsBefore.toFixed(1)}h before start > ${mlbPropMaxHrs}h) — ${legLabel}`);
        priceParlay._lastFailure = {
          reason: 'prop too early',
          detail: `${legLabel} MLB prop ${hrsBefore.toFixed(1)}h pre-game (>${mlbPropMaxHrs}h — market not mature)`,
          blockerLeg: legDescriptor,
        };
        return null;
      }
    }

    // Check if prices are stale for this sport. Uses per-sport threshold:
    // MMA/boxing/NFL have tighter windows because they move on news;
    // NCAAB/tennis have looser windows because they only refresh on full cycles.
    if (isStaleCached(lineInfo.sport, lineInfo.startTime)) {
      const ageMin = Math.round(oddsFeed.getCacheAge(lineInfo.sport) * 10) / 10;
      const threshold = oddsFeed.getStaleThreshold(lineInfo.sport);
      log.debug('Pricing', `Declined: stale prices for ${lineInfo.sport} (${ageMin}min old, threshold ${threshold}m)`);
      priceParlay._lastFailure = {
        reason: 'stale odds',
        detail: `${lineInfo.sport} odds ${ageMin}m old (threshold ${threshold}m)`,
        blockerLeg: legDescriptor,
      };
      return null;
    }

    // Prop-leg freshness (SGP roadmap Stage 0): mirrors shouldDecline's
    // prop_stale gate. Load-bearing at CONFIRM time — validateForConfirmation
    // calls priceParlay directly (no shouldDecline), and without this a
    // stale prop reprices against its own stale fairProb, shows zero drift,
    // and gets accepted. With it, the reprice fails with a non-churn reason
    // and the bounded fail-open rejects. Quote path unaffected (shouldDecline
    // already declined stale props before priceParlay runs).
    if (/^player_/.test(lineInfo.marketType || '') && lineInfo.propFetchedAt) {
      const propAgeMs = nowMs - lineInfo.propFetchedAt;
      const propStaleMs = (config.pricing.stalePropSeconds || 420) * 1000;
      if (propAgeMs > propStaleMs) {
        const ageMin = Math.round(propAgeMs / 6000) / 10;
        log.debug('Pricing', `Declined: stale prop data for ${legLabel} (${ageMin} min old)`);
        priceParlay._lastFailure = {
          reason: 'prop stale',
          detail: `${legLabel} prop data ${ageMin} min old (>${Math.round(propStaleMs / 60000 * 10) / 10} min)`,
          blockerLeg: legDescriptor,
        };
        return null;
      }
    }

    // Pre-game closing-line guard: within 30 min of tip-off, sportsbooks
    // move the line hard on late news. Require much fresher cache (≤ 2 min)
    // for events in the final pre-game window. Catches scenarios where the
    // sport-level cache passes isStale but the line has moved since refresh
    // (this is how the Rockies +190/+194 stale FD/DK quote slipped through).
    // Golf outrights exempt for the same reason as isStaleCached above: no
    // odds-feed cache entry ⇒ getCacheAge is Infinity ⇒ this would decline every
    // outright leg once the tournament is within 30 min of tee-off. Their own
    // board-age guards cover freshness and fail closed.
    if (lineInfo.sport !== 'golf_outrights' && oddsFeed.isEventStalePreGame(lineInfo.sport, lineInfo.startTime)) {
      const ageMin = Math.round(oddsFeed.getCacheAge(lineInfo.sport) * 10) / 10;
      log.info('Pricing', `Declined pre-game: ${legLabel} starts soon, cache ${ageMin}m old (limit 2m)`);
      priceParlay._lastFailure = {
        reason: 'stale odds (pre-game)',
        detail: `${legLabel} starts within 30m, ${lineInfo.sport} cache ${ageMin}m old (pre-game limit 2m)`,
        blockerLeg: legDescriptor,
      };
      return null;
    }

    // Lineup-change guard: if the MLB starting pitcher or NHL starting goalie
    // has swapped within the last few minutes, the sportsbooks are still
    // re-pricing and our cached odds are likely stale even if the cache
    // timestamp is fresh. Decline briefly to avoid getting picked off on
    // lineup news. Only MLB/NHL — other sports return null from this check.
    const lineupStatus = oddsFeed.checkLineupFreshness(
      lineInfo.sport, lineInfo.homeTeam, lineInfo.awayTeam, lineInfo.startTime
    );
    if (lineupStatus) {
      const ageSec = Math.round(lineupStatus.ageMs / 1000);
      log.info('Pricing', `Declined: lineup change ${ageSec}s ago for ${legLabel} — ${lineupStatus.detail}`);
      priceParlay._lastFailure = {
        reason: 'lineup change',
        detail: `${legLabel}: ${lineupStatus.detail} (${ageSec}s ago, grace window active)`,
        blockerLeg: legDescriptor,
      };
      return null;
    }

    // Pre-compute whether we need Pinnacle line verification for this leg.
    // (The conditional that used to run after getFairProbAsync — moved here so
    // we can fire it in parallel with the fair-prob fetch.)
    let needsVerify = false;
    let verifyCachedLine = null;
    if ((lineInfo.oddsApiMarket === 'spreads' || lineInfo.oddsApiMarket === 'totals') && lineInfo.line != null) {
      const event = oddsFeed.getEventMarkets(
        lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam, lineInfo.startTime
      );
      const cachedLine = event?.markets?.[lineInfo.oddsApiMarket]?.line;
      if (cachedLine != null && Math.abs(Math.abs(cachedLine) - Math.abs(lineInfo.line)) < 0.01) {
        needsVerify = true;
        verifyCachedLine = cachedLine;
      }
    }

    legStates.push({ lineId, lineInfo, legLabel, legDescriptor, needsVerify, verifyCachedLine });
  }

  // Phase 1 complete — captured before Phase 2 dispatches any async work.
  phase1EndMs = performance.now();

  // ------------------- PHASE 2: Per-leg fair probs + line verify ----------------
  // Try sync resolution first. All fair-prob paths EXCEPT getFairProbAsync's
  // alt-line fallback are actually synchronous under the hood (series / MMA /
  // golf / DNB / primary-cache). When every leg resolves sync, we skip the
  // Promise.all scheduling entirely — saves N microtasks per RFQ on the
  // cache-warm happy path. Only fall into async mode if any leg requires
  // an alt-line fetch or a verify-against-Pinnacle call.
  const fairProbs = new Array(legStates.length);
  const verifyResults = new Array(legStates.length).fill(null);
  let pendingAsyncFair = null;     // array of [idx, Promise] for legs needing async fair
  let pendingVerifyIdx = null;     // array of idx for legs needing async verify

  for (let i = 0; i < legStates.length; i++) {
    const s = legStates[i];
    // Seeded book-price override (one-sided HR props): quote the book's posted
    // price + sweetener directly, bypassing de-vig+vig — same mechanism as the
    // series/golf overrides below. fairProb still drives EV/risk weighting.
    if (s.lineInfo && s.lineInfo.bookPriceOverride != null) {
      s.bookPriceOverride = s.lineInfo.bookPriceOverride;
      fairProbs[i] = (s.lineInfo.fairProb != null) ? s.lineInfo.fairProb : s.lineInfo.bookPriceOverride;
      continue;
    }
    // Sync-resolvable fair paths
    const seriesFair = getSeriesFairProb(s.lineInfo);
    if (seriesFair != null) {
      if (typeof seriesFair === 'object') {
        s.bookPriceOverride = seriesFair.bookPriceOverride;
        fairProbs[i] = seriesFair.fairProb;
      } else {
        fairProbs[i] = seriesFair;
      }
      continue;
    }
    const mmaFair = getMmaFairProb(s.lineInfo);
    if (mmaFair != null) { fairProbs[i] = mmaFair; continue; }
    // Golf outrights (win / top 5-10-20 / make cut). Sync cache read — the
    // boards are warmed at line-seed time. Fails CLOSED: a cold/stale board or
    // an unknown player returns null here and the leg declines rather than
    // quoting off nothing. Nesting + YES-only are enforced in shouldDecline.
    // UFC method of victory (KO/TKO/DQ, submission, decision, inside-the-
    // distance). Sync cache read of the DK 6-way board, warmed in the
    // background (the scrape walks one page per fight, ~3-5 min). Fails
    // CLOSED: cold/stale board, unknown fighter, or a partial DK board all
    // return null here and the leg declines rather than quoting off nothing.
    // Same-fight correlation is handled by the SGP gate in shouldDecline —
    // every method pair on one fight is mutually exclusive or nested.
    if (s.lineInfo && MOV_MARKET_TYPES.has(s.lineInfo.marketType)) {
      const hit = ufcMov.getMovFairForLine(s.lineInfo);
      if (hit == null) {
        priceParlay._lastFailure = {
          reason: 'no_fair_value',
          detail: `${s.lineInfo.playerName || '?'} ${s.lineInfo.marketType}:${s.lineInfo.selection} — no fresh DK method board (stale/uncovered fight)`,
          blockerLeg: { team: s.lineInfo.playerName, market: s.lineInfo.marketType, sport: s.lineInfo.sport },
        };
        return null;
      }
      fairProbs[i] = hit.fairProb;   // getMovFairForLine already applied the yes/no side
      continue;
    }
    if (s.lineInfo && s.lineInfo.sport === 'golf_outrights') {
      const hit = golfOutrightFair(s.lineInfo);
      if (hit == null) {
        priceParlay._lastFailure = {
          reason: 'no_fair_value',
          detail: `${s.lineInfo.playerName || '?'} ${s.lineInfo.marketType} — no fresh DataGolf outright board (stale/uncovered player)`,
          blockerLeg: { team: s.lineInfo.playerName, market: s.lineInfo.marketType, sport: 'golf_outrights' },
        };
        return null;
      }
      // NO side (make_cut only — the other markets are blocked in shouldDecline)
      fairProbs[i] = s.lineInfo.selection === 'no' ? (1 - hit.fairProb) : hit.fairProb;
      continue;
    }
    const golfFair = getGolfMatchupFairProb(s.lineInfo);
    if (golfFair != null) {
      // Handle object-form return (carries bookPriceOverride when fair
      // came from Bookmaker manual upload, BetOnline raw, or Bovada raw —
      // see getGolfMatchupFairProb for the precedence ladder).
      if (typeof golfFair === 'object') {
        s.bookPriceOverride = golfFair.bookPriceOverride;
        fairProbs[i] = golfFair.fairProb;
      } else {
        fairProbs[i] = golfFair;
      }
      continue;
    }
    // Golf matchups with no Bookmaker manual / BetOnline / Bovada raw line
    // FALL THROUGH to the generic de-vig consensus path below (getFairProb
    // on the golf_matchups cache). Superseded strict mode (2026-05-19), which
    // declined outright here: that was chosen because tighter-than-book
    // consensus pricing produced -EV fills — but the vigGolfMatchupMin floor
    // (2026-07-19, payout-vig 0.0909 => -110/-110 on a coinflip) now guarantees
    // a real ~7% two-way margin on consensus legs, removing that objection.
    // Strict mode had also silently DROPPED all matchup quoting whenever
    // DataGolf's book coverage thinned: The Open R4 carried BetOnline for only
    // 1 of 42 pairings, so 41/42 parlays declined and golf quoting stopped
    // (2026-07-18 morning). Fatter raw book lines (betcris/betonline/bovada)
    // are still preferred when present via getGolfMatchupFairProb + clampOverride;
    // this is only the fallback when none exists. If consensus is ALSO missing,
    // the standard 'no fair value' decline still fires at the generic path.
    if (s.lineInfo.isDNB) {
      fairProbs[i] = oddsFeed.getDNBFairProb(
        s.lineInfo.oddsApiSport, s.lineInfo.homeTeam, s.lineInfo.awayTeam,
        s.lineInfo.oddsApiSelection, s.lineInfo.startTime
      );
      continue;
    }
    // Player strikeouts (Phase 2). Fair prob was captured at registration
    // time by line-manager via oddsFeed.lookupPlayerStrikeoutProp (sync
    // SharpAPI cache) or lookupPlayerStrikeoutPropFromTheOddsApi (async
    // TOA fallback) and stored on lineInfo.fairProb keyed to selection.
    // The generic getFairProb() below is keyed on home/away game-line
    // markets and returns null for player props, which previously caused
    // Phase-3 to decline with "no player_strikeouts quote in our odds
    // feed" even though lineInfo.fairProb was already populated. Use the
    // cached value directly.
    //
    // Staleness is guarded upstream in shouldDecline rule (c) — anything
    // older than STALE_MS already declined before reaching priceParlay.
    // Player-prop legs (Phase-2 launch types: player_points,
    // player_rebounds, player_assists, player_threes,
    // player_shots_on_goal) AND the original player_strikeouts. All
    // store fair prob on lineInfo at registration time (line-manager
    // calls oddsFeed.lookupTheOddsApiPlayerProp / lookupPlayerStrikeoutProp
    // with the leg's selection-specific over/under value). The generic
    // getFairProb() below is keyed on home/away game-line markets and
    // returns null for player props, so use the cached value directly.
    //
    // Staleness is guarded upstream in shouldDecline — anything older
    // than STALE_MS already declined before reaching priceParlay.
    if (s.lineInfo.marketType && /^player_/.test(s.lineInfo.marketType)) {
      if (s.lineInfo.fairProb != null) {
        fairProbs[i] = s.lineInfo.fairProb;
        continue;
      }
      // fairProb missing — leave fairProbs[i] undefined so Phase 3's
      // null-check fires the standard 'no fair value' decline path.
    }
    // RFI (Run First Inning) — like props, its fair was captured at seed time
    // (line-manager RFI pre-seed via oddsFeed.getRfiFair) and stored on
    // lineInfo.fairProb per side (Over=yesFair, Under=noFair). It has NO odds-
    // cache entry, so use the seeded fair directly; the normal vig pipeline
    // (with the vigRfiMin floor) then prices it. Missing fair → decline.
    if (s.lineInfo.marketType === 'run_first_inning') {
      if (s.lineInfo.fairProb != null) {
        fairProbs[i] = s.lineInfo.fairProb;
        continue;
      }
    }
    // Primary cache fast path — try sync before dispatching async.
    const syncPrimary = oddsFeed.getFairProb(
      s.lineInfo.oddsApiSport,
      s.lineInfo.homeTeam,
      s.lineInfo.awayTeam,
      s.lineInfo.oddsApiMarket,
      s.lineInfo.oddsApiSelection,
      s.lineInfo.line,
      s.lineInfo.startTime
    );
    if (syncPrimary != null) { fairProbs[i] = syncPrimary; continue; }

    // Alt-line sync fast path. When altLinesCache is fresh for this
    // event, fair + sanity checks resolve synchronously — no await, no
    // microtask hop. This restores sub-1ms pricing for cache-hit alt
    // legs. Falls through to async on cache miss/stale so network
    // refetch + non-spread/total market types (h1, team_totals via
    // Bovada) stay covered by getFairProbAsync.
    const syncAlt = oddsFeed.getAltLineFairProbSync(
      s.lineInfo.oddsApiSport,
      s.lineInfo.homeTeam,
      s.lineInfo.awayTeam,
      s.lineInfo.oddsApiMarket,
      s.lineInfo.oddsApiSelection,
      s.lineInfo.line,
      s.lineInfo.startTime
    );
    if (syncAlt != null) { fairProbs[i] = syncAlt; continue; }

    // Missing from both sync paths — fall back to the async path which can fetch
    // alt lines / do event-id resolution / consult Bovada fallback.
    if (!pendingAsyncFair) pendingAsyncFair = [];
    pendingAsyncFair.push([i, oddsFeed.getFairProbAsync(
      s.lineInfo.oddsApiSport,
      s.lineInfo.homeTeam,
      s.lineInfo.awayTeam,
      s.lineInfo.oddsApiMarket,
      s.lineInfo.oddsApiSelection,
      s.lineInfo.line,
      s.lineInfo.startTime
    )]);
  }
  for (let i = 0; i < legStates.length; i++) {
    if (legStates[i].needsVerify) {
      if (!pendingVerifyIdx) pendingVerifyIdx = [];
      pendingVerifyIdx.push(i);
    }
  }

  // ASYNC PATH: only enter when something actually needs async work.
  // Wraps the post-await wire-up + phase-3 call in a .then() so the
  // function still returns the same shape (Promise resolves to result).
  //
  // 2026-05-13: temporary instrumentation — capture how many legs needed
  // async fair-prob fetch vs Pinnacle-verify, and the total await time.
  // Surfaced in stageTimings as price_p2_asyncFairCount / p2_verifyCount /
  // p2_awaitMs so we can drill the 30-55ms tail to the right culprit.
  if (pendingAsyncFair || pendingVerifyIdx) {
    const proms = [];
    if (pendingAsyncFair) {
      for (const [, p] of pendingAsyncFair) proms.push(p);
    }
    if (pendingVerifyIdx) {
      for (const i of pendingVerifyIdx) {
        const s = legStates[i];
        proms.push(oddsFeed.verifyLineWithPinnacle(
          s.lineInfo.oddsApiSport, s.lineInfo.homeTeam, s.lineInfo.awayTeam,
          s.lineInfo.oddsApiMarket, s.verifyCachedLine
        ));
      }
    }
    const _phase2AwaitStart = performance.now();
    const _asyncFairCount = pendingAsyncFair ? pendingAsyncFair.length : 0;
    const _verifyCount = pendingVerifyIdx ? pendingVerifyIdx.length : 0;
    return Promise.all(proms).then(settled => {
      // Stash phase2 await breakdown on the function for caller to pick up.
      priceParlay._lastPhase2Diag = {
        awaitMs: Math.round((performance.now() - _phase2AwaitStart) * 100) / 100,
        asyncFairCount: _asyncFairCount,
        verifyCount: _verifyCount,
      };
      let k = 0;
      if (pendingAsyncFair) {
        for (const [idx] of pendingAsyncFair) fairProbs[idx] = settled[k++];
      }
      if (pendingVerifyIdx) {
        for (const idx of pendingVerifyIdx) verifyResults[idx] = settled[k++];
      }
      return _doPhase3();
    });
  }
  // Sync-only path — no phase2 await happened. Clear the diag so we don't
  // mis-attribute a prior call's slow await to this RFQ.
  priceParlay._lastPhase2Diag = null;
  // SYNC FAST PATH: all leg fair-probs already populated. Call _doPhase3
  // directly and return the result object — NOT a Promise. Caller's
  // sync-or-await branch returns it without microtask overhead.
  return _doPhase3();

  // _doPhase3 is a hoisted function declaration so it can be CALLED above
  // even though it's DECLARED below. JS hoists `function` declarations
  // (not arrow expressions) to the top of the containing scope. Captures
  // every priceParlay local via closure scope (legStates, fairProbs,
  // verifyResults, opts, timing markers, etc.). Body kept at indent
  // level 2 to minimize the diff vs the original phase-3 layout.
  function _doPhase3() {
  // Phase 2 complete — await(s) have resolved; everything below is sync.
  phase2EndMs = performance.now();

  // -------------------- PHASE 3: Post-process results per leg -------------------
  // Per-leg vig bumps surfaced by sub-pricing fallbacks (e.g. tennis
  // totals snap-to-nearest). Indexed by legIdx; defaults to 0 when no
  // bump applies. Read by getEffectiveVig and the per-leg vig output
  // fields below so the snap leak is bounded.
  const legVigBumps = new Array(legStates.length).fill(0);

  for (let legIdx = 0; legIdx < legStates.length; legIdx++) {
    const { lineId, lineInfo, legLabel, legDescriptor, bookPriceOverride } = legStates[legIdx];
    let fairProb = fairProbs[legIdx];
    const verifyResult = verifyResults[legIdx];

    if (lineInfo.isDNB && fairProb != null) {
      log.debug('Pricing', `DNB derived fair prob ${fairProb.toFixed(4)} for ${legLabel}`);
    }

    // LAST-RESORT FALLBACK: tennis totals where the exact line isn't
    // cached but a nearby cached line exists. Books in our feed are
    // sparse on tennis half-points (Pinnacle posts integer totals to
    // avoid pushes; DK/FD post sporadically). Without this, PX's wider
    // line offerings systematically decline as "no fair value." Snap
    // path emits a 3% vig bump that getEffectiveVig honors below; the
    // interpolation path emits 0 bump (math is sound across small gaps).
    if ((fairProb == null || fairProb <= 0 || fairProb >= 1)
        && lineInfo.oddsApiSport === 'tennis'
        && lineInfo.oddsApiMarket === 'totals'
        && (lineInfo.oddsApiSelection === 'over' || lineInfo.oddsApiSelection === 'under')
        && lineInfo.line != null) {
      const snap = oddsFeed.getTennisTotalsFallback(
        lineInfo.homeTeam, lineInfo.awayTeam,
        lineInfo.oddsApiSelection, lineInfo.line
      );
      if (snap && snap.fairProb != null && snap.fairProb > 0 && snap.fairProb < 1) {
        fairProb = snap.fairProb;
        fairProbs[legIdx] = snap.fairProb;
        legVigBumps[legIdx] = snap.vigBump || 0;
      }
    }

    // Strict guard. Includes !Number.isFinite to catch NaN/Infinity — NaN
    // compares false against every numeric operator, so without this it
    // silently propagates through fairParlayProb *= fairProb, stores as
    // null in Supabase, and surfaces as fair=0.000 in the dashboard
    // (which is what the 5 unaccounted-for losing parlays from the
    // 5-6 leg audit had). Declining here is the right thing — a NaN
    // fair prob is a pricing-pipeline failure, not a legitimate quote.
    if (fairProb == null || !Number.isFinite(fairProb) || fairProb <= 0 || fairProb >= 1) {
      log.debug('Pricing', `Declined: no fair value for ${lineInfo.teamName} ${lineInfo.marketType} (fairProb=${fairProb})`);
      priceParlay._lastFailure = {
        reason: 'no fair value',
        detail: `no ${lineInfo.oddsApiMarket || lineInfo.marketType} quote for ${legLabel} in our odds feed`,
        blockerLeg: legDescriptor,
      };
      return null;
    }

    // Look up sportsbook raw odds for this leg. Pass lineInfo.line so the
    // accessor can reject cached values that belong to a different line
    // (e.g. Arsenal -1.25 when the PX RFQ wanted Arsenal -1). Returning null
    // on mismatch is safer than reporting the primary-line book odds and
    // corrupting the dashboard's competitor comparison.
    const pinnacleOdds = oddsFeed.getPinnacleOdds(
      lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
      lineInfo.oddsApiMarket, lineInfo.oddsApiSelection, lineInfo.startTime, lineInfo.line
    );
    const fanduelOdds = oddsFeed.getFanDuelOdds(
      lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
      lineInfo.oddsApiMarket, lineInfo.oddsApiSelection, lineInfo.startTime, lineInfo.line
    );
    const kalshiOdds = oddsFeed.getKalshiOdds(
      lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
      lineInfo.oddsApiMarket, lineInfo.oddsApiSelection, lineInfo.startTime, lineInfo.line
    );
    const draftkingsOdds = oddsFeed.getDraftKingsOdds(
      lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
      lineInfo.oddsApiMarket, lineInfo.oddsApiSelection, lineInfo.startTime, lineInfo.line
    );

    // For DNB (Draw No Bet) legs, also fetch the opposite-side book odds so
    // we can compute DNB-adjusted per-book implied probs. The raw book home
    // implied from a 3-way soccer market is NOT the DNB implied — it must be
    // renormalized as pinHome / (pinHome + pinAway). Without this, the
    // dashboard's Pinnacle/DK parlay columns compound raw 3-way home probs,
    // producing a misleading apples-to-oranges comparison with our DNB offer.
    let pinnacleDNBProb = null;
    let fanduelDNBProb = null;
    let kalshiDNBProb = null;
    let draftkingsDNBProb = null;
    // Compute DNB-renormalized book probs for ANY soccer h2h leg, not
    // just legs explicitly flagged isDNB. PX's soccer moneyline market
    // is universally 2-way (Draw No Bet) on the bet semantics, but the
    // line-manager's regex for setting isDNB only fires when PX names
    // the market with explicit "2 Way" / "DNB" / "Draw No Bet" tokens.
    // Some PX events label it just "Moneyline" — those legs end up
    // unflagged, books return raw 3-way (home win only) probs, and the
    // dashboard's parlay-vs-books compound becomes apples-to-oranges
    // (DNB our offer vs 3-way book prices), inflating the
    // pp-distance into bogus -90% edge values. By always renormalizing
    // for soccer, we guarantee the comparison stays 2-way both sides.
    const isSoccerH2h = lineInfo.oddsApiMarket === 'h2h'
      && typeof lineInfo.oddsApiSport === 'string'
      && lineInfo.oddsApiSport.startsWith('soccer');
    if ((lineInfo.isDNB || isSoccerH2h) && lineInfo.oddsApiMarket === 'h2h') {
      const oppSel = lineInfo.oddsApiSelection === 'home' ? 'away' : 'home';
      function calcDNB(sameOdds, oppOdds) {
        if (sameOdds == null || oppOdds == null) return null;
        const pSame = oddsFeed.americanToImpliedProb(sameOdds);
        const pOpp = oddsFeed.americanToImpliedProb(oppOdds);
        const sum = pSame + pOpp;
        return sum > 0 ? pSame / sum : null;
      }
      const pinOpp = oddsFeed.getPinnacleOdds(
        lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
        'h2h', oppSel, lineInfo.startTime
      );
      const fdOpp = oddsFeed.getFanDuelOdds(
        lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
        'h2h', oppSel, lineInfo.startTime
      );
      const klOpp = oddsFeed.getKalshiOdds(
        lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
        'h2h', oppSel, lineInfo.startTime
      );
      const dkOpp = oddsFeed.getDraftKingsOdds(
        lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
        'h2h', oppSel, lineInfo.startTime
      );
      pinnacleDNBProb = calcDNB(pinnacleOdds, pinOpp);
      fanduelDNBProb = calcDNB(fanduelOdds, fdOpp);
      kalshiDNBProb = calcDNB(kalshiOdds, klOpp);
      draftkingsDNBProb = calcDNB(draftkingsOdds, dkOpp);
    }

    // Require a valid fair probability — if we have one, sportsbook data exists
    // (fair prob is built from de-vigged consensus of all available books).
    // Previously required specifically Pinnacle or FanDuel, but with 25 books
    // from SharpAPI, any book's data in the consensus is sufficient.
    // The fairProb null check above already catches truly blind legs.

    // Spread/total line verification: check result from Phase 2. When the
    // requested line matches our cached primary, verifyLineWithPinnacle
    // confirms the line hasn't moved. Prevents pricing stale alt-spreads
    // at primary-spread odds.
    if (verifyResult && !verifyResult.ok) {
      log.info('Pricing', `Declined: spread line moved for ${legLabel} (cached ${legStates[legIdx].verifyCachedLine}, Pinnacle now ${verifyResult.currentLine})`);
      priceParlay._lastFailure = {
        reason: 'spread line moved',
        detail: `${legLabel}: cached line ${legStates[legIdx].verifyCachedLine} but Pinnacle now ${verifyResult.currentLine} (moved ${verifyResult.diff.toFixed(1)}pts)`,
        blockerLeg: legDescriptor,
      };
      return null;
    }

    // Get de-vigged consensus fair prob for display (separate from pricing fairProb)
    const displayFairProb = oddsFeed.getDisplayFairProb(
      lineInfo.oddsApiSport, lineInfo.homeTeam, lineInfo.awayTeam,
      lineInfo.oddsApiMarket, lineInfo.oddsApiSelection,
      lineInfo.line != null ? Math.abs(lineInfo.line) : null,
      lineInfo.startTime
    );

    // Anomalous-fair guard. Safety net in case a feed-shape edge case
    // sneaks past getBookPairsForTotals. If our de-vigged fair sits far
    // from the simple book consensus (mean of Pin/DK/FD implied probs),
    // decline rather than risk a mispriced offer. Scoped to total /
    // run_line markets — where the Apr-24 CLE @ TOR bug lived — and
    // skipped when fewer than 2 books are available (consensus isn't
    // meaningful). Not applied to DNB legs: raw 3-way americanToProb
    // isn't directly comparable to our DNB-adjusted fair.
    if (
      config.pricing.declineAnomalousTotalsEnabled &&
      bookPriceOverride == null && // overrides are intentional and trusted
      !lineInfo.isDNB &&
      (lineInfo.marketType === 'total' || lineInfo.marketType === 'run_line')
    ) {
      const books = [pinnacleOdds, fanduelOdds, draftkingsOdds]
        .map(o => (o != null ? oddsFeed.americanToImpliedProb(o) : null))
        .filter(p => p != null && p > 0 && p < 1);
      if (books.length >= 2) {
        const consensus = books.reduce((s, p) => s + p, 0) / books.length;
        const dev = Math.abs(fairProb - consensus);
        const threshold = config.pricing.declineAnomalousTotalsThreshold || 0.10;
        if (dev > threshold) {
          log.warn('Pricing', `Declined: anomalous fair ${(fairProb * 100).toFixed(1)}% vs book consensus ${(consensus * 100).toFixed(1)}% (dev ${(dev * 100).toFixed(1)}pp > ${(threshold * 100).toFixed(1)}pp) — ${legLabel}`);
          priceParlay._lastFailure = {
            reason: 'anomalous fair vs book consensus',
            detail: `${legLabel}: fair ${(fairProb * 100).toFixed(1)}% deviates ${(dev * 100).toFixed(1)}pp from book consensus ${(consensus * 100).toFixed(1)}% (${books.length} books)`,
            blockerLeg: legDescriptor,
          };
          return null;
        }
      }
    }

    // Moneyline anomaly check — same pattern as the totals/run_line check
    // above but scoped to game-line moneylines (not DNB; not series_winner;
    // not player_*). Catches the staleness scenario operator caught on
    // 2026-05-02 ATL @ COL: our cached fair-implied was 61.1% (-162) while
    // DK had moved to -219 (68.7% implied) on late lineup news. Cache age
    // alone (under STALE_PRICE_MINUTES) doesn't catch this — the move
    // happens within the threshold but our consensus is built from a
    // delayed feed. A book-consensus deviation gate is the right safety
    // net: if our fair drifts more than declineAnomalousMoneylineThreshold
    // from the average of available book-implied probs, decline rather
    // than offer a stale price the bettor can scoop.
    if (
      config.pricing.declineAnomalousMoneylineEnabled &&
      bookPriceOverride == null &&
      !lineInfo.isDNB &&
      lineInfo.marketType === 'moneyline' &&
      lineInfo.oddsApiMarket === 'h2h'
    ) {
      const books = [pinnacleOdds, fanduelOdds, draftkingsOdds]
        .map(o => (o != null ? oddsFeed.americanToImpliedProb(o) : null))
        .filter(p => p != null && p > 0 && p < 1);
      if (books.length >= 2) {
        const consensus = books.reduce((s, p) => s + p, 0) / books.length;
        const dev = Math.abs(fairProb - consensus);
        const threshold = config.pricing.declineAnomalousMoneylineThreshold || 0.05;
        if (dev > threshold) {
          log.warn('Pricing', `Declined: anomalous ML fair ${(fairProb * 100).toFixed(1)}% vs book consensus ${(consensus * 100).toFixed(1)}% (dev ${(dev * 100).toFixed(1)}pp > ${(threshold * 100).toFixed(1)}pp) — ${legLabel}`);
          priceParlay._lastFailure = {
            reason: 'anomalous fair vs book consensus',
            detail: `${legLabel} moneyline: fair ${(fairProb * 100).toFixed(1)}% deviates ${(dev * 100).toFixed(1)}pp from book consensus ${(consensus * 100).toFixed(1)}% (${books.length} books)`,
            blockerLeg: legDescriptor,
          };
          return null;
        }
      }
    }

    // Operator-pinned manual line-odds override. When set, the leg's
    // offered prob is the implied-prob of the operator's American odds,
    // bypassing the model's fair × vig (same plumbing as the NBA-series
    // bookPriceOverride). Operator override always wins over any prior
    // bookPriceOverride from the fair-prob lookups (e.g., NBA heavy fav).
    let effectiveBookPriceOverride = bookPriceOverride != null ? bookPriceOverride : null;
    let manualOddsApplied = null;
    const manualAm = lineManager.getManualLineOdds(lineId);
    if (manualAm != null && Number.isFinite(manualAm) && manualAm !== 0) {
      // SP perspective: stored override IS what we offer (operator-set
      // American odds). Convert to implied prob for parlay compounding.
      const absAm = Math.abs(manualAm);
      const implied = manualAm > 0 ? 100 / (manualAm + 100) : absAm / (absAm + 100);
      if (implied > 0 && implied < 1) {
        effectiveBookPriceOverride = implied;
        manualOddsApplied = manualAm;
        log.info('Pricing', `Manual override applied to line ${lineId}: offered ${manualAm} (implied ${implied.toFixed(4)})`);
      }
    }

    // Per-prop-type-per-side fair CALIBRATION. De-vig inherits the books'
    // favourite-longshot shading, so some prop legs are systematically
    // mispriced (HR-over: our fair 21.2% vs realised 16.3%, z=-3.62 on 930
    // unique legs). A measured multiplier corrects the leg's fairProb before it
    // compounds. Off unless config.pricing.propFairCalibration has the key.
    // Skipped for bookPriceOverride legs (we quote the book number directly
    // there) and only touches genuine prob fairs.
    const calibMap = config.pricing.propFairCalibration;
    if (calibMap && effectiveBookPriceOverride == null
        && fairProb != null && fairProb > 0 && fairProb < 1
        && lineInfo.marketType && lineInfo.oddsApiSelection) {
      const mult = calibMap[`${lineInfo.marketType}.${String(lineInfo.oddsApiSelection).toLowerCase()}`];
      if (mult != null && mult !== 1) {
        const adj = Math.min(0.999, Math.max(0.0001, fairProb * mult));
        if (adj !== fairProb) {
          propFairCalibs.push({ leg: legLabel, from: Math.round(fairProb * 10000) / 10000, to: Math.round(adj * 10000) / 10000, mult });
          fairProb = adj;
        }
      }
    }

    pricedLegs.push({
      lineId,
      lineInfo,
      fairProb,
      bookPriceOverride: effectiveBookPriceOverride,
      manualOddsApplied,
      vigBump: legVigBumps[legIdx] || 0,
      displayFairProb,
      pinnacleOdds,
      fanduelOdds,
      kalshiOdds,
      draftkingsOdds,
      pinnacleDNBProb,
      fanduelDNBProb,
      kalshiDNBProb,
      draftkingsDNBProb,
    });

    fairParlayProb *= fairProb;
  }

  // Sanity check — if fair parlay prob is extremely small OR not finite,
  // decline. !Number.isFinite catches NaN that may have leaked in from
  // a leg whose fairProb was NaN (the per-leg guard catches this too, but
  // defense in depth here is cheap — NaN comparisons are always false so
  // without the explicit finite check it would silently slip through this
  // sub-0.001 guard as well).
  // All-MoV parlays get a far lower probability floor (operator directive
  // 2026-07-17: no odds-range limits on method-of-victory parlays). Method YES
  // prices are longshots by nature — two deep tails on one card (+2800 KO x
  // +1800 KO) combine to 0.067%, which the 0.1% floor refused. Only when EVERY
  // leg is MoV, so a method leg can't drag a mixed parlay under the floor.
  // The NaN check below is NEVER relaxed: a non-finite prob is a pipeline
  // failure, not a longshot, and must always decline.
  const _movOnlyProbFloor = pricedLegs.length > 0
    && pricedLegs.every(l => l.lineInfo && MOV_MARKET_TYPES.has(l.lineInfo.marketType));
  const _minParlayProb = _movOnlyProbFloor
    ? (Number(process.env.MOV_MIN_PARLAY_PROB) || 0.000001)
    : 0.001;
  if (!Number.isFinite(fairParlayProb) || fairParlayProb < _minParlayProb) {
    log.debug('Pricing', `Declined: fair parlay prob invalid (${fairParlayProb})`);
    priceParlay._lastFailure = {
      reason: 'parlay too unlikely',
      detail: Number.isFinite(fairParlayProb)
        ? `combined fair prob ${(fairParlayProb * 100).toFixed(4)}% < ${(_minParlayProb * 100).toFixed(4)}% threshold`
        : `combined fair prob non-finite (${fairParlayProb}) — pricing pipeline failure`,
      blockerLeg: null,
    };
    return null;
  }

  // Detect SGP early (any pxEventId shared by 2+ legs). Used below to
  // widen per-leg vig for same-game parlays (compensates for positive
  // correlation that independent-multiplication fair ignores). SGP is
  // permitted here only for the combos that shouldDecline already
  // allow-listed — this is just the pricing-side amplifier.
  const _eventCounts = {};
  for (const pl of pricedLegs) {
    const eid = pl.lineInfo.pxEventId;
    if (!eid) continue;
    // Golf outrights share a pxEventId across the WHOLE FIELD (one PX event per
    // market holds all 156 players), so they are never "same game". Counting
    // them here would apply the SGP vig amplifier + correlation factor to two
    // unrelated players. Mirrors the identical exemption in shouldDecline's
    // byEvent grouping — keep the two in lockstep.
    if (pl.lineInfo.sport === 'golf_outrights') continue;
    _eventCounts[eid] = (_eventCounts[eid] || 0) + 1;
  }
  const isSGPParlay = Object.values(_eventCounts).some(c => c >= 2);

  // ---- NESTED IMPLICATION DETECTION (SGP roadmap Stage 1) ----
  // Re-derived from LEG SHAPE (never from opts) so the confirm-path
  // reprice — which calls priceParlay(legs) with no opts — computes the
  // identical fair prob (confirm-symmetry invariant). For each detected
  // pair, the exact joint is P(strong leg): expressed as a fair multiplier
  // of 1/p_weak, applied to fairParlayProb below and folded into
  // sgpFairMultiplier so vigFair + per-leg alignment mirror it.
  // TWO multipliers per pair (adversarial-review fix): the FAIR side always
  // divides out the weak leg's fairProb (joint fair = P(strong) exactly).
  // The OFFERED side must divide out the weak leg's actual contribution to
  // the offered product — bookPriceOverride when the leg is a book-mirror
  // leg (WC props, MLB HR binaries), else fairProb. Without the split, a
  // both-override pair priced at override_strong × (1−sweetener)(1+overround)
  // ≈ 7% short of the intended exact mirror(strong) — conservative, but not
  // the advertised exact price, and dependent on unrelated env knobs.
  let nestedFairMultiplier = 1;
  let nestedOfferedMultiplier = 1;
  let nestedPairCount = 0;
  // Hoisted so the same-direction prop fallback (Stage 2.5) can skip the legs
  // the nested + xteam passes already consumed (avoids double-counting).
  const _sgpNestedUsed = new Set();
  const _sgpXteamUsed = new Set();
  if (isSGPParlay) {
    const usedIdx = _sgpNestedUsed;
    for (let i = 0; i < pricedLegs.length; i++) {
      if (usedIdx.has(i)) continue;
      for (let j = i + 1; j < pricedLegs.length; j++) {
        if (usedIdx.has(j)) continue;
        const m = matchNestedPair(pricedLegs[i].lineInfo, pricedLegs[j].lineInfo);
        if (!m) continue;
        const strongLeg = (m.strong === pricedLegs[i].lineInfo) ? pricedLegs[i] : pricedLegs[j];
        const weakLeg = (m.strong === pricedLegs[i].lineInfo) ? pricedLegs[j] : pricedLegs[i];
        // Feed-consistency guard: implication forces P(strong) ≤ P(weak).
        // Books inverted by more than 8pp = a feed is wrong — fail closed
        // rather than quote on bad data. (Small inversions are tolerated
        // and resolve conservatively: collapsing divides out p_weak, so a
        // too-low p_weak SHORTENS our quote — the safe direction.)
        if (strongLeg.fairProb > weakLeg.fairProb + 0.08) {
          log.warn('Pricing', `Nested pair feed inconsistency: P(${strongLeg.lineInfo.propType} ${strongLeg.lineInfo.line})=${(strongLeg.fairProb * 100).toFixed(1)}% > P(${weakLeg.lineInfo.propType} ${weakLeg.lineInfo.line})=${(weakLeg.fairProb * 100).toFixed(1)}% + 8pp for ${strongLeg.lineInfo.playerName} — declining`);
          priceParlay._lastFailure = {
            reason: 'nested pair inconsistent',
            detail: `implication violated by feed: strong ${(strongLeg.fairProb * 100).toFixed(1)}% > weak ${(weakLeg.fairProb * 100).toFixed(1)}% + 8pp (${strongLeg.lineInfo.playerName})`,
            blockerLeg: { team: strongLeg.lineInfo.teamName, market: strongLeg.lineInfo.marketType, line: strongLeg.lineInfo.line, sport: strongLeg.lineInfo.sport },
          };
          return null;
        }
        const weakOfferedContribution = (weakLeg.bookPriceOverride != null && weakLeg.bookPriceOverride > 0 && weakLeg.bookPriceOverride < 1)
          ? weakLeg.bookPriceOverride
          : weakLeg.fairProb;
        if (weakLeg.fairProb > 0 && weakLeg.fairProb < 1 && weakOfferedContribution > 0 && weakOfferedContribution < 1) {
          nestedFairMultiplier *= 1 / weakLeg.fairProb;
          nestedOfferedMultiplier *= 1 / weakOfferedContribution;
          nestedPairCount++;
          usedIdx.add(i); usedIdx.add(j);
          break;
        }
      }
    }
  }

  // ---- CROSS-TEAM PAIR DETECTION (SGP roadmap Stage 2) ----
  // Re-derived from LEG SHAPE (roster-resolved sides, never opts) so the
  // confirm-path reprice computes the identical fair prob. Additive
  // band-top: jointFair = min(p1·p2 + φmax·√(p1q1·p2q2), min(p1,p2)).
  // Additive because correlation lift is additive in probability — a flat
  // multiplicative boost undercovers low-probability pairs (MLB HR+HR, the
  // #1 demand shape) by >10×. Band-top because selection pins realized
  // dependence at the top of the band: sharps request the linked pairs, so
  // φmax is the no-regret price under a public pricing grid.
  // Expressed as a single multiplier folded into fairParlayProb AND
  // sgpFairMultiplier; standard doubled SGP leg vig stays ON (the roadmap's
  // 6%/leg). Book-mirror legs come out slightly MORE conservative (their
  // offered contribution carries the book margin too) — acceptable
  // direction for a small-test class.
  let xteamFairMultiplier = 1;
  let xteamPairCount = 0;
  if (isSGPParlay) {
    const usedX = _sgpXteamUsed;
    for (let i = 0; i < pricedLegs.length; i++) {
      if (usedX.has(i)) continue;
      for (let j = i + 1; j < pricedLegs.length; j++) {
        if (usedX.has(j)) continue;
        if (!matchXTeamPair(pricedLegs[i].lineInfo, pricedLegs[j].lineInfo)) continue;
        const p1 = pricedLegs[i].fairProb, p2 = pricedLegs[j].fairProb;
        if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1)) continue;
        // Number.isFinite (not ||): an explicit SGP_PROP_XTEAM_PHI_MAX=0
        // must mean zero lift, not re-default to 0.15 (review fix).
        const phiRaw = config.pricing.sgpPropXTeamPhiMax;
        const phi = Math.max(0, Number.isFinite(phiRaw) ? phiRaw : 0.15);
        const naive = p1 * p2;
        const jointFair = Math.min(naive + phi * Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2)), Math.min(p1, p2));
        if (jointFair > naive) xteamFairMultiplier *= jointFair / naive;
        xteamPairCount++;
        usedX.add(i); usedX.add(j);
        break;
      }
    }
    if (xteamFairMultiplier !== 1) {
      const before = fairParlayProb;
      fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * xteamFairMultiplier));
      log.debug('Pricing', `XTeam band-top lift (${xteamPairCount} pair${xteamPairCount > 1 ? 's' : ''}) — fair ${(before * 100).toFixed(2)}% × ${xteamFairMultiplier.toFixed(4)} = ${(fairParlayProb * 100).toFixed(2)}%`);
    }
  }

  // ---- SAME-GAME SAME-DIRECTION PROP FALLBACK (SGP roadmap Stage 2.5) ----
  // The xteam pass (Stage 2) only lifts prop pairs it can roster-resolve to
  // OPPOSING teams; K-props are excluded from it, and any pair whose players
  // don't resolve (incomplete rosters — WNBA especially) falls through to the
  // NAIVE INDEPENDENT product. That fail-OPEN is the leak a prop-SGP sharp
  // exploited (2026-07): same-game K-Under+K-Under and points-Over+points-Over
  // quoted with ZERO correlation, ~5pp too generous. Any two same-game props on
  // the SAME side (both Over / both Under) are positively correlated through the
  // shared game script, so we apply the same additive band-top the xteam pass
  // uses — but to EVERY such pair the precise passes didn't consume, and
  // roster-INDEPENDENTLY so it holds when identity resolution fails. Leg-shape-
  // derived (no opts) so the confirm reprice computes the identical fair
  // (confirm-symmetry invariant). Same-direction only: mixed Over/Under is left
  // independent (negative-corr there already prices conservatively for us).
  let propSameGameFallbackMultiplier = 1;
  let propSameGameFallbackPairs = 0;
  if (isSGPParlay) {
    const phiRaw = config.pricing.sgpPropSameGamePhiFloor;
    const phiFloor = Math.max(0, Number.isFinite(phiRaw) ? phiRaw : 0.10);
    // Run when the pooled floor is on OR any per-family key is set — a family
    // key must still bind when the operator zeroes the pooled floor.
    if (phiFloor > 0 || Object.keys(config.pricing.sgpPhiByFamily || {}).length > 0) {
      const isProp = li => /^player_/.test(li.marketType || '');
      const sideOf = li => String(li.oddsApiSelection || li.selection || '').toLowerCase();
      const consumed = new Set([..._sgpNestedUsed, ..._sgpXteamUsed]);
      // A game TOTAL is a valid same-direction partner for a prop: one player's
      // Over is positively correlated with the GAME total Over (he's a component
      // of it). Include totals ONLY in events with no spread/ml leg, so we never
      // double-count the spread_total / ml_total combo factor (which owns those
      // mixed events). Team totals are excluded (their direction relative to the
      // player needs roster resolution — the thing this fallback exists to avoid
      // depending on).
      const eventMkts = {};
      for (const pl of pricedLegs) {
        const li = pl.lineInfo; if (li.pxEventId == null) continue;
        (eventMkts[li.pxEventId] || (eventMkts[li.pxEventId] = new Set())).add(li.marketType);
      }
      const eventHasSpreadOrMl = ev => { const s = eventMkts[ev]; return !!(s && (s.has('spread') || s.has('moneyline'))); };
      const eligible = li => isProp(li) || (li.marketType === 'total' && !eventHasSpreadOrMl(li.pxEventId));
      // Cluster the unconsumed eligible legs by (game, direction). Greedy
      // disjoint PAIRING undercounts a 3+ same-side stack — it lifts one pair and
      // drops the odd leg, yet a 3-Over stack in one game is MORE correlated than
      // any single pair (the exact blow-up shape this guards against). Compound
      // the band-top across each cluster (N-1 chained links) so the lift grows
      // with stack size. Clusters must be anchored by >=1 PROP leg (a bare
      // total+total alt-line pair is nested-implication territory, handled
      // above). Deterministic (leg order) → confirm-symmetric.
      const clusters = {};
      for (let i = 0; i < pricedLegs.length; i++) {
        if (consumed.has(i)) continue;
        const li = pricedLegs[i].lineInfo;
        if (!eligible(li)) continue;
        const side = sideOf(li);
        if (side !== 'over' && side !== 'under') continue; // same-direction class only
        const p = pricedLegs[i].fairProb;
        if (!(p > 0 && p < 1)) continue;
        if (li.pxEventId == null) continue;
        const key = li.pxEventId + '|' + side;
        const c = clusters[key] || (clusters[key] = { ps: [], fams: [], hasProp: false });
        c.ps.push(p);
        c.fams.push(sgpPropFamily(li));
        if (isProp(li)) c.hasProp = true;
      }
      // Per-family phi: correlation is prop-family-specific (batter composites
      // ride the game script far harder than strikeouts), so each consecutive
      // pair looks up its sorted family-pair key in sgpPhiByFamily and falls
      // back to the pooled floor when unkeyed. Empty map = pooled behavior,
      // byte-identical to before. Calibrate keys with scripts/dk-sgp-phi.js.
      const phiByFamily = config.pricing.sgpPhiByFamily || {};
      for (const key of Object.keys(clusters)) {
        const c = clusters[key];
        if (c.ps.length < 2 || !c.hasProp) continue; // same-game same-side pair, prop-anchored
        for (let k = 1; k < c.ps.length; k++) {
          const p1 = c.ps[k - 1], p2 = c.ps[k];
          const famKey = [c.fams[k - 1], c.fams[k]].sort().join('_');
          const pairPhi = Number.isFinite(phiByFamily[famKey]) ? phiByFamily[famKey] : phiFloor;
          if (pairPhi <= 0) continue;
          const naive = p1 * p2;
          const jointFair = Math.min(naive + pairPhi * Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2)), Math.min(p1, p2));
          if (jointFair > naive) propSameGameFallbackMultiplier *= jointFair / naive;
        }
        propSameGameFallbackPairs += c.ps.length - 1;
      }
      if (propSameGameFallbackMultiplier !== 1) {
        const before = fairParlayProb;
        fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * propSameGameFallbackMultiplier));
        log.debug('Pricing', `Same-game same-dir prop fallback (${propSameGameFallbackPairs} pair${propSameGameFallbackPairs > 1 ? 's' : ''}, φ=${phiFloor}) — fair ${(before * 100).toFixed(2)}% × ${propSameGameFallbackMultiplier.toFixed(4)} = ${(fairParlayProb * 100).toFixed(2)}%`);
      }
    }
  }

  // SGP vig-multiplier suppression:
  // - prop_nested pairs price EXACTLY (joint = strong leg) — the doubled
  //   SGP vig exists to cover correlation UNCERTAINTY, of which these have
  //   none. Detected from leg shape (confirm-symmetric). The weak leg's
  //   normal per-leg vig still applies, making the quote slightly shorter
  //   than a pure single-leg price — conservative by design.
  // - kprop_kprop's old suppression is REMOVED (SGP roadmap Stage 0):
  //   opposing-pitcher Ks share umpire zone, park K-factor, and weather —
  //   the same common factors the SGP vig is there to cover. Leaving a
  //   known-looser carve-out live hands attackers a preferred template.
  //   (xteam pairs likewise keep the doubled vig — band-top covers the
  //   dependence, vig covers the rest.)
  const skipSgpVig = nestedPairCount > 0;
  const sgpVigMult = (isSGPParlay && !skipSgpVig)
    ? Math.max(1, config.pricing.sgpVigMultiplier || 1)
    : 1;
  // Prop legs get their own SGP vig multiplier so we can quote K-prop /
  // prop-prop same-game tickets competitively without loosening game-line
  // SGPs. Falls back to sgpVigMult when SGP_PROP_VIG_MULTIPLIER is unset.
  const sgpPropVigMult = (isSGPParlay && !skipSgpVig)
    ? Math.max(1, config.pricing.sgpPropVigMultiplier || config.pricing.sgpVigMultiplier || 1)
    : 1;

  // ---- SGP CORRELATION ADJUSTMENT ----
  // The naive product of fair leg probs understates the true joint prob
  // for positively-correlated spread+total pairs. We apply an UPWARD
  // multiplier to fairParlayProb BEFORE vig is computed, which shortens
  // offered odds — matching how real books price SGPs.
  //
  // POLICY CHANGE 2026-04-22: previously we had a direction classifier
  // that applied ×1.15 for "positive" combos (minus+over, plus+under)
  // and ×0.90 for "negative" combos (minus+under, plus+over). Empirical
  // check against a DK SGP reference (OKC -16.5 + Under 216.5) showed
  // the direction classifier gets the sign WRONG for large-spread NBA
  // blowouts: the "fav + under" case is actually POSITIVELY correlated
  // there (starter rest in 4th quarter → pace slows → under hits), yet
  // our code was shrinking fair by 0.90, pushing offered odds longer
  // and leaking EV to bettors. DK's +228 vs our naive-compound-derived
  // +263 on that parlay was a ~35-cent underpricing in the bettor's
  // favor.
  //
  // New policy: treat ALL spread_total SGPs as positively correlated
  // (always widen fair, always shorten offered). Empirically books
  // almost always charge more on SGPs than naive product, regardless
  // of theoretical sign. Safer default — worst case we're slightly
  // tight on the small minority of truly negatively-correlated pairs
  // and lose those fills, which is strictly better than settling
  // EV-negative on the positively-correlated ones we've been mispricing.
  //
  // sgpCorrelationNegative is no longer consulted but kept in config
  // for potential future use (e.g., restoring direction logic once
  // per-sport/per-spread-magnitude rules are calibrated).
  //
  // Only applies to 2-leg spread_total SGPs — the only combo currently
  // in SGP_ALLOWED_COMBOS. ml_total was briefly added + reverted on
  // 2026-04-22 (operator concern that ml_total correlation is stronger
  // than our flat 1.08 factor captures — would risk EV leak until we
  // add per-combo tuning). If ml_total is re-enabled later, extend the
  // combo check here and consider a dedicated correlation factor.
  let sgpCorrelationFactor = 1;
  let sgpCorrelationCombo = null; // 'spread_total' | 'ml_total' | null
  // Detect SGP components (events with exactly 2 legs that form a known
  // correlated combo). Previously gated to `pricedLegs.length === 2`,
  // which excluded any multi-leg parlay that contained a 2-leg SGP
  // component on a single event (e.g. a 5-leg parlay with Cavs ML +
  // CLE@DET Over 216 sharing pxEventId 20023799). For those, the
  // correlation factor never applied, so fairParlayProb was the naive
  // product — overstating displayed Theo Edge by ~9pp on the example
  // parlay 019e0334-… (2026-05-07) and the EV $ by ~6×.
  //
  // New policy: detect SGP components in any-length parlay. Apply the
  // per-combo correlation factor MULTIPLICATIVELY across all detected
  // components (independent SGPs on different events compound).
  if (isSGPParlay) {
    const eventLegs = {};
    for (const l of pricedLegs) {
      const eid = l.lineInfo.pxEventId;
      if (!eid) continue;
      if (!eventLegs[eid]) eventLegs[eid] = [];
      eventLegs[eid].push(l);
    }
    const byCombo = config.pricing.sgpCorrelationByCombo || {};
    const by3Plus = config.pricing.sgpCorrelation3PlusByCombo || {};
    const detectedCombos = [];

    // Build a sorted market signature for an event's leg set. Used both
    // for direct 2-leg combo lookups (e.g. 'ml_total') and for the 3+leg
    // signature lookups (e.g. 'ml_spread_total', 'ml_total_total' for
    // 2 alt totals + ml).
    function comboSignature(legs) {
      const parts = legs.map(l => {
        const mt = l.lineInfo.marketType;
        if (mt === 'moneyline') return 'ml';
        if (mt === 'spread') return 'spread';
        if (mt === 'total') return 'total';
        return mt; // pass through anything we don't normalize (e.g. team_total)
      }).sort();
      return parts.join('_');
    }

    for (const legs of Object.values(eventLegs)) {
      let combo = null;
      let factor = 1;

      if (legs.length === 2) {
        // 2-leg path — legacy combo names ('ml_total','spread_total').
        // For spread_total, also detect the directional sub-combo
        // (fav+over, dog+under, fav+under, dog+over) so the per-direction
        // factor can apply if configured. FD calibration 2026-05-07
        // showed factor ranges from 1.02 (dog+under) to 1.30 (fav+over)
        // — single-value spread_total can't capture that spread, so a
        // directional key wins the lookup if present, falling back to
        // the un-directed 'spread_total' value otherwise.
        let spreadLeg = null, totalLeg = null, mlLeg = null;
        for (const l of legs) {
          const mt = l.lineInfo.marketType;
          if (mt === 'spread') spreadLeg = l;
          else if (mt === 'total') totalLeg = l;
          else if (mt === 'moneyline') mlLeg = l;
        }
        if (spreadLeg && totalLeg) {
          combo = 'spread_total';
          // Directional key: spread_<favOrDog>_<overOrUnder>.
          //   spreadLeg.lineInfo.line < 0 → bettor's side is favorite
          //   totalLeg.lineInfo.selection 'over'/'under' → which side of total
          const spreadLine = Number(spreadLeg.lineInfo.line);
          const totalSel = String(totalLeg.lineInfo.selection || totalLeg.lineInfo.oddsApiSelection || '').toLowerCase();
          if (Number.isFinite(spreadLine) && spreadLine !== 0 && (totalSel === 'over' || totalSel === 'under')) {
            const sd = spreadLine < 0 ? 'fav' : 'dog';
            const td = totalSel; // 'over' or 'under'
            const directional = `spread_${sd}_${td}`;
            if (byCombo[directional] != null) {
              factor = byCombo[directional];
              combo = directional; // metadata reflects what actually applied
            }
          }
        } else if (mlLeg && totalLeg) {
          combo = 'ml_total';
        }
        if (!combo) continue;
        // Fall back to un-directed factor when no directional key matched.
        if (factor === 1) {
          if (byCombo[combo] != null) factor = byCombo[combo];
          else if (combo === 'spread_total') factor = config.pricing.sgpCorrelationPositive || 1;
        }
      } else if (legs.length >= 3) {
        // 3+ legs same-event — previously got NO correlation discount.
        // Build a sorted market signature and look up in the 3+ map;
        // falls back to 'default' for unrecognized combos.
        combo = comboSignature(legs);
        if (by3Plus[combo] != null) {
          factor = by3Plus[combo];
        } else {
          factor = by3Plus.default || 1;
          log.debug('Pricing', `SGP 3+leg combo '${combo}' not in sgpCorrelation3PlusByCombo — using default factor ${factor}`);
        }
      } else {
        continue; // 1 leg per event isn't an SGP component
      }

      if (factor === 1) continue;
      detectedCombos.push(combo);
      sgpCorrelationFactor *= factor;
    }
    // Metadata: first detected combo for back-compat with consumers that
    // expect a single string. (Multi-component SGPs are rare; the factor
    // already compounds them correctly.)
    if (detectedCombos.length > 0) sgpCorrelationCombo = detectedCombos[0];
  }
  // Maintain the existing log/instrumentation interface for
  // backward-compat with anything that reads sgpCorrelationSign.
  const sgpCorrelationSign = sgpCorrelationFactor > 1 ? 'positive'
    : sgpCorrelationFactor < 1 ? 'negative' : null;

  // K-prop + same-team ML SGP carve-out (M3 carve-out, operator-approved
  // 2026-04-27). When the parlay is exactly 2 legs (one player_strikeouts
  // + one moneyline on the same game) AND the ML team matches the
  // pitcher's team per lineup cache, apply a positive-correlation boost.
  // Empirically calibrated from DK SGP pricing: ~14.5% avg discount on
  // 3 sample combos. Default 0.15. Stacks multiplicatively with the
  // 2-way spread_total factor above (won't fire simultaneously since
  // those are different combos).
  let isKpropMlSameTeamSGP = false;
  if (isSGPParlay && pricedLegs.length === 2) {
    const propLeg = pricedLegs.find(l => l.lineInfo.marketType === 'player_strikeouts');
    const mlLeg = pricedLegs.find(l => l.lineInfo.marketType === 'moneyline');
    if (propLeg && mlLeg && propLeg.lineInfo.pxEventId === mlLeg.lineInfo.pxEventId) {
      const pi = propLeg.lineInfo;
      const pitcherSide = oddsFeed.getPitcherSide(
        pi.sport, pi.homeTeam, pi.awayTeam, pi.startTime, pi.playerName,
      );
      const mlSide = mlLeg.lineInfo.oddsApiSelection || mlLeg.lineInfo.selection;
      if (pitcherSide && mlSide && pitcherSide === mlSide) {
        isKpropMlSameTeamSGP = true;
        const boost = 1 + (config.pricing.sgpPropMlCorrBoost || 0);
        const before = fairParlayProb;
        fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * boost));
        log.debug('Pricing', `SGP K-prop+ML same-team correlation boost — fair ${(before*100).toFixed(2)}% × ${boost} = ${(fairParlayProb*100).toFixed(2)}% (pitcher ${pi.playerName}, side ${pitcherSide})`);
      }
    }
  }

  if (sgpCorrelationFactor !== 1) {
    const before = fairParlayProb;
    fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * sgpCorrelationFactor));
    log.debug('Pricing', `SGP correlation ${sgpCorrelationSign} — fair ${(before*100).toFixed(2)}% × ${sgpCorrelationFactor} = ${(fairParlayProb*100).toFixed(2)}%`);
  }

  // ---- SAME-TOURNAMENT GOLF CORRELATION ----
  // Root cause of July 2026's entire -$6,541 loss. Golf matchups were -$8,299
  // that month; EXCLUDING them July was +$1,758. Golf legs sit on separate
  // pxEventIds, so every correlation gate above treats them as independent and
  // simply multiplies — but 310 of 310 multi-golf tickets shared ONE
  // tournament. Those players face the same course, weather and wave, so their
  // outcomes are positively correlated and the true parlay probability is
  // HIGHER than the product.
  //
  // Measured on settled results, the miss grows monotonically with golf leg
  // count (predicted SP win% vs actual):
  //     1 leg  76.0% -> 72.5%  (z -0.55)
  //     2 legs 73.4% -> 67.1%  (z -1.69)
  //     3 legs 87.1% -> 64.0%  (z -4.88)   <-- 23pp, not variance
  //     4 legs 93.2% -> 84.4%  (z -1.98)
  // Implied bettor-hit multipliers ~1.24x (2 legs), ~2.8x (3), ~2.3x (4).
  // Samples at 3-4 legs are small (50/32), so the DIRECTION is solid but the
  // magnitude is not; we apply a deliberately conservative compounding factor
  // rather than the raw implied one.
  //
  // Applies to matchups AND outrights — outrights share the same structure
  // (one tournament, one course) and, being YES-side legs we lay, carry the
  // same exposure. Legs across DIFFERENT tournaments stay independent.
  const golfCorrPerLeg = config.pricing.golfSameTournamentCorrelation;
  if (golfCorrPerLeg > 1) {
    const byTournament = {};
    for (const l of pricedLegs) {
      const li = l.lineInfo || {};
      const sport = String(li.sport || li.oddsApiSport || '');
      if (!sport.startsWith('golf')) continue;
      // Group by tournament. Fall back to the sport key so legs with no
      // tournament metadata still group (conservative: assumes same event).
      const key = String(li.tournamentName || li.pxEventName || sport).toLowerCase().trim();
      byTournament[key] = (byTournament[key] || 0) + 1;
    }
    let golfFactor = 1;
    for (const n of Object.values(byTournament)) {
      if (n >= 2) golfFactor *= Math.pow(golfCorrPerLeg, n - 1);
    }
    if (golfFactor > 1) {
      const before = fairParlayProb;
      const cap = config.pricing.golfSameTournamentCorrelationCap || 3;
      const applied = Math.min(golfFactor, cap);
      fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * applied));
      log.info('Pricing', `Golf same-tournament correlation ×${applied.toFixed(3)} `
        + `(groups ${JSON.stringify(byTournament)}) — fair ${(before * 100).toFixed(2)}% → ${(fairParlayProb * 100).toFixed(2)}%`);
    }
  }

  // Cross-game same-market correlation. Legs of the SAME market + side across
  // DIFFERENT games are positively correlated through the shared environment
  // (a high-scoring night lifts every over / HR / goalscorer at once), but the
  // independent product above underprices that joint — the leak behind
  // correlated blow-up slates (May 6 multi-totals; league-wide HR days). Boost
  // the fair (bettor win prob) toward the true higher joint so our offer
  // tightens. SAME-game clusters are the SGP path above (same pxEventId); this
  // fires only across DISTINCT pxEventIds, so the two compose without double-
  // counting. Env-gated via CROSS_GAME_CORR_BY_MARKET (JSON marketType ->
  // per-extra-game factor); empty default = no change. Boost = factor^(games-1),
  // capped. MUST also feed sgpFairMultiplier below (offered side) or offered
  // odds come out longer than Fair.
  let crossGameCorrFactor = 1;
  {
    const xgMap = config.pricing.crossGameCorrByMarket || {};
    if (Object.keys(xgMap).length && pricedLegs.length >= 2) {
      const clusters = {};
      for (const l of pricedLegs) {
        const mt = l.lineInfo.marketType || l.lineInfo.market;
        if (!mt || xgMap[mt] == null) continue;
        const side = l.lineInfo.oddsApiSelection || l.lineInfo.selection || '';
        const k = mt + '|' + side;
        const c = clusters[k] || (clusters[k] = { mt, games: new Set() });
        if (l.lineInfo.pxEventId != null) c.games.add(l.lineInfo.pxEventId);
      }
      const applied = [];
      for (const [k, c] of Object.entries(clusters)) {
        if (c.games.size < 2) continue; // same market+side across 2+ distinct games
        const f = xgMap[c.mt];
        if (!(f > 1)) continue;
        crossGameCorrFactor *= Math.pow(f, c.games.size - 1);
        applied.push(`${k}×${c.games.size}g`);
      }
      const capB = config.pricing.crossGameCorrMaxBoost || 2.0;
      if (crossGameCorrFactor > capB) crossGameCorrFactor = capB;
      if (crossGameCorrFactor > 1) {
        const before = fairParlayProb;
        fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * crossGameCorrFactor));
        log.debug('Pricing', `Cross-game same-market correlation ×${crossGameCorrFactor.toFixed(3)} [${applied.join(', ')}] — fair ${(before*100).toFixed(2)}% → ${(fairParlayProb*100).toFixed(2)}%`);
      }
    }
  }

  // Nested implication collapse: joint = P(strong) exactly, i.e. the weak
  // leg's factor is divided out of the naive product. Detected above from
  // leg shape; mirrored into sgpFairMultiplier below (vig alignment).
  if (nestedFairMultiplier !== 1) {
    const before = fairParlayProb;
    fairParlayProb = Math.max(0.001, Math.min(0.99, fairParlayProb * nestedFairMultiplier));
    log.debug('Pricing', `Nested implication collapse (${nestedPairCount} pair${nestedPairCount > 1 ? 's' : ''}) — fair ${(before * 100).toFixed(2)}% × ${nestedFairMultiplier.toFixed(4)} = ${(fairParlayProb * 100).toFixed(2)}% (joint = strong leg)`);
  }

  // Apply vig to ODDS (multiplicative) rather than probability (additive).
  // This scales naturally: a 3% vig on -700 reduces the payout by 3%,
  // not by a fixed probability shift that distorts at extreme odds.
  //
  // Method: for each leg, compute fair decimal odds (1/fairProb), then
  // reduce the payout portion by (1 - vig). Compound across legs.
  //
  // Example at 3% vig:
  //   Fair -700 (decimal 1.143): payout = 0.143, vigged = 0.143 × 0.97 = 0.139 → decimal 1.139 → -718
  //   Fair +150 (decimal 2.50):  payout = 1.50,  vigged = 1.50  × 0.97 = 1.455 → decimal 2.455 → +146
  //   Consistent % reduction in payout regardless of odds level.
  //
  // SGP amplifier: when the parlay is a same-game parlay, multiply the
  // effective per-leg vig by config.pricing.sgpVigMultiplier (default 2×).
  // This widens the price to compensate for positive same-game correlation
  // without triggering PX's "invalid estimated prices" rejection that
  // multiplicative correlation boosts used to hit.
  const globalBaseVig = config.pricing.defaultVig;
  const vigBySport = config.pricing.vigBySport || {};

  // Per-sport base vig: uses sport-specific override if set, else global default.
  function getBaseVigForSport(sport) {
    if (sport && vigBySport[sport] != null) return vigBySport[sport];
    return globalBaseVig;
  }

  // Smoothly scaling vig: linear ramp above fairProb 0.50.
  // Replaces the previous 2-step floor (2.5% @ 0.70, 3% @ 0.80) — the
  // step function gave identical vig at p=0.81 and p=0.95 even though
  // the long tail needs more bite to prevent compounding leaks on
  // heavy favorites in multi-leg parlays.
  //
  // Formula: vig = max(floor, baseVig + slope * (fairProb - 0.5))
  // Slope and floor are Railway-tunable via VIG_FAVORITE_SLOPE and
  // VIG_FAVORITE_FLOOR env vars.
  //
  // Default slope 0.075 sample (base 1%):
  //   p=0.60: 1.75%   p=0.70: 2.50%   p=0.75: 2.875%
  //   p=0.80: 3.25%   p=0.85: 3.625%  p=0.90: 4.00%
  //   p=0.95: 4.375%  p=1.00: 4.75%
  // Hits the old 2.5% floor exactly at p=0.70 (no regression at the
  // standard heavy-favorite band), exceeds the old 3% at p≥0.80, and
  // grows ~1.4pp into the long tail where the old step was bleeding.
  const favSlope = config.pricing.vigFavoriteSlope;
  const favFloor = config.pricing.vigFavoriteFloor;
  const seriesMinVig = config.pricing.vigSeriesMin || 0;
  function getEffectiveVig(fairProb, sport, marketType, vigBump = 0) {
    const baseVig = getBaseVigForSport(sport);
    // Player props (Phase-2 launch types + K-prop): flat per-leg vig at
    // the VIG_PROP_FLOOR floor (default 3%). Skips the favorite-slope
    // ramp because props don't have favorites in the team-line sense —
    // a player with fair Over=0.55 isn't a "favorite" the way a -350
    // moneyline is. Still subject to the SGP multiplier and 20% cap
    // below so multi-prop parlays don't compound runaway vig.
    if (marketType && /^player_/.test(marketType)) {
      let vig = Math.max(config.pricing.vigPropFloor || 0, baseVig);
      if (vigBump > 0) vig += vigBump;
      if (sgpPropVigMult > 1) {
        vig = Math.min(0.20, vig * sgpPropVigMult);
      }
      return Math.min(0.20, vig);
    }
    let vig;
    if (fairProb <= 0.5) {
      vig = baseVig;
    } else {
      const ramp = baseVig + favSlope * (fairProb - 0.5);
      vig = favFloor > 0 ? Math.max(favFloor, ramp) : ramp;
    }
    // Series-winner legs get a configurable floor on top of the
    // normal vig — typically the only SP quoting these on PX, so we
    // can widen the spread without losing order flow.
    if (marketType === 'series_winner' && seriesMinVig > 0) {
      vig = Math.max(vig, seriesMinVig);
    }
    // MMA legs (moneyline + total rounds) — same logic: low-comp
    // market on PX, we can widen without losing flow.
    const mmaMinVig = config.pricing.vigMmaMin || 0;
    if (sport === 'mma_mixed_martial_arts' && mmaMinVig > 0) {
      vig = Math.max(vig, mmaMinVig);
    }
    // Golf-matchup floor — applies whenever the leg is golf_matchups
    // AND we DON'T have a manual upload (bookPriceOverride bypasses vig
    // entirely, so this floor only fires on the DataGolf fallback
    // path). DataGolf publishes near-fair de-vigged probabilities, so
    // without a floor our default 1.3% vig produces ~0.7% pair vig
    // (caught 2026-05-14 on R2 PGA Championship matchups pre-upload).
    // Operator preference: keep DataGolf as a valid source but charge
    // a wider margin to compensate for the model uncertainty.
    const golfMatchupMinVig = config.pricing.vigGolfMatchupMin || 0;
    if (sport === 'golf_matchups' && golfMatchupMinVig > 0) {
      vig = Math.max(vig, golfMatchupMinVig);
    }
    // Golf outrights (option B) — the RFQ-path twin of the computeSingleLegVig
    // copy. win/top_5/top_10/top_20 fairs are RAW DK implied (already vig-loaded
    // by DK) → OVERRIDE the 6% default vig with the thin mirror cushion. make_cut
    // is a DE-VIGGED fair (golf-topn power-normalizes the make-side board) → keep
    // the wider vigGolfOutrightMin floor; the 2% mirror would quote it far too
    // cheap.
    if (sport === 'golf_outrights') {
      if (GOLF_RAW_DK_OUTRIGHT_MARKETS.has(marketType)) {
        vig = config.pricing.vigGolfOutrightMirror || 0.02;
      } else {
        const golfOutrightMinVig = config.pricing.vigGolfOutrightMin || 0;
        if (golfOutrightMinVig > 0) vig = Math.max(vig, golfOutrightMinVig);
      }
    }
    // First-5-innings (F5) floor — the settlement analysis found F5 totals
    // under-won by 7.6pp and F5 run lines by 12.8pp (our fair runs
    // optimistic on this thinner, lower-liquidity sub-market). A min-vig
    // floor widens the margin to compensate, same mechanism as series/MMA.
    // Env-gated (VIG_F5_MIN, default 0 = no change).
    const f5MinVig = config.pricing.vigF5Min || 0;
    if (f5MinVig > 0 && typeof marketType === 'string' && /^first_5/.test(marketType)) {
      vig = Math.max(vig, f5MinVig);
    }
    // Full-game spread / run-line floor — run lines under-won by 3.9pp and
    // were 99% softer than the sharp book consensus (our spread de-vig fair
    // runs ~4pp optimistic; biggest recent team-market drag). A floor adds
    // cushion without needing a full de-vig rework. Env-gated (VIG_SPREAD_MIN,
    // default 0). Applies to full-game spreads only — F5 spreads are caught
    // by the F5 floor above (checked first; Math.max makes order irrelevant).
    const spreadMinVig = config.pricing.vigSpreadMin || 0;
    if (spreadMinVig > 0 && marketType === 'spread') {
      vig = Math.max(vig, spreadMinVig);
    }
    // RFI (1st Inning Total Runs) floor — sets the margin on this fresh,
    // uncalibrated 2-way market. Env-gated (VIG_RFI_MIN, default 0.03).
    const rfiMinVig = config.pricing.vigRfiMin || 0;
    if (rfiMinVig > 0 && marketType === 'run_first_inning') {
      vig = Math.max(vig, rfiMinVig);
    }
    // (Player-prop vig floor lives in the early player_* branch above as
    // vigPropFloor / VIG_PROP_FLOOR — this non-prop path is never reached by
    // props, so no prop floor belongs here.)
    // Per-leg vigBump from sub-pricing fallbacks (e.g. tennis totals
    // snap-to-nearest). Adds to the base vig BEFORE SGP multiplier so
    // the bump is preserved through correlation amplification but
    // capped at 20% with the rest.
    if (vigBump > 0) vig += vigBump;
    // SGP amplifier — compensate for same-game correlation. Capped at
    // 20% to avoid runaway vig if favorite ramp + SGP multiplier stack
    // on an extreme favorite; PX could still reject at absurd vig.
    if (sgpVigMult > 1) {
      vig = Math.min(0.20, vig * sgpVigMult);
    }
    return Math.min(0.20, vig);
  }

  function applyOddsVig(fairProb, sport, marketType, vigBump = 0) {
    const vig = getEffectiveVig(fairProb, sport, marketType, vigBump);
    const fairDecimal = 1 / fairProb;
    const payout = fairDecimal - 1; // the profit portion
    const viggedPayout = payout * (1 - vig); // reduce payout by vig %
    return 1 / (1 + viggedPayout); // convert back to implied prob
  }

  // ---------------------------------------------------------------------
  // VIG APPLICATION — two modes, A/B-testable via config.pricing.parlayLevelVig
  //
  // PER-LEG MODE (default, legacy):
  //   Apply vig to each leg independently, multiply the vigged per-leg
  //   probs. This COMPOUNDS the vig. For a 5-leg parlay at 2% per leg,
  //   effective parlay vig ≈ 4.2% (meaningfully uncompetitive).
  //
  // PARLAY-LEVEL MODE (experimental):
  //   Apply vig ONCE at the parlay level using the MAX per-leg effective
  //   rate. The max preserves sport-aware pricing (highest sport wins)
  //   and favorite-ramp protection (any leg triggering the ramp pulls
  //   the whole parlay's vig up). Eliminates multi-leg compounding.
  //
  // Observed data: per-leg win rate collapses at 4+ legs (28%→14%→9%)
  // suggesting competitors don't compound. A/B test via:
  //   POST /config/vig {parlayLevelVig:true}  — enable
  //   POST /config/vig {parlayLevelVig:false} — disable
  // Watch win rate by leg count before/after.
  // ---------------------------------------------------------------------
  let offeredImpliedProb;
  let vigMode;
  let vigRateUsed; // informational — the rate applied (for debugging/analytics)
  // Implied-prob added by the near-lock concentration surcharge (0 when the
  // ticket isn't the lock+coinflip shape). Surfaced on meta so we can tell
  // whether the guard ever fires — the flow it targets went dormant 2026-07-30,
  // so "it earned nothing" and "it never fired" must be distinguishable.
  let lockConcentrationAdd = 0;
  // Implied-prob added by the longshot vig floor (0 when neither floor bound).
  // Surfaced so the VIG_MIN_PP / VIG_MIN_ROI experiment is measurable — we can
  // split retention on floored vs un-floored quotes rather than guessing.
  let vigFloorAdd = 0;
  let vigFloorWhich = null;   // 'pp' | 'roi' | null
  // Legs flagged with bookPriceOverride (e.g. NBA series heavy favorites
  // past -500 FV) bypass vig entirely — we quote DK's offered number for
  // those legs. Vig logic below applies only to the remaining legs.
  const overrideLegs = pricedLegs.filter(l => l.bookPriceOverride != null);
  const vigLegs = pricedLegs.filter(l => l.bookPriceOverride == null);
  const overrideProduct = overrideLegs.reduce((p, l) => p * l.bookPriceOverride, 1);

  // Parlay fair prob over vig legs — reused by both modes and by the
  // longshot ramp below.
  //
  // SGP-CORRELATION ALIGNMENT: when an SGP correlation boost was applied
  // to fairParlayProb above (sgpCorrelationFactor for ml_total/spread_total,
  // or sgpPropMlCorrBoost for K-prop+ML same-team), vigFair MUST mirror
  // that same boost. Otherwise vig is charged against the raw per-leg
  // product while the displayed Fair reflects the boosted joint —
  // producing offered odds LONGER than Fair (bettor-favorable, negative
  // SP edge per ticket). Verified against MTL ML + MTL@BUF U5.5 SGP on
  // 2026-05-06: pre-fix our offered came out +370 vs Fair +332 (-8% theo
  // edge); post-fix offered tracks Fair × (1 - vig).
  // NOTE: the nested factor here is the OFFERED-side one (divides out the
  // weak leg's actual contribution to the offered product — its
  // bookPriceOverride when it's a mirror leg, else its fairProb). The
  // FAIR-side factor (always 1/fairProb) was applied to fairParlayProb
  // above. sgpFairMultiplier feeds only offered-price computations
  // (vigFair, per-leg alignment, the all-override branch).
  const sgpFairMultiplier =
    (isKpropMlSameTeamSGP ? (1 + (config.pricing.sgpPropMlCorrBoost || 0)) : 1) *
    sgpCorrelationFactor *
    crossGameCorrFactor *
    nestedOfferedMultiplier *
    xteamFairMultiplier *
    propSameGameFallbackMultiplier;
  const vigFair = vigLegs.reduce((p, l) => p * l.fairProb, 1) * sgpFairMultiplier;

  // ---------------------------------------------------------------------
  // LONGSHOT VIG WIDENING (parlay-level)
  //
  // The per-leg favorite ramp only fires above fairProb 0.5, so multi-leg
  // parlays built out of dog legs never trigger it — their parlay-product
  // fair prob lands low (5-20%) but each leg uses base vig. That's where
  // our chart showed the biggest gap vs Pinnacle. This ramp closes that
  // gap by adding vig linearly as parlay fair prob approaches 0.
  //
  // Applied as an ADDITIVE increment to the vig rate used below. Capped
  // at 0.20 downstream (same ceiling as the SGP multiplier) so we can't
  // stack runaway vig on extreme long shots.
  // ---------------------------------------------------------------------
  const lsThreshold = config.pricing.vigLongshotThreshold || 0;
  const lsMaxAdd = config.pricing.vigLongshotMaxAdd || 0;
  let longshotAdd = 0;
  if (lsMaxAdd > 0 && lsThreshold > 0 && vigFair > 0 && vigFair < lsThreshold) {
    longshotAdd = lsMaxAdd * (1 - vigFair / lsThreshold);
  }

  // ---------------------------------------------------------------------
  // TEMPLATE-EXPOSURE RAMP
  //
  // Checks how many identical parlays (same canonical signature) have
  // already confirmed inside the rolling window (default 24h). Returns
  // a graduated vig add, or a decline signal when concentration exceeds
  // the hard cap. Empirical: April 18 cliff was 80%+ driven by two
  // parlay signatures each copied 6-9 times — see template-exposure.js
  // for the full counterfactual derivation.
  //
  // ADDITIVE with longshotAdd (both in vig rate units); capped at 0.20
  // downstream so runaway stacking can't happen.
  // ---------------------------------------------------------------------
  // This ramp is QUOTE-TIME ADMISSION CONTROL only. It is SKIPPED on the
  // confirm-time reprice (opts.skipTemplateRamp): once PX has matched our
  // quote, re-running the cap only mis-rejects the fill — the reprice sees the
  // order's OWN pending reservation (plus any sibling cooldown), declines, and
  // validateForConfirmation turns that into a fail-closed reject. The cap's
  // purpose (limit how many copies we TAKE) is already enforced at quote time;
  // it's moot for a bet PX is booking. The confirm reprice exists only for the
  // fair-value drift check, which is fair-prob-based, so the skipped ramp vig
  // doesn't affect it. Diagnosed 2026-06-21: confirm reprices were failing
  // closed on this cap and rejecting ~93% of confirms (multi-hour fill outage).
  let templateRampAdd = 0;
  let templatePriorCount = 0;
  if (!opts.skipTemplateRamp) {
    const templateLegsForSig = pricedLegs.map(l => ({
      team: l.lineInfo.teamName,
      market: l.lineInfo.marketType,
      line: l.lineInfo.line,
    }));
    // Pass parlayId so getRampDecision can atomically reserve a pending
    // slot on non-decline. Closes the timing race where multiple RFQs on
    // the same signature land within seconds (faster than the confirm
    // cycle) and all see priorCount=0 because none had confirmed yet.
    // estStake uses the RFQ's max_risk if known so /template-exposure-stats
    // shows realistic in-flight totals; the real confirmedStake replaces it
    // when recordConfirmation graduates the entry.
    const templateRfqMaxRisk = (opts && Number.isFinite(+opts.maxRisk)) ? +opts.maxRisk : 0;
    const templateDecision = templateExposure.getRampDecision(templateLegsForSig, {
      parlayId: opts ? opts.parlayId : null,
      estStake: templateRfqMaxRisk,
    });
    if (templateDecision.decline) {
      log.info('Pricing', `Declined: ${templateDecision.reason} (stake so far $${templateDecision.totalStake.toFixed(2)})`);
      priceParlay._lastFailure = {
        reason: 'template exposure cap',
        detail: templateDecision.reason,
        blockerLeg: null,
      };
      return null;
    }
    templateRampAdd = templateDecision.extraVig || 0;
    templatePriorCount = templateDecision.count || 0;
  }

  if (config.pricing.parlayLevelVig) {
    // Parlay-level: single vig application using max per-leg rate (over vig legs only).
    const perLegVigs = vigLegs.map(l => getEffectiveVig(l.fairProb, l.lineInfo.sport, l.lineInfo.marketType, l.vigBump || 0));
    const maxVig = perLegVigs.length > 0 ? Math.max(...perLegVigs) : config.pricing.defaultVig;
    const effectiveVig = Math.min(0.20, maxVig + longshotAdd + templateRampAdd);
    if (vigLegs.length > 0) {
      const fairDecimal = 1 / vigFair;
      const payout = fairDecimal - 1;
      const viggedPayout = payout * (1 - effectiveVig);
      offeredImpliedProb = (1 / (1 + viggedPayout)) * overrideProduct;
    } else {
      // ALL legs are bookPriceOverride legs (e.g. a nested pair of WC
      // book-mirror props). The SGP fair multiplier (nested-implication
      // collapse / correlation boosts) must still apply — without it an
      // all-override nested pair prices at the naive product of mirrors,
      // exactly the correlated-gift Stage 1 exists to close. (vigFair
      // carries the multiplier only when vig legs exist, hence the
      // explicit application here.)
      offeredImpliedProb = Math.min(0.99, overrideProduct * sgpFairMultiplier);
    }
    vigMode = 'parlay-level';
    vigRateUsed = effectiveVig;
  } else {
    // Per-leg: vig applied to each leg's odds then compounded (legacy).
    offeredImpliedProb = overrideProduct;
    for (const leg of vigLegs) {
      offeredImpliedProb *= applyOddsVig(leg.fairProb, leg.lineInfo.sport, leg.lineInfo.marketType, leg.vigBump || 0);
    }
    // SGP-CORRELATION ALIGNMENT (per-leg mode): mirror the same boost that
    // was applied to fairParlayProb. Per-leg compounding works on raw
    // leg.fairProb values and otherwise leaves offered un-boosted relative
    // to the displayed Fair, producing the same -EV bug fixed in
    // parlay-level mode via vigFair. See vigFair comment above for the
    // empirical justification.
    if (sgpFairMultiplier !== 1 && offeredImpliedProb > 0) {
      offeredImpliedProb = Math.min(0.99, offeredImpliedProb * sgpFairMultiplier);
    }
    // Longshot widening + template ramp applied as a final parlay-level
    // haircut on the post-compounding offered prob so the sensitivity
    // matches parlay-level mode's behavior for low-prob parlays.
    const totalParlayAdd = longshotAdd + templateRampAdd;
    if (totalParlayAdd > 0 && vigLegs.length > 0 && offeredImpliedProb > 0) {
      const payout = (1 / offeredImpliedProb) - 1;
      const cappedAdd = Math.min(totalParlayAdd, 0.20);
      const adjustedPayout = payout * (1 - cappedAdd);
      offeredImpliedProb = (1 / (1 + adjustedPayout));
    }
    vigMode = 'per-leg';
    // For per-leg, expose the AVERAGE per-leg rate as the "used" value (vig legs only).
    const avgVig = vigLegs.length > 0
      ? vigLegs.reduce((s, l) => s + getEffectiveVig(l.fairProb, l.lineInfo.sport, l.lineInfo.marketType, l.vigBump || 0), 0) / vigLegs.length
      : 0;
    vigRateUsed = Math.min(0.20, avgVig + longshotAdd + templateRampAdd);
  }

  // Fair-prob multiplier floor. Mirrors how Pinnacle / DK / FD price —
  // markup applied as a fraction of fair, producing pp-distance that
  // grows with fair prob. Our payout-vig formula above produces a flat
  // (or slightly decreasing) pp-distance curve; this knob gives the
  // slope a books-shaped lift without disrupting low-fair behavior
  // where the longshot ramp already dominates.
  //
  // Take the MAX of (current offered, fair × (1 + multiplier)). At low
  // fair the existing payout formula wins; at high fair the multiplier
  // floor kicks in. Default 0 = disabled.
  const fairMult = config.pricing.vigFairMultiplier || 0;
  if (fairMult > 0 && vigLegs.length > 0 && vigFair > 0) {
    const multiplierOffered = vigFair * (1 + fairMult) * overrideProduct;
    if (multiplierOffered > offeredImpliedProb) {
      offeredImpliedProb = Math.min(0.99, multiplierOffered);
    }
  }

  // Heavy-favorite per-leg fair markup. For each leg with fair_prob >
  // vigHeavyFavThreshold, override its leg-level offered with
  // fair × (1 + markup). Below-threshold legs keep their normal
  // payout-vig offered. Compounds across legs and MAX-gates against
  // the current offeredImpliedProb so this never tightens — only
  // widens chalky legs to DK-retail-shaped pricing where the payout
  // formula's vig is too small to bite.
  //
  // Mode-agnostic: in per-leg vig mode the existing offeredImpliedProb
  // is the per-leg compound; in parlay-level vig mode it's the single
  // combined calc. Either way the MAX picks the wider of the two.
  const heavyFavMarkup = config.pricing.vigHeavyFavFairMarkup || 0;
  const heavyFavThreshold = config.pricing.vigHeavyFavThreshold || 0.70;
  // Soccer DNB-scoped favorite markup (see config.vigDnbFavMarkup). Same
  // fair × (1 + markup) shape as the generic heavy-fav markup, but a
  // separate, typically-larger coefficient applied ONLY to DNB legs and at
  // its own (lower) threshold — so we charge real margin on Draw-No-Bet
  // favorites (where payout-vig is most impotent) without re-rating other
  // sports' chalk. Folded into the same MAX-gated compound below.
  const dnbFavMarkup = config.pricing.vigDnbFavMarkup || 0;
  const dnbFavThreshold = config.pricing.vigDnbFavThreshold || 0.55;
  const heavyFavCap = config.pricing.vigHeavyFavFairCap || 0.85;
  const dnbFavCap = config.pricing.vigDnbFavCap || 0.92;
  if ((heavyFavMarkup > 0 || dnbFavMarkup > 0) && vigLegs.length > 0) {
    let heavyCompound = overrideProduct;
    for (const leg of vigLegs) {
      const fp = leg.fairProb;
      // Props carry their own VIG_PROP_FLOOR protection and the favorite
      // markup is calibrated off team-line books, so never apply the GENERIC
      // markup to a player-prop leg. (DNB legs are team markets, never props.)
      const mt = leg.lineInfo.marketType || '';
      const isProp = /^(player_|pitcher_|hitter_|batter_)/.test(mt);
      // DNB favorite: use the larger of the DNB markup and the generic
      // heavy-fav markup so a DNB leg is never marked up LESS than a
      // same-prob team line would be. Both are CAPPED at an upper fair-prob
      // bound so extreme chalk — where our de-vig already under-rates the
      // favorite and a markup risks a PX reject — is left alone.
      const dnbApplies = leg.lineInfo.isDNB && dnbFavMarkup > 0
        && fp > dnbFavThreshold && fp < dnbFavCap;
      const heavyApplies = heavyFavMarkup > 0 && !isProp
        && fp > heavyFavThreshold && fp < heavyFavCap;
      if (dnbApplies || heavyApplies) {
        const markup = Math.max(
          dnbApplies ? dnbFavMarkup : 0,
          heavyApplies ? heavyFavMarkup : 0,
        );
        heavyCompound *= Math.min(0.99, fp * (1 + markup));
      } else {
        heavyCompound *= applyOddsVig(fp, leg.lineInfo.sport, leg.lineInfo.marketType, leg.vigBump || 0);
      }
    }
    if (heavyCompound > offeredImpliedProb) {
      offeredImpliedProb = Math.min(0.99, heavyCompound);
    }
  }

  // Chalk-stack parlay surcharge. Punishes the multi-leg-of-favorites
  // pattern specifically (where compounding heavy favs into one parlay
  // produces a near-coinflip parlay shape that retail books like DK
  // mark up far more aggressively than fair-driven pricing produces).
  // Triggers when:
  //   - parlay has 2+ legs
  //   - parlay's combined fair > vigChalkStackParlayThreshold (parlay
  //     isn't a longshot, otherwise the longshot ramp already widens)
  //   - EVERY leg's fair > vigChalkStackLegThreshold (all favorites)
  // Effect: parlay-level fair × (1 + surcharge), MAX against current.
  const chalkSurcharge = config.pricing.vigChalkStackSurcharge || 0;
  const chalkLegThresh = config.pricing.vigChalkStackLegThreshold || 0.60;
  const chalkParlayThresh = config.pricing.vigChalkStackParlayThreshold || 0.25;
  if (chalkSurcharge > 0
      && vigLegs.length >= 2
      && vigFair > chalkParlayThresh
      && vigLegs.every(l => l.fairProb > chalkLegThresh)) {
    const surchargeOffered = vigFair * (1 + chalkSurcharge) * overrideProduct;
    if (surchargeOffered > offeredImpliedProb) {
      offeredImpliedProb = Math.min(0.99, surchargeOffered);
    }
  }

  // -------------------------------------------------------------------
  // PER-LEG-COUNT VIG MULTIPLIER
  //
  // Variance on parlays scales nonlinearly with leg count: a single bad
  // leg torches many wins, and adversarially-selected high-leg parlays
  // (longshot bombs at 4-leg, chalk stacks at 6-leg) are exactly where
  // bettor +EV concentrates. Pinnacle's per-$ wagered edge in the
  // boxed low-fair-prob region of the Parlay Pricing chart grows
  // visibly with leg count for this reason.
  //
  // We multiply the cumulative vig fraction (offeredImpliedProb / vigFair − 1)
  // by config.pricing.vigByLegCount[legCount], so the surcharge scales
  // with whatever vig is already accumulated (longshot ramp, template
  // ramp, chalk-stack, etc) rather than adding a fixed pp. legCounts
  // not in the map default to 1.0 (no change), so 2-leg / 3-leg parlays
  // are unaffected by default.
  //
  // Bettor-favorable bookPriceOverride legs (where offered ≤ vigFair)
  // are skipped — the multiplier would otherwise contract our edge.
  // -------------------------------------------------------------------
  const legCountMultMap = config.pricing.vigByLegCount || {};
  // Clamp to the highest defined key so the top entry behaves as "N+": a
  // leg count above the map's max reuses the max multiplier instead of
  // silently falling through to ×1.0 (the 9-12 hole this fixed, and future-
  // proofs against MAX_LEGS ever rising past the map). Exact match wins;
  // over-max reuses the max-key value; under-min (2-leg) stays ×1.0.
  const _lcKeys = Object.keys(legCountMultMap).map(Number).filter(Number.isFinite);
  const _lcMax = _lcKeys.length ? Math.max(..._lcKeys) : 0;
  const legCountMult = legCountMultMap[vigLegs.length]
    || (vigLegs.length > _lcMax ? legCountMultMap[_lcMax] : 1.0)
    || 1.0;
  if (legCountMult > 1.0 && offeredImpliedProb > vigFair && vigFair > 0) {
    const currentVigFraction = offeredImpliedProb / vigFair - 1;
    const scaledOffered = vigFair * (1 + currentVigFraction * legCountMult);
    if (scaledOffered > offeredImpliedProb) {
      offeredImpliedProb = Math.min(0.99, scaledOffered);
    }
  }

  // -------------------------------------------------------------------
  // NEAR-LOCK CONCENTRATION SURCHARGE
  //
  // A leg priced >= 0.90 contributes almost no uncertainty. Bolt one onto a
  // single genuine coinflip and the ticket is economically a SINGLE BET wearing
  // a parlay's clothing: the real leg's model error passes through undiluted,
  // but the ladder above prices it as a 2-leg (x1.0, since vigByLegCount starts
  // at 3) and our normal ~6% markup is all that stands behind it.
  //
  // MEASURED over the full book 2026-04-02..08-05, tickets with a leg at
  // -1000 or longer (fair >= 90.91%):
  //   ALL leg counts   n=65   -$3,690   ROI -36.9%   realised 49.2% vs model
  //                                                  37.1% void-adjusted, z=2.03
  //   >>> exactly 1 non-lock leg: n=17  -$4,225  ROI -99.5%  bettor won 17/17, z=4.62
  //       3 legs n=9  +$94 | 4 legs n=18 +$502 | 5+ legs n=21 -$61
  // So the damage is ENTIRELY the concentrated shape. Genuine multi-leg parlays
  // that merely contain a lock are fine-to-profitable and are deliberately left
  // alone — this fires only when <= 1 leg carries real uncertainty.
  //
  // Threshold is 0.90, NOT 0.80: the 0.80-0.90 band is +$2,204 over the same
  // window and widening into it would tax a profitable segment.
  //
  // The lock legs themselves are not the problem — they went 66-1-11(void). We
  // are not repricing them; we are refusing to give single-bet risk a parlay's
  // vig treatment.
  //
  // HONEST LIMIT: a surcharge cannot rescue a segment that lost 100% of 17
  // tickets — that run implies the counterparty was reading the coinflip leg
  // better than we were, not that our margin was 15% too thin. This makes the
  // shape unattractive and observable; VIG_LOCK_DECLINE=true refuses it
  // outright, which the data says is also +EV. Default is to price, not refuse.
  // -------------------------------------------------------------------
  const lockThresh = config.pricing.vigLockLegThreshold;
  const lockLegs = vigLegs.filter(l => Number(l.fairProb) >= lockThresh);
  const realLegs = vigLegs.length - lockLegs.length;
  const lockConcentrated = lockLegs.length > 0 && realLegs <= 1 && vigLegs.length >= 2;
  if (lockConcentrated) {
    if (config.pricing.declineNearLockSingleBet) {
      log.info('Pricing', `Declined: near-lock single-bet shape — ${lockLegs.length} leg(s) >= ${lockThresh} with only ${realLegs} uncertain leg`);
      priceParlay._lastFailure = {
        reason: 'near_lock_single_bet',
        detail: `${lockLegs.length} leg(s) at fair >= ${lockThresh} with only ${realLegs} uncertain leg — economically a single bet`,
      };
      return null;
    }
    const surcharge = config.pricing.vigLockConcentrationSurcharge || 0;
    if (surcharge > 0 && offeredImpliedProb > vigFair && vigFair > 0) {
      const currentVigFraction = offeredImpliedProb / vigFair - 1;
      const scaled = vigFair * (1 + currentVigFraction * (1 + surcharge));
      if (scaled > offeredImpliedProb) {
        lockConcentrationAdd = Math.min(0.99, scaled) - offeredImpliedProb;
        offeredImpliedProb = Math.min(0.99, scaled);
      }
    }
  }

  // -------------------------------------------------------------------
  // CONSENSUS FLOOR CLAMP — final guardrail against fair-prob plumbing
  // bugs (selection flips, wrong market mapping). For each leg, look up
  // Pin/FD/DK consensus implied; floor the leg's contribution at
  // consensusImplied − priceFloorVsConsensusPp. Compound across legs and
  // MAX-gate against the current offeredImpliedProb so the clamp can
  // only TIGHTEN (never widen). Legs without Pin/FD/DK data contribute
  // their normal payout-vig'd implied so the floor product reflects
  // only the legs we have data on.
  //
  // Without this clamp, a sign-flip on a team_total line can produce
  // offered odds 25-30pp wider than market — observed 2026-05-08 Lines
  // tab with My +266 vs CONS −128 on Rockies +4.5 team total.
  // -------------------------------------------------------------------
  const consFloorPp = config.pricing.priceFloorVsConsensusPp || 0;
  if (consFloorPp > 0 && vigLegs.length > 0) {
    let floorProduct = overrideProduct;
    let anyFloorApplied = false;
    for (const leg of vigLegs) {
      const consImp = getConsensusImplied(leg.lineInfo);
      if (consImp != null) {
        anyFloorApplied = true;
        const legFloor = Math.max(0.01, consImp - (consFloorPp / 100));
        floorProduct *= legFloor;
      } else {
        // No consensus for this leg — contribute its normal payout-vig'd
        // implied so legs without book data aren't double-counted as
        // (1.0) which would inflate the floor product.
        floorProduct *= applyOddsVig(leg.fairProb, leg.lineInfo.sport, leg.lineInfo.marketType, leg.vigBump || 0);
      }
    }
    if (anyFloorApplied && floorProduct > offeredImpliedProb) {
      offeredImpliedProb = Math.min(0.99, floorProduct);
    }
  }

  // -------------------------------------------------------------------
  // PARLAY-LEVEL CONSENSUS CAP — anti heavy-favorite-stacking leak.
  // The per-leg floor above subtracts pp PER LEG and compounds, letting an
  // N-leg parlay be offered ~N×pp more generous than the sharp consensus
  // parlay price (the leak that lets us beat the vigged books on chalk
  // stacks — worse with more legs). This bounds TOTAL generosity vs the raw
  // consensus product at a single pp regardless of leg count: floor offered
  // at (Π consensus_leg) − priceFloorVsConsensusParlayPp. The consensus is
  // vigged, so within ~1pp of it we still sit above the de-vigged true fair
  // (we keep margin) while never being exploitably more generous than the
  // books. MAX-gate (only TIGHTENS, never widens). Legs without Pin/FD/DK
  // data contribute their payout-vig'd implied so the product isn't inflated.
  // -------------------------------------------------------------------
  const consParlayPp = config.pricing.priceFloorVsConsensusParlayPp || 0;
  const consParlayChalkPp = config.pricing.priceFloorVsConsensusParlayChalkPp;
  const chalkCapLegThresh = config.pricing.vigChalkStackLegThreshold || 0.60;
  if ((consParlayPp > 0 || (consParlayChalkPp != null && consParlayChalkPp >= 0)) && vigLegs.length > 0) {
    let consProduct = overrideProduct;
    let anyConsData = false;
    // Chalk detection uses CONSENSUS implied (not our fair) so a heavy-fav stack
    // is caught even when our de-vig underrates a leg (the leak we found 06-25:
    // a -128 leg is 56% at consensus but our fair had it at 53.9%, dodging the
    // fair-based chalk-stack surcharge). Every leg a favorite ⇒ chalk stack.
    let everyLegFavorite = true;
    for (const leg of vigLegs) {
      const consImp = getConsensusImplied(leg.lineInfo);
      if (consImp != null) {
        anyConsData = true;
        consProduct *= consImp;
        if (consImp < chalkCapLegThresh) everyLegFavorite = false;
      } else {
        everyLegFavorite = false; // no book data ⇒ can't call it chalk
        consProduct *= applyOddsVig(leg.fairProb, leg.lineInfo.sport, leg.lineInfo.marketType, leg.vigBump || 0);
      }
    }
    if (anyConsData) {
      // Chalk stacks get the tighter cap (default 0 ⇒ floor at consensus, no
      // value given away on adverse-selection-prone favorite stacks); normal
      // parlays keep the wider cap (competitive bettor value).
      const effPp = (everyLegFavorite && consParlayChalkPp != null && consParlayChalkPp >= 0)
        ? consParlayChalkPp
        : consParlayPp;
      if (effPp >= 0) {
        const parlayFloor = Math.max(0.01, consProduct - effPp / 100);
        if (parlayFloor > offeredImpliedProb) {
          offeredImpliedProb = Math.min(0.99, parlayFloor);
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // CROSS-SPORT VIG BUMP — additive margin on multi-sport parlays.
  //
  // Bettors who combine MLB+NBA or MLB+NBA+NHL show multi-sport expertise
  // that produces selection-biased outcomes worse than independent legs
  // predict (z=−2.66 to −2.90 from calibration data on Over+1000 range).
  // A small pp bump covers the correlation blind spot without pricing
  // single-sport parlays more aggressively. Default 0 (disabled); set
  // CROSS_SPORT_VIG_BUMP_PP=0.5 to add 0.5pp on any parlay spanning 2+
  // sports. Only fires on cross-game parlays (SGPs are single-event).
  // -------------------------------------------------------------------
  const crossSportBumpPp = config.pricing.crossSportVigBumpPp || 0;
  if (crossSportBumpPp > 0 && !isSGPParlay) {
    const uniqueSports = new Set(
      vigLegs.map(l => l.lineInfo?.sport).filter(Boolean)
    );
    if (uniqueSports.size > 1) {
      offeredImpliedProb = Math.min(0.99, offeredImpliedProb + crossSportBumpPp / 100);
    }
  }

  // -------------------------------------------------------------------
  // FIXED PP FLOOR ON DISTANCE FROM FAIR
  //
  // The multiplicative vig stack (per-leg vig, longshot ramp, chalk
  // stack, leg-count multiplier) is RELATIVE — it produces a percentage
  // change. At very low parlay fair probs (~0-5%), even a 5% relative
  // vig only nets +0.1-0.25pp of absolute distance, which leaves the
  // longshot zone of the Parlay Pricing vs Books chart nearly flat
  // against fair while the books (Pin/FD/DK) carry +1.3 to +2.4pp
  // average margin. This floor ensures we never offer closer than
  // VIG_MIN_PP percentage points above fair regardless of where the
  // multiplicative stack landed.
  //
  // 0 disables (default). Operator can tune on Railway without a code
  // push. Start small (0.3-0.5pp) and watch the longshot band on the
  // chart lift while monitoring fill rate.
  // -------------------------------------------------------------------
  // Two floors, applied as a UNION (whichever binds harder wins):
  //   pp floor : never offer closer than VIG_MIN_PP points above fair.
  //   ROI floor: never accept less than VIG_MIN_ROI return on our risk, i.e.
  //              op >= (fp + R)/(1 - ... ) — since ROI = (op-fp)/(1-op) = R
  //              solves to op = (fp + R)/(1 + R). For op < ~0.10 the two agree;
  //              the ROI floor keeps biting as parlays shorten.
  // Both default 0 (disabled). Telemetry: lockConcentrationAdd-style, so the
  // experiment is measurable — meta.vigFloorAdd records the implied-prob the
  // floor added, and which floor bound. START SMALL (see config).
  const minVigPp = config.pricing.vigMinPp || 0;
  const minVigRoi = config.pricing.vigMinRoi || 0;
  if ((minVigPp > 0 || minVigRoi > 0) && fairParlayProb > 0 && fairParlayProb < 1) {
    const ppFloor = minVigPp > 0 ? fairParlayProb + minVigPp / 100 : 0;
    const roiFloor = minVigRoi > 0 ? (fairParlayProb + minVigRoi) / (1 + minVigRoi) : 0;
    const floor = Math.max(ppFloor, roiFloor);
    if (floor > offeredImpliedProb) {
      const before = offeredImpliedProb;
      offeredImpliedProb = Math.min(0.99, floor);
      vigFloorAdd = offeredImpliedProb - before;
      vigFloorWhich = roiFloor >= ppFloor ? 'roi' : 'pp';
    }
  }

  // -------------------------------------------------------------------
  // PRICING SAFETY NET: cross-check fair against Pinnacle raw compound.
  //
  // Sign-flip bugs on alt spreads have historically been the most dangerous
  // pricing error (see altSpreads signed-home_point fix). If our fair prob
  // diverges too far optimistically from Pinnacle's raw compound on a
  // non-SGP parlay, decline rather than price. Pinnacle raw is looser than
  // our consensus on average (it includes vig) so OUR fair should almost
  // always be SLIGHTLY LOWER (tighter) than Pin raw compound. A 25%+ gap
  // in the bettor-favorable direction is a strong signal that our
  // consensus was corrupted (wrong line side, wrong book, wrong direction).
  //
  // Only runs when Pinnacle has all legs and for non-SGP cross-game
  // parlays (SGPs have valid correlation-driven deltas and are handled
  // via the Pin-match path below).
  // -------------------------------------------------------------------
  {
    const pinLegs = pricedLegs.filter(l => l.pinnacleOdds != null);
    const havePinAll = pinLegs.length === pricedLegs.length && pinLegs.length > 0;
    // Detect cross-game (no two legs share a pxEventId)
    const eventIds = pricedLegs.map(l => l.lineInfo.pxEventId).filter(Boolean);
    const uniqueEventIds = new Set(eventIds);
    const isCrossGame = uniqueEventIds.size === eventIds.length && eventIds.length > 0;
    if (havePinAll && isCrossGame) {
      let pinRawCross = 1;
      for (const l of pricedLegs) {
        // isDNB alone misses soccer h2h legs PX names plainly "Moneyline"
        // — see bookImpliedForLeg.
        const legImpl = pinImplied(l);
        pinRawCross *= legImpl;
      }
      if (pinRawCross > 0 && pinRawCross < 1) {
        // Our fair should be at or below Pin raw (we use de-vigged consensus
        // which is typically tighter). Guard against wildly optimistic fair
        // that would produce bettor-favorable prices way above Pin.
        const pinToOurs = fairParlayProb / pinRawCross;
        const SAFETY_THRESHOLD = 0.75; // block if our fair is < 75% of Pin raw
        if (pinToOurs < SAFETY_THRESHOLD) {
          log.warn('Pricing', `SAFETY: fair ${(fairParlayProb*100).toFixed(2)}% vs Pin raw ${(pinRawCross*100).toFixed(2)}% ratio=${pinToOurs.toFixed(3)} — declining to avoid sign-flip / wrong-line mispricing`);
          priceParlay._lastFailure = {
            reason: 'pricing safety guard',
            detail: `our fair ${(fairParlayProb*100).toFixed(2)}% is ${((1-pinToOurs)*100).toFixed(0)}% below Pinnacle raw ${(pinRawCross*100).toFixed(2)}% — possible sign-flip / wrong-line corruption`,
            blockerLeg: null,
          };
          return null;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // SGP correlation handling
  //
  // Same-game parlays have correlated legs that independent multiplication
  // doesn't capture. ML/spread + total on the same game are positively
  // correlated (favorites covering → more scoring → pushes over).
  //
  // Two-layer approach:
  //   1. Correlation discount: 3% implied prob boost on ML/spread + total
  //      SGP pairs. Calibrated from DK (+240 on Rangers ML + Over 9) vs
  //      independent (+253). DK discounts ~4%, Bookmaker ~0%, we split at 3%.
  //   2. Pin-match floor: if Pinnacle data available, ensure we never
  //      offer better than Pinnacle raw compound minus 0.5% edge.
  //      max(correlation-adjusted, pin-match) ensures we take the tighter
  //      of the two signals.
  // ---------------------------------------------------------------------
  let pricingMethod = 'perLegVig';
  let pinRawCompound = null;
  let pinMatchTarget = null;

  // SGP flag — already computed above as isSGPParlay. Kept here for
  // backwards-compat naming in the blocks below (Pin-match floor etc.).
  const isSGP = isSGPParlay;

  if (isSGP) {
    // PX rejects any SGP offer priced above its internal correlation model
    // with "invalid estimated prices". Apr 2026 test: any boost → rejection,
    // zero boost → ~99% acceptance. We let PX's own correlation handling
    // price the dependency and only enforce a Pin-match floor below.

    // --- Pin-match floor ---
    // Compute Pinnacle raw compound implied prob using DNB-adjusted values
    // where applicable (soccer 2-way moneylines). If Pin data available,
    // ensure we don't offer better than Pin raw minus 0.5%.
    const pinLegs = pricedLegs.filter(l => l.pinnacleOdds != null);
    const havePinAll = pinLegs.length === pricedLegs.length;

    if (havePinAll) {
      let pinProb = 1;
      for (const l of pricedLegs) {
        // isDNB alone misses soccer h2h legs PX names plainly "Moneyline"
        // — see bookImpliedForLeg.
        const legImpl = pinImplied(l);
        pinProb *= legImpl;
      }
      if (pinProb > 0 && pinProb < 1) {
        pinRawCompound = pinProb;
        // Target 0.5% bettor edge below Pin raw compound
        pinMatchTarget = pinRawCompound * (1 - 0.005);
        if (pinMatchTarget > offeredImpliedProb) {
          log.info('Pricing', `SGP pin-match tightening: ${(offeredImpliedProb*100).toFixed(2)}% → ${(pinMatchTarget*100).toFixed(2)}% (Pin raw ${(pinRawCompound*100).toFixed(2)}%)`);
          offeredImpliedProb = pinMatchTarget;
          pricingMethod = 'sgp_pin_match';
        } else {
          pricingMethod = 'sgp_pin_match_keep_baseline';
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // CATASTROPHIC-MISPRICING CIRCUIT BREAKER
  //
  // After all pricing logic has run, cross-check the OFFERED implied prob
  // against the naive book-consensus compound (no de-vig, just raw book
  // implied products). If we're selling at a dramatically lower implied
  // prob than the books collectively suggest, something is structurally
  // broken — a compounding bug, a sign-flip, a misread line, etc.
  //
  // Motivation: Delphi Apr-2026 case study where a maker offered $0.10 on
  // a 4-leg NHL parlay whose book-raw compound was ~$0.80+ and kept
  // offering it for 95 minutes across 142 fills losing $170k. The fair
  // sanity check (v1 "PRICING SAFETY NET" above) runs BEFORE vig is
  // applied and would not catch a post-vig error that blows up the
  // offered price.
  //
  // Threshold 0.60: under normal operation our offered ≈ 0.95-1.10× book
  // raw (we add slightly more vig than books do on average, but same
  // order of magnitude). Anything below 60% is a strong signal of
  // structural bug. Declines with 'suspected mispricing' reason and
  // logs loudly so the operator can investigate.
  //
  // Runs only when we have book data for every leg. Single-book legs
  // still count — correlated bias in one book is rare enough that
  // a dramatic undercut relative to even a single book is worth
  // flagging.
  // ---------------------------------------------------------------------
  {
    let bookCompound = 1;
    let allLegsHaveBooks = true;
    for (const l of pricedLegs) {
      // DNB-aware per book. Previously this used the RAW 3-way price for every
      // book, which on soccer makes bookCompound far too small, inflates
      // `ratio` and so stops this guard from ever firing on DNB parlays —
      // failing OPEN on the one product where our price diverges most.
      const probs = [
        bookImpliedForLeg(l, 'pinnacleOdds', 'pinnacleDNBProb'),
        bookImpliedForLeg(l, 'fanduelOdds', 'fanduelDNBProb'),
        bookImpliedForLeg(l, 'draftkingsOdds', 'draftkingsDNBProb'),
      ].filter(p => p != null && p > 0 && p < 1);
      if (probs.length === 0) { allLegsHaveBooks = false; break; }
      const legAvg = probs.reduce((s, p) => s + p, 0) / probs.length;
      bookCompound *= legAvg;
    }
    if (allLegsHaveBooks && bookCompound > 0 && offeredImpliedProb > 0) {
      const ratio = offeredImpliedProb / bookCompound;
      const SANITY_FLOOR = 0.60;
      if (ratio < SANITY_FLOOR) {
        log.error('Pricing', `CATASTROPHIC MISPRICE BLOCK: offered ${(offeredImpliedProb*100).toFixed(2)}% vs book-raw compound ${(bookCompound*100).toFixed(2)}% (ratio ${ratio.toFixed(3)}) — declining. Legs: ${pricedLegs.map(l => `${l.lineInfo.teamName}/${l.lineInfo.marketType}${l.lineInfo.line!=null?' '+l.lineInfo.line:''}`).join(' + ')}`);
        priceParlay._lastFailure = {
          reason: 'suspected mispricing',
          detail: `offered ${(offeredImpliedProb*100).toFixed(2)}% is ${((1-ratio)*100).toFixed(0)}% below book-raw compound ${(bookCompound*100).toFixed(2)}% — possible compounding/sign-flip bug`,
          blockerLeg: null,
        };
        return null;
      }
    }
  }

  // -------------------------------------------------------------------
  // MINIMUM THEO EDGE GATE — decline if final edge is below the floor.
  //
  // After all pricing adjustments, edge = (offered − fair) / fair × 100.
  // Calibration data shows ≤1% theo-edge quotes are systematically
  // money-losing (z=−4.33, +501–1000 range): model estimation error
  // consumes the margin. Default 0 (disabled); set MIN_THEO_EDGE_PCT=1.0
  // to cut the low-edge tail. Measured against fairParlayProb so the gate
  // moves with volatility — tight-odds parlays need less pp to clear 1%
  // edge than long-shot parlays.
  // -------------------------------------------------------------------
  const minTheoEdgePct = config.pricing.minTheoEdgePct || 0;
  if (minTheoEdgePct > 0 && fairParlayProb > 0) {
    const theoEdge = (offeredImpliedProb - fairParlayProb) / fairParlayProb * 100;
    if (theoEdge < minTheoEdgePct) {
      priceParlay._lastFailure = {
        reason: 'below-min-edge',
        detail: `theo edge ${theoEdge.toFixed(2)}% < floor ${minTheoEdgePct}%`,
        blockerLeg: null,
      };
      return null;
    }
  }

  // Cap at 0.99 (can't offer 100%+ implied)
  const cappedProb = Math.min(offeredImpliedProb, 0.99);

  // Convert to decimal odds
  const decimalOdds = 1 / cappedProb;

  // Determine max risk. Series-containing parlays get a tighter cap
  // because they tie up bankroll until the series settles (can be weeks).
  // Prop-containing parlays (Phase 2 player_strikeouts) get an even
  // tighter cap because we're still proving +EV at small size and
  // single-pitcher concentration risk is unknown. The smallest cap
  // applicable wins (series cap doesn't compound with prop cap).
  // max_risk on the offer is what PX uses to bound bettor wagers, so
  // setting it here enforces the per-parlay limit at the exchange level.
  const parlayHasSeries = pricedLegs.some(l =>
    typeof l.lineInfo.marketType === 'string' &&
    l.lineInfo.marketType.startsWith('series_')
  );
  // Detect any player_<type> leg, not just player_strikeouts. Earlier
  // version of this check only matched K-prop, so the new Phase-2 prop
  // types (player_points/rebounds/assists/threes_made/shots_on_goal)
  // were going out with the standard maxRiskPerParlay cap instead of
  // the much smaller prop-aware maxRiskPerParlayWithProp cap. Caused
  // the first confirmed prop fill (Hart REB + Tatum AST cross-game)
  // to land at $90.4 SP risk despite a configured $50 prop cap.
  const parlayHasProp = pricedLegs.some(l =>
    typeof l.lineInfo.marketType === 'string' &&
    /^player_/.test(l.lineInfo.marketType)
  );
  // RFI (Run First Inning) is a fresh, uncalibrated market — cap any parlay
  // carrying an RFI leg at the small prop-aware limit, same as player props.
  const parlayHasRfi = pricedLegs.some(l =>
    l.lineInfo.marketType === 'run_first_inning'
  );
  const candidateCaps = [config.pricing.maxRiskPerParlay];
  if (parlayHasSeries) candidateCaps.push(config.pricing.maxSeriesRiskPerParlay || 500);
  if (parlayHasProp) candidateCaps.push(config.pricing.maxRiskPerParlayWithProp || 50);
  // RFI gets its own (tighter) launch cap, independent of the prop cap.
  if (parlayHasRfi) candidateCaps.push(config.pricing.maxRiskPerParlayWithRfi || 25);
  // Experimental-SGP tier (SGP roadmap): combos under small-test rollout get
  // a much tighter per-ticket cap. Shape identifies the CLASS (nested pairs
  // → 'prop_nested', immune to classification gaps); membership in
  // SGP_EXPERIMENTAL_COMBOS decides whether that class is still in the
  // small-test tier — so removing a class from the experimental set
  // graduates its cap without code changes. min() with the caps above —
  // existing parlay types unaffected.
  const _expCombos = config.pricing.experimentalSgpCombos;
  const _isExperimentalParlay = !!_expCombos && (
    (opts.sgpCombo && _expCombos.has(opts.sgpCombo)) ||
    (nestedPairCount > 0 && _expCombos.has('prop_nested')) ||
    (xteamPairCount > 0 && _expCombos.has('prop_prop_xteam'))
  );
  if (_isExperimentalParlay) {
    candidateCaps.push(config.pricing.maxRiskSgpExperimental || 15);
  }

  // ---- NEGATIVE BETTOR-SIDE ODDS (parlay prob > 50%) ----
  // Historically declined outright: "PX cannot handle negative bettor-side odds
  // — it flips the sign and overpays" (guard added 2026-04-08). PX has since
  // confirmed negative bettor odds ARE supported (operator, 2026-07-15), so we
  // enable them — but ONLY for all-golf-outright parlays, and on a tight cap.
  //
  // Why it matters: make_cut favourites are 80%+ EACH, so any two of them exceed
  // 50% and the bettor's price is negative. That made the parlays operators and
  // PX staff actually reach for (McIlroy + Fitzpatrick = 70%) permanently
  // unquotable.
  //
  // Why the cap: the old claim, IF true, is catastrophic rather than marginal.
  // On a 70% parlay priced -238, PX honouring the sign gives the bettor -1.4 EV
  // per $100 (we profit); PX flipping it to +238 gives the bettor +136.6 EV per
  // $100 (we get destroyed). So this rides the same small-test shape as RFI /
  // experimental SGP until a REAL fill proves the sign: check a settled
  // negative-odds parlay's confirmed_odds — |confirmed| must equal |offered| and
  // the sign must be OPPOSITE. Once proven, raise VIG-free via
  // NEG_ODDS_MAX_RISK or drop the cap entirely.
  const _negOddsAllowed = config.pricing.allowNegativeBettorOdds;
  const _allOutrightNeg = pricedLegs.length > 0 && pricedLegs.every(l => l.lineInfo && l.lineInfo.sport === 'golf_outrights');
  const _isNegativeBettorOdds = decimalOdds < 2.0;
  if (_isNegativeBettorOdds) {
    if (!(_negOddsAllowed && _allOutrightNeg)) {
      log.debug('Pricing', `Declined: negative bettor odds (decimal ${decimalOdds.toFixed(3)}, prob ${(cappedProb*100).toFixed(1)}%) — not enabled for this parlay shape`);
      priceParlay._lastFailure = {
        reason: 'negative odds',
        detail: `parlay prob ${(cappedProb*100).toFixed(1)}% > 50% → negative bettor odds`
          + (_negOddsAllowed ? ' (allowed only for all-golf-outright parlays)' : ' (ALLOW_NEGATIVE_BETTOR_ODDS not enabled)'),
        blockerLeg: null,
      };
      return null;
    }
    // Small-test cap while the sign convention is unproven in production.
    candidateCaps.push(config.pricing.negOddsMaxRisk || 25);
  }
  const maxRisk = Math.min(...candidateCaps);

  const americanOdds = decimalToAmerican(decimalOdds);

  // Decline heavy favorite moneyline legs — originally a guard against a PX
  // sign-flip that overpaid heavy chalk. Per-sport caps are now config-driven
  // (HEAVY_FAV_ML_CAP_BY_SPORT; defaults NBA -300, tennis/MMA -450 preserve the
  // historical hardcoded values — loosened 2026-05-11 by Mike from -250/-350).
  // A sport absent from the map, or set to 0, has NO cap. The cap is American
  // odds (negative); the decline threshold prob = |cap|/(|cap|+100)
  // (e.g. -300 -> 0.75, -450 -> 0.8182, -600 -> 0.8571). Chalk-shaped vig knobs
  // (VIG_HEAVY_FAV_FAIR_MARKUP / VIG_FAIR_MULTIPLIER / chalk-stack surcharge)
  // still make these heavier favorites pay up when they DO quote.
  const mlCaps = config.pricing.heavyFavMlCapBySport || {};
  for (const leg of pricedLegs) {
    if (leg.lineInfo.marketType !== 'moneyline') continue;
    const cap = mlCaps[leg.lineInfo.sport];
    if (cap == null || cap === 0) continue; // no cap configured for this sport
    const absCap = Math.abs(cap);
    const threshold = cap < 0 ? absCap / (absCap + 100) : 100 / (absCap + 100);
    if (leg.fairProb > threshold) {
      const impliedOdds = leg.fairProb >= 0.5 ? Math.round(-100 * leg.fairProb / (1 - leg.fairProb)) : Math.round(100 * (1 - leg.fairProb) / leg.fairProb);
      log.debug('Pricing', `Declined: ${leg.lineInfo.sport} moneyline ${leg.lineInfo.teamName} heavy favorite (${impliedOdds}) exceeds ${cap} cap`);
      priceParlay._lastFailure = {
        reason: `${leg.lineInfo.sport} heavy favorite`,
        detail: `${leg.lineInfo.teamName} at ${impliedOdds} exceeds ${cap} cap (fair ${(leg.fairProb*100).toFixed(1)}% > ${(threshold*100).toFixed(1)}%)`,
        blockerLeg: { team: leg.lineInfo.teamName, sport: leg.lineInfo.sport, market: 'moneyline' },
      };
      return null;
    }
  }

  // Don't quote on very high odds parlays — even small stakes create huge payouts
  // Golf OUTRIGHTS get their own (higher) cap: they are longshots BY NATURE, so
  // the global +1500 blocks essentially every legitimate outright parlay — a
  // 2-leg Top 5 of two of the best players in the field prices at +2196 and was
  // refused (operator report 2026-07-15). Only applied when EVERY leg is an
  // outright, so a golf leg can't be used to smuggle a mixed parlay past the
  // normal cap. Risk is still bounded by maxRisk/stake caps, which is the real
  // control on payout size — this cap is about odds shape, not exposure.
  const _allOutright = pricedLegs.length > 0 && pricedLegs.every(l => l.lineInfo && l.lineInfo.sport === 'golf_outrights');
  // Method-of-victory parlays are exempt from the odds cap entirely (operator
  // directive 2026-07-17: "we do not need to keep to any odds range limits for
  // quoting method of victory markets for parlays"). MoV YES prices are
  // longshots BY NATURE — a single card ran +110 to +3500, and any 2-leg
  // combination blows past even the raised +15000 global. Same containment as
  // the outright branch: only when EVERY leg is MoV, so a method leg can't
  // smuggle a mixed parlay past the normal cap. Exposure stays bounded by
  // maxRisk/stake caps, which are the real control on payout size.
  const _allMov = pricedLegs.length > 0 && pricedLegs.every(l => l.lineInfo && MOV_MARKET_TYPES.has(l.lineInfo.marketType));
  const _globalMaxOdds = config.pricing.maxOdds || 1000;
  // RAISES the cap for all-outright parlays, never LOWERS it. Must be a
  // Math.max against the global: the operator raised MAX_ODDS to 15000
  // (2026-07-15) and the outright branch — which exists to be MORE permissive —
  // silently overrode it back down to 6000 for exactly the parlays it was meant
  // to help. A per-sport override that can undercut the global is a trap; if
  // someone sets MAX_ODDS above the outright default, honour it.
  const maxOdds = _allMov
    ? Infinity
    : _allOutright
      ? Math.max(_globalMaxOdds, config.pricing.maxOddsGolfOutrights || 6000)
      : _globalMaxOdds;
  if (americanOdds > maxOdds) {
    log.debug('Pricing', `Declined: odds +${americanOdds} exceed max +${maxOdds}`);
    priceParlay._lastFailure = {
      reason: 'odds too high',
      detail: `offered +${americanOdds} > max +${maxOdds}`,
      blockerLeg: null,
    };
    return null;
  }

  // PX RULE 2 (Anthony/PX 2026-06-25): the per-leg probabilities we report must
  // MULTIPLY to the parlay's implied prob. Distribute the full parlay price
  // (vig + ramps + SGP correlation, all baked into cappedProb) across the legs
  // so their product === cappedProb. Attach to each priced leg so both the
  // offer's estimated_price AND the confirmation use the SAME reconciling probs.
  const _legBaseProbs = pricedLegs.map(l => (l.bookPriceOverride != null ? l.bookPriceOverride : l.fairProb));
  const _legConfirmProbs = distributeLegProbs(_legBaseProbs, cappedProb);
  pricedLegs.forEach((l, i) => { l._legConfirmProb = _legConfirmProbs[i]; });

  // Build estimated_price (per-leg breakdown) — per-leg probs whose product
  // equals the offered parlay implied prob, so PX's reconciliation passes.
  // Falls back to the legacy per-leg vig only if distribution was unusable.
  const estimatedPrice = pricedLegs.map((leg, i) => {
    const legImplied = (_legConfirmProbs[i] != null && _legConfirmProbs[i] > 0)
      ? _legConfirmProbs[i]
      : (leg.bookPriceOverride != null
          ? leg.bookPriceOverride
          : applyOddsVig(leg.fairProb, leg.lineInfo.sport, leg.lineInfo.marketType, leg.vigBump || 0));
    return { line_id: leg.lineId, odds: decimalToAmerican(1 / legImplied) };
  });

  // PX RULE 3 (Anthony/PX 2026-06-25): max_risk is the REQUESTER's stake cap at
  // our quoted price, NOT our payout cap. `maxRisk` above is our intended max
  // PAYOUT liability; the stake that produces that payout at the offered odds is
  // payout / (decimal - 1) = payout * p/(1-p), p = offered implied prob. Sending
  // the payout number as the stake cap let a winning requester collect up to
  // payout*(decimal-1) — at +400 that is 4x our intended liability.
  const _offeredP = Math.min(0.999999, Math.max(1e-6, cappedProb));
  const maxRiskStake = Math.max(1, Math.round(maxRisk * _offeredP / (1 - _offeredP)));

  // valid_until in nanoseconds. Prop-containing parlays get the shorter
  // validity window (default 30s vs 60s) — prop prices move on lineup/usage
  // news and a long-lived quote is free option time for the bettor.
  const offerValidSecs = parlayHasProp
    ? (config.pricing.offerValidSecondsProp || config.pricing.offerValidSeconds)
    : config.pricing.offerValidSeconds;
  const validUntil = Math.floor((Date.now() / 1000 + offerValidSecs) * 1e9);

  // Compose phase-level durations for latency instrumentation. Rounded
  // to 0.01ms — sub-microsecond noise isn't useful here.
  const phase3EndMs = performance.now();
  const _timings = {
    // entryToPhase1Ms: time from priceParlay entry to start of sync
    // validation (phaseStartMs). Captures team_total decline loop +
    // any pre-phase1 setup. Should be <0.05ms in steady state.
    entryToPhase1Ms: Math.round((phaseStartMs - entryMs) * 100) / 100,
    phase1Ms: phase1EndMs != null ? Math.round((phase1EndMs - phaseStartMs) * 100) / 100 : null,
    phase2Ms: (phase1EndMs != null && phase2EndMs != null) ? Math.round((phase2EndMs - phase1EndMs) * 100) / 100 : null,
    phase3Ms: phase2EndMs != null ? Math.round((phase3EndMs - phase2EndMs) * 100) / 100 : null,
    // totalInternalMs: total time from entry to end of phase3 marker.
    // Difference vs the websocket-measured priceParlay duration (which
    // includes the await microtask hop on entry + the result-construction/
    // return path + post-return microtask hop) tells us the V8 overhead.
    totalInternalMs: Math.round((phase3EndMs - entryMs) * 100) / 100,
  };

  // ---------------------------------------------------------------------
  // V2 SHADOW MODE
  //
  // When pricingV2Enabled, run the v2 pipeline alongside v1 and log a
  // side-by-side comparison record. Never affects the live offer (v1
  // number still goes to PX). Gate in template-ramp + longshot-add is
  // passed through so v2 sees the same exposure context as v1.
  //
  // When pricingV2Live is also true, OVERRIDE the v1 americanOdds with
  // v2's computed value. Ships code-dark until Mike flips the flag.
  //
  // Hot-path cost: the v2 pipeline (calibration + correlation +
  // ev-vig) adds ~500-1000µs per quote. That cost is unavoidable when
  // pricingV2Live is true (we need v2's price before returning), but
  // when it's false (pure shadow) we can defer with setImmediate so
  // the offer returns to the WS handler first and v2 computes on the
  // next event loop tick. Observed regression 2026-04-24: p50 went
  // from <1.0ms to ~1.6ms once v2 shadow went wide. This defer path
  // recovers that — the shadow log still populates, just milliseconds
  // later, and nothing downstream reads meta._v2Shadow today.
  // ---------------------------------------------------------------------
  const _v2ShadowArgs = config.pricing.pricingV2Enabled ? {
    parlayId: opts.parlayId || '(unknown)',
    pricedLegs,
    v1OfferedAmericanOdds: americanOdds,
    v1FairParlayProb: fairParlayProb,
    opts: {
      targetEdge: config.pricing.pricingV2TargetEdge,
      kSigma: config.pricing.pricingV2KSigma,
      templateRampAdd: templateRampAdd || 0,
    },
  } : null;
  let _v2Shadow = null;
  if (_v2ShadowArgs) {
    if (config.pricing.pricingV2Live) {
      // Sync path: v2's offered odds may override v1's below. Must block.
      try {
        _v2Shadow = v2.shadowCompare(_v2ShadowArgs);
      } catch (err) {
        log.warn('V2Pricing', `shadow failed: ${err.message}`);
      }
    } else {
      // Async path: pure-shadow, no override possible. Defer so the offer
      // ships first. setImmediate runs on the next event loop tick —
      // after this function returns and the offer is handed to the WS
      // handler for HTTP submission to PX.
      setImmediate(() => {
        try {
          v2.shadowCompare(_v2ShadowArgs);
        } catch (err) {
          log.warn('V2Pricing', `deferred shadow failed: ${err.message}`);
        }
      });
    }
  }

  // A/B arm assignment. Deterministic by parlayId-hash so the same
  // parlay always lands in the same arm (important for retry semantics
  // and settlement attribution). Recorded in meta.abArm REGARDLESS of
  // whether v2 actually overrides — keeps shadow records attributable
  // to arms even before we flip pricingV2Live on.
  //   - pricingV2LivePercent 0  → every parlay is 'v1'
  //   - pricingV2LivePercent 50 → 50/50 split
  //   - pricingV2LivePercent 100 → every parlay is 'v2'
  // Override only actually fires when pricingV2Live is ALSO true —
  // that's the master kill-switch.
  //
  // Hash uses md5 over the full parlayId rather than parseInt on the
  // first 8 hex chars. Why: parlayIds are UUIDv7, where the first 12
  // hex chars encode the timestamp in ms. First-8-hex only advances
  // ~1 per 65s, so at 5% target the hash spends ~104 min in the
  // >=5 band before cycling back — yielding long "freeze" windows
  // where no parlay gets assigned v2. md5 mixes all bits uniformly
  // so assignment is per-parlay-random, not per-65s-bucket.
  const _livePct = config.pricing.pricingV2LivePercent || 0;
  let abArm = 'v1';
  if (opts.parlayId && _livePct > 0) {
    if (_livePct >= 100) {
      abArm = 'v2';
    } else {
      const h = crypto.createHash('md5').update(String(opts.parlayId)).digest();
      const n = h.readUInt32BE(0);
      if ((n % 100) < _livePct) abArm = 'v2';
    }
  }

  // If v2 is LIVE and this parlay is in the v2 arm, replace the offer's
  // odds with v2's result. Records v2Used in meta so A/B metrics can
  // distinguish "assigned to v2 arm" from "actually got v2 price"
  // (they differ when pricingV2Live is false but assignment still runs).
  let finalAmericanOdds = americanOdds;
  let finalOfferedImpliedProb = offeredImpliedProb;
  let v2Used = false;
  if (config.pricing.pricingV2Live && abArm === 'v2' && _v2Shadow && _v2Shadow.v2.offeredAmericanOdds != null) {
    finalAmericanOdds = _v2Shadow.v2.offeredAmericanOdds;
    finalOfferedImpliedProb = _v2Shadow.v2.offeredImpliedProb;
    v2Used = true;
    log.info('V2Pricing', `live[${abArm}]: v1=${americanOdds} → v2=${finalAmericanOdds} (Δ ${finalAmericanOdds - americanOdds})`);
  }

  return {
    offer: {
      valid_until: validUntil,
      odds: finalAmericanOdds, // American odds for PX
      max_risk: maxRiskStake, // RULE 3: requester stake cap (not our payout cap)
      estimated_price: estimatedPrice,
    },
    meta: {
      _timings,
      abArm,
      v2Used,
      // Quote timestamp — consumed by validateForConfirmation's bounded
      // fail-open (a reprice failure only rides the original quote when the
      // quote is younger than the staleness budget for its leg types).
      quotedAtMs: Date.now(),
      _v2Shadow: _v2Shadow ? {
        v1American: _v2Shadow.v1.offeredAmericanOdds,
        v2American: _v2Shadow.v2.offeredAmericanOdds,
        americanDelta: _v2Shadow.delta.americanOddsDelta,
        v2FairParlay: _v2Shadow.v2.parlayFairProb,
        v2CorrelationLift: _v2Shadow.v2.correlationLift,
        v2Uncertainty: _v2Shadow.v2.parlayUncertainty,
        v2EffectiveEdge: _v2Shadow.v2.effectiveEdge,
        calibrationApplied: _v2Shadow.v2.calibrationApplied,
        liveMode: !!config.pricing.pricingV2Live,
      } : null,
      legs: pricedLegs.map(l => {
        // For totals/spreads, build a descriptive label: "Over 6.5 (NYM vs CHC)"
        let team = l.lineInfo.teamName;
        // Capitalize first letter (PX sends "over"/"under" lowercase for totals)
        if (team) team = team.charAt(0).toUpperCase() + team.slice(1);
        const event = l.lineInfo.pxEventName || '';
        if (l.lineInfo.marketType === 'total' && l.lineInfo.homeTeam && l.lineInfo.awayTeam) {
          team = `${team} (${l.lineInfo.awayTeam} @ ${l.lineInfo.homeTeam})`;
        }
        // TRUE per-leg offered implied prob — stored so the Single-Leg
        // Pricing chart can plot our ACTUAL curve. The chart used to
        // reconstruct "My Offer" from legVig via the payout-vig formula
        // alone (offered = p/(1-(1-p)·v)), whose pp-distance is
        // geometrically flat/decreasing (≈ p·(1-p)·v, a parabola peaking
        // at p=0.5). That hid the books-shaped favorite markup entirely,
        // so any VIG_HEAVY_FAV_FAIR_MARKUP / VIG_FAIR_MULTIPLIER widening
        // was invisible on the chart even when it was firing on the price.
        // Mirror the same MAX gates priceParlay applies per-leg
        // (payout-vig MAX fair×(1+fairMult) MAX fair×(1+heavyFavMarkup))
        // so the stored value equals our real per-leg contribution.
        // Parlay-level ramps (longshot, leg-count) have no per-leg
        // attribution and are intentionally excluded.
        let legOfferedProb = null;
        if (l.bookPriceOverride != null) {
          legOfferedProb = l.bookPriceOverride;
        } else if (l.fairProb > 0 && l.fairProb < 1) {
          const _fp = l.fairProb;
          const _v = getEffectiveVig(_fp, l.lineInfo.sport, l.lineInfo.marketType, l.vigBump || 0);
          let _off = 1 / (1 + (1 / _fp - 1) * (1 - _v)); // payout-vig
          if (fairMult > 0) { const m = _fp * (1 + fairMult); if (m > _off && m < 0.99) _off = m; }
          if (heavyFavMarkup > 0 && _fp > heavyFavThreshold) { const m = _fp * (1 + heavyFavMarkup); if (m > _off && m < 0.99) _off = m; }
          legOfferedProb = Math.min(0.99, _off);
        }
        return {
          lineId: l.lineId,
          team,
          market: l.lineInfo.marketType,
          marketName: l.lineInfo.marketName || null,
          isDNB: l.lineInfo.isDNB || false,
          selection: l.lineInfo.oddsApiSelection,
          line: l.lineInfo.line,
          fairProb: Math.round(l.fairProb * 10000) / 10000,
          legVig: l.bookPriceOverride != null ? 0 : Math.round(getEffectiveVig(l.fairProb, l.lineInfo.sport, l.lineInfo.marketType, l.vigBump || 0) * 10000) / 10000,
          // True per-leg offered implied (payout-vig + favorite markup, MAX-gated).
          // The Single-Leg chart prefers this over reconstructing from legVig.
          legOfferedProb: legOfferedProb != null ? Math.round(legOfferedProb * 100000) / 100000 : null,
          // RULE 2 reconciling per-leg prob: Π(legConfirmProb) === parlay implied prob.
          // Sent to PX in the confirmation so per-leg probs multiply to the parlay odds.
          legConfirmProb: l._legConfirmProb != null ? Math.round(l._legConfirmProb * 1000000) / 1000000 : null,
          bookPriceOverride: l.bookPriceOverride != null ? Math.round(l.bookPriceOverride * 10000) / 10000 : null,
          displayFairProb: l.displayFairProb ? Math.round(l.displayFairProb * 10000) / 10000 : null,
          pinnacleOdds: l.pinnacleOdds || null,
          fanduelOdds: l.fanduelOdds || null,
          kalshiOdds: l.kalshiOdds || null,
          draftkingsOdds: l.draftkingsOdds || null,
          // DNB-adjusted per-book implied probs for soccer 2-way parlay compound.
          // Null for non-DNB legs (use standard americanToProb(odds) instead).
          pinnacleDNBProb: l.pinnacleDNBProb != null ? Math.round(l.pinnacleDNBProb * 10000) / 10000 : null,
          fanduelDNBProb: l.fanduelDNBProb != null ? Math.round(l.fanduelDNBProb * 10000) / 10000 : null,
          kalshiDNBProb: l.kalshiDNBProb != null ? Math.round(l.kalshiDNBProb * 10000) / 10000 : null,
          draftkingsDNBProb: l.draftkingsDNBProb != null ? Math.round(l.draftkingsDNBProb * 10000) / 10000 : null,
          // Golf matchup metadata — drives the R1/R2/Tournament tag in the
          // dashboard. Null on non-golf legs.
          roundNum: l.lineInfo.roundNum ?? null,
          matchupType: l.lineInfo.matchupType ?? null,
          tournamentName: l.lineInfo.tournamentName ?? null,
          sport: l.lineInfo.sport,
          homeTeam: l.lineInfo.homeTeam,
          awayTeam: l.lineInfo.awayTeam,
          startTime: l.lineInfo.startTime || null,
          pxEventId: l.lineInfo.pxEventId || null,
          pxEventName: l.lineInfo.pxEventName || null,
          onDemand: l.lineInfo.onDemand || false,
        };
      }),
      vig: Math.round(pricedLegs.reduce((s, l) => s + getEffectiveVig(l.fairProb, l.lineInfo.sport, l.lineInfo.marketType, l.vigBump || 0), 0) / pricedLegs.length * 10000) / 10000,
      // Which vig application mode was used for this quote. Recorded per-quote
      // so /market-intel can split win rate by mode for A/B analysis.
      vigMode,
      vigRateUsed: Math.round((vigRateUsed || 0) * 10000) / 10000,
      // Additional vig added by longshot ramp (parlay-level, applied when
      // parlay fair prob < vigLongshotThreshold). 0 when not triggered.
      // Exposed so dashboard can flag which quotes used the ramp and we
      // can A/B measure acceptance-rate impact.
      longshotAdd: Math.round((longshotAdd || 0) * 10000) / 10000,
      // Template-exposure ramp contribution + prior-confirmation count
      // for the quote's canonical parlay signature. 0 / 0 when ramp
      // didn't fire. Lets the dashboard flag quotes penalized for
      // template stacking and retroactively measure whether we actually
      // lost volume on the 2nd/3rd/4th-of-identical bets.
      templateRampAdd: Math.round((templateRampAdd || 0) * 10000) / 10000,
      // Implied-prob added by the near-lock concentration surcharge. 0 means
      // the ticket was not the lock+coinflip shape (or the surcharge is off).
      // Non-zero is the only way to confirm the guard is live, since the flow
      // it targets has been dormant since 2026-07-30.
      lockConcentrationAdd: Math.round((lockConcentrationAdd || 0) * 10000) / 10000,
      // Implied-prob added by the longshot vig floor, and which floor bound.
      // 0 / null when the floor is off or didn't bind. Lets us measure the
      // VIG_MIN_PP / VIG_MIN_ROI experiment against retention directly.
      vigFloorAdd: Math.round((vigFloorAdd || 0) * 10000) / 10000,
      vigFloorWhich,
      // Per-prop-type leg-fair calibration adjustments applied (empty when off).
      propFairCalibs: propFairCalibs.length ? propFairCalibs : undefined,
      templatePriorCount: templatePriorCount || 0,
      fairParlayProb: Math.round(fairParlayProb * 100000) / 100000,
      pricingMethod,
      isSGP,
      // Same-game parlay tracking: which combo (spread_total, ml_total, etc.)
      // and how much we amplified vig. `sgpCombo` is set upstream by
      // shouldDecline when the parlay is a 2-leg same-event combo we
      // allow-listed; it flows through opts so priceParlay can record it.
      sgpCombo: opts.sgpCombo || null,
      sgpVigMultiplier: isSGP ? sgpVigMult : 1,
      // Nested-implication collapse (Stage 1): pairs detected from leg
      // shape and the fair multiplier applied (1/p_weak per pair). >1 means
      // joint was collapsed to the strong leg(s) — exact pricing.
      nestedPairs: nestedPairCount || 0,
      nestedFairMultiplier: nestedFairMultiplier !== 1 ? Math.round(nestedFairMultiplier * 10000) / 10000 : 1,
      // Cross-team pair band-top lift (Stage 2) — shape-detected.
      xteamPairs: xteamPairCount || 0,
      xteamFairMultiplier: xteamFairMultiplier !== 1 ? Math.round(xteamFairMultiplier * 10000) / 10000 : 1,
      // Correlation adjustment applied to the joint fair prob for this SGP
      // before vig. Null if not an SGP or not a recognized combo. Stored
      // so /sgp-stats + order audits can split acceptance + ROI by
      // correlation sign as we tune the factors.
      sgpCorrelationSign: sgpCorrelationSign,
      sgpCorrelationFactor: sgpCorrelationFactor,
      pinRawCompound: pinRawCompound != null ? Math.round(pinRawCompound * 100000) / 100000 : null,
      pinMatchTarget: pinMatchTarget != null ? Math.round(pinMatchTarget * 100000) / 100000 : null,
      offeredImpliedProb: Math.round(cappedProb * 100000) / 100000,
      decimalOdds: Math.round(decimalOdds * 100) / 100,
      americanOdds,
      // Compute competitor book parlay odds from per-leg book implied probs.
      // For DNB legs (soccer 2-way moneyline), use the DNB-adjusted per-book
      // implied (pinHome / (pinHome + pinAway)) instead of the raw 3-way home
      // implied. This makes the comparison apples-to-apples: our DNB offer
      // vs. the book's DNB-equivalent parlay. Previously we compounded raw
      // 3-way implied, producing a misleadingly loose "Pinnacle parlay" number
      // that looked ~200 American points better than our DNB offer.
      pinnacleParlay: (() => {
        const pinLegs = pricedLegs.filter(l => l.pinnacleOdds != null);
        if (pinLegs.length !== pricedLegs.length) return null;
        let pinProb = 1;
        for (const l of pinLegs) {
          // isDNB alone misses soccer h2h legs PX names plainly "Moneyline"
          // — see bookImpliedForLeg.
          const legImpl = pinImplied(l);
          pinProb *= legImpl;
        }
        if (pinProb <= 0 || pinProb >= 1) return null;
        return decimalToAmerican(1 / pinProb);
      })(),
      kalshiParlay: (() => {
        const klLegs = pricedLegs.filter(l => l.kalshiOdds != null);
        if (klLegs.length !== pricedLegs.length) return null;
        let klProb = 1;
        for (const l of klLegs) {
          const legImpl = l.lineInfo.isDNB && l.kalshiDNBProb != null
            ? l.kalshiDNBProb
            : oddsFeed.americanToImpliedProb(l.kalshiOdds);
          klProb *= legImpl;
        }
        if (klProb <= 0 || klProb >= 1) return null;
        return decimalToAmerican(1 / klProb);
      })(),
      draftkingsParlay: (() => {
        const dkLegs = pricedLegs.filter(l => l.draftkingsOdds != null);
        if (dkLegs.length !== pricedLegs.length) return null;
        let dkProb = 1;
        for (const l of dkLegs) {
          const legImpl = l.lineInfo.isDNB && l.draftkingsDNBProb != null
            ? l.draftkingsDNBProb
            : oddsFeed.americanToImpliedProb(l.draftkingsOdds);
          dkProb *= legImpl;
        }
        if (dkProb <= 0 || dkProb >= 1) return null;
        return decimalToAmerican(1 / dkProb);
      })(),
      fanduelParlay: (() => {
        const fdLegs = pricedLegs.filter(l => l.fanduelOdds != null);
        if (fdLegs.length !== pricedLegs.length) return null;
        let fdProb = 1;
        for (const l of fdLegs) {
          const legImpl = l.lineInfo.isDNB && l.fanduelDNBProb != null
            ? l.fanduelDNBProb
            : oddsFeed.americanToImpliedProb(l.fanduelOdds);
          fdProb *= legImpl;
        }
        if (fdProb <= 0 || fdProb >= 1) return null;
        return decimalToAmerican(1 / fdProb);
      })(),
      maxRisk,
    },
  };
  } // end of _doPhase3
}

/**
 * Quick check if we should even attempt to price this parlay.
 */
// ---------------------------------------------------------------------------
// NESTED IMPLICATION PAIRS (SGP roadmap Stage 1 — exact pricing, zero
// dependence risk).
//
// Two same-player, same-game prop legs where one outcome logically IMPLIES
// the other have joint probability EXACTLY equal to the implying ("strong")
// leg's probability: P(A ∧ B) = P(A) when A ⊆ B. No correlation estimation,
// no model risk — arithmetic. Priced naively as a product these are the
// single most exploitable SGP shape (e.g. goalscorer + SoT1+ as a product
// gifts ~+14% bettor ROI), so the table is also a trap-closer.
//
// SIDE-KEYED and OVER-ONLY by design: only matching-'over' tuples that
// satisfy a whitelisted implication qualify. Everything else — under
// pairs, mixed sides (negatively linked!), non-listed stat pairs — stays
// under the existing same-player block. K-prop ladders are excluded so
// the same-pitcher rule's territory is untouched.
//
// Launch-gated: pairs only quote when 'prop_nested' is present in
// SGP_ALLOWED_COMBOS (env, operator-controlled — NOT auto-included).
// ---------------------------------------------------------------------------
// pitcher_strikeouts: K ladders stay under the same-pitcher rule's territory.
// hitter_rbi_runs: classifyMlbProp CONFLATES two different stats (RBIs and
// Runs Scored) into this one propType — a same-player "ladder" could pair
// RBI Over 1.5 with Runs Over 0.5, which is NOT an implication (review
// finding). The HR⇒hitter_rbi_runs cross rule at 0.5/0.5 stays valid: a HR
// credits the batter ≥1 RBI AND ≥1 run, so it implies either reading.
const _NESTED_LADDER_EXCLUDED_PROPTYPES = new Set(['pitcher_strikeouts', 'hitter_rbi_runs']);
// Cross-stat implication rules: strong propType ⇒ weak propType, with a
// line condition (ls = strong leg line, lw = weak leg line; anytime YES
// markets register at 0.5).
const _NESTED_CROSS_RULES = [
  // A goal IS a shot on target (Opta convention; own goals excluded from
  // both player-GS and the scorer's SoT, so the implication is clean).
  // GS does NOT imply SoT 2+ (the goal contributes exactly one SoT).
  //
  // SETTLEMENT-VERIFICATION GATE: this is the only table entry whose
  // implication crosses two DIFFERENT stat feeds (GS grading vs SoT
  // grading) — every other rule is same-feed arithmetic. Per the roadmap
  // ("any pair unverifiable for a grading window stays dark"), it stays
  // OFF until the operator confirms on one graded match that PX settles
  // a scorer's SoT 1+ YES (env SGP_NESTED_SOCCER_GS_SOT=true to enable).
  { sport: (s) => s === 'soccer' || s.startsWith('soccer_'), strong: 'goalscorer', weak: 'sot_1', cond: () => process.env.SGP_NESTED_SOCCER_GS_SOT === 'true' },
  { sport: (s) => s === 'soccer' || s.startsWith('soccer_'), strong: 'sot_2', weak: 'sot_1', cond: () => true },
  // NHL points = goals + assists: N goals (or assists) ⇒ ≥N points.
  { sport: (s) => s === 'icehockey_nhl', strong: 'goals', weak: 'points', cond: (ls, lw) => ls >= lw },
  { sport: (s) => s === 'icehockey_nhl', strong: 'assists', weak: 'points', cond: (ls, lw) => ls >= lw },
  // MLB: a HR is a hit; a HR credits the batter ≥1 RBI; a HR is 4 total bases.
  { sport: (s) => s === 'baseball_mlb', strong: 'hitter_hr', weak: 'hitter_hits', cond: (ls, lw) => ls === 0.5 && lw === 0.5 },
  { sport: (s) => s === 'baseball_mlb', strong: 'hitter_hr', weak: 'hitter_rbi_runs', cond: (ls, lw) => ls === 0.5 && lw === 0.5 },
  { sport: (s) => s === 'baseball_mlb', strong: 'hitter_hr', weak: 'hitter_total_bases', cond: (ls, lw) => ls === 0.5 && lw <= 3.5 },
  // NBA/WNBA: M made threes ⇒ ≥3M points. Over ls threes = ≥ceil(ls) makes.
  { sport: (s) => s === 'basketball_nba' || s === 'basketball_wnba', strong: 'threes_made', weak: 'points', cond: (ls, lw) => lw <= 3 * Math.ceil(ls) - 0.5 },
];

/**
 * Prop-family bucket for the per-family same-game phi map (sgpPhiByFamily).
 * Correlation with the game script is family-specific — batter run-producing
 * composites ride it far harder than strikeouts — so pairs are keyed by the
 * sorted pair of these buckets (e.g. 'batter_batter', 'kprop_total').
 */
function sgpPropFamily(li) {
  const mt = String((li && li.marketType) || '');
  if (mt === 'player_strikeouts') return 'kprop';
  if (/^player_hitter_/.test(mt)) return 'batter';
  if (/^player_(points|rebounds|assists|threes_made|pra)/.test(mt)) return 'bball';
  if (mt === 'total') return 'total';
  if (/^player_/.test(mt)) return 'prop';
  return 'other';
}

function _nestedNormPlayer(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.'`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Match two lineInfos against the implication table. Returns
 * { strong, weak } (lineInfo refs) when one leg implies the other, else
 * null. Requirements enforced here: same pxEventId, same normalized
 * player, BOTH selections 'over' (YES-style one-sided props register as
 * over), both player_* markets.
 */
function matchNestedPair(a, b) {
  if (!a || !b) return null;
  if (!/^player_/.test(a.marketType || '') || !/^player_/.test(b.marketType || '')) return null;
  if (!a.pxEventId || a.pxEventId !== b.pxEventId) return null;
  if ((a.selection || '') !== 'over' || (b.selection || '') !== 'over') return null;
  const pa = _nestedNormPlayer(a.playerName || a.teamName);
  const pb = _nestedNormPlayer(b.playerName || b.teamName);
  if (!pa || pa !== pb) return null;
  const sport = a.sport || a.oddsApiSport || '';
  if (sport !== (b.sport || b.oddsApiSport || '')) return null;
  const ta = a.propType, tb = b.propType;
  if (!ta || !tb) return null;
  const la = a.line != null ? a.line : 0.5;
  const lb = b.line != null ? b.line : 0.5;
  // Same-stat ladder: higher over-line implies lower over-line.
  if (ta === tb && !_NESTED_LADDER_EXCLUDED_PROPTYPES.has(ta)) {
    if (la > lb) return { strong: a, weak: b };
    if (lb > la) return { strong: b, weak: a };
    return null; // identical line = duplicate leg, not a ladder
  }
  // Cross-stat rules, tried in both orientations.
  for (const r of _NESTED_CROSS_RULES) {
    if (!r.sport(sport)) continue;
    if (ta === r.strong && tb === r.weak && r.cond(la, lb)) return { strong: a, weak: b };
    if (tb === r.strong && ta === r.weak && r.cond(lb, la)) return { strong: b, weak: a };
  }
  return null;
}

function _nestedCombosAllowed() {
  return (config.pricing.sgpAllowedCombos || []).includes('prop_nested');
}

// ---------------------------------------------------------------------------
// CROSS-TEAM PROP PAIRS (SGP roadmap Stage 2 — 'prop_prop_xteam')
// ---------------------------------------------------------------------------
// Two prop legs, same game, DIFFERENT players on OPPOSITE teams (NBA pts-over
// A-team + pts-over B-team; MLB cross-team HR+HR / hits+hits — the #1
// declined-and-competitor-filled shape). Identity comes from the roster
// service and FAILS CLOSED: unknown player, ambiguous name, or unresolvable
// side ⇒ no match ⇒ the same-game block declines as before. Same-TEAM pairs
// (strongest dependence — shared park AND pitcher) stay blocked until the
// Stage-3 oracle confirms their band.
const _XTEAM_ROSTER_SPORTS = new Set(['baseball_mlb', 'basketball_nba', 'basketball_wnba']);

function matchXTeamPair(a, b) {
  if (!a || !b) return null;
  if (!/^player_/.test(a.marketType || '') || !/^player_/.test(b.marketType || '')) return null;
  // K-props NEVER enter the xteam class (review fix — HIGH): opposing-
  // pitcher K+K pairs are player_* legs on opposite MLB teams, so without
  // this exclusion they'd classify as 'prop_prop_xteam' the moment the
  // roster loads — silently DECLINING the live operator-approved
  // kprop_kprop carve-out under the default env (combo dark), repricing
  // in-flight confirms with a one-sided lift (drift rejects), and
  // misledgering the experiment budget when enabled. K pairs keep their
  // dedicated carve-out path (rule (d) + the kprop_kprop key) exactly
  // as before, deterministically, roster or no roster.
  if (a.marketType === 'player_strikeouts' || b.marketType === 'player_strikeouts') return null;
  if (!a.pxEventId || a.pxEventId !== b.pxEventId) return null;
  const sport = a.sport || '';
  if (sport !== (b.sport || '') || !_XTEAM_ROSTER_SPORTS.has(sport)) return null;
  const pa = _nestedNormPlayer(a.playerName || a.teamName);
  const pb = _nestedNormPlayer(b.playerName || b.teamName);
  if (!pa || !pb || pa === pb) return null; // same player = nested/same-player territory
  let sideA = null, sideB = null;
  try {
    const roster = require('./roster');
    sideA = roster.getPlayerSide(sport, a.playerName || a.teamName, a.homeTeam, a.awayTeam);
    sideB = roster.getPlayerSide(sport, b.playerName || b.teamName, b.homeTeam, b.awayTeam);
  } catch (_) { return null; } // roster unavailable — fail closed
  if (!sideA || !sideB) return null;   // unresolved identity — fail closed
  if (sideA === sideB) return null;    // same team — stays blocked (Stage 3)
  return { sides: [sideA, sideB] };
}

function _xteamCombosAllowed() {
  return (config.pricing.sgpAllowedCombos || []).includes('prop_prop_xteam');
}

function shouldDecline(legs, parlayId) {
  // parlayId is OPTIONAL — only used by side-effect-free observability
  // hooks (e.g. SGP shadow logging). Pricing logic must NOT depend on it.
  if (!legs || legs.length === 0) return { declined: true, reason: 'empty parlay', detail: null };

  // Signature cooldown — FIRST gate, independent of the existing template-
  // exposure cooldown which has a state-propagation race. The standalone
  // sig-cooldown module is armed unconditionally at every status='confirmed'
  // assignment site, so once ANY parlay on this signature has confirmed
  // (via order.matched OR order.finalized path) the next same-sig RFQ
  // within SIGNATURE_COOLDOWN_SECONDS declines immediately. Cannot be
  // bypassed by downstream logic.
  try {
    // Lazy-require so a missing module never crashes pricer init.
    const sigCd = require('./sig-cooldown');
    const cd = sigCd.checkSignatureCooldown(legs);
    if (cd && cd.block) {
      const remainSec = Math.ceil(cd.remainingMs / 1000);
      return {
        declined: true,
        reason: 'signature_cooldown',
        detail: `same parlay confirmed ${Math.round(cd.ageMs / 1000)}s ago — cooldown is ${remainSec + Math.round(cd.ageMs / 1000)}s, ${remainSec}s remaining`,
      };
    }
  } catch (_) { /* never let a bug in the cooldown check break pricing */ }

  if (legs.length > config.pricing.maxLegs) {
    return { declined: true, reason: 'too many legs', detail: `${legs.length} legs > max ${config.pricing.maxLegs}` };
  }

  // Dedup: decline if we just quoted this exact leg-set within the window.
  // Bettors can submit the same parlay repeatedly faster than our exposure
  // state updates (race between quote and confirm). Say no on the repeats.
  const dup = orderTracker.checkRecentDuplicate(legs);
  if (dup) {
    return {
      declined: true,
      reason: 'duplicate parlay',
      detail: `identical leg-set quoted ${Math.round(dup.ageMs / 1000)}s ago (60s dedup window)`,
    };
  }

  // Novelty / sub-game market guard. Some PX events are micro-markets like
  // "To Win the Tip Off", "First Basket", "Race to 7 Runs", "Winning Margin",
  // "Method of Victory", "Coin Toss", "First Touchdown", etc. These have
  // fair probabilities completely different from the parent game's
  // moneyline, but our line-manager / pricing pipeline can mistakenly map
  // them to the parent game's ML fair (caught 2026-05-30: a Spurs ML +
  // Spurs Tip-Off ML parlay confirmed @ +447 / 18.28% offered vs ~21%
  // true joint — modeled +2.81% edge but actual -14.9% edge). Asymmetric-
  // risk-correct call: decline rather than risk mis-pricing.
  //
  // Pattern is conservative — explicitly catches confirmed novelty market
  // tokens, avoids broad words like "first inning" (legit MLB sub-game)
  // or "first goal" (could be legit soccer 1st-half) that overlap real
  // markets we already price. Expand cautiously if other patterns surface.
  const NOVELTY_PATTERN = /\b(?:tip\s*off|tipoff|first\s+(?:basket|field\s+goal|fg|touchdown|to\s+score)|race\s+to\s+\d+|winning\s+margin|method\s+of\s+(?:victory|finish|win)|exact\s+(?:score|result)|coin\s+toss|opening\s+(?:kickoff|drive|possession)|first\s+possession)\b/i;
  for (const leg of legs) {
    const lineId = leg.line_id || leg.lineId || leg;
    const lineInfo = lineManager.lookupLine(lineId);
    if (!lineInfo) continue; // main loop handles unknown legs
    const ev = String(lineInfo.pxEventName || '');
    const mn = String(lineInfo.marketName || '');
    if (NOVELTY_PATTERN.test(ev) || NOVELTY_PATTERN.test(mn)) {
      return {
        declined: true,
        reason: 'novelty_market',
        detail: `unsupported sub-game market — pxEventName "${ev}", marketName "${mn}" — would mis-price using parent game's fair (e.g. tip-off ~50% vs full-game ML ~42%)`,
      };
    }
  }

  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // SOCCER "TO ADVANCE" vs the 2-WAY MONEYLINE — same event, near-nested.
  //
  // They are DIFFERENT BETS (operator correction 2026-07-15 — do not conflate):
  //   Moneyline (2 Way) = DNB: 90-MINUTE regulation only; a draw REFUNDS.
  //   To Advance        = the whole tie INCLUDING extra time + penalties; no push.
  // Their fair PROBABILITIES coincide only because ET/pens track 90-min relative
  // strength: P(adv) = w + d·q equals DNB = w/(w+a) iff q = w/(w+a). PX's own
  // book agrees (ML 2-Way -117/+116 vs Advance -118/+115) — which is why pricing
  // advance off the DNB fair is sound. Same number, different settlement.
  //
  // But that difference is exactly what makes parlaying them DANGEROUS, not safe.
  // Take ENG advance + ENG DNB (each ~54.9%):
  //   ENG wins in 90  -> both win
  //   Draw            -> DNB PUSHES (leg voided, parlay reduces to advance),
  //                      advance carries into ET/pens
  //   ARG wins in 90  -> both lose
  // So the parlay effectively pays whenever ENG advances: true ≈ 54.9%, while
  // independent multiplication quotes 0.549² ≈ 30% — a ~1.8x UNDERPRICE on a
  // pair a bettor can build in two clicks. The DNB push means the second leg
  // adds almost no extra risk while we charge as if it did.
  //
  // Nothing else catches this: the SGP machinery sees an unrecognised
  // moneyline_advance combo, and the golf guard keys on PLAYER.
  // OPPOSITE teams (ENG advance + ARG DNB) are near-mutually-exclusive, so
  // independent multiplication OVERSTATES them — conservative, left allowed.
  {
    const legInfos = [];
    for (const l of (legs || [])) {
      if (!l) continue;
      const lid = l.line_id || l.lineId || l;
      let li = l.lineInfo;
      if (!li) { try { li = lineManager.lookupLine(lid); } catch (_) { li = null; } }
      if (li) legInfos.push(li);
    }
    // ---- METHOD OF VICTORY: never allowed in an SGP ----------------------
    // Operator directive 2026-07-17: "Do not allow parlaying of SGPs with
    // method of victory lines."
    //
    // This is an EXPLICIT, UNCONDITIONAL block, deliberately NOT relying on the
    // generic SGP gate further down. That gate declines these today only
    // because no key in SGP_ALLOWED_COMBOS happens to match a MoV pair — an
    // incidental protection that evaporates the moment someone adds a combo
    // key, and the failure would be silent AND expensive: every same-fight
    // method pair is either mutually exclusive (Usman by KO + Usman by SUB
    // can't both happen; only one fighter wins at all) or nested (ko ⊂ itd,
    // mov ⊂ moneyline). Independent multiplication of mutually exclusive legs
    // prices a P=0 parlay as if it were live.
    //
    // Runs on RAW {line_id} legs via the resolution above — production sends
    // unresolved legs, which is exactly how the golf nesting guard silently
    // never fired for weeks.
    const movLegs = legInfos.filter(li => MOV_MARKET_TYPES.has(li.marketType));
    if (movLegs.length) {
      for (const a of movLegs) {
        for (const b of legInfos) {
          if (a === b) continue;
          if (!a.pxEventId || String(a.pxEventId) !== String(b.pxEventId)) continue;
          const bDesc = `${b.playerName || b.teamName || '?'} ${b.marketType}${b.selection ? ':' + b.selection : ''}`;
          return {
            declined: true,
            reason: 'mov_sgp_blocked',
            detail: `method-of-victory legs cannot be parlayed same-game: ${a.playerName || a.teamName} ${a.marketType}:${a.selection} + ${bDesc} on event ${a.pxEventId} — method outcomes are mutually exclusive or nested within the same fight`,
          };
        }
      }
    }

    // TENNIS SETS markets may NEVER be parlayed with anything else on the same
    // match. Like the MoV block above this is an EXPLICIT, UNCONDITIONAL
    // pre-pass rather than a reliance on the generic SGP gate, which blocks
    // these today only because no key in SGP_ALLOWED_COMBOS happens to match —
    // incidental protection that evaporates the moment someone adds a key.
    //
    // The relationships are not merely correlated, several are deterministic
    // (best-of-3):
    //   - Total Sets OVER 2.5 means the match went 2-1, which means BOTH
    //     players won at least one set. So over-2.5 IMPLIES both "at least one
    //     set" YES legs. P(over ∧ alos) = P(over), not the product.
    //   - Winning the MATCH requires winning 2 sets, so match-win ⊂
    //     "wins at least one set". Nested, so the joint is the match leg alone.
    //   - Total Sets UNDER 2.5 (a 2-0) means the LOSER won zero sets, i.e. it
    //     is the exact complement of the loser's "at least one set" YES.
    //   - 1st Set moneyline is strongly correlated with the match moneyline.
    // Pricing any of these as independent multiplies a near-certain or
    // impossible joint as if it were live.
    const SET_MARKETS = new Set(['set_win_at_least_one', 'first_set_moneyline', 'total_sets']);
    const setLegs = legInfos.filter(li => SET_MARKETS.has(li.marketType));
    if (setLegs.length) {
      for (const a of setLegs) {
        for (const b of legInfos) {
          if (a === b) continue;
          if (!a.pxEventId || String(a.pxEventId) !== String(b.pxEventId)) continue;
          const bDesc = `${b.playerName || b.teamName || '?'} ${b.marketType}${b.selection ? ':' + b.selection : ''}`;
          return {
            declined: true,
            reason: 'tennis_sets_sgp_blocked',
            detail: `tennis set markets cannot be parlayed same-match: ${a.playerName || a.teamName || '?'} ${a.marketType}:${a.selection} + ${bDesc} on event ${a.pxEventId} — set outcomes are nested or deterministic within one match (over 2.5 sets IMPLIES both players won a set; winning the match implies winning a set)`,
          };
        }
      }
    }

    const advLegs = legInfos.filter(li => li.marketType === 'advance');
    if (advLegs.length) {
      const norm = s => String(s || '').toLowerCase().trim();
      // Two advance legs on the same event = the two sides of one market.
      for (const a of advLegs) {
        for (const b of legInfos) {
          if (a === b) continue;
          if (String(a.pxEventId) !== String(b.pxEventId)) continue;
          const sameTeam = norm(a.teamName) && norm(a.teamName) === norm(b.teamName);
          if (b.marketType === 'advance' || (b.marketType === 'moneyline' && sameTeam)) {
            return {
              declined: true,
              reason: 'advance_dnb_duplicate',
              detail: `${a.teamName} advance + ${b.teamName} ${b.marketType} on event ${a.pxEventId} — advance (incl. ET/pens) and the 2-way DNB (90 min, draw refunds) are near-nested: on a draw the DNB leg PUSHES and the parlay reduces to advance, so true ≈ P(advance) ≈ 54.9% vs an independent 0.549² ≈ 30% (~1.8x underprice)`,
            };
          }
        }
      }
    }
  }

  // GOLF OUTRIGHT structural guards. MUST run before anything that could
  // approve the parlay.
  //
  // (1) SAME-PLAYER NESTING — the dangerous one. Golf outright markets are
  // perfectly NESTED: win ⊂ top_5 ⊂ top_10 ⊂ top_20 ⊂ make_cut. So
  //     P(Scheffler win AND Scheffler top_5) = P(win)   — NOT the product.
  // Independent multiplication gives 15% × 35% = 5.25% against a true 15%:
  // a ~3x underprice we'd be picked off on every time. The existing SGP /
  // correlation machinery CANNOT catch this because it keys on shared
  // pxEventId, and PX puts each outright market in a SEPARATE event
  // ("...- Tournament Winner" 1019502362 vs "...- Top 5 Finish" 1026450813).
  // A matchup leg on the same player is correlated the same way (winning your
  // H2H is evidence you finished high), so it counts too.
  // Different PLAYERS are safe and deliberately allowed: two players can't both
  // win (mutually exclusive) and compete for finite top-N/cut slots, so
  // independent multiplication OVERSTATES those parlays — conservative for us.
  //
  // (2) YES-SIDE ONLY for win/top_5/top_10/top_20 (operator directive): the
  // counterparty takes YES. line-manager doesn't register those NO lines at
  // all, so this is belt-and-braces if PX ever quotes an unregistered side.
  {
    // Resolve lineInfo HERE. This guard runs long before shouldDecline builds
    // `resolvedLegs`, so at this point `legs` are RAW RFQ entries ({line_id})
    // with NO .lineInfo. The original `legs.filter(l => l.lineInfo && ...)`
    // therefore matched NOTHING in production and the guard silently never
    // fired — we submitted an 8-leg containing BOTH "Rory McIlroy make_cut" and
    // "Rory McIlroy win" (perfectly nested, ~3x underpriced) at +2679 on
    // 2026-07-15. It passed local tests only because those injected
    // pre-resolved {lineId, lineInfo} objects. Accept both shapes.
    const golfLegs = [];
    for (const l of (legs || [])) {
      if (!l) continue;
      const lineId = l.line_id || l.lineId || l;
      let li = l.lineInfo;
      if (!li) { try { li = lineManager.lookupLine(lineId); } catch (_) { li = null; } }
      if (!li) continue;
      if (li.sport === 'golf_outrights' || li.sport === 'golf_matchups') golfLegs.push({ lineInfo: li });
    }
    // Runtime kill-switch for golf OUTRIGHT parlay quoting (not matchups).
    // Set via POST /golf-outrights/pause — used to hard-stop between-rounds
    // outright quoting before the next round tees off, so a stale board can't
    // be picked off during live play (operator directive for The Open R3,
    // 2026-07-18: stop at 4am ET, R3 tees 4:10am). In-memory: resets on
    // restart, which is fine — it's a same-session operational toggle, and the
    // board also fails closed on its own once DK stops serving the ties boards.
    if (_golfOutrightsPaused && golfLegs.some(l => l.lineInfo.sport === 'golf_outrights')) {
      return { declined: true, reason: 'golf_outrights_paused', detail: 'golf outright parlay quoting is paused (kill-switch active)' };
    }
    if (golfLegs.length) {
      const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[.'’`\-]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
      // Map player → the golf legs that reference them. A matchup references
      // TWO players (home/away); an outright references exactly one.
      const byPlayer = new Map();
      for (const l of golfLegs) {
        const li = l.lineInfo;
        const names = li.sport === 'golf_outrights'
          ? [li.playerName || li.teamName]
          : [li.homeTeam, li.awayTeam];
        for (const nm of names.filter(Boolean)) {
          const k = norm(nm);
          if (!k) continue;
          if (!byPlayer.has(k)) byPlayer.set(k, []);
          if (!byPlayer.get(k).includes(l)) byPlayer.get(k).push(l);
        }
      }
      for (const [player, ls] of byPlayer) {
        if (ls.length < 2) continue;
        const desc = ls.map(l => `${l.lineInfo.marketType}${l.lineInfo.selection ? ':' + l.lineInfo.selection : ''}`).join(' + ');
        return {
          declined: true,
          reason: 'golf_same_player_nested',
          detail: `${ls.length} golf legs on the same player (${player}) — outright markets are nested (win ⊂ top5 ⊂ top10 ⊂ top20 ⊂ make_cut), so independent pricing badly underprices: ${desc}`,
        };
      }
      const badSide = golfLegs.find(l => l.lineInfo.sport === 'golf_outrights'
        && l.lineInfo.selection === 'no'
        && l.lineInfo.marketType !== 'outright_make_cut');
      if (badSide) {
        return {
          declined: true,
          reason: 'golf_outright_no_side',
          detail: `${badSide.lineInfo.marketType} NO side not offered — win/top_5/top_10/top_20 are YES-side only (counterparty takes YES)`,
        };
      }
    }
  }

  // Pre-pass for STRUCTURAL prop-correlation rules that should outrank
  // per-leg quality reasons (no_fair_value, low_confidence, stale). A
  // parlay containing two K-prop legs on the same pitcher is correlated
  // by construction — declining for "BetRivers-alone" instead of
  // "two legs on the same pitcher" misnames the actual problem and would
  // also approve the parlay if BetRivers happened to be FD/DK.
  //
  // COMBINED prop-correlation pre-pass. Single iteration over legs
  // produces:
  //   - same-player detection (two prop legs on the same player, any
  //     combination of stats — supersedes the older same-pitcher rule
  //     which only handled K-prop pairs)
  //   - same-game prop+anything block (any prop leg + any same-game
  //     leg in same parlay — covers prop+ML/spread/total AND prop+prop)
  //
  // K-PROP EXCEPTION to the same-game block: event groups whose prop
  // legs are ALL player_strikeouts defer to same-game correlation rule
  // (d) in its post-loop position — that rule carries the full
  // operator-approved (2026-04-27) SGP carve-outs (2-leg K-prop +
  // same-team ML, opposing-pitcher K-prop + K-prop) and we must not
  // double-implement the allowance here. K-prop combos matching no
  // carve-out still decline there with the same reason. The same-player
  // rule above is NOT exempted — two legs on one pitcher decline in the
  // pre-pass regardless of stat or market type.
  //
  // Performance note: was two separate iterations before — combined
  // here so we walk the legs array once. Also skips the heavier
  // same-game grouping if no prop leg is found at all (game-line-only
  // parlays were paying the iteration cost on every parlay).
  //
  // SAME-PLAYER RULE rationale: two prop legs on the same player are
  // correlated regardless of which stats are measured. Even combos that
  // look superficially independent (HR + stolen bases, K + walks) share
  // the underlying "player got significant playing time / pitcher went
  // deep" factor that inflates BOTH probabilities together. Without
  // measured per-(sport, prop_a, prop_b) correlation factors, we can't
  // safely de-vig the joint probability — declining is the asymmetric-
  // risk-correct call (overestimating correlation just declines a
  // profitable RFQ; underestimating sells the bettor a parlay too
  // cheaply).
  {
    const playerPropSeen = {};   // for same-player rule (sport|player → first-seen leg meta)
    const legsByEvent = {};      // for same-game rule (only populated if a prop leg appears)
    let anyPropLeg = false;
    // Player-name normalizer — strip diacritics, periods, apostrophes,
    // backticks, collapse whitespace, lowercase. Same canonicalization
    // as the per-(sport, player) exposure system in order-tracker so
    // "C.J. McCollum" and "CJ McCollum" produce the same key here too.
    const _normPlayer = (s) => (s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[.'`]/g, '').replace(/\s+/g, ' ').trim();
    for (const leg of legs) {
      const lineId = leg.line_id || leg.lineId || leg;
      const lineInfo = lineManager.lookupLine(lineId);
      if (!lineInfo) continue; // unknown leg — main loop handles
      const mt = lineInfo.marketType || '';
      const isPropLeg = mt.startsWith('player_');
      // Same-player rule — universal across all player_* market types.
      // Replaces the older same-pitcher rule (which only handled
      // player_strikeouts pairs); covers MLB hitter props (hits, HR,
      // total bases, RBIs), Phase-2 NBA points/rebounds/assists/threes,
      // NHL shots_on_goal, AND legacy K-prop pairs the same way.
      if (isPropLeg) {
        const sport = lineInfo.sport || lineInfo.oddsApiSport;
        // playerName is the canonical field; teamName is also populated
        // for K-props (legacy) so fall back if playerName is missing.
        const rawPlayer = lineInfo.playerName || lineInfo.teamName || '';
        const player = _normPlayer(rawPlayer);
        if (sport && player) {
          const playerKey = sport + '|' + player;
          if (playerPropSeen[playerKey]) {
            const prev = playerPropSeen[playerKey];
            // NESTED EXEMPTION (Stage 1): a whitelisted implication pair
            // (e.g. goalscorer + SoT1+, HR + hit, points ladder) prices
            // EXACTLY (joint = strong leg) — allow it through when the
            // operator has enabled 'prop_nested' in SGP_ALLOWED_COMBOS.
            // Anything not in the side-keyed table still declines here,
            // including all under/mixed-side same-player pairs (the
            // permanently-blocked negative-correlation class).
            if (_nestedCombosAllowed() && matchNestedPair(prev, lineInfo)) {
              // fall through — classifySgpCombo tags it 'prop_nested' and
              // priceParlay collapses the pair to the strong leg.
            } else {
              // Shadow-log same-player declines too (SGP roadmap Stage 0):
              // this is where future nested-table candidates and the
              // Stage-4 same-player two-stat demand shows up.
              try {
                require('./sgp-audit').logSgpDecline(parlayId, lineInfo.pxEventId, [prev, lineInfo], [], 'prop_correlation_same_player');
              } catch (_) { /* observability must never break pricing */ }
              return {
                declined: true,
                reason: 'prop_correlation_same_player',
                detail: `Two prop legs on "${rawPlayer}" in same parlay (${prev.marketType}${prev.line != null ? ' ' + prev.line : ''} + ${mt}${lineInfo.line != null ? ' ' + lineInfo.line : ''}) — same-player props are correlated regardless of which stats they measure`,
              };
            }
          }
          playerPropSeen[playerKey] = lineInfo;
        }
      }
      // Same-game rule grouping — only build if we've actually seen a
      // prop leg (or this is one). Game-line-only parlays skip this work.
      if (isPropLeg || anyPropLeg) {
        const eid = lineInfo.pxEventId;
        if (eid) {
          if (!legsByEvent[eid]) legsByEvent[eid] = { props: [], others: [] };
          if (isPropLeg) {
            legsByEvent[eid].props.push(lineInfo);
            anyPropLeg = true;
            // Backfill: if we encountered non-prop legs BEFORE the first
            // prop leg, they weren't grouped. Re-scan from the start to
            // catch them. Rare path — only on first prop leg encounter.
            if (legsByEvent[eid].others.length === 0) {
              for (const otherLeg of legs) {
                if (otherLeg === leg) break;
                const oid = otherLeg.line_id || otherLeg.lineId || otherLeg;
                const oInfo = lineManager.lookupLine(oid);
                if (!oInfo || !oInfo.pxEventId) continue;
                if (oInfo.pxEventId !== eid) continue;
                if ((oInfo.marketType || '').startsWith('player_')) continue;
                legsByEvent[eid].others.push(oInfo);
              }
            }
          } else {
            legsByEvent[eid].others.push(lineInfo);
          }
        }
      }
    }
    // Same-game block — only check when at least one prop leg exists.
    if (anyPropLeg) {
      for (const [eid, group] of Object.entries(legsByEvent)) {
        if (group.props.length > 0 && (group.props.length + group.others.length) > 1) {
          // K-PROP EXEMPTION (regression fix 2026-06-11): when every
          // prop leg in the group is a K-prop, fall through to the M3
          // post-loop rule (d), which implements the operator-approved
          // 2026-04-27 carve-outs (sgpKpropMlSameTeam, sgpKpropOpposing).
          // The Phase-2 same-game block (commit 4564859) had silently
          // made those carve-outs unreachable. Non-carve-out K-prop
          // combos (K + total, K + run-line, K + opposite-team ML) are
          // still declined by rule (d) with this same reason.
          if (group.props.every(li => li.marketType === 'player_strikeouts')) continue;
          // NESTED EXEMPTION (Stage 1): exactly two same-player prop legs
          // forming a whitelisted implication pair, with NO other legs on
          // the same game, fall through to classifySgpCombo ('prop_nested',
          // env-gated) + the exact-collapse pricing. Any extra same-game
          // leg keeps the whole parlay declined here.
          if (group.others.length === 0 && group.props.length === 2
              && _nestedCombosAllowed() && matchNestedPair(group.props[0], group.props[1])) continue;
          // CROSS-TEAM EXEMPTION (Stage 2): exactly two different-player,
          // opposite-team prop legs (roster-resolved, fail-closed), no other
          // same-game legs — falls through to 'prop_prop_xteam' (env-gated)
          // + additive band-top pricing.
          if (group.others.length === 0 && group.props.length === 2
              && _xteamCombosAllowed() && matchXTeamPair(group.props[0], group.props[1])) continue;
          const propLabels = group.props.map(li =>
            `${li.playerName || li.teamName || '?'} ${li.propType || li.marketType} ${li.selection || ''} ${li.line ?? ''}`.trim());
          const otherLabels = group.others.map(li =>
            `${li.teamName || '?'} ${li.marketType || ''}`.trim());
          const detail = `pxEventId=${eid}: ${group.props.length} prop leg(s) [${propLabels.join('; ')}]`
            + (group.others.length ? ` + ${group.others.length} same-game leg(s) [${otherLabels.join('; ')}]` : '');
          // SGP Phase-0 shadow log. No-op unless SGP_SHADOW_LOGGING=true on Railway.
          // Fire-and-forget; pricing behavior unchanged.
          try {
            require('./sgp-audit').logSgpDecline(parlayId, eid, group.props, group.others);
          } catch (_) { /* defensive — observability must never break pricing */ }
          return {
            declined: true,
            reason: 'prop_correlation_same_game',
            detail,
          };
        }
      }
    }
  }

  // Check all legs are known and events haven't started.
  // Uses pre-computed lineInfo.startTimeMs (parsed lazily on first lookupLine
  // and cached on the object) to avoid re-parsing the ISO string per RFQ.
  const resolvedLegs = [];
  const nowMs = Date.now();
  for (const leg of legs) {
    const lineId = leg.line_id || leg.lineId || leg;
    const lineInfo = lineManager.lookupLine(lineId);
    if (!lineInfo) return { declined: true, reason: 'unknown legs', detail: null };

    // Manual disable: operator can disable specific lines or whole
    // events from the dashboard (Lines table → drill-down → Disable).
    // Used when a sportsbook pulls lines on a delayed/uncertain game
    // and we want to avoid getting picked off on stale prices.
    if (lineManager.isLineDisabled(lineId)) {
      const teamLabel = lineInfo.teamName || '?';
      const eventLabel = lineInfo.pxEventName || '?';
      return {
        declined: true,
        reason: 'manually_disabled',
        detail: `${teamLabel} (${eventLabel}) — manually disabled by operator`,
      };
    }

    // Prop-specific decline rules. Applied per-leg as we iterate.
    // Cross-leg correlation rules checked separately above.
    //
    // Applies to ALL player_<type> markets — player_strikeouts (K-prop),
    // player_points, player_rebounds, player_assists, player_threes,
    // player_shots_on_goal, etc. Phase-2 launch types share the same
    // confidence-gate semantics as K-prop.
    if (lineInfo.marketType && /^player_/.test(lineInfo.marketType)) {
      const isKProp = lineInfo.marketType === 'player_strikeouts';
      const propMinBooks = config.pricing.propMinBooksWithBothSides || 3;
      // Min-books floor: K-prop keeps its 2-book + trusted-alone exception
      // for backward compat (built around the SharpAPI single-book pattern).
      // New Phase-2 props use the stricter propMinBooksWithBothSides (default
      // 3) with no trusted-alone carve-out — TOA's broader coverage means
      // we should always have ≥3 books for legitimate prop quotes.
      const playerLabel = lineInfo.playerName || lineInfo.teamName || '?';
      const propLabel = isKProp ? 'K' : (lineInfo.propType || lineInfo.marketType.replace(/^player_/, ''));

      // (a) Missing fair value — prop matcher returned no usable consensus.
      if (lineInfo.fairProb == null) {
        return {
          declined: true,
          reason: 'prop_no_fair_value',
          detail: `${playerLabel} ${propLabel} ${lineInfo.line} (${lineInfo.selection}) — prop matcher returned no fair_prob`,
        };
      }
      // (b) Min-books gate — branches by prop family.
      const both = lineInfo.booksWithBothSides || 0;
      const propBooks = lineInfo.propBooks || [];
      const trustedSet = config.pricing.propTrustedSingleBooks || [];
      const trustedAlone = both === 1 && propBooks.some(b => trustedSet.includes(String(b).toLowerCase()));
      // One-sided carve-out: MLB hitter-binary props (HR / hits / total bases /
      // RBI) are priced intentionally off a single posted side via the one-sided
      // path (line-manager.js ~1503). TOA one-sided is overround-adjusted;
      // DK-scraper one-sided is raw implied (leans on the longshot vig). Both
      // synthesize a valid fairProb, so they must NOT be rejected on
      // books_with_both_sides=0 — that gate is for 2-sided props only.
      const oneSidedPriced = ['toa-one-sided', 'dk-scraper-one-sided'].includes(lineInfo.propSource);
      if (isKProp) {
        if (both < 2 && !trustedAlone) {
          return {
            declined: true,
            reason: 'prop_low_confidence',
            detail: `${playerLabel} K ${lineInfo.line}: books_with_both_sides=${both}, books=[${propBooks.join(',')}] — need ≥2 books OR one of [${trustedSet.join(',')}]`,
          };
        }
      } else {
        // Phase-2 launch props: ≥N-book floor with single-trusted-book
        // carve-out. Originally Phase-2 was strictly ≥3 books with no
        // exception (TOA was assumed to have broad coverage). Reality:
        // TOA's NHL player_shots_on_goal coverage is thin and many
        // legitimate props have only Pinnacle or only DK with both sides.
        // The trustedAlone exception now applies here too — single-book
        // props from a trusted source price normally instead of declining.
        if (both < propMinBooks && !trustedAlone && !oneSidedPriced) {
          return {
            declined: true,
            reason: 'prop_low_confidence',
            detail: `${playerLabel} ${propLabel} ${lineInfo.line}: books_with_both_sides=${both}, books=[${propBooks.join(',')}] — need ≥${propMinBooks} OR one of [${trustedSet.join(',')}]`,
          };
        }
      }
      // (c) Stale prop data. Configurable via STALE_PROP_SECONDS (default
      // 420s — see config.js for the seed-snapshot arithmetic that floors
      // the safe value; ships as a package with the TOA prop cadence cut).
      const STALE_MS = (config.pricing.stalePropSeconds || 420) * 1000;
      if (lineInfo.propFetchedAt && (Date.now() - lineInfo.propFetchedAt) > STALE_MS) {
        const ageMin = Math.round((Date.now() - lineInfo.propFetchedAt) / 6000) / 10;
        return {
          declined: true,
          reason: 'prop_stale',
          detail: `${playerLabel} ${propLabel} ${lineInfo.line}: prop data ${ageMin} min old (>${Math.round(STALE_MS / 60000 * 10) / 10} min)`,
        };
      }
    }

    const isGolfMatchup = lineInfo.sport === 'golf_matchups' || lineInfo.oddsApiSport === 'golf_matchups';
    // Golf OUTRIGHTS are PRE-TOURNAMENT ONLY (operator directive 2026-07-30),
    // which REVERSES the 2026-07-16 directive that had them quote live between
    // rounds. Once play starts, a pre-tournament board is stale in a way no
    // freshness check can see: positions on the leaderboard move probabilities
    // far more than the board updates, and we would be laying NO into
    // information we don't have. So outrights now fall through to the normal
    // started gate below and decline once the event begins.
    const isGolfOutright = false;
    const startMs = lineInfo.startTimeMs;
    if (startMs != null) {
      if (isNaN(startMs)) {
        return { declined: true, reason: 'unknown start time', detail: `${lineInfo.teamName || '?'} (${lineInfo.sport || '?'}) has invalid startTime ${lineInfo.startTime} — cannot verify game hasn't started` };
      }
      if (nowMs > startMs && !isGolfOutright) {
        return { declined: true, reason: 'event started', detail: `${lineInfo.teamName || '?'} (${lineInfo.sport || '?'}) already in progress` };
      }
    } else if (!isGolfMatchup) {
      // Null startTime is a risk — game could already be live. Decline rather than
      // silently skip the check. Golf matchups exempt (see comment above).
      return { declined: true, reason: 'unknown start time', detail: `${lineInfo.teamName || '?'} (${lineInfo.sport || '?'}) has no startTime — cannot verify game hasn't started` };
    }

    // Alt-spread block (NBA/MLB/NHL by default — see isBlockedAltSpread).
    const altReason = isBlockedAltSpread(lineInfo);
    if (altReason) {
      return {
        declined: true,
        reason: 'alt-spread blocked',
        detail: `${lineInfo.teamName || '?'} ${lineInfo.marketType} ${lineInfo.line}: ${altReason}`,
      };
    }
    // Alt-total block (NBA only — see isBlockedAltTotal).
    const altTotalReason = isBlockedAltTotal(lineInfo);
    if (altTotalReason) {
      return {
        declined: true,
        reason: 'alt-total blocked',
        detail: `${lineInfo.teamName || '?'} ${lineInfo.marketType} ${lineInfo.line}: ${altTotalReason}`,
      };
    }

    resolvedLegs.push({ lineId, lineInfo });
  }

  // M3 cross-leg prop correlation rules. Run after the per-leg loop
  // because they need the resolvedLegs array to compare across legs.
  // ALL-OR-NOTHING decline: if any rule fires, decline the entire parlay.
  const propLegs = resolvedLegs.filter(l => l.lineInfo.marketType === 'player_strikeouts');
  if (propLegs.length > 0) {
    // (d) Same-game correlation: K-prop leg + any other leg sharing
    // pxEventId is heavily correlated. The pitcher's K count and his
    // team's run total / win probability move together. Decline rather
    // than try to model the correlation.
    //
    // CARVE-OUT (operator-approved 2026-04-27): exactly-2-leg parlays
    // of (K-prop + same-team ML) are allowed. The pitcher's team
    // moneyline IS positively correlated with their K total, but books
    // (DK, FD) have stable empirical SGP pricing for this combo (DK
    // ~14.5% discount, FD ~24.3% across sample). We mirror DK-style
    // pricing via sgpPropMlCorrBoost (default 0.15) applied to
    // fairParlayProb in priceParlay. Other K-prop SGP combos (K + total,
    // K + run-line, K + opposite-team-ML) remain blocked.
    for (const propLeg of propLegs) {
      const eid = propLeg.lineInfo.pxEventId;
      if (!eid) continue;
      const sameGameOthers = resolvedLegs.filter(l =>
        l !== propLeg && l.lineInfo.pxEventId === eid
      );
      if (sameGameOthers.length === 0) continue;

      // CARVE-OUT 1: K-prop + same-team ML (2-leg parlay).
      // Positively correlated — pricing applies sgpPropMlCorrBoost in
      // priceParlay. Operator-approved 2026-04-27.
      const isMlCarveOutCandidate = resolvedLegs.length === 2
        && sameGameOthers.length === 1
        && sameGameOthers[0].lineInfo.marketType === 'moneyline';
      if (isMlCarveOutCandidate) {
        const pi = propLeg.lineInfo;
        const pitcherSide = oddsFeed.getPitcherSide(
          pi.sport, pi.homeTeam, pi.awayTeam, pi.startTime, pi.playerName
        );
        const mlSide = sameGameOthers[0].lineInfo.oddsApiSelection || sameGameOthers[0].lineInfo.selection;
        if (pitcherSide && mlSide && pitcherSide === mlSide) {
          // Allow — fall through to pricing. Marker on resolvedLegs
          // so priceParlay can apply the correlation boost.
          for (const r of resolvedLegs) r.sgpKpropMlSameTeam = true;
          continue; // process next propLeg
        }
      }

      // CARVE-OUT 2: All same-game-other legs are K-props on different
      // pitchers (opposing starters). Two pitchers in the same MLB game
      // pitch to different batters; their K-counts are largely
      // independent. Books (DK, FD) routinely offer this combo with
      // little to no correlation discount. Same-pitcher × 2 already
      // blocked upstream by the same-pitcher pre-pass, so by the time
      // we reach here any same-game K-prop pairing is opposing-pitcher
      // by construction. Operator-approved 2026-04-27.
      if (sameGameOthers.every(l => l.lineInfo.marketType === 'player_strikeouts')) {
        // Allow — fall through to pricing as effectively independent.
        // Marker so downstream code can identify the combo if needed.
        for (const r of resolvedLegs) r.sgpKpropOpposing = true;
        continue;
      }

      // No carve-out applied — decline. Show first same-game-other leg
      // in the detail for diagnostic clarity.
      const sample = sameGameOthers[0];
      // SGP Phase-0 shadow log — parity with the pre-pass logger, since
      // K-prop same-game groups now reach this point instead of being
      // declined (and logged) up there. Fire-and-forget.
      try {
        const evLegs = [propLeg, ...sameGameOthers].map(l => l.lineInfo);
        require('./sgp-audit').logSgpDecline(
          parlayId, eid,
          evLegs.filter(li => /^player_/.test(li.marketType || '')),
          evLegs.filter(li => !/^player_/.test(li.marketType || ''))
        );
      } catch (_) { /* defensive — observability must never break pricing */ }
      return {
        declined: true,
        reason: 'prop_correlation_same_game',
        detail: `${propLeg.lineInfo.playerName || '?'} K ${propLeg.lineInfo.line} + ${sample.lineInfo.teamName || sample.lineInfo.playerName || '?'} ${sample.lineInfo.marketType || '?'} on same event ${eid}`,
      };
    }
    // (e) Multi-line same-pitcher: two K-prop legs on the same pitcher
    // are perfectly anti-correlated (if Over/Under) or perfectly
    // correlated (if same side, different lines). Either way, decline.
    const seen = {};
    for (const propLeg of propLegs) {
      const player = (propLeg.lineInfo.playerName || '').toLowerCase().trim();
      if (!player) continue;
      if (seen[player]) {
        return {
          declined: true,
          reason: 'prop_correlation_same_pitcher',
          detail: `Two legs on pitcher "${propLeg.lineInfo.playerName}" in same parlay`,
        };
      }
      seen[player] = true;
    }
  }

  // Same-game parlay gating. Previously blanket-declined because
  // multiplicative correlation boosts triggered PX "invalid estimated
  // prices" rejection. Now: allow configured market-pair combos only;
  // pricing path applies a wider vig multiplier (config.pricing.
  // sgpVigMultiplier) instead of a boost to compensate for positive
  // same-game correlation in a way PX accepts.
  const byEvent = {};
  for (const l of resolvedLegs) {
    const eid = l.lineInfo.pxEventId;
    if (!eid) continue;
    // GOLF OUTRIGHTS ARE NOT SAME-GAME. PX models an outright as ONE event
    // holding the ENTIRE FIELD ("2026 The Open - To Make The Cut" = all 156
    // players), so a shared pxEventId here means "same market type", NOT "same
    // game". Grouping them made every 2-leg outright parlay look like an SGP and
    // get blocked as an unrecognized combo — operator hit exactly this on PX:
    // "Cameron Young YES + Ludvig Aberg YES" -> No Offers Available, tagged SGP.
    // Two DIFFERENT players are near-independent (mildly NEGATIVE: they compete
    // for the same ~70 cut spots / finishing slots), so independent
    // multiplication OVERSTATES the parlay = conservative for us. The real
    // correlation risk — the SAME player across nested markets — is caught by
    // the golf_same_player_nested pre-pass above, which keys on PLAYER, not event.
    if (l.lineInfo.sport === 'golf_outrights') continue;
    if (!byEvent[eid]) byEvent[eid] = [];
    byEvent[eid].push({ market: l.lineInfo.marketType, team: l.lineInfo.teamName, home: l.lineInfo.homeTeam, away: l.lineInfo.awayTeam, sport: l.lineInfo.sport, li: l.lineInfo });
  }
  // Classify a 2-leg SGP group into a stable combo key. Returns null if
  // the group is 3+ legs or the market pair isn't a recognized combo
  // (e.g. spread+spread — blocked by duplicate rules anyway).
  const classifySgpCombo = (entries) => {
    if (entries.length !== 2) return null;
    // Nested implication pair (Stage 1): two same-player prop legs from
    // the side-keyed implication table. Checked FIRST so e.g. a soccer
    // goalscorer+SoT pair never falls through to the generic key match.
    if (entries[0].li && entries[1].li && matchNestedPair(entries[0].li, entries[1].li)) {
      return 'prop_nested';
    }
    // Cross-team different-player prop pair (Stage 2) — roster-resolved,
    // fail-closed (unresolved identity returns null ⇒ 'SGP not allowed').
    if (entries[0].li && entries[1].li && matchXTeamPair(entries[0].li, entries[1].li)) {
      return 'prop_prop_xteam';
    }
    const markets = entries.map(e => e.market).sort();
    const key = markets.join('_');
    // Only named combos users can opt in/out of via SGP_ALLOWED_COMBOS:
    if (key === 'moneyline_total') return 'ml_total';
    if (key === 'spread_total') return 'spread_total';
    if (key === 'moneyline_spread') return 'ml_spread'; // also blocked below as correlated
    if (key === 'moneyline_player_strikeouts') return 'kprop_ml'; // 2026-04-27: K-prop + ML same-team SGP
    if (key === 'player_strikeouts_player_strikeouts') return 'kprop_kprop'; // 2026-04-27: 2 K-props on same game (opposing pitchers — same-pitcher dup blocked upstream)
    return null; // any other pair: reject by default
  };
  // Auto-include 'kprop_ml' and 'kprop_kprop' in the allowed-combos set
  // so the prop carve-outs (handled in the prop_correlation_same_game
  // block above) don't get re-blocked here. The carve-outs already
  // enforce the same-team check (kprop_ml) and the same-pitcher pre-pass
  // ensures kprop_kprop is opposing pitchers; this gate just needs to
  // recognize the combos.
  const allowedCombos = new Set([...(config.pricing.sgpAllowedCombos || []), 'kprop_ml', 'kprop_kprop']);
  // `sgpCombo` is captured on the whole parlay for downstream pricing +
  // order-tracking. Currently we only support single-event SGP legs
  // (length==2 on one pxEventId); multi-event SGPs not supported yet.
  let sgpEventId = null;
  let sgpCombo = null;
  for (const [eid, entries] of Object.entries(byEvent)) {
    if (entries.length <= 1) continue;
    const gameLabel0 = entries[0].away && entries[0].home ? `${entries[0].away} @ ${entries[0].home}` : `event ${eid}`;
    // Tennis SGPs are structurally different from team-sport SGPs:
    // sets/games are tightly coupled (a fav covering -1.5 sets means a
    // straight-set match, which makes Under games near-certain). Our
    // sport-agnostic SGP_CORRELATION_BY_COMBO grid was calibrated on
    // MLB samples and badly underestimates tennis correlation — observed
    // case 2026-05-08: priced spread_fav_under at +251 while DK had
    // +170 / FD had +182. Block until sport-specific correlation keys
    // are wired in.
    const sgpSport = entries[0].sport || '';
    if (sgpSport === 'tennis') {
      log.info('Pricing', `Declined SGP: tennis SGPs blocked (${entries.length} legs on ${gameLabel0})`);
      return {
        declined: true,
        reason: 'SGP not allowed',
        detail: `tennis SGPs blocked — sport-specific correlation factors not yet calibrated`,
      };
    }
    // Soccer: block ml_total and spread_total combos. Most major sportsbooks
    // (DK, FD, etc.) don't offer these for soccer because goal totals are
    // tightly correlated with ML/spread outcomes — a team winning by a
    // margin almost always means goals scored, so the "independent legs"
    // pricing model breaks down. Operator-confirmed 2026-05-08 after
    // observing Manchester United ML + Manchester @ Sunderland Over 2.5
    // SGP get accepted at +123 (FD had +168, well wider). Other sports
    // (MLB/NBA/NHL) keep the combos allowed via SGP_ALLOWED_COMBOS.
    if (sgpSport === 'soccer' || sgpSport.startsWith('soccer_')) {
      const soccerCombo = classifySgpCombo(entries);
      if (soccerCombo === 'ml_total' || soccerCombo === 'spread_total') {
        log.info('Pricing', `Declined SGP: soccer ${soccerCombo} blocked (${entries.length} legs on ${gameLabel0})`);
        return {
          declined: true,
          reason: 'SGP not allowed',
          detail: `soccer ${soccerCombo} SGPs blocked — books don't offer due to goal-total correlation with ML/spread outcomes`,
        };
      }
    }
    const combo = classifySgpCombo(entries);
    if (!combo || !allowedCombos.has(combo)) {
      log.info('Pricing', `Declined SGP: ${entries.length} legs on ${gameLabel0} (combo=${combo || 'unclassified'}, not in allowed list)`);
      // Shadow-log with the classified combo in the signature so demand
      // for not-yet-enabled classes (prop_nested while dark, future
      // prop_prop_xteam, …) is measurable BEFORE enabling them.
      try {
        const propLis = entries.filter(e => /^player_/.test(e.market || '')).map(e => e.li).filter(Boolean);
        const otherLis = entries.filter(e => !/^player_/.test(e.market || '')).map(e => e.li).filter(Boolean);
        require('./sgp-audit').logSgpDecline(parlayId, eid, propLis, otherLis, `sgp_not_allowed:${combo || 'unclassified'}`);
      } catch (_) { /* observability must never break pricing */ }
      return {
        declined: true,
        reason: 'SGP not allowed',
        detail: `${entries.length} legs on same game: ${gameLabel0} (combo=${combo || 'unclassified'} not in SGP_ALLOWED_COMBOS=${[...allowedCombos].join(',') || 'empty'})`,
      };
    }
    // Multiple same-game pairs on DIFFERENT events are allowed (2026-07-24):
    // every pair reaching this point has individually passed the allowed-combo
    // check above, the pairs are on independent games, and the pricing engine
    // already applies per-combo correlation factors MULTIPLICATIVELY across
    // all detected components (see the eventLegs loop in priceParlay). The
    // old blanket decline here turned away $11.5K of network-filled volume in
    // one 2-day sample (avg $2.3K tickets — multi-SGP bettors run big).
    // For parlay-level metadata (experiment budgets/stop-loss key on it),
    // prefer an EXPERIMENTAL combo over a standard one so the sgp-guard
    // budget + stop-loss checks bind whenever any component is experimental.
    if (sgpEventId == null) {
      sgpEventId = eid;
      sgpCombo = combo;
    } else {
      const expSet = config.pricing.experimentalSgpCombos;
      const comboIsExp = !!(expSet && (expSet.has ? expSet.has(combo) : Array.isArray(expSet) && expSet.includes(combo)));
      const currentIsExp = !!(expSet && (expSet.has ? expSet.has(sgpCombo) : Array.isArray(expSet) && expSet.includes(sgpCombo)));
      if (comboIsExp && !currentIsExp) sgpCombo = combo;
      log.info('Pricing', `Multi-SGP parlay: additional same-game pair (${combo}) on event ${eid} alongside ${sgpEventId} — pricing with compounded correlation factors`);
    }
  }
  // ---- CROSS-EVENT SERIES CORRELATION ----
  // Series events and the underlying game events have DIFFERENT pxEventIds
  // (e.g. Series Winner - DEN vs MIN is event 1500006589, Game 1 MIN @ DEN
  // is a separate event). The per-pxEventId grouping above can't catch them
  // paired. Group again by normalized home/away team pair across all legs:
  //   - series_spread + any game leg (moneyline/spread/total/team_total)
  //     between the same two teams: blocked (series outcome is tied to each
  //     game's outcome, high correlation)
  //   - multiple series_spread legs on the same series (alt lines on same
  //     matchup): blocked (same bet at different breakpoints)
  //
  // Fast-path: skip this pass entirely when no leg is a series market.
  // 97%+ of RFQs don't touch series markets at all, so the byPair build
  // and loop were pure waste on the hot path. Guard saves ~50-150μs per
  // RFQ depending on leg count.
  const hasAnySeriesLeg = resolvedLegs.some(r => {
    const mt = r.lineInfo.marketType;
    return typeof mt === 'string' && mt.startsWith('series_');
  });
  if (hasAnySeriesLeg) {
    const normName = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(series\)\s*/g, '').replace(/[^a-z0-9 ]/g, '').trim();
    const pairKey = (h, a) => {
      const nh = normName(h), na = normName(a);
      if (!nh || !na) return null;
      return [nh, na].sort().join('|');
    };
    const byPair = {};
    for (const l of resolvedLegs) {
      const key = pairKey(l.lineInfo.homeTeam, l.lineInfo.awayTeam);
      if (!key) continue;
      if (!byPair[key]) byPair[key] = [];
      byPair[key].push({ market: l.lineInfo.marketType, team: l.lineInfo.teamName, line: l.lineInfo.line });
    }
    for (const [key, entries] of Object.entries(byPair)) {
      if (entries.length <= 1) continue;
      const seriesSpreadLegs = entries.filter(e => e.market === 'series_spread');
      if (seriesSpreadLegs.length === 0) continue;
      if (seriesSpreadLegs.length >= 2) {
        log.info('Pricing', `Declined: multiple series_spread legs on same series (${key})`);
        return { declined: true, reason: 'correlated legs', detail: `multiple series spread lines on same series: ${key}` };
      }
      const gameTypes = ['moneyline', 'spread', 'total', 'team_total'];
      const hasGameLeg = entries.some(e => gameTypes.includes(e.market));
      if (hasGameLeg) {
        log.info('Pricing', `Declined: series_spread + game leg on same matchup (${key})`);
        return { declined: true, reason: 'correlated legs', detail: `series spread + individual game market on same matchup: ${key}` };
      }
    }
  }

  // Check team-level exposure limits.
  // Use maxRiskPerParlay as the estimate. The confirm-time re-check in
  // handleConfirm is the real safety net (checks actual stake against both
  // per-team and per-game caps with pending reservations). Keeping
  // shouldDecline lightweight here avoids over-restricting quotes — the
  // original 3x estPayout inflation was declining too many RFQs.
  const estPayout = config.pricing.maxRiskPerParlay || 500;
  // Pass legs with fairProb info for weighted calculation. CRITICAL:
  // include the full lineInfo so checkExposureLimits and checkGameExposure
  // can build the right key (teamKey|pxEventId|date for team check,
  // pxEventId|date for game check). Previously only {team, fairProb} was
  // passed — the key builders fell back to '|noevent' which never matched
  // the real exposure[] entries (which use eventId+date). The team-cap
  // check was effectively a no-op at quote time; only confirm-time caught
  // overflows. Now the quote-time check is a real gate, eliminating
  // redundant quote→confirm→reject cycles and closing the PX-ignores-
  // reject leak path entirely (we never quote in the first place).
  const legsWithProb = resolvedLegs.map(l => {
    const fp = oddsFeed.getFairProb(
      l.lineInfo.oddsApiSport, l.lineInfo.homeTeam, l.lineInfo.awayTeam,
      l.lineInfo.oddsApiMarket, l.lineInfo.oddsApiSelection,
      l.lineInfo.line != null ? Math.abs(l.lineInfo.line) : null, l.lineInfo.startTime
    );
    return {
      team: l.lineInfo.teamName,
      fairProb: fp || 0.5,
      lineInfo: l.lineInfo,           // exposure-key builders read pxEventId, startTime, homeTeam, awayTeam from here
      pxEventId: l.lineInfo.pxEventId, // explicit fallback fields if a checker reads them at top level
      startTime: l.lineInfo.startTime,
      homeTeam: l.lineInfo.homeTeam,
      awayTeam: l.lineInfo.awayTeam,
    };
  });
  const exposureCheck = orderTracker.checkExposureLimits(
    legsWithProb, estPayout, config.pricing.maxExposurePerTeam
  );
  if (!exposureCheck.allowed) {
    log.info('Pricing', `Exposure limit: ${exposureCheck.reason}`);
    try {
      const push = require('./push');
      const v = (exposureCheck.violations || [])[0];
      if (v) push.notifyCapHit('team', { subject: v.team, limit: v.limit, current: v.wouldBe });
    } catch (_) { /* fire-and-forget */ }
    return { declined: true, reason: 'team exposure limit', detail: exposureCheck.reason, violations: exposureCheck.violations, estPayout };
  }

  // Per-event aggregate cap (quote-time gate). Catches the same risk
  // as the team check but at the EVENT level — a parlay with Lakers
  // spread on one leg and Hawks total on another (same LAL@ATL game)
  // ends up adding to BOTH team buckets but ALSO to the single
  // pxEventId bucket. Without this, repeated parlays touching opposite
  // sides of the same game can build event-level concentration that
  // no team-level cap sees.
  // Per-LINE cap. Sits alongside the team/game caps because those key on an
  // ENTITY: a counterparty pairing ONE repeated line with many different
  // partners spreads across a fresh team bucket and a fresh game bucket on
  // every ticket, so neither ever binds while the repeated line concentrates.
  // See checkLegExposure for the measured case that motivated it.
  const legCheck = orderTracker.checkLegExposure(
    legsWithProb, estPayout, config.pricing.maxExposurePerLeg
  );
  if (!legCheck.allowed) {
    log.info('Pricing', `Leg exposure limit: ${legCheck.reason}`);
    try {
      const push = require('./push');
      push.notifyCapHit('leg', { subject: legCheck.legLabel || 'line', limit: legCheck.limit, current: legCheck.wouldBe });
    } catch (_) { /* fire-and-forget */ }
    return {
      declined: true,
      reason: 'leg exposure limit',
      detail: legCheck.reason,
      violations: [{ team: legCheck.legLabel || 'line', wouldBe: legCheck.wouldBe || 0, limit: legCheck.limit || 0 }],
      estPayout,
    };
  }

  const gameCheck = orderTracker.checkGameExposure(
    legsWithProb, estPayout, config.pricing.maxExposurePerGame
  );
  if (!gameCheck.allowed) {
    log.info('Pricing', `Game exposure limit: ${gameCheck.reason}`);
    try {
      const push = require('./push');
      push.notifyCapHit('game', { subject: gameCheck.eventLabel || 'game', limit: gameCheck.limit, current: gameCheck.wouldBe });
    } catch (_) { /* fire-and-forget */ }
    return {
      declined: true,
      reason: 'game exposure limit',
      detail: gameCheck.reason,
      violations: [{ team: 'game-event', wouldBe: gameCheck.wouldBe || 0, limit: gameCheck.limit || 0 }],
      estPayout,
    };
  }

  // Series-specific gross exposure cap. Uses the tighter per-parlay
  // cap (config.pricing.maxSeriesRiskPerParlay) as the worst-case add
  // since that's what max_risk on the offer will be set to for series
  // parlays — PX cannot confirm an amount above it.
  const hasSeriesLeg = resolvedLegs.some(l =>
    typeof l.lineInfo.marketType === 'string' &&
    l.lineInfo.marketType.startsWith('series_')
  );
  if (hasSeriesLeg) {
    const seriesParlayCap = config.pricing.maxSeriesRiskPerParlay || 500;
    const seriesCheck = orderTracker.checkSeriesExposure(
      resolvedLegs, seriesParlayCap, config.pricing.maxSeriesGrossExposure
    );
    if (!seriesCheck.allowed) {
      log.info('Pricing', `Series exposure limit: ${seriesCheck.reason}`);
      return {
        declined: true,
        reason: 'series exposure limit',
        detail: seriesCheck.reason,
        violations: [{ team: 'series-event', wouldBe: seriesCheck.wouldBe || 0, limit: seriesCheck.limit || 0 }],
        estPayout: seriesParlayCap,
      };
    }
  }

  // Per-player exposure cap. Runs AFTER the series check so we have
  // the right estPayout — for prop-containing parlays, the per-parlay
  // cap is config.pricing.maxRiskPerParlayWithProp (smaller than the
  // generic estPayout). Use that as the additional-risk worst case.
  //
  // Unified check covers ALL player_<type> markets (Phase-2 NBA points/
  // rebounds/assists/threes_made + NHL shots_on_goal + legacy MLB
  // player_strikeouts). Caps come from MAX_EXPOSURE_PER_PLAYER_BY_SPORT
  // (per-sport JSON map) with MAX_EXPOSURE_PER_PLAYER_DEFAULT fallback.
  // Consolidated 2026-05-01 — previously K-props had a separate
  // MAX_EXPOSURE_PER_PITCHER env var ($500 default) that operators kept
  // forgetting to raise alongside the Phase-2 caps. The legacy
  // pitcherExposure map is still populated for instrumentation but no
  // longer drives gating.
  const hasAnyPropLeg = resolvedLegs.some(l =>
    l.lineInfo.marketType && /^player_/.test(l.lineInfo.marketType)
  );
  if (hasAnyPropLeg) {
    const propParlayCap = config.pricing.maxRiskPerParlayWithProp || 50;
    const playerCheck = orderTracker.checkPlayerExposure(
      resolvedLegs,
      propParlayCap,
      config.pricing.maxExposurePerPlayerBySport || {},
      config.pricing.maxExposurePerPlayerDefault,
    );
    if (playerCheck && playerCheck.exceeded) {
      const pendingTxt = playerCheck.pending ? ` + pending $${playerCheck.pending}` : '';
      log.info('Pricing', `Player exposure cap: ${playerCheck.player} (${playerCheck.sport}) would be $${playerCheck.wouldBe} (max $${playerCheck.max})`);
      try {
        const push = require('./push');
        push.notifyCapHit('player', { subject: `${playerCheck.player} (${playerCheck.sport})`, limit: playerCheck.max, current: playerCheck.wouldBe });
      } catch (_) {}
      return {
        declined: true,
        reason: 'player exposure limit',
        detail: `${playerCheck.player} (${playerCheck.sport}): current $${playerCheck.current}${pendingTxt} + this parlay $${propParlayCap} = $${playerCheck.wouldBe} > cap $${playerCheck.max}`,
        violations: [{ team: playerCheck.player, wouldBe: playerCheck.wouldBe, limit: playerCheck.max }],
        estPayout: propParlayCap,
      };
    }

    // Script-aware prop game caps (SGP roadmap Stage 0 / attack 3B):
    // per-(game, side) and total-per-game prop risk. The per-player cap
    // above can't see N tickets on N different players long the same game
    // script; these can. Worst-case charge = this parlay's per-parlay cap
    // (the experimental tier cap if the combo is experimental).
    try {
      const sgpGuard = require('./sgp-guard');
      const expCombo = sgpGuard.isExperimental(sgpCombo);
      const addRisk = expCombo
        ? (config.pricing.maxRiskSgpExperimental || 15)
        : propParlayCap;
      const gameCapCheck = sgpGuard.checkPropGameCaps(resolvedLegs, addRisk);
      if (!gameCapCheck.allowed) {
        log.info('Pricing', `Prop game cap: ${gameCapCheck.reason}`);
        return {
          declined: true,
          reason: 'prop game exposure limit',
          detail: gameCapCheck.reason,
          violations: [{ team: gameCapCheck.scope, wouldBe: gameCapCheck.wouldBe, limit: gameCapCheck.limit }],
          estPayout: addRisk,
        };
      }
      // Experimental-combo tier: daily filled-risk budget + auto-dark
      // stop-loss. Only fires for combos in SGP_EXPERIMENTAL_COMBOS.
      const expCheck = sgpGuard.checkExperiment(sgpCombo, addRisk);
      if (!expCheck.allowed) {
        log.info('Pricing', `SGP experiment gate: ${expCheck.reason}`);
        return {
          declined: true,
          reason: 'sgp_experiment_limit',
          detail: expCheck.reason,
        };
      }
    } catch (err) {
      // Guard must never crash pricing — but it also must not silently
      // disappear: fail CLOSED for experimental combos, open for the rest
      // (established caps still protect them).
      log.warn('Pricing', `sgp-guard check errored: ${err.message}`);
      if (sgpCombo && config.pricing.experimentalSgpCombos && config.pricing.experimentalSgpCombos.has(sgpCombo)) {
        return { declined: true, reason: 'sgp_experiment_limit', detail: `guard unavailable (${err.message}) — fail closed for experimental combo` };
      }
    }

    // Concurrent same-market payout cap (correlated-tail control). Bounds the
    // total open payout across every parlay holding this prop marketType on
    // the same slate-day — the cross-game / cross-counterparty concentration
    // the per-player and per-game caps can't see. Env-gated
    // (MAX_CONCURRENT_MARKET_PAYOUT, default 0 = off). Charge the same
    // worst-case per-parlay cap used above.
    const cmeCap = config.pricing.maxConcurrentMarketPayout || 0;
    if (cmeCap > 0) {
      let cmeAdd = propParlayCap;
      try {
        const sg = require('./sgp-guard');
        if (sg.isExperimental && sg.isExperimental(sgpCombo)) cmeAdd = config.pricing.maxRiskSgpExperimental || 15;
      } catch (_) { /* experimental detection best-effort — fall back to prop cap */ }
      const cme = orderTracker.checkConcurrentMarketExposure(resolvedLegs, cmeAdd, cmeCap);
      if (cme && cme.exceeded) {
        log.info('Pricing', `Concurrent market cap: ${cme.marketType} on ${cme.day} would be $${cme.wouldBe} (max $${cme.max})`);
        return {
          declined: true,
          reason: 'concurrent market exposure limit',
          detail: `${cme.marketType} (${cme.day}): open $${cme.current} + this parlay $${cmeAdd} = $${cme.wouldBe} > cap $${cme.max}`,
          violations: [{ team: cme.marketType, wouldBe: cme.wouldBe, limit: cme.max }],
          estPayout: cmeAdd,
        };
      }
    }
  }

  // On success, surface the resolved lineInfos keyed by lineId so the caller
  // can pass them to priceParlay and skip redundant lookupLine() calls.
  // Also surface the classified SGP combo (if any) so priceParlay can stamp
  // it on meta for order-tracking and per-combo analytics.
  const resolvedLineInfos = new Map();
  for (const r of resolvedLegs) resolvedLineInfos.set(r.lineId, r.lineInfo);
  return { declined: false, resolvedLineInfos, sgpCombo, sgpEventId };
}

/**
 * Re-validate pricing at confirmation time.
 * Check if fair values have moved significantly since we quoted.
 */
async function validateForConfirmation(parlayId, originalMeta) {
  if (!originalMeta || !originalMeta.legs) return { valid: false, reason: 'no original meta' };

  const legs = originalMeta.legs.map(l => l.lineId);
  // Skip the template-exposure ramp on the confirm reprice — it's quote-time
  // admission control, and re-running it here mis-rejects already-matched bets
  // (it would see this order's own pending reservation and fail closed). The
  // reprice is purely the fair-value drift check below.
  const currentPricing = await priceParlay(legs, { skipTemplateRamp: true });
  if (!currentPricing) {
    // Could not reprice. Common benign cause: line-index churn between
    // quote and confirm — a leg's lineId dropped out of the index because
    // the next refresh found it momentarily below the minBooks gate
    // (especially prop legs with thin TOA coverage). Walking away in that
    // case cost us won auctions (2026-05-12: a 4-leg RBI parlay was quoted,
    // won, then walked away from 3 times in 44 seconds), so we accept on
    // the original quote for it.
    //
    // But the original fix was UNCONDITIONAL accept — which is also a
    // ride-the-stale-quote channel: ANY reprice failure (stale odds, event
    // started, lineup-flipped pricing failures) got accepted at the original
    // number with no drift coverage (SGP roadmap Stage 0, attack 2A).
    // Now cause-and-time-bounded: accept ONLY when
    //   (a) the failure is transient index churn ('unknown line' — the leg
    //       priced fine at quote time and dropped from the index), AND
    //   (b) the quote is younger than the staleness budget for its leg mix
    //       (props: stalePropSeconds; team-only: stalePriceMinutes).
    // Every other reprice failure fails CLOSED (reject).
    // RACE-SAFE churn detection (adversarial-review fix): priceParlay's
    // _lastFailure static is overwritten by every concurrent RFQ pricing
    // call, and we just crossed an await — reading it for the accept/reject
    // DECISION could misclassify under load. Re-derive the churn signal
    // locally instead: index churn ⇔ a leg that priced at quote time no
    // longer resolves in the line index. _lastFailure stays log-only.
    const lastFailure = priceParlay._lastFailure || null;
    const failReason = lastFailure && lastFailure.reason;
    const isIndexChurn = legs.some(lid => !lineManager.lookupLine(lid));
    const hasPropLeg = (originalMeta.legs || []).some(l => /^player_/.test(l.market || l.marketType || ''));
    const budgetMs = hasPropLeg
      ? (config.pricing.stalePropSeconds || 420) * 1000
      : (config.pricing.stalePriceMinutes || 15) * 60 * 1000;
    // Quotes from before this deploy carry no quotedAtMs — treat as within
    // budget (offer validity already bounds their age to ≤60s).
    const quoteAgeMs = originalMeta.quotedAtMs ? (Date.now() - originalMeta.quotedAtMs) : null;
    const withinBudget = quoteAgeMs == null || quoteAgeMs <= budgetMs;
    if (isIndexChurn && withinBudget) {
      log.warn('Pricing', `Could not reprice at confirm (index churn) — accepting on original quote (age ${quoteAgeMs == null ? 'unknown' : Math.round(quoteAgeMs / 1000) + 's'})`);
      return {
        valid: true,
        reason: 'reprice unavailable (index churn); honoring original quote',
        currentPricing: null,
      };
    }
    log.warn('Pricing', `Could not reprice at confirm — REJECTING (failure=${failReason || 'unknown'}, churn=${isIndexChurn}, quoteAge=${quoteAgeMs == null ? '?' : Math.round(quoteAgeMs / 1000) + 's'}, budget=${Math.round(budgetMs / 1000)}s)`);
    return {
      valid: false,
      reason: `reprice failed (${failReason || 'unknown'}) — fail closed`,
      currentPricing: null,
    };
  }

  // Check if fair value has moved significantly against us since quote.
  // Threshold configurable via CONFIRMATION_DRIFT_THRESHOLD env var (default 3%).
  const originalProb = originalMeta.fairParlayProb;
  const currentProb = currentPricing.meta.fairParlayProb;
  const drift = Math.abs(currentProb - originalProb) / originalProb;
  const driftThreshold = config.pricing.confirmationDriftThreshold;

  if (drift > driftThreshold) {
    log.warn('Pricing', `Price drift of ${(drift * 100).toFixed(1)}% since quote (threshold ${(driftThreshold * 100).toFixed(1)}%) — rejecting confirmation`);
    return { valid: false, reason: `price drift ${(drift * 100).toFixed(1)}% > ${(driftThreshold * 100).toFixed(1)}%`, currentPricing };
  }

  return { valid: true, currentPricing };
}

function getLastPriceFailure() {
  return priceParlay._lastFailure || null;
}

module.exports = {
  setGolfOutrightsPaused,
  isGolfOutrightsPaused,
  // Exported for test/sgp-phi-family.test.js — pins the family buckets the
  // per-family phi map keys on.
  sgpPropFamily,
  // Exported for test/dnb-book-comparator.test.js — pins the draw-no-bet
  // product-matching rule that book comparisons depend on.
  __bookImpliedForLeg: bookImpliedForLeg,
  priceParlay,
  shouldDecline,
  validateForConfirmation,
  getLastPriceFailure,
  computeSingleLegQuote,
  decimalToAmerican,
  distributeLegProbs,
  // Exposed so /lines/detail can resolve golf fair probs through the
  // same DataGolf → DK → BetOnline cascade that the live pricing
  // path uses. Without this, the Lines tab shows no fair for any
  // golf matchup line even when pricing would succeed at RFQ time.
  getGolfMatchupFairProb,
};
