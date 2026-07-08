import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { networkInterfaces } from 'os';
import { RoomManager } from './roomManager.js';

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Serve the pre-built client (run `npm run build` before playing with friends)
app.use(express.static('dist'));
// Fallback to current dir for dev
app.use(express.static('.'));

const manager = new RoomManager(io);

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── Lobby ──

  socket.on('host_game', ({ playerName, avatar, options }, cb) => {
    const playerId = socket.id;
    const room = manager.createRoom(playerId, playerName, avatar);
    room.options = options || { startingCash: 1500, diceCount: 2, moneyVisible: true };
    socket.join(room.code);
    socket.emit('room_created', {
      roomCode: room.code,
      playerId,
      players: room.players,
    });
    console.log(`[host] ${playerName} → room ${room.code}`, room.options);
    if (cb) cb({ ok: true, roomCode: room.code, playerId });
  });

  socket.on('join_game', ({ roomCode, playerName, avatar }, cb) => {
    const playerId = socket.id;
    const result = manager.joinRoom(roomCode, playerId, playerName, avatar);
    if (!result.ok) {
      if (cb) cb({ ok: false, error: result.error });
      return;
    }
    socket.join(roomCode);
    io.to(roomCode).emit('update_players', { players: result.room.players });
    socket.emit('joined', { roomCode, playerId, players: result.room.players });
    console.log(`[join] ${playerName} → room ${roomCode}`);
    if (cb) cb({ ok: true, roomCode, playerId, players: result.room.players });
  });

  socket.on('leave_room', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room) return;
    manager.removePlayer(roomCode, socket.id);
    socket.leave(roomCode);
    io.to(roomCode).emit('update_players', { players: room.players });
    if (room.players.length === 0) {
      manager.destroyRoom(roomCode);
    }
  });

  // ── Game control ──

  socket.on('start_game', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room) return;
    const host = room.players[0];
    if (!host || host.id !== socket.id) return;
    const ok = manager.startGame(roomCode);
    if (!ok) return;
    // Broadcast full game state to everyone
    io.to(roomCode).emit('game_started', { gameState: room.gameState });
    // Start the first turn timer
    manager.startTurnTimer(roomCode, io);
  });

  // ── Game actions ──

  socket.on('roll_dice', ({ roomCode }, cb) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) { if (cb) cb({ ok: false }); return; }
    const result = manager.handleRollDice(roomCode, socket.id);
    if (!result) { if (cb) cb({ ok: false }); return; }
    // Broadcast dice result + animation path + landing
    io.to(roomCode).emit('dice_rolled', result);
    if (cb) cb({ ok: true });
  });

  socket.on('debug_roll', ({ roomCode, targetId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const host = room.players[0];
    if (!host || host.id !== socket.id) return;
    if (gs.phase !== 'roll') return;
    const player = gs.players[gs.currentPlayerIndex];
    if (!player) return;
    const destId = targetId || 1;
    const validIds = gs.boardSquares.map(sq => sq.id);
    const bestId = validIds.includes(destId) ? destId : 1;
    const oldPos = player.position;
    player.position = bestId;
    gs.lastRoll = { die1: 0, die2: 0, total: 0, newPos: bestId, path: [bestId], playerId: socket.id, passedGo: bestId < oldPos };
    gs.phase = 'rolling';
    io.to(roomCode).emit('dice_rolled', gs.lastRoll);
  });

  socket.on('confirm_landing', ({ roomCode, rollResult }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    // Only the current player can confirm their landing
    const gs = room.gameState;
    const current = gs.players[gs.currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    // Log dice values after animation completes
    if (rollResult) {
      const roller = gs.players.find(p => p.id === socket.id);
      if (roller) actionLog(roomCode, `🎲 ${roller.name} rolled ${rollResult.die1}+${rollResult.die2}=${rollResult.total}`);
    }
    manager.handleLanding(roomCode, socket.id, rollResult, io);
  });

  socket.on('buy_property', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const sq = gs.pendingPropertyBuy?.square;
    const player = gs.players.find(p => p.id === socket.id);
    manager.resolvePropertyBuy(roomCode, socket.id, true);
    if (player && sq) actionLog(roomCode, `🏠 ${player.name} bought ${sq.name}`);
    broadcastState(roomCode);
  });

  socket.on('decline_property', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const sq = gs.pendingPropertyBuy?.square;
    const player = gs.players.find(p => p.id === socket.id);
    manager.resolvePropertyBuy(roomCode, socket.id, false);
    if (player && sq) actionLog(roomCode, `🚫 ${player.name} declined ${sq.name}`);
    broadcastState(roomCode);
  });

  socket.on('pay_rent', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const rent = gs.pendingRentPayment;
    const player = gs.players.find(p => p.id === socket.id);
    const owner = rent ? gs.players.find(p => p.id === rent.ownerId) : null;
    manager.resolveRent(roomCode, socket.id);
    if (player && rent) actionLog(roomCode, `💰 ${player.name} paid $${rent.amount} rent to ${owner ? owner.name : 'Bank'}`);
    broadcastState(roomCode);
  });

  socket.on('sell_to_bank_for_rent', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player || !gs.pendingRentPayment) return;
    // Auto-sell all properties to bank until player can afford rent
    const rent = gs.pendingRentPayment;
    const owned = gs.boardSquares.filter(s => s.owner === socket.id);
    for (const sq of [...owned]) {
      if (player.money >= rent.amount) break;
      if (sq.upgrade) room.engine.sellUpgrade(socket.id, sq.id);
      room.engine.sellPropertyToBank(socket.id, sq.id);
    }
    if (player.money >= rent.amount) {
      manager.resolveRent(roomCode, socket.id);
      actionLog(roomCode, `🏚️ ${player.name} sold properties to pay $${rent.amount} rent`);
    } else {
      // Still can't pay — all money goes to owner, then forced jail
      const owner = gs.players.find(p => p.id === rent.ownerId);
      if (owner && player.money > 0) {
        owner.money += player.money;
        actionLog(roomCode, `💰 ${player.name}'s remaining $${player.money} goes to ${owner.name}`);
        player.money = 0;
      }
      // Force bankruptcy / jail
      gs.boardSquares.forEach(sq => {
        if (sq.owner === socket.id) { sq.owner = null; sq.upgrade = null; }
      });
      player.isBankrupt = false;
      player.position = 25; // Go to jail
      player.statusEffects.missedTurnsRemaining = 5;
      gs.pendingRentPayment = null;
      actionLog(roomCode, `🔒 ${player.name} couldn't pay — all properties to bank, forced 5 turns in jail`);
      manager.finishTurn(room, roomCode, io);
    }
    broadcastState(roomCode);
  });

  socket.on('declare_bankrupt_from_rent', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player || !gs.pendingRentPayment) return;
    const rent = gs.pendingRentPayment;
    const owner = gs.players.find(p => p.id === rent.ownerId);
    // All money goes to owner
    if (owner && player.money > 0) {
      owner.money += player.money;
      actionLog(roomCode, `💰 ${player.name}'s $${player.money} goes to ${owner.name}`);
      player.money = 0;
    }
    // All properties to bank
    gs.boardSquares.forEach(sq => {
      if (sq.owner === socket.id) { sq.owner = null; sq.upgrade = null; }
    });
    // Go to jail for 5 turns
    player.position = 25;
    player.statusEffects.missedTurnsRemaining = 5;
    player.isBankrupt = false;
    gs.pendingRentPayment = null;
    actionLog(roomCode, `🔒 ${player.name} declared bankruptcy — 5 turns in jail`);
    manager.finishTurn(room, roomCode, io);
    broadcastState(roomCode);
  });

  socket.on('draw_card', ({ roomCode, deckType }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const result = manager.handleDrawCard(roomCode, socket.id, deckType);
    if (!result) return;
    const cardInfo = {
      card: result.card,
      cardNumber: result.cardNumber,
      squareName: gs.blindCard?.squareName || '',
      deckType: result.deckType,
      pendingSecondCard: result.pendingSecondCard,
      cityNames: result.cityNames || [],
    };
    // Send private card to the drawing player immediately
    io.to(socket.id).emit('private_card', cardInfo);
    io.to(roomCode).except(socket.id).emit('other_drawing', { playerName: player.name });
    // Broadcast card to all other players immediately
    io.to(roomCode).except(socket.id).emit('public_card_draw', {
      ...cardInfo,
      playerName: player.name,
    });
    actionLog(roomCode, `🃏 ${player.name} is reading a card...`);
    broadcastState(roomCode);
  });

  socket.on('confirm_blind_card', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    // Notify others to close the public card view
    io.to(roomCode).except(socket.id).emit('close_public_card');
    const outcome = manager.resolveBlindCard(roomCode, socket.id, io);
    if (outcome) {
      io.to(roomCode).emit('card_outcome', outcome);
      actionLog(roomCode, `🃏 ${outcome.playerName}: ${outcome.description}`);
    }
    // Check for city owner card details to broadcast
    const gs = room?.gameState;
    if (gs && gs.pendingCityOwnersCard) {
      const cityInfo = gs.pendingCityOwnersCard;
      const cityStr = cityInfo.cityNames.join('، ');
      actionLog(roomCode, `🏙️ ${cityStr} — collected $${cityInfo.totalCollected}`);
      gs.pendingCityOwnersCard = null;
    }
    broadcastState(roomCode);
  });

  socket.on('card_choice', ({ roomCode, choiceIndex }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    manager.resolveCardChoice(roomCode, socket.id, choiceIndex);
    if (player) actionLog(roomCode, `⚖️ ${player.name} made a card choice`);
    broadcastState(roomCode);
  });

  socket.on('skip_prison', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    manager.skipPrison(roomCode, socket.id);
    if (player) actionLog(roomCode, `⏭️ ${player.name} skipped prison turn`);
    broadcastState(roomCode);
  });

  socket.on('use_jail_free', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    manager.useJailFreeCard(roomCode, socket.id);
    if (player) {
      actionLog(roomCode, `🔓 ${player.name} used a jail-free card`);
      io.to(socket.id).emit('splash_text', { text: '🔓 Jail Free!', type: 'celebrate' });
    }
    broadcastState(roomCode);
  });

  socket.on('pay_bail', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    manager.payBail(roomCode, socket.id);
    if (player) actionLog(roomCode, `💰 ${player.name} paid bail`);
    broadcastState(roomCode);
  });

  socket.on('buy_upgrade', ({ roomCode, propertyId, upgradeType }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    const sq = gs.boardSquares.find(s => s.id === propertyId);
    const ok = manager.buyUpgrade(roomCode, socket.id, propertyId, upgradeType);
    if (ok && player && sq) actionLog(roomCode, `🏗️ ${player.name} built ${upgradeType} on ${sq.name}`);
    if (ok) {
      gs.pendingUpgradeChoice = null;
      manager.finishTurn(room, roomCode, io);
    }
    broadcastState(roomCode);
  });

  socket.on('sell_upgrade', ({ roomCode, propertyId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    const sq = gs.boardSquares.find(s => s.id === propertyId);
    manager.sellUpgrade(roomCode, socket.id, propertyId);
    if (player && sq) actionLog(roomCode, `🏗️ ${player.name} sold upgrade on ${sq.name}`);
    broadcastState(roomCode);
  });

  socket.on('sell_property', ({ roomCode, propertyId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    const sq = gs.boardSquares.find(s => s.id === propertyId);
    manager.sellPropertyToBank(roomCode, socket.id, propertyId);
    if (player && sq) actionLog(roomCode, `🏚️ ${player.name} sold ${sq.name} to bank`);
    broadcastState(roomCode);
  });

  // ── Trade (v2 — mutual proposal system) ──

  socket.on('trade_request', ({ roomCode, targetId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const initiator = gs.players.find(p => p.id === socket.id);
    const partner = gs.players.find(p => p.id === targetId);
    if (!initiator || !partner || initiator.isBankrupt || partner.isBankrupt) {
      socket.emit('trade_error', { message: 'Trade could not be started' });
      return;
    }
    // Check trade timing restriction
    if (room.options?.tradeTiming === 'own_turn') {
      const currentPlayer = gs.players[gs.currentPlayerIndex];
      if (!currentPlayer || currentPlayer.id !== socket.id) {
        socket.emit('trade_error', { message: '⏳ You can only trade on your own turn' });
        return;
      }
    }
    // Send trade request notification to the partner
    io.to(targetId).emit('trade_request_notify', {
      initiatorId: socket.id,
      initiatorName: initiator.name,
      initiatorAvatar: initiator.avatar,
    });
    socket.emit('trade_request_sent', { partnerName: partner.name });
    actionLog(roomCode, `🤝 ${initiator.name} sent a trade request to ${partner.name}`);
  });

  socket.on('accept_trade_request', ({ roomCode, initiatorId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const result = manager.initTrade(roomCode, initiatorId, socket.id);
    if (!result) {
      socket.emit('trade_error', { message: 'Trade could not be started' });
      return;
    }
    if (result.error === 'rate_limited') {
      socket.emit('trade_error', { message: `⏳ Wait ${result.waitSec}s before trading again` });
      return;
    }
    // Send to both participants only
    io.to(result.initiator.id).to(result.partner.id).emit('trade_opened', result);
  });

  socket.on('decline_trade_request', ({ roomCode, initiatorId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const initiator = gs.players.find(p => p.id === initiatorId);
    const partner = gs.players.find(p => p.id === socket.id);
    if (initiator) {
      io.to(initiatorId).emit('trade_request_declined', { partnerName: partner?.name || 'Unknown' });
    }
    actionLog(roomCode, `❌ ${partner?.name || 'Unknown'} declined the trade request`);
  });

  socket.on('trade_send_proposal', ({ roomCode, cash, propIds, jailCards }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !manager.playerInTrade(room, socket.id)) return;
    const result = manager.sendTradeProposal(roomCode, socket.id, { cash, propIds, jailCards });
    if (!result) return;
    // Send updated trade state to participants only
    const parts = result._participants || [];
    if (parts.length === 2) io.to(parts[0]).to(parts[1]).emit('trade_state_update', result);
    const sender = room.gameState.players.find(p => p.id === socket.id);
  });

  socket.on('trade_accept_proposal', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !manager.playerInTrade(room, socket.id)) return;
    const result = manager.acceptTradeProposal(roomCode, socket.id);
    if (!result) return;
    if (result.aName) {
      // Trade executed - broadcast to all
      io.to(roomCode).emit('trade_executed', result);
      actionLog(roomCode, `🤝 Trade executed between ${result.aName} and ${result.bName}!`);
      const gs = room.gameState;
      if (gs.pendingRentPayment) {
        const { playerId: renterId, ownerId } = gs.pendingRentPayment;
        if ((result.aId === renterId && result.bId === ownerId) || (result.aId === ownerId && result.bId === renterId)) {
          gs.pendingRentPayment = null;
          actionLog(roomCode, `✅ Rent waived due to trade with owner!`);
        }
      }
      broadcastState(roomCode);
    } else {
      // Send to participants only
      const parts = result._participants || [];
      if (parts.length === 2) io.to(parts[0]).to(parts[1]).emit('trade_state_update', result);
      const accepter = room.gameState.players.find(p => p.id === socket.id);
      if (accepter) actionLog(roomCode, `✅ ${accepter.name} accepted a proposal`);
    }
  });

  socket.on('trade_decline_proposal', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !manager.playerInTrade(room, socket.id)) return;
    const result = manager.declineTradeProposal(roomCode, socket.id);
    if (!result) return;
    const parts = result._participants || [];
    if (parts.length === 2) io.to(parts[0]).to(parts[1]).emit('trade_state_update', result);
    const decliner = room.gameState.players.find(p => p.id === socket.id);
    if (decliner) actionLog(roomCode, `❌ ${decliner.name} declined the proposal`);
  });

  socket.on('trade_cancel', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const result = manager.cancelTrade(roomCode, socket.id);
    if (result) {
      if (room.gameState.pendingRentPayment) {
        room.gameState.phase = 'rent_payment';
      }
      const parts = result._participants || [];
      if (parts.length === 2) io.to(parts[0]).to(parts[1]).emit('trade_cancelled', result);
      broadcastState(roomCode);
    }
  });

  socket.on('skip_upgrade', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    room.gameState.pendingUpgradeChoice = null;
    manager.finishTurn(room, roomCode, io);
    broadcastState(roomCode);
  });

  socket.on('sell_building_in_trade', ({ roomCode, propId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const sq = gs.boardSquares.find(s => s.id === propId);
    if (!sq || sq.owner !== socket.id || !sq.upgrade) return;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const key = sq.upgrade + '_rent';
    const cost = sq.owner_paying?.[key] || 0;
    const refund = Math.round(cost * 0.75);
    player.money += refund;
    sq.upgrade = null;
    actionLog(roomCode, `🏗️ ${player.name} sold upgrade on ${sq.name} for $${refund}`);
    broadcastState(roomCode);
  });

  // ── Club choice ──
  socket.on('club_choice', ({ roomCode, choice }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    manager.resolveClubChoice(roomCode, socket.id, choice);
    if (player) {
      actionLog(roomCode, `🎰 ${player.name} chose ${choice === 'membership' ? 'membership' : 'guest'} at the club`);
      if (choice === 'membership') {
        io.to(socket.id).emit('splash_text', { text: '🎰 Club Member!', type: 'celebrate' });
      }
    }
    broadcastState(roomCode);
  });

  // ── Bid events (v2) ──
  socket.on('create_bid', ({ roomCode, cash, propIds, jailCards }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const bid = manager.createBid(roomCode, socket.id, cash, propIds, jailCards);
    if (!bid) return;
    io.to(roomCode).emit('bid_created', bid);
    actionLog(roomCode, `📢 ${player.name} posted a public bid!`);
  });

  socket.on('bid_respond', ({ roomCode, bidId, cash, propIds, jailCards }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const result = manager.respondToBid(roomCode, bidId, socket.id, cash, propIds, jailCards);
    if (!result) return;
    // Emit the full updated bid
    const bid = gs.activeBids?.find(b => b.id === bidId);
    if (bid) io.to(roomCode).emit('bid_offer_added', bid);
    actionLog(roomCode, `📩 ${player.name} made an offer on a bid`);
  });

  socket.on('bid_accept_offer', ({ roomCode, bidId, offerId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const result = manager.acceptBidOffer(roomCode, bidId, offerId, socket.id);
    if (!result) return;
    io.to(roomCode).emit('bid_executed', { ...result, bidId });
    actionLog(roomCode, `✅ ${result.bidderName} accepted ${result.offererName}'s bid offer!`);
    broadcastState(roomCode);
  });

  socket.on('cancel_bid', ({ roomCode, bidId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const ok = manager.cancelBid(roomCode, bidId, socket.id);
    if (ok) {
      io.to(roomCode).emit('bid_cancelled', { bidId });
      actionLog(roomCode, `🚫 A bid was cancelled`);
    }
  });

  // ── Reconnection ──

  socket.on('restore_game', ({ roomCode, playerName, playerId, gameState }) => {
    let room = manager.getRoom(roomCode);
    if (!room) {
      room = manager.createRoomFromState(roomCode, gameState);
      if (!room) { socket.emit('restore_game_result', { success: false, error: 'Failed to create room' }); return; }
    }
    // Find or create the player slot
    let player = room.players.find(p => p.name === playerName);
    if (!player) {
      player = { name: playerName, id: socket.id, connected: true, avatar: 1 };
      room.players.push(player);
    } else {
      const oldId = player.id;
      player.id = socket.id;
      player.connected = true;
      if (room.gameState) {
        const gp = room.gameState.players.find(p => p.id === oldId);
        if (gp) { gp.id = socket.id; gp.connected = true; }
      }
    }
    socket.join(roomCode);
    io.to(roomCode).emit('player_reconnected', { playerId: socket.id, players: room.players });
    socket.emit('restore_game_result', { success: true, roomCode, playerId: socket.id, gameState: room.gameState });
    if (room.gameState) {
      manager.stopTurnTimer(room);
      manager.startTurnTimer(roomCode, io);
    }
  });

  socket.on('rejoin_game', ({ roomCode, playerName }) => {
    const room = manager.getRoom(roomCode);
    if (!room) { socket.emit('rejoin_failed', { error: 'Room not found' }); return; }
    if (room.kicked?.has(playerName)) { socket.emit('rejoin_failed', { error: 'You were removed from this game' }); return; }
    const existing = room.players.find(p => p.name === playerName && !p.connected);
    if (!existing) { socket.emit('rejoin_failed', { error: 'Player not found or already connected' }); return; }
    const oldId = existing.id;
    existing.id = socket.id;
    existing.connected = true;
    if (room.gameState) {
      const gp = room.gameState.players.find(p => p.id === oldId);
      if (gp) { gp.id = socket.id; gp.connected = true; }
      // Update all board square owners and pending references from old ID to new ID
      room.gameState.boardSquares.forEach(sq => {
        if (sq.owner === oldId) sq.owner = socket.id;
      });
      if (room.gameState.pendingPropertyBuy?.playerId === oldId) room.gameState.pendingPropertyBuy.playerId = socket.id;
      if (room.gameState.pendingRentPayment?.playerId === oldId) room.gameState.pendingRentPayment.playerId = socket.id;
      if (room.gameState.pendingRentPayment?.ownerId === oldId) room.gameState.pendingRentPayment.ownerId = socket.id;
      if (room.gameState.pendingDeckDraw?.playerId === oldId) room.gameState.pendingDeckDraw.playerId = socket.id;
      if (room.gameState.blindCard?.playerId === oldId) room.gameState.blindCard.playerId = socket.id;
      if (room.gameState.activeCardChoice?._playerId === oldId) room.gameState.activeCardChoice._playerId = socket.id;
    }
    socket.join(roomCode);
    io.to(roomCode).emit('player_reconnected', { playerId: socket.id, oldPlayerId: oldId, players: room.players });
    socket.emit('rejoined', { roomCode, playerId: socket.id, players: room.players, gameState: room.gameState });
    console.log(`[rejoin] ${playerName} → room ${roomCode} (was ${oldId}, now ${socket.id})`);
    if (room.gameState) {
      const room2 = manager.getRoom(roomCode);
      if (room2) {
        manager.stopTurnTimer(room2);
        manager.startTurnTimer(roomCode, io);
      }
    }
  });

  socket.on('terminate_player', ({ roomCode, targetId }) => {
    const result = manager.terminatePlayer(roomCode, socket.id, targetId);
    if (!result) return;
    actionLog(roomCode, `💀 A player was kicked by the host`);
    if (result.gameState) {
      io.to(roomCode).emit('player_terminated', { targetId, players: result.players });
      io.to(roomCode).emit('state_update', { gameState: result.gameState, phase: result.gameState.phase });
      const room = manager.getRoom(roomCode);
      if (room && room.engine) {
        const gs = result.gameState;
        if (gs.gameOver) {
          manager.stopTurnTimer(room);
          io.to(roomCode).emit('game_over', { winner: gs.players.find(p => !p.isBankrupt) });
        }
      }
    } else {
      io.to(roomCode).emit('update_players', { players: result.players });
    }
  });

  // ── Disconnect ──

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    for (const [code, room] of manager.rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const player = room.players[idx];
        // If game is active, just mark disconnected
        if (room.gameState) {
          manager.disconnectPlayer(code, socket.id);
          io.to(code).emit('player_disconnected', { playerId: socket.id, players: room.players, connected: false });
          // If it's the current player's turn and they disconnect, auto-pass
          const current = room.gameState.players[room.gameState.currentPlayerIndex];
          if (current && current.id === socket.id) {
            manager.handleDisconnectAutoPass(room, code, io);
          }
        } else {
          // In lobby — remove entirely
          room.players.splice(idx, 1);
          io.to(code).emit('update_players', { players: room.players });
        }
        if (room.players.length === 0) {
          manager.destroyRoom(code);
        }
        break;
      }
    }
  });

  function broadcastState(roomCode) {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    // Notify whose turn it is
    const current = gs.players[gs.currentPlayerIndex];
    if (current && gs.phase === 'roll' && !gs.gameOver) {
      actionLog(roomCode, `👉 ${current.name}'s turn`);
    }
    io.to(roomCode).emit('state_update', { gameState: gs, phase: gs.phase });
  }

  function actionLog(roomCode, message) {
    io.to(roomCode).emit('action_log', { message });
  }
});

const PORT = process.env.PORT || 3001;
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`🎲 Bank El Haz server running`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://${ip}:${PORT}`);
  console.log(`   Share the Network address with friends!`);
});
