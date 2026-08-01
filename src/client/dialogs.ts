import type { Action } from '../shared/actions';
import type { Card, SquareId } from '../shared/types';
import { buildDialogModal, BUILT_DIALOGS } from './dialog-builders';
import type { DialogCtx } from './dialog-builders';
import { UPGRADE_ICONS } from './constants';
import { byId, clear, el, fmt } from './dom';
import type { ClientAction, DialogName, UIClientState } from './store';
import { visibleDialog } from './store';

export interface DialogApi extends DialogCtx {
  getStore: () => UIClientState;
  dispatch: (action: ClientAction) => void;
}

let api: DialogApi | null = null;
const roots = new Map<DialogName, HTMLElement>();
let lastVisible: DialogName | null = null;
let lastPendingSignature = '';

function root(name: DialogName): HTMLElement | null {
  return roots.get(name) ?? null;
}

function show(name: DialogName | null): void {
  const prev = lastVisible;
  if (prev !== null && prev !== name) {
    root(prev)?.classList.remove('show');
  }
  if (name !== null && name !== prev) {
    root(name)?.classList.add('show');
  }
  lastVisible = name;
}

export function isVisible(name: DialogName): boolean {
  return lastVisible === name;
}

function emit(action: Action): void {
  if (api) api.emitAction(action);
}

// ── Renderers ──

function renderPropertyBuy(ui: UIClientState): void {
  const o = root('property_buy');
  if (!o || !ui.cs) return;
  const cs = ui.cs;
  const pending = cs.pending;
  if (pending.kind !== 'property_buy') return;
  const sq = cs.board.squares.find((s) => s.id === pending.squareId);
  const nameEl = byId('buy-prop-name');
  const priceEl = byId('buy-prop-price');
  if (!nameEl || !priceEl) return;
  nameEl.textContent = sq ? sq.name : '';
  priceEl.textContent = sq && 'purchasePrice' in sq ? `$${fmt(sq.purchasePrice)}` : '';
}

function renderUpgrade(ui: UIClientState): void {
  const o = root('upgrade');
  if (!o || !ui.cs) return;
  const cs = ui.cs;
  const pending = cs.pending;
  if (pending.kind !== 'upgrade') return;
  const sq = cs.board.squares.find((s) => s.id === pending.squareId);
  const nameEl = byId('upgrade-prop-name');
  if (nameEl) nameEl.textContent = sq ? sq.name : '';
  const optionsEl = byId('upgrade-options');
  if (!optionsEl) return;
  clear(optionsEl);
  for (const option of pending.options) {
    const btn = el('button', 'btn btn-buy');
    btn.type = 'button';
    const icon = UPGRADE_ICONS[option.tier] ?? '';
    btn.textContent = `${icon} ${option.tier} — $${fmt(option.cost)} (rent $${fmt(option.visitorRent)})`;
    btn.addEventListener('click', () =>
      emit({ type: 'BUY_UPGRADE', actorId: '', squareId: pending.squareId, tier: option.tier }),
    );
    optionsEl.appendChild(btn);
  }
}

function choiceLabel(choice: import('../shared/types').Choice, squareName?: string): string {
  if (choice.label) return choice.label;
  switch (choice.type) {
    case 'receive_cash':
      return `💰 Take $${fmt(choice.amount)}`;
    case 'pay_fine':
      return `💸 Pay $${fmt(choice.amount)}`;
    case 'go_to_prison':
      return '🔒 Go to Prison';
    case 'claim_free_property':
      return squareName ? `🏠 Claim ${squareName}` : '🏠 Claim a Property';
    case 'move_to_dynamic_pool':
      return squareName ? `🚶 Move to ${squareName}` : '🚶 Move to a Property';
    default:
      return 'Choose';
  }
}

function renderCardChoice(ui: UIClientState): void {
  const o = root('card_choice');
  if (!o || !ui.cs || ui.cs.pending.kind !== 'card_choice') return;
  const pending = ui.cs.pending;
  const titleEl = byId('card-choice-title');
  if (titleEl) titleEl.textContent = pending.title;
  const body = byId('card-choice-body');
  if (!body) return;
  clear(body);

  const flat: { choice: import('../shared/types').Choice; squareId?: SquareId }[] = [];
  for (const choice of pending.options) {
    if (choice.type === 'claim_free_property' || choice.type === 'move_to_dynamic_pool') {
      for (const squareId of pending.propertyPool) flat.push({ choice, squareId });
    } else {
      flat.push({ choice });
    }
  }
  flat.forEach((entry, index) => {
    const name = entry.squareId !== undefined
      ? ui.cs!.board.squares.find((s) => s.id === entry.squareId)?.name
      : undefined;
    const btn = el('button', 'btn btn-buy');
    btn.type = 'button';
    btn.textContent = choiceLabel(entry.choice, name);
    btn.addEventListener('click', () => emit({ type: 'CHOOSE_CARD_OPTION', actorId: '', index }));
    body.appendChild(btn);
  });
  if (flat.length === 0) {
    const btn = el('button', 'btn btn-buy', '✅ Confirm');
    btn.type = 'button';
    btn.addEventListener('click', () => emit({ type: 'CONFIRM_CARD', actorId: '' }));
    body.appendChild(btn);
  }
}

function cityNamesFor(card: Card, ui: UIClientState): string[] {
  if (!ui.cs) return [];
  const ids = card.id === 15 ? (card.choices[0]?.type === 'claim_free_property' ? card.choices[0].poolOptions : undefined)
    : undefined;
  const pool = ids && ids.length > 0 ? ids : (ui.cs.pending.kind === 'card_choice' ? ui.cs.pending.propertyPool : undefined);
  if (!pool) return [];
  return pool
    .map((id) => ui.cs!.board.squares.find((s) => s.id === id)?.name)
    .filter((n): n is string => n !== undefined);
}

function renderBlindCard(ui: UIClientState): void {
  const o = root('blind_card');
  if (!o || !ui.cs || ui.cs.pending.kind !== 'blind_card') return;
  const pending = ui.cs.pending;
  const card = pending.card;
  const isMahkama = card.deck === 'mahkama';
  const prefix = pending.remainingDraws.length > 0 ? '(سحب ورقتين)' : '';

  const titleEl = byId('blind-card-title');
  if (titleEl) titleEl.textContent = isMahkama ? `⚖️ محكمة ${prefix}` : `🍀 حظك ${prefix}`;

  const face = byId('card-face-content');
  if (face) {
    face.classList.remove('mahkama-face', 'hazak-face');
    face.classList.add(isMahkama ? 'mahkama-face' : 'hazak-face');
  }
  const header = byId('card-face-header');
  if (header) header.textContent = isMahkama ? '⚖️' : '🍀';
  const type = byId('card-face-type');
  if (type) type.textContent = isMahkama ? '⚖️ المحكمة' : '🍀 حظك';
  const desc = byId('card-face-desc');
  if (desc) desc.textContent = card.description || '—';

  const citiesEl = byId('card-face-cities');
  const effectEl = byId('card-face-effect');
  if (citiesEl) {
    const cityNames = pending.cityIds
      ? pending.cityIds.map((id) => ui.cs!.board.squares.find((s) => s.id === id)?.name).filter((n): n is string => n !== undefined)
      : [];
    if (cityNames.length > 0) {
      citiesEl.textContent = `🏙️ ${cityNames.join('، ')}`;
      citiesEl.style.display = 'block';
    } else {
      citiesEl.style.display = 'none';
    }
  }
  if (effectEl) {
    effectEl.style.display = 'none';
    if (card.params.repairCosts) {
      effectEl.textContent = `أسواق: ${fmt(card.params.repairCosts.market)}ج | استراحات: ${fmt(card.params.repairCosts.rest_stop)}ج | جراجات: ${fmt(card.params.repairCosts.garage)}ج`;
      effectEl.style.display = 'block';
    } else if (card.action === 'choice') {
      if (card.id === 11) {
        effectEl.textContent = 'مدينة خالية ≤ 150ج أو 100ج نقداً';
        effectEl.style.display = 'block';
      } else if (card.id === 15) {
        effectEl.textContent = 'ادفع 100ج أو اذهب للسجن';
        effectEl.style.display = 'block';
      }
    }
  }

  const btn = byId('btn-confirm-card');
  if (btn) {
    (btn as HTMLButtonElement).disabled = false;
    btn.classList.toggle('mahkama-confirm-btn', isMahkama);
  }
}

function renderClub(ui: UIClientState): void {
  const o = root('club');
  if (!o || !ui.cs || ui.cs.pending.kind !== 'club') return;
  const pending = ui.cs.pending;
  const me = ui.cs.players.find((p) => p.id === ui.mySeatId);
  const desc = byId('club-desc');
  if (desc) desc.textContent = 'وصلت إلى نادي الحظ!';
  const membership = byId('club-membership');
  if (membership) membership.textContent = `🎫 العضوية: $${fmt(pending.membershipCost)}`;
  const guest = byId('club-guest');
  if (guest) guest.textContent = `🚪 ضيف: $${fmt(pending.guestFineFee)}`;
  const btnM = byId<HTMLButtonElement>('btn-club-membership');
  if (btnM) btnM.disabled = me != null && me.money !== null && me.money < pending.membershipCost;
}

function renderRent(ui: UIClientState): void {
  const o = root('rent');
  if (!o || !ui.cs || ui.cs.pending.kind !== 'rent') return;
  const pending = ui.cs.pending;
  const owner = pending.ownerId !== null ? ui.cs.players.find((p) => p.id === pending.ownerId) : null;
  const info = byId('rent-info');
  if (info) info.textContent = owner ? `ادفع الإيجار لـ ${owner.name}` : 'ادفع الإيجار';
  const amount = byId('rent-amount');
  if (amount) amount.textContent = `$${fmt(pending.amount)}`;
  const me = ui.cs.players.find((p) => p.id === ui.mySeatId);
  const pay = byId<HTMLButtonElement>('btn-pay-rent');
  if (pay && me != null && me.money !== null && me.money < pending.amount) {
    pay.disabled = true;
    pay.textContent = '💸 لا يوجد مال كافٍ';
  } else if (pay) {
    pay.disabled = false;
    pay.textContent = '💰 Pay Rent';
  }
}

function renderWinner(ui: UIClientState): void {
  const o = root('winner');
  if (!o) return;
  const text = byId('winner-text');
  if (!text || !ui.cs) return;
  const cs = ui.cs;
  if (cs.winnerId === null) {
    text.textContent = 'انتهت اللعبة بالتعادل';
    return;
  }
  const winner = cs.players.find((p) => p.id === cs.winnerId);
  text.textContent = winner
    ? winner.id === ui.mySeatId
      ? '🎉 فزت باللعبة!'
      : `فاز ${winner.name} 🏆`
    : 'انتهت اللعبة';
}

// ── Public API ──

export function initDialogs(opts: DialogApi): void {
  api = opts;
  const container = byId('modals-root');
  if (!container) return;
  const ctx: DialogCtx = {
    emitAction: (a) => emit(a),
    closeInspect: () => api?.dispatch({ type: 'dialogClose', name: 'inspect' }),
    closeInventory: () => api?.dispatch({ type: 'dialogClose', name: 'inventory' }),
    closePlayerList: () => api?.dispatch({ type: 'dialogClose', name: 'player_list' }),
    acceptTradeRequest: () => api?.acceptTradeRequest(),
    declineTradeRequest: () => api?.declineTradeRequest(),
    confirmSellBuilding: () => api?.confirmSellBuilding(),
    closeSellBuilding: () => api?.closeSellBuilding(),
    leaveToLobby: () => api?.leaveToLobby(),
  };
  for (const name of BUILT_DIALOGS) {
    const node = buildDialogModal(name, ctx);
    roots.set(name, node);
    container.appendChild(node);
  }
}

/**
 * Reconcile decision dialogs against the current pending. Runs on every store
 * change. Decision dialogs open only when the pending addresses this client,
 * and are closed automatically when the server advances (closeOnServer).
 */
export function syncDialogs(ui: UIClientState): void {
  if (!ui.cs) return;
  const me = ui.mySeatId;

  const wanted = new Map<DialogName, boolean>();
  const p = ui.cs.pending;
  if (p.kind === 'property_buy' && p.playerId === me) wanted.set('property_buy', true);
  if (p.kind === 'upgrade' && p.playerId === me) wanted.set('upgrade', true);
  if (p.kind === 'card_choice' && p.playerId === me) wanted.set('card_choice', true);
  if (p.kind === 'blind_card' && p.playerId === me) wanted.set('blind_card', true);
  if (p.kind === 'club' && p.playerId === me) wanted.set('club', true);
  if (p.kind === 'rent' && p.playerId === me) wanted.set('rent', true);

  const decisionNames: DialogName[] = [
    'property_buy',
    'upgrade',
    'card_choice',
    'blind_card',
    'club',
    'rent',
  ];

  if (ui.cs.gameOver) {
    wanted.clear();
    wanted.set('winner', true);
  }

  const currentOpen = new Set(ui.dialogs.map((d) => d.name));
  for (const name of decisionNames) {
    const shouldOpen = wanted.get(name) ?? false;
    if (shouldOpen && !currentOpen.has(name)) {
      api?.dispatch({ type: 'dialogOpen', name, closeOnServer: true });
    } else if (!shouldOpen && currentOpen.has(name)) {
      api?.dispatch({ type: 'dialogClose', name });
    }
  }
}

/** Re-render open dialog contents + manage visibility. */
export function renderDialogs(ui: UIClientState): void {
  renderPropertyBuy(ui);
  renderUpgrade(ui);
  renderCardChoice(ui);
  renderBlindCard(ui);
  renderClub(ui);
  renderRent(ui);
  renderWinner(ui);

  const top = visibleDialog(ui);
  show(top ? top.name : null);
}

export function pendingSignature(ui: UIClientState): string {
  if (!ui.cs) return 'none';
  const p = ui.cs.pending;
  return `${p.kind}:${'playerId' in p ? p.playerId : ''}:${ui.cs.phase}`;
}

export function setLastPendingSignature(sig: string): void {
  lastPendingSignature = sig;
}

export function getLastPendingSignature(): string {
  return lastPendingSignature;
}

export { cityNamesFor };
