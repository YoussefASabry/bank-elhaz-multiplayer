// Bank El Haz — server-authoritative game engine.
// Pure state machine: no sockets, no timers. RNG is injectable so tests are deterministic.
// All player input goes through dispatch(playerId, action) which returns { ok, error?, events }.

export const PRISON_ID = 25;
export const START_ID = 1;
export const BOARD_SIZE = 34;

const BUILD_COST_FACTOR = { 1: 0.5, 2: 0.8, 3: 1.2 }; // garage, rest stop, market
const BUILD_SELL_REFUND = 0.75;
const BANK_SALE_FACTOR = 0.5; // selling a property back to the bank

export const LEVEL_NAMES = ['none', 'garage', 'rest_stop', 'market'];

export class GameEngine {
  constructor({ players, options = {}, rng = Math.random, data }) {
    if (!data) throw new Error('engine requires data: { board, hazak, mahkama }');
    this.rng = rng;
    this.data = data;
    this.options = {
      startingCash: options.startingCash ?? 1500,
      diceCount: options.diceCount ?? 2,
      moneyVisible: options.moneyVisible ?? true,
      turnSeconds: options.turnSeconds ?? 90,
    };
    this.events = [];
    this.initState(players);
  }

  initState(roomPlayers) {
    const squares = this.data.board.board_positions.map(sq =>
      sq.type === 'property'
        ? { ...sq, owner: null, level: 0 }
        : { ...sq }
    );
    const hazak = [...this.data.hazak.hazak];
    const mahkama = [...this.data.mahkama.mahkama];
    this.shuffle(hazak);
    this.shuffle(mahkama);

    this.state = {
      meta: {
        passGoSalary: this.data.board.game_meta.pass_go_salary,
        bailCost: 50,
        ...this.options,
      },
      players: roomPlayers.map(rp => ({
        id: rp.id,
        name: rp.name,
        avatar: rp.avatar || 1,
        position: START_ID,
        money: this.options.startingCash,
        jailFreeCards: 0,
        freeCards: 0,
        inJail: false,
        jailTurns: 0,
        doubleNextRoll: false,
        halfRentNext: false,
        skipNextTurn: false,
        isBankrupt: false,
        connected: true,
      })),
      currentIndex: 0,
      squares,
      decks: { hazak, mahkama, hazakDiscard: [], mahkamaDiscard: [] },
      phase: 'awaiting_roll',
      pending: null,       // phase-specific payload
      trade: null,         // { id, fromId, toId, give, get }
      turn: { rolled: false, lastRoll: null },
      gameOver: false,
      winnerId: null,
      log: [],
    };
  }

  // ── Helpers ──

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  player(id) { return this.state.players.find(p => p.id === id); }
  square(id) { return this.state.squares.find(s => s.id === id); }
  current() { return this.state.players[this.state.currentIndex]; }

  emit(type, payload = {}) { this.events.push({ type, ...payload }); }

  log(msg) {
    this.state.log.push(msg);
    if (this.state.log.length > 200) this.state.log.shift();
    this.emit('log', { message: msg });
  }

  groupSquares(colorGroup) {
    return this.state.squares.filter(s => s.type === 'property' && s.color_group === colorGroup);
  }

  ownsFullGroup(playerId, colorGroup) {
    const group = this.groupSquares(colorGroup);
    return group.length > 0 && group.every(s => s.owner === playerId);
  }

  buildingCost(square, level) {
    return Math.round(square.purchase_price * BUILD_COST_FACTOR[level]);
  }

  netWorth(player) {
    let worth = player.money;
    for (const sq of this.state.squares) {
      if (sq.owner !== player.id) continue;
      worth += Math.round(sq.purchase_price * BANK_SALE_FACTOR);
      for (let l = 1; l <= sq.level; l++) worth += Math.round(this.buildingCost(sq, l) * BUILD_SELL_REFUND);
    }
    return worth;
  }

  // ── Public API ──

  dispatch(playerId, action) {
    this.events = [];
    const player = this.player(playerId);
    if (!player) return this.fail('unknown_player');
    if (this.state.gameOver) return this.fail('game_over');
    if (player.isBankrupt) return this.fail('bankrupt');

    const t = action.type;
    try {
      // Actions available regardless of turn
      switch (t) {
        case 'build': return this.result(this.actBuild(player, action.squareId));
        case 'sell_building': return this.result(this.actSellBuilding(player, action.squareId));
        case 'sell_property': return this.result(this.actSellProperty(player, action.squareId));
        case 'propose_trade': return this.result(this.actProposeTrade(player, action));
        case 'respond_trade': return this.result(this.actRespondTrade(player, action.accept));
        case 'cancel_trade': return this.result(this.actCancelTrade(player));
      }

      // Turn-bound actions
      const isCurrent = this.current()?.id === playerId;
      if (!isCurrent) return this.fail('not_your_turn');

      switch (t) {
        case 'roll': return this.result(this.actRoll(player));
        case 'jail_pay': return this.result(this.actJailPay(player));
        case 'jail_card': return this.result(this.actJailCard(player));
        case 'jail_skip': return this.result(this.actJailSkip(player));
        case 'buy': return this.result(this.actBuy(player));
        case 'decline': return this.result(this.actDecline(player));
        case 'reveal_card': return this.result(this.actRevealCard(player));
        case 'card_choice': return this.result(this.actCardChoice(player, action.index));
        case 'club_choice': return this.result(this.actClubChoice(player, action.choice));
        case 'pay_debt': return this.result(this.actPayDebt(player));
        case 'declare_bankruptcy': return this.result(this.actBankruptcy(player));
        default: return this.fail('unknown_action');
      }
    } catch (err) {
      return { ok: false, error: 'engine_error', detail: err.message, events: this.events };
    }
  }

  result(r) {
    if (r && r.error) return { ok: false, error: r.error, events: this.events };
    return { ok: true, events: this.events };
  }
  fail(error) { return { ok: false, error, events: this.events }; }

  // Called by the room when a timer expires. Resolves the current phase with a safe default.
  autoResolve() {
    this.events = [];
    const gs = this.state;
    if (gs.gameOver) return { ok: true, events: [] };
    const player = this.current();
    if (!player) return { ok: true, events: [] };

    switch (gs.phase) {
      case 'awaiting_roll':
        if (player.inJail) this.actJailSkip(player);
        else { this.actRoll(player); }
        break;
      case 'buy_decision': this.actDecline(player); break;
      case 'card': this.actRevealCard(player); break;
      case 'card_choice': this.actCardChoice(player, 0); break;
      case 'club_choice': this.actClubChoice(player, 'guest'); break;
      case 'debt': {
        const debtor = this.player(gs.pending.debtorId);
        if (debtor.money >= gs.pending.amount) this.actPayDebt(debtor);
        else this.actBankruptcy(debtor);
        break;
      }
      default: break;
    }
    return { ok: true, events: this.events };
  }

  // ── Roll & movement ──

  rollDice() {
    const count = this.state.meta.diceCount;
    const die1 = Math.floor(this.rng() * 6) + 1;
    const die2 = count >= 2 ? Math.floor(this.rng() * 6) + 1 : 0;
    return { die1, die2, total: die1 + die2, isDouble: count >= 2 && die1 === die2 };
  }

  newPosition(pos, steps) {
    return (((pos - 1 + steps) % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE + 1;
  }

  actRoll(player) {
    const gs = this.state;
    if (gs.phase !== 'awaiting_roll') return { error: 'wrong_phase' };
    if (player.inJail) return { error: 'in_jail' };
    if (gs.turn.rolled) return { error: 'already_rolled' };

    const roll = this.rollDice();
    let steps = roll.total;
    if (player.doubleNextRoll) {
      steps *= 2;
      player.doubleNextRoll = false;
      this.log(`🚌 ${player.name} moves double: ${steps} steps`);
    }
    gs.turn.rolled = true;
    gs.turn.lastRoll = roll;

    const oldPos = player.position;
    const path = [];
    let cursor = oldPos;
    for (let i = 0; i < steps; i++) { cursor = this.newPosition(cursor, 1); path.push(cursor); }
    const newPos = path[path.length - 1] ?? oldPos;
    const passedGo = path.includes(START_ID);

    player.position = newPos;
    this.emit('roll', { playerId: player.id, ...roll, steps, oldPos, newPos, path, passedGo });
    this.log(`🎲 ${player.name} rolled ${roll.die1}${roll.die2 ? `+${roll.die2}` : ''} = ${roll.total}`);

    if (passedGo) {
      player.money += gs.meta.passGoSalary;
      this.emit('salary', { playerId: player.id, amount: gs.meta.passGoSalary });
      this.log(`💵 ${player.name} collected $${gs.meta.passGoSalary} salary`);
    }
    this.evaluateLanding(player);
  }

  evaluateLanding(player) {
    const sq = this.square(player.position);
    if (!sq) return this.endTurn();
    switch (sq.type) {
      case 'property': return this.landProperty(player, sq);
      case 'deck_trigger': return this.landDeck(player, sq, sq.deck_type || 'hazak');
      case 'dual_deck_trigger': return this.landDeck(player, sq, 'dual');
      case 'corner_square': return this.landCorner(player, sq);
      default: return this.endTurn();
    }
  }

  landProperty(player, sq) {
    const gs = this.state;
    if (sq.owner === null) {
      gs.phase = 'buy_decision';
      gs.pending = { squareId: sq.id, playerId: player.id, price: sq.purchase_price };
      this.emit('buy_decision', { playerId: player.id, squareId: sq.id, price: sq.purchase_price, canAfford: player.money >= sq.purchase_price });
      return;
    }
    if (sq.owner === player.id) return this.endTurn();
    const owner = this.player(sq.owner);
    if (!owner || owner.isBankrupt) return this.endTurn();

    let rent = this.calculateRent(sq);
    if (player.halfRentNext) {
      rent = Math.ceil(rent / 2);
      player.halfRentNext = false;
      this.log(`🎫 ${player.name} pays only half rent`);
    }
    this.emit('rent_due', { playerId: player.id, ownerId: owner.id, squareId: sq.id, amount: rent });
    this.charge(player, rent, owner.id, `rent for ${sq.name}`, () => this.endTurn());
  }

  calculateRent(sq) {
    if (sq.color_group === 'utility' || !sq.visitor_paying) return sq.base_rent;
    if (sq.level >= 3) return sq.visitor_paying.market_rent;
    if (sq.level === 2) return sq.visitor_paying.rest_stop_rent;
    if (sq.level === 1) return sq.visitor_paying.garage_rent;
    // Full unimproved color set → double base rent
    const fullSet = this.ownsFullGroup(sq.owner, sq.color_group);
    return fullSet ? sq.base_rent * 2 : sq.base_rent;
  }

  landDeck(player, sq, deckType) {
    const gs = this.state;
    if (deckType === 'dual') {
      const card = this.drawCard('mahkama');
      if (!card) return this.endTurn();
      gs.phase = 'card';
      gs.pending = { card, deckType: 'mahkama', playerId: player.id, squareName: sq.name, second: 'hazak' };
    } else {
      const card = this.drawCard(deckType);
      if (!card) return this.endTurn();
      gs.phase = 'card';
      gs.pending = { card, deckType, playerId: player.id, squareName: sq.name, second: null };
    }
    this.emit('card_drawn', { playerId: player.id, deckType: gs.pending.deckType, card: gs.pending.card, squareName: sq.name });
  }

  landCorner(player, sq) {
    const gs = this.state;
    switch (sq.id) {
      case START_ID:
        return this.endTurn(); // salary already granted while passing
      case 8:
        gs.phase = 'club_choice';
        gs.pending = { playerId: player.id, membershipCost: sq.membership_cost, guestFee: sq.guest_fine_fee };
        this.emit('club_choice', { playerId: player.id, ...gs.pending });
        return;
      case 18:
        player.doubleNextRoll = true;
        this.log(`🚌 ${player.name} boards the fast bus — next roll is doubled!`);
        this.emit('fast_bus', { playerId: player.id });
        return this.endTurn();
      case PRISON_ID:
        this.sendToJail(player);
        return this.endTurn();
      default:
        return this.endTurn();
    }
  }

  sendToJail(player) {
    const sq = this.square(PRISON_ID);
    player.position = PRISON_ID;
    player.inJail = true;
    player.jailTurns = sq?.rules?.max_turns_to_miss ?? 2;
    this.emit('jailed', { playerId: player.id });
    this.log(`🔒 ${player.name} goes to prison`);
  }

  // ── Buying / auction ──

  actBuy(player) {
    const gs = this.state;
    if (gs.phase !== 'buy_decision') return { error: 'wrong_phase' };
    const sq = this.square(gs.pending.squareId);
    if (player.money < sq.purchase_price) return { error: 'insufficient_funds' };
    player.money -= sq.purchase_price;
    sq.owner = player.id;
    gs.pending = null;
    this.emit('property_bought', { playerId: player.id, squareId: sq.id, price: sq.purchase_price });
    this.log(`🏠 ${player.name} bought ${sq.name} for $${sq.purchase_price}`);
    this.endTurn();
  }

  actDecline(player) {
    const gs = this.state;
    if (gs.phase !== 'buy_decision') return { error: 'wrong_phase' };
    const sq = this.square(gs.pending.squareId);
    gs.pending = null;
    this.emit('property_declined', { playerId: player.id, squareId: sq.id });
    this.log(`🚫 ${player.name} declined ${sq.name}`);
    this.endTurn();
  }

  // ── Cards ──

  drawCard(deckType) {
    const d = this.state.decks;
    const deck = deckType === 'mahkama' ? d.mahkama : d.hazak;
    const discard = deckType === 'mahkama' ? d.mahkamaDiscard : d.hazakDiscard;
    if (deck.length === 0) {
      deck.push(...discard.splice(0));
      this.shuffle(deck);
      if (deck.length === 0) return null;
    }
    return deck.pop();
  }

  discard(card, deckType) {
    const d = this.state.decks;
    (deckType === 'mahkama' ? d.mahkamaDiscard : d.hazakDiscard).push(card);
  }

  actRevealCard(player) {
    const gs = this.state;
    if (gs.phase !== 'card') return { error: 'wrong_phase' };
    const { card, deckType, second, squareName } = gs.pending;
    gs.pending = null;
    gs.phase = 'resolving';
    this.applyCard(card, deckType, player, () => {
      // After the first (mahkama) card of a dual square, draw the hazak card
      if (second && !gs.gameOver && !player.isBankrupt) {
        const card2 = this.drawCard(second);
        if (card2) {
          gs.phase = 'card';
          gs.pending = { card: card2, deckType: second, playerId: player.id, squareName, second: null };
          this.emit('card_drawn', { playerId: player.id, deckType: second, card: card2, squareName });
          return;
        }
      }
      this.endTurn();
    });
  }

  // Applies a card. `done` is invoked when the card fully resolves without needing input.
  // If the card opens a choice or a debt, `done` is stored and called after resolution.
  applyCard(card, deckType, player, done) {
    const gs = this.state;
    this.log(`🃏 ${player.name}: ${card.description}`);

    const finish = () => { this.discard(card, deckType); done(); };

    switch (card.action) {
      case 'collect_from_players': {
        let total = 0;
        for (const p of gs.players) {
          if (p.id === player.id || p.isBankrupt) continue;
          const amt = Math.min(card.players_money, p.money);
          p.money -= amt; total += amt;
        }
        player.money += total;
        this.emit('money', { playerId: player.id, delta: total });
        return finish();
      }
      case 'receive_bank':
        player.money += card.bank_money;
        this.emit('money', { playerId: player.id, delta: card.bank_money });
        return finish();
      case 'pay_bank':
        this.discard(card, deckType);
        return this.charge(player, -card.bank_money, null, 'court fine', done);
      case 'go_to_jail':
        this.sendToJail(player);
        return finish();
      case 'receive_jail_free_card':
        player.jailFreeCards += card.jail_free_card || 1;
        return finish();
      case 'bank_pays_per_building': {
        const count = gs.squares.filter(s => s.owner === player.id).reduce((t, s) => t + (s.level || 0), 0);
        const amount = count * (card.per_building_amount || 25);
        player.money += amount;
        this.emit('money', { playerId: player.id, delta: amount });
        this.log(`🏗️ Bank pays ${player.name} $${amount} for ${count} buildings`);
        return finish();
      }
      case 'pay_repairs': {
        const costs = card.repair_costs || { market: 100, rest_stop: 50, garage: 25 };
        let total = 0;
        for (const s of gs.squares) {
          if (s.owner !== player.id) continue;
          for (let l = 1; l <= (s.level || 0); l++) total += costs[LEVEL_NAMES[l]] || 0;
        }
        this.discard(card, deckType);
        if (total === 0) return done();
        this.log(`🔧 ${player.name} owes $${total} in repairs`);
        return this.charge(player, total, null, 'repairs', done);
      }
      case 'collect_from_city_owners': {
        const owned = gs.squares.filter(s => s.type === 'property' && s.owner && s.owner !== player.id);
        this.shuffle(owned);
        const cities = owned.slice(0, Math.min(card.city_count || 3, owned.length));
        let total = 0;
        for (const city of cities) {
          const owner = this.player(city.owner);
          if (!owner || owner.isBankrupt) continue;
          const amt = Math.min(card.amount_per_city || 50, owner.money);
          owner.money -= amt; total += amt;
        }
        player.money += total;
        this.emit('city_owners_card', { playerId: player.id, cities: cities.map(c => ({ id: c.id, name: c.name })), total });
        this.log(`🏙️ ${player.name} collected $${total} from city owners (${cities.map(c => c.name).join('، ') || 'none'})`);
        return finish();
      }
      case 'skip_turn_and_pay':
        player.skipNextTurn = true;
        this.discard(card, deckType);
        return this.charge(player, -card.bank_money, null, 'detention fine', done);
      case 'choice':
        return this.openMahkamaChoice(card, deckType, player, done);
      default:
        return this.applyHazakCard(card, deckType, player, done);
    }
  }

  applyHazakCard(card, deckType, player, done) {
    const gs = this.state;
    const hasRealChoice = card.choices?.some(c => c.action_type);

    const applyBase = (after) => {
      if (card.players_money > 0) {
        let total = 0;
        for (const p of gs.players) {
          if (p.id === player.id || p.isBankrupt) continue;
          const amt = Math.min(card.players_money, p.money);
          p.money -= amt; total += amt;
        }
        player.money += total;
        this.emit('money', { playerId: player.id, delta: total });
      }
      if (card.free_card > 0) player.freeCards += card.free_card;
      if (card.no_prison_card > 0) player.jailFreeCards += card.no_prison_card;
      if (card.half_price) player.halfRentNext = true;

      const move = () => {
        if (card.move_to > 0 && !hasRealChoice) return this.teleport(player, card.move_to, after);
        if (card.squares_to_move && !hasRealChoice) {
          const dest = this.newPosition(player.position, card.squares_to_move);
          return this.teleport(player, dest, after, card.squares_to_move > 0);
        }
        after();
      };

      if (card.bank_money < 0) {
        return this.charge(player, -card.bank_money, null, 'hazak card', move);
      }
      if (card.bank_money > 0) {
        player.money += card.bank_money;
        this.emit('money', { playerId: player.id, delta: card.bank_money });
      }
      move();
    };

    if (!hasRealChoice) {
      return applyBase(() => { this.discard(card, deckType); done(); });
    }

    // Cards with choices: apply base money first, then open the choice
    applyBase(() => this.openHazakChoice(card, deckType, player, done));
  }

  teleport(player, dest, done, viaGo = null) {
    const gs = this.state;
    const passedGo = dest === START_ID || (viaGo !== false && dest < player.position && viaGo === true);
    player.position = dest;
    this.emit('teleport', { playerId: player.id, to: dest });
    if (dest === START_ID || passedGo && viaGo) {
      player.money += gs.meta.passGoSalary;
      this.emit('salary', { playerId: player.id, amount: gs.meta.passGoSalary });
    }
    // Landing on the new square still applies (rent, cards, corners)
    this.evaluateLandingAfterCard(player, done);
  }

  evaluateLandingAfterCard(player, done) {
    const sq = this.square(player.position);
    if (!sq) return done();
    if (sq.type === 'property') {
      const gs = this.state;
      if (sq.owner && sq.owner !== player.id) {
        const owner = this.player(sq.owner);
        if (owner && !owner.isBankrupt) {
          let rent = this.calculateRent(sq);
          if (player.halfRentNext) { rent = Math.ceil(rent / 2); player.halfRentNext = false; }
          this.emit('rent_due', { playerId: player.id, ownerId: owner.id, squareId: sq.id, amount: rent });
          return this.charge(player, rent, owner.id, `rent for ${sq.name}`, done);
        }
      } else if (sq.owner === null) {
        this.state.phase = 'buy_decision';
        this.state.pending = { squareId: sq.id, playerId: player.id, price: sq.purchase_price };
        this.emit('buy_decision', { playerId: player.id, squareId: sq.id, price: sq.purchase_price, canAfford: player.money >= sq.purchase_price });
        return; // buy/decline path ends the turn itself
      }
      return done();
    }
    if (sq.type === 'corner_square' && sq.id === PRISON_ID) {
      this.sendToJail(player);
      return done();
    }
    if (sq.type === 'corner_square' && sq.id === 18) {
      player.doubleNextRoll = true;
      return done();
    }
    if (sq.type === 'corner_square' && sq.id === 8) {
      this.state.phase = 'club_choice';
      this.state.pending = { playerId: player.id, membershipCost: sq.membership_cost, guestFee: sq.guest_fine_fee, done };
      this.emit('club_choice', { playerId: player.id, membershipCost: sq.membership_cost, guestFee: sq.guest_fine_fee });
      return;
    }
    // Deck squares do NOT chain another draw after a teleport (avoids infinite loops)
    return done();
  }

  openMahkamaChoice(card, deckType, player, done) {
    const gs = this.state;
    if (card.id === 11) {
      const maxPrice = card.choices.find(c => c.max_price)?.max_price || 150;
      const cashAmt = card.choices.find(c => c.action_type === 'receive_cash')?.amount || 100;
      const available = gs.squares.filter(s => s.type === 'property' && s.owner === null && s.purchase_price <= maxPrice);
      if (available.length === 0) {
        player.money += cashAmt;
        this.emit('money', { playerId: player.id, delta: cashAmt });
        this.discard(card, deckType);
        return done();
      }
      gs.phase = 'card_choice';
      gs.pending = {
        playerId: player.id, card, deckType, done,
        title: card.description,
        options: [
          { action: 'cash', label: `💰 خذ ${cashAmt} جنيه من البنك`, amount: cashAmt },
          ...available.map(s => ({ action: 'claim_property', label: `🏙️ ${s.name} ($${s.purchase_price})`, squareId: s.id })),
        ],
      };
      this.emit('card_choice', { playerId: player.id, title: card.description, options: gs.pending.options });
      return;
    }
    if (card.id === 15) {
      const fine = card.choices.find(c => c.action_type === 'pay_fine')?.amount || 100;
      gs.phase = 'card_choice';
      gs.pending = {
        playerId: player.id, card, deckType, done,
        title: card.description,
        options: [
          { action: 'pay_fine', label: `💰 ادفع ${fine} جنيه غرامة`, amount: fine },
          { action: 'go_to_prison', label: '🔒 اذهب للسجن' },
        ],
      };
      this.emit('card_choice', { playerId: player.id, title: card.description, options: gs.pending.options });
      return;
    }
    this.discard(card, deckType);
    done();
  }

  openHazakChoice(card, deckType, player, done) {
    const gs = this.state;
    const choice = card.choices.find(c => c.action_type);

    if (choice.action_type === 'move_to_dynamic_pool') {
      const props = gs.squares.filter(s => s.type === 'property');
      this.shuffle(props);
      const pool = props.slice(0, choice.selection_count || 3);
      gs.phase = 'card_choice';
      gs.pending = {
        playerId: player.id, card, deckType, done,
        title: card.description,
        options: pool.map(s => ({ action: 'goto', label: `🏙️ ${s.name}`, squareId: s.id })),
      };
      this.emit('card_choice', { playerId: player.id, title: card.description, options: gs.pending.options });
      return;
    }

    if (choice.action_type === 'claim_free_property' || card.choices.some(c => c.action_type === 'claim_free_property')) {
      const cashOpt = card.choices.find(c => c.action_type === 'receive_cash');
      const propOpt = card.choices.find(c => c.action_type === 'claim_free_property');
      const cashAmt = cashOpt?.amount || 150;
      const available = (propOpt?.pool_options || [])
        .map(id => this.square(id))
        .filter(s => s && (propOpt.unowned_only === false || s.owner === null));
      if (available.length === 0) {
        player.money += cashAmt;
        this.emit('money', { playerId: player.id, delta: cashAmt });
        this.discard(card, deckType);
        return done();
      }
      gs.phase = 'card_choice';
      gs.pending = {
        playerId: player.id, card, deckType, done,
        title: card.description,
        options: [
          { action: 'cash', label: `💰 خذ ${cashAmt} جنيه`, amount: cashAmt },
          ...available.map(s => ({ action: 'claim_property', label: `🏙️ ${s.name} ($${s.purchase_price})`, squareId: s.id })),
        ],
      };
      this.emit('card_choice', { playerId: player.id, title: card.description, options: gs.pending.options });
      return;
    }

    this.discard(card, deckType);
    done();
  }

  actCardChoice(player, index) {
    const gs = this.state;
    if (gs.phase !== 'card_choice') return { error: 'wrong_phase' };
    if (gs.pending.playerId !== player.id) return { error: 'not_your_choice' };
    const { card, deckType, options, done } = gs.pending;
    const chosen = options[index];
    if (!chosen) return { error: 'invalid_choice' };
    gs.pending = null;
    gs.phase = 'resolving';
    this.discard(card, deckType);
    this.log(`⚖️ ${player.name} chose: ${chosen.label}`);

    switch (chosen.action) {
      case 'cash':
        player.money += chosen.amount;
        this.emit('money', { playerId: player.id, delta: chosen.amount });
        return done();
      case 'claim_property': {
        const sq = this.square(chosen.squareId);
        if (sq && sq.owner === null) sq.owner = player.id;
        this.emit('property_bought', { playerId: player.id, squareId: chosen.squareId, price: 0 });
        return done();
      }
      case 'pay_fine':
        return this.charge(player, chosen.amount, null, 'court fine', done);
      case 'go_to_prison':
        this.sendToJail(player);
        return done();
      case 'goto':
        return this.teleport(player, chosen.squareId, done, true);
      default:
        return done();
    }
  }

  // ── Club ──

  actClubChoice(player, choice) {
    const gs = this.state;
    if (gs.phase !== 'club_choice') return { error: 'wrong_phase' };
    const { membershipCost, guestFee, done } = gs.pending;
    gs.pending = null;
    gs.phase = 'resolving';
    const cost = choice === 'membership' ? membershipCost : guestFee;
    this.log(`🎰 ${player.name} ${choice === 'membership' ? `bought club membership ($${cost})` : `paid guest fee ($${cost})`}`);
    this.charge(player, cost, null, 'club', done || (() => this.endTurn()));
  }

  // ── Money / debt ──

  // Charge `amount` from player. If they can't afford it, opens the debt phase;
  // `done` runs after full payment (possibly later) or bankruptcy resolution.
  charge(player, amount, creditorId, reason, done) {
    const gs = this.state;
    amount = Math.max(0, Math.round(amount));
    if (amount === 0) return done();
    if (player.money >= amount) {
      player.money -= amount;
      if (creditorId) {
        const creditor = this.player(creditorId);
        if (creditor && !creditor.isBankrupt) creditor.money += amount;
      }
      this.emit('paid', { playerId: player.id, creditorId, amount, reason });
      this.log(`💸 ${player.name} paid $${amount} (${reason})`);
      return done();
    }
    // Can they possibly raise the money?
    if (this.netWorth(player) < amount) {
      this.emit('debt', { playerId: player.id, creditorId, amount, reason, hopeless: true });
      return this.executeBankruptcy(player, creditorId, done);
    }
    gs.phase = 'debt';
    gs.pending = { debtorId: player.id, creditorId, amount, reason, done };
    this.emit('debt', { playerId: player.id, creditorId, amount, reason, hopeless: false });
    this.log(`⚠️ ${player.name} owes $${amount} (${reason}) — must raise funds or go bankrupt`);
  }

  actPayDebt(player) {
    const gs = this.state;
    if (gs.phase !== 'debt') return { error: 'wrong_phase' };
    const { debtorId, creditorId, amount, reason, done } = gs.pending;
    if (player.id !== debtorId) return { error: 'not_your_debt' };
    if (player.money < amount) return { error: 'insufficient_funds' };
    gs.pending = null;
    gs.phase = 'resolving';
    player.money -= amount;
    if (creditorId) {
      const creditor = this.player(creditorId);
      if (creditor && !creditor.isBankrupt) creditor.money += amount;
    }
    this.emit('paid', { playerId: player.id, creditorId, amount, reason });
    this.log(`💸 ${player.name} paid off the $${amount} debt`);
    done();
  }

  actBankruptcy(player) {
    const gs = this.state;
    if (gs.phase !== 'debt') return { error: 'wrong_phase' };
    if (gs.pending.debtorId !== player.id) return { error: 'not_your_debt' };
    const { creditorId, done } = gs.pending;
    gs.pending = null;
    gs.phase = 'resolving';
    this.executeBankruptcy(player, creditorId, done);
  }

  executeBankruptcy(player, creditorId, done) {
    const gs = this.state;
    const creditor = creditorId ? this.player(creditorId) : null;
    this.log(`💀 ${player.name} is bankrupt!`);

    if (creditor && !creditor.isBankrupt) {
      creditor.money += Math.max(0, player.money);
      creditor.jailFreeCards += player.jailFreeCards;
      for (const sq of gs.squares) {
        if (sq.owner === player.id) sq.owner = creditor.id; // buildings carry over
      }
      this.log(`📦 ${player.name}'s assets go to ${creditor.name}`);
    } else {
      for (const sq of gs.squares) {
        if (sq.owner === player.id) { sq.owner = null; sq.level = 0; }
      }
      this.log(`📦 ${player.name}'s properties return to the bank`);
    }
    player.money = 0;
    player.jailFreeCards = 0;
    player.isBankrupt = true;
    this.emit('bankrupt', { playerId: player.id, creditorId: creditor?.id || null });

    // Cancel any trade involving them
    if (gs.trade && (gs.trade.fromId === player.id || gs.trade.toId === player.id)) gs.trade = null;

    if (this.checkGameOver()) return;
    if (this.current()?.id === player.id) return this.endTurn();
    done();
  }

  checkGameOver() {
    const gs = this.state;
    const alive = gs.players.filter(p => !p.isBankrupt);
    if (alive.length <= 1) {
      gs.gameOver = true;
      gs.phase = 'game_over';
      gs.winnerId = alive[0]?.id || null;
      gs.pending = null;
      this.emit('game_over', { winnerId: gs.winnerId });
      if (alive[0]) this.log(`🏆 ${alive[0].name} wins the game!`);
      return true;
    }
    return false;
  }

  // ── Build / mortgage / sell ──

  actBuild(player, squareId) {
    const sq = this.square(squareId);
    if (!sq || sq.type !== 'property') return { error: 'not_property' };
    if (sq.owner !== player.id) return { error: 'not_owner' };
    if (sq.color_group === 'utility') return { error: 'cannot_build_here' };
    if (sq.level >= 3) return { error: 'max_level' };
    if (!this.ownsFullGroup(player.id, sq.color_group)) return { error: 'need_full_set' };
    const group = this.groupSquares(sq.color_group);
    // Build evenly across the set
    const minLevel = Math.min(...group.map(s => s.level));
    if (sq.level > minLevel) return { error: 'build_evenly' };
    const cost = this.buildingCost(sq, sq.level + 1);
    if (player.money < cost) return { error: 'insufficient_funds' };
    player.money -= cost;
    sq.level++;
    this.emit('built', { playerId: player.id, squareId: sq.id, level: sq.level, cost });
    this.log(`🏗️ ${player.name} built a ${LEVEL_NAMES[sq.level]} on ${sq.name} ($${cost})`);
  }

  actSellBuilding(player, squareId) {
    const sq = this.square(squareId);
    if (!sq || sq.owner !== player.id) return { error: 'not_owner' };
    if (!sq.level) return { error: 'no_buildings' };
    const group = this.groupSquares(sq.color_group);
    const maxLevel = Math.max(...group.map(s => s.level));
    if (sq.level < maxLevel) return { error: 'sell_evenly' };
    const refund = Math.round(this.buildingCost(sq, sq.level) * BUILD_SELL_REFUND);
    sq.level--;
    player.money += refund;
    this.emit('building_sold', { playerId: player.id, squareId: sq.id, level: sq.level, refund });
    this.log(`🏚️ ${player.name} sold a building on ${sq.name} (+$${refund})`);
  }

  actSellProperty(player, squareId) {
    const sq = this.square(squareId);
    if (!sq || sq.owner !== player.id) return { error: 'not_owner' };
    if (sq.level > 0) return { error: 'has_buildings' };
    const value = Math.round(sq.purchase_price * BANK_SALE_FACTOR);
    sq.owner = null;
    player.money += value;
    this.emit('property_sold', { playerId: player.id, squareId: sq.id, value });
    this.log(`🏚️ ${player.name} sold ${sq.name} to the bank (+$${value})`);
  }

  // ── Jail ──

  actJailPay(player) {
    if (!player.inJail) return { error: 'not_in_jail' };
    const bail = this.state.meta.bailCost;
    if (player.money < bail) return { error: 'insufficient_funds' };
    player.money -= bail;
    player.inJail = false;
    player.jailTurns = 0;
    this.emit('jail_freed', { playerId: player.id, how: 'bail' });
    this.log(`🔓 ${player.name} paid $${bail} bail`);
  }

  actJailCard(player) {
    if (!player.inJail) return { error: 'not_in_jail' };
    if (player.jailFreeCards <= 0) return { error: 'no_card' };
    player.jailFreeCards--;
    player.inJail = false;
    player.jailTurns = 0;
    this.emit('jail_freed', { playerId: player.id, how: 'card' });
    this.log(`🔓 ${player.name} used a jail-free card`);
  }

  actJailSkip(player) {
    if (!player.inJail) return { error: 'not_in_jail' };
    if (this.state.phase !== 'awaiting_roll') return { error: 'wrong_phase' };
    player.jailTurns--;
    this.log(`⏭️ ${player.name} waits in prison (${player.jailTurns} turns left)`);
    if (player.jailTurns <= 0) {
      player.inJail = false;
      this.emit('jail_freed', { playerId: player.id, how: 'served' });
    }
    this.state.turn.lastRoll = null;
    this.endTurn();
  }

  // ── Trade ──

  actProposeTrade(player, { toId, give = {}, get = {} }) {
    const gs = this.state;
    if (gs.trade) return { error: 'trade_in_progress' };
    const target = this.player(toId);
    if (!target || target.isBankrupt || target.id === player.id) return { error: 'invalid_target' };

    const clean = (side, owner) => ({
      cash: Math.max(0, Math.min(Math.floor(side.cash || 0), owner.money)),
      props: (side.props || []).filter(id => {
        const sq = this.square(id);
        return sq && sq.owner === owner.id && sq.level === 0;
      }),
      jailCards: Math.max(0, Math.min(Math.floor(side.jailCards || 0), owner.jailFreeCards)),
    });

    const giveC = clean(give, player);
    const getC = clean(get, target);
    if (giveC.cash === 0 && giveC.props.length === 0 && giveC.jailCards === 0 &&
        getC.cash === 0 && getC.props.length === 0 && getC.jailCards === 0) {
      return { error: 'empty_trade' };
    }

    gs.trade = { id: `${player.id}-${gs.log.length}`, fromId: player.id, toId, give: giveC, get: getC };
    this.emit('trade_proposed', { trade: gs.trade });
    this.log(`🤝 ${player.name} proposed a trade to ${target.name}`);
  }

  actRespondTrade(player, accept) {
    const gs = this.state;
    const tr = gs.trade;
    if (!tr) return { error: 'no_trade' };
    if (tr.toId !== player.id) return { error: 'not_your_trade' };
    gs.trade = null;
    if (!accept) {
      this.emit('trade_declined', { fromId: tr.fromId, toId: tr.toId });
      this.log(`❌ ${player.name} declined the trade`);
      return;
    }
    const from = this.player(tr.fromId);
    const to = this.player(tr.toId);
    // Re-validate everything at execution time
    if (from.isBankrupt || to.isBankrupt) return { error: 'trade_invalid' };
    if (from.money < tr.give.cash || to.money < tr.get.cash) return { error: 'trade_invalid' };
    if (from.jailFreeCards < tr.give.jailCards || to.jailFreeCards < tr.get.jailCards) return { error: 'trade_invalid' };
    for (const id of tr.give.props) { const s = this.square(id); if (!s || s.owner !== from.id || s.level > 0) return { error: 'trade_invalid' }; }
    for (const id of tr.get.props) { const s = this.square(id); if (!s || s.owner !== to.id || s.level > 0) return { error: 'trade_invalid' }; }

    from.money += tr.get.cash - tr.give.cash;
    to.money += tr.give.cash - tr.get.cash;
    from.jailFreeCards += tr.get.jailCards - tr.give.jailCards;
    to.jailFreeCards += tr.give.jailCards - tr.get.jailCards;
    for (const id of tr.give.props) this.square(id).owner = to.id;
    for (const id of tr.get.props) this.square(id).owner = from.id;

    this.emit('trade_executed', { fromId: from.id, toId: to.id, give: tr.give, get: tr.get });
    this.log(`🤝 Trade executed: ${from.name} ⇄ ${to.name}`);
  }

  actCancelTrade(player) {
    const gs = this.state;
    if (!gs.trade) return { error: 'no_trade' };
    if (gs.trade.fromId !== player.id && gs.trade.toId !== player.id) return { error: 'not_your_trade' };
    gs.trade = null;
    this.emit('trade_cancelled', {});
    this.log(`🚫 Trade cancelled`);
  }

  // ── Turn flow ──

  endTurn() {
    const gs = this.state;
    if (gs.gameOver) return;
    this.advanceTurn();
  }

  advanceTurn() {
    const gs = this.state;
    if (this.checkGameOver()) return;
    let guard = 0;
    do {
      gs.currentIndex = (gs.currentIndex + 1) % gs.players.length;
      guard++;
      const next = gs.players[gs.currentIndex];
      if (next.isBankrupt) continue;
      if (next.skipNextTurn) {
        next.skipNextTurn = false;
        this.log(`⏭️ ${next.name}'s turn is skipped`);
        continue;
      }
      break;
    } while (guard < gs.players.length * 2);

    gs.phase = 'awaiting_roll';
    gs.pending = null;
    gs.turn = { rolled: false, lastRoll: null };
    this.emit('turn_started', { playerId: this.current().id });
  }

  // Player left permanently → treat as bankruptcy to the bank
  removePlayer(playerId) {
    this.events = [];
    const player = this.player(playerId);
    if (!player || player.isBankrupt || this.state.gameOver) return { ok: true, events: this.events };
    const gs = this.state;
    // If mid-phase on their turn, clear it
    if (this.current()?.id === playerId) { gs.pending = null; }
    if (gs.pending?.debtorId === playerId) { gs.pending = null; }
    this.executeBankruptcy(player, null, () => {
      if (!gs.gameOver && this.current()?.id === playerId) this.advanceTurn();
    });
    if (!gs.gameOver && this.current()?.id === playerId) this.advanceTurn();
    return { ok: true, events: this.events };
  }
}
