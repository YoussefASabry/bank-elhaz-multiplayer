/**
 * Pure modal markup for the decision/manual dialogs. No DOM lookups at build
 * time; each builder receives a `DialogCtx` the wiring module binds to the
 * live store + net. Kept separate from dialogs.ts so no file exceeds 400 lines.
 */
import type { Action } from '../shared/actions';
import type { DialogName } from './store';
import { el } from './dom';

export interface DialogCtx {
  emitAction: (action: Action) => void;
  closeInspect: () => void;
  closeInventory: () => void;
  closePlayerList: () => void;
  acceptTradeRequest: () => void;
  declineTradeRequest: () => void;
  confirmSellBuilding: () => void;
  closeSellBuilding: () => void;
  leaveToLobby: () => void;
}

function overlay(name: DialogName, extraClass = 'modal-overlay'): HTMLElement {
  const o = el('div', extraClass);
  o.id = `${name}-modal`;
  return o;
}

function box(content: HTMLElement, style = ''): HTMLElement {
  const b = el('div', 'modal-box');
  if (style) b.style.cssText = style;
  b.appendChild(content);
  return b;
}

function buildPropertyBuy(ctx: DialogCtx): HTMLElement {
  const o = overlay('property_buy');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h2');
  h.textContent = '🏠 Property Available!';
  const name = el('p');
  name.id = 'buy-prop-name';
  name.style.cssText = 'font-size:1.1rem;font-weight:bold;margin:12px 0;color:#5a3a0a;';
  const price = el('p');
  price.id = 'buy-prop-price';
  price.style.cssText = 'font-size:1.3rem;color:#2e7d32;margin-bottom:16px;';
  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  const buy = el('button', 'btn btn-buy', '💰 Buy');
  buy.id = 'btn-buy-prop';
  buy.type = 'button';
  buy.addEventListener('click', () => ctx.emitAction({ type: 'RESOLVE_PROPERTY_BUY', actorId: '', buy: true }));
  const decline = el('button', 'btn btn-decline', '❌ Decline');
  decline.id = 'btn-decline-prop';
  decline.type = 'button';
  decline.addEventListener('click', () => ctx.emitAction({ type: 'RESOLVE_PROPERTY_BUY', actorId: '', buy: false }));
  buttons.appendChild(buy);
  buttons.appendChild(decline);
  content.appendChild(h);
  content.appendChild(name);
  content.appendChild(price);
  content.appendChild(buttons);
  o.appendChild(box(content, 'max-width:400px;'));
  return o;
}

function buildUpgrade(ctx: DialogCtx): HTMLElement {
  const o = overlay('upgrade');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h2', '', '🏗️ Upgrade Property');
  const name = el('p');
  name.id = 'upgrade-prop-name';
  name.style.cssText = 'font-size:1rem;font-weight:bold;margin:8px 0;color:#5a3a0a;';
  const hint = el('p', '', 'You own all cities of this color. Choose an upgrade:');
  hint.style.cssText = 'font-size:0.8rem;color:#7a5a3a;margin-bottom:12px;';
  const options = el('div');
  options.id = 'upgrade-options';
  options.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;';
  const skip = el('button', 'btn btn-decline', '⏭️ Skip');
  skip.id = 'btn-skip-upgrade';
  skip.type = 'button';
  skip.style.cssText = 'font-size:0.85rem;padding:6px 20px;';
  skip.addEventListener('click', () => ctx.emitAction({ type: 'SKIP_UPGRADE', actorId: '' }));
  content.appendChild(h);
  content.appendChild(name);
  content.appendChild(hint);
  content.appendChild(options);
  content.appendChild(skip);
  o.appendChild(box(content, 'max-width:420px;'));
  return o;
}

function buildCardChoice(): HTMLElement {
  const o = overlay('card_choice');
  const content = el('div');
  const h = el('h2');
  h.id = 'card-choice-title';
  h.textContent = '⚖️ Card Choice';
  const body = el('div', 'card-choices');
  body.id = 'card-choice-body';
  content.appendChild(h);
  content.appendChild(body);
  o.appendChild(box(content));
  return o;
}

function buildBlindCard(ctx: DialogCtx): HTMLElement {
  const o = overlay('blind_card', 'modal-overlay-transparent');
  const content = el('div');
  content.style.cssText = 'text-align:center;max-width:380px;border:none;box-shadow:none;background:transparent;';
  const h = el('h2');
  h.id = 'blind-card-title';
  h.style.cssText = 'color:#3a2a1a;font-size:1.1rem;margin-bottom:12px;';
  h.textContent = '🃏 Card Draw';
  const draw = el('div');
  draw.id = 'card-draw-modal';
  const face = el('div', 'card-face');
  face.id = 'card-face-content';
  const header = el('div', 'card-header');
  header.id = 'card-face-header';
  header.textContent = '🃏';
  const type = el('div', 'card-type');
  type.id = 'card-face-type';
  type.textContent = '—';
  const desc = el('div', 'card-description');
  desc.id = 'card-face-desc';
  desc.textContent = '—';
  const cities = el('div', 'card-city-list');
  cities.id = 'card-face-cities';
  cities.style.display = 'none';
  const effect = el('div', 'card-effect-detail');
  effect.id = 'card-face-effect';
  effect.style.display = 'none';
  face.appendChild(header);
  face.appendChild(type);
  face.appendChild(desc);
  face.appendChild(cities);
  face.appendChild(effect);
  const confirm = el('button', 'confirm-card-btn', '✅ Confirm');
  confirm.id = 'btn-confirm-card';
  confirm.type = 'button';
  confirm.style.cssText = 'display:block;margin:12px auto 0;';
  confirm.addEventListener('click', () => ctx.emitAction({ type: 'CONFIRM_CARD', actorId: '' }));
  draw.appendChild(face);
  draw.appendChild(confirm);
  content.appendChild(h);
  content.appendChild(draw);
  o.appendChild(box(content, 'text-align:center;max-width:380px;border:none;box-shadow:none;background:transparent;'));
  return o;
}

function buildClub(ctx: DialogCtx): HTMLElement {
  const o = overlay('club');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h2', '', '🎰 نادي الحظ');
  const desc = el('p');
  desc.id = 'club-desc';
  desc.style.cssText = 'font-size:0.95rem;margin:12px 0;color:#5a3a0a;';
  const membership = el('p');
  membership.id = 'club-membership';
  membership.style.cssText = 'font-size:1.1rem;font-weight:bold;color:#2e7d32;margin:8px 0;';
  const guest = el('p');
  guest.id = 'club-guest';
  guest.style.cssText = 'font-size:1rem;color:#7a5a3a;margin:8px 0;';
  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-top:16px;';
  const btnM = el('button', 'btn btn-buy', '🎫 Buy Membership');
  btnM.id = 'btn-club-membership';
  btnM.type = 'button';
  btnM.addEventListener('click', () => ctx.emitAction({ type: 'CHOOSE_CLUB', actorId: '', choice: 'membership' }));
  const btnG = el('button', 'btn btn-choice', '🚪 Guest Fine');
  btnG.id = 'btn-club-guest';
  btnG.type = 'button';
  btnG.addEventListener('click', () => ctx.emitAction({ type: 'CHOOSE_CLUB', actorId: '', choice: 'guest' }));
  buttons.appendChild(btnM);
  buttons.appendChild(btnG);
  content.appendChild(h);
  content.appendChild(desc);
  content.appendChild(membership);
  content.appendChild(guest);
  content.appendChild(buttons);
  o.appendChild(box(content, 'text-align:center;max-width:400px;'));
  return o;
}

function buildRent(ctx: DialogCtx): HTMLElement {
  const o = overlay('rent');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const info = el('h3');
  info.id = 'rent-info';
  info.style.cssText = 'margin:0 0 8px;';
  const amount = el('p');
  amount.id = 'rent-amount';
  amount.style.cssText = 'font-size:1.3rem;color:#2e7d32;margin:8px 0;';
  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-top:12px;';
  const pay = el('button', 'btn btn-buy', '💰 Pay Rent');
  pay.id = 'btn-pay-rent';
  pay.type = 'button';
  pay.addEventListener('click', () => ctx.emitAction({ type: 'PAY_RENT', actorId: '' }));
  const bankrupt = el('button', 'btn btn-decline', '💥 Bankrupt');
  bankrupt.id = 'btn-declare-bankrupt';
  bankrupt.type = 'button';
  bankrupt.addEventListener('click', () => ctx.emitAction({ type: 'DECLARE_BANKRUPT', actorId: '' }));
  buttons.appendChild(pay);
  buttons.appendChild(bankrupt);
  content.appendChild(info);
  content.appendChild(amount);
  content.appendChild(buttons);
  o.appendChild(box(content, 'max-width:380px;text-align:center;'));
  return o;
}

function buildWinner(ctx: DialogCtx): HTMLElement {
  const o = overlay('winner');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h2', '', '🏆');
  const text = el('p');
  text.id = 'winner-text';
  text.style.cssText = 'font-size:1.2rem;font-weight:bold;color:#5a3a0a;margin:12px 0;';
  const back = el('button', 'btn btn-buy', '🚪 Back to Lobby');
  back.id = 'btn-close-winner';
  back.type = 'button';
  back.addEventListener('click', () => ctx.leaveToLobby());
  content.appendChild(h);
  content.appendChild(text);
  content.appendChild(back);
  o.appendChild(box(content, 'max-width:400px;text-align:center;'));
  return o;
}

function buildInspect(ctx: DialogCtx): HTMLElement {
  const o = overlay('inspect');
  const content = el('div');
  const close = el('button', 'modal-close', '✕');
  close.id = 'btn-close-inspect';
  close.type = 'button';
  close.addEventListener('click', () => ctx.closeInspect());
  const inner = el('div');
  inner.id = 'inspect-content';
  content.appendChild(close);
  content.appendChild(inner);
  o.appendChild(box(content));
  return o;
}

function buildInventory(ctx: DialogCtx): HTMLElement {
  const o = overlay('inventory');
  const content = el('div');
  const close = el('button', 'modal-close', '✕');
  close.id = 'btn-close-inventory';
  close.type = 'button';
  close.addEventListener('click', () => ctx.closeInventory());
  const h = el('h2', '', '📦 My Properties');
  const list = el('div');
  list.id = 'inventory-list';
  list.style.cssText = 'max-height:50vh;overflow-y:auto;';
  content.appendChild(close);
  content.appendChild(h);
  content.appendChild(list);
  o.appendChild(box(content, 'max-width:450px;'));
  return o;
}

function buildPlayerList(ctx: DialogCtx): HTMLElement {
  const o = overlay('player_list');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h3', '', '👥 Players');
  const list = el('div');
  list.id = 'player-list-content';
  list.style.cssText = 'text-align:left;max-height:300px;overflow-y:auto;';
  const close = el('button', 'btn btn-decline', '❌ Close');
  close.id = 'btn-close-player-list';
  close.type = 'button';
  close.style.cssText = 'margin-top:12px;font-size:0.85rem;padding:6px 18px;';
  close.addEventListener('click', () => ctx.closePlayerList());
  content.appendChild(h);
  content.appendChild(list);
  content.appendChild(close);
  o.appendChild(box(content, 'max-width:400px;text-align:center;'));
  return o;
}

function buildPlayerAction(): HTMLElement {
  const o = overlay('player_action');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const inner = el('div');
  inner.id = 'player-action-content';
  content.appendChild(inner);
  o.appendChild(box(content, 'max-width:320px;text-align:center;'));
  return o;
}

function buildTradeRequest(ctx: DialogCtx): HTMLElement {
  const o = overlay('trade_request');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h3', '', '🤝 Trade Request');
  const info = el('p');
  info.id = 'trade-request-info';
  info.style.cssText = 'font-size:0.95rem;color:#5a3a0a;margin:12px 0;';
  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-top:16px;';
  const accept = el('button', 'btn btn-buy', '✅ Accept');
  accept.id = 'btn-accept-trade-request';
  accept.type = 'button';
  accept.addEventListener('click', () => ctx.acceptTradeRequest());
  const decline = el('button', 'btn btn-decline', '❌ Decline');
  decline.id = 'btn-decline-trade-request';
  decline.type = 'button';
  decline.addEventListener('click', () => ctx.declineTradeRequest());
  buttons.appendChild(accept);
  buttons.appendChild(decline);
  content.appendChild(h);
  content.appendChild(info);
  content.appendChild(buttons);
  o.appendChild(box(content, 'max-width:380px;text-align:center;'));
  return o;
}

function buildSellBldg(ctx: DialogCtx): HTMLElement {
  const o = overlay('sell_bldg');
  const content = el('div');
  content.style.cssText = 'text-align:center;';
  const h = el('h3', '', '🏗️ Sell Building');
  const desc = el('p');
  desc.id = 'sell-bldg-desc';
  desc.style.cssText = 'font-size:0.85rem;color:#5a3a0a;margin:8px 0;';
  const refundP = el('p');
  refundP.style.cssText = 'font-size:1.1rem;font-weight:bold;color:#2e7d32;';
  refundP.textContent = 'Refund: $';
  const refund = el('span');
  refund.id = 'sell-bldg-refund';
  refund.textContent = '0';
  refundP.appendChild(refund);
  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-top:12px;';
  const sell = el('button', 'btn btn-buy', '✅ Sell');
  sell.id = 'btn-confirm-sell-bldg';
  sell.type = 'button';
  sell.addEventListener('click', () => ctx.confirmSellBuilding());
  const cancel = el('button', 'btn', 'Cancel');
  cancel.id = 'btn-cancel-sell-bldg';
  cancel.type = 'button';
  cancel.addEventListener('click', () => ctx.closeSellBuilding());
  buttons.appendChild(sell);
  buttons.appendChild(cancel);
  content.appendChild(h);
  content.appendChild(desc);
  content.appendChild(refundP);
  content.appendChild(buttons);
  o.appendChild(box(content, 'max-width:380px;text-align:center;'));
  return o;
}

/** The dialogs this module owns (trade/bid/preview are built elsewhere). */
export const BUILT_DIALOGS: DialogName[] = [
  'property_buy',
  'upgrade',
  'card_choice',
  'blind_card',
  'club',
  'rent',
  'winner',
  'inspect',
  'inventory',
  'player_list',
  'player_action',
  'trade_request',
  'sell_bldg',
];

const BUILDERS: Record<string, (ctx: DialogCtx) => HTMLElement> = {
  property_buy: buildPropertyBuy,
  upgrade: buildUpgrade,
  card_choice: buildCardChoice,
  blind_card: buildBlindCard,
  club: buildClub,
  rent: buildRent,
  winner: buildWinner,
  inspect: buildInspect,
  inventory: buildInventory,
  player_list: buildPlayerList,
  player_action: buildPlayerAction,
  trade_request: buildTradeRequest,
  sell_bldg: buildSellBldg,
};

export function buildDialogModal(name: DialogName, ctx: DialogCtx): HTMLElement {
  const builder = BUILDERS[name];
  if (!builder) return el('div');
  return builder(ctx);
}
