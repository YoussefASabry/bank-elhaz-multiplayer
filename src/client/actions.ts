/**
 * Player intents: every button that talks to the server.
 *
 * Each of these sends an INTENT and nothing else (WIRE.md rule 2) — no state, no
 * computed outcome. Prices shown in confirmations are display values derived
 * from the projection; the server recomputes them and is free to disagree.
 */

import type { DeckType, SquareId, UpgradeTier } from '../shared/types.js';
import { byId, setHtml, escapeHtml } from './dom.js';
import { S } from './state.js';
import { socket } from './net/socket.js';
import { getPfpUrl } from './theme.js';
import { getColorGroupBG } from './render/cells.js';
import { closeAllModals } from './ui/modals.js';
import { showToast } from './ui/effects.js';
import { UPGRADE_ICONS, UPGRADE_LABELS } from './state.js';
import { pendingOf, playerById, squareById, squaresOwnedBy } from './view-model.js';

/** Refund/resale rate the UI quotes. The server owns the real arithmetic. */
const RESALE_RATE = 0.75;

function room(): string | null {
  return S.roomCode;
}

// ── Turn ──

export function rollDice(): void {
  const view = S.view;
  const rc = room();
  if (S.isAnimating || !view || rc === null) return;
  if (view.currentPlayer?.id !== S.myPlayerId) return;
  if (view.phase !== 'roll') return;
  socket.emit('roll_dice', { roomCode: rc });
  const btn = byId<HTMLButtonElement>('btn-roll');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🎲 Rolling...';
  }
}

export function initDebugDropdown(): void {
  const view = S.view;
  const sel = byId<HTMLSelectElement>('debug-tile-select');
  if (!view || !sel) return;
  sel.innerHTML = view.squares
    .map((sq) => `<option value="${sq.id}">${sq.id} - ${escapeHtml(sq.name)}</option>`)
    .join('');
}

export function debugGo(): void {
  const sel = byId<HTMLSelectElement>('debug-tile-select');
  const rc = room();
  if (!sel || rc === null) return;
  const targetId = Number.parseInt(sel.value, 10);
  if (!Number.isFinite(targetId) || targetId <= 0) return;
  socket.emit('debug_roll', { roomCode: rc, targetId });
  const btn = byId<HTMLButtonElement>('btn-roll');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🎲 Debug...';
  }
}

export function drawFromDeck(deckType: DeckType): void {
  const view = S.view;
  const rc = room();
  if (!view || rc === null) return;
  if (view.currentPlayer?.id !== S.myPlayerId) return;
  if (view.phase !== 'draw_card') return;
  const pending = pendingOf(view, 'deck_draw');
  if (!pending) return;
  // The queue names what may be drawn next; square 4 holds two entries.
  if (!pending.queue.includes(deckType)) return;
  socket.emit('draw_card', { roomCode: rc, deckType });
}

// ── Landing choices ──

export function chooseClub(choice: 'membership' | 'guest'): void {
  const rc = room();
  if (rc === null) return;
  closeAllModals();
  socket.emit('club_choice', { roomCode: rc, choice });
}

export function buyProperty(): void {
  const rc = room();
  if (rc === null) return;
  closeAllModals();
  socket.emit('buy_property', { roomCode: rc });
}

export function declineProperty(): void {
  const rc = room();
  if (rc === null) return;
  closeAllModals();
  socket.emit('decline_property', { roomCode: rc });
}

export function payRent(): void {
  const rc = room();
  if (rc === null) return;
  socket.emit('pay_rent', { roomCode: rc });
}

export function declareBankrupt(): void {
  const rc = room();
  if (rc === null) return;
  if (!confirm('Declare bankruptcy? You will lose all properties and go to jail for 5 turns.')) return;
  socket.emit('declare_bankrupt_from_rent', { roomCode: rc });
}

export function confirmBlindCard(): void {
  const rc = room();
  if (rc === null) return;
  closeAllModals();
  const btn = byId<HTMLButtonElement>('btn-confirm-card');
  if (btn) btn.disabled = true;
  socket.emit('confirm_blind_card', { roomCode: rc });
}

export function selectCardChoice(index: number): void {
  const rc = room();
  if (rc === null) return;
  closeAllModals();
  socket.emit('card_choice', { roomCode: rc, choiceIndex: index });
}

// ── Prison ──

export function skipPrison(): void {
  const rc = room();
  if (rc !== null) socket.emit('skip_prison', { roomCode: rc });
}

export function useJailFree(): void {
  const rc = room();
  if (rc !== null) socket.emit('use_jail_free', { roomCode: rc });
}

export function payBail(): void {
  const rc = room();
  if (rc !== null) socket.emit('pay_bail', { roomCode: rc });
}

// ── Player list / admin ──

export function openPlayerList(): void {
  const view = S.view;
  const roster = view
    ? view.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        connected: p.connected,
        isBankrupt: p.isBankrupt,
      }))
    : S.lobbyPlayers.map((p) => ({ ...p, isBankrupt: false }));

  if (roster.length === 0) return;
  const isHost = roster[0]?.id === S.myPlayerId;

  const html = roster
    .map((p) => {
      const status = p.isBankrupt ? '💀' : p.connected === false ? '🔴 Disconnected' : '🟢 Connected';
      const kick =
        isHost && !p.isBankrupt && p.id !== S.myPlayerId
          ? `<button class="btn btn-decline btn-sm" onclick="terminatePlayer('${escapeHtml(p.id)}')" style="font-size:0.75rem;padding:2px 8px;">⛔ Kick</button>`
          : '';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #e0d5c0;">
        <span><img src="${getPfpUrl(p.avatar || 1)}" style="width:28px;height:28px;border-radius:50%;vertical-align:middle;margin-right:8px;" />${escapeHtml(p.name)} <span style="font-size:0.8rem;color:#888;">${status}</span></span>${kick}</div>`;
    })
    .join('');

  setHtml('player-list-content', html);
  byId('player-list-modal')?.classList.add('show');
}

export function closePlayerList(): void {
  byId('player-list-modal')?.classList.remove('show');
}

export function terminatePlayer(playerId: string): void {
  const rc = room();
  if (rc === null) return;
  if (
    !confirm(
      'Kick this player? Their money will be split among remaining players, properties freed, and they cannot rejoin.',
    )
  ) {
    return;
  }
  socket.emit('terminate_player', { roomCode: rc, targetId: playerId });
  closePlayerList();
}

// ── Inventory ──

function upgradeRefundFor(squareId: SquareId): number {
  const view = S.view;
  if (!view) return 0;
  const sq = squareById(view, squareId);
  if (!sq || sq.upgrade === null || sq.buildCost === null) return 0;
  return Math.round(sq.buildCost[sq.upgrade] * RESALE_RATE);
}

function propertyResaleFor(squareId: SquareId): number {
  const view = S.view;
  if (!view) return 0;
  const sq = squareById(view, squareId);
  return Math.floor((sq?.purchasePrice ?? 0) * RESALE_RATE);
}

export function openInventory(): void {
  const view = S.view;
  if (!view) return;
  const me = playerById(view, S.myPlayerId);
  if (!me) return;

  const owned = squaresOwnedBy(view, S.myPlayerId);
  let html: string;

  if (owned.length === 0) {
    html = '<div style="text-align:center;color:#7a5a3a;padding:20px;">You don\'t own any properties.</div>';
  } else {
    html = owned
      .map((sq) => {
        const bg = getColorGroupBG(sq.colorGroup);
        const icon = sq.upgrade === null ? '' : UPGRADE_ICONS[sq.upgrade];
        const label = sq.upgrade === null ? '' : UPGRADE_LABELS[sq.upgrade];
        const resale = propertyResaleFor(sq.id);
        const refund = upgradeRefundFor(sq.id);

        const sellUpgradeBtn =
          sq.upgrade !== null
            ? `<button class="btn btn-warn btn-sm" onclick="confirmSellUpgrade(${sq.id})" style="font-size:0.65rem;padding:2px 6px;">Sell ${icon} ($${refund})</button>`
            : '';
        const sellPropBtn =
          sq.upgrade === null
            ? `<button class="btn btn-warn btn-sm" onclick="confirmSellProperty(${sq.id})" style="font-size:0.65rem;padding:2px 6px;">Sell ($${resale})</button>`
            : '<span style="font-size:0.6rem;color:#c0392b;">Sell upgrade first</span>';

        return `<div style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid #e0d0b0;font-size:0.8rem;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${bg};flex-shrink:0;"></span>
          <span style="flex:1;font-weight:bold;">${escapeHtml(sq.name)}</span>
          <span style="color:#7a5a3a;font-size:0.7rem;">${icon} ${label}</span>
          <span style="color:#8B6914;font-size:0.7rem;">$${sq.purchasePrice ?? 0}</span>
        ${sellUpgradeBtn}${sellPropBtn}</div>`;
      })
      .join('');
  }

  setHtml('inventory-list', html);
  byId('inventory-modal')?.classList.add('show');
}

export function closeInventory(): void {
  byId('inventory-modal')?.classList.remove('show');
}

export function confirmSellUpgrade(propertyId: SquareId): void {
  const view = S.view;
  const rc = room();
  if (!view || rc === null) return;
  const sq = squareById(view, propertyId);
  if (!sq || sq.upgrade === null) return;
  const refund = upgradeRefundFor(propertyId);
  if (!confirm(`Sell ${sq.upgrade} on ${sq.name} for $${refund}?`)) return;
  socket.emit('sell_upgrade', { roomCode: rc, propertyId });
  closeInventory();
}

export function confirmSellProperty(propertyId: SquareId): void {
  const view = S.view;
  const rc = room();
  if (!view || rc === null) return;
  const sq = squareById(view, propertyId);
  if (!sq) return;
  if (sq.upgrade !== null) {
    showToast('❌ Sell the upgrade first before selling the property.');
    return;
  }
  const resale = propertyResaleFor(propertyId);
  if (!confirm(`Sell ${sq.name} for $${resale}?`)) return;
  socket.emit('sell_property', { roomCode: rc, propertyId });
  closeInventory();
}

export function sellProperty(propertyId: SquareId): void {
  const rc = room();
  if (rc !== null) socket.emit('sell_property', { roomCode: rc, propertyId });
}

export function buyUpgrade(propertyId: SquareId, upgradeType: UpgradeTier): void {
  const rc = room();
  if (rc === null) return;
  socket.emit('buy_upgrade', { roomCode: rc, propertyId, upgradeType });
  byId('upgrade-modal')?.classList.remove('show');
}

export function skipUpgrade(): void {
  const rc = room();
  if (rc === null) return;
  socket.emit('skip_upgrade', { roomCode: rc });
  byId('upgrade-modal')?.classList.remove('show');
}
