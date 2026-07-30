# Bank El Haz — Engine Unification, Bug Eradication & TypeScript Migration

**Status:** `pending approval`
**Date:** 2026-07-30
**Branch target:** new branch off `master` (repo is single-commit `255aecf`)

---

## 1. Requirements Summary

The game has pervasive defects in trading, menus/dialogs, turn tracking and state
management. Investigation found ~34 concrete defects, most traceable to three
structural causes:

1. **Duplicated rules.** `src/*` (6 modules, 1,300 lines) and `gameEngine.js`
   (986 lines) implement the same game twice with *different* models —
   `src/` uses `square.buildings: string[]` with cost = % of purchase price
   (`src/state.js:121`), the server uses `square.upgrade: string` with cost read
   from the **rent** table (`gameEngine.js:841`). Rent formulas differ
   (`src/deck.js:596` vs `gameEngine.js:386`).
2. **No single writer.** `server.js` mutates `room.gameState` directly in 8
   places (`:107`, `:187`, `:216`, `:240`, `:470`, `:481`, `:497`, `:614`),
   `roomManager.js` in ~12 more, `gameEngine.js` everywhere. Any invariant can be
   broken from any layer.
3. **Untyped, untested, unsplit.** Zero tests, no `test` script, `index.html` is
   3,996 lines of inline CSS+JS, all errors swallowed by
   `try/catch` in `updateUI` (`index.html:2486`, `:2758`).

### Interview decisions (user, this session)

| Question | Decision |
|---|---|
| Refactor depth | **One shared engine** — single authoritative rules engine, duplication deleted |
| Hot-seat mode | **Drop it** — delete `hotseat.html` and old `src/*` |
| Toolchain | **TypeScript + Vitest + split files** |

### Non-goals

Not in scope: new gameplay features (auctions, mortgages, chat, sound), AI
players, persistence to a database, i18n, visual redesign. Board/card data
(`board.json`, `hazak.json`, `mahkama.json`) content is unchanged except where a
defect requires a schema addition (see B24).

---

## 2. Target Architecture

Server-authoritative, pure-reducer engine. The engine never touches
`socket.io`, `Date.now()`, or `Math.random()` directly.

```
package.json          scripts: dev build server test test:soak typecheck lint
tsconfig.json         strict: true
vite.config.ts        client build + /socket.io proxy → :3001
vitest.config.ts
index.html            markup shell only (target ≤ 250 lines)
data/                 board.json  hazak.json  mahkama.json   (moved from root)
src/
  shared/
    types.ts          GameState, Player, Square, Card, Phase, Action, DomainEvent
    events.ts         typed ClientToServerEvents / ServerToClientEvents maps
    rules.ts          BOARD_SIZE, SELL_REFUND_RATIO, UPGRADE_ORDER
                        (costs/rents come from data, not constants)
  engine/
    rng.ts            seedable PRNG (deterministic tests)
    board.ts          loadBoard, findSquare, step, wouldPassGo
    dice.ts           rollDice(rng, diceCount)
    deck.ts           draw / discard / reshuffle — deckType always explicit
    cards.ts          card effects + choice setup/resolution
    property.ts       buy / rent / upgrade / sell
    turn.ts           finishTurn / advanceTurn / prison
    trade.ts          pure trade state machine + settlement
    bid.ts            pure bid/offer state machine + settlement
    bankruptcy.ts     single bankruptcy model
    index.ts          createGame(cfg, rng) ; applyAction(state, action, ctx)
                        → { state, events: DomainEvent[] }
  server/
    main.ts           express + socket.io bootstrap
    rooms.ts          RoomManager: lobby, membership, reconnect, id remap
    turnTimer.ts      one interval per room, symmetric clearInterval
    view.ts           projectFor(playerId, state) — money visibility, card secrecy
    handlers/*.ts     thin: authorize → build Action → applyAction → broadcast
  client/
    main.ts  net.ts  store.ts
    views/            board.ts tokens.ts corners.ts timer.ts log.ts dice.ts
    dialogs/          manager.ts + one module per dialog (buy, rent, club,
                      card, upgrade, inventory, playerList, inspect, preview)
    trade/  bid/
    styles/           base.css board.css dialogs.css trade.css responsive.css
tests/
  engine/*.test.ts        unit
  regression/*.test.ts    one test per bug ID below
  integration/*.test.ts   real socket.io client ↔ server
  soak/play.test.ts       200-turn 4-player headless game + invariant assertions
docs/ARCHITECTURE.md       replaces the stale HANDOFF.md
```

**Core contract** (`src/engine/index.ts`):

```ts
export function applyAction(
  state: GameState,
  action: Action,          // { type, actorId, ...payload }
  ctx: { rng: Rng; now: number },
): { state: GameState; events: DomainEvent[] }
```

`applyAction` is the **only** function permitted to mutate/replace game state.
It rejects actions whose `actorId` is not entitled to act (wrong player, wrong
phase) by returning the state unchanged plus a `rejected` event. Server handlers
become ~5 lines each. This makes B03, B09, B13, B19, B22 unrepresentable rather
than merely fixed.

---

## 3. Bug Ledger

Every row gets a regression test named `B<nn>_*` in `tests/regression/`.

### Turn tracking & timer

| ID | Location | Defect | Fix |
|---|---|---|---|
| B01 | `roomManager.js:168`, `:145` | `clearTimeout()` called on a `setInterval` handle → old interval survives; each `startTurnTimer` stacks another 1s ticker. N stacked timers decrement `timerSeconds` N×/sec and fire `autoPass` N times. **Primary cause of turn chaos.** | `turnTimer.ts` owns a single handle per room; `clearInterval` on every path; `startTurnTimer` asserts no live handle |
| B02 | `roomManager.js:203-255` | `autoPass` has no branch for `draw_card`, `upgrade_choice`, `rolling` → timer hits 0, nothing happens, timer not restarted → **permanent freeze** | `autoPass` switches over the exhaustive `Phase` union; TS `never` check makes a missing branch a compile error |
| B03 | `server.js:302` | `manager.useJailFreeCard()` does not exist on `RoomManager` (only on `GameEngine`) → `TypeError`, jail-free button dead | action `USE_JAIL_FREE` routed through `applyAction`; integration test asserts release |
| B04 | `roomManager.js:277` + `gameEngine.js:316`; also `src/engine.js:52`+`:201` | Landing exactly on square 1 pays Pass-Go salary **twice** (`passedGo` is `newPos < oldPos`, true when landing on 1) | salary credited once, in `turn.ts` movement resolution; corner-1 handler no longer pays |
| B05 | `roomManager.js:211`, `gameEngine.js:117` | Jailed player whose timer expires in phase `roll` is **rolled and moved** — `computeRoll` never checks `missedTurnsRemaining` | `ROLL_DICE` rejected while `missedTurnsRemaining > 0`; `autoPass` in prison performs `SKIP_PRISON_TURN` |
| B06 | `roomManager.js:134-136` | `terminatePlayer` splices `gs.players` without adjusting `currentPlayerIndex` → turn order shifts or index goes out of range; if the kicked player was current, no advance → freeze | players are never removed from `gs.players`; kick marks `eliminated: true`, then `advanceTurn` if they held the turn |
| B28 | `gameEngine.js:942-966` | `advanceTurn` recurses for `skipNextTurn` with no depth guard; bankrupt-skip `do/while` can exit **on** a bankrupt player when `tries` is exhausted | single iterative loop bounded by `players.length`, post-condition asserts the selected player is active |

### Cards & dialogs

| ID | Location | Defect | Fix |
|---|---|---|---|
| B07 | `roomManager.js:367` → `gameEngine.js:436,477` | `gs.blindCard` is nulled **before** `handleCardEffect`, which reads `gs.blindCard?.deckType` to choose the discard pile → **every Mahkama card is discarded into the Hazak pile.** Decks cross-contaminate; mahkama drains to empty, `drawCard` starts returning `null` | `deckType` is a required field on the card action; `deck.ts` refuses a card whose `deckType` doesn't match the target pile |
| B08 | `gameEngine.js:668` | Same nulling makes `effectCollectFromCityOwners` fall through to re-randomizing cities → **cities charged ≠ cities shown on the card** | pre-selected `cityIds` carried on the action payload, not read back off transient state |
| B09 | `roomManager.js:363-369` | `resolveBlindCard` applies the effect to the **caller** (`playerId`), not `blindCard.playerId`, with no turn check → any client can emit `confirm_blind_card` and take another player's card effect | `applyAction` authorization: actor must equal `state.blindCard.playerId` |
| B10 | `gameEngine.js:304` | Dual-deck square 4 always returns `pendingSecondCard: false` → second card never drawn online (hot-seat did draw 2 via `src/turn.js:20`) | `pendingSecondCard` modelled as `pendingDraws: DeckType[]` queue |
| B11 | `gameEngine.js:706` vs `src/turn.js:40`, `server.js:268-273` | `pendingCityOwnersCard` is set but the server engine never gates `finishTurn` on it (client engine did); the server just logs and clears it. No dialog ever shown | outcome delivered as a `DomainEvent` and rendered by `dialogs/card.ts`; no transient state gate needed |

### Trading

| ID | Location | Defect | Fix |
|---|---|---|---|
| B12 | `roomManager.js:579`, `:744`, `:782` | Properties with an upgrade are **silently** filtered out of proposals/bids — no feedback, the item just vanishes | validation returns a typed rejection reason; client shows it |
| B13 | `server.js:469-471` | `trade_cancel` force-sets `gs.phase = 'rent_payment'` regardless of whose turn it is or the current phase → **phase corruption mid-turn** | trade lifecycle cannot write `state.phase`; rent gating derives from `pendingRentPayment` alone |
| B14 | `roomManager.js:21`, `server.js:656-682` | Trades are never cleared on disconnect, turn change, kick or bankruptcy → `playerInTrade()` matches a stale trade forever, so that player **can never trade again** | `trade.ts` exposes `expireTrades(state, reason)`; called on disconnect, kick, bankruptcy, and turn advance |
| B15 | `roomManager.js:693`, `:702` | `Math.max(0, …)` clamps the *giver's* jail-card decrement but the receiver is credited unconditionally → **card duplication** | settlement validates the full basket atomically before any mutation; insufficient basket = rejection |
| B16 | `roomManager.js:493-506` | Rate limit keyed on `socket.id`, which changes on reconnect → limit trivially reset | keyed on stable seat id, stored on the room |
| B17 | `index.html:3266` | `getMyProposalForSocket()` reads `#trade-jail-<side>` — **that input is never rendered** (`generatePanelHtml` only renders `trade-cash-<side>`) → dragged jail cards are silently dropped from every proposal | proposal read from `store`, never from the DOM |
| B17b | `index.html:3194-3196` | `myPropIds`/`myCash`/`myJailCards` ternaries are identical on both branches — per-side state is aliased, so side `b`'s basket reads side `a`'s | single `myOffer` object in the store, side is presentational only |
| B18 | `index.html:3087` vs `roomManager.js:535` | Client sets `timerEnd = now + 65000`, server expires at 60s; on client expiry it emits `trade_cancel` → triggers B13 | server is the only trade-timer authority; client renders `trade_timer_sync` |

### State management & integrity

| ID | Location | Defect | Fix |
|---|---|---|---|
| B19 | `server.js:569-596` | `restore_game` installs a **client-supplied `gameState`** into a new room. Any client can fabricate money and property ownership | resume kept, but snapshots become **server-signed and replay-proof** — see §4a. Unsigned or stale payloads are rejected |
| B20 | `server.js:611-619` | Reconnect id remap misses `activeBids[].playerId`, `bid.offers[].playerId`, `room.trades`, `pendingClubChoice.playerId`, `pendingUpgradeChoice.playerId`, `lastRoll.playerId` → after reconnect the player cannot resolve their own pending dialog → freeze | stable per-seat `playerId` decoupled from `socket.id`; `socket.id` never appears in `GameState`. Remapping ceases to exist as a concept |
| B21 | `gameEngine.js:970-985` vs `server.js:190`, `:221` | Two contradictory bankruptcy models — `checkLiquidation` sets `isBankrupt = true`; the rent handlers set it **false** and jail for 5 turns. Game-over detection is therefore unreliable | one `bankruptcy.ts`; "can't pay" is a house rule flag (`onBankruptcy: 'eliminate' \| 'jail'`) resolved in one place |
| B22 | `roomManager.js:225-249` | `autoPass` reimplements rent settlement instead of calling `resolveRentPayment` → timeout produces a different outcome than clicking Pay | `autoPass` emits the same `Action`s a human would |
| B23 | `index.html:2437` | `moneyVisible` enforced client-side only; the server broadcasts every player's money | `view.ts projectFor()` strips other players' `money` server-side. Also strips `hazakDeck`/`mahkamaDeck` contents and other players' `blindCard` |
| B24 | `gameEngine.js:255` | `getUpgradeOptions` offers all three tiers unconditionally (`if (square.upgrade !== 'garage') push('garage')` …), so from a `market` a player can pay $250 for a `garage` — **a downgrade you pay for**, and tiers can be skipped | tiers strictly ordered `garage → rest_stop → market`; only the next tier is offered; a purchase that would lower the tier is rejected |
| B25 | `src/state.js:121` / `src/deck.js:596` vs `gameEngine.js:386` | Two building models with different cost *and* rent formulas: `src/` uses `buildings: string[]` with cost = % of `purchase_price`; the server uses `upgrade: string` with cost from `owner_paying`. **The server model matches the data and wins**; the `src/` model is deleted | single `upgrade: UpgradeTier \| null`; one `calculateRent` reading `visitor_paying[tier+'_rent']`; build cost reads `owner_paying[tier+'_rent']` |
| B26 | `server.js:688-693` | `broadcastState` logs "👉 X's turn" on **every** broadcast whenever phase is `roll` → duplicate log lines and toast spam | log emitted from the `TURN_STARTED` domain event only |
| B27 | `index.html:2486`, `:2758` | `updateUI` wraps its whole body in `try/catch` and only `console.error`s → **every render bug is invisible** | no blanket catch; a top-level error boundary shows a visible banner and rethrows in dev |
| B29 | `roomManager.js:172-185` | Timer broadcasts `timer_sync` every second to the whole room; `timerSeconds` also lives in `GameState`, so it is duplicated into every `state_update` | timer is transport-level only, removed from `GameState` |
| B30 | `src/dice.js:8`, `gameEngine.js:110` | Board size `34` hardcoded in two places | `BOARD_SIZE` derived from loaded board data in `rules.ts` |
| B31 | `gameEngine.js:58` vs `board.json:game_meta.pass_go_salary` | Server defaults salary to `250` from options; single-player read it from board data; `HANDOFF.md` claims `350` | one resolution path: `options.passGoSalary ?? board.game_meta.pass_go_salary` |
| B32 | `roomManager.js:155` vs `board.json:game_meta.min_players` | Server allows 2 players, data says `min_players: 3` | **decided: minimum is 2.** `data/board.json` corrected to `min_players: 2`; the server and host UI both read it from data, no hardcoded `2` |

### Found during Phase 1 data-schema audit (not in the original ledger)

| ID | Location | Defect | Fix |
|---|---|---|---|
| B36 | `gameEngine.js:514` vs `data/hazak.json` card 14 | The data key is `"half price"` (**with a space**); the server reads `card.half_price` (underscore), which is always `undefined`. **The half-rent card has never worked in multiplayer.** The deleted `src/deck.js:159` read `card["half price"] === 1` correctly, so this was a server-only regression | typed `HazakCard` with `"half price": 0 \| 1` makes `card.half_price` a **compile error**; a normalising data loader maps it to `halfPrice: boolean` once, at the edge |
| B37 | `gameEngine.js:539` vs `data/hazak.json` card 7 | `pool_source: "random_cities"` and `unowned_only: false` are ignored — the engine shuffles all properties regardless. Currently harmless because `unowned_only` happens to be `false` for the only card that uses it, so the accident matches the intent | honour both fields from the data; a test pins card 7's pool to `unowned_only: false` so a future data flip to `true` cannot silently do nothing |
| B38 | `gameEngine.js:744-749`, `:761-764` | Choice `label` strings and the cash `amount` exist in the data but are **hardcoded** in the engine, and the option order is inverted (data lists `claim_free_property` first, code emits cash first). No visible defect today only because the hardcoded `100` coincides with `choices[1].amount` | render `choice.label` and `choice.amount` from the data; option order follows data order. Removes a silent-divergence trap |

### Project hygiene

| ID | Location | Action |
|---|---|---|
| B33 | `hotseat.html`, `src/state.js`, `src/engine.js`, `src/deck.js`, `src/turn.js`, `src/dice.js`, `src/liquidation.js`, `src/utils.js`, `src/main.js`, `index.js`, `package.json:13` | Delete (hot-seat dropped per decision). `src/main.js` is a comment, `index.js` is a stub |
| B34 | `stress.js`, `stress-test-output.txt`, `stress-test-complete.txt` | Delete. Replaced by `tests/soak/play.test.ts` with real assertions |
| B35 | `HANDOFF.md` | Stale — documents a `multiplayer/` directory that no longer exists, and rules (350 salary, buildings array) that were never true on the server. Replace with `docs/ARCHITECTURE.md` generated from the final code |

---

## 4. Implementation Phases

Each phase ends green: `npm run typecheck && npm test` pass, and the app is
launchable. Phases 0–3 do not change runtime behaviour of the shipped app.

### Phase 0 — Scaffolding & dead-code removal

1. Add `typescript`, `vitest`, `@types/node`, `@types/express`,
   `socket.io-client` (dev), `@vitest/coverage-v8`.
2. `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`,
   `exactOptionalPropertyTypes: true`, `moduleResolution: "bundler"`.
3. `vite.config.ts` + `vitest.config.ts`; `package.json` scripts:
   `dev`, `server`, `client`, `build`, `preview`, `test`, `test:soak`,
   `typecheck`.
4. Move `board.json`, `hazak.json`, `mahkama.json` → `data/`.
5. Delete B33/B34 files. Remove the `hotseat` npm script.
6. `.gitignore`: add `coverage/`, `*.tsbuildinfo`.

**Exit:** `npm run typecheck` passes on an empty `src/`; `npm run build` produces
`dist/`; old server still boots via the (still-present) `server.js`.

### Phase 1 — `shared/` types + engine primitives

1. `shared/types.ts`: `Square` union (`Property | CornerSquare | DeckTrigger |
   DualDeckTrigger`), `Card` union (Hazak field-style vs Mahkama `action`-style),
   `Phase` union, `Player`, `GameState`, `Action` union, `DomainEvent` union.
   `GameState` contains **no** `socket.id`, no timer, no transient UI fields.
2. `shared/rules.ts`: `BOARD_SIZE` (derived), `SELL_REFUND_RATIO .75`
   (the only ratio not present in the data), `UPGRADE_ORDER = ['garage',
   'rest_stop', 'market']`. Upgrade **costs are not** constants — they come from
   `owner_paying[tier+'_rent']` in `data/board.json`, and rents from
   `visitor_paying[tier+'_rent']`. `types.ts` documents this: `owner_paying` is
   the *build cost* table, `visitor_paying` the *rent* table; the `_rent` suffix
   on both is a data-format wart, not a semantic.
3. `engine/rng.ts` seedable PRNG; `engine/board.ts` (`step`, `wouldPassGo`,
   `findSquare`) — fixes **B30**; `engine/dice.ts`; `engine/deck.ts` with
   mandatory `deckType` — fixes **B07** by construction.
4. Zod-free runtime validation of the three data files at load (a small
   hand-written validator) so a malformed `board.json` fails fast.

**Tests:** `step` wraps 34→1 correctly; `wouldPassGo` false for backward card
moves; `deck.draw` reshuffles from the matching discard only; `deck.discard`
throws on pile mismatch; every card in `hazak.json`/`mahkama.json` parses to a
known variant (guards against future data typos).

**Exit:** ≥ 90% line coverage on `engine/board.ts`, `dice.ts`, `deck.ts`, `rng.ts`.

### Phase 2 — Engine core as a reducer

1. `engine/property.ts` — buy, `calculateRent` from `visitor_paying` (single
   formula, **B25**), `getUpgradeOptions` (**next tier only**, **B24**),
   `purchaseUpgrade` (cost from `owner_paying`, unchanged economy),
   `sellUpgrade` (75% of that cost), `sellPropertyToBank`. Properties without
   `owner_paying`/`visitor_paying` (e.g. square 16, محطة بنزين) are
   non-upgradable — typed as a distinct `UtilityProperty` variant so the
   check is structural, not a runtime `if`.
2. `engine/cards.ts` — all Hazak + Mahkama effects, choice setup and resolution;
   `cityIds` on the action payload (**B08**).
3. `engine/turn.ts` — movement + single salary credit (**B04**), `finishTurn`,
   `advanceTurn` (iterative, bounded, post-condition, **B28**), prison actions
   with roll rejection while jailed (**B05**).
4. `engine/bankruptcy.ts` — one model, `onBankruptcy` house rule (**B21**).
5. `engine/index.ts` — `createGame`, `applyAction` with an authorization table
   keyed by `(phase, action.type)` → required actor. Exhaustive `switch` with a
   `never` fallthrough (**B02**, **B09**).
6. Delete old `src/*.js` and `gameEngine.js` once parity tests pass.

**Tests (regression, one per ID):** B04 landing exactly on square 1 credits the
salary once; B05 `ROLL_DICE` while jailed is rejected; B07 20 Mahkama draws
never grow `hazakDiscard`; B08 charged owners match the announced `cityIds`;
B09 a non-owner `CONFIRM_CARD` is rejected; B10 square 4 produces exactly two
draws in deck order mahkama→hazak; B24 on القدس only `garage` ($250) is offered
at tier 0, only `rest_stop` ($750) after that, and `garage` is **not** offered
once `market` is built; B25 rent at each tier equals
`visitor_paying[tier+'_rent']` exactly (190 / 900 / 1550 on القدس) and build cost
equals `owner_paying[tier+'_rent']` (250 / 750 / 1000); square 16 offers no
upgrades; B28 all-but-one skipping still lands on an active player; B21
elimination sets `isBankrupt` and never both flags.

**Exit:** ≥ 95% coverage on `src/engine/**`; `gameEngine.js` and old `src/*.js`
deleted; `npm run typecheck` clean.

### Phase 3 — Trade & bid as pure state machines

1. `engine/trade.ts` — states `proposing_a → reviewing_b → proposing_b →
   reviewing_a → settled`, atomic basket validation before mutation (**B15**),
   typed rejection reasons (**B12**), `expireTrades(state, reason)` (**B14**),
   no writes to `state.phase` (**B13**), seat-keyed rate limit (**B16**).
2. `engine/bid.ts` — same treatment for bids/offers, including the same atomic
   settlement and upgrade-property rejection.

**Tests:** B12 proposing an upgraded property returns
`{ rejected: 'property_has_upgrade' }`; B13 cancelling a trade during another
player's `card_choice` leaves `phase` untouched; B14 disconnect expires the
trade and the player can open a new one; B15 offering 2 jail cards while holding
1 is rejected and no cards are created; B16 rate limit survives a simulated
reconnect; settlement is all-or-nothing under an injected mid-transfer failure.

### Phase 4 — Server rewrite on the engine

1. `server/rooms.ts` — lobby, seats with **stable `playerId` decoupled from
   `socket.id`** (**B20** disappears entirely), join/rejoin/kick
   (`eliminated` flag, no splice, **B06**), `min_players` from data (**B32**).
2. `server/turnTimer.ts` — one interval per room, `clearInterval` on every exit
   path, guarded start (**B01**); timer removed from `GameState` (**B29**).
3. `server/view.ts` — `projectFor(playerId, state)`: strips other players'
   `money` when `moneyVisible === false`, strips deck contents, strips other
   players' `blindCard` (**B23**).
4. `server/handlers/*.ts` — each handler authorizes, builds an `Action`, calls
   `applyAction`, broadcasts projections + maps `DomainEvent[]` → socket emits.
   Turn-start log emitted from `TURN_STARTED` only (**B26**). `USE_JAIL_FREE`
   handler exists (**B03**). `autoPass` emits the same actions a human would
   (**B22**) and covers every phase exhaustively (**B02**).
5. `server/snapshot.ts` — signed, replay-proof resume (**B19**), see §4a.
6. Salary resolution single-path (**B31**); `min_players` read from data,
   corrected to `2` (**B32**).

**Tests (integration, real `socket.io-client`):**
- B01: 30 consecutive turns; assert exactly one live interval per room and
  `timer_sync` arrives at 1 Hz ±10%.
- B02: for each of `draw_card`, `upgrade_choice`, `rolling`, `blind_card`,
  `card_choice`, `club_choice`, `property_choice`, `rent_payment`, `roll` —
  let the timer expire and assert the turn advances within 2 s.
- B03: jail-free button releases the player and does not throw.
- B06: host kicks the current player → turn advances, indices stay valid.
- B19: a client emitting a forged `gameState` cannot alter server state
  (event removed → assert the room is untouched).
- B23: player A's socket never receives player B's `money` when
  `moneyVisible: false`, and never receives deck contents.
- B26: exactly one "turn" log line per turn.

**Exit (Phase 4):** all Phase 4 integration tests green; `autoPass` covers every
`Phase` variant; no `socket.id` appears in `GameState`.

### Phase 4a — Signed server snapshots (B19)

Resume is kept, but the client can no longer author state. The client holds an
**opaque, signed blob** it cannot forge or usefully replay.

`server/snapshot.ts`:

```ts
type SignedSnapshot = {
  payload: string;   // base64 of canonical JSON: { roomCode, stateVersion,
                     //   issuedAt, seatIds, state }
  sig: string;       // hex HMAC-SHA256(payload, secret)
  v: 1;              // envelope version
};
```

- **Signing.** `createHmac('sha256', secret)` over the exact `payload` bytes.
  Canonical JSON = sorted keys, so re-serialisation is byte-stable.
- **Secret.** `BANKELHAZ_SECRET` env var. If unset, generate 32 random bytes and
  persist to `.data/secret` (mode `0600`, gitignored) so dev restarts keep
  working. Production start-up **logs a warning** if the secret was
  auto-generated.
- **Issuing.** After each `applyAction`, the room's `stateVersion` increments.
  A fresh snapshot is emitted to each connected player as
  `snapshot_issued { snapshot }` (throttled to at most 1/turn), and the client
  stores it verbatim in `localStorage` — it is never parsed for gameplay.
- **Restoring.** `restore_game { snapshot }` → verify HMAC with
  `crypto.timingSafeEqual`, then check **all** of:
  1. `roomCode` in the payload has no live room (otherwise → plain `rejoin`);
  2. `stateVersion > highestSeenVersion[roomCode]`, read from persisted
     `.data/versions.json` — this is what makes **rollback replay impossible**;
     a player cannot restore an older, richer snapshot;
  3. `issuedAt` within `SNAPSHOT_TTL` (default 24 h);
  4. the requesting seat id appears in `payload.seatIds`.
  On success: install the state, bump `highestSeenVersion`, seat the requester.
  On any failure: `restore_rejected { reason }`, state untouched.
- **Recovery of the version counter.** `.data/versions.json` is written
  synchronously on every bump, so a crash cannot lose more than one version and
  the worst case is one rejected legitimate restore, never an accepted replay.

**Tests:**
- valid snapshot restores; `stateVersion` and money match the issued state;
- flipping one byte of `payload` → rejected `bad_signature`;
- flipping one byte of `sig` → rejected `bad_signature`;
- a snapshot re-submitted after a newer one was restored → rejected
  `stale_version` (the replay attack);
- hand-crafted payload with `money: 999999` and no valid sig → rejected;
- snapshot for a room that is still live → routed to `rejoin`, not installed;
- expired `issuedAt` → rejected `expired`;
- a seat id absent from `seatIds` → rejected `not_a_participant`;
- `timingSafeEqual` is used (no `===` on the signature — asserted by lint rule
  or a direct source assertion).

**Exit (Phase 4a):** `server.js` and `roomManager.js` deleted; the old client
(`index.html`'s inline JS) still runs against the new server via the same event
names, or the event rename is applied in the same commit as Phase 5.

### Phase 5 — Client split & TypeScript

1. `index.html` reduced to markup + a single `<script type="module"
   src="/src/client/main.ts">`; CSS extracted to `src/client/styles/*.css`.
2. `client/store.ts` holds `myOffer` and all UI state — the DOM is never read as
   a data source (**B17**, **B17b**).
3. `client/dialogs/manager.ts` — one owner of modal visibility with an explicit
   priority order, replacing the ad-hoc `closeAllModals()` /
   `checkPhaseFromState()` pairing (`index.html:2491`, `:2763`) that both
   force-closes and reopens modals on every `state_update`.
4. Trade timer display driven only by `trade_timer_sync` (**B18**).
5. Blanket `try/catch` removed; a visible error banner replaces it (**B27**).
6. Typed socket client from `shared/events.ts`.

**Tests:** dialog-manager unit tests (priority order, no two modals visible,
reopen-on-reconnect); `store` reducer tests for the trade basket; a Vitest DOM
test asserting a dragged jail card reaches the emitted proposal payload (**B17**).

### Phase 6 — Soak, docs, cleanup

1. `tests/soak/play.test.ts` — 4 players, seeded RNG, 200 turns headless
   through the real server, asserting after **every** action:
   - no non-bankrupt player has `money < 0`;
   - `hazakDeck.length + hazakDiscard.length === 15` and likewise for mahkama,
     and **no card appears in the wrong pile**;
   - every `square.owner` is `null` or a live seat id;
   - `currentPlayerIndex` in range and pointing at a non-eliminated player;
   - exactly one timer interval per room;
   - no phase persists longer than `2 × turnTimeout`;
   - the game terminates (winner or draw) within 200 turns.
2. `docs/ARCHITECTURE.md` written from the final code; `HANDOFF.md` deleted
   (**B35**).
3. `README.md` with accurate run instructions (the old ones in `HANDOFF.md:381`
   point at `/home/joe/Projects/`).

**Exit:** soak test green over 5 different seeds.

---

## 5. Acceptance Criteria

Every criterion is machine-checkable.

**Build & types**
1. `npm run typecheck` exits 0 with `strict: true`.
2. `npm run build` exits 0 and emits `dist/`.
3. `grep -rn "any" src/` yields no unsuppressed `any` outside declared
   `unknown`-narrowing helpers.

**Tests**
4. `npm test` exits 0; ≥ 90% line coverage on `src/engine/**` and
   ≥ 70% on `src/server/**`.
5. `tests/regression/` contains exactly one passing test per bug ID B01–B32 **and
   B36–B38** (B33–B35 are hygiene deletions, verified by criterion 7 instead).
   B36 specifically: hazak card 14 sets `payHalfRentNextLanding`, and the next
   rent paid is halved.
6. `npm run test:soak` passes on seeds `1, 2, 3, 4, 5`.

**Structural**
7. `gameEngine.js`, `roomManager.js`, `server.js`, `hotseat.html`, `stress.js`,
   `index.js`, `src/*.js`, `stress-test-*.txt`, `HANDOFF.md` are all absent.
8. `wc -l index.html` ≤ 250.
9. No file in `src/` exceeds 400 lines.
10. `grep -rn "Math.random\|Date.now" src/engine/` returns nothing (RNG and clock
    are injected).
11. `grep -rn "socket\|io\." src/engine/` returns nothing.
12. `grep -rn "socket.id" src/shared/types.ts src/engine/` returns nothing
    (stable seat ids only).
13. Exactly one definition each of `calculateRent`, `advanceTurn`,
    `calculateNewPosition`/`step`, and the shuffle helper across the repo.

**Behavioural (asserted by the tests above)**
14. Landing exactly on square 1 credits `pass_go_salary` once (B04).
15. 200 Mahkama draws leave `hazakDiscard` free of Mahkama cards (B07).
16. Announced `cityNames` on a `collect_from_city_owners` card match the players
    actually charged (B08).
17. Square 4 yields exactly two card draws, Mahkama then Hazak (B10).
18. A jailed player cannot roll, by button or by timeout (B05).
19. For all nine phases, timer expiry advances the game within 2 s (B02).
20. Jail-free release works end-to-end (B03).
21. A trade cancelled during another player's turn does not change `phase` (B13).
22. Jail-card and property totals are conserved across every executed
    trade and bid (B15).
23. A dragged jail card appears in the emitted proposal payload (B17).
24. With `moneyVisible: false`, a client's received state never contains another
    player's `money`, nor any deck contents (B23).
25. Only the next upgrade tier is ever offered; costs equal
    `owner_paying[tier+'_rent']` and rents equal `visitor_paying[tier+'_rent']`
    for all 34 squares, unchanged from today's data (B24/B25).
26. Exactly one turn-start log line per turn (B26).
27. `restore_game` accepts only snapshots carrying a valid HMAC **and** a
    `stateVersion` strictly greater than the highest previously restored for that
    room code. Forged payloads, byte-flipped signatures, and replays of older
    snapshots are all rejected with state untouched (B19).
28. `grep -rn "=== *sig\|sig *===" src/server/snapshot.ts` returns nothing —
    signature comparison uses `crypto.timingSafeEqual`.
29. `data/board.json` has `min_players: 2` and no `2` is hardcoded as a player
    minimum in `src/` (B32).

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Big-bang rewrite regresses working behaviour (animations, themes, board layout) | High | Phases 0–4 leave the client untouched and event names stable; the board/theme/animation code is *moved*, not rewritten, in Phase 5. Visual diff by screenshot on 3 viewports before/after. |
| Economy is unchanged (B24/B25 decided in favour of the JSON), so a "fix" that users expect to change costs will not | Low | `docs/ARCHITECTURE.md` states plainly that `owner_paying` = build cost and `visitor_paying` = rent, and that the `src/` %-of-price model was the incorrect one. A test pins all 34 squares' costs and rents to today's data so any future drift is caught. |
| Snapshot secret auto-generated in production → snapshots silently unverifiable after a redeploy on a fresh filesystem | Medium | `.data/secret` persisted `0600`; start-up warns loudly when the secret was auto-generated; `BANKELHAZ_SECRET` documented as required for any deployment with a non-persistent disk. Rejected restores fail closed with a clear client message, never by installing state. |
| Snapshot replay: a player hoards a favourable early snapshot and restores it later | High if missed | Monotonic `stateVersion` per room code persisted in `.data/versions.json`, checked with a strict `>`; dedicated regression test replays an older snapshot and asserts rejection. Fails closed. |
| Snapshot bloats `localStorage` (full `GameState` per issue) and the existing `catch {}` around `setItem` (`index.html:1279`) hides quota failures | Low | One snapshot key only, overwritten; throttled to 1/turn; quota failure surfaces a visible warning instead of being swallowed. |
| Stable seat ids (B20) change the wire format of every player-id field | Medium | Landed atomically in Phase 4 together with the client's id handling; integration tests cover reconnect before the phase is declared done. |
| Hot-seat removal (B33) drops offline play entirely | Low | Confirmed twice by the user. `docs/ARCHITECTURE.md` records the removal; a single-player mode against local seats is a possible follow-up on top of the unified engine (cheap, since the engine no longer depends on the network). |
| TS migration stalls on `import … with { type: 'json' }` + Vite + Node interop | Low | Data loaded through a single `data/index.ts` module with an explicit validator; no assertion syntax in app code. |
| Scope creep into new features | Medium | Non-goals section is binding; any feature request becomes a follow-up. |

---

## 7. Verification Steps

Run in order; each must pass before the next phase is considered complete.

```bash
npm ci
npm run typecheck                 # 0 errors, strict
npm test                          # unit + regression + integration
npm run test:soak                 # seeds 1-5, 200 turns each
npm run build                     # dist/ emitted
npm run server &                  # boots on :3001
```

Manual smoke (4 browser tabs, one room):
1. Host + 3 joins; start game; confirm turn order and a single 1 Hz timer.
2. Let a turn expire in each of the nine phases; confirm no freeze (B01/B02).
3. Land on square 4; confirm two cards, Mahkama then Hazak (B10).
4. Draw 10 Mahkama cards; confirm the deck counter for Hazak never grows (B07).
5. Go to prison; confirm Roll is refused, Bail works, Jail-Free works (B03/B05).
6. Full trade with cash + property + jail card; confirm all three transfer
   (B15/B17).
7. Open a trade, then cancel it while another player is mid card-choice;
   confirm their dialog is unaffected (B13).
8. Kill a tab mid-turn; rejoin; confirm the pending dialog is still actionable
   (B20).
9. Host with money hidden; confirm the DevTools network payload contains no
   other player's `money` (B23).
10. Restart the server mid-game; click Resume; confirm the game returns at the
    same `stateVersion` (B19).
11. Hand-edit the `localStorage` snapshot to raise your money, click Resume;
    confirm rejection with `bad_signature` and no state change (B19).
12. Save a snapshot, play 3 more turns, restart the server, restore the **newer**
    snapshot, then attempt the older one; confirm `stale_version` rejection
    (B19 replay).
13. Start a room with exactly 2 players; confirm the game starts (B32).

Structural checks:

```bash
wc -l index.html                                  # ≤ 250
find src -name '*.ts' | xargs wc -l | sort -rn    # no file > 400
grep -rn "Math.random\|Date.now\|socket" src/engine/   # empty
ls gameEngine.js roomManager.js server.js hotseat.html stress.js 2>&1  # not found
```

---

## 8. Estimated Shape

| Phase | Net LOC | Files touched |
|---|---|---|
| 0 Scaffold | +120 / −4,200 | 12 |
| 1 Types + primitives | +900 | 10 |
| 2 Engine core | +1,600 / −1,900 | 18 |
| 3 Trade + bid | +700 | 8 |
| 4 Server | +900 / −1,580 | 14 |
| 4a Signed snapshots | +260 | 5 |
| 5 Client | +2,400 / −3,750 | 30 |
| 6 Soak + docs | +600 / −450 | 6 |

Roughly a net reduction of ~1,000 lines with test coverage going 0 → ~90% on the
rules engine.

---

## 9. Resolved Decisions

All blocking questions are answered; nothing is outstanding.

| # | Question | Decision |
|---|---|---|
| 1 | Refactor depth | **One shared engine.** Single authoritative rules engine; `src/*` and `gameEngine.js` duplication deleted |
| 2 | Hot-seat mode | **Dropped** (confirmed twice). `hotseat.html` + old `src/*.js` deleted |
| 3 | Toolchain | **TypeScript** (`strict`) + Vitest + split client modules |
| 4 | Upgrade costs & rents | **The JSON is authoritative.** `owner_paying` = build cost, `visitor_paying` = rent. Economy unchanged; the `src/` %-of-`purchase_price` model was wrong and is deleted. B24 narrows to the tier-ordering defect only |
| 5 | Save / resume | **Signed server snapshots** (§4a) — HMAC-SHA256, monotonic `stateVersion`, TTL, participant check. Resume survives a server restart; forgery and replay do not |
| 6 | `min_players` | **2.** `data/board.json` corrected from `3`; no hardcoded minimum |

**Remaining gate:** this plan is `pending approval` and **no source file has been
modified**. Confirm to begin Phase 0.
