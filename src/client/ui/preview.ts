/**
 * The lobby's "preview this theme" board.
 *
 * Static and non-interactive: it exists so a host can see a theme before
 * committing to it, so it renders from the local board file rather than from
 * game state (there is no game yet).
 */

import type { RawSquare } from '../../shared/raw.js';
import { byId, qs } from '../dom.js';
import { rawSquares } from '../board-data.js';
import { CORNER_ICONS, COLOR_BG_MAP, gridClass } from '../state.js';
import { getEdgeClass, getCornerContent, getDeckIconFor, applyPreviewImage } from '../render/cells.js';
import { THEME_SLOT_FILES_PUBLIC, THEME_SLOT_MAP_PUBLIC } from '../theme.js';

const PREVIEW_BOARD_W = 1064;
const PREVIEW_BOARD_H = 735;

const PREVIEW_GRID_CSS =
  'display:grid;grid-template-columns:110px 85px 85px 85px 85px 110px 85px 85px 85px 85px 110px;' +
  'grid-template-rows:120px repeat(6,75px) 120px;gap:3px;background:#d4a853;border:4px solid #8B6914;' +
  'border-radius:14px;padding:5px;';

function section(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderPreviewCell(sq: RawSquare): HTMLDivElement {
  const cell = document.createElement('div');
  const colorGroup = sq.type === 'property' ? sq.color_group : '';
  cell.className = `cell ${sq.type} ${gridClass(sq.id)} ${getEdgeClass(sq.id)}`;
  if (colorGroup) cell.classList.add(colorGroup);

  if (CORNER_ICONS[sq.id] !== undefined) {
    cell.innerHTML = getCornerContent(sq.id, sq.name);
  } else if (sq.type === 'property') {
    const colorSection = section(`cell-section cell-color-section cell-color ${colorGroup}`);
    colorSection.style.background = COLOR_BG_MAP[colorGroup] ?? '#607d8b';
    colorSection.style.fontSize = '0.65rem';
    colorSection.style.padding = '2px 4px';
    cell.appendChild(colorSection);
    cell.appendChild(section('cell-section cell-city', sq.name));
    cell.appendChild(
      section('cell-section cell-price-section', sq.purchase_price ? `$${sq.purchase_price}` : ''),
    );
    cell.appendChild(section('cell-section cell-bottom-section'));
  } else if (sq.type === 'deck_trigger' || sq.type === 'dual_deck_trigger') {
    const label = section('cell-section deck-label');
    label.innerHTML = getDeckIconFor(sq.type, sq.type === 'deck_trigger' ? sq.deck_type : undefined);
    cell.appendChild(label);
    const nameSection = section('cell-section', sq.name);
    nameSection.style.cssText = 'font-size:0.6rem;color:#6a4a1a;';
    cell.appendChild(nameSection);
  }

  return cell;
}

function renderPreviewBoard(boardEl: HTMLElement, theme: string): void {
  boardEl.style.cssText = PREVIEW_GRID_CSS;

  for (const sq of rawSquares) {
    const cell = renderPreviewCell(sq);
    const slotKey = THEME_SLOT_MAP_PUBLIC[sq.id];
    if (theme !== 'plain' && slotKey !== undefined) {
      const file = THEME_SLOT_FILES_PUBLIC[slotKey];
      if (file !== undefined) applyPreviewImage(cell, `assets/themes/${theme}/${file}`);
    }
    boardEl.appendChild(cell);
  }

  const center = document.createElement('div');
  center.className = 'center-cell';
  center.innerHTML = '<div class="cc-title">🏦 بنك الحظ</div>';
  if (theme !== 'plain') applyPreviewImage(center, `assets/themes/${theme}/center-bg.png`);
  boardEl.appendChild(center);
}

export function openPreview(): void {
  const selected = qs<HTMLSelectElement>('#theme-host, #theme-join')?.value ?? 'plain';
  const modal = byId('preview-modal');
  const container = byId('preview-board-container');
  if (!modal || !container) return;

  modal.classList.add('show');
  container.innerHTML = '';
  const board = document.createElement('div');
  board.className = 'preview-board';
  renderPreviewBoard(board, selected);
  container.appendChild(board);

  requestAnimationFrame(() => {
    const box = container.closest<HTMLElement>('.preview-box');
    if (!box) return;
    const boxStyle = getComputedStyle(box);
    const padX = parseFloat(boxStyle.paddingLeft) + parseFloat(boxStyle.paddingRight);
    const padY = parseFloat(boxStyle.paddingTop) + parseFloat(boxStyle.paddingBottom);
    const availW = box.clientWidth - padX;
    const availH = box.clientHeight - padY;
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.max(Math.min(availW / PREVIEW_BOARD_W, availH / PREVIEW_BOARD_H, 1), 0.2);
    board.style.transform = `scale(${scale})`;
  });
}

export function closePreview(): void {
  byId('preview-modal')?.classList.remove('show');
  // The preview board is rebuilt on every open; dropping it on close stops a
  // few hundred detached cells (and their pending image loads) lingering.
  const container = byId('preview-board-container');
  if (container) container.innerHTML = '';
}
