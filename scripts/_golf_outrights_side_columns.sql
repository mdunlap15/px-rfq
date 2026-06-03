-- ============================================================================
-- Golf Outrights — YES/NO posting side support.
-- Run ONCE in the Supabase SQL editor BEFORE deploying the side-toggle feature
-- (idempotent / safe to re-run). Then click Sync on each tournament so the new
-- px_no_line_id column gets populated from PX.
--
--  px_no_line_id : the NO selection's PX line_id for this player market. Needed
--                  to post the NO side (we hold NO; the counterparty backs YES at
--                  our offered price). px_line_id remains the YES selection.
--  post_side     : which side WE post. 'no' (default) = lay the field: post on the
--                  NO line at the complement so the counterparty backs YES at the
--                  offered price (e.g. McIlroy offered YES +193 -> we post NO -193).
--                  'yes' = back the player: post on the YES line at the offered
--                  price. Per-row, operator-toggled, preserved across syncs.
-- ============================================================================

ALTER TABLE public.golf_outright_config
  ADD COLUMN IF NOT EXISTS px_no_line_id text,
  ADD COLUMN IF NOT EXISTS post_side text NOT NULL DEFAULT 'no';

-- (Existing rows get post_side='no' — the corrected "lay the field" behavior.
--  px_no_line_id stays NULL until the next Sync repopulates it from PX.)
