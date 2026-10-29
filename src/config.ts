import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WindowDef } from './types.ts';

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url));

export interface PathRule { pattern: string; weight: number; note: string }
export interface KeywordRule { pattern: string; weight: number }
export interface LabelRule { name: string; weight: number }

export interface SubsystemRule {
  id: string;
  name: string;
  description: string;
  requirePathEvidence?: boolean;
  paths: PathRule[];
  keywords: KeywordRule[];
  labels: LabelRule[];
}

export interface SignalRule { id: string; description: string; pattern: string; weight: number }

export interface ClassificationRules {
  excludePaths: { tests: string[]; docs: string[]; frontend: string[] };
  designDocPaths: string[];
  formatPaths: string[];
  coreAreas: { prefixes: string[]; minLinesPerArea: number; breadthThreshold: number; breadthWeightPerArea: number; breadthMax: number };
  mechanicalTitlePattern: string;
  signals: SignalRule[];
  subsystems: SubsystemRule[];
}

export interface TrendingConfig {
  halfLifeHours: number;
  lookbackDays: number;
  recentDays: number;
  baselineDays: number;
  weights: {
    comment: number;
    reviewVerdict: number;
    reviewSummary: number;
    reviewInlineComment: number;
    reviewInlineCapPerReview: number;
    push: number;
    pushesPerDayCap: number;
    participant: number;
    participantCap: number;
  };
  sizeFactor: { perDecade: number; max: number };
  acceleration: { slope: number; min: number; max: number; minBaselineDays: number };
  unusual: { madMultiplier: number; minWeightedEvents: number };
}

export interface ImportanceConfig {
  minScore: number;
  scale: number;
  assignThreshold: number;
  keywordCap: number;
  labelCap: number;
  secondarySubsystemWeight: number;
  secondarySubsystemCap: number;
  mechanicalMultiplier: number;
  backportMultiplier: number;
  mainBranches: string[];
  churn: { floor: number; perDecade: number };
  maxRelevantFiles: number;
}

export interface CollectionConfig {
  listPageSize: number;
  detailBatchSize: number;
  detailConcurrency: number;
  maxFilesPerPr: number;
  refreshAfterHours: number;
  maxDetailPrsPerRun: number;
  /** Cap for the first run (empty cache), so the first deploy happens within minutes. */
  bootstrapMaxDetailPrs: number;
  /** Also collect PRs merged or closed within this many days; 0 collects open PRs only. */
  closedDays: number;
  rateLimitReserve: number;
  maxRateLimitWaitSeconds: number;
  maxRetries: number;
  eventRetentionDays: number;
  bodyMaxChars: number;
  pushClusterMinutes: number;
  botLogins: string[];
  ignoreCommentPatterns: string[];
}

export interface DashboardConfig {
  repo: { owner: string; name: string };
  site: { title: string; refreshHours: number; staleAfterHours: number };
  collection: CollectionConfig;
  windows: WindowDef[];
  trending: TrendingConfig;
  importance: ImportanceConfig;
  history: { retentionDays: number; keepDatasets: number };
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(CONFIG_DIR + name, 'utf8')) as T;
}

/**
 * Load config/dashboard.json, applying environment overrides:
 *   PR_DASH_REPO=owner/name   change the target repository
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const config = readJson<DashboardConfig>('dashboard.json');
  const repo = env.PR_DASH_REPO?.trim();
  if (repo) {
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo);
    if (!m) throw new Error(`PR_DASH_REPO must look like "owner/name", got "${repo}"`);
    config.repo = { owner: m[1], name: m[2] };
  }
  return config;
}

export function loadRules(): ClassificationRules {
  return readJson<ClassificationRules>('subsystems.json');
}
