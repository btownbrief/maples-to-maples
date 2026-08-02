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

## Party Mode (`party.html`)

The in-person, big-group way to play — built for a real table (a coffee
meetup, a game night): **one phone passes around**, everyone but the judge
writes an answer to the green card, the judge reads them out loud and
crowns one, the judge rotates every round. One game is a full trip around
the table (everyone judges once), 3–16 players, 6–12 is the sweet spot.
After the crowning, everyone's answers are unmasked (the "who wrote THAT?"
moment), and a latecomer can be dealt in between rounds. The screen holds
itself awake while a party is live.

It's entirely on-device: no Supabase, no accounts, no moderation queue —
party answers never leave the phone and vanish with the party. The current
game is kept in localStorage so an accidental refresh doesn't kill game
night. It has its own green-card deck (`js/party-cards.js`) so game night
never spoils or drains the weekly queue.

- `js/party-engine.js` — PURE party rules (fleet engine convention: plain
  JSON state, seeded RNG inside the state, no DOM/network/clock); tested
  by `scripts/test-party.mjs` (`node`, no framework)
- `js/party.js` + `party.html` — the screens (setup, pass-the-phone,
  compose, judge, reveal, standings); UI only
- `js/party-cards.js` — the party deck of green cards

GitHub Actions:

- `deploy.yml` — GitHub Pages deploy on push
- `promote.yml` — Monday-morning round rollover (the game also self-heals
  on load and in-page when a phase deadline passes)
- `pending-answers.yml` — every 2h, opens/closes a GitHub issue when
  reader answers await review (the issue email is the notification)
