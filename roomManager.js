import { GameEngine } from './gameEngine.js';

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.tradeRateLimits = new Map();
  }

  findTrade(room, playerId1, playerId2) {
    const tid = [playerId1, playerId2].sort().join(':');
    return (room.trades || []).find(t => {
      const tkey = [t.players.a, t.players.b].sort().join(':');
      return tkey === tid;
    }) || null;
  }
  playerInTrade(room, playerId) {
    return (room.trades || []).find(t => t.players.a === playerId || t.players.b === playerId) || null;
  }

  createRoom(hostId, hostName, avatar) {
    let code;
    do { code = generateRoomCode(); } while (this.rooms.has(code));
    const room = {
      code,
      players: [{ id: hostId, name: hostName, avatar: avatar || 1, connected: true }],
      kicked: new Set(),
      gameState: null,
      timer: null,
      trades: [],
      turnTimer: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  createRoomFromState(code, gameState) {
    if (this.rooms.has(code)) return null;
    const room = {
      code,
      players: [],
      kicked: new Set(),
      gameState,
      timer: null,
      trades: [],
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
    if (room.kicked.has(playerName)) return { ok: false, error: 'You were removed from this game' };
    // Rejoin if player exists and is disconnected
    const existing = room.players.find(p => p.name === playerName && !p.connected);
    if (existing) {
      existing.id = playerId;
      existing.connected = true;
      return { ok: true, room, rejoined: true };
    }
    if (room.gameState) return { ok: false, error: 'Game already started' };
    if (room.players.length >= 6) return { ok: false, error: 'Room is full (max 6)' };
    if (room.players.find(p => p.id === playerId)) return { ok: false, error: 'Already in room' };
    room.players.push({ id: playerId, name: playerName, avatar: avatar || 1, connected: true });
    return { ok: true, room };
  }

  removePlayer(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== playerId);
  }

  disconnectPlayer(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) player.connected = false;
    // Also update gameState player if game is active
    if (room.gameState) {
      const gp = room.gameState.players.find(p => p.id === playerId);
      if (gp) gp.connected = false;
    }
  }

  rejoinPlayer(code, oldPlayerId, newSocketId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players.find(p => p.id === oldPlayerId && !p.connected);
    if (!player) return null;
    player.id = newSocketId;
    player.connected = true;
    // Also update gameState player
    if (room.gameState) {
      const gp = room.gameState.players.find(p => p.id === oldPlayerId);
      if (gp) gp.connected = true;
    }
    return { player, gameState: room.gameState, players: room.players };
  }

  terminatePlayer(code, hostId, targetId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const host = room.players[0];
    if (!host || host.id !== hostId) return null;
    const idx = room.players.findIndex(p => p.id === targetId);
    if (idx === -1) return null;
    const target = room.players[idx];
    if (room.gameState) {
      const gs = room.gameState;
      const player = gs.players.find(p => p.id === targetId);
      if (player && !player.isBankrupt) {
        const remaining = gs.players.filter(p => p.id !== targetId && !p.isBankrupt);
        if (remaining.length > 0 && player.money > 0) {
          const share = Math.floor(player.money / remaining.length);
          remaining.forEach(p => p.money += share);
        }
        player.money = 0;
        gs.boardSquares.forEach(sq => {
          if (sq.owner === targetId) sq.owner = null;
        });
        player.isBankrupt = true;
      }
      const gsIdx = gs.players.findIndex(p => p.id === targetId);
      if (gsIdx !== -1) gs.players.splice(gsIdx, 1);
    }
    room.kicked.add(target.name);
    room.players.splice(idx, 1);
    return { players: room.players, gameState: room.gameState };
  }

  destroyRoom(code) {
    const room = this.rooms.get(code);
    if (room) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      (room.trades || []).forEach(t => { if (t.timer) clearTimeout(t.timer); });
      this.rooms.delete(code);
    }
  }

  // ── Game lifecycle ──

  startGame(code) {
    const room = this.rooms.get(code);
    if (!room || room.players.length < 2) return false;
    const engine = new GameEngine(room.players, { ...room.options, testMode: false });
    engine.initGame();
    room.gameState = engine.state;
    room.engine = engine;
    return true;
  }

  // ── Turn timer ──

  startTurnTimer(code, io, durationSecs) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState) return;
    if (room.turnTimer) clearTimeout(room.turnTimer);
    const duration = durationSecs || 90;
    room.gameState.timerSeconds = duration;
    room.gameState.timerRunning = true;
    io.to(code).emit('timer_sync', { seconds: duration, running: true });

    let secs = duration;
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

  resetTurnTimer(room, code, io, durationSecs) {
    this.stopTurnTimer(room);
    this.startTurnTimer(code, io, durationSecs);
  }

  autoPass(room, code, io) {
    if (!room.gameState || room.gameState.gameOver) return;
    const gs = room.gameState;
    const player = gs.players[gs.currentPlayerIndex];
    if (!player) return;

    const phase = gs.phase;
    if (phase === 'roll') {
      const result = this.handleRollDice(code, player.id);
      if (result) {
        io.to(code).emit('dice_rolled', result);
        this.handleLanding(code, player.id, result, io);
      }
    } else if (phase === 'club_choice') {
      this.resolveClubChoice(code, player.id, 'guest');
    } else if (phase === 'property_choice') {
      const { pendingPropertyBuy } = gs;
      if (pendingPropertyBuy) {
        pendingPropertyBuy.resolved = true;
        gs.pendingPropertyBuy = null;
        this.finishTurn(room, code, io);
      }
    } else if (phase === 'rent_payment') {
      const rent = gs.pendingRentPayment;
      if (rent) {
        const renter = gs.players.find(p => p.id === rent.playerId);
        const owner = gs.players.find(p => p.id === rent.ownerId);
        if (renter) {
          if (renter.money >= rent.amount) {
            renter.money -= rent.amount;
            if (owner && !owner.isBankrupt) owner.money += rent.amount;
          } else {
            // Can't pay — force bankruptcy
            if (owner && renter.money > 0) {
              owner.money += renter.money;
              renter.money = 0;
            }
            gs.boardSquares.forEach(sq => {
              if (sq.owner === renter.id) { sq.owner = null; sq.upgrade = null; }
            });
            renter.position = 25;
            renter.statusEffects.missedTurnsRemaining = 5;
          }
        }
        gs.pendingRentPayment = null;
      }
      this.finishTurn(room, code, io);
    } else if (phase === 'blind_card') {
      this.resolveBlindCard(code, player.id, io);
    } else if (phase === 'card_choice') {
      this.resolveCardChoice(code, player.id, 0);
    }
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

    room.engine.evaluateLanding(player);
    io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });

    // Splash texts for special squares
    const square = gs.boardSquares.find(s => s.id === player.position);
    if (square?.id === 18) {
      io.to(code).emit('splash_text', { text: '🚌 Fast Bus — Double Next Roll!', type: '' });
    } else if (square?.id === 25) {
      io.to(code).emit('splash_text', { text: '🔒 Sent to Prison!', type: 'loss' });
    }

    const phase = gs.phase;
    if (phase === 'draw_card') {
      const deckLabel = gs.pendingDeckDraw?.deckType === 'dual' ? '⚖️ المحكمة + 🍀 حظك' :
        gs.pendingDeckDraw?.deckType === 'mahkama' ? '⚖️ المحكمة' : '🍀 حظك';
      io.to(code).emit('action_log', { message: `🃏 ${player.name} landed on ${deckLabel} — click a deck pile to draw!` });
      io.to(playerId).emit('landed_on_deck', { deckLabel });
      this.resetTurnTimer(room, code, io);
    } else if (phase === 'blind_card') {
      const bs = this.io.to(playerId);
      bs.emit('private_card', {
        card: gs.blindCard.card,
        cardNumber: gs.blindCard.cardNumber || 1,
        squareName: gs.blindCard.squareName,
        deckType: gs.blindCard.deckType || 'hazak',
        pendingSecondCard: !!gs.pendingSecondCard,
        cityNames: gs.blindCard.cityNames || [],
      });
      socketToRoom(io, code, playerId).emit('other_drawing', { playerName: player.name });
      this.resetTurnTimer(room, code, io);
    } else if (phase === 'club_choice' || phase === 'card_choice' || phase === 'upgrade_choice') {
      this.resetTurnTimer(room, code, io);
    } else if (phase === 'property_choice') {
      this.resetTurnTimer(room, code, io);
    } else if (phase === 'rent_payment') {
      this.resetTurnTimer(room, code, io, 120);
    } else if (phase === 'done' || gs.gameOver) {
      this.advanceTurn(room, code, io);
    } else if (phase === 'roll') {
      this.startTurnTimer(code, io);
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

  handleDrawCard(code, playerId, deckType) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return null;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === playerId);
    if (!player) return null;
    if (gs.phase !== 'draw_card') return null;
    return room.engine.handleDrawCard(playerId, deckType);
  }

  resolveBlindCard(code, playerId, io) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return null;
    const gs = room.gameState;
    if (!gs.blindCard) return null;

    const { card, playerId: pid, deckType } = gs.blindCard;
    const player = gs.players.find(p => p.id === pid);
    if (!player) { gs.blindCard = null; this.finishTurn(room, code, io); return null; }

    gs.blindCard = null;

    room.engine.handleCardEffect(card, playerId);
    const outcome = { description: card.description, playerName: player.name, deckType: deckType || 'hazak' };

    if (gs.activeCardChoice) {
      io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
      this.resetTurnTimer(room, code, io);
      return outcome;
    }

    this.finishTurn(room, code, io);
    return outcome;
  }

  resolveCardChoice(code, playerId, choiceIndex) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.resolveCardChoice(choiceIndex);
    this.finishTurn(room, code, this.io);
  }

  resolveClubChoice(code, playerId, choice) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    const gs = room.gameState;
    room.engine.resolveClubChoice(choice);
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
      this.io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
    } else {
      this.advanceTurn(room, code, this.io);
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
    this.io.to(code).emit('state_update', { gameState: gs, phase: gs.phase });
  }

  buyUpgrade(code, playerId, propertyId, upgradeType) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    const ok = room.engine.purchaseUpgrade(playerId, propertyId, upgradeType);
    if (ok) {
      room.gameState.pendingUpgradeChoice = null;
    }
    return ok;
  }

  sellUpgrade(code, playerId, propertyId) {
    const room = this.rooms.get(code);
    if (!room || !room.engine || !room.gameState) return;
    room.engine.sellUpgrade(playerId, propertyId);
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

  // ════════════════════════════════════════════
  //  NEW TRADE SYSTEM
  // ════════════════════════════════════════════

  checkTradeRateLimit(playerId) {
    const now = Date.now();
    const entry = this.tradeRateLimits.get(playerId);
    if (!entry || now > entry.resetAt) {
      this.tradeRateLimits.set(playerId, { count: 1, resetAt: now + 60000 });
      return { ok: true, remaining: 2 };
    }
    if (entry.count >= 3) {
      const waitSec = Math.ceil((entry.resetAt - now) / 1000);
      return { ok: false, remaining: 0, waitSec };
    }
    entry.count++;
    return { ok: true, remaining: 3 - entry.count };
  }

  initTrade(code, initiatorId, partnerId) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState) return null;
    if (this.playerInTrade(room, initiatorId) || this.playerInTrade(room, partnerId)) return null;
    const gs = room.gameState;
    const initiator = gs.players.find(p => p.id === initiatorId);
    const partner = gs.players.find(p => p.id === partnerId);
    if (!initiator || !partner || initiator.isBankrupt || partner.isBankrupt) return null;

    const rateCheck = this.checkTradeRateLimit(initiatorId);
    if (!rateCheck.ok) return { error: 'rate_limited', waitSec: rateCheck.waitSec };

    const tradeId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const trade = {
      id: tradeId,
      players: { a: initiatorId, b: partnerId },
      proposalA: null,
      proposalB: null,
      acceptedA: false,
      acceptedB: false,
      state: 'proposing_a',
      createdAt: Date.now(),
      timer: null,
    };
    if (!room.trades) room.trades = [];
    room.trades.push(trade);

    this.startTradeTimer(room, code, trade, 60);

    return {
      tradeId,
      state: 'proposing_a',
      initiatorId,
      initiator: { id: initiatorId, name: initiator.name, avatar: initiator.avatar, money: initiator.money },
      partner: { id: partnerId, name: partner.name, avatar: partner.avatar, money: partner.money },
      proposalA: null,
      proposalB: null,
    };
  }

  startTradeTimer(room, code, trade, seconds) {
    if (trade.timer) clearTimeout(trade.timer);
    const tradeId = trade.id;
    trade.timer = setTimeout(() => {
      const t = (room.trades || []).find(tr => tr.id === tradeId);
      if (t) {
        if (t.timer) clearTimeout(t.timer);
        room.trades = (room.trades || []).filter(tr => tr.id !== tradeId);
      }
      this.io.to(trade.players.a).to(trade.players.b).emit('trade_cancelled', { reason: 'timeout' });
    }, seconds * 1000);
    this.io.to(trade.players.a).to(trade.players.b).emit('trade_timer_sync', { seconds, running: true });
  }

  sendTradeProposal(code, playerId, proposal) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState) return null;
    const tr = this.playerInTrade(room, playerId);
    if (!tr) return null;
    const gs = room.gameState;

    const isA = playerId === tr.players.a;
    const expectedState = isA ? 'proposing_a' : 'proposing_b';
    if (tr.state !== expectedState) return null;

    const player = gs.players.find(p => p.id === playerId);
    if (!player) return null;

    const cash = Math.max(0, Math.min(proposal.cash || 0, player.money));
    const propIds = (proposal.propIds || []).filter(id => {
      const sq = gs.boardSquares.find(s => s.id === id);
      return sq && sq.owner === playerId && (!sq.upgrade);
    });
    const jailCards = Math.max(0, Math.min(proposal.jailCards || 0, player.inventory.jailFreeCards || 0));

    if (isA) {
      tr.proposalA = { cash, propIds, jailCards, submitted: true };
      tr.acceptedB = false;
      tr.state = 'reviewing_b';
    } else {
      tr.proposalB = { cash, propIds, jailCards, submitted: true };
      tr.acceptedA = false;
      tr.state = 'reviewing_a';
    }

    this.resetTradeTimer(room, code, tr);

    return {
      tradeId: tr.id,
      state: tr.state,
      proposalA: tr.proposalA,
      proposalB: tr.proposalB,
      acceptedA: tr.acceptedA,
      acceptedB: tr.acceptedB,
      fromPlayerId: playerId,
      _participants: [tr.players.a, tr.players.b],
    };
  }

  acceptTradeProposal(code, playerId) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState) return null;
    const tr = this.playerInTrade(room, playerId);
    if (!tr) return null;

    if (tr.state === 'reviewing_b' && playerId === tr.players.b) {
      tr.acceptedB = true;
      tr.state = 'proposing_b';
      return { tradeId: tr.id, state: tr.state, accepted: true, side: 'b', _participants: [tr.players.a, tr.players.b] };
    }

    if (tr.state === 'reviewing_a' && playerId === tr.players.a) {
      tr.acceptedA = true;
      if (tr.proposalA && tr.proposalB && tr.acceptedA && tr.acceptedB) {
        return this.executeTrade(code, tr);
      }
      return { tradeId: tr.id, state: tr.state, accepted: true, side: 'a', _participants: [tr.players.a, tr.players.b] };
    }

    return null;
  }

  declineTradeProposal(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const tr = this.playerInTrade(room, playerId);
    if (!tr) return null;

    if (tr.state === 'reviewing_b' && playerId === tr.players.b) {
      tr.state = 'proposing_a';
      return { tradeId: tr.id, state: tr.state, declined: true, side: 'b', _participants: [tr.players.a, tr.players.b] };
    }

    if (tr.state === 'reviewing_a' && playerId === tr.players.a) {
      tr.state = 'proposing_b';
      return { tradeId: tr.id, state: tr.state, declined: true, side: 'a', _participants: [tr.players.a, tr.players.b] };
    }

    return null;
  }

  cancelTrade(code, playerId, reason = 'cancelled') {
    const room = this.rooms.get(code);
    if (!room) return null;
    // Find any trade involving this player
    const tr = playerId ? this.playerInTrade(room, playerId) : (room.trades && room.trades.length > 0 ? room.trades[0] : null);
    if (!tr) return null;

    if (tr.timer) clearTimeout(tr.timer);
    if (room.trades) room.trades = room.trades.filter(t => t !== tr);
    return { reason, _participants: [tr.players.a, tr.players.b] };
  }

  resetTradeTimer(room, code, tr) {
    if (tr?.timer) {
      clearTimeout(tr.timer);
      this.startTradeTimer(room, code, tr, 60);
    }
  }

  executeTrade(code, tr) {
    const room = this.rooms.get(code);
    if (!room || !room.gameState || !tr) return null;
    const gs = room.gameState;

    if (!tr.proposalA || !tr.proposalB) return null;

    const pA = gs.players.find(p => p.id === tr.players.a);
    const pB = gs.players.find(p => p.id === tr.players.b);
    if (!pA || !pB) {
      if (tr.timer) clearTimeout(tr.timer);
      if (room.trades) room.trades = room.trades.filter(t => t !== tr);
      return null;
    }

    const aCost = tr.proposalA.cash;
    const bCost = tr.proposalB.cash;
    if (aCost > pA.money || bCost > pB.money) return null;

    pA.money -= tr.proposalA.cash;
    pB.money += tr.proposalA.cash;
    tr.proposalA.propIds.forEach(pid => {
      const sq = gs.boardSquares.find(s => s.id === pid);
      if (sq && sq.owner === pA.id) sq.owner = pB.id;
    });
    pA.inventory.jailFreeCards = Math.max(0, (pA.inventory.jailFreeCards || 0) - tr.proposalA.jailCards);
    pB.inventory.jailFreeCards = (pB.inventory.jailFreeCards || 0) + tr.proposalA.jailCards;

    pB.money -= tr.proposalB.cash;
    pA.money += tr.proposalB.cash;
    tr.proposalB.propIds.forEach(pid => {
      const sq = gs.boardSquares.find(s => s.id === pid);
      if (sq && sq.owner === pB.id) sq.owner = pA.id;
    });
    pB.inventory.jailFreeCards = Math.max(0, (pB.inventory.jailFreeCards || 0) - tr.proposalB.jailCards);
    pA.inventory.jailFreeCards = (pA.inventory.jailFreeCards || 0) + tr.proposalB.jailCards;

    tr.state = 'executed';
    if (tr.timer) clearTimeout(tr.timer);
    if (room.trades) room.trades = room.trades.filter(t => t !== tr);

    return { aName: pA.name, bName: pB.name, aId: pA.id, bId: pB.id, _participants: [pA.id, pB.id] };
  }

  getTradeState(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const tr = playerId ? this.playerInTrade(room, playerId) : null;
    if (!tr) return null;
    return {
      tradeId: tr.id,
      players: tr.players,
      state: tr.state,
      proposalA: tr.proposalA,
      proposalB: tr.proposalB,
      acceptedA: tr.acceptedA,
      acceptedB: tr.acceptedB,
    };
  }

  // ════════════════════════════════════════════
  //  BID SYSTEM
  // ════════════════════════════════════════════

  createBid(roomCode, playerId, cash, propIds, jailCards = 0) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.gameState) return null;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.isBankrupt) return null;

    // One active bid per player
    if (gs.activeBids?.some(b => b.playerId === playerId)) return null;

    const validCash = Math.max(0, Math.min(cash || 0, player.money));
    const validProps = (propIds || []).filter(id => {
      const sq = gs.boardSquares.find(s => s.id === id);
      return sq && sq.owner === playerId && (!sq.upgrade);
    });
    const validJail = Math.max(0, Math.min(jailCards || 0, player.inventory.jailFreeCards || 0));

    if (validCash === 0 && validProps.length === 0 && validJail === 0) return null;

    const bid = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 4),
      playerId,
      playerName: player.name,
      avatar: player.avatar,
      cash: validCash,
      propIds: validProps,
      jailCards: validJail,
      offers: [],
      createdAt: Date.now(),
    };

    if (!gs.activeBids) gs.activeBids = [];
    gs.activeBids.push(bid);
    return bid;
  }

  respondToBid(roomCode, bidId, playerId, cash, propIds, jailCards = 0) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.gameState) return null;
    const gs = room.gameState;
    if (!gs.activeBids) return null;

    const bid = gs.activeBids.find(b => b.id === bidId);
    if (!bid || bid.playerId === playerId) return null;

    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.isBankrupt) return null;

    const validCash = Math.max(0, Math.min(cash || 0, player.money));
    const validProps = (propIds || []).filter(id => {
      const sq = gs.boardSquares.find(s => s.id === id);
      return sq && sq.owner === playerId && (!sq.upgrade);
    });
    const validJail = Math.max(0, Math.min(jailCards || 0, player.inventory.jailFreeCards || 0));

    if (validCash === 0 && validProps.length === 0 && validJail === 0) return null;

    const offer = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 4),
      playerId,
      playerName: player.name,
      avatar: player.avatar,
      cash: validCash,
      propIds: validProps,
      jailCards: validJail,
    };

    bid.offers.push(offer);
    return { bidId, offer };
  }

  acceptBidOffer(roomCode, bidId, offerId, acceptPlayerId) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.gameState) return null;
    const gs = room.gameState;
    if (!gs.activeBids) return null;

    const bid = gs.activeBids.find(b => b.id === bidId);
    if (!bid || bid.playerId !== acceptPlayerId) return null;

    const offer = bid.offers.find(o => o.id === offerId);
    if (!offer) return null;

    const bidder = gs.players.find(p => p.id === bid.playerId);
    const offerer = gs.players.find(p => p.id === offer.playerId);
    if (!bidder || !offerer) return null;

    // Validate funds
    if (bid.cash > bidder.money || offer.cash > offerer.money) return null;

    // Execute bid: bidder gives cash+props+jail to offerer, offerer gives cash+props+jail to bidder
    bidder.money -= bid.cash;
    offerer.money += bid.cash;
    bid.propIds.forEach(pid => {
      const sq = gs.boardSquares.find(s => s.id === pid);
      if (sq && sq.owner === bidder.id) sq.owner = offerer.id;
    });
    bidder.inventory.jailFreeCards = (bidder.inventory.jailFreeCards || 0) - (bid.jailCards || 0);
    offerer.inventory.jailFreeCards = (offerer.inventory.jailFreeCards || 0) + (bid.jailCards || 0);

    offerer.money -= offer.cash;
    bidder.money += offer.cash;
    offer.propIds.forEach(pid => {
      const sq = gs.boardSquares.find(s => s.id === pid);
      if (sq && sq.owner === offerer.id) sq.owner = bidder.id;
    });
    offerer.inventory.jailFreeCards = (offerer.inventory.jailFreeCards || 0) - (offer.jailCards || 0);
    bidder.inventory.jailFreeCards = (bidder.inventory.jailFreeCards || 0) + (offer.jailCards || 0);

    gs.activeBids = gs.activeBids.filter(b => b.id !== bidId);
    return { bidderName: bidder.name, offererName: offerer.name };
  }

  cancelBid(roomCode, bidId, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.gameState) return false;
    const gs = room.gameState;
    if (!gs.activeBids) return false;
    const idx = gs.activeBids.findIndex(b => b.id === bidId && b.playerId === playerId);
    if (idx === -1) return false;
    gs.activeBids.splice(idx, 1);
    return true;
  }

  getBidsForPlayer(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.gameState) return [];
    const gs = room.gameState;
    return (gs.activeBids || []).filter(b => b.playerId !== playerId);
  }
}

function socketToRoom(io, roomCode, excludeId) {
  return io.to(roomCode).except(excludeId);
}
