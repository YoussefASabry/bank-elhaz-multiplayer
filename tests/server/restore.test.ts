/**
 * Task 14 — the snapshot wiring. B19: the legacy `restore_game` installed a
 * client-authored `gameState`, so anyone could mint money or ownership.
 *
 * `tests/server/snapshot.test.ts` already covers the crypto in isolation; this
 * file covers the SOCKET-LAYER contract: that a bad blob never reaches a room,
 * that a good one rebuilds one, and that a replay is refused.
 */
import { describe, expect, it } from 'vitest';
import { attemptRestore, issueSnapshot } from '../../src/server/snapshots.js';
import type { SignedSnapshot } from '../../src/shared/events.js';
import { harness, seatRoom } from './harness.js';
import { makeState, SEAT_A, SEAT_B, setMoney } from '../helpers/fixtures.js';

function issued(h: ReturnType<typeof harness>, money = 1500) {
  const s = makeState();
  setMoney(s, SEAT_A, money);
  s.stateVersion = 10;
  const room = seatRoom(h, s, 'ROOM');
  const snap = issueSnapshot(h.ctx, room);
  if (snap === null) throw new Error('no snapshot issued');
  return { s, room, snap };
}

describe('restore — a signed snapshot round-trips', () => {
  it('rebuilds the room and seats the requester', () => {
    const h = harness();
    const { snap } = issued(h);
    h.rooms.destroy('ROOM'); // the room is gone; this is a genuine resume

    const out = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 'sock-new',
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.room.code).toBe('ROOM');
    expect(out.seatId).toBe(SEAT_A);
    expect(h.rooms.locate('sock-new')?.seat.id).toBe(SEAT_A);
  });

  it('resolves the seat by name when the client forgot its id', () => {
    const h = harness();
    const { snap } = issued(h);
    h.rooms.destroy('ROOM');

    const out = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Player 2',
      claimedSeatId: undefined,
      socketId: 'sock-2',
    });

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.seatId).toBe(SEAT_B);
  });
});

describe('restore — forgery is refused (B19)', () => {
  it('rejects a tampered payload', () => {
    const h = harness();
    const { snap } = issued(h);
    h.rooms.destroy('ROOM');

    // Rewrite the state to make SEAT_A rich, keeping the original signature.
    const decoded = JSON.parse(Buffer.from(snap.payload, 'base64').toString('utf8')) as {
      state: { players: { id: string; money: number }[] };
    };
    const target = decoded.state.players.find((p) => p.id === SEAT_A);
    if (target === undefined) throw new Error('no player');
    target.money = 999_999;
    const forged: SignedSnapshot = {
      v: 1,
      payload: Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64'),
      sig: snap.sig,
    };

    const out = attemptRestore(h.ctx, {
      snapshot: forged,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 'sock-x',
    });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad_signature');
    // Nothing was installed.
    expect(h.rooms.get('ROOM')).toBeNull();
  });

  it('rejects a snapshot signed with a different secret', () => {
    const a = harness({ secret: 'secret-aaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const { snap } = issued(a);
    const b = harness({ secret: 'secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb' });

    const out = attemptRestore(b.ctx, {
      snapshot: snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 's',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad_signature');
  });

  it('rejects a non-participant even with a perfectly valid blob', () => {
    const h = harness();
    const { snap } = issued(h);
    h.rooms.destroy('ROOM');

    const out = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Nobody',
      claimedSeatId: 'seat-intruder',
      socketId: 's',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('not_a_participant');
  });
});

describe('restore — replay is refused', () => {
  it('will not restore the same version twice', () => {
    const h = harness();
    const { snap } = issued(h);
    h.rooms.destroy('ROOM');

    const first = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 's1',
    });
    expect(first.ok).toBe(true);
    h.rooms.destroy('ROOM');

    const second = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 's2',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('stale_version');
  });

  it('will not restore an OLDER richer snapshot over a newer one', () => {
    const h = harness();
    // v20 is restored first...
    const rich = issued(h, 9000);
    rich.s.stateVersion = 20;
    const late = issueSnapshot(h.ctx, rich.room);
    if (late === null) throw new Error('no snapshot');
    h.rooms.destroy('ROOM');
    expect(
      attemptRestore(h.ctx, {
        snapshot: late,
        playerName: 'Player 1',
        claimedSeatId: SEAT_A,
        socketId: 's1',
      }).ok,
    ).toBe(true);
    h.rooms.destroy('ROOM');

    // ...so the hoarded v10 blob is now worthless.
    const out = attemptRestore(h.ctx, {
      snapshot: rich.snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 's2',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('stale_version');
  });

  it('refuses to clobber a room that is still live', () => {
    const h = harness();
    const { snap } = issued(h); // room 'ROOM' is still registered and live
    const out = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 's',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('room_is_live');
  });
});

describe('restore — expiry', () => {
  it('rejects a snapshot older than the TTL', () => {
    const h = harness();
    const { snap } = issued(h);
    h.rooms.destroy('ROOM');
    h.advance(25 * 60 * 60 * 1000); // TTL is 24h

    const out = attemptRestore(h.ctx, {
      snapshot: snap,
      playerName: 'Player 1',
      claimedSeatId: SEAT_A,
      socketId: 's',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('expired');
  });
});
