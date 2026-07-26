# Maples to Maples — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for the weekly flow and architecture — this file adds the rules
an agent needs. Stephen is non-technical — explain consequential changes in plain
language.

## What this is
Btown's weekly community judging game: one Burlington green-card prompt a week,
readers play short answers, the town swipes on them. Plain static site, **no build
step**: `index.html` + `admin.html` + `style.css` + ES modules in `js/`. Deployed by
GitHub Pages via `.github/workflows/deploy.yml` on push. Sibling of caption-this —
same machinery, prompt cards instead of photos.

## The moving parts
- `js/api.js` — Supabase RPC + shared `btown-*` player identity
- `js/rounds.js` — PURE round-phase and week-key math (Vermont wall clock). No DOM,
  no network, no hidden clock; it mirrors the schema's `m2m_phase`/`m2m_week_monday`.
  If you change the weekly shape, change schema AND rounds.js AND the tests together.
- `js/swipe.js` — swipe judging deck (pointer physics, undo)
- `js/main.js` — tabs, weekly round phases, results + archive
- `js/admin.js` + `admin.html` — the Editor's Desk (moderation + green card queue)
- Actions: `promote.yml` (Monday-morning round rollover — the game also self-heals on
  load), `pending-answers.yml` (every 2h, opens/closes a GitHub issue when reader
  answers await review — the issue email is Stephen's notification), `deploy.yml`.

## Submissions & approval — this is MANUAL, there is no AI in it
Reader answers are born `pending` and are invisible to voters until the editor
approves them from `admin.html`. Answers edited by their author go back to pending.
The admin dashboard is **passphrase-gated**: every admin RPC verifies the passphrase
server-side (`m2m_admin_check_pass`); the pass is cached in localStorage after first
unlock. Approve/reject/queue all go through security-definer RPCs. **No moderation
model, no AI API — do not add one unless Stephen explicitly asks.**

## Backend rules
Shared Btown Games Supabase project; this game owns only the `m2m_*` tables and
functions — never touch the caption-this or scores objects. Everything is behind RLS;
the public anon key can **only** call the security-definer RPCs in
`supabase/schema.sql` (setup in `supabase/SETUP.md`). Never put a service-role key or
the admin passphrase in client JS or commit it — the passphrase is checked
server-side by design.

## Before you finish
Run `node scripts/test-rounds.mjs` — plain Node, no framework, must pass. If you
changed RPC calls or the round lifecycle, walk the weekly flow (answer → approve →
vote → results) against a Supabase instance, or clearly say you could not and what
you inspected instead. Say what you verified.
