#!/bin/bash
# ──────────────────────────────────────────────
#  Bank El Haz — Local 2-Tab Test Script
# ──────────────────────────────────────────────
#  Starts the server and prints instructions
#  for testing in two browser tabs.
# ──────────────────────────────────────────────

cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🎲 Bank El Haz — Local Test Server    ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Starting server on http://localhost:3001 ..."
echo ""
echo "  ─── HOW TO TEST ───"
echo ""
echo "  1. Open TWO browser tabs/windows at:"
echo "       http://localhost:3001"
echo ""
echo "  2. Tab 1: Enter a name → click HOST GAME"
echo "     Tab 2: Enter a name → enter the room code → JOIN"
echo ""
echo "  3. Tab 1: Click START GAME"
echo ""
echo "  ─── TEST CHECKLIST ───"
echo ""
echo "  [ ] Dice roll animation works (no infinite shaking)"
echo "  [ ] After roll, dice stop shaking and show final faces"
echo "  [ ] Roll button shows 'Roll Dice' on your turn"
echo "  [ ] Roll button shows 'Wait...' when not your turn"
echo "  [ ] Trade button opens player selector → modal stays open"
echo "  [ ] Bid button opens bid modal → stays open"
echo "  [ ] Inventory button opens modal → stays open"
echo "  [ ] Toast notifications are narrow (not full-width)"
echo "  [ ] Property buy modal appears when landing on empty property"
echo "  [ ] Rent payment works (pay rent / declare bankruptcy)"
echo "  [ ] Card draws work (click deck pile on card squares)"
echo "  [ ] Turn advances correctly between players"
echo ""
echo "  Press Ctrl+C to stop the server."
echo ""

node server.js
