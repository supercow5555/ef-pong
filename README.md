# EF Pong

Always-on ELO leaderboard for office ping pong. Static frontend (GitHub Pages) + Supabase backend. Full product spec lives in [`design_handoff_ef_pong/`](design_handoff_ef_pong/README.md).

## Structure

- `index.html` + `js/app.js` — the phone app (leaderboard, log a match, feed, profile, identity gate)
- `wall.html` + `js/wall.js` — the office wall display (realtime, 10s polling fallback)
- `js/api.js` — data layer (the ten API operations)
- `js/config.js` — Supabase project URL + anon key
- `supabase/schema.sql` — the tables + RLS + realtime publication (includes trust-wave columns for fresh installs)
- `supabase/functions.sql` — `log_match` (server-side ELO), `correct_match` (void/edit + full-season replay), `roll_season`, plus the trust-wave functions (`dispute_match`, `resolve_dispute`, `approve_claim`/`reject_claim`, …)
- `supabase/migrations/001_trust_wave.sql` — additive migration that upgrades a **live** MVP database to the trust wave (run once)
- `supabase/migrations/002_seasons.sql` — additive migration for the seasons feature (`last_seen_season`, one-active-season guard, client-driven season functions); re-run `functions.sql` after it
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
```

Rolling a season is now done from the app's **Admin tab → Season control** (a signed-in
admin, no secret). The season functions are admin-JWT'd — `roll_season(name)` closes the
live season, crowns its champion, opens a fresh board named `name`, and resets everyone to
1000; `rename_season(id, name)` renames any season; `rebuild_season(id, recrown)` replays a
season's non-voided matches and optionally re-crowns. See the seasons handoff bundle.

## Trust wave (wave 1: trust & identity)

Adds magic-link login, match ownership, disputes → an admin queue, and a
claim-your-name onboarding gate. The rules live in
[`design_handoff_ef_pong/`](design_handoff_ef_pong/) and the build brief in the
trust-wave handoff bundle. Key rule: **voiding a disputed match uses localized
reversal** — only the two players move, no season replay.

### Deploying it to the live DB (once)

1. **Migration.** In the Supabase SQL editor run `supabase/migrations/001_trust_wave.sql`,
   then re-run `supabase/functions.sql` (adds the new functions + the auth guard
   on `log_match`). Fresh installs can just run the updated `schema.sql` +
   `functions.sql` and skip the migration.
2. **Enable magic-link auth.** Supabase → Authentication → Providers → Email:
   turn on “Email” / magic link. Add the site URL and the GitHub Pages URL to
   Authentication → URL Configuration (Site URL + Redirect URLs) so the link
   returns to the app.
3. **Make yourself admin** (DB only — never grantable from the client). After you
   sign in once and are approved so your email is bound:
   ```sql
   update player set is_admin = true where email = '<you>@ef.com';
   ```
   Or bind + promote in one go before first sign-in:
   ```sql
   update player set email = '<you>@ef.com', is_admin = true where id = '<your player id>';
   ```
4. **Flip rollout when everyone's onboarded** — from the app's Admin tab
   (Rollout toggle), or `select set_rollout_complete(true);` as an admin.

### How it works

- **Recognised email** (bound to a player) signs straight in. A **new email**
  claims an unclaimed roster name or creates a new player → lands **pending**
  (browse only) until an admin approves, which binds the email.
- **`log_match` / `dispute_match` / commenting** require a verified caller
  (email bound) and, for logging/disputing, that you're a participant — enforced
  in the functions, not just the UI. Reactions and viewing stay open.
- **Dispute** flags a match (`confirmed` → `disputed`) and routes to the admin;
  it changes no rating on its own. The admin **upholds** (→ `confirmed`),
  **voids** (localized reversal), or **voids + penalises** (flat −50 on the
  offender, logged in `rating_history` as `kind='penalty'`).
- `correct_match` / `replay_season` remain the rare full-replay escape hatch.

Note: EF Circular font files are licensed and not committed; the app falls back to system fonts where they're unavailable.
