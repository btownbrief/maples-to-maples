// MAPLES TO MAPLES — Party Mode UI. One shared phone at a big table:
// pass-to-submit, judge crowns, maples counted. UI ONLY — every rule lives
// in the pure engine (js/party-engine.js); this file just wires screens to
// it and keeps the current party in localStorage so a pocketed phone or an
// accidental refresh never kills game night. No network, no Supabase —
// party answers stay on the device and vanish with the party, so the weekly
// game's moderation queue is never involved.
import {
  createParty, judgeIndex, currentSubmitter, submitAnswer, skipSubmitter,
  answersForJudge, crownWinner, nextRound, extendRounds, standings, isValidParty,
  MIN_PLAYERS, MAX_PLAYERS, MAX_ANSWER_LEN,
} from './party-engine.js';
import { PARTY_CARDS } from './party-cards.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const SAVE_KEY = 'm2m-party-state';

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

/* ---------------- party state + persistence ---------------- */

let party = null;      // the engine state (the only game truth)
let revealed = false;  // pass-screen privacy latch: has the right person tapped in?
let pick = -1;         // judge's currently selected answer
let composeFor = null; // which player the open compose screen belongs to
let passFor = null;    // which player the pass screen is waiting on
let draft = '';        // their typed-so-far answer (survives the privacy latch)

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(party)); } catch { /* storage full/off */ }
}
function clearSave() {
  localStorage.removeItem(SAVE_KEY);
}
function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (isValidParty(s)) return s;
  } catch { /* corrupt JSON */ }
  // A truncated or mangled save must never crash game night — drop it.
  clearSave();
  return null;
}

/* Every engine transition funnels through here: update, persist, redraw. */
function apply(next) {
  party = next;
  revealed = false;
  pick = -1;
  composeFor = null;
  passFor = null;
  draft = '';
  save();
  render();
}

// Someone pockets or locks the phone mid-screen: drop back behind the pass
// screen so whoever picks it up next can't read a private answer — but keep
// the typer's draft so an accidental screen-lock doesn't eat their card.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && revealed) {
    if (party?.phase === 'submit') draft = $('compose-text').value;
    revealed = false;
    render();
  }
});

/* ---------------- screens ---------------- */

const SCREENS = ['party-setup', 'party-pass', 'party-compose', 'party-judge-pass', 'party-judge', 'party-reveal', 'party-over'];
function screen(id) {
  for (const s of SCREENS) show($(s), s === id);
}

function nameOf(i) { return party.players[i].name; }

function render() {
  if (!party) return renderSetup();
  if (party.phase === 'submit') return revealed ? renderCompose() : renderPass();
  if (party.phase === 'judge') return revealed ? renderJudge() : renderJudgePass();
  if (party.phase === 'reveal') return renderReveal();
  return renderOver();
}

/* ---------------- setup ---------------- */

const lobby = []; // names being gathered before the party starts

function renderSetup() {
  screen('party-setup');
  const saved = loadSave();
  show($('resume-box'), !!saved);
  show($('setup-form'), !saved);
  if (saved) {
    const n = saved.players.length;
    const line = saved.phase === 'over'
      ? `You left a finished ${n}-player party on the scoreboard.`
      : `There's a ${n}-player party mid-game — round ${Math.min(saved.round + 1, saved.totalRounds)} of ${saved.totalRounds}.`;
    $('resume-line').textContent = line;
    return;
  }
  const list = $('player-list');
  list.innerHTML = '';
  lobby.forEach((name, i) => {
    const li = document.createElement('li');
    li.className = 'player-chip';
    const label = document.createElement('span');
    label.textContent = name;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.setAttribute('aria-label', `Remove ${name}`);
    x.textContent = '✕';
    x.onclick = () => { lobby.splice(i, 1); renderSetup(); };
    li.append(label, x);
    list.appendChild(li);
  });
  const n = lobby.length;
  $('player-count-line').textContent =
    n < MIN_PLAYERS ? `Add at least ${MIN_PLAYERS} players to start (${n} so far). 6–12 is the sweet spot.`
      : n <= 12 ? `${n} players — looking good. Add more or deal the card!`
        : `${n} players — a big table! ${MAX_PLAYERS} is the max.`;
  $('btn-start').disabled = n < MIN_PLAYERS;
}

$('add-player-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('player-name');
  const name = input.value.trim();
  if (!name) return;
  if (lobby.some((p) => p.toLowerCase() === name.toLowerCase())) {
    return toast('Someone already grabbed that name!', 'error');
  }
  if (lobby.length >= MAX_PLAYERS) {
    return toast(`${MAX_PLAYERS} players is the max — that's already a party.`, 'error');
  }
  lobby.push(name);
  input.value = '';
  input.focus();
  renderSetup();
};

$('btn-start').onclick = () => {
  try {
    apply(createParty({ playerNames: lobby, cards: PARTY_CARDS, seed: Date.now() | 0 }));
  } catch (err) {
    toast(err.message || 'Could not start the party', 'error');
  }
};

$('btn-resume').onclick = () => {
  const saved = loadSave();
  if (!saved) return renderSetup();
  party = saved;
  revealed = false;
  pick = -1;
  render();
};

$('btn-discard').onclick = () => {
  clearSave();
  party = null;
  renderSetup();
};

/* ---------------- submit: pass screen + compose ---------------- */

function renderPass() {
  screen('party-pass');
  const who = currentSubmitter(party);
  passFor = who;
  const total = party.players.length - 1; // everyone but the judge
  const inCount = total - party.queue.length;
  $('pass-progress').textContent =
    `round ${party.round + 1} of ${party.totalRounds} · ${inCount} of ${total} answers in · ${nameOf(judgeIndex(party))} judges`;
  $('pass-name').textContent = nameOf(who);
  $('btn-im-here').textContent = `I'm ${nameOf(who)} — show me the card`;
  $('btn-skip').textContent = `${nameOf(who)} isn't around? Skip them`;
}

$('btn-im-here').onclick = () => {
  revealed = true;
  render();
};

$('btn-skip').onclick = () => {
  // A double-fired tap must never skip the NEXT player too.
  if (currentSubmitter(party) !== passFor || passFor === null) return;
  const who = nameOf(passFor);
  apply(skipSubmitter(party));
  toast(`Skipped ${who} this round`, 'info');
};

function renderCompose() {
  screen('party-compose');
  const who = currentSubmitter(party);
  composeFor = who;
  $('compose-banner').textContent = `🍁 ${nameOf(who)}, play your card — nobody peek!`;
  $('compose-prompt').textContent = party.prompt;
  $('compose-text').value = draft;
  $('compose-chars').textContent = MAX_ANSWER_LEN - draft.length;
  $('compose-text').focus();
}

$('compose-text').oninput = () => {
  $('compose-chars').textContent = MAX_ANSWER_LEN - $('compose-text').value.length;
};

$('compose-form').onsubmit = (e) => {
  e.preventDefault();
  // A double-fired submit must never hand this answer to the NEXT player in
  // the queue: only accept it for the player the screen was opened for.
  if (currentSubmitter(party) !== composeFor) return;
  try {
    apply(submitAnswer(party, $('compose-text').value));
  } catch {
    toast('Write a little something first!', 'error');
  }
};

/* ---------------- judging ---------------- */

function renderJudgePass() {
  screen('party-judge-pass');
  const judge = nameOf(judgeIndex(party));
  $('judge-pass-name').textContent = judge;
  $('btn-im-judge').textContent = `I'm ${judge} — show me the answers`;
}

$('btn-im-judge').onclick = () => {
  revealed = true;
  render();
};

function renderJudge() {
  screen('party-judge');
  $('judge-banner').textContent = `⚖️ ${nameOf(judgeIndex(party))} holds the gavel`;
  $('judge-prompt').textContent = party.prompt;
  const list = $('judge-answers');
  list.innerHTML = '';
  answersForJudge(party).forEach((text, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'answer-option' + (i === pick ? ' picked' : '');
    btn.textContent = text;
    btn.onclick = () => { pick = i; renderJudge(); };
    li.appendChild(btn);
    list.appendChild(li);
  });
  $('btn-crown').disabled = pick < 0;
}

$('btn-crown').onclick = () => {
  if (pick < 0) return;
  try {
    apply(crownWinner(party, pick));
  } catch (err) {
    toast(err.message || 'Could not crown that one', 'error');
  }
};

/* ---------------- reveal + scoreboard ---------------- */

function scoreList(el, s) {
  el.innerHTML = '';
  const { rows, leaders } = standings(s);
  const leadSet = new Set(leaders.map((l) => l.player));
  rows.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'score-row' + (r.score > 0 && leadSet.has(r.player) ? ' leading' : '');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'score-name';
    name.textContent = r.name;
    const maples = document.createElement('span');
    maples.className = 'score-maples';
    maples.textContent = r.score > 0 ? '🍁'.repeat(Math.min(r.score, 8)) + (r.score > 8 ? ` ×${r.score}` : '') : '—';
    li.append(rank, name, maples);
    el.appendChild(li);
  });
}

function renderReveal() {
  screen('party-reveal');
  show($('reveal-winner'), !party.scrapped);
  show($('reveal-scrapped'), party.scrapped);
  if (!party.scrapped) {
    $('reveal-prompt').textContent = party.prompt;
    $('reveal-text').textContent = party.winner.text;
    $('reveal-author').textContent = `That was ${nameOf(party.winner.player)}! +1 🍁`;
  }
  scoreList($('reveal-scores'), party);
  const lastRound = party.round + 1 >= party.totalRounds;
  $('btn-next-round').textContent = lastRound ? 'See the final standings 🏆' : 'Deal the next card 🍁';
}

$('btn-next-round').onclick = () => {
  if (party.phase !== 'reveal') return; // double-fire: already advanced
  apply(nextRound(party));
};

/* ---------------- game over ---------------- */

function renderOver() {
  screen('party-over');
  const { leaders } = standings(party);
  const names = leaders.map((l) => l.name);
  const crowned = leaders[0].score > 0;
  $('over-champion').textContent = !crowned
    ? 'No maples were handed out — Burlington remains undefeated.'
    : names.length === 1
      ? `${names[0]} is the Top Maple of the table! 🍁`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} share the crown! 🍁`;
  $('over-line').textContent =
    `${party.totalRounds} rounds played · ${party.players.length} players`;
  scoreList($('over-scores'), party);
}

$('btn-another-trip').onclick = () => {
  try {
    apply(extendRounds(party));
  } catch (err) {
    toast(err.message || 'Could not deal another lap', 'error');
  }
};

$('btn-new-party').onclick = () => {
  clearSave();
  party = null;
  lobby.length = 0;
  renderSetup();
};

/* ---------------- boot ---------------- */
render();
