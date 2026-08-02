/**
 * The dispatch pipeline: one writer, one event map, one timer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, broadcastState } from '../../src/server/dispatch.js';
import { SYSTEM_ACTOR } from '../../src/shared/actions.js';
import { stopTurnTimer } from '../../src/server/turnTimer.js';
import { harness, seatRoom, sock } from './harness.js';
import { makeState, SEAT_A, SEAT_B, setTurn, give, setMoney, p } from '../helpers/fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('dispatch — rejections are inert', () => {
  it('does not broadcast, log, or bump stateVersion when the reducer refuses', () => {
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);
    const versionBefore = s.stateVersion;
    h.emit.clear();

    // SEAT_B rolling out of turn.
    const res = dispatch(h.ctx, room, { type: 'ROLL_DICE', actorId: SEAT_B });

    expect(res.ok).toBe(false);
    expect(s.stateVersion).toBe(versionBefore);
    expect(h.emit.of('state_update')).toHaveLength(0);
    expect(h.emit.of('dice_rolled')).toHaveLength(0);
  });

  it('sends nothing at all to the client — WIRE.md has no `rejected` event', () => {
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);
    h.emit.clear();

    dispatch(h.ctx, room, { type: 'PAY_RENT', actorId: SEAT_B });
    expect(h.emit.sent.map((x) => x.event)).not.toContain('rejected');
  });
});

describe('dispatch — accepted actions broadcast a per-viewer projection', () => {
  it('sends one state_update per connected seat, each addressed to that seat', () => {
    const h = harness();
    const s = makeState({ config: { moneyVisible: false } });
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);
    h.emit.clear();

    dispatch(h.ctx, room, { type: 'ROLL_DICE', actorId: SEAT_A });

    const updates = h.emit.sent.filter((x) => x.event === 'state_update');
    expect(updates).toHaveLength(s.players.length);
    // Each recipient sees its own money and not its neighbour's.
    for (const u of updates) {
      const payload = u.payload as { gameState: { youAre: string; players: { id: string; money: number | null }[] } };
      const me = payload.gameState.players.find((q) => q.id === payload.gameState.youAre);
      const other = payload.gameState.players.find((q) => q.id !== payload.gameState.youAre);
      expect(me?.money).toBeTypeOf('number');
      expect(other?.money).toBeNull();
    }
  });

  it('emits dice_rolled with the legacy field names', () => {
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);
    h.emit.clear();

    dispatch(h.ctx, room, { type: 'ROLL_DICE', actorId: SEAT_A });

    const rolled = h.emit.of('dice_rolled')[0] as Record<string, unknown>;
    expect(Object.keys(rolled).sort()).toEqual(
      ['die1', 'die2', 'isDouble', 'newPos', 'oldPos', 'passedGo', 'path', 'playerId', 'steps', 'total'].sort(),
    );
    expect(rolled['playerId']).toBe(SEAT_A);
  });
});

describe('dispatch — the turn banner comes from TURN_STARTED only (B26)', () => {
  it('does not re-log "X\'s turn" on a broadcast that changes nothing', () => {
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);
    h.emit.clear();

    broadcastState(h.ctx, room);
    broadcastState(h.ctx, room);
    broadcastState(h.ctx, room);

    const turnLogs = h.emit
      .of('action_log')
      .filter((m) => String((m as { message: string }).message).includes("'s turn"));
    expect(turnLogs).toHaveLength(0);
  });
});

describe('dispatch — one interval per room (B01)', () => {
  it('re-arming the clock never leaves two live intervals', () => {
    vi.useFakeTimers();
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);

    // Roll, then confirm: two turn-key changes, two re-arms.
    dispatch(h.ctx, room, { type: 'ROLL_DICE', actorId: SEAT_A });
    dispatch(h.ctx, room, { type: 'CONFIRM_LANDING', actorId: SEAT_A });
    h.emit.clear();

    vi.advanceTimersByTime(1000);
    const ticks = h.emit.of('timer_sync');
    // Exactly one tick for one second. Two intervals would produce two.
    expect(ticks).toHaveLength(1);
    stopTurnTimer(room);
  });

  it('a refused action does not restart the clock', () => {
    vi.useFakeTimers();
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    const room = seatRoom(h, s);
    dispatch(h.ctx, room, { type: 'ROLL_DICE', actorId: SEAT_A });

    vi.advanceTimersByTime(3000);
    h.emit.clear();
    dispatch(h.ctx, room, { type: 'ROLL_DICE', actorId: SEAT_B }); // refused
    vi.advanceTimersByTime(1000);

    const seconds = (h.emit.of('timer_sync')[0] as { seconds: number } | undefined)?.seconds;
    // The countdown kept going rather than resetting to the full duration.
    expect(seconds).toBeLessThan(s.config.turnTimeoutSeconds);
    stopTurnTimer(room);
  });
});

describe('dispatch — TIMEOUT is the same path as a human action (B22)', () => {
  it('settles rent identically whether clicked or timed out', () => {
    const build = () => {
      const h = harness();
      const s = makeState({ cash: 2000 });
      setTurn(s, SEAT_A);
      give(s, SEAT_B, 2);
      setMoney(s, SEAT_A, 2000);
      setMoney(s, SEAT_B, 2000);
      s.phase = 'rent_payment';
      s.pending = { kind: 'rent', playerId: SEAT_A, ownerId: SEAT_B, amount: 190, squareId: 2 };
      const room = seatRoom(h, s);
      return { h, s, room };
    };

    const human = build();
    dispatch(human.h.ctx, human.room, { type: 'PAY_RENT', actorId: SEAT_A });
    stopTurnTimer(human.room);

    const timed = build();
    dispatch(timed.h.ctx, timed.room, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    stopTurnTimer(timed.room);

    expect(p(human.s, SEAT_A).money).toBe(p(timed.s, SEAT_A).money);
    expect(p(human.s, SEAT_B).money).toBe(p(timed.s, SEAT_B).money);
    expect(human.s.phase).toBe(timed.s.phase);
  });

  it('a client cannot forge a system action', () => {
    const h = harness();
    const s = makeState();
    const room = seatRoom(h, s);
    h.emit.clear();
    // SEAT_A trying to speak as the server.
    const res = dispatch(h.ctx, room, {
      type: 'PLAYER_DISCONNECTED',
      actorId: SEAT_A,
    } as never);
    expect(res.ok).toBe(false);
  });
});

describe('dispatch — private cards go to one socket (WIRE.md rule 3)', () => {
  it('sends private_card to the drawer and other_drawing to the rest', () => {
    const h = harness();
    const s = makeState();
    setTurn(s, SEAT_A);
    s.phase = 'draw_card';
    s.pending = { kind: 'deck_draw', playerId: SEAT_A, queue: ['hazak'], squareName: 'حظك' };
    const room = seatRoom(h, s);
    h.emit.clear();

    dispatch(h.ctx, room, { type: 'DRAW_CARD', actorId: SEAT_A, deck: 'hazak' });

    expect(h.emit.toOnly(sock(SEAT_A), 'private_card')).toHaveLength(1);
    expect(h.emit.toOnly(sock(SEAT_B), 'private_card')).toHaveLength(0);

    const others = h.emit.sent.filter((x) => x.event === 'other_drawing');
    expect(others).toHaveLength(1);
    expect(others[0]?.except).toBe(sock(SEAT_A));
    stopTurnTimer(room);
  });
});
