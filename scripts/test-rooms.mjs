// Online-rooms wiring test: drives the real vendored client (js/rooms.js)
// against the local shim (scripts/rooms-shim.mjs) as 3-4 simulated phones,
// then plays full online parties through the real party engine — including
// the submit phase's SIMULTANEOUS pushes, where every phone but one hits
// version_conflict and must re-apply its answer to the refetched truth.
//
//   node scripts/test-rooms.mjs

import { startShim } from './rooms-shim.mjs';
import {
  createParty, submitAnswerFor, skipPlayer, crownWinner, nextRound,
  extendRounds, standings, isValidParty,
} from '../js/party-engine.js';
import { PARTY_CARDS } from '../js/party-cards.js';

const GAME = 'maples-to-maples';

/* --------------------------------------------------- phone environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (k) => (stores.get(current).has(k) ? stores.get(current).get(k) : null),
  setItem: (k, v) => stores.get(current).set(k, String(v)),
  removeItem: (k) => stores.get(current).delete(k),
};
function device(d) {
  if (!stores.has(d)) stores.set(d, new Map());
  current = d;
}
for (const d of ['A', 'B', 'C', 'D', 'E']) device(d);
device('A');

let passed = 0;
function t(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (e) {
    t(e && e.code === code, `${label} (got ${e && e.code})`);
  }
}

const shim = await startShim();
globalThis.BTOWN_ROOMS_URL = shim.url;
const { OnlineMatch, savedSession } = await import('../js/rooms.js');

const freshDeal = (seats) => createParty({
  playerNames: Array.from({ length: seats }, (_, i) => `Maple ${i + 1}`),
  cards: PARTY_CARDS,
  seed: 42 + seats,
});

/* The UI's pushOnline loop, distilled: re-apply this phone's action to the
 * freshest state on version_conflict; the engine's idempotence makes a
 * re-apply of an already-landed answer a no-op. */
async function pushParty(match, applyFn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = applyFn(match.state);
    if (next === match.state) return;
    try {
      await match.push(next, { over: next.phase === 'over' });
      return;
    } catch (e) {
      if (e?.code !== 'version_conflict') throw e;
    }
  }
  throw new Error('push never landed after 5 attempts');
}

async function syncAll(phones, label) {
  for (const p of phones) {
    device(p.d);
    await p.m._fetch();
  }
  const first = JSON.stringify(phones[0].m.state);
  t(phones.every((p) => JSON.stringify(p.m.state) === first), label);
}

/* Play a whole party: submit (deliberately from stale states, so pushes
 * conflict and retry), judge crowns, any phone deals the next card. */
async function playToTheEnd(phones, tag) {
  let guard = 0;
  while (phones[0].m.state.phase !== 'over') {
    if (++guard > 60) throw new Error('party never ended');
    const s = phones[0].m.state;
    if (s.phase === 'submit') {
      // every writer applies to its CURRENT (possibly stale) view — the
      // first push lands, the rest conflict and re-apply
      for (const w of phones.filter((p) => p.m.seat !== s.judge)) {
        device(w.d);
        await pushParty(w.m, (cur) => submitAnswerFor(cur, w.m.seat, `seat ${w.m.seat} plays round ${cur.round + 1}`));
      }
    } else if (s.phase === 'judge') {
      const j = phones.find((p) => p.m.seat === s.judge);
      device(j.d);
      await pushParty(j.m, (cur) => crownWinner(cur, 0));
    } else { // reveal
      const dealer = phones[(s.round + 1) % phones.length];
      device(dealer.d);
      await pushParty(dealer.m, (cur) => nextRound(cur));
    }
    await syncAll(phones, `${tag}: phones identical after a ${s.phase} step`);
    t(isValidParty(phones[0].m.state) || phones[0].m.state.phase === 'over', `${tag}: state stays structurally valid`);
  }
}

/* ------------------------------------------------------ generic checks */

device('A');
const host = await OnlineMatch.create({ game: GAME, name: 'Ann', seats: 3, state: freshDeal(3) });
t(/^[A-Z2-9]{4}$/.test(host.code) && host.seat === 0 && host.status === 'waiting', 'host deals a 3-seat table in seat 0');
t(savedSession(GAME)?.roomId === host.roomId, 'host session saved');
t(JSON.stringify(host.state).length < 131072, 'a fresh party fits far under the state cap');

device('B');
await expectCode(OnlineMatch.join({ game: GAME, code: 'ZZZZ', name: 'X' }), 'not_found', 'bad code rejected');
await expectCode(OnlineMatch.join({ game: 'crazy-eights', code: host.code, name: 'X' }), 'wrong_game', 'wrong game rejected');
const bo = await OnlineMatch.join({ game: GAME, code: ` ${host.code.toLowerCase()} `, name: 'Bo' });
t(bo.seat === 1 && bo.status === 'waiting', 'second phone takes seat 1, table still waiting');

device('C');
const cy = await OnlineMatch.join({ game: GAME, code: host.code, name: 'Cy' });
t(cy.seat === 2 && cy.status === 'playing', 'third phone fills the table and the party starts');
t(cy.opponents().map((o) => o.name).sort().join(',') === 'Ann,Bo', 'joiner sees both other names');

device('D');
await expectCode(OnlineMatch.join({ game: GAME, code: host.code, name: 'Di' }), 'room_started', 'a fourth phone is turned away from a full 3-seat table');

/* -------------------------------------- the concurrent-submission race */

const trio = [{ m: host, d: 'A' }, { m: bo, d: 'B' }, { m: cy, d: 'C' }];
await syncAll(trio, 'all three phones start from the same deal');

{
  const base = host.state;
  t(base.phase === 'submit' && base.judge === 0, 'round 1: seat 0 judges, seats 1-2 write');
  const fromBo = submitAnswerFor(base, 1, 'a creemee in a blizzard');
  const fromCy = submitAnswerFor(base, 2, 'Champ doing taxes');
  device('B');
  await bo.push(fromBo);
  t(bo.version === 1, "Bo's answer lands first");
  device('C');
  await expectCode(cy.push(fromCy), 'version_conflict', "Cy's simultaneous push hits version_conflict");
  t(cy.state.submissions.length === 1, "the conflict refetched Bo's answer into Cy's state");
  const midRace = submitAnswerFor(cy.state, 1, 'a creemee in a blizzard');
  t(midRace === cy.state, "re-applying Bo's already-landed answer is a same-object no-op");
  const retried = submitAnswerFor(cy.state, 2, 'Champ doing taxes');
  await cy.push(retried);
  t(cy.state.phase === 'judge', "Cy re-applies to the fresh state and the round closes");
}

await syncAll(trio, 'phones agree after the race');
{
  const j = trio.find((p) => p.m.seat === host.state.judge);
  device(j.d);
  await pushParty(j.m, (cur) => crownWinner(cur, 0));
  await syncAll(trio, 'phones agree after the crowning');
  t(host.state.phase === 'reveal' && host.state.winner, 'a winner is on the table');
  device('A');
  await pushParty(host, (cur) => nextRound(cur));
  await syncAll(trio, 'phones agree after dealing round 2');
}

/* --------------------------------------------- full 3-phone party */

await playToTheEnd(trio, '3p');
t(host.state.phase === 'over', '3-phone party reaches the final standings');
t(standings(host.state).rows.length === 3, 'standings cover all three seats');
t(host.status === 'over', 'the room is flagged over with the party');

// another trip around the table (the online rematch)
device('B');
await pushParty(bo, (cur) => extendRounds(cur));
await syncAll(trio, 'phones agree after dealing another trip');
t(host.state.phase === 'submit' && host.state.totalRounds === 6, 'another 3-round trip is dealt into the same room');
await playToTheEnd(trio, '3p-extended');
t(host.state.phase === 'over', 'the extended trip also reaches standings');

// resume after a "refresh"
device('A');
const resumed = await OnlineMatch.resume({ game: GAME });
t(resumed.roomId === host.roomId && resumed.seat === 0, 'resume reattaches to the same seat');

// leave: the other phones see the table break up
await resumed.leave();
t(savedSession(GAME) === null, 'leave clears the session');
device('B');
await bo._fetch();
t(bo.status === 'over' && bo.opponents().some((o) => o.left), 'the table sees who left');
await expectCode(pushParty(bo, (cur) => extendRounds(cur)), 'opponent_left', 'dealing into an abandoned table is barred');

/* --------------------------------------------- full 4-phone party */

device('A');
const h4 = await OnlineMatch.create({ game: GAME, name: 'Ann', seats: 4, state: freshDeal(4) });
device('B');
const g1 = await OnlineMatch.join({ game: GAME, code: h4.code, name: 'Bo' });
device('C');
const g2 = await OnlineMatch.join({ game: GAME, code: h4.code, name: 'Cy' });
device('D');
const g3 = await OnlineMatch.join({ game: GAME, code: h4.code, name: 'Di' });
t(g3.seat === 3 && g3.status === 'playing', 'four phones fill a 4-seat table');
const quad = [{ m: h4, d: 'A' }, { m: g1, d: 'B' }, { m: g2, d: 'C' }, { m: g3, d: 'D' }];
await syncAll(quad, 'four phones start from the same deal');

// the judge skips a phone that went dark mid-round
{
  const s = h4.state;
  const writers = quad.filter((p) => p.m.seat !== s.judge);
  for (const w of writers.slice(0, 2)) {
    device(w.d);
    await pushParty(w.m, (cur) => submitAnswerFor(cur, w.m.seat, `seat ${w.m.seat} made it`));
  }
  const judgePhone = quad.find((p) => p.m.seat === s.judge);
  const ghost = writers[2].m.seat;
  device(judgePhone.d);
  await pushParty(judgePhone.m, (cur) => skipPlayer(cur, ghost));
  await syncAll(quad, 'phones agree after the judge skips a dark phone');
  t(h4.state.phase === 'judge' && h4.state.submissions.length === 2, 'skipping the last writer closes the round with 2 answers');
  await pushParty(judgePhone.m, (cur) => crownWinner(cur, 0));
  device(quad[1].d);
  await quad[1].m._fetch();
  await pushParty(quad[1].m, (cur) => nextRound(cur));
  await syncAll(quad, 'phones agree heading into round 2');
}

await playToTheEnd(quad, '4p');
t(h4.state.phase === 'over', '4-phone party reaches the final standings');
t(standings(h4.state).rows.length === 4, 'standings cover all four seats');

// a 5th phone can never sit down
device('E');
await expectCode(OnlineMatch.join({ game: GAME, code: h4.code, name: 'Ed' }), 'room_started', 'a fifth phone is turned away');

/* --------------------------------------------------------- not_ready */

{
  const { createServer } = await import('node:http');
  const dead = createServer((req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  globalThis.BTOWN_ROOMS_URL = `http://127.0.0.1:${dead.address().port}`;
  const fresh = await import('../js/rooms.js?not-ready');
  await expectCode(
    fresh.OnlineMatch.create({ game: GAME, name: 'A', state: freshDeal(3), seats: 3 }),
    'not_ready', 'missing backend reads as not_ready');
  dead.close();
}

shim.server.close();
console.log(`\nALL ROOMS TESTS PASSED (${passed} checks)`);
process.exit(0);
