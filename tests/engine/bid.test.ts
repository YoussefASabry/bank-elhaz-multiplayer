/**
 * engine/bid.ts — pure bid state machine.
 *
 * "One active bid per seat" IS enforced, via the 'already_has_active_bid'
 * RejectReason. It was missing from the union when this file was first written;
 * it was added and the rule is now covered below. The old implementation
 * enforced the same rule at roomManager.js:739-740, so omitting it would have
 * been a regression — the client positions one floating bid box per bid near its
 * owner, and two concurrent bids from one seat would overlap.
 */
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
import { createBid, offerOnBid, acceptOffer, cancelBid, expireBids } from '../../src/engine/bid.js';
import { ownerOf, upgradeOf } from '../../src/engine/state.js';
import { BID_TTL_MS } from '../../src/shared/rules.js';
import type { Basket } from '../../src/shared/trading.js';

const NOW = 1_000_000;

function basket(overrides: Partial<Basket> = {}): Basket {
  return { cash: 0, squareIds: [], jailCards: 0, ...overrides };
}

describe('createBid — one active bid per seat', () => {
  it('rejects a second concurrent bid from the same seat', () => {
    const state = makeDuel({ cash: 1000 });
    expect(createBid(state, SEAT_A, basket({ cash: 100 }), NOW).ok).toBe(true);

    const second = createBid(state, SEAT_A, basket({ cash: 200 }), NOW + 1);
    expect(second).toEqual({ ok: false, reason: 'already_has_active_bid' });
    // The rejection must not have half-created anything.
    expect(state.bids).toHaveLength(1);
    expect(state.bids[0]?.basket.cash).toBe(100);
  });

  it('still allows a DIFFERENT seat to bid concurrently', () => {
    const state = makeDuel({ cash: 1000 });
    expect(createBid(state, SEAT_A, basket({ cash: 100 }), NOW).ok).toBe(true);
    expect(createBid(state, SEAT_B, basket({ cash: 100 }), NOW).ok).toBe(true);
    expect(state.bids).toHaveLength(2);
  });

  it('frees the seat to bid again after it cancels', () => {
    const state = makeDuel({ cash: 1000 });
    const first = createBid(state, SEAT_A, basket({ cash: 100 }), NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(cancelBid(state, SEAT_A, first.value.id).ok).toBe(true);
    expect(createBid(state, SEAT_A, basket({ cash: 200 }), NOW + 1).ok).toBe(true);
  });

  it('frees the seat to bid again after the bid EXPIRES (same shape as trade bug B14)', () => {
    const state = makeDuel({ cash: 1000 });
    expect(createBid(state, SEAT_A, basket({ cash: 100 }), NOW).ok).toBe(true);

    expireBids(state, NOW + BID_TTL_MS + 1);
    expect(state.bids).toHaveLength(0);

    // A stale record must not lock the seat out for the rest of the game.
    expect(createBid(state, SEAT_A, basket({ cash: 200 }), NOW + BID_TTL_MS + 2).ok).toBe(true);
  });
});

describe('createBid', () => {
  it('rejects an empty basket', () => {
    const state = makeDuel();
    const result = createBid(state, SEAT_A, basket(), NOW);
    expect(result).toEqual({ ok: false, reason: 'empty_basket' });
    expect(state.bids).toHaveLength(0);
  });

  it('rejects cash the seat does not have', () => {
    const state = makeDuel({ cash: 100 });
    const result = createBid(state, SEAT_A, basket({ cash: 500 }), NOW);
    expect(result).toEqual({ ok: false, reason: 'basket_not_affordable' });
    expect(state.bids).toHaveLength(0);
  });

  it('rejects a square the seat does not own', () => {
    const state = makeDuel();
    give(state, SEAT_B, SQ.jerusalem);
    const result = createBid(state, SEAT_A, basket({ squareIds: [SQ.jerusalem] }), NOW);
    expect(result).toEqual({ ok: false, reason: 'basket_items_not_owned' });
    expect(state.bids).toHaveLength(0);
  });

  it('rejects a square that carries an upgrade, rather than silently dropping it (B12 sibling)', () => {
    const state = makeDuel();
    give(state, SEAT_A, SQ.jerusalem, 'garage');
    const result = createBid(state, SEAT_A, basket({ squareIds: [SQ.jerusalem] }), NOW);
    expect(result).toEqual({ ok: false, reason: 'property_has_upgrade' });
    expect(state.bids).toHaveLength(0);
  });

  it('rejects more jail cards than the seat holds, rather than driving the count negative (B15 sibling)', () => {
    const state = makeDuel();
    giveJailCards(state, SEAT_A, 1);
    const result = createBid(state, SEAT_A, basket({ jailCards: 2 }), NOW);
    expect(result).toEqual({ ok: false, reason: 'insufficient_jail_cards' });
    expect(state.bids).toHaveLength(0);
    // Nothing was mutated on the failed attempt.
    expect(p(state, SEAT_A).inventory.jailFreeCards).toBe(1);
  });

  it('rejects a bankrupt or eliminated seat', () => {
    const state = makeDuel();
    p(state, SEAT_A).isBankrupt = true;
    const result = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    expect(result).toEqual({ ok: false, reason: 'player_inactive' });

    const state2 = makeDuel();
    p(state2, SEAT_A).eliminated = true;
    const result2 = createBid(state2, SEAT_A, basket({ cash: 10 }), NOW);
    expect(result2).toEqual({ ok: false, reason: 'player_inactive' });
  });

  it('creates a bid on a valid basket', () => {
    const state = makeDuel();
    give(state, SEAT_A, SQ.jerusalem);
    giveJailCards(state, SEAT_A, 1);
    const result = createBid(state, SEAT_A, basket({ cash: 50, squareIds: [SQ.jerusalem], jailCards: 1 }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.playerId).toBe(SEAT_A);
    expect(result.value.basket).toEqual({ cash: 50, squareIds: [SQ.jerusalem], jailCards: 1 });
    expect(result.value.offers).toEqual([]);
    expect(result.value.createdAt).toBe(NOW);
    expect(state.bids).toEqual([result.value]);
  });
});

describe('offerOnBid', () => {
  it('rejects an unknown bid id', () => {
    const state = makeDuel();
    const result = offerOnBid(state, SEAT_B, 'no-such-bid', basket({ cash: 10 }));
    expect(result).toEqual({ ok: false, reason: 'no_such_bid' });
  });

  it('rejects offering on your own bid', () => {
    const state = makeDuel();
    setMoney(state, SEAT_A, 100);
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    const result = offerOnBid(state, SEAT_A, created.value.id, basket({ cash: 5 }));
    expect(result).toEqual({ ok: false, reason: 'cannot_bid_on_own' });
    expect(created.value.offers).toEqual([]);
  });

  it('rejects an unaffordable counter-basket', () => {
    const state = makeState({ seats: [SEAT_A, SEAT_B, SEAT_C], cash: 100 });
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    const result = offerOnBid(state, SEAT_B, created.value.id, basket({ cash: 500 }));
    expect(result).toEqual({ ok: false, reason: 'basket_not_affordable' });
  });

  it('rejects a bankrupt or eliminated offerer', () => {
    const state = makeDuel();
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    p(state, SEAT_B).isBankrupt = true;
    const result = offerOnBid(state, SEAT_B, created.value.id, basket({ cash: 5 }));
    expect(result).toEqual({ ok: false, reason: 'player_inactive' });
  });

  it('adds a valid offer to the bid', () => {
    const state = makeDuel();
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    const result = offerOnBid(state, SEAT_B, created.value.id, basket({ cash: 5 }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.playerId).toBe(SEAT_B);
    expect(result.value.basket).toEqual({ cash: 5, squareIds: [], jailCards: 0 });
    expect(state.bids[0]?.offers).toEqual([result.value]);
  });
});

describe('acceptOffer', () => {
  function setupSettleable() {
    const state = makeState({ seats: [SEAT_A, SEAT_B, SEAT_C], cash: 500 });
    give(state, SEAT_A, SQ.jerusalem);
    give(state, SEAT_B, SQ.gaza);
    giveJailCards(state, SEAT_A, 1);

    const created = createBid(state, SEAT_A, basket({ cash: 100, squareIds: [SQ.jerusalem], jailCards: 1 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    const offered = offerOnBid(state, SEAT_B, created.value.id, basket({ cash: 50, squareIds: [SQ.gaza] }));
    if (!offered.ok) throw new Error('setup failed');
    return { state, bidId: created.value.id, offerId: offered.value.id };
  }

  it('rejects an unknown bid id', () => {
    const state = makeDuel();
    const result = acceptOffer(state, SEAT_A, 'no-such-bid', 'no-such-offer');
    expect(result).toEqual({ ok: false, reason: 'no_such_bid' });
  });

  it('rejects acceptance by anyone other than the bid owner', () => {
    const { state, bidId, offerId } = setupSettleable();
    // The offerer trying to accept their own offer.
    expect(acceptOffer(state, SEAT_B, bidId, offerId)).toEqual({ ok: false, reason: 'not_the_owner' });
    // An uninvolved third seat.
    expect(acceptOffer(state, SEAT_C, bidId, offerId)).toEqual({ ok: false, reason: 'not_the_owner' });
    expect(state.bids).toHaveLength(1);
  });

  it('rejects an unknown offer id', () => {
    const { state, bidId } = setupSettleable();
    const result = acceptOffer(state, SEAT_A, bidId, 'no-such-offer');
    expect(result).toEqual({ ok: false, reason: 'no_such_offer' });
  });

  it('settles: swaps baskets, conserving total cash, jail cards, and the multiset of square owners', () => {
    const { state, bidId, offerId } = setupSettleable();
    const cashBefore = totalMoney(state);
    const jailCardsBefore =
      p(state, SEAT_A).inventory.jailFreeCards + p(state, SEAT_B).inventory.jailFreeCards + p(state, SEAT_C).inventory.jailFreeCards;

    const result = acceptOffer(state, SEAT_A, bidId, offerId);
    expect(result.ok).toBe(true);

    // Cash: A paid 100, received 50 -> net -50. B paid 50, received 100 -> net +50.
    expect(p(state, SEAT_A).money).toBe(450);
    expect(p(state, SEAT_B).money).toBe(550);
    expect(totalMoney(state)).toBe(cashBefore);

    // Squares traded hands, nothing created or destroyed.
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_B);
    expect(ownerOf(state, SQ.gaza)).toBe(SEAT_A);

    // Jail cards: A gave 1, received 0 -> 0. B gave 0, received 1 -> 1.
    expect(p(state, SEAT_A).inventory.jailFreeCards).toBe(0);
    expect(p(state, SEAT_B).inventory.jailFreeCards).toBe(1);
    const jailCardsAfter =
      p(state, SEAT_A).inventory.jailFreeCards + p(state, SEAT_B).inventory.jailFreeCards + p(state, SEAT_C).inventory.jailFreeCards;
    expect(jailCardsAfter).toBe(jailCardsBefore);

    // The bid (and its offer) is gone.
    expect(state.bids).toHaveLength(0);
  });

  it('re-validates the OFFERER basket at accept time and rejects a stale offer (cash spent since offering)', () => {
    const { state, bidId, offerId } = setupSettleable();
    setMoney(state, SEAT_B, 10); // B no longer has the 50 they offered.

    const result = acceptOffer(state, SEAT_A, bidId, offerId);
    expect(result).toEqual({ ok: false, reason: 'basket_not_affordable' });

    // Nothing settled: bid still open, ownership and cash untouched.
    expect(state.bids).toHaveLength(1);
    expect(ownerOf(state, SQ.jerusalem)).toBe(SEAT_A);
    expect(ownerOf(state, SQ.gaza)).toBe(SEAT_B);
    expect(p(state, SEAT_A).money).toBe(500);
  });

  it('re-validates the BIDDER basket at accept time and rejects a stale bid (square sold since bidding)', () => {
    const { state, bidId, offerId } = setupSettleable();
    give(state, SEAT_C, SQ.jerusalem); // A no longer owns what they bid.

    const result = acceptOffer(state, SEAT_A, bidId, offerId);
    expect(result).toEqual({ ok: false, reason: 'basket_items_not_owned' });
    expect(state.bids).toHaveLength(1);
  });

  it('re-validates for an upgrade added since the offer, rather than settling on stale data', () => {
    const { state, bidId, offerId } = setupSettleable();
    give(state, SEAT_A, SQ.jerusalem, 'garage'); // still owned by A, but now upgraded.

    const result = acceptOffer(state, SEAT_A, bidId, offerId);
    expect(result).toEqual({ ok: false, reason: 'property_has_upgrade' });
    expect(state.bids).toHaveLength(1);
    expect(upgradeOf(state, SQ.jerusalem)).toBe('garage');
  });

  it('rejects settlement if either side went inactive since offering', () => {
    const { state, bidId, offerId } = setupSettleable();
    p(state, SEAT_B).isBankrupt = true;
    const result = acceptOffer(state, SEAT_A, bidId, offerId);
    expect(result).toEqual({ ok: false, reason: 'player_inactive' });
    expect(state.bids).toHaveLength(1);
  });
});

describe('cancelBid', () => {
  it('rejects an unknown bid id', () => {
    const state = makeDuel();
    expect(cancelBid(state, SEAT_A, 'no-such-bid')).toEqual({ ok: false, reason: 'no_such_bid' });
  });

  it('rejects cancellation by anyone other than the owner', () => {
    const state = makeDuel();
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    expect(cancelBid(state, SEAT_B, created.value.id)).toEqual({ ok: false, reason: 'not_the_owner' });
    expect(state.bids).toHaveLength(1);
  });

  it('removes the bid when cancelled by its owner', () => {
    const state = makeDuel();
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    if (!created.ok) throw new Error('setup failed');
    const result = cancelBid(state, SEAT_A, created.value.id);
    expect(result).toEqual({ ok: true, value: created.value });
    expect(state.bids).toHaveLength(0);
  });
});

describe('expireBids', () => {
  it('removes only bids whose TTL has elapsed, emitting one BID_CANCELLED event each', () => {
    const state = makeDuel();
    const fresh = createBid(state, SEAT_A, basket({ cash: 10 }), NOW);
    const stale = createBid(state, SEAT_B, basket({ cash: 10 }), NOW - BID_TTL_MS);
    if (!fresh.ok || !stale.ok) throw new Error('setup failed');

    const result = expireBids(state, NOW);
    expect(result.state.bids).toEqual([fresh.value]);
    expect(result.events).toEqual([{ type: 'BID_CANCELLED', bidId: stale.value.id }]);
  });

  it('keeps a bid whose TTL has not yet elapsed', () => {
    const state = makeDuel();
    const created = createBid(state, SEAT_A, basket({ cash: 10 }), NOW - BID_TTL_MS + 1);
    if (!created.ok) throw new Error('setup failed');
    const result = expireBids(state, NOW);
    expect(result.state.bids).toEqual([created.value]);
    expect(result.events).toEqual([]);
  });
});

describe('phase immutability (B13 sibling)', () => {
  it('never writes state.phase across create, offer, accept, cancel or expire', () => {
    const state = makeState({ seats: [SEAT_A, SEAT_B, SEAT_C], cash: 500 });
    const initialPhase = state.phase;
    give(state, SEAT_A, SQ.jerusalem);
    give(state, SEAT_B, SQ.gaza);

    const created = createBid(state, SEAT_A, basket({ squareIds: [SQ.jerusalem] }), NOW);
    expect(state.phase).toBe(initialPhase);
    if (!created.ok) throw new Error('setup failed');

    const offered = offerOnBid(state, SEAT_B, created.value.id, basket({ squareIds: [SQ.gaza] }));
    expect(state.phase).toBe(initialPhase);
    if (!offered.ok) throw new Error('setup failed');

    const accepted = acceptOffer(state, SEAT_A, created.value.id, offered.value.id);
    expect(state.phase).toBe(initialPhase);
    expect(accepted.ok).toBe(true);

    const created2 = createBid(state, SEAT_C, basket({ cash: 10 }), NOW);
    expect(state.phase).toBe(initialPhase);
    if (!created2.ok) throw new Error('setup failed');

    cancelBid(state, SEAT_C, created2.value.id);
    expect(state.phase).toBe(initialPhase);

    const created3 = createBid(state, SEAT_A, basket({ cash: 10 }), NOW - BID_TTL_MS);
    if (!created3.ok) throw new Error('setup failed');
    expireBids(state, NOW);
    expect(state.phase).toBe(initialPhase);
  });
});
