// ============================================================================
// Generic ROUND 1 golf-matchup uploader.
// ============================================================================
// Same path the one-shot per-tournament scripts used
// (_upload_pga_championship_round1.js), but the board is supplied at RUN time
// instead of being hardcoded, so a new tournament needs no new file.
//
// Posts to /betonline-zurich/upload with scope='round_1'. That endpoint
// REPLACES every existing round_1 matchup (other scopes — 'tournament',
// 'round_2'... — are left alone), updates the live in-memory cache
// immediately, AND persists to Supabase kv_store['betonline_zurich'] via
// saveKV, so the upload survives a Railway redeploy. There is no separate
// Supabase write to do (the older _upload_cj_cup_matchups.js wrote the KV
// directly and required a redeploy to take effect — this does not).
//
// Once uploaded these are the AUTHORITATIVE quoting prices for R1 matchup
// legs: pricer.getGolfMatchupFairProb reads them at PRIORITY 1 and quotes AT
// the raw book price (bookPriceOverride — no de-vig / re-vig), clamped up to
// the vigGolfMatchupMin payout floor. Bad numbers here quote live money, so
// the script is DRY-RUN BY DEFAULT and only writes with --go.
//
// Usage:
//   # 1. dry-run — parses, pairs, and sanity-checks, writes nothing
//   node scripts/_upload_golf_round1.js --file board.txt
//   node scripts/_upload_golf_round1.js --file board.json
//   pbpaste | node scripts/_upload_golf_round1.js          # stdin
//
//   # 2. upload for real
//   node scripts/_upload_golf_round1.js --file board.txt --go
//
// Input shapes (auto-detected):
//   .json  — [{ teamA, oddsA, teamB, oddsB }, ...]  (or {matchups:[...]})
//   .txt   — raw BetOnline/Bookmaker paste, "<id> - Name/Name  <odds>" rows,
//            paired sequentially by services/betonline-scraper.parseManualText
//            (the SAME parser the server runs, required here so the dry-run
//            preview is exactly what the server would store).
//
// Env: AUTH_USERNAME / AUTH_PASSWORD (admin Basic auth), PROD_URL to override
// the host. Reads .env if present.
//
// Flags:
//   --file <path>   board file (omit to read stdin)
//   --scope <s>     default round_1; accepts round_2..round_4 / tournament
//   --go            actually upload (default is dry-run)
//   --force         upload even if sanity checks flagged pairings
// ============================================================================

require('dotenv').config();
const fs = require('fs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const URL = process.env.PROD_URL || 'https://prophetx-rfq-production-6781.up.railway.app';
const SCOPE = opt('--scope', 'round_1');
const GO = flag('--go');
const FORCE = flag('--force');
const FILE = opt('--file', null);

// Two-way overround bounds. A correctly-paired book matchup prices ~2-8% over;
// mis-paired rows (the sequential pairer walking a paste whose rows interleave)
// produce a sum far outside this. Cheap, high-signal check — it caught nothing
// in the PGA R1 board but it is the failure mode that would silently quote
// garbage.
const OVERROUND_MIN = 1.00;
const OVERROUND_MAX = 1.15;

const impliedOf = (odds) => (odds >= 0 ? 100 / (odds + 100) : -odds / (-odds + 100));
const fmtOdds = (o) => (o >= 0 ? `+${o}` : `${o}`);

function readInput() {
  if (FILE) {
    if (!fs.existsSync(FILE)) {
      console.error(`No such file: ${FILE}`);
      process.exit(1);
    }
    return { text: fs.readFileSync(FILE, 'utf8'), isJson: /\.json$/i.test(FILE) };
  }
  const stdin = fs.readFileSync(0, 'utf8');
  if (!stdin.trim()) {
    console.error('No input — pass --file <path> or pipe the board on stdin.');
    process.exit(1);
  }
  return { text: stdin, isJson: stdin.trim().startsWith('[') || stdin.trim().startsWith('{') };
}

// Normalize either input shape to the array form the endpoint accepts. Text
// goes through the server's own parser so the preview can't disagree with what
// the server would store.
function toMatchups({ text, isJson }) {
  if (isJson) {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : parsed.matchups;
    if (!Array.isArray(arr)) throw new Error('JSON must be an array or {matchups:[...]}');
    return arr.map(m => ({
      teamA: String(m.teamA ?? m.team_a ?? '').trim(),
      oddsA: Number(m.oddsA ?? m.odds_a),
      teamB: String(m.teamB ?? m.team_b ?? '').trim(),
      oddsB: Number(m.oddsB ?? m.odds_b),
    }));
  }
  const { parseManualText } = require('../services/betonline-scraper');
  return parseManualText(text, SCOPE).map(m => ({
    teamA: m.teams[0].team, oddsA: m.teams[0].odds,
    teamB: m.teams[1].team, oddsB: m.teams[1].odds,
  }));
}

(async () => {
  const matchups = toMatchups(readInput());
  if (!matchups.length) {
    console.error('Parsed 0 matchups — check the paste format ("<id> - Name/Name" with American odds nearby).');
    process.exit(1);
  }

  console.log(`Parsed ${matchups.length} ${SCOPE} pairings from ${FILE || 'stdin'}\n`);

  const flagged = [];
  const seen = new Map();
  for (const [i, m] of matchups.entries()) {
    const problems = [];
    if (!m.teamA || !m.teamB) problems.push('missing name');
    if (!Number.isFinite(m.oddsA) || !Number.isFinite(m.oddsB)) problems.push('missing odds');
    let sum = null;
    if (Number.isFinite(m.oddsA) && Number.isFinite(m.oddsB)) {
      sum = impliedOf(m.oddsA) + impliedOf(m.oddsB);
      if (sum < OVERROUND_MIN || sum > OVERROUND_MAX) {
        problems.push(`two-way sum ${(sum * 100).toFixed(1)}% outside ${OVERROUND_MIN * 100}-${OVERROUND_MAX * 100}% — likely mis-paired`);
      }
    }
    // A player appearing twice in one scope is legal (Cadillac R3 had Castillo
    // in two pairings, which is why the lookup is opponent-aware) but it is
    // also what a mis-paired paste looks like, so surface it.
    for (const name of [m.teamA, m.teamB]) {
      if (!name) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) problems.push(`"${name}" also in pairing #${seen.get(k) + 1}`);
      else seen.set(k, i);
    }

    const line = `${String(i + 1).padStart(3)}. ${m.teamA.padEnd(28)} ${fmtOdds(m.oddsA).padStart(6)}`
      + `  vs  ${m.teamB.padEnd(28)} ${fmtOdds(m.oddsB).padStart(6)}`
      + (sum != null ? `   [${(sum * 100).toFixed(1)}%]` : '');
    console.log(problems.length ? `${line}   <-- ${problems.join('; ')}` : line);
    if (problems.length) flagged.push({ i: i + 1, problems });
  }

  if (flagged.length) {
    console.log(`\n${flagged.length} pairing(s) flagged. Re-check the paste before uploading.`);
    if (GO && !FORCE) {
      console.error('Refusing to upload with flagged pairings — fix the board, or re-run with --force if they are genuinely correct.');
      process.exit(1);
    }
  } else {
    console.log('\nAll pairings look sane (two-way overrounds in range, no duplicate players).');
  }

  if (!GO) {
    console.log('\n[dry-run] nothing uploaded. Re-run with --go to post.');
    return;
  }

  const USER = process.env.AUTH_USERNAME;
  const PASS = process.env.AUTH_PASSWORD;
  if (!USER || !PASS) {
    console.error('AUTH_USERNAME and AUTH_PASSWORD must be set (env or .env) to upload.');
    process.exit(1);
  }
  const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

  console.log(`\nUploading ${matchups.length} ${SCOPE} matchups to ${URL} ...`);
  const resp = await fetch(URL + '/betonline-zurich/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ scope: SCOPE, matchups }),
  });
  const body = await resp.json().catch(() => ({}));
  console.log(`Status: ${resp.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (!resp.ok) process.exit(1);

  // Read back the live cache and count what actually landed in this scope —
  // the upload response reports what it accepted, this confirms what the
  // server will price off.
  const check = await fetch(URL + '/betonline-zurich', { headers: { Authorization: auth } });
  const state = await check.json().catch(() => ({}));
  const inScope = (state.matchups || []).filter(m => m.scope === SCOPE).length;
  console.log(`\nVerified: ${inScope} ${SCOPE} matchups live in cache (source=${state.source}, fetchedAt=${state.fetchedAt}).`);
  if (inScope !== matchups.length) {
    console.error(`WARNING: expected ${matchups.length}, cache holds ${inScope}.`);
    process.exit(1);
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
