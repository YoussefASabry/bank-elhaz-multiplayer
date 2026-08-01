import { byId, el, qs } from './dom';
import { DICE_FACES } from './constants';

export interface ToastOpts {
  card?: boolean;
  ttl?: number;
}

export function showToast(message: string, opts: ToastOpts = {}): void {
  const container = byId('toast-container');
  if (!container) return;
  const toast = el('div', opts.card ? 'toast card-toast' : 'toast');
  toast.textContent = message;
  container.appendChild(toast);
  while (container.children.length > 6) container.removeChild(container.firstChild as Node);
  const ttl = opts.ttl ?? 3000;
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.animation = 'toastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }
  }, ttl);
}

type BigTextMode = 'gold' | 'loss' | 'celebrate';

export function showBigText(text: string, mode: BigTextMode = 'gold'): void {
  const overlay = byId('big-text-overlay');
  if (!overlay) return;
  const node = el('div', `big-text${mode === 'loss' ? ' big-loss' : mode === 'celebrate' ? ' big-celebrate' : ''}`);
  node.textContent = text;
  overlay.appendChild(node);
  setTimeout(() => node.remove(), 1700);
}

/**
 * Money float near a player corner. Amount sign picks the direction; negative
 * floats down in red, positive floats up in green.
 */
export function showFloatMoney(amount: number, playerId: string): void {
  const corner = byId(`player-corner-${playerId}`);
  const container = byId('float-money-container');
  if (!container) return;
  const node = el('div', 'float-money');
  const gain = amount >= 0;
  node.textContent = `${gain ? '+' : '−'}${Math.abs(amount).toLocaleString('en-US')}`;
  node.style.color = gain ? '#2e7d32' : '#c0392b';
  node.style.animationName = gain ? 'floatUp' : 'floatDown';
  const rect = corner ? corner.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2 };
  node.style.left = `${rect.left + 20}px`;
  node.style.top = `${rect.top}px`;
  container.appendChild(node);
  setTimeout(() => node.remove(), 1300);
}

export function flashMoney(playerId: string, delta: number): void {
  const corner = byId(`player-corner-${playerId}`);
  if (!corner) return;
  const money = qs<HTMLElement>('.pc-money', corner);
  if (!money) return;
  money.classList.remove('flash-gain', 'flash-loss');
  void money.offsetWidth;
  money.classList.add(delta >= 0 ? 'flash-gain' : 'flash-loss');
  setTimeout(() => money.classList.remove('flash-gain', 'flash-loss'), 600);
}

/** Card drawn from the center deck, flying to the drawer's corner. */
export function animateCardFly(isMahkama: boolean, onDone: () => void): void {
  const source = qs<HTMLElement>(isMahkama ? '.deck-pile.mahkama-pile' : '.deck-pile.hazak-pile');
  const fly = el('div', isMahkama ? 'card-fly mahkama-fly' : 'card-fly hazak-fly');
  fly.textContent = isMahkama ? '⚖️' : '🍀';
  document.body.appendChild(fly);
  const srcRect = source ? source.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2 };
  fly.style.left = `${srcRect.left}px`;
  fly.style.top = `${srcRect.top}px`;
  fly.style.transition = 'all 0.6s cubic-bezier(0.4, 0.0, 0.2, 1)';
  const done = () => {
    fly.remove();
    onDone();
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fly.style.left = `${window.innerWidth / 2 - 45}px`;
      fly.style.top = `${window.innerHeight / 2 - 32}px`;
      fly.style.transform = 'scale(1.8) rotate(8deg)';
      fly.style.opacity = '0.4';
    });
  });
  setTimeout(done, 650);
}

export function setDieFaces(dieEls: HTMLElement[], die1: number, die2: number): void {
  if (dieEls[0]) dieEls[0].textContent = DICE_FACES[die1] ?? '';
  if (dieEls[1]) dieEls[1].textContent = DICE_FACES[die2] ?? '';
}

/** Shake dice for `ms`, then settle on the rolled faces. */
export function animateDice(dieEls: HTMLElement[], die1: number, die2: number, ms = 700): Promise<void> {
  return new Promise((resolve) => {
    dieEls.forEach((d) => d.classList.add('rolling'));
    const settle = () => {
      dieEls.forEach((d) => d.classList.remove('rolling'));
      setDieFaces(dieEls, die1, die2);
      resolve();
    };
    setTimeout(settle, ms);
  });
}

/** Update the turn timer bars (center + remote control); hides them when idle. */
export function updateTimer(seconds: number, running: boolean, total: number): void {
  const show = running && total > 0;
  document.querySelectorAll<HTMLElement>('.cc-timer').forEach((bar) => {
    bar.style.display = show ? 'flex' : 'none';
    if (!show) return;
    const display = qs<HTMLElement>('.cc-timer-display', bar);
    const fill = qs<HTMLElement>('.timer-fill-inner', bar);
    if (!display || !fill) return;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    display.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    const frac = Math.max(0, Math.min(1, seconds / total));
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    bar.classList.toggle('timer-danger', seconds <= 10);
    bar.classList.toggle('timer-warn', seconds > 10 && seconds <= 25);
  });
}

/** Bus fast-travel animation between two squares. */
export function animateBus(fromId: number, toId: number): void {
  const car = byId('moving-car');
  if (!car) return;
  const fromCell = byId(`square-${fromId}`);
  const toCell = byId(`square-${toId}`);
  if (!fromCell || !toCell) return;
  const fromRect = fromCell.getBoundingClientRect();
  const toRect = toCell.getBoundingClientRect();
  car.style.display = 'block';
  car.style.left = `${fromRect.left}px`;
  car.style.top = `${fromRect.top}px`;
  car.textContent = '🚌';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      car.style.transition = 'left 0.5s ease-in-out, top 0.5s ease-in-out, transform 0.5s ease-in-out';
      car.style.left = `${toRect.left}px`;
      car.style.top = `${toRect.top}px`;
    });
  });
  setTimeout(() => {
    car.style.display = 'none';
    car.style.transition = 'none';
  }, 650);
}
