// Tennis SET markets — fair-value resolution in getFairProb.
//
// Without an explicit branch these keys fall through the h2h/spreads/totals
// ladder and return null, i.e. EVERY set RFQ declines "no fair value" while the
// fair sits in the cache. Registration alone is not enough; this is the fourth
// and last gate between PX posting the market and us quoting it.
//
// Run: npm test   (or: node --test test/tennis-sets-fair.test.js)

const { test } = require('node:test');
const assert = require('node:assert');
const of = require('../services/odds-feed');

// Seed a tennis event straight into the cache via the Pinnacle merge path.
function seed() {
  const pin = require('../services/pinnacle-tennis');
  pin.rememberBoard({
    fetchedAt: Date.now(),
    games: [{
      homeTeam: 'Kristina Penickova', awayTeam: 'Antonia Rivera',
      startTime: new Date(Date.now() + 6 * 3600e3).toISOString(),
      eventId: 'TEST1', league: 'ITF', started: false,
      h2h: {
        home: { americanOdds: -200, impliedProb: 0.667, fairProb: 0.65 },
        away: { americanOdds: 165, impliedProb: 0.377, fairProb: 0.35 },
      },
      totalsByLine: {}, spreadsByLine: {},
      sets: {
        format: 'Bo3',
        firstSetMl: { home: { fairProb: 0.6483 }, away: { fairProb: 0.3517 } },
        totalSets: { line: 2.5, over: { fairProb: 0.3169 }, under: { fairProb: 0.6831 } },
        // Self-consistent by construction: 0.7956 + 0.5213 - 0.3169 = 1.
        atLeastOneSet: { home: { fairProb: 0.7956 }, away: { fairProb: 0.5213 } },
        consistency: 0,
      },
    }],
  });
  return of.mergePinnacleTennisMatches({ reapply: true });
}

const H = 'Kristina Penickova', A = 'Antonia Rivera';
const fair = (mkt, sel, line) => of.getFairProb('tennis', H, A, mkt, sel, line);

test('first_set_moneyline resolves both sides', async () => {
  await seed();
  assert.ok(Math.abs(await fair('first_set_moneyline', 'home', null) - 0.6483) < 1e-9);
  assert.ok(Math.abs(await fair('first_set_moneyline', 'away', null) - 0.3517) < 1e-9);
});

test('total_sets resolves over/under at 2.5', async () => {
  await seed();
  assert.ok(Math.abs(await fair('total_sets', 'over', 2.5) - 0.3169) < 1e-9);
  assert.ok(Math.abs(await fair('total_sets', 'under', 2.5) - 0.6831) < 1e-9);
});

test('total_sets REFUSES any line other than PX\'s 2.5', async () => {
  await seed();
  // Pricing a 3.5 off the 2.5 fair would be a different event entirely.
  assert.equal(await fair('total_sets', 'over', 3.5), null);
  assert.equal(await fair('total_sets', 'over', 1.5), null);
});

test('set_win_at_least_one: YES is the stored prob, NO is its complement', async () => {
  await seed();
  const yes = await fair('set_win_at_least_one', 'home_yes', null);
  const no = await fair('set_win_at_least_one', 'home_no', null);
  assert.ok(Math.abs(yes - 0.7956) < 1e-9);
  assert.ok(Math.abs(no - (1 - 0.7956)) < 1e-9, 'NO must be the exact complement (they get swept)');
  assert.ok(Math.abs(yes + no - 1) < 1e-12);
});

test('set_win_at_least_one resolves the AWAY player independently', async () => {
  await seed();
  const awayYes = await fair('set_win_at_least_one', 'away_yes', null);
  assert.ok(Math.abs(awayYes - 0.5213) < 1e-9);
  // The two players' YES probs do NOT sum to 1 — both can win a set (a 2-1).
  const homeYes = await fair('set_win_at_least_one', 'home_yes', null);
  assert.ok(homeYes + awayYes > 1, 'both can win a set, so the pair exceeds 1');
});

test('the set identity survives the round trip through getFairProb', async () => {
  await seed();
  const h = await fair('set_win_at_least_one', 'home_yes', null);
  const a = await fair('set_win_at_least_one', 'away_yes', null);
  const over = await fair('total_sets', 'over', 2.5);
  // P(h>=1) + P(a>=1) - P(over 2.5) = 1
  assert.ok(Math.abs(h + a - over - 1) < 0.02, 'identity broke: ' + (h + a - over));
});

test('an unknown side or selection fails closed', async () => {
  await seed();
  assert.equal(await fair('first_set_moneyline', 'draw', null), null);
  assert.equal(await fair('set_win_at_least_one', 'sideways_yes', null), null);
  assert.equal(await fair('set_win_at_least_one', '', null), null);
});

test('a match with no sets block returns null, never a guess', async () => {
  const pin = require('../services/pinnacle-tennis');
  pin.rememberBoard({
    fetchedAt: Date.now(),
    games: [{
      homeTeam: 'No Sets', awayTeam: 'Player Two',
      startTime: new Date(Date.now() + 6 * 3600e3).toISOString(),
      eventId: 'TEST2', started: false,
      h2h: { home: { fairProb: 0.5 }, away: { fairProb: 0.5 } },
      totalsByLine: {}, spreadsByLine: {}, sets: null,
    }],
  });
  await of.mergePinnacleTennisMatches({ reapply: true });
  assert.equal(await of.getFairProb('tennis', 'No Sets', 'Player Two', 'first_set_moneyline', 'home', null), null);
  assert.equal(await of.getFairProb('tennis', 'No Sets', 'Player Two', 'total_sets', 'over', 2.5), null);
});
