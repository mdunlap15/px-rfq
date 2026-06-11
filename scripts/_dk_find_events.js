const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');
  await page.goto('https://sportsbook.draftkings.com/leagues/soccer/world-cup-2026', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000));
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/event/"]')).map((a) => a.getAttribute('href'))
      .filter((h, i, arr) => h && !h.includes('sgpmode') && arr.indexOf(h) === i)
  );
  links.forEach((l) => console.log(l));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
