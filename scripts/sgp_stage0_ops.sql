-- SGP roadmap Stage 0 — one-time Supabase ops (run in the SQL editor).
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.

-- 1. Closing-line persistence (CLV history must survive deploys — the
--    in-memory cache is wiped on every Railway restart). Written by
--    db.saveClosingLine (write-through from captureClosingLines).
CREATE TABLE IF NOT EXISTS closing_lines (
  cache_key     TEXT PRIMARY KEY,
  sport         TEXT,
  home_team     TEXT,
  away_team     TEXT,
  commence_time TIMESTAMPTZ,
  captured_at   TIMESTAMPTZ DEFAULT NOW(),
  snapshot      JSONB
);
CREATE INDEX IF NOT EXISTS idx_closing_lines_commence ON closing_lines (commence_time DESC);
CREATE INDEX IF NOT EXISTS idx_closing_lines_sport ON closing_lines (sport, commence_time DESC);

-- 2. sgp_audit dedup hash (raw decline counts are ~3.5x bot-inflated;
--    COUNT(DISTINCT leg_hash) gives true unique-shape demand). The code
--    degrades gracefully until this runs (logs without the hash).
ALTER TABLE sgp_audit ADD COLUMN IF NOT EXISTS leg_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_sgp_audit_leg_hash ON sgp_audit (leg_hash);

-- 3. Declines-table index for demand/diagnostics queries by reason+time.
--    NOTE: the declines table is ~63M rows — CONCURRENTLY avoids locking
--    writes during the build, but CANNOT run inside a transaction. In the
--    Supabase SQL editor run this statement BY ITSELF (it auto-commits per
--    statement; if it errors about transactions, run it via a direct
--    psql connection instead).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_declines_reason_at
  ON declines (reason, declined_at DESC);
