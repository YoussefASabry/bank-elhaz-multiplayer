# Bank El Haz — Refactor Handoff

**Branch:** `refactor/unified-engine-ts` (off `master`)
**State:** mid-refactor. Engine core largely done; **server and client are NOT yet migrated.**
**Gates at time of writing:** `tsc --noEmit` 0 · `vitest run` 217 passing / 8 files · `vite build` 0

> This file replaces the previous HANDOFF.md, which was stale: it documented a
> `multiplayer/` directory that no longer exists, a `$350` pass-go salary that was
> never true on the server (the data says 250), and a building model
> (`buildings: string[]`, cost = % of purchase price) that only the deleted
> single-player engine used.

The authoritative plan is [`.omc/plans/2026-07-30-bank-elhaz-refactor.md`](.omc/plans/2026-07-30-bank-elhaz-refactor.md).
It carries the full 38-item bug ledger with file:line citations. Read it before
continuing.

---

## 1. What this refactor is

The game had pervasive defects in trading, dialogs, turn tracking and state
management. Three structural causes, not thirty independent bugs:

1. **Rules existed twice and disagreed.** `src/*.js` (client, 1,300 lines) and
   `gameEngine.js` (server, 986 lines) implemented the same game with *different*
   models. Rent and build-cost formulas differed outright.
2. **No single writer.** `server.js` mutated `room.gameState` directly in 8
   places, `roomManager.js` in ~12 more. Any invariant could be broken from any
   layer.
3. **Untyped, untested, unsplit.** Zero tests, no `test` script, `index.html` was
   3,996 lines of inline CSS+JS, and `updateUI` wrapped its whole body in
   `try/catch` so every render bug was invisible.

### Decisions already made (by the user — do not relitigate)

| # | Decision |
|---|---|
| 1 | **One shared engine.** Duplication deleted, not maintained. |
| 2 | **Hot-seat dropped.** `hotseat.html` + all of `src/*.js` deleted. Multiplayer only. |
| 3 | **TypeScript**, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. |
| 4 | **The JSON is authoritative for the economy.** `owner_paying` = build cost, `visitor_paying` = rent. Economy is unchanged by this refactor. |
| 5 | **Signed server snapshots** for save/resume — not deletion of the feature. |
| 6 | **`min_players` is 2.** `data/board.json` corrected from 3. |

**On #4, read this before touching `property.ts`.** The `_rent` suffix appears in
*both* tables, which is a data wart, not a semantic. On القدس (id 2, price 300):
building a garage costs `owner_paying.garage_rent` = **250** and then earns
`visitor_paying.garage_rent` = **190** per visit. Costs rise 250/750/1000, rents
rise faster 190/900/1550 — a coherent economy. An earlier draft of the plan
proposed deriving build cost as a percentage of `purchase_price`; that was the
*deleted* engine's model, it did **not** match this data, and reintroducing it
would silently change game balance.

---

## 2. Architecture

Server-authoritative pure-reducer engine. The engine never imports socket.io and
never calls `Math.random()` or `Date.now()` — randomness and time are injected.

```
data/                 board.json  hazak.json  mahkama.json   (moved from root)
src/
  shared/             the vocabulary; no logic
    raw.ts            on-disk JSON shapes, warts quarantined here
    types.ts          Square/Card/Player/GameState/Phase/Pending unions
    trading.ts        Basket/Trade/Bid
    actions.ts        Action + DomainEvent + RejectReason
    rules.ts          constants (deliberately thin — costs come from data)
    events.ts         typed socket.io contract
  engine/             pure, deterministic, no I/O
    rng.ts            seedable mulberry32
    board.ts          load + validate + movement
    deck.ts           card normalisation + draw/discard
    dice.ts
    state.ts          state factory + accessors
    property.ts       rent, upgrades, buy/sell
    cards.ts          all card effects + choices
    turn.ts           rolling, landing eval, handover, prison
    bankruptcy.ts     one insolvency model + game over
    trade.ts          trade state machine
    bid.ts            bid state machine
  server/
    snapshot.ts       HMAC signing + replay gate
    versionStore.ts   persisted monotonic version per room
  client/styles/      CSS extracted from index.html (800 lines, 5 files)
tests/
  helpers/fixtures.ts SINGLE-AUTHORED shared fixture — extend this, don't inline
  engine/*.test.ts
  server/*.test.ts
```

### Two structural choices that kill bug classes

**No socket ids in `GameState`.** Players are identified by a stable `SeatId` that
outlives reconnects. The old server stored `socket.id` in state and had to remap
six fields on every rejoin, missing `activeBids`, `bid.offers`, `trades`,
`pendingClubChoice`, `pendingUpgradeChoice` and `lastRoll` — so after a reconnect
you could not resolve your own dialog and the game froze (B20). With stable seats
there is nothing to remap.

**One `pending` slot, as a discriminated union.** The old state had eight
independently-nullable `pendingX` fields that could all be set at once — the root
of several freezes. Conflicting pending states are now a type error. `phase` is
kept in lockstep via `phaseForPending()` in `turn.ts`.

### The contract to build against

```ts
applyAction(state, action, { rng, now }) -> { state, events: DomainEvent[] }
```

**Not yet written — this is the next task (#9).** It is the only function that may
mutate or replace state. It authorizes on `(phase, action.type) -> required actor`
and returns state unchanged plus a `REJECTED` event for anything unentitled. That
single check is what makes B03/B09/B13/B19/B22 unrepresentable rather than merely
fixed.

---

## 3. Where things stand

### Done and verified

| Phase | Deliverable |
|---|---|
| 0 | TS + Vitest + Vite scaffold; deleted `hotseat.html`, all `src/*.js`, `index.js`, `stress.js`, `stress-test-*.txt`; `data/` move; `min_players` 3→2 |
| 1 | `shared/*` (6 files) and engine primitives `rng`/`board`/`deck`/`dice`/`state` |
| 2 | `property.ts`, `cards.ts`, `turn.ts`, `bankruptcy.ts` |
| 3 | `trade.ts`, `bid.ts` |
| 4a-core | `snapshot.ts`, `versionStore.ts` |
| 5-css | CSS extracted, `index.html` 3,996 → 3,192 |

Phase 0 was gated on real output: `tsc` 0, `build` 0 + `dist/`, `node server.js`
LISTENing on 3001 + HTTP 200, and a byte-identical `board_positions` check proving
the economy was untouched.

### Not started

| # | Task | Why it matters |
|---|---|---|
| **9** | `engine/index.ts` — `applyAction` reducer + authorization table | **The keystone.** Nothing below can be wired without it. |
| 13 | Server rewrite: `rooms.ts`, `turnTimer.ts`, `view.ts`, `handlers/*` | Deletes `server.js`, `roomManager.js`, `gameEngine.js` |
| 14 | Wire snapshots into the socket handlers | Core is done; only the wiring is left |
| 15 | Client split into TS modules | `index.html` 3,192 → target ≤250 |
| 16 | `docs/ARCHITECTURE.md`, README, soak test | |

### Deliberately descoped

A dedicated `tests/regression/B01..B38` suite was planned and **dropped** at the
user's request ("no need to be too perfect"). The bugs are covered incidentally by
the module tests instead. If you want the one-test-per-bug-ID matrix back, plan
§5 criterion 5 describes it.

---

## 4. Legacy code is still live — read this before you run it

`server.js`, `roomManager.js` and `gameEngine.js` **are still present and still
running the game.** `index.html` still talks to them. The new `src/engine/` is
fully tested but **not yet connected to anything.**

Consequences:

- `npm run dev` / `npm start` today runs the **OLD** engine. Every bug in the
  ledger that lives in the server layer is still live in a running game.
- The three legacy files are deleted in task 13, not before.
- Do not partially wire the new engine into the old server. The wire format changes
  (stable seat ids, one `action` channel), so it is an atomic swap.

### Bugs still live in the running game

All of these are fixed in the new engine or specified, but the code path users hit
is still the old one:

| ID | Symptom |
|---|---|
| B01 | `clearTimeout` on a `setInterval` handle → timers stack, countdown runs N× fast, `autoPass` storms. **Primary cause of turn chaos.** |
| B02 | `autoPass` has no branch for `draw_card`/`upgrade_choice`/`rolling` → timer hits 0, nothing happens, **permanent freeze** |
| B03 | `manager.useJailFreeCard()` does not exist on `RoomManager` → jail-free button throws |
| B06 | kick splices `gs.players` without fixing `currentPlayerIndex` → turn order shifts / freeze |
| B19 | `restore_game` installs a **client-supplied** `gameState` → forge any money/ownership |
| B20 | reconnect id-remap misses 6 fields → your own dialog becomes unactionable |
| B22 | timeout rent path diverges from the human path |
| B23 | `moneyVisible` enforced client-side only; server broadcasts every balance |
| B26 | turn log line emitted on every broadcast → log/toast spam |
| B17/B17b/B18 | client trade: jail-card input never rendered so dragged cards are dropped; per-side state aliased; client 65s timer vs server 60s trips the phase-corrupting cancel |
| B27 | `updateUI` swallows every error |

---

## 5. Bugs found *during* the refactor (not in the original audit)

**B36 is the headline.** The data key is `"half price"` — **with a space**. The
server read `card.half_price` — with an underscore. Always `undefined`. **The
half-rent card has never once worked in multiplayer.** The deleted `src/deck.js`
read it correctly, so this was a server-only regression that no test could catch
because there were no tests. Now normalised once in `deck.ts` and pinned:

```
✓ B36 — the "half price" key (with a space) is read correctly
  ✓ sets halfRentNextLanding on hazak card 14
  ✓ is the ONLY card that grants half rent
```

- **B37** — `unowned_only` / `pool_source` on hazak card 7 were ignored. Currently
  *latent*: the data says `false` and the engine's behaviour matched by accident.
  Now honoured and pinned so a future data flip to `true` can't silently no-op.
- **B38** — choice `label`s and the cash `amount` live in the data but were
  hardcoded in the engine, with the option order inverted relative to the data.
- **Backward-movement salary.** Beyond B04, the old `passedGo = newPos < oldPos`
  is also wrong for *backward* card moves. `advance()` now computes it
  arithmetically and returns `false` for any backward move.
- **Shared nested board objects.** `{...sq, owner: null}` was a shallow spread, so
  every room shared the *same* `visitor_paying` objects as the module-level JSON
  import. Never mutated, so it never bit — but one careless write from corrupting
  every concurrent room. Ownership now lives outside the board entirely.

Two `RejectReason` variants were added mid-flight because workers correctly
refused to invent strings: `square_already_owned` (guards silent property theft in
`buyProperty`) and `already_has_active_bid` (the old code enforced one bid per
seat at `roomManager.js:739`; dropping it would have regressed into overlapping
bid boxes).

---

## 6. Conventions — follow these

- **`applyAction` is the only writer.** Modules expose pure helpers returning
  `{ ok: true, ... } | { ok: false, reason: RejectReason }`. Add new reasons to the
  union in `shared/actions.ts`; never invent a string at the call site.
- **No `Math.random()` / `Date.now()` under `src/engine/`.** Take an `Rng`; take
  `now: number`. This is what makes the soak test reproducible.
- **Nothing but the reducer writes `state.phase`.** `trade.ts` and `bid.ts` are
  asserted never to touch it (B13).
- **`cards.ts` must not import `property.ts` or `turn.ts`.** Cards move the player
  and signal `needsLandingEval`; `turn.ts` decides what the destination means.
  This avoids a cycle and keeps landing logic in one place.
- **Salary is credited by the movement path only.** The origin square's `salary`
  corner effect pays **nothing** — it is just the marker identifying the origin.
  Both `advance().passedGo` and `applyTeleport` credit exactly once (B04).
- **Extend `tests/helpers/fixtures.ts`** rather than hand-rolling state in a test.
- `vitest` transpiles **without** typechecking, so a green test run does not mean
  it compiles. Always run both.

### ⚠ `applyAction` MUST mutate state in place — do not go immutable

`trade.ts:86` keys its rate limiter on **`GameState` object identity**:

```ts
const tradeOpenLog = new WeakMap<GameState, Map<SeatId, number[]>>();
```

That was the right call — a bare module-level `Map<SeatId, …>` would leak counters
across concurrent rooms and across every test reusing a seat id like `'seat-a'`.
But it couples the limiter to the current in-place mutation style. **If the reducer
is written to return a fresh state object per action, the trade rate limit
silently resets to zero on every call** and B16 regresses with no test failure and
no type error. The tests won't catch it because they hold one state object
throughout.

If you do want an immutable reducer, move the counter into `GameState` itself
first, then convert. Don't convert and hope.

### `CHOOSE_CARD_OPTION.index` is an index into a FLATTENED list

`resolveChoice` in `cards.ts` does **not** index `card.choices` directly.
Non-pool choices (`receive_cash`, `pay_fine`, `go_to_prison`) are one entry each,
but a `claim_free_property` or `move_to_dynamic_pool` choice **expands to one entry
per resolved `propertyPool` city**. So a card offering "cash or a free city" with 4
eligible cities presents 5 options, not 2.

The reducer and the client must both compute the index against that expansion.
No card in this dataset has more than one pool-bearing choice, so the flattening is
unambiguous — but it is an easy off-by-N and it would manifest as "the player
picked Cairo and got Aswan", which no type checker will catch.

---

## 7. Known debt

- `src/engine/cards.ts` is **409 lines**, just over the 400-line ceiling the plan
  sets (criterion 9). Split it when convenient.
- `bid.ts` and `trade.ts` duplicate basket validation (~20 lines). Deliberate:
  two agents were building them concurrently and a shared helper would have
  conflicted. Extract now that both call sites are finished.
- `setupChoices()` returns `remainingDraws: []` as a placeholder; the caller must
  copy the real queue from the originating `blind_card` pending. Fragile — the
  reducer (#9) should encapsulate it.
- No commits existed until this one, so there are no intermediate rollback points
  for phases 0–3.
- **`trade.ts` and `bid.ts` have different `Result` shapes.** `trade.ts` returns
  `{ ok, events, value }`; `bid.ts` returns `{ ok, value }` and leaves event
  construction to the caller. Deliberate — `cancelTrade` takes a caller-supplied
  reason string that has nowhere to live but its event. The reducer can forward
  `.events` or build its own; both work, but pick one convention and note it.
- **Self-trade is rejected with `not_the_entitled_player`** (`trade.ts:134`) because
  no dedicated reason exists. Add `cannot_trade_with_self` if the client needs to
  distinguish it.
- **`setupChoices()` returns `remainingDraws: []` as a placeholder.** It has no
  knowledge of the originating `blind_card`'s queue, so the caller must copy the
  real queue across when installing the `card_choice` pending. Fragile; the reducer
  should encapsulate it so no future caller has to remember.

### Unverified risk: CSS cascade after the extraction

All seven `@media` blocks were moved into `responsive.css`, which loads **last**.
In the original single stylesheet some of those media blocks sat physically
*before* later non-media rules (the trade and card-redesign sections). Where an
earlier media rule and a later non-media rule set the **same property** on the
**same selector** at **equal specificity**, moving the media queries to the end can
flip which one wins.

What was verified: content parity (sorted, normalised line-multiset diff between
the original 809-line block and the concatenation of the 5 files — zero
differences, 722 lines each side; brace count 514 vs 514), and no exact
selector+property collisions between the media blocks and the other files.

What was **not** verified: a live pixel-diff of the rendered page before vs after.
So this is content parity, not proven visual parity. If a responsive layout looks
wrong on a narrow viewport, this is the first thing to suspect.

---

## 8. How to run

```bash
npm install
npm run dev        # OLD engine — server.js on :3001 + vite on :5173
npm test           # new engine: 217 tests
npm run typecheck  # tsc --noEmit, strict
npm run build      # vite build -> dist/
```

There is no hot-seat mode any more; `npm run hotseat` was removed.

---

## 9. Next step

Write `src/engine/index.ts` (task 9): `createGame` + `applyAction` with the
`(phase, action.type) -> required actor` authorization table and an exhaustive
`switch` over `Phase` with a `never` fallthrough, so a missing phase branch is a
compile error rather than the permanent freeze it is today (B02). Everything else
is blocked on it.
