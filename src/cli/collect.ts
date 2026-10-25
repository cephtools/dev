// Scheduled collection entry point.
//
//   GITHUB_TOKEN=... node src/cli/collect.ts --state state [--max-details N]
//
// State directory layout (persisted on the data branch by the workflow):
//   cache.json      per-PR detail cache (incremental collection)
//   history.json    trending rank snapshots
//   public/         published data (manifest.json, status.json, datasets/)
//
// Exit code is non-zero if no new dataset was published; status.json always records
// the outcome so the dashboard can show collection failures.

import { join } from 'node:path';
import { loadConfig, loadRules } from '../config.ts';
import { loadCache, saveCache } from '../collect/cache.ts';
import { collect } from '../collect/collector.ts';
import { buildDataset } from '../dataset/build.ts';
import { appendSnapshot, loadHistory, saveHistory } from '../dataset/history.ts';
import { publishDataset, readStatus, writeStatus } from '../dataset/publish.ts';
import { GitHubClient } from '../github/client.ts';
import { parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const stateDir = str(args.state, 'state');
const publicDir = join(stateDir, 'public');
const cachePath = join(stateDir, 'cache.json');
const historyPath = join(stateDir, 'history.json');
const log = (msg: string) => console.log(`[collect] ${msg}`);

const startedAt = new Date();
const config = loadConfig();
if (typeof args['max-details'] === 'string') {
  config.collection.maxDetailPrsPerRun = config.collection.bootstrapMaxDetailPrs = Number(args['max-details']);
}
const rules = loadRules();
const cache = loadCache(cachePath);
const previousStatus = readStatus(publicDir);

try {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const client = new GitHubClient({
    token,
    maxRetries: config.collection.maxRetries,
    maxRateLimitWaitMs: config.collection.maxRateLimitWaitSeconds * 1000,
    log,
  });
  log(`collecting ${config.repo.owner}/${config.repo.name} (${Object.keys(cache.records).length} PRs cached)`);
  const { records, stats } = await collect({ client, config, cache, now: startedAt, log });
  // Persist fetched details even if a later step fails, so API work is not wasted.
  saveCache(cachePath, cache);

  const history = loadHistory(historyPath);
  const { dataset, snapshot } = buildDataset({ records, stats, config, rules, now: startedAt, startedAt, history, source: 'github' });
  const manifest = publishDataset(publicDir, dataset, config.history.keepDatasets);
  saveHistory(historyPath, appendSnapshot(history, snapshot, startedAt, config.history.retentionDays));

  writeStatus(publicDir, {
    lastAttemptAt: startedAt.toISOString(),
    ok: true,
    error: null,
    lastSuccessAt: dataset.generatedAt,
    lastSuccessId: manifest.id,
    partial: stats.partial,
    notes: stats.notes,
  });
  const important = dataset.prs.filter((p) => p.technical.important).length;
  const trending = dataset.prs.filter((p) => p.trending.score > 0).length;
  log(`published ${manifest.dataset}: ${dataset.prs.length} PRs, ${trending} with recent activity, ${important} technically important`);
  log(`API: ${stats.apiRequests} requests, ${stats.apiCost} points, ${stats.rateLimitRemaining ?? '?'} remaining`);
  for (const note of stats.notes) log(`note: ${note}`);
} catch (err) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[collect] FAILED: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  try {
    saveCache(cachePath, cache);
  } catch {
    // keep the original error visible
  }
  writeStatus(publicDir, {
    lastAttemptAt: startedAt.toISOString(),
    ok: false,
    error: message,
    lastSuccessAt: previousStatus?.lastSuccessAt ?? null,
    lastSuccessId: previousStatus?.lastSuccessId ?? null,
    partial: false,
    notes: [],
  });
  process.exitCode = 1;
}
