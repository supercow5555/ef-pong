-- EF Pong — Seasons migration
-- Additive & idempotent — safe to run once on the live DB.
-- Adds: per-player last_seen_season (podium "seen once per roll"), the one-active-season
--       guard, and the client-driven season functions (roll/rename/rebuild/see).
--
-- After running this, re-run supabase/functions.sql so the new roll_season(text) and the
-- rename/rebuild/see functions + grants are installed. Fresh installs can just run the
-- updated schema.sql + functions.sql and skip this file.

-- ---------- player: which roll's podium this player has dismissed ----------
alter table player add column if not exists last_seen_season text;

-- ---------- exactly one active season, enforced at the DB level ----------
create unique index if not exists one_active_season on season (is_active) where is_active;

-- ---------- drop the old secret-based roll_season (replaced by roll_season(text)) ----------
drop function if exists roll_season(text, text, text);

-- The roll_season(text) / rename_season / rebuild_season / see_season definitions and
-- their grants live in supabase/functions.sql — re-run that file after this migration.
