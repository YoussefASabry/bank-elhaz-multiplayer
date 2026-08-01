import { io, type Socket } from 'socket.io-client';
import type {
  ClientState,
  ClientToServerEvents,
  LobbyMember,
  RoomOptions,
  ServerToClientEvents,
  SignedSnapshot,
} from '../shared/events';
import type { Action, DomainEvent } from '../shared/actions';
import type { Card, SeatId } from '../shared/types';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface NetHandlers {
  onLobby: (p: { roomCode: string; you: SeatId; members: LobbyMember[] }) => void;
  onMembers: (p: { members: LobbyMember[] }) => void;
  onRoomError: (p: { message: string; tab?: 'host' | 'join' }) => void;
  onGameStarted: (p: { state: ClientState }) => void;
  onState: (p: { state: ClientState }) => void;
  onEvents: (p: { events: DomainEvent[] }) => void;
  onRejected: (p: { action: string; reason: string }) => void;
  onPrivateCard: (p: {
    card: Card;
    deck: 'mahkama' | 'hazak';
    cardNumber: number;
    totalCards: number;
    cityNames?: string[];
  }) => void;
  onTimer: (p: { seconds: number; running: boolean; total: number }) => void;
  onTradeTimer: (p: { tradeId: string; seconds: number }) => void;
  onSnapshot: (p: { snapshot: SignedSnapshot }) => void;
  onRestoreOk: (p: { roomCode: string; you: SeatId; state: ClientState }) => void;
  onRestoreRejected: (p: { reason: string }) => void;
  onGameOver: (p: { winnerId: SeatId | null }) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export class Net {
  socket: ClientSocket;
  private connected = false;
  private handlers: NetHandlers;
  private pendingConnect: (() => void) | null = null;

  constructor(handlers: NetHandlers) {
    this.handlers = handlers;
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.wire();
  }

  private wire(): void {
    const s = this.socket;
    s.on('connect', () => {
      this.connected = true;
      if (this.pendingConnect) {
        const fn = this.pendingConnect;
        this.pendingConnect = null;
        fn();
      }
      this.handlers.onConnect();
    });
    s.on('disconnect', () => {
      this.connected = false;
      this.handlers.onDisconnect();
    });
    s.on('room_created', (p) => this.handlers.onLobby(p));
    s.on('room_joined', (p) => this.handlers.onLobby(p));
    s.on('room_members', (p) => this.handlers.onMembers(p));
    s.on('room_error', (p) => this.handlers.onRoomError(p));
    s.on('game_started', (p) => this.handlers.onGameStarted(p));
    s.on('state', (p) => this.handlers.onState(p));
    s.on('events', (p) => this.handlers.onEvents(p));
    s.on('rejected', (p) => this.handlers.onRejected(p));
    s.on('private_card', (p) => this.handlers.onPrivateCard(p));
    s.on('timer', (p) => this.handlers.onTimer(p));
    s.on('trade_timer', (p) => this.handlers.onTradeTimer(p));
    s.on('snapshot_issued', (p) => this.handlers.onSnapshot(p));
    s.on('restore_ok', (p) => this.handlers.onRestoreOk(p));
    s.on('restore_rejected', (p) => this.handlers.onRestoreRejected(p));
    s.on('game_over', (p) => this.handlers.onGameOver(p));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Run once the socket is connected (immediately if it already is). */
  whenConnected(fn: () => void): void {
    if (this.connected) fn();
    else this.pendingConnect = fn;
  }

  host(name: string, avatar: number, options: RoomOptions): void {
    this.socket.emit('host_game', { playerName: name, avatar, options }, (r) => {
      if (!r.ok) this.handlers.onRoomError({ message: r.error ?? 'Could not create room', tab: 'host' });
    });
  }

  join(roomCode: string, name: string, avatar: number): void {
    this.socket.emit('join_game', { roomCode, playerName: name, avatar }, (r) => {
      if (!r.ok) this.handlers.onRoomError({ message: r.error ?? 'Could not join room', tab: 'join' });
    });
  }

  leaveRoom(roomCode: string): void {
    this.socket.emit('leave_room', { roomCode });
  }

  startGame(roomCode: string): void {
    this.socket.emit('start_game', { roomCode });
  }

  act(roomCode: string, action: Action): void {
    this.socket.emit('action', { roomCode, action });
  }

  rejoin(roomCode: string, seatToken: string): void {
    this.socket.emit('rejoin', { roomCode, seatToken });
  }

  restore(snapshot: SignedSnapshot, seatToken: string): void {
    this.socket.emit('restore', { snapshot, seatToken });
  }
}
