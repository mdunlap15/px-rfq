// dk-sgp-phi.js — back out DK's IMPLIED same-game correlation (phi) for a
// 2-leg combo, from DK's own SGP price vs its singles.
//
// WHY: same-game correlation is prop-family-specific (batter run-producing
// composites ride the game script far harder than strikeouts), and our own
// settled tape is too small to calibrate per family — it sign-flips between
// windows. DK prices SGPs off a book-scale simulation; capturing (single A,
// single B, SGP price) and backing out phi borrows that calibration. The
// Kalshi maker measured this stable to ~±0.01 across vig assumptions.
// Feed the results into SGP_PHI_BY_FAMILY (config.pricing.sgpPhiByFamily).
//
// TWO MODES
//
// 1. CALC (no browser — paste numbers from the DK app by hand):
//      node scripts/dk-sgp-phi.js --calc <singleA> <singleB> <sgp> [oppA] [oppB]
//    American odds. If oppA/oppB (the OTHER side of each single) are given,
//    the singles are properly de-vigged as true two-sided pairs; otherwise a
//    per-side load assumption is used and phi is reported under a low and a
//    high assumption so the ±0.01 stability claim is visible per combo.
//      e.g.  node scripts/dk-sgp-phi.js --calc -140 -115 +205 +115 -105
//
// 2. CAPTURE (Puppeteer, passive-intercept — the proven dk-scraper pattern):
//      node scripts/dk-sgp-phi.js <dkEventUrl> "<selection A text>" "<selection B text>"
//    Loads the event page (Akamai-gated: headless page-load passes the JS
//    challenge; never call DK's API directly), records every market XHR (which
//    carry BOTH sides of every single — true de-vig, no assumption), clicks the
//    two named selections to build the SGP betslip, and captures the betslip
//    pricing XHR for the combined price. The betslip endpoint is not pinned to
//    one URL: after the clicks the script logs EVERY json XHR whose body
//    mentions both selections, so the first run doubles as endpoint recon.
//
// The math (shared by both modes):
//   p1,p2 = de-vigged single fair probs; q = de-vigged SGP joint prob
//   phi   = (q − p1·p2) / sqrt(p1(1−p1) · p2(1−p2))
// SGP de-vig assumptions reported side by side:
//   product : SGP carries both legs' loads compounded  (1+v1)(1+v2)
//   single  : SGP carries one leg's load only          (1+max(v1,v2))
//   none    : raw implied (upper bound on q, hence on phi)

const amerToProb = (a) => {
  const n = Number(String(a).replace(/−/g, '-'));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : (-n) / (-n + 100);
};

/** Proportional 2-way de-vig; returns the fair prob of side A. */
function devigPair(aProb, bProb) {
  if (!(aProb > 0) || !(bProb > 0)) return null;
  return aProb / (aProb + bProb);
}

/**
 * Back out phi. singles: [{prob, oppProb|null, loadAssumption|null}] x2,
 * sgpProb: raw implied of the SGP price. Returns {phi:{product,single,none},
 * p1, p2, v1, v2, stable} — `stable` is max−min across assumptions.
 */
function backOutPhi(singleA, singleB, sgpProb, opts = {}) {
  const DEFAULT_LOAD = opts.defaultLoad != null ? opts.defaultLoad : 0.025; // per-side, ~5% pair
  const leg = (s) => {
    if (s.oppProb != null && s.oppProb > 0) {
      const fair = devigPair(s.prob, s.oppProb);
      return { p: fair, v: s.prob / fair - 1 };            // v = this side's actual load
    }
    const v = s.loadAssumption != null ? s.loadAssumption : DEFAULT_LOAD;
    return { p: s.prob / (1 + v), v };
  };
  const A = leg(singleA), B = leg(singleB);
  if (!(A.p > 0 && A.p < 1 && B.p > 0 && B.p < 1) || !(sgpProb > 0 && sgpProb < 1)) return null;
  const denom = Math.sqrt(A.p * (1 - A.p) * B.p * (1 - B.p));
  const phiAt = (q) => (q - A.p * B.p) / denom;
  const qProduct = sgpProb / ((1 + A.v) * (1 + B.v));
  const qSingle = sgpProb / (1 + Math.max(A.v, B.v));
  const out = {
    p1: A.p, p2: B.p, v1: A.v, v2: B.v,
    phi: {
      product: phiAt(qProduct),
      single: phiAt(qSingle),
      none: phiAt(sgpProb),
    },
  };
  const vals = [out.phi.product, out.phi.single];
  out.stable = Math.max(...vals) - Math.min(...vals);
  return out;
}

function printResult(label, r) {
  if (!r) { console.log(label + ': could not compute (bad inputs)'); return; }
  console.log(label);
  console.log(`  de-vigged singles: p1=${(r.p1 * 100).toFixed(2)}%  p2=${(r.p2 * 100).toFixed(2)}%  (side loads v1=${(r.v1 * 100).toFixed(1)}% v2=${(r.v2 * 100).toFixed(1)}%)`);
  console.log(`  phi  product-load=${r.phi.product.toFixed(3)}  single-load=${r.phi.single.toFixed(3)}  no-devig=${r.phi.none.toFixed(3)}`);
  console.log(`  spread across vig assumptions: ${r.stable.toFixed(3)}  ${r.stable <= 0.02 ? '(stable — trust it)' : '(UNSTABLE — capture the opposite sides and re-run)'}`);
}

// ---------------------------------------------------------------- CALC mode
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--calc') {
    const [a, b, sgp, oppA, oppB] = argv.slice(1);
    if (!a || !b || !sgp) {
      console.log('usage: node scripts/dk-sgp-phi.js --calc <singleA> <singleB> <sgp> [oppA] [oppB]');
      process.exit(1);
    }
    const r = backOutPhi(
      { prob: amerToProb(a), oppProb: oppA ? amerToProb(oppA) : null },
      { prob: amerToProb(b), oppProb: oppB ? amerToProb(oppB) : null },
      amerToProb(sgp)
    );
    printResult(`phi for ${a} + ${b} -> SGP ${sgp}`, r);
    return;
  }

  // ------------------------------------------------------------ CAPTURE mode
  const [eventUrl, selAText, selBText] = argv;
  if (!eventUrl || !selAText || !selBText) {
    console.log('usage: node scripts/dk-sgp-phi.js <dkEventUrl> "<selection A text>" "<selection B text>"');
    console.log('   or: node scripts/dk-sgp-phi.js --calc <singleA> <singleB> <sgp> [oppA] [oppB]');
    process.exit(1);
  }
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

  const marketPayloads = [];   // pre-click: market XHRs (carry BOTH sides of singles)
  const postClickPayloads = []; // post-click: candidate betslip pricing XHRs
  let clicked = false;
  page.on('response', async (res) => {
    try {
      const ct = String(res.headers()['content-type'] || '');
      if (!ct.includes('json')) return;
      const url = res.url();
      if (!/draftkings|dkn|sportsbook/i.test(url)) return;
      const text = await res.text();
      if (!text || text.length < 50) return;
      (clicked ? postClickPayloads : marketPayloads).push({ url, text });
    } catch { /* stream already consumed / detached */ }
  });

  console.log('loading', eventUrl, '(Akamai challenge, ~20-40s)…');
  await page.goto(eventUrl, { waitUntil: 'networkidle2', timeout: 120000 });
  await new Promise(r => setTimeout(r, 5000));

  // Click a selection by its visible text. DK renders selections as buttons /
  // divs whose aria-label or textContent contains the player+market wording.
  async function clickSelection(txt) {
    const ok = await page.evaluate((needle) => {
      const els = [...document.querySelectorAll('button,[role="button"],div[aria-label]')];
      const hit = els.find(e =>
        ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || ''))
          .toLowerCase().includes(needle.toLowerCase()));
      if (!hit) return false;
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return true;
    }, txt);
    console.log((ok ? 'clicked: ' : 'NOT FOUND on page: ') + txt);
    return ok;
  }

  clicked = true;
  const okA = await clickSelection(selAText);
  await new Promise(r => setTimeout(r, 2500));
  const okB = await clickSelection(selBText);
  await new Promise(r => setTimeout(r, 6000));   // let the betslip quote land
  await browser.close();

  if (!okA || !okB) {
    console.log('\nOne or both selections not found — check the exact on-page wording (aria-labels).');
  }

  // Recon output: any post-click JSON mentioning both selections is a betslip
  // pricing candidate. Print URLs + odds-looking fields so the endpoint can be
  // pinned and parsed properly on the next iteration.
  const mentionsBoth = postClickPayloads.filter(p => {
    const t = p.text.toLowerCase();
    const a = selAText.toLowerCase().split(/\s+/)[0];
    const b = selBText.toLowerCase().split(/\s+/)[0];
    return t.includes(a) && t.includes(b);
  });
  console.log(`\ncaptured ${marketPayloads.length} market XHRs pre-click, ${postClickPayloads.length} post-click (${mentionsBoth.length} mention both selections)`);
  for (const p of mentionsBoth.slice(0, 5)) {
    const odds = [...p.text.matchAll(/"(americanOdds|americanDisplayOdds|oddsAmerican)"\s*:\s*"?([+\-−]?\d+)"?/g)].map(m => m[2]);
    console.log('  CANDIDATE:', p.url.slice(0, 110));
    console.log('    odds fields:', odds.slice(0, 12).join(', ') || '(none — inspect body)');
  }
  const dump = 'C:/Users/mdunl/px-rfq/_dk_sgp_phi_capture.json';
  require('fs').writeFileSync(dump, JSON.stringify({ eventUrl, selAText, selBText, mentionsBoth, marketCount: marketPayloads.length }, null, 1));
  console.log('full candidate payloads written to', dump);
  console.log('\nOnce the SGP price + both sides of each single are identified, finish with:');
  console.log('  node scripts/dk-sgp-phi.js --calc <singleA> <singleB> <sgp> <oppA> <oppB>');
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { backOutPhi, devigPair, amerToProb };
