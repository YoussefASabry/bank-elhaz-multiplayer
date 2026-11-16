/**
 * The reducer. `applyAction` is the ONLY function permitted to mutate or
 * replace game state — every other engine module is a helper it calls.
 *
 * Two invariants carry most of the defect classes from HANDOFF.md:
 *
 *  1. **One authorization table.** Every action is checked against
 *     {@link AUTH} keyed by action type before any handler runs: allowed
 *     phases, and who is entitled to act. A handler never re-derives
 *     entitlement, so it cannot disagree with another handler.
 *     - B03 `USE_JAIL_FREE` had no server handler at all; it is in the table.
 *     - B09 `confirm_blind_card` applied the card to the CALLER; entitlement
 *       `pending_player` makes the caller and the drawing player the same
 *       seat by construction.
 *     - B19 `restore_game` installed a client GameState; there is no action
 *       that carries a state, so it is unrepresentable.
 *
 *  2. **One timeout path.** `TIMEOUT` does not settle anything itself. It
 *     synthesises the default action for whatever is pending and recurses
 *     through `applyAction`, so the timeout path and the human path are the
 *     same code (B22).
 *
 * `SYSTEM_ACTOR` is never a seat id, and system-only actions reject any other
 * actor, so a client cannot forge a timeout or a disconnect.
 */
import { SYSTEM_ACTOR } from '../shared/actions.js';
import type {
  Action,
  ActionResult,
  ActionType,
  Actor,
  DomainEvent,
  RejectReason,
} from '../shared/actions.js';
import type { GameState, Phase, SeatId } from '../shared/types.js';
import { isActive } from '../shared/types.js';
import { isEmptyBasket } from '../shared/trading.js';

import { checkGameOver, checkInsolvency, kickPlayer } from './bankruptcy.js';
import { acceptOffer, cancelBid, createBid, expireBids, offerOnBid } from './bid.js';
import { applyCardEffects, preselectCities, resolveChoice, setupChoices } from './cards.js';
import { deckTotal, discard, draw } from './deck.js';
import {
  buyProperty,
  purchaseUpgrade,
  sellPropertyToBank,
  sellUpgrade,
} from './property.js';
import type { Rng } from './rng.js';
import {
  playerById,
  requirePlayer,
  transfer,
} from './state.js';
import {
  acceptTrade,
  cancelTrade,
  declineTrade,
  expireTrades,
  openTrade,
  proposeTrade,
} from './trade.js';
import {
  advanceTurn,
  evaluateLanding,
  finishTurn,
  payBail,
  resolveRoll,
  skipPrisonTurn,
  useJailFreeCard,
} from './turn.js';

export * from './board.js';
export * from './state.js';
export * from './rng.js';

/** Who may issue an action. Checked before the handler, never inside it. */
type Entitlement =
  /** The seat whose turn it is. */
  | 'current_turn'
  /** The seat named by `state.pending` — always the seat the prompt is for. */
  | 'pending_player'
  /** Any seat still in the game (trades, bids, raising cash, conceding). */
  | 'any_active'
  /** Trades honour `config.tradeTiming`: 'anytime' or 'own_turn'. */
  | 'trade_window'
  /** Seat 0. There is no `isHost` on Player, so the first seat is the host. */
  | 'host'
  /** The server itself. Rejects anything that is not SYSTEM_ACTOR. */
  | 'system';

interface AuthRule {
  /** Phases in which the action is accepted. `null` means any phase. */
  phases: readonly Phase[] | null;
  entitlement: Entitlement;
}

/**
 * Phases in which a player may raise cash or concede. Deliberately broad: a
 * player facing rent they cannot pay must be able to sell before paying.
 * `game_over` is excluded here and again by the global terminal check.
 */
const LIQUIDITY_PHASES: readonly Phase[] = [
  'roll',
  'rolling',
  'draw_card',
  'blind_card',
  'card_choice',
  'club_choice',
  'property_choice',
  'upgrade_choice',
  'rent_payment',
];

const AUTH: Record<ActionType, AuthRule> = {
  ROLL_DICE: { phases: ['roll'], entitlement: 'current_turn' },
  CONFIRM_LANDING: { phases: ['rolling'], entitlement: 'current_turn' },

  RESOLVE_PROPERTY_BUY: { phases: ['property_choice'], entitlement: 'pending_player' },
  PAY_RENT: { phases: ['rent_payment'], entitlement: 'pending_player' },
  BUY_UPGRADE: { phases: ['upgrade_choice'], entitlement: 'pending_player' },
  SKIP_UPGRADE: { phases: ['upgrade_choice'], entitlement: 'pending_player' },
  DRAW_CARD: { phases: ['draw_card'], entitlement: 'pending_player' },
  CONFIRM_CARD: { phases: ['blind_card'], entitlement: 'pending_player' },
  CHOOSE_CARD_OPTION: { phases: ['card_choice'], entitlement: 'pending_player' },
  CHOOSE_CLUB: { phases: ['club_choice'], entitlement: 'pending_player' },

  SELL_UPGRADE: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  SELL_PROPERTY: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  DECLARE_BANKRUPT: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },

  SKIP_PRISON_TURN: { phases: ['roll'], entitlement: 'current_turn' },
  PAY_BAIL: { phases: ['roll'], entitlement: 'current_turn' },
  USE_JAIL_FREE: { phases: ['roll'], entitlement: 'current_turn' },

  TRADE_OPEN: { phases: LIQUIDITY_PHASES, entitlement: 'trade_window' },
  TRADE_PROPOSE: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  TRADE_ACCEPT: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  TRADE_DECLINE: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  TRADE_CANCEL: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },

  BID_CREATE: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  BID_OFFER: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  BID_ACCEPT_OFFER: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },
  BID_CANCEL: { phases: LIQUIDITY_PHASES, entitlement: 'any_active' },

  KICK_PLAYER: { phases: null, entitlement: 'host' },

  TIMEOUT: { phases: null, entitlement: 'system' },
  PLAYER_DISCONNECTED: { phases: null, entitlement: 'system' },
  PLAYER_RECONNECTED: { phases: null, entitlement: 'system' },
  EXPIRE_TRADES: { phases: null, entitlement: 'system' },
};

/** Actions the server issues on its own behalf. Never accepted from a socket. */
const SYSTEM_ONLY: ReadonlySet<ActionType> = new Set<ActionType>([
  'TIMEOUT',
  'PLAYER_DISCONNECTED',
  'PLAYER_RECONNECTED',
  'EXPIRE_TRADES',
]);

function reject(state: GameState, action: Action, reason: RejectReason): ActionResult {
  return {
    state,
    events: [{ type: 'REJECTED', action: action.type, reason, actorId: action.actorId }],
  };
}

/** The seat `state.pending` is addressed to, if any. */
function pendingPlayer(state: GameState): SeatId | null {
  return state.pending.kind === 'none' ? null : state.pending.playerId;
}

function isSeat(actor: Actor): actor is SeatId {
  return actor !== SYSTEM_ACTOR;
}

/**
 * The whole authorization decision. Returns a reason, or null when allowed.
 * Nothing else in this file re-checks turn ownership or phase.
 */
function authorize(state: GameState, action: Action): RejectReason | null {
  const rule = AUTH[action.type];

  // A client must never be able to speak as the server.
  if (action.actorId === SYSTEM_ACTOR && !SYSTEM_ONLY.has(action.type)) {
    return 'system_action_from_client';
  }
  if (SYSTEM_ONLY.has(action.type) && action.actorId !== SYSTEM_ACTOR) {
    return 'system_action_from_client';
  }

  // Terminal state accepts nothing at all.
  if (state.gameOver || state.phase === 'game_over') return 'game_over';

  if (rule.phases !== null && !rule.phases.includes(state.phase)) return 'wrong_phase';

  if (rule.entitlement === 'system') {
    return action.actorId === SYSTEM_ACTOR ? null : 'system_action_from_client';
  }

  if (!isSeat(action.actorId)) return 'system_action_from_client';
  const actor = playerById(state, action.actorId);
  if (actor === undefined) return 'player_not_found';
  if (!isActive(actor)) return 'player_inactive';

  switch (rule.entitlement) {
    case 'current_turn': {
      const holder = state.players[state.currentPlayerIndex];
      return holder !== undefined && holder.id === action.actorId ? null : 'not_your_turn';
    }
    case 'pending_player': {
      const owed = pendingPlayer(state);
      if (owed === null) return 'nothing_pending';
      return owed === action.actorId ? null : 'not_the_entitled_player';
    }
    case 'trade_window': {
      if (state.config.tradeTiming === 'anytime') return null;
      const holder = state.players[state.currentPlayerIndex];
      return holder !== undefined && holder.id === action.actorId ? null : 'not_your_turn';
    }
    case 'host': {
      const host = state.players[0];
      return host !== undefined && host.id === action.actorId ? null : 'not_host';
    }
    case 'any_active':
      return null;
    default: {
      const never: never = rule.entitlement;
      throw new Error(`Unhandled entitlement: ${String(never)}`);
    }
  }
}

/** Debit/credit bookkeeping that always emits the matching MONEY_CHANGED. */
function pay(
  state: GameState,
  seatId: SeatId,
  delta: number,
  reason: string,
  events: DomainEvent[],
): void {
  const player = requirePlayer(state, seatId);
  player.money += delta;
  events.push({
    type: 'MONEY_CHANGED',
    playerId: seatId,
    delta,
    balance: player.money,
    reason,
  });
}

/**
 * Tail shared by every card resolution: apply landing effects for a teleport,
 * then re-queue the second card of a dual-deck square (B10), then let
 * `finishTurn` pick the phase or hand the turn over.
 */
function afterCard(
  state: GameState,
  seatId: SeatId,
  needsLandingEval: boolean,
  remainingDraws: readonly string[],
  squareName: string,
  events: DomainEvent[],
): void {
  if (needsLandingEval) events.push(...evaluateLanding(state, seatId));

  if (state.pending.kind === 'none' && remainingDraws.length > 0) {
    state.pending = {
      kind: 'deck_draw',
      playerId: seatId,
      queue: remainingDraws as never,
      squareName,
    };
  }
  events.push(...finishTurn(state));
}

/**
 * Apply one action. Returns the (mutated) state and the events to broadcast.
 * A rejected action leaves state untouched and does not bump `stateVersion`,
 * so a rejection can never advance a snapshot.
 */
export function applyAction(state: GameState, action: Action, rng: Rng): ActionResult {
  const denial = authorize(state, action);
  if (denial !== null) return reject(state, action, denial);

  const result = dispatch(state, action, rng);

  const rejected =
    result.events.length === 1 && result.events[0]?.type === 'REJECTED';
  if (!rejected) result.state.stateVersion += 1;
  return result;
}

function dispatch(state: GameState, action: Action, rng: Rng): ActionResult {
  const events: DomainEvent[] = [];

  switch (action.type) {
    case 'ROLL_DICE': {
      const res = resolveRoll(state, action.actorId as SeatId, rng);
      if (!res.ok) return reject(state, action, res.reason);
      return { state, events: res.events };
    }

    case 'CONFIRM_LANDING': {
      const seatId = action.actorId as SeatId;
      events.push(...evaluateLanding(state, seatId));
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'RESOLVE_PROPERTY_BUY': {
      if (state.pending.kind !== 'property_buy') return reject(state, action, 'nothing_pending');
      const { playerId, squareId } = state.pending;
      if (action.buy) {
        const res = buyProperty(state, playerId, squareId);
        if (!res.ok) return reject(state, action, res.reason);
        events.push({ type: 'PROPERTY_BOUGHT', playerId, squareId, price: res.price });
        events.push({
          type: 'MONEY_CHANGED',
          playerId,
          delta: -res.price,
          balance: requirePlayer(state, playerId).money,
          reason: 'buy_property',
        });
      } else {
        events.push({ type: 'PROPERTY_DECLINED', playerId, squareId });
      }
      state.pending = { kind: 'none' };
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'PAY_RENT': {
      if (state.pending.kind !== 'rent') return reject(state, action, 'nothing_pending');
      const { playerId, ownerId, amount } = state.pending;
      const payer = requirePlayer(state, playerId);
      const owner = ownerId === null ? null : playerById(state, ownerId) ?? null;
      const paid = transfer(payer, owner, amount);

      events.push({
        type: 'MONEY_CHANGED',
        playerId,
        delta: -paid,
        balance: payer.money,
        reason: 'rent',
      });
      if (owner !== null) {
        events.push({
          type: 'MONEY_CHANGED',
          playerId: owner.id,
          delta: paid,
          balance: owner.money,
          reason: 'rent_income',
        });
      }
      events.push({ type: 'RENT_PAID', playerId, ownerId, amount: paid });

      state.pending = { kind: 'none' };
      events.push(...checkInsolvency(state, playerId));
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'BUY_UPGRADE': {
      if (state.pending.kind !== 'upgrade') return reject(state, action, 'nothing_pending');
      const { playerId, squareId } = state.pending;
      if (action.squareId !== squareId) return reject(state, action, 'square_not_found');

      const res = purchaseUpgrade(state, playerId, squareId, action.tier);
      if (!res.ok) return reject(state, action, res.reason);

      events.push({
        type: 'UPGRADE_BUILT',
        playerId,
        squareId,
        tier: res.tier,
        cost: res.cost,
      });
      // purchaseUpgrade has already debited; report the resulting balance.
      events.push({
        type: 'MONEY_CHANGED',
        playerId,
        delta: -res.cost,
        balance: requirePlayer(state, playerId).money,
        reason: 'upgrade',
      });

      state.pending = { kind: 'none' };
      events.push(...checkInsolvency(state, playerId));
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'SKIP_UPGRADE': {
      if (state.pending.kind !== 'upgrade') return reject(state, action, 'nothing_pending');
      state.pending = { kind: 'none' };
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'SELL_UPGRADE': {
      const seatId = action.actorId as SeatId;
      const res = sellUpgrade(state, seatId, action.squareId);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({
        type: 'UPGRADE_SOLD',
        playerId: seatId,
        squareId: action.squareId,
        tier: res.tier,
        refund: res.refund,
      });
      events.push({
        type: 'MONEY_CHANGED',
        playerId: seatId,
        delta: res.refund,
        balance: requirePlayer(state, seatId).money,
        reason: 'sell_upgrade',
      });
      return { state, events };
    }

    case 'SELL_PROPERTY': {
      const seatId = action.actorId as SeatId;
      const res = sellPropertyToBank(state, seatId, action.squareId);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({
        type: 'PROPERTY_SOLD',
        playerId: seatId,
        squareId: action.squareId,
        refund: res.refund,
      });
      events.push({
        type: 'MONEY_CHANGED',
        playerId: seatId,
        delta: res.refund,
        balance: requirePlayer(state, seatId).money,
        reason: 'sell_property',
      });
      return { state, events };
    }

    case 'DRAW_CARD': {
      if (state.pending.kind !== 'deck_draw') return reject(state, action, 'nothing_pending');
      const { playerId, queue, squareName } = state.pending;
      const next = queue[0];
      if (next === undefined) return reject(state, action, 'nothing_pending');
      if (next !== action.deck) return reject(state, action, 'deck_mismatch');

      const card = draw(state.decks, action.deck, rng);
      if (card === null) return reject(state, action, 'deck_exhausted');

      const totalCards = deckTotal(state.decks, action.deck);
      const cardNumber = totalCards - state.decks[action.deck].draw.length;

      events.push({
        type: 'CARD_DRAWN',
        playerId,
        deck: action.deck,
        cardId: card.id,
        cardNumber,
        totalCards,
      });

      const cityIds = preselectCities(state, card, rng);
      state.pending = {
        kind: 'blind_card',
        playerId,
        card,
        cardNumber,
        totalCards,
        ...(cityIds.length > 0 ? { cityIds } : {}),
        remainingDraws: queue.slice(1),
      };
      void squareName;
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'CONFIRM_CARD': {
      if (state.pending.kind !== 'blind_card') return reject(state, action, 'nothing_pending');
      const { playerId, card, cityIds, remainingDraws } = state.pending;

      if (card.choices.length > 0) {
        const setup = setupChoices(state, playerId, card, rng);
        events.push(...setup.events);
        discard(state.decks, card);
        if (setup.pending !== null) {
          // setupChoices cannot know the originating queue; copy it across.
          state.pending = { ...setup.pending, remainingDraws };
          events.push(...finishTurn(state));
          return { state: setup.state, events };
        }
        state.pending = { kind: 'none' };
        afterCard(setup.state, playerId, false, remainingDraws, '', events);
        return { state: setup.state, events };
      }

      const outcome = applyCardEffects(state, playerId, card, rng, cityIds ?? []);
      events.push(...outcome.events);
      events.push({
        type: 'CARD_RESOLVED',
        playerId,
        deck: card.deck,
        cardId: card.id,
        description: card.description,
      });
      discard(state.decks, card);
      state.pending = { kind: 'none' };
      events.push(...checkInsolvency(state, playerId));
      afterCard(outcome.state, playerId, outcome.needsLandingEval, remainingDraws, '', events);
      return { state: outcome.state, events };
    }

    case 'CHOOSE_CARD_OPTION': {
      if (state.pending.kind !== 'card_choice') return reject(state, action, 'nothing_pending');
      const { playerId, card, remainingDraws } = state.pending;

      const res = resolveChoice(state, playerId, action.index);
      if (!res.ok) return reject(state, action, res.reason);

      events.push(...res.events);
      events.push({
        type: 'CARD_RESOLVED',
        playerId,
        deck: card.deck,
        cardId: card.id,
        description: card.description,
      });
      state.pending = { kind: 'none' };
      events.push(...checkInsolvency(state, playerId));
      afterCard(res.state, playerId, res.needsLandingEval, remainingDraws, '', events);
      return { state: res.state, events };
    }

    case 'CHOOSE_CLUB': {
      if (state.pending.kind !== 'club') return reject(state, action, 'nothing_pending');
      const { playerId, membershipCost, guestFineFee } = state.pending;
      const cost = action.choice === 'membership' ? membershipCost : guestFineFee;

      pay(state, playerId, -cost, action.choice === 'membership' ? 'club_membership' : 'club_guest', events);
      if (action.choice === 'membership') requirePlayer(state, playerId).isClubMember = true;
      events.push({ type: 'CLUB_RESOLVED', playerId, choice: action.choice, cost });

      state.pending = { kind: 'none' };
      events.push(...checkInsolvency(state, playerId));
      events.push(...finishTurn(state));
      return { state, events };
    }

    case 'SKIP_PRISON_TURN': {
      const res = skipPrisonTurn(state, action.actorId as SeatId);
      if (!res.ok) return reject(state, action, res.reason);
      return { state, events: res.events };
    }

    case 'PAY_BAIL': {
      const res = payBail(state, action.actorId as SeatId);
      if (!res.ok) return reject(state, action, res.reason);
      return { state, events: res.events };
    }

    case 'USE_JAIL_FREE': {
      const res = useJailFreeCard(state, action.actorId as SeatId);
      if (!res.ok) return reject(state, action, res.reason);
      return { state, events: res.events };
    }

    case 'DECLARE_BANKRUPT': {
      const seatId = action.actorId as SeatId;
      const player = requirePlayer(state, seatId);
      player.money = -1; // force the single insolvency model to settle it (B21)
      events.push(...checkInsolvency(state, seatId));
      if (!state.gameOver) {
        const holder = state.players[state.currentPlayerIndex];
        if (holder !== undefined && holder.id === seatId) {
          state.pending = { kind: 'none' };
          events.push(...advanceTurn(state));
        }
      }
      return { state, events };
    }

    case 'KICK_PLAYER': {
      events.push(...kickPlayer(state, action.targetId, action.actorId as SeatId));
      if (!state.gameOver) {
        const holder = state.players[state.currentPlayerIndex];
        if (holder !== undefined && holder.id === action.targetId) {
          state.pending = { kind: 'none' };
          events.push(...advanceTurn(state));
        }
      }
      return { state, events };
    }

    /* ---------------- trades ---------------- */

    case 'TRADE_OPEN': {
      const res = openTrade(state, action.actorId as SeatId, action.partnerId, action.now);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({ type: 'TRADE_OPENED', tradeId: res.value.id, a: res.value.a, b: res.value.b });
      return { state, events };
    }

    case 'TRADE_PROPOSE': {
      if (isEmptyBasket(action.basket)) return reject(state, action, 'empty_basket');
      const res = proposeTrade(state, action.actorId as SeatId, action.basket);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({ type: 'TRADE_STAGE_CHANGED', tradeId: res.value.id, stage: res.value.stage });
      return { state, events };
    }

    case 'TRADE_ACCEPT': {
      const res = acceptTrade(state, action.actorId as SeatId);
      if (!res.ok) return reject(state, action, res.reason);
      const trade = res.value;
      if (trade.stage === 'settled') {
        events.push({ type: 'TRADE_SETTLED', tradeId: trade.id, a: trade.a, b: trade.b });
      } else {
        events.push({ type: 'TRADE_STAGE_CHANGED', tradeId: trade.id, stage: trade.stage });
      }
      return { state, events };
    }

    case 'TRADE_DECLINE': {
      const res = declineTrade(state, action.actorId as SeatId);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({ type: 'TRADE_STAGE_CHANGED', tradeId: res.value.id, stage: res.value.stage });
      return { state, events };
    }

    case 'TRADE_CANCEL': {
      // B13: cancelling a trade must NOT touch `phase`. It never did here.
      const res = cancelTrade(state, action.actorId as SeatId, 'cancelled_by_player');
      if (!res.ok) return reject(state, action, res.reason);
      events.push({ type: 'TRADE_CANCELLED', tradeId: res.value.id, reason: 'cancelled_by_player' });
      return { state, events };
    }

    /* ---------------- bids ---------------- */

    case 'BID_CREATE': {
      if (isEmptyBasket(action.basket)) return reject(state, action, 'empty_basket');
      const res = createBid(state, action.actorId as SeatId, action.basket, action.now);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({ type: 'BID_CREATED', bidId: res.value.id, playerId: res.value.playerId });
      return { state, events };
    }

    case 'BID_OFFER': {
      if (isEmptyBasket(action.basket)) return reject(state, action, 'empty_basket');
      const res = offerOnBid(state, action.actorId as SeatId, action.bidId, action.basket);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({
        type: 'BID_OFFER_ADDED',
        bidId: action.bidId,
        offerId: res.value.id,
        playerId: res.value.playerId,
      });
      return { state, events };
    }

    case 'BID_ACCEPT_OFFER': {
      const res = acceptOffer(state, action.actorId as SeatId, action.bidId, action.offerId);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({
        type: 'BID_SETTLED',
        bidId: res.value.bid.id,
        bidderId: res.value.bid.playerId,
        offererId: res.value.offer.playerId,
      });
      return { state, events };
    }

    case 'BID_CANCEL': {
      const res = cancelBid(state, action.actorId as SeatId, action.bidId);
      if (!res.ok) return reject(state, action, res.reason);
      events.push({ type: 'BID_CANCELLED', bidId: res.value.id });
      return { state, events };
    }

    /* ---------------- server-issued ---------------- */

    case 'EXPIRE_TRADES': {
      const t = expireTrades(state, action.now, 'expired');
      events.push(...t.events);
      const b = expireBids(t.state, action.now);
      events.push(...b.events);
      return { state: b.state, events };
    }

    case 'PLAYER_DISCONNECTED': {
      const player = playerById(state, action.playerId);
      if (player === undefined) return reject(state, action, 'player_not_found');
      player.connected = false;
      return { state, events };
    }

    case 'PLAYER_RECONNECTED': {
      const player = playerById(state, action.playerId);
      if (player === undefined) return reject(state, action, 'player_not_found');
      player.connected = true;
      return { state, events };
    }

    /**
     * B22: no settlement logic lives here. The timeout picks the default
     * answer to whatever is on the table and replays it through the same
     * reducer as a human answer, so the two paths cannot drift.
     */
    case 'TIMEOUT': {
      const synthetic = defaultActionFor(state);
      if (synthetic === null) return { state, events };
      const inner = applyAction(state, synthetic, rng);
      /**
       * The inner `applyAction` already bumped `stateVersion`, and the outer
       * one is about to bump it again for this same TIMEOUT. One action must
       * mean one version, or clients see a gap and refetch a snapshot, so the
       * inner bump is undone here and only the outer one survives.
       */
      const innerRejected =
        inner.events.length === 1 && inner.events[0]?.type === 'REJECTED';
      if (!innerRejected) inner.state.stateVersion -= 1;
      return inner;
    }

    default: {
      const never: never = action;
      throw new Error(`Unhandled action: ${JSON.stringify(never)}`);
    }
  }
}

/** The action a timed-out player is deemed to have taken. */
function defaultActionFor(state: GameState): Action | null {
  const pending = state.pending;

  switch (pending.kind) {
    case 'property_buy':
      return { type: 'RESOLVE_PROPERTY_BUY', actorId: pending.playerId, buy: false };
    case 'rent':
      return { type: 'PAY_RENT', actorId: pending.playerId };
    case 'upgrade':
      return { type: 'SKIP_UPGRADE', actorId: pending.playerId };
    case 'club':
      return { type: 'CHOOSE_CLUB', actorId: pending.playerId, choice: 'guest' };
    case 'deck_draw': {
      const deck = pending.queue[0];
      return deck === undefined
        ? null
        : { type: 'DRAW_CARD', actorId: pending.playerId, deck };
    }
    case 'blind_card':
      return { type: 'CONFIRM_CARD', actorId: pending.playerId };
    case 'card_choice':
      return { type: 'CHOOSE_CARD_OPTION', actorId: pending.playerId, index: 0 };
    case 'none': {
      const holder = state.players[state.currentPlayerIndex];
      if (holder === undefined) return null;
      if (holder.statusEffects.missedTurnsRemaining > 0) {
        return { type: 'SKIP_PRISON_TURN', actorId: holder.id };
      }
      if (state.phase === 'rolling') return { type: 'CONFIRM_LANDING', actorId: holder.id };
      if (state.phase === 'roll') return { type: 'ROLL_DICE', actorId: holder.id };
      return null;
    }
    default: {
      const never: never = pending;
      throw new Error(`Unhandled pending: ${JSON.stringify(never)}`);
    }
  }
}

export { checkGameOver };
