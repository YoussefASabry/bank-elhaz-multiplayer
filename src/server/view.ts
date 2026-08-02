/**
 * Redaction. Builds the per-viewer payload for `state_update` / `game_started`
 * / `rejoined` / `restore_game_result`.
 *
 * This module is MANDATORY (docs/WIRE.md rule 1). The legacy server did
 * `io.to(roomCode).emit('state_update', { gameState: gs, phase: gs.phase })` —
 * one raw `GameState` to everybody — which leaked three separate things:
 *
 *   - **The deck order.** `gs.decks[*].draw` is the shuffled future. Anyone
 *     with a devtools console could read the next N cards.
 *   - **Every balance.** `moneyVisible: false` was honoured only by the
 *     client's renderer; the numbers were still on the wire (bug B23).
 *   - **The card being read.** `gs.blindCard.card` was broadcast to the whole
 *     room the moment it was drawn, so `private_card` was privacy theatre.
 *
 * Nothing here mutates state. Every projection is a fresh object, so a
 * projection can never alias into `GameState` and be written back.
 */
import type {
  ClientState,
  DeckCounts,
  PendingView,
  PublicPlayer,
} from '../shared/events.js';
import type {
  DeckType,
  GameState,
  Pending,
  Player,
  SeatId,
  SquareId,
  SquareOwnership,
} from '../shared/types.js';

/**
 * Balances are visible to a viewer when the host left them visible, or always
 * for the viewer's own seat. `null` means "hidden", which the client renders as
 * `???` — it is not a zero and must not be treated as one.
 */
function projectPlayer(player: Player, viewer: SeatId, moneyVisible: boolean): PublicPlayer {
  const canSee = moneyVisible || player.id === viewer;
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    position: player.position,
    money: canSee ? player.money : null,
    inventory: { ...player.inventory },
    statusEffects: { ...player.statusEffects },
    isClubMember: player.isClubMember,
    isBankrupt: player.isBankrupt,
    eliminated: player.eliminated,
    connected: player.connected,
  };
}

/**
 * Counts only. Sending `draw` leaks the entire future of the game; sending
 * `discard` leaks it by subtraction.
 */
function projectDecks(state: GameState): Record<DeckType, DeckCounts> {
  const out = {} as Record<DeckType, DeckCounts>;
  for (const deck of Object.keys(state.decks) as DeckType[]) {
    const d = state.decks[deck];
    out[deck] = { drawCount: d.draw.length, discardCount: d.discard.length };
  }
  return out;
}

/**
 * A `blind_card` is replaced by an opaque marker for everyone but the drawer,
 * so opponents see *that* a card is being read (and how far through the deck
 * we are) without seeing *which* card. Every other pending kind is already
 * public information — it is a prompt the whole table can see.
 */
function projectPending(pending: Pending, viewer: SeatId): PendingView {
  if (pending.kind === 'blind_card' && pending.playerId !== viewer) {
    return {
      kind: 'blind_card_hidden',
      playerId: pending.playerId,
      cardNumber: pending.cardNumber,
      totalCards: pending.totalCards,
    };
  }
  return pending;
}

function projectOwnership(state: GameState): Record<SquareId, SquareOwnership> {
  const out: Record<SquareId, SquareOwnership> = {};
  for (const [id, rec] of Object.entries(state.ownership)) {
    out[Number(id)] = { owner: rec.owner, upgrade: rec.upgrade };
  }
  return out;
}

/**
 * The whole projection for one viewer.
 *
 * `board` is passed through by reference on purpose: it is static, immutable
 * data (ownership lives in `state.ownership`, deliberately outside it) and
 * copying it per viewer per broadcast would be pure waste.
 */
export function buildClientState(state: GameState, viewer: SeatId): ClientState {
  const moneyVisible = state.config.moneyVisible;
  return {
    config: state.config,
    board: state.board,
    ownership: projectOwnership(state),
    players: state.players.map((p) => projectPlayer(p, viewer, moneyVisible)),
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    pending: projectPending(state.pending, viewer),
    decks: projectDecks(state),
    lastRoll: state.lastRoll === null ? null : { ...state.lastRoll },
    // Trades and bids are already seat-scoped by the engine and are delivered
    // to participants over dedicated events; the arrays are copied so a client
    // projection can never alias the live ones.
    trades: state.trades.map((t) => ({ ...t })),
    bids: state.bids.map((b) => ({ ...b, offers: b.offers.map((o) => ({ ...o })) })),
    gameOver: state.gameOver,
    winnerId: state.winnerId,
    stateVersion: state.stateVersion,
    youAre: viewer,
  };
}
