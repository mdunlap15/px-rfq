# College Baseball (`baseball_ncaa`) Onboarding Plan — PARKED

**Status:** Parked 2026-06-17 per operator. Wiring is fully scoped and verified; **not built**.
**Reason to park:** PX lists **0** college baseball events right now (mid-CWS), and the season
ends ~June 22–23, then is dormant until **~February 2027**. Recurring payoff is next season.
**Resume trigger:** When PX starts posting "College Baseball" events again (next season, or any
remaining CWS games it decides to list). Run the **Pre-flight** section first, then the steps.

---

## Verified facts (live checks, 2026-06-17)

- **The Odds API key = `baseball_ncaa`** (title "NCAA Baseball", `active=true`, group Baseball,
  `has_outrights=false`). Confirmed live via `/v4/sports?all=true` and an odds pull.
- **TOA coverage:** h2h + spreads (run lines) + totals all populate. Books seen: ballybet,
  betmgm, betonlineag, betparx, betrivers, betus, bovada, **draftkings**, espnbet, **fanduel**,
  fliff, lowvig, mybookieag, williamhill_us. **NO Pinnacle.** De-vig anchor is DK+FD only.
  - Run lines: primary **±1.5**, with ±2 / ±2.5 alts present *natively* in the `markets=spreads`
    pull (no separate alt request needed for these).
  - Totals run **high** (observed 14.5–17.5; college aluminum-era offense). Sample: NC @ WVU,
    DK h2h NC −200 / WVU +154; RL NC −2.5 (−120); total O/U 17.5.
  - Quota: ~20.5M remaining; an odds pull cost ~6 — negligible.
- **ProphetX side (queried live via `get_tournaments` + `get_sport_events`):**
  - PX HAS a **"College Baseball"** tournament (`id=1600000270`, `sport.id=3`, **`sport.name="Baseball"`**).
    Also "Women's College World Series" (also `sport.name="Baseball"` — but TOA `baseball_ncaa` is
    MEN'S; women's softball has no TOA route, ignore).
  - → `sportNameMap` value is **`'Baseball'`** (shares MLB's bucket exactly as
    `basketball_ncaab`/`nba`/`wnba` all share `'Basketball'`). line-manager `seedEvent`
    disambiguates the shared sport_name by team-name match (NCAA teams won't match MLB odds).
  - **At check time PX listed 0 live college events** (135 current events; 15 baseball, all MLB).
    So nothing registers/quotes until PX posts college games.
- **Env note:** local `.env` had `PX_BASE_URL=https://cash.api.prophetx.com` which **does not
  resolve** (DNS ENOTFOUND). Correct host is `https://cash.api.prophetx.co`. Production must
  already be `.co`. (Used `.co` override for the live recon.)

## Template & design principle

`basketball_ncaab` is the clean precedent: it's implemented **entirely as config/data-table
entries with ZERO per-sport code branches** (pricer.js has no NCAAB literal). Replicate that —
add `baseball_ncaa` as data entries, NOT new code branches. The ONLY code logic that needs
touching is a handful of MLB-literal gates (`=== 'baseball_mlb'`) that must widen to the
baseball *family* (`startsWith('baseball')`) so college alt lines register / type correctly.

---

## Pre-flight (re-run in February before touching code)

1. **TOA still active:** `GET /v4/sports?all=true` → confirm `baseball_ncaa` present & `active`.
2. **PX posts events:** `prophetx.fetchSportEvents()` → confirm there ARE events with
   `sport_name==='Baseball'` whose `tournament_name` matches college (e.g. "College Baseball"),
   and that `sport.name` is still **"Baseball"** (a changed string silently blocks the sport —
   the MMA `'MMA'` gotcha).
3. **Re-verify line anchors below** — code drifts; trust the SYMBOL names, not the line numbers.
4. Confirm DK+FD still both present on `baseball_ncaa` (de-vig needs ≥2 sharp-ish books; no Pinnacle).

---

## REQUIRED edits (sport won't quote / will misprice without these)

1. **`services/odds-feed.js` — `ODDS_API_FALLBACK`** (obj starts ~L183; `basketball_ncaab` at ~L191).
   Add, mirroring the **non-flipGated** NCAAB entry (NOT the flipGated MLB entry at ~L315):
   ```js
   'baseball_ncaa': {
     oddsApiSport: 'baseball_ncaa',
     markets: 'h2h,spreads,totals',
     bookmakers: ODDS_API_BOOKMAKERS,
   },
   ```
   Without an odds route, `fetchOddsForSport` throws "Unknown sport" and the staleness gate
   declines every RFQ. Non-flipGated → routes straight through `fetchFromTheOddsApi` like NCAAB.

2. **`config.js` — `sportNameMap`** (~L1030–1060). Add: `'baseball_ncaa': 'Baseball',`
   REQUIRED — `seedAllLines` builds `pxSportNames = Object.values(sportNameMap)` and drops any PX
   event whose `sport_name` isn't in the set. Value confirmed **"Baseball"** (see verified facts).

3. **`services/line-manager.js` — `TOTAL_BOUNDS_BY_SPORT` (~L234) and `MAX_SPREAD_BY_SPORT` (~L265).**
   Add (college runs higher than MLB's `[6.5,15]` / `5`):
   - `'baseball_ncaa': [6.5, 22]` to totals bounds
   - `'baseball_ncaa': 7` to max spread
   Without these, `isValidFullGameLine` falls back to permissive defaults (totals `absLine>2.5`
   accept; spreads unbounded) → risks registering a junk/sub-game total as full-game.

4. **`services/espn-scores.js` — `ESPN_LEAGUES`** (~L21). Add:
   `'baseball_ncaa': [{ sport: 'baseball', league: 'college-baseball' }]`
   REQUIRED for settlement (order-tracker resolves W/L via ESPN). **Verify the exact ESPN slug**
   `college-baseball` on the first live settlement. Full-game final-score resolution is unaffected
   by 7-inning doubleheaders (linescore just has 7 entries); no F5 product for college.

## RECOMMENDED (safe-by-default protection; do these too)

5. **`config.js` — `vigBySport`** (~L27, currently env-only IIFE returning `{}` when `VIG_BY_SPORT`
   unset). Bake a **code-level protective default** so the sport is safe even if the env isn't set
   (no Pinnacle + thin coverage makes the 1.5% default too tight):
   ```js
   vigBySport: (() => {
     const defaults = { baseball_ncaa: 0.045 }; // thin/no-Pinnacle market — env can override
     let envMap = {};
     if (process.env.VIG_BY_SPORT) { try { const p = JSON.parse(process.env.VIG_BY_SPORT);
       if (p && typeof p === 'object' && !Array.isArray(p)) envMap = p; } catch {} }
     return { ...defaults, ...envMap };
   })(),
   ```
   (Keeps existing env-override + runtime `/config/vig` behavior; just adds a floor default.)

6. **`services/odds-feed.js` — `oddsApiToSharpMarket`** (~L1861). Generalize both baseball arms:
   `if (sport === 'baseball_mlb')` → `if (sport.startsWith('baseball'))` for spreads→`run_line`
   and totals→`total_runs`. NOTE: currently off-path for `baseball_ncaa` (only called from
   `fetchPinnacleRows`, which early-returns when the sport isn't in `PINNACLE_SPORT_MAP`, and we
   are NOT adding one — no Pinnacle). Do it anyway: zero-risk, prevents a latent bug if Pinnacle
   coverage ever appears. MLB unaffected (`startsWith('baseball')` still matches it).

7. **`services/line-manager.js` — virtual alt-spread/alt-total registration** (recon refs ~L2887–2895
   and ~L2921–2923 — **VERIFY**). Generalize both `if (sportKey === 'baseball_mlb')` →
   `if (sportKey.startsWith('baseball'))`, reusing `config.pricing.mlbAllowedRunLines` (±0.5/±1.5)
   and `mlbAltTotalMaxDistance` (±1.5). This is what lets the native TOA alt run-lines (±2/±2.5)
   and alt totals actually register & quote; left MLB-only, those alt RFQs decline as "unknown
   legs". **Decision:** include this only if you want alt lines at launch; primary-lines-only
   (skip #7, #8, #10) is the more conservative first cut and still quotes ML + primary RL + total.

8. **`services/pricer.js` — `isBlockedAltTotal`** (~L189, baseball arm ~L198). Generalize
   `sport === 'baseball_mlb'` → `sport.startsWith('baseball')` so NCAA alt totals get the same
   ±distance guard. (Consistency with #7. NOTE: `isBlockedAltSpread` at ~L67 returns null unless
   the sport is in `blockAltSpreadSports` — leave `baseball_ncaa` OUT of that block like NCAAB,
   so its run-line gate at ~L109 is moot; generalizing it is optional.)

9. **`services/odds-feed.js` — `SPORTS_WITH_ALT_MARKETS`** (~L3811) and/or
   `SPORTS_WITH_ONDEMAND_ALT_MARKETS` (~L3839). Add `'baseball_ncaa'` if doing alt lines (#7) — it
   enables alt pre-warm + the strict alt-as-primary safety gate (important on thin/no-Pinnacle).

10. **`index.js` — `FAST_REFRESH_SPORTS`** (~L444; gated by `supportedSports.includes`, so it only
    fires once enabled). Add `'baseball_ncaa'` so the ~2.5-min re-fetch keeps the stale gate honest.

## COSMETIC (dashboard; not a quoting blocker)

11. **`client/index.html`** — add `'baseball_ncaa'` to all four enums: `sportLabel` (~L8065) →
    `'NCAA Baseball'`; `canonicalSport` (~L8130) → keep **distinct** from `baseball_mlb` (don't
    collapse, so P&L-by-sport separates college from MLB); `sportPill` clsMap (~L8159); the two
    `sportLabelMap`/`sportOrder` blocks (~L10271, ~L10717).
12. **`client/viewer.html`** — mirror: `sportLabel` (~L7306), `canonicalSport` (~L7371), optional
    vig-by-sport `sportKeys` (~L2012).
13. **`services/order-tracker.js` — `SPORT_LABEL_MAP`** (~L5853) — only if PX uses a distinct
    college-baseball label in CSV exports (backfill cosmetic).
14. **`services/v2/correlation.js` — `CROSS_EVENT_SAME_SPORT_TOTAL_CORR`** (~L83) — optional
    `'baseball_ncaa': 0.05` to mirror MLB (absent = 0 corr, conservative/harmless).

## EXPLICITLY LEAVE MLB-ONLY (do NOT generalize — they correctly no-op for college)

- All **F5 / first-5-innings** paths (`supplementMlbF5Markets`, F5 consensus/alt markets,
  `F5_MARKET_TYPES` name patterns, espn F5 resolver) — college has no F5 product.
- **Probable-pitcher StatsAPI feed** + `checkLineupFreshness` lineup-change grace — no NCAA feed.
- **MLB hitter/pitcher prop pre-seed** (`_MLB_PROP_TO_TOA_MARKET`, `classifyMlbProp` seed) +
  `PROP_LAUNCH_ALLOWLIST` — **TOA carries NO NCAA-baseball props.** Launch game-lines-only.
- **In-play live model** (`in-play-models.js` `mlbLiveProb`, `SPORT_HANDLERS`) — the 9-inning
  hardcode `(9-inning)*2` breaks on 7-inning doubleheaders + run-rule/mercy endings common in
  college. Do NOT wire `baseball_ncaa` into `SPORT_HANDLERS`; no-handler fallback (static pregame
  prob) is the safe default. (Build a 7-inning/mercy-aware variant only if live RFQs matter.)
- **Retired SharpAPI paths** (`LEAGUE_MAP`, `marketTypesList`) — college routes through TOA; Sharp
  retired (commit `e0c269a`). Do NOT add a SharpAPI entry.
- **`PINNACLE_SPORT_MAP`** — skip; no Pinnacle on `baseball_ncaa` (would be a no-op).

## Recommended conservative launch config

- **Markets:** team only — h2h (ML), run-line (±1.5 primary), totals. (Default team-sport branch
  in line-manager `mainMarkets` already covers these; no `isMmaSport`-style flag needed.)
- **Alt lines:** operator choice — primary-only is the safest first cut (skip #7/#8/#9/#10).
- **Props:** OFF (no TOA source anyway).
- **Vig:** ~**0.045** (see #5; vs 1.5% default) — thin coverage, DK+FD-only de-vig, no Pinnacle.
- **Risk caps:** global defaults apply (MAX_RISK_PER_PARLAY 500, MAX_EXPOSURE_PER_TEAM 50,
  MAX_LEGS 8). No per-sport edit needed.
- **Stale threshold:** global 5-min default is fine (FAST_REFRESH keeps it fresh).

## GO-LIVE GATE

All edits above ship **dark** — nothing registers/quotes because `baseball_ncaa` isn't in
`supportedSports`. The single switch that turns quoting ON is the **env** change: add
`baseball_ncaa` to Railway `SUPPORTED_SPORTS` (+ set `VIG_BY_SPORT` if not relying on the #5
code default) and restart. Recommended: deploy code first, soak, set vig, then flip
`SUPPORTED_SPORTS` last as the final go-live action (reversible without a redeploy).

## Verification when built

- `node --check` each edited file.
- Re-use the **TOA byLine de-vig** (commit `ae9cb80`): a college run-line/total RFQ at a
  non-modal line should price off the books posting THAT line, not a cross-line blend.
- With PX events live: register a college game, confirm a `/recent-quotes` ML/RL/total price
  sits sane vs DK/FD, and confirm one settles via ESPN `college-baseball`.
