# 🏦 Bank El Haz (بنك الحظ) — Complete Handoff

## Project Overview

An Arabic-themed Monopoly-like board game built as a web app. Players buy/sell properties across Middle Eastern/North African cities, draw chance cards (Hazak / حظك and Mahkama / المحكمة), build buildings (garage → rest stop → market), go to prison, trade, bid, and try to bankrupt opponents.

**Two modes:**
- **Single-player (offline hot-seat):** `index.html` at root — uses local JS modules (`src/`)
- **Multiplayer (online, 2–6 players):** `multiplayer/index.html` — uses Socket.IO + Node.js server

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | Vanilla JS (ES modules), HTML5, CSS3 |
| Build tool | Vite 6 (both root and multiplayer) |
| Backend | Node.js, Express, Socket.IO 4 |
| State | In-memory (no database) |
| Module format | ESM (`"type": "module"`) |

---

## Directory Structure

```
Bank Elhaz/
├── index.html            # Single-player hot-seat game (1868 lines)
├── index.js              # Placeholder (just console.log)
├── package.json          # Root: vite dev server
├── board.json            # Board positions (34 squares)
├── hazak.json            # Hazak (حظك) deck — 15 cards
├── mahkama.json          # Mahkama (المحكمة) deck — 15 cards
├── stress.js             # Automated test script
├── stress-test-output.txt / stress-test-complete.txt  # Test results
├── src/                  # Single-player game engine modules
│   ├── state.js          # initState, getState, findSquare, getBuildingCosts
│   ├── engine.js         # computeRoll, applyLanding, evaluateLanding, selling
│   ├── deck.js           # drawCard, handleCardEffect, resolveCardChoice, calculateRent (633 lines, most complex)
│   ├── turn.js           # finishTurn, advanceTurn, skipPrisonTurn, payBail, useJailFreeCard
│   ├── dice.js           # rollDice, calculateNewPosition, didPassGo
│   ├── liquidation.js    # checkLiquidation, sellBuildingToBank, sellPropertyToBank, declareBankruptcy
│   ├── main.js           # Empty (game controller inlined in index.html)
│   └── utils.js          # log, getLogs, clearLogs
├── multiplayer/          # Multiplayer server + client
│   ├── index.html        # Multiplayer client (2643 lines)
│   ├── package.json      # Dependencies: express, socket.io, cors, vite
│   ├── server.js         # Node.js server (Socket.IO + Express, 421 lines)
│   ├── roomManager.js    # Room management, turn timer, trade, bids (708 lines)
│   ├── gameEngine.js     # Server-side game logic — duplicate of src/ (914 lines)
│   ├── board.json        # Same as root board.json
│   ├── hazak.json        # Same as root hazak.json
│   ├── mahkama.json      # Same as root mahkama.json
│   ├── vite.config.js    # Vite config: proxy /socket.io → :3001
│   ├── dist/             # Pre-built client for deployment
│   └── src/              # (empty/maybe unused)
└── .opencode/            # opencode AI config
```

---

## Board Layout

34 positions in a circle, grid rendered via CSS Grid (11 columns × 8 rows).

| Position | Name | Type | Notes |
|----------|------|------|-------|
| 1 | البداية (Start) | Corner square | Pass Go: +$350 salary |
| 2 | القدس (Jerusalem) | Property | Purple, $300 |
| 3 | غزة (Gaza) | Property | Purple, $250 |
| 4 | المحكمة أو حظك | Dual deck trigger | Draw Mahkama then Hazak |
| 5 | بيروت (Beirut) | Property | Pink, $300 |
| 6 | الرياض (Riyadh) | Property | Pink, $250 |
| 7 | بغداد (Baghdad) | Property | Pink, $250 |
| 8 | نادي الحظ (Club) | Corner square | Membership $150, guest fine $20 |
| 9 | بني غازي (Benghazi) | Property | Orange, $150 |
| 10 | عدن (Aden) | Property | Orange, $100 |
| 11 | المحكمة | Deck trigger | Mahkama card |
| 12 | البحرين (Bahrain) | Property | Orange, $90 |
| 13 | حظك | Deck trigger | Hazak card |
| 14 | الدار البيضاء (Casablanca) | Property | Yellow, $250 |
| 15 | تونس (Tunis) | Property | Yellow, $200 |
| 16 | محطة بنزين (Gas Station) | Property | Utility, $300 |
| 17 | الجزائر (Algiers) | Property | Yellow, $300 |
| 18 | الأتوبيس السريع (Fast Bus) | Corner square | Double next roll |
| 19 | حلب (Aleppo) | Property | Brown, $300 |
| 20 | الاسكندرية (Alexandria) | Property | Brown, $325 |
| 21 | المحكمة | Deck trigger | Mahkama card |
| 22 | أسوان (Aswan) | Property | Green, $200 |
| 23 | دمشق (Damascus) | Property | Green, $350 |
| 24 | القاهرة (Cairo) | Property | Green, $450 |
| 25 | السجن (Prison) | Corner square | Miss 2 turns or pay $50 bail |
| 26 | الخرطوم (Khartoum) | Property | Cyan, $200 |
| 27 | عمان (Amman) | Property | Cyan, $250 |
| 28 | الأقصر (Luxor) | Property | White, $200 |
| 29 | بور سعيد (Port Said) | Property | Cyan, $250 |
| 30 | حظك | Deck trigger | Hazak card |
| 31 | صنعاء (Sana'a) | Property | Red, $250 |
| 32 | المحكمة | Deck trigger | Mahkama card |
| 33 | الكويت (Kuwait) | Property | Red, $250 |
| 34 | قطر (Qatar) | Property | Red, $150 |

---

## Single-Player Architecture (`src/`)

### State Flow

```
index.html (UI)
  → imports src/state.js, src/engine.js, src/deck.js, src/turn.js, src/liquidation.js, src/utils.js
  → calls initState() from state.js
  → phase starts at 'setup', then 'roll'
  → rollDice() in index.html calls computeRoll() from engine.js
  → applyLanding() → evaluateLanding() → handlePropertyLanding/handleDeckTrigger/handleCornerSquare
  → finishTurn() from turn.js → advanceTurn()
  → updateUI() renders everything
```

### State Object (from `state.js`)

```javascript
{
  gameMeta: { maxPlayers, passGoSalary, bankManagerBonus },
  players: [{ id, name, position, money, isHuman, inventory: { freeCards, jailFreeCards },
              statusEffects: { payHalfRentNextLanding, doubleNextRoll, missedTurnsRemaining, skipNextTurn },
              isBankrupt, color, _prevMoney }],
  currentPlayerIndex, boardSquares, hazakDeck, mahkamaDeck,
  mahkamaDiscard, hazakDiscard, activeCardChoice, pendingPropertyBuy,
  pendingRentPayment, lastRoll, phase, isLiquidating, gameOver,
  turnLog, timerSeconds, timerRunning, blindCard, pendingSecondCard,
  animationPath, animationPlayerId, inspectSquareId, pendingClubChoice,
  activeBids, pendingCityOwnersCard, tradeProposal, tradeConfirmations
}
```

### Phases

| Phase | Meaning |
|-------|---------|
| `setup` | Game just started |
| `roll` | Waiting for current player to roll |
| `rolling` | Dice animation in progress |
| `property_choice` | Player must buy/decline property |
| `rent_payment` | Player must pay rent |
| `blind_card` | Player has drawn a card, must reveal |
| `card_choice` | Player must choose from card options |
| `club_choice` | Player must choose membership/guest |
| `done` | Turn done, advancing to next player |

---

## Card Decks

### Hazak Deck (حظك) — 15 cards

Chance-type cards. Mix of:
- **Bank money:** +$200, +$100, +$50, -$100, -$150
- **Collect from players:** +$30 from each, +$50 from each
- **Movement:** Move back 5, move forward 4, teleport to specific city, teleport to Go
- **Free play card:** Free next game (freeCards)
- **Jail-free card:** getOutOfPrisonCards (stored as jailFreeCards)
- **Half rent:** Pay half rent next landing
- **Choices (cards 7, 15):**
  - Card 7: Move to one of 3 random cities, get $100
  - Card 15: Take $150 cash OR claim a free unowned property (from fixed pool: 9, 10, 12, 34)

### Mahkama Deck (المحكمة) — 15 cards

Court-themed cards. Uses a unified `action` field:
- `collect_from_players`: Take $25 from each player
- `pay_bank` / `receive_bank`: Pay/receive set amount
- `go_to_jail`: Teleport to prison square 25
- `receive_jail_free_card`: +1 jailFreeCard
- `bank_pays_per_building`: $25 per building owned
- `pay_repairs`: Pay per building type (market $100, rest_stop $50, garage $25)
- `collect_from_city_owners`: Pick 3 random owned cities, $50 from each unique owner
- `choice` (cards 11, 15):
  - Card 11: Choose a free property ≤$150 OR take $100 cash
  - Card 15: Pay $100 fine OR go to prison
- `skip_turn_and_pay`: Pay $50 + skip next turn

---

## Building System

Three building levels, built in order:

| Level | Cost (% of purchase price) | Sell refund (75% of cost) |
|-------|---------------------------|--------------------------|
| Garage | 50% | 37.5% |
| Rest Stop | 80% | 60% |
| Market | 120% | 90% |

Rent is calculated based on building count (0 → base_rent, 1 → garage_rent, 2 → rest_stop_rent, 3+ → market_rent). Rent has separate `visitor_paying` and `owner_paying` values. Currently only `visitor_paying` is used.

---

## Corner Squares

| ID | Square | Effect |
|----|--------|--------|
| 1 | Start | +$350 pass-go salary |
| 8 | Nady El Haz | Club choice: membership $150 or guest $20 |
| 18 | Al-Otobees Al-Saree | Next roll doubled |
| 25 | Prison | Miss 2 turns. Options: skip turn (auto-decrement), pay $50 bail, or use jail-free card |

---

## Prison System

- **Entry:** Landing on square 25 (corner) or Mahkama card 5/6 (go_to_jail)
- `missedTurnsRemaining` starts at 2 (from `max_turns_to_miss` in board.json)
- **Options each turn (in the `updateUI` prison-actions bar):**
  1. **Skip** — decrements `missedTurnsRemaining`, calls `finishTurn` which advances to next player if still in prison
  2. **Pay Bail ($50)** — `payBail()` in turn.js, sets `missedTurnsRemaining = 0`, phase back to 'roll'
  3. **Use Jail-Free Card** — `useJailFreeCard()` in turn.js, consumes one `jailFreeCards`, sets free
- **Auto-pass (timer expiry):** `skipPrisonTurn()` is called (decrement + finishTurn)

---

## Multiplayer Architecture

```
Client (browser)              Server (Node.js)
    │                              │
    ├── socket.emit('roll_dice') ──┤
    │                              ├── roomManager.handleRollDice()
    │                              ├── gameEngine.computeRoll()
    ├── socket.on('dice_rolled') ←─┤ (broadcast to room)
    │                              │
    ├── animate car across board   │
    │                              │
    ├── socket.emit('confirm_landing') ──┤
    │                              ├── roomManager.handleLanding()
    │                              ├── gameEngine.evaluateLanding()
    │                              ├── broadcast state_update
    └── updateUI() ←──────────────┘
```

### Server Components

**`server.js`** (421 lines)
- Express + Socket.IO on port 3001
- Serves static files from `dist/` (fallback to `.`)
- Handles all socket events: lobby, game actions, trade, bid, prison
- Key: `broadcastState()` emits `state_update` to all players in room
- Key: `actionLog()` emits log messages

**`roomManager.js`** (708 lines)
- `RoomManager` class with `rooms` Map
- Room lifecycle: create, join, leave, destroy
- Turn timer: 90-second countdown per turn with `autoPass()` fallback
- Game lifecycle: `startGame()` creates `GameEngine`, emits `game_started`
- Trade system: mutual proposal (A proposes → B reviews/accepts → B proposes → A reviews/accepts → execute)
- Bid system: players post bids with cash/props, others respond with offers

**`gameEngine.js`** (914 lines)
- Self-contained duplicate of `src/` modules combined into a single class
- Contains: `computeRoll`, `evaluateLanding`, card handling, prison, etc.
- Notable differences from client: `handleCardEffect` has a `switch(card.action)` that directly maps to methods; no separate `turn.js` — `finishTurn` and `advanceTurn` are methods

---

## Features Implemented

### Core Game
- [x] Dice roll (1 or 2 dice via options.diceCount)
- [x] Double roll effect (square 18)
- [x] Pass Go salary ($350)
- [x] Property purchase
- [x] Rent payment (building-dependent)
- [x] Half-price rent status effect
- [x] Building construction (garage → rest stop → market)
- [x] Building/property sale (75% refund)
- [x] Prison (miss 2 turns, bail, jail-free card)
- [x] Bankruptcy and liquidation
- [x] Game over detection (last player standing)

### Card System
- [x] Two decks with reshuffle from discard
- [x] Card choices (pick from options)
- [x] Dual deck triggers (draw from both decks)
- [x] Teleportation via cards
- [x] Bank pays/receives money
- [x] Collect from all players
- [x] Collect from specific city owners
- [x] Repair costs per building
- [x] Free property claiming
- [x] Jail-free card collection
- [x] Skip next turn effect

### UI
- [x] CSS Grid board layout (34 cells)
- [x] Player tokens (colored circles with avatar images)
- [x] Property ownership indicators (owner avatar in corner)
- [x] Building icons on owned properties
- [x] Moving car animation across board tiles
- [x] Dice display with Unicode faces
- [x] Prison action bar (skip, bail, jail-free)
- [x] Card display modal with choices
- [x] Property inspection on click
- [x] Player info panels
- [x] Game log
- [x] Turn timer (90 seconds)
- [x] Responsive layout with player corner panels

### Multiplayer Online
- [x] Room system (4-character code)
- [x] Host/join lobby
- [x] Avatar selection (1–12 profile pictures)
- [x] Dice count and money visibility options
- [x] Real-time game state sync via Socket.IO
- [x] Turn timer with server authority
- [x] Auto-pass on timer expiry
- [x] Player disconnect handling (auto-pass turn)
- [x] Trade system (mutual proposal)
- [x] Bid/auction system
- [x] Game log per room
- [x] Pre-built client for deployment (`dist/`)

### Hot-Seat Single-Player
- [x] Player count selection (2–6)
- [x] Starting cash selection ($400 or $1500)
- [x] Same game engine core

---

## Recent Bug Fixes (Session History)

1. **Player tokens disappearing**: Token rendering was a tiny 10px dot hidden after animation. Changed to 32px centered circle with avatar image, rendered BEFORE hiding the moving car.

2. **Nady El Haz extra turn**: `autoPass()` was missing `startTimer()` after auto-resolving `club_choice`, causing the timer interval to never restart. Added `startTimer()` after every auto-resolve branch.

3. **Stale finishTurn calls**: Added guard in `finishTurn()` — only the current player's ID can finish their turn.

4. **Hazak card 7 double money**: `resolveCardChoice` was re-applying `bank_money` that was already applied in `applyHazakCard`. Removed the duplicate from `resolveCardChoice`.

5. **Jail-free card auto-use**: Removed auto-consumption from all 3 jail entry points (engine.js, deck.js ×2). Added manual "Use Jail-Free Card" button visible only when player has cards in inventory.

6. **renderTokens undefined in multiplayer**: The function was called but never defined, causing `updateUI()` to crash silently (caught by try/catch). Added the function with proper CSS.

7. **Token/owner icon swap**: Player tokens (the moving pieces) now render big and centered (32px). Owner avatars are small (11px, 55% opacity) in the bottom-left corner.

---

## Known Issues & TODOs

### Bugs
- **Mahkama card 10 UI**: `pendingCityOwnersCard` data (selected cities, amounts) is stored in state but never displayed in a modal or UI element — the player just gets a log message.
- **Card choice for AI**: Non-human players auto-resolve with `resolveCardChoice(0)` which always picks the first option. No AI strategy exists.
- **multiplayer gameEngine.js `finishTurn`**: Takes a `skipAdvance` param (unused in single-player) and doesn't check `pendingCityOwnersCard` before advancing, unlike the client `turn.js`.
- **multiplayer gameEngine.js `handleCardEffect`**: Doesn't call `finishTurn` after effects (client version does). The roomManager calls `finishTurn` separately, but this means effects that need to halt (like card choice) must set `gs.phase` directly.
- **`pendingSecondCard` handling**: In multiplayer gameEngine.js `finishTurn`, the `pendingSecondCard` is an object `{ deckType, squareName }` vs the single-player where it's a boolean. The code handles this differently and the object structure may need alignment.

### Missing Features
- No save/load game state
- No undo/redo
- No spectator mode
- No chat system
- No sound effects
- No animation for building purchase
- No animation for card draw (card fly animation exists but may be unreliable)
- No property auction when declined (standard Monopoly rule)
- No mortgage system
- No "free parking" house rule

### Code Quality
- `src/engine.js` and `src/deck.js` have some code duplication (especially `sellBuilding` logic appears in `engine.js`, `liquidation.js`, and `deck.js`)
- `multiplayer/gameEngine.js` is a near-duplicate of the `src/` modules — any fix must be applied in both places
- Player `color` is assigned only in single-player `initState()`, not in multiplayer `initGame()` — multiplayer uses avatar as the token visual
- `avatar` field is an emoji character (🚗, 🏎️, etc.) in single-player but a numeric index (1–12) in multiplayer pointing to profile picture URLs

---

## How to Run

```bash
# Single-player (hot-seat)
cd /home/joe/Projects/Bank\ Elhaz
npm install
npm run dev        # → http://localhost:5173

# Multiplayer (server + client)
cd /home/joe/Projects/Bank\ Elhaz/multiplayer
npm install
npm run dev        # → http://localhost:5173 (server on :3001)
# Or production build:
npm run build && npm start
```

---

## Data Flow for Key Actions

### Rolling Dice
1. User clicks "Roll Dice" → `rollDice()` in window scope
2. Calls `computeRoll(playerId)` from `engine.js` → returns `{ die1, die2, total, isDouble, oldPos, newPos, steps, passedGo, path, playerId }`
3. Sets `state.phase = 'rolling'`, calls `animateToken(roll)`
4. `animateToken()` moves a car div tile-by-tile with `setTimeout` (180ms per tile)
5. Animation ends → calls `applyLanding(roll)` → updates player position, checks pass-go, calls `evaluateLanding()` → handles property/deck/corner → calls `finishTurn()` → `advanceTurn()` → next player
6. `updateUI()` re-renders everything

### Drawing a Card
1. `handleDeckTrigger()` sets `state.blindCard = { card, playerId, squareName, deckType }`, `phase = 'blind_card'`
2. UI shows card face modal → user clicks "Confirm" → `revealBlindCard()` calls `handleCardEffect(card, playerId)`
3. `handleCardEffect()` switches on `card.action` (Mahkama) or calls `applyHazakCard()` (Hazak)
4. Effect is applied (money, movement, jail, etc.)
5. If choices exist: `setupCardChoices()` sets `state.activeCardChoice`, `phase = 'card_choice'`, waits for user
6. User picks → `resolveCardChoice(index)` → applies choice → discards card → `finishTurn()`
7. If teleport lands on another special square: `evaluateLandingAfterCard()` handles it

### Prison Flow
1. Player lands on jail or draws "go to jail" card → `missedTurnsRemaining = 2`
2. Each turn: if player is current and phase is 'roll' and `missedTurnsRemaining > 0` → show prison UI
3. **Skip**: `skipPrisonTurn()` → decrements counter → if 0, phase = 'roll'; else `finishTurn()` (advance to next player)
4. **Pay bail**: `payBail()` → deduct $50 → `missedTurnsRemaining = 0` → phase = 'roll'
5. **Use jail-free card**: `useJailFreeCard()` → decrement `jailFreeCards` → `missedTurnsRemaining = 0` → phase = 'roll'
6. Auto-pass: `autoPass()` calls `skipPrisonTurn()` if phase is 'roll' and `missedTurnsRemaining > 0`

---

## Key Files Snapshot

| File | Lines | Purpose |
|------|-------|---------|
| `index.html` (root) | 1868 | Single-player game: HTML, CSS, inline JS (game controller) |
| `multiplayer/index.html` | 2643 | Multiplayer client: HTML, CSS, inline JS (Socket.IO client) |
| `multiplayer/server.js` | 421 | Express + Socket.IO server |
| `multiplayer/roomManager.js` | 708 | Room/timer/trade/bid orchestration |
| `multiplayer/gameEngine.js` | 914 | Server game logic (duplicate of src/) |
| `src/engine.js` | 266 | Client game logic (landing, property, club, selling) |
| `src/deck.js` | 633 | Card drawing, effects, choices, rent calculation |
| `src/state.js` | 135 | State initialization and access |
| `src/turn.js` | 158 | Turn advancement, prison actions |
| `src/dice.js` | 13 | Dice rolling, position calculation |
| `src/liquidation.js` | 114 | Bankruptcy, selling to bank |
| `board.json` | 502 | 34 board positions with rent tables |
| `hazak.json` | 226 | 15 Hazak cards |
| `mahkama.json` | 243 | 15 Mahkama cards |
