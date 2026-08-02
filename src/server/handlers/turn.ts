/**
 * Rolling and landing.
 *
 * `confirm_landing` deliberately ignores the `rollResult` the client sends. The
 * legacy handler read `rollResult.die1/die2/total` back off the wire purely to
 * write the log line — a client could therefore narrate a roll it never made.
 * The dice are already in `state.lastRoll`; the log comes from the `DICE_ROLLED`
 * domain event.
 */
import type { ServerCtx } from '../context.js';
import { debugTeleport, dispatch } from '../dispatch.js';
import { isHost } from '../rooms.js';
import { asSquareId, inGame, type TypedSocket } from './common.js';

export function registerTurnHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('roll_dice', (_p, cb) => {
    const at = inGame(ctx, socket);
    if (at === null) {
      cb?.({ ok: false });
      return;
    }
    const res = dispatch(ctx, at.room, { type: 'ROLL_DICE', actorId: at.seat.id });
    cb?.({ ok: res.ok });
  });

  socket.on('confirm_landing', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'CONFIRM_LANDING', actorId: at.seat.id });
  });

  /**
   * Host-only debug teleport. Kept because the legacy client exposes it, but
   * gated on host *and* on a real board id — the legacy version accepted any
   * `targetId` and fell back to square 1.
   */
  socket.on('debug_roll', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    if (!isHost(at.room, at.seat.id)) return;
    const target = asSquareId(p?.targetId) ?? 1;
    debugTeleport(ctx, at.room, at.seat.id, target);
  });
}
