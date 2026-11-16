/**
 * Turn countdown rendering.
 *
 * The countdown is server-authoritative (WIRE.md rule 4): `timer_sync` carries
 * the remaining seconds and this module only draws them. It does not run its own
 * clock, and it never decides that time is up — a client that disagrees with the
 * server about the deadline is how the old build produced two different turn
 * lengths on two screens.
 *
 * `max` is the high-water mark for the CURRENT turn, so the bar has a
 * denominator. It is reset by `resetTurnClock` when the turn changes; the legacy
 * `_maxTimer` lived on game state and only ever grew, so one long turn left
 * every later bar starting part-full.
 */

import { byId } from '../dom.js';
import { S } from '../state.js';

const REFRESH_MS = 500;
let refreshHandle: number | null = null;

export function applyTimerSync(seconds: number, running: boolean): void {
  S.timer.seconds = seconds;
  S.timer.running = running;
  if (seconds > S.timer.max) S.timer.max = seconds;
  updateTimerUI();
}

/** Called when a new turn begins so the bar rescales to the new allowance. */
export function resetTurnClock(): void {
  S.timer.max = 0;
}

export function stopTimer(): void {
  S.timer.running = false;
  S.timer.seconds = 0;
  updateTimerUI();
}

function paint(displayId: string, fillId: string, barId: string, text: string, pct: string, secs: number): void {
  const display = byId(displayId);
  if (display) display.textContent = text;
  const fill = byId(fillId);
  if (fill) fill.style.width = pct;
  const bar = byId(barId);
  if (bar) {
    bar.classList.toggle('timer-warn', secs <= 30 && secs > 10);
    bar.classList.toggle('timer-danger', secs <= 10);
  }
}

export function updateTimerUI(): void {
  if (!S.view) return;
  const secs = S.timer.seconds;
  const maxSecs = S.timer.max > 0 ? S.timer.max : 90;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const text = `${m}:${s.toString().padStart(2, '0')}`;
  const pct = `${Math.max(0, Math.min(100, (secs / maxSecs) * 100))}%`;

  paint('timer-display', 'timer-fill', 'timer-bar', text, pct, secs);
  paint('rc-timer-display', 'rc-timer-fill', 'rc-timer-bar', text, pct, secs);
}

/**
 * Starts the repaint loop. The legacy `setInterval` was created at script load
 * and never cleared, so it went on ticking against a stale state after the game
 * ended or the player returned to the lobby.
 */
export function startTimerRefresh(): void {
  if (refreshHandle !== null) return;
  refreshHandle = window.setInterval(() => {
    if (S.view && !S.view.gameOver) updateTimerUI();
  }, REFRESH_MS);
}

export function stopTimerRefresh(): void {
  if (refreshHandle === null) return;
  clearInterval(refreshHandle);
  refreshHandle = null;
}
