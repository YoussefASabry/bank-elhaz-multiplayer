/**
 * Express + socket.io bootstrap. Replaces `server.js`.
 *
 * This file wires; it does not decide. Every socket event is registered by a
 * `handlers/*` module, every one of those ends in `dispatch`, and `dispatch` is
 * the only caller of `applyAction`. Reading this file top to bottom should tell
 * you the whole shape of the server in about eighty lines, which was not true
 * of the 717-line original.
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';

import { socketEmitter } from './context.js';
import type { ServerCtx, TypedServer } from './context.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { registerBidHandlers } from './handlers/bids.js';
import { registerCardHandlers } from './handlers/cards.js';
import { registerLobbyHandlers } from './handlers/lobby.js';
import { registerPrisonHandlers } from './handlers/prison.js';
import { registerPropertyHandlers } from './handlers/property.js';
import { registerTradeHandlers } from './handlers/trades.js';
import { registerTurnHandlers } from './handlers/turn.js';
import type { TypedSocket } from './handlers/common.js';
import { RoomStore } from './rooms.js';
import { loadOrCreateSecret } from './snapshot.js';
import { loadVersionStore } from './versionStore.js';

export interface StartOptions {
  port?: number;
  dataDir?: string;
}

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  // Serve the built client when there is one, else the working tree (dev).
  app.use(express.static('dist'));
  app.use(express.static('.'));
  return app;
}

/** Build the shared context. Exported so tests can assemble one with fakes. */
export function createContext(io: TypedServer, dataDir = '.data'): ServerCtx {
  return {
    rooms: new RoomStore(),
    emit: socketEmitter(io),
    secret: loadOrCreateSecret(dataDir).secret,
    versions: loadVersionStore(dataDir),
    now: () => Date.now(),
    rng: (room) => room.rng,
  };
}

/**
 * Attach every handler group to one socket. The order is irrelevant — no
 * handler depends on another — but the grouping mirrors `handlers/`.
 */
export function registerHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.data.roomCode = null;
  socket.data.seatId = null;

  registerLobbyHandlers(ctx, socket);
  registerTurnHandlers(ctx, socket);
  registerPropertyHandlers(ctx, socket);
  registerCardHandlers(ctx, socket);
  registerPrisonHandlers(ctx, socket);
  registerTradeHandlers(ctx, socket);
  registerBidHandlers(ctx, socket);
  registerAdminHandlers(ctx, socket);
}

function localIPv4(): string {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const net of addrs ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

export function start(options: StartOptions = {}): { close: () => Promise<void> } {
  const port = options.port ?? Number(process.env['PORT'] ?? 3001);
  const app = createApp();
  const httpServer = createServer(app);
  const io: TypedServer = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  const ctx = createContext(io, options.dataDir ?? '.data');

  io.on('connection', (socket) => {
    registerHandlers(ctx, socket as TypedSocket);
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`🎲 Bank El Haz server running`);
    console.log(`   Local:    http://localhost:${port}`);
    console.log(`   Network:  http://${localIPv4()}:${port}`);
    console.log(`   Share the Network address with friends!`);
  });

  return {
    close: async () => {
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Start only when this module IS the entrypoint, never when a test imports it.
 * Comparing resolved URLs rather than sniffing argv for a substring: the old
 * guard would have matched any path containing "server".
 */
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) start();
