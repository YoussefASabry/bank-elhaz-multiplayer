/**
 * The four player panels and the tokens standing on the board.
 *
 * Hidden balances are no longer a client-side courtesy. The legacy panel checked
 * `gameMeta.moneyVisible` and chose not to DRAW other players' money, while the
 * server had already broadcast it to everyone — anyone with a console could read
 * it (B23). Now the server sends `money: null` to players who may not see it, so
 * `null` is the only thing there is to render.
 */

import type { PublicPlayer } from '../../shared/events.js';
import type { SeatId } from '../../shared/types.js';
import { byId, qs, qsa, escapeHtml } from '../dom.js';
import { S, upgradeIcon } from '../state.js';
import { getPfpUrl } from '../theme.js';
import { getColorGroupBG } from './cells.js';
import { squaresOwnedBy, type ViewState, type ViewSquare } from '../view-model.js';

/** Panel placement per active-player count, exactly as the original laid it out. */
export function getCornerLayout(count: number): readonly string[] {
  if (count <= 2) return ['corner-tl', 'corner-br'];
  if (count === 3) return ['corner-tc', 'corner-bl', 'corner-br'];
  if (count === 4) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br'];
  if (count === 5) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lc'];
  if (count === 6) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lc', 'corner-rc'];
  if (count === 7) {
    return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lt', 'corner-lc', 'corner-rc'];
  }
  return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lt', 'corner-lb', 'corner-rt', 'corner-rc'];
}

function inventoryBadges(p: PublicPlayer): string {
  const items: string[] = [];
  if (p.isClubMember) {
    items.push(
      '<span class="mini-inv-badge" style="background:linear-gradient(135deg,#fff3e0,#ffe0b2);border:1px solid #ff9800;">🎰 Club</span>',
    );
  }
  const jail = p.inventory.jailFreeCards;
  if (jail > 0) {
    items.push(
      `<span class="mini-inv-badge" style="background:linear-gradient(135deg,#fce4ec,#f8bbd0);border:1px solid #c62828;">🔓 Jail×${jail}</span>`,
    );
  }
  return items.length > 0
    ? `<div class="pc-inv" style="display:flex;gap:3px;flex-wrap:wrap;">${items.join('')}</div>`
    : '';
}

function propertyChips(props: readonly ViewSquare[]): string {
  return props
    .map((sq) => {
      const bg = getColorGroupBG(sq.colorGroup);
      const upg = upgradeIcon(sq.upgrade);
      const title = escapeHtml(sq.name) + (upg ? ' (' + upg + ')' : '');
      return `<span class="mini-card" style="background:${bg};color:#fff;" title="${title}">${escapeHtml(sq.name.slice(0, 3))}${upg}</span>`;
    })
    .join('');
}

function statusText(p: PublicPlayer): string {
  if (p.isBankrupt) return '💀 Bankrupt';
  if (p.eliminated) return '🚫 Removed';
  if (p.statusEffects.missedTurnsRemaining > 0) return '🔒 In prison';
  return '';
}

export function renderPlayerCorners(): void {
  const view = S.view;
  if (!view) return;
  const container = byId('player-corners');
  if (!container) return;

  const active = view.players.filter((p) => !p.isBankrupt).length;
  const corners = getCornerLayout(active);

  container.innerHTML = view.players
    .map((p, i) => {
      const cornerClass = corners[i % corners.length] ?? 'corner-tl';
      const isCurrent = i === view.currentPlayerIndex;
      // `money === null` means the host hid balances and this viewer is not the
      // owner — the server already withheld the number.
      const moneyDisplay = p.money === null ? '💰 ???' : `$${p.money}`;
      const clickable = !p.isBankrupt;
      const props = squaresOwnedBy(view, p.id).filter((sq) => sq.kind === 'property' || sq.kind === 'utility');
      const chips = propertyChips(props);
      const status = statusText(p);
      const badges = inventoryBadges(p);

      return `
        <div class="player-corner ${cornerClass} ${isCurrent ? 'current-turn' : ''} ${p.isBankrupt ? 'bankrupt' : ''} ${p.connected === false ? 'disconnected' : ''}" data-player-id="${escapeHtml(p.id)}" style="${clickable ? 'cursor:pointer;' : ''}" ${clickable ? `onclick="onPlayerCardClick('${escapeHtml(p.id)}')"` : ''}>
          <div class="pc-header"><img src="${getPfpUrl(p.avatar || 1)}" alt="" />${escapeHtml(p.name)}${p.connected === false ? ' 🔴' : ''}</div>
          <div class="pc-money">${moneyDisplay}</div>
          ${badges}
          ${chips ? `<div class="pc-props">${chips}</div>` : ''}
          ${status ? `<div class="pc-status">${status}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

export function renderTokens(view: ViewState): void {
  qsa('.cell .tokens').forEach((el) => {
    el.innerHTML = '';
  });
  for (const p of view.players) {
    if (p.isBankrupt || p.eliminated) continue;
    const cell = qs(`.cell[data-id="${p.position}"] .tokens`);
    if (!cell) continue;
    const token = document.createElement('div');
    token.className = 'token';
    token.innerHTML = `<img src="${getPfpUrl(p.avatar || 1)}" alt="" />`;
    token.title = p.name;
    token.dataset['pid'] = p.id;
    cell.appendChild(token);
  }
}

/** The token element for a seat, used by the movement animation. */
export function tokenFor(seat: SeatId): HTMLElement | null {
  return qs<HTMLElement>(`.token[data-pid="${seat}"]`);
}
