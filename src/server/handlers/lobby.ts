/**
 * Socket connection wiring: lobby + session events (plan §Phase 4).
 *
 * Gameplay itself is the single `action` channel handled in room.ts; this file
 * only wires transport-level events — host/join/leave/start before a game,
 * rejoin/restore after one, and disconnect. None of these build or mutate
 * GameState directly; every state change goes through `manager.applyToRoom` or
 * `manager.startGame`, so the reducer stays the single writer.
 *
 * Rejoin needs no id remapping at all (B20): seats are stable `SeatId`s, and
 * `rejoin { seatToken }` simply rebinds this socket to that seat — the token IS
 * the seat id, an unguessable random string the client stored in localStorage.
 */
import type { Server } from 'socket.io';
import { loadBoard } from '../../engine/board.js';
import { SYSTEM_ACTOR } from '../../shared/actions.js';
import { restoreSnapshot } from '../snapshot.js';
import { generateSeatId } from '../rooms.js';
import type { Room, RoomManager } from '../rooms.js';
import { handleAction, type RoomController } from './room.js';
import { projectFor } from '../view.js';
import type { LobbyMember, RoomOptions } from '../../shared/events.js';
import type { VersionStore } from '../versionStore.js';

export interface LobbyDeps {
  secret: Buffer;
  versionStore: VersionStore;
}

function lobbyMembers(room: Room): LobbyMember[] {
  return room.seats.map((s) => ({
    id: s.id,
    name: s.name,
    avatar: s.avatar,
    connected: s.connected,
    isHost: s.isHost,
  }));
}

function normalizeOptions(input: unknown, boardMeta: { startingCash: number; passGoSalary: number }): RoomOptions {
  const o = (input !== null && typeof input === 'object' ? input : {}) as Partial<RoomOptions>;
  const options: RoomOptions = {
    startingCash: typeof o.startingCash === 'number' ? o.startingCash : boardMeta.startingCash,
    passGoSalary: typeof o.passGoSalary === 'number' ? o.passGoSalary : boardMeta.passGoSalary,
    diceCount: o.diceCount === 1 || o.diceCount === 2 ? o.diceCount : 2,
    moneyVisible: o.moneyVisible !== false,
    tradeTiming: o.tradeTiming === 'own_turn' ? 'own_turn' : 'anytime',
    onBankruptcy: o.onBankruptcy === 'jail' ? 'jail' : 'eliminate',
  };
  if (typeof o.turnTimeoutSeconds === 'number') options.turnTimeoutSeconds = o.turnTimeoutSeconds;
  if (typeof o.rentTurnTimeoutSeconds === 'number') options.rentTurnTimeoutSeconds = o.rentTurnTimeoutSeconds;
  return options;
}

/** Resolve a disconnected current player's turn immediately (B22-consistent). */

function turnHolderOf(state: { players: { id: string }[]; currentPlayerIndex: number }): string | undefined {
  return state.players[state.currentPlayerIndex]?.id;
}

export function wireLobby(
  io: Server,
  manager: RoomManager,
  controller: RoomController,
  deps: LobbyDeps,
): void {
  const boardMeta = loadBoard().meta;

  io.on('connection', (socket) => {
    socket.data.roomCode = null;
    socket.data.seatId = null;

    // ── Lobby ──

    socket.on('host_game', (payload, cb) => {
      const playerName = typeof payload?.playerName === 'string' ? payload.playerName : 'Player';
      const seatId = generateSeatId();
      const room = manager.createRoom(
        { id: seatId, name: playerName, avatar: typeof payload?.avatar === 'number' ? payload.avatar : 1 },
        normalizeOptions(payload?.options, boardMeta),
      );
      socket.data.roomCode = room.code;
      socket.data.seatId = seatId;
      socket.join(room.code);
      manager.bindSocket(room, seatId, socket.id);
      socket.emit('room_created', { roomCode: room.code, you: seatId, members: lobbyMembers(room) });
      if (cb) cb({ ok: true, roomCode: room.code, you: seatId });
    });

    socket.on('join_game', (payload, cb) => {
      const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode : '';
      const playerName = typeof payload?.playerName === 'string' ? payload.playerName : 'Player';
      const seatId = generateSeatId();
      const result = manager.joinRoom(roomCode, {
        id: seatId,
        name: playerName,
        avatar: typeof payload?.avatar === 'number' ? payload.avatar : 1,
      });
      if (!result.ok) {
        if (cb) cb({ ok: false, error: result.error });
        return;
      }
      socket.data.roomCode = result.room.code;
      socket.data.seatId = seatId;
      socket.join(result.room.code);
      manager.bindSocket(result.room, seatId, socket.id);
      io.to(result.room.code).emit('room_members', { members: lobbyMembers(result.room) });
      socket.emit('room_joined', { roomCode: result.room.code, you: seatId, members: lobbyMembers(result.room) });
      if (cb) cb({ ok: true, roomCode: result.room.code, you: seatId });
    });

    socket.on('leave_room', (payload) => {
      const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode : '';
      const room = manager.getRoom(roomCode);
      if (room === undefined || socket.data.seatId === null) return;
      if (room.state !== null) {
        handleGameDisconnect(io, manager, controller, socket);
        return;
      }
      const { empty } = manager.leaveRoom(roomCode, socket.data.seatId);
      socket.leave(roomCode);
      if (empty) {
        controller.destroy(room);
        manager.destroyRoom(roomCode);
        return;
      }
      io.to(roomCode).emit('room_members', { members: lobbyMembers(room) });
    });

    // ── Game control ──

    socket.on('start_game', (payload) => {
      const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode : '';
      const room = manager.getRoom(roomCode);
      if (room === undefined) return;
      const host = room.seats.find((s) => s.isHost);
      if (host === undefined || host.id !== socket.data.seatId) return;
      if (!manager.isBound(room, host.id, socket.id)) return;
      const result = manager.startGame(roomCode);
      if (!result.ok) {
        socket.emit('room_error', { message: result.error });
        return;
      }
      controller.onGameStart(result.room);
    });

    // ── Gameplay (single channel) ──

    socket.on('action', (payload) => {
      const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode : '';
      const action = payload?.action;
      if (action === undefined || action === null) return;
      if (manager.getRoom(roomCode) === undefined) return;
      handleAction(io, manager, controller, socket, { roomCode, action });
    });

    // ── Reconnect / resume ──

    socket.on('rejoin', (payload) => {
      const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode : '';
      const seatToken = typeof payload?.seatToken === 'string' ? payload.seatToken : '';
      const room = manager.getRoom(roomCode);
      if (room === undefined) {
        socket.emit('room_error', { message: 'Room not found' });
        return;
      }
      const seat = manager.seatById(room, seatToken);
      if (seat === undefined) {
        socket.emit('room_error', { message: 'Seat not found in this room' });
        return;
      }
      socket.data.roomCode = room.code;
      socket.data.seatId = seatToken;
      socket.join(room.code);
      manager.bindSocket(room, seatToken, socket.id);
      if (room.state === null) {
        io.to(room.code).emit('room_members', { members: lobbyMembers(room) });
        socket.emit('room_joined', { roomCode: room.code, you: seatToken, members: lobbyMembers(room) });
        return;
      }
      const result = manager.applyToRoom(room, {
        type: 'PLAYER_RECONNECTED',
        actorId: SYSTEM_ACTOR,
        playerId: seatToken,
      });
      controller.broadcastAfterAction(room, result.events);
    });

    socket.on('restore', (payload) => {
      const snapshot = payload?.snapshot;
      const seatToken = typeof payload?.seatToken === 'string' ? payload.seatToken : '';
      if (snapshot === undefined || snapshot === null) {
        socket.emit('restore_rejected', { reason: 'malformed' });
        return;
      }
      const result = restoreSnapshot(snapshot, deps.secret, {
        now: Date.now(),
        isRoomLive: (code) => manager.getRoom(code) !== undefined,
        versionStore: deps.versionStore,
        requesterSeatId: seatToken,
      });
      if (!result.ok) {
        socket.emit('restore_rejected', { reason: result.reason });
        return;
      }
      const room = manager.installState(result.payload.roomCode, result.payload.state);
      socket.data.roomCode = room.code;
      socket.data.seatId = seatToken;
      socket.join(room.code);
      manager.bindSocket(room, seatToken, socket.id);
      if (room.state === null) throw new Error('restore installed a room with no state');
      socket.emit('restore_ok', {
        roomCode: room.code,
        you: seatToken,
        state: projectFor(room.state, seatToken),
      });
      controller.syncTimer(room);
    });

    // ── Disconnect ──

    socket.on('disconnect', () => {
      const roomCode = socket.data.roomCode;
      const seatId = socket.data.seatId;
      if (roomCode === null || seatId === null) return;
      const room = manager.getRoom(roomCode);
      if (room === undefined) return;
      manager.releaseSocket(roomCode, socket.id);
      if (room.state === null) {
        const { empty } = manager.leaveRoom(roomCode, seatId);
        if (empty) {
          controller.destroy(room);
          manager.destroyRoom(roomCode);
          return;
        }
        io.to(roomCode).emit('room_members', { members: lobbyMembers(room) });
        return;
      }
      handleGameDisconnect(io, manager, controller, socket);
    });
  });
}

function handleGameDisconnect(
  io: Server,
  manager: RoomManager,
  controller: RoomController,
  socket: { data: { seatId: string | null } },
): void {
  const seatId = socket.data.seatId;
  if (seatId === null) return;
  const rooms = manager.all().filter((room) => room.state !== null && room.seats.some((s) => s.id === seatId));
  for (const room of rooms) {
    const result = manager.applyToRoom(room, {
      type: 'PLAYER_DISCONNECTED',
      actorId: SYSTEM_ACTOR,
      playerId: seatId,
    });
    controller.broadcastAfterAction(room, result.events);
    const state = room.state;
    if (state === null || state.gameOver) continue;
    const current = turnHolderOf(state);
    if (current === seatId) {
      // Resolve the current player's turn now instead of stalling the window.
      const timeout = manager.applyToRoom(room, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
      controller.broadcastAfterAction(room, timeout.events);
    }
  }
}
