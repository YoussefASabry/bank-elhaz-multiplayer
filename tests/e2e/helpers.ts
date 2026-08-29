import { mkdirSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

mkdirSync('screenshots', { recursive: true });

/** Save a labelled screenshot into the repo `screenshots/` folder. */
export async function shot(
  page: Page,
  name: string,
  opts: { fullPage?: boolean } = {},
): Promise<void> {
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage: opts.fullPage ?? false });
}

/** Native confirm()/alert() dialogs are auto-dismissed. */
export function dismissDialogs(page: Page): void {
  page.on('dialog', (d) => void d.dismiss().catch(() => {}));
}

export interface RoomPair {
  host: Page;
  guest: Page;
  code: string;
  hostName: string;
  guestName: string;
}

/** Host a room, join it with a second tab, and land in the waiting room. */
export async function makeRoom(context: BrowserContext, names?: {
  host?: string;
  guest?: string;
}): Promise<RoomPair> {
  const hostName = names?.host ?? 'Host';
  const guestName = names?.guest ?? 'Guest';

  const host = await context.newPage();
  dismissDialogs(host);
  await host.goto('./');
  await host.locator('#host-name').fill(hostName);
  await host.locator('#btn-host').click();
  await expect(host.locator('#room-waiting')).toBeVisible({ timeout: 20_000 });
  const code = (await host.locator('#room-code-display').innerText()).trim();

  const guest = await context.newPage();
  dismissDialogs(guest);
  await guest.goto('./');
  await guest.locator('#tab-join').click();
  await guest.locator('#join-name').fill(guestName);
  await guest.locator('#join-code').fill(code);
  await guest.locator('#btn-join').click();
  await expect(guest.locator('#room-waiting')).toBeVisible({ timeout: 20_000 });
  await expect(host.locator('#room-waiting')).toBeVisible({ timeout: 20_000 });

  // Host roster must show both players before starting is allowed.
  await expect(host.locator('#lobby-player-list .lp-item')).toHaveCount(2, { timeout: 20_000 });
  return { host, guest, code, hostName, guestName };
}

/** Start the game from the waiting room on both tabs. */
export async function startGame(host: Page, guest: Page): Promise<void> {
  const btn = host.locator('#btn-start-game');
  await expect(btn).toBeEnabled({ timeout: 20_000 });
  await btn.click();
  await expect(host.locator('#game-container')).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator('#game-container')).toBeVisible({ timeout: 20_000 });
  await expect(host.locator('#board .cell')).toHaveCount(34, { timeout: 20_000 });
}

/** Host seat (players[0]) UI helpers. */
export const hostMoney = (host: Page) =>
  host.locator('#player-corners .player-corner').first().locator('.pc-money');
export const guestMoney = (guest: Page) =>
  guest.locator('#player-corners .player-corner').nth(1).locator('.pc-money');
export const hostCorner = (host: Page) =>
  host.locator('#player-corners .player-corner').first();
export const guestCorner = (page: Page) =>
  page.locator('#player-corners .player-corner').nth(1);

export function moneyNum(text: string): number {
  const m = text.match(/-?\d+/);
  return m ? Number(m[0]) : 0;
}

/** Wait until it is this page's player's turn (roll enabled). */
export async function waitMyTurn(page: Page): Promise<void> {
  try {
    await expect(page.locator('#btn-roll')).toBeEnabled({ timeout: 30_000 });
  } catch (e) {
    const dump = await page.evaluate(() => ({
      banner: document.getElementById('turn-banner')?.textContent ?? null,
      rollText: (document.getElementById('btn-roll') as HTMLButtonElement | null)?.textContent ?? null,
      shown: Array.from(document.querySelectorAll('.modal-overlay.show, .modal-overlay-transparent.show, .cell, .deck-pile.glow-dual, .deck-pile.glow-mahkama, .deck-pile.glow-hazak')).map((o) => (o as HTMLElement).className),
      rent: document.getElementById('rent-actions') ? getComputedStyle(document.getElementById('rent-actions')!).display : null,
      prison: document.getElementById('prison-actions')?.className ?? null,
    }));
    console.log('[waitMyTurn][stuck]', JSON.stringify(dump));
    throw e;
  }
}

export type PromptKind = 'buy' | 'club' | 'deck' | 'rent' | 'upgrade' | 'prison' | 'plain';

/**
 * Wait until a locator's element is genuinely on-screen (nonzero box and not
 * `display:none`/`visibility:hidden`), then return it. This keeps Playwright
 * from spinning on nodes that are mid re-render.
 */
export async function waitVisible<T extends Page>(
  page: T,
  locator: ReturnType<Page['locator']>,
): Promise<ReturnType<Page['locator']>> {
  await expect
    .poll(() => locator.evaluate((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }))
    .toBe(true)
    .catch(async () => {
      const state = await page.evaluate(() => {
        const el = (id: string) => document.getElementById(id);
        const g = (id: string) => {
          const e = el(id) as HTMLElement | null;
          if (!e) return null;
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return { cls: e.className, display: cs.display, vis: cs.visibility, w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
          banner: el('turn-banner')?.textContent,
          roll: g('btn-roll'),
          clubModal: g('club-modal'),
          clubBox: g('club-modal .modal-box') ?? null,
          memb: g('club-btn-membership'),
          guestBtn: g('club-btn-guest'),
          buy: g('buy-modal'),
          inspect: g('inspect-modal'),
          rent: g('rent-actions'),
          prison: g('prison-actions'),
glows: Array.from(document.querySelectorAll('.deck-pile')).map((p) => p.className),
        };
      });
      throw new Error(
        `Element stayed invisible. DOM=${JSON.stringify(state)}`,
      );
    });
  return locator;
}

/** Block until the landing prompt is present (prompt stays OPEN for screenshotting). */
export async function awaitLanding(page: Page): Promise<PromptKind> {
  // The whole turn can resolve (plain landing, turn advances) during the
  // token-travel pause below, so seed the "saw my turn" flag from the banner
  // state at entry rather than only from within the poll loop.
  await page.evaluate(() => {
    const w = window as unknown as { __bankWasMineTurn?: boolean };
    w.__bankWasMineTurn = (document.getElementById('turn-banner')?.textContent ?? '').includes('Your Turn');
  });
  await page.waitForTimeout(700); // token travel
  try {
    await page.waitForFunction(() => {
      const el = (id: string) => document.getElementById(id);
      const has = (id: string) => el(id)?.classList.contains('show');
      if (has('buy-modal') || has('club-modal') || has('upgrade-modal') || has('inspect-modal')) return true;
      if (document.querySelector('.deck-pile.glow-dual, .deck-pile.glow-mahkama, .deck-pile.glow-hazak')) return true;
      if (el('rent-actions') && getComputedStyle(el('rent-actions')!).display !== 'none') return true;
      if (el('prison-actions') && el('prison-actions')!.classList.contains('show')) return true;
      const banner = el('turn-banner')?.textContent ?? '';
      const isMine = banner.includes('Your Turn');
      const w = window as unknown as { __bankWasMineTurn?: boolean };
      if (isMine) w.__bankWasMineTurn = true;
      // Resolved when it is no longer my turn AND my roll button is disabled
      // ("⏳ Wait...") — this is also what makes a redundant second
      // awaitLanding (after rollOpen already consumed the landing) return
      // immediately instead of hanging on the already-flipped banner.
      const roll = el('btn-roll') as HTMLButtonElement | null;
      if (!isMine && (w.__bankWasMineTurn || roll === null || roll.disabled)) return true;
      return false;
    });
  } catch (e) {
    const dump = await page.evaluate(() => {
      const el = (id: string) => document.getElementById(id);
      const info = (id: string) => {
        const e = el(id);
        if (!e) return null;
        return { cls: e.className, display: getComputedStyle(e).display };
      };
      return {
        turnBanner: el('turn-banner')?.textContent,
        roll: info('btn-roll'),
        buy: info('buy-modal'),
        club: info('club-modal'),
        upgrade: info('upgrade-modal'),
        inspect: info('inspect-modal'),
        rent: info('rent-actions'),
        prison: info('prison-actions'),
        glow: Array.from(document.querySelectorAll('.deck-pile')).map((p) => p.className),
      };
    });
    console.log('[awaitLanding][timed-out]', JSON.stringify(dump));
    throw e;
  }
  await page.waitForTimeout(300); // let a just-opened modal settle
  if (await page.locator('.deck-pile.glow-dual, .deck-pile.glow-mahkama, .deck-pile.glow-hazak').count()) return 'deck';
  if ((await page.locator('#club-modal.show').count()) > 0) return 'club';
  if (await page.locator('#rent-actions').evaluate((e) => getComputedStyle(e).display !== 'none')) return 'rent';
  if ((await page.locator('#upgrade-modal.show').count()) > 0) return 'upgrade';
  if ((await page.locator('#buy-modal.show').count()) > 0) return 'buy';
  if ((await page.locator('#prison-actions.show').count()) > 0) return 'prison';
  return 'plain';
}

/** Resolve whatever prompt is currently open on the page. */
export async function resolvePrompt(
  page: Page,
  opts: {
    autoBuy?: boolean;
    clubMembership?: boolean;
    upgrade?: boolean;
    prisonBail?: boolean;
  } = {},
): Promise<PromptKind> {
  let kind = await awaitLanding(page);
  switch (kind) {
    case 'buy':
      if (opts.autoBuy) await clickRobust(page, '.modal-overlay.show #buy-modal, #buy-modal.show button[onclick*="buyProperty"]');
      else await clickRobust(page, '#buy-modal button[onclick*="declineProperty"]');
      break;
    case 'club':
      await clickRobust(page, opts.clubMembership ? '#club-btn-membership' : '#club-btn-guest');
      break;
    case 'deck':
      await resolveDeck(page);
      break;
    case 'rent':
      await clickRobust(page, '#btn-pay-rent');
      break;
    case 'upgrade':
      if (opts.upgrade) await clickRobust(page, '#upgrade-options button');
      else await clickRobust(page, 'button[onclick*="skipUpgrade"]');
      break;
    case 'prison':
      if (opts.prisonBail) await clickRobust(page, '#prison-actions button[onclick*="payBail"]');
      else await clickPrisonSkip(page);
      break;
    default:
      break;
  }
  await page.waitForTimeout(600);
  return kind;
}

async function clickPrisonSkip(page: Page): Promise<void> {
  const none = page.locator('#prison-actions button').filter({ hasText: /Skip|serve|سجن|قضاء/i }).first();
  if (await none.count()) await none.click();
  else await page.locator('#prison-actions button').last().click();
}

/**
 * Click an in-game action. Prefers a real trusted click; if the target is
 * stuck in a zero-geometry re-render state, falls back to a programmatic
 * `.click()` on the element (which always fires its onclick handler).
 */
export async function clickRobust(
  page: Page,
  target: string | ReturnType<Page['locator']>,
): Promise<void> {
  const loc = typeof target === 'string' ? page.locator(target) : target;
  try {
    await loc.first().click({ timeout: 1_200 });
    return;
  } catch {
    // no-op: fall through to JS click
  }
  // The client has a known render bug where `.show` overlays can measure
  // 0x0 (CSS transition / re-render race), which makes trusted clicks wait
  // forever on hit-testing. Fire the handler directly instead so a fresh
  // modal doesn't go stale inside a trade handshake window.
  await loc.first().evaluate((el) => (el as HTMLElement).click()).catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Wait until an element has non-zero geometry (i.e. fully laid out, not
 * caught in a mid-render 0×0 state). Returns false if it never materialises.
 */
export async function waitGeometry(page: Page, selector: string, ms = 7000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((sel) => {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, selector);
    if (ok) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

export async function resolveDeck(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const piledir = '.deck-pile.glow-dual, .deck-pile.glow-mahkama, .deck-pile.glow-hazak';
    const glow = page.locator(piledir).first();
    if ((await glow.count()) === 0) break;
    await waitVisible(page, glow).catch(() => {});
    await glow.click();
    const blind = page.locator('#blind-card-modal.show');
    try {
      await blind.waitFor({ state: 'visible', timeout: 12_000 });
    } catch {
      console.log('[resolveDeck] no blind modal after click', await page.evaluate(() => ({
        banner: document.getElementById('turn-banner')?.textContent,
        glows: Array.from(document.querySelectorAll('.deck-pile')).map((p) => p.className),
        shown: Array.from(document.querySelectorAll('.modal-overlay.show, .modal-overlay-transparent.show')).map((o) => o.id),
      })));
      return;
    }
    await shot(page, '04-blind-card-modal');
    await clickRobust(page, '#btn-confirm-card');
    const choice = page.locator('#card-modal.show');
    if ((await choice.count()) > 0) {
      await clickRobust(page, '#card-modal.show button');
    }
  }
}

/**
 * Host-only deterministic teleport: moves the CURRENT player to `squareId`,
 * waits for the landing prompt (leaves it OPEN), and reports its kind.
 */
export async function teleport(page: Page, squareId: string): Promise<PromptKind> {
  await waitMyTurn(page);
  const sel = page.locator('#debug-tile-select');
  await expect(sel).toBeVisible({ timeout: 20_000 });
  await sel.selectOption(squareId).catch(() => {});
  const optionText = await sel.locator(`option[value="${squareId}"]`).textContent().catch(() => null);
  expect(optionText, `board square ${squareId} must be selectable`).toBeTruthy();
  await page.getByRole('button', { name: /Go/ }).click();
  return awaitLanding(page);
}

/** Roll + wait for landing prompt (left open) for the page whose turn it is. */
export async function rollOpen(page: Page): Promise<PromptKind> {
  await waitMyTurn(page);
  await page.locator('#btn-roll').click();
  return awaitLanding(page);
}

/** Roll + auto-resolve a whole turn. */
export async function autoTurn(page: Page): Promise<PromptKind> {
  const kind = await rollOpen(page);
  return resolvePrompt(page, {});
}

/** Open the trade modal between host and guest, leaving it open on both sides. */
export async function openTradeWithGuest(host: Page, guest: Page): Promise<void> {
  await waitMyTurn(host);
  await clickRobust(host, '#btn-trade');
  await expect(host.locator('#player-selector')).toHaveClass(/show/);
  await waitGeometry(host, '#player-selector.show');
  await shot(host, '05-trade-selector');
  await clickRobust(host, '.ps-player');
  await expect(guest.locator('#trade-request-modal')).toHaveClass(/show/);
  await waitGeometry(guest, '#trade-request-modal.show');
  await shot(guest, '05b-trade-request');
  await clickRobust(guest, '#trade-request-modal button[onclick*="acceptTradeRequest"]');
  await expect(guest.locator('#trade-modal')).toHaveClass(/show/, { timeout: 10_000 });
  await expect(host.locator('#trade-modal')).toHaveClass(/show/);
  await waitGeometry(host, '#trade-modal.show');
  await shot(host, '06-trade-panel');
}

/**
 * Sell one of MY built properties (by square id) inside the open trade panel,
 * so it becomes a draggable tradable prop. Confirms the sell modal.
 */
export async function sellUpgradeInTrade(page: Page, squareId: string, propName: string): Promise<void> {
  const sellBtn = page.locator(`.trade-panel.mine button[onclick^="showSellBuilding(${squareId})"]`);
  await expect(sellBtn).toBeEnabled();
  await clickRobust(page, sellBtn);
  await expect(page.locator('#sell-bldg-modal')).toHaveClass(/show/);
  await waitGeometry(page, '#sell-bldg-modal.show');
  await shot(page, '06b-sell-building-modal');
  await clickRobust(page, '#sell-bldg-modal button[onclick*="confirmSellBuilding"]');
  await expect(page.locator('#sell-bldg-modal')).not.toHaveClass(/show/, { timeout: 10_000 });
  const card = page
    .locator('.trade-panel.mine [draggable="true"].mini-prop-card')
    .filter({ hasText: propName })
    .first();
  await expect(card).toBeAttached({ timeout: 10_000 });
}

/**
 * Drag one of MY tradable property cards (by Arabic name) into my dropzone.
 * Cards are `.mini-prop-card[draggable="true"]` inside the `.trade-panel.mine`.
 */
export async function dragMyPropIntoBasket(page: Page, propName: string): Promise<void> {
  const card = page
    .locator('.trade-panel.mine [draggable="true"].mini-prop-card')
    .filter({ hasText: propName })
    .first();
  try {
    await expect(card).toBeAttached();
  } catch (e) {
    const dump = await page.evaluate(() => ({
      draggable: Array.from(document.querySelectorAll('.trade-panel.mine [draggable="true"].mini-prop-card')).map((c) => (c as HTMLElement).innerText),
      tradables: Array.from(document.querySelectorAll('.trade-panel.mine .mini-prop-card')).map((c) => (c as HTMLElement).innerText),
      panel: document.getElementById('trade-panels')?.innerHTML.slice(0, 400) ?? null,
    }));
    console.log('[drag][missing-card]', JSON.stringify(dump).slice(0, 2000));
    throw e;
  }
  const target = page.locator('#dropzone-a');
  await expect(target).toBeVisible();
  await card.dragTo(target);
  await expect(target.locator('.trade-card, .mini-prop-card').first()).toBeVisible();
}