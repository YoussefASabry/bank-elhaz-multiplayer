// Tiny WebAudio synth — no audio assets needed.
let ctx = null;
let muted = localStorage.getItem('beh_muted') === '1';

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur = 0.12, type = 'sine', vol = 0.18, when = 0) {
  if (muted) return;
  try {
    const a = ac();
    const t = a.currentTime + when;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch { /* audio unavailable */ }
}

export const sounds = {
  dice() { for (let i = 0; i < 5; i++) tone(300 + Math.random() * 500, 0.05, 'square', 0.08, i * 0.06); },
  step() { tone(650, 0.045, 'sine', 0.07); },
  buy() { tone(523, 0.1, 'triangle', 0.2); tone(659, 0.1, 'triangle', 0.2, 0.09); tone(784, 0.16, 'triangle', 0.2, 0.18); },
  cash() { tone(880, 0.07, 'triangle', 0.16); tone(1175, 0.1, 'triangle', 0.16, 0.06); },
  pay() { tone(392, 0.1, 'sawtooth', 0.1); tone(294, 0.16, 'sawtooth', 0.1, 0.09); },
  card() { tone(700, 0.06, 'triangle', 0.14); tone(950, 0.09, 'triangle', 0.14, 0.07); },
  jail() { tone(220, 0.2, 'sawtooth', 0.14); tone(165, 0.3, 'sawtooth', 0.14, 0.18); },
  gavel() { tone(180, 0.08, 'square', 0.2); tone(120, 0.12, 'square', 0.18, 0.09); },
  trade() { tone(587, 0.08, 'triangle', 0.15); tone(740, 0.08, 'triangle', 0.15, 0.08); tone(880, 0.12, 'triangle', 0.15, 0.16); },
  turn() { tone(520, 0.08, 'sine', 0.12); tone(660, 0.1, 'sine', 0.12, 0.08); },
  bankrupt() { [392, 370, 349, 330].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.14, i * 0.2)); },
  win() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.2, i * 0.14)); },
  tick() { tone(1000, 0.03, 'square', 0.05); },
};

export function toggleMute() {
  muted = !muted;
  localStorage.setItem('beh_muted', muted ? '1' : '0');
  return muted;
}
export function isMuted() { return muted; }
