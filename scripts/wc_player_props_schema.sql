-- World Cup / international soccer player-prop cache.
--
-- Populated by the DECOUPLED scraper worker (scripts/dk-wc-props-worker.js),
-- which runs off the trading box (local cron or a separate Railway worker) so
-- the fragile headless-Chromium scrape never touches the live RFQ/fill path.
-- The live service only READS this table (services/wc-player-props.js).
--
-- One row per (PX event, player, market). `market` is one of:
--   'goalscorer' | 'sot_1' | 'sot_2' | 'assists'
-- `american` is DraftKings' bettor-facing OVER/anytime price (e.g. +150, -255).
-- `player_key` is the diacritic-stripped, lowercased name used to match PX's
--   "<Player> To Score a Goal" market back to this row.
--
-- Run this once in the Supabase SQL editor before starting the worker.

create table if not exists wc_player_props (
  px_event_id   bigint      not null,
  player_key    text        not null,   -- normalized match key e.g. "raul jimenez"
  market        text        not null,   -- goalscorer | sot_1 | sot_2 | assists
  american      integer     not null,   -- DK OVER/anytime price
  player_name   text,                   -- DK display name (debug)
  dk_event_id   text,                   -- DK event id (debug)
  match_label   text,                   -- "South Africa at Mexico" (debug)
  commence_time timestamptz,
  scraped_at    timestamptz not null default now(),
  primary key (px_event_id, player_key, market)
);

create index if not exists wc_player_props_event_idx   on wc_player_props (px_event_id);
create index if not exists wc_player_props_scraped_idx  on wc_player_props (scraped_at);
