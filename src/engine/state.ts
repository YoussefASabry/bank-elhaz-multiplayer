/**
 * State factory and accessors.
 *
 * Separate from the reducer (src/engine/index.ts) so that property/cards/turn can
 * be built and tested against real state without the reducer existing yet.
 *
 * Ownership lives OUTSIDE the board. The old code did
 * `boardData.board_positions.map(sq => ({ ...sq, owner: null }))` — a shallow
 * spread, which meant every room's game state shared the SAME nested
 * `visitor_paying` / `owner_paying` objects as the module-level JSON import.
 * Nothing mutated them, so it never bit, but it was one careless write away from
 * corrupting every concurrent room's rent tables. Keeping the board immutable and
 * ownership in its own map removes that hazard entirely.
 */

import { loadBoard, isOwnable } from './board.js';
import { createDecks } from './deck.js';
import { DEFAULT_TURN_TIMEOUT_SECONDS, RENT_TURN_TIMEOUT_SECONDS } from '../shared/rules.js';
import type { Rng } from './rng.js';
import type {
  Board,
  GameConfig,
  GameState,
  OwnableSquare,
  Player,
  SeatId,
  Square,
  SquareId,
  SquareOwnership,
  UpgradeTier,
} from '../shared/types.js';

export interface SeatInput {
  id: SeatId;
  name: string;
  avatar?: number;
  connected?: boolean;
}

export function defaultConfig(board: Board, overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    startingCash: board.meta.startingCash,
    passGoSalary: board.meta.passGoSalary,
    diceCount: 2,
    moneyVisible: true,
    tradeTiming: 'anytime',
    onBankruptcy: 'eliminate',
    turnTimeoutSeconds: DEFAULT_TURN_TIMEOUT_SECONDS,
    rentTurnTimeoutSeconds: RENT_TURN_TIMEOUT_SECONDS,
    ...overrides,
  };
}

export function createPlayer(seat: SeatInput, startingCash: number, startPosition: SquareId): Player {
  return {
    id: seat.id,
    name: seat.name,
    avatar: seat.avatar ?? 1,
    position: startPosition,
    money: startingCash,
    inventory: { freeCards: 0, jailFreeCards: 0 },
    statusEffects: {
      payHalfRentNextLanding: false,
      doubleNextRoll: false,
      missedTurnsRemaining: 0,
      skipNextTurn: false,
    },
    isClubMember: false,
    isBankrupt: false,
    eliminated: false,
    connected: seat.connected ?? true,
  };
}

export function createInitialState(
  seats: readonly SeatInput[],
  rng: Rng,
  configOverrides: Partial<GameConfig> = {},
  board: Board = loadBoard(),
): GameState {
  const config = defaultConfig(board, configOverrides);
  const startId = board.squares[0]?.id ?? 1;

  const ownership: Record<SquareId, SquareOwnership> = {};
  for (const sq of board.squares) {
    if (isOwnable(sq)) ownership[sq.id] = { owner: null, upgrade: null };
  }

  return {
    config,
    board,
    ownership,
    players: seats.map((s) => createPlayer(s, config.startingCash, startId)),
    hostId: seats[0]?.id ?? null,
    currentPlayerIndex: 0,
    turnNumber: 1,
    phase: 'roll',
    pending: { kind: 'none' },
    decks: createDecks(rng),
    lastRoll: null,
    trades: [],
    bids: [],
    gameOver: false,
    winnerId: null,
    stateVersion: 0,
  };
}

// ── Player accessors ──

export function currentPlayer(state: GameState): Player | undefined {
  return state.players[state.currentPlayerIndex];
}

export function playerById(state: GameState, id: SeatId): Player | undefined {
  return state.players.find((p) => p.id === id);
}

export function requirePlayer(state: GameState, id: SeatId): Player {
  const p = playerById(state, id);
  if (p === undefined) throw new Error(`No player with id ${id}`);
  return p;
}

/** Players who can still take turns (not bankrupt, not kicked). */
export function activePlayers(state: GameState): Player[] {
  return state.players.filter((p) => !p.isBankrupt && !p.eliminated);
}

export function isCurrent(state: GameState, id: SeatId): boolean {
  return currentPlayer(state)?.id === id;
}

export function isInPrison(player: Player): boolean {
  return player.statusEffects.missedTurnsRemaining > 0;
}

// ── Ownership accessors ──

export function ownershipOf(state: GameState, id: SquareId): SquareOwnership | undefined {
  return state.ownership[id];
}

export function ownerOf(state: GameState, id: SquareId): SeatId | null {
  return state.ownership[id]?.owner ?? null;
}

export function upgradeOf(state: GameState, id: SquareId): UpgradeTier | null {
  return state.ownership[id]?.upgrade ?? null;
}

export function setOwner(state: GameState, id: SquareId, owner: SeatId | null): void {
  const rec = state.ownership[id];
  if (rec === undefined) throw new Error(`Square ${id} is not ownable`);
  rec.owner = owner;
}

export function setUpgrade(state: GameState, id: SquareId, tier: UpgradeTier | null): void {
  const rec = state.ownership[id];
  if (rec === undefined) throw new Error(`Square ${id} is not ownable`);
  rec.upgrade = tier;
}

/** Square ids owned by a seat, in board order. */
export function ownedBy(state: GameState, seatId: SeatId): SquareId[] {
  return state.board.squares.filter((sq) => ownerOf(state, sq.id) === seatId).map((sq) => sq.id);
}

export function ownedSquares(state: GameState, seatId: SeatId): OwnableSquare[] {
  return state.board.squares.filter(
    (sq): sq is OwnableSquare => isOwnable(sq) && ownerOf(state, sq.id) === seatId,
  );
}

/** Release every square held by a seat — used on bankruptcy and on kick. */
export function releaseAll(state: GameState, seatId: SeatId): SquareId[] {
  const released: SquareId[] = [];
  for (const sq of state.board.squares) {
    const rec = state.ownership[sq.id];
    if (rec !== undefined && rec.owner === seatId) {
      rec.owner = null;
      rec.upgrade = null;
      released.push(sq.id);
    }
  }
  return released;
}

export function squareAt(state: GameState, id: SquareId): Square | undefined {
  return state.board.squares.find((s) => s.id === id);
}

/** Does this seat own every square in the colour group? Required to upgrade. */
export function ownsFullColorGroup(state: GameState, seatId: SeatId, group: string): boolean {
  const group_ = state.board.squares.filter((s): s is OwnableSquare => isOwnable(s) && s.colorGroup === group);
  if (group_.length === 0) return false;
  return group_.every((s) => ownerOf(state, s.id) === seatId);
}

// ── Money ──

/**
 * Move money and report the real delta. Payment is capped at what the payer has,
 * so a player can reach exactly 0 but never silently go negative from a transfer.
 * Insolvency is decided by bankruptcy.ts, not here.
 */
export function transfer(from: Player, to: Player | null, requested: number): number {
  const amount = Math.max(0, Math.min(requested, from.money));
  from.money -= amount;
  if (to !== null && !to.isBankrupt) to.money += amount;
  return amount;
}

export function credit(player: Player, amount: number): void {
  player.money += amount;
}

export function debit(player: Player, amount: number): void {
  player.money -= amount;
}
