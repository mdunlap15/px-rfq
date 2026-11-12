# RFQ ↔ Order Book parity: assessment + build plan (2026-11-11)

Source: `px-methodology-2026-11-11.md` (order-book rules as of 11/11 13:30 ET). Goal (operator): RFQ uses the exact
same sourcing + monitoring as the PX order book "as much as possible". Not built yet — build + push tonight.

## 0. The one idea that makes this tractable

The order book backs side O at an ask; its taker therefore holds side X at that price. An RFQ bettor holding X on a
leg is in the **same position against us**. So the parity rule for a parlay leg is:

> **leg offered prob = what our order book would charge a taker for that single bet** (its ask, seen from X),
> and **leg fair = the order book's fair**. Parlay offered = product of leg asks (then SGP / parlay-level rules).

We already do this for MLB series, UFC MoV, elections and tennis game spreads. This plan generalises it.
Two ways to get the ask: (a) **relay it** from the posters (exact, but only for lines the order book is listing right
now), (b) **port the rule** (needed for every line outside the order book's windows/markets). We need both.

## 1. Where we stand (live 11/11)

- `px_rfq_relay`: 2,228 fresh entries (1,829 `multi_line_guard`, 353 `cfb_line_guard`, posters ~45). 40.7K leg reads
  priced off it since boot, 1.2K via complement, 2 adverse overrides. Watch mode: 19 active events (NBA 10, NHL 6, CFB 2).
- So **fairs** are already shared on lines the order book prices or watch mode grades (≤ 8 h, recently RFQ'd).
  **Asks, holds, windows, eligibility and margins are not shared** — RFQ still prices `fair × (1+vig)` + consensus
  floors + parlay layers, on its own windows.

## 2. Gap table

Legend: ✅ same · 🟡 partial · ❌ different · — n/a to RFQ (maker-only mechanics)

### 2.1 Principles (all sports)

| OB rule | RFQ today | Status |
|---|---|---|
| Fair = per-book de-vig, **median** across books, exact point | `buildConsensus*` = **mean** of de-vigged filtered books (`odds-feed.js:3919+`); median only in football prop poster method | ❌ |
| Books count once per **distinct price pair** (Kambi skins = 1 vote) | every book is a vote | ❌ |
| ≥3 distinct-book consensus, else Pinnacle; Pinnacle >4pp off consensus = stale | Pinnacle de-vig used as a FLOOR on favourites only; no 4pp rule | ❌ |
| Proportional for balanced; **Shin** for lopsided (heavy-fav NOs, first/last TD, soccer 3-way) | proportional; Shin only NFL props + MoV; first/last TD power-normalised | 🟡 |
| Main lines only; alts give slope, never level | football main-only ✅; NBA/NHL/MLB/soccer/tennis price alt points off TOA alt cache | ❌ |
| Never shorter than fair + sport margin rule | per-leg vig + consensus floor (raw − 1pp); sport EV floors only on tennis spread/dog, series, elections | 🟡 |
| Exact joins, ambiguity declines | team match has substring + last-N-words fallbacks (college already anchored) | 🟡 |
| Start guard per sport (NFL/NHL/NBA 30 s, CFB 2 min, tennis 15 min, soccer 5 min) | decline only once started (+ ESPN in-play) | ❌ |
| Line guards: cancel if EV vs fresh fair < +0.5% | confirm rejects adverse drift > 1.5% (`CONFIRM_ADVERSE_DRIFT`) — a drift test, not an EV floor | 🟡 |
| Holds (player hold, book-move, churn 3/30 min, large fill ≥$1K/120 s, point-stability wait, cumulative move) | none relayed; RFQ only sees the guard's fair | ❌ |
| Fill holds only on large fills | RFQ: none (election has its own) | ❌ |
| EV fill pinned at placement; EV live frozen at start (`fair_sync`) | EV fill / EV live / game-time EV built 10/13–10/21 | ✅ |
| Judge by CLV vs close, stake-weighted, by sport | have the data; no stake-weighted 7-day CLV-by-sport view matching §8 | 🟡 |
| Guard A, self-cross, ALO, fast-fill fuse, visible clip, cancel/relist, headroom priority | — | — |

### 2.2 Per sport

**NFL**
| OB | RFQ | |
|---|---|---|
| Point = most-quoted 2-sided point, tie → Pinnacle's | `nfl-consensus` median-of-main snapped to .5 | 🟡 |
| ≥3 consensus, Pinnacle below, Pin >4pp → consensus | generic builder | ❌ |
| Ask = raw mirror of opposite side + 1 rung concession, 16-tick min width, ≥ fair | fair×(1+vig) + raw−1pp floor (≈ mirror − concession; close in effect) | 🟡 |
| Props: 1-vote or tied point → decline; changed point waits for stable fair (0.5pp × 3 passes, ≤15 min) | best-booked point, ties broken toward middle; no stability wait | ❌ |
| TD scorers: OB lists NO only at −300 or deeper (= bettor YES ≥ +300), ≥3 books quoting YES, Shin for first/last, NOs −999..−300 lengthened 3pp | YES mirror − 3% sweetener, no +300 floor, power-normalised first/last | ❌ |
| Specials ≥3 distinct prices, ≥ +3% EV | not registered (check) | — |
| Windows: game T-20h (full-game **total T-3h**), team totals T-12h, props **T-6h**, TD T-12h, defensive props T-90, 1Q down T-15 | event T-48h; props `FOOTBALL_PROP_TMINUS_MINUTES` 1440 (prod); `poster` preset = the **stale 10/01** windows (T-60/T-120) | ❌ |
| Legs past +300 capped $500 | none | ❌ |

**CFB**
| Game lines: sharp composite (median Pin/BetOnline/LowVig/DK/FD, ≥2 distinct; consensus if Pin >4pp off), ESPN bridge check | generic builder | ❌ |
| Legs past +800 nothing; ML declines if dog past +400; size scaled by book count | none | ❌ |
| Windows: spread/total **T-2h**, ML T-3h, periods/team totals T-20h, Q1 down T-15, cutoff T-2 min | T-48h, cutoff at start | ❌ |
| Props ≥**4** books, band rule (+150 or longer +1 rung), 18-pt width, T-120, cutoff T-2 | ≥3 books | ❌ |

**NBA**
| ≥3 consensus, Pinnacle below; each leg at **4% EV**; no ML concession | generic + vig; NBA ceiling A/B (0 since 11/7) | ❌ |
| Game lines **T-20 min** only | all day | ❌ (decision) |
| Props: ≥4 books at exact point, 4% EV, YES/NO props NO-side only and nothing with own fair < 25% | NBA props T-25 ✅-ish, 2-book floor | ❌ |
| Props only after **both lineups confirmed on NBA.com + 5 min**, inside T-20; inactive never listed | T-25, no lineup gate | ❌ |
| Pre-post FanDuel/Kambi check; pulled/moved player held 10 min | none | ❌ |

**NHL**
| Game: Pinnacle-anchored, **2pp cross-check** vs ≥3 consensus, disagreement **declines**; nothing ≥ +300 | generic | ❌ |
| Markets: ML, main total, 3-way NO, period ML, OT NO (no puck line, no alt totals) | registers puck line + alt totals | ❌ |
| Props ≥**5** books exact point, overs lengthened 3pp; SOG on a player Pinnacle doesn't price: **$150 cap** | 2-book floor; early-prop gate A/B 50% | ❌ |
| Goal scorers NO-only −300 or deeper (bettor YES ≥ +300), ≥5 books, field fair, T-120 | check registration | ❌ |
| Windows T-60 | all day | ❌ (decision) |

**Tennis**
| Tour level only | TOA-only + registration guard (10/21) | ✅ |
| Markets: ML, 1st-set ML, total sets, game spread; **total games OFF** | allowlist has `total` (total games) ON | ❌ |
| ML ≥2-book consensus → live sources → Pinnacle; nothing past +400; sets nothing past +300 | no odds caps | ❌ |
| Dog legs off Pinnacle ≥8% EV; game spread ≥6% EV each side | spread 6% / dog 8% built (10/6) | ✅ |
| Margin given back 0.5pp; live-source ML legs > +6% EV not quoted | none | ❌ |
| Windows T-3h → down T-15 | all day, cutoff at start | ❌ |

**Soccer**
| Markets: 3-way NO only; DNB, main spread, main total, BTTS; no alternates (non-main only if ≥3 books carry it as main) | alt spreads/totals priced; UCL totals-only | ❌ |
| Two-way legs ≥1.2% EV; 3-way NO = exact mirror of consensus YES | vig | ❌ |
| Pin vs ≥3 consensus > 2pp → **less generous** of the two; ≥3 books; nothing past +400 | none | ❌ |
| One bet per losing outcome | — (parlay SGP rules cover same-game) | — |
| $500 net per side; **T-30 → T-5** | all day | ❌ (decision) |

## 3. Decisions needed before building

1. **Windows.** Mirroring exactly (NBA game lines T-20, NHL T-60, soccer T-30, tennis T-3h, CFB mains T-2h) removes
   most RFQ volume — most parlays are built hours ahead. Options:
   - (A) **Exact windows everywhere.** Pure parity; big volume drop.
   - (B) **Exact windows for props + soccer + tennis** (lineups / inactives / the two sports with negative CLV), game
     lines keep RFQ's wider windows but priced by the OB method and monitored by watch mode. *Recommended.*
   - (C) Methodology only, keep current windows.
   Whatever the choice, the start **cutoffs** (30 s / 2 min / 5 min / 15 min) should be mirrored — cheap, no downside.
2. **What sits on top of per-leg OB asks.** Per-leg OB margins compound in a parlay: NBA 4% EV/leg ≈ 1.125× fair at
   3 legs, 1.17× at 4 — roughly where FD/DK sit (1.18–1.20× on 3+), and above bettors' measured ~1.075× on 3+.
   On 2 legs it is ~1.08× vs bettors' ~1.15× → under water. Today's parlay layers (calibration floor ×1.10 + 8%,
   cross-game widen +6% at 100%, factors, book-match arms) would stack ON TOP and double-charge. Recommend:
   OB leg asks become the base; keep calibration for **EV honesty only** (meta.evFair) and drop its margin floor for
   3+ legs; keep the 2-leg selection factor; retire cross-game widen; keep book-match running as is (its match arm
   replaces everything, so it stays a clean A/B against the new control). Your call.
3. **Sizes.** Mirror the per-market net caps as per-line RFQ leg-risk caps (risk × P(other legs)), + "legs past +300
   capped $500"? Separate from the order book's caps (no shared book) for now. Recommend yes, separate.
4. **Poster-service change** for relaying asks + holds (§4 Phase 2) touches `rfq_relay.py` in poster-service
   (deployed with `railway up`, not git). OK to edit/deploy it tonight, or RFQ-side only?

## 4. Build plan

### Phase 1 — RFQ-side only, tonight (low risk, mostly declines/eligibility)

Every item a runtime key (no restart), default ON unless marked, with a test per rule + mutants.

1. **Per-sport start cutoffs** (`obStartCutoffSec` map: NFL/NHL/NBA/NCAAB 30, CFB 120, tennis 900, soccer 300).
   Pricer leg check next to `event started` (`pricer.js:1120`) and in `shouldDecline` (`:6563`); confirm reprice
   too. Reason `ob_start_cutoff`.
2. **Eligibility table** (`obLegEligibility`): odds caps (NHL leg ≥ +300 out; tennis ML > +400, sets > +300; soccer
   > +400; CFB leg > +800 out, CFB ML out if dog > +400; NBA prop own fair < 25% out), book minimums (CFB props 4,
   NBA props 4 at exact point, NHL props 5, NFL TD ≥3 YES books), **TD / goalscorer YES only at ≥ +300**, tennis
   total games off (allowlist), NHL markets = ML / main total / period ML (puck line + alt totals off), NHL SOG on a
   player Pinnacle doesn't price → $150 per-ticket cap. Enforced at registration where deterministic (so PX stops
   sending), and at pricing.
3. **OB fair builder** (`obFairMethod`, runtime, default on, old fair stamped as `meta.legs[].fairPreOb` for a
   week of comparison): in `buildConsensusMoneyline/Spread/Totals/TeamTotals` — dedupe identical price pairs, median
   not mean, ≥3 distinct → consensus else Pinnacle, Pinnacle > 4pp off → consensus; sport overrides: NHL
   Pinnacle-anchor + 2pp cross-check → decline; soccer > 2pp gap → less generous of the two; CFB sharp composite
   (Pin/BetOnline/LowVig/DK/FD, ≥2 distinct). Shin for lopsided two-ways (fav ≥ 75%) and for first/last TD fields.
   ⚠ Changes every fair → re-read calibration (`/fair-calibration`) after a week.
4. **Confirm EV floor**: reject a confirm when the re-priced ticket EV vs fresh fair < +0.5% (`obConfirmMinEvPct`),
   alongside the existing adverse-drift check. Mirrors the line guards' floor.
5. **Large-fill hold** (RFQ's own fills): ≥ $1,000 of our confirmed leg risk on one line inside 120 s → that line
   (props: that player) declines for 5 min. Reuses the election fill-hold pattern.
6. **Windows map** (`obWindows`, per sport × market family, minutes before start), per decision 1. Football: update
   the `poster` preset to the 11/11 windows (props T-6h, TD T-12h, defensive props T-90, full-game total T-3h, team
   totals T-12h, 1Q down T-15). NBA props: add the lineup gate in Phase 2 (needs a source).
7. **CLV-by-sport view** matching §8 (7-day, stake-weighted vs closing fair) so the two books are judged the same way.

### Phase 2 — needs poster-service (`rfq_relay.py`) tonight or tomorrow

8. **Relay the ask and holds**: entry becomes `[fair_lo, ts, source, fair_hi, ask_x, hold_until]` where `ask_x` = the
   implied prob the order book is charging a taker on this line_id's side, and `hold_until` = epoch the line (or
   player) is held by any guard (player hold, book-move, churn, stability wait, cumulative move, large fill).
   RFQ: fresh `ask_x` → leg `bookPriceOverride` = ask_x (floored at fair); `hold_until` > now → leg declines
   (`ob_hold`). Back-compatible (old 4-tuples still parse).
9. **Per-sport leg-margin port** for legs the order book isn't listing (outside its window/market):
   NBA 4% EV (`q ≥ (f+e)/(1+e)`), soccer 1.2%, specials 3%, NHL overs +3pp, TD NOs −999..−300 → bettor YES +3pp,
   tennis 0.5pp give-back, NFL raw mirror − 1 rung (≈ current consensus floor), CFB props band rule. Same
   `bookPriceOverride` mechanics as series/tennis.
10. **NBA lineup gate**: relay "both lineups confirmed + 5 min" per game from the poster (it already reads NBA.com)
    → NBA props register/price only then.

### Phase 3 — measure first

11. **Main lines only** for NBA / NHL / soccer / tennis spreads + totals (football done). Measure first: share of RFQ
    legs and fills on non-main points per sport (`/recent-quotes` + matched_parlays) — then switch with a runtime key.
12. Per-market per-line size caps (decision 3) and "legs past +300 → $500".
13. Point-stability wait for props whose point changed.

## 5. Risks / notes

- Fair changes (Phase 1 #3) move EV fill, calibration multipliers, drift families and every live A/B's numbers;
  arms stay comparable (both arms get the same fair), pre/post windows don't. Stamp `fairPreOb` for a week.
- Book-match match arm floors at raw fair +1% — a fair change moves its floor too.
- Windows/eligibility cut volume; the order book's §8 CLV says that's where its edge comes from. Read
  `/ab-arm-metrics` and CLV-by-sport a week after.
- RFQ and order-book positions remain separate books (no shared cap) — unchanged.
- Push at 1am auto-push or on an explicit "push"; Phase 1 includes no env edits (runtime keys only).

## 6. Build status (2026-11-11 evening)

Operator: "Go with your recommendations" → windows option B, OB per-leg asks as the base (calibration floor
off on 3+ leg all-ask parlays, cross-game widen retired on ask tickets, 2-leg factor / book-match unchanged),
RFQ's own caps. Built (one commit, not pushed): Phase 1 #1–#7 and the RFQ side of Phase 2 #8–#9 (relay
ask/hold read back-compatibly; per-sport leg-margin port). See the `OB_PARITY_ENABLED` row in CLAUDE.md.

Still open:
- poster-service `rfq_relay.py`: write `ask` + `holdUntil` (needs operator OK — deploys with `railway up`).
- NBA lineup-confirmed gate (needs the poster's NBA.com read relayed).
- Main-lines-only for NBA / NHL / soccer / tennis (measure first); per-line size caps; prop point-stability wait.
- Not covered by the fair method: per-event alt-line cache, team totals.
- NHL SOG $150 cap for players Pinnacle doesn't price (no per-player Pinnacle flag on prop lines yet).
- Note: prod runtime has `footballGameMainOnly=false` (override) — the order book is main-only.
