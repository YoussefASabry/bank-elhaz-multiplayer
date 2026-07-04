// Board rendering: 34 cells around an 11×8 CSS grid + center hub + token layer.
import { sounds } from './sounds.js';

// position id → [gridColumn, gridRow]
const GRID = {
  1: [1, 8], 2: [1, 7], 3: [1, 6], 4: [1, 5], 5: [1, 4], 6: [1, 3], 7: [1, 2], 8: [1, 1],
  9: [2, 1], 10: [3, 1], 11: [4, 1], 12: [5, 1], 13: [6, 1], 14: [7, 1], 15: [8, 1], 16: [9, 1], 17: [10, 1],
  18: [11, 1], 19: [11, 2], 20: [11, 3], 21: [11, 4], 22: [11, 5], 23: [11, 6], 24: [11, 7], 25: [11, 8],
  26: [10, 8], 27: [9, 8], 28: [8, 8], 29: [7, 8], 30: [6, 8], 31: [5, 8], 32: [4, 8], 33: [3, 8], 34: [2, 8],
};

const CORNER_ICONS = { 1: '🏁', 8: '🎰', 18: '🚌', 25: '🔒' };
const PLAYER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00'];

export const pfp = n => `/assets/pfps/avatar${n || 1}.svg`;
export const playerColor = i => PLAYER_COLORS[i % PLAYER_COLORS.length];

const boardEl = () => document.getElementById('board');
const tokenLayer = () => document.getElementById('token-layer');

export function buildBoard(squares, { onCellClick }) {
  const board = boardEl();
  board.innerHTML = '';
  for (const sq of squares) {
    const [col, row] = GRID[sq.id];
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.id = sq.id;
    cell.style.gridColumn = col;
    cell.style.gridRow = row;
    if (sq.type === 'property') {
      cell.innerHTML = `
        <div class="color-bar cg-${sq.color_group}"></div>
        <div class="cname">${sq.name}</div>
        <div class="cprice">$${sq.purchase_price}</div>
        <div class="buildings"></div>
        <div class="owner-strip" style="display:none"></div>`;
    } else if (sq.type === 'corner_square') {
      cell.className = 'cell corner';
      cell.innerHTML = `<div class="cicon">${CORNER_ICONS[sq.id] || '★'}</div><div class="cname">${sq.name}</div>`;
    } else {
      cell.className = 'cell deck';
      const icon = sq.type === 'dual_deck_trigger' ? '⚖️🍀' : (sq.deck_type === 'mahkama' ? '⚖️' : '🍀');
      cell.innerHTML = `<div class="cicon">${icon}</div><div class="cname">${sq.name}</div>`;
    }
    cell.addEventListener('click', () => onCellClick(sq.id));
    board.appendChild(cell);
  }
  const center = document.createElement('div');
  center.id = 'center';
  center.style.gridColumn = '2 / 11';
  center.style.gridRow = '2 / 8';
  center.innerHTML = `
    <h2>🏦 بنك الحظ</h2>
    <div class="dice-row"><div class="die" id="die1">?</div><div class="die" id="die2">?</div></div>
    <div class="roll-hint" id="roll-hint"></div>
    <button id="roll-btn" style="display:none">🎲 Roll</button>
    <div class="deck-stats" id="deck-stats"></div>`;
  board.appendChild(center);
}

export function updateCells(state, myId, selectedId) {
  for (const sq of state.squares) {
    const cell = boardEl().querySelector(`.cell[data-id="${sq.id}"]`);
    if (!cell) continue;
    cell.classList.toggle('selected', sq.id === selectedId);
    if (sq.type !== 'property') continue;
    const ownerIdx = state.players.findIndex(p => p.id === sq.owner);
    const strip = cell.querySelector('.owner-strip');
    if (ownerIdx >= 0) {
      strip.style.display = 'block';
      strip.style.background = playerColor(ownerIdx);
    } else {
      strip.style.display = 'none';
    }
    const b = cell.querySelector('.buildings');
    b.textContent = sq.level >= 3 ? '🏬' : '🏠'.repeat(sq.level || 0);
  }
  const ds = document.getElementById('deck-stats');
  if (ds) ds.textContent = `🍀 ${state.deckCounts.hazak} · ⚖️ ${state.deckCounts.mahkama}`;
}

export function showDice(roll) {
  const d1 = document.getElementById('die1'), d2 = document.getElementById('die2');
  if (!d1) return;
  const faces = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  d1.textContent = faces[roll.die1] || roll.die1;
  d2.style.display = roll.die2 ? '' : 'none';
  d2.textContent = faces[roll.die2] || roll.die2;
  d1.classList.remove('spin'); d2.classList.remove('spin');
  void d1.offsetWidth;
  d1.classList.add('spin'); d2.classList.add('spin');
}

// ── Tokens ──

function cellCenter(posId, slot = 0, count = 1) {
  const cell = boardEl().querySelector(`.cell[data-id="${posId}"]`);
  const wrap = document.getElementById('board-wrap');
  if (!cell) return { x: 0, y: 0 };
  const c = cell.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  // Spread multiple tokens on the same square
  const spread = Math.min(c.width / 4, 12);
  const off = count > 1 ? (slot - (count - 1) / 2) * spread : 0;
  return { x: c.left - w.left + c.width / 2 + off, y: c.top - w.top + c.height * 0.62 };
}

export function renderTokens(state) {
  const layer = tokenLayer();
  for (const [i, p] of state.players.entries()) {
    let tok = layer.querySelector(`.token[data-pid="${p.id}"]`);
    if (p.isBankrupt) { tok?.remove(); continue; }
    if (!tok) {
      tok = document.createElement('div');
      tok.className = 'token';
      tok.dataset.pid = p.id;
      tok.innerHTML = `<img src="${pfp(p.avatar)}" alt="${p.name}" title="${p.name}" />`;
      layer.appendChild(tok);
    }
    tok.style.borderColor = p.id === state.currentPlayerId ? '#ffd700' : playerColor(i);
    tok.classList.toggle('current', p.id === state.currentPlayerId);
    tok.classList.toggle('jailed', p.inJail);
    if (!tok.dataset.animating) placeToken(tok, p.position, state, p.id);
  }
  // remove tokens of players no longer present
  for (const tok of [...layer.children]) {
    if (!state.players.some(p => p.id === tok.dataset.pid && !p.isBankrupt)) tok.remove();
  }
}

function placeToken(tok, posId, state, pid) {
  const here = state.players.filter(p => !p.isBankrupt && p.position === posId);
  const slot = here.findIndex(p => p.id === pid);
  const { x, y } = cellCenter(posId, Math.max(slot, 0), here.length);
  tok.style.left = `${x}px`;
  tok.style.top = `${y}px`;
}

// Animate along a path, then resolve. ~180ms per tile.
export function animateToken(state, playerId, path) {
  return new Promise(resolve => {
    const tok = tokenLayer().querySelector(`.token[data-pid="${playerId}"]`);
    if (!tok || !path?.length) return resolve();
    tok.dataset.animating = '1';
    let i = 0;
    const stepMs = Math.max(240, Math.min(340, 3600 / path.length));
    const step = () => {
      if (i >= path.length) {
        delete tok.dataset.animating;
        flashCell(path[path.length - 1]);
        return resolve();
      }
      const { x, y } = cellCenter(path[i]);
      tok.style.left = `${x}px`;
      tok.style.top = `${y}px`;
      sounds.step();
      i++;
      setTimeout(step, stepMs);
    };
    step();
  });
}

export function flashCell(id) {
  const cell = boardEl().querySelector(`.cell[data-id="${id}"]`);
  if (!cell) return;
  cell.classList.remove('flash');
  void cell.offsetWidth;
  cell.classList.add('flash');
}

// Reposition tokens on window resize
window.addEventListener('resize', () => {
  const ev = new CustomEvent('board:resize');
  window.dispatchEvent(ev);
});
