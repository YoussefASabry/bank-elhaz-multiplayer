/**
 * Persisted "highest restored `stateVersion` per room" — the anti-replay gate
 * behind snapshot restore (see snapshot.ts, bug B19, plan §4a). A snapshot can
 * only be restored if its `stateVersion` is strictly greater than the highest
 * one this room has ever restored, which is what makes replaying an older,
 * richer snapshot impossible.
 *
 * Written synchronously on every bump: a crash can lose at most the most
 * recent bump, so the worst case is one legitimate restore wrongly rejected as
 * stale, never a replay wrongly accepted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionStore {
  getHighest(roomCode: string): number;
  /**
   * Records `version` as seen for `roomCode` if it is higher than what is
   * already stored, persisting synchronously. No-op (and no write) otherwise.
   */
  recordSeen(roomCode: string, version: number): void;
}

function readVersions(filePath: string): Record<string, number> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    const versions: Record<string, number> = {};
    if (parsed !== null && typeof parsed === 'object') {
      for (const [room, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number') versions[room] = v;
      }
    }
    return versions;
  } catch {
    // Corrupt file: start clean rather than crash the process. Worst case is
    // one rejected legitimate restore, never an accepted replay.
    return {};
  }
}

export function loadVersionStore(dataDir = '.data'): VersionStore {
  const filePath = join(dataDir, 'versions.json');
  const versions = readVersions(filePath);

  function persist(): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(versions), 'utf8');
  }

  return {
    getHighest(roomCode: string): number {
      return versions[roomCode] ?? 0;
    },
    recordSeen(roomCode: string, version: number): void {
      const current = versions[roomCode] ?? 0;
      if (version > current) {
        versions[roomCode] = version;
        persist();
      }
    },
  };
}
