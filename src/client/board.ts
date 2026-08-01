import type { ClientState, PublicPlayer } from '../shared/events';
import type { Board, Square, SquareId } from '../shared/types';
import { CORNER_ICONS, edgeClass, getColorGroupBG, gridClass, pfpUrl } from './constants';
import { byId, clear, el } from './dom';
import { themeBgForSquare } from './theme';

interface BoardHandles {
  cells: Map<SquareId, HTMLElement>;
  center: HTMLElement;
}

let handles: BoardHandles | null = null;

export function boardCells(): Map<SquareId, HTMLElement> {
  if (!handles) return new Map();
  return handles.cells;
}

export function boardCell(id: SquareId): HTMLElement | null {
  return boardCells().get(id) ?? null;
}

export function centerCell(): HTMLElement | null {
  return handles ? handles.center : null;
}

const UPGRADE_ICONS: Record<string, string> = { garage: '🏗️', rest_stop: '🏡', market: '🏬' };

function deckIcon(square: { id: SquareId }): string {
  if (square.id === 4) return '⚖️🍀';
  if (square.id === 11 || square.id === 21 || square.id === 32) return '⚖️';
  if (square.id === 13 || square.id === 30) return '🍀';
  return '🃏';
}

function squareClass(kind: Square['kind']): string {
  switch (kind) {
    case 'corner':
      return 'corner_square';
    case 'property':
      return 'property';
    case 'utility':
      return 'property utility';
    case 'deck':
      return 'deck_trigger';
    case 'dual_deck':
      return 'dual_deck_trigger';
  }
}

function isOwnableSquare(square: Square): square is Extract<Square, { kind: 'property' | 'utility' }> {
  return square.kind === 'property' || square.kind === 'utility';
}

function cornerContent(square: { id: SquareId; name: string }): HTMLElement {
  const wrap = el('div');
  const icon = el('div', 'corner-icon');
  icon.textContent = CORNER_ICONS[square.id] ?? '•';
  const name = el('div', 'corner-name');
  name.textContent = square.name;
  wrap.appendChild(icon);
  wrap.appendChild(name);
  return wrap;
}

export function renderBoard(boardEl: HTMLElement, board: Board, theme: string): void {
  clear(boardEl);
  boardEl.style.cssText =
    'display:grid;grid-template-columns:110px 85px 85px 85px 85px 110px 85px 85px 85px 85px 110px;' +
    'grid-template-rows:120px repeat(6,75px) 120px;gap:3px;background:#d4a853;' +
    'border:4px solid #8B6914;border-radius:14px;padding:5px;';

  const cells = new Map<SquareId, HTMLElement>();

  for (const square of board.squares) {
    const cell = el('div', `cell ${squareClass(square.kind)} ${gridClass(square.id)} ${edgeClass(square.id)}`);
    cell.id = `square-${square.id}`;
    cell.dataset.squareId = String(square.id);
    if (isOwnableSquare(square)) cell.classList.add(square.colorGroup);

    if (CORNER_ICONS[square.id]) {
      cell.appendChild(cornerContent({ id: square.id, name: square.name }));
    } else if (isOwnableSquare(square)) {
      const colorBg = getColorGroupBG(square.colorGroup);
      const colorSection = el('div', `cell-section cell-color-section cell-color ${square.colorGroup}`);
      colorSection.style.background = colorBg;
      const city = el('div', 'cell-section cell-city');
      city.textContent = square.name;
      const price = el('div', 'cell-section cell-price-section');
      price.textContent = square.purchasePrice ? `$${square.purchasePrice}` : '';
      const bottom = el('div', 'cell-section cell-bottom-section');
      bottom.dataset.squareId = String(square.id);
      cell.appendChild(colorSection);
      cell.appendChild(city);
      cell.appendChild(price);
      cell.appendChild(bottom);
    } else if (square.kind === 'deck' || square.kind === 'dual_deck') {
      const label = el('div', 'cell-section deck-label');
      const icon = el('span', 'deck-icon');
      icon.textContent = deckIcon({ id: square.id });
      label.appendChild(icon);
      const name = el('div', 'cell-section');
      name.style.cssText = 'font-size:0.6rem;color:#6a4a1a;';
      name.textContent = square.name;
      cell.appendChild(label);
      cell.appendChild(name);
    }

    const slot = themeBgForSquare(theme, square.id);
    if (slot) {
      const img = new Image();
      img.onload = () => {
        cell.style.backgroundImage = `url(${slot})`;
        cell.style.backgroundSize = 'cover';
        cell.style.backgroundPosition = 'center';
      };
      img.onerror = () => {};
      img.src = slot;
    }

    cell.addEventListener('click', () => {
      if (window.__bankelhaz) window.__bankelhaz.inspectSquare(square.id);
    });
    boardEl.appendChild(cell);
    cells.set(square.id, cell);
  }

  const center = el('div', 'center-cell');
  center.id = 'center-cell';
  const centerBg = themeBgForSquare(theme, 0);
  if (centerBg) {
    const img = new Image();
    img.onload = () => {
      center.style.backgroundImage = `url(${centerBg})`;
      center.style.backgroundSize = 'cover';
      center.style.backgroundPosition = 'center';
    };
    img.onerror = () => {};
    img.src = centerBg;
  }
  center.appendChild(buildCenterContent());
  boardEl.appendChild(center);

  handles = { cells, center };
}

function buildCenterContent(): HTMLElement {
  const wrap = el('div');
  wrap.style.cssText = 'display:contents;';

  const pfpWrap = el('div', 'center-pfp');
  pfpWrap.id = 'cc-center-pfp';
  const pfpImg = new Image();
  pfpImg.alt = 'current player';
  pfpWrap.appendChild(pfpImg);

  const title = el('div', 'cc-title');
  title.textContent = '🏦 بنك الحظ';

  const banner = el('div', 'turn-banner');
  banner.id = 'cc-turn-banner';
  banner.textContent = '🎯 —';

  const timer = el('div', 'cc-timer');
  timer.id = 'cc-timer-bar';
  timer.style.display = 'none';
  const timerDisplay = el('span');
  timerDisplay.id = 'cc-timer-display';
  timerDisplay.textContent = '1:00';
  const timerFillWrap = el('div', 'timer-fill');
  const timerFill = el('div', 'timer-fill-inner');
  timerFill.id = 'cc-timer-fill';
  timerFill.style.width = '100%';
  timerFillWrap.appendChild(timerFill);
  timer.appendChild(timerDisplay);
  timer.appendChild(timerFillWrap);

  const diceArea = el('div', 'center-dice');
  diceArea.id = 'cc-dice-area';
  const die1 = el('div', 'die');
  die1.id = 'cc-die1';
  die1.textContent = '⚀';
  const die2 = el('div', 'die');
  die2.id = 'cc-die2';
  die2.textContent = '⚀';
  diceArea.appendChild(die1);
  diceArea.appendChild(die2);

  const actions = el('div', 'cc-actions');
  const rollBtn = el('button', 'btn btn-primary roll-dice-btn');
  rollBtn.id = 'cc-btn-roll';
  rollBtn.textContent = '🎲 Roll';
  rollBtn.disabled = true;
  rollBtn.type = 'button';
  actions.appendChild(rollBtn);

  const prison = el('div', 'cc-prison');
  prison.id = 'cc-prison-actions';
  const prisonLabel = el('span');
  prisonLabel.textContent = '🔒 In prison';
  const btnSkip = el('button', 'btn btn-skip');
  btnSkip.dataset.prison = 'skip';
  btnSkip.textContent = '⏭️ Skip';
  const btnBail = el('button', 'btn btn-bail');
  btnBail.dataset.prison = 'bail';
  btnBail.textContent = '💰 Bail';
  const btnFree = el('button', 'btn btn-jailfree');
  btnFree.dataset.prison = 'free';
  btnFree.textContent = '🔓 Free';
  prison.appendChild(prisonLabel);
  prison.appendChild(btnSkip);
  prison.appendChild(btnBail);
  prison.appendChild(btnFree);

  const deckMahkama = el('div', 'deck-pile mahkama-pile');
  deckMahkama.id = 'deck-mahkama';
  const backM = el('div', 'card-back');
  backM.textContent = '⚖️';
  const labelM = el('div', 'deck-label');
  labelM.textContent = 'المحكمة ';
  const countM = el('span');
  countM.id = 'mahkama-deck-count';
  countM.textContent = '0';
  labelM.appendChild(countM);
  deckMahkama.appendChild(backM);
  deckMahkama.appendChild(labelM);

  const deckHazak = el('div', 'deck-pile hazak-pile');
  deckHazak.id = 'deck-hazak';
  const backH = el('div', 'card-back');
  backH.textContent = '🍀';
  const labelH = el('div', 'deck-label');
  labelH.textContent = 'حظك ';
  const countH = el('span');
  countH.id = 'hazak-deck-count';
  countH.textContent = '0';
  labelH.appendChild(countH);
  deckHazak.appendChild(backH);
  deckHazak.appendChild(labelH);

  const toasts = el('div');
  toasts.id = 'toast-container';

  wrap.appendChild(pfpWrap);
  wrap.appendChild(title);
  wrap.appendChild(banner);
  wrap.appendChild(timer);
  wrap.appendChild(diceArea);
  wrap.appendChild(actions);
  wrap.appendChild(prison);
  wrap.appendChild(deckMahkama);
  wrap.appendChild(deckHazak);
  wrap.appendChild(toasts);
  return wrap;
}

// ── Token placement ──

function avatarImg(player: PublicPlayer): HTMLImageElement {
  const img = new Image();
  img.src = pfpUrl(player.avatar);
  img.alt = player.name;
  img.title = player.name;
  img.width = 22;
  img.height = 22;
  return img;
}

function tokenStackOffset(index: number): string {
  const positions = [
    'translate(-6px,-6px)',
    'translate(6px,6px)',
    'translate(-6px,6px)',
    'translate(6px,-6px)',
    'translate(0px,-10px)',
    'translate(0px,10px)',
    'translate(-12px,0px)',
    'translate(12px,0px)',
  ];
  return positions[index % positions.length] ?? '';
}

function placeToken(cell: HTMLElement, player: PublicPlayer, index: number): void {
  let tokens = cell.querySelector('.tokens') as HTMLElement | null;
  if (!tokens) {
    tokens = el('div', 'tokens');
    cell.appendChild(tokens);
  }
  const token = el('div', 'token');
  token.id = `token-${player.id}`;
  token.style.transform = tokenStackOffset(index);
  token.appendChild(avatarImg(player));
  tokens.appendChild(token);
}

/** Rebuild every token from player positions, with stable stacking per square. */
export function renderTokens(state: ClientState, players: PublicPlayer[]): void {
  for (const cell of boardCells().values()) {
    const tokens = cell.querySelector('.tokens');
    if (tokens) tokens.remove();
  }
  const bySquare = new Map<SquareId, PublicPlayer[]>();
  for (const p of players) {
    const list = bySquare.get(p.position) ?? [];
    list.push(p);
    bySquare.set(p.position, list);
  }
  for (const [squareId, list] of bySquare) {
    const cell = boardCell(squareId);
    if (!cell) continue;
    list.forEach((p, i) => placeToken(cell, p, i));
  }
}

// ── Ownership / upgrades / highlights ──

export function renderOwnership(state: ClientState, players: PublicPlayer[]): void {
  for (const [squareId, cell] of boardCells()) {
    const own = state.ownership[squareId];
    const owner = own && own.owner !== null ? players.find((p) => p.id === own.owner) : null;
    cell.classList.toggle('owned', owner !== null);

    const bottom = cell.querySelector('.cell-bottom-section');
    if (!bottom) continue;
    const existing = bottom.querySelector('.building-icons');
    if (existing) existing.remove();
    const avatar = bottom.querySelector('.owner-avatar');
    if (avatar) avatar.remove();

    if (owner) {
      const wrap = el('div', 'owner-avatar');
      const img = avatarImg(owner);
      img.width = 18;
      img.height = 18;
      wrap.appendChild(img);
      bottom.appendChild(wrap);
    }
    if (own && own.upgrade) {
      const icons = el('div', 'building-icons');
      const n = own.upgrade === 'market' ? 3 : own.upgrade === 'rest_stop' ? 2 : 1;
      icons.textContent = (UPGRADE_ICONS[own.upgrade] ?? '🏗️').repeat(n);
      bottom.appendChild(icons);
    }
  }
}

export function renderBoardState(state: ClientState, players: PublicPlayer[]): void {
  for (const [squareId, cell] of boardCells()) {
    const cur = players[state.currentPlayerIndex];
    const active = cur !== undefined && cur.position === squareId && !state.gameOver;
    cell.classList.toggle('active', active);
  }
}

/** Show the current player's avatar in the board center during their turn. */
export function setCenterPfp(state: ClientState, players: PublicPlayer[]): void {
  const wrap = byId('cc-center-pfp');
  if (!wrap) return;
  const cur = players[state.currentPlayerIndex];
  const show = cur !== undefined && !state.gameOver;
  wrap.classList.toggle('show', show);
  if (show) {
    const img = wrap.querySelector('img');
    if (img) img.src = pfpUrl(cur.avatar);
  }
}

/** Glow the center deck pile(s) the current player is about to draw from. */
export function setDeckGlow(state: ClientState, players: PublicPlayer[]): void {
  const mahkama = byId('deck-mahkama');
  const hazak = byId('deck-hazak');
  if (!mahkama || !hazak) return;
  let m = false;
  let h = false;
  if (!state.gameOver) {
    const cur = players[state.currentPlayerIndex];
    const sq = cur ? state.board.squares.find((s) => s.id === cur.position) : undefined;
    if (sq) {
      if (sq.kind === 'deck') {
        if (sq.deck === 'mahkama') m = true;
        else h = true;
      } else if (sq.kind === 'dual_deck') {
        m = true;
        h = true;
      }
    }
  }
  mahkama.classList.toggle('glow-mahkama', m && !h);
  mahkama.classList.toggle('glow-dual', m && h);
  hazak.classList.toggle('glow-hazak', h && !m);
  hazak.classList.toggle('glow-dual', m && h);
}

/** Animate a token walking the roll path, then resolve. */
export function animateTokenMove(
  player: PublicPlayer,
  path: readonly SquareId[],
  msPerStep: number,
  onDone: () => void,
): void {
  if (path.length === 0) {
    onDone();
    return;
  }
  let i = 0;
  const step = () => {
    const squareId = path[i] as SquareId;
    i += 1;
    let token = byId<HTMLElement>(`token-${player.id}`);
    if (!token) {
      const cell = boardCell(player.position);
      const fallback = cell ?? boardCell(path[0] as SquareId);
      if (fallback) placeToken(fallback, player, 0);
      token = byId<HTMLElement>(`token-${player.id}`);
    }
    const cell = boardCell(squareId);
    if (token && cell && token.parentElement !== cell) {
      cell.appendChild(token);
    }
    if (i < path.length) {
      setTimeout(step, msPerStep);
    } else {
      setTimeout(onDone, msPerStep);
    }
  };
  step();
}
