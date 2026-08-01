/**
 * Server bootstrap (plan §Phase 4). Express + socket.io entry point.
 *
 * Also exports `createApp()` so integration tests boot the REAL server on an
 * ephemeral port instead of stubbing the transport. Runs as a script only when
 * invoked directly (`node src/server/main.ts`); the `server` npm script does
 * that via tsx.
 */
import express from 'express';
import { createServer } from 'node:http';
import type { Server } from 'socket.io';
import { Server as ServerImpl } from 'socket.io';
import cors from 'cors';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRoomManager } from './rooms.js';
import { createRoomController } from './handlers/room.js';
import { wireLobby } from './handlers/lobby.js';
import { loadOrCreateSecret } from './snapshot.js';
import { loadVersionStore } from './versionStore.js';

export interface BankElhazApp {
  io: Server;
  manager: ReturnType<typeof createRoomManager>;
  controller: ReturnType<typeof createRoomController>;
  httpServer: ReturnType<typeof createServer>;
  start: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

export function createApp(dataDir = '.data'): BankElhazApp {
  const app = express();
  app.use(cors());
  const httpServer = createServer(app);
  const io = new ServerImpl(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Serve the pre-built client (run `npm run build` before playing with friends).
  app.use(express.static('dist'));
  // Fallback to current dir for dev.
  app.use(express.static('.'));

  const manager = createRoomManager();
  const { secret } = loadOrCreateSecret(dataDir);
  const versionStore = loadVersionStore(dataDir);
  const controller = createRoomController(io, manager, { secret });
  wireLobby(io, manager, controller, { secret, versionStore });

  return {
    io,
    manager,
    controller,
    httpServer,
    start: (port, host = '0.0.0.0') =>
      new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          const actualPort = typeof address === 'object' && address !== null ? address.port : port;
          resolve(actualPort);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        // io.close() already stops listening; guard the http close so shutting
        // down twice (or after a test teardown) never throws ERR_SERVER_NOT_RUNNING.
        const shutDown = () => {
          if (httpServer.listening) httpServer.close(() => resolve());
          else resolve();
        };
        if (io.engine.clientsCount > 0) io.close(shutDown);
        else shutDown();
      }),
  };
}

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

async function startServer(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3001);
  const app = createApp();
  const actual = await app.start(port);
  const ip = getLocalIP();
  console.log('🎲 Bank El Haz server running');
  console.log(`   Local:    http://localhost:${actual}`);
  console.log(`   Network:  http://${ip}:${actual}`);
  console.log('   Share the Network address with friends!');
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void startServer();
}
