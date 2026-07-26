// Supabase backend for MAPLES TO MAPLES (shared Btown Games project).
// Schema lives in supabase/schema.sql; the anon key below can only call
// the m2m_* security-definer RPCs defined there. Same identity model as
// every Btown game: a random player id + secret token under shared
// btown-* localStorage keys, so answer authors' names match their
// arcade names.

const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';

function stored(key, make) {
  let v = localStorage.getItem(key);
  if (!v) { v = make(); localStorage.setItem(key, v); }
  return v;
}
// shared "btown-" keys so all Btown games on this domain share one identity
export function playerId() {
  return stored('btown-player-id', () => crypto.randomUUID());
}
export function playerToken() {
  return stored('btown-player-token', () =>
    [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
}
export function getName() { return localStorage.getItem('btown-player-name') || ''; }
export function setName(n) { localStorage.setItem('btown-player-name', n.trim().slice(0, 20)); }

function baseHeaders(extra = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, ...extra };
  // legacy JWT-style anon keys also go in the Authorization header;
  // new sb_publishable_ keys must not (they aren't bearer tokens)
  if (SUPABASE_ANON_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return headers;
}

export async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let msg = `${fn} failed: ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
