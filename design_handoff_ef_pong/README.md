# Handoff: EF Pong — live office ping-pong ELO leaderboard

## Overview
EF Pong is an always-on ELO leaderboard for office ping pong (~40 players at EF).
After a game, a player logs the result ("I beat Sofia 11–4"); the system updates each
player's ELO rating, re-ranks the ladder, and posts the match to a public feed where
colleagues react (🔥/😮/🤝) and leave comments. Seasons run quarterly and hard-reset the
ladder; past champions live in a Hall of Fame. It's used on **phones** (to log matches)
and on an **office wall display** (to watch, live).

This bundle is the output of a completed design phase: a full product spec, a clickable
frontend prototype, and a seven-step backend design walkthrough. Every major decision is
locked. The next phase is **implementation**.

## About the design files
The `.dc.html` files in this bundle are **design references authored in HTML** — prototypes
and specification documents that show intended look, behavior, data model, and architecture.
They are **not production code to copy directly**. The task is to **recreate the prototype in
a real, deployable codebase** and **wire it to a live backend**, following the decisions
documented here and in the linked spec docs.

Because the design decisions already name a concrete stack (static frontend + Supabase),
implement against that stack unless the developer has a strong reason to deviate. If deviating,
preserve the data model, the API surface, and the server-side-ELO principle.

## Fidelity
**High-fidelity.** The prototype (`EF Pong Prototype.dc.html`) has final layout, colors,
typography, spacing, and interactions, built on the **EF Backpack design system** (EF blue
`#006BD6` on a warm mono-black/white canvas, EF Circular type, pill buttons, 16px cards).
Recreate the UI faithfully using the target codebase's component library, and apply EF Backpack
tokens for styling. The backend docs are a hi-fi **architecture** spec, not code — implement
them idiomatically for the chosen platform.

## The stack (locked decisions)
- **Frontend:** static app (HTML/JS/CSS or a static-exported framework build), hosted on
  **GitHub Pages** (free; code already on GitHub). Runs entirely in the browser.
- **Backend:** **Supabase** (managed Postgres). Provides the database, an auto-generated API,
  auth (magic-link + SSO), and realtime — all in one project. The browser talks to Supabase
  **directly**; the static host and Supabase never talk to each other.
- **Cost:** ~€0/month at 40 players (both free tiers). Optional ~€10/yr custom domain. Known
  ceiling ~€25/mo (Supabase Pro) only if wildly popular.

## Data model — seven tables
Full detail (columns, types, keys, relationships) in `EF Pong Data Model.dc.html`. Everything
else (rankings, head-to-head, upsets) is **computed**, not stored.

| Table | Columns (roughly) |
|---|---|
| **player** | id, name, avatar, join_date, `login_identity` (empty until auth Phase 2) |
| **standings** | id, player→player, season→season, current_elo, wins, losses, peak — **one row per player × season** (the cached leaderboard; past seasons frozen = Hall of Fame) |
| **match** | id, winner→player, loser→player, winner_score, loser_score, elo_change, timestamp, season, entered_by, `status` (confirmed/pending/disputed), voided flag |
| **rating_history** | id, player→player, match→match, rating_after, timestamp — **append-only** |
| **season** | id, name, start, end, champion→player, active flag |
| **reaction** | id, match→match, player→player (or anonymous), type |
| **comment** | id, match→match, author→player, text, timestamp |

Notes that matter for implementation:
- `standings` is a **cache** — it's always rebuildable by replaying `match` rows through the ELO
  math. Keep it consistent with matches at all times (see corrections below).
- `rating_history` is **append-only** and, with ordered matches, makes the whole season
  deterministically replayable.
- `match.status` and `player.login_identity` exist from day one but stay unused at launch —
  they're the hooks the auth path fills later. Do not strip them.

## API — ten operations
Full detail in `EF Pong Talking To It.dc.html`. Seven are plain reads/writes Supabase generates;
three are custom server-side functions.

| Operation | Type | What it does |
|---|---|---|
| `getLeaderboard` | read | Active-season standings joined to players, sorted by ELO. Powers leaderboard + wall. |
| `getFeed` | read | Recent matches, newest first, with reaction counts + comments. Powers feed + wall ticker. |
| `getPlayer` | read | One player's standing, rating-history trend, recent matches, head-to-head. Powers profile. |
| `logMatch` | **custom (write)** | The special one — records a match AND computes ELO server-side (see below). |
| `addReaction` | write | Adds 🔥/😮/🤝 to a match. Anonymous at launch. |
| `postComment` | write | Adds a comment with the pick-your-name author. |
| `deleteComment` | delete | Author removes own; admin removes anything. |
| `addPlayer` | write | Adds someone to the roster (name only). |
| `rollSeason` | **custom, admin** | Closes the active season (freeze champion), opens a new one, resets standings. |
| `correctMatch` | **custom, admin** | Void/edit a match, then full-season replay (see below). |

### ELO — computed server-side, inside `logMatch`
ELO **must** run on the server, never the phone, so everyone agrees, results can't be faked, and
the zero-sum update stays atomic. Move the prototype's `calcDelta` / `expected` / `marginMult`
math **verbatim** into the `logMatch` database function.

Parameters (locked):
- Starting rating **1000**.
- K-factor **24**, but **40** for a player's first 5 (provisional) games.
- Margin-of-victory multiplier **`M = 1 + ln(pointDiff) / ln(11)`** where `pointDiff = winnerScore − loserScore`.
- **Zero-sum:** winner gains exactly what loser loses.
- **Rating floor ~100.**

`logMatch`, in order (one atomic transaction — all succeed or none):
1. Validate the two players + score.
2. Read both players' current standings (ratings).
3. Compute expected scores, apply K and the margin multiplier → delta.
4. Insert the `match` row (with `elo_change`, status `confirmed`, active season).
5. Update both `standings` rows (new ELO, win/loss, peak).
6. Append two `rating_history` rows.
7. Return the result so the app can show "+22 ELO".

Steps 4–6 are one unit — a match touches three tables and they must commit together.

### Corrections — `correctMatch` = void/edit, then full-season replay
Detail in `EF Pong Admin And Corrections.dc.html`. Because ELO is chained, you can't just delete a
bad match. The fix:
1. Admin picks the match, chooses **void** (mark voided) or **edit** (correct the facts).
2. Apply the change to that one `match` row.
3. Reset the season's `standings` to 1000 and clear its `rating_history`.
4. Replay every non-voided match of the season in time order through the same ELO math.
5. Rewrite `standings` + re-append `rating_history` from the replay.
6. All as one atomic unit.

Full-season replay (not partial) is the chosen approach: one code path for void and edit, reuses
trusted ELO, obviously correct, and instant at a few-hundred matches per season. The same replay
also self-heals `standings` if the cache ever drifts. Voids are **marked, not hard-deleted** —
history stays auditable.

## Auth — phased, additive (no rebuild)
Detail in `EF Pong The Auth Path.dc.html`. "Who are you?" only touches three fields: `entered_by`
(match), `author_id` (comment), and later "who may log." All point at a `player` row; auth only
changes how confidently that's filled — via the `player.login_identity` column.

- **Phase 1 — Pick your name (LAUNCH, today):** no real login; tap your name, device remembers it.
  Anyone can log any match (honour system). `login_identity` empty. This is what the prototype does.
- **Phase 2 — Email magic-link (the upgrade):** turn on Supabase magic-link auth; on first sign-in
  write email into `login_identity`. Now the API can enforce "log only matches you played" →
  unlocks confirm-or-dispute (`match.status` = pending/disputed).
- **Phase 3 — EF SSO (much later):** point Supabase SSO at EF's identity provider; existing EF
  accounts, auto-provisioned profiles, genuinely office-only. Same `login_identity` slot, stronger proof.

Each phase is a config toggle plus (Phase 2) one line linking sign-in to a player row. No tables or
screens change. **Launch on Phase 1.**

## The live wall — Supabase realtime, polling fallback
Detail in `EF Pong The Live Wall.dc.html`. The wall must stay current unattended for days.
- Use **Supabase realtime:** subscribe once to `match`, `standings`, `reaction`, `comment`; on any
  change, refetch the affected view (`getLeaderboard` / `getFeed`) and animate the diff (new row
  slides in, ELO ticks).
- **Fallback:** if the connection drops, poll the same two reads every ~10s until it's back.
- **Unattended robustness:** auto-reconnect + full refetch on reconnect; refetch on tab/screen wake;
  redraw from fresh reads (no accumulating state) so a screen left on all quarter stays healthy.

## Screens / views (from the prototype)
Recreate these from `EF Pong Prototype.dc.html`, which has exact layout, copy, and interactions.
All use the EF Backpack design system.
- **Leaderboard** — ranked ladder for the active season (rank, avatar, name, ELO, W/L). Powers the
  main view and the wall.
- **Log a match** — pick winner + loser from the roster, enter score; shows the live ELO delta.
- **Feed** — reverse-chronological matches with reaction counts and comments; add reaction / comment.
- **Profile + head-to-head** — one player's standing, rating trend line, recent matches, H2H record.
- **Wall display** — big-screen leaderboard + live match ticker; the realtime target.
- **Identity gate** — "pick your name" first-run screen (Phase 1 auth). Includes a **create-player
  flow**: an "I'm new — add me" button opens an inline form (live avatar with auto-initials +
  assigned color, name field, duplicate-name block, "Add me & continue"). New players self-register
  at 1000 ELO via the `addPlayer` operation and are selected as the device identity. On day one the
  gate opens straight into this form (empty-state "Be the first"). The leaderboard and feed also have
  first-run empty states (few-players invite hint; "No matches yet") so day one doesn't look broken.

## Design tokens (EF Backpack)
Use the bound design system for exact values; key ones:
- **Colors:** brand primary `#006BD6`; mono-black `#191919` (not pure black); gray-100 `#F5F5F5`
  (surfaces), gray-400 `#949494` (borders); success `#008928`, warning/red `#D1334A`, attention
  `#FAB005`, promo pink `#DA2381`.
- **Type:** EF Circular (300 body, 500 titles, 700 headers, 900 eyebrow/display); IBM Plex Mono for
  data/timers; display up to ~72–80px. Sentence case everywhere except all-caps eyebrows.
- **Spacing:** 4px base grid. **Radii:** 4 (small), 8 (inputs/images), 16 (cards), full pills for
  buttons/chips/avatars. **Elevation:** restrained — 1px `black/10` hairline on cards; 2px lift on hover.
- **Motion:** 150–300ms, standard easing `cubic-bezier(0.4,0,0.95,1)`; signature "link with arrow"
  nudges arrow ~8px on hover. No bounces.

## Assets
- **Icons:** Phosphor (`@phosphor-icons/web`). Regular for most UI, bold in buttons/carets, fill for status.
- **Logos:** EF Backpack lockup SVGs (via the design system's `Logo` component) — never redraw/recolor.
- **No emoji in product chrome** except the three reaction glyphs (🔥/😮/🤝), which are content.
- **Player avatars:** placeholder in the prototype — supply real ones or initials at build.

## Implementation order (recommended)
1. Create the Supabase project → recreate the seven tables (Data Model doc) in the table editor.
2. Open the first season. **No player seeding** — players self-register via the in-app
   create-player flow (see below), each starting at 1000 ELO; the roster fills in live from day one.
3. **Checkpoint:** get just `players` reading/writing live end-to-end via the create-player form
   (proves the GitHub Pages ↔ Supabase path).
4. Point the prototype's data layer at Supabase — swap in-memory seeds for the API calls above
   (shapes already match the tables by design).
5. Move the ELO math into the `logMatch` database function; add `rollSeason` and `correctMatch`.
6. Turn on realtime for the wall; publish the frontend to GitHub Pages.
7. (Later) Phase 2 auth: enable magic-link, link `login_identity`, turn on confirm/dispute.

## Files in this bundle
- `EF Pong PRD.dc.html` — full product requirements (source of truth).
- `EF Pong Prototype.dc.html` — clickable hi-fi frontend prototype (the UI to recreate).
- `EF Pong Data Model.dc.html` — Step 1: the seven tables in detail.
- `EF Pong Where Data Lives.dc.html` — Step 2: Supabase platform decision.
- `EF Pong Talking To It.dc.html` — Step 3: the ten API operations + server-side ELO.
- `EF Pong Hosting And Cost.dc.html` — Step 4: GitHub Pages + Supabase, and cost.
- `EF Pong The Auth Path.dc.html` — Step 5: the phased login road.
- `EF Pong Admin And Corrections.dc.html` — Step 6: `correctMatch` and replay.
- `EF Pong The Live Wall.dc.html` — Step 7: realtime + polling fallback.
- `EF Pong Backend Handoff.dc.html` — the running walkthrough brief (context + decision log).

Open the `.dc.html` files in a browser to read them as formatted documents.
