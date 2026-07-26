// Editor's Desk: approve/reject answers, write and queue green cards,
// steer the live round. The passphrase is verified server-side by every
// admin RPC; after the first successful unlock it's kept in localStorage.
import { rpc } from './api.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const PASS_KEY = 'm2m-admin-pass';
let pass = localStorage.getItem(PASS_KEY) || '';

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => show(t, false), ms);
}

async function unlock(candidate) {
  $('gate-status').textContent = 'Checking…';
  try {
    const ok = await rpc('m2m_admin_check_pass', { p_pass: candidate });
    if (!ok) {
      $('gate-status').textContent = 'Nope — that’s not it.';
      return;
    }
    pass = candidate;
    localStorage.setItem(PASS_KEY, pass);
    show($('gate'), false);
    show($('dash'));
    refresh();
  } catch (e) {
    $('gate-status').textContent = 'Could not reach the server.';
    console.error(e);
  }
}

$('pass-go').onclick = () => unlock($('pass-input').value);
$('pass-input').onkeydown = (e) => { if (e.key === 'Enter') unlock($('pass-input').value); };
$('lock-btn').onclick = () => {
  localStorage.removeItem(PASS_KEY);
  location.reload();
};

function actionButton(label, cls, fn) {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.onclick = async () => {
    b.disabled = true;
    try { await fn(); toast('Done ✓'); refresh(); }
    catch (e) { toast(e.message); b.disabled = false; }
  };
  return b;
}

async function refresh() {
  let data;
  try {
    data = await rpc('m2m_admin_list_cards', { p_pass: pass });
  } catch (e) {
    toast(e.message || 'Failed to load');
    if (/passphrase/i.test(e.message || '')) $('lock-btn').click();
    return;
  }

  // live round
  const live = $('live-card');
  live.textContent = '';
  if (data.live) {
    const card = document.createElement('div');
    card.className = 'admin-card';
    const prompt = document.createElement('div');
    prompt.className = 'green-card mini';
    prompt.textContent = data.live.prompt;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const ansUntil = new Date(data.live.answers_until).toLocaleString();
    const voteUntil = new Date(data.live.votes_until).toLocaleString();
    meta.textContent =
      `phase: ${data.live.phase} · ${data.live.pending_count} pending / ` +
      `${data.live.approved_count} approved · answers until ${ansUntil} · ` +
      `round ends ${voteUntil}`;
    card.append(prompt, meta);
    live.appendChild(card);
  } else {
    live.innerHTML = '<div class="hint">No live round.</div>';
  }
  show($('live-actions'), Boolean(data.live));

  // green card queue
  const q = $('queue-list');
  q.textContent = '';
  data.queue.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'admin-card';
    const prompt = document.createElement('div');
    prompt.className = 'green-card mini';
    prompt.textContent = c.prompt;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `#${i + 1} in line${i === 0 ? ' · goes live next Monday' : ''}`;
    const row = document.createElement('div');
    row.className = 'admin-actions';
    row.append(
      actionButton('✏️ Edit', 'ghost', () => {
        const next = prompt$(c.prompt);
        if (next === null) throw new Error('cancelled');
        return rpc('m2m_admin_update_card', { p_pass: pass, p_card: c.id, p_prompt: next });
      }),
      actionButton('🚀 Make live now', 'ghost', () => {
        if (!confirm('End the current round (if any) and put this green card live?')) throw new Error('cancelled');
        return rpc('m2m_admin_promote_card', { p_pass: pass, p_card: c.id });
      }),
      actionButton('🗑️ Remove', 'danger', () => {
        if (!confirm('Remove this green card from the queue?')) throw new Error('cancelled');
        return rpc('m2m_admin_remove_card', { p_pass: pass, p_card: c.id });
      }),
    );
    card.append(prompt, meta, row);
    q.appendChild(card);
  });
  show($('queue-empty'), data.queue.length === 0);

  // answers on the live card
  let answers = [];
  try { answers = await rpc('m2m_admin_list_answers', { p_pass: pass }); } catch { /* no live round */ }
  const pending = answers.filter((a) => a.status === 'pending');
  const approved = answers.filter((a) => a.status === 'approved');

  $('pending-badge').textContent = pending.length;
  show($('pending-badge'), pending.length > 0);
  show($('approve-all-wrap'), pending.length > 1);
  renderAnswers($('pending-list'), pending, (a) => [
    ['✅ Approve', 'good', () => rpc('m2m_admin_approve_answer', { p_pass: pass, p_answer: a.id })],
    ['🗑️ Reject', 'danger', () => rpc('m2m_admin_reject_answer', { p_pass: pass, p_answer: a.id })],
  ]);
  show($('pending-empty'), pending.length === 0);

  renderAnswers($('approved-list'), approved, (a) => [
    ['✕', 'danger', () => {
      if (!confirm(`Pull this answer by ${a.name} out of the deck?`)) throw new Error('cancelled');
      return rpc('m2m_admin_reject_answer', { p_pass: pass, p_answer: a.id });
    }],
  ]);
  show($('approved-empty'), approved.length === 0);
}

// prompt() shadowed by local names above, so keep a direct handle
function prompt$(current) {
  return window.prompt('Green card text:', current);
}

function renderAnswers(listEl, answers, actionsFor) {
  listEl.textContent = '';
  answers.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'admin-answer-row';
    const body = document.createElement('div');
    body.className = 'body';
    const text = document.createElement('div');
    text.textContent = `“${a.text}”`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `— ${a.name}` + (a.status === 'approved' ? ` · net ${a.net >= 0 ? '+' : ''}${a.net}` : '');
    body.append(text, who);
    row.appendChild(body);
    const btns = document.createElement('div');
    btns.className = 'admin-actions tight';
    actionsFor(a).forEach(([label, cls, fn]) => btns.appendChild(actionButton(label, cls, fn)));
    row.appendChild(btns);
    listEl.appendChild(row);
  });
}

// write a new green card
$('card-add').onclick = async () => {
  const text = $('card-text').value.trim();
  if (!text) return;
  $('card-add').disabled = true;
  try {
    await rpc('m2m_admin_add_card', { p_pass: pass, p_prompt: text });
    $('card-text').value = '';
    toast('Green card queued 🟩');
    refresh();
  } catch (e) { toast(e.message); }
  $('card-add').disabled = false;
};
$('card-text').addEventListener('input', () => {
  $('card-chars').textContent = String(120 - $('card-text').value.length);
});

$('btn-approve-all').onclick = async () => {
  if (!confirm('Approve every pending answer?')) return;
  try {
    const n = await rpc('m2m_admin_approve_all', { p_pass: pass });
    toast(`Approved ${n} ✓`);
    refresh();
  } catch (e) { toast(e.message); }
};

$('btn-open-voting').onclick = async () => {
  if (!confirm('Close answer submissions and start voting right now?')) return;
  try { await rpc('m2m_admin_open_voting', { p_pass: pass }); toast('Voting is open 🔥'); refresh(); }
  catch (e) { toast(e.message); }
};
$('btn-end-round').onclick = async () => {
  if (!confirm('End the round NOW? Results become final and the next green card goes live.')) return;
  try { await rpc('m2m_admin_end_round', { p_pass: pass }); toast('Round ended 🏁'); refresh(); }
  catch (e) { toast(e.message); }
};
$('refresh-btn').onclick = refresh;

// auto-unlock if a stored passphrase works
if (pass) unlock(pass);
