// Persistent per-PR cache. Lets each run fetch details only for PRs that changed,
// and accumulates event history beyond GitHub's per-connection limits.

import { existsSync, readFileSync } from 'node:fs';
import type { ActivityEvent, PrRecord } from '../types.ts';
import { DAY_MS } from '../util/time.ts';
import { dedupeEvents } from './normalize.ts';
import { writeJsonAtomic } from '../util/fs.ts';

export const CACHE_VERSION = 1;

export interface PrCache {
  version: number;
  records: Record<string, PrRecord>;
}

export function emptyCache(): PrCache {
  return { version: CACHE_VERSION, records: {} };
}

export function loadCache(path: string): PrCache {
  if (!existsSync(path)) return emptyCache();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrCache;
  // An incompatible cache is discarded rather than misread; the next runs rebuild it.
  if (parsed.version !== CACHE_VERSION || typeof parsed.records !== 'object') return emptyCache();
  return parsed;
}

export function saveCache(path: string, cache: PrCache): void {
  writeJsonAtomic(path, cache, false);
}

/**
 * Merge a freshly fetched record with its cached predecessor.
 *
 * Fresh events always win. Cached events are kept only where the fresh fetch was
 * truncated (older than `fresh.eventsCompleteSince`), so deleted comments disappear
 * once a fetch covers their time range. Completeness is tracked conservatively: the
 * union is complete back to the cached coverage only if the cached fetch overlaps the
 * fresh one's truncation point.
 */
export function mergeRecord(cached: PrRecord | undefined, fresh: PrRecord, now: Date, retentionDays: number): PrRecord {
  let events: ActivityEvent[] = fresh.events;
  let completeSince = fresh.eventsCompleteSince;

  if (cached && cached.detail === 'full' && fresh.eventsCompleteSince) {
    const cutoff = Date.parse(fresh.eventsCompleteSince);
    const older = cached.events.filter((e) => Date.parse(e.at) < cutoff);
    events = dedupeEvents([...older, ...fresh.events]);
    const overlaps = cached.fetchedAt !== null && Date.parse(cached.fetchedAt) >= cutoff;
    completeSince = overlaps ? cached.eventsCompleteSince : fresh.eventsCompleteSince;
  }

  const retentionCutoff = now.getTime() - retentionDays * DAY_MS;
  const retained = events.filter((e) => Date.parse(e.at) >= retentionCutoff);
  if (retained.length < events.length) {
    // Dropping old events makes history incomplete before the retention cutoff.
    const cutoffIso = new Date(retentionCutoff).toISOString();
    if (!completeSince || Date.parse(completeSince) < retentionCutoff) completeSince = cutoffIso;
  }
  return { ...fresh, events: retained, eventsCompleteSince: completeSince };
}

/**
 * Apply list-level metadata (title, labels, draft, updatedAt) to a cached detail record
 * so cheap fields stay current even when details are not refetched this run.
 */
export function refreshListFields(cached: PrRecord, listed: PrRecord): PrRecord {
  return {
    ...cached,
    title: listed.title,
    url: listed.url,
    listUpdatedAt: listed.updatedAt,
    isDraft: listed.isDraft,
    labels: listed.labels,
    baseRef: listed.baseRef,
    additions: listed.additions,
    deletions: listed.deletions,
    changedFiles: listed.changedFiles,
  };
}
