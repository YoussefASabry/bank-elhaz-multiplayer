import { describe, it, expect } from 'vitest';
import { createRng } from '../../src/engine/rng.js';
import { rollDice } from '../../src/engine/dice.js';

describe('rng determinism', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 20 }, (_, i) => createRng(1).int(1000) + i * 0);
    const b = Array.from({ length: 20 }, (_, i) => createRng(2).int(1000) + i * 0);
    expect(a[0]).not.toBe(b[0]);
  });

  it('stays within [0,1)', () => {
    const r = createRng(9);
    for (let i = 0; i < 500; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('does not degenerate on seed 0', () => {
    const r = createRng(0);
    const vals = new Set(Array.from({ length: 20 }, () => r.next()));
    expect(vals.size).toBeGreaterThan(1);
  });

  it('int() stays in range and tolerates non-positive bounds', () => {
    const r = createRng(4);
    for (let i = 0; i < 200; i++) {
      const v = r.int(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
    expect(r.int(0)).toBe(0);
    expect(r.int(-3)).toBe(0);
  });

  it('range() is inclusive on both ends', () => {
    const r = createRng(13);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.range(1, 6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('shuffle', () => {
  it('is a permutation — no items lost or duplicated', () => {
    const r = createRng(21);
    const src = Array.from({ length: 30 }, (_, i) => i);
    const out = r.shuffle([...src]);
    expect(out).toHaveLength(30);
    expect([...out].sort((a, b) => a - b)).toEqual(src);
  });

  it('is deterministic for a given seed', () => {
    const one = createRng(77).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const two = createRng(77).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(one).toEqual(two);
  });

  it('actually reorders (not an identity shuffle)', () => {
    const src = Array.from({ length: 40 }, (_, i) => i);
    const out = createRng(5).shuffle([...src]);
    expect(out).not.toEqual(src);
  });
});

describe('dice', () => {
  it('rolls two dice in 1..6 and sums them', () => {
    const r = createRng(31);
    for (let i = 0; i < 300; i++) {
      const roll = rollDice(r, 2);
      expect(roll.die1).toBeGreaterThanOrEqual(1);
      expect(roll.die1).toBeLessThanOrEqual(6);
      expect(roll.die2).not.toBeNull();
      expect(roll.die2 ?? 0).toBeGreaterThanOrEqual(1);
      expect(roll.die2 ?? 0).toBeLessThanOrEqual(6);
      expect(roll.total).toBe(roll.die1 + (roll.die2 ?? 0));
    }
  });

  it('reports die2 as null for a one-die game rather than a misleading 0', () => {
    const r = createRng(8);
    for (let i = 0; i < 50; i++) {
      const roll = rollDice(r, 1);
      expect(roll.die2).toBeNull();
      expect(roll.total).toBe(roll.die1);
      expect(roll.isDouble).toBe(false);
    }
  });

  it('detects doubles only in two-dice games', () => {
    const r = createRng(2);
    let doubles = 0;
    for (let i = 0; i < 600; i++) {
      const roll = rollDice(r, 2);
      if (roll.isDouble) {
        doubles++;
        expect(roll.die1).toBe(roll.die2);
      }
    }
    // ~1/6 of 600 == 100; assert it is in a sane band rather than exact.
    expect(doubles).toBeGreaterThan(50);
    expect(doubles).toBeLessThan(160);
  });
});
