import { describe, it, expect } from 'vitest';
import rawBoardJson from '../../data/board.json' with { type: 'json' };
import type { RawBoard, RawUpgradableProperty } from '../../src/shared/raw.js';
import { isOwnable, isUpgradableSquare } from '../../src/engine/board.js';
import { ownerOf, upgradeOf } from '../../src/engine/state.js';
import {
  calculateRent,
  getUpgradeOptions,
  purchaseUpgrade,
  sellUpgrade,
  buyProperty,
  sellPropertyToBank,
} from '../../src/engine/property.js';
import { board, makeState, give, giveColorGroup, setMoney, p, SQ, SEAT_A, SEAT_B } from '../helpers/fixtures.js';

const rawBoard = rawBoardJson as unknown as RawBoard;

// ── Data pinning: every one of the 34 squares, cross-checked against the raw JSON ──

describe('board data pinning (all 34 squares)', () => {
  it('loads exactly 34 squares, matching the raw data', () => {
    expect(rawBoard.board_positions).toHaveLength(34);
    expect(board.squares).toHaveLength(34);
  });

  for (const rawSquare of rawBoard.board_positions) {
    it(`square ${rawSquare.id} (${rawSquare.name}) is normalised faithfully`, () => {
      const sq = board.squares.find((s) => s.id === rawSquare.id);
      expect(sq).toBeDefined();
      if (sq === undefined) return;

      if (rawSquare.type !== 'property') return;

      if (!isOwnable(sq)) throw new Error(`square ${rawSquare.id} should be ownable`);
      expect(sq.purchasePrice).toBe(rawSquare.purchase_price);
      expect(sq.baseRent).toBe(rawSquare.base_rent);

      if (rawSquare.visitor_paying !== undefined && rawSquare.owner_paying !== undefined) {
        // Upgradable property: buildCost <- owner_paying, visitorRent <- visitor_paying.
        const up: RawUpgradableProperty = rawSquare;
        expect(isUpgradableSquare(sq)).toBe(true);
        if (!isUpgradableSquare(sq)) return;
        expect(sq.buildCost).toEqual({
          garage: up.owner_paying.garage_rent,
          rest_stop: up.owner_paying.rest_stop_rent,
          market: up.owner_paying.market_rent,
        });
        expect(sq.visitorRent).toEqual({
          garage: up.visitor_paying.garage_rent,
          rest_stop: up.visitor_paying.rest_stop_rent,
          market: up.visitor_paying.market_rent,
        });
      } else {
        // The one utility square (id 16): ownable, but no tier tables at all.
        expect(isUpgradableSquare(sq)).toBe(false);
      }
    });
  }

  it('square 16 (محطة بنزين) is the utility, not an upgradable property', () => {
    const sq = board.squares.find((s) => s.id === SQ.gasStation);
    expect(sq?.kind).toBe('utility');
  });
});

// ── calculateRent (B25) ──

describe('calculateRent', () => {
  it('charges base rent with no upgrade', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem);
    expect(calculateRent(state, SQ.jerusalem, SEAT_B)).toBe(35);
  });

  it('charges the visitor-rent for the built tier — garage/rest_stop/market on القدس', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(calculateRent(state, SQ.jerusalem, SEAT_B)).toBe(190);

    give(state, SEAT_A, SQ.jerusalem, 'rest_stop');
    expect(calculateRent(state, SQ.jerusalem, SEAT_B)).toBe(900);

    give(state, SEAT_A, SQ.jerusalem, 'market');
    expect(calculateRent(state, SQ.jerusalem, SEAT_B)).toBe(1550);
  });

  it('charges nothing landing on your own property or an unowned one', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem);
    expect(calculateRent(state, SQ.jerusalem, SEAT_A)).toBe(0);
    expect(calculateRent(state, SQ.gaza, SEAT_B)).toBe(0);
  });

  it('halves (rounding up) and CONSUMES the half-rent flag, then applies once only (B36)', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem); // base rent 35
    const visitor = p(state, SEAT_B);
    visitor.statusEffects.payHalfRentNextLanding = true;

    expect(calculateRent(state, SQ.jerusalem, SEAT_B)).toBe(18); // ceil(35 / 2)
    expect(visitor.statusEffects.payHalfRentNextLanding).toBe(false);

    // Flag is consumed: the next landing charges full rent again.
    expect(calculateRent(state, SQ.jerusalem, SEAT_B)).toBe(35);
  });

  it('returns 0 for non-ownable squares', () => {
    const state = makeState();
    expect(calculateRent(state, SQ.dualDeck, SEAT_B)).toBe(0);
  });
});

// ── getUpgradeOptions / purchaseUpgrade (B24) ──

describe('getUpgradeOptions offers only the next tier', () => {
  it('garage -> rest_stop -> market -> nothing, in sequence', () => {
    const state = makeState();
    giveColorGroup(state, SEAT_A, 'purple'); // owns both القدس and غزة, no upgrades yet

    expect(getUpgradeOptions(state, SEAT_A, SQ.jerusalem)).toEqual([
      { tier: 'garage', cost: 250, visitorRent: 190 },
    ]);

    give(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(getUpgradeOptions(state, SEAT_A, SQ.jerusalem)).toEqual([
      { tier: 'rest_stop', cost: 750, visitorRent: 900 },
    ]);

    give(state, SEAT_A, SQ.jerusalem, 'rest_stop');
    expect(getUpgradeOptions(state, SEAT_A, SQ.jerusalem)).toEqual([
      { tier: 'market', cost: 1000, visitorRent: 1550 },
    ]);

    give(state, SEAT_A, SQ.jerusalem, 'market');
    expect(getUpgradeOptions(state, SEAT_A, SQ.jerusalem)).toEqual([]);
  });

  it('is empty for a square the seat does not own', () => {
    const state = makeState();
    giveColorGroup(state, SEAT_A, 'purple');
    expect(getUpgradeOptions(state, SEAT_B, SQ.jerusalem)).toEqual([]);
  });

  it('is empty for the utility square (16) — no tier tables to offer', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.gasStation);
    expect(getUpgradeOptions(state, SEAT_A, SQ.gasStation)).toEqual([]);
  });
});

describe('purchaseUpgrade', () => {
  it('rejects a tier that is not exactly next — market square cannot "upgrade" to garage', () => {
    const state = makeState();
    giveColorGroup(state, SEAT_A, 'purple');
    give(state, SEAT_A, SQ.jerusalem, 'market');

    const result = purchaseUpgrade(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(result).toEqual({ ok: false, reason: 'upgrade_tier_not_next' });
  });

  it('rejects without owning the full colour group', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem); // owns القدس only, not غزة

    const result = purchaseUpgrade(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(result).toEqual({ ok: false, reason: 'upgrade_requires_full_color_group' });
  });

  it('rejects the utility square (16) as not upgradable', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.gasStation);

    const result = purchaseUpgrade(state, SEAT_A, SQ.gasStation, 'garage');
    expect(result).toEqual({ ok: false, reason: 'square_not_upgradable' });
  });

  it('rejects insufficient funds and does not charge the player', () => {
    const state = makeState();
    giveColorGroup(state, SEAT_A, 'purple');
    setMoney(state, SEAT_A, 100); // garage costs 250

    const result = purchaseUpgrade(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(p(state, SEAT_A).money).toBe(100);
    expect(upgradeOf(state, SQ.jerusalem)).toBeNull();
  });

  it('rejects a seat that does not own the square', () => {
    const state = makeState();
    giveColorGroup(state, SEAT_A, 'purple');

    const result = purchaseUpgrade(state, SEAT_B, SQ.jerusalem, 'garage');
    expect(result).toEqual({ ok: false, reason: 'not_the_owner' });
  });

  it('builds the next tier, charging exactly the data cost', () => {
    const state = makeState();
    giveColorGroup(state, SEAT_A, 'purple');
    setMoney(state, SEAT_A, 1000);

    const result = purchaseUpgrade(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(result).toEqual({ ok: true, tier: 'garage', cost: 250 });
    expect(p(state, SEAT_A).money).toBe(750);
    expect(upgradeOf(state, SQ.jerusalem)).toBe('garage');
  });
});

// ── sellUpgrade ──

describe('sellUpgrade', () => {
  it('refunds 75% of the data build cost and clears the upgrade', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem, 'garage'); // build cost 250
    setMoney(state, SEAT_A, 500);

    const result = sellUpgrade(state, SEAT_A, SQ.jerusalem);
    expect(result).toEqual({ ok: true, tier: 'garage', refund: 188 }); // round(250 * 0.75)
    expect(p(state, SEAT_A).money).toBe(688);
    expect(upgradeOf(state, SQ.jerusalem)).toBeNull();
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_A); // property itself is untouched
  });

  it('rejects a seat that does not own the square', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem, 'garage');
    expect(sellUpgrade(state, SEAT_B, SQ.jerusalem)).toEqual({ ok: false, reason: 'not_the_owner' });
  });

  it('rejects a square with nothing built on it yet', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem); // owned, but no upgrade
    expect(sellUpgrade(state, SEAT_A, SQ.jerusalem)).toEqual({ ok: false, reason: 'no_upgrade_to_sell' });
  });

  it('rejects the utility square (16) as not upgradable, distinct from "nothing to sell"', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.gasStation);
    expect(sellUpgrade(state, SEAT_A, SQ.gasStation)).toEqual({ ok: false, reason: 'square_not_upgradable' });
  });
});

// ── buyProperty ──

describe('buyProperty', () => {
  it('buys at the listed purchase price and assigns ownership', () => {
    const state = makeState();
    setMoney(state, SEAT_A, 1000);

    const result = buyProperty(state, SEAT_A, SQ.jerusalem);
    expect(result).toEqual({ ok: true, price: 300 });
    expect(p(state, SEAT_A).money).toBe(700);
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_A);
  });

  it('rejects insufficient funds and leaves the square unowned', () => {
    const state = makeState();
    setMoney(state, SEAT_A, 100);

    const result = buyProperty(state, SEAT_A, SQ.jerusalem);
    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(p(state, SEAT_A).money).toBe(100);
    expect(ownerOf(state, SQ.jerusalem)).toBeNull();
  });

  it('rejects buying a square that already has an owner, without touching it', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem);
    const before = p(state, SEAT_B).money;

    const result = buyProperty(state, SEAT_B, SQ.jerusalem);
    expect(result).toEqual({ ok: false, reason: 'square_already_owned' });
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_A);
    expect(p(state, SEAT_B).money).toBe(before);
  });
});

// ── sellPropertyToBank ──

describe('sellPropertyToBank', () => {
  it('refunds 75% of the purchase price for a bare property', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem);
    setMoney(state, SEAT_A, 500);

    const result = sellPropertyToBank(state, SEAT_A, SQ.jerusalem);
    expect(result).toEqual({ ok: true, refund: 225 }); // round(300 * 0.75)
    expect(p(state, SEAT_A).money).toBe(725);
    expect(ownerOf(state, SQ.jerusalem)).toBeNull();
    expect(upgradeOf(state, SQ.jerusalem)).toBeNull();
  });

  it('refunds both the property AND the standing upgrade', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem, 'rest_stop'); // build cost 750
    setMoney(state, SEAT_A, 500);

    const result = sellPropertyToBank(state, SEAT_A, SQ.jerusalem);
    // round(300 * 0.75) + round(750 * 0.75) = 225 + 563
    expect(result).toEqual({ ok: true, refund: 788 });
    expect(p(state, SEAT_A).money).toBe(1288);
    expect(ownerOf(state, SQ.jerusalem)).toBeNull();
    expect(upgradeOf(state, SQ.jerusalem)).toBeNull();
  });

  it('rejects a seat that does not own the square', () => {
    const state = makeState();
    give(state, SEAT_A, SQ.jerusalem);
    expect(sellPropertyToBank(state, SEAT_B, SQ.jerusalem)).toEqual({ ok: false, reason: 'not_the_owner' });
  });
});
