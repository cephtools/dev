// Assemble the published dataset from collected records: metrics, scores, ranks.

import { createHash } from 'node:crypto';
import type { ClassificationRules, DashboardConfig } from '../config.ts';
import type { CollectStats } from '../collect/collector.ts';
import { allWindowMetrics, lastActivityAt } from '../score/metrics.ts';
import { technicalImportance } from '../score/importance.ts';
import { markUnusual, trendingScore } from '../score/trending.ts';
import type { ChangedFile, PrRecord, TechnicalResult, TrendingResult, WindowDef, WindowMetrics } from '../types.ts';
import { HOUR_MS, ms } from '../util/time.ts';
import { comparisonSnapshot, type History, type Snapshot } from './history.ts';
import { churn } from '../score/classify.ts';

export const SCHEMA_VERSION = 1;
const OTHER_FILES_SHOWN = 5;

export interface DatasetFile extends ChangedFile {
  /** Fragment of the PR "Files changed" page for this file (#diff-<sha256(path)>). */
  anchor: string;
  relevant: boolean;
}

export interface DatasetPr {
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  baseRef: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  ciState: string | null;
  detail: 'fresh' | 'stale' | 'missing';
  fetchedAt: string | null;
  totals: { comments: number; reviews: number; commits: number };
  metrics: Record<string, WindowMetrics>;
  trending: TrendingResult & { rank: number | null; previousRank: number | null };
  technical: Omit<TechnicalResult, 'relevantFiles'> & { relevantFiles: string[] };
  files: DatasetFile[];
}

export interface CollectionInfo extends CollectStats {
  source: 'github' | 'sample';
  startedAt: string;
  finishedAt: string;
}

export interface Dataset {
  schemaVersion: number;
  id: string;
  generatedAt: string;
  repo: { owner: string; name: string; url: string };
  site: DashboardConfig['site'];
  collection: CollectionInfo;
  windows: WindowDef[];
  scoring: {
    trending: DashboardConfig['trending'];
    importance: DashboardConfig['importance'];
    population: { median: number; mad: number; threshold: number; population: number };
  };
  subsystems: { id: string; name: string; description: string }[];
  history: { comparedTo: string | null; snapshots: number };
  prs: DatasetPr[];
}

export interface BuildInput {
  records: PrRecord[];
  stats: CollectStats;
  config: DashboardConfig;
  rules: ClassificationRules;
  now: Date;
  startedAt: Date;
  history: History;
  source: 'github' | 'sample';
}

export function datasetId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function diffAnchor(path: string): string {
  return 'diff-' + createHash('sha256').update(path).digest('hex');
}

function detailState(rec: PrRecord, config: DashboardConfig, now: Date): DatasetPr['detail'] {
  if (rec.detail !== 'full') return 'missing';
  const changed = rec.listUpdatedAt !== undefined && rec.listUpdatedAt !== rec.updatedAt;
  const old = now.getTime() - ms(rec.fetchedAt) > config.collection.refreshAfterHours * HOUR_MS;
  return changed || old ? 'stale' : 'fresh';
}

function datasetFiles(rec: PrRecord, relevant: ChangedFile[]): DatasetFile[] {
  const relevantPaths = new Set(relevant.map((f) => f.path));
  const others = rec.files.filter((f) => !relevantPaths.has(f.path)).sort((a, b) => churn(b) - churn(a)).slice(0, OTHER_FILES_SHOWN);
  return [
    ...relevant.map((f) => ({ ...f, anchor: diffAnchor(f.path), relevant: true })),
    ...others.map((f) => ({ ...f, anchor: diffAnchor(f.path), relevant: false })),
  ];
}

export function buildDataset(input: BuildInput): { dataset: Dataset; snapshot: Snapshot } {
  const { records, stats, config, rules, now, history } = input;

  const trending = records.map((rec) => trendingScore(rec, { now, config: config.trending, collection: config.collection }));
  const population = markUnusual(trending, config.trending);

  const ranked = records
    .map((rec, i) => ({ n: rec.number, s: trending[i].score }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || b.n - a.n);
  const rankOf = new Map(ranked.map((r, i) => [r.n, i + 1]));
  const previous = comparisonSnapshot(history, now);

  const prs: DatasetPr[] = records.map((rec, i) => {
    const tech = technicalImportance(rec, rules, config.importance);
    const prevRank = previous?.prs[rec.number]?.[0];
    return {
      number: rec.number,
      title: rec.title,
      url: rec.url,
      author: rec.author,
      isDraft: rec.isDraft,
      baseRef: rec.baseRef,
      labels: rec.labels,
      createdAt: rec.createdAt,
      updatedAt: rec.listUpdatedAt ?? rec.updatedAt,
      lastActivityAt: lastActivityAt(rec, config.collection),
      additions: rec.additions,
      deletions: rec.deletions,
      changedFiles: rec.changedFiles,
      ciState: rec.ciState,
      detail: detailState(rec, config, now),
      fetchedAt: rec.fetchedAt,
      totals: rec.totals,
      metrics: allWindowMetrics(rec, now, config.windows, config.collection),
      trending: { ...trending[i], rank: rankOf.get(rec.number) ?? null, previousRank: prevRank ? prevRank : null },
      technical: { ...tech, relevantFiles: tech.relevantFiles.map((f) => f.path) },
      files: datasetFiles(rec, tech.relevantFiles),
    };
  });
  prs.sort((a, b) => b.number - a.number);

  const snapshot: Snapshot = {
    at: now.toISOString(),
    prs: Object.fromEntries(prs.map((p) => [p.number, [p.trending.rank ?? 0, p.trending.score, p.technical.score]])),
  };

  const dataset: Dataset = {
    schemaVersion: SCHEMA_VERSION,
    id: datasetId(now),
    generatedAt: now.toISOString(),
    repo: { owner: config.repo.owner, name: config.repo.name, url: `https://github.com/${config.repo.owner}/${config.repo.name}` },
    site: config.site,
    collection: { ...stats, source: input.source, startedAt: input.startedAt.toISOString(), finishedAt: new Date().toISOString() },
    windows: config.windows,
    scoring: { trending: config.trending, importance: config.importance, population },
    subsystems: rules.subsystems.map(({ id, name, description }) => ({ id, name, description })),
    history: { comparedTo: previous?.at ?? null, snapshots: history.snapshots.length },
    prs,
  };
  return { dataset, snapshot };
}
