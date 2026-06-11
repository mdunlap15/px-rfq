/**
 * World Cup soccer player-prop cache (READ side).
 *
 * The decoupled worker (scripts/dk-wc-props-worker.js — runs OFF this box)
 * scrapes DraftKings goalscorer / shots-on-target / assists prices and
 * upserts them into the Supabase `wc_player_props` table. This service polls
 * that table into memory so line-manager registration and pricing can do
 * synchronous lookups. NO browser, NO scraping, NO writes happen here.
 *
 * Markets: 'goalscorer' | 'sot_1' | 'sot_2' | 'assists'
 * Key:     `${px_event_id}|${player_key}|${market}`
 *
 * Freshness is enforced downstream by pricer's existing prop_stale gate
 * (15 min on lineInfo.propFetchedAt) — this cache just carries scraped_at
 * through. Rows older than WC_PROP_CACHE_MAX_AGE_HOURS (default 24) are
 * dropped at poll time purely to bound memory.
 */
const db = require('./db');
const log = require('./logger');

const POLL_MINUTES = Number(process.env.WC_PROPS_POLL_MINUTES) || 2;
const CACHE_MAX_AGE_HOURS = Number(process.env.WC_PROP_CACHE_MAX_AGE_HOURS) || 24;

let _cache = new Map();      // key -> { american, scrapedAtMs, playerName, matchLabel }
let _byEvent = new Map();    // px_event_id -> Set(keys)
let _lastPollAt = null;
let _lastPollError = null;
let _pollTimer = null;

// Same normalization as the worker's norm() — diacritics stripped, lowercase,
// non-alphanumerics collapsed. PX "Raúl Jiménez" and DK "Raul Jimenez" both
// map to "raul jimenez".
function normPlayerKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function americanToImplied(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

async function refresh() {
  const client = db.getClient();
  if (!client) { _lastPollError = 'supabase not configured'; return 0; }
  try {
    const cutoff = new Date(Date.now() - CACHE_MAX_AGE_HOURS * 3600 * 1000).toISOString();
    // Paginate: Supabase clips any response at 1000 rows regardless of
    // .limit() — a single fetch silently dropped 167 of the first 1167-row
    // scrape. Page on the composite PK ordering until a short page.
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from('wc_player_props')
        .select('px_event_id, player_key, market, american, player_name, match_label, scraped_at')
        .gte('scraped_at', cutoff)
        .order('px_event_id', { ascending: true })
        .order('player_key', { ascending: true })
        .order('market', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
      if (from > 50000) break; // runaway guard
    }
    const next = new Map();
    const nextByEvent = new Map();
    for (const r of all) {
      const key = `${r.px_event_id}|${r.player_key}|${r.market}`;
      next.set(key, {
        american: r.american,
        scrapedAtMs: r.scraped_at ? new Date(r.scraped_at).getTime() : null,
        playerName: r.player_name,
        matchLabel: r.match_label,
      });
      if (!nextByEvent.has(r.px_event_id)) nextByEvent.set(r.px_event_id, new Set());
      nextByEvent.get(r.px_event_id).add(key);
    }
    _cache = next;
    _byEvent = nextByEvent;
    _lastPollAt = Date.now();
    _lastPollError = null;
    return _cache.size;
  } catch (err) {
    _lastPollError = err.message;
    log.warn('WCProps', `cache refresh failed: ${err.message}`);
    return -1;
  }
}

function startPolling() {
  if (_pollTimer) return;
  refresh().then(n => {
    if (n >= 0) log.info('WCProps', `initial cache load: ${n} rows`);
  }).catch(() => {});
  _pollTimer = setInterval(() => { refresh().catch(() => {}); }, POLL_MINUTES * 60 * 1000);
  if (_pollTimer.unref) _pollTimer.unref();
}

/** Sync lookup. Returns { american, impliedProb, scrapedAtMs } or null. */
function lookup(pxEventId, playerNameOrKey, market) {
  const key = `${pxEventId}|${normPlayerKey(playerNameOrKey)}|${market}`;
  const hit = _cache.get(key);
  if (!hit) return null;
  const impliedProb = americanToImplied(hit.american);
  if (impliedProb == null) return null;
  return { american: hit.american, impliedProb, scrapedAtMs: hit.scrapedAtMs };
}

/** Event ids that currently have cached props (drives registration). */
function getEventIds() {
  return [...new Map(_byEvent).keys()];
}

function getStatus() {
  const byMarket = {};
  for (const k of _cache.keys()) {
    const m = k.split('|').pop();
    byMarket[m] = (byMarket[m] || 0) + 1;
  }
  let newest = null, oldest = null;
  for (const v of _cache.values()) {
    if (v.scrapedAtMs != null) {
      if (newest == null || v.scrapedAtMs > newest) newest = v.scrapedAtMs;
      if (oldest == null || v.scrapedAtMs < oldest) oldest = v.scrapedAtMs;
    }
  }
  return {
    rows: _cache.size,
    events: _byEvent.size,
    byMarket,
    newestScrapeAgoMin: newest != null ? Math.round((Date.now() - newest) / 60000) : null,
    oldestScrapeAgoMin: oldest != null ? Math.round((Date.now() - oldest) / 60000) : null,
    lastPollAt: _lastPollAt ? new Date(_lastPollAt).toISOString() : null,
    lastPollError: _lastPollError,
    pollMinutes: POLL_MINUTES,
  };
}

module.exports = { refresh, startPolling, lookup, getEventIds, getStatus, normPlayerKey, americanToImplied };
