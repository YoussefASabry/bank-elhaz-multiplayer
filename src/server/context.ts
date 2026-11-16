/**
 * The server's shared context and the small pure mappers that turn engine
 * vocabulary into the legacy wire vocabulary.
 *
 * The engine speaks `Basket { cash, squareIds, jailCards }` and `Trade { stage,
 * a, b }`. The frozen wire speaks `{ cash, propIds, jailCards }` and
 * `{ state, players: {a, b} }`. Rather than let every handler translate ad hoc
 * (which is how the legacy code ended up with three spellings of a proposal),
 * every conversion lives here and nowhere else.
 */
import type { Server } from 'socket.io';
import type { Basket, Bid, BidOffer, GameState, SeatId, SquareId, Trade } from '../shared/types.js';
import type { Rng } from '../engine/rng.js';
import type { VersionStore } from './versionStore.js';
import type { RoomStore } from './rooms.js';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  WireBasket,
  WireBid,
  WireBidOffer,
  WireProposal,
  WireWinner,
} from './wire.js';

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type S2C = ServerToClientEvents;

/**
 * The only way this server writes to a socket. An interface rather than a bare
 * `io` so the dispatch pipeline can be unit-tested against a recording fake
 * without standing up a real socket.io server.
 */
export interface Emitter {
  /** Everyone in the room. */
  toRoom<E extends keyof S2C>(code: string, event: E, ...args: Parameters<S2C[E]>): void;
  /** One socket. */
  toSocket<E extends keyof S2C>(socketId: string, event: E, ...args: Parameters<S2C[E]>): void;
  /** Everyone in the room but one socket. */
  toRoomExcept<E extends keyof S2C>(
    code: string,
    exceptSocketId: string,
    event: E,
    ...args: Parameters<S2C[E]>
  ): void;
}

export function socketEmitter(io: TypedServer): Emitter {
  return {
    toRoom(code, event, ...args) {
      io.to(code).emit(event, ...args);
    },
    toSocket(socketId, event, ...args) {
      io.to(socketId).emit(event, ...args);
    },
    toRoomExcept(code, exceptSocketId, event, ...args) {
      io.to(code).except(exceptSocketId).emit(event, ...args);
    },
  };
}

export interface ServerCtx {
  rooms: RoomStore;
  emit: Emitter;
  /** HMAC key for signed snapshots. */
  secret: Buffer;
  versions: VersionStore;
  /** Injected so tests can freeze time; the engine never calls Date.now() itself. */
  now: () => number;
  /** Per-room RNG is on the Room; this is the fallback for room creation. */
  rng: (room: { rng: Rng }) => Rng;
}

// ── engine → wire mappers ──

export function toWireBasket(b: Basket): WireBasket {
  return { cash: b.cash, propIds: [...b.squareIds], jailCards: b.jailCards };
}

/** Legacy proposals carry `submitted: true`; the client keys its UI off it. */
export function toWireProposal(b: Basket | null): WireProposal | null {
  return b === null ? null : { ...toWireBasket(b), submitted: true };
}

/** `{cash, propIds, jailCards}` off the wire → the engine's basket. */
export function fromWireBasket(p: {
  cash?: number;
  propIds?: SquareId[];
  jailCards?: number;
}): Basket {
  return {
    cash: Math.max(0, Math.floor(Number(p.cash ?? 0)) || 0),
    squareIds: Array.isArray(p.propIds) ? p.propIds.filter((n) => typeof n === 'number') : [],
    jailCards: Math.max(0, Math.floor(Number(p.jailCards ?? 0)) || 0),
  };
}

export function playerName(state: GameState, seatId: SeatId): string {
  return state.players.find((p) => p.id === seatId)?.name ?? 'Unknown';
}

export function playerAvatar(state: GameState, seatId: SeatId): number {
  return state.players.find((p) => p.id === seatId)?.avatar ?? 1;
}

export function squareName(state: GameState, id: SquareId): string {
  return state.board.squares.find((s) => s.id === id)?.name ?? '';
}

export function toWireOffer(state: GameState, offer: BidOffer): WireBidOffer {
  return {
    id: offer.id,
    playerId: offer.playerId,
    playerName: playerName(state, offer.playerId),
    avatar: playerAvatar(state, offer.playerId),
    ...toWireBasket(offer.basket),
  };
}

export function toWireBid(state: GameState, bid: Bid): WireBid {
  return {
    id: bid.id,
    playerId: bid.playerId,
    playerName: playerName(state, bid.playerId),
    avatar: playerAvatar(state, bid.playerId),
    ...toWireBasket(bid.basket),
    offers: bid.offers.map((o) => toWireOffer(state, o)),
    createdAt: bid.createdAt,
  };
}

export function tradeParticipants(trade: Trade): SeatId[] {
  return [trade.a, trade.b];
}

export function toWireWinner(state: GameState): WireWinner | undefined {
  const id = state.winnerId;
  const p = id === null ? undefined : state.players.find((q) => q.id === id);
  if (p === undefined) return undefined;
  return { id: p.id, name: p.name, avatar: p.avatar, money: p.money };
}
