/**
 * The anti-corruption layer between the wire and the renderers.
 *
 * The old inline script read a state shape the new server no longer sends:
 *
 *   legacy field              →  ClientState
 *   ────────────────────────────────────────────────────────────────────────
 *   gameState.boardSquares[]  →  board.squares[] + ownership[id]  (split)
 *   gameState.activeBids      →  bids[]          (Basket, not flat cash/propIds)
 *   gameState.pendingXxx × 8  →  pending         (one discriminated union)
 *   gameState.hazakDeck.length→  decks.hazak.drawCount  (counts only; B19)
 *   gameState.timerSeconds    →  — gone; timers are transport-only (B29)
 *   gameState.gameMeta.moneyVisible → — gone; hidden balances arrive as
 *                                     `money: null`, enforced server-side (B23)
 *
 * Rather than scatter that translation across ~1400 lines of rendering, every
 * conversion happens exactly once, here, and the renderers consume `ViewState`.
 * If the projection changes, one file changes.
 *
 * This layer is READ-ONLY. It never writes back to the state it was handed —
 * the legacy client mutated `gameState` in place from six event handlers
 * (patching `pendingX.playerId` on reconnect, splicing `activeBids`, assigning
 * `lastRoll`), which is why its view could disagree with the server's.
 */

import type { ClientState, PublicPlayer, PendingView } from '../shared/events.js';
import type {
  ColorGroup,
  DeckType,
  GameConfig,
  GameMeta,
  LastRoll,
  Phase,
  SeatId,
  Square,
  SquareId,
  UpgradeTier,
} from '../shared/types.js';
import type { Trade } from '../shared/trading.js';

/**
 * A board square with its dynamic ownership folded back in — the shape the
 * renderers want, rebuilt from the two halves the server sends separately.
 * Nullable price/colour fields make "is this ownable" a check rather than an
 * assumption; corners and deck triggers have neither.
 */
export interface ViewSquare {
  id: SquareId;
  name: string;
  description: string | undefined;
  kind: Square['kind'];
  colorGroup: ColorGroup | null;
  purchasePrice: number | null;
  baseRent: number | null;
  buildCost: Readonly<Record<UpgradeTier, number>> | null;
  visitorRent: Readonly<Record<UpgradeTier, number>> | null;
  owner: SeatId | null;
  upgrade: UpgradeTier | null;
  /** The untouched square, for the few renderers that need corner-specific data. */
  raw: Square;
}

/** A bid basket flattened and with the bidder's identity resolved. */
export interface ViewBidOffer {
  id: string;
  playerId: SeatId;
  playerName: string;
  avatar: number;
  cash: number;
  propIds: readonly SquareId[];
  jailCards: number;
}

export interface ViewBid extends ViewBidOffer {
  offers: readonly ViewBidOffer[];
  createdAt: number;
}

export interface ViewState {
  config: GameConfig;
  players: readonly PublicPlayer[];
  currentPlayerIndex: number;
  currentPlayer: PublicPlayer | null;
  phase: Phase;
  pending: PendingView;
  squares: readonly ViewSquare[];
  bids: readonly ViewBid[];
  trades: readonly Trade[];
  deckCounts: Readonly<Record<DeckType, number>>;
  lastRoll: LastRoll | null;
  meta: GameMeta;
  gameOver: boolean;
  winnerId: SeatId | null;
  stateVersion: number;
  youAre: SeatId;
}

const EMPTY_BUILD: null = null;

function toViewSquare(sq: Square, owner: SeatId | null, upgrade: UpgradeTier | null): ViewSquare {
  const ownable = sq.kind === 'property' || sq.kind === 'utility';
  return {
    id: sq.id,
    name: sq.name,
    description: sq.description,
    kind: sq.kind,
    colorGroup: ownable ? sq.colorGroup : null,
    purchasePrice: ownable ? sq.purchasePrice : null,
    baseRent: ownable ? sq.baseRent : null,
    buildCost: sq.kind === 'property' ? sq.buildCost : EMPTY_BUILD,
    visitorRent: sq.kind === 'property' ? sq.visitorRent : EMPTY_BUILD,
    owner,
    upgrade,
    raw: sq,
  };
}

function toViewOffer(
  id: string,
  playerId: SeatId,
  cash: number,
  propIds: readonly SquareId[],
  jailCards: number,
  players: readonly PublicPlayer[],
): ViewBidOffer {
  const p = players.find((x) => x.id === playerId);
  return {
    id,
    playerId,
    playerName: p?.name ?? '—',
    avatar: p?.avatar ?? 1,
    cash,
    propIds,
    jailCards,
  };
}

/** Rebuilds the flat view the renderers consume. Pure; allocates a fresh tree. */
export function buildViewState(cs: ClientState): ViewState {
  const squares = cs.board.squares.map((sq) => {
    const own = cs.ownership[sq.id];
    return toViewSquare(sq, own?.owner ?? null, own?.upgrade ?? null);
  });

  const bids: ViewBid[] = cs.bids.map((b) => ({
    ...toViewOffer(b.id, b.playerId, b.basket.cash, b.basket.squareIds, b.basket.jailCards, cs.players),
    offers: b.offers.map((o) =>
      toViewOffer(o.id, o.playerId, o.basket.cash, o.basket.squareIds, o.basket.jailCards, cs.players),
    ),
    createdAt: b.createdAt,
  }));

  return {
    config: cs.config,
    players: cs.players,
    currentPlayerIndex: cs.currentPlayerIndex,
    currentPlayer: cs.players[cs.currentPlayerIndex] ?? null,
    phase: cs.phase,
    pending: cs.pending,
    squares,
    bids,
    trades: cs.trades,
    deckCounts: { hazak: cs.decks.hazak.drawCount, mahkama: cs.decks.mahkama.drawCount },
    lastRoll: cs.lastRoll,
    meta: cs.board.meta,
    gameOver: cs.gameOver,
    winnerId: cs.winnerId,
    stateVersion: cs.stateVersion,
    youAre: cs.youAre,
  };
}

// ── Lookups (replacing the legacy `.find()` chains) ──

export function squareById(vs: ViewState, id: SquareId): ViewSquare | undefined {
  return vs.squares.find((s) => s.id === id);
}

export function playerById(vs: ViewState, id: SeatId | null): PublicPlayer | undefined {
  if (id === null) return undefined;
  return vs.players.find((p) => p.id === id);
}

export function squaresOwnedBy(vs: ViewState, id: SeatId | null): ViewSquare[] {
  if (id === null) return [];
  return vs.squares.filter((s) => s.owner === id);
}

export function isOwnable(sq: ViewSquare): boolean {
  return sq.kind === 'property' || sq.kind === 'utility';
}

/** True when this square can carry an upgrade at all (utilities cannot). */
export function isUpgradable(sq: ViewSquare): boolean {
  return sq.kind === 'property';
}

/**
 * Typed replacement for the eight legacy `state.pendingXxx` reads. Returns the
 * pending slot only when it is of the requested kind, so a stale `property_buy`
 * dialog can no longer be driven by a `rent` pending.
 */
export function pendingOf<K extends PendingView['kind']>(
  vs: ViewState,
  kind: K,
): Extract<PendingView, { kind: K }> | null {
  return vs.pending.kind === kind ? (vs.pending as Extract<PendingView, { kind: K }>) : null;
}

/** Whether `seat` is the player the current pending slot is waiting on. */
export function pendingBelongsTo(pending: PendingView, seat: SeatId | null): boolean {
  if (seat === null || pending.kind === 'none') return false;
  return pending.playerId === seat;
}

export function isMyTurn(vs: ViewState | null, seat: SeatId | null): boolean {
  if (!vs || seat === null) return false;
  return vs.currentPlayer?.id === seat;
}
