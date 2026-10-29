import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCache } from '../src/collect/cache.ts';
import { collect, CollectionError, listClosedPrs, listOpenPrs, selectForRefresh } from '../src/collect/collector.ts';
import { normalizeListNode, type RawPrListNode } from '../src/collect/normalize.ts';
import { GitHubClient, GitHubError, RateLimitError, TransientError } from '../src/github/client.ts';
import { expandFixture } from '../src/sample/expand.ts';
import { config, fakeFetch, hoursAgo, json, NOW } from './helpers.ts';

const noSleep = async () => {};
const rl = (remaining = 4000) => ({ cost: 1, remaining, resetAt: new Date(Date.now() + 3_600_000).toISOString() });
const client = (fn: ReturnType<typeof fakeFetch>['fn'], extra = {}) =>
  new GitHubClient({ token: 't', fetchImpl: fn, sleep: noSleep, maxRetries: 3, baseBackoffMs: 1, ...extra });

// List and detail nodes come from the same spec, so updatedAt agrees as it does on GitHub.
// A merged PR was merged 1h ago, after its last comment, so merging changes updatedAt.
const spec = (n: number, merged = false) =>
  expandFixture({ number: n, title: `PR ${n}`, author: 'a', createdDaysAgo: 3, files: [['src/os/bluestore/BlueStore.cc', 10, 1]], comments: [{ author: 'b', hoursAgo: 2 }], ...(merged ? { state: 'merged', closedHoursAgo: 1 } : {}) }, NOW);
const listNode = (n: number) => spec(n).list;
const detailNode = (n: number, merged = false) => spec(n, merged).detail!;

function listPage(numbers: number[], total: number, next: string | null) {
  return json({ data: { rateLimit: rl(), repository: { pullRequests: { totalCount: total, pageInfo: { hasNextPage: !!next, endCursor: next }, nodes: numbers.map(listNode) } } } });
}

function closedPage(nodes: RawPrListNode[], next: string | null = null, remaining = 4000) {
  return json({ data: { rateLimit: rl(remaining), repository: { pullRequests: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } } } });
}

test('client retries transient 5xx and network errors', async () => {
  const f = fakeFetch((_b, i) => {
    if (i === 0) throw new Error('ECONNRESET');
    if (i === 1) return new Response('bad gateway', { status: 502 });
    return json({ data: { rateLimit: rl(), ok: 1 } });
  });
  const res = await client(f.fn).graphql<{ ok: number }>('q');
  assert.equal(res.data.ok, 1);
  assert.equal(f.calls.length, 3);
});

test('client gives up after max retries with TransientError', async () => {
  const f = fakeFetch(() => new Response('', { status: 503 }));
  await assert.rejects(client(f.fn).graphql('q'), TransientError);
  assert.equal(f.calls.length, 4);
});

test('client waits out a short secondary rate limit', async () => {
  const waits: number[] = [];
  const f = fakeFetch((_b, i) => (i === 0 ? new Response('You have exceeded a secondary rate limit', { status: 403, headers: { 'retry-after': '2' } }) : json({ data: { rateLimit: rl(), ok: 1 } })));
  const c = new GitHubClient({ token: 't', fetchImpl: f.fn, sleep: async (ms) => void waits.push(ms), maxRetries: 0 });
  await c.graphql('q');
  assert.deepEqual(waits, [2000]);
});

test('client throws RateLimitError instead of waiting too long', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const f = fakeFetch(() => new Response('API rate limit exceeded', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }));
  await assert.rejects(client(f.fn, { maxRateLimitWaitMs: 60_000 }).graphql('q'), RateLimitError);
});

test('client surfaces auth failures and GraphQL errors without data', async () => {
  await assert.rejects(client(fakeFetch(() => new Response('', { status: 401 })).fn).graphql('q'), (e: Error) => e instanceof GitHubError && /401/.test(e.message));
  await assert.rejects(client(fakeFetch(() => json({ data: null, errors: [{ message: 'Field x does not exist' }] })).fn).graphql('q'), /does not exist/);
});

test('client tracks rate limit budget', async () => {
  const c = client(fakeFetch(() => json({ data: { rateLimit: rl(1234) } })).fn);
  await c.graphql('q');
  assert.equal(c.rateLimit?.remaining, 1234);
  assert.equal(c.totalCost, 1);
});

test('listOpenPrs follows pagination and de-duplicates', async () => {
  const f = fakeFetch((b) => {
    if (!b.variables.after) return listPage([1, 2, 3], 5, 'c1');
    return listPage([3, 4, 5], 5, null); // #3 repeated across pages
  });
  const { prs } = await listOpenPrs(client(f.fn), config);
  assert.deepEqual(prs.map((p) => p.number).sort(), [1, 2, 3, 4, 5]);
  assert.equal(f.calls[1].variables.after, 'c1');
});

test('listOpenPrs refuses a clearly incomplete list instead of publishing it', async () => {
  const f = fakeFetch(() => listPage([1, 2], 500, null));
  await assert.rejects(listOpenPrs(client(f.fn), config), CollectionError);
});

test('listOpenPrs rejects an inaccessible repository', async () => {
  const f = fakeFetch(() => json({ data: { rateLimit: rl(), repository: null } }));
  await assert.rejects(listOpenPrs(client(f.fn), config), /not found/);
});

test('listClosedPrs keeps PRs closed within closedDays and stops paging at the cutoff', async () => {
  const closed = (number: number, state: 'merged' | 'closed', closedHoursAgo: number) => expandFixture({ number, title: 't', author: 'a', createdDaysAgo: 90, state, closedHoursAgo }, NOW).list;
  const days = config.collection.closedDays;
  const f = fakeFetch((b) => {
    if (!b.variables.after) {
      return closedPage([
        closed(10, 'merged', 1),
        { ...closed(11, 'closed', (days + 10) * 24), updatedAt: hoursAgo(2) }, // closed long ago, commented on recently
        closed(12, 'merged', 5 * 24),
      ], 'c1');
    }
    if (b.variables.after === 'c1') return closedPage([closed(13, 'closed', (days - 1) * 24), closed(14, 'merged', (days + 1) * 24)], 'c2');
    throw new Error('paged past the cutoff');
  });
  const prs = await listClosedPrs(client(f.fn), config, NOW);
  assert.deepEqual(prs.map((p) => [p.number, p.state]), [[10, 'merged'], [12, 'merged'], [13, 'closed']]);
  assert.equal(prs[0].mergedAt, prs[0].closedAt);
  assert.equal(prs[2].mergedAt, null);
  assert.equal(f.calls.length, 2);

  const off = fakeFetch(() => {
    throw new Error('should not list closed PRs');
  });
  assert.deepEqual(await listClosedPrs(client(off.fn), { ...config, collection: { ...config.collection, closedDays: 0 } }, NOW), []);
});

test('detail fetches prefer open PRs over recently closed ones', () => {
  const open = normalizeListNode(spec(1).list, config.collection);
  const merged = normalizeListNode(spec(2, true).list, config.collection); // updated more recently
  assert.deepEqual(selectForRefresh([merged, open], emptyCache(), config, NOW).map((p) => p.number), [1, 2]);
});

test('only open PRs are refreshed by age; merged PRs wait for an update', () => {
  const longAgo = hoursAgo(config.collection.refreshAfterHours + 1);
  const cached = (n: number, merged = false) => ({ ...normalizeListNode(spec(n, merged).list, config.collection), detail: 'full' as const, fetchedAt: longAgo });
  const cache = { ...emptyCache(), records: { 1: cached(1), 2: cached(2, true) } };
  const listed = [normalizeListNode(spec(1).list, config.collection), normalizeListNode(spec(2, true).list, config.collection)];
  assert.deepEqual(selectForRefresh(listed, cache, config, NOW).map((p) => p.number), [1]);
  listed[1] = { ...listed[1], updatedAt: hoursAgo(0.5) }; // a late comment on the merged PR
  assert.deepEqual(selectForRefresh(listed, cache, config, NOW).map((p) => p.number), [2, 1]);
});

function detailHandler(numbers: number[], opts: { failBatchesOver?: number; missing?: number[]; merged?: number[] } = {}) {
  return (b: { query: string; variables: Record<string, unknown> }) => {
    if (b.query.includes('ListOpenPrs')) return listPage(numbers, numbers.length, null);
    if (b.query.includes('ListClosedPrs')) return closedPage((opts.merged ?? []).map((n) => spec(n, true).list));
    const requested = [...b.query.matchAll(/p(\d+): pullRequest/g)].map((m) => Number(m[1]));
    if (opts.failBatchesOver && requested.length > opts.failBatchesOver) return new Response('timeout', { status: 502 });
    const repo = Object.fromEntries(requested.map((n) => [`p${n}`, opts.missing?.includes(n) ? null : detailNode(n, opts.merged?.includes(n))]));
    return json({ data: { rateLimit: rl(), repository: repo }, errors: opts.missing?.length ? [{ type: 'NOT_FOUND', message: 'not found' }] : undefined });
  };
}

test('collect fetches details in batches and splits batches that time out', async () => {
  const numbers = Array.from({ length: 12 }, (_, i) => 100 + i);
  const f = fakeFetch(detailHandler(numbers, { failBatchesOver: 3 }));
  const cache = emptyCache();
  const { records, stats } = await collect({ client: client(f.fn, { maxRetries: 0 }), config, cache, now: NOW });
  assert.equal(records.length, 12);
  assert.ok(records.every((r) => r.detail === 'full'));
  assert.equal(stats.fetched, 12);
  assert.equal(stats.partial, false);
});

test('collect keeps missing PRs as stubs and reports partial data', async () => {
  const f = fakeFetch(detailHandler([1, 2, 3], { missing: [2] }));
  const { records, stats } = await collect({ client: client(f.fn), config, cache: emptyCache(), now: NOW });
  assert.equal(records.find((r) => r.number === 2)!.detail, 'none');
  assert.deepEqual(stats.failed, [2]);
  assert.equal(stats.missing, 1);
  assert.ok(stats.partial);
  assert.ok(stats.notes.some((n) => /#2/.test(n)));
});

test('collect is incremental: unchanged cached PRs are not refetched', async () => {
  const cache = emptyCache();
  const f1 = fakeFetch(detailHandler([1, 2]));
  await collect({ client: client(f1.fn), config, cache, now: NOW });
  const f2 = fakeFetch(detailHandler([1, 2]));
  const { stats } = await collect({ client: client(f2.fn), config, cache, now: new Date(NOW.getTime() + 3_600_000) });
  assert.equal(f2.calls.length, 2, 'only the open and closed list queries');
  assert.equal(stats.fetched, 0);
  assert.equal(stats.cachedFresh, 2);
});

test('collect stops detail fetching at the rate-limit reserve and uses cached data', async () => {
  const f = fakeFetch((b) => {
    if (b.query.includes('ListOpenPrs')) return json({ data: { rateLimit: rl(10), repository: { pullRequests: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [listNode(1), listNode(2)] } } } });
    if (b.query.includes('ListClosedPrs')) return closedPage([], null, 10);
    throw new Error('should not fetch details');
  });
  const { records, stats } = await collect({ client: client(f.fn), config, cache: emptyCache(), now: NOW });
  assert.equal(records.length, 2, 'PRs are still listed');
  assert.ok(stats.partial);
  assert.ok(stats.notes.some((n) => /reserve/.test(n)));
});

test('collect keeps recently merged PRs and drops PRs that are neither open nor recently closed', async () => {
  const cache = emptyCache();
  await collect({ client: client(fakeFetch(detailHandler([1, 2, 3])).fn), config, cache, now: NOW });
  // #1 was merged; #3 is in neither list (e.g. closed before the closedDays window).
  const { records, stats } = await collect({ client: client(fakeFetch(detailHandler([2], { merged: [1] })).fn), config, cache, now: NOW });
  assert.deepEqual(Object.keys(cache.records).sort(), ['1', '2']);
  const merged = records.find((r) => r.number === 1)!;
  assert.equal(merged.state, 'merged');
  assert.ok(merged.mergedAt);
  assert.equal(merged.detail, 'full');
  assert.equal(stats.fetched, 1, 'merging changed updatedAt, so only #1 is refetched');
  assert.deepEqual([stats.listed, stats.closedListed, stats.closedDays], [1, 1, config.collection.closedDays]);
});

test('collect keeps a PR closed between the two listings once, as closed', async () => {
  const { records, stats } = await collect({ client: client(fakeFetch(detailHandler([1, 2], { merged: [1] })).fn), config, cache: emptyCache(), now: NOW });
  assert.deepEqual(records.map((r) => [r.number, r.state]).sort(), [[1, 'merged'], [2, 'open']]);
  assert.equal(stats.listed, 1);
});

test('collect propagates listing failures (never an empty PR list)', async () => {
  const f = fakeFetch(() => new Response('', { status: 500 }));
  await assert.rejects(collect({ client: client(f.fn, { maxRetries: 1 }), config, cache: emptyCache(), now: NOW }), TransientError);
});

test('first run publishes early: bootstrap cap applies only while the cache is empty', async () => {
  const numbers = Array.from({ length: 30 }, (_, i) => 200 + i);
  const cfg = structuredClone(config);
  cfg.collection.bootstrapMaxDetailPrs = 10;
  cfg.collection.maxDetailPrsPerRun = 100;
  const cache = emptyCache();
  const first = await collect({ client: client(fakeFetch(detailHandler(numbers)).fn), config: cfg, cache, now: NOW });
  assert.equal(first.records.length, 30, 'every open PR is listed');
  assert.equal(first.stats.fetched, 10);
  assert.equal(first.stats.missing, 20);
  assert.ok(first.stats.notes.some((n) => /First run/.test(n)));
  const second = await collect({ client: client(fakeFetch(detailHandler(numbers)).fn), config: cfg, cache, now: NOW });
  assert.equal(second.stats.fetched, 20, 'next run catches up with the normal cap');
  assert.equal(second.stats.missing, 0);
});
