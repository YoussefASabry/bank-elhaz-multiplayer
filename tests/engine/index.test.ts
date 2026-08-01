/**
 * engine/index.ts — the keystone reducer: `createGame`, `applyAction`, the
 * (phase, action.type) authorization table, and the timeout autoPass synthesis.
 *
 * These are the tests the whole refactor was steered toward: authorization is
 * the load-bearing guarantee, so the auth matrix is exercised directly (wrong
 * phase, wrong actor, system-actor forgery, host-only kick) and the happy path
 * walks every phase machine end-to-end through the public API only.
 *
 * Seed discipline: `act` hands each action a FRESH `Rng`, so a roll is fully
 * predictable via `rollTotal(seed)` — `aim`/`landOn` place a player so their
 * next roll lands exactly on the target square without crossing the origin
 * (no pass-go salary, which would muddy the money assertions).
 */

import { describe, it, expect } from 'vitest';
import { createGame, applyAction } from '../../src/engine/index.js';
import { createRng } from '../../src/engine/rng.js';
import { rollDice } from '../../src/engine/dice.js';
import { step } from '../../src/engine/board.js';
import { draw } from '../../src/engine/deck.js';
import { currentPlayer, ownerOf, upgradeOf } from '../../src/engine/state.js';
import { SYSTEM_ACTOR } from '../../src/shared/actions.js';
import type { Action, RejectReason } from '../../src/shared/actions.js';
import type { GameState, Pending, SeatId, SquareId } from '../../src/shared/types.js';
import type { Basket } from '../../src/shared/trading.js';
import {
  makeState,
  makeRng,
  SEAT_A,
  SEAT_B,
  SEAT_C,
  SQ,
  board,
  p,
  give,
  giveColorGroup,
  giveJailCards,
  setMoney,
  setPosition,
  setTurn,
  jail,
  stackCard,
  totalMoney,
} from '../helpers/fixtures.js';

const NOW = 1_000_000;

function act(state: GameState, action: Action, seed = 1) {
  return applyAction(state, action, { rng: makeRng(seed), now: NOW });
}

function rollTotal(seed = 1): number {
  return rollDice(createRng(seed), 2).total;
}

/** Assert a rejection, that it left the state untouched, and return the reason. */
function expectRejected(state: GameState, action: Action): RejectReason {
  const result = applyAction(state, action, { rng: makeRng(1), now: NOW });
  expect(result.state).toBe(state);
  const rejected = result.events.find((e) => e.type === 'REJECTED');
  expect(rejected).toBeDefined();
  return rejected!.reason;
}

/** Place the actor so that rolling with `seed` lands exactly on `target`. */
function aim(state: GameState, seatId: SeatId, target: SquareId, seed = 1): void {
  setPosition(state, seatId, step(board, target, -rollTotal(seed)));
}

/** Roll + confirm, landing the actor on `target`. */
function landOn(state: GameState, seatId: SeatId, target: SquareId, seed = 1): void {
  aim(state, seatId, target, seed);
  const result = act(state, { type: 'ROLL_DICE', actorId: seatId }, seed);
  expect(result.events.some((e) => e.type === 'DICE_ROLLED')).toBe(true);
  expect(p(state, seatId).position).toBe(target);
  act(state, { type: 'CONFIRM_LANDING', actorId: seatId }, seed);
}

function jailCards(state: GameState): number {
  return state.players.reduce((sum, pl) => sum + pl.inventory.jailFreeCards, 0);
}

const basket = (overrides: Partial<Basket> = {}): Basket => ({
  cash: 0,
  squareIds: [],
  jailCards: 0,
  ...overrides,
});

// ── createGame ──

describe('createGame', () => {
  it('hosts the first seat and starts on a clean turn', () => {
    const state = createGame(
      [
        { id: SEAT_A, name: 'A' },
        { id: SEAT_B, name: 'B' },
        { id: SEAT_C, name: 'C' },
      ],
      makeRng(7),
      {},
      board,
    );
    expect(state.hostId).toBe(SEAT_A);
    expect(state.phase).toBe('roll');
    expect(state.pending).toEqual({ kind: 'none' });
    expect(state.players.map((pl) => pl.id)).toEqual([SEAT_A, SEAT_B, SEAT_C]);
    expect(state.stateVersion).toBe(0);
  });

  it('is deterministic: the same seed yields the same starting deck', () => {
    const seats = [
      { id: SEAT_A, name: 'A' },
      { id: SEAT_B, name: 'B' },
    ];
    const a = createGame(seats, makeRng(42), {}, board);
    const b = createGame(seats, makeRng(42), {}, board);
    const ids = (s: GameState) => s.decks.hazak.draw.map((c) => c.id);
    expect(ids(a)).toEqual(ids(b));
  });
});

// ── Happy path: the turn phase machine ──

describe('turn flow through applyAction', () => {
  it('rolls, confirms, and buys an unowned property', () => {
    const state = makeState({ cash: 2000 });
    landOn(state, SEAT_A, SQ.gasStation);

    expect(state.pending.kind).toBe('property_buy');
    expect(state.phase).toBe('property_choice');

    const result = act(state, { type: 'RESOLVE_PROPERTY_BUY', actorId: SEAT_A, buy: true });
    expect(result.events.some((e) => e.type === 'PROPERTY_BOUGHT')).toBe(true);
    expect(ownerOf(state, SQ.gasStation)).toBe(SEAT_A);
    expect(p(state, SEAT_A).money).toBe(2000 - 300);
    expect(currentPlayer(state)?.id).toBe(SEAT_B);
    expect(state.phase).toBe('roll');
  });

  it('a visitor pays rent to the active owner', () => {
    const state = makeState({ cash: 2000 });
    give(state, SEAT_A, SQ.gaza);
    setTurn(state, SEAT_B);
    landOn(state, SEAT_B, SQ.gaza);

    expect(state.pending.kind).toBe('rent');
    const pending = state.pending as Extract<Pending, { kind: 'rent' }>;
    const payerBefore = p(state, SEAT_B).money;
    const ownerBefore = p(state, SEAT_A).money;

    const result = act(state, { type: 'PAY_RENT', actorId: SEAT_B });
    expect(result.events.some((e) => e.type === 'RENT_PAID')).toBe(true);
    expect(p(state, SEAT_B).money).toBe(payerBefore - pending.amount);
    expect(p(state, SEAT_A).money).toBe(ownerBefore + pending.amount);
    expect(state.phase).toBe('roll');
  });

  it('landing on your own property offers upgrades in tier order', () => {
    const state = makeState({ cash: 2000 });
    giveColorGroup(state, SEAT_A, 'purple');
    landOn(state, SEAT_A, SQ.gaza);

    expect(state.pending.kind).toBe('upgrade');
    const pending = state.pending as Extract<Pending, { kind: 'upgrade' }>;
    expect(pending.options.length).toBeGreaterThan(0);
    const { tier, cost } = pending.options[0]!;
    const before = p(state, SEAT_A).money;

    const result = act(state, {
      type: 'BUY_UPGRADE',
      actorId: SEAT_A,
      squareId: SQ.gaza,
      tier,
    });
    expect(result.events.some((e) => e.type === 'UPGRADE_BUILT')).toBe(true);
    expect(upgradeOf(state, SQ.gaza)).toBe(tier);
    expect(p(state, SEAT_A).money).toBe(before - cost);
  });

  it('joining the club charges the membership fee once', () => {
    const state = makeState({ cash: 2000 });
    landOn(state, SEAT_A, SQ.club);

    expect(state.pending.kind).toBe('club');
    const pending = state.pending as Extract<Pending, { kind: 'club' }>;
    const before = p(state, SEAT_A).money;

    const result = act(state, { type: 'CHOOSE_CLUB', actorId: SEAT_A, choice: 'membership' });
    expect(result.events.some((e) => e.type === 'CLUB_RESOLVED' && e.choice === 'membership')).toBe(true);
    expect(p(state, SEAT_A).isClubMember).toBe(true);
    expect(p(state, SEAT_A).money).toBe(before - pending.membershipCost);
    expect(state.phase).toBe('roll');
  });

  it('landing on prison jails the player', () => {
    const state = makeState({ cash: 2000 });
    landOn(state, SEAT_A, SQ.prison, 7);
    expect(p(state, SEAT_A).statusEffects.missedTurnsRemaining).toBeGreaterThan(0);
    expect(p(state, SEAT_A).position).toBe(SQ.prison);
  });
});

// ── Cards (square 4 draws both decks — B10) ──

describe('card draws through applyAction', () => {
  it('square 4 draws mahkama then hazak, choices included', () => {
    const state = makeState({ cash: 2000 });
    stackCard(state, 'mahkama', 1); // no choices: collect 25 from each player
    stackCard(state, 'hazak', 15); // choices: receive 150 or claim a free city
    landOn(state, SEAT_A, SQ.dualDeck, 12);

    expect(state.pending.kind).toBe('deck_draw');
    const first = state.pending as Extract<Pending, { kind: 'deck_draw' }>;
    expect(first.queue).toEqual(['mahkama', 'hazak']);

    // First draw + resolve: no choices → the queue re-installs for hazak.
    act(state, { type: 'DRAW_CARD', actorId: SEAT_A, deck: 'mahkama' });
    expect(state.pending.kind).toBe('blind_card');
    let drawn = state.pending as Extract<Pending, { kind: 'blind_card' }>;
    expect(drawn.card.id).toBe(1);
    expect(drawn.remainingDraws).toEqual(['hazak']);

    act(state, { type: 'CONFIRM_CARD', actorId: SEAT_A });
    expect(state.pending.kind).toBe('deck_draw');
    const second = state.pending as Extract<Pending, { kind: 'deck_draw' }>;
    expect(second.queue).toEqual(['hazak']);

    // Second draw: card 15 presents a choice.
    act(state, { type: 'DRAW_CARD', actorId: SEAT_A, deck: 'hazak' });
    expect(state.pending.kind).toBe('blind_card');
    drawn = state.pending as Extract<Pending, { kind: 'blind_card' }>;
    expect(drawn.card.id).toBe(15);

    act(state, { type: 'CONFIRM_CARD', actorId: SEAT_A });
    expect(state.pending.kind).toBe('card_choice');

    // Flat option 0 = receive_cash(150).
    const choice = act(state, { type: 'CHOOSE_CARD_OPTION', actorId: SEAT_A, index: 0 });
    expect(choice.events.some((e) => e.type === 'CARD_RESOLVED')).toBe(true);
    expect(state.pending.kind).toBe('none');
    expect(state.phase).toBe('roll');
    expect(p(state, SEAT_A).money).toBe(2000 + 50 + 150); // 25×2 players + card cash
  });

  it('drawing from the wrong pile is rejected (deck_mismatch)', () => {
    const state = makeState({ cash: 2000 });
    landOn(state, SEAT_A, SQ.hazakTrigger, 12);
    expect(state.pending.kind).toBe('deck_draw');
    expectRejected(state, { type: 'DRAW_CARD', actorId: SEAT_A, deck: 'mahkama' });
    expect(state.pending.kind).toBe('deck_draw'); // untouched
  });
});

// ── Prison ──

describe('prison actions through applyAction', () => {
  it('a jailed player cannot roll (B05)', () => {
    const state = makeState({ cash: 2000 });
    jail(state, SEAT_A, 2);
    expectRejected(state, { type: 'ROLL_DICE', actorId: SEAT_A }); // in_prison
  });

  it('serving a turn decrements and hands over (B05)', () => {
    const state = makeState({ cash: 2000 });
    jail(state, SEAT_A, 2);
    const result = act(state, { type: 'SKIP_PRISON_TURN', actorId: SEAT_A });
    expect(result.events.some((e) => e.type === 'PRISON_TURN_SKIPPED')).toBe(true);
    expect(p(state, SEAT_A).statusEffects.missedTurnsRemaining).toBe(1);
    expect(currentPlayer(state)?.id).toBe(SEAT_B);
  });

  it('paying bail releases immediately (B03)', () => {
    const state = makeState({ cash: 2000 });
    jail(state, SEAT_A, 2);
    const result = act(state, { type: 'PAY_BAIL', actorId: SEAT_A });
    expect(result.events.some((e) => e.type === 'RELEASED_FROM_JAIL' && e.via === 'bail')).toBe(true);
    expect(p(state, SEAT_A).statusEffects.missedTurnsRemaining).toBe(0);
    expect(currentPlayer(state)?.id).toBe(SEAT_A);
  });

  it('a jail-free card releases immediately (B03)', () => {
    const state = makeState({ cash: 2000 });
    giveJailCards(state, SEAT_A, 1);
    jail(state, SEAT_A, 2);
    const result = act(state, { type: 'USE_JAIL_FREE', actorId: SEAT_A });
    expect(result.events.some((e) => e.type === 'RELEASED_FROM_JAIL' && e.via === 'jail_free_card')).toBe(true);
    expect(p(state, SEAT_A).inventory.jailFreeCards).toBe(0);
  });
});

// ── Insolvency ──

describe('DECLARE_BANKRUPT through applyAction', () => {
  it('works only from a rent pending and settles with the single model (B21)', () => {
    const state = makeState({ cash: 2000 });
    give(state, SEAT_A, SQ.gaza);
    setMoney(state, SEAT_B, 10);
    setTurn(state, SEAT_B);
    landOn(state, SEAT_B, SQ.gaza);
    expect(state.pending.kind).toBe('rent');

    // Not reachable from a non-rent phase.
    setTurn(state, SEAT_A);
    expectRejected(state, { type: 'DECLARE_BANKRUPT', actorId: SEAT_A });
    setTurn(state, SEAT_B);

    const result = act(state, { type: 'DECLARE_BANKRUPT', actorId: SEAT_B });
    expect(result.events.some((e) => e.type === 'BANKRUPT' && e.rule === 'eliminate')).toBe(true);
    expect(p(state, SEAT_B).isBankrupt).toBe(true);
    expect(ownerOf(state, SQ.gaza)).toBe(SEAT_A); // the debt is never paid
    expect(currentPlayer(state)?.id).toBe(SEAT_C); // turn skips the bankrupt seat
  });
});

// ── Trades and bids ──

describe('trades and bids through applyAction', () => {
  it('a settled trade conserves money and jail cards and moves ownership atomically', () => {
    const state = makeState({ cash: 2000 });
    give(state, SEAT_A, SQ.jerusalem);
    giveJailCards(state, SEAT_A, 1);
    const moneyBefore = totalMoney(state);
    const cardsBefore = jailCards(state);

    act(state, { type: 'TRADE_OPEN', actorId: SEAT_A, partnerId: SEAT_B, now: NOW });
    act(state, { type: 'TRADE_PROPOSE', actorId: SEAT_A, basket: basket({ squareIds: [SQ.jerusalem], jailCards: 1 }) });
    act(state, { type: 'TRADE_ACCEPT', actorId: SEAT_B });
    act(state, { type: 'TRADE_PROPOSE', actorId: SEAT_B, basket: basket({ cash: 500 }) });

    const settled = act(state, { type: 'TRADE_ACCEPT', actorId: SEAT_A });
    expect(settled.events.some((e) => e.type === 'TRADE_SETTLED')).toBe(true);
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_B);
    expect(p(state, SEAT_A).inventory.jailFreeCards).toBe(0);
    expect(p(state, SEAT_B).inventory.jailFreeCards).toBe(1);
    expect(totalMoney(state)).toBe(moneyBefore);
    expect(jailCards(state)).toBe(cardsBefore);
    expect(state.trades).toHaveLength(0);
  });

  it('a settled bid conserves money and moves the offered property', () => {
    const state = makeState({ cash: 2000 });
    give(state, SEAT_B, SQ.gaza);
    const moneyBefore = totalMoney(state);

    act(state, { type: 'BID_CREATE', actorId: SEAT_A, basket: basket({ cash: 400 }), now: NOW });
    const bidId = state.bids[0]!.id;
    act(state, { type: 'BID_OFFER', actorId: SEAT_B, bidId, basket: basket({ squareIds: [SQ.gaza] }) });
    const offerId = state.bids[0]!.offers[0]!.id;

    const settled = act(state, { type: 'BID_ACCEPT_OFFER', actorId: SEAT_A, bidId, offerId });
    expect(settled.events.some((e) => e.type === 'BID_SETTLED')).toBe(true);
    expect(ownerOf(state, SQ.gaza)).toBe(SEAT_A);
    expect(totalMoney(state)).toBe(moneyBefore);
    expect(state.bids).toHaveLength(0);
  });

  it('only the bid owner may accept an offer', () => {
    const state = makeState({ cash: 2000 });
    act(state, { type: 'BID_CREATE', actorId: SEAT_A, basket: basket({ cash: 100 }), now: NOW });
    const bidId = state.bids[0]!.id;
    expectRejected(state, { type: 'BID_ACCEPT_OFFER', actorId: SEAT_B, bidId, offerId: 'x' }); // not_the_owner
    expectRejected(state, { type: 'BID_OFFER', actorId: SEAT_A, bidId, basket: basket({ cash: 10 }) }); // cannot_bid_on_own
  });
});

// ── Host authority ──

describe('host authority and removal', () => {
  it('only the host may kick, and the kicked seat can never act again', () => {
    const state = makeState({ cash: 2000 });
    expect(state.hostId).toBe(SEAT_A);

    expectRejected(state, { type: 'KICK_PLAYER', actorId: SEAT_B, targetId: SEAT_C }); // not_host
    const result = act(state, { type: 'KICK_PLAYER', actorId: SEAT_A, targetId: SEAT_C });
    expect(result.events.some((e) => e.type === 'PLAYER_KICKED' && e.playerId === SEAT_C)).toBe(true);
    expect(p(state, SEAT_C).eliminated).toBe(true);

    // The ejected seat refuses every further action.
    expectRejected(state, { type: 'ROLL_DICE', actorId: SEAT_C });
    expectRejected(state, { type: 'TRADE_OPEN', actorId: SEAT_C, partnerId: SEAT_B, now: NOW });
  });

  it('a disconnect sweeps open trades and reconnects restore the flag (B14)', () => {
    const state = makeState({ cash: 2000 });
    act(state, { type: 'TRADE_OPEN', actorId: SEAT_A, partnerId: SEAT_B, now: NOW });
    expect(state.trades).toHaveLength(1);

    const result = act(state, { type: 'PLAYER_DISCONNECTED', actorId: SYSTEM_ACTOR, playerId: SEAT_A });
    expect(result.events.some((e) => e.type === 'TRADE_CANCELLED')).toBe(true);
    expect(state.trades).toHaveLength(0);
    expect(p(state, SEAT_A).connected).toBe(false);

    act(state, { type: 'PLAYER_RECONNECTED', actorId: SYSTEM_ACTOR, playerId: SEAT_A });
    expect(p(state, SEAT_A).connected).toBe(true);
  });
});

// ── Authorization matrix ──

describe('authorization', () => {
  it('rejects wrong-actor and wrong-phase actions without mutating state', () => {
    const state = makeState({ cash: 2000 });
    expectRejected(state, { type: 'ROLL_DICE', actorId: SEAT_B }); // not_your_turn
    expectRejected(state, { type: 'CONFIRM_LANDING', actorId: SEAT_A }); // wrong_phase
    expectRejected(state, { type: 'RESOLVE_PROPERTY_BUY', actorId: SEAT_A, buy: true }); // wrong_phase
    expectRejected(state, { type: 'PAY_RENT', actorId: SEAT_A }); // wrong_phase
    expectRejected(state, { type: 'BUY_UPGRADE', actorId: SEAT_A, squareId: SQ.gaza, tier: 'garage' }); // wrong_phase
    expectRejected(state, { type: 'SKIP_UPGRADE', actorId: SEAT_A }); // wrong_phase
    expectRejected(state, { type: 'CHOOSE_CLUB', actorId: SEAT_A, choice: 'membership' }); // wrong_phase
    expectRejected(state, { type: 'DRAW_CARD', actorId: SEAT_A, deck: 'hazak' }); // wrong_phase
    expectRejected(state, { type: 'CONFIRM_CARD', actorId: SEAT_A }); // wrong_phase
    expectRejected(state, { type: 'CHOOSE_CARD_OPTION', actorId: SEAT_A, index: 0 }); // wrong_phase
    expectRejected(state, { type: 'SELL_PROPERTY', actorId: SEAT_A, squareId: SQ.gaza }); // not_the_owner
    expectRejected(state, { type: 'SELL_UPGRADE', actorId: SEAT_A, squareId: SQ.gaza }); // not_the_owner
    expectRejected(state, { type: 'ROLL_DICE', actorId: 'ghost' }); // player_not_found
  });

  it('system actions from a client actor are rejected', () => {
    const state = makeState({ cash: 2000 });
    // The Action union forbids these at compile time; cast to prove the
    // runtime gate still rejects a forged system actor.
    const forge = <T extends object>(a: T) => a as unknown as Action;
    expectRejected(state, forge({ type: 'TIMEOUT', actorId: SEAT_A })); // system_action_from_client
    expectRejected(state, forge({ type: 'PLAYER_DISCONNECTED', actorId: SEAT_A, playerId: SEAT_B })); // system_action_from_client
    expectRejected(state, forge({ type: 'EXPIRE_TRADES', actorId: SEAT_A, now: NOW })); // system_action_from_client
  });

  it('a client action under the SYSTEM_ACTOR is rejected', () => {
    const state = makeState({ cash: 2000 });
    expectRejected(state, { type: 'ROLL_DICE', actorId: SYSTEM_ACTOR }); // system_action_from_client
  });

  it('trade timing can restrict trading to the current player', () => {
    const state = makeState({ config: { tradeTiming: 'own_turn' } });
    expectRejected(state, { type: 'TRADE_OPEN', actorId: SEAT_B, partnerId: SEAT_C, now: NOW }); // not_your_turn
    const result = act(state, { type: 'TRADE_OPEN', actorId: SEAT_A, partnerId: SEAT_B, now: NOW });
    expect(result.events.some((e) => e.type === 'TRADE_OPENED')).toBe(true);
  });

  it('a finished game rejects every client action', () => {
    const state = makeState({ cash: 2000 });
    state.gameOver = true;
    state.phase = 'game_over';
    expectRejected(state, { type: 'ROLL_DICE', actorId: SEAT_A }); // game_over
    expectRejected(state, { type: 'KICK_PLAYER', actorId: SEAT_A, targetId: SEAT_B }); // game_over
  });
});

// ── Timeout autoPass ──

describe('TIMEOUT autoPass', () => {
  it('synthesizes the exact human action, so a timeout never diverges (B22)', () => {
    const state = makeState({ cash: 2000 });
    give(state, SEAT_A, SQ.gaza);
    setTurn(state, SEAT_B);
    landOn(state, SEAT_B, SQ.gaza);

    const pending = state.pending as Extract<Pending, { kind: 'rent' }>;
    const before = p(state, SEAT_B).money;
    const result = act(state, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    expect(result.events.some((e) => e.type === 'RENT_PAID')).toBe(true);
    expect(p(state, SEAT_B).money).toBe(before - pending.amount);
  });

  it('every phase has an autoPass branch (B02): rolling confirms', () => {
    const state = makeState({ cash: 2000 });
    act(state, { type: 'ROLL_DICE', actorId: SEAT_A });
    expect(state.phase).toBe('rolling');

    const result = act(state, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    expect(result.events.some((e) => e.type === 'REJECTED')).toBe(false);
    expect(state.phase).not.toBe('rolling');
  });

  it('a jailed player serves a prison turn instead of rolling on timeout (B05)', () => {
    const state = makeState({ cash: 2000 });
    jail(state, SEAT_A, 2);
    const result = act(state, { type: 'TIMEOUT', actorId: SYSTEM_ACTOR });
    expect(result.events.some((e) => e.type === 'PRISON_TURN_SKIPPED')).toBe(true);
    expect(result.events.some((e) => e.type === 'DICE_ROLLED')).toBe(false);
  });
});

// ── Determinism ──

describe('determinism', () => {
  it('the same seed replays the same roll', () => {
    const a = makeState({ seed: 42 });
    const b = makeState({ seed: 42 });

    const firstRoll = (s: GameState) => {
      const holder = currentPlayer(s)!.id;
      const result = applyAction(s, { type: 'ROLL_DICE', actorId: holder }, { rng: makeRng(1), now: NOW });
      const ev = result.events.find((e) => e.type === 'DICE_ROLLED');
      return ev?.type === 'DICE_ROLLED' ? { die1: ev.die1, die2: ev.die2 } : null;
    };
    expect(firstRoll(a)).toEqual(firstRoll(b));
  });

  it('the same seed yields the same card draws', () => {
    const a = makeState({ seed: 42 });
    const b = makeState({ seed: 42 });

    const ids = (s: GameState) => {
      const rng = makeRng(1);
      return [0, 1, 2].map(() => draw(s.decks, 'hazak', rng)?.id ?? null);
    };
    expect(ids(a)).toEqual(ids(b));
  });
});
