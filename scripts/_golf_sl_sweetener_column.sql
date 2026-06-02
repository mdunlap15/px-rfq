-- ============================================================================
-- Per-matchup sweetener for the Golf Single-Leg book.
-- Run ONCE in the Supabase SQL editor BEFORE deploying the per-row sweetener
-- feature (idempotent / safe to re-run).
--
-- Adds an optional per-side markup. NULL = use the global default
-- (GOLF_SL_MATCHUP_SWEETENER_PCT, currently 0.07). A positive value overrides
-- the global for that side. Stored as a FRACTION (0.07 = 7%), matching the
-- global env var's convention. The dashboard shows/edits it in whole percent.
-- ============================================================================

ALTER TABLE golf_single_leg_config
  ADD COLUMN IF NOT EXISTS sweetener_pct numeric;

-- (No backfill — existing rows stay NULL and fall back to the global default.)
