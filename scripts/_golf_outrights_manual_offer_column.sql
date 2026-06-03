-- ============================================================================
-- Golf Outrights — per-row manual offer override.
-- Run ONCE in the Supabase SQL editor before deploying the editable-offer
-- feature (idempotent / safe to re-run).
--
--  manual_offered_american : the YES price a counterparty pays to back this
--    player, typed by the operator in the "Our Offered (YES)" field. NULL = use
--    the auto price (DK american x (1 + sweetener)). The Side toggle still
--    decides how it posts: NO posts the complement on the NO line; YES posts
--    this price on the YES line.
-- ============================================================================

ALTER TABLE public.golf_outright_config
  ADD COLUMN IF NOT EXISTS manual_offered_american numeric;

-- (Existing rows stay NULL = auto. Set per-row in the UI; preserved across syncs.)
