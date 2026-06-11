/**
 * DECOUPLED World Cup player-prop scraper worker.
 *
 * Runs OFF the trading box (local cron, or a separate Railway worker) so the
 * fragile headless-Chromium scrape never shares a process with the live RFQ /
 * fill handler. It:
 *   1. Lists PX's upcoming World Cup matches (tournament 53 by default).
 *   2. Loads DK's soccer hub, harvests event slugs, and matches each PX match
 *      to its DK slug by normalized team names.
 *   3. Runs the existing per-event scraper (scripts/dk-wc-props.js) for each.
 *   4. Upserts {px_event_id, player_key, market, american, ...} rows into the
 *      Supabase `wc_player_props` table that the live service reads.
 *
 * The live service (services/wc-player-props.js, Stage 2) only READS that
 * table — it never launches a browser.
 *
 * Usage:
 *   node scripts/dk-wc-props-worker.js            # scrape + upsert
 *   node scripts/dk-wc-props-worker.js --dry      # scrape + print, NO write
 *   WC_TOURNAMENT_IDS=53,36 node scripts/dk-wc-props-worker.js
 *
 * Run schema first: scripts/wc_player_props_schema.sql (Supabase SQL editor).
 */
require('dotenv').config();
const px = require('../services/prophetx');
const db = require('../services/db');
const { scrapeEvent } = require('./dk-wc-props');

const DRY = process.argv.includes('--dry');
const TOURNAMENT_IDS = (process.env.WC_TOURNAMENT_IDS || '53')
  .split(',').map(s => Number(s.trim())).filter(Boolean);
const DK_SOCCER_HUB = 'https://sportsbook.draftkings.com/leagues/soccer';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// ---- name normalization + national-team aliases ---------------------------
// PX uses full names ("United States"); DK slugs use abbreviations ("usa").
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const TEAM_ALIAS = {
  'usa': 'united states', 'us': 'united states',
  'united states of america': 'united states',
  'korea republic': 'south korea', 'south korea republic': 'south korea',
  'china pr': 'china', 'czechia': 'czech republic',
  'ivory coast': 'cote divoire', "cote d ivoire": 'cote divoire',
  'bosnia and herzegovina': 'bosnia', 'bosnia herzegovina': 'bosnia',
};
function canon(s) { const n = norm(s); return TEAM_ALIAS[n] || n; }
// two team names "match" if their canonical forms are equal or one contains
// the other (handles "united states" vs "usa"->"united states", etc.)
function teamMatch(a, b) {
  const x = canon(a), y = canon(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// ---- PX side --------------------------------------------------------------
function pxTeams(ev) {
  // Prefer an explicit competitors array; fall back to parsing "Away at Home".
  const comp = ev.competitors || ev.teams || [];
  if (Array.isArray(comp) && comp.length >= 2) {
    return comp.map(c => c.name || c.display_name || c).filter(Boolean).slice(0, 2);
  }
  const name = ev.name || ev.display_name || '';
  const m = name.split(/\s+(?:at|vs\.?|@)\s+/i);
  return m.length >= 2 ? [m[0].trim(), m[1].trim()] : [];
}
async function fetchPxWcEvents() {
  const out = [];
  for (const tid of TOURNAMENT_IDS) {
    let evs = [];
    try { evs = await px.fetchAffiliateSportEvents({ tournamentId: tid }); }
    catch (e) { console.warn(`PX tournament ${tid}: ${e.message}`); continue; }
    const arr = Array.isArray(evs) ? evs : (evs && (evs.data || evs.sport_events || evs.events)) || [];
    for (const ev of arr) {
      const id = ev.event_id || ev.id;
      const teams = pxTeams(ev);
      if (!id || teams.length < 2) continue;
      out.push({
        pxEventId: Number(id),
        teams,
        label: ev.name || ev.display_name || teams.join(' vs '),
        commence: ev.scheduled || ev.start_time || ev.commence_time || ev.start || null,
      });
    }
  }
  return out;
}

// ---- DK side: discover event slugs from the soccer hub ---------------------
async function fetchDkSoccerSlugs() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(DK_SOCCER_HUB, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3500));
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/event/"]')).map(a => a.getAttribute('href')));
    // "/event/mexico-vs-south-africa/33260384?sgpmode=true" -> "mexico-vs-south-africa/33260384"
    const slugs = [...new Set(hrefs
      .map(h => (h || '').replace(/^.*\/event\//, '').replace(/\?.*$/, ''))
      .filter(s => /\/\d+$/.test(s)))];
    return slugs.map(s => {
      const parts = s.split('/')[0].split('-vs-');
      return { slugId: s, dkEventId: s.split('/').pop(), teams: parts.map(p => p.replace(/-/g, ' ')) };
    });
  } finally {
    await browser.close();
  }
}

// match a PX event to a DK slug: both teams must match
function matchDk(pxEv, dkSlugs) {
  return dkSlugs.find(d =>
    d.teams.length >= 2 &&
    pxEv.teams.every(pt => d.teams.some(dt => teamMatch(pt, dt))));
}

// ---- scrape -> rows -------------------------------------------------------
function rowsFromScrape(pxEv, scraped) {
  const rows = [];
  const push = (player, market, american) => {
    if (american == null || american === '') return;
    const a = parseInt(String(american).replace(/[^0-9+-]/g, ''), 10);
    if (!Number.isFinite(a)) return;
    const key = norm(player);
    if (!key) return;
    rows.push({
      px_event_id: pxEv.pxEventId,
      player_key: key,
      market,
      american: a,
      player_name: player,
      dk_event_id: String(scraped.eventId),
      match_label: pxEv.label,
      commence_time: pxEv.commence,
      // MUST be set explicitly: on upsert-update the column default does not
      // re-apply, so without this a re-scraped row would keep its original
      // insert timestamp and read as permanently stale to the freshness guard.
      scraped_at: new Date().toISOString(),
    });
  };
  for (const g of scraped.goalscorer || []) push(g.player, 'goalscorer', g.odds);
  for (const s of scraped.sot || []) { push(s.player, 'sot_1', s.one); push(s.player, 'sot_2', s.two); }
  for (const a of scraped.assists || []) push(a.player, 'assists', a.odds);
  return rows;
}

async function upsert(rows) {
  const client = db.getClient();
  if (!client) throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
  // chunk to keep payloads sane
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await client.from('wc_player_props')
      .upsert(chunk, { onConflict: 'px_event_id,player_key,market' });
    if (error) throw new Error(`upsert: ${error.message}`);
  }
}

async function main() {
  console.log(`[wc-worker] tournaments=${TOURNAMENT_IDS.join(',')} dry=${DRY}`);
  await px.login();
  const pxEvents = await fetchPxWcEvents();
  console.log(`[wc-worker] PX upcoming matches: ${pxEvents.length}`);
  if (!pxEvents.length) { console.log('[wc-worker] nothing to do'); return; }

  const dkSlugs = await fetchDkSoccerSlugs();
  console.log(`[wc-worker] DK soccer-hub events: ${dkSlugs.length}`);

  const allRows = [];
  let matched = 0, unmatched = 0;
  for (const pxEv of pxEvents) {
    const dk = matchDk(pxEv, dkSlugs);
    if (!dk) { unmatched++; console.log(`  UNMATCHED: ${pxEv.label} [${pxEv.teams.join(' / ')}]`); continue; }
    matched++;
    let scraped;
    try { scraped = await scrapeEvent(dk.slugId); }
    catch (e) { console.warn(`  scrape failed ${dk.slugId}: ${e.message}`); continue; }
    const rows = rowsFromScrape(pxEv, scraped);
    allRows.push(...rows);
    console.log(`  ${pxEv.label}  ->  DK ${dk.slugId}  | gs:${(scraped.goalscorer || []).length} sot:${(scraped.sot || []).length} ast:${(scraped.assists || []).length} -> ${rows.length} rows`);
  }
  console.log(`[wc-worker] matched ${matched}/${pxEvents.length} (unmatched ${unmatched}); ${allRows.length} prop rows`);

  if (DRY) {
    console.log('[wc-worker] --dry: not writing. Sample rows:');
    allRows.slice(0, 8).forEach(r => console.log('   ', JSON.stringify(r)));
    return;
  }
  if (!allRows.length) { console.log('[wc-worker] no rows to write'); return; }
  await upsert(allRows);
  console.log(`[wc-worker] upserted ${allRows.length} rows into wc_player_props`);
}

if (require.main === module) {
  // --loop [minutes]: run forever, re-scraping every N minutes (default 10).
  // The live service's prop_stale gate declines any prop whose scrape is
  // older than 15 min, so 10-min loops keep quotes continuously alive;
  // stopping the loop fail-safes quoting off within 15 min.
  const loopIdx = process.argv.indexOf('--loop');
  if (loopIdx !== -1) {
    const mins = Number(process.argv[loopIdx + 1]) || 10;
    console.log(`[wc-worker] loop mode: every ${mins} min (Ctrl+C to stop; quoting auto-stops ≤15 min after)`);
    const runOnce = () => main().catch(e => console.error('[wc-worker] run failed (will retry next loop):', e.message));
    runOnce();
    setInterval(runOnce, mins * 60 * 1000);
  } else {
    main().then(() => process.exit(0)).catch(e => { console.error('[wc-worker] FATAL', e.message); process.exit(1); });
  }
}
module.exports = { main, norm, canon, teamMatch, matchDk, rowsFromScrape };
