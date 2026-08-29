/**
 * The socket.io wire contract, transcribed from `docs/WIRE.md` (FROZEN) and
 * from the exact payload shapes the legacy `server.js` / `roomManager.js`
 * emitted.
 *
 * ── Why this file exists rather than `shared/events.ts` ──────────────────────
 *
 * `src/shared/events.ts` describes a DIFFERENT, aspirational protocol: one
 * generic `action` channel plus `state` / `events` / `rejected` / `timer`.
 * `docs/WIRE.md` is the frozen contract — 37 named client intents, 35 named
 * server events — and the client is being rewritten against WIRE.md right now.
 * Where the two disagree, WIRE.md wins, so the names and payloads below are
 * WIRE.md's.
 *
 * `shared/events.ts` is still the source of truth for the *projection* types
 * (`ClientState`, `PublicPlayer`, `DeckCounts`, `PendingView`, `SignedSnapshot`)
 * because those are shared vocabulary the client imports directly; only the
 * event envelope differs. See the note in the final report.
 *
 * Every payload here is byte-shape-identical to what the legacy server sent,
 * with exactly two deliberate deviations, both mandated by the refactor:
 *
 *   1. `state_update.gameState` is a redacted `ClientState`, not a raw
 *      `GameState` (WIRE.md rule 1 / bugs B19, B23). See `view.ts`.
 *   2. `restore_game` carries an opaque `SignedSnapshot` instead of a
 *      client-authored `gameState` (bug B19), and `state_update` gained an
 *      additive optional `snapshot` field to deliver it — WIRE.md's 35 events
 *      have no snapshot-issuing event, so it rides along on the state
 *      broadcast at turn boundaries.
 */
import type {
  ClientState,
  SignedSnapshot,
} from '../shared/events.js';
import type {
  Card,
  DeckType,
  Phase,
  SeatId,
  SquareId,
  TradeStage,
  UpgradeTier,
} from '../shared/types.js';

export type { ClientState, SignedSnapshot };

/** A lobby/room member, as the legacy `room.players` array carried them. */
export interface WirePlayer {
  id: SeatId;
  name: string;
  avatar: number;
  connected: boolean;
}

/** The legacy `{cash, propIds, jailCards}` basket shape used by trades and bids. */
export interface WireBasket {
  cash: number;
  propIds: SquareId[];
  jailCards: number;
}

/** Legacy proposals carried a `submitted` flag the client keys its UI off. */
export type WireProposal = WireBasket & { submitted: true };

/** `gs.lastRoll` as the legacy engine's `computeRoll` returned it. */
export interface WireRoll {
  die1: number;
  die2: number;
  total: number;
  isDouble: boolean;
  oldPos: SquareId;
  newPos: SquareId;
  steps: number;
  passedGo: boolean;
  path: readonly SquareId[];
  playerId: SeatId;
}

export interface WireCardInfo {
  card: Card;
  cardNumber: number;
  squareName: string;
  deckType: DeckType;
  pendingSecondCard: boolean;
  cityNames: string[];
}

export interface WireBidOffer {
  id: string;
  playerId: SeatId;
  playerName: string;
  avatar: number;
  cash: number;
  propIds: SquareId[];
  jailCards: number;
}

export interface WireBid extends WireBidOffer {
  offers: WireBidOffer[];
  createdAt: number;
}

/** The `winner` object legacy put on `game_over` — a whole player, or undefined. */
export interface WireWinner {
  id: SeatId;
  name: string;
  avatar: number;
  money: number;
}

// ── server → client (35) ─────────────────────────────────────────────────────

export interface ServerToClientEvents {
  // lobby
  room_created: (p: { roomCode: string; playerId: SeatId; players: WirePlayer[] }) => void;
  joined: (p: { roomCode: string; playerId: SeatId; players: WirePlayer[] }) => void;
  update_players: (p: { players: WirePlayer[] }) => void;
  rejoined: (p: {
    roomCode: string;
    playerId: SeatId;
    players: WirePlayer[];
    gameState: ClientState | null;
  }) => void;
  rejoin_failed: (p: { error: string }) => void;
  restore_game_result: (p: {
    success: boolean;
    roomCode?: string;
    playerId?: SeatId;
    gameState?: ClientState | null;
    error?: string;
  }) => void;

  // game lifecycle
  game_started: (p: { gameState: ClientState }) => void;
  state_update: (p: {
    gameState: ClientState;
    phase: Phase;
    /** Additive; present only when a fresh signed snapshot was issued. */
    snapshot?: SignedSnapshot;
  }) => void;
  game_over: (p: { winner: WireWinner | undefined }) => void;
  action_log: (p: { message: string }) => void;
  splash_text: (p: { text: string; type: string }) => void;
  timer_sync: (p: { seconds: number; running: boolean }) => void;

  // turn
  dice_rolled: (p: WireRoll) => void;

  // cards
  landed_on_deck: (p: { deckLabel: string }) => void;
  private_card: (p: WireCardInfo) => void;
  other_drawing: (p: { playerName: string }) => void;
  public_card_draw: (p: WireCardInfo & { playerName: string }) => void;
  close_public_card: () => void;
  card_outcome: (p: { description: string; playerName: string; deckType: DeckType }) => void;

  // presence / admin
  player_disconnected: (p: {
    playerId: SeatId;
    players: WirePlayer[];
    connected: false;
  }) => void;
  player_reconnected: (p: {
    playerId: SeatId;
    oldPlayerId?: SeatId;
    players: WirePlayer[];
  }) => void;
  player_terminated: (p: { targetId: SeatId; players: WirePlayer[] }) => void;

  // trades
  trade_error: (p: { message: string }) => void;
  trade_request_notify: (p: {
    initiatorId: SeatId;
    initiatorName: string;
    initiatorAvatar: number;
  }) => void;
  trade_request_sent: (p: { partnerName: string }) => void;
  trade_request_declined: (p: { partnerName: string }) => void;
  trade_opened: (p: {
    tradeId: string;
    state: TradeStage;
    initiatorId: SeatId;
    initiator: { id: SeatId; name: string; avatar: number; money: number };
    partner: { id: SeatId; name: string; avatar: number; money: number };
    proposalA: WireProposal | null;
    proposalB: WireProposal | null;
  }) => void;
  trade_state_update: (p: {
    tradeId: string;
    state: TradeStage;
    proposalA: WireProposal | null;
    proposalB: WireProposal | null;
    acceptedA: boolean;
    acceptedB: boolean;
    fromPlayerId?: SeatId;
    accepted?: boolean;
    declined?: boolean;
    side?: 'a' | 'b';
    _participants: SeatId[];
  }) => void;
  trade_executed: (p: {
    aName: string;
    bName: string;
    aId: SeatId;
    bId: SeatId;
    _participants: SeatId[];
  }) => void;
  trade_cancelled: (p: { reason: string; _participants?: SeatId[] }) => void;
  trade_timer_sync: (p: { seconds: number; running: boolean }) => void;

  // bids
  bid_created: (p: WireBid) => void;
  bid_offer_added: (p: WireBid) => void;
  bid_executed: (p: { bidderName: string; offererName: string; bidId: string }) => void;
  bid_cancelled: (p: { bidId: string }) => void;
}

// ── client → server (37; `sell_to_bank_for_rent` deliberately absent) ────────

type Ack = (r: {
  ok: boolean;
  roomCode?: string;
  playerId?: SeatId;
  /** Roster snapshot so the ack alone can render the waiting room. */
  players?: WirePlayer[];
  error?: string;
}) => void;

export interface ClientToServerEvents {
  // lobby (6)
  host_game: (p: { playerName: string; avatar: number; options?: WireRoomOptions }, cb?: Ack) => void;
  join_game: (p: { roomCode: string; playerName: string; avatar: number }, cb?: Ack) => void;
  leave_room: (p: { roomCode: string }) => void;
  start_game: (p: { roomCode: string }) => void;
  rejoin_game: (p: { roomCode: string; playerName: string }) => void;
  /**
   * B19: `gameState` is GONE. The client returns the opaque signed blob it was
   * issued; anything else it sends is ignored.
   */
  restore_game: (p: {
    roomCode: string;
    playerName: string;
    playerId?: SeatId;
    snapshot?: SignedSnapshot;
  }) => void;

  // turn (3)
  roll_dice: (p: { roomCode: string }, cb?: (r: { ok: boolean }) => void) => void;
  confirm_landing: (p: { roomCode: string; rollResult?: unknown }) => void;
  debug_roll: (p: { roomCode: string; targetId?: SquareId }) => void;

  // property (9)
  buy_property: (p: { roomCode: string }) => void;
  decline_property: (p: { roomCode: string }) => void;
  pay_rent: (p: { roomCode: string }) => void;
  declare_bankrupt_from_rent: (p: { roomCode: string }) => void;
  buy_upgrade: (p: { roomCode: string; propertyId: SquareId; upgradeType: UpgradeTier }) => void;
  skip_upgrade: (p: { roomCode: string }) => void;
  sell_upgrade: (p: { roomCode: string; propertyId: SquareId }) => void;
  sell_property: (p: { roomCode: string; propertyId: SquareId }) => void;
  sell_building_in_trade: (p: { roomCode: string; propId: SquareId }) => void;

  // cards (4)
  draw_card: (p: { roomCode: string; deckType: DeckType }) => void;
  confirm_blind_card: (p: { roomCode: string }) => void;
  card_choice: (p: { roomCode: string; choiceIndex: number }) => void;
  club_choice: (p: { roomCode: string; choice: 'membership' | 'guest' }) => void;

  // prison (3)
  skip_prison: (p: { roomCode: string }) => void;
  pay_bail: (p: { roomCode: string }) => void;
  use_jail_free: (p: { roomCode: string }) => void;

  // trades (7)
  trade_request: (p: { roomCode: string; targetId: SeatId }) => void;
  accept_trade_request: (p: { roomCode: string; initiatorId: SeatId }) => void;
  decline_trade_request: (p: { roomCode: string; initiatorId: SeatId }) => void;
  trade_send_proposal: (p: {
    roomCode: string;
    cash?: number;
    propIds?: SquareId[];
    jailCards?: number;
  }) => void;
  trade_accept_proposal: (p: { roomCode: string }) => void;
  trade_decline_proposal: (p: { roomCode: string }) => void;
  trade_cancel: (p: { roomCode: string }) => void;

  // bids (4)
  create_bid: (p: {
    roomCode: string;
    cash?: number;
    propIds?: SquareId[];
    jailCards?: number;
  }) => void;
  bid_respond: (p: {
    roomCode: string;
    bidId: string;
    cash?: number;
    propIds?: SquareId[];
    jailCards?: number;
  }) => void;
  bid_accept_offer: (p: { roomCode: string; bidId: string; offerId: string }) => void;
  cancel_bid: (p: { roomCode: string; bidId: string }) => void;

  // admin (1)
  terminate_player: (p: { roomCode: string; targetId: SeatId }) => void;
}

/** Host options, as the legacy lobby sent them. All fields optional on the wire. */
export interface WireRoomOptions {
  startingCash?: number;
  passGoSalary?: number;
  diceCount?: 1 | 2;
  moneyVisible?: boolean;
  tradeTiming?: 'anytime' | 'own_turn';
  onBankruptcy?: 'eliminate' | 'jail';
  turnTimeoutSeconds?: number;
}

export interface InterServerEvents {
  ping: () => void;
}

/** Per-socket data the server attaches at connection time. */
export interface SocketData {
  roomCode: string | null;
  seatId: SeatId | null;
}
