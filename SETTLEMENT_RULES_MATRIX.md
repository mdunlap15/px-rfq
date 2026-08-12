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
| MLB F5 moneyline / run line / total | Books' `1st_5_innings_*` | Tie after 5 ⇒ no winner ⇒ void/push (Moneyline contract definition; Rules I/J void-on-exact pattern) — matches book convention | Rain <5 innings: Postponed (Rule C, same-calendar-day) / Suspended (Rule D, 36h) ⇒ void unless unequivocally determined — matches book void | **VERIFIED** (PX Baseball Rules, 2026-08-07; F5 has no explicit spec section — settled by the general contract definitions) | https://prophethelp.zendesk.com/hc/en-us/articles/45512047671697 |
| Run first inning (YRFI/NRFI) | TOA `totals_1st_1_innings` | n/a (0.5 line) | | **KNOWN-OPEN, correctly gated OFF** | `config.rfi.enabled` off pending PX side-convention confirmation — do not enable before resolving |
| MLB hitter/K props | TOA + distribution fair | Integer lines push (side-aware since 02c241a) | **PX Rule L (VERIFIED): batter must be in STARTING LINEUP + record ≥1 PA or the leg VOIDS; pitcher must start + throw ≥1 pitch. Parlay legs void individually.** Stricter than some books (bench/pinch-hit settles at DK-style books, voids on PX). Direction: PX voids MORE ⇒ more void-refunds ⇒ neutral-to-slightly-favorable for us as layer; void-adjusted calibration (e21976a) grades it correctly | **VERIFIED** | Extra innings count in all totals (Rule G) |
| Tennis moneyline | Books' h2h | n/a | **Retirement: PX pushed** (Musetti ret → 'push', observed once). Books VARY: Pinnacle voids unless match complete; DK settles after 1 set played | **PARTIAL** | One observation. If PX pushes retirements while a source book settles-after-1-set, the source price embeds win-by-retirement value we refund — small but real |
| Tennis totals / spread (games) | TOA + Pinnacle merge, exact line | Push on exact games line | Retirement mid-match: PX push (same observation); Pinnacle voids incomplete | **PARTIAL** | Directionally aligned (both void/push-ish); the *threshold* (any retirement vs completed-set-1) unverified |
| Tennis 1st-set ML / total sets | TOA `h2h_s1` / `alternate_set_totals` | Exact-line push n/a (2.5) | Set 1 completed → most books settle s1 markets even on later retirement | **PARTIAL** | Lower risk: set-1 markets usually resolve before retirements |
| **Tennis "to win a set" (set_win_at_least_one)** | TOA `alternate_set_spreads` (+1.5 identity) | n/a | **RESOLVED (PX/Anthony 2026-08-07): PX settles YES as already-achieved on retirement after a won set.** Void-on-incomplete source books refund those scenarios, so their +1.5 price slightly UNDERSTATES P(PX YES) — our YES fair is ~1-2% relative cheap (bettor-favorable, bounded by the ~2-4% tour retirement rate). Documented bias; optional retirement premium if it ever matters. Retirement BEFORE any set concludes: still unanswered | **VERIFIED (PX side)** | Mismatch confirmed but small + direction known |
| Team totals (MLB) | TOA per-event `team_totals` | Push on exact (Rule J void-on-exact) | Extra innings count (Rule G, VERIFIED) | **VERIFIED** | |
| NFL/preseason ML, spread, total | TOA multi-book de-vig, same market | **UNVERIFIED on PX**: books settle ML incl. OT with tie→push, spread/total push on exact; regular-season NFL games CAN tie after OT | Postponement/cancellation convention unverified on PX | **UNVERIFIED — ask Anthony before regular season** | Preseason launch Aug 13: tie risk ≈ nil in preseason (OT rules), but the ML-tie and OT-inclusion rules MUST be confirmed before Sept 10. Book side: all consensus books settle incl. OT — if PX excludes OT on any market we cannot price it |
| NFL team totals / first-half | TOA `team_totals` / `*_h1` per-event supplements | Push on exact (book side) | | **UNVERIFIED** | Registration self-heals only when the supplement has the market cached (T1.8 guard); PX-abbreviated team names resolved via the ambiguity-checked guard |
| NFL anytime TD (`player_anytime_td`) | TOA `player_anytime_td` (2 books, Yes-only, book-mirror) | n/a (lineless) | **Book convention: OT counts; player must dress?** — varies by book; PX rule unknown | **UNVERIFIED — do not allowlist until answered** | Coverage must be re-measured in Week 1; allowlist entry is the launch lever and stays out until then |
| NBA/NHL series markets | DK series winners scrape | n/a | Series cancelled: both follow league | **VERIFIED-ish**, out of season | |

## The question for PX (Anthony) — ANSWERED 2026-08-07

Answers folded into the rows above. (1) Tennis to-win-a-set: **settles YES** as
already-achieved on retirement after a won set (retirement before any set
concludes remains open — low priority, tiny probability mass). (2) F5: resolved
by PX's published Baseball Rules (link in the F5 row). Original draft kept for
the record:

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
