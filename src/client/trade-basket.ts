/**
 * Client-side trade basket editor (bug B17: drag-and-drop basket). Kept separate
 * from trade.ts so both stay under the 400-line ceiling.
 */
import type { Basket, SquareId } from '../shared/types';
import { el, fmt } from './dom';
import { getColorGroupBG } from './constants';
import type { ClientAction, UIClientState } from './store';
import { myPlayer } from './store';

export function emptyBasket(): Basket {
  return { cash: 0, squareIds: [], jailCards: 0 };
}

export function squareName(ui: UIClientState, id: SquareId): string {
  if (!ui.cs) return '';
  return ui.cs.board.squares.find((s) => s.id === id)?.name ?? '';
}

export function squareColor(ui: UIClientState, id: SquareId): string {
  if (!ui.cs) return '#607d8b';
  const sq = ui.cs.board.squares.find((s) => s.id === id);
  return sq && (sq.kind === 'property' || sq.kind === 'utility') ? getColorGroupBG(sq.colorGroup) : '#607d8b';
}

export function myTradableSquares(ui: UIClientState): SquareId[] {
  if (!ui.cs) return [];
  return Object.entries(ui.cs.ownership)
    .filter(([, own]) => own.owner === ui.mySeatId && own.upgrade === null)
    .map(([id]) => Number(id));
}

export function basketSummary(ui: UIClientState, basket: Basket | null): string {
  if (!basket) return '—';
  const props = basket.squareIds.map((id) => squareName(ui, id)).join('، ');
  const parts: string[] = [];
  if (basket.cash > 0) parts.push(`$${fmt(basket.cash)}`);
  if (props) parts.push(props);
  if (basket.jailCards > 0) parts.push(`${basket.jailCards}🔓`);
  return parts.join(' + ') || '—';
}

function selectedChip(
  ui: UIClientState,
  id: SquareId,
  dispatch: (action: ClientAction) => void,
): HTMLElement {
  const chip = el('span', 'trade-sel-chip');
  chip.style.background = squareColor(ui, id);
  chip.textContent = `${squareName(ui, id)} ✕`;
  chip.addEventListener('click', () => removeSquare(ui, id, dispatch));
  return chip;
}

function addSquare(ui: UIClientState, id: SquareId, dispatch: (action: ClientAction) => void): void {
  const offer = ui.myOffer ?? emptyBasket();
  if (offer.squareIds.includes(id)) return;
  dispatch({ type: 'myOffer', offer: { ...offer, squareIds: [...offer.squareIds, id] } });
}

function removeSquare(ui: UIClientState, id: SquareId, dispatch: (action: ClientAction) => void): void {
  const offer = ui.myOffer ?? emptyBasket();
  dispatch({ type: 'myOffer', offer: { ...offer, squareIds: offer.squareIds.filter((x) => x !== id) } });
}

function setJail(ui: UIClientState, count: number, dispatch: (action: ClientAction) => void): void {
  const m = myPlayer(ui);
  if (!m) return;
  const clamped = Math.max(0, Math.min(count, m.inventory.jailFreeCards));
  const offer = ui.myOffer ?? emptyBasket();
  dispatch({ type: 'myOffer', offer: { ...offer, jailCards: clamped } });
}

export function renderBasketEdit(
  ui: UIClientState,
  container: HTMLElement,
  dispatch: (action: ClientAction) => void,
): void {
  const m = myPlayer(ui);
  if (!m) return;
  const offer: Basket = ui.myOffer ?? emptyBasket();

  container.textContent = '';

  const cashRow = el('div', 'trade-cash-row');
  const cashLabel = el('span', '', '💰 Cash:');
  const cashInput = el('input') as HTMLInputElement;
  cashInput.type = 'number';
  cashInput.min = '0';
  cashInput.max = String(m.money ?? 0);
  cashInput.value = String(offer.cash);
  cashInput.style.width = '90px';
  cashInput.addEventListener('input', () => {
    const cash = Math.max(0, Number(cashInput.value) || 0);
    dispatch({ type: 'myOffer', offer: { ...(ui.myOffer ?? emptyBasket()), cash } });
  });
  cashRow.appendChild(cashLabel);
  cashRow.appendChild(cashInput);
  container.appendChild(cashRow);

  const dropLabel = el('div', '', '🏠 Properties (drag or tap below):');
  dropLabel.style.cssText = 'font-size:0.75rem;color:#7a5a3a;margin:6px 0 2px;';
  container.appendChild(dropLabel);

  const drop = el('div', 'trade-props-dropzone');
  drop.id = 'trade-my-dropzone';
  drop.style.cssText = 'min-height:40px;margin-bottom:4px;';
  const dropLabelInner = el('div', 'dropzone-label', 'Drag properties here');
  drop.appendChild(dropLabelInner);

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const raw = e.dataTransfer?.getData('text/plain');
    if (!raw) return;
    const id = Number(raw);
    if (Number.isNaN(id)) return;
    addSquare(ui, id, dispatch);
  });
  container.appendChild(drop);

  const selected = el('div', 'trade-selected-row');
  selected.id = 'trade-my-selected';
  selected.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px;';
  for (const id of offer.squareIds) {
    selected.appendChild(selectedChip(ui, id, dispatch));
  }
  container.appendChild(selected);

  const tradable = el('div');
  tradable.style.cssText = 'font-size:0.65rem;color:#7a5a3a;margin-bottom:8px;max-height:60px;overflow-y:auto;display:flex;flex-wrap:wrap;gap:3px;';
  for (const id of myTradableSquares(ui)) {
    if (offer.squareIds.includes(id)) continue;
    const chip = el('span', 'trade-src-chip');
    chip.draggable = true;
    chip.style.background = squareColor(ui, id);
    chip.textContent = squareName(ui, id);
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', String(id));
    });
    chip.addEventListener('click', () => addSquare(ui, id, dispatch));
    tradable.appendChild(chip);
  }
  if (tradable.children.length === 0) {
    tradable.textContent = 'لا توجد عقارات قابلة للتداول';
  }
  container.appendChild(tradable);

  const jailRow = el('div', 'trade-jail-row');
  const jailLabel = el('span', '', `🔓 Jail cards (${m.inventory.jailFreeCards}):`);
  const jailCount = el('span', 'trade-jail-count');
  jailCount.id = 'trade-my-jail-count';
  jailCount.textContent = String(offer.jailCards);
  const btnMinus = el('button', 'btn btn-sm', '−');
  btnMinus.type = 'button';
  btnMinus.addEventListener('click', () => setJail(ui, offer.jailCards - 1, dispatch));
  const btnPlus = el('button', 'btn btn-sm', '+');
  btnPlus.type = 'button';
  btnPlus.addEventListener('click', () => setJail(ui, offer.jailCards + 1, dispatch));
  jailRow.appendChild(jailLabel);
  jailRow.appendChild(btnMinus);
  jailRow.appendChild(jailCount);
  jailRow.appendChild(btnPlus);
  container.appendChild(jailRow);
}
