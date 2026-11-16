/**
 * Trade and bid shapes.
 *
 * Split out of types.ts to keep every file under the 400-line ceiling.
 *
 * A `Basket` is validated and transferred ATOMICALLY. The old settlement
 * decremented the giver with `Math.max(0, n - k)` but credited the receiver
 * unconditionally, so trading more jail cards than you held CREATED cards out of
 * nothing (bug B15). Here, a basket is checked in full before any mutation and an
 * unaffordable basket is rejected outright.
 */

import type { SeatId, SquareId } from './types.js';

export interface Basket {
  cash: number;
  squareIds: readonly SquareId[];
  jailCards: number;
}

export function isEmptyBasket(b: Basket): boolean {
  return b.cash <= 0 && b.squareIds.length === 0 && b.jailCards <= 0;
}

/**
 * proposing_a → reviewing_b → proposing_b → reviewing_a → settled.
 * Declining bounces back one stage rather than tearing the trade down.
 */
export type TradeStage =
  | 'proposing_a'
  | 'reviewing_b'
  | 'proposing_b'
  | 'reviewing_a'
  | 'settled';

export interface Trade {
  id: string;
  a: SeatId;
  b: SeatId;
  stage: TradeStage;
  proposalA: Basket | null;
  proposalB: Basket | null;
  acceptedA: boolean;
  acceptedB: boolean;
  createdAt: number;
  /**
   * Server-authoritative. The client previously ran its own 65s countdown against
   * the server's 60s and emitted `trade_cancel` on its own expiry, which tripped
   * the phase-corrupting cancel path (bugs B18 + B13).
   */
  expiresAt: number;
}

export interface BidOffer {
  id: string;
  playerId: SeatId;
  basket: Basket;
}

export interface Bid {
  id: string;
  playerId: SeatId;
  basket: Basket;
  offers: BidOffer[];
  createdAt: number;
}
