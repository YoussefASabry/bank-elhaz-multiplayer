/**
 * The ONE place `DomainEvent[]` becomes socket traffic.
 *
 * Every handler's job ends at "translate the intent into an `Action` and call
 * `applyAction`". What the table *sees* as a result is decided exclusively
 * here. The legacy server did the opposite — each of its ~30 handlers built its
 * own log line and chose its own broadcast — which is how `pay_rent` and the
 * timeout rent path came to narrate the same event differently (bug B22), and
 * how `state_update` grew a "X's turn" log line that fired on *every* broadcast
 * that happened to catch `phase === 'roll'`, spamming the toast stack (bug B26).
 * Here the turn banner comes from `TURN_STARTED` and from nothing else.
 *
 * The switch is exhaustive with a `never` fallthrough, so adding a
 * `DomainEvent` variant without deciding how the table learns about it is a
 * compile error rather than a silent omission.
 */
import type { DomainEvent } from '../shared/actions.js';
import type { Bid, GameState, SeatId, Trade } from '../shared/types.js';
import type { ServerCtx } from './context.js';
import {
  playerAvatar,
  playerName,
  squareName,
  toWireBid,
  toWireProposal,
  toWireWinner,
  tradeParticipants,
} from './context.js';
import type { Room } from './rooms.js';

/**
 * Copies of the collections an action may *remove* from. `TRADE_SETTLED`,
 * `TRADE_CANCELLED`, `BID_SETTLED` and `BID_CANCELLED` all name an entity the
 * reducer has already deleted, so the payload has to be rebuilt from what was
 * there a moment ago.
 */
export interface PreDispatch {
  trades: Trade[];
  bids: Bid[];
}

export function capture(state: GameState | null): PreDispatch {
  if (state === null) return { trades: [], bids: [] };
  return {
    trades: state.trades.map((t) => ({ ...t })),
    bids: state.bids.map((b) => ({ ...b, offers: b.offers.map((o) => ({ ...o })) })),
  };
}

function resolveTrade(state: GameState, before: PreDispatch, tradeId: string): Trade | undefined {
  return state.trades.find((t) => t.id === tradeId) ?? before.trades.find((t) => t.id === tradeId);
}

function resolveBid(state: GameState, before: PreDispatch, bidId: string): Bid | undefined {
  return state.bids.find((b) => b.id === bidId) ?? before.bids.find((b) => b.id === bidId);
}

function socketOf(ctx: ServerCtx, room: Room, seatId: SeatId): string | null {
  return ctx.rooms.seatOf(room, seatId)?.socketId ?? null;
}

export function log(ctx: ServerCtx, room: Room, message: string): void {
  ctx.emit.toRoom(room.code, 'action_log', { message });
}

function toParticipants(
  ctx: ServerCtx,
  room: Room,
  seats: readonly SeatId[],
  send: (socketId: string) => void,
): void {
  for (const seatId of seats) {
    const sid = socketOf(ctx, room, seatId);
    if (sid !== null) send(sid);
  }
}

/**
 * The engine names cancel reasons `cancelled_by_player` / `expired`; the frozen
 * wire says `cancelled` / `timeout`, and the client switches on those strings.
 * WIRE.md wins, so translate at the boundary rather than in the engine.
 */
function wireCancelReason(reason: string): string {
  if (reason === 'cancelled_by_player') return 'cancelled';
  if (reason === 'expired') return 'timeout';
  return reason;
}

/** Human-readable deck label, matching the legacy strings exactly. */
function deckLabel(queue: readonly string[]): string {
  if (queue.length > 1) return '⚖️ المحكمة + 🍀 حظك';
  return queue[0] === 'mahkama' ? '⚖️ المحكمة' : '🍀 حظك';
}

export function emitDomainEvents(
  ctx: ServerCtx,
  room: Room,
  events: readonly DomainEvent[],
  before: PreDispatch,
): void {
  const state = room.state;
  if (state === null) return;

  for (const ev of events) {
    switch (ev.type) {
      // A refusal is server-side truth only. WIRE.md's 35 events have no
      // `rejected` channel, and the legacy handlers simply returned, so the
      // client learns nothing — matching behaviour exactly.
      case 'REJECTED':
        break;

      case 'TURN_STARTED': {
        log(ctx, room, `👉 ${playerName(state, ev.playerId)}'s turn`);
        break;
      }

      // Phase is carried by every `state_update`; no separate signal.
      case 'PHASE_CHANGED':
        break;

      case 'DICE_ROLLED': {
        const roll = state.lastRoll;
        if (roll !== null) {
          ctx.emit.toRoom(room.code, 'dice_rolled', {
            die1: roll.die1,
            die2: roll.die2,
            total: roll.total,
            isDouble: state.config.diceCount === 2 && roll.die1 === roll.die2,
            oldPos: roll.from,
            newPos: roll.to,
            steps: roll.steps,
            passedGo: roll.passedGo,
            path: roll.path,
            playerId: roll.playerId,
          });
        }
        log(
          ctx,
          room,
          `🎲 ${playerName(state, ev.playerId)} rolled ${ev.die1}+${ev.die2}=${ev.total}`,
        );
        if (ev.doubleApplied) {
          ctx.emit.toRoom(room.code, 'splash_text', {
            text: '🚌 Fast Bus — Double Next Roll!',
            type: '',
          });
        }
        break;
      }

      // Movement is visible in the projected state; the animation is driven by
      // `dice_rolled.path`.
      case 'MOVED':
        break;

      case 'PASSED_GO': {
        log(ctx, room, `💵 ${playerName(state, ev.playerId)} collected $${ev.amount} salary`);
        break;
      }

      // Balances ride on the projection. Narration for the *reason* is emitted
      // by the specific event that caused it, so money is never double-logged.
      case 'MONEY_CHANGED':
        break;

      case 'PROPERTY_BOUGHT': {
        log(
          ctx,
          room,
          `🏠 ${playerName(state, ev.playerId)} bought ${squareName(state, ev.squareId)}`,
        );
        break;
      }

      case 'PROPERTY_DECLINED': {
        log(
          ctx,
          room,
          `🚫 ${playerName(state, ev.playerId)} declined ${squareName(state, ev.squareId)}`,
        );
        break;
      }

      case 'PROPERTY_SOLD': {
        log(
          ctx,
          room,
          `🏚️ ${playerName(state, ev.playerId)} sold ${squareName(state, ev.squareId)} to bank`,
        );
        break;
      }

      // The prompt itself is `pending`; the projection carries it.
      case 'RENT_DUE':
        break;

      case 'RENT_PAID': {
        const to = ev.ownerId === null ? 'Bank' : playerName(state, ev.ownerId);
        log(ctx, room, `💰 ${playerName(state, ev.playerId)} paid $${ev.amount} rent to ${to}`);
        break;
      }

      case 'UPGRADE_BUILT': {
        log(
          ctx,
          room,
          `🏗️ ${playerName(state, ev.playerId)} built ${ev.tier} on ${squareName(state, ev.squareId)}`,
        );
        break;
      }

      case 'UPGRADE_SOLD': {
        log(
          ctx,
          room,
          `🏗️ ${playerName(state, ev.playerId)} sold upgrade on ${squareName(state, ev.squareId)} for $${ev.refund}`,
        );
        break;
      }

      /**
       * The three-way card reveal (WIRE.md rule 3). The drawer gets the card;
       * everyone else gets `other_drawing` plus the public mirror. The legacy
       * server did this too — but it also broadcast the card inside
       * `state_update`, so the privacy was decorative. `view.ts` now redacts it.
       */
      case 'CARD_DRAWN': {
        const pending = state.pending;
        if (pending.kind !== 'blind_card') break;
        const drawer = socketOf(ctx, room, ev.playerId);
        const player = state.players.find((p) => p.id === ev.playerId);
        const info = {
          card: pending.card,
          cardNumber: pending.cardNumber,
          squareName: player === undefined ? '' : squareName(state, player.position),
          deckType: ev.deck,
          pendingSecondCard: pending.remainingDraws.length > 0,
          cityNames: (pending.cityIds ?? []).map((id) => squareName(state, id)),
        };
        if (drawer !== null) {
          ctx.emit.toSocket(drawer, 'private_card', info);
          ctx.emit.toRoomExcept(room.code, drawer, 'other_drawing', {
            playerName: playerName(state, ev.playerId),
          });
          ctx.emit.toRoomExcept(room.code, drawer, 'public_card_draw', {
            ...info,
            playerName: playerName(state, ev.playerId),
          });
        }
        log(ctx, room, `🃏 ${playerName(state, ev.playerId)} is reading a card...`);
        break;
      }

      case 'CARD_RESOLVED': {
        const who = playerName(state, ev.playerId);
        ctx.emit.toRoom(room.code, 'card_outcome', {
          description: ev.description,
          playerName: who,
          deckType: ev.deck,
        });
        log(ctx, room, `🃏 ${who}: ${ev.description}`);
        break;
      }

      case 'CITY_OWNERS_CHARGED': {
        const names = ev.squareIds.map((id) => squareName(state, id)).join('، ');
        log(ctx, room, `🏙️ ${names} — collected $${ev.totalCollected}`);
        break;
      }

      case 'JAILED': {
        ctx.emit.toRoom(room.code, 'splash_text', { text: '🔒 Sent to Prison!', type: 'loss' });
        log(ctx, room, `🔒 ${playerName(state, ev.playerId)} was sent to prison`);
        break;
      }

      case 'RELEASED_FROM_JAIL': {
        const who = playerName(state, ev.playerId);
        if (ev.via === 'jail_free_card') {
          const sid = socketOf(ctx, room, ev.playerId);
          if (sid !== null) {
            ctx.emit.toSocket(sid, 'splash_text', { text: '🔓 Jail Free!', type: 'celebrate' });
          }
          log(ctx, room, `🔓 ${who} used a jail-free card`);
        } else if (ev.via === 'bail') {
          log(ctx, room, `💰 ${who} paid bail`);
        } else {
          log(ctx, room, `🔓 ${who} served their sentence`);
        }
        break;
      }

      case 'PRISON_TURN_SKIPPED': {
        log(ctx, room, `⏭️ ${playerName(state, ev.playerId)} skipped prison turn`);
        break;
      }

      case 'CLUB_RESOLVED': {
        const who = playerName(state, ev.playerId);
        log(ctx, room, `🎰 ${who} chose ${ev.choice} at the club`);
        if (ev.choice === 'membership') {
          const sid = socketOf(ctx, room, ev.playerId);
          if (sid !== null) {
            ctx.emit.toSocket(sid, 'splash_text', { text: '🎰 Club Member!', type: 'celebrate' });
          }
        }
        break;
      }

      case 'DOUBLE_NEXT_ROLL_GRANTED': {
        ctx.emit.toRoom(room.code, 'splash_text', {
          text: '🚌 Fast Bus — Double Next Roll!',
          type: '',
        });
        break;
      }

      case 'TURN_SKIPPED': {
        log(ctx, room, `⏭️ ${playerName(state, ev.playerId)}'s turn was skipped (${ev.reason})`);
        break;
      }

      case 'BANKRUPT': {
        const who = playerName(state, ev.playerId);
        log(
          ctx,
          room,
          ev.rule === 'jail'
            ? `🔒 ${who} went bankrupt — sent to prison`
            : `💀 ${who} went bankrupt and is out`,
        );
        break;
      }

      case 'PLAYER_KICKED': {
        log(ctx, room, `💀 A player was kicked by the host`);
        break;
      }

      case 'GAME_OVER': {
        ctx.emit.toRoom(room.code, 'game_over', { winner: toWireWinner(state) });
        break;
      }

      /* ── trades ── */

      case 'TRADE_OPENED': {
        const trade = resolveTrade(state, before, ev.tradeId);
        if (trade === undefined) break;
        const payload = {
          tradeId: trade.id,
          state: trade.stage,
          initiatorId: trade.a,
          initiator: {
            id: trade.a,
            name: playerName(state, trade.a),
            avatar: playerAvatar(state, trade.a),
            money: state.players.find((p) => p.id === trade.a)?.money ?? 0,
          },
          partner: {
            id: trade.b,
            name: playerName(state, trade.b),
            avatar: playerAvatar(state, trade.b),
            money: state.players.find((p) => p.id === trade.b)?.money ?? 0,
          },
          proposalA: toWireProposal(trade.proposalA),
          proposalB: toWireProposal(trade.proposalB),
        };
        toParticipants(ctx, room, tradeParticipants(trade), (sid) =>
          ctx.emit.toSocket(sid, 'trade_opened', payload),
        );
        log(
          ctx,
          room,
          `🤝 ${playerName(state, trade.a)} opened a trade with ${playerName(state, trade.b)}`,
        );
        break;
      }

      case 'TRADE_STAGE_CHANGED': {
        const trade = resolveTrade(state, before, ev.tradeId);
        if (trade === undefined) break;
        const payload = {
          tradeId: trade.id,
          state: trade.stage,
          proposalA: toWireProposal(trade.proposalA),
          proposalB: toWireProposal(trade.proposalB),
          acceptedA: trade.acceptedA,
          acceptedB: trade.acceptedB,
          _participants: tradeParticipants(trade),
        };
        toParticipants(ctx, room, tradeParticipants(trade), (sid) =>
          ctx.emit.toSocket(sid, 'trade_state_update', payload),
        );
        break;
      }

      case 'TRADE_SETTLED': {
        const payload = {
          aName: playerName(state, ev.a),
          bName: playerName(state, ev.b),
          aId: ev.a,
          bId: ev.b,
          _participants: [ev.a, ev.b],
        };
        // Legacy broadcast the execution to the whole room, not just the pair.
        ctx.emit.toRoom(room.code, 'trade_executed', payload);
        log(ctx, room, `🤝 Trade executed between ${payload.aName} and ${payload.bName}!`);
        break;
      }

      case 'TRADE_CANCELLED': {
        const trade = resolveTrade(state, before, ev.tradeId);
        const participants = trade === undefined ? [] : tradeParticipants(trade);
        const payload = { reason: wireCancelReason(ev.reason), _participants: participants };
        toParticipants(ctx, room, participants, (sid) =>
          ctx.emit.toSocket(sid, 'trade_cancelled', payload),
        );
        break;
      }

      /* ── bids ── */

      case 'BID_CREATED': {
        const bid = resolveBid(state, before, ev.bidId);
        if (bid === undefined) break;
        ctx.emit.toRoom(room.code, 'bid_created', toWireBid(state, bid));
        log(ctx, room, `📢 ${playerName(state, ev.playerId)} posted a public bid!`);
        break;
      }

      case 'BID_OFFER_ADDED': {
        const bid = resolveBid(state, before, ev.bidId);
        if (bid === undefined) break;
        // Legacy re-sent the WHOLE bid, not just the new offer.
        ctx.emit.toRoom(room.code, 'bid_offer_added', toWireBid(state, bid));
        log(ctx, room, `📩 ${playerName(state, ev.playerId)} made an offer on a bid`);
        break;
      }

      case 'BID_SETTLED': {
        const bidderName = playerName(state, ev.bidderId);
        const offererName = playerName(state, ev.offererId);
        ctx.emit.toRoom(room.code, 'bid_executed', {
          bidderName,
          offererName,
          bidId: ev.bidId,
        });
        log(ctx, room, `✅ ${bidderName} accepted ${offererName}'s bid offer!`);
        break;
      }

      case 'BID_CANCELLED': {
        ctx.emit.toRoom(room.code, 'bid_cancelled', { bidId: ev.bidId });
        log(ctx, room, `🚫 A bid was cancelled`);
        break;
      }

      default: {
        const never: never = ev;
        throw new Error(`Unhandled domain event: ${JSON.stringify(never)}`);
      }
    }
  }
}

/**
 * `landed_on_deck` is not a domain event — it is a UI nudge derived from the
 * pending slot after an action settles. Emitted once, to the seat that must act.
 */
export function emitDeckPrompt(ctx: ServerCtx, room: Room): void {
  const state = room.state;
  if (state === null || state.pending.kind !== 'deck_draw') return;
  const label = deckLabel(state.pending.queue);
  const who = state.pending.playerId;
  log(
    ctx,
    room,
    `🃏 ${playerName(state, who)} landed on ${label} — click a deck pile to draw!`,
  );
  const sid = socketOf(ctx, room, who);
  if (sid !== null) ctx.emit.toSocket(sid, 'landed_on_deck', { deckLabel: label });
}
