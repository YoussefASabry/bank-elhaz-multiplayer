import { describe, it, expect } from 'vitest';
import { makeEngine, grant, data, seqRng } from './helpers.js';

const hazak = id => data.hazak.hazak.find(c => c.id === id);
const mahkama = id => data.mahkama.mahkama.find(c => c.id === id);

// Plant a card as if drawn and reveal it as the current player.
function play(e, deckType, card, { second = null } = {}) {
  const player = e.current();
  e.state.phase = 'card';
  e.state.pending = { card, deckType, playerId: player.id, squareName: 'test', second };
  return e.dispatch(player.id, { type: 'reveal_card' });
}

describe('hazak cards', () => {
  it('1: +200 insurance, move back 5', () => {
    const e = makeEngine();
    const p = e.player('p1');
    p.position = 13; // 13-5=8 is club → choose guest to isolate
    play(e, 'hazak', hazak(1));
    expect(p.position).toBe(8);
    expect(e.state.phase).toBe('club_choice');
    e.dispatch('p1', { type: 'club_choice', choice: 'guest' });
    expect(p.money).toBe(1500 + 200 - 20);
  });

  it('2: grants a free-play card (stored, no in-game effect)', () => {
    const e = makeEngine();
    play(e, 'hazak', hazak(2));
    expect(e.player('p1').freeCards).toBe(1);
  });

  it('3: pays $100 to the bank', () => {
    const e = makeEngine();
    play(e, 'hazak', hazak(3));
    expect(e.player('p1').money).toBe(1400);
  });

  it('4: pays $100 then teleports to start with salary', () => {
    const e = makeEngine();
    const p = e.player('p1');
    p.position = 10;
    play(e, 'hazak', hazak(4));
    expect(p.position).toBe(1);
    expect(p.money).toBe(1500 - 100 + data.board.game_meta.pass_go_salary);
  });

  it('5 & 9: receive bank money', () => {
    const e = makeEngine();
    play(e, 'hazak', hazak(5));
    expect(e.player('p1').money).toBe(1600);
    while (e.current().id !== 'p1') e.autoResolve();
    play(e, 'hazak', hazak(9));
    expect(e.player('p1').money).toBe(1650);
  });

  it('6 & 13: collect from every player', () => {
    const e = makeEngine();
    play(e, 'hazak', hazak(6)); // +30 each
    expect(e.player('p1').money).toBe(1560);
    expect(e.player('p2').money).toBe(1470);
    while (e.current().id !== 'p1') e.autoResolve();
    play(e, 'hazak', hazak(13)); // +50 each
    expect(e.player('p1').money).toBe(1660);
  });

  it('6: broke players pay only what they have', () => {
    const e = makeEngine();
    e.player('p2').money = 10;
    play(e, 'hazak', hazak(6));
    expect(e.player('p2').money).toBe(0);
    expect(e.player('p1').money).toBe(1540); // 10 + 30
  });

  it('7: +100 then choose one of 3 cities to travel to', () => {
    const e = makeEngine();
    play(e, 'hazak', hazak(7));
    expect(e.state.phase).toBe('card_choice');
    const opts = e.state.pending.options;
    expect(opts.length).toBe(3);
    const r = e.dispatch('p1', { type: 'card_choice', index: 0 });
    expect(r.ok).toBe(true);
    const p = e.player('p1');
    // Landed on the chosen city → either buy_decision (unowned) or turn ended
    expect([opts[0].squareId]).toContain(p.position);
    expect(p.money).toBeGreaterThanOrEqual(1600 - 0); // +100 applied before choice
  });

  it('8, 10, 12: fixed bank payments', () => {
    for (const [id, cost] of [[8, 150], [10, 100], [12, 100]]) {
      const e = makeEngine();
      play(e, 'hazak', hazak(id));
      expect(e.player('p1').money).toBe(1500 - cost);
    }
  });

  it('11: +100 and teleport to Bahrain (12); pays rent there if owned', () => {
    const e = makeEngine();
    grant(e, 'p2', 12); // Bahrain base 15
    play(e, 'hazak', hazak(11));
    const p = e.player('p1');
    expect(p.position).toBe(12);
    expect(p.money).toBe(1500 + 100 - 15);
  });

  it('14: move forward 4 with half-rent applied on landing', () => {
    const e = makeEngine();
    const p = e.player('p1');
    p.position = 30; // +4 → 34 (Qatar, base 20)
    grant(e, 'p2', 34);
    play(e, 'hazak', hazak(14));
    expect(p.position).toBe(34);
    expect(p.money).toBe(1500 - 10); // half of 20
    expect(p.halfRentNext).toBe(false);
  });

  it('15: choice of $150 or a free unowned property from the pool', () => {
    const e = makeEngine();
    play(e, 'hazak', hazak(15));
    expect(e.state.phase).toBe('card_choice');
    const propOpt = e.state.pending.options.findIndex(o => o.action === 'claim_property');
    e.dispatch('p1', { type: 'card_choice', index: propOpt });
    const owned = [9, 10, 12, 34].some(id => e.square(id).owner === 'p1');
    expect(owned).toBe(true);
  });

  it('15: falls back to cash when the whole pool is owned', () => {
    const e = makeEngine();
    grant(e, 'p2', 9, 10, 12, 34);
    play(e, 'hazak', hazak(15));
    expect(e.player('p1').money).toBe(1650);
    expect(e.state.phase).not.toBe('card_choice');
  });
});

describe('mahkama cards', () => {
  it('1: collect 25 from each player', () => {
    const e = makeEngine();
    play(e, 'mahkama', mahkama(1));
    expect(e.player('p1').money).toBe(1550);
    expect(e.player('p2').money).toBe(1475);
  });

  it('2, 3, 12: fines to the bank', () => {
    for (const [id, fine] of [[2, 40], [3, 50], [12, 15]]) {
      const e = makeEngine();
      play(e, 'mahkama', mahkama(id));
      expect(e.player('p1').money).toBe(1500 - fine);
    }
  });

  it('4 & 13: receive from bank', () => {
    for (const [id, amt] of [[4, 100], [13, 200]]) {
      const e = makeEngine();
      play(e, 'mahkama', mahkama(id));
      expect(e.player('p1').money).toBe(1500 + amt);
    }
  });

  it('5 & 6: go to jail', () => {
    for (const id of [5, 6]) {
      const e = makeEngine();
      play(e, 'mahkama', mahkama(id));
      expect(e.player('p1').inJail).toBe(true);
      expect(e.player('p1').position).toBe(25);
    }
  });

  it('7: receive a jail-free card', () => {
    const e = makeEngine();
    play(e, 'mahkama', mahkama(7));
    expect(e.player('p1').jailFreeCards).toBe(1);
  });

  it('8: bank pays $25 per building', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3);
    e.square(2).level = 3; e.square(3).level = 1; // 4 buildings
    play(e, 'mahkama', mahkama(8));
    expect(e.player('p1').money).toBe(1500 + 100);
  });

  it('9: repairs charged per building tier', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3);
    e.square(2).level = 3; // garage+rest+market = 25+50+100 = 175
    e.square(3).level = 1; // 25
    play(e, 'mahkama', mahkama(9));
    expect(e.player('p1').money).toBe(1500 - 200);
  });

  it('9: no buildings → no charge', () => {
    const e = makeEngine();
    play(e, 'mahkama', mahkama(9));
    expect(e.player('p1').money).toBe(1500);
  });

  it('10: collects $50 per selected owned city from its owner', () => {
    const e = makeEngine();
    grant(e, 'p2', 2, 3); // only two owned properties → both selected
    play(e, 'mahkama', mahkama(10));
    expect(e.player('p1').money).toBe(1600);
    expect(e.player('p2').money).toBe(1400);
  });

  it('10: no owned cities → nothing happens', () => {
    const e = makeEngine();
    play(e, 'mahkama', mahkama(10));
    expect(e.player('p1').money).toBe(1500);
  });

  it('11: choice — claim a free city ≤150 or take $100', () => {
    const e = makeEngine();
    play(e, 'mahkama', mahkama(11));
    expect(e.state.phase).toBe('card_choice');
    e.dispatch('p1', { type: 'card_choice', index: 0 }); // cash
    expect(e.player('p1').money).toBe(1600);
  });

  it('11: auto-cash when no cheap property is free', () => {
    const e = makeEngine();
    for (const s of e.state.squares) if (s.type === 'property' && s.purchase_price <= 150) s.owner = 'p2';
    play(e, 'mahkama', mahkama(11));
    expect(e.state.phase).not.toBe('card_choice');
    expect(e.player('p1').money).toBe(1600);
  });

  it('14: pay $50 and skip next turn', () => {
    const e = makeEngine();
    play(e, 'mahkama', mahkama(14)); // turn advances to p2
    const p = e.player('p1');
    expect(p.money).toBe(1450);
    expect(p.skipNextTurn).toBe(true);
    expect(e.current().id).toBe('p2');
    e.advanceTurn(); // p2 → p3
    expect(e.current().id).toBe('p3');
    e.advanceTurn(); // p3 → p1 is skipped → p2
    expect(e.current().id).toBe('p2');
    expect(p.skipNextTurn).toBe(false);
  });

  it('15: choice — pay $100 or go to prison', () => {
    const e1 = makeEngine();
    play(e1, 'mahkama', mahkama(15));
    e1.dispatch('p1', { type: 'card_choice', index: 0 });
    expect(e1.player('p1').money).toBe(1400);

    const e2 = makeEngine();
    play(e2, 'mahkama', mahkama(15));
    e2.dispatch('p1', { type: 'card_choice', index: 1 });
    expect(e2.player('p1').inJail).toBe(true);
  });
});

describe('dual deck square', () => {
  it('draws mahkama then hazak', () => {
    const e = makeEngine();
    // plant simple cards on top of both decks
    e.state.decks.mahkama.push(mahkama(4)); // +100
    e.state.decks.hazak.push(hazak(9));     // +50
    play(e, 'mahkama', mahkama(4), { second: 'hazak' });
    expect(e.state.phase).toBe('card');
    expect(e.state.pending.deckType).toBe('hazak');
    e.dispatch('p1', { type: 'reveal_card' });
    expect(e.player('p1').money).toBe(1500 + 100 + 50);
  });
});

describe('deck reshuffle', () => {
  it('recycles the discard pile when a deck empties', () => {
    const e = makeEngine();
    e.state.decks.hazak = [];
    e.state.decks.hazakDiscard = [hazak(9)];
    const card = e.drawCard('hazak');
    expect(card.id).toBe(9);
    expect(e.drawCard('hazak')).toBe(null);
  });
});
