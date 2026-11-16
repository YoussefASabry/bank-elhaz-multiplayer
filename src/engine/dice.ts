/**
 * Dice.
 *
 * `diceCount: 1` is a host option. The old implementation returned
 * `{ die2: 0, total: d1 + 0 }` and separately reported `isDouble: count >= 2 && d1 === d2`,
 * which is correct but leaves `die2: 0` to leak into the UI as a blank face — the
 * client had to special-case it in two places. Here `die2` is null for one-die
 * games so the absence is explicit and type-checked.
 */

import type { Rng } from './rng.js';

export interface DiceRoll {
  die1: number;
  die2: number | null;
  total: number;
  isDouble: boolean;
}

export function rollDice(rng: Rng, diceCount: 1 | 2): DiceRoll {
  const die1 = rng.range(1, 6);
  if (diceCount === 1) {
    return { die1, die2: null, total: die1, isDouble: false };
  }
  const die2 = rng.range(1, 6);
  return { die1, die2, total: die1 + die2, isDouble: die1 === die2 };
}
