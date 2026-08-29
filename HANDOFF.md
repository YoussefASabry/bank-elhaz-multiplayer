# BANK EL HAZ (بنك الحظ) — COMPLETE PROJECT HANDBOOK

> Everything about this project: features, rules, data, protocol, UI layout,
> architecture, testing, environment quirks, and the full fix log — now with a
> function-by-function CODE MAP (`file:line`) so any symbol can be located.
> Generated 2026-08-24, **re-verified + expanded 2026-08-29** after the trade
> engine + e2e screenshot-tour session.

---

## TABLE OF CONTENTS

1. [What This Is](#1-what-this-is)
2. [Quick Start — How To Run](#2-quick-start--how-to-run)
3. [Session Fix Log](#3-session-fix-log)
4. [Repository Map (with file:line anchors)](#4-repository-map)
5. [Architecture](#5-architecture)
6. [Game Rules — Complete](#6-game-rules--complete)
7. [Board Data — All 34 Squares](#7-board-data--all-34-squares)
8. [Card Decks — Every Card](#8-card-decks--every-card)
9. [Wire Protocol](#9-wire-protocol)
10. [Client (`index.html`) — Every Button, Event, Ecosystem](#10-client-indexhtml--every-button-event-ecosystem)
11. [Engine Internals — Function Reference `src/engine/*`](#11-engine-internals--function-reference)
12. [Server Internals — Function Reference `src/server/*`](#12-server-internals--function-reference)
13. [Shared Vocabulary — `src/shared/*`](#13-shared-vocabulary)
14. [Themes & Assets](#14-themes--assets)
15. [Testing Guide (incl. the e2e screenshot tour)](#15-testing-guide)
16. [Known Issues & Environment Notes](#16-known-issues--environment-notes)

---

## 1. WHAT THIS IS

**Bank El Haz (بنك الحظ)** — an Arabic-language Monopoly-style multiplayer board
game ("Luck Bank"), played online in the browser. 2–6 players, one player hosts
a room, everyone else joins with a 4-letter room code.

- **Language**: UI is mostly Arabic (Egyptian dialect), RTL-friendly.
- **Stack**: TypeScript everywhere. Express + socket.io server, vanilla-JS
  client (a single `index.html` with an inline ES-module script), Vite build,
  Vitest unit/integration tests, Playwright e2e screenshot tour.
- **Board**: 34 squares, Arab-city themed (القدس، الرياض، القاهرة…), 4 corner
  squares, two card decks (⚖️ المحكمة "Court" and 🍀 حظك "Your Luck").
- **Current branch**: `test2` tracking `origin/refactor/unified-engine-ts`
  (commit `32ea855` base + this session's fixes, uncommitted).
- **Status (2026-08-29)**: ✅ everything green —
  - `npm run typecheck` **clean**; `npm test` = **273/273 vitest tests / 14
    files**; `vite build` **clean**.
  - e2e screenshot tour (`tests/e2e/game.spec.ts`) **passes reproducibly** —
    buy → club → upgrade → 4-stage trade → rent → modals → bid → prison —
    produces **20 screenshots** in `screenshots/` (03–20).
  - The trade engine now handles the **full 4-stage proposal machine**; the
    tour drives it end-to-end with drag & drop.

---

## 2. QUICK START — HOW TO RUN

### Production (single origin, recommended)

```bash
npm install          # if needed
npm run build        # vite build → dist/
PORT=<port> npm run server   # tsx src/server/index.ts
```

Open **http://localhost:<port>** — the engine server itself serves the built
client (`express.static('dist')`, falling back to the repo working tree —
`src/server/index.ts:42-43`).

### Dev mode (two processes, hot reload of the page)

```bash
npm run dev
```

Spawns the engine server (`npx tsx src/server/index.ts`) and Vite dev client
(`npx vite --port 5173`; auto-bumps if taken). Vite proxies `/socket.io/*` to
the engine server; the proxy target is `process.env.VITE_API_TARGET ?? 3001`
(`vite.config.ts`).

### Individual scripts (`package.json:6-15`)

| Script | Command | Effect |
|---|---|---|
| `npm run server` | `tsx src/server/index.ts` | Engine server only (serves dist too) |
| `npm run client` | `vite --port 5173` | Vite dev client only |
| `npm run build` | `vite build` | Build client into `dist/` |
| `npm run preview` | `vite preview` | Preview the build |
| `npm run typecheck` | `tsc --noEmit` | Typecheck everything |
| `npm test` | `vitest run` | 273 unit + integration tests |
| `npm run test:soak` | `vitest run tests/soak` | No-op: `tests/soak/` does not exist |

### ⚠️ THIS MACHINE'S PORT SITUATION (important!)

- Ports **3001** and **5173** are squatted by zombie listeners (uid 1000, a
  separate PID namespace — invisible to `ps`, unsignalable, no sudo/fuser/ss
  available). 3001 still serves an **old built copy** of the game (pre-refactor
  wire shape) — do not develop against it.
- **A live game server currently runs on port 4477** — a leftover `npm run
  server` (tsx `src/server/index.ts`) started 2026-08-28 21:56, still bound to
  `0.0.0.0:4477`. It serves the *current* `dist/` at request time, so after
  `npm run build` it serves today's fixed client. The e2e suite boots its own
  web server on **4399** (`playwright.config.ts`).
- Fresh servers auto-fall-back upward on `EADDRINUSE` (see §5 invariant:
  `src/server/index.ts:106-117`) with a loud `⚠️ Port X is busy — trying X+1`.
- For deterministic manual runs:
  ```bash
  PORT=4123 npm run build && PORT=4123 npm run server   # → http://localhost:4123
  ```

---

## 3. SESSION FIX LOG

Fixes 1–7 are from the 2026-08-24 engineering session; fixes 8–11 (the trade
flakes) landed 2026-08-29. All uncommitted working-tree changes on top of
`origin/refactor/unified-engine-ts`.

### Fix 1 — Server never started under npm scripts *(root cause #1)*
`package.json` ran the server with **vite-node**, but the entrypoint guard in
`src/server/index.ts` compared `process.argv[1]` against `import.meta.url`;
vite-node sets argv[1] to its own binary → guard false → `start()` never ran.
`"server"` now uses **`tsx src/server/index.ts`** (tsx sets argv[1] = script).

### Fix 2 — Zombie-proof port binding
`src/server/index.ts:106-117` catches `EADDRINUSE` and walks up to +10 ports
with a loud warning.

### Fix 3 — Client couldn't understand the new server state *(root cause #2)*
The refactored server projects a normalized per-viewer state (`board` +
separate `ownership`, ONE discriminated `pending`, deck *counts*, redacted
money). The inline client was written against the old fat shape. Added the
anti-corruption adapter **`adaptGameState(gs)`** (`index.html:451`) rebuilding
the legacy view (`boardSquares`, `gameMeta`, all `pending*` fields,
`activeCardChoice`, `activeBids`) from the wire payload — idempotent, wired
into all four assignment sites (`game_started` 885, `rejoined` 903,
`restore_game_result` 930, `state_update` 974).

### Fix 4 — Card-choice button indexes desync
`card_choice` indexes the **flattened** option list; `flattenCardOptions()`
(`index.html:533`) mirrors the expansion so `choiceIndex` lines up.

### Fix 5 — Page hung on load (offline CDN dependency)
`<script src="/socket.io/socket.io.js">` instead of the CDN — served by the
engine server itself, version-matched.

### Fix 6 — Lobby roster race
`host_game` / `join_game` acks now carry `players: WirePlayer[]`
(`src/server/handlers/lobby.ts:62-114`) so the waiting room renders correctly
on first paint.

### Fix 7 — Dev proxy hardcoding
`vite.config.ts` proxy target is `process.env.VITE_API_TARGET ?? 3001`.

### Fix 8 — Unclosed `<div id="blind-card-modal">` (index.html markup)
The blind-card overlay was **never closed** in the HTML, so every overlay
defined after it (bid-create, trade-modal, trade-request, player-list,
player-action-popup…) was *nested inside* the transparent overlay — which the
`.show` class keeps `display:none`. Result: those modals rendered at **0×0**
forever, which is exactly why the e2e tour couldn't click the trade/bid UIs.
Now properly closed (`index.html:192-205`).

### Fix 9 — `updateUI()` must not auto-close `trade-modal`
`updateUI()` (`index.html:1814`) blindly closed `buy-modal`, `upgrade-modal`,
`card-draw-modal`, `inspect-modal`, `inventory-modal` on every `state_update` —
it previously included **`trade-modal`** too, which killed an in-flight trade.
Removed `trade-modal` from that list, and added the guard
**`if (tradeState.active) renderTradeUI();`** so the open panel re-renders
instead of going stale after a sell-in-trade / proposal event.

### Fix 10 — Engine trade needs *both* baskets (the 4-stage machine)
The old tour optimistically accepted the first proposal and expected the trade
to settle. The engine's state machine (`src/engine/trade.ts:159-240`) is
strict:
`proposing_a` (A proposes) → `reviewing_b` (B accepts **→ moving to
`proposing_b`**, NOT settling) → `proposing_b` (B counter-proposes) →
`reviewing_a` (A accepts **→ settles**). The guest's accept at `reviewing_b`
only advances the stage. The tour now plays all four stages (see §15).

### Fix 11 — e2e popup-Cancel selector hit "Trade"
`#player-action-popup button[onclick*="closePlayerActionPopup"]` matched **all
three** popup buttons (Trade/View/Cancel each embed `closePlayerActionPopup`),
and `clickRobust()` uses `.first()` → it clicked **Trade**, firing a second
`trade_request` that re-opened the request modal on the guest and froze the
tour. Fixed to the exact selector
`#player-action-popup button[onclick="closePlayerActionPopup()"]`
(`tests/e2e/game.spec.ts:150`).

---

## 4. REPOSITORY MAP

```
Bank El Haz/
├── index.html               ← THE live client (~3326 lines): markup + inline
│                              ES-module script. All UI logic + socket handlers
│                              + adaptGameState adapter. Built by Vite.
├── package.json             scripts: dev/server/client/build/test/test:soak/
│                              typecheck (see §2)
├── vite.config.ts           proxy /socket.io → VITE_API_TARGET ?? :3001
├── tsconfig.json
├── playwright.config.ts     e2e config: webServer `npm run build &&
│                              PORT=4399 npm run server`, viewport 1440×900,
│                              workers 1 (see §15)
├── data/
│   ├── board.json           ← authoritative board: game_meta + 34 board_positions
│   ├── hazak.json           ← 🍀 حظك deck (15 raw cards)
│   └── mahkama.json         ← ⚖️ المحكمة deck (15 raw cards)
├── assets/
│   ├── pfps/avatar1..20.svg ← avatars (SVG!)
│   └── themes/              ← board background themes
├── docs/
│   ├── WIRE.md              ← frozen socket protocol spec
│   └── HANDOFF-refactor.md  ← previous engineering handoff (bug IDs B01–B38)
├── src/
│   ├── shared/              ← domain vocabulary shared by all layers (§13)
│   │   ├── types.ts         GameState, Square union, Pending union, Phase…
│   │   ├── trading.ts       Basket / Trade / Bid shapes
│   │   ├── events.ts        aspirational event defs + projection types
│   │   ├── raw.ts           raw JSON field types (snake_case data)
│   │   ├── actions.ts       Action union, Actor, RejectReason, DomainEvent
│   │   └── rules.ts         economy constants (refunds, timers, caps)
│   ├── engine/              ← pure game logic, zero I/O (§11)
│   │   ├── index.ts         THE single reducer: authorize + dispatch
│   │   ├── state.ts         createInitialState, per-square getters
│   │   ├── board.ts         loads+normalizes data/board.json (snake→camel)
│   │   ├── turn.ts          resolveRoll / evaluateLanding / advanceTurn
│   │   ├── cards.ts         draw, blind-card, choice flattening/resolution
│   │   ├── deck.ts          shuffle/draw/discard
│   │   ├── property.ts      buy/rent/upgrade math (JSON-driven)
│   │   ├── trade.ts         the 4-stage trade machine
│   │   ├── bid.ts           bid/offer lifecycle
│   │   ├── bankruptcy.ts    insolvency / kick / game-over
│   │   ├── dice.ts          rollDice
│   │   └── rng.ts           seeded RNG per room
│   ├── server/              ← I/O boundary (§12)
│   │   ├── index.ts         bootstrap: express + socket.io + static serving
│   │   ├── rooms.ts         RoomStore, seats, reconnect bookkeeping
│   │   ├── context.ts       ServerCtx (rooms, emit, secret, rng, now)
│   │   ├── dispatch.ts      action → applyAction → events → broadcast
│   │   ├── view.ts          buildClientState() — MANDATORY redaction/projection
│   │   ├── domainEvents.ts  engine events → socket emissions (dice_rolled…)
│   │   ├── wire.ts          frozen typed event contract (matches docs/WIRE.md)
│   │   ├── snapshot.ts, snapshots.ts, versionStore.ts   persistence
│   │   ├── turnTimer.ts     per-turn countdown + trade deadlines
│   │   └── handlers/        lobby.ts turn.ts property.ts cards.ts prison.ts
│   │                        trades.ts bids.ts admin.ts common.ts
│   └── client/              ← TS client rewrite (NOT wired into index.html;
│      │                       exists as the Phase-5 migration skeleton)
│      ├── view-model.ts     the TS twin of the inline adapter (great reference)
│      ├── actions.ts dom.ts state.ts storage.ts theme.ts layout.ts board-data.ts
│      └── styles/{base,board,dialogs,trade,responsive}.css
├── tests/
│   ├── engine/*.test.ts     board normalization, cards, decks, bids, property,
│   │                        trade, rng, reducer (index)
│   ├── server/*.test.ts     rooms, view redaction, dispatch, snapshot,
│   │                        restore, integration (real socket)
│   ├── helpers/fixtures.ts
│   └── e2e/
│       ├── game.spec.ts     ← the big screenshot tour (170 lines)
│       ├── lobby.spec.ts    lobby + start smoke
│       ├── _trade-probe.spec.ts   trade wire probe
│       └── helpers.ts       every e2e helper (shot, clickRobust, teleport…)
├── screenshots/             ← tour output (20 PNGs, e.g. 11-buy-modal.png)
├── .e2e-probes/             socket.io-client wire probes (trade-payload-probe.ts,
│   │                        trade-wire-probe.ts) — need a running server
├── test-results/            ← Playwright artifacts (gitignored)
├── playwright-report/       ← Playwright HTML report (gitignored)
└── dist/                    ← build output (gitignored, served in prod)
```

---

## 5. ARCHITECTURE

```
 browser tab                engine server                  engine (pure)
┌──────────────┐   ws    ┌────────────────────┐  actions  ┌─────────────┐
│ index.html   │◄───────►│ socket.io handlers │─────────►│ applyAction │
│ inline module│         │ handlers/*         │           │ (reducer)   │
│ + adapter    │◄───────┌│ dispatch.ts        │◄──────────┤ events out  │
└──────────────┘ states └│ view.ts (redact!)  │  events   └─────────────┘
                         │ domainEvents.ts    │
                         └────────────────────┘
```

Request path for a socket action:
1. Handler (`src/server/handlers/*.ts`) validates wire shape (`asSeatId`,
   `asString`, `fromWireBasket` in `common.ts`/`context.ts`), then calls
   `dispatch(ctx, room, action)`.
2. `dispatch` (`src/server/dispatch.ts:121`) captures `before` state, calls
   `applyAction` (engine reducer), re-emits domain events, syncs trade timers,
   arms the turn timer on turn change, and `broadcastState` unless rejected.
3. `applyAction` (`src/engine/index.ts:286`) runs `authorize` then an exhaustive
   `dispatch` switch. Returns events; increments `stateVersion` when not
   rejected (rejections emit a lone `REJECTED` event).
4. `broadcastState` (`src/server/dispatch.ts:54`) calls
   `buildClientState(state, viewerId)` **once per connected seat** — the
   mandatory projection/redaction.
5. `emitDomainEvents` (`src/server/domainEvents.ts:95`) turns domain events into
   the 35 wire events + Arabic `action_log` narrations.

### Key invariants (enforced in code)

1. **Every outbound game state goes through `view.ts buildClientState()`** —
   `src/server/view.ts:103`. It strips deck order (anti-cheat, `projectDecks`
   at :61), hides other players' money when `moneyVisible:false`
   (sends `money:null`, `projectPlayer` at :40), and replaces other players'
   blind cards with `blind_card_hidden` (`projectPending` :76). The raw
   `GameState` is never broadcast.
2. **One pending slot** (`state.pending`, `src/shared/types.ts:252`) replaces
   the eight independently-nullable legacy fields that caused freezes.
   Note: phase `rolling` (dice rolled, awaiting CONFIRM_LANDING) has
   `pending: none` — the landing-confirmation decision is **phase-encoded**,
   not pending-encoded (`src/server/dispatch.ts` + `src/engine/turn.ts:75`).
3. **Stable SeatIds** (`seat-<uuid>`), never socket ids, in game state — a
   reconnect only ever calls `rooms.attach()` (`src/server/rooms.ts:195`),
   single-field socket repoint (bug B20 class removed).
4. **Authorization** — the `AUTH` table (`src/engine/index.ts:115`) maps every
   `ActionType → {phases, entitlement}`; `authorize()` (:183) rejects a
   mismatched actor instead of ignoring it.
5. **stateVersion** increments on every accepted action; snapshot restore
   requires a strictly-greater version than any already restored
   (`versionStore.ts`, `snapshot.ts`, bug B19) → replay impossible.
6. **Board data is immutable**, shared across rooms; dynamic bits live in
   `state.ownership` (`src/shared/types.ts:223`).

---

## 6. GAME RULES — COMPLETE

### Players & money
- **2–6 players** (host configurable; min `BOARD.meta.minPlayers` enforced in
  `lobby.ts`); hard cap `MAX_PLAYERS_HARD_CAP = 6` (`src/shared/rules.ts:55`).
- Starting cash default **$1200** (`data/board.json game_meta`; lobby field
  defaults to 1500). Produced by `createInitialState` (`src/engine/state.ts:74`)
  from `config.startingCash`.
- **Passing البداية (Go)** pays salary **$250** (`passGoSalary`) — credited
  during movement, not on landing (`src/engine/turn.ts:58` `paySalary`, called
  from `advance()` path; landing's corner `salary` case deliberately no-ops).
- Money visibility: host may hide other players' balances → `money:null`,
  rendered `💰 ???` (`view.ts:40`, `index.html:1770`).

### Turn lifecycle
1. Phase **`roll`**: current player clicks 🎲 Roll Dice → `ROLL_DICE`
   (`src/engine/turn.ts:75` `resolveRoll`: two dice per config, double-roll if
   `statusEffects.doubleNextRoll`, path via `board.advance()` `:235`).
2. Phase **`rolling`**: `dice_rolled` arrives with `path`; the client animates
   the token square-by-square (`index.html:1213` `animateToken`), then emits
   `confirm_landing` → `CONFIRM_LANDING` →
   `evaluateLanding` (`src/engine/turn.ts:144`) + `finishTurn`.
3. Landing resolves into EXACTLY ONE prompt:
   - unowned ownable → pending **property_buy** → phase `property_choice`
   - owned by someone → pending **rent** → phase `rent_payment`
   - deck square → pending **deck_draw** → phase `draw_card`
   - own property, full color group, has an upgrade tier → pending **upgrade**
   - club corner → pending **club**
   - prison corner → `missedTurnsRemaining` set, turn passes
4. Prompt resolved → `finishTurn` (`src/engine/turn.ts:220`): pending set →
   park in that phase; else `advanceTurn` (:243) — bounded skip loop over
   inactive/skip-next-turn players. Timer re-arms per handover.

### Properties, rent & upgrades
- 23 upgradable cities + 1 utility (محطة بنزين, id 16 — ownable, NOT
  upgradable; pays $40 when *passed*, or to bank if unowned).
- Rent tables from `visitor_paying`, build costs `owner_paying` — read
  directly by `src/engine/property.ts` (`calculateRent` :63,
  `getUpgradeOptions` :87, `purchaseUpgrade` :105, `sellUpgrade` :139,
  `buyProperty` :157, `sellPropertyToBank` :183). No derived formulas — JSON
  is law. Example القدس: price 300, base rent 35; garage 250→rent 190;
  rest stop 750→900; market 1000→1550.
- Upgrading requires the **full color group** (`ownsFullColorGroup`
  `src/engine/state.ts:192`; tier progression `nextTier`/`UPGRADE_ORDER`
  `src/shared/rules.ts:26-39`). Selling refunds `SELL_REFUND_RATIO = 0.75`
  (`src/shared/rules.ts:18`).
- Color groups: purple(2), pink(3), orange(3), yellow(3), brown(2), green(3),
  cyan(3), white(1!), red(3), utility(1).

### Corner squares
| Sq | Name | Effect |
|----|------|--------|
| 1 | البداية 🏁 | +salary $250 as you pass |
| 8 | نادي الحظ 🎰 | Club: membership **$150** (max 2) or guest fine **$20** |
| 18 | الأتوبيس السريع 🚌 | **double next dice roll** (`statusEffects.doubleNextRoll`) |
| 25 | السجن 🔒 | Prison: miss up to **2 turns**, bail **$50**, or 🔓 jail-free card |

### Prison
- Sent by mahkama cards 5/6/15-choice or `onBankruptcy:'jail'` rule.
- While `missedTurnsRemaining > 0` the roll button reads 🔒 In Prison and
  `prison-actions` appear (Skip / Bail / Use jail-free —
  `src/engine/turn.ts:294` `skipPrisonTurn`, :312 `payBail`, :332
  `useJailFreeCard`).
- Jail-free cards come from حظك 2 and المحكمة 7, held in
  `inventory.jailFreeCards`.

### Trading (see also §9, §10 trade section, §11 trade.ts)
- 🤝 Trade button (any non-bankrupt player; `tradeTiming` host config:
  `anytime` or `own_turn`, entitlement `trade_window`).
- Flow: pick partner → request modal → accept → trade panel with two baskets
  (cash + drag-drop properties + jail cards). **4-stage machine**:
  `proposing_a → reviewing_b → proposing_b → reviewing_a → settled/declined`.
- Server-enforced **60 s timer** (`TRADE_TIMEOUT_SECONDS`, `rules.ts:45`);
  atomic basket validation; rate limit 3 opens per 60 s
  (`TRADE_RATE_LIMIT`/`TRADE_RATE_WINDOW_MS`). Panel minimizes to a bar
  (`📦 Trade active»); dedicated events keep both sides in sync.

### Bidding (📢 Bid)
- Any active player posts a bid: cash + properties + jail cards into a pot.
  One open bid per seat (`bid.ts:84` `createBid`).
- Floating bid boxes render near corners (`index.html:3069` `renderBidFloats`).
  Others counter-offer (`bid.ts:111` `offerOnBid` → `bid_respond`); creator
  accepts an offer (`acceptOffer` :133) or cancels (`cancelBid` :164);
  TTL `BID_TTL_MS = 120_000` (`expireBids` :175).

### Bankruptcy & winning
- Cannot pay rent → 💀 Bankrupt (`DECLARE_BANKRUPT`, engine `index.ts:471`).
  `onBankruptcy` host config: `eliminate` (out) or `jail` (5 turns).
  Settlement via `checkInsolvency` (`src/engine/bankruptcy.ts:28`).
- Eliminated/bankrupt players stay rendered (💀 Bankrupt) but skipped
  (`isActive` = !isBankrupt && !eliminated).
- Game ends when one solvent player remains → `checkGameOver`
  (`src/engine/bankruptcy.ts:80`) + `game_over` + winner splash.

### Timers
- Turn timer `timeoutSecondsFor` (`src/server/turnTimer.ts:32`):
  default 90 s (`DEFAULT_TURN_TIMEOUT_SECONDS`), rent 120 s
  (`RENT_TURN_TIMEOUT_SECONDS`). Emits `timer_sync` every second.
- On expiry the server auto-plays `defaultActionFor(state)`
  (`src/engine/index.ts:738`) — the safest legal action per prompt — replayed
  *through the same reducer* (bug B22), so it cannot drift.

---

## 7. BOARD DATA — ALL 34 SQUARES

From `data/board.json` (authoritative; `src/engine/board.ts` normalizes
snake_case→camelCase at load — `loadBoardFrom` :154, `normaliseSquare` :75,
`validateBoard` :125). Prices in game dollars.

| id | Name | Type | Group | Price | Base rent | Garage c→r | Rest stop c→r | Market c→r |
|----|------|------|-------|------:|----------:|-----------:|--------------:|-----------:|
| 1 | البداية | corner 🏁 | — | — | — | — | — | — |
| 2 | القدس | city | purple | 300 | 35 | 250→190 | 750→900 | 1000→1550 |
| 3 | غزة | city | purple | 250 | 30 | 200→130 | 600→650 | 800→910 |
| 4 | المحكمة أو حظك | dual deck | — | draws BOTH (mahkama first) | | | | |
| 5 | بيروت | city | pink | 300 | 32 | 200→180 | 750→850 | 1000→1500 |
| 6 | الرياض | city | pink | 250 | 29 | 200→130 | 600→650 | 800→600* |
| 7 | بغداد | city | pink | 250 | 28 | 200→120 | 600→600 | 800→850 |
| 8 | نادي الحظ | corner 🎰 | — | membership 150 / guest fine 20 | | | | |
| 9 | بني غازي | city | orange | 150 | 22 | 120→75 | 440→275 | 550→675 |
| 10 | عدن | city | orange | 100 | 17 | 100→72 | 310→380 | 450→600 |
| 11 | المحكمة | deck ⚖️ | — | mahkama draw | | | | |
| 12 | البحرين | city | orange | 90 | 15 | 80→60 | 250→300 | 350→480 |
| 13 | حظك | deck 🍀 | — | hazak draw | | | | |
| 14 | الدار البيضاء | city | yellow | 250 | 30 | 200→130 | 550→600 | 750→850 |
| 15 | تونس | city | yellow | 200 | 25 | 165→120 | 360→600 | 490→800 |
| 16 | محطة بنزين | utility | utility | 300 | 40/pass | NOT upgradable | | |
| 17 | الجزائر | city | yellow | 300 | 35 | 525→185 | 750→850 | 1000→1000 |
| 18 | الأتوبيس السريع | corner 🚌 | — | double next roll | | | | |
| 19 | حلب | city | brown | 300 | 35 | 250→185 | 750→850 | 1000→1500 |
| 20 | الاسكندرية | city | brown | 325 | 45 | 300→220 | 850→1000 | 1200→1700 |
| 21 | المحكمة | deck ⚖️ | — | mahkama draw | | | | |
| 22 | أسوان | city | green | 200 | 27 | 165→130 | 360→700 | 490→900 |
| 23 | دمشق | city | green | 350 | 50 | 320→250 | 900→1200 | 1250→1850 |
| 24 | القاهرة | city | green | 450 | 55 | 400→320 | 1200→1500 | 1600→2400 |
| 25 | السجن | corner 🔒 | — | miss ≤2 turns / bail 50 | | | | |
| 26 | الخرطوم | city | cyan | 200 | 27 | 170→130 | 370→630 | 500→850 |
| 27 | عمان | city | cyan | 250 | 30 | 200→130 | 550→600 | 750→850 |
| 28 | الأقصر | city | white | 200 | 30 | 250→75 | 550→100 | 750→150 |
| 29 | بور سعيد | city | cyan | 250 | 30 | 210→130 | 550→700 | 800→900 |
| 30 | حظك | deck 🍀 | — | hazak draw | | | | |
| 31 | صنعاء | city | red | 250 | 30 | 220→125 | 600→620 | 820→925 |
| 32 | المحكمة | deck ⚖️ | — | mahkama draw | | | | |
| 33 | الكويت | city | red | 250 | 30 | 220→125 | 600→620 | 820→925 |
| 34 | قطر | city | red | 150 | 20 | 120→75 | 260→375 | 480→600 |

\* الرياض market *rent* (600) < rest-stop rent (650) in the source data — the
data wins, the engine does not second-guess it.

Meta: title بنك الحظ, starting cash 1200, pass-go salary 250, min 2 / max 6.
Engine lookup helpers: `findSquare` (`board.ts:175`), `requireSquare` (:180),
`step` (:211), `advance` (:235), `teleport` (:253),
`colorGroupSquares` (:258).

---

## 8. CARD DECKS — EVERY CARD

Both decks have **15 cards** (labels update as drawn; server sends counts only,
never order — `view.ts projectDecks` :61). Card types live in
`src/shared/types.ts:143-186` (`CardEffects`, `CardParams`, `Card`); raw JSON
normalised by `src/engine/deck.ts` (`normaliseCard` :113, `loadCards` :128,
`createDecks` :137, `draw` :148, `discard` :162, `deckTotal` :169).

### 🍀 حظك (hazak) — pure effects
| # | Effect |
|---|--------|
| 1 | Insurance pays you $200; move BACK 5 squares |
| 2 | 🔓 Jail-free card (keep for next game only) |
| 3 | Pay $100 (you joke too much) |
| 4 | Pay $100, go TO البداية and collect $250 salary |
| 5 | Receive $100 travel money |
| 6 | Birthday: collect $30 from EVERY player |
| 7 | Radio prize: +$100 AND choose to jump to 1 of 3 random cities |
| 8 | Pay $150 tailoring bills |
| 9 | Receive $50 patriotism prize |
| 10 | Pay $100 clothes (you + family) |
| 11 | +$100 from grandma, go to البحرين (12) to collect it |
| 12 | Pay $25×4 school fees (= $100) |
| 13 | Baby born: collect $50 from every player |
| 14 | Advance 4 AND pay HALF rent on next landing |
| 15 | CHOICE: take $150 **or** claim a free city from {بني غازي 9, عدن 10, البحرين 12, قطر 34} if unowned |

### ⚖️ المحكمة (mahkama) — court actions
| # | Action | Effect |
|---|--------|--------|
| 1 | collect_from_players | $25 from every player |
| 2 | pay_bank | $40 traffic fine |
| 3 | pay_bank | $50 littering fine |
| 4 | receive_bank | +$100 savings withdrawal |
| 5 | go_to_jail | Straight to السجن |
| 6 | go_to_jail | Army-dodger → السجن |
| 7 | receive_jail_free_card | 🔓 keep or sell later |
| 8 | bank_pays_per_building | +$25 × total buildings you own |
| 9 | pay_repairs | $100/market, $50/rest_stop, $25/garage |
| 10 | collect_from_city_owners | 3 random cities: $50 from each owner |
| 11 | CHOICE | claim free unowned city ≤$150 **or** +$100 |
| 12 | pay_bank | $15 lawyer fees |
| 13 | receive_bank | +$200 compensation |
| 14 | skip_turn_and_pay | lose next turn AND pay $50 |
| 15 | CHOICE | pay $100 fine **or** go to prison |

### How a card turn plays out (engine side)
1. Landing → pending `deck_draw` (`evaluateLanding`, `turn.ts:144`).
2. `DRAW_CARD` (`engine/index.ts:404`) draws, pre-selects cities
   (`preselectCities` `cards.ts:117`), parks pending `blind_card` carrying the
   card, `cardNumber`, pre-selected `cityIds` (bug B08: resolve charges exactly
   the displayed cities), and `remainingDraws` (square 4 queues a second card).
3. `confirm_blind_card` → `CONFIRM_CARD` (`engine/index.ts:430`).
   - Choice card → `setupChoices` (`cards.ts:279`) + `flattenChoiceOptions`
     (:342) → pending `card_choice`; `card_choice{choiceIndex}` →
     `resolveChoice` (:355). The index is over the **flattened** list — the
     client mirrors it in `flattenCardOptions` (`index.html:533`).
   - Non-choice → `applyCardEffects` (:132) settles immediately.
4. `afterCard` (`engine/index.ts:260`) resumes the queue
   (`remainingDraws`) or finishes the turn.

Wire: drawer gets `private_card`; others get `other_drawing` +
`public_card_draw` mirror + `close_public_card`; everyone gets
`card_outcome{description, playerName, deckType}` after resolution.

---

## 9. WIRE PROTOCOL

Authoritative spec: `docs/WIRE.md` + typed contract `src/server/wire.ts`.
Room-scoped namespaces; all game events implicitly scoped by socket membership.

### Client → Server — 37 intents (`wire.ts ServerToClientEvents` is :113; the
`ClientToServerEvents` interface is `wire.ts:229`)

**Lobby (6):** `host_game{name,avatar,options}→ack(ok,roomCode,playerId,players)`
· `join_game{roomCode,playerName,avatar}→ack(ok,…,players)`
· `leave_room` · `start_game` · `rejoin_game{roomCode,playerName}`
· `restore_game{roomCode?,playerName,snapshot?}` (see Fix notes / B19 — the
`gameState` field is ignored; only the opaque signed blob is trusted)

**Turn (3):** `roll_dice` · `confirm_landing{rollResult?}` (payload ignored —
phase-encoded authority) · `debug_roll{targetId}` (host-only cheat)

**Property (9):** `buy_property` · `decline_property` · `pay_rent`
· `declare_bankrupt_from_rent` · `buy_upgrade{squareId,tier}` · `skip_upgrade`
· `sell_upgrade{id}` · `sell_property{id}` · `sell_building_in_trade{propId}`

**Cards (4):** `draw_card{deckType:'hazak'|'mahkama'}` · `confirm_blind_card`
· `card_choice{choiceIndex}` (flattened index!) · `club_choice{'membership'|'guest'}`

**Prison (3):** `skip_prison` · `pay_bail` · `use_jail_free`

**Trades (7):** `trade_request{targetId}` · `accept_trade_request{initiatorId}`
· `decline_trade_request{initiatorId}` · `trade_send_proposal{cash?,propIds?,
jailCards?}` · `trade_accept_proposal` · `trade_decline_proposal` · `trade_cancel`

**Bids (4):** `create_bid{cash?,propIds?,jailCards?}` · `bid_respond{bidId,
cash?,propIds?,jailCards?}` · `bid_accept_offer{bidId,offerId}` · `cancel_bid{bidId}`

**Admin (1):** `terminate_player{targetId}`

### Server → Client — 35 events (`wire.ts:113-227`)

**Lobby/presence (9):** `room_created{roomCode,playerId,players}` ·
`joined{…,players}` · `update_players{players}` ·
`rejoined{roomCode,playerId,players,gameState}` · `rejoin_failed{error}` ·
`restore_game_result{success,roomCode?,playerId?,gameState?,error?}`
· `player_reconnected{playerId,oldPlayerId?,players}` ·
`player_disconnected{playerId,players,connected:false}` · `player_terminated`

**Game state (6):** `game_started{gameState}` · `state_update{gameState,
phase,snapshot?}` — per-viewer projection, the heartbeat ·
`game_over{winner}` · `action_log{message}` · `splash_text{text,type}` ·
`timer_sync{seconds,running}`

**Dice/movement (1):** `dice_rolled{die1,die2,total,isDouble,oldPos,newPos,
steps,passedGo,path,playerId}`

**Cards (6):** `landed_on_deck{deckLabel}` · `private_card{card,cardNumber,
squareName,deckType,pendingSecondCard,cityNames}` ·
`other_drawing{playerName}` · `public_card_draw{…,playerName}` ·
`close_public_card` · `card_outcome{description,playerName,deckType}`

**Trades (9):** `trade_error{message}` · `trade_request_notify{initiatorId,
initiatorName,initiatorAvatar}` · `trade_request_sent{partnerName}` ·
`trade_request_declined{partnerName}` · `trade_opened{tradeId,state,
initiatorId,initiator:{id,name,avatar,money},partner:{…},proposalA,proposalB}`
· `trade_state_update{tradeId,state,proposalA,proposalB,acceptedA,acceptedB,
fromPlayerId?,accepted?,declined?,side?,_participants[]}` ·
`trade_executed{aName,bName,aId,bId,_participants[]}` ·
`trade_cancelled{reason,_participants?}` · `trade_timer_sync{seconds,running}`

**Bids (4):** `bid_created` · `bid_offer_added` · `bid_executed{bidderName,
offererName,bidId}` · `bid_cancelled{bidId}` (all `WireBid`-shaped except the
last two)

`WirePlayer = {id, name, avatar, connected}` (stable SeatId strings). Basket
translation helpers: `toWireBasket` / `toWireProposal` / `fromWireBasket`
(`src/server/context.ts:84-104`). **Trade wire facts**: `trade_opened` uses
`state: 'proposing_a'` and always `proposalA:null, proposalB:null` initially;
`trade_request` takes `targetId`; `accept_trade_request` takes `initiatorId`;
the initiator is always side `a`.

---

## 10. CLIENT (`index.html`) — EVERY BUTTON, EVENT, ECOSYSTEM

Single-page app; one `<script type="module">` (from ~`index.html:346`) holds
everything. Modal markup block is `index.html:160-345`; board markup is built
in `renderBoard()` (`index.html:1626`). Remote-control block at :121.

### Global module state
- `myPlayerId`, `roomCode`, `gameState` (legacy-shaped, fed by
  `adaptGameState`), `tradeState` (the live trade object), `bidCreateProps`,
  `bidCreateJail`, `bidRespondProps`, `bidRespondJail`, `bidRespondTarget`
  (`index.html:425-445`).
- localStorage keys: `bankelhaz_session{roomCode,playerName}` ·
  `bankelhaz_prefs{name}` · `bankelhaz_fullsave` (snapshot blob) ·
  avatar + theme selections.

### The adapter / shaping layer
| fn | line | purpose |
|----|------|---------|
| `keyifyTier(rec)` | 446 | `{garage_rent,…} → {garage:…}` |
| `adaptGameState(gs)` | 451 | server `ClientState` → legacy view (see §3 Fix 3) |
| `flattenCardOptions(pending, squareOf)` | 533 | mirrors server flatten for `choiceIndex` |
| `deckCount(st, name)` | 558 | `decks.<name>.drawCount` |
| `getThemeImageUrl(slotKey)` | 688 | theme bg URL resolution |

### Socket connectivity & rejoin (`index.html:346-423`)
`socket = io('')` (same-origin, websocket+long-polling). `connect`/`disconnect`/
`connect_error` handlers drive the `#socket-status` banner, an overlay
`.socket-disconnected-overlay`, `tryRejoin()` (:364, auto `rejoin_game` with the
saved hint), and `emitRejoin()` (:417, manual form).

### Lobby (screens & buttons)
- `switchLobbyTab(tab)` :731 — 🎮 Host / 🔗 Join tabs.
- `hostGame()` :745 — reads `#host-name`, options (`#opt-starting-cash`,
  `#opt-passgo-salary`, `#opt-dice-count`, `#opt-money-visibility`,
  `#opt-trade-timing`), emits `host_game`, stores prefs.
- `joinGame()` :771 — reads `#join-name`, `#join-code`, emits `join_game`.
- `showRoomWaiting(players)` :795 / `updateLobbyPlayers` :803 — roster rows;
  host sees 👑 badge, Start Game button `#btn-start-game` (disabled until ≥2).
- `startGame()` :828 → emits `start_game`.
- `leaveRoom()` :832 / `leaveGame()` :837 → `leave_room`.
- `resetToLobby()` :845.
- `#btn-restore-game` 💵 Resume Game → `restoreSavedGame()` :624 (emits
  `restore_game` with the saved blob); `exportGameState()` :633 /
  `importGameState(event)` :643 for JSON save files; `checkSavedGame()` :610.

### In-game socket handlers (all attached around :861-1167) — what each does
`room_created` 861 · `joined` 865 · `update_players` 869 ·
`player_disconnected` 875 · `game_started` 885 (→ adapt + renderBoard) ·
`rejoined` 903 · `rejoin_failed` 923 · `restore_game_result` 930 ·
`player_reconnected` 949 · `player_terminated` 969 · `state_update` 974
(adapt → updateUI, snapshot fallback) · `timer_sync` 990 (timer bar) ·
`dice_rolled` 1006 (dice faces, token animation, `animateToken`) ·
`private_card` 1052 → `showPrivateCard` · `other_drawing` 1058 ·
`public_card_draw` 1063 → `showPublicCard` · `card_outcome` 1067 · `action_log`
1073 → toast · `landed_on_deck` 1078 · `splash_text` 1082 → `showBigText` ·
`game_over` 1086 (winner splash, clears save) · `close_public_card` 2275 ·
trade events 1106-1167 (see trade section) · bid events 3033-3068
(see bid section).

### Turn actions (buttons in the board center, built in `renderBoard`)
| button | handler | line | emits |
|---|---|---|---|
| `#btn-roll` 🎲 Roll Dice | `rollDice()` | 1170 | `roll_dice` |
| `#cdie1/2`, `#rc-die1/2` | — | 1006/1626 | dice faces |
| debug `#debug-tile-select` + Go | `initDebugDropdown()` :1181 / `debugGo()` :1190 | debug | `debug_roll{targetId}` |
| deck piles `.deck-pile` | `onDeckClick(deckType)` | 1201 | `draw_card` |
| `#btn-trade` 🤝 Trade | `openTrade()` | 2325 | player-selector → `trade_request` |
| `#btn-bid` 📢 Bid | `openBid()` | 2869 | — |
| 📦 My Stuff | `openInventory()` | 1332 | — |
| `#btn-pay-rent` 💰 | `payRent()` | 1270 | `pay_rent` |
| `#btn-declare-bankrupt` 💀 | `declareBankrupt()` | 1274 | `declare_bankrupt_from_rent` |
| `#btn-use-jailfree` / rc version | `useJailFree()` | 1295 | `use_jail_free` |
| `#prison-actions` Skip/Bail | `skipPrison()` 1291 / `payBail()` 1328 | | `skip_prison` / `pay_bail` |

`animateToken(roll, shouldConfirm)` :1213 moves the car sprite 400 ms/step over
`roll.path`, then emits `confirm_landing` (only the rolling player).
Buy modal buttons: `buyProperty()` 1260 / `declineProperty()` 1265.
Upgrade buttons: `buyUpgrade(propertyId, tier)` 1408 / `skipUpgrade()` 1413.
Club buttons: `chooseClub('membership'|'guest')` 1255.
Blind card: `confirmBlindCard()` 1280; card choice:
`selectCardChoice(index)` 1286.

### Cards UI
- `animateCardFly(isMahkama, cb)` 1420 — card flip-in.
- `showPrivateCard(data)` 1456 — fills `#card-face-*`, sets deck/repair/choice
  hints, adds `.mahkama-face/.hazak-face`, shows `#blind-card-modal`.
- `showPublicCard(data)` 2252 — the public mirror.

### Board & tiles
- `renderBoard()` 1626 — builds 34 `.cell` divs (`GRID_CLASS` p1…p34, edge
  classes, color strips, owner-avatar slot, building icons, tokens container,
  center cell with banners/timer/dice/actions/deck piles) + click →
  `inspectTile(id)`.
- `renderPlayerCorners()` 1740 — pinned `#player-corners` panels per player
  (`getCornerLayout` :3123), money (or `💰 ???`), inventory badges, `.mini-card`
  prop chips, status, `.current-turn` highlight, click →
  `onPlayerCardClick(id)`.
- `renderTokens(state)` 1794 — token sprites per player per cell.
- `updateUI()` 1814 — the mega-refresh: closes turn-limited modals (NOT the
  trade modal — Fix 9), re-renders open trade panel, deck labels, activations,
  ownership, roll/trade/bid button states, prison UI, rent buttons, money
  flash/floats, `checkPhaseFromState()`, `renderBidFloats()`, `updateTimerUI()`.
- `checkPhaseFromState()` 2093 — drives the modals from pending fields:
  club / buy / upgrade / card-choice (with money-eligibility disabling).
- `inspectTile(squareId)` 1510 / `closeInspect()` 1545 — property details.
- `getColorGroupBG` 1549 · `getEdgeClass` 1559 · `cornerImageHtml` 1568 ·
  `getCornerContent` 1578 · `getDeckIcon` 1583 · `applyCellTheme` 1589 ·
  `applyDeckTheme` 1607.
- Overlays: `showBigText` 2281 · `showFloatMoney` 2218 · `log` 2302 ·
  `showToast` 2308 · `stopTimer` 2182 · `updateTimerUI` 2188 ·
  `closeAllModals` 2176 · `resizeBoard` 3265.

### Player action popup (click a corner)
`onPlayerCardClick(playerId)` 2348 — popup with 🤝 Trade /
🏠 View Properties / ❌ Cancel. `startTradeWith(targetId)` 2391 emits
`trade_request` directly (bypasses selector); `viewPlayerProperties(playerId)`
2371 fills the inspect modal; `closePlayerActionPopup()` 2367.

### Trade (the big one)
Client per-side object `tradeState` = `{active, mySide:'a'|'b', a, b, state,
aProposal, bProposal, minimized, myCash, myPropIds, myJailCards, timerEnd}` —
populated by `openTradePanel(data)` (:2401) from `trade_opened`.

- `openTrade()` 2325 — builds `#ps-list` (.ps-player rows), shows
  `#player-selector`; clicking a `.ps-player` emits `trade_request{targetId}`.
- `#trade-request-modal`: `acceptTradeRequest()` 1148 (emits
  `accept_trade_request{initiatorId}` from `dataset.initiatorId`) /
  `declineTradeRequest()` 1155.
- `renderTradeUI()` 2443 — central renderer per `tradeState`:
  - Status text per stage (`proposing_a → …`).
  - Panels via `generatePanelHtml()` :2514 for side a and b.
  - Footer buttons: 📨 Send Proposal (`sendTradeProposal`), ✅ Accept /
    ❌ Decline (`acceptTradeProposal`/`declineTradeProposal`), 🚫 Cancel.
  - Re-attaches cash-input listeners.
- `getMyProposalForSocket()` 2592 → `{cash, propIds, jailCards}`;
  `sendTradeProposal()` 2600 validates (must offer *something*; keep ≥$1) then
  emits `trade_send_proposal`.
- `acceptTradeProposal` 2616 / `declineTradeProposal` 2620 / `cancelTrade` 2624
  (emits `trade_cancel` then closes) / `closeTrade` 2629 / `minimizeTrade`
  2636 / `restoreTrade` 2642.
- `startTradeTimer()` 2649 — 60 s countdown, cancels the trade at 0.
- Drag & drop: `.mini-prop-card[draggable=true]` items →
  `onPropDrag(e, propId)` 2705 / `onJailDrag` 2709; dropzones:
  `onDropZoneDragOver` 2714 / `onDropZoneDragLeave` 2719 /
  `onDropZoneDrop(e, side)` 2723; removals `removeTradeProp` 2757,
  `removeTradeJail` 2752; cash/number listeners
  `onMyCashChangeFn` 2764 / `onMyJailChangeFn` 2778 / `setMaxCash` 2792.
- Selling inside trade: `showSellBuilding(propId)` 2801 (fills
  `#sell-bldg-modal`) → `confirmSellBuilding()` 2813 emits
  `sell_building_in_trade`.
- Event wiring: `trade_opened` 1106 → `openTradePanel`;
  `trade_state_update` 1110 → `syncTradeState(data)` 2424 (updates proposals /
  accepted flags, resets your local basket after your own submit);
  `trade_executed` 1115 → toast + `closeTrade()`;
  `trade_cancelled` 1121 → toast + `closeTrade()`;
  `trade_error` 1128 → toast; `trade_timer_sync` 1162 → re-syncs clock.

### Bid
- `openBid()` 2869 — opens `#bid-create-modal`, resets `bidCreateProps`,
  `bidCreateJail`; `closeBidCreate()` 2880.
- Drop handlers `onBidCreateDrop` 2884 / `onBidRespondDrop` 2987; renderers
  `renderBidCreateSelected` 2903 / `renderBidCreateTradable` 2920 /
  `renderBidRespondTradable` 2957 / `renderBidRespondSelected` 3006;
  removers `removeBidCreateProp` 2914 / `removeBidRespondProp` 3017.
- `createBid()` 2933 — validates cash ≤ money, emits `create_bid`.
- `respondToBid(bidId, bidderName)` 2947 → `#bid-respond-modal`;
  `submitBidRespond()` 2970 emits `bid_respond`; `closeBidRespond()` 2981.
- `acceptBidOffer(bidId, offerId)` 3023 → `bid_accept_offer`;
  `cancelBid(bidId)` 3027 → `cancel_bid`.
- Events: `bid_created` 3033, `bid_offer_added` 3042, `bid_executed` 3051,
  `bid_cancelled` 3062 → mutate `gameState.activeBids` + `renderBidFloats()` 3069.
- `getBidCorner(playerId, state)` 3133 — CSS position for each floating box.

### Misc
- `#btn-players-float` 👥 → `openPlayerList()` 1299 (`#player-list-modal`),
  host sees ⛔ Kick (`terminatePlayer` 1322, confirm-guarded);
  `closePlayerList()` 1318.
- `#inventory-modal`: `openInventory()` 1332 lists owned props with Sell
  buttons → `confirmSellUpgrade(propertyId)` 1378 / `confirmSellProperty(pid)`
  1390 (confirm dialogs) eventually emit `sell_upgrade` / `sell_property`;
  `closeInventory()` 1374.
- Theme preview: `openPreview()` 3153 / `closePreview` 3180 /
  `renderPreviewBoard(boardEl, theme)` 3185; theme selectors
  `initThemeSelectors()` 695, pfp grids `renderPfpGrid` 712 /
  `initPfpPickers()` 738.
- `updateRoomCodeBadge()` 589 / `persistGameState()` 602 (snapshot save).

---

## 11. ENGINE INTERNALS — FUNCTION REFERENCE

### `src/engine/index.ts` — the reducer (777 lines)
- `AUTH` table :115 — `ActionType → {phases, entitlement}` (see §5).
- `LIQUIDITY_PHASES` :99 — phases where selling/cash/concede is legal.
- `SYSTEM_ONLY` :155 — `TIMEOUT`, `PLAYER_DISCONNECTED`,
  `PLAYER_RECONNECTED`, `EXPIRE_TRADES`.
- `reject()` :163 → `{ok:false, events:[REJECTED]}`.
- `pendingPlayer()` :171 · `isSeat()` :175.
- `authorize()` :183 — phase + entitlement checks (see §5.4).
- `pay()` :237 — debit/credit with `MONEY_CHANGED`.
- `afterCard()` :260 — resume remaining card draws or finish turn.
- `applyAction()` :286 — authorize → dispatch; bump `stateVersion` (once /
  not on REJECTED).
- `dispatch()` :298 — exhaustive switch; every case documented:
  - `ROLL_DICE` :299 → `resolveRoll`; `CONFIRM_LANDING` :307 →
    `evaluateLanding` + `finishTurn`.
  - `RESOLVE_PROPERTY_BUY{buy}` :315; `PAY_RENT` :339; `BUY_UPGRADE` :371;
    `SKIP_UPGRADE` :393; `SELL_UPGRADE` :400; `SELL_PROPERTY` :420.
  - `DRAW_CARD` :438; `CONFIRM_CARD` :489; `CHOOSE_CARD_OPTION` :537;
    `CHOOSE_CLUB` :560; `SKIP_PRISON_TURN` :576; `PAY_BAIL` :580;
    `USE_JAIL_FREE` :584.
  - `DECLARE_BANKRUPT` :588 — forces `money=-1` to route through
    `checkInsolvency` (B21); `KICK_PLAYER` :604.
  - `TRADE_OPEN` :619 / `TRADE_PROPOSE` :627 / `TRADE_ACCEPT` :635 /
    `TRADE_DECLINE` :650 / `TRADE_CANCEL` :657 (never touches `phase`, B13).
  - `BID_CREATE` :667 / `BID_OFFER` :676 / `BID_ACCEPT_OFFER` :685 /
    `BID_CANCEL` :695.
  - `EXPIRE_TRADES` :705; `PLAYER_DISCONNECTED` :710;
    `PLAYER_RECONNECTED` :716; `TIMEOUT` :728 — synthesises the default action
    via `defaultActionFor` and replays it through the same reducer (B22), then
    undoes the inner version bump so ONE action = ONE version.
- `defaultActionFor(state)` :738 — the timeout's default per pending kind
  (property_buy→decline, rent→pay, upgrade→skip, club→guest, deck_draw→draw,
  blind_card→confirm, card_choice→option 0, none→prison-skip/roll/confirm-landing).

### `src/engine/state.ts`
`defaultConfig` :40 · `createPlayer` :53 · `createInitialState` :74 ·
`currentPlayer` :109 · `playerById` :113 · `requirePlayer` :117 ·
`activePlayers` :124 · `isCurrent` :128 · `isInPrison` :132 ·
`ownershipOf` :138 · `ownerOf` :142 · `upgradeOf` :146 · `setOwner` :150 ·
`setUpgrade` :156 · `ownedBy` :163 · `ownedSquares` :167 · `releaseAll` :174 ·
`squareAt` :187 · `ownsFullColorGroup` :192 · `transfer` :205 ·
`credit` :212 · `debit` :216.

### `src/engine/board.ts`
normalizers `isUpgradable` :34 · `tierTable` :38 · `normaliseCorner` :48 ·
`normaliseSquare` :75 · `normaliseMeta` :115; `validateBoard` :125 ·
`loadBoardFrom` :154 · `loadBoard()` :169 · `findSquare` :175 ·
`requireSquare` :180 · `isOwnable` :186 · `isUpgradableSquare` :190 ·
`startSquareId` :194 · `prisonSquare` :200 · `step` :211 ·
`advance(from, steps)` :235 (returns `{to, path, passedGo}`) · `teleport` :253 ·
`colorGroupSquares` :258.

### `src/engine/turn.ts`
`phaseForPending` :32 · `paySalary` :58 · `resolveRoll` :75 (rolls dice,
advances, handles doubles/in-prison guard) · `applyTeleport` :129 (used by the
host debug teleport) · `evaluateLanding` :144 (the ONE prompt resolver) ·
`finishTurn` :220 · `advanceTurn` :243 (bounded skip loop, B28) ·
`skipPrisonTurn` :294 · `payBail` :312 · `useJailFreeCard` :332 ·
`turnHolder` :347.

### `src/engine/cards.ts`
`preselectCities` :117 · `applyCardEffects` :132 · `resolveClaimPool` :248 ·
`resolveDynamicPool` :264 · `setupChoices` :279 · `flattenChoiceOptions` :342 ·
`resolveChoice` :355. Card effect vocabulary:
`moneyEvent` :90 · `cardResolvedEvent` :94 · `ownedUpgradedSquares` :99.

### `src/engine/deck.ts`
`normaliseCard` :113 · `loadCards` :128 · `createDecks` :137 · `draw` :148 ·
`discard` :162 · `deckTotal` :169 · `hasCrossContamination` :175.

### `src/engine/property.ts`
`calculateRent` :63 · `getUpgradeOptions` :87 · `purchaseUpgrade` :105 ·
`sellUpgrade` :139 · `buyProperty` :157 · `sellPropertyToBank` :183.

### `src/engine/trade.ts`
`findTradeFor` :76 · `removeTrade` :80 · rate-limit WeakMap :86-107 ·
`validateBasket` :109 (owns the items, can afford cash, jail cards held) ·
`openTrade` :122 · `proposeTrade` :159 (stage-gated; sets one proposal) ·
`acceptTrade` :188 (reviewing_b→advance to proposing_b; reviewing_a→
**re-validate both baskets** then `settle`) · `settle` :224 (atomic cash/
jail-card/ownership swaps) · `declineTrade` :240 · `cancelTrade` :271 ·
`expireTrades` :284.

### `src/engine/bid.ts`
`checkBasket` :55 · `settleBaskets` :69 · `createBid` :84 (one per seat) ·
`offerOnBid` :111 · `acceptOffer` :133 (creator-only, settles+removes) ·
`cancelBid` :164 · `expireBids` :175.

### `src/engine/bankruptcy.ts`
`checkInsolvency` :28 · `kickPlayer` :58 · `checkGameOver` :80.

### `src/engine/dice.ts` + `rng.ts`
`rollDice(rng, diceCount)` (`dice.ts:20`) → `{die1,die2,total,isDouble}`.
`createRng(seed)` (`rng.ts:27`) — mulberry-style seeded PRNG, per room, lives
in the room and in snapshots for reproducibility.

---

## 12. SERVER INTERNALS — FUNCTION REFERENCE

### `src/server/index.ts` (bootstrap)
`StartOptions` :33 · `createApp()` :38 (express; `express.static('dist')` :42 +
`express.static('.')` :43) · `createContext(io, dataDir)` :48 ·
`registerHandlers` :63 (wires all 9 handler modules) · `localIPv4` :77 ·
`start(options)` :87 — default port `PORT ?? 3001`, EADDRINUSE walk :106-117,
banner :119-124.

### `src/server/rooms.ts` (RoomStore)
`Seat` :25 · `Room` :35 · `generateRoomCode` :64 · `RoomStore` :72 —
`get` :74 · `has` :78 · `isLive` :82 (room with `state !== null`) ·
`locate(socketId)` :88 · `seatOf` :95 · `socketsOf` :101 ·
`create(host,…)` :114 · `createFromState(code, state, options)` :139 (seats
rebuilt so ids match the restored `GameState` — ownership never dangles) ·
`join` :166 (same-name disconnected seat = reconnect) · `attach` :195 (the
ONLY reconnect mutation, B20) · `findRejoinable` :213 · `findByName` :222 ·
`markDisconnected` :228 · `removeSeat` :247 · `destroy` :252 ·
`isDeserted` :265 · `wirePlayers` :264 · `isHost` :273.

### `src/server/context.ts`
`Emitter` :42 · `socketEmitter` :56 · `ServerCtx` :70 ·
`toWireBasket` :84 · `toWireProposal` :89 (`submitted:true`) ·
`fromWireBasket` :94 → engine `Basket` · `playerName` :106 · `playerAvatar`
:110 · `squareName` :114 · `toWireOffer` :118 · `toWireBid` :128 ·
`tradeParticipants` :140 · `toWireWinner` :144.

### `src/server/dispatch.ts`
`broadcastState` :54 (per-viewer `buildClientState`) · `maybeIssueSnapshot` :74
· `syncTradeTimers` :89 · `dispatch` :121 — the pipeline (§5) ·
`debugTeleport` :167 — the ONE place the server reaches past `applyAction`
(knowing exception; still mutates only via engine fns, flagged for a proper
`DEBUG_TELEPORT` action) · `armTurnTimer` :224.

### `src/server/view.ts`
`projectPlayer` :40 (redacts money when hidden) · `projectDecks` :61 ·
`projectPending` :76 (blind cards of others → `blind_card_hidden`) ·
`projectOwnership` :88 · `buildClientState` :103.

### `src/server/domainEvents.ts`
`PreDispatch/capture` :37/42 (snapshot diffing for trade/bid resolution) ·
`socketOf` :58 · `toParticipants` :66 · `wireCancelReason` :83 ·
`deckLabel` :90 · `emitDomainEvents` :95 — every `DomainEvent` → wire emission
+ `action_log`/`splash_text` narration (see §9 for the emission table);
`emitDeckPrompt` :471 (the `landed_on_deck` nudge, derived from pending).

### `src/server/turnTimer.ts`
`timeoutSecondsFor` :32 · `startTurnTimer` :61 (1 s ticks → `timer_sync`) ·
`stopTurnTimer` :50 · `resetTurnTimer` :83 · `startTradeTimer` :115 (per-trade
deadline, keyed by tradeId — two concurrent trades can't cancel each other) ·
`stopTradeTimer` :96 · `stopAllTradeTimers` :104.

### `src/server/snapshot.ts` / `snapshots.ts` / `versionStore.ts`
`loadOrCreateSecret` (`snapshot.ts:83`, `.data/` secret) ·
`canonicalStringify` :128 · `sign` :134 · `createSnapshot` :138 ·
`verifySignature` :148 · `restoreSnapshot` :185 ·
`issueSnapshot` (`snapshots.ts:30`) · `attemptRestore` :81 (name→seat peek
then full re-verify; enforces participant + not-live + signature + version) ·
`restoreErrorMessage` :51 · `loadVersionStore` (`versionStore.ts:42`) — the
monotonic per-room restore gate (BUG B19).

### `src/server/handlers/*` — intent handlers (each calls `dispatch`)
- `common.ts` — `TypedSocket` :26, `seated()` :39 (lobby), `inGame()` :44
  (room with running state), validators `asSquareId` :51 · `asSeatId` :56 ·
  `asString` :60.
- `lobby.ts` — `host_game` :63 · `join_game` :80 · `leave_room` :116 ·
  `start_game` :136 · `rejoin_game` :161 · `restore_game` :215.
- `turn.ts` — `roll_dice` :16 · `confirm_landing` :26 · `debug_roll` :37
  (host-only `/debug_roll` → `debugTeleport`).
- `property.ts` — `buy_property` :25 · `decline_property` :31 · `pay_rent` :37
  · `declare_bankrupt_from_rent` :43 · `buy_upgrade` :49 · `skip_upgrade` :58
  · `sell_upgrade` :64 · `sell_property` :72 · `sell_building_in_trade` :88.
- `cards.ts` — `draw_card` :25 · `confirm_blind_card` :33 · `card_choice` :48
  · `club_choice` :56.
- `prison.ts` — `skip_prison` :21 · `pay_bail` :27 · `use_jail_free` :33.
- `trades.ts` — `trade_request` :29 (validates partner, `tradeTiming`,
  rate-limit pre-checks, stores in `room.tradeRequests` then emits
  `trade_request_notify`; NOTE the strict `accept_trade_request` gate at :72:
  only an invitation this server actually *delivered* may be accepted) ·
  `accept_trade_request` :72 → `TRADE_OPEN{actorId: recorded, partnerId: seat}` ·
  `decline_trade_request` :114 · `trade_send_proposal` :135 ·
  `trade_accept_proposal` :145 · `trade_decline_proposal` :151 ·
  `trade_cancel` :157.
- `bids.ts` — `create_bid` :20 · `bid_respond` :31 · `bid_accept_offer` :44 ·
  `cancel_bid` :58.
- `admin.ts` — `terminate_player` :25 (host), `disconnect` :62 (presence).

---

## 13. SHARED VOCABULARY

- **`src/shared/types.ts`** — `SquareId=number` :28, `SeatId=string` :34,
  `DeckType` :37, `UpgradeTier` :38; `Entry`/`Square` union :42-100; `Player`
  :188 (id/name/avatar/position/money/inventory/statusEffects/isClubMember/
  isBankrupt/eliminated/connected); `isActive()` :209; `SquareOwnership` :215;
  `GameConfig` :312; `GameState` :344 (config, board, ownership, players,
  currentPlayerIndex, turnNumber, phase, pending, decks, lastRoll, trades,
  bids, gameOver, winnerId, stateVersion); `Phase` :232; `Pending` union :252
  (`none | property_buy | rent | club | upgrade | deck_draw | blind_card |
  card_choice`); `UpgradeOption` :240.
- **`src/shared/trading.ts`** — `Basket{cash, squareIds, jailCards}` :15 ·
  `isEmptyBasket` :21 · `TradeStage` :29 · `Trade` :36 (a, b, stage,
  proposalA/B, acceptedA/B, createdAt, expiresAt) · `BidOffer` :54 · `Bid` :60.
- **`src/shared/actions.ts`** — `Actor`/`SYSTEM_ACTOR` :23-25 · `Action` union
  :33 (see §11 dispatch) · `ActionType` :75 · `RejectReason` :79-132 ·
  `DomainEvent` :140-178.
- **`src/shared/rules.ts`** — `SELL_REFUND_RATIO=0.75` :18 · `UPGRADE_ORDER`
  :26 · `nextTier` :29 · `tierRank` :37 · `DEFAULT_TURN_TIMEOUT_SECONDS=90`
  :41 · `RENT_TURN_TIMEOUT_SECONDS=120` :43 · `TRADE_TIMEOUT_SECONDS=60` :45 ·
  `TRADE_RATE_LIMIT=3` :47 · `TRADE_RATE_WINDOW_MS=60_000` :48 ·
  `BID_TTL_MS=120_000` :50 · `SNAPSHOT_TTL_MS=24h` :53 ·
  `MAX_PLAYERS_HARD_CAP=6` :55.
- **`src/shared/events.ts`** / **`raw.ts`** — aspirational projection types and
  raw snake_case JSON mirror (board JSON fields).

---

## 14. THEMES & ASSETS

- `assets/pfps/avatar1..20.svg` — circular avatars (**SVG**). `getPfpUrl(num)`
  (`src/client/theme.ts:116`; inline twin at `index.html`) returns `.svg` —
  any code expecting `.png` is wrong (the un-wired `src/client/*` still does;
  see known issues).
- `assets/themes/` — selectable board skins; selected in lobby per player,
  previewed via `openPreview()` (`index.html:3153`).
- Theme classes applied to piles/cards (`applyDeckTheme`,
  `mahkama-face/hazak-face`, confirm-button tinting).
- Styles: five stylesheets under `src/client/styles/` (base/board/dialogs/
  trade/responsive); additional inline `<style>` blocks in `index.html` cover
  lobby + game chrome. Board grid/edge classes: `GRID_CLASS` p1…p34 +
  `getEdgeClass` (`index.html:1559`).

---

## 15. TESTING GUIDE

```bash
npm run typecheck                 # tsc --noEmit — must be clean
npm test                          # 273 tests / 14 files (vitest), ~4 s
npm run build                     # must succeed
PORT=<port> npm run server        # boot; banner should print

npx playwright test tests/e2e/game.spec.ts    # the screenshot tour (~1.1 m)
npx playwright test tests/e2e/lobby.spec.ts   # lobby + start smoke
```

### Vitest suites (273 tests)
- `tests/engine/` — `board.test.ts` (normalization/validation),
  `cards.test.ts`, `deck.test.ts`, `bid.test.ts`, `trade.test.ts`,
  `property.test.ts`, `rng.test.ts`, `index.test.ts` (the reducer).
- `tests/server/` — `rooms.test.ts`, `view.test.ts` (redaction),
  `dispatch.test.ts`, `snapshot.test.ts`, `restore.test.ts`,
  `integration.test.ts` (real socket.io pair: host/join/start/roll/buy),
  `harness.ts` (fixtures).
- `npm run test:soak` → `vitest run tests/soak` is a NO-OP (dir absent).

### Playwright config (`playwright.config.ts`)
webServer `npm run build && PORT=4399 npm run server`, baseURL
`http://localhost:4399/`, viewport 1440×900, `workers:1`, per-test timeout
150 s, expect 20 s. `screenshot:'only-on-failure'`, trace retained on failure.

### The e2e screenshot tour (`tests/e2e/game.spec.ts`)
Deterministic: the host uses the debug teleport (`teleport`) to land on exact
squares, so every stage is scripted:
1. buy القدس (square 2, $300) — asserts $1500→$1200 and a corner `.mini-card`
2. club corner (8, $150 membership) — `#club-modal`
3. buy غزة (3, $250) → full purple set
4. land on own القدس → upgrade modal → build garage 🏗️
5. **trade القدس to the guest**: `openTradeWithGuest` (btn-trade → player
   selector → request modal → accept) → `sellUpgradeInTrade` (sell the garage
   inside the trade panel first) → `dragMyPropIntoBasket` (real drag & drop to
   `#dropzone-a`) → A proposes → B accepts (advances to proposing_b) → **B
   counter-proposes $100** → A accepts → `trade_executed`, both modals close,
   guest owns the mini-card
6. land on guest-owned القدس → `#rent-actions` Pay Rent
7. inspect tile modal · 8. inventory modal · 9. player list modal ·
10. per-player popup (click guest corner; fixed Cancel selector) ·
11. bid-create modal · 12. prison (square 25, then host's next turn shows
`#prison-actions`; bail).

Screenshot filenames (20): 04-blind-card-modal, 05-trade-selector,
05b-trade-request, 06-trade-panel, 06b-sell-building-modal, 07-trade-review,
07b-counter-proposal, 07c-host-review, 08-trade-executed, 10-board-overview,
11-buy-modal, 12-club-modal, 13-upgrade-modal, 14-rent-actions,
15-inspect-modal, 16-inventory-modal, 17-player-list-modal,
18-player-action-popup, 19-bid-modal, 20-prison-actions.

### e2e helpers (`tests/e2e/helpers.ts`, 421 lines)
| helper | line | purpose |
|---|---|---|
| `shot(page, name, opts)` | 8 | saved screenshot → `screenshots/` |
| `dismissDialogs(page)` | 17 | auto-dismiss native confirm()/alert() |
| `makeRoom(context, names)` | 30 | host+join two tabs, waiting room, 2 `.lp-item`s |
| `startGame(host, guest)` | 61 | Start Game → board with 34 `.cell`s both tabs |
| `hostMoney/guestMoney/hostCorner/guestCorner` | 71-78 | corner-panel locators (seat 0 / 1) |
| `moneyNum(text)` | 80 | `$1,200` → 1200 |
| `waitMyTurn(page)` | 86 | roll button enabled (30 s) + debug dump on stuck |
| `waitVisible(page, loc)` | 109 | nonzero geometry poll |
| `awaitLanding(page)` | 153 | waits for a landing prompt (or turn flip), returns `PromptKind`; seeds its "saw my turn" flag from the banner |
| `resolvePrompt(page, opts)` | 216 | clicks the matching button for the current prompt |
| `clickRobust(page, target)` | 266 | `.first().click()` then `.evaluate(el.click())` fallback for 0×0 overlays |
| `waitGeometry(page, sel)` | 289 | poll for nonzero box |
| `resolveDeck(page)` | 304 | click glowing pile, confirm blind card, resolve any choice |
| `teleport(page, squareId)` | 335 | host debug: select tile + Go, leave prompt open, `PromptKind` |
| `rollOpen(page)` | 347 | waitMyTurn + click roll + awaitLanding |
| `autoTurn(page)` | 354 | rollOpen + resolvePrompt |
| `openTradeWithGuest(host, guest)` | 360 | full selector→request→accept handshake, leaves `#trade-modal` open both sides |
| `sellUpgradeInTrade(page, squareId, propName)` | 381 | `.trade-panel.mine button[onclick^=showSellBuilding]` → confirm → draggable card exists |
| `dragMyPropIntoBasket(page, propName)` | 401 | drag `.mini-prop-card` by Arabic name into `#dropzone-a` |

Other e2e files: `lobby.spec.ts` (host/join/start smoke),
`_trade-probe.spec.ts` (raw wire probe). Helpers live alongside in `helpers.ts`.

### Wire probes `.e2e-probes/`
`socket.io-client` scripts (`trade-payload-probe.ts`, `trade-wire-probe.ts`)
that connect to a **running** server — they do NOT boot one. Point them at the
live server (e.g. the one on 4477) or the e2e booted one;
`PORT=4488 npx tsx .e2e-probes/…` hangs without a server on that port.

### Manual smoke (two browser tabs)
1. Tab A: name + Create Room → note code.
2. Tab B: join code + name → roster shows both, 👑 on host.
3. Start → 34 cells render, deck labels (15).
4. Roll → token animates → landing prompt appears.
5. Buy → both tabs' money drop equally; corner gains a mini-card.

---

## 16. KNOWN ISSUES & ENVIRONMENT NOTES

1. **Zombie ports 3001/5173** (see §2). Unkillable from this shell; reboot
   clears them. 3001 serves the cousin's older build; **j7f655** (a live game
   server) currently runs on **4477** serving the current `dist/` after builds.
2. **`pkill -f` hangs this shell tool** — always kill by PID found through
   `/proc/*/cmdline`.
3. `tests/soak/` does not exist — `npm run test:soak` is a no-op.
4. npm prints `Unknown user config "tmp"` — cosmetic, local .npmrc quirk.
5. White color-group has a single city (الأقصر) → monopoly after buying it
   alone. Data quirk, preserved intentionally.
6. الرياض tier rents non-monotonic (market 600 < rest stop 650). Data quirk,
   data wins.
7. Hidden-money games: opponents' `money` is `null`; corners render `💰 ???`;
   secondary spots (trade tooltips) may render `$null` cosmetically.
8. The TS client rewrite under `src/client/` is complete-looking but **not
   wired** — the `index.html` inline script remains the shipped client. Its
   `view-model.ts` documents the same mapping the inline adapter implements.
   Reference mismatch flagged: `src/client/*` still expects
   `assets/pfps/*.png` while the served client uses `.svg`.
9. Old engineering handoff (bug table B01–B38, acceptance criteria) moved to
   `docs/HANDOFF-refactor.md`.
10. `debug_roll` is host-only teleport; the clean redesign (a
    `DEBUG_TELEPORT` action in the `Action` union with
    `entitlement:'host'`) is flagged in `src/server/dispatch.ts:167`. The
    current implementation is a knowing exception that mutates only through
    engine functions.
11. `clickRobust` + exact-onclick selectors are load-bearing in the e2e tour:
    any handler whose onclick embeds another's name (e.g.
    `closePlayerActionPopup()`) WILL be mis-clocked by `[onclick*=…]` — always
    prefer exact `[onclick="…"]` when the string is a prefix of other handlers.
12. Uncommitted changes live in the working tree; suggested commit message:
    `fix: trade 4-stage machine in tour, blind-card-modal nesting, updateUI trade-modal guard, legacy adapter + lobby acks`.
13. **The client is NOT responsive.** No `@media` queries and no `transform:
    scale`/zoom anywhere in `index.html`; the board grid is hard-coded pixels
    (`boardEl.style.cssText` grid-template at `index.html:3187` → ~1012 px
    wide), and the `<meta name="viewport">` sets `user-scalable=no`
    (`index.html:5`). A phone-width viewport therefore just overflows
    horizontally; 768 px tablets render cramped but usable. Mobile/tablet
    screenshot tests were investigated (2026-08-29) and **deferred by owner
    decision** pending a proper responsive pass — do not expect narrow-screen
    screenshots from the current e2e tour (viewport 1440×900).

— end of handbook —