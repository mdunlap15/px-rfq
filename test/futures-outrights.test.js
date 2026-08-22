// Futures / outright board: field normalization and entity resolution.
//
// The entity matcher is the dangerous part. PX writes the school or city
// ("Georgia"); TOA appends the mascot ("Georgia Bulldogs"). Naive prefix
// matching resolves "Georgia" to Georgia Tech just as happily, which would
// price one team's futures line off another team's probability.

const test = require('node:test');
const assert = require('node:assert');
const F = require('../services/futures-outrights');

const SPORT = 'americanfootball_ncaaf_championship_winner';
const EVENT = 'National Champion 2026/27';

// Entity keys as the fetcher stores them (already normalized + summing to 1).
const BOARD = {
  sport: SPORT, label: 'ncaaf_championship_winner', target: 1, books: 6,
  bookKeys: ['pinnacle', 'draftkings', 'fanduel'], overrounds: [1.3, 1.407, 1.369],
  entities: {
    'ohio state buckeyes': 0.30,
    'notre dame fighting irish': 0.20,
    'oregon ducks': 0.15,
    'oregon state beavers': 0.05,
    'georgia bulldogs': 0.12,
    'georgia tech yellow jackets': 0.03,
    'texas longhorns': 0.09,
    'texas tech red raiders': 0.02,
    'miami hurricanes': 0.02,
    'miami redhawks': 0.02,
  },
  fetchedAt: Date.now(),
};
F.__debugSetBoard(SPORT, BOARD);

const fair = (name) => F.getFuturesFairSync(EVENT, name);

test('maps a PX short name onto the right mascot-suffixed entity', () => {
  assert.strictEqual(fair('Ohio State'), 0.30);
  assert.strictEqual(fair('Oregon'), 0.15);       // NOT Oregon State
  assert.strictEqual(fair('Georgia'), 0.12);      // NOT Georgia Tech
  assert.strictEqual(fair('Texas'), 0.09);        // NOT Texas Tech
});

test('handles multi-word mascots', () => {
  // "notre dame fighting irish" needs TWO trailing words stripped.
  assert.strictEqual(fair('Notre Dame'), 0.20);
});

test('a one-word PX name cannot claim a two-word school via mascot stripping', () => {
  // Stripping TWO words from "ohio state buckeyes" yields "ohio", so without a
  // guard PX's "Ohio" (the Bobcats) takes OHIO STATE's probability. This board
  // has no Bobcats entry, which is exactly the case a live-board ambiguity
  // check would NOT have caught.
  assert.strictEqual(fair('Ohio'), null);
});

test('but it still resolves when its own entity is on the board', () => {
  const S3 = 'baseball_mlb_world_series_winner';
  F.__debugSetBoard(S3, { ...BOARD, sport: S3, entities: {
    ...BOARD.entities, 'ohio bobcats': 0.01,
  } });
  assert.strictEqual(F.getFuturesFairSync('2026 World Series Winner', 'Ohio'), 0.01);
  assert.strictEqual(F.getFuturesFairSync('2026 World Series Winner', 'Ohio State'), 0.30);
});

test('a genuinely ambiguous name fails closed', () => {
  // Miami Hurricanes vs Miami RedHawks -- both strip to "miami".
  assert.strictEqual(fair('Miami'), null);
});

test('exact matches win outright', () => {
  assert.strictEqual(fair('Oregon State'), 0.05);
  assert.strictEqual(fair('Georgia Tech'), 0.03);
});

test('unknown entities and blanks return null, never a guess', () => {
  for (const n of ['Nonexistent Team', '', null, undefined, '   ']) {
    assert.strictEqual(fair(n), null, `expected null for ${String(n)}`);
  }
});

test('a stale board declines rather than quoting old prices', () => {
  const S2 = 'baseball_mlb_world_series_winner';
  F.__debugSetBoard(S2, { ...BOARD, sport: S2 }, Date.now() - 999 * 60 * 60 * 1000);
  assert.strictEqual(F.getFuturesFairSync('2026 World Series Winner', 'Ohio State'), null);
});

test('an unmapped PX futures event is not classified', () => {
  // No TOA source exists for these; they must never resolve to some other
  // board's numbers.
  for (const n of ['Regular Season Win Totals 2026/27', 'NFL MVP 2026/27',
                   'NFL Division Winners 2026/27', 'Premier League Winner 2026/27',
                   'Heisman Winner 2026', '2026 AL Triple Crown Winner']) {
    assert.strictEqual(F.classifyFuturesEvent(n), null, `${n} must not classify`);
  }
});

test('Super Bowl WINNER classifies but Super Bowl MVP does not', () => {
  assert.strictEqual(F.classifyFuturesEvent('Super Bowl LXI Winner').label, 'nfl_super_bowl_winner');
  assert.strictEqual(F.classifyFuturesEvent('Super Bowl MVP 2026/27'), null);
});

test('powerNormalize drives an overround field to exactly the target', () => {
  const probs = [0.30, 0.25, 0.20, 0.18, 0.15, 0.12, 0.10, 0.08];
  const raw = probs.reduce((a, b) => a + b, 0);
  assert.ok(raw > 1.3, 'fixture should carry a real overround');
  const k = F.powerNormalize(probs, 1);
  const out = probs.map(p => Math.pow(p, k));
  assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('powerNormalize shrinks longshots harder than favourites', () => {
  // Must be an OVERROUND field (sum > 1) -- that is what a book posts. On an
  // underround the exponent goes the other way and so does the effect.
  const probs = [0.40, 0.35, 0.30, 0.20];
  assert.ok(probs.reduce((a, b) => a + b, 0) > 1);
  const k = F.powerNormalize(probs, 1);
  const pw = probs.map(p => Math.pow(p, k));
  const s = pw.reduce((a, b) => a + b, 0);
  const norm = pw.map(p => p / s);
  const prop = probs.map(p => p / probs.reduce((a, b) => a + b, 0));
  assert.ok(norm[0] > prop[0], 'favourite higher under power');
  assert.ok(norm[3] < prop[3], 'longest shot lower under power');
});

test('powerNormalize returns null when it cannot bracket', () => {
  assert.strictEqual(F.powerNormalize([], 1), null);
  assert.strictEqual(F.powerNormalize([0.5, 0.5], 0), null);
});

test('the alias map covers the one shape the matcher cannot', () => {
  const S4 = 'americanfootball_nfl_super_bowl_winner';
  F.__debugSetBoard(S4, { ...BOARD, sport: S4, entities: {
    ...BOARD.entities, 'alabama crimson tide': 0.04,
  } });
  // "Alabama" is a ONE-word school with a TWO-word mascot. Any rule that
  // resolves it by string shape also resolves "Ohio" -> Ohio State, so it is
  // listed explicitly instead.
  assert.strictEqual(F.getFuturesFairSync('Super Bowl LXI Winner', 'Alabama'), 0.04);
  // The alias must not weaken the collision guard.
  assert.strictEqual(F.getFuturesFairSync('Super Bowl LXI Winner', 'Ohio'), null);
});

test('an alias pointing at an absent entity still fails closed', () => {
  const S5 = 'baseball_mlb_world_series_winner';
  F.__debugSetBoard(S5, { ...BOARD, sport: S5 }); // no Crimson Tide on this board
  assert.strictEqual(F.getFuturesFairSync('2026 World Series Winner', 'Alabama'), null);
});
