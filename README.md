# 🍁 MAPLES TO MAPLES

Btown's weekly community judging game — part of the
[Btown Games](https://play.btownbrief.com) arcade from the
[BTown Brief](https://www.btownbrief.com). In the spirit of the classic
party judging games, with an all-original Burlington deck.

**Play it: https://play.btownbrief.com/maples-to-maples/**

## How a week works (all times Vermont)

| When | What |
| --- | --- |
| Monday 00:00 → Wednesday noon | 🍁 One green card (a Burlington prompt) goes live; readers play their answer (≤80 chars) |
| Wednesday noon → Sunday night | 🔥 Tinder-style swipe judging (🍁 right / 👎 left) on the approved answers |
| Monday morning | 🏆 The Top Maple is crowned on the Results tab, next green card goes live automatically |

Every reader answer sits in a **review queue** until the editor approves
it from `admin.html` — nothing appears publicly unmoderated. The editor
also writes and queues future green cards from the same desk; each Monday
pulls the next card in line.

Voting is **one vote per local player identity (per browser)**: the same
`btown-*` id + token minted in `js/api.js` that names you on every arcade
leaderboard. Clearing browser storage mints a fresh voter, so a determined
person could vote again — the same honor-system tradeoff the fleet accepts
for its leaderboards, and the right size for a small community game. There
are no accounts, by design.

## Architecture

Plain static site — no build step. `index.html` + `style.css` + ES modules
in `js/`. Backend is the shared Btown Games Supabase project: everything is
locked behind RLS and the public key can only call the `m2m_*`
security-definer RPCs in [`supabase/schema.sql`](supabase/schema.sql).
Setup steps in [`supabase/SETUP.md`](supabase/SETUP.md).

- `js/api.js` — Supabase RPC + shared `btown-*` player identity
- `js/rounds.js` — pure Vermont-wall-clock round math (week keys, phase
  boundaries); tested by `scripts/test-rounds.mjs` (`node`, no framework)
- `js/swipe.js` — the swipe deck (pointer physics, stamps, undo)
- `js/main.js` — tabs, weekly round phases, results + past-weeks archive
- `js/admin.js` + `admin.html` — the Editor's Desk (passphrase-gated
  moderation + the green card queue)
- `data/green-cards.md` — the 12 launch prompts (seed SQL in SETUP.md)

GitHub Actions:

- `deploy.yml` — GitHub Pages deploy on push
- `promote.yml` — Monday-morning round rollover (the game also self-heals
  on load and in-page when a phase deadline passes)
- `pending-answers.yml` — every 2h, opens/closes a GitHub issue when
  reader answers await review (the issue email is the notification)
