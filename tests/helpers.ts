import { loadConfig, loadRules } from '../src/config.ts';
import { expandFixture, type FixtureSpec } from '../src/sample/expand.ts';
import { normalizeDetailNode } from '../src/collect/normalize.ts';
import type { ActivityEvent, PrRecord } from '../src/types.ts';
import { HOUR_MS } from '../src/util/time.ts';

export const NOW = new Date('2026-10-25T12:00:00Z');
export const config = loadConfig({});
export const rules = loadRules();

export const hoursAgo = (h: number, now = NOW) => new Date(now.getTime() - h * HOUR_MS).toISOString();

let seq = 0;
export function ev(kind: ActivityEvent['kind'], h: number, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id: `E${seq++}`, kind, at: hoursAgo(h), actor: `user${seq % 5}`, actorIsBot: false, ...extra };
}

export function record(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    number: 1000,
    title: 'test PR',
    url: 'https://github.com/ceph/ceph/pull/1000',
    author: 'author',
    authorIsBot: false,
    state: 'open',
    isDraft: false,
    createdAt: hoursAgo(24 * 60),
    closedAt: null,
    mergedAt: null,
    updatedAt: hoursAgo(1),
    baseRef: 'main',
    labels: [],
    additions: 10,
    deletions: 5,
    changedFiles: 1,
    detail: 'full',
    fetchedAt: NOW.toISOString(),
    body: '',
    files: [],
    filesTruncated: false,
    totals: { comments: 0, reviews: 0, commits: 0 },
    ciState: null,
    events: [],
    eventsCompleteSince: null,
    ...overrides,
  };
}

export function fromSpec(spec: Partial<FixtureSpec> & { number: number }, now = NOW): PrRecord {
  const full: FixtureSpec = { title: 't', author: 'author', createdDaysAgo: 30, ...spec };
  const { detail } = expandFixture(full, now);
  return normalizeDetailNode(detail!, { config: config.collection, now });
}

export function files(...entries: [string, number, number][]) {
  return entries.map(([path, additions, deletions]) => ({ path, additions, deletions }));
}

/** Build a fetch stub that returns queued responses (or calls a handler) and records request bodies. */
export function fakeFetch(handler: (body: { query: string; variables: Record<string, unknown> }, call: number) => Response | Promise<Response>) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fn = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    return handler(body, calls.length - 1);
  };
  return { fn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
