// Tennis totals/spreads must be graded in GAMES, never in SETS.
//
// Operator caught it 2026-09-09: Gauff d. Andreeva 2-6 7-6 6-2 (29 games).
// The parlay's "Over 21.5" leg — a Total GAMES market — showed as a LOSS on
// the dashboard while PX had settled it won and the ticket itself was
// settled_lost (bettor won). The score grader had taken ESPN's tennis
// homeScore/awayScore, which are SETS WON (2-1), summed them to 3, compared
// 3 < 21.5, and overrode PX's correct value in memory.
//
// Two things are locked here:
//   1. the ESPN tennis parse now carries homeGames/awayGames (sum of per-set
//      linescore values), null unless every set has a numeric value;
//   2. checkLegResults grades tennis total/spread from those games, clears a
//      set-derived value and defers to PX when games are unavailable, and never
//      reaches the generic homeScore+awayScore branch for tennis.
//
// Run: node --test test/tennis-games-grading.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const espn = require('../services/espn-scores');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'order-tracker.js'), 'utf8');

// ESPN's actual shape for the match (site.api.espn.com WTA scoreboard,
// 2026-09-09): tennis lives in event.groupings[].competitions[], competitors
// are athletes, `score` is absent, and linescores[].value is games per set.
function espnTennisEvent({ homeName, awayName, homeSets, awaySets, completed = true }) {
  const mk = (sets, otherSets) => sets.map((v, i) => ({ value: v, winner: v > otherSets[i] }));
  return {
    date: '2026-09-09T16:40:00Z',
    groupings: [{ competitions: [{
      date: '2026-09-09T16:40:00Z',
      status: { type: { completed, state: completed ? 'post' : 'in', name: completed ? 'STATUS_FINAL' : 'STATUS_IN_PROGRESS' } },
      competitors: [
        { homeAway: 'home', athlete: { displayName: homeName }, winner: true, linescores: mk(homeSets, awaySets) },
        { homeAway: 'away', athlete: { displayName: awayName }, winner: false, linescores: mk(awaySets, homeSets) },
      ],
    }] }],
  };
}

test('ESPN tennis parse: sets stay in homeScore/awayScore, GAMES come out in homeGames/awayGames', () => {
  const ev = espnTennisEvent({ homeName: 'Mirra Andreeva', awayName: 'Coco Gauff', homeSets: [6, 6, 2], awaySets: [2, 7, 6] });
  const [m] = espn._parseTennisMatches(ev, 'wta');
  assert.ok(m, 'match parsed');
  assert.strictEqual(m.completed, true);
  // sets: Andreeva won set 1, Gauff sets 2 and 3
  assert.strictEqual(m.homeScore, 1, 'home (Andreeva) sets won');
  assert.strictEqual(m.awayScore, 2, 'away (Gauff) sets won');
  // games: 6+6+2 = 14, 2+7+6 = 15 → 29 total
  assert.strictEqual(m.homeGames, 14);
  assert.strictEqual(m.awayGames, 15);
  assert.strictEqual(m.homeGames + m.awayGames, 29, 'the match total the Over 21.5 settles on');
});

test('games are null — never a partial sum — when any set lacks a numeric value', () => {
  const ev = espnTennisEvent({ homeName: 'A', awayName: 'B', homeSets: [6, 6], awaySets: [3, 4] });
  ev.groupings[0].competitions[0].competitors[0].linescores[1] = { winner: true };   // value missing
  const [m] = espn._parseTennisMatches(ev, 'wta');
  assert.strictEqual(m.homeGames, null, 'a missing set value must not grade a total off 6 games');
  assert.strictEqual(m.awayGames, 7, 'the other side is still summable');
  const pre = espnTennisEvent({ homeName: 'A', awayName: 'B', homeSets: [], awaySets: [], completed: false });
  const [p] = espn._parseTennisMatches(pre, 'wta');
  assert.strictEqual(p.homeGames, null, 'no sets yet → no games');
});

// --- the grading rule, mirrored from checkLegResults so the arithmetic is pinned
function gradeTennis(result, market, selection, line) {
  // mirrors the code exactly: null/undefined games are UNAVAILABLE, never 0
  // (Number(null) === 0 would grade every total as a 0-game match), and a
  // null line never grades.
  const hg = result.homeGames == null ? NaN : Number(result.homeGames);
  const ag = result.awayGames == null ? NaN : Number(result.awayGames);
  if (!Number.isFinite(hg) || !Number.isFinite(ag) || line == null || !Number.isFinite(Number(line))) return null;
  if (market === 'total') {
    const games = hg + ag;
    if (selection === 'over') return games > line ? 'won' : games < line ? 'lost' : 'push';
    return games < line ? 'won' : games > line ? 'lost' : 'push';
  }
  const margin = selection === 'home' ? (hg - ag) : selection === 'away' ? (ag - hg) : null;
  if (margin == null) return null;
  const adjusted = margin + line;
  return adjusted > 0 ? 'won' : adjusted < 0 ? 'lost' : 'push';
}
function gradeFromSets(result, market, selection, line) {   // the OLD generic branch
  const total = result.homeScore + result.awayScore;
  if (selection === 'over') return total > line ? 'won' : total < line ? 'lost' : 'push';
  return total < line ? 'won' : total > line ? 'lost' : 'push';
}

test('the reported ticket: Over 21.5 on a 29-game match is WON from games and "lost" from sets', () => {
  const r = { homeScore: 1, awayScore: 2, homeGames: 14, awayGames: 15 };
  assert.strictEqual(gradeTennis(r, 'total', 'over', 21.5), 'won');
  assert.strictEqual(gradeFromSets(r, 'total', 'over', 21.5), 'lost', 'this is the bug: 3 sets < 21.5');
});

test('set-count grading marks EVERY tennis Over lost and EVERY Under won, at any real line', () => {
  for (const sets of [[2, 0], [2, 1]]) for (const line of [18.5, 21.5, 22.5, 24.5, 30.5]) {
    const r = { homeScore: sets[0], awayScore: sets[1] };
    assert.strictEqual(gradeFromSets(r, 'total', 'over', line), 'lost');
    assert.strictEqual(gradeFromSets(r, 'total', 'under', line), 'won');
  }
});

test('games spread: the Zheng −3.5 shape — set margin says won, games say lost', () => {
  // Zheng won 2-0 in sets; suppose 6-4 7-6 = 13-10 games → margin +3, −3.5 fails.
  const r = { homeScore: 2, awayScore: 0, homeGames: 13, awayGames: 10 };
  assert.strictEqual(gradeTennis(r, 'spread', 'home', -3.5), 'lost');
  assert.strictEqual(gradeTennis(r, 'spread', 'home', -2.5), 'won');
  assert.strictEqual(gradeTennis(r, 'spread', 'away', 3.5), 'won');
  assert.strictEqual(gradeTennis(r, 'spread', 'home', -3), 'push');
});

test('no games → no grade (defer to PX), never a set-based fallback', () => {
  assert.strictEqual(gradeTennis({ homeScore: 2, awayScore: 0, homeGames: null, awayGames: null }, 'total', 'over', 21.5), null);
  assert.strictEqual(gradeTennis({ homeScore: 2, awayScore: 0 }, 'spread', 'home', -3.5), null);
  assert.strictEqual(gradeTennis({ homeScore: 2, awayScore: 0, homeGames: 12, awayGames: 9 }, 'total', 'over', null), null);
});

// --- structural: the tennis block exists, sits BEFORE the generic branches,
// self-heals, and the sets-based total branch is unreachable for tennis
test('checkLegResults grades tennis total/spread from games before the generic sets-based branch', () => {
  const tennisAt = SRC.indexOf("if (l.sport === 'tennis' && (market === 'total' || market === 'spread'))");
  const genericTotalAt = SRC.indexOf('const total = result.homeScore + result.awayScore;');
  assert.ok(tennisAt > -1, 'tennis block must exist');
  assert.ok(genericTotalAt > -1);
  assert.ok(tennisAt < genericTotalAt, 'tennis must be handled BEFORE the generic homeScore+awayScore total');
  const block = SRC.slice(tennisAt, genericTotalAt);
  assert.ok(/const hg = result\.homeGames == null \? NaN : Number\(result\.homeGames\);/.test(block), 'grades from GAMES, with null treated as unavailable (never 0)');
  assert.ok(/const ag = result\.awayGames == null \? NaN : Number\(result\.awayGames\);/.test(block));
  assert.ok(/games > line \? 'won'/.test(block), 'over rule on games');
  assert.ok(/Clearing set-derived/.test(block), 'self-heals a set-derived value when games are unavailable');
  assert.ok(/gradedFromGames = true/.test(block), 'marks a games-based grade so the self-heal never clears it');
  // The GRADED path must also `continue` — otherwise a correct games-based
  // result falls straight into the generic sets-based total branch below and
  // is overwritten with the wrong answer. Pin the tail of the block: after the
  // games-based "Leg resolved" log there must be a `continue;` before the
  // `checked++` that opens the generic path.
  const resolvedLogAt = block.indexOf('(tennis games ${hg}-${ag})`);');
  assert.ok(resolvedLogAt > -1, 'games-based resolution log present');
  const tail = block.slice(resolvedLogAt);
  const checkedAt = tail.indexOf('checked++;');
  assert.ok(checkedAt > -1, 'the generic path follows the tennis block');
  assert.ok(/\bcontinue;/.test(tail.slice(0, checkedAt)), 'the graded tennis path must continue before the generic branch');
  const noGamesAt = block.indexOf('Clearing set-derived');
  const noGamesTail = block.slice(noGamesAt, resolvedLogAt);
  assert.ok(/\bcontinue;/.test(noGamesTail), 'the no-games path must continue too');
});
