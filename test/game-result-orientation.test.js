// Regression test: score matching must report winner/scores in the CALLER's
// home/away orientation, even when the scores feed stores the matchup flipped.
//
// Background (2026-07-25): the TOA-scores path accepted a reverse-orientation
// match (`matchReverse`) but then derived winner + scores from the FEED's
// orientation, silently INVERTING every result whose feed orientation differed
// from ours. MMA/boxing have no true home/away, so sources disagree routinely —
// TOA listed "Ponzinibbio (home) vs Patterson (away)" while our line had
// Patterson as home, so Patterson's WIN graded as a LOSS. Same for Axel Sola
// and Muhammad Said on the same card. The operator saw settled parlays whose
// legs showed ✗ yet were charged as SP losses.
//
// P&L was safe (PX settlementStatus is authoritative in reconcileSettlements),
// but the inverted inferredResult also drives isParlayAlreadyDead — which
// RELEASES EXPOSURE on a live parlay — and the dashboard leg marks, which
// deliberately prefer inferredResult over PX when they disagree.
//
// Tests target _matchScoreGame (the pure matcher extracted from getGameResult)
// so they are deterministic: fixture in, result out, no network. An earlier
// draft stubbed module exports and silently hit the live TOA feed instead —
// it passed only while those scores stayed in TOA's daysFrom window.
//
// Run: npm test   (or: node --test test/game-result-orientation.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

const oddsFeed = require('../services/odds-feed');
const match = oddsFeed._matchScoreGame;

// Real 2026-07-25 UFC card data, in the orientation TOA actually served it.
const T = '2026-07-25T13:00:00Z';
const FEED_GAMES = [
  { homeTeam: 'Santiago Ponzinibbio', awayTeam: 'Sam Patterson', homeScore: 0, awayScore: 1, completed: true, commenceTime: T },
  { homeTeam: 'Ismael Bonfim', awayTeam: 'Axel Sola', homeScore: 0, awayScore: 1, completed: true, commenceTime: T },
  { homeTeam: 'Dustin Jacoby', awayTeam: 'Muhammad Said', homeScore: 0, awayScore: 1, completed: true, commenceTime: T },
];

test('flipped-orientation feed still reports the CALLER\'s winner (Patterson won)', () => {
  // Our line has Patterson as HOME; the feed has him as AWAY.
  const r = match(FEED_GAMES, 'Sam Patterson', 'Santiago Ponzinibbio', T);
  assert.ok(r, 'should match the fight');
  assert.equal(r.winner, 'home', 'Patterson is our HOME and he won — must be "home", not the feed\'s "away"');
  assert.equal(r.homeScore, 1, 'scores must be re-oriented to the caller');
  assert.equal(r.awayScore, 0);
});

test('same fight queried in the feed\'s own orientation also grades correctly', () => {
  const r = match(FEED_GAMES, 'Santiago Ponzinibbio', 'Sam Patterson', T);
  assert.ok(r, 'should match the fight');
  assert.equal(r.winner, 'away', 'Patterson is our AWAY here and he won');
  assert.equal(r.homeScore, 0);
  assert.equal(r.awayScore, 1);
});

test('the other two inverted fights from the same card grade correctly', () => {
  const sola = match(FEED_GAMES, 'Axel Sola', 'Ismael Bonfim', T);
  assert.equal(sola && sola.winner, 'home', 'Sola (our home) won');
  const said = match(FEED_GAMES, 'Muhammad Said', 'Dustin Jacoby', T);
  assert.equal(said && said.winner, 'home', 'Said (our home) won');
});

test('a normal same-orientation feed is unaffected (no false flip)', () => {
  const games = [{ homeTeam: 'Boston Red Sox', awayTeam: 'New York Yankees', homeScore: 5, awayScore: 3, completed: true, commenceTime: T }];
  const r = match(games, 'Boston Red Sox', 'New York Yankees', T);
  assert.equal(r.winner, 'home');
  assert.equal(r.homeScore, 5);
  assert.equal(r.awayScore, 3);
});

test('no match returns null rather than a wrong-fight result', () => {
  assert.equal(match(FEED_GAMES, 'Conor McGregor', 'Michael Chandler', T), null);
});
