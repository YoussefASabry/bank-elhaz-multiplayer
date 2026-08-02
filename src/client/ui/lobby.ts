/**
 * Lobby: hosting, joining, the waiting room and the way back out.
 *
 * Room options are narrowed here rather than passed through as strings — the
 * legacy code read `<select>.value` straight into the `host_game` payload, so a
 * renamed option value reached the server as an unknown string and silently fell
 * back to a default.
 */

import type { WireRoomOptions } from '../../server/wire.js';
import { byId, qsa, inputValue, numberValue, setText, escapeHtml } from '../dom.js';
import { S, resetGameState, type LobbyPlayer } from '../state.js';
import { socket } from '../net/socket.js';
import { getPfpUrl, initThemeSelectors } from '../theme.js';
import { updateRoomCodeBadge } from '../storage.js';
import { showToast } from './effects.js';

function selectValue(id: string): string {
  return byId<HTMLSelectElement>(id)?.value ?? '';
}

function readRoomOptions(): WireRoomOptions {
  const dice = numberValue('opt-dice-count', 2);
  const timing = selectValue('opt-trade-timing');
  return {
    startingCash: numberValue('opt-starting-cash', 1500),
    passGoSalary: numberValue('opt-passgo-salary', 250),
    diceCount: dice === 1 ? 1 : 2,
    moneyVisible: selectValue('opt-money-visibility') === 'visible',
    tradeTiming: timing === 'own_turn' ? 'own_turn' : 'anytime',
  };
}

function rememberSession(name: string, code: string): void {
  S.myPlayerName = name;
  S.roomCode = code;
  localStorage.setItem('bankelhaz_prefs', JSON.stringify({ name }));
  localStorage.setItem('bankelhaz_session', JSON.stringify({ roomCode: code, playerName: name }));
}

function setDisabled(id: string, disabled: boolean): void {
  const btn = byId<HTMLButtonElement>(id);
  if (btn) btn.disabled = disabled;
}

// ── Host / join ──

export function hostGame(): void {
  const name = inputValue('host-name') || 'Player';
  setText('lobby-error-host', '');
  setDisabled('btn-host', true);

  socket.emit(
    'host_game',
    { playerName: name, avatar: S.mySelectedAvatar, options: readRoomOptions() },
    (res) => {
      if (res.ok && res.roomCode !== undefined) {
        S.myPlayerId = res.playerId ?? null;
        rememberSession(name, res.roomCode);
        showRoomWaiting();
      } else {
        setText('lobby-error-host', res.error ?? 'Failed to create room');
        setDisabled('btn-host', false);
      }
    },
  );
}

export function joinGame(): void {
  const name = inputValue('join-name') || 'Player';
  const code = inputValue('join-code').toUpperCase();
  if (code.length < 2) {
    setText('lobby-error-join', 'Enter a room code');
    return;
  }
  setText('lobby-error-join', '');
  setDisabled('btn-join', true);

  socket.emit('join_game', { roomCode: code, playerName: name, avatar: S.mySelectedAvatar }, (res) => {
    if (res.ok && res.roomCode !== undefined) {
      S.myPlayerId = res.playerId ?? null;
      rememberSession(name, res.roomCode);
      showRoomWaiting();
    } else {
      setText('lobby-error-join', res.error ?? 'Failed to join');
      setDisabled('btn-join', false);
    }
  });
}

// ── Waiting room ──

export function showRoomWaiting(players?: readonly LobbyPlayer[]): void {
  const list = byId('lobby-player-list');
  if (list) list.innerHTML = '';
  qsa<HTMLElement>('.lobby-tabs, #panel-host, #panel-join').forEach((e) => {
    e.style.display = 'none';
  });
  const waiting = byId('room-waiting');
  if (waiting) waiting.style.display = 'block';
  setText('room-code-display', S.roomCode ?? '');
  updateLobbyPlayers(players ?? S.lobbyPlayers);
}

export function updateLobbyPlayers(players: readonly LobbyPlayer[]): void {
  S.lobbyPlayers = [...players];

  const list = byId('lobby-player-list');
  // The host is the first seat. With no roster yet (the host's own `host_game`
  // ack arrives before `update_players`) assume host, as the legacy did.
  const isHost = players.length === 0 || players[0]?.id === S.myPlayerId;

  if (list) {
    list.innerHTML = players
      .map(
        (p, i) =>
          `<div class="lp-item">
        <img src="${getPfpUrl(p.avatar || 1)}" alt="" />
        <span class="lp-name">${escapeHtml(p.name)}${p.connected === false ? ' 🔴' : ''}</span>
        ${i === 0 ? '<span class="lp-host">👑 Host</span>' : ''}
      </div>`,
      )
      .join('');
  }

  const btn = byId<HTMLButtonElement>('btn-start-game');
  if (!btn) return;
  if (isHost && players.length >= 2) {
    btn.disabled = false;
    btn.textContent = '▶️ Start Game';
  } else if (isHost) {
    btn.disabled = true;
    btn.textContent = '⏳ Waiting for players...';
  } else {
    btn.disabled = true;
    btn.textContent = '⏳ Waiting for host to start...';
  }
}

// ── Leaving ──

export function startGame(): void {
  if (S.roomCode === null) return;
  socket.emit('start_game', { roomCode: S.roomCode });
}

export function leaveRoom(): void {
  if (S.roomCode !== null) socket.emit('leave_room', { roomCode: S.roomCode });
  resetToLobby();
}

export function leaveGame(): void {
  if (!confirm('Leave the current game? You can rejoin later with the room code.')) return;
  if (S.roomCode !== null) socket.emit('leave_room', { roomCode: S.roomCode });
  const game = byId('game-container');
  const lobby = byId('lobby-screen');
  if (game) game.style.display = 'none';
  if (lobby) lobby.style.display = 'block';
  resetToLobby();
}

/**
 * Returns the UI to a clean lobby. Registered teardown (timers, modals,
 * overlays) runs through `onResetToLobby` hooks so this module does not have to
 * import every feature that owns a timer.
 */
const resetHooks: Array<() => void> = [];

export function onResetToLobby(fn: () => void): void {
  resetHooks.push(fn);
}

export function resetToLobby(): void {
  // Teardown first: a surviving countdown from the abandoned game used to keep
  // firing against a null state after the lobby was already showing.
  for (const fn of resetHooks) fn();

  resetGameState();
  S.myPlayerId = null;
  S.mySelectedTheme = 'plain';
  localStorage.removeItem('bankelhaz_session');

  initThemeSelectors();

  const waiting = byId('room-waiting');
  if (waiting) waiting.style.display = 'none';
  qsa<HTMLElement>('.lobby-tabs, #panel-host, #panel-join').forEach((e) => {
    e.style.display = '';
  });
  setDisabled('btn-host', false);
  setDisabled('btn-join', false);
  updateRoomCodeBadge();
}

/** One-shot session prompt, offered on the first connect only. */
export function offerRejoin(hint: { roomCode: string; playerName: string }): void {
  if (!confirm(`Rejoin "${hint.roomCode}" as ${hint.playerName}?`)) return;
  showToast('🔄 Attempting to rejoin room "' + hint.roomCode + '" as ' + hint.playerName + '...');
  socket.emit('rejoin_game', { roomCode: hint.roomCode, playerName: hint.playerName });
}
