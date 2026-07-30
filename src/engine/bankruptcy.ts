/**
 * Insolvency and game-over — ONE model (B21).
 *
 * The old code had two contradictory ones: `checkLiquidation` set
 * `isBankrupt = true` and released properties, while server.js:190 and :221 set
 * `isBankrupt = FALSE` and sent the player to jail for 5 turns instead. Whichever
 * ran last won, so game-over detection was unreliable — a "bankrupt" player could
 * still be holding a turn.
 *
 * Here it is a single house rule, `config.onBankruptcy`:
 *   'eliminate' — out of the game (classic)
 *   'jail'      — assets stripped, 5 turns in prison, stays in the game
 * Both paths run through this module and nowhere else.
 */

import { prisonSquare } from './board.js';
import { activePlayers, releaseAll, requirePlayer } from './state.js';
import type { DomainEvent } from '../shared/actions.js';
import type { GameState, SeatId } from '../shared/types.js';

/** Turns spent in prison when the 'jail' rule fires instead of elimination. */
const JAIL_RULE_TURNS = 5;

/**
 * Settle a player whose balance went negative. No-op when solvent.
 * Call this after ANY debit — rent, fine, repairs, upgrade, bail.
 */
export function checkInsolvency(state: GameState, seatId: SeatId): DomainEvent[] {
  const player = requirePlayer(state, seatId);
  if (player.isBankrupt || player.eliminated) return [];
  if (player.money >= 0) return [];

  const events: DomainEvent[] = [];
  releaseAll(state, seatId);
  player.money = 0;

  if (state.config.onBankruptcy === 'jail') {
    const prison = prisonSquare(state.board);
    player.position = prison.id;
    player.statusEffects.missedTurnsRemaining = JAIL_RULE_TURNS;
    player.inventory.jailFreeCards = 0;
    events.push({ type: 'BANKRUPT', playerId: seatId, rule: 'jail' });
    events.push({ type: 'JAILED', playerId: seatId, turnsToMiss: JAIL_RULE_TURNS });
    return events;
  }

  player.isBankrupt = true;
  player.inventory.jailFreeCards = 0;
  player.inventory.freeCards = 0;
  player.statusEffects.missedTurnsRemaining = 0;
  player.statusEffects.skipNextTurn = false;
  events.push({ type: 'BANKRUPT', playerId: seatId, rule: 'eliminate' });
  events.push(...checkGameOver(state));
  return events;
}

/** Host kicked a player. Never splices the array — that shifted turn order (B06). */
export function kickPlayer(state: GameState, targetId: SeatId, by: SeatId): DomainEvent[] {
  const player = requirePlayer(state, targetId);
  if (player.eliminated) return [];

  const events: DomainEvent[] = [];
  const remaining = activePlayers(state).filter((pl) => pl.id !== targetId);
  if (remaining.length > 0 && player.money > 0) {
    const share = Math.floor(player.money / remaining.length);
    for (const pl of remaining) pl.money += share;
  }
  player.money = 0;
  releaseAll(state, targetId);
  player.eliminated = true;
  player.statusEffects.missedTurnsRemaining = 0;
  player.statusEffects.skipNextTurn = false;

  events.push({ type: 'PLAYER_KICKED', playerId: targetId, by });
  events.push(...checkGameOver(state));
  return events;
}

/** Last player standing wins. Sets the terminal phase so no action is accepted after. */
export function checkGameOver(state: GameState): DomainEvent[] {
  if (state.gameOver) return [];
  const active = activePlayers(state);
  if (active.length > 1) return [];

  state.gameOver = true;
  state.phase = 'game_over';
  state.pending = { kind: 'none' };
  state.winnerId = active[0]?.id ?? null;
  return [{ type: 'GAME_OVER', winnerId: state.winnerId }];
}
