import type {
  ClientState as ServerState,
  LobbyMember,
  PublicPlayer,
} from '../shared/events';
import type { DomainEvent } from '../shared/actions';
import type { Basket, SeatId, SquareId } from '../shared/types';
import type { Trade, Bid } from '../shared/trading';

export type DialogName =
  | 'property_buy'
  | 'upgrade'
  | 'card_choice'
  | 'blind_card'
  | 'club'
  | 'prison'
  | 'jail_free'
  | 'bankrupt'
  | 'rent'
  | 'inspect'
  | 'inventory'
  | 'trade_request'
  | 'player_list'
  | 'player_action'
  | 'trade'
  | 'bid_create'
  | 'bid_respond'
  | 'sell_bldg'
  | 'preview'
  | 'winner';

export interface DialogEntry {
  name: DialogName;
  closeOnServer: boolean;
  order: number;
}

export const DIALOG_PRIORITY: Record<DialogName, number> = {
  winner: 100,
  property_buy: 60,
  upgrade: 60,
  card_choice: 60,
  blind_card: 60,
  club: 60,
  prison: 60,
  jail_free: 60,
  bankrupt: 60,
  trade_request: 55,
  trade: 50,
  bid_create: 50,
  bid_respond: 50,
  rent: 40,
  sell_bldg: 35,
  inspect: 30,
  inventory: 30,
  player_list: 30,
  player_action: 30,
  preview: 10,
};

export interface UIClientState {
  cs: ServerState | null;
  roomCode: string;
  mySeatId: SeatId;
  gameStarted: boolean;
  dialogs: DialogEntry[];
  nextDialogOrder: number;
  myOffer: Basket | null;
  myJailCards: number;
  pendingSecondCard: boolean;
  lobbyMembers: LobbyMember[];
  lastTimer: { seconds: number; running: boolean; total: number } | null;
  lastTradeTimers: Record<string, number>;
  roomError: string | null;
  lastEvents: DomainEvent[];
}

export type ClientAction =
  | { type: 'lobby'; roomCode: string; mySeatId: SeatId; members: LobbyMember[] }
  | { type: 'members'; members: LobbyMember[] }
  | { type: 'state'; cs: ServerState }
  | { type: 'events'; events: DomainEvent[] }
  | { type: 'roomError'; message: string }
  | { type: 'timer'; seconds: number; running: boolean; total: number }
  | { type: 'tradeTimer'; tradeId: string; seconds: number }
  | { type: 'dialogOpen'; name: DialogName; closeOnServer?: boolean }
  | { type: 'dialogClose'; name: DialogName }
  | { type: 'dialogsClear' }
  | { type: 'myOffer'; offer: Basket | null }
  | { type: 'myJailCards'; count: number }
  | { type: 'pendingSecondCard'; value: boolean }
  | { type: 'reset' };

export function initialUIState(): UIClientState {
  return {
    cs: null,
    roomCode: '',
    mySeatId: '',
    gameStarted: false,
    dialogs: [],
    nextDialogOrder: 0,
    myOffer: null,
    myJailCards: 0,
    pendingSecondCard: false,
    lobbyMembers: [],
    lastTimer: null,
    lastTradeTimers: {},
    roomError: null,
    lastEvents: [],
  };
}

// ── Dialog queue helpers ──

export function topDialog(state: UIClientState): DialogEntry | null {
  if (state.dialogs.length === 0) return null;
  return state.dialogs.reduce((top, e) => (e.order < top.order ? e : top), state.dialogs[0]!);
}

export function isDialogOpen(state: UIClientState, name: DialogName): boolean {
  return state.dialogs.some((e) => e.name === name);
}

export function isTopDialog(state: UIClientState, name: DialogName): boolean {
  const top = topDialog(state);
  return top !== null && top.name === name;
}

function sortedDialogs(state: UIClientState): DialogEntry[] {
  return [...state.dialogs].sort((x, y) => {
    if (DIALOG_PRIORITY[y.name] !== DIALOG_PRIORITY[x.name]) {
      return DIALOG_PRIORITY[y.name] - DIALOG_PRIORITY[x.name];
    }
    return x.order - y.order;
  });
}

/** Highest-priority open dialog; the only one that should be visible. */
export function visibleDialog(state: UIClientState): DialogEntry | null {
  return sortedDialogs(state)[0] ?? null;
}

export function reducer(state: UIClientState, action: ClientAction): UIClientState {
  switch (action.type) {
    case 'lobby':
      return {
        ...state,
        roomCode: action.roomCode,
        mySeatId: action.mySeatId,
        lobbyMembers: action.members,
        roomError: null,
      };
    case 'members':
      return { ...state, lobbyMembers: action.members };
    case 'state':
      return { ...state, cs: action.cs, gameStarted: true, roomError: null };
    case 'events':
      return { ...state, lastEvents: action.events };
    case 'roomError':
      return { ...state, roomError: action.message };
    case 'timer':
      return { ...state, lastTimer: { seconds: action.seconds, running: action.running, total: action.total } };
    case 'tradeTimer':
      return { ...state, lastTradeTimers: { ...state.lastTradeTimers, [action.tradeId]: action.seconds } };
    case 'dialogOpen': {
      if (state.dialogs.some((e) => e.name === action.name)) return state;
      const entry: DialogEntry = {
        name: action.name,
        closeOnServer: action.closeOnServer ?? false,
        order: state.nextDialogOrder,
      };
      return {
        ...state,
        dialogs: [...state.dialogs, entry],
        nextDialogOrder: state.nextDialogOrder + 1,
      };
    }
    case 'dialogClose':
      return { ...state, dialogs: state.dialogs.filter((e) => e.name !== action.name) };
    case 'dialogsClear':
      return { ...state, dialogs: [] };
    case 'myOffer':
      if (action.offer === state.myOffer) return state;
      return { ...state, myOffer: action.offer };
    case 'myJailCards':
      return { ...state, myJailCards: action.count };
    case 'pendingSecondCard':
      return { ...state, pendingSecondCard: action.value };
    case 'reset':
      return initialUIState();
    default:
      return state;
  }
}

// ── Selectors ──

export function myPlayer(state: UIClientState): PublicPlayer | null {
  if (!state.cs) return null;
  return state.cs.players.find((p) => p.id === state.mySeatId) ?? null;
}

export function currentPlayer(state: UIClientState): PublicPlayer | null {
  if (!state.cs) return null;
  return state.cs.players[state.cs.currentPlayerIndex] ?? null;
}

export function isMyTurn(state: UIClientState): boolean {
  if (!state.cs || state.cs.gameOver) return false;
  const cur = currentPlayer(state);
  return cur !== null && cur.id === state.mySeatId && !cur.isBankrupt && !cur.eliminated;
}

/** This client is the player the current pending decision addresses. */
export function pendingForMe(state: UIClientState): boolean {
  if (!state.cs) return false;
  const p = state.cs.pending;
  if (p.kind === 'none' || p.kind === 'blind_card_hidden') return false;
  return p.playerId === state.mySeatId;
}

export function canRoll(state: UIClientState): boolean {
  if (!state.cs || state.cs.gameOver) return false;
  if (state.cs.phase !== 'roll') return false;
  if (state.cs.pending.kind !== 'none') return false;
  const cur = currentPlayer(state);
  return cur !== null && cur.id === state.mySeatId && !cur.isBankrupt && !cur.eliminated && !cur.statusEffects.skipNextTurn;
}

/** True when the client should confirm landing (phase `rolling`, no pending). */
export function awaitingLandingConfirm(state: UIClientState): boolean {
  if (!state.cs || state.cs.gameOver) return false;
  if (state.cs.phase !== 'rolling') return false;
  if (state.cs.pending.kind !== 'none') return false;
  const cur = currentPlayer(state);
  return cur !== null && cur.id === state.mySeatId;
}

export function squareOwner(cs: ServerState, squareId: SquareId): PublicPlayer | null {
  const own = cs.ownership[squareId];
  if (!own || own.owner === null) return null;
  return cs.players.find((p) => p.id === own.owner) ?? null;
}

export function myOwnedSquares(state: UIClientState): SquareId[] {
  if (!state.cs) return [];
  return Object.entries(state.cs.ownership)
    .filter(([, o]) => o.owner === state.mySeatId && o.upgrade === null)
    .map(([id]) => Number(id));
}

export function myTradableSquares(state: UIClientState): SquareId[] {
  return myOwnedSquares(state);
}

export function myTrades(state: UIClientState): Trade[] {
  if (!state.cs) return [];
  return state.cs.trades.filter((t) => t.a === state.mySeatId || t.b === state.mySeatId);
}

export function bidsForMe(state: UIClientState): Bid[] {
  if (!state.cs) return [];
  return state.cs.bids.filter((b) => b.playerId === state.mySeatId);
}
