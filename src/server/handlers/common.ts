/**
 * Shared handler plumbing.
 *
 * The single most important function here is {@link seated}. Every legacy
 * handler began with `manager.getRoom(roomCode)` and then used `socket.id` as
 * the player identity — that is, it trusted the *client's* `roomCode` to say
 * which game it was acting in. `seated` instead resolves the room and seat from
 * the server's own socket registry and ignores the payload's `roomCode`
 * entirely, so a client cannot address a room it is not seated in.
 *
 * This is the mechanical half of WIRE.md rule 2 ("the client never sends
 * state"): a payload may contribute an id, an amount, or a choice, and nothing
 * else reaches the reducer.
 */
import type { Socket } from 'socket.io';
import type { SeatId, SquareId } from '../../shared/types.js';
import type { ServerCtx } from '../context.js';
import type { Room, Seat } from '../rooms.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../wire.js';

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface Seated {
  room: Room;
  seat: Seat;
}

/** Where this socket is seated, or null. Never consults the client's payload. */
export function seated(ctx: ServerCtx, socket: TypedSocket): Seated | null {
  return ctx.rooms.locate(socket.id);
}

/** Seated AND in a room with a running game. */
export function inGame(ctx: ServerCtx, socket: TypedSocket): Seated | null {
  const at = seated(ctx, socket);
  if (at === null || at.room.state === null) return null;
  return at;
}

/** Coerce an untrusted wire value to a board id, or null. */
export function asSquareId(value: unknown): SquareId | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Coerce an untrusted wire value to a seat id, or null. */
export function asSeatId(value: unknown): SeatId | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
