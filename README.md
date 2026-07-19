# EF Pong

Always-on ELO leaderboard for office ping pong. Static frontend (GitHub Pages) + Supabase backend. Full product spec lives in [`design_handoff_ef_pong/`](design_handoff_ef_pong/README.md).

## Structure

- `index.html` + `js/app.js` — the phone app (leaderboard, log a match, feed, profile, identity gate)
- `wall.html` + `js/wall.js` — the office wall display (realtime, 10s polling fallback)
- `js/api.js` — data layer (the ten API operations)
- `js/config.js` — Supabase project URL + anon key
- `supabase/schema.sql` — the seven tables + RLS + realtime publication
- `supabase/functions.sql` — `log_match` (server-side ELO), `correct_match` (void/edit + full-season replay), `roll_season`
- `supabase/seed.sql` — opens the first season

## Setup (once)

1. In the Supabase SQL editor run, in order: `schema.sql`, `functions.sql`, `seed.sql`.
2. Change the admin secret: `update app_config set value = '<your secret>' where key = 'admin_secret';`
3. Put the project URL + anon key in `js/config.js`.
4. Enable GitHub Pages (Settings → Pages → deploy from `main`, root).

## ELO (locked)

Start 1000 · K=24 (40 for a player's first 5 games) · margin multiplier `1 + ln(pointDiff)/ln(11)` · zero-sum · floor 100 · computed server-side inside `log_match`, never in the browser.

## Admin operations

Run from the Supabase SQL editor:

```sql
-- void or edit a match (then full-season replay):
select correct_match('<admin secret>', '<match id>', 'void');
select correct_match('<admin secret>', '<match id>', 'edit', null, null, 11, 7);

-- close the quarter and open the next:
select roll_season('<admin secret>', '2026-q4', 'Q4 2026');
```

## Auth phases

Launch = Phase 1 (pick your name, honour system). Phase 2 (magic-link) and Phase 3 (EF SSO) are config upgrades — see the handoff docs; no schema changes needed.

Note: EF Circular font files are licensed and not committed; the app falls back to system fonts where they're unavailable.
