/**
 * The reducer and its authorization table.
 *
 * Every other engine test exercises a sub-module directly. This file is the
 * only one that goes through `applyAction`, which is the sole legal way to
 * mutate a GameState — so it is where the authorization table, the system
 * boundary, and the regressions B03/B09/B13/B19/B21/B22 are pinned down.
 */
import { describe, expect, it } from 'vitest';
import { applyAction, createRng } from '../../src/engine/index.js';
import { SYSTEM_ACTOR } from '../../src/shared/actions.js';
import type { Action, RejectReason } from '../../src/shared/actions.js';
import type { GameState, Phase, SeatId } from '../../src/shared/types.js';
import type { ActionResult } from '../../src/shared/actions.js';
import { SEAT_A, SEAT_B, SEAT_C, giveJailCards, jail, makeState, p, setTurn } from '../helpers/fixtures.js';

const rng = () => createRng(42);

/** The reject reason, or null when the action was accepted. */
function rejection(res: ActionResult): RejectReason | null {
  for (const ev of res.events) {
    if (ev.type === 'REJECTED') return ev.reason;
  }
  return null;
}

function act(state: GameState, action: Action): ActionResult {
  return applyAction(state, action, rng());
}

/** Play legal turns until `phase` is reached. Throws rather than looping forever. */
function driveTo(state: GameState, phase: Phase, budget = 400): GameState {
  let s = state;
  for (let i = 0; i < budget; i++) {
    if (s.phase === phase) return s;
    const holder = s.players[s.currentPlayerIndex];
    if (holder === undefined) throw new Error('no current player');
    const next: Action =
      s.phase === 'roll'
        ? { type: 'ROLL_DICE', actorId: holder.id }
        : { type: 'CONFIRM_LANDING', actorId: holder.id };
    const res = applyAction(s, next, createRng(i + 1));
    if (rejection(res) !== null) throw new Error(`stuck in ${s.phase}: ${String(rejection(res))}`);
    s = res.state;
    if (s.gameOver) throw new Error('game ended before reaching ' + phase);
  }
  throw new Error(`never reached ${phase}`);
}

describe('the system boundary', () => {
  it('refuses a system action that arrives from a seat (B19)', () => {
    const s = makeState();
    const res = act(s, { type: 'TIMEOUT', actorId: SEAT_A } as unknown as Action);
    expect(rejection(res)).toBe('system_action_from_client');
  });

  it('refuses a seat action that claims to be the server', () => {
    const s = makeState();
    const res = act(s, { type: 'ROLL_DICE', actorId: SYSTEM_ACTOR });
    expect(rejection(res)).toBe('system_action_from_client');
  });

  it('ignores any state a client tries to smuggle in with the action (B19)', () => {
    const s = makeState();
    const holder = s.players[s.currentPlayerIndex]!;
    const forged = {
      type: 'ROLL_DICE',
      actorId: holder.id,
      state: { ...s, players: s.players.map((pl) => ({ ...pl, money: 999_999 })) },
      phase: 'game_over',
      gameOver: true,
      stateVersion: 9_999,
    } as unknown as Action;
    // applyAction mutates in place, so `s` is `res.state`. Capture the scalar first.
    const versionBefore = s.stateVersion;
    const res = act(s, forged);

    expect(rejection(res)).toBeNull();
    for (const pl of res.state.players) expect(pl.money).not.toBe(999_999);
    expect(res.state.gameOver).toBe(false);
    expect(res.state.stateVersion).toBe(versionBefore + 1);
  });
});

describe('the authorization table', () => {
  it('rejects an action from a player whose turn it is not', () => {
    const s = makeState();
    const other = s.players.find((pl) => pl.id !== s.players[s.currentPlayerIndex]!.id)!;
    expect(rejection(act(s, { type: 'ROLL_DICE', actorId: other.id }))).toBe('not_your_turn');
  });

  it('rejects an action taken in the wrong phase', () => {
    const s = makeState();
    const holder = s.players[s.currentPlayerIndex]!;
    const rolled = act(s, { type: 'ROLL_DICE', actorId: holder.id }).state;
    expect(rolled.phase).not.toBe('roll');
    expect(rejection(act(rolled, { type: 'ROLL_DICE', actorId: holder.id }))).toBe('wrong_phase');
  });

  it('accepts nothing at all once the game is over', () => {
    const s: GameState = { ...makeState(), gameOver: true };
    const holder = s.players[s.currentPlayerIndex]!;
    expect(rejection(act(s, { type: 'ROLL_DICE', actorId: holder.id }))).toBe('game_over');
    expect(rejection(act(s, { type: 'DECLARE_BANKRUPT', actorId: holder.id }))).toBe('game_over');
  });

  it('only lets the host kick', () => {
    const s = makeState();
    const nonHost = s.players[1]!;
    const res = act(s, { type: 'KICK_PLAYER', actorId: nonHost.id, targetId: s.players[2]!.id });
    expect(rejection(res)).toBe('not_host');
  });

  it('leaves the state untouched when it rejects', () => {
    const s = makeState();
    const before = JSON.stringify(s);
    const res = act(s, { type: 'ROLL_DICE', actorId: SYSTEM_ACTOR });
    expect(rejection(res)).not.toBeNull();
    expect(JSON.stringify(res.state)).toBe(before);
    expect(res.state.stateVersion).toBe(s.stateVersion);
  });

  it('bumps stateVersion when it accepts', () => {
    const s = makeState();
    const holder = s.players[s.currentPlayerIndex]!;
    const versionBefore = s.stateVersion;
    const res = act(s, { type: 'ROLL_DICE', actorId: holder.id });
    expect(rejection(res)).toBeNull();
    expect(res.state.stateVersion).toBe(versionBefore + 1);
  });
});

describe('B09 — the pending slot decides who may answer', () => {
  it('rejects the answer when it comes from a seat the prompt was not addressed to', () => {
    const s = driveTo(makeState(), 'property_choice');
    const owed = s.pending.kind === 'none' ? null : s.pending.playerId;
    expect(owed).not.toBeNull();
    const intruder = s.players.find((pl) => pl.id !== owed)!;
    const res = act(s, { type: 'RESOLVE_PROPERTY_BUY', actorId: intruder.id, buy: true });
    expect(rejection(res)).toBe('not_the_entitled_player');
  });

  it('accepts the answer from the seat the prompt was addressed to', () => {
    const s = driveTo(makeState(), 'property_choice');
    const owed = (s.pending.kind === 'none' ? null : s.pending.playerId) as SeatId;
    const res = act(s, { type: 'RESOLVE_PROPERTY_BUY', actorId: owed, buy: false });
    expect(rejection(res)).toBeNull();
  });
});

describe('B03 — USE_JAIL_FREE has a handler', () => {
  it('releases a jailed player holding a card and consumes it', () => {
    const s = makeState();
    setTurn(s, SEAT_A);
    jail(s, SEAT_A, 2);
    giveJailCards(s, SEAT_A, 1);
    const before = p(s, SEAT_A).inventory.jailFreeCards;

    const res = act(s, { type: 'USE_JAIL_FREE', actorId: SEAT_A });

    expect(rejection(res)).toBeNull();
    const after = p(res.state, SEAT_A);
    expect(after.inventory.jailFreeCards).toBe(before - 1);
    expect(after.statusEffects.missedTurnsRemaining).toBe(0);
  });

  it('rejects a player with no card rather than silently doing nothing', () => {
    const s = makeState();
    setTurn(s, SEAT_A);
    jail(s, SEAT_A, 2);
    giveJailCards(s, SEAT_A, 0);
    expect(rejection(act(s, { type: 'USE_JAIL_FREE', actorId: SEAT_A }))).not.toBeNull();
  });
});

describe('B13 — TRADE_CANCEL never writes phase', () => {
  it('leaves the phase exactly as it found it', () => {
    const s = makeState();
    for (const seat of [SEAT_A, SEAT_B, SEAT_C]) {
      const res = act(s, { type: 'TRADE_CANCEL', actorId: seat });
      expect(res.state.phase).toBe(s.phase);
    }
  });
});

describe('B22 — TIMEOUT goes through the same reducer', () => {
  it('is accepted from the server and moves the game on', () => {
    const s = makeState();
    const versionBefore = s.stateVersion;
    const res = act(s, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    expect(rejection(res)).toBeNull();
    expect(res.state.stateVersion).toBe(versionBefore + 1);
  });
});
