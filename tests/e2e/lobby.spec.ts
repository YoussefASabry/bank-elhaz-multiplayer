import { expect, test } from '@playwright/test';
import { dismissDialogs, makeRoom, shot, startGame } from './helpers';

/**
 * Lobby + waiting room screenshot tour. Run: `npx playwright test tests/e2e/lobby.spec.ts`
 * Screenshots land in `screenshots/`.
 */
test('every pre-game screen: lobby host, lobby join, waiting room, game start', async ({
  context,
}) => {
  // Gallery page for the two lobby tabs.
  const page = await context.newPage();
  dismissDialogs(page);
  await page.goto('./');

  // -- 01 lobby, host tab --
  await page.locator('#host-name').fill('Host');
  await page.locator('#pfp-grid-host .avatar, #pfp-grid-host img').first().click();
  await shot(page, '01-lobby-host-tab');

  // -- 02 lobby, join tab --
  await page.locator('#tab-join').click();
  await shot(page, '02-lobby-join-tab');

  // -- 03/04 waiting room --
  const { host, guest } = await makeRoom(context);
  await shot(host, '03-waiting-room-host', { fullPage: true });
  expect(host.locator('#room-code-display')).not.toHaveText('');
  await shot(guest, '03b-waiting-room-guest');

  await startGame(host, guest);
  await shot(host, '04-game-loaded-host', { fullPage: true });
});