/**
 * Bid state machine.
 *
 * PURE over `GameState.bids`: no socket/io, no `Math.random`, no `Date.now` —
 * timestamps arrive as an explicit `now` parameter and ids are derived from the
 * inputs rather than a hidden counter. This module never touches `state.phase`;
 * turn/phase authorization is the reducer's job (src/engine/index.ts), not this
 * module's — bid.ts only enforces the domain rules around baskets and bid/offer
 * existence.
 *
 * Same defect class as trade.ts, fixed the same way:
 *
 *  - B15 sibling (atomicity): a basket is validated ENTIRELY — cash affordable,
 *    every square actually owned by the seat, no square carrying an upgrade,
 *    jail cards actually held — before anything is mutated. The old
 *    roomManager.js:829-839 did
 *    `bidder.inventory.jailFreeCards = (bidder.inventory.jailFreeCards || 0) - (bid.jailCards || 0)`
 *    with no check at all, which could drive a player's jail cards negative
 *    while crediting the other side — inventing cards from nothing. Here that
 *    is rejected with 'insufficient_jail_cards' before either side is touched.
 *  - B12 sibling: roomManager.js:744 and :782 silently filtered upgraded
 *    squares out of a basket, so the item just vanished with no feedback.
 *    Here offering an upgraded square is rejected with 'property_has_upgrade'.
 *  - Re-validated at ACCEPT time, not just at offer time: `acceptOffer`
 *    re-checks both baskets in full, since either side may have spent the
 *    cash, sold a square, or had a square upgraded between the offer and the
 *    acceptance. A stale offer is rejected, never settled on stale data.
 *
 * One active bid per seat is ENFORCED (`already_has_active_bid`), matching the
 * old roomManager.js:739-740 — the client renders one floating bid box per bid
 * positioned near its owner, so a second concurrent bid from the same seat would
 * overlap it. Cancelling or letting a bid expire both free the seat to bid again,
 * so a stale record can never lock a seat out for the rest of the game (the same
 * failure shape as trade bug B14).
 */

import type { GameState, Player, SeatId } from '../shared/types.js';
import { isActive } from '../shared/types.js';
import type { Basket, Bid, BidOffer } from '../shared/trading.js';
import { isEmptyBasket } from '../shared/trading.js';
import type { RejectReason, DomainEvent } from '../shared/actions.js';
import { playerById, ownerOf, upgradeOf, setOwner, transfer } from './state.js';
import { BID_TTL_MS } from '../shared/rules.js';

export type Result<T = void> = { ok: true; value: T } | { ok: false; reason: RejectReason };

// ── Basket validation ──

/**
 * Full validation of a basket against what `player` actually holds RIGHT NOW.
 * Returns the rejection reason, or null when the basket may be transferred as-is.
 * Never mutates anything — callers only mutate after every basket involved has
 * passed this check.
 */
function checkBasket(state: GameState, player: Player, basket: Basket): RejectReason | null {
  if (isEmptyBasket(basket)) return 'empty_basket';
  if (basket.cash < 0) return 'basket_not_affordable';
  if (basket.cash > player.money) return 'basket_not_affordable';
  if (basket.jailCards < 0) return 'insufficient_jail_cards';
  if (basket.jailCards > player.inventory.jailFreeCards) return 'insufficient_jail_cards';
  for (const squareId of basket.squareIds) {
    if (ownerOf(state, squareId) !== player.id) return 'basket_items_not_owned';
    if (upgradeOf(state, squareId) !== null) return 'property_has_upgrade';
  }
  return null;
}

/** Move both baskets between the two players. Only ever called after BOTH have passed checkBasket. */
function settleBaskets(state: GameState, bidder: Player, bidderBasket: Basket, offerer: Player, offererBasket: Basket): void {
  transfer(bidder, offerer, bidderBasket.cash);
  transfer(offerer, bidder, offererBasket.cash);

  for (const squareId of bidderBasket.squareIds) setOwner(state, squareId, offerer.id);
  for (const squareId of offererBasket.squareIds) setOwner(state, squareId, bidder.id);

  bidder.inventory.jailFreeCards -= bidderBasket.jailCards;
  offerer.inventory.jailFreeCards += bidderBasket.jailCards;
  offerer.inventory.jailFreeCards -= offererBasket.jailCards;
  bidder.inventory.jailFreeCards += offererBasket.jailCards;
}

// ── Actions ──

export function createBid(state: GameState, seatId: SeatId, basket: Basket, now: number): Result<Bid> {
  const player = playerById(state, seatId);
  if (player === undefined) return { ok: false, reason: 'player_not_found' };
  if (!isActive(player)) return { ok: false, reason: 'player_inactive' };

  // One open bid per seat. The old implementation enforced this
  // (roomManager.js:739-740), and the client renders one floating box per bid
  // positioned near its owner — so allowing two would stack them on top of each
  // other. Dropping the rule would be a regression, not a simplification.
  if (state.bids.some((b) => b.playerId === seatId)) {
    return { ok: false, reason: 'already_has_active_bid' };
  }

  const basketErr = checkBasket(state, player, basket);
  if (basketErr !== null) return { ok: false, reason: basketErr };

  const bid: Bid = {
    id: `bid-${now}-${seatId}-${state.bids.length}`,
    playerId: seatId,
    basket,
    offers: [],
    createdAt: now,
  };
  state.bids.push(bid);
  return { ok: true, value: bid };
}

export function offerOnBid(state: GameState, seatId: SeatId, bidId: string, basket: Basket): Result<BidOffer> {
  const bid = state.bids.find((b) => b.id === bidId);
  if (bid === undefined) return { ok: false, reason: 'no_such_bid' };
  if (bid.playerId === seatId) return { ok: false, reason: 'cannot_bid_on_own' };

  const player = playerById(state, seatId);
  if (player === undefined) return { ok: false, reason: 'player_not_found' };
  if (!isActive(player)) return { ok: false, reason: 'player_inactive' };

  const basketErr = checkBasket(state, player, basket);
  if (basketErr !== null) return { ok: false, reason: basketErr };

  const offer: BidOffer = {
    id: `offer-${bidId}-${bid.offers.length}`,
    playerId: seatId,
    basket,
  };
  bid.offers.push(offer);
  return { ok: true, value: offer };
}

/** Only the bid's own creator may accept an offer on it. Settles and removes the bid. */
export function acceptOffer(
  state: GameState,
  bidderId: SeatId,
  bidId: string,
  offerId: string,
): Result<{ bid: Bid; offer: BidOffer }> {
  const bidIndex = state.bids.findIndex((b) => b.id === bidId);
  if (bidIndex === -1) return { ok: false, reason: 'no_such_bid' };
  const bid = state.bids[bidIndex]!;
  if (bid.playerId !== bidderId) return { ok: false, reason: 'not_the_owner' };

  const offer = bid.offers.find((o) => o.id === offerId);
  if (offer === undefined) return { ok: false, reason: 'no_such_offer' };

  const bidder = playerById(state, bid.playerId);
  const offerer = playerById(state, offer.playerId);
  if (bidder === undefined || offerer === undefined) return { ok: false, reason: 'player_not_found' };
  if (!isActive(bidder) || !isActive(offerer)) return { ok: false, reason: 'player_inactive' };

  // Re-validate both baskets against CURRENT state — either side may have spent
  // cash, sold a square, or had a square upgraded since the offer was made.
  const bidderErr = checkBasket(state, bidder, bid.basket);
  if (bidderErr !== null) return { ok: false, reason: bidderErr };
  const offererErr = checkBasket(state, offerer, offer.basket);
  if (offererErr !== null) return { ok: false, reason: offererErr };

  settleBaskets(state, bidder, bid.basket, offerer, offer.basket);
  state.bids.splice(bidIndex, 1);
  return { ok: true, value: { bid, offer } };
}

export function cancelBid(state: GameState, seatId: SeatId, bidId: string): Result<Bid> {
  const bidIndex = state.bids.findIndex((b) => b.id === bidId);
  if (bidIndex === -1) return { ok: false, reason: 'no_such_bid' };
  const bid = state.bids[bidIndex]!;
  if (bid.playerId !== seatId) return { ok: false, reason: 'not_the_owner' };

  state.bids.splice(bidIndex, 1);
  return { ok: true, value: bid };
}

/** Drop every bid whose TTL has elapsed, oldest rule first. Batch, so it reports its own events. */
export function expireBids(state: GameState, now: number): { state: GameState; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  const remaining: Bid[] = [];
  for (const bid of state.bids) {
    if (now - bid.createdAt >= BID_TTL_MS) {
      events.push({ type: 'BID_CANCELLED', bidId: bid.id });
    } else {
      remaining.push(bid);
    }
  }
  state.bids = remaining;
  return { state, events };
}
