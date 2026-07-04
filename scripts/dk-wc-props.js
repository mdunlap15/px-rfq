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
const stripET = (s) => String(s == null ? '' : s).replace(/\s*\(incl[^)]*extra time\)/i, '').trim(); // drop knockout "(including Extra Time)" suffix

// Reject in-play / partial-match variants that load alongside the full-match markets and would
// otherwise pollute the parse with different (wrong) prices: Live/in-play, 90-min-only, half-only,
// extra-time-only, next-team. The full-match "(Incl. Extra Time)" knockout markets pass.
const isVariant = (s) => /\b(live|90 ?min|1st half|2nd half|first half|second half|next team|extra time goalscorer|extra time assist)\b/i.test(String(s == null ? '' : s));
// True for full-match "(including Extra Time)" / "(Incl. Extra Time)" knockout markets. When a match
// offers BOTH an ET and a non-ET version of a prop, we keep the ET one (it matches the PX knockout market).
const isET = (s) => /incl[^)]*extra time|including extra time/i.test(String(s == null ? '' : s));

function parseGoalscorer(doc) {
  // The goalscorer subcategory carries three markets: 1st / Anytime / 2+.
  // Emit anytime and 2+ separately (1st is excluded on purpose).
  const mkts = {};
  for (const m of doc.markets) mkts[m.id] = m;
  const anytime = [], twoPlus = [];
  for (const s of doc.selections) {
    const mk = mkts[s.marketId];
    if (!mk) continue;
    const mtype = stripET((mk.marketType && mk.marketType.name) || '');
    if (isVariant((mk.marketType && mk.marketType.name) || '') || isVariant(mk.name || '')) continue;
    const _et = isET((mk.marketType && mk.marketType.name) || '') || isET(mk.name || '');
    const row = { player: s.label, seo: ((s.participants || [{}])[0].seoIdentifier || s.label).trim(), odds: norm(s.displayOdds && s.displayOdds.american), _et };
    if (/anytime goalscorer/i.test(mtype)) anytime.push(row);          // matches "Anytime Goalscorer" + "...(including Extra Time)"
    else if (/2 or more goals/i.test(mtype)) twoPlus.push(row);
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
    const mname = stripET(mk.name || ''); const mtype = stripET((mk.marketType && mk.marketType.name) || '');
    if (isVariant((mk.marketType && mk.marketType.name) || '') || isVariant(mk.name || '')) continue;
    if (!/shots on target/i.test(mtype + ' ' + mname)) continue;   // STRICT market-type gate (safe for content-based cross-run)
    const _et = isET((mk.marketType && mk.marketType.name) || '') || isET(mk.name || '');
    const player = mname.replace(/ Shots on Target$/i, '').trim();
    const seo = ((s.participants || [{}])[0].seoIdentifier || player).trim();
    byPlayer[player] = byPlayer[player] || { player, seo, one: null, two: null, three: null, _et };
    const lab = (s.label || '').trim();
    if (lab === '1+') byPlayer[player].one = norm(s.displayOdds && s.displayOdds.american);
    else if (lab === '2+') byPlayer[player].two = norm(s.displayOdds && s.displayOdds.american);
    else if (lab === '3+') byPlayer[player].three = norm(s.displayOdds && s.displayOdds.american);
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
    const mname = stripET(mk.name || ''); const mtype = stripET((mk.marketType && mk.marketType.name) || mk.name || '');
    if (isVariant((mk.marketType && mk.marketType.name) || '') || isVariant(mk.name || '')) continue;
    if (/score or assist|goals? \+ assist/i.test(mtype + ' ' + mname)) continue;   // EXCLUDE combined "Score or Assist" / "Goals + Assists" (correlated, not pure assist)
    if (!/assist/i.test(mtype + ' ' + mname)) continue;           // STRICT: only assist markets
    const _et = isET((mk.marketType && mk.marketType.name) || '') || isET(mk.name || '');
    const lab = (s.label || '').trim();
    const amer = norm(s.displayOdds && s.displayOdds.american);
    const seo = ((s.participants || [{}])[0].seoIdentifier || '').trim();
    if (/per[- ]?player|assists$/i.test(mname) && /\bassist/i.test(mtype + mname)) {
      // per-player market: player in market name, label is "1+"/"2+"
      const player = mname.replace(/ Assists$/i, '').replace(/ To Record an Assist$/i, '').trim();
      byPlayer[player] = byPlayer[player] || { player, seo: seo || player, odds: null, _et };
      if (lab === '1+' || /assist/i.test(s.outcomeType || '')) byPlayer[player].odds = byPlayer[player].odds || amer;
    } else {
      // single market: player in label
      byPlayer[s.label] = byPlayer[s.label] || { player: s.label, seo: seo || s.label, odds: amer, _et };
    }
  }
  for (const v of Object.values(byPlayer)) out.push(v);
  return out;
}

async function scrapeEvent(slugId) {
  const eventId = slugId.split('/').pop();
  // --disable-dev-shm-usage: Railway/Docker give Chromium a tiny /dev/shm (~64MB); without this
  // Chromium segfaults on these prop pages (kernel "cr2: 0000..." page fault) -> DK scrape returns 0000.
  // Writes shared memory to /tmp instead. --disable-gpu/--disable-setuid-sandbox are safe headless companions.
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'] });
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
    // DK lazy-loads each prop section's data ONLY when its category/accordion is activated, and it
    // RENUMBERS the eventSubcategory ids on every page load (so ids are useless — never key off them).
    // Drive purely by NAME: click each prop category + its accordion sections, and RETRY until the three
    // markets we need (anytime goalscorer / shots on target / pure player assists) have all loaded.
    //  - Top category pills (e.g. "Shots") are DIVs; accordion section headers (e.g. "Player Assists")
    //    are BUTTONs -> click whichever exact-text element exists, preferring the clickable one.
    //  - "Goals + Assists" is the category that cascade-loads the pure "Player Assists" subcat.
    // CRITICAL: DK's React accordions/tabs ignore in-page el.click() — they only respond to a REAL pointer
    // event. So we locate the element (scrolling it into view) and return its on-screen center, then fire
    // page.mouse.click() at that point. Skip a section that's already aria-expanded (clicking would COLLAPSE
    // it). This is the fix for knockout SoT/assists not loading (the prior el.click() silently did nothing).
    const locate = (name) => page.evaluate((title) => {
      // Match ACCORDION SECTION HEADERS only (button/[role=tab]/[aria-expanded]) — NEVER the top-nav <A>
      // category links: clicking those NAVIGATES to a single-category view and removes the other sections
      // from the DOM (that's what hid "Player Assists"). The default page view stacks all sections.
      let acc = null;
      for (const e of document.querySelectorAll('button,[role="tab"],[aria-expanded]')) {
        if ((e.textContent || '').trim() !== title || e.offsetParent === null) continue;
        if (e.tagName === 'A' || e.closest('a')) continue;   // exclude nav anchors
        if (!acc || (e.textContent || '').length < (acc.textContent || '').length) acc = e;
      }
      if (!acc) return null;
      if (acc.getAttribute('aria-expanded') === 'true') return { open: true };  // already expanded; don't collapse it
      acc.scrollIntoView({ block: 'center' });
      const r = acc.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, name);
    const clickByName = async (name) => {
      const box = await locate(name);
      if (!box) return false;
      if (box.open) return true;
      if (box.x > 0 && box.y > 0) { try { await page.mouse.click(box.x, box.y); } catch (_) {} }
      return true;
    };
    // Accordion SECTION headers to expand (NOT top-nav category links). Goalscorer + Player Shots on Target
    // are expanded by default; we still list them in case a match loads them collapsed. "Goals + Assists"
    // is expanded first because the pure "Player Assists" section sits inside that category group.
    const TARGETS = ['Player Shots on Target', 'Player Shots', 'Goals + Assists', 'Player Assists', 'Anytime Assist', 'Goalscorer'];
    const coverage = () => {
      const names = [];
      for (const id of Object.keys(bodies)) {
        try { for (const m of (JSON.parse(bodies[id]).markets || [])) names.push(((m.marketType && m.marketType.name) || '')); } catch (_) {}
      }
      const has = (re) => names.some((n) => re.test(n) && !isVariant(n));
      return { gs: has(/anytime goalscorer/i), sot: has(/shots on target/i), ast: has(/player assists|to record an assist/i) };
    };
    // Click each target (category pill or accordion section header) with a real mouse click and WAIT for
    // its XHR — no page scrolling between clicks (scrolling re-renders/collapses DK's accordions and was
    // eating the assists load). Retry rounds until all 3 markets are covered.
    for (let round = 0; round < 4; round++) {
      for (const name of TARGETS) {
        if (await clickByName(name)) await new Promise((r) => setTimeout(r, 3000));
      }
      const c = coverage();
      if (c.gs && c.sot && c.ast) break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    // Parse by CONTENT, not by subcat id: run all three parsers over EVERY captured body and merge.
    // Each parser only extracts its own market type, so cross-running is safe + structure-agnostic
    // (works for both group-stage and knockout id schemes).
    const result = { eventId, slug: slugId, scrapedKeys: Object.keys(bodies), coverage: coverage(), goalscorer: [], goals2plus: [], sot: [], assists: [] };
    // Merge by player, PREFERRING the "(including Extra Time)" row when a player appears in both an ET and
    // a non-ET market (knockout pages carry both; the 90-min ones are already dropped by isVariant). This
    // is what bit us before: the 90-min/no-suffix prices are LONGER (less time) -> wrong side vs the PX ET market.
    const mGS = new Map(), m2 = new Map(), mSOT = new Map(), mAST = new Map();
    const put = (map, key, row) => { if (!key) return; const ex = map.get(key); if (!ex || (row._et && !ex._et)) map.set(key, row); };
    for (const id of Object.keys(bodies)) {
      let doc; try { doc = JSON.parse(bodies[id]); } catch (_) { continue; }
      if (!doc || !Array.isArray(doc.markets) || !Array.isArray(doc.selections)) continue;
      const g = parseGoalscorer(doc);
      for (const r of g.anytime) put(mGS, r.seo, r);
      for (const r of g.twoPlus) put(m2, r.seo, r);
      for (const r of parseShotsOnTarget(doc)) put(mSOT, r.player, r);
      for (const r of parseAssists(doc)) put(mAST, r.player, r);
      if (process.env.DK_RAW) fs.writeFileSync('C:/Users/mdunl/dk_raw_' + id + '.json', bodies[id]);
    }
    const strip = (m) => Array.from(m.values()).map(({ _et, ...r }) => r);
    result.goalscorer = strip(mGS); result.goals2plus = strip(m2); result.sot = strip(mSOT); result.assists = strip(mAST);
    // Knockout sanity: if this match offers ANY ET market, every kept row in that market should be ET
    // (a residual non-ET row means we failed to load the ET version -> flag it rather than post 90-min prices).
    const etFlag = (arr) => arr.some((r) => r._et) ? arr.every((r) => r._et) : true;
    result.etConsistent = { gs: etFlag(Array.from(mGS.values())), sot: etFlag(Array.from(mSOT.values())), ast: etFlag(Array.from(mAST.values())) };
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
