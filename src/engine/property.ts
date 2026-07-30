/**
 * Property economy: rent, upgrades, and buying/selling to the bank.
 *
 * THE ECONOMY IS DATA-DRIVEN AND UNCHANGED (user decision — see shared/rules.ts):
 *   build cost of tier T   = square.buildCost[T]    (from `owner_paying` in the data)
 *   visitor rent at tier T = square.visitorRent[T]  (from `visitor_paying` in the data)
 *   base rent (no upgrade) = square.baseRent
 *   sell refund            = round(cost * SELL_REFUND_RATIO)
 * An earlier draft derived build cost as a percentage of `purchasePrice`; that was
 * the deleted src/ engine's model and it did NOT match this data (e.g. القدس,
 * id 2: costs 250/750/1000, rents 190/900/1550 — not any simple fraction of the
 * 300 purchase price). Don't reintroduce that.
 *
 * B24: upgrades are strictly sequential. `getUpgradeOptions` returns AT MOST the
 * one next tier (via `nextTier()`), never all three — the old code pushed every
 * tier unconditionally, so a `market` could "upgrade" to a `garage` for money.
 * `purchaseUpgrade` rejects any tier that isn't exactly the next one.
 *
 * B25: ONE rent formula, here and nowhere else. `calculateRent` is also where the
 * half-rent card (B36) pays off: if the visitor is carrying
 * `statusEffects.payHalfRentNextLanding`, the rent is halved (rounded up) and the
 * flag is consumed (set back to false) so it only ever fires once.
 *
 * محطة بنزين (square 16) is a `UtilityProperty`, not an `UpgradableProperty` — it
 * is ownable but has no tier tables. `isUpgradableSquare` (board.ts) makes that a
 * structural check rather than a runtime `if`: `getUpgradeOptions` returns `[]`
 * for it and `purchaseUpgrade` rejects with `square_not_upgradable`.
 */

import { isOwnable, isUpgradableSquare } from './board.js';
import {
  ownerOf,
  upgradeOf,
  setOwner,
  setUpgrade,
  ownsFullColorGroup,
  requirePlayer,
  squareAt,
  credit,
  debit,
} from './state.js';
import { nextTier, SELL_REFUND_RATIO } from '../shared/rules.js';
import type { GameState, SeatId, SquareId, UpgradeTier, UpgradeOption } from '../shared/types.js';
import type { RejectReason } from '../shared/actions.js';

export type BuyPropertyResult = { ok: true; price: number } | { ok: false; reason: RejectReason };
export type SellToBankResult = { ok: true; refund: number } | { ok: false; reason: RejectReason };
export type PurchaseUpgradeResult =
  | { ok: true; tier: UpgradeTier; cost: number }
  | { ok: false; reason: RejectReason };
export type SellUpgradeResult =
  | { ok: true; tier: UpgradeTier; refund: number }
  | { ok: false; reason: RejectReason };

/**
 * Rent owed by `visitorId` for landing on `squareId` right now.
 *
 * Returns 0 for squares that aren't ownable, are unowned, or are owned by the
 * visitor themself (no self-rent). Otherwise: base rent with no upgrade, or the
 * visitor-rent for the current tier. If the visitor is carrying a half-rent
 * flag, halves (rounding up) and CONSUMES it — see B25/B36 above.
 */
export function calculateRent(state: GameState, squareId: SquareId, visitorId: SeatId): number {
  const square = squareAt(state, squareId);
  if (square === undefined || !isOwnable(square)) return 0;

  const owner = ownerOf(state, squareId);
  if (owner === null || owner === visitorId) return 0;

  const upgrade = upgradeOf(state, squareId);
  const base = upgrade !== null && isUpgradableSquare(square) ? square.visitorRent[upgrade] : square.baseRent;

  const visitor = requirePlayer(state, visitorId);
  if (visitor.statusEffects.payHalfRentNextLanding) {
    visitor.statusEffects.payHalfRentNextLanding = false;
    return Math.ceil(base / 2);
  }
  return base;
}

/**
 * The upgrade(s) `seatId` may currently build on `squareId` — at most one
 * entry, the next tier in sequence (B24). Empty when the square isn't
 * upgradable, isn't owned by this seat, the seat doesn't own the whole colour
 * group yet, or the square is already at the top tier.
 */
export function getUpgradeOptions(state: GameState, seatId: SeatId, squareId: SquareId): UpgradeOption[] {
  const square = squareAt(state, squareId);
  if (square === undefined || !isUpgradableSquare(square)) return [];
  if (ownerOf(state, squareId) !== seatId) return [];
  if (!ownsFullColorGroup(state, seatId, square.colorGroup)) return [];

  const tier = nextTier(upgradeOf(state, squareId));
  if (tier === null) return [];

  return [{ tier, cost: square.buildCost[tier], visitorRent: square.visitorRent[tier] }];
}

/**
 * Build `tier` on `squareId` for `seatId`. Rejects, in order: unknown square,
 * non-ownable square, non-upgradable square (utility — B_16), not the owner,
 * missing the full colour group, a tier that isn't exactly next (B24), and
 * insufficient funds.
 */
export function purchaseUpgrade(
  state: GameState,
  seatId: SeatId,
  squareId: SquareId,
  tier: UpgradeTier,
): PurchaseUpgradeResult {
  const square = squareAt(state, squareId);
  if (square === undefined) return { ok: false, reason: 'square_not_found' };
  if (!isOwnable(square)) return { ok: false, reason: 'square_not_ownable' };
  if (!isUpgradableSquare(square)) return { ok: false, reason: 'square_not_upgradable' };
  if (ownerOf(state, squareId) !== seatId) return { ok: false, reason: 'not_the_owner' };
  if (!ownsFullColorGroup(state, seatId, square.colorGroup)) {
    return { ok: false, reason: 'upgrade_requires_full_color_group' };
  }

  const expected = nextTier(upgradeOf(state, squareId));
  if (expected === null || tier !== expected) return { ok: false, reason: 'upgrade_tier_not_next' };

  const cost = square.buildCost[tier];
  const player = requirePlayer(state, seatId);
  if (player.money < cost) return { ok: false, reason: 'insufficient_funds' };

  debit(player, cost);
  setUpgrade(state, squareId, tier);
  return { ok: true, tier, cost };
}

/**
 * Sell the standing upgrade on `squareId` back to the bank for
 * `SELL_REFUND_RATIO` of its build cost, clearing the upgrade back to `null`.
 * `square_not_upgradable` is for a square with no tier table at all (utility);
 * `no_upgrade_to_sell` is for an upgradable square that simply has nothing
 * built on it yet.
 */
export function sellUpgrade(state: GameState, seatId: SeatId, squareId: SquareId): SellUpgradeResult {
  const square = squareAt(state, squareId);
  if (square === undefined) return { ok: false, reason: 'square_not_found' };
  if (!isOwnable(square)) return { ok: false, reason: 'square_not_ownable' };
  if (ownerOf(state, squareId) !== seatId) return { ok: false, reason: 'not_the_owner' };
  if (!isUpgradableSquare(square)) return { ok: false, reason: 'square_not_upgradable' };

  const tier = upgradeOf(state, squareId);
  if (tier === null) return { ok: false, reason: 'no_upgrade_to_sell' };

  const refund = Math.round(square.buildCost[tier] * SELL_REFUND_RATIO);
  const player = requirePlayer(state, seatId);
  credit(player, refund);
  setUpgrade(state, squareId, null);
  return { ok: true, tier, refund };
}

/** Buy an unowned ownable square from the bank at its listed purchase price. */
export function buyProperty(state: GameState, seatId: SeatId, squareId: SquareId): BuyPropertyResult {
  const square = squareAt(state, squareId);
  if (square === undefined) return { ok: false, reason: 'square_not_found' };
  if (!isOwnable(square)) return { ok: false, reason: 'square_not_ownable' };
  // Defence in depth. The reducer only reaches this from a `property_choice`
  // pending state, which turn.ts creates for UNOWNED squares only, so this is
  // unreachable in normal flow. Without it, though, an out-of-band call would
  // have `setOwner` overwrite the existing owner with no error at all — a player
  // silently loses a city and nothing appears in the log. Cheap guard, and the
  // failure it prevents is invisible property theft.
  if (ownerOf(state, squareId) !== null) return { ok: false, reason: 'square_already_owned' };

  const price = square.purchasePrice;
  const player = requirePlayer(state, seatId);
  if (player.money < price) return { ok: false, reason: 'insufficient_funds' };

  debit(player, price);
  setOwner(state, squareId, seatId);
  return { ok: true, price };
}

/**
 * Sell an owned square back to the bank. Refunds 75% of the purchase price
 * PLUS 75% of the standing upgrade's build cost, if any, then clears both
 * owner and upgrade.
 */
export function sellPropertyToBank(state: GameState, seatId: SeatId, squareId: SquareId): SellToBankResult {
  const square = squareAt(state, squareId);
  if (square === undefined) return { ok: false, reason: 'square_not_found' };
  if (!isOwnable(square)) return { ok: false, reason: 'square_not_ownable' };
  if (ownerOf(state, squareId) !== seatId) return { ok: false, reason: 'not_the_owner' };

  const tier = upgradeOf(state, squareId);
  const upgradeCost = tier !== null && isUpgradableSquare(square) ? square.buildCost[tier] : 0;
  const refund = Math.round(square.purchasePrice * SELL_REFUND_RATIO) + Math.round(upgradeCost * SELL_REFUND_RATIO);

  const player = requirePlayer(state, seatId);
  credit(player, refund);
  setOwner(state, squareId, null);
  setUpgrade(state, squareId, null);
  return { ok: true, refund };
}
