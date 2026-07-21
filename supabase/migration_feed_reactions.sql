-- Feed redesign — expand reaction_type from 3 to 7 values.
--
-- The app's browser anon key can't run DDL, so run this ONCE against the live
-- database (Supabase dashboard → SQL Editor, or psql). It is idempotent:
-- ADD VALUE IF NOT EXISTS is safe to re-run.
--
-- Until this runs, the three original reactions (fire/wow/gg) work everywhere;
-- the four new ones (lol/angry/rage/poop) will fail to insert and their counts
-- revert on the next feed refresh.

alter type reaction_type add value if not exists 'lol';
alter type reaction_type add value if not exists 'angry';
alter type reaction_type add value if not exists 'rage';
alter type reaction_type add value if not exists 'poop';

-- Make PostgREST pick up the new enum values immediately.
notify pgrst, 'reload schema';
