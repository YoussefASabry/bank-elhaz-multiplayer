import { describe, it, expect } from 'vitest';
import {
  loadCards,
  createDecks,
  draw,
  discard,
  deckTotal,
  hasCrossContamination,
} from '../../src/engine/deck.js';
import { createRng } from '../../src/engine/rng.js';
import type { Card } from '../../src/shared/types.js';

const hazak = loadCards('hazak');
const mahkama = loadCards('mahkama');

function byId(cards: Card[], id: number): Card {
  const c = cards.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no card ${id}`);
  return c;
}

describe('card loading', () => {
  it('loads 15 cards per deck, each tagged with its own deck', () => {
    expect(hazak).toHaveLength(15);
    expect(mahkama).toHaveLength(15);
    expect(hazak.every((c) => c.deck === 'hazak')).toBe(true);
    expect(mahkama.every((c) => c.deck === 'mahkama')).toBe(true);
  });

  it('parses every card into a known shape', () => {
    for (const c of [...hazak, ...mahkama]) {
      expect(typeof c.description).toBe('string');
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.effects.bankMoney).toBe('number');
    }
  });

  it('gives hazak cards no action discriminator and mahkama cards one', () => {
    expect(hazak.every((c) => c.action === null)).toBe(true);
    expect(mahkama.every((c) => c.action !== null)).toBe(true);
  });
});

describe('B36 — the "half price" key (with a space) is read correctly', () => {
  it('sets halfRentNextLanding on hazak card 14', () => {
    // The old server read `card.half_price` (underscore), which is not a key that
    // exists in the data, so this card silently did nothing in multiplayer.
    expect(byId(hazak, 14).effects.halfRentNextLanding).toBe(true);
  });

  it('is the ONLY card that grants half rent', () => {
    const granting = [...hazak, ...mahkama].filter((c) => c.effects.halfRentNextLanding);
    expect(granting.map((c) => `${c.deck}#${c.id}`)).toEqual(['hazak#14']);
  });

  it('also carries its forward movement of 4', () => {
    expect(byId(hazak, 14).effects.squaresToMove).toBe(4);
  });

  it('drops the empty `choices: [{}]` entry that card 14 carries', () => {
    // A naive `choices.length > 0` check misfires on this card.
    expect(byId(hazak, 14).choices).toEqual([]);
  });
});

describe('B37 — dynamic pool fields are honoured', () => {
  it('reads selection_count and unowned_only from hazak card 7', () => {
    const choices = byId(hazak, 7).choices;
    expect(choices).toHaveLength(1);
    const c = choices[0];
    expect(c?.type).toBe('move_to_dynamic_pool');
    if (c?.type === 'move_to_dynamic_pool') {
      expect(c.selectionCount).toBe(3);
      // Data says false; the old engine ignored the field entirely and happened
      // to match by accident. Pinned so a future flip to true cannot no-op.
      expect(c.unownedOnly).toBe(false);
    }
  });

  it('also applies the unconditional +100 from that card', () => {
    expect(byId(hazak, 7).effects.bankMoney).toBe(100);
  });
});

describe('B38 — choice labels, amounts and ORDER come from the data', () => {
  it('keeps mahkama card 11 options in data order: claim_free_property then cash', () => {
    const c = byId(mahkama, 11);
    expect(c.choices.map((o) => o.type)).toEqual(['claim_free_property', 'receive_cash']);
  });

  it('reads the cash amount from the data rather than a hardcoded 100', () => {
    const cash = byId(mahkama, 11).choices.find((o) => o.type === 'receive_cash');
    expect(cash?.type).toBe('receive_cash');
    if (cash?.type === 'receive_cash') expect(cash.amount).toBe(100);
  });

  it('reads max_price for the free-property option', () => {
    const claim = byId(mahkama, 11).choices.find((o) => o.type === 'claim_free_property');
    if (claim?.type === 'claim_free_property') expect(claim.maxPrice).toBe(150);
  });

  it('carries the Arabic labels from the data', () => {
    for (const o of byId(mahkama, 11).choices) {
      expect(typeof o.label).toBe('string');
      expect((o.label ?? '').length).toBeGreaterThan(0);
    }
  });

  it('normalises mahkama card 15 to pay_fine / go_to_prison with its amount', () => {
    const c = byId(mahkama, 15);
    expect(c.choices.map((o) => o.type)).toEqual(['pay_fine', 'go_to_prison']);
    const fine = c.choices[0];
    if (fine?.type === 'pay_fine') expect(fine.amount).toBe(100);
  });

  it('normalises hazak card 15 to cash / claim with its pool and unownedOnly', () => {
    const c = byId(hazak, 15);
    expect(c.choices.map((o) => o.type)).toEqual(['receive_cash', 'claim_free_property']);
    const cash = c.choices[0];
    if (cash?.type === 'receive_cash') expect(cash.amount).toBe(150);
    const claim = c.choices[1];
    if (claim?.type === 'claim_free_property') {
      expect([...(claim.poolOptions ?? [])]).toEqual([9, 10, 12, 34]);
      expect(claim.unownedOnly).toBe(true);
    }
  });
});

describe('mahkama parameter blocks', () => {
  it('reads per_building_amount (card 8)', () => {
    expect(byId(mahkama, 8).params.perBuildingAmount).toBeTypeOf('number');
  });
  it('reads repair_costs (card 9)', () => {
    const costs = byId(mahkama, 9).params.repairCosts;
    expect(costs).toBeDefined();
    expect(Object.keys(costs ?? {}).sort()).toEqual(['garage', 'market', 'rest_stop']);
  });
  it('reads amount_per_city and city_count (card 10)', () => {
    const p = byId(mahkama, 10).params;
    expect(p.amountPerCity).toBeTypeOf('number');
    expect(p.cityCount).toBeTypeOf('number');
  });
});

describe('B07 — decks cannot cross-contaminate', () => {
  it('routes a discard to the pile named by the card itself', () => {
    const decks = createDecks(createRng(1));
    const card = draw(decks, 'mahkama', createRng(2));
    expect(card).not.toBeNull();
    if (card === null) return;
    discard(decks, card);
    expect(decks.mahkama.discard).toHaveLength(1);
    expect(decks.hazak.discard).toHaveLength(0);
  });

  it('keeps the hazak pile untouched while the whole mahkama deck cycles', () => {
    const rng = createRng(7);
    const decks = createDecks(rng);
    const hazakBefore = deckTotal(decks, 'hazak');
    for (let i = 0; i < 15; i++) {
      const c = draw(decks, 'mahkama', rng);
      expect(c?.deck).toBe('mahkama');
      if (c !== null) discard(decks, c);
    }
    expect(decks.hazak.discard).toHaveLength(0);
    expect(deckTotal(decks, 'hazak')).toBe(hazakBefore);
    expect(deckTotal(decks, 'mahkama')).toBe(15);
    expect(hasCrossContamination(decks)).toBe(false);
  });

  it('conserves each deck at 15 cards across many draw/discard cycles', () => {
    const rng = createRng(11);
    const decks = createDecks(rng);
    for (let i = 0; i < 200; i++) {
      const deck = i % 2 === 0 ? 'hazak' : 'mahkama';
      const c = draw(decks, deck, rng);
      if (c !== null) discard(decks, c);
      expect(deckTotal(decks, 'hazak')).toBe(15);
      expect(deckTotal(decks, 'mahkama')).toBe(15);
    }
    expect(hasCrossContamination(decks)).toBe(false);
  });

  it('throws when handed a card claiming an unknown deck', () => {
    const decks = createDecks(createRng(1));
    const bogus = { ...(hazak[0] as Card), deck: 'nope' as unknown as 'hazak' };
    expect(() => discard(decks, bogus)).toThrow();
  });
});

describe('reshuffling', () => {
  it('reshuffles from its OWN discard pile when the draw pile empties', () => {
    const rng = createRng(3);
    const decks = createDecks(rng);
    const drawn: Card[] = [];
    for (let i = 0; i < 15; i++) {
      const c = draw(decks, 'hazak', rng);
      if (c !== null) drawn.push(c);
    }
    expect(drawn).toHaveLength(15);
    expect(decks.hazak.draw).toHaveLength(0);
    for (const c of drawn) discard(decks, c);
    const next = draw(decks, 'hazak', rng);
    expect(next).not.toBeNull();
    expect(next?.deck).toBe('hazak');
    expect(decks.hazak.draw).toHaveLength(14);
  });

  it('returns null only when both piles are empty for that deck', () => {
    const rng = createRng(5);
    const decks = createDecks(rng);
    decks.hazak.draw = [];
    decks.hazak.discard = [];
    expect(draw(decks, 'hazak', rng)).toBeNull();
    // The other deck is unaffected.
    expect(draw(decks, 'mahkama', rng)).not.toBeNull();
  });
});
