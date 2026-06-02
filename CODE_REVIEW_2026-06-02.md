# Full-app review — 2026-06-02 (overnight)

Mike asked for a thorough review while offline. Six parallel deep-reviews ran
across the whole codebase (pricing, odds/lines, order-tracking/P&L, WS/startup,
client, golf/scrapers). **Nothing here is pushed.** Held commits are local only,
each gated on your explicit "push".

---

## TL;DR

- **Caught a critical bug in my OWN held work** before it could ship: the matchup
  sweetener commit would have crashed the entire golf-single-leg pipeline
  (wrong `require('../config')` shape → `config.pricing` undefined → TypeError).
  Fixed + runtime-verified. Also fixed the same latent bug in `px-single.js`.
- **Found and fixed the boot-retry root cause** you've been chasing: zombie
  Pusher clients racing the shared connection state. (held — wants a sandbox test)
- **Fixed the 2-minute / 200k-row rollup query** that was running back-to-back
  every 60s. (held — stopgap + a real SQL-RPC migration to run)
- Plus dead-code removal and a data-integrity fix.
- Everything below the "HELD COMMITS" line is **flagged, not changed** — either
  too risky to deploy without your eyes, or it needs a pricing/product decision.

---

## HELD COMMITS (in push order, oldest first)

Origin is at `6931861` (the revert). To deploy, review and push.

| # | commit | what | risk |
|---|--------|------|------|
| 1 | `b80d277` | Restore matchup fairProb cache fallback (the reverted logic; it was correct) | Low |
| 2 | `6d7171d` | Single-leg matchup sweetener (`GOLF_SL_MATCHUP_SWEETENER_PCT`, default 0.07 → Caesars-style -125/-106) | Low |
| 3 | `f2da6a4` | **CRITICAL** config-import fix in golf-single-leg + px-single (makes #2 actually run) | Low |
| 4 | `10212d7` | **Boot-retry root cause** — kill zombie Pusher clients, single-flight connect | Med |
| 5 | `a971d73` | Rollup perf — 10min refresh + DESC truncation + `scripts/_declines_rollup_rpc.sql` | Low |
| 6 | `f67f9e1` | Dead code removal (buildOffers, computeCorrelationBoost, dup keys, etc.) | Low |
| 7 | `f721994` | saveDecline: scope warn-once to schema errors (don't silence real outages) | Low |

**Important sequencing:** commits 1+2 are inert without 3. If you push the
sweetener, push 1–3 together. Commit 4 (boot-retry) is the high-value one but
it touches the live connect path — I'd smoke-test a `/reconnect` in sandbox
first. Commit 5's `.sql` file is a migration **you run in Supabase**; the code
stopgap works without it.

### On the sweetener (your spread-too-narrow complaint)
The narrow Gotterup -111 / English +106 you saw was NOT the fairProb fix — it
was that golf matchups were routing through the parlay-SP vig stack
(`vigGolfMatchupMin` 0.04 → ~1.3% pair vig). Commit #2 bypasses that for the
single-leg book and applies a flat per-side markup. At the 0.07 default:
`fair 0.52 → -125`, `fair 0.48 → -106` → **7.0% pair vig**, matching Caesars.
Tune via `GOLF_SL_MATCHUP_SWEETENER_PCT`. If you want **per-matchup** control
(different markup per pairing), that's a small follow-up (config column + UI).

---

## FLAGGED — NOT CHANGED (your call)

### A. Money-path / pricing — recommend, but I won't deploy blind

1. **Spread direction-mismatch declines priceable legs** (`odds-feed.js` ~5180).
   When a requested spread has the same magnitude but opposite sign of the
   cached primary, it skips straight to the alt cache and returns null —
   without consulting `market.byLine['<sel>|<signed>']` which is already built.
   You're declining gettable business. Fix is additive/low-risk but changes
   live pricing, so I'm flagging not shipping. (This is the `Spread direction
   mismatch: home cached -1.5 vs requested 1.5` log line.)

2. **Golf outrights post ~1% over DK's *vigged* implied** (`golf-outrights.js`
   ~198). Default sweetener 0.01 is applied to DK's already-overround price
   (winner markets carry 30-40% overround). If YES fills, you may be
   systematically -EV. **This is a pricing-policy decision, not a bug** —
   confirm intent. Likely should de-vig DK's overround first, then add markup.

3. **DataGolf tie-handling** (`datagolf.js` ~174). `round_matchups` (ties→void)
   and `tournament_matchups` (some books settle ties→lose) are de-vigged
   identically as pure 2-way. Overstates the favorite's fair on tie-possible
   tournament matchups. The 7% sweetener cushion probably covers it, but it's a
   latent fair-value gap. Changing it shifts fair values → wants your sign-off.

### B. Performance — real, but bigger changes

4. **Per-event TOA supplement re-runs every cycle** (`odds-feed.js` ~902/1234).
   The `matchFails=1` log spam you see: games that structurally lack TOA F5/H1
   are re-attempted every 10-min refresh (+ a 60/120/240s retry chain) because
   there's no negative cache for "no event found." Add a short negative-cache.
   Med risk (TTL tuning).

5. **Client dashboard renders everything every 10s** (`index.html`
   `refreshDashboard`). All 13 Analytics SVG charts + heatmap + market intel +
   both history tables re-render on every tick even when the tab is hidden, and
   two maps (`orderState.allOrders`, `historyState.orders`) grow unbounded and
   get fully re-sorted each tick. Biggest client CPU/memory win = gate heavy
   renders on the active tab. Larger change; flagged.

6. **Puppeteer: no global Chromium concurrency cap** (`dk-scraper.js`). Distinct
   scrape types each `launch()` independently; on Railway's memory ceiling this
   is the most likely cause of the 50-85s scrapes returning 0 results
   (Chromium starved → Akamai challenge times out). Add a semaphore (max 1-2)
   or one long-lived browser. Med risk (touches every scrape entry point).

### C. Correctness / robustness — low–med, flagged for the money path

7. **P&L counter drift** (`order-tracker.js`): `revertBogusSettlements`
   increments `totalConfirmations` with no symmetric decrement on settle;
   `totalWins/Losses` increment on result but decrement on `pnl>0/<0`, so a
   `pnl===0` win drifts. **These are COUNT drifts, not dollar drifts** — the
   runningPnL dollar total is symmetric and correct (verified). Relevant to win-
   rate displays, not your "P&L far off" report. One-line fixes but in the
   settlement path → flagged.

8. **Paginated readers missing ORDER BY tiebreak** (`db.js` `getDailyPnL`,
   `loadOrdersInDateRange`, `loadFillBucketRowsSince`). Per your own memory note,
   offset pagination over a non-unique sort key can double/skip rows at page
   boundaries. `loadOrders`/`loadMatchedParlays` already have the tiebreak;
   these don't. Low risk but it's the P&L read path → flagged for your review.
   (I added the tiebreak to `loadDeclinesSince` since I was already touching it.)

9. **Team-name substring matcher false positives** (`line-manager.js` ~456).
   Substring fallback ("City" ⊂ "Manchester City") with no length floor /
   uniqueness check → cross-game contamination risk. Med risk to fix (could
   drop currently-working fuzzy matches); wants metrics before tightening.

10. **viewer.html dropped the `safeRender` hardening** the admin file has — one
    throw in any render freezes the whole read-only viewer refresh. Med-ish;
    flagged (it's in the 14k-line duplicate file).

### D. Golf single-leg (currently DISABLED — zero live risk until you enable)

11. **No tee-off cancellation** despite the header advertising it — a wager
    stays live into tee-off as long as PX lists the line. Build this before
    enabling the SL bot.
12. **Drift check compares against ladder-snapped odds**, not `posted_fair_prob`
    → constant snapping bias, can cause spurious cancel/repost churn. Clean fix.
13. **Posted-but-unrecorded wager risk** if PX's `succeed_wagers[]` doesn't echo
    `external_id` — verify the response shape against live PX before enabling.

### E. Maintainability (opportunistic, large)

14. `index.html` / `viewer.html` are ~14k lines of near-duplicate code that has
    already diverged (see #10). Extract a shared `dashboard-core.js`.
15. Shared `scraper-utils.js` (launch/devig/odds-converters duplicated 3-7×
    across scrapers, with subtly different de-vig variants).
16. Unify `computeSingleLegVig` / `getEffectiveVig` (documented "must mirror
    exactly" = standing drift hazard).

---

## P&L "far off after deploy" (your earlier report) — conclusion

The deploy restart's boot reconcile (`revertBogusSettlements` + GhostReconcile)
net-shifted running P&L by only ~$74 from the visible log window — far too small
to read as "far off." The dollar total is computed symmetrically (verified).
Most likely you were comparing different views (Daily Volume chart vs `/me`
realized vs cumulative) which legitimately use different sources. When you see
it next, screenshot the Analytics tab + `/me` realized side-by-side and I can
direction-find. (Counter drifts in C-7 affect win-rate %, not dollars.)

---

## What I did NOT touch
Anything live-money-path or large that couldn't be verified without you:
pricing-curve changes, the spread byLine fix, supplement caching, client
render gating, Puppeteer concurrency, the settlement counter fixes, the P&L
read-path tiebreaks. All flagged above with specific file:line so you can pick
them up surgically.
