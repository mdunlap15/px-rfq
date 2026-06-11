/**
 * DraftKings World Cup player-prop scraper.
 *
 * DK's /sites/*-SB/api/sportscontent/... JSON endpoints are Akamai-gated
 * (403 to any vanilla client) AND CORS-locked (in-page fetch fails). The
 * one path that works: headless Chromium loads the event page (passes the
 * Akamai JS challenge), and we PASSIVELY intercept the eventSubcategory
 * markets XHR that DK's own SPA fires. Each player-prop subcategory only
 * loads when its tab is viewed, so we click the subcategory's <H2> header
 * by exact title (clicking the container div does NOT trigger the fetch)
 * and capture the response.
 *
 * Output per event:
 *   { goalscorer: [{player, seo, odds}],      // Anytime Goalscorer
 *     sot:        [{player, seo, one, two}],   // 1+ / 2+ Shots on Target
 *     assists:    [{player, seo, odds}] }      // 1+ / Anytime Assist
 *
 * Usage:
 *   node scripts/dk-wc-props.js <eventSlugAndId> [outFile]
 *   e.g. node scripts/dk-wc-props.js brazil-vs-morocco/33260432 dk_brazil_morocco.json
 *
 * Odds are American strings normalized to ASCII (DK serves U+2212 minus).
 */
const fs = require('fs');
const puppeteer = require('puppeteer');

// Subcategory titles (exact H2 text) we navigate, with their numeric ids.
// ids are stable per-league; titles are what we click. If DK renames a
// tab, update TITLE here (the click is title-driven, capture is id-driven).
const SUBCATS = [
  { key: 'goalscorer', id: '16604', title: 'Goalscorer' },
  { key: 'sot', id: '16861', title: 'Player Shots on Target' },
  { key: 'assists', id: '16863', title: 'Player Assists' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const norm = (s) => (s == null ? s : String(s).replace(/−/g, '-')); // DK minus -> ASCII

function parseGoalscorer(doc) {
  // The goalscorer subcategory carries three markets: 1st / Anytime / 2+.
  // Emit anytime and 2+ separately (1st is excluded on purpose).
  const mkts = {};
  for (const m of doc.markets) mkts[m.id] = m;
  const anytime = [], twoPlus = [];
  for (const s of doc.selections) {
    const mk = mkts[s.marketId];
    if (!mk) continue;
    const mtype = (mk.marketType && mk.marketType.name) || '';
    const row = { player: s.label, seo: ((s.participants || [{}])[0].seoIdentifier || s.label).trim(), odds: norm(s.displayOdds && s.displayOdds.american) };
    if (mtype === 'Anytime Goalscorer') anytime.push(row);
    else if (/2 or More Goals/i.test(mtype)) twoPlus.push(row);
  }
  return { anytime, twoPlus };
}
function parseShotsOnTarget(doc) {
  const mkts = {};
  for (const m of doc.markets) mkts[m.id] = m;
  const byPlayer = {};
  for (const s of doc.selections) {
    const mk = mkts[s.marketId];
    if (!mk) continue;
    const player = mk.name.replace(/ Shots on Target$/i, '').trim();
    const seo = ((s.participants || [{}])[0].seoIdentifier || player).trim();
    byPlayer[player] = byPlayer[player] || { player, seo, one: null, two: null };
    const lab = (s.label || '').trim();
    if (lab === '1+') byPlayer[player].one = norm(s.displayOdds && s.displayOdds.american);
    else if (lab === '2+') byPlayer[player].two = norm(s.displayOdds && s.displayOdds.american);
  }
  return Object.values(byPlayer);
}
function parseAssists(doc) {
  const mkts = {};
  for (const m of doc.markets) mkts[m.id] = m;
  const out = [];
  // Assists may be either per-player "{Player} Assists" with a 1+ line,
  // or a single "Anytime Assist" market with player-labeled selections.
  // Handle both: prefer the 1+ line; fall back to an Anytime/ToAssist row.
  const byPlayer = {};
  for (const s of doc.selections) {
    const mk = mkts[s.marketId];
    if (!mk) continue;
    const mtype = (mk.marketType && mk.marketType.name) || mk.name || '';
    const lab = (s.label || '').trim();
    const amer = norm(s.displayOdds && s.displayOdds.american);
    const seo = ((s.participants || [{}])[0].seoIdentifier || '').trim();
    if (/per[- ]?player|assists$/i.test(mk.name) && /\bassist/i.test(mtype + mk.name)) {
      // per-player market: player in market name, label is "1+"/"2+"
      const player = mk.name.replace(/ Assists$/i, '').replace(/ To Record an Assist$/i, '').trim();
      byPlayer[player] = byPlayer[player] || { player, seo: seo || player, odds: null };
      if (lab === '1+' || /assist/i.test(s.outcomeType || '')) byPlayer[player].odds = byPlayer[player].odds || amer;
    } else if (/assist/i.test(mtype)) {
      // single market: player in label
      byPlayer[s.label] = byPlayer[s.label] || { player: s.label, seo: seo || s.label, odds: amer };
    }
  }
  for (const v of Object.values(byPlayer)) out.push(v);
  return out;
}

async function scrapeEvent(slugId) {
  const eventId = slugId.split('/').pop();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    const bodies = {};
    const reSub = new RegExp('templateVars=' + eventId + '%2C(\\d+)');
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!/eventSubcategory\/v1\/markets/.test(url)) return;
        const m = reSub.exec(url);
        if (!m) return;
        const text = await resp.text();
        if (text.length > 800) bodies[m[1]] = text;
      } catch (_) {}
    });
    await page.goto('https://sportsbook.draftkings.com/event/' + slugId, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000));
    for (const sc of SUBCATS) {
      if (bodies[sc.id]) continue; // already loaded (goalscorer is default)
      const clicked = await page.evaluate((title) => {
        const els = Array.from(document.querySelectorAll('h2,h3,[role="tab"],button,a')).filter(
          (e) => (e.textContent || '').trim() === title && e.offsetParent !== null && e.children.length <= 1
        );
        if (!els.length) return false;
        els[0].scrollIntoView();
        els[0].click();
        return true;
      }, sc.title);
      await new Promise((r) => setTimeout(r, 4000));
      if (!bodies[sc.id]) console.error('WARN: no body for ' + sc.key + ' (clicked=' + clicked + ')');
    }
    const result = { eventId, slug: slugId, scrapedKeys: Object.keys(bodies), goals2plus: [] };
    for (const sc of SUBCATS) {
      if (!bodies[sc.id]) { result[sc.key] = []; continue; }
      const doc = JSON.parse(bodies[sc.id]);
      if (sc.key === 'goalscorer') {
        const g = parseGoalscorer(doc);
        result.goalscorer = g.anytime;
        result.goals2plus = g.twoPlus;
      } else if (sc.key === 'sot') result.sot = parseShotsOnTarget(doc);
      else if (sc.key === 'assists') result.assists = parseAssists(doc);
      // keep raw for debugging assists schema this first run
      if (process.env.DK_RAW) fs.writeFileSync('C:/Users/mdunl/dk_raw_' + sc.key + '.json', bodies[sc.id]);
    }
    return result;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const slugId = process.argv[2];
  const out = process.argv[3];
  if (!slugId) { console.error('usage: node dk-wc-props.js <slug/eventId> [outFile]'); process.exit(1); }
  scrapeEvent(slugId).then((r) => {
    console.log('event', r.eventId, '| subs:', r.scrapedKeys.join(','));
    console.log('  goalscorer:', r.goalscorer.length, '| goals2plus:', r.goals2plus.length, '| sot:', r.sot.length, '| assists:', r.assists.length);
    if (out) { fs.writeFileSync(out, JSON.stringify(r, null, 1)); console.log('  wrote', out); }
    else console.log(JSON.stringify(r, null, 1).substring(0, 1200));
  }).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
module.exports = { scrapeEvent };
