import { describe, it, expect } from 'vitest';
import {
  loadBoard,
  loadBoardFrom,
  findSquare,
  requireSquare,
  step,
  advance,
  startSquareId,
  prisonSquare,
  colorGroupSquares,
  isUpgradableSquare,
  BoardDataError,
} from '../../src/engine/board.js';
import type { RawBoard } from '../../src/shared/raw.js';
import type { CornerSquare } from '../../src/shared/types.js';

const board = loadBoard();

describe('board loading', () => {
  it('loads all 34 positions and derives size from data, not a literal (B30)', () => {
    expect(board.size).toBe(34);
    expect(board.squares).toHaveLength(34);
  });

  it('has contiguous ids 1..34', () => {
    const ids = board.squares.map((s) => s.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
  });

  it('reads min_players as 2 (B32)', () => {
    expect(board.meta.minPlayers).toBe(2);
  });

  it('reads pass_go_salary from data', () => {
    expect(board.meta.passGoSalary).toBe(250);
  });
});

describe('corner effects are derived from data, not hardcoded ids', () => {
  const corners = board.squares.filter((s): s is CornerSquare => s.kind === 'corner');

  it('finds exactly one of each effect', () => {
    const effects = corners.map((c) => c.effect).sort();
    expect(effects).toEqual(['club', 'double_next_roll', 'prison', 'salary']);
  });

  it('derives the club from membership_cost/guest_fine_fee', () => {
    const club = corners.find((c) => c.effect === 'club');
    expect(club).toBeDefined();
    expect(club?.id).toBe(8);
    if (club?.effect === 'club') {
      expect(club.membershipCost).toBe(150);
      expect(club.guestFineFee).toBe(20);
    }
  });

  it('derives prison rules from the rules block', () => {
    const prison = prisonSquare(board);
    expect(prison.id).toBe(25);
    expect(prison.maxTurnsToMiss).toBe(2);
    expect(prison.bailCost).toBe(50);
  });

  it('derives the double-roll corner from status_effect', () => {
    const bus = corners.find((c) => c.effect === 'double_next_roll');
    expect(bus?.id).toBe(18);
  });

  it('treats the board origin as start', () => {
    expect(startSquareId(board)).toBe(1);
  });

  it('rejects a corner with no recognisable effect', () => {
    const broken: RawBoard = {
      game_meta: {
        title: 't',
        starting_cash_player: 100,
        pass_go_salary: 10,
        max_players: 6,
        min_players: 2,
      },
      board_positions: [
        { id: 1, name: 'start', type: 'corner_square' },
        { id: 2, name: 'mystery', type: 'corner_square' },
      ],
    };
    expect(() => loadBoardFrom(broken)).toThrow(BoardDataError);
  });
});

describe('property normalisation — the JSON is authoritative', () => {
  it('reads owner_paying as BUILD COST and visitor_paying as RENT on القدس (id 2)', () => {
    const sq = requireSquare(board, 2);
    expect(sq.kind).toBe('property');
    if (sq.kind !== 'property') return;
    expect(sq.purchasePrice).toBe(300);
    expect(sq.baseRent).toBe(35);
    // Costs rise, rents rise faster — a coherent economy, unchanged by this refactor.
    expect(sq.buildCost).toEqual({ garage: 250, rest_stop: 750, market: 1000 });
    expect(sq.visitorRent).toEqual({ garage: 190, rest_stop: 900, market: 1550 });
  });

  it('models محطة بنزين (id 16) as a non-upgradable utility', () => {
    const sq = requireSquare(board, 16);
    expect(sq.kind).toBe('utility');
    // Structural, not a runtime check: it is simply not an UpgradableProperty.
    expect(isUpgradableSquare(sq)).toBe(false);
  });

  it('gives every upgradable property both tier tables', () => {
    const upgradable = board.squares.filter(isUpgradableSquare);
    expect(upgradable).toHaveLength(23);
    for (const sq of upgradable) {
      for (const tier of ['garage', 'rest_stop', 'market'] as const) {
        expect(typeof sq.buildCost[tier]).toBe('number');
        expect(typeof sq.visitorRent[tier]).toBe('number');
      }
    }
  });

  it('groups colours, with utility as a single-member group', () => {
    expect(colorGroupSquares(board, 'utility').map((s) => s.id)).toEqual([16]);
    expect(colorGroupSquares(board, 'purple').map((s) => s.id)).toEqual([2, 3]);
  });
});

describe('deck triggers', () => {
  it('reads deck_type for single triggers', () => {
    const sq = requireSquare(board, 11);
    expect(sq.kind).toBe('deck');
    if (sq.kind === 'deck') expect(sq.deck).toBe('mahkama');
    const hazak = requireSquare(board, 13);
    if (hazak.kind === 'deck') expect(hazak.deck).toBe('hazak');
  });

  it('queues BOTH decks for square 4, mahkama first (B10)', () => {
    const sq = requireSquare(board, 4);
    expect(sq.kind).toBe('dual_deck');
    if (sq.kind === 'dual_deck') expect([...sq.draws]).toEqual(['mahkama', 'hazak']);
  });
});

describe('movement', () => {
  it('wraps forward past the end', () => {
    expect(step(board, 34, 1)).toBe(1);
    expect(step(board, 33, 3)).toBe(2);
  });

  it('wraps backward below the start', () => {
    expect(step(board, 1, -1)).toBe(34);
    expect(step(board, 2, -5)).toBe(31);
  });

  it('reports passedGo when forward movement completes a lap', () => {
    const r = advance(board, 30, 6);
    expect(r.to).toBe(2);
    expect(r.passedGo).toBe(true);
  });

  it('counts landing EXACTLY on the origin as passing go, once (B04)', () => {
    const r = advance(board, 30, 5);
    expect(r.to).toBe(1);
    expect(r.passedGo).toBe(true);
  });

  it('does not report passedGo for a move that stays within the lap', () => {
    const r = advance(board, 1, 33);
    expect(r.to).toBe(34);
    expect(r.passedGo).toBe(false);
  });

  it('NEVER reports passedGo for backward movement, even when the id increases (B04)', () => {
    const r = advance(board, 2, -5);
    expect(r.to).toBe(31);
    // Old rule was `newPos < oldPos`; 31 < 2 is false here, but the inverse case
    // (a backward move landing on a lower id) wrongly satisfied it.
    expect(r.passedGo).toBe(false);
    const back = advance(board, 10, -4);
    expect(back.to).toBe(6);
    expect(back.passedGo).toBe(false);
  });

  it('produces a step-by-step path of the right length', () => {
    const r = advance(board, 32, 4);
    expect(r.path).toEqual([33, 34, 1, 2]);
    expect(r.to).toBe(2);
  });

  it('produces a reversed path for backward movement', () => {
    const r = advance(board, 2, -3);
    expect(r.path).toEqual([1, 34, 33]);
  });

  it('treats a full lap as landing back on the origin having passed go', () => {
    const r = advance(board, 1, 34);
    expect(r.to).toBe(1);
    expect(r.passedGo).toBe(true);
  });
});

describe('lookup', () => {
  it('returns undefined for an unknown id but throws in require', () => {
    expect(findSquare(board, 99)).toBeUndefined();
    expect(() => requireSquare(board, 99)).toThrow(BoardDataError);
  });
});
