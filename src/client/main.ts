/**
 * Client bootstrap and coordinator. Owns the store instance, the socket
 * handlers, and the top-level render loop; every module below is a pure
 * function of the current UIClientState.
 */
import type { Action, DomainEvent } from '../shared/actions';
import type { SeatId, SquareId, UpgradeTier } from '../shared/types';
import { SELL_REFUND_RATIO } from '../shared/rules';
import type { ClientState } from '../shared/events';
import { Net, type NetHandlers } from './net';
import {
  clearSession,
  clearSnapshot,
  downloadSave,
  loadPrefs,
  loadSession,
  loadSnapshot,
  parseSaveFile,
  savePrefs,
  saveSession,
  saveSnapshot,
} from './session';
import type { ClientPrefs } from './session';
import {
  canRoll,
  initialUIState,
  isDialogOpen,
  myPlayer,
  reducer,
} from './store';
import type { ClientAction, UIClientState } from './store';
import { initLobby, renderLobby, setLobbyError, showWaiting, updateConnected, updateWaitingMembers } from './lobby';
import type { LobbyApi } from './lobby';
import {
  getLastPendingSignature,
  initDialogs,
  pendingSignature,
  renderDialogs,
  setLastPendingSignature,
  syncDialogs,
} from './dialogs';
import type { DialogApi } from './dialogs';
import { initTrade, openPlayerSelector, openTradeWith, setMinimized, syncTrade } from './trade';
import { initBids, openBidCreate, syncBids } from './bids';
import {
  animateTokenMove,
  renderBoard,
  renderBoardState,
  renderOwnership,
  renderTokens,
  setCenterPfp,
  setDeckGlow,
} from './board';
import {
  highlightCurrentTurn,
  renderCornerProps,
  renderPlayerCorners,
  setDeckCounts,
  setDiceFaces,
  setTurnBanner,
  showPlayerActionPopup,
  syncActionButtons,
  updateCornerPlayer,
} from './hud';
import { animateBus, animateCardFly, showBigText, showToast, updateTimer } from './fx';
import { narrateEvents } from './narrate';
import { buildGameLayout, resizeBoard } from './layout';
import { el, byId, clear, fmt } from './dom';
import { getColorGroupBG, pfpUrl, UPGRADE_ICONS, UPGRADE_LABELS } from './constants';

declare global {
  interface Window {
    __bankelhaz?: { inspectSquare: (id: SquareId) => void };
  }
}

// ── Store (single instance; pure reducer from store.ts) ──

let ui: UIClientState = initialUIState();
const listeners = new Set<() => void>();
let suppressRender = false;

function getUI(): UIClientState {
  return ui;
}

function dispatch(action: ClientAction): void {
  const next = reducer(ui, action);
  if (next === ui) return;
  ui = next;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Prefs ──

let prefs: ClientPrefs = loadPrefs();

function setPrefs(p: ClientPrefs): void {
  prefs = p;
  savePrefs(p);
}

// ── Wiring API ──

let net: Net;

function emitAction(action: Action): void {
  if (ui.roomCode) net.act(ui.roomCode, action);
}

let sellTarget: { squareId: SquareId; refund: number } | null = null;
let inspectSquare: SquareId | null = null;
let viewPlayerSeatId: SeatId | null = null;

const dialogApi: DialogApi = {
  getStore: getUI,
  dispatch,
  emitAction,
  closeInspect: () => dispatch({ type: 'dialogClose', name: 'inspect' }),
  closeInventory: () => dispatch({ type: 'dialogClose', name: 'inventory' }),
  closePlayerList: () => dispatch({ type: 'dialogClose', name: 'player_list' }),
  acceptTradeRequest: () => {
    dispatch({ type: 'dialogClose', name: 'trade_request' });
    dispatch({ type: 'dialogOpen', name: 'trade', closeOnServer: true });
  },
  declineTradeRequest: () => {
    emitAction({ type: 'TRADE_DECLINE', actorId: '' });
    dispatch({ type: 'dialogClose', name: 'trade_request' });
  },
  confirmSellBuilding: () => {
    if (sellTarget) emitAction({ type: 'SELL_UPGRADE', actorId: '', squareId: sellTarget.squareId });
    sellTarget = null;
    dispatch({ type: 'dialogClose', name: 'sell_bldg' });
  },
  closeSellBuilding: () => {
    sellTarget = null;
    dispatch({ type: 'dialogClose', name: 'sell_bldg' });
  },
  leaveToLobby,
};

const lobbyApi: LobbyApi = {
  getPrefs: () => prefs,
  setPrefs,
  host: (name, avatar, options) => net.whenConnected(() => net.host(name, avatar, options)),
  join: (code, name, avatar) => net.whenConnected(() => net.join(code, name, avatar)),
  leaveRoom: () => {
    if (ui.roomCode) net.leaveRoom(ui.roomCode);
    clearSession();
  },
  startGame: () => {
    if (ui.roomCode) net.startGame(ui.roomCode);
  },
  resume: resumeGame,
  exportSave: () => {
    const session = loadSession();
    if (session) downloadSave(session, loadSnapshot());
  },
  importSave: (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const blob = parseSaveFile(String(reader.result));
      if (!blob) {
        showToast('ملف غير صالح');
        return;
      }
      saveSession(blob.roomCode, blob.seatToken);
      if (blob.snapshot) saveSnapshot(blob.snapshot);
      resumeGame();
    };
    reader.readAsText(file);
  },
  hasSnapshot: () => loadSnapshot() !== null,
  updateConnected,
  isConnected: () => net.isConnected,
};

// ── Game screen helpers ──

let boardTheme = '';

function ensureBoard(): void {
  const boardEl = byId('board');
  if (!boardEl || !ui.cs) return;
  if (boardTheme !== prefs.theme) {
    renderBoard(boardEl, ui.cs.board, prefs.theme);
    boardTheme = prefs.theme;
  }
}

// ── Token movement (queued; tokens re-render from final state when done) ──

const prevPositions = new Map<string, SquareId>();
let suppressTokens = false;
const moveQueue: { playerId: string; path: SquareId[] }[] = [];

function buildMovePath(from: SquareId, to: SquareId, size: number): SquareId[] {
  const path: SquareId[] = [];
  let cur = from;
  while (cur !== to) {
    cur = (cur % size) + 1;
    path.push(cur);
    if (path.length > size) break;
  }
  return path;
}

function queueMove(playerId: string, from: SquareId, to: SquareId, teleported: boolean): void {
  if (!ui.cs) return;
  if (teleported) {
    animateBus(from, to);
    moveQueue.push({ playerId, path: [to] });
    suppressTokens = true;
    return;
  }
  const fromPos = prevPositions.get(playerId) ?? from;
  const path = buildMovePath(fromPos, to, ui.cs.board.size);
  if (path.length > 0) {
    moveQueue.push({ playerId, path });
    suppressTokens = true;
  }
}

function drainMoveQueue(): void {
  const cs = ui.cs;
  if (!cs) {
    suppressTokens = false;
    return;
  }
  const mv = moveQueue.shift();
  if (!mv) {
    suppressTokens = false;
    renderTokens(cs, cs.players);
    return;
  }
  const player = cs.players.find((p) => p.id === mv.playerId);
  if (!player || mv.path.length === 0) {
    drainMoveQueue();
    return;
  }
  animateTokenMove(player, mv.path, 160, drainMoveQueue);
}

// ── Auxiliary dialog content ──

function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'btn btn-choice', label) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function openInspect(id: SquareId): void {
  viewPlayerSeatId = null;
  inspectSquare = id;
  dispatch({ type: 'dialogOpen', name: 'inspect' });
}

/** Opens the inspect dialog pointed at a player's property list. */
export function openPlayerProps(seatId: SeatId): void {
  inspectSquare = null;
  viewPlayerSeatId = seatId;
  dispatch({ type: 'dialogOpen', name: 'inspect' });
}

/** Click handler for a player's corner card: Trade / View Properties popup. */
function openPlayerAction(seatId: SeatId): void {
  if (!ui.cs) return;
  const p = ui.cs.players.find((x) => x.id === seatId);
  if (!p || p.isBankrupt || p.eliminated) return;
  const inTrade = ui.cs.trades.some((t) => t.a === seatId || t.b === seatId);
  showPlayerActionPopup({
    seatId,
    name: p.name,
    avatar: p.avatar,
    canTrade: seatId !== ui.mySeatId && !inTrade,
    onTrade: () => openTradeWith(ui, seatId),
    onViewProps: () => openPlayerProps(seatId),
  });
}

// ── Leave-game confirmation popup ──

let leavePopupEl: HTMLElement | null = null;

function ensureLeavePopup(): HTMLElement {
  if (leavePopupEl && leavePopupEl.isConnected) return leavePopupEl;
  const root = byId('modals-root') ?? document.body;
  leavePopupEl = el('div', 'player-action-popup leave-popup');
  leavePopupEl.id = 'leave-confirm-popup';
  root.appendChild(leavePopupEl);
  return leavePopupEl;
}

function hideLeaveConfirm(): void {
  leavePopupEl?.classList.remove('show');
}

function showLeaveConfirm(): void {
  const popup = ensureLeavePopup();
  popup.innerHTML = '';
  const header = el('div', 'popup-header', '🚪 Leave game?');
  const msg = el('p');
  msg.style.cssText = 'color:#7a5a3a;font-size:0.85rem;text-align:center;margin:0 0 10px;';
  msg.textContent = 'You will return to the lobby and your seat will be freed.';
  const actions = el('div', 'popup-actions');
  const mk = (label: string, cls: string, fn: () => void) => {
    const b = el('button', `btn ${cls}`, label) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  mk('✅ Leave', 'btn-buy', () => {
    hideLeaveConfirm();
    leaveToLobby();
  });
  mk('❌ Cancel', 'btn-decline', hideLeaveConfirm);
  popup.appendChild(header);
  popup.appendChild(msg);
  popup.appendChild(actions);
  popup.classList.add('show');
}

function openSell(id: SquareId): void {
  if (!ui.cs) return;
  const own = ui.cs.ownership[id];
  const sq = ui.cs.board.squares.find((s) => s.id === id);
  if (!sq || !own || !own.upgrade) return;
  const refund = 'buildCost' in sq ? Math.round(sq.buildCost[own.upgrade] * SELL_REFUND_RATIO) : 0;
  sellTarget = { squareId: id, refund };
  dispatch({ type: 'dialogOpen', name: 'sell_bldg' });
}

function renderInspect(): void {
  const content = byId('inspect-content');
  if (!content || !ui.cs) return;
  clear(content);
  if (viewPlayerSeatId !== null) {
    renderPlayerProps(content, viewPlayerSeatId);
    return;
  }
  if (inspectSquare === null) return;
  const id = inspectSquare;
  const sq = ui.cs.board.squares.find((s) => s.id === id);
  if (!sq) return;
  const own = ui.cs.ownership[id];
  const owner = own && own.owner !== null ? ui.cs.players.find((p) => p.id === own.owner) : null;
  const mine = owner != null && owner.id === ui.mySeatId;

  const isProp = sq.kind === 'property' || sq.kind === 'utility';
  const header = el('div', 'prop-header');
  header.style.background = isProp ? getColorGroupBG(sq.colorGroup) : '#5a3a1a';
  header.style.color = isProp ? '#ffffff' : '#ffd700';
  header.textContent = sq.name;
  content.appendChild(header);

  const row = (label: string, value: string) => {
    const r = el('div', 'prop-detail');
    r.appendChild(el('span', 'label', label));
    r.appendChild(el('span', 'value', value));
    content.appendChild(r);
  };

  if (isProp) {
    row('💰 Price', `$${fmt(sq.purchasePrice)}`);
    row('🎯 Base Rent', `$${fmt(sq.baseRent)}`);
    row('🏠 Owner', owner ? owner.name : '🏦 Bank');
    row('🏗️ Upgrade', own && own.upgrade ? UPGRADE_LABELS[own.upgrade] : '—');
    if (sq.kind === 'property') {
      const h = el('h3', '', '📊 Upgrade Options');
      h.style.cssText = 'color:#3a2a1a;font-size:0.85rem;margin:8px 0 4px;font-weight:bold;';
      content.appendChild(h);
      const table = el('table', 'tier-table');
      const head = el('tr');
      for (const t of ['Type', 'Owner Cost', 'Visitor Rent']) head.appendChild(el('th', '', t));
      table.appendChild(head);
      const tiers: [UpgradeTier, string][] = [
        ['garage', '🏗️ Garage'],
        ['rest_stop', '🏡 Rest Stop'],
        ['market', '🏬 Market'],
      ];
      for (const [tier, label] of tiers) {
        const tr = el('tr');
        tr.appendChild(el('td', '', label));
        tr.appendChild(el('td', '', `$${fmt(sq.buildCost[tier])}`));
        tr.appendChild(el('td', '', `$${fmt(sq.visitorRent[tier])}`));
        table.appendChild(tr);
      }
      content.appendChild(table);
    }
  } else {
    if (sq.description) row('📋 Info', sq.description);
    if (sq.kind === 'corner') {
      switch (sq.effect) {
        case 'club':
          row('🎫 Membership', `$${fmt(sq.membershipCost)}`);
          row('🚪 Guest Fine', `$${fmt(sq.guestFineFee)}`);
          break;
        case 'prison':
          row('🔒 Bail', `$${fmt(sq.bailCost)}`);
          break;
        case 'salary':
          row('💰 Salary', `$${fmt(ui.cs.config.passGoSalary)}`);
          break;
        case 'double_next_roll':
          row('🎲 Effect', 'Roll again next turn');
          break;
      }
    } else if (sq.kind === 'deck' || sq.kind === 'dual_deck') {
      const deckLabel =
        sq.kind === 'dual_deck' ? '⚖️ المحكمة + 🍀 حظك' : sq.deck === 'mahkama' ? '⚖️ المحكمة' : '🍀 حظك';
      row('🃏 Deck', deckLabel);
    }
  }

  if (mine && own && own.upgrade) content.appendChild(btn('🏗️ Sell Building', () => openSell(id)));
  if (mine && (!own || !own.upgrade)) {
    content.appendChild(btn('🏷️ Sell Property', () => emitAction({ type: 'SELL_PROPERTY', actorId: '', squareId: id })));
  }
}

/** Lists every property a given player owns inside the inspect dialog. */
function renderPlayerProps(content: HTMLElement, seatId: SeatId): void {
  const player = ui.cs!.players.find((p) => p.id === seatId);
  const header = el('div', 'prop-header');
  header.style.background = '#5a3a1a';
  header.style.color = '#ffd700';
  header.textContent = player ? `🏠 ${player.name}` : '🏠 Properties';
  content.appendChild(header);

  const owned = Object.entries(ui.cs!.ownership)
    .filter(([, o]) => o.owner === seatId)
    .map(([sid, o]) => ({ sq: ui.cs!.board.squares.find((s) => s.id === Number(sid)), own: o }))
    .filter((x): x is { sq: NonNullable<typeof x.sq>; own: typeof x.own } => !!x.sq);
  if (owned.length === 0) {
    const empty = el('div', '', 'لا يملك عقارات بعد');
    empty.style.cssText = 'padding:12px;color:#999;text-align:center;';
    content.appendChild(empty);
    return;
  }
  for (const { sq, own } of owned) {
    const isProp = sq.kind === 'property' || sq.kind === 'utility';
    const bg = isProp ? getColorGroupBG(sq.colorGroup) : '#607d8b';
    const row = el('div', 'prop-detail');
    row.style.cssText = `background:${bg}22;border-radius:4px;margin:2px 0;`;
    const name = el('span', '', sq.name);
    name.style.fontWeight = 'bold';
    row.appendChild(name);
    const extra = el('span', '', own.upgrade ? ' ' + (UPGRADE_ICONS[own.upgrade] ?? '') : '');
    row.appendChild(extra);
    const price = el('span', '', isProp ? `$${fmt(sq.purchasePrice)}` : '');
    price.style.cssText = 'float:right;color:#2e7d32;font-weight:bold;';
    row.appendChild(price);
    content.appendChild(row);
  }
}

function renderInventory(): void {
  const list = byId('inventory-list');
  if (!list || !ui.cs) return;
  clear(list);
  for (const [sid, own] of Object.entries(ui.cs.ownership)) {
    if (own.owner !== ui.mySeatId) continue;
    const id = Number(sid);
    const sq = ui.cs.board.squares.find((s) => s.id === id);
    if (!sq) continue;
    const row = el('div', 'inventory-row');
    const label = el('span', '', `${sq.name}${own.upgrade ? ' — ' + UPGRADE_LABELS[own.upgrade] : ''}`);
    row.appendChild(label);
    if (own.upgrade) row.appendChild(btn('Sell Bldg', () => openSell(id)));
    if (!own.upgrade) row.appendChild(btn('Sell', () => emitAction({ type: 'SELL_PROPERTY', actorId: '', squareId: id })));
    row.appendChild(btn('👁️', () => openInspect(id)));
    list.appendChild(row);
  }
  if (list.children.length === 0) list.textContent = 'لا تملك عقارات بعد';
}

function renderPlayerList(): void {
  const list = byId('player-list-content');
  if (!list || !ui.cs) return;
  clear(list);
  for (const p of ui.cs.players) {
    const row = el('div', 'ps-player');
    const img = new Image();
    img.src = pfpUrl(p.avatar);
    img.width = 28;
    img.height = 28;
    const name = el('span', 'ps-name', `${p.name}${p.id === ui.mySeatId ? ' (أنت)' : ''}${p.isBankrupt ? ' 💥' : ''}`);
    row.appendChild(img);
    row.appendChild(name);
    list.appendChild(row);
  }
}

function renderSell(): void {
  const desc = byId('sell-bldg-desc');
  const refund = byId('sell-bldg-refund');
  const t = sellTarget;
  if (!desc || !refund || !ui.cs || !t) return;
  const sq = ui.cs.board.squares.find((s) => s.id === t.squareId);
  desc.textContent = sq ? `سيعود ${sq.name} إلى حالته الأساسية` : '';
  refund.textContent = fmt(t.refund);
}

function renderAuxDialogs(): void {
  if (!ui.cs) return;
  if (isDialogOpen(ui, 'inspect')) renderInspect();
  if (isDialogOpen(ui, 'inventory')) renderInventory();
  if (isDialogOpen(ui, 'player_list')) renderPlayerList();
  if (isDialogOpen(ui, 'sell_bldg')) renderSell();
}

// ── Auto-draw deck cards (deck_draw pending = draw queue[0]) ──

let lastDrawKey = '';

function maybeAutoDraw(): void {
  const p = ui.cs?.pending;
  if (!ui.cs || !p || p.kind !== 'deck_draw' || p.playerId !== ui.mySeatId) return;
  const deck = p.queue[0];
  if (deck === undefined) return;
  const key = `${ui.cs.stateVersion}`;
  if (key === lastDrawKey) return;
  lastDrawKey = key;
  setTimeout(() => emitAction({ type: 'DRAW_CARD', actorId: '', deck }), 600);
}

// ── Sync helpers ──

function syncMyInfo(): void {
  const me = myPlayer(ui);
  const count = me ? me.inventory.jailFreeCards : 0;
  if (count !== ui.myJailCards) dispatch({ type: 'myJailCards', count });
}

function syncPendingCard(): void {
  const sig = pendingSignature(ui);
  if (sig === getLastPendingSignature()) return;
  setLastPendingSignature(sig);
  if (ui.cs?.pending.kind === 'blind_card' && ui.cs.pending.playerId === ui.mySeatId) {
    animateCardFly(ui.cs.pending.card.deck === 'mahkama', () => {});
  }
}

// ── Main render loop ──

function renderEverything(): void {
  if (!ui.gameStarted || ui.cs === null) return;
  const gameEl = byId('game-container');
  const lobbyEl = byId('lobby-screen');
  if (gameEl) gameEl.style.display = 'block';
  if (lobbyEl) lobbyEl.style.display = 'none';

  ensureBoard();
  const badge = byId('room-code-badge');
  if (badge) {
    if (ui.roomCode) {
      badge.textContent = `🏠 ${ui.roomCode}`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
  renderPlayerCorners(byId('player-corners') ?? document.body, ui.cs.players, openPlayerAction);
  renderOwnership(ui.cs, ui.cs.players);
  renderBoardState(ui.cs, ui.cs.players);
  if (!suppressTokens) renderTokens(ui.cs, ui.cs.players);
  ui.cs.players.forEach(updateCornerPlayer);
  renderCornerProps(ui, ui.cs.players);
  setDiceFaces(ui);
  setDeckCounts(ui);
  setTurnBanner(ui);
  setCenterPfp(ui.cs, ui.cs.players);
  setDeckGlow(ui.cs, ui.cs.players);
  syncActionButtons(ui);
  highlightCurrentTurn(ui);
  syncDialogs(ui);
  renderDialogs(ui);
  renderAuxDialogs();
  syncTrade(ui);
  syncBids(ui);
  syncMyInfo();
  syncPendingCard();
  maybeAutoDraw();

  if (ui.cs.gameOver) updateTimer(0, false, 0);
  resizeBoard();
}

// ── Screen transitions ──

function enterGame(): void {
  dispatch({ type: 'dialogsClear' });
  renderEverything();
}

function leaveToLobby(): void {
  if (ui.roomCode) net.leaveRoom(ui.roomCode);
  clearSession();
  clearSnapshot();
  setMinimized(false);
  hideLeaveConfirm();
  dispatch({ type: 'reset' });
  boardTheme = '';
  const gameEl = byId('game-container');
  const lobbyEl = byId('lobby-screen');
  if (gameEl) gameEl.style.display = 'none';
  if (lobbyEl) lobbyEl.style.display = '';
  renderLobby(prefs, net.isConnected);
}

// ── Resume (rejoin live room, or restore signed snapshot) ──

function resumeGame(): void {
  const session = loadSession();
  if (!session) {
    showToast('لا توجد جلسة محفوظة');
    return;
  }
  const snapshot = loadSnapshot();
  net.whenConnected(() => {
    if (snapshot) net.restore(snapshot, session.seatToken);
    else net.rejoin(session.roomCode, session.seatToken);
  });
}

// ── Rejected-action feedback ──

const REJECT_TEXT: Record<string, string> = {
  not_your_turn: 'ليس دورك',
  wrong_phase: 'لا يمكن فعل هذا الآن',
  not_the_entitled_player: 'هذا القرار ليس لك',
  game_over: 'انتهت اللعبة',
  insufficient_funds: 'المال غير كافٍ',
  in_prison: 'أنت في السجن',
  no_jail_free_card: 'لا تملك بطاقة خروج',
  property_has_upgrade: 'العقار عليه تحسينات',
  square_already_owned: 'العقار مملوك مسبقاً',
  not_the_owner: 'لست مالك العقار',
  empty_basket: 'العرض فارغ',
  already_in_trade: 'أنت في تداول بالفعل',
  trade_wrong_stage: 'مرحلة تداول غير صحيحة',
  cannot_bid_on_own: 'لا يمكنك المزايدة على عرضك',
  already_has_active_bid: 'لديك عرض مزايدة نشط',
  no_such_bid: 'العرض غير موجود',
  no_such_offer: 'العرض المقابل غير موجود',
  insufficient_jail_cards: 'لا تملك بطاقات سجن كافية',
  deck_exhausted: 'نفدت البطاقات',
  not_host: 'أنت لست المضيف',
  nothing_pending: 'لا يوجد قرار معلق',
};

function rejectText(reason: string): string {
  return REJECT_TEXT[reason] ?? `مرفوض: ${reason}`;
}

// ── Socket handlers ──

function handleState(cs: ClientState): void {
  const wasFirst = ui.cs === null;
  const oldPositions = ui.cs ? new Map(ui.cs.players.map((p) => [p.id, p.position])) : new Map<string, SquareId>();
  dispatch({ type: 'state', cs });
  prevPositions.clear();
  oldPositions.forEach((pos, id) => prevPositions.set(id, pos));
  if (wasFirst) {
    dispatch({ type: 'lobby', roomCode: ui.roomCode, mySeatId: cs.youAre, members: [] });
    enterGame();
  }
}

const handlers: NetHandlers = {
  onLobby: (p) => {
    saveSession(p.roomCode, p.you);
    dispatch({ type: 'lobby', roomCode: p.roomCode, mySeatId: p.you, members: p.members });
    renderLobby(prefs, net.isConnected);
    showWaiting(p.roomCode, p.members, p.members.some((m) => m.id === p.you && m.isHost));
  },
  onMembers: (p) => {
    dispatch({ type: 'members', members: p.members });
    updateWaitingMembers(p.members);
  },
  onRoomError: (p) => {
    setLobbyError(p.tab ?? 'join', p.message);
    dispatch({ type: 'roomError', message: p.message });
  },
  onGameStarted: (p) => handleState(p.state),
  onState: (p) => handleState(p.state),
  onEvents: (p) => {
    if (p.events.length === 0) return;
    dispatch({ type: 'events', events: p.events });
    if (!ui.cs) return;
    narrateEvents(ui, { onMoved: queueMove });
    if (suppressTokens) drainMoveQueue();
  },
  onRejected: (p) => showToast(rejectText(p.reason)),
  onPrivateCard: () => {},
  onTimer: (p) => {
    suppressRender = true;
    dispatch({ type: 'timer', seconds: p.seconds, running: p.running, total: p.total });
    suppressRender = false;
    updateTimer(p.seconds, p.running, p.total);
  },
  onTradeTimer: (p) => {
    suppressRender = true;
    dispatch({ type: 'tradeTimer', tradeId: p.tradeId, seconds: p.seconds });
    suppressRender = false;
  },
  onSnapshot: (p) => saveSnapshot(p.snapshot),
  onRestoreOk: (p) => {
    saveSession(p.roomCode, p.you);
    dispatch({ type: 'lobby', roomCode: p.roomCode, mySeatId: p.you, members: [] });
    dispatch({ type: 'state', cs: p.state });
    enterGame();
  },
  onRestoreRejected: (p) => {
    showToast(`تعذّر استعادة اللعبة: ${p.reason}`);
    clearSnapshot();
  },
  onGameOver: (p) => showBigText('🏆 انتهت اللعبة', 'celebrate'),
  onConnect: () => {
    updateConnected(true);
    const session = loadSession();
    if (session && session.roomCode) net.rejoin(session.roomCode, session.seatToken);
  },
  onDisconnect: () => {
    updateConnected(false);
    if (ui.cs) showToast('🔴 انقطع الاتصال بالخادم', { ttl: 5000 });
  },
};

// ── Global control-button delegation ──

function wireControls(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof Element)) return;
    if (target.closest('.roll-dice-btn')) {
      if (ui.cs && ui.cs.phase === 'rolling') emitAction({ type: 'CONFIRM_LANDING', actorId: '' });
      else emitAction({ type: 'ROLL_DICE', actorId: '' });
      return;
    }
    const prisonBtn = target.closest<HTMLElement>('[data-prison]');
    if (prisonBtn) {
      const mode = prisonBtn.dataset.prison;
      if (mode === 'skip') emitAction({ type: 'SKIP_PRISON_TURN', actorId: '' });
      else if (mode === 'bail') emitAction({ type: 'PAY_BAIL', actorId: '' });
      else if (mode === 'free') emitAction({ type: 'USE_JAIL_FREE', actorId: '' });
      return;
    }
    if (target.closest('.rc-btn-trade')) {
      openPlayerSelector(ui);
      return;
    }
    if (target.closest('.rc-btn-bid')) {
      openBidCreate(ui);
      return;
    }
    if (target.id === 'rc-btn-inventory') {
      dispatch({ type: 'dialogOpen', name: 'inventory' });
      return;
    }
    if (target.id === 'btn-players-float') {
      dispatch({ type: 'dialogOpen', name: 'player_list' });
      return;
    }
    if (target.id === 'btn-leave-game') {
      showLeaveConfirm();
    }
  });
}

// ── Bootstrap ──

initLobby(lobbyApi);
initDialogs(dialogApi);
initTrade(dialogApi);
initBids(dialogApi);
buildGameLayout(byId('game-container') ?? document.body);
wireControls();
window.addEventListener('resize', () => {
  if (ui.cs) resizeBoard();
});
window.__bankelhaz = { inspectSquare: (id) => openInspect(id) };
subscribe(() => {
  if (!suppressRender) renderEverything();
});
renderLobby(prefs, false);
net = new Net(handlers);
