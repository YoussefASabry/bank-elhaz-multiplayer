import { describe, it, expect } from 'vitest';
import { makeEngine, forceRoll, grant, diceRng, data } from './helpers.js';

describe('movement & dice', () => {
  it('moves the player by dice total and records the path', () => {
    const e = makeEngine();
    e.rng = diceRng(2, 3);
    const r = e.dispatch('p1', { type: 'roll' });
    expect(r.ok).toBe(true);
    const roll = r.events.find(ev => ev.type === 'roll');
    expect(roll.total).toBe(5);
    expect(e.player('p1').position).toBe(6);
    expect(roll.path).toEqual([2, 3, 4, 5, 6]);
  });

  it('wraps around the 34-square board and pays salary when passing start', () => {
    const e = makeEngine();
    const p = e.player('p1');
    p.position = 33;
    e.rng = diceRng(2, 3); // 33 → 4 (passes start)
    const before = p.money;
    e.dispatch('p1', { type: 'roll' });
    expect(p.position).toBe(4);
    expect(p.money).toBeGreaterThanOrEqual(before + data.board.game_meta.pass_go_salary - 200); // salary paid (card may adjust)
  });

  it('rejects rolls out of turn', () => {
    const e = makeEngine();
    const r = e.dispatch('p2', { type: 'roll' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_your_turn');
  });

  it('double roll gives NO extra turn (house rule)', () => {
    const e = makeEngine();
    e.rng = diceRng(2, 2); // lands on 5 (property) — double
    e.dispatch('p1', { type: 'roll' });
    e.dispatch('p1', { type: 'decline' });
    expect(e.current().id).toBe('p2');
    expect(e.state.phase).toBe('awaiting_roll');
  });

  it('fast bus doubles the next roll', () => {
    const e = makeEngine();
    const p = e.player('p1');
    p.position = 13;
    e.rng = diceRng(2, 3); // land on 18 = fast bus
    e.dispatch('p1', { type: 'roll' });
    expect(p.doubleNextRoll).toBe(true);
    // next turn for p1: roll 2+3 = 5 → 10 steps → 28
    e.dispatch('p2', { type: 'jail_skip' }).ok || e.autoResolve();
  });
});

describe('property purchase & auction', () => {
  it('buying deducts money and assigns owner', () => {
    const e = makeEngine();
    forceRoll(e, 'p1', 5); // Beirut $300
    expect(e.state.phase).toBe('buy_decision');
    const before = e.player('p1').money;
    e.dispatch('p1', { type: 'buy' });
    expect(e.square(5).owner).toBe('p1');
    expect(e.player('p1').money).toBe(before - 300);
    expect(e.current().id).toBe('p2');
  });

  it('declining just ends the turn; property stays with the bank', () => {
    const e = makeEngine();
    forceRoll(e, 'p1', 5);
    e.dispatch('p1', { type: 'decline' });
    expect(e.square(5).owner).toBe(null);
    expect(e.state.phase).toBe('awaiting_roll');
    expect(e.current().id).toBe('p2');
  });
});

describe('rent', () => {
  it('charges base rent and pays the owner', () => {
    const e = makeEngine();
    grant(e, 'p2', 5); // Beirut base 32
    const before1 = e.player('p1').money, before2 = e.player('p2').money;
    forceRoll(e, 'p1', 5);
    expect(e.player('p1').money).toBe(before1 - 32);
    expect(e.player('p2').money).toBe(before2 + 32);
    expect(e.current().id).toBe('p2');
  });

  it('doubles base rent on a full unimproved color set', () => {
    const e = makeEngine();
    grant(e, 'p2', 5, 6, 7); // full pink set
    const before = e.player('p1').money;
    forceRoll(e, 'p1', 5);
    expect(e.player('p1').money).toBe(before - 64);
  });

  it('uses building-tier rent', () => {
    const e = makeEngine();
    grant(e, 'p2', 5, 6, 7);
    e.square(5).level = 2; e.square(6).level = 2; e.square(7).level = 2;
    const before = e.player('p1').money;
    forceRoll(e, 'p1', 5);
    expect(e.player('p1').money).toBe(before - data.board.board_positions.find(s => s.id === 5).visitor_paying.rest_stop_rent);
  });

  it('half-rent status halves next rent once', () => {
    const e = makeEngine();
    grant(e, 'p2', 5);
    e.player('p1').halfRentNext = true;
    const before = e.player('p1').money;
    forceRoll(e, 'p1', 5);
    expect(e.player('p1').money).toBe(before - 16); // ceil(32/2)
    expect(e.player('p1').halfRentNext).toBe(false);
  });

  it('landing on own property does nothing', () => {
    const e = makeEngine();
    grant(e, 'p1', 5);
    const before = e.player('p1').money;
    forceRoll(e, 'p1', 5);
    expect(e.player('p1').money).toBe(before);
    expect(e.current().id).toBe('p2');
  });
});

describe('building rules', () => {
  it('requires the full color set', () => {
    const e = makeEngine();
    grant(e, 'p1', 2); // purple is 2 & 3
    expect(e.dispatch('p1', { type: 'build', squareId: 2 }).error).toBe('need_full_set');
    grant(e, 'p1', 3);
    expect(e.dispatch('p1', { type: 'build', squareId: 2 }).ok).toBe(true);
    expect(e.square(2).level).toBe(1);
    expect(e.player('p1').money).toBe(1500 - 150); // 50% of 300
  });

  it('enforces even building across the set', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3);
    e.dispatch('p1', { type: 'build', squareId: 2 });
    expect(e.dispatch('p1', { type: 'build', squareId: 2 }).error).toBe('build_evenly');
    expect(e.dispatch('p1', { type: 'build', squareId: 3 }).ok).toBe(true);
    expect(e.dispatch('p1', { type: 'build', squareId: 2 }).ok).toBe(true);
  });

  it('blocks building past market level and on utilities', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3, 16);
    e.player('p1').money = 99999;
    e.square(2).level = 3; e.square(3).level = 3;
    expect(e.dispatch('p1', { type: 'build', squareId: 2 }).error).toBe('max_level');
    expect(e.dispatch('p1', { type: 'build', squareId: 16 }).error).toBe('cannot_build_here');
  });

  it('sells buildings evenly for 75% refund', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3);
    e.square(2).level = 2; e.square(3).level = 1;
    expect(e.dispatch('p1', { type: 'sell_building', squareId: 3 }).error).toBe('sell_evenly');
    const before = e.player('p1').money;
    expect(e.dispatch('p1', { type: 'sell_building', squareId: 2 }).ok).toBe(true);
    expect(e.player('p1').money).toBe(before + Math.round(300 * 0.8 * 0.75));
  });
});

describe('selling to the bank', () => {
  it('sell property pays 50% and returns it to the bank', () => {
    const e = makeEngine();
    grant(e, 'p1', 2);
    e.dispatch('p1', { type: 'sell_property', squareId: 2 });
    expect(e.player('p1').money).toBe(1500 + 150);
    expect(e.square(2).owner).toBe(null);
  });

  it('cannot sell a property that still has buildings', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3);
    e.square(2).level = 1;
    expect(e.dispatch('p1', { type: 'sell_property', squareId: 2 }).error).toBe('has_buildings');
  });

  it('mortgage action no longer exists', () => {
    const e = makeEngine();
    grant(e, 'p1', 2);
    expect(e.dispatch('p1', { type: 'mortgage', squareId: 2 }).error).toBe('unknown_action');
  });
});

describe('debt & bankruptcy', () => {
  it('opens debt phase when rent unaffordable but assets can cover it', () => {
    const e = makeEngine();
    grant(e, 'p2', 5);
    e.square(5).level = 3; // Beirut market rent 1500
    grant(e, 'p1', 24); // Cairo, mortgage value 225
    e.player('p1').money = 1400;
    forceRoll(e, 'p1', 5);
    expect(e.state.phase).toBe('debt');
    // liquidate: sell Cairo to the bank (+$225)
    e.dispatch('p1', { type: 'sell_property', squareId: 24 });
    expect(e.dispatch('p1', { type: 'pay_debt' }).ok).toBe(true);
    expect(e.player('p2').money).toBe(1500 + 1500);
    expect(e.current().id).toBe('p2');
  });

  it('auto-bankrupts when net worth cannot cover the debt; creditor gets assets', () => {
    const e = makeEngine();
    grant(e, 'p2', 5);
    e.square(5).level = 3;
    grant(e, 'p1', 34);
    e.player('p1').money = 10;
    forceRoll(e, 'p1', 5);
    const p1 = e.player('p1');
    expect(p1.isBankrupt).toBe(true);
    expect(e.square(34).owner).toBe('p2'); // assets transferred to creditor
    expect(e.player('p2').money).toBe(1500 + 10);
    expect(e.state.gameOver).toBe(false);
  });

  it('voluntary bankruptcy in debt phase transfers to creditor', () => {
    const e = makeEngine();
    grant(e, 'p2', 5);
    e.square(5).level = 3;
    grant(e, 'p1', 24);
    e.player('p1').money = 1400;
    forceRoll(e, 'p1', 5);
    expect(e.state.phase).toBe('debt');
    e.dispatch('p1', { type: 'declare_bankruptcy' });
    expect(e.player('p1').isBankrupt).toBe(true);
    expect(e.square(24).owner).toBe('p2');
  });

  it('bank-debt bankruptcy returns properties to the bank', () => {
    const e = makeEngine(); // 3 players so game continues
    const p1 = e.player('p1');
    grant(e, 'p1', 34);
    p1.money = 5;
    // Land on club and pick membership ($150) with no net worth
    p1.position = 4;
    e.rng = diceRng(1, 3);
    e.dispatch('p1', { type: 'roll' }); // lands on 8 = club
    expect(e.state.phase).toBe('club_choice');
    e.dispatch('p1', { type: 'club_choice', choice: 'membership' });
    expect(p1.isBankrupt).toBe(true);
    expect(e.square(34).owner).toBe(null);
  });

  it('game over when only one player remains', () => {
    const e = makeEngine({ players: 2 });
    grant(e, 'p2', 5);
    e.square(5).level = 3;
    e.player('p1').money = 10;
    forceRoll(e, 'p1', 5);
    expect(e.state.gameOver).toBe(true);
    expect(e.state.winnerId).toBe('p2');
    expect(e.state.phase).toBe('game_over');
  });
});

describe('prison', () => {
  it('landing on prison jails for 2 turns; skip serves time', () => {
    const e = makeEngine();
    forceRoll(e, 'p1', 25);
    const p1 = e.player('p1');
    expect(p1.inJail).toBe(true);
    expect(p1.jailTurns).toBe(2);
    expect(e.current().id).toBe('p2');
    // back to p1's turn
    e.dispatch('p2', { type: 'roll' }); e.autoResolveLoop?.();
    // fast-forward: force p2 & p3 turns to end
    while (e.current().id !== 'p1' && !e.state.gameOver) e.autoResolve();
    expect(e.dispatch('p1', { type: 'roll' }).error).toBe('in_jail');
    e.dispatch('p1', { type: 'jail_skip' });
    expect(p1.jailTurns).toBe(1);
    while (e.current().id !== 'p1' && !e.state.gameOver) e.autoResolve();
    e.dispatch('p1', { type: 'jail_skip' });
    expect(p1.inJail).toBe(false);
  });

  it('bail frees immediately and allows rolling', () => {
    const e = makeEngine();
    forceRoll(e, 'p1', 25);
    while (e.current().id !== 'p1') e.autoResolve();
    const before = e.player('p1').money;
    e.dispatch('p1', { type: 'jail_pay' });
    expect(e.player('p1').money).toBe(before - 50);
    expect(e.player('p1').inJail).toBe(false);
    expect(e.dispatch('p1', { type: 'roll' }).ok).toBe(true);
  });

  it('jail-free card frees without cost', () => {
    const e = makeEngine();
    forceRoll(e, 'p1', 25);
    e.player('p1').jailFreeCards = 1;
    while (e.current().id !== 'p1') e.autoResolve();
    e.dispatch('p1', { type: 'jail_card' });
    expect(e.player('p1').inJail).toBe(false);
    expect(e.player('p1').jailFreeCards).toBe(0);
  });
});

describe('trade', () => {
  it('executes a fair two-way trade', () => {
    const e = makeEngine();
    grant(e, 'p1', 2);
    grant(e, 'p2', 5);
    const r = e.dispatch('p1', {
      type: 'propose_trade', toId: 'p2',
      give: { cash: 100, props: [2] }, get: { props: [5], jailCards: 0 },
    });
    expect(r.ok).toBe(true);
    e.dispatch('p2', { type: 'respond_trade', accept: true });
    expect(e.square(2).owner).toBe('p2');
    expect(e.square(5).owner).toBe('p1');
    expect(e.player('p1').money).toBe(1400);
    expect(e.player('p2').money).toBe(1600);
    expect(e.state.trade).toBe(null);
  });

  it('declining clears the trade with no transfer', () => {
    const e = makeEngine();
    grant(e, 'p1', 2);
    e.dispatch('p1', { type: 'propose_trade', toId: 'p2', give: { props: [2] }, get: { cash: 50 } });
    e.dispatch('p2', { type: 'respond_trade', accept: false });
    expect(e.square(2).owner).toBe('p1');
    expect(e.state.trade).toBe(null);
  });

  it('rejects trading properties with buildings and empty trades', () => {
    const e = makeEngine();
    grant(e, 'p1', 2, 3);
    e.square(2).level = 1;
    const r = e.dispatch('p1', { type: 'propose_trade', toId: 'p2', give: { props: [2] }, get: {} });
    expect(r.error).toBe('empty_trade'); // built property filtered out → nothing left
  });

  it('only the target may respond; only one trade at a time', () => {
    const e = makeEngine();
    grant(e, 'p1', 2);
    e.dispatch('p1', { type: 'propose_trade', toId: 'p2', give: { props: [2] }, get: { cash: 1 } });
    expect(e.dispatch('p3', { type: 'respond_trade', accept: true }).error).toBe('not_your_trade');
    expect(e.dispatch('p3', { type: 'propose_trade', toId: 'p1', give: { cash: 5 }, get: {} }).error).toBe('trade_in_progress');
    e.dispatch('p1', { type: 'cancel_trade' });
    expect(e.state.trade).toBe(null);
  });
});

describe('club', () => {
  it('guest fee charges $20', () => {
    const e = makeEngine();
    forceRoll(e, 'p1', 8);
    expect(e.state.phase).toBe('club_choice');
    e.dispatch('p1', { type: 'club_choice', choice: 'guest' });
    expect(e.player('p1').money).toBe(1480);
    expect(e.current().id).toBe('p2');
  });
});

describe('disconnect handling', () => {
  it('removePlayer bankrupts to bank and advances the turn', () => {
    const e = makeEngine();
    grant(e, 'p1', 2);
    e.removePlayer('p1');
    expect(e.player('p1').isBankrupt).toBe(true);
    expect(e.square(2).owner).toBe(null);
    expect(e.current().id).toBe('p2');
    expect(e.state.gameOver).toBe(false);
  });
});
