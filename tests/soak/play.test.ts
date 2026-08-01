/**
 * Soak test: four REAL socket clients play a full game against the LIVE server
 * (createApp on an ephemeral port — no transport stubs), and the whole thing
 * unfolds in the test log.
 *
 * The bots play a deterministic, aggressive policy (buy when affordable, build
 * when affordable, claim free properties, pay rent) so the economy moves and
 * players actually go bankrupt. On every 4th decision a bot deliberately does
 * NOTHING and lets the server's per-room timer expire, so the TIMEOUT path
 * (B02/B22) is exercised continuously through a real game instead of only in
 * crafted unit states.
 *
 * Invariants are asserted on EVERY state broadcast, which catches the whole
 * bug-class families this refactor was built around:
 *
 *   - players.length is constant (B06 — kicks/elimination never splice)
 *   - stateVersion never goes backwards (B19 — snapshot/replay order)
 *   - pending.kind and phase stay in lockstep (B02 — no stray phase)
 *   - pending.playerId is always the current player (B09 — no cross-player acts)
 *   - exactly one TURN_STARTED per events batch, strictly increasing turnNumber;
 *     a repeat of the same seat is legal only when a skipNextTurn player was
 *     skipped in the same batch (advanceTurn wraps and hands the turn back)
 *   - game over is terminal: phase `game_over`, winner matches the survivors
 *   - money is always a finite number (never NaN)
 *
 * A liveness watchdog fails the test if no state arrives for a long stretch —
 * the exact freeze symptom of the old B01 stacked-interval / B02 missing-branch
 * bugs.
 *
 * The game ends either by natural game over or by hitting MAX_TURNS; both are
 * passes as long as every invariant held and turns kept flowing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type BankElhazApp } from '../../src/server/main.js';
import type { Action, DomainEvent } from '../../src/shared/actions.js';
import type { ClientState, RoomOptions } from '../../src/shared/events.js';
import type { Choice, Phase, SeatId, SquareId } from '../../src/shared/types.js';

const OPTIONS: RoomOptions = {
  // A tight economy so a real game-over happens within the soak window: with
  // generous cash + salary the bots never dip negative and the game never ends.
  // At 500/50 the rents and card fines actually bite.
  startingCash: 500,
  passGoSalary: 50,
  diceCount: 2,
  moneyVisible: true,
  tradeTiming: 'anytime',
  onBankruptcy: 'eliminate',
  turnTimeoutSeconds: 1,
  rentTurnTimeoutSeconds: 1,
};

/** Stop the soak after this many handovers even if no one is bankrupt yet. */
const MAX_TURNS = 150;
/** Every Nth decision a bot waits and lets the server timer auto-pass (B02). */
const LAZY_EVERY = 4;
/** Fail if no state broadcast arrives within this window (freeze detection). */
const WATCHDOG_MS = 20_000;

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
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 5000);
    socket.emit(event, payload, (r: T) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

// ── Bot policy ──

/** Prison square's bail cost from the projected board, or 0 if unknown. */
function prisonBail(state: ClientState): number {
  for (const sq of state.board.squares) {
    if (sq.kind === 'corner' && sq.effect === 'prison') return sq.bailCost;
  }
  return 0;
}

/**
 * `CHOOSE_CARD_OPTION` indexes into the FLATTENED option list (HANDOFF §6):
 * a pool-bearing choice expands to one entry per property. Prefer claiming a
 * property, then moving, then cash, then the cheapest fine, then prison.
 */
function pickCardOption(pending: Extract<ClientState['pending'], { kind: 'card_choice' }>): number {
  const flat: Array<{ choice: Choice; squareId?: SquareId }> = [];
  for (const choice of pending.options) {
    if (choice.type === 'claim_free_property' || choice.type === 'move_to_dynamic_pool') {
      for (const squareId of pending.propertyPool) flat.push({ choice, squareId });
    } else {
      flat.push({ choice });
    }
  }
  const preferred: Choice['type'][] = [
    'claim_free_property',
    'move_to_dynamic_pool',
    'receive_cash',
    'pay_fine',
    'go_to_prison',
  ];
  for (const type of preferred) {
    const idx = flat.findIndex((f) => f.choice.type === type);
    if (idx >= 0) return idx;
  }
  return 0;
}

/**
 * The bot's move for the current projected state. Returns the action to send,
 * or null when this bot has nothing to do right now (not its turn, it's out,
 * the game is over, or the pending references someone else).
 */
function botDecision(state: ClientState, me: SeatId): Action | null {
  if (state.gameOver) return null;
  const mePlayer = state.players.find((pl) => pl.id === me);
  if (mePlayer === undefined || mePlayer.isBankrupt || mePlayer.eliminated) return null;
  if (state.players[state.currentPlayerIndex]?.id !== me) return null;

  switch (state.phase) {
    case 'roll':
      if (mePlayer.statusEffects.missedTurnsRemaining > 0) {
        if (mePlayer.inventory.jailFreeCards > 0) return { type: 'USE_JAIL_FREE', actorId: me };
        if (mePlayer.money !== null && mePlayer.money >= prisonBail(state) + 100) {
          return { type: 'PAY_BAIL', actorId: me };
        }
        return { type: 'SKIP_PRISON_TURN', actorId: me };
      }
      return { type: 'ROLL_DICE', actorId: me };
    case 'rolling':
      return { type: 'CONFIRM_LANDING', actorId: me };
    case 'draw_card': {
      const pending = state.pending;
      if (pending.kind !== 'deck_draw' || pending.playerId !== me) return null;
      const deck = pending.queue[0];
      if (deck === undefined) return null;
      return { type: 'DRAW_CARD', actorId: me, deck };
    }
    case 'blind_card': {
      if (state.pending.kind !== 'blind_card' || state.pending.playerId !== me) return null;
      return { type: 'CONFIRM_CARD', actorId: me };
    }
    case 'card_choice': {
      if (state.pending.kind !== 'card_choice' || state.pending.playerId !== me) return null;
      return { type: 'CHOOSE_CARD_OPTION', actorId: me, index: pickCardOption(state.pending) };
    }
    case 'club_choice': {
      const pending = state.pending;
      if (pending.kind !== 'club' || pending.playerId !== me) return null;
      if (mePlayer.money !== null && mePlayer.money >= pending.membershipCost + 100) {
        return { type: 'CHOOSE_CLUB', actorId: me, choice: 'membership' };
      }
      return { type: 'CHOOSE_CLUB', actorId: me, choice: 'guest' };
    }
    case 'property_choice': {
      const pending = state.pending;
      if (pending.kind !== 'property_buy' || pending.playerId !== me) return null;
      // Always buy: the pending is only installed when the player can afford
      // the price, and buying drains cash to the bank, tightening the economy.
      return { type: 'RESOLVE_PROPERTY_BUY', actorId: me, buy: true };
    }
    case 'upgrade_choice': {
      const pending = state.pending;
      if (pending.kind !== 'upgrade' || pending.playerId !== me) return null;
      const opt = pending.options[0];
      if (opt === undefined) return { type: 'SKIP_UPGRADE', actorId: me };
      // Build whenever the next tier is affordable: it makes the game's rents
      // (and thus bankruptcies) happen faster.
      if (mePlayer.money !== null && mePlayer.money >= opt.cost) {
        return { type: 'BUY_UPGRADE', actorId: me, squareId: pending.squareId, tier: opt.tier };
      }
      return { type: 'SKIP_UPGRADE', actorId: me };
    }
    case 'rent_payment': {
      if (state.pending.kind !== 'rent' || state.pending.playerId !== me) return null;
      return { type: 'PAY_RENT', actorId: me };
    }
    case 'game_over':
      return null;
    default: {
      const never: never = state.phase;
      void never;
      return null;
    }
  }
}

// ── Invariants ──

/**
 * pending.kind → the phase(s) it may coexist with. `none` is legal in both
 * `roll` (nothing rolled yet) and `rolling` (rolled, awaiting CONFIRM_LANDING —
 * that decision is phase-encoded, not pending-encoded).
 */
const PENDING_PHASES: Record<string, readonly Phase[]> = {
  none: ['roll', 'rolling'],
  property_buy: ['property_choice'],
  rent: ['rent_payment'],
  club: ['club_choice'],
  upgrade: ['upgrade_choice'],
  deck_draw: ['draw_card'],
  blind_card: ['blind_card'],
  blind_card_hidden: ['blind_card'],
  card_choice: ['card_choice'],
};

interface InvariantCtx {
  seatCount: number;
  lastVersion: number;
}

/** Returns a failure description, or null when the state is consistent. */
function checkStateInvariants(state: ClientState, ctx: InvariantCtx): string | null {
  if (state.players.length !== ctx.seatCount) {
    return `players.length changed: ${ctx.seatCount} -> ${state.players.length}`;
  }
  const cur = state.players[state.currentPlayerIndex];
  if (cur === undefined) return `no player at currentPlayerIndex ${state.currentPlayerIndex}`;
  if (state.stateVersion < ctx.lastVersion) {
    return `stateVersion went backwards: ${ctx.lastVersion} -> ${state.stateVersion}`;
  }
  ctx.lastVersion = state.stateVersion;

  for (const pl of state.players) {
    if (pl.money !== null && !Number.isFinite(pl.money)) return `player ${pl.id} has non-finite money ${pl.money}`;
  }

  if (state.gameOver) {
    if (state.phase !== 'game_over') return `gameOver=true but phase is ${state.phase}`;
    const active = state.players.filter((pl) => !pl.isBankrupt && !pl.eliminated);
    const expected = active.length === 1 ? (active[0]!.id as SeatId | null) : null;
    if (state.winnerId !== expected) {
      return `winnerId ${state.winnerId} does not match survivors [${active.map((p) => p.id).join(', ')}]`;
    }
    return null;
  }
  if (state.phase === 'game_over') return 'phase game_over without gameOver=true';

  const expected = PENDING_PHASES[state.pending.kind];
  if (expected === undefined || !expected.includes(state.phase)) {
    return `pending ${state.pending.kind} but phase ${state.phase} (expected ${expected?.join(' or ') ?? '?'})`;
  }
  if (state.pending.kind !== 'none' && state.pending.playerId !== cur.id) {
    return `pending.playerId ${state.pending.playerId} != current player ${cur.id}`;
  }
  return null;
}

// ── Log digest ──

/** Render a DomainEvent as a single log line, or null for uninteresting ones. */
function digestEvent(e: DomainEvent): string | null {
  switch (e.type) {
    case 'TURN_STARTED':
      return `>> turn ${e.turnNumber} | ${e.playerId}`;
    case 'DICE_ROLLED':
      return `   dice ${e.die1}+${e.die2}=${e.total} (steps ${e.steps}${e.doubleApplied ? ', doubled' : ''}) by ${e.playerId}`;
    case 'MOVED':
      return `   moved ${e.from} -> ${e.to} by ${e.playerId}${e.teleported ? ' (teleport)' : ''}`;
    case 'PASSED_GO':
      return `   salary +${e.amount} to ${e.playerId}`;
    case 'PROPERTY_BOUGHT':
      return `   ${e.playerId} bought sq ${e.squareId} for ${e.price}`;
    case 'PROPERTY_DECLINED':
      return `   ${e.playerId} declined sq ${e.squareId}`;
    case 'PROPERTY_SOLD':
      return `   ${e.playerId} sold sq ${e.squareId}`;
    case 'RENT_DUE':
      return `   rent ${e.amount} owed by ${e.playerId}${e.ownerId !== null ? ` to ${e.ownerId}` : ' (to bank)'} on sq ${e.squareId}`;
    case 'RENT_PAID':
      return `   ${e.playerId} paid ${e.amount} rent${e.ownerId !== null ? ` to ${e.ownerId}` : ''}`;
    case 'UPGRADE_BUILT':
      return `   ${e.playerId} built ${e.tier} on sq ${e.squareId} for ${e.cost}`;
    case 'UPGRADE_SOLD':
      return `   ${e.playerId} sold ${e.tier} on sq ${e.squareId}`;
    case 'CARD_DRAWN':
      return `   ${e.playerId} drew ${e.deck}#${e.cardId}`;
    case 'CARD_RESOLVED':
      return `   ${e.playerId} resolved card: ${e.description}`;
    case 'CITY_OWNERS_CHARGED':
      return `   ${e.playerId} charged city owners [${e.chargedPlayerIds.join(', ')}] total ${e.totalCollected}`;
    case 'JAILED':
      return `   ${e.playerId} jailed (${e.turnsToMiss} turns)`;
    case 'RELEASED_FROM_JAIL':
      return `   ${e.playerId} released via ${e.via}`;
    case 'PRISON_TURN_SKIPPED':
      return `   ${e.playerId} skipped prison turn (${e.remaining} left)`;
    case 'CLUB_RESOLVED':
      return `   ${e.playerId} club: ${e.choice} (${e.cost})`;
    case 'DOUBLE_NEXT_ROLL_GRANTED':
      return `   ${e.playerId} granted double next roll`;
    case 'TURN_SKIPPED':
      return `   ${e.playerId} turn skipped (${e.reason})`;
    case 'BANKRUPT':
      return `   XXX ${e.playerId} BANKRUPT (${e.rule})`;
    case 'PLAYER_KICKED':
      return `   XXX ${e.playerId} kicked by ${e.by}`;
    case 'GAME_OVER':
      return `== GAME OVER: winner ${e.winnerId ?? 'none'} ==`;
    default:
      return null;
  }
}

// ── The soak ──

interface SoakResult {
  endReason: 'game_over' | 'turn_cap';
  turns: number;
  winnerId: SeatId | null;
  botActions: number;
  botWaits: number;
  rejections: number;
  playersAtEnd: Array<{ id: SeatId; money: number | null; bankrupt: boolean; eliminated: boolean; properties: number }>;
}

beforeAll(async () => {
  app = createApp(mkdtempSync(join(tmpdir(), 'bankelhaz-soak-')));
  port = await app.start(0);
});

afterAll(async () => {
  for (const socket of openSockets) {
    if (socket.connected) socket.disconnect();
  }
  await app.close();
});

describe('soak: four real clients play a full game', () => {
  it('plays to game over (or the turn cap) with every invariant holding', async () => {
    // ── Lobby: host + 3 joiners ──
    const sockets: ClientSocket[] = [];
    const names = ['Host', 'P1', 'P2', 'P3'];

    const host = await connect();
    sockets.push(host);
    const hostAck = await emitAck<{ ok: boolean; roomCode?: string; you?: SeatId; error?: string }>(host, 'host_game', {
      playerName: names[0],
      avatar: 1,
      options: OPTIONS,
    });
    expect(hostAck.ok).toBe(true);
    const roomCode = hostAck.roomCode as string;
    const seatIds: SeatId[] = [hostAck.you as SeatId];

    for (let i = 1; i < 4; i++) {
      const s = await connect();
      sockets.push(s);
      const ack = await emitAck<{ ok: boolean; you?: SeatId; error?: string }>(s, 'join_game', {
        roomCode,
        playerName: names[i],
        avatar: i + 1,
      });
      expect(ack.ok).toBe(true);
      seatIds.push(ack.you as SeatId);
    }

    host.emit('start_game', { roomCode });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for game_started')), 5000);
      host.once('game_started', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // ── Watchers ──
    let settled = false;
    let resolveSoak: (r: SoakResult) => void = () => {};
    let rejectSoak: (e: Error) => void = () => {};
    const finished = new Promise<SoakResult>((res, rej) => {
      resolveSoak = res;
      rejectSoak = rej;
    });

    const stateCtx: InvariantCtx = { seatCount: 4, lastVersion: -1 };
    let turnsSeen = 0;
    let lastTurnNumber = 0;
    let lastTurnPlayer: SeatId | null = null;
    let lastStateAt = Date.now();
    let botActions = 0;
    let botWaits = 0;
    let rejections = 0;
    let winnerId: SeatId | null = null;
    let endReason: SoakResult['endReason'] = 'turn_cap';
    const failures: string[] = [];

    function settle(result?: SoakResult, error?: Error): void {
      if (settled) return;
      settled = true;
      if (error !== undefined) rejectSoak(error);
      else resolveSoak(result as SoakResult);
    }

    // Liveness watchdog: a long silence means the turn machine froze (B01/B02).
    const watchdog = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastStateAt > WATCHDOG_MS) {
        settle(undefined, new Error(`freeze detected: no state for ${WATCHDOG_MS}ms (after ${turnsSeen} turns)`));
      }
    }, 2000);

    host.on('events', (p: { events: DomainEvent[] }) => {
      if (settled) return;
      for (const e of p.events) {
        const line = digestEvent(e);
        if (line !== null) console.log(line);
      }
      const started = p.events.filter((e) => e.type === 'TURN_STARTED');
      if (started.length > 1) {
        failures.push(`events batch carried ${started.length} TURN_STARTED (must be at most one)`);
      }
      for (const e of started) {
        if (e.type !== 'TURN_STARTED') continue;
        if (e.turnNumber <= lastTurnNumber) {
          failures.push(`turnNumber ${e.turnNumber} did not increase after ${lastTurnNumber}`);
        }
        // Normally the turn alternates, but a skipNextTurn player in the middle
        // legitimately hands the turn straight back to the previous holder
        // (the loop in advanceTurn skips them and wraps around). The soak
        // caught this as a false positive, so a repeat is only legal when the
        // same batch skipped someone.
        if (e.playerId === lastTurnPlayer && !p.events.some((x) => x.type === 'TURN_SKIPPED')) {
          failures.push(`TURN_STARTED twice in a row for ${e.playerId} with no skip in between`);
        }
        lastTurnNumber = e.turnNumber;
        lastTurnPlayer = e.playerId;
        turnsSeen += 1;
      }
      if (failures.length > 0) settle(undefined, new Error(`invariant violation: ${failures[0]}`));
      if (turnsSeen >= MAX_TURNS && !settled) {
        settle({ endReason, turns: turnsSeen, winnerId, botActions, botWaits, rejections, playersAtEnd: [] });
      }
    });

    host.on('state', (p: { state: ClientState }) => {
      if (settled) return;
      lastStateAt = Date.now();
      const failure = checkStateInvariants(p.state, stateCtx);
      if (failure !== null) {
        settle(undefined, new Error(`invariant violation at version ${p.state.stateVersion}: ${failure}`));
        return;
      }
      if (p.state.gameOver) {
        winnerId = p.state.winnerId;
        endReason = 'game_over';
        settle({
          endReason,
          turns: turnsSeen,
          winnerId,
          botActions,
          botWaits,
          rejections,
          playersAtEnd: p.state.players.map((pl) => ({
            id: pl.id,
            money: pl.money,
            bankrupt: pl.isBankrupt,
            eliminated: pl.eliminated,
            properties: Object.values(p.state.ownership).filter((o) => o.owner === pl.id).length,
          })),
        });
      }
    });

    // ── Bots: respond on their turn, occasionally wait for the timeout ──
    const lastRespondedVersion = new Map<SeatId, number>();
    const decisions = new Map<SeatId, number>();

    for (let i = 0; i < 4; i++) {
      const seat = seatIds[i] as SeatId;
      lastRespondedVersion.set(seat, -1);
      decisions.set(seat, 0);
      const socket = sockets[i] as ClientSocket;

      socket.on('state', (p: { state: ClientState }) => {
        if (settled) return;
        const state = p.state;
        if (state.stateVersion <= (lastRespondedVersion.get(seat) ?? -1)) return;
        lastRespondedVersion.set(seat, state.stateVersion);

        const action = botDecision(state, seat);
        if (action === null) return;

        const n = decisions.get(seat) ?? 0;
        decisions.set(seat, n + 1);
        if ((n + 1) % LAZY_EVERY === 0) {
          // Deliberately idle: the server timer auto-passes in ~1s (B02/B22).
          botWaits += 1;
          return;
        }
        botActions += 1;
        socket.emit('action', { roomCode, action });
      });

      socket.on('rejected', () => {
        if (settled) return;
        rejections += 1;
      });
    }

    // ── Run until game over or the turn cap ──
    let result: SoakResult;
    try {
      result = await finished;
    } finally {
      clearInterval(watchdog);
    }

    // ── Assertions ──
    expect(failures).toEqual([]);
    expect(result.turns).toBeGreaterThanOrEqual(10); // the game actually moved
    expect(result.rejections).toBeLessThanOrEqual(25); // no rejection storm
    expect(result.botActions).toBeGreaterThan(0);

    const active = result.playersAtEnd.filter((pl) => !pl.bankrupt && !pl.eliminated);
    if (result.endReason === 'game_over') {
      expect(active.length).toBeLessThanOrEqual(1);
      expect(result.winnerId).toBe(active.length === 1 ? active[0]!.id : null);
    }

    // ── Final log ──
    console.log('\n==== soak summary ====');
    console.log(`end reason: ${result.endReason} | turns: ${result.turns} | winner: ${result.winnerId ?? 'none'}`);
    console.log(`bot actions: ${result.botActions} | timeout auto-passes: ${result.botWaits} | rejections: ${result.rejections}`);
    for (const pl of result.playersAtEnd) {
      console.log(
        `  ${pl.id.padEnd(8)} money ${String(pl.money).padStart(6)}  props ${pl.properties}  ` +
          `${pl.bankrupt ? 'BANKRUPT ' : ''}${pl.eliminated ? 'KICKED ' : ''}`,
      );
    }
    console.log('==========================');
  }, 300000);
});
