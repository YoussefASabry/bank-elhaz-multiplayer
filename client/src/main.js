import { io } from 'socket.io-client';
import { buildBoard, updateCells, renderTokens, animateToken, showDice, flashCell, pfp, playerColor } from './board.js';
import { sounds, toggleMute, isMuted } from './sounds.js';

const socket = io();
const $ = id => document.getElementById(id);

const app = {
  myId: null,
  roomCode: null,
  isHost: false,
  state: null,          // latest server game state
  selectedSquare: null, // detail panel selection
  tradeDraft: null,     // local trade builder { toId, give:{...}, get:{...} }
  boardBuilt: false,
  timerTotal: 90,
  queue: Promise.resolve(), // serializes animated state applications
  prevMoney: {},
};

// ═══════════════ Lobby ═══════════════

let chosenAvatar = 1;

function initLobby() {
  for (const key of ['host', 'join']) {
    const grid = $(`pfp-${key}`);
    for (let i = 1; i <= 20; i++) {
      const img = document.createElement('img');
      img.src = pfp(i);
      img.className = i === 1 ? 'selected' : '';
      img.addEventListener('click', () => {
        chosenAvatar = i;
        document.querySelectorAll('.pfp-grid img').forEach(el => el.classList.remove('selected'));
        document.querySelectorAll('.pfp-grid img').forEach(el => { if (el.src.endsWith(`avatar${i}.svg`)) el.classList.add('selected'); });
      });
      grid.appendChild(img);
    }
  }

  $('tab-host').onclick = () => switchTab('host');
  $('tab-join').onclick = () => switchTab('join');
  $('btn-host').onclick = hostGame;
  $('btn-join').onclick = joinGame;
  $('btn-leave').onclick = () => { socket.emit('leave_room'); showWaiting(false); };
  $('btn-start').onclick = () => socket.emit('start_game', {}, r => { if (!r.ok) lobbyError(r.error); });
  $('join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

  const savedName = localStorage.getItem('beh_name');
  if (savedName) { $('host-name').value = savedName; $('join-name').value = savedName; }
}

function switchTab(tab) {
  $('tab-host').classList.toggle('active', tab === 'host');
  $('tab-join').classList.toggle('active', tab === 'join');
  $('panel-host').classList.toggle('show', tab === 'host');
  $('panel-join').classList.toggle('show', tab === 'join');
}

function lobbyError(msg) { $('lobby-error').textContent = msg || ''; }

function hostGame() {
  const name = $('host-name').value.trim();
  if (!name) return lobbyError('Enter your name');
  localStorage.setItem('beh_name', name);
  const options = {
    startingCash: parseInt($('opt-cash').value, 10),
    diceCount: parseInt($('opt-dice').value, 10),
    moneyVisible: $('opt-money').value === 'visible',
  };
  socket.emit('host_game', { playerName: name, avatar: chosenAvatar, options }, r => {
    if (!r.ok) return lobbyError(r.error);
    app.myId = r.playerId; app.roomCode = r.roomCode; app.isHost = true;
    showWaiting(true, r.players);
  });
}

function joinGame() {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim();
  if (!name) return lobbyError('Enter your name');
  if (code.length !== 4) return lobbyError('Enter the 4-letter room code');
  localStorage.setItem('beh_name', name);
  socket.emit('join_game', { roomCode: code, playerName: name, avatar: chosenAvatar }, r => {
    if (!r.ok) return lobbyError(r.error);
    app.myId = r.playerId; app.roomCode = r.roomCode; app.isHost = false;
    if (r.reconnected) return; // state broadcast will switch screens
    showWaiting(true, r.players);
  });
}

function showWaiting(on, players = []) {
  lobbyError('');
  $('waiting').classList.toggle('hidden', !on);
  $('panel-host').classList.toggle('show', !on && $('tab-host').classList.contains('active'));
  $('panel-join').classList.toggle('show', !on && $('tab-join').classList.contains('active'));
  document.querySelector('.lobby-tabs').style.display = on ? 'none' : 'flex';
  if (on) {
    $('room-code').textContent = app.roomCode;
    renderWaitingPlayers(players);
  } else {
    app.roomCode = null;
  }
}

function renderWaitingPlayers(players) {
  $('waiting-players').innerHTML = players.map((p, i) => `
    <div class="wp"><img src="${pfp(p.avatar)}" /><span>${esc(p.name)}</span>${i === 0 ? '<span class="host-tag">HOST</span>' : ''}</div>
  `).join('');
  const btn = $('btn-start');
  if (app.isHost) {
    btn.disabled = players.length < 2;
    btn.textContent = players.length < 2 ? 'Waiting for players…' : `▶ Start Game (${players.length} players)`;
  } else {
    btn.disabled = true;
    btn.textContent = 'Waiting for host to start…';
  }
}

// ═══════════════ Socket events ═══════════════

socket.on('connect', () => { $('conn-status').textContent = '🟢 Connected'; $('conn-status').classList.add('ok'); });
socket.on('disconnect', () => { $('conn-status').textContent = '🔴 Disconnected — reconnecting…'; $('conn-status').classList.remove('ok'); });

socket.on('lobby_players', ({ players }) => renderWaitingPlayers(players));

socket.on('state', ({ state, events }) => {
  app.queue = app.queue.then(() => applyState(state, events || [])).catch(console.error);
});

socket.on('timer', ({ seconds }) => updateTimer(seconds));
socket.on('trade_expired', () => { toast('⏳ Trade expired', 'bad'); closeTradeOverlay(); });
socket.on('player_connection', ({ connected, name }) => {
  toast(connected ? `🟢 ${name} reconnected` : `🔌 ${name} disconnected`, connected ? 'good' : 'bad');
});

// ═══════════════ State application ═══════════════

async function applyState(state, events) {
  const first = !app.state;
  app.state = state;

  if (first || !app.boardBuilt) {
    $('lobby').classList.remove('show');
    $('game').classList.add('show');
    buildBoard(state.squares, { onCellClick: selectSquare });
    app.boardBuilt = true;
    $('roll-btn').onclick = () => act({ type: 'roll' });
    $('btn-mute').textContent = isMuted() ? '🔇' : '🔊';
    for (const p of state.players) app.prevMoney[p.id] = p.money;
  }

  // Animate movement before painting final state
  const roll = events.find(e => e.type === 'roll');
  if (roll) {
    showDice(roll);
    sounds.dice();
    await sleep(800); // let everyone read the dice
    if (roll.path?.length) await animateToken(state, roll.playerId, roll.path);
    await sleep(500); // breathe after landing
  }
  const tp = events.find(e => e.type === 'teleport');
  if (tp) { flashCell(tp.to); }

  handleEventFeedback(events);
  render();
}

function handleEventFeedback(events) {
  const s = app.state;
  const name = id => s.players.find(p => p.id === id)?.name || '?';
  for (const e of events) {
    switch (e.type) {
      case 'salary': if (e.playerId === app.myId) { bigFloat(`+$${e.amount} 💵`); sounds.cash(); } break;
      case 'property_bought': sounds.buy(); flashCell(e.squareId); break;
      case 'paid':
        if (e.playerId === app.myId) { bigFloat(`-$${e.amount}`, true); sounds.pay(); }
        else if (e.creditorId === app.myId) { bigFloat(`+$${e.amount} 💰`); sounds.cash(); }
        break;
      case 'card_drawn': sounds.card(); break;
      case 'jailed': if (e.playerId === app.myId) { bigFloat('🔒 السجن!', true); } sounds.jail(); break;
      case 'trade_proposed': sounds.trade(); break;
      case 'trade_executed': sounds.trade(); toast('🤝 Trade completed!', 'good'); closeTradeOverlay(); break;
      case 'trade_declined': toast('❌ Trade declined', 'bad'); closeTradeOverlay(); break;
      case 'trade_cancelled': closeTradeOverlay(); break;
      case 'bankrupt': sounds.bankrupt(); toast(`💀 ${name(e.playerId)} is bankrupt!`, 'bad'); break;
      case 'game_over': sounds.win(); break;
      case 'turn_started': if (e.playerId === app.myId) { sounds.turn(); bigFloat('🎲 دورك!'); } break;
      case 'debt': if (e.playerId === app.myId) { sounds.pay(); toast(`⚠️ You owe $${e.amount} — raise funds or declare bankruptcy`, 'bad'); } break;
      case 'city_owners_card': toast(`🏙️ ${e.cities.map(c => c.name).join('، ')} → $${e.total}`); break;
    }
  }
}

// ═══════════════ Rendering ═══════════════

function render() {
  const s = app.state;
  if (!s) return;
  updateCells(s, app.myId, app.selectedSquare);
  renderTokens(s);
  renderTurnBanner();
  renderPlayers();
  renderMyPanel();
  renderActionPanel();
  renderDetailPanel();
  renderLog();
  renderCardOverlay();
  renderTradeOverlay();
  renderGameOver();
  renderCenter();
}

function me() { return app.state.players.find(p => p.id === app.myId); }
function isMyTurn() { return app.state.currentPlayerId === app.myId; }
function esc(str) { const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML; }
function sqById(id) { return app.state.squares.find(x => x.id === id); }

function renderTurnBanner() {
  const s = app.state;
  const cur = s.players.find(p => p.id === s.currentPlayerId);
  if (!cur) return;
  $('tb-avatar').src = pfp(cur.avatar);
  $('tb-name').textContent = cur.id === app.myId ? `${cur.name} (you)` : cur.name;
  $('tb-sub').textContent = phaseLabel(s);
}

function phaseLabel(s) {
  switch (s.phase) {
    case 'awaiting_roll': return s.players.find(p => p.id === s.currentPlayerId)?.inJail ? 'In prison…' : 'Rolling the dice…';
    case 'buy_decision': return 'Deciding on a property…';
    case 'card': return 'Drawing a card…';
    case 'card_choice': return 'Making a card choice…';
    case 'club_choice': return 'At the Luck Club…';
    case 'debt': return '⚠️ Raising funds…';
    case 'game_over': return '🏆 Game over';
    default: return '';
  }
}

function updateTimer(seconds) {
  const fill = $('timer-fill');
  if (!fill) return;
  const pct = Math.max(0, Math.min(100, (seconds / app.timerTotal) * 100));
  fill.style.width = `${pct}%`;
  fill.classList.toggle('warn', seconds <= 30 && seconds > 10);
  fill.classList.toggle('danger', seconds <= 10);
  if (seconds <= 5 && seconds > 0 && isMyTurn()) sounds.tick();
}

function renderPlayers() {
  const s = app.state;
  $('players-panel').innerHTML = s.players.map((p, i) => {
    const props = s.squares.filter(sq => sq.owner === p.id);
    const money = p.money === null ? '🙈' : `$${p.money}`;
    const badges = [
      p.inJail ? '🔒' : '',
      p.jailFreeCards ? `🎟️×${p.jailFreeCards}` : '',
      p.doubleNextRoll ? '🚌' : '',
      p.halfRentNext ? '½' : '',
      !p.connected ? '🔌' : '',
    ].filter(Boolean).join(' ');
    const moneyFlash = app.prevMoney[p.id] !== undefined && p.money !== null && p.money !== app.prevMoney[p.id]
      ? (p.money > app.prevMoney[p.id] ? 'gain' : 'loss') : '';
    app.prevMoney[p.id] = p.money;
    const tradeBtn = p.id !== app.myId && !p.isBankrupt && !me()?.isBankrupt && !s.gameOver
      ? `<button class="trade-btn" data-trade="${p.id}">🤝</button>` : '';
    return `
      <div class="pl-card ${p.id === s.currentPlayerId ? 'current' : ''} ${p.id === app.myId ? 'me' : ''} ${p.isBankrupt ? 'bankrupt' : ''} ${!p.connected ? 'offline' : ''}"
           style="border-left: 6px solid ${playerColor(i)}">
        <img src="${pfp(p.avatar)}" />
        <span class="pl-name">${esc(p.name)}${p.id === app.myId ? ' ⭐' : ''}</span>
        <span class="pl-badges">${badges}</span>
        <span class="pl-money ${moneyFlash}">${money}</span>
        <span style="font-size:0.7rem;color:var(--ink-soft)">🏠${props.length}</span>
        ${tradeBtn}
      </div>`;
  }).join('');
  $('players-panel').querySelectorAll('[data-trade]').forEach(btn => {
    btn.onclick = ev => { ev.stopPropagation(); openTradeBuilder(btn.dataset.trade); };
  });
}

function renderMyPanel() {
  const s = app.state;
  const panel = $('my-panel');
  const my = me();
  if (!my) { panel.innerHTML = ''; return; }
  const mine = s.squares.filter(sq => sq.owner === my.id);
  const chips = mine.map(sq => `
    <span class="mp-chip cg-${sq.color_group}" data-sq="${sq.id}">
      ${esc(sq.name)}${sq.level ? ` ${sq.level >= 3 ? '🏬' : '🏠'.repeat(sq.level)}` : ''}
    </span>`).join('');
  const cards = [
    my.jailFreeCards ? `🎟️ Jail-free ×${my.jailFreeCards}` : '',
    my.freeCards ? `🃏 Free-play ×${my.freeCards}` : '',
  ].filter(Boolean).join(' · ');
  panel.innerHTML = `
    <div class="mp-title">📜 Your properties (${mine.length}) — $${my.money ?? '?'}</div>
    <div class="mp-chips">${chips || '<span class="mp-empty">Nothing yet — land on a city and buy it!</span>'}</div>
    ${cards ? `<div class="mp-cards">${cards}</div>` : ''}`;
  panel.querySelectorAll('[data-sq]').forEach(el => {
    el.onclick = () => selectSquare(parseInt(el.dataset.sq, 10));
  });
}

function renderCenter() {
  const s = app.state;
  const rollBtn = $('roll-btn');
  const hint = $('roll-hint');
  if (!rollBtn) return;
  const myTurnToRoll = isMyTurn() && s.phase === 'awaiting_roll' && !me()?.inJail && !s.gameOver;
  rollBtn.style.display = myTurnToRoll ? '' : 'none';
  if (s.gameOver) hint.textContent = '';
  else if (myTurnToRoll) hint.textContent = '';
  else {
    const cur = s.players.find(p => p.id === s.currentPlayerId);
    hint.textContent = cur ? `${cur.name}'s turn` : '';
  }
}

// ── Action panel: contextual, replaces stacked modals ──

function renderActionPanel() {
  const s = app.state;
  const panel = $('action-panel');
  const my = me();
  if (!my || s.gameOver) { panel.innerHTML = `<div class="ap-title">${s.gameOver ? '🏆 Game over' : ''}</div>`; return; }
  if (my.isBankrupt) { panel.innerHTML = '<div class="ap-title">💀 You are bankrupt</div><div class="ap-sub">Spectating…</div>'; return; }

  if (!isMyTurn()) {
    const cur = s.players.find(p => p.id === s.currentPlayerId);
    panel.innerHTML = `<div class="ap-title">⏳ Waiting for ${esc(cur?.name || '…')}</div><div class="ap-sub">${phaseLabel(s)}</div>`;
    return;
  }

  switch (s.phase) {
    case 'awaiting_roll': {
      if (my.inJail) {
        panel.innerHTML = `
          <div class="ap-title">🔒 You are in prison (${my.jailTurns} turn${my.jailTurns > 1 ? 's' : ''} left)</div>
          <div class="ap-row">
            <button class="act-btn red" id="ap-bail" ${my.money < 50 ? 'disabled' : ''}>💰 Pay $50 bail</button>
            <button class="act-btn blue" id="ap-jailcard" ${my.jailFreeCards < 1 ? 'disabled' : ''}>🎟️ Use card (${my.jailFreeCards})</button>
            <button class="act-btn gray" id="ap-skip">⏭️ Wait it out</button>
          </div>`;
        $('ap-bail').onclick = () => act({ type: 'jail_pay' });
        $('ap-jailcard').onclick = () => act({ type: 'jail_card' });
        $('ap-skip').onclick = () => act({ type: 'jail_skip' });
      } else {
        panel.innerHTML = `<div class="ap-title">🎲 Your turn!</div><div class="ap-sub">Roll the dice on the board, or manage your properties below.</div>`;
      }
      break;
    }
    case 'buy_decision': {
      const sq = sqById(s.pending.squareId);
      const afford = my.money >= sq.purchase_price;
      panel.innerHTML = `
        <div class="ap-title">🏠 ${esc(sq.name)} is available — $${sq.purchase_price}</div>
        <div class="ap-row">
          <button class="act-btn green" id="ap-buy" ${afford ? '' : 'disabled'}>💰 Buy for $${sq.purchase_price}</button>
          <button class="act-btn gray" id="ap-decline">❌ Decline</button>
        </div>`;
      $('ap-buy').onclick = () => act({ type: 'buy' });
      $('ap-decline').onclick = () => act({ type: 'decline' });
      break;
    }
    case 'card':
    case 'card_choice':
      panel.innerHTML = `<div class="ap-title">🃏 Card drawn</div><div class="ap-sub">See the card overlay.</div>`;
      break;
    case 'club_choice': {
      const pend = s.pending;
      panel.innerHTML = `
        <div class="ap-title">🎰 Luck Club (نادي الحظ)</div>
        <div class="ap-row">
          <button class="act-btn blue" id="ap-member" ${my.money < pend.membershipCost ? 'disabled' : ''}>💳 Membership $${pend.membershipCost}</button>
          <button class="act-btn gray" id="ap-guest">🚶 Guest $${pend.guestFee}</button>
        </div>`;
      $('ap-member').onclick = () => act({ type: 'club_choice', choice: 'membership' });
      $('ap-guest').onclick = () => act({ type: 'club_choice', choice: 'guest' });
      break;
    }
    case 'debt': {
      const d = s.pending;
      const canPay = my.money >= d.amount;
      const creditor = s.players.find(p => p.id === d.creditorId);
      panel.innerHTML = `
        <div class="ap-title">⚠️ You owe $${d.amount} ${creditor ? `to ${esc(creditor.name)}` : 'to the bank'}</div>
        <div class="ap-sub">Cash: $${my.money}. Click your properties below to sell buildings or sell to the bank.</div>
        <div class="ap-row">
          <button class="act-btn green" id="ap-pay" ${canPay ? '' : 'disabled'}>💸 Pay $${d.amount}</button>
          <button class="act-btn red" id="ap-bankrupt">💀 Declare bankruptcy</button>
        </div>`;
      $('ap-pay').onclick = () => act({ type: 'pay_debt' });
      $('ap-bankrupt').onclick = () => {
        if (confirm('Declare bankruptcy? You lose the game.')) act({ type: 'declare_bankruptcy' });
      };
      break;
    }
    default:
      panel.innerHTML = `<div class="ap-title">…</div>`;
  }
}

// ── Property detail panel ──

function selectSquare(id) {
  app.selectedSquare = app.selectedSquare === id ? null : id;
  render();
}

function renderDetailPanel() {
  const s = app.state;
  const panel = $('detail-panel');
  const sq = app.selectedSquare ? sqById(app.selectedSquare) : null;
  if (!sq || sq.type !== 'property') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const owner = s.players.find(p => p.id === sq.owner);
  const mine = sq.owner === app.myId;
  const colorClass = `cg-${sq.color_group}`;
  const rentRows = sq.visitor_paying ? `
    <div class="dp-row"><span>Base rent ${'' /* doubled note */}</span><span class="v">$${sq.base_rent}</span></div>
    <div class="dp-row"><span>🏠 Garage</span><span class="v">$${sq.visitor_paying.garage_rent}</span></div>
    <div class="dp-row"><span>🏠🏠 Rest stop</span><span class="v">$${sq.visitor_paying.rest_stop_rent}</span></div>
    <div class="dp-row"><span>🏬 Market</span><span class="v">$${sq.visitor_paying.market_rent}</span></div>`
    : `<div class="dp-row"><span>Flat rent</span><span class="v">$${sq.base_rent}</span></div>`;

  const buildCost = lvl => Math.round(sq.purchase_price * [0, 0.5, 0.8, 1.2][lvl]);
  let actions = '';
  if (mine) {
    const canBuildHere = sq.color_group !== 'utility' && sq.level < 3;
    actions = `
      <div class="dp-actions">
        ${canBuildHere ? `<button class="act-btn green" id="dp-build">🏗️ Build ($${buildCost(sq.level + 1)})</button>` : ''}
        ${sq.level > 0 ? `<button class="act-btn gray" id="dp-sellb">Sell building (+$${Math.round(buildCost(sq.level) * 0.75)})</button>` : ''}
        ${sq.level === 0 ? `<button class="act-btn red" id="dp-sellp">Sell to bank (+$${Math.round(sq.purchase_price * 0.5)})</button>` : ''}
      </div>
      <div style="font-size:0.68rem;color:var(--ink-soft);margin-top:6px">Building needs the full ${sq.color_group} set, built evenly.</div>`;
  }

  panel.innerHTML = `
    <button class="dp-close" id="dp-close">✕</button>
    <div class="dp-header ${colorClass}">${esc(sq.name)}</div>
    <div class="dp-row"><span>Price</span><span class="v">$${sq.purchase_price}</span></div>
    <div class="dp-row"><span>Owner</span><span class="v">${owner ? esc(owner.name) : '— bank —'}</span></div>
    <div class="dp-row"><span>Buildings</span><span class="v">${sq.level >= 3 ? '🏬 Market' : '🏠'.repeat(sq.level) || 'None'}</span></div>
    ${rentRows}
    ${actions}`;
  $('dp-close').onclick = () => { app.selectedSquare = null; render(); };
  bind('dp-build', () => act({ type: 'build', squareId: sq.id }));
  bind('dp-sellb', () => act({ type: 'sell_building', squareId: sq.id }));
  bind('dp-sellp', () => { if (confirm(`Sell ${sq.name} to the bank?`)) act({ type: 'sell_property', squareId: sq.id }); });
}

function bind(id, fn) { const el = $(id); if (el) el.onclick = fn; }

function renderLog() {
  const el = $('log-panel');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = app.state.log.map(l => `<div>${esc(l)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── Card overlay ──

function renderCardOverlay() {
  const s = app.state;
  const overlay = $('card-overlay');
  const show = s.phase === 'card' || s.phase === 'card_choice';
  overlay.classList.toggle('show', show);
  if (!show) return;
  const pend = s.pending;
  const face = $('card-face');
  const isMahkama = (pend.deckType || (s.phase === 'card_choice' ? 'hazak' : '')) === 'mahkama';
  face.classList.toggle('mahkama', s.phase === 'card' ? pend.deckType === 'mahkama' : false);
  $('cf-deck').textContent = s.phase === 'card'
    ? (pend.deckType === 'mahkama' ? '⚖️ المحكمة' : '🍀 حظك')
    : '⚖️ اختر';
  $('cf-desc').textContent = s.phase === 'card' ? pend.card.description : pend.title;

  const choices = $('cf-choices');
  const okBtn = $('cf-ok');
  if (s.phase === 'card') {
    choices.innerHTML = '';
    const mine = pend.playerId === app.myId;
    okBtn.style.display = mine ? '' : 'none';
    okBtn.textContent = 'Apply ✓';
    okBtn.onclick = () => act({ type: 'reveal_card' });
    if (!mine) {
      const drawer = s.players.find(p => p.id === pend.playerId);
      choices.innerHTML = `<div style="font-size:0.8rem;color:var(--ink-soft)">${esc(drawer?.name || '')} drew this card…</div>`;
    }
  } else {
    okBtn.style.display = 'none';
    const mine = pend.playerId === app.myId;
    if (mine) {
      choices.innerHTML = '';
      pend.options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.textContent = opt.label;
        b.onclick = () => act({ type: 'card_choice', index: i });
        choices.appendChild(b);
      });
    } else {
      const chooser = s.players.find(p => p.id === pend.playerId);
      choices.innerHTML = `<div style="font-size:0.8rem;color:var(--ink-soft)">${esc(chooser?.name || '')} is choosing…</div>`;
    }
  }
}

// ── Trade ──

function openTradeBuilder(targetId) {
  app.tradeDraft = { toId: targetId, giveCash: 0, getCash: 0, giveProps: new Set(), getProps: new Set(), giveJail: 0, getJail: 0 };
  renderTradeOverlay(true);
}

function closeTradeOverlay() {
  app.tradeDraft = null;
  $('trade-overlay').classList.remove('show');
}

function renderTradeOverlay(force = false) {
  const s = app.state;
  const overlay = $('trade-overlay');
  const box = $('trade-box');

  // Incoming/outgoing live trade takes priority over local draft
  if (s?.trade) {
    overlay.classList.add('show');
    const t = s.trade;
    const from = s.players.find(p => p.id === t.fromId);
    const to = s.players.find(p => p.id === t.toId);
    const side = (label, cash, props, jail) => `
      <b>${label}</b>: ${cash ? `$${cash}` : ''} ${props.map(id => esc(sqById(id)?.name)).join('، ')} ${jail ? `🎟️×${jail}` : ''} ${!cash && !props.length && !jail ? '—' : ''}`;
    const summary = `
      <div class="trade-summary">
        ${side(`${esc(from?.name)} gives`, t.give.cash, t.give.props, t.give.jailCards)}<br/>
        ${side(`${esc(to?.name)} gives`, t.get.cash, t.get.props, t.get.jailCards)}
      </div>`;
    if (t.toId === app.myId) {
      box.innerHTML = `<h2>🤝 ${esc(from?.name)} proposes a trade</h2>${summary}
        <div class="trade-actions">
          <button class="act-btn green" id="tr-accept">✅ Accept</button>
          <button class="act-btn red" id="tr-decline">❌ Decline</button>
        </div>`;
      $('tr-accept').onclick = () => act({ type: 'respond_trade', accept: true });
      $('tr-decline').onclick = () => act({ type: 'respond_trade', accept: false });
    } else if (t.fromId === app.myId) {
      box.innerHTML = `<h2>🤝 Waiting for ${esc(to?.name)}…</h2>${summary}
        <div class="trade-actions"><button class="act-btn red" id="tr-cancel">Cancel trade</button></div>`;
      $('tr-cancel').onclick = () => act({ type: 'cancel_trade' });
    } else {
      overlay.classList.remove('show'); // spectators just see the log
    }
    return;
  }

  // Local draft builder
  if (!app.tradeDraft) { if (!force) overlay.classList.remove('show'); return; }
  const d = app.tradeDraft;
  const my = me();
  const them = s.players.find(p => p.id === d.toId);
  if (!them || them.isBankrupt) return closeTradeOverlay();

  const propList = (owner, set, prefix) => s.squares
    .filter(sq => sq.owner === owner.id && sq.type === 'property')
    .map(sq => `
      <div class="t-prop ${set.has(sq.id) ? 'sel' : ''} ${sq.level > 0 ? 'disabled' : ''}" data-${prefix}="${sq.id}" ${sq.level > 0 ? 'title="Sell buildings first"' : ''}>
        <span class="dot cg-${sq.color_group}"></span>${esc(sq.name)} ${sq.level > 0 ? `🏠×${sq.level}` : ''}
      </div>`).join('') || '<div style="font-size:0.7rem;color:var(--ink-soft)">No properties</div>';

  overlay.classList.add('show');
  box.innerHTML = `
    <h2>🤝 Trade with ${esc(them.name)}</h2>
    <div class="trade-cols">
      <div class="trade-col give">
        <h3>📤 You give</h3>
        <div class="t-cash">💰 $<input type="number" id="t-give-cash" min="0" max="${my.money}" value="${d.giveCash}" /></div>
        <div class="t-props">${propList(my, d.giveProps, 'give')}</div>
        ${my.jailFreeCards ? `<div class="t-jail">🎟️ Jail cards <input type="number" id="t-give-jail" min="0" max="${my.jailFreeCards}" value="${d.giveJail}" /></div>` : ''}
      </div>
      <div class="trade-col get">
        <h3>📥 You get</h3>
        <div class="t-cash">💰 $<input type="number" id="t-get-cash" min="0" ${them.money !== null ? `max="${them.money}"` : ''} value="${d.getCash}" /></div>
        <div class="t-props">${propList(them, d.getProps, 'get')}</div>
        ${them.jailFreeCards ? `<div class="t-jail">🎟️ Jail cards <input type="number" id="t-get-jail" min="0" max="${them.jailFreeCards}" value="${d.getJail}" /></div>` : ''}
      </div>
    </div>
    <div class="trade-actions">
      <button class="act-btn blue" id="t-send">📨 Send offer</button>
      <button class="act-btn gray" id="t-close">Cancel</button>
    </div>`;

  box.querySelectorAll('[data-give]').forEach(el => el.onclick = () => {
    const id = parseInt(el.dataset.give, 10);
    if (sqById(id).level > 0) return toast('Sell the buildings first', 'bad');
    d.giveProps.has(id) ? d.giveProps.delete(id) : d.giveProps.add(id);
    syncDraftInputs(); renderTradeOverlay(true);
  });
  box.querySelectorAll('[data-get]').forEach(el => el.onclick = () => {
    const id = parseInt(el.dataset.get, 10);
    if (sqById(id).level > 0) return toast('They must sell buildings first', 'bad');
    d.getProps.has(id) ? d.getProps.delete(id) : d.getProps.add(id);
    syncDraftInputs(); renderTradeOverlay(true);
  });
  $('t-send').onclick = () => {
    syncDraftInputs();
    act({
      type: 'propose_trade', toId: d.toId,
      give: { cash: d.giveCash, props: [...d.giveProps], jailCards: d.giveJail },
      get: { cash: d.getCash, props: [...d.getProps], jailCards: d.getJail },
    }, ok => { if (ok) { app.tradeDraft = null; } });
  };
  $('t-close').onclick = closeTradeOverlay;

  function syncDraftInputs() {
    d.giveCash = parseInt($('t-give-cash')?.value, 10) || 0;
    d.getCash = parseInt($('t-get-cash')?.value, 10) || 0;
    d.giveJail = parseInt($('t-give-jail')?.value, 10) || 0;
    d.getJail = parseInt($('t-get-jail')?.value, 10) || 0;
  }
}

// ── Game over ──

function renderGameOver() {
  const s = app.state;
  const overlay = $('gameover-overlay');
  if (!s.gameOver) { overlay.classList.remove('show'); return; }
  const winner = s.players.find(p => p.id === s.winnerId);
  overlay.classList.add('show');
  $('gameover-box').innerHTML = `
    <div class="go-title">🏆</div>
    ${winner ? `<img src="${pfp(winner.avatar)}" /><div class="go-title">${esc(winner.name)} wins!</div>` : '<div class="go-title">Game over</div>'}
    <button class="big-btn" onclick="location.reload()">🔄 Back to lobby</button>`;
}

// ═══════════════ Utilities ═══════════════

function act(action, cb) {
  socket.emit('action', action, r => {
    if (!r.ok && r.error) toast(errorText(r.error), 'bad');
    if (cb) cb(r.ok);
  });
}

const ERRORS = {
  insufficient_funds: "💸 Not enough money",
  need_full_set: '🎨 You need the full color set to build',
  build_evenly: '⚖️ Build evenly across the set',
  sell_evenly: '⚖️ Sell evenly across the set',
  has_buildings: '🏠 Sell the buildings first',
  not_your_turn: "⏳ It's not your turn",
  wrong_phase: '⏳ Not right now',
  trade_in_progress: '🤝 Finish the current trade first',
  empty_trade: '🤝 The trade is empty',
  max_level: '🏬 Already at maximum',
  cannot_build_here: '🚫 Nothing can be built here',
};
function errorText(code) { return ERRORS[code] || `⚠️ ${code}`; }

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5300);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bigFloat(text, loss = false) {
  const el = document.createElement('div');
  el.className = `big-float ${loss ? 'loss' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

$('btn-mute').onclick = () => { $('btn-mute').textContent = toggleMute() ? '🔇' : '🔊'; };
window.addEventListener('board:resize', () => { if (app.state) renderTokens(app.state); });

initLobby();
