import type { SignedSnapshot } from '../shared/events';

export interface Session {
  roomCode: string;
  seatToken: string;
  savedAt: number;
}

export interface SaveBlob extends Session {
  snapshot: SignedSnapshot | null;
  version: number;
}

const SESSION_KEY = 'bankelhaz_session';
const PREF_KEY = 'bankelhaz_prefs';
const SNAPSHOT_KEY = 'bankelhaz_snapshot';

export interface ClientPrefs {
  name: string;
  avatar: number;
  theme: string;
}

const DEFAULT_PREFS: ClientPrefs = { name: 'Player 1', avatar: 1, theme: 'plain' };

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.roomCode !== 'string' || typeof parsed.seatToken !== 'string') return null;
    return { roomCode: parsed.roomCode, seatToken: parsed.seatToken, savedAt: Number(parsed.savedAt) || Date.now() };
  } catch {
    return null;
  }
}

export function saveSession(roomCode: string, seatToken: string): void {
  const session: Session = { roomCode, seatToken, savedAt: Date.now() };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable — rejoin just won't be automatic */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function loadPrefs(): ClientPrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ClientPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: ClientPrefs): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function loadSnapshot(): SignedSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SignedSnapshot>;
    if (parsed.v !== 1 || typeof parsed.payload !== 'string' || typeof parsed.sig !== 'string') return null;
    return parsed as SignedSnapshot;
  } catch {
    return null;
  }
}

export function saveSnapshot(snapshot: SignedSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

export function downloadSave(session: Session, snapshot: SignedSnapshot | null): void {
  const blob: SaveBlob = { ...session, snapshot, version: 1 };
  const url = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `bank-elhaz-${session.roomCode}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function parseSaveFile(text: string): SaveBlob | null {
  try {
    const parsed = JSON.parse(text) as Partial<SaveBlob>;
    if (typeof parsed.roomCode !== 'string' || typeof parsed.seatToken !== 'string') return null;
    if (parsed.snapshot !== null && parsed.snapshot !== undefined) {
      const snap = parsed.snapshot as SignedSnapshot;
      if (snap.v !== 1 || typeof snap.payload !== 'string' || typeof snap.sig !== 'string') return null;
    }
    return parsed as SaveBlob;
  } catch {
    return null;
  }
}
