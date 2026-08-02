/**
 * End-to-end over a real socket.io connection: the only test that proves the
 * bootstrap, the handler registration, the redaction and the event map are
 * actually wired to each other rather than merely all present.
 *
 * Deliberately small — the rules are tested in `tests/engine/`. What is checked
 * here is the *plumbing*: does an intent sent by a client come back as the
 * events WIRE.md promises, addressed to the right sockets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import { start } from '../../src/server/index.js';

const PORT = 3411;
const URL = `http://localhost:${PORT}`;
let server: { close: () => Promise<void> };
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bankelhaz-'));
  server = start({ port: PORT, dataDir });
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const clients: Socket[] = [];
function connect(): Promise<Socket> {
  const s = ioClient(URL, { transports: ['websocket'], forceNew: true });
  clients.push(s);
  return new Promise((res, rej) => {
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}

afterAll(() => {
  for (const c of clients) c.disconnect();
});

/** Resolve on the next occurrence of `event`. */
function next<T = unknown>(s: Socket, event: string, ms = 3000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${event}`)), ms);
    s.once(event, (p: T) => {
      clearTimeout(t);
      res(p);
    });
  });
}

describe('integration — a real game over a real socket', () => {
  it('hosts, joins, starts, rolls and redacts, all over the wire', async () => {
    const host = await connect();
    const guest = await connect();

    // --- host_game
    const created = await new Promise<{ ok: boolean; roomCode?: string; playerId?: string }>(
      (res) => {
        host.emit('host_game', { playerName: 'Alice', avatar: 1, options: { moneyVisible: false } }, res);
      },
    );
    expect(created.ok).toBe(true);
    const roomCode = created.roomCode;
    expect(roomCode).toMatch(/^[A-Z0-9]{4,6}$/);

    // --- join_game: the host must be told about it
    const hostSeesJoin = next<{ players: unknown[] }>(host, 'update_players');
    const joined = await new Promise<{ ok: boolean; playerId?: string }>((res) => {
      guest.emit('join_game', { roomCode, playerName: 'Bob', avatar: 2 }, res);
    });
    expect(joined.ok).toBe(true);
    expect((await hostSeesJoin).players).toHaveLength(2);

    // --- start_game: both sides get a projection of their own
    const hostStart = next<{ gameState: Record<string, unknown> }>(host, 'game_started');
    const guestStart = next<{ gameState: Record<string, unknown> }>(guest, 'game_started');
    host.emit('start_game', { roomCode });
    const hostView = (await hostStart).gameState;
    const guestView = (await guestStart).gameState;

    expect(hostView['youAre']).toBe(created.playerId);
    expect(guestView['youAre']).toBe(joined.playerId);

    // Redaction actually reached the wire: no deck order, no foreign balances.
    expect(JSON.stringify(hostView)).not.toContain('"draw":[');
    const guestPlayers = guestView['players'] as { id: string; money: number | null }[];
    expect(guestPlayers.find((p) => p.id === joined.playerId)?.money).toBeTypeOf('number');
    expect(guestPlayers.find((p) => p.id === created.playerId)?.money).toBeNull();

    // --- the clock is running and server-authoritative
    const tick = await next<{ seconds: number }>(host, 'timer_sync', 3000);
    expect(tick.seconds).toBeGreaterThan(0);

    // --- roll_dice from the wrong player is silently refused
    const guestRoll = await new Promise<{ ok: boolean }>((res) => {
      guest.emit('roll_dice', { roomCode }, res);
    });
    expect(guestRoll.ok).toBe(false);

    // --- roll_dice from the right player produces dice_rolled + state_update
    const rolled = next<{ playerId: string; die1: number; total: number }>(host, 'dice_rolled');
    const updated = next<{ gameState: Record<string, unknown> }>(guest, 'state_update');
    host.emit('roll_dice', { roomCode });

    const dice = await rolled;
    expect(dice.playerId).toBe(created.playerId);
    expect(dice.die1).toBeGreaterThanOrEqual(1);
    expect(dice.total).toBeGreaterThanOrEqual(2);

    const after = (await updated).gameState;
    expect(after['stateVersion']).toBeGreaterThan(Number(guestView['stateVersion']));
  });

  it('rejects a rejoin for a room that does not exist', async () => {
    const s = await connect();
    const failed = next<{ error: string }>(s, 'rejoin_failed');
    s.emit('rejoin_game', { roomCode: 'ZZZZ', playerName: 'Ghost' });
    expect((await failed).error).toBeTypeOf('string');
  });

  it('refuses an unsigned restore instead of installing it (B19)', async () => {
    const s = await connect();
    const result = next<{ success: boolean; error?: string }>(s, 'restore_game_result');
    // The legacy client-authored shape: a bare gameState with no signature.
    s.emit('restore_game', {
      roomCode: 'HACK',
      playerName: 'Mallory',
      gameState: { players: [{ id: 'x', money: 999999 }] },
    });
    const out = await result;
    expect(out.success).toBe(false);
    expect(out.error).toBeTypeOf('string');
  });
});
