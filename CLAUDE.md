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
  db.js                   Supabase client (parlay_orders, matched_parlays tables)
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
| `PROP_LAUNCH_ALLOWLIST` | No | Comma-separated `<sport>.<propType>` keys that may quote (e.g. `baseball_mlb.hitter_hr,soccer.goalscorer`). Props not listed never register. |
| `MAX_RISK_PER_PARLAY` | No | Default: 500 |
| `MAX_RISK_PER_PARLAY_WITH_PROP` | No | Default: 50. Cap on **OUR max risk** (payout liability) for any parlay containing a player-prop leg. Prod: 3000 (2026-08-13). |
| `PX_MIN_STAKE` | No | Default: 1. PX's minimum bookable stake. A per-parlay RISK cap is sent to PX as a *bettor stake* cap (Rule 3: `stake = risk × p/(1−p)`) floored at $1 — so when a cap converts to a sub-$1 stake cap, the smallest fill PX can book already breaches it and we are certain to reject at confirm. `priceParlay` declines those at quote time (`unfillable within risk cap`). Bites only where a small cap meets long odds: at the ordinary $500 `MAX_RISK_PER_PARLAY` the crossover is ~**+50000** (relevant to deep MoV tails, which are otherwise exempt from `MAX_ODDS`), at the $15 experimental-SGP cap ~+1500, and at the $3,000 prop cap beyond +300000. |
| `MAX_EXPOSURE_PER_TEAM` | No | Default: 50 |
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
| `MOV_TTL_MIN` | No | Default: 45. Warm cadence for the DK method-of-victory scrape (~3-5 min/card, background only — never on the RFQ path). |
| `MOV_MAX_AGE_MIN` | No | Default: 180. Max board age that still prices; beyond it MoV legs fail closed. |
| `MOV_DRAW_PROB` | No | Default: 0.005. The unpriced 7th outcome; the 6-way de-vig normalizes to `1 - this`. |
| `MOV_MIN_PARLAY_PROB` | No | Default: 0.000001. Probability floor for **all-MoV** parlays, replacing the standard 0.1%. Raise it to re-impose a tail limit. |
| `BTTS_SPORTS` | No | Default: `soccer_usa_mls`. Sport keys eligible for Both-Teams-To-Score. Deliberately NOT every soccer key: `btts` is a per-event fetch, so each league multiplies calls against the same TOA key the main odds path uses, and that key rate-limits by frequency. Widen one league at a time. |
| `BTTS_BOOKMAKERS` | No | Default: `pinnacle,draftkings,fanduel,betmgm,betrivers,williamhill,matchbook`. Two-sided books only — a make-side-only book can't be de-vigged. |
| `BTTS_MIN_BOOKS` | No | Default: 2. Minimum two-sided books before a game is priced. |
| `BTTS_TTL_SECONDS` | No | Default: 240. TTL of the per-game BTTS consensus cache. |
| `BTTS_FETCH_SPACING_MS` | No | Default: 250. Gap between per-event BTTS calls. Guards the TOA request-frequency limit — an unpaced burst 429s, and a 429 masquerades as "no BTTS for this game". |
| `SGP_ALLOWED_COMBOS` | No | Comma-separated same-game combo keys that may quote. **Unset → legacy default `spread_total`. Explicitly empty (`""`) → ALL SGP combos blocked** — that distinction is load-bearing: setting `SGP_ALLOWED_COMBOS=""` on Railway must mean "block every SGP", not "fall back to spread_total", so the code distinguishes `undefined` from `''`. Keys: `spread_total` (moderate correlation), `ml_total` (strong, −37% ROI historically), `ml_spread` (blocked by correlation rules regardless). K-prop carve-outs (`kprop_ml`, `kprop_kprop`) are auto-included downstream regardless. Experimental classes (e.g. `prop_nested`) ALSO need an entry here to quote at all — experimental membership only adds tighter caps. ⚠ Adding a key here is what makes the MoV same-fight block's independence matter: `mov_sgp_blocked` is an unconditional pre-pass precisely so it survives any combo added here. |
| `FOOTBALL_SGP_ENABLED` | No | Default: false (must be the literal `'true'`). Football same-game parlays are blocked because no calibrated football correlation factors exist. Enabling it can NEVER re-open period-vs-game combos — that guard is separate. |
| `LOG_LEVEL` | No | Default: `info` |
| `WS_CONFIRM_STALL_MINUTES` | No | Default: 30 (raised from 12 on 2026-08-18; prod sets 30 explicitly). Half of the confirm-stall watchdog: force a WebSocket reconnect only after this long with no `price.confirm.new` **event** AND `WS_CONFIRM_STALL_MIN_OFFERS` offers submitted. Resets on the EVENT, not on a fill, so rejecting confirms (blocked creators, reprice misses) never reads as a dead channel — meaning it targets ONE failure mode: PX silently stops delivering on the private channel. It would NOT have fired on the 2026-06-21 outage (confirms arrived, then failed closed); a separate detector covers that. |
| `WS_CONFIRM_STALL_MIN_OFFERS` | No | Default: 250 (raised from 40 on 2026-08-18; prod sets 250 explicitly). The offer-count half of the same AND-gate, and the dimension that does nearly all the separating work. **The ORIGINAL default (40) was badly mis-calibrated**: normal quote→confirm conversion is ~3.6% (~27 offers/confirm), so 40 offers with no confirm is an ordinary lull. Measured over 4 healthy days (2026-08-14→18, 15,908 offers / 581 confirm events) the confirm-gap distribution is p50 11 offers / p90 68 / p99 230 / **max 434**, and in minutes p50 2.3 / p90 23 / p99 106 / **max 362** — i.e. 6-hour confirm gaps happen with fills resuming fine. At (12, 40) the watchdog fired **143 times in 4 days (~21/day)**, starting 17 minutes after boot. At (30, 250) the same window yields 4. Reconnects are cheap and were NOT the cause of any fill drought (measured p50 0.6s, p90 1.8s, max 3.7s, 0 failures in 143 — costing ~0.1 confirms/day); the real damage was diagnostic, since the log line reads as a PX-side outage. 250 sits just above the p99 with headroom — do NOT raise to the observed max (434/500), that is fitting to the sample. Detection latency for a genuinely dead channel is ~1.5-2h at daytime volume (~150 offers/hr). Read at MODULE LOAD, so a change needs a restart to take effect. |
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

## API Endpoints (Express)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Railway health check (always 200) |
| `/status` | GET | Full service status JSON |
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
| `/ufc-mov` | GET | UFC method-of-victory board: per-fight de-vigged KO/SUB/DEC/ITD fairs, age, `priceable`. **First stop when a MoV leg won't quote.** `?force=1` kicks a fresh scrape. |
| `/golf-topn` | GET | DK ties-included Top 5/10/20 board state + the DERIVED tie uplift per market. Diagnose with: missing slug = add `GOLF_DK_SLUG_MAP`; empty `markets` = DK isn't serving that board; stale `ageMs` = scrape failing. ⚠ **This reports PRIORITY 1 ONLY.** `priceable:false` does NOT mean top-N is dark — DataGolf is priority 2 and quotes fine on its own. To test whether outrights actually price, call `datagolf.getOutrightFairProbSync(player, marketType, tournament)` after a warm, or read `basis` on a live quote. |
| `/prop-correlation` | GET | Live-calibrated same-game prop correlation factors from `prop_settlements` (realized joint win-rate ÷ product of marginal leg rates) + bettor-edge-vs-price. `?days=60&minN=8` |
| `/settle-props` | POST | Settle finished MLB hitter-prop parlays vs box scores into `prop_settlements` now (`{sinceDays?:14, dryRun?:false}`). Daily job does this when `PROP_SETTLEMENT_ENABLED=true`. |

## Database (Supabase)

- **parlay_orders**: Our quotes, confirmations, settlements, P&L
- **matched_parlays**: All matched parlays across all SPs (market intelligence). NOTE: `.outcome` only records `missed`/`other_sp` — it does NOT carry the game result, so realized prop outcomes come from `prop_settlements` instead.
- **prop_settlements**: Realized box-score outcomes for MLB hitter-prop parlays (services/prop-settlement.js, from the free MLB Stats API). Drives same-game prop correlation calibration. Run `migrations/prop_settlements.sql` once, then enable `PROP_SETTLEMENT_ENABLED=true`.
- Upserts on `parlay_id` for orders

## Soccer Specifics

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
  (DK raw mirror, offers tagged `claude_mov_`, $500-$2,000 tiers). Those positions
  are INVISIBLE to this trader's exposure tracker — a parlay MoV quote on the same
  fight outcome stacks risk across the two books with no shared cap. PX also
  frequently lacks DEC markets that DK prices (10/10 skipped 2026-08-11).

## Key Gotchas

- **American odds, not decimal**: PX rejects decimal odds with "invalid odds" 400. All odds submitted must be American integers (e.g., +150, -200). Fixed in commit 10c1469.
- **config import order**: Services that use `config` must import at top of file, not lazily. The "key is not defined" bug was caused by config imported at bottom of websocket.js. Fixed in commit 10c1469.
- **valid_until is nanoseconds**: PX expects `valid_until` in nanoseconds, not milliseconds or seconds.
- **callback_url is absolute**: `submitOffer` and `confirmOrder` use the callback URL from the RFQ directly (not relative to baseUrl).
- **Both channels are private-prefixed**: PX WebSocket channels are both `private-*` — the broadcast one has "broadcast" in the name.
- **Back-to-back/doubleheader matching**: Odds cache stores arrays per team pair, matched by closest `commenceTime` to handle same-day series.
- **Team markets are full-game only** (plus MLB F5 / NBA first-half carve-outs): the main-market filter drops quarter/period/inning markets. **Player props register separately** via the pre-seed prop pass (allowlist-gated per `PROP_LAUNCH_ALLOWLIST`) — MLB hitter/K props, NBA/WNBA points/rebounds/assists/threes, NHL points/assists/SOG, soccer WC goalscorer/SoT/assists.
- **max_risk enforcement**: PX sandbox may not enforce max_risk limits. A $2,447 order was confirmed despite max_risk=500. Open question for Alec (PX contact).

## Conventions

- CommonJS (`require`/`module.exports`), no ES modules
- No TypeScript, no build step
- `node-fetch@2` (CommonJS compatible)
- Logging: `log.info('Category', 'message', optionalData)`
- **Pushing is gated, with ONE standing exception.** Push auto-deploys to Railway production and restarts the trader.
  - **In an interactive session: NEVER `git push` without explicit user approval.** Commit freely, but the push must be gated on the user typing "push" (or equivalent) in chat. Do NOT push after completing work, do NOT push as part of a batched command, do NOT assume earlier approval carries over to a new commit. Every single push requires a fresh green-light. There is no time-based trigger inside a session — 1am arriving is not approval.
  - **Exception — the daily 1am ET auto-push** (operator directive 2026-08-23). The scheduled task `daily-1am-push` (`~/.claude/scheduled-tasks/daily-1am-push/SKILL.md`) pushes whatever is committed on `main`, then verifies the Railway deploy actually restarted and re-seeded. It is pre-authorized and needs no per-run approval. It **aborts without pushing if `npm test` is red** — an unattended push deploys whatever happens to be committed, so the suite is the only gate standing between a half-finished commit and production. Anything you do not want deployed overnight must be left uncommitted, not merely unpushed.
