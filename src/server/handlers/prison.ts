/**
 * Prison: serve, pay bail, or spend a jail-free card.
 *
 * B03 lived here. The legacy handler was:
 *
 *     socket.on('use_jail_free', ({ roomCode }) => {
 *       manager.useJailFreeCard(roomCode, socket.id);   // ← no such method
 *
 * `RoomManager` had no `useJailFreeCard`, so pressing the button threw a
 * TypeError inside the socket callback, killed the handler, and left the player
 * stuck in prison holding a card that did nothing. There is now exactly one
 * implementation, `turn.ts:useJailFreeCard`, reached through `USE_JAIL_FREE`,
 * and the reducer's authorization table has an entry for it — which is what
 * makes "the action exists but nothing handles it" unrepresentable.
 */
import type { ServerCtx } from '../context.js';
import { dispatch } from '../dispatch.js';
import { inGame, type TypedSocket } from './common.js';

export function registerPrisonHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('skip_prison', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'SKIP_PRISON_TURN', actorId: at.seat.id });
  });

  socket.on('pay_bail', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'PAY_BAIL', actorId: at.seat.id });
  });

  socket.on('use_jail_free', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'USE_JAIL_FREE', actorId: at.seat.id });
  });
}
