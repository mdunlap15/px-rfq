// CJ Cup ROUND 3 matchup uploader — PX-pairing authoritative.
//
// Pipeline:
//   1. Fetch /lines/detail?sport=golf_matchups from the running service →
//      authoritative list of PX-registered R3 matchup pairings.
//   2. Fetch DataGolf round_matchups (PGA) → odds per pairing across books.
//   3. For each PX pairing, find the DataGolf entry that matches the same
//      two players (in either order, normalized names). Pick the best
//      available book: BetOnline > Bovada > DraftKings > FanDuel.
//   4. Upload the {teamA, oddsA, teamB, oddsB} payload to
//      /betonline-zurich/upload with scope='round_3' (replaces prior
//      round_3 cache).
//
// Earlier Bookmaker-based upload was wrong because Bookmaker has
// different pairings than PX (e.g., Bookmaker had Spieth vs Scheffler;
// PX has Spieth vs Mitchell). Code comments in services/betonline-scraper.js
// explicitly call out BetOnline as the canonical source whose pairings
// mirror PX.
//
// Usage:
//   node scripts/_upload_cj_cup_round3.js                 # preview only
//   node scripts/_upload_cj_cup_round3.js --upload        # actually POST
//
// Required env:
//   DATAGOLF_API_KEY  (always)
//   AUTH_USERNAME, AUTH_PASSWORD  (always — also used to fetch /lines/detail)

require('dotenv').config();

const DG_KEY = process.env.DATAGOLF_API_KEY;
const URL = process.env.PROD_URL || 'https://prophetx-rfq-production-6781.up.railway.app';
const USER = process.env.AUTH_USERNAME;
const PASS = process.env.AUTH_PASSWORD;
const UPLOAD = process.argv.includes('--upload');

if (!DG_KEY) { console.error('DATAGOLF_API_KEY must be set'); process.exit(1); }
if (!USER || !PASS) { console.error('AUTH_USERNAME and AUTH_PASSWORD must be set'); process.exit(1); }

const BOOK_PREFERENCE = ['betonline', 'bovada', 'draftkings', 'fanduel'];

// "Lastname, Firstname" → "Firstname Lastname"
function normalizeDgName(name) {
  if (!name) return '';
  const s = name.trim();
  if (!s.includes(',')) return s;
  const parts = s.split(',').map(p => p.trim());
  if (parts.length === 2) return parts[1] + ' ' + parts[0];
  return parts.slice(1).join(' ') + ' ' + parts[0];
}

// Name match key — strip punctuation, accents, hyphens, collapse whitespace,
// lowercase. Then compare full normalized OR last-name-only as a fallback.
function nameKey(n) {
  if (!n) return '';
  return String(n)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,']/g, '')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function lastName(n) {
  const k = nameKey(n);
  if (!k) return '';
  return k.split(' ').pop();
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  if (nameKey(a) === nameKey(b)) return true;
  if (lastName(a) === lastName(b)) return true;
  return false;
}

function pairMatch(dgP1, dgP2, pxA, pxB) {
  // Pairing matches if {dgP1, dgP2} matches {pxA, pxB} as a set.
  if (namesMatch(dgP1, pxA) && namesMatch(dgP2, pxB)) return { swap: false };
  if (namesMatch(dgP1, pxB) && namesMatch(dgP2, pxA)) return { swap: true };
  return null;
}

function pickBook(oddsObj) {
  for (const book of BOOK_PREFERENCE) {
    const o = oddsObj && oddsObj[book];
    if (!o) continue;
    const p1 = Number(o.p1);
    const p2 = Number(o.p2);
    if (Number.isFinite(p1) && Number.isFinite(p2) && p1 !== 0 && p2 !== 0) {
      return { book, p1, p2 };
    }
  }
  return null;
}

(async () => {
  // 1. Fetch PX-registered R3 matchups via /lines/detail
  console.log('Fetching /lines/detail?sport=golf_matchups ...');
  const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
  const linesResp = await fetch(URL + '/lines/detail?sport=golf_matchups', {
    headers: { Authorization: auth },
  });
  if (!linesResp.ok) { console.error('Failed:', linesResp.status, await linesResp.text()); process.exit(1); }
  const linesBody = await linesResp.json();
  const allLines = linesBody.lines || [];

  // Group by pxEventId — each event has two lines (home + away). Filter to R3.
  const eventsById = new Map();
  for (const ln of allLines) {
    if (!/round 3 matchup/i.test(ln.pxEventName || '')) continue;
    if (!eventsById.has(ln.pxEventId)) {
      eventsById.set(ln.pxEventId, {
        pxEventId: ln.pxEventId,
        pxEventName: ln.pxEventName,
        homeTeam: ln.homeTeam,
        awayTeam: ln.awayTeam,
        startTime: ln.startTime,
        eventDisabled: ln.eventDisabled,
      });
    }
  }
  const pxPairings = [...eventsById.values()];
  console.log(`PX R3 pairings registered: ${pxPairings.length}`);

  // 2. Fetch DataGolf round_matchups
  console.log('\nFetching DataGolf round_matchups (PGA tour)...');
  const dgUrl = `https://feeds.datagolf.com/betting-tools/matchups`
    + `?tour=pga&market=round_matchups&odds_format=american&file_format=json&key=${DG_KEY}`;
  const dgResp = await fetch(dgUrl);
  if (!dgResp.ok) { console.error('DG fetch failed', dgResp.status); process.exit(1); }
  const dgData = await dgResp.json();
  if (typeof dgData.match_list === 'string') {
    console.error('DG returned no matchups:', dgData.match_list);
    process.exit(1);
  }
  console.log(`DG event: ${dgData.event_name}  round=${dgData.round_num}  raw_entries=${dgData.match_list.length}`);

  // 3. For each PX pairing, find DataGolf entry that matches both players
  const matchups = [];
  const matched = [];
  const fallback = [];
  const skipped = [];

  for (const px of pxPairings) {
    let bestEntry = null;
    let bestPicked = null;
    let bestSwap = false;
    let entriesMatchingPair = [];

    for (const entry of dgData.match_list) {
      // PX matchups treat ties as void (refund). DataGolf returns a mix —
      // skip any entry with ties='separate bet offered' since those are
      // priced as 3-way markets and don't compare apples-to-apples.
      if (entry.ties && entry.ties !== 'void') continue;
      const p1 = normalizeDgName(entry.p1_player_name);
      const p2 = normalizeDgName(entry.p2_player_name);
      const m = pairMatch(p1, p2, px.awayTeam, px.homeTeam);
      if (!m) continue;
      entriesMatchingPair.push({ entry, p1, p2, swap: m.swap });
      // First entry where any preferred book has odds wins.
      const picked = pickBook(entry.odds);
      if (picked && !bestPicked) {
        bestEntry = entry;
        bestPicked = picked;
        bestSwap = m.swap;
        break;
      }
    }

    if (!bestPicked) {
      // Maybe DG has this pairing but no book in our preference list — show
      // all books that DO have odds, for diagnostic
      const allBooks = new Set();
      for (const m of entriesMatchingPair) {
        for (const [book, o] of Object.entries(m.entry.odds || {})) {
          if (o && Number.isFinite(Number(o.p1)) && Number.isFinite(Number(o.p2))) allBooks.add(book);
        }
      }
      skipped.push({
        pxEventId: px.pxEventId,
        pxEventName: px.pxEventName,
        away: px.awayTeam,
        home: px.homeTeam,
        dgEntries: entriesMatchingPair.length,
        booksAvailable: [...allBooks],
      });
      continue;
    }

    // PX side: awayTeam = teamA (DG p1 if !swap, else DG p2)
    // bestPicked has {p1, p2} from DG. Swap means DG.p1 == px.homeTeam.
    const oddsA = bestSwap ? bestPicked.p2 : bestPicked.p1;
    const oddsB = bestSwap ? bestPicked.p1 : bestPicked.p2;

    matchups.push({
      teamA: px.awayTeam,
      oddsA,
      teamB: px.homeTeam,
      oddsB,
    });

    const rec = {
      pxEventName: px.pxEventName,
      teamA: px.awayTeam, oddsA,
      teamB: px.homeTeam, oddsB,
      book: bestPicked.book,
    };
    if (bestPicked.book === 'betonline') matched.push(rec);
    else fallback.push(rec);
  }

  // 4. Summary
  console.log('\n=== SUMMARY ===');
  console.log(`PX R3 pairings:        ${pxPairings.length}`);
  console.log(`Matched (BetOnline):   ${matched.length}`);
  console.log(`Matched (fallback):    ${fallback.length}`);
  console.log(`Skipped (no DG match): ${skipped.length}`);

  const fmtOdds = (o) => (o >= 0 ? '+' : '') + o;
  if (fallback.length) {
    console.log(`\nFallback book picks:`);
    for (const r of fallback) {
      console.log(`  [${r.book.padEnd(11)}] ${r.teamA} ${fmtOdds(r.oddsA)} vs ${r.teamB} ${fmtOdds(r.oddsB)}`);
    }
  }
  if (skipped.length) {
    console.log(`\nSkipped PX pairings (no usable DG odds):`);
    for (const s of skipped) {
      console.log(`  ${s.pxEventName}  (${s.away} vs ${s.home})  dgEntries=${s.dgEntries}  books=[${s.booksAvailable.join(',') || 'none'}]`);
    }
  }

  console.log(`\nFinal upload payload (${matchups.length} matchups). Sample first 5:`);
  for (const m of matchups.slice(0, 5)) {
    console.log(`  ${m.teamA.padEnd(28)} ${fmtOdds(m.oddsA).padStart(5)}   vs   ${m.teamB.padEnd(28)} ${fmtOdds(m.oddsB).padStart(5)}`);
  }

  // Sanity check: Spieth pairing
  const spieth = matchups.find(m => /spieth/i.test(m.teamA) || /spieth/i.test(m.teamB));
  if (spieth) {
    console.log(`\nSpieth pairing check: ${spieth.teamA} (${fmtOdds(spieth.oddsA)}) vs ${spieth.teamB} (${fmtOdds(spieth.oddsB)})`);
  } else {
    console.log(`\n⚠ Spieth not in final payload — check skipped list.`);
  }

  if (!UPLOAD) {
    console.log(`\n[preview mode] Re-run with --upload to POST to ${URL}/betonline-zurich/upload`);
    return;
  }

  if (matchups.length === 0) {
    console.error('\nRefusing to upload empty matchup list.');
    process.exit(1);
  }

  console.log(`\nUploading ${matchups.length} round_3 matchup pairings...`);
  const resp = await fetch(URL + '/betonline-zurich/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ scope: 'round_3', matchups }),
  });
  const body = await resp.json().catch(() => ({}));
  console.log('Status: ' + resp.status);
  console.log(JSON.stringify(body, null, 2));
  if (!resp.ok) process.exit(1);
})().catch(err => { console.error('FATAL:', err.message, err.stack); process.exit(1); });
