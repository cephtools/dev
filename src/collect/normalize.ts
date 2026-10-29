// Convert raw GraphQL PR nodes into PrRecords. All de-duplication keys are GitHub
// node ids (or commit oids), so the same activity is never counted twice.

import type { CollectionConfig } from '../config.ts';
import type { ActivityEvent, ChangedFile, PrRecord, PrState, ReviewState } from '../types.ts';
import { stripTemplate } from '../util/text.ts';

interface RawActor { login: string; __typename?: string }
interface RawConn<T> { totalCount?: number; nodes?: (T | null)[] | null; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }

export interface RawPrListNode {
  number: number;
  title: string;
  url: string;
  /** GitHub PullRequestState: OPEN, CLOSED or MERGED. */
  state?: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  baseRefName: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  author: RawActor | null;
  labels?: RawConn<{ name: string }> | null;
}

export interface RawPrDetailNode extends RawPrListNode {
  body?: string | null;
  comments?: RawConn<{ id: string; createdAt: string; body?: string; isMinimized?: boolean; author: RawActor | null }> | null;
  reviews?: RawConn<{ id: string; state: string; submittedAt: string | null; body?: string; author: RawActor | null; comments?: { totalCount: number } }> | null;
  commits?: RawConn<{ commit: { oid: string; committedDate: string } }> | null;
  lastCommit?: RawConn<{ commit: { statusCheckRollup: { state: string } | null } }> | null;
  timelineItems?: RawConn<{ id?: string; createdAt?: string; actor?: RawActor | null }> | null;
  files?: RawConn<ChangedFile> | null;
}

export interface NormalizeContext {
  config: CollectionConfig;
  now: Date;
}

const REVIEW_STATES = new Set<ReviewState>(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

function nodes<T>(conn: RawConn<T> | null | undefined): T[] {
  return (conn?.nodes ?? []).filter((n): n is T => n != null);
}

export function isBot(actor: RawActor | null | undefined, config: CollectionConfig): boolean {
  if (!actor) return false;
  return actor.__typename === 'Bot' || actor.login.endsWith('[bot]') || config.botLogins.includes(actor.login);
}

function compileIgnore(config: CollectionConfig): RegExp[] {
  return config.ignoreCommentPatterns.map((p) => new RegExp(p, 'i'));
}

function prState(state: string | undefined): PrState {
  return state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open';
}

/** Fields available from the PR list query; enough for a stub record. */
export function normalizeListNode(raw: RawPrListNode, config: CollectionConfig): PrRecord {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? null,
    authorIsBot: isBot(raw.author, config),
    state: prState(raw.state),
    isDraft: !!raw.isDraft,
    createdAt: raw.createdAt,
    closedAt: raw.closedAt ?? null,
    mergedAt: raw.mergedAt ?? null,
    updatedAt: raw.updatedAt,
    baseRef: raw.baseRefName ?? 'main',
    labels: nodes(raw.labels).map((l) => l.name),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    detail: 'none',
    fetchedAt: null,
    body: '',
    files: [],
    filesTruncated: false,
    totals: { comments: 0, reviews: 0, commits: 0 },
    ciState: null,
    events: [],
    eventsCompleteSince: null,
  };
}

/**
 * Normalize a full detail node. `extraFiles` are file pages fetched separately when
 * the PR touches more than 100 files.
 */
export function normalizeDetailNode(raw: RawPrDetailNode, ctx: NormalizeContext, extraFiles: ChangedFile[] = [], filesComplete = true): PrRecord {
  const { config } = ctx;
  const rec = normalizeListNode(raw, config);
  const ignore = compileIgnore(config);
  const events: ActivityEvent[] = [];
  // Oldest event returned by each connection that GitHub truncated (nodes < totalCount).
  const truncatedAt: string[] = [];

  const comments = nodes(raw.comments);
  for (const c of comments) {
    if (c.isMinimized) continue; // hidden as spam/outdated/off-topic
    const body = c.body ?? '';
    events.push({
      id: c.id,
      kind: 'comment',
      at: c.createdAt,
      actor: c.author?.login ?? null,
      actorIsBot: isBot(c.author, config),
      ...(ignore.some((re) => re.test(body)) ? { noise: true } : {}),
    });
  }
  if ((raw.comments?.totalCount ?? 0) > comments.length && comments.length) truncatedAt.push(oldest(comments.map((c) => c.createdAt)));

  const reviews = nodes(raw.reviews);
  for (const r of reviews) {
    // PENDING reviews are unsubmitted drafts and have no submittedAt.
    if (!r.submittedAt || !REVIEW_STATES.has(r.state as ReviewState)) continue;
    events.push({
      id: r.id,
      kind: 'review',
      at: r.submittedAt,
      actor: r.author?.login ?? null,
      actorIsBot: isBot(r.author, config),
      state: r.state as ReviewState,
      inline: r.comments?.totalCount ?? 0,
      hasBody: !!r.body?.trim(),
    });
  }
  const submitted = reviews.filter((r) => r.submittedAt);
  if ((raw.reviews?.totalCount ?? 0) > reviews.length && submitted.length) truncatedAt.push(oldest(submitted.map((r) => r.submittedAt!)));

  const commits = nodes(raw.commits);
  for (const c of commits) {
    events.push({ id: c.commit.oid, kind: 'commit', at: c.commit.committedDate, actor: rec.author, actorIsBot: false });
  }
  if ((raw.commits?.totalCount ?? 0) > commits.length && commits.length) truncatedAt.push(oldest(commits.map((c) => c.commit.committedDate)));

  for (const t of nodes(raw.timelineItems)) {
    if (!t.id || !t.createdAt) continue;
    events.push({ id: t.id, kind: 'force_push', at: t.createdAt, actor: t.actor?.login ?? null, actorIsBot: isBot(t.actor, config) });
  }

  const files = dedupeFiles([...nodes(raw.files), ...extraFiles]);
  const totalFiles = raw.files?.totalCount ?? raw.changedFiles ?? files.length;

  return {
    ...rec,
    detail: 'full',
    fetchedAt: ctx.now.toISOString(),
    body: stripTemplate(raw.body ?? '').slice(0, config.bodyMaxChars),
    files,
    filesTruncated: !filesComplete || files.length < totalFiles,
    totals: {
      comments: raw.comments?.totalCount ?? comments.length,
      reviews: raw.reviews?.totalCount ?? reviews.length,
      commits: raw.commits?.totalCount ?? commits.length,
    },
    ciState: nodes(raw.lastCommit)[0]?.commit.statusCheckRollup?.state ?? null,
    events: dedupeEvents(events),
    eventsCompleteSince: truncatedAt.length ? newest(truncatedAt) : null,
  };
}

export function dedupeEvents(events: ActivityEvent[]): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const e of events) byId.set(`${e.kind}:${e.id}`, e); // later occurrence wins (fresher data)
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function dedupeFiles(files: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const f of files) byPath.set(f.path, { path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 });
  return [...byPath.values()];
}

function oldest(times: string[]): string {
  return times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

function newest(times: string[]): string {
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}
