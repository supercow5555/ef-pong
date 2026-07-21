-- EF Pong — Trust Wave migration (wave 1: trust & identity)
-- Additive & idempotent-ish — safe to run once on the live DB.
-- Adds: bound email + admin flag, dispute metadata, rating_history audit kind,
--       a claim table, and the rollout_complete config flag.
--
-- NOTE ON STATUS NAMING: the design handoff talks about a 'counting' status, but
-- the live schema already ships match_status = ('confirmed','pending','disputed')
-- and log_match writes 'confirmed'. To keep log_match's ELO behaviour UNCHANGED
-- (acceptance check #1) we treat the existing 'confirmed' as the live/"counting"
-- state. Disputes flip 'confirmed' -> 'disputed'; uphold flips it back.

-- ---------- player: bound email + admin flag ----------
alter table player add column if not exists email text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'player_email_key') then
    alter table player add constraint player_email_key unique (email);
  end if;
end $$;
alter table player add column if not exists is_admin boolean not null default false;

-- ---------- match: dispute metadata (is_voided already exists) ----------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'dispute_reason') then
    create type dispute_reason as enum ('score','nothappen','wrongplayer','other');
  end if;
end $$;
alter table match add column if not exists dispute_reason dispute_reason;
alter table match add column if not exists disputed_by text references player(id);

-- ---------- rating_history: why a change happened (audit) ----------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'rh_kind') then
    create type rh_kind as enum ('match','void','penalty');
  end if;
end $$;
alter table rating_history add column if not exists kind rh_kind not null default 'match';
alter table rating_history alter column match_id drop not null;   -- penalties have no match

-- ---------- claim: a sign-in awaiting admin approval ----------
create table if not exists claim (
  id         text primary key default gen_random_uuid()::text,
  player_id  text not null references player(id),
  email      text not null,
  created_at timestamptz not null default now()
);

-- ---------- app_config: rollout flag ----------
insert into app_config (key, value) values ('rollout_complete','false')
  on conflict (key) do nothing;

-- ---------- RLS for the new claim table ----------
-- With auth on: authenticated users may file their own claim and read the queue
-- (admin needs to see it; roster is internal). player.email / player.is_admin
-- are only ever written by the security-definer functions, never the client.
alter table claim enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='claim' and policyname='read_claim') then
    create policy read_claim on claim for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='claim' and policyname='add_claim') then
    create policy add_claim on claim for insert to authenticated with check (true);
  end if;
end $$;

alter publication supabase_realtime add table claim;

-- ---------- auth helper: the approved player behind the current request ----------
create or replace function current_player()
returns text language sql stable security definer set search_path = public as
$$ select id from player
   where email = nullif(current_setting('request.jwt.claims', true)::json ->> 'email', '') $$;

-- ---------- tighten comments: verified players only, and only as themselves ----------
drop policy if exists add_comment on comment;
create policy add_comment on comment for insert to authenticated with check (author_id = current_player());

