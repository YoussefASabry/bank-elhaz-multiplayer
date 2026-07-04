# 🏦 Bank El Haz (بنك الحظ) — Handoff (v2)

Arabic-themed Monopoly-like board game. **Online multiplayer only** (2–6 players) — the old
single-player hot-seat mode was removed in the v2 rewrite.

## Tech stack

| Component | Technology |
|-----------|-----------|
| Game engine | Pure JS state machine (`server/engine.js`), server-authoritative, injectable RNG |
| Server | Node.js + Express + Socket.IO 4 (`server/index.js`, `server/roomManager.js`) |
| Client | Vanilla JS ES modules built with Vite (`client/`) |
| Tests | Vitest (`tests/`) — 79 tests incl. seeded full-game fuzz simulation |
| State | In-memory, one Node process (no DB) |

## Directory structure

```
├── server/
│   ├── engine.js        # ALL game rules. No sockets/timers. dispatch(playerId, action) → {ok, error, events}
│   ├── roomManager.js   # Rooms, timers (turn 90s / auction 15s / trade 60s), reconnect grace, state sanitization
│   └── index.js         # Express + Socket.IO wiring, serves dist/ in production
├── shared/              # board.json (34 squares), hazak.json, mahkama.json (15 cards each)
├── client/
│   ├── index.html       # lobby + game shell + overlays
│   ├── styles.css       # responsive board (container queries), sidebar, overlays
│   ├── public/assets/pfps/avatar1..20.svg
│   └── src/
│       ├── main.js      # app orchestration: lobby, state application, sidebar, action panel, trade, overlays
│       ├── board.js     # board grid render, tokens, movement animation
│       └── sounds.js    # WebAudio synth (no audio assets), mute toggle persisted
├── tests/               # engine.test.js, cards.test.js (every card), simulation.test.js (seeded fuzz)
├── Dockerfile           # multi-stage production image
└── vite.config.js       # client root, /socket.io proxy for dev, vitest config
```

## How to run

```bash
npm install
npm run dev      # server :3001 + vite client :5173 (proxied websockets)
npm test         # vitest suite
npm run build    # client → dist/
npm start        # production: single server on :3001 serving dist/ + sockets
```

## Deploying

The production build is a **single Node process**: Express serves the built client from
`dist/` and Socket.IO handles the game on the same port. State is in-memory, so run exactly
**one instance** (no horizontal scaling / no sticky-session setup needed).

- **Railway / Render / Fly.io** (recommended): point at the repo; build `npm ci && npm run build`,
  start `npm start`, or just use the provided `Dockerfile`. Set nothing but `PORT` (respected
  automatically) and `NODE_ENV=production` (locks Socket.IO CORS to same-origin).
- **Any VPS**: `npm ci && npm run build && PORT=80 NODE_ENV=production node server/index.js`.
- Health check endpoint: `GET /healthz`.
- Not deployable to serverless/edge (Vercel functions etc.) — needs a persistent websocket process.

## Game rules (v2)

Classic Bank El Haz rules plus these mechanics added in the rewrite (auction, mortgage and
the Monopoly doubles rule were tried and then **removed by request** — declining a property
simply ends the turn, and liquidity comes from selling to the bank):

- **Color sets**: building requires the full color group, built/sold evenly (level diff ≤ 1). Full unimproved set doubles base rent. Utility (gas station) can't be built on.
- **Buildings**: garage 50% / rest stop 80% / market 120% of price; selling refunds 75% of cost.
- **Selling to the bank**: any unbuilt property sells back for 50% of its price.
- **Debt phase**: unpayable charges open a liquidation window (sell buildings / sell property to bank), then pay or declare bankruptcy. If net worth can't cover the debt, bankruptcy is automatic. Creditor players receive the bankrupt's assets; bank debts return properties to the bank.
- **Trade**: single-offer Monopoly flow — one player composes give/get (cash, unbuilt properties, jail-free cards), the target accepts or declines; 60s expiry; validated server-side at execution.
- **Prison**: miss 2 turns, or pay $50 bail, or use a jail-free card.
- **Timers**: 90s per decision, server-authoritative; timeout auto-resolves safely (auto-roll, auto-decline, first card choice, guest at club, pay-or-bankrupt).
- **Disconnects**: turn auto-resolves immediately; 60s grace to reconnect by rejoining with the same name; after grace the player is bankrupted to the bank.

## Engine architecture

`GameEngine` is a pure state machine — no I/O, timers, or sockets. Everything enters through
`dispatch(playerId, {type, ...})`, which validates against the current `phase` and returns
`{ok, error?, events[]}`. Events (`roll`, `paid`, `auction_won`, `debt`, …) drive client
animation/sound; the room broadcasts sanitized state + events after every action.

Phases: `awaiting_roll → buy_decision | auction | card → card_choice | club_choice | debt → … → game_over`.
Payments flow through `charge()`, which opens the `debt` phase when cash is short and
auto-bankrupts when net worth can't cover it. Card effects use continuation callbacks (`done`)
so a card can chain into rent, a choice, a second (dual-square) card, or a debt without losing
the turn-end.

RNG is injected (`new GameEngine({rng})`), so tests force exact dice and reproducible shuffles.
`autoResolve()` is the single timeout entry point used by the room timers.

## Testing

- `tests/engine.test.js` — movement, rent tiers, building rules, bank sales, debt/bankruptcy, prison, trade, disconnect removal.
- `tests/cards.test.js` — every Hazak and Mahkama card by id, incl. edge cases (empty pools, broke payers, dual-deck square, reshuffle).
- `tests/simulation.test.js` — seeded fuzz: full random games across seeds/player counts with invariants checked every step (money ≥ 0, ownership consistency, deck conservation, no deadlock, `autoResolve` always progresses).

Helpers in `tests/helpers.js`: `seededRng`, `diceRng(d1,d2)` (force dice), `forceRoll` (land on an exact square), `grant` (assign ownership).

## Known data quirks (see card audit in project discussion)

- Hazak 4 text says $250 salary; board pays $350 (`pass_go_salary`).
- Hazak 2 "free play" card is collected but has no in-game effect (cross-game concept).
- Mahkama 5's Arabic text contradicts itself; functions as go-to-jail.
- Club membership ($150) gives no benefit over guest ($20) — rational players always pick guest.
- Riyadh (6): market rent (600) < rest-stop rent (650); Luxor (28) rents unusually low — likely data typos.
- Gas station (16) note "pay bank when unowned" is not implemented; it behaves as a normal flat-rent property.
