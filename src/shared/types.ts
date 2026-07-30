/**
 * Domain model. This is the vocabulary the whole codebase shares.
 *
 * Two structural rules make entire bug classes unrepresentable:
 *
 * 1. NO socket ids anywhere in GameState. Players are identified by a stable
 *    `SeatId` that outlives reconnects. The old server stored `socket.id` in
 *    state and had to remap six separate fields on every rejoin, missing
 *    `activeBids`, `bid.offers`, `trades`, `pendingClubChoice`,
 *    `pendingUpgradeChoice` and `lastRoll` (bug B20). With stable seats there is
 *    nothing to remap, so B20 cannot exist.
 *
 * 2. ONE `pending` slot, as a discriminated union. The old state had eight
 *    independently-nullable `pendingX` fields that could all be set at once,
 *    which is the root of several turn freezes. Here, conflicting pending states
 *    are a type error.
 *
 * Also absent by design: timer fields (transport-level only, bug B29) and any
 * UI-only field such as `_prevMoney` (the client store owns that).
 */

import type { RawColorGroup, RawMahkamaAction } from './raw.js';
import type { Trade, Bid } from './trading.js';

// ── Identity ──

/** Board position, 1..34. */
export type SquareId = number;

/**
 * Stable per-seat identity, assigned once at join and never changed — NOT a
 * socket id. Survives disconnect, reconnect and server restart.
 */
export type SeatId = string;

export type ColorGroup = RawColorGroup;
export type DeckType = 'hazak' | 'mahkama';
export type UpgradeTier = 'garage' | 'rest_stop' | 'market';

// ── Board (static; loaded once, never mutated) ──

interface SquareBase {
  id: SquareId;
  name: string;
  description?: string;
}

/** A city that can be owned AND upgraded. */
export interface UpgradableProperty extends SquareBase {
  kind: 'property';
  colorGroup: ColorGroup;
  purchasePrice: number;
  baseRent: number;
  /** Cost the OWNER pays to build each tier (from `owner_paying`). */
  buildCost: Record<UpgradeTier, number>;
  /** Rent a VISITOR pays at each tier (from `visitor_paying`). */
  visitorRent: Record<UpgradeTier, number>;
}

/**
 * A city that can be owned but NOT upgraded (only محطة بنزين, id 16, which has
 * no tier tables in the data). Separate variant so non-upgradability is
 * structural — `getUpgradeOptions` cannot be called on it — rather than a
 * runtime `if (!square.owner_paying) return []`.
 */
export interface UtilityProperty extends SquareBase {
  kind: 'utility';
  colorGroup: ColorGroup;
  purchasePrice: number;
  baseRent: number;
}

export type OwnableSquare = UpgradableProperty | UtilityProperty;

/**
 * Corner effects are read from the data rather than switched on hardcoded ids.
 * The old engines both did `switch (square.id) { case 8: ... case 18: ... }`,
 * even though the data already carries `membership_cost`, `status_effect` and
 * `rules`.
 */
export type CornerEffect =
  | { effect: 'salary' }
  | { effect: 'club'; membershipCost: number; guestFineFee: number }
  | { effect: 'double_next_roll' }
  | { effect: 'prison'; maxTurnsToMiss: number; bailCost: number };

export type CornerSquare = SquareBase & { kind: 'corner' } & CornerEffect;

export interface DeckTriggerSquare extends SquareBase {
  kind: 'deck';
  deck: DeckType;
}

/** Square 4 — draws from BOTH decks, mahkama first (bug B10: online only ever drew one). */
export interface DualDeckSquare extends SquareBase {
  kind: 'dual_deck';
  draws: readonly DeckType[];
}

export type Square =
  | UpgradableProperty
  | UtilityProperty
  | CornerSquare
  | DeckTriggerSquare
  | DualDeckSquare;

export interface GameMeta {
  title: string;
  startingCash: number;
  passGoSalary: number;
  maxPlayers: number;
  minPlayers: number;
}

export interface Board {
  meta: GameMeta;
  squares: readonly Square[];
  /** Derived, never hardcoded (bug B30: `34` was literal in two places). */
  size: number;
}

// ── Cards (normalised; the `"half price"` wart is resolved at load) ──

export type Choice =
  | { type: 'receive_cash'; amount: number; label?: string }
  | { type: 'pay_fine'; amount: number; label?: string }
  | { type: 'go_to_prison'; label?: string }
  | {
      type: 'claim_free_property';
      label?: string;
      maxPrice?: number;
      poolOptions?: readonly SquareId[];
      unownedOnly: boolean;
    }
  | {
      type: 'move_to_dynamic_pool';
      label?: string;
      selectionCount: number;
      unownedOnly: boolean;
    };

/** Unconditional effects, applied before any choice is offered. */
export interface CardEffects {
  bankMoney: number;
  /** Taken from every other solvent player. */
  collectFromEachPlayer: number;
  freeCards: number;
  jailFreeCards: number;
  /** Normalised from the `"half price"` key (bug B36). */
  halfRentNextLanding: boolean;
  moveTo: SquareId | null;
  squaresToMove: number;
  skipNextTurn: boolean;
}

export interface CardParams {
  perBuildingAmount?: number;
  repairCosts?: Record<UpgradeTier, number>;
  amountPerCity?: number;
  cityCount?: number;
}

export interface Card {
  id: number;
  deck: DeckType;
  description: string;
  effects: CardEffects;
  /** Mahkama cards carry an action discriminator; hazak cards are pure effects. */
  action: RawMahkamaAction | null;
  choices: readonly Choice[];
  params: CardParams;
}

export interface DeckState {
  draw: Card[];
  discard: Card[];
}

// ── Players ──

export interface StatusEffects {
  payHalfRentNextLanding: boolean;
  doubleNextRoll: boolean;
  missedTurnsRemaining: number;
  skipNextTurn: boolean;
}

export interface Player {
  id: SeatId;
  name: string;
  avatar: number;
  position: SquareId;
  money: number;
  inventory: { freeCards: number; jailFreeCards: number };
  statusEffects: StatusEffects;
  isClubMember: boolean;
  /** Lost the game by insolvency. */
  isBankrupt: boolean;
  /**
   * Removed by the host. Distinct from bankruptcy, and NEVER spliced out of the
   * players array — splicing shifted `currentPlayerIndex` and corrupted turn
   * order (bug B06).
   */
  eliminated: boolean;
  connected: boolean;
}

/** A player still able to take turns. */
export function isActive(p: Player): boolean {
  return !p.isBankrupt && !p.eliminated;
}

// ── Dynamic square state ──

export interface SquareOwnership {
  owner: SeatId | null;
  upgrade: UpgradeTier | null;
}

// ── Phases ──

/**
 * Nine actionable phases plus one terminal. The old `'done'` phase is gone: it
 * was only ever a transient between finishTurn and advanceTurn.
 *
 * Every one of these MUST have a timeout branch — `autoPass` previously had no
 * branch for `draw_card`, `upgrade_choice` or `rolling`, so the timer expired,
 * nothing happened, and the game froze permanently (bug B02). The reducer
 * switches exhaustively with a `never` fallthrough so a missing branch fails to
 * compile.
 */
export type Phase =
  | 'roll'
  | 'rolling'
  | 'draw_card'
  | 'blind_card'
  | 'card_choice'
  | 'club_choice'
  | 'property_choice'
  | 'upgrade_choice'
  | 'rent_payment'
  | 'game_over';

// ── The single pending slot ──

export interface UpgradeOption {
  tier: UpgradeTier;
  cost: number;
  visitorRent: number;
}

export type Pending =
  | { kind: 'none' }
  | { kind: 'property_buy'; playerId: SeatId; squareId: SquareId }
  | {
      kind: 'rent';
      playerId: SeatId;
      ownerId: SeatId | null;
      amount: number;
      squareId: SquareId;
    }
  | {
      kind: 'club';
      playerId: SeatId;
      membershipCost: number;
      guestFineFee: number;
    }
  | {
      kind: 'upgrade';
      playerId: SeatId;
      squareId: SquareId;
      options: readonly UpgradeOption[];
    }
  | {
      kind: 'deck_draw';
      playerId: SeatId;
      /** Remaining draws; square 4 enqueues ['mahkama','hazak'] (bug B10). */
      queue: readonly DeckType[];
      squareName: string;
    }
  | {
      kind: 'blind_card';
      playerId: SeatId;
      card: Card;
      cardNumber: number;
      totalCards: number;
      /**
       * Cities pre-selected for `collect_from_city_owners` and shown on the card.
       * Carried here so resolution charges exactly these owners; the old engine
       * re-randomised at resolve time because it had already nulled the card,
       * so the cities charged differed from the cities displayed (bug B08).
       */
      cityIds?: readonly SquareId[];
      /** Draws still queued after this card (square 4's second card). */
      remainingDraws: readonly DeckType[];
    }
  | {
      kind: 'card_choice';
      playerId: SeatId;
      card: Card;
      title: string;
      options: readonly Choice[];
      /** Resolved property pool for claim/move choices, in display order. */
      propertyPool: readonly SquareId[];
      remainingDraws: readonly DeckType[];
    };

// ── Configuration ──

export type BankruptcyRule = 'eliminate' | 'jail';

export interface GameConfig {
  startingCash: number;
  passGoSalary: number;
  diceCount: 1 | 2;
  moneyVisible: boolean;
  tradeTiming: 'anytime' | 'own_turn';
  /** Single bankruptcy model (bug B21: two contradictory ones existed). */
  onBankruptcy: BankruptcyRule;
  turnTimeoutSeconds: number;
}

// ── Trades and bids ──

// Defined in ./trading.ts; re-exported so `types.js` stays the single import
// point for consumers that just want the domain vocabulary.
export type { Basket, TradeStage, Trade, BidOffer, Bid } from './trading.js';

// ── The state ──

export interface LastRoll {
  playerId: SeatId;
  die1: number;
  die2: number;
  total: number;
  steps: number;
  from: SquareId;
  to: SquareId;
  path: readonly SquareId[];
  passedGo: boolean;
  doubleApplied: boolean;
}

export interface GameState {
  config: GameConfig;
  board: Board;
  /** Dynamic square state, kept separate so board data is never mutated. */
  ownership: Record<SquareId, SquareOwnership>;
  players: Player[];
  currentPlayerIndex: number;
  /** Increments once per turn handover; surfaced in TURN_STARTED for logs/soak. */
  turnNumber: number;
  phase: Phase;
  pending: Pending;
  decks: Record<DeckType, DeckState>;
  lastRoll: LastRoll | null;
  trades: Trade[];
  bids: Bid[];
  gameOver: boolean;
  winnerId: SeatId | null;
  /**
   * Monotonic, incremented on every accepted action. Snapshot restore requires
   * a strictly greater version than the highest already restored, which is what
   * makes snapshot replay impossible (bug B19).
   */
  stateVersion: number;
}
