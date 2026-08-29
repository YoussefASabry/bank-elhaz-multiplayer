import { test, expect } from '@playwright/test';
import { makeRoom, startGame, waitMyTurn, clickRobust, waitGeometry, shot } from './helpers';

test('trade open probe (fresh room)', async ({ context }) => {
  const { host, guest } = await makeRoom(context);
  await startGame(host, guest);
  for (const p of [host, guest]) {
    p.on('console', (m) => console.log(`[probe ${p === host ? 'host' : 'guest'}]`, m.text()));
  }
  await waitMyTurn(host);
  await clickRobust(host, '#btn-trade');
  await expect(host.locator('#player-selector')).toHaveClass(/show/);
  await waitGeometry(host, '#player-selector.show');
  await clickRobust(host, '.ps-player');

  const watch = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const t: string[] = [];
      const step = async () => {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const tm = document.getElementById('trade-modal') as HTMLElement | null;
          const rq = document.getElementById('trade-request-modal') as HTMLElement | null;
          t.push(
            `t=${(i / 5).toFixed(1)} trade=${tm ? tm.className : 'missing'} rq=${rq ? rq.className : 'missing'}`,
          );
        }
        return t;
      };
      return step();
    });

  const hostPath = watch(host);
  const guestPath = watch(guest);
  await clickRobust(guest, '#trade-request-modal button[onclick*="acceptTradeRequest"]');
  const [gh, gg] = await Promise.all([hostPath, guestPath]);
  console.log('[probe][host-timeline]', JSON.stringify(gh));
  console.log('[probe][guest-timeline]', JSON.stringify(gg));
  await expect(host.locator('#trade-modal')).toHaveClass(/show/);
  await expect(guest.locator('#trade-modal')).toHaveClass(/show/);
  await shot(host, 'zz-probe-trade-open');
});
test('pageerror hunt in trade', async ({ context }) => {
  const { host, guest } = await makeRoom(context);
  await startGame(host, guest);
  const errs: string[] = [];
  for (const p of [host, guest]) p.on('pageerror', (e) => errs.push(`${p === host ? 'H' : 'G'}: ${e.message}`));
  await waitMyTurn(host);
  await clickRobust(host, '#btn-trade');
  await expect(host.locator('#player-selector')).toHaveClass(/show/);
  await waitGeometry(host, '#player-selector.show');
  await clickRobust(host, '.ps-player');
  await guest.waitForSelector('#trade-request-modal.show', { timeout: 8000 });
  await guest.waitForTimeout(300);
  await clickRobust(guest, '#trade-request-modal button[onclick*="acceptTradeRequest"]');
  await guest.waitForTimeout(2500);
  const snap = await guest.evaluate(() => {
    const tm = document.getElementById('trade-modal') as HTMLElement | null;
    return {
      cls: tm?.className,
      display: tm ? getComputedStyle(tm).display : null,
      rect: tm ? (() => { const r = tm.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      innerLen: tm?.innerHTML.length,
      status: document.getElementById('trade-status')?.textContent,
    };
  });
  console.log('[probe][guest-snapshot]', JSON.stringify(snap));
  console.log('[probe][pageerrors]', JSON.stringify(errs));
});
