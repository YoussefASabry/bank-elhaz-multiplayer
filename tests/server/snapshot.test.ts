import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSnapshot,
  restoreSnapshot,
  canonicalStringify,
  loadOrCreateSecret,
  type SnapshotPayload,
  type RestoreContext,
} from '../../src/server/snapshot.js';
import { loadVersionStore, type VersionStore } from '../../src/server/versionStore.js';
import { makeState, SEAT_A, SEAT_B, totalMoney } from '../helpers/fixtures.js';
import type { GameState } from '../../src/shared/types.js';

const SECRET = Buffer.from('unit-test-secret-do-not-use-in-prod', 'utf8');
const ROOM = 'ROOM42';

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'bankelhaz-snapshot-'));
}

function makePayload(state: GameState, overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    roomCode: ROOM,
    stateVersion: state.stateVersion,
    issuedAt: 1_000,
    seatIds: [SEAT_A, SEAT_B],
    state,
    ...overrides,
  };
}

function baseCtx(versionStore: VersionStore, overrides: Partial<RestoreContext> = {}): RestoreContext {
  return {
    now: 1_000,
    isRoomLive: () => false,
    versionStore,
    requesterSeatId: SEAT_A,
    ...overrides,
  };
}

function flipOneByte(base64: string): string {
  const buf = Buffer.from(base64, 'base64');
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString('base64');
}

function flipOneHexByte(hex: string): string {
  const chars = hex.split('');
  const first = chars[0] ?? '0';
  chars[0] = first === '0' ? '1' : '0';
  return chars.join('');
}

describe('snapshot signing + replay gate', () => {
  let versionStore: VersionStore;

  beforeEach(() => {
    versionStore = loadVersionStore(tmpDataDir());
  });

  it('a valid snapshot restores with matching stateVersion and money', () => {
    const state = makeState();
    state.stateVersion = 3;
    const money = totalMoney(state);
    const snapshot = createSnapshot(makePayload(state), SECRET);

    const result = restoreSnapshot(snapshot, SECRET, baseCtx(versionStore));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.stateVersion).toBe(3);
      expect(totalMoney(result.payload.state)).toBe(money);
    }
  });

  it('rejects with bad_signature when a byte of the payload is flipped', () => {
    const state = makeState();
    const snapshot = createSnapshot(makePayload(state), SECRET);
    const tampered = { ...snapshot, payload: flipOneByte(snapshot.payload) };

    const result = restoreSnapshot(tampered, SECRET, baseCtx(versionStore));

    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects with bad_signature when a byte of the sig is flipped', () => {
    const state = makeState();
    const snapshot = createSnapshot(makePayload(state), SECRET);
    const tampered = { ...snapshot, sig: flipOneHexByte(snapshot.sig) };

    const result = restoreSnapshot(tampered, SECRET, baseCtx(versionStore));

    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a hand-crafted payload with inflated money and no valid signature', () => {
    const state = makeState();
    const forgedPayload = makePayload(state);
    forgedPayload.state.players[0]!.money = 999_999;
    const forgedPayloadB64 = Buffer.from(canonicalStringify(forgedPayload), 'utf8').toString('base64');

    const result = restoreSnapshot(
      { payload: forgedPayloadB64, sig: 'deadbeef'.repeat(8), v: 1 },
      SECRET,
      baseCtx(versionStore),
    );

    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a re-submitted snapshot after a newer one was already restored (replay)', () => {
    const state = makeState();
    const older = createSnapshot(makePayload(state, { stateVersion: 5 }), SECRET);

    const first = restoreSnapshot(older, SECRET, baseCtx(versionStore));
    expect(first.ok).toBe(true);

    // Re-submitting the exact same (now-consumed) snapshot must be rejected.
    const replay = restoreSnapshot(older, SECRET, baseCtx(versionStore));
    expect(replay).toEqual({ ok: false, reason: 'stale_version' });

    // A strictly newer one is still fine...
    const newer = createSnapshot(makePayload(state, { stateVersion: 6 }), SECRET);
    const second = restoreSnapshot(newer, SECRET, baseCtx(versionStore));
    expect(second.ok).toBe(true);

    // ...but that older snapshot is now stale too.
    const staleAgain = restoreSnapshot(older, SECRET, baseCtx(versionStore));
    expect(staleAgain).toEqual({ ok: false, reason: 'stale_version' });
  });

  it('rejects a snapshot whose version equals the highest already restored (not just older ones)', () => {
    const state = makeState();
    const first = createSnapshot(makePayload(state, { stateVersion: 5 }), SECRET);
    expect(restoreSnapshot(first, SECRET, baseCtx(versionStore)).ok).toBe(true);

    // A DIFFERENT snapshot carrying the SAME version 5 must also be rejected —
    // restoring consumes the version, it is not free to repeat at parity.
    const sameVersionDifferentState = makeState({ cash: 12345 });
    sameVersionDifferentState.stateVersion = 5;
    const equalVersion = createSnapshot(
      makePayload(sameVersionDifferentState, { stateVersion: 5 }),
      SECRET,
    );

    expect(restoreSnapshot(equalVersion, SECRET, baseCtx(versionStore))).toEqual({
      ok: false,
      reason: 'stale_version',
    });
  });

  it('routes a snapshot for a still-live room to room_is_live instead of installing it', () => {
    const state = makeState();
    const snapshot = createSnapshot(makePayload(state), SECRET);

    const result = restoreSnapshot(snapshot, SECRET, baseCtx(versionStore, { isRoomLive: () => true }));

    expect(result).toEqual({ ok: false, reason: 'room_is_live' });
  });

  it('rejects an expired snapshot', () => {
    const state = makeState();
    const issuedAt = 0;
    const ttlMs = 1_000;
    const snapshot = createSnapshot(makePayload(state, { issuedAt, stateVersion: 1 }), SECRET);

    const result = restoreSnapshot(snapshot, SECRET, baseCtx(versionStore, { now: issuedAt + ttlMs + 1, ttlMs }));

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a snapshot right at the TTL boundary', () => {
    const state = makeState();
    const issuedAt = 0;
    const ttlMs = 1_000;
    const snapshot = createSnapshot(makePayload(state, { issuedAt, stateVersion: 1 }), SECRET);

    const atBoundary = restoreSnapshot(snapshot, SECRET, baseCtx(versionStore, { now: issuedAt + ttlMs, ttlMs }));

    expect(atBoundary.ok).toBe(true);
  });

  it('rejects a requester whose seat id is absent from seatIds', () => {
    const state = makeState();
    const snapshot = createSnapshot(makePayload(state, { seatIds: [SEAT_A], stateVersion: 1 }), SECRET);

    const result = restoreSnapshot(snapshot, SECRET, baseCtx(versionStore, { requesterSeatId: SEAT_B }));

    expect(result).toEqual({ ok: false, reason: 'not_a_participant' });
  });

  it('rejects a well-signed but structurally malformed payload', () => {
    // Valid JSON, correctly signed with the real secret, but missing the
    // required fields — the shape check must still fail closed.
    const badPayloadB64 = Buffer.from(canonicalStringify({ nonsense: true }), 'utf8').toString('base64');
    const sig = createHmac('sha256', SECRET).update(badPayloadB64, 'utf8').digest('hex');
    const snapshot = { payload: badPayloadB64, sig, v: 1 as const };

    const result = restoreSnapshot(snapshot, SECRET, baseCtx(versionStore));

    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('produces byte-stable canonical JSON regardless of key insertion order', () => {
    const a = canonicalStringify({ b: 1, a: 2, nested: { z: 1, y: 2 } });
    const b = canonicalStringify({ a: 2, nested: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
  });

  it('uses crypto.timingSafeEqual for signature comparison, not a naive === on the signature', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/server/snapshot.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(/\.sig\s*===/);
    expect(source).not.toMatch(/snapshot\.sig\s*==/);
  });
});

describe('loadOrCreateSecret', () => {
  const originalEnv = process.env['BANKELHAZ_SECRET'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['BANKELHAZ_SECRET'];
    else process.env['BANKELHAZ_SECRET'] = originalEnv;
    vi.restoreAllMocks();
  });

  it('prefers BANKELHAZ_SECRET when set, and does not touch disk', () => {
    process.env['BANKELHAZ_SECRET'] = 'my-explicit-secret';
    const { secret, autoGenerated } = loadOrCreateSecret(tmpDataDir());
    expect(autoGenerated).toBe(false);
    expect(secret.toString('utf8')).toBe('my-explicit-secret');
  });

  it('auto-generates, persists at 0600, and warns loudly when nothing else is set', () => {
    delete process.env['BANKELHAZ_SECRET'];
    const dataDir = tmpDataDir();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { secret, autoGenerated } = loadOrCreateSecret(dataDir);

    expect(autoGenerated).toBe(true);
    expect(secret.length).toBe(32);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/BANKELHAZ_SECRET/);

    const stat = statSync(join(dataDir, 'secret'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reuses a previously persisted secret on the next load, without warning again', () => {
    delete process.env['BANKELHAZ_SECRET'];
    const dataDir = tmpDataDir();

    const first = loadOrCreateSecret(dataDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = loadOrCreateSecret(dataDir);

    expect(second.autoGenerated).toBe(false);
    expect(second.secret.equals(first.secret)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('versionStore', () => {
  it('starts at 0 and only bumps on a strictly higher version, persisting synchronously', () => {
    const dataDir = tmpDataDir();
    const store = loadVersionStore(dataDir);
    expect(store.getHighest(ROOM)).toBe(0);

    store.recordSeen(ROOM, 5);
    store.recordSeen(ROOM, 3); // lower — ignored
    expect(store.getHighest(ROOM)).toBe(5);

    // Recovers across a reload, simulating a server restart.
    const reloaded = loadVersionStore(dataDir);
    expect(reloaded.getHighest(ROOM)).toBe(5);
  });
});
