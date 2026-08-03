/* MAPLES TO MAPLES party engine — pure rules for Party Mode, the fleet's
 * engine-purity convention (see kings-corner/js/engine.js): every function
 * is a pure function over one plain JSON-serializable state object. No DOM,
 * no network, no timers, no Date, no Math.random — the shuffle runs on a
 * seeded RNG whose integer state lives INSIDE the game state, so a party
 * survives JSON.stringify → JSON.parse → resume, and the same seed always
 * deals the same night. Online multiplayer later = syncing this exact
 * object; keep ALL party rules in this file (js/party.js is UI only).
 *
 * The shape of a round, one shared phone passing around the table:
 *   'submit' — everyone but the judge takes the phone in turn and plays
 *              an answer to the green card (or gets skipped)
 *   'judge'  — the judge reads the shuffled, anonymous answers and crowns one
 *   'reveal' — the author is unmasked, a maple is scored (or the round was
 *              scrapped: fewer than 2 answers came in)
 *   'over'   — every planned round played; extendRounds() deals another lap
 *
 * The judge rotates every round: round r is judged by player r % nPlayers,
 * and one full "trip" is nPlayers rounds, so everyone judges once.
 *
 * Public API (every mutator returns a NEW state, never mutates):
 *   createParty({ playerNames, cards, seed })  -> state
 *   judgeIndex(state)                          -> player index judging now
 *   currentSubmitter(state)                    -> player index holding the phone, or null
 *   submitAnswer(state, text)                  -> state (records, passes the phone)
 *   submitAnswerFor(state, player, text)       -> state (online: any seat, any order)
 *   skipSubmitter(state)                       -> state (they're in the bathroom)
 *   skipPlayer(state, player)                  -> state (online: judge skips a ghost)
 *   answersForJudge(state)                     -> shuffled anonymous texts
 *   crownWinner(state, pick)                   -> state (pick indexes answersForJudge)
 *   addPlayer(state, name)                     -> state (deal a latecomer in, reveal only)
 *   nextRound(state)                           -> state (next card, next judge)
 *   extendRounds(state, extra)                 -> state (from 'over': deal more rounds)
 *   standings(state)                           -> scoreboard, leaders first
 */

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 16;
export const MAX_ANSWER_LEN = 80;

/* ---------------------------------------------------------------- RNG
 * mulberry32, same idiom as the kings-corner engine — the integer state is
 * threaded through and stored on the party state as `rng`. */

function rngNext(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, s };
}

/* Fisher-Yates. Returns { items, rng } — never touches the input array. */
function shuffle(input, rngState) {
  const items = input.slice();
  let s = rngState;
  for (let i = items.length - 1; i > 0; i--) {
    const r = rngNext(s);
    s = r.s;
    const j = Math.floor(r.value * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return { items, rng: s };
}

/* ---------------------------------------------------------------- setup */

export function createParty(options = {}) {
  const rawNames = options.playerNames;
  if (!Array.isArray(rawNames)) throw new Error('playerNames must be an array');
  const names = rawNames.map((n) => String(n ?? '').trim());
  if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) {
    throw new Error(`party needs ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
  }
  if (names.some((n) => !n)) throw new Error('every player needs a name');
  const seen = new Set();
  for (const n of names) {
    const key = n.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate player name: ${n}`);
    seen.add(key);
  }

  const rawCards = options.cards;
  if (!Array.isArray(rawCards) || rawCards.length === 0) {
    throw new Error('cards must be a non-empty array of prompts');
  }
  const cards = rawCards.map((c) => String(c ?? '').trim());
  if (cards.some((c) => !c)) throw new Error('cards must be a non-empty array of prompts');

  const seed = (options.seed ?? 1) | 0;
  const shuffled = shuffle(cards.map((_, i) => i), seed);

  const base = {
    version: 1,
    seed,
    rng: shuffled.rng,
    cards: cards.slice(),
    deck: shuffled.items,
    players: names.map((name) => ({ name, score: 0 })),
    round: 0,
    totalRounds: names.length, // one trip around the table: everyone judges once
    phase: 'submit',
    prompt: null,
    queue: [],
    submissions: [],
    order: [],
    winner: null,
    scrapped: false,
  };
  return startRound(base, 0, 0);
}

/* Is this a party state this engine can safely drive? Structural check for
 * anything read back from storage — a truncated or hand-mangled save must
 * land here as false, never as a crash mid-party. */
export function isValidParty(s) {
  if (!s || typeof s !== 'object' || s.version !== 1) return false;
  if (!['submit', 'judge', 'reveal', 'over'].includes(s.phase)) return false;
  if (!Array.isArray(s.players) || s.players.length < MIN_PLAYERS || s.players.length > MAX_PLAYERS) return false;
  if (!s.players.every((p) => p && typeof p.name === 'string' && p.name.trim()
    && Number.isInteger(p.score) && p.score >= 0)) return false;
  const n = s.players.length;
  if (!Number.isInteger(s.round) || !Number.isInteger(s.totalRounds)
    || s.round < 0 || s.totalRounds < 1 || s.round > s.totalRounds) return false;
  if (!Number.isInteger(s.rng)) return false;
  if (!Array.isArray(s.cards) || s.cards.length === 0
    || !s.cards.every((c) => typeof c === 'string' && c.trim())) return false;
  const cardIdx = (i) => Number.isInteger(i) && i >= 0 && i < s.cards.length;
  const playerIdx = (i) => Number.isInteger(i) && i >= 0 && i < n;
  if (!Array.isArray(s.deck) || !s.deck.every(cardIdx)) return false;
  if (!Array.isArray(s.queue) || !s.queue.every(playerIdx)) return false;
  if (!Array.isArray(s.submissions) || !s.submissions.every((x) => x && playerIdx(x.player)
    && typeof x.text === 'string' && x.text.trim() && x.text.length <= MAX_ANSWER_LEN)) return false;
  if (!Array.isArray(s.order)
    || !s.order.every((i) => Number.isInteger(i) && i >= 0 && i < s.submissions.length)) return false;
  if (s.phase !== 'over' && typeof s.prompt !== 'string') return false;
  if (!Number.isInteger(s.judge) || !playerIdx(s.judge)) return false;
  // Structural honesty: unique names, unique deck cards, and a queue /
  // submission set that exactly partitions the non-judges.
  const names = s.players.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return false;
  if (new Set(s.deck).size !== s.deck.length) return false;
  if (s.queue.includes(s.judge)) return false;
  if (new Set(s.queue).size !== s.queue.length) return false;
  const subPlayers = s.submissions.map((x) => x.player);
  if (subPlayers.includes(s.judge)) return false;
  if (new Set(subPlayers).size !== subPlayers.length) return false;
  if (s.queue.some((q) => subPlayers.includes(q))) return false;
  if (new Set(s.order).size !== s.order.length) return false;
  if (s.phase === 'submit') {
    if (s.queue.length === 0) return false;
    if (subPlayers.length + s.queue.length !== n - 1) return false;
  }
  if (s.phase === 'judge' && (s.order.length < 2 || s.order.length !== s.submissions.length)) return false;
  if (s.phase === 'reveal' && !s.scrapped) {
    if (!(s.winner && playerIdx(s.winner.player) && typeof s.winner.text === 'string')) return false;
    if (!s.submissions.some((x) => x.player === s.winner.player && x.text === s.winner.text)) return false;
  }
  return true;
}

/* Deal a fresh round: draw a card (reshuffling a spent deck), rebuild the
 * pass-the-phone queue starting at the judge's left, clear the table. */
function startRound(state, round, judge) {
  let { deck, rng } = state;
  if (deck.length === 0) {
    const re = shuffle(state.cards.map((_, i) => i), rng);
    deck = re.items;
    rng = re.rng;
    // A fresh shuffle may put the card we just played right back on top —
    // rotate it to the bottom so no table ever sees the same prompt twice
    // in a row.
    if (deck.length > 1 && state.prompt && state.cards[deck[deck.length - 1]] === state.prompt) {
      deck = [deck[deck.length - 1], ...deck.slice(0, -1)];
    }
  }
  const prompt = state.cards[deck[deck.length - 1]];
  const n = state.players.length;
  if (!Number.isInteger(judge)) judge = 0;
  judge = ((judge % n) + n) % n;
  const queue = [];
  for (let i = 1; i < n; i++) queue.push((judge + i) % n);
  return {
    ...state,
    rng,
    judge,
    deck: deck.slice(0, -1),
    round,
    phase: 'submit',
    prompt,
    queue,
    submissions: [],
    order: [],
    winner: null,
    scrapped: false,
  };
}

/* ---------------------------------------------------------------- reads */

export function judgeIndex(state) {
  return state.judge;
}

export function currentSubmitter(state) {
  return state.phase === 'submit' && state.queue.length ? state.queue[0] : null;
}

/* The judge's deck: shuffled and anonymous — order never betrays who
 * answered first. */
export function answersForJudge(state) {
  if (state.phase !== 'judge') throw new Error('not judging yet');
  return state.order.map((i) => state.submissions[i].text);
}

/* Scoreboard rows { player, name, score }, highest first (stable: table
 * order breaks ties). leaders = everyone sharing the top score. */
export function standings(state) {
  const rows = state.players
    .map((p, player) => ({ player, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.player - b.player);
  const top = rows[0].score;
  return { rows, leaders: rows.filter((r) => r.score === top) };
}

/* ---------------------------------------------------------------- submit */

export function submitAnswer(state, rawText) {
  if (state.phase !== 'submit') throw new Error('not accepting answers now');
  return submitAnswerFor(state, state.queue[0], rawText);
}

/* Seat-aware submit for online play, where answers land in any order. A
 * player whose answer already landed gets the SAME state object back — that
 * idempotence is what makes the UI's version-conflict retry loop safe to
 * re-apply against a fresher state. */
export function submitAnswerFor(state, player, rawText) {
  if (state.phase !== 'submit') throw new Error('not accepting answers now');
  if (!Number.isInteger(player) || player < 0 || player >= state.players.length) {
    throw new Error('bad player: ' + player);
  }
  if (state.submissions.some((x) => x.player === player)) return state;
  if (player === state.judge) throw new Error('the judge does not answer');
  if (!state.queue.includes(player)) throw new Error('answers are closed for this seat');
  const text = String(rawText ?? '').trim();
  if (!text) throw new Error('empty_answer');
  if (text.length > MAX_ANSWER_LEN) throw new Error('answer_too_long');
  const next = {
    ...state,
    submissions: state.submissions.concat([{ player, text }]),
    queue: state.queue.filter((p) => p !== player),
  };
  return next.queue.length ? next : closeSubmissions(next);
}

export function skipSubmitter(state) {
  if (state.phase !== 'submit') throw new Error('not accepting answers now');
  return skipPlayer(state, state.queue[0]);
}

/* Online: drop a player from this round's queue (their phone went dark).
 * Skipping someone already answered or already skipped is a no-op. */
export function skipPlayer(state, player) {
  if (state.phase !== 'submit') throw new Error('not accepting answers now');
  if (!state.queue.includes(player)) return state;
  const next = { ...state, queue: state.queue.filter((p) => p !== player) };
  return next.queue.length ? next : closeSubmissions(next);
}

/* Last answer is in. Fewer than 2 and there's nothing to judge — scrap the
 * round; otherwise shuffle the judging order and hand the phone over. */
function closeSubmissions(state) {
  if (state.submissions.length < 2) {
    return { ...state, phase: 'reveal', scrapped: true, order: [], winner: null };
  }
  const { items, rng } = shuffle(state.submissions.map((_, i) => i), state.rng);
  return { ...state, rng, order: items, phase: 'judge' };
}

/* ---------------------------------------------------------------- judge */

export function crownWinner(state, pick) {
  if (state.phase !== 'judge') throw new Error('not judging yet');
  if (!Number.isInteger(pick) || pick < 0 || pick >= state.order.length) {
    throw new Error('bad pick: ' + pick);
  }
  const sub = state.submissions[state.order[pick]];
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === sub.player ? { ...p, score: p.score + 1 } : p),
    phase: 'reveal',
    winner: { player: sub.player, text: sub.text },
  };
}

/* Deal a latecomer in between rounds (the reveal screen): they join with
 * zero maples, enter the pass order from the next round, and the party
 * grows by one round so the gavel still reaches everyone roughly once. */
export function addPlayer(state, rawName) {
  if (state.phase !== 'reveal') throw new Error('deal newcomers in between rounds');
  if (state.players.length >= MAX_PLAYERS) throw new Error(`the table is full at ${MAX_PLAYERS}`);
  const name = String(rawName ?? '').trim();
  if (!name) throw new Error('every player needs a name');
  if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`duplicate player name: ${name}`);
  }
  return {
    ...state,
    players: state.players.concat([{ name, score: 0 }]),
    totalRounds: state.totalRounds + 1,
  };
}

/* ---------------------------------------------------------------- rounds */

export function nextRound(state) {
  if (state.phase !== 'reveal') throw new Error('round is not over');
  const round = state.round + 1;
  if (round >= state.totalRounds) {
    return { ...state, round, phase: 'over', prompt: null, queue: [], order: [] };
  }
  // Rotation is stored, not derived: latecomers extend the table without
  // rewriting who has already judged (round % n breaks once n changes).
  return startRound(state, round, (state.judge + 1) % state.players.length);
}

/* From 'over': deal another lap (default: one more full trip around the
 * table, so the judge rotation stays fair). */
export function extendRounds(state, extra = state.players.length) {
  if (state.phase !== 'over') throw new Error('party is still going');
  if (!Number.isInteger(extra) || extra < 1) throw new Error('bad extension: ' + extra);
  return startRound({ ...state, totalRounds: state.totalRounds + extra }, state.round, (state.judge + 1) % state.players.length);
}
