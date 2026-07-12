/**
 * DraftKings soccer player-prop scraper — league-parametrized.
 *
 * Generalizes the World Cup scraper (dk-wc-props.js) to ANY DK soccer league:
 * discover the league page's event links, then scrape each event with the
 * (league-agnostic) scrapeEvent() — DK renumbers subcategory ids per load and
 * uses the same market-type names across soccer leagues, so the per-event
 * parser is reused verbatim. Built for MLS (`usa---mls`) where TOA has no
 * usable multi-book prop source; works for any league DK posts props on.
 *
 * Usage:
 *   node scripts/dk-soccer-props.js <leagueSlug> [outFile]
 *   e.g. node scripts/dk-soccer-props.js usa---mls dk_mls.json
 *        node scripts/dk-soccer-props.js world-cup-2026        (WC — verifies the path)
 *
 * Returns { league, scrapedAt, events: [ { eventId, slug, home, away, goalscorer,
 *   goals2plus, sot, assists, coverage } ] }.  Player rows carry a DK `seo`
 *   identifier (accented real name) for downstream matching to PX names.
 */
const fs = require('fs');
const puppeteer = require('puppeteer');
const { scrapeEvent } = require('./dk-wc-props.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const LAUNCH = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'] };

// Discover event slugs (`<slug>/<eventId>`) on a DK soccer league page.
async function discoverEvents(leagueSlug) {
  const browser = await puppeteer.launch(LAUNCH);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto('https://sportsbook.draftkings.com/leagues/soccer/' + leagueSlug, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 5000));
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/event/"]'))
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && !h.includes('sgpmode'))
        .map((h) => h.replace(/^\/event\//, '').split('?')[0])
        .filter((h, i, arr) => arr.indexOf(h) === i));
  } finally {
    await browser.close();
  }
}

// Scrape all events for a league. maxEvents bounds a huge slate; concurrency 1
// (each scrapeEvent launches its own browser — DK is heavy, keep it serial).
async function scrapeLeague(leagueSlug, opts = {}) {
  const maxEvents = opts.maxEvents || 30;
  const slugIds = (await discoverEvents(leagueSlug)).slice(0, maxEvents);
  const events = [];
  for (const slugId of slugIds) {
    try {
      const r = await scrapeEvent(slugId);
      const [aw, hm] = (slugId.split('/')[0] || '').split('-vs-');
      events.push({ eventId: r.eventId, slug: slugId, away: aw || null, home: hm || null,
        goalscorer: r.goalscorer, goals2plus: r.goals2plus, sot: r.sot, assists: r.assists,
        coverage: r.coverage, etConsistent: r.etConsistent });
    } catch (err) {
      events.push({ slug: slugId, error: err.message });
    }
  }
  return { league: leagueSlug, scrapedAt: new Date().toISOString(), events };
}

if (require.main === module) {
  const league = process.argv[2];
  const out = process.argv[3];
  if (!league) { console.error('usage: node dk-soccer-props.js <leagueSlug> [outFile]'); process.exit(1); }
  scrapeLeague(league).then((r) => {
    console.log(`league ${r.league}: ${r.events.length} events`);
    for (const e of r.events) console.log(`  ${e.slug}: gs=${(e.goalscorer||[]).length} 2+=${(e.goals2plus||[]).length} sot=${(e.sot||[]).length} ast=${(e.assists||[]).length}${e.error ? ' ERR ' + e.error : ''}`);
    if (out) { fs.writeFileSync(out, JSON.stringify(r, null, 1)); console.log('wrote', out); }
  }).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
module.exports = { discoverEvents, scrapeLeague };
