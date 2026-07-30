/**
 * Card normalisation and deck mechanics.
 *
 * Three data-fidelity bugs are fixed here, at the boundary, once:
 *
 *   B36  `"half price"` (the real key, with a space) is read correctly. The old
 *        server read `card.half_price` and so the half-rent card NEVER fired.
 *   B37  `unowned_only` and `selection_count` are honoured on the dynamic pool
 *        card instead of being ignored.
 *   B38  choice `label` and `amount` come from the data instead of being
 *        hardcoded, and options keep DATA order instead of being reordered.
 *
 * B07 is fixed structurally: a `Card` knows which deck it came from, and
 * `discard()` derives the target pile from `card.deck`. There is no deckType
 * parameter left to pass wrongly. The old code read the pile from
 * `gs.blindCard?.deckType` AFTER blindCard had been nulled, so every Mahkama card
 * was discarded onto the Hazak pile and the two decks cross-contaminated.
 */

import hazakJson from '../../data/hazak.json' with { type: 'json' };
import mahkamaJson from '../../data/mahkama.json' with { type: 'json' };
import type {
  RawCard,
  RawChoice,
  RawHazakCard,
  RawHazakDeck,
  RawMahkamaCard,
  RawMahkamaDeck,
} from '../shared/raw.js';
import type { Card, CardEffects, CardParams, Choice, DeckState, DeckType, UpgradeTier } from '../shared/types.js';
import type { Rng } from './rng.js';

export class CardDataError extends Error {}

function isMahkama(raw: RawCard): raw is RawMahkamaCard {
  return 'action' in raw && typeof raw.action === 'string';
}

function normaliseChoice(raw: RawChoice): Choice | null {
  // hazak card 14 carries `choices: [{}]` — a single empty object. Presence of
  // action_type is the real signal, so optionless entries are dropped.
  if (raw.action_type === undefined) return null;

  const label = raw.label;
  const withLabel = <T extends object>(o: T): T & { label?: string } =>
    label === undefined ? o : { ...o, label };

  switch (raw.action_type) {
    case 'receive_cash':
      if (raw.amount === undefined) throw new CardDataError('receive_cash choice has no amount.');
      return withLabel({ type: 'receive_cash' as const, amount: raw.amount });
    case 'pay_fine':
      if (raw.amount === undefined) throw new CardDataError('pay_fine choice has no amount.');
      return withLabel({ type: 'pay_fine' as const, amount: raw.amount });
    case 'go_to_prison':
      return withLabel({ type: 'go_to_prison' as const });
    case 'claim_free_property': {
      const base: Choice = {
        type: 'claim_free_property',
        // Absent means "no restriction"; only card 15 sets it true.
        unownedOnly: raw.unowned_only === true,
        ...(raw.max_price === undefined ? {} : { maxPrice: raw.max_price }),
        ...(raw.pool_options === undefined ? {} : { poolOptions: [...raw.pool_options] }),
      };
      return withLabel(base);
    }
    case 'move_to_dynamic_pool':
      return withLabel({
        type: 'move_to_dynamic_pool' as const,
        selectionCount: raw.selection_count ?? 3,
        unownedOnly: raw.unowned_only === true,
      });
    default: {
      const never: never = raw.action_type;
      throw new CardDataError(`Unknown choice action_type: ${String(never)}`);
    }
  }
}

function normaliseEffects(raw: RawCard): CardEffects {
  const mahkama = isMahkama(raw);
  return {
    bankMoney: raw.bank_money,
    collectFromEachPlayer: raw.players_money,
    freeCards: raw.free_card,
    // Both decks spell the jail card differently; mahkama has an extra field.
    jailFreeCards: raw.no_prison_card + (mahkama ? raw.jail_free_card : 0),
    // B36: the key really is "half price", with a space. Only hazak card 14 has it.
    halfRentNextLanding: mahkama ? false : (raw as RawHazakCard)['half price'] === 1,
    moveTo: raw.move_to > 0 ? raw.move_to : null,
    squaresToMove: raw.squares_to_move,
    skipNextTurn: mahkama ? raw.skip_next_turn === 1 : false,
  };
}

function normaliseParams(raw: RawCard): CardParams {
  if (!isMahkama(raw)) return {};
  const params: CardParams = {};
  if (raw.per_building_amount !== undefined) params.perBuildingAmount = raw.per_building_amount;
  if (raw.amount_per_city !== undefined) params.amountPerCity = raw.amount_per_city;
  if (raw.city_count !== undefined) params.cityCount = raw.city_count;
  if (raw.repair_costs !== undefined) {
    const costs: Record<UpgradeTier, number> = {
      garage: raw.repair_costs.garage,
      rest_stop: raw.repair_costs.rest_stop,
      market: raw.repair_costs.market,
    };
    params.repairCosts = costs;
  }
  return params;
}

export function normaliseCard(raw: RawCard, deck: DeckType): Card {
  const choices = raw.choices
    .map(normaliseChoice)
    .filter((c): c is Choice => c !== null);
  return {
    id: raw.id,
    deck,
    description: raw.description,
    effects: normaliseEffects(raw),
    action: isMahkama(raw) ? raw.action : null,
    choices,
    params: normaliseParams(raw),
  };
}

export function loadCards(deck: DeckType): Card[] {
  if (deck === 'hazak') {
    const raw = hazakJson as unknown as RawHazakDeck;
    return raw.hazak.map((c) => normaliseCard(c, 'hazak'));
  }
  const raw = mahkamaJson as unknown as RawMahkamaDeck;
  return raw.mahkama.map((c) => normaliseCard(c, 'mahkama'));
}

export function createDecks(rng: Rng): Record<DeckType, DeckState> {
  return {
    hazak: { draw: rng.shuffle(loadCards('hazak')), discard: [] },
    mahkama: { draw: rng.shuffle(loadCards('mahkama')), discard: [] },
  };
}

/**
 * Draw from `deck`, reshuffling that deck's own discard pile when exhausted.
 * Returns null only when both draw and discard are empty for that deck.
 */
export function draw(decks: Record<DeckType, DeckState>, deck: DeckType, rng: Rng): Card | null {
  const pile = decks[deck];
  if (pile.draw.length === 0) {
    if (pile.discard.length === 0) return null;
    pile.draw = rng.shuffle(pile.discard.splice(0, pile.discard.length));
  }
  return pile.draw.pop() ?? null;
}

/**
 * Return a card to ITS OWN discard pile. The pile is derived from `card.deck`, so
 * a Mahkama card cannot land on the Hazak pile (bug B07). A mismatch would mean
 * the card was fabricated, so it throws rather than corrupting the decks quietly.
 */
export function discard(decks: Record<DeckType, DeckState>, card: Card): void {
  const pile = decks[card.deck];
  if (pile === undefined) throw new CardDataError(`Card ${card.id} has unknown deck "${card.deck}".`);
  pile.discard.push(card);
}

/** Total cards accounted for in a deck — invariant: constant for the whole game. */
export function deckTotal(decks: Record<DeckType, DeckState>, deck: DeckType): number {
  const pile = decks[deck];
  return pile.draw.length + pile.discard.length;
}

/** True when any card sits in the wrong pile. The soak test asserts this is false. */
export function hasCrossContamination(decks: Record<DeckType, DeckState>): boolean {
  for (const deck of ['hazak', 'mahkama'] as const) {
    const pile = decks[deck];
    if (pile.draw.some((c) => c.deck !== deck)) return true;
    if (pile.discard.some((c) => c.deck !== deck)) return true;
  }
  return false;
}
