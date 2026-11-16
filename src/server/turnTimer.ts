/**
 * Server-authoritative deadlines.
 *
 * Three legacy defects live and die here:
 *
 *  - **B01.** `startTurnTimer` created the countdown with `setInterval` but
 *    `stopTurnTimer`/`destroyRoom` cancelled it with `clearTimeout`. On an
 *    interval handle that is a no-op, so every reset stacked another live
 *    interval on the room. Two intervals means the countdown ticks twice per
 *    second and `autoPass` fires twice per expiry — the single largest cause of
 *    turn chaos. Here there is exactly one handle per room, it is always
 *    cancelled with `clearInterval`, and `start` cancels before it creates.
 *
 *  - **B02.** `autoPass` hand-rolled a phase switch that had no branch for
 *    `draw_card`, `upgrade_choice` or `rolling`, so in those phases the timer
 *    hit zero and *nothing happened* — a permanent freeze. This module no
 *    longer decides anything: it dispatches a single `TIMEOUT` action and the
 *    reducer's `defaultActionFor` (exhaustive over `Pending`, `never`
 *    fallthrough) picks the default answer. A missing case is a compile error.
 *
 *  - **B18.** The client ran its own 65s trade countdown against the server's
 *    60s and emitted `trade_cancel` when *it* expired. The server owns the
 *    deadline; `trade_timer_sync` renders a number the server already decided.
 *
 * Timers are transport-level and deliberately absent from `GameState` (B29).
 */
import { RENT_TURN_TIMEOUT_SECONDS, TRADE_TIMEOUT_SECONDS } from '../shared/rules.js';
import type { GameState } from '../shared/types.js';
import type { Room } from './rooms.js';

/** How long the seat on the clock gets, given what it is being asked to do. */
export function timeoutSecondsFor(state: GameState): number {
  // Paying rent may require liquidating first, so it gets the longer window —
  // the same 120s the legacy server special-cased.
  if (state.phase === 'rent_payment') return RENT_TURN_TIMEOUT_SECONDS;
  return state.config.turnTimeoutSeconds;
}

export interface TurnTimerHooks {
  /** Fired every second with the remaining count, for `timer_sync`. */
  onTick: (seconds: number, running: boolean) => void;
  /** Fired once, at zero. The caller dispatches `TIMEOUT`. */
  onExpire: () => void;
}

/**
 * Stop the room's countdown. Idempotent, and — unlike the legacy version —
 * actually cancels an interval.
 */
export function stopTurnTimer(room: Room): void {
  if (room.turnTimer !== null) {
    clearInterval(room.turnTimer);
    room.turnTimer = null;
  }
}

/**
 * (Re)start the room's countdown. Always stops first, so a room can never hold
 * two live intervals no matter how many times this is called.
 */
export function startTurnTimer(room: Room, hooks: TurnTimerHooks, durationSecs?: number): void {
  stopTurnTimer(room);
  if (room.state === null || room.state.gameOver) return;

  const duration = durationSecs ?? timeoutSecondsFor(room.state);
  hooks.onTick(duration, true);

  let secs = duration;
  room.turnTimer = setInterval(() => {
    secs -= 1;
    if (secs > 0) {
      hooks.onTick(secs, true);
      return;
    }
    // Zero: tear the interval down BEFORE dispatching, so a re-entrant
    // start from inside onExpire cannot be cancelled by our own cleanup.
    stopTurnTimer(room);
    hooks.onTick(0, false);
    hooks.onExpire();
  }, 1000);
}

export function resetTurnTimer(room: Room, hooks: TurnTimerHooks, durationSecs?: number): void {
  startTurnTimer(room, hooks, durationSecs);
}

// ── Trade deadlines ──

export interface TradeTimerHooks {
  /** Fired once at open, for `trade_timer_sync`. */
  onSync: (seconds: number, running: boolean) => void;
  /** Fired at expiry. The caller dispatches `EXPIRE_TRADES` and notifies. */
  onExpire: (tradeId: string) => void;
}

export function stopTradeTimer(room: Room, tradeId: string): void {
  const handle = room.tradeTimers.get(tradeId);
  if (handle !== undefined) {
    clearTimeout(handle);
    room.tradeTimers.delete(tradeId);
  }
}

export function stopAllTradeTimers(room: Room): void {
  for (const handle of room.tradeTimers.values()) clearTimeout(handle);
  room.tradeTimers.clear();
}

/**
 * Arm (or re-arm) the deadline for one trade. Keyed by trade id, so two
 * concurrent trades in the same room cannot cancel each other's clock — the
 * legacy version stored a single `trade.timer` per trade object but reset it
 * through a helper that silently did nothing when the trade had no timer yet.
 */
export function startTradeTimer(
  room: Room,
  tradeId: string,
  hooks: TradeTimerHooks,
  seconds: number = TRADE_TIMEOUT_SECONDS,
): void {
  stopTradeTimer(room, tradeId);
  const handle = setTimeout(() => {
    room.tradeTimers.delete(tradeId);
    hooks.onExpire(tradeId);
  }, seconds * 1000);
  room.tradeTimers.set(tradeId, handle);
  hooks.onSync(seconds, true);
}
