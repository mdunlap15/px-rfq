-- ============================================================================
-- Golf Outrights bulk-poster — Supabase schema
-- ============================================================================
-- Three tables:
--   golf_outright_tournaments  — list of DK tournament URLs the orchestrator
--                                should scrape. User adds via UI; orchestrator
--                                iterates enabled rows.
--   golf_outright_config       — per-(player, market) preferences: risk_amount,
--                                enabled flag, notes. One row per side we might
--                                post. Default state = enabled=false,
--                                risk_amount=null (nothing posts unless the user
--                                explicitly configures).
--   golf_outright_wagers       — runtime state: what we've posted to PX, posted
--                                odds, wager_ids, status, drift-check baselines.
-- ============================================================================

-- Tournaments: source-of-truth URL list. Slug is the DK URL segment after
-- /leagues/golf/, e.g. "the-memorial-tournament". Primary key so re-adding
-- the same tournament is idempotent.
create table if not exists public.golf_outright_tournaments (
  dk_slug           text primary key,
  tournament_name   text,
  dk_url            text not null,
  enabled           boolean not null default true,
  notes             text,
  last_scraped_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists golf_outright_tournaments_enabled_idx
  on public.golf_outright_tournaments (enabled) where enabled = true;

-- Config: one row per (tournament, market_type, player, side).
-- For pilot, side is almost always 'yes' (you post YES offers to attract NO
-- requests). Schema supports 'no' for future flexibility.
create table if not exists public.golf_outright_config (
  id                bigserial primary key,
  dk_slug           text not null references public.golf_outright_tournaments(dk_slug) on delete cascade,
  market_type       text not null,            -- 'top_1' | 'top_5' | 'top_10' | 'top_20' | 'make_cut'
  player_name       text not null,
  side              text not null default 'yes', -- 'yes' | 'no'
  px_line_id        text,                     -- populated after we match the player to a PX line
  px_event_id       bigint,                   -- ditto
  px_market_id      bigint,
  dk_american_odds  int,                      -- latest scraped DK odds for ref
  dk_implied        numeric(8,5),
  offered_implied   numeric(8,5),             -- = dk_implied × (1 + sweetener)
  offered_american  int,                      -- snapped to PX ladder
  risk_amount       numeric(10,2),            -- null = not configured (no post)
  enabled           boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (dk_slug, market_type, player_name, side)
);
create index if not exists golf_outright_config_enabled_idx
  on public.golf_outright_config (enabled) where enabled = true;
create index if not exists golf_outright_config_slug_idx
  on public.golf_outright_config (dk_slug);
create index if not exists golf_outright_config_lineid_idx
  on public.golf_outright_config (px_line_id) where px_line_id is not null;

-- Runtime wagers: tracks what's actually posted to PX, drift-check baselines.
create table if not exists public.golf_outright_wagers (
  wager_id          text primary key,         -- PX's wager_id
  config_id         bigint references public.golf_outright_config(id) on delete set null,
  dk_slug           text,
  px_line_id        text not null,
  px_event_id       bigint,
  external_id       text,                     -- our idempotency key sent to PX
  posted_odds       int,                      -- American odds we posted at
  posted_stake      numeric(10,2),
  posted_dk_implied numeric(8,5),             -- DK's implied at post time (for drift check)
  status            text,                     -- posted / partially_matched / matched / cancelled / errored
  status_detail     text,
  posted_at         timestamptz not null default now(),
  cancelled_at      timestamptz,
  last_seen_at      timestamptz not null default now()
);
create index if not exists golf_outright_wagers_config_idx
  on public.golf_outright_wagers (config_id);
create index if not exists golf_outright_wagers_active_idx
  on public.golf_outright_wagers (status) where status in ('posted', 'partially_matched');

-- Trigger: touch updated_at on tournament + config edits
create or replace function public.touch_golf_outright_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_golf_outright_tournaments_updated on public.golf_outright_tournaments;
create trigger trg_golf_outright_tournaments_updated
  before update on public.golf_outright_tournaments
  for each row execute function public.touch_golf_outright_updated_at();
drop trigger if exists trg_golf_outright_config_updated on public.golf_outright_config;
create trigger trg_golf_outright_config_updated
  before update on public.golf_outright_config
  for each row execute function public.touch_golf_outright_updated_at();
