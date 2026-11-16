/**
 * Raw on-disk shapes for data/board.json, data/hazak.json, data/mahkama.json.
 *
 * These mirror the JSON EXACTLY, warts included. Nothing outside the data loader
 * (src/engine/board.ts, src/engine/deck.ts) should import from this file — the
 * loader normalises these into the clean domain types in ./types.ts and the rest
 * of the codebase only ever sees those.
 *
 * Why this file exists: the old server read `card.half_price` while the data
 * actually spells the key `"half price"` (with a space), so the half-rent card
 * silently never fired (bug B36). Typing the raw shape makes that class of
 * mistake a compile error instead of a runtime no-op.
 */

// ── board.json ──

export type RawColorGroup =
  | 'purple'
  | 'pink'
  | 'orange'
  | 'yellow'
  | 'brown'
  | 'green'
  | 'cyan'
  | 'white'
  | 'red'
  | 'utility';

/** Rent/cost tiers. NOTE the `_rent` suffix appears in BOTH tables — see RawRentTable. */
export interface RawRentTable {
  garage_rent: number;
  rest_stop_rent: number;
  market_rent: number;
}

/**
 * A normal, upgradable city.
 *
 * `visitor_paying` is the RENT a visitor pays at each tier.
 * `owner_paying`   is the COST the owner pays to BUILD each tier.
 *
 * Both use the `_rent` suffix, which is a data-format wart, not a semantic:
 * on القدس (id 2) building a garage costs owner_paying.garage_rent = 250 and
 * then earns visitor_paying.garage_rent = 190 per visit. Costs rise
 * (250/750/1000) and rents rise faster (190/900/1550) — a coherent economy.
 * The deleted src/ engine modelled cost as a % of purchase_price, which did NOT
 * match this data; that model was wrong and is gone.
 */
export interface RawUpgradableProperty {
  id: number;
  name: string;
  type: 'property';
  color_group: RawColorGroup;
  purchase_price: number;
  base_rent: number;
  visitor_paying: RawRentTable;
  owner_paying: RawRentTable;
}

/** Utility (only محطة بنزين, id 16): priced and rentable, but has NO tier tables. */
export interface RawUtilityProperty {
  id: number;
  name: string;
  type: 'property';
  color_group: RawColorGroup;
  purchase_price: number;
  base_rent: number;
  notes?: string;
  visitor_paying?: never;
  owner_paying?: never;
}

export type RawProperty = RawUpgradableProperty | RawUtilityProperty;

export interface RawCornerSquare {
  id: number;
  name: string;
  type: 'corner_square';
  description?: string;
  /** id 8 (نادي الحظ) only. */
  membership_cost?: number;
  guest_fine_fee?: number;
  /** id 18 (الأتوبيس السريع) only — the data names the effect, the old code hardcoded `case 18`. */
  status_effect?: string;
  /** id 25 (السجن) only. */
  rules?: { max_turns_to_miss: number; bail_cost: number };
}

export interface RawDeckTrigger {
  id: number;
  name: string;
  type: 'deck_trigger';
  deck_type: 'hazak' | 'mahkama';
}

export interface RawDualDeckTrigger {
  id: number;
  name: string;
  type: 'dual_deck_trigger';
  description?: string;
}

export type RawSquare =
  | RawProperty
  | RawCornerSquare
  | RawDeckTrigger
  | RawDualDeckTrigger;

export interface RawGameMeta {
  title: string;
  starting_cash_player: number;
  pass_go_salary: number;
  max_players: number;
  min_players: number;
}

export interface RawBoard {
  game_meta: RawGameMeta;
  board_positions: RawSquare[];
}

// ── hazak.json / mahkama.json ──

export type RawChoiceActionType =
  | 'receive_cash'
  | 'claim_free_property'
  | 'move_to_dynamic_pool'
  | 'pay_fine'
  | 'go_to_prison';

/**
 * Choice options are a loose bag in the data. Note that hazak card 14 carries
 * `choices: [{}]` — a single EMPTY object — so any check of the form
 * `choices.length > 0` misfires. Presence of `action_type` is the real signal,
 * and the loader drops optionless entries.
 */
export interface RawChoice {
  action_type?: RawChoiceActionType;
  /** Present on mahkama choices; the old engine hardcoded its own Arabic strings instead (B38). */
  label?: string;
  amount?: number;
  max_price?: number;
  pool_options?: number[];
  pool_source?: string;
  selection_count?: number;
  unowned_only?: boolean;
}

/** Fields shared by both decks. Every card carries all of them, usually as 0. */
interface RawCardCommon {
  id: number;
  description: string;
  bank_money: number;
  players_money: number;
  free_card: number;
  no_prison_card: number;
  move_to: number;
  squares_to_move: number;
  choices: RawChoice[];
}

export interface RawHazakCard extends RawCardCommon {
  /**
   * THE WART (B36): the key is literally `"half price"`, with a space, and only
   * hazak card 14 has it. `gameEngine.js:514` read `card.half_price` — a
   * different, non-existent key — so half-rent never applied on the server.
   * Declared here so the correct spelling is the only one that type-checks.
   */
  'half price'?: 0 | 1;
  action?: never;
}

export type RawMahkamaAction =
  | 'collect_from_players'
  | 'pay_bank'
  | 'receive_bank'
  | 'go_to_jail'
  | 'receive_jail_free_card'
  | 'bank_pays_per_building'
  | 'pay_repairs'
  | 'collect_from_city_owners'
  | 'choice'
  | 'skip_turn_and_pay';

export interface RawMahkamaCard extends RawCardCommon {
  action: RawMahkamaAction;
  jail_free_card: number;
  skip_next_turn: number;
  /** action === 'bank_pays_per_building' */
  per_building_amount?: number;
  /** action === 'pay_repairs' */
  repair_costs?: { garage: number; rest_stop: number; market: number };
  /** action === 'collect_from_city_owners' */
  amount_per_city?: number;
  city_count?: number;
}

export type RawCard = RawHazakCard | RawMahkamaCard;

export interface RawHazakDeck {
  hazak: RawHazakCard[];
}

export interface RawMahkamaDeck {
  mahkama: RawMahkamaCard[];
}
