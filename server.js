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

  socket.on('host_game', ({ playerName, avatar }, cb) => {
    const playerId = socket.id;
    const room = manager.createRoom(playerId, playerName, avatar);
    socket.join(room.code);
    socket.emit('room_created', {
      roomCode: room.code,
      playerId,
      players: room.players,
    });
    console.log(`[host] ${playerName} → room ${room.code}`);
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
    manager.handleLanding(roomCode, socket.id, rollResult, io);
  });

  socket.on('buy_property', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.resolvePropertyBuy(roomCode, socket.id, true);
    broadcastState(roomCode);
  });

  socket.on('decline_property', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.resolvePropertyBuy(roomCode, socket.id, false);
    broadcastState(roomCode);
  });

  socket.on('pay_rent', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.resolveRent(roomCode, socket.id);
    broadcastState(roomCode);
  });

  socket.on('confirm_blind_card', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const outcome = manager.resolveBlindCard(roomCode, socket.id, io);
    if (outcome) {
      io.to(roomCode).emit('card_outcome', outcome);
    }
    broadcastState(roomCode);
  });

  socket.on('card_choice', ({ roomCode, choiceIndex }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.resolveCardChoice(roomCode, socket.id, choiceIndex);
    broadcastState(roomCode);
  });

  socket.on('skip_prison', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.skipPrison(roomCode, socket.id);
    broadcastState(roomCode);
  });

  socket.on('pay_bail', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.payBail(roomCode, socket.id);
    broadcastState(roomCode);
  });

  socket.on('sell_building', ({ roomCode, propertyId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.sellBuilding(roomCode, socket.id, propertyId);
    broadcastState(roomCode);
  });

  socket.on('sell_property', ({ roomCode, propertyId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    manager.sellPropertyToBank(roomCode, socket.id, propertyId);
    broadcastState(roomCode);
  });

  // ── Trade ──

  socket.on('trade_request', ({ roomCode, targetId }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState) return;
    const result = manager.initTrade(roomCode, socket.id, targetId);
    if (result) {
      io.to(roomCode).emit('trade_opened', result);
    }
  });

  socket.on('trade_update', ({ roomCode, side, cash, propIds }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !room.trade) return;
    const upd = manager.updateTrade(roomCode, socket.id, side, cash, propIds);
    if (upd) {
      socket.to(roomCode).emit('trade_sync', upd);
    }
  });

  socket.on('trade_lock', ({ roomCode, side }) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.gameState || !room.trade) return;
    const result = manager.toggleTradeLock(roomCode, socket.id, side);
    if (result) {
      io.to(roomCode).emit('trade_lock_update', result);
      if (result.bothLocked) {
        const execResult = manager.executeTrade(roomCode);
        if (execResult) {
          io.to(roomCode).emit('trade_executed', execResult);
          broadcastState(roomCode);
        }
      }
    }
  });

  socket.on('trade_close', ({ roomCode }) => {
    const room = manager.getRoom(roomCode);
    if (room) room.trade = null;
    io.to(roomCode).emit('trade_closed');
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
    io.to(roomCode).emit('state_update', { gameState: room.gameState, phase: room.gameState.phase });
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
