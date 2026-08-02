// Pinnacle tennis source — parsing + the sets/games trap.
//
// THE TRAP THIS FILE EXISTS FOR
// -----------------------------
// Pinnacle models one tennis match as TWO matchups: a units="Sets" parent and
// a units="Games" child. The markets feed returns BOTH, and the market `key` is
// IDENTICAL between them — `s;0;s;1.5` is a 1.5-SET spread on the parent and a
// 1.5-GAME spread on the child, at wildly different prices (measured on
// Gea/Shapovalov 2026-08-01: -202/+171 vs -104/-112).
//
// Any parser keyed on the market key or on the points value silently prices a
// games spread off a sets line. That is a far worse error than the coverage gap
// this source closes, and an invisible one — both look like ordinary 1.5
// spreads. These tests use the real observed payload shape.
//
// Run: npm test   (or: node --test test/pinnacle-tennis.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const pin = require('../services/pinnacle-tennis');
const { __devig2: devig2, __amerToProb: amerToProb } = pin;

// --- helpers to drive the real fetch through a stubbed transport -------------
const PARENT_ID = 1633230155; // units=Sets
const CHILD_ID = 1633246783;  // units=Games
const FUTURE = new Date(Date.now() + 6 * 3600 * 1000).toISOString();

function matchups({ start = FUTURE, live = false } = {}) {
  return [
    {
      id: PARENT_ID, parentId: null, units: 'Sets', startTime: start, isLive: live,
      league: { name: 'ATP Los Cabos - Final' },
      participants: [
        { name: 'Arthur Gea', alignment: 'home' },
        { name: 'Denis Shapovalov', alignment: 'away' },
      ],
    },
    {
      id: CHILD_ID, parentId: PARENT_ID, units: 'Games', startTime: start,
      league: { name: 'ATP Los Cabos - Final' },
      participants: [
        { name: 'Arthur Gea (Games)', alignment: 'home' },
        { name: 'Denis Shapovalov (Games)', alignment: 'away' },
      ],
    },
  ];
}

function markets() {
  return [
    // --- parent (SETS) — must never reach the games ladder ---
    { key: 's;0;m', type: 'moneyline', period: 0, matchupId: PARENT_ID, status: 'open',
      prices: [{ designation: 'home', price: 119 }, { designation: 'away', price: -136 }] },
    { key: 's;0;s;1.5', type: 'spread', period: 0, matchupId: PARENT_ID, status: 'open',
      prices: [{ designation: 'home', points: 1.5, price: -202 }, { designation: 'away', points: -1.5, price: 171 }] },
    { key: 's;0;ou;2.5', type: 'total', period: 0, matchupId: PARENT_ID, status: 'open',
      prices: [{ designation: 'over', points: 2.5, price: 139 }, { designation: 'under', points: 2.5, price: -164 }] },

    // --- child (GAMES) — the ladder we want. NOTE the identical spread key ---
    { key: 's;0;s;1.5', type: 'spread', period: 0, matchupId: CHILD_ID, status: 'open',
      prices: [{ designation: 'home', points: 1.5, price: -104 }, { designation: 'away', points: -1.5, price: -112 }] },
    { key: 's;0;s;2.5', type: 'spread', period: 0, matchupId: CHILD_ID, status: 'open',
      prices: [{ designation: 'home', points: 2.5, price: -133 }, { designation: 'away', points: -2.5, price: 112 }] },
    { key: 's;0;ou;22.5', type: 'total', period: 0, matchupId: CHILD_ID, status: 'open',
      prices: [{ designation: 'over', points: 22.5, price: -102 }, { designation: 'under', points: 22.5, price: -114 }] },
    { key: 's;0;ou;23.5', type: 'total', period: 0, matchupId: CHILD_ID, status: 'open',
      prices: [{ designation: 'over', points: 23.5, price: 121 }, { designation: 'under', points: 23.5, price: -144 }] },

    // --- period 1 (first set) — a different PX product, must be ignored ---
    { key: 's;1;ou;10.5', type: 'total', period: 1, matchupId: CHILD_ID, status: 'open',
      prices: [{ designation: 'over', points: 10.5, price: 231 }, { designation: 'under', points: 10.5, price: -294 }] },
    // --- suspended market — must be ignored ---
    { key: 's;0;ou;24.5', type: 'total', period: 0, matchupId: CHILD_ID, status: 'suspended',
      prices: [{ designation: 'over', points: 24.5, price: 150 }, { designation: 'under', points: 24.5, price: -180 }] },
    // --- team_total = PLAYER games won, a different product ---
    { key: 's;0;tt;12.5;home', type: 'team_total', period: 0, matchupId: CHILD_ID, status: 'open',
      prices: [{ designation: 'over', points: 12.5, price: 112 }, { designation: 'under', points: 12.5, price: -133 }] },
    // --- row referencing an unknown matchup — units unknowable, must drop ---
    { key: 's;0;s;3.5', type: 'spread', period: 0, matchupId: 999999999, status: 'open',
      prices: [{ designation: 'home', points: 3.5, price: -110 }, { designation: 'away', points: -3.5, price: -110 }] },
  ];
}

async function run({ mu = matchups(), mk = markets() } = {}) {
  const orig = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    json: async () => (/\/matchups$/.test(String(url)) ? mu : mk),
  });
  // The module caches its fetch impl on first use; clear it so the stub takes.
  delete require.cache[require.resolve('../services/pinnacle-tennis')];
  const fresh = require('../services/pinnacle-tennis');
  try {
    return await fresh.fetchPinnacleTennis();
  } finally {
    global.fetch = orig;
    delete require.cache[require.resolve('../services/pinnacle-tennis')];
  }
}

// --- pure helpers -----------------------------------------------------------
test('amerToProb handles both signs', () => {
  assert.ok(Math.abs(amerToProb(100) - 0.5) < 1e-9);
  assert.ok(Math.abs(amerToProb(-200) - 0.6666667) < 1e-6);
  assert.ok(Math.abs(amerToProb(150) - 0.4) < 1e-9);
  assert.equal(amerToProb(0), null);
  assert.equal(amerToProb(null), null);
});

test('devig2 normalises to 1 and rejects bad input', () => {
  const d = devig2(0.55, 0.55);
  assert.ok(Math.abs(d.a + d.b - 1) < 1e-12);
  assert.ok(Math.abs(d.a - 0.5) < 1e-12);
  assert.equal(devig2(0, 0.5), null);
  assert.equal(devig2(null, 0.5), null);
});

// --- THE TRAP ---------------------------------------------------------------
test('SETS spread never leaks into the GAMES ladder (identical market key)', async () => {
  const { games } = await run();
  assert.equal(games.length, 1);
  const g = games[0];

  // Both matchups carry `s;0;s;1.5`. Only the GAMES one may be used, and it is
  // identified by price, not by key: -104/-112, not the sets -202/+171.
  const s = g.spreadsByLine['1.5'];
  assert.ok(s, 'games 1.5 spread must be present');
  assert.equal(s.home.americanOdds, -104, 'must be the GAMES price, not the sets -202');
  assert.equal(s.away.americanOdds, -112);

  // The sets total (2.5) must not appear anywhere in the games ladder.
  assert.equal(g.totalsByLine['2.5'], undefined, 'sets total 2.5 must not be a games total');
  for (const k of Object.keys(g.totalsByLine)) {
    assert.ok(Number(k) > 10, `games totals are ~20; got ${k}`);
  }
});

test('moneyline comes from the parent and is de-vigged', async () => {
  const { games } = await run();
  const h = games[0].h2h;
  assert.equal(h.home.americanOdds, 119);
  assert.equal(h.away.americanOdds, -136);
  assert.ok(Math.abs(h.home.fairProb + h.away.fairProb - 1) < 1e-12);
  assert.ok(h.away.fairProb > h.home.fairProb, 'the -136 side must be the favourite');
});

test('only period 0 is collected — first-set markets are a different product', async () => {
  const { games } = await run();
  assert.equal(games[0].totalsByLine['10.5'], undefined, 'period-1 total must not appear');
});

test('suspended markets and unresolvable matchups are dropped', async () => {
  const { games } = await run();
  const g = games[0];
  assert.equal(g.totalsByLine['24.5'], undefined, 'suspended market must be skipped');
  assert.equal(g.spreadsByLine['3.5'], undefined, 'unknown matchupId must never be guessed');
});

test('team_total (player games won) is not collected as a match total', async () => {
  const { games } = await run();
  assert.equal(games[0].totalsByLine['12.5'], undefined);
});

test('every de-vigged pair sums to 1', async () => {
  const { games } = await run();
  const g = games[0];
  for (const t of Object.values(g.totalsByLine)) {
    assert.ok(Math.abs(t.over.fairProb + t.under.fairProb - 1) < 1e-12);
  }
  for (const s of Object.values(g.spreadsByLine)) {
    assert.ok(Math.abs(s.home.fairProb + s.away.fairProb - 1) < 1e-12);
  }
});

test('spreads are keyed by the signed HOME handicap', async () => {
  const { games } = await run();
  const g = games[0];
  assert.deepEqual(Object.keys(g.spreadsByLine).sort(), ['1.5', '2.5']);
  assert.equal(g.spreadsByLine['2.5'].line, 2.5);
});

// --- fail-closed behaviour --------------------------------------------------
test('in-play matches are never surfaced', async () => {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const { games } = await run({ mu: matchups({ start: past }) });
  assert.equal(games.length, 0, 'a started match must not produce a game');
});

test('isLive flag alone suppresses a match', async () => {
  const { games } = await run({ mu: matchups({ live: true }) });
  assert.equal(games.length, 0);
});

test('a match with no moneyline is dropped', async () => {
  const mk = markets().filter(m => m.type !== 'moneyline');
  const { games } = await run({ mk });
  assert.equal(games.length, 0, 'no ML = unusable');
});

test('a match with no Games child still yields the moneyline, no ladder', async () => {
  const mu = matchups().filter(m => m.units !== 'Games');
  const { games } = await run({ mu });
  assert.equal(games.length, 1);
  assert.ok(games[0].h2h, 'moneyline still usable');
  assert.deepEqual(games[0].spreadsByLine, {}, 'no games child -> no spreads');
  assert.deepEqual(games[0].totalsByLine, {}, 'no games child -> no totals');
});

test('a transport failure returns an empty board rather than throwing', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('boom'); };
  delete require.cache[require.resolve('../services/pinnacle-tennis')];
  const fresh = require('../services/pinnacle-tennis');
  try {
    const b = await fresh.fetchPinnacleTennis();
    assert.deepEqual(b.games, []);
    assert.equal(b.error, 'boom');
  } finally {
    global.fetch = orig;
    delete require.cache[require.resolve('../services/pinnacle-tennis')];
  }
});

test('a non-array payload is rejected, not parsed', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ error: 'nope' }) });
  delete require.cache[require.resolve('../services/pinnacle-tennis')];
  const fresh = require('../services/pinnacle-tennis');
  try {
    const b = await fresh.fetchPinnacleTennis();
    assert.deepEqual(b.games, []);
    assert.equal(b.error, 'bad shape');
  } finally {
    global.fetch = orig;
    delete require.cache[require.resolve('../services/pinnacle-tennis')];
  }
});

test('rememberBoard keeps only non-empty boards', () => {
  const before = pin.getLastBoard();
  pin.rememberBoard({ games: [], fetchedAt: 1 });
  assert.equal(pin.getLastBoard(), before, 'an empty board must not overwrite a good one');
  const good = { games: [{ homeTeam: 'a' }], fetchedAt: 2 };
  pin.rememberBoard(good);
  assert.equal(pin.getLastBoard(), good);
});
