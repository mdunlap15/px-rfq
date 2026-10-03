// UFC method-of-victory RFQ legs on the ORDER-BOOK methodology (2026-10-03).
//
// Operator directive: "We should be quoting (1-sided) UFC MoV lines. Use the
// methodology we use for the order book lines." Reference chain (read-only):
// ufc_mov_board_bov.py (stager) -> ufc_mov_post.py (poster), MOV_FLOOR=-300,
// px_post_client.devig_n_shin. What is pinned here:
//   - Shin port == px_post_client.devig_n_shin (reference values computed by the
//     Python function itself, copied verbatim)
//   - parsing of a REAL Bovada coupon (test/fixtures, captured 2026-10-03 21:18Z)
//   - YES-only registration at the seed + cache-restore entry points
//   - the +300 floor, the 26h window, stale/cold fail-closed, refusal rules
//   - mirror price == Bovada raw YES implied; fair == 6-way Shin; ITD = KO+SUB
//   - same-fight block intact; MOV_SOURCE=dk restores the old behaviour
//
// Run: npm test   (or: node --test test/bovada-mov.test.js)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

delete process.env.MOV_SOURCE;
delete process.env.MOV_MIRROR_FLOOR_AT_FAIR;

const bov = require('../services/bovada-mov');
const ufcMov = require('../services/ufc-mov');
const px = require('../services/prophetx');
const lineManager = require('../services/line-manager');
const db = require('../services/db');
const oddsFeed = require('../services/odds-feed');
const pricer = require('../services/pricer');
const { config } = require('../config');

const COUPON = require('./fixtures/bovada-ufc-coupon-2026-10-03.json');
const NOW = Date.parse('2026-10-03T21:18:00Z');          // capture time
const A2P = (a) => (a >= 100 ? 100 / (a + 100) : -a / (-a + 100));
const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

// The fixture's fight starts are real (2026-10-03/04); quotes are evaluated at
// the capture time so the window/started checks see the card as it was.
function load() { bov.ingestCoupon(COUPON, { nowMs: NOW, at: NOW }); }
beforeEach(() => {
  load();
  delete process.env.MOV_SOURCE;
  delete process.env.MOV_MIRROR_FLOOR_AT_FAIR;
  config.pricing.movRfqMinYesOdds = 300;
  config.pricing.movBookMirrorSweetener = 0;
});

// A PX MoV line as the seed registers it (parseMarketSelections shape +
// _setSeedLine fields). PX names Parkin "Mick" — Bovada says "Michael".
function movLine(over) {
  return Object.assign({
    sport: 'mma_mixed_martial_arts', oddsApiSport: 'mma_mixed_martial_arts',
    marketType: 'mov_ko', oddsApiMarket: 'mov_ko', selection: 'yes', oddsApiSelection: 'yes',
    playerName: 'Mick Parkin', teamName: 'Mick Parkin',
    homeTeam: 'Johnny Walker', awayTeam: 'Mick Parkin',
    pxEventId: 31406573, pxEventName: 'Johnny Walker vs Mick Parkin',
    startTime: '2026-10-03T22:15:00Z',
  }, over);
}
const q = (over, opts) => bov.getQuoteForLine(movLine(over), Object.assign({ nowMs: NOW }, opts));
const reg = (over) => bov.registrationRefusal(movLine(over), { nowMs: NOW });

// ---------------------------------------------------------------------------
// 1. Shin port — reference values from px_post_client.devig_n_shin itself
// ---------------------------------------------------------------------------
test('devigNShin == px_post_client.devig_n_shin (Walker/Parkin, Gautier/Kopylov, S<=1, 3-way)', () => {
  const p = A2P;
  const W = [p(250), p(1800), p(350) + p(1000), p(300), p(800), p(500) + p(1100)];
  const G = [p(105), p(2000), p(500) + p(1100), p(475), p(2800), p(500) + p(1100)];
  const REF = {
    W: [0.23403920982868734, 0.027159715980564925, 0.2589995977731655, 0.2015709591533815, 0.07665955811081933, 0.2015709591533815],
    G: [0.4217850836044488, 0.023594458954120934, 0.20333230176083025, 0.13394141320291456, 0.014014440716855134, 0.20333230176083025],
    U: [0.3333333333333333, 0.22222222222222224, 0.11111111111111112, 0.16666666666666666, 0.11111111111111112, 0.05555555555555556],
    H: [0.6197244927631113, 0.2656385425046946, 0.11463696473219419],
  };
  const chk = (got, ref) => { assert.equal(got.length, ref.length); got.forEach((x, i) => assert.ok(close(x, ref[i], 1e-12), `${x} vs ${ref[i]}`)); };
  chk(bov.devigNShin(W, 1.0), REF.W);
  chk(bov.devigNShin(G, 1.0), REF.G);
  chk(bov.devigNShin([0.3, 0.2, 0.1, 0.15, 0.1, 0.05], 1.0), REF.U);
  chk(bov.devigNShin([0.9, 0.5, 0.3], 1.0), REF.H);
  assert.equal(bov.devigNShin([0.5], 1.0), null, 'fewer than 2 outcomes -> null');
});

// ---------------------------------------------------------------------------
// 2. Parsing a real Bovada coupon
// ---------------------------------------------------------------------------
test('fixture: straight quotes per fighter x method, DEC = UD + split/majority synth', () => {
  const f = bov.parseCoupon(COUPON, { nowMs: NOW })['31406573'];
  assert.equal(f.home, 'Johnny Walker');
  assert.equal(f.away, 'Michael Parkin');
  const w = f.fighters['Johnny Walker'], pk = f.fighters['Michael Parkin'];
  assert.equal(w.KO.american, 250);       // "Wins by KO, TKO or DQ" (the comma case)
  assert.equal(w.SUB.american, 1800);
  assert.equal(w.ITD.american, 200);      // "Wins Inside Distance" — a direct quote
  // "Decision or Technical Decision" is dropped (technical); DEC = UD +350 + SMD +1000
  // = 0.31313 -> int(round(100*(1-p)/p)) = 219, exactly as the stager.
  assert.equal(w.DEC.american, 219);
  assert.equal(pk.KO.american, 300);
  assert.equal(pk.DEC.american, 300);      // UD +500 + SMD +1100 -> 0.25 -> +300
  assert.deepEqual(f.refusals, []);
});

test('fixture: "Roman Kopylov Wins by Submission" is SUB, not ITD (ko read as a token)', () => {
  const f = bov.parseCoupon(COUPON, { nowMs: NOW })['31386993'];
  assert.equal(f.fighters['Roman Kopylov'].SUB.american, 2800);
  assert.equal(f.fighters['Roman Kopylov'].ITD.american, 400);
  assert.ok(f.fair, 'Gautier/Kopylov must carry a complete 6-way fair');
});

test('fixture: Bout Specials, round-specific, double chance and conditional winners never enter', () => {
  const f = bov.parseCoupon(COUPON, { nowMs: NOW })['31406573'];
  // Bout Specials "Johnny Walker by KO/TKO or Michael Parkin by Points +110" would
  // be a second, disagreeing Walker KO quote — it must not be there.
  assert.ok(!f.fighters['Johnny Walker'].KO.refused);
  assert.equal(bov.methodOf('Johnny Walker by TKO/KO/DQ in Round 1'), null);
  assert.equal(bov.methodOf('Johnny Walker by TKO/KO/DQ in Rounds 1 or 2'), null);
  assert.equal(bov.methodOf('Double Chance Johnny Walker by TKO/KO/DQ or Submission'), null);
  assert.equal(bov.methodOf('Fight Winner - Inside The Distance Only Johnny Walker'), null);
  assert.equal(bov.methodOf('Johnny Walker Wins by Decision or Technical Decision'), null);
  assert.equal(bov.methodOf('Johnny Walker Wins by KO, TKO or DQ'), 'KO');
  assert.equal(bov.methodOf('Johnny Walker Wins Inside Distance'), 'ITD');
  assert.equal(bov.methodOf('Johnny Walker Wins by Unanimous Decision'), 'DECU');
  assert.equal(bov.methodOf('Johnny Walker Wins by Split or Majority Decision'), 'DECS');
  assert.equal(bov.methodOf('Roman Kopylov Wins by Submission'), 'SUB');
  // non-MMA / no-MoV events (ACA prelims carry only the fight line) are absent
  const all = bov.parseCoupon(COUPON, { nowMs: NOW });
  assert.ok(!Object.values(all).some(x => /Khasaev|Specials/.test(x.description)));
});

test('fixture fair == 6-way Shin of the straight quotes, ITD fair = KO + SUB', () => {
  const f = bov.parseCoupon(COUPON, { nowMs: NOW })['31406573'];
  assert.ok(close(f.fair['Johnny Walker'].KO, 0.23403920982868734));
  assert.ok(close(f.fair['Michael Parkin'].DEC, 0.2015709591533815));
  for (const n of ['Johnny Walker', 'Michael Parkin']) {
    assert.ok(close(f.fair[n].ITD, f.fair[n].KO + f.fair[n].SUB));
  }
});

// ---------------------------------------------------------------------------
// 3. The quote: mirror, fair, floor, window, freshness, names
// ---------------------------------------------------------------------------
test('offered prob == Bovada raw YES implied exactly; fairProb == Shin', () => {
  const r = q({});                                    // Parkin KO +300
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.yesAmerican, 300);
  assert.equal(r.bookPriceOverride, 0.25);
  assert.equal(r.rawImplied, 0.25);
  assert.ok(close(r.fairProb, 0.2015709591533815));
  assert.equal(r.clampedToFair, false);
});

test('ITD leg prices off Bovada\'s own ITD quote; fair = KO + SUB', () => {
  config.pricing.movRfqMinYesOdds = 150;
  const r = q({ marketType: 'mov_itd' });             // Parkin ITD +185
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(close(r.bookPriceOverride, A2P(185)));
  assert.ok(close(r.fairProb, 0.2015709591533815 + 0.07665955811081933));
});

test('+300 floor: YES +250 refused (quote AND registration), +300 admitted, runtime-tunable', () => {
  const lo = q({ playerName: 'Johnny Walker', teamName: 'Johnny Walker' });  // Walker KO +250
  assert.equal(lo.ok, false); assert.equal(lo.reason, 'mov_below_floor');
  assert.equal(reg({ playerName: 'Johnny Walker', teamName: 'Johnny Walker' }), 'mov_below_floor');
  assert.equal(reg({}), null, 'Parkin KO +300 sits exactly on the floor and registers');
  config.pricing.movRfqMinYesOdds = 200;
  assert.equal(q({ playerName: 'Johnny Walker', teamName: 'Johnny Walker' }).ok, true);
  config.pricing.movRfqMinYesOdds = 301;
  assert.equal(q({}).reason, 'mov_below_floor');
});

test('sweetener defaults to 0 and is opt-in', () => {
  assert.equal(config.pricing.movBookMirrorSweetener, 0);
  config.pricing.movBookMirrorSweetener = 0.02;
  assert.ok(close(q({}).bookPriceOverride, 0.25 * 0.98));
});

test('mirror below fair is floored at fair (MOV_MIRROR_FLOOR_AT_FAIR=false opts out)', () => {
  // Synthetic fight whose ITD quote sits BELOW KO+SUB fair.
  const ev = {
    id: '1', description: 'Alpha One vs Bravo Two', startTime: NOW + 3600e3,
    displayGroups: [{ markets: [
      { description: 'Method of Victory', outcomes: [
        ['Alpha One Wins by KO, TKO or DQ', '+150'], ['Alpha One Wins by Submission', '+300'], ['Alpha One Wins by Decision', '+500'],
        ['Bravo Two Wins by KO, TKO or DQ', '+600'], ['Bravo Two Wins by Submission', '+900'], ['Bravo Two Wins by Decision', '+700'],
      ].map(([d, a]) => ({ description: d, status: 'O', price: { american: a } })) },
      { description: 'Alternate Method of Victory', outcomes: [{ description: 'Alpha One Wins Inside Distance', status: 'O', price: { american: '+300' } }] },
    ] }],
  };
  bov.ingestCoupon([{ events: [ev] }], { nowMs: NOW, at: NOW });
  const li = { marketType: 'mov_itd', playerName: 'Alpha One', homeTeam: 'Alpha One', awayTeam: 'Bravo Two', selection: 'yes', startTime: new Date(NOW + 3600e3).toISOString() };
  const r = bov.getQuoteForLine(li, { nowMs: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.fairProb > 0.25, 'setup: fair ITD must exceed the raw +300 (25%)');
  assert.equal(r.bookPriceOverride, r.fairProb);
  assert.equal(r.clampedToFair, true);
  process.env.MOV_MIRROR_FLOOR_AT_FAIR = 'false';
  assert.equal(bov.getQuoteForLine(li, { nowMs: NOW }).bookPriceOverride, 0.25);
});

test('NO side refused everywhere', () => {
  assert.equal(q({ selection: 'no' }).reason, 'mov_no_side');
  assert.equal(reg({ selection: 'no' }), 'mov_no_side');
});

test('window: beyond 26h refused; unparseable start fails closed; started declines', () => {
  assert.equal(q({ startTime: new Date(NOW + 27 * 3600e3).toISOString() }).reason, 'mov_beyond_window');
  assert.equal(reg({ startTime: new Date(NOW + 27 * 3600e3).toISOString() }), 'mov_beyond_window');
  assert.equal(q({ startTime: 'tbd' }).reason, 'mov_start_unknown');
  assert.equal(reg({ startTime: null }), 'mov_start_unknown');
  assert.equal(q({}, { nowMs: Date.parse('2026-10-03T22:16:00Z') }).ok, false);
});

test('stale / cold board fails closed for pricing but NEVER de-registers', () => {
  bov.__setCache({ at: NOW - 31 * 60e3, fights: bov.parseCoupon(COUPON, { nowMs: NOW }) });
  assert.equal(q({}).reason, 'mov_board_stale');
  assert.equal(reg({}), null, 'a 31-min-old board still steers registration (floor) — no flap');
  bov.__setCache({ at: 0, fights: {} });
  assert.equal(q({}).reason, 'mov_board_cold');
  assert.equal(reg({}), null, 'cold board registers YES and lets pricing fail closed');
  assert.equal(reg({ playerName: 'Johnny Walker', teamName: 'Johnny Walker' }), null,
    'with no board there is no floor evidence — register, pricing decides');
  assert.equal(reg({ selection: 'no' }), 'mov_no_side', 'NO is refused regardless of board state');
});

test('fight Bovada has not posted yet registers (pricing declines)', () => {
  const li = { marketType: 'mov_ko', playerName: 'Nobody Here', homeTeam: 'Nobody Here', awayTeam: 'Someone Else', selection: 'yes', startTime: new Date(NOW + 3600e3).toISOString() };
  assert.equal(bov.registrationRefusal(li, { nowMs: NOW }), null);
  assert.equal(bov.getQuoteForLine(li, { nowMs: NOW }).reason, 'mov_fight_not_on_board');
});

test('names: nickname accepted only when the surname is unique in the bout; collisions refuse', () => {
  assert.equal(q({}).fighter, 'Michael Parkin', 'PX "Mick Parkin" = Bovada "Michael Parkin"');
  const mk = (h, a) => ({ id: h, description: `${h} vs ${a}`, startTime: NOW + 3600e3, displayGroups: [{ markets: [
    { description: 'Method of Victory', outcomes: [h, a].flatMap(n => [['KO, TKO or DQ', '+400'], ['Submission', '+500'], ['Decision', '+350']]
      .map(([m, o]) => ({ description: `${n} Wins by ${m}`, status: 'O', price: { american: o } }))) }] }] });
  bov.ingestCoupon([{ events: [mk('Abus Magomedov', 'Shara Magomedov')] }], { nowMs: NOW, at: NOW });
  const st = new Date(NOW + 3600e3).toISOString();
  const ok = bov.getQuoteForLine({ marketType: 'mov_ko', playerName: 'Shara Magomedov', homeTeam: 'Abus Magomedov', awayTeam: 'Shara Magomedov', selection: 'yes', startTime: st }, { nowMs: NOW });
  assert.equal(ok.ok, true); assert.equal(ok.fighter, 'Shara Magomedov');
  // A shared surname never matches on surname alone.
  const bad = bov.getQuoteForLine({ marketType: 'mov_ko', playerName: 'Said Magomedov', homeTeam: 'Abus Magomedov', awayTeam: 'Said Magomedov', selection: 'yes', startTime: st }, { nowMs: NOW });
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'mov_fight_not_on_board');
  // The same bout twice on the board -> ambiguous, never a guess.
  const e1 = mk('Abus Magomedov', 'Shara Magomedov'); const e2 = mk('Abus Magomedov', 'Shara Magomedov'); e2.id = 'dup';
  bov.ingestCoupon([{ events: [e1, e2] }], { nowMs: NOW, at: NOW });
  assert.equal(bov.registrationRefusal({ marketType: 'mov_ko', playerName: 'Shara Magomedov', homeTeam: 'Abus Magomedov', awayTeam: 'Shara Magomedov', selection: 'yes', startTime: st }, { nowMs: NOW }), 'mov_fight_ambiguous');
  // Mojibake: PX's U+FFFD is a one-char wildcard on the surname.
  assert.ok(bov.fuzzyEq(bov.surname('Norbert N�v�nyi Jr.'), bov.surname('Norbert Novenyi')));
});

test('duplicate quotes that disagree are refused (quote and registration)', () => {
  const ev = { id: '9', description: 'Cee Three vs Dee Four', startTime: NOW + 3600e3, displayGroups: [{ markets: [
    { description: 'Method of Victory', outcomes: [{ description: 'Cee Three Wins by KO, TKO or DQ', status: 'O', price: { american: '+400' } }] },
    { description: 'Alternate Method of Victory', outcomes: [{ description: 'Cee Three Wins by KO/TKO', status: 'O', price: { american: '+450' } }] },
  ] }] };
  bov.ingestCoupon([{ events: [ev] }], { nowMs: NOW, at: NOW });
  const li = { marketType: 'mov_ko', playerName: 'Cee Three', homeTeam: 'Cee Three', awayTeam: 'Dee Four', selection: 'yes', startTime: new Date(NOW + 3600e3).toISOString() };
  assert.equal(bov.getQuoteForLine(li, { nowMs: NOW }).reason, 'mov_quote_refused');
  assert.equal(bov.registrationRefusal(li, { nowMs: NOW }), 'mov_quote_refused');
});

test('a Bout Specials quote naming ONE fighter never collides with the straight quote', () => {
  // On the live card every Bout Special either names both fighters or a round,
  // so other filters catch it; this one would slip through as a second KO quote.
  const ev = { id: '7', description: 'Gee Seven vs Aitch Eight', startTime: NOW + 3600e3, displayGroups: [{ markets: [
    { description: 'Method of Victory', outcomes: [{ description: 'Gee Seven Wins by KO, TKO or DQ', status: 'O', price: { american: '+400' } }] },
    { description: 'Bout Specials', outcomes: [{ description: 'Gee Seven to Win by KO/TKO', status: 'O', price: { american: '+900' } }] },
  ] }] };
  const f = bov.parseCoupon([{ events: [ev] }], { nowMs: NOW })['7'];
  assert.equal(f.fighters['Gee Seven'].KO.american, 400);
  assert.ok(!f.fighters['Gee Seven'].KO.refused);
});

test('incomplete 6-way field -> no fair -> leg declines (poster blanks the fair)', () => {
  const ev = { id: '8', description: 'Eee Five vs Eff Six', startTime: NOW + 3600e3, displayGroups: [{ markets: [
    { description: 'Method of Victory', outcomes: [{ description: 'Eee Five Wins by KO, TKO or DQ', status: 'O', price: { american: '+400' } }] }] }] };
  bov.ingestCoupon([{ events: [ev] }], { nowMs: NOW, at: NOW });
  const r = bov.getQuoteForLine({ marketType: 'mov_ko', playerName: 'Eee Five', homeTeam: 'Eee Five', awayTeam: 'Eff Six', selection: 'yes', startTime: new Date(NOW + 3600e3).toISOString() }, { nowMs: NOW });
  assert.equal(r.reason, 'mov_no_fair');
});

// ---------------------------------------------------------------------------
// 4. Registration at the index entry points
// ---------------------------------------------------------------------------
// _setSeedLine / lookupLineAsync evaluate against the real clock, so these
// cases use a board built "now" with fights starting in the next hours.
function liveBoard() {
  const now = Date.now();
  const shift = now + 3600e3 - Date.parse('2026-10-03T22:15:00Z');
  const body = JSON.parse(JSON.stringify(COUPON));
  for (const g of body) for (const e of g.events) e.startTime += shift;
  bov.ingestCoupon(body, { nowMs: now, at: now });
  return new Date(now + 3600e3).toISOString();   // Walker/Parkin start
}

test('seed (_setSeedLine): NO never enters the index; YES below floor refused; eligible YES enters', () => {
  const st = liveBoard();
  const idx = lineManager.__debugGetLineIndex();
  const no = lineManager._setSeedLine('mov-no-1', movLine({ selection: 'no', oddsApiSelection: 'no', startTime: st }));
  assert.equal(no._marketDenied, true); assert.ok(!idx['mov-no-1']);
  const lo = lineManager._setSeedLine('mov-lo-1', movLine({ playerName: 'Johnny Walker', teamName: 'Johnny Walker', startTime: st }));
  assert.equal(lo._marketDenied, true); assert.ok(!idx['mov-lo-1']);
  const ok = lineManager._setSeedLine('mov-ok-1', movLine({ startTime: st }));
  assert.ok(!ok._marketDenied); assert.ok(idx['mov-ok-1']);
  delete idx['mov-ok-1'];
});

test('cache restore (lookupLineAsync): a cached NO / below-floor MoV line does not resurrect', async () => {
  const st = liveBoard();
  const orig = db.loadLineCacheEntry;
  try {
    db.loadLineCacheEntry = async () => movLine({ selection: 'no', oddsApiSelection: 'no', startTime: st });
    assert.equal(await lineManager.lookupLineAsync('mov-cache-no'), null);
    db.loadLineCacheEntry = async () => movLine({ playerName: 'Johnny Walker', teamName: 'Johnny Walker', startTime: st });
    assert.equal(await lineManager.lookupLineAsync('mov-cache-lo'), null);
    db.loadLineCacheEntry = async () => movLine({ startTime: st });
    assert.ok(await lineManager.lookupLineAsync('mov-cache-ok'));
  } finally {
    db.loadLineCacheEntry = orig;
    delete lineManager.__debugGetLineIndex()['mov-cache-ok'];
  }
});

test('all three index entry points consult the MoV gate (on-demand pinned structurally)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/line-manager'), 'utf8');
  const body = (name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, i + 40000); };
  assert.ok(/_movRefusal\(info\)/.test(body('function _setSeedLine(')));
  assert.ok(/_movRefusal\(cached\)/.test(body('async function lookupLineAsync(')));
  assert.ok(/_movRefusal\(foundInfo\)/.test(src.slice(src.indexOf('async function resolveUnknownLine('))));
});

// ---------------------------------------------------------------------------
// 5. PX market parse: name/sub_type cross-check + side by NAME, uniquely
// ---------------------------------------------------------------------------
const pxMkt = (name, subType, sels) => ({ type: 'moneyline', name, sub_type: subType, selections: [sels.map(([n, id]) => ({ name: n, line_id: id }))] });
test('parseMarketSelections: sub_type agreeing / absent parses; disagreeing or duplicate side refuses', () => {
  const ok = px.parseMarketSelections(pxMkt('Mick Parkin To Win By KO/TKO/DQ', 'fighter_to_win_by_knockout_tko', [['YES', 'y1'], ['NO', 'n1']]));
  assert.deepEqual(ok.map(s => [s.marketType, s.selection, s.playerName]), [['mov_ko', 'yes', 'Mick Parkin'], ['mov_ko', 'no', 'Mick Parkin']]);
  assert.equal(px.parseMarketSelections(pxMkt('Mick Parkin To Win By KO/TKO/DQ', undefined, [['YES', 'y1'], ['NO', 'n1']])).length, 2);
  // PX inverts the ids on Decision — the side still comes from the NAME.
  const dec = px.parseMarketSelections(pxMkt('Mick Parkin To Win By Decision', 'fighter_to_win_by_decision', [['NO', 'id1'], ['YES', 'id2']]));
  assert.equal(dec.find(s => s.selection === 'yes').lineId, 'id2');
  assert.deepEqual(px.parseMarketSelections(pxMkt('Piero Guaylupo To Win By Submission', 'fighter_to_win_by_unanimous_decision', [['YES', 'y'], ['NO', 'n']])), []);
  assert.deepEqual(px.parseMarketSelections(pxMkt('X Y To Win Inside The Distance', 'fighter_to_win_by_split_or_majority_decision', [['YES', 'y'], ['NO', 'n']])), []);
  assert.deepEqual(px.parseMarketSelections(pxMkt('Mick Parkin To Win By Submission', 'fighter_to_win_by_submission', [['YES', 'a'], ['YES', 'b'], ['NO', 'n']])), []);
});

// ---------------------------------------------------------------------------
// 6. Pricer + shouldDecline
// ---------------------------------------------------------------------------
const LINES = {};
const origLookup = lineManager.lookupLine;
const origStale = oddsFeed.isStaleForEvent, origStalePre = oddsFeed.isEventStalePreGame;
lineManager.lookupLine = (id) => LINES[id] || origLookup(id);
oddsFeed.isStaleForEvent = () => false;
oddsFeed.isEventStalePreGame = () => false;
process.on('exit', () => { lineManager.lookupLine = origLookup; oddsFeed.isStaleForEvent = origStale; oddsFeed.isEventStalePreGame = origStalePre; });

function pricerLines() {
  // The local .env carries a $10 MAX_RISK_PER_PARLAY; at MoV longshot odds that
  // is below PX's $1 minimum stake ("unfillable within cap"). Use a prod-like cap.
  if (!(config.pricing.maxRiskPerParlay >= 500)) config.pricing.maxRiskPerParlay = 500;
  const st1 = liveBoard();
  const st2 = new Date(Date.parse(st1) + 2.5 * 3600e3).toISOString();   // Gautier/Kopylov
  const base = (o) => { const li = movLine(o); li.startTimeMs = Date.parse(li.startTime); return li; };
  Object.assign(LINES, {
    'pk-ko': base({ startTime: st1 }),
    'pk-ko-no': base({ startTime: st1, selection: 'no', oddsApiSelection: 'no' }),
    'jw-sub': base({ startTime: st1, marketType: 'mov_sub', oddsApiMarket: 'mov_sub', playerName: 'Johnny Walker', teamName: 'Johnny Walker' }),
    'rk-ko': base({ startTime: st2, playerName: 'Roman Kopylov', teamName: 'Roman Kopylov', homeTeam: 'Ateba Gautier', awayTeam: 'Roman Kopylov', pxEventId: 31386993, pxEventName: 'Ateba Gautier vs Roman Kopylov' }),
  });
}

test('priceParlay: all-MoV cross-fight parlay offers the product of the Bovada YES mirrors', async () => {
  pricerLines();
  const r = await pricer.priceParlay(['pk-ko', 'rk-ko']);
  assert.ok(r && r.offer, 'must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
  const mirror = A2P(300) * A2P(475);
  const offered = A2P(r.offer.odds);
  // American odds are integers; allow one unit of rounding, never in the bettor's favour by more.
  assert.equal(r.offer.odds, 2200, "0.25 x 0.17391 = 4.3478% = +2200 exactly"); assert.ok(Math.abs(offered - mirror) < 2e-5, `offered ${offered} vs mirror ${mirror} (odds ${r.offer.odds})`);
  const legs = r.meta.legs;
  assert.ok(close(legs.find(l => /Parkin/.test(l.team || l.player || l.playerName || '') || l.lineId === 'pk-ko').bookPriceOverride, 0.25, 1e-4));
  const fair = 0.2015709591533815 * 0.13394141320291456;
  assert.ok(Math.abs(r.meta.fairParlayProb - fair) < 6e-5, `fair ${r.meta.fairParlayProb} vs Shin product ${fair}`);
});

test('priceParlay: a below-floor MoV leg declines the parlay', async () => {
  pricerLines();
  LINES['jw-ko'] = Object.assign({}, LINES['pk-ko'], { playerName: 'Johnny Walker', teamName: 'Johnny Walker' });
  const r = await pricer.priceParlay(['jw-ko', 'rk-ko']);
  assert.equal(r, null);
  assert.equal(pricer.priceParlay._lastFailure.reason, 'mov_below_floor');
});

test('shouldDecline: MoV NO leg declines mov_no_side; same-fight still mov_sgp_blocked', () => {
  pricerLines();
  const d = pricer.shouldDecline([{ line_id: 'pk-ko-no' }, { line_id: 'rk-ko' }], null);
  assert.equal(d.declined, true); assert.equal(d.reason, 'mov_no_side');
  const s = pricer.shouldDecline([{ line_id: 'pk-ko' }, { line_id: 'jw-sub' }], null);
  assert.equal(s.declined, true); assert.equal(s.reason, 'mov_sgp_blocked');
});

// ---------------------------------------------------------------------------
// 7. MOV_SOURCE=dk restores the old behaviour
// ---------------------------------------------------------------------------
test('MOV_SOURCE=dk: no MoV registration gate, NO side not refused, DK fair x vig (no mirror)', async () => {
  pricerLines();
  process.env.MOV_SOURCE = 'dk';
  try {
    assert.equal(ufcMov.source(), 'dk');
    assert.equal(ufcMov.movRegistrationRefusal(LINES['pk-ko-no']), null);
    assert.equal(ufcMov.movRegistrationRefusal(Object.assign({}, LINES['pk-ko'], { playerName: 'Johnny Walker' })), null);
    const d = pricer.shouldDecline([{ line_id: 'pk-ko-no' }, { line_id: 'rk-ko' }], null);
    assert.ok(!d || d.reason !== 'mov_no_side');
    ufcMov.ingestBoard({ fights: [
      { slug: 'walker-parkin', fighters: [{ name: 'Johnny Walker', KO: 250, SUB: 1800, DEC: 219 }, { name: 'Mick Parkin', KO: 300, SUB: 800, DEC: 300 }] },
      { slug: 'gautier-kopylov', fighters: [{ name: 'Ateba Gautier', KO: 105, SUB: 2000, DEC: 300 }, { name: 'Roman Kopylov', KO: 475, SUB: 2800, DEC: 300 }] },
    ] });
    const r = await pricer.priceParlay(['pk-ko', 'rk-ko']);
    assert.ok(r && r.offer, 'dk path must price: ' + JSON.stringify(pricer.priceParlay._lastFailure));
    assert.ok(r.meta.legs.every(l => l.bookPriceOverride == null), 'dk path is fair x vig, not a mirror');
    const dkFair = ufcMov.getMovFairSync('Mick Parkin', 'mov_ko', 'Johnny Walker').fairProb
      * ufcMov.getMovFairSync('Roman Kopylov', 'mov_ko', 'Ateba Gautier').fairProb;
    assert.ok(Math.abs(r.meta.fairParlayProb - dkFair) < 6e-5, `dk fair ${r.meta.fairParlayProb} vs ${dkFair}`);
  } finally {
    delete process.env.MOV_SOURCE;
  }
  assert.equal(ufcMov.source(), 'bovada');
});
