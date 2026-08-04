# Performance review — 2026-08-04 (overnight)

Window: **45 days of settled fills** (2026-06-20 → 08-04, 3,236 parlays) and
**30 days of market-wide data** (51,653 matched parlays, $12.47M, every SP).

All P&L is on **our risk** (`confirmed_stake`), which is what we lay. `pnl` on a
win is the bettor's stake. `fair_parlay_prob` is the **bettor's** win prob, so
`settled_won` = the bettor lost.

---

## 0. Shipped and verified tonight

| Item | State |
|---|---|
| Tennis Sets wiring (`dc1800e`) | **Pushed, deployed, live** |
| Registered set lines in prod | `first_set_moneyline` 62, `total_sets` 68, `set_win_at_least_one` 124 |
| Trader after redeploy | `paused: false`, WS `connected`, quoting confirmed |
| Golf outright board | Re-scraped + re-pasted (Wyndham, 146/146/146), `priceable: true` |
| Test suite | 155/155 pass (8 new set-market tests) |

Set markets have registered but **have not been RFQ'd yet** — first real quotes
should appear during Tuesday's slate. Worth a look at `/recent-quotes` for
`first_set_moneyline` in the morning.

---

## 1. Headline

**We are roughly break-even and running below our own model.**

| Window | n | Our risk | P&L | ROI | Expected ROI | Gap |
|---|---|---|---|---|---|---|
| Last 45d | 3,236 | $881,964 | **-$1,849** | -0.21% | +1.19% | -1.40pp |
| Last 14d | 949 | $378,922 | **-$6,024** | -1.59% | +1.16% | -2.75pp |
| Prior 14d | 882 | $190,162 | +$4,087 | +2.15% | +1.50% | +0.65pp |

Two things to internalise:

1. **Expected ROI is only ~1.2% on risk.** We charge a median **6.38%** margin
   over fair, but because we lay at short prices that converts to barely 1% on
   the money at stake. A 1pp calibration error anywhere wipes out the entire
   edge. The book is thin, not comfortable.
2. **Risk doubled in the last 14 days** ($190K → $379K) while ROI went negative.
   Volume grew into the segment we price worst.

**The good news is that our prices are not the problem.** CLV is
**+1.03pp, t=7.76, 76.7% of fills positive** — we consistently beat closing.
We are not being picked off on price generally. The losses are concentrated and
diagnosable.

---

## 2. Where the money went

Last 14 days by sport — **golf matchups are the entire deterioration and more**:

| Sport | n | Risk | P&L |
|---|---|---|---|
| **golf_matchups** | 62 | $59,125 | **-$8,697** |
| baseball_mlb | 572 | $244,616 | -$2,270 |
| mma | 58 | $15,507 | +$46 |
| basketball_wnba | 95 | $17,308 | +$600 |
| soccer_usa_mls | 8 | $1,806 | +$639 |
| MIXED | 111 | $24,215 | +$1,122 |
| tennis | 40 | $16,206 | +$2,669 |

Over the full 45 days: golf matchups **-$6,294 (-8.43% ROI)**, soccer -$4,318,
MIXED -$4,224. Winners: WNBA **+$7,100 (+17.5%)**, tennis +$3,377 (+13.8%),
MMA +$1,950, SGP +$4,883 (+10.6%).

---

## 3. Golf matchups — a structural mispricing, not variance

You previously judged the July golf losses to be variance ("priced well; just a
few lucky bets"). **New evidence over the following 14 days says otherwise**, and
it's a different, stronger test than the P&L z-score I showed before.

Restricting to **pure multi-leg golf-matchup parlays with complete leg results**
(n=108, of which **107 have all legs in the same tournament**):

| Legs | n | Model P | Realised P | Independence benchmark | Risk | P&L |
|---|---|---|---|---|---|---|
| 2 | 61 | 27.87% | 34.43% | 34.83% | $18,732 | -$423 |
| 3 | 18 | 14.20% | 33.33% | 24.96% | $5,619 | -$1,727 |
| 4 | 11 | 6.86% | 18.18% | 8.85% | $7,002 | -$2,243 |
| 5 | 11 | 3.90% | 9.09% | 1.58% | $12,443 | +$299 |
| **All** | **108** | **19.29%** | **27.78%** | — | $63,329 | -$3,732 |

Overall **z = 2.23**. The "independence benchmark" is the realised leg win rate
raised to the leg count — i.e. what the parlay *would* pay if legs were
independent. That decomposition separates two distinct defects:

- **At 2 legs**, realised (34.43%) ≈ independence (34.83%). So the miss there is
  purely that **our golf leg fairs are too low** — golf legs realise **56.17%**
  vs a model **51.62%** (n=397, z=1.82).
- **At 3+ legs**, realised runs **far above** independence (18.18% vs 8.85% at 4
  legs; 9.09% vs 1.58% at 5). That is **same-tournament correlation**, and it
  compounds with leg count exactly as correlation should.

This matches the known finding that the 2026-07-30 same-tournament factor doesn't
fire on the tickets that matter.

**Why this hurts so much:** we quote **100% of golf matchup tickets and win 30%**
of them, versus a 4.7% win rate in MLB. We are consistently the cheapest price in
the market on the one product we systematically underprice. That is textbook
winner's curse, and it explains why golf loses far more than its share of volume.

**Recommendation (highest $ impact):** either apply a real same-tournament
correlation factor at 3+ legs *and* lift the golf leg fair by ~4pp, or stop
quoting 3+ leg golf matchups until that lands. The 2-leg book is close to
fair once the leg fair is corrected.

---

## 4. Calibration — what's right and what's wrong

**Leg-level, all sports (n=8,436 legs with results):**

| Model band | n | Model | Realised | Diff | z |
|---|---|---|---|---|---|
| 0–0.3 | 1,383 | 21.80% | 17.43% | **-4.38pp** | **-3.94** |
| 0.3–0.4 | 349 | 34.91% | 30.66% | -4.25pp | -1.66 |
| 0.4–0.5 | 1,931 | 46.41% | 47.70% | +1.29pp | 1.14 |
| 0.5–0.6 | 3,382 | 54.45% | 56.09% | +1.64pp | 1.92 |
| 0.6–0.7 | 818 | 64.35% | 66.87% | +2.52pp | 1.51 |
| 0.7–0.8 | 409 | 74.38% | 76.53% | +2.15pp | 0.99 |

A textbook **favourite–longshot bias in our fairs**: we overprice longshots
(good for us, z=-3.94) and underrate favourites (costs us). Modest per leg, but
it compounds across a parlay.

**By sport (legs):**

| Sport | n | Model | Realised | Diff | z |
|---|---|---|---|---|---|
| **mma** | 445 | 56.13% | 64.27% | **+8.14pp** | **3.46** |
| golf_matchups | 397 | 51.62% | 56.17% | +4.55pp | 1.82 |
| soccer | 999 | 58.14% | 60.56% | +2.42pp | 1.55 |
| basketball_wnba | 835 | 53.63% | 55.69% | +2.06pp | 1.19 |
| tennis | 349 | 56.98% | 57.88% | +0.90pp | 0.34 |
| baseball_mlb | 5,296 | 45.08% | 43.94% | -1.14pp | -1.67 |

**MMA is the most miscalibrated leg source we have (z=3.46, 8.14pp).** It's still
profitable (+5.08% ROI) only because the MMA margin is wide enough to absorb an
8pp error. Fixing the fair converts directly to P&L, and it de-risks the MoV
expansion which sits on the same fairs.

**MLB is well calibrated and slightly in our favour** — the core book is healthy.

**The parlay combination rule itself is fine** (all parlays: model 18.81% vs
realised 19.33%, z=0.72). Golf is the only sport where the combination rule
breaks.

**One small anomaly worth watching:** parlays containing a leg with fair ≥0.90
(n=49) ran **-$4,408, ROI -54.6%**, model 31.6% vs realised 65.3%. These are
2-leg "near-lock + coin-flip prop" structures (e.g. `player_hitter_hr` NO at 96%
+ a 45% prop). The near-lock legs went 48/48. Small n and MLB props calibrate
fine overall, so this may be selection — but the shape (a lock used to dilute vig
on a real bet) is worth a policy look.

---

## 5. Volume, share, and why we lose bids

**Market (30d):** 51,653 matched parlays, **$12.47M**. Recent daily market is
~$500K across ~1,900 tickets.

| Stage | Tickets | Stake |
|---|---|---|
| All matched parlays | 51,653 | $12,466,038 |
| We quoted | 13,694 (26.5%) | $3,211,446 |
| → **we won** | 822 (6.0% of quoted) | **$346,455** |
| → lost to another SP | 12,872 | $2,864,992 |
| Never quoted | 37,959 (73.5%) | $9,254,591 |

Our share is **~5–8% of daily matched volume** (~$30K/day of ~$500K).
Note: share attribution in `matched_parlays` was broken before ~7/24 and is
reliable from 7/25 onward (7/25 reconciles exactly with `parlay_orders` at
$46,806).

**Lost bids are lost by very little:** median gap **0.82pp**, p25 0.26pp.

**Ties are the striking part:** 2,954 bids matched the winning price exactly.
**We won only 808 of them (27.4%)**, forfeiting **$748,417** of stake at a price
we had already matched.

I tested whether we lose ties because we're slow. **We are not** — tie-losses had
*lower* submit latency than tie-wins (median 13.6ms vs 16.6ms), and our sizes are
comparable ($4,500 vs $5,000 median). 27.4% is about what random allocation among
~4 converged SPs would give. **So ties are competition, not a bug — the lever is
price, not speed.** A further 2,484 bids were within 0.5pp and worse ($849K).

---

## 6. Coverage gaps

Two independent views. **By live RFQ volume** (declines, last 24h — note 88.1%
of all declines are *blocked creator*, which is the quote-fisher bot being
correctly rejected and is not lost revenue):

| Cause (of 12,538 `unknown legs` declines) | Count | Share |
|---|---|---|
| **MLB binary YES/NO hitter prop** (line 0.5) | 8,593 | **68.5%** |
| MLB alt run-line / hitter ladder | 2,292 | 18.3% |
| Unregistered alt total/spread | 1,365 | 10.9% |
| Rejected by sport-aware bounds | 208 | 1.7% |
| MLB pitcher_other (outs etc) | 63 | 0.5% |

**By actual matched money** (30d, ticket stake attributed to unregistered legs):

| Gap | Stake |
|---|---|
| soccer / player_prop | **$672,844** |
| MMA / event_match_gap | $212,710 |
| Tennis / event_match_gap | $208,871 |
| baseball_mlb / low_line_ambiguous | $177,732 |
| baseball_mlb / other_line | $127,086 |

`event_match_gap` (PX events we never matched to any odds event) totals
**$722,142 / 3,461 tickets** — concentrated in tennis, MMA and soccer.

---

## 7. Recommendations, ranked

1. **Golf matchups: correlation at 3+ legs + ~4pp leg-fair lift.**
   -$8,697 in 14 days, z=2.23, and we win 30% of what we quote. Biggest single
   dollar item. Interim option: stop quoting 3+ leg golf until fixed.
2. **MLB binary YES/NO hitter props.** The #1 unmet RFQ demand by a wide margin
   (8,593 declines/24h). We already price hitter props; the `line 0.5` binary
   variants fail *registration*, not pricing. New volume in our best-calibrated
   sport.
3. **MMA leg fairs (z=3.46, +8.14pp).** Currently masked by wide margin. Direct
   P&L, and it de-risks the MoV work built on the same fairs.
4. **Activate the declines rollup RPC.** `scripts/_declines_rollup_rpc.sql` has
   never been run in Supabase (`declines_rollup` does not exist). Until it is,
   coverage measurement means hand-paginating 120K rows, as tonight did.
5. **Fix `declines.unknown_categories`** — it currently stores the literal string
   `[object Object]` for every row. The column is unusable; the detail strings
   are the only reason tonight's breakdown was possible.
6. **Persist the golf outright paste board.** It is in-memory: every redeploy
   silently zeroes it while ~430 outright lines stay registered, so PX can send
   RFQs we cannot price. I re-pasted tonight, but this will recur on every push.
7. **`event_match_gap` in tennis/MMA/soccer ($722K/30d).** Event-matching
   failures, not pricing. The new Pinnacle tennis source should have helped —
   worth re-measuring in a week.
8. **Soccer**: fills stopped dead on **2026-07-20** (World Cup ended 7/19) and
   there are currently **zero soccer lines registered**, despite 111 soccer
   events sitting in the odds cache (MLS 31, Argentina 33, Brazil 20, EPL 10,
   LigaMX 9, Libertadores 8). Some of that is genuinely off-season, but MLS at
   least should be quoting. **Verify during the daytime slate** — I could not
   distinguish off-season from a registration failure at 04:00 ET.

---

## 8. Things that are working — don't touch

- **CLV +1.03pp (t=7.76)** — pricing beats close; no general adverse selection.
- **MLB leg calibration** slightly in our favour (z=-1.67) on 5,296 legs.
- **Longshot legs overpriced in our favour** (z=-3.94).
- **SGP +10.6% ROI** on $45.9K — best-performing product per dollar, and only 5%
  of book. `spread_total` +18.2%, `prop_prop_xteam` +17.1%. Expansion candidate.
- **WNBA +17.5%, tennis +13.8%.**
- **Blocked-creator gating** absorbing ~106K fisher RFQs/day.
