/**
 * Card draw and resolution.
 *
 * The three-way reveal (WIRE.md rule 3) is emitted from `domainEvents.ts` off
 * the `CARD_DRAWN` event, not from here — `private_card` to the drawer,
 * `other_drawing` + `public_card_draw` to everyone else. All this file does is
 * turn a click into an action.
 *
 * B09: `confirm_blind_card` used to apply the card's effect to whoever *sent*
 * the event, with no turn check at all, so any player could resolve another
 * player's card onto themselves. The reducer's `pending_player` entitlement
 * makes the caller and the drawing player the same seat by construction, so the
 * handler does not (and cannot usefully) check anything.
 */
import type { DeckType } from '../../shared/types.js';
import type { ServerCtx } from '../context.js';
import { dispatch } from '../dispatch.js';
import { inGame, type TypedSocket } from './common.js';

function asDeck(value: unknown): DeckType | null {
  return value === 'hazak' || value === 'mahkama' ? value : null;
}

export function registerCardHandlers(ctx: ServerCtx, socket: TypedSocket): void {
  socket.on('draw_card', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const deck = asDeck(p?.deckType);
    if (deck === null) return;
    dispatch(ctx, at.room, { type: 'DRAW_CARD', actorId: at.seat.id, deck });
  });

  socket.on('confirm_blind_card', () => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    // Tear the shared reveal down first, so the table stops showing a card that
    // is about to be resolved. Purely a UI trigger — no domain event fits.
    ctx.emit.toRoomExcept(at.room.code, socket.id, 'close_public_card');
    dispatch(ctx, at.room, { type: 'CONFIRM_CARD', actorId: at.seat.id });
  });

  /**
   * `choiceIndex` indexes the FLATTENED option list: a pool-bearing choice
   * expands to one entry per resolved city, so "cash or a free city" with four
   * eligible cities is five options, not two. The engine's `resolveChoice`
   * owns that expansion and rejects an out-of-range index.
   */
  socket.on('card_choice', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const index = Number(p?.choiceIndex);
    if (!Number.isInteger(index) || index < 0) return;
    dispatch(ctx, at.room, { type: 'CHOOSE_CARD_OPTION', actorId: at.seat.id, index });
  });

  socket.on('club_choice', (p) => {
    const at = inGame(ctx, socket);
    if (at === null) return;
    const choice = p?.choice;
    if (choice !== 'membership' && choice !== 'guest') return;
    dispatch(ctx, at.room, { type: 'CHOOSE_CLUB', actorId: at.seat.id, choice });
  });
}
