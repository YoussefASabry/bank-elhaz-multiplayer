/**
 * Turn a broadcast `DomainEvent[]` batch into UI feedback: toasts, big text,
 * money floats, dice animation and token movement hooks. Pure side effects;
 * owned by main.ts which feeds it the current store snapshot.
 */
import type { DomainEvent } from '../shared/actions';
import type { SquareId } from '../shared/types';
import type { UIClientState } from './store';
import { animateBus, animateDice, flashMoney, showBigText, showFloatMoney, showToast } from './fx';

export interface NarrateOpts {
  onMoved: (playerId: string, from: SquareId, to: SquareId, teleported: boolean) => void;
}

function nameOf(ui: UIClientState, id: string): string {
  return ui.cs?.players.find((p) => p.id === id)?.name ?? 'لاعب';
}

function squareNameOf(ui: UIClientState, id: SquareId): string {
  return ui.cs?.board.squares.find((s) => s.id === id)?.name ?? '';
}

/** Shake both dice displays, then settle on the rolled faces. */
export function rollDiceAnimation(die1: number, die2: number): void {
  document.querySelectorAll<HTMLElement>('.center-dice').forEach((area) => {
    const dice = Array.from(area.querySelectorAll<HTMLElement>('.die'));
    if (dice.length >= 2) animateDice(dice, die1, die2, 600);
  });
}

export function narrateEvents(ui: UIClientState, opts: NarrateOpts): void {
  for (const e of ui.lastEvents) {
    switch (e.type) {
      case 'DICE_ROLLED':
        rollDiceAnimation(e.die1, e.die2);
        break;
      case 'MOVED':
        if (e.teleported) {
          animateBus(e.from, e.to);
        } else {
          opts.onMoved(e.playerId, e.from, e.to, false);
        }
        break;
      case 'PASSED_GO':
        showFloatMoney(e.amount, e.playerId);
        showToast(`${nameOf(ui, e.playerId)} مرّ من البداية +$${e.amount.toLocaleString('en-US')}`, { card: true });
        break;
      case 'MONEY_CHANGED':
        showFloatMoney(e.delta, e.playerId);
        flashMoney(e.playerId, e.delta);
        break;
      case 'PROPERTY_BOUGHT':
        showToast(`🏠 ${nameOf(ui, e.playerId)} اشترى ${squareNameOf(ui, e.squareId)} ب $${e.price.toLocaleString('en-US')}`);
        break;
      case 'PROPERTY_DECLINED':
        showToast(`❌ ${nameOf(ui, e.playerId)} رفض شراء ${squareNameOf(ui, e.squareId)}`);
        break;
      case 'RENT_PAID':
        showToast(`💸 ${nameOf(ui, e.playerId)} دفع $${e.amount.toLocaleString('en-US')} إيجار`);
        break;
      case 'UPGRADE_BUILT':
        showToast(`🏗️ ${nameOf(ui, e.playerId)} بنى ${e.tier} في ${squareNameOf(ui, e.squareId)}`);
        break;
      case 'UPGRADE_SOLD':
        showToast(`🏷️ ${nameOf(ui, e.playerId)} باع تحسين من ${squareNameOf(ui, e.squareId)}`);
        break;
      case 'PROPERTY_SOLD':
        showToast(`🏷️ ${nameOf(ui, e.playerId)} باع ${squareNameOf(ui, e.squareId)}`);
        break;
      case 'CARD_DRAWN':
        showToast(`🃏 ${nameOf(ui, e.playerId)} يسحب بطاقة`, { card: true });
        break;
      case 'CARD_RESOLVED':
        showToast(`🃏 ${nameOf(ui, e.playerId)}: ${e.description}`, { card: true });
        break;
      case 'CITY_OWNERS_CHARGED':
        showToast(`🏙️ ${nameOf(ui, e.playerId)} يدفع $${e.totalCollected.toLocaleString('en-US')} لأصحاب المدن`);
        break;
      case 'JAILED':
        showBigText(`🔒 ${nameOf(ui, e.playerId)} في السجن!`, 'loss');
        break;
      case 'RELEASED_FROM_JAIL':
        showToast(`🔓 ${nameOf(ui, e.playerId)} خرج من السجن`);
        break;
      case 'PRISON_TURN_SKIPPED':
        showToast(`⏭️ ${nameOf(ui, e.playerId)} يخطي دور السجن (بقي ${e.remaining})`);
        break;
      case 'CLUB_RESOLVED':
        showToast(`🎰 ${nameOf(ui, e.playerId)} ${e.choice === 'membership' ? 'اشترى عضوية' : 'دفع ضريبة الضيف'}`);
        break;
      case 'DOUBLE_NEXT_ROLL_GRANTED':
        showBigText('🎲🎲 زوجية! رمي إضافي');
        break;
      case 'TURN_SKIPPED':
        showToast(`⏭️ ${nameOf(ui, e.playerId)} يخطي الدور`);
        break;
      case 'TURN_STARTED':
        if (e.playerId === ui.mySeatId) showBigText('🎯 Your Turn 🎯', 'celebrate');
        break;
      case 'BANKRUPT':
        showBigText(`💥 ${nameOf(ui, e.playerId)} مفلس!`, 'loss');
        break;
      case 'GAME_OVER':
        showBigText('🏆 انتهت اللعبة', 'celebrate');
        break;
      case 'TRADE_OPENED':
        showToast(`🤝 ${nameOf(ui, e.a)} يريد التداول مع ${nameOf(ui, e.b)}`);
        break;
      case 'TRADE_SETTLED':
        showToast('🤝 تم التداول بنجاح');
        break;
      case 'TRADE_CANCELLED':
        showToast('✕ أُلغي التداول');
        break;
      case 'BID_CREATED':
        showToast(`📢 ${nameOf(ui, e.playerId)} نشر عرضاً`);
        break;
      case 'BID_OFFER_ADDED':
        showToast(`📩 ${nameOf(ui, e.playerId)} قدّم عرضاً مقابل`);
        break;
      case 'BID_SETTLED':
        showToast('✅ اكتمل عرض المزايدة');
        break;
      case 'BID_CANCELLED':
        showToast('✕ سُحب عرض المزايدة');
        break;
      case 'REJECTED':
      case 'PHASE_CHANGED':
      case 'TRADE_STAGE_CHANGED':
      case 'PLAYER_KICKED':
        break;
      default:
        break;
    }
  }
}
