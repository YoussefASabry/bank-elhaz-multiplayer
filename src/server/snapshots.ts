/**
 * Task 14 — wiring `snapshot.ts` + `versionStore.ts` into the socket layer.
 *
 * The legacy `restore_game` handler (`server.js:569`) took a `gameState`
 * straight off the wire and installed it:
 *
 *     socket.on('restore_game', ({ roomCode, playerName, playerId, gameState }) => {
 *       room = manager.createRoomFromState(roomCode, gameState);   // ← B19
 *
 * Any client could fabricate money, ownership, or a winning position. Resume is
 * kept (the user chose signed snapshots over deleting the feature), but the
 * client now holds only an **opaque blob it cannot forge or usefully replay**:
 *
 *   - HMAC-SHA256 over canonical JSON, compared with `timingSafeEqual`.
 *   - Version-gated against a persisted high-water mark, so hoarding a
 *     legitimately-signed *rich* snapshot and restoring it later fails.
 *   - TTL- and participant-checked.
 *
 * `snapshot.ts` does all of that and is deliberately pure — it never installs
 * state. Installing is this module's job, and it only ever happens after
 * `restoreSnapshot` returns `ok: true`.
 */
import type { RestoreRejection, SignedSnapshot } from '../shared/events.js';
import type { GameState, SeatId } from '../shared/types.js';
import type { ServerCtx } from './context.js';
import type { Room } from './rooms.js';
import { createSnapshot, restoreSnapshot } from './snapshot.js';

/** Mint a signed snapshot of the room's current state. */
export function issueSnapshot(ctx: ServerCtx, room: Room): SignedSnapshot | null {
  const state = room.state;
  if (state === null) return null;
  return createSnapshot(
    {
      roomCode: room.code,
      stateVersion: state.stateVersion,
      issuedAt: ctx.now(),
      seatIds: state.players.map((p) => p.id),
      state,
    },
    ctx.secret,
  );
}

export type RestoreOutcome =
  | { ok: true; room: Room; seatId: SeatId; state: GameState }
  /** The room is already running — the caller should route to a plain rejoin. */
  | { ok: false; reason: RestoreRejection };

/** Human-readable text for the legacy `restore_game_result.error` field. */
export function restoreErrorMessage(reason: RestoreRejection): string {
  switch (reason) {
    case 'bad_signature':
      return 'Snapshot signature is invalid';
    case 'stale_version':
      return 'A newer state has already been restored for this room';
    case 'expired':
      return 'Snapshot has expired';
    case 'not_a_participant':
      return 'You were not part of that game';
    case 'room_is_live':
      return 'That room is still running — rejoin instead';
    case 'malformed':
      return 'Snapshot is unreadable';
    default: {
      const never: never = reason;
      throw new Error(`Unhandled restore rejection: ${String(never)}`);
    }
  }
}

/**
 * Verify a client-supplied snapshot and, only on success, rebuild the room
 * around it.
 *
 * `requesterSeatId` is resolved from the blob's own player list by name when
 * the client did not remember its seat id — the name is a *lookup key into
 * signed data*, never a grant of authority: `restoreSnapshot` still enforces
 * participant membership against the signed `seatIds`.
 */
export function attemptRestore(
  ctx: ServerCtx,
  args: {
    snapshot: SignedSnapshot;
    playerName: string;
    claimedSeatId?: SeatId | undefined;
    socketId: string;
  },
): RestoreOutcome {
  // Resolve which seat is asking BEFORE trusting anything: peek at the payload
  // only to map a name to a seat id, then let restoreSnapshot re-parse and
  // re-verify from scratch. A forged blob dies at the signature check either way.
  const peeked = peekSeats(args.snapshot);
  const requesterSeatId =
    args.claimedSeatId ??
    peeked.find((p) => p.name === args.playerName)?.id ??
    '';

  const result = restoreSnapshot(args.snapshot, ctx.secret, {
    now: ctx.now(),
    isRoomLive: (code) => ctx.rooms.isLive(code),
    versionStore: ctx.versions,
    requesterSeatId,
  });

  if (!result.ok) return { ok: false, reason: result.reason };

  const { payload } = result;
  const room = ctx.rooms.createFromState(payload.roomCode, payload.state, {});
  if (room === null) return { ok: false, reason: 'room_is_live' };

  const seat = ctx.rooms.seatOf(room, requesterSeatId);
  if (seat === undefined) return { ok: false, reason: 'not_a_participant' };
  ctx.rooms.attach(room, seat, args.socketId);

  return { ok: true, room, seatId: seat.id, state: payload.state };
}

/**
 * Read the seat list out of an UNVERIFIED blob, for name→id resolution only.
 * Returns nothing on any parse failure; the real gate is `restoreSnapshot`.
 */
function peekSeats(snapshot: SignedSnapshot): { id: SeatId; name: string }[] {
  try {
    const raw: unknown = JSON.parse(Buffer.from(snapshot.payload, 'base64').toString('utf8'));
    if (raw === null || typeof raw !== 'object') return [];
    const state = (raw as { state?: unknown }).state;
    if (state === null || typeof state !== 'object') return [];
    const players = (state as { players?: unknown }).players;
    if (!Array.isArray(players)) return [];
    return players.flatMap((p: unknown) => {
      if (p === null || typeof p !== 'object') return [];
      const id = (p as { id?: unknown }).id;
      const name = (p as { name?: unknown }).name;
      return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
    });
  } catch {
    return [];
  }
}
