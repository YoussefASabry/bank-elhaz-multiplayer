/**
 * Board loading, validation and movement.
 *
 * Corner effects are derived from the DATA (`membership_cost`, `status_effect`,
 * `rules`) instead of `switch (square.id) { case 8: case 18: case 25: }`, which is
 * what both old engines did. The one concession is the start square: the JSON
 * carries no marker for it, so the board ORIGIN (lowest id) is treated as start.
 * That is a principled rule rather than a magic number, and `validateBoard`
 * asserts there is exactly one of each special corner, so a data typo fails loudly
 * at load instead of silently disabling prison.
 */

import boardJson from '../../data/board.json' with { type: 'json' };
import type { RawBoard, RawSquare, RawUpgradableProperty } from '../shared/raw.js';
import type {
  Board,
  CornerSquare,
  GameMeta,
  Square,
  SquareId,
  UpgradeTier,
  OwnableSquare,
  UpgradableProperty,
} from '../shared/types.js';

export class BoardDataError extends Error {}

const TIER_KEYS: Record<UpgradeTier, 'garage_rent' | 'rest_stop_rent' | 'market_rent'> = {
  garage: 'garage_rent',
  rest_stop: 'rest_stop_rent',
  market: 'market_rent',
};

function isUpgradable(raw: RawSquare): raw is RawUpgradableProperty {
  return raw.type === 'property' && 'visitor_paying' in raw && raw.visitor_paying !== undefined;
}

function tierTable(
  src: { garage_rent: number; rest_stop_rent: number; market_rent: number },
): Record<UpgradeTier, number> {
  return {
    garage: src[TIER_KEYS.garage],
    rest_stop: src[TIER_KEYS.rest_stop],
    market: src[TIER_KEYS.market],
  };
}

function normaliseCorner(raw: Extract<RawSquare, { type: 'corner_square' }>, isOrigin: boolean): CornerSquare {
  const base = { id: raw.id, name: raw.name, kind: 'corner' as const } as const;
  const withDesc = raw.description === undefined ? base : { ...base, description: raw.description };

  if (raw.membership_cost !== undefined && raw.guest_fine_fee !== undefined) {
    return { ...withDesc, effect: 'club', membershipCost: raw.membership_cost, guestFineFee: raw.guest_fine_fee };
  }
  if (raw.rules !== undefined) {
    return {
      ...withDesc,
      effect: 'prison',
      maxTurnsToMiss: raw.rules.max_turns_to_miss,
      bailCost: raw.rules.bail_cost,
    };
  }
  if (raw.status_effect !== undefined) {
    return { ...withDesc, effect: 'double_next_roll' };
  }
  if (isOrigin) {
    return { ...withDesc, effect: 'salary' };
  }
  throw new BoardDataError(
    `Corner square ${raw.id} ("${raw.name}") has no recognisable effect: it is not the ` +
      `board origin and carries none of membership_cost / rules / status_effect.`,
  );
}

function normaliseSquare(raw: RawSquare, isOrigin: boolean): Square {
  switch (raw.type) {
    case 'property': {
      if (isUpgradable(raw)) {
        return {
          kind: 'property',
          id: raw.id,
          name: raw.name,
          colorGroup: raw.color_group,
          purchasePrice: raw.purchase_price,
          baseRent: raw.base_rent,
          // owner_paying is the BUILD COST table; visitor_paying is the RENT table.
          buildCost: tierTable(raw.owner_paying),
          visitorRent: tierTable(raw.visitor_paying),
        };
      }
      return {
        kind: 'utility',
        id: raw.id,
        name: raw.name,
        colorGroup: raw.color_group,
        purchasePrice: raw.purchase_price,
        baseRent: raw.base_rent,
      };
    }
    case 'corner_square':
      return normaliseCorner(raw, isOrigin);
    case 'deck_trigger':
      return { kind: 'deck', id: raw.id, name: raw.name, deck: raw.deck_type };
    case 'dual_deck_trigger': {
      const base = { kind: 'dual_deck' as const, id: raw.id, name: raw.name, draws: ['mahkama', 'hazak'] as const };
      return raw.description === undefined ? base : { ...base, description: raw.description };
    }
    default: {
      const never: never = raw;
      throw new BoardDataError(`Unknown square type: ${JSON.stringify(never)}`);
    }
  }
}

function normaliseMeta(raw: RawBoard['game_meta']): GameMeta {
  return {
    title: raw.title,
    startingCash: raw.starting_cash_player,
    passGoSalary: raw.pass_go_salary,
    maxPlayers: raw.max_players,
    minPlayers: raw.min_players,
  };
}

export function validateBoard(board: Board): void {
  const { squares } = board;
  if (squares.length === 0) throw new BoardDataError('Board has no positions.');

  const ids = squares.map((s) => s.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new BoardDataError('Board has duplicate square ids.');

  const sorted = [...ids].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      throw new BoardDataError(`Board ids must be contiguous 1..${sorted.length}; got a gap at ${i + 1}.`);
    }
  }

  const corners = squares.filter((s): s is CornerSquare => s.kind === 'corner');
  const count = (effect: CornerSquare['effect']): number => corners.filter((c) => c.effect === effect).length;
  for (const effect of ['salary', 'club', 'double_next_roll', 'prison'] as const) {
    const n = count(effect);
    if (n !== 1) {
      throw new BoardDataError(`Expected exactly one corner with effect "${effect}", found ${n}.`);
    }
  }
  if (board.meta.minPlayers < 2) throw new BoardDataError('min_players must be at least 2.');
  if (board.meta.maxPlayers < board.meta.minPlayers) {
    throw new BoardDataError('max_players must be >= min_players.');
  }
}

export function loadBoardFrom(raw: RawBoard): Board {
  const positions = raw.board_positions;
  if (positions.length === 0) throw new BoardDataError('board_positions is empty.');
  const originId = positions.reduce((min, s) => (s.id < min ? s.id : min), positions[0]!.id);

  const board: Board = {
    meta: normaliseMeta(raw.game_meta),
    squares: positions.map((raw2) => normaliseSquare(raw2, raw2.id === originId)),
    size: positions.length,
  };
  validateBoard(board);
  return board;
}

/** The board as shipped in data/board.json. */
export function loadBoard(): Board {
  return loadBoardFrom(boardJson as unknown as RawBoard);
}

// ── Lookup ──

export function findSquare(board: Board, id: SquareId): Square | undefined {
  return board.squares.find((s) => s.id === id);
}

/** Throws rather than returning undefined; use where a missing square is a bug. */
export function requireSquare(board: Board, id: SquareId): Square {
  const sq = findSquare(board, id);
  if (sq === undefined) throw new BoardDataError(`No square with id ${id}.`);
  return sq;
}

export function isOwnable(square: Square): square is OwnableSquare {
  return square.kind === 'property' || square.kind === 'utility';
}

export function isUpgradableSquare(square: Square): square is UpgradableProperty {
  return square.kind === 'property';
}

export function startSquareId(board: Board): SquareId {
  const start = board.squares.find((s) => s.kind === 'corner' && s.effect === 'salary');
  if (start === undefined) throw new BoardDataError('Board has no start square.');
  return start.id;
}

export function prisonSquare(board: Board): Extract<CornerSquare, { effect: 'prison' }> {
  const sq = board.squares.find(
    (s): s is Extract<CornerSquare, { effect: 'prison' }> => s.kind === 'corner' && s.effect === 'prison',
  );
  if (sq === undefined) throw new BoardDataError('Board has no prison square.');
  return sq;
}

// ── Movement ──

/** Wrap a position by `steps`, which may be negative. Never reports pass-go. */
export function step(board: Board, from: SquareId, steps: number): SquareId {
  const size = board.size;
  return (((from - 1 + steps) % size) + size) % size + 1;
}

export interface Advance {
  to: SquareId;
  /** True only when FORWARD movement wrapped past the origin. */
  passedGo: boolean;
  path: SquareId[];
}

/**
 * Move `steps` forward (or backward if negative) and report whether the origin
 * was crossed.
 *
 * The old rule was `passedGo = newPos < oldPos`, which is wrong in two ways:
 * a BACKWARD move that wraps below 1 lands on a higher id and is missed, while a
 * backward move that merely lands lower is not a pass at all yet satisfied the
 * comparison in the paths that used it. Landing exactly on the origin also
 * double-counted, because the corner handler paid the salary a second time
 * (bug B04). Here pass-go is computed from the arithmetic — forward travel whose
 * cumulative offset reaches or exceeds one lap — and the caller credits it once.
 */
export function advance(board: Board, from: SquareId, steps: number): Advance {
  const size = board.size;
  const to = step(board, from, steps);
  const path: SquareId[] = [];
  const dir = steps >= 0 ? 1 : -1;
  let cursor = from;
  for (let i = 0; i < Math.abs(steps); i++) {
    cursor = step(board, cursor, dir);
    path.push(cursor);
  }
  const passedGo = steps > 0 && from - 1 + steps >= size;
  return { to, passedGo, path };
}

/**
 * Teleport. Never credits salary implicitly — cards that should pay for landing on
 * the start square do it via the start square's own effect, exactly once.
 */
export function teleport(board: Board, to: SquareId): SquareId {
  requireSquare(board, to);
  return to;
}

export function colorGroupSquares(board: Board, group: string): OwnableSquare[] {
  return board.squares.filter((s): s is OwnableSquare => isOwnable(s) && s.colorGroup === group);
}
