import type { RoomOptions, LobbyMember } from '../shared/events';
import type { RawColorGroup } from '../shared/raw';
import type { ClientPrefs } from './session';
import { COLOR_BG_MAP, CORNER_ICONS, edgeClass, BOARD_W, BOARD_H, pfpUrl } from './constants';
import { byId, el, escapeHtml } from './dom';
import { themeList } from './theme';
import boardData from '../../data/board.json';

const previewSquares = boardData.board_positions;

export interface LobbyApi {
  getPrefs: () => ClientPrefs;
  setPrefs: (prefs: ClientPrefs) => void;
  host: (name: string, avatar: number, options: RoomOptions) => void;
  join: (roomCode: string, name: string, avatar: number) => void;
  leaveRoom: () => void;
  startGame: () => void;
  resume: () => void;
  exportSave: () => void;
  importSave: (file: File) => void;
  hasSnapshot: () => boolean;
  updateConnected: (connected: boolean) => void;
  isConnected: () => boolean;
}

let api: LobbyApi | null = null;
let activeTab: 'host' | 'join' = 'host';
let selectedAvatarHost = 1;
let selectedAvatarJoin = 1;
let isHost = false;
let pendingAction: 'host' | 'join' | null = null;

const OPTION_HTML = `
<div style="text-align:left;margin-top:12px;border-top:1px solid #6a4a1a;padding-top:10px;">
  <label style="font-size:0.8rem;margin:0 0 4px;">🎲 Host Options</label>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">Starting Cash</label>
    <input type="number" id="opt-starting-cash" value="1500" min="500" max="5000" step="100" style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;" />
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">Pass-Go Salary</label>
    <input type="number" id="opt-passgo-salary" value="250" min="0" max="1000" step="50" style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;" />
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">Dice</label>
    <select id="opt-dice-count" style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;">
      <option value="2" selected>Two Dice</option>
      <option value="1">One Die</option>
    </select>
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">Show Money</label>
    <select id="opt-money-visibility" style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;">
      <option value="visible" selected>Visible</option>
      <option value="hidden">Hidden</option>
    </select>
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">🤝 Trade Timing</label>
    <select id="opt-trade-timing" style="width:90px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;">
      <option value="anytime" selected>Any Turn</option>
      <option value="own_turn">Your Turn Only</option>
    </select>
  </div>
</div>`;

function pfpGridHtml(prefix: 'host' | 'join', prefs: ClientPrefs): string {
  const selected = prefix === 'host' ? selectedAvatarHost : selectedAvatarJoin;
  let html = '';
  for (let i = 1; i <= 20; i++) {
    html +=
      `<div class="pfp-option${i === selected ? ' selected' : ''}" data-avatar="${i}" data-prefix="${prefix}">` +
      `<img src="${pfpUrl(i)}" alt="avatar ${i}" loading="lazy" /></div>`;
  }
  return html;
}

function themeSelectHtml(prefix: 'host' | 'join', prefs: ClientPrefs): string {
  const themes = themeList();
  return themes
    .map((t) => `<option value="${t}"${t === prefs.theme ? ' selected' : ''}>${t === 'plain' ? 'Plain' : t}</option>`)
    .join('');
}

export function renderLobby(prefs: ClientPrefs, connected: boolean): void {
  const screen = byId('lobby-screen');
  if (!screen) return;
  pendingAction = null;
  if (prefs.avatar >= 1 && prefs.avatar <= 20) {
    selectedAvatarHost = prefs.avatar;
    selectedAvatarJoin = prefs.avatar;
  } else {
    selectedAvatarHost = 1;
    selectedAvatarJoin = 1;
  }
  screen.innerHTML = `
<h1>🏦 بنك الحظ</h1>
<div class="subtitle">Bank El Haz — Online Multiplayer</div>
<div id="socket-status" style="position:relative;margin-bottom:10px;padding:6px;border-radius:8px;font-size:0.8rem;font-weight:bold;background:#e74c3c;color:#fff;display:none;">🔴 Connecting to server...</div>
<div class="lobby-tabs">
  <button id="tab-host" class="active" type="button">🎮 Host Game</button>
  <button id="tab-join" type="button">🔗 Join Game</button>
</div>
<div id="panel-host" class="lobby-panel show">
  <label>Your Name</label>
  <input type="text" id="host-name" value="${escapeHtml(prefs.name)}" maxlength="20" />
  <div class="pfp-picker-label">Choose Your Avatar</div>
  <div class="pfp-grid" id="pfp-grid-host">${pfpGridHtml('host', prefs)}</div>
  ${OPTION_HTML}
  <div style="display:flex;gap:8px;align-items:center;margin-top:10px;border-top:1px solid #c4a96a;padding-top:10px;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">🎨 My Theme</label>
    <select id="theme-host" style="width:120px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;">${themeSelectHtml('host', prefs)}</select>
    <button id="btn-preview-host" type="button" style="padding:4px 10px;border-radius:6px;border:1px solid #c4a96a;background:#faf0dc;color:#3a2a1a;font-size:0.8rem;cursor:pointer;">👁️</button>
  </div>
  <button class="lobby-btn" id="btn-host" type="button">🎮 Create Room</button>
  <div class="lobby-error" id="lobby-error-host"></div>
</div>
<div id="panel-join" class="lobby-panel">
  <label>Your Name</label>
  <input type="text" id="join-name" value="${escapeHtml(prefs.name)}" maxlength="20" />
  <label>Room Code</label>
  <input type="text" id="join-code" placeholder="e.g. ABCD" maxlength="4" style="text-transform:uppercase;letter-spacing:4px;font-size:1.3rem;font-weight:bold;" />
  <div class="pfp-picker-label">Choose Your Avatar</div>
  <div class="pfp-grid" id="pfp-grid-join">${pfpGridHtml('join', prefs)}</div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:10px;border-top:1px solid #c4a96a;padding-top:10px;">
    <label style="font-size:0.75rem;color:#7a5a3a;flex:1;">🎨 My Theme</label>
    <select id="theme-join" style="width:120px;padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#fff;color:#3a2a1a;font-size:0.85rem;">${themeSelectHtml('join', prefs)}</select>
    <button id="btn-preview-join" type="button" style="padding:4px 8px;border-radius:6px;border:1px solid #c4a96a;background:#faf0dc;color:#3a2a1a;font-size:0.8rem;cursor:pointer;">👁️</button>
  </div>
  <button class="lobby-btn" id="btn-join" type="button">🔗 Join Room</button>
  <div class="lobby-error" id="lobby-error-join"></div>
</div>
<div id="room-waiting" style="display:none;"></div>
<div id="save-row" style="margin-top:16px;border-top:2px solid #c4a96a;padding-top:12px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
  <button id="btn-restore-game" type="button" style="display:none;padding:8px 20px;border-radius:10px;border:2px solid #1b5e20;background:#43a047;color:#fff;font-size:0.95rem;cursor:pointer;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.2);">💾 Resume Game</button>
  <button id="btn-export-save" type="button" style="padding:6px 16px;border-radius:8px;border:1px solid #c4a96a;background:#faf0dc;color:#5a3a0a;font-size:0.8rem;cursor:pointer;">📥 Export</button>
  <button id="btn-import-save" type="button" style="padding:6px 16px;border-radius:8px;border:1px solid #c4a96a;background:#faf0dc;color:#5a3a0a;font-size:0.8rem;cursor:pointer;">📤 Import</button>
  <input type="file" id="import-file-input" accept=".json" style="display:none" />
</div>`;

  updateConnected(connected);
  if (api?.hasSnapshot()) {
    const resume = byId('btn-restore-game');
    if (resume) resume.style.display = '';
  }
  wireLobby(prefs);
}

function wireLobby(prefs: ClientPrefs): void {
  byId('tab-host')?.addEventListener('click', () => switchTab('host'));
  byId('tab-join')?.addEventListener('click', () => switchTab('join'));

  const bindAvatarGrid = (prefix: 'host' | 'join') => {
    const grid = byId(`pfp-grid-${prefix}`);
    grid?.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('.pfp-option[data-avatar]');
      if (!target) return;
      const avatar = Number(target.dataset.avatar);
      if (prefix === 'host') selectedAvatarHost = avatar;
      else selectedAvatarJoin = avatar;
      const prefs2 = { ...api!.getPrefs(), avatar };
      api!.setPrefs(prefs2);
      grid.querySelectorAll('.pfp-option').forEach((o) => o.classList.toggle('selected', o === target));
    });
  };
  bindAvatarGrid('host');
  bindAvatarGrid('join');

  const bindTheme = (prefix: 'host' | 'join') => {
    const sel = byId(`theme-${prefix}`) as HTMLSelectElement | null;
    sel?.addEventListener('change', () => {
      const prefs2 = { ...api!.getPrefs(), theme: sel.value };
      api!.setPrefs(prefs2);
    });
    byId(`btn-preview-${prefix}`)?.addEventListener('click', () => {
      openPreview(sel?.value ?? 'plain');
    });
  };
  bindTheme('host');
  bindTheme('join');

  byId('btn-host')?.addEventListener('click', () => {
    const name = (byId('host-name') as HTMLInputElement)?.value.trim() || 'Player 1';
    const avatar = selectedAvatarHost;
    api!.setPrefs({ ...api!.getPrefs(), name });
    if (!api!.isConnected()) {
      setLobbyError('host', 'Not connected to server — is `npm run server` running?');
      return;
    }
    setPending('host');
    api!.host(name, avatar, readOptions());
  });

  byId('btn-join')?.addEventListener('click', () => {
    const name = (byId('join-name') as HTMLInputElement)?.value.trim() || 'Player 2';
    const code = ((byId('join-code') as HTMLInputElement)?.value ?? '').toUpperCase().trim();
    const avatar = selectedAvatarJoin;
    if (code.length < 2) {
      setLobbyError('join', 'Enter a room code');
      return;
    }
    api!.setPrefs({ ...api!.getPrefs(), name });
    if (!api!.isConnected()) {
      setLobbyError('join', 'Not connected to server — is `npm run server` running?');
      return;
    }
    setPending('join');
    api!.join(code, name, avatar);
  });

  byId('btn-restore-game')?.addEventListener('click', () => api?.resume());
  byId('btn-export-save')?.addEventListener('click', () => api?.exportSave());
  byId('btn-import-save')?.addEventListener('click', () => byId('import-file-input')?.click());
  byId('import-file-input')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) api?.importSave(file);
    (e.target as HTMLInputElement).value = '';
  });
}

function readOptions(): RoomOptions {
  const cash = Number((byId('opt-starting-cash') as HTMLInputElement)?.value) || 1500;
  const salary = Number((byId('opt-passgo-salary') as HTMLInputElement)?.value) || 250;
  const dice = (byId('opt-dice-count') as HTMLSelectElement)?.value === '1' ? 1 : 2;
  const moneyVisible = (byId('opt-money-visibility') as HTMLSelectElement)?.value !== 'hidden';
  const tradeTiming = ((byId('opt-trade-timing') as HTMLSelectElement)?.value ?? 'anytime') as 'anytime' | 'own_turn';
  return {
    startingCash: cash,
    passGoSalary: salary,
    diceCount: dice,
    moneyVisible,
    tradeTiming,
    onBankruptcy: 'eliminate',
  };
}

export function switchTab(tab: 'host' | 'join'): void {
  activeTab = tab;
  byId('tab-host')?.classList.toggle('active', tab === 'host');
  byId('tab-join')?.classList.toggle('active', tab === 'join');
  byId('panel-host')?.classList.toggle('show', tab === 'host');
  byId('panel-join')?.classList.toggle('show', tab === 'join');
}

export function updateConnected(connected: boolean): void {
  const status = byId('socket-status');
  if (!status) return;
  if (connected) {
    status.style.display = 'none';
  } else {
    status.style.display = 'block';
    status.textContent = '🔴 Disconnected from server — start the server with: npm run server';
  }
}

function memberRows(members: LobbyMember[]): string {
  return members
    .map(
      (m) =>
        `<div class="lp-item">
          <img src="${pfpUrl(m.avatar)}" alt="" loading="lazy" />
          <span class="lp-name">${escapeHtml(m.name)}${m.connected ? '' : ' 🔴'}</span>
          ${m.isHost ? '<span class="lp-host">👑 Host</span>' : ''}
        </div>`,
    )
    .join('');
}

export function showWaiting(roomCode: string, members: LobbyMember[], isHostPlayer: boolean): void {
  isHost = isHostPlayer;
  const waiting = byId('room-waiting');
  if (!waiting) return;
  waiting.innerHTML = `
<div style="margin-top:16px;border-top:2px solid #c4a96a;padding-top:16px;">
  <p style="font-size:0.85rem;color:#7a5a3a;">Share this code with friends:</p>
  <div class="room-code-display" id="room-code-display">${escapeHtml(roomCode)}</div>
  <div class="lobby-players" id="lobby-player-list">${memberRows(members)}</div>
  <button class="lobby-btn" id="btn-start-game" type="button" ${isHostPlayer && members.length >= 2 ? '' : 'disabled'}>${startBtnLabel(isHostPlayer, members.length)}</button>
  <button class="lobby-btn" id="btn-leave-room" type="button" style="background:linear-gradient(135deg,#c0392b,#922b21);margin-top:4px;">🚪 Leave Room</button>
</div>`;
  waiting.style.display = 'block';
  byId('btn-start-game')?.addEventListener('click', () => api?.startGame());
  byId('btn-leave-room')?.addEventListener('click', () => api?.leaveRoom());
}

function startBtnLabel(isHostPlayer: boolean, count: number): string {
  if (!isHostPlayer) return '⏳ Waiting for host to start...';
  if (count < 2) return '⏳ Waiting for players...';
  return '▶️ Start Game';
}

export function updateWaitingMembers(members: LobbyMember[]): void {
  const list = byId('lobby-player-list');
  if (!list) return;
  list.innerHTML = memberRows(members);
  const startBtn = byId('btn-start-game') as HTMLButtonElement | null;
  if (startBtn) {
    startBtn.disabled = !isHost || members.length < 2;
    startBtn.textContent = startBtnLabel(isHost, members.length);
  }
}

export function setLobbyError(tab: 'host' | 'join', message: string): void {
  const err = byId(tab === 'host' ? 'lobby-error-host' : 'lobby-error-join');
  if (err) err.textContent = message;
  if (pendingAction === tab) setPending(null);
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function setPending(tab: 'host' | 'join' | null): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingAction = tab;
  const hostBtn = byId('btn-host') as HTMLButtonElement | null;
  const joinBtn = byId('btn-join') as HTMLButtonElement | null;
  if (hostBtn) hostBtn.disabled = tab === 'host';
  if (joinBtn) joinBtn.disabled = tab === 'join';
  if (tab) {
    pendingTimer = setTimeout(() => {
      if (pendingAction === tab) {
        setLobbyError(tab, 'Server not responding — try again');
        setPending(null);
      }
    }, 8000);
  }
}

export function clearLobbyErrors(): void {
  const a = byId('lobby-error-host');
  const b = byId('lobby-error-join');
  if (a) a.textContent = '';
  if (b) b.textContent = '';
}

function openPreview(theme: string): void {
  const overlay = el('div', 'modal-overlay');
  overlay.id = 'preview-modal';
  const box = el('div', 'preview-box');
  const close = el('button', 'preview-close', '✕');
  close.type = 'button';
  close.addEventListener('click', () => overlay.remove());
  const board = el('div', 'preview-board');
  board.style.cssText = 'transform-origin:top left;';
  box.appendChild(close);
  box.appendChild(board);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.classList.add('show');

  board.style.cssText =
    'display:grid;grid-template-columns:110px 85px 85px 85px 85px 110px 85px 85px 85px 85px 110px;' +
    'grid-template-rows:120px repeat(6,75px) 120px;gap:3px;background:#d4a853;' +
    'border:4px solid #8B6914;border-radius:14px;padding:5px;transform-origin:top left;';
  for (const sq of previewSquares) {
    const cell = el('div', `cell ${sq.type} p${sq.id} ${edgeClass(sq.id)}`);
    if (sq.color_group) cell.classList.add(sq.color_group);
    if (CORNER_ICONS[sq.id]) {
      cell.innerHTML = `<div class="corner-icon">${CORNER_ICONS[sq.id]}</div><div class="corner-name">${escapeHtml(sq.name)}</div>`;
    } else if (sq.type === 'property') {
      const colorBg = sq.color_group ? COLOR_BG_MAP[sq.color_group as RawColorGroup] : '#607d8b';
      const colorSection = el('div', `cell-section cell-color-section cell-color ${sq.color_group ?? ''}`);
      colorSection.style.background = colorBg;
      colorSection.style.fontSize = '0.65rem';
      colorSection.style.padding = '2px 4px';
      const city = el('div', 'cell-section cell-city', sq.name);
      const price = el('div', 'cell-section cell-price-section', sq.purchase_price ? `$${sq.purchase_price}` : '');
      const bottom = el('div', 'cell-section cell-bottom-section');
      cell.appendChild(colorSection);
      cell.appendChild(city);
      cell.appendChild(price);
      cell.appendChild(bottom);
    } else if (sq.type === 'deck_trigger' || sq.type === 'dual_deck_trigger') {
      const label = el('div', 'cell-section deck-label');
      label.textContent = sq.id === 4 ? '⚖️🍀' : sq.id === 11 || sq.id === 21 || sq.id === 32 ? '⚖️' : '🍀';
      const name = el('div', 'cell-section', sq.name);
      name.style.cssText = 'font-size:0.6rem;color:#6a4a1a;';
      cell.appendChild(label);
      cell.appendChild(name);
    }
    board.appendChild(cell);
  }
  const center = el('div', 'center-cell');
  const title = el('div', 'cc-title', '🏦 بنك الحظ');
  center.appendChild(title);
  board.appendChild(center);

  const fit = () => {
    const boxStyle = getComputedStyle(box);
    const padX = parseFloat(boxStyle.paddingLeft) + parseFloat(boxStyle.paddingRight);
    const padY = parseFloat(boxStyle.paddingTop) + parseFloat(boxStyle.paddingBottom);
    const availW = box.clientWidth - padX;
    const availH = box.clientHeight - padY;
    if (availW <= 0 || availH <= 0) return;
    const s = Math.min(availW / BOARD_W, availH / BOARD_H, 1);
    board.style.transform = `scale(${Math.max(s, 0.2)})`;
  };
  requestAnimationFrame(fit);
}

export function initLobby(opts: LobbyApi): void {
  api = opts;
}
