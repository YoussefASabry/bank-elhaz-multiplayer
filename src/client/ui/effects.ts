/**
 * Transient visual feedback: the toast feed, floating money, the big centre
 * overlay and the shared public-card reveal.
 *
 * `#toast-container` is a scrolling message feed by design (CSS gives it
 * `overflow-y:auto` and a max height), so toasts are meant to persist — they are
 * not auto-dismissing popups and this module does not turn them into any.
 */

import type { WireCardInfo } from '../../server/wire.js';
import { byId, setText, setDisplay, qsa } from '../dom.js';
import { S } from '../state.js';

// ── Toast feed ──

/** Bounds the feed's DOM. Far beyond the ~6 rows that fit in the 100px panel. */
const MAX_TOASTS = 100;
const MAX_LOGS = 500;

export function showToast(msg: string, isCard = false): void {
  const container = byId('toast-container');
  if (!container) return;

  // The legacy guard compared against EVERY toast ever appended, and nothing
  // ever removes them — so the first "❌ Not your turn" permanently suppressed
  // all later ones. Comparing against the newest entry only is what "avoid
  // duplicate identical toasts stacking" actually meant.
  const last = container.lastElementChild;
  if (last && last.textContent === msg) return;

  const el = document.createElement('div');
  el.className = 'toast' + (isCard ? ' card-toast' : '');
  el.textContent = msg;
  container.appendChild(el);

  while (container.childElementCount > MAX_TOASTS && container.firstElementChild) {
    container.firstElementChild.remove();
  }

  container.scrollTop = container.scrollHeight;
}

export function log(...args: unknown[]): void {
  const msg = args.map((a) => String(a)).join(' ');
  S.logs.push(msg);
  if (S.logs.length > MAX_LOGS) S.logs.splice(0, S.logs.length - MAX_LOGS);
  console.log(msg);
}

// ── Floating money ──

export function showFloatMoney(amount: number): void {
  const container = byId('float-money-container');
  if (!container) return;
  const el = document.createElement('div');
  const sign = amount >= 0 ? '+' : '';
  const color = amount >= 0 ? '#2e7d32' : '#c0392b';
  el.textContent = `${sign}$${amount}`;
  el.style.cssText = `
      position: absolute; left: 50%; top: 40%;
      transform: translateX(-50%);
      font-size: 2rem; font-weight: bold; font-family: monospace;
      color: ${color}; text-shadow: 0 0 10px rgba(0,0,0,0.2);
      pointer-events: none; z-index: 150;
      animation: floatMoneyAnim 1.5s ease-out forwards;
    `;
  container.appendChild(el);
  el.addEventListener('animationend', () => {
    el.remove();
  });
}

/** Injects the float keyframes once. Called from main.ts, not at import time. */
export function initEffects(): void {
  if (byId('float-money-style')) return;
  const style = document.createElement('style');
  style.id = 'float-money-style';
  style.textContent = `
      @keyframes floatMoneyAnim {
        0% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        50% { opacity: 1; transform: translateX(-50%) translateY(-40px) scale(1.3); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-80px) scale(1); }
      }
    `;
  document.head.appendChild(style);
}

// ── Big centre text ──

let bigTextTimeout: number | null = null;

export function showBigText(text: string, replace = false, type = ''): void {
  const overlay = byId('big-text-overlay');
  if (!overlay) return;
  if (replace) {
    overlay.innerHTML = '';
    if (bigTextTimeout !== null) {
      clearTimeout(bigTextTimeout);
      bigTextTimeout = null;
    }
  }
  const el = document.createElement('div');
  el.className = 'big-text' + (type ? ' big-' + type : '');
  el.textContent = text;
  overlay.appendChild(el);
  el.addEventListener('animationend', (e) => {
    if (e.animationName === 'bigTextOut') el.remove();
  });
  if (replace) {
    bigTextTimeout = window.setTimeout(() => {
      overlay.innerHTML = '';
      bigTextTimeout = null;
    }, 2000);
  }
}

/**
 * Cancels a scheduled overlay clear. Called when the turn ends, so a 2s timer
 * started by the previous turn cannot blank an overlay the new turn just drew.
 */
export function cancelBigText(): void {
  if (bigTextTimeout !== null) {
    clearTimeout(bigTextTimeout);
    bigTextTimeout = null;
  }
}

// ── Public card reveal ──

export function showPublicCard(data: WireCardInfo & { playerName: string }): void {
  const playerName = data.playerName || 'A player';
  const isMahkama = data.deckType === 'mahkama';

  setText('blind-card-title', isMahkama ? `⚖️ ${playerName} drew المحكمة` : `🍀 ${playerName} drew حظك`);

  const face = byId('card-face-content');
  if (face) {
    face.classList.remove('mahkama-face', 'hazak-face');
    face.classList.add(isMahkama ? 'mahkama-face' : 'hazak-face');
  }

  setText('card-face-header', isMahkama ? '⚖️' : '🍀');
  setText('card-face-type', isMahkama ? '⚖️ المحكمة' : '🍀 حظك');
  setText('card-face-desc', data.card.description || '—');
  setDisplay('btn-confirm-card', 'none');

  const citiesEl = byId('card-face-cities');
  if (citiesEl) {
    if (data.cityNames.length > 0) {
      citiesEl.textContent = `🏙️ ${data.cityNames.join('، ')}`;
      citiesEl.style.display = 'block';
    } else {
      citiesEl.style.display = 'none';
    }
  }

  byId('blind-card-modal')?.classList.add('show');
}

export function closePublicCard(): void {
  byId('blind-card-modal')?.classList.remove('show');
  setDisplay('btn-confirm-card', '');
}

/** Removes every transient overlay. Used on reconnect and on leaving a game. */
export function clearTransientOverlays(): void {
  cancelBigText();
  const overlay = byId('big-text-overlay');
  if (overlay) overlay.innerHTML = '';
  qsa('.float-money').forEach((el) => {
    el.remove();
  });
}
