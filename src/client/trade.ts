import type { Action } from '../shared/actions';
import type { SeatId } from '../shared/types';
import { byId, clear, el } from './dom';
import { pfpUrl } from './constants';
import type { UIClientState } from './store';
import { isDialogOpen, myPlayer } from './store';
import type { DialogApi } from './dialogs';
import { basketSummary, emptyBasket, renderBasketEdit } from './trade-basket';

let api: DialogApi | null = null;
let minimized = false;

function emit(action: Action): void {
  if (api) api.emitAction(action);
}

function me(ui: UIClientState) {
  return myPlayer(ui);
}

function myTrade(ui: UIClientState) {
  if (!ui.cs) return undefined;
  return ui.cs.trades.find((t) => t.a === ui.mySeatId || t.b === ui.mySeatId);
}

// ── Markup ──

function buildTradeModal(): HTMLElement {
  const o = el('div', 'modal-overlay');
  o.id = 'trade-modal';
  const b = el('div', 'modal-box');
  b.style.cssText = 'max-width:680px;';

  const header = el('div', 'trade-header');
  const h = el('h2', '', '🤝 Trade');
  const actions = el('div', 'trade-header-actions');
  const minimizeBtn = el('button', '', '─');
  minimizeBtn.type = 'button';
  minimizeBtn.addEventListener('click', () => setMinimized(true));
  const closeBtn = el('button', '', '✕');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => cancelTrade());
  actions.appendChild(minimizeBtn);
  actions.appendChild(closeBtn);
  header.appendChild(h);
  header.appendChild(actions);

  const timer = el('div', 'trade-timer');
  timer.id = 'trade-timer';
  const status = el('div', 'trade-status');
  status.id = 'trade-status';
  status.textContent = 'Starting trade...';
  const panels = el('div', 'trade-panels');
  panels.id = 'trade-panels';
  const footer = el('div', 'trade-footer');
  footer.id = 'trade-footer';

  b.appendChild(header);
  b.appendChild(timer);
  b.appendChild(status);
  b.appendChild(panels);
  b.appendChild(footer);
  o.appendChild(b);
  return o;
}

function buildMinimizedBar(): HTMLElement {
  const bar = el('div');
  bar.id = 'trade-minimized-bar';
  bar.textContent = '📦 Trade ';
  const span = el('span');
  span.id = 'mini-trade-status';
  span.textContent = 'active';
  const close = el('span', 'bar-close', '✕');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelTrade();
  });
  bar.appendChild(span);
  bar.appendChild(close);
  bar.addEventListener('click', () => setMinimized(false));
  return bar;
}

function buildPlayerSelector(): HTMLElement {
  const o = el('div');
  o.id = 'player-selector';
  const box = el('div', 'ps-box');
  const h = el('h3', '', '🤝 Choose a player to trade with');
  const list = el('div');
  list.id = 'ps-list';
  const closeBtn = el('div', 'ps-close-btn', 'Cancel');
  closeBtn.addEventListener('click', () => o.classList.remove('show'));
  box.appendChild(h);
  box.appendChild(list);
  box.appendChild(closeBtn);
  o.appendChild(box);
  return o;
}

// ── Panel rendering ──

function renderOtherSide(ui: UIClientState, container: HTMLElement, playerId: string, basket: Parameters<typeof basketSummary>[1]): void {
  clear(container);
  const p = ui.cs?.players.find((x) => x.id === playerId);
  const header = el('div', 'trade-player-header');
  const img = new Image();
  img.src = pfpUrl(p?.avatar ?? 0);
  img.width = 28;
  img.height = 28;
  const name = el('span', '', p?.name ?? '?');
  header.appendChild(img);
  header.appendChild(name);
  container.appendChild(header);
  const summary = el('div', 'trade-basket-view');
  summary.textContent = basketSummary(ui, basket);
  container.appendChild(summary);
}

function stageStatus(ui: UIClientState, trade: NonNullable<ReturnType<typeof myTrade>>): string {
  const iAm = (id: string) => id === ui.mySeatId;
  const a = trade.a;
  const b = trade.b;
  switch (trade.stage) {
    case 'proposing_a':
      return iAm(a) ? 'قدّم عرضك الأول' : 'بانتظار عرض الطرف الآخر...';
    case 'reviewing_b':
      return iAm(b) ? 'راجع عرض الطرف الآخر ثم قرر' : 'بانتظار رد الطرف الآخر...';
    case 'proposing_b':
      return iAm(b) ? 'قدّم عرضك الآن' : 'بانتظار عرض الطرف الآخر...';
    case 'reviewing_a':
      return iAm(a) ? 'راجع العرض النهائي ثم قرر' : 'بانتظار الرد النهائي...';
    default:
      return '';
  }
}

function renderFooter(ui: UIClientState, trade: NonNullable<ReturnType<typeof myTrade>>): void {
  const footer = byId('trade-footer');
  if (!footer) return;
  clear(footer);
  const iAm = (id: string) => id === ui.mySeatId;
  const meIsA = iAm(trade.a);
  const btn = (label: string, cls: string, action: () => void): HTMLButtonElement => {
    const b = el('button', `btn ${cls}`, label) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  };

  switch (trade.stage) {
    case 'proposing_a':
      if (meIsA) {
        footer.appendChild(btn('📨 إرسال العرض', 'btn-buy', () => propose(ui)));
        footer.appendChild(btn('✕ إلغاء', 'btn-decline', () => cancelTrade()));
      }
      break;
    case 'reviewing_b':
      if (!meIsA) {
        footer.appendChild(btn('✅ قبول', 'btn-buy', () => emit({ type: 'TRADE_ACCEPT', actorId: '' })));
        footer.appendChild(btn('❌ رفض', 'btn-decline', () => emit({ type: 'TRADE_DECLINE', actorId: '' })));
        footer.appendChild(btn('✕ إلغاء', 'btn-decline', () => cancelTrade()));
      }
      break;
    case 'proposing_b':
      if (!meIsA) {
        footer.appendChild(btn('📨 إرسال العرض', 'btn-buy', () => propose(ui)));
        footer.appendChild(btn('✕ إلغاء', 'btn-decline', () => cancelTrade()));
      }
      break;
    case 'reviewing_a':
      if (meIsA) {
        footer.appendChild(btn('✅ قبول و إتمام', 'btn-buy', () => emit({ type: 'TRADE_ACCEPT', actorId: '' })));
        footer.appendChild(btn('❌ رفض', 'btn-decline', () => emit({ type: 'TRADE_DECLINE', actorId: '' })));
        footer.appendChild(btn('✕ إلغاء', 'btn-decline', () => cancelTrade()));
      }
      break;
    default:
      break;
  }
}

function propose(ui: UIClientState): void {
  const offer = ui.myOffer ?? emptyBasket();
  emit({ type: 'TRADE_PROPOSE', actorId: '', basket: offer });
}

function cancelTrade(): void {
  emit({ type: 'TRADE_CANCEL', actorId: '' });
  api?.dispatch({ type: 'dialogClose', name: 'trade' });
}

export function setMinimized(value: boolean): void {
  minimized = value;
  const bar = byId('trade-minimized-bar');
  if (bar) bar.style.display = value ? 'block' : 'none';
  if (value) {
    api?.dispatch({ type: 'dialogClose', name: 'trade' });
  } else {
    api?.dispatch({ type: 'dialogOpen', name: 'trade' });
  }
}

function renderTradePanel(ui: UIClientState, trade: NonNullable<ReturnType<typeof myTrade>>): void {
  const status = byId('trade-status');
  if (status) status.textContent = stageStatus(ui, trade);

  const timer = byId('trade-timer');
  if (timer) {
    const remaining = ui.lastTradeTimers[trade.id];
    timer.textContent = remaining !== undefined ? `⏳ ${remaining}s` : '';
    timer.style.display = remaining !== undefined ? 'block' : 'none';
  }

  const panels = byId('trade-panels');
  if (!panels) return;
  clear(panels);

  const meIsA = trade.a === ui.mySeatId;
  const partnerId = meIsA ? trade.b : trade.a;
  const myBasket = meIsA ? trade.proposalA : trade.proposalB;
  const partnerBasket = meIsA ? trade.proposalB : trade.proposalA;

  const myCol = el('div', 'trade-panel-col');
  const myHeader = el('div', 'trade-player-header');
  const mePlayer = me(ui);
  const myImg = new Image();
  myImg.src = pfpUrl(mePlayer?.avatar ?? 0);
  myImg.width = 28;
  myImg.height = 28;
  const myName = el('span', '', `${mePlayer?.name ?? 'أنت'} (أنت)`);
  myHeader.appendChild(myImg);
  myHeader.appendChild(myName);
  myCol.appendChild(myHeader);

  const canEdit =
    (trade.stage === 'proposing_a' && meIsA) || (trade.stage === 'proposing_b' && !meIsA);
  if (canEdit) {
    renderBasketEdit(ui, myCol, (a) => api?.dispatch(a));
  } else {
    const summary = el('div', 'trade-basket-view');
    summary.textContent = basketSummary(ui, myBasket);
    myCol.appendChild(summary);
  }

  const partnerCol = el('div', 'trade-panel-col');
  renderOtherSide(ui, partnerCol, partnerId, partnerBasket);

  panels.appendChild(myCol);
  panels.appendChild(partnerCol);

  renderFooter(ui, trade);
}

// ── Public sync ──

export function syncTrade(ui: UIClientState): void {
  const trade = myTrade(ui);
  const requestModal = byId('trade-request-modal');
  const tradeModal = byId('trade-modal');
  const bar = byId('trade-minimized-bar');
  if (!tradeModal || !bar) return;

  if (!trade) {
    tradeModal.classList.remove('show');
    bar.style.display = 'none';
    if (requestModal) requestModal.classList.remove('show');
    api?.dispatch({ type: 'myOffer', offer: null });
    return;
  }

  // Fresh trade directed at me (still A's turn to propose): show the request gate.
  const iAmB = trade.b === ui.mySeatId;
  if (iAmB && trade.stage === 'proposing_a' && !isDialogOpen(ui, 'trade')) {
    if (requestModal) {
      const info = byId('trade-request-info');
      const other = ui.cs?.players.find((p) => p.id === trade.a);
      if (info) info.textContent = `${other?.name ?? 'لاعب آخر'} يريد التداول معك`;
      requestModal.classList.add('show');
    }
    bar.style.display = 'none';
    return;
  }
  if (requestModal) requestModal.classList.remove('show');

  // Init the draft basket when a proposing stage begins.
  if (ui.myOffer === null) {
    api?.dispatch({ type: 'myOffer', offer: emptyBasket() });
  }

  if (isDialogOpen(ui, 'trade')) {
    renderTradePanel(ui, trade);
    tradeModal.classList.add('show');
  } else {
    tradeModal.classList.remove('show');
  }

  if (!minimized && isDialogOpen(ui, 'trade')) {
    bar.style.display = 'none';
  } else if (trade && !isDialogOpen(ui, 'trade')) {
    const statusEl = byId('mini-trade-status');
    if (statusEl) statusEl.textContent = trade.stage;
    bar.style.display = 'block';
  }
}

export function openPlayerSelector(ui: UIClientState): void {
  const sel = byId('player-selector');
  const list = byId('ps-list');
  if (!sel || !list) return;
  clear(list);
  if (!ui.cs) return;
  for (const p of ui.cs.players) {
    if (p.id === ui.mySeatId || p.isBankrupt || p.eliminated) continue;
    if (ui.cs.trades.some((t) => t.a === p.id || t.b === p.id)) continue;
    const row = el('div', 'ps-player');
    const img = new Image();
    img.src = pfpUrl(p.avatar);
    img.alt = p.name;
    const name = el('span', 'ps-name', p.name);
    row.appendChild(img);
    row.appendChild(name);
    row.addEventListener('click', () => {
      if (openTradeWith(ui, p.id)) sel.classList.remove('show');
    });
    list.appendChild(row);
  }
  sel.classList.add('show');
}

/** Opens a trade directly with a specific partner (skips the selector). */
export function openTradeWith(ui: UIClientState, partnerId: SeatId): boolean {
  if (!ui.cs) return false;
  const p = ui.cs.players.find((x) => x.id === partnerId);
  if (!p || p.id === ui.mySeatId || p.isBankrupt || p.eliminated) return false;
  if (ui.cs.trades.some((t) => t.a === p.id || t.b === p.id)) return false;
  emit({ type: 'TRADE_OPEN', actorId: '', partnerId: p.id, now: Date.now() });
  api?.dispatch({ type: 'dialogOpen', name: 'trade' });
  return true;
}

export function closePlayerSelector(): void {
  byId('player-selector')?.classList.remove('show');
}

export function initTrade(opts: DialogApi): void {
  api = opts;
  const container = byId('modals-root');
  if (!container) return;
  container.appendChild(buildTradeModal());
  container.appendChild(buildMinimizedBar());
  container.appendChild(buildPlayerSelector());
}

export { myTrade };
