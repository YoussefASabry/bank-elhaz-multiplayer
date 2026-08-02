/**
 * Server-side test harness: a recording `Emitter` and a `ServerCtx` built
 * around it, so the dispatch pipeline can be driven without a real socket.io
 * server or a real clock.
 *
 * Extends `tests/helpers/fixtures.ts` for game state rather than rebuilding it.
 */
import { createRng } from '../../src/engine/rng.js';
import type { GameState, SeatId } from '../../src/shared/types.js';
import type { Emitter, ServerCtx } from '../../src/server/context.js';
import type { Room, Seat } from '../../src/server/rooms.js';
import { RoomStore } from '../../src/server/rooms.js';
import type { VersionStore } from '../../src/server/versionStore.js';

export interface Sent {
  /** 'room' | socket id */
  target: string;
  except?: string;
  event: string;
  payload: unknown;
}

export interface Recorder extends Emitter {
  sent: Sent[];
  /** Every payload sent for an event, in order. */
  of: (event: string) => unknown[];
  /** Payloads sent specifically to one socket. */
  toOnly: (socketId: string, event: string) => unknown[];
  clear: () => void;
}

export function recorder(): Recorder {
  const sent: Sent[] = [];
  return {
    sent,
    toRoom(code, event, ...args) {
      sent.push({ target: `room:${code}`, event: String(event), payload: args[0] });
    },
    toSocket(socketId, event, ...args) {
      sent.push({ target: socketId, event: String(event), payload: args[0] });
    },
    toRoomExcept(code, exceptSocketId, event, ...args) {
      sent.push({
        target: `room:${code}`,
        except: exceptSocketId,
        event: String(event),
        payload: args[0],
      });
    },
    of(event) {
      return sent.filter((s) => s.event === event).map((s) => s.payload);
    },
    toOnly(socketId, event) {
      return sent.filter((s) => s.target === socketId && s.event === event).map((s) => s.payload);
    },
    clear() {
      sent.length = 0;
    },
  };
}

export function memoryVersionStore(initial: Record<string, number> = {}): VersionStore {
  const versions: Record<string, number> = { ...initial };
  return {
    getHighest: (roomCode) => versions[roomCode] ?? 0,
    recordSeen: (roomCode, version) => {
      if (version > (versions[roomCode] ?? 0)) versions[roomCode] = version;
    },
  };
}

export interface Harness {
  ctx: ServerCtx;
  emit: Recorder;
  rooms: RoomStore;
  /** Advance the injected clock. */
  advance: (ms: number) => void;
}

export function harness(opts: { now?: number; secret?: string } = {}): Harness {
  const emit = recorder();
  let clock = opts.now ?? 1_700_000_000_000;
  const ctx: ServerCtx = {
    rooms: new RoomStore(),
    emit,
    secret: Buffer.from(opts.secret ?? 'test-secret-test-secret-test-sec', 'utf8'),
    versions: memoryVersionStore(),
    now: () => clock,
    rng: (room) => room.rng,
  };
  return {
    ctx,
    emit,
    rooms: ctx.rooms,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * A room holding `state`, with one connected socket per seat. Socket ids are
 * `sock:<seatId>` so assertions read clearly.
 */
export function seatRoom(h: Harness, state: GameState, code = 'TEST'): Room {
  const room: Room = {
    code,
    seats: state.players.map(
      (p): Seat => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        connected: true,
        socketId: `sock:${p.id}`,
      }),
    ),
    kicked: new Set(),
    state,
    options: {},
    rng: createRng(42),
    turnTimer: null,
    tradeTimers: new Map(),
    tradeRequests: new Map(),
    lastSnapshotTurn: 0,
  };
  // Reach into the store so `locate`/`isLive` behave as in production.
  (h.rooms as unknown as { rooms: Map<string, Room> }).rooms.set(code, room);
  const bySocket = (
    h.rooms as unknown as { bySocket: Map<string, { roomCode: string; seatId: SeatId }> }
  ).bySocket;
  for (const seat of room.seats) {
    if (seat.socketId !== null) bySocket.set(seat.socketId, { roomCode: code, seatId: seat.id });
  }
  return room;
}

export function sock(seatId: SeatId): string {
  return `sock:${seatId}`;
}
