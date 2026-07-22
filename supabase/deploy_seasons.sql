-- EF Pong — Seasons: ONE paste-ready deploy for the live DB.
-- Safe to run on a DB that already has the trust wave applied. Do NOT re-run 001_trust_wave.sql
-- (its final "add table claim" to the realtime publication errors once it's already a member —
--  that's the sign the trust wave is already live). Everything below is idempotent / create-or-replace.
--
-- Run this whole file once in the Supabase SQL editor.

-- ========== schema / migration ==========
alter table player add column if not exists last_seen_season text;
create unique index if not exists one_active_season on season (is_active) where is_active;
drop function if exists roll_season(text, text, text);   -- retire the old secret-based signature

-- ========== functions (client-driven, admin-JWT'd) ==========

-- rollSeason(name): close the live season (freeze champion), open a fresh active season
-- named `name`, seed every player at 1000. Server owns the internal id.
create or replace function roll_season(p_name text) returns json
language plpgsql security definer set search_path = public as
$$
declare
  v_old_id text;
  v_champion text;
  v_new_id text;
begin
  perform require_admin();

  if coalesce(nullif(trim(p_name), ''), '') = '' then
    raise exception 'season name is required';
  end if;

  select id into v_old_id from season where is_active;

  if v_old_id is not null then
    select player_id into v_champion from standings
      where season_id = v_old_id order by elo desc limit 1;
    update season set is_active = false, ends_at = now(),
      champion_id = v_champion where id = v_old_id;
  end if;

  v_new_id := left(regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'), 24);
  v_new_id := trim(both '-' from v_new_id);
  if v_new_id = '' then v_new_id := 'season'; end if;
  v_new_id := v_new_id || '-' || substr(gen_random_uuid()::text, 1, 8);

  insert into season (id, name, starts_at, is_active)
  values (v_new_id, trim(p_name), now(), true);

  insert into standings (player_id, season_id)
  select id, v_new_id from player;

  return json_build_object('id', v_new_id, 'name', trim(p_name),
                           'closed', v_old_id, 'champion', v_champion);
end;
$$;

-- renameSeason(id, name): pure rename of any season (live or past), no replay.
create or replace function rename_season(p_season_id text, p_name text)
returns json language plpgsql security definer set search_path = public as
$$
begin
  perform require_admin();
  if coalesce(nullif(trim(p_name), ''), '') = '' then
    raise exception 'season name is required';
  end if;
  update season set name = trim(p_name) where id = p_season_id;
  if not found then raise exception 'season not found'; end if;
  return json_build_object('id', p_season_id, 'name', trim(p_name));
end;
$$;

-- rebuildSeason(id, recrown): season-scoped replay from 1000 + optional re-crown.
create or replace function rebuild_season(p_season_id text, p_recrown boolean default true)
returns json language plpgsql security definer set search_path = public as
$$
declare
  v_champion text;
  v_recrowned boolean := false;
begin
  perform require_admin();
  if not exists (select 1 from season where id = p_season_id) then
    raise exception 'season not found';
  end if;

  perform replay_season(p_season_id);

  if p_recrown then
    select player_id into v_champion from standings
      where season_id = p_season_id order by elo desc limit 1;
    update season set champion_id = v_champion where id = p_season_id;
    v_recrowned := true;
  end if;

  return json_build_object('rebuilt', p_season_id, 'recrowned', v_recrowned,
                           'champion', v_champion);
end;
$$;

-- seeSeason(id): mark the podium reveal seen for the calling player (shows once per roll).
create or replace function see_season(p_season_id text)
returns void language plpgsql security definer set search_path = public as
$$
declare v_caller text;
begin
  v_caller := current_player();
  if v_caller is null then return; end if;
  update player set last_seen_season = p_season_id where id = v_caller;
end;
$$;

-- ========== grants ==========
grant execute on function roll_season(text)            to anon, authenticated;
grant execute on function rename_season(text, text)     to anon, authenticated;
grant execute on function rebuild_season(text, boolean) to anon, authenticated;
grant execute on function see_season(text)              to anon, authenticated;
