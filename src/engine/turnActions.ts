/**
 * Action executors for the TURN-SCOPED action types — everything that drives the
 * current player's phase machine. The reducer (src/engine/index.ts) authorizes,
 * then dispatches here. This module NEVER re-authorizes; it assumes the actor is
 * entitled and enforces only domain rules (funds, ownership, jail state), each of
 * which is already gated by the underlying engine module.
 *
 * Split out of index.ts to stay under the 400-line ceiling. Phase-independent
 * actions (sells, trades, bids, system hooks, kick) live in peerActions.ts. No
 * `Math.random`/`Date.now` here — all randomness and time come through
 * `ReducerCtx`.
 */

import { resolveRoll, evaluateLanding, finishTurn, skipPrisonTurn, payBail, useJailFreeCard } from './turn.js';
import { applyCardEffects, preselectCities, setupChoices, resolveChoice } from './cards.js';
import {
  buyProperty,
  purchaseUpgrade,
} from './property.js';
import { checkInsolvency, declareBankruptcy } from './bankruptcy.js';
import { draw, deckTotal } from './deck.js';
import { credit, debit, playerById, requirePlayer } from './state.js';
import type { Action, DomainEvent, RejectReason } from '../shared/actions.js';
import type { GameState } from '../shared/types.js';
import { isActive } from '../shared/types.js';
import type { Rng } from './rng.js';

export interface ReducerCtx {
  rng: Rng;
  now: number;
}

export type ExecResult = { ok: true; events: DomainEvent[] } | { ok: false; reason: RejectReason };

// ── Turn ──

export function execRollDice(
  state: GameState,
  action: Extract<Action, { type: 'ROLL_DICE' }>,
  ctx: ReducerCtx,
): ExecResult {
  const result = resolveRoll(state, action.actorId, ctx.rng);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, events: result.events };
}

/** The player acknowledged where they rolled to; evaluate whatever is there. */
export function execConfirmLanding(
  state: GameState,
  action: Extract<Action, { type: 'CONFIRM_LANDING' }>,
): ExecResult {
  const events: DomainEvent[] = [];
  events.push(...evaluateLanding(state, action.actorId));
  events.push(...finishTurn(state));
  return { ok: true, events };
}

// ── Cards ──

/**
 * Pop one deck off the `deck_draw` pending's queue (square 4 enqueues
 * mahkama, then hazak — B10) and install the `blind_card` pending. Card
 * resolution happens on CONFIRM_CARD so the drawing player reads the card first.
 */
export function execDrawCard(
  state: GameState,
  action: Extract<Action, { type: 'DRAW_CARD' }>,
  ctx: ReducerCtx,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'deck_draw' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const deck = pending.queue[0];
  if (deck === undefined) {
    state.pending = { kind: 'none' };
    return { ok: true, events: finishTurn(state) };
  }
  if (deck !== action.deck) {
    return { ok: false, reason: 'deck_mismatch' };
  }

  const totalCards = deckTotal(state.decks, deck);
  const card = draw(state.decks, deck, ctx.rng);
  if (card === null) {
    // Defensive: the entire deck is somehow in flight. Skip rather than freeze
    // the phase — mirrors the legacy drawCard's `finishTurn()` on a null draw.
    state.pending = { kind: 'none' };
    return { ok: true, events: finishTurn(state) };
  }

  const cityIds = preselectCities(state, card, ctx.rng);
  const cardNumber = state.decks[deck].discard.length + 1;
  const events: DomainEvent[] = [
    { type: 'CARD_DRAWN', playerId: action.actorId, deck, cardId: card.id, cardNumber, totalCards },
  ];

  state.pending = {
    kind: 'blind_card',
    playerId: action.actorId,
    card,
    cardNumber,
    totalCards,
    ...(cityIds.length > 0 ? { cityIds } : {}),
    remainingDraws: pending.queue.slice(1),
    squareName: pending.squareName,
  };
  events.push(...finishTurn(state));
  return { ok: true, events };
}

/**
 * The drawing player confirms they have read the card: apply the unconditional
 * effects, then either present the choice dialog (deferring any landing
 * evaluation until the choice is made, since a `move_to_dynamic_pool` choice
 * moves them) or evaluate the landing immediately.
 */
export function execConfirmCard(
  state: GameState,
  action: Extract<Action, { type: 'CONFIRM_CARD' }>,
  ctx: ReducerCtx,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'blind_card' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const events: DomainEvent[] = [];
  const outcome = applyCardEffects(state, action.actorId, pending.card, ctx.rng, pending.cityIds);
  events.push(...outcome.events);

  const setup = setupChoices(state, action.actorId, pending.card, ctx.rng);
  events.push(...setup.events);

  if (setup.pending !== null) {
    // The card_choice pending loses the originating queue in setupChoices
    // (known debt) — copy it across so square 4's second card still fires.
    state.pending = {
      ...setup.pending,
      remainingDraws: pending.remainingDraws,
      squareName: pending.squareName,
    };
  } else if (pending.remainingDraws.length > 0) {
    // No choice to present, but square 4 still owes a second draw (B10).
    state.pending = {
      kind: 'deck_draw',
      playerId: action.actorId,
      queue: pending.remainingDraws,
      squareName: pending.squareName,
    };
  } else {
    state.pending = { kind: 'none' };
    if (outcome.needsLandingEval) events.push(...evaluateLanding(state, action.actorId));
  }
  events.push(...finishTurn(state));
  return { ok: true, events };
}

/** `index` counts into the FLATTENED option list — see HANDOFF §6. */
export function execChooseCardOption(
  state: GameState,
  action: Extract<Action, { type: 'CHOOSE_CARD_OPTION' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'card_choice' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const result = resolveChoice(state, action.actorId, action.index);
  if (!result.ok) return { ok: false, reason: result.reason };

  const events: DomainEvent[] = [...result.events];
  if (pending.remainingDraws.length > 0) {
    // Square 4 still owes its second draw (B10) — the choice is resolved but
    // the player stays parked in draw_card for the next pile.
    state.pending = {
      kind: 'deck_draw',
      playerId: action.actorId,
      queue: pending.remainingDraws,
      squareName: pending.squareName,
    };
  } else {
    state.pending = { kind: 'none' };
    if (result.needsLandingEval) events.push(...evaluateLanding(state, action.actorId));
  }
  events.push(...finishTurn(state));
  return { ok: true, events };
}

// ── Club corner ──

export function execChooseClub(
  state: GameState,
  action: Extract<Action, { type: 'CHOOSE_CLUB' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'club' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const player = requirePlayer(state, action.actorId);
  const events: DomainEvent[] = [];

  if (action.choice === 'membership') {
    if (player.money < pending.membershipCost) return { ok: false, reason: 'insufficient_funds' };
    debit(player, pending.membershipCost);
    player.isClubMember = true;
    events.push({ type: 'CLUB_RESOLVED', playerId: action.actorId, choice: 'membership', cost: pending.membershipCost });
    events.push({
      type: 'MONEY_CHANGED',
      playerId: action.actorId,
      delta: -pending.membershipCost,
      balance: player.money,
      reason: 'club_membership',
    });
  } else {
    debit(player, pending.guestFineFee);
    events.push({ type: 'CLUB_RESOLVED', playerId: action.actorId, choice: 'guest', cost: pending.guestFineFee });
    events.push({
      type: 'MONEY_CHANGED',
      playerId: action.actorId,
      delta: -pending.guestFineFee,
      balance: player.money,
      reason: 'club_guest_fine',
    });
    events.push(...checkInsolvency(state, action.actorId));
  }

  state.pending = { kind: 'none' };
  events.push(...finishTurn(state));
  return { ok: true, events };
}

// ── Property ──

export function execResolvePropertyBuy(
  state: GameState,
  action: Extract<Action, { type: 'RESOLVE_PROPERTY_BUY' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'property_buy' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const events: DomainEvent[] = [];
  if (action.buy) {
    const result = buyProperty(state, action.actorId, pending.squareId);
    if (!result.ok) return { ok: false, reason: result.reason };
    const player = requirePlayer(state, action.actorId);
    events.push({ type: 'PROPERTY_BOUGHT', playerId: action.actorId, squareId: pending.squareId, price: result.price });
    events.push({
      type: 'MONEY_CHANGED',
      playerId: action.actorId,
      delta: -result.price,
      balance: player.money,
      reason: 'buy_property',
    });
  } else {
    events.push({ type: 'PROPERTY_DECLINED', playerId: action.actorId, squareId: pending.squareId });
  }

  state.pending = { kind: 'none' };
  events.push(...finishTurn(state));
  return { ok: true, events };
}

/**
 * Rent is an UNCONDITIONAL debit (the payer may go negative) — unlike the capped
 * `transfer` used for optional payments — so a player who cannot cover rent goes
 * negative and is settled by the single bankruptcy model (B21). The owner is
 * credited only while still active (they may have been kicked or gone bankrupt
 * while the debt was pending).
 */
export function execPayRent(
  state: GameState,
  action: Extract<Action, { type: 'PAY_RENT' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'rent' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const payer = requirePlayer(state, action.actorId);
  const owner = pending.ownerId !== null ? playerById(state, pending.ownerId) : undefined;
  const events: DomainEvent[] = [];

  debit(payer, pending.amount);
  events.push({
    type: 'MONEY_CHANGED',
    playerId: action.actorId,
    delta: -pending.amount,
    balance: payer.money,
    reason: 'rent',
  });
  if (owner !== undefined && owner.id !== action.actorId && isActive(owner)) {
    credit(owner, pending.amount);
    events.push({
      type: 'MONEY_CHANGED',
      playerId: owner.id,
      delta: pending.amount,
      balance: owner.money,
      reason: 'rent',
    });
  }
  events.push({ type: 'RENT_PAID', playerId: action.actorId, ownerId: pending.ownerId, amount: pending.amount });
  events.push(...checkInsolvency(state, action.actorId));

  state.pending = { kind: 'none' };
  events.push(...finishTurn(state));
  return { ok: true, events };
}

export function execBuyUpgrade(
  state: GameState,
  action: Extract<Action, { type: 'BUY_UPGRADE' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'upgrade' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }

  const result = purchaseUpgrade(state, action.actorId, pending.squareId, action.tier);
  if (!result.ok) return { ok: false, reason: result.reason };
  const player = requirePlayer(state, action.actorId);

  const events: DomainEvent[] = [
    { type: 'UPGRADE_BUILT', playerId: action.actorId, squareId: pending.squareId, tier: result.tier, cost: result.cost },
    {
      type: 'MONEY_CHANGED',
      playerId: action.actorId,
      delta: -result.cost,
      balance: player.money,
      reason: 'buy_upgrade',
    },
  ];
  state.pending = { kind: 'none' };
  events.push(...finishTurn(state));
  return { ok: true, events };
}

export function execSkipUpgrade(
  state: GameState,
  action: Extract<Action, { type: 'SKIP_UPGRADE' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'upgrade' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }
  state.pending = { kind: 'none' };
  return { ok: true, events: finishTurn(state) };
}

// ── Prison (phase 'roll', jailed current player) ──

export function execSkipPrisonTurn(
  state: GameState,
  action: Extract<Action, { type: 'SKIP_PRISON_TURN' }>,
): ExecResult {
  const result = skipPrisonTurn(state, action.actorId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, events: result.events };
}

export function execPayBail(
  state: GameState,
  action: Extract<Action, { type: 'PAY_BAIL' }>,
): ExecResult {
  const result = payBail(state, action.actorId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, events: result.events };
}

export function execUseJailFree(
  state: GameState,
  action: Extract<Action, { type: 'USE_JAIL_FREE' }>,
): ExecResult {
  const result = useJailFreeCard(state, action.actorId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, events: result.events };
}

// ── Insolvency ──

/** The player admits they cannot cover the rent owed and declares bankruptcy. */
export function execDeclareBankrupt(
  state: GameState,
  action: Extract<Action, { type: 'DECLARE_BANKRUPT' }>,
): ExecResult {
  const pending = state.pending;
  if (pending.kind !== 'rent' || pending.playerId !== action.actorId) {
    return { ok: false, reason: 'not_the_entitled_player' };
  }
  const events: DomainEvent[] = [...declareBankruptcy(state, action.actorId)];
  state.pending = { kind: 'none' };
  events.push(...finishTurn(state));
  return { ok: true, events };
}
