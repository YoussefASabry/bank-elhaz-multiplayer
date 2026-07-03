import boardData from '../board.json' with { type: 'json' };
import hazakData from '../hazak.json' with { type: 'json' };
import mahkamaData from '../mahkama.json' with { type: 'json' };

let gameState = null;

export function getState() {
  return gameState;
}

export function setState(newState) {
  gameState = newState;
}

export function initState(numPlayers = 3, options = {}) {
  const { startingCash, shuffleDeck } = options;

  const boardSquares = boardData.board_positions.map(sq => {
    if (sq.type === 'property') {
      return { ...sq, owner: null, buildings: [] };
    }
    return { ...sq };
  });

  const hazakDeck = [...hazakData.hazak];
  const mahkamaDeck = [...mahkamaData.mahkama];

  if (shuffleDeck !== false) {
    fisherYatesShuffle(hazakDeck);
    fisherYatesShuffle(mahkamaDeck);
  } else {
    hazakDeck.reverse();
    mahkamaDeck.reverse(); // For sequential testing
  }

  const maxPlayers = boardData.game_meta.max_players;
  const playerCount = Math.min(numPlayers, maxPlayers);
  const cash = startingCash ?? 400;

  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i + 1,
      name: `Player ${i + 1}`,
      position: 1,
      money: cash,
      isHuman: true,
      inventory: { freeCards: 0, jailFreeCards: 0 }, // Changed getOutofPrisonCards to jailFreeCards
      statusEffects: { payHalfRentNextLanding: false, doubleNextRoll: false, missedTurnsRemaining: 0, skipNextTurn: false },
      isBankrupt: false,
      color: ['#ffd700', '#f44336', '#4caf50', '#2196f3', '#ff9800', '#9c27b0'][i],
      _prevMoney: cash, // Added for UI animation tracking
    });
  }

  gameState = {
    gameMeta: {
      maxPlayers: boardData.game_meta.max_players,
      passGoSalary: boardData.game_meta.pass_go_salary,
      bankManagerBonus: boardData.game_meta.bank_manager_bonus
    },
    players,
    currentPlayerIndex: 0,
    boardSquares,
    hazakDeck,
    mahkamaDeck, // Added mahkamaDeck
    hazakDiscard: [], // Added discard pile
    mahkamaDiscard: [], // Added discard pile
    activeCardChoice: null,
    pendingPropertyBuy: null,
    pendingRentPayment: null, // Added pendingRentPayment
    lastRoll: null,
    phase: 'setup',
    isLiquidating: false,
    gameOver: false,
    turnLog: [],

    // Timer
    timerSeconds: 90,
    timerRunning: false,

    // Blind card
    blindCard: null,
    pendingSecondCard: false, // Added for dual deck triggers

    // Animation path
    animationPath: null,
    animationPlayerId: null,

    // Property inspect
    inspectSquareId: null,

    // Club
    pendingClubChoice: null,

    // Bids
    activeBids: [],
    pendingCityOwnersCard: null, // Added for specific Mahkama card effect

    // Trade
    tradeProposal: null,
    tradeConfirmations: {},
  };

  return gameState;
}

export function findSquare(id) {
  if (!gameState) return null;
  if (Array.isArray(id)) {
    return id.map(sid => gameState.boardSquares.find(sq => sq.id === sid)).filter(Boolean);
  }
  return gameState.boardSquares.find(sq => sq.id === id);
}

export function getSquareName(id) {
  const sq = findSquare(id);
  return sq ? sq.name : `Unknown(${id})`;
}

export function getBuildingCosts(square) {
  return {
    garage: Math.round(square.purchase_price * 0.5),
    rest_stop: Math.round(square.purchase_price * 0.8),
    market: Math.round(square.purchase_price * 1.2)
  };
}

function fisherYatesShuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
