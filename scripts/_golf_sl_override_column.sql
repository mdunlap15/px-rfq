-- ============================================================================
-- Per-line manual override for the Golf Single-Leg book.
-- Run ONCE in the Supabase SQL editor BEFORE deploying the editable-line
-- feature (idempotent / safe to re-run).
--
-- Stores the American odds a counterparty pays to BACK this player. NULL = use
-- the auto markup (GOLF_SL_MATCHUP_SWEETENER_PCT). A value overrides that one
-- line — edited via the "Our Offered" field on the Golf Single-Leg tab.
-- ============================================================================

ALTER TABLE golf_single_leg_config
  ADD COLUMN IF NOT EXISTS manual_offered_american numeric;

-- (No backfill — existing rows stay NULL and keep auto-loading at the markup.)
