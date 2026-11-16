/**
 * Room lifecycle, seats, host, join / rejoin / disconnect.
 *
 * The one structural change from `roomManager.js`: **a seat id is not a socket
 * id.** The legacy manager used `socket.id` as the player's identity and wrote
 * it into game state, so every reconnect had to rewrite that id everywhere it
 * had been copied — and it missed six places (`activeBids`, `bid.offers`,
 * `trades`, `pendingClubChoice`, `pendingUpgradeChoice`, `lastRoll`), which is
 * why after a reconnect your own dialog stopped responding (bug B20).
 *
 * Here a `Seat` owns a stable `SeatId` minted once at join, plus a *mutable*
 * `socketId` that is the only thing a reconnect touches. `GameState` never sees
 * a socket id, so there is nothing to remap and B20 cannot be written.
 *
 * This module holds no timers and emits nothing — `turnTimer.ts` owns the
 * former and the handlers own the latter. It is the registry, not the server.
 */
import { randomUUID } from 'node:crypto';
import type { GameState, SeatId } from '../shared/types.js';
import { MAX_PLAYERS_HARD_CAP } from '../shared/rules.js';
import type { Rng } from '../engine/rng.js';
import { createRng } from '../engine/rng.js';
import type { WirePlayer, WireRoomOptions } from './wire.js';

export interface Seat {
  /** Stable for the lifetime of the game. Never a socket id. */
  id: SeatId;
  name: string;
  avatar: number;
  connected: boolean;
  /** The live transport. Null while disconnected. */
  socketId: string | null;
}

export interface Room {
  code: string;
  /** Ordered. `seats[0]` is the host — there is no `isHost` flag to fall out of sync. */
  seats: Seat[];
  /** Names kicked by the host, so they cannot walk back in through `join_game`. */
  kicked: Set<string>;
  state: GameState | null;
  options: WireRoomOptions;
  rng: Rng;
  /** Owned by turnTimer.ts; parked here so the room is the single lifetime root. */
  turnTimer: NodeJS.Timeout | null;
  tradeTimers: Map<string, NodeJS.Timeout>;
  /**
   * Outstanding trade invitations, `target seat → initiator seat`.
   *
   * The legacy `accept_trade_request` handler took the `initiatorId` straight
   * off the wire and opened a trade with it, so any player could force a trade
   * dialog onto any other by naming them as the "initiator" of a request that
   * was never sent. Recording the invitation server-side closes that.
   */
  tradeRequests: Map<SeatId, SeatId>;
  /** Highest turnNumber a snapshot was issued for, to avoid re-signing per broadcast. */
  lastSnapshotTurn: number;
}

export type JoinResult =
  | { ok: true; room: Room; seat: Seat; rejoined: boolean }
  | { ok: false; error: string };

function generateRoomCode(rooms: ReadonlyMap<string, Room>): string {
  let code: string;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  /** socketId → where that socket is seated. Rebuilt on every (re)connect. */
  private readonly bySocket = new Map<string, { roomCode: string; seatId: SeatId }>();

  // ── lookup ──

  get(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  has(code: string): boolean {
    return this.rooms.has(code);
  }

  /** A room that exists AND has a game running — what "live" means for restore. */
  isLive(code: string): boolean {
    const room = this.rooms.get(code);
    return room !== undefined && room.state !== null;
  }

  locate(socketId: string): { room: Room; seat: Seat } | null {
    const at = this.bySocket.get(socketId);
    if (at === undefined) return null;
    const room = this.rooms.get(at.roomCode);
    if (room === undefined) return null;
    const seat = room.seats.find((s) => s.id === at.seatId);
    if (seat === undefined) return null;
    return { room, seat };
  }

  seatOf(room: Room, seatId: SeatId): Seat | undefined {
    return room.seats.find((s) => s.id === seatId);
  }

  /** Every live socket in a room — used to fan out per-viewer projections. */
  socketsOf(room: Room): { socketId: string; seatId: SeatId }[] {
    const out: { socketId: string; seatId: SeatId }[] = [];
    for (const seat of room.seats) {
      if (seat.socketId !== null) out.push({ socketId: seat.socketId, seatId: seat.id });
    }
    return out;
  }

  // ── lifecycle ──

  create(hostName: string, avatar: number, socketId: string, options: WireRoomOptions): Room {
    const code = generateRoomCode(this.rooms);
    const seat: Seat = {
      id: `seat-${randomUUID()}`,
      name: hostName,
      avatar: avatar || 1,
      connected: true,
      socketId,
    };
    const room: Room = {
      code,
      seats: [seat],
      kicked: new Set(),
      state: null,
      options,
      rng: createRng(Date.now() & 0x7fffffff),
      turnTimer: null,
      tradeTimers: new Map(),
      tradeRequests: new Map(),
      lastSnapshotTurn: 0,
    };
    this.rooms.set(code, room);
    this.bySocket.set(socketId, { roomCode: code, seatId: seat.id });
    return room;
  }

  /**
   * Rebuild an empty room around a restored snapshot. Seats are recreated from
   * the snapshot's players so their ids match the ids inside the restored
   * `GameState` — if these drifted, every ownership record would point at a
   * seat that no longer exists.
   */
  createFromState(code: string, state: GameState, options: WireRoomOptions): Room | null {
    if (this.rooms.has(code)) return null;
    const room: Room = {
      code,
      seats: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        connected: false,
        socketId: null,
      })),
      kicked: new Set(),
      state,
      options,
      rng: createRng(Date.now() & 0x7fffffff),
      turnTimer: null,
      tradeTimers: new Map(),
      tradeRequests: new Map(),
      lastSnapshotTurn: state.turnNumber,
    };
    this.rooms.set(code, room);
    return room;
  }

  join(code: string, name: string, avatar: number, socketId: string): JoinResult {
    const room = this.rooms.get(code);
    if (room === undefined) return { ok: false, error: 'Room not found' };
    if (room.kicked.has(name)) return { ok: false, error: 'You were removed from this game' };

    // A disconnected seat with this name is a reconnect, not a new player —
    // this is how the legacy lobby behaved and the client relies on it.
    const existing = room.seats.find((s) => s.name === name && !s.connected);
    if (existing !== undefined) {
      this.attach(room, existing, socketId);
      return { ok: true, room, seat: existing, rejoined: true };
    }

    if (room.state !== null) return { ok: false, error: 'Game already started' };
    if (room.seats.length >= MAX_PLAYERS_HARD_CAP) {
      return { ok: false, error: `Room is full (max ${MAX_PLAYERS_HARD_CAP})` };
    }
    if (room.seats.some((s) => s.name === name)) return { ok: false, error: 'Already in room' };

    const seat: Seat = {
      id: `seat-${randomUUID()}`,
      name,
      avatar: avatar || 1,
      connected: true,
      socketId,
    };
    room.seats.push(seat);
    this.bySocket.set(socketId, { roomCode: code, seatId: seat.id });
    return { ok: true, room, seat, rejoined: false };
  }

  /**
   * Point an existing seat at a new socket. The ONLY mutation a reconnect
   * performs — contrast with the legacy six-field id rewrite (B20).
   */
  attach(room: Room, seat: Seat, socketId: string): void {
    if (seat.socketId !== null) this.bySocket.delete(seat.socketId);
    seat.socketId = socketId;
    seat.connected = true;
    this.bySocket.set(socketId, { roomCode: room.code, seatId: seat.id });
    const player = room.state?.players.find((p) => p.id === seat.id);
    if (player !== undefined) player.connected = true;
  }

  /** Find a seat eligible for `rejoin_game`: same name, currently disconnected. */
  findRejoinable(room: Room, name: string): Seat | undefined {
    return room.seats.find((s) => s.name === name && !s.connected);
  }

  /** Find a seat by name regardless of connection state (snapshot restore). */
  findByName(room: Room, name: string): Seat | undefined {
    return room.seats.find((s) => s.name === name);
  }

  markDisconnected(room: Room, seat: Seat): void {
    if (seat.socketId !== null) this.bySocket.delete(seat.socketId);
    seat.socketId = null;
    seat.connected = false;
  }

  /**
   * Remove a seat outright. Only legal before the game starts — once a game
   * exists, a departing player is marked disconnected and their `Player` is
   * flagged `eliminated` instead, because splicing the players array shifts
   * `currentPlayerIndex` and corrupts turn order (bug B06).
   */
  removeSeat(room: Room, seat: Seat): void {
    if (seat.socketId !== null) this.bySocket.delete(seat.socketId);
    room.seats = room.seats.filter((s) => s.id !== seat.id);
  }

  destroy(code: string): void {
    const room = this.rooms.get(code);
    if (room === undefined) return;
    if (room.turnTimer !== null) clearInterval(room.turnTimer);
    for (const t of room.tradeTimers.values()) clearTimeout(t);
    room.tradeTimers.clear();
    for (const seat of room.seats) {
      if (seat.socketId !== null) this.bySocket.delete(seat.socketId);
    }
    this.rooms.delete(code);
  }

  /** True when nobody is still connected — the caller decides whether to destroy. */
  isDeserted(room: Room): boolean {
    return room.seats.every((s) => !s.connected);
  }
}

/** The lobby view of the seats, in the exact shape the legacy server sent. */
export function wirePlayers(room: Room): WirePlayer[] {
  return room.seats.map((s) => ({
    id: s.id,
    name: s.name,
    avatar: s.avatar,
    connected: s.connected,
  }));
}

export function isHost(room: Room, seatId: SeatId): boolean {
  return room.seats[0]?.id === seatId;
}
