/**
 * The server's post-reducer choreography (plan §Phase 4).
 *
 * One module owns everything that happens AFTER an action is applied: splitting
 * `REJECTED` off to the actor, broadcasting `DomainEvent[]` to the room, pushing
 * a per-seat projection to each socket (projections differ — view.ts), keeping
 * the per-room turn timer armed, handling game over, and issuing signed
 * snapshots at turn boundaries (B19, §4a).
 *
 * The timer is the ONE interval per room (B01) and is cleared on game over and
 * room destruction. Its expiry synthesizes the same `TIMEOUT` system action the
 * engine turns into a human-equivalent action, so a timeout can never diverge
 * from a click (B22).
 *
 * Every `TURN_STARTED` also sweeps stale trades/bids (B14) via a system
 * `EXPIRE_TRADES` action and issues fresh snapshots to the connected seats.
 */
import type { Server } from 'socket.io';
import { SYSTEM_ACTOR } from '../../shared/actions.js';
import type { Action, DomainEvent, ActionResult } from '../../shared/actions.js';
import { createSnapshot } from '../snapshot.js';
import { createTurnTimer, turnTotalSeconds } from '../turnTimer.js';
import { projectFor } from '../view.js';
import type { TurnTimer } from '../turnTimer.js';
import type { Room, RoomManager } from '../rooms.js';
import type { SocketData } from '../../shared/events.js';
import type { SeatId } from '../../shared/types.js';

export interface RoomController {
  /** Broadcast the events + per-seat projections from one reducer result. */
  broadcastAfterAction(room: Room, events: DomainEvent[]): void;
  /** Arm (or re-arm) the room's turn timer for the current phase. */
  syncTimer(room: Room): void;
  stopTimer(room: Room): void;
  /** Timer + timer state cleanup when a room is destroyed. */
  destroy(room: Room): void;
  /** First turn: per-socket `game_started` + synthetic TURN_STARTED (B26). */
  onGameStart(room: Room): void;
}

export interface ControllerDeps {
  secret: Buffer;
}

function socketOf(room: Room, seatId: SeatId): string | null {
  const socketId = room.socketBySeat.get(seatId);
  return socketId !== undefined && socketId !== '' ? socketId : null;
}

export function createRoomController(io: Server, manager: RoomManager, deps: ControllerDeps): RoomController {
  const timers = new Map<string, TurnTimer>();

  function timerFor(room: Room): TurnTimer {
    let timer = timers.get(room.code);
    if (timer === undefined) {
      timer = createTurnTimer({
        onTick: (seconds) => {
          if (room.state === null) return;
          io.to(room.code).emit('timer', {
            seconds,
            running: true,
            total: turnTotalSeconds(room.state),
          });
        },
        onExpire: () => expireRoom(room),
      });
      timers.set(room.code, timer);
    }
    return timer;
  }

  function expireRoom(room: Room): void {
    if (room.state === null || room.state.gameOver) return;
    const result = manager.applyToRoom(room, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    controller.broadcastAfterAction(room, result.events);
  }

  function issueSnapshots(room: Room): void {
    const state = room.state;
    if (state === null) return;
    const snapshot = createSnapshot(
      {
        roomCode: room.code,
        stateVersion: state.stateVersion,
        issuedAt: Date.now(),
        seatIds: state.players.map((p) => p.id),
        state,
      },
      deps.secret,
    );
    for (const seatId of room.seats.map((s) => s.id)) {
      const socketId = socketOf(room, seatId);
      if (socketId === null) continue;
      io.to(socketId).emit('snapshot_issued', { snapshot });
    }
  }

  const controller: RoomController = {
    broadcastAfterAction(room, events) {
      const state = room.state;
      if (state === null) return;

      const rejections = events.filter((e) => e.type === 'REJECTED');
      const publicEvents = events.filter((e) => e.type !== 'REJECTED');
      if (publicEvents.length > 0) io.to(room.code).emit('events', { events: publicEvents });

      for (const rejection of rejections) {
        if (rejection.actorId === SYSTEM_ACTOR) continue;
        const socketId = socketOf(room, rejection.actorId);
        if (socketId === null) continue;
        io.to(socketId).emit('rejected', { action: rejection.action, reason: rejection.reason });
      }

      for (const seat of room.seats) {
        const socketId = socketOf(room, seat.id);
        if (socketId === null) continue;
        io.to(socketId).emit('state', { state: projectFor(state, seat.id) });
      }

      if (state.gameOver) {
        controller.stopTimer(room);
        io.to(room.code).emit('game_over', { winnerId: state.winnerId });
      } else {
        controller.syncTimer(room);
      }

      const turnStarted = publicEvents.some((e) => e.type === 'TURN_STARTED');
      if (!turnStarted) return;

      // B14 sweep + fresh resume blobs once per turn handover.
      issueSnapshots(room);
      const expire: ActionResult = manager.applyToRoom(room, {
        type: 'EXPIRE_TRADES',
        actorId: SYSTEM_ACTOR,
        now: Date.now(),
      });
      if (expire.events.length > 0) controller.broadcastAfterAction(room, expire.events);
    },

    syncTimer(room) {
      const state = room.state;
      if (state === null) return;
      if (state.gameOver) {
        controller.stopTimer(room);
        return;
      }
      const timer = timerFor(room);
      const total = turnTotalSeconds(state);
      timer.start(total);
      io.to(room.code).emit('timer', { seconds: timer.seconds, running: true, total });
    },

    stopTimer(room) {
      const timer = timers.get(room.code);
      if (timer !== undefined) timer.stop();
    },

    destroy(room) {
      controller.stopTimer(room);
      timers.delete(room.code);
    },

    onGameStart(room) {
      const state = room.state;
      if (state === null) return;
      for (const seat of room.seats) {
        const socketId = socketOf(room, seat.id);
        if (socketId === null) continue;
        io.to(socketId).emit('game_started', { state: projectFor(state, seat.id) });
      }
      const current = state.players[state.currentPlayerIndex];
      const events: DomainEvent[] =
        current !== undefined
          ? [{ type: 'TURN_STARTED', playerId: current.id, turnNumber: state.turnNumber }]
          : [];
      controller.broadcastAfterAction(room, events);
    },
  };

  return controller;
}

/** The single gameplay channel. `actorId` is overwritten server-side (B09). */
export function handleAction(
  io: Server,
  manager: RoomManager,
  controller: RoomController,
  socket: { data: SocketData; id: string },
  payload: { roomCode: string; action: Action },
): void {
  const room = manager.getRoom(payload.roomCode);
  if (room === undefined || room.state === null) return;
  const seatId = socket.data.seatId;
  if (seatId === null || !manager.isBound(room, seatId, socket.id)) return;
  // Spread then overwrite: the wire may not choose its own actor (B09). The
  // cast is safe — the spread result is the same Action with a seat id, and any
  // client-forged system action is rejected by the reducer's actor gate.
  const action = { ...payload.action, actorId: seatId } as Action;
  const result = manager.applyToRoom(room, action);
  controller.broadcastAfterAction(room, result.events);
}
