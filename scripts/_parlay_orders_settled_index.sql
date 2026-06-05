-- ============================================================================
-- Index for status-filtered / settled-row scans on parlay_orders.
--
-- WHY: parlay_orders has grown large enough that queries filtering
-- `status LIKE 'settled_%'` (optionally with a settled_at range) do a FULL TABLE
-- SCAN and exceed Supabase's ~8s statement_timeout. Confirmed 2026-06-04: even a
-- 50-row settled read times out, while a tiny unfiltered PK read returns in
-- ~560ms. This breaks:
--   * the /bankroll endpoint's "settled since snapshotAt" query (index.js ~2394)
--   * getDailyPnL / getTotalPnL (services/db.js)
--   * the rev-N bankroll seed replays (scripts/_seed_bankroll_revN.js)
--
-- FIX: a composite btree on (status, settled_at). `status LIKE 'settled_%'` is a
-- prefix match → range scan over the three settled_* values; settled_at as the
-- 2nd column then serves range/order within each. Also covers the bankroll
-- handler's `status IN (...) AND settled_at >= X` shape.
--
-- Run ONCE in the Supabase SQL editor. CONCURRENTLY avoids locking the table
-- (so live trading isn't blocked) but CANNOT run inside a transaction block —
-- paste it as a single standalone statement. Safe to re-run (IF NOT EXISTS).
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS parlay_orders_status_settled_at_idx
  ON public.parlay_orders (status, settled_at);

-- After it builds, the /bankroll endpoint should respond reliably and the rev-7
-- seed replay (scripts/_seed_bankroll_rev7.js) will run without timing out.
