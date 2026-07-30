/**
 * Typed socket.io contract, shared by server and client.
 *
 * Design note: gameplay travels over a SINGLE `action` event carrying an
 * `Action`, not ~30 bespoke events. The old server.js had one handler per verb
 * (`buy_property`, `pay_rent`, `skip_prison`, `use_jail_free`, …), each
 * re-implementing its own authorization, mutation and broadcast. That is how
 * `use_jail_free` ended up calling a RoomManager method that did not exist
 * (bug B03) and how the timeout path drifted from the human path (bug B22).
 * One channel means one authorize → applyAction → broadcast path.
 *
 * Lobby/session concerns (join, rejoin, restore) stay as distinct events because
 * they are not game actions and must work before a game exists.
 */

import type { Action, DomainEvent, RejectReason } from './actions.js';
import type {
  Board,
  DeckType,
  GameConfig,
  Pending,
  Phase,
  Player,
  SeatId,
  SquareId,
  SquareOwnership,
  LastRoll,
  Trade,
  Bid,
  Card,
} from './types.js';

// ── Projected state (what a given client is allowed to see) ──

/**
 * `money` is null when the host hid balances and this is not the viewer.
 * Enforced SERVER-side in view.ts — the old client merely chose not to render
 * other players' money while the server broadcast it to everyone (bug B23).
 */
export type PublicPlayer = Omit<Player, 'money'> & { money: number | null };

/** Deck contents are never sent — only counts. Sending them leaked future draws. */
export interface DeckCounts {
  drawCount: number;
  discardCount: number;
}

/**
 * `pending` is projected too: a `blind_card` is replaced by an opaque marker for
 * everyone except the drawing player, so opponents learn that a card is being
 * read without learning which card.
 */
export type PendingView =
  | Pending
  | { kind: 'blind_card_hidden'; playerId: SeatId; cardNumber: number; totalCards: number };

export interface ClientState {
  config: GameConfig;
  board: Board;
  ownership: Record<SquareId, SquareOwnership>;
  players: PublicPlayer[];
  currentPlayerIndex: number;
  phase: Phase;
  pending: PendingView;
  decks: Record<DeckType, DeckCounts>;
  lastRoll: LastRoll | null;
  trades: Trade[];
  bids: Bid[];
  gameOver: boolean;
  winnerId: SeatId | null;
  stateVersion: number;
  /** The recipient's own seat id, so the client never guesses its identity. */
  youAre: SeatId;
}

// ── Lobby ──

export interface LobbyMember {
  id: SeatId;
  name: string;
  avatar: number;
  connected: boolean;
  isHost: boolean;
}

export interface RoomOptions {
  startingCash: number;
  passGoSalary: number;
  diceCount: 1 | 2;
  moneyVisible: boolean;
  tradeTiming: 'anytime' | 'own_turn';
  onBankruptcy: 'eliminate' | 'jail';
}

// ── Snapshots (bug B19) ──

/**
 * Opaque to the client. It stores and returns the blob verbatim and MUST NOT
 * parse it for gameplay — the payload is HMAC-signed and version-gated, so a
 * hand-edited or replayed blob is rejected server-side.
 */
export interface SignedSnapshot {
  v: 1;
  payload: string;
  sig: string;
}

export type RestoreRejection =
  | 'bad_signature'
  | 'stale_version'
  | 'expired'
  | 'not_a_participant'
  | 'room_is_live'
  | 'malformed';

// ── Server → client ──

export interface ServerToClientEvents {
  room_created: (p: { roomCode: string; you: SeatId; members: LobbyMember[] }) => void;
  room_joined: (p: { roomCode: string; you: SeatId; members: LobbyMember[] }) => void;
  room_members: (p: { members: LobbyMember[] }) => void;
  room_error: (p: { message: string }) => void;

  game_started: (p: { state: ClientState }) => void;
  /** Full projected state. Sent per-socket, since projections differ per viewer. */
  state: (p: { state: ClientState }) => void;
  /** Narration + UI triggers. The client renders logs from these, not from state diffs. */
  events: (p: { events: DomainEvent[] }) => void;
  /** Your action was refused, with a machine-readable reason. */
  rejected: (p: { action: string; reason: RejectReason }) => void;

  /** Only ever sent to the drawing player. */
  private_card: (p: {
    card: Card;
    deck: DeckType;
    cardNumber: number;
    totalCards: number;
    cityNames?: string[];
  }) => void;

  /**
   * Transport-level only; deliberately NOT part of GameState (bug B29), and one
   * interval per room (bug B01: clearTimeout was called on a setInterval handle,
   * so timers stacked and autoPass fired repeatedly).
   */
  timer: (p: { seconds: number; running: boolean; total: number }) => void;

  trade_timer: (p: { tradeId: string; seconds: number }) => void;

  snapshot_issued: (p: { snapshot: SignedSnapshot }) => void;
  restore_ok: (p: { roomCode: string; you: SeatId; state: ClientState }) => void;
  restore_rejected: (p: { reason: RestoreRejection }) => void;

  game_over: (p: { winnerId: SeatId | null }) => void;
}

// ── Client → server ──

export interface ClientToServerEvents {
  host_game: (
    p: { playerName: string; avatar: number; options: RoomOptions },
    ack?: (r: { ok: boolean; roomCode?: string; you?: SeatId; error?: string }) => void,
  ) => void;
  join_game: (
    p: { roomCode: string; playerName: string; avatar: number },
    ack?: (r: { ok: boolean; roomCode?: string; you?: SeatId; error?: string }) => void,
  ) => void;
  leave_room: (p: { roomCode: string }) => void;
  start_game: (p: { roomCode: string }) => void;

  /**
   * The single gameplay channel. `actorId` is IGNORED on the wire and overwritten
   * server-side with the sender's authenticated seat id — otherwise a client
   * could act as another player, which is exactly bug B09.
   */
  action: (p: { roomCode: string; action: Action }) => void;

  rejoin: (p: { roomCode: string; seatToken: string }) => void;
  restore: (p: { snapshot: SignedSnapshot; seatToken: string }) => void;
}

/** Per-socket data the server attaches at connection time. */
export interface SocketData {
  roomCode: string | null;
  seatId: SeatId | null;
}
