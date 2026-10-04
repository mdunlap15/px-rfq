// ============================================================================
// mlb-series-consensus.js — MLB playoff SERIES WINNER prices for RFQ legs,
// on the ORDER-BOOK methodology.
// ============================================================================
// Operator 2026-10-04: "we should be quoting MLB playoff series prices in
// between games of the series." Standing: "I don't want to derive any of our
// own lines; I want ours to always be direct references to the lines of
// sportsbooks" and "use the methodology we use for the order book lines".
//
// REFERENCE (read-only; never run from here — they place orders / scrape):
//   C:/Users/mdunl/mlb_series_consensus.py   sources + consensus rules (ported)
//   C:/Users/mdunl/mlb_series_post.py        price_pair() (translated below)
//   C:/Users/mdunl/dk-mlb-series.js          DK capture -> dk-scraper.fetchMlbSeriesBoard
//   C:/Users/mdunl/bo-mlb-series.js          BetOnline capture (ported below)
//   C:/Users/mdunl/mlb_series_sched.py       team_key / pair_key (ported below)
//   C:/Users/mdunl/mlb_futures_consensus.py  CLUBS / ALIAS / imp / am / ai (ported)
//
// SOURCES: draftkings (headless Chrome, XHR intercept), betonline (headless
// Chrome, page text of /sportsbook/baseball/mlb-series), bovada (public JSON
// coupon, plain HTTPS). FanDuel, Kambi and The Odds API carry no series market,
// so the 3-book floor is met EXACTLY and only when both Chrome scrapes work.
//
// CONSENSUS RULES (per series = a pair of clubs, keyed 'braves|dodgers'):
//   * a book counts once; sides join on teamKey() (series suffix stripped first);
//     an unknown / same-club pair is dropped, two markets claiming one pair in
//     one book drop that book for the pair (refuse rather than guess);
//   * a book's two-way overround must sit in [SERIES_OVR_LO, SERIES_OVR_HI]
//     (1.01..1.12), else it is dropped for the pair;
//   * suspended / closed / live markets are skipped; a source older than
//     SERIES_SRC_MAX_AGE_S (600) does not count; a scrape with ZERO markets is
//     a source ERROR (it never reads as "no series");
//   * fair(A)   = median over books of the PROPORTIONAL de-vig imp(A)/(imp(A)+imp(B));
//   * raw(A)    = median over books of the RAW implied of A (probability space),
//                 converted to American — the number the poster mirrors;
//   * fair_lo(A)= the least favourable book's fair for A;
//   * DECLINE when fewer than SERIES_MIN_BOOKS (3; per-pair SERIES_MIN_BOOKS_PAIRS
//     "rays|yankees:2") books, or the books' fairs span > SERIES_MAX_GAP_PP (3).
//
// PRICING — see priceLeg() for the exact price_pair() translation.
//
// The consensus is rebuilt at READ time from the per-source caches, so a
// source ages out of the count the moment it passes 600 s (the Python builder
// applies the same age at build time to its scrape files). The per-series
// board timestamp handed to series-window.js is the OLDEST counted source's
// fetch time — a series reopens after a final only once every book that prices
// it was read after the game ended.
// ============================================================================

const log = require('./logger');

const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== '' && process.env[k] != null ? v : d; };
const MIN_BOOKS = () => Math.max(1, Math.floor(envNum('SERIES_MIN_BOOKS', 3)));
const MAX_GAP_PP = () => envNum('SERIES_MAX_GAP_PP', 3.0);
const OVR_LO = () => envNum('SERIES_OVR_LO', 1.01);
const OVR_HI = () => envNum('SERIES_OVR_HI', 1.12);
const SRC_MAX_AGE_MS = () => envNum('SERIES_SRC_MAX_AGE_S', 600) * 1000;
const MIN_EV = () => envNum('SERIES_MIN_EV', 0.01);
const MAX_SUM = () => envNum('SERIES_MAX_SUM', 0.97);
const MAX_ASK = () => envNum('SERIES_MAX_ASK', 300);
const WORST_BOOK_CLAMP = () => process.env.SERIES_WORST_BOOK_CLAMP !== '0';
const BOVADA_TIMEOUT_MS = () => envNum('SERIES_BOVADA_TIMEOUT_MS', 15000);
const BO_DEADLINE_MS = () => envNum('BO_SERIES_DEADLINE_MS', 60000);
const WARM_DEADLINE_MS = () => envNum('MLB_SERIES_WARM_DEADLINE_MS', 240000);

/** SERIES_MIN_BOOKS_PAIRS "rays|yankees:2,braves|dodgers:2" -> {pair: n}. Read per call. */
function minBooksPairs() {
  const out = {};
  for (const it of String(process.env.SERIES_MIN_BOOKS_PAIRS || '').split(',')) {
    const i = it.lastIndexOf(':');
    if (i < 0) continue;
    const n = parseInt(it.slice(i + 1), 10);
    if (Number.isFinite(n)) out[it.slice(0, i).trim().toLowerCase()] = n;
  }
  return out;
}
function minBooksFor(pair, dflt, pairs = minBooksPairs()) {
  const v = pairs[String(pair).toLowerCase()];
  return v != null ? v : dflt;
}

// ---------------------------------------------------------------------------
// clubs + keys (mlb_futures_consensus.CLUBS/ALIAS, mlb_series_sched.team_key)
// ---------------------------------------------------------------------------
const CLUBS = new Set([
  'diamondbacks', 'braves', 'orioles', 'red sox', 'cubs', 'white sox', 'reds', 'guardians', 'rockies', 'tigers',
  'astros', 'royals', 'angels', 'dodgers', 'marlins', 'brewers', 'twins', 'mets', 'yankees', 'athletics',
  'phillies', 'pirates', 'padres', 'giants', 'mariners', 'cardinals', 'rays', 'rangers', 'blue jays', 'nationals',
]);
const ALIAS = { backs: 'diamondbacks', dbacks: 'diamondbacks', 'd backs': 'diamondbacks', s: 'athletics' };

/** PX '<Team> (Series)', BetOnline '<Nick> Series Price', DK 'NY Yankees', Bovada full names -> nickname key; '' if not a club. */
function teamKey(name) {
  let s = String(name == null ? '' : name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\s*\(\s*series\s*\)\s*$/i, '')
    .replace(/\s+series\s+price\s*$/i, '')
    .replace(/\s+to\s+win\s+series\s*$/i, '');
  const t = s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!t.length) return '';
  let k = (t[t.length - 1] === 'sox' || t[t.length - 1] === 'jays') ? t.slice(-2).join(' ') : t[t.length - 1];
  k = ALIAS[k] || k;
  return CLUBS.has(k) ? k : '';
}
/** 'braves|dodgers' — order-free; '' if either side is not a club or both are the same club. */
function pairKey(a, b) {
  const ka = teamKey(a), kb = teamKey(b);
  if (!ka || !kb || ka === kb) return '';
  return [ka, kb].sort().join('|');
}

// ---------------------------------------------------------------------------
// odds helpers (mlb_futures_consensus.ai / imp / am)
// ---------------------------------------------------------------------------
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
function ai(x) {
  const s = String(x == null ? '' : x).replace(/\u2212/g, '-').replace(/\+/g, '').trim().toUpperCase();
  if (s === 'EVEN' || s === 'EV' || s === 'PK') return 100;
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Math.trunc(Number(s));
  return Math.abs(v) >= 100 ? v : null;
}
function imp(a) {
  a = Number(a);
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}
function am(p) {
  p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return p >= 0.5 ? pyRound(-100 * p / (1 - p)) : pyRound(100 * (1 - p) / p);
}
function median(xs) {
  const a = xs.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// per-book parsers -> {pair: {keyA: american, keyB: american}}  (pure)
// ---------------------------------------------------------------------------
function _put(out, seen, pair, ka, pa, kb, pb) {
  seen[pair] = (seen[pair] || 0) + 1;
  out[pair] = { [ka]: pa, [kb]: pb };
}
function _uniq(out, seen, drops, book) {
  for (const [p, c] of Object.entries(seen)) {
    if (c !== 1 && out[p]) {
      delete out[p];
      drops.push(`${book}: ${c} markets claim ${p} -> dropped (refuse rather than guess)`);
    }
  }
  return out;
}

/** src_dk: from fetchMlbSeriesBoard().markets. ZERO markets is a source ERROR. */
function srcDk(board, drops = [], { year = new Date().getFullYear() } = {}) {
  const markets = (board && board.markets) || [];
  if (!markets.length) {
    throw new Error(`draftkings scrape captured 0 Series Winner markets (via ${board && board.via}, ${String(board && board.url).slice(0, 90)}) -- tab moved or page failed`);
  }
  const out = {}, seen = {};
  for (const m of markets) {
    const nm = String(m.name || '');
    const mt = String(m.marketType || '');
    if (mt !== 'Series Winner' && !/ - Winner$/.test(nm)) continue;
    if (!nm.includes(String(year))) { drops.push(`draftkings: ${JSON.stringify(nm.slice(0, 60))} not this season -> skipped`); continue; }
    if (m.suspended) { drops.push(`draftkings: ${JSON.stringify(nm.slice(0, 60))} suspended -> skipped`); continue; }
    const sels = (m.selections || []).filter(s => s.team);
    if (sels.length !== 2) continue;
    const ka = teamKey(sels[0].team), kb = teamKey(sels[1].team);
    const pa = ai(sels[0].odds), pb = ai(sels[1].odds);
    const pair = pairKey(sels[0].team, sels[1].team);
    if (!pair || pa == null || pb == null) {
      drops.push(`draftkings: ${JSON.stringify(nm.slice(0, 60))} unresolved (${sels[0].team}/${sels[1].team}) -> skipped`);
      continue;
    }
    _put(out, seen, pair, ka, pa, kb, pb);
  }
  return _uniq(out, seen, drops, 'draftkings');
}

/** bo-mlb-series.js page-text parse -> [{a, b, ml:{a, b}}]. */
const BO_ROT = /^\d{3,7}\s*-$/;
function boNum(s) {
  const t = String(s).replace(/\u2212/g, '-').trim();
  if (/^(EVEN|EV)$/i.test(t)) return 100;
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null;
}
function parseBoText(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(s => s !== '');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!BO_ROT.test(lines[i])) continue;
    const a = lines[i + 1], rotB = lines[i + 2], bb = lines[i + 3];
    if (!a || !BO_ROT.test(rotB || '') || !bb) continue;
    if (boNum(a) !== null || boNum(bb) !== null) continue;
    const seg = lines.slice(i + 4, i + 4 + 8);
    const mi = seg.indexOf('Moneyline');
    if (mi < 0) continue;
    const va = boNum(seg[mi + 1]), vb = boNum(seg[mi + 2]);
    if (va === null || vb === null) continue;          // no price shown = market not open
    out.push({ a, b: bb, ml: { a: va, b: vb } });
    i += 3;
  }
  return out;
}

/** src_bo: only '<Nick> Series Price' rows (the page family also lists game moneylines). */
function srcBo(board, drops = []) {
  const rows = (board && board.matchups) || [];
  if (!rows.length) throw new Error('betonline scrape found 0 priced pairings -- page moved or failed');
  const out = {}, seen = {};
  for (const r of rows) {
    const a = String(r.a || ''), b = String(r.b || ''), ml = r.ml || {};
    if (!(/series price\s*$/i.test(a) && /series price\s*$/i.test(b))) continue;
    const pa = ai(ml.a), pb = ai(ml.b);
    const pair = pairKey(a, b);
    if (!pair || pa == null || pb == null) { drops.push(`betonline: ${a} / ${b} unresolved -> skipped`); continue; }
    _put(out, seen, pair, teamKey(a), pa, teamKey(b), pb);
  }
  return _uniq(out, seen, drops, 'betonline');
}

/** src_bovada: the playoff-series coupon groups. */
function srcBovada(body, drops = []) {
  const groups = Array.isArray(body) ? body : [body];
  const out = {}, seen = {};
  for (const grp of groups) {
    if (!grp) continue;
    const path = (grp.path || []).map(p => String(p.description || '')).join(' > ');
    if (!/series prices/i.test(path) || !/playoff series/i.test(path)) continue;
    for (const ev of grp.events || []) {
      if (ev.live || !['U', 'O'].includes(String(ev.status || 'U'))) {
        drops.push(`bovada: ${JSON.stringify(String(ev.description).slice(0, 60))} live/closed -> skipped`);
        continue;
      }
      for (const dg of ev.displayGroups || []) {
        for (const m of dg.markets || []) {
          if (String(m.description || '').trim() !== 'Series Winner') continue;
          if (m.status !== 'O') { drops.push(`bovada: ${JSON.stringify(String(ev.description).slice(0, 60))} series market suspended -> skipped`); continue; }
          const oc = (m.outcomes || []).filter(o => (o.status == null ? 'O' : o.status) === 'O');
          if (oc.length !== 2) continue;
          const na = oc[0].description, nb = oc[1].description;
          const pa = ai((oc[0].price || {}).american), pb = ai((oc[1].price || {}).american);
          const pair = pairKey(na, nb);
          if (!pair || pa == null || pb == null) { drops.push(`bovada: ${na} / ${nb} unresolved -> skipped`); continue; }
          _put(out, seen, pair, teamKey(na), pa, teamKey(nb), pb);
        }
      }
    }
  }
  return _uniq(out, seen, drops, 'bovada');
}

// ---------------------------------------------------------------------------
// consensus (pure port of mlb_series_consensus.consensus)
// ---------------------------------------------------------------------------
function consensus(perBook, opts = {}) {
  const mb = opts.minBooks != null ? opts.minBooks : MIN_BOOKS();
  const mg = opts.maxGapPp != null ? opts.maxGapPp : MAX_GAP_PP();
  const lo = opts.ovrLo != null ? opts.ovrLo : OVR_LO();
  const hi = opts.ovrHi != null ? opts.ovrHi : OVR_HI();
  const mbPairs = opts.minBooksPairs || minBooksPairs();
  const pairs = [...new Set(Object.values(perBook).flatMap(bk => Object.keys(bk || {})))].sort();
  const out = {}, rej = {};
  for (const p of pairs) {
    const [ka, kb] = p.split('|');
    const used = {};
    for (const book of Object.keys(perBook).sort()) {
      const q = (perBook[book] || {})[p];
      if (!q || !(ka in q) || !(kb in q)) continue;
      const ovr = imp(q[ka]) + imp(q[kb]);
      if (!(lo <= ovr && ovr <= hi)) {
        (rej[p] = rej[p] || {})[book] = `overround ${ovr.toFixed(3)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
        continue;
      }
      used[book] = q;
    }
    const rec = { teams: [ka, kb], books: used, n: Object.keys(used).length, raw: {}, fair: {}, fair_lo: {}, gap_pp: null, decline: null };
    const qs = Object.values(used);
    if (qs.length) {
      const fa = qs.map(q => imp(q[ka]) / (imp(q[ka]) + imp(q[kb])));
      const f = median(fa);
      rec.fair = { [ka]: r6(f), [kb]: r6(1 - f) };
      rec.fair_lo = { [ka]: r6(Math.min(...fa)), [kb]: r6(Math.min(...fa.map(x => 1 - x))) };
      rec.gap_pp = Math.round(100 * (Math.max(...fa) - Math.min(...fa)) * 1000) / 1000;
      rec.raw = { [ka]: am(median(qs.map(q => imp(q[ka])))), [kb]: am(median(qs.map(q => imp(q[kb])))) };
    }
    const need = minBooksFor(p, mb, mbPairs);
    if (rec.n < need) {
      rec.decline = `only ${rec.n} book(s) (${Object.keys(used).sort().join(',') || 'none'}) < ${need}`;
    } else if (rec.gap_pp != null && rec.gap_pp > mg + 1e-9) {
      rec.decline = `books disagree by ${rec.gap_pp.toFixed(1)}pp > ${mg.toFixed(1)}pp`;
    }
    out[p] = rec;
  }
  return { series: out, rejected: rej };
}

// ---------------------------------------------------------------------------
// PRICING — mlb_series_post.price_pair() translated to ONE parlay leg.
// ---------------------------------------------------------------------------
// The order book posts an offer BACKING each side O at ask(O) = the raw mirror
// of the opposite side, -raw(X); a taker who fills it holds X at exactly the
// books' median raw price for X. In a parlay the bettor takes X and we hold O —
// the same position. So for the bettor's side X (O = the other club):
//
//   poster step                         RFQ leg (q = offered prob of X)
//   2 ask(O) = mirror -raw(X)           q = imp(raw(X))           (direct book reference)
//   4 imp(ask O) <= clamp(O),           q >= 1 - clamp(O)          clamp(O) = min(fair O, fair_lo O)
//     clamp = worst book's fair           (= the HIGHEST book fair for X)
//   5 EV(O at ask) >= MIN_EV vs median  q >= (fair X + e)/(1 + e)  (identical: our EV per $ risked)
//     fair                              q >= fair X * (1 + e)      (operator's stated floor; max of both)
//   6 pre-check: raw mirror pair sum    imp(raw X) + imp(raw O) < 2 - MAX_SUM -> DECLINE
//     > MAX_SUM -> decline              (the post-clamp ceiling cannot bind here: clamps
//                                        only raise q, which only lowers the pair sum)
//   7 ask(O) >= +MAX_ASK not quoted     am(1 - q) >= MAX_ASK -> DECLINE this side
//   invariant imp(ask O) <= clamp(O)    q >= 1 - clamp(O) re-asserted
//
// NOT carried over (ladder-only, a parlay leg has no per-leg PX ladder):
//   step 3's odds-banded rung (+1 rung margin at >= +150, none at +130..+149,
//   1-rung concession below +130) and the MINTICKS width floor (off by default).
//   The long-side hedge / fixed sides / per-side caps are position management
//   on the operator's own book, not prices.
//
// fairProb (EV / risk / exposure) = the consensus median fair of X.
function priceLeg(rec, side, opts = {}) {
  const e = opts.minEv != null ? opts.minEv : MIN_EV();
  const maxSum = opts.maxSum != null ? opts.maxSum : MAX_SUM();
  const maxAsk = opts.maxAsk != null ? opts.maxAsk : MAX_ASK();
  const worst = opts.worstBookClamp != null ? opts.worstBookClamp : WORST_BOOK_CLAMP();
  const notes = [];
  if (!rec) return { ok: false, reason: 'mlb_series_no_record' };
  if (rec.decline) return { ok: false, reason: 'mlb_series_consensus_declined', detail: rec.decline };
  const [ka, kb] = rec.teams || [];
  if (side !== ka && side !== kb) return { ok: false, reason: 'mlb_series_side_unmatched', detail: `${side} not in ${ka}|${kb}` };
  const other = side === ka ? kb : ka;
  const rawX = Number((rec.raw || {})[side]), rawO = Number((rec.raw || {})[other]);
  const fX = Number((rec.fair || {})[side]), fO = Number((rec.fair || {})[other]);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawO) || !Number.isFinite(fX) || !Number.isFinite(fO)) {
    return { ok: false, reason: 'mlb_series_record_incomplete' };
  }
  if (!(fX > 0 && fX < 1) || Math.abs(fX + fO - 1) > 1e-3) {
    return { ok: false, reason: 'mlb_series_fair_invalid', detail: `fair ${fX}/${fO} not a two-way pair` };
  }
  // clamp fair of OUR side O: never above the median; the worst book's when readable and sane
  let clampO = fO;
  if (worst && rec.fair_lo) {
    const lo = Number(rec.fair_lo[other]);
    if (lo > 0 && lo <= clampO + 1e-9) clampO = lo;
  }
  const qRawX = imp(rawX), qRawO = imp(rawO);
  const mirrorSum = (1 - qRawX) + (1 - qRawO);
  if (mirrorSum > maxSum + 1e-9) {
    return { ok: false, reason: 'mlb_series_pair_ceiling', detail: `raw mirror already ${(100 * mirrorSum).toFixed(1)}% > ${(100 * maxSum).toFixed(0)}% ceiling` };
  }
  let q = qRawX;
  let bound = 'raw_mirror';
  const floorClamp = 1 - clampO;
  if (q < floorClamp - 1e-12) { q = floorClamp; bound = clampO < fO - 1e-9 ? 'worst_book_fair' : 'median_fair'; notes.push(`raised to never-better-than-${bound} ${floorClamp.toFixed(4)}`); }
  const floorEvExact = (fX + e) / (1 + e);   // poster's EV on its stake == our EV per $ risked
  const floorEvStated = fX * (1 + e);        // operator's stated "fair x (1 + SERIES_MIN_EV)"
  const floorEv = e > 0 ? Math.max(floorEvExact, floorEvStated) : 0;
  if (q < floorEv - 1e-12) { q = floorEv; bound = 'min_ev'; notes.push(`raised to the ${(100 * e).toFixed(1)}% minimum edge ${floorEv.toFixed(4)}`); }
  if (!(q < 1)) return { ok: false, reason: 'mlb_series_price_invalid', detail: `offered ${q}` };
  const ourAsk = am(1 - q);
  if (ourAsk >= maxAsk) {
    return { ok: false, reason: 'mlb_series_longshot_side', detail: `our side ${other} would ask ${ourAsk >= 0 ? '+' : ''}${ourAsk} (>= +${maxAsk}): ${side} not quoted (house longshot rule)` };
  }
  if (q < floorClamp - 1e-9) return { ok: false, reason: 'mlb_series_invariant', detail: `offered ${q} below 1 - clamp ${floorClamp}` };
  return { ok: true, offeredProb: q, fairProb: fX, bound, ourAsk, rawAmerican: rawX, notes };
}

// ---------------------------------------------------------------------------
// sources: cache + warm (background only — never on the RFQ hot path)
// ---------------------------------------------------------------------------
const BOOKS = ['draftkings', 'betonline', 'bovada'];
const _src = {};          // book -> { at, pairs, drops, error, errorAt, meta }
for (const b of BOOKS) _src[b] = { at: 0, pairs: null, drops: [], error: null, errorAt: null, meta: null };
let _inflight = null;
let _lastWarm = null;     // { startedAt, finishedAt, ms }

function _record(book, fn, raw, meta) {
  const drops = [];
  try {
    const pairs = fn(raw, drops);
    _src[book] = { at: Date.now(), pairs, drops, error: null, errorAt: null, meta };
  } catch (err) {
    // A ZERO-market scrape is an error AND clears the book (the Python
    // scrapers rewrite their file empty, so the book drops out immediately).
    _src[book] = { at: 0, pairs: null, drops, error: err.message, errorAt: Date.now(), meta };
  }
}
function _fail(book, err) {
  // Launch / network / timeout failure: keep the last good read; it ages out
  // of the count at SERIES_SRC_MAX_AGE_S (a failed scrape leaves the old file).
  _src[book] = Object.assign({}, _src[book], { error: String((err && err.message) || err).slice(0, 200), errorAt: Date.now() });
}

const BOV_URLS = [
  'https://www.bovada.lv/services/sports/event/coupon/events/A/description/baseball/mlb-playoff-series?marketFilterId=def&preMatchOnly=true&lang=en',
  'https://www.bovada.lv/services/sports/event/coupon/events/A/description/baseball?marketFilterId=def&preMatchOnly=true&lang=en',
];
let _fetch;
function fetchFn() {
  if (!_fetch) _fetch = global.fetch ? global.fetch.bind(global) : require('node-fetch');
  return _fetch;
}
async function fetchBovada() {
  let last = null;
  for (const u of BOV_URLS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BOVADA_TIMEOUT_MS());
    try {
      const r = await fetchFn()(u, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.bovada.lv/sports',
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      last = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`bovada unreadable: ${String(last && last.message).slice(0, 100)}`);
}

/** bo-mlb-series.js, through dk-scraper's browser-slot governor. */
async function fetchBetOnline() {
  const dk = require('./dk-scraper');
  const url = process.env.BO_SERIES_URL || 'https://www.betonline.ag/sportsbook/baseball/mlb-series';
  const browser = await dk.launchBrowser({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; browser.close().catch(() => {}); }, BO_DEADLINE_MS());
  let text = '';
  try {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');
    await p.setViewport({ width: 1600, height: 1200 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 8000));
    for (let i = 0; i < 10; i++) { await p.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await new Promise(r => setTimeout(r, 500)); }
    text = await p.evaluate(() => document.body.innerText);
  } catch (err) {
    if (timedOut) throw new Error(`betonline deadline ${BO_DEADLINE_MS()}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
  }
  return { url, scrapedAt: new Date().toISOString(), matchups: parseBoText(text) };
}

function _withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** One refresh of all three sources. Single-flight; always resolves. */
async function warm() {
  if (_inflight) return _inflight;
  const startedAt = Date.now();
  const deadline = WARM_DEADLINE_MS();
  _inflight = (async () => {
    const dk = require('./dk-scraper');
    const bov = _withTimeout(fetchBovada(), deadline, 'bovada')
      .then(body => _record('bovada', srcBovada, body, null), err => _fail('bovada', err));
    // DK then BetOnline (the browser governor serializes them anyway).
    const chrome = (async () => {
      await _withTimeout(dk.fetchMlbSeriesBoard(), deadline, 'draftkings')
        .then(board => _record('draftkings', srcDk, board, { via: board.via, url: board.url, timedOut: board.timedOut, markets: (board.markets || []).length }),
          err => _fail('draftkings', err));
      await _withTimeout(fetchBetOnline(), deadline, 'betonline')
        .then(board => _record('betonline', srcBo, board, { url: board.url, matchups: (board.matchups || []).length }),
          err => _fail('betonline', err));
    })();
    await Promise.all([bov, chrome]);
    _lastWarm = { startedAt: new Date(startedAt).toISOString(), ms: Date.now() - startedAt };
    const c = getConsensus();
    const n = Object.keys(c.series).length;
    const ok = Object.values(c.series).filter(r => !r.decline).length;
    log.info('MlbSeries', `Consensus: ${n} series, ${ok} priceable; books ${BOOKS.map(b => `${b}=${_src[b].pairs ? Object.keys(_src[b].pairs).length : 'ERR'}`).join(' ')} (${_lastWarm.ms}ms)`
      + (BOOKS.some(b => _src[b].error) ? ` errors: ${BOOKS.filter(b => _src[b].error).map(b => `${b}: ${_src[b].error}`).join(' | ')}` : ''));
    return c;
  })().catch(err => { log.warn('MlbSeries', `warm failed: ${err.message}`); return getConsensus(); })
    .finally(() => { _inflight = null; });
  return _inflight;
}

// ---------------------------------------------------------------------------
// read side (sync)
// ---------------------------------------------------------------------------
/** Consensus over the sources still inside SERIES_SRC_MAX_AGE_S at `now`. */
function getConsensus(now = Date.now()) {
  const maxAge = SRC_MAX_AGE_MS();
  const perBook = {}, ages = {};
  for (const b of BOOKS) {
    const s = _src[b];
    if (s.pairs && s.at && now - s.at <= maxAge) { perBook[b] = s.pairs; ages[b] = s.at; }
  }
  const { series, rejected } = consensus(perBook);
  for (const rec of Object.values(series)) {
    const ats = Object.keys(rec.books).map(b => ages[b]).filter(Number.isFinite);
    rec.boardAtMs = ats.length ? Math.min(...ats) : null;
  }
  return { series, rejected, booksRead: Object.keys(perBook).sort() };
}

/** Resolve a PX series line to its consensus record + side, matchup-scoped. */
function _resolve(lineInfo, now) {
  const pk = pairKey(lineInfo && lineInfo.homeTeam, lineInfo && lineInfo.awayTeam);
  if (!pk) return { error: 'mlb_series_pair_unresolved', detail: `${lineInfo && lineInfo.homeTeam} / ${lineInfo && lineInfo.awayTeam}` };
  const side = teamKey(lineInfo.teamName);
  if (!side || !pk.split('|').includes(side)) return { error: 'mlb_series_side_unmatched', detail: `${lineInfo.teamName} not in ${pk}` };
  const rec = getConsensus(now).series[pk] || null;
  return { pk, side, rec };
}

/** Per-series board time (oldest counted source) — null when nothing prices it. */
function getBoardAtMs(lineInfo, now = Date.now()) {
  const r = _resolve(lineInfo, now);
  return r.rec ? r.rec.boardAtMs : null;
}

/** {ok, fairProb, bookPriceOverride, basis, ...} or {ok:false, reason, detail}. */
function getQuoteForLine(lineInfo, now = Date.now()) {
  const r = _resolve(lineInfo, now);
  if (r.error) return { ok: false, reason: r.error, detail: r.detail };
  if (!r.rec) return { ok: false, reason: 'mlb_series_no_record', detail: `no fresh consensus for ${r.pk}` };
  const q = priceLeg(r.rec, r.side);
  if (!q.ok) return Object.assign({ pair: r.pk, side: r.side }, q);
  return {
    ok: true, pair: r.pk, side: r.side,
    fairProb: q.fairProb, bookPriceOverride: q.offeredProb, basis: 'mlb_series_consensus',
    bound: q.bound, books: r.rec.n, rawAmerican: q.rawAmerican, boardAtMs: r.rec.boardAtMs,
  };
}

function getStatus(now = Date.now()) {
  const c = getConsensus(now);
  const series = {};
  for (const [p, rec] of Object.entries(c.series)) {
    const quotes = {};
    for (const k of rec.teams) {
      const q = priceLeg(rec, k);
      quotes[k] = q.ok
        ? { offeredProb: r6(q.offeredProb), offeredAmerican: am(q.offeredProb), bound: q.bound }
        : { declined: q.reason, detail: q.detail || null };
    }
    series[p] = {
      books: rec.books, n: rec.n, fair: rec.fair, raw: rec.raw, fair_lo: rec.fair_lo, gap_pp: rec.gap_pp,
      decline: rec.decline, rejected: c.rejected[p] || null,
      ageSec: rec.boardAtMs ? Math.round((now - rec.boardAtMs) / 1000) : null,
      rfqQuote: quotes,
    };
  }
  const sources = {};
  for (const b of BOOKS) {
    const s = _src[b];
    sources[b] = {
      ageSec: s.at ? Math.round((now - s.at) / 1000) : null,
      counted: c.booksRead.includes(b),
      pairs: s.pairs ? Object.keys(s.pairs) : null,
      error: s.error, errorAgeSec: s.errorAt ? Math.round((now - s.errorAt) / 1000) : null,
      drops: s.drops && s.drops.length ? s.drops.slice(0, 10) : undefined,
      meta: s.meta || undefined,
    };
  }
  return {
    method: 'order-book consensus (DK + BetOnline + Bovada; median proportional de-vig fair; offered = median raw implied, clamped)',
    minBooks: MIN_BOOKS(), minBooksPairs: minBooksPairs(), maxGapPp: MAX_GAP_PP(), srcMaxAgeSec: SRC_MAX_AGE_MS() / 1000,
    minEv: MIN_EV(), maxSum: MAX_SUM(), maxAsk: MAX_ASK(),
    warming: !!_inflight, lastWarm: _lastWarm, sources, series,
  };
}

// test seams
function __setSourceForTest(book, pairs, at = Date.now()) {
  _src[book] = { at: pairs ? at : 0, pairs: pairs || null, drops: [], error: null, errorAt: null, meta: null };
}
function __resetForTest() {
  for (const b of BOOKS) __setSourceForTest(b, null);
  _inflight = null;
  _lastWarm = null;
}
function __recordForTest(book, raw, at) {
  const fn = { draftkings: srcDk, betonline: srcBo, bovada: srcBovada }[book];
  _record(book, fn, raw, null);
  if (at != null && _src[book].pairs) _src[book].at = at;
  return _src[book];
}

module.exports = {
  // keys + odds
  teamKey, pairKey, ai, imp, am, median,
  // parsers
  srcDk, srcBo, srcBovada, parseBoText,
  // rules
  consensus, priceLeg, minBooksFor, minBooksPairs,
  // cache
  warm, getConsensus, getQuoteForLine, getBoardAtMs, getStatus,
  BOOKS,
  __setSourceForTest, __resetForTest, __recordForTest,
};
