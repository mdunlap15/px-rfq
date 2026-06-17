-- parlay_orders timestamp indexes
-- ---------------------------------------------------------------------------
-- WHY: analytics/reporting queries that order or filter parlay_orders by
-- quoted_at / confirmed_at / settled_at were doing full-table scans and
-- hitting Supabase's statement timeout once the table grew (observed: every
-- per-ET-day fill-count query and the hour-of-week endpoint timed out;
-- getTotalPnL had to paginate getDailyPnL as a workaround). These btree
-- indexes make the newest-first range scans (the dominant access pattern)
-- index-only instead of a full scan.
--
-- HOW TO RUN: paste into the Supabase SQL editor and run. CREATE INDEX
-- CONCURRENTLY does NOT lock the table against writes (parlay_orders is
-- written on every quote), but it CANNOT run inside a transaction block —
-- run these as individual statements (the SQL editor does this by default;
-- do NOT wrap in BEGIN/COMMIT). IF NOT EXISTS makes it safe to re-run.
--
-- DEPLOY ORDERING: indexes are transparent to the application — no code
-- change depends on them and running this never breaks anything. Run any
-- time, before or after a deploy.
-- ---------------------------------------------------------------------------

-- Quote-time scans (e.g. "quotes today", hour-of-week). DESC matches the
-- newest-first ordering every caller uses.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parlay_orders_quoted_at
  ON parlay_orders (quoted_at DESC);

-- Fill scans (e.g. per-day confirmed counts). Partial — every fill query
-- filters confirmed_at IS NOT NULL, and most rows never confirm, so the
-- partial index is far smaller and faster than a full one.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parlay_orders_confirmed_at
  ON parlay_orders (confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

-- Settlement scans (P&L by day, settled-row counts). Same partial rationale.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parlay_orders_settled_at
  ON parlay_orders (settled_at DESC)
  WHERE settled_at IS NOT NULL;
