/**
 * Cell chrome shared by the live board and the lobby preview: edge classes,
 * corner artwork, deck icons and themed backgrounds.
 *
 * Themed backgrounds load asynchronously and then REPLACE the cell's contents.
 * That is a race against re-rendering: the legacy `img.onload` fired whenever it
 * fired and wiped whatever cell it had captured, so a board redraw that landed
 * first had its fresh contents erased by a stale image from the previous theme.
 * A render generation counter closes it — a callback from an older generation
 * simply returns.
 */

import type { SquareId } from '../../shared/types.js';
import { CORNER_ICONS } from '../state.js';
import { getThemeImageUrl, themeSlotFor } from '../theme.js';

/** Bumped on every full board render; stale async callbacks compare against it. */
let renderGeneration = 0;

export function beginRenderGeneration(): number {
  renderGeneration += 1;
  return renderGeneration;
}

export function isCurrentGeneration(gen: number): boolean {
  return gen === renderGeneration;
}

// ── Static chrome ──

const CORNER_IDS = new Set<SquareId>([1, 8, 18, 25]);

export function getEdgeClass(posId: SquareId): string {
  if (CORNER_IDS.has(posId)) return 'corner';
  if (posId >= 2 && posId <= 7) return 'edge-left';
  if (posId >= 9 && posId <= 17) return 'edge-top';
  if (posId >= 19 && posId <= 24) return 'edge-right';
  if (posId >= 26 && posId <= 34) return 'edge-bottom';
  return '';
}

const CORNER_IMAGES: Readonly<Record<string, string>> = {
  '1': 'start.png',
  '8': 'club.png',
  '18': 'bus.png',
  '25': 'prison.png',
  hazak: 'hazak.png',
  mahkama: 'mahkama.png',
  fuel: 'fuel.png',
};

export function cornerImageHtml(id: SquareId | string, w: number, h: number): string {
  const name = CORNER_IMAGES[String(id)];
  if (name === undefined) return '';
  return `<img src="assets/corners/${name}" alt="" style="width:${w}px;height:${h}px;display:none;" onload="this.style.display=''" onerror="this.remove()" />`;
}

export function getCornerContent(id: SquareId, name: string): string {
  const icon = CORNER_ICONS[id] ?? '📍';
  return `<div class="corner-icon">${cornerImageHtml(id, 28, 28)}<span class="corner-emoji">${icon}</span></div><div class="corner-name">${name}</div>`;
}

export function getDeckIconFor(kind: string, deckType: string | undefined): string {
  if (kind === 'dual_deck_trigger' || kind === 'dual_deck') return '⚖️🍀';
  return deckType === 'mahkama' ? '⚖️' : '🍀';
}

export function getColorGroupBG(group: string | null): string {
  const map: Readonly<Record<string, string>> = {
    purple: '#9b59b6',
    pink: '#ff80ab',
    orange: '#ff9800',
    yellow: '#ffeb3b',
    brown: '#795548',
    green: '#4caf50',
    cyan: '#00bcd4',
    white: '#bdbdbd',
    red: '#f44336',
    utility: '#607d8b',
  };
  if (group === null) return '#555';
  return map[group] ?? '#555';
}

// ── Themed backgrounds ──

function applyBackground(el: HTMLElement, url: string): void {
  el.style.backgroundImage = `url(${url})`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
}

/**
 * Loads the themed artwork for a square and, once it decodes, swaps it in for
 * the cell's text content — keeping the `.tokens` layer, which holds the player
 * pieces standing on that square.
 */
export function applyCellTheme(cell: HTMLElement, sqId: SquareId, gen: number): void {
  const url = getThemeImageUrl(themeSlotFor(sqId));
  if (url === null) return;
  const img = new Image();
  img.onload = () => {
    if (!isCurrentGeneration(gen) || !cell.isConnected) return;
    applyBackground(cell, url);
    const tokens = cell.querySelector('.tokens');
    cell.innerHTML = '';
    if (tokens) cell.appendChild(tokens);
  };
  img.onerror = () => {
    /* a theme missing one slot falls back to the plain cell */
  };
  img.src = url;
}

export function applyDeckTheme(pileEl: HTMLElement, slotKey: string, gen: number): void {
  const url = getThemeImageUrl(slotKey);
  if (url === null) return;
  const img = new Image();
  img.onload = () => {
    if (!isCurrentGeneration(gen) || !pileEl.isConnected) return;
    const cardBack = pileEl.querySelector<HTMLElement>('.card-back');
    if (!cardBack) return;
    applyBackground(cardBack, url);
    cardBack.textContent = '';
  };
  img.onerror = () => {};
  img.src = url;
}

/** Same as `applyCellTheme` but for an explicit theme name (lobby preview). */
export function applyPreviewImage(el: HTMLElement, url: string): void {
  const img = new Image();
  img.onload = () => {
    if (!el.isConnected) return;
    applyBackground(el, url);
  };
  img.onerror = () => {};
  img.src = url;
}
