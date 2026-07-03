import { initState, getState } from './src/state.js';
import { computeRoll, applyLanding, resolveClubChoice, resolvePropertyPurchase, resolveRentPayment, sellBuilding, sellPropertyToBank } from './src/engine.js'; // Import engine functions
import { revealBlindCard, resolveCardChoice } from './src/deck.js'; // Import deck functions
import { skipPrisonTurn, payBail, advanceTurn } from './src/turn.js'; // Import turn functions
import { log, clearLogs, getLogs } from './src/utils.js';

clearLogs();

log('═══════════════════════════════════════════════════');
log('  ULTIMATE STRESS TEST — Bank El Haz Engine');
log('═══════════════════════════════════════════════════');
log(`  Starting Capital: $400`);
log(`  Max Turns: 200`);
log(`  Deck Mode: Sequential (Hazak 1→15 loop, Mahkama 1→15 loop)`);
log(`  Mahkama Tiles: Now drawing from Mahkama deck`);
log('═══════════════════════════════════════════════════\n');

initState(3, { startingCash: 400, shuffleDeck: false }); // Use the new initState

const state = getState();

state.players.forEach(p => {
  log(`🔵 ${p.name}: $${p.money} starting capital`);
});

log(`📦 Hazak Deck order (sequential): ${state.hazakDeck.map(c => `#${c.id}`).join(', ')}`);
log(`📦 Mahkama Deck order (sequential): ${state.mahkamaDeck.map(c => `#${c.id}`).join(', ')}`);

let turnCount = 0;
const maxTurns = 200;

while (!state.gameOver && turnCount < maxTurns) {
  turnCount++;
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (!currentPlayer.isBankrupt) {
    // Simulate a roll and landing
    const rollResult = computeRoll(currentPlayer.id);
    if (rollResult) {
      if (rollResult.wasDoubleActive) log(`✈️ Double roll active! Steps doubled to ${rollResult.steps}`);
      log(`   🎲 Rolled: ${rollResult.die1} + ${rollResult.die2} = ${rollResult.total}`);
      applyLanding(rollResult);
    }

    // Auto-resolve any pending actions triggered by landing
    let autoResolveDepth = 0;
    const maxResolveDepth = 10; // Prevent infinite loops in complex card chains

    while (state.phase !== 'roll' && state.phase !== 'done' && !state.gameOver && autoResolveDepth < maxResolveDepth) {
      autoResolveDepth++;
      if (state.blindCard) {
        log(`⚡ Auto-resolving blind card for player ${currentPlayer.name}`);
        revealBlindCard();
      } else if (state.activeCardChoice) {
        log(`⚡ Auto-resolving card choice — selecting option 0`);
        resolveCardChoice(0);
      } else if (state.pendingRentPayment) {
        log(`⚡ Auto-paying rent for player ${currentPlayer.name}`);
        resolveRentPayment();
      } else if (state.pendingPropertyBuy) {
        log(`⚡ Auto-declining property purchase for player ${currentPlayer.name}`);
        resolvePropertyPurchase(false); // Decline by default
      } else if (state.pendingClubChoice) {
        log(`⚡ Auto-choosing 'guest' for club for player ${currentPlayer.name}`);
        resolveClubChoice('guest'); // Choose guest by default
      } else if (currentPlayer.statusEffects.missedTurnsRemaining > 0 && state.phase === 'prison') {
        log(`⚡ Auto-skipping prison turn for player ${currentPlayer.name}`);
        skipPrisonTurn(currentPlayer.id);
      } else if (currentPlayer.statusEffects.skipNextTurn && state.phase === 'skip_turn') {
        log(`⚡ Auto-skipping turn due to card effect for player ${currentPlayer.name}`);
        advanceTurn(); // Advance turn, effect is cleared internally
      } else {
        // If nothing else to resolve, advance turn
        if (state.phase !== 'done' && !state.gameOver) {
          advanceTurn();
        }
      }
    }
  } else {
    advanceTurn(); // Bankrupt players just advance turn
  }
}

log('\n═══════════════════════════════════════════════════');
log('  STRESS TEST RESULTS');
log('═══════════════════════════════════════════════════');

if (state.gameOver) {
  const winner = state.players.find(p => !p.isBankrupt);
  if (winner) {
    log(`  🏆 WINNER: ${winner.name} after ${turnCount} turns`);
  } else {
    log(`  💀 Game Over — all players bankrupt after ${turnCount} turns`);
  }
} else {
  log(`  ⏹️  Simulation stopped after ${maxTurns} turns (game still in progress)`);
}

log('\n  Final Player Standings:');
state.players.forEach(p => {
  const status = p.isBankrupt ? '💀 BANKRUPT' : '🔵 ACTIVE';
  const props = state.boardSquares.filter(s => s.owner === p.id);
  log(`  ${status} ${p.name}: $${p.money} | Properties: ${props.map(s => s.name).join(', ') || 'none'}`);
  log(`   Jail Free Cards: ${p.inventory.jailFreeCards}, Free Cards: ${p.inventory.freeCards}`);
});

log('\n  Card draw cycle verification:');
const drawnHazakCards = getLogs().filter(l => l.includes('drawing a Hazak card') || l.includes('reveals:'));
const hazakCardCounts = {};
drawnHazakCards.forEach(l => {
  const m = l.match(/Card #(\d+)/);
  if (m) {
    const id = m[1];
    hazakCardCounts[id] = (hazakCardCounts[id] || 0) + 1;
  }
});
log('  Hazak Cards Drawn:');
Object.entries(hazakCardCounts).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([id, count]) => {
  log(`  Card #${id}: drawn ${count} time(s)`);
});

const drawnMahkamaCards = getLogs().filter(l => l.includes('drawing a Mahkama card'));
const mahkamaCardCounts = {};
drawnMahkamaCards.forEach(l => {
  const m = l.match(/Card #(\d+)/);
  if (m) {
    const id = m[1];
    mahkamaCardCounts[id] = (mahkamaCardCounts[id] || 0) + 1;
  }
});
log('  Mahkama Cards Drawn:');
Object.entries(mahkamaCardCounts).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([id, count]) => {
  log(`  Card #${id}: drawn ${count} time(s)`);
});


log('\n═══════════════════════════════════════════════════');
