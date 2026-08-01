import { BOARD_H, BOARD_W } from './constants';
import { byId, el } from './dom';

/**
 * Static game screen layout: board + mobile remote control + player corners.
 * The remote control is hidden on desktop via inline style (mobile CSS wins
 * with `display:block !important`). `zoom` scales the board's layout box too,
 * so no wrapper with manually-resized dimensions is needed.
 */
export function buildGameLayout(container: HTMLElement): void {
  container.textContent = '';

  const layout = el('div', 'game-layout');
  const board = el('div');
  board.id = 'board';
  layout.appendChild(board);
  layout.appendChild(buildRemoteControl());

  const corners = el('div');
  corners.id = 'player-corners';
  layout.appendChild(corners);

  container.appendChild(layout);

  const playersBtn = el('button', 'btn btn-choice', '👥');
  playersBtn.id = 'btn-players-float';
  playersBtn.type = 'button';
  playersBtn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:40;padding:8px 12px;font-size:1rem;border-radius:50%;';
  container.appendChild(playersBtn);

  const leaveBtn = el('button', 'btn btn-decline', '🚪 Leave');
  leaveBtn.id = 'btn-leave-game';
  leaveBtn.type = 'button';
  leaveBtn.title = 'Leave game and return to lobby';
  leaveBtn.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:40;padding:8px 12px;font-size:0.85rem;border-radius:20px;';
  container.appendChild(leaveBtn);

  const badge = el('div');
  badge.id = 'room-code-badge';
  badge.style.cssText =
    'position:fixed;top:50px;left:8px;z-index:40;padding:4px 10px;border-radius:6px;' +
    'border:1px solid #c4a96a;background:rgba(245,230,200,0.85);color:#5a3a0a;' +
    'font-size:0.75rem;font-weight:bold;letter-spacing:1px;display:none;';
  container.appendChild(badge);
}

function buildRemoteControl(): HTMLElement {
  const rc = el('div');
  rc.id = 'remote-control';
  rc.style.display = 'none';

  const status = el('div');
  status.id = 'rc-status';

  const banner = el('div', 'turn-banner', '🎯 —');
  banner.id = 'rc-turn-banner';

  const timer = el('div', 'cc-timer');
  timer.id = 'rc-timer-bar';
  timer.style.display = 'none';
  const timerDisplay = el('span', 'cc-timer-display', '1:00');
  timerDisplay.id = 'rc-timer-display';
  const timerFillWrap = el('div', 'timer-fill');
  const timerFill = el('div', 'timer-fill-inner');
  timerFill.id = 'rc-timer-fill';
  timerFill.style.width = '100%';
  timerFillWrap.appendChild(timerFill);
  timer.appendChild(timerDisplay);
  timer.appendChild(timerFillWrap);

  const diceArea = el('div', 'center-dice');
  diceArea.id = 'rc-dice-area';
  const die1 = el('div', 'die', '⚀');
  die1.id = 'rc-die1';
  const die2 = el('div', 'die', '⚀');
  die2.id = 'rc-die2';
  diceArea.appendChild(die1);
  diceArea.appendChild(die2);

  status.appendChild(banner);
  status.appendChild(timer);
  status.appendChild(diceArea);

  const row1 = el('div', 'rc-row');
  const rollBtn = el('button', 'btn btn-primary roll-dice-btn', '🎲 Roll');
  rollBtn.id = 'rc-btn-roll';
  rollBtn.type = 'button';
  rollBtn.disabled = true;
  row1.appendChild(rollBtn);

  const row2 = el('div', 'rc-row rc-secondary');
  const tradeBtn = el('button', 'btn btn-trade rc-btn-trade', '🤝 Trade');
  tradeBtn.id = 'rc-btn-trade';
  tradeBtn.type = 'button';
  const bidBtn = el('button', 'btn btn-choice rc-btn-bid', '📢 Bid');
  bidBtn.id = 'rc-btn-bid';
  bidBtn.type = 'button';
  const inventoryBtn = el('button', 'btn btn-choice', '📦 My Stuff');
  inventoryBtn.id = 'rc-btn-inventory';
  inventoryBtn.type = 'button';
  row2.appendChild(tradeBtn);
  row2.appendChild(bidBtn);
  row2.appendChild(inventoryBtn);

  const prison = el('div', 'cc-prison');
  prison.id = 'rc-prison-actions';
  prison.style.display = 'none';
  const label = el('span', '', '🔒 In prison');
  const btnSkip = el('button', 'btn btn-skip', '⏭️ Skip');
  btnSkip.dataset.prison = 'skip';
  btnSkip.type = 'button';
  const btnBail = el('button', 'btn btn-bail', '💰 Bail');
  btnBail.dataset.prison = 'bail';
  btnBail.type = 'button';
  const btnFree = el('button', 'btn btn-jailfree', '🔓 Free');
  btnFree.dataset.prison = 'free';
  btnFree.type = 'button';
  prison.appendChild(label);
  prison.appendChild(btnSkip);
  prison.appendChild(btnBail);
  prison.appendChild(btnFree);

  rc.appendChild(status);
  rc.appendChild(row1);
  rc.appendChild(row2);
  rc.appendChild(prison);
  return rc;
}

/** Fit the board into the viewport via CSS `zoom` (scales layout box too). */
export function resizeBoard(): void {
  const board = byId('board');
  if (!board) return;
  const scale = Math.min(1, (window.innerWidth - 20) / BOARD_W);
  board.style.zoom = String(scale);
}

export { BOARD_H, BOARD_W };
