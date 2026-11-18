// ============================================================================
// manual-offers.js — the ONE copy of the manual order-book write routes
//   POST /admin/offers/place   POST /admin/offers/cancel
// (2026-11-19, moved verbatim out of index.js so the isolated placement front,
// place-front.js, and index.js run the same validation / headroom / placement
// code. index.js still mounts these handlers when PLACE_FRONT is off.)
//
// Behaviour is the index.js route bodies of 2026-11-18, unchanged, with two
// deliberate differences:
//   1. PACING. The old route slept MANUAL_PACE_MS (700 ms) unconditionally
//      before EVERY batch, including the first. Now the FIRST PX order call of a
//      request waits only until MANUAL_PACE_MS has passed since this process's
//      last PX order call (and since any concurrent request's reserved slot);
//      every LATER batch / cancel in the same request still sleeps the full
//      MANUAL_PACE_MS first, exactly as before. Concurrent requests are now
//      spaced (one slot reserved per call) instead of both firing together.
//   2. The odds-ladder read and the balance read run concurrently, but ONLY
//      while px-single already holds a token younger than 22 h (so two
//      concurrent reads can never trigger two /auth/login calls -- the
//      session-cap hazard). Error priority is unchanged: a ladder failure is
//      reported first, then off-ladder odds, then a balance failure.
// Plus: per-request timing (log line + a 200-entry ring for front-stats).
// ============================================================================

'use strict';

const PACE_DEFAULT_MS = 700;

function _pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(list) {
  const t = list.map(x => x.total_ms).sort((a, b) => a - b);
  return { n: t.length, p50_ms: _pct(t, 50), p90_ms: _pct(t, 90), max_ms: t.length ? t[t.length - 1] : null };
}

/**
 * @param {object} [opts]
 * @param {object}   [opts.log]      logger with info/warn/error (default ./logger)
 * @param {Function} [opts.loadPxs]  () => px-single module (default lazy require)
 * @param {object}   [opts.env]      environment (default process.env)
 * @param {Function} [opts.now]      () => ms clock (default Date.now)
 * @param {Function} [opts.sleep]    ms => Promise (default setTimeout)
 */
function createManualOffers(opts = {}) {
  const log = opts.log || require('./logger');
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const _msleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const loadPxs = opts.loadPxs || (() => require('./px-single'));

  const MANUAL_OFFER_MAX_STAKE = Number(env.MANUAL_OFFER_MAX_STAKE || 25000);
  const MANUAL_OFFERS_MAX_PER_REQ = 1000;
  const MANUAL_PACE_MS = Number(env.MANUAL_PACE_MS || PACE_DEFAULT_MS); // PX order endpoints cap ~2 req/s

  // px-single is lazy-required so a missing dep can't crash boot. (2026-06-16)
  let _manualPxs = null;
  function _manualPxsGuard(res) {
    if (!_manualPxs) {
      try { _manualPxs = loadPxs(); }
      catch (e) { res.status(500).json({ ok: false, error: 'px-single unavailable: ' + e.message }); return null; }
    }
    return _manualPxs;
  }

  // ---------------------------------------------------------------------
  // Pacer: one process-wide clock for PX ORDER calls (place / cancel).
  //   lastDoneAt  — when the last PX order call returned (ok or error)
  //   reservedAt  — earliest start for the next caller (a concurrent request
  //                 that already took a slot pushes this forward)
  // first=true  : wait until max(now, lastDoneAt + PACE, reservedAt)
  // first=false : additionally at least PACE from now (the old unconditional
  //               pre-batch sleep, kept for every later batch of a request)
  // ---------------------------------------------------------------------
  let lastDoneAt = 0;
  let reservedAt = 0;
  async function waitTurn(first) {
    const t = now();
    let start = Math.max(t, lastDoneAt + MANUAL_PACE_MS, reservedAt);
    if (!first) start = Math.max(start, t + MANUAL_PACE_MS);
    reservedAt = start + MANUAL_PACE_MS;
    const wait = start - t;
    if (wait > 0) await _msleep(wait);
    return wait;
  }
  function markDone() { lastDoneAt = Math.max(lastDoneAt, now()); }

  // Only overlap the ladder + balance reads when px-single provably holds a
  // fresh token, so the two reads cannot both call /auth/login.
  function _canParallel(pxs) {
    try {
      if (typeof pxs._tokenCache !== 'function') return false;
      const tc = pxs._tokenCache();
      return !!(tc && tc.token && Number.isFinite(tc.time) && (now() - tc.time) < 22 * 60 * 60 * 1000);
    } catch (_) { return false; }
  }

  // Ring of the last 200 place requests (front-stats).
  const RING = 200;
  const ring = [];
  let inflight = 0;
  function record(entry) { ring.push(entry); if (ring.length > RING) ring.shift(); }

  // POST /admin/offers/place
  //   body: { offers: [{ line_id, odds, stake, external_id }, ...], dryRun?: bool }
  // Guards (fat-finger + shared-cap protection for the live money account):
  //   shape/type validation, per-offer stake cap, odds must be a real ladder
  //   rung, and a balance pre-flight that refuses to post more unmatched stake
  //   than the account's 50x-cash headroom (PX resting-volume cap; shared with the parlay quoter).
  async function place(req, res) {
    const t0 = now();
    const tm = { bal_ms: null, place_ms: null, first_wait_ms: null };
    const send = (code, body) => (code === 200 ? res.json(body) : res.status(code).json(body));
    inflight++;
    try {
      return await _place(req, res, send, tm);
    } finally {
      inflight--;
      const status = res.statusCode;
      const total = now() - t0;
      const dryRun = !!(req.body && req.body.dryRun);
      const n = (req.body && Array.isArray(req.body.offers)) ? req.body.offers.length : 0;
      record({ at: new Date(t0).toISOString(), total_ms: total, bal_ms: tm.bal_ms, place_ms: tm.place_ms,
        first_wait_ms: tm.first_wait_ms, offers: n, dryRun, status });
      try {
        log.info('ManualOffers', `timing status=${status} offers=${n} dryRun=${dryRun} balance_ms=${tm.bal_ms} place_ms=${tm.place_ms} first_wait_ms=${tm.first_wait_ms} total_ms=${total}`);
      } catch (_) { /* logging never breaks a placement */ }
    }
  }

  async function _place(req, res, send, tm) {
    const pxs = _manualPxsGuard(res); if (!pxs) return;
    const offers = (req.body && Array.isArray(req.body.offers)) ? req.body.offers : null;
    const dryRun = !!(req.body && req.body.dryRun);
    if (!offers || offers.length === 0) return send(400, { ok: false, error: 'body.offers must be a non-empty array' });
    if (offers.length > MANUAL_OFFERS_MAX_PER_REQ) return send(400, { ok: false, error: `too many offers (${offers.length} > ${MANUAL_OFFERS_MAX_PER_REQ})` });
    const errs = []; const seen = new Set();
    offers.forEach((o, i) => {
      if (!o || typeof o.line_id !== 'string' || !o.line_id) errs.push(`offer[${i}]: missing line_id`);
      if (!Number.isInteger(o && o.odds)) errs.push(`offer[${i}]: odds must be an integer`);
      if (!(Number.isFinite(o && o.stake) && o.stake > 0)) errs.push(`offer[${i}]: stake must be > 0`);
      else if (o.stake > MANUAL_OFFER_MAX_STAKE) errs.push(`offer[${i}]: stake ${o.stake} > cap ${MANUAL_OFFER_MAX_STAKE}`);
      if (o && o.order_strategy != null && !['ALO', 'fillOrKill'].includes(o.order_strategy)) errs.push(`offer[${i}]: order_strategy must be ALO or fillOrKill`);
      if (!o || typeof o.external_id !== 'string' || !o.external_id) errs.push(`offer[${i}]: missing external_id`);
      else if (seen.has(o.external_id)) errs.push(`offer[${i}]: duplicate external_id`);
      else seen.add(o.external_id);
    });
    if (errs.length) return send(400, { ok: false, error: 'validation failed', details: errs.slice(0, 25) });
    try {
      const tb = now();
      let ladder; let bal;
      if (_canParallel(pxs)) {
        const [lr, br] = await Promise.allSettled([pxs.fetchOddsLadder(), pxs.fetchBalance()]);
        if (lr.status === 'rejected') throw lr.reason;
        ladder = lr.value;
        const lset = new Set(ladder);
        const off = offers.filter(o => !lset.has(o.odds)).map(o => ({ external_id: o.external_id, odds: o.odds }));
        if (off.length) { tm.bal_ms = now() - tb; return send(400, { ok: false, error: 'off-ladder odds', details: off.slice(0, 25) }); }
        if (br.status === 'rejected') throw br.reason;
        bal = br.value;
      } else {
        ladder = await pxs.fetchOddsLadder();
        const lset = new Set(ladder);
        const off = offers.filter(o => !lset.has(o.odds)).map(o => ({ external_id: o.external_id, odds: o.odds }));
        if (off.length) { tm.bal_ms = now() - tb; return send(400, { ok: false, error: 'off-ladder odds', details: off.slice(0, 25) }); }
        bal = await pxs.fetchBalance();
      }
      tm.bal_ms = now() - tb;
      const cash = Number(bal.balance || 0);
      // CFTC rename tolerance: wager -> order. Reading only the legacy key
      // would silently yield 0 unmatched under the new vocabulary, which makes
      // headroom look MAXIMAL and breaks this cap OPEN.
      const unmatched = Number(bal.unmatched_wager_balance ?? bal.unmatched_order_balance ?? 0);
      const totalStake = offers.reduce((s, o) => s + o.stake, 0);
      // Resting-volume cap multiplier. Default 50 (legacy). The CFTC merge
      // introduced an account-wide ~10x unmatched-stake cap — set
      // PX_RESTING_CAP_MULT=10 (confirm the exact value with PX/Alec) to enforce
      // it; kept at 50 here so this change is behavior-neutral until confirmed.
      const restingMult = Number(env.PX_RESTING_CAP_MULT) || 50;
      const headroom = cash * restingMult - unmatched;
      if (cash <= 0) return send(409, { ok: false, error: 'account balance is 0 — offers would be invalidated', balance: bal });
      // Staleness guard: the post-merge balance shape flags when the unmatched
      // figure isn't freshly synced. A stale (lower) unmatched makes headroom
      // look too generous → an over-post PX would then cap/invalidate. Refuse
      // unless the unmatched balance is freshly synced.
      // Same rename, and FAIL CLOSED on absence. Previously a missing status
      // key skipped the freshness guard entirely: under the CFTC vocabulary
      // (or any shape change) `unmatched` reads 0, headroom reads maximal, and
      // the one check that would have caught it is itself skipped.
      const unmatchedStatus = bal.unmatched_wager_balance_status ?? bal.unmatched_order_balance_status;
      if (unmatchedStatus == null) {
        return send(409, { ok: false, error: 'unmatched balance status absent under BOTH legacy and CFTC keys — refusing to compute headroom', balance: bal });
      }
      if (unmatchedStatus !== 'succeed') {
        return send(409, { ok: false, error: `unmatched balance not fresh (status=${unmatchedStatus}) — refusing to compute headroom`, balance: bal });
      }
      if (totalStake > headroom) return send(409, { ok: false, error: `total stake ${totalStake} exceeds headroom ${headroom}`, balance: { cash, unmatched, headroom } });
      if (dryRun) return send(200, { ok: true, dryRun: true, offers: offers.length, totalStake, balance: { cash, unmatched, headroom } });
      const tp = now();
      const succeed = []; const failed = [];
      for (let i = 0; i < offers.length; i += 20) {
        // stay under PX's ~2 req/s order limit: first batch waits only for the
        // pacer slot, later batches keep the full pre-batch sleep.
        const w = await waitTurn(i === 0);
        if (i === 0) tm.first_wait_ms = w;
        const batch = offers.slice(i, i + 20).map(o => ({ line_id: o.line_id, odds: o.odds, stake: o.stake, external_id: o.external_id,
          ...(o.order_strategy ? { order_strategy: o.order_strategy } : {}) }));
        let r = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { r = await pxs.placeMultipleWagers(batch); markDone(); break; }
          catch (e) {
            markDone();
            if (/429|rate.?limit/i.test(e.message) && attempt < 2) { await _msleep(1500); continue; }
            failed.push(...batch.map(o => ({ external_id: o.external_id, error: e.message })));
            break;
          }
        }
        if (r) { succeed.push(...(r.succeed_wagers || [])); failed.push(...(r.failed_wagers || [])); }
      }
      tm.place_ms = now() - tp;
      log.info('ManualOffers', `place ${succeed.length} ok / ${failed.length} failed, totalStake $${totalStake} (${offers.length} requested)`);
      send(200, { ok: true, placed: succeed.length, failed: failed.length, totalStake, succeed_wagers: succeed, failed_wagers: failed });
    } catch (e) {
      log.error('ManualOffers', 'place failed: ' + e.message);
      send(500, { ok: false, error: e.message });
    }
  }

  // POST /admin/offers/cancel
  //   body: ONE of { wager_ids: [...] } | { markets: [{event_id, market_id}] } | { event_id: <num> }
  async function cancel(req, res) {
    const pxs = _manualPxsGuard(res); if (!pxs) return;
    const b = req.body || {};
    inflight++;
    try {
      const out = {};
      if (Array.isArray(b.wager_ids) && b.wager_ids.length) {
        out.wagers = [];
        let first = true;
        for (const wid of b.wager_ids) {
          await waitTurn(first); first = false;
          try { await pxs.cancelWager(wid); markDone(); out.wagers.push({ wager_id: wid, ok: true }); }
          catch (e) { markDone(); out.wagers.push({ wager_id: wid, ok: false, error: e.message }); }
        }
      } else if (Array.isArray(b.markets) && b.markets.length) {
        out.markets = [];
        let first = true;
        for (const m of b.markets) {
          await waitTurn(first); first = false;
          let done = false;
          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            try { await pxs.cancelWagersByMarket(m.event_id, m.market_id); markDone(); out.markets.push({ ...m, ok: true }); done = true; }
            catch (e) {
              markDone();
              if (/429|rate.?limit/i.test(e.message) && attempt < 2) { await _msleep(1500); continue; }
              out.markets.push({ ...m, ok: false, error: e.message }); done = true;
            }
          }
        }
      } else if (b.event_id != null) {
        try { await pxs.cancelWagersByEvent(b.event_id); } finally { markDone(); }
        out.event_id = b.event_id; out.cancelled_event = true;
      } else {
        return res.status(400).json({ ok: false, error: 'provide wager_ids[], markets[], or event_id' });
      }
      log.info('ManualOffers', `cancel ${JSON.stringify(b).slice(0, 160)}`);
      res.json({ ok: true, ...out });
    } catch (e) {
      log.error('ManualOffers', 'cancel failed: ' + e.message);
      res.status(500).json({ ok: false, error: e.message });
    } finally {
      inflight--;
    }
  }

  function stats() {
    const live = ring.filter(x => !x.dryRun && x.status === 200);
    return {
      window: ring.length,
      all: summarize(ring),
      live_ok: summarize(live),
      dry: summarize(ring.filter(x => x.dryRun)),
      last: ring.slice(-10),
      inflight,
      pace_ms: MANUAL_PACE_MS,
      pacer: { last_order_call_done_at: lastDoneAt ? new Date(lastDoneAt).toISOString() : null },
    };
  }

  return { place, cancel, stats, inflight: () => inflight, _waitTurn: waitTurn, _markDone: markDone };
}

// ---------------------------------------------------------------------------
// Basic-auth decision for the front's /admin/offers/* routes. A faithful copy
// of index.js startStatusServer's global auth middleware (same env vars, same
// roles, same status codes and bodies). index.js keeps its own middleware;
// keep the two in step if either changes.
//   returns null when the request may proceed, else { status, body, headers? }
// ---------------------------------------------------------------------------
function makeAdminAuth(env = process.env, log = null) {
  const AUTH_USERNAME = env.AUTH_USERNAME || 'mike';
  const AUTH_PASSWORD = env.AUTH_PASSWORD || '';
  const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
  const AUTH_PUBLIC_PATHS = new Set(['/health']);
  function parseAuthList(raw, label) {
    const map = new Map();
    for (const pair of (raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const idx = pair.indexOf(':');
      if (idx <= 0 || idx === pair.length - 1) {
        if (log) log.warn('Auth', `Skipping malformed ${label} entry (expected "user:pass")`);
        continue;
      }
      const user = pair.slice(0, idx);
      const pass = pair.slice(idx + 1);
      if (user === AUTH_USERNAME) continue;
      map.set(user, pass);
    }
    return map;
  }
  const AUTH_VIEWERS = parseAuthList(env.AUTH_VIEWERS, 'AUTH_VIEWERS');
  const AUTH_FULL_VIEWERS = parseAuthList(env.AUTH_FULL_VIEWERS, 'AUTH_FULL_VIEWERS');
  const AUTH_VIEWER_PATHS = new Set(
    (env.AUTH_VIEWER_PATHS || '/edge-vs-fair.html,/viewer,/viewer.html,/status,/orders,/me,/bankroll,/daily-pnl,/daily-volume,/viewer/manifest.json,/viewer/sw.js,/viewer/icon-192.svg,/viewer/icon-512.svg,/push/vapid-key,/push/subscribe,/push/unsubscribe,/push/mute-prefs,/wow-analysis,/wow-analysis.html')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  const DENY = { status: 401, body: 'Authentication required', headers: { 'WWW-Authenticate': 'Basic realm="ProphetX SP", charset="UTF-8"' } };
  function check(req) {
    if (!AUTH_ENABLED) return null;
    if (AUTH_PUBLIC_PATHS.has(req.path)) return null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx > -1) {
          const user = decoded.slice(0, idx);
          const pass = decoded.slice(idx + 1);
          if (user === AUTH_USERNAME && safeEqual(pass, AUTH_PASSWORD)) {
            req.user = { username: user, role: 'admin' };
            return null;
          }
          if (AUTH_VIEWERS.has(user)) {
            if (safeEqual(pass, AUTH_VIEWERS.get(user))) {
              req.user = { username: user, role: 'viewer' };
              if (AUTH_VIEWER_PATHS.has(req.path)) return null;
              return { status: 403, body: 'Forbidden' };
            }
          }
          if (AUTH_FULL_VIEWERS.has(user)) {
            if (safeEqual(pass, AUTH_FULL_VIEWERS.get(user))) {
              req.user = { username: user, role: 'full_viewer' };
              const m = req.method;
              if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
              return { status: 403, body: 'Forbidden — read-only account' };
            }
          }
        }
      } catch (_) { /* fall through to 401 */ }
    }
    return DENY;
  }
  // Express middleware form
  function middleware(req, res, next) {
    const d = check(req);
    if (!d) return next();
    if (d.headers) res.set(d.headers);
    return res.status(d.status).send(d.body);
  }
  return { check, middleware, enabled: AUTH_ENABLED };
}

module.exports = { createManualOffers, makeAdminAuth, summarize };
