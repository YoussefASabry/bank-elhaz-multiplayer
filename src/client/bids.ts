import type { Action } from '../shared/actions';
import type { Basket, SquareId } from '../shared/types';
import type { Bid } from '../shared/trading';
import { byId, clear, el, fmt } from './dom';
import { getColorGroupBG, pfpUrl } from './constants';
import type { UIClientState } from './store';
import type { DialogApi } from './dialogs';

let api: DialogApi | null = null;

function emit(action: Action): void {
  if (api) api.emitAction(action);
}

function emptyBasket(): Basket {
  return { cash: 0, squareIds: [], jailCards: 0 };
}

function squareName(ui: UIClientState, id: SquareId): string {
  if (!ui.cs) return '';
  return ui.cs.board.squares.find((s) => s.id === id)?.name ?? '';
}

function squareColor(ui: UIClientState, id: SquareId): string {
  if (!ui.cs) return '#607d8b';
  const sq = ui.cs.board.squares.find((s) => s.id === id);
  return sq && (sq.kind === 'property' || sq.kind === 'utility') ? getColorGroupBG(sq.colorGroup) : '#607d8b';
}

function basketSummary(ui: UIClientState, basket: Basket): string {
  const props = basket.squareIds.map((id) => squareName(ui, id)).join('، ');
  const parts: string[] = [];
  if (basket.cash > 0) parts.push(`$${fmt(basket.cash)}`);
  if (props) parts.push(props);
  if (basket.jailCards > 0) parts.push(`${basket.jailCards}🔓`);
  return parts.join(' + ') || '—';
}

function tradable(ui: UIClientState): SquareId[] {
  if (!ui.cs) return [];
  return Object.entries(ui.cs.ownership)
    .filter(([, own]) => own.owner === ui.mySeatId && own.upgrade === null)
    .map(([id]) => Number(id));
}

// ── Markup ──

function buildBidCreate(): HTMLElement {
  const o = el('div', 'modal-overlay');
  o.id = 'bid-create-modal';
  const b = el('div', 'modal-box');
  b.style.cssText = 'max-width:460px;';

  const close = el('button', 'modal-close', '✕');
  close.type = 'button';
  close.addEventListener('click', () => closeBidCreate());
  const h = el('h2', '', '📢 Post a Bid');
  const hint = el('p', '', 'Offer cash and/or properties. Other players can then make counter-offers.');
  hint.style.cssText = 'font-size:0.8rem;color:#7a5a3a;margin-bottom:8px;';

  const body = el('div');
  body.id = 'bid-create-body';

  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:8px;justify-content:center;';
  const post = el('button', 'btn btn-buy', '📢 Post Bid');
  post.type = 'button';
  post.addEventListener('click', () => {
    const basket = readDraft('bid-create');
    emit({ type: 'BID_CREATE', actorId: '', basket, now: Date.now() });
    closeBidCreate();
  });
  const cancel = el('button', 'btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => closeBidCreate());
  buttons.appendChild(post);
  buttons.appendChild(cancel);

  b.appendChild(close);
  b.appendChild(h);
  b.appendChild(hint);
  b.appendChild(body);
  b.appendChild(buttons);
  o.appendChild(b);
  return o;
}

function buildBidRespond(): HTMLElement {
  const o = el('div', 'modal-overlay');
  o.id = 'bid-respond-modal';
  const b = el('div', 'modal-box');
  b.style.cssText = 'max-width:420px;text-align:center;';

  const h = el('h3', '', '📩 Respond to Bid');
  const info = el('p');
  info.id = 'bid-respond-info';
  info.style.cssText = 'font-size:0.8rem;color:#7a5a3a;margin-bottom:8px;';
  const body = el('div');
  body.id = 'bid-respond-body';

  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:8px;justify-content:center;';
  const send = el('button', 'btn btn-buy', '📩 Send Offer');
  send.type = 'button';
  send.addEventListener('click', () => {
    const target = respondTarget;
    if (!target) return;
    const basket = readDraft('bid-respond');
    emit({ type: 'BID_OFFER', actorId: '', bidId: target, basket });
    closeBidRespond();
  });
  const cancel = el('button', 'btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => closeBidRespond());
  buttons.appendChild(send);
  buttons.appendChild(cancel);

  b.appendChild(h);
  b.appendChild(info);
  b.appendChild(body);
  b.appendChild(buttons);
  o.appendChild(b);
  return o;
}

function buildBidFloats(): HTMLElement {
  const f = el('div');
  f.id = 'bid-floats';
  f.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:60;';
  return f;
}

// ── Draft editors (shared by create + respond) ──

type DraftId = 'bid-create' | 'bid-respond';
const drafts = new Map<DraftId, Basket>();
let respondTarget: string | null = null;

function draft(id: DraftId): Basket {
  return drafts.get(id) ?? emptyBasket();
}

function setDraftCash(id: DraftId, cash: number): void {
  drafts.set(id, { ...draft(id), cash: Math.max(0, cash) });
}

function toggleDraftSquare(id: DraftId, squareId: SquareId): void {
  const d = draft(id);
  const has = d.squareIds.includes(squareId);
  drafts.set(id, {
    ...d,
    squareIds: has ? d.squareIds.filter((x) => x !== squareId) : [...d.squareIds, squareId],
  });
  renderDraft(id);
}

function setDraftJail(id: DraftId, count: number): void {
  drafts.set(id, { ...draft(id), jailCards: Math.max(0, count) });
  renderDraft(id);
}

function readDraft(id: DraftId): Basket {
  return draft(id);
}

function renderDraft(id: DraftId): void {
  const container = byId(id === 'bid-create' ? 'bid-create-body' : 'bid-respond-body');
  if (!container) return;
  const d = draft(id);
  clear(container);
  const draftId = id;

  const cashRow = el('div');
  cashRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';
  const cashLabel = el('span', '', '💰 Cash:');
  const cash = el('input') as HTMLInputElement;
  cash.type = 'number';
  cash.min = '0';
  cash.value = String(d.cash);
  cash.style.width = '100px';
  cash.addEventListener('input', () => setDraftCash(id, Number(cash.value) || 0));
  cashRow.appendChild(cashLabel);
  cashRow.appendChild(cash);
  container.appendChild(cashRow);

  const propsLabel = el('div', '', '🏠 Properties (tap to toggle):');
  propsLabel.style.cssText = 'font-size:0.75rem;color:#7a5a3a;margin-bottom:4px;';
  container.appendChild(propsLabel);

  const chips = el('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px;max-height:70px;overflow-y:auto;';
  for (const id of tradable(uiNow())) {
    const chip = el('span', 'trade-sel-chip');
    chip.style.background = squareColor(uiNow(), id);
    chip.textContent = d.squareIds.includes(id) ? `${squareName(uiNow(), id)} ✓` : squareName(uiNow(), id);
    chip.addEventListener('click', () => toggleDraftSquare(draftId, id));
    chips.appendChild(chip);
  }
  if (chips.children.length === 0) chips.textContent = 'لا توجد عقارات قابلة للتداول';
  container.appendChild(chips);

  const jailRow = el('div');
  jailRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const jailLabel = el('span', '', '🔓 Jail cards:');
  const minus = el('button', 'btn btn-sm', '−');
  minus.type = 'button';
  minus.addEventListener('click', () => setDraftJail(id, d.jailCards - 1));
  const count = el('span', '', String(d.jailCards));
  const plus = el('button', 'btn btn-sm', '+');
  plus.type = 'button';
  plus.addEventListener('click', () => setDraftJail(id, d.jailCards + 1));
  jailRow.appendChild(jailLabel);
  jailRow.appendChild(minus);
  jailRow.appendChild(count);
  jailRow.appendChild(plus);
  container.appendChild(jailRow);
}

let currentUi: UIClientState | null = null;
function uiNow(): UIClientState {
  return currentUi ?? ({ mySeatId: '', cs: null, myJailCards: 0 } as UIClientState);
}

// ── Bid floats ──

function bidderPosition(index: number): string {
  const spots = [
    'top:90px;left:16px;',
    'top:90px;right:16px;',
    'bottom:160px;left:16px;',
    'bottom:160px;right:16px;',
    'top:50%;left:16px;',
  ];
  return spots[index % spots.length] ?? '';
}

function renderBidFloat(ui: UIClientState, bid: Bid, index: number): void {
  const container = byId('bid-floats');
  if (!container) return;
  const bidder = ui.cs?.players.find((p) => p.id === bid.playerId);
  const float = el('div', 'bid-float');
  float.style.cssText = `pointer-events:auto;position:fixed;${bidderPosition(index)};`;

  const header = el('div', 'bid-float-header');
  const img = new Image();
  img.src = pfpUrl(bidder?.avatar ?? 0);
  img.width = 24;
  img.height = 24;
  const name = el('span', '', `${bidder?.name ?? '?'} يبحث عن`);
  header.appendChild(img);
  header.appendChild(name);
  float.appendChild(header);

  const offer = el('div', 'bid-float-offer');
  offer.textContent = basketSummary(ui, bid.basket);
  float.appendChild(offer);

  const isMine = bid.playerId === ui.mySeatId;
  if (isMine) {
    const withdraw = el('button', 'btn btn-warn', '✕ سحب');
    withdraw.type = 'button';
    withdraw.addEventListener('click', () => emit({ type: 'BID_CANCEL', actorId: '', bidId: bid.id }));
    float.appendChild(withdraw);

    if (bid.offers.length > 0) {
      const offersLabel = el('div', 'bid-offers-label', 'العروض المقابلة:');
      float.appendChild(offersLabel);
      for (const ofr of bid.offers) {
        const from = ui.cs?.players.find((p) => p.id === ofr.playerId);
        const row = el('div', 'bid-offer-row');
        const summary = el('span', '', `${from?.name ?? '?'}: ${basketSummary(ui, ofr.basket)}`);
        const accept = el('button', 'btn btn-buy btn-sm', '✅');
        accept.type = 'button';
        accept.addEventListener('click', () =>
          emit({ type: 'BID_ACCEPT_OFFER', actorId: '', bidId: bid.id, offerId: ofr.id }),
        );
        row.appendChild(summary);
        row.appendChild(accept);
        float.appendChild(row);
      }
    } else {
      const waiting = el('div', 'bid-offers-label', 'بانتظار العروض...');
      float.appendChild(waiting);
    }
  } else {
    const respond = el('button', 'btn btn-choice', '📩 عرض مقابل');
    respond.type = 'button';
    respond.addEventListener('click', () => openBidRespond(ui, bid));
    float.appendChild(respond);
  }

  container.appendChild(float);
}

// ── Public API ──

export function openBidCreate(ui: UIClientState): void {
  currentUi = ui;
  drafts.set('bid-create', emptyBasket());
  renderDraft('bid-create');
  byId('bid-create-modal')?.classList.add('show');
}

function closeBidCreate(): void {
  byId('bid-create-modal')?.classList.remove('show');
}

function openBidRespond(ui: UIClientState, bid: Bid): void {
  currentUi = ui;
  respondTarget = bid.id;
  const info = byId('bid-respond-info');
  const bidder = ui.cs?.players.find((p) => p.id === bid.playerId);
  if (info) info.textContent = `رد على عرض ${bidder?.name ?? '?'}: ${basketSummary(ui, bid.basket)}`;
  drafts.set('bid-respond', emptyBasket());
  renderDraft('bid-respond');
  byId('bid-respond-modal')?.classList.add('show');
}

function closeBidRespond(): void {
  byId('bid-respond-modal')?.classList.remove('show');
  respondTarget = null;
}

export function syncBids(ui: UIClientState): void {
  const container = byId('bid-floats');
  if (!container || !ui.cs) return;
  clear(container);
  ui.cs.bids.forEach((bid, i) => renderBidFloat(ui, bid, i));
}

export function initBids(opts: DialogApi): void {
  api = opts;
  const container = byId('modals-root');
  if (!container) return;
  container.appendChild(buildBidCreate());
  container.appendChild(buildBidRespond());
  container.appendChild(buildBidFloats());
}
