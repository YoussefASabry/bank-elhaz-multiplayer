import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { networkInterfaces } from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { RoomManager } from './roomManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Same-origin in production (client is served by this server); open in dev for vite
  cors: process.env.NODE_ENV === 'production' ? undefined : { origin: '*', methods: ['GET', 'POST'] },
});

// Serve built client
const dist = path.join(__dirname, '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Bank El Haz server running. Build the client with `npm run build` or use the vite dev server.'));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
}

const manager = new RoomManager(io);

io.on('connection', (socket) => {
  let joinedRoom = null;

  const ack = (cb, payload) => { if (typeof cb === 'function') cb(payload); };

  socket.on('host_game', ({ playerName, avatar, options }, cb) => {
    const name = cleanName(playerName);
    if (!name) return ack(cb, { ok: false, error: 'Invalid name' });
    const room = manager.createRoom(socket.id, name, avatar, options);
    socket.join(room.code);
    joinedRoom = room.code;
    ack(cb, { ok: true, roomCode: room.code, playerId: socket.id, players: room.players, options: room.options });
  });

  socket.on('join_game', ({ roomCode, playerName, avatar }, cb) => {
    const name = cleanName(playerName);
    if (!name) return ack(cb, { ok: false, error: 'Invalid name' });
    const result = manager.joinRoom(roomCode, socket.id, name, avatar);
    if (result.error) return ack(cb, { ok: false, error: result.error });
    const room = result.room;
    socket.join(room.code);
    joinedRoom = room.code;
    if (result.reconnected) {
      io.to(room.code).emit('player_connection', { playerId: socket.id, connected: true, name });
      ack(cb, { ok: true, roomCode: room.code, playerId: socket.id, players: room.players, reconnected: true, options: room.options });
      manager.broadcast(room, []);
    } else {
      io.to(room.code).emit('lobby_players', { players: room.players });
      ack(cb, { ok: true, roomCode: room.code, playerId: socket.id, players: room.players, options: room.options });
    }
  });

  socket.on('leave_room', () => {
    if (!joinedRoom) return;
    const room = manager.getRoom(joinedRoom);
    socket.leave(joinedRoom);
    if (room && !room.engine) {
      manager.removeFromLobby(joinedRoom, socket.id);
      io.to(joinedRoom).emit('lobby_players', { players: room.players });
    }
    joinedRoom = null;
  });

  socket.on('start_game', (_payload, cb) => {
    if (!joinedRoom) return ack(cb, { ok: false, error: 'no_room' });
    const result = manager.startGame(joinedRoom, socket.id);
    ack(cb, result.error ? { ok: false, error: result.error } : { ok: true });
  });

  // Single funnel for all in-game actions — engine validates everything.
  socket.on('action', (action, cb) => {
    if (!joinedRoom || !action || typeof action.type !== 'string') return ack(cb, { ok: false, error: 'bad_request' });
    const result = manager.handleAction(joinedRoom, socket.id, action);
    ack(cb, { ok: result.ok, error: result.error });
  });

  socket.on('disconnect', () => {
    manager.handleDisconnect(socket.id);
  });
});

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().slice(0, 20);
  return trimmed.length >= 1 ? trimmed : null;
}

const PORT = process.env.PORT || 3001;
function localIP() {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets) if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  return 'localhost';
}
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🎲 Bank El Haz server on http://localhost:${PORT} (LAN: http://${localIP()}:${PORT})`);
});
