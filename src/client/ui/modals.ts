/**
 * Backdrop dismissal for the modals that support it, plus the global close-all.
 *
 * Each overlay closes only when the click landed on the backdrop itself
 * (`target === currentTarget`), never on a child — that check is what keeps a
 * click inside the dialog from dismissing it.
 *
 * Handlers are attached once, from `initModals`. The legacy registrations sat at
 * script top level, which had the same effect only by accident; making it an
 * explicit one-shot means re-entering a room cannot stack a second listener that
 * closes the dialog twice.
 */

import { byId, qsa } from '../dom.js';

/** Dismisses every open dialog. Used on reconnect, game over and leaving. */
export function closeAllModals(): void {
  qsa('.modal-overlay, .modal-overlay-transparent').forEach((el) => {
    el.classList.remove('show');
  });
}

function onBackdrop(id: string, close: () => void): void {
  const el = byId(id);
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
}

export interface ModalCloseHandlers {
  closeInspect: () => void;
  minimizeTrade: () => void;
  closeBidCreate: () => void;
  closeBidRespond: () => void;
  closePlayerSelector: () => void;
}

/**
 * Wires backdrop dismissal. Takes the close functions as arguments rather than
 * reaching through `window`, so a renamed handler is a compile error instead of
 * a dialog that silently stops closing.
 */
export function initModals(h: ModalCloseHandlers): void {
  onBackdrop('inspect-modal', h.closeInspect);
  onBackdrop('trade-modal', h.minimizeTrade);
  onBackdrop('bid-create-modal', h.closeBidCreate);
  onBackdrop('bid-respond-modal', h.closeBidRespond);
  onBackdrop('player-selector', h.closePlayerSelector);
  onBackdrop('sell-bldg-modal', () => {
    byId('sell-bldg-modal')?.classList.remove('show');
  });
}
