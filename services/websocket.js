const Pusher = require('pusher-js');
const { config, getBankroll } = require('../config');
const log = require('./logger');
const px = require('./prophetx');
const pricer = require('./pricer');
const orderTracker = require('./order-tracker');
const oddsFeed = require('./odds-feed');
const db = require('./db');

// Extract the player name from a PX prop market name. PX formats like:
//   "Tarik Skubal Pitching Strikeouts"
//   "Aaron Judge Total Bases"
//   "Mookie Betts Home Runs"
// Strategy: strip the trailing market-stat phrase. Returns null if no
// recognizable stat suffix found (so the shadow logger can flag it).
function extractPlayerNameFromPropMarket(marketName) {
  if (!marketName) return null;
  const m = String(marketName);
  // Patterns ordered by specificity. Each strips ONE known stat phrase.
  // Note PX often inserts "Total" between player and stat: "Luis Castillo
  // Total Pitching Strikeouts" — handle that with an optional `total\s+`
  // token in each pattern. Also strip a trailing "Total" as a final
  // cleanup in case any future market uses "<Player> Total" without the
  // stat phrase being matched.
  const strips = [
    // NBA double-double / triple-double — must run BEFORE the MLB
    // singles/doubles/triples strips below or " Double"/" Triple" at the
    // end of "<Player> Triple Double" gets eaten by the MLB patterns.
    /\s+(double|triple)\s*[-]?\s*double$/i,
    // ---- MLB ----
    /\s+(total\s+)?pitching\s+strike\s*outs?$/i,
    /\s+(total\s+)?batting\s+strike\s*outs?$/i,
    /\s+(total\s+)?strike\s*outs?\s+(thrown|recorded)$/i,
    /\s+(total\s+)?strike\s*outs?$/i,
    /\s+total\s+bases$/i,
    /\s+(total\s+)?home\s+runs?$/i,
    /\s+(total\s+)?rbis?$/i,
    /\s+(total\s+)?hits?$/i,
    /\s+(total\s+)?runs?$/i,
    /\s+(total\s+)?walks?$/i,
    /\s+(total\s+)?stolen\s+bases?$/i,
    /\s+(total\s+)?singles?$/i,
    /\s+(total\s+)?doubles?$/i,
    /\s+(total\s+)?triples?$/i,
    /\s+(total\s+)?earned\s+runs?$/i,
    /\s+outs\s+recorded$/i,
    /\s+innings\s+pitched$/i,
    // ---- NBA ----
    // Combos first so single-stat patterns don't shave off only the trailing
    // word and leave "<player> Total Points + Rebounds" with "Rebounds"
    // matched but the rest left in place.
    /\s+(total\s+)?points?\s*(\+|&|and|plus|\/)\s*rebounds?\s*(\+|&|and|plus|\/)\s*assists?$/i,
    /\s+(total\s+)?points?\s*(\+|&|and|plus|\/)\s*rebounds?$/i,
    /\s+(total\s+)?points?\s*(\+|&|and|plus|\/)\s*assists?$/i,
    /\s+(total\s+)?rebounds?\s*(\+|&|and|plus|\/)\s*assists?$/i,
    /\s+(total\s+)?steals?\s*(\+|&|and|plus|\/)\s*blocks?$/i,
    /\s+pra$/i, /\s+pr$/i, /\s+pa$/i, /\s+ra$/i, /\s+sb$/i,
    // Three-pointers — many variants
    /\s+(total\s+)?made\s+(three[\s-]*pointers?|threes?|3[\s-]*pointers?|3[\s-]*pt[s]?)$/i,
    /\s+(three[\s-]*pointers?|threes?|3[\s-]*pointers?)\s+made$/i,
    /\s+(total\s+)?(three[\s-]*pointers?|threes?|3[\s-]*pointers?|3[\s-]*pt[s]?)$/i,
    // ---- Soccer (World Cup props; PX phrasing) ----
    // Full phrases BEFORE the bare single-stat patterns below, otherwise the
    // bare pattern shaves only the tail ("<Player> To Give" / "<Player> To
    // Have At Least 1 Shot") and player matching fails.
    /\s+to\s+score\s+or\s+give\s+(an?\s+)?assists?$/i,
    /\s+to\s+give\s+(an?\s+)?assists?$/i,
    /\s+to\s+have\s+at\s+least\s+\d+\s+shots?(\s+on\s+target)?$/i,
    /\s+(total\s+)?shots?\s+on\s+target$/i,
    // ---- Football (NFL/NCAAF; PX phrasing, probe 2026-08-05) ----
    // Full phrase, optionally with PX's trailing "?" — must run before any
    // bare single-stat pattern so only the player name survives.
    /\s+to\s+score\s+a\s+touchdown\s*\??$/i,
    // Single stats
    /\s+(total\s+)?points?$/i,
    /\s+(total\s+)?rebounds?$/i,
    /\s+(total\s+)?assists?$/i,
    /\s+(total\s+)?blocks?$/i,
    /\s+(total\s+)?steals?$/i,
    /\s+(total\s+)?turnovers?$/i,
    /\s+(total\s+)?(field\s+goals?|fgs?)\s+(made|attempted)?$/i,
    /\s+(total\s+)?free\s+throws?\s+(made|attempted)?$/i,
    /\s+(total\s+)?minutes\s+played$/i,
    // Yes/No exotic markets without numeric line
    /\s+to\s+score\s+the\s+first\s+(basket|field\s+goal)$/i,
    // ---- NHL ----
    // Goalie-specific multi-word phrases FIRST so bare "Saves" doesn't
    // partial-match "Goalie Saves" and leave "<Player> Goalie".
    /\s+(total\s+)?(goalie|goaltender)\s+(saves?|wins?)$/i,
    /\s+goals?\s+against$/i,
    // Shots on goal BEFORE bare "goals" so "Shots on Goal" isn't
    // partially matched as "Goals".
    /\s+(total\s+)?shots?\s+on\s+goal$/i,
    /\s+(total\s+)?sog$/i,
    /\s+(total\s+)?saves?$/i,
    /\s+anytime\s+(goal|assist)\s*(scorer|recorder)?$/i,
    // PX names the anytime-goalscorer market "<Player> To Score a Goal" — strip
    // the FULL phrase before the bare goals pattern below, otherwise only the
    // trailing " Goal" gets shaved and "<Player> To Score a" fails player
    // matching. NHL goals props weren't registering at all (observed 2026-06-10).
    /\s+to\s+score\s+(an?\s+)?goals?$/i,
    /\s+(total\s+)?goals?$/i,
    /\s+(total\s+)?(blocked\s+shots?|blocks?)$/i,
    /\s+(total\s+)?hits?$/i,
    /\s+(total\s+)?(penalty\s+minutes?|pim)$/i,
    /\s+(total\s+)?faceoffs?(\s+won)?$/i,
    /\s+(power\s+play|pp)\s+(point|points|goal|goals|assist|assists)$/i,
  ];
  for (const re of strips) {
    if (re.test(m)) {
      let name = m.replace(re, '').trim();
      // Final cleanup — if a stray "Total" remains at the end, strip it.
      // Defends against future PX market names like "<Player> Total" we
      // haven't accounted for in the regex above.
      name = name.replace(/\s+total$/i, '').trim();
      return name || null;
    }
  }
  return null;
}

// Football-shaped prop names that MUST NOT be classified by another sport's
// classifier. Measured misroutes (NFL_CFB_READINESS_2026-08-05.md):
//   classifyNbaProp("Bijan Robinson To Score a Touchdown")  → 'turnovers'
//     (the /\btos?\b/ turnover alternation matched the word "To")
//   classifyNhlProp("Justin Tucker Field Goals Made")        → 'goals'
//   classifyMlbProp("Jeremiah Love To Score a Touchdown")    → 'hitter_other'
//     (via the /to\s+score/ hitter pattern)
// A misclassified football prop doesn't just pollute Phase-0 stats: the prop
// routers key TOA market lookups on the classifier output, so a football name
// classified as an NBA/NHL/MLB propType would look up a completely wrong
// book market. Every marker here is football-unambiguous ACROSS the sports
// that consult it — "field goal" is deliberately NOT here because it is a
// real NBA stat (classifyNhlProp adds it separately; hockey has no field
// goals).
const FOOTBALL_PROP_NAME_RE = /touch\s*down|\btds?\b|to\s+throw\s+an?\s+interception|interceptions?\s+thrown|(?:passing|rushing|receiving)\s+yards?|pass\s+(?:completions?|attempts?)|\breceptions?\b|\bsacks?\b|kicking\s+points?|extra\s+points?\s+made/i;

// Football player-prop sub-classifier. Mirrors the MLB/NBA/NHL/soccer
// classifiers. Only 'anytime_td' maps to a TOA market
// (line-manager _FOOTBALL_PROP_TO_TOA_MARKET) — every other bucket exists
// for decline-rollup visibility and never registers. Quoting additionally
// requires a PROP_LAUNCH_ALLOWLIST entry (none shipped = fully dark).
//
// Returns one of:
//   'anytime_td'          — "<Player> To Score a Touchdown" (PX sup_moneyline YES/NO)
//   'first_td'            — first-TD variants (novelty; no source wired)
//   'passing_yards' / 'rushing_yards' / 'receiving_yards' / 'receptions'
//                         — volume stats (not posted 5 weeks out; re-measure in game week)
//   'interception_thrown' — single-player INT market
//   'field_goals_made' / 'kicking_points' — kicker props
//   'other_football_prop' — football-shaped but unbucketed
//   null                  — not a recognizable football prop (game markets like
//                           "Moneyline"/"Total Points" return null so the prop
//                           routers skip them), OR a multi-player composite
//                           ("Kenny Pickett or Carson Beck To Throw An
//                           Interception?") which is unpriceable by
//                           construction — no book posts an OR-of-two-players
//                           market — and must stay unclassified so it declines.
function classifyFootballProp(marketName) {
  if (!marketName) return null;
  const n = String(marketName).toLowerCase().trim();
  // Multi-player / unit composites fail closed (mirrors the parser's
  // or/and/&/slash guard in prophetx.js parseMarketSelections).
  if (/\b(?:or|and)\b|[&/+,]/.test(n)) return null;
  if (/\bto\s+score\s+a\s+touchdown\s*\??$/.test(n)) return 'anytime_td';
  if (/\b(?:first|1st)\s+touchdown\b|to\s+score\s+the\s+first\s+touchdown/.test(n)) return 'first_td';
  if (/passing\s+yards?/.test(n)) return 'passing_yards';
  if (/rushing\s+yards?/.test(n)) return 'rushing_yards';
  if (/receiving\s+yards?/.test(n)) return 'receiving_yards';
  if (/\breceptions?\b/.test(n)) return 'receptions';
  if (/to\s+throw\s+an?\s+interception|interceptions?\s+thrown/.test(n)) return 'interception_thrown';
  if (/field\s+goals?\s+made/.test(n)) return 'field_goals_made';
  if (/kicking\s+points?|extra\s+points?\s+made/.test(n)) return 'kicking_points';
  if (FOOTBALL_PROP_NAME_RE.test(n)) return 'other_football_prop';
  return null;
}
// (exported via module.exports block at end of file as _classifyFootballProp)

// MLB player-prop sub-classifier (Phase 0 of pitcher-strikeouts experiment).
// We currently bucket all MLB props as `category='player_prop'`. To decide
// whether to subscribe to a paid prop feed, we need to know what % of that
// volume is specifically pitcher strikeouts (Phase 2's first market) vs
// hitter props vs pitcher non-K props.
//
// Returns one of:
//   'pitcher_strikeouts' — the experiment target market (Pitching Ks)
//   'pitcher_other'      — outs/innings/walks/earned-runs/win/loss
//   'hitter_strikeouts'  — Batting Strikeouts (real market on PX)
//   'hitter_total_bases' — top hitter market
//   'hitter_hits'        — hits incl. 2+ hits, etc.
//   'hitter_hr'          — home runs / power props
//   'hitter_rbi_runs'    — RBIs, runs scored
//   'hitter_other'       — singles/doubles/triples/sb/etc.
//   'mlb_prop_ambiguous' — strikeout prop without Pitching/Batting prefix
//                          (rare in PX feed but possible from other books)
//   'other_mlb_prop'     — couldn't classify (catch-all)
//   null                 — input wasn't an MLB market name
//
// PX's naming convention disambiguates pitcher vs hitter K markets
// explicitly: "Pitching Strikeouts" vs "Batting Strikeouts". The
// classifier matches those forms strictly; bare "Strikeouts" with no
// pitching/batting qualifier (e.g. "Tarik Skubal Strikeouts" if it
// ever appears) routes to mlb_prop_ambiguous so it doesn't pollute
// the pitcher_strikeouts bucket the Step 1 decision relies on.
function classifyMlbProp(marketName) {
  if (!marketName) return null;
  const n = String(marketName).toLowerCase();
  // Football names belong to classifyFootballProp — measured misroute:
  // "Jeremiah Love To Score a Touchdown" hit the /to\s+score/ hitter
  // pattern below and returned 'hitter_other'.
  if (FOOTBALL_PROP_NAME_RE.test(n)) return null;
  // Pitcher strikeouts — PX's "Pitching Strikeouts" + variants where
  // 'thrown'/'recorded' makes pitcher-side unambiguous on its own.
  // Allow optional 's / s suffix on K to catch "K's Thrown".
  if (/pitching\s+strike\s*out|\bk'?s?\s+(thrown|recorded)\b|strike\s*outs?\s+(thrown|recorded)/.test(n)) {
    return 'pitcher_strikeouts';
  }
  // Hitter strikeouts — PX's "Batting Strikeouts" form.
  if (/batting\s+strike\s*out/.test(n)) {
    return 'hitter_strikeouts';
  }
  // Bare "strikeouts" / "K's" without pitching/batting qualifier.
  // Could be either side; flag separately so Phase 0 numbers stay
  // honest. Operator can sample these in /prop-opportunity to confirm
  // PX always uses the qualified form (in which case this bucket
  // should be ~0).
  if (/strike\s*out|\bk'?s\b/.test(n)) {
    return 'mlb_prop_ambiguous';
  }
  // Pitcher non-K props. Earned runs, innings pitched, outs recorded
  // are pitcher-only by definition.
  if (/innings\s+pitch|outs\s+recorded|earned\s+run|hits\s+allow|walks\s+(allow|issued)|pitcher.*(win|loss|decision|to\s+(get|record))|\bera\b|\bwhip\b/.test(n)) {
    return 'pitcher_other';
  }
  // Hitter combo props (multi-stat), e.g. "Hits + Runs + RBIs" /
  // "Total Hits, Runs & RBIs". Mirror the NBA classifier (pra_combo): detect
  // multi-stat combos BEFORE the single-stat buckets. A composite must NOT
  // fall through to a single-stat bucket (hitter_rbi_runs / hitter_hits / ...)
  // — those map to ONE TOA book market (e.g. hitter_rbi_runs -> batter_rbis =
  // pure RBIs), and pricing the much-more-likely combo against single-stat
  // odds would badly underprice it (the "Arozarena Total Hits, Runs & RBIs
  // 1.5 -> hitter_rbi_runs" landmine, observed flooding declines 2026-06-16).
  // Route to hitter_other (no TOA mapping, not one-sided-eligible) so combos
  // always decline safely. NOTE: "Home Runs" contains "runs" but is a single
  // stat — exclude it from the runs/RBI category before counting.
  // Combo: Hits + Runs + RBIs. Matches multiple single-stat words, so detect it
  // BEFORE the >=2-category → hitter_other fallthrough below. Maps to TOA
  // batter_hits_runs_rbis (priced exact-line de-vig — correlated compound stat).
  if (/hits?\s*\+\s*runs?\s*\+\s*rbis?|\bh\s*\+\s*r\s*\+\s*rbis?\b/.test(n)) return 'hitter_hits_runs_rbis';
  const _hHr      = /home\s+run|\bhr\b/.test(n);
  const _hTb      = /total\s+bases|\btb\b/.test(n);
  const _hHits    = /\bhits?\b/.test(n);
  const _hRbiRuns = /\brbi/.test(n) || /runs\s+batted\s+in/.test(n) || /runs\s+scored/.test(n)
    || (/\bruns?\b/.test(n) && !/home\s+runs?/.test(n));
  const _hitterStatCats = (_hHr ? 1 : 0) + (_hTb ? 1 : 0) + (_hHits ? 1 : 0) + (_hRbiRuns ? 1 : 0);
  if (_hitterStatCats >= 2) return 'hitter_other';

  // Hitter buckets — order matters; check most specific first
  if (/total\s+bases|tb\b/.test(n)) return 'hitter_total_bases';
  if (/home\s+run|\bhr\b/.test(n)) return 'hitter_hr';
  if (/\brbi/.test(n) || /runs\s+batted\s+in/.test(n) || /runs\s+scored/.test(n)) return 'hitter_rbi_runs';
  if (/\bhits\b|to\s+record\s+a\s+hit/.test(n)) return 'hitter_hits';
  if (/stolen\s+bases?|\bsb\b/.test(n)) return 'hitter_stolen_bases';
  if (/single|double|triple|walk\b|to\s+score/.test(n)) return 'hitter_other';
  // No specific match — flag as generic MLB prop so the bucket is
  // visible (helps future iterations of this classifier catch new
  // book naming conventions).
  return 'other_mlb_prop';
}
// (exported via module.exports block at end of file as _classifyMlbProp)

// NBA player-prop sub-classifier (Phase 0 instrumentation only — we do
// NOT quote NBA props yet). Mirrors classifyMlbProp so the same in-
// memory rollup (recordDecline.byPropType) and the [propType:X] tag in
// unknown_details capture NBA prop volume by market type. Phase 4+ will
// use this data to size which NBA props (if any) are worth quoting.
//
// Returns one of:
//   'points'             — "Player Points" / "Total Points" (single stat)
//   'rebounds'           — "Player Rebounds" / "Total Rebounds"
//   'assists'            — "Player Assists" / "Total Assists"
//   'threes_made'        — 3-pointers / threes made
//   'blocks'             — "Player Blocks"
//   'steals'             — "Player Steals"
//   'steals_blocks'      — combined steals + blocks
//   'pra_combo'          — any combo of points/rebounds/assists (PRA, PR, PA, RA)
//   'double_double'      — "Double Double"
//   'triple_double'      — "Triple Double"
//   'turnovers'          — "Player Turnovers"
//   'first_basket'       — "First Basket Scorer" — high-variance, illiquid
//   'nba_prop_ambiguous' — combo containing other stats we can't bucket cleanly
//   'other_nba_prop'     — couldn't classify (catch-all)
//   null                 — input wasn't a market name
//
// Ordering matters: combos are checked BEFORE single-stat buckets so
// "Points + Rebounds + Assists" doesn't match the points regex first.
function classifyNbaProp(marketName) {
  if (!marketName) return null;
  const n = String(marketName).toLowerCase();

  // Football names belong to classifyFootballProp — measured misroute:
  // "Bijan Robinson To Score a Touchdown" matched the /\btos?\b/ turnover
  // alternation (the word "To") and returned 'turnovers'.
  if (FOOTBALL_PROP_NAME_RE.test(n)) return null;

  // Triple/double double — check before single-stat patterns
  if (/triple\s*[-]?\s*double/.test(n)) return 'triple_double';
  if (/double\s*[-]?\s*double/.test(n)) return 'double_double';

  // First basket / first field goal — illiquid, high-variance
  if (/first\s+(basket|field\s+goal|fg)/.test(n)) return 'first_basket';

  // Combos — detect by counting how many of the core stats appear in
  // the same market name. Use word boundaries to avoid matching
  // "rebounds" inside other words.
  const hasPoints   = /\bpoints?\b|\bpts\b/.test(n);
  const hasRebounds = /\brebounds?\b|\brebs?\b|\breb\b/.test(n);
  const hasAssists  = /\bassists?\b|\basts?\b|\bast\b/.test(n);
  const hasThrees   = /\bthrees?\b|3[-\s]*point|3[-\s]*pt|three\s*pointer/.test(n);
  const hasBlocks   = /\bblocks?\b|\bblks?\b/.test(n);
  const hasSteals   = /\bsteals?\b|\bstls?\b/.test(n);
  const praCount = (hasPoints ? 1 : 0) + (hasRebounds ? 1 : 0) + (hasAssists ? 1 : 0);

  if (praCount >= 2) {
    // Pure PRA-family combo (points/rebounds/assists in any pairing).
    // If it ALSO mixes in threes/blocks/steals, route to ambiguous so
    // the bucket stays clean for sizing.
    if (hasThrees || hasBlocks || hasSteals) return 'nba_prop_ambiguous';
    return 'pra_combo';
  }

  // Steals + blocks combo (no points/reb/ast involved)
  if (hasSteals && hasBlocks) return 'steals_blocks';

  // Any other 2+ core-stat combo (e.g. "Points + Threes", "Rebounds +
  // Steals") that didn't match the named buckets above. Route to
  // ambiguous so single-stat sizing doesn't get inflated by combos.
  const statCount = praCount + (hasThrees ? 1 : 0) + (hasBlocks ? 1 : 0) + (hasSteals ? 1 : 0);
  if (statCount >= 2) return 'nba_prop_ambiguous';

  // Single-stat buckets — order from most-specific to least.
  // Threes first since "Made Threes" can read as a points-like phrase
  // in some books.
  if (hasThrees) return 'threes_made';
  if (hasBlocks) return 'blocks';
  if (hasSteals) return 'steals';
  if (hasRebounds) return 'rebounds';
  if (hasAssists) return 'assists';
  // \btos\b (plural only) — the old \btos?\b also matched the bare English
  // word "to", so ANY market name containing "To ..." that reached this
  // line classified as turnovers. Real turnover props say "Turnovers".
  if (/\bturnovers?\b|\btos\b/.test(n)) return 'turnovers';
  if (hasPoints) return 'points';

  // Other recognized NBA prop families we don't yet bucket
  if (/free\s+throw|\bft\b/.test(n)) return 'other_nba_prop';
  if (/field\s+goal|\bfg\b/.test(n)) return 'other_nba_prop';
  if (/minutes\s+played|\bmins?\b/.test(n)) return 'other_nba_prop';

  return 'other_nba_prop';
}
// (exported via module.exports block at end of file as _classifyNbaProp)

// NHL player-prop sub-classifier. Mirrors classifyMlbProp / classifyNbaProp
// shape so the same in-memory rollup (recordDecline.byPropType) and the
// [propType:X] tag in unknown_details capture NHL prop volume.
//
// Returns one of:
//   'shots_on_goal'   — "Player Shots on Goal" / "SOG"
//   'goals'           — "Player Goals" / "Anytime Goal Scorer"
//   'assists'         — "Player Assists"
//   'points'          — "Player Points" (goals + assists, NHL-style)
//   'saves'           — "Goalie Saves" / "Total Saves"
//   'pim'             — "Penalty Minutes"
//   'blocks'          — "Player Blocks" / "Blocked Shots"
//   'hits'            — "Player Hits"
//   'goalie_other'    — goalie wins / goals against / shutouts
//   'nhl_prop_ambiguous' — multi-stat combo
//   'other_nhl_prop'  — couldn't classify
//   null              — input wasn't a market name
//
// Ordering matters: combos and goalie-specific markets checked before
// generic stat patterns ("saves" before "shots" since both have shot in
// the wider context).
function classifyNhlProp(marketName) {
  if (!marketName) return null;
  const n = String(marketName).toLowerCase();

  // Football names belong to classifyFootballProp — measured misroute:
  // "Justin Tucker Field Goals Made" matched the goals pattern and
  // returned 'goals'. "Field goal" is checked here (not in the shared
  // football RE) because it IS a real NBA stat but is NOT a hockey one.
  if (FOOTBALL_PROP_NAME_RE.test(n) || /field\s+goals?/.test(n)) return null;

  // Goalie-specific markets first — these are unambiguous and should
  // not be conflated with skater stats.
  if (/(goalie|goaltender)\s+save|total\s+save|^saves?\b/.test(n)) return 'saves';
  if (/(goalie|goaltender).*(win|loss|decision)|goalie\s+win/.test(n)) return 'goalie_other';
  if (/goals?\s+against|\bga\b|shutout/.test(n)) return 'goalie_other';

  // Combo detection — multi-stat NHL props are rare but possible.
  // Strip "shots on goal" / "sog" / "blocked shots" before checking
  // individual stat words so the "goal" inside "shots on goal" doesn't
  // trip the goals matcher (and same for "shots" inside "blocked shots").
  const hasShots    = /shots?\s+on\s+goal|\bsog\b/.test(n);
  const hasBlocks   = /blocked\s+shots?|\bblocks?\b|\bblks?\b/.test(n);
  const stripped    = n
    .replace(/shots?\s+on\s+goal/g, '')
    .replace(/\bsog\b/g, '')
    .replace(/blocked\s+shots?/g, '');
  const hasGoals    = /\bgoals?\b/.test(stripped);
  const hasAssists  = /\bassists?\b/.test(stripped);
  const hasPointsW  = /\bpoints?\b|\bpts\b/.test(stripped);
  const hasHits     = /\bhits?\b/.test(stripped);
  const hasPim      = /penalty\s+minutes?|\bpim\b/.test(stripped);

  // Goals + assists = NHL "points" — collapse to single bucket
  if (hasGoals && hasAssists && !hasShots && !hasBlocks && !hasHits) return 'points';

  // Any other 2+ core-stat combo
  const statCount = (hasGoals ? 1 : 0) + (hasAssists ? 1 : 0) + (hasPointsW ? 1 : 0)
    + (hasShots ? 1 : 0) + (hasBlocks ? 1 : 0) + (hasHits ? 1 : 0);
  if (statCount >= 2) return 'nhl_prop_ambiguous';

  // Single-stat buckets
  if (hasShots) return 'shots_on_goal';
  if (hasGoals) return 'goals';
  if (hasAssists) return 'assists';
  if (hasPointsW) return 'points';
  if (hasBlocks) return 'blocks';
  if (hasHits) return 'hits';
  if (hasPim) return 'pim';

  return 'other_nhl_prop';
}
// (exported via module.exports block at end of file as _classifyNhlProp)

// Soccer player-prop sub-classifier. Mirrors the MLB/NBA/NHL classifiers so
// the decline rollup (recordDecline.byPropType) and the [propType:X] tag in
// unknown_details capture World Cup prop volume by market type — visible in
// /prop-opportunity and decline stats even before (or beyond what) the
// PROP_LAUNCH_ALLOWLIST quotes.
//
// Returns one of:
//   'goalscorer'           — "<P> To Score a Goal" (quotable: soccer.goalscorer)
//   'shots_on_target'      — "At Least N Shot(s) On Target" (quotable: sot_1/sot_2)
//   'shots'                — "At Least N Shot(s)" total shots (NOT quotable — no book source)
//   'assists'              — "To Give Assist" (quotable: soccer.assists)
//   'score_or_assist'      — combo market (NOT quotable — no book source)
//   'other_soccer_prop'    — couldn't classify
//   null                   — input wasn't a market name
//
// Ordering matters: "Shots On Target" before bare "Shot(s)"; the combo
// before goalscorer/assists so "To Score Or Give Assist" doesn't partial-
// match either single-stat bucket.
function classifySoccerProp(marketName) {
  if (!marketName) return null;
  const n = String(marketName).toLowerCase();
  if (/to score or give (an? )?assist/.test(n)) return 'score_or_assist';
  if (/to have at least \d+ shots? on target/.test(n)) return 'shots_on_target';
  if (/to have at least \d+ shots?\b/.test(n)) return 'shots';
  if (/to score (a )?goal/.test(n)) return 'goalscorer';
  if (/to give (an? )?assist/.test(n)) return 'assists';
  return 'other_soccer_prop';
}
// (exported via module.exports block at end of file as _classifySoccerProp)

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

let pusherClient = null;
let broadcastChannel = null;
let privateChannel = null;
let channelNames = { broadcast: null, private: null };
// Paused defaults to TRUE at boot so any unexpected restart (Railway
// auto-restart, OOM, health-check flip, manual redeploy) comes up
// safely paused rather than silently resuming unprotected quoting.
// Observed 2026-04-23: service restarted multiple times in a single
// afternoon and each restart dropped the in-memory pause state —
// quoted ~49 RFQs unprotected before caught.
//
// Supabase-backed persistence (see loadPausedState/persistPausedState
// below) overrides this default once the DB load completes, so the
// LAST explicit /pause or /resume call wins across restarts. An
// operator who explicitly resumed before a crash will see the service
// come back up in the resumed state; the default-true only protects
// the narrow window where (a) the DB read is in flight, or (b) no
// persisted state exists yet (fresh deploy).
//
// Legacy env-var override still honored for manual control —
// START_PAUSED=false will force initial paused=false, useful only
// for dev / initial bring-up.
let paused = true;
if (process.env.START_PAUSED === 'false' || process.env.START_PAUSED === '0') {
  paused = false;
}

// Persist pause state to Supabase so it survives restarts. Keyed KV
// storage (see db.saveKV / loadKV). Fire-and-forget save with error
// logged; next /pause or /resume call retries automatically.
const PAUSED_STATE_KEY = 'websocket_paused_state';
async function persistPausedState(newValue) {
  try {
    const db = require('./db');
    await db.saveKV(PAUSED_STATE_KEY, { paused: newValue, updatedAt: new Date().toISOString() });
  } catch (err) {
    log.warn('WS', `persistPausedState failed: ${err.message}`);
  }
}
// Load persisted state at boot. If present, override the default. Called
// from loadFromDbOnBoot() below after the db client is ready.
async function loadPausedStateFromDb() {
  try {
    const db = require('./db');
    const row = await db.loadKV(PAUSED_STATE_KEY);
    if (row && typeof row.paused === 'boolean') {
      const wasPaused = paused;
      paused = row.paused;
      log.info('WS', `Loaded persisted pause state: paused=${paused} (was ${wasPaused}, updatedAt=${row.updatedAt || 'unknown'})`);
      return { loaded: true, paused, updatedAt: row.updatedAt };
    }
    log.info('WS', 'No persisted pause state — keeping boot default (paused=true)');
    return { loaded: false, paused };
  } catch (err) {
    log.warn('WS', `loadPausedStateFromDb failed: ${err.message} — keeping current paused=${paused}`);
    return { loaded: false, paused, error: err.message };
  }
}
let connectionState = 'disconnected';
let lastHealthCheck = null;
let healthCheckTimer = null;
let reconnectAttempts = 0;
let channelAuth = {}; // { channelName: authString } from PX registration
let _connectingPromise = null; // single-flight guard for connect()

// ---------------------------------------------------------------------------
// CONNECT
// ---------------------------------------------------------------------------

/**
 * Fully tear down the current Pusher client: unbind ALL event handlers, then
 * disconnect, then null the reference.
 *
 * This is the fix for the boot-retry zombie-client bug (diagnosed 2026-06-02).
 * connect() used to do `new Pusher()` on every attempt WITHOUT tearing down
 * the previous client. pusher-js auto-connects and runs its own internal
 * reconnect loop, and the old client's `state_change` handler keeps writing
 * the shared module-level `connectionState` — so a zombie from a failed boot
 * attempt could flip connectionState back to 'disconnected' AFTER the live
 * client connected, leaving the service stuck disconnected until a manual
 * /reconnect (which only "worked" because by then PX had evicted the stale
 * sessions AND the zombies had gone quiet). Unbinding handlers before
 * replacing the client guarantees exactly one writer of connectionState.
 */
function _teardownClient() {
  if (!pusherClient) return;
  try { pusherClient.connection && pusherClient.connection.unbind_all && pusherClient.connection.unbind_all(); } catch (_) {}
  try { pusherClient.unbind_all && pusherClient.unbind_all(); } catch (_) {}
  try { pusherClient.disconnect(); } catch (_) {}
  pusherClient = null;
}

/**
 * Single-flight wrapper around the real connect sequence. If a connect is
 * already in progress, concurrent callers (boot-retry loop, runtime watchdog,
 * manual /reconnect) get the SAME in-flight promise instead of each spawning a
 * competing Pusher client. Combined with _teardownClient(), this ensures there
 * is only ever one live client.
 */
async function connect() {
  if (_connectingPromise) {
    log.info('WS', 'connect() already in progress — returning in-flight promise');
    return _connectingPromise;
  }
  _connectingPromise = _doConnect();
  try {
    return await _connectingPromise;
  } finally {
    _connectingPromise = null;
  }
}

/**
 * Full connection sequence:
 * 1. Get Pusher config from PX
 * 2. Create Pusher client
 * 3. Wait for connection
 * 4. Register socket_id with PX
 * 5. Subscribe to broadcast + private channels
 * 6. Bind event handlers
 */
async function _doConnect() {
  log.info('WS', 'Starting WebSocket connection...');

  // Kill any prior client (and its bound handlers) before creating a new one,
  // so a failed/previous attempt's client can't keep racing connectionState.
  _teardownClient();

  // 1. Get Pusher config
  const wsConfig = await px.getWebSocketConfig();
  log.info('WS', `Pusher config: key=${wsConfig.key}, cluster=${wsConfig.cluster}`);

  // 2. Create Pusher client
  pusherClient = new Pusher(wsConfig.key, {
    cluster: wsConfig.cluster,
    forceTLS: true,
    // Tightened from pusher-js defaults (120s/30s) so a half-open TCP path
    // is detected faster. Caught 2026-06-01 03:39am ET: socket silently
    // died, pusher-js never declared it dead, reconnectAttempts stayed 0,
    // and we missed 7.5h of RFQs. The new watchdog below catches the
    // *pong-without-data* failure mode that even these can miss, but
    // these timeouts shorten detection for the pure half-open TCP case.
    activityTimeout: 60_000,  // 1 min idle → send ping
    pongTimeout: 15_000,      // 15s to pong → declare dead, reconnect
    // Custom authorizer — uses auth tokens from PX registration response
    authorizer: (channel, options) => ({
      authorize: (socketId, callback) => {
        // Use pre-fetched auth from PX registration
        const auth = channelAuth[channel.name];
        if (auth) {
          log.debug('WS', `Authorizing channel ${channel.name} with cached auth`);
          callback(null, { auth });
          return;
        }

        // Fallback: call PX auth endpoint directly
        log.info('WS', `No cached auth for ${channel.name}, calling PX auth endpoint...`);
        (async () => {
          try {
            const token = await px.login();
            const resp = await fetch(
              `${require('../config').config.px.baseUrl}/parlay/sp/websocket/auth`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  socket_id: socketId,
                  channel_name: channel.name,
                }),
              }
            );
            const data = await resp.json();
            callback(null, data);
          } catch (err) {
            log.error('WS', `Channel auth failed for ${channel.name}: ${err.message}`);
            callback(err);
          }
        })();
      },
    }),
  });

  // 3. Wait for connection
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Tear down the half-open client so it doesn't keep consuming a PX
      // session slot — otherwise the next boot-retry attempt hits
      // session_num_exceed against a session this very attempt is holding.
      _teardownClient();
      reject(new Error('Pusher connection timeout (30s)'));
    }, 30000);

    pusherClient.connection.bind('connected', async () => {
      clearTimeout(timeout);
      connectionState = 'connected';
      reconnectAttempts = 0;
      // Seed lastHealthCheck so the watchdog doesn't fire on a fresh
      // reconnect just because the first health event hasn't arrived yet
      // (pusher-js can take up to activityTimeout to send the first ping).
      lastHealthCheck = Date.now();
      const socketId = pusherClient.connection.socket_id;
      log.info('WS', `Connected! socket_id=${socketId}`);

      try {
        // 4. Register socket with PX
        const regData = await px.registerWebSocket(socketId);
        log.info('WS', 'WebSocket registered with PX', regData);

        // Parse channel info from registration response
        parseChannels(regData);

        // 5-6. Subscribe and bind
        subscribeAndBind();

        // Start health check monitor
        startHealthCheckMonitor();

        resolve();
      } catch (err) {
        log.error('WS', `Post-connect setup failed: ${err.message}`);
        // Registration/subscribe failed but the socket is fully connected and
        // holding a PX session — tear it down before rejecting so the retry
        // doesn't collide with our own orphaned session.
        _teardownClient();
        reject(err);
      }
    });

    pusherClient.connection.bind('error', (err) => {
      log.error('WS', `Connection error: ${JSON.stringify(err)}`);
    });

    // Monitor state changes
    pusherClient.connection.bind('state_change', (states) => {
      const prev = connectionState;
      connectionState = states.current;
      log.info('WS', `State: ${states.previous} → ${states.current}`);

      if (states.current === 'disconnected' || states.current === 'failed') {
        reconnectAttempts++;
        if (reconnectAttempts > 10) {
          log.error('WS', 'Too many reconnect attempts — stopping');
        }
        // Push notification on transition to disconnected (debounced 1min
        // so a reconnect-storm doesn't spam). Skip the very first transition
        // out of 'initialized' which is normal startup.
        if (prev === 'connected') {
          try {
            require('./push').notifyConnectionState('disconnected', `WebSocket dropped (attempt ${reconnectAttempts})`);
          } catch (_) {}
        }
      }

      // On reconnect, re-register
      if (states.current === 'connected' && states.previous !== 'initialized') {
        handleReconnect();
        // Notify on successful reconnect after a real disconnect.
        if (prev !== 'connected') {
          try {
            require('./push').notifyConnectionState('reconnected', 'PX RFQ stream restored');
          } catch (_) {}
        }
      }
    });
  });
}

/**
 * Parse channel names from the PX registration response.
 *
 * Actual PX response format:
 * {
 *   auth: "...",
 *   data: {
 *     success: true,
 *     status: "CONNECTED",
 *     authorized_channel: [
 *       { channel_name: "private-broadcast-service=4-device_type=5", auth: "...", binding_events: ["price.ask.new", "order.matched"] },
 *       { channel_name: "private-service=4-device_type=5-user=xxx", auth: "...", binding_events: ["price.confirm.new", ...] }
 *     ]
 *   }
 * }
 *
 * Note: Both channels are private- prefixed. The broadcast channel has "broadcast" in the name.
 */
function parseChannels(regData) {
  // Store per-channel auth tokens for the Pusher authorizer
  channelAuth = {};

  const d = regData.data || regData;

  // Handle the authorized_channel array format
  if (d.authorized_channel && Array.isArray(d.authorized_channel)) {
    for (const ch of d.authorized_channel) {
      const name = ch.channel_name;
      if (!name) continue;

      // Store auth for this channel
      channelAuth[name] = ch.auth;

      // Classify channel by name
      if (name.includes('broadcast')) {
        channelNames.broadcast = name;
        log.info('WS', `Broadcast channel: ${name} (events: ${(ch.binding_events || []).join(', ')})`);
      } else {
        channelNames.private = name;
        log.info('WS', `Private channel: ${name} (events: ${(ch.binding_events || []).join(', ')})`);
      }
    }
  }

  // Fallback: try other response formats
  if (!channelNames.broadcast && !channelNames.private) {
    if (d.channels) {
      for (const ch of (Array.isArray(d.channels) ? d.channels : [d.channels])) {
        const name = ch.name || ch.channel_name || ch;
        if (typeof name === 'string') {
          if (name.includes('broadcast')) channelNames.broadcast = name;
          else channelNames.private = name;
        }
      }
    }
  }

  if (!channelNames.broadcast && !channelNames.private) {
    log.error('WS', 'Could not parse channel names from registration response:', JSON.stringify(regData).substring(0, 500));
  }

  log.info('WS', `Channels configured: broadcast=${channelNames.broadcast}, private=${channelNames.private}`);
}

/**
 * Subscribe to channels and bind event handlers.
 */
function subscribeAndBind() {
  // Broadcast channel — RFQ events
  if (channelNames.broadcast) {
    broadcastChannel = pusherClient.subscribe(channelNames.broadcast);
    broadcastChannel.bind('price.ask.new', handleRFQ);
    broadcastChannel.bind('order.matched', handleOrderMatched);
    broadcastChannel.bind('pusher:subscription_succeeded', () => {
      log.info('WS', `Subscribed to broadcast: ${channelNames.broadcast}`);
    });
    broadcastChannel.bind('pusher:subscription_error', (err) => {
      log.error('WS', `Broadcast subscription error: ${JSON.stringify(err)}`);
    });
  }

  // Private channel — confirmations, settlements
  if (channelNames.private) {
    privateChannel = pusherClient.subscribe(channelNames.private);
    privateChannel.bind('price.confirm.new', handleConfirm);
    privateChannel.bind('order.finalized', handleOrderFinalized);
    privateChannel.bind('order.settled', handleLegSettled);
    privateChannel.bind('parlay.settled', handleParlaySettled);
    privateChannel.bind('parlay.processing', (data) => {
      log.info('WS', 'Parlay processing', data);
    });
    privateChannel.bind('parlay.finalized', (data) => {
      log.info('WS', 'Parlay finalized', data);
    });
    privateChannel.bind('refund.processed', (data) => {
      log.info('WS', 'Refund processed', data);
    });
    privateChannel.bind('pusher:subscription_succeeded', () => {
      log.info('WS', `Subscribed to private: ${channelNames.private}`);
    });
    privateChannel.bind('pusher:subscription_error', (err) => {
      log.error('WS', `Private subscription error: ${JSON.stringify(err)}`);
    });
  }

  // Bind health check on all channels
  if (broadcastChannel) {
    broadcastChannel.bind('health_check', handleHealthCheck);
  }
  if (privateChannel) {
    privateChannel.bind('health_check', handleHealthCheck);
  }
}

// ---------------------------------------------------------------------------
// EVENT HANDLERS
// ---------------------------------------------------------------------------

/**
 * Handle incoming RFQ (price.ask.new).
 */
// Fast parlay-ID dedup — Pusher sometimes delivers the same price.ask.new
// event twice within milliseconds. Without this guard we process, price,
// and submit two identical offers for every RFQ, wasting latency and
// potentially confusing PX's matching engine.
const recentRfqIds = new Map(); // parlayId → timestamp
const RFQ_DEDUP_MS = 2000;     // ignore same parlayId within 2 seconds

async function handleRFQ(data) {
  // Use performance.now() instead of Date.now() for sub-millisecond
  // precision. At our current sub-2ms latency, Date.now()'s integer
  // resolution rounds actual 0.55ms and 0.95ms both to "1ms", hiding
  // real performance differences. performance.now() returns a
  // floating-point DOMHighResTimeStamp with ~microsecond precision.
  // Both startTime and recentRfqIds entries use the same clock source,
  // so dedup comparisons stay consistent.
  const startTime = performance.now();
  // Per-stage cumulative-elapsed markers (ms since RFQ receipt, as float
  // with 2 decimal places). Populated progressively as the handler walks
  // through each stage, then attached to the responseTime record so
  // /latency-breakdown can compute deltas.
  const stageTimings = {};
  // Round a float ms value to 2 decimals for JSON-clean storage.
  const elapsedMs = () => Math.round((performance.now() - startTime) * 100) / 100;

  rfqStages.received++;

  const isPausedNow = paused;
  if (isPausedNow) rfqStages.paused++;

  try {
    // RFQ data is nested under data.payload
    const payload = data.payload || data;
    const parlayId = payload.parlay_id || payload.parlayId;
    const legs = payload.market_lines || payload.legs || [];
    const callbackUrl = payload.callback_url || payload.callbackUrl;
    // creator_id is the ONLY counterparty identifier PX exposes, and only on
    // RFQ events — matched/settled strip it (per Alec @ PX, 2026-04-20). Capture
    // here so it can flow through recordQuote → parlay_orders.meta.creatorId,
    // enabling per-counterparty P&L / sharp-detection analytics. REST
    // /parlay/sp/orders also returns it, so historical rows can be backfilled
    // via scripts/_backfill_creator_ids.js.
    const creatorId = payload.creator_id || payload.creatorId || null;

    // QUOTE-FISHER CLASSIFICATION. Recorded on EVERY inbound RFQ, before any
    // decline/dedup logic, so the rate reflects what was actually asked of us
    // rather than what we chose to quote. The verdict is stamped onto the
    // quote (meta.fisher) so fill-rate and elasticity analysis can exclude
    // spam WITHOUT conditioning on the outcome — an ex-post "creators with
    // zero fills" filter is endogenous and silently invalidated a pricing
    // study on 2026-08-03 (79.7% of the sample was four zero-fill creators,
    // concentrated in the expensive price bands).
    let fisherInfo = null;
    try {
      const legSig = Array.isArray(legs) && legs.length
        ? legs.map(l => String(l.line_id || l.lineId || '')).sort().join('|')
        : null;
      // NOTE: wall-clock, NOT startTime — that is a performance.now() reading
      // (see line ~799) and the activity window is Date.now()-based.
      fisherInfo = require('./creator-activity').recordRfq(creatorId, legSig, Date.now());
    } catch (err) {
      log.debug('RFQ', `fisher classification failed (non-fatal): ${err.message}`);
    }

    // Fast dedup: skip if we already saw this exact parlayId in the last 2s.
    // Pusher delivers duplicate events ~2-30ms apart; processing both doubles
    // our latency footprint and submits redundant offers to PX.
    const lastSeen = recentRfqIds.get(parlayId);
    if (lastSeen && startTime - lastSeen < RFQ_DEDUP_MS) {
      log.debug('RFQ', `Duplicate delivery skipped: parlay=${parlayId} (${startTime - lastSeen}ms after first)`);
      return;
    }
    recentRfqIds.set(parlayId, startTime);
    // Opportunistic cleanup — keep map from growing unbounded
    if (recentRfqIds.size > 5000) {
      for (const [id, ts] of recentRfqIds) {
        if (startTime - ts > RFQ_DEDUP_MS) recentRfqIds.delete(id);
        if (recentRfqIds.size <= 2500) break;
      }
    }

    // Record raw receipt IMMEDIATELY so we can positively confirm this RFQ
    // was broadcast to us, regardless of whether we decline/error/quote.
    recordRfqReceipt(parlayId, legs.length, isPausedNow);

    // Creator-ID blocklist check. The operator can block specific counterparties
    // identified as sharps (consistent +bettor-ROI across N≥20 fills). Decline
    // BEFORE pricing so we don't waste latency on quotes we wouldn't accept.
    // PX-side optics are identical to any other decline reason — they can't
    // tell us-declining-on-creator apart from us-declining-on-correlation.
    if (creatorId) {
      const blocklist = require('./creator-blocklist');
      if (blocklist.isBlocked(creatorId)) {
        const entry = blocklist.getEntry(creatorId);
        const reason = entry && entry.reason ? entry.reason : '<no reason>';
        log.info('RFQ', `Declining: blocked creator ${creatorId} (reason: ${reason}) — parlay=${parlayId}`);
        orderTracker.recordDecline('blocked creator', {
          parlayId,
          knownLegs: [],
          declineDetail: 'creator_id ' + creatorId + (entry && entry.reason ? ' — ' + entry.reason : ''),
        });
        rfqStages.declined++;
        updateRfqOutcome(parlayId, 'blocked_creator', creatorId);
        return;
      }
    }

    // Per-creator leg stacking gate. Caps how many currently-open parlays
    // a single creator can have sharing any one leg. Defends against the
    // "rotate the second leg, keep the anchor constant" pattern where
    // one bettor accumulates concentrated exposure on a single outcome
    // (e.g. 5 Knicks-ML parlays each with a different prop). Runs only
    // when creator_id is known — skips legacy/anonymous RFQs.
    const stackLimit = config.pricing.maxParlaysPerCreatorLeg;
    if (creatorId && stackLimit > 0 && Array.isArray(legs) && legs.length > 0) {
      for (const leg of legs) {
        const lid = leg.lineId || leg.line_id;
        if (!lid) continue;
        const sel = leg.selection || '';
        const legKey = lid + ':' + sel;
        const openCount = orderTracker.getCreatorLegStackCount(creatorId, legKey);
        if (openCount >= stackLimit) {
          const legLabel = (leg.team || leg.market || lid) + (sel ? ' (' + sel + ')' : '');
          log.info('RFQ', `Declining: creator ${creatorId.slice(0, 8)} already has ${openCount} open parlays sharing leg ${legLabel} (max ${stackLimit}) — parlay=${parlayId}`);
          orderTracker.recordDecline('creator leg stacking', {
            parlayId,
            knownLegs: [],
            declineDetail: 'creator ' + creatorId.slice(0, 8) + ' has ' + openCount + ' open parlays sharing ' + legLabel + ' (max ' + stackLimit + ')',
          });
          rfqStages.declined++;
          updateRfqOutcome(parlayId, 'creator_leg_stack', creatorId);
          return;
        }
      }
    }

    // Downgraded to debug — high-volume log that can backpressure stdout
    // under load. "Offered" log below preserves the audit trail for successful
    // submissions; paused/declined outcomes are already tracked separately.
    log.debug('RFQ', `${isPausedNow ? '[PAUSED] ' : ''}Received: parlay=${parlayId}, legs=${legs.length}`);

    // Attempt on-demand resolution of any unknown lines where the event IS known
    // (e.g., alt spreads/totals not pre-registered at startup).
    //
    // Two modes:
    //   - inline (default, config.pricing.resolveInlineOnRfq=true):
    //     AWAIT the resolution promises so we can quote this RFQ once the
    //     line is resolved. Costs ~50-150ms per slow resolve.
    //   - fast (resolveInlineOnRfq=false): kick off resolution
    //     async (fire-and-forget) and continue immediately. This RFQ
    //     will likely decline as unknown_legs, but the cache gets
    //     warmed for the next RFQ on the same line. Trade ~5% miss
    //     rate (first hit on each new line) for ~95ms p95 latency win.
    const lineManagerEarly = require('./line-manager');
    const unknownAtStart = legs.filter(l => {
      const lid = l.line_id || l.lineId || l;
      return !lineManagerEarly.lookupLine(lid);
    });
    if (unknownAtStart.length > 0) {
      if (config.pricing.resolveInlineOnRfq === false) {
        // Fast mode — kick off async, don't await.
        for (const leg of unknownAtStart) {
          // Promise rejection handler to prevent unhandled-rejection
          // log spam; the resolver already records per-lineId failures
          // via _recordResolveFailure so we don't need the return value.
          lineManagerEarly.resolveUnknownLine(leg).catch(err => {
            log.debug('Resolve', `async resolve failed: ${err.message}`);
          });
        }
        // No log line — this fires on every RFQ with unknown legs
        // (high volume), so muting it keeps stdout clean.
      } else {
        // Inline mode — await resolution so we can quote THIS RFQ once the line
        // registers. BUT skip the await for legs we've recently FAILED to
        // resolve (cached per-lineId in _failuresByLineId, 10k cap). Those are
        // overwhelmingly the unregistered player-prop flood: the event (game) is
        // known, so resolveUnknownLine takes the SLOW path (fetch markets, line
        // not found, fail) — 50-150ms each. Awaiting a known-failing line buys
        // nothing (it declines regardless) and the piled-up latency makes us
        // lose tied-odds tiebreaker races (operator incident 2026-06-07: prop
        // flood collapsed win rate 62%->~5%). Fire-and-forget the known
        // failures (refresh the cache in case they become resolvable) and only
        // AWAIT fresh/unseen lines — the real alt/game lines we can quote. This
        // is the TARGETED replacement for the global RESOLVE_INLINE_ON_RFQ=false
        // fast-mode, which skipped ALL awaits and killed quoting on a cold cache.
        const getFail = lineManagerEarly.getResolveFailure;
        const toAwait = [];
        for (const leg of unknownAtStart) {
          const lid = leg.line_id || leg.lineId || leg;
          if (getFail && getFail(lid)) {
            lineManagerEarly.resolveUnknownLine(leg).catch(err => log.debug('Resolve', `async resolve failed: ${err.message}`));
          } else {
            toAwait.push(leg);
          }
        }
        if (toAwait.length > 0) {
          // Cap total wall-clock spent awaiting resolveUnknownLine. The
          // decode stage was hitting 29-30s because pxFetch's 401-retry
          // chain (refreshSession + login + retry = 3×10s timeouts) could
          // compound before the AbortController fired on any one call. A
          // wall-clock cap on the entire resolve batch ensures we move on
          // (and decline as unknown_line) rather than burning 30s of a
          // 3-5s RFQ window. RESOLVE_INLINE_TIMEOUT_MS default = 2000.
          const resolveTimeoutMs = config.pricing.resolveInlineTimeoutMs;
          const resolveWithCap = (leg) => {
            return new Promise((resolve) => {
              const t = setTimeout(() => resolve(null), resolveTimeoutMs);
              lineManagerEarly.resolveUnknownLine(leg)
                .then(r => { clearTimeout(t); resolve(r); })
                .catch(() => { clearTimeout(t); resolve(null); });
            });
          };
          const resolved = await Promise.all(toAwait.map(resolveWithCap));
          const resolvedCount = resolved.filter(Boolean).length;
          if (resolvedCount > 0) {
            log.info('RFQ', `On-demand resolved ${resolvedCount}/${toAwait.length} unknown lines for parlay=${parlayId}`);
          }
        }
      }
    }
    stageTimings.resolve = elapsedMs();

    // Quick decline check. parlayId is an optional observability hook
    // (used by SGP shadow logging) — pricing logic doesn't depend on it.
    const declineCheck = pricer.shouldDecline(legs, parlayId);
    stageTimings.decline = elapsedMs();
    if (declineCheck && declineCheck.declined) {
      const lineManager = require('./line-manager');
      const knownLegs = [];
      const unknownLegs = [];
      const unknownSports = [];
      const unknownCategories = []; // granular categorization for each unknown leg
      for (const l of legs) {
        const lineId = l.line_id || l.lineId || l;
        const info = lineManager.lookupLine(lineId);
        if (info) {
          const mt = info.marketType || '';
          const isTotalLike = mt === 'total' || mt === 'team_total' || /total/.test(mt);
          const teamWithCtx = isTotalLike && info.homeTeam && info.awayTeam
            ? `${info.teamName} (${info.awayTeam} @ ${info.homeTeam})`
            : info.teamName;
          knownLegs.push({
            team: teamWithCtx,
            market: info.marketType,
            sport: info.sport,
            line: info.line,
            homeTeam: info.homeTeam,
            awayTeam: info.awayTeam,
            startTime: info.startTime || null,
          });
        } else {
          unknownLegs.push(lineId);
          // Build specific description with market detail
          const eventName = l.sport_event_id ? lineManager.getEventName(l.sport_event_id) : null;
          const eventInfo = l.sport_event_id ? lineManager.getEventInfo(l.sport_event_id) : null;
          const tName = l.tournament_id ? lineManager.getTournamentName(l.tournament_id) : null;
          const baseName = eventName || tName || 'unknown';
          const isKnownEvent = !!eventName;
          const eventSport = eventInfo?.sport || eventInfo?.sportName || 'unknown';

          const hasLine = l.line != null;
          const lineNum = hasLine ? l.line : null;
          const origLine = l.origin_market_line != null ? l.origin_market_line : null;

          // --- Granular categorization ---
          // Priority order: authoritative signals from resolveUnknownLine
          // first, then line-value heuristic as a fallback. Previously the
          // heuristic was primary, which mis-tagged thousands of player
          // props as 'team_total' (NBA 15-60 line range).
          let category = 'unknown';
          let detail;

          // Check resolveUnknownLine failure FIRST — most reliable signal.
          // Use the per-lineId failure map (added 2026-05-12) instead of the
          // legacy _lastFailure singleton. The singleton was getting clobbered
          // when a parlay had multiple unknown legs all racing through
          // Promise.all(resolveUnknownLine(...)): only the last writer's
          // failure survived, so 99.9% of MLB alt-spread declines reported
          // resolveReason=null when actually each leg had its own (now
          // recoverable) failure. The lineId guard below is still needed in
          // case the cap evicted an entry — null fall-through to the heuristic
          // is correct behavior.
          const resolveFailure = lineManagerEarly.getResolveFailure
            ? lineManagerEarly.getResolveFailure(lineId)
            : lineManagerEarly.resolveUnknownLine._lastFailure;
          let resolveReason = null;
          let resolveDetail = null;
          if (resolveFailure && resolveFailure.lineId === lineId) {
            resolveReason = resolveFailure.reason;
            resolveDetail = resolveFailure.pxHome && resolveFailure.pxAway
              ? `PX: ${resolveFailure.pxHome} vs ${resolveFailure.pxAway} [${resolveFailure.sportsAvail || ''}]`
              : (resolveFailure.marketTypesFound ? `markets found: ${resolveFailure.marketTypesFound.join(',')}` : null);

            // Authoritative categorization from PX-level data
            if (resolveReason === 'unsupported_market_type') {
              // PX explicitly told us this is a sup_moneyline / prop / etc.
              // Subdivide based on market name: sub-game vs player prop vs other
              const mn = (resolveFailure.marketName || '').toLowerCase();
              if (/first half|1st half|second half|2nd half|quarter|period|inning|overtime/i.test(mn)) {
                category = 'sub_game';
                detail = `sub-game market: ${resolveFailure.marketName}`;
              } else if (/milestone|points|rebound|assist|strikeout|yards|receptions|block|steal|to record/i.test(mn)) {
                category = 'player_prop';
                detail = `player prop: ${resolveFailure.marketName}`;
              } else {
                category = 'other_unsupported';
                detail = `unsupported: ${resolveFailure.marketName || resolveFailure.marketType}`;
              }
            } else if (resolveReason === 'sub_game_market') {
              // Sub-game detected by name in the spread/total market walk
              category = 'sub_game';
              detail = `sub-game: ${resolveFailure.marketName}`;
            } else if (resolveReason === 'player_prop_market') {
              // Line-manager identified a player prop market by name even
              // though PX tagged it with a supported type (e.g. "total").
              // marketName carries the actual prop label (e.g. "LeBron
              // James Made Threes").
              category = 'player_prop';
              detail = `player prop: ${resolveFailure.marketName}`;
            } else if (resolveReason === 'unknown_event') {
              category = 'unknown_event';
              detail = `event ${resolveFailure.eventId} not in lineManager`;
            } else if (resolveReason === 'no_event_id') {
              category = 'no_event_id';
              detail = 'leg missing sport_event_id';
            } else if (resolveReason === 'no_odds_match') {
              category = 'event_match_gap';
              detail = `PX event not matched to odds feed${resolveDetail ? ': ' + resolveDetail : ''}`;
            } else if (resolveReason === 'out_of_bounds_line') {
              category = 'sub_game';
              detail = `rejected by sport-aware bounds (line ${resolveFailure.line})`;
            }
            // line_not_in_markets falls through to the heuristic below
          }

          if (category === 'unknown') {
            if (!hasLine) {
              // No line number = moneyline-style leg for a prop / 2-way exotic
              category = 'player_prop';
              detail = 'no line (prop or 2-way)';
            } else if (hasLine && origLine != null && lineNum !== origLine) {
              category = 'alt_line';
              detail = `alt line ${lineNum} (primary: ${origLine})`;
            } else if (hasLine) {
              // Fall back to line-value heuristic (less reliable — player props
              // often have NBA lines 15-60 that overlap with team totals).
              // When PX gave us line_not_in_markets (walked all markets, nothing),
              // the leg is definitely not a primary full-game market — it's
              // more likely a prop than an alt line, so tag as player_prop.
              const absLine = Math.abs(lineNum);
              const isNbaPropRange = eventSport.includes('basketball') && absLine >= 5 && absLine <= 60;
              if (resolveReason === 'line_not_in_markets' && isNbaPropRange) {
                category = 'player_prop';
                detail = `line ${lineNum} (walked ${resolveFailure?.marketTypesFound?.length || '?'} markets, no match)`;
              } else if (eventSport.includes('basketball') && absLine > 100) {
                // Real NBA game totals (e.g., 224.5) — over 100 is the only
                // line range that isn't a player prop or alt-spread.
                category = 'alt_total';
                detail = `line ${lineNum}`;
              } else if (eventSport.includes('basketball') && absLine > 60 && absLine <= 100) {
                // Possible team-half-total (e.g., 55.5) — narrow band, could
                // also be alt game total. Tag as alt_total since team_total
                // for NBA is very rarely registered as a primary anyway.
                category = 'alt_total';
                detail = `line ${lineNum}`;
              } else if (eventSport.includes('basketball')) {
                // 0.5–60 range. Real NBA team totals are 100+, real
                // alt-spreads of registered primaries already routed to
                // 'alt_line' via origLine match above. What lands here is
                // overwhelmingly player props (points, rebounds, assists,
                // threes, blocks, steals) — line values 0.5–14 (rebounds /
                // assists / made threes) and 14.5–60 (player points). Bias
                // to player_prop since prior heuristic mis-tagged thousands
                // as team_total and alt_spread.
                category = 'player_prop';
                detail = `line ${lineNum} (likely player prop)`;
              } else if (eventSport.includes('baseball') && absLine === 0.5) {
                // PX encodes binary hitter props (Total Hits/HRs/RBIs/Bases/Runs
                // Over/Under 0.5) as type='total' with line=0.5. The bulk of
                // the prior "alt_spread" tagging was actually these binary
                // props — diagnosed 2026-05-21 (87% of MLB low-line declines
                // were binary props, not real run-line spreads).
                category = 'hitter_binary_prop';
                detail = `line 0.5 (binary YES/NO hitter prop)`;
              } else if (eventSport.includes('baseball') && (absLine === 1.5 || absLine === 2.5 || absLine === 3.5)) {
                // Ambiguous at line=1.5/2.5: real alt run-line OR ladder
                // hitter prop (Total Hits 2+, Total Bases 2+, etc.). Without
                // marketName populated by resolveUnknownLine we can't tell —
                // tag as ambiguous so the next analysis distinguishes them.
                category = 'baseball_low_line_ambiguous';
                detail = `line ${lineNum} (alt run-line OR hitter ladder)`;
              } else if (eventSport.includes('baseball') && absLine >= 5 && absLine <= 15) {
                category = 'alt_total';
                detail = `line ${lineNum}`;
              } else if (eventSport.includes('baseball') && absLine < 5) {
                category = 'alt_spread';
                detail = `line ${lineNum}`;
              } else if (eventSport.includes('hockey') && absLine === 0.5) {
                // Same pattern as baseball: line=0.5 in NHL = binary player
                // prop (To Score a Goal, To Record a Point, Anytime Goalscorer).
                category = 'player_binary_prop';
                detail = `line 0.5 (binary YES/NO player prop)`;
              } else if (eventSport.includes('hockey') && absLine >= 4 && absLine <= 10) {
                category = 'alt_total';
                detail = `line ${lineNum}`;
              } else if (eventSport.includes('hockey') && absLine < 4) {
                category = 'alt_spread';
                detail = `line ${lineNum}`;
              } else if (eventSport.includes('basketball') && absLine === 0.5) {
                category = 'player_binary_prop';
                detail = `line 0.5 (binary YES/NO player prop)`;
              } else if (eventSport.includes('soccer') && absLine <= 5) {
                category = absLine <= 2 ? 'alt_spread' : 'alt_total';
                detail = `line ${lineNum}`;
              } else {
                category = 'other_line';
                detail = `line ${lineNum}`;
              }
            }
          }

          // Phase 0 player-prop sub-classifier (MLB only for now).
          // When we tagged this leg as category='player_prop' AND the
          // event sport is baseball, run the marketName through the
          // MLB prop classifier so we can quantify the pitcher-K
          // opportunity vs other prop types. Result fed into both the
          // in-memory bucket counter (recordDecline) and the human-
          // readable unknown_details string (which IS persisted to
          // Supabase, so we have an SQL-queryable trail across
          // restarts).
          let propType = null;
          const propMarketName = (resolveFailure && resolveFailure.lineId === lineId && resolveFailure.marketName) || null;
          if (category === 'player_prop' && eventSport) {
            if (eventSport.includes('baseball')) {
              propType = classifyMlbProp(propMarketName);
            } else if (eventSport.includes('basketball')) {
              propType = classifyNbaProp(propMarketName);
            } else if (eventSport.includes('hockey')) {
              propType = classifyNhlProp(propMarketName);
            } else if (eventSport.includes('soccer')) {
              propType = classifySoccerProp(propMarketName);
            } else if (eventSport.includes('americanfootball')) {
              propType = classifyFootballProp(propMarketName);
            }
          }
          const propTag = propType ? ` [propType:${propType}]` : '';

          // Phase 1 shadow pricing — pitcher strikeouts only.
          // If this leg is a pitcher_strikeouts prop AND we have the
          // pieces needed to look it up (marketName + line + event
          // info), call the prop matcher and persist what we WOULD
          // have priced. Does NOT change decline behavior — leg still
          // routes to the unknown-legs decline path. Async-fire-and-
          // forget so the decline path isn't blocked on a DB write.
          if (propType === 'pitcher_strikeouts' && propMarketName && eventInfo) {
            const playerName = extractPlayerNameFromPropMarket(propMarketName);
            if (playerName) {
              // line-manager's eventIndex stores { name, sport, sportName,
              // competitors, scheduled } — NOT homeTeam/awayTeam directly.
              // Extract home/away from competitors (mirror the pattern at
              // line-manager.js:496-501).
              let homeTeam = null;
              let awayTeam = null;
              if (eventInfo.competitors && eventInfo.competitors.length >= 2) {
                const homeComp = eventInfo.competitors.find(c => c.side === 'home') || eventInfo.competitors[0];
                const awayComp = eventInfo.competitors.find(c => c.side === 'away') || eventInfo.competitors[1];
                homeTeam = homeComp && homeComp.name;
                awayTeam = awayComp && awayComp.name;
              }
              const eventCtx = {
                homeTeam, awayTeam,
                startTime: eventInfo.scheduled || eventInfo.startTime || eventInfo.commenceTime,
              };
              const captured = {
                parlayId, lineId,
                pxEventId: l.sport_event_id || null,
                marketName: propMarketName,
                playerName, lineNum, propType,
              };

              // Async shadow-price + persist. Two-tier source strategy:
              //   1. SharpAPI cache (sync, fast)
              //   2. The Odds API fallback (async HTTP) when SharpAPI didn't
              //      produce a usable fair prob — covers BOTH:
              //        - no_event_match (game not in Hobby tier prop slate, ~38% of legs)
              //        - matched_no_devig (book only priced one side, ~62% of SharpAPI matches)
              // n=13 measured 61.5% combined fair-prob coverage with TOA only on
              // the first case; adding the second case projects to ~92%. Both run
              // fire-and-forget so the decline path is never blocked.
              const usableFairProb = (l) => l && l.fairProbOver != null && l.fairProbUnder != null;
              (async () => {
                // TOA-primary (operator preference 2026-05-18). SharpAPI
                // remains as a fallback. Same order as the seed path and the
                // on-demand resolveUnknownLine K-prop branch.
                let lookup = await oddsFeed.lookupPlayerStrikeoutPropFromTheOddsApi(
                  'baseball_mlb', eventCtx, captured.playerName, captured.lineNum,
                );
                let source = 'theoddsapi';
                if (!usableFairProb(lookup)) {
                  const sharpLookup = oddsFeed.lookupPlayerStrikeoutProp(
                    'baseball_mlb', eventCtx, captured.playerName, captured.lineNum,
                  );
                  if (sharpLookup && usableFairProb(sharpLookup)) {
                    lookup = sharpLookup;
                    source = 'sharpapi';
                  }
                }
                const entry = {
                  ...captured,
                  line: captured.lineNum,
                  source,
                  fairProbOver: lookup && lookup.fairProbOver != null ? lookup.fairProbOver : null,
                  fairProbUnder: lookup && lookup.fairProbUnder != null ? lookup.fairProbUnder : null,
                  booksWithBothSides: lookup && lookup.booksWithBothSides != null ? lookup.booksWithBothSides : null,
                  books: lookup && lookup.books ? lookup.books : null,
                  resolvedEventId: lookup && lookup.resolvedEventId ? lookup.resolvedEventId : null,
                  matchError: lookup && lookup.error ? lookup.error : null,
                  matchStages: lookup && lookup.stages ? lookup.stages : null,
                };
                await db.savePropShadowQuote(entry).catch(() => {});
                const tag = `[${source}]`;
                if (lookup && lookup.error) {
                  log.info('PropShadow', `${tag} ${captured.playerName} K ${captured.lineNum}: ${lookup.error} [stages: ${(lookup.stages || []).join('|')}]`);
                } else if (lookup && lookup.fairProbOver != null) {
                  log.info('PropShadow', `${tag} ${captured.playerName} K ${captured.lineNum}: fairOver=${lookup.fairProbOver.toFixed(4)} fairUnder=${lookup.fairProbUnder.toFixed(4)} books=${(lookup.books || []).join(',')} (${lookup.booksWithBothSides} both-sides)`);
                }
              })().catch(err => log.warn('PropShadow', `async error: ${err.message}`));
            } else {
              log.debug('PropShadow', `Could not extract player name from "${propMarketName}"`);
            }
          }

          // Phase 1 shadow pricing — NBA player points. Mirrors the
          // pitcher_strikeouts block above, swapping the lookup function
          // and sport key. SharpAPI fetches player_points rows via the
          // updated marketTypesList (basketball_nba). No TOA fallback in
          // this first iteration — coverage will be measured via the
          // /prop-performance endpoint and TOA can be added in a follow-up
          // if SharpAPI's NBA prop coverage is too thin.
          if (propType === 'points' && propMarketName && eventInfo
              && eventSport && eventSport.includes('basketball')) {
            const playerName = extractPlayerNameFromPropMarket(propMarketName);
            if (playerName) {
              let homeTeam = null;
              let awayTeam = null;
              if (eventInfo.competitors && eventInfo.competitors.length >= 2) {
                const homeComp = eventInfo.competitors.find(c => c.side === 'home') || eventInfo.competitors[0];
                const awayComp = eventInfo.competitors.find(c => c.side === 'away') || eventInfo.competitors[1];
                homeTeam = homeComp && homeComp.name;
                awayTeam = awayComp && awayComp.name;
              }
              const eventCtx = {
                homeTeam, awayTeam,
                startTime: eventInfo.scheduled || eventInfo.startTime || eventInfo.commenceTime,
              };
              const captured = {
                parlayId, lineId,
                pxEventId: l.sport_event_id || null,
                marketName: propMarketName,
                playerName, lineNum, propType,
              };
              (async () => {
                const lookup = oddsFeed.lookupPlayerPointsProp(
                  'basketball_nba', eventCtx, captured.playerName, captured.lineNum,
                );
                const entry = {
                  ...captured,
                  line: captured.lineNum,
                  source: 'sharpapi',
                  fairProbOver: lookup && lookup.fairProbOver != null ? lookup.fairProbOver : null,
                  fairProbUnder: lookup && lookup.fairProbUnder != null ? lookup.fairProbUnder : null,
                  booksWithBothSides: lookup && lookup.booksWithBothSides != null ? lookup.booksWithBothSides : null,
                  books: lookup && lookup.books ? lookup.books : null,
                  resolvedEventId: lookup && lookup.resolvedEventId ? lookup.resolvedEventId : null,
                  matchError: lookup && lookup.error ? lookup.error : null,
                  matchStages: lookup && lookup.stages ? lookup.stages : null,
                };
                await db.savePropShadowQuote(entry).catch(() => {});
                if (lookup && lookup.error) {
                  log.info('PropShadow', `[sharpapi/nba_points] ${captured.playerName} pts ${captured.lineNum}: ${lookup.error} [stages: ${(lookup.stages || []).join('|')}]`);
                } else if (lookup && lookup.fairProbOver != null) {
                  log.info('PropShadow', `[sharpapi/nba_points] ${captured.playerName} pts ${captured.lineNum}: fairOver=${lookup.fairProbOver.toFixed(4)} fairUnder=${lookup.fairProbUnder.toFixed(4)} books=${(lookup.books || []).join(',')} (${lookup.booksWithBothSides} both-sides)`);
                }
              })().catch(err => log.warn('PropShadow', `async error: ${err.message}`));
            } else {
              log.debug('PropShadow', `NBA: could not extract player name from "${propMarketName}"`);
            }
          }

          // Phase 1 shadow pricing — NBA player props via The Odds API.
          // Captures points, rebounds, assists, and threes side-by-side
          // with the SharpAPI block above. TOA's NBA prop coverage is
          // far broader (probe 2026-04-30: 100% slate coverage, 9 books
          // incl. Pinnacle on points/rebounds/assists, 8 books on
          // threes) so this is the data source we'll use for Phase-2
          // live quoting if shadow match rates hold up.
          //
          // Mapping: NBA classifier propType → TOA market key
          const NBA_PROP_TYPE_TO_TOA_MARKET = {
            points: 'player_points',
            rebounds: 'player_rebounds',
            assists: 'player_assists',
            threes_made: 'player_threes',
          };
          const toaMarketKey = NBA_PROP_TYPE_TO_TOA_MARKET[propType];
          if (toaMarketKey && propMarketName && eventInfo
              && eventSport && eventSport.includes('basketball')) {
            const playerName = extractPlayerNameFromPropMarket(propMarketName);
            if (playerName) {
              let homeTeam = null;
              let awayTeam = null;
              if (eventInfo.competitors && eventInfo.competitors.length >= 2) {
                const homeComp = eventInfo.competitors.find(c => c.side === 'home') || eventInfo.competitors[0];
                const awayComp = eventInfo.competitors.find(c => c.side === 'away') || eventInfo.competitors[1];
                homeTeam = homeComp && homeComp.name;
                awayTeam = awayComp && awayComp.name;
              }
              const eventCtx = {
                homeTeam, awayTeam,
                startTime: eventInfo.scheduled || eventInfo.startTime || eventInfo.commenceTime,
              };
              const captured = {
                parlayId, lineId,
                pxEventId: l.sport_event_id || null,
                marketName: propMarketName,
                playerName, lineNum, propType,
              };
              const tagBase = `[theoddsapi/nba_${propType}]`;
              (async () => {
                const lookup = await oddsFeed.lookupTheOddsApiPlayerProp(
                  'basketball_nba', toaMarketKey, eventCtx, captured.playerName, captured.lineNum,
                );
                const entry = {
                  ...captured,
                  line: captured.lineNum,
                  source: 'theoddsapi',
                  fairProbOver: lookup && lookup.fairProbOver != null ? lookup.fairProbOver : null,
                  fairProbUnder: lookup && lookup.fairProbUnder != null ? lookup.fairProbUnder : null,
                  booksWithBothSides: lookup && lookup.booksWithBothSides != null ? lookup.booksWithBothSides : null,
                  books: lookup && lookup.books ? lookup.books : null,
                  resolvedEventId: lookup && lookup.resolvedEventId ? lookup.resolvedEventId : null,
                  matchError: lookup && lookup.error ? lookup.error : null,
                  matchStages: lookup && lookup.stages ? lookup.stages : null,
                };
                await db.savePropShadowQuote(entry).catch(() => {});
                if (lookup && lookup.error) {
                  log.info('PropShadow', `${tagBase} ${captured.playerName} ${propType} ${captured.lineNum}: ${lookup.error} [stages: ${(lookup.stages || []).join('|')}]`);
                } else if (lookup && lookup.fairProbOver != null) {
                  log.info('PropShadow', `${tagBase} ${captured.playerName} ${propType} ${captured.lineNum}: fairOver=${lookup.fairProbOver.toFixed(4)} fairUnder=${lookup.fairProbUnder.toFixed(4)} books=${(lookup.books || []).join(',')} (${lookup.booksWithBothSides} both-sides)`);
                }
              })().catch(err => log.warn('PropShadow', `async error: ${err.message}`));
            }
          }

          const tag = isKnownEvent ? '[unregistered market]' : '[unsupported event]';
          unknownSports.push(`${baseName} ${tag}${propTag} ${detail}`);
          // Extract player name eagerly for any leg the resolver tagged as a
          // player_prop AND whose marketName we captured. Used by the
          // dashboard to label otherwise-"Unknown" leg rows with something
          // recognizable ("Wendell Carter Jr." instead of "Unknown").
          const playerName = (category === 'player_prop' && propMarketName)
            ? extractPlayerNameFromPropMarket(propMarketName)
            : null;
          unknownCategories.push({
            lineId,
            category,
            propType, // null for non-MLB-prop legs
            playerName, // null if classifier doesn't recognize the stat phrase
            sport: eventSport,
            eventName: baseName,
            line: lineNum,
            origLine,
            isKnownEvent,
            resolveReason,
            resolveDetail,
            // pxEventId: surfaces the raw PX event id for unknown_event
            // declines so the operator can look it up against PX's API and
            // identify the missing sport / event class (futures, MiLB,
            // smaller soccer leagues, etc.). Pulled from resolveFailure
            // when present — falls back to the leg's own sport_event_id
            // if the resolver never recorded a failure (defensive).
            // NOTE: loop variable is `l`, not `leg` — using the wrong
            // identifier here threw ReferenceError on every unknown-leg
            // RFQ post-deploy 2026-05-14, knocking the bot into a restart
            // loop. Fixed same day.
            pxEventId: (resolveFailure && resolveFailure.eventId) || l.sport_event_id || null,
            // Surface the human-readable PX market name (e.g. "LeBron
            // James Made Threes", "1st Quarter Spread") when the resolver
            // captured one, so the dashboard can show *exactly* what
            // unregistered market this leg belongs to.
            //
            // marketName captured via gated resolveFailure read (line 778):
            // we use the per-lineId failure map, then assert
            // resolveFailure.lineId === lineId so propMarketName never
            // carries cross-attributed labels (observed 2026-04-25 with
            // the legacy singleton — baseball_mlb alt_spread legs were
            // showing NBA prop marketNames like "Nikola Jokić Total
            // Points" in /decline-audit).
            marketName: propMarketName,
          });
        }
      }
      // Use the specific reason from shouldDecline (correlation, started, limit, etc.)
      // Fall back to 'unknown legs' if we have unknowns but shouldDecline didn't say so
      const reason = unknownLegs.length > 0 ? 'unknown legs' : (declineCheck.reason || 'exposure/limit');
      orderTracker.recordDecline(reason, {
        parlayId,
        legs,
        knownLegs,
        unknownLegs,
        unknownSports,
        unknownCategories,
        declineDetail: declineCheck.detail || null,
        violations: declineCheck.violations || null,
        estPayout: declineCheck.estPayout || null,
      });
      rfqStages.declined++;
      recordDeclineReason(reason, declineCheck.detail || null, knownLegs);
      updateRfqOutcome(parlayId, 'declined', reason);
      return;
    }

    // Price the parlay — pass already-resolved lineInfos from shouldDecline
    // so Phase 1 can skip redundant lookupLine() calls per leg.
    // Capture call-side timestamps so we can compute the await microtask
    // overhead: difference between (priceReturnMs - priceCallMs) and
    // the pricer's internal totalInternalMs is V8's awaitOverhead.
    // priceParlay is intentionally NOT async — it returns the result
    // synchronously when no async work is needed (cache-warm path), and
    // returns a Promise only when alt-line fetch or Pinnacle verify
    // requires it. Branching on `.then` avoids the V8 microtask cost of
    // awaiting on the sync path (~0.32ms p50 saved measured Apr 26).
    const priceCallMs = performance.now();
    const resultMaybe = pricer.priceParlay(legs, {
      resolvedLineInfos: declineCheck.resolvedLineInfos,
      sgpCombo: declineCheck.sgpCombo || null,
      parlayId,
    });
    const result = (resultMaybe && typeof resultMaybe.then === 'function')
      ? await resultMaybe
      : resultMaybe;
    const priceReturnMs = performance.now();
    stageTimings.price = elapsedMs();
    // Carry forward pricer's internal phase markers so /latency-breakdown
    // can decompose the "price" stage into phase1 (sync validation),
    // phase2 (parallel fair-prob + Pinnacle verify), phase3 (post-process
    // + American-odds compute). Only present on happy-path returns.
    if (result && result.meta && result.meta._timings) {
      const t = result.meta._timings;
      stageTimings.price_phase1Ms = t.phase1Ms;
      stageTimings.price_phase2Ms = t.phase2Ms;
      stageTimings.price_phase3Ms = t.phase3Ms;
      // Diagnostic markers added Apr 26 to find the ~0.31ms gap between
      // sum-of-phases and total price duration. entryToPhase1 = pre-phase
      // setup (team_total check + opts unpacking). awaitOverhead = V8
      // microtask cost of `await pricer.priceParlay(...)` (the difference
      // between websocket-measured outside duration and pricer-measured
      // internal duration).
      stageTimings.price_entryToPhase1Ms = t.entryToPhase1Ms;
      const outsideDur = priceReturnMs - priceCallMs;
      const insideDur = t.totalInternalMs;
      stageTimings.price_awaitOverheadMs = Math.round(Math.max(0, outsideDur - insideDur) * 100) / 100;
      stageTimings.price_outsideDurationMs = Math.round(outsideDur * 100) / 100;
      // 2026-05-13 instrumentation: phase2-await breakdown so we can see
      // how much of phase2 time is the actual async wait vs. how many legs
      // contributed. async = getFairProbAsync (TOA alt-line fetch); verify =
      // verifyLineWithPinnacle (Odds API events fetch).
      const p2 = pricer.priceParlay._lastPhase2Diag;
      if (p2) {
        stageTimings.price_p2_awaitMs = p2.awaitMs;
        stageTimings.price_p2_asyncFairCount = p2.asyncFairCount;
        stageTimings.price_p2_verifyCount = p2.verifyCount;
      }
    }
    if (!result) {
      // Near miss — all legs known but couldn't price. Get the specific blocker.
      const failure = pricer.getLastPriceFailure() || { reason: 'no fair value', detail: null, blockerLeg: null };
      const lineManager = require('./line-manager');
      const knownLegs = legs.map(l => {
        const info = lineManager.lookupLine(l.line_id || l.lineId || l);
        if (!info) return null;
        // For totals (incl. F5 / H1 variants), include game context so
        // the dashboard doesn't show a bare "Under 4.5" without knowing
        // which game it refers to.
        let team = info.teamName;
        const mt = info.marketType || '';
        const isTotalLike = mt === 'total' || mt === 'team_total'
          || /total/.test(mt); // catches first_5_innings_total, totals_h1
        if (isTotalLike && info.homeTeam && info.awayTeam) {
          team = `${team} (${info.awayTeam} @ ${info.homeTeam})`;
        }
        // Flag the specific leg that blocked pricing
        const blocker = failure.blockerLeg;
        const isBlocker = blocker != null
          && blocker.team === info.teamName
          && blocker.market === info.marketType
          && blocker.line === info.line;
        return {
          team, market: info.marketType, sport: info.sport, line: info.line,
          homeTeam: info.homeTeam, awayTeam: info.awayTeam,
          startTime: info.startTime || null,
          pxEventName: info.pxEventName || null,
          isBlocker,
        };
      }).filter(Boolean);
      // Use the specific failure reason (may be more precise than 'no fair value')
      const declineReason = failure.reason === 'no fair value' ? 'no fair value' : failure.reason;
      orderTracker.recordDecline(declineReason, {
        parlayId,
        knownLegs,
        declineDetail: failure.detail,
      });
      rfqStages.priceFailed++;
      recordPriceFailure(declineReason, failure.detail, knownLegs);
      updateRfqOutcome(parlayId, 'price_failed', declineReason);
      return;
    }

    // Record the quote. Stash creator_id (PX's only counterparty
    // identifier — see comment near `const creatorId` above) into the
    // meta object so it gets persisted on the parlay_orders row.
    if (creatorId) result.meta.creatorId = creatorId;
    // Stamp the quote-time fisher verdict so downstream fill-rate / elasticity
    // work can exclude spam without conditioning on the outcome. Recorded even
    // when false, so "absent" is distinguishable from "not a fisher".
    if (fisherInfo) {
      result.meta.fisher = !!fisherInfo.fisher;
      result.meta.fisherReason = fisherInfo.reason || null;
      result.meta.creatorRfqPerHour = fisherInfo.rfqPerHour;
      result.meta.creatorRefires = fisherInfo.refires;
    }
    orderTracker.recordQuote(
      parlayId,
      result.meta.legs,
      result.meta.americanOdds, // Store American odds (matches PX format)
      result.meta.maxRisk,
      result.meta.fairParlayProb,
      result.meta
    );

    // Mirror the priced quote into the in-memory /recent-quotes ring buffer
    // (works while paused). Outcome mirrors the submit decision just below so
    // the operator can tell would-offer (paused_skip) from actually-sent.
    recordRecentQuote(
      parlayId,
      result.meta,
      (isPausedNow || paused) ? 'paused_skip' : (callbackUrl ? 'submitted' : 'no_callback')
    );

    // Submit offer to PX FIRST — speed is critical in the RFQ auction.
    // Bookkeeping (pending exposure, signature) happens AFTER the HTTP call
    // so it doesn't add latency before our offer reaches PX.
    //
    // Pause check uses BOTH the snapshot (isPausedNow at RFQ receipt) and
    // the live `paused` flag. Either being true blocks the submit. The
    // snapshot keeps log/metrics consistent for one RFQ ("Received [PAUSED]"
    // and the submit decision agree); the live check closes the tiny race
    // window where Mike clicks pause AFTER receipt but BEFORE submit (the
    // few ms of pricing). When paused becomes true mid-RFQ, no offer ships.
    if (isPausedNow || paused) {
      log.debug('RFQ', `[PAUSED] Would offer: parlay=${parlayId}, odds=${result.meta.americanOdds}, fair=${result.meta.fairParlayProb.toFixed(5)}`);
      updateRfqOutcome(parlayId, 'paused_skip', `would offer ${result.meta.americanOdds}`);
    } else if (callbackUrl) {
      // Fire-and-forget submit. PX sees our offer the moment the bytes
      // hit the wire — awaiting the HTTP response would add ~25ms of
      // round-trip to every RFQ's handler without changing the time
      // PX actually receives the offer. By not awaiting we:
      //   (a) let bookkeeping (pending-reservation, signature dedup)
      //       run in parallel with PX's response, so concurrent RFQs
      //       on the same game see our reservation 20-30ms sooner;
      //   (b) measure latency as dispatch time (what matters for
      //       winning the RFQ auction), not as ACK round-trip.
      // Errors surface asynchronously in the .catch handler below.
      const submitPromise = px.submitOffer(callbackUrl, parlayId, [result.offer]);
      const elapsed = elapsedMs();
      stageTimings.submit = elapsed;
      rfqStages.submitted++;
      _offersSinceConfirmEvent++; // confirm-stall watchdog: offers since last confirm event
      // Defer all post-submit bookkeeping to setImmediate. These calls
      // don't affect the offer itself or subsequent RFQ eligibility; they
      // only feed analytics/logging/db. Running them inline was stealing
      // ~0.3-0.5ms of event-loop time from the next RFQ under burst load.
      // setImmediate fires after the current tick, letting the next Pusher
      // event queue first.
      setImmediate(() => {
        recordResponseTime(parlayId, elapsed, result.meta.americanOdds, stageTimings);
        orderTracker.updateOrderLatency(parlayId, elapsed, stageTimings);
        updateRfqOutcome(parlayId, 'submitted', `odds ${result.meta.americanOdds}`);
        const f = (v) => (v == null ? '0' : Number(v).toFixed(2));
        log.info('RFQ', `Offered: parlay=${parlayId}, odds=${result.meta.americanOdds}, fair=${result.meta.fairParlayProb.toFixed(5)}, vig=${result.meta.vig}, ${f(elapsed)}ms dispatch (resolve=${f(stageTimings.resolve)} decline=${f(stageTimings.decline)} price=${f(stageTimings.price)})`);
      });
      submitPromise.catch(err => {
        rfqStages.submitError++;
        updateRfqOutcome(parlayId, 'submit_error', err.message);
        offerErrors.unshift({ error: err.message, time: new Date().toISOString(), parlayId, stack: err.stack?.split('\n')[1]?.trim() });
        if (offerErrors.length > 50) offerErrors.pop();
        // Per-combo PX rejection counter (SGP roadmap invariant 7). New
        // correlated combos collapse fair probs ABOVE the naive product —
        // the exact shape PX has rejected on team lines with "invalid
        // estimated prices". A silent rejection pattern would look like
        // zero demand while making validation gates unreachable; count it
        // per combo so /sgp-experiments surfaces it from quote one.
        const combo = result && result.meta && result.meta.sgpCombo;
        if (combo) {
          _pxSubmitErrorsByCombo[combo] = (_pxSubmitErrorsByCombo[combo] || 0) + 1;
          if (/invalid.+price|estimated/i.test(err.message || '')) {
            log.warn('RFQ', `PX rejected ${combo} offer (possible price-model rejection): ${err.message}`);
          }
        }
      });
    } else {
      rfqStages.noCallback++;
      updateRfqOutcome(parlayId, 'no_callback');
      log.warn('RFQ', `No callback URL for parlay ${parlayId}`);
    }

    // Bookkeeping AFTER submission — reserve pending exposure so concurrent
    // RFQs on the same teams see this risk in shouldDecline. Also record
    // leg signature for the 5s dedup window.
    const worstCaseRisk = config.pricing.maxRiskPerParlay || 500;
    const legsWithInfo = result.meta.legs.map(l => ({
      ...l,
      lineInfo: l,
      fairProb: l.fairProb,
    }));
    const reservation = orderTracker.buildPendingReservation(
      legsWithInfo, worstCaseRisk, config.pricing.offerValidSeconds
    );
    orderTracker.reservePending(parlayId, reservation);
    orderTracker.recordParlaySignature(result.meta.legs);
  } catch (err) {
    const pid = typeof parlayId !== 'undefined' ? parlayId : 'unknown';
    log.error('RFQ', `Error handling RFQ for ${pid}: ${err.message}`);
    rfqStages.submitError++;
    updateRfqOutcome(pid, 'submit_error', err.message);
    offerErrors.unshift({ error: err.message, time: new Date().toISOString(), parlayId: pid, stack: err.stack?.split('\n')[1]?.trim() });
    if (offerErrors.length > 50) offerErrors.pop();
  }
}

/**
 * Handle confirmation request (price.confirm.new).
 */
async function handleConfirm(data) {
  // Confirm-stall watchdog: a confirm event arrived → the private channel is
  // alive. Reset on the EVENT (not on a fill) so that rejecting confirms — e.g.
  // blocked creators — never looks like a stalled channel.
  _lastConfirmEventAt = Date.now();
  _offersSinceConfirmEvent = 0;
  _confirmCounts.received++;
  // Confirmation data is nested under data.payload. These are HOISTED above
  // the try (and so out of it) on purpose: the fail-closed catch at the bottom
  // needs parlayId/orderUuid/callbackUrl/stake to reject back to PX. A throw in
  // the pre-accept logic must NEVER leave the offer hanging with no response.
  const payload = (data && (data.payload || data)) || {};
  const parlayId = payload.parlay_id || payload.parlayId;
  const orderUuid = payload.order_uuid || payload.orderUuid;
  const callbackUrl = payload.callback_url || payload.callbackUrl;
  const confirmedStake = payload.stake || payload.confirmed_stake;
  try {
    const confirmedOdds = payload.odds || payload.confirmed_odds;

    log.info('Confirm', `Received: parlay=${parlayId}, order=${orderUuid}, odds=${confirmedOdds}, stake=$${confirmedStake}`);
    log.info('Confirm', `FULL PAYLOAD: ${JSON.stringify(payload)}`);

    // Pause gate. `handleAsk` stops creating new offers when paused, but PX
    // can still deliver confirms on offers already in flight (or past their
    // valid_until in sandbox). Pause MUST mean no new risk — reject every
    // confirm regardless of state, so operator-initiated pause fully stops
    // the book growing.
    if (paused) {
      log.info('Confirm', `[PAUSED] Rejecting confirm: parlay=${parlayId}, stake=$${confirmedStake}, odds=${confirmedOdds}`);
      orderTracker.recordRejection(parlayId, 'service paused');
      if (callbackUrl) {
        try {
          await px.confirmOrder(callbackUrl, orderUuid, 'reject');
        } catch (e) {
          log.warn('Confirm', `Paused-reject POST failed for ${parlayId}: ${e.message}`);
        }
      }
      return;
    }

    // Find our original quote
    const originalOrder = orderTracker.findByParlayId(parlayId);
    if (!originalOrder) {
      log.warn('Confirm', `No quote found for parlay ${parlayId} — rejecting`);
      _recordConfirmOutcome(parlayId, 'noQuote', 'no quote found', confirmedStake);
      if (callbackUrl) {
        await px.confirmOrder(callbackUrl, orderUuid, 'reject');
      }
      return;
    }

    // Blocklist check at confirm time — the LAST gate before a wager lands.
    // handleRFQ declines blocked creators before pricing, BUT a blocked
    // counterparty can still reach here two ways:
    //   (a) PX omits creator_id on the live RFQ (backfilled to meta only
    //       later) — observed 2026-06-06, two $4,940 fills with meta.creatorId
    //       still null. By confirm time PX's order feed carries creator_id, so
    //       we resolve it live (bounded REST) when meta lacks it.
    //   (b) on a COLD BOOT the in-memory blocklist cache is still empty when
    //       BOTH the RFQ and this confirm arrive — observed 2026-06-26, creator
    //       45628ef7 quoted+filled ~19s apart inside the boot window even though
    //       meta.creatorId WAS present (blocklist hydration ran fire-and-forget
    //       AFTER connect, behind slow Puppeteer pre-warms). resolveConfirmBlock
    //       self-heals this with a bounded ensureFresh() before deciding.
    // resolveConfirmBlock returns { blocked, creatorId, via } — via ∈ meta/rest.
    try {
      const blocklist = require('./creator-blocklist');
      const metaCreatorId = originalOrder.meta &&
        (originalOrder.meta.creatorId || originalOrder.meta.creator_id);
      const verdict = await blocklist.resolveConfirmBlock({
        metaCreatorId: metaCreatorId || null,
        // Bounded — must NEVER hang the confirm hot path. If PX's orders
        // endpoint is slow/unresponsive, give up fast and proceed without the
        // live creator (the RFQ-time gate covers the common case). 2026-06-10:
        // an UNBOUNDED fetch here hung EVERY confirm for ~2h when the PX orders
        // endpoint degraded — zero fills, no rejects, no errors logged.
        fetchLiveCreatorId: async () => {
          const liveOrder = await Promise.race([
            px.fetchOrderByUuid(orderUuid),
            new Promise((_, rej) => setTimeout(() => rej(new Error('creator-lookup timeout (800ms)')), 800)),
          ]);
          return liveOrder && liveOrder.creator_id;
        },
      });
      // Stamp a REST-resolved id back onto meta so later handlers don't re-query.
      if (verdict.via === 'rest' && verdict.creatorId && originalOrder.meta) {
        originalOrder.meta.creatorId = verdict.creatorId;
        log.info('Confirm', `Resolved creator ${verdict.creatorId} live for parlay=${parlayId} (PX omitted it on the RFQ)`);
      }
      if (verdict.blocked) {
        log.info('Confirm', `Rejecting: blocked creator ${verdict.creatorId} (via ${verdict.via}) — parlay=${parlayId}`);
        orderTracker.recordRejection(parlayId, 'blocked creator');
        if (callbackUrl) {
          try { await px.confirmOrder(callbackUrl, orderUuid, 'reject'); }
          catch (e) { log.warn('Confirm', `Block-reject POST failed for ${parlayId}: ${e.message}`); }
        }
        return;
      }
    } catch (_) { /* blocklist module not loaded yet — allow through */ }

    // Check stake/risk limits before accepting.
    // VERIFIED from live PX payload: PX sends stake = our SP risk = bettor's
    // to-win amount = our max payout liability.
    // Example: bettor wagered $100 at +1774, to-win $1774. PX sent stake=$1774
    // and odds=-1774 (SP side). Our risk on this parlay is $1774.
    // Our risk = confirmedStake directly, no multiplication.
    const ourRisk = confirmedStake || 0;
    const origLegs = originalOrder.legs || originalOrder.meta?.legs || [];
    const legsForCheck = origLegs.map(l => ({ ...l, lineInfo: l, team: l.team || l.teamName, fairProb: l.fairProb }));

    // Per-parlay caps, mirrored from priceParlay's candidateCaps logic so
    // the confirm path enforces exactly what the offer's max_risk promised.
    // PX has documentedly ignored offer-level max_risk before (a $2,447
    // order confirmed against max_risk=500) — this re-check is the only
    // enforcement we fully control. Smallest applicable cap wins, same as
    // the offer side: series cap, prop cap ($50), and the experimental-SGP
    // tier cap for combos under small-test rollout (SGP roadmap Stage 0).
    const parlayHasSeries = legsForCheck.some(l =>
      typeof (l.market || l.marketType) === 'string' &&
      (l.market || l.marketType).startsWith('series_')
    );
    const parlayHasPropLeg = legsForCheck.some(l =>
      /^player_/.test(String(l.market || l.marketType || ''))
    );
    const confirmCaps = [config.pricing.maxRiskPerParlay];
    if (parlayHasSeries) confirmCaps.push(config.pricing.maxSeriesRiskPerParlay || 500);
    if (parlayHasPropLeg) confirmCaps.push(config.pricing.maxRiskPerParlayWithProp || 50);
    const metaCombo = originalOrder.meta && originalOrder.meta.sgpCombo;
    // Mirrors the offer side exactly (review fix): shape identifies the
    // class (meta.nestedPairs stamped by priceParlay — immune to combo-
    // classification gaps on imported orders), membership in the
    // experimental set decides whether that class is still small-test
    // capped. Removing a class from SGP_EXPERIMENTAL_COMBOS graduates both
    // sides together.
    const _exp = config.pricing.experimentalSgpCombos;
    const isExperimentalCombo = !!_exp && (
      (metaCombo && _exp.has(metaCombo)) ||
      ((originalOrder.meta && originalOrder.meta.nestedPairs > 0) && _exp.has('prop_nested')) ||
      ((originalOrder.meta && originalOrder.meta.xteamPairs > 0) && _exp.has('prop_prop_xteam'))
    );
    if (isExperimentalCombo) confirmCaps.push(config.pricing.maxRiskSgpExperimental || 15);
    const maxRisk = Math.min(...confirmCaps.filter(c => c > 0));
    if (maxRisk > 0 && ourRisk > maxRisk) {
      const capLabel = isExperimentalCombo ? 'experimental SGP cap'
        : parlayHasPropLeg ? 'prop per-parlay cap'
        : parlayHasSeries ? 'series per-parlay cap'
        : 'per-parlay risk limit';
      log.warn('Confirm', `Rejecting: our risk $${ourRisk.toFixed(2)} exceeds ${capLabel} $${maxRisk.toFixed(0)} (stake=$${confirmedStake}, odds=${confirmedOdds})`);
      orderTracker.recordRejection(parlayId, `risk $${ourRisk.toFixed(0)} > max $${maxRisk}`);
      orderTracker.recordExposureRejection(parlayId, ourRisk, capLabel, [{ team: 'parlay-cap', wouldBe: ourRisk, limit: maxRisk }]);
      if (callbackUrl) {
        await px.confirmOrder(callbackUrl, orderUuid, 'reject');
      }
      return;
    }

    // Release this parlay's pending reservation BEFORE the exposure check
    // below so we don't double-count (real ourRisk + pending worst-case for
    // the same parlay). The remaining pending totals reflect OTHER in-flight
    // quotes, which is what we want to include in the cap.
    orderTracker.releasePending(parlayId);

    // Template + per-team cooldown gates at confirm time. Quote-time
    // template-exposure ignores pending reservations (so a bettor's retry
    // isn't blocked by their own in-flight quote), opening a race window
    // where multiple parlays can quote out before any confirm. Operator
    // caught (2026-05-13) three Seattle Storm parlays confirming within
    // 30 seconds — signature-level cooldown didn't catch them because the
    // 2nd legs rotated (Det -4, Det -4, Cle +4). Two checks here:
    //   1. checkConfirmCooldown: exact same signature confirmed within
    //      template cooldown window
    //   2. checkTeamCooldown: ANY team in this parlay was present in a
    //      recently-confirmed parlay (broader, catches the rotation)
    // First fill wins; rapid copies of either kind decline.
    try {
      const templateExposure = require('./template-exposure');
      const legsForTemplate = legsForCheck.map(l => ({
        team: l.team || l.teamName,
        market: l.market || l.marketType,
        line: l.line,
      }));
      const cooldown = templateExposure.checkConfirmCooldown(legsForTemplate, parlayId);
      if (cooldown.block) {
        log.warn('Confirm', `Rejecting: ${cooldown.reason} (parlay=${parlayId.substring(0, 8)})`);
        orderTracker.recordRejection(parlayId, cooldown.reason);
        if (callbackUrl) {
          await px.confirmOrder(callbackUrl, orderUuid, 'reject');
        }
        return;
      }
      const teamCd = templateExposure.checkTeamCooldown(legsForTemplate, parlayId, null, { source: 'confirm' });
      if (teamCd.block) {
        log.warn('Confirm', `Rejecting: ${teamCd.reason} (parlay=${parlayId.substring(0, 8)})`);
        orderTracker.recordRejection(parlayId, teamCd.reason);
        if (callbackUrl) {
          await px.confirmOrder(callbackUrl, orderUuid, 'reject');
        }
        return;
      }
      // Large-parlay team freeze — stricter than the cooldown above.
      // Set by a recent confirm with stake ≥ LARGE_PARLAY_FREEZE_SIZE.
      // Cleared via /admin/clear-team-freeze when operator OKs more exposure.
      const freeze = templateExposure.checkLargeTeamFreeze(legsForTemplate, parlayId, null, { source: 'confirm' });
      if (freeze.block) {
        log.warn('Confirm', `Rejecting: ${freeze.reason} (parlay=${parlayId.substring(0, 8)})`);
        orderTracker.recordRejection(parlayId, freeze.reason);
        if (callbackUrl) {
          await px.confirmOrder(callbackUrl, orderUuid, 'reject');
        }
        return;
      }
    } catch (err) {
      // Don't break the confirm path on template-exposure errors —
      // log and continue. Worst case: rapid-duplicate squeaks through.
      log.warn('Confirm', `template/team cooldown check errored: ${err.message}`);
    }

    // Per-team exposure re-check — CRITICAL. shouldDecline ran at price time
    // with stale exposure data; by confirm time other parlays may have pushed
    // real exposure past the cap. Without this check, 5 concurrent quotes all
    // passed shouldDecline and all 5 confirmed, blowing through the per-team
    // limit. Use ourRisk (the actual stake PX is confirming) not a guess.
    const teamCheck = orderTracker.checkExposureLimits(
      legsForCheck, ourRisk, config.pricing.maxExposurePerTeam
    );
    if (!teamCheck.allowed) {
      log.warn('Confirm', `Rejecting: ${teamCheck.reason}`);
      orderTracker.recordRejection(parlayId, teamCheck.reason);
      orderTracker.recordExposureRejection(parlayId, ourRisk, 'team exposure limit', teamCheck.violations);
      if (callbackUrl) {
        await px.confirmOrder(callbackUrl, orderUuid, 'reject');
      }
      return;
    }

    // Per-event aggregate cap. Sums SP-risk across ALL legs on one
    // pxEventId, regardless of team or market — catches two-sided
    // event stacking the per-team cap can't see. Particularly relevant
    // as alt-spread coverage expands (more breakpoints per game).
    const gameCheck = orderTracker.checkGameExposure(
      legsForCheck, ourRisk, config.pricing.maxExposurePerGame
    );
    if (!gameCheck.allowed) {
      log.warn('Confirm', `Rejecting: ${gameCheck.reason}`);
      orderTracker.recordRejection(parlayId, gameCheck.reason);
      orderTracker.recordExposureRejection(parlayId, ourRisk, 'game exposure limit', [{
        team: 'game-event', wouldBe: gameCheck.wouldBe, limit: gameCheck.limit,
      }]);
      if (callbackUrl) {
        await px.confirmOrder(callbackUrl, orderUuid, 'reject');
      }
      return;
    }

    // Script-aware prop game caps + experimental-combo tier re-check (SGP
    // roadmap Stage 0). Quote-time checks ran against worst-case risk;
    // re-check here with the ACTUAL confirmed stake — and the experiment
    // budget/auto-dark state may have moved since the quote (another fill
    // landed, a stop-loss tripped). Fail closed for experimental combos if
    // the guard itself errors.
    if (parlayHasPropLeg) {
      try {
        const sgpGuard = require('./sgp-guard');
        const gameCapCheck = sgpGuard.checkPropGameCaps(legsForCheck, ourRisk);
        if (!gameCapCheck.allowed) {
          log.warn('Confirm', `Rejecting: ${gameCapCheck.reason}`);
          orderTracker.recordRejection(parlayId, gameCapCheck.reason);
          orderTracker.recordExposureRejection(parlayId, ourRisk, 'prop game exposure limit', [{
            team: gameCapCheck.scope, wouldBe: gameCapCheck.wouldBe, limit: gameCapCheck.limit,
          }]);
          if (callbackUrl) await px.confirmOrder(callbackUrl, orderUuid, 'reject');
          return;
        }
        const expCheck = sgpGuard.checkExperiment(metaCombo, ourRisk);
        if (!expCheck.allowed) {
          log.warn('Confirm', `Rejecting: ${expCheck.reason}`);
          orderTracker.recordRejection(parlayId, expCheck.reason);
          if (callbackUrl) await px.confirmOrder(callbackUrl, orderUuid, 'reject');
          return;
        }
      } catch (err) {
        log.warn('Confirm', `sgp-guard re-check errored: ${err.message}`);
        if (isExperimentalCombo) {
          orderTracker.recordRejection(parlayId, `sgp-guard unavailable — fail closed (${err.message})`);
          if (callbackUrl) await px.confirmOrder(callbackUrl, orderUuid, 'reject');
          return;
        }
      }
    }

    // Series gross-exposure re-check. Same rationale as the team check:
    // a race between quote and confirm could push a series event over
    // the $1K cap. Uses actual ourRisk now that the stake is known.
    if (parlayHasSeries) {
      const seriesCheck = orderTracker.checkSeriesExposure(
        legsForCheck, ourRisk, config.pricing.maxSeriesGrossExposure
      );
      if (!seriesCheck.allowed) {
        log.warn('Confirm', `Rejecting: ${seriesCheck.reason}`);
        orderTracker.recordRejection(parlayId, seriesCheck.reason);
        orderTracker.recordExposureRejection(parlayId, ourRisk, 'series exposure limit', [{
          team: 'series-event', wouldBe: seriesCheck.wouldBe, limit: seriesCheck.limit,
        }]);
        if (callbackUrl) {
          await px.confirmOrder(callbackUrl, orderUuid, 'reject');
        }
        return;
      }
    }

    // Re-validate pricing
    const validation = await pricer.validateForConfirmation(parlayId, originalOrder.meta);
    if (!validation.valid) {
      log.warn('Confirm', `Rejecting: ${validation.reason}`);
      orderTracker.recordRejection(parlayId, validation.reason);
      if (callbackUrl) {
        await px.confirmOrder(callbackUrl, orderUuid, 'reject');
      }
      return;
    }

    // Build price_probability for the confirmation.
    // PX RULE 2 (Anthony 2026-06-25): for non-SGP parlays the per-leg
    // probabilities must MULTIPLY to the parlay odds. Recompute the per-leg
    // probs from the ACTUAL confirmed parlay prob (robust to any quote->confirm
    // drift) so their product is exact. confirmedOdds is SP-side (negative for
    // our +bettor offers); flip to the bettor side, whose implied prob is the
    // target the per-leg probs must reconcile to. (Sending raw l.fairProb made
    // Π(probs) fall short of the parlay odds by exactly the vig -> "Invalid
    // Probability"; ground-truth confirmed 385/385 non-SGP parlays failed.)
    const _bettorOdds = -Number(confirmedOdds);
    const _bettorDec = _bettorOdds > 0 ? (_bettorOdds / 100 + 1) : (100 / (-_bettorOdds) + 1);
    const _targetParlayProb = 1 / _bettorDec;
    const _legBase = originalOrder.meta.legs.map(l =>
      (l.bookPriceOverride != null ? l.bookPriceOverride : l.fairProb));
    const _legConfirm = pricer.distributeLegProbs(_legBase, _targetParlayProb);
    // PX RULE 3: max_risk is the requester's STAKE cap at our price, not our
    // payout cap. `maxRisk` (computed above from config) is our payout cap;
    // convert to the stake that yields that payout at the confirmed odds.
    const _maxRiskStake = (_targetParlayProb > 0 && _targetParlayProb < 1)
      ? Math.max(1, Math.round(maxRisk * _targetParlayProb / (1 - _targetParlayProb)))
      : maxRisk;
    const priceProbability = [{
      max_risk: _maxRiskStake,
      computed_odds: confirmedOdds,
      vig: config.pricing.defaultVig,
      lines: originalOrder.meta.legs.map((l, i) => ({
        line_id: l.lineId,
        probability: (_legConfirm[i] != null && _legConfirm[i] > 0)
          ? _legConfirm[i]
          : (l.legConfirmProb != null ? l.legConfirmProb
            : (l.legOfferedProb != null ? l.legOfferedProb : l.fairProb)),
      })),
    }];

    // Send the accept POST FIRST, only record confirmation if it returns
    // successfully. Previously we recorded optimistically before the POST,
    // so any HTTP error / timeout / network failure would leave a
    // phantom-confirmed order in our local state while PX had nothing.
    // Root cause of many null-UUID phantoms that accumulated before the
    // ghost reconciler could catch them.
    if (callbackUrl) {
      try {
        await px.confirmOrder(
          callbackUrl,
          orderUuid,
          'accept',
          confirmedOdds,
          confirmedStake,
          priceProbability
        );
      } catch (acceptErr) {
        // An accept-POST exception is AMBIGUOUS. Previously we'd mark
        // the order rejected here — but PX sometimes books the bet
        // despite returning an error (5xx after server-side commit,
        // timeout after PX's side processed, 400 with unclear body).
        // That assumption leaked $13,904 of hidden risk over the week
        // of 2026-04-17 to 04-24 (358 orders PX had TBD but we had
        // rejected — the accept-POST-failed drift).
        //
        // New path: mark acceptUnknown (state preserved, no exposure
        // flip), then schedule a PX REST verification. verifyAcceptUnknown
        // pulls ground truth and either imports (via importPxBookedOrder)
        // or marks rejected (via recordRejection). 3s delay gives PX time
        // to finalize if the failure came after their commit.
        log.warn('Confirm', `Accept POST errored for ${parlayId}: ${acceptErr.message} — will verify via PX REST in 3s`);
        _recordConfirmOutcome(parlayId, 'acceptUnknown', acceptErr.message, confirmedStake);
        orderTracker.markAcceptUnknown(parlayId, orderUuid, confirmedOdds, confirmedStake, acceptErr.message);
        setTimeout(() => {
          verifyAcceptUnknown(parlayId, orderUuid, confirmedOdds, confirmedStake).catch(err =>
            log.warn('AcceptVerify', `${parlayId} verify-task threw: ${err.message}`)
          );
        }, 3000);
        return;
      }
      log.info('Confirm', `Accepted: order=${orderUuid}`);
      _recordConfirmOutcome(parlayId, 'accepted', null, confirmedStake);

      // POST succeeded — now safe to record confirmation locally.
      orderTracker.recordConfirmation(parlayId, orderUuid, confirmedOdds, confirmedStake);

      // Feed the SGP guard ledgers (prop game-script risk + experimental
      // combo daily budget). Best-effort — never blocks the fill.
      try {
        const order = orderTracker.findByParlayId(parlayId);
        if (order) require('./sgp-guard').recordFill(order);
      } catch (e) { log.debug('SGP-Guard', `recordFill skipped: ${e.message}`); }

      // Send push notification to mobile app
      try {
        const push = require('./push');
        const order = orderTracker.findByParlayId(parlayId);
        if (order) push.notifyConfirmation(order);
      } catch (pushErr) {
        log.debug('Push', `Notification failed: ${pushErr.message}`);
      }
    } else {
      // No callback URL means we can't confirm back to PX at all — don't
      // record as confirmed. Treat as rejected to avoid phantom creation.
      orderTracker.recordRejection(parlayId, 'no-callback-url');
    }
  } catch (err) {
    // SILENT-DROP GUARD — fail closed. Any throw in the pre-accept logic
    // (validation, exposure checks, building priceProbability, etc.) used to
    // land here and be swallowed: NO accept, NO reject, NO record. The
    // bettor's offer hung to timeout and we had zero trace — the exact
    // "confirms arrive but never fill" symptom, undetectable after the fact.
    // (The accept-POST itself can't reach here — it has its own try that
    // routes failures to verifyAcceptUnknown — so a reject is always safe.)
    // Now: reject back to PX so the offer resolves, record it, and count it
    // in the error bucket so the conversion watchdog (and /confirm-activity)
    // surface it immediately.
    log.error('Confirm', `Handler threw for parlay=${parlayId}: ${err.message}`, err.stack || '');
    _recordConfirmOutcome(parlayId, 'error', err.message, confirmedStake);
    try {
      if (callbackUrl) await px.confirmOrder(callbackUrl, orderUuid, 'reject');
      orderTracker.recordRejection(parlayId, `confirm-handler-error: ${err.message}`);
    } catch (e2) {
      log.warn('Confirm', `error-path reject POST failed for parlay=${parlayId}: ${e2.message}`);
    }
  }
}

/**
 * Verify an accept-POST that errored ambiguously. Fetches PX's
 * current state for the order_uuid and decides based on ground truth:
 *   - PX has it finalized / tbd  → import as confirmed (addExposure fires)
 *   - PX already settled         → import + record settlement
 *   - PX has no record           → retry up to ATTEMPT_DELAYS_MS, then reject
 *   - Verify itself fails        → retry, then reject defensively
 *
 * Called 3 seconds after the accept-POST exception (see handleConfirm).
 * If PX hasn't finalized within the first attempt, retries at 15s and 60s
 * before giving up — covers the case where PX commits server-side after
 * the HTTP error returned to us. The `attempt` parameter (default 0) is
 * the index into ATTEMPT_DELAYS_MS for the next retry, NOT the current
 * attempt number — when there are no more delays we record rejection.
 *
 * Safe to call multiple times on the same parlay (importPxBookedOrder and
 * recordRejection are both idempotent on already-resolved orders).
 */
const VERIFY_ATTEMPT_DELAYS_MS = [15000, 60000]; // after the initial 3s, retry at +15s and +60s

async function verifyAcceptUnknown(parlayId, orderUuid, confirmedOdds, confirmedStake, attempt = 0) {
  if (!orderUuid) {
    log.warn('AcceptVerify', `${parlayId}: no orderUuid to verify against PX — marking rejected`);
    orderTracker.recordRejection(parlayId, 'accept-POST-failed: no orderUuid');
    return;
  }

  // Skip verify if the order has already been resolved by another path
  // (e.g. order.matched + order.finalized arrived during the wait window
  // and promoted it to confirmed). Belt-and-suspenders against retry races.
  const current = orderTracker.findByParlayId
    ? orderTracker.findByParlayId(parlayId)
    : null;
  if (current && (current.status === 'confirmed' || (current.status || '').startsWith('settled_'))) {
    log.debug('AcceptVerify', `${parlayId}: already ${current.status} via another path — skipping verify`);
    return;
  }

  const scheduleRetryOrReject = (rejectReason) => {
    const nextDelay = VERIFY_ATTEMPT_DELAYS_MS[attempt];
    if (nextDelay == null) {
      log.warn('AcceptVerify', `${parlayId}: exhausted retries → ${rejectReason}`);
      orderTracker.recordRejection(parlayId, rejectReason);
      return;
    }
    log.info('AcceptVerify', `${parlayId}: retry ${attempt + 1}/${VERIFY_ATTEMPT_DELAYS_MS.length} in ${nextDelay}ms (${rejectReason})`);
    setTimeout(() => {
      verifyAcceptUnknown(parlayId, orderUuid, confirmedOdds, confirmedStake, attempt + 1).catch(err =>
        log.warn('AcceptVerify', `${parlayId} retry-task threw: ${err.message}`)
      );
    }, nextDelay);
  };

  try {
    const pxOrder = await px.fetchOrderByUuid(orderUuid);
    if (!pxOrder) {
      // PX has no record yet — could be propagation delay. Retry before giving up.
      scheduleRetryOrReject('accept-POST-failed: PX has no record');
      return;
    }
    const pxSettleStatus = pxOrder.settlement_status;
    const pxOrderStatus = pxOrder.status;
    const pxStake = pxOrder.confirmed_stake != null ? Number(pxOrder.confirmed_stake) : confirmedStake;
    const pxOdds = pxOrder.confirmed_odds != null ? Number(pxOrder.confirmed_odds) : confirmedOdds;

    if (['won', 'lost', 'push'].includes(pxSettleStatus)) {
      // Edge case: PX settled the leg during the verify window.
      // Promote then settle so exposure lifecycle stays coherent.
      log.info('AcceptVerify', `${parlayId}: PX already ${pxSettleStatus} → importing + settling`);
      orderTracker.importPxBookedOrder(parlayId, orderUuid, pxStake, pxOdds);
      orderTracker.recordSettlement(orderUuid, pxSettleStatus, Number(pxOrder.profit || 0));
      return;
    }

    if (pxSettleStatus === 'tbd' || pxOrderStatus === 'finalized') {
      log.info('AcceptVerify', `${parlayId}: PX has it TBD/finalized → importing as confirmed`);
      orderTracker.importPxBookedOrder(parlayId, orderUuid, pxStake, pxOdds);
      return;
    }

    // 'cancelled' is definitive — PX explicitly killed the order. Don't retry.
    if (pxOrderStatus === 'cancelled' || pxSettleStatus === 'cancelled') {
      log.info('AcceptVerify', `${parlayId}: PX cancelled → rejected (no retry)`);
      orderTracker.recordRejection(parlayId, `accept-POST-failed: PX cancelled`);
      return;
    }

    // Any other PX state (e.g. 'requested', 'pending', unknown) — could be
    // mid-commit. Retry before giving up.
    scheduleRetryOrReject(`accept-POST-failed: PX state ${pxSettleStatus}/${pxOrderStatus}`);
  } catch (err) {
    // Network / PX REST hiccup. Retry on transient errors before giving up.
    log.warn('AcceptVerify', `${parlayId} verify attempt ${attempt} threw: ${err.message}`);
    scheduleRetryOrReject(`accept-POST-failed + verify-failed: ${err.message}`);
  }
}

/**
 * Handle order matched.
 *
 * Channel/delivery open question (Apr 2026): Alec from PX said "you would
 * only be able to see your own wagers and traffic through this" — implying
 * matched broadcasts may only reach the winning SP. Our codebase historically
 * treated these as market-wide broadcasts; the 98% tied-odds phenomenon in
 * the data is consistent with Alec's model (matched_odds == ourOdds because
 * the event is only fired on our own wins).
 *
 * The diagnostic log below captures enough signal to verify Alec's model:
 * each event now includes our own offeredOdds and the order status AT
 * EVENT TIME (before recordMatchedParlay mutates it). If every event shows
 * matched_odds matching our offered odds within the rounding tolerance,
 * Alec's model holds and we should never see loss events via this path.
 * Any event where odds differ or we had no prior quote is a counterexample.
 */
function handleOrderMatched(data) {
  const payload = data.payload || data;
  const parlayId = payload.parlay_id || payload.parlayId;
  const matchedOdds = payload.matched_odds;
  const matchedStake = payload.matched_stake;
  const legs = payload.market_lines || [];

  const lineManager = require('./line-manager');
  const hadQuote = orderTracker.findByParlayId(parlayId);
  // Snapshot pre-classification state so the log reflects what arrived,
  // not what recordMatchedParlay mutated our own order record to.
  const ourOddsAtEvent = hadQuote?.offeredOdds ?? null;
  const ourStatusAtEvent = hadQuote?.status ?? null;
  const oddsDeltaAbs = (ourOddsAtEvent != null && matchedOdds != null)
    ? Math.abs(Math.abs(ourOddsAtEvent) - Math.abs(matchedOdds))
    : null;

  // Pause gate. Outstanding quotes have a 60s valid_until, so PX can match
  // a quote that went out right before the operator paused. recordMatchedParlay
  // would promote quoted → confirmed regardless of pause state — adding risk
  // to the book after the operator explicitly said "no new positions."
  //
  // When paused, skip the promotion. The order stays in 'quoted' status; if
  // PX actually booked it server-side (they can and sometimes do, per the
  // accept-POST drift pattern), /px-status-repair will catch + reconcile
  // later. This gives the operator full control over what gets booked while
  // paused, with a clear audit trail via the WARN log.
  if (paused && hadQuote && hadQuote.status === 'quoted') {
    log.warn('Market', `[PAUSED] order.matched for parlay=${(parlayId||'').substring(0,8)} — skipping promotion. odds=${matchedOdds}, stake=$${matchedStake}, ourOdds=${ourOddsAtEvent}, legs=${legs.length}. If PX booked server-side, /px-status-repair will reconcile.`);
    return;
  }

  const entry = orderTracker.recordMatchedParlay(parlayId, matchedOdds, matchedStake, legs, lineManager);

  log.info('Market', `Matched: parlay=${(parlayId||'').substring(0,8)}, `
    + `odds=${matchedOdds}, ourOdds=${ourOddsAtEvent ?? 'n/a'}, `
    + `oddsDelta=${oddsDeltaAbs ?? 'n/a'}, `
    + `stake=$${matchedStake}, legs=${legs.length}, `
    + `outcome=${entry.outcome}, hadQuote=${!!hadQuote}, `
    + `ourStatusPreEvent=${ourStatusAtEvent ?? 'n/a'}, `
    + `totalOrders=${orderTracker.getStats().totalOrders}`);
}

/**
 * Handle order finalized (private — our order confirmed by PX).
 */
function handleOrderFinalized(data) {
  const payload = data.payload || data;
  const orderUuid = payload.order_uuid || payload.orderUuid;
  const parlayId = payload.parlay_id || payload.parlayId;
  log.info('WS', `Order finalized: ${orderUuid}`, payload);

  // Store the orderUuid on the order — this is the only event that has it
  if (parlayId && orderUuid) {
    orderTracker.recordFinalized(parlayId, orderUuid, payload);
  }
}

/**
 * Handle individual leg settlement.
 */
function handleLegSettled(data) {
  const payload = data.payload || data;
  const orderUuid = payload.order_uuid || payload.orderUuid;
  const status = payload.status || payload.settlement_status;
  log.info('WS', `Leg settled: order=${orderUuid}, status=${status}`, payload);

  if (orderUuid) {
    orderTracker.recordLegSettlement(orderUuid, payload);
  }
}

/**
 * Handle full parlay settlement.
 *
 * PX WebSocket parlay.settled payload is just {order_uuid, result, payout}
 * — NO leg-level settlement data. If we call recordSettlement directly
 * from this event, the order is persisted with empty leg_status fields,
 * and on the next service restart loadFromDb's revert heuristic may flip
 * it back to 'confirmed' (destroying the settlement record).
 *
 * Fix: backfill leg data from PX REST BEFORE recording the settlement.
 * We fetch the order's full details (which include per-leg settlement_status)
 * via fetchOrderByUuid, call recordLegSettlement for each leg, then call
 * recordSettlement. The legs are now populated on the stored order, so
 * future reloads see legStatuses.length > 0 and use the unambiguous
 * pattern-match branch instead of the risky "unfinished heuristic".
 *
 * If the REST fetch fails, we still call recordSettlement as a fallback
 * — better to have the settlement with a partial record than lose it.
 */
async function handleParlaySettled(data) {
  const payload = data.payload || data;
  const orderUuid = payload.order_uuid || payload.orderUuid;
  const result = payload.result || payload.status;
  const payout = payload.payout || 0;

  // PX WebSocket parlay.settled uses SP-perspective ('won' = SP won = bettor's parlay lost).
  // Evidence: 64/64 settlements inverted when flipping, all showing as SP losses despite
  // score data confirming legs failed. Removing flip — PX result is used directly.
  log.info('Settle', `Parlay settled: order=${orderUuid}, pxResult=${result}, payout=${payout}`);

  if (!orderUuid) {
    log.warn('Settle', 'parlay.settled event missing order_uuid — skipping');
    return;
  }

  // Backfill leg settlement data from PX REST before recording the parlay settlement.
  // This makes the stored order self-describing: any future reload can determine
  // the correct SP result from leg_status alone without needing start-time heuristics.
  try {
    const pxOrder = await px.fetchOrderByUuid(orderUuid);
    if (pxOrder && Array.isArray(pxOrder.legs)) {
      for (const pxLeg of pxOrder.legs) {
        if (pxLeg.line_id && pxLeg.settlement_status) {
          orderTracker.recordLegSettlement(orderUuid, pxLeg);
        }
      }
      log.info('Settle', `Backfilled ${pxOrder.legs.length} legs from PX REST for ${orderUuid}`);
    } else {
      log.debug('Settle', `Could not fetch order details from PX REST for ${orderUuid}`);
    }
  } catch (err) {
    log.warn('Settle', `Leg backfill failed for ${orderUuid}: ${err.message}`);
  }

  orderTracker.recordSettlement(orderUuid, result, payout);
}

/**
 * Handle health check heartbeat.
 */
function handleHealthCheck(data) {
  lastHealthCheck = Date.now();
  log.debug('WS', 'Health check received');
}

// ---------------------------------------------------------------------------
// HEALTH CHECK MONITOR + ZOMBIE-CONNECTION WATCHDOG
// ---------------------------------------------------------------------------
// History: prior to 2026-06-01 this only LOGGED a warning when the health
// check stopped, on the assumption that pusher-js would handle reconnection
// automatically. It doesn't always — caught 2026-06-01 03:39am ET when the
// socket entered "pong-without-data" state (control plane alive but event
// delivery dead). reconnectAttempts stayed 0 for 7.5 hours. 423 quotes →
// 0 quotes for ~7h before Mike noticed via the dashboard.
//
// Fix: this monitor now actively force-reconnects when the health-event
// stream has been silent past WS_WATCHDOG_STALE_MINUTES (default 3). Same
// disconnect+connect path the manual /reconnect endpoint uses. Push
// notification fires on auto-reconnect. Disable with WS_WATCHDOG_DISABLED=true.

const _watchdogEnabled = !/^true$/i.test(process.env.WS_WATCHDOG_DISABLED || '');
const _watchdogStaleMs = (Number(process.env.WS_WATCHDOG_STALE_MINUTES) || 3) * 60 * 1000;
let _watchdogReconnecting = false;
let _watchdogLastFireAt = 0;

// Confirm-channel stall watchdog. The PRIVATE channel can silently stop
// delivering price.confirm.new while the socket stays "healthy" (pongs keep
// arriving, lastHealthCheck stays fresh) — so the health watchdog above misses
// it and fills just stop with no error (2026-06-10 & 2026-06-11 outages, both
// recovered by a manual /reconnect). Detect: we're actively submitting offers
// but have seen ZERO confirm events in N minutes → channel dead → reconnect.
const _confirmStallMs = (Number(process.env.WS_CONFIRM_STALL_MINUTES) || 12) * 60 * 1000;
const _confirmStallMinOffers = Number(process.env.WS_CONFIRM_STALL_MIN_OFFERS) || 40;
let _lastConfirmEventAt = Date.now();
let _offersSinceConfirmEvent = 0;

// Per-sgpCombo PX submit-error counts (SGP roadmap invariant 7) — surfaced
// via getPxSubmitErrorsByCombo for /sgp-experiments.
const _pxSubmitErrorsByCombo = {};
function getPxSubmitErrorsByCombo() { return { ..._pxSubmitErrorsByCombo }; }

// Confirm-outcome telemetry. Every price.confirm.new is tallied by outcome so
// confirm→fill conversion is OBSERVABLE in real time (GET /confirm-activity)
// instead of inferred from the DB after the fact. The 'error' bucket is the
// critical one: it counts confirms that threw in the handler — the silent
// non-fill class that previously left no trace anywhere. 'received' is the
// total; rejected is derived (received - the rest) since reject reasons already
// live in /recent-rejects.
const _confirmCounts = { received: 0, accepted: 0, acceptUnknown: 0, error: 0, noQuote: 0 };
const _confirmLog = [];
const _CONFIRM_LOG_MAX = 200;
let _confirmErrorsSeen = 0; // snapshot for the conversion watchdog (Edit G)
function _recordConfirmOutcome(parlayId, outcome, reason, stake) {
  if (_confirmCounts[outcome] != null) _confirmCounts[outcome]++;
  _confirmLog.push({
    t: Date.now(),
    parlayId: parlayId ? String(parlayId).substring(0, 12) : null,
    outcome,
    reason: reason || null,
    stake: stake != null ? stake : null,
  });
  if (_confirmLog.length > _CONFIRM_LOG_MAX) _confirmLog.shift();
}
function getConfirmActivity() {
  const now = Date.now();
  const windowCounts = (mins) => {
    const cut = now - mins * 60000;
    return _confirmLog.reduce((a, e) => {
      if (e.t >= cut) a[e.outcome] = (a[e.outcome] || 0) + 1;
      return a;
    }, {});
  };
  const c = _confirmCounts;
  const derivedRejected = Math.max(0, c.received - c.accepted - c.acceptUnknown - c.error - c.noQuote);
  return {
    sinceBoot: { ...c, rejectedDerived: derivedRejected },
    last15min: windowCounts(15),
    last60min: windowCounts(60),
    lastConfirmEventAgoSec: Math.round((now - _lastConfirmEventAt) / 1000),
    recent: _confirmLog.slice(-50).reverse().map(e => ({ ...e, agoSec: Math.round((now - e.t) / 1000) })),
  };
}

async function _watchdogReconnect(reason) {
  if (_watchdogReconnecting) return;
  // Cooldown — don't fire more than once per 2 min, even if reconnect
  // fails repeatedly. Prevents reconnect storm if PX is itself down.
  if (Date.now() - _watchdogLastFireAt < 120_000) return;
  _watchdogReconnecting = true;
  _watchdogLastFireAt = Date.now();
  log.warn('WS-Watchdog', `Forcing reconnect: ${reason}`);
  // Seed lastHealthCheck so we don't immediately re-fire during the
  // handshake (the cooldown above is belt; this is suspenders).
  lastHealthCheck = Date.now();
  _lastConfirmEventAt = Date.now();  // fresh confirm-stall window post-reconnect
  _offersSinceConfirmEvent = 0;
  try {
    try { require('./push').notifyConnectionState('zombie', `Watchdog auto-reconnect: ${reason}`); } catch (_) {}
    try { px.clearCooldown && px.clearCooldown(); } catch (_) {}
    disconnect();
    await connect();
    log.info('WS-Watchdog', 'Auto-reconnect complete');
  } catch (err) {
    log.error('WS-Watchdog', `Auto-reconnect failed: ${err.message}`);
  } finally {
    _watchdogReconnecting = false;
  }
}

function startHealthCheckMonitor() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);

  const monitorStartedAt = Date.now();
  healthCheckTimer = setInterval(() => {
    if (!lastHealthCheck) {
      // NEVER-CONNECTED guard (found 2026-06-12: a boot-race left the WS
      // 'disconnected' with reconnectAttempts=0 and the book dark until a
      // manual /reconnect). The initial connect has no retry of its own,
      // and this early-return meant the watchdog could not see the failure
      // because no health event ever arrives on a socket that never opened.
      // After 3 minutes of never-connected, force the watchdog.
      if (_watchdogEnabled && connectionState !== 'connected'
          && Date.now() - monitorStartedAt > 3 * 60 * 1000) {
        _watchdogReconnect('never connected since boot (initial WS connect failed)')
          .catch(() => { /* logged inside */ });
      }
      return;
    }
    const ageMs = Date.now() - lastHealthCheck;
    if (ageMs > 60_000) {
      log.warn('WS', `No health check received in ${Math.round(ageMs / 1000)}s — connection may be stale`);
    }
    if (_watchdogEnabled && ageMs > _watchdogStaleMs) {
      _watchdogReconnect(`lastHealthCheck stale ${Math.round(ageMs / 1000)}s (threshold ${Math.round(_watchdogStaleMs / 1000)}s)`)
        .catch(() => { /* logged inside */ });
    }
    // Confirm-channel stall: socket healthy but the private channel stopped
    // delivering confirms while we keep submitting → reconnect to re-subscribe.
    // Gated on active submitting (min-offers) so a genuinely quiet period never
    // triggers a needless reconnect.
    if (_watchdogEnabled && !paused && connectionState === 'connected') {
      const confirmAgeMs = Date.now() - _lastConfirmEventAt;
      if (confirmAgeMs > _confirmStallMs && _offersSinceConfirmEvent >= _confirmStallMinOffers) {
        _watchdogReconnect(`confirm-stall: ${_offersSinceConfirmEvent} offers submitted, no confirm event in ${Math.round(confirmAgeMs / 60000)}min`)
          .catch(() => { /* logged inside */ });
      }
    }
    // Confirm-CONVERSION alarm. The stall watchdog above only sees the case
    // where confirm events STOP. It is blind to the more insidious case where
    // confirms keep ARRIVING but throw in the handler (so _lastConfirmEventAt
    // stays fresh) — confirms that never become fills. The fail-closed catch
    // now rejects + counts those in the error bucket; here we shout the moment
    // any new ones appear so a silent non-fill drought can't go unnoticed.
    if (_confirmCounts.error > _confirmErrorsSeen) {
      const delta = _confirmCounts.error - _confirmErrorsSeen;
      _confirmErrorsSeen = _confirmCounts.error;
      log.error('WS-Watchdog', `CONFIRM-CONVERSION ALARM: ${delta} confirm handler-error(s) in last 60s (total ${_confirmCounts.error}) — confirms arriving but failing to convert. See /confirm-activity.`);
      try { require('./push').notifyConnectionState('confirm-error', `${delta} confirm handler-error(s) — see /confirm-activity`); } catch (_) {}
    }
  }, 60_000);
  log.info('WS-Watchdog', _watchdogEnabled
    ? `armed — auto-reconnect when lastHealthCheck stale > ${Math.round(_watchdogStaleMs / 1000)}s`
    : 'disabled via WS_WATCHDOG_DISABLED');
}

// ---------------------------------------------------------------------------
// RECONNECT
// ---------------------------------------------------------------------------

async function handleReconnect() {
  log.info('WS', 'Reconnected — re-registering socket...');
  try {
    const socketId = pusherClient.connection.socket_id;
    const regData = await px.registerWebSocket(socketId);
    parseChannels(regData);
    // Channels should auto-resubscribe with Pusher-js
    log.info('WS', 'Re-registration complete');
  } catch (err) {
    log.error('WS', `Re-registration failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// CONTROL
// ---------------------------------------------------------------------------

function pause() {
  paused = true;
  log.info('WS', 'Paused — will not respond to RFQs');
  persistPausedState(true); // fire-and-forget
}

function resume() {
  paused = false;
  log.info('WS', 'Resumed — will respond to RFQs');
  persistPausedState(false); // fire-and-forget
}

function disconnect() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (pusherClient) {
    // Unbind handlers + disconnect + null the ref (not just disconnect) so the
    // old client can't keep emitting state_change into the shared state.
    _teardownClient();
    log.info('WS', 'Disconnected');
  }
  connectionState = 'disconnected';
}

// Response time tracking
// { parlayId, elapsed, offeredOdds, time, stages?: { resolve, decline, price, submit } }
// stages is populated by handleRFQ — per-stage elapsed ms measured from RFQ receipt.
const responseTimes = [];
const MAX_RESPONSE_TIMES = 500; // increased for meaningful percentile computation

// RFQ flow stage counters (reset each session)
const rfqStages = {
  received: 0,
  paused: 0,
  declined: 0,
  priceFailed: 0,
  noCallback: 0,
  submitted: 0,
  submitError: 0,
};

// --- Recent priced-quotes ring buffer ------------------------------------
// Captures every parlay we successfully PRICE — whether or not we then submit,
// so it populates in PAUSED/observation mode too. Feeds the read-only
// /recent-quotes endpoint, which lets the operator eyeball actual would-be
// offered odds vs fair (the markup we'd extract) BEFORE going live, without
// quoting. Pure in-memory, capped, and wrapped in try/catch so telemetry can
// never break the RFQ hot path.
const RECENT_QUOTES_MAX = 100;
const _recentQuotes = [];
function _probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  const dec = 1 / p;
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}
function recordRecentQuote(parlayId, meta, outcome) {
  try {
    if (!meta) return;
    const legs = Array.isArray(meta.legs) ? meta.legs.map(l => ({
      desc: l.team || l.marketName || l.lineId || null,
      market: l.market || null,
      line: (l.line != null ? l.line : null),
      selection: l.selection || null,
      sport: l.sport || null,
      pxEventName: l.pxEventName || null,
      fairProb: (l.fairProb != null ? l.fairProb : null),
      // True per-leg offered implied prob (payout-vig + favorite markup).
      offeredProb: (l.legOfferedProb != null ? l.legOfferedProb : (l.bookPriceOverride != null ? l.bookPriceOverride : null)),
    })) : [];
    const fairProb = (meta.fairParlayProb != null ? meta.fairParlayProb : null);
    _recentQuotes.unshift({
      time: new Date().toISOString(),
      parlayId: parlayId || null,
      outcome, // 'paused_skip' (would-offer, not sent) | 'submitted' | 'no_callback'
      sport: meta.sport || (legs[0] && legs[0].sport) || null,
      legCount: legs.length,
      offeredOdds: (meta.americanOdds != null ? meta.americanOdds : null),
      fairOdds: _probToAmerican(fairProb),
      fairParlayProb: fairProb,
      vig: (meta.vig != null ? meta.vig : null),
      maxRisk: (meta.maxRisk != null ? meta.maxRisk : null),
      isSGP: !!meta.isSGP,
      sgpCombo: meta.sgpCombo || null,
      nestedPairs: meta.nestedPairs || 0,
      xteamPairs: meta.xteamPairs || 0,
      legs,
    });
    if (_recentQuotes.length > RECENT_QUOTES_MAX) _recentQuotes.length = RECENT_QUOTES_MAX;
  } catch (_) { /* never let telemetry break the hot path */ }
}
function getRecentQuotes(limit) {
  const n = Math.min(Math.max(1, parseInt(limit, 10) || 50), RECENT_QUOTES_MAX);
  return { count: _recentQuotes.length, max: RECENT_QUOTES_MAX, quotes: _recentQuotes.slice(0, n) };
}

// Raw RFQ receipt log — track every parlayId received via WebSocket,
// regardless of whether we quoted, declined, or errored. Lets us positively
// confirm whether a specific parlay was ever broadcast to us.
// Keyed by parlayId → { receivedAt, legCount, stage, outcome }
const receivedRfqs = new Map();
const MAX_RECEIVED_RFQS = 20000;
const receivedRfqOrder = []; // FIFO for memory cap

function recordRfqReceipt(parlayId, legCount, paused) {
  if (!parlayId) return;
  receivedRfqs.set(parlayId, {
    receivedAt: new Date().toISOString(),
    legCount: legCount || 0,
    paused: !!paused,
    outcome: 'received', // updated later when we know the final outcome
  });
  receivedRfqOrder.push(parlayId);
  while (receivedRfqOrder.length > MAX_RECEIVED_RFQS) {
    const oldId = receivedRfqOrder.shift();
    receivedRfqs.delete(oldId);
  }
}

function updateRfqOutcome(parlayId, outcome, detail) {
  if (!parlayId) return;
  const entry = receivedRfqs.get(parlayId);
  if (entry) {
    entry.outcome = outcome;
    if (detail) entry.detail = detail;
  }
}

function wasRfqReceived(parlayId) {
  return receivedRfqs.get(parlayId) || null;
}

function getReceivedRfqStats() {
  const outcomes = {};
  for (const entry of receivedRfqs.values()) {
    outcomes[entry.outcome] = (outcomes[entry.outcome] || 0) + 1;
  }
  return { total: receivedRfqs.size, outcomes };
}

function recordResponseTime(parlayId, elapsed, offeredOdds, stages) {
  responseTimes.unshift({
    parlayId,
    elapsed,
    offeredOdds,
    time: new Date().toISOString(),
    stages: stages || null,
  });
  if (responseTimes.length > MAX_RESPONSE_TIMES) responseTimes.pop();
}

/**
 * Seed the in-memory responseTimes buffer from a persisted source
 * (typically order-tracker.getRecentLatencyRecords). Called once at boot
 * after orders are loaded so the Latency Monitor + win-rate-by-bucket
 * report is non-empty immediately on a fresh deploy. Records that already
 * exist in the buffer (matched by parlayId) are skipped — live in-flight
 * RFQs always win over rehydrated history.
 */
function seedResponseTimes(records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const existing = new Set(responseTimes.map(r => r.parlayId));
  let added = 0;
  for (const r of records) {
    if (!r || r.elapsed == null || existing.has(r.parlayId)) continue;
    responseTimes.push({
      parlayId: r.parlayId,
      elapsed: r.elapsed,
      offeredOdds: r.offeredOdds,
      time: r.time,
      stages: r.stages || null,
    });
    existing.add(r.parlayId);
    added++;
  }
  // Newest first, trim to the rolling cap
  responseTimes.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  if (responseTimes.length > MAX_RESPONSE_TIMES) responseTimes.length = MAX_RESPONSE_TIMES;
  return added;
}

// ---------------------------------------------------------------------------
// LATENCY BREAKDOWN — per-stage percentiles + win-rate-by-bucket
// ---------------------------------------------------------------------------

/** Compute percentiles from a sorted numeric array. */
function _percentiles(sorted) {
  if (!sorted.length) return null;
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: pick(0.5),
    p75: pick(0.75),
    p90: pick(0.90),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1],
    // Preserve 2-decimal precision on avg — with performance.now() inputs,
    // rounding to integer would hide sub-ms stage differences.
    avg: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
  };
}

/**
 * Full latency breakdown — per-stage percentiles + win-rate-by-latency bucket.
 *
 * Stages (cumulative elapsed from RFQ receipt):
 *   resolve → after resolveUnknownLine (unknown-leg on-demand resolution)
 *   decline → after shouldDecline check
 *   price   → after priceParlay returns
 *   submit  → after submitOffer POST returns (end-to-end)
 *
 * Non-cumulative "deltas" are derived: e.g. priceDelta = price - decline.
 */
function getLatencyBreakdown() {
  const withStages = responseTimes.filter(r => r.stages);
  const endToEnd = responseTimes.map(r => r.elapsed).sort((a, b) => a - b);

  // Per-stage cumulative percentiles
  const stageKeys = ['resolve', 'decline', 'price', 'submit'];
  const stageStats = {};
  for (const k of stageKeys) {
    const vals = withStages
      .map(r => (r.stages && r.stages[k] != null) ? r.stages[k] : null)
      .filter(v => v != null)
      .sort((a, b) => a - b);
    stageStats[k] = _percentiles(vals);
  }

  // Price-phase durations (non-cumulative — each value is the length of
  // that specific phase in ms). Populated by pricer's phase markers and
  // only present on successfully-offered RFQs.
  //
  // Apr 26 added: entryToPhase1 (pre-phase setup), awaitOverhead (V8
  // microtask cost), outsideDuration (full priceParlay duration measured
  // from websocket side). These help find where the price-stage time goes
  // beyond the original phase1+2+3 markers.
  const priceSubStats = {};
  const priceSubKeys = [
    'price_phase1Ms', 'price_phase2Ms', 'price_phase3Ms',
    'price_entryToPhase1Ms', 'price_awaitOverheadMs', 'price_outsideDurationMs',
  ];
  for (const k of priceSubKeys) {
    const vals = withStages
      .map(r => (r.stages && r.stages[k] != null) ? r.stages[k] : null)
      .filter(v => v != null)
      .sort((a, b) => a - b);
    priceSubStats[k] = _percentiles(vals);
  }

  // Per-stage deltas (how long each stage actually took, not cumulative)
  const deltaStats = {};
  const deltaPairs = [
    ['receive_to_resolve', null, 'resolve'],
    ['resolve_to_decline', 'resolve', 'decline'],
    ['decline_to_price', 'decline', 'price'],
    ['price_to_submit', 'price', 'submit'],
  ];
  for (const [name, prev, next] of deltaPairs) {
    const vals = withStages
      .map(r => {
        const s = r.stages;
        if (!s) return null;
        const a = prev ? s[prev] : 0;
        const b = s[next];
        if (a == null || b == null) return null;
        return b - a;
      })
      .filter(v => v != null && v >= 0)
      .sort((a, b) => a - b);
    deltaStats[name] = _percentiles(vals);
  }

  // Win-rate by latency bucket — requires joining with orderTracker matched parlays.
  // orderTracker tracks matchedParlays with `weQuoted` + `outcome` ('won' = our quote matched).
  let winRateBuckets = null;
  try {
    const orderTracker = require('./order-tracker');
    const matched = orderTracker.getMatchedParlays ? orderTracker.getMatchedParlays() : [];
    // Map parlayId -> {outcome, ...details} for joining + expansion details
    const matchedByParlay = new Map();
    for (const m of matched) {
      if (!m.parlayId) continue;
      matchedByParlay.set(m.parlayId, m);
    }
    const buckets = [
      { label: '<30ms', min: 0, max: 30 },
      { label: '30-50ms', min: 30, max: 50 },
      { label: '50-75ms', min: 50, max: 75 },
      { label: '75-100ms', min: 75, max: 100 },
      { label: '100-150ms', min: 100, max: 150 },
      { label: '150-250ms', min: 150, max: 250 },
      { label: '>250ms', min: 250, max: Infinity },
    ].map(b => ({ ...b, quoted: 0, won: 0, lost: 0, unknown: 0, parlays: [] }));
    for (const r of responseTimes) {
      const bucket = buckets.find(b => r.elapsed >= b.min && r.elapsed < b.max);
      if (!bucket) continue;
      bucket.quoted++;
      const m = matchedByParlay.get(r.parlayId);
      const outcome = m ? m.outcome : undefined;
      if (outcome === 'won') bucket.won++;
      // Count every real auction loss — outbid ('lost'/'other_sp') AND
      // same-price ('tied_lost') — so the win-rate denominator is honest and
      // tie-losses can be diagnosed by latency bucket (the whole point of this
      // view for the tie-loss question).
      else if (outcome === 'lost' || outcome === 'other_sp' || outcome === 'tied_lost') bucket.lost++;
      else bucket.unknown++;
      // Per-parlay detail for click-to-expand on the dashboard. Trim to the
      // fields the UI needs so the payload doesn't balloon.
      bucket.parlays.push({
        parlayId: r.parlayId,
        time: r.time,
        elapsed: r.elapsed,
        offeredOdds: r.offeredOdds,
        outcome: outcome || 'unknown',
        legs: m ? (m.legs || []).map(l => ({
          sport: l.sport,
          team: l.team || l.teamName || l.selection,
          market: l.market || l.marketType,
          line: l.line,
        })) : [],
        legCount: m ? m.legCount : null,
        matchedAmericanOdds: m ? m.matchedAmericanOdds : null,
        matchedStake: m ? m.matchedStake : null,
      });
    }
    winRateBuckets = buckets.map(b => ({
      ...b,
      max: b.max === Infinity ? null : b.max,
      winRate: (b.won + b.lost) > 0 ? (b.won / (b.won + b.lost) * 100).toFixed(1) + '%' : null,
    }));
  } catch (err) {
    // Best-effort — orderTracker may not expose getMatchedParlays yet
    winRateBuckets = { error: err.message };
  }

  return {
    capturedAt: new Date().toISOString(),
    sample: {
      totalResponseTimes: responseTimes.length,
      withStageData: withStages.length,
      rfqStages: { ...rfqStages },
    },
    endToEnd: _percentiles(endToEnd),
    stagesCumulative: stageStats,
    stageDeltas: deltaStats,
    pricePhases: priceSubStats,
    winRateByLatencyBucket: winRateBuckets,
  };
}

// Frozen baseline snapshot — set once via /latency-baseline/capture so we can
// compare post-optimization numbers against pre-optimization numbers.
let _baselineSnapshot = null;
function captureBaseline() {
  _baselineSnapshot = getLatencyBreakdown();
  return _baselineSnapshot;
}
function getBaseline() {
  return _baselineSnapshot;
}

const offerErrors = []; // last N offer submission failures

// ---------------------------------------------------------------------------
// PRICE FAILURE + DECLINE TRACKING — real-time reason breakdown
// ---------------------------------------------------------------------------
const priceFailureReasons = {};   // reason → count
const declineReasons = {};        // reason → count
const recentFailures = [];        // last N with detail
const MAX_RECENT_FAILURES = 200;

function recordPriceFailure(reason, detail, knownLegs) {
  priceFailureReasons[reason] = (priceFailureReasons[reason] || 0) + 1;
  recentFailures.unshift({
    type: 'price_failed',
    reason,
    detail: detail || null,
    legs: (knownLegs || []).map(l => `${l.team} ${l.market}${l.line != null ? ' ' + l.line : ''}`).join(' + ') || null,
    time: new Date().toISOString(),
  });
  if (recentFailures.length > MAX_RECENT_FAILURES) recentFailures.pop();
}

function recordDeclineReason(reason, detail, knownLegs) {
  declineReasons[reason] = (declineReasons[reason] || 0) + 1;
  recentFailures.unshift({
    type: 'declined',
    reason,
    detail: detail || null,
    legs: (knownLegs || []).map(l => `${l.team || l.teamName || '?'} ${l.market || l.marketType || '?'}`).join(' + ') || null,
    time: new Date().toISOString(),
  });
  if (recentFailures.length > MAX_RECENT_FAILURES) recentFailures.pop();
}

function getQuoteCoverageStats() {
  return {
    rfqStages: { ...rfqStages },
    priceFailureReasons: { ...priceFailureReasons },
    declineReasons: { ...declineReasons },
    submissionRate: rfqStages.received > 0
      ? `${((rfqStages.submitted / rfqStages.received) * 100).toFixed(1)}%`
      : '0%',
    recentFailures: recentFailures.slice(0, 50),
  };
}

function getResponseTimeStats() {
  const times = responseTimes.map(r => r.elapsed);
  if (times.length > 0) times.sort((a, b) => a - b);
  return {
    count: times.length,
    min: times[0] || 0,
    max: times[times.length - 1] || 0,
    avg: times.length ? Math.round((times.reduce((s, t) => s + t, 0) / times.length) * 100) / 100 : 0,
    median: times[Math.floor(times.length / 2)] || 0,
    p95: times[Math.floor(times.length * 0.95)] || 0,
    recent: responseTimes.slice(0, 10),
    offerErrors: offerErrors.slice(0, 20),
    successCount: responseTimes.length,
    errorCount: offerErrors.length,
    rfqStages,
  };
}

function getState() {
  return {
    connectionState,
    paused,
    lastHealthCheck: lastHealthCheck ? new Date(lastHealthCheck).toISOString() : null,
    reconnectAttempts,
    channels: channelNames,
    responseTimeStats: getResponseTimeStats(),
  };
}

module.exports = {
  connect,
  disconnect,
  pause,
  resume,
  loadPausedStateFromDb,
  getState,
  getResponseTimeStats,
  getLatencyBreakdown,
  seedResponseTimes,
  captureBaseline,
  getBaseline,
  wasRfqReceived,
  getReceivedRfqStats,
  getQuoteCoverageStats,
  getConfirmActivity,
  getPxSubmitErrorsByCombo,
  getRecentQuotes,
  _classifyMlbProp: classifyMlbProp, // exposed for /prop-opportunity sanity testing
  _classifyNbaProp: classifyNbaProp, // exposed for /prop-opportunity sanity testing
  _classifyNhlProp: classifyNhlProp, // exposed for /prop-opportunity sanity testing
  _classifySoccerProp: classifySoccerProp, // exposed for /prop-opportunity sanity testing
  _classifyFootballProp: classifyFootballProp, // exposed for line-manager football prop routers
  _extractPlayerNameFromPropMarket: extractPlayerNameFromPropMarket, // exposed for line-manager Phase-2 prop bridge
};
