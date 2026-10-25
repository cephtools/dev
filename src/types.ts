// Shared types for the collector, scoring and dataset stages.

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

/**
 * One normalized unit of PR activity. `id` is the GitHub node id (or commit oid),
 * which is the de-duplication key across pages, batches and collection runs.
 */
export interface ActivityEvent {
  id: string;
  kind: 'comment' | 'review' | 'commit' | 'force_push';
  at: string;
  actor: string | null;
  actorIsBot: boolean;
  /** Comment matched an ignore pattern (e.g. "jenkins test make check"). */
  noise?: boolean;
  /** Review only. */
  state?: ReviewState;
  /** Review only: number of inline (diff) comments submitted with this review. */
  inline?: number;
  /** Review only: review has a non-empty summary body. */
  hasBody?: boolean;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/** A PR as stored in the collector cache. */
export interface PrRecord {
  number: number;
  title: string;
  url: string;
  author: string | null;
  authorIsBot: boolean;
  isDraft: boolean;
  createdAt: string;
  /** updatedAt as of the last detail fetch (or listing, for stubs). */
  updatedAt: string;
  /** updatedAt from the most recent listing; differs from updatedAt when details are stale. */
  listUpdatedAt?: string;
  baseRef: string;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  /** 'full' once a detail query succeeded; 'none' for list-only stubs. */
  detail: 'full' | 'none';
  fetchedAt: string | null;
  body: string;
  files: ChangedFile[];
  filesTruncated: boolean;
  /** Lifetime totals reported by GitHub (totalCount), independent of event retention. */
  totals: { comments: number; reviews: number; commits: number };
  ciState: string | null;
  events: ActivityEvent[];
  /**
   * Events are complete from this instant onward; null means complete for the PR's
   * whole life. Set when GitHub's per-connection limits truncated older events.
   */
  eventsCompleteSince: string | null;
}

export interface WindowDef {
  key: string;
  hours: number;
}

export interface WindowMetrics {
  comments: number;
  reviews: number;
  verdicts: number;
  reviewComments: number;
  commits: number;
  pushes: number;
  participants: number;
}

export interface Evidence {
  type: 'path' | 'keyword' | 'label' | 'breadth' | 'signal' | 'format' | 'design-doc';
  detail: string;
  weight: number;
  files?: string[];
}

export type Confidence = 'high' | 'medium' | 'low';

export interface SubsystemMatch {
  id: string;
  score: number;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface TechnicalResult {
  score: number;
  raw: number;
  important: boolean;
  confidence: Confidence | null;
  subsystems: SubsystemMatch[];
  signals: Evidence[];
  explanation: string;
  relevantFiles: ChangedFile[];
  coreLines: number;
  flags: { backport: boolean; mechanical: boolean; testOnly: boolean; docsOnly: boolean; filesTruncated: boolean };
}

export interface TrendingResult {
  score: number;
  base: number;
  components: { discussion: number; review: number; code: number };
  acceleration: {
    basis: 'own-history' | 'new-pr' | 'truncated-history' | 'no-detail';
    ratio: number | null;
    multiplier: number;
    recentWeighted: number;
    baselineWeeklyWeighted: number | null;
  };
  unusual: boolean;
  explanation: string[];
}
