import boardData from './board.json' with { type: 'json' };
import hazakData from './hazak.json' with { type: 'json' };

let callbacks = { log: [] };

export function setLogCallback(fn) {
  callbacks.log.push(fn);
}

function log(...args) {
  const msg = args.join(' ');
  callbacks.log.forEach(fn => fn(msg));
}

export class GameEngine {
  constructor(roomPlayers) {
    this.roomPlayers = roomPlayers;
    this.state = null;
    this.logs = [];
  }

  initGame() {
    const boardSquares = boardData.board_positions.map(sq => {
      if (sq.type === 'property') {
        return { ...sq, owner: null, buildings: [] };
      }
      return { ...sq };
    });

    const hazakDeck = [...hazakData.hazak];
    this.shuffle(hazakDeck);

    const cash = 1200;
    const players = this.roomPlayers.map((rp, i) => ({
      id: rp.id,
      name: rp.name,
      avatar: rp.avatar || 1,
      position: 1,
      money: cash,
      isHuman: true,
      inventory: { freeCards: 0, getOutofPrisonCards: 0 },
      statusEffects: { payHalfRentNextLanding: false, doubleNextRoll: false, missedTurnsRemaining: 0 },
      isBankrupt: false,
      _prevMoney: cash,
    }));

    this.state = {
      gameMeta: {
        maxPlayers: boardData.game_meta.max_players,
        passGoSalary: boardData.game_meta.pass_go_salary,
        bankManagerBonus: boardData.game_meta.bank_manager_bonus,
      },
      players,
      currentPlayerIndex: 0,
      boardSquares,
      hazakDeck,
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
      tradeProposal: null,
      tradeConfirmations: {},
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
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    return { die1: d1, die2: d2, total: d1 + d2, isDouble: d1 === d2 };
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
      this.finishTurn();
    } else {
      const owner = gs.players.find(p => p.id === square.owner);
      const rent = this.calculateRent(square, player);
      gs.pendingRentPayment = { playerId: player.id, ownerId: owner?.id, amount: rent, squareName: square.name };
      gs.phase = 'rent_payment';
    }
  }

  handleDeckTrigger(player, square) {
    const gs = this.state;
    const card = this.drawCard();
    if (card) {
      gs.blindCard = { card, playerId: player.id, squareName: square.name };
      if (square.type === 'dual_deck_trigger') {
        gs.pendingSecondCard = true;
        gs.blindCard.cardNumber = 1;
      }
      gs.phase = 'blind_card';
    } else {
      this.finishTurn();
    }
  }

  handleCornerSquare(player, square) {
    const gs = this.state;
    switch (square.id) {
      case 1:
        this.finishTurn();
        break;
      case 8: {
        let cost = 0;
        if (player.money >= square.membership_cost) {
          cost = square.membership_cost;
        } else if (player.money >= square.guest_fine_fee) {
          cost = square.guest_fine_fee;
        }
        player.money -= cost;
        this.checkLiquidation(player.id);
        this.finishTurn();
        break;
      }
      case 18:
        player.statusEffects.doubleNextRoll = true;
        this.finishTurn();
        break;
      case 25:
        player.statusEffects.missedTurnsRemaining = square.rules.max_turns_to_miss;
        if (player.inventory.getOutofPrisonCards > 0) {
          player.inventory.getOutofPrisonCards--;
          player.statusEffects.missedTurnsRemaining = 0;
        }
        this.finishTurn();
        break;
      default:
        this.finishTurn();
    }
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
    const buildingCount = square.buildings ? square.buildings.length : 0;
    let rent = square.base_rent;
    if (buildingCount >= 3) rent = square.visitor_paying.market_rent;
    else if (buildingCount >= 2) rent = square.visitor_paying.rest_stop_rent;
    else if (buildingCount >= 1) rent = square.visitor_paying.garage_rent;
    if (player.statusEffects.payHalfRentNextLanding) {
      rent = Math.ceil(rent / 2);
      player.statusEffects.payHalfRentNextLanding = false;
    }
    return rent;
  }

  // ── Deck ──

  drawCard() {
    const gs = this.state;
    if (gs.hazakDeck.length === 0) return null;
    return gs.hazakDeck.pop();
  }

  handleCardEffect(card, playerId) {
    const gs = this.state;
    const playerIndex = gs.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1 || gs.players[playerIndex].isBankrupt) return;
    const player = gs.players[playerIndex];

    gs.activeCardChoice = null;

    if (card.bank_money !== 0) {
      gs.players[playerIndex].money += card.bank_money;
    }

    if (card.players_money > 0) {
      let totalCollected = 0;
      gs.players.forEach(p => {
        if (p.id !== playerId && !p.isBankrupt) {
          const amount = Math.min(card.players_money, p.money);
          p.money -= amount;
          totalCollected += amount;
        }
      });
      gs.players[playerIndex].money += totalCollected;
    }

    if (card.move_to > 0) {
      player.position = card.move_to;
    }

    if (card.squares_to_move !== 0) {
      const prevPos = player.position;
      const newPos = this.calculateNewPosition(prevPos, card.squares_to_move);
      player.position = newPos;
      if (card.squares_to_move > 0 && newPos < prevPos) {
        gs.players[playerIndex].money += gs.gameMeta.passGoSalary;
      }
    }

    if (card.free_card > 0) {
      player.inventory.freeCards += card.free_card;
    }

    if (card.no_prison_card > 0) {
      player.inventory.getOutofPrisonCards += card.no_prison_card;
    }

    if (card['half price'] === 1) {
      player.statusEffects.payHalfRentNextLanding = true;
    }

    if (this.hasComplexChoices(card)) {
      this.setupCardChoices(card, playerId);
      if (gs.activeCardChoice) {
        gs.activeCardChoice._card = card;
      }
      gs.phase = 'card_choice';
      return;
    }

    gs.hazakDeck.unshift(card);
    this.checkLiquidation(playerId);
  }

  hasComplexChoices(card) {
    return card.choices && card.choices.length > 0 &&
      card.choices.some(c => c.action_type);
  }

  setupCardChoices(card, playerId) {
    const gs = this.state;
    if (card.id === 7) {
      const properties = gs.boardSquares.filter(sq => sq.type === 'property');
      for (let i = properties.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [properties[i], properties[j]] = [properties[j], properties[i]];
      }
      const options = properties.slice(0, 3);
      gs.activeCardChoice = {
        cardId: card.id, playerId, type: 'move_to_property',
        options: options.map(s => ({ id: s.id, name: s.name })),
        bonusCash: card.bank_money,
      };
    }

    if (card.id === 15) {
      const poolOptions = card.choices[1].pool_options;
      const available = gs.boardSquares.filter(
        s => poolOptions.includes(s.id) && s.owner === null && s.purchase_price <= 150
      );
      if (available.length === 0) {
        player.money += 150;
        this.checkLiquidation(playerId);
      } else {
        gs.activeCardChoice = {
          cardId: card.id, playerId, type: 'cash_or_property',
          options: [
            { action: 'cash', label: 'خذ 150 جنيه', amount: 150 },
            { action: 'property', label: 'اختر مدينة مجانية', properties: available.map(s => ({ id: s.id, name: s.name })) },
          ],
        };
      }
    }
  }

  resolveCardChoice(choiceIndex) {
    const gs = this.state;
    if (!gs.activeCardChoice) return;
    const { cardId, playerId, type, options } = gs.activeCardChoice;
    const player = gs.players.find(p => p.id === playerId);
    if (!player) { gs.activeCardChoice = null; return; }
    const cardRef = gs.activeCardChoice._card;

    if (cardId === 7 && type === 'move_to_property') {
      const clampedIdx = Math.min(choiceIndex, options.length - 1);
      const chosen = options[clampedIdx];
      player.position = chosen.id;
      if (cardRef) gs.hazakDeck.unshift(cardRef);
      gs.activeCardChoice = null;
      const landingSquare = gs.boardSquares.find(s => s.id === chosen.id);
      if (landingSquare) {
        if (landingSquare.type === 'property' && landingSquare.owner !== null && landingSquare.owner !== playerId) {
          const rent = this.calculateRent(landingSquare, player);
          player.money -= rent;
          const owner = gs.players.find(p => p.id === landingSquare.owner);
          if (owner) owner.money += rent;
          this.checkLiquidation(playerId);
        }
      }
    }

    if (cardId === 15 && type === 'cash_or_property') {
      if (choiceIndex === 0) {
        player.money += 150;
        if (cardRef) gs.hazakDeck.unshift(cardRef);
        gs.activeCardChoice = null;
        this.checkLiquidation(playerId);
      } else {
        const propOptions = options[1].properties;
        const subChoice = Math.min(choiceIndex - 1, propOptions.length - 1);
        const chosen = propOptions[subChoice];
        const square = gs.boardSquares.find(s => s.id === chosen.id);
        if (square) square.owner = playerId;
        if (cardRef) gs.hazakDeck.unshift(cardRef);
        gs.activeCardChoice = null;
      }
    }
  }

  // ── Sell ──

  sellBuilding(playerId, propertyId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    const square = gs.boardSquares.find(s => s.id === propertyId);
    if (!square || square.owner !== playerId || !square.buildings || square.buildings.length === 0) return false;
    const top = square.buildings.pop();
    const costs = {
      garage: Math.round(square.purchase_price * 0.5),
      rest_stop: Math.round(square.purchase_price * 0.8),
      market: Math.round(square.purchase_price * 1.2),
    };
    player.money += Math.round(costs[top] * 0.75);
    return true;
  }

  sellPropertyToBank(playerId, propertyId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    const square = gs.boardSquares.find(s => s.id === propertyId);
    if (!square || square.owner !== playerId) return false;
    while (square.buildings && square.buildings.length > 0) {
      this.sellBuilding(playerId, propertyId);
    }
    const salePrice = Math.round(square.purchase_price * 0.75);
    player.money += salePrice;
    square.owner = null;
    square.buildings = [];
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

  // ── Turn ──

  finishTurn(skipAdvance) {
    const gs = this.state;
    if (gs.pendingSecondCard) {
      gs.pendingSecondCard = false;
      const card2 = this.drawCard();
      if (card2) {
        gs.blindCard = { card: card2, playerId: gs.players[gs.currentPlayerIndex]?.id, squareName: 'المحكمة أو حظك', cardNumber: 2 };
        gs.phase = 'blind_card';
        return;
      }
    }
    if (gs.pendingPropertyBuy) {
      gs.phase = 'property_choice';
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

    gs.phase = 'roll';
    gs.timerRunning = false;
  }

  // ── Liquidation ──

  checkLiquidation(playerId) {
    const gs = this.state;
    const player = gs.players.find(p => p.id === playerId);
    if (!player || player.isBankrupt) return false;
    if (player.money < 0) {
      gs.isLiquidating = true;
      // Force bankruptcy on negative money after all checks
      player.isBankrupt = true;
      player.money = 0;
      gs.isLiquidating = false;
      gs.boardSquares.forEach(sq => {
        if (sq.owner === playerId) { sq.owner = null; sq.buildings = []; }
      });
      return true;
    }
    return false;
  }
}
