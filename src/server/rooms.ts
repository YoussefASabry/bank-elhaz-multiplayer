/**
 * Room lifecycle and seat membership (plan §Phase 4).
 *
 * Two design rules, both inherited from the shared types:
 *
 * 1. SEATS, NOT SOCKETS. A player is a `SeatId` assigned once at join and never
 *    changed; `socketBySeat` is the only place socket ids appear, and it is room
 *    transport metadata, never `GameState` (bug B20: the old server stored
 *    `socket.id` in state and remapped six fields on rejoin, missing several).
 *    Reconnecting is now just "bind this socket to that seat".
 *
 * 2. ONE mutation path. `applyToRoom` is the only function here that mutates
 *    game state; it threads `{ rng, now }` through the engine reducer, so the
 *    engine's determinism contract (no `Math.random`/`Date.now` in src/engine)
 *    holds and every action is server-authoritative. Handlers never touch
 *    `room.state` directly.
 *
 * Lobby bounds (min/max players) come from the board data, never literals
 * (bug B32: the server hardcoded 2 while the data said 3).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { createRng } from '../engine/rng.js';
import { createGame, applyAction } from '../engine/index.js';
import { loadBoard } from '../engine/board.js';
import type { Rng } from '../engine/rng.js';
import type { GameConfig, GameState, SeatId } from '../shared/types.js';
import type { Action, ActionResult } from '../shared/actions.js';
import type { RoomOptions } from '../shared/events.js';

export interface RoomSeatInput {
  id: SeatId;
  name: string;
  avatar: number;
}

export interface RoomSeat extends RoomSeatInput {
  connected: boolean;
  isHost: boolean;
}

export interface Room {
  code: string;
  options: RoomOptions;
  seats: RoomSeat[];
  state: GameState | null;
  /** One Rng per room, seeded at game start; consumed by every applyToRoom. */
  rng: Rng | null;
  /** seatId → socket id. The ONLY socket ids on the server. */
  socketBySeat: Map<SeatId, string>;
}

export interface RoomManager {
  createRoom(host: RoomSeatInput, options: RoomOptions): Room;
  joinRoom(code: string, seat: RoomSeatInput): { ok: true; room: Room } | { ok: false; error: string };
  getRoom(code: string): Room | undefined;
  seatById(room: Room, seatId: SeatId): RoomSeat | undefined;
  /** True when the seat has exactly this socket bound (the sender check). */
  isBound(room: Room, seatId: SeatId, socketId: string): boolean;
  bindSocket(room: Room, seatId: SeatId, socketId: string): void;
  /** Detach a socket from whatever seat held it; returns that seat id, if any. */
  releaseSocket(code: string, socketId: string): SeatId | null;
  leaveRoom(code: string, seatId: SeatId): { room: Room | undefined; empty: boolean };
  destroyRoom(code: string): void;
  startGame(code: string, seed?: number): { ok: true; room: Room } | { ok: false; error: string };
  /** Install a pre-existing state (snapshot restore, tests). Never mutates it. */
  installState(code: string, state: GameState): Room;
  applyToRoom(room: Room, action: Action): ActionResult;
  all(): Room[];
  minPlayers(): number;
  maxPlayers(): number;
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** A seat id is an unguessable token: clients present it to rejoin (B20). */
export function generateSeatId(): SeatId {
  return `s-${randomBytes(9).toString('hex')}`;
}

function randomSeed(): number {
  return randomInt(1, 0x7fffffff);
}

function toGameConfig(options: RoomOptions, boardMeta: { startingCash: number; passGoSalary: number }): Partial<GameConfig> {
  const overrides: Partial<GameConfig> = {};
  // B31: salary/starting-cash resolve as options ?? board data, one path only.
  if (typeof options.startingCash === 'number') overrides.startingCash = options.startingCash;
  else overrides.startingCash = boardMeta.startingCash;
  if (typeof options.passGoSalary === 'number') overrides.passGoSalary = options.passGoSalary;
  else overrides.passGoSalary = boardMeta.passGoSalary;
  overrides.diceCount = options.diceCount;
  overrides.moneyVisible = options.moneyVisible;
  overrides.tradeTiming = options.tradeTiming;
  overrides.onBankruptcy = options.onBankruptcy;
  if (typeof options.turnTimeoutSeconds === 'number') overrides.turnTimeoutSeconds = options.turnTimeoutSeconds;
  if (typeof options.rentTurnTimeoutSeconds === 'number') overrides.rentTurnTimeoutSeconds = options.rentTurnTimeoutSeconds;
  return overrides;
}

/** Rebuild host-facing options from a GameState — used after snapshot restore. */
export function optionsFromConfig(config: GameConfig): RoomOptions {
  return {
    startingCash: config.startingCash,
    passGoSalary: config.passGoSalary,
    diceCount: config.diceCount,
    moneyVisible: config.moneyVisible,
    tradeTiming: config.tradeTiming,
    onBankruptcy: config.onBankruptcy,
    turnTimeoutSeconds: config.turnTimeoutSeconds,
    rentTurnTimeoutSeconds: config.rentTurnTimeoutSeconds,
  };
}

export function createRoomManager(): RoomManager {
  const board = loadBoard();
  const rooms = new Map<string, Room>();

  function makeRoom(host: RoomSeatInput, options: RoomOptions): Room {
    return {
      code: randomRoomCode(),
      options,
      seats: [
        { id: host.id, name: host.name, avatar: host.avatar, connected: true, isHost: true },
      ],
      state: null,
      rng: null,
      socketBySeat: new Map([[host.id, '']]),
    };
  }

  function promoteHost(room: Room): void {
    for (let i = 0; i < room.seats.length; i++) {
      const seat = room.seats[i];
      if (seat === undefined) continue;
      seat.isHost = i === 0;
    }
  }

  return {
    createRoom(host, options): Room {
      const room = makeRoom(host, options);
      // Collisions are vanishingly unlikely; retry a few times to be safe.
      let attempts = 0;
      while (rooms.has(room.code) && attempts < 10) {
        room.code = randomRoomCode();
        attempts++;
      }
      rooms.set(room.code, room);
      return room;
    },

    joinRoom(code, seat) {
      const room = rooms.get(code);
      if (room === undefined) return { ok: false, error: 'Room not found' };
      if (room.state !== null) return { ok: false, error: 'Game already started' };
      if (room.seats.some((s) => s.id === seat.id)) return { ok: false, error: 'Seat already in room' };
      if (room.seats.length >= board.meta.maxPlayers) return { ok: false, error: 'Room is full' };
      room.seats.push({ id: seat.id, name: seat.name, avatar: seat.avatar, connected: true, isHost: false });
      room.socketBySeat.set(seat.id, '');
      return { ok: true, room };
    },

    getRoom(code) {
      return rooms.get(code);
    },

    seatById(room, seatId) {
      return room.seats.find((s) => s.id === seatId);
    },

    isBound(room, seatId, socketId) {
      return room.socketBySeat.get(seatId) === socketId;
    },

    bindSocket(room, seatId, socketId) {
      room.socketBySeat.set(seatId, socketId);
      const seat = room.seats.find((s) => s.id === seatId);
      if (seat !== undefined) seat.connected = true;
    },

    releaseSocket(code, socketId) {
      const room = rooms.get(code);
      if (room === undefined) return null;
      for (const [seatId, bound] of room.socketBySeat) {
        if (bound === socketId) {
          room.socketBySeat.set(seatId, '');
          return seatId;
        }
      }
      return null;
    },

    leaveRoom(code, seatId) {
      const room = rooms.get(code);
      if (room === undefined) return { room: undefined, empty: true };
      room.socketBySeat.delete(seatId);
      room.seats = room.seats.filter((s) => s.id !== seatId);
      promoteHost(room);
      return { room, empty: room.seats.length === 0 };
    },

    destroyRoom(code) {
      rooms.delete(code);
    },

    startGame(code, seed) {
      const room = rooms.get(code);
      if (room === undefined) return { ok: false, error: 'Room not found' };
      if (room.state !== null) return { ok: false, error: 'Game already started' };
      if (room.seats.length < board.meta.minPlayers) {
        return { ok: false, error: `Need at least ${board.meta.minPlayers} players` };
      }
      const rng = createRng(seed ?? randomSeed());
      room.state = createGame(
        room.seats.map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, connected: s.connected })),
        rng,
        toGameConfig(room.options, board.meta),
        board,
      );
      room.rng = rng;
      return { ok: true, room };
    },

    installState(code, state) {
      const room = rooms.get(code);
      if (room === undefined) throw new Error(`Cannot install state into unknown room ${code}`);
      room.state = state;
      room.options = optionsFromConfig(state.config);
      room.rng = createRng(randomSeed());
      // Seats are rebuilt from the state's own players, so restored games seat
      // exactly the people in the snapshot (B19).
      room.seats = state.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        connected: false,
        isHost: p.id === state.hostId || i === 0,
      }));
      room.socketBySeat.clear();
      for (const seat of room.seats) room.socketBySeat.set(seat.id, '');
      return room;
    },

    applyToRoom(room, action) {
      if (room.state === null) throw new Error(`Cannot apply action to room ${room.code}: no game`);
      if (room.rng === null) room.rng = createRng(randomSeed());
      const result = applyAction(room.state, action, { rng: room.rng, now: Date.now() });
      room.state = result.state;
      return result;
    },

    all() {
      return [...rooms.values()];
    },

    minPlayers() {
      return board.meta.minPlayers;
    },

    maxPlayers() {
      return board.meta.maxPlayers;
    },
  };
}
