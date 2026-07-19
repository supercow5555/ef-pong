-- EF Pong — schema (7 tables) + RLS
-- Source of truth: design_handoff_ef_pong/EF Pong Data Model.dc.html

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type match_status as enum ('confirmed', 'pending', 'disputed');
create type reaction_type as enum ('fire', 'wow', 'gg');

-- ---------- tables ----------
create table player (
  id             text primary key,
  name           text not null unique,
  initials       text not null,
  avatar_color   text not null,
  join_date      timestamptz not null default now(),
  login_identity text
);

create table season (
  id          text primary key,           -- e.g. '2026-q3'
  name        text not null,              -- e.g. 'Q3 2026'
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  champion_id text references player(id),
  is_active   boolean not null default false
);

-- exactly one active season at a time
create unique index one_active_season on season (is_active) where is_active;

create table standings (
  id        text primary key default gen_random_uuid()::text,
  player_id text not null references player(id),
  season_id text not null references season(id),
  elo       int not null default 1000,
  wins      int not null default 0,
  losses    int not null default 0,
  peak      int not null default 1000,
  unique (player_id, season_id)
);

create table match (
  id           text primary key default gen_random_uuid()::text,
  winner_id    text not null references player(id),
  loser_id     text not null references player(id),
  winner_score int not null,
  loser_score  int not null,
  elo_delta    int not null,
  season_id    text not null references season(id),
  entered_by   text references player(id),
  status       match_status not null default 'confirmed',
  is_voided    boolean not null default false,
  played_at    timestamptz not null default now(),
  check (winner_id <> loser_id)
);

create index match_feed on match (season_id, played_at desc);

create table rating_history (
  id           text primary key default gen_random_uuid()::text,
  player_id    text not null references player(id),
  match_id     text not null references match(id),
  rating_after int not null,
  recorded_at  timestamptz not null default now()
);

create index rating_history_player on rating_history (player_id, recorded_at);

create table reaction (
  id        text primary key default gen_random_uuid()::text,
  match_id  text not null references match(id),
  type      reaction_type not null,
  player_id text references player(id)   -- nullable: anonymous at launch
);

create index reaction_match on reaction (match_id);

create table comment (
  id        text primary key default gen_random_uuid()::text,
  match_id  text not null references match(id),
  author_id text not null references player(id),
  text      text not null check (length(text) between 1 and 500),
  posted_at timestamptz not null default now()
);

create index comment_match on comment (match_id, posted_at);

-- private config (admin secret for rollSeason / correctMatch)
create table app_config (
  key   text primary key,
  value text not null
);
insert into app_config (key, value) values ('admin_secret', 'change-me');

-- ---------- row level security ----------
alter table player         enable row level security;
alter table season         enable row level security;
alter table standings      enable row level security;
alter table match          enable row level security;
alter table rating_history enable row level security;
alter table reaction       enable row level security;
alter table comment        enable row level security;
alter table app_config     enable row level security;  -- no policies: invisible to anon

-- everyone can read everything (except app_config)
create policy read_player    on player         for select using (true);
create policy read_season    on season         for select using (true);
create policy read_standings on standings      for select using (true);
create policy read_match     on match          for select using (true);
create policy read_history   on rating_history for select using (true);
create policy read_reaction  on reaction       for select using (true);
create policy read_comment   on comment        for select using (true);

-- Phase 1 (honour system) writes via anon key:
create policy add_player   on player   for insert with check (login_identity is null);
create policy add_reaction on reaction for insert with check (true);
create policy add_comment  on comment  for insert with check (true);
create policy del_comment  on comment  for delete using (true);

-- match / standings / rating_history / season have NO insert/update policies:
-- they are written only by the security-definer functions below.

-- ---------- realtime ----------
alter publication supabase_realtime add table match, standings, reaction, comment;
