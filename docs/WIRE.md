# Wire Protocol — FROZEN

The contract between `src/server/` and `src/client/`. The lists below were
generated from the legacy `index.html`, `server.js` and `roomManager.js`, not
written by hand. The surface is symmetric — every client intent has a server
handler, every server event has a client listener — so any deviation introduced
by the refactor is a regression, not an improvement.

Verified: 37 client→server, 35 server→client, 0 orphans on either side.

## client → server (37)

`accept_trade_request` `bid_accept_offer` `bid_respond` `buy_property` 
`buy_upgrade` `cancel_bid` `card_choice` `club_choice` `confirm_blind_card` 
`confirm_landing` `create_bid` `debug_roll` `declare_bankrupt_from_rent` 
`decline_property` `decline_trade_request` `draw_card` `host_game` 
`join_game` `leave_room` `pay_bail` `pay_rent` `rejoin_game` `restore_game` 
`roll_dice` `sell_building_in_trade` `sell_property` `sell_upgrade` 
`skip_prison` `skip_upgrade` `start_game` `terminate_player` 
`trade_accept_proposal` `trade_cancel` `trade_decline_proposal` 
`trade_request` `trade_send_proposal` `use_jail_free` 

plus socket.io's built-in `disconnect`.

## server → client (35)

`action_log` `bid_cancelled` `bid_created` `bid_executed` `bid_offer_added` 
`card_outcome` `close_public_card` `dice_rolled` `game_over` `game_started` 
`joined` `landed_on_deck` `other_drawing` `player_disconnected` 
`player_reconnected` `player_terminated` `private_card` `public_card_draw` 
`rejoin_failed` `rejoined` `restore_game_result` `room_created` `splash_text` 
`state_update` `timer_sync` `trade_cancelled` `trade_error` `trade_executed` 
`trade_opened` `trade_request_declined` `trade_request_notify` 
`trade_request_sent` `trade_state_update` `trade_timer_sync` `update_players` 

## Rules

1. **`state_update` carries a redacted view**, never a raw `GameState`. Other
   players' held cards and the remaining deck order are stripped — see
   `server/view.ts`. Legacy broadcast both; that is B19's client-side twin.
2. **The client never sends state.** It sends an intent; the server builds the
   `Action` and calls `applyAction`. Any payload field that is not an id, an
   amount, or a choice is ignored.
3. **`private_card` goes to the drawing player only**; everyone else receives
   `other_drawing`. `public_card_draw` / `close_public_card` are the shared
   reveal for cards the rules make public.
4. **Timers are server-authoritative.** `timer_sync` / `trade_timer_sync` render
   a deadline the server already owns; a client that never receives one must
   still be timed out.
5. **One dead handler is deleted, not ported:** `sell_to_bank_for_rent` has no
   emitter in any client and is unreachable.
