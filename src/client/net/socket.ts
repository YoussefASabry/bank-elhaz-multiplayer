/**
 * The one socket, typed against the frozen wire contract.
 *
 * `Socket<ServerToClientEvents, ClientToServerEvents>` means a typo in an event
 * name, or a payload missing `roomCode`, is a compile error rather than an
 * intent that silently vanishes into the server. That is the whole reason the
 * contract in `server/wire.ts` is imported rather than restated: one definition,
 * checked from both ends. WIRE.md's 35 + 37 events are exactly what this file
 * can speak — no renames, no additions.
 *
 * socket.io itself still comes from the CDN <script> in index.html (that markup
 * is frozen and must not move), so the runtime `io` is a global and only its
 * TYPES are imported. Importing the npm package instead would ship a second
 * copy of socket.io in the bundle.
 */

import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../server/wire.js';
import { byId, qsa, escapeHtml } from '../dom.js';
import { S } from '../state.js';
import { showToast } from '../ui/effects.js';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface IoFactory {
  (uri: string, opts: { transports: string[] }): GameSocket;
}

declare global {
  // Provided by the socket.io CDN <script> tag in index.html.
  // eslint-disable-next-line no-var
  var io: IoFactory;
}

export const socket: GameSocket = io('', { transports: ['websocket', 'polling'] });

/** Set by main.ts; lets the connect handler run the one-shot session prompt. */
let onFirstConnect: (() => void) | null = null;

export function setFirstConnectHook(fn: () => void): void {
  onFirstConnect = fn;
}

function updateSocketStatus(connected: boolean): void {
  const el = byId('socket-status');
  if (!el) return;
  if (connected || socket.connected) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.textContent = '🔴 Disconnected from server — start the server with: node multiplayer/server.js';
}

function showSocketDisconnected(): void {
  if (byId('game-container')?.style.display !== 'block') return;
  if (document.querySelector('.socket-disconnected-overlay')) return;

  // Both values are user-supplied and were interpolated raw into attributes; a
  // name containing a quote used to break out of the value and destroy the form.
  const code = escapeHtml(S.roomCode ?? '');
  const name = escapeHtml(S.myPlayerName || (readSavedName() ?? ''));

  const overlay = document.createElement('div');
  overlay.className = 'socket-disconnected-overlay';
  overlay.innerHTML = `<div style="background:#c0392b;color:#fff;padding:8px 16px;text-align:center;font-size:0.9rem;font-weight:bold;">🔴 Disconnected from server — rejoin below</div>
<div style="background:#f5e6c8;padding:12px 16px;text-align:center;border-bottom:2px solid #c4a96a;">
  <input type="text" id="rejoin-code" placeholder="Room Code" value="${code}" maxlength="4" style="width:80px;padding:6px 8px;border-radius:6px;border:1px solid #c4a96a;text-transform:uppercase;letter-spacing:3px;font-weight:bold;text-align:center;font-size:0.9rem;margin-right:6px;">
  <input type="text" id="rejoin-name" placeholder="Your Name" value="${name}" maxlength="20" style="width:120px;padding:6px 8px;border-radius:6px;border:1px solid #c4a96a;font-size:0.9rem;margin-right:6px;">
  <button onclick="emitRejoin()" style="padding:6px 16px;border-radius:6px;border:none;background:#2e7d32;color:#fff;font-size:0.85rem;cursor:pointer;font-weight:bold;">🔗 Rejoin</button>
</div>`;
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;';
  document.body.prepend(overlay);
}

function clearSocketDisconnected(): void {
  qsa('.socket-disconnected-overlay').forEach((el) => {
    el.remove();
  });
}

function readSavedName(): string | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('bankelhaz_prefs') ?? '{}');
    if (parsed !== null && typeof parsed === 'object' && 'name' in parsed) {
      const n = (parsed as { name?: unknown }).name;
      if (typeof n === 'string') return n;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Registers the transport-level handlers. Called once from main.ts.
 *
 * `connect_error` used to be registered TWICE — the same handler body appeared
 * at two points in the inline script — so every failed connection attempt built
 * the rejoin overlay twice and logged twice. Registration happening in exactly
 * one place, once, is what stops that recurring.
 */
export function initSocketLifecycle(): void {
  socket.on('connect', () => {
    console.log('[socket] connected', socket.id);
    updateSocketStatus(true);
    clearSocketDisconnected();
    // Only on the FIRST connect. The legacy code ran the "Rejoin room X?"
    // confirm() and the saved-game check on every reconnect, so a flaky
    // connection produced a modal dialog per reconnect, mid-game.
    if (!S.rejoinOffered) {
      S.rejoinOffered = true;
      onFirstConnect?.();
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('[socket] disconnected', reason);
    showSocketDisconnected();
    updateSocketStatus(false);
  });

  socket.on('connect_error', (err: Error) => {
    console.error('[socket] connect error', err.message);
    showSocketDisconnected();
    updateSocketStatus(false);
  });

  window.setTimeout(() => {
    updateSocketStatus(socket.connected);
  }, 500);
}

/** Re-joins from the disconnect overlay's own form. */
export function emitRejoin(): void {
  const code = (byId<HTMLInputElement>('rejoin-code')?.value ?? '').trim().toUpperCase();
  const name = (byId<HTMLInputElement>('rejoin-name')?.value ?? '').trim();
  if (!code || !name) {
    showToast('❌ Enter room code and name');
    return;
  }
  socket.emit('rejoin_game', { roomCode: code, playerName: name });
  showToast('🔄 Attempting to rejoin as ' + name + '...');
}

/**
 * Emits an intent that needs the current room. Returns false (and does nothing)
 * when there is no room — the legacy code sent `{roomCode: null}` and let the
 * server reject it.
 */
export function emitInRoom<E extends keyof ClientToServerEvents>(
  event: E,
  payload: Omit<Parameters<ClientToServerEvents[E]>[0], 'roomCode'>,
): boolean {
  if (S.roomCode === null) return false;
  const full = { ...payload, roomCode: S.roomCode } as Parameters<ClientToServerEvents[E]>[0];
  (socket.emit as (e: E, p: unknown) => void)(event, full);
  return true;
}
