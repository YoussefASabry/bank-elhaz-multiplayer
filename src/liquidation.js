import { getState, findSquare } from './state.js';
import { log } from './utils.js';

export function checkLiquidation(playerId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.isBankrupt) return false;

  if (player.money < 0) {
    state.isLiquidating = true;
    log(`⚠️  Player ${playerId} (${player.name}) is in debt ($${player.money}). Liquidation required.`);
    return true;
  }
  return false;
}

export function getOwnedProperties(playerId) {
  const state = getState();
  return state.boardSquares.filter(sq => sq.owner === playerId);
}

export function sellBuildingToBank(playerId, propertyId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  const square = findSquare(propertyId);

  if (!square || square.owner !== playerId) {
    log(`❌ Cannot sell building: property ${propertyId} not owned by Player ${playerId}`);
    return false;
  }

  if (!square.buildings || square.buildings.length === 0) {
    log(`❌ No buildings on ${square.name} to sell`);
    return false;
  }

  const topBuilding = square.buildings.pop();
  let constructionCost = 0;
  // This logic is duplicated in getBuildingCosts in state.js and engine.js
  // For consistency, let's keep it local for now, but ideally this would be a shared helper.
  if (topBuilding === 'garage') constructionCost = Math.round(square.purchase_price * 0.5);
  else if (topBuilding === 'rest_stop') constructionCost = Math.round(square.purchase_price * 0.8);
  else if (topBuilding === 'market') constructionCost = Math.round(square.purchase_price * 1.2);

  const refund = Math.round(constructionCost * 0.75);
  player.money += refund;
  log(`💰 Sold ${topBuilding} on ${square.name} for $${refund} (75% of $${constructionCost})`);
  log(`   New balance: $${player.money}`);

  return true;
}

export function sellPropertyToBank(playerId, propertyId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  const square = findSquare(propertyId);

  if (!square || square.owner !== playerId) {
    log(`❌ Cannot sell: property ${propertyId} not owned by Player ${playerId}`);
    return false;
  }

  while (square.buildings && square.buildings.length > 0) {
    sellBuildingToBank(playerId, propertyId);
  }

  const refund = Math.round(square.purchase_price * 0.75);
  player.money += refund;
  square.owner = null;
  square.buildings = [];
  log(`🏠 Sold ${square.name} back to bank for $${refund}`);
  log(`   New balance: $${player.money}`);

  if (player.money >= 0) {
    state.isLiquidating = false;
    log(`✅ Player ${playerId} is out of debt!`);
  }

  return true;
}

export function declareBankruptcy(playerId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);

  if (!player) return;

  player.isBankrupt = true;
  player.money = 0;
  state.isLiquidating = false;

  // Release all properties and jail-free cards
  state.boardSquares.forEach(sq => {
    if (sq.owner === playerId) {
      sq.owner = null;
      sq.buildings = [];
    }
  });
  player.inventory.jailFreeCards = 0; // Clear jail free cards
  player.inventory.freeCards = 0; // Clear free play cards
  player.statusEffects.missedTurnsRemaining = 0; // Clear prison status

  log(`💀 Player ${playerId} (${player.name}) has declared bankruptcy and is out of the game.`);

  const activePlayers = state.players.filter(p => !p.isBankrupt);
  if (activePlayers.length <= 1) {
    state.gameOver = true;
    if (activePlayers.length === 1) {
      log(`🏆 ${activePlayers[0].name} wins the game!`);
    } else {
      log(`🏁 Game over — no players remaining.`);
    }
  }
}
