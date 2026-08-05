<!-- Generated 2026-08-05 from a 23-agent verified sweep. Every hypothesis was
     adversarially re-tested; the claimed-vs-corrected dollar column below shows how
     much did not survive. Read section 5 before re-litigating anything. -->

# Assessment
**px-rfq model performance — 30 days to 2026-08-05**
Prepared for Mike. All dollar figures on OUR risk (`confirmed_stake`). MEASURED = computed from `dd90_fills.json`; ESTIMATED = modelled.

---

## 1. Is it variance?

**Yes. Overwhelmingly. Roughly 80–90% of the shortfall is variance and ticket concentration; at most $1.5–3.0K/30d is recurring, capturable mispricing.**

The direct tests:

| Test | Result | Verdict |
|---|---|---|
| 30d P&L vs correctly-calibrated MC null (200k sims) | observed −$5,773 vs null mean **+$7,504**, SD $13,534 → 16.4th pct, z=−0.98, **p=0.328** | not significant |
| 14d P&L | 9.1st pct, **p=0.183** | not significant |
| "Monotonic deterioration" — permutation on ticket order (100k) | residual-ROI spread 3.26pp, **p=0.370**; P(monotone 3-block decline by chance) = **0.163** | not a trend |
| Per-ticket calibration, 90d, vs raw `meta.fairParlayProb` | +1.83pp, z=3.80, p=1.4e-4 | **artifact — see below** |
| Same test, **void-adjusted** (divide fp by the fair of legs that later voided) | **+0.40pp, z=0.82, p=0.41** | not significant |

**The single significant result in the entire investigation was an accounting artifact.** `meta.fairParlayProb` is the product of *all* legs including ones that later voided; the parlay is then graded after repricing, with the void legs removed — which is strictly easier for the bettor. 8.7% of 30d tickets carry a voided leg (golf 21.8%, soccer 29.2% over 90d). Correcting for it kills 78% of the "bettors beat us by 1.83pp" signal: **z 3.80 → 0.82**. Every golf, lead-time and prop-under z-score in this sweep is inflated by the same mechanism.

Two more things that dissolve on inspection:

- **The "monotonic deterioration" is a binning choice.** Rolling 30d windows: a window ending **50 days ago was worse (−$15,041 shortfall) than the current one (−$13,427)**. It is invisible in 0/30/60/90 bins because it straddles a boundary. There is no monotone trend to explain.
- **Three tickets are 105% of the entire 30d shortfall.** Five PX events are 92% of it. Bootstrap 95% CI on the 30d shortfall: **[−$41,270, +$12,446]**.

Also note what did *not* change: charged margin **rose** monotonically (median markup over fair 4.01% → 5.55% → 6.83%), model expected ROI was flat (1.10% / 1.04% / 1.24%), and CLV stayed positive (+0.99 / +1.18 / +1.04pp). We are charging more and earning less — the opposite of a give-away-price signature. "We cut price" and "we're being picked off" are both **refuted**.

**Decision: do not restructure the book. Do not cut volume. Fix two small real things, add instrumentation, and stop reading month-to-month P&L as signal — you do not have the sample size to.**

---

## 2. What actually happened — attribution that sums

Partition of the **30d shortfall vs model** (realised −$5,773 = model EV +$7,671 + shortfall −$13,444). Ticket sets are disjoint and verified non-overlapping.

| Cause | n tickets | 30d shortfall | % of shortfall | M/E |
|---|---:|---:|---:|:--|
| **Three tail tickets** (dafce62f 2-leg MLB ML $5,498; 488d07fc 2-leg MLB K-props $4,495; 25e39917 5-leg MLB totals $3,949) | 3 | **−$14,058** | 105% | M |
| **Whale f49612dd, golf matchups, 3M Open week 7/23–7/26** | 7 | **−$7,462** | 56% | M |
| **Near-lock / prop-under cluster** (creator 0380a6c9, one ≥0.90 leg bolted to one real coinflip) | 15 | **−$3,927** | 29% | M |
| **All other tickets** | 1,978 | **+$12,003** | −89% | M |
| **Total shortfall** | 2,003 | **−$13,444** | 100% | M |
| Model expected P&L | | +$7,671 | | M |
| **= Realised P&L** | | **−$5,773** | | M |

**The complement of every named "leak" is running HOT (+$12,003, z=+1.07), not cold.** That is the arithmetic signature of segments selected *because* they lost — not evidence that the segments are real.

Of the named buckets, how much is structural (i.e. would recur):

| Bucket | Total | Recurring / capturable | Basis |
|---|---:|---:|---|
| 3 tail tickets | −$14,058 | **$0** | pure variance; no pricing defect found on any of them (worst ticket carried only a 2.4% markup but was correctly priced) |
| Whale golf | −$7,462 | **~$450–$1,300** | ex-whale 30d golf is **−$445 (z=−0.12)**, sitting on model; golf since 7/30 is **+$1,274 (+$1,105 vs model)** |
| Near-lock cluster | −$3,927 | **~$2,500** | ESTIMATED: repricing at the measured 1.88× still leaves E=−$2,420; the rest is variance. **Flow is dormant** — zero fills with max-leg fp≥0.85 since 2026-07-30 |
| **Total recurring** | | **~$1,500–$3,000/30d** | |

**UNEXPLAINED: essentially all of it.** After removing everything defensible, ~$10.5–12K of the −$13.4K shortfall is unattributable and statistically indistinguishable from zero.

Two accounting notes on the headline number:
- The reported **−$5,773 is already net of $8,824 of void relief**. 45 of 400 lost tickets settled for less than nominal risk — all 45 are push-containing, mechanism verified (liability shrinks correctly on void; we still collect full stake on wins). On a nominal-risk basis the 30d figure is **−$14,597**. You should decide which one is "the" P&L; the verdict is identical either way.
- The over-attribution problem in the raw analysis was severe: the seven hypotheses claimed **−$37,950** against an actual −$5,773 (6.6×). After verification: −$9,157 (1.6×), and even that double-counts.

---

## 3. Root causes, ranked by defensible dollars

### #1 — Near-lock leg makes a parlay a de-facto single bet — ~−$2,500/30d (ESTIMATED, dormant)
**Mechanism.** One leg priced 0.92–0.98 (`player_hitter_hr under 0.5`) bolted to one genuine coinflip prop. The parlay is priced with parlay discipline (leg-count vig ladder) but is economically a single bet, so the real leg's model error passes through undiluted against only a 6.5% markup.
**Evidence.** 30d n=15, risk $3,979, P&L −$3,844, ROI −96.6%; model 39.4% vs realised 93.3%. Void-adjusted z=**3.97** (the only segment besides MMA that survives the void correction). Cluster bootstrap over 52 90d clusters P=0.006; leave-one-cluster-out worst t=−2.39; threshold-stable 0.85–0.95, collapses at 0.80. Causal test: within prop-under parlays, **without** a lock n=167 z=0.49; **with** a lock n=11 z=4.32 — the lock is the mechanism, not the prop side.
**Cost.** −$3,927 realised; ~−$2,503 structural. **But 74% of it is 2 game-days and the flow stopped 2026-07-25.** Forward capture ≈ $0 unless it returns.
**Existing guard cannot fire:** `vigChalkStackSurcharge` = 0 *and* its trigger requires **every** leg > 0.60 — the exact opposite shape.

### #2 — Golf matchup leg fairs run ~3–5pp low — ~−$450 to −$1,300/30d (ESTIMATED, weak)
**Mechanism.** Golf matchup legs are `bookPriceOverride` legs: `vigLegs` is empty and the offered price is literally the naive product of DK's raw book prices — **zero house vig**. 225 of 230 fills match the naive product to <0.5%. Expected edge is DK's own ~2.6pp/leg overround and nothing else.
**Evidence, honestly stated.** Ex-whale 30d golf = **−$445, z=−0.12** (on model). Void-adjusted ex-whale calibration z=**1.26** (not significant). The direct correlation test refutes the same-tournament story: 2,947 within-(tournament,round) pairs give ρ = **−0.005** [−0.037, +0.020] → implied c ∈ [0.96, 1.02]; the claimed c=1.255 requires ρ=0.295, 15× the point estimate. The 90d MLE on the correct (offered) base is c=1.128 [0.984, 1.260] — **c=1 not rejected** — and dies entirely under cluster bootstrap and ex-3M-Open (c=1.059, p=0.494).
**Real defect found, worth fixing as correctness not as revenue:** `golfFactor` in `services/pricer.js` L2100 is declared inside its own block, only multiplies `fairParlayProb`, and is **absent from `sgpFairMultiplier` (L2371-2378)** — the sole channel to `offeredImpliedProb`. It reaches the price today only by accident through `VIG_MIN_PP=0.12` (config default 0). No meta field records whether it fired.

### #3 — Structural thinness: 61% of risk earns 22% of the edge — not a leak, a capacity fact
`ROI_on_risk = (op−fp)/(1−op) = hold_on_handle ÷ leverage`. 30d: hold 6.47% of $118,577 handle, but $618,254 of risk → leverage **5.21×** → ROI **1.24%**. Risk-weighted *absolute* margin is a near-constant 0.5–1.3pp everywhere; the 57% relative markup on 8-leg tickets is worth 0.58% ROI while a 4.8% markup on 2-leggers is worth 1.65%. **Portfolio signal/noise is 0.56σ per 30 days.** $378,318 (61% of risk) sits in tickets with expected ROI <1%, delivering $1,694 (22%) of edge at 0.24σ. This is why a 1pp calibration error erases everything, and why P&L cannot referee any of these decisions.

### #4 — MMA leg fairs (WATCH, do not act)
The only other segment surviving the void correction: 30d adj z=**2.43**, MMA moneyline legs model 59.44% vs realised 69.03% (n=226). But out-of-sample k collapses **1.168 → 0.980** on days 31–90, and MMA is **+$896 realised** in 30d — the wide `vigMmaMin`=0.03 is covering it. Real risk: if MMA margin is ever trimmed for competitiveness, this flips negative immediately.

---

## 4. The plan

### (a) Ship now — cheap, low risk

| # | Change | Expected 30d $ | Confidence | Effort | Risk of doing it |
|---|---|---|---|---|---|
| 1 | **`services/prop-settlement.js` `_settleLeg` (~L85): side-aware grading.** `need = Math.ceil(line)` never reads `leg.selection`, so `parlay_won` is inverted for every UNDER leg (144 of 2,292 our MLB hitter-prop legs). Carry `side` into `leg_results`. Then re-run `POST /settle-props` with a wide `sinceDays`. | $0 P&L | **High** (verified by file read) | 1h | None. `/prop-correlation` is currently reporting the opposite of truth for under legs — every factor it feeds is contaminated |
| 2 | **Near-lock hardening, `services/pricer.js`:** exclude any leg with `fairProb >= 0.90` from the `vigByLegCount` leg count, so lock+coinflip is priced with single-bet discipline. Add `VIG_LOCK_LEG_THRESHOLD` (0.90) + optional `VIG_LOCK_LEG_SURCHARGE` (~0.15) as the secondary. Do **not** set the threshold at 0.80 — 0.80–0.90 buckets are +$2,537 over 90d. | **$0 today, ~$2,500/30d if flow returns** | Med-high (adj z=3.97, bootstrap p=0.006) | 2–3h | Segment is 0.6% of 30d risk. Even declining it outright is +EV. Near-zero volume risk |
| 3 | **Golf wiring + observability, `services/pricer.js`:** hoist `golfFactor` out of its block, add it as a term in `sgpFairMultiplier` (L2371-8), and emit `meta.golfCorrFactor` + `meta.golfTournamentGroups`. **Set the factor at 1.0**, not 1.22. | $0 | High (code verified) | 2h | Shipping it at 1.22 would over-price 2-leg tickets by 22% where measured m=0.954 (n=99) — and 2-leggers are >half the golf book. **Ship the wiring, not the number** |
| 4 | **Golf margin decision (policy, not a bug).** Golf matchups quote at exactly the naive DK product with **zero house vig** on $76K/30d of risk. Either add a deliberate golf leg markup (~+2–3pp) or accept ~$0 expected edge there consciously. | ESTIMATED +$500–1,000 | Low-med | 1h | **We are the clearing price on 248/248 golf parlays over 90d** — the elasticity estimator has zero support, so "captive demand, zero volume cost" is unmeasurable. Realistic downside is losing a large share of golf volume. If you want less golf, say so and own it |
| 5 | **`AUTH`-adjacent hygiene: fix the inverted CLV sign comment** at `services/order-tracker.js:1553-1555` and `index.js:9140` ("positive = bad for SP"). Empirically clvDelta Q1 → Q4 runs −5.70% → +15.52% ROI. | $0 | High | 15min | None. It's a dashboard-misreading trap |
| 6 | **WNBA vig +2pp** via `VIG_BY_SPORT`. | **+$134** [CI $39–$274], P(loss)=0.003 | High (166 parlays, 87 fills, 0 ties, retention 95/89/79%) | 15min | ~0.01σ — will never be visible in P&L. Ship because it's free, not because it matters |

### (b) Needs a build — instrumentation first, then decisions

| # | Change | Value | Effort |
|---|---|---|---|
| 7 | **Void-adjusted calibration everywhere.** Every calibration surface (dashboard, `/prop-correlation`, any future analysis) must grade against the product of *surviving* legs, never raw `meta.fairParlayProb`. Persist `meta.voidAdjustedFairProb` at settlement. | **Highest analytic value in the list.** Without it we will re-manufacture this entire investigation next quarter | 1 day |
| 8 | **Per-EVENT and per-creator-per-event exposure cap.** 5 PX events = 92% of the 30d shortfall; two of them are one golf round where one creator took two tickets sharing the same two legs. | Variance reduction, not EV. Note: I measured the **per-parlay** cap counterfactual and it is value-destroying — cap $2,000 gives −$5,050 (roi −0.97%) vs −$5,773 (−0.93%), and is *worse* in the 30-60d block. Cap at the **event/creator** level, not the ticket level | 1–2 days |
| 9 | **Dashboard: report absolute margin `(op−fp)/(1−op)`** alongside relative markup in the Config/Runtime tab. A 57%-relative-markup 8-leg ticket reads "safe" and earns 0.58% ROI on risk. | Prevents mis-tuning | 3h |
| 10 | **Raise closing-line snapshot coverage.** Currently 15% of fills, **0% for golf**, and the covered subsample realises at z=−2.02 while the uncovered 85% realises at z=+5.06 — the only unbiased staleness instrument has essentially no power. Also persist `validateForConfirmation`'s repriced fair as `meta.confirmFairParlayProb` + a drift-rejection counter (confirm reject rate is currently **unobservable**). | Enables the next investigation | 1 day |
| 11 | **One-sided confirm drift gate**, `services/pricer.js:4832`. `Math.abs()` rejects confirms where the fair moved **in our favour**. Change to signed, but **keep a magnitude sanity bound on the favourable side** (the symmetric gate doubles as a guard against a corrupted reprice, e.g. a one-book fair collapsing). | $0 today (0/455 same-line pairs move >1% inside 120s; median quote→confirm 7.5s) | 1h |

### (c) Needs more data — do not act yet

- **Golf leg-fair markup beyond a token +2–3pp.** Ex-whale adj z=1.26. Re-measure after ~100 more golf tickets, using the void-adjusted grade.
- **MMA.** Pre-register a re-test at +120 fights. Both an in-sample vig raise (k collapses 1.168→0.980 OOS) and doing nothing are defensible; do nothing.
- **Near-coinflip band (0.50–0.60) shading.** Train z=3.11, **holdout z=0.78**. Ex-golf/ex-MMA the 30d in-band gap is +0.36pp. Re-fit on a fresh holdout.
- **WNBA props / `run_first_inning`** — flip sign out-of-sample. Watchlist with pre-registered re-tests at n≥800 and n≥300 legs.
- **`matched_parlays` tranche structure.** We are the **marginal (deepest) fill in 891/892 (99.9%)** of our fills since 7/24 — no tranche ever cleared worse than our price. That is a more important structural fact than anything in the pricing analysis and nobody has investigated what it implies about our position in the book.

---

## 5. What NOT to do

Each of these was tested and refuted. Do not re-litigate.

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **We cut price / are being picked off** | **REFUTED** | Median markup rose 4.01% → 5.55% → 6.83%; CLV +1.04pp (t=5.36) in the last block; risk-weighted CLV 0.87/0.91/0.77pp |
| **Winner's curse / high fill-rate segments are cursed** | **REFUTED, 5 ways** | Risk-weighted WLS of segment ROI on win-rate: slope **+4.97pp** (t=0.48) — wrong sign. Golf is a **54/54 monopoly** (zero distinct rival prices) so no auction exists. Golf 88.9% capture = −9.29% ROI vs WNBA 52.4% capture = +19.1% ROI, same stratum. Worst-calibrated sport (MMA) is one of the *lowest*-capture. Calibration did **not** worsen as competition tripled |
| **Any capture-rate / fill-share decline gate** | **DO NOT BUILD** | Swept every threshold: only cut that helps is "decline golf" (identical numbers); **every threshold below 70% destroys $700–$3,600 of 30d P&L** |
| **Soccer is a second golf** | **REFUTED** | Naive z=3.93 was 70% void artifact + 30% leg-sharing. Leg-sharing-aware MC z=0.13. Every correlation axis null (same-matchday φ=1.035 [0.84,1.26]). Soccer **made +$954** in 30d on 2.4% of risk. Worst-5 soccer tickets = 318% of the 90d net loss |
| **Leg fair values are miscalibrated** | **REFUTED** | 90d n=16,304 legs: model 51.80% vs real 51.99%, +0.19pp, z=0.28. 30d +0.58pp, z=0.61. Out-of-sample correction of every segment simultaneously: **−$626**. Stop tuning fairProb |
| **Favourite-longshot bias needs correcting** | **REFUTED — wrong sign** | b=1.082 (>1, we *overrate* longshots = conservative), and it vanishes ex-HR-props (b=1.021 [0.881,1.147]) |
| **SGP combos are leaking** | **REFUTED — profit centre** | +$14,143 on $123,482, every combo positive. Needed correlation factors are **below 1.0** (ml_total 0.86, spread_total 0.83, kprop_kprop 0.54) vs configured 1.15/1.072. The entire book-level miss is *outside* SGP (non-SGP z=4.86). If anything there's room to loosen |
| **Populate `crossGameCorrByMarket`** | **DO NOT** | Every category tested lands at corrFac ≈1.0, all \|z\|<1.2. Cross-game HR stacking φ=0.87 [0.70,1.04] — the commented `player_hitter_hr:1.08` suggestion is contradicted by 3,359 tickets |
| **MoV tails / `MOV_MIN_PARLAY_PROB`** | **FINE** | n=11, +$220, longest MoV fill dec 69.4. The longest odds in the whole 90d book (dec 135–151) are HR/SB prop parlays, all profitable. No damaging tail has ever filled |
| **Timing / staleness / stale odds cache** | **REFUTED** | Drift at the configured **2-minute refresh interval is literally 0.000pp** (t=−0.92, n=6,948, fixed-horizon estimator). Confirms never reprice (`confirmed_odds === −offered_odds` on 6,227/6,236). Timing mix identical across all three P&L blocks |
| **Lead-time vig ladder (+2/+5pp above 12h)** | **DO NOT SHIP** | The −$13,888 is **98% three tickets**; leave-3-out leaves **−$344** on $86K of risk. Non-monotone in lead time (decile 8 −0.28pp, decile 9 +5.03pp), and the band's CLV is *positive* (+0.88pp, t=3.78) |
| **Late-fill / near-kickoff guard** | **DO NOT** | 0–15m is among our best-calibrated bands. Any such rule cuts profitable volume |
| **Block a new creator (incl. f49612dd)** | **DO NOT** | MC null over 941 creators: worst observed gap p=0.33, and the null's own median worst-creator gap is −$5,554. Out-of-sample persistence **fails**: train-sharp half made us +$657, train-soft half lost −$2,945 (wrong sign); Spearman ρ(train,test) = −0.18 to −0.23. f49612dd is +$1,418 realised since 7/27. Existing 11-entry blocklist is working |
| **`MAX_RISK_PER_PARLAY` exposure-cap gap** | **FALSE — there is no gap** | Production `max_risk` on 30d fills is 4,000–6,000 (modal 5000, n=893). **0 of 2,003 tickets breach.** The $5,190/$5,487 golf fills sat inside a $5,500 configured cap. That's a config choice, not a leak |
| **Any broad vig raise** | **DO NOT** | Measured marginal retention in MLB (61% of risk) is 73%/19%/0% at +1/+2/+3pp. Profit-maximising retune across *all* sports is worth **+$134/30d** — 0.01σ |
| **Block prop UNDER legs / raise prop vig** | **DO NOT** | All prop parlays 30d: model 16.65% vs realised 16.57% (z=−0.07). Prop over legs realise **3.70pp below** our fair (z=−3.90) — conservative. Ex-creator-0380a6c9 the under book is −$63 on $1,582 |
| **F5 innings markets** | **NOT A DISTINCT DEFECT** | F5 legs calibrate *better* than full-game MLB in the same band (+0.80pp vs +1.29pp). 30d only t=−1.05 and improving (−$4,730 → −$923) |
| **DNB void repricing path** | **VERIFIED CORRECT** | Liability shrink observed/predicted median 1.018–1.031; full stake collected on wins (ratio 1.0000). Leave it alone |

---

## 6. How we will know it worked

**Do not judge any of this on P&L.** With a 30d SD of $13,534 and a true edge of ~$7,500/month:

| Detection target | Window needed | Power |
|---|---|---|
| The book's own edge, at 2σ | **12.8 months** (n≈25,586 fills) | — |
| A persistent 1.8pp calibration miss, from P&L alone | **244 days** | 80% @ α=0.05 |
| Same, at 1 month / 3 / 6 / 12 | | 16% / 39% / 67% / 92% |

So the metrics have to be per-ticket, not per-dollar:

1. **Void-adjusted per-ticket calibration z, book-wide, rolling 90d.** Current corrected value: **+0.40pp, z=0.82**. Alarm if it exceeds z=2.5 sustained over two consecutive 30d blocks. This is the primary health metric and it does not currently exist — build it (item 7).
2. **Void-adjusted calibration by segment**, pre-registered list only: golf matchups, MMA, near-lock (fp≥0.90), MLB 2-leg cross-game. Re-tested monthly, no post-hoc segment mining. Anything not on the list gets a Bonferroni correction over the ~44 segments that exist.
3. **Near-lock fix:** the fix is verified when zero tickets with a leg ≥0.90 price with a leg-count-diluted vig. That's a unit test, not a P&L observation. Track `count(fills where max leg fp ≥ 0.90)` — currently **0 since 2026-07-30**. If it stays 0, the fix earns nothing and that is fine.
4. **Golf wiring:** verified by `meta.golfCorrFactor` appearing on every golf fill with the expected value. Track golf ex-whale void-adjusted z; it needs ~100 more tickets to move.
5. **Concentration guardrail (the metric that would actually have helped):** max single-event shortfall and max single-creator-single-event risk, per week. Today: 5 events = 92% of the 30d shortfall. Target: no single PX event >15% of 30d shortfall.
6. **`/prop-correlation` sanity:** after the settlement fix, under-leg factors should move materially. If they don't, the re-run didn't take.

---

## 7. Open questions / what I could not determine

1. **Which P&L number is "the" number.** Effective-risk basis: −$5,773. Nominal `confirmed_stake` basis: −$14,597. The $8,824 gap is entirely void relief on 45 push-containing lost tickets — mechanism verified correct, but you should pick a reporting convention. The variance verdict is unchanged either way (nominal 30d p=0.115, trend p=0.33).
2. **Is golf a pricing problem or an exposure decision?** Cannot resolve at n=124 ex-whale (adj z=1.26, direct pairwise ρ=−0.005). What is *certain* is that golf carries **zero house vig** by construction. That's a deliberate policy question you should answer, not something the data will settle.
3. **Confirm-time reject rate is completely unobservable.** No field persists `validateForConfirmation`'s repriced fair; rejected confirms never become orders. We cannot currently tell whether the drift gate is firing at all. (Item 10.)
4. **Blocklist integrity unverifiable from this dataset.** The canonical fills carry no block dates. Five of the 11 blocked creators have fills inside 90d — not contradicted, but not confirmed. Worth a direct check against `kv_store`.
5. **We are the marginal/deepest fill in 99.9% of our fills.** RFQs clear in tranches across multiple SPs and we are consistently the last tranche. Nobody has worked out what that implies — it may mean our price is systematically the worst accepted, or simply that we quote deepest size. This is the single most interesting unexamined structural fact in the data.
6. **`meta.clvDelta` covers only 918/6,236 settled fills (14.7%), 0% of golf**, and that subsample realises at z=−2.02 while the uncovered 85% realises at z=+5.06. The "CLV is +1.03pp so we're not being picked off" conclusion is directionally supported but rests on a favourably-selected 15%. It has **zero golf content**.
7. **Whether the near-lock flow returns.** Creator 0380a6c9 stopped 2026-07-25. If it never comes back, the one genuinely real pricing defect in this investigation is worth $0 going forward — and the honest answer to "why are we losing" becomes, in full: *we aren't, at any statistically detectable rate; we had a bad month on three tickets.*
