import boardData from './board.json' with { type: 'json' };
import hazakData from './hazak.json' with { type: 'json' };
import mahkamaData from './mahkama.json' with { type: 'json' };

let callbacks = { log: [] };

export function setLogCallback(fn) {
  callbacks.log.push(fn);
}

function log(...args) {
  const msg = args.join(' ');
  callbacks.log.forEach(fn => fn(msg));
}

export class GameEngine {
  constructor(roomPlayers, options) {
    this.roomPlayers = roomPlayers;
    this.options = options || { startingCash: 1500, diceCount: 2, moneyVisible: true };
    this.state = null;
    this.logs = [];
  }

  initGame() {
    const opts = this.options;
    const boardSquares = boardData.board_positions.map(sq => {
      if (sq.type === 'property') {
        return { ...sq, owner: null, upgrade: null };
      }
      return { ...sq };
    });

    const hazakDeck = [...hazakData.hazak];
    this.shuffle(hazakDeck);

    const mahkamaDeck = [...mahkamaData.mahkama];
    this.shuffle(mahkamaDeck);

    const cash = opts.startingCash || 1500;
    const players = this.roomPlayers.map((rp, i) => ({
      id: rp.id,
      name: rp.name,
      avatar: rp.avatar || 1,
      connected: rp.connected !== false,
      position: 1,
      money: cash,
      isHuman: true,
      inventory: { freeCards: 0, getOutofPrisonCards: 0, jailFreeCards: 0 },
      isClubMember: false,
      statusEffects: { payHalfRentNextLanding: false, doubleNextRoll: false, missedTurnsRemaining: 0, skipNextTurn: false },
      isBankrupt: false,
      _prevMoney: cash,
    }));

    this.state = {
      gameMeta: {
        maxPlayers: boardData.game_meta.max_players,
        passGoSalary: opts.passGoSalary || 250,
        diceCount: opts.diceCount || 2,
        moneyVisible: opts.moneyVisible !== false,
      },
      players,
      currentPlayerIndex: 0,
      boardSquares,
      hazakDeck,
      mahkamaDeck,
      mahkamaDiscard: [],
      hazakDiscard: [],
      activeCardChoice: null,
      pendingPropertyBuy: null,
      pendingRentPayment: null,
      lastRoll: null,
      phase: 'roll',
      isLiquidating: false,
      gameOver: false,
      turnLog: [],
      timerSeconds: 90,
      timerRunning: false,
      blindCard: null,
      pendingSecondCard: false,
      pendingClubChoice: null,
      pendingUpgradeChoice: null,
      activeBids: [],
      tradeProposal: null,
      tradeConfirmations: {},
      pendingCityOwnersCard: null,
    };
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  // ── Dice ──

  rollDice() {
    const count = this.options.diceCount || 2;
    const d1 = Math.floor(Math.random() * 6) + 1;
    let d2 = 0;
    if (count >= 2) {
      d2 = Math.floor(Math.random() * 6) + 1;
    }
    return { die1: d1, die2: d2, total: d1 + d2, isDouble: count >= 2 && d1 === d2 };
  }

  calculateNewPosition(current, steps) {
    return ((current - 1 + steps) % 34 + 34) % 34 + 1;
  }

  didPassGo(oldPos, newPos) {
    return newPos < oldPos;
  }

  computeRoll(playerId) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.isBankrupt) return null;

    // Test mode: force landing on special squares (deck_trigger, dual_deck_trigger, corner_square with effect)
    if (this.options.testMode) {
      return this.computeTestRoll(playerId);
    }

    const { die1, die2, total, isDouble } = this.rollDice();
    let steps = total;
    if (player.statusEffects.doubleNextRoll) {
      steps *= 2;
      player.statusEffects.doubleNextRoll = false;
    }

    const oldPos = player.position;
    const newPos = this.calculateNewPosition(oldPos, steps);
    const passedGo = this.didPassGo(oldPos, newPos);

    const path = [];
    let cursor = oldPos;
    for (let i = 0; i < steps; i++) {
      cursor = this.calculateNewPosition(cursor, 1);
      path.push(cursor);
    }

    return { die1, die2, total, isDouble, oldPos, newPos, steps, passedGo, path, playerId };
  }

  computeTestRoll(playerId) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.isBankrupt) return null;

    const SPECIAL_IDS = new Set([4, 8, 11, 13, 18, 21, 25, 30, 32]);
    const oldPos = player.position;
    let targetPos = oldPos;
    let steps = 0;

    // Find the nearest special square ahead (up to 12 steps)
    for (let s = 1; s <= 12; s++) {
      const pos = this.calculateNewPosition(oldPos, s);
      if (SPECIAL_IDS.has(pos)) {
        targetPos = pos;
        steps = s;
        break;
      }
    }

    // If no special square found within 12 steps, wrap around and find the first one
    if (steps === 0) {
      for (let s = 1; s <= 34; s++) {
        const pos = this.calculateNewPosition(oldPos, s);
        if (SPECIAL_IDS.has(pos)) {
          targetPos = pos;
          steps = s;
          break;
        }
      }
    }

    const passedGo = this.didPassGo(oldPos, targetPos);

    // Create a roll that lands exactly on the target
    const die1 = Math.min(steps, 6);
    const die2 = steps - die1 > 0 ? steps - die1 : 0;
    const isDouble = die1 === die2;

    const path = [];
    let cursor = oldPos;
    for (let i = 0; i < steps; i++) {
      cursor = this.calculateNewPosition(cursor, 1);
      path.push(cursor);
    }

    return { die1, die2, total: steps, isDouble, oldPos, newPos: targetPos, steps, passedGo, path, playerId };
  }

  // ── Landing ──

  evaluateLanding(player) {
    const gs = this.state;
    const landedSquare = gs.boardSquares.find(s => s.id === player.position);
    if (!landedSquare) {
      this.finishTurn();
      return;
    }

    switch (landedSquare.type) {
      case 'property':
        this.handlePropertyLanding(player, landedSquare);
        break;
      case 'deck_trigger':
      case 'dual_deck_trigger':
        this.handleDeckTrigger(player, landedSquare);
        break;
      case 'corner_square':
        this.handleCornerSquare(player, landedSquare);
        break;
      default:
        this.finishTurn();
    }
  }

  handlePropertyLanding(player, square) {
    const gs = this.state;
    if (square.owner === null) {
      if (player.money >= square.purchase_price) {
        gs.pendingPropertyBuy = { square, playerId: player.id };
        gs.phase = 'property_choice';
      } else {
        this.finishTurn();
      }
    } else if (square.owner === player.id) {
      const upgradesAvail = this.getUpgradeOptions(player, square);
      if (upgradesAvail.length > 0) {
        gs.pendingUpgradeChoice = { square, playerId: player.id, options: upgradesAvail };
        gs.phase = 'upgrade_choice';
      } else {
        this.finishTurn();
      }
    } else {
      const owner = gs.players.find(p => p.id === square.owner);
      const rent = this.calculateRent(square, player);
      gs.pendingRentPayment = { playerId: player.id, ownerId: owner?.id, amount: rent, squareName: square.name };
      gs.phase = 'rent_payment';
    }
  }

  getUpgradeOptions(player, square) {
    if (!square.visitor_paying || !square.owner_paying) return [];
    const gs = this.state;
    const group = square.color_group;
    if (!group) return [];
    const colorSquares = gs.boardSquares.filter(s => s.color_group === group);
    const ownsAll = colorSquares.every(s => s.owner === player.id);
    if (!ownsAll) return [];
    const upgrades = [];
    if (square.upgrade !== 'garage') upgrades.push('garage');
    if (square.upgrade !== 'rest_stop') upgrades.push('rest_stop');
    if (square.upgrade !== 'market') upgrades.push('market');
    return upgrades.map(type => {
      const key = type + '_rent';
      return {
        type,
        cost: square.owner_paying[key] || 0,
        visitorRent: square.visitor_paying[key] || 0,
      };
    }).filter(u => player.money >= u.cost);
  }

  handleDeckTrigger(player, square) {
    const gs = this.state;
    const deckType = square.deck_type || (square.type === 'dual_deck_trigger' ? 'dual' : 'hazak');

    // Instead of drawing immediately, set pending and wait for player to click the deck pile
    gs.pendingDeckDraw = { playerId: player.id, deckType, squareName: square.name };
    gs.phase = 'draw_card';
  }

  preSelectCitiesForCard(card) {
    const gs = this.state;
    const ownedProperties = gs.boardSquares.filter(sq => sq.type === 'property' && sq.owner !== null);
    this.shuffle(ownedProperties);
    const count = Math.min(card.city_count || 3, ownedProperties.length);
    const chosen = ownedProperties.slice(0, count);
    return {
      cityIds: chosen.map(c => c.id),
      cityNames: chosen.map(c => c.name),
    };
  }

  handleDrawCard(playerId, deckType) {
    const gs = this.state;
    const pending = gs.pendingDeckDraw;
    if (!pending || pending.playerId !== playerId) return null;
    if (pending.deckType !== deckType && pending.deckType !== 'dual') return null;

    if (pending.deckType === 'dual') {
      const card = this.drawCard(deckType);
      if (card) {
        let extra = {};
        if (card.action === 'collect_from_city_owners') {
          extra = this.preSelectCitiesForCard(card);
        }
        gs.blindCard = { card, playerId, squareName: pending.squareName, deckType, ...extra };
        const otherDeck = deckType === 'mahkama' ? 'hazak' : 'mahkama';
        gs.pendingDeckDraw = { playerId, deckType: otherDeck, squareName: pending.squareName };
        gs.phase = 'blind_card';
        return { card, cardNumber: 1, deckType, pendingSecondCard: false, ...extra };
      } else {
        gs.pendingDeckDraw = null;
        this.finishTurn();
        return null;
      }
    } else {
      const card = this.drawCard(deckType);
      if (card) {
        let extra = {};
        if (card.action === 'collect_from_city_owners') {
          extra = this.preSelectCitiesForCard(card);
        }
        gs.blindCard = { card, playerId, squareName: pending.squareName, deckType, ...extra };
        gs.pendingDeckDraw = null;
        gs.phase = 'blind_card';
        return { card, cardNumber: 1, deckType, pendingSecondCard: false, ...extra };
      } else {
        gs.pendingDeckDraw = null;
        this.finishTurn();
        return null;
      }
    }
  }

  handleCornerSquare(player, square) {
    const gs = this.state;
    switch (square.id) {
      case 1:
        player.money += gs.gameMeta.passGoSalary;
        this.finishTurn();
        break;
      case 8:
        if (player.isClubMember) { this.finishTurn(); break; }
        gs.pendingClubChoice = {
          playerId: player.id,
          membershipCost: square.membership_cost,
          guestFineFee: square.guest_fine_fee,
        };
        gs.phase = 'club_choice';
        break;
      case 18:
        player.statusEffects.doubleNextRoll = true;
        this.finishTurn();
        break;
      case 25:
        player.statusEffects.missedTurnsRemaining = square.rules.max_turns_to_miss;
        this.finishTurn();
        break;
      default:
        this.finishTurn();
    }
  }

  resolveClubChoice(choice) {
    const gs = this.state;
    if (!gs.pendingClubChoice) return;
    const { playerId, membershipCost, guestFineFee } = gs.pendingClubChoice;
    const player = gs.players.find(p => p.id === playerId);
    gs.pendingClubChoice = null;

    if (choice === 'membership' && player && player.money >= membershipCost) {
      player.money -= membershipCost;
      player.isClubMember = true;
      this.checkLiquidation(playerId);
    } else if (choice === 'guest' && player && player.money >= guestFineFee) {
      player.money -= guestFineFee;
      this.checkLiquidation(playerId);
    }
    // roomManager calls finishTurn for both options
  }

  resolvePropertyPurchase(shouldBuy) {
    const gs = this.state;
    if (!gs.pendingPropertyBuy) return;
    const { square, playerId } = gs.pendingPropertyBuy;
    const player = gs.players.find(p => p.id === playerId);
    gs.pendingPropertyBuy = null;
    if (shouldBuy && player && player.money >= square.purchase_price) {
      square.owner = playerId;
      player.money -= square.purchase_price;
    }
    this.checkLiquidation(playerId);
  }

  resolveRentPayment() {
    const gs = this.state;
    if (!gs.pendingRentPayment) return;
    const { playerId, ownerId, amount } = gs.pendingRentPayment;
    const player = gs.players.find(p => p.id === playerId);
    const owner = gs.players.find(p => p.id === ownerId);
    gs.pendingRentPayment = null;
    if (!player) return;
    const canPay = Math.min(amount, Math.max(0, player.money));
    player.money -= canPay;
    if (owner && !owner.isBankrupt) owner.money += canPay;
    this.checkLiquidation(playerId);
  }

  calculateRent(square, player) {
    let rent = square.base_rent;
    if (square.upgrade && square.visitor_paying) {
      const key = square.upgrade + '_rent';
      if (square.visitor_paying[key]) rent = square.visitor_paying[key];
    }
    if (player.statusEffects.payHalfRentNextLanding) {
      rent = Math.ceil(rent / 2);
      player.statusEffects.payHalfRentNextLanding = false;
    }
    return rent;
  }

  // ── Deck ──

  drawCard(deckType = 'hazak') {
    const gs = this.state;
    if (deckType === 'mahkama') {
      if (gs.mahkamaDeck.length === 0) {
        gs.mahkamaDeck = [...gs.mahkamaDiscard];
        this.shuffle(gs.mahkamaDeck);
        gs.mahkamaDiscard = [];
        if (gs.mahkamaDeck.length === 0) return null;
      }
      return gs.mahkamaDeck.pop();
    } else {
      if (gs.hazakDeck.length === 0) {
        gs.hazakDeck = [...gs.hazakDiscard];
        this.shuffle(gs.hazakDeck);
        gs.hazakDiscard = [];
        if (gs.hazakDeck.length === 0) return null;
      }
      return gs.hazakDeck.pop();
    }
  }

  discardCard(card, deckType = 'hazak') {
    const gs = this.state;
    if (deckType === 'mahkama') {
      gs.mahkamaDiscard.push(card);
    } else {
      gs.hazakDiscard.push(card);
    }
  }

  handleCardEffect(card, playerId) {
    const gs = this.state;
    const playerIndex = gs.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1 || gs.players[playerIndex].isBankrupt) return;
    const player = gs.players[playerIndex];
    const deckType = gs.blindCard?.deckType || 'hazak';

    gs.activeCardChoice = null;
    gs.pendingCityOwnersCard = null;

    // Mahkama cards use card.action; Hazak cards use raw fields
    switch (card.action) {
      case 'collect_from_players':
        this.effectCollectFromPlayers(card, player, playerIndex);
        break;
      case 'pay_bank':
      case 'receive_bank':
        this.effectBankMoney(card, player);
        break;
      case 'go_to_jail':
        this.effectGoToJail(card, player);
        break;
      case 'receive_jail_free_card':
        this.effectJailFreeCard(card, player);
        break;
      case 'bank_pays_per_building':
        this.effectBankPaysPerBuilding(card, player);
        break;
      case 'pay_repairs':
        this.effectPayRepairs(card, player);
        break;
      case 'collect_from_city_owners':
        this.effectCollectFromCityOwners(card, player, playerId);
        return;
      case 'choice':
        this.setupMahkamaChoice(card, player, playerId);
        return;
      case 'skip_turn_and_pay':
        this.effectSkipTurnAndPay(card, player);
        break;
      default:
        // ── Hazak-style fields ──
        this.applyHazakCard(card, player, playerId);
        return;
    }

    this.discardCard(card, deckType);
    this.checkLiquidation(playerId);
  }

  applyHazakCard(card, player, playerId) {
    const gs = this.state;
    const deckType = gs.blindCard?.deckType || 'hazak';

    // Bank money
    if (card.bank_money !== 0) {
      player.money += card.bank_money;
    }

    // Collect from each player
    if (card.players_money > 0) {
      let totalCollected = 0;
      gs.players.forEach(p => {
        if (p.id !== playerId && !p.isBankrupt) {
          const amount = Math.min(card.players_money, p.money);
          p.money -= amount;
          totalCollected += amount;
        }
      });
      player.money += totalCollected;
    }

    // Free play card
    if (card.free_card > 0) {
      player.inventory.freeCards = (player.inventory.freeCards || 0) + card.free_card;
    }

    // Jail-free card
    if (card.no_prison_card > 0) {
      player.inventory.jailFreeCards = (player.inventory.jailFreeCards || 0) + card.no_prison_card;
    }

    // Half rent on next landing
    if (card.half_price) {
      player.statusEffects.payHalfRentNextLanding = true;
    }

    // Move to specific position (teleport) — only if no real choices
    const hasRealChoice = card.choices?.some(c => c.action_type);
    if (card.move_to > 0 && !hasRealChoice) {
      player.position = card.move_to;
      if (card.move_to === 1) {
        player.money += gs.gameMeta.passGoSalary;
      }
    }

    // Move N squares forward/backward — only if no real choices
    if (card.squares_to_move !== 0 && !hasRealChoice) {
      const newPos = this.calculateNewPosition(player.position, card.squares_to_move);
      player.position = newPos;
    }

    // ── Handle hazak-style choices ──
    if (card.choices && card.choices.length > 0) {
      const choice = card.choices[0];

      if (choice.action_type === 'move_to_dynamic_pool') {
        const count = choice.selection_count || 3;
        const allProps = gs.boardSquares.filter(s => s.type === 'property');
        this.shuffle(allProps);
        const pool = allProps.slice(0, Math.min(count, allProps.length));

        if (pool.length === 0) {
          this.discardCard(card, deckType);
          this.checkLiquidation(playerId);
          return;
        }

        gs.activeCardChoice = {
          cardId: card.id,
          playerId,
          type: 'move_to_pool',
          title: card.description,
          options: pool.map(s => ({
            action: 'goto_property',
            label: `🏙️ ${s.name}`,
            propertyId: s.id,
          })),
          _card: card,
          _deckType: deckType,
        };
        gs.phase = 'card_choice';
        return;
      }

      if (choice.action_type === 'claim_free_property' && card.choices.length >= 2) {
        // Hazak id=15: cash or free property
        const cashOpt = card.choices.find(c => c.action_type === 'receive_cash');
        const propOpt = card.choices.find(c => c.action_type === 'claim_free_property');
        const cashAmount = cashOpt?.amount || 150;

        const poolOptions = propOpt?.pool_options || [];
        const unownedOnly = propOpt?.unowned_only !== false;
        const available = poolOptions
          .map(id => gs.boardSquares.find(s => s.id === id))
          .filter(Boolean)
          .filter(s => !unownedOnly || s.owner === null)
          .filter(s => s.purchase_price <= cashAmount);

        const opts = [
          { action: 'cash', label: `💰 خذ ${cashAmount} جنيه من البنك`, amount: cashAmount },
          ...available.map(s => ({ action: 'property', label: `🏙️ ${s.name} (${s.purchase_price}ج)`, propertyId: s.id })),
        ];

        if (available.length === 0) {
          player.money += cashAmount;
          this.discardCard(card, deckType);
          this.checkLiquidation(playerId);
          return;
        }

        gs.activeCardChoice = {
          cardId: card.id,
          playerId,
          type: 'cash_or_free_property',
          title: card.description,
          options: opts,
          _card: card,
          _deckType: deckType,
        };
        gs.phase = 'card_choice';
        return;
      }
    }

    this.discardCard(card, deckType);
    this.checkLiquidation(playerId);
  }

  effectCollectFromPlayers(card, player, playerIndex) {
    const gs = this.state;
    let totalCollected = 0;
    gs.players.forEach(p => {
      if (p.id !== player.id && !p.isBankrupt) {
        const amount = Math.min(card.players_money, p.money);
        p.money -= amount;
        totalCollected += amount;
      }
    });
    player.money += totalCollected;
  }

  effectBankMoney(card, player) {
    player.money += card.bank_money;
  }

  effectGoToJail(card, player) {
    const gs = this.state;
    player.position = card.move_to;
    const prisonSquare = gs.boardSquares.find(s => s.id === 25);
    if (prisonSquare) {
      player.statusEffects.missedTurnsRemaining = prisonSquare.rules.max_turns_to_miss;
    }
  }

  effectJailFreeCard(card, player) {
    player.inventory.jailFreeCards += card.jail_free_card;
  }

  effectBankPaysPerBuilding(card, player) {
    const gs = this.state;
    const ownedSquares = gs.boardSquares.filter(sq => sq.owner === player.id);
    let totalUpgrades = 0;
    ownedSquares.forEach(sq => {
      if (sq.upgrade) totalUpgrades++;
    });
    const amount = totalUpgrades * (card.per_building_amount || 25);
    player.money += amount;
  }

  effectPayRepairs(card, player) {
    const gs = this.state;
    const costs = card.repair_costs || { market: 100, rest_stop: 50, garage: 25 };
    const ownedSquares = gs.boardSquares.filter(sq => sq.owner === player.id);
    let total = 0;
    ownedSquares.forEach(sq => {
      if (sq.upgrade && costs[sq.upgrade]) {
        total += costs[sq.upgrade];
      }
    });
    player.money -= total;
  }

  effectCollectFromCityOwners(card, player, playerId) {
    const gs = this.state;
    let chosenCities;

    if (gs.blindCard?.cityIds && gs.blindCard?.cityNames) {
      chosenCities = gs.blindCard.cityIds.map(id => gs.boardSquares.find(s => s.id === id)).filter(Boolean);
    } else {
      const ownedProperties = gs.boardSquares.filter(sq => sq.type === 'property' && sq.owner !== null);
      this.shuffle(ownedProperties);
      const count = Math.min(card.city_count || 3, ownedProperties.length);
      chosenCities = ownedProperties.slice(0, count);
    }

    if (chosenCities.length === 0) {
      this.discardCard(card, gs.blindCard?.deckType || 'hazak');
      this.checkLiquidation(playerId);
      return;
    }

    const cityNames = chosenCities.map(c => c.name);
    const cityIds = chosenCities.map(c => c.id);
    let totalCollected = 0;
    const payerSet = new Set();

    chosenCities.forEach(city => {
      if (city.owner && city.owner !== playerId) {
        payerSet.add(city.owner);
      }
    });

    payerSet.forEach(ownerId => {
      const owner = gs.players.find(p => p.id === ownerId);
      if (owner && !owner.isBankrupt) {
        const payment = (card.amount_per_city || 50);
        const amount = Math.min(payment, owner.money);
        owner.money -= amount;
        totalCollected += amount;
      }
    });

    player.money += totalCollected;

    gs.pendingCityOwnersCard = {
      card,
      cityNames,
      cityIds,
      totalCollected,
      deckType: gs.blindCard?.deckType || 'hazak',
    };

    this.discardCard(card, gs.blindCard?.deckType || 'hazak');
    this.checkLiquidation(playerId);
  }

  effectSkipTurnAndPay(card, player) {
    player.money += card.bank_money;
    player.statusEffects.skipNextTurn = true;
  }

  setupMahkamaChoice(card, player, playerId) {
    const gs = this.state;

    if (card.id === 11) {
      const maxPrice = card.choices[0].max_price || 150;
      const available = gs.boardSquares.filter(
        s => s.type === 'property' && s.owner === null && s.purchase_price <= maxPrice
      );

      if (available.length === 0) {
        player.money += 100;
        this.discardCard(card, gs.blindCard?.deckType || 'hazak');
        this.checkLiquidation(playerId);
        return;
      }

      gs.activeCardChoice = {
        cardId: card.id,
        playerId,
        type: 'cash_or_free_property',
        title: card.description,
        options: [
          { action: 'cash', label: '💰 خذ ١٠٠ جنيه من البنك', amount: 100 },
          ...available.map(s => ({ action: 'property', label: `🏙️ ${s.name} (${s.purchase_price}ج)`, propertyId: s.id })),
        ],
        _card: card,
        _deckType: gs.blindCard?.deckType || 'hazak',
      };
      gs.phase = 'card_choice';
      return;
    }

    if (card.id === 15) {
      gs.activeCardChoice = {
        cardId: card.id,
        playerId,
        type: 'pay_or_prison',
        title: card.description,
        options: [
          { action: 'pay_fine', label: '💰 ادفع ١٠٠ جنيه غرامة', amount: 100 },
          { action: 'go_to_prison', label: '🔒 اذهب للسجن' },
        ],
        _card: card,
        _deckType: gs.blindCard?.deckType || 'hazak',
      };
      gs.phase = 'card_choice';
      return;
    }
  }

  resolveCardChoice(choiceIndex) {
    const gs = this.state;
    if (!gs.activeCardChoice) return;
    const { cardId, playerId, type, options } = gs.activeCardChoice;
    const player = gs.players.find(p => p.id === playerId);
    if (!player) { gs.activeCardChoice = null; return; }

    const chosen = options[choiceIndex];
    const deckType = gs.activeCardChoice._deckType || 'hazak';

    if (type === 'cash_or_free_property') {
      if (chosen.action === 'cash') {
        player.money += chosen.amount;
      } else if (chosen.action === 'property') {
        const square = gs.boardSquares.find(s => s.id === chosen.propertyId);
        if (square) square.owner = playerId;
      }
      this.discardCard(gs.activeCardChoice._card, deckType);
      gs.activeCardChoice = null;
      this.checkLiquidation(playerId);
      return;
    }

    if (type === 'pay_or_prison') {
      if (chosen.action === 'pay_fine') {
        player.money -= chosen.amount;
      } else if (chosen.action === 'go_to_prison') {
        player.position = 25;
        const prisonSquare = gs.boardSquares.find(s => s.id === 25);
        if (prisonSquare) {
          player.statusEffects.missedTurnsRemaining = prisonSquare.rules.max_turns_to_miss;
        }
      }
      this.discardCard(gs.activeCardChoice._card, deckType);
      gs.activeCardChoice = null;
      this.checkLiquidation(playerId);
      return;
    }

    if (type === 'move_to_pool') {
      if (chosen.action === 'goto_property') {
        player.position = chosen.propertyId;
      }
      this.discardCard(gs.activeCardChoice._card, deckType);
      gs.activeCardChoice = null;
      this.checkLiquidation(playerId);
      return;
    }

    if (gs.activeCardChoice._card) {
      this.discardCard(gs.activeCardChoice._card, deckType);
    }
    gs.activeCardChoice = null;
  }

  hasComplexChoices(card) {
    return card.choices && card.choices.length > 0 &&
      card.choices.some(c => c.action_type);
  }

  // ── Upgrades ──

  purchaseUpgrade(playerId, propertyId, upgradeType) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    const square = gs.boardSquares.find(s => s.id === propertyId);
    if (!square || square.owner !== playerId) return false;
    const key = upgradeType + '_rent';
    const cost = square.owner_paying?.[key];
    if (!cost || player.money < cost) return false;
    player.money -= cost;
    square.upgrade = upgradeType;
    return true;
  }

  sellUpgrade(playerId, propertyId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    const square = gs.boardSquares.find(s => s.id === propertyId);
    if (!square || square.owner !== playerId || !square.upgrade) return false;
    const key = square.upgrade + '_rent';
    const cost = square.owner_paying?.[key];
    const refund = Math.round((cost || 0) * 0.75);
    player.money += refund;
    square.upgrade = null;
    return true;
  }

  sellPropertyToBank(playerId, propertyId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    const square = gs.boardSquares.find(s => s.id === propertyId);
    if (!square || square.owner !== playerId) return false;
    if (square.upgrade) {
      this.sellUpgrade(playerId, propertyId);
    }
    const salePrice = Math.round(square.purchase_price * 0.75);
    player.money += salePrice;
    square.owner = null;
    square.upgrade = null;
    if (player.money >= 0 && gs.isLiquidating) {
      gs.isLiquidating = false;
    }
    return true;
  }

  // ── Prison ──

  payBail(playerId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.statusEffects.missedTurnsRemaining <= 0) return;
    const square = gs.boardSquares.find(s => s.id === 25);
    const bailCost = square ? square.rules.bail_cost : 50;
    if (player.money >= bailCost) {
      player.money -= bailCost;
      player.statusEffects.missedTurnsRemaining = 0;
      gs.phase = 'roll';
    }
  }

  useJailFreeCard(playerId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.statusEffects.missedTurnsRemaining <= 0) return;
    if (player.inventory.jailFreeCards > 0) {
      player.inventory.jailFreeCards--;
      player.statusEffects.missedTurnsRemaining = 0;
      gs.phase = 'roll';
    }
  }

  // ── Turn ──

  finishTurn(skipAdvance) {
    const gs = this.state;
    if (gs.pendingDeckDraw) {
      const drawer = gs.players.find(p => p.id === gs.pendingDeckDraw.playerId);
      if (drawer && drawer.statusEffects.missedTurnsRemaining > 0) {
        gs.pendingDeckDraw = null;
      } else {
        gs.phase = 'draw_card';
        return;
      }
    }
    if (gs.pendingClubChoice) {
      gs.phase = 'club_choice';
      return;
    }
    if (gs.pendingRentPayment) {
      gs.phase = 'rent_payment';
      return;
    }
    if (gs.pendingPropertyBuy) {
      gs.phase = 'property_choice';
      return;
    }
    if (gs.pendingUpgradeChoice) {
      gs.phase = 'upgrade_choice';
      return;
    }
    if (gs.activeCardChoice) {
      gs.phase = 'card_choice';
      return;
    }
    gs.phase = 'done';
    if (!skipAdvance) this.advanceTurn();
  }

  advanceTurn() {
    const gs = this.state;
    const activePlayers = gs.players.filter(p => !p.isBankrupt);
    if (activePlayers.length <= 1) {
      gs.gameOver = true;
      gs.phase = 'done';
      return;
    }
    let tries = 0;
    do {
      gs.currentPlayerIndex = (gs.currentPlayerIndex + 1) % gs.players.length;
      tries++;
    } while (gs.players[gs.currentPlayerIndex].isBankrupt && tries < gs.players.length);

    const nextPlayer = gs.players[gs.currentPlayerIndex];
    if (nextPlayer && nextPlayer.statusEffects.skipNextTurn) {
      nextPlayer.statusEffects.skipNextTurn = false;
      this.advanceTurn();
      return;
    }

    gs.phase = 'roll';
    gs.timerSeconds = 90;
    gs.timerRunning = true;
  }

  // ── Liquidation ──

  checkLiquidation(playerId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.isBankrupt) return false;
    if (player.money < 0) {
      gs.isLiquidating = true;
      player.isBankrupt = true;
      player.money = 0;
      gs.isLiquidating = false;
      gs.boardSquares.forEach(sq => {
        if (sq.owner === playerId) { sq.owner = null; sq.upgrade = null; }
      });
      return true;
    }
    return false;
  }
}
