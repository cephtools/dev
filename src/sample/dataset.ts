// Build records and a dataset from the fixture PRs without touching the network.
// Used by the sample CLI and by tests.

import { readFileSync } from 'node:fs';
import { loadConfig, loadRules } from '../config.ts';
import type { CollectStats } from '../collect/collector.ts';
import { normalizeDetailNode, normalizeListNode } from '../collect/normalize.ts';
import { buildDataset } from '../dataset/build.ts';
import { expandFixture, type FixtureFile } from './expand.ts';
import type { PrRecord } from '../types.ts';
import { HOUR_MS } from '../util/time.ts';

export const FIXTURE_PATH = new URL('../../tests/fixtures/prs.json', import.meta.url);

export function sampleRecords(now: Date): PrRecord[] {
  const config = loadConfig({});
  const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;
  return fixtures.prs.map((spec) => {
    const { list, detail } = expandFixture(spec, now);
    return detail ? normalizeDetailNode(detail, { config: config.collection, now }) : normalizeListNode(list, config.collection);
  });
}

export function sampleDataset(now: Date) {
  const config = loadConfig({});
  const records = sampleRecords(now);
  const missing = records.filter((r) => r.detail !== 'full').length;
  const stats: CollectStats = {
    totalOpen: records.length, listed: records.length, fetched: records.length - missing, failed: [], cachedFresh: 0,
    stale: 0, missing, partial: missing > 0,
    notes: ['Sample dataset generated from test fixtures; not live data.', ...(missing ? [`${missing} PR(s) have no detail data yet (only list metadata); their scores are incomplete.`] : [])],
    apiCost: 0, apiRequests: 0, rateLimitRemaining: null,
  };
  // A synthetic previous snapshot so rank movement is visible in the sample.
  const prevAt = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  const history = { version: 1 as const, snapshots: [{ at: prevAt, prs: { '60420': [1, 30, 0], '61003': [2, 25, 83], '61001': [3, 20, 0] } as Record<string, [number, number, number]> }] };
  return buildDataset({ records, stats, config, rules: loadRules(), now, startedAt: now, history, source: 'sample' });
}
