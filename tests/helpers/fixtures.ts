/**
 * Shared test fixtures.
 *
 * SINGLE-AUTHORED on purpose: several engine modules are built in parallel and
 * they all need to construct game state. Without one fixture they would each grow
 * their own, drift, and then disagree about what a "default game" is.
 *
 * If you need a helper that is not here, add it here rather than inlining a
 * bespoke state builder in a test file.
 */

import { createInitialState, setOwner, setUpgrade, playerById } from '../../src/engine/state.js';
import { createRng } from '../../src/engine/rng.js';
import { loadBoard } from '../../src/engine/board.js';
import type { Rng } from '../../src/engine/rng.js';
import type {
  GameConfig,
  GameState,
  Player,
  SeatId,
  SquareId,
  UpgradeTier,
} from '../../src/shared/types.js';

export const SEAT_A = 'seat-a';
export const SEAT_B = 'seat-b';
export const SEAT_C = 'seat-c';
export const SEAT_D = 'seat-d';

export const board = loadBoard();

/** Well-known square ids, resolved from the real data so they cannot drift. */
export const SQ = {
  start: 1,
  jerusalem: 2, // purple, 300, buildCost 250/750/1000, visitorRent 190/900/1550
  gaza: 3, // purple, 250 — the other half of the purple group
  dualDeck: 4, // draws mahkama then hazak
  club: 8,
  mahkamaTrigger: 11,
  hazakTrigger: 13,
  gasStation: 16, // utility: ownable, NOT upgradable
  fastBus: 18,
  prison: 25,
} as const;

export interface MakeStateOptions {
  seats?: readonly SeatId[];
  seed?: number;
  config?: Partial<GameConfig>;
  /** Starting cash shortcut; overrides config.startingCash. */
  cash?: number;
}

export function makeRng(seed = 1): Rng {
  return createRng(seed);
}

/** A fresh game. Defaults to 3 seats, deterministic seed, generous cash. */
export function makeState(opts: MakeStateOptions = {}): GameState {
  const seats = opts.seats ?? [SEAT_A, SEAT_B, SEAT_C];
  const config: Partial<GameConfig> = { ...opts.config };
  if (opts.cash !== undefined) config.startingCash = opts.cash;
  else if (config.startingCash === undefined) config.startingCash = 2000;

  return createInitialState(
    seats.map((id, i) => ({ id, name: `Player ${i + 1}`, avatar: i + 1 })),
    makeRng(opts.seed ?? 1),
    config,
    board,
  );
}

/** Two-seat game — the minimum now that min_players is 2 (B32). */
export function makeDuel(opts: MakeStateOptions = {}): GameState {
  return makeState({ ...opts, seats: [SEAT_A, SEAT_B] });
}

export function p(state: GameState, id: SeatId): Player {
  const player = playerById(state, id);
  if (player === undefined) throw new Error(`fixture: no seat ${id}`);
  return player;
}

/** Give a seat a square, optionally already upgraded. */
export function give(
  state: GameState,
  seatId: SeatId,
  squareId: SquareId,
  upgrade: UpgradeTier | null = null,
): void {
  setOwner(state, squareId, seatId);
  setUpgrade(state, squareId, upgrade);
}

/** Give a seat every square in a colour group — the precondition for upgrading. */
export function giveColorGroup(state: GameState, seatId: SeatId, group: string): SquareId[] {
  const ids = state.board.squares
    .filter((s) => (s.kind === 'property' || s.kind === 'utility') && s.colorGroup === group)
    .map((s) => s.id);
  for (const id of ids) give(state, seatId, id);
  return ids;
}

export function setMoney(state: GameState, seatId: SeatId, money: number): void {
  p(state, seatId).money = money;
}

export function setPosition(state: GameState, seatId: SeatId, squareId: SquareId): void {
  p(state, seatId).position = squareId;
}

/** Make it a seat's turn, regardless of current order. */
export function setTurn(state: GameState, seatId: SeatId): void {
  const idx = state.players.findIndex((pl) => pl.id === seatId);
  if (idx < 0) throw new Error(`fixture: no seat ${seatId}`);
  state.currentPlayerIndex = idx;
}

export function jail(state: GameState, seatId: SeatId, turns = 2): void {
  const player = p(state, seatId);
  player.position = SQ.prison;
  player.statusEffects.missedTurnsRemaining = turns;
}

export function giveJailCards(state: GameState, seatId: SeatId, n: number): void {
  p(state, seatId).inventory.jailFreeCards = n;
}

/**
 * Stack a specific card on top of a deck's draw pile so a test can force it.
 * Uses the real normalised card, so tests exercise real data.
 */
export function stackCard(state: GameState, deck: 'hazak' | 'mahkama', cardId: number): void {
  const pile = state.decks[deck];
  const idx = pile.draw.findIndex((c) => c.id === cardId);
  if (idx < 0) throw new Error(`fixture: card ${cardId} not in ${deck} draw pile`);
  const [card] = pile.draw.splice(idx, 1);
  if (card === undefined) throw new Error('fixture: splice failed');
  pile.draw.push(card); // pop() draws from the end
}

/** Total money held by all players — useful for conservation assertions. */
export function totalMoney(state: GameState): number {
  return state.players.reduce((sum, pl) => sum + pl.money, 0);
}
