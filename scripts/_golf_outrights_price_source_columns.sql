-- ============================================================================
-- golf_outright_config — price provenance columns (for DataGolf-sourced make_cut)
-- ============================================================================
-- Run once in Supabase SQL editor. Safe to re-run (idempotent).
--
-- Why: Top 1/5/10/20 are priced from the DraftKings scrape, but DK serves NO
-- cut market, so make_cut is priced from DataGolf's de-vigged book consensus
-- instead (services/datagolf.js → fetchMakeCutBoard). Two sources now write to
-- the same table, and they are NOT interchangeable:
--
--   price_source='dk'       dk_implied = DK's RAW posted price (vig INFLATED
--                           above fair). offered_implied = dk_implied×(1−sweetener).
--   price_source='datagolf' dk_implied = DE-VIGGED FAIR p(make) (power/odds-ratio
--                           de-vig across books quoting both make+miss).
--                           offered_implied = fair×(1+GOLF_MAKE_CUT_VIG).
--
-- The adjustment runs in OPPOSITE directions because offered_implied is the YES
-- price a counterparty pays and the default post_side='no' lays the player:
-- backing NO at (1−offered_implied) is +EV only while offered_implied > fair.
-- A raw DK price is already above fair; a de-vigged fair is not. Read
-- price_source before interpreting dk_implied — it is NOT always a DK number.
--
-- source_books: how many sportsbooks quoted BOTH sides for this player. Cut
-- boards are thin (16 of 118 players on The Open had exactly 1). Rows below
-- GOLF_MAKE_CUT_MIN_BOOKS are skipped at sync and never written.

alter table public.golf_outright_config
  add column if not exists price_source text not null default 'dk';

alter table public.golf_outright_config
  add column if not exists source_books int;

comment on column public.golf_outright_config.price_source is
  'dk | datagolf — determines how dk_implied must be read (raw vig-inflated vs de-vigged fair) and which direction offered_implied was adjusted.';
comment on column public.golf_outright_config.source_books is
  'make_cut only: count of books quoting BOTH make+miss that fed the power de-vig consensus.';

create index if not exists golf_outright_config_price_source_idx
  on public.golf_outright_config (price_source);
