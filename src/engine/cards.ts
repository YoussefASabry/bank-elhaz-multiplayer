/**
 * Card resolution: Mahkama (المحكمة) and Hazak (حظك) effects, choices and the
 * B08 pre-selected city-owner charge.
 *
 * ARCHITECTURAL BOUNDARY: this module does not import property.ts or turn.ts.
 * When a card moves a player onto a new square, it SETS the position and
 * reports `needsLandingEval: true`; turn.ts is the one that then evaluates
 * whatever is on that square (buy prompt, rent, corner effect). Landing is
 * never evaluated here, and pass-go salary is never credited here — turn.ts
 * owns that (bug B04), we only ever move and signal.
 *
 * Bugs fixed here:
 *
 *   B08  `collect_from_city_owners` (mahkama 10). The three cities are chosen
 *        ONCE, at draw time, via `preselectCities`, and the caller stores the
 *        result on the `blind_card` Pending's `cityIds`. Resolution (in
 *        `applyCardEffects`) is handed those SAME ids back and charges
 *        exactly them. The old server re-randomised at resolve time because
 *        it had already nulled `blindCard`, so the cities actually charged
 *        differed from the cities shown on the card. Each distinct OWNER is
 *        charged once (a `Set`), the drawing player is never charged even if
 *        they happen to own one of the selected cities, and every payment is
 *        capped at that owner's money (`transfer`).
 *   B10  square 4 (دائرة مشتركة) draws mahkama then hazak. This module does
 *        not decide the draw order — that is turn.ts / board.ts's
 *        `DualDeckSquare.draws` — but every result here carries through
 *        whatever `remainingDraws` the caller threads in, rather than
 *        assuming a card is always the last one.
 *   B36  (fixed upstream in deck.ts) — this module's job is only to READ
 *        `card.effects.halfRentNextLanding` and set
 *        `player.statusEffects.payHalfRentNextLanding`. It is OR'd in rather
 *        than assigned, so an unrelated card drawn before the flag is
 *        consumed can never clobber it back to false.
 *   B37  `move_to_dynamic_pool` honours `unownedOnly` and `selectionCount`
 *        from the data (see `resolveDynamicPool`) instead of a hardcoded 3
 *        drawn from anywhere.
 *   B38  choice labels/amounts/max prices come from the data
 *        (`Choice.label`/`amount`/`maxPrice`) and `options` keeps DATA ORDER —
 *        nothing here re-sorts or re-labels a choice.
 *
 * Empty-pool fallback (hazak 15 / mahkama 11): when the resolved property
 * pool for a `claim_free_property` choice comes back empty, `setupChoices`
 * does not offer a choice with one dead branch — it silently resolves the
 * sibling `receive_cash` option instead.
 */

import { advance, isOwnable, findSquare, prisonSquare, teleport } from './board.js';
import { discard } from './deck.js';
import { activePlayers, credit, debit, ownerOf, requirePlayer, setOwner, transfer } from './state.js';
import type { DomainEvent, RejectReason } from '../shared/actions.js';
import type {
  Card,
  Choice,
  GameState,
  Pending,
  SeatId,
  SquareId,
  UpgradeTier,
} from '../shared/types.js';
import type { Rng } from './rng.js';

type CardChoicePending = Extract<Pending, { kind: 'card_choice' }>;

export interface CardOutcome {
  state: GameState;
  events: DomainEvent[];
  /** True when the player's new position needs turn.ts to evaluate landing. */
  needsLandingEval: boolean;
}

export interface SetupChoicesResult {
  state: GameState;
  events: DomainEvent[];
  /**
   * The `card_choice` Pending to install, or null when the card is already
   * fully resolved (no choices at all, or the empty-pool fallback fired).
   *
   * `remainingDraws` is a placeholder ([]) here — setupChoices has no
   * knowledge of the originating `blind_card`'s queue. The caller (turn.ts)
   * must copy the real `remainingDraws` from that Pending onto whatever it
   * installs as the new `card_choice` Pending.
   */
  pending: CardChoicePending | null;
}

export type ChoiceResult =
  | ({ ok: true } & CardOutcome)
  | { ok: false; reason: RejectReason };

function moneyEvent(playerId: SeatId, delta: number, balance: number, reason: string): DomainEvent {
  return { type: 'MONEY_CHANGED', playerId, delta, balance, reason };
}

function cardResolvedEvent(playerId: SeatId, card: Card): DomainEvent {
  return { type: 'CARD_RESOLVED', playerId, deck: card.deck, cardId: card.id, description: card.description };
}

/** Squares this seat owns with a tier built, for the two per-building mahkama cards. */
function ownedUpgradedSquares(state: GameState, seatId: SeatId): Array<{ squareId: SquareId; tier: UpgradeTier }> {
  const result: Array<{ squareId: SquareId; tier: UpgradeTier }> = [];
  for (const sq of state.board.squares) {
    if (!isOwnable(sq)) continue;
    const rec = state.ownership[sq.id];
    if (rec !== undefined && rec.owner === seatId && rec.upgrade !== null) {
      result.push({ squareId: sq.id, tier: rec.upgrade });
    }
  }
  return result;
}

/**
 * Cities pre-selected for `collect_from_city_owners`, computed ONCE at draw
 * time (bug B08). Candidates are OWNED ownable squares, board-wide — ownership
 * (and thus who ends up charged) is decided later, at resolution, from these
 * SAME ids.
 */
export function preselectCities(state: GameState, card: Card, rng: Rng): readonly SquareId[] {
  if (card.action !== 'collect_from_city_owners') return [];
  const count = card.params.cityCount ?? 0;
  const candidates = state.board.squares
    .filter(isOwnable)
    .filter((sq) => ownerOf(state, sq.id) !== null)
    .map((sq) => sq.id);
  return rng.shuffle(candidates).slice(0, count);
}

/**
 * Unconditional effects — the part of a card that always applies, before any
 * choice is offered. `cityIds` must be the SAME ids `preselectCities` produced
 * at draw time; only read when `card.action === 'collect_from_city_owners'`.
 */
export function applyCardEffects(
  state: GameState,
  seatId: SeatId,
  card: Card,
  rng: Rng,
  cityIds: readonly SquareId[] = [],
): CardOutcome {
  void rng; // reserved for callers that need it symmetrically with setupChoices
  const player = requirePlayer(state, seatId);
  const events: DomainEvent[] = [];

  // ── Money / status, generic to both decks ──
  if (card.effects.bankMoney > 0) {
    credit(player, card.effects.bankMoney);
    events.push(moneyEvent(seatId, card.effects.bankMoney, player.money, 'card_bank_money'));
  } else if (card.effects.bankMoney < 0) {
    debit(player, -card.effects.bankMoney);
    events.push(moneyEvent(seatId, card.effects.bankMoney, player.money, 'card_bank_money'));
  }

  if (card.effects.collectFromEachPlayer > 0) {
    for (const other of activePlayers(state)) {
      if (other.id === seatId) continue;
      const paid = transfer(other, player, card.effects.collectFromEachPlayer);
      if (paid > 0) {
        events.push(moneyEvent(other.id, -paid, other.money, 'card_collect_from_players'));
        events.push(moneyEvent(seatId, paid, player.money, 'card_collect_from_players'));
      }
    }
  }

  if (card.effects.freeCards !== 0) player.inventory.freeCards += card.effects.freeCards;
  if (card.effects.jailFreeCards !== 0) player.inventory.jailFreeCards += card.effects.jailFreeCards;
  // B36: OR'd in, never cleared here, so an unconsumed flag from another card survives.
  if (card.effects.halfRentNextLanding) player.statusEffects.payHalfRentNextLanding = true;
  if (card.effects.skipNextTurn) player.statusEffects.skipNextTurn = true;

  // ── Movement / jail ──
  let needsLandingEval = false;
  if (card.action === 'go_to_jail') {
    // Ignore the raw move_to (data hardcodes 25); read the real prison square.
    const prison = prisonSquare(state.board);
    player.position = prison.id;
    player.statusEffects.missedTurnsRemaining = prison.maxTurnsToMiss;
    events.push({ type: 'JAILED', playerId: seatId, turnsToMiss: prison.maxTurnsToMiss });
    // Deliberately no needsLandingEval: being sent to jail is not a landing.
  } else if (card.effects.moveTo !== null) {
    const from = player.position;
    player.position = teleport(state.board, card.effects.moveTo);
    needsLandingEval = true;
    events.push({ type: 'MOVED', playerId: seatId, from, to: player.position, teleported: true });
  } else if (card.effects.squaresToMove !== 0) {
    const from = player.position;
    const result = advance(state.board, from, card.effects.squaresToMove);
    player.position = result.to;
    needsLandingEval = true;
    events.push({ type: 'MOVED', playerId: seatId, from, to: result.to, teleported: false });
  }

  // ── Mahkama actions not already covered by the generic effects above ──
  switch (card.action) {
    case 'bank_pays_per_building': {
      const count = ownedUpgradedSquares(state, seatId).length;
      const amount = (card.params.perBuildingAmount ?? 0) * count;
      if (amount > 0) {
        credit(player, amount);
        events.push(moneyEvent(seatId, amount, player.money, 'card_bank_pays_per_building'));
      }
      break;
    }
    case 'pay_repairs': {
      const costs = card.params.repairCosts;
      if (costs !== undefined) {
        let total = 0;
        for (const { tier } of ownedUpgradedSquares(state, seatId)) total += costs[tier];
        if (total > 0) {
          debit(player, total);
          events.push(moneyEvent(seatId, -total, player.money, 'card_pay_repairs'));
        }
      }
      break;
    }
    case 'collect_from_city_owners': {
      const amountPerCity = card.params.amountPerCity ?? 0;
      const ownerIds = new Set<SeatId>();
      for (const squareId of cityIds) {
        const owner = ownerOf(state, squareId);
        if (owner !== null && owner !== seatId) ownerIds.add(owner);
      }
      const chargedPlayerIds: SeatId[] = [];
      let totalCollected = 0;
      for (const ownerId of ownerIds) {
        const ownerPlayer = requirePlayer(state, ownerId);
        const paid = transfer(ownerPlayer, player, amountPerCity);
        chargedPlayerIds.push(ownerId);
        totalCollected += paid;
        if (paid > 0) events.push(moneyEvent(ownerId, -paid, ownerPlayer.money, 'card_city_owners_charged'));
      }
      if (totalCollected > 0) events.push(moneyEvent(seatId, totalCollected, player.money, 'card_city_owners_charged'));
      events.push({
        type: 'CITY_OWNERS_CHARGED',
        playerId: seatId,
        squareIds: cityIds,
        chargedPlayerIds,
        totalCollected,
      });
      break;
    }
    default:
      break;
  }

  return { state, events, needsLandingEval };
}

/** claim_free_property is always for an UNOWNED square, regardless of `unownedOnly`. */
function resolveClaimPool(state: GameState, choice: Extract<Choice, { type: 'claim_free_property' }>): SquareId[] {
  const candidateIds =
    choice.poolOptions !== undefined
      ? choice.poolOptions
      : state.board.squares.filter(isOwnable).map((sq) => sq.id);
  return candidateIds.filter((id) => {
    if (ownerOf(state, id) !== null) return false;
    if (choice.maxPrice !== undefined) {
      const sq = findSquare(state.board, id);
      if (sq === undefined || !isOwnable(sq) || sq.purchasePrice > choice.maxPrice) return false;
    }
    return true;
  });
}

/** B37: honour selectionCount and unownedOnly instead of a hardcoded 3 / any square. */
function resolveDynamicPool(
  state: GameState,
  choice: Extract<Choice, { type: 'move_to_dynamic_pool' }>,
  rng: Rng,
): SquareId[] {
  let candidates = state.board.squares.filter(isOwnable).map((sq) => sq.id);
  if (choice.unownedOnly) candidates = candidates.filter((id) => ownerOf(state, id) === null);
  return rng.shuffle(candidates).slice(0, choice.selectionCount);
}

/**
 * Build the `card_choice` Pending for a card's `choices`, or resolve it away
 * entirely when there is nothing to choose (no choices at all, or the
 * empty-pool fallback below).
 */
export function setupChoices(state: GameState, seatId: SeatId, card: Card, rng: Rng): SetupChoicesResult {
  const events: DomainEvent[] = [];

  if (card.choices.length === 0) {
    discard(state.decks, card);
    events.push(cardResolvedEvent(seatId, card));
    return { state, events, pending: null };
  }

  // At most one choice in this data needs a resolved property pool.
  let propertyPool: SquareId[] = [];
  for (const choice of card.choices) {
    if (choice.type === 'claim_free_property') propertyPool = resolveClaimPool(state, choice);
    else if (choice.type === 'move_to_dynamic_pool') propertyPool = resolveDynamicPool(state, choice, rng);
  }

  const hasPoolChoice = card.choices.some(
    (c) => c.type === 'claim_free_property' || c.type === 'move_to_dynamic_pool',
  );
  const cashChoice = card.choices.find(
    (c): c is Extract<Choice, { type: 'receive_cash' }> => c.type === 'receive_cash',
  );

  // Empty-pool fallback (hazak 15 / mahkama 11): don't offer a dead branch.
  if (hasPoolChoice && propertyPool.length === 0 && cashChoice !== undefined) {
    discard(state.decks, card);
    const player = requirePlayer(state, seatId);
    credit(player, cashChoice.amount);
    events.push(moneyEvent(seatId, cashChoice.amount, player.money, 'card_choice_fallback'));
    events.push(cardResolvedEvent(seatId, card));
    return { state, events, pending: null };
  }

  // No sibling to fall back to and nothing claimable — resolve as a no-op
  // rather than present a choice with zero live options.
  if (hasPoolChoice && propertyPool.length === 0 && card.choices.length === 1) {
    discard(state.decks, card);
    events.push(cardResolvedEvent(seatId, card));
    return { state, events, pending: null };
  }

  const pending: CardChoicePending = {
    kind: 'card_choice',
    playerId: seatId,
    card,
    title: card.description,
    options: card.choices,
    propertyPool,
    remainingDraws: [],
  };
  return { state, events, pending };
}

interface FlatOption {
  choice: Choice;
  squareId?: SquareId;
}

/**
 * `options` (data order, B38) with the single pool-bearing choice (if any)
 * expanded into one entry per resolved property — that expanded list is what
 * `resolveChoice`'s `index` refers to, matching one button per offered city.
 */
function flattenChoiceOptions(options: readonly Choice[], propertyPool: readonly SquareId[]): FlatOption[] {
  const flat: FlatOption[] = [];
  for (const choice of options) {
    if (choice.type === 'claim_free_property' || choice.type === 'move_to_dynamic_pool') {
      for (const squareId of propertyPool) flat.push({ choice, squareId });
    } else {
      flat.push({ choice });
    }
  }
  return flat;
}

/** Apply the option at `index` in the current `card_choice` Pending. */
export function resolveChoice(state: GameState, seatId: SeatId, index: number): ChoiceResult {
  const pending = state.pending;
  if (pending.kind !== 'card_choice') return { ok: false, reason: 'wrong_phase' };
  if (pending.playerId !== seatId) return { ok: false, reason: 'not_the_entitled_player' };

  const flat = flattenChoiceOptions(pending.options, pending.propertyPool);
  const picked = flat[index];
  if (picked === undefined) return { ok: false, reason: 'no_such_choice' };

  const player = requirePlayer(state, seatId);
  const events: DomainEvent[] = [];
  let needsLandingEval = false;

  switch (picked.choice.type) {
    case 'receive_cash': {
      credit(player, picked.choice.amount);
      events.push(moneyEvent(seatId, picked.choice.amount, player.money, 'card_choice'));
      break;
    }
    case 'pay_fine': {
      debit(player, picked.choice.amount);
      events.push(moneyEvent(seatId, -picked.choice.amount, player.money, 'card_choice'));
      break;
    }
    case 'go_to_prison': {
      const prison = prisonSquare(state.board);
      player.position = prison.id;
      player.statusEffects.missedTurnsRemaining = prison.maxTurnsToMiss;
      events.push({ type: 'JAILED', playerId: seatId, turnsToMiss: prison.maxTurnsToMiss });
      break;
    }
    case 'claim_free_property': {
      if (picked.squareId !== undefined) setOwner(state, picked.squareId, seatId);
      break;
    }
    case 'move_to_dynamic_pool': {
      if (picked.squareId !== undefined) {
        const from = player.position;
        player.position = teleport(state.board, picked.squareId);
        needsLandingEval = true;
        events.push({ type: 'MOVED', playerId: seatId, from, to: player.position, teleported: true });
      }
      break;
    }
    default: {
      const never: never = picked.choice;
      throw new Error(`Unhandled choice type: ${JSON.stringify(never)}`);
    }
  }

  events.push(cardResolvedEvent(seatId, pending.card));
  discard(state.decks, pending.card);

  return { ok: true, state, events, needsLandingEval };
}
