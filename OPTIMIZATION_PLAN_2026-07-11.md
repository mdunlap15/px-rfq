# Pricing & Volume Optimization Plan — 2026-07-11

Produced overnight per operator request: full review of 3 months of data (7,073 settled fills, $1.58M risk, +$25.3K, +1.60% ROI), all institutional memory, env↔code audit, network-share analysis, CLV/prod diagnostics — then every recommendation adversarially verified against code (file:line) and fresh DB scans by independent review agents. Items that failed verification were dropped or modified; rejected drafts are documented at the bottom.

## Executive diagnosis

1. **Volume**: We capture **3.3% of a $13.8M/month network**. The two biggest suppressors found are *self-inflicted*:
   - `PRICE_FLOOR_VS_CONSENSUS_PP=0.08` (live since ~7/3–7/4) is read by code as **0.08 percentage points** (code divides by 100; default is 8). It clamps 92% of consensus-covered lines to ~the vigged book price (~2pp/leg of competitiveness removed) and **halved covered main-market fills** (38/day → 18/day, −70–80% stake). This — alongside the WC schedule and the 7/9–7/10 fisher drought — is the third leg of the "volume dropped since 7/4" mystery.
   - **Prop one-fill lockout**: quote-time charges the full `MAX_RISK_PER_PARLAY_WITH_PROP=4005` against `MAX_PROP_TEAM_SIDE_RISK=4005` / `MAX_PROP_RISK_PER_GAME=5000` with no pending discount (sgp-guard.js:98–130) → **one $149 prop fill locks the whole game** (verified live in today's declines).
2. **ROI**: Calibration says realized bettor-win ≈ offered implied in every odds bucket and realized > fair everywhere — **adverse selection eats the entire charged margin; there is no room to loosen vig broadly**. All ROI repair must be segment-targeted. The vig trim of mid-June bought volume with the whole margin: multi-main ROI Apr +6.6% → Jul −0.4%.
3. **The fixes shipped in June/July work**: prop-multi May −32% → Jun +10.7%; K-props post-7/8-fix +10.5%; F5 post-floor positive; heavy-fav bucket +8.9%; prop-SGP +21.8% in July. Every previously-"unpushed" pricing commit is verified pushed and live (d36b603, 297ff31, 45e56b2, dc77fb6, 9978b10, 7478d2e, f4f84e5, 38efbfe).

## THE ENV CHANGES (apply as ONE batch, off-peak — each apply restarts the service)

### A. Volume levers (verified safe)
| Var | From → To | Why |
|---|---|---|
| `PRICE_FLOOR_VS_CONSENSUS_PP` | 0.08 → **1** | The big one. The 0.08 was a units slip (code reads pp and divides by 100; the operator's deliberate pre-7/3 value was 1). **1, not the code default 8**, is correct (operator-confirmed 2026-07-11): the healthy 6/26–7/3 fill regime ran at exactly per-leg 1 + the d36b603 parlay caps (1.0pp total / 0.0pp chalk), AND the single-leg/resting-line path has ONLY the per-leg floor (pricer.js:651-657) — at 8 a feed error could park a public resting line 8pp off consensus; at 1 every posted line stays anchored within 1pp of vigged consensus. Expect ~2× covered main-market fills (that's the measured per-leg=1 baseline). |
| `MAX_RISK_PER_PARLAY_WITH_PROP` | 4005 → **2000** | Kills the one-fill lockout (with the caps below: 3 tickets/side, 5/game). Keeps the $1–2K prop band open (since 6/25: 29W-0L, +$1,918). Caps whale damage at $2K/ticket (May 18–20 whale hit $2.7–6.2K tickets for −$22.5K). |
| `MAX_PROP_TEAM_SIDE_RISK` | 4005 → **6000** | 3× headroom vs ticket charge. |
| `MAX_PROP_RISK_PER_GAME` | 5000 → **10000** | 5× headroom vs ticket charge. |
| `MAX_RISK_SGP_EXPERIMENTAL` | 3500 → **2000** | min() with the with-prop cap makes >2000 dead anyway; 2000/5000 weekly stop-loss = tripwire fires after 2–3 max losses instead of 1.4. |
| `HEAVY_FAV_ML_CAP_BY_SPORT` | unset → **{"tennis":-600}** | Quantified: 64% of July tennis heavy-fav declines clear at −600; 72% of the network-matched ones are capturable (~$9.6K/mo pool at measured tennis +13.5% ROI). Merges over defaults (NBA −300, MMA −450 unchanged). |
| `VIG_BY_SPORT` | tennis 0.025 → **0.022** | Only change to this map. Tennis positive every single month, 2.0% share of $464K/mo network segment, auction losses at 3.5% median gap. **Do NOT raise soccer here — see rejected items.** |

### B. ROI repair (segment-targeted, verified correctly-signed)
| Var | From → To | Why |
|---|---|---|
| `VIG_BY_LEG_COUNT` | "3": 1.16 → **1.30** (rest unchanged) | 3-leg = $416K risk at +0.11% all-time, **−1.22% post-6/25**. Move is ~0.3% decimal (10× smaller than the median auction gap) — low volume risk. Honest sizing: ~+$0.3K/qtr, not a windfall; right-signed. |
| `SGP_CORRELATION_BY_COMBO` | fav_over 1.25 → **1.30**; everything else UNCHANGED: `{"spread_total":1.15,"ml_total":1.15,"spread_fav_over":1.30,"spread_dog_under":1.08,"spread_fav_under":1.08,"spread_dog_over":1.08}` | 1.30 is the FD-calibrated value for the most positively-correlated combo. The 0.95 code defaults for fav_under/dog_over were REJECTED by verification: they're uncalibrated theory, contradicted by a real incident (tennis fav_under offered +251 vs DK +170 — books price it as POSITIVE correlation). **Monitor `/sgp-experiments` pxSubmitErrorsByCombo after applying — any PX rejections → drop fav_over back to 1.25.** |
| `VIG_LONGSHOT_THRESHOLD` + `VIG_LONGSHOT_MAX_ADD` | 0.16 → **0.25** AND 0.058 → **0.036** (must move TOGETHER) | The 0.16–0.25 fair band is a dead zone: no longshot add, $247K risk, −1.05% ROI, sitting between two positive neighbors. The paired MAX_ADD cut keeps fair-0.10 pricing exactly neutral and slightly LOOSENS deep longshots (post-6/25 +1.23%) while adding margin only in the dead band. Applying the threshold alone would hike the whole band — don't. |
| `VIG_F5_MIN` | 0.023 → **0.030** | F5 ML/totals bled −14 to −18% May–June; floor live since 7/3; fills held 12–17/day even at the 0.05 floor era, so volume risk minimal. Covers all `first_5*` markets (single knob — verified; the "+11% run line" didn't replicate). |
| `VIG_DNB_FAV_MARKUP` | 0.042 → **0.055** | The soccer leak is DNB heavy favorites specifically: +9.7pp bettor edge (n=267, ~4σ); totals are PROFITABLE (+4.75%). The markup env only actually activated 7/3 (June bled with it off). 0.055 ≈ +1.4pp on a 78% fav, delivered only to the measured leak. Re-verify after WC ends (~7/19). |
| `VIG_RFI_MIN` | 0.025-live → **0.03** | Restore code default; RFI flow is ~$40/parlay — costs nothing. |
| `RFI_MAX_RISK` | 3000 → **1000** | RFI has 4 settled fills / $159 risk ever — zero calibration, and the known v1 gap (no RFI↔game-total correlation penalty) was designed to be bounded by a small cap. One $3K loss = ~90× all RFI profit to date. (500 if you want textbook-safe; ratchet up after ~100 settles.) |
| `TEMPLATE_RAMP_MAX_STAKE` | unset (off) → **1500** | Built + pushed (7478d2e), dark. Every historical blow-up day was duplicate-stakes, not correlation (Rockies 9×, MMA-card 9×, Over-9 4×). Sim: ≈+$3–4K/mo net. |
| `MAX_CONCURRENT_MARKET_PAYOUT` | unset (off) → **15000** | The one unbounded tail left (league-wide HR night). Designed cap, currently off. Watch `/status` limit-decline counters; raise if it ever binds on legit flow. |

### C. Instrumentation (the arbiter of all future prop decisions)
1. Run `migrations/prop_settlements.sql` in Supabase (one-time).
2. Set `PROP_SETTLEMENT_ENABLED=true`.
3. `POST /settle-props {"sinceDays":30}` to backfill.
   Both prop-SGP combos quote live while `prop_settlements` has **0 rows** — the live correlation calibration and bettor-edge-vs-price signal are completely dark. This closes the loop.
4. `SGP_PROP_VIG_MULTIPLIER=1.2` — explicit pin of the current inherited value (no behavior change; decouples prop-SGP margin from future game-line SGP changes; July's best segment at +21.8%).

### D. Deletions / hygiene
- **Delete** `SHARP_ODDS_API_KEY` (dead — code requires `SHARPAPI_ENABLED=true` which is unset; subscription cancelled 6/25).
- **Delete** `TOA_PRIMARY_SPORTS` (legacy migration toggle; unset = TOA-primary for all flip-gated sports — safer, future-proof).
- **DO NOT DELETE `MAX_EXPOSURE_PER_PLAYER_BY_SPORT="{}"`** — it looks like a no-op but is LOAD-BEARING: deleting it re-activates the code default `{basketball_nba:200, icehockey_nhl:200}`, which (vs the 2000 ticket charge) would 100% structurally decline every NBA/NHL prop parlay next season. This exact bricking has happened before (May 24–Jun 1: 80K+ player-exposure declines from a 5005-charge/5000-cap off-by-5).
- Optional cleanup (zero behavior change, values == code defaults): DECLINE_ANOMALOUS_*, DEVIG_FAV_MAX_SHARE, PARLAY_LEVEL_VIG, PROP_ALT_LINE_MAX_DISTANCE, TEMPLATE_RAMP_DECLINE_AT/TIER3/WINDOW, RESOLVE_INLINE_*, PX_RESTING_CAP_MULT, QUOTE_HORIZON_DAYS, SUPPORTED_SPORTS, GOLF_OUTRIGHTS_ENABLED, SGP_NESTED_SOCCER_GS_SOT, MAX_EXPOSURE_PER_TEAM.

### E. Explicitly KEEP unchanged (verified correct)
`DEFAULT_VIG=0.016`, MLB 0.015, WNBA 0.023 · `VIG_PROP_FLOOR=0.035` (props filling at ~breakeven; cutting pushes negative, raising kills the recovered fill flow) · `MIN_THEO_EDGE_PCT=1.2` (raising trades volume superlinearly) · `STALE_PROP_SECONDS=2400` + TOA_PROP_TTL/REFRESH_AHEAD (coherent package — never tighten one alone) · `PENDING_RESERVATION_DISCOUNT=0.1` · template-ramp tiers/cooldowns (bot defense working as intended) · chalk-stack knobs · `MAX_LEGS=12`, `MAX_ODDS=8000` · 4–12 leg vig multipliers (5–8 verified adequate post-fixes; do NOT raise further).

## Rejected draft items (so they don't come back)
- ~~Raise soccer `VIG_BY_SPORT` 0.023→0.028~~ — mathematically impotent vs the DNB gap (+0.08pp vs 10pp) and taxes soccer totals, which are +4.75% profitable. DNB markup is the right lever.
- ~~`MAX_EXPOSURE_PER_PLAYER_BY_SPORT={"nba":2000,...}`~~ — false premise; env `"{}"` is set and working (default 5005 applies). Setting 2000 would *tighten* and brake NBA relaunch.
- ~~Cross-game corr factor on `player_hitter_hr`/`player_goalscorer`~~ — cross-game HR parlays are measured PROFITABLE for us (+1.87%, n=342; bettors 11-for-342). A 1.08^(games−1) factor would kill a winning segment. Tail risk is handled by MAX_CONCURRENT_MARKET_PAYOUT + TEMPLATE_RAMP_MAX_STAKE instead.
- ~~`SGP_CORRELATION_BY_COMBO` 0.95s for fav_under/dog_over~~ — uncalibrated; books price some of these as positive-correlation (tennis incident).
- ~~`MAX_RISK_PER_PARLAY_WITH_PROP=1000`~~ — forfeits the measured-profitable $1–2K band; 2000 keeps it while still fixing the lockout.

## Follow-up build backlog (code, not env — next sessions)
1. **Soccer prop sourcing** — the #1 structural volume gap: $1.28M/mo unregistered soccer prop legs at 0.4% share (MLS allowlist-key mismatch `soccer_usa_mls.*` vs stored `soccer.*`, plus no TOA source for MLS props → needs DK-scraper sourcing).
2. **Negative-odds guard re-validation** — 2,703 network parlays/mo fill at bettor-negative total odds; we blanket-decline (pricer.js:2769–2777 sign-flip gotcha). Real capturable volume if the PX sign convention is re-verified.
3. **CLV instrument repair** — `/clv-report` ignores `days`; closing-line persistence is write-only (2,209 rows never hydrated on boot → every restart destroys coverage). Coverage only 10.9%.
4. **Prop ledger pending-discount** — the structural fix behind the lockout: charge quote-time addRisk at a realistic stake estimate (p90 ≈ $500) instead of the full cap, mirroring order-tracker's pendingReservationDiscount.
5. **Boot-time warn** when any player cap < the with-prop parlay cap (the silent 100%-decline state; has happened twice).
6. **Whale decision — creator `45628ef7-dbdb-46f9-b143-3f47822a9013`**: the May 18–20 cross-sport prop whale (−$25,830 in 3 days; 2-leg prop+home-ML fingerprint at $1.5–3K bettor stakes; +62% lifetime ROI vs us; NOT blocked; still probing the identical shape at $4,500 maxRisk on 7/9). 0-for-6 since the K fixes. Recommend BLOCK on precedent (blocked others at 10× less damage) — they self-select when a misprice reopens. Awaiting your call.
7. **Unexplained 06:30Z service restart** on 7/11 + 13 TOA fetch timeouts in 15 min — check Railway deploy/crash logs; odds-feed reliability remains the top non-price volume threat.
8. Update CLAUDE.md: remove SHARP_ODDS_API_KEY from required env.

## Monitoring after applying (first 48h)
- `/status` → rfqStages funnel: submitted/received should rise as the consensus clamp lifts; `priceFailed` stays ~0.
- `/sgp-experiments` → `pxSubmitErrorsByCombo` must stay empty (fav_over 1.30 probe).
- Prop declines: `prop-game-cap` reasons should drop to ~0 (lockout gone).
- `/prop-correlation?days=60` populates once settlements backfill — then prop pricing decisions get an evidence loop.
- Daily P&L by class: watch 3-leg, F5, DNB-fav, 0.16–0.25 band ROIs; and covered main-market fills/day (expect ~2×).
- The mid-odds (30–50% implied) post-6/25 wobble (realized 2–3.5pp above implied, ~1.2σ) — watch, don't act yet.

## Expected net effect (honest ranges)
- Volume: covered main-market fills ~2× (clamp restore) + prop concurrency unlock + tennis pool (~$9.6K/mo) + auction wins from tennis trim. The $1.86M/mo "lost auctions at 3.5% median gap" pool is the ceiling the clamp restore chips at.
- ROI: +0.5 to +1.5pp on the repaired segments (3-leg, F5, DNB-fav, dead-band, fav_over) without touching the healthy core; whale tail capped at $2K/ticket; slate tail bounded.
- Nothing in this plan loosens price where calibration shows adverse selection already eats the margin.
