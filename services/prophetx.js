// Uses Node's global fetch (undici under the hood). Keep-alive, pool size,
// and TCP_NODELAY are configured by services/httpClient — see that module.
// Migrated from node-fetch@2 + custom http.Agent for S3 of latency plan.
const { config } = require('../config');
const log = require('./logger');

// Token cache
let tokenCache = { token: null, refreshToken: null, time: 0 };
// Cooldown: after a failed login (especially session_num_exceed), don't retry
// for this many ms. Prevents periodic timers from burning through all 20 sessions.
let loginCooldownUntil = 0;

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

async function login() {
  const age = (Date.now() - tokenCache.time) / 1000 / 60;
  if (tokenCache.token && age < config.px.tokenTtlMinutes) {
    return tokenCache.token;
  }

  // Try refresh first (doesn't create a new session — never blocked by cooldown)
  if (tokenCache.refreshToken) {
    try {
      const refreshed = await refreshSession();
      if (refreshed) return refreshed;
    } catch (err) {
      log.warn('PX-Auth', `Refresh failed: ${err.message}, falling back to login`);
    }
  }

  // If we have a stale token, return it anyway — let PX reject with 401
  // and the caller can retry. Better than throwing and blocking all offers.
  if (tokenCache.token) {
    log.debug('PX-Auth', 'Token expired but returning stale token to avoid blocking');
    return tokenCache.token;
  }

  // Cooldown: if a recent login failed, don't spam PX with more attempts
  if (Date.now() < loginCooldownUntil) {
    const waitSec = Math.round((loginCooldownUntil - Date.now()) / 1000);
    throw new Error(`Login on cooldown (${waitSec}s remaining) — avoiding session_num_exceed`);
  }

  log.info('PX-Auth', 'Logging in to ProphetX...');
  const resp = await pxFetchWithTimeout(`${config.px.baseUrl}/partner/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      access_key: config.px.accessKey,
      secret_key: config.px.secretKey,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    // If session limit hit, set a 10-minute cooldown (wait for sessions to expire)
    if (text.includes('session_num_exceed')) {
      loginCooldownUntil = Date.now() + 10 * 60 * 1000;
      log.error('PX-Auth', 'Session limit hit — 10min cooldown before next login attempt');
    }
    throw new Error(`ProphetX login failed (${resp.status}): ${text}`);
  }

  // Success — clear any cooldown
  loginCooldownUntil = 0;

  const data = await resp.json();
  const token = data.access_token || data.data?.access_token;
  if (!token) throw new Error('ProphetX login: no access_token in response');

  const refreshToken = data.refresh_token || data.data?.refresh_token || null;
  tokenCache = { token, refreshToken, time: Date.now() };
  log.info('PX-Auth', `Login successful, token cached${refreshToken ? ' (with refresh token)' : ''}`);
  return token;
}

/**
 * Refresh the access token using the stored refresh token.
 * This does NOT create a new session, avoiding the session limit.
 */
async function refreshSession() {
  if (!tokenCache.refreshToken) return null;

  log.debug('PX-Auth', 'Refreshing session...');
  const resp = await pxFetchWithTimeout(`${config.px.baseUrl}/partner/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ refresh_token: tokenCache.refreshToken }),
  });

  if (!resp.ok) {
    tokenCache.refreshToken = null; // clear stale refresh token
    return null;
  }

  const data = await resp.json();
  const token = data.access_token || data.data?.access_token;
  if (!token) return null;

  const refreshToken = data.refresh_token || data.data?.refresh_token || tokenCache.refreshToken;
  tokenCache = { token, refreshToken, time: Date.now() };
  log.info('PX-Auth', 'Session refreshed (no new session created)');
  return token;
}

function invalidateToken() {
  tokenCache = { token: null, refreshToken: tokenCache.refreshToken, time: 0 };
}

// ---------------------------------------------------------------------------
// GENERIC REQUEST WRAPPER
// ---------------------------------------------------------------------------

// Hard request timeout for ALL PX REST calls — no PX request may hang the event
// loop indefinitely. 2026-06-10 OUTAGE: an un-timed-out orders fetch on the
// confirm hot path hung every confirm for ~2h with no error/reject. This is the
// systemic backstop (the confirm-path lookup also has a tighter 800ms cap).
// AbortController works with both global fetch and node-fetch.
const PX_REQUEST_TIMEOUT_MS = parseInt(process.env.PX_REQUEST_TIMEOUT_MS) || 10000;
async function pxFetchWithTimeout(url, options) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PX_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ac.signal }));
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.type === 'aborted')) {
      throw new Error(`PX request timeout after ${PX_REQUEST_TIMEOUT_MS}ms: ${(options && options.method) || 'GET'} ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function pxFetch(endpoint, method = 'GET', body = null, useBaseUrl = true) {
  const token = await login();
  const url = useBaseUrl ? `${config.px.baseUrl}${endpoint}` : endpoint;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const resp = await pxFetchWithTimeout(url, options);

  if (resp.status === 401) {
    // Token expired — try to get a fresh one and retry ONCE.
    // Use refresh token directly (no new session). If refresh fails,
    // try a fresh login but suppress cooldown on failure.
    log.warn('PX-Auth', `401 on ${method} ${endpoint} — re-authenticating`);
    invalidateToken();
    clearCooldown();
    let newToken = null;
    // Try refresh first (no session cost)
    if (tokenCache.refreshToken) {
      try { newToken = await refreshSession(); } catch (e) {}
    }
    // Fall back to login, but suppress cooldown if it fails
    if (!newToken) {
      const savedCooldown = loginCooldownUntil;
      try { newToken = await login(); } catch (e) {
        loginCooldownUntil = savedCooldown; // restore, don't set new cooldown
        throw new Error(`ProphetX API 401 on ${method} ${endpoint} — re-auth failed: ${e.message}`);
      }
    }
    options.headers['Authorization'] = `Bearer ${newToken}`;
    const retryResp = await pxFetchWithTimeout(url, options);
    if (!retryResp.ok) {
      const text = await retryResp.text();
      throw new Error(`ProphetX API ${retryResp.status} on ${method} ${endpoint} (retry): ${text}`);
    }
    return retryResp.json();
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ProphetX API ${resp.status} on ${method} ${endpoint}: ${text}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// SPORT EVENTS & MARKETS
// ---------------------------------------------------------------------------

async function fetchSportEvents() {
  const data = await pxFetch('/partner/mm/get_sport_events');
  return data.data?.sport_events || [];
}

// ---------------------------------------------------------------------------
// fetchMarkets cache + in-flight coalescing
// ---------------------------------------------------------------------------
// Two callers exercise this endpoint heavily:
//   1. seedAllLines — fetches markets for every supported PX event at seed time
//      (one call per event, unique event_id → no cache contention)
//   2. resolveUnknownLine — fetches markets for an event the first time an
//      unknown line_id arrives from that event. The hot path.
//
// Latency instrumentation showed receive_to_resolve p95 ≈ 160ms, traced to
// the PX get_markets round-trip inside resolveUnknownLine. Two classes of
// wasted work:
//   a. Multiple concurrent RFQs for the same fresh event each fire their
//      own fetchMarkets call (line-manager's inFlightResolutions map only
//      dedupes per-lineId, not per-eventId).
//   b. Rapid back-to-back RFQs across different lineIds in the same
//      event re-fetch identical market data.
//
// 30s TTL + in-flight promise map collapses both. Markets metadata (market
// types, lines, selection ids) is structural and changes slowly — the
// odds inside it aren't read here, so a 30s stale window is safe. Seed-
// time calls still hit the network because seed iterates unique events
// sequentially with 100ms spacing between them — TTL won't come into
// play unless the same event is re-seeded inside 30s (refreshLines is
// on a 2-min cadence, so no).
const _marketsCache = {};          // eventId -> { markets, fetchedAt }
const _marketsInFlight = {};       // eventId -> Promise<markets[]>
const MARKETS_CACHE_TTL_MS = 30 * 1000;
const _marketsCacheStats = { hits: 0, coalesced: 0, fetched: 0, errors: 0 };

async function fetchMarkets(eventId, opts = {}) {
  const bypass = opts.bypass === true;
  const now = Date.now();

  // Fast path: fresh cache entry.
  if (!bypass) {
    const cached = _marketsCache[eventId];
    if (cached && (now - cached.fetchedAt) < MARKETS_CACHE_TTL_MS) {
      _marketsCacheStats.hits++;
      return cached.markets;
    }
    // Coalesce: another caller is already fetching this eventId.
    const pending = _marketsInFlight[eventId];
    if (pending) {
      _marketsCacheStats.coalesced++;
      return pending;
    }
  }

  const promise = (async () => {
    try {
      const data = await pxFetch(`/partner/mm/get_markets?event_id=${eventId}`);
      const markets = data.data?.markets || [];
      _marketsCache[eventId] = { markets, fetchedAt: Date.now() };
      _marketsCacheStats.fetched++;
      return markets;
    } catch (err) {
      _marketsCacheStats.errors++;
      throw err;
    } finally {
      delete _marketsInFlight[eventId];
    }
  })();
  _marketsInFlight[eventId] = promise;
  return promise;
}

function getMarketsCacheStats() {
  const total = _marketsCacheStats.hits + _marketsCacheStats.coalesced + _marketsCacheStats.fetched;
  return {
    ..._marketsCacheStats,
    ttlMs: MARKETS_CACHE_TTL_MS,
    cacheSize: Object.keys(_marketsCache).length,
    inFlight: Object.keys(_marketsInFlight).length,
    hitRate: total > 0 ? (_marketsCacheStats.hits + _marketsCacheStats.coalesced) / total : null,
  };
}

// ---------------------------------------------------------------------------
// AFFILIATE API — richer reference endpoints that return team/market names
//
// PX exposes a separate /partner/affiliate/* namespace with three read-only
// endpoints that the /partner/mm/* ones don't match feature-for-feature:
//
//   • get_sport_events?event_ids[]&tournament_id= — bulk event lookup with
//     competitors[] (home/away team names + abbreviations), scheduled start
//     time, tournament_name, sport_name
//   • get_multiple_markets?event_ids[]&get_all_market=true — bulk markets
//     keyed by event_id, same schema as single-event get_markets
//   • get_tournaments — tournament_id → sport/league dictionary
//
// These replace the per-event enrichment loop entirely: 217 serial fetches
// become two bulk calls. They also expose home/away team names (via
// competitors[].side) which the MM namespace does not.
// ---------------------------------------------------------------------------

/**
 * Bulk fetch sport event metadata. Accepts { eventIds?, tournamentId? }.
 * Returns an array of sport-event objects with competitors, scheduled,
 * tournament_name, sport_name, etc.
 *
 * PX appears to accept either `event_ids=1,2,3` (comma-separated) or
 * repeated `event_ids=1&event_ids=2` syntax. We use comma-separated since
 * it's shorter; fall back handled in caller if that doesn't parse.
 */
async function fetchAffiliateSportEvents({ eventIds = null, tournamentId = null } = {}) {
  // NOTE: Our API key has /partner/mm/* access only — /partner/affiliate/*
  // returns 401. The mm namespace exposes the same reference endpoints but
  // only for CURRENT (live/upcoming) events; historical events return 404.
  const params = [];
  if (eventIds && eventIds.length > 0) {
    params.push(`event_ids=${eventIds.join(',')}`);
  }
  if (tournamentId) params.push(`tournament_id=${tournamentId}`);
  const qs = params.length ? `?${params.join('&')}` : '';
  const data = await pxFetch(`/partner/mm/get_sport_events${qs}`);
  return data.data?.sport_events || data.sport_events || [];
}

/**
 * Bulk fetch markets for many events at once. Returns an object keyed by
 * eventId → markets array. Pass `getAllMarket: false` to trim the response
 * to primary markets only (moneyline/spread/total/team_total).
 */
async function fetchAffiliateMultipleMarkets(eventIds, opts = {}) {
  if (!eventIds || eventIds.length === 0) return {};
  const params = [`event_ids=${eventIds.join(',')}`];
  if (opts.getAllMarket !== false) params.push('get_all_market=true');
  const data = await pxFetch(`/partner/mm/get_multiple_markets?${params.join('&')}`);
  // Shape: { data: { <event_id>: [markets] } } OR { <event_id>: [markets] }
  return data.data || data;
}

/**
 * One-shot tournament dictionary. Returns an array of tournaments, each with
 * { id, name, sport: { id, name } }. Small response — cache it on startup
 * and look up tournament_id → sport_name across the whole session.
 */
async function fetchAffiliateTournaments() {
  const data = await pxFetch('/partner/mm/get_tournaments');
  return data.data?.tournaments || data.tournaments || [];
}

// ---------------------------------------------------------------------------
// SUPPORTED LINES
// ---------------------------------------------------------------------------

// PX's /parlay/sp/supported-lines accepts at most 1000 line_ids per call
// (400 invalid_params otherwise). As our line index has grown past 1000
// we'd silently fail to register any lines — forcing every first-RFQ for
// a line to pay a round-trip via on-demand registration. Chunk both
// POST and DELETE to stay under the cap.
const PX_SUPPORTED_LINES_CHUNK_SIZE = 1000;

async function registerSupportedLines(lineIds) {
  if (!lineIds || lineIds.length === 0) return { success: true, count: 0 };
  if (lineIds.length <= PX_SUPPORTED_LINES_CHUNK_SIZE) {
    log.info('PX-Lines', `Registering ${lineIds.length} supported lines`);
    return pxFetch('/parlay/sp/supported-lines', 'POST', { supported_lines: lineIds });
  }
  const chunks = [];
  for (let i = 0; i < lineIds.length; i += PX_SUPPORTED_LINES_CHUNK_SIZE) {
    chunks.push(lineIds.slice(i, i + PX_SUPPORTED_LINES_CHUNK_SIZE));
  }
  log.info('PX-Lines', `Registering ${lineIds.length} supported lines in ${chunks.length} chunks (cap ${PX_SUPPORTED_LINES_CHUNK_SIZE})`);
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    await pxFetch('/parlay/sp/supported-lines', 'POST', { supported_lines: chunk });
    log.debug('PX-Lines', `  chunk ${ci + 1}/${chunks.length} registered (${chunk.length} lines)`);
  }
  return { success: true, count: lineIds.length, chunks: chunks.length };
}

async function removeSupportedLines(lineIds) {
  if (!lineIds || lineIds.length === 0) return { success: true };
  if (lineIds.length <= PX_SUPPORTED_LINES_CHUNK_SIZE) {
    log.info('PX-Lines', `Removing ${lineIds.length} supported lines`);
    return pxFetch('/parlay/sp/supported-lines', 'DELETE', { supported_lines: lineIds });
  }
  const chunks = [];
  for (let i = 0; i < lineIds.length; i += PX_SUPPORTED_LINES_CHUNK_SIZE) {
    chunks.push(lineIds.slice(i, i + PX_SUPPORTED_LINES_CHUNK_SIZE));
  }
  log.info('PX-Lines', `Removing ${lineIds.length} supported lines in ${chunks.length} chunks`);
  for (const chunk of chunks) {
    await pxFetch('/parlay/sp/supported-lines', 'DELETE', { supported_lines: chunk });
  }
  return { success: true, count: lineIds.length, chunks: chunks.length };
}

// Fetch the FULL supported-lines set. PX caps each page at 100 and returns a
// `token` cursor for the next page — a single GET only sees 100. We paginate via
// ?token= until exhausted so the supported-set reconciler (line-manager) can see
// the whole set and prune stale entries. maxLines bounds a pathological loop.
async function getSupportedLines(maxLines = 100000) {
  const all = [];
  let token = null;
  const maxPages = Math.ceil(maxLines / 100) + 1;
  for (let i = 0; i < maxPages; i++) {
    const q = token
      ? `/parlay/sp/supported-lines?limit=100&token=${encodeURIComponent(token)}`
      : '/parlay/sp/supported-lines?limit=100';
    let data;
    try {
      data = await pxFetch(q);
    } catch (e) {
      // Return what we have rather than discarding the whole fetch — a partial
      // set still lets the reconciler prune most stale lines.
      log.warn('PX-Lines', `getSupportedLines pagination stopped at page ${i} (${all.length} fetched): ${e.message}`);
      break;
    }
    const page = (data.data && data.data.supported_lines) || [];
    all.push(...page);
    const next = data.data && data.data.token;
    if (!page.length || !next || next === token) break; // last page / no cursor advance
    token = next;
    if (all.length >= maxLines) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// WEBSOCKET
// ---------------------------------------------------------------------------

async function getWebSocketConfig() {
  const data = await pxFetch('/parlay/sp/websocket/connection-config');
  return data; // { key, cluster, app_id }
}

async function registerWebSocket(socketId) {
  const data = await pxFetch('/parlay/sp/websocket/register', 'POST', {
    socket_id: socketId,
  });
  return data; // { channels, events }
}

// ---------------------------------------------------------------------------
// OFFERS & CONFIRMATIONS
// ---------------------------------------------------------------------------

async function submitOffer(callbackUrl, parlayId, offers) {
  // No pre-submit log. Removed because JSON.stringify(offers) + log.info
  // on the hot path adds 1-3ms (stdout back-pressure dependent), and the
  // "Offered" log in websocket.js already records this submission. The
  // response log below is off the critical path — the caller fires this
  // promise and doesn't await it.
  return pxFetch(callbackUrl, 'POST', {
    parlay_id: parlayId,
    offers,
  }, false).then(data => {
    log.info('PX-Offer', `Response for ${parlayId}: ${JSON.stringify(data).substring(0, 300)}`);
    return data;
  }).catch(err => {
    log.error('PX-Offer', `Failed to submit offer for ${parlayId}: ${err.message}`);
    throw err;
  });
}

async function confirmOrder(callbackUrl, orderUuid, action, confirmedOdds, confirmedStake, priceProbability) {
  log.info('PX-Confirm', `${action} order ${orderUuid}`);
  const body = {
    order_uuid: orderUuid,
    action,
  };
  if (confirmedOdds != null) body.confirmed_odds = confirmedOdds;
  if (confirmedStake != null) body.confirmed_stake = confirmedStake;
  if (priceProbability) body.price_probability = priceProbability;

  const data = await pxFetch(callbackUrl, 'POST', body, false);
  return data;
}

// ---------------------------------------------------------------------------
// ORDERS
// ---------------------------------------------------------------------------

async function fetchBalance() {
  const data = await pxFetch('/partner/mm/get_balance');
  return data.data || data;
}

/**
 * Fetch orders from PX. PX caps single pages at 100 orders and returns a
 * base64 `token` for the next page. When limit > 100, we paginate using
 * that token until we reach the limit or exhaust all orders.
 */
/**
 * Fetch a single order by order_uuid from PX REST. Returns the order object
 * with full leg-level settlement data, or null if not found.
 *
 * Used by the WebSocket parlay.settled handler to backfill leg status data
 * before persisting a settlement — without this, orders settled via WebSocket
 * have no leg_status fields, which triggers the loadFromDb revert heuristic
 * on restart and silently destroys settlement records.
 *
 * Implementation: scans the most recent 50 orders for the matching UUID.
 * The just-settled order is nearly always at the top of that window.
 */
async function fetchOrderByUuid(uuid) {
  if (!uuid) return null;
  try {
    // Look back 200 (was 50) so the just-settled order's leg backfill in
    // handleParlaySettled doesn't silently miss when a burst of newer
    // confirms/quotes pushes it past a small window. recordSettlement still
    // records P&L regardless; this just keeps the leg-level record populated.
    const orders = await fetchOrders(200);
    return orders.find(o => o.order_uuid === uuid) || null;
  } catch (err) {
    log.warn('PX-Orders', `fetchOrderByUuid(${uuid}) failed: ${err.message}`);
    return null;
  }
}

async function fetchOrders(limit = 50, status = null) {
  const PAGE_SIZE = 100;
  const all = [];
  let token = null;
  while (all.length < limit) {
    const pageSize = Math.min(PAGE_SIZE, limit - all.length);
    let url = `/parlay/sp/orders/?limit=${pageSize}`;
    if (status) url += `&status=${status}`;
    if (token) url += `&token=${encodeURIComponent(token)}`;
    let data;
    try {
      data = await pxFetch(url);
    } catch (err) {
      log.warn('PX-Orders', `Pagination stopped (offset ${all.length}): ${err.message}`);
      break;
    }
    const orders = data.data?.orders || [];
    if (orders.length === 0) break;
    all.push(...orders);
    token = data.data?.token || null;
    if (!token || orders.length < pageSize) break; // no more pages
  }
  return all;
}

// ---------------------------------------------------------------------------
// MARKET PARSING HELPERS
// ---------------------------------------------------------------------------

/**
 * Golf matchup ±0.5 SPREAD market name.
 *   "Ludvig Aberg vs. Scottie Scheffler (Round 2 Matchup) - Spread"
 * Anchored end-to-end on purpose: PX types this 'sup_moneyline', a type shared
 * with series spreads/totals, soccer asian handicaps and football props, so a
 * loose match would drag unrelated markets into golf handling.
 */
const GOLF_MATCHUP_SPREAD_RE =
  /^(.+?)\s+vs\.?\s+(.+?)\s*\(\s*(?:round\s*(\d+)|tournament)\s+matchup\s*\)\s*[-–—]\s*spread\s*$/i;

/** Accent/punctuation-insensitive name normaliser for golf player matching. */
function golfNormName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve PX's abbreviated spread code ("SCH", "REIT") to one of the TWO full
 * player names in this market. Returns null — never a guess — when the code is
 * ambiguous or matches neither.
 *
 * Tier 1 is the surname prefix, PX's observed convention (SCH→Scheffler,
 * ABE→Aberg, HEN→Henley, REIT→Reitan). Tier 2 tries any name token, which
 * covers a first-name-derived code ("MIN" for Min Woo Lee).
 *
 * A tier that matches BOTH players returns null rather than falling through to
 * a looser tier: ambiguity must fail closed, not escalate. That is what makes a
 * same-surname pairing (Matt vs Alex Fitzpatrick, the two Hojgaards) go dark
 * instead of paying the wrong side.
 */
function resolveGolfAbbrev(abbr, players) {
  const a = golfNormName(abbr).replace(/ /g, '');
  if (!a || !Array.isArray(players) || players.length !== 2) return null;
  const tokensOf = (p) => golfNormName(p).split(' ').filter(Boolean);

  const bySurname = players.filter((p) => {
    const t = tokensOf(p);
    return t.length && t[t.length - 1].startsWith(a);
  });
  if (bySurname.length === 1) return bySurname[0];
  if (bySurname.length > 1) return null;            // ambiguous — fail closed

  const byAnyToken = players.filter((p) => tokensOf(p).some((t) => t.startsWith(a)));
  return byAnyToken.length === 1 ? byAnyToken[0] : null;
}

/**
 * Parse a ProphetX market response into a flat list of line entries.
 * Handles the nested selections structure for moneyline, spread, and total markets.
 *
 * Returns: [{ lineId, marketType, selection, teamName, line, competitorId, outcomeName }]
 */
function parseMarketSelections(market) {
  const results = [];
  let marketType = market.type; // 'moneyline', 'spread', 'total'

  // Strip trailing odds from team names (e.g., "Kansas City Royals -103" → "Kansas City Royals")
  function cleanSelectionName(name) {
    if (!name) return '';
    // Remove trailing odds pattern: space + optional sign + digits (e.g., " -103", " +275", " 150")
    return name.replace(/\s+[+-]?\d+(\.\d+)?$/, '').trim();
  }

  // PX uses the same market.type ('moneyline', 'spread', 'total') for both
  // full-game and sub-period markets (First 5 Innings for MLB, First Half
  // for NBA), distinguishing them only by market.name. Detect by name and
  // override the marketType so downstream code (line-manager, pricer) routes
  // to the correct cache entry (h2h_f5, h2h_h1, etc).
  //
  // IMPORTANT: the previous F5 regex included `1st\s*half` as an alternate
  // which incorrectly classified NBA 1st-Half markets as MLB F5. H1 and F5
  // are now detected separately with non-overlapping patterns.
  const marketName = market.name || '';
  const isF5ByName = /1st[-\s]?5th.*inning|first\s*5\s*inning|first\s*five\s*innings|\bf5\b/i.test(marketName);
  if (isF5ByName) {
    if (marketType === 'moneyline') marketType = 'first_5_innings_moneyline';
    else if (marketType === 'spread') marketType = 'first_5_innings_run_line';
    else if (marketType === 'total') marketType = 'first_5_innings_total';
  }
  // First-Half (NBA primarily; may apply to other sports if PX posts them).
  // Must run AFTER the F5 check and skip if F5 already matched, so a
  // hypothetical "First Half of 1st 5 Innings" wouldn't double-classify.
  const isH1ByName = !isF5ByName && /first\s*half|1st\s*half/i.test(marketName);
  if (isH1ByName) {
    if (marketType === 'moneyline') marketType = 'first_half_moneyline';
    else if (marketType === 'spread') marketType = 'first_half_spread';
    else if (marketType === 'total') marketType = 'first_half_total';
  }
  // Second Half (football/basketball) — same mechanism as H1 above, run after
  // it so the patterns can't overlap. Belt-and-braces for the seed-time name
  // exclusion in line-manager: even if that filter is ever relaxed, the
  // marketType can never collide with a full-game type. The measured failure
  // without this: PX's 2H total market carries line 35.5 and so does the
  // full-game ladder, so "Second Half Under 35.5" priced BYTE-IDENTICAL to the
  // full-game Under 35.5 — true P(2H under 35.5) is ~98-99%, a ~2x mispricing
  // (NFL_CFB_READINESS_2026-08-05.md). Registered lines never re-enter
  // resolveUnknownLine where the sub-game name pattern lives, so the retag
  // here is the only type-level defence.
  const isH2ByName = !isF5ByName && !isH1ByName && /second\s*half|2nd\s*half/i.test(marketName);
  if (isH2ByName) {
    if (marketType === 'moneyline') marketType = 'second_half_moneyline';
    else if (marketType === 'spread') marketType = 'second_half_spread';
    else if (marketType === 'total') marketType = 'second_half_total';
  }
  // Quarters (1st-4th, football/basketball) — same collision trap as 2H. The
  // quarter number is preserved in the type (quarter_1_total etc.) so two
  // different quarters can never alias each other either.
  const quarterMatch = (!isF5ByName && !isH1ByName && !isH2ByName)
    ? /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+quarter\b/i.exec(marketName)
    : null;
  const quarterNum = quarterMatch
    ? { '1st': 1, first: 1, '2nd': 2, second: 2, '3rd': 3, third: 3, '4th': 4, fourth: 4 }[quarterMatch[1].toLowerCase()]
    : null;
  if (quarterNum) {
    if (marketType === 'moneyline') marketType = `quarter_${quarterNum}_moneyline`;
    else if (marketType === 'spread') marketType = `quarter_${quarterNum}_spread`;
    else if (marketType === 'total') marketType = `quarter_${quarterNum}_total`;
  }

  // Team totals are also typed as 'total' by PX. The only way to distinguish
  // from full-game totals is the market NAME (e.g. "SJ: Team Total Goals",
  // "Philadelphia Phillies Team Total Runs", "Home Team Total"). Without this
  // override, the line-manager applies full-game total bounds ([4, 9] for NHL)
  // which reject all team totals as sub-game — silently losing hundreds of
  // RFQs per day to mislabeled 'alt_spread' declines. Detect by name and
  // upgrade the marketType so downstream routing uses team_total semantics.
  const isTeamTotalByName = /\bteam\s*total\b|^(home|away|[A-Z]{2,4}):\s*team/i.test(marketName);
  if (!isF5ByName && isTeamTotalByName && marketType === 'total') {
    marketType = 'team_total';
  }

  // Both Teams To Score. PX types this `moneyline` — IDENTICAL to the real
  // team moneyline and to the 3-way "<Team> to Win (90 Min)" markets (live
  // probe 2026-07-16, Toronto FC at CF Montréal: BTTS is id=1318
  // type='moneyline', the same type as id=11 "Moneyline (2 Way)"). So the
  // btts branch below, which keyed on `marketType === 'btts'`, could never
  // fire: PX has no such type. Name detection is the only signal.
  //
  // Until now this parsed as a moneyline whose selections are named YES/NO.
  // That was harmless ONLY by accident — line-manager tried to match "YES"
  // against the competitor names, failed, and dropped the line. Getting this
  // wrong in the other direction would price BTTS off the team moneyline, so
  // the name test is anchored (not a loose /both teams/ substring) and the
  // period guard below keeps a half/period variant from stealing the
  // full-game type.
  // UFC Method of Victory. PX posts FOUR per-fighter YES/NO markets, all typed
  // 'moneyline' (live probe 2026-07-17, Usman/Du Plessis — same shape trap as
  // BTTS above):
  //   "<Fighter> To Win By KO/TKO/DQ"        id 1060xxxxx
  //   "<Fighter> To Win By Submission"       id 1020xxxxx
  //   "<Fighter> To Win By Decision"         id 1070xxxxx
  //   "<Fighter> To Win Inside The Distance" id 1050xxxxx  (KO+SUB composite)
  // Without this they parse as a moneyline whose teamName is literally
  // "YES"/"NO" and get dropped when that fails competitor matching — safe only
  // by accident, and the failure mode if it ever matched would be pricing
  // "Usman by KO" off Usman's straight moneyline.
  //
  // The fighter is captured into playerName; the market NAME is the only place
  // it appears (selections are just YES/NO). "Fight To Go The Distance" is a
  // fight-level market with no fighter and deliberately does NOT match here.
  const movMatch = /^(.+?)\s+to\s+win\s+(?:by\s+(ko\/tko\/dq|ko\/tko|submission|decision)|(inside\s+the\s+distance))\s*$/i.exec(marketName.trim());
  if (movMatch) {
    const who = (movMatch[1] || '').trim();
    const how = (movMatch[2] || '').toLowerCase();
    marketType = movMatch[3] ? 'mov_itd'
      : /^ko/.test(how) ? 'mov_ko'
      : how === 'submission' ? 'mov_sub'
      : 'mov_dec';
    const results = [];
    for (const selGroup of (market.selections || [])) {
      for (const sel of (Array.isArray(selGroup) ? selGroup : [selGroup])) {
        if (!sel || !sel.line_id) continue;
        const nameLC = (sel.name || sel.display_name || '').toLowerCase();
        const selection = nameLC.includes('yes') ? 'yes' : nameLC.includes('no') ? 'no' : 'unknown';
        if (selection === 'unknown') continue;
        results.push({
          lineId: sel.line_id,
          marketType,
          selection,
          playerName: who,
          teamName: who,
          line: null,
          competitorId: sel.competitor_id || null,
          outcomeName: sel.name,
        });
      }
    }
    return results;
  }

  // FOOTBALL PLAYER PROPS. PX types these 'sup_moneyline' with YES/NO
  // selections and the player ONLY in the market name — the BTTS/MoV/
  // tennis-sets shape trap for the fourth time (probe 2026-08-05, preseason
  // event 19453: "Jeremiah Love To Score a Touchdown", market 1500029692).
  // Keyed on the NAME pattern, never on type='sup_moneyline': that type is
  // shared with series spreads/totals and soccer asian handicaps below, and
  // the failure mode of a loose match is a prop registering as marketType
  // 'moneyline' — which turns prop+total into an ALLOWED ml_total priced off
  // the team line. Anchored regex ONLY.
  //
  // Multi-player composites ("Kenny Pickett or Carson Beck To Throw An
  // Interception?") are DELIBERATELY left unmatched — no book posts a price
  // for an OR-of-two-players market, so they must stay unparsed and decline.
  // The or/and/&/slash guard below catches a conjunction that satisfies the
  // anchor ("A or B To Score a Touchdown") and fails it CLOSED (zero
  // selections, before any branch that could read YES/NO as team names).
  const tdMatch = /^(.+?)\s+to\s+score\s+a\s+touchdown\s*\??$/i.exec(marketName.trim());
  if (tdMatch) {
    const who = (tdMatch[1] || '').trim();
    // Multi-player / team-unit composites (incl. "D/ST") fail closed.
    if (!who || /\b(?:or|and)\b|[&/+,]/i.test(who)) return [];
    const results = [];
    for (const selGroup of (market.selections || [])) {
      for (const sel of (Array.isArray(selGroup) ? selGroup : [selGroup])) {
        if (!sel || !sel.line_id) continue;
        const nameLC = (sel.name || sel.display_name || '').toLowerCase();
        const selection = nameLC.includes('yes') ? 'yes' : nameLC.includes('no') ? 'no' : 'unknown';
        if (selection === 'unknown') continue;
        results.push({
          lineId: sel.line_id,
          marketType: 'player_anytime_td',
          selection,
          playerName: who,
          teamName: who,
          line: null,
          competitorId: sel.competitor_id || null,
          outcomeName: sel.name,
        });
      }
    }
    return results;
  }

  // GOLF MATCHUP ±0.5 SPREAD. PX posts TWO markets per matchup event:
  //
  //   "<A> vs. <B> (Round N Matchup)"            type='moneyline'      TIES VOID
  //   "<A> vs. <B> (Round N Matchup) - Spread"   type='sup_moneyline'  TIES COUNT
  //
  // They are DIFFERENT PRODUCTS. Measured 2026-08-27 the single-round tie rate
  // is 9.3% (8.1-9.9%, confirmed independently at 9.2% off PX's own two
  // markets), so a ±0.5 leg priced from any ties-VOID feed gives away ~9pp on
  // the +0.5 side against a 1-2pp parlay margin. It therefore gets its OWN
  // marketType — never 'moneyline' (which would alias the ties-void sibling on
  // the same event and price it off DataGolf) and never 'spread' (which would
  // route it through the alt-spread bounds/blocks and let classifySgpCombo
  // read a same-pairing pair as 'ml_spread').
  //
  // Two shape traps unique to this market:
  //   1. sel.line is 0 on BOTH sides — the ±0.5 handicap exists ONLY in the
  //      selection name, so the generic spread branches would register line 0
  //      and tag both sides 'underdog' (undefined < 0 is false), pricing a
  //      handicap as a pick'em.
  //   2. Selections are ABBREVIATED player codes of INCONSISTENT length
  //      ("SCH -0.5", "ABE +0.5", "HEN -0.5", "REIT +0.5"), and the full names
  //      appear only in the market name. Nothing can be sliced by position.
  //
  // Resolution is scoped to the TWO players named in THIS market and fails
  // closed on ambiguity — the UFC-MoV surname collision (Abus vs Shara
  // Magomedov) one notch worse, since a prefix is less specific than a
  // surname and the tour fields two Fitzpatricks, two Hojgaards and several
  // Kims. A missed market costs one market; a swapped one pays the wrong side
  // of a 56.6/43.4 line.
  const golfSpreadMatch = GOLF_MATCHUP_SPREAD_RE.exec(marketName.trim());
  if (golfSpreadMatch) {
    const players = [golfSpreadMatch[1].trim(), golfSpreadMatch[2].trim()];
    const roundNum = golfSpreadMatch[3] ? parseInt(golfSpreadMatch[3], 10) : null;
    const out = [];
    for (const selGroup of (market.selections || [])) {
      for (const sel of (Array.isArray(selGroup) ? selGroup : [selGroup])) {
        if (!sel || !sel.line_id) continue;
        const raw = String(sel.name || sel.display_name || '').trim();
        const m = /^([A-Za-z][A-Za-z'.’-]*)\s*([+-]0\.5)$/.exec(raw);
        if (!m) continue;
        const who = resolveGolfAbbrev(m[1], players);
        const line = parseFloat(m[2]);
        if (!who || !Number.isFinite(line)) continue;
        // ORDER-BOOK DEPTH. PX returns one selection entry PER RESTING PRICE
        // RUNG, all sharing the same line_id — observed live with 2 rungs on
        // one side and 4 on the other. There are still only two SIDES. Dedupe
        // on line_id (first rung wins; we price off our own board, so the
        // resting odds here are irrelevant) or the integrity check below sees
        // "6/2 sides" and declines the whole market. That failure only appears
        // once a market has depth, so it would have registered zero lines in
        // production while parsing fine against a fresh, empty book.
        if (out.some(o => o.lineId === sel.line_id)) continue;
        out.push({
          lineId: sel.line_id,
          marketType: 'golf_matchup_spread',
          // -0.5 must win outright; +0.5 wins or ties.
          selection: line < 0 ? 'favorite' : 'underdog',
          teamName: who,
          playerName: who,
          line,
          roundNum,
          competitorId: sel.competitor_id || null,
          outcomeName: raw,
        });
      }
    }
    // Whole-market integrity: exactly two sides, two DIFFERENT players, and
    // OPPOSITE handicaps. Anything else means the abbreviation resolver was
    // fooled, and half a matchup priced as if whole is worse than no quote.
    let bad = null;
    if (out.length !== 2) bad = `resolved ${out.length}/2 sides (unmatched or ambiguous abbreviation)`;
    else if (out[0].teamName === out[1].teamName) bad = `both sides resolved to the same player (${out[0].teamName})`;
    else if (Math.sign(out[0].line) === Math.sign(out[1].line)) bad = `both sides carry the same handicap sign (${out[0].line})`;
    if (bad) {
      log.warn('PX-Markets', `Golf matchup spread "${marketName}": ${bad} — declining the whole market rather than registering a partial`);
      return [];
    }
    return out;
  }

  // TENNIS SETS MARKETS. PX posts four per match (probe 2026-08-03, ATP
  // Montreal), and two of them are the BTTS/MoV shape trap yet again:
  //
  //   "1st Set Moneyline"                    type='moneyline'  id 1309
  //   "Total Sets"            line 2.5       type='total'      id 1328
  //   "<Player> To Win At Least One Set"     type='moneyline'  id 1329/1330
  //
  // The first two are the DANGEROUS ones. "1st Set Moneyline" carries PX type
  // 'moneyline' and contains the word "Moneyline", so a substring-based name
  // allowlist can admit it as the MATCH moneyline — pricing one set off the
  // full-match line. "Total Sets" carries type 'total' with a 2.5 line against
  // Total GAMES lines of 20.5-27.5; priced as a games total it is nonsense.
  // Giving them their own marketTypes makes the handling deliberate instead of
  // relying on a name filter to keep dropping them.
  //
  // The third is the MoV shape exactly: selections are literally YES/NO and the
  // player appears ONLY in the market name.
  //
  // BEST-OF-3 SEMANTICS live in the pricing source, not here — see
  // services/pinnacle-tennis.js: "+1.5 sets" is "wins at least one set" only in
  // best-of-3, and the format is inferred rather than assumed.
  const setsAlosMatch = /^(.+?)\s+to\s+win\s+at\s+least\s+(?:one|1)\s+set\s*$/i.exec(marketName.trim());
  if (setsAlosMatch) {
    const who = (setsAlosMatch[1] || '').trim();
    const results = [];
    for (const selGroup of (market.selections || [])) {
      for (const sel of (Array.isArray(selGroup) ? selGroup : [selGroup])) {
        if (!sel || !sel.line_id) continue;
        const nameLC = (sel.name || sel.display_name || '').toLowerCase();
        const selection = nameLC.includes('yes') ? 'yes' : nameLC.includes('no') ? 'no' : 'unknown';
        if (selection === 'unknown') continue;
        results.push({
          lineId: sel.line_id,
          marketType: 'set_win_at_least_one',
          selection,
          playerName: who,
          teamName: who,
          line: null,
          competitorId: sel.competitor_id || null,
          outcomeName: sel.name,
        });
      }
    }
    return results;
  }
  // Anchored: "1st Set Moneyline" / "Set 1 Moneyline". Deliberately does NOT
  // match "2nd Set ..." — we have no source for later sets, so those must stay
  // unclassified and drop rather than be priced off the first set.
  if (/^(?:1st|first)\s+set\s+moneyline\s*$/i.test(marketName.trim())
      || /^set\s*1\s+moneyline\s*$/i.test(marketName.trim())) {
    marketType = 'first_set_moneyline';
  } else if (/^total\s+sets\s*$/i.test(marketName.trim())) {
    marketType = 'total_sets';
  }

  const isBttsByName = /^both\s*teams\s*to\s*score\b/i.test(marketName.trim());
  // "Both Teams To Score in the 1st Half" is a DIFFERENT market with a
  // different fair — we have no odds for it, so leave it unclassified and
  // let it drop rather than quote it off the full-game BTTS consensus.
  const isPeriodQualified = /\b(1st|2nd|first|second)\s*(half|period)\b|\bhalf\b|\bperiod\b/i.test(marketName);
  if (isBttsByName && !isPeriodQualified && !isF5ByName && !isH1ByName) {
    marketType = 'btts';
  }

  // --- SOCCER 3-WAY (the BTTS/MoV trap again) ---
  //
  // PX types these plain 'moneyline', identical to the real "Moneyline
  // (2 Way)" draw-no-bet market, and the selections are literally YES/NO.
  // The TEAM only exists in the market NAME. Do NOT team-match the YES/NO
  // selection against the competitors: that resolves to home/away and the
  // pricer reads the leg as a straight DNB moneyline, which is a ~17pp
  // overprice (P(home|no draw) quoted as P(home)).
  //
  // Anchored on "90 Min" deliberately. PX also posts period-qualified
  // variants we have no 3-way source for; those must stay unclassified and
  // drop rather than be priced off the full-match board.
  const _mn = marketName.trim();
  const _drawMatch = /^draw\s*\(\s*90\s*min\s*\)\s*$/i.test(_mn);
  const _winMatch = _mn.match(/^(.+?)\s+to\s+win\s*\(\s*90\s*min\s*\)\s*$/i);
  let soccerWinTeam = null;
  if (_drawMatch) {
    marketType = 'soccer_draw_3way';
  } else if (_winMatch && _winMatch[1]) {
    marketType = 'soccer_win_3way';
    soccerWinTeam = _winMatch[1].trim();
  }

  // F5 moneyline uses same structure as full-game moneyline (selections array)
  const isF5Moneyline = /first_5_innings_moneyline|first_five_innings_moneyline/.test(marketType);
  // F5 spread/total uses same structure as full-game spread/total (market_lines)
  const isF5Spread = /first_5_innings_run_line|first_five_innings_run_line/.test(marketType);
  const isF5Total = /first_5_innings_total|first_five_innings_total/.test(marketType);
  // H1 (First Half) markets use the same structures as full-game — moneyline
  // uses .selections, spread/total uses .market_lines. We need these booleans
  // separate from the string equality checks below (marketType is now
  // 'first_half_moneyline'/'first_half_spread'/'first_half_total' after the
  // name-detection override above).
  const isH1Moneyline = /first_half_moneyline|1st_half_moneyline/.test(marketType);
  const isH1Spread = /first_half_spread|1st_half_spread/.test(marketType);
  const isH1Total = /first_half_total|1st_half_total/.test(marketType);
  // H2 + quarter types (retagged above) reuse the same structures. Building
  // their selections keeps the retagged marketType attached to every leg;
  // downstream registration drops the unknown types (no odds source exists),
  // which is the fail-closed path — what must NEVER happen is these legs
  // carrying a full-game marketType.
  const isH2Moneyline = /second_half_moneyline|2nd_half_moneyline/.test(marketType);
  const isH2Spread = /second_half_spread|2nd_half_spread/.test(marketType);
  const isH2Total = /second_half_total|2nd_half_total/.test(marketType);
  const isQuarterMoneyline = /^quarter_[1-4]_moneyline$/.test(marketType);
  const isQuarterSpread = /^quarter_[1-4]_spread$/.test(marketType);
  const isQuarterTotal = /^quarter_[1-4]_total$/.test(marketType);

  // PX uses `type: 'sup_moneyline'` for Series Game Spread + Series Total
  // Games (live probe 2026-04-18). Selections are structured like moneyline
  // (flat selections array) but the 'line' field is zero — the actual
  // line + side are encoded in the selection name (e.g. "MIN +1.5",
  // "Over 5.5"). Detect by market name and retag marketType so the seed's
  // series handling picks it up.
  const isSupSeriesSpread = market.type === 'sup_moneyline'
    && (/\bseries\s*(game\s*)?(spread|handicap)\b/i.test(marketName)
        || /\bseries\b[^.]*\bspread\b/i.test(marketName));
  const isSupSeriesTotal = market.type === 'sup_moneyline'
    && !isSupSeriesSpread
    && (/\bseries\s*total\s*games\b/i.test(marketName)
        || /\btotal\s*games\b/i.test(marketName)
        || /\bseries\b[^.]*\btotal\b/i.test(marketName));
  // Soccer asian-handicap spreads: PX publishes them under type='sup_moneyline'
  // with name "Spread (Regular Time)". Verified 2026-05-03 EPL Tottenham FC at
  // Aston Villa FC and other EPL/UCL/sub-league games — all soccer spreads
  // ride this type-name combo. Without retagging, line-manager's supportedBase
  // gate rejects them and EPL/UCL/etc spread coverage drops to zero.
  const isSupSoccerSpread = market.type === 'sup_moneyline'
    && !isSupSeriesSpread
    && !isSupSeriesTotal
    && /^spread\b/i.test(marketName);
  if (isSupSeriesSpread) marketType = 'spread';      // retagged to 'series_spread' by line-manager
  else if (isSupSeriesTotal) marketType = 'total';   // retagged to 'series_total' by line-manager
  else if (isSupSoccerSpread) marketType = 'spread'; // soccer asian-handicap spread

  if (isSupSeriesSpread && market.selections) {
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        const raw = (sel.display_name || sel.name || '').trim();
        // Parse "TEAM +/-N.N" (e.g. "MIN +1.5", "DEN -2.5"). Team portion
        // is everything before the signed number.
        const m = raw.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)$/);
        if (!m) continue;
        const teamName = m[1].trim();
        const line = parseFloat(m[2]);
        if (!Number.isFinite(line)) continue;
        results.push({
          lineId: sel.line_id,
          marketType: 'spread',
          selection: line < 0 ? 'favorite' : 'underdog',
          teamName,
          line,
          competitorId: sel.competitor_id || null,
          outcomeName: raw,
        });
      }
    }
    return results;
  }

  // SPREAD TYPED 'sup_moneyline' WITH THE HANDICAP ONLY IN THE NAME.
  // Verified live on CFL 2026-08-29 (Toronto @ Saskatchewan): PX posts
  // type='sup_moneyline', market name "Spread", selections "SAS -4.5" /
  // "TOR +4.5" — and sel.line is 0 on BOTH. NFL/NCAAF use type='spread' with a
  // real sel.line, which is why this only bites the leagues PX models this way.
  //
  // Falling through to the generic spread path would register line 0 and, since
  // `0 < 0` is false, tag BOTH sides 'underdog' — a -4.5 spread priced as a
  // pick'em on the wrong side. Same shape as the golf matchup spread trap.
  //
  // Only claims the market when BOTH sides parse to a signed number; otherwise
  // it falls through untouched so the existing soccer asian-handicap handling
  // (which does carry sel.line) is unaffected.
  if (isSupSoccerSpread && market.selections) {
    const named = [];
    for (const selGroup of market.selections) {
      for (const sel of (Array.isArray(selGroup) ? selGroup : [selGroup])) {
        if (!sel || !sel.line_id) continue;
        const raw = (sel.display_name || sel.name || '').trim();
        const mm = raw.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)$/);
        if (!mm) continue;
        const line = parseFloat(mm[2]);
        if (!Number.isFinite(line)) continue;
        named.push({
          lineId: sel.line_id,
          marketType: 'spread',
          selection: line < 0 ? 'favorite' : 'underdog',
          teamName: mm[1].trim(),
          line,
          competitorId: sel.competitor_id || null,
          outcomeName: raw,
        });
      }
    }
    // Require a clean two-sided market with OPPOSITE signs. A half-parsed
    // spread priced as if whole is worse than no quote.
    const okPair = named.length === 2
      && named[0].teamName !== named[1].teamName
      && Math.sign(named[0].line) !== Math.sign(named[1].line);
    if (okPair) return named;
    if (named.length) {
      log.warn('PX-Markets', `sup_moneyline spread "${marketName}": ${named.length}/2 sides parsed from names — falling through to the generic path`);
    }
  }

  if (isSupSeriesTotal && market.selections) {
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        const raw = (sel.display_name || sel.name || '').trim();
        // Parse "Over N.N" / "Under N.N"
        const m = raw.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
        if (!m) continue;
        const side = m[1].toLowerCase();
        const line = parseFloat(m[2]);
        if (!Number.isFinite(line)) continue;
        results.push({
          lineId: sel.line_id,
          marketType: 'total',
          selection: side,
          teamName: side,
          line,
          competitorId: null,
          outcomeName: raw,
        });
      }
    }
    return results;
  }

  // `first_set_moneyline` reuses the moneyline builder verbatim: PX gives it
  // the same two-competitor shape, and line-manager's home/away matching then
  // works unchanged. Only the marketType differs, which is what stops it being
  // priced off the MATCH line.
  if ((marketType === 'moneyline' || marketType === 'first_set_moneyline'
       || isF5Moneyline || isH1Moneyline || isH2Moneyline || isQuarterMoneyline) && market.selections) {
    // Moneyline: selections is array of arrays, each inner array has one object
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        results.push({
          lineId: sel.line_id,
          marketType, // preserves F5/H1 market type name
          selection: sel.competitor_id ? 'team' : 'unknown',
          teamName: cleanSelectionName(sel.display_name || sel.name || ''),
          line: null,
          competitorId: sel.competitor_id,
          outcomeName: sel.name,
        });
      }
    }
  } else if ((marketType === 'spread' || marketType === 'total' || marketType === 'team_total'
             || marketType === 'total_sets' || isF5Spread || isF5Total || isH1Spread || isH1Total
             || isH2Spread || isH2Total || isQuarterSpread || isQuarterTotal)
             && market.market_lines) {
    // Spread/Total: market_lines array, each with selections
    // Include ALL alternate lines so we can respond to any RFQ
    //
    // For team_total markets, the selection display_name is "Over N" / "Under N"
    // and doesn't identify which team. Extract the team hint from the market
    // name (e.g. "SJ: Team Total Goals" → "SJ"). The line-manager matches
    // this hint against home/away team names (via abbreviation maps) to
    // determine the side.
    let teamHint = null;
    if (marketType === 'team_total') {
      // Pattern 1: "ABC: Team Total ..." or "ABC Team Total ..."
      const m1 = marketName.match(/^([^:]+?)(?::|\s+)\s*Team\s*Total/i);
      // Pattern 2: "Team Name Team Total ..." (team name before "Team Total")
      const m2 = marketName.match(/^(.+?)\s+Team\s+Total/i);
      teamHint = (m1 && m1[1].trim()) || (m2 && m2[1].trim()) || null;
    }

    for (const marketLine of market.market_lines) {
      for (const selGroup of (marketLine.selections || [])) {
        for (const sel of selGroup) {
          if (!sel.line_id) continue;

          let selection = 'unknown';
          if (marketType === 'spread' || isF5Spread || isH1Spread || isH2Spread || isQuarterSpread) {
            selection = sel.line < 0 ? 'favorite' : 'underdog';
          } else if (marketType === 'total' || marketType === 'team_total' || marketType === 'total_sets'
                     || isF5Total || isH1Total || isH2Total || isQuarterTotal) {
            const nameLC = (sel.name || sel.display_name || '').toLowerCase();
            selection = nameLC.includes('over') ? 'over' : nameLC.includes('under') ? 'under' : 'unknown';
          }

          // For team_total legs, pass the extracted team hint as teamName so
          // line-manager's home/away matching can work. Fall back to the
          // selection display name for non-team-total legs.
          const teamForLeg = marketType === 'team_total' && teamHint
            ? teamHint
            : cleanSelectionName(sel.display_name || sel.name || '');

          results.push({
            lineId: sel.line_id,
            marketType, // preserves F5 market type name
            selection,
            teamName: teamForLeg,
            line: sel.line != null ? sel.line : marketLine.line,
            competitorId: sel.competitor_id,
            outcomeName: sel.name,
            isFavourite: !!marketLine.favourite,
          });
        }
      }
    }
  } else if ((marketType === 'spread' || marketType === 'total' || marketType === 'team_total'
             || marketType === 'total_sets' || isF5Spread || isF5Total) && market.selections) {
    // Fallback: spread/total market with selections directly (no market_lines
    // wrapper). PX sometimes returns alt lines as SEPARATE market entries,
    // each a flat spread/total market with its own selections array. Without
    // this branch we'd miss thousands of alt spreads/totals per day and
    // decline 'unknown legs' unnecessarily. market.line carries the value.
    const topLine = market.line;
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        const legLine = sel.line != null ? sel.line : topLine;
        let selection = 'unknown';
        if (marketType === 'spread' || isF5Spread) {
          selection = (legLine != null && legLine < 0) ? 'favorite' : 'underdog';
        } else if (marketType === 'total' || marketType === 'team_total' || marketType === 'total_sets' || isF5Total) {
          const nameLC = (sel.name || sel.display_name || '').toLowerCase();
          selection = nameLC.includes('over') ? 'over' : nameLC.includes('under') ? 'under' : 'unknown';
        }
        results.push({
          lineId: sel.line_id,
          marketType,
          selection,
          teamName: cleanSelectionName(sel.display_name || sel.name || ''),
          line: legLine,
          competitorId: sel.competitor_id,
          outcomeName: sel.name,
        });
      }
    }
  } else if ((marketType === 'btts' || marketType === 'both_teams_to_score') && market.selections) {
    // BTTS: selections array, Yes/No outcomes
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        const nameLC = (sel.name || sel.display_name || '').toLowerCase();
        const selection = nameLC.includes('yes') ? 'yes' : nameLC.includes('no') ? 'no' : 'unknown';
        results.push({
          lineId: sel.line_id,
          marketType: 'btts',
          selection,
          teamName: sel.display_name || sel.name || '',
          line: null,
          competitorId: sel.competitor_id,
          outcomeName: sel.name,
        });
      }
    }
  } else if ((marketType === 'soccer_win_3way' || marketType === 'soccer_draw_3way') && market.selections) {
    // YES/NO shaped like BTTS. teamName carries the club parsed from the
    // MARKET NAME (null for Draw, which has no team), never the YES/NO
    // selection text -- see the trap note above.
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        const nameLC = (sel.name || sel.display_name || '').toLowerCase();
        const selection = nameLC.includes('yes') ? 'yes' : nameLC.includes('no') ? 'no' : 'unknown';
        results.push({
          lineId: sel.line_id,
          marketType,
          selection,
          teamName: soccerWinTeam,
          line: null,
          competitorId: sel.competitor_id,
          outcomeName: sel.name,
        });
      }
    }
  } else if (marketType === 'double_chance' && market.selections) {
    // Double Chance: 3-way selections — 1X, X2, 12
    for (const selGroup of market.selections) {
      for (const sel of selGroup) {
        if (!sel.line_id) continue;
        const nameLC = (sel.name || sel.display_name || '').toLowerCase().replace(/\s+/g, '');
        let selection = 'unknown';
        if (nameLC.includes('1x') || nameLC.includes('homeordraw') || nameLC.includes('home/draw')) selection = '1X';
        else if (nameLC.includes('x2') || nameLC.includes('awayordraw') || nameLC.includes('draw/away') || nameLC.includes('draworaway')) selection = 'X2';
        else if (nameLC.includes('12') || nameLC.includes('homeoraway') || nameLC.includes('home/away')) selection = '12';
        results.push({
          lineId: sel.line_id,
          marketType: 'double_chance',
          selection,
          teamName: sel.display_name || sel.name || '',
          line: null,
          competitorId: sel.competitor_id,
          outcomeName: sel.name,
        });
      }
    }
  }

  return results;
}

// Registration-safety assertion for football player props — the BTTS/MoV/
// tennis-sets marketType trap, fourth occurrence. Everything protecting
// same-game prop stacks in the pricer (prop_correlation_same_game) keys on
// the /^player_/ marketType prefix, and PX types football props
// 'sup_moneyline': a football prop that slips through registration carrying a
// full-game marketType turns prop+total into an ALLOWED ml_total priced off
// the team moneyline. The registration path must call this for every football
// prop line and REFUSE (fail closed) any line for which it returns false.
//
// Absence-safe by design: null/undefined/'' are NOT safe, and only /^player_/
// types pass — so the forbidden full-game set {moneyline, spread, total,
// team_total} can never sneak through, nor can a period retag
// (first_half_* / second_half_* / quarter_N_*), 'sup_moneyline' itself, or a
// typo'd/unknown type.
const FOOTBALL_PROP_FORBIDDEN_MARKET_TYPES = new Set(['moneyline', 'spread', 'total', 'team_total']);
function isFootballPropMarketTypeSafe(marketType) {
  if (typeof marketType !== 'string') return false;
  const mt = marketType.trim().toLowerCase();
  if (!mt) return false;
  if (FOOTBALL_PROP_FORBIDDEN_MARKET_TYPES.has(mt)) return false;
  return /^player_[a-z0-9_]+$/.test(mt);
}

function clearCooldown() {
  loginCooldownUntil = 0;
}

module.exports = {
  login,
  invalidateToken,
  clearCooldown,
  pxFetch,
  fetchSportEvents,
  fetchMarkets,
  getMarketsCacheStats,
  fetchAffiliateSportEvents,
  fetchAffiliateMultipleMarkets,
  fetchAffiliateTournaments,
  registerSupportedLines,
  removeSupportedLines,
  getSupportedLines,
  getWebSocketConfig,
  registerWebSocket,
  submitOffer,
  confirmOrder,
  fetchBalance,
  fetchOrders,
  fetchOrderByUuid,
  parseMarketSelections,
  GOLF_MATCHUP_SPREAD_RE,
  resolveGolfAbbrev,
  golfNormName,
  isFootballPropMarketTypeSafe,
};
