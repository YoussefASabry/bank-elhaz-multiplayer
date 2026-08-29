# Bank El Haz (بنك الحظ) — Project CLAUDE.md

Arabic-language Monopoly-style multiplayer web game (Bank El Haz = "Luck Bank"). UI mostly Arabic/Egyptian dialect, RTL. Code map: HANDOFF.md (function-by-function with file:line anchors); older bug-table: docs/HANDOFF-refactor.md.

## Stack & run
- Legacy `server.js`/`roomManager.js`/`gameEngine.js` DELETED. Server = refactored TS engine, runs via `tsx src/server/main.ts` (npm run dev/server).
- The inline client in `index.html` speaks the legacy wire protocol and is NOT playable against the refactored engine; browser play requires the Phase 5 client rewrite (`src/client/*`).
- Tests: `npm test` (unit); `npm run test:soak` boots real server + full 4-client game (~70-100s); e2e via `npx playwright test tests/e2e/game.spec.ts` (helpers: tests/e2e/helpers.ts — teleport, autoTurn, resolvePrompt, openTrade...). webServer boots `npm run build && PORT=4399 npm run server`.
- Manual play: rebuild then http://localhost:4477 (leftover dev server serves current dist/).

## Known constraints / gotchas
- Board renders from engine's normalized `Board` type (`kind`, `colorGroup`, `purchasePrice`, `buildCost`, `visitorRent`); raw snake_case fields exist only in the loader (`src/engine/board.ts`).
- Client is NOT responsive: no @media/scale handling, fixed ~1012px board grid (index.html:3187), viewport user-scalable=no (index.html:5). Mobile/tablet tests deferred by owner pending a responsive pass.
- `assets/pfps/` contains only `.svg` avatars but client references `assets/pfps/${avatar}.png` — avatars render broken in a real browser (jsdom won't catch it).
- Engine phase `rolling` (dice rolled, awaiting CONFIRM_LANDING) has `pending: none`; landing-confirmation decision is phase-encoded, not pending-encoded.
- Legacy inline client `updateUI` must never auto-close `trade-modal` (trade lifecycle: `trade_executed`/`trade_cancelled`/65s timer); re-render the open panel when `tradeState.active`.
- Trade wire facts: `trade_opened` sends `{ tradeId, state:'proposing_a', initiatorId: <seatId>, initiator:{id,name,avatar,money}, partner:{...}, proposalA:null, proposalB:null }`; `trade_request` takes `targetId`; `accept_trade_request` takes `initiatorId`.

## Relevant skills
Use: superpowers-test-driven-development, superpowers-systematic-debugging, superpowers-verification-before-completion, superpowers-writing-plans; anthropics-frontend-design + vercel-* for the Phase 5 client rewrite; impeccable for design polish; anthropics-webapp-testing for browser flows. Skip SEO/marketing skills here.

## Memory
Durable facts/decisions in memory/ — keep terse; update after significant work. HANDOFF.md stays canonical for code structure.