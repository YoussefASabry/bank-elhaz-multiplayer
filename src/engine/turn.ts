/**
 * Turn orchestration: rolling, landing evaluation, turn handover, prison.
 *
 * THE SALARY RULE (B04). Pass-Go pays EXACTLY ONCE per arrival at or through the
 * origin, and it is credited by the MOVEMENT path only:
 *   - dice movement  -> `advance().passedGo`, which is true both for crossing the
 *                       origin and for landing exactly on it
 *   - card teleport  -> credited iff the destination IS the origin
 * The origin square's `salary` corner effect therefore pays NOTHING; it is purely
 * the marker that identifies which square is the origin. The old code credited in
 * BOTH places, so landing exactly on square 1 paid twice
 * (roomManager.js:277 + gameEngine.js:316).
 *
 * Landing evaluation is centralised here, which is why cards.ts must not evaluate
 * landings itself — it moves the player and signals `needsLandingEval`, and this
 * module decides what the destination means.
 */

import { advance, isOwnable, isUpgradableSquare, prisonSquare, startSquareId, requireSquare } from './board.js';
import { rollDice } from './dice.js';
import { calculateRent, getUpgradeOptions } from './property.js';
import { checkGameOver, checkInsolvency } from './bankruptcy.js';
import { credit, currentPlayer, debit, isInPrison, ownerOf, requirePlayer, squareAt } from './state.js';
import type { DomainEvent, RejectReason } from '../shared/actions.js';
import type { GameState, LastRoll, Pending, Phase, SeatId, SquareId } from '../shared/types.js';
import { isActive } from '../shared/types.js';
import type { Rng } from './rng.js';

export type TurnResult = { ok: true; events: DomainEvent[] } | { ok: false; reason: RejectReason };

/** The resting phase implied by a pending slot. Keeps phase and pending in lockstep. */
export function phaseForPending(pending: Pending): Phase {
  switch (pending.kind) {
    case 'none':
      return 'roll';
    case 'property_buy':
      return 'property_choice';
    case 'rent':
      return 'rent_payment';
    case 'club':
      return 'club_choice';
    case 'upgrade':
      return 'upgrade_choice';
    case 'deck_draw':
      return 'draw_card';
    case 'blind_card':
      return 'blind_card';
    case 'card_choice':
      return 'card_choice';
    default: {
      const never: never = pending;
      throw new Error(`Unhandled pending kind: ${JSON.stringify(never)}`);
    }
  }
}

/** Credit the pass-go salary. The single place that does. */
function paySalary(state: GameState, seatId: SeatId, events: DomainEvent[]): void {
  const player = requirePlayer(state, seatId);
  credit(player, state.config.passGoSalary);
  events.push({ type: 'PASSED_GO', playerId: seatId, amount: state.config.passGoSalary });
  events.push({
    type: 'MONEY_CHANGED',
    playerId: seatId,
    delta: state.config.passGoSalary,
    balance: player.money,
    reason: 'pass_go',
  });
}

/**
 * Roll and move. Rejects while jailed (B05) — the old timeout path rolled and
 * moved prisoners because `computeRoll` never checked `missedTurnsRemaining`.
 */
export function resolveRoll(state: GameState, seatId: SeatId, rng: Rng): TurnResult {
  const player = requirePlayer(state, seatId);
  if (!isActive(player)) return { ok: false, reason: 'player_inactive' };
  if (isInPrison(player)) return { ok: false, reason: 'in_prison' };

  const events: DomainEvent[] = [];
  const roll = rollDice(rng, state.config.diceCount);

  let steps = roll.total;
  let doubleApplied = false;
  if (player.statusEffects.doubleNextRoll) {
    steps *= 2;
    player.statusEffects.doubleNextRoll = false;
    doubleApplied = true;
  }

  const from = player.position;
  const moved = advance(state.board, from, steps);
  player.position = moved.to;

  const lastRoll: LastRoll = {
    playerId: seatId,
    die1: roll.die1,
    die2: roll.die2 ?? 0,
    total: roll.total,
    steps,
    from,
    to: moved.to,
    path: moved.path,
    passedGo: moved.passedGo,
    doubleApplied,
  };
  state.lastRoll = lastRoll;
  state.phase = 'rolling';

  events.push({
    type: 'DICE_ROLLED',
    playerId: seatId,
    die1: roll.die1,
    die2: roll.die2 ?? 0,
    total: roll.total,
    steps,
    doubleApplied,
  });
  events.push({ type: 'MOVED', playerId: seatId, from, to: moved.to, teleported: false });
  if (moved.passedGo) paySalary(state, seatId, events);

  return { ok: true, events };
}

/**
 * Move a player by teleport (card effect) and credit salary iff they arrived at
 * the origin. Used by the reducer after a card sets a position.
 */
export function applyTeleport(state: GameState, seatId: SeatId, to: SquareId): DomainEvent[] {
  const player = requirePlayer(state, seatId);
  const from = player.position;
  requireSquare(state.board, to);
  player.position = to;

  const events: DomainEvent[] = [{ type: 'MOVED', playerId: seatId, from, to, teleported: true }];
  if (to === startSquareId(state.board)) paySalary(state, seatId, events);
  return events;
}

/**
 * Decide what the player's current square means, installing the pending slot the
 * UI needs. Does NOT advance the turn; the caller finishes.
 */
export function evaluateLanding(state: GameState, seatId: SeatId): DomainEvent[] {
  const player = requirePlayer(state, seatId);
  const square = squareAt(state, player.position);
  const events: DomainEvent[] = [];
  if (square === undefined) return events;

  if (isOwnable(square)) {
    const owner = ownerOf(state, square.id);

    if (owner === null) {
      if (player.money >= square.purchasePrice) {
        state.pending = { kind: 'property_buy', playerId: seatId, squareId: square.id };
      }
      return events;
    }

    if (owner === seatId) {
      if (isUpgradableSquare(square)) {
        const options = getUpgradeOptions(state, seatId, square.id);
        if (options.length > 0) {
          state.pending = { kind: 'upgrade', playerId: seatId, squareId: square.id, options };
        }
      }
      return events;
    }

    const amount = calculateRent(state, square.id, seatId);
    state.pending = { kind: 'rent', playerId: seatId, ownerId: owner, amount, squareId: square.id };
    events.push({ type: 'RENT_DUE', playerId: seatId, ownerId: owner, amount, squareId: square.id });
    return events;
  }

  switch (square.kind) {
    case 'corner':
      switch (square.effect) {
        case 'salary':
          // Deliberately nothing: the movement path already paid (B04).
          return events;
        case 'club':
          if (player.isClubMember) return events;
          state.pending = {
            kind: 'club',
            playerId: seatId,
            membershipCost: square.membershipCost,
            guestFineFee: square.guestFineFee,
          };
          return events;
        case 'double_next_roll':
          player.statusEffects.doubleNextRoll = true;
          events.push({ type: 'DOUBLE_NEXT_ROLL_GRANTED', playerId: seatId });
          return events;
        case 'prison':
          player.statusEffects.missedTurnsRemaining = square.maxTurnsToMiss;
          events.push({ type: 'JAILED', playerId: seatId, turnsToMiss: square.maxTurnsToMiss });
          return events;
        default: {
          const never: never = square;
          throw new Error(`Unhandled corner: ${JSON.stringify(never)}`);
        }
      }
    case 'deck':
      state.pending = { kind: 'deck_draw', playerId: seatId, queue: [square.deck], squareName: square.name };
      return events;
    case 'dual_deck':
      // Both decks, mahkama first (B10 — online only ever drew one).
      state.pending = { kind: 'deck_draw', playerId: seatId, queue: [...square.draws], squareName: square.name };
      return events;
    default:
      return events;
  }
}

/**
 * End the current action. If something is still pending, park in its phase;
 * otherwise hand the turn over.
 */
export function finishTurn(state: GameState): DomainEvent[] {
  if (state.gameOver) return [];
  if (state.pending.kind !== 'none') {
    const phase = phaseForPending(state.pending);
    const events: DomainEvent[] = [];
    if (state.phase !== phase) {
      events.push({ type: 'PHASE_CHANGED', from: state.phase, to: phase });
      state.phase = phase;
    }
    return events;
  }
  return advanceTurn(state);
}

/**
 * Hand the turn to the next eligible player.
 *
 * Single bounded loop with a post-condition (B28). The old version recursed for
 * `skipNextTurn` with no depth guard, and its bankrupt-skip `do/while` could exit
 * WITH `currentPlayerIndex` still pointing at a bankrupt player once `tries` ran
 * out. Players in prison are NOT skipped here — they take their turn and choose
 * skip/bail/jail-free, which is what the prison UI is for.
 */
export function advanceTurn(state: GameState): DomainEvent[] {
  const events: DomainEvent[] = [];
  events.push(...checkGameOver(state));
  if (state.gameOver) return events;

  const count = state.players.length;
  let index = state.currentPlayerIndex;
  let found = -1;

  for (let i = 0; i < count * 2; i++) {
    index = (index + 1) % count;
    const candidate = state.players[index];
    if (candidate === undefined || !isActive(candidate)) continue;
    if (candidate.statusEffects.skipNextTurn) {
      candidate.statusEffects.skipNextTurn = false;
      events.push({ type: 'TURN_SKIPPED', playerId: candidate.id, reason: 'skip_next_turn' });
      continue;
    }
    found = index;
    break;
  }

  if (found === -1) {
    // Everyone eligible was skipped or inactive; the game cannot continue.
    events.push(...checkGameOver(state));
    if (!state.gameOver) {
      state.gameOver = true;
      state.phase = 'game_over';
      state.winnerId = null;
      events.push({ type: 'GAME_OVER', winnerId: null });
    }
    return events;
  }

  state.currentPlayerIndex = found;
  state.turnNumber += 1;
  state.pending = { kind: 'none' };
  state.phase = 'roll';
  state.lastRoll = null;

  const next = state.players[found];
  if (next === undefined) throw new Error('advanceTurn post-condition failed: no player at chosen index');
  if (!isActive(next)) throw new Error('advanceTurn post-condition failed: chose an inactive player');

  events.push({ type: 'TURN_STARTED', playerId: next.id, turnNumber: state.turnNumber });
  return events;
}

// ── Prison ──

/** Serve one turn. Frees the player at zero, letting them roll this same turn. */
export function skipPrisonTurn(state: GameState, seatId: SeatId): TurnResult {
  const player = requirePlayer(state, seatId);
  if (!isInPrison(player)) return { ok: false, reason: 'nothing_pending' };

  player.statusEffects.missedTurnsRemaining -= 1;
  const remaining = player.statusEffects.missedTurnsRemaining;
  const events: DomainEvent[] = [{ type: 'PRISON_TURN_SKIPPED', playerId: seatId, remaining }];

  if (remaining <= 0) {
    events.push({ type: 'RELEASED_FROM_JAIL', playerId: seatId, via: 'served' });
    state.phase = 'roll';
    return { ok: true, events };
  }

  events.push(...advanceTurn(state));
  return { ok: true, events };
}

export function payBail(state: GameState, seatId: SeatId): TurnResult {
  const player = requirePlayer(state, seatId);
  if (!isInPrison(player)) return { ok: false, reason: 'nothing_pending' };

  const cost = prisonSquare(state.board).bailCost;
  if (player.money < cost) return { ok: false, reason: 'insufficient_funds' };

  debit(player, cost);
  player.statusEffects.missedTurnsRemaining = 0;
  state.phase = 'roll';

  const events: DomainEvent[] = [
    { type: 'MONEY_CHANGED', playerId: seatId, delta: -cost, balance: player.money, reason: 'bail' },
    { type: 'RELEASED_FROM_JAIL', playerId: seatId, via: 'bail' },
  ];
  events.push(...checkInsolvency(state, seatId));
  return { ok: true, events };
}

/** B03: this path existed on the engine but had no server handler at all. */
export function useJailFreeCard(state: GameState, seatId: SeatId): TurnResult {
  const player = requirePlayer(state, seatId);
  if (!isInPrison(player)) return { ok: false, reason: 'nothing_pending' };
  if (player.inventory.jailFreeCards <= 0) return { ok: false, reason: 'no_jail_free_card' };

  player.inventory.jailFreeCards -= 1;
  player.statusEffects.missedTurnsRemaining = 0;
  state.phase = 'roll';
  return {
    ok: true,
    events: [{ type: 'RELEASED_FROM_JAIL', playerId: seatId, via: 'jail_free_card' }],
  };
}

/** Whose turn it is, for the reducer's authorization checks. */
export function turnHolder(state: GameState): SeatId | undefined {
  return currentPlayer(state)?.id;
}
