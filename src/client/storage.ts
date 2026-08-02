/**
 * Session persistence and the save/export/import controls.
 *
 * B19: the client no longer stores or sends game state. It used to write the
 * whole `gameState` to localStorage and hand it back on `restore_game`, so
 * anything with a text editor could rewrite the board and the server would take
 * it. What is stored now is the opaque `SignedSnapshot` the server issued — an
 * HMAC-signed, version-gated blob this module treats as bytes and never parses
 * for gameplay. Export/import still work; they just move a blob the server will
 * re-validate instead of state it will trust.
 */

import type { SignedSnapshot } from '../shared/events.js';
import type { SeatId } from '../shared/types.js';
import { byId } from './dom.js';
import { S } from './state.js';
import { socket } from './net/socket.js';
import { showToast } from './ui/effects.js';

const SAVE_KEY = 'bankelhaz_fullsave';
const SESSION_KEY = 'bankelhaz_session';

interface SaveFile {
  roomCode: string;
  playerName: string;
  playerId: SeatId | null;
  snapshot: SignedSnapshot;
  savedAt: number;
}

export interface SessionHint {
  roomCode: string;
  playerName: string;
}

// ── Parsing (defensive: everything here is attacker-editable) ──

function isSnapshot(v: unknown): v is SignedSnapshot {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o['v'] === 1 && typeof o['payload'] === 'string' && typeof o['sig'] === 'string';
}

function parseSaveFile(raw: string): SaveFile | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o['roomCode'] !== 'string' || typeof o['playerName'] !== 'string') return null;
    if (!isSnapshot(o['snapshot'])) return null;
    const pid = o['playerId'];
    return {
      roomCode: o['roomCode'],
      playerName: o['playerName'],
      playerId: typeof pid === 'string' ? pid : null,
      snapshot: o['snapshot'],
      savedAt: typeof o['savedAt'] === 'number' ? o['savedAt'] : 0,
    };
  } catch {
    return null;
  }
}

function readSave(): SaveFile | null {
  const raw = localStorage.getItem(SAVE_KEY);
  return raw === null ? null : parseSaveFile(raw);
}

export function readSessionHint(): SessionHint | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (parsed === null || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o['roomCode'] !== 'string' || typeof o['playerName'] !== 'string') return null;
    return { roomCode: o['roomCode'], playerName: o['playerName'] };
  } catch {
    return null;
  }
}

// ── Room badge ──

export function updateRoomCodeBadge(): void {
  const badge = byId('room-code-badge');
  const leaveBtn = byId('btn-leave');
  if (!badge || !leaveBtn) return;
  if (S.roomCode !== null && byId('game-container')?.style.display === 'block') {
    badge.textContent = '🏠 ' + S.roomCode;
    badge.style.display = 'inline-block';
    leaveBtn.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
    leaveBtn.style.display = 'none';
  }
}

// ── Persist ──

/**
 * Writes the latest signed snapshot. A no-op until the server has issued one —
 * there is nothing else worth saving, and fabricating a save from the projected
 * view is exactly what B19 forbids.
 */
export function persistGameState(): void {
  if (S.roomCode === null || !S.myPlayerName || S.snapshot === null) return;
  const data: SaveFile = {
    roomCode: S.roomCode,
    playerName: S.myPlayerName,
    playerId: S.myPlayerId,
    snapshot: S.snapshot,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: data.roomCode, playerName: data.playerName }));
  } catch {
    /* quota exceeded — the game is still playable, so this stays silent */
  }
}

export function clearSavedGame(): void {
  localStorage.removeItem(SAVE_KEY);
  localStorage.removeItem(SESSION_KEY);
  checkSavedGame();
}

// ── Restore ──

export function checkSavedGame(): void {
  const btn = byId('btn-restore-game');
  if (!btn) return;
  const save = readSave();
  const display = save ? 'inline-block' : 'none';
  if (btn.style.display !== display) btn.style.display = display;

  if (save && byId('game-container')?.style.display !== 'block') {
    // The legacy call passed 6000 here as if showToast took a duration; the
    // second parameter is `isCard`, so every "saved game found" notice was
    // rendered with the card-toast styling by accident.
    showToast('💾 Saved game found — click "Resume Game" to continue');
  }
}

export function restoreSavedGame(): void {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw === null) {
    showToast('❌ No saved game found');
    return;
  }
  const save = parseSaveFile(raw);
  if (!save) {
    showToast('❌ Corrupted save');
    return;
  }
  socket.emit('restore_game', {
    roomCode: save.roomCode,
    playerName: save.playerName,
    ...(save.playerId === null ? {} : { playerId: save.playerId }),
    snapshot: save.snapshot,
  });
}

// ── Export / import ──

export function exportGameState(): void {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw === null) {
    showToast('❌ No saved game to export');
    return;
  }
  const blob = new Blob([raw], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bankelhaz_${S.roomCode ?? 'game'}.json`;
  a.click();
  // The legacy version never revoked the object URL, so every export leaked the
  // whole blob for the lifetime of the page.
  URL.revokeObjectURL(url);
  showToast('📥 Game exported');
}

export function importGameState(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!input || !file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const text = typeof reader.result === 'string' ? reader.result : '';
    const save = parseSaveFile(text);
    if (!save) {
      showToast('❌ Invalid save file');
      return;
    }
    localStorage.setItem(SAVE_KEY, text);
    showToast('✅ Game imported! Click Resume Game');
    checkSavedGame();
  };
  reader.onerror = () => {
    showToast('❌ Could not read file');
  };
  reader.readAsText(file);
  input.value = '';
}
