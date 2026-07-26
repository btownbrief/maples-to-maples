// MAPLES TO MAPLES — app shell: tabs, weekly round, results + archive.
import { rpc, playerId, playerToken, getName, setName } from './api.js';
import { createDeck } from './swipe.js';
import { classifyPhase, msUntil } from './rounds.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => show(t, false), ms);
}

// ---------------- name picking (shared arcade identity) ----------------
function ensureName() {
  return new Promise((resolve) => {
    if (getName()) return resolve(getName());
    show($('name-modal'));
    $('name-input').focus();
    const save = () => {
      const v = $('name-input').value.trim();
      if (!v) return;
      setName(v);
      show($('name-modal'), false);
      resolve(getName());
    };
    $('name-save').onclick = save;
    $('name-input').onkeydown = (e) => { if (e.key === 'Enter') save(); };
  });
}

// ---------------- tabs ----------------
const views = { week: $('view-week'), results: $('view-results') };
function goto(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
  Object.entries(views).forEach(([k, v]) => show(v, k === tab));
  if (tab === 'results') loadResults();
  if (tab === 'week') loadRound();
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => goto(b.dataset.tab)));

function fmtDeadline(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
}

// ---------------- THIS WEEK ----------------
let round = null;
let deck = null;

// Self-heal without a reload: re-fetch the round the moment the server's
// phase deadline passes, and whenever the tab comes back into focus with
// a stale phase (rounds.js mirrors the server's Vermont wall-clock math).
function schedulePhaseFlip() {
  clearTimeout(schedulePhaseFlip._t);
  const ms = msUntil(round?.phase_ends_at);
  if (ms > 0) schedulePhaseFlip._t = setTimeout(loadRound, Math.min(ms + 1500, 6 * 3600 * 1000));
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !round?.card) return;
  if (classifyPhase(round.card.week_of) !== round.phase) loadRound();
});

async function loadRound() {
  const panels = ['round-loading', 'round-none', 'round-answer', 'round-vote', 'round-upcoming'];
  panels.forEach((id) => show($(id), id === 'round-loading'));
  try {
    round = await rpc('m2m_get_current_round', { p_player: playerId() });
  } catch (e) {
    $('round-loading').textContent = 'Hmm, couldn’t reach the game. Try again in a minute?';
    console.error(e);
    return;
  }
  show($('round-loading'), false);
  $('week-chip').textContent = round.card
    ? `week of ${new Date(round.card.week_of + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : '';
  schedulePhaseFlip();

  if (!round.card || round.phase === 'none') return show($('round-none'));
  if (round.phase === 'upcoming') return show($('round-upcoming'));
  if (round.phase === 'answer') return showAnswerPhase();
  if (round.phase === 'vote') return showVotePhase();
}

function showAnswerPhase() {
  show($('round-answer'));
  $('green-prompt').textContent = round.card.prompt;
  $('answer-deadline').textContent = `Answers close ${fmtDeadline(round.phase_ends_at)} — then Btown judges.`;
  $('answer-count-line').textContent =
    round.answer_count > 0
      ? `${round.answer_count} answer${round.answer_count === 1 ? '' : 's'} in so far`
      : 'Be the first to play a card!';

  const mine = round.your_answer;
  if (mine) {
    $('answer-text').value = mine.text;
    $('answer-chars').textContent = String(80 - mine.text.length);
    $('answer-done').textContent = mine.status === 'approved'
      ? '✅ Your card is in the deck! You can still reword it until voting starts (edits get re-reviewed).'
      : '📮 Your card is in! The editor gives every card a quick once-over before it joins the deck.';
    show($('answer-done'));
  } else {
    show($('answer-done'), false);
  }
}

$('answer-text').addEventListener('input', () => {
  $('answer-chars').textContent = String(80 - $('answer-text').value.length);
});

$('answer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('answer-text').value.trim();
  if (!text) return;
  await ensureName();
  const btn = $('answer-submit');
  btn.disabled = true;
  try {
    await rpc('m2m_submit_answer', {
      p_card: round.card.id, p_player: playerId(), p_token: playerToken(),
      p_name: getName(), p_text: text,
    });
    $('answer-done').textContent =
      '📮 Card played! The editor gives every card a quick once-over before it joins the deck.';
    show($('answer-done'));
    toast('Answer in! 🍁');
  } catch (err) {
    toast(err.message || 'Could not submit — try again?');
  }
  btn.disabled = false;
});

async function showVotePhase() {
  show($('round-vote'));
  $('vote-prompt').textContent = round.card.prompt;
  $('vote-progress').textContent = '…';
  let data;
  try {
    data = await rpc('m2m_get_answers_to_swipe', { p_card: round.card.id, p_player: playerId() });
  } catch (e) {
    toast('Could not load the deck — try again?');
    console.error(e);
    return;
  }
  let voted = data.voted;
  const total = data.total;

  const progress = () => {
    $('vote-progress').textContent = total === 0 ? '' : `${voted} of ${total} judged`;
    show($('deck-empty'), deck && deck.remaining === 0);
    $('btn-undo').disabled = !deck?.canUndo;
    if (total === 0) $('deck-empty').querySelector('p').textContent =
      'No cards in the deck yet (yours doesn’t count — no self-votes!). Check back soon.';
    if (deck?.remaining === 0) show($('deck-empty'));
  };

  deck = createDeck($('deck'), data.cards, {
    onVote: async (id, value) => {
      await rpc('m2m_vote_answer', {
        p_answer: id, p_player: playerId(), p_token: playerToken(), p_value: value,
      });
      voted += value === 0 ? -1 : 1;
    },
    onEmpty: () => show($('deck-empty')),
    onProgress: progress,
  });
  deck.render();
  progress();
}

$('btn-yep').onclick = () => deck?.vote(1);
$('btn-nope').onclick = () => deck?.vote(-1);
$('btn-undo').onclick = () => deck?.undo();

// ---------------- RESULTS ----------------
async function loadResults() {
  let data;
  try {
    data = await rpc('m2m_get_results');
  } catch (e) {
    toast('Could not load results');
    console.error(e);
    return;
  }
  const has = Boolean(data.card);
  show($('results-none'), !has);
  show($('results-body'), has);
  if (!has) return;

  $('results-prompt').textContent = data.card.prompt;
  $('results-week').textContent = `week of ${new Date(data.card.week_of + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  $('results-stats').textContent =
    `${data.answer_count} answers · ${data.total_votes} swipes of judgment from Btown`;

  const list = $('results-list');
  list.textContent = '';
  (data.top || []).forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'result-row' + (i === 0 ? ' winner' : '');
    const net = document.createElement('div');
    net.className = 'net' + (row.net < 0 ? ' neg' : '');
    net.textContent = (row.net > 0 ? '+' : '') + row.net;
    const body = document.createElement('div');
    body.className = 'body';
    if (i === 0) {
      const tag = document.createElement('div');
      tag.className = 'winner-tag';
      tag.textContent = '🍁 TOP MAPLE · as seen in the BTown Brief';
      body.appendChild(tag);
    }
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = `“${row.text}”`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `— ${row.name} · 🍁 ${row.up} / 👎 ${row.down}`;
    body.append(text, meta);
    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = i === 0 ? '🍁' : `${i + 1}`;
    li.append(rank, body, net);
    list.appendChild(li);
  });

  // past weeks
  const archive = data.archive || [];
  show($('archive-section'), archive.length > 0);
  const arc = $('archive-list');
  arc.textContent = '';
  archive.forEach((w) => {
    const li = document.createElement('li');
    li.className = 'archive-row';
    const prompt = document.createElement('div');
    prompt.className = 'archive-prompt';
    prompt.textContent = w.prompt;
    const week = document.createElement('div');
    week.className = 'archive-week';
    week.textContent = new Date(w.week_of + 'T12:00:00')
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const win = document.createElement('div');
    win.className = 'archive-winner';
    win.textContent = w.winner_text
      ? `🍁 “${w.winner_text}” — ${w.winner_name}`
      : 'No answers made the deck that week.';
    li.append(prompt, week, win);
    arc.appendChild(li);
  });
}

// ---------------- go ----------------
loadRound();
