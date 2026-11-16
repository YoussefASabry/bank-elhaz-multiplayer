/**
 * Full board construction: the 34 cells, the centre console and the two deck
 * piles.
 *
 * This is a FULL rebuild and it destroys the centre console — which contains
 * `#toast-container`, `#timer-bar` and every action button. It must therefore
 * run only when the board's static structure actually changes (new game, theme
 * change, reconnect), never on an ordinary `state_update`; `updateUI` mutates
 * the existing nodes instead. Calling it per state broadcast is what used to
 * wipe the message feed mid-turn.
 *
 * The centre console's markup is reproduced verbatim from the inline original,
 * including its `onclick=` attributes — those resolve against the `window`
 * globals registered in `globals.ts`.
 */

import type { SquareId } from '../../shared/types.js';
import { byId, qs, escapeHtml } from '../dom.js';
import { S, CORNER_ICONS, COLOR_BG_MAP, gridClass } from '../state.js';
import { getThemeImageUrl } from '../theme.js';
import type { ViewSquare } from '../view-model.js';
import {
  applyCellTheme,
  applyDeckTheme,
  applyPreviewImage,
  beginRenderGeneration,
  getCornerContent,
  getDeckIconFor,
  getEdgeClass,
} from './cells.js';
import { resizeBoard } from '../layout.js';

/** Set by main.ts so the board can open the inspect dialog without a cycle. */
let onTileClick: (id: SquareId) => void = () => {};
let onDeckClick: (deck: 'hazak' | 'mahkama') => void = () => {};

export function setBoardHandlers(handlers: {
  inspectTile: (id: SquareId) => void;
  drawFromDeck: (deck: 'hazak' | 'mahkama') => void;
}): void {
  onTileClick = handlers.inspectTile;
  onDeckClick = handlers.drawFromDeck;
}

const CENTER_HTML = `
      <img class="center-pfp" id="center-pfp" src="" alt="">
      <div class="turn-banner" id="turn-banner">🎯 —</div>
      <div class="cc-timer" id="timer-bar">
        <span id="timer-display">1:00</span>
        <div class="timer-fill"><div class="timer-fill-inner" id="timer-fill" style="width:100%"></div></div>
      </div>
      <div class="center-dice" id="center-dice-area">
        <div class="die" id="cdie1">⚀</div>
        <div class="die" id="cdie2">⚀</div>
      </div>
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
        <div class="cc-actions">
          <button class="btn btn-primary" id="btn-roll" onclick="rollDice()" disabled style="font-size:1rem;padding:8px 28px;">🎲 Roll</button>
        </div>
        <div class="cc-actions" style="margin-top:1px;">
          <button class="btn btn-trade" id="btn-trade" onclick="openTrade()" disabled style="font-size:0.8rem;">🤝 Trade</button>
          <button class="btn btn-choice" id="btn-bid" onclick="openBid()" disabled style="font-size:0.8rem;">📢 Bid</button>
          <button class="btn btn-choice" onclick="openInventory()" style="font-size:0.8rem;">📦 My Stuff</button>
        </div>
        </div>
        <div id="rent-actions" style="display:none;margin-top:3px;gap:3px;flex-direction:column;align-items:center;">
          <button class="btn btn-buy" id="btn-pay-rent" onclick="payRent()" style="font-size:0.85rem;padding:4px 14px;">💰 Pay Rent</button>
          <button class="btn btn-decline btn-sm" id="btn-declare-bankrupt" onclick="declareBankrupt()" style="font-size:0.7rem;display:none;">💀 Bankrupt</button>
        </div>
        <div class="cc-actions" id="debug-area" style="margin-top:1px;display:none;">
          <select id="debug-tile-select" style="padding:2px 4px;border-radius:4px;border:1px solid #8B6914;background:#fff;color:#3a2a1a;font-size:0.7rem;width:100px;"></select>
          <button class="btn" onclick="debugGo()" style="font-size:0.7rem;padding:2px 8px;background:#5a3a1a;color:#ffd700;">🎲 Go</button>
        </div>
      </div>
      <div class="cc-prison" id="prison-actions">
        <span>🔒 In prison</span>
        <button class="btn btn-skip" onclick="skipPrison()">⏭️ Skip</button>
        <button class="btn btn-bail" onclick="payBail()">💰 Bail ($50)</button>
        <button class="btn btn-jailfree" id="btn-use-jailfree" onclick="useJailFree()" style="display:none">🔓 Jail-Free</button>
      </div>
      <div id="toast-container"></div>
      <div class="cc-title">🏦 بنك الحظ</div>
      <div class="deck-count" id="deck-count"></div>
    `;

function cellInnerHtml(sq: ViewSquare): string {
  if (CORNER_ICONS[sq.id] !== undefined) {
    return getCornerContent(sq.id, sq.name);
  }
  if (sq.kind === 'property' || sq.kind === 'utility') {
    const colorBg = COLOR_BG_MAP[sq.colorGroup ?? ''] ?? '#607d8b';
    const price = sq.purchasePrice ? `$${sq.purchasePrice}` : '';
    return `
          <div class="cell-section cell-color-section cell-color ${sq.colorGroup ?? ''}" style="background:${colorBg};font-size:0.65rem;padding:2px 4px;"></div>
          <div class="cell-section cell-city">${escapeHtml(sq.name)}</div>
          <div class="cell-section cell-price-section">${price}</div>
          <div class="cell-section cell-bottom-section">
            <span class="owner-avatar"></span>
            <span class="building-icons"></span>
          </div>
        `;
  }
  if (sq.kind === 'deck' || sq.kind === 'dual_deck') {
    const deckType = sq.raw.kind === 'deck' ? sq.raw.deck : undefined;
    return `<div class="cell-section deck-label">${getDeckIconFor(sq.kind, deckType)}</div><div class="cell-section" style="font-size:0.9rem;color:#5a3a0a;font-weight:bold;">${escapeHtml(sq.name)}</div>`;
  }
  return '';
}

/** Maps the engine's square kind onto the CSS class the legacy data-driven markup used. */
function cssKind(sq: ViewSquare): string {
  switch (sq.kind) {
    case 'property':
    case 'utility':
      return 'property';
    case 'corner':
      return 'corner_square';
    case 'deck':
      return 'deck_trigger';
    case 'dual_deck':
      return 'dual_deck_trigger';
  }
}

export function renderBoard(): void {
  const board = byId('board');
  if (!board) return;
  const view = S.view;
  if (!view) {
    board.innerHTML = '';
    return;
  }

  const gen = beginRenderGeneration();
  board.innerHTML = '';

  for (const sq of view.squares) {
    const cell = document.createElement('div');
    cell.className = `cell ${cssKind(sq)} ${gridClass(sq.id)} ${getEdgeClass(sq.id)}`;
    if (sq.colorGroup) cell.classList.add(sq.colorGroup);
    cell.innerHTML = cellInnerHtml(sq);

    const tokensDiv = document.createElement('div');
    tokensDiv.className = 'tokens';
    cell.appendChild(tokensDiv);

    cell.dataset['id'] = String(sq.id);
    cell.addEventListener('click', () => {
      onTileClick(sq.id);
    });
    board.appendChild(cell);
    applyCellTheme(cell, sq.id, gen);
  }

  const center = document.createElement('div');
  center.className = 'center-cell';
  center.innerHTML = CENTER_HTML;
  board.appendChild(center);

  const centerBgUrl = getThemeImageUrl('center-bg');
  // Applied to the element just created, not re-queried from the document —
  // the legacy callback did `document.querySelector('.center-cell')` on load and
  // would paint whichever centre cell existed by then, which after a re-render
  // was a different node (and threw outright if none was present).
  if (centerBgUrl !== null) applyPreviewImage(center, centerBgUrl);

  board.appendChild(renderDeckPile('mahkama', gen));
  board.appendChild(renderDeckPile('hazak', gen));

  window.setTimeout(resizeBoard, 50);
}

function renderDeckPile(deck: 'hazak' | 'mahkama', gen: number): HTMLElement {
  const view = S.view;
  const count = view ? view.deckCounts[deck] : 0;
  const pile = document.createElement('div');
  pile.className = `deck-pile ${deck}-pile`;
  pile.dataset['deck'] = deck;
  if (deck === 'mahkama') {
    pile.innerHTML = `<div class="card-back mahkama-back">⚖️</div><div class="deck-label">⚖️ المحكمة (${count})</div>`;
  } else {
    pile.innerHTML = `<div class="card-back hazak-back">🍀</div><div class="deck-label">🍀 حظك (${count})</div>`;
  }
  pile.addEventListener('click', () => {
    onDeckClick(deck);
  });
  applyDeckTheme(pile, deck === 'mahkama' ? 'deck-mahkama' : 'deck-hazak', gen);
  return pile;
}

/** Updates just the deck counters, so a draw does not require a full rebuild. */
export function updateDeckLabels(): void {
  const view = S.view;
  if (!view) return;
  const mahkama = qs('.mahkama-pile .deck-label');
  if (mahkama) mahkama.textContent = `⚖️ المحكمة (${view.deckCounts.mahkama})`;
  const hazak = qs('.hazak-pile .deck-label');
  if (hazak) hazak.textContent = `🍀 حظك (${view.deckCounts.hazak})`;
}
