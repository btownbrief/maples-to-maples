# MAPLES TO MAPLES — backend setup (one time, ~5 minutes)

This game extends the existing **btown-games** Supabase project (the same
one the arcade leaderboard and CAPTION THIS use). It adds its own `m2m_*`
tables and functions and **does not touch the caption-this or scores
tables** at all.

## 1. Run the schema

Go to the Supabase dashboard → your **btown-games** project →
**SQL Editor**, paste the whole of `supabase/schema.sql` (no edits
needed), click **Run**. You should see "Success. No rows returned."

## 2. Set your admin passphrase

Pick a passphrase you'll remember — it's what unlocks `admin.html` on
your phone. (Reusing your CAPTION THIS passphrase is fine — this game
stores its own copy, so changing one never affects the other.) Paste this
into the SQL Editor with your passphrase filled in, and click **Run**:

```sql
insert into public.m2m_admin_config (pass_hash)
values (crypt('your-passphrase-here', gen_salt('bf')))
on conflict (id) do update set pass_hash = excluded.pass_hash;
```

Only the bcrypt *hash* of your passphrase is stored. Run the same
statement again any time to change it. Never commit your passphrase to
the repo — it's public.

## 3. Load the starter green cards (optional but recommended)

> ⚠️ Steps run in order — this one fails with
> `relation "public.m2m_cards" does not exist` if step 1 hasn't run yet.

Paste this into the SQL Editor and click **Run** to queue the 12 launch
cards from `data/green-cards.md` (they go live one per week, in order —
edit the list first if you like):

```sql
insert into public.m2m_cards (prompt, created_at) values
  ('The most Burlington thing imaginable',                       now() + interval '1 second'),
  ('What downtown secretly needs more of',                       now() + interval '2 seconds'),
  ('The real mayor of Church Street',                            now() + interval '3 seconds'),
  ('The perfect excuse for being late during construction season', now() + interval '4 seconds'),
  ('What Champ does all winter',                                 now() + interval '5 seconds'),
  ('Burlington''s official scent',                               now() + interval '6 seconds'),
  ('The first rule of surviving a Vermont winter',               now() + interval '7 seconds'),
  ('What''s really at the bottom of that pothole on North Ave',  now() + interval '8 seconds'),
  ('Burlington''s next official holiday',                        now() + interval '9 seconds'),
  ('Proof that summer has finally arrived in Btown',             now() + interval '10 seconds'),
  ('What Lake Champlain is thinking about at 6 a.m.',            now() + interval '11 seconds'),
  ('The most Vermont way to settle an argument',                 now() + interval '12 seconds');
```

(The staggered timestamps just pin the queue order.)

## 4. That's it

The site already ships with the shared project URL + publishable key — no
storage bucket needed (this game is all text).

Open https://play.btownbrief.com/maples-to-maples/admin.html, enter your
passphrase, and you're the editor-in-chief. The first card goes live the
moment anyone loads the game during a Monday–Wednesday-noon window (or
tap **🚀 Make live now** on a queued card to start a round today).

## How the week runs (all times Vermont / America-New_York)

- **Monday 00:00 → Wednesday noon** — answers open on the new green card
- **Wednesday noon → Sunday 23:59** — swipe judging (approved answers only)
- **Monday morning** — round is marked done, results move to the Results
  tab, and the next green card in your queue goes live automatically
  (a GitHub Action pings the promote function Monday mornings, and the
  game itself also self-heals on every page load).

## Moderation (manual, by design)

Reader answers arrive as **pending** and are invisible until you approve
them from admin.html — approve/reject one at a time or **Approve all**.
Answers edited by their author go back to pending for another look.
`.github/workflows/pending-answers.yml` checks the queue every 2 hours;
if answers are waiting it opens a GitHub issue (GitHub emails you), and
closes it once the queue is clear.

For anything deeper, the Table Editor in the dashboard works on
`m2m_cards`, `m2m_answers`, `m2m_votes`.
