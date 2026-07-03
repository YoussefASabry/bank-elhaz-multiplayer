import { getState, findSquare } from './state.js'; // Added findSquare
import { drawCard } from './deck.js';
import { log } from './utils.js';

export function finishTurn(playerId) {
  const state = getState();

  // Safety: only the current player can finish their turn
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (currentPlayer && currentPlayer.id !== playerId) {
    return;
  }

  if (state.pendingClubChoice) {
    state.phase = 'club_choice';
    return;
  }

  // Handle drawing the second card for dual deck triggers
  if (state.pendingSecondCard) {
    doSecondCard(playerId);
    return;
  }

  if (state.pendingPropertyBuy) {
    state.phase = 'property_choice';
    return;
  }

  // If a card choice is active for the current player, wait for their input
  if (state.activeCardChoice) {
    const player = state.players.find(p => p.id === playerId);
    if (player && player.isHuman) { // Only pause for human players
      state.phase = 'card_choice';
      return;
    }
  }

  // If a Mahkama card triggered a collect_from_city_owners, wait for UI confirmation
  if (state.pendingCityOwnersCard) {
    // This is handled by the UI and confirmBlindCard button now
    state.phase = 'blind_card'; // Re-use blind_card phase to wait for confirm
    return;
  }

  state.phase = 'done';
  advanceTurn();
}

function doSecondCard(playerId) {
  const state = getState();
  state.pendingSecondCard = false;
  // Second card for dual deck is always Hazak
  const card2 = drawCard('hazak');
  if (card2) {
    state.blindCard = { card: card2, playerId, squareName: 'المحكمة أو حظك', deckType: 'hazak', cardNumber: 2 };
    state.phase = 'blind_card';
  } else {
    log(`   ⚠️ Second Hazak card deck is empty!`);
    finishTurn(playerId);
  }
}

export function advanceTurn() {
  const state = getState();
  const activePlayers = state.players.filter(p => !p.isBankrupt);

  if (activePlayers.length <= 1) {
    state.gameOver = true;
    state.phase = 'done';
    if (activePlayers.length === 1) {
      log(`\n🏆 ${activePlayers[0].name} wins the game!`);
    } else {
      log(`\n🏁 Game over — no active players remaining.`);
    }
    return;
  }

  let nextPlayerFound = false;
  let attempts = 0;
  const maxAttempts = state.players.length * 2; // Prevent infinite loop in case of logic error

  do {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
    const nextPlayer = state.players[state.currentPlayerIndex];
    attempts++;

    if (nextPlayer.isBankrupt) {
      continue; // Skip bankrupt players
    }

    if (nextPlayer.statusEffects.skipNextTurn) {
      log(`   ⏭️ ${nextPlayer.name} is skipping their turn.`);
      nextPlayer.statusEffects.skipNextTurn = false; // Reset effect
      continue; // Skip this player's turn entirely
    }

    nextPlayerFound = true; // Found a valid player for the next turn

  } while (!nextPlayerFound && attempts < maxAttempts);

  if (!nextPlayerFound) {
    log(`   ❌ No active player found for next turn, ending game.`);
    state.gameOver = true;
    state.phase = 'done';
    return;
  }

  state.phase = 'roll';
  state.timerSeconds = 90;
  state.timerRunning = true;
  const nextPlayer = state.players[state.currentPlayerIndex];
  log(`\n🎲 --- ${nextPlayer.name}'s Turn ---`);
}

export function skipPrisonTurn(playerId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.statusEffects.missedTurnsRemaining <= 0) return;
  player.statusEffects.missedTurnsRemaining--;
  log(`   😴 ${player.name} is in prison — ${player.statusEffects.missedTurnsRemaining} turns remaining`);
  if (player.statusEffects.missedTurnsRemaining <= 0) {
    log(`   🔓 ${player.name} is free!`);
    state.phase = 'roll';
    return;
  }
  finishTurn(playerId);
}

export function payBail(playerId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.statusEffects.missedTurnsRemaining <= 0) return;
  const square = findSquare(25); // Prison square
  const bailCost = square ? square.rules.bail_cost : 50;
  if (player.money >= bailCost) {
    player.money -= bailCost;
    player.statusEffects.missedTurnsRemaining = 0;
    log(`   🔓 ${player.name} paid $${bailCost} bail and is free!`);
    state.phase = 'roll';
  } else {
    log(`   ❌ ${player.name} cannot afford bail (need $${bailCost}, have $${player.money})`);
  }
}

export function useJailFreeCard(playerId) {
  const state = getState();
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.statusEffects.missedTurnsRemaining <= 0) return;
  if (player.inventory.jailFreeCards > 0) {
    player.inventory.jailFreeCards--;
    player.statusEffects.missedTurnsRemaining = 0;
    log(`   🔓 ${player.name} used a Get Out of Prison Free card!`);
    state.phase = 'roll';
  } else {
    log(`   ❌ ${player.name} has no jail-free cards!`);
  }
}
