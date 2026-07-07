/**
 * DraftKings golf outrights scraper — Winner / Top 5 / Top 10 (Including Ties).
 *
 * Golf tournaments are LEAGUES on DK (e.g. /leagues/golf/rbc-canadian-open),
 * not events. The league page's default load fires ONE leagueSubcategory
 * markets XHR that already contains all three outright boards — no tab
 * clicking required (unlike the WC props scraper, dk-wc-props.js).
 * Same Akamai/CORS situation: passive Puppeteer interception only.
 *
 * Usage: node scripts/dk-golf-outrights.js <league-slug> [outFile]
 *   e.g. node scripts/dk-golf-outrights.js rbc-canadian-open out.json
 * Output: { winner:[{player,odds}], top5:[{player,odds}], top10:[{player,odds}] }
 * Odds American strings, ASCII-normalized (DK serves U+2212 minus).
 */
const fs = require('fs');
const puppeteer = require('puppeteer');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const norm = (s) => (s == null ? s : String(s).replace(/−/g, '-'));
const KEYMAP = [
  { key: 'winner', re: /^Outright Winner$/i },
  { key: 'top5', re: /^Top 5 \(Including Ties\)$/i },
  { key: 'top10', re: /^Top 10 \(Including Ties\)$/i },
  { key: 'top20', re: /^Top 20 \(Including Ties\)$/i },
];
// Top 20 lives behind its own button (not in the default payload); click to load it.
const CLICK_TABS = ['Top 20 (Including Ties)'];

async function scrapeGolf(slug) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    const bodies = [];
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!/league\/leagueSubcategory\/v1\/markets/.test(url)) return;
        const text = await resp.text();
        if (text.length > 5000) bodies.push(text);
      } catch (_) {}
    });
    await page.goto('https://sportsbook.draftkings.com/leagues/golf/' + slug, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 6000));
    for (const label of CLICK_TABS) {
      const clicked = await page.evaluate((txt) => {
        const el = Array.from(document.querySelectorAll('button,[role="tab"],a,h2')).find(
          (e) => (e.textContent || '').trim() === txt && e.offsetParent !== null);
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      }, label);
      if (!clicked) console.error('WARN: tab not found: ' + label);
      await new Promise((r) => setTimeout(r, 4000));
    }
    const out = { slug, winner: [], top5: [], top10: [], top20: [] };
    for (const body of bodies) {
      const doc = JSON.parse(body);
      const mkts = {};
      for (const m of doc.markets || []) mkts[m.id] = m;
      for (const s of doc.selections || []) {
        const m = mkts[s.marketId];
        if (!m) continue;
        const mtype = (m.marketType && m.marketType.name) || m.name || '';
        const slot = KEYMAP.find((k) => k.re.test(mtype));
        if (!slot) continue;
        if (out[slot.key].some((r) => r.player === s.label)) continue; // dedupe across repeated XHRs
        out[slot.key].push({ player: s.label, odds: norm(s.displayOdds && s.displayOdds.american) });
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const slug = process.argv[2];
  const outFile = process.argv[3];
  if (!slug) { console.error('usage: node dk-golf-outrights.js <league-slug> [outFile]'); process.exit(1); }
  scrapeGolf(slug).then((r) => {
    console.log('league', r.slug, '| winner:', r.winner.length, '| top5:', r.top5.length, '| top10:', r.top10.length, '| top20:', r.top20.length);
    if (outFile) { fs.writeFileSync(outFile, JSON.stringify(r, null, 1)); console.log('wrote', outFile); }
  }).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
module.exports = { scrapeGolf };
