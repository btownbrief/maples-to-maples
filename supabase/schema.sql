-- MAPLES TO MAPLES — schema for the Btown Games weekly judging game.
-- Paste this WHOLE file into the Supabase SQL Editor (same btown-games
-- project as the leaderboard and CAPTION THIS) and click Run.
--
-- Run it AS-IS (no edits needed), then set your real admin passphrase with
-- the one-line insert in SETUP.md step 2 — the passphrase never belongs in
-- this file, because this repo is public.
--
-- Everything here is prefixed m2m_ and lives alongside — never touches —
-- the caption-this and scores tables. Security model is identical: RLS
-- locks every table completely; the public anon key can ONLY go through
-- the security-definer functions below. Admin functions additionally
-- require the passphrase, which is stored only as a bcrypt hash.
--
-- Weekly lifecycle (America/New_York):
--   Each green card runs Monday–Sunday. Answers open Mon 00:00 → Wed 12:00
--   (noon); voting runs Wed 12:00 → Sun 23:59; then the round is done and
--   the oldest 'queued' card is promoted. Promotion happens inside
--   m2m_advance_rounds(), which is called by every m2m_get_current_round()
--   AND by a Monday-morning GitHub Action — zero maintenance.
--
-- Moderation is MANUAL by design: answers arrive as 'pending' and are
-- invisible to voters until the editor approves them from admin.html.

-- Supabase keeps extensions in the "extensions" schema, and every function
-- below pins search_path=public, so pgcrypto calls must be schema-qualified.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

-- Green cards: the weekly prompts. Only the editor writes these (from the
-- admin desk); they wait in line as 'queued' and go live oldest-first.
create table if not exists public.m2m_cards (
  id uuid primary key default gen_random_uuid(),
  prompt text not null check (length(prompt) between 1 and 120),
  status text not null default 'queued'
    check (status in ('queued','live','done','removed')),
  week_of date,                    -- the Monday this card's round started
  answers_until timestamptz,      -- answer phase ends (Wed noon NY)
  votes_until timestamptz,        -- voting ends / round over (Mon 00:00 NY)
  created_at timestamptz not null default now()
);
-- at most one card may be live at a time
create unique index if not exists m2m_cards_one_live
  on public.m2m_cards ((true)) where status = 'live';

-- Red cards: reader answers. Born 'pending'; only 'approved' answers ever
-- appear in the voting deck or results.
create table if not exists public.m2m_answers (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.m2m_cards(id) on delete cascade,
  player_id uuid not null,
  token text not null,             -- device secret; proves answer ownership
  name text not null,
  text text not null check (length(text) between 1 and 80),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  unique (card_id, player_id)      -- one answer per player per card
);

create table if not exists public.m2m_votes (
  answer_id uuid not null references public.m2m_answers(id) on delete cascade,
  voter_player_id uuid not null,
  voter_token text not null,       -- proves vote ownership (for undo/change)
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (answer_id, voter_player_id)  -- one vote per player per answer
);

create table if not exists public.m2m_admin_config (
  id boolean primary key default true check (id),  -- single row
  pass_hash text not null
);

-- Seeds a random, unrecoverable placeholder hash on a FRESH database only —
-- nobody (including you) can log in until you set a real passphrase in
-- SETUP.md step 2. "do nothing" means re-running this file can never clobber
-- the live passphrase.
--
-- Never put the real passphrase in this file — the repo is public. To set or
-- rotate it, paste this into the Supabase SQL editor instead (bare crypt() is
-- fine there; only the pinned-search_path functions below need qualifying):
--
--   insert into public.m2m_admin_config (pass_hash)
--   values (crypt('your-new-passphrase', gen_salt('bf')))
--   on conflict (id) do update set pass_hash = excluded.pass_hash;
--
insert into public.m2m_admin_config (pass_hash)
values (extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')))
on conflict (id) do nothing;

-- Lock everything down: anon can only use the functions below.
alter table public.m2m_cards enable row level security;
alter table public.m2m_answers enable row level security;
alter table public.m2m_votes enable row level security;
alter table public.m2m_admin_config enable row level security;
revoke all on table public.m2m_cards from anon, authenticated;
revoke all on table public.m2m_answers from anon, authenticated;
revoke all on table public.m2m_votes from anon, authenticated;
revoke all on table public.m2m_admin_config from anon, authenticated;

-- --------------------------------------------------------------- helpers

create or replace function public.m2m_ny_now() returns timestamp
language sql stable as $$
  select now() at time zone 'America/New_York';
$$;

-- the Monday of the current week, NY time
create or replace function public.m2m_week_monday() returns date
language sql stable as $$
  select (public.m2m_ny_now()::date
          - (extract(isodow from public.m2m_ny_now())::int - 1));
$$;

-- NY wall-clock date+time -> timestamptz
create or replace function public.m2m_ny_ts(d date, hrs int) returns timestamptz
language sql stable as $$
  select (d::timestamp + make_interval(hours => hrs))
         at time zone 'America/New_York';
$$;

create or replace function public.m2m_is_admin(p_pass text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from m2m_admin_config
    where pass_hash = extensions.crypt(coalesce(p_pass, ''), pass_hash)
  );
$$;
revoke all on function public.m2m_is_admin(text) from public, anon, authenticated;

create or replace function public.m2m_require_admin(p_pass text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not m2m_is_admin(p_pass) then
    raise exception 'bad admin passphrase' using errcode = '28000';
  end if;
end $$;
revoke all on function public.m2m_require_admin(text) from public, anon, authenticated;

-- ------------------------------------------------------ round lifecycle

-- Close a finished round and promote the oldest queued green card.
-- Idempotent; safe to call any time from anywhere.
create or replace function public.m2m_advance_rounds() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_week date;
  v_ans timestamptz;
begin
  update m2m_cards set status = 'done'
  where status = 'live' and votes_until <= now();

  if not exists (select 1 from m2m_cards where status = 'live') then
    v_week := m2m_week_monday();
    v_ans  := m2m_ny_ts(v_week + 2, 12);          -- Wednesday noon NY
    if now() >= v_ans then                         -- past Wed noon: wait for
      v_week := v_week + 7;                        -- next Monday instead
      v_ans  := m2m_ny_ts(v_week + 2, 12);
    end if;
    update m2m_cards
    set status = 'live', week_of = v_week,
        answers_until = v_ans,
        votes_until = m2m_ny_ts(v_week + 7, 0)     -- following Monday 00:00 NY
    where id = (select id from m2m_cards
                where status = 'queued'
                order by created_at limit 1);
  end if;
end $$;

create or replace function public.m2m_phase(c m2m_cards) returns text
language sql stable as $$
  select case
    when c.status <> 'live' then 'none'
    when c.week_of > public.m2m_ny_now()::date then 'upcoming'
    when now() < c.answers_until then 'answer'
    when now() < c.votes_until then 'vote'
    else 'none'
  end;
$$;

-- ----------------------------------------------------------- player RPCs

-- The one call the game makes on load: auto-advances rounds, then reports
-- the live green card, the phase, and (if a player id is given) that
-- player's own answer so the page can show its review status.
create or replace function public.m2m_get_current_round(p_player uuid default null)
returns json
language plpgsql security definer set search_path = public as $$
declare
  c m2m_cards;
  ph text;
begin
  perform m2m_advance_rounds();
  select * into c from m2m_cards where status = 'live';
  if not found then
    return json_build_object('phase', 'none', 'card', null);
  end if;
  ph := m2m_phase(c);
  return json_build_object(
    'phase', ph,
    'phase_ends_at', case ph when 'answer' then c.answers_until
                             when 'vote' then c.votes_until
                             when 'upcoming' then m2m_ny_ts(c.week_of, 0) end,
    'card', json_build_object('id', c.id, 'prompt', c.prompt, 'week_of', c.week_of),
    'answer_count', (select count(*) from m2m_answers
                     where card_id = c.id and status <> 'rejected'),
    'your_answer', case when p_player is null then null else
      (select json_build_object('text', a.text, 'status', a.status)
       from m2m_answers a
       where a.card_id = c.id and a.player_id = p_player) end
  );
end $$;

-- Upsert the player's single answer for the live card (answer phase only).
-- Edits during the answer phase are allowed, but a changed answer goes back
-- to 'pending' for another look from the editor.
create or replace function public.m2m_submit_answer(
  p_card uuid, p_player uuid, p_token text, p_name text, p_text text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  c m2m_cards;
  clean_name text := left(trim(coalesce(p_name, '')), 20);
  clean_text text := left(trim(coalesce(p_text, '')), 80);
begin
  select * into c from m2m_cards where id = p_card;
  if not found or m2m_phase(c) <> 'answer' then
    raise exception 'answers are closed' using errcode = 'P0001';
  end if;
  if length(clean_text) = 0 then
    raise exception 'empty answer' using errcode = 'P0001';
  end if;
  if length(clean_name) = 0 then clean_name := 'Anonymous'; end if;
  -- sanity cap: one card can't accumulate unbounded answers
  if (select count(*) from m2m_answers where card_id = p_card) >= 500 then
    raise exception 'answer limit reached' using errcode = 'P0001';
  end if;
  insert into m2m_answers (card_id, player_id, token, name, text)
  values (p_card, p_player, p_token, clean_name, clean_text)
  on conflict (card_id, player_id) do update
    set text = excluded.text, name = excluded.name, created_at = now(),
        status = case when m2m_answers.text = excluded.text
                      then m2m_answers.status else 'pending' end
    where m2m_answers.token = excluded.token;  -- only the owning device edits
end $$;

-- Approved answers the player hasn't voted on yet (never their own), random
-- order, plus progress numbers for "12 of 34 judged".
create or replace function public.m2m_get_answers_to_swipe(
  p_card uuid, p_player uuid
) returns json
language plpgsql security definer set search_path = public as $$
declare
  c m2m_cards;
begin
  select * into c from m2m_cards where id = p_card;
  if not found or m2m_phase(c) <> 'vote' then
    return json_build_object('cards', '[]'::json, 'voted', 0, 'total', 0);
  end if;
  return json_build_object(
    'cards', coalesce((
      select json_agg(json_build_object('id', a.id, 'name', a.name, 'text', a.text)
                      order by random())
      from m2m_answers a
      where a.card_id = p_card and a.status = 'approved'
        and a.player_id <> p_player
        and not exists (select 1 from m2m_votes v
                        where v.answer_id = a.id
                          and v.voter_player_id = p_player)
    ), '[]'::json),
    'voted', (select count(*) from m2m_votes v
              join m2m_answers a on a.id = v.answer_id
              where a.card_id = p_card and a.status = 'approved'
                and v.voter_player_id = p_player),
    'total', (select count(*) from m2m_answers a
              where a.card_id = p_card and a.status = 'approved'
                and a.player_id <> p_player)
  );
end $$;

-- value +1 / -1 votes (upsert, token-guarded); value 0 retracts (undo).
create or replace function public.m2m_vote_answer(
  p_answer uuid, p_player uuid, p_token text, p_value int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  a m2m_answers;
  c m2m_cards;
begin
  if p_value not in (-1, 0, 1) then return; end if;
  select * into a from m2m_answers where id = p_answer;
  if not found or a.status <> 'approved' then return; end if;
  select * into c from m2m_cards where id = a.card_id;
  if m2m_phase(c) <> 'vote' then
    raise exception 'voting is closed' using errcode = 'P0001';
  end if;
  if a.player_id = p_player then
    raise exception 'cannot vote on your own answer' using errcode = 'P0001';
  end if;
  if p_value = 0 then
    delete from m2m_votes
    where answer_id = p_answer and voter_player_id = p_player
      and voter_token = p_token;
  else
    insert into m2m_votes (answer_id, voter_player_id, voter_token, value)
    values (p_answer, p_player, p_token, p_value)
    on conflict (answer_id, voter_player_id) do update
      set value = excluded.value
      where m2m_votes.voter_token = excluded.voter_token;
  end if;
end $$;

-- Results tab in one call: the most recently finished round (top 10 approved
-- answers by net votes) plus an archive of the finished rounds before it.
create or replace function public.m2m_get_results() returns json
language plpgsql security definer set search_path = public as $$
declare
  c m2m_cards;
begin
  perform m2m_advance_rounds();
  select * into c from m2m_cards
  where status = 'done' order by votes_until desc limit 1;
  if not found then return json_build_object('card', null); end if;
  return json_build_object(
    'card', json_build_object('id', c.id, 'prompt', c.prompt, 'week_of', c.week_of),
    'answer_count', (select count(*) from m2m_answers
                     where card_id = c.id and status = 'approved'),
    'total_votes', (select count(*) from m2m_votes v
                    join m2m_answers a on a.id = v.answer_id
                    where a.card_id = c.id and a.status = 'approved'),
    'top', coalesce((
      select json_agg(row_to_json(t)) from (
        select a.name, a.text,
               coalesce(sum(v.value) filter (where v.value = 1), 0)::int as up,
               coalesce(-sum(v.value) filter (where v.value = -1), 0)::int as down,
               coalesce(sum(v.value), 0)::int as net
        from m2m_answers a
        left join m2m_votes v on v.answer_id = a.id
        where a.card_id = c.id and a.status = 'approved'
        group by a.id, a.name, a.text, a.created_at
        order by net desc, up desc, a.created_at asc
        limit 10
      ) t
    ), '[]'::json),
    'archive', coalesce((
      select json_agg(row_to_json(t)) from (
        select w.prompt, w.week_of, win.name as winner_name,
               win.text as winner_text, win.net as winner_net
        from m2m_cards w
        left join lateral (
          select a.name, a.text, coalesce(sum(v.value), 0)::int as net
          from m2m_answers a
          left join m2m_votes v on v.answer_id = a.id
          where a.card_id = w.id and a.status = 'approved'
          group by a.id, a.name, a.text, a.created_at
          order by net desc,
                   coalesce(sum(v.value) filter (where v.value = 1), 0) desc,
                   a.created_at asc
          limit 1
        ) win on true
        where w.status = 'done' and w.id <> c.id
        order by w.votes_until desc
        limit 12
      ) t
    ), '[]'::json)
  );
end $$;

-- Used by the notification GitHub Action and the admin page badge.
create or replace function public.m2m_get_pending_count() returns integer
language sql security definer stable set search_path = public as $$
  select count(*)::int from m2m_answers a
  join m2m_cards c on c.id = a.card_id and c.status = 'live'
  where a.status = 'pending';
$$;

-- ------------------------------------------------------------ admin RPCs

-- Everything the Editor's Desk needs about cards in one call.
create or replace function public.m2m_admin_list_cards(p_pass text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  perform m2m_advance_rounds();
  return json_build_object(
    'queue', coalesce((select json_agg(row_to_json(t)) from (
      select id, prompt, created_at from m2m_cards
      where status = 'queued' order by created_at) t), '[]'::json),
    'live', (select row_to_json(t) from (
      select c.id, c.prompt, c.week_of, c.answers_until, c.votes_until,
             m2m_phase(c) as phase,
             (select count(*) from m2m_answers
              where card_id = c.id and status = 'pending') as pending_count,
             (select count(*) from m2m_answers
              where card_id = c.id and status = 'approved') as approved_count
      from m2m_cards c where status = 'live') t),
    'recent_done', coalesce((select json_agg(row_to_json(t)) from (
      select id, prompt, week_of from m2m_cards
      where status = 'done' order by votes_until desc limit 5) t), '[]'::json)
  );
end $$;

-- Answers on the live card, pending first then approved, with vote counts.
create or replace function public.m2m_admin_list_answers(p_pass text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  return coalesce((select json_agg(row_to_json(t)) from (
    select a.id, a.name, a.text, a.status, a.created_at,
           coalesce(sum(v.value), 0)::int as net
    from m2m_answers a
    join m2m_cards c on c.id = a.card_id and c.status = 'live'
    left join m2m_votes v on v.answer_id = a.id
    where a.status in ('pending', 'approved')
    group by a.id
    order by (a.status = 'pending') desc, a.created_at desc
  ) t), '[]'::json);
end $$;

create or replace function public.m2m_admin_approve_answer(p_pass text, p_answer uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  update m2m_answers set status = 'approved'
  where id = p_answer and status = 'pending';
end $$;

-- One tap to clear the whole review queue on the live card.
create or replace function public.m2m_admin_approve_all(p_pass text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform m2m_require_admin(p_pass);
  update m2m_answers a set status = 'approved'
  from m2m_cards c
  where c.id = a.card_id and c.status = 'live' and a.status = 'pending';
  get diagnostics n = row_count;
  return n;
end $$;

-- Works on pending (reject) and approved (pull it back out of the deck).
create or replace function public.m2m_admin_reject_answer(p_pass text, p_answer uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  update m2m_answers set status = 'rejected'
  where id = p_answer and status in ('pending', 'approved');
end $$;

-- Write a new green card into the queue.
create or replace function public.m2m_admin_add_card(p_pass text, p_prompt text)
returns void language plpgsql security definer set search_path = public as $$
declare
  clean text := left(trim(coalesce(p_prompt, '')), 120);
begin
  perform m2m_require_admin(p_pass);
  if length(clean) = 0 then
    raise exception 'empty prompt' using errcode = 'P0001';
  end if;
  insert into m2m_cards (prompt) values (clean);
end $$;

-- Fix a typo on a queued or live card.
create or replace function public.m2m_admin_update_card(
  p_pass text, p_card uuid, p_prompt text
) returns void language plpgsql security definer set search_path = public as $$
declare
  clean text := left(trim(coalesce(p_prompt, '')), 120);
begin
  perform m2m_require_admin(p_pass);
  if length(clean) = 0 then
    raise exception 'empty prompt' using errcode = 'P0001';
  end if;
  update m2m_cards set prompt = clean
  where id = p_card and status in ('queued', 'live');
end $$;

create or replace function public.m2m_admin_remove_card(p_pass text, p_card uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  update m2m_cards set status = 'removed'
  where id = p_card and status = 'queued';
end $$;

-- Force a card live right now (ends any current round). Uses this week's
-- standard boundaries, but never starts a round whose answer window is
-- already over: past Wed noon it grants 48h of answers + 4 days of voting.
create or replace function public.m2m_admin_promote_card(p_pass text, p_card uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_week date;
  v_ans timestamptz;
  v_end timestamptz;
begin
  perform m2m_require_admin(p_pass);
  if not exists (select 1 from m2m_cards
                 where id = p_card and status = 'queued') then
    raise exception 'card is not in the queue' using errcode = 'P0001';
  end if;
  update m2m_cards set status = 'done' where status = 'live';
  v_week := m2m_week_monday();
  v_ans  := m2m_ny_ts(v_week + 2, 12);
  v_end  := m2m_ny_ts(v_week + 7, 0);
  if v_ans <= now() then
    v_ans := now() + interval '48 hours';
    v_end := v_ans + interval '4 days';
  end if;
  update m2m_cards
  set status = 'live', week_of = v_week,
      answers_until = v_ans, votes_until = v_end
  where id = p_card;
end $$;

-- Close answers early: voting starts now.
create or replace function public.m2m_admin_open_voting(p_pass text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  update m2m_cards set answers_until = now()
  where status = 'live' and answers_until > now();
end $$;

-- End the current round now (results become final, next card goes live).
create or replace function public.m2m_admin_end_round(p_pass text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform m2m_require_admin(p_pass);
  update m2m_cards set votes_until = now(),
    answers_until = least(answers_until, now())
  where status = 'live';
  perform m2m_advance_rounds();
end $$;

-- Lets the admin page verify the passphrase before storing it locally.
create or replace function public.m2m_admin_check_pass(p_pass text) returns boolean
language sql security definer stable set search_path = public as $$
  select public.m2m_is_admin(p_pass);
$$;

-- ---------------------------------------------------------------- grants

grant execute on function public.m2m_get_current_round(uuid) to anon;
grant execute on function public.m2m_advance_rounds() to anon;
grant execute on function public.m2m_submit_answer(uuid, uuid, text, text, text) to anon;
grant execute on function public.m2m_get_answers_to_swipe(uuid, uuid) to anon;
grant execute on function public.m2m_vote_answer(uuid, uuid, text, int) to anon;
grant execute on function public.m2m_get_results() to anon;
grant execute on function public.m2m_get_pending_count() to anon;
grant execute on function public.m2m_admin_list_cards(text) to anon;
grant execute on function public.m2m_admin_list_answers(text) to anon;
grant execute on function public.m2m_admin_approve_answer(text, uuid) to anon;
grant execute on function public.m2m_admin_approve_all(text) to anon;
grant execute on function public.m2m_admin_reject_answer(text, uuid) to anon;
grant execute on function public.m2m_admin_add_card(text, text) to anon;
grant execute on function public.m2m_admin_update_card(text, uuid, text) to anon;
grant execute on function public.m2m_admin_remove_card(text, uuid) to anon;
grant execute on function public.m2m_admin_promote_card(text, uuid) to anon;
grant execute on function public.m2m_admin_open_voting(text) to anon;
grant execute on function public.m2m_admin_end_round(text) to anon;
grant execute on function public.m2m_admin_check_pass(text) to anon;
