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
begin
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
create or replace function roll_season(
  p_admin_secret text,
  p_new_id text,     -- e.g. '2026-q4'
  p_new_name text    -- e.g. 'Q4 2026'
) returns json
language plpgsql security definer set search_path = public as
$$
declare
  v_old_id text;
  v_champion text;
begin
  if p_admin_secret <> (select value from app_config where key = 'admin_secret') then
    raise exception 'invalid admin secret';
  end if;

  select id into v_old_id from season where is_active;

  if v_old_id is not null then
    select player_id into v_champion from standings
      where season_id = v_old_id order by elo desc limit 1;
    update season set is_active = false, ends_at = now(),
      champion_id = v_champion where id = v_old_id;
  end if;

  insert into season (id, name, starts_at, is_active)
  values (p_new_id, p_new_name, now(), true);

  insert into standings (player_id, season_id)
  select id, p_new_id from player;

  return json_build_object('closed', v_old_id, 'champion', v_champion, 'opened', p_new_id);
end;
$$;

-- ---------- grants ----------
grant execute on function log_match(text, text, int, int, text) to anon;
grant execute on function correct_match(text, text, text, text, text, int, int) to anon;
grant execute on function roll_season(text, text, text) to anon;
-- helpers stay callable but harmless
grant execute on function elo_expected(int, int), elo_margin_mult(int),
  elo_calc_delta(int, int, int, int, int), valid_score(int, int) to anon;
revoke execute on function replay_season(text) from anon, authenticated;
