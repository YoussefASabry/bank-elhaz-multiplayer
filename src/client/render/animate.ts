/**
 * Token movement animation.
 *
 * The walk is a chain of timeouts, and the legacy version kept no handle on it.
 * A second roll arriving before the first finished started a SECOND chain
 * against the same car element: the two fought over its position and each fired
 * its own `confirm_landing` at the end, confirming a landing twice. The handle
 * below makes a new walk cancel the one in flight.
 */

import type { LastRoll } from '../../shared/types.js';
import { byId, qs, qsa } from '../dom.js';
import { S } from '../state.js';
import { getPfpUrl } from '../theme.js';
import { socket } from '../net/socket.js';
import { playerById } from '../view-model.js';

const STEP_MS = 400;
let walkTimer: number | null = null;

/** Stops any walk in progress and hides the car. */
export function cancelTokenAnimation(): void {
  if (walkTimer !== null) {
    clearTimeout(walkTimer);
    walkTimer = null;
  }
  const car = byId('moving-car');
  if (car) car.style.display = 'none';
  S.isAnimating = false;
}

export function animateToken(roll: LastRoll, shouldConfirm: boolean): void {
  const view = S.view;
  if (!view) return;
  const player = playerById(view, roll.playerId);
  if (!player) {
    S.isAnimating = false;
    return;
  }

  cancelTokenAnimation();
  S.isAnimating = true;

  // Drop the piece from its origin square so it does not appear in two places
  // while the car is travelling.
  qsa<HTMLElement>(`.cell[data-id="${roll.from}"] .tokens .token`).forEach((t) => {
    if (t.dataset['pid'] === roll.playerId) t.remove();
  });

  const car = byId('moving-car');
  if (!car) {
    S.isAnimating = false;
    if (shouldConfirm) confirmLanding(roll);
    return;
  }
  car.innerHTML = `<img src="${getPfpUrl(player.avatar || 1)}" alt="" />`;
  car.style.display = 'block';

  const path = roll.path;
  let idx = 0;

  const moveNext = (): void => {
    if (idx >= path.length) {
      walkTimer = null;
      car.style.display = 'none';
      S.isAnimating = false;
      if (shouldConfirm) confirmLanding(roll);
      return;
    }
    const cell = qs(`.cell[data-id="${path[idx]}"]`);
    if (cell) {
      const rect = cell.getBoundingClientRect();
      car.style.left = rect.left + rect.width / 2 - 14 + 'px';
      car.style.top = rect.top + rect.height / 2 - 14 + 'px';
    }
    idx++;
    walkTimer = window.setTimeout(moveNext, STEP_MS);
  };

  moveNext();
}

function confirmLanding(roll: LastRoll): void {
  if (S.roomCode === null) return;
  socket.emit('confirm_landing', { roomCode: S.roomCode, rollResult: roll });
}
