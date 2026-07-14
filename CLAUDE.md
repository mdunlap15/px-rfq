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
| `SHARP_ODDS_API_KEY` | Yes | SharpAPI key (primary odds source, DK+FD free tier) |
| `THE_ODDS_API_KEY` | No | The Odds API key (fallback for NCAAB, alt lines from Pinnacle) |
| `SUPABASE_URL` | No | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | No | Supabase service role key |
| `DEFAULT_VIG` | No | Default: 0.015 (1.5% per leg) |
| `VIG_BY_SPORT` | No | JSON map of per-sport base vig overriding `DEFAULT_VIG` (e.g. `{"soccer":0.03}`) |
| `PROP_LAUNCH_ALLOWLIST` | No | Comma-separated `<sport>.<propType>` keys that may quote (e.g. `baseball_mlb.hitter_hr,soccer.goalscorer`). Props not listed never register. |
| `MAX_RISK_PER_PARLAY` | No | Default: 500 |
| `MAX_RISK_PER_PARLAY_WITH_PROP` | No | Default: 50. Cap for any parlay containing a player-prop leg. |
| `MAX_EXPOSURE_PER_TEAM` | No | Default: 50 |
| `MAX_LEGS` | No | Default: 8 |
| `STALE_PRICE_MINUTES` | No | Default: 15 |
| `REFRESH_INTERVAL_MINUTES` | No | Default: 10 (code default — production Railway sets 2) |
| `SUPPORTED_SPORTS` | No | Default: `basketball_nba,basketball_ncaab,baseball_mlb,icehockey_nhl,tennis,soccer` |
| `GOLF_OUTRIGHTS_PARLAY_ENABLED` | No | Default: `true`. Kill-switch for quoting golf outright legs (win/top 5/10/20/make cut) in **parlays**. When false, zero outright lines register → PX never sends an outright RFQ. Independent of the single-leg poster (still hard-disabled). |
| `GOLF_OUTRIGHT_MAX_AGE_MIN` | No | Default: 360. Refuse a DataGolf outright board older than this. DataGolf serves the LAST tournament's board when a tour is idle (euro returned a 9-day-stale "BMW International Open" on 2026-07-14) — without this we'd quote a finished event. |
| `GOLF_TOPN_TIES_UPLIFT` | No | Unset = top 5/10/20 use RAW (un-de-vigged, conservative) consensus. Set to a calibrated multiple (e.g. 1.12) to de-vig top-N by normalizing the field to N × uplift. **Only set with a real view** — see Key Gotchas. |
| `GOLF_MAKE_CUT_VIG` | No | Default: 0.03. Our margin OVER the de-vigged fair for make_cut (`offered_implied = fair × (1 + vig)`). Moves the price the **opposite** way to `GOLF_OUTRIGHTS_SWEETENER` — see Key Gotchas. |
| `GOLF_MAKE_CUT_MIN_BOOKS` | No | Default: 2. Minimum sportsbooks quoting **both** make+miss before a player is priced. Cut boards are thin; 1-book players are noise. |
| `LOG_LEVEL` | No | Default: `info` |
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
  - `top_5/10/20` — **deliberately NOT de-vigged.** PX settles ties-included, but DataGolf's model
    field-sums to EXACTLY 5.00/10.00/20.00 = the **dead-heat** convention, so it's a lower bound and
    would underprice. The true ties-included target is N × (1 + unknown uplift) — not derivable from
    the feed. We use the RAW consensus, which sits ABOVE fair by the overround (measured sums
    6.86/13.29/25.77). Because we only ever take YES, overstating a leg makes the parlay MORE
    expensive → we can't be picked off, we just fill less. Set `GOLF_TOPN_TIES_UPLIFT` only with a
    calibrated view. **Expect top-N legs to quote rich and rarely fill — that's intended.**
- **Fails closed**: cold/stale board, unknown player, or <2 books → `null` → decline.
- Fair lookup is a **sync cache read** on the RFQ hot path (`getOutrightFairProbSync`); boards are
  warmed at line-seed time by `warmGolfOutrightBoards()`.
- **PX event names carry a market suffix** ("2026 The Open - Tournament Winner") but DataGolf's
  `event_name` is the tournament alone ("The Open Championship"). line-manager stores
  `tournamentName` = the part before the first " - ". Skip that strip and EVERY leg fails the
  event-name match and silently declines.

## Odds Sources

- **SharpAPI** (`api.sharpapi.io`): Primary source for NBA, MLB, NHL, tennis, soccer. Free tier covers DraftKings + FanDuel
- **The Odds API** (`api.the-odds-api.com`): Fallback for NCAAB. Also used on-demand for alternate spread/total lines (Pinnacle, DK, FD)
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
  - **Dead-heat objection does not apply.** golf-outrights.js prices Top 1/5/10/20 off DK
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
| `/single-leg/golf-outrights/make-cut-dryrun/:slug` | GET | Dry-run the DataGolf-priced make_cut board (no DB/PX writes). `?name=<tournament>` helps match DataGolf's event. Check `lay_ev_violations` = 0 before enabling. |
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
- **NEVER `git push` without explicit user approval.** Push auto-deploys to Railway production. Commit freely, but the push must always be gated on the user typing "push" (or equivalent) in chat. Do NOT push after completing work, do NOT push as part of a batched command, do NOT assume earlier approval carries over to a new commit. Every single push requires a fresh green-light.
