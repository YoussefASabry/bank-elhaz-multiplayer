/**
 * The per-broadcast UI refresh: everything that changes without rebuilding the
 * board.
 *
 * Money-change flashes previously stored `_prevMoney` ON each player object
 * inside game state, so a UI-only field rode along in the domain model and was
 * clobbered whenever a fresh projection arrived. It lives in this module now,
 * keyed by seat — which is also why it survives a reconnect intact.
 */

import type { Choice, SeatId, SquareId, UpgradeTier } from '../../shared/types.js';
import { byId, qs, qsa, setText, escapeHtml } from '../dom.js';
import { S, DICE_FACE, UPGRADE_ICONS } from '../state.js';
import { getPfpUrl } from '../theme.js';
import { showBigText, showFloatMoney } from '../ui/effects.js';
import { updateTimerUI } from '../ui/timer.js';
import { pendingOf, playerById, type ViewState } from '../view-model.js';
import { renderPlayerCorners, renderTokens } from './players.js';

/** Dialogs that a state change invalidates. Cleared before anything reopens. */
const TURN_LIMITED_MODALS = [
  'buy-modal',
  'upgrade-modal',
  'card-draw-modal',
  'inspect-modal',
  'inventory-modal',
  'trade-modal',
];

let prevTurnId: SeatId | null = null;
const prevMoney = new Map<SeatId, number>();

/** Injected by main.ts to avoid a cycle with the bid module. */
let renderBidFloats: () => void = () => {};
let onSelectCardChoice: (index: number) => void = () => {};
let onBuyUpgrade: (squareId: SquareId, tier: UpgradeTier) => void = () => {};
let initDebugDropdown: () => void = () => {};

export function setUiHandlers(h: {
  renderBidFloats: () => void;
  selectCardChoice: (index: number) => void;
  buyUpgrade: (squareId: SquareId, tier: UpgradeTier) => void;
  initDebugDropdown: () => void;
}): void {
  renderBidFloats = h.renderBidFloats;
  onSelectCardChoice = h.selectCardChoice;
  onBuyUpgrade = h.buyUpgrade;
  initDebugDropdown = h.initDebugDropdown;
}

/** Forgets per-turn UI memory. Called on game end and when leaving a room. */
export function resetUiMemory(): void {
  prevTurnId = null;
  prevMoney.clear();
}

// ── Sections ──

function renderDeckCounters(view: ViewState): void {
  setText('deck-count', `🍀: ${view.deckCounts.hazak} | ⚖️: ${view.deckCounts.mahkama}`);
  const mahkamaLabel = qs('.mahkama-pile .deck-label');
  if (mahkamaLabel) mahkamaLabel.textContent = `المحكمة (${view.deckCounts.mahkama})`;
  const hazakLabel = qs('.hazak-pile .deck-label');
  if (hazakLabel) hazakLabel.textContent = `حظك (${view.deckCounts.hazak})`;
}

function renderOccupiedCells(view: ViewState): void {
  qsa('.cell.active').forEach((el) => {
    el.classList.remove('active');
  });
  for (const p of view.players) {
    if (p.isBankrupt) continue;
    qs(`.cell[data-id="${p.position}"]`)?.classList.add('active');
  }
}

function renderOwnership(view: ViewState): void {
  for (const sq of view.squares) {
    const cell = qs(`.cell[data-id="${sq.id}"]`);
    if (!cell) continue;
    const avatarEl = cell.querySelector('.owner-avatar');
    const bldgEl = cell.querySelector('.building-icons');

    if (sq.owner !== null) {
      S.prevOwnership[sq.id] = sq.owner;
      cell.classList.add('owned');
      const owner = playerById(view, sq.owner);
      if (avatarEl) avatarEl.innerHTML = `<img src="${getPfpUrl(owner?.avatar ?? 1)}" alt="" />`;
      if (bldgEl) bldgEl.textContent = sq.upgrade === null ? '' : (UPGRADE_ICONS[sq.upgrade] ?? '🔨');
    } else {
      cell.classList.remove('owned');
      if (avatarEl) avatarEl.innerHTML = '';
      if (bldgEl) bldgEl.textContent = '';
    }
  }
}

function renderTurnBanner(view: ViewState, isMyTurn: boolean): void {
  const cur = view.currentPlayer;
  if (!cur) return;

  const money = cur.money === null ? '???' : String(cur.money);
  const text = !view.gameOver
    ? isMyTurn
      ? `⏳ Your Turn  ($${money})`
      : `⌛ ${cur.name}'s Turn  ($${money})`
    : '';
  const color = isMyTurn ? '#2e7d32' : '#fff';
  for (const id of ['turn-banner', 'rc-turn-banner']) {
    const el = byId(id);
    if (!el) continue;
    el.textContent = text;
    el.style.color = color;
  }

  if (prevTurnId !== null && prevTurnId !== cur.id && !view.gameOver) {
    window.setTimeout(() => {
      showBigText(isMyTurn ? '🎯 Your Turn 🎯' : `🎯 ${cur.name}'s Turn 🎯`, true);
    }, 400);
  }
  prevTurnId = cur.id;

  const centerPfp = byId<HTMLImageElement>('center-pfp');
  if (centerPfp) {
    if (!view.gameOver) {
      centerPfp.src = getPfpUrl(cur.avatar || 1);
      centerPfp.classList.add('show');
    } else {
      centerPfp.classList.remove('show');
    }
  }
}

/** Duration of the tumble; keep in sync with `diceTumble` in board.css. */
const DICE_ROLL_MS = 620;
/** How often the faces flicker to a random value while tumbling. */
const DICE_CYCLE_MS = 70;

/** Identifies a roll so a re-render doesn't restart (or interrupt) the tumble. */
let diceAnimKey = '';
let diceCycleTimer: ReturnType<typeof setInterval> | null = null;
let diceStopTimer: ReturnType<typeof setTimeout> | null = null;

function clearDiceTimers(): void {
  if (diceCycleTimer !== null) clearInterval(diceCycleTimer);
  if (diceStopTimer !== null) clearTimeout(diceStopTimer);
  diceCycleTimer = null;
  diceStopTimer = null;
}

function renderDice(view: ViewState): void {
  if (!view.lastRoll) {
    // Turn ended: allow the next roll (even an identical one) to animate again.
    diceAnimKey = '';
    return;
  }
  const roll = view.lastRoll;
  const single = view.config.diceCount === 1;
  const f1 = DICE_FACE(roll.die1);
  const f2 = DICE_FACE(roll.die2);

  const dice1 = [byId('cdie1'), byId('rc-die1')].filter((d): d is HTMLElement => d !== null);
  const dice2 = [byId('cdie2'), byId('rc-die2')].filter((d): d is HTMLElement => d !== null);
  for (const d of dice2) d.style.display = single ? 'none' : '';

  const paintFinal = (): void => {
    for (const d of dice1) d.textContent = f1;
    for (const d of dice2) d.textContent = f2;
  };

  const key = `${roll.playerId}|${roll.die1}|${roll.die2}|${roll.from}|${roll.to}`;
  if (key === diceAnimKey) {
    // Same roll re-rendered by an unrelated state change. Don't restart the
    // tumble; only repaint if it has already finished.
    if (diceCycleTimer === null) paintFinal();
    return;
  }
  diceAnimKey = key;
  clearDiceTimers();

  const animated = [...dice1, ...(single ? [] : dice2)];
  for (const d of animated) {
    d.classList.remove('rolling', 'settled');
    void d.offsetWidth; // reflow so the animation restarts
    d.classList.add('rolling');
  }

  // Flicker through random faces so the result isn't spoiled mid-tumble.
  diceCycleTimer = setInterval(() => {
    for (const d of animated) d.textContent = DICE_FACE(1 + Math.floor(Math.random() * 6));
  }, DICE_CYCLE_MS);

  diceStopTimer = setTimeout(() => {
    clearDiceTimers();
    paintFinal();
    for (const d of animated) {
      d.classList.remove('rolling');
      void d.offsetWidth;
      d.classList.add('settled');
    }
  }, DICE_ROLL_MS);
}

function renderDeckGlow(view: ViewState, isMyTurn: boolean): void {
  const mahkamaPile = qs('.mahkama-pile');
  const hazakPile = qs('.hazak-pile');
  const draw = pendingOf(view, 'deck_draw');
  const isDrawPhase = view.phase === 'draw_card' && draw !== null && isMyTurn;

  for (const el of [mahkamaPile, hazakPile]) {
    el?.classList.toggle('clickable', isDrawPhase);
  }

  const clearAll = (): void => {
    for (const el of [mahkamaPile, hazakPile]) {
      el?.classList.remove('glow-mahkama', 'glow-hazak', 'glow-dual');
    }
  };

  if (!isDrawPhase || !draw) {
    clearAll();
    return;
  }

  clearAll();
  // The queue is the authority on what may be drawn: square 4 enqueues both
  // decks, so two entries means both piles glow (B10).
  const queue = draw.queue;
  if (queue.length > 1) {
    mahkamaPile?.classList.add('glow-dual');
    hazakPile?.classList.add('glow-dual');
  } else if (queue[0] === 'mahkama') {
    mahkamaPile?.classList.add('glow-mahkama');
  } else if (queue[0] === 'hazak') {
    hazakPile?.classList.add('glow-hazak');
  }
}

function setBtn(id: string, disabled: boolean, text?: string): void {
  const btn = byId<HTMLButtonElement>(id);
  if (!btn) return;
  btn.disabled = disabled;
  if (text !== undefined) btn.textContent = text;
}

function renderActionButtons(view: ViewState, isMyTurn: boolean): void {
  const cur = view.currentPlayer;
  const debugArea = byId('debug-area');
  const prison = byId('prison-actions');

  if (view.gameOver) {
    setBtn('btn-roll', true, '🏁 Game Over');
    setBtn('btn-trade', true);
    setBtn('btn-bid', true);
    if (debugArea) debugArea.style.display = 'none';
  } else if (isMyTurn && view.phase === 'draw_card') {
    setBtn('btn-roll', true, '🃏 Click deck to draw...');
    setBtn('btn-trade', false);
    setBtn('btn-bid', false);
    if (debugArea) debugArea.style.display = 'none';
    prison?.classList.remove('show');
  } else if (isMyTurn && view.phase === 'roll') {
    const inPrison = (cur?.statusEffects.missedTurnsRemaining ?? 0) > 0;
    if (inPrison && cur) {
      setBtn('btn-roll', true, '🔒 In Prison');
      prison?.classList.add('show');
      const jailFreeBtn = byId('btn-use-jailfree');
      if (jailFreeBtn) {
        const n = cur.inventory.jailFreeCards;
        jailFreeBtn.style.display = n > 0 ? '' : 'none';
        if (n > 0) jailFreeBtn.textContent = `🔓 Jail-Free (${n})`;
      }
    } else {
      setBtn('btn-roll', false, '🎲 Roll Dice');
      prison?.classList.remove('show');
    }
    setBtn('btn-trade', false);
    setBtn('btn-bid', false);
    if (debugArea) {
      const isHost = view.players[0]?.id === S.myPlayerId;
      debugArea.style.display = isHost ? '' : 'none';
      if (isHost) initDebugDropdown();
    }
  } else {
    setBtn('btn-roll', true, view.phase === 'rolling' ? '🎲 Rolling...' : '⏳ Wait...');
    setBtn('btn-trade', false);
    setBtn('btn-bid', false);
    if (debugArea) debugArea.style.display = 'none';
    prison?.classList.remove('show');
  }

  mirrorToRemote(view, isMyTurn);
}

function mirrorToRemote(view: ViewState, isMyTurn: boolean): void {
  const btnRoll = byId<HTMLButtonElement>('btn-roll');
  const btnTrade = byId<HTMLButtonElement>('btn-trade');
  const btnBid = byId<HTMLButtonElement>('btn-bid');

  const rcRoll = byId<HTMLButtonElement>('rc-btn-roll');
  if (rcRoll && btnRoll) {
    rcRoll.disabled = btnRoll.disabled;
    rcRoll.textContent = btnRoll.textContent;
  }
  const rcTrade = byId<HTMLButtonElement>('rc-btn-trade');
  if (rcTrade && btnTrade) rcTrade.disabled = btnTrade.disabled;
  const rcBid = byId<HTMLButtonElement>('rc-btn-bid');
  if (rcBid) rcBid.disabled = btnBid ? btnBid.disabled : true;

  const rcPrison = byId('rc-prison-actions');
  if (!rcPrison) return;
  const inPrison = byId('prison-actions')?.classList.contains('show') ?? false;
  const cur = view.currentPlayer;
  if (inPrison && isMyTurn && cur) {
    rcPrison.style.display = '';
    const rcJailFree = byId('rc-btn-use-jailfree');
    if (rcJailFree) {
      const n = cur.inventory.jailFreeCards;
      rcJailFree.style.display = n > 0 ? '' : 'none';
      if (n > 0) rcJailFree.textContent = `🔓 Jail-Free (${n})`;
    }
  } else {
    rcPrison.style.display = 'none';
  }
}

function renderRentActions(view: ViewState): void {
  const rentActions = byId('rent-actions');
  const rent = pendingOf(view, 'rent');

  if (rent === null || view.phase !== 'rent_payment') {
    if (rentActions) rentActions.style.display = 'none';
    return;
  }
  if (rent.playerId !== S.myPlayerId) {
    if (rentActions) rentActions.style.display = 'none';
    return;
  }

  if (rentActions) rentActions.style.display = 'flex';
  const me = playerById(view, S.myPlayerId);
  const canPay = me !== undefined && me.money !== null && me.money >= rent.amount;

  const btnPayRent = byId<HTMLButtonElement>('btn-pay-rent');
  if (btnPayRent) {
    btnPayRent.textContent = `💰 Pay $${rent.amount} Rent`;
    btnPayRent.style.display = canPay ? '' : 'none';
  }
  const btnBankrupt = byId<HTMLButtonElement>('btn-declare-bankrupt');
  if (btnBankrupt) btnBankrupt.style.display = !canPay && rent.ownerId !== null ? '' : 'none';

  setBtn('btn-roll', true, '💰 Pay rent first');
}

function flashMoneyChanges(view: ViewState): void {
  for (const p of view.players) {
    if (p.money === null) continue;
    const prev = prevMoney.get(p.id);
    if (prev !== undefined && prev !== p.money) {
      const diff = p.money - prev;
      const corner = qs(`.player-corner[data-player-id="${p.id}"]`);
      const moneyEl = corner?.querySelector('.pc-money');
      if (moneyEl) {
        moneyEl.classList.add(diff > 0 ? 'flash-gain' : 'flash-loss');
        window.setTimeout(() => {
          moneyEl.classList.remove('flash-gain', 'flash-loss');
        }, 1000);
      }
      if (p.id === S.myPlayerId) showFloatMoney(diff);
    }
    prevMoney.set(p.id, p.money);
  }
}

// ── Phase-driven dialogs ──

function choiceLabel(choice: Choice, index: number): string {
  if (choice.label !== undefined && choice.label !== '') return choice.label;
  switch (choice.type) {
    case 'receive_cash':
      return `💵 Receive $${choice.amount}`;
    case 'pay_fine':
      return `💸 Pay $${choice.amount}`;
    case 'go_to_prison':
      return '🔒 Go to prison';
    default:
      return `Option ${index + 1}`;
  }
}

function checkPhaseFromState(view: ViewState): void {
  const me = S.myPlayerId;

  const club = pendingOf(view, 'club');
  if (club !== null && view.phase === 'club_choice') {
    if (club.playerId !== me) return;
    const cp = playerById(view, club.playerId);
    if (!cp) return;
    setText('club-desc', `Welcome to نادي الحظ, ${cp.name}!`);
    setText('club-membership', `🎫 Membership: $${club.membershipCost}`);
    setText('club-guest', `🚪 Guest Fine: $${club.guestFineFee}`);
    const money = cp.money ?? 0;
    setBtn('club-btn-membership', money < club.membershipCost);
    setBtn('club-btn-guest', money < club.guestFineFee);
    byId('club-modal')?.classList.add('show');
    return;
  }

  const buy = pendingOf(view, 'property_buy');
  if (buy !== null && view.phase === 'property_choice') {
    if (buy.playerId !== me) return;
    const sq = view.squares.find((s) => s.id === buy.squareId);
    if (!sq) return;
    setText('buy-prop-name', sq.name);
    setText('buy-prop-price', `$${sq.purchasePrice ?? 0}`);
    byId('buy-modal')?.classList.add('show');
    return;
  }

  const upgrade = pendingOf(view, 'upgrade');
  if (upgrade !== null && view.phase === 'upgrade_choice') {
    if (upgrade.playerId !== me) return;
    const sq = view.squares.find((s) => s.id === upgrade.squareId);
    setText('upgrade-prop-name', sq?.name ?? '');
    const optsEl = byId('upgrade-options');
    if (optsEl) {
      optsEl.innerHTML = '';
      for (const opt of upgrade.options) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-buy';
        btn.style.cssText = 'font-size:0.85rem;padding:8px 16px;';
        btn.textContent = `${UPGRADE_ICONS[opt.tier]} ${opt.tier} — $${opt.cost} (Rent: $${opt.visitorRent})`;
        // Bound directly instead of an onclick= string carrying an interpolated
        // id, so a renamed tier is a compile error rather than a dead button.
        btn.addEventListener('click', () => {
          onBuyUpgrade(upgrade.squareId, opt.tier);
        });
        optsEl.appendChild(btn);
      }
    }
    byId('upgrade-modal')?.classList.add('show');
    return;
  }

  const cardChoice = pendingOf(view, 'card_choice');
  if (cardChoice !== null && view.phase === 'card_choice') {
    if (cardChoice.playerId !== me) return;
    byId('card-modal')?.classList.add('show');
    const cp = playerById(view, cardChoice.playerId);
    const emoji = cardChoice.card.deck === 'mahkama' ? '⚖️' : '🍀';
    setText('card-modal-title', `${emoji} ${cp ? cp.name : 'You'} — اختر`);

    const body = byId('card-modal-body');
    if (!body) return;
    body.innerHTML = '';
    if (cardChoice.title) {
      const desc = document.createElement('p');
      desc.style.cssText = 'font-size:0.85rem;color:#5a3a1a;margin-bottom:10px;text-align:center;';
      desc.textContent = cardChoice.title;
      body.appendChild(desc);
    }
    cardChoice.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (opt.type === 'receive_cash' || opt.type === 'pay_fine' ? 'btn-buy' : 'btn-choice');
      btn.style.cssText = 'font-size:0.85rem;padding:8px 16px;width:100%;margin:4px 0;';
      btn.textContent = choiceLabel(opt, i);
      btn.addEventListener('click', () => {
        onSelectCardChoice(i);
      });
      body.appendChild(btn);
    });
  }
}

// ── Entry point ──

export function updateUI(): void {
  const view = S.view;
  if (!view) return;

  // Turn-limited dialogs are dismissed before anything reopens, so a dialog
  // belonging to a phase that has already passed cannot linger.
  for (const id of TURN_LIMITED_MODALS) {
    byId(id)?.classList.remove('show');
  }

  const isMyTurn = view.currentPlayer?.id === S.myPlayerId;

  renderDeckCounters(view);
  renderOccupiedCells(view);
  renderOwnership(view);
  renderTokens(view);
  renderTurnBanner(view, isMyTurn);
  renderDice(view);
  renderDeckGlow(view, isMyTurn);
  renderActionButtons(view, isMyTurn);
  renderRentActions(view);
  renderPlayerCorners();
  flashMoneyChanges(view);
  renderBidFloats();
  checkPhaseFromState(view);
  updateTimerUI();
}

export { escapeHtml };
