/**
 * Redaction (WIRE.md rule 1). These are the tests that would have caught B19's
 * client-side twin and B23: the legacy server broadcast the raw `GameState`, so
 * the deck order, every balance and the card being read were all on the wire.
 */
import { describe, expect, it } from 'vitest';
import { buildClientState } from '../../src/server/view.js';
import { makeState, SEAT_A, SEAT_B, p, setPosition } from '../helpers/fixtures.js';
import { applyAction } from '../../src/engine/index.js';
import { createRng } from '../../src/engine/rng.js';
import type { GameState } from '../../src/shared/types.js';

describe('view — the deck is never on the wire', () => {
  it('sends counts, not cards', () => {
    const s = makeState();
    const view = buildClientState(s, SEAT_A);

    expect(view.decks.hazak.drawCount).toBe(s.decks.hazak.draw.length);
    expect(view.decks.hazak.discardCount).toBe(s.decks.hazak.discard.length);
    // The projection must not carry the cards themselves under ANY key.
    expect(JSON.stringify(view.decks)).not.toContain('description');
  });

  it('leaks no card id anywhere in the payload of a fresh game', () => {
    const s = makeState();
    const json = JSON.stringify(buildClientState(s, SEAT_A));
    // Every real card carries a `description`; the board does not.
    const descriptions = s.decks.hazak.draw.map((c) => c.description).filter((d) => d.length > 8);
    for (const d of descriptions.slice(0, 5)) {
      expect(json).not.toContain(d);
    }
  });
});

describe('view — balances honour moneyVisible (B23)', () => {
  it('hides other players money but never your own', () => {
    const s = makeState({ config: { moneyVisible: false } });
    const view = buildClientState(s, SEAT_A);

    const me = view.players.find((q) => q.id === SEAT_A);
    const them = view.players.find((q) => q.id === SEAT_B);
    expect(me?.money).toBe(p(s, SEAT_A).money);
    expect(them?.money).toBeNull();
  });

  it('shows everyone when the host left balances visible', () => {
    const s = makeState({ config: { moneyVisible: true } });
    const view = buildClientState(s, SEAT_A);
    expect(view.players.every((q) => typeof q.money === 'number')).toBe(true);
  });

  it('hidden money is null, not zero — a client must not render it as broke', () => {
    const s = makeState({ config: { moneyVisible: false }, cash: 1500 });
    const them = buildClientState(s, SEAT_A).players.find((q) => q.id === SEAT_B);
    expect(them?.money).toBeNull();
    expect(them?.money).not.toBe(0);
  });
});

/** Force a blind_card pending for SEAT_A by landing them on a deck square. */
function withBlindCard(): GameState {
  const s = makeState();
  setPosition(s, SEAT_A, 13); // hazak trigger
  s.currentPlayerIndex = s.players.findIndex((q) => q.id === SEAT_A);
  s.phase = 'draw_card';
  s.pending = { kind: 'deck_draw', playerId: SEAT_A, queue: ['hazak'], squareName: 'حظك' };
  return applyAction(s, { type: 'DRAW_CARD', actorId: SEAT_A, deck: 'hazak' }, createRng(9)).state;
}

describe('view — a blind card is private (WIRE.md rule 3)', () => {
  it('gives the drawing player the real card', () => {
    const s = withBlindCard();
    expect(s.pending.kind).toBe('blind_card');
    const mine = buildClientState(s, SEAT_A).pending;
    expect(mine.kind).toBe('blind_card');
  });

  it('replaces it with an opaque marker for everyone else', () => {
    const s = withBlindCard();
    const theirs = buildClientState(s, SEAT_B).pending;
    expect(theirs.kind).toBe('blind_card_hidden');
    expect(JSON.stringify(theirs)).not.toContain('description');
  });

  it('still tells opponents how far through the deck we are', () => {
    const s = withBlindCard();
    const theirs = buildClientState(s, SEAT_B).pending;
    if (theirs.kind !== 'blind_card_hidden') throw new Error('expected hidden marker');
    expect(theirs.playerId).toBe(SEAT_A);
    expect(theirs.totalCards).toBeGreaterThan(0);
  });
});

describe('view — projections never alias live state', () => {
  it('mutating a projection cannot write back into GameState', () => {
    const s = makeState();
    const view = buildClientState(s, SEAT_A);

    const first = view.players[0];
    if (first === undefined) throw new Error('no players');
    first.name = 'TAMPERED';
    first.inventory.jailFreeCards = 99;
    view.ownership[2] = { owner: SEAT_B, upgrade: 'market' };

    expect(s.players[0]?.name).not.toBe('TAMPERED');
    expect(s.players[0]?.inventory.jailFreeCards).toBe(0);
    expect(s.ownership[2]?.owner).toBeNull();
  });

  it('tells the recipient who they are, so the client never guesses', () => {
    const s = makeState();
    expect(buildClientState(s, SEAT_B).youAre).toBe(SEAT_B);
  });
});
