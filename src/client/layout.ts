/**
 * Responsive board scaling.
 *
 * The board is authored at a fixed 1064×735 and scaled with a transform, so the
 * layout box is collapsed with negative right/bottom margins to match the
 * VISUAL size — without that the page keeps reserving the unscaled footprint.
 *
 * Behaviour is unchanged from the inline version; only the wiring moved.
 */

import { byId } from './dom.js';
import { S } from './state.js';
import { persistGameState } from './storage.js';

const BOARD_W = 1064;
const BOARD_H = 735;

/** Breakpoints, matching responsive.css. */
const TABLET_MIN = 601;
const TABLET_MAX = 900;
const LANDSCAPE_MOBILE_MAX = 1100;

export function resizeBoard(): void {
  const board = byId('board');
  if (!board) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw === 0) return;

  board.style.transform = '';
  board.style.margin = '';
  board.style.top = '';
  board.style.left = '';

  const isPortrait =
    window.matchMedia('(orientation: portrait)').matches ||
    vw < vh ||
    (vw >= TABLET_MIN && vw <= TABLET_MAX);
  const isLandscapeMobile = !isPortrait && vw <= LANDSCAPE_MOBILE_MAX;

  let availW: number;
  let availH: number;
  let marginLeft = 0;
  let marginTop = 0;

  if (isPortrait) {
    availW = vw - 8;
    availH = vh * 0.58;
    marginTop = 24;
  } else if (isLandscapeMobile) {
    const sideW = Math.min(240, vw * 0.32);
    availW = vw - sideW - 12;
    availH = vh - 8;
    marginLeft = 6;
    marginTop = 4;
  } else {
    availW = vw - 60;
    availH = vh - 60;
  }

  const scale = Math.max(Math.min(availW / BOARD_W, availH / BOARD_H, 1), 0.2);

  board.style.transform = `scale(${scale})`;
  board.style.transformOrigin = 'left top';
  board.style.marginLeft = marginLeft + 'px';
  board.style.marginTop = marginTop + 'px';
  board.style.marginRight = -(BOARD_W * (1 - scale)) + 'px';
  board.style.marginBottom = -(BOARD_H * (1 - scale)) + 'px';
}

let orientationTimer: number | null = null;

export function initLayout(): void {
  window.addEventListener('resize', resizeBoard);

  window.addEventListener('orientationchange', () => {
    // One pending re-layout at a time; rapid rotation used to queue a timeout
    // per event and thrash the transform after the device had settled.
    if (orientationTimer !== null) clearTimeout(orientationTimer);
    orientationTimer = window.setTimeout(() => {
      orientationTimer = null;
      resizeBoard();
    }, 300);
  });

  window.addEventListener('beforeunload', () => {
    if (S.view && S.roomCode !== null && !S.view.gameOver) persistGameState();
  });
}
