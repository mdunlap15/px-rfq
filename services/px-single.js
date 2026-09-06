// ============================================================================
// px-single.js — ProphetX order-book client (single-leg wagers: golf SL + outrights)
// ============================================================================
// Separate token cache / refresh / session-cooldown from services/prophetx.js,
// but as of the 2026-06-16 CFTC account merge it authenticates as the SAME
// account by default:
//   - Credentials: PX_SINGLE_ACCESS_KEY / PX_SINGLE_SECRET_KEY if set, ELSE
//     fall back to the main account (PX_ACCESS_KEY / PX_SECRET_KEY). Operator
//     consolidated everything onto the one merged account, so leaving the
//     PX_SINGLE_* vars unset routes golf posting through the funded account.
//   - Same PX base URL (config.px.baseUrl).
//   - Own session (PX allows 20 concurrent per user); shares the account's
//     balance + 10x unmatched-exposure cap with the parlay quoter.
//
// This file is loaded only when GOLF_SINGLE_LEG_ENABLED=true (or any module
// that uses it requires it on demand). Importing it does NOT initiate any
// network calls or token fetches.
//
// API endpoint patterns extracted from Mike's Google Apps Script
// (PX Order Book Script.txt) so we match what already works in production
// for the second account.
// ============================================================================

const log = require('./logger');
const { config } = require('../config');
// px-single has its OWN pxFetch, so it never went through prophetx.js's CFTC normaliser --
// this file was invisible to the terminology audit until 2026-09-03 because that audit only
// scanned Python. Reuse the same, already-tested normaliser rather than a second copy.
const { normalizeCftcPayload } = require('./prophetx');

// ---------------------------------------------------------------------------
// CFTC v4 WRITE PATH (Mike 2026-09-03) — default OFF.
//
// PX_V4_WRITES=true routes every write on this surface to its v4 successor with the renamed
// REQUEST fields (line_id->strike_id, odds->price, stake->quantity). Response-side translation
// is handled by normalizeCftcPayload, which is why reads need no per-call work.
//
// V4_CANARY_PREFIX is the surgical override: a batch whose external_ids ALL carry that prefix
// goes to v4 even while the flag is off. That is what makes it possible to prove the new
// placement route with ONE $1 offer in production without switching the live book -- placement
// is IP-gated, so it cannot be canaried from a laptop at all (CLAUDE.md 2).
// ---------------------------------------------------------------------------
const PX_V4_WRITES = String(process.env.PX_V4_WRITES || '').toLowerCase() === 'true';
const V4_CANARY_PREFIX = 'claude_v4canary';

function _useV4(orders) {
  if (PX_V4_WRITES) return true;
  return Array.isArray(orders) && orders.length > 0
    && orders.every(o => String((o && o.external_id) || '').startsWith(V4_CANARY_PREFIX));
}

const BASE = config.px && config.px.baseUrl ? config.px.baseUrl : 'https://cash.api.prophetx.co';

let tokenCache = { token: null, refreshToken: null, time: 0 };
let loginCooldownUntil = 0;

// Cached odds ladder. PX ladder is stable across sessions — cache for 1h.
let oddsLadderCache = { ladder: null, time: 0 };
const LADDER_TTL_MS = 60 * 60 * 1000;

function _keys() {
  // Post-CFTC consolidation (operator 2026-06-16): everything that posts or
  // quotes runs on the ONE merged account. PX_SINGLE_* keys are now OPTIONAL —
  // when unset, fall back to the main account credentials (config.px), so
  // golf single-leg + outrights trade the same funded account as the parlay
  // quoter. PX allows up to 20 concurrent sessions per user, so this client
  // and the main prophetx.js client coexisting on the same keys is fine
  // (separate sessions, shared balance + 10x exposure cap — intended).
  const access = process.env.PX_SINGLE_ACCESS_KEY || (config.px && config.px.accessKey);
  const secret = process.env.PX_SINGLE_SECRET_KEY || (config.px && config.px.secretKey);
  if (!access || !secret) {
    throw new Error('px-single: no credentials — set PX_SINGLE_ACCESS_KEY/SECRET_KEY or the main PX_ACCESS_KEY/PX_SECRET_KEY');
  }
  return { access, secret, usingMain: !process.env.PX_SINGLE_ACCESS_KEY };
}

async function login() {
  // 24h token life; refresh if older than 23h.
  if (tokenCache.token && (Date.now() - tokenCache.time) < 23 * 60 * 60 * 1000) {
    return tokenCache.token;
  }
  if (Date.now() < loginCooldownUntil) {
    const waitSec = Math.round((loginCooldownUntil - Date.now()) / 1000);
    throw new Error(`px-single: login on cooldown (${waitSec}s) — avoiding session_num_exceed`);
  }

  const { access, secret, usingMain } = _keys();
  log.info('PX-Single', `Logging in (${usingMain ? 'MAIN merged account — PX_SINGLE_* unset' : 'dedicated PX_SINGLE account'})…`);
  const resp = await fetch(`${BASE}/partner/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ access_key: access, secret_key: secret }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (text.includes('session_num_exceed')) {
      loginCooldownUntil = Date.now() + 10 * 60 * 1000;
      log.error('PX-Single', 'session_num_exceed — 10min cooldown');
    }
    throw new Error(`px-single login failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  loginCooldownUntil = 0;
  const data = await resp.json();
  const token = data.access_token || data.data?.access_token;
  if (!token) throw new Error('px-single login: no access_token in response');
  const refreshToken = data.refresh_token || data.data?.refresh_token || null;
  tokenCache = { token, refreshToken, time: Date.now() };
  log.info('PX-Single', `Login OK${refreshToken ? ' (with refresh token)' : ''}`);
  return token;
}

async function refreshSession() {
  if (!tokenCache.refreshToken) return null;
  const resp = await fetch(`${BASE}/partner/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ refresh_token: tokenCache.refreshToken }),
  });
  if (!resp.ok) { tokenCache.refreshToken = null; return null; }
  const data = await resp.json();
  const token = data.access_token || data.data?.access_token;
  if (!token) return null;
  const refreshToken = data.refresh_token || data.data?.refresh_token || tokenCache.refreshToken;
  tokenCache = { token, refreshToken, time: Date.now() };
  return token;
}

async function pxFetch(endpoint, method = 'GET', body = null) {
  const token = await login();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  let resp = await fetch(`${BASE}${endpoint}`, opts);
  // 401 once — try refresh, retry
  if (resp.status === 401) {
    log.warn('PX-Single', `401 on ${method} ${endpoint} — re-authing`);
    tokenCache.token = null;
    let newToken = null;
    if (tokenCache.refreshToken) {
      try { newToken = await refreshSession(); } catch (_) {}
    }
    if (!newToken) { try { newToken = await login(); } catch (_) {} }
    if (newToken) {
      opts.headers.Authorization = `Bearer ${newToken}`;
      resp = await fetch(`${BASE}${endpoint}`, opts);
    }
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`px-single ${method} ${endpoint} ${resp.status}: ${text.slice(0, 300)}`);
  }
  // Translate CFTC vocabulary back to legacy so every reader below keeps working whichever
  // tier answered. Endpoint-scoped, so `price`/`quantity` are only remapped where they really
  // are renames of odds/stake.
  return normalizeCftcPayload(await resp.json(), endpoint);
}

// ---------------------------------------------------------------------------
// PX endpoints
// ---------------------------------------------------------------------------

async function fetchSportEvents() {
  const j = await pxFetch('/partner/mm/get_sport_events', 'GET');
  return (j.data && j.data.sport_events) || [];
}

async function fetchMarkets(eventId) {
  const j = await pxFetch(`/partner/v2/mm/get_markets?event_id=${encodeURIComponent(eventId)}`, 'GET');
  return (j.data && j.data.markets) || [];
}

async function fetchBalance() {
  // /v4/mm/get_balance renames matched_wager_balance -> matched_order_balance et al;
  // normalizeCftcPayload maps them back.
  const j = await pxFetch(PX_V4_WRITES ? '/partner/v4/mm/get_balance'
                                       : '/partner/mm/get_balance', 'GET');
  return j.data || j;
}

// Bulk place wagers — PX accepts up to 20 per call. Caller is responsible
// for batching; this function makes ONE API call per batch.
// orders shape: [{ line_id, odds (american int), stake (number), external_id (string) }, ...]
// Returns { succeed_wagers: [...], failed_wagers: [...] }.
async function placeMultipleWagers(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return { succeed_wagers: [], failed_wagers: [] };
  if (orders.length > 20) throw new Error('px-single.placeMultipleWagers: max 20 per call');
  // v4 renames the REQUEST fields; normalizeCftcPayload is response-side only and cannot help
  // here. Probed live: /partner/v4/mm/submit_multiple_orders EXISTS and returns byte-identical
  // errors to place_multiple_wagers, so this is a swap, not a rewrite. (`submit_orders` is 404;
  // the singular `submit_order` also exists but takes one order.)
  const v4 = _useV4(orders);
  const payload = {
    data: orders.map(o => (v4 ? {
      strike_id: o.line_id,
      price: o.odds,
      quantity: o.stake,
      external_id: o.external_id,
    } : {
      line_id: o.line_id,
      odds: o.odds,
      stake: o.stake,
      external_id: o.external_id,
    })),
  };
  const route = v4 ? '/partner/v4/mm/submit_multiple_orders' : '/partner/mm/place_multiple_wagers';
  log.info('PX-Single', `${v4 ? 'submit_multiple_orders(v4)' : 'place_multiple_wagers'} request: ${JSON.stringify(payload.data)}`);
  const j = await pxFetch(route, 'POST', payload);
  // Log the RAW response so we can verify PX's actual shape — the parlay SP
  // doesn't use this endpoint, so its field names (succeed_wagers / wager_id /
  // status / external_id) are unverified against live PX. Diagnosing the
  // "said posted but not on book" case (2026-06-02).
  try {
    const dataStr = JSON.stringify(j && j.data);
    log.info('PX-Single', `place_multiple_wagers raw data: ${dataStr ? dataStr.slice(0, 1500) : '(no .data) top-level: ' + JSON.stringify(j).slice(0, 1500)}`);
  } catch (_) {}
  // Be liberal in what we accept: PX may nest these under j.data or return
  // them at the top level.
  const root = (j && j.data) ? j.data : (j || {});
  // v4 nests its results under order-flavoured names; stay liberal in what we accept so the
  // caller sees one shape whichever tier answered.
  return {
    succeed_wagers: root.succeed_wagers || root.succeeded_wagers || root.wagers
      || root.succeed_orders || root.succeeded_orders || root.orders || [],
    failed_wagers: root.failed_wagers || root.failures || root.failed_orders || [],
    _raw: root,
  };
}

// Cancel contracts CANARIED on the production account 2026-09-03: cancel_order takes
// {external_id, order_id}; the by-market route keeps `event_id` (`sport_event_id` is rejected
// with invalid_event_id). Here only the id is available, so the order_id form is used.
async function cancelWager(wagerId) {
  return PX_V4_WRITES
    ? await pxFetch('/partner/v4/mm/cancel_order', 'POST', { order_id: wagerId })
    : await pxFetch('/partner/mm/cancel_wager', 'POST', { wager_id: wagerId });
}

async function cancelWagersByEvent(eventId) {
  const path = PX_V4_WRITES ? '/partner/v4/mm/cancel_orders_by_event'
                            : '/partner/mm/cancel_wagers_by_event';
  return await pxFetch(path, 'POST', { event_id: Number(eventId) });
}

async function cancelWagersByMarket(eventId, marketId) {
  const path = PX_V4_WRITES ? '/partner/v4/mm/cancel_orders_by_market'
                            : '/partner/mm/cancel_wagers_by_market';
  return await pxFetch(path, 'POST', { event_id: Number(eventId), market_id: Number(marketId) });
}

// ---------------------------------------------------------------------------
// Odds ladder — PX requires posted odds to land on a valid rung. Fetch once
// per hour and snap any computed odds to the nearest rung before posting.
// ---------------------------------------------------------------------------
async function fetchOddsLadder(force = false) {
  if (!force && oddsLadderCache.ladder && (Date.now() - oddsLadderCache.time) < LADDER_TTL_MS) {
    return oddsLadderCache.ladder;
  }
  // v4 get_price_ladder returns the SAME list of bare integers (measured: 555 either way).
  const j = await pxFetch(PX_V4_WRITES ? '/partner/v4/mm/get_price_ladder'
                                       : '/partner/mm/get_odds_ladder', 'GET');
  let ladder = j.data || j;
  // Some shapes return { ladder: [...] }, others return [...] directly
  if (ladder && !Array.isArray(ladder) && Array.isArray(ladder.ladder)) ladder = ladder.ladder;
  if (!Array.isArray(ladder)) throw new Error('px-single: unexpected odds-ladder shape');
  oddsLadderCache = { ladder, time: Date.now() };
  return ladder;
}

// Synchronous read of the last-fetched ladder (or null) — no API round-trip.
// Used by the golf single-leg 1-tick sweetener so _computeOffered (sync) can
// step on real PX rungs. postEnabled()/loadState() warm the cache via
// fetchOddsLadder() first; a cold cache makes the sweetener fall back to a
// 1-point nudge, which still covers the near-even case (-110 → -109).
function getCachedLadder() {
  return oddsLadderCache.ladder || null;
}

function snapToLadder(odds, ladder) {
  if (!Array.isArray(ladder) || !ladder.length) return Math.round(odds);
  let best = ladder[0];
  let bestDist = Math.abs(odds - best);
  for (let i = 1; i < ladder.length; i++) {
    const d = Math.abs(odds - ladder[i]);
    if (d < bestDist) { best = ladder[i]; bestDist = d; }
  }
  return best;
}

module.exports = {
  login,
  refreshSession,
  fetchSportEvents,
  fetchMarkets,
  fetchBalance,
  placeMultipleWagers,
  cancelWager,
  cancelWagersByEvent,
  cancelWagersByMarket,
  fetchOddsLadder,
  getCachedLadder,
  snapToLadder,
  // for tests / debugging
  _tokenCache: () => ({ ...tokenCache, token: tokenCache.token ? '<set>' : null }),
};
