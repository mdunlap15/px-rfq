-- ============================================================================
-- 7-day rollup as a SQL aggregate (the REAL fix for the loadDeclinesSince
-- perf problem). Run these CREATE FUNCTION statements ONCE in the Supabase
-- SQL editor. They are safe/idempotent (CREATE OR REPLACE) and read-only.
--
-- BACKGROUND
-- services/order-tracker.js: refreshPersistentRollup7d() currently pulls up to
-- 200k `declines` rows + 50k `matched_parlays` rows into Node every refresh and
-- aggregates them in JS. Production logs showed 78-119 SECONDS per pass and the
-- 200k cap being hit (so the JS rollup was also silently truncated). Everything
-- it computes is a GROUP BY aggregate — none of it needs row-level data in Node.
--
-- The interval bump + DESC ordering already shipped (held) as a stopgap. This
-- RPC is the durable fix: it turns a 119s / 200k-row transfer into a single
-- indexed aggregate returning a few hundred rows in well under a second.
--
-- DEPLOY ORDER
--   1) Run this SQL in Supabase (creates the two functions + the index).
--   2) Then wire services/db.js to call them via client.rpc(...) and have
--      refreshPersistentRollup7d() consume the aggregated shape. (Code change
--      is held separately — do NOT wire it until these functions exist, or the
--      rollup will error and fall back to empty.)
--
-- PARITY NOTES (must match the JS aggregation in order-tracker.js ~2173-2251)
--   * declinesByReason            -> declines_rollup.cnt grouped by reason
--   * volumeByReason.totalLegs    -> declines_rollup.total_legs
--   * volumeByReason.byLegCount   -> declines_leg_histogram (bucketed, 10+ )
--   * riskLimitMissed.byDay       -> declines_rollup filtered to the 4 reasons
--   * missedVolume                -> matched_missed_rollup (we_quoted = false)
-- ============================================================================

-- Supporting index for the windowed scan (declined_at is the filter+sort key).
CREATE INDEX IF NOT EXISTS idx_declines_declined_at ON declines (declined_at);

-- ----------------------------------------------------------------------------
-- 1) Per-reason, per-day counts + leg totals over a window.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION declines_rollup(from_ts timestamptz)
RETURNS TABLE (
  reason      text,
  day         date,
  cnt         bigint,
  total_legs  bigint
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(reason, 'unknown')                            AS reason,
    (declined_at AT TIME ZONE 'America/New_York')::date    AS day,
    count(*)                                               AS cnt,
    COALESCE(sum(jsonb_array_length(
      CASE WHEN jsonb_typeof(known_legs) = 'array'
           THEN known_legs ELSE '[]'::jsonb END)), 0)      AS total_legs
  FROM declines
  WHERE declined_at >= from_ts
  GROUP BY 1, 2;
$$;

-- ----------------------------------------------------------------------------
-- 2) Leg-count histogram (0..10, then 10+) per reason. Drives the
--    volumeByReason.byLegCount breakdown shown in the dashboard declines table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION declines_leg_histogram(from_ts timestamptz)
RETURNS TABLE (
  reason     text,
  leg_bucket text,
  cnt        bigint
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(reason, 'unknown') AS reason,
    CASE WHEN n > 10 THEN '10+' ELSE n::text END AS leg_bucket,
    count(*) AS cnt
  FROM (
    SELECT
      reason,
      jsonb_array_length(
        CASE WHEN jsonb_typeof(known_legs) = 'array'
             THEN known_legs ELSE '[]'::jsonb END) AS n
    FROM declines
    WHERE declined_at >= from_ts
  ) s
  GROUP BY 1, 2;
$$;

-- ----------------------------------------------------------------------------
-- 3) Missed matched volume (parlays that matched on PX where we did NOT quote),
--    joined back to our decline reason by parlay_id. Per-reason + per-day.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION matched_missed_rollup(from_ts timestamptz)
RETURNS TABLE (
  reason       text,
  day          date,
  cnt          bigint,
  total_stake  numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(d.reason, 'not seen')                       AS reason,
    (m.matched_at AT TIME ZONE 'America/New_York')::date AS day,
    count(*)                                             AS cnt,
    COALESCE(sum(m.matched_stake), 0)                    AS total_stake
  FROM matched_parlays m
  LEFT JOIN LATERAL (
    SELECT reason FROM declines d
    WHERE d.parlay_id = m.parlay_id
    ORDER BY d.declined_at DESC
    LIMIT 1
  ) d ON true
  WHERE m.matched_at >= from_ts
    AND m.we_quoted = false
  GROUP BY 1, 2;
$$;

-- Quick smoke test (last 7 days):
--   select * from declines_rollup(now() - interval '7 days') order by day desc, cnt desc;
--   select * from declines_leg_histogram(now() - interval '7 days') order by reason, leg_bucket;
--   select * from matched_missed_rollup(now() - interval '7 days') order by day desc, total_stake desc;
