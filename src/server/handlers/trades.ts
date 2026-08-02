/**
 * Trades: the invitation handshake, then the four-stage proposal machine.
 *
 * The handshake (`trade_request` → `accept_trade_request` /
 * `decline_trade_request`) carries no game state and never reaches the reducer;
 * it exists to get both players' consent before a `Trade` is created. Only
 * `accept_trade_request` produces an action.
 *
 * Two legacy holes are closed here:
 *
 *  - **Forged invitations.** `accept_trade_request` took `initiatorId` off the
 *    wire and opened a trade with whoever it named, so any player could
 *    conjure a trade dialog on any other. The invitation is now recorded in
 *    `room.tradeRequests` when it is *sent*, and accepting checks it.
 *
 *  - **B13 / B18.** Cancelling used to write `phase = 'rent_payment'` from
 *    outside the turn, corrupting the phase for whoever was actually playing;
 *    and the client ran a 65s countdown against the server's 60s, so the
 *    client's own expiry fired that corrupting cancel. `TRADE_CANCEL` cannot
 *    touch `phase` (asserted in the engine), and the deadline is server-owned.
 */
import { TRADE_RATE_WINDOW_MS } from '../../shared/rules.js';
import type { ServerCtx } from '../context.js';
import { fromWireBasket, playerName } from '../context.js';
import { dispatch } from '../dispatch.js';
import { asSeatId, inGame, type TypedSocket } from './common.js';

export function registerTradeHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('trade_request', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;
    const state = room.state;
    if (state === null) return;

    const targetId = asSeatId(p?.targetId);
    const target = targetId === null ? undefined : state.players.find((q) => q.id === targetId);
    const me = state.players.find((q) => q.id === seat.id);
    if (targetId === null || target === undefined || me === undefined) {
      socket.emit('trade_error', { message: 'Trade could not be started' });
      return;
    }
    if (targetId === seat.id || target.isBankrupt || target.eliminated || me.isBankrupt) {
      socket.emit('trade_error', { message: 'Trade could not be started' });
      return;
    }
    // Mirror the reducer's `trade_window` entitlement so the requester gets a
    // useful message instead of a silent refusal three steps later.
    if (state.config.tradeTiming === 'own_turn') {
      const holder = state.players[state.currentPlayerIndex];
      if (holder === undefined || holder.id !== seat.id) {
        socket.emit('trade_error', { message: '⏳ You can only trade on your own turn' });
        return;
      }
    }

    room.tradeRequests.set(targetId, seat.id);
    const targetSocket = ctx.rooms.seatOf(room, targetId)?.socketId ?? null;
    if (targetSocket !== null) {
      ctx.emit.toSocket(targetSocket, 'trade_request_notify', {
        initiatorId: seat.id,
        initiatorName: me.name,
        initiatorAvatar: me.avatar,
      });
    }
    socket.emit('trade_request_sent', { partnerName: target.name });
    ctx.emit.toRoom(room.code, 'action_log', {
      message: `🤝 ${me.name} sent a trade request to ${target.name}`,
    });
  });

  socket.on('accept_trade_request', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;
    const state = room.state;
    if (state === null) return;

    const claimed = asSeatId(p?.initiatorId);
    const recorded = room.tradeRequests.get(seat.id) ?? null;
    // Only an invitation this server actually delivered may be accepted.
    if (recorded === null || (claimed !== null && claimed !== recorded)) {
      socket.emit('trade_error', { message: 'Trade could not be started' });
      return;
    }
    room.tradeRequests.delete(seat.id);

    // The INITIATOR is side `a`, matching the legacy `initTrade(initiator, accepter)`
    // ordering the client's dialog is built around.
    const res = dispatch(ctx, room, {
      type: 'TRADE_OPEN',
      actorId: recorded,
      partnerId: seat.id,
      now: ctx.now(),
    });

    if (!res.ok) {
      const reason = res.events.find((e) => e.type === 'REJECTED');
      const rateLimited = reason?.type === 'REJECTED' && reason.reason === 'trade_rate_limited';
      // The legacy message carried an exact `waitSec`. The engine's rate-limit
      // window lives in a module-private WeakMap (trade.ts:86) — deliberately
      // outside GameState so it never reaches a snapshot — so the exact
      // remaining time is not reachable from here. The `{message: string}`
      // shape is unchanged; only the wording is less precise. Flagged in the
      // handover: `REJECTED` should carry the figure.
      socket.emit('trade_error', {
        message: rateLimited
          ? `⏳ Wait up to ${Math.round(TRADE_RATE_WINDOW_MS / 1000)}s before trading again`
          : 'Trade could not be started',
      });
    }
  });

  socket.on('decline_trade_request', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;
    const state = room.state;
    if (state === null) return;

    const recorded = room.tradeRequests.get(seat.id) ?? asSeatId(p?.initiatorId);
    room.tradeRequests.delete(seat.id);
    if (recorded === null) return;

    const myName = playerName(state, seat.id);
    const initiatorSocket = ctx.rooms.seatOf(room, recorded)?.socketId ?? null;
    if (initiatorSocket !== null) {
      ctx.emit.toSocket(initiatorSocket, 'trade_request_declined', { partnerName: myName });
    }
    ctx.emit.toRoom(room.code, 'action_log', {
      message: `❌ ${myName} declined the trade request`,
    });
  });

  socket.on('trade_send_proposal', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, {
      type: 'TRADE_PROPOSE',
      actorId: at.seat.id,
      basket: fromWireBasket(p ?? {}),
    });
  });

  socket.on('trade_accept_proposal', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'TRADE_ACCEPT', actorId: at.seat.id });
  });

  socket.on('trade_decline_proposal', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'TRADE_DECLINE', actorId: at.seat.id });
  });

  socket.on('trade_cancel', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'TRADE_CANCEL', actorId: at.seat.id });
  });
}
