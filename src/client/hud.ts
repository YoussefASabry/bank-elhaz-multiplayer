import type { PublicPlayer } from '../shared/events';
import type { SeatId } from '../shared/types';
import { cornerLayout, DICE_FACES, getColorGroupBG, pfpUrl } from './constants';
import { byId, clear, el } from './dom';
import { boardCell } from './board';
import type { UIClientState } from './store';
import { awaitingLandingConfirm, canRoll, currentPlayer, isMyTurn, myPlayer } from './store';

/** Player corner cards around the board. */
export function renderPlayerCorners(
  container: HTMLElement,
  players: PublicPlayer[],
  onClick: ((seatId: SeatId) => void) | null = null,
): void {
  clear(container);
  const active = players.filter((p) => !p.isBankrupt && !p.eliminated);
  const layout = cornerLayout(Math.max(active.length, players.length));
  players.forEach((p, i) => {
    const corner = el('div', `player-corner ${layout[i % layout.length]}`);
    corner.id = `player-corner-${p.id}`;
    if (p.isBankrupt || p.eliminated) corner.classList.add('bankrupt');
    if (!p.connected) corner.classList.add('disconnected');
    if (onClick && !p.isBankrupt && !p.eliminated) {
      corner.classList.add('clickable');
      corner.addEventListener('click', () => onClick(p.id));
    }

    const header = el('div', 'pc-header');
    const img = new Image();
    img.src = pfpUrl(p.avatar);
    img.alt = p.name;
    const name = el('span');
    name.textContent = p.name;
    header.appendChild(img);
    header.appendChild(name);

    const money = el('div', 'pc-money');
    money.id = `pc-money-${p.id}`;
    money.textContent = p.money !== null ? `$${p.money.toLocaleString('en-US')}` : '?';

    const props = el('div', 'pc-props');
    props.id = `pc-props-${p.id}`;

    const status = el('div', 'pc-status');
    status.id = `pc-status-${p.id}`;

    corner.appendChild(header);
    corner.appendChild(money);
    corner.appendChild(props);
    corner.appendChild(status);
    container.appendChild(corner);
  });
}

export function updateCornerPlayer(p: PublicPlayer): void {
  const corner = byId(`player-corner-${p.id}`);
  if (!corner) return;
  const money = byId<HTMLElement>(`pc-money-${p.id}`);
  if (money) money.textContent = p.money !== null ? `$${p.money.toLocaleString('en-US')}` : '?';
  const status = byId<HTMLElement>(`pc-status-${p.id}`);
  if (status) {
    const parts: string[] = [];
    if (p.isBankrupt) parts.push('💥 مفلس');
    if (p.eliminated) parts.push('🚫 خارج');
    if (p.statusEffects.missedTurnsRemaining > 0) parts.push(`🔒 ${p.statusEffects.missedTurnsRemaining}`);
    if (p.statusEffects.skipNextTurn) parts.push('⏭️');
    if (p.statusEffects.doubleNextRoll) parts.push('🎲🎲');
    if (p.isClubMember) parts.push('🎰');
    status.textContent = parts.join(' ');
  }
}

/** Owned mini-cards under a player corner. */
export function renderCornerProps(ui: UIClientState, players: PublicPlayer[]): void {
  if (!ui.cs) return;
  for (const p of players) {
    const wrap = byId(`pc-props-${p.id}`);
    if (!wrap) continue;
    clear(wrap);
    for (const [squareId, own] of Object.entries(ui.cs.ownership)) {
      if (own.owner !== p.id) continue;
      const sq = ui.cs.board.squares.find((s) => s.id === Number(squareId));
      if (!sq) continue;
      const mini = el('div', 'mini-card');
      mini.style.background = sq.kind === 'property' || sq.kind === 'utility' ? getColorGroupBG(sq.colorGroup) : '#607d8b';
      const icon = el('span');
      icon.textContent =
        sq.kind === 'property' || sq.kind === 'utility' ? (sq.colorGroup === 'utility' ? '⛽' : '🏠') : '🃏';
      const tier = el('span');
      tier.textContent = own.upgrade ? { garage: '🏗️', rest_stop: '🏡', market: '🏬' }[own.upgrade] : '';
      mini.appendChild(icon);
      mini.appendChild(tier);
      wrap.appendChild(mini);
    }
  }
}

export function setDiceFaces(ui: UIClientState): void {
  const face1 = ui.cs && ui.cs.lastRoll ? DICE_FACES[ui.cs.lastRoll.die1] ?? '' : (DICE_FACES[1] ?? '');
  const face2 = ui.cs && ui.cs.lastRoll ? DICE_FACES[ui.cs.lastRoll.die2] ?? '' : (DICE_FACES[1] ?? '');
  const singleDie = ui.cs?.config.diceCount === 1;
  document.querySelectorAll<HTMLElement>('.center-dice').forEach((area) => {
    const dice = Array.from(area.querySelectorAll<HTMLElement>('.die'));
    if (dice[0]) dice[0].textContent = face1;
    if (dice[1]) dice[1].style.display = singleDie ? 'none' : '';
  });
}

export function setDeckCounts(ui: UIClientState): void {
  if (!ui.cs) return;
  const m = byId('mahkama-deck-count');
  const h = byId('hazak-deck-count');
  if (m) m.textContent = String(ui.cs.decks.mahkama.drawCount);
  if (h) h.textContent = String(ui.cs.decks.hazak.drawCount);
}

export function setTurnBanner(ui: UIClientState): void {
  const me = myPlayer(ui);
  const cur = currentPlayer(ui);
  let text = '🎯 —';
  let isMe = false;
  if (ui.cs && ui.cs.gameOver) {
    text = ui.cs.winnerId ? '🏆 انتهت اللعبة' : '🤝 انتهت اللعبة';
  } else if (ui.cs && cur) {
    isMe = me !== null && cur.id === me.id;
    const turnText = isMe ? `دورك أنت` : `دور ${cur.name}`;
    const jail = cur.statusEffects.missedTurnsRemaining > 0 ? ' 🔒' : '';
    text = `🎯 ${turnText}${jail}`;
  }
  document.querySelectorAll<HTMLElement>('.turn-banner').forEach((b) => {
    b.textContent = text;
    b.classList.toggle('my-turn', isMe);
  });
}

/** Enable/disable the always-visible action buttons (center + remote control). */
export function syncActionButtons(ui: UIClientState): void {
  const canR = canRoll(ui);
  const confirmLanding = awaitingLandingConfirm(ui);
  document.querySelectorAll<HTMLButtonElement>('.roll-dice-btn').forEach((b) => {
    b.disabled = !(canR || confirmLanding);
    b.textContent = confirmLanding ? '✅ Landing' : '🎲 Roll';
  });

  const me = myPlayer(ui);
  const inPrison = isMyTurn(ui) && me !== null && me.statusEffects.missedTurnsRemaining > 0;
  document.querySelectorAll<HTMLElement>('.cc-prison').forEach((prison) => {
    prison.style.display = inPrison ? 'flex' : 'none';
    if (inPrison) {
      const freeBtn = prison.querySelector<HTMLButtonElement>('[data-prison="free"]');
      if (freeBtn) freeBtn.style.display = me && me.inventory.jailFreeCards > 0 ? '' : 'none';
      const payBtn = prison.querySelector<HTMLButtonElement>('[data-prison="bail"]');
      if (payBtn) payBtn.disabled = !me || me.money === null || me.money < 100;
    }
  });

  const active = ui.cs !== null && !ui.cs.gameOver;
  document.querySelectorAll<HTMLButtonElement>('.rc-btn-trade').forEach((b) => {
    b.disabled = !active;
  });
  document.querySelectorAll<HTMLButtonElement>('.rc-btn-bid').forEach((b) => {
    b.disabled = !active;
  });
}

export function highlightCurrentTurn(ui: UIClientState): void {
  const corners = document.querySelectorAll<HTMLElement>('.player-corner');
  const cur = currentPlayer(ui);
  corners.forEach((c) => {
    c.classList.toggle('current-turn', cur !== null && c.id === `player-corner-${cur.id}`);
  });
}

// ── Player action popup (click a player's corner) ──

let popupEl: HTMLElement | null = null;

function ensurePopup(): HTMLElement {
  if (popupEl && popupEl.isConnected) return popupEl;
  const root = byId('modals-root') ?? document.body;
  popupEl = el('div', 'player-action-popup');
  popupEl.id = 'player-action-popup';
  root.appendChild(popupEl);
  return popupEl;
}

export function closePlayerActionPopup(): void {
  popupEl?.classList.remove('show');
}

export function showPlayerActionPopup(opts: {
  seatId: SeatId;
  name: string;
  avatar: number;
  canTrade: boolean;
  onTrade: () => void;
  onViewProps: () => void;
}): void {
  const popup = ensurePopup();
  popup.innerHTML = '';

  const header = el('div', 'popup-header');
  const img = new Image();
  img.src = pfpUrl(opts.avatar);
  img.alt = opts.name;
  const strong = el('strong', '', opts.name);
  header.appendChild(img);
  header.appendChild(strong);

  const actions = el('div', 'popup-actions');
  const mk = (label: string, cls: string, fn: () => void) => {
    const b = el('button', `btn ${cls}`, label) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  if (opts.canTrade) {
    mk('🤝 Trade', 'btn-trade', () => {
      closePlayerActionPopup();
      opts.onTrade();
    });
  }
  mk('🏠 View Properties', '', () => {
    closePlayerActionPopup();
    opts.onViewProps();
  });
  mk('❌ Cancel', 'btn-decline', closePlayerActionPopup);

  popup.appendChild(header);
  popup.appendChild(actions);
  popup.classList.add('show');
}
