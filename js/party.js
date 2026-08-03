// MAPLES TO MAPLES — Party Mode UI. UI ONLY — every rule lives in the pure
// engine (js/party-engine.js); this file just wires screens to it. Two ways
// to play:
//  - pass-the-phone: one shared phone at a big table (3-16). Fully
//    on-device — no network, answers stay on the phone, and the party lives
//    in localStorage so a pocketed phone never kills game night.
//  - online: 3-4 players, each on their own phone, synced through the
//    fleet's shared rooms backend (js/rooms.js). The whole engine state —
//    answers included — reaches every phone; the honest UI keeps answers
//    anonymous until the reveal (a devtools snoop could peek — the accepted
//    fleet tradeoff for friendly games). Neither mode touches the weekly
//    game's Supabase moderation queue.
import {
  createParty, judgeIndex, currentSubmitter, submitAnswer, submitAnswerFor,
  skipSubmitter, skipPlayer,
  answersForJudge, crownWinner, addPlayer, nextRound, extendRounds, standings, isValidParty,
  MIN_PLAYERS, MAX_PLAYERS, MAX_ANSWER_LEN,
} from './party-engine.js';
import { PARTY_CARDS } from './party-cards.js';
import { OnlineMatch, clearSession, getName, savedSession } from './rooms.js';

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

const GAME = 'maples-to-maples';
let online = null;     // { match } — this phone is engine player match.seat
let draftRound = -1;   // which round the draft belongs to (online repaints mid-typing)
let pushing = false;   // one online push in flight at a time
let leaveArmed = false;

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(party)); } catch { /* storage full/off */ }
}
function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (e) { /* storage denied — nothing to clear */ }
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

/* Every PASS-MODE engine transition funnels through here: update, persist,
 * redraw. Online transitions go through pushOnline instead — the room, not
 * localStorage, is the truth there. */
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
  if (!online && document.hidden && revealed) {
    if (party?.phase === 'submit') draft = $('compose-text').value;
    revealed = false;
    render();
  }
  // Wake locks auto-release when the page hides — take it back on return.
  if (!document.hidden && party && party.phase !== 'over') requestWakeLock();
});

/* A phone on the table dims and locks mid-party; hold the screen awake
 * while a game is live. Progressive enhancement — quietly does nothing
 * where the Wake Lock API is missing or the battery saver refuses. */
let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* refused — fine */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

/* ---------------- screens ---------------- */

const SCREENS = ['party-setup', 'party-pass', 'party-compose', 'party-judge-pass', 'party-judge', 'party-reveal', 'party-over', 'onlinePanel', 'lobby', 'party-wait'];
function screen(id) {
  for (const s of SCREENS) show($(s), s === id);
}

/* Online, the engine state carries placeholder names ("Maple 1") because the
 * host deals before anyone joins — real names live on the room's seats. */
function nameOf(i) {
  if (online) {
    if (i === online.match.seat) return 'You';
    return online.match.seats.find((s) => s.seat === i)?.name || `Maple ${i + 1}`;
  }
  return party.players[i].name;
}

function render() {
  if (online) return renderOnline();
  if (!party) return renderSetup();
  if (party.phase === 'submit') return revealed ? renderCompose() : renderPass();
  if (party.phase === 'judge') return revealed ? renderJudge() : renderJudgePass();
  if (party.phase === 'reveal') return renderReveal();
  return renderOver();
}

/* Online, this phone IS one seat: no pass screens, no privacy latches —
 * render my perspective of the shared state (fleet rule 2). */
function renderOnline() {
  if (!party) return renderSetup();
  if (online.match.status === 'over' && party.phase !== 'over') return renderTableGone();
  const me = online.match.seat;
  if (party.phase === 'submit') {
    return me !== party.judge && party.queue.includes(me) ? renderCompose() : renderWait();
  }
  if (party.phase === 'judge') return me === party.judge ? renderJudge() : renderWait();
  if (party.phase === 'reveal') return renderReveal();
  return renderOver();
}

/* ---------------- setup ---------------- */

const lobby = []; // names being gathered before the party starts

function renderSetup() {
  screen('party-setup');
  refreshRejoin();
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
    requestWakeLock();
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
  requestWakeLock();
};

$('btn-discard').onclick = () => {
  clearSave();
  party = null;
  renderSetup();
};

/* ---------------- submit: pass screen + compose ---------------- */

function renderPass() {
  screen('party-pass');
  // The prompt is table-public (the judge reads it aloud), so show it here:
  // everyone waiting on the phone can start cooking up their answer.
  $('pass-prompt').textContent = party.prompt;
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
  const who = online ? online.match.seat : currentSubmitter(party);
  composeFor = who;
  $('compose-banner').textContent = online
    ? '🍁 Play your card — the table is waiting!'
    : `🍁 ${nameOf(who)}, play your card — nobody peek!`;
  $('compose-hint').textContent = online
    ? 'The judge reads it unsigned — nobody learns it was yours until the reveal.'
    : "Keep it secret — hand the phone back face-down when you're done.";
  $('compose-prompt').textContent = party.prompt;
  // Online, other players' answers landing repaint this screen mid-typing —
  // restore the draft (dropping one left over from an earlier round).
  const text = online && draftRound !== party.round ? '' : draft;
  if ($('compose-text').value !== text) $('compose-text').value = text;
  $('compose-chars').textContent = MAX_ANSWER_LEN - text.length;
  if (document.activeElement !== $('compose-text')) $('compose-text').focus();
}

$('compose-text').oninput = () => {
  draft = $('compose-text').value;
  draftRound = party ? party.round : -1;
  $('compose-chars').textContent = MAX_ANSWER_LEN - draft.length;
};

$('compose-form').onsubmit = (e) => {
  e.preventDefault();
  if (online) {
    const text = $('compose-text').value;
    if (!text.trim()) return toast('Write a little something first!', 'error');
    draft = '';
    pushOnline((s) => submitAnswerFor(s, online.match.seat, text));
    return;
  }
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
  $('judge-banner').textContent = online
    ? '⚖️ You hold the gavel'
    : `⚖️ ${nameOf(judgeIndex(party))} holds the gavel`;
  $('judge-hint').textContent = online
    ? 'The whole table is reading these too — take your time, then crown one.'
    : 'Read every answer out loud — with feeling — then crown one.';
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
  if (online) {
    const chosen = pick;
    pick = -1;
    return pushOnline((s) => crownWinner(s, chosen));
  }
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
    name.textContent = online ? nameOf(r.player) : r.name;
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
  const others = party.scrapped ? [] : party.order
    .map((i) => party.submissions[i])
    .filter((s) => s.player !== party.winner.player);
  show($('reveal-others-wrap'), others.length > 0);
  if (!party.scrapped) {
    $('reveal-prompt').textContent = party.prompt;
    $('reveal-text').textContent = party.winner.text;
    $('reveal-author').textContent = `That was ${nameOf(party.winner.player)}! +1 🍁`;
    // the "wait, who wrote THAT?" moment — unmask everyone else too
    const list = $('reveal-others');
    list.innerHTML = '';
    for (const s of others) {
      const li = document.createElement('li');
      li.className = 'other-row';
      const text = document.createElement('div');
      text.textContent = s.text;
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = `— ${nameOf(s.player)}`;
      li.append(text, who);
      list.appendChild(li);
    }
  }
  scoreList($('reveal-scores'), party);
  show($('deal-in-row'), !online && party.players.length < MAX_PLAYERS);
  show($('deal-in-form'), false);
  const lastRound = party.round + 1 >= party.totalRounds;
  $('btn-next-round').textContent = lastRound ? 'See the final standings 🏆' : 'Deal the next card 🍁';
}

$('btn-deal-in').onclick = () => {
  show($('deal-in-form'));
  $('deal-in-name').focus();
};

$('deal-in-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('deal-in-name').value.trim();
  if (!name) return;
  try {
    apply(addPlayer(party, name));
    $('deal-in-name').value = '';
    toast(`${name} is in — they're dealt in next round! 🍁`, 'success');
  } catch (err) {
    toast(err.message || 'Could not add them', 'error');
  }
};

$('btn-next-round').onclick = () => {
  if (party.phase !== 'reveal') return; // double-fire: already advanced
  if (online) return pushOnline((s) => nextRound(s));
  apply(nextRound(party));
};

/* ---------------- game over ---------------- */

/* A brief rain of maple leaves over the final standings. Pure decoration:
 * skipped under reduced motion, removes itself when done. */
function mapleShower() {
  if (reducedMotion.matches || $('maple-shower')) return;
  const host = document.createElement('div');
  host.id = 'maple-shower';
  for (let i = 0; i < 16; i++) {
    const leaf = document.createElement('span');
    leaf.textContent = '🍁';
    leaf.style.left = `${Math.random() * 100}vw`;
    leaf.style.animationDelay = `${(Math.random() * 1.2).toFixed(2)}s`;
    leaf.style.animationDuration = `${(2.2 + Math.random() * 1.8).toFixed(2)}s`;
    leaf.style.fontSize = `${Math.round(16 + Math.random() * 18)}px`;
    host.appendChild(leaf);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 4600);
}

function renderOver() {
  screen('party-over');
  mapleShower();
  const { leaders } = standings(party);
  const names = leaders.map((l) => (online ? nameOf(l.player) : l.name));
  const crowned = leaders[0].score > 0;
  $('over-champion').textContent = !crowned
    ? 'No maples were handed out — Burlington remains undefeated.'
    : names.length === 1
      ? (names[0] === 'You'
        ? "You're the Top Maple of the table! 🍁"
        : `${names[0]} is the Top Maple of the table! 🍁`)
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} share the crown! 🍁`;
  releaseWakeLock();
  $('over-line').textContent =
    `${party.totalRounds} rounds played · ${party.players.length} players`;
  scoreList($('over-scores'), party);
  $('btn-new-party').textContent = online ? 'Leave the table' : 'New party';
}

$('btn-another-trip').onclick = () => {
  if (online) return pushOnline((s) => extendRounds(s));
  try {
    apply(extendRounds(party));
    requestWakeLock();
  } catch (err) {
    toast(err.message || 'Could not deal another lap', 'error');
  }
};

$('btn-new-party').onclick = () => {
  if (online) return leaveTable(false);
  clearSave();
  releaseWakeLock();
  party = null;
  lobby.length = 0;
  renderSetup();
};

/* ---------------- online play (the rooms layer) ---------------- */

/* Apply an engine step to the FRESHEST room state and push it. During the
 * submit phase several phones push at once, so all but one hit
 * version_conflict — rooms.js refetches the server truth on conflict, and
 * because the engine's seat-aware mutators are idempotent we can safely
 * re-apply this phone's action to the fresh state and try again. */
async function pushOnline(applyFn) {
  if (!online || pushing) return;
  pushing = true;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let next;
      try {
        next = applyFn(online.match.state);
      } catch {
        break; // the table already moved past this action — adopt the truth
      }
      if (next === online.match.state) break; // no-op: it already landed
      try {
        await online.match.push(next, { over: next.phase === 'over' });
        break;
      } catch (err) {
        if (err?.code !== 'version_conflict') {
          toast(friendly(err), 'error');
          break;
        }
        if (attempt === 4) toast('The table is busy — try again!', 'error');
      }
    }
  } finally {
    pushing = false;
    if (online) {
      party = online.match.state;
      render();
    }
  }
}

const FRIENDLY_ERRORS = {
  not_found: 'No table has that code — check the four characters.',
  room_full: 'That table is already full.',
  room_started: 'That party has already dealt its first card.',
  not_ready: "Online play isn't switched on yet — check back soon!",
  offline: "Can't reach the sugarhouse — are you online?",
  opponent_left: 'Someone left the table.',
};
function friendly(err) {
  if (err?.code === 'wrong_game') return `That code belongs to ${String(err.detail || 'another game').replace(/-/g, ' ')}.`;
  return FRIENDLY_ERRORS[err?.code] || 'The signal drifted through the sugarbush. Try again.';
}

function renderWait() {
  screen('party-wait');
  const s = party;
  const me = online.match.seat;
  $('wait-prompt').textContent = s.prompt;
  const total = s.players.length - 1;
  $('wait-progress').textContent =
    `round ${s.round + 1} of ${s.totalRounds} · ${me === s.judge ? 'you hold the gavel' : `${nameOf(s.judge)} judges`}`;
  const list = $('wait-list');
  list.innerHTML = '';
  show($('wait-answers'), false);
  $('btn-leave-table').textContent = 'Leave the table';
  leaveArmed = false;
  if (s.phase === 'submit') {
    const inCount = total - s.queue.length;
    $('wait-emoji').textContent = me === s.judge ? '⚖️' : '🍁';
    $('wait-line').textContent = me === s.judge
      ? `The table is writing — ${inCount} of ${total} answers in.`
      : `Your card is in! ${inCount} of ${total} answers on the table.`;
    const dark = new Set(online.match.opponents().filter((o) => o.away || o.left).map((o) => o.seat));
    for (const p of s.queue) {
      const li = document.createElement('li');
      li.className = 'wait-row';
      const label = document.createElement('span');
      label.textContent = `${nameOf(p)} is still writing…${dark.has(p) ? ' 🌙' : ''}`;
      li.appendChild(label);
      if (me === s.judge) {
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'linkish';
        skip.textContent = 'skip them';
        skip.onclick = () => pushOnline((cur) => skipPlayer(cur, p));
        li.appendChild(skip);
      }
      list.appendChild(li);
    }
  } else { // judge phase, and this phone is not the judge
    $('wait-emoji').textContent = '⚖️';
    $('wait-line').textContent = `${nameOf(s.judge)} is reading the answers…`;
    const ul = $('wait-answers');
    ul.innerHTML = '';
    for (const text of answersForJudge(s)) {
      const li = document.createElement('li');
      li.className = 'other-row';
      li.textContent = text;
      ul.appendChild(li);
    }
    show(ul);
  }
}

function renderTableGone() {
  screen('party-wait');
  $('wait-prompt').textContent = party.prompt || '—';
  $('wait-progress').textContent = 'the table broke up';
  $('wait-emoji').textContent = '🍂';
  $('wait-line').textContent = 'Someone left, so this party is over.';
  $('wait-list').innerHTML = '';
  show($('wait-answers'), false);
  $('btn-leave-table').textContent = 'Back to the porch';
}

function leaveTable(confirmNeeded) {
  if (!online) return;
  if (confirmNeeded && !leaveArmed && online.match.status === 'playing') {
    leaveArmed = true;
    $('btn-leave-table').textContent = 'Really leave? The party ends for everyone';
    setTimeout(() => {
      leaveArmed = false;
      if (online) render();
    }, 2600);
    return;
  }
  const match = online.match;
  online = null;
  leaveArmed = false;
  match.leave();
  releaseWakeLock();
  party = null;
  draft = '';
  renderSetup();
}

$('btn-leave-table').onclick = () => leaveTable(true);

/* ---- host / join panel ---- */

let panelIntent = 'host';
let selectedSeats = 3;
let lobbyMatch = null;

$('hostBtn').onclick = () => openPanel('host');
$('joinBtn').onclick = () => openPanel('join');
$('opCancel').onclick = () => renderSetup();
$('opGo').onclick = onlineGo;
$('lobbyCancel').onclick = cancelLobby;
$('rejoinBtn').onclick = rejoinTable;

document.querySelectorAll('.seat-btn').forEach((button) => {
  button.onclick = () => {
    selectedSeats = +button.dataset.seats;
    document.querySelectorAll('.seat-btn').forEach((choice) => {
      const chosen = choice === button;
      choice.classList.toggle('selected', chosen);
      choice.setAttribute('aria-pressed', String(chosen));
    });
  };
});

$('opCode').oninput = () => {
  $('opCode').value = $('opCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
};
[$('opName'), $('opCode')].forEach((input) => input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    onlineGo();
  }
}));

function openPanel(intent) {
  panelIntent = intent;
  $('opTitle').textContent = intent === 'host' ? 'Host a table' : 'Join a table';
  $('opGo').textContent = intent === 'host' ? 'Get a code' : 'Pull up a chair';
  show($('opSeatsWrap'), intent === 'host');
  show($('opCodeWrap'), intent !== 'host');
  show($('opError'), false);
  $('opName').value = $('opName').value || getName();
  screen('onlinePanel');
  (intent === 'join' && $('opName').value ? $('opCode') : $('opName')).focus();
}

function opFail(message) {
  $('opError').textContent = message;
  show($('opError'));
}

async function onlineGo() {
  if ($('opGo').disabled) return;
  const name = $('opName').value.trim();
  if (!name) {
    opFail('Every player needs a name.');
    $('opName').focus();
    return;
  }
  $('opGo').disabled = true;
  show($('opError'), false);
  try {
    let match;
    if (panelIntent === 'host') {
      match = await OnlineMatch.create({
        game: GAME,
        name,
        seats: selectedSeats,
        state: createParty({
          playerNames: Array.from({ length: selectedSeats }, (_, i) => `Maple ${i + 1}`),
          cards: PARTY_CARDS,
          seed: Date.now() | 0,
        }),
      });
    } else {
      const code = $('opCode').value.trim();
      if (code.length !== 4) {
        opFail('The table code is 4 characters.');
        $('opCode').focus();
        return;
      }
      match = await OnlineMatch.join({ game: GAME, code, name });
    }
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    opFail(friendly(err));
  } finally {
    $('opGo').disabled = false;
  }
}

/* ---- lobby ---- */

function renderLobby(match) {
  $('lobbyCode').textContent = match.code;
  const list = $('lobbyNames');
  list.innerHTML = '';
  const total = match.maxSeats || match.state.players.length;
  for (let seat = 0; seat < total; seat++) {
    const joined = match.seats.find((entry) => entry.seat === seat);
    const li = document.createElement('li');
    li.textContent = joined ? `🍁 ${joined.name}` : '☕ Waiting for a player…';
    list.appendChild(li);
  }
}

function openLobby(match) {
  if (lobbyMatch && lobbyMatch !== match) lobbyMatch.stop();
  lobbyMatch = match;
  $('lobbyHint').textContent = 'The rest of the table joins with this code or your invite link.';
  renderLobby(match);
  screen('lobby');
  match.start({
    onStatus: (status) => {
      if (status === 'playing') enterOnlineGame(match);
      else if (status === 'over') $('lobbyHint').textContent = 'Someone left before the first card. Host a fresh table.';
    },
    onPresence: () => renderLobby(match),
    onError: () => {},
  });
}

function cancelLobby() {
  lobbyMatch?.leave();
  lobbyMatch = null;
  renderSetup();
}

$('inviteBtn').onclick = async () => {
  if (!lobbyMatch) return;
  const url = `${location.origin}${location.pathname}?join=${lobbyMatch.code}`;
  const text = `Pull up a chair — Maples to Maples, live! 🍁 ${url}`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(url);
      $('inviteBtn').textContent = '✓ Link copied';
      setTimeout(() => { $('inviteBtn').textContent = '📲 Send an invite'; }, 1800);
    }
  } catch { /* closing a share sheet is harmless */ }
};

/* ---- rejoin + entering the game ---- */

async function rejoinTable() {
  $('rejoinBtn').disabled = true;
  try {
    const match = await OnlineMatch.resume({ game: GAME });
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    if (['not_found', 'not_seated', 'room_started'].includes(err?.code)) {
      clearSession(GAME);
      refreshRejoin();
    } else {
      toast(friendly(err), 'error');
    }
  } finally {
    $('rejoinBtn').disabled = false;
  }
}

function refreshRejoin() {
  const saved = savedSession(GAME);
  show($('rejoinBtn'), !!saved);
  if (saved) $('rejoinBtn').textContent = `↩ Rejoin your table (${saved.code})`;
}

function enterOnlineGame(match) {
  lobbyMatch = null;
  online = { match };
  party = match.state;
  revealed = false;
  pick = -1;
  draft = '';
  draftRound = -1;
  leaveArmed = false;
  requestWakeLock();
  render();
  match.start({
    onState: (remoteState) => {
      party = remoteState;
      pick = -1;
      render();
    },
    onStatus: () => render(),
    onPresence: () => render(),
    onError: () => {},
  });
}

/* ---------------- boot ---------------- */
render();

(() => {
  const code = new URLSearchParams(location.search).get('join');
  if (!code || !/^[A-Za-z0-9]{4}$/.test(code)) return;
  history.replaceState(null, '', location.pathname);
  openPanel('join');
  $('opCode').value = code.toUpperCase();
  if ($('opName').value) $('opCode').focus();
})();
