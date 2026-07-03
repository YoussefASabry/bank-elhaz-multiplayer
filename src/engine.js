import { getState, findSquare, getSquareName } from './state.js';
import { rollDice, calculateNewPosition, didPassGo } from './dice.js';
import { drawCard, handleCardEffect, calculateRent } from './deck.js'; // Removed setupCardChoices, resolveCardChoice - moved to engine or deck
import { checkLiquidation } from './liquidation.js';
import { finishTurn } from './turn.js'; // Removed advanceTurn - only finishTurn in here
import { log } from './utils.js';

export function computeRoll(playerId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.isBankrupt) return null;

  const { die1, die2, total, isDouble } = rollDice();

  let steps = total;
  let wasDoubleActive = false;
  if (player.statusEffects.doubleNextRoll) {
    steps *= 2;
    player.statusEffects.doubleNextRoll = false;
    wasDoubleActive = true;
  }

  const oldPos = player.position;
  const newPos = calculateNewPosition(oldPos, steps);
  const passedGo = didPassGo(oldPos, newPos);

  const path = [];
  let cursor = oldPos;
  for (let i = 0; i < steps; i++) {
    cursor = calculateNewPosition(cursor, 1);
    path.push(cursor);
  }

  return {
    die1, die2, total, isDouble, wasDoubleActive,
    oldPos, newPos, steps, passedGo, path, playerId
  };
}

export function applyLanding(rollResult) {
  const state = getState();
  const { playerId, newPos, passedGo } = rollResult; // Removed oldPos, as it's not directly used here
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.isBankrupt) {
    finishTurn(playerId);
    return;
  }

  state.lastRoll = rollResult;
  player.position = newPos;

  if (passedGo) {
    player.money += state.gameMeta.passGoSalary;
    log(`   🏁 ${player.name} passed GO! +$${state.gameMeta.passGoSalary} → $${player.money}`);
  }

  const landedSquare = findSquare(newPos);
  if (!landedSquare) {
    log(`   ⚠️  Landed on undefined position ${newPos}`);
    finishTurn(playerId);
    return;
  }

  evaluateLanding(player, landedSquare);
}

function evaluateLanding(player, square) {
  const state = getState();
  log(`   📍 Landed on: ${square.name} (type: ${square.type})`);

  switch (square.type) {
    case 'property':
      handlePropertyLanding(player, square);
      break;
    case 'deck_trigger':
      handleDeckTrigger(player, square);
      break;
    case 'dual_deck_trigger':
      handleDualDeckTrigger(player, square);
      break;
    case 'corner_square':
      handleCornerSquare(player, square);
      break;
    default:
      log(`   ℹ️  No special action for this square type`);
      finishTurn(player.id);
  }
}

function handlePropertyLanding(player, square) {
  const state = getState();

  if (square.owner === null) {
    log(`   🏠 ${square.name} is unowned — price: $${square.purchase_price}`);
    if (player.money >= square.purchase_price) {
      state.pendingPropertyBuy = { square, playerId: player.id };
      state.phase = 'property_choice';
      log('   ⏸️  Buy or decline?');
    } else {
      log(`   ❌ Cannot afford $${square.purchase_price} (have $${player.money})`);
      finishTurn(player.id);
    }
  } else if (square.owner === player.id) {
    log(`   🏠 ${player.name} owns this property`);
    finishTurn(player.id);
  } else {
    const owner = state.players.find(p => p.id === square.owner);
    const rent = calculateRent(square, player);
    state.pendingRentPayment = { playerId: player.id, ownerId: owner?.id, amount: rent, squareName: square.name };
    state.phase = 'rent_payment';
    log(`   💸 Owes $${rent} rent to ${owner ? owner.name : 'Bank'} on ${square.name}`);
  }
}

export function resolveRentPayment() {
  const state = getState();
  if (!state.pendingRentPayment) return;
  const { playerId, ownerId, amount } = state.pendingRentPayment;
  const player = state.players.find(p => p.id === playerId);
  const owner = state.players.find(p => p.id === ownerId);
  state.pendingRentPayment = null;
  if (!player) { finishTurn(playerId); return; }
  const canPay = Math.min(amount, Math.max(0, player.money));
  player.money -= canPay;
  if (owner && !owner.isBankrupt) owner.money += canPay;
  log(`   💸 Paid $${canPay} rent to ${owner ? owner.name : 'Bank'} → $${player.money}`);
  checkLiquidation(playerId);
  finishTurn(playerId);
}

export function resolveClubChoice(choice) {
  const state = getState();
  if (!state.pendingClubChoice) return;
  const { playerId, membershipCost, guestFineFee } = state.pendingClubChoice;
  const player = state.players.find(p => p.id === playerId);
  state.pendingClubChoice = null;

  if (choice === 'membership' && player && player.money >= membershipCost) {
    player.money -= membershipCost;
    log(`   ✅ ${player.name} joined the club for $${membershipCost} → $${player.money}`);
  } else if (choice === 'guest' && player && player.money >= guestFineFee) {
    player.money -= guestFineFee;
    log(`   🚪 ${player.name} paid guest fine $${guestFineFee} → $${player.money}`);
  } else if (player) {
    log(`   ❌ ${player.name} cannot afford the club`);
  }
  checkLiquidation(playerId);
  finishTurn(playerId);
}

export function resolvePropertyPurchase(shouldBuy) {
  const state = getState();
  if (!state.pendingPropertyBuy) return;
  const { square, playerId } = state.pendingPropertyBuy;
  const player = state.players.find(p => p.id === playerId);
  state.pendingPropertyBuy = null;

  if (shouldBuy && player && player.money >= square.purchase_price) {
    square.owner = playerId;
    player.money -= square.purchase_price;
    log(`   ✅ ${player.name} bought ${square.name} for $${square.purchase_price} → $${player.money}`);
  } else {
    log(`   ❌ ${player.name} declined/ignored ${square.name}`);
  }
  checkLiquidation(playerId);
  finishTurn(playerId);
}

function handleDeckTrigger(player, square) {
  log(`   🃏 ${square.name} — drawing a Hazak card...`);

  const card = drawCard('hazak'); // Specify Hazak deck
  if (card) {
    const state = getState();
    state.blindCard = { card, playerId: player.id, squareName: square.name, deckType: 'hazak' }; // Specify deckType
    state.phase = 'blind_card';
  } else {
    finishTurn(player.id);
  }
}

function handleDualDeckTrigger(player, square) {
  log(`   ⚖️  ${square.name} — drawing a Mahkama card first...`);

  const card1 = drawCard('mahkama'); // Draw from Mahkama deck first
  if (card1) {
    const state = getState();
    state.pendingSecondCard = true; // Flag to draw a second card (Hazak) later
    state.blindCard = { card: card1, playerId: player.id, squareName: square.name, deckType: 'mahkama', cardNumber: 1 }; // Specify deckType
    state.phase = 'blind_card';
  } else {
    finishTurn(player.id);
  }
}

function handleCornerSquare(player, square) {
  const state = getState();

  switch (square.id) {
    case 1:
      player.money += state.gameMeta.passGoSalary;
      log(`   🏁 Landed on start! +$${state.gameMeta.passGoSalary} → $${player.money}`);
      finishTurn(player.id);
      break;
    case 8:
      log(`   🎰 Nadi El Haz — membership: $${square.membership_cost}, guest fine: $${square.guest_fine_fee}`);
      state.pendingClubChoice = {
        playerId: player.id,
        membershipCost: square.membership_cost,
        guestFineFee: square.guest_fine_fee
      };
      state.phase = 'club_choice';
      break;
    case 18:
      player.statusEffects.doubleNextRoll = true;
      log(`   🚌 Al-otobees Al-Saree — next roll doubled!`);
      finishTurn(player.id);
      break;
    case 25:
      player.statusEffects.missedTurnsRemaining = square.rules.max_turns_to_miss;
      log(`   🔒 Prison! Miss ${square.rules.max_turns_to_miss} turn(s) or pay $${square.rules.bail_cost} bail. Use a 🔓 jail-free card if you have one.`);
      finishTurn(player.id);
      break;
    default:
      log(`   ℹ️  Corner: ${square.name}`);
      finishTurn(player.id);
  }
}

export function sellBuilding(playerId, propertyId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  const square = findSquare(propertyId);
  if (!square || square.owner !== playerId || !square.buildings || square.buildings.length === 0) {
    return false;
  }
  const top = square.buildings.pop();
  const costs = { garage: Math.round(square.purchase_price * 0.5), rest_stop: Math.round(square.purchase_price * 0.8), market: Math.round(square.purchase_price * 1.2) };
  const refund = Math.round(costs[top] * 0.75);
  player.money += refund;
  log(`   🏗️  Sold ${top} on ${square.name} for $${refund}`);
  return true;
}

export function sellPropertyToBank(playerId, propertyId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  const square = findSquare(propertyId);
  if (!square || square.owner !== playerId) return false;
  while (square.buildings && square.buildings.length > 0) {
    const top = square.buildings.pop();
    const costs = { garage: Math.round(square.purchase_price * 0.5), rest_stop: Math.round(square.purchase_price * 0.8), market: Math.round(square.purchase_price * 1.2) };
    const refund = Math.round(costs[top] * 0.75);
    player.money += refund;
  }
  const salePrice = Math.round(square.purchase_price * 0.75);
  player.money += salePrice;
  square.owner = null;
  square.buildings = [];
  log(`   🏠 Sold ${square.name} to bank for $${salePrice}`);
  if (player.money >= 0 && state.isLiquidating) {
    state.isLiquidating = false;
    log(`   ✅ ${player.name} is out of debt!`);
  }
  return true;
}
