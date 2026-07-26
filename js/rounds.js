// Pure round-phase and week-key math for MAPLES TO MAPLES. No DOM, no
// network, no hidden clock — every function takes the Date it should
// reason about, so scripts/test-rounds.mjs can pin exact instants.
//
// The Supabase schema (m2m_phase / m2m_advance_rounds) is the source of
// truth at runtime; this module mirrors its math in Vermont wall-clock
// time (America/New_York) so the page can label weeks and notice, without
// a reload, that a phase boundary just slid past.
//
// The weekly shape, all times Vermont:
//   Monday 00:00 → Wednesday noon   'answer'  (red cards come in)
//   Wednesday noon → Monday 00:00   'vote'    (swipe judging)
//   otherwise                       'none'    (round over / nothing live)

const NY = 'America/New_York';
const ISO_DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

// What the clock on a Burlington wall says at this instant.
export function nyParts(date = new Date()) {
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, isoDow: ISO_DOW[p.weekday],
  };
}

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' of this instant, Vermont time.
export function nyDateKey(date = new Date()) {
  const p = nyParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Calendar arithmetic on a 'YYYY-MM-DD' key (year/month rollovers included).
export function addDaysKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// The Monday that starts this instant's week, Vermont time — the round's
// week key. Matches the schema's m2m_week_monday().
export function weekMondayKey(date = new Date()) {
  const p = nyParts(date);
  return addDaysKey(nyDateKey(date), -(p.isoDow - 1));
}

// The Monday a brand-new round would start on after this instant.
export function nextRoundMondayKey(date = new Date()) {
  return addDaysKey(weekMondayKey(date), 7);
}

// Is this instant strictly before <hour>:00 Vermont time on the given day?
// (Exactly on the hour counts as NOT before — same as the schema's
// strict `now() < answers_until` comparisons.)
export function isNyBefore(date, dateKey, hour) {
  const key = nyDateKey(date);
  if (key !== dateKey) return key < dateKey;
  return nyParts(date).hour < hour;
}

// Which phase a round with this week_of is in at this instant. Mirrors the
// schema's m2m_phase() for a live card.
export function classifyPhase(weekOfKey, date = new Date()) {
  if (!weekOfKey) return 'none';
  if (nyDateKey(date) < weekOfKey) return 'upcoming';
  if (isNyBefore(date, addDaysKey(weekOfKey, 2), 12)) return 'answer';
  if (isNyBefore(date, addDaysKey(weekOfKey, 7), 0)) return 'vote';
  return 'none';
}

// Milliseconds until a server-reported phase deadline (0 if passed/absent).
export function msUntil(iso, date = new Date()) {
  if (!iso) return 0;
  return Math.max(0, new Date(iso).getTime() - date.getTime());
}
