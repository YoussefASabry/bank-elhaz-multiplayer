/**
 * Server-side projection of GameState for a specific viewer (plan §Phase 4,
 * bug B23).
 *
 * The old client enforced `moneyVisible` in `updateUI` while the server
 * broadcast everyone's balances — any client could read them from the wire.
 * Here the server strips:
 *
 *   - other players' `money` when `moneyVisible === false`;
 *   - deck CONTENTS entirely (only draw/discard counts are sent — sending the
 *     draw pile leaks future cards);
 *   - the actual card in a `blind_card` pending for everyone except the drawing
 *     player, who is replaced by an opaque `blind_card_hidden` marker.
 *
 * Everything else (board, ownership, phase, pending, trades, bids, lastRoll)
 * is public by design — the old game rendered all of it and the client needs it.
 */
import type { ClientState, DeckCounts, PublicPlayer, PendingView } from '../shared/events.js';
import type { GameState, Pending, SeatId, SquareId } from '../shared/types.js';

function projectPending(pending: Pending, viewerId: SeatId): PendingView {
  if (pending.kind === 'blind_card' && pending.playerId !== viewerId) {
    return {
      kind: 'blind_card_hidden',
      playerId: pending.playerId,
      cardNumber: pending.cardNumber,
      totalCards: pending.totalCards,
    };
  }
  return pending;
}

function deckCounts(state: GameState, deck: 'hazak' | 'mahkama'): DeckCounts {
  return {
    drawCount: state.decks[deck].draw.length,
    discardCount: state.decks[deck].discard.length,
  };
}

function projectPlayers(state: GameState, viewerId: SeatId): PublicPlayer[] {
  const visible = state.config.moneyVisible;
  return state.players.map((p) => ({
    ...p,
    money: visible || p.id === viewerId ? p.money : null,
  }));
}

/** The state a given seat is allowed to see. */
export function projectFor(state: GameState, viewerId: SeatId): ClientState {
  return {
    config: state.config,
    board: state.board,
    ownership: state.ownership as Record<SquareId, import('../shared/types.js').SquareOwnership>,
    players: projectPlayers(state, viewerId),
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    pending: projectPending(state.pending, viewerId),
    decks: { hazak: deckCounts(state, 'hazak'), mahkama: deckCounts(state, 'mahkama') },
    lastRoll: state.lastRoll,
    trades: state.trades,
    bids: state.bids,
    gameOver: state.gameOver,
    winnerId: state.winnerId,
    stateVersion: state.stateVersion,
    youAre: viewerId,
  };
}
