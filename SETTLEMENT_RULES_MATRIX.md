# Settlement-rules matrix — quoted market vs. pricing source

Created 2026-08-07 (audit item: verify settlement semantics before trusting a
pricing source — the same label needs different sources on different venues).
For every market we quote: what happens on **tie / void / DNF / retirement**, on
BOTH sides of the pipe — PX's settlement of what we quote, and the source
market's settlement embedded in the odds we consume. A mismatch in ANY outcome
is unpriceable by margin: only matching the rules fixes it.

**Status key:** VERIFIED = confirmed against PX behavior or rule text and the
source's convention. PARTIAL = one observation or one side confirmed.
UNVERIFIED = inferred, never checked. Anything UNVERIFIED that carries volume
belongs in the question list at the bottom.

| Quoted market | Source | Tie/push | Void / DNF / retirement | Status | Notes |
|---|---|---|---|---|---|
| MLB/NBA/NHL/WNBA moneyline, spread, total | TOA multi-book de-vig, same market | Push on exact line both sides | League postponement voids both sides | **VERIFIED** | Standard two-way everywhere; ~5,300 MLB legs calibrate clean (z=−1.67) |
| Soccer moneyline (PX "Moneyline (2 Way)") | Book 3-way converted to **DNB** | **Draw REFUNDS on PX** — source explicitly DNB-derived | 90-minute rule both sides | **VERIFIED** (2026-06-11: our quotes sat inside PX's own DNB book) | The classic venue-semantics trap, already caught: book 3-way ML (draw loses) is a *different product* |
| Soccer BTTS | TOA per-event `btts`, 2-sided de-vig | n/a (binary) | 90-min convention both sides | **VERIFIED** (probe 2026-07-16) | |
| UFC method-of-victory (mov_*) | DK 6-way, power de-vig to 1−draw | Draw = the unpriced 7th outcome (MOV_DRAW_PROB) | Fight cancelled → PX void; we fail closed on missing outcomes | **VERIFIED** | ITD = KO+SUB exact identity |
| Golf outright top-N | DK **"(Including Ties)"** board only | Ties-included matches PX's "(Ties Included)" naming | Tournament abandoned: both follow official result | **VERIFIED** (deeply — DataGolf rejected precisely because it settles dead-heat) | The strongest precedent of this discipline in the codebase |
| Golf make_cut | DataGolf make/mc 2-way power de-vig | n/a (binary, no dead heat) | | **VERIFIED** | |
| MLB F5 moneyline / run line / total | Books' `1st_5_innings_*` | **Push-on-tie assumed BOTH sides** | Rain shortening <5 innings: assumed void both sides | **UNVERIFIED** ← ask PX | F5 legs calibrate fine (+0.80pp), which *suggests* no mismatch, but PX's rule text has never been read. Kalshi's F5 was three-way (tie=loss) — the exact trap |
| Run first inning (YRFI/NRFI) | TOA `totals_1st_1_innings` | n/a (0.5 line) | | **KNOWN-OPEN, correctly gated OFF** | `config.rfi.enabled` off pending PX side-convention confirmation — do not enable before resolving |
| MLB hitter/K props | TOA + distribution fair | Integer lines push (side-aware since 02c241a) | Player doesn't start: PX voids, books vary (DNP rules) | **PARTIAL** | Box-score grading verified; the source's DNP convention vs PX's unexamined |
| Tennis moneyline | Books' h2h | n/a | **Retirement: PX pushed** (Musetti ret → 'push', observed once). Books VARY: Pinnacle voids unless match complete; DK settles after 1 set played | **PARTIAL** | One observation. If PX pushes retirements while a source book settles-after-1-set, the source price embeds win-by-retirement value we refund — small but real |
| Tennis totals / spread (games) | TOA + Pinnacle merge, exact line | Push on exact games line | Retirement mid-match: PX push (same observation); Pinnacle voids incomplete | **PARTIAL** | Directionally aligned (both void/push-ish); the *threshold* (any retirement vs completed-set-1) unverified |
| Tennis 1st-set ML / total sets | TOA `h2h_s1` / `alternate_set_totals` | Exact-line push n/a (2.5) | Set 1 completed → most books settle s1 markets even on later retirement | **PARTIAL** | Lower risk: set-1 markets usually resolve before retirements |
| **Tennis "to win a set" (set_win_at_least_one)** | TOA `alternate_set_spreads` (+1.5 identity) | n/a | **THE LIVE RISK.** Player retires in set 2 having WON set 1: PX plausibly settles YES as already-achieved; the +1.5-sets source at many books is **VOID** on an incomplete match. If so, every consumed price embeds different retirement treatment than what we owe | **UNVERIFIED ← ask PX (top priority)** | Quoting now (~64 lines). Bo3-only identity is guarded; retirement is not |
| Team totals (MLB) | TOA per-event `team_totals` | Push on exact | Extra innings count (standard both sides) | **UNVERIFIED** (low volume) | |
| NBA/NHL series markets | DK series winners scrape | n/a | Series cancelled: both follow league | **VERIFIED-ish**, out of season | |

## The question for PX (Anthony) — draft, for Mike to send

> Two settlement-rule questions on markets we're quoting:
>
> 1. **Tennis "To Win At Least One Set"**: if a player retires mid-match
>    *after* winning a set (e.g. wins set 1, retires in set 2), does the
>    market settle YES as already-achieved, or void on the incomplete match?
>    And if the player retires *before* any set concludes — void, or NO?
>
> 2. **MLB First-5-Innings markets** (ML / run line / total): confirm the F5
>    moneyline pushes both sides on a tie after 5 complete innings, and what
>    happens to all three F5 markets if rain ends the game before 5 innings.
>
> Both determine which book convention we should price from, so exact rule
> text (not just intent) would help.

## Standing rule

Before quoting any NEW market: fill in a row here FIRST — source market's
tie/void/DNF/retirement vs PX's — and decline the market until every outcome
matches or the mismatch is consciously priced. The golf dead-heat and soccer
DNB rows show the cost of getting this right late vs early.
