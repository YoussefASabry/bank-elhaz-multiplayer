/**
 * The single pipeline: intent → `Action` → `applyAction` → emit → broadcast.
 *
 * Every socket handler in `handlers/` ends by calling {@link dispatch}. No
 * handler touches `GameState`, chooses a broadcast, or manages a timer, which
 * is what makes the whole-server invariants below true by construction rather
 * than by discipline:
 *
 *  - **One writer.** `applyAction` is the only mutator. The legacy server wrote
 *    `room.gameState` directly in 8 places and `roomManager.js` in ~12 more.
 *  - **One timeout path.** The countdown dispatches `TIMEOUT` through this same
 *    function, so a timed-out rent and a clicked rent are literally the same
 *    code (bug B22).
 *  - **One timer per room.** The timer is re-armed only when the *turn key*
 *    below actually changes, so a rejected action cannot silently extend a
 *    player's clock and repeated broadcasts cannot stack intervals (bug B01).
 */
import { applyAction } from '../engine/index.js';
import { applyTeleport, evaluateLanding, finishTurn } from '../engine/turn.js';
import { SYSTEM_ACTOR } from '../shared/actions.js';
import type { Action, DomainEvent } from '../shared/actions.js';
import type { GameState } from '../shared/types.js';
import type { ServerCtx } from './context.js';
import { capture, emitDeckPrompt, emitDomainEvents } from './domainEvents.js';
import type { PreDispatch } from './domainEvents.js';
import type { Room } from './rooms.js';
import { issueSnapshot } from './snapshots.js';
import {
  startTradeTimer,
  startTurnTimer,
  stopAllTradeTimers,
  stopTradeTimer,
  stopTurnTimer,
} from './turnTimer.js';
import { buildClientState } from './view.js';

/**
 * Identifies "whose move is it, and on what". When this changes the clock
 * restarts; when it does not, the clock keeps running. A rejected action leaves
 * it identical, so refusals never buy time.
 */
function turnKey(state: GameState): string {
  const pendingSeat = state.pending.kind === 'none' ? '-' : state.pending.playerId;
  return [
    state.turnNumber,
    state.currentPlayerIndex,
    state.phase,
    state.pending.kind,
    pendingSeat,
  ].join('|');
}

/** Fan the redacted projection out, one payload per viewer (WIRE.md rule 1). */
export function broadcastState(ctx: ServerCtx, room: Room): void {
  const state = room.state;
  if (state === null) return;

  const snapshot = maybeIssueSnapshot(ctx, room);
  for (const { socketId, seatId } of ctx.rooms.socketsOf(room)) {
    ctx.emit.toSocket(socketId, 'state_update', {
      gameState: buildClientState(state, seatId),
      phase: state.phase,
      ...(snapshot === null ? {} : { snapshot }),
    });
  }
}

/**
 * Task 14. A fresh signed snapshot is minted once per turn, not per broadcast —
 * signing embeds the whole state, so per-broadcast would be wasteful. The blob
 * rides along on `state_update` because WIRE.md's 35 events contain no
 * dedicated snapshot channel.
 */
function maybeIssueSnapshot(ctx: ServerCtx, room: Room): ReturnType<typeof issueSnapshot> | null {
  const state = room.state;
  if (state === null) return null;
  if (state.turnNumber <= room.lastSnapshotTurn) return null;
  room.lastSnapshotTurn = state.turnNumber;
  return issueSnapshot(ctx, room);
}

export interface DispatchOutcome {
  /** False when the reducer refused the action. */
  ok: boolean;
  events: DomainEvent[];
}

/** Timer lifecycle driven by what the reducer just did to the trade table. */
function syncTradeTimers(ctx: ServerCtx, room: Room, events: readonly DomainEvent[]): void {
  for (const ev of events) {
    if (ev.type === 'TRADE_OPENED') {
      startTradeTimer(room, ev.tradeId, {
        onSync: (seconds, running) => {
          for (const seatId of [ev.a, ev.b]) {
            const sid = ctx.rooms.seatOf(room, seatId)?.socketId ?? null;
            if (sid !== null) ctx.emit.toSocket(sid, 'trade_timer_sync', { seconds, running });
          }
        },
        onExpire: () => {
          // The engine decides what expiry means; we only supply the clock.
          dispatch(ctx, room, {
            type: 'EXPIRE_TRADES',
            actorId: SYSTEM_ACTOR,
            now: ctx.now(),
          });
        },
      });
    } else if (ev.type === 'TRADE_SETTLED' || ev.type === 'TRADE_CANCELLED') {
      stopTradeTimer(room, ev.tradeId);
    }
  }
}

/**
 * Apply one action and tell the table about it.
 *
 * Returns the reducer's own verdict so a handler can decide whether to emit an
 * intent-level courtesy message (e.g. `trade_error`), but a handler must never
 * use it to perform a second mutation.
 */
export function dispatch(ctx: ServerCtx, room: Room, action: Action): DispatchOutcome {
  const state = room.state;
  if (state === null) return { ok: false, events: [] };

  const before: PreDispatch = capture(state);
  const keyBefore = turnKey(state);

  const result = applyAction(state, action, room.rng);
  // The reducer mutates in place and returns the same object; reassigning keeps
  // the room correct if that ever becomes a fresh object.
  room.state = result.state;

  const rejected =
    result.events.length === 1 && result.events[0]?.type === 'REJECTED';

  emitDomainEvents(ctx, room, result.events, before);
  syncTradeTimers(ctx, room, result.events);

  const now = room.state;
  if (now.gameOver) {
    stopTurnTimer(room);
    stopAllTradeTimers(room);
  } else if (turnKey(now) !== keyBefore) {
    armTurnTimer(ctx, room);
    emitDeckPrompt(ctx, room);
  }

  if (!rejected) broadcastState(ctx, room);
  return { ok: !rejected, events: result.events };
}

/**
 * Host-only debug teleport — the ONE place this server reaches past
 * `applyAction`, and it is a knowing exception.
 *
 * `debug_roll` is in WIRE.md's frozen 37, but `shared/actions.ts` has no
 * teleport action and that file is outside this task's ownership, so there is
 * no `Action` to build. The compromise: every mutation still happens *inside*
 * engine functions (`applyTeleport`, `evaluateLanding`, `finishTurn`) — the
 * exact three the reducer itself composes for a card-driven move — and this
 * function writes nothing but `stateVersion`. The handler layer above still
 * touches no state at all.
 *
 * The clean fix is a `DEBUG_TELEPORT` variant in the `Action` union, guarded by
 * `entitlement: 'host'`. Flagged in the handover report.
 */
export function debugTeleport(
  ctx: ServerCtx,
  room: Room,
  actorId: string,
  target: number,
): void {
  const state = room.state;
  if (state === null || state.gameOver) return;
  if (state.phase !== 'roll') return;
  const holder = state.players[state.currentPlayerIndex];
  if (holder === undefined) return;
  if (state.board.squares.find((s) => s.id === target) === undefined) return;
  void actorId;

  const before = capture(state);
  const from = holder.position;
  const events: DomainEvent[] = [
    ...applyTeleport(state, holder.id, target),
    ...evaluateLanding(state, holder.id),
    ...finishTurn(state),
  ];
  state.stateVersion += 1;

  // PAYLOAD FIX, not a port. The legacy debug path emitted `gs.lastRoll`
  // verbatim — the PREVIOUS roll, which is `null` on the first turn of a game
  // and stale every time after. WIRE.md gives `dice_rolled` a total shape, so
  // this sends a well-formed zeroed roll instead: same keys, and the zeros are
  // an unambiguous "teleport, no dice" for the animation code.
  ctx.emit.toRoom(room.code, 'dice_rolled', {
    die1: 0,
    die2: 0,
    total: 0,
    isDouble: false,
    oldPos: from,
    newPos: target,
    steps: 0,
    passedGo: false,
    path: [target],
    playerId: holder.id,
  });

  emitDomainEvents(ctx, room, events, before);
  syncTradeTimers(ctx, room, events);
  if (state.gameOver) {
    stopTurnTimer(room);
    stopAllTradeTimers(room);
  } else {
    armTurnTimer(ctx, room);
    emitDeckPrompt(ctx, room);
  }
  broadcastState(ctx, room);
}

/**
 * Arm the countdown for whoever is now on the clock. Exported because the
 * lobby needs it at `start_game`, before any action has been dispatched.
 */
export function armTurnTimer(ctx: ServerCtx, room: Room): void {
  startTurnTimer(room, {
    onTick: (seconds, running) => {
      ctx.emit.toRoom(room.code, 'timer_sync', { seconds, running });
    },
    onExpire: () => {
      dispatch(ctx, room, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    },
  });
}
