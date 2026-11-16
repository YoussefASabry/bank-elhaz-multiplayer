/**
 * Seats outlive sockets (B20), and nothing ever splices a running turn order (B06).
 */
import { describe, expect, it } from 'vitest';
import { RoomStore, wirePlayers, isHost } from '../../src/server/rooms.js';
import { harness, seatRoom } from './harness.js';
import { makeState, SEAT_A, SEAT_B } from '../helpers/fixtures.js';

describe('rooms — a seat id is not a socket id (B20)', () => {
  it('keeps the same seat id across a reconnect', () => {
    const store = new RoomStore();
    const room = store.create('Alice', 1, 'socket-1', {});
    const seat = room.seats[0];
    if (seat === undefined) throw new Error('no seat');
    const originalId = seat.id;

    store.markDisconnected(room, seat);
    store.attach(room, seat, 'socket-2');

    expect(seat.id).toBe(originalId);
    expect(seat.socketId).toBe('socket-2');
    expect(store.locate('socket-2')?.seat.id).toBe(originalId);
    expect(store.locate('socket-1')).toBeNull();
  });

  it('never puts a socket id into game state', () => {
    const h = harness();
    const s = makeState();
    const room = seatRoom(h, s);
    const json = JSON.stringify(s);
    for (const seat of room.seats) {
      expect(json).not.toContain(String(seat.socketId));
    }
  });

  it('re-attaching flips the engine player back to connected', () => {
    const h = harness();
    const s = makeState();
    const room = seatRoom(h, s);
    const seat = room.seats[0];
    if (seat === undefined) throw new Error('no seat');

    h.rooms.markDisconnected(room, seat);
    s.players[0]!.connected = false;
    h.rooms.attach(room, seat, 'socket-new');

    expect(s.players[0]?.connected).toBe(true);
  });
});

describe('rooms — joining', () => {
  it('refuses a kicked name', () => {
    const store = new RoomStore();
    const room = store.create('Alice', 1, 's1', {});
    room.kicked.add('Mallory');
    const res = store.join(room.code, 'Mallory', 1, 's2');
    expect(res.ok).toBe(false);
  });

  it('treats a disconnected same-name seat as a reconnect, not a new player', () => {
    const store = new RoomStore();
    const room = store.create('Alice', 1, 's1', {});
    store.join(room.code, 'Bob', 2, 's2');
    const bob = room.seats.find((s) => s.name === 'Bob');
    if (bob === undefined) throw new Error('no bob');
    store.markDisconnected(room, bob);

    const res = store.join(room.code, 'Bob', 2, 's3');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejoined).toBe(true);
    expect(room.seats).toHaveLength(2);
    expect(res.seat.id).toBe(bob.id);
  });

  it('refuses a new player once the game has started', () => {
    const h = harness();
    const s = makeState();
    const room = seatRoom(h, s);
    const res = h.rooms.join(room.code, 'Latecomer', 1, 'sX');
    expect(res.ok).toBe(false);
  });

  it('the first seat is the host and stays the host', () => {
    const store = new RoomStore();
    const room = store.create('Alice', 1, 's1', {});
    store.join(room.code, 'Bob', 2, 's2');
    const alice = room.seats[0];
    const bob = room.seats[1];
    if (alice === undefined || bob === undefined) throw new Error('seats');
    expect(isHost(room, alice.id)).toBe(true);
    expect(isHost(room, bob.id)).toBe(false);
  });
});

describe('rooms — the wire shape of the lobby list', () => {
  it('matches the legacy `{id, name, avatar, connected}` exactly', () => {
    const store = new RoomStore();
    const room = store.create('Alice', 3, 's1', {});
    const players = wirePlayers(room);
    expect(players).toHaveLength(1);
    expect(Object.keys(players[0] ?? {}).sort()).toEqual(
      ['avatar', 'connected', 'id', 'name'].sort(),
    );
  });
});

describe('rooms — removing a seat does not disturb turn order (B06)', () => {
  it('leaves players and currentPlayerIndex untouched in game state', () => {
    const h = harness();
    const s = makeState();
    s.currentPlayerIndex = 2;
    const room = seatRoom(h, s);
    const victim = room.seats.find((x) => x.id === SEAT_A);
    if (victim === undefined) throw new Error('no seat');

    h.rooms.removeSeat(room, victim);

    expect(room.seats).toHaveLength(2);
    // The running game is untouched — no splice, no index shift.
    expect(s.players).toHaveLength(3);
    expect(s.currentPlayerIndex).toBe(2);
    expect(s.players.map((q) => q.id)).toContain(SEAT_A);
    expect(s.players.map((q) => q.id)).toContain(SEAT_B);
  });
});
