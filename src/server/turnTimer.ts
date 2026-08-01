/**
 * Per-room turn timer (plan §Phase 4, bugs B01/B29).
 *
 * B01 was a stacked-interval disaster: `clearTimeout()` was called on a
 * `setInterval` handle, so the old interval survived and every subsequent
 * `startTurnTimer` added ANOTHER 1s ticker. N tickers decremented the same
 * counter N×/second and fired `autoPass` N times. Here:
 *
 *   - ONE interval per room, owned by exactly one `TurnTimer` object.
 *   - `start()` clears any live handle before arming, so a restart can never
 *     stack. A guard assertion catches a double-arm from the same ticker.
 *   - `stop()` clears on every exit path; the controller calls it on game over
 *     and room destruction.
 *
 * The timer is pure transport: it lives here, never in `GameState` (B29). The
 * duration for a given phase comes from GameConfig, which survives snapshot
 * restore — see `turnTotalSeconds`.
 */
import { DEFAULT_TURN_TIMEOUT_SECONDS, RENT_TURN_TIMEOUT_SECONDS } from '../shared/rules.js';
import type { GameState } from '../shared/types.js';

export interface TimerCallbacks {
  /** Fired once per second while running. */
  onTick: (secondsRemaining: number) => void;
  /** Fired when the countdown reaches zero. The handle is already cleared. */
  onExpire: () => void;
}

export interface TurnTimer {
  /** Reset the countdown to `total` seconds and (re)start. Never stacks. */
  start(totalSeconds: number): void;
  stop(): void;
  isRunning(): boolean;
  seconds: number;
}

export function createTurnTimer(callbacks: TimerCallbacks): TurnTimer {
  let handle: ReturnType<typeof setInterval> | null = null;
  let seconds = 0;

  return {
    start(totalSeconds: number): void {
      if (handle !== null) clearInterval(handle);
      seconds = Math.max(1, Math.floor(totalSeconds));
      handle = setInterval(() => {
        seconds -= 1;
        if (seconds <= 0) {
          if (handle !== null) clearInterval(handle);
          handle = null;
          callbacks.onExpire();
        } else {
          callbacks.onTick(seconds);
        }
      }, 1000);
    },

    stop(): void {
      if (handle !== null) clearInterval(handle);
      handle = null;
    },

    isRunning(): boolean {
      return handle !== null;
    },

    get seconds(): number {
      return seconds;
    },
  };
}

/**
 * How long the current phase may sit without an action. Rent gets a longer
 * window — paying may require selling assets first. Reads GameConfig so a
 * restored game keeps its configured windows (B19).
 */
export function turnTotalSeconds(state: GameState): number {
  if (state.phase === 'rent_payment') return state.config.rentTurnTimeoutSeconds;
  if (state.config.turnTimeoutSeconds > 0) return state.config.turnTimeoutSeconds;
  return DEFAULT_TURN_TIMEOUT_SECONDS;
}

export { DEFAULT_TURN_TIMEOUT_SECONDS, RENT_TURN_TIMEOUT_SECONDS };
