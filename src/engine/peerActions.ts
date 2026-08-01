/**
 * Action executors for the PHASE-INDEPENDENT actions: trades, bids, sells to
 * the bank, the disconnect/reconnect/expiry housekeeping hooks, and the host
 * kick.
 *
 * These are deliberately phase-INDEPENDENT (the reducer still authorizes them —
 * by ownership for sells, by participation for trades/bids — but they never
 * change `state.phase`, bug B13). Bid results carry no events in bid.ts, so the
 * event construction happens here rather than being forwarded, unlike trade.ts.
 */

import {
  openTrade,
  proposeTrade,
  acceptTrade,
  declineTrade,
  cancelTrade,
  expireTrades,
} from './trade.js';
import { createBid, offerOnBid, acceptOffer, cancelBid, expireBids } from './bid.js';
import { kickPlayer } from './bankruptcy.js';
import { advanceTurn, turnHolder } from './turn.js';
import { playerById, requirePlayer } from './state.js';
import { sellUpgrade, sellPropertyToBank } from './property.js';
import type { Action, DomainEvent } from '../shared/actions.js';
import type { GameState } from '../shared/types.js';
import type { ExecResult, ReducerCtx } from './turnActions.js';

function ok(events: DomainEvent[]): ExecResult {
  return { ok: true, events };
}

// ── Sells to the bank (side effects only; never change the phase) ──

export function execSellUpgrade(
  state: GameState,
  action: Extract<Action, { type: 'SELL_UPGRADE' }>,
): ExecResult {
  const result = sellUpgrade(state, action.actorId, action.squareId);
  if (!result.ok) return { ok: false, reason: result.reason };
  const player = requirePlayer(state, action.actorId);
  return {
    ok: true,
    events: [
      { type: 'UPGRADE_SOLD', playerId: action.actorId, squareId: action.squareId, tier: result.tier, refund: result.refund },
      {
        type: 'MONEY_CHANGED',
        playerId: action.actorId,
        delta: result.refund,
        balance: player.money,
        reason: 'sell_upgrade',
      },
    ],
  };
}

export function execSellProperty(
  state: GameState,
  action: Extract<Action, { type: 'SELL_PROPERTY' }>,
): ExecResult {
  const result = sellPropertyToBank(state, action.actorId, action.squareId);
  if (!result.ok) return { ok: false, reason: result.reason };
  const player = requirePlayer(state, action.actorId);
  return {
    ok: true,
    events: [
      { type: 'PROPERTY_SOLD', playerId: action.actorId, squareId: action.squareId, refund: result.refund },
      {
        type: 'MONEY_CHANGED',
        playerId: action.actorId,
        delta: result.refund,
        balance: player.money,
        reason: 'sell_property',
      },
    ],
  };
}

// ── Trades ──

export function execTradeOpen(
  state: GameState,
  action: Extract<Action, { type: 'TRADE_OPEN' }>,
): ExecResult {
  const result = openTrade(state, action.actorId, action.partnerId, action.now);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok(result.events);
}

export function execTradePropose(
  state: GameState,
  action: Extract<Action, { type: 'TRADE_PROPOSE' }>,
): ExecResult {
  const result = proposeTrade(state, action.actorId, action.basket);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok(result.events);
}

export function execTradeAccept(
  state: GameState,
  action: Extract<Action, { type: 'TRADE_ACCEPT' }>,
): ExecResult {
  const result = acceptTrade(state, action.actorId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok(result.events);
}

export function execTradeDecline(
  state: GameState,
  action: Extract<Action, { type: 'TRADE_DECLINE' }>,
): ExecResult {
  const result = declineTrade(state, action.actorId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok(result.events);
}

export function execTradeCancel(
  state: GameState,
  action: Extract<Action, { type: 'TRADE_CANCEL' }>,
): ExecResult {
  const result = cancelTrade(state, action.actorId, 'user_cancelled');
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok(result.events);
}

// ── Bids ──

export function execBidCreate(
  state: GameState,
  action: Extract<Action, { type: 'BID_CREATE' }>,
): ExecResult {
  const result = createBid(state, action.actorId, action.basket, action.now);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok([{ type: 'BID_CREATED', bidId: result.value.id, playerId: action.actorId }]);
}

export function execBidOffer(
  state: GameState,
  action: Extract<Action, { type: 'BID_OFFER' }>,
): ExecResult {
  const result = offerOnBid(state, action.actorId, action.bidId, action.basket);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok([{ type: 'BID_OFFER_ADDED', bidId: action.bidId, offerId: result.value.id, playerId: action.actorId }]);
}

export function execBidAcceptOffer(
  state: GameState,
  action: Extract<Action, { type: 'BID_ACCEPT_OFFER' }>,
): ExecResult {
  const result = acceptOffer(state, action.actorId, action.bidId, action.offerId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok([
    { type: 'BID_SETTLED', bidId: action.bidId, bidderId: action.actorId, offererId: result.value.offer.playerId },
  ]);
}

export function execBidCancel(
  state: GameState,
  action: Extract<Action, { type: 'BID_CANCEL' }>,
): ExecResult {
  const result = cancelBid(state, action.actorId, action.bidId);
  if (!result.ok) return { ok: false, reason: result.reason };
  return ok([{ type: 'BID_CANCELLED', bidId: action.bidId }]);
}

// ── System hooks (server-authoritative; actorId is SYSTEM_ACTOR) ──

/** Mark the seat disconnected and sweep its trades/bids (B14). No turn effect. */
export function execPlayerDisconnected(
  state: GameState,
  action: Extract<Action, { type: 'PLAYER_DISCONNECTED' }>,
): ExecResult {
  const player = playerById(state, action.playerId);
  if (player === undefined) return { ok: false, reason: 'player_not_found' };
  player.connected = false;

  const events: DomainEvent[] = [];
  const trade = cancelTrade(state, action.playerId, 'disconnect');
  if (trade.ok) events.push(...trade.events);
  for (const bid of state.bids.filter((b) => b.playerId === action.playerId)) {
    events.push({ type: 'BID_CANCELLED', bidId: bid.id });
  }
  state.bids = state.bids.filter((b) => b.playerId !== action.playerId);
  return ok(events);
}

export function execPlayerReconnected(
  state: GameState,
  action: Extract<Action, { type: 'PLAYER_RECONNECTED' }>,
): ExecResult {
  const player = playerById(state, action.playerId);
  if (player === undefined) return { ok: false, reason: 'player_not_found' };
  player.connected = true;
  return ok([]);
}

/** Server-side sweep for stale trades and bids (B14). */
export function execExpireTrades(
  state: GameState,
  action: Extract<Action, { type: 'EXPIRE_TRADES' }>,
): ExecResult {
  const events: DomainEvent[] = [];
  events.push(...expireTrades(state, action.now, 'timeout').events);
  events.push(...expireBids(state, action.now).events);
  return ok(events);
}

/**
 * Host removes a seat. Bankruptcy module handles the money share, property
 * release and game-over check; this executor additionally sweeps the seat's
 * trade/bid and advances the turn if the kicked seat was mid-turn (B06 — the
 * array is never spliced, so indices stay valid).
 */
export function execKickPlayer(
  state: GameState,
  action: Extract<Action, { type: 'KICK_PLAYER' }>,
): ExecResult {
  const target = playerById(state, action.targetId);
  if (target === undefined) return { ok: false, reason: 'player_not_found' };
  if (action.targetId === action.actorId) return { ok: false, reason: 'not_the_entitled_player' };

  const events: DomainEvent[] = [...kickPlayer(state, action.targetId, action.actorId)];

  const trade = cancelTrade(state, action.targetId, 'kick');
  if (trade.ok) events.push(...trade.events);
  for (const bid of state.bids.filter((b) => b.playerId === action.targetId)) {
    events.push({ type: 'BID_CANCELLED', bidId: bid.id });
  }
  state.bids = state.bids.filter((b) => b.playerId !== action.targetId);

  if (!state.gameOver && turnHolder(state) === action.targetId) {
    events.push(...advanceTurn(state));
  }
  return ok(events);
}
