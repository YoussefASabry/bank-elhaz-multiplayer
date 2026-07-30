/**
 * Rule constants.
 *
 * Deliberately thin. Upgrade costs and rents are NOT here — they come from the
 * board data (`owner_paying` = build cost, `visitor_paying` = rent) because the
 * user's decision is that the JSON is authoritative. An earlier draft of the plan
 * proposed deriving cost as a percentage of `purchase_price`; that was the model
 * used by the deleted src/ engine and it did not match the data. Reintroducing a
 * cost constant here would silently change the economy, so don't.
 *
 * Board size is derived from the loaded data, never written as a literal (bug
 * B30: `34` appeared hardcoded in src/dice.js and gameEngine.js).
 */

import type { UpgradeTier } from './types.js';

/** Refund when selling a property or an upgrade back to the bank. */
export const SELL_REFUND_RATIO = 0.75;

/**
 * Build order. Tiers are strictly sequential: you may only build the NEXT tier.
 * The old `getUpgradeOptions` offered all three unconditionally, so from a
 * `market` a player could pay for a `garage` — a downgrade you pay money for
 * (bug B24).
 */
export const UPGRADE_ORDER: readonly UpgradeTier[] = ['garage', 'rest_stop', 'market'] as const;

/** The tier that may be built next, or null when already at the top. */
export function nextTier(current: UpgradeTier | null): UpgradeTier | null {
  if (current === null) return UPGRADE_ORDER[0] ?? null;
  const idx = UPGRADE_ORDER.indexOf(current);
  if (idx < 0) return null;
  return UPGRADE_ORDER[idx + 1] ?? null;
}

/** Rank of a tier, for ordering comparisons. null (no upgrade) ranks -1. */
export function tierRank(tier: UpgradeTier | null): number {
  return tier === null ? -1 : UPGRADE_ORDER.indexOf(tier);
}

export const DEFAULT_TURN_TIMEOUT_SECONDS = 90;
/** Rent gets a longer window; paying may require selling assets first. */
export const RENT_TURN_TIMEOUT_SECONDS = 120;

export const TRADE_TIMEOUT_SECONDS = 60;
/** Max trades a seat may open per rolling window. */
export const TRADE_RATE_LIMIT = 3;
export const TRADE_RATE_WINDOW_MS = 60_000;

export const BID_TTL_MS = 120_000;

/** Snapshot validity window for signed resume (bug B19). */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_PLAYERS_HARD_CAP = 6;
