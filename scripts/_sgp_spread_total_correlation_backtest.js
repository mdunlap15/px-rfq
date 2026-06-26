// Closing-line SGP spread+total correlation backtest for MLB.
//
// WHY: the directional SGP correlation factors (spread_fav_over, spread_fav_under,
// spread_dog_over, spread_dog_under) drive how much we mark up / discount
// same-game spread+total parlays. The pricing-competitiveness workflow estimated
// these from a PROXY (median total line = 9, runline 1.5, fav-cover ignoring
// which team was favored), so only the DIRECTION was trustworthy, not the
// magnitudes. This script measures them off REAL lines: the actual total line
// and the actual favorite come from our own parlay leg data, joined with final
// scores from the free MLB Stats API (statsapi.mlb.com). Use it to decide
// whether to restore the directional factors (and at what magnitude) before
// loosening the fav+under / dog+over quadrants that the 4fc8c778 sharp targeted.
//
// Factor = realized joint rate / (product of realized marginal rates).
//   factor > 1  positively correlated  -> SHORTEN the parlay (charge more)
//   factor < 1  negatively correlated  -> LENGTHEN the parlay (more competitive)
//
// Quadrants (from the bettor's side of the spread leg):
//   fav = bettor took the favorite (spread line < 0); covers = fav won by >= 2
//   dog = bettor took the underdog (spread line > 0); covers = fav did NOT win by >= 2
//   over / under = total runs vs the real total line
//
// Run:  node scripts/_sgp_spread_total_correlation_backtest.js [days]
//       (default 30; reads SUPABASE_URL / SUPABASE_SERVICE_KEY from .env)
//
// Caches linescores to _mlb_linescore_cache.json so re-runs are cheap.

require('dotenv').config();
const fs = require('fs');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const DAYS = parseInt(process.argv[2], 10) || 30;
const CACHE_PATH = __dirname + '/_mlb_linescore_cache.json';

let scheduleCache = {};
try { scheduleCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { scheduleCache = {}; }

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}
// Last-2-words match handles "Milwaukee Brewers" vs "Brewers" etc.
function teamMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const la = na.split(' ').slice(-1)[0], lb = nb.split(' ').slice(-1)[0];
  return la && la === lb;
}

async function pageAll(buildQuery) {
  let from = 0, page = 1000, all = [];
  while (true) {
    const { data, error } = await buildQuery().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < page || all.length >= 60000) break;
    from += page;
  }
  return all;
}

// Fetch final linescores for a date (YYYY-MM-DD) from MLB Stats API. Cached.
async function fetchFinalsForDate(date) {
  if (scheduleCache[date]) return scheduleCache[date];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
  let games = [];
  try {
    const res = await fetch(url, { timeout: 15000 });
    const json = await res.json();
    for (const d of (json.dates || [])) {
      for (const g of (d.games || [])) {
        const ls = g.linescore;
        const status = (g.status && g.status.abstractGameState) || '';
        if (status !== 'Final') continue;
        const home = g.teams && g.teams.home, away = g.teams && g.teams.away;
        const homeRuns = ls && ls.teams && ls.teams.home && ls.teams.home.runs;
        const awayRuns = ls && ls.teams && ls.teams.away && ls.teams.away.runs;
        if (homeRuns == null || awayRuns == null) continue;
        games.push({
          gamePk: g.gamePk,
          homeName: home && home.team && home.team.name,
          awayName: away && away.team && away.team.name,
          homeRuns, awayRuns,
        });
      }
    }
  } catch (e) {
    games = []; // leave uncached on failure so a later run retries
    return games;
  }
  scheduleCache[date] = games;
  return games;
}

// Build per-game line facts from our own MLB parlay legs: the real total line
// and which side was the favorite (from a spread leg with a non-zero line).
function extractGameLines(rows) {
  // key: pxEventId (preferred) or homeTeam|awayTeam|date
  const byGame = {};
  for (const r of rows) {
    const legs = (r.meta && r.meta.legs) || r.legs || [];
    for (const l of legs) {
      if (String(l.sport || '') !== 'baseball_mlb') continue;
      const mt = l.market || l.marketType;
      const start = l.startTime || r.quoted_at;
      const date = start ? new Date(start).toISOString().slice(0, 10) : null;
      if (!date) continue;
      const key = l.pxEventId ? `pk:${l.pxEventId}` : `${norm(l.homeTeam)}|${norm(l.awayTeam)}|${date}`;
      if (!byGame[key]) {
        byGame[key] = { date, homeTeam: l.homeTeam, awayTeam: l.awayTeam, totalLine: null, favTeam: null };
      }
      const g = byGame[key];
      if (!g.homeTeam && l.homeTeam) g.homeTeam = l.homeTeam;
      if (!g.awayTeam && l.awayTeam) g.awayTeam = l.awayTeam;
      if (mt === 'total' && g.totalLine == null && Number.isFinite(Number(l.line))) {
        g.totalLine = Number(l.line);
      }
      if (mt === 'spread' && g.favTeam == null) {
        const line = Number(l.line);
        if (Number.isFinite(line) && line !== 0) {
          // bettor's team is the favorite iff the spread line is negative
          g.favTeam = line < 0 ? (l.team || l.teamName) : _otherTeam(l, l.team || l.teamName);
        }
      }
    }
  }
  return byGame;
}
function _otherTeam(leg, team) {
  if (teamMatch(team, leg.homeTeam)) return leg.awayTeam;
  if (teamMatch(team, leg.awayTeam)) return leg.homeTeam;
  return null;
}

(async () => {
  const sinceIso = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(`Pulling MLB spread/total legs since ${sinceIso.slice(0, 10)} (last ${DAYS}d)…`);

  // Source 1: our own quotes. Source 2: the whole-network matched_parlays
  // (more diverse — includes games we never quoted, so the line sample isn't
  // skewed to the bot's handful of repeated games). Both carry leg-level
  // line/market/team, which is all we need for the real total + favorite.
  const ourRows = await pageAll(() => sb.from('parlay_orders')
    .select('quoted_at, legs, meta')
    .gt('quoted_at', sinceIso)
    .order('quoted_at', { ascending: false }));
  const netRows = await pageAll(() => sb.from('matched_parlays')
    .select('matched_at, legs')
    .gt('matched_at', sinceIso)
    .order('matched_at', { ascending: false }));
  console.log(`  ${ourRows.length} parlay_orders rows + ${netRows.length} matched_parlays rows`);

  // matched_parlays rows expose .legs at top level and use matched_at; shim
  // them to the shape extractGameLines expects (quoted_at + meta.legs).
  const netShim = netRows.map(r => ({ quoted_at: r.matched_at, legs: r.legs, meta: null }));
  const byGame = extractGameLines([...ourRows, ...netShim]);
  const games = Object.values(byGame).filter(g => g.totalLine != null && g.favTeam && g.homeTeam && g.awayTeam);
  console.log(`  ${games.length} distinct games with BOTH a real total line and a favorite`);

  // Settle each game against final scores. A night game's startTime in UTC can
  // roll to the NEXT calendar day, but the MLB schedule indexes it under the
  // local (ET) date — so always search both the derived date and the day
  // before to avoid a one-day miss.
  const prevOf = (d) => new Date(new Date(d + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const dates = [...new Set(games.flatMap(g => [g.date, prevOf(g.date)]))].sort();
  const finalsByDate = {};
  for (const d of dates) finalsByDate[d] = await fetchFinalsForDate(d);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(scheduleCache));

  let settled = 0, unmatched = 0;
  const obs = []; // { favCovered, wentOver }
  for (const g of games) {
    const finals = [...(finalsByDate[g.date] || []), ...(finalsByDate[prevOf(g.date)] || [])];
    const fg = finals.find(f =>
      (teamMatch(f.homeName, g.homeTeam) && teamMatch(f.awayName, g.awayTeam)) ||
      (teamMatch(f.homeName, g.awayTeam) && teamMatch(f.awayName, g.homeTeam)));
    if (!fg) { unmatched++; continue; }
    const totalRuns = fg.homeRuns + fg.awayRuns;
    const wentOver = totalRuns > g.totalLine; // pushes (==) excluded below
    if (totalRuns === g.totalLine) continue;   // total push — drop
    // favorite margin: did the favorite win by >= 2 (covers -1.5)?
    let favRuns, oppRuns;
    if (teamMatch(g.favTeam, fg.homeName)) { favRuns = fg.homeRuns; oppRuns = fg.awayRuns; }
    else if (teamMatch(g.favTeam, fg.awayName)) { favRuns = fg.awayRuns; oppRuns = fg.homeRuns; }
    else { unmatched++; continue; }
    const favCovered = (favRuns - oppRuns) >= 2;
    obs.push({ favCovered, wentOver });
    settled++;
  }

  console.log(`  settled ${settled}, unmatched ${unmatched}\n`);
  if (settled < 20) {
    console.log('Too few settled games for stable factors — widen the window (e.g. node scripts/_sgp_spread_total_correlation_backtest.js 60).');
    return;
  }

  const n = obs.length;
  const pOver = obs.filter(o => o.wentOver).length / n;
  const pUnder = 1 - pOver;
  const pFav = obs.filter(o => o.favCovered).length / n;
  const pDog = 1 - pFav;
  const joint = (favC, over) => obs.filter(o => o.favCovered === favC && o.wentOver === over).length / n;

  const cell = (favC, over, pMarg) => {
    const j = joint(favC, over);
    const indep = (favC ? pFav : pDog) * (over ? pOver : pUnder);
    const factor = indep > 0 ? j / indep : 0;
    return { j, indep, factor };
  };
  const quad = {
    fav_over: cell(true, true),
    fav_under: cell(true, false),
    dog_over: cell(false, true),
    dog_under: cell(false, false),
  };

  console.log(`Marginals: P(over)=${(pOver * 100).toFixed(1)}%  P(fav covers -1.5)=${(pFav * 100).toFixed(1)}%  (n=${n})\n`);
  console.log('quadrant   | realized | indep   | FACTOR | direction');
  for (const [k, c] of Object.entries(quad)) {
    const dir = c.factor > 1.04 ? 'positive (shorten)' : c.factor < 0.96 ? 'negative (lengthen)' : 'independent';
    console.log(
      k.padEnd(10), '|',
      (c.j * 100).toFixed(1).padStart(6) + '%', '|',
      (c.indep * 100).toFixed(1).padStart(5) + '%', '|',
      c.factor.toFixed(3).padStart(5), '|', dir);
  }
  console.log('\nCompare to current production env (fav_over 1.23, others 1.05) and code defaults');
  console.log('(fav_over 1.30, dog_under 1.02, fav_under 0.95, dog_over 0.95). Restore DIRECTION;');
  console.log('only trust these MAGNITUDES if n per quadrant is healthy (>~40).');

  // Per-quadrant n for confidence
  const qn = {
    fav_over: obs.filter(o => o.favCovered && o.wentOver).length,
    fav_under: obs.filter(o => o.favCovered && !o.wentOver).length,
    dog_over: obs.filter(o => !o.favCovered && o.wentOver).length,
    dog_under: obs.filter(o => !o.favCovered && !o.wentOver).length,
  };
  console.log('\nquadrant n:', JSON.stringify(qn));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
