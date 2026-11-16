/**
 * Actions are the ONLY way game state changes. `applyAction` in
 * src/engine/index.ts is the only function permitted to mutate or replace state.
 *
 * Every action carries an `actorId`, and the reducer checks it against an
 * authorization table keyed by (phase, action type). That single check is what
 * makes a family of defects unrepresentable rather than merely fixed:
 *
 *   B03  a handler for USE_JAIL_FREE that never existed on the server
 *   B09  confirm_blind_card applying the card effect to the CALLER instead of
 *        the drawing player, with no turn check at all
 *   B13  a trade cancel writing `phase = 'rent_payment'` from outside the turn
 *   B19  restore_game installing a client-authored GameState
 *   B22  the timeout path reimplementing rent settlement differently to the
 *        human path
 *
 * `SYSTEM_ACTOR` is reserved for the server itself (timeouts, disconnects) and
 * is never a seat id, so a client cannot forge one.
 */

import type { DeckType, SeatId, SquareId, UpgradeTier, Basket, Phase } from './types.js';

export const SYSTEM_ACTOR = '__system__' as const;
export type SystemActor = typeof SYSTEM_ACTOR;
export type Actor = SeatId | SystemActor;

// ── Actions ──

interface ActionBase {
  actorId: Actor;
}

export type Action =
  // Turn
  | (ActionBase & { type: 'ROLL_DICE' })
  | (ActionBase & { type: 'CONFIRM_LANDING' })
  // Property
  | (ActionBase & { type: 'RESOLVE_PROPERTY_BUY'; buy: boolean })
  | (ActionBase & { type: 'PAY_RENT' })
  | (ActionBase & { type: 'BUY_UPGRADE'; squareId: SquareId; tier: UpgradeTier })
  | (ActionBase & { type: 'SKIP_UPGRADE' })
  | (ActionBase & { type: 'SELL_UPGRADE'; squareId: SquareId })
  | (ActionBase & { type: 'SELL_PROPERTY'; squareId: SquareId })
  // Cards
  | (ActionBase & { type: 'DRAW_CARD'; deck: DeckType })
  | (ActionBase & { type: 'CONFIRM_CARD' })
  | (ActionBase & { type: 'CHOOSE_CARD_OPTION'; index: number })
  // Club
  | (ActionBase & { type: 'CHOOSE_CLUB'; choice: 'membership' | 'guest' })
  // Prison
  | (ActionBase & { type: 'SKIP_PRISON_TURN' })
  | (ActionBase & { type: 'PAY_BAIL' })
  | (ActionBase & { type: 'USE_JAIL_FREE' })
  // Insolvency
  | (ActionBase & { type: 'DECLARE_BANKRUPT' })
  // Trade
  | (ActionBase & { type: 'TRADE_OPEN'; partnerId: SeatId; now: number })
  | (ActionBase & { type: 'TRADE_PROPOSE'; basket: Basket })
  | (ActionBase & { type: 'TRADE_ACCEPT' })
  | (ActionBase & { type: 'TRADE_DECLINE' })
  | (ActionBase & { type: 'TRADE_CANCEL' })
  // Bid
  | (ActionBase & { type: 'BID_CREATE'; basket: Basket; now: number })
  | (ActionBase & { type: 'BID_OFFER'; bidId: string; basket: Basket })
  | (ActionBase & { type: 'BID_ACCEPT_OFFER'; bidId: string; offerId: string })
  | (ActionBase & { type: 'BID_CANCEL'; bidId: string })
  // System-only
  | { type: 'TIMEOUT'; actorId: SystemActor }
  | { type: 'PLAYER_DISCONNECTED'; actorId: SystemActor; playerId: SeatId }
  | { type: 'PLAYER_RECONNECTED'; actorId: SystemActor; playerId: SeatId }
  | { type: 'EXPIRE_TRADES'; actorId: SystemActor; now: number }
  // Host-only
  | (ActionBase & { type: 'KICK_PLAYER'; targetId: SeatId });

export type ActionType = Action['type'];

// ── Rejections ──

export type RejectReason =
  | 'not_your_turn'
  | 'wrong_phase'
  | 'not_the_entitled_player'
  | 'system_action_from_client'
  | 'game_over'
  | 'player_not_found'
  | 'player_inactive'
  | 'square_not_found'
  | 'square_not_ownable'
  | 'not_the_owner'
  /**
   * Buying a square that already has an owner. Distinct from `not_the_owner`,
   * which is the opposite direction (the actor is not the holder). Unreachable
   * through the normal reducer flow, but guarded anyway: without it, an
   * out-of-band buy silently overwrites `ownership[id].owner` — property theft
   * with no error.
   */
  | 'square_already_owned'
  | 'insufficient_funds'
  | 'in_prison'
  | 'no_jail_free_card'
  | 'property_has_upgrade'
  | 'upgrade_tier_not_next'
  | 'upgrade_requires_full_color_group'
  | 'square_not_upgradable'
  /**
   * The square CAN take upgrades but currently has none built, so there is
   * nothing to sell. Distinct from `square_not_upgradable` (which means the
   * square has no tier tables at all, e.g. محطة بنزين) so the client can say
   * "nothing built here" instead of "this can never be upgraded".
   */
  | 'no_upgrade_to_sell'
  | 'no_such_choice'
  | 'deck_mismatch'
  | 'deck_exhausted'
  | 'already_in_trade'
  | 'no_active_trade'
  | 'trade_wrong_stage'
  | 'trade_rate_limited'
  | 'basket_not_affordable'
  | 'basket_items_not_owned'
  | 'insufficient_jail_cards'
  | 'no_such_bid'
  | 'no_such_offer'
  | 'cannot_bid_on_own'
  /** One open bid per seat. The old roomManager.js:740 enforced this; dropping it
   * would regress into multiple simultaneous bid floats for one player. */
  | 'already_has_active_bid'
  | 'empty_basket'
  | 'not_host'
  | 'nothing_pending';

// ── Domain events ──

/**
 * Emitted by the reducer for the server to broadcast and log. The turn-start log
 * line comes from TURN_STARTED and nowhere else — the old `broadcastState` logged
 * "X's turn" on EVERY broadcast whenever the phase happened to be `roll`, which
 * spammed the log and the toast stack (bug B26).
 */
export type DomainEvent =
  | { type: 'REJECTED'; action: ActionType; reason: RejectReason; actorId: Actor }
  | { type: 'TURN_STARTED'; playerId: SeatId; turnNumber: number }
  | { type: 'PHASE_CHANGED'; from: Phase; to: Phase }
  | {
      type: 'DICE_ROLLED';
      playerId: SeatId;
      die1: number;
      die2: number;
      total: number;
      steps: number;
      doubleApplied: boolean;
    }
  | { type: 'MOVED'; playerId: SeatId; from: SquareId; to: SquareId; teleported: boolean }
  | { type: 'PASSED_GO'; playerId: SeatId; amount: number }
  | { type: 'MONEY_CHANGED'; playerId: SeatId; delta: number; balance: number; reason: string }
  | { type: 'PROPERTY_BOUGHT'; playerId: SeatId; squareId: SquareId; price: number }
  | { type: 'PROPERTY_DECLINED'; playerId: SeatId; squareId: SquareId }
  | { type: 'PROPERTY_SOLD'; playerId: SeatId; squareId: SquareId; refund: number }
  | { type: 'RENT_DUE'; playerId: SeatId; ownerId: SeatId | null; amount: number; squareId: SquareId }
  | { type: 'RENT_PAID'; playerId: SeatId; ownerId: SeatId | null; amount: number }
  | { type: 'UPGRADE_BUILT'; playerId: SeatId; squareId: SquareId; tier: UpgradeTier; cost: number }
  | { type: 'UPGRADE_SOLD'; playerId: SeatId; squareId: SquareId; tier: UpgradeTier; refund: number }
  | { type: 'CARD_DRAWN'; playerId: SeatId; deck: DeckType; cardId: number; cardNumber: number; totalCards: number }
  | { type: 'CARD_RESOLVED'; playerId: SeatId; deck: DeckType; cardId: number; description: string }
  | {
      type: 'CITY_OWNERS_CHARGED';
      playerId: SeatId;
      squareIds: readonly SquareId[];
      chargedPlayerIds: readonly SeatId[];
      totalCollected: number;
    }
  | { type: 'JAILED'; playerId: SeatId; turnsToMiss: number }
  | { type: 'RELEASED_FROM_JAIL'; playerId: SeatId; via: 'bail' | 'jail_free_card' | 'served' }
  | { type: 'PRISON_TURN_SKIPPED'; playerId: SeatId; remaining: number }
  | { type: 'CLUB_RESOLVED'; playerId: SeatId; choice: 'membership' | 'guest'; cost: number }
  | { type: 'DOUBLE_NEXT_ROLL_GRANTED'; playerId: SeatId }
  | { type: 'TURN_SKIPPED'; playerId: SeatId; reason: 'skip_next_turn' | 'in_prison' | 'inactive' }
  | { type: 'BANKRUPT'; playerId: SeatId; rule: 'eliminate' | 'jail' }
  | { type: 'PLAYER_KICKED'; playerId: SeatId; by: SeatId }
  | { type: 'GAME_OVER'; winnerId: SeatId | null }
  | { type: 'TRADE_OPENED'; tradeId: string; a: SeatId; b: SeatId }
  | { type: 'TRADE_STAGE_CHANGED'; tradeId: string; stage: string }
  | { type: 'TRADE_SETTLED'; tradeId: string; a: SeatId; b: SeatId }
  | { type: 'TRADE_CANCELLED'; tradeId: string; reason: string }
  | { type: 'BID_CREATED'; bidId: string; playerId: SeatId }
  | { type: 'BID_OFFER_ADDED'; bidId: string; offerId: string; playerId: SeatId }
  | { type: 'BID_SETTLED'; bidId: string; bidderId: SeatId; offererId: SeatId }
  | { type: 'BID_CANCELLED'; bidId: string };

export interface ActionResult {
  state: import('./types.js').GameState;
  events: DomainEvent[];
}
