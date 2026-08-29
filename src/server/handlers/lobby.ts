/**
 * Lobby and session: host, join, leave, start, rejoin, restore.
 *
 * These are the only handlers that are not game actions — they must work
 * before a `GameState` exists, which is why WIRE.md keeps them as distinct
 * events rather than folding them into the action channel.
 */
import { loadBoard } from '../../engine/board.js';
import { createInitialState } from '../../engine/state.js';
import type { GameConfig } from '../../shared/types.js';
import type { ServerCtx } from '../context.js';
import { armTurnTimer, broadcastState } from '../dispatch.js';
import { wirePlayers } from '../rooms.js';
import type { Room } from '../rooms.js';
import { attemptRestore, restoreErrorMessage } from '../snapshots.js';
import { stopTurnTimer } from '../turnTimer.js';
import { buildClientState } from '../view.js';
import type { WireRoomOptions } from '../wire.js';
import { asString, seated, type TypedSocket } from './common.js';

/**
 * Loaded once. The board is immutable — ownership lives in `state.ownership`,
 * deliberately outside it — so every room can share this instance. The legacy
 * code spread it per room with `{...sq, owner: null}`, a *shallow* copy that
 * left every room sharing the same nested rent tables anyway, with none of the
 * safety and all of the allocation.
 */
const BOARD = loadBoard();

/**
 * Translate host options into engine config. Only keys the host actually sent
 * are forwarded; `exactOptionalPropertyTypes` means an explicit `undefined`
 * is not the same as an absent key, and would blow away the engine default.
 */
function toConfigOverrides(options: WireRoomOptions): Partial<GameConfig> {
  const cfg: Partial<GameConfig> = {};
  if (typeof options.startingCash === 'number') cfg.startingCash = options.startingCash;
  if (typeof options.passGoSalary === 'number') cfg.passGoSalary = options.passGoSalary;
  if (options.diceCount === 1 || options.diceCount === 2) cfg.diceCount = options.diceCount;
  if (typeof options.moneyVisible === 'boolean') cfg.moneyVisible = options.moneyVisible;
  if (options.tradeTiming === 'anytime' || options.tradeTiming === 'own_turn') {
    cfg.tradeTiming = options.tradeTiming;
  }
  if (options.onBankruptcy === 'eliminate' || options.onBankruptcy === 'jail') {
    cfg.onBankruptcy = options.onBankruptcy;
  }
  if (typeof options.turnTimeoutSeconds === 'number') {
    cfg.turnTimeoutSeconds = options.turnTimeoutSeconds;
  }
  return cfg;
}

/** `game_started` carries a projection, so it is sent per viewer like `state_update`. */
function sendGameStarted(ctx: ServerCtx, room: Room): void {
  const state = room.state;
  if (state === null) return;
  for (const { socketId, seatId } of ctx.rooms.socketsOf(room)) {
    ctx.emit.toSocket(socketId, 'game_started', { gameState: buildClientState(state, seatId) });
  }
}

export function registerLobbyHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('host_game', (p, cb) => {
    const name = asString(p?.playerName);
    if (name === null) {
      cb?.({ ok: false, error: 'A name is required' });
      return;
    }
    const options = p.options ?? {};
    const room = ctx.rooms.create(name, Number(p.avatar) || 1, socket.id, options);
    void socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.seatId = room.seats[0]?.id ?? null;

    const playerId = room.seats[0]?.id ?? '';
    socket.emit('room_created', { roomCode: room.code, playerId, players: wirePlayers(room) });
    cb?.({ ok: true, roomCode: room.code, playerId, players: wirePlayers(room) });
  });

  socket.on('join_game', (p, cb) => {
    const code = asString(p?.roomCode);
    const name = asString(p?.playerName);
    if (code === null || name === null) {
      cb?.({ ok: false, error: 'Room code and name are required' });
      return;
    }
    const result = ctx.rooms.join(code.toUpperCase(), name, Number(p.avatar) || 1, socket.id);
    if (!result.ok) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    const { room, seat } = result;
    void socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.seatId = seat.id;

    ctx.emit.toRoom(room.code, 'update_players', { players: wirePlayers(room) });
    socket.emit('joined', {
      roomCode: room.code,
      playerId: seat.id,
      players: wirePlayers(room),
    });
    cb?.({ ok: true, roomCode: room.code, playerId: seat.id, players: wirePlayers(room) });

    // Joining a room whose game is already running is a reconnect; hand them
    // the current position immediately rather than leaving them on a blank board.
    if (room.state !== null) {
      ctx.emit.toRoom(room.code, 'player_reconnected', {
        playerId: seat.id,
        players: wirePlayers(room),
      });
      broadcastState(ctx, room);
    }
  });

  socket.on('leave_room', () => {
    const at = seated(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;

    if (room.state === null) {
      ctx.rooms.removeSeat(room, seat);
    } else {
      // Mid-game: never splice a seated player out of the running game — that
      // is what shifted `currentPlayerIndex` and corrupted turn order (B06).
      ctx.rooms.markDisconnected(room, seat);
    }
    void socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.seatId = null;

    ctx.emit.toRoom(room.code, 'update_players', { players: wirePlayers(room) });
    if (ctx.rooms.isDeserted(room)) ctx.rooms.destroy(room.code);
  });

  socket.on('start_game', () => {
    const at = seated(ctx, socket);
    if (at === null) return;
    const { room, seat } = at;
    if (room.state !== null) return;
    if (room.seats[0]?.id !== seat.id) return; // host only
    if (room.seats.length < BOARD.meta.minPlayers) return;

    room.state = createInitialState(
      room.seats.map((s) => ({
        id: s.id,
        name: s.name,
        avatar: s.avatar,
        connected: s.connected,
      })),
      room.rng,
      toConfigOverrides(room.options),
      BOARD,
    );

    sendGameStarted(ctx, room);
    armTurnTimer(ctx, room);
    broadcastState(ctx, room);
  });

  socket.on('rejoin_game', (p) => {
    const code = asString(p?.roomCode);
    const name = asString(p?.playerName);
    if (code === null || name === null) {
      socket.emit('rejoin_failed', { error: 'Room code and name are required' });
      return;
    }
    const room = ctx.rooms.get(code.toUpperCase());
    if (room === null) {
      socket.emit('rejoin_failed', { error: 'Room not found' });
      return;
    }
    if (room.kicked.has(name)) {
      socket.emit('rejoin_failed', { error: 'You were removed from this game' });
      return;
    }
    const seat = ctx.rooms.findRejoinable(room, name);
    if (seat === undefined) {
      socket.emit('rejoin_failed', { error: 'Player not found or already connected' });
      return;
    }

    const oldPlayerId = seat.id; // stable: reported only because the legacy client reads it
    ctx.rooms.attach(room, seat, socket.id);
    void socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.seatId = seat.id;

    ctx.emit.toRoom(room.code, 'player_reconnected', {
      playerId: seat.id,
      oldPlayerId,
      players: wirePlayers(room),
    });
    socket.emit('rejoined', {
      roomCode: room.code,
      playerId: seat.id,
      players: wirePlayers(room),
      gameState: room.state === null ? null : buildClientState(room.state, seat.id),
    });

    if (room.state !== null) {
      // A reconnect must not hand the returning player a fresh full clock.
      // Re-arm once so exactly one interval is live (B01).
      stopTurnTimer(room);
      armTurnTimer(ctx, room);
      broadcastState(ctx, room);
    }
  });

  /**
   * B19. The client returns the opaque signed blob it was issued. Any
   * `gameState` it also sends is ignored — there is no code path from a wire
   * payload into `GameState` any more.
   */
  socket.on('restore_game', (p) => {
    const code = asString(p?.roomCode);
    const name = asString(p?.playerName);
    if (name === null) {
      socket.emit('restore_game_result', { success: false, error: 'A name is required' });
      return;
    }

    // A live room is not a restore at all — it is a rejoin. Route it there so
    // a returning player never clobbers a game still in progress.
    if (code !== null && ctx.rooms.isLive(code.toUpperCase())) {
      const room = ctx.rooms.get(code.toUpperCase());
      const seat = room === null ? undefined : ctx.rooms.findByName(room, name);
      if (room !== null && seat !== undefined) {
        ctx.rooms.attach(room, seat, socket.id);
        void socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.seatId = seat.id;
        ctx.emit.toRoom(room.code, 'player_reconnected', {
          playerId: seat.id,
          players: wirePlayers(room),
        });
        socket.emit('restore_game_result', {
          success: true,
          roomCode: room.code,
          playerId: seat.id,
          gameState: room.state === null ? null : buildClientState(room.state, seat.id),
        });
        stopTurnTimer(room);
        armTurnTimer(ctx, room);
        broadcastState(ctx, room);
        return;
      }
    }

    const snapshot = p?.snapshot;
    if (snapshot === undefined || snapshot === null) {
      socket.emit('restore_game_result', {
        success: false,
        error: 'No snapshot supplied',
      });
      return;
    }

    const outcome = attemptRestore(ctx, {
      snapshot,
      playerName: name,
      claimedSeatId: p.playerId,
      socketId: socket.id,
    });

    if (!outcome.ok) {
      socket.emit('restore_game_result', {
        success: false,
        error: restoreErrorMessage(outcome.reason),
      });
      return;
    }

    const { room, seatId } = outcome;
    void socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.seatId = seatId;

    ctx.emit.toRoom(room.code, 'player_reconnected', {
      playerId: seatId,
      players: wirePlayers(room),
    });
    socket.emit('restore_game_result', {
      success: true,
      roomCode: room.code,
      playerId: seatId,
      gameState: room.state === null ? null : buildClientState(room.state, seatId),
    });
    armTurnTimer(ctx, room);
    broadcastState(ctx, room);
  });
}
