/**
 * The keystone: `createGame` and `applyAction`, the ONLY function permitted to
 * mutate or replace game state (see HANDOFF §2).
 *
 * Authorization model: every action carries an `actorId`. The reducer first
 * checks it against an entitlement table keyed by (phase, action.type) →
 * required actor; any mismatch returns the state UNCHANGED plus a `REJECTED`
 * event. That single gate is what makes B03 (jail-free button with no handler),
 * B09 (any client resolving another player's card), B13 (trade cancel corrupting
 * the phase) and B22 (timeout diverging from the human path) unrepresentable:
 * the actor literally cannot reach the mutation.
 *
 * The `never` fallthroughs below turn a missing phase branch into a COMPILE
 * error, not the permanent freeze that an absent autoPass branch caused (B02).
 *
 * No `Math.random()` or `Date.now()` here — randomness and time are injected
 * through `ctx`, so a seed replays a game exactly (soak test criterion 6/10).
 */

import { createInitialState, playerById, isInPrison, requirePlayer, ownerOf } from './state.js';
import { turnHolder } from './turn.js';
import { findTradeFor } from './trade.js';
import { SYSTEM_ACTOR } from '../shared/actions.js';
import type { Action, ActionResult, Actor, DomainEvent, RejectReason } from '../shared/actions.js';
import type { Board, GameConfig, GameState, SeatId } from '../shared/types.js';
import type { Rng } from './rng.js';
import type { SeatInput } from './state.js';
import {
  execRollDice,
  execConfirmLanding,
  execDrawCard,
  execConfirmCard,
  execChooseCardOption,
  execChooseClub,
  execResolvePropertyBuy,
  execPayRent,
  execBuyUpgrade,
  execSkipUpgrade,
  execSkipPrisonTurn,
  execPayBail,
  execUseJailFree,
  execDeclareBankrupt,
} from './turnActions.js';
import type { ExecResult, ReducerCtx } from './turnActions.js';
import {
  execSellUpgrade,
  execSellProperty,
  execTradeOpen,
  execTradePropose,
  execTradeAccept,
  execTradeDecline,
  execTradeCancel,
  execBidCreate,
  execBidOffer,
  execBidAcceptOffer,
  execBidCancel,
  execPlayerDisconnected,
  execPlayerReconnected,
  execExpireTrades,
  execKickPlayer,
} from './peerActions.js';

export type { ReducerCtx };

const SYSTEM_ACTION_TYPES = new Set<Action['type']>([
  'TIMEOUT',
  'PLAYER_DISCONNECTED',
  'PLAYER_RECONNECTED',
  'EXPIRE_TRADES',
]);

// ── Public entry points ──

/**
 * Create a fresh game. The first seat is the host (KICK_PLAYER authority); the
 * deck is shuffled with `rng` so a seed gives a deterministic starting deck.
 */
export function createGame(
  seats: readonly SeatInput[],
  rng: Rng,
  configOverrides: Partial<GameConfig> = {},
  board?: Board,
): GameState {
  return createInitialState(seats, rng, configOverrides, board);
}

/**
 * The single mutation path. Authorizes, executes, and returns the (mutated)
 * state plus the domain events to broadcast. Rejections return the state
 * untouched with a single `REJECTED` event; the version counter advances only
 * on accepted actions.
 */
export function applyAction(state: GameState, action: Action, ctx: ReducerCtx): ActionResult {
  const auth = authorize(state, action);
  if (!auth.ok || auth.actor !== action.actorId) {
    return {
      state,
      events: [{ type: 'REJECTED', action: action.type, reason: auth.ok ? 'not_your_turn' : auth.reason, actorId: action.actorId }],
    };
  }

  const result = execute(state, action, ctx);
  if (!result.ok) {
    return {
      state,
      events: [{ type: 'REJECTED', action: action.type, reason: result.reason, actorId: action.actorId }],
    };
  }
  state.stateVersion += 1;
  return { state, events: result.events };
}

// ── Authorization ──

type Auth = { ok: true; actor: Actor } | { ok: false; reason: RejectReason };

function ok(actor: Actor): Auth {
  return { ok: true, actor };
}

function denied(reason: RejectReason): Auth {
  return { ok: false, reason };
}

/**
 * (phase, action.type) → required actor. Phase-independent actions (trades,
 * bids, sells, kick) check their own entitlement; everything else is gated by
 * the phase the current turn is parked in.
 */
function authorize(state: GameState, action: Action): Auth {
  if (action.actorId === SYSTEM_ACTOR) {
    return SYSTEM_ACTION_TYPES.has(action.type) ? ok(SYSTEM_ACTOR) : denied('system_action_from_client');
  }
  if (SYSTEM_ACTION_TYPES.has(action.type)) return denied('system_action_from_client');
  if (state.gameOver) return denied('game_over');
  if (playerById(state, action.actorId) === undefined) return denied('player_not_found');

  switch (action.type) {
    case 'KICK_PLAYER':
      return state.hostId === action.actorId ? ok(action.actorId) : denied('not_host');
    case 'TRADE_OPEN':
      if (state.config.tradeTiming === 'own_turn' && !isCurrentTurn(state, action.actorId)) {
        return denied('not_your_turn');
      }
      return ok(action.actorId);
    case 'TRADE_PROPOSE':
    case 'TRADE_ACCEPT':
    case 'TRADE_DECLINE':
    case 'TRADE_CANCEL':
      return findTradeFor(state, action.actorId) !== undefined ? ok(action.actorId) : denied('not_the_entitled_player');
    case 'SELL_UPGRADE':
    case 'SELL_PROPERTY':
      return ownerOf(state, action.squareId) === action.actorId ? ok(action.actorId) : denied('not_the_owner');
    case 'BID_CREATE':
    case 'BID_OFFER':
    case 'BID_ACCEPT_OFFER':
    case 'BID_CANCEL':
      // Bid ownership/self-bid rules are domain checks in bid.ts — the actor is
      // entitled by being an active player, which is checked above.
      return ok(action.actorId);
    default:
      return phaseAuthorization(state, action);
  }
}

function isCurrentTurn(state: GameState, seatId: SeatId): boolean {
  return turnHolder(state) === seatId;
}

/** Turn-scoped actions: the phase names exactly who may act in it. */
function phaseAuthorization(state: GameState, action: Action): Auth {
  const pending = state.pending;
  const turn = turnHolder(state);
  switch (state.phase) {
    case 'roll':
      switch (action.type) {
        case 'ROLL_DICE':
        case 'SKIP_PRISON_TURN':
        case 'PAY_BAIL':
        case 'USE_JAIL_FREE':
          return turn === undefined ? denied('player_not_found') : ok(turn);
        default:
          return denied('wrong_phase');
      }
    case 'rolling':
      return action.type === 'CONFIRM_LANDING'
        ? turn === undefined
          ? denied('player_not_found')
          : ok(turn)
        : denied('wrong_phase');
    case 'draw_card':
      return action.type === 'DRAW_CARD' && pending.kind === 'deck_draw' ? ok(pending.playerId) : denied('wrong_phase');
    case 'blind_card':
      return action.type === 'CONFIRM_CARD' && pending.kind === 'blind_card'
        ? ok(pending.playerId)
        : denied('wrong_phase');
    case 'card_choice':
      return action.type === 'CHOOSE_CARD_OPTION' && pending.kind === 'card_choice'
        ? ok(pending.playerId)
        : denied('wrong_phase');
    case 'club_choice':
      return action.type === 'CHOOSE_CLUB' && pending.kind === 'club' ? ok(pending.playerId) : denied('wrong_phase');
    case 'property_choice':
      return action.type === 'RESOLVE_PROPERTY_BUY' && pending.kind === 'property_buy'
        ? ok(pending.playerId)
        : denied('wrong_phase');
    case 'upgrade_choice':
      if (pending.kind !== 'upgrade') return denied('wrong_phase');
      return action.type === 'BUY_UPGRADE' || action.type === 'SKIP_UPGRADE' ? ok(pending.playerId) : denied('wrong_phase');
    case 'rent_payment':
      if (pending.kind !== 'rent') return denied('wrong_phase');
      return action.type === 'PAY_RENT' || action.type === 'DECLARE_BANKRUPT'
        ? ok(pending.playerId)
        : denied('wrong_phase');
    case 'game_over':
      return denied('game_over');
    default: {
      const never: never = state.phase;
      throw new Error(`Unhandled phase: ${JSON.stringify(never)}`);
    }
  }
}

// ── Execution ──

/** Route an authorized action to its executor. TIMEOUT re-enters here with the human action (B22). */
function execute(state: GameState, action: Action, ctx: ReducerCtx): ExecResult {
  switch (action.type) {
    // Turn
    case 'ROLL_DICE':
      return execRollDice(state, action, ctx);
    case 'CONFIRM_LANDING':
      return execConfirmLanding(state, action);
    // Cards
    case 'DRAW_CARD':
      return execDrawCard(state, action, ctx);
    case 'CONFIRM_CARD':
      return execConfirmCard(state, action, ctx);
    case 'CHOOSE_CARD_OPTION':
      return execChooseCardOption(state, action);
    // Club
    case 'CHOOSE_CLUB':
      return execChooseClub(state, action);
    // Property
    case 'RESOLVE_PROPERTY_BUY':
      return execResolvePropertyBuy(state, action);
    case 'PAY_RENT':
      return execPayRent(state, action);
    case 'BUY_UPGRADE':
      return execBuyUpgrade(state, action);
    case 'SKIP_UPGRADE':
      return execSkipUpgrade(state, action);
    case 'SELL_UPGRADE':
      return execSellUpgrade(state, action);
    case 'SELL_PROPERTY':
      return execSellProperty(state, action);
    // Prison
    case 'SKIP_PRISON_TURN':
      return execSkipPrisonTurn(state, action);
    case 'PAY_BAIL':
      return execPayBail(state, action);
    case 'USE_JAIL_FREE':
      return execUseJailFree(state, action);
    // Insolvency
    case 'DECLARE_BANKRUPT':
      return execDeclareBankrupt(state, action);
    // Trades
    case 'TRADE_OPEN':
      return execTradeOpen(state, action);
    case 'TRADE_PROPOSE':
      return execTradePropose(state, action);
    case 'TRADE_ACCEPT':
      return execTradeAccept(state, action);
    case 'TRADE_DECLINE':
      return execTradeDecline(state, action);
    case 'TRADE_CANCEL':
      return execTradeCancel(state, action);
    // Bids
    case 'BID_CREATE':
      return execBidCreate(state, action);
    case 'BID_OFFER':
      return execBidOffer(state, action);
    case 'BID_ACCEPT_OFFER':
      return execBidAcceptOffer(state, action);
    case 'BID_CANCEL':
      return execBidCancel(state, action);
    // System
    case 'TIMEOUT':
      return applyTimeout(state, ctx);
    case 'PLAYER_DISCONNECTED':
      return execPlayerDisconnected(state, action);
    case 'PLAYER_RECONNECTED':
      return execPlayerReconnected(state, action);
    case 'EXPIRE_TRADES':
      return execExpireTrades(state, action);
    // Host
    case 'KICK_PLAYER':
      return execKickPlayer(state, action);
    default: {
      const never: never = action;
      throw new Error(`Unhandled action: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Timer expiry: synthesize the action a human would send in this phase and run
 * it through the SAME executor, so a timeout can never produce a different
 * outcome from a click (B22). Every phase has a branch (B02). Jailed players
 * serve a prison turn instead of rolling (B05).
 */
function applyTimeout(state: GameState, ctx: ReducerCtx): ExecResult {
  const turn = turnHolder(state);
  if (state.gameOver || turn === undefined) return { ok: true, events: [] };

  let action: Action | null;
  switch (state.phase) {
    case 'roll': {
      const player = requirePlayer(state, turn);
      action = isInPrison(player)
        ? { type: 'SKIP_PRISON_TURN', actorId: turn }
        : { type: 'ROLL_DICE', actorId: turn };
      break;
    }
    case 'rolling':
      action = { type: 'CONFIRM_LANDING', actorId: turn };
      break;
    case 'draw_card':
      action =
        state.pending.kind === 'deck_draw' && state.pending.queue[0] !== undefined
          ? { type: 'DRAW_CARD', actorId: turn, deck: state.pending.queue[0] }
          : null;
      break;
    case 'blind_card':
      action = { type: 'CONFIRM_CARD', actorId: turn };
      break;
    case 'card_choice':
      action = { type: 'CHOOSE_CARD_OPTION', actorId: turn, index: 0 };
      break;
    case 'club_choice':
      action = { type: 'CHOOSE_CLUB', actorId: turn, choice: 'guest' };
      break;
    case 'property_choice':
      action = { type: 'RESOLVE_PROPERTY_BUY', actorId: turn, buy: false };
      break;
    case 'upgrade_choice':
      action = { type: 'SKIP_UPGRADE', actorId: turn };
      break;
    case 'rent_payment':
      action = { type: 'PAY_RENT', actorId: turn };
      break;
    case 'game_over':
      action = null;
      break;
    default: {
      const never: never = state.phase;
      throw new Error(`Unhandled timeout phase: ${JSON.stringify(never)}`);
    }
  }

  if (action === null) return { ok: true, events: [] };
  return execute(state, action, ctx);
}

export type { Actor, DomainEvent, GameState };
