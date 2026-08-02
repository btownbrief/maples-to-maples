// Tests for js/party-engine.js — plain Node, no framework:
//   node scripts/test-party.mjs
// Drives whole parties through the pure engine: a full 3-player round, a
// 12-player trip around the table, determinism, serialization, skips,
// scrapped rounds, and the immutability rule.
import {
  createParty, judgeIndex, currentSubmitter, submitAnswer, skipSubmitter,
  answersForJudge, crownWinner, addPlayer, nextRound, extendRounds, standings, isValidParty,
  MIN_PLAYERS, MAX_PLAYERS, MAX_ANSWER_LEN,
} from '../js/party-engine.js';
import { PARTY_CARDS } from '../js/party-cards.js';

let failures = 0;
function is(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function throws(fn, label) {
  try {
    fn();
    failures += 1;
    console.error(`✗ ${label} — expected a throw, got none`);
  } catch {
    console.log(`✓ ${label}`);
  }
}

const CARDS = PARTY_CARDS;
const party = (names, seed = 42) => createParty({ playerNames: names, cards: CARDS, seed });

// ---- deck sanity -------------------------------------------------------
is(CARDS.length >= 40, true, 'party deck ships at least 40 green cards');
is(CARDS.every((c) => typeof c === 'string' && c.trim().length > 0), true, 'every card is a non-empty prompt');
is(new Set(CARDS).size, CARDS.length, 'no duplicate cards in the deck');

// ---- setup validation --------------------------------------------------
throws(() => party(['Al', 'Bea']), `fewer than ${MIN_PLAYERS} players is rejected`);
throws(() => party(Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => `P${i}`)), `more than ${MAX_PLAYERS} players is rejected`);
throws(() => party(['Al', 'Bea', '  ']), 'a blank name is rejected');
throws(() => party(['Al', 'Bea', 'al']), 'duplicate names are rejected (case-insensitive)');
throws(() => createParty({ playerNames: ['Al', 'Bea', 'Cy'], cards: [], seed: 1 }), 'an empty deck is rejected');

// ---- a full 3-player round, played move by move ------------------------
let s = party(['Al', 'Bea', 'Cy']);
is(s.phase, 'submit', '3p: party opens in the submit phase');
is(typeof s.prompt, 'string', '3p: a green card is on the table');
is(judgeIndex(s), 0, '3p: round 1 is judged by player 0');
is(currentSubmitter(s), 1, "3p: the phone starts at the judge's left");
is(s.totalRounds, 3, '3p: one trip = 3 rounds, everyone judges once');

s = submitAnswer(s, '  A creemee in a snowstorm  ');
is(currentSubmitter(s), 2, '3p: the phone passes to the next player');
s = submitAnswer(s, 'Champ on skis');
is(s.phase, 'judge', '3p: last answer in → judging begins');
is(currentSubmitter(s), null, '3p: nobody is submitting during judging');

const answers = answersForJudge(s);
is(answers.length, 2, '3p: the judge sees both answers');
is([...answers].sort(), ['A creemee in a snowstorm', 'Champ on skis'].sort(),
  '3p: answers are trimmed and all present');
is(s.submissions.map((x) => x.text).includes(answers[0]), true, '3p: judge sees real texts (anonymously)');

const pickIdx = answers.indexOf('Champ on skis');
s = crownWinner(s, pickIdx);
is(s.phase, 'reveal', '3p: crowning moves to the reveal');
is(s.winner, { player: 2, text: 'Champ on skis' }, '3p: the author is unmasked');
is(s.players[2].score, 1, '3p: the winner scores a maple');
is(s.players[1].score, 0, '3p: nobody else scores');

const prevPrompt = s.prompt;
s = nextRound(s);
is(s.phase, 'submit', '3p: next round reopens submissions');
is(s.round, 1, '3p: round counter advances');
is(judgeIndex(s), 1, '3p: the judge rotates');
is(currentSubmitter(s), 2, "3p: the new phone order starts at the new judge's left");
is(s.prompt === prevPrompt, false, '3p: a fresh green card is drawn');

// finish the trip: rounds 2 and 3
s = submitAnswer(s, 'Round two answer');
s = submitAnswer(s, 'Another round two answer');
s = crownWinner(s, 0);
s = nextRound(s);
is(judgeIndex(s), 2, '3p: round 3 is judged by player 2');
s = submitAnswer(s, 'Round three answer');
s = submitAnswer(s, 'Another round three answer');
s = crownWinner(s, 1);
s = nextRound(s);
is(s.phase, 'over', '3p: after everyone judges once, the party is over');
is(standings(s).rows.reduce((a, r) => a + r.score, 0), 3, '3p: three maples were handed out');

// ---- keep playing ------------------------------------------------------
throws(() => nextRound(s), 'over: nextRound refuses (use extendRounds)');
s = extendRounds(s);
is(s.phase, 'submit', 'extend: another lap reopens play');
is(s.totalRounds, 6, 'extend: default extension is one more full trip');
is(judgeIndex(s), 0, 'extend: the judge rotation continues where it left off');

// ---- skips and the scrapped round --------------------------------------
let sk = party(['Al', 'Bea', 'Cy', 'Di']);
sk = skipSubmitter(sk);
is(sk.submissions.length, 0, 'skip: a skipped player leaves no answer');
sk = submitAnswer(sk, 'only answer one');
sk = submitAnswer(sk, 'only answer two');
is(sk.phase, 'judge', 'skip: two real answers is still a judgeable round');

let scrap = party(['Al', 'Bea', 'Cy']);
scrap = skipSubmitter(scrap);
scrap = submitAnswer(scrap, 'lonely answer');
is(scrap.phase, 'reveal', 'scrap: one answer is not a contest — round goes to reveal');
is(scrap.scrapped, true, 'scrap: the round is marked scrapped');
is(scrap.winner, null, 'scrap: no winner on a scrapped round');
scrap = nextRound(scrap);
is(scrap.phase, 'submit', 'scrap: the party moves on to the next round');
is(scrap.players.map((p) => p.score), [0, 0, 0], 'scrap: no maples were handed out');

// ---- dealing in a latecomer --------------------------------------------
let late = party(['Al', 'Bea', 'Cy']);
throws(() => addPlayer(late, 'Di'), 'latecomer: rejected mid-submit');
late = submitAnswer(late, 'one');
late = submitAnswer(late, 'two');
throws(() => addPlayer(late, 'Di'), 'latecomer: rejected mid-judging');
late = crownWinner(late, 0);
late = addPlayer(late, '  Di  ');
is(late.players.map((p) => p.name), ['Al', 'Bea', 'Cy', 'Di'], 'latecomer: Di joins (trimmed) with the table intact');
is(late.players[3].score, 0, 'latecomer: Di starts with zero maples');
is(late.totalRounds, 4, 'latecomer: the party grows by one round');
is(isValidParty(late), true, 'latecomer: the grown party still validates');
throws(() => addPlayer(late, 'di'), 'latecomer: duplicate name still rejected');
late = nextRound(late);
is(late.queue.includes(3), true, 'latecomer: Di is in the next pass order');
is(late.queue.length, 3, 'latecomer: next round expects 3 answers');
{
  let full = party(Array.from({ length: MAX_PLAYERS }, (_, i) => `P${i}`));
  while (full.phase === 'submit') full = submitAnswer(full, 'x');
  full = crownWinner(full, 0);
  throws(() => addPlayer(full, 'One More'), `latecomer: a full table of ${MAX_PLAYERS} stays full`);
}

// ---- answer validation -------------------------------------------------
let v = party(['Al', 'Bea', 'Cy']);
throws(() => submitAnswer(v, '   '), 'a blank answer is rejected');
throws(() => submitAnswer(v, 'x'.repeat(MAX_ANSWER_LEN + 1)), 'an over-long answer is rejected');
is(submitAnswer(v, 'x'.repeat(MAX_ANSWER_LEN)).submissions.length, 1, 'an answer at exactly the cap is fine');
throws(() => answersForJudge(v), 'answersForJudge refuses outside the judge phase');
throws(() => crownWinner(v, 0), 'crownWinner refuses outside the judge phase');
throws(() => extendRounds(v), 'extendRounds refuses while the party is going');

// ---- a 12-player trip around the table ---------------------------------
const names12 = ['Al', 'Bea', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ida', 'Jo', 'Kip', 'Lou'];
let big = party(names12, 7);
is(big.totalRounds, 12, '12p: one trip = 12 rounds');
const judges = [];
const seenPrompts = new Set();
while (big.phase !== 'over') {
  judges.push(judgeIndex(big));
  seenPrompts.add(big.prompt);
  let turns = 0;
  while (big.phase === 'submit') {
    const who = currentSubmitter(big);
    big = submitAnswer(big, `${names12[who]} answers round ${big.round}`);
    turns += 1;
  }
  is(turns, 11, `12p: round ${big.round} collected 11 answers`);
  is(answersForJudge(big).length, 11, `12p: round ${big.round} judge sees all 11`);
  big = crownWinner(big, big.round % 11);
  big = nextRound(big);
}
is(judges, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '12p: every player judged exactly once, in order');
is(seenPrompts.size, 12, '12p: twelve distinct green cards were dealt');
is(standings(big).rows.reduce((a, r) => a + r.score, 0), 12, '12p: twelve maples handed out');
is(standings(big).rows[0].score >= standings(big).rows[11].score, true, '12p: standings sort highest first');

// ---- deck reshuffles when it runs dry ----------------------------------
let dry = createParty({ playerNames: ['Al', 'Bea', 'Cy'], cards: ['P1', 'P2'], seed: 3 });
for (let r = 0; r < 5; r++) {
  if (dry.phase === 'over') dry = extendRounds(dry);
  is(['P1', 'P2'].includes(dry.prompt), true, `dry deck: round ${dry.round} still deals a card`);
  dry = submitAnswer(dry, 'a');
  dry = submitAnswer(dry, 'b');
  dry = crownWinner(dry, 0);
  dry = nextRound(dry);
}

// ---- determinism + serialization ---------------------------------------
const a1 = party(['Al', 'Bea', 'Cy'], 99);
const a2 = party(['Al', 'Bea', 'Cy'], 99);
is(a1, a2, 'same seed, same names → identical party');
const b1 = party(['Al', 'Bea', 'Cy'], 100);
is(a1.prompt === b1.prompt && a1.deck.join() === b1.deck.join(), false, 'a different seed deals differently');

let frozen = party(['Al', 'Bea', 'Cy'], 5);
frozen = submitAnswer(frozen, 'saved mid-round');
const thawed = JSON.parse(JSON.stringify(frozen));
is(submitAnswer(thawed, 'resumed fine'), submitAnswer(frozen, 'resumed fine'),
  'a party survives stringify → parse → resume');

// ---- immutability: no mutator touches its input ------------------------
const before = party(['Al', 'Bea', 'Cy'], 8);
const snapshot = JSON.stringify(before);
submitAnswer(before, 'does not mutate');
skipSubmitter(before);
is(JSON.stringify(before), snapshot, 'submit/skip never mutate the input state');

let judgeState = submitAnswer(submitAnswer(party(['Al', 'Bea', 'Cy'], 8), 'one'), 'two');
const judgeSnap = JSON.stringify(judgeState);
crownWinner(judgeState, 0);
is(JSON.stringify(judgeState), judgeSnap, 'crownWinner never mutates the input state');
let revealState = crownWinner(judgeState, 0);
const revealSnap = JSON.stringify(revealState);
nextRound(revealState);
is(JSON.stringify(revealState), revealSnap, 'nextRound never mutates the input state');
is(JSON.parse(JSON.stringify(judgeState)), judgeState, 'a judge-phase state survives stringify → parse');

// ---- card normalization ------------------------------------------------
const norm = createParty({ playerNames: ['Al', 'Bea', 'Cy'], cards: ['  padded  ', 42], seed: 1 });
is(norm.cards, ['padded', '42'], 'cards are normalized to trimmed strings');
throws(() => createParty({ playerNames: ['Al', 'Bea', 'Cy'], cards: ['ok', '   '], seed: 1 }),
  'a blank card is rejected');

// ---- isValidParty: the resume gate -------------------------------------
is(isValidParty(party(['Al', 'Bea', 'Cy'], 9)), true, 'a fresh party validates');
is(isValidParty(judgeState), true, 'a judge-phase party validates');
is(isValidParty(revealState), true, 'a reveal-phase party validates');
{
  let done = party(['Al', 'Bea', 'Cy'], 9);
  while (done.phase !== 'over') {
    while (done.phase === 'submit') done = submitAnswer(done, 'x');
    if (done.phase === 'judge') done = crownWinner(done, 0);
    done = nextRound(done);
  }
  is(isValidParty(done), true, 'a finished party validates');
}
is(isValidParty(null), false, 'null is not a party');
is(isValidParty({}), false, 'an empty object is not a party');
is(isValidParty({ version: 1, players: [] }), false, 'a truncated save is rejected');
{
  const good = party(['Al', 'Bea', 'Cy'], 9);
  is(isValidParty({ ...good, phase: 'lunch' }), false, 'an unknown phase is rejected');
  is(isValidParty({ ...good, queue: [7] }), false, 'an out-of-range queue index is rejected');
  is(isValidParty({ ...good, queue: [] }), false, 'a submit phase with nobody queued is rejected');
  is(isValidParty({ ...good, deck: ['NaN'] }), false, 'a corrupted deck is rejected');
  is(isValidParty({ ...good, rng: 'x' }), false, 'a corrupted rng is rejected');
  is(isValidParty({ ...good, prompt: null }), false, 'a mid-round save with no prompt is rejected');
  const midJudge = submitAnswer(submitAnswer(good, 'one'), 'two');
  is(isValidParty({ ...midJudge, winner: null, order: [0] }), false,
    'a judge phase with a short order is rejected');
  const crowned = crownWinner(midJudge, 0);
  is(isValidParty({ ...crowned, winner: null }), false, 'an un-scrapped reveal with no winner is rejected');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll party tests passed.');

// ---- review regression tests (2026-08-02) ------------------------------
// Latecomer fairness across an extension: with the judge stored rather
// than derived, everyone — including the latecomer — judges exactly once
// per full trip after they join.
{
  let s = party(['A', 'B', 'C']);
  const seen = [];
  const playRound = (st) => {
    while (st.phase === 'submit') st = submitAnswer(st, 'answer ' + st.queue[0]);
    st = crownWinner(st, 0);
    return st;
  };
  for (let i = 0; i < 3; i++) { seen.push(judgeIndex(s)); s = playRound(s); s = i < 2 ? nextRound(s) : s; }
  s = nextRound(s); // -> over
  s = extendRounds(s, 4);
  s = playRound(s);       // first extension round ends at reveal…
  s = addPlayer(s, 'D');  // …which is where latecomers get dealt in
  s = nextRound(s);
  const extSeen = [judgeIndex(s)];
  for (let i = 0; i < 4; i++) { s = playRound(s); s = nextRound(s); if (s.phase !== 'over') extSeen.push(judgeIndex(s)); }
  is(new Set(extSeen).size, 4, 'after a latecomer joins, four extension rounds get four distinct judges');
  is(extSeen.includes(3), true, 'the latecomer gets a turn as judge');
}

// Validator rejects internally corrupt states.
{
  let s = party(['A', 'B', 'C', 'D']);
  is(isValidParty({ ...s, queue: [s.queue[0], s.queue[0]] }), false, 'duplicate players in the queue are rejected');
  is(isValidParty({ ...s, queue: [...s.queue, judgeIndex(s)] }), false, 'the judge in the queue is rejected');
  is(isValidParty({ ...s, players: s.players.map((p) => ({ ...p, name: 'Same' })) }), false, 'duplicate player names are rejected');
  is(isValidParty({ ...s, deck: [...s.deck.slice(0, -1), s.deck[0]] }), false, 'duplicate deck cards are rejected');
  is(isValidParty({ ...s, judge: undefined }), false, 'a save without a stored judge is rejected');
  let j = s;
  while (j.phase === 'submit') j = submitAnswer(j, 'x' + j.queue[0]);
  const w = crownWinner(j, 0);
  is(isValidParty({ ...w, winner: { player: w.winner.player, text: 'never submitted' } }), false,
    'a winner that matches no submission is rejected');
}

// Reshuffle boundary: the same prompt never repeats back-to-back, on any seed.
{
  for (let seed = 0; seed < 20; seed++) {
    let s = createParty({ playerNames: ['A', 'B', 'C'], cards: CARDS.slice(0, 45), seed });
    s = { ...s, totalRounds: 95 };
    let prev = null, repeat = false;
    for (let i = 0; i < 94; i++) {
      if (s.prompt === prev) { repeat = true; break; }
      prev = s.prompt;
      while (s.phase === 'submit') s = submitAnswer(s, 'a' + s.queue[0]);
      s = crownWinner(s, 0);
      s = nextRound(s);
    }
    if (repeat) { failures += 1; console.error('✗ prompt repeated back-to-back at seed ' + seed); break; }
  }
  console.log('✓ no back-to-back prompt repeats across 20 seeds through multiple reshuffles');
}
