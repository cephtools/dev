// Compact per-run snapshots of trending ranks and scores, used to show rank movement
// ("↑ 12 since yesterday") and kept for later baseline analysis.

import { existsSync, readFileSync } from 'node:fs';
import { DAY_MS, HOUR_MS } from '../util/time.ts';
import { writeJsonAtomic } from '../util/fs.ts';

export interface Snapshot {
  at: string;
  /** PR number → [trending rank or 0 when unranked, trending score, technical score] */
  prs: Record<string, [number, number, number]>;
}

export interface History {
  version: 1;
  snapshots: Snapshot[];
}

export function loadHistory(path: string): History {
  if (!existsSync(path)) return { version: 1, snapshots: [] };
  const h = JSON.parse(readFileSync(path, 'utf8')) as History;
  return h.version === 1 && Array.isArray(h.snapshots) ? h : { version: 1, snapshots: [] };
}

export function saveHistory(path: string, history: History): void {
  writeJsonAtomic(path, history, false);
}

/**
 * Pick the snapshot to compare against: the newest one at least `targetHours` old,
 * falling back to the oldest snapshot we have (so a young deployment still shows movement).
 */
export function comparisonSnapshot(history: History, now: Date, targetHours = 20): Snapshot | null {
  const sorted = [...history.snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const cutoff = now.getTime() - targetHours * HOUR_MS;
  const older = sorted.filter((s) => Date.parse(s.at) <= cutoff);
  return older[older.length - 1] ?? sorted[0] ?? null;
}

export function appendSnapshot(history: History, snapshot: Snapshot, now: Date, retentionDays: number): History {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const snapshots = [...history.snapshots.filter((s) => Date.parse(s.at) >= cutoff && s.at !== snapshot.at), snapshot];
  return { version: 1, snapshots };
}
