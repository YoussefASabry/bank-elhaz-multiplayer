/**
 * Board theming and avatar pickers.
 *
 * Themes are discovered at build time from `assets/themes/<name>/center-bg.png`
 * via Vite's `import.meta.glob`, so dropping a folder in adds a theme with no
 * code change. `import.meta.glob` is a Vite transform rather than a standard, so
 * its shape is declared locally instead of pulling `vite/client` into the
 * project's tsconfig (which is shared with the server rewrite in flight).
 */

import type { SquareId } from '../shared/types.js';
import { byId, qsa } from './dom.js';
import { S } from './state.js';

interface ImportMetaGlob {
  glob: (pattern: string, opts?: { eager?: boolean }) => Record<string, unknown>;
}

/** Slot key → the image file that fills it, per theme folder. */
const THEME_SLOT_FILES: Readonly<Record<string, string>> = {
  'center-bg': 'center-bg.png',
  'corner-beginning': 'corner-beginning.png',
  'corner-club': 'corner-club.png',
  'corner-bus': 'corner-bus.png',
  'corner-prison': 'corner-prison.png',
  'mahkama-tb': 'mahkama-tb.png',
  'mahkama-right': 'mahkama-right.png',
  hazak: 'hazak.png',
  'dual-trigger': 'dual-trigger.png',
  'fuel-station': 'fuel-station.png',
  'deck-mahkama': 'deck-mahkama.png',
  'deck-hazak': 'deck-hazak.png',
  preview: 'preview.png',
};

/** Square id → themed slot. Squares absent here get no themed artwork. */
const THEME_SLOT_MAP: Readonly<Record<number, string>> = {
  1: 'corner-beginning',
  8: 'corner-club',
  18: 'corner-bus',
  25: 'corner-prison',
  4: 'dual-trigger',
  11: 'mahkama-tb',
  13: 'hazak',
  16: 'fuel-station',
  21: 'mahkama-right',
  30: 'hazak',
  32: 'mahkama-tb',
};

export function themeSlotFor(id: SquareId): string | undefined {
  return THEME_SLOT_MAP[id];
}

/** Exposed for the lobby preview, which renders an arbitrary theme, not `S.mySelectedTheme`. */
export const THEME_SLOT_MAP_PUBLIC: Readonly<Record<number, string>> = THEME_SLOT_MAP;
export const THEME_SLOT_FILES_PUBLIC: Readonly<Record<string, string>> = THEME_SLOT_FILES;

export function getThemeImageUrl(slotKey: string | undefined): string | null {
  if (S.mySelectedTheme === 'plain' || slotKey === undefined) return null;
  const file = THEME_SLOT_FILES[slotKey];
  if (file === undefined) return null;
  return `assets/themes/${S.mySelectedTheme}/${file}`;
}

/** Discovers theme folders. Safe to call once at boot. */
export function detectThemes(): void {
  try {
    const meta = import.meta as unknown as ImportMetaGlob;
    const modules = meta.glob('./assets/themes/*/center-bg.png', { eager: false });
    const names = Object.keys(modules)
      .map((p) => {
        const parts = p.split('/');
        return parts[parts.length - 2];
      })
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    S.availableThemes = ['plain', ...names];
  } catch {
    S.availableThemes = ['plain'];
  }
}

/** Selects that already have their `change` handler, so re-init cannot re-bind. */
const boundSelects = new WeakSet<HTMLSelectElement>();

/**
 * Fills and syncs the theme dropdowns. Idempotent: `resetToLobby` calls this
 * every time a room is left, and the legacy version added another `change`
 * listener on each call — leave and rejoin three times and one dropdown change
 * fired four handlers.
 */
export function initThemeSelectors(): void {
  for (const id of ['theme-host', 'theme-join']) {
    const sel = byId<HTMLSelectElement>(id);
    if (!sel) continue;
    sel.innerHTML = S.availableThemes
      .map(
        (t) =>
          `<option value="${t}">${t === 'plain' ? '🎨 Plain' : '🎭 ' + t.charAt(0).toUpperCase() + t.slice(1)}</option>`,
      )
      .join('');
    sel.value = S.mySelectedTheme;
    if (!boundSelects.has(sel)) {
      boundSelects.add(sel);
      sel.addEventListener('change', () => {
        S.mySelectedTheme = sel.value;
      });
    }
  }
}

// ── Avatars ──

const AVATAR_COUNT = 20;

export function getPfpUrl(num: number): string {
  return `assets/pfps/avatar${num}.svg`;
}

function renderPfpGrid(containerId: string): void {
  const el = byId(containerId);
  if (!el) return;
  el.innerHTML = '';
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const div = document.createElement('div');
    div.className = 'pfp-option' + (i === S.mySelectedAvatar ? ' selected' : '');
    div.innerHTML = `<img src="${getPfpUrl(i)}" alt="Avatar ${i}" />`;
    div.addEventListener('click', () => {
      S.mySelectedAvatar = i;
      localStorage.setItem('bankelhaz_avatar', String(i));
      // Both grids are re-marked, not just the one clicked. The legacy handler
      // only cleared `.selected` inside its own container, so picking an avatar
      // on the Host tab left the Join tab showing the previous highlight.
      markSelectedAvatar();
    });
    el.appendChild(div);
  }
}

/** Re-applies the `.selected` highlight in every pfp grid, without re-rendering. */
function markSelectedAvatar(): void {
  for (const containerId of ['pfp-grid-host', 'pfp-grid-join']) {
    const el = byId(containerId);
    if (!el) continue;
    qsa<HTMLElement>('.pfp-option', el).forEach((opt, idx) => {
      opt.classList.toggle('selected', idx + 1 === S.mySelectedAvatar);
    });
  }
}

export function initPfpPickers(): void {
  renderPfpGrid('pfp-grid-host');
  renderPfpGrid('pfp-grid-join');
}
