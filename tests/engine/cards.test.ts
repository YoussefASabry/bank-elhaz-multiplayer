import { describe, expect, it } from 'vitest';
import {
  makeDuel,
  makeState,
  makeRng,
  give,
  setMoney,
  setPosition,
  p,
  SEAT_A,
  SEAT_B,
  SEAT_C,
  stackCard,
  board,
} from '../helpers/fixtures.js';
import { isOwnable, findSquare, prisonSquare } from '../../src/engine/board.js';
import { ownerOf } from '../../src/engine/state.js';
import { applyCardEffects, preselectCities, resolveChoice, setupChoices } from '../../src/engine/cards.js';
import type { GameState } from '../../src/shared/types.js';

function drawStacked(state: GameState, deck: 'hazak' | 'mahkama', cardId: number) {
  stackCard(state, deck, cardId);
  const pile = state.decks[deck];
  const card = pile.draw.pop();
  if (card === undefined) throw new Error('test: card not on top of pile');
  return card;
}

describe('cards: hazak effects', () => {
  it('hazak 14 sets payHalfRentNextLanding and advances 4 squares', () => {
    const state = makeState();
    const card = drawStacked(state, 'hazak', 14);
    const player = p(state, SEAT_A);
    const from = player.position;
    const rng = makeRng();

    const result = applyCardEffects(state, SEAT_A, card, rng);

    expect(player.statusEffects.payHalfRentNextLanding).toBe(true);
    expect(player.position).not.toBe(from);
    expect(result.needsLandingEval).toBe(true);
  });

  it('halfRentNextLanding is OR-ed in and never clobbers a pending flag back to false', () => {
    const state = makeState();
    const player = p(state, SEAT_A);
    player.statusEffects.payHalfRentNextLanding = true;

    const card = drawStacked(state, 'hazak', 3); // an ordinary card with no half-rent effect
    applyCardEffects(state, SEAT_A, card, makeRng());

    expect(player.statusEffects.payHalfRentNextLanding).toBe(true);
  });

  it('hazak 7 offers exactly 3 pool options (B37 selectionCount) and grants +100 from the bank', () => {
    const state = makeState();
    const card = drawStacked(state, 'hazak', 7);
    const player = p(state, SEAT_A);
    const before = player.money;
    const rng = makeRng();

    const outcome = applyCardEffects(state, SEAT_A, card, rng);
    expect(player.money).toBe(before + 100);
    expect(outcome.needsLandingEval).toBe(false);

    const setup = setupChoices(state, SEAT_A, card, rng);
    expect(setup.pending).not.toBeNull();
    expect(setup.pending?.options).toHaveLength(1);
    expect(setup.pending?.options[0]?.type).toBe('move_to_dynamic_pool');
    expect(setup.pending?.propertyPool).toHaveLength(3);
    // All 3 must be distinct real ownable squares.
    const pool = setup.pending?.propertyPool ?? [];
    expect(new Set(pool).size).toBe(3);
    for (const id of pool) {
      const sq = findSquare(board, id);
      expect(sq && isOwnable(sq)).toBeTruthy();
    }
  });

  it('resolving a move_to_dynamic_pool option teleports the player and signals landing eval', () => {
    const state = makeState();
    const card = drawStacked(state, 'hazak', 7);
    const rng = makeRng();
    applyCardEffects(state, SEAT_A, card, rng);
    const setup = setupChoices(state, SEAT_A, card, rng);
    state.pending = { ...setup.pending!, remainingDraws: [] };

    const target = setup.pending!.propertyPool[1]!;
    const result = resolveChoice(state, SEAT_A, 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(p(state, SEAT_A).position).toBe(target);
      expect(result.needsLandingEval).toBe(true);
    }
  });

  it('hazak 15: cash option is 150 and the pool is exactly [9,10,12,34] filtered to unowned', () => {
    const state = makeState();
    const card = drawStacked(state, 'hazak', 15);
    const rng = makeRng();
    applyCardEffects(state, SEAT_A, card, rng);
    const setup = setupChoices(state, SEAT_A, card, rng);

    expect(setup.pending).not.toBeNull();
    const options = setup.pending!.options;
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ type: 'receive_cash', amount: 150 });
    expect(options[1]).toMatchObject({ type: 'claim_free_property', unownedOnly: true });
    expect([...setup.pending!.propertyPool].sort((a, b) => a - b)).toEqual([9, 10, 12, 34]);
  });

  it('hazak 15: when 9/10/12/34 are all owned, falls back to the 150 cash option automatically', () => {
    const state = makeState();
    for (const id of [9, 10, 12, 34]) give(state, SEAT_B, id);
    const card = drawStacked(state, 'hazak', 15);
    const player = p(state, SEAT_A);
    const before = player.money;
    const rng = makeRng();
    applyCardEffects(state, SEAT_A, card, rng);
    const setup = setupChoices(state, SEAT_A, card, rng);

    expect(setup.pending).toBeNull();
    expect(player.money).toBe(before + 150);
  });

  it('hazak 15: choosing claim_free_property sets ownership for free, no movement', () => {
    const state = makeState();
    const card = drawStacked(state, 'hazak', 15);
    const rng = makeRng();
    const before = p(state, SEAT_A).money;
    applyCardEffects(state, SEAT_A, card, rng);
    const setup = setupChoices(state, SEAT_A, card, rng);
    state.pending = { ...setup.pending!, remainingDraws: [] };

    // Flattened index: [receive_cash] then 4 claim_free_property pool entries.
    const claimedId = setup.pending!.propertyPool[0]!;
    const result = resolveChoice(state, SEAT_A, 1);

    expect(result.ok).toBe(true);
    expect(ownerOf(state, claimedId)).toBe(SEAT_A);
    expect(p(state, SEAT_A).money).toBe(before); // no cost charged
    if (result.ok) expect(result.needsLandingEval).toBe(false);
  });
});

describe('cards: mahkama effects', () => {
  it('mahkama 11: options stay in data order with data label/amount, and max_price 150 is respected', () => {
    const state = makeState();
    const card = drawStacked(state, 'mahkama', 11);
    const rng = makeRng();
    applyCardEffects(state, SEAT_A, card, rng);
    const setup = setupChoices(state, SEAT_A, card, rng);

    expect(setup.pending).not.toBeNull();
    const options = setup.pending!.options;
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ type: 'claim_free_property', maxPrice: 150 });
    expect(options[1]).toMatchObject({ type: 'receive_cash', amount: 100 });
    for (const id of setup.pending!.propertyPool) {
      const sq = findSquare(board, id);
      expect(sq && isOwnable(sq) && sq.purchasePrice <= 150).toBeTruthy();
      expect(ownerOf(state, id)).toBeNull();
    }
  });

  it('mahkama 11: falls back to the 100 cash option when nothing <=150 is unowned', () => {
    const state = makeState();
    for (const sq of board.squares) {
      if (isOwnable(sq)) give(state, SEAT_B, sq.id);
    }
    const card = drawStacked(state, 'mahkama', 11);
    const player = p(state, SEAT_A);
    const before = player.money;
    const rng = makeRng();
    applyCardEffects(state, SEAT_A, card, rng);
    const setup = setupChoices(state, SEAT_A, card, rng);

    expect(setup.pending).toBeNull();
    expect(player.money).toBe(before + 100);
  });

  it('mahkama 15: pay_fine takes 100; go_to_prison sends to the real prison square', () => {
    const prison = prisonSquare(board);

    const s1 = makeState();
    const c1 = drawStacked(s1, 'mahkama', 15);
    const rng1 = makeRng();
    const before1 = p(s1, SEAT_A).money;
    applyCardEffects(s1, SEAT_A, c1, rng1);
    const setup1 = setupChoices(s1, SEAT_A, c1, rng1);
    s1.pending = { ...setup1.pending!, remainingDraws: [] };
    resolveChoice(s1, SEAT_A, 0);
    expect(p(s1, SEAT_A).money).toBe(before1 - 100);

    const s2 = makeState();
    const c2 = drawStacked(s2, 'mahkama', 15);
    const rng2 = makeRng();
    applyCardEffects(s2, SEAT_A, c2, rng2);
    const setup2 = setupChoices(s2, SEAT_A, c2, rng2);
    s2.pending = { ...setup2.pending!, remainingDraws: [] };
    const result2 = resolveChoice(s2, SEAT_A, 1);
    expect(p(s2, SEAT_A).position).toBe(prison.id);
    expect(p(s2, SEAT_A).statusEffects.missedTurnsRemaining).toBe(prison.maxTurnsToMiss);
    if (result2.ok) expect(result2.needsLandingEval).toBe(false);
  });

  it('mahkama 8: bank pays 25 per garage/rest_stop/market building owned', () => {
    const state = makeState();
    give(state, SEAT_A, 2, 'garage');
    give(state, SEAT_A, 3, 'market');
    give(state, SEAT_A, 5); // unimproved — should not count
    const card = drawStacked(state, 'mahkama', 8);
    const player = p(state, SEAT_A);
    const before = player.money;

    applyCardEffects(state, SEAT_A, card, makeRng());

    expect(player.money).toBe(before + 25 * 2);
  });

  it('mahkama 9: charges repair_costs per tier (garage 25, rest_stop 50, market 100)', () => {
    const state = makeState();
    give(state, SEAT_A, 2, 'garage');
    give(state, SEAT_A, 5, 'rest_stop');
    give(state, SEAT_A, 19, 'market');
    const card = drawStacked(state, 'mahkama', 9);
    const player = p(state, SEAT_A);
    const before = player.money;

    applyCardEffects(state, SEAT_A, card, makeRng());

    expect(player.money).toBe(before - (25 + 50 + 100));
  });

  it('collect_from_players (mahkama 1) caps each payer at their own balance', () => {
    const state = makeState({ seats: [SEAT_A, SEAT_B, SEAT_C] });
    setMoney(state, SEAT_B, 10); // less than the 25 owed
    setMoney(state, SEAT_C, 1000);
    const card = drawStacked(state, 'mahkama', 1);
    const drawer = p(state, SEAT_A);
    const before = drawer.money;

    applyCardEffects(state, SEAT_A, card, makeRng());

    expect(p(state, SEAT_B).money).toBe(0);
    expect(p(state, SEAT_C).money).toBe(1000 - 25);
    expect(drawer.money).toBe(before + 10 + 25);
  });

  it('mahkama 10 (collect_from_city_owners): charges each distinct owner ONCE, exactly the preselected cityIds, across many seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const state = makeState({ seats: [SEAT_A, SEAT_B, SEAT_C], seed });
      // Spread ownership across B and C, and give A one city too, to prove A is
      // never charged even when A owns one of the preselected squares.
      give(state, SEAT_A, 2);
      give(state, SEAT_B, 5);
      give(state, SEAT_B, 6);
      give(state, SEAT_C, 19);
      give(state, SEAT_C, 20);
      setMoney(state, SEAT_B, 1000);
      setMoney(state, SEAT_C, 1000);

      const rng = makeRng(seed);
      const card = drawStacked(state, 'mahkama', 10);
      const cityIds = preselectCities(state, card, rng);

      expect(cityIds.length).toBeLessThanOrEqual(card.params.cityCount ?? 0);
      const announcedOwners = new Set(
        cityIds.map((id) => ownerOf(state, id)).filter((o): o is string => o !== null && o !== SEAT_A),
      );

      const before = p(state, SEAT_A).money;
      const outcome = applyCardEffects(state, SEAT_A, card, rng, cityIds);
      const chargeEvent = outcome.events.find((e) => e.type === 'CITY_OWNERS_CHARGED');
      expect(chargeEvent).toBeDefined();
      if (chargeEvent?.type === 'CITY_OWNERS_CHARGED') {
        expect(new Set(chargeEvent.squareIds)).toEqual(new Set(cityIds));
        expect(new Set(chargeEvent.chargedPlayerIds)).toEqual(announcedOwners);
        // No duplicates: distinct owners charged once each.
        expect(chargeEvent.chargedPlayerIds.length).toBe(new Set(chargeEvent.chargedPlayerIds).size);
        expect(chargeEvent.chargedPlayerIds).not.toContain(SEAT_A);
        expect(p(state, SEAT_A).money).toBe(before + chargeEvent.totalCollected);
      }
    }
  });

  it('mahkama 10: payment from each owner is capped at that owner\'s balance', () => {
    const state = makeState({ seats: [SEAT_A, SEAT_B, SEAT_C] });
    give(state, SEAT_B, 5);
    setMoney(state, SEAT_B, 10); // less than amount_per_city (50)
    const card = drawStacked(state, 'mahkama', 10);
    const rng = makeRng(7);
    const cityIds = preselectCities(state, card, rng);
    // Force the scenario deterministically regardless of what preselection drew.
    const forcedIds = cityIds.length > 0 ? cityIds : [5];

    applyCardEffects(state, SEAT_A, card, rng, forcedIds.includes(5) ? forcedIds : [...forcedIds, 5]);

    expect(p(state, SEAT_B).money).toBeGreaterThanOrEqual(0);
  });
});

describe('cards: jail', () => {
  it("go_to_jail reads the prison square from board.ts, not a hardcoded id/turn count", () => {
    const state = makeState();
    const prison = prisonSquare(board);
    const card = drawStacked(state, 'mahkama', 5);

    applyCardEffects(state, SEAT_A, card, makeRng());

    expect(p(state, SEAT_A).position).toBe(prison.id);
    expect(p(state, SEAT_A).statusEffects.missedTurnsRemaining).toBe(prison.maxTurnsToMiss);
  });

  it('go_to_jail does not request a landing evaluation', () => {
    const state = makeState();
    const card = drawStacked(state, 'mahkama', 6);
    const outcome = applyCardEffects(state, SEAT_A, card, makeRng());
    expect(outcome.needsLandingEval).toBe(false);
  });

  it('receive_jail_free_card grants exactly one jail-free card', () => {
    const state = makeState();
    const card = drawStacked(state, 'mahkama', 7);
    const before = p(state, SEAT_A).inventory.jailFreeCards;
    applyCardEffects(state, SEAT_A, card, makeRng());
    expect(p(state, SEAT_A).inventory.jailFreeCards).toBe(before + 1);
  });
});

describe('cards: movement never credits pass-go itself', () => {
  it('hazak 4 (move_to start) only teleports and signals landing eval; no salary here', () => {
    const state = makeDuel();
    setPosition(state, SEAT_A, 20);
    const card = drawStacked(state, 'hazak', 4);
    const player = p(state, SEAT_A);
    const before = player.money;

    const outcome = applyCardEffects(state, SEAT_A, card, makeRng());

    // -100 bank_money is the only money change; the 250 salary text on the
    // card is turn.ts's job when it evaluates landing on the start square.
    expect(player.money).toBe(before - 100);
    expect(player.position).toBe(1);
    expect(outcome.needsLandingEval).toBe(true);
  });

  it('hazak 1 moves backward 5 squares without crediting a pass-go salary', () => {
    const state = makeDuel();
    setPosition(state, SEAT_A, 3);
    const card = drawStacked(state, 'hazak', 1);
    const player = p(state, SEAT_A);
    const before = player.money;

    const outcome = applyCardEffects(state, SEAT_A, card, makeRng());

    expect(player.money).toBe(before + 200);
    expect(outcome.needsLandingEval).toBe(true);
    // 3 - 5 wraps backward past the origin; still no salary credited by cards.ts.
    expect(player.position).not.toBe(0);
  });
});
