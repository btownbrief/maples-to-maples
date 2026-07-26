-- MIGRATION 2026-07-26 — paste this whole file into the Supabase SQL Editor
-- (btown-games project) and click Run. Safe to re-run: it only replaces one
-- function and touches no data.
--
-- What it fixes: m2m_submit_answer used to send an edited answer back to
-- 'pending' only when its TEXT changed. That let a player get approved, then
-- change their public display NAME to something abusive and stay approved.
-- Now any change — text or name — goes back to 'pending' for review.

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
                       and m2m_answers.name = excluded.name
                      then m2m_answers.status else 'pending' end
    where m2m_answers.token = excluded.token;  -- only the owning device edits
end $$;
