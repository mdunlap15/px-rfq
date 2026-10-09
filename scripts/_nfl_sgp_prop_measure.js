// NFL same-game PROP correlation — measurement (2026-10-09).
// Reads the cache written by scripts/_nfl_sgp_prop_collect.js (ESPN box scores +
// The Odds API historical odds at kickoff-60min) and measures, per pair class,
//     M = sum_pairs I(A)*I(B) / sum_pairs pA*pB
// where pA, pB are the books' DE-VIGGED probabilities for each leg -- exactly
// the factor by which an independently priced same-game parlay is too cheap.
// Also reported: Mc = M / (calibration of A x calibration of B), the coupling
// with the marginal mis-calibration divided out. 95% CI = bootstrap over GAMES.
// Fair methods = what the trader uses: anytime TD = field normalisation
// (raw x T / book field sum, T=4.10, median over books); two-way markets =
// proportional de-vig per book, median over books, at the most-booked point.
//
//   node scripts/_nfl_sgp_prop_measure.js [--minp 0.15] [--boot 2000]
'use strict';
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.NFL_SGP_DATA_DIR || path.join(require('os').homedir(), 'nfl_sgp_data');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MINP = Number(arg('--minp', 0.0));
const BOOT = Number(arg('--boot', 2000));
const TFIELD = 4.10;

const imp = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const nick = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(' ').slice(-1)[0];

function parseBox(box) {
  // -> { players: Map(normName -> {name, team, td, rushYds, recYds, rec, passYds, passTd, isQB}) }
  const players = new Map();
  for (const t of (box.boxscore && box.boxscore.players) || []) {
    const team = t.team.displayName;
    const get = (n) => { let p = players.get(n); if (!p) { p = { name: n, team, td: 0, rushYds: 0, recYds: 0, rec: 0, passYds: 0, passTd: 0, isQB: false }; players.set(n, p); } return p; };
    for (const cat of t.statistics || []) {
      const L = cat.labels || [];
      for (const a of cat.athletes || []) {
        const n = normName(a.athlete && a.athlete.displayName);
        if (!n) continue;
        const v = (lab) => { const i = L.indexOf(lab); return i >= 0 ? Number(String(a.stats[i]).split('/')[0]) || 0 : 0; };
        const p = get(n);
        if (cat.name === 'rushing') { p.rushYds += v('YDS'); p.td += v('TD'); }
        if (cat.name === 'receiving') { p.recYds += v('YDS'); p.rec += v('REC'); p.td += v('TD'); }
        if (cat.name === 'passing') {
          const ca = String(a.stats[L.indexOf('C/ATT')] || '0/0').split('/'); const att = Number(ca[1]) || 0;
          p.passYds += v('YDS'); p.passTd += v('TD'); if (att >= 10) p.isQB = true;
        }
      }
    }
  }
  return players;
}

function fairs(odds, game) {
  const books = ((odds.data || {}).bookmakers) || [];
  const out = { td: new Map(), tdRaw: new Map(), side: {}, total: null, ou: { pass_yds: new Map(), rush_yds: new Map(), rec_yds: new Map(), receptions: new Map() } };
  // anytime TD: per book field normalisation
  const tdBy = new Map();
  for (const bk of books) {
    const m = (bk.markets || []).find(x => x.key === 'player_anytime_td'); if (!m) continue;
    const yes = m.outcomes.filter(o => /^yes$/i.test(o.name) && o.description && !/no touchdown/i.test(o.description));
    if (yes.length < 10) continue;
    const sum = yes.reduce((s, o) => s + imp(o.price), 0);
    if (!(sum > TFIELD && sum < 3 * TFIELD)) continue;
    for (const o of yes) { const n = normName(o.description); (tdBy.get(n) || tdBy.set(n, []).get(n)).push(Math.min(0.95, imp(o.price) * TFIELD / sum));
      (out.tdRaw.get(n) || out.tdRaw.set(n, []).get(n)).push(imp(o.price)); }
  }
  for (const [n, xs] of tdBy) out.td.set(n, median(xs));
  // two-way game markets at the most-booked point
  const twoWay = (key) => {
    const byPoint = new Map();
    for (const bk of books) {
      const m = (bk.markets || []).find(x => x.key === key); if (!m || m.outcomes.length !== 2) continue;
      const [a, b] = m.outcomes; const pa = imp(a.price), pb = imp(b.price);
      const k = key === 'totals' ? String(a.point) : String(Math.abs(a.point || 0));
      (byPoint.get(k) || byPoint.set(k, []).get(k)).push({ a, b, fa: pa / (pa + pb), fb: pb / (pa + pb) });
    }
    let best = null; for (const [k, v] of byPoint) if (!best || v.length > best[1].length) best = [k, v];
    return best ? best[1] : [];
  };
  const ml = twoWay('h2h');
  if (ml.length) {
    const fHome = median(ml.map(x => (nick(x.a.name) === nick(game.home) ? x.fa : x.fb)));
    out.side.mlHome = fHome;
  }
  const sp = twoWay('spreads');
  if (sp.length) {
    const r = sp.map(x => (nick(x.a.name) === nick(game.home) ? { pt: x.a.point, f: x.fa } : { pt: x.b.point, f: x.fb }));
    out.side.spHomePoint = median(r.map(x => x.pt)); out.side.spHome = median(r.map(x => x.f));
  }
  const tt = twoWay('totals');
  if (tt.length) {
    const r = tt.map(x => (/over/i.test(x.a.name) ? { pt: x.a.point, f: x.fa } : { pt: x.b.point, f: x.fb }));
    out.total = { point: median(r.map(x => x.pt)), over: median(r.map(x => x.f)) };
  }
  // player over/unders at each player's most-booked point
  const ouKeys = { player_pass_yds: 'pass_yds', player_rush_yds: 'rush_yds', player_reception_yds: 'rec_yds', player_receptions: 'receptions' };
  for (const [mk, short] of Object.entries(ouKeys)) {
    const per = new Map(); // player -> point -> [fairOver]
    for (const bk of books) {
      const m = (bk.markets || []).find(x => x.key === mk); if (!m) continue;
      const grp = new Map();
      for (const o of m.outcomes) { const k = normName(o.description) + '|' + o.point; (grp.get(k) || grp.set(k, {}).get(k))[/over/i.test(o.name) ? 'o' : 'u'] = o; }
      for (const [k, g] of grp) { if (!g.o || !g.u) continue; const [n, pt] = k.split('|'); const po = imp(g.o.price), pu = imp(g.u.price);
        const pm = per.get(n) || per.set(n, new Map()).get(n); (pm.get(pt) || pm.set(pt, []).get(pt)).push(po / (po + pu)); }
    }
    for (const [n, pm] of per) { let best = null; for (const [pt, xs] of pm) if (!best || xs.length > best[1].length) best = [pt, xs]; if (best && best[1].length >= 2) out.ou[short].set(n, { point: Number(best[0]), over: median(best[1]) }); }
  }
  return out;
}

// ---- load
const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));
const games = [];
let tdLegs = 0, tdMatched = 0, tdUnmatched = 0;
for (const g of index) {
  if (!g.toaId) continue;
  const bf = path.join(DATA_DIR, 'espn', `box_${g.espnId}.json`), of = path.join(DATA_DIR, 'toa', `odds_${g.toaId}.json`);
  if (!fs.existsSync(bf) || !fs.existsSync(of)) continue;
  const players = parseBox(JSON.parse(fs.readFileSync(bf, 'utf8')));
  const F = fairs(JSON.parse(fs.readFileSync(of, 'utf8')), g);
  const td = [];
  for (const [n, p] of F.td) {
    tdLegs++;
    // Snapshot is kickoff-60min, AFTER NFL inactives (T-90), so a priced player
    // played; no box-score line = no touches = no TD (counting it a miss, not
    // dropping it, avoids inflating both calibration and M). His team is
    // unknown then, so he joins team-free classes only (TD + total).
    const pl = players.get(n);
    if (!pl) tdUnmatched++; else tdMatched++;
    // q = what the RFQ book QUOTES for this leg: the books' raw YES (median)
    // x (1 - PROP_BOOK_MIRROR_SWEETENER 3%), never below fair.
    const q = Math.max(p, median(F.tdRaw.get(n) || []) * 0.97);
    if (p >= MINP) td.push({ n, p, q, hit: pl && pl.td > 0 ? 1 : 0, team: pl ? pl.team : null, isQB: !!(pl && pl.isQB) });
  }
  const homeWon = g.homeScore > g.awayScore ? 1 : (g.homeScore < g.awayScore ? 0 : null);
  const margin = g.homeScore - g.awayScore;
  const sides = [];
  if (F.side.mlHome != null && homeWon != null) {
    sides.push({ kind: 'ml', team: g.home, p: F.side.mlHome, hit: homeWon });
    sides.push({ kind: 'ml', team: g.away, p: 1 - F.side.mlHome, hit: 1 - homeWon });
  }
  if (F.side.spHome != null && F.side.spHomePoint != null) {
    const cov = margin + F.side.spHomePoint; // home covers if > 0
    if (cov !== 0) { sides.push({ kind: 'spread', team: g.home, p: F.side.spHome, hit: cov > 0 ? 1 : 0, pt: F.side.spHomePoint });
      sides.push({ kind: 'spread', team: g.away, p: 1 - F.side.spHome, hit: cov < 0 ? 1 : 0, pt: -F.side.spHomePoint }); }
  }
  let totals = [];
  if (F.total && F.total.point != null) {
    const pts = g.homeScore + g.awayScore;
    if (pts !== F.total.point) totals = [{ kind: 'over', p: F.total.over, hit: pts > F.total.point ? 1 : 0 }, { kind: 'under', p: 1 - F.total.over, hit: pts < F.total.point ? 1 : 0 }];
  }
  const ou = [];
  for (const [short, mp] of Object.entries(F.ou)) for (const [n, x] of mp) {
    const pl = players.get(n); if (!pl) continue;
    const val = { pass_yds: pl.passYds, rush_yds: pl.rushYds, rec_yds: pl.recYds, receptions: pl.rec }[short];
    if (val === x.point) continue;
    ou.push({ n, market: short, team: pl.team, isQB: pl.isQB, p: x.over, hit: val > x.point ? 1 : 0 });
  }
  games.push({ g, td, sides, totals, ou });
}

// ---- pair classes
const classes = {};
let _q = null;
const add = (cls, gi, hitJ, pJ, hA, pA, hB, pB) => {
  const c = classes[cls] || (classes[cls] = { rows: [] });
  c.rows.push([gi, hitJ, pJ, hA, pA, hB, pB, _q != null ? _q : pJ]);
};
games.forEach((G, gi) => {
  const { td, sides, totals, ou } = G;
  for (let i = 0; i < td.length; i++) for (let j = i + 1; j < td.length; j++) {
    const a = td[i], b = td[j];
    if (!a.team || !b.team) continue;
    const same = a.team === b.team;
    const qb = a.isQB || b.isQB;
    _q = a.q * b.q;
    add(`TD+TD ${same ? 'same team' : 'opposing'}${qb ? ' (incl QB)' : ''}`, gi, a.hit * b.hit, a.p * b.p, a.hit, a.p, b.hit, b.p);
    add(`TD+TD ${same ? 'same team' : 'opposing'} (all)`, gi, a.hit * b.hit, a.p * b.p, a.hit, a.p, b.hit, b.p);
  }
  for (let i = 0; i < td.length; i++) for (let j = i + 1; j < td.length; j++) for (let k = j + 1; k < td.length; k++) {
    const t = [td[i], td[j], td[k]]; if (t.some(x => !x.team)) continue; const teams = new Set(t.map(x => x.team));
    const cls = `TDx3 ${teams.size === 1 ? 'all same team' : '2+1 split'}`;
    _q = t[0].q * t[1].q * t[2].q;
    add(cls, gi, t[0].hit * t[1].hit * t[2].hit, t[0].p * t[1].p * t[2].p, 0, 0, 0, 0);
  }
  // TD x4 (any split) and TD + TD + a side (the 3-leg shapes bettors send)
  const tdk = td.filter(x => x.team);
  for (let i = 0; i < tdk.length; i++) for (let j = i + 1; j < tdk.length; j++) {
    for (let k = j + 1; k < tdk.length; k++) for (let l = k + 1; l < tdk.length; l++) {
      const t = [tdk[i], tdk[j], tdk[k], tdk[l]];
      _q = t.reduce((m, x) => m * x.q, 1);
      add('TDx4 (any split)', gi, t.every(x => x.hit) ? 1 : 0, t.reduce((m, x) => m * x.p, 1), 0, 0, 0, 0);
    }
    for (const sd of sides) {
      const a = tdk[i], b = tdk[j];
      const own = (a.team === sd.team ? 1 : 0) + (b.team === sd.team ? 1 : 0);
      _q = a.q * b.q * sd.p;
      add(`TD+TD + ${sd.kind} (${own === 2 ? 'both OWN' : own === 1 ? 'one own' : 'both OPP'})`, gi, a.hit * b.hit * sd.hit, a.p * b.p * sd.p, 0, 0, 0, 0);
    }
    for (const t of totals) { const a = tdk[i], b = tdk[j]; _q = a.q * b.q * t.p; add(`TD+TD + game ${t.kind}`, gi, a.hit * b.hit * t.hit, a.p * b.p * t.p, 0, 0, 0, 0); }
  }
  _q = null;
  for (const a of td) {
    if (a.team) for (const s of sides) (_q = a.q * s.p, add(`TD + ${s.kind} ${s.team === a.team ? 'OWN team' : 'OPP team'}`, gi, a.hit * s.hit, a.p * s.p, a.hit, a.p, s.hit, s.p));
    for (const t of totals) { _q = a.q * t.p; add(`TD + game ${t.kind}`, gi, a.hit * t.hit, a.p * t.p, a.hit, a.p, t.hit, t.p); }
    _q = null;
  }
  _q = null;
  // yardage: QB pass yds over + same-team receiver rec yds over (the stack)
  for (const a of ou) for (const b of ou) {
    if (a === b || a.n === b.n) continue;
    if (a.market === 'pass_yds' && b.market === 'rec_yds') add(`QB pass yds O + ${a.team === b.team ? 'SAME' : 'OPP'}-team rec yds O`, gi, a.hit * b.hit, a.p * b.p, a.hit, a.p, b.hit, b.p);
    if (a.market === 'rec_yds' && b.market === 'rec_yds' && a.n < b.n) add(`rec yds O + rec yds O ${a.team === b.team ? 'same team' : 'opposing'}`, gi, a.hit * b.hit, a.p * b.p, a.hit, a.p, b.hit, b.p);
    if (a.market === 'rush_yds' && b.market === 'rec_yds') add(`rush yds O + ${a.team === b.team ? 'SAME' : 'OPP'}-team rec yds O`, gi, a.hit * b.hit, a.p * b.p, a.hit, a.p, b.hit, b.p);
  }
  for (const a of ou) {
    for (const s of sides) if (s.kind === 'spread') add(`${a.market} O + spread ${s.team === a.team ? 'OWN' : 'OPP'}`, gi, a.hit * s.hit, a.p * s.p, a.hit, a.p, s.hit, s.p);
    for (const t of totals) add(`${a.market} O + game ${t.kind}`, gi, a.hit * t.hit, a.p * t.p, a.hit, a.p, t.hit, t.p);
  }
});

function stat(rows) {
  let J = 0, P = 0, HA = 0, PA = 0, HB = 0, PB = 0, Q = 0;
  for (const r of rows) { J += r[1]; P += r[2]; HA += r[3]; PA += r[4]; HB += r[5]; PB += r[6]; Q += r[7]; }
  const M = J / P;
  const cal = PA > 0 && PB > 0 ? (HA / PA) * (HB / PB) : null;
  return { M, Mc: cal ? M / cal : null, Mq: J / Q, n: rows.length, J, P };
}
function boot(rows) {
  const byG = new Map(); for (const r of rows) (byG.get(r[0]) || byG.set(r[0], []).get(r[0])).push(r);
  const gs = [...byG.values()]; const Ms = [];
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const Qs = [];
  for (let b = 0; b < BOOT; b++) { let J = 0, P = 0, Q = 0; for (let i = 0; i < gs.length; i++) { const g = gs[Math.floor(rnd() * gs.length)]; for (const r of g) { J += r[1]; P += r[2]; Q += r[7]; } } Ms.push(J / P); Qs.push(J / Q); }
  Ms.sort((a, b) => a - b); Qs.sort((a, b) => a - b);
  return [Ms[Math.floor(0.025 * BOOT)], Ms[Math.floor(0.975 * BOOT)], gs.length, Qs[Math.floor(0.975 * BOOT)]];
}
console.log(`games ${games.length}; TD legs priced ${tdLegs}, matched to a box score ${tdMatched}, no stat line (inactive/void) ${tdUnmatched}; minp ${MINP}`);
const tdAll = games.flatMap(G => G.td); const cal = tdAll.reduce((s, x) => s + x.hit, 0) / tdAll.reduce((s, x) => s + x.p, 0);
console.log(`anytime-TD marginal calibration (hits / sum fair): ${cal.toFixed(3)} over ${tdAll.length} legs`);
console.log('class'.padEnd(46), 'M'.padStart(6), '95% CI'.padStart(16), 'Mc'.padStart(6), 'Mq'.padStart(6), 'Mq97'.padStart(6), 'pairs'.padStart(7), 'games'.padStart(6), 'joint hits'.padStart(10));
for (const [k, c] of Object.entries(classes).sort()) {
  const s = stat(c.rows); const [lo, hi, ng, qhi] = boot(c.rows);
  console.log(k.padEnd(46), s.M.toFixed(3).padStart(6), `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`.padStart(16), (s.Mc != null && s.Mc > 0 ? s.Mc.toFixed(3) : '-').padStart(6), s.Mq.toFixed(3).padStart(6), qhi.toFixed(3).padStart(6), String(s.n).padStart(7), String(ng).padStart(6), String(s.J).padStart(10));
}
