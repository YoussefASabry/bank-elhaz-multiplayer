/**
 * Seedable PRNG.
 *
 * The engine must be deterministic given a seed, so `Math.random()` is banned
 * everywhere under src/engine/ (acceptance criterion 10 greps for it). Every
 * function that needs randomness takes an `Rng`. This is what lets the soak test
 * replay an identical 200-turn game across seeds 1..5 and makes any failure
 * reproducible instead of a one-in-a-thousand flake.
 *
 * Algorithm is mulberry32: 32-bit state, good enough distribution for dice and
 * shuffles, and trivially portable so a seed means the same thing everywhere.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Returns 0 when maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** Uniform integer in [min, max] inclusive. */
  range(min: number, max: number): number;
  /** Fisher-Yates, in place, returning the same array for chaining. */
  shuffle<T>(items: T[]): T[];
  /** A fresh independent Rng, for isolating sub-streams. */
  fork(): Rng;
}

export function createRng(seed: number): Rng {
  // Avoid a zero state, which would make mulberry32 degenerate.
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => {
    if (maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive);
  };

  const rng: Rng = {
    next,
    int,
    range: (min, max) => min + int(max - min + 1),
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const a = items[i] as T;
        const b = items[j] as T;
        items[i] = b;
        items[j] = a;
      }
      return items;
    },
    fork: () => createRng(int(0x7fffffff)),
  };

  return rng;
}
