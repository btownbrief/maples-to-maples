// MAPLES TO MAPLES — app shell: tabs, weekly round, results + archive.
import { rpc, playerId, playerToken, getName, setName } from './api.js';
import { createDeck } from './swipe.js';
import { classifyPhase, msUntil } from './rounds.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function toast(msg, type = 'info', ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.className = type;
  if (document.visibilityState !== 'visible') return show(t, false);
  show(t);
  if (!reducedMotion.matches) {
    void t.offsetWidth;
    t.classList.add('toast-in');
  }
  clearTimeout(toast._hide);
  clearTimeout(toast._remove);
  toast._hide = setTimeout(() => {
    if (reducedMotion.matches) return show(t, false);
    t.classList.remove('toast-in');
    t.classList.add('toast-out');
    toast._remove = setTimeout(() => show(t, false), 180);
  }, ms);
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
  if (tab !== 'week') {
    roundRunId += 1;
    deck?.destroy();
    deck = null;
    stopDeadlineCountdown();
    clearTimeout(schedulePhaseFlip._t);
    document.querySelectorAll('.deal-in').forEach((el) => el.classList.remove('deal-in'));
  }
  if (tab !== 'results') cancelResultsEffects();
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

function fmtCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function stopDeadlineCountdown() {
  clearTimeout(stopDeadlineCountdown._t);
}

function startDeadlineCountdown(el, lead) {
  stopDeadlineCountdown();
  const tick = () => {
    const remaining = msUntil(round?.phase_ends_at);
    el.textContent = remaining > 0
      ? `${lead} in ${fmtCountdown(remaining)} · ${fmtDeadline(round.phase_ends_at)}`
      : `${lead} now…`;
    if (remaining > 0 && document.visibilityState === 'visible') {
      stopDeadlineCountdown._t = setTimeout(tick, Math.min(1000, remaining));
    }
  };
  tick();
}

// ---------------- THIS WEEK ----------------
let round = null;
let deck = null;
let roundRunId = 0;
const dealtCards = new Set();

function dealGreenCard(el) {
  if (!round?.card) return;
  if (dealtCards.has(round.card.id)) {
    el.classList.remove('deal-in');
    return;
  }
  dealtCards.add(round.card.id);
  el.classList.remove('deal-in');
  if (document.visibilityState !== 'visible') return;
  void el.offsetWidth;
  el.classList.add('deal-in');
}

// Self-heal without a reload: re-fetch the round the moment the server's
// phase deadline passes, and whenever the tab comes back into focus with
// a stale phase (rounds.js mirrors the server's Vermont wall-clock math).
function schedulePhaseFlip() {
  clearTimeout(schedulePhaseFlip._t);
  const ms = msUntil(round?.phase_ends_at);
  if (ms > 0) schedulePhaseFlip._t = setTimeout(loadRound, Math.min(ms + 1500, 6 * 3600 * 1000));
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    roundRunId += 1;
    deck?.destroy();
    deck = null;
    stopDeadlineCountdown();
    clearTimeout(schedulePhaseFlip._t);
    cancelResultsEffects();
    clearTimeout(toast._hide);
    clearTimeout(toast._remove);
    show($('toast'), false);
    document.querySelectorAll('.deal-in').forEach((el) => el.classList.remove('deal-in'));
    return;
  }
  if (views.week.classList.contains('hidden')) return;
  if (!round?.card) return loadRound();
  if (classifyPhase(round.card.week_of) !== round.phase) {
    loadRound();
  } else {
    if (round.phase === 'vote' && !deck) return loadRound();
    schedulePhaseFlip();
    if (round.phase === 'answer') startDeadlineCountdown($('answer-deadline'), 'Answers close');
    if (round.phase === 'vote') startDeadlineCountdown($('vote-deadline'), 'Judging closes');
  }
});

async function loadRound() {
  const activeRun = ++roundRunId;
  deck?.destroy();
  deck = null;
  stopDeadlineCountdown();
  const panels = ['round-loading', 'round-none', 'round-answer', 'round-vote', 'round-upcoming'];
  panels.forEach((id) => show($(id), id === 'round-loading'));
  let data;
  try {
    data = await rpc('m2m_get_current_round', { p_player: playerId() });
  } catch (e) {
    if (activeRun !== roundRunId) return;
    $('round-loading').textContent = 'Hmm, couldn’t reach the game. Try again in a minute?';
    console.error(e);
    return;
  }
  if (activeRun !== roundRunId) return;
  round = data;
  show($('round-loading'), false);
  $('week-chip').textContent = round.card
    ? `week of ${new Date(round.card.week_of + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : '';
  schedulePhaseFlip();

  if (!round.card || round.phase === 'none') return show($('round-none'));
  if (round.phase === 'upcoming') return show($('round-upcoming'));
  if (round.phase === 'answer') return showAnswerPhase();
  if (round.phase === 'vote') return showVotePhase(activeRun);
}

function showAnswerPhase() {
  show($('round-answer'));
  $('green-prompt').textContent = round.card.prompt;
  dealGreenCard($('round-answer').querySelector('.green-card'));
  startDeadlineCountdown($('answer-deadline'), 'Answers close');
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
    toast('Answer in! 🍁', 'success');
  } catch (err) {
    toast(err.message || 'Could not submit — try again?', 'error');
  }
  btn.disabled = false;
});

async function showVotePhase(activeRun) {
  deck?.destroy();
  deck = null;
  show($('round-vote'));
  $('vote-prompt').textContent = round.card.prompt;
  dealGreenCard($('round-vote').querySelector('.green-card'));
  startDeadlineCountdown($('vote-deadline'), 'Judging closes');
  $('vote-progress-label').textContent = 'Loading the deck…';
  $('vote-progress-label').classList.remove('count-pop');
  $('vote-progress-track').classList.remove('animating');
  show($('vote-progress-track'));
  $('vote-progress-fill').style.width = '0%';
  let data;
  try {
    data = await rpc('m2m_get_answers_to_swipe', { p_card: round.card.id, p_player: playerId() });
  } catch (e) {
    if (activeRun !== roundRunId) return;
    toast('Could not load the deck — try again?', 'error');
    console.error(e);
    return;
  }
  if (activeRun !== roundRunId) return;
  let voted = data.voted;
  const total = data.total;

  const progress = ({ animate = false } = {}) => {
    const label = $('vote-progress-label');
    const track = $('vote-progress-track');
    const fill = $('vote-progress-fill');
    const percent = total === 0 ? 0 : Math.min(100, (voted / total) * 100);
    label.textContent = total === 0 ? '' : `${voted} of ${total} judged`;
    track.style.setProperty('--segments', Math.max(1, Math.min(total, 30)));
    track.setAttribute('aria-valuemax', String(total));
    track.setAttribute('aria-valuenow', String(voted));
    show(track, total > 0);
    track.classList.toggle('animating', animate && !reducedMotion.matches);
    fill.style.width = `${percent}%`;
    if (animate && !reducedMotion.matches) {
      label.classList.remove('count-pop');
      void label.offsetWidth;
      label.classList.add('count-pop');
    } else {
      label.classList.remove('count-pop');
    }
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
}

$('btn-yep').onclick = () => deck?.vote(1);
$('btn-nope').onclick = () => deck?.vote(-1);
$('btn-undo').onclick = () => deck?.undo();

// ---------------- RESULTS ----------------
let resultsRunId = 0;
let resultsTimers = [];
const revealedResults = new Set();

function formatNet(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

function cancelResultsEffects() {
  resultsRunId += 1;
  resultsTimers.forEach(clearTimeout);
  resultsTimers = [];
  document.querySelectorAll('#results-list .net[data-target]').forEach((el) => {
    el.textContent = formatNet(Number(el.dataset.target));
  });
  document.querySelectorAll('#results-body .reveal-row').forEach((el) => {
    el.classList.remove('reveal-row');
  });
}

// Ported from caption-this's short, eased score count.
function countUp(el, target, ms, activeRun) {
  if (reducedMotion.matches || ms === 0) {
    el.textContent = formatNet(target);
    return;
  }
  const started = performance.now();
  let frame = null;
  let fallback = null;
  const finish = (showTarget = true) => {
    if (frame) cancelAnimationFrame(frame);
    if (fallback) clearTimeout(fallback);
    frame = null;
    fallback = null;
    if (showTarget && activeRun === resultsRunId) el.textContent = formatNet(target);
  };
  el.textContent = '0';
  const tick = (now) => {
    if (activeRun !== resultsRunId) return finish(false);
    const progress = Math.min((now - started) / ms, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatNet(Math.round(target * eased));
    if (progress < 1) frame = requestAnimationFrame(tick);
    else finish();
  };
  frame = requestAnimationFrame(tick);
  fallback = setTimeout(finish, ms + 400);
}

function shouldRevealResults(cardId) {
  const key = `m2m-results-revealed:${cardId}`;
  if (revealedResults.has(key)) return false;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch { /* the in-memory guard still prevents a replay */ }
  revealedResults.add(key);
  return true;
}

async function loadResults() {
  cancelResultsEffects();
  const activeRun = resultsRunId;
  let data;
  try {
    data = await rpc('m2m_get_results');
  } catch (e) {
    if (activeRun !== resultsRunId) return;
    toast('Could not load results', 'error');
    console.error(e);
    return;
  }
  if (activeRun !== resultsRunId) return;
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
  const rows = data.top || [];
  const reveal = shouldRevealResults(data.card.id) && !reducedMotion.matches;
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'result-row' + (i === 0 ? ' winner' : '');
    const net = document.createElement('div');
    net.className = 'net' + (row.net < 0 ? ' neg' : '');
    net.dataset.target = String(row.net);
    net.textContent = reveal ? '0' : formatNet(row.net);
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
    if (reveal) {
      const delay = (rows.length - 1 - i) * 60;
      li.classList.add('reveal-row');
      li.style.animationDelay = `${delay}ms`;
      const timer = setTimeout(() => {
        if (activeRun === resultsRunId) countUp(net, row.net, 520, activeRun);
      }, delay);
      resultsTimers.push(timer);
    }
    list.appendChild(li);
  });

  // past weeks
  const archive = data.archive || [];
  show($('archive-section'), archive.length > 0);
  const arc = $('archive-list');
  arc.textContent = '';
  archive.forEach((w, i) => {
    const li = document.createElement('li');
    li.className = 'archive-row';
    if (reveal) {
      const delay = Math.min(rows.length, 5) * 60 + Math.min(i, 6) * 55;
      li.classList.add('reveal-row');
      li.style.animationDelay = `${delay}ms`;
    }
    const medal = document.createElement('div');
    medal.className = 'archive-medal';
    medal.setAttribute('aria-hidden', 'true');
    medal.textContent = w.winner_text ? '🍁' : '—';
    const details = document.createElement('div');
    details.className = 'archive-details';
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
      ? `“${w.winner_text}” — ${w.winner_name}`
      : 'No answers made the deck that week.';
    if (!w.winner_text) medal.classList.add('empty');
    details.append(prompt, week, win);
    li.append(medal, details);
    arc.appendChild(li);
  });
}

// ---------------- go ----------------
loadRound();
