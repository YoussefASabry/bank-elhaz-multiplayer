/**
 * Property: buying, declining, rent, upgrades, liquidation.
 *
 * Note what is NOT here: `sell_to_bank_for_rent`. WIRE.md rule 5 — no client
 * emits it and it is unreachable, so it is deleted rather than ported. Its 30
 * lines of hand-rolled "sell everything then force jail" logic were also a
 * second, divergent insolvency model; `checkInsolvency` in the engine is now
 * the only one (bug B21).
 *
 * `declare_bankrupt_from_rent` maps onto the same single model rather than
 * re-implementing the forced-jail path the legacy handler inlined.
 */
import type { UpgradeTier } from '../../shared/types.js';
import type { ServerCtx } from '../context.js';
import { dispatch } from '../dispatch.js';
import { asSquareId, inGame, type TypedSocket } from './common.js';

const TIERS: readonly string[] = ['garage', 'rest_stop', 'market'];

function asTier(value: unknown): UpgradeTier | null {
  return typeof value === 'string' && TIERS.includes(value) ? (value as UpgradeTier) : null;
}

export function registerPropertyHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('buy_property', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'RESOLVE_PROPERTY_BUY', actorId: at.seat.id, buy: true });
  });

  socket.on('decline_property', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'RESOLVE_PROPERTY_BUY', actorId: at.seat.id, buy: false });
  });

  socket.on('pay_rent', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'PAY_RENT', actorId: at.seat.id });
  });

  socket.on('declare_bankrupt_from_rent', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'DECLARE_BANKRUPT', actorId: at.seat.id });
  });

  socket.on('buy_upgrade', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const squareId = asSquareId(p?.propertyId);
    const tier = asTier(p?.upgradeType);
    if (squareId === null || tier === null) return;
    dispatch(ctx, at.room, { type: 'BUY_UPGRADE', actorId: at.seat.id, squareId, tier });
  });

  socket.on('skip_upgrade', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    dispatch(ctx, at.room, { type: 'SKIP_UPGRADE', actorId: at.seat.id });
  });

  socket.on('sell_upgrade', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const squareId = asSquareId(p?.propertyId);
    if (squareId === null) return;
    dispatch(ctx, at.room, { type: 'SELL_UPGRADE', actorId: at.seat.id, squareId });
  });

  socket.on('sell_property', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const squareId = asSquareId(p?.propertyId);
    if (squareId === null) return;
    dispatch(ctx, at.room, { type: 'SELL_PROPERTY', actorId: at.seat.id, squareId });
  });

  /**
   * Selling a building from inside the trade dialog is the same act as selling
   * one anywhere else — it exists as a separate event only because the legacy
   * client needed a different UI refresh. It routes to `SELL_UPGRADE`, so the
   * ownership check, the refund ratio and the resulting log line cannot drift
   * from the normal path. The legacy handler recomputed the refund inline with
   * `sq.owner_paying[sq.upgrade + '_rent'] * 0.75` and never checked insolvency.
   */
  socket.on('sell_building_in_trade', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const squareId = asSquareId(p?.propId);
    if (squareId === null) return;
    dispatch(ctx, at.room, { type: 'SELL_UPGRADE', actorId: at.seat.id, squareId });
  });
}
