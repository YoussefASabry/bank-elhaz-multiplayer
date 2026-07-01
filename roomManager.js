import { GameEngine } from './gameEngine.js';

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  createRoom(hostId, hostName, avatar) {
    let code;
    do { code = generateRoomCode(); } while (this.rooms.has(code));
    const room = {
      code,
      players: [{ id: hostId, name: hostName, avatar: avatar || 1 }],
      gameState: null,
      timer: null,
      trade: null,
      turnTimer: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  joinRoom(code, playerId, playerName, avatar) {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.gameState) return { ok: false, error: 'Game already started' };
    if (room.players.length >= 6) return { ok: false, error: 'Room is full (max 6)' };
    if (room.players.find(p => p.id === playerId)) return { ok: false, error: 'Already in room' };
    room.players.push({ id: playerId, name: playerName, avatar: avatar || 1 });
    return { ok: true, room };
  }

  removePlayer(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== playerId);
  }

  destroyRoom(code) {
    const room = this.rooms.get(code);
    if (room) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      this.rooms.delete(code);
    }
  }

  // ── Game lifecycle ──

  startGame(code) {
    const room = this.rooms.get(code);
    if (!room || room.players.length < 2) return false;
    const engine = new GameEngine(room.players);
    engine.initGame();
    room.gameState = engine.state;
    room.engine = engine;
    return true;
  }

  // ── Turn timer ──

  startTurnTimer(code, io) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState) return;
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.gameState.timerSeconds = 90;
    room.gameState.timerRunning = true;
    io.to(code).emit('timer_sync', { seconds: 90, running: true });

    let secs = 90;
    room.turnTimer = setInterval(() => {
      secs--;
      room.gameState.timerSeconds = secs;
      io.to(code).emit('timer_sync', { seconds: secs, running: true });
      if (secs <= 0) {
        clearInterval(room.turnTimer);
        room.turnTimer = null;
        room.gameState.timerRunning = false;
        this.autoPass(room, code, io);
      }
    }, 1000);
  }

  stopTurnTimer(room) {
    if (room.turnTimer) {
      clearInterval(room.turnTimer);
      room.turnTimer = null;
    }
    if (room.gameState) {
      room.gameState.timerRunning = false;
    }
  }

  resetTurnTimer(room, code, io) {
    this.stopTurnTimer(room);
    this.startTurnTimer(code, io);
  }

  autoPass(room, code, io) {
    if (!room.gameState || room.gameState.gameOver) return;
    const gs = room.gameState;
    const player = gs.players[gs.currentPlayerIndex];
    if (!player) return;

    const phase = gs.phase;
    if (phase === 'roll') {
      this.advanceTurn(room, code, io);
    } else if (phase === 'property_choice') {
      const { pendingPropertyBuy } = gs;
      if (pendingPropertyBuy) {
        pendingPropertyBuy.resolved = true;
        gs.pendingPropertyBuy = null;
        this.finishTurn(room, code, io);
      }
    } else if (phase === 'rent_payment') {
      gs.pendingRentPayment = null;
      this.finishTurn(room, code, io);
    } else if (phase === 'blind_card') {
      this.resolveBlindCard(code, player.id, io);
    } else if (phase === 'card_choice') {
      this.resolveCardChoice(code, player.id, 0);
    }
    io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
  }

  // ── Game actions ──

  handleRollDice(code, playerId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return null;
    const gs = room.gameState;
    const player = gs.players[gs.currentPlayerIndex];
    if (!player || player.id !== playerId) return null;
    if (gs.phase !== 'roll') return null;

    const result = room.engine.computeRoll(playerId);
    if (!result) return null;
    gs.lastRoll = result;
    gs.phase = 'rolling';

    // Update player position (authoritative)
    const p = gs.players.find(p => p.id === playerId);
    if (!p) return null;
    p.position = result.newPos;

    if (result.passedGo) {
      p.money += gs.gameMeta.passGoSalary;
    }

    return result;
  }

  handleLanding(code, playerId, rollResult, io) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === playerId);
    if (!player) return;

    // Evaluate landing
    room.engine.evaluateLanding(player);
    io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });

    // Handle special phases
    const phase = gs.phase;
    if (phase === 'blind_card') {
      // Send card privately to the drawing player
      const bs = this.io.to(playerId);
      bs.emit('private_card', {
        card: gs.blindCard.card,
        cardNumber: gs.blindCard.cardNumber || 1,
        squareName: gs.blindCard.squareName,
        pendingSecondCard: !!gs.pendingSecondCard,
      });
      // Tell others someone is drawing
      socketToRoom(io, code, playerId).emit('other_drawing', { playerName: player.name });
    } else if (phase === 'property_choice') {
      this.resetTurnTimer(room, code, io);
    } else if (phase === 'rent_payment') {
      this.resetTurnTimer(room, code, io);
    } else if (phase === 'done' || gs.gameOver) {
      this.advanceTurn(room, code, io);
    }
  }

  resolvePropertyBuy(code, playerId, shouldBuy) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.resolvePropertyPurchase(shouldBuy);
    this.finishTurn(room, code, this.io);
  }

  resolveRent(code, playerId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.resolveRentPayment();
    this.finishTurn(room, code, this.io);
  }

  resolveBlindCard(code, playerId, io) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return null;
    const gs = room.gameState;
    if (!gs.blindCard) return null;

    const { card, playerId: pid } = gs.blindCard;
    const player = gs.players.find(p => p.id === pid);
    if (!player) { gs.blindCard = null; this.finishTurn(room, code, io); return null; }

    gs.blindCard = null;

    if (gs.pendingSecondCard) {
      gs.pendingSecondCard = false;
      const card2 = room.engine.drawCard();
      if (card2) {
        gs.blindCard = { card: card2, playerId, squareName: 'المحكمة أو حظك', cardNumber: 2 };
        io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
        this.io.to(playerId).emit('private_card', {
          card: card2, cardNumber: 2, squareName: 'المحكمة أو حظك', pendingSecondCard: false,
        });
        socketToRoom(io, code, playerId).emit('other_drawing', { playerName: player.name });
        return null;
      }
    }

    room.engine.handleCardEffect(card, playerId);
    const outcome = { description: card.description, playerName: player.name };
    this.finishTurn(room, code, io);
    return outcome;
  }

  resolveCardChoice(code, playerId, choiceIndex) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.resolveCardChoice(choiceIndex);
    this.finishTurn(room, code, this.io);
  }

  skipPrison(code, playerId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.statusEffects.missedTurnsRemaining <= 0) return;
    player.statusEffects.missedTurnsRemaining--;
    if (player.statusEffects.missedTurnsRemaining <= 0) {
      gs.phase = 'roll';
      this.resetTurnTimer(room, code, this.io);
    } else {
      room.engine.finishTurn(playerId, true);
    }
  }

  payBail(code, playerId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.payBail(playerId);
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === playerId);
    if (player && player.statusEffects.missedTurnsRemaining <= 0) {
      gs.phase = 'roll';
      this.resetTurnTimer(room, code, this.io);
    }
  }

  sellBuilding(code, playerId, propertyId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.sellBuilding(playerId, propertyId);
  }

  sellPropertyToBank(code, playerId, propertyId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.sellPropertyToBank(playerId, propertyId);
  }

  // ── Turn management ──

  finishTurn(room, code, io) {
    if (!room.engine || !room.gameState) return;
    room.engine.finishTurn();
    const gs = room.gameState;
    if (gs.gameOver) {
      this.stopTurnTimer(room);
      io.to(code).emit('game_over', { winner: gs.players.find(p => !p.isBankrupt) });
      return;
    }
    // Reset timer for next turn
    this.startTurnTimer(code, io);
    io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
  }

  advanceTurn(room, code, io) {
    if (!room.engine || !room.gameState) return;
    room.engine.advanceTurn();
    const gs = room.gameState;
    if (gs.gameOver) {
      this.stopTurnTimer(room);
      io.to(code).emit('game_over', { winner: gs.players.find(p => !p.isBankrupt) });
      return;
    }
    this.startTurnTimer(code, io);
    io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
  }

  handleDisconnectAutoPass(room, code, io) {
    const gs = room.gameState;
    if (!gs || gs.gameOver) return;
    this.stopTurnTimer(room);
    room.engine.finishTurn();
    if (gs.gameOver) {
      io.to(code).emit('game_over', { winner: gs.players.find(p => !p.isBankrupt) });
      return;
    }
    this.startTurnTimer(code, io);
    io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
  }

  // ── Trade ──

  initTrade(code, playerId, targetId) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState) return null;
    const gs = room.gameState;
    const a = gs.players.find(p => p.id === playerId);
    const b = gs.players.find(p => p.id === targetId);
    if (!a || !b) return null;

    room.trade = {
      a: { id: playerId, cash: 0, propIds: [], locked: false },
      b: { id: targetId, cash: 0, propIds: [], locked: false },
    };
    return {
      a: { id: a.id, name: a.name, avatar: a.avatar, money: a.money },
      b: { id: b.id, name: b.name, avatar: b.avatar, money: b.money },
    };
  }

  updateTrade(code, playerId, side, cash, propIds) {
    const room = this.rooms.get(code);
    if (!room || !room.trade) return null;
    const sideKey = side === 'a' ? 'a' : 'b';
    const trade = room.trade;
    if (trade[sideKey].id !== playerId) return null;
    if (trade[sideKey].locked) return null;
    trade[sideKey].cash = Math.max(0, cash);
    trade[sideKey].propIds = propIds || [];
    return { side: sideKey, cash: trade[sideKey].cash, propIds: trade[sideKey].propIds };
  }

  toggleTradeLock(code, playerId, side) {
    const room = this.rooms.get(code);
    if (!room || !room.trade) return null;
    const sideKey = side === 'a' ? 'a' : 'b';
    const trade = room.trade;
    if (trade[sideKey].id !== playerId) return null;
    trade[sideKey].locked = !trade[sideKey].locked;
    // If a player locked, check if the OTHER side needs to be unlocked
    if (trade[sideKey].locked) {
      // Unlock the other side if both were locked (reset scenario)
    }
    return {
      side: sideKey,
      locked: trade[sideKey].locked,
      bothLocked: trade.a.locked && trade.b.locked,
    };
  }

  executeTrade(code) {
    const room = this.rooms.get(code);
    if (!room || !room.trade || !room.gameState) return null;
    const trade = room.trade;
    if (!trade.a.locked || !trade.b.locked) return null;
    const gs = room.gameState;
    const pA = gs.players.find(p => p.id === trade.a.id);
    const pB = gs.players.find(p => p.id === trade.b.id);
    if (!pA || !pB) return null;

    // Validate cash
    if (trade.a.cash > pA.money || trade.b.cash > pB.money) return null;

    // Transfer cash
    pA.money -= trade.a.cash;
    pB.money += trade.a.cash;
    pB.money -= trade.b.cash;
    pA.money += trade.b.cash;

    // Transfer properties
    trade.a.propIds.forEach(pid => {
      const sq = gs.boardSquares.find(s => s.id === pid);
      if (sq && sq.owner === pA.id) sq.owner = pB.id;
    });
    trade.b.propIds.forEach(pid => {
      const sq = gs.boardSquares.find(s => s.id === pid);
      if (sq && sq.owner === pB.id) sq.owner = pA.id;
    });

    room.trade = null;
    return { aName: pA.name, bName: pB.name };
  }
}

function socketToRoom(io, roomCode, excludeId) {
  return io.to(roomCode).except(excludeId);
}
