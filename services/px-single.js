// ============================================================================
// px-single.js — ProphetX client for the SECOND account (single-leg wagers)
// ============================================================================
// COMPLETELY ISOLATED from services/prophetx.js:
//   - Own access/secret keys (PX_SINGLE_ACCESS_KEY / PX_SINGLE_SECRET_KEY env)
//   - Own token cache, own refresh logic, own session-limit cooldown
//   - Operates on the SAME PX base URL (cash.api.prophetx.co/partner) but
//     authenticates as a different MM partner, so all read/write happens on
//     the single-leg account exclusively.
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

const BASE = config.px && config.px.baseUrl ? config.px.baseUrl : 'https://cash.api.prophetx.co';

let tokenCache = { token: null, refreshToken: null, time: 0 };
let loginCooldownUntil = 0;

// Cached odds ladder. PX ladder is stable across sessions — cache for 1h.
let oddsLadderCache = { ladder: null, time: 0 };
const LADDER_TTL_MS = 60 * 60 * 1000;

function _keys() {
  const access = process.env.PX_SINGLE_ACCESS_KEY;
  const secret = process.env.PX_SINGLE_SECRET_KEY;
  if (!access || !secret) {
    throw new Error('px-single: PX_SINGLE_ACCESS_KEY / PX_SINGLE_SECRET_KEY not configured');
  }
  return { access, secret };
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

  const { access, secret } = _keys();
  log.info('PX-Single', 'Logging in (second account)…');
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
  return await resp.json();
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
  const j = await pxFetch('/partner/mm/get_balance', 'GET');
  return j.data || j;
}

// Bulk place wagers — PX accepts up to 20 per call. Caller is responsible
// for batching; this function makes ONE API call per batch.
// orders shape: [{ line_id, odds (american int), stake (number), external_id (string) }, ...]
// Returns { succeed_wagers: [...], failed_wagers: [...] }.
async function placeMultipleWagers(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return { succeed_wagers: [], failed_wagers: [] };
  if (orders.length > 20) throw new Error('px-single.placeMultipleWagers: max 20 per call');
  const payload = {
    data: orders.map(o => ({
      line_id: o.line_id,
      odds: o.odds,
      stake: o.stake,
      external_id: o.external_id,
    })),
  };
  const j = await pxFetch('/partner/mm/place_multiple_wagers', 'POST', payload);
  return {
    succeed_wagers: (j.data && j.data.succeed_wagers) || [],
    failed_wagers: (j.data && j.data.failed_wagers) || [],
  };
}

async function cancelWager(wagerId) {
  return await pxFetch('/partner/mm/cancel_wager', 'POST', { wager_id: wagerId });
}

async function cancelWagersByEvent(eventId) {
  return await pxFetch('/partner/mm/cancel_wagers_by_event', 'POST', { event_id: Number(eventId) });
}

async function cancelWagersByMarket(eventId, marketId) {
  return await pxFetch('/partner/mm/cancel_wagers_by_market', 'POST', {
    event_id: Number(eventId), market_id: Number(marketId),
  });
}

// ---------------------------------------------------------------------------
// Odds ladder — PX requires posted odds to land on a valid rung. Fetch once
// per hour and snap any computed odds to the nearest rung before posting.
// ---------------------------------------------------------------------------
async function fetchOddsLadder(force = false) {
  if (!force && oddsLadderCache.ladder && (Date.now() - oddsLadderCache.time) < LADDER_TTL_MS) {
    return oddsLadderCache.ladder;
  }
  const j = await pxFetch('/partner/mm/get_odds_ladder', 'GET');
  let ladder = j.data || j;
  // Some shapes return { ladder: [...] }, others return [...] directly
  if (ladder && !Array.isArray(ladder) && Array.isArray(ladder.ladder)) ladder = ladder.ladder;
  if (!Array.isArray(ladder)) throw new Error('px-single: unexpected odds-ladder shape');
  oddsLadderCache = { ladder, time: Date.now() };
  return ladder;
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
  snapToLadder,
  // for tests / debugging
  _tokenCache: () => ({ ...tokenCache, token: tokenCache.token ? '<set>' : null }),
};
