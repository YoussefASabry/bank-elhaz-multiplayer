import { expect, test } from '@playwright/test';
import {
  autoTurn,
  clickRobust,
  dragMyPropIntoBasket,
  guestCorner,
  hostCorner,
  hostMoney,
  makeRoom,
  moneyNum,
  openTradeWithGuest,
  sellUpgradeInTrade,
  resolvePrompt,
  shot,
  startGame,
  teleport,
  waitGeometry,
  waitMyTurn,
} from './helpers';

/**
 * Full in-game tour, driven deterministically with the host debug teleport.
 * Screenshots: board, buy, club, upgrade, blind card, trade, rent, inspect,
 * inventory, player list, player popup, bid, prison.
 */
test('screenshot tour: buy → club → upgrade → trade → rent → modals → bid → prison', async ({
  context,
}) => {
  const { host, guest } = await makeRoom(context);
  await startGame(host, guest);

  for (const p of [host, guest]) {
    p.on('console', (msg) => console.log(`[page ${p === host ? 'host' : 'guest'}]`, msg.text()));
  }

  await shot(host, '10-board-overview', { fullPage: true });

  const money = async () => moneyNum(await hostMoney(host).innerText());
  let cash = await money();

  // ── 1. Buy القدس (square 2, $300) ───────────────────────────────────────
  expect(await teleport(host, '2')).toBe('buy');
  await waitGeometry(host, '#buy-modal.show');
  await shot(host, '11-buy-modal');
  await resolvePrompt(host, { autoBuy: true });
  let nextCash = await money();
  expect(nextCash).toBe(cash - 300);
  cash = nextCash;
  await expect(hostCorner(host).locator('.mini-card')).toHaveCount(1);

  await autoTurn(guest);

  // ── 2. Club corner (square 8) ──────────────────────────────────────────
  expect(await teleport(host, '8')).toBe('club');
  await waitGeometry(host, '#club-modal.show');
  await shot(host, '12-club-modal');
  await resolvePrompt(host, { clubMembership: true });
  nextCash = await money();
  expect(nextCash).toBe(cash - 150);
  cash = nextCash;
  await expect(hostCorner(host)).toContainText('Club');

  await autoTurn(guest);

  // ── 3. Buy غزة (square 3, $250) → complete the purple set ─────────────
  expect(await teleport(host, '3')).toBe('buy');
  await resolvePrompt(host, { autoBuy: true });
  nextCash = await money();
  expect(nextCash).toBe(cash - 250);
  cash = nextCash;

  await autoTurn(guest);

  // ── 4. Land on own full-set property → upgrade modal ──────────────────
  expect(await teleport(host, '2')).toBe('upgrade');
  await waitGeometry(host, '#upgrade-modal.show');
  await shot(host, '13-upgrade-modal');
  await resolvePrompt(host, { upgrade: true });
  await expect(hostCorner(host).locator('.mini-card').first()).toContainText('🏗️');

  await autoTurn(guest);

  // ── 5. Trade القدس to the guest via real drag & drop ──────────────────
  await openTradeWithGuest(host, guest);
  await sellUpgradeInTrade(host, '2', 'القدس');
  await dragMyPropIntoBasket(host, 'القدس');
  await clickRobust(host, '#trade-footer button[onclick*="sendTradeProposal"]');
  await expect(guest.locator('#trade-footer')).toContainText('Accept Proposal');
  await shot(guest, '07-trade-review');

  // The engine's stage machine needs BOTH baskets: b's accept at reviewing_b
  // only advances to proposing_b, so the guest counter-proposes $100, then
  // the host's accept at reviewing_a settles the trade.
  await clickRobust(guest, '#trade-footer button[onclick*="acceptTradeProposal"]');
  await expect(guest.locator('#trade-footer')).toContainText('Send Proposal');
  await guest.locator('#trade-cash-b[type=number]').fill('100');
  await shot(guest, '07b-counter-proposal');
  await clickRobust(guest, '#trade-footer button[onclick*="sendTradeProposal"]');
  await expect(host.locator('#trade-footer')).toContainText('Accept Proposal');
  await shot(host, '07c-host-review');
  await clickRobust(host, '#trade-footer button[onclick*="acceptTradeProposal"]');

  // Trade executes: modal closes on both sides, guest owns القدس.
  await expect(host.locator('#trade-modal')).not.toHaveClass(/show/);
  await expect(guest.locator('#trade-modal')).not.toHaveClass(/show/);
  await expect(guestCorner(guest).locator('.mini-card').first()).toBeVisible();
  await shot(host, '08-trade-executed');
  cash = await money();

  // ── 6. Land on guest-owned القدس → rent prompt ─────────────────────────
  expect(await teleport(host, '2')).toBe('rent');
  await waitGeometry(host, '#rent-actions');
  await shot(host, '14-rent-actions');
  await resolvePrompt(host, {});
  nextCash = await money();
  expect(nextCash).toBeLessThan(cash);
  cash = nextCash;

  await autoTurn(guest);

  // ── 7. Inspect a tile ──────────────────────────────────────────────────
  await waitMyTurn(host);
  await clickRobust(host, host.locator('.cell[data-id="2"]'));
  await expect(host.locator('#inspect-modal')).toHaveClass(/show/);
  await waitGeometry(host, '#inspect-modal.show');
  await shot(host, '15-inspect-modal');
  await clickRobust(host, '#inspect-modal .modal-close');
  await expect(host.locator('#inspect-modal')).not.toHaveClass(/show/);

  // ── 8. Inventory ("My Stuff") ──────────────────────────────────────────
  await host.locator('button[onclick*="openInventory"]').first().click();
  await expect(host.locator('#inventory-modal')).toHaveClass(/show/);
  await waitGeometry(host, '#inventory-modal.show');
  await shot(host, '16-inventory-modal');
  await clickRobust(host, '#inventory-modal .modal-close');

  // ── 9. Player list ─────────────────────────────────────────────────────
  await host.locator('#btn-players-float').click();
  await expect(host.locator('#player-list-modal')).toHaveClass(/show/);
  await waitGeometry(host, '#player-list-modal.show');
  await shot(host, '17-player-list-modal');
  await clickRobust(host, '#player-list-modal button[onclick*="closePlayerList"]');
  await expect(host.locator('#player-list-modal')).not.toHaveClass(/show/);

  // ── 10. Per-player action popup (click guest's corner) ─────────────────
  await clickRobust(host, guestCorner(host));
  await expect(host.locator('#player-action-popup')).toHaveClass(/show/);
  await waitGeometry(host, '#player-action-popup.show');
  await shot(host, '18-player-action-popup');
  await clickRobust(host, '#player-action-popup button[onclick="closePlayerActionPopup()"]');

  // ── 11. Bid modal ──────────────────────────────────────────────────────
  await waitMyTurn(host);
  await host.locator('#btn-bid').click();
  await expect(host.locator('#bid-create-modal')).toHaveClass(/show/);
  await waitGeometry(host, '#bid-create-modal.show');
  await shot(host, '19-bid-modal');
  await clickRobust(host, '#bid-create-modal button[onclick*="closeBidCreate"]');
  await expect(host.locator('#bid-create-modal')).not.toHaveClass(/show/);

  // ── 12. Prison (square 25) — keep last, it gates further turns ────────
  // Landing on 25 jails the host and immediately passes the turn; the jail
  // prompt (phase `roll` + missedTurnsRemaining > 0) only renders at the
  // start of the host's NEXT turn.
  expect(await teleport(host, '25')).toBe('plain');
  await autoTurn(guest);
  await waitGeometry(host, '#prison-actions.show');
  await shot(host, '20-prison-actions');
  await resolvePrompt(host, { prisonBail: true });
});