/**
 * Client-side view state — everything the UI needs that is NOT game state.
 *
 * Exported as one mutable object rather than a pile of `export let`, because an
 * ES module's exported bindings are read-only to importers: the legacy code
 * reassigns `gameState`, `roomCode` and `myPlayerId` from a dozen call sites,
 * and that only stays possible through a shared record.
 *
 * Nothing here is authoritative. `S.view` is a projection the server sent; the
 * client never edits it and never invents a field the server did not supply.
 * The legacy script patched `gameState` in place (remapping `pendingX.playerId`
 * after a reconnect, filtering `activeBids` on a timer) which let the rendered
 * board drift from the server's truth — with stable `SeatId`s none of that
 * remapping is needed at all.
 */

import type { SignedSnapshot } from '../shared/events.js';
import type { SeatId, SquareId, UpgradeTier } from '../shared/types.js';
import type { ViewState } from './view-model.js';

/** A lobby row, as `update_players` delivers it. */
export interface LobbyPlayer {
  id: SeatId;
  name: string;
  avatar: number;
  connected: boolean;
}

/**
 * Server-authoritative countdown, kept OUT of game state (bug B29). `max` is the
 * high-water mark for this turn so the progress bar has a denominator; it resets
 * whenever a new turn starts rather than growing forever.
 */
export interface TimerState {
  seconds: number;
  running: boolean;
  max: number;
}

export interface ClientStore {
  myPlayerId: SeatId | null;
  myPlayerName: string;
  roomCode: string | null;
  /** The projected state, already translated by `buildViewState`. */
  view: ViewState | null;
  /** Opaque restore blob; stored and returned verbatim, never parsed (B19). */
  snapshot: SignedSnapshot | null;
  isAnimating: boolean;
  mySelectedAvatar: number;
  mySelectedTheme: string;
  availableThemes: string[];
  lobbyPlayers: LobbyPlayer[];
  logs: string[];
  /** Previous owner per square, to animate only genuine ownership changes. */
  prevOwnership: Record<SquareId, SeatId | null>;
  timer: TimerState;
  /** Whether the one-shot session restore prompt has already been offered. */
  rejoinOffered: boolean;
}

export interface SavedPrefs {
  name?: string;
}

function readAvatar(): number {
  const raw = localStorage.getItem('bankelhaz_avatar');
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function readPrefs(): SavedPrefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('bankelhaz_prefs') ?? '{}');
    if (parsed !== null && typeof parsed === 'object') return parsed as SavedPrefs;
  } catch {
    /* corrupt prefs are not worth a crash on boot */
  }
  return {};
}

export const S: ClientStore = {
  myPlayerId: null,
  myPlayerName: '',
  roomCode: null,
  view: null,
  snapshot: null,
  isAnimating: false,
  mySelectedAvatar: readAvatar(),
  mySelectedTheme: 'plain',
  availableThemes: ['plain'],
  lobbyPlayers: [],
  logs: [],
  prevOwnership: {},
  timer: { seconds: 0, running: false, max: 0 },
  rejoinOffered: false,
};

/** Clears every per-game field. Used by leaveGame / game_over / resetToLobby. */
export function resetGameState(): void {
  S.roomCode = null;
  S.view = null;
  S.snapshot = null;
  S.isAnimating = false;
  S.lobbyPlayers = [];
  S.logs = [];
  S.prevOwnership = {};
  S.timer = { seconds: 0, running: false, max: 0 };
}

// ── Presentation constants ──

/** Index 0 is unused: dice faces are 1-based. */
export const DICE_FACES: readonly string[] = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export const CORNER_ICONS: Readonly<Record<number, string>> = {
  1: '🏁',
  8: '🎰',
  18: '🚌',
  25: '🔒',
};

export const COLOR_BG_MAP: Readonly<Record<string, string>> = {
  purple: '#9b59b6',
  pink: '#ff80ab',
  orange: '#ff9800',
  yellow: '#FFEB3B',
  brown: '#795548',
  green: '#4caf50',
  cyan: '#00bcd4',
  white: '#90a4ae',
  red: '#f44336',
  utility: '#607d8b',
};

/** Exactly the strings the legacy markup rendered — do not translate. */
export const UPGRADE_ICONS: Readonly<Record<UpgradeTier, string>> = {
  garage: '🏗️',
  rest_stop: '🏡',
  market: '🏬',
};

export const UPGRADE_LABELS: Readonly<Record<UpgradeTier, string>> = {
  garage: 'Garage',
  rest_stop: 'Rest Stop',
  market: 'Market',
};

/** `Garage 🏗️` — label plus icon, the form used in the inspect table. */
export function upgradeLabel(tier: UpgradeTier): string {
  return `${UPGRADE_LABELS[tier]} ${UPGRADE_ICONS[tier]}`;
}

export function upgradeIcon(tier: UpgradeTier | null): string {
  return tier === null ? '' : UPGRADE_ICONS[tier];
}

/** Grid class per square id — `p1`…`p34`, sized from the board, not hardcoded. */
export function gridClass(id: SquareId): string {
  return `p${id}`;
}

export const DICE_FACE = (n: number): string => DICE_FACES[n] ?? '?';
