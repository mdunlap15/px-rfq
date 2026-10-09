// NFL same-game PROP correlation — data collector (2026-10-09).
// Operator: "Let's work on which NFL same-game props we can safely allow."
// Demand (declined football_sgp_blocked RFQs joined to network fills): anytime-TD
// combos dominate (TD+TD $39.6K, TDx3 $28.9K, TD+spread $10.6K, ...).
//
// For each NFL game 2023 -> now:
//   * ESPN scoreboard + box score (free): teams, final score, every player's
//     rushing/receiving/passing stats with TEAM attribution.
//   * The Odds API HISTORICAL event odds at kickoff-60min (our key has
//     historical access; 10 credits per market per region): anytime TD, h2h,
//     spreads, totals and the main yardage props, all US books.
// Resumable: every response is cached under DATA_DIR, so a re-run costs only
// what is missing. Read-only — no px-rfq services, no Supabase.
//
//   node scripts/_nfl_sgp_prop_collect.js [--seasons 2023,2024,2025] [--max-games N]
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.NFL_SGP_DATA_DIR || path.join(require('os').homedir(), 'nfl_sgp_data');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const KEY = ((env.match(/^THE_ODDS_API_KEY=(.*)$/m) || [])[1] || '').trim().replace(/^['"]|['"]$/g, '');
const MARKETS = ['player_anytime_td', 'h2h', 'spreads', 'totals', 'player_pass_yds',
  'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_pass_tds'];
const SPACING_MS = Number(process.env.NFL_SGP_SPACING_MS || 1500);

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SEASONS = String(arg('--seasons', '2023,2024,2025')).split(',').map(Number);
const MAX_GAMES = Number(arg('--max-games', 1e9));

fs.mkdirSync(path.join(DATA_DIR, 'espn'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'toa'), { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastToa = 0, credits = 0, toaCalls = 0;

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) return { __status: r.status, __body: (await r.text()).slice(0, 200) };
      const j = await r.json();
      if (url.includes('the-odds-api')) { credits += Number(r.headers.get('x-requests-last') || 0); toaCalls++; j.__remaining = r.headers.get('x-requests-remaining'); }
      return j;
    } catch (e) { await sleep(2000 * (i + 1)); }
  }
  return { __status: 'error' };
}
async function toa(url) {
  const wait = lastToa + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastToa = Date.now();
  return getJson(url);
}
function cached(file, fn) {
  if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return fn().then(j => { if (j && !j.__status) fs.writeFileSync(file, JSON.stringify(j)); return j; });
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const nick = (s) => norm(s).split(' ').slice(-1)[0];

async function espnGames(season) {
  const out = [];
  for (const [type, weeks] of [[2, 18], [3, 5]]) {
    for (let w = 1; w <= weeks; w++) {
      const f = path.join(DATA_DIR, 'espn', `sb_${season}_${type}_${w}.json`);
      const sb = await cached(f, () => getJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=${type}&week=${w}&dates=${season}`));
      for (const e of (sb.events || [])) {
        const c = e.competitions && e.competitions[0];
        if (!c || !(c.status && c.status.type && c.status.type.completed)) continue;
        const home = c.competitors.find(x => x.homeAway === 'home'), away = c.competitors.find(x => x.homeAway === 'away');
        out.push({ espnId: e.id, season, week: w, type, date: e.date, home: home.team.displayName, away: away.team.displayName,
          homeScore: Number(home.score), awayScore: Number(away.score) });
      }
    }
  }
  return out;
}

(async () => {
  if (!KEY) throw new Error('THE_ODDS_API_KEY missing');
  const games = [];
  for (const s of SEASONS) games.push(...await espnGames(s));
  // historical player props start 2023-05; keep regular + post season only
  const list = games.filter(g => Date.parse(g.date) > Date.parse('2023-08-01')).slice(0, MAX_GAMES);
  console.log(`games ${list.length} (${SEASONS.join(',')})`);
  const index = [];
  const evListCache = {};
  for (const [i, g] of list.entries()) {
    // ESPN box score
    await cached(path.join(DATA_DIR, 'espn', `box_${g.espnId}.json`),
      () => getJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${g.espnId}`));
    // TOA event id at kickoff-65min
    const kick = Date.parse(g.date);
    const snapList = new Date(kick - 65 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    let toaEv = null;
    const evFile = path.join(DATA_DIR, 'toa', `events_${snapList.replace(/:/g, '')}.json`);
    const evs = evListCache[evFile] || (evListCache[evFile] = await cached(evFile,
      () => toa(`https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/events?apiKey=${KEY}&date=${snapList}`)));
    toaEv = (evs.data || []).find(e => nick(e.home_team) === nick(g.home) && nick(e.away_team) === nick(g.away)
      && Math.abs(Date.parse(e.commence_time) - kick) < 6 * 3600e3);
    if (!toaEv) { index.push(Object.assign({}, g, { toaId: null, note: 'no toa event' })); continue; }
    const snap = new Date(kick - 60 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const oddsFile = path.join(DATA_DIR, 'toa', `odds_${toaEv.id}.json`);
    const odds = await cached(oddsFile, () => toa(`https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/events/${toaEv.id}/odds?apiKey=${KEY}&date=${snap}&regions=us&oddsFormat=american&markets=${MARKETS.join(',')}`));
    index.push(Object.assign({}, g, { toaId: toaEv.id, snapshot: odds && odds.timestamp, books: ((odds.data || {}).bookmakers || []).length }));
    if (i % 25 === 0) console.log(`${i}/${list.length} ${g.season} wk${g.week} ${g.away}@${g.home} books=${index[index.length - 1].books} credits=${credits} calls=${toaCalls} remaining=${odds.__remaining || '?'}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 1));
  const ok = index.filter(x => x.books > 0).length;
  console.log(`done: ${index.length} games, ${ok} with book odds; TOA calls ${toaCalls}, credits ${credits}; data in ${DATA_DIR}`);
})().catch(e => { console.error(e); process.exit(1); });
