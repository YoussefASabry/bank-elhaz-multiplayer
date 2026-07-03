import { getState, findSquare, getSquareName } from './state.js';
import { calculateNewPosition } from './dice.js';
import { checkLiquidation } from './liquidation.js';
import { finishTurn } from './turn.js';
import { log } from './utils.js';

// Draw a card from the specified deck, or Hazak by default
export function drawCard(deckType = 'hazak') {
  const state = getState();
  const deck = deckType === 'mahkama' ? state.mahkamaDeck : state.hazakDeck;
  const discard = deckType === 'mahkama' ? state.mahkamaDiscard : state.hazakDiscard;

  if (deck.length === 0) {
    if (discard.length > 0) {
      // Reshuffle discard pile into deck
      log(`      shuffling ${deckType} discard pile (${discard.length} cards) back into deck.`);
      while (discard.length > 0) {
        deck.push(discard.pop());
      }
      shuffle(deck);
    } else {
      log(`❌ ${deckType} deck and discard are empty!`);
      return null;
    }
  }
  return deck.pop();
}

function discardCard(card, deckType = 'hazak') {
  const state = getState();
  if (deckType === 'mahkama') {
    state.mahkamaDiscard.push(card);
  } else {
    state.hazakDiscard.push(card);
  }
}

export function revealBlindCard() {
  const state = getState();
  if (!state.blindCard) return;
  const { card, playerId, deckType } = state.blindCard;
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.isBankrupt) {
    state.blindCard = null;
    finishTurn(playerId);
    return;
  }

  const cardNum = state.blindCard.cardNumber;
  const prefix = cardNum ? `📜 [Card ${cardNum}/${state.pendingSecondCard ? 2 : 1}]` : '📜';
  log(`\n${prefix} ${player.name} reveals: ${card.description}`);

  state.blindCard = null;
  handleCardEffect(card, playerId, deckType);
}

export function handleCardEffect(card, playerId, deckType = 'hazak') {
  const state = getState();
  const playerIndex = state.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1 || state.players[playerIndex].isBankrupt) return;
  const player = state.players[playerIndex];

  log(`   Applying card #${card.id}: ${card.description}`);

  state.activeCardChoice = null;
  state.pendingCityOwnersCard = null; // Clear any pending city owner card effects

  // Mahkama cards use 'action' field, Hazak cards use direct fields
  if (card.action) {
    switch (card.action) {
      case 'collect_from_players':
        effectCollectFromPlayers(card, player, playerId);
        break;
      case 'pay_bank':
      case 'receive_bank':
        effectBankMoney(card, player);
        break;
      case 'go_to_jail':
        effectGoToJail(card, player);
        break;
      case 'receive_jail_free_card':
        effectJailFreeCard(card, player);
        break;
      case 'bank_pays_per_building':
        effectBankPaysPerBuilding(card, player);
        break;
      case 'pay_repairs':
        effectPayRepairs(card, player);
        break;
      case 'collect_from_city_owners':
        effectCollectFromCityOwners(card, player, playerId, deckType);
        discardCard(card, deckType); // discard after full effect for city owner cards
        return; // City owner card resolves outside standard flow
      case 'choice':
        setupCardChoices(card, playerId, deckType);
        if (state.activeCardChoice) {
          state.activeCardChoice._card = card;
          state.activeCardChoice._deckType = deckType;
        }
        if (player.isHuman) {
          state.phase = 'card_choice';
          return;
        }
        resolveCardChoice(0); // Auto-resolve for non-human player
        return;
      case 'skip_turn_and_pay':
        effectSkipTurnAndPay(card, player);
        break;
      default:
        log(`   ⚠️ Unknown card action: ${card.action}`);
    }
  } else {
    // Apply Hazak-style effects
    applyHazakCard(card, player, playerId, deckType);
  }

  // If there's an active choice, the card will be unshifted to deck later
  if (!state.activeCardChoice) {
    discardCard(card, deckType);
  }

  checkLiquidation(playerId);
  finishTurn(playerId);
}

function applyHazakCard(card, player, playerId, deckType) {
  const state = getState();

  if (card.bank_money !== 0) {
    player.money += card.bank_money;
    const sign = card.bank_money > 0 ? '+' : '';
    log(`   💰 Bank: ${sign}$${card.bank_money} → $${player.money}`);
  }

  if (card.players_money > 0) {
    let totalCollected = 0;
    state.players.forEach(p => {
      if (p.id !== playerId && !p.isBankrupt) {
        const amount = Math.min(card.players_money, p.money);
        p.money -= amount;
        totalCollected += amount;
        log(`   👤 ${p.name} paid $${amount}`);
      }
    });
    player.money += totalCollected;
    log(`   👥 Collected $${totalCollected} from other players → $${player.money}`);
  }

  if (card.free_card > 0) {
    player.inventory.freeCards += card.free_card;
    log(`   🆓 +${card.free_card} free card(s) → ${player.inventory.freeCards}`);
  }

  if (card.no_prison_card > 0) {
    player.inventory.jailFreeCards += card.no_prison_card; // Use jailFreeCards
    log(`   🔓 +${card.no_prison_card} get-out-of-prison card(s) → ${player.inventory.jailFreeCards}`);
  }

  if (card["half price"] === 1) {
    player.statusEffects.payHalfRentNextLanding = true;
    log(`   💲 Half rent active for next property`);
  }

  // Handle movements only if there are no complex choices that override movement
  if (!hasComplexChoices(card)) {
    if (card.move_to > 0) {
      const prevPos = player.position;
      player.position = card.move_to;
      log(`   🚀 Teleported from ${getSquareName(prevPos)} → ${getSquareName(card.move_to)}`);
      if (card.move_to === 1) { // Passed Go
        player.money += state.gameMeta.passGoSalary;
        log(`   🏁 Passed Go! +$${state.gameMeta.passGoSalary} → $${player.money}`);
      }
    } else if (card.squares_to_move !== 0) {
      const prevPos = player.position;
      const newPos = calculateNewPosition(prevPos, card.squares_to_move);
      player.position = newPos;
      const dir = card.squares_to_move > 0 ? 'forward' : 'backward';
      log(`   🚶 Moved ${dir} ${Math.abs(card.squares_to_move)}: ${getSquareName(prevPos)} → ${getSquareName(newPos)}`);
      if (card.squares_to_move > 0 && newPos < prevPos) { // Passed Go
        player.money += state.gameMeta.passGoSalary;
        log(`   🏁 Passed Go! +$${state.gameMeta.passGoSalary} → $${player.money}`);
      }
    }
  }

  if (hasComplexChoices(card)) {
    setupCardChoices(card, playerId, deckType);
    if (state.activeCardChoice) {
      state.activeCardChoice._card = card;
      state.activeCardChoice._deckType = deckType;
    }
    if (player.isHuman) {
      state.phase = 'card_choice';
      return;
    }
    resolveCardChoice(0); // Auto-resolve for non-human player
    return;
  }
}

// Helper functions for Mahkama card effects
function effectCollectFromPlayers(card, player, playerId) {
  const state = getState();
  let totalCollected = 0;
  state.players.forEach(p => {
    if (p.id !== playerId && !p.isBankrupt) {
      const amount = Math.min(card.players_money, p.money);
      p.money -= amount;
      totalCollected += amount;
      log(`   👤 ${p.name} paid $${amount}`);
    }
  });
  player.money += totalCollected;
  log(`   👥 Collected $${totalCollected} from other players → $${player.money}`);
}

function effectBankMoney(card, player) {
  player.money += card.bank_money;
  const sign = card.bank_money > 0 ? '+' : '';
  log(`   💰 Bank: ${sign}$${card.bank_money} → $${player.money}`);
}

function effectGoToJail(card, player) {
  const state = getState();
  const prisonSquareId = 25;
  player.position = prisonSquareId;
  const prisonSquare = findSquare(prisonSquareId);
  if (prisonSquare) {
    player.statusEffects.missedTurnsRemaining = prisonSquare.rules.max_turns_to_miss;
  }
  log(`   🔒 Teleported to Jail! Must skip ${player.statusEffects.missedTurnsRemaining} turn(s) or pay bail. Use a 🔓 jail-free card if you have one.`);
}

function effectJailFreeCard(card, player) {
  player.inventory.jailFreeCards += card.jail_free_card;
  log(`   🔓 +${card.jail_free_card} Get Out of Prison Free card(s) → ${player.inventory.jailFreeCards}`);
}

function effectBankPaysPerBuilding(card, player) {
  const state = getState();
  const ownedSquares = state.boardSquares.filter(sq => sq.owner === player.id);
  let totalBuildings = 0;
  ownedSquares.forEach(sq => {
    if (sq.buildings) {
      totalBuildings += sq.buildings.length;
    }
  });
  const amount = totalBuildings * (card.per_building_amount || 25);
  player.money += amount;
  log(`   🏗️ Bank paid $${amount} for ${totalBuildings} buildings → $${player.money}`);
}

function effectPayRepairs(card, player) {
  const state = getState();
  const costs = card.repair_costs || { market: 100, rest_stop: 50, garage: 25 };
  const ownedSquares = state.boardSquares.filter(sq => sq.owner === player.id);
  let totalRepairCost = 0;
  ownedSquares.forEach(sq => {
    if (sq.buildings) {
      sq.buildings.forEach(b => {
        // Assume 'b' is the type string 'garage', 'rest_stop', 'market'
        totalRepairCost += costs[b] || 0;
      });
    }
  });
  player.money -= totalRepairCost;
  log(`   🔧 Paid $${totalRepairCost} for repairs → $${player.money}`);
}

function effectCollectFromCityOwners(card, player, playerId, deckType) {
  const state = getState();
  const ownedProperties = state.boardSquares.filter(sq => sq.type === 'property' && sq.owner !== null);
  shuffle(ownedProperties);
  const count = Math.min(card.city_count || 3, ownedProperties.length);
  const chosenCities = ownedProperties.slice(0, count);

  if (chosenCities.length === 0) {
    log(`   ℹ️ No owned cities to collect from.`);
    return;
  }

  const cityNames = chosenCities.map(c => c.name);
  let totalCollected = 0;
  const payerSet = new Set(); // Collect from each unique owner once

  chosenCities.forEach(city => {
    if (city.owner && city.owner !== playerId) {
      payerSet.add(city.owner);
    }
  });

  payerSet.forEach(ownerId => {
    const owner = state.players.find(p => p.id === ownerId);
    if (owner && !owner.isBankrupt) {
      const payment = card.amount_per_city || 50;
      const amount = Math.min(payment, owner.money);
      owner.money -= amount;
      totalCollected += amount;
      log(`   👤 ${owner.name} paid $${amount} for city owners card`);
    }
  });

  player.money += totalCollected;
  log(`   🏙️ Collected $${totalCollected} from city owners → $${player.money}`);

  state.pendingCityOwnersCard = {
    card,
    cityNames,
    totalCollected,
    deckType,
  };
}

function effectSkipTurnAndPay(card, player) {
  player.money += card.bank_money;
  player.statusEffects.skipNextTurn = true;
  const sign = card.bank_money > 0 ? '+' : '';
  log(`   💰 Bank: ${sign}$${card.bank_money} → $${player.money}. Skip next turn.`);
}


function hasComplexChoices(card) {
  return card.choices && card.choices.length > 0 &&
    card.choices.some(c => c.action_type);
}

export function setupCardChoices(card, playerId, deckType = 'hazak') {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player) return;

  // Hazak card ID 7: Move to random property + cash
  if (card.id === 7 && card.choices[0]?.action_type === 'move_to_dynamic_pool') {
    const properties = state.boardSquares.filter(sq => sq.type === 'property');
    shuffle(properties);
    const options = properties.slice(0, Math.min(card.choices[0].selection_count || 3, properties.length));
    state.activeCardChoice = {
      cardId: card.id,
      playerId,
      type: 'move_to_pool',
      title: card.description,
      options: options.map(s => ({ action: 'goto_property', label: `🏙️ ${s.name}`, propertyId: s.id })),
      _card: card,
      _deckType: deckType,
    };
    log(`   🎯 Choose a city: ${options.map(s => s.name).join(', ')}`);
    return;
  }

  // Hazak card ID 15: Cash or free property
  if (card.id === 15 && card.choices[0]?.action_type === 'receive_cash' && card.choices[1]?.action_type === 'claim_free_property') {
    const cashOpt = card.choices.find(c => c.action_type === 'receive_cash');
    const propOpt = card.choices.find(c => c.action_type === 'claim_free_property');
    const cashAmount = cashOpt?.amount || 150;

    const poolOptions = propOpt?.pool_options || [];
    const unownedOnly = propOpt?.unowned_only !== false;
    const available = poolOptions
      .map(id => findSquare(id))
      .filter(Boolean)
      .filter(s => !unownedOnly || s.owner === null);

    const opts = [
      { action: 'cash', label: `💰 خذ ${cashAmount} جنيه من البنك`, amount: cashAmount },
      ...available.map(s => ({ action: 'property', label: `🏙️ ${s.name} (${s.purchase_price}ج)`, propertyId: s.id })),
    ];

    if (available.length === 0) {
      player.money += cashAmount;
      log(`   💰 No free properties available. Received $${cashAmount} → $${player.money}`);
      discardCard(card, deckType);
      checkLiquidation(playerId);
      finishTurn(playerId);
      return;
    }

    state.activeCardChoice = {
      cardId: card.id,
      playerId,
      type: 'cash_or_free_property',
      title: card.description,
      options: opts,
      _card: card,
      _deckType: deckType,
    };
    log(`   🎯 $${cashAmount} cash or free city?`);
    return;
  }

  // Mahkama card ID 11: Cash or free property (Mahkama style)
  if (card.id === 11 && card.action === 'choice' && card.choices[0]?.action_type === 'claim_free_property') {
    const maxPrice = card.choices[0].max_price || 150;
    const cashAmount = card.choices[1]?.amount || 100;

    const available = state.boardSquares.filter(
      s => s.type === 'property' && s.owner === null && s.purchase_price <= maxPrice
    );

    const opts = [
      { action: 'cash', label: `💰 خذ ${cashAmount} جنيه من البنك`, amount: cashAmount },
      ...available.map(s => ({ action: 'property', label: `🏙️ ${s.name} (${s.purchase_price}ج)`, propertyId: s.id })),
    ];

    if (available.length === 0) {
      player.money += cashAmount;
      log(`   💰 No free properties. Received $${cashAmount} → $${player.money}`);
      discardCard(card, deckType);
      checkLiquidation(playerId);
      finishTurn(playerId);
      return;
    }

    state.activeCardChoice = {
      cardId: card.id,
      playerId,
      type: 'cash_or_free_property',
      title: card.description,
      options: opts,
      _card: card,
      _deckType: deckType,
    };
    log(`   🎯 $${cashAmount} cash or free city (max $${maxPrice})?`);
    return;
  }

  // Mahkama card ID 15: Pay fine or go to prison
  if (card.id === 15 && card.action === 'choice' && card.choices[0]?.action_type === 'pay_fine') {
    const fineAmount = card.choices[0].amount || 100;
    state.activeCardChoice = {
      cardId: card.id,
      playerId,
      type: 'pay_or_prison',
      title: card.description,
      options: [
        { action: 'pay_fine', label: `💰 ادفع ${fineAmount} جنيه غرامة`, amount: fineAmount },
        { action: 'go_to_prison', label: '🔒 اذهب للسجن' },
      ],
      _card: card,
      _deckType: deckType,
    };
    log(`   🎯 Pay $${fineAmount} fine or go to prison?`);
    return;
  }

  // Fallback for unhandled complex choices
  log(`   ⚠️ Unhandled complex card choice for card ID ${card.id}. Resolving by default.`);
  discardCard(card, deckType);
  checkLiquidation(playerId);
  finishTurn(playerId);
}

export function resolveCardChoice(choiceIndex) {
  const state = getState();
  if (!state.activeCardChoice) return;

  const { cardId, playerId, type, options } = state.activeCardChoice;
  const player = state.players.find(p => p.id === playerId);
  if (!player) { state.activeCardChoice = null; return; }

  const cardRef = state.activeCardChoice._card;
  const deckType = state.activeCardChoice._deckType || 'hazak';

  const clampedIdx = Math.min(choiceIndex, options.length - 1);
  const chosen = options[clampedIdx];

  log(`   ✅ ${player.name} chose: ${chosen.label || chosen.name || 'option ' + (clampedIdx + 1)}`);

  switch (type) {
    case 'move_to_pool': // Hazak card 7
      if (chosen.action === 'goto_property') {
        player.position = chosen.propertyId;
        log(`   🚀 Teleported to ${findSquare(chosen.propertyId)?.name}`);
        // bank_money already applied in applyHazakCard before choice
        discardCard(cardRef, deckType);
        state.activeCardChoice = null;
        evaluateLandingAfterCard(playerId, findSquare(chosen.propertyId));
        return;
      }
      break;

    case 'cash_or_free_property': // Hazak card 15 or Mahkama card 11
      if (chosen.action === 'cash') {
        player.money += chosen.amount;
        log(`   💰 Took $${chosen.amount} → $${player.money}`);
      } else if (chosen.action === 'property') {
        const square = findSquare(chosen.propertyId);
        if (square) {
          square.owner = playerId;
          log(`   🏠 Claimed ${square.name} for free!`);
        }
      }
      discardCard(cardRef, deckType);
      state.activeCardChoice = null;
      checkLiquidation(playerId);
      finishTurn(playerId);
      return;

    case 'pay_or_prison': // Mahkama card 15
      if (chosen.action === 'pay_fine') {
        player.money -= chosen.amount;
        log(`   💰 Paid $${chosen.amount} fine → $${player.money}`);
      } else if (chosen.action === 'go_to_prison') {
        const prisonSquareId = 25;
        player.position = prisonSquareId;
        const prisonSquare = findSquare(prisonSquareId);
        if (prisonSquare) {
          player.statusEffects.missedTurnsRemaining = prisonSquare.rules.max_turns_to_miss;
        }
        log(`   🔒 Went to prison.`);
      }
      discardCard(cardRef, deckType);
      state.activeCardChoice = null;
      checkLiquidation(playerId);
      finishTurn(playerId);
      return;
  }

  // Fallback for any unhandled choice or to clean up
  if (cardRef) {
    discardCard(cardRef, deckType);
  }
  state.activeCardChoice = null;
  checkLiquidation(playerId);
  finishTurn(playerId);
}

function evaluateLandingAfterCard(playerId, square) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player) { finishTurn(playerId); return; }

  // If the player landed on a property owned by someone else, they pay rent.
  if (square.type === 'property' && square.owner !== null && square.owner !== playerId) {
    const rent = calculateRent(square, player);
    player.money -= rent;
    const owner = state.players.find(p => p.id === square.owner);
    if (owner && !owner.isBankrupt) owner.money += rent; // Owner receives rent
    log(`   🏠 Landed on ${square.name} (owned by ${owner?.name}) — paid $${rent} rent → $${player.money}`);
    checkLiquidation(playerId);
  } else if (square.type === 'deck_trigger' || square.type === 'dual_deck_trigger') {
    // If landed on a deck trigger after being teleported by card, draw another card.
    handleDeckTriggerOnTeleport(player, square);
    return; // Don't finish turn yet, card effect will call finishTurn
  } else if (square.type === 'corner_square') {
    handleCornerSquareOnTeleport(player, square);
    return; // Corner effect will call finishTurn
  }
  finishTurn(playerId);
}

function handleDeckTriggerOnTeleport(player, square) {
  const state = getState();
  const deckType = square.deck_type || (square.type === 'dual_deck_trigger' ? 'mahkama' : 'hazak'); // Dual deck draws Mahkama first

  if (square.type === 'dual_deck_trigger') {
    log(`   ⚖️  ${square.name} — drawing TWO cards (teleport triggered)...`);
    const card1 = drawCard('mahkama');
    if (card1) {
      state.pendingSecondCard = true; // Flag to draw a second card (Hazak)
      state.blindCard = { card: card1, playerId: player.id, squareName: square.name, deckType: 'mahkama', cardNumber: 1 };
      state.phase = 'blind_card';
    } else {
      finishTurn(player.id);
    }
  } else {
    log(`   🃏 ${square.name} — drawing a card (teleport triggered)...`);
    const card = drawCard(deckType);
    if (card) {
      state.blindCard = { card, playerId: player.id, squareName: square.name, deckType };
      state.phase = 'blind_card';
    } else {
      finishTurn(player.id);
    }
  }
}

function handleCornerSquareOnTeleport(player, square) {
  const state = getState();
  switch (square.id) {
    case 1: // Start
      player.money += state.gameMeta.passGoSalary;
      log(`   🏁 Landed on Start! +$${state.gameMeta.passGoSalary} → $${player.money}`);
      break;
    case 8: // Club
      log(`   🎰 Nadi El Haz — membership: $${square.membership_cost}, guest fine: $${square.guest_fine_fee}`);
      state.pendingClubChoice = {
        playerId: player.id,
        membershipCost: square.membership_cost,
        guestFineFee: square.guest_fine_fee
      };
      state.phase = 'club_choice';
      break;
    case 18: // Fast Bus (Double next roll)
      player.statusEffects.doubleNextRoll = true;
      log(`   🚌 Al-otobees Al-Saree — next roll doubled!`);
      break;
    case 25: // Jail
      player.statusEffects.missedTurnsRemaining = square.rules.max_turns_to_miss;
      log(`   🔒 Landed in Prison! Miss ${square.rules.max_turns_to_miss} turn(s) or pay $${square.rules.bail_cost} bail. Use a 🔓 jail-free card if you have one.`);
      break;
    default:
      log(`   ℹ️ Corner: ${square.name}`);
  }
  finishTurn(player.id);
}

export function calculateRent(square, player) {
  const buildingCount = square.buildings ? square.buildings.length : 0;
  let rent = square.base_rent;

  if (buildingCount >= 3) rent = square.visitor_paying.market_rent;
  else if (buildingCount >= 2) rent = square.visitor_paying.rest_stop_rent;
  else if (buildingCount >= 1) rent = square.visitor_paying.garage_rent;

  if (player.statusEffects.payHalfRentNextLanding) {
    rent = Math.ceil(rent / 2);
    player.statusEffects.payHalfRentNextLanding = false;
    log(`   💲 Half-price rent! Reduced to $${rent}`);
  }

  return rent;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}


