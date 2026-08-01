import type { SquareId } from '../shared/types';

const centerModules = import.meta.glob('../../assets/themes/*/center-bg.png', {
  eager: true,
  query: '?url',
  import: 'default',
});
const slotModules = import.meta.glob('../../assets/themes/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

export type ThemeSlotKey =  | 'corner_beginning'
  | 'corner_club'
  | 'corner_bus'
  | 'corner_prison'
  | 'mahkama_tb'
  | 'mahkama_right'
  | 'hazak'
  | 'dual_trigger'
  | 'fuel_station'
  | 'deck_mahkama'
  | 'deck_hazak'
  | 'center_bg';

export const THEME_SLOT_FILES: Record<ThemeSlotKey, string> = {
  corner_beginning: 'corner-beginning.png',
  corner_club: 'corner-club.png',
  corner_bus: 'corner-bus.png',
  corner_prison: 'corner-prison.png',
  mahkama_tb: 'mahkama-tb.png',
  mahkama_right: 'mahkama-right.png',
  hazak: 'hazak.png',
  dual_trigger: 'dual-trigger.png',
  fuel_station: 'fuel-station.png',
  deck_mahkama: 'deck-mahkama.png',
  deck_hazak: 'deck-hazak.png',
  center_bg: 'center-bg.png',
};

export const THEME_SLOT_MAP: Partial<Record<SquareId, ThemeSlotKey>> = {
  1: 'corner_beginning',
  8: 'corner_club',
  18: 'corner_bus',
  25: 'corner_prison',
  11: 'mahkama_tb',
  32: 'mahkama_tb',
  21: 'mahkama_right',
  13: 'hazak',
  30: 'hazak',
  4: 'dual_trigger',
  16: 'fuel_station',
};

export function themeList(): string[] {
  const themes = new Set<string>();
  for (const key of Object.keys(centerModules)) {
    const m = key.match(/themes\/([^/]+)\/center-bg\.png$/);
    if (m && m[1]) themes.add(m[1]);
  }
  return ['plain', ...Array.from(themes).sort()];
}

function urlFor(theme: string, file: string): string {
  const key = `../../assets/themes/${theme}/${file}`;
  const found = Object.entries(slotModules).find(([k]) => k.endsWith(`/${theme}/${file}`));
  if (found) return found[1] as string;
  return key;
}

export function centerBgUrl(theme: string): string | null {
  if (theme === 'plain') return null;
  return urlFor(theme, THEME_SLOT_FILES.center_bg) || null;
}

export function slotUrl(theme: string, slot: ThemeSlotKey): string | null {
  if (theme === 'plain') return null;
  const url = urlFor(theme, THEME_SLOT_FILES[slot]);
  return url || null;
}

export function themeBgForSquare(theme: string, squareId: SquareId): string | null {
  const slot = THEME_SLOT_MAP[squareId];
  if (!slot) return null;
  return slotUrl(theme, slot);
}
