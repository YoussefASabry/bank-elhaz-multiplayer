import type { ColorGroup, SquareId, UpgradeTier } from '../shared/types';

export const BOARD_W = 1064;
export const BOARD_H = 735;

export const MAX_TRADES = 5;
export const MAX_OFFERS = 5;

export const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export const CORNER_ICONS: Record<number, string> = { 1: '🏁', 8: '🎰', 18: '🚌', 25: '🔒' };

export const UPGRADE_ICONS: Record<UpgradeTier, string> = {
  garage: '🏗️',
  rest_stop: '🏡',
  market: '🏬',
};

export const UPGRADE_LABELS: Record<UpgradeTier, string> = {
  garage: 'Garage 🏗️',
  rest_stop: 'Rest Stop 🏡',
  market: 'Market 🏬',
};

export const COLOR_BG_MAP: Record<ColorGroup, string> = {
  purple: '#9b59b6',
  pink: '#ff80ab',
  orange: '#ff9800',
  yellow: '#FFEB3B',
  brown: '#795548',
  green: '#4caf50',
  cyan: '#00bcd4',
  white: '#90a4ae',
  red: '#f44336',
  utility: '#607d8b',
};

export const DEFAULT_COLOR_BG = '#607d8b';

export function getColorGroupBG(group: ColorGroup | undefined | null): string {
  if (group && COLOR_BG_MAP[group]) return COLOR_BG_MAP[group];
  return DEFAULT_COLOR_BG;
}

export function edgeClass(id: SquareId): string {
  if (id <= 8) return 'edge-left';
  if (id <= 18) return 'edge-top';
  if (id <= 25) return 'edge-right';
  return 'edge-bottom';
}

export function gridClass(id: SquareId): string {
  return 'p' + id;
}

export function cornerLayout(count: number): string[] {
  if (count <= 2) return ['corner-tl', 'corner-br'];
  if (count === 3) return ['corner-tc', 'corner-bl', 'corner-br'];
  if (count === 4) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br'];
  if (count === 5) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lc'];
  if (count === 6) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lc', 'corner-rc'];
  if (count === 7) return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lt', 'corner-lc', 'corner-rc'];
  return ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'corner-lt', 'corner-lb', 'corner-rt', 'corner-rc'];
}

export const PFP_COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63'];

export const AVATAR_MIN = 1;
export const AVATAR_MAX = 20;

/** Avatar assets are `assets/pfps/avatar1.svg` … `avatar20.svg`. */
export function pfpUrl(avatar: number): string {
  const n = Math.min(AVATAR_MAX, Math.max(AVATAR_MIN, Math.floor(avatar) || AVATAR_MIN));
  return `assets/pfps/avatar${n}.svg`;
}
