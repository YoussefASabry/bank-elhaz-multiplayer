/**
 * Phase 4 integration tests (plan §Phase 4). Boot the REAL server
 * (`createApp` in src/server/main.ts) on an ephemeral port, drive it with REAL
 * socket.io clients, and assert on bug-table behaviour end-to-end:
 *
 *   B01  one interval per room — timeout turns advance exactly one at a time,
 *        and the `timer` event ticks once per second, strictly decreasing.
 *   B02  every phase has an autoPass branch — TIMEOUT synthesizes the exact
 *        human action and the phase machine moves on.
 *   B03  USE_JAIL_FREE works over the wire (it was a server bug, not a client
 *        one: the legacy server had no handler for it at all).
 *   B06  KICK_PLAYER marks `eliminated`, never splices the players array.
 *   B19  a client-authored/forged snapshot is rejected before it can install
 *        state; the legacy `restore_game` event does nothing.
 *   B20  a disconnected seat rejoins the live game by seat token.
 *   B23  the server projects: other players' money is null when the host hid
 *        balances; deck contents are never sent; a blind_card is opaque to
 *        everyone except the drawing player.
 *   B26  TURN_STARTED is the ONLY turn-start signal, one per handover.
 *
 * Seeded/deterministic states are installed via `manager.installState` and the
 * timer driven by the real controller, so these run against the production
 * mutation path (`applyToRoom` + `broadcastAfterAction`), not stubs.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type BankElhazApp } from '../../src/server/main.js';
import {
  SEAT_A,
  SEAT_B,
  SEAT_C,
  SQ,
  p,
  give,
  jail,
  giveJailCards,
  stackCard,
  makeState,
} from '../helpers/fixtures.js';
import type { DomainEvent, RejectReason } from '../../src/shared/actions.js';
import type { ClientState, RoomOptions } from '../../src/shared/events.js';
import type { GameState, SeatId } from '../../src/shared/types.js';

const baseOptions: RoomOptions = {
  startingCash: 2000,
  passGoSalary: 200,
  diceCount: 2,
  moneyVisible: true,
  tradeTiming: 'anytime',
  onBankruptcy: 'eliminate',
  turnTimeoutSeconds: 1,
  rentTurnTimeoutSeconds: 1,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: BankElhazApp;
let port: number;
const openSockets: ClientSocket[] = [];

function connect(): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    openSockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

function emitAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 3000);
    // DefaultEventsMap typing: emit(event, ...args) is loose — fine for tests.
    socket.emit(event, payload, (r: T) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

function waitFor<T>(
  socket: ClientSocket,
  event: string,
  opts: { predicate?: (d: T) => boolean; timeoutMs?: number } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (d: T) => {
      if (opts.predicate !== undefined && !opts.predicate(d)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(d);
    };
    socket.on(event, handler);
  });
}

function collect<T>(socket: ClientSocket, event: string): T[] {
  const out: T[] = [];
  socket.on(event, (d: T) => out.push(d));
  return out;
}

async function setupSocketRoom(n: number, options: RoomOptions = baseOptions): Promise<{
  sockets: ClientSocket[];
  seatIds: SeatId[];
  roomCode: string;
}> {
  const sockets: ClientSocket[] = [];
  const seatIds: SeatId[] = [];

  const host = await connect();
  sockets.push(host);
  const hostAck = await emitAck<{ ok: boolean; roomCode?: string; you?: SeatId; error?: string }>(host, 'host_game', {
    playerName: 'Host',
    avatar: 1,
    options,
  });
  expect(hostAck.ok).toBe(true);
  seatIds.push(hostAck.you as SeatId);

  for (let i = 1; i < n; i++) {
    const s = await connect();
    sockets.push(s);
    const ack = await emitAck<{ ok: boolean; roomCode?: string; you?: SeatId; error?: string }>(s, 'join_game', {
      roomCode: hostAck.roomCode,
      playerName: `P${i}`,
      avatar: i + 1,
    });
    expect(ack.ok).toBe(true);
    seatIds.push(ack.you as SeatId);
  }
  return { sockets, seatIds, roomCode: hostAck.roomCode as string };
}

/** Start the real game and return the host's first per-seat projection. */
async function startGame(socket: ClientSocket, roomCode: string): Promise<ClientState> {
  socket.emit('start_game', { roomCode });
  const p = await waitFor<{ state: ClientState }>(socket, 'game_started');
  return p.state;
}

/**
 * A deterministic 2-seat state whose player ids are the room's REAL seat ids,
 * with fast timeouts so the real timer drives it. Call `installAndRebind` and
 * then `controller.syncTimer` to run it through the production path.
 */
function craftBase(seats: readonly SeatId[]): GameState {
  const src = makeState({
    seats: seats.map((_, i) => `tmp-${i}` as SeatId),
    cash: 2000,
    config: { turnTimeoutSeconds: 1, rentTurnTimeoutSeconds: 1 },
  });
  src.players.forEach((pl, i) => {
    pl.id = seats[i] as SeatId;
  });
  src.hostId = (seats[0] as SeatId | undefined) ?? null;
  src.currentPlayerIndex = 0;
  src.phase = 'roll';
  src.pending = { kind: 'none' };
  return src;
}

function installAndRebind(
  roomCode: string,
  state: GameState,
  binds: { seatId: SeatId; socket: ClientSocket }[],
): GameState {
  const room = app.manager.installState(roomCode, state);
  for (const { seatId, socket } of binds) app.manager.bindSocket(room, seatId, socket.id as string);
  return room.state as GameState;
}

function roomState(roomCode: string): GameState {
  const room = app.manager.getRoom(roomCode);
  if (room === undefined || room.state === null) throw new Error(`no state for ${roomCode}`);
  return room.state;
}

async function waitForState(
  roomCode: string,
  done: (st: GameState) => boolean,
  timeoutMs = 6000,
): Promise<GameState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const room = app.manager.getRoom(roomCode);
    if (room?.state !== undefined && room.state !== null && done(room.state)) return room.state;
    await sleep(40);
  }
  throw new Error(`state condition not met in ${timeoutMs}ms`);
}

function turnStarted(events: DomainEvent[]): boolean {
  return events.some((e) => e.type === 'TURN_STARTED');
}

beforeAll(async () => {
  app = createApp(mkdtempSync(join(tmpdir(), 'bankelhaz-integration-')));
  port = await app.start(0);
});

afterEach(() => {
  for (const room of app.manager.all()) {
    app.controller.destroy(room);
    app.manager.destroyRoom(room.code);
  }
});

afterAll(async () => {
  for (const socket of openSockets) {
    if (socket.connected) socket.disconnect();
  }
  await app.close();
});

// ── B01 + B26: one interval per room, one TURN_STARTED per handover ──

describe('turn timer (B01) and turn-start signalling (B26)', () => {
  it('timeout-driven turns advance one at a time — no stacked intervals (B01)', async () => {
    const { sockets, roomCode } = await setupSocketRoom(2, baseOptions);

    const arrivals: number[] = [];
    sockets[0]!.on('events', (d: { events: DomainEvent[] }) => {
      if (d.events.some((e) => e.type === 'TURN_STARTED')) arrivals.push(Date.now());
    });

    await startGame(sockets[0] as ClientSocket, roomCode);

    // Synthetic turn 1 + two full handovers = 4 arrivals.
    await waitFor<{ events: DomainEvent[] }>(sockets[0] as ClientSocket, 'events', {
      predicate: () => arrivals.length >= 4,
      timeoutMs: 15000,
    });

    // A turn handover needs at least two 1s timer cycles (roll → confirm →
    // advance), so a genuine gap is >= 2s. A stacked interval (B01) fires the
    // timeout every ~1s, which would show up as ~1s gaps or a burst.
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(1500);
    }
    expect(arrivals.length).toBeGreaterThanOrEqual(4);

    // No runaway: a 4s window must not produce more than two handovers
    // (legitimate cadence is one turn every 2-7s, depending on what the dice
    // land on).
    const before = arrivals.length;
    await sleep(4000);
    expect(arrivals.length - before).toBeLessThanOrEqual(2);
  }, 25000);

  it('one TURN_STARTED per handover, increasing turnNumber, alternating seats (B26)', async () => {
    const { sockets, roomCode } = await setupSocketRoom(2, baseOptions);

    const eventBatches = collect<{ events: DomainEvent[] }>(sockets[0] as ClientSocket, 'events');
    await startGame(sockets[0] as ClientSocket, roomCode);

    await waitFor<{ events: DomainEvent[] }>(sockets[0] as ClientSocket, 'events', {
      predicate: () =>
        eventBatches.flatMap((b) => b.events).filter((e) => e.type === 'TURN_STARTED').length >= 4,
      timeoutMs: 15000,
    });
    await sleep(200);

    const started = eventBatches
      .flatMap((b) => b.events)
      .filter((e): e is Extract<DomainEvent, { type: 'TURN_STARTED' }> => e.type === 'TURN_STARTED');

    // No batch ever carries more than one TURN_STARTED, and no other event
    // signals a turn start (only TURN_STARTED may).
    for (const batch of eventBatches) {
      const n = batch.events.filter((e) => e.type === 'TURN_STARTED').length;
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(started.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < started.length; i++) {
      expect(started[i]!.turnNumber).toBeGreaterThan(started[i - 1]!.turnNumber);
      expect(started[i]!.playerId).not.toBe(started[i - 1]!.playerId);
    }
  }, 25000);

  it('timer ticks once per second, strictly decreasing (B01)', async () => {
    const opts = { ...baseOptions, turnTimeoutSeconds: 3, rentTurnTimeoutSeconds: 3 };
    const { sockets, roomCode } = await setupSocketRoom(2, opts);
    await startGame(sockets[0] as ClientSocket, roomCode);

    const timers = collect<{ seconds: number; running: boolean; total: number }>(sockets[0] as ClientSocket, 'timer');
    await sleep(2600);

    const seen = timers.map((t) => t.seconds);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seen.length; i++) {
      const diff = seen[i - 1]! - seen[i]!;
      expect(diff).toBeGreaterThanOrEqual(1);
      expect(diff).toBeLessThanOrEqual(1);
    }
  }, 10000);
});

// ── B02: every phase has an autoPass branch ──

describe('TIMEOUT autoPass over the real timer (B02)', () => {
  interface PhaseCase {
    name: string;
    build: (st: GameState) => void;
    done: (st: GameState) => boolean;
    assert: (st: GameState) => void;
  }

  const lastCard = (st: GameState, deck: 'hazak' | 'mahkama') =>
    st.decks[deck].draw[st.decks[deck].draw.length - 1] as NonNullable<GameState['decks'][typeof deck]['draw'][number]>;

  const cases: PhaseCase[] = [
    {
      name: 'roll → rolls the dice',
      build: () => {},
      done: (st) => st.phase === 'rolling',
      assert: (st) => expect(st.phase).toBe('rolling'),
    },
    {
      name: 'rolling → confirms landing (start salary, turn advances)',
      build: (st) => {
        st.phase = 'rolling';
        st.lastRoll = {
          playerId: SEAT_A,
          die1: 2,
          die2: 2,
          total: 4,
          steps: 4,
          from: 1,
          to: 5,
          path: [2, 3, 4, 5],
          passedGo: false,
          doubleApplied: false,
        };
        st.players[0]!.position = SQ.start;
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(st.phase).toBe('roll');
        expect(st.players[1]!.id).toBe(SEAT_B);
      },
    },
    {
      name: 'draw_card → draws a card into blind_card',
      build: (st) => {
        stackCard(st, 'mahkama', 1);
        st.phase = 'draw_card';
        st.pending = { kind: 'deck_draw', playerId: SEAT_A, queue: ['mahkama'], squareName: 'test' };
      },
      done: (st) => st.pending.kind === 'blind_card',
      assert: (st) => {
        expect(st.phase).toBe('blind_card');
        if (st.pending.kind !== 'blind_card') throw new Error('expected blind_card');
        expect(st.pending.card.id).toBe(1);
      },
    },
    {
      name: 'blind_card → confirms (collect_from_players, turn advances)',
      build: (st) => {
        stackCard(st, 'mahkama', 1);
        st.phase = 'blind_card';
        st.pending = {
          kind: 'blind_card',
          playerId: SEAT_A,
          card: lastCard(st, 'mahkama'),
          cardNumber: 1,
          totalCards: 15,
          remainingDraws: [],
          squareName: 'test',
        };
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(p(st, SEAT_B).money).toBe(2000 - 25); // card 1: collect 25 from each other player
      },
    },
    {
      name: 'card_choice → picks option 0 (receive_cash 150, turn advances)',
      build: (st) => {
        stackCard(st, 'hazak', 15);
        st.phase = 'card_choice';
        const card = lastCard(st, 'hazak');
        st.pending = {
          kind: 'card_choice',
          playerId: SEAT_A,
          card,
          title: card.description,
          options: card.choices,
          propertyPool: [],
          remainingDraws: [],
          squareName: 'test',
        };
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(p(st, SEAT_A).money).toBe(2000 + 150);
      },
    },
    {
      name: 'club_choice → guest fine (turn advances)',
      build: (st) => {
        st.phase = 'club_choice';
        st.pending = { kind: 'club', playerId: SEAT_A, membershipCost: 150, guestFineFee: 20 };
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(p(st, SEAT_A).money).toBe(2000 - 20);
      },
    },
    {
      name: 'property_choice → declines (turn advances)',
      build: (st) => {
        st.phase = 'property_choice';
        st.pending = { kind: 'property_buy', playerId: SEAT_A, squareId: 2 };
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(st.phase).toBe('roll');
        expect(st.ownership[2]?.owner).toBeNull();
      },
    },
    {
      name: 'upgrade_choice → skips (turn advances)',
      build: (st) => {
        st.phase = 'upgrade_choice';
        st.pending = { kind: 'upgrade', playerId: SEAT_A, squareId: 2, options: [] };
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(st.phase).toBe('roll');
        expect(st.ownership[2]?.upgrade).toBeNull();
      },
    },
    {
      name: 'rent_payment → pays (turn advances)',
      build: (st) => {
        st.phase = 'rent_payment';
        st.pending = { kind: 'rent', playerId: SEAT_A, ownerId: null, amount: 100, squareId: 2 };
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(p(st, SEAT_A).money).toBe(2000 - 100);
      },
    },
    {
      name: 'jailed roll → serves a prison turn, does NOT roll (B05)',
      build: (st) => {
        jail(st, SEAT_A, 2);
      },
      done: (st) => st.currentPlayerIndex === 1,
      assert: (st) => {
        expect(p(st, SEAT_A).statusEffects.missedTurnsRemaining).toBe(1);
        expect(st.lastRoll).toBeNull();
      },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const state = craftBase([SEAT_A, SEAT_B]);
      c.build(state);
      const room = app.manager.createRoom({ id: 'host', name: 'H', avatar: 1 }, baseOptions);
      app.manager.installState(room.code, state);
      app.controller.syncTimer(app.manager.getRoom(room.code) as never);
      const after = await waitForState(room.code, c.done);
      c.assert(after);
    }, 8000);
  }
});

// ── B03: USE_JAIL_FREE exists on the server ──

describe('USE_JAIL_FREE over the wire (B03)', () => {
  it('releases the current player from prison, still their turn to roll', async () => {
    const { sockets, seatIds, roomCode } = await setupSocketRoom(2, baseOptions);
    await startGame(sockets[0] as ClientSocket, roomCode);

    const [a, b] = seatIds as [SeatId, SeatId];
    const crafted = craftBase([a, b]);
    jail(crafted, a, 2);
    giveJailCards(crafted, a, 1);
    installAndRebind(roomCode, crafted, [
      { seatId: a, socket: sockets[0] as ClientSocket },
      { seatId: b, socket: sockets[1] as ClientSocket },
    ]);
    app.controller.stopTimer(app.manager.getRoom(roomCode) as never);

    (sockets[0] as ClientSocket).emit('action', { roomCode, action: { type: 'USE_JAIL_FREE', actorId: a } });

    const released = await waitFor<{ events: DomainEvent[] }>(sockets[0] as ClientSocket, 'events', {
      predicate: (batch) => batch.events.some((e) => e.type === 'RELEASED_FROM_JAIL'),
    });
    expect(released.events.some((e) => e.type === 'RELEASED_FROM_JAIL' && e.via === 'jail_free_card')).toBe(true);

    const st = roomState(roomCode);
    expect(p(st, a).statusEffects.missedTurnsRemaining).toBe(0);
    expect(p(st, a).inventory.jailFreeCards).toBe(0);
    expect(st.currentPlayerIndex).toBe(0);
    expect(st.phase).toBe('roll');
  }, 8000);
});

// ── B06: kick marks eliminated, never splices ──

describe('KICK_PLAYER (B06)', () => {
  it('eliminates the target, keeps the array, and advances the turn', async () => {
    const { sockets, seatIds, roomCode } = await setupSocketRoom(3, baseOptions);
    await startGame(sockets[0] as ClientSocket, roomCode);

    const [a, b, c] = seatIds as [SeatId, SeatId, SeatId];
    const crafted = craftBase([a, b, c]);
    crafted.currentPlayerIndex = 1; // b is mid-turn
    installAndRebind(roomCode, crafted, [
      { seatId: a, socket: sockets[0] as ClientSocket },
      { seatId: b, socket: sockets[1] as ClientSocket },
      { seatId: c, socket: sockets[2] as ClientSocket },
    ]);
    app.controller.stopTimer(app.manager.getRoom(roomCode) as never);

    (sockets[0] as ClientSocket).emit('action', { roomCode, action: { type: 'KICK_PLAYER', actorId: a, targetId: b } });

    await waitFor<{ events: DomainEvent[] }>(sockets[0] as ClientSocket, 'events', {
      predicate: (batch) => batch.events.some((e) => e.type === 'PLAYER_KICKED'),
    });

    const st = roomState(roomCode);
    expect(st.players.length).toBe(3); // never spliced
    expect(p(st, b).eliminated).toBe(true);
    // turn advanced off the eliminated player to c
    expect(st.currentPlayerIndex).toBe(2);
    expect(st.players[st.currentPlayerIndex]!.id).toBe(c);
  }, 8000);
});

// ── B20: rejoin by seat token ──

describe('rejoin (B20)', () => {
  it('rebinds a fresh socket to the seat and marks it connected', async () => {
    const opts = { ...baseOptions, turnTimeoutSeconds: 90, rentTurnTimeoutSeconds: 120 };
    const { sockets, seatIds, roomCode } = await setupSocketRoom(2, opts);
    await startGame(sockets[0] as ClientSocket, roomCode);

    const a = seatIds[0] as SeatId;
    (sockets[0] as ClientSocket).disconnect();

    const rejoin = await connect();
    rejoin.emit('rejoin', { roomCode, seatToken: a });
    const projected = await waitFor<{ state: ClientState }>(rejoin, 'state', { timeoutMs: 8000 });
    expect(projected.state.youAre).toBe(a);
    expect(p(roomState(roomCode), a).connected).toBe(true);
  }, 10000);
});

// ── B23: server-side projection ──

describe('projection (B23)', () => {
  it('strips other players money when the host hid balances', async () => {
    const opts = { ...baseOptions, moneyVisible: false };
    const { sockets, seatIds, roomCode } = await setupSocketRoom(2, opts);
    const guestPromise = waitFor<{ state: ClientState }>(sockets[1] as ClientSocket, 'game_started');
    const hostView = await startGame(sockets[0] as ClientSocket, roomCode);
    const guestView = await guestPromise;
    const [a, b] = seatIds as [SeatId, SeatId];

    expect(hostView.players.find((pl) => pl.id === a)!.money).toBe(2000);
    expect(hostView.players.find((pl) => pl.id === b)!.money).toBeNull();
    expect(guestView.state.players.find((pl) => pl.id === b)!.money).toBe(2000);
    expect(guestView.state.players.find((pl) => pl.id === a)!.money).toBeNull();
    // deck contents are never sent, only counts
    expect('draw' in hostView.decks.hazak).toBe(false);
    expect(hostView.decks.hazak.drawCount).toBeGreaterThan(0);
  }, 8000);

  it('both players see money when visibility is on', async () => {
    const { sockets, seatIds, roomCode } = await setupSocketRoom(2, baseOptions);
    const hostView = await startGame(sockets[0] as ClientSocket, roomCode);

    for (const pl of hostView.players) expect(pl.money).toBe(2000);
    void seatIds;
  }, 8000);

  it('a blind_card is opaque to everyone except the drawing player', async () => {
    const { sockets, seatIds, roomCode } = await setupSocketRoom(2, baseOptions);
    await startGame(sockets[0] as ClientSocket, roomCode);

    const [a, b] = seatIds as [SeatId, SeatId];
    const crafted = craftBase([a, b]);
    stackCard(crafted, 'mahkama', 1);
    crafted.phase = 'blind_card';
    crafted.pending = {
      kind: 'blind_card',
      playerId: a,
      card: crafted.decks.mahkama.draw[crafted.decks.mahkama.draw.length - 1]!,
      cardNumber: 1,
      totalCards: 15,
      remainingDraws: [],
      squareName: 'test',
    };
    give(crafted, b, SQ.gasStation);
    installAndRebind(roomCode, crafted, [
      { seatId: a, socket: sockets[0] as ClientSocket },
      { seatId: b, socket: sockets[1] as ClientSocket },
    ]);
    app.controller.stopTimer(app.manager.getRoom(roomCode) as never);

    // B sells (a phase-independent action) so the reducer broadcasts while A's
    // blind_card is still pending — both sockets get a projected state.
    (sockets[1] as ClientSocket).emit('action', {
      roomCode,
      action: { type: 'SELL_PROPERTY', actorId: b, squareId: SQ.gasStation },
    });

    const drawerView = await waitFor<{ state: ClientState }>(sockets[0] as ClientSocket, 'state', {
      predicate: (p) => p.state.pending.kind === 'blind_card',
    });
    const otherView = await waitFor<{ state: ClientState }>(sockets[1] as ClientSocket, 'state', {
      predicate: (p) => p.state.pending.kind === 'blind_card_hidden',
    });

    expect(drawerView.state.pending.kind).toBe('blind_card');
    if (drawerView.state.pending.kind !== 'blind_card') throw new Error('expected blind_card for drawer');
    expect(drawerView.state.pending.playerId).toBe(a);
    expect(otherView.state.pending).toEqual({
      kind: 'blind_card_hidden',
      playerId: a,
      cardNumber: 1,
      totalCards: 15,
    });
  }, 8000);
});

// ── B19: forged/legacy restore does nothing ──

describe('restore safety (B19)', () => {
  it('rejects a forged snapshot with bad_signature and installs no room', async () => {
    const s = await connect();
    s.emit('restore', { snapshot: { v: 1, payload: 'Zm9yZ2Vk', sig: '0000' }, seatToken: 's-forged' });

    const rejected = await waitFor<{ reason: RejectReason }>(s, 'restore_rejected');
    expect(rejected.reason).toBe('bad_signature');
    expect(app.manager.all()).toHaveLength(0);
  }, 8000);

  it('ignores the legacy restore_game event entirely (no state install)', async () => {
    const s = await connect();
    s.emit('restore_game', { gameState: { money: 999999, hack: true } });
    await sleep(150);
    expect(app.manager.all()).toHaveLength(0);
  }, 8000);
});
