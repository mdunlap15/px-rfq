# Pre-registration — conditional vig raise on spread/total legs

**Status:** PRE-REGISTERED, NOT STARTED. Written 2026-08-03, before any arm ran.
Nothing in this document may be revised after data collection begins except the
"Amendments" section, which is append-only and dated.

The point of writing this first is that the finding it tests was produced by an
analysis that had already been refuted once. An ex-post filter or a moved
threshold would make the result unfalsifiable in exactly the way the original
demand-curve study was.

---

## 1. Hypothesis

Raising vig on spread/total legs **only for quotes already priced at or above
Pinnacle's compounded raw price** increases 30-day EV, because:

- filled spread/total parlays carry a thin margin — n=302, $21,662 wagered,
  model EV $1,238 = **5.71% of wager** — so a small absolute vig increase is a
  large *relative* margin increase (+0.5pp/leg ⇒ **+104% EV per fill**);
- break-even therefore only requires retaining **49%** of those fills at
  +0.5pp/leg (66% at +0.25pp, 32% at +1.0pp);
- the bot-cleaned, leg-count-standardised elasticity is only **−0.54 per pp**
  above +0.25pp gap, against a **−0.82** break-even slope; below zero gap it is
  −1.17 to −1.47, i.e. steeper than break-even, which is why the raise must be
  **conditional** rather than uniform.

**Predicted effect:** +$174 / +$348 / +$837 per 30 days at +0.25 / +0.5 /
+1.0pp per treated leg (clean curve). Point estimate for the chosen arm:
**+$348 / 30d**.

**This is small.** It sits against a book that realised roughly −$4.6K over the
same window, and the bootstrap CI on the original uniform estimate never
excluded zero. Treat a null result as the expected outcome, not a failure.

---

## 2. Arms

| arm | rule |
|---|---|
| **A (control)** | current pricing, unchanged |
| **B (treatment)** | +0.5pp per leg of vig, applied ONLY to legs with `marketType ∈ {spread, total}`, and ONLY when the quote's price-vs-Pinnacle gap is **≥ 0** |

Assignment: deterministic hash of `parlayId` → 50/50. Deterministic so a re-fired
grid lands in the same arm every time and cannot leak across.

**The gap condition is evaluated at quote time** from the same compounded
Pinnacle reference used in the analysis. If any leg lacks a Pinnacle price the
quote is **excluded from the experiment entirely** (recorded as arm `n/a`), not
silently routed to control — that would contaminate the control arm with exactly
the population the treatment cannot reach.

---

## 3. Exclusions — fixed now, not after seeing results

1. **Quote-fishers.** Excluded via the quote-time `meta.fisher` flag
   (services/creator-activity.js), which classifies from request rate and grid
   re-fire only. An ex-post "creators with zero fills" filter is **endogenous**
   and is specifically forbidden here.
2. **Soccer moneyline legs**, in either arm. The Pinnacle reference is 3-way
   while our quote is draw-no-bet, so the gap condition is not meaningful for
   them (median gap phantom of ~+10pp).
3. **Golf.** No golf leg carries `pinnacleOdds`, so golf can never satisfy the
   gap condition. Stated explicitly so its absence is not later read as a result.
4. **Same-game parlays.** SGP fill rate (0.066%) is ~18× below cross-game
   (1.201%) and is collinear with the gap axis; including them would swamp the
   comparison with a population that essentially never fills.

---

## 4. Primary endpoint

**Realised P&L per $1 of wager, arm B minus arm A**, over treated-eligible
quotes only (spread/total, gap ≥ 0, exclusions applied).

- Reported **winsorised at 5%** and **trimmed at 2.5%** alongside the raw sum.
  The 30-day calibration run showed the worst 3 tickets accounting for 118% of
  the total miss, so raw sums are not decision-grade at this n.
- Bootstrap 95% CI (2,000 resamples) on the per-wager mean.

**Secondary endpoints** (reported, not decisive):
- fill count and fill rate per arm, to confirm the retention assumption
- CLV (`meta.clvDelta`) per arm — stake-independent and higher-powered
- realised EV per fill

---

## 5. Stopping rule

Run to **whichever comes first**: 30 days, or **300 fills** in the treated-eligible
population. No interim peeking at the primary endpoint before one of those is hit.
Secondary endpoints (fill counts, CLV) may be monitored for operational safety.

**Safety abort** — halt and revert immediately if any of:
- arm B fill count drops below **25%** of arm A over any rolling 7-day window
  (the retention assumption is badly wrong);
- arm B realised P&L is worse than arm A by more than **$2,000** raw at any point;
- submit-error rate in arm B exceeds arm A by more than 1pp.

---

## 6. Success criteria — declared in advance

- **Adopt** if trimmed per-wager P&L for B exceeds A **and** the bootstrap CI on
  the difference excludes zero.
- **Reject** if the CI excludes zero in the other direction.
- **Inconclusive** otherwise — which, given the effect size versus the noise, is
  the single most likely outcome. Inconclusive means *do not adopt*; it does not
  license re-slicing the data until something is significant.

---

## 7. What would make this study invalid

Recorded so a future reader can check whether it happened:

- moving the +0.5pp figure, the gap ≥ 0 condition, or the exclusion list after
  data collection starts;
- adding a post-hoc subgroup (a sport, a leg count, a counterparty) and reporting
  it as the headline;
- excluding creators, days, or tickets on any criterion derived from fills;
- extending past the stopping rule because the result "nearly" reached
  significance.

---

## 8. Implementation notes

- Arm assignment and the treated flag must be stamped on `meta` at quote time
  (`meta.abArm` already exists and is currently `'v1'` for all rows — use a
  distinct field, e.g. `meta.vigAbArm`, so the two are not conflated).
- The vig change belongs behind a Runtime Tuning key so it can be reverted
  without a deploy.
- Log the gap value used for the condition, so the eligibility decision is
  auditable after the fact.

## Amendments

_(append-only; date and justify every entry)_

- None.
