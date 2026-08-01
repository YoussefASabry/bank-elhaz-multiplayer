/**
 * Client smoke test: boots the REAL socket.io server and drives the REAL
 * `src/client/*` modules (the `main.ts` bootstrap) inside jsdom against it,
 * while three raw socket bots play the other seats through the same wire
 * protocol the soak uses.
 *
 * This exercises the layer the soak cannot: the actual browser client —
 * lobby UI, store transitions, dialog sync, board/token rendering, dice,
 * narrate toasts, the roll/landing button, prison actions, and the deck-card
 * auto-draw path — and fails loudly if any of it throws at runtime.
 *
 * The client-under-test is driven through its own DOM (real `.click()` on the
 * buttons the client renders), so click-delegation wiring is covered too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { createApp, type BankElhazApp } from '../../src/server/main.js';
import type { Action } from '../../src/shared/actions.js';
import type { ClientState } from '../../src/shared/events.js';
import type { Choice, SeatId, SquareId } from '../../src/shared/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: BankElhazApp;
let port: number;
const openSockets: ClientSocket[] = [];

beforeAll(async () => {
  app = createApp(mkdtempSync(join(tmpdir(), 'bankelhaz-client-')));
  port = await app.start(0, '127.0.0.1');
});

afterAll(async () => {
  for (const s of openSockets) {
    if (s.connected) s.disconnect();
  }
  await app.close();
});

function connect(): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    openSockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

function emitAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 5000);
    socket.emit(event, payload, (r: T) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function clickSel(sel: string): boolean {
  const node = document.querySelector<HTMLElement>(sel);
  if (!node) return false;
  node.click();
  return true;
}

/** Install the jsdom globals the client modules rely on. */
function installJsdom(url: string): void {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, unknown>;
  const keys = [
    'window',
    'document',
    'location',
    'history',
    'localStorage',
    'sessionStorage',
    'Element',
    'Node',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLImageElement',
    'HTMLDivElement',
    'HTMLSpanElement',
    'HTMLParagraphElement',
    'HTMLAnchorElement',
    'Image',
    'FileReader',
    'Event',
    'MouseEvent',
    'CustomEvent',
    'KeyboardEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'Blob',
    'URL',
    'matchMedia',
    'MutationObserver',
    'XMLHttpRequest',
  ];
  for (const k of keys) {
    const v = w[k];
    if (v === undefined) continue;
    try {
      (globalThis as Record<string, unknown>)[k] = v;
    } catch {
      Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
  }
  try {
    (globalThis as Record<string, unknown>)['window'] = w['window'];
    (globalThis as Record<string, unknown>)['document'] = w['document'];
    (globalThis as Record<string, unknown>)['location'] = w['location'];
  } catch {
    /* covered by the loop above */
  }
}

// ── Bot policy for the three raw-socket seats (mirrors the soak) ──

function prisonBail(state: ClientState): number {
  for (const sq of state.board.squares) {
    if (sq.kind === 'corner' && sq.effect === 'prison') return sq.bailCost;
  }
  return 0;
}

function pickCardOption(pending: Extract<ClientState['pending'], { kind: 'card_choice' }>): number {
  const flat: Array<{ choice: Choice; squareId?: SquareId }> = [];
  for (const choice of pending.options) {
    if (choice.type === 'claim_free_property' || choice.type === 'move_to_dynamic_pool') {
      for (const squareId of pending.propertyPool) flat.push({ choice, squareId });
    } else {
      flat.push({ choice });
    }
  }
  const preferred: Choice['type'][] = [
    'claim_free_property',
    'move_to_dynamic_pool',
    'receive_cash',
    'pay_fine',
    'go_to_prison',
  ];
  for (const type of preferred) {
    const idx = flat.findIndex((f) => f.choice.type === type);
    if (idx >= 0) return idx;
  }
  return 0;
}

function botDecision(state: ClientState, me: SeatId): Action | null {
  if (state.gameOver) return null;
  const mePlayer = state.players.find((pl) => pl.id === me);
  if (mePlayer === undefined || mePlayer.isBankrupt || mePlayer.eliminated) return null;
  if (state.players[state.currentPlayerIndex]?.id !== me) return null;

  switch (state.phase) {
    case 'roll':
      if (mePlayer.statusEffects.missedTurnsRemaining > 0) {
        if (mePlayer.inventory.jailFreeCards > 0) return { type: 'USE_JAIL_FREE', actorId: me };
        if (mePlayer.money !== null && mePlayer.money >= prisonBail(state) + 100) {
          return { type: 'PAY_BAIL', actorId: me };
        }
        return { type: 'SKIP_PRISON_TURN', actorId: me };
      }
      return { type: 'ROLL_DICE', actorId: me };
    case 'rolling':
      return { type: 'CONFIRM_LANDING', actorId: me };
    case 'draw_card': {
      const pending = state.pending;
      if (pending.kind !== 'deck_draw' || pending.playerId !== me) return null;
      const deck = pending.queue[0];
      if (deck === undefined) return null;
      return { type: 'DRAW_CARD', actorId: me, deck };
    }
    case 'blind_card': {
      if (state.pending.kind !== 'blind_card' || state.pending.playerId !== me) return null;
      return { type: 'CONFIRM_CARD', actorId: me };
    }
    case 'card_choice': {
      if (state.pending.kind !== 'card_choice' || state.pending.playerId !== me) return null;
      return { type: 'CHOOSE_CARD_OPTION', actorId: me, index: pickCardOption(state.pending) };
    }
    case 'club_choice': {
      const pending = state.pending;
      if (pending.kind !== 'club' || pending.playerId !== me) return null;
      if (mePlayer.money !== null && mePlayer.money >= pending.membershipCost + 100) {
        return { type: 'CHOOSE_CLUB', actorId: me, choice: 'membership' };
      }
      return { type: 'CHOOSE_CLUB', actorId: me, choice: 'guest' };
    }
    case 'property_choice': {
      const pending = state.pending;
      if (pending.kind !== 'property_buy' || pending.playerId !== me) return null;
      return { type: 'RESOLVE_PROPERTY_BUY', actorId: me, buy: true };
    }
    case 'upgrade_choice': {
      const pending = state.pending;
      if (pending.kind !== 'upgrade' || pending.playerId !== me) return null;
      const opt = pending.options[0];
      if (opt === undefined) return { type: 'SKIP_UPGRADE', actorId: me };
      if (mePlayer.money !== null && mePlayer.money >= opt.cost) {
        return { type: 'BUY_UPGRADE', actorId: me, squareId: pending.squareId, tier: opt.tier };
      }
      return { type: 'SKIP_UPGRADE', actorId: me };
    }
    case 'rent_payment': {
      if (state.pending.kind !== 'rent' || state.pending.playerId !== me) return null;
      return { type: 'PAY_RENT', actorId: me };
    }
    case 'game_over':
      return null;
    default: {
      const never: never = state.phase;
      void never;
      return null;
    }
  }
}

// ── Client-under-test driver: click real DOM buttons ──

function myMoney(): number | null {
  const corner = document.querySelector<HTMLElement>('.player-corner.current-turn');
  if (!corner) return null;
  const money = corner.querySelector<HTMLElement>('.pc-money');
  if (!money) return null;
  const n = Number((money.textContent ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseUpgradeCost(text: string): number {
  const m = text.match(/\$\s*([\d,]+)/);
  if (!m || !m[1]) return 0;
  return Number(m[1].replace(/,/g, ''));
}

/** Click the decision the client is currently asking for; true if something clicked. */
function clickClientDecision(): boolean {
  const prison = byId('rc-prison-actions');
  if (prison && prison.style.display !== 'none') {
    const free = prison.querySelector<HTMLButtonElement>('[data-prison="free"]');
    if (free && free.style.display !== 'none') {
      free.click();
      return true;
    }
    const bail = prison.querySelector<HTMLButtonElement>('[data-prison="bail"]');
    if (bail && !bail.disabled) {
      bail.click();
      return true;
    }
    const skip = prison.querySelector<HTMLButtonElement>('[data-prison="skip"]');
    if (skip) {
      skip.click();
      return true;
    }
  }

  const modal = document.querySelector<HTMLElement>('#modals-root .modal-overlay.show');
  if (modal) {
    const id = modal.id;
    if (id === 'winner-modal') {
      if (byId('btn-close-winner')) {
        clickSel('#btn-close-winner');
        return true;
      }
    } else if (id === 'property_buy-modal') {
      if (byId<HTMLButtonElement>('btn-buy-prop')) {
        clickSel('#btn-buy-prop');
        return true;
      }
    } else if (id === 'upgrade-modal') {
      const first = document.querySelector<HTMLButtonElement>('#upgrade-options .btn-buy');
      if (first) {
        const cost = parseUpgradeCost(first.textContent ?? '');
        const money = myMoney();
        if (cost > 0 && (money === null || money < cost)) {
          if (byId<HTMLButtonElement>('btn-skip-upgrade')) {
            clickSel('#btn-skip-upgrade');
            return true;
          }
        }
        first.click();
        return true;
      }
      if (byId<HTMLButtonElement>('btn-skip-upgrade')) {
        clickSel('#btn-skip-upgrade');
        return true;
      }
    } else if (id === 'club-modal') {
      const member = byId<HTMLButtonElement>('btn-club-membership');
      if (member && !member.disabled) {
        member.click();
        return true;
      }
      if (byId<HTMLButtonElement>('btn-club-guest')) {
        clickSel('#btn-club-guest');
        return true;
      }
    } else if (id === 'rent-modal') {
      const pay = byId<HTMLButtonElement>('btn-pay-rent');
      if (pay && !pay.disabled) {
        pay.click();
        return true;
      }
      if (byId<HTMLButtonElement>('btn-declare-bankrupt')) {
        clickSel('#btn-declare-bankrupt');
        return true;
      }
    } else if (id === 'blind_card-modal') {
      if (byId<HTMLButtonElement>('btn-confirm-card')) {
        clickSel('#btn-confirm-card');
        return true;
      }
    } else if (id === 'card_choice-modal') {
      const opt = document.querySelector<HTMLButtonElement>('#card-choice-body .btn-buy');
      if (opt) {
        opt.click();
        return true;
      }
    }
    return false;
  }

  const roll = document.querySelector<HTMLButtonElement>('.roll-dice-btn');
  if (roll && !roll.disabled) {
    roll.click();
    return true;
  }
  return false;
}

describe('client smoke: real client modules against the real server', () => {
  it('hosts, joins 3 bots, and plays a real game through the client DOM', async () => {
    installJsdom(`http://127.0.0.1:${port}/`);

    const errors: string[] = [];
    const onUncaught = (err: Error): void => {
      errors.push(err && err.stack ? err.stack : String(err));
    };
    const onRejection = (reason: unknown): void => {
      errors.push(`unhandled rejection: ${String(reason)}`);
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);

    try {
      // Boot the real client (import side effects install handlers + connect).
      await import('../../src/client/main');

      // The socket-status bar hides once the client's socket connects.
      await waitFor(
        () => {
          const status = byId('socket-status');
          return status !== null && status.style.display === 'none';
        },
        8000,
        'client socket connected',
      );

      // ── Host through the real lobby UI ──
      const nameInput = byId<HTMLInputElement>('host-name');
      expect(nameInput).not.toBeNull();
      nameInput!.value = 'ClientHost';
      clickSel('#btn-host');
      await waitFor(() => byId('room-code-display') !== null, 8000, 'room created');
      const roomCode = byId('room-code-display')!.textContent!.trim();
      expect(roomCode.length).toBeGreaterThan(0);

      // ── Three bots join via the real wire protocol ──
      const seatIds: SeatId[] = [];
      const botSockets: ClientSocket[] = [];
      for (let i = 0; i < 3; i++) {
        const s = await connect();
        botSockets.push(s);
        const ack = await emitAck<{ ok: boolean; you?: SeatId; error?: string }>(s, 'join_game', {
          roomCode,
          playerName: `Bot${i}`,
          avatar: i + 2,
        });
        expect(ack.ok).toBe(true);
        seatIds.push(ack.you as SeatId);
      }

      // ── Host starts through the real lobby UI ──
      await waitFor(
        () => {
          const btn = byId<HTMLButtonElement>('btn-start-game');
          return btn !== null && !btn.disabled;
        },
        8000,
        'start button enabled',
      );
      clickSel('#btn-start-game');

      // ── Game screen rendered: lobby hidden, board cells built ──
      try {
        await waitFor(
          () => {
            const g = byId('game-container');
            return g !== null && g.style.display === 'block' && document.querySelectorAll('.cell').length > 0;
          },
          8000,
          'game screen rendered',
        );
      } catch (e) {
        const extra = errors.length > 0 ? `\nclient errors:\n${errors.join('\n')}` : '';
        throw new Error(`${e instanceof Error ? e.message : String(e)}${extra}`);
      }
      expect(document.querySelectorAll('.cell').length).toBeGreaterThan(20);

      // ── Bot seats respond immediately on their turn ──
      const lastResponded = new Map<SeatId, number>();
      for (let i = 0; i < 3; i++) {
        const seat = seatIds[i] as SeatId;
        lastResponded.set(seat, -1);
        const s = botSockets[i] as ClientSocket;
        s.on('state', (p: { state: ClientState }) => {
          const state = p.state;
          if (state.stateVersion <= (lastResponded.get(seat) ?? -1)) return;
          lastResponded.set(seat, state.stateVersion);
          const action = botDecision(state, seat);
          if (action) s.emit('action', { roomCode, action });
        });
      }

      // ── Drive the client's own decisions through its real DOM ──
      let turns = 0;
      let lastTurnCorner = '';
      const turnIv = setInterval(() => {
        const cur = document.querySelector<HTMLElement>('.player-corner.current-turn');
        const id = cur ? cur.id : '';
        if (id !== '' && id !== lastTurnCorner) {
          if (lastTurnCorner !== '') turns += 1;
          lastTurnCorner = id;
        }
      }, 50);

      const gameOver = () => byId('winner-modal')?.classList.contains('show') ?? false;
      const deadline = Date.now() + 120000;
      let lastClick = 0;
      while (Date.now() < deadline && turns < 30 && !gameOver()) {
        if (errors.length > 0) throw new Error(`client runtime error:\n${errors[0]}`);
        if (Date.now() - lastClick >= 150) {
          const clicked = clickClientDecision();
          if (clicked) lastClick = Date.now();
        }
        await sleep(60);
      }
      clearInterval(turnIv);

      if (errors.length > 0) throw new Error(`client runtime error:\n${errors[0]}`);
      if (!gameOver()) {
        expect(turns).toBeGreaterThanOrEqual(15);
      }

      // ── The board kept rendering: tokens exist, dice faces set, money shown ──
      expect(document.querySelectorAll('.token').length).toBeGreaterThan(0);
      const dice1 = byId('rc-die1');
      expect(dice1).not.toBeNull();
      const playerCorner = document.querySelector<HTMLElement>('.player-corner');
      expect(playerCorner).not.toBeNull();
      expect(byId('game-container')?.style.display).toBe('block');

      console.log(`\n==== client smoke summary ====`);
      console.log(`turns observed: ${turns} | game over: ${gameOver()}`);
      console.log(`tokens: ${document.querySelectorAll('.token').length} | cells: ${document.querySelectorAll('.cell').length}`);
      console.log(`==============================`);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    }
  }, 150000);
});
