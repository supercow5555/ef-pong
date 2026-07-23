-- 003_open_match_logging.sql
-- Remove the "you can only log matches you played in" restriction so any verified
-- player can record a match — including a spectator logging a game between two
-- other players. The caller is still required to be a verified player, and is
-- still stamped into match.entered_by for the audit trail.
--
-- Additive & idempotent: `create or replace` swaps the function body in place;
-- signature, grants and RLS are unchanged. Apply in the Supabase SQL editor
-- (the anon key can't run DDL). Safe to re-run.

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
  -- including a spectator logging a game between two other people. We still stamp
  -- entered_by with the caller so there's an audit trail of who recorded it.
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
