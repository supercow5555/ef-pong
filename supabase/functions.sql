-- EF Pong — server-side functions: log_match, roll_season, correct_match
-- ELO math moved verbatim from the prototype (calcDelta / expected / marginMult).

-- expected(a, b) = 1 / (1 + 10^((b - a) / 400))
create or replace function elo_expected(a int, b int)
returns double precision language sql immutable as
$$ select 1.0 / (1.0 + power(10.0, (b - a) / 400.0)) $$;

-- marginMult(diff) = 1 + ln(max(diff,1)) / ln(11)
create or replace function elo_margin_mult(diff int)
returns double precision language sql immutable as
$$ select 1.0 + ln(greatest(diff, 1)) / ln(11.0) $$;

-- calcDelta: K = 40 while winner has < 5 games, else 24; delta >= 1
create or replace function elo_calc_delta(w_elo int, l_elo int, ws int, ls int, w_games int)
returns int language sql immutable as
$$ select greatest(1, round(
     (case when w_games < 5 then 40 else 24 end)
     * elo_margin_mult(ws - ls)
     * (1.0 - elo_expected(w_elo, l_elo))
   ))::int $$;

-- valid score: to >= 11, win by >= 2, cap 21
create or replace function valid_score(ws int, ls int)
returns boolean language sql immutable as
$$ select ws >= 11 and ws - ls >= 2 and ws <= 21 and ls >= 0 $$;

-- ---------- logMatch ----------
create or replace function log_match(
  p_winner_id text,
  p_loser_id  text,
  p_winner_score int,
  p_loser_score  int,
  p_entered_by   text default null
) returns json
language plpgsql security definer set search_path = public as
$$
declare
  v_season_id text;
  v_w standings%rowtype;
  v_l standings%rowtype;
  v_delta int;
  v_match_id text;
  v_w_new int;
  v_l_new int;
  v_caller text;
begin
  -- The caller must be a verified player (email bound via magic link), but need
  -- NOT be one of the two players: any verified player may record a match,
  -- including a spectator logging a game between two other people. This removes
  -- the earlier friction where only a participant could log. We still stamp
  -- entered_by with the caller so there's an audit trail of who recorded it.
  -- ELO math below is unchanged from the MVP.
  v_caller := current_player();
  if v_caller is null then
    raise exception 'sign in (and get verified) to log matches';
  end if;
  p_entered_by := v_caller;

  if p_winner_id = p_loser_id then
    raise exception 'winner and loser must be different players';
  end if;
  if not valid_score(p_winner_score, p_loser_score) then
    raise exception 'invalid score: game is to 11+, win by 2, max 21';
  end if;

  select id into v_season_id from season where is_active;
  if v_season_id is null then
    raise exception 'no active season';
  end if;

  -- ensure standings rows exist (players may register mid-season)
  insert into standings (player_id, season_id)
  values (p_winner_id, v_season_id), (p_loser_id, v_season_id)
  on conflict (player_id, season_id) do nothing;

  select * into v_w from standings
    where player_id = p_winner_id and season_id = v_season_id for update;
  select * into v_l from standings
    where player_id = p_loser_id and season_id = v_season_id for update;

  v_delta := elo_calc_delta(v_w.elo, v_l.elo, p_winner_score, p_loser_score,
                            v_w.wins + v_w.losses);
  v_w_new := v_w.elo + v_delta;
  v_l_new := greatest(100, v_l.elo - v_delta);

  insert into match (winner_id, loser_id, winner_score, loser_score,
                     elo_delta, season_id, entered_by, status)
  values (p_winner_id, p_loser_id, p_winner_score, p_loser_score,
          v_delta, v_season_id, p_entered_by, 'confirmed')
  returning id into v_match_id;

  update standings set elo = v_w_new, wins = wins + 1,
    peak = greatest(peak, v_w_new)
    where id = v_w.id;
  update standings set elo = v_l_new, losses = losses + 1
    where id = v_l.id;

  insert into rating_history (player_id, match_id, rating_after)
  values (p_winner_id, v_match_id, v_w_new),
         (p_loser_id,  v_match_id, v_l_new);

  return json_build_object(
    'match_id', v_match_id,
    'elo_delta', v_delta,
    'winner_elo', v_w_new,
    'loser_elo', v_l_new,
    'upset', (v_l.elo - v_w.elo) >= 150
  );
end;
$$;

-- ---------- season replay (shared by correct_match; also self-heals drift) ----------
create or replace function replay_season(p_season_id text)
returns void
language plpgsql security definer set search_path = public as
$$
declare
  m record;
  v_w standings%rowtype;
  v_l standings%rowtype;
  v_delta int;
  v_w_new int;
  v_l_new int;
begin
  delete from rating_history
    where match_id in (select id from match where season_id = p_season_id);

  update standings set elo = 1000, wins = 0, losses = 0, peak = 1000
    where season_id = p_season_id;

  for m in
    select * from match
    where season_id = p_season_id and not is_voided
    order by played_at, id
  loop
    insert into standings (player_id, season_id)
    values (m.winner_id, p_season_id), (m.loser_id, p_season_id)
    on conflict (player_id, season_id) do nothing;

    select * into v_w from standings
      where player_id = m.winner_id and season_id = p_season_id;
    select * into v_l from standings
      where player_id = m.loser_id and season_id = p_season_id;

    v_delta := elo_calc_delta(v_w.elo, v_l.elo, m.winner_score, m.loser_score,
                              v_w.wins + v_w.losses);
    v_w_new := v_w.elo + v_delta;
    v_l_new := greatest(100, v_l.elo - v_delta);

    update match set elo_delta = v_delta where id = m.id;

    update standings set elo = v_w_new, wins = wins + 1,
      peak = greatest(peak, v_w_new) where id = v_w.id;
    update standings set elo = v_l_new, losses = losses + 1 where id = v_l.id;

    insert into rating_history (player_id, match_id, rating_after, recorded_at)
    values (m.winner_id, m.id, v_w_new, m.played_at),
           (m.loser_id,  m.id, v_l_new, m.played_at);
  end loop;
end;
$$;

-- ---------- correctMatch (admin): void or edit, then full-season replay ----------
create or replace function correct_match(
  p_admin_secret text,
  p_match_id text,
  p_action text,                 -- 'void' | 'edit'
  p_winner_id text default null, -- edit only (null = keep)
  p_loser_id  text default null,
  p_winner_score int default null,
  p_loser_score  int default null
) returns json
language plpgsql security definer set search_path = public as
$$
declare
  v_season_id text;
begin
  if p_admin_secret <> (select value from app_config where key = 'admin_secret') then
    raise exception 'invalid admin secret';
  end if;

  select season_id into v_season_id from match where id = p_match_id;
  if v_season_id is null then
    raise exception 'match not found';
  end if;

  if p_action = 'void' then
    update match set is_voided = true where id = p_match_id;
  elsif p_action = 'edit' then
    update match set
      winner_id    = coalesce(p_winner_id, winner_id),
      loser_id     = coalesce(p_loser_id, loser_id),
      winner_score = coalesce(p_winner_score, winner_score),
      loser_score  = coalesce(p_loser_score, loser_score)
      where id = p_match_id;
    if exists (select 1 from match where id = p_match_id
               and (winner_id = loser_id or not valid_score(winner_score, loser_score))) then
      raise exception 'edit produces an invalid match';
    end if;
  else
    raise exception 'action must be void or edit';
  end if;

  perform replay_season(v_season_id);
  return json_build_object('replayed_season', v_season_id);
end;
$$;

-- ---------- rollSeason (admin): freeze champion, open next, reset standings ----------
-- Seasons feature: client-driven and admin-JWT'd (require_admin), not secret-based.
-- The admin supplies the new season's free-text NAME; the server owns the internal id.
-- Atomic: close the current season (freeze its champion), open a fresh active season,
-- and seed every player at 1000. The one_active_season index guarantees exclusivity.
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
    -- freeze the champion = current top of the closing season's (now frozen) standings
    select player_id into v_champion from standings
      where season_id = v_old_id order by elo desc limit 1;
    update season set is_active = false, ends_at = now(),
      champion_id = v_champion where id = v_old_id;
  end if;

  -- internal id: a slug of the name + a short uuid suffix so it's readable yet unique
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

-- ---------- renameSeason (admin): pure rename, no replay ----------
-- Free-text rename of any season (live or past). The name propagates everywhere the
-- season is shown (Hall of Fame, admin list). No standings/ELO are touched.
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

-- ---------- rebuildSeason (admin): season-scoped replay + optional re-crown ----------
-- Replays every non-voided match of the season from 1000 (existing replay_season) and
-- rewrites its standings. If p_recrown, re-freeze the (possibly new) champion into the
-- Hall of Fame; otherwise leave champion_id untouched. A rebuild can change who won a
-- past season — it's reflected in standings + rating_history either way.
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

-- ---------- seeSeason: mark the podium reveal seen for the calling player ----------
-- Written when a player dismisses the podium, so the reveal shows exactly once per roll.
create or replace function see_season(p_season_id text)
returns void language plpgsql security definer set search_path = public as
$$
declare v_caller text;
begin
  v_caller := current_player();
  if v_caller is null then return; end if;   -- anon/pending: nothing to persist
  update player set last_seen_season = p_season_id where id = v_caller;
end;
$$;

-- ============================================================================
-- Trust wave (wave 1): disputes, localized reversal, penalties, claims.
-- See design_handoff_trust_wave/EF Pong Trust Handoff.dc.html §4.
-- ============================================================================

-- the approved player behind the current request (see schema.sql). Redefined
-- here so functions.sql is runnable standalone against the live DB.
create or replace function current_player()
returns text language sql stable security definer set search_path = public as
$$ select id from player
   where email = nullif(current_setting('request.jwt.claims', true)::json ->> 'email', '') $$;

-- the caller must map to an is_admin player, else abort
create or replace function require_admin()
returns text language plpgsql stable security definer set search_path = public as
$$
declare v_id text;
begin
  select id into v_id from player
    where email = nullif(current_setting('request.jwt.claims', true)::json ->> 'email', '')
      and is_admin;
  if v_id is null then
    raise exception 'admin only';
  end if;
  return v_id;
end;
$$;

-- ---------- dispute_match — flag only, no rating change ----------
-- Either participant may dispute, and only while the match is live ('confirmed').
create or replace function dispute_match(p_match_id text, p_reason text)
returns void language plpgsql security definer set search_path = public as
$$
declare v_caller text;
begin
  v_caller := current_player();
  if v_caller is null then
    raise exception 'sign in (and get verified) to dispute';
  end if;
  update match set status = 'disputed',
                   dispute_reason = p_reason::dispute_reason,
                   disputed_by = v_caller
   where id = p_match_id and status = 'confirmed'
     and (winner_id = v_caller or loser_id = v_caller);
  if not found then
    raise exception 'not a participant, or match not disputable';
  end if;
end;
$$;

-- ---------- withdraw_dispute — disputer takes it back (-> live) ----------
create or replace function withdraw_dispute(p_match_id text)
returns void language plpgsql security definer set search_path = public as
$$
declare v_caller text;
begin
  v_caller := current_player();
  update match set status = 'confirmed', dispute_reason = null, disputed_by = null
   where id = p_match_id and status = 'disputed' and disputed_by = v_caller;
  if not found then
    raise exception 'nothing to withdraw';
  end if;
end;
$$;

-- ---------- resolve_dispute — uphold / void / void+penalise (LOCALIZED) ----------
-- Voiding reverses ONLY this match's stored elo_delta on ITS two players and
-- undoes their W/L. Nobody else moves — no season replay, no cascade.
create or replace function resolve_dispute(
  p_match_id text,
  p_action   text,          -- 'uphold' | 'void' | 'void_penalize'
  p_penalty  int default 50)
returns json language plpgsql security definer set search_path = public as
$$
declare m match%rowtype; v_season text;
begin
  perform require_admin();

  select * into m from match where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  v_season := m.season_id;

  if p_action = 'uphold' then
    update match set status = 'confirmed', dispute_reason = null, disputed_by = null
     where id = p_match_id;
    return json_build_object('upheld', p_match_id);
  end if;

  if m.is_voided then
    raise exception 'already voided';
  end if;

  -- VOID: reverse only this match's delta, on its two players.
  update standings set elo = elo - m.elo_delta, wins = greatest(0, wins - 1)
    where player_id = m.winner_id and season_id = v_season;
  update standings set elo = elo + m.elo_delta, losses = greatest(0, losses - 1)
    where player_id = m.loser_id and season_id = v_season;
  update match set is_voided = true, status = 'disputed' where id = p_match_id;
  insert into rating_history (player_id, match_id, rating_after, kind)
    select player_id, m.id, elo, 'void' from standings
     where season_id = v_season and player_id in (m.winner_id, m.loser_id);

  if p_action = 'void_penalize' then   -- flat, non-zero-sum sanction on the offender (the winner)
    update standings set elo = greatest(100, elo - p_penalty)
      where player_id = m.winner_id and season_id = v_season;
    insert into rating_history (player_id, match_id, rating_after, kind)
      select m.winner_id, null, elo, 'penalty' from standings
       where season_id = v_season and player_id = m.winner_id;
  end if;

  return json_build_object('voided', p_match_id, 'penalized', p_action = 'void_penalize');
end;
$$;

-- ---------- approve_claim / reject_claim — bind (or drop) the email ----------
create or replace function approve_claim(p_claim_id text)
returns void language plpgsql security definer set search_path = public as
$$
declare c claim%rowtype;
begin
  perform require_admin();
  select * into c from claim where id = p_claim_id;
  if not found then raise exception 'claim not found'; end if;
  update player set email = c.email where id = c.player_id;  -- bind -> recognised next time
  delete from claim where id = p_claim_id;
end;
$$;

create or replace function reject_claim(p_claim_id text)
returns void language plpgsql security definer set search_path = public as
$$
begin
  perform require_admin();
  delete from claim where id = p_claim_id;
end;
$$;

-- ---------- rollout flag — readable by all, flippable by admin only ----------
-- (app_config itself is invisible to clients via RLS; these narrow accessors
--  avoid exposing admin_secret.)
create or replace function rollout_complete()
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select value from app_config where key = 'rollout_complete'), 'false') = 'true' $$;

create or replace function set_rollout_complete(p_on boolean)
returns void language plpgsql security definer set search_path = public as
$$
begin
  perform require_admin();
  insert into app_config (key, value) values ('rollout_complete', case when p_on then 'true' else 'false' end)
    on conflict (key) do update set value = excluded.value;
end;
$$;

-- ---------- grants ----------
grant execute on function rollout_complete()             to anon, authenticated;
grant execute on function set_rollout_complete(boolean)  to anon, authenticated;
grant execute on function log_match(text, text, int, int, text) to anon, authenticated;
grant execute on function correct_match(text, text, text, text, text, int, int) to anon, authenticated;
grant execute on function roll_season(text)               to anon, authenticated;
grant execute on function rename_season(text, text)        to anon, authenticated;
grant execute on function rebuild_season(text, boolean)    to anon, authenticated;
grant execute on function see_season(text)                 to anon, authenticated;
grant execute on function dispute_match(text, text)      to anon, authenticated;
grant execute on function withdraw_dispute(text)         to anon, authenticated;
grant execute on function resolve_dispute(text, text, int) to anon, authenticated;
grant execute on function approve_claim(text)            to anon, authenticated;
grant execute on function reject_claim(text)             to anon, authenticated;
grant execute on function current_player()               to anon, authenticated;
grant execute on function require_admin()                to anon, authenticated;
-- helpers stay callable but harmless
grant execute on function elo_expected(int, int), elo_margin_mult(int),
  elo_calc_delta(int, int, int, int, int), valid_score(int, int) to anon, authenticated;
revoke execute on function replay_season(text) from anon, authenticated;
