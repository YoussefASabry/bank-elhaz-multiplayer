import { describe, it, expect } from 'vitest';
import {
  makeState,
  makeDuel,
  SEAT_A,
  SEAT_B,
  SEAT_C,
  SQ,
  p,
  give,
  giveJailCards,
  setMoney,
  totalMoney,
} from '../helpers/fixtures.js';
import {
  openTrade,
  proposeTrade,
  acceptTrade,
  declineTrade,
  cancelTrade,
  expireTrades,
  findTradeFor,
} from '../../src/engine/trade.js';
import { ownerOf, setOwner } from '../../src/engine/state.js';
import { TRADE_RATE_LIMIT, TRADE_TIMEOUT_SECONDS } from '../../src/shared/rules.js';
import type { Basket } from '../../src/shared/trading.js';
import type { GameState } from '../../src/shared/types.js';

const NOW = 1_000_000;

function basket(overrides: Partial<Basket> = {}): Basket {
  return { cash: 0, squareIds: [], jailCards: 0, ...overrides };
}

/** Total jail-free cards held across all players — conservation helper. */
function totalJailCards(state: GameState): number {
  return state.players.reduce((sum, pl) => sum + pl.inventory.jailFreeCards, 0);
}

/** Owner of every ownable square, as a stable-order snapshot for set comparison. */
function ownerSnapshot(state: GameState): Array<string | null> {
  return Object.keys(state.ownership)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => ownerOf(state, id));
}

describe('openTrade', () => {
  it('opens a fresh trade in stage proposing_a', () => {
    const state = makeDuel();
    const result = openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('proposing_a');
    expect(result.value.a).toBe(SEAT_A);
    expect(result.value.b).toBe(SEAT_B);
    expect(result.value.expiresAt).toBe(NOW + TRADE_TIMEOUT_SECONDS * 1000);
    expect(state.trades).toHaveLength(1);
    expect(result.events).toEqual([{ type: 'TRADE_OPENED', tradeId: result.value.id, a: SEAT_A, b: SEAT_B }]);
  });

  it('rejects an unknown seat', () => {
    const state = makeDuel();
    expect(openTrade(state, SEAT_A, 'seat-ghost', NOW)).toEqual({ ok: false, reason: 'player_not_found' });
  });

  it('rejects trading with yourself', () => {
    const state = makeDuel();
    expect(openTrade(state, SEAT_A, SEAT_A, NOW).ok).toBe(false);
  });

  it('rejects when either seat is inactive (B: bankrupt/eliminated cannot trade)', () => {
    const state = makeDuel();
    p(state, SEAT_B).isBankrupt = true;
    expect(openTrade(state, SEAT_A, SEAT_B, NOW)).toEqual({ ok: false, reason: 'player_inactive' });
  });

  it('rejects when the initiator is already in a trade', () => {
    const state = makeState();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(openTrade(state, SEAT_A, SEAT_C, NOW)).toEqual({ ok: false, reason: 'already_in_trade' });
  });

  it('rejects when the partner is already in a trade', () => {
    const state = makeState();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(openTrade(state, SEAT_C, SEAT_B, NOW)).toEqual({ ok: false, reason: 'already_in_trade' });
  });

  it('B16: rate-limits opens per stable SeatId, and the limit persists across a simulated reconnect', () => {
    const state = makeState();
    // Open and immediately cancel so "already_in_trade" never masks the rate limit.
    for (let i = 0; i < TRADE_RATE_LIMIT; i++) {
      const t = openTrade(state, SEAT_A, SEAT_B, NOW + i * 1000);
      expect(t.ok).toBe(true);
      if (t.ok) cancelTrade(state, SEAT_A, 'test-cycle');
    }
    // One more within the window is rejected.
    const over = openTrade(state, SEAT_A, SEAT_B, NOW + TRADE_RATE_LIMIT * 1000);
    expect(over).toEqual({ ok: false, reason: 'trade_rate_limited' });

    // Nothing resets the counter merely by continuing to use the SAME state object
    // (standing in for a reconnect with the same SeatId, since there are no socket
    // ids anywhere in GameState) — it is still rejected a bit later, still inside
    // the 60s window of the earliest counted open.
    const stillOver = openTrade(state, SEAT_A, SEAT_B, NOW + 5_000);
    expect(stillOver).toEqual({ ok: false, reason: 'trade_rate_limited' });

    // Once the window has slid past the earliest opens, capacity frees up again.
    const afterWindow = openTrade(state, SEAT_A, SEAT_B, NOW + 61_000);
    expect(afterWindow.ok).toBe(true);
  });
});

describe('proposeTrade', () => {
  it('rejects when there is no active trade', () => {
    const state = makeDuel();
    expect(proposeTrade(state, SEAT_A, basket())).toEqual({ ok: false, reason: 'no_active_trade' });
  });

  it('rejects b proposing while it is a\'s turn to propose', () => {
    const state = makeDuel();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(proposeTrade(state, SEAT_B, basket())).toEqual({ ok: false, reason: 'trade_wrong_stage' });
  });

  it('advances proposing_a -> reviewing_b', () => {
    const state = makeDuel();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    const result = proposeTrade(state, SEAT_A, basket({ cash: 50 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('reviewing_b');
    expect(result.value.proposalA).toEqual(basket({ cash: 50 }));
  });

  it('B: rejects a basket offering cash the seat does not have', () => {
    const state = makeDuel({ cash: 100 });
    openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(proposeTrade(state, SEAT_A, basket({ cash: 500 }))).toEqual({
      ok: false,
      reason: 'basket_not_affordable',
    });
  });

  it('B: rejects a basket offering a square the seat does not own', () => {
    const state = makeDuel();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(proposeTrade(state, SEAT_A, basket({ squareIds: [SQ.jerusalem] }))).toEqual({
      ok: false,
      reason: 'basket_items_not_owned',
    });
  });

  it('B15: rejects a basket offering more jail cards than the seat holds', () => {
    const state = makeDuel();
    giveJailCards(state, SEAT_A, 1);
    openTrade(state, SEAT_A, SEAT_B, NOW);
    const before = { money: totalMoney(state), jail: totalJailCards(state) };
    const result = proposeTrade(state, SEAT_A, basket({ jailCards: 2 }));
    expect(result).toEqual({ ok: false, reason: 'insufficient_jail_cards' });
    // Nothing was mutated by the rejected proposal.
    expect({ money: totalMoney(state), jail: totalJailCards(state) }).toEqual(before);
  });

  it('B12: rejects offering a square that carries an upgrade', () => {
    const state = makeDuel();
    give(state, SEAT_A, SQ.jerusalem, 'garage');
    openTrade(state, SEAT_A, SEAT_B, NOW);
    const result = proposeTrade(state, SEAT_A, basket({ squareIds: [SQ.jerusalem] }));
    expect(result).toEqual({ ok: false, reason: 'property_has_upgrade' });
    // The trade is untouched — still waiting on a's proposal.
    const trade = findTradeFor(state, SEAT_A);
    expect(trade?.stage).toBe('proposing_a');
    expect(trade?.proposalA).toBeNull();
  });
});

describe('full lifecycle: propose / accept / decline / settle', () => {
  function setUp() {
    const state = makeDuel();
    give(state, SEAT_A, SQ.jerusalem);
    give(state, SEAT_B, SQ.gaza);
    giveJailCards(state, SEAT_A, 2);
    giveJailCards(state, SEAT_B, 1);
    openTrade(state, SEAT_A, SEAT_B, NOW);
    return state;
  }

  it('accept at reviewing_b advances to proposing_b (does not settle)', () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket({ cash: 100 }));
    const result = acceptTrade(state, SEAT_B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('proposing_b');
    expect(result.value.acceptedB).toBe(true);
    // Not settled: nothing moved yet.
    expect(p(state, SEAT_A).money).toBe(p(state, SEAT_B).money);
  });

  it('decline at reviewing_b bounces back to proposing_a without tearing the trade down', () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket({ cash: 100 }));
    const result = declineTrade(state, SEAT_B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('proposing_a');
    expect(result.value.proposalA).toBeNull();
    // The trade still exists — a can propose again, it was not cancelled (B14 sibling concern).
    expect(findTradeFor(state, SEAT_A)).toBeDefined();
    expect(findTradeFor(state, SEAT_B)).toBeDefined();
  });

  it('decline at reviewing_a bounces back to proposing_b', () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket({ cash: 100 }));
    acceptTrade(state, SEAT_B);
    proposeTrade(state, SEAT_B, basket({ squareIds: [SQ.gaza] }));
    const result = declineTrade(state, SEAT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('proposing_b');
    expect(result.value.proposalB).toBeNull();
    expect(findTradeFor(state, SEAT_A)).toBeDefined();
  });

  it('rejects accept from the wrong seat at each review stage', () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket({ cash: 100 }));
    // It's b's turn to review; a cannot accept its own proposal.
    expect(acceptTrade(state, SEAT_A)).toEqual({ ok: false, reason: 'trade_wrong_stage' });
  });

  it('settles on accept at reviewing_a, moving both baskets and conserving totals', () => {
    const state = setUp();
    const moneyBefore = totalMoney(state);
    const jailBefore = totalJailCards(state);
    const ownersBefore = ownerSnapshot(state);

    proposeTrade(state, SEAT_A, basket({ cash: 100, squareIds: [SQ.jerusalem], jailCards: 1 }));
    acceptTrade(state, SEAT_B);
    proposeTrade(state, SEAT_B, basket({ squareIds: [SQ.gaza], jailCards: 1 }));
    const result = acceptTrade(state, SEAT_A);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('settled');
    expect(result.events).toEqual([
      { type: 'TRADE_SETTLED', tradeId: result.value.id, a: SEAT_A, b: SEAT_B },
    ]);

    // Squares swapped.
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_B);
    expect(ownerOf(state, SQ.gaza)).toBe(SEAT_A);
    // Cash and jail cards moved as offered.
    expect(p(state, SEAT_A).money).toBe(2000 - 100);
    expect(p(state, SEAT_B).money).toBe(2000 + 100);
    expect(p(state, SEAT_A).inventory.jailFreeCards).toBe(2 - 1 + 1);
    expect(p(state, SEAT_B).inventory.jailFreeCards).toBe(1 - 1 + 1);

    // Conservation: totals unchanged, only redistributed.
    expect(totalMoney(state)).toBe(moneyBefore);
    expect(totalJailCards(state)).toBe(jailBefore);
    expect(ownerSnapshot(state).sort()).toEqual(ownersBefore.sort());

    // Both seats are free to trade again — settlement tears the trade down (B14 sibling).
    expect(findTradeFor(state, SEAT_A)).toBeUndefined();
    expect(findTradeFor(state, SEAT_B)).toBeUndefined();
    expect(state.trades).toHaveLength(0);
  });

  it('B15: re-validates both baskets at settlement time and rejects without mutating anything if one has gone stale', () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket({ cash: 100, squareIds: [SQ.jerusalem] }));
    acceptTrade(state, SEAT_B);
    proposeTrade(state, SEAT_B, basket({ squareIds: [SQ.gaza] }));

    // Simulate SEAT_A losing jerusalem (e.g. sold it) between proposal and settlement.
    setOwner(state, SQ.jerusalem, null);

    const moneyBefore = totalMoney(state);
    const jailBefore = totalJailCards(state);

    const result = acceptTrade(state, SEAT_A);
    expect(result).toEqual({ ok: false, reason: 'basket_items_not_owned' });

    // Nothing moved: the failed settlement attempt did not touch cash, jail cards,
    // or the (already-changed) square ownership any further.
    expect(totalMoney(state)).toBe(moneyBefore);
    expect(totalJailCards(state)).toBe(jailBefore);
    expect(ownerOf(state, SQ.jerusalem)).toBeNull();
    expect(ownerOf(state, SQ.gaza)).toBe(SEAT_B);

    // The trade survives the failed settlement attempt — still in reviewing_a.
    const trade = findTradeFor(state, SEAT_A);
    expect(trade?.stage).toBe('reviewing_a');
  });

  it('B15: rejects settlement if a seat can no longer afford its offered cash', () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket({ cash: 100 }));
    acceptTrade(state, SEAT_B);
    proposeTrade(state, SEAT_B, basket({ cash: 50 }));

    // a spends down their cash after proposing.
    setMoney(state, SEAT_A, 10);

    const result = acceptTrade(state, SEAT_A);
    expect(result).toEqual({ ok: false, reason: 'basket_not_affordable' });
  });

  it("rejects settlement when both final baskets are empty", () => {
    const state = setUp();
    proposeTrade(state, SEAT_A, basket());
    acceptTrade(state, SEAT_B);
    proposeTrade(state, SEAT_B, basket());
    expect(acceptTrade(state, SEAT_A)).toEqual({ ok: false, reason: 'empty_basket' });
  });
});

describe('cancelTrade', () => {
  it('tears the trade down for both seats and never touches state.phase (B13)', () => {
    const state = makeDuel();
    state.phase = 'draw_card';
    const phaseBefore = state.phase;
    openTrade(state, SEAT_A, SEAT_B, NOW);
    proposeTrade(state, SEAT_A, basket({ cash: 10 }));

    const result = cancelTrade(state, SEAT_A, 'user_cancelled');
    expect(result.ok).toBe(true);
    expect(state.trades).toHaveLength(0);
    expect(findTradeFor(state, SEAT_A)).toBeUndefined();
    expect(findTradeFor(state, SEAT_B)).toBeUndefined();
    expect(state.phase).toBe(phaseBefore);
    if (result.ok) {
      expect(result.events).toEqual([
        { type: 'TRADE_CANCELLED', tradeId: result.value.id, reason: 'user_cancelled' },
      ]);
    }
  });

  it('rejects when there is no active trade for the seat', () => {
    const state = makeDuel();
    expect(cancelTrade(state, SEAT_A, 'anything')).toEqual({ ok: false, reason: 'no_active_trade' });
  });

  it('works even for an inactive (bankrupt) seat — cancellation is the cleanup path for bankruptcy', () => {
    const state = makeDuel();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    p(state, SEAT_A).isBankrupt = true;
    expect(cancelTrade(state, SEAT_A, 'bankruptcy').ok).toBe(true);
  });
});

describe('expireTrades', () => {
  it('removes trades past their expiresAt and frees the seat to trade again (B14)', () => {
    const state = makeDuel();
    const opened = openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(opened.ok).toBe(true);

    const stillActive = expireTrades(state, NOW + 1000, 'timeout');
    expect(stillActive.events).toEqual([]);
    expect(findTradeFor(state, SEAT_A)).toBeDefined();

    const expiryTime = NOW + TRADE_TIMEOUT_SECONDS * 1000;
    const swept = expireTrades(state, expiryTime, 'timeout');
    expect(swept.state.trades).toHaveLength(0);
    if (opened.ok) {
      expect(swept.events).toEqual([{ type: 'TRADE_CANCELLED', tradeId: opened.value.id, reason: 'timeout' }]);
    }

    // B14: the seat is no longer permanently stuck "in a trade".
    expect(findTradeFor(state, SEAT_A)).toBeUndefined();
    const reopened = openTrade(state, SEAT_A, SEAT_B, expiryTime + 1);
    expect(reopened.ok).toBe(true);
  });

  it('leaves unexpired trades alone', () => {
    const state = makeDuel();
    openTrade(state, SEAT_A, SEAT_B, NOW);
    const result = expireTrades(state, NOW + 1, 'timeout');
    expect(result.events).toHaveLength(0);
    expect(state.trades).toHaveLength(1);
  });
});

describe('B13: state.phase is never written by trade.ts', () => {
  it('is byte-identical before and after the full lifecycle', () => {
    const state = makeDuel();
    state.phase = 'upgrade_choice';
    const phaseBefore = state.phase;

    openTrade(state, SEAT_A, SEAT_B, NOW);
    expect(state.phase).toBe(phaseBefore);
    proposeTrade(state, SEAT_A, basket({ cash: 10 }));
    expect(state.phase).toBe(phaseBefore);
    acceptTrade(state, SEAT_B);
    expect(state.phase).toBe(phaseBefore);
    declineTrade(state, SEAT_A);
    expect(state.phase).toBe(phaseBefore);
    proposeTrade(state, SEAT_A, basket({ cash: 20 }));
    expect(state.phase).toBe(phaseBefore);
    acceptTrade(state, SEAT_B);
    expect(state.phase).toBe(phaseBefore);
    proposeTrade(state, SEAT_B, basket());
    expect(state.phase).toBe(phaseBefore);
    acceptTrade(state, SEAT_A); // settles
    expect(state.phase).toBe(phaseBefore);

    const reopened = openTrade(state, SEAT_A, SEAT_B, NOW + 100);
    expect(reopened.ok).toBe(true);
    expect(state.phase).toBe(phaseBefore);
    cancelTrade(state, SEAT_A, 'cleanup');
    expect(state.phase).toBe(phaseBefore);
  });
});
