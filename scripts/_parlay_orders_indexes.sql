-- parlay_orders timestamp indexes
-- ---------------------------------------------------------------------------
-- WHY: analytics/reporting queries that order or filter parlay_orders by
-- quoted_at / confirmed_at / settled_at were full-table-scanning and hitting
-- Supabase's statement timeout (per-ET-day fill counts, hour-of-week,
-- getTotalPnL, and the /network-share card — which silently showed 0 fills /
-- 0% bid-win because its confirmed_at/quoted_at head-counts timed out).
--
-- HOW TO RUN: paste into the Supabase SQL editor and run. These are PLAIN
-- CREATE INDEX (not CONCURRENTLY) because the SQL editor wraps statements in a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside one (error
-- 25001). Plain CREATE INDEX takes a brief write-lock on parlay_orders while it
-- builds (a few seconds — the table is ~877K rows). This is SAFE during live
-- trading: the app's parlay_orders writes are fire-and-forget (.catch) and PX
-- offer submission is independent of DB recording, so the worst case is a few
-- seconds of delayed local writes — no missed quotes, no data loss. Still,
-- prefer a quiet window if convenient. IF NOT EXISTS makes it safe to re-run.
--
-- ZERO-LOCK ALTERNATIVE: if you'd rather take no write-lock at all, run the
-- CONCURRENTLY form (one statement at a time, autocommit) over a DIRECT
-- connection instead of the SQL editor — Supabase → Project Settings →
-- Database → Connection string, then psql:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parlay_orders_quoted_at    ON parlay_orders (quoted_at DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parlay_orders_confirmed_at ON parlay_orders (confirmed_at DESC) WHERE confirmed_at IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parlay_orders_settled_at   ON parlay_orders (settled_at DESC) WHERE settled_at IS NOT NULL;
--
-- DEPLOY ORDERING: indexes are transparent to the application — no code change
-- depends on them. Run any time.
-- ---------------------------------------------------------------------------

-- Fill scans (per-day confirmed counts, /network-share card). Partial — only
-- ~7k rows have confirmed_at, so this builds fast. Fixes the fills=0 card.
CREATE INDEX IF NOT EXISTS idx_parlay_orders_confirmed_at
  ON parlay_orders (confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

-- Settlement scans (P&L by day, getTotalPnL). Partial — small, builds fast.
CREATE INDEX IF NOT EXISTS idx_parlay_orders_settled_at
  ON parlay_orders (settled_at DESC)
  WHERE settled_at IS NOT NULL;

-- Quote-time scans (quotes-today, hour-of-week). Full ~877K-row index — the
-- largest/slowest build (a few-second write-lock). Lower priority than the two
-- partials above; if you want to avoid the lock, do this one via the
-- CONCURRENTLY-over-psql alternative noted in the header.
CREATE INDEX IF NOT EXISTS idx_parlay_orders_quoted_at
  ON parlay_orders (quoted_at DESC);
