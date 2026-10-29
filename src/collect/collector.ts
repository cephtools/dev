// Collection pipeline: list all open PRs and recently merged/closed ones → pick the ones
// whose details are missing or stale → fetch details in batches within the API budget →
// merge into the cache.

import type { DashboardConfig } from '../config.ts';
import { GitHubClient, RateLimitError, TransientError, type GraphQLResult } from '../github/client.ts';
import { LIST_CLOSED_PRS, LIST_OPEN_PRS, PR_FILES_PAGE, prDetailBatchQuery } from '../github/queries.ts';
import type { ChangedFile, PrRecord } from '../types.ts';
import { DAY_MS, HOUR_MS, ms } from '../util/time.ts';
import { mergeRecord, refreshListFields, type PrCache } from './cache.ts';
import { normalizeDetailNode, normalizeListNode, type RawPrDetailNode, type RawPrListNode } from './normalize.ts';

export interface CollectStats {
  totalOpen: number;
  /** Open PRs listed. */
  listed: number;
  /** PRs merged or closed within the last `closedDays` days. */
  closedListed: number;
  closedDays: number;
  fetched: number;
  failed: number[];
  cachedFresh: number;
  stale: number;
  missing: number;
  partial: boolean;
  notes: string[];
  apiCost: number;
  apiRequests: number;
  rateLimitRemaining: number | null;
}

export interface CollectResult {
  records: PrRecord[];
  stats: CollectStats;
}

export class CollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionError';
  }
}

interface ListConnection {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (RawPrListNode | null)[];
}

interface ListResponse {
  repository: { pullRequests: ListConnection } | null;
}

interface ClosedListResponse {
  repository: { pullRequests: Omit<ListConnection, 'totalCount'> } | null;
}

export async function listOpenPrs(client: GitHubClient, config: DashboardConfig): Promise<{ prs: PrRecord[]; totalCount: number }> {
  const byNumber = new Map<number, PrRecord>();
  let after: string | null = null;
  let totalCount = 0;
  for (let page = 0; page < 1000; page++) {
    const vars: Record<string, unknown> = { owner: config.repo.owner, name: config.repo.name, first: config.collection.listPageSize, after };
    const { data }: GraphQLResult<ListResponse> = await client.graphql<ListResponse>(LIST_OPEN_PRS, vars);
    const conn: ListConnection | undefined = data.repository?.pullRequests;
    if (!conn) throw new CollectionError(`repository ${config.repo.owner}/${config.repo.name} not found or not accessible`);
    totalCount = conn.totalCount;
    for (const node of conn.nodes) {
      if (node) byNumber.set(node.number, normalizeListNode(node, config.collection));
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const prs = [...byNumber.values()];
  // PRs open/close while we paginate, so allow small drift, but never accept a list
  // that is clearly incomplete (that would silently hide PRs from the dashboard).
  const tolerance = Math.max(5, Math.ceil(totalCount * 0.02));
  if (prs.length < totalCount - tolerance) {
    throw new CollectionError(`listed ${prs.length} open PRs but GitHub reports ${totalCount}; refusing to publish an incomplete list`);
  }
  return { prs, totalCount };
}

/**
 * List PRs merged or closed within the last `closedDays` days. Old PRs that were merely
 * updated recently (a late comment, a label change) are skipped. GitHub's totalCount
 * covers the whole closed history, so there is no completeness check as for open PRs.
 */
export async function listClosedPrs(client: GitHubClient, config: DashboardConfig, now: Date): Promise<PrRecord[]> {
  const days = config.collection.closedDays;
  if (!(days > 0)) return [];
  const cutoff = now.getTime() - days * DAY_MS;
  const byNumber = new Map<number, PrRecord>();
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const vars: Record<string, unknown> = { owner: config.repo.owner, name: config.repo.name, first: config.collection.listPageSize, after };
    const { data }: GraphQLResult<ClosedListResponse> = await client.graphql<ClosedListResponse>(LIST_CLOSED_PRS, vars);
    const conn = data.repository?.pullRequests;
    if (!conn) throw new CollectionError(`repository ${config.repo.owner}/${config.repo.name} not found or not accessible`);
    // Ordered by updatedAt, newest first: once a PR was last updated before the cutoff,
    // every later one was too, and none of them can have been closed after it.
    let reachedCutoff = false;
    for (const node of conn.nodes) {
      if (!node) continue;
      if (Date.parse(node.updatedAt) < cutoff) reachedCutoff = true;
      else if (node.closedAt && Date.parse(node.closedAt) >= cutoff) byNumber.set(node.number, normalizeListNode(node, config.collection));
    }
    if (reachedCutoff || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return [...byNumber.values()];
}

/** Decide which PRs need a detail fetch, most valuable first. */
export function selectForRefresh(listed: PrRecord[], cache: PrCache, config: DashboardConfig, now: Date): PrRecord[] {
  const refreshMs = config.collection.refreshAfterHours * HOUR_MS;
  const changed: PrRecord[] = [];
  const aged: PrRecord[] = [];
  for (const pr of listed) {
    const cached = cache.records[pr.number];
    if (!cached || cached.detail !== 'full' || cached.updatedAt !== pr.updatedAt) changed.push(pr);
    // Merged and closed PRs only change with updatedAt, so they are never refreshed by age.
    else if (pr.state === 'open' && (!cached.fetchedAt || now.getTime() - Date.parse(cached.fetchedAt) > refreshMs)) aged.push(pr);
  }
  // Open PRs first (they are what the dashboard is for), then recently updated ones:
  // they are the ones whose scores move.
  const closedLast = (pr: PrRecord) => (pr.state === 'open' ? 0 : 1);
  changed.sort((a, b) => closedLast(a) - closedLast(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  aged.sort((a, b) => ms(cache.records[a.number].fetchedAt) - ms(cache.records[b.number].fetchedAt));
  return [...changed, ...aged];
}

type DetailResponse = { repository: Record<string, RawPrDetailNode | null> | null };

async function fetchFilePages(client: GitHubClient, config: DashboardConfig, number: number, cursor: string | null, have: number): Promise<{ files: ChangedFile[]; complete: boolean }> {
  const files: ChangedFile[] = [];
  let after = cursor;
  while (after && have + files.length < config.collection.maxFilesPerPr) {
    const { data } = await client.graphql<{ repository: { pullRequest: { files: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ChangedFile[] } } | null } | null }>(
      PR_FILES_PAGE,
      { owner: config.repo.owner, name: config.repo.name, number, after },
    );
    const conn = data.repository?.pullRequest?.files;
    if (!conn) break;
    files.push(...conn.nodes.filter(Boolean));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return { files, complete: after === null };
}

/**
 * Fetch one batch of PR details. On a transient failure (GitHub times out on heavy
 * queries), split the batch and retry the halves; a single PR that still fails is
 * reported in `failed` and keeps its cached data.
 */
async function fetchBatch(client: GitHubClient, config: DashboardConfig, numbers: number[], now: Date, failed: number[]): Promise<PrRecord[]> {
  let result;
  try {
    result = await client.graphql<DetailResponse>(prDetailBatchQuery(numbers), { owner: config.repo.owner, name: config.repo.name });
  } catch (err) {
    if (err instanceof TransientError) {
      if (numbers.length === 1) {
        failed.push(numbers[0]);
        return [];
      }
      const mid = Math.ceil(numbers.length / 2);
      return [
        ...(await fetchBatch(client, config, numbers.slice(0, mid), now, failed)),
        ...(await fetchBatch(client, config, numbers.slice(mid), now, failed)),
      ];
    }
    throw err;
  }
  const out: PrRecord[] = [];
  for (const n of numbers) {
    const raw = result.data.repository?.[`p${n}`];
    if (!raw) {
      failed.push(n); // e.g. NOT_FOUND because it was closed/deleted mid-run
      continue;
    }
    let extra: ChangedFile[] = [];
    let complete = true;
    if (raw.files?.pageInfo?.hasNextPage) {
      const pages = await fetchFilePages(client, config, n, raw.files.pageInfo.endCursor, raw.files.nodes?.length ?? 0);
      extra = pages.files;
      complete = pages.complete;
    }
    out.push(normalizeDetailNode(raw, { config: config.collection, now }, extra, complete));
  }
  return out;
}

export interface CollectOptions {
  client: GitHubClient;
  config: DashboardConfig;
  cache: PrCache;
  now: Date;
  log?: (msg: string) => void;
}

/**
 * Run a collection. Throws CollectionError (or a GitHub error) if the open or closed PR
 * list cannot be obtained; detail fetch problems degrade to a partial result instead.
 * Mutates `cache` in place.
 */
export async function collect({ client, config, cache, now, log = () => {} }: CollectOptions): Promise<CollectResult> {
  const notes: string[] = [];
  const { prs: open, totalCount } = await listOpenPrs(client, config);
  log(`listed ${open.length} open PRs (GitHub reports ${totalCount})`);
  const { closedDays } = config.collection;
  const closed = await listClosedPrs(client, config, now);
  if (closedDays > 0) log(`listed ${closed.length} PRs merged or closed in the last ${closedDays} days`);
  // A PR closed between the two listings appears in both; the later, closed entry wins.
  const listed = [...new Map([...open, ...closed].map((p) => [p.number, p])).values()];
  const closedListed = listed.filter((p) => p.state !== 'open').length;

  // First run: publish early with the most recently updated PRs; later runs catch up.
  const bootstrap = Object.keys(cache.records).length === 0;
  const cap = bootstrap ? config.collection.bootstrapMaxDetailPrs : config.collection.maxDetailPrsPerRun;
  const candidates = selectForRefresh(listed, cache, config, now);
  const queue = candidates.slice(0, cap);
  if (candidates.length > queue.length) {
    notes.push(`${bootstrap ? 'First run: f' : 'F'}etched details for ${queue.length} PRs (open ones first, most recently updated first); ${candidates.length - queue.length} more will be fetched in the next run(s).`);
  }
  const fetchedNumbers = new Set<number>();
  const failed: number[] = [];
  let partial = false;

  // Batches run `detailConcurrency` at a time: GitHub's latency per batch (seconds,
  // highly variable) dominates, not the point cost.
  const { detailBatchSize, detailConcurrency } = config.collection;
  const step = detailBatchSize * Math.max(1, detailConcurrency);
  for (let i = 0; i < queue.length; i += step) {
    const remaining = client.rateLimit?.remaining;
    if (remaining !== undefined && remaining < config.collection.rateLimitReserve) {
      notes.push(`Stopped detail collection with ${remaining} API points left (reserve ${config.collection.rateLimitReserve}); remaining PRs use cached data.`);
      partial = true;
      break;
    }
    const round = queue.slice(i, i + step).map((p) => p.number);
    const batches: number[][] = [];
    for (let j = 0; j < round.length; j += detailBatchSize) batches.push(round.slice(j, j + detailBatchSize));
    const results = await Promise.allSettled(batches.map((b) => fetchBatch(client, config, b, now, failed)));
    let rateLimited: RateLimitError | null = null;
    for (const r of results) {
      if (r.status === 'rejected') {
        if (r.reason instanceof RateLimitError) {
          rateLimited = r.reason;
          continue;
        }
        throw r.reason;
      }
      for (const rec of r.value) {
        cache.records[rec.number] = mergeRecord(cache.records[rec.number], rec, now, config.collection.eventRetentionDays);
        fetchedNumbers.add(rec.number);
      }
    }
    if (rateLimited) {
      notes.push(`Rate limited during detail collection (resets ${rateLimited.resetAt ?? 'unknown'}); remaining PRs use cached data.`);
      partial = true;
      break;
    }
    log(`details: ${Math.min(i + round.length, queue.length)}/${queue.length} (API points left: ${client.rateLimit?.remaining ?? '?'})`);
  }
  if (failed.length) {
    notes.push(`Detail fetch failed for ${failed.length} PR(s): ${failed.slice(0, 20).map((n) => `#${n}`).join(', ')}; cached data used where available.`);
    partial = true;
  }

  // Drop PRs that are neither open nor recently closed; refresh cheap list fields on the rest.
  const listedNumbers = new Set(listed.map((p) => String(p.number)));
  for (const key of Object.keys(cache.records)) if (!listedNumbers.has(key)) delete cache.records[key];

  const refreshMs = config.collection.refreshAfterHours * HOUR_MS;
  let stale = 0;
  let missing = 0;
  let cachedFresh = 0;
  const records = listed.map((pr) => {
    const cached = cache.records[pr.number];
    if (!cached || cached.detail !== 'full') {
      missing++;
      return pr;
    }
    const merged = refreshListFields(cached, pr);
    cache.records[pr.number] = merged;
    if (!fetchedNumbers.has(pr.number)) {
      const outdated = cached.updatedAt !== pr.updatedAt || (pr.state === 'open' && now.getTime() - ms(cached.fetchedAt) > refreshMs);
      if (outdated) stale++;
      else cachedFresh++;
    }
    return merged;
  });
  if (missing) notes.push(`${missing} PR(s) have no detail data yet (only list metadata); their scores are incomplete.`);
  if (stale) notes.push(`${stale} PR(s) changed since their details were last fetched; scores use the older cached details.`);

  return {
    records,
    stats: {
      totalOpen: totalCount,
      listed: listed.length - closedListed,
      closedListed,
      closedDays,
      fetched: fetchedNumbers.size,
      failed,
      cachedFresh,
      stale,
      missing,
      partial: partial || missing > 0 || stale > 0,
      notes,
      apiCost: client.totalCost,
      apiRequests: client.requestCount,
      rateLimitRemaining: client.rateLimit?.remaining ?? null,
    },
  };
}
