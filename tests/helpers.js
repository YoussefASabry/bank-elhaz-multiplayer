import { readFileSync } from 'fs';
import { GameEngine } from '../server/engine.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../shared/${name}.json`, import.meta.url)));
export const data = { board: load('board'), hazak: load('hazak'), mahkama: load('mahkama') };

// Deterministic RNG from a fixed sequence (repeats when exhausted)
export function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// Mulberry32 — seedable PRNG for full-game simulations
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeEngine({ players = 3, options = {}, rng = seededRng(42) } = {}) {
  const roomPlayers = Array.from({ length: players }, (_, i) => ({
    id: `p${i + 1}`, name: `Player ${i + 1}`, avatar: i + 1,
  }));
  return new GameEngine({ players: roomPlayers, options, rng, data });
}

// Force dice: returns an rng whose first two samples produce die1, die2.
// rng() is used as Math.floor(rng()*6)+1 → value v needs rng in [(v-1)/6, v/6).
export function diceRng(...dice) {
  const vals = dice.map(d => (d - 1) / 6 + 0.001);
  return seqRng(vals);
}

// Land a player exactly on `targetId` with a non-double 1+2 roll, never wrapping
// past Start (which would pay salary and corrupt money expectations).
export function forceRoll(engine, playerId, targetId) {
  if (targetId < 4) throw new Error('forceRoll targets must be ≥ 4 to avoid passing Start');
  const player = engine.player(playerId);
  player.position = targetId - 3;
  engine.rng = diceRng(1, 2);
  return engine.dispatch(playerId, { type: 'roll' });
}

// Give ownership without going through purchase flow
export function grant(engine, playerId, ...squareIds) {
  for (const id of squareIds) {
    const sq = engine.square(id);
    sq.owner = playerId;
    sq.level = 0;
  }
}
