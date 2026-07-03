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

  socket.on('confirm_blind_card', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
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
      actionLog(roomCode, `🏙️ المدن المختارة: ${cityStr} — تم تحصيل ${cityInfo.totalCollected}ج`);
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
    if (player) actionLog(roomCode, `🔓 ${player.name} used a jail-free card`);
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

  socket.on('sell_building', ({ roomCode, propertyId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    const sq = gs.boardSquares.find(s => s.id === propertyId);
    manager.sellBuilding(roomCode, socket.id, propertyId);
    if (player && sq) actionLog(roomCode, `🏗️ ${player.name} sold a building on ${sq.name}`);
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
    const result = manager.initTrade(roomCode, socket.id, targetId);
    if (!result) {
      socket.emit('trade_error', { message: 'Trade could not be started' });
      return;
    }
    if (result.error === 'rate_limited') {
      socket.emit('trade_error', { message: `⏳ Wait ${result.waitSec}s before trading again` });
      return;
    }
    // Send to both participants
    io.to(roomCode).emit('trade_opened', result);
    actionLog(roomCode, `🤝 ${result.initiator.name} opened a trade with ${result.partner.name}`);
  });

  socket.on('trade_send_proposal', ({ roomCode, cash, propIds, jailCards }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !room.trade) return;
    const result = manager.sendTradeProposal(roomCode, socket.id, { cash, propIds, jailCards });
    if (!result) return;
    // Send updated trade state to both
    io.to(roomCode).emit('trade_state_update', result);
    const sender = room.gameState.players.find(p => p.id === socket.id);
    if (sender) actionLog(roomCode, `📨 ${sender.name} sent a trade proposal`);
  });

  socket.on('trade_accept_proposal', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !room.trade) return;
    const result = manager.acceptTradeProposal(roomCode, socket.id);
    if (!result) return;
    if (result.aName) {
      io.to(roomCode).emit('trade_executed', result);
      actionLog(roomCode, `🤝 Trade executed between ${result.aName} and ${result.bName}!`);
      broadcastState(roomCode);
    } else {
      io.to(roomCode).emit('trade_state_update', result);
      const accepter = room.gameState.players.find(p => p.id === socket.id);
      if (accepter) actionLog(roomCode, `✅ ${accepter.name} accepted a proposal`);
    }
  });

  socket.on('trade_decline_proposal', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !room.trade) return;
    const result = manager.declineTradeProposal(roomCode, socket.id);
    if (!result) return;
    io.to(roomCode).emit('trade_state_update', result);
    const decliner = room.gameState.players.find(p => p.id === socket.id);
    if (decliner) actionLog(roomCode, `❌ ${decliner.name} declined the proposal`);
  });

  socket.on('trade_cancel', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const result = manager.cancelTrade(roomCode, socket.id);
    if (result) {
      io.to(roomCode).emit('trade_cancelled', result);
      actionLog(roomCode, `🚫 Trade cancelled`);
    }
  });

  socket.on('sell_building_in_trade', ({ roomCode, propId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const sq = gs.boardSquares.find(s => s.id === propId);
    if (!sq || sq.owner !== socket.id || !sq.buildings || sq.buildings.length === 0) return;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const refund = sq.buildings.reduce((t, b) => t + Math.floor((b.cost || 0) / 2), 0);
    player.money += refund;
    sq.buildings = [];
    actionLog(roomCode, `🏗️ ${player.name} sold buildings on ${sq.name} for $${refund}`);
    broadcastState(roomCode);
  });

  // ── Club choice ──
  socket.on('club_choice', ({ roomCode, choice }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    manager.resolveClubChoice(roomCode, socket.id, choice);
    if (player) actionLog(roomCode, `🎰 ${player.name} chose ${choice === 'membership' ? 'membership' : 'guest'} at the club`);
    broadcastState(roomCode);
  });

  // ── Bid events (v2) ──
  socket.on('create_bid', ({ roomCode, cash, propIds }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const bid = manager.createBid(roomCode, socket.id, cash, propIds);
    if (!bid) return;
    io.to(roomCode).emit('bid_created', bid);
    actionLog(roomCode, `📢 ${player.name} posted a public bid!`);
  });

  socket.on('bid_respond', ({ roomCode, bidId, cash, propIds }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players.find(p => p.id === socket.id);
    if (!player) return;
    const result = manager.respondToBid(roomCode, bidId, socket.id, cash, propIds);
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

  // ── Disconnect ──

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    // Find room containing this player
    for (const [code, room] of manager.rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(code).emit('player_disconnected', { playerId: socket.id, players: room.players });
        if (room.gameState) {
          // If it's the current player's turn and they disconnect, auto-pass
          const current = room.gameState.players[room.gameState.currentPlayerIndex];
          if (current && current.id === socket.id) {
            manager.handleDisconnectAutoPass(room, code, io);
          }
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
