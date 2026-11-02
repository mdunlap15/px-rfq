// US 2026 ELECTION RACES as parlay legs (operator 2026-11-02: "offer for parlays our
// lines for Elections that we are using in the PX order book. Use the same
// methodologies and monitoring we are using there.").
//
// A port of the order book's poster-service/election_cycle.py. Reference only,
// never run from here.
//  * RACES: data/election-race-map.json. It is a copy of the poster's race_map.json:
//    each PX race event joined to ONE Kalshi event and ONE Polymarket event by
//    exact candidate name, two-candidate races only.
//  * FAIR for candidate A (the map's first candidate) = the mean of the Kalshi mid
//    and the Polymarket mid. DECLINE unless both venues are readable, each spread
//    <= MAX_SPREAD, the venues agree within MAX_GAP, the two Kalshi candidates sum
//    to 0.95..1.05, and the fair is inside [FAIR_MIN, FAIR_MAX].
//  * PRICE: the poster backs a side at the most generous ladder price carrying
//    >= MIN_EV against the fair. A parlay leg has no ladder. The bettor takes X,
//    we hold the other side, so the leg offers q = (fair X + e)/(1 + e), which is
//    exactly EV e per $ we risk (the MLB-series translation).
//  * GUARD (polled every POLL_SEC, the poster's 5 s cadence):
//      - steam: the fair moved >= STEAM_PP inside STEAM_WIN_S -> race dark STEAM_HOLD_S;
//      - fill hold: our confirmed risk on the race grew -> race dark HOLD_S;
//      - a fair read older than MAX_AGE_SEC is unpriceable.
//    Every RFQ and confirm reprice reads the current state, so a race that would
//    make the poster cancel stops quoting here at the same instant.
//  * TAKEDOWN at STOP_UTC (2026-11-03 22:00Z, before exit polls / first poll close),
//    the poster's ELEC_STOP_UTC: lines stop registering and every leg declines.
//    PX's scheduled date is 11/10, so no start guard does this.
//  * One election leg per parlay: races are correlated through the national
//    environment and independent multiplication would underprice a stack of them.
//
// Leg mapping: fair A = P(candidate A wins). YES on A = fA, NO on A = 1 - fA,
// YES on B = 1 - fA, NO on B = fA. B's market is the same bet as A's, so it
// registers with the same fair.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const E = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => { const v = parseFloat(E(k, '')); return Number.isFinite(v) ? v : d; };

function cfg() {
  return {
    enabled: String(E('ELEC_RFQ_ENABLED', 'true')).toLowerCase() !== 'false',
    stopMs: Date.parse(E('ELEC_STOP_UTC', '2026-11-03T22:00:00Z')),
    minEv: num('ELEC_MIN_EV', 0.025),
    maxSpread: num('ELEC_MAX_SPREAD', 0.03),
    maxGap: num('ELEC_MAX_GAP', 0.02),
    fairMin: num('ELEC_FAIR_MIN', 0.10),
    fairMax: num('ELEC_FAIR_MAX', 0.90),
    steamPp: num('ELEC_STEAM_PP', 0.03),
    steamWinS: num('ELEC_STEAM_WIN_S', 180),
    steamHoldS: num('ELEC_STEAM_HOLD_S', 300),
    holdS: num('ELEC_FILL_HOLD_S', 180),
    pollSec: Math.max(2, num('ELEC_RFQ_POLL_SEC', 5)),
    maxAgeSec: num('ELEC_RFQ_MAX_AGE_SEC', 30),
    maxRiskPerParlay: num('ELEC_RFQ_MAX_RISK', 1000),
    longRisk: num('ELEC_RFQ_LONG_RISK', 500),
    maxRaceRisk: num('ELEC_RFQ_MAX_RACE_RISK', 2000),
    timeoutMs: num('ELEC_RFQ_TIMEOUT_MS', 6000),
  };
}

let _map = null;
let _mapPath = path.join(__dirname, '..', 'data', 'election-race-map.json');
function _loadMap() {
  if (_map) return _map;
  const byEid = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(_mapPath, 'utf8'));
    for (const r of (raw.races || raw)) {
      if (!r || r.why || !Array.isArray(r.cands) || r.cands.length !== 2) continue;
      byEid.set(String(r.eid), r);
    }
  } catch (err) {
    log.warn('Election', `race map unreadable (${err.message}) — no election lines`);
  }
  _map = byEid;
  return _map;
}

// ---- state (per race eid) ----
const _state = {
  fairs: new Map(),     // eid -> {fair, why, det, at}
  hist: new Map(),      // eid -> [[ms, fair]]
  hold: new Map(),      // eid -> {until, why}
  riskSeen: new Map(),  // eid -> confirmed risk last seen
  lastPoll: null, lastOk: null, lastErr: null, polls: 0,
};

function enabled() { return cfg().enabled; }
function isStopped(nowMs = Date.now()) { const s = cfg().stopMs; return Number.isFinite(s) ? nowMs >= s : true; }
function isElectionLine(li) { return !!(li && li.sport === 'politics' && li.marketType === 'election_winner'); }

function isMappedRace(eventId) { return _loadMap().has(String(eventId)); }

/** Map lookup for a PX event + market name -> {race, idx} or null. */
function candidateFor(eventId, marketName) {
  const r = _loadMap().get(String(eventId));
  if (!r) return null;
  const nm = String(marketName || '').trim();
  const idx = r.cands.findIndex(c => c.px_name === nm);
  return idx >= 0 ? { race: r, idx } : null;
}

/** Registration gate (seed, cache restore). Returns null = allowed, else the reason. */
function registrationRefusal(info, nowMs = Date.now()) {
  if (!enabled()) return 'election_disabled';
  if (isStopped(nowMs)) return 'election_stopped';
  if (!info || !candidateFor(info.pxEventId, info.marketName)) return 'election_race_unmapped';
  if (info.selection !== 'yes' && info.selection !== 'no') return 'election_side_unknown';
  return null;
}

// ---- venue reads (the poster's fetch_venues) ----
let _fetch = null;
async function _jget(url, timeoutMs) {
  if (!_fetch) _fetch = global.fetch ? global.fetch.bind(global) : require('node-fetch');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await _fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchVenues(races, opts = {}) {
  const get = opts.jget || (u => _jget(u, cfg().timeoutMs));
  const kt = []; const pid = [];
  for (const r of races) for (const c of r.cands) { kt.push(c.kalshi); pid.push(String(c.poly_id)); }
  const K = {}; const P = {};
  for (let i = 0; i < kt.length; i += 50) {
    const d = await get('https://api.elections.kalshi.com/trade-api/v2/markets?tickers=' + kt.slice(i, i + 50).join(','));
    for (const m of (d && d.markets) || []) {
      if (m.status !== 'active') continue;
      const b = parseFloat(m.yes_bid_dollars), a = parseFloat(m.yes_ask_dollars);
      if (b > 0 && b <= a && a < 1) K[m.ticker] = [b, a];
    }
  }
  for (let i = 0; i < pid.length; i += 40) {
    const q = pid.slice(i, i + 40).map(x => 'id=' + x).join('&');
    const d = await get('https://gamma-api.polymarket.com/markets?limit=100&' + q);
    for (const m of (Array.isArray(d) ? d : [])) {
      if (m.closed || !m.active) continue;
      const b = parseFloat(m.bestBid), a = parseFloat(m.bestAsk);
      if (b > 0 && b <= a && a < 1) P[String(m.id)] = [b, a];
    }
  }
  return { K, P };
}

/** The poster's race_fair: -> {fair, det, why}. why null = quotable. */
function raceFair(r, K, P, c = cfg()) {
  const A = r.cands[0], B = r.cands[1];
  const ka = K[A.kalshi], kb = K[B.kalshi], pa = P[String(A.poly_id)];
  if (!ka || !kb) return { fair: null, det: null, why: 'kalshi unreadable' };
  if (!pa) return { fair: null, det: null, why: 'polymarket unreadable' };
  const km = (ka[0] + ka[1]) / 2, kbm = (kb[0] + kb[1]) / 2, pm = (pa[0] + pa[1]) / 2;
  const det = { k: ka, p: pa, km, pm };
  if (ka[1] - ka[0] > c.maxSpread + 1e-9) return { fair: null, det, why: `kalshi spread ${(ka[1] - ka[0]).toFixed(3)}` };
  if (pa[1] - pa[0] > c.maxSpread + 1e-9) return { fair: null, det, why: `polymarket spread ${(pa[1] - pa[0]).toFixed(3)}` };
  if (Math.abs(km - pm) > c.maxGap + 1e-9) return { fair: null, det, why: `venues disagree ${(100 * Math.abs(km - pm)).toFixed(1)}pp` };
  if (!(km + kbm >= 0.95 && km + kbm <= 1.05)) return { fair: null, det, why: `kalshi pair sums ${(km + kbm).toFixed(3)}` };
  const f = (km + pm) / 2;
  if (!(f >= c.fairMin && f <= c.fairMax)) return { fair: f, det, why: `fair ${(100 * f).toFixed(1)}% outside window` };
  return { fair: f, det, why: null };
}

function _riskByRace() {
  try { return require('./order-tracker').getElectionRiskByRace() || {}; } catch (_) { return {}; }
}

/** Apply one venue read to state: fairs, steam holds, fill holds. Exported for tests. */
function applyRead(K, P, nowMs = Date.now()) {
  const c = cfg();
  const risk = _riskByRace();   // one pass over the book per poll, not one per race
  for (const [eid, r] of _loadMap()) {
    const rf = raceFair(r, K, P, c);
    _state.fairs.set(eid, { ...rf, at: nowMs });
    if (rf.fair != null) {
      const h = (_state.hist.get(eid) || []).filter(x => nowMs - x[0] <= c.steamWinS * 1000);
      h.push([nowMs, rf.fair]);
      _state.hist.set(eid, h);
      let lo = Infinity, hi = -Infinity;
      for (const x of h) { if (x[1] < lo) lo = x[1]; if (x[1] > hi) hi = x[1]; }
      const held = _state.hold.get(eid);
      if (hi - lo >= c.steamPp - 1e-9 && !(held && held.until > nowMs)) {
        _state.hold.set(eid, { until: nowMs + c.steamHoldS * 1000, why: `steam ${(100 * (hi - lo)).toFixed(1)}pp` });
        log.info('Election', `STEAM HOLD ${eid} ${r.name}: fair moved ${(100 * (hi - lo)).toFixed(1)}pp -> dark ${c.steamHoldS}s`);
      }
    }
    noteRisk(eid, risk[eid] || 0, nowMs);
  }
}

/** Fill hold: confirmed risk on the race grew since the last look. */
function noteRisk(eid, risk, nowMs = Date.now()) {
  eid = String(eid);
  const prev = _state.riskSeen.get(eid);
  if (prev != null && risk > prev + 0.5) {
    const c = cfg();
    _state.hold.set(eid, { until: nowMs + c.holdS * 1000, why: `fill $${Math.round(risk - prev)}` });
    log.info('Election', `FILL HOLD ${eid}: risk $${Math.round(prev)} -> $${Math.round(risk)} -> dark ${c.holdS}s`);
  }
  _state.riskSeen.set(eid, risk);
}

/**
 * Price one leg -> {ok:true, fairProb, bookPriceOverride, basis} or {ok:false, reason, detail}.
 * Sync cache read on the RFQ / confirm path.
 */
function getElectionQuote(li, nowMs = Date.now()) {
  const c = cfg();
  if (!enabled()) return { ok: false, reason: 'election_disabled' };
  if (isStopped(nowMs)) return { ok: false, reason: 'election_stopped', detail: 'past ELEC_STOP_UTC' };
  const hit = candidateFor(li && li.pxEventId, li && li.marketName);
  if (!hit) return { ok: false, reason: 'election_race_unmapped' };
  const eid = String(hit.race.eid);
  const held = _state.hold.get(eid);
  if (held && held.until > nowMs) return { ok: false, reason: 'election_hold', detail: held.why };
  const st = _state.fairs.get(eid);
  if (!st) return { ok: false, reason: 'election_no_read' };
  if ((nowMs - st.at) / 1000 > c.maxAgeSec) return { ok: false, reason: 'election_stale', detail: `${Math.round((nowMs - st.at) / 1000)}s old` };
  if (st.why) return { ok: false, reason: 'election_declined', detail: st.why };
  const fA = st.fair;
  const aSide = hit.idx === 0 ? li.selection === 'yes' : li.selection === 'no';
  const f = aSide ? fA : 1 - fA;
  const e = c.minEv;
  const q = (f + e) / (1 + e);
  if (!(q > 0 && q < 1)) return { ok: false, reason: 'election_price_invalid' };
  return { ok: true, fairProb: f, bookPriceOverride: q, basis: { source: 'kalshi_polymarket_mid', km: st.det.km, pm: st.det.pm, ageSec: Math.round((nowMs - st.at) / 1000) } };
}

// ---- poll loop ----
let _timer = null; let _inflight = false;
async function pollOnce() {
  if (_inflight) return;
  if (!enabled() || isStopped()) return;
  const races = [..._loadMap().values()];
  if (!races.length) return;
  _inflight = true;
  _state.lastPoll = Date.now();
  try {
    const { K, P } = await fetchVenues(races);
    applyRead(K, P, Date.now());
    _state.lastOk = Date.now(); _state.polls++;
  } catch (err) {
    _state.lastErr = `${new Date().toISOString()} ${err.message}`;
    log.warn('Election', `venue read failed: ${err.message}`);
  } finally { _inflight = false; }
}

function start() {
  if (_timer || !enabled()) return;
  pollOnce().catch(() => {});
  _timer = setInterval(() => { pollOnce().catch(() => {}); }, cfg().pollSec * 1000);
  if (_timer.unref) _timer.unref();
  log.info('Election', `election RFQ poller started (${_loadMap().size} races, every ${cfg().pollSec}s, stop ${new Date(cfg().stopMs).toISOString()})`);
}

function getStatus(nowMs = Date.now()) {
  const c = cfg();
  const races = [];
  for (const [eid, r] of _loadMap()) {
    const st = _state.fairs.get(eid); const h = _state.hold.get(eid);
    races.push({
      eid, name: r.name, candA: r.cands[0].px_name,
      fairA: st && st.fair != null ? Math.round(st.fair * 10000) / 10000 : null,
      why: st ? st.why : 'no read', ageSec: st ? Math.round((nowMs - st.at) / 1000) : null,
      hold: h && h.until > nowMs ? { why: h.why, secLeft: Math.round((h.until - nowMs) / 1000) } : null,
      risk: Math.round(_state.riskSeen.get(eid) || 0),
    });
  }
  const quotable = races.filter(r => !r.why && !r.hold && r.ageSec != null && r.ageSec <= c.maxAgeSec).length;
  return {
    enabled: c.enabled, stopped: isStopped(nowMs), stopUtc: new Date(c.stopMs).toISOString(),
    races: races.length, quotable, polls: _state.polls,
    lastOk: _state.lastOk ? new Date(_state.lastOk).toISOString() : null, lastErr: _state.lastErr,
    knobs: { minEv: c.minEv, maxSpread: c.maxSpread, maxGap: c.maxGap, fairMin: c.fairMin, fairMax: c.fairMax, steamPp: c.steamPp, holdS: c.holdS, maxAgeSec: c.maxAgeSec, maxRiskPerParlay: c.maxRiskPerParlay, maxRaceRisk: c.maxRaceRisk },
    detail: races,
  };
}

function _resetForTest(mapPath) {
  _map = null; if (mapPath) _mapPath = mapPath;
  _state.fairs.clear(); _state.hist.clear(); _state.hold.clear(); _state.riskSeen.clear();
}

module.exports = {
  enabled, isStopped, isElectionLine, isMappedRace, candidateFor, registrationRefusal,
  fetchVenues, raceFair, applyRead, noteRisk, getElectionQuote, pollOnce, start, getStatus, cfg,
  _resetForTest,
};
