# ProphetX Parlay Service Provider

Automated market maker for parlay bets on ProphetX (PX). Receives RFQs via WebSocket, prices them using de-vigged sportsbook odds, and submits offers back.

## User Context

- **Timezone**: US Eastern (ET)
- **Operator**: Mike — runs the parlay SP, monitors via dashboard

## Architecture

```
index.js                  Entry point — Express server + async startup sequence
config.js                 Env vars, pricing defaults, sport mappings
services/
  prophetx.js             PX API client (auth, events, markets, offers, confirmations)
  websocket.js            Pusher WebSocket — RFQ/confirm/settle event handlers
  pricer.js               Pricing engine — fair value + vig → offer (American odds)
  odds-feed.js            SharpAPI (primary) + The Odds API (fallback) — de-vigged odds
  line-manager.js         Maps PX line_ids to Odds API events, team name matching
  order-tracker.js        Exposure tracking, P&L, market intelligence, decline stats
  db.js                   Supabase client (parlay_orders, matched_parlays tables) + retry spool
  db-breaker.js           Circuit breaker every Supabase request goes through (timeout + fail-fast)
  state-snapshot.js       Last-known-good state files for a DB-down boot (needs a Railway volume)
  logger.js               Simple leveled logger (debug/info/warn/error)
client/
  index.html              Dashboard SPA (Live, Analytics, History, Market Intel, Config tabs)
```

## Deployment

- **Platform**: Railway (auto-deploys on push to main)
- **Runtime**: Node.js (`npm start` → `node index.js`)
- **Dev**: `npm run dev` → `node --watch index.js`
- **No build step** — vanilla JS, no TypeScript, no bundler

## Environment Variables (set in Railway)

| Variable | Required | Description |
|---|---|---|
| `PX_ACCESS_KEY` | Yes | ProphetX partner API access key |
| `PX_SECRET_KEY` | Yes | ProphetX partner API secret key |
| `PX_BASE_URL` | No | Default: `https://cash.api.prophetx.co` (production) |
| `SHARP_ODDS_API_KEY` | No | SharpAPI key. **SharpAPI is DECOMMISSIONED** — subscription cancelled 2026-06-25 and every former call-site now checks one gate, `_sharpEnabled()`, which is false unless `SHARPAPI_ENABLED='true'` AND the key is present. A stale key lingering in the environment issues **no** requests. Was "Required: Yes / primary odds source" until 2026-08-21; that was wrong for ~8 weeks. |
| `SHARPAPI_ENABLED` | No | Emergency re-enable for SharpAPI. Must be the literal string `'true'`. Leave unset — the overlap-window fall-throughs fail closed to TOA (a stale gate declines if TOA is empty), which is the intended behavior. |
| `TOA_PRIMARY_SPORTS` | No | Comma-separated sport keys for which The Odds API is PRIMARY rather than a fallback. The one-sport-at-a-time migration toggle off SharpAPI; with Sharp decommissioned this now governs which sports take the TOA-primary path. |
| `THE_ODDS_API_KEY` | No | The Odds API key (fallback for NCAAB, alt lines from Pinnacle) |
| `SUPABASE_URL` | No | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | No | Supabase service role key |
| `DEFAULT_VIG` | No | Default: 0.015 (1.5% per leg) |
| `VIG_BY_SPORT` | No | JSON map of per-sport base vig overriding `DEFAULT_VIG` (e.g. `{"soccer":0.03}`) |
| `VIG_BY_SPORT_MARKET` | No | JSON map keyed `<sport>.<marketType>` (e.g. `{"baseball_mlb.total":0.010}`) overriding `VIG_BY_SPORT` for one market. **SCOPE: matches the POST-PARSE marketType**, so `baseball_mlb.total` is FULL-GAME only — F5/1H/2H/quarter/team/series/RFI totals carry their own suffixed types and are NOT covered — while ALT spreads/totals ARE covered (they retag back to plain `spread`/`total`). **Usually INERT on markets with Pinnacle/FD/DK coverage**: the per-leg consensus floor (`PRICE_FLOOR_VS_CONSENSUS_PP`, prod 1pp) sets the price there, measured 2026-08-14 — a −110/−110 MLB total quotes 51.381% at both 1.6% and 1.0% vig. It reaches a price mainly on legs with NO book consensus, which are the least-corroborated fairs, so narrow with care. Exists because sport-wide vig cannot express "absent from MLB totals, competitive on MLB moneyline" — measured 2026-08-14: we won 5.9% of MLB-total contests we entered and 3.2% of spreads, in the one family the audit proved calibrated. Moves the BASE vig only; favorite ramp, prop floor, MMA/golf minimums, SGP multiplier and the 20% ceiling all still apply, so an override can never push a leg below its own floor. Entries that are 0, negative, >0.25, or malformed are DROPPED (falls back to sport vig) rather than quoting at fair. |
| `MLB_SGP_CORRELATION_MEASURED` | No | Default: off (must be the literal `'true'`). When on, `services/mlb-sgp-correlation.js` takes precedence over the sport-agnostic `SGP_CORRELATION_BY_COMBO` grid for MLB `ml_total` / `spread_total` pairs. The grid's MLB numbers (`ml_total` 1.15, `spread_fav_over` 1.30) were back-calculated from 4 FanDuel samples and never measured; measured over the complete 2024–25 seasons (4,911 games), **`ml_total` is small and DIRECTIONAL** (fav+under 1.03, dog+over 1.05, the other two anti-correlated → clamp) and **run-line fav+over is 1.00–1.13 depending on the game total**. Gated, unlike football, because MLB same-game is LIVE — flipping it reprices the $52K/wk of contested volume we currently lose at a 3.6–3.8pp median gap (0.13% / 0.02% of contests won). The 2× SGP vig multiplier is untouched; only the phantom correlation charge goes. |
| `MLB_SGP_CORRELATION` | No | JSON override of the measured MLB table (`{"ml":{"dog_over":{"factor":1.05}},"spread":{"fav_over":{"buckets":[{"maxTotal":7.5,"factor":1.13},...]},"dog_under":{"factor":1.05}}}`). Clamped at ≥ 1.00; malformed JSON falls back to the measurement. |
| `HR_PAIR_TRIM_PERCENT` | No | Default: 0 (**dark**). A/B split (0-100) for the **HR-pair margin trim** on 2-leg MLB parlays where BOTH legs are `player_hitter_hr` on **different** games. Assignment is `md5('hr:'+parlayId) mod 100` — deterministic, same idiom as the v2 arm — and recorded in `meta.hrTrimArm` (`null` out of scope / dark, `'control'` / `'trim'` in scope) whether or not the trim fires, so the control arm is attributable. Why it exists (measured 2026-09-09, 7 days): we lost **$70K/wk** of network fills on this exact shape at a **median gap of 0.32pp, 100% within 1pp**, while our own HR-pair fills run **+4.7% ROI [3.5, 6.1]** — the one prop market the audit found calibrated. Same-game HR pairs are excluded (they carry the `prop_prop_xteam` multiplier, p50 1.90×, a different product). Confirm-time drift keys on `fairParlayProb`, which the trim never touches, so a trimmed quote confirms in the same arm. |
| `HR_PAIR_TRIM_FRACTION` | No | Default: 0.4 (capped at 0.9). Fraction of the modelled margin `(offered − fair)` removed in the trim arm. ⚠ **A FRACTION, never a flat pp cut** — the median modelled margin on HR pairs is only **0.33pp (8.1% of fair)**, so a flat 0.30pp trim would put **37% of quotes at or below fair**. 0.4 turns an 8.1% relative edge into ~4.9%, closing ~0.13pp of the 0.32pp gap. `meta.hrTrimPreProb` keeps the untrimmed price so the counterfactual is recoverable from settled rows. |
| `HR_PAIR_MIN_REL_EDGE_PCT` | No | Default: 4. Hard floor on relative edge AFTER the trim: `offered >= fair × (1 + this/100)`. A trimmed quote below it is **clamped up, never declined** — so even a mis-set fraction cannot quote below fair. Mutation-checked: removing the floor, switching to a flat pp cut, and admitting same-game pairs each fail the suite (`test/hr-pair-trim.test.js`). |
| `ML_PAIR_TRIM_PERCENT` / `ML_PAIR_TRIM_FRACTION` / `ML_PAIR_MIN_REL_EDGE_PCT` | No | The **moneyline** twin of the HR-pair trim (2026-09-17), identical machinery in `pricer.js` on a parallel block: exactly 2 legs, both `baseball_mlb` `moneyline`, different games; arm = `md5('ml:'+parlayId) mod 100` (distinct salt, so ML-arm and HR-arm are independent); `meta.mlTrimArm`/`mlTrimApplied`/`mlTrimPreProb`/`mlTrimFraction`. Defaults **0 (dark)** / 0.4 / 4. Why: measured 2026-09-10, $253K/wk of 2-leg cross-game MLB ML network fills lost at a **0.69pp median gap, 35% within 0.5pp**, while our own 2-leg MLB ML settled fills run **z=-1.08** (calibrated, merely uncompetitive). Same guarantees: FRACTION of `(offered − fair)` never a flat pp; clamped to `fair × (1 + floor)`, never below; confirm reprice keys on `fairParlayProb` (untouched) so a trimmed quote confirms in the same arm. `test/ml-pair-trim.test.js`. |
| `PROP_NET_EXPOSURE_BY_SPORT` | No | JSON per-sport cap on **league-wide NET player-prop exposure**. Default `{}` — **no league-wide cap** (operator directive 2026-09-26: "get rid of any exposure by sport limits entirely"; was CFB $500 / NFL $1500 from 2026-09-07). ⚠ If re-imposed, the check charges each new ticket its FULL per-ticket cap (`MAX_RISK_PER_PARLAY_WITH_PROP`, prod $3000), so a league cap below a few multiples of that declines everything. A **new dimension** none of the existing caps can express: `MAX_EXPOSURE_PER_PLAYER_BY_SPORT` is per-PLAYER (twenty receivers in twenty games each sit under their own cap while the league book runs past $500), sgp-guard's prop game caps are per-GAME (blind to a whole Saturday slate), `MAX_RISK_PER_PARLAY_WITH_PROP` is per-TICKET. Computed by summing the EXISTING per-player accounting by sport — never a second set of books, so it cannot drift out of step. A sport ABSENT from the map is **uncapped on this dimension** (its other caps still apply), so add a league here when you open props for it. A `0` or negative entry means "not configured", NOT "block everything". |
| `FOOTBALL_TMINUS_HOURS` | No | Default: 48. **Operator directive 2026-09-21: "I do not want to quote NFL and CFB parlays until 48 hours out of each."** A football EVENT does not register until within this many hours of kickoff — gating the WHOLE event (game lines AND props), a NEARER cap than `MAX_DAYS_AHEAD` (6d). Enforced at every index entry point (seed filter + on-demand resolve, `reason:football_beyond_tminus`) so an RFQ cannot re-register a far-out football line the seed skipped. All PX football shares `sport_name` 'American Football' (NFL/CFB/CFL/preseason), so the floor applies to all of them — same conservative direction as `MAX_DAYS_AHEAD` (never hold far-out football risk where our fair moves more than the price). The football PROP window (`FOOTBALL_PROP_TMINUS_MINUTES`, prod 24h) is TIGHTER and still applies on top, so props open at 24h even though the event registers at 48h. Hours; 0/blank → 48; set very large to disable. `test/football-tminus-window.test.js`. |
| `FOOTBALL_GAME_MAIN_ONLY` | No | Default: **ON** (literal `'false'` restores the alt ladder; runtime key `footballGameMainOnly`, no restart). Operator directive 2026-10-01: NFL/CFB RFQ game lines match the order book — **MAIN NUMBER ONLY**. Every point-bearing game market on `americanfootball_nfl` / `_nfl_preseason` / `_ncaaf` (full-game, 1H, Q1 spread + total, team totals) registers only its consensus main; moneylines and props are untouched; CFL unchanged. Main = `nfl-consensus` board `mainLine` (the posters' median-of-main-key-points snapped to .5; per-team for team totals), else the odds-feed consensus line; neither → the market registers nothing. PX point = the one equal to main, else the unique PX point within 0.5, else none. One gate (`services/football-main-line.js` via `_footballMainRefusal`) at every entry point: seed + cold-start hydration (`_setSeedLine`), cache restore (exact main only), on-demand + virtual alt registration (declines with `football_alt_line` / `football_main_unknown` / `football_main_not_posted`). Build-then-swap removes the alts from PX's supported set on the first seed; when the main moves, the new main registers and the old one drops. `test/football-main-line-only.test.js`. |
| `FOOTBALL_PROP_TMINUS_MINUTES` | No | Default: 120. Football props do not **REGISTER** until the game is inside this window — so outside it PX is never told we support the line and never sends the RFQ (same posture as the golf kill-switch). Mirrors the single-leg scheduler, operator verbatim: "I don't want football player props being listed until T-120 before game start times." **NFL inactives drop ~90 minutes before kickoff — i.e. INSIDE the window** — so a board built earlier is quoting players who will not take a snap, and a resting stale quote is a free option for whoever watches the market move. An **unparseable kickoff fails CLOSED**. |
| `FOOTBALL_PROP_WINDOWS` | No | Default: unset → `FOOTBALL_PROP_TMINUS_MINUTES` for every league (unchanged behaviour). **`poster`** = the single-leg posters' live registration windows (operator "mirror the order book" directive 2026-10-01): NFL props T-60 and TDs T-60, on **Monday/Thursday** (ET weekday of kickoff — MNF is a UTC Tuesday) props T-120 / TDs T-360, **receptions T-60 every day**; CFB props + TD T-120. Or JSON `{"<sport>":{"props":60,"td":60,"monThuProps":120,"monThuTd":360,"late":{"receptions":60}}}`. A sport absent from the map keeps the global window. Enforced at the seed AND the on-demand bridge. `test/football-poster-mirror.test.js`. |
| `FOOTBALL_PROP_FAIR_METHOD` | No | Default: `poster`. NFL/CFB two-sided prop FAIR = the poster's: prob-space MEDIAN of each side across books quoting both sides at the exact point, then ONE 2-way de-vig — **Shin** for NFL (`nfl_game_cycle.pair_fair` → `px_post_client.devig2_shin`, ported as `odds-feed._shinDeVig2`, reference values pinned) with **Pinnacle's own pair** when its de-vig is within `FOOTBALL_PROP_PIN_MAX_GAP` (default 0.04) of the consensus, else the consensus; **proportional, no anchor** for CFB (`cfb_props_cycle`). The prop heavy-fav floor still applies on top. `legacy` = per-book proportional de-vig averaged (pre-2026-10-01). CFL has no poster → legacy. |
| `FOOTBALL_ANYTIME_TD_FIELD_T` | No | Default `{"americanfootball_nfl":4.10,"americanfootball_nfl_preseason":4.10,"americanfootball_ncaaf":5.0}` (the posters' TFIELD / `CFB_TD_TFIELD`). Anytime-TD FAIR = median over books of `raw × T / Σ(book's YES field)`; a book needs ≥10 outcomes, the player inside its field and Σ in (T, 3T); none → the old 8% assumed-overround fair. Fair only — the quote stays the raw book-mirror minus the sweetener, now **clamped never below fair YES** (the posters' never-shorter-than-fair rule). |
| `FOOTBALL_PROP_INJURY_GATE` | No | Default: on (literal `false` disables). ESPN availability gate (`services/football-injuries.js`, a port of the posters' `player_status.py`): a football prop on a player ESPN lists Out / IR / Doubtful / Suspended / Inactive does not register (seed + on-demand). Questionable is NOT blocked. **Fail-open** like the poster: no unique ESPN game (both teams, ±6h of kickoff) or a failed read → gate inactive. Scoreboard + summary cached `ESPN_INJURY_TTL_SECONDS` (300), 6s timeout; no network under `node --test`. |
| `FOOTBALL_PROP_MIN_BOOKS` | No | Default: 3. Football props need MORE books than the global `PROP_MIN_BOOKS_WITH_BOTH_SIDES` (2). Below 3 "there is no independent cross-check and we are mirroring one book with nothing to audit it". ⚠ The football floor is **ABSOLUTE — the trusted-single-book bypass (`PROP_TRUSTED_SINGLE_BOOKS`) is disabled for football**, otherwise one DK quote would satisfy it and silently defeat the rule. Kept separate so raising the football bar never tightens MLB/NBA/NHL. |
| `PROP_LAUNCH_ALLOWLIST` | No | Comma-separated `<sport>.<propType>` keys that may quote (e.g. `baseball_mlb.hitter_hr,soccer.goalscorer`). Props not listed never register. **Does NOT gate pitcher strikeouts** — those have their own dedicated seed/on-demand paths and their own kill-switch, `PITCHER_K_PROPS_ENABLED`. |
| `PITCHER_K_PROPS_ENABLED` | No | Master kill-switch for pitcher-strikeout props (`marketType='player_strikeouts'`). **Default: OFF** (2026-08-24); literal `'true'` to re-enable. ⚠ Corrected 2026-09-27: the dedicated K SEED branch is dead code (the mainMarkets `excludePatterns` drop "strikeouts"/"pitching" names first), so the only live SEED path is the generic allowlist pre-seed (`baseball_mlb.pitcher_strikeouts` in `PROP_LAUNCH_ALLOWLIST`), which did NOT consult this flag until 9/27. The flag now gates the generic pre-seed, the dedicated on-demand branch and the generic on-demand bridge — and with it off, an RFQ for a K lineId is CLAIMED and declined (`k_props_disabled`) instead of falling through to virtual registration as an MLB game alt-total (a bare `continue` did that). Re-enabling for seed-time registration needs BOTH the flag and the allowlist entry. **Do not re-enable without the K-under fix** (`PROP_FAIR_CALIBRATION` below). `test/k-under-fair.test.js`, `test/audit-fix-review.test.js`. |
| `PROP_FAIR_CALIBRATION` | No | JSON `{"<full marketType>.<side>": multiplier}` on leg fairProb (e.g. `player_hitter_hr.over`; a bare propType never matches), bounds [0.5, 1.5]. **Code defaults MERGE under the env, env wins per key** (until 2026-09-27 the env replaced the whole map). Code default `player_strikeouts.under: 1.19` — K-under legs priced off the strikeout-count distribution fair won 146 vs 122.3 expected over 219 unique legs (7/8–8/24), ratio 1.19 [95% CI 1.08, 1.31] (1.15 ex-ac90ac6d); calibrated (0.98) before 7/8 on exact-line de-vig. Paired with odds-feed `_strikeoutUnderFair`: K under = max(1 − distOver, 1 − exactLineOver); the OVER keeps the distribution fair. ⚠ **Prod env already sets `player_strikeouts.under: 1.15`** (interim, 8/24) alongside `player_hitter_hr.over: 0.93`, so prod resolves K-under to **1.15**, not 1.19, until that env key is changed. The miss concentrates on LOW lines (≤4.5: 1.22, 5.5: 1.19, ≥7.5: 1.04); the real fix is the count-distribution shape (early-exit left tail, pitch-count-capped right tail), which needs per-leg exact-line/mean logging first. |
| `SGP_CORRELATION_BY_COMBO` / `SGP_CORRELATION_3PLUS_BY_COMBO` | No | JSON maps of same-game correlation factors (the sport-agnostic GRID, back-calculated from FanDuel SGPs), merged onto code defaults and runtime-editable. **Every grid factor is FLOORED at 1.00 where it is applied** (`pricer.js`, 2026-09-27): directional and un-directed 2-leg keys, the legacy `SGP_CORRELATION_POSITIVE` fallback and the 3+ map incl. `default` — no env, partial-JSON or runtime edit can price a same-game parlay below independent (same clamp as the measured football/MLB tables). The `spread_fav_under` / `spread_dog_over` defaults are **1.00** (were 0.95; prod env sets both 1.08, but a partial replacement of the JSON silently brought the 0.95s back). A floor only at the directional lookup does NOT work — the `factor === 1` fallback re-reads the same key. `backfillSgpCorrelation` applies the same floor AND the measured football table first (it used to re-price football tickets stored at 1.00 off the grid). `test/sgp-grid-floor.test.js`. |
| `MLB_SERIES_ENABLED` | No | Default: ON (literal `'false'` turns it off; runtime key `mlbSeriesEnabled`, no restart). MLB playoff **Series Winner** legs, priced since 2026-10-04 on the **order-book methodology** — DK + BetOnline + Bovada consensus (`services/mlb-series-consensus.js`, see "MLB playoff series" below). Operator directive 2026-09-28: "quote MLB wild card series markets. $1.5K stakes." Each series is dark only while one of its games is in play. Stake: `maxSeriesRiskPerParlay` (runtime 1500 on 9/28; env 4500). Gross per series event: `MAX_SERIES_GROSS_EXPOSURE` (prod 6000; now also runtime key `maxSeriesGrossExposure`). Off also stops the consensus scrapes. |
| `MLB_SERIES_MAX_AGE_MIN` | No | **No longer read for MLB pricing** (2026-10-04) — the consensus uses `SERIES_SRC_MAX_AGE_S` per source. Kept in config for the legacy DK series path. |
| `SERIES_MIN_BOOKS` / `SERIES_MIN_BOOKS_PAIRS` | No | Defaults: 3 / unset. Consensus book floor, and per-series overrides as the poster's pair keys (`rays\|yankees:2,brewers\|padres:2`). Same names and semantics as `~/mlb_series_consensus.py`. ⚠ The order book's `run_ws_cycle.bat` sets `SERIES_MIN_BOOKS_PAIRS=rays\|yankees:2,brewers\|padres:2`; the RFQ book matches it only if Railway sets the same value (unset = 3 books everywhere, the fail-closed direction). |
| `SERIES_MAX_GAP_PP` / `SERIES_OVR_LO` / `SERIES_OVR_HI` / `SERIES_SRC_MAX_AGE_S` | No | Defaults: 3.0 / 1.01 / 1.12 / 600. A series declines when the counted books' de-vigged fairs span more than the gap; a book whose two-way overround is outside [LO, HI] is dropped for that series; a source read longer ago than `SERIES_SRC_MAX_AGE_S` does not count (evaluated at READ time). |
| `SERIES_MIN_EV` / `SERIES_MAX_SUM` / `SERIES_MAX_ASK` / `SERIES_WORST_BOOK_CLAMP` | No | Defaults: 0.01 / 0.97 / 300 / on (`0` = off). The poster's `price_pair()` knobs, translated to one parlay leg — see "MLB playoff series". |
| `MLB_SERIES_WARM_SEC` | No | Default: 300 (min 60). Consensus refresh cadence (DK + BetOnline Chrome scrapes through `dk-scraper`'s browser governor, Bovada JSON). Runs only while an MLB series line is registered and `mlbSeriesEnabled` is on. Must stay well under `SERIES_SRC_MAX_AGE_S` or series go dark between passes. `DK_SERIES_DEADLINE_MS` (70000) / `BO_SERIES_DEADLINE_MS` (60000) / `SERIES_BOVADA_TIMEOUT_MS` (15000) / `MLB_SERIES_WARM_DEADLINE_MS` (240000) bound each source and the pass. |
| `MAX_RISK_PER_PARLAY` | No | Default: 500 |
| `MAX_RISK_PER_PARLAY_WITH_PROP` | No | Default: 50. Cap on **OUR max risk** (payout liability) for any parlay containing a player-prop leg. Prod: 3000 (2026-08-13). |
| `PX_MIN_STAKE` | No | Default: 1. PX's minimum bookable stake. A per-parlay RISK cap is sent to PX as a *bettor stake* cap (Rule 3: `stake = risk × p/(1−p)`) floored at $1 — so when a cap converts to a sub-$1 stake cap, the smallest fill PX can book already breaches it and we are certain to reject at confirm. `priceParlay` declines those at quote time (`unfillable within risk cap`). Bites only where a small cap meets long odds: at the ordinary $500 `MAX_RISK_PER_PARLAY` the crossover is ~**+50000** (relevant to deep MoV tails, which are otherwise exempt from `MAX_ODDS`), at the $15 experimental-SGP cap ~+1500, and at the $3,000 prop cap beyond +300000. |
| `MAX_EXPOSURE_PER_TEAM` | No | Default: 50 |
| `MAX_RAW_EXPOSURE_PER_TEAM` | No | The per-team RAW hard cap (prod $6,000; runtime key `maxRawExposurePerTeam`). **Since 2026-09-26 it is genuinely hard** — see "Team / game caps" below. Distinct from `MAX_EXPOSURE_PER_TEAM` (weighted, prod runtime $8,500): raising one does not raise the other. |
| `DEDUP_MAX_REQUOTES` | No | Default: 1 (runtime key `dedupMaxRequotes`). Identical leg-set re-sends RE-PRICED per 5s window; beyond it they decline `duplicate parlay`. 0 restores decline-every-repeat. Why: bettors preview then place ~2.7s later and the PLACEMENT fills (128/704 vs 3/704 for the preview) — the old dedup declined the real order. |
| `PENDING_RESERVATION_DISCOUNT` | No | **INERT since 2026-09-26** — no gating cap reads quote-time reservations any more. Kept only so old env/runtime values do not error. |
| `MAX_LEGS` | No | Default: 8 |
| `STALE_PRICE_MINUTES` | No | Default: 15 |
| `REFRESH_INTERVAL_MINUTES` | No | Default: 10 (code default — production Railway sets 2) |
| `SUPPORTED_SPORTS` | No | Default: `basketball_nba,basketball_ncaab,baseball_mlb,icehockey_nhl,tennis,soccer` |
| `GOLF_OUTRIGHTS_PARLAY_ENABLED` | No | Default: `true`. Kill-switch for quoting golf outright legs (win/top 5/10/20/make cut) in **parlays**. When false, zero outright lines register → PX never sends an outright RFQ. |
| `GOLF_OUTRIGHT_MAX_AGE_MIN` | No | Default: 360. Refuse a DataGolf outright board older than this. DataGolf serves the LAST tournament's board when a tour is idle (euro returned a 9-day-stale "BMW International Open" on 2026-07-14) — without this we'd quote a finished event. |
| `GOLF_TOPN_TTL_MIN` | No | Default: 30. TTL of the DK ties-included top-N board cache (`services/golf-topn.js`). The DK scrape is Puppeteer (~142s/tournament) so it is warmed in the background and only ever read synchronously on the RFQ path. |
| `GOLF_DK_SLUG_MAP` | No | JSON PX-tournament → DK-league-slug overrides, e.g. `{"the open":"the-open-championship"}`. PX says "2026 The Open" but DK's slug is `the-open-championship`, so slugify does NOT work. A tournament with no slug simply never registers top-N (logged). |
| `GOLF_TOPN_MAX_AGE_MIN` | No | Default: 180. **READ tolerance** — how old a top-N board may be and still PRICE. Deliberately much larger than `GOLF_TOPN_TTL_MIN` and tracked separately: conflating the two made top-N go DEAD for a ~2.5min window every cycle, because the board expired at TTL while the re-scrape takes ~150s, so every read in between returned null (operator hit this at a 33min board vs a 30min TTL → Top 5 "No Offers Available"). Safe to be loose because these are 4-day tournament outrights that barely move pre-event — a 3h-old ties board beats no price. Beyond it we still fail CLOSED. |
| `GOLF_TOPN_TIES_UPLIFT` | No | Default: **1.27, ON by default (not opt-in)**. DataGolf serves top-N on the DEAD-HEAT basis while PX settles Ties Included, so `datagolf.fetchOutrightBoard` power-normalizes top-N to `N × uplift`. Uncorrected, our YES price is ~25% too cheap and we lay the NO — the gap is our loss on every ticket, which is why the default is on. 1.27 is MEASURED, not guessed: 5×1.27=6.35 matches the derived T(top_5)=6.35 exactly, and 10×1.27=12.70 sits ~3% ABOVE the measured T(top_10)=12.32 — deliberately the safe direction, since a higher target means a higher YES price and a safer NO lay. `0` falls back to raw consensus (conservative on a dead-heat basis ONLY — still ~25% below ties-included truth). |
| `GOLF_OUTRIGHT_PASTE_MAX_AGE_MIN` | No | Default: 720 (12h). Freshness ceiling for an **operator paste** board, deliberately longer than the scraped `GOLF_TOPN_MAX_AGE_MIN`: the operator pastes intentionally and stops via the kill-switch, so we don't force a re-paste on the tight scrape max-age. Beyond it, fail closed so a forgotten paste can't quote day-old odds. `outright_win` only ever comes from a paste, so it always uses this ceiling. |
| `GOLF_MAKE_CUT_VIG` | No | Default: 0.03. Our margin OVER the de-vigged fair for make_cut (`offered_implied = fair × (1 + vig)`). Moves the price the **opposite** way to `GOLF_OUTRIGHTS_SWEETENER` — see Key Gotchas. |
| `GOLF_MAKE_CUT_MIN_BOOKS` | No | Default: 2. Minimum sportsbooks quoting **both** make+miss before a player is priced. Cut boards are thin; 1-book players are noise. |
| `MOV_SOURCE` | No | Default: `bovada` — UFC MoV RFQ legs follow the **order-book methodology** (`services/bovada-mov.js`, see "UFC Method of Victory"): YES-only, offered = Bovada's raw YES implied, quoted only while YES ≥ `MOV_RFQ_MIN_YES_ODDS`, fair = 6-way Shin. **`dk`** restores the pre-2026-10-03 behaviour wholesale (DK 6-way power-de-vig fair × vig, YES **and** NO registered, no floor/window). Read per call. |
| `MOV_RFQ_MIN_YES_ODDS` | No | Default: 300 (runtime key `movRfqMinYesOdds`). A MoV YES leg registers and quotes only while Bovada's YES is at least this — the order-book poster's `NO <= -300` floor (`dwcs_mov_cycle.py MOV_FLOOR`) seen from the YES side. Compared on Bovada's raw American price (the poster snaps −YES to PX's ladder first; a parlay leg has no per-leg ladder). |
| `MOV_RFQ_WINDOW_H` | No | Default: 26 (the stager's `MOV_WINDOW_H`). MoV lines outside this many hours of the fight do not register or quote; an unparseable start fails closed. |
| `MOV_BOOK_MIRROR_SWEETENER` | No | Default: **0** (runtime key `movBookMirrorSweetener`) — offered = Bovada raw YES implied × (1 − this), so 0 is the order book's exact price. Separate from `PROP_BOOK_MIRROR_SWEETENER` (3%) on purpose. |
| `MOV_MIRROR_FLOOR_AT_FAIR` | No | Default: on (literal `false` disables). If Bovada's raw YES is ever below its own Shin fair (possible on ITD, a separate Bovada quote vs the KO+SUB fair) the leg is offered at fair instead — never a −EV mirror. Shown per line as `clampedToFair` on `/ufc-mov`. |
| `MOV_BOVADA_MAX_AGE_MIN` | No | Default: 30. Max Bovada board age that still PRICES; beyond it MoV legs fail closed (`mov_board_stale`). |
| `MOV_BOVADA_REG_MAX_AGE_MIN` | No | Default: 360. How old a board may be and still steer REGISTRATION (floor / refusals). Longer than the pricing tolerance so registration does not flap on a missed refresh; older (or cold) → lines register and pricing decides. |
| `MOV_BOVADA_TTL_SEC` / `MOV_BOVADA_TIMEOUT_MS` | No | Defaults: 120 / 15000. Bovada coupon refresh cadence (kicked by each line seed while PX lists MMA; single-flight, background only) and fetch timeout. |
| `MOV_TTL_MIN` | No | Default: 45. **`MOV_SOURCE=dk` only.** Warm cadence for the DK method-of-victory scrape (~3-5 min/card, background only — never on the RFQ path). |
| `MOV_MAX_AGE_MIN` | No | Default: 180. **`MOV_SOURCE=dk` only.** Max DK board age that still prices; beyond it MoV legs fail closed. |
| `MOV_DRAW_PROB` | No | Default: 0.005. **`MOV_SOURCE=dk` only.** The unpriced 7th outcome; the DK 6-way de-vig normalizes to `1 - this`. (The Bovada path ports the poster's Shin, which normalizes to 1.0.) |
| `MOV_MIN_PARLAY_PROB` | No | Default: 0.000001. Probability floor for **all-MoV** parlays, replacing the standard 0.1%. Raise it to re-impose a tail limit. |
| `BTTS_SPORTS` | No | Default: `soccer_usa_mls`. Sport keys eligible for Both-Teams-To-Score. Deliberately NOT every soccer key: `btts` is a per-event fetch, so each league multiplies calls against the same TOA key the main odds path uses, and that key rate-limits by frequency. Widen one league at a time. |
| `BTTS_BOOKMAKERS` | No | Default: `pinnacle,draftkings,fanduel,betmgm,betrivers,williamhill,matchbook`. Two-sided books only — a make-side-only book can't be de-vigged. |
| `BTTS_MIN_BOOKS` | No | Default: 2. Minimum two-sided books before a game is priced. |
| `BTTS_TTL_SECONDS` | No | Default: 240. TTL of the per-game BTTS consensus cache. |
| `BTTS_FETCH_SPACING_MS` | No | Default: 250. Gap between per-event BTTS calls. Guards the TOA request-frequency limit — an unpaced burst 429s, and a 429 masquerades as "no BTTS for this game". |
| `SGP_ALLOWED_COMBOS` | No | Comma-separated same-game combo keys that may quote. **Unset → legacy default `spread_total`. Explicitly empty (`""`) → ALL SGP combos blocked** — that distinction is load-bearing: setting `SGP_ALLOWED_COMBOS=""` on Railway must mean "block every SGP", not "fall back to spread_total", so the code distinguishes `undefined` from `''`. Keys: `spread_total` (moderate correlation), `ml_total` (strong, −37% ROI historically), `ml_spread` (blocked by correlation rules regardless). K-prop carve-outs (`kprop_ml`, `kprop_kprop`) are auto-included downstream regardless. Experimental classes (e.g. `prop_nested`) ALSO need an entry here to quote at all — experimental membership only adds tighter caps. ⚠ Adding a key here is what makes the MoV same-fight block's independence matter: `mov_sgp_blocked` is an unconditional pre-pass precisely so it survives any combo added here. |
| `SGP_BLOCKED_SPORTS` | No | Comma-separated sport keys on which **no same-game parlay quotes**, whatever `SGP_ALLOWED_COMBOS` says. **Unset → `icehockey_nhl`; explicitly `""` → no sport blocked** (same unset-vs-empty rule as `SGP_ALLOWED_COMBOS`). Operator directive 2026-09-28: "Do not allow any NHL SGPs for now. Let's monitor those to determine what combo allowances and SGP discount rates we need to apply." An unconditional pre-pass in `shouldDecline` (`sgp_sport_blocked`, the `mov_sgp_blocked` pattern) runs before the prop-correlation check, combo classification and the allowlist, so no combo key can re-open a listed sport; cross-game parlays still quote; golf-outright "events" are never treated as same-game. **Runtime-editable** (`sgpBlockedSports`), so NHL re-opens without a restart — back under `SGP_ALLOWED_COMBOS`, which for NHL still means the UNMEASURED generic grid, so release shapes with measured factors. **Monitoring:** `declines.detail` starts `combo=<ml_total|spread_total|ml_spread|prop_*|3plus|unclassified> dir=<fav|dog|unk>_<over|under>` (or `same_side|opp_side`) `markets= legs= sport= event=`; count demand with `substring(detail from 'combo=([^ ]+)')` and rank by joining `matched_parlays` on `parlay_id` (raw decline counts are inflated by repeats/bots). Shown in `/status` and `/sgp-experiments`. `test/sgp-sport-block.test.js`. |
| `FOOTBALL_SGP_ENABLED` | No | Default: false (must be the literal `'true'`). Releases football same-game parlays — but **ONLY the one measured shape**: exactly 2 full-game legs on the event, one side (spread or moneyline) + one game total, on NFL or NCAAF. Everything else same-game football stays blocked with the flag ON — **player props above all** (game-script coupling is an order of magnitude larger and is NOT calibrated), plus 3+ leg stacks, team totals, side+side, alt-total pairs, and CFL (never measured). A leg carrying a `playerName` is refused whatever its `marketType` claims, because PX types markets misleadingly (BTTS arrives as `moneyline`). Enabling it can NEVER re-open period-vs-game combos — that guard is separate. |
| `FOOTBALL_SGP_MAX_SPREAD_NCAAF` | No | Default: 28. CFB spread+total same-game parlays with |spread| at or above this DECLINE (`football_sgp_spread_too_large`). 0 disables. Added 2026-09-25 after Rutgers −42.5 + O56.5 quoted +233 vs FanDuel's SGP +151; the table has since been re-measured to 1.24 (28–35) / 1.25 (35+), so this is a safety cap, not a calibration gap. `test/cfb-sgp-spread-cap.test.js`. |
| `FOOTBALL_SGP_CORRELATION` | No | JSON override of the measured football side+total correlation table (`services/football-sgp-correlation.js`). **The defaults ARE the measurement** — an override is a deliberate departure from it, not tuning. Shape: `{"ncaaf":{"ml_total":1.02,"spreadBuckets":[{"minSpread":14.5,"factor":1.17},{"minSpread":0,"factor":1.0}]}}`. Factors are clamped at **≥ 1.00** — the negative directions are real (CFB fav+under measured 0.934) but honouring them would make our quote *cheaper* than independent, so they floor at 1.00. Malformed JSON logs a warning and falls back to the measurement. |
| `TELEGRAM_ALERTS_ENABLED` | No | Master kill-switch for ALL Telegram alerts. **Default: OFF** (operator directive 2026-08-28). Must be the literal string `'true'` to re-enable. Gated inside `telegram.sendMessage` — the single function every alert funnels through — so no call site can bypass it, and read from `process.env` per call so flipping it back on needs no restart. Note the pre-existing no-op only covered MISSING `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; this suppresses sends even when both are configured. |
| `LOG_LEVEL` | No | Default: `info` |
| `CLOSED_FIELD_ONE_SIDED_MARKETS` | No | Comma-separated TOA one-sided prop market keys where **exactly one outcome occurs**, so the whole field is **power-normalised to 1.0 per book** (the golf outright-win method) instead of assuming the per-outcome `toaOneSidedPropOverround` (8%). Default `player_1st_td,player_last_td` (last TD added 2026-10-01). Why: first-TD YES prices sum to **~1.36–1.38** across the field (49ers@Rams, 33 outcomes incl. "No Touchdown", 13 books), so the 8% assumption left every first-TD fair ~25% high — measured live after the fix: McCaffrey 0.169 → 0.137, Nacua 0.118 → 0.091, Kittle 0.063 → 0.046 (longshots compressed harder, as power normalisation should). A book qualifies only with ≥15 outcomes and a field sum in [1.05, 2.0] and the player's price inside it; no qualifying book → the 8% path (registration never depends on it). **Anytime TD must NOT be listed** — it is an open field (sum ≈ 5.6 = expected scorers). This corrects the FAIR (EV/risk); the QUOTE remains the raw book-mirror minus `PROP_BOOK_MIRROR_SWEETENER`. `test/first-td-field-normalization.test.js`. |
| `SPORT_MARKET_ALLOWLIST` | No | JSON `sport key → [post-parse marketTypes]` that may enter the line index — and therefore register with PX — for that sport; a sport with **no entry is unrestricted**. Default `{"soccer_uefa_champs_league":["total"]}`: the **Champions League league phase is TOTALS-ONLY** (operator directive 2026-09-09 when the key was added). Soccer totals are the one soccer market measured calibrated (z≈0); spreads (z=3.04, −$5.3K) and DNB favourites (z=3.45) were the June leak, and the Champions League is where favourites are heaviest. Enforced at **every** index entry point (seed, on-demand resolve, Supabase cache restore) — `test/sport-market-allowlist.test.js`. `total` admits full-game totals incl. alt totals (they retag to `total`) and excludes `team_total`, period totals, `btts`, `spread`, `moneyline`. |
| `STALE_PRICE_MINUTES_BY_SPORT` | No | JSON per-sport stale threshold (minutes) merged over code defaults (NFL/NCAAF 4, MLB 3, MMA/boxing/WNBA/NCAAB 5, golf matchups 25). Prod 2026-09-26: MLB 5, NCAAF 6, NFL 6 — the CFB cache ran 4–6 min between refreshes on a full Saturday slate (8–12 min at 19:10Z). **Runtime-editable since 2026-09-26** (`stalePriceMinutesBySport`, as is `propNetExposureBySport`) so neither needs a Railway edit — a Railway edit restarts the trader, which happened twice at peak that Saturday. ⚠ A runtime edit REPLACES the whole map; a sport left out falls back to `STALE_PRICE_MINUTES` (10) — looser. Always send the full map. |
| `SWEEP_PRIORITY_SPORTS` | No | Comma-separated sport keys swept **first every odds refresh cycle**, never displaced by the deadline carry, and exempt from `SWEEP_DEADLINE_MINUTES`. Default: `baseball_mlb,americanfootball_nfl,americanfootball_ncaaf,tennis,basketball_nba,icehockey_nhl,basketball_wnba,mma_mixed_martial_arts`; `none` restores the pure fairness rotation. Read per sweep (no restart needed). **Why (measured 2026-09-09):** $463K/wk of MLB network fills were declining as `stale odds` at a 3-min threshold — 53% within 3 min past it — because the MLB cache ran 4–8 min old against a 2-min refresh: the sweep walks all 26 sports under a 4-min deadline, waits out up to 120s of TOA 429 cooldown per sweep, and the carry put the deadline-skipped tail in FRONT of MLB (5th in `SUPPORTED_SPORTS`), so MLB was pushed back, skipped, carried, and pushed back again. Fairness rotation alone starved the sports with the most demand. |
| `WS_CONFIRM_STALL_MINUTES` | No | Default: 30 (raised from 12 on 2026-08-18; prod sets 30 explicitly). Half of the confirm-stall watchdog: force a WebSocket reconnect only after this long with no `price.confirm.new` **event** AND `WS_CONFIRM_STALL_MIN_OFFERS` offers submitted. Resets on the EVENT, not on a fill, so rejecting confirms (blocked creators, reprice misses) never reads as a dead channel — meaning it targets ONE failure mode: PX silently stops delivering on the private channel. It would NOT have fired on the 2026-06-21 outage (confirms arrived, then failed closed); a separate detector covers that. |
| `WS_CONFIRM_STALL_MIN_OFFERS` | No | Default: 250 (raised from 40 on 2026-08-18; prod sets 250 explicitly). The offer-count half of the same AND-gate, and the dimension that does nearly all the separating work. **The ORIGINAL default (40) was badly mis-calibrated**: normal quote→confirm conversion is ~3.6% (~27 offers/confirm), so 40 offers with no confirm is an ordinary lull. Measured over 4 healthy days (2026-08-14→18, 15,908 offers / 581 confirm events) the confirm-gap distribution is p50 11 offers / p90 68 / p99 230 / **max 434**, and in minutes p50 2.3 / p90 23 / p99 106 / **max 362** — i.e. 6-hour confirm gaps happen with fills resuming fine. At (12, 40) the watchdog fired **143 times in 4 days (~21/day)**, starting 17 minutes after boot. At (30, 250) the same window yields 4. Reconnects are cheap and were NOT the cause of any fill drought (measured p50 0.6s, p90 1.8s, max 3.7s, 0 failures in 143 — costing ~0.1 confirms/day); the real damage was diagnostic, since the log line reads as a PX-side outage. 250 sits just above the p99 with headroom — do NOT raise to the observed max (434/500), that is fitting to the sample. Detection latency for a genuinely dead channel is ~1.5-2h at daytime volume (~150 offers/hr). Read at MODULE LOAD, so a change needs a restart to take effect. |
| `QUOTE_PERSIST_SAMPLE` | No | Default: **0.05**. Fraction of UNFILLED quotes written to `parlay_orders` (deterministic `md5('qp:'+parlayId)` sample; the row carries `meta.persistWeight = 1/rate`). A quote is ALWAYS written once anything happens to it — matched by another SP (`meta.matchedByOtherSp` / `matchedTieUnclaimed`, written by `recordMatchedParlay`), confirmed, rejected, settled — so every join on OUR odds for a parlay someone filled (`/competitiveness`, `/lost-analysis`, `/network-share-*`, `/bid-comparison`) is unaffected. Count-style denominators reweight with `db.quoteRowWeight(row)` (fill-bucket backfill, `/v2-ab-metrics`, `/analytics/hour-of-week`); other analytics that COUNT unfilled quotes from the DB under-count them ~20x for rows written after 2026-10-03, and the post-restart All Quotes table shows only matched + sampled quotes. `1` restores persist-every-quote, `0` persists none. Read per call. |
| `DB_TIMEOUT_MS` / `DB_READ_TIMEOUT_MS` | No | Defaults 8000 / 12000. Hard client-side timeout on every Supabase write / read (was: none — calls hung ~20s to a Cloudflare 522). The response body is read inside the window. |
| `DB_BREAKER_FAILURES` / `DB_BREAKER_WINDOW_MS` | No | Defaults 5 / 60000. Trip on this many CONSECUTIVE outage failures, or this many inside the window that are also >=50% of its requests. Outage failure = network error, timeout, HTTP 502/503/504/520-530. A plain 500 (PostgREST query error, e.g. one heavy analytics query's statement timeout) and 4xx are NOT counted. |
| `DB_BREAKER_OPEN_MS` / `DB_BREAKER_MAX_OPEN_MS` | No | Defaults 60000 / 600000. Open backoff, doubling per consecutive trip (a failed half-open probe, or a re-trip within a max window of closing), capped; resets after staying closed a full max window. |
| `DB_SPOOL_MAX` / `DB_SPOOL_CRITICAL_MAX` / `DB_SPOOL_DRAIN_PER_SEC` | No | Defaults 5000 / 50000 / 20. Retry-spool caps and drain pace. Over `DB_SPOOL_MAX` the oldest DROPPABLE rows go first; critical rows are dropped only past `DB_SPOOL_CRITICAL_MAX` (counted in `droppedCritical`, logged as an error). |
| `DB_BOOT_PROBE_MS` | No | Default 5000. Boot probe deadline; on a miss the breaker is forced open before the ~12 sequential boot hydrations. |
| `DB_DEFERRED_LOAD_MS` | No | Default 60000. First retry of the deferred order merge-load after a DB-down boot (doubles, cap 10 min). |
| `DB_PNL_REFRESH_MINUTES` | No | Default 15 (was a hard-coded 2). Cadence of `refreshDbPnL` — a full paginated read of every settled order for the display-only `/status` `orders.dbPnL`. Skipped while the breaker is open. |
| `LINE_CACHE_FULL_RESAVE_HOURS` | No | Default 6. `saveLineCache` is DIFF-ONLY (only lines new/changed since the last successful save); a full re-save of the index runs at most this often. Skipped while the breaker is open. |
| `SGP_AUDIT_FLUSH_MS` / `SGP_AUDIT_FLUSH_MAX` / `SGP_AUDIT_BUF_CAP` | No | Defaults 10000 / 500 / 5000. `sgp_audit` rows (SGP shadow logging) are buffered by parlay_id and written as one multi-row upsert per flush instead of one request per same-game decline. Droppable; held while the breaker is open. |
| `CREATOR_BLOCKLIST_FALLBACK` | No | Comma-separated creator ids used ONLY when the blocklist cannot be loaded at boot (DB down) and no snapshot file exists; the first real DB load replaces it. Copy the current value from `GET /admin/creators/blocked` -> `fallbackEnv.value`. A Railway env edit restarts the trader — update off-peak. |
| `RUNTIME_CONFIG_FALLBACK` | No | JSON `{ "<runtime key>": value }` applied ONLY when the runtime overrides cannot be loaded at boot and no snapshot file exists; validated through the registry like a POST; superseded by the stored overrides on the first real DB load. |
| `STATE_SNAPSHOT_DIR` | No | Unset = disabled. Directory for automatic last-known-good snapshots of the creator blocklist and runtime overrides (rewritten after every successful DB load/persist, read only on a DB-down boot, preferred over the env fallbacks). **Only useful on a Railway VOLUME** (mount at e.g. `/data`, set `/data`) — the container filesystem incl. `/tmp` is wiped every deploy. Trade-off: a service with a volume loses overlapping zero-downtime deploys (a few seconds down per deploy). |
| `RUNTIME_CONFIG_PERSIST_WAIT_MS` / `RUNTIME_CONFIG_RETRY_MS` | No | Defaults 1500 / 30000. How long `POST /config/runtime` waits for the DB write before responding `persisted:"pending"`, and the background retry cadence for a deferred load/persist. Read at module load. |
| `AUTH_USERNAME` | No | Default: `mike`. Admin username for HTTP Basic Auth. |
| `AUTH_PASSWORD` | No | Admin password. **Auth is OFF when unset** — server is publicly accessible. |
| `AUTH_VIEWERS` | No | Comma-separated `user:pass` pairs for **scaled-down** read-only accounts (e.g., `alice:hunter2,bob:sekret`). Restricted to `AUTH_VIEWER_PATHS`. |
| `AUTH_FULL_VIEWERS` | No | Comma-separated `user:pass` pairs for **full-dashboard** read-only accounts. Can hit every GET endpoint; all mutations 403. |
| `AUTH_VIEWER_PATHS` | No | Comma-separated paths viewers may access. Default: `/edge-vs-fair.html,/viewer,/viewer.html,/status,/orders,/me`. |

## Auth & Read-Only Viewers

Three roles via HTTP Basic Auth (browser-native login dialog):

- **Admin** (`AUTH_USERNAME` / `AUTH_PASSWORD`) — full access to `/` (main dashboard), all admin endpoints, and `/viewer`.
- **Full viewer** (`AUTH_FULL_VIEWERS`) — read-only access to the **full** dashboard (`/`, market intel, lines, reports, all GET endpoints). Every POST/PUT/DELETE/PATCH returns 403. Admin-action buttons (Pause, Refresh Lines, etc.) remain visible but silently fail when clicked.
- **Viewer** (`AUTH_VIEWERS`) — read-only, restricted to `AUTH_VIEWER_PATHS`. Default list scopes them to the scaled-down `/viewer` dashboard plus the two endpoints it polls (`/status`, `/orders`) and `/me`.

**Provisioning:**
- Scaled-down viewer: `AUTH_VIEWERS=alice:correctHorse,bob:battery` — point them at `https://<host>/viewer`.
- Full read-only viewer: `AUTH_FULL_VIEWERS=charlie:correctHorse2,dave:battery2` — point them at `https://<host>/`.

If a username appears in both lists, `AUTH_VIEWERS` wins (more restrictive); a warning logs at boot. Don't reuse usernames between the admin slot and the viewer pools either — collisions are skipped with a warning.

**Sign-out:** HTTP Basic Auth credentials are cached by the browser until the tab/process closes. There is no clean server-side logout.

## Team / game caps (2026-09-26 rework)

- **The bug:** every open QUOTE reserved the full `maxRiskPerParlay` ($6,000) against its team and game keys for 60s, counted ×0.1, so ~10 open quotes darked a team with ~$0 real exposure (Texas dark 13:25–16:00Z on 9/26: 202 network parlays, $38.1K, at <= $240 confirmed). The confirm check ALSO discounted the confirming ticket ×0.1, so the raw "hard" cap was soft (23 team-event keys ended above $6K confirmed in 45 days).
- **QUOTE mode** (`checkExposureLimits` / `checkGameExposure` default): confirmed exposure + in-flight CONFIRM reservations at actual stakes, NO increment, `>=` — a full team/game stops quoting. Quote reservations are not read by any gating cap.
- **Ticket size** is bounded instead by `getExposureHeadroom` → pushed into `priceParlay` candidate caps → the offer's `max_risk` (floored from the PUBLISHED odds, never rounded up). Skipped on the confirm reprice (`skipTemplateRamp`), which must never fail closed on a cap (2026-06-21 outage).
- **CONFIRM mode** (`opts.mode='confirm'`): EXACT — confirmed + other in-flight confirms + the actual ticket, no discount, `>`. `reserveConfirmingExposure` / `releaseConfirmingExposure` mirror the per-line `reserveConfirmingLegRisk`; a reservation stops counting once its order has landed (confirmed + orderUuid) so an acceptUnknown hold never double counts.
- **Game charge** mirrors `recalcNetExposure`: per game, MAX over market:selection buckets of the SUM of risk × P(other legs) — two same-game legs on one bucket land as a sum.
- **Team key** for every reader comes from `exposureTeamLabel` (pricer.js) — full-game totals book as "Over (Away @ Home)"; reading `lineInfo.teamName` ("over") hits a key nothing writes.
- **Double-fill guard for re-quotes:** `template-exposure` has an in-flight confirm lane — a second confirm of the same signature while the first is mid-confirm is rejected (`template_inflight_at_confirm`).
- **Supersede:** a re-send releases the preview quote's exposure + template slots before pricing (same creator, or either creator unknown — PX often omits creator_id). Another SP's fill (`order.matched` other_sp) releases them too. The matched-path loud `[EXPOSURE OVERRIDE]` fires only on a canonical win, not a tie.
- `/debug/pending-game-legs` "live" quote reservations are diagnostic only; decline snapshots now list the in-flight CONFIRMS that filled the game. Locked by `test/team-cap-reservations.test.js` (11 mutants, all killed).
- ⚠ **Scratch/subagent scripts that require these services write to PRODUCTION Supabase** unless run under `node --test` or `NODE_ENV=test` (config.js loads `.env` by absolute path). A review run on 9/26 wrote a fake `tie-pid` order and a runtime override.

## Supabase circuit breaker + retry spool (2026-10-03 outage)

**Incident:** the Supabase project (Small compute, us-west-2) was UNHEALTHY ~13h: 568K API requests/24h (~6.5/s), 162K gateway errors. The trader kept writing — every quote, matched parlay, SGP audit, decline batch, the FULL line_cache every 2-min seed, a full paginated settled-orders read every 2 min — each call hanging ~20s to a Cloudflare 522, so the instance never got room to recover. `POST /config/runtime` awaited the DB and 502'd through Railway's edge; GET hung; a restart booted with an empty blocklist and no runtime overrides.

- **One choke point:** `services/db-breaker.js` is passed to `createClient` as `global.fetch`, so EVERY request — db.js helpers and the ~25 direct `db.getClient()` call sites — gets a hard timeout (8s write / 12s read) and fails FAST while open. postgrest-js turns the thrown fetch into `{ error:{message:'DbCircuitOpen: ...'}, status:0 }`, so existing callers take their existing unavailable path untouched. `isTransientResult(res)` (status 0 or gateway 5xx) is how writers tell "DB unreachable, retry" from a permanent error.
- **States:** CLOSED -> OPEN (5 consecutive, or >=5 and >=50% in 60s) -> after 60s x 2^level (cap 10 min) HALF_OPEN: ONE probe, others fail fast -> success CLOSED (spool drains) / failure OPEN at the next level.
- **Retry spool (in-memory, bounded):** CRITICAL = orders that are confirmed / settled / orphaned / carry an orderUuid or confirmedAt, every `matched_parlays` row, and KV writes flagged `{critical:true}` (only the pause flag). DROPPABLE = sampled unfilled quotes and rejects. One slot per order (the live object, so a replay writes its latest state); a failed replay never clobbers a newer payload; drain is critical-first at <=20 rows/s and the first replay IS the half-open probe. Declines and SGP audits keep their own bounded buffers (held, not dropped, while open; a transient flush failure puts the batch back). The spool dies with the process — a restart while it holds rows loses them; the boot PX reconcile re-derives confirmed/settled orders from PX REST, but spooled matched_parlays rows are lost. `/status` -> `db.spool` shows counts, `droppedCritical`, oldest age.
- **Never spool merged state.** A KV value hydrated from the DB and edited in memory (blocklist, runtime overrides) must not be replayed blind: after a DB-down boot the in-memory copy is partial and the write would CLOBBER the stored value (the 2026-06-26 blocklist clobber class). Those two modules refuse to persist until a REAL read has landed (`loadKVStrict` distinguishes "absent" from "could not read"), keep local edits pending and re-apply them on every load, and retry in the background.
- **Runtime config** (`services/runtime-config.js`) holds overrides in memory: `set()`/`reset()` apply and respond (persist awaited <=1.5s, else `persisted:"pending"`), `list()`/GET never touch the DB. The old set() did a DB read-modify-write — with the DB down its read returned `{}` and the write would have replaced every override with the one key being set.
- **DB-down boot:** `db.bootProbe()` (5s) forces the breaker open before the boot hydrations; `loadOrders` aborts instead of paging 200 pages x 4 retries; order-tracker schedules a deferred MERGE-load (`/status` -> `db.hydration.orders`: `failed-retrying` -> `recovered`) that never overwrites an in-memory order; blocklist + runtime config fall back to the snapshot file (`STATE_SNAPSHOT_DIR`, volume only) else `CREATOR_BLOCKLIST_FALLBACK` / `RUNTIME_CONFIG_FALLBACK`, and merge the DB copy when it answers. The pause flag stays at its boot default (paused) when it cannot be read — check `/status` -> `db.hydration` before resuming after a DB-down restart.
- **Write-volume cuts:** unfilled quotes sampled (`QUOTE_PERSIST_SAMPLE`, 5%); `sgp_audit` batched; `line_cache` diff-only; `refreshDbPnL` 2 -> 15 min. Measure the effect live from `/status` -> `db.breaker.requestsPerMin` and `db.breaker.topEndpoints` (per table + method since boot).
- Locked by `test/db-circuit-breaker.test.js` + `test/db-down-state-resilience.test.js` (real supabase-js client over a fake transport — never the network).

## MLB playoff series (2026-09-28; order-book pricing 2026-10-04)

- **PRICE SOURCE = the order book's series consensus** (`services/mlb-series-consensus.js`, 2026-10-04). Operator: "we should be quoting MLB playoff series prices in between games of the series"; standing: "direct references to the lines of sportsbooks", "use the methodology we use for the order book lines". It replaced the DK-only path after DK moved its MLB series tab (2026-10-04 the `category=futures&subcategory=series-props` URL showed only game lines, so every series leg priced null). Reference, read-only, never run from here: `~/mlb_series_consensus.py` (sources + rules, ported), `~/mlb_series_post.py` `price_pair()` (translated), `~/dk-mlb-series.js` (→ `dk-scraper.fetchMlbSeriesBoard`), `~/bo-mlb-series.js` (ported), `~/mlb_series_sched.py` `team_key`/`pair_key` (ported). On the 2026-10-04 fixtures the JS consensus reproduces `~/cons_mlb_series.json` number for number.
  - **Sources**: DraftKings (headless Chrome via the shared browser-slot governor; FOLLOW THE TAB WHOSE TEXT IS "SERIES PROPS", then `category=postseason&subcategory=series-props[&nav_1=winner]`, then the futures URLs — on 10/04 there was no such tab and the postseason URL served all four Division Series), BetOnline (headless Chrome, `/sportsbook/baseball/mlb-series` page text, only `<Nick> Series Price` rows), Bovada (public JSON coupon `.../baseball/mlb-playoff-series`, group path must contain "Series Prices" and "Playoff Series"). FanDuel, Kambi and TOA carry no series market, so the 3-book floor is met EXACTLY and only when both Chrome scrapes work.
  - **Rules** (per series = pair of clubs, keyed `braves|dodgers`): a book counts once; sides join on the club nickname after the series suffix is stripped (White Sox ≠ Red Sox; a bare "Sox" is no club); an unknown/duplicated/same-club pair is dropped; overround must be in `[SERIES_OVR_LO, SERIES_OVR_HI]`; suspended/closed/live markets skipped; **a ZERO-market scrape is a source ERROR and drops the book at once** (a launch/timeout failure keeps the last read, which ages out); a source older than `SERIES_SRC_MAX_AGE_S` (600) does not count — evaluated at READ time; fair = median per-book PROPORTIONAL de-vig; raw = median raw implied (probability space) → American; fair_lo = least favourable book's fair; DECLINE below `SERIES_MIN_BOOKS` (3, per-pair `SERIES_MIN_BOOKS_PAIRS`) or a fair spread > `SERIES_MAX_GAP_PP` (3).
  - **Pricing = `price_pair()` translated to one parlay leg** (`priceLeg`). The poster backs side O at ask(O) = mirror of −raw(X), so its taker holds X at the books' median raw; in a parlay the bettor takes X and we hold O — the same position. For the bettor's side X: offered `q = imp(raw X)` (`bookPriceOverride`, no vig on top); `q ≥ 1 − clamp(O)` with clamp(O) = min(fair O, fair_lo O), i.e. never better for the bettor than the MOST favourable book's fair for X (poster step 4, `SERIES_WORST_BOOK_CLAMP`); `q ≥ max((fair X + e)/(1+e), fair X·(1+e))`, e = `SERIES_MIN_EV` — the first is exactly the poster's EV-on-its-stake (= our EV per $ risked), the second the operator's stated form; the larger binds (step 5). At e = 1% the floor rarely binds: on a proportional de-vig raw/fair = the book's overround, and step 6 needs ≥ 3% of it; DECLINE when the raw mirror pair sum > `SERIES_MAX_SUM` (97%; step 6 — the post-clamp ceiling cannot bind, clamps only lower our ask); DECLINE side X when our ask on O would be `SERIES_MAX_ASK` (+300) or longer (step 7 — e.g. Dodgers −350: the Dodgers leg declines, the Braves +280 leg quotes). fairProb (EV/risk/exposure) = the median fair. **Not carried over** (ladder/position-only): step 3's odds-banded rung (+1 rung ≥ +150, none +130..149, −1 rung < +130), the tick width floor, long-side hedge sizing, fixed sides, per-side caps. A two-series parlay offers the product of the two mirrors.
  - **RELAY (2026-10-04) — the live source in prod.** Railway cannot scrape DK (blocked, 0 markets) or BetOnline (times out), so our own pass sees Bovada only and every series declines. `~/mlb_series_consensus.py` (the order book's builder, run by `ws_cycle` on the laptop) now also publishes its output to kv_store `mlb_series_consensus` = `{ts, src_ts, series, books_read, errors, min_books, max_gap_pp}` (`_publish_relay`, best-effort, after the file write). While fresh (`MLB_SERIES_RELAY_MAX_AGE_MIN`, 15) the relay IS the consensus — identical books and numbers to the order book, its declines honoured — and the Chrome scrapes are skipped; board time = `src_ts` (oldest counted source). Stale/absent → our own sources. Depends on the laptop poster running. `/status` → `killSwitches.mlbSeries.consensus.relay`. `test/mlb-series-relay.test.js`.
  - **In play = no quote, ever (operator 2026-10-04: "it's very important we not be quoting series prices while games of the given series are in play").** ESPN showing a started game not final keeps the series dark with NO time cutoff (cap `MLB_SERIES_ESPN_LIVE_CAP_HOURS` 18, only so a stuck/postponed record can't dark it for days); the time fallback (`MLB_SERIES_GAME_MAX_HOURS`) applies only when ESPN has no record and is now 8h (was 5).
  - **Warm**: own loop, `MLB_SERIES_WARM_SEC` (300), only while an MLB series line is registered and `mlbSeriesEnabled`; single-flight, every source deadline-bounded; the RFQ path is a sync cache read. Any MLB series leg that does not price fails closed with the consensus reason in `_lastFailure.detail` — never falls through to another source.
- **Dark only while a game of the series is IN PLAY** (`services/series-window.js`; operator 2026-09-29, revising 9/28's "off at Game 1": "It's OK to quote them. We just shouldn't be quoting any while games from them are in play."). A game is in play from first pitch until ESPN (`espn-scores`) reports it final, or `MLB_SERIES_GAME_MAX_HOURS` (5) after first pitch if ESPN can't see it. Games come from the PX series event's own start (PX moves it to the next game) plus every same-matchup MLB game in the index (started ≤12h ago). **After a final, pricing also waits until the series' board post-dates the end by ≥ `MLB_SERIES_RELIST_GRACE_MIN` (5)** — the board time is the **OLDEST source counted for that series**, so one book still showing the pre-game price keeps it dark. Registration gates only on in-play (gating it on board freshness would deadlock the scrape, which runs only while series lines are registered). DK's MLB series `startEventDate` is ROUND-level and ignored. The generic started-event gate is exempt for MLB series lines (their PX start is a past game once the series is under way). Unknown start → closed.
- **Enforced at every index entry point** (seed `_setSeedLine`, Supabase cache restore, on-demand resolve → `mlb_series_closed`) so PX stops sending the RFQ within one seed; `shouldDecline` declines `series closed` and `getSeriesFairProb` returns null (the CONFIRM reprice runs only `priceParlay`, so it closes at the same instant).
- **Name matching**: the consensus resolves a PX line by `pairKey(homeTeam, awayTeam)` and the side by club key, so a lookup is scoped to its own matchup by construction. (DK's legacy lookup for NBA/NHL keeps the 9/28 nickname + board-wide-uniqueness fix: the old last-word fallback matched "Chicago White Sox" to "BOS Red Sox".)
- **Series winner + any leg on a game of the same matchup is BLOCKED** (all sports — ML, total, F5, props): the series is built from those games, so independent pricing is far too generous. Cross-series and cross-sport parlays quote.
- `/status` → `killSwitches.mlbSeries.consensus`: per series the books + prices, fair, raw, fair_lo, gap, decline reason, age and the RFQ quote per side; per source age / counted / error. `test/mlb-series.test.js` (20 tests) + `test/mlb-series-consensus.test.js` (22 tests on real 2026-10-04 DK/BetOnline/Bovada fixtures; 30 of 31 mutants killed, the survivor equivalent).

## RFQ Flow

1. **Startup**: Auth with PX → fetch odds → seed lines (match PX events to Odds API) → connect WebSocket → register supported lines
2. **price.ask.new** (broadcast): RFQ arrives → `shouldDecline()` checks legs known + correlation + exposure → `priceParlay()` gets fair probs, applies vig → `submitOffer()` sends American odds back via callback URL
3. **price.confirm.new** (private): PX asks to confirm → re-validate pricing (5% drift check) → accept/reject
4. **order.matched** (broadcast): Any SP's parlay gets filled — tracked for market intelligence
5. **order.settled** / **parlay.settled** (private): Settlement → P&L recording

## Pricing Logic

- **De-vig**: For each leg, average fair probabilities across sportsbooks using `deVig2Way()` (proportional removal)
- **Parlay fair prob**: Product of individual leg fair probs
- **Offered prob**: `fairParlayProb * (1 + vig)` (makes price worse for bettor)
- **Odds format**: PX uses American odds throughout. `decimalToAmerican()` in pricer.js handles conversion
- **Alt lines**: If RFQ has a spread/total not matching the primary line, fetches alt lines from The Odds API on demand (Pinnacle)
- **Stale check**: Declines if odds cache is older than `stalePriceMinutes`
- **Started check**: Declines if event has already started

## Correlation Rules (pricer.js `shouldDecline`)

- **Blocked**: Spread + moneyline on same game (highly correlated)
- **Blocked**: Two of same market type on same game
- **Allowed**: Spread/moneyline + total on same game
- **Blocked**: 2+ golf legs on the **same player** (`golf_same_player_nested`). Golf outrights are
  perfectly NESTED — win ⊂ top_5 ⊂ top_10 ⊂ top_20 ⊂ make_cut — so `P(win AND top_5) = P(win)`,
  NOT the product. Independent pricing gives 15%×35% = 5.25% vs a true 15% (~3× underprice).
  **The generic SGP/correlation machinery cannot catch this**: it keys on shared `pxEventId`, and
  PX puts every outright market in its OWN event (Winner `1019502362`, Top 5 `1026450813`,
  Make Cut `1080332570`). A golf matchup leg on the same player counts too. Different PLAYERS are
  deliberately allowed — two players can't both win and they compete for finite top-N/cut slots,
  so independent multiplication OVERSTATES those parlays (conservative for us).

## Golf Outrights in Parlays

PX models outrights as an event with `competitors: []` and `sub_type: "outrights"`, where **each
market is one player** with YES/NO selections. They died on line-manager's `!homeComp` check, which
is why no golf outright leg had ever been registered or quoted. Registered via
`_registerGolfOutrightEvent` (gated by `GOLF_OUTRIGHTS_PARLAY_ENABLED`).

- **YES-side only** for win/top_5/top_10/top_20 (operator directive) — the counterparty takes YES.
  The NO lines are never registered, and `shouldDecline` rejects a NO leg as belt-and-braces.
  `make_cut` registers BOTH sides — it's the one market with a real two-sided book quote (make+miss).
- **Pricing basis differs per market — this is the whole ballgame:**
  - `win` — sum of P(win) over the field is EXACTLY 1 (a 72-hole tie goes to a playoff), so the
    book field is **power-normalized to 1.0** → a true fair. Verified field sum 1.01.
  - `make_cut` — binary; **power 2-way de-vig** of make vs miss (see Odds Sources).
  - `top_5/10/20` — **TWO-TIER chain** (`pricer.js` `golfOutrightFair`), not DK-only:
    **PRIORITY 1** = the operator's DK "(Including Ties)" paste / scrape board (`golf-topn.js`);
    **PRIORITY 2** = DataGolf, **RESTORED 2026-07-30** (operator directive: quote outrights for
    every tournament from a reliable source — DataGolf carries 11-14 books per market pre-tournament,
    which neither the Railway-blocked DK scrape nor a manual paste can match).
    The 2026-07-18 removal was about **BASIS, not reliability**, and that basis is now corrected
    inside `datagolf.fetchOutrightBoard`: top-N is power-normalized to `N × GOLF_TOPN_TIES_UPLIFT`,
    **default 1.27, ON by default** (not opt-in — uncorrected, our YES price is ~25% too cheap and
    we lay the NO, so the gap is our loss on every ticket). 1.27 is measured: T(top_5)=6.35 vs
    nominal 5 is exact; 10×1.27=12.70 sits ~3% ABOVE the measured T(top_10)=12.32 — deliberately the
    safe direction. `GOLF_TOPN_TIES_UPLIFT=0` falls back to raw consensus.
    ⚠ So `/golf-topn` reporting `priceable:false` does **NOT** mean top-N is dark — it describes
    PRIORITY 1 only. Verify tier 2 before declaring an outage (2026-08-21: `/golf-topn` was 50h
    stale with Chromium failing to launch on Railway, and outrights were quoting fine off DataGolf).
    The reason DataGolf can't be used **raw** still stands: it CONVERTS book odds to DEAD-HEAT rather than relaying the
    book's posted price. Proven on The Open, same book/market/moment — Scheffler "Top 5 (Including
    Ties)" on DK's site **+144 (41.0%)** vs DataGolf's `draftkings` top_5 **+178 (36.0%)**; field
    sums DK-site **7.96** vs DataGolf **6.27** (nominal 5); top_10 **14.54** vs **11.80**. All ~150
    players ran 23-27% low = a systematic UNDERPRICE. (`dead_heat=yes|no` is NOT a toggle on that
    endpoint — verified identical.)
    ⚠ A "conservative RAW consensus" is NOT a workaround — raw is only conservative relative to the
    SAME basis; on a dead-heat basis it still lands ~25% BELOW ties-included truth.
    **De-vig target is DERIVED, not guessed** (guessing biases toward underpricing): a dead-heat
    field sums to EXACTLY N by construction, so `book_overround = dead-heat RAW sum ÷ N`; overround
    is a property of the book's pricing, not the tie convention, so
    `T = ties RAW sum ÷ book_overround` = the true ties-included field sum. Measured on The Open:
    T(top_5)=**6.35**, T(top_10)=**12.32** — ties add ~1.35 players at top-5 and ~2.3 at top-10, and
    ties being commoner deeper is an independent check that the derivation is sound. Both sums must
    come from the SAME player intersection. `datagolf.fetchDeadHeatAnchor()` supplies the anchor.
    (Until 2026-07-30 the anchor was the only sanctioned use of DataGolf top-N data — "a calibration
    constant, never a price". That is no longer true: PRIORITY 2 prices top-N off DataGolf directly,
    with the same dead-heat gap corrected by `GOLF_TOPN_TIES_UPLIFT` instead of a per-event anchor.)
  - **Coverage**: DK served Winner + Top 5 + Top 10 for The Open but **no Top 20 / no Make Cut**.
    ⚠ **Registration is deliberately NOT gated on the board being warm** (gate REMOVED 2026-07-15).
    The old rule — "a top-N line is registered ONLY when its DK board is loaded, so PX can't send a
    leg we'd decline" — was actively harmful: the DK scrape takes ~150s while seeds run every ~2min,
    and `seedAllLines` is **build-then-swap**, so skipping a line DELETES it from the live index.
    Top-N registration FLAPPED on every boot and scrape hiccup, PX stopped sending those RFQs, and
    it surfaced as "we aren't quoting Top 5". **A missing line is far worse than a declined RFQ** —
    a decline costs one RFQ; a missing line costs the whole market and churns PX's supported set.
    Registration means "PX may ask us"; PRICING decides whether we answer, and it fails closed
    (`getTopNFairProbSync` returns null on a cold/stale/absent board). make_cut is the same shape:
    all ~156 players register though only ~97 can price. **Do not "fix" this by de-registering
    stale lines.**
  - **DK scrape is ~142s (Puppeteer)** → background warm on `GOLF_TOPN_TTL_MIN`, sync cache read on
    the hot path. Cold-start is by design: first seed registers win/make_cut only; the next seed
    picks up top-N. `golf-topn.js` also refuses if DK's market name doesn't literally say
    "Including Ties" (the scraper's loose `/top[\s-]?5\b/` would otherwise match a dead-heat board)
    and if the derived uplift falls outside [1.0, 1.6].
- **Fails closed**: cold/stale board, unknown player, or <2 books → `null` → decline.
- Fair lookup is a **sync cache read** on the RFQ hot path (`getOutrightFairProbSync`); boards are
  warmed at line-seed time by `warmGolfOutrightBoards()`.
- **PX event names carry a market suffix** ("2026 The Open - Tournament Winner") but DataGolf's
  `event_name` is the tournament alone ("The Open Championship"). line-manager stores
  `tournamentName` = the part before the first " - ". Skip that strip and EVERY leg fails the
  event-name match and silently declines.

## Odds Sources

- **The Odds API** (`api.the-odds-api.com`): **the primary odds source.** Also used on-demand for alternate spread/total lines (Pinnacle, DK, FD). Which sports take the TOA-primary path is governed by `TOA_PRIMARY_SPORTS`.
- **SharpAPI** (`api.sharpapi.io`): **DECOMMISSIONED** (subscription cancelled 2026-06-25). Formerly primary for NBA/MLB/NHL/tennis/soccer. Every call-site is behind `_sharpEnabled()` (`odds-feed.js:503`) and issues no request unless `SHARPAPI_ENABLED='true'`. Do not describe it as a live source or plan around its coverage.
- **DK World Cup props scraper** (`scripts/dk-wc-props.js`): NEITHER API above carries
  DraftKings for soccer player props (shots/SoT/goalscorer/assists — BetRivers/FanDuel only,
  and they diverge badly from DK). This scraper pulls them straight off the DK site:
  `node scripts/dk-wc-props.js <away>-vs-<home>/<eventId> [outFile]` → JSON
  `{goalscorer:[{player,seo,odds}], sot:[{player,seo,one,two}], assists:[{player,seo,odds}]}`.
  Find event slugs/ids with `scripts/_dk_find_events.js` (lists `/event/...` links from DK's
  `world-cup-2026` league page). How it works: DK's JSON API is Akamai-gated (403 to vanilla
  clients) and CORS-locked, so headless Puppeteer loads the event page to pass the JS
  challenge, then passively intercepts the `eventSubcategory/v1/markets` XHRs the SPA fires;
  prop tabs lazy-load, so it clicks each subcategory `<h2>` by exact title (clicking the
  container div does nothing). Subcategory ids (per-league, may rotate — re-recon if a market
  comes back empty): goalscorer 16604, SoT 16861, shots 16868, assists 16863. Odds are
  American strings normalized to ASCII (DK serves U+2212 minus); `seo` carries the accented
  real name (e.g. "Vinícius Júnior") — use it for name-matching to PX. Ground-truth validated
  2026-06-11: 254/256 exact vs hand-typed DK boards (the 2 diffs were live line movement).
  Used by the WC NO-posting routine (anytime goalscorer / 1+ & 2+ SoT / 1+ assists mirrors).
- **DK golf outrights scraper** (`scripts/dk-golf-outrights.js`): same Puppeteer/intercept
  technique for golf. Golf tournaments are DK **leagues** (`/leagues/golf/<slug>`), not events;
  the league page's default load fires one `league/leagueSubcategory/v1/markets` XHR carrying
  all three outright boards. `node scripts/dk-golf-outrights.js rbc-canadian-open [out.json]`
  → `{winner,top5,top10}` as `{player,odds}` ("(Including Ties)" variants, ASCII-normalized).
  **Serves NO cut market** — make_cut is DataGolf-priced (below).
- **DataGolf make-the-cut** (`services/datagolf.js` → `fetchMakeCutBoard`/`dryRunMakeCut`):
  the ONLY source for golf make_cut. Endpoint `/betting-tools/outrights`. Gotchas:
  - `market=make_cut` = MAKE (YES); **`market=mc` = MISS (NO)** — they are the two sides of
    one 2-way market, NOT aliases. Verified: both sides sum to 105-109% per player. Treating
    `mc` as the make side inverts every price.
  - **Dead-heat objection does not apply.** Top 1/5/10/20 are priced off DK
    because DataGolf settles dead-heat while PX settles ties-included (PX names those events
    "Top 5 Finish (Ties Included)"). Make-the-cut is **binary** — no dead heat — and PX's
    event carries no ties qualifier ("2026 The Open - To Make The Cut"). DataGolf is valid here.
  - **Power (odds-ratio) de-vig, never proportional.** Cut boards are mostly heavy favorites and
    books load the whole overround on the cheap miss side, so proportional de-vig underrates
    favorites by ~4pp (Scheffler 84.2% vs a true ~89). Measured vs DataGolf's model baseline:
    proportional favs **-4.15pp** / power **-0.83pp** / shin -2.12pp. Power lands -0.53pp over 118.
  - **Pinnacle (1/156) and Bovada (0) are NOT usable** for this market despite being sharp
    elsewhere. DK/PointsBet cover ~155 but **make-side only** (no miss → no 2-way de-vig).
    Real two-sided books: bet365 115, betway 99, unibet 87, williamhill 68, betmgm/fanduel/
    skybet ~46, betonline 41. `GOLF_MAKE_CUT_MIN_BOOKS` (default 2) drops 1-book noise.
  - **PRICE DIRECTION IS INVERTED vs the DK path.** `offered_implied` is the YES price a
    counterparty pays and default `post_side='no'` LAYS the player, so the lay is +EV only
    while `offered_implied > fair`. DK's `dk_implied` is a RAW vig-inflated price so
    `×(1 - sweetener)` still lands above fair; DataGolf hands back a **de-vigged fair**, so
    make_cut uses `fair × (1 + GOLF_MAKE_CUT_VIG)` instead. Applying the DK sweetener to a
    fair would make every lay -EV. Read `price_source` before interpreting `dk_implied`.

## Team Name Matching (line-manager.js)

PX and odds APIs use different team names. Matching strategies (in order):
1. Override map (`TEAM_NAME_OVERRIDES` — NHL abbreviations like WAS, CBJ, MTL)
2. Exact normalized match
3. Substring containment
4. Last N words match (e.g., "Red Sox" matches "Boston Red Sox")

**College (`/ncaa/` sport keys)** goes through `_collegeAnchoredMatch`: a bare PX
school name ("Alabama") must be a word-anchored PREFIX of the candidate, the
shortest remainder wins ("Oregon Ducks" over "Oregon State Beavers"), an
unanchored lone substring is REFUSED ("Houston" ≠ "Sam Houston State"). **A tie on
remainder length is resolved by QUALIFIER (2026-09-10)**: "Alabama" vs "Alabama
Crimson Tide" AND "Alabama State Hornets" is +2/+2, and it used to fail closed —
that single tie left East Carolina @ Alabama dark for **$116K of network fills on
9/5**, with Illinois (Illinois State) and Louisiana (Louisiana Tech) failing the
same way whenever the derivative school is on the week's board. The tie now goes
to the ONE candidate whose remainder carries no qualifier token (`state`, `tech`,
`a and m`, directional prefixes, `city`, `college`, …); two bare mascots (Carolina
Panthers / Hurricanes) or two qualified names stay ambiguous → null. The
shortest-remainder rule outside a tie is untouched. `test/college-team-match.test.js`.
⚠ The event_match_gap on football was **$1.03M/wk** (9/3–9/9), almost all of it
on 9/5–9/6 before the anchored matcher deployed; re-measure on Saturday 9/12.

**MLB "Total Hits, Runs & RBIs"** (PX's live phrasing, comma + ampersand) was
classified `hitter_other` and its player name came back mangled — **$224K/wk** of
network fills declined as unknown legs although `baseball_mlb.hitter_hits_runs_rbis`
was on the allowlist. Both the classifier and the extractor now accept `,`/`&`/`+`/
`and` between the three stats.

## API Endpoints (Express)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Railway health check (always 200); `db` = breaker state + spool counts |
| `/status` | GET | Full service status JSON; `db` = circuit breaker, retry spool, write volume, DB-down boot hydration state |
| `/orders` | GET | Recent orders with P&L |
| `/market-intel` | GET | All matched parlays across SPs |
| `/refresh-odds` | POST | Manual odds refresh |
| `/refresh-lines` | POST | Manual line re-seed |
| `/pause` | POST | Stop responding to RFQs |
| `/resume` | POST | Resume RFQ handling |
| `/reconnect` | POST | Force WebSocket reconnect |
| `/odds-events` | GET | Debug: cached odds events |
| `/lines` | GET | Debug: registered line index |
| `/confirm-activity` | GET | Confirm→fill conversion health. **First stop on any fill-drought**: `error` bucket > 0 = confirms throwing in the handler; `received` flat = channel/volume. |
| `/recent-rejects` | GET | Last ~100 confirm-time rejections with reasons |
| `/wc-props` | GET | World Cup soccer player-prop visibility: registered counts by market, price source, freshness, active allowlist entries |
| `/sgp-experiments` | GET | SGP experiment panel: per-combo dark/budget/stop-loss state, prop game-script exposure, PX submit-errors by combo |
| `/sgp-experiments/reset` | POST | Clear a combo's auto-dark state after reviewing a stop-loss breach (`{combo:"prop_nested"}`) |
| `/ufc-mov` | GET | UFC method-of-victory board (`source` = bovada/dk). Bovada: per fight the straight YES quotes, 6-way Shin fairs, `eligibleYes` (≥ floor, in window), `refusals`, age, `priceable`, plus `registeredLines` — every MoV line in the index with its live quote or refusal reason. **First stop when a MoV leg won't quote.** `?force=1` kicks a fresh fetch. |
| `/golf-topn` | GET | DK ties-included Top 5/10/20 board state + the DERIVED tie uplift per market. Diagnose with: missing slug = add `GOLF_DK_SLUG_MAP`; empty `markets` = DK isn't serving that board; stale `ageMs` = scrape failing. ⚠ **This reports PRIORITY 1 ONLY.** `priceable:false` does NOT mean top-N is dark — DataGolf is priority 2 and quotes fine on its own. To test whether outrights actually price, call `datagolf.getOutrightFairProbSync(player, marketType, tournament)` after a warm, or read `basis` on a live quote. |
| `/prop-correlation` | GET | Live-calibrated same-game prop correlation factors from `prop_settlements` (realized joint win-rate ÷ product of marginal leg rates) + bettor-edge-vs-price. `?days=60&minN=8` |
| `/settle-props` | POST | Settle finished MLB hitter-prop parlays vs box scores into `prop_settlements` now (`{sinceDays?:14, dryRun?:false}`). Daily job does this when `PROP_SETTLEMENT_ENABLED=true`. |

## Database (Supabase)

- **parlay_orders**: Our quotes, confirmations, settlements, P&L
- **matched_parlays**: All matched parlays across all SPs (market intelligence). NOTE: `.outcome` only records `missed`/`other_sp` — it does NOT carry the game result, so realized prop outcomes come from `prop_settlements` instead.
- **prop_settlements**: Realized box-score outcomes for MLB hitter-prop parlays (services/prop-settlement.js, from the free MLB Stats API). Drives same-game prop correlation calibration. Run `migrations/prop_settlements.sql` once, then enable `PROP_SETTLEMENT_ENABLED=true`.
- Upserts on `parlay_id` for orders

## Soccer Specifics

- **Champions League (`soccer_uefa_champs_league`) is TOTALS-ONLY** via `SPORT_MARKET_ALLOWLIST` (2026-09-09). The
  `_qualification` key TOA retired after the qualifiers; the league phase is a separate active key that odds-feed
  already maps. Adding it without the market gate would have quoted DNB/spreads on the heaviest favourites in
  soccer — the exact shape that lost in June.
- **PX soccer moneylines are 2-way draw-no-bet** ("Moneyline (2 Way)" — draw refunds). Sportsbooks post soccer ML as 3-way (draw loses) — a **different product**. Our DNB quotes correctly sum to ~100% across the two teams and look "narrow" next to 3-way book prices; PX's separate "<Team> to Win (90 Min)" YES/NO markets are the 3-way equivalents. Verified 2026-06-11: our quotes sat inside PX's own DNB order book while DK/FD 3-way prices differed by 100+ points.
- **World Cup player props** (anytime goalscorer, shots-on-target 1+/2+, assists): PX posts them as lineless YES/NO markets ("<Player> To Score a Goal", "<Player> To Have At Least 1 Shot On Target", "<Player> To Give Assist"). They register through the standard TOA prop pre-seed (line-manager `_classifySoccerProp`) against TOA's `soccer_fifa_world_cup` key (FD/DK/BetRivers), **YES side only**, priced book-mirror (raw posted consensus × (1 − `PROP_BOOK_MIRROR_SWEETENER`)). Launch-gated by `PROP_LAUNCH_ALLOWLIST` keys `soccer.goalscorer`, `soccer.sot_1`, `soccer.sot_2`, `soccer.assists`. TOA anytime outcomes carry **no point** and use side name **"Yes"** (not "Over").
- **BTTS ("Both Teams To Score")** — MLS. Two independent traps, either of which alone yields **zero** BTTS lines:
  1. **PX types BTTS as `moneyline`**, identical to the real ML and to the 3-way "<Team> to Win (90 Min)" markets (probe 2026-07-16: BTTS id=1318 type='moneyline'; "Moneyline (2 Way)" id=11 same type). So the `marketType === 'btts'` branch in `parseMarketSelections` was **unreachable dead code** — PX never sends that type. Detection is by NAME (`BTTS_MARKET_RE`), and the seed's `fullGameNames` allowlist needed a carve-out too (it demands a type='moneyline' market be NAMED like a moneyline). Before the fix this parsed as a moneyline with `selection:'unknown'` and survived only because team-matching "YES" against the competitors failed — i.e. it was safe **by accident**, and the failure mode had it registered would be pricing BTTS off the team moneyline.
  2. **TOA serves `btts` ONLY on the per-event endpoint.** The bulk `/odds` endpoint 422s (`Markets not supported by this endpoint: btts`) — the same gotcha as team_totals/F5/H1. The bulk parser scanning for `m.key === 'btts'` therefore never matched. `ensureBtts` / `supplementBtts` mirror the `ensureTeamTotals` pattern (timeout-bounded, single-flight, TTL, fail-closed), plus a line-manager pre-seed per game for the same reason team_totals has one: relying on the background supplement alone leaves the cache empty and every RFQ declines "no fair value".
  - Coverage: 8 two-sided books (**pinnacle + matchbook are eu-region — do NOT drop to regions=us**). Fair = per-book 2-way de-vig, averaged; `BTTS_MIN_BOOKS` (default 2) drops 1-book noise.
  - **The TOA key rate-limits by request FREQUENCY** (429 `EXCEEDED_FREQ_LIMIT`), separate from quota. An unpaced fan-out 429'd ~30% of the slate — and a 429 reads as *"this game has no BTTS"*, not as an error. Hence `BTTS_FETCH_SPACING_MS`, the serial loop, the events-list pre-warm, and: **transient (429/5xx) failures are never cached as misses**. If attach ratio drops, read the `(N transient fetch failures)` suffix on the `btts supplement:` log line before blaming book coverage.
  - Same-game BTTS combos (BTTS+ML, BTTS+total, and the impossible BTTS yes+no) classify as `unclassified` and are **declined** by the existing SGP gate — correct, since BTTS is correlated with both ML and totals. Only cross-game BTTS parlays quote.
  - **BTTS YES is usually a favourite** (~62%), so a *single* YES leg trips the negative-odds guard (`allowed only for all-golf-outright parlays`) and declines. YES quotes fine inside a multi-leg parlay; NO quotes standalone.

## UFC Method of Victory (parlays)

PX posts **FOUR** per-fighter markets per fight, all typed `moneyline` with YES/NO
selections (the BTTS trap again — probe 2026-07-17, Usman/Du Plessis):

| PX market name | marketType | PX market id |
|---|---|---|
| `<Fighter> To Win By KO/TKO/DQ` | `mov_ko` | 1060xxxxx |
| `<Fighter> To Win By Submission` | `mov_sub` | 1020xxxxx |
| `<Fighter> To Win By Decision` | `mov_dec` | 1070xxxxx |
| `<Fighter> To Win Inside The Distance` | `mov_itd` | 1050xxxxx |

**ORDER-BOOK METHODOLOGY (operator directive 2026-10-03, verbatim):** "We should be
quoting (1-sided) UFC MoV lines. Use the methodology we use for the order book lines."
Standing principle: "I don't want to derive any of our own lines; I want ours to always be
direct references to the lines of sportsbooks, adjusted as we may choose." Reference
chain (read-only, never run from here): `~/ufc_mov_board_bov.py` (stager: source, parse,
floor, fair) → `~/ufc_mov_post.py` (poster) ← `~/dwcs_mov_cycle.py` (`MOV_FLOOR=-300`);
`px_post_client.devig_n_shin`. Implemented in `services/bovada-mov.js` behind
`MOV_SOURCE=bovada` (default; `dk` = the legacy DK path below, wholesale).
- **Source = Bovada's public coupon JSON** (`/services/sports/event/coupon/events/A/description/ufc-mma?marketFilterId=all&preMatchOnly=true`),
  plain HTTPS, no Puppeteer, ONE call per refresh — the coupon carries the full per-event
  market set (verified 2026-10-03 identical to the per-event v2 endpoint the stager walks).
  Warmed in the background each line seed (TTL 120s, single-flight, 15s timeout); the RFQ
  path is a sync cache read. Single book, accepted by the operator — so the parser
  **refuses** anything ambiguous rather than guessing.
- **ONE-SIDED: YES only.** The poster lays the NO at −(Bovada YES); in a parlay the
  counterparty takes YES and we hold the NO — the same position. NO lines are refused at
  every index entry point (`_movRefusal`: seed `_setSeedLine`, Supabase cache restore,
  on-demand resolve — the last is defensive, the on-demand path has never resolved MoV)
  and `shouldDecline` declines a stray NO leg (`mov_no_side`).
- **Eligibility = the poster's:** YES ≥ `MOV_RFQ_MIN_YES_ODDS` (+300 ⇔ NO ≤ −300), fight
  within `MOV_RFQ_WINDOW_H` (26h), an unambiguous straight quote. **Registration** refuses
  only on deterministic evidence (NO side, outside the window, a board that SAYS the YES is
  below the floor or the quote is refused/ambiguous); a cold or very old board, or a fight
  Bovada hasn't posted props for, REGISTERS and pricing fails closed — the golf top-N
  build-then-swap lesson. The floor is real price state, so a YES crossing +300 does
  (de)register on the next seed — exactly as the order book posts/cancels.
- **PRICE = direct mirror:** the leg's offered prob is Bovada's raw YES implied
  (`bookPriceOverride`, bypasses vig; `MOV_BOOK_MIRROR_SWEETENER` default 0). An all-MoV
  parlay offers the product of the mirrors (Parkin KO +300 × Kopylov KO +475 → +2200).
  Floored at fair (`MOV_MIRROR_FLOOR_AT_FAIR`).
- **FAIR (EV / risk / exposure only):** the stager's 6-way n-way **Shin**
  (`devigNShin`, exact port — pinned to values computed by `px_post_client.devig_n_shin`)
  over KO/SUB/DEC × 2 fighters, normalized to 1.0; **ITD fair = KO + SUB**. A fight missing
  any of the six has no fair and its legs DECLINE (`mov_no_fair`) — the poster posts
  without a fair, a parlay cannot size risk without one.
- **Parsing (stager `method_of`)**: KO = "Wins by KO, TKO or DQ" (tokenised — the comma
  case), SUB, ITD = Bovada's own "Wins Inside Distance" quote mirrored onto PX's
  `fighter_to_win_by_any_knockout_submission_dq` (a direct quote, not derived), DEC = a bare
  "by Decision" if present, else **Unanimous + Split/Majority summed** (the stager drops
  "Decision or Technical Decision" for the word *technical*; on 10/03 Silva's bare quote was
  EVEN while UD+SMD summed to 60% — we mirror the stager). Dropped: round-specific, "Fight
  Winner - … Only" (conditional), Double Chance, technical decisions, suspended outcomes.
  **Duplicate quotes that disagree → refused, never averaged.** Three tightenings vs the
  stager, each only turning a quote into a refusal: **Bout Specials markets excluded
  outright** (the stager drops them from the fair only); the ITD-composite test reads `ko`
  as a **token** (the stager's substring test classified "Roman Kopylov Wins by Submission"
  as ITD on the 10/03 card); fighter attribution needs a **unique** winner.
- **PX side**: `parseMarketSelections` refuses a MoV market whose `sub_type`
  (`fighter_to_win_by_*`) disagrees with its NAME (Connor/Guaylupo 2026-09-22), reads the
  side from the selection NAME exactly (PX inverts the ids on decision only) and refuses a
  market with two YES or two NO selections.
- **Names**: the bout is resolved from BOTH PX competitors; full-name signature or token
  subset, or a **surname unique in that bout** (poster 10/03: Bovada "Michael Parkin" = PX
  "Mick Parkin"), with at least one fighter matching on more than a surname; a shared
  surname never matches on surname alone (Abus/Shara Magomedov); two matching bouts →
  `mov_fight_ambiguous`; PX's U+FFFD mojibake is a one-char wildcard on the surname.
- Locked by `test/bovada-mov.test.js` (real Bovada fixture
  `test/fixtures/bovada-ufc-coupon-2026-10-03.json`; 24 mutants, all killed).

**LEGACY DK PATH (`MOV_SOURCE=dk`)** — kept intact, no longer the default price source:
- **SharpAPI's method_of_victory feed is DEAD** (2026-07-11) and returns an EMPTY
  board rather than erroring — anything built on it fails SILENTLY. DK is the only
  source (`dk-scraper.fetchUfcMethodOfVictory`, ported from the operator's
  standalone so it deploys). DK's API is Akamai-gated AND CORS-locked: passive
  Puppeteer interception is the ONLY path — never call the API directly.
- **The fighter only exists in the market NAME** — the selections are literally
  YES/NO. `parseMarketSelections` parses it out into `playerName`. Do NOT team-match
  the fighter to a competitor: that resolves to home/away and the pricer would read
  the leg as a straight moneyline.
- **De-vig the whole 6-way, never one fighter's 3 methods.** The vig lives across
  all six outcomes (2 fighters x KO/SUB/DEC); DK's six sum to ~110-120% (measured
  119.7% on Du Plessis/Usman). Target is `1 - MOV_DRAW_PROB`, not 1 — the draw is a
  real 7th outcome DK never prices. **Power** de-vig, not proportional: the board
  spans +110 to +3500 and proportional underrates the favorite (measured -4.15pp on
  the same-shaped golf make-cut board), which means quoting its YES too CHEAP.
- **ITD is DERIVED**: `P(A inside distance) = P(A by KO) + P(A by SUB)` exactly
  (mutually exclusive). DK has no ITD market, and a composite from another book is a
  known trap ("KO/TKO, DQ or Submission" once masqueraded as a -115 submission vs a
  real +325).
- **MoV legs may NEVER be parlayed same-fight** (`mov_sgp_blocked`, operator
  directive). Every method pair on one fight is mutually exclusive (Usman by KO +
  Usman by SUB can't both happen; only one fighter wins at all) or nested (ko ⊂ itd;
  mov ⊂ moneyline), so independent multiplication prices a P=0 parlay as if it were
  live. This is an **explicit, unconditional** pre-pass in `shouldDecline` that does
  NOT rely on the generic SGP gate: that gate blocks these today only because no key
  in `SGP_ALLOWED_COMBOS` happens to match a MoV pair — incidental protection that
  evaporates the moment someone adds a combo key. It blocks a MoV leg against ANY
  other leg on the same `pxEventId` (other MoV, moneyline, total rounds, either
  side). Locked by `test/mov-sgp-block.test.js`, including adversarial cases that
  force MoV combos INTO `SGP_ALLOWED_COMBOS` and assert it still declines. Only
  CROSS-fight MoV parlays quote.
- **No odds-range limits** (operator directive): all-MoV parlays bypass `MAX_ODDS`
  entirely and use `MOV_MIN_PARLAY_PROB` (default 1e-6) instead of the 0.1% floor.
  Both gates require EVERY leg to be MoV so a method leg can't smuggle a mixed
  parlay past the normal caps. The NaN guard is never relaxed. ⚠ This lets two deep
  tails quote at **+131,516** and three at **+4,047,488** — if PX's odds ladder
  rejects those (it reportedly caps near ±25000), they'll surface as submit errors,
  not bad fills.
- **Name matching**: surnames COLLIDE (one card had BOTH Abus and Shara Magomedov,
  and surname keying stamped one's prices onto the other). Key on a sorted-token
  signature of the FULL name; token-SUBSET fallback tolerates middle names
  (DK "Jose Delgado" = PX "Jose Miguel Delgado") while still failing closed on the
  Magomedov case. Lookups are scoped to ONE fight by passing both competitors.
- **`/ufc-mov`** = first stop when a MoV leg won't quote (board age, per-fight
  fairs, `priceable`). `?force=1` kicks a fresh scrape.
- Prelims often carry NO method markets — 0 prices on an undercard fight is normal,
  not a scrape failure. A fight missing any of its 6 outcomes fails closed.
- **DK segregates MMA by league page** (found 2026-08-11): `/leagues/mma/ufc`
  carries numbered cards ONLY — Tuesday **Dana White's Contender Series** lives at
  `/leagues/mma/dana-white's-contender-series`, and the UFC page silently returns
  zero of its fighters. **FIXED 2026-08-11 (c70f599)**: `dk-scraper._movLeagueUrls()` now scrapes
  BOTH the UFC page and the Contender Series page
  (`.../leagues/mma/dana-white%E2%80%99s-contender-series` — note the
  **typographic apostrophe** `%E2%80%99`, not an ASCII quote; the ASCII slug
  404s). Verified live 2026-08-18: all 5 Tuesday CS fights priceable on the MoV
  board. A CS fight now fails closed only for the ordinary reasons (PX posts no
  method markets for it — common on prelims — or the board goes stale).
- **A standalone operator routine posts single-market MoV NO lines** on PX
  (now the Bovada stager above; offers tagged `claude_mov_`, DWCS $2,000 flat). Those
  positions are INVISIBLE to this trader's exposure tracker — and since 2026-10-03 the
  RFQ book holds the SAME NO on the same outcomes, so a parlay MoV fill stacks risk on
  top of the order-book lay with no shared cap. PX also
  frequently lacks DEC markets that DK prices (10/10 skipped 2026-08-11).

## Football Player Props (parlay legs)

Opened 2026-09-07 (operator directive). Sourced under the SAME rules as the
single-leg props scheduler (`~/cfb_props_cycle.py`), because those rules exist
in response to being picked off on this exact market last season.

**MIRROR THE ORDER BOOK (operator directive 2026-10-01, verbatim):** "For NFL/CFB
RFQs we need to be pricing all markets we are for the PX order book. Refer to what
we're listing there and how we are pricing them and use the same methodology for
RFQs." The reference posters (outside this repo, run from `poster-service`): NFL
props + TD scorers = `nfl_game_cycle.py` (`PROPKEY`/`TDKEY`, the laptop
`NflPropsCycle` is disabled); CFB props + anytime TD = `cfb_props_cycle.py`
(laptop `CfbPropsCycle`, `--tminus 120 --minbooks 3`); game lines =
`nfl_pre_post.py` (NFL full game via `nfl_cycle.py`; CFB everything via
`cfb_cycle.py --profile cfb`) and `nfl_game_cycle.py` (NFL 1H/1Q/team totals).
What the RFQ book now copies (`test/football-poster-mirror.test.js`, 14 mutants killed):
- **Markets:** the four NFL families the RFQ book lacked — Total Passing & Rushing
  Yards (`player_pass_rush_yds`; PX writes an ampersand, so the classifier
  recognises the phrase BEFORE the composite guard), Total Passing Attempts
  (`player_pass_attempts`), Total Rushing Attempts (`player_rush_attempts`),
  Longest Pass (`player_pass_longest_completion` — `player_pass_longest` 422s) —
  plus **Last TD** (`player_last_td`, closed field, YES-only mirror like first TD;
  added to `CLOSED_FIELD_ONE_SIDED_MARKETS`' default and the novelty carve-out).
  All need `PROP_LAUNCH_ALLOWLIST` keys (`pass_rush_yards`, `pass_attempts`,
  `rush_attempts`, `longest_pass`, `last_td`).
- **Fair:** `FOOTBALL_PROP_FAIR_METHOD=poster` (default) and the anytime-TD field
  fair (`FOOTBALL_ANYTIME_TD_FIELD_T`) — see the env table.
- **Windows:** `FOOTBALL_PROP_WINDOWS=poster` (opt-in; prod sets
  `FOOTBALL_PROP_TMINUS_MINUTES=1440`, far wider than any poster window).
- **Availability:** `FOOTBALL_PROP_INJURY_GATE` (default on, fail-open).
- **On-demand = seed.** The on-demand bridge used the GLOBAL prop floor (2), the
  trusted-single-book bypass, no prop window and no one-line rule, so RFQs
  registered football alt points the seed refuses (prod 10/01: 18 of 108 NFL prop
  markets carried 2–6 points). It now applies the football floor (absolute), the
  window, the ESPN gate and the best-booked-point rule (`_footballBestPropPoint`,
  shared with the seed).
- **Deliberately NOT mirrored:** the poster's single-leg PRICE (raw opposite-side
  mirror + 1-rung sweetener + 16/18-tick widen + `band()`) — parlay legs keep
  offered = fair × (1+vig) with the consensus floors; the TD **NO** side and the
  −300 listing floor (the posters list NO, which is the SAME position as our YES
  leg — we hold NO either way — so the RFQ YES leg already covers it; the −300 floor
  is a variance choice on single-leg size); the per-side (one-sided) book count
  (RFQ keeps ≥3 books with BOTH sides); game-line fair methodology (posters: sharp
  Pinnacle/composite anchor + median consensus at the MAIN number only; RFQ keeps
  its consensus builders — on CFB the consensus floors set ~82% of prices anyway;
  the alt LADDERS were dropped 2026-10-01, see `FOOTBALL_GAME_MAIN_ONLY`); full-game ML/spread/total is NOT listed by the NFL
  game board (`nfl_game_cycle` drops it as too narrow) but IS by `nfl_pre_post`.

- **TOA coverage is MEASURED, and the old comment claiming otherwise was wrong.**
  Live 2026-09-07, us region, one NFL + one NCAAF event —
  `player_pass_yds` NFL 6/6 two-sided, NCAAF 3/3; `player_pass_tds` 6/6, 3/3;
  `player_reception_yds` 6/6, 3/3; `player_rush_yds` 6/6, NCAAF 2/2 (thin);
  `player_receptions` NFL 6/5, NCAAF absent. The map had carried `anytime_td`
  ALONE on the claim of "ZERO player_* keys for NCAAF".
- ⚠ **The TD markets are ONE-SIDED at every book** — `player_anytime_td` 8 books
  and not one prices the "no"; `player_1st_td` 7 books, same. They cannot be
  2-way de-vigged, so BOTH take the lineless YES-only book-mirror path (we offer
  YES, we get NO — operator directive 2026-09-10). Allowlist keys:
  `americanfootball_{nfl,ncaaf}.anytime_td` / `.first_td`. TOA outcomes are
  `name:"Yes"` + `description:<player>`; first TD also carries a "No Touchdown"
  outcome (+15000) the player matcher ignores.
  ⚠ **First TD is a CLOSED field** and is **field-normalised** (2026-09-10,
  `CLOSED_FIELD_ONE_SIDED_MARKETS`): its YES prices sum to ~1.36–1.38 across the
  field, so the 8% per-outcome assumption had left every first-TD fair ~25% high.
  Each book's field is power-normalised to 1.0 and the player's normalised prob
  averaged across complete books (13 on 49ers@Rams). This corrects the **fair**
  (EV, risk, exposure); the **quote** is still the raw book-mirror minus the
  sweetener, i.e. it matches the books' YES price — so the modelled edge on
  first TD now reads as the real ~25–35% margin over fair rather than ~8%.
  Anytime TD is an OPEN field (sum ≈ 5.6 ≈ expected TD scorers) and keeps the
  per-outcome 8%; it must never be added to the closed-field list.
  **Correlation:** a TD leg is a player prop with a `playerName`, so the football
  same-game guard refuses it against ANY other leg on the same game — spread,
  total, moneyline, team total, another scorer, the same player's first+anytime —
  even with `FOOTBALL_SGP_ENABLED=true` (`test/td-scorer-props.test.js`).
  Cross-game TD legs are independent.
  **Novelty guard carve-out:** the `novelty_market` pattern contains
  `first touchdown`; a REGISTERED `player_first_td` / `player_anytime_td` leg is
  exempted by marketType (it prices off its own book market, not the parent
  game). An unregistered "First Touchdown" market still declines.
- ⚠ **Until 2026-09-10 NO football prop except anytime TD had ever registered.**
  `extractPlayerNameFromPropMarket` (websocket.js) had no football stat strips,
  so "<Player> Passing Yards" / "Rushing Yards" / "Receiving Yards" / "Total
  Receptions" / "Total Passing Touchdowns" / "To Score First Touchdown" /
  "Interceptions Thrown" all returned a NULL player and the seed skipped them
  at `if (!playerName) continue;` — silently, at debug level. Verified on the
  49ers@Rams PX board (142 markets: 0/25 receptions, 0/30 first TD, 0/13
  receiving yds named). The classifier also bucketed "Total Passing
  Touchdowns" as `other_football_prop`, so `passing_tds` could never quote.
  Fixed in 7589e23+; `test/football-lines.test.js` pins the live PX phrasing.
  **When a prop family shows 0 lines, test the extractor on a real PX market
  name before suspecting the window, the book gate or TOA.**
- **Also mapped (2026-09-14):** interceptions thrown (`player_pass_interceptions`),
  field goals made (`player_field_goals`), pass completions
  (`player_pass_completions`) and longest reception (`player_reception_longest`),
  all two-sided and measured live on Broncos @ Chiefs (5 / 3 / 6 / 4 books).
  "Longest Reception" must classify BEFORE receptions or it buckets as a count prop.
- **Shared TOA key (2026-09-14).** The single-leg posters use the same key, so the
  trader sees a steady trickle of frequency 429s. Broncos @ Chiefs props stayed dark
  ~40 min because (1) the per-event prop fetchers gave up on the first 429 with no
  retry and never told the governor, and (2) the governor paused all TOA calls 5s
  doubling to 120s per 429. Now: prop fetches retry a 429 twice with jittered
  backoff (`TOA_PROP_429_RETRIES`, default 2) and report to the governor; the
  governor base is 1s capped at 8s (`TOA_BACKOFF_BASE_MS` / `TOA_BACKOFF_MAX_MS`).
  Football prop skips (no player name, no fair, too few books) log at INFO.
  The quota is not the constraint (20.9M remaining); request FREQUENCY is.
- **Player-name suffixes (2026-09-14).** Roman-numeral suffixes compare STRICTLY in the
  TOA matcher (Michael Carter and Michael Carter II are different Jets players), so PX
  writing "Kenneth Walker" on yardage/receptions while every book wrote "Kenneth Walker
  III" left three of his markets dark. The fix is anchored in PX's own board for the
  game, never the book board: an unsuffixed non-TD football market inherits a suffix
  only when every PX TD market for that base name carries that same suffix
  (`_footballTdGensByBase` / `_applyFootballTdSuffix`, seed path). An unsuffixed TD
  market (Carter the RB) or no TD market blocks the rename. A book-board fallback was
  tried first and REJECTED: it priced "Michael Carter" off "Michael Carter II".
- **T-120 registration window** (`FOOTBALL_PROP_TMINUS_MINUTES`; per-league /
  per-weekday via `FOOTBALL_PROP_WINDOWS`). Gates REGISTRATION, not pricing, at
  the seed and (since 2026-10-01) the on-demand bridge. Unparseable kickoff fails closed.
- **≥3 books, absolute** (`FOOTBALL_PROP_MIN_BOOKS`) — the trusted-single-book
  bypass is disabled for football.
- **ONE line per (player, market) — NO ALTS.** PX bundles every alt point for a
  player into ONE market, so without pruning we would register the whole ladder.
  Two reasons not to: an alt ladder on one player is a stack of near-nested
  legs, and on the single-leg book alts filled **-3.1% vs -0.6% on mains** —
  alts are where the pick-off happens, because they are the points with the
  thinnest coverage. "Best-booked" = most books quoting BOTH sides at that
  point; ties break toward the middle of the ladder, not an edge. If no point
  clears the book gate, the whole market is skipped.
- **League-wide net prop cap** (`PROP_NET_EXPOSURE_BY_SPORT`): CFB $500,
  NFL $1500.
- **Same-game football props remain BLOCKED** by the `football_sgp_blocked`
  guard even with `FOOTBALL_SGP_ENABLED=true` — prop game-script coupling is an
  order of magnitude larger than side+total and is NOT calibrated. Measured
  demand supports this: CFB prop demand is **95% cross-game** (17,959 vs 1,004
  legs on 2026-09-06). NFL is 52/48, so NFL same-game is real demand we are
  deliberately declining until the coupling is measured.
- Launch still gated by `PROP_LAUNCH_ALLOWLIST` — add e.g.
  `americanfootball_ncaaf.passing_yards,americanfootball_nfl.receiving_yards`.
- ⚠ **Decline volume is a MISLEADING proxy for football prop demand** — it is
  not merely inflated, it is INVERTED. Saturday 2026-09-06: passing yards
  17,236 declined legs → **$2,960** of network fills; rushing yards 551 declined
  legs → **$7,892**. Rank markets by `matched_parlays`, never by declines.

## MLB SGPs — side + total (measured, gated)

Same method as football (`M = P(A∩B)/(P(A)·P(B))` on pre-game consensus lines
+ final scores, bootstrapped CIs): The Odds API **historical** snapshots at
16:00Z and 22:30Z (our key has historical access — 30 credits/snapshot, later
snapshot wins per game, median across ~10 US books) joined to Retrosheet game
logs. See `services/mlb-sgp-correlation.js` for the tables.

- **`ml_total` is small and DIRECTIONAL** (n=4,703, complete 2024–25): fav+under
  **1.030** [1.008, 1.052], dog+over **1.047** [1.011, 1.083], and the other two
  directions anti-correlated (fav+over 0.968, dog+under 0.956 → clamp). The
  opposite of the grid's intuition — favourites win pitchers' duels 3-1, dogs win
  shootouts — so its flat 1.15 charged most on the one direction that is actually
  anti-correlated. Production's 1.15 is a charge for a coupling that does not exist, and
  it is the bucket where we lose **$40K/wk at a 3.6pp median gap, winning 0.13%
  of contests** — the 40 fills we did win ran +34% ROI, which is what a phantom
  correlation looks like from the inside.
- **Run line + total is small (~1.05) and conditioned on the TOTAL**, the same
  shape as the CFB spread split: fav covers −1.5 + over is ~1.13 at totals ≤7.5
  (covering −1.5 in a 7-run game *requires* the over), ~1.07 at 8–9, and ≤1.00
  at ≥9.5 (n=4,687 games, complete 2024–25 seasons). A single `spread_fav_over` number is wrong in both directions.
  Production's 1.30 is ~25 points too rich on the most-asked direction.
- Clamped ≥1.00; unknown total or direction fails toward the **tightest**
  bucket; non-MLB returns null so the grid still applies elsewhere.
- **Gated by `MLB_SGP_CORRELATION_MEASURED`** because MLB same-game is live.
  Mutation-checked (`test/mlb-sgp-correlation.test.js`): ignoring the switch
  fails 2, collapsing the total buckets fails 4, removing the clamp fails 1,
  dropping the ML-side derivation fails 1.
- ⚠ The **fetch shares the trader's TOA key** — four concurrent fetchers
  stalled everything in `EXCEEDED_FREQ_LIMIT` backoff on 2026-09-09. One paced
  process (2.6s cadence) is fine; never fan it out.

## Football SGPs — side + total (NFL / CFB)

Blocked until 2026-09-07 on the grounds that "no calibrated football correlation
factors exist". They exist now, and they are **measured, not modelled** —
and deliberately NOT reverse-engineered from a book's SGP price, which bakes in
the book's own margin and would import it straight into our fair value.

Method: for each historical game take the CLOSING consensus spread + total and
the final score, then compute `M = P(A∩B) / (P(A)·P(B))` — exactly the quantity
that multiplies our independent fair parlay probability. `M = 1.00` means
independent pricing is already correct. 95% CIs bootstrapped, pushes excluded.
**NFL** 7,245 games 1999-2025 (nflverse closing lines); **CFB** 7,676 games
2006-2025 (cfbfastR multi-book median joined to final scores).

- **NFL is INDEPENDENT.** fav-cover+over 1.004 [0.979, 1.028]; fav-ML+over 1.005
  [0.988, 1.021]. Every NFL CI contains 1.000 across 27 seasons. The widely
  repeated "favourite covers ⇒ over hits 52.5%" **does not replicate** on
  closing lines — measured P(over | fav covered) = **49.7%**. Applying a
  correlation discount to NFL side+total would be inventing one.
- ⚠ **RE-MEASURED 2026-09-25 — finer tail buckets.** The single 14.5+ → 1.17
  bucket was an average: Rutgers −42.5 + O56.5 quoted **+233** while FanDuel's real
  SGP was **+151**. On 9,465 games (`scripts/_cfb_sgp_bucket_measure.py`, reproduces
  the old 14.5+ aggregate at 1.167): 7.5–14.5 **1.05**, 14.5–21 **1.11**, 21–28
  **1.17**, 28–35 **1.24**, 35+ **1.25** (40+ 1.265). The coupling climbs with the
  spread. Interim guard: CFB spread+total SGPs with |spread| ≥
  `FOOTBALL_SGP_MAX_SPREAD_NCAAF` (default 28, 0 disables) DECLINE as
  `football_sgp_spread_too_large` (`test/cfb-sgp-spread-cap.test.js`).
  ⚠ The dashboard's FanDuel/DK/Pinnacle **parlay** columns multiply each book's
  legs INDEPENDENTLY — on an SGP they are NOT the book's SGP price (+252 shown vs
  FD's actual +151). Never read them as "the book pays X" for same-game parlays.
- **CFB spread+total is DIRECTIONAL (2026-09-27).** The spread buckets are the fav covers + over / dog covers + under cell. The OPPOSITE pair (fav + under, dog + over) measures **0.66–0.96 at 7.5+** (clamped to 1.00) and **1.054–1.057 [1.003, 1.110] at 0–3.5** (charged 1.06; same-direction there is 0.94 → 1.00). Same 9,465 games; `scripts/_cfb_sgp_bucket_measure.py` prints all four cells. Until this fix `pricer.js` passed only the spread SIZE to `footballSgpFactor`, so every opposite pair paid the full 1.05–1.25 bucket. Direction comes from the legs (the spread leg's signed line on the bettor's side + the total leg's over/under); if either is unreadable the bucket charges the DEARER direction. NFL and CFB ml_total unchanged. In `FOOTBALL_SGP_CORRELATION` a bucket's `oppositeFactor` is optional (absent → both directions at `factor`). ⚠ dog + under at 35+ measures **1.31** vs the 1.25 bucket — another reason the 28+ decline stays (both directions). `test/cfb-sgp-direction.test.js`.
- **CFB aggregate 1.067 is an ARTEFACT of aggregation — do not use it.**
  Split by spread: 0-3.5 → 1.006, 3.5-7.5 → 1.030, 7.5-14.5 → 1.004 (all three
  CIs contain 1.000), **14.5+ → 1.169 [1.131, 1.209]**. Below two touchdowns
  there is no correlation; above it, blowout game script (garbage time, running
  clock, backups) genuinely couples side to total. That bucket is **~32% of CFB
  games**, so the single aggregate would simultaneously OVERprice the other 68%
  and still UNDERprice this one. The spread split is load-bearing.
- **CFB ml_total is only 1.02** (measured 1.015 [1.002, 1.028]) even at big
  spreads — a huge favourite winning outright carries almost no information
  (P = 93.8% at 14.5+). It must NOT inherit the 1.17.
- **Clamped at ≥ 1.00, asymmetric on purpose.** The negative directions are real
  (CFB fav+under 0.934, dog+over 0.935) but honouring them would price us
  *cheaper* than independent. Clamping leaves us merely uncompetitive there
  rather than exposed.
- **An unreadable spread falls back to the WIDEST bucket** (1.17), not the
  narrowest. The spread is the input that decides between 1.00 and 1.17; failing
  toward 1.00 would underprice precisely the bucket that matters.
- Football takes **precedence over `sgpCorrelationByCombo`**, including its
  directional `spread_fav_over` keys. That grid is sport-agnostic and
  back-calculated from a few FanDuel MLB/NHL samples; letting it win here would
  apply an MLB number to a football game — the exact "guessed factor" the block
  existed to prevent.
- `spread_total` / `ml_total` must also be in `SGP_ALLOWED_COMBOS` (they already
  are in prod). The football gate and the combo allowlist are independent.
- Locked by `test/football-sgp-correlation.test.js`, including mutation checks:
  collapsing CFB to the aggregate fails 5 tests, removing the ≥1.00 clamp fails
  1, failing the unknown-spread fallback cheap fails 1, and dropping the
  `playerName` guard fails 1.

## Key Gotchas

- **American odds, not decimal**: PX rejects decimal odds with "invalid odds" 400. All odds submitted must be American integers (e.g., +150, -200). Fixed in commit 10c1469.
- **config import order**: Services that use `config` must import at top of file, not lazily. The "key is not defined" bug was caused by config imported at bottom of websocket.js. Fixed in commit 10c1469.
- **valid_until is nanoseconds**: PX expects `valid_until` in nanoseconds, not milliseconds or seconds.
- **callback_url is absolute**: `submitOffer` and `confirmOrder` use the callback URL from the RFQ directly (not relative to baseUrl).
- **Both channels are private-prefixed**: PX WebSocket channels are both `private-*` — the broadcast one has "broadcast" in the name.
- **Back-to-back/doubleheader matching**: Odds cache stores arrays per team pair, matched by closest `commenceTime` to handle same-day series.
- **Team markets are full-game only** (plus MLB F5 / NBA first-half carve-outs): the main-market filter drops quarter/period/inning markets. **Player props register separately** via the pre-seed prop pass (allowlist-gated per `PROP_LAUNCH_ALLOWLIST`) — MLB hitter/K props, NBA/WNBA points/rebounds/assists/threes, NHL points/assists/SOG, soccer WC goalscorer/SoT/assists.
- **On CFB the CONSENSUS FLOORS set the price, not vig or surcharges** (measured 2026-09-26). The per-leg floor (`PRICE_FLOOR_VS_CONSENSUS_PP`, raw Pin/FD/DK implied − 1pp) and the parlay floor (Π raw consensus − `PRICE_FLOOR_VS_CONSENSUS_PARLAY_PP`, chalk stacks − 0pp) run LAST and only tighten, so they sit at the books' own vigged price. After the 2%→0.5% CFB vig cut they set 81–83% of CFB quotes. An exemption from the heavy-fav / chalk-stack / leg-count surcharges for 2–4 leg all-CFB parlays was built and REVERTED the same day: replayed WITH the floors it flipped 1 of 194 lost tickets ($25) — a replay without them had claimed $12.6K. **Any price-lever replay must apply these floors.** Winners price ~1.6% over our fair on CFB, inside our ±3.1%/leg calibration noise; CFB total OVER legs run against us (n=103, z=+1.96), so loosening the floors is not proven +EV — test it as a tagged A/B arm if at all.
- **Closing-line (CLV) lookup resolves by START TIME, not id** (fixed 2026-09-27). `captureClosingLines` keys snapshots `sport|home|away|<odds-feed eventId>`; settlement looked them up with the PX event id, which never matches, and the fallback returned the FIRST snapshot for the pair — MLB series games 2–4 and doubleheader game 2 read game 1's close (~37% of unique legs), contaminating every `clvDelta` and `/clv-report`. `getClosingLineSnapshot(sport, home, away, eventId, startTime)` now takes an exact odds-feed-id hit, else the pair's snapshot with the closest `commenceTime` within **12h (90 min for baseball** — a doubleheader game with no captured close must not read its sibling's); otherwise `null`. **`clvDelta` on orders settled before 2026-09-27 is still contaminated** — filter CLV work to later settlements. `test/closing-line-lookup.test.js`.
- **Parlays with a push/void leg — how PX settles them** (`services/parlay-settlement.js`, measured 2026-09-27 on 206/206 won-with-a-push parlays). Any lost leg → SP won. Otherwise, if the parlay contains a SAME-GAME group (2+ legs on one PX `sport_event_id`), PX **voids the whole parlay** (`push`, $0) even when the pushed leg is on another game; with no same-game group PX drops the void legs and pays **reduced odds** (`lost`), dividing out the per-leg probability we sent at confirm and rounding against the bettor (cent-exact on 113/140 post-6/26). ⚠ The audit's 15 "won-with-a-push → settled_push/$0" tickets are CORRECT — do not re-book them. A `lost` with a void leg and NO PX profit books the reduced payout (`meta.pnlSource='derived_void_reduced:*'`) instead of full risk; the label is cleared whenever PX's own profit arrives or the order re-settles. Settlement paths apply PX leg statuses in memory (`recordLegSettlement(..., {persist:false})`) and the ONE settled save persists them — separate 'confirmed' leg saves raced it and could revert the row. Repair scripts (dry-run by default, `--apply` writes only PX's own numbers): `scripts/_reconcile_push_settlements.js`, `scripts/_estimate_restored_fairs.js` (marks `meta.fairEstimated`). `test/push-settlement-mapping.test.js`, `test/audit-fix-review.test.js`.
- **TOA gate wedge + overlapping seeds (2026-09-28).** Odds sat ~60 min stale for EVERY sport from 14:31Z until a restart at 16:52Z while TOA answered in 0.18s from outside: the trader's own TOA gate (`abortableFetch` / `_toaAcquire`, 4 slots) was jammed. A caller whose budget expired while QUEUED stayed in the queue and still cost a slot turn + `TOA_MIN_INTERVAL_MS` when reached, so a backlog of dead waiters outlived every live 500ms caller; the blocking events-list refresh had no single-flight (314 NFL fetches in 52s) and nothing stopped re-attempting a refresh that had just failed — metastable, 123K `fetchTimeouts`, only a restart cleared it. Fixed: an aborted waiter splices itself out of the queue; `_refreshTheOddsApiEvents` is single-flight per sport; the blocking events AND prop paths serve stale for `TOA_REFRESH_FAIL_BACKOFF_SECONDS` (default 20) after a failure instead of re-fetching (and log only the attempting caller). Gate state is on `/status` → `toaStaleServe.gate` (`queued`, `inFlight`, `abandoned`, `maxQueue`). **Same morning, `refreshLines` had no in-flight guard**: the 2-min timer started a new seed while 5–25 min seeds ran, each call RESET `_seedIndexTarget = {}` under the running one, and the first to finish swapped in a partial index → the supported-lines sync de-registered the rest (registered lines 1,028 before the restart vs 4,157 after; 5/8 NHL openers and 2/4 MLB Wild Card Game 1s missing). Overlapping calls now JOIN the running seed; one older than `LINE_SEED_MAX_RUN_MINUTES` (default 30) is abandoned and its swap + PX sync skipped via a generation check. **Diagnose a wedge from `/status`: `odds.*.ageMinutes` all climbing together + `toaStaleServe.fetchTimeouts` rising fast = gate, not TOA** — confirm with one free `GET /v4/sports` from outside. `test/toa-gate-wedge.test.js` (7 mutants, all killed).
- **Tests must never reach production Supabase.** `config.js` loads `.env` by ABSOLUTE path, so any process that requires `services/` gets the production service key. `services/db.js` is a no-op when `NODE_TEST_CONTEXT` is set (normal `node --test` children), `NODE_ENV=test`, `process.execArgv` contains `--test` (catches `node --test --test-isolation=none`, which runs files in the parent where NODE_TEST_CONTEXT is unset — a review run that way wrote 14 fake `parlay_orders` rows on 2026-09-27), or the entry file is `test/*.test.js`. A plain `node some-script.js` that requires services IS production. Pinned by `test/audit-fix-review.test.js` + `test/fixtures/db-guard-probe.cjs`.
- **max_risk enforcement**: PX sandbox may not enforce max_risk limits. A $2,447 order was confirmed despite max_risk=500. Open question for Alec (PX contact).

## Conventions

- CommonJS (`require`/`module.exports`), no ES modules
- No TypeScript, no build step
- `node-fetch@2` (CommonJS compatible)
- Logging: `log.info('Category', 'message', optionalData)`
- **Pushing is gated, with ONE standing exception.** Push auto-deploys to Railway production and restarts the trader.
  - **In an interactive session: NEVER `git push` without explicit user approval.** Commit freely, but the push must be gated on the user typing "push" (or equivalent) in chat. Do NOT push after completing work, do NOT push as part of a batched command, do NOT assume earlier approval carries over to a new commit. Every single push requires a fresh green-light. There is no time-based trigger inside a session — 1am arriving is not approval.
  - **Exception — the daily 1am ET auto-push** (operator directive 2026-08-23). The scheduled task `daily-1am-push` (`~/.claude/scheduled-tasks/daily-1am-push/SKILL.md`) pushes whatever is committed on `main`, then verifies the Railway deploy actually restarted and re-seeded. It is pre-authorized and needs no per-run approval. It **aborts without pushing if `npm test` is red** — an unattended push deploys whatever happens to be committed, so the suite is the only gate standing between a half-finished commit and production. Anything you do not want deployed overnight must be left uncommitted, not merely unpushed.
