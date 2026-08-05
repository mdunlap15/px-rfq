# NFL / CFB readiness

**Prepared 2026-08-05. First NFL preseason game: Carolina Panthers @ Arizona Cardinals, PX event `19453`, Thu 2026-08-07T00:00Z = Wed Aug 6, 8:00pm ET (~38h from when you read this).**

---

## Bottom line

**Game lines are reachable for tomorrow with about 3–4 hours of work plus a redeploy. Player props are impossible at any effort level. My recommendation is to not quote tomorrow anyway, and to target the Aug 13–16 preseason wave instead.**

The reason props are impossible is not policy — it's supply: The Odds API serves **zero player-prop market keys** for this event (MEASURED, 28 books, 4 regions), PX's only two football props are typed `sup_moneyline` and our own `parseMarketSelections` returns **zero selections** for them, and no football prop wiring exists anywhere in the repo. Nothing ships that by tomorrow.

The reason I'd skip the game lines is arithmetic on the trade: tomorrow is **one** game. Getting it live requires pushing three code changes to production during a live MLB/tennis/golf evening (redeploy = restart = lost volume on books that are actually earning), and at least two of those changes must ship *together* or we introduce a **measured 2× mispricing**. A dry-run with the sport-key fix applied and nothing else showed a 2-leg parlay containing PX's "Second Half Under 35.5" pricing at fair 23.98% / +292 — **byte-identical** to the same parlay built on the *full-game* Under 35.5. True P(second half under 35.5) is ~98–99%. We would quote roughly double the correct price. Aug 13–16 brings ~16 more preseason games; the same work captures 16× the volume with a week of testing behind it.

Also worth saying plainly so nobody re-does this work: **NFL regular season (Sept 10) needs no sport-key change at all.** The 272 events already cached under `americanfootball_nfl` are the regular season and the key is already mapped. The Tier 1 work below is a *preseason* problem.

---

## Current state

**The registration gap is not a bug.** Prod caches 272 NFL + 126 NCAAF odds events and registers ~0 football lines, and the instinct is that registration is broken. It isn't. PX lists **143 events total, of which 10 are American Football**: 4 CFL games, 1 NFL preseason game, 5 competitor-less NFL Futures events, and **zero NCAAF**. The 272 cached NFL events have no PX counterpart to match against — their first game is 2026-09-10. The one genuinely unmatched football event is tomorrow's preseason game, and it is unmatched because **The Odds API serves preseason under a separate sport key, `americanfootball_nfl_preseason`, which we do not fetch.** Prod `/status` `lines.lastSeed.unmatchedEventDetails` names it explicitly: `Carolina Panthers at Arizona Cardinals`.

| Area | Status | Why | Evidence |
|---|---|---|---|
| **Preseason odds source** | **Broken** | `americanfootball_nfl_preseason` is a distinct active TOA key holding exactly 1 event (the ARI/CAR game, 28 books). Zero occurrences of "preseason" anywhere in `config.js`, `services/`, `scripts/`, `index.js`. Missing from `config.js:1452` supportedSports, `config.js:~1476` sportNameMap, and `services/odds-feed.js:~236` `ODDS_API_FALLBACK`. `fetchOddsForSport('americanfootball_nfl_preseason')` emits **no HTTP request** and returns `{}` silently — it falls through to the retired SharpAPI block. | MEASURED |
| **NFL line registration** | **0 of ~50 line_ids** | Consequence of the above: no odds cache → team match fails → event skipped at `line-manager.js:1262`. With all three fixes applied in a stubbed dry-run, **48 lines register**. | MEASURED |
| **NCAAF** | **Nothing to register** | PX lists zero NCAAF events. TOA's earliest NCAAF game is 2026-08-29 (126 events). PX runs a ~3-day rolling game board (measured day histogram: 8/05=57, 8/06=50, 8/07=1, 8/08=14), so PX's silence carries **zero information** about whether it will offer CFB or in what shape. | MEASURED |
| **CFL** | **Working and complete** | PX exposes exactly ONE market on a CFL event (`Moneyline`, event `1500010333`). 4 games × 2 sides = the 8 registered lines. Not a gap, and CFL cannot form a same-game SGP at all. It is **not** a proof that the football spread/total/prop paths work — they have never run in production. | MEASURED |
| **Team name matching (NFL)** | **Works** | 32/32 PX NFL names round-trip to TOA exactly. TOA names on tomorrow's game are byte-identical to PX ("Carolina Panthers", "Arizona Cardinals"). PX futures-style abbreviations ("KC Chiefs", "SF 49ers") also resolve. | MEASURED |
| **"Second Half" markets** | **Live mispricing landmine** | `parseMarketSelections` (`services/prophetx.js:579-584`) retags First Half only. "Second Half Moneyline/Spread/Total Points" come back as plain `moneyline`/`spread`/`total`. Seed `excludePatterns` (`line-manager.js:1346`) contains `2nd half` but **not** `second half`, and `fullGameNames` is substring-matched so "Second Half Moneyline" passes on the "Moneyline" substring. The RFQ-time path's `subGameNamePat` (`:3025`) *does* catch it — the two gates disagree and the weaker one runs at seed. PX market 90 carries lines 16.5, 17.5 **and 35.5**; the full-game total ladder also carries 35.5. | MEASURED end-to-end |
| **Team totals** | **Registers with the WRONG TEAM** | In the fixed dry-run, *both* "ARI: Team Total Points" and "CAR: Team Total Points" registered as `teamName: "Arizona Cardinals"`, `home_over`/`home_under`. Cause: matching strategy 3, substring containment (`line-manager.js:556-560`) — "CAR" is a substring of "Cardinals", and that branch returns the first hit with **no ambiguity check**, unlike the last-N-words branch at `:567-574` which requires exactly one match. Fails closed today only because `TEAM_TOTAL_SPORTS` (`odds-feed.js:1826`) excludes football, so it dies at pricing with "no fair value". `config.js:729` `declineTeamTotals` defaults **false**, so `pricer.js:885` never fires either. | MEASURED |
| **First Half markets** | Registers, fails closed (dark) | Correctly retags to `first_half_*`, but `supplementNbaH1Markets` (`odds-feed.js:2174`) hardcodes `basketball_nba` in both the gate (`:1215`) and the URL (`:2203-2206`). TOA **does** serve `h2h_h1`/`spreads_h1`/`totals_h1` for football — only the plumbing is NBA-only. | MEASURED (TOA) / INFERRED (code) |
| **Alt lines** | Very thin, one single-book path | PX posts spreads ±0.5/1/1.5/2 and totals 34.5/35/35.5/36.5. Our book allowlist (`odds-feed.js:223` = pinnacle,draftkings,fanduel) yields DK ±1.5/35.5, FD ±1.5/35.5, Pinnacle ±1/35. `alternate_spreads` returns only each book's own main line. PX's ±0.5, ±2, 34.5, 36.5 have **zero** coverage. Total 35 has Pinnacle alone — and `ALT_LINES_PINNACLE_ALONE_OK` is live, so it priced at 50.2% off one book in the dry-run. | MEASURED |
| **Line bounds** | Absent for football | `TOTAL_BOUNDS_BY_SPORT` (`line-manager.js:280`) and `MAX_SPREAD_BY_SPORT` (`:311`) have no `americanfootball_*` key. Totals fall back to `absLine > 2.5`; spreads return `true` unconditionally. | MEASURED |
| **Vig** | Would quote at 1.5% | Prod `vigBySport` has **zero** football keys → `defaultVig` 0.015, our thinnest tier. NCAAB, a known-soft market, gets 3%. | MEASURED (`/status`) |
| **Prop caps** | Inert | `maxRiskPerParlayWithProp` = **5000** = `maxRiskPerParlay` = 5000, so the `Math.min()` at `pricer.js:3007-3009` is a no-op. `propMinBooksWithBothSides` = **1** (code default 2). `maxExposurePerPlayerBySport` = `{}` with a 5005 default. Same failure class as the documented `=6000` incident. | MEASURED |
| **Player props (PX side)** | Unparseable | PX posts 2 props on 19453, both `type: 'sup_moneyline'` with YES/NO selections: "Jeremiah Love To Score a Touchdown" (`1500029692`) and "Kenny Pickett or Carson Beck To Throw An Interception?" (`1500029727`). `px.parseMarketSelections` returns `[]` for both. The second is an OR-of-two-QBs market **no book posts anywhere** — unpriceable by construction. PX already has a live book on the first: $176 resting at +200. | MEASURED |
| **Player props (source side)** | No source for preseason | Enumerated real keys via `/v4/sports/{key}/events/{id}/markets?regions=us,us2,uk,eu`: preseason event returns 14 keys, **all game-line**, zero `player_*`. Regular-season NFL Week 1 returns `player_anytime_td` (2 books), `player_1st_td` (1), `player_tds_over` (1) — and nothing else; yardage/reception props are not posted 5 weeks out. NCAAF: **zero** `player_*` keys on three separate events. | MEASURED |
| **Prop pipeline (our side)** | Four independent gaps | No football branch in either prop router (`line-manager.js:1941-1957` pre-seed, `:3201-3215` on-demand); no `_classifyFootballProp`; `extractPlayerNameFromPropMarket` returns null for 13/14 football names; `PROP_LAUNCH_ALLOWLIST` has zero football entries. | MEASURED |
| **Point-less "anytime" prop bug** | **Live production bug, affects soccer today** | `lookupTheOddsApiPlayerProp` early-returns at `odds-feed.js:9743` on `allRows.length === 0`; `allRows` only accepts rows with `o.point != null`, and anytime markets carry no point. The one-sided wrapper re-propagates the error at `:9859` instead of recovering from `matchedRows`. Introduced by commit `3d45fca` (2026-07-08) which changed `matched.length===0` to `allRows.length===0`. MEASURED live on MLS: `player_goal_scorer_anytime` → `player_line_match:5, all_rows:0` → error. **`soccer.goalscorer` and `soccer.assists` are in the prod allowlist and have been silently dead for ~4 weeks.** | MEASURED |
| **NFL Futures** | Dormant, unguarded | 5 competitor-less events (Super Bowl `1500009835`, AFC `1500010487`, NFC `1500010488`, MVP `1500010486`, win totals `1500010316`), golf-outright shape. Never register (outright bypass at `line-manager.js:1132` is gated to `sport_name === 'Golf'`). But shouldDecline **ALLOWS** "KC win Super Bowl + KC win AFC" — perfectly nested, different pxEventIds, generic gate blind. | MEASURED |
| **Inactives / starter news** | No source, anywhere | `checkLineupFreshness` (`odds-feed.js:8764`) returns null for anything not `baseball_mlb`/`icehockey_nhl`. Repo-wide grep finds no injury/inactives/snap-count feed. TOA has none either. | MEASURED |
| **Pre-game staleness guard** | Weaker than documented | `isEventStalePreGame` (`odds-feed.js:7877`) docstring says 30-min window / 2-min cache. The **code** is `minsToStart > 10 → return false` and `getCacheAge(sport) > 3`. Comment and code disagree; someone will trust the comment. | MEASURED |
| **Book dispersion, preseason vs regular** | Not worse — but the comparison is confounded | On pinnacle/DK/FD, de-vigged fairs on the preseason game disagree by 0.85pp (h2h), 0.65pp (spread), 1.34pp (total) vs 3.50 / 2.44 / 1.34pp on a regular-season comparator; overrounds identical (~3.8–4.8%). **Do not lean on this**: the comparator is T-39 days vs T-42 hours, and disagreement shrinks toward kickoff. It also hides that books disagree on the *line itself* (Pinnacle 35 vs DK/FD 35.5), which is what collapses per-line support to 1 book. | MEASURED, confounded |

---

## What must happen before we can quote

### Tier 1 — game lines only (minimum to quote ML/spread/total tomorrow)

Order matters. **T1.1 must land before T1.2**, or enabling football activates the second-half leak on the very first game.

| # | Change | File / key | Effort | Risk if skipped | Needed tomorrow? |
|---|---|---|---|---|---|
| **T1.1** | Add `second half` to the seed exclusion. Cleanest: make the seed reuse the same sub-game pattern the resolve path already has at `:3025`. | `services/line-manager.js:1346` `excludePatterns` | 15 min | **The measured 2× mispricing.** Non-negotiable. | **YES — first** |
| **T1.2a** | Add the preseason key to the fetch config, copying the `americanfootball_cfl` block at `:274` verbatim: `{ oddsApiSport:'americanfootball_nfl_preseason', markets:'h2h,spreads,totals', bookmakers: ODDS_API_BOOKMAKERS }` | `services/odds-feed.js:~236` `ODDS_API_FALLBACK` | 5 min | No odds → nothing quotes | YES |
| **T1.2b** | `'americanfootball_nfl_preseason': 'American Football'` — **insert it BEFORE `americanfootball_nfl`** (see T1.3) | `config.js:~1476` `sportNameMap` | 5 min | `possibleSportKeys` (`line-manager.js:1096`) is derived solely from this map; without it, 0 lines even with the env var set (measured) | YES |
| **T1.2c** | Append `americanfootball_nfl_preseason` | `config.js:1452` default **and** Railway `SUPPORTED_SPORTS` env | 2 min | **Env overrides the code default entirely** — confirmed via `/status config.sports`. The code edit alone does nothing. | YES |
| **T1.3** | **Commence-time proximity guard** on the seed match (reject when the matched odds event's `commenceTime` is >~24–36h from PX's `scheduled`) | `services/line-manager.js:1153-1176` / `services/odds-feed.js:7592-7635` | 45–60 min + test | `getEventMarkets` picks the closest candidate by time with **no maximum delta**, and when only one candidate exists it never consults time at all. Both football keys sort "specific", stable sort preserves config order. So a preseason game whose pair also exists in the 272-event regular-season board binds to the **September** fixture and quotes off regular-season odds — silently, fresh cache, no stale flag. Tomorrow escapes by luck (measured: zero CAR-vs-ARI regular-season fixture). **4 of 17 preseason games Aug 6–17 do share a pair** — ARI@LV 8/14, LAC@HOU 8/14, LAR@KC 8/15, DAL@SEA 8/16. | Not for tomorrow's game specifically; **required before Aug 13** |
| **T1.4** | Football entries in `TOTAL_BOUNDS_BY_SPORT` and `MAX_SPREAD_BY_SPORT` | `line-manager.js:280`, `:311` | 10 min | No sanity net at all. Suggest NFL/preseason totals `[30,65]` spread 21; NCAAF `[30,90]` spread 45; CFL `[35,70]`. **Note:** bounds are *not* a substitute for T1.1 — `[30,65]` rejects the harmless 2H 16.5/17.5 and **accepts** the dangerous 2H 35.5. | Defence-in-depth |
| **T1.5** | Football SGP hard block, alongside the tennis block, env-releasable (`FOOTBALL_SGP_ENABLED`, default false) | `services/pricer.js:~4432` | 10 min | See correlation section. Removes the entire same-game surface in one line. | **YES** |
| **T1.6** | `VIG_BY_SPORT` += `"americanfootball_nfl_preseason":0.045, "americanfootball_nfl":0.03, "americanfootball_ncaaf":0.03` | Railway env only, no redeploy | 2 min | Otherwise we debut in the sharpest market on the calendar at our thinnest tier (1.5%) with zero calibration history and no inactives feed | **YES** |
| **T1.7** | `STALE_PRICE_MINUTES_BY_SPORT` += `"americanfootball_nfl_preseason": 2` | Railway env | 2 min | A new key inherits the 5-min default, not NFL's 4 (`config.js:798`). Too loose for a market that moves on a beat-writer tweet. | YES |
| **T1.8** | Advertise-and-decline cleanup: fail closed at registration for any line with no consensus behind it, not just H1/team_total | `line-manager.js:1874-1881` (extend the tennis-style guard) | ~1h | Realistic priceable slice is ~10 of 50 line_ids; the other ~40 get advertised to PX and decline 100% — the exact **PX Rule 2** issue Anthony flagged | Can follow, but it is a compliance surface |

**Tier 1 total: ~3–4 hours including tests, plus one redeploy.** Per CLAUDE.md the push needs a fresh explicit green-light from you, and a redeploy restarts the service and costs live volume — do it off-peak.

**Sport-key plumbing a new key silently inherits nothing from** (each fails quietly; none blocks tomorrow, but decide explicitly): `config.js:798` `stalePriceMinutesBySport`; `index.js:488` `FAST_REFRESH_SPORTS` (gated on `supportedSports` at `:500`); `odds-feed.js:4343` `SPORTS_WITH_ALT_MARKETS` (no pre-warm → alt fetch lands on the RFQ hot path); `odds-feed.js:4514` `ODDS_API_LIVE_SPORTS` + `order-tracker.js:4753`; `espn-scores.js:27` (dashboard in-play augmentation, not settlement — non-critical); `services/v2/correlation.js:84` (`nfl` 0.08 / `ncaaf` 0.05 → preseason gets 0, cross-game total parlays lose their uplift and are *underpriced*); `line-manager.js:3655/:3742` `MAX_ALT_DEVIATION`.

One of those misses is *accidentally protective* and you should know why before "fixing" it: under `americanfootball_nfl`, `MAX_ALT_DEVIATION` = 15 and `MAX_SPREAD_BY_SPORT` falls back to 15, which means the virtual-registration fallback (`line-manager.js:3611+`) will register **any prop leg carrying a line ≤15** as an alt spread and price it off the spread board. Under a *new* preseason key both lookups miss, `maxDeviation` becomes 0, and it fails closed. So a "simpler" merge of preseason events into `oddsCache['americanfootball_nfl']` **arms** that trap; a separate key defuses it. It is armed for the regular season regardless from Sept 10 — that guard belongs before then, not in the props backlog.

### Tier 2 — full game markets

| Item | Change | Effort | Notes |
|---|---|---|---|
| **First half** | Generalize `supplementNbaH1Markets` (`odds-feed.js:2174`) from hardcoded `basketball_nba` (`:1216`, `:2200-2206`) to a sport set; add dispatch at `:1215` | 2–3h + quota check | Data exists: `h2h_h1`, `spreads_h1`, `totals_h1` measured on the preseason event. Per-event endpoint → pace it like BTTS |
| **Second half / quarters** | Add an `isH2ByName` / quarter retag branch in `parseMarketSelections` alongside the F5/H1 blocks (`prophetx.js:570-584`) so the marketType can never *collide* with a full-game type even if a name filter is later relaxed | 30 min | Belt-and-braces for T1.1. Then a source is a separate build. |
| **Team totals** | Fix the abbreviation collision **first** (see below), then add football to `TEAM_TOTAL_SPORTS` (`odds-feed.js:1826`) — but confirm coverage: the preseason event serves only `alternate_team_totals` from **DraftKings alone**, no plain `team_totals` key | 1–2h recon + 1h fix | **Do not enable team totals until the CAR→Cardinals bug is fixed.** Add an abbreviation-aware guard for `<ABBR>: Team Total Points` (match the abbreviation against the competitor list explicitly, fail closed on ambiguity) plus an ambiguity check on the substring branch at `line-manager.js:556-560` mirroring the last-N-words discipline at `:567-574`. Unit test: ARI and CAR must resolve to different teams. |
| **Alt lines** | Decide on `ALT_LINES_PINNACLE_ALONE_OK` for football; consider adding football to `BLOCK_ALT_SPREAD_SPORTS` (`config.js:615`) or tightening `MAX_ALT_DEVIATION` from 15 to ~3 until alt pricing is validated | 30 min | Measured: PX total 35 priced at 50.2% off Pinnacle alone in the dry-run |

### Tier 3 — player props (ordered dependency chain)

Nothing before step 5 produces a single quotable football prop. **Not viable for preseason at all** (no TOA prop keys exist), and only marginally viable for NFL Week 1 (anytime TD on 2 books).

1. **Parser** — `services/prophetx.js parseMarketSelections`: add a football YES/NO branch modelled on the UFC MoV branch (`:627-655`) and tennis sets (`:678-701`). Anchored regexes only: `/^(.+?)\s+to\s+score\s+a\s+touchdown$/i` → `player_anytime_td`, player lifted from `market.name` into `playerName`, selection yes/no. **Deliberately do not match multi-player markets** ("X or Y To Throw An Interception?") — leave them unparsed so they decline. Do **not** let YES/NO reach team matching. ~50 LOC + test. 1–2h.
2. **YES→over remap** — this is the dependency that would otherwise make steps 1–5 register **zero** lines. The pre-seed's grouping loop drops anything that isn't `over`/`under` and anything with a null line (`line-manager.js:~1999-2004`), and the one-sided branch has a third gate at `:~2196`. Soccer only survives because of an explicit remap at `:1974-1977` that filters `outcomeName === 'YES'` and rewrites `{selection:'over', line: …}`. Football needs the identical remap. ~15 LOC. 30 min.
3. **Classifier + name extraction** — `_classifyFootballProp` in `services/websocket.js` beside the NBA/NHL/MLB/soccer classifiers; football strip patterns in `extractPlayerNameFromPropMarket`. **Regression-test against all three existing classifiers**: measured misroutes are `classifyNbaProp("Bijan Robinson To Score a Touchdown")` → `'turnovers'` (the `/\btos?\b/` regex matches "To"), `classifyNhlProp("Justin Tucker Field Goals Made")` → `'goals'`, `classifyMlbProp("Jeremiah Love To Score a Touchdown")` → `'hitter_other'`. ~90 LOC. 2–3h.
4. **Routers** — `_FOOTBALL_PROP_TO_TOA_MARKET` beside the existing maps (`line-manager.js:21-93`); add the `sportKey.startsWith('americanfootball')` branch to **both** `:1941-1957` and `:3201-3215`. They must stay in lockstep or the seed and on-demand paths disagree. ~40 LOC. 1h.
5. **Fix the point-less anytime bug** — `odds-feed.js:9743` gate the `allRows.length === 0` return on `line != null` (or push point-less rows with `point: null`), and stop `:9859` propagating `std.error` when `std.matchedRows` is non-empty. **Do this regardless of the football decision — it is killing `soccer.goalscorer` and `soccer.assists` in production right now.** ~30 LOC + fixture test. 1–2h.
6. **One-sided path** — extend `oneSidedEligible` (`line-manager.js:2085`) to football anytime-TD and add it to the book-mirror branch at `:2158`. `player_anytime_td` is Yes-only at every book, so the two-sided path can never satisfy `booksWithBothSides`. Register **YES side only**. ~25 LOC. 1h.
7. **Name normalization** — `normPlayerName` (`odds-feed.js:9671`) strips `[.'`]` but **not hyphens**. Measured against live TOA: "Jaxon Smith Njigba" → `player_line_match:0` vs "Jaxon Smith-Njigba" → 2. Also strip suffixes into a separate compared field so "Michael Carter" ≠ "Michael Carter II" while "Travis Etienne" == "Travis Etienne Jr.", and drop `D/ST` entries. Separately: **delete or team-scope the last-name-only fallback** in `dk-scraper.js:1966` — it already collides at n=47 (Kyle vs Kyren Williams) and is unusable on a full NFL slate. ~80 LOC + a name table test. 2–3h.
8. **Config, env only** — `MAX_RISK_PER_PARLAY_WITH_PROP` → **50** (currently 5000, inert); `PROP_MIN_BOOKS_WITH_BOTH_SIDES` → 2 (currently 1); `MAX_EXPOSURE_PER_PLAYER_BY_SPORT` → add football; confirm live `MAX_PROP_RISK_PER_GAME`/`MAX_PROP_TEAM_SIDE_RISK` (accrued $3,445 on one game vs the 600/300 code defaults implies they are far above them); `PROP_LAUNCH_ALLOWLIST` += `americanfootball_nfl.anytime_td` **only, and only last**. Do **not** add NCAAF.
9. **Correlation** — leave `SGP_ALLOWED_COMBOS` untouched. `prop_settlements` is hardcoded `sport === 'baseball_mlb'` (`prop-settlement.js:143`, `:163`), so `/prop-correlation` has zero football data and any football prop correlation factor is a guess.

**Realistic: 2–3 engineering days for steps 1–8, delivering anytime-TD on regular-season NFL where TOA has 2 books.** Yardage/reception coverage must be re-measured in game week (not posted 5 weeks out) or built as a DK Puppeteer scraper on the `scripts/dk-wc-props.js` pattern (~1 day recon + ~1 day wiring, single-book so book-mirror only, and subcategory ids rotate).

### CFB-specific

**There is nothing to build against today and no way to bound the estimate.** PX lists zero NCAAF events, and its game board is only ~3 days deep, so its silence tells us nothing. TOA's first NCAAF game is 2026-08-29.

**The long pole is team names, and it is worse than NFL by an order of magnitude.** Measured against real TOA rosters (184 distinct teams):

- School **+ mascot** naming: **184/184 correct.**
- School **only** (mascot dropped): **~14–15 resolve to the WRONG TEAM silently** — Michigan→Central/Eastern Michigan, Texas→North Texas, Kansas→Arkansas Pine Bluff, Miami→Miami (OH), Florida→Florida State, Tennessee→Middle Tennessee, Arizona→Arizona State, Oregon→Oregon State, Iowa→Iowa State, and more. The list **differs between runs** because the substring branch returns the first hit and depends on odds-cache array order.
- Aliases returning null (→ dark, safe): "Miami (FL)", "North Carolina State", "Louisiana State", "Central Florida", "App State", "Southern California".

Mitigating: a wrong *price* needs **both** teams to mis-resolve into a pair that exists as a real cached event, so the dominant outcome is a dark game (lost volume) with a narrow mispricing tail. But the substring branch (`line-manager.js:556-560`) genuinely lacks the ambiguity check its sibling has, and that should be fixed regardless.

**Plan:** recon on **Aug 26–27** — the day PX posts CFB, re-run the matcher against real PX-vs-TOA pairs, build a `TEAM_NAME_OVERRIDES` block, add NCAAF bounds and vig. Budget 1–2 days for the naming pass alone, and treat the total as **unbounded** until PX's market shape is observed. Do **not** attempt CFB props — zero TOA prop keys measured on three separate NCAAF events.

---

## Correlation rules that MUST land before football SGPs

**Good news first, because it inverts the expected finding: the generic pxEventId-keyed gate *will* catch nested period markets.** PX puts all 14 markets on tomorrow's game — full game, 1Q, 1H, 2H, both team totals, both props — under **one** `pxEventId` (`19453`). This is the opposite of golf outrights, where PX splits Winner/Top-5/Make-Cut into separate events and the generic machinery is structurally blind.

I verified this with a `shouldDecline` harness against prod SGP config. Measured **DECLINED**: ML+spread, spread+alt-spread, team_total+total, team_total+team_total, team_total+spread, 1H+full-game (both spread and total), 2H ML + full ML, 3-leg one-game tickets, and all four same-game prop shapes (QB+WR, ATD+ATD, prop+team total, prop+game total) via `prop_correlation_same_game`.

**The gate is not the problem. The mis-tagging is.** Measured **ALLOWED**: `2H ML + full Total` (classifies as `ml_total`), `2H Total + full Spread` (`spread_total`), `2H Spread + full Total` (`spread_total`) — because the 2H legs carry marketType `moneyline`/`spread`/`total` and are indistinguishable from full-game legs. Fix the retag (T1.1 / Tier 2) and `classifySgpCombo` (`pricer.js:4385-4407`) returns null for those pairs and they decline generically.

Required blocks, in order:

| Block | What it prevents | Why the generic gate is insufficient |
|---|---|---|
| **`football_sgp_blocked`** (`pricer.js:~4432`, alongside the tennis block, env-releasable via `FOOTBALL_SGP_ENABLED`) | Every same-game football combination at launch | Prod allows `spread_total` and `ml_total` **on any sport** with **flat, sport-agnostic factors** (1.15/1.15, `spread_fav_over` 1.30) that `config.js` itself documents as back-calculated from **4 FanDuel MLB/NHL samples**, constant in spread magnitude, with no football key. Football has the strongest game-script coupling of anything we quote and the biggest book SGP discounts. Tennis got a hard block for exactly this reason. **Do not instead add football keys to `sgpCorrelationByCombo` — a guessed factor is worse than a block**, and that's the mistake `config.js` documents for tennis. |
| **`football_period_sgp_blocked`** — explicit, unconditional pre-pass in the style of `mov_sgp_blocked` (`pricer.js:3778-3792`) / `tennis_sets_sgp_blocked` (`:3812-3827`): if any leg's marketName or marketType identifies a period market (first/second half, any quarter), decline any parlay containing another leg on the same `pxEventId` | 1Q ⊂ 1H ⊂ game; 2H ⊂ game. Independent multiplication of nested legs is the golf and UFC failure verbatim | The generic gate *does* see the shared `pxEventId` here — but T1.1 proved the **marketType string can silently become a full-game one**, and the gate reads marketType. This pre-pass must not depend on the generic gate, exactly as the MoV pre-pass doesn't (CLAUDE.md: that gate blocks MoV today only because no key in `SGP_ALLOWED_COMBOS` happens to match — incidental protection that evaporates the moment someone adds a combo key). |
| **Football prop marketType assertion** (registration-time, before any `PROP_LAUNCH_ALLOWLIST` football entry) | A prop registering as `marketType: 'moneyline'` turns prop+total into an **ALLOWED `ml_total`** priced off the team moneyline | This is the BTTS/MoV/tennis-sets trap for the fourth time. Everything protecting QB+WR stacks, ATD stacks, team-total+RB and game-total+prop is `prop_correlation_same_game` keying on the `/^player_/` prefix (`pricer.js:3994`, `:4144`) — measured to decline all four shapes **when the prefix is present**. PX types these `sup_moneyline`. Assert + test that a football prop line never carries marketType in {moneyline, spread, total, team_total}. |
| **`football_futures_nested`** — keyed on **TEAM/PLAYER, not pxEventId**, modelled on `golf_same_player_nested` (`pricer.js:3870-3936`) | "KC win Super Bowl + KC win AFC" — perfectly nested, P(joint) = P(SB), not the product. Also SB+win-total, MVP+that player's team futures | This one the generic gate genuinely **cannot** see: SB `1500009835`, AFC `1500010487`, NFC `1500010488`, MVP `1500010486`, win totals `1500010316` are **distinct pxEventIds** with one market per team. Golf outrights verbatim. Measured **ALLOWED** today (`sgpCombo = null`, no gate fires). Dormant only because outright registration is gated to `sport_name === 'Golf'` at `line-manager.js:1132`. **Do not add `sup_moneyline` to the seed's `supportedBase` for football until this exists.** |
| **Prop ladder exclusion** (pre-emptive) | Composite football propTypes collapsing wrongly in `matchNestedPair` | `matchNestedPair`'s same-stat over-ladder branch (`pricer.js:3589`) is sport-agnostic and `prop_nested` is **live in prod**. A pass-yds ladder collapsing to the strong leg is arithmetically exact and fine — but only if no football propType conflates two stats (the `hitter_rbi_runs` mistake). Add any composite to `_NESTED_LADDER_EXCLUDED_PROPTYPES` (`pricer.js:3533`). |

**Keep as-is — verified, do not loosen:** do not add `ml_spread`, team_total pairs, or any 3+leg football signature to `SGP_ALLOWED_COMBOS` / `sgpCorrelation3PlusByCombo`. Cross-game football parlays (different pxEventIds) are allowed and should stay allowed.

`NOVELTY_PATTERN` (`pricer.js:3709`) already covers first touchdown / first FG / first to score / coin toss / opening kickoff / first possession / winning margin — that surface is already handled.

---

## Preseason: recommendation

**Do not quote tomorrow. Land Tier 1 properly this week and go live on the Aug 13–16 wave. Props wait for Week 1 at the earliest — and honestly, for a real prop build, not a launch.**

Why props wait, concretely: TOA serves **zero player-prop keys** for preseason, so there is no price source at any effort level. Even for regular-season Week 1, coverage is `player_anytime_td` on 2 books, `player_1st_td` and `player_tds_over` on DraftKings alone — against a `propMinBooksWithBothSides` we should be *raising* to 2, into a prop cap that is currently inert at 5000, with the `allRows` bug meaning the one-sided lookup path returns an error today. And we would be doing it on the one sport where `prop_settlements` has no data at all, so every same-game prop correlation factor would be a guess. There is no version of this that is ready in five weeks, let alone one day.

Why not tomorrow's game lines: one 8pm game, against three code changes that have never run in production, a redeploy during active hours, and a measured 2× mispricing that only stays closed if T1.1 ships in the same commit. The Aug 13–16 wave is 16 games and buys a week of testing. It also happens to be exactly when the commence-time collision (T1.3) starts biting — ARI@LV, LAC@HOU, LAR@KC, DAL@SEA all recur in the regular season — so the work needs to be done properly by then regardless.

**If you decide to go tomorrow anyway, the non-negotiable set is: T1.1 + T1.2a/b/c + T1.5 + T1.6 + T1.7, all in one commit, pushed off-peak, followed by a `/lines` check that (a) NFL lines > 0, (b) no line's marketName contains "Second Half", (c) team totals show two distinct teams.** Skip any one of T1.1 / T1.5 / T1.6 and don't do it.

**Settings for whenever we do go live (Railway env, no redeploy needed):**

```
VIG_BY_SPORT           += "americanfootball_nfl_preseason": 0.045
                          "americanfootball_nfl":           0.03
                          "americanfootball_ncaaf":         0.03
STALE_PRICE_MINUTES_BY_SPORT += "americanfootball_nfl_preseason": 2
FOOTBALL_SGP_ENABLED    = false            (new flag, T1.5)
MAX_RISK_PER_PARLAY_WITH_PROP = 50         (fix regardless — currently inert at 5000)
PROP_MIN_BOOKS_WITH_BOTH_SIDES = 2         (currently 1)
```

4.5% preseason vig is 3× our default and above NCAAB's 3%. Justification: zero calibration history, no inactives feed, and a market whose dominant price driver — who plays and for how long — surfaces from beat writers 60–90 minutes before kickoff, information we structurally do not have. Trim only after 2–3 weeks of settled data. Do **not** trim it on the strength of the dispersion measurement above; that comparison is confounded by time-to-event.

---

## Risks and what would go wrong

| Failure mode | Likelihood | Caught by | Severity |
|---|---|---|---|
| **Second-half leg priced off full-game consensus** | Certain, if the preseason key ships without T1.1 | **Nothing.** The marketType string is indistinguishable from a real full-game leg; registered lines never re-enter `resolveUnknownLine` where the correct pattern lives. Single-leg 2H legs are declined by the negative-odds guard, but **parlays are the product and that guard vanishes at 2 legs** — measured. | **Critical — ~2× mispricing.** Tomorrow only the 2H moneyline actually prices (2H spread ±0.5 and 2H totals 16.5/17.5 have no book coverage, so they fail closed by accident). In the regular season the 2H spread ladder (~±7) overlaps the full-game ladder (~±14) almost completely and the leak becomes fully live. |
| **Preseason game binds to a regular-season odds event** | High from Aug 13 (4 of 17 games share a pair) | **Nothing.** No max commence-time delta anywhere in the match path; fresh cache, no stale flag, no decline. | **Critical.** Also worth checking against the open memory item "5 mid-series MLB games dark all day 7/23 — stale-event commence-time match hypothesis" — same code path, and T1.3 would confirm or kill that theory. |
| **Team total registers on the wrong team** | Certain for football, whenever team totals are enabled | Currently fails closed at pricing (`TEAM_TOTAL_SPORTS` excludes football → "no fair value"), which is **luck, not a guard**. `declineTeamTotals` defaults false so `pricer.js:885` never fires. | High, latent. NFL/CFB team totals are always PX-abbreviated, so this is systemic. |
| **Football prop registers as marketType `moneyline`** | Only if props are built carelessly | Nothing — it becomes an allowed `ml_total`. Needs the registration-time assertion. | High, latent |
| **CFB game priced off the wrong school** | Moderate, if PX drops mascots | Mostly dark (both teams must mis-resolve into a real cached pair), narrow mispricing tail | Medium — mostly lost volume |
| **Alt line priced off Pinnacle alone** | Measured on tomorrow's total 35 | `ALT_LINES_MIN_BOOKS=2`, but `ALT_LINES_PINNACLE_ALONE_OK` explicitly overrides it | Medium — decide explicitly whether single-book pricing is acceptable for a sport with no history |
| **Starter news at T-90min** | Every preseason game | `isEventStalePreGame` fires only inside **10 minutes** of kickoff with a 3-min cache limit (not the 30/2 its docstring claims). The T-90 → T-10 window is covered only by the ordinary staleness gate. | Medium-high, unmitigated except by vig |
| **~40 of 50 line_ids advertised then always declined** | Certain, without T1.8 | Nothing | Medium — PX Rule 2 compliance |
| **TOA 429 drops football lines for a cycle** | Observed — 429s hit at 300/400/700/1000ms spacing on a key already carrying production load | Fails closed (0 events → 0 lines), but lines **flap in and out between seeds**, same trap documented for BTTS | Low-medium. Quota is a non-issue (19.5M remaining, unposted markets cost 0); **frequency** is the only constraint |
| **Redeploy during active hours** | Certain | N/A | Real cost — lost MLB/tennis/golf volume. Push off-peak. |

**Not a risk (verified, so don't spend time here):** cross-game football parlays, ML+spread, spread+alt-spread, 1H+full-game, team-total pairs, 3-leg one-game tickets, and all four same-game prop shapes all decline correctly today. CFL is complete and structurally safe. NFL Futures never register. NFL team-name matching is 32/32.

---

## Open questions

1. **Will PX offer CFB at all, and in what market shape?** Unanswerable until PX posts NCAAF (its board is ~3 days deep; TOA's first game is 8/29). Everything about the CFB estimate — market shape, naming convention, prop availability — is unknown until ~Aug 26.
2. **Does PX post team totals with abbreviations on every football event, or only some?** One event observed. If some events use full names, the collision guard needs to handle both.
3. **Is single-book (Pinnacle-alone) pricing acceptable for football alt lines?** Operator call. Currently permitted by `ALT_LINES_PINNACLE_ALONE_OK` and measured firing.
4. **What are the live `MAX_PROP_RISK_PER_GAME` / `MAX_PROP_TEAM_SIDE_RISK` values in Railway?** `/sgp-experiments` shows accrued per-game prop risk up to $3,445 against code defaults of 600/300, so they are set well above default and I could not read them.
5. **Preseason softness — real or not?** The dispersion comparison (T-42h preseason vs T-39d regular) is confounded and proves nothing. Re-run against a regular-season game at comparable time-to-kickoff before using it to justify any vig trim, and track **line** disagreement (Pinnacle 35 vs DK/FD 35.5), not just pp dispersion at each book's own line.
6. **Does PX's odds ladder accept the prices football SGPs would produce?** Untested for football; only surfaces as submit errors, not bad fills.
7. **Regular-season NFL prop coverage in game week.** `player_pass_yds` / `_rush_yds` / `_reception_yds` / `_receptions` are simply not posted 5 weeks out. All 27 candidate keys return 200 (valid keys, no data) — coverage must be re-measured in Week 1 before any prop build is scoped against them.
8. **`isEventStalePreGame`: is 10min/3min intentional or a regression?** Code and its own docstring contradict each other. Whichever is right, they must not both ship — someone will trust the comment.
9. **Verify the soccer goalscorer/assists fix separately.** The `allRows` bug (introduced 2026-07-08, commit `3d45fca`) has silently killed two live allowlist entries for ~4 weeks. Confirm they start quoting after the fix, independent of anything football.
