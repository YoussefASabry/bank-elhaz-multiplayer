import { readFileSync } from 'fs';
import { GameEngine } from './engine.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../shared/${name}.json`, import.meta.url)));
const DATA = { board: load('board'), hazak: load('hazak'), mahkama: load('mahkama') };

const TURN_SECONDS = 90;
const TRADE_SECONDS = 60;
const RECONNECT_GRACE_MS = 60_000;

function roomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  // ── Lobby ──

  createRoom(hostId, name, avatar, options) {
    let code;
    do { code = roomCode(); } while (this.rooms.has(code));
    const room = {
      code,
      players: [{ id: hostId, name, avatar: avatar || 1 }],
      options: {
        startingCash: clampInt(options?.startingCash, 100, 5000, 1500),
        diceCount: options?.diceCount === 1 ? 1 : 2,
        moneyVisible: options?.moneyVisible !== false,
      },
      engine: null,
      timers: { turn: null, turnTick: null, trade: null, disconnects: new Map() },
      secondsLeft: 0,
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) { return this.rooms.get(code?.toUpperCase?.() || code) || null; }

  joinRoom(code, playerId, name, avatar) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.engine) {
      // Allow reconnect by name if that player disconnected mid-game
      const ghost = room.engine.state.players.find(p => !p.connected && p.name === name && !p.isBankrupt);
      if (ghost) return this.reconnect(room, ghost, playerId);
      return { error: 'Game already started' };
    }
    if (room.players.length >= 6) return { error: 'Room is full (max 6)' };
    if (room.players.some(p => p.name === name)) return { error: 'Name already taken' };
    room.players.push({ id: playerId, name, avatar: avatar || 1 });
    return { room };
  }

  reconnect(room, ghost, newId) {
    const grace = room.timers.disconnects.get(ghost.id);
    if (grace) { clearTimeout(grace); room.timers.disconnects.delete(ghost.id); }
    const oldId = ghost.id;
    ghost.id = newId;
    ghost.connected = true;
    // Rewrite every id reference in engine state
    const gs = room.engine.state;
    for (const sq of gs.squares) if (sq.owner === oldId) sq.owner = newId;
    if (gs.pending) {
      for (const k of ['playerId', 'debtorId', 'creditorId']) {
        if (gs.pending[k] === oldId) gs.pending[k] = newId;
      }
    }
    if (gs.trade) {
      if (gs.trade.fromId === oldId) gs.trade.fromId = newId;
      if (gs.trade.toId === oldId) gs.trade.toId = newId;
    }
    const lobbyP = room.players.find(p => p.id === oldId);
    if (lobbyP) lobbyP.id = newId;
    return { room, reconnected: true, player: ghost };
  }

  removeFromLobby(code, playerId) {
    const room = this.getRoom(code);
    if (!room || room.engine) return;
    room.players = room.players.filter(p => p.id !== playerId);
    if (room.players.length === 0) this.destroyRoom(code);
  }

  destroyRoom(code) {
    const room = this.getRoom(code);
    if (!room) return;
    const t = room.timers;
    for (const timer of [t.turn, t.turnTick, t.trade]) if (timer) clearInterval(timer), clearTimeout(timer);
    for (const g of t.disconnects.values()) clearTimeout(g);
    this.rooms.delete(room.code);
  }

  // ── Game lifecycle ──

  startGame(code, requesterId) {
    const room = this.getRoom(code);
    if (!room || room.engine) return { error: 'no_room' };
    if (room.players[0]?.id !== requesterId) return { error: 'not_host' };
    if (room.players.length < 2) return { error: 'need_2_players' };
    room.engine = new GameEngine({ players: room.players, options: room.options, data: DATA });
    this.broadcast(room, []);
    this.startTurnTimer(room);
    return { room };
  }

  // ── State broadcast ──

  sanitize(room, forPlayerId) {
    const gs = room.engine.state;
    const hideMoney = !gs.meta.moneyVisible;
    return {
      meta: gs.meta,
      phase: gs.phase,
      pending: this.sanitizePending(gs),
      trade: gs.trade,
      currentPlayerId: room.engine.current()?.id || null,
      players: gs.players.map(p => ({
        ...p,
        money: hideMoney && p.id !== forPlayerId ? null : p.money,
      })),
      squares: gs.squares,
      deckCounts: { hazak: gs.decks.hazak.length, mahkama: gs.decks.mahkama.length },
      turn: gs.turn,
      gameOver: gs.gameOver,
      winnerId: gs.winnerId,
      log: gs.log.slice(-60),
      secondsLeft: room.secondsLeft,
    };
  }

  sanitizePending(gs) {
    if (!gs.pending) return null;
    // Strip engine-internal fields (continuation callbacks, raw card refs)
    const { done, card, ...rest } = gs.pending;
    return { ...rest, card: card ? { ...card } : undefined };
  }

  broadcast(room, events = []) {
    const gs = room.engine.state;
    if (!gs.meta.moneyVisible) {
      // Per-player payloads when money is hidden
      for (const p of gs.players) {
        this.io.to(p.id).emit('state', { state: this.sanitize(room, p.id), events });
      }
    } else {
      this.io.to(room.code).emit('state', { state: this.sanitize(room, null), events });
    }
  }

  // ── Timers ──

  startTurnTimer(room) {
    this.stopTurnTimer(room);
    if (!room.engine || room.engine.state.gameOver) return;
    room.secondsLeft = TURN_SECONDS;
    this.io.to(room.code).emit('timer', { seconds: room.secondsLeft });
    room.timers.turnTick = setInterval(() => {
      room.secondsLeft--;
      this.io.to(room.code).emit('timer', { seconds: room.secondsLeft });
      if (room.secondsLeft <= 0) {
        this.stopTurnTimer(room);
        const r = room.engine.autoResolve();
        this.afterAction(room, r.events);
      }
    }, 1000);
  }

  stopTurnTimer(room) {
    if (room.timers.turnTick) { clearInterval(room.timers.turnTick); room.timers.turnTick = null; }
  }

  startTradeTimer(room) {
    this.stopTradeTimer(room);
    room.timers.trade = setTimeout(() => {
      const gs = room.engine.state;
      if (gs.trade) {
        gs.trade = null;
        this.io.to(room.code).emit('trade_expired', {});
        this.broadcast(room, [{ type: 'trade_cancelled' }]);
      }
    }, TRADE_SECONDS * 1000);
  }

  stopTradeTimer(room) {
    if (room.timers.trade) { clearTimeout(room.timers.trade); room.timers.trade = null; }
  }

  // ── Actions ──

  handleAction(code, playerId, action) {
    const room = this.getRoom(code);
    if (!room || !room.engine) return { ok: false, error: 'no_game' };
    const result = room.engine.dispatch(playerId, action);
    if (result.ok) this.afterAction(room, result.events, action);
    return result;
  }

  afterAction(room, events, action = null) {
    const gs = room.engine.state;

    // Timer management driven by resulting phase / events
    if (events.some(e => e.type === 'trade_proposed')) this.startTradeTimer(room);
    if (events.some(e => ['trade_executed', 'trade_declined', 'trade_cancelled'].includes(e.type))) this.stopTradeTimer(room);

    if (gs.gameOver) {
      this.stopTurnTimer(room);
      this.stopTradeTimer(room);
    } else if (events.some(e => e.type === 'turn_started')) {
      this.startTurnTimer(room);
    } else if (events.some(e => ['buy_decision', 'card_drawn', 'card_choice', 'club_choice', 'debt'].includes(e.type))) {
      // Fresh decision window
      this.startTurnTimer(room);
    }

    this.broadcast(room, events);
  }

  // ── Disconnect ──

  handleDisconnect(playerId) {
    for (const room of this.rooms.values()) {
      if (!room.engine) {
        if (room.players.some(p => p.id === playerId)) {
          this.removeFromLobby(room.code, playerId);
          if (this.rooms.has(room.code)) {
            this.io.to(room.code).emit('lobby_players', { players: room.players });
          }
        }
        continue;
      }
      const gp = room.engine.state.players.find(p => p.id === playerId);
      if (!gp || gp.isBankrupt) continue;
      gp.connected = false;
      this.io.to(room.code).emit('player_connection', { playerId, connected: false, name: gp.name });

      // Their pending decision shouldn't block others — auto-resolve their turn now,
      // then give them a grace window to reconnect before full removal.
      if (room.engine.current()?.id === playerId && !room.engine.state.gameOver) {
        this.stopTurnTimer(room);
        const r = room.engine.autoResolve();
        this.afterAction(room, r.events);
      }
      const grace = setTimeout(() => {
        room.timers.disconnects.delete(playerId);
        if (!room.engine || room.engine.state.gameOver) return;
        const still = room.engine.state.players.find(p => p.id === playerId);
        if (still && !still.connected && !still.isBankrupt) {
          const r = room.engine.removePlayer(playerId);
          this.afterAction(room, r.events);
        }
        // Everyone gone → destroy
        if (room.engine.state.players.every(p => !p.connected)) this.destroyRoom(room.code);
      }, RECONNECT_GRACE_MS);
      room.timers.disconnects.set(playerId, grace);
    }
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
