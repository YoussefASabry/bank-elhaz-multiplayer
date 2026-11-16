/**
 * Public bids.
 *
 * The legacy handlers clamped baskets themselves (`Math.min(cash, player.money)`,
 * filter propIds by ownership) and then executed the swap with a *different*
 * set of checks in `acceptBidOffer`. `bid.ts` in the engine validates a basket
 * once, in full, before any transfer — and re-validates BOTH baskets at accept
 * time, because either side may have spent cash or sold a square since the
 * offer was made. So these handlers do no clamping at all: an unaffordable
 * basket is rejected outright rather than silently shrunk to what you can
 * afford, which is what let a player "offer" more jail cards than they held and
 * mint them out of nothing (bug B15).
 */
import type { ServerCtx } from '../context.js';
import { fromWireBasket } from '../context.js';
import { dispatch } from '../dispatch.js';
import { asString, inGame, type TypedSocket } from './common.js';

export function registerBidHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('create_bid', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, {
      type: 'BID_CREATE',
      actorId: at.seat.id,
      basket: fromWireBasket(p ?? {}),
      now: ctx.now(),
    });
  });

  socket.on('bid_respond', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const bidId = asString(p?.bidId);
    if (bidId === null) return;
    dispatch(ctx, at.room, {
      type: 'BID_OFFER',
      actorId: at.seat.id,
      bidId,
      basket: fromWireBasket(p),
    });
  });

  socket.on('bid_accept_offer', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const bidId = asString(p?.bidId);
    const offerId = asString(p?.offerId);
    if (bidId === null || offerId === null) return;
    dispatch(ctx, at.room, {
      type: 'BID_ACCEPT_OFFER',
      actorId: at.seat.id,
      bidId,
      offerId,
    });
  });

  socket.on('cancel_bid', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const bidId = asString(p?.bidId);
    if (bidId === null) return;
    dispatch(ctx, at.room, { type: 'BID_CANCEL', actorId: at.seat.id, bidId });
  });
}
