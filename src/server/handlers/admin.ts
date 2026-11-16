/**
 * Host administration and disconnects.
 *
 * B06 is the story here. The legacy kick did:
 *
 *     const gsIdx = gs.players.findIndex(p => p.id === targetId);
 *     if (gsIdx !== -1) gs.players.splice(gsIdx, 1);
 *
 * — splicing the *running turn order* while `currentPlayerIndex` kept pointing
 * at a slot that now held a different player. Kick someone before the current
 * player and the turn silently jumped; kick the last player while they were up
 * and the index dangled past the end and the game froze.
 *
 * `kickPlayer` in the engine marks `eliminated` and never splices, so indices
 * are stable. The seat is still removed from the *lobby* list, which is a
 * separate array, so the wire payload the client receives is unchanged.
 */
import { SYSTEM_ACTOR } from '../../shared/actions.js';
import type { ServerCtx } from '../context.js';
import { dispatch } from '../dispatch.js';
import { isHost, wirePlayers } from '../rooms.js';
import { asSeatId, seated, type TypedSocket } from './common.js';

export function registerAdminHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('terminate_player', (p) => {
    const at = seated(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;
    if (!isHost(room, seat.id)) return;

    const targetId = asSeatId(p?.targetId);
    if (targetId === null || targetId === seat.id) return;
    const target = ctx.rooms.seatOf(room, targetId);
    if (target === undefined) return;

    room.kicked.add(target.name);

    if (room.state === null) {
      // Lobby: just drop the seat.
      ctx.rooms.removeSeat(room, target);
      ctx.emit.toRoom(room.code, 'update_players', { players: wirePlayers(room) });
      return;
    }

    const targetSocket = target.socketId;
    dispatch(ctx, room, { type: 'KICK_PLAYER', actorId: seat.id, targetId });
    // Drop the lobby seat only after the action: `dispatch` broadcasts, and the
    // kicked player should receive that final state before losing their seat.
    ctx.rooms.removeSeat(room, target);
    ctx.emit.toRoom(room.code, 'player_terminated', {
      targetId,
      players: wirePlayers(room),
    });
    if (targetSocket !== null) {
      ctx.emit.toSocket(targetSocket, 'player_terminated', {
        targetId,
        players: wirePlayers(room),
      });
    }
  });

  socket.on('disconnect', () => {
    const at = seated(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;

    if (room.state === null) {
      // Lobby: remove entirely, exactly as the legacy server did.
      ctx.rooms.removeSeat(room, seat);
      ctx.emit.toRoom(room.code, 'update_players', { players: wirePlayers(room) });
      if (room.seats.length === 0) ctx.rooms.destroy(room.code);
      return;
    }

    ctx.rooms.markDisconnected(room, seat);
    ctx.emit.toRoom(room.code, 'player_disconnected', {
      playerId: seat.id,
      players: wirePlayers(room),
      connected: false,
    });

    // Tell the engine, so `connected` is right in every projection.
    dispatch(ctx, room, {
      type: 'PLAYER_DISCONNECTED',
      actorId: SYSTEM_ACTOR,
      playerId: seat.id,
    });

    // If they were on the clock, don't make the table wait out the full timer.
    const state = room.state;
    const holder = state.players[state.currentPlayerIndex];
    if (holder !== undefined && holder.id === seat.id && !state.gameOver) {
      dispatch(ctx, room, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    }

    if (ctx.rooms.isDeserted(room)) ctx.rooms.destroy(room.code);
  });
}
