-- ============================================================================
-- Golf Single-Leg Bot — Supabase schema
-- ============================================================================
-- Two tables:
--   golf_single_leg_config   — user preferences (per side per matchup):
--                              risk amount, enabled flag, notes
--   golf_single_leg_wagers   — runtime state: what we've posted, posted odds,
--                              wager IDs from PX, status, last-seen timestamps
--
-- Keys design:
--   line_id  — PX line identifier for one SIDE of one matchup
--              (Scottie Scheffler in "Scheffler vs Spieth" is its own line_id)
--   Each side is independently configurable (asymmetric posting supported).
-- ============================================================================

create table if not exists public.golf_single_leg_config (
  line_id           text primary key,
  event_id          bigint not null,
  market_id         bigint,
  tournament_name   text,
  matchup_name      text,                       -- "Scheffler vs Spieth (R4)"
  side_name         text,                       -- "Scottie Scheffler"
  side_opponent     text,                       -- "Jordan Spieth"
  round_num         int,
  risk_amount       numeric(10,2),              -- null = not configured (no post)
  enabled           boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists golf_single_leg_config_event_idx
  on public.golf_single_leg_config (event_id);
create index if not exists golf_single_leg_config_enabled_idx
  on public.golf_single_leg_config (enabled) where enabled = true;

create table if not exists public.golf_single_leg_wagers (
  wager_id          text primary key,           -- PX's wager_id
  line_id           text not null,              -- FK -> config.line_id
  event_id          bigint not null,
  external_id       text,                       -- our idempotency key sent to PX
  posted_odds       int,                        -- American odds we posted at
  posted_stake      numeric(10,2),
  posted_fair_prob  numeric(8,5),               -- our fair at post time (for drift check)
  status            text,                       -- posted / partially_matched / matched / cancelled / errored
  status_detail     text,
  posted_at         timestamptz not null default now(),
  cancelled_at      timestamptz,
  last_seen_at      timestamptz not null default now()
);
create index if not exists golf_single_leg_wagers_line_idx
  on public.golf_single_leg_wagers (line_id);
create index if not exists golf_single_leg_wagers_active_idx
  on public.golf_single_leg_wagers (status) where status in ('posted', 'partially_matched');

-- Touch updated_at on config edits
create or replace function public.touch_golf_single_leg_config_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_golf_single_leg_config_updated on public.golf_single_leg_config;
create trigger trg_golf_single_leg_config_updated
  before update on public.golf_single_leg_config
  for each row execute function public.touch_golf_single_leg_config_updated_at();
