/**
 * Trade state machine — a pure function layer over `GameState.trades`.
 *
 * Nothing here touches sockets, `Math.random`, or `Date.now`. Every timestamp
 * comes in as a `now` parameter supplied by the caller (the reducer, which reads
 * it off the incoming `Action`), so this module is fully deterministic and
 * testable without faking the clock. `Result<T>` carries its own `events` —
 * unlike the sibling `engine/bid.ts`, `cancelTrade` here takes a caller-supplied
 * `reason` string that has nowhere else to go but onto the `TRADE_CANCELLED`
 * event, so every action reports its own events rather than making the reducer
 * reconstruct them from `value` alone.
 *
 * Stage machine: proposing_a → reviewing_b → proposing_b → reviewing_a → settled.
 * `a` proposes, `b` reviews (accept advances, decline bounces back to
 * proposing_a), `b` proposes, `a` reviews (accept settles, decline bounces back
 * to proposing_b). Whichever seat's proposal changes invalidates the other
 * seat's earlier acceptance — `acceptedA`/`acceptedB` mean "signs off on the
 * CURRENT pairing of baskets", not "signed off once, ever".
 *
 * B15 (atomicity): the old settlement decremented the giver with
 * `Math.max(0, n - k)` but credited the receiver unconditionally, so offering
 * more jail-free cards than you actually held CREATED a card from nothing. Here
 * BOTH baskets are fully re-validated — ownership, upgrades, cash, jail cards —
 * immediately before settlement, and nothing is mutated until both pass. A test
 * asserts total cash, total jail cards and the multiset of square owners are
 * unchanged (only redistributed) by a settlement.
 *
 * B12: a square carrying an upgrade cannot be offered — rejected with the typed
 * `property_has_upgrade` reason instead of being silently dropped from the
 * basket.
 *
 * B13: this module NEVER writes `state.phase`. Cancelling a trade must not be
 * able to corrupt whichever phase another player's turn happens to be in.
 *
 * B14: `expireTrades` is the hook disconnect/kick/bankruptcy/turn-advance call
 * to sweep out trades whose `expiresAt <= now`. Without it a stale trade makes
 * `findTradeFor` match forever and the seat can never trade again.
 *
 * B16: the trade-open rate limit is keyed on the stable `SeatId` — there is no
 * socket id anywhere in `GameState` to key it on instead. The counter lives in a
 * module-level `WeakMap` keyed by the `GameState` object itself (this codebase
 * mutates state in place rather than replacing it per action, so the same
 * object persists for the life of the game — including across a reconnect,
 * since the seat and the state object are unchanged). Keying on the state
 * object rather than a bare module-level `Map<SeatId, ...>` also means two
 * independent games never pollute each other's rate-limit counters, which a
 * single shared `Map` would.
 *
 * B18: `expiresAt` is computed from the caller-supplied `now` plus
 * `TRADE_TIMEOUT_SECONDS`. The server is the sole timer authority; nothing here
 * runs a countdown.
 */

import { TRADE_RATE_LIMIT, TRADE_RATE_WINDOW_MS, TRADE_TIMEOUT_SECONDS } from '../shared/rules.js';
import { isEmptyBasket } from '../shared/trading.js';
import type { RejectReason, DomainEvent } from '../shared/actions.js';
import type { Basket, GameState, SeatId, Trade, TradeStage } from '../shared/types.js';
import { isActive } from '../shared/types.js';
import { ownerOf, playerById, requirePlayer, setOwner, transfer, upgradeOf } from './state.js';

export type Result<T = undefined> =
  | { ok: true; events: DomainEvent[]; value: T }
  | { ok: false; reason: RejectReason };

function ok<T>(value: T, events: DomainEvent[]): Result<T> {
  return { ok: true, events, value };
}

function fail<T = undefined>(reason: RejectReason): Result<T> {
  return { ok: false, reason };
}

// ── Lookup ──

/** A seat may be in at most one trade at a time. */
export function findTradeFor(state: GameState, seatId: SeatId): Trade | undefined {
  return state.trades.find((t) => t.a === seatId || t.b === seatId);
}

function removeTrade(state: GameState, tradeId: string): void {
  state.trades = state.trades.filter((t) => t.id !== tradeId);
}

// ── Rate limiting (B16) ──

const tradeOpenLog = new WeakMap<GameState, Map<SeatId, number[]>>();

/** Prunes and returns the LIVE array backing this seat's rate-limit window. */
function openTimestamps(state: GameState, seatId: SeatId, now: number): number[] {
  let perGame = tradeOpenLog.get(state);
  if (perGame === undefined) {
    perGame = new Map();
    tradeOpenLog.set(state, perGame);
  }
  const pruned = (perGame.get(seatId) ?? []).filter((t) => now - t < TRADE_RATE_WINDOW_MS);
  perGame.set(seatId, pruned);
  return pruned;
}

// ── Basket validation ──

/**
 * Full validation of one seat's basket against CURRENT state: ownership,
 * upgrades (B12), cash, jail cards. Used both for early feedback at propose
 * time and, critically, again immediately before settlement (B15) since
 * ownership or funds may have moved in the interim. Never mutates anything —
 * callers only mutate after every basket involved has passed this check.
 */
function validateBasket(state: GameState, seatId: SeatId, basket: Basket): RejectReason | null {
  const player = requirePlayer(state, seatId);
  for (const squareId of basket.squareIds) {
    if (ownerOf(state, squareId) !== seatId) return 'basket_items_not_owned';
    if (upgradeOf(state, squareId) !== null) return 'property_has_upgrade';
  }
  if (basket.cash > player.money) return 'basket_not_affordable';
  if (basket.jailCards > player.inventory.jailFreeCards) return 'insufficient_jail_cards';
  return null;
}

// ── Actions ──

export function openTrade(
  state: GameState,
  initiatorId: SeatId,
  partnerId: SeatId,
  now: number,
): Result<Trade> {
  const initiator = playerById(state, initiatorId);
  const partner = playerById(state, partnerId);
  if (initiator === undefined || partner === undefined) return fail('player_not_found');
  // A seat cannot open a trade with itself — there is no dedicated reason for
  // this, so it reuses the closest fit: this actor is not entitled to the
  // trade it is asking for.
  if (initiatorId === partnerId) return fail('not_the_entitled_player');
  if (!isActive(initiator) || !isActive(partner)) return fail('player_inactive');
  if (findTradeFor(state, initiatorId) !== undefined) return fail('already_in_trade');
  if (findTradeFor(state, partnerId) !== undefined) return fail('already_in_trade');

  const recent = openTimestamps(state, initiatorId, now);
  if (recent.length >= TRADE_RATE_LIMIT) return fail('trade_rate_limited');
  recent.push(now);

  const trade: Trade = {
    id: `t-${now}-${initiatorId}-${partnerId}`,
    a: initiatorId,
    b: partnerId,
    stage: 'proposing_a',
    proposalA: null,
    proposalB: null,
    acceptedA: false,
    acceptedB: false,
    createdAt: now,
    expiresAt: now + TRADE_TIMEOUT_SECONDS * 1000,
  };
  state.trades = [...state.trades, trade];
  return ok(trade, [{ type: 'TRADE_OPENED', tradeId: trade.id, a: trade.a, b: trade.b }]);
}

export function proposeTrade(state: GameState, seatId: SeatId, basket: Basket): Result<Trade> {
  const trade = findTradeFor(state, seatId);
  if (trade === undefined) return fail('no_active_trade');
  const player = requirePlayer(state, seatId);
  if (!isActive(player)) return fail('player_inactive');

  const isProposingA = trade.stage === 'proposing_a' && trade.a === seatId;
  const isProposingB = trade.stage === 'proposing_b' && trade.b === seatId;
  if (!isProposingA && !isProposingB) return fail('trade_wrong_stage');

  const reason = validateBasket(state, seatId, basket);
  if (reason !== null) return fail(reason);

  let stage: TradeStage;
  if (isProposingA) {
    trade.proposalA = basket;
    trade.acceptedA = true;
    trade.acceptedB = false;
    stage = 'reviewing_b';
  } else {
    trade.proposalB = basket;
    trade.acceptedB = true;
    trade.acceptedA = false;
    stage = 'reviewing_a';
  }
  trade.stage = stage;
  return ok(trade, [{ type: 'TRADE_STAGE_CHANGED', tradeId: trade.id, stage }]);
}

export function acceptTrade(state: GameState, seatId: SeatId): Result<Trade> {
  const trade = findTradeFor(state, seatId);
  if (trade === undefined) return fail('no_active_trade');
  const player = requirePlayer(state, seatId);
  if (!isActive(player)) return fail('player_inactive');

  if (trade.stage === 'reviewing_b' && trade.b === seatId) {
    trade.acceptedB = true;
    trade.stage = 'proposing_b';
    return ok(trade, [{ type: 'TRADE_STAGE_CHANGED', tradeId: trade.id, stage: trade.stage }]);
  }

  if (trade.stage === 'reviewing_a' && trade.a === seatId) {
    const basketA = trade.proposalA;
    const basketB = trade.proposalB;
    if (basketA === null || basketB === null) return fail('trade_wrong_stage');
    if (isEmptyBasket(basketA) && isEmptyBasket(basketB)) return fail('empty_basket');

    // B15: re-validate BOTH sides in full, against current state, before ANY
    // mutation. Nothing below this point runs unless both baskets still hold.
    const reasonA = validateBasket(state, trade.a, basketA);
    if (reasonA !== null) return fail(reasonA);
    const reasonB = validateBasket(state, trade.b, basketB);
    if (reasonB !== null) return fail(reasonB);

    trade.acceptedA = true;
    settle(state, trade, basketA, basketB);
    trade.stage = 'settled';
    removeTrade(state, trade.id);
    return ok(trade, [{ type: 'TRADE_SETTLED', tradeId: trade.id, a: trade.a, b: trade.b }]);
  }

  return fail('trade_wrong_stage');
}

/** Moves both baskets atomically. Caller has already validated both in full. */
function settle(state: GameState, trade: Trade, basketA: Basket, basketB: Basket): void {
  const playerA = requirePlayer(state, trade.a);
  const playerB = requirePlayer(state, trade.b);

  if (basketA.cash > 0) transfer(playerA, playerB, basketA.cash);
  if (basketB.cash > 0) transfer(playerB, playerA, basketB.cash);

  playerA.inventory.jailFreeCards -= basketA.jailCards;
  playerB.inventory.jailFreeCards += basketA.jailCards;
  playerB.inventory.jailFreeCards -= basketB.jailCards;
  playerA.inventory.jailFreeCards += basketB.jailCards;

  for (const squareId of basketA.squareIds) setOwner(state, squareId, trade.b);
  for (const squareId of basketB.squareIds) setOwner(state, squareId, trade.a);
}

export function declineTrade(state: GameState, seatId: SeatId): Result<Trade> {
  const trade = findTradeFor(state, seatId);
  if (trade === undefined) return fail('no_active_trade');
  const player = requirePlayer(state, seatId);
  if (!isActive(player)) return fail('player_inactive');

  if (trade.stage === 'reviewing_b' && trade.b === seatId) {
    trade.stage = 'proposing_a';
    trade.proposalA = null;
    trade.acceptedA = false;
    trade.acceptedB = false;
    return ok(trade, [{ type: 'TRADE_STAGE_CHANGED', tradeId: trade.id, stage: trade.stage }]);
  }

  if (trade.stage === 'reviewing_a' && trade.a === seatId) {
    trade.stage = 'proposing_b';
    trade.proposalB = null;
    trade.acceptedA = false;
    trade.acceptedB = false;
    return ok(trade, [{ type: 'TRADE_STAGE_CHANGED', tradeId: trade.id, stage: trade.stage }]);
  }

  return fail('trade_wrong_stage');
}

/**
 * Tears the trade down unconditionally — used for explicit cancellation AND as
 * the cleanup primitive for disconnect/kick/bankruptcy. Deliberately does not
 * gate on `isActive`: an eliminated or bankrupt seat must still be able to have
 * its own trade cancelled out from under it. Never touches `state.phase` (B13).
 */
export function cancelTrade(state: GameState, seatId: SeatId, reason: string): Result<Trade> {
  const trade = findTradeFor(state, seatId);
  if (trade === undefined) return fail('no_active_trade');

  removeTrade(state, trade.id);
  return ok(trade, [{ type: 'TRADE_CANCELLED', tradeId: trade.id, reason }]);
}

/**
 * Sweeps out every trade whose `expiresAt <= now` (B14/B18). The caller is
 * responsible for invoking this on disconnect, kick, bankruptcy and
 * turn-advance so a stale trade can never permanently occupy a seat.
 */
export function expireTrades(
  state: GameState,
  now: number,
  reason: string,
): { state: GameState; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  const remaining: Trade[] = [];
  for (const trade of state.trades) {
    if (trade.expiresAt <= now) {
      events.push({ type: 'TRADE_CANCELLED', tradeId: trade.id, reason });
    } else {
      remaining.push(trade);
    }
  }
  state.trades = remaining;
  return { state, events };
}
