-- prop_settlements: realized box-score outcomes for MLB hitter-prop parlays.
-- Populated by services/prop-settlement.js (settleRecent) from the free MLB
-- Stats API. Read by /prop-correlation to produce live-calibrated same-game
-- prop correlation factors. Non-destructive: this is a NEW table; nothing
-- writes to matched_parlays.outcome (which keeps its 'missed'/'other_sp' meaning).
--
-- Run once in the Supabase SQL editor before enabling PROP_SETTLEMENT_ENABLED.

CREATE TABLE IF NOT EXISTS prop_settlements (
  parlay_id      text PRIMARY KEY,
  matched_at     timestamptz,
  sport          text,
  combo          text,          -- e.g. 'SAME-G/OPP-TM | hitter_hr+hitter_hr'
  same_game      boolean,
  same_team      boolean,
  leg_count      int,
  prop_types     text[],        -- sorted propTypes
  matched_odds   numeric,
  matched_stake  numeric,
  we_quoted      boolean,
  leg_results    jsonb,         -- [{player, propType, line, stat, won}]
  parlay_won     boolean,
  source         text DEFAULT 'mlb-statsapi',
  settled_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prop_settlements_matched_at_idx ON prop_settlements (matched_at);
CREATE INDEX IF NOT EXISTS prop_settlements_combo_idx      ON prop_settlements (combo);
