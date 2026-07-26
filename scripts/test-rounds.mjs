// Tests for js/rounds.js — plain Node, no framework: `node scripts/test-rounds.mjs`
// Every case pins an exact UTC instant and asserts what the Vermont
// wall-clock math must say about it.
import {
  nyParts, nyDateKey, addDaysKey, weekMondayKey,
  nextRoundMondayKey, isNyBefore, classifyPhase, msUntil,
} from '../js/rounds.js';

let failures = 0;
function is(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
const at = (iso) => new Date(iso);

// ---- week keys: UTC date vs Vermont date -------------------------------
// 02:00 UTC Tuesday is still 22:00 Monday in Vermont (EDT, UTC-4).
is(nyDateKey(at('2026-07-21T02:00:00Z')), '2026-07-20', 'late Monday evening VT is not yet Tuesday');
is(weekMondayKey(at('2026-07-21T02:00:00Z')), '2026-07-20', 'week key uses the Vermont date, not UTC');
is(weekMondayKey(at('2026-07-23T12:00:00Z')), '2026-07-20', 'Thursday belongs to Monday the 20th');
is(weekMondayKey(at('2026-07-20T12:00:00Z')), '2026-07-20', 'Monday belongs to itself');
is(weekMondayKey(at('2026-07-26T23:00:00Z')), '2026-07-20', 'Sunday is still the old week');

// ---- year boundary -----------------------------------------------------
// Jan 1 2026 is a Thursday; its week began Monday Dec 29 2025.
is(weekMondayKey(at('2026-01-01T12:00:00Z')), '2025-12-29', 'New Year week reaches back into December');
is(addDaysKey('2025-12-29', 7), '2026-01-05', 'adding a week crosses the year boundary');
is(nextRoundMondayKey(at('2026-01-01T12:00:00Z')), '2026-01-05', 'next round from New Year week is Jan 5');
is(addDaysKey('2026-02-28', 1), '2026-03-01', 'Feb 28 + 1 = Mar 1 (2026 is not a leap year)');

// ---- Monday-rollover instant (EST in January, UTC-5) -------------------
// Round of Dec 29 ends Monday Jan 5 at 00:00 Vermont = 05:00 UTC.
is(classifyPhase('2025-12-29', at('2026-01-05T04:59:00Z')), 'vote', 'still voting at 23:59 Sunday VT');
is(classifyPhase('2025-12-29', at('2026-01-05T05:00:00Z')), 'none', 'round over at exactly Monday 00:00 VT');
is(weekMondayKey(at('2026-01-05T05:00:00Z')), '2026-01-05', 'at that same instant the new week has begun');

// ---- answer→vote boundary, Wednesday noon (EDT in July, UTC-4) ---------
// Week of Jul 20: answers close Wed Jul 22 12:00 VT = 16:00 UTC.
is(classifyPhase('2026-07-20', at('2026-07-20T04:00:00Z')), 'answer', 'answers open at Monday 00:00 VT');
is(classifyPhase('2026-07-20', at('2026-07-22T15:59:59Z')), 'answer', 'answers still open at 11:59 Wednesday VT');
is(classifyPhase('2026-07-20', at('2026-07-22T16:00:00Z')), 'vote', 'voting starts at exactly Wednesday noon VT');
is(classifyPhase('2026-07-20', at('2026-07-27T03:59:00Z')), 'vote', 'voting runs through Sunday night VT');
is(classifyPhase('2026-07-20', at('2026-07-27T04:00:00Z')), 'none', 'round over at Monday 00:00 VT (EDT = 04:00 UTC)');

// ---- upcoming: card promoted late for a week that hasn't started -------
is(classifyPhase('2026-07-27', at('2026-07-26T12:00:00Z')), 'upcoming', 'next week\'s card reads as upcoming on Sunday');
is(classifyPhase(null, at('2026-07-26T12:00:00Z')), 'none', 'no week key means no round');

// ---- DST transition week (clocks spring forward Sun Mar 8 2026) --------
is(weekMondayKey(at('2026-03-09T04:30:00Z')), '2026-03-09', 'week after spring-forward starts cleanly (EDT)');
is(classifyPhase('2026-03-02', at('2026-03-04T16:59:00Z')), 'answer', 'pre-DST week: Wed 11:59 VT is 16:59 UTC (EST)');
is(classifyPhase('2026-03-02', at('2026-03-04T17:00:00Z')), 'vote', 'pre-DST week: voting starts at 17:00 UTC (EST noon)');

// ---- isNyBefore edges --------------------------------------------------
is(isNyBefore(at('2026-07-22T15:59:00Z'), '2026-07-22', 12), true, '11:59 VT is before noon');
is(isNyBefore(at('2026-07-22T16:00:00Z'), '2026-07-22', 12), false, 'exactly noon VT is not before noon');
is(isNyBefore(at('2026-07-21T12:00:00Z'), '2026-07-22', 12), true, 'the day before is before');
is(isNyBefore(at('2026-07-23T12:00:00Z'), '2026-07-22', 12), false, 'the day after is not before');

// ---- misc helpers ------------------------------------------------------
is(nyParts(at('2026-07-21T02:00:00Z')).isoDow, 1, 'isoDow says Monday for late Monday evening VT');
is(msUntil('2026-07-22T16:00:00Z', at('2026-07-22T15:59:00Z')), 60000, 'msUntil counts down to the deadline');
is(msUntil('2026-07-22T16:00:00Z', at('2026-07-22T17:00:00Z')), 0, 'msUntil clamps at zero after the deadline');
is(msUntil(null, at('2026-07-22T17:00:00Z')), 0, 'msUntil handles a missing deadline');

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll rounds tests passed.');
