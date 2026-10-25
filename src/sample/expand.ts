// Expand compact fixture specs (relative times, repeated comments) into raw GraphQL
// nodes, so fixtures exercise the same normalize → score path as live data.

import type { RawPrDetailNode, RawPrListNode } from '../collect/normalize.ts';
import { HOUR_MS } from '../util/time.ts';

export interface FixtureComment { author: string; hoursAgo: number; body?: string; bot?: boolean; minimized?: boolean }
export interface FixtureCommentSeries { repeat: number; authors: string[]; startHoursAgo: number; everyHours: number; body?: string; bot?: boolean }
export interface FixtureReview { author: string; hoursAgo: number; state: string; inline?: number; body?: string }
export interface FixtureCommits { hoursAgo: number; count: number }

export interface FixtureSpec {
  number: number;
  title: string;
  author: string;
  authorBot?: boolean;
  createdDaysAgo: number;
  draft?: boolean;
  base?: string;
  labels?: string[];
  body?: string;
  files?: [string, number, number][];
  comments?: (FixtureComment | FixtureCommentSeries)[];
  reviews?: FixtureReview[];
  commits?: FixtureCommits[];
  forcePushesHoursAgo?: number[];
  ci?: string | null;
  /** Override GitHub totalCount values to simulate long histories / truncated connections. */
  totals?: { comments?: number; reviews?: number; commits?: number };
  /** Emit only list-level data (no detail fetched yet). */
  listOnly?: boolean;
  _comment?: string;
}

export interface FixtureFile {
  description?: string;
  prs: FixtureSpec[];
}

const iso = (now: Date, hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR_MS).toISOString();
const actor = (login: string, bot = false) => ({ login, __typename: bot ? 'Bot' : 'User' });

export function expandFixture(spec: FixtureSpec, now: Date, repoUrl = 'https://github.com/ceph/ceph'): { list: RawPrListNode; detail: RawPrDetailNode | null } {
  const files = (spec.files ?? []).map(([path, additions, deletions]) => ({ path, additions, deletions }));
  const comments: NonNullable<RawPrDetailNode['comments']>['nodes'] = [];
  let ci = 0;
  for (const c of spec.comments ?? []) {
    if ('repeat' in c) {
      for (let i = 0; i < c.repeat; i++) {
        comments.push({ id: `IC_${spec.number}_${ci++}`, createdAt: iso(now, c.startHoursAgo + i * c.everyHours), body: c.body ?? 'Looks reasonable, one question inline.', isMinimized: false, author: actor(c.authors[i % c.authors.length], c.bot) });
      }
    } else {
      comments.push({ id: `IC_${spec.number}_${ci++}`, createdAt: iso(now, c.hoursAgo), body: c.body ?? 'Comment.', isMinimized: !!c.minimized, author: actor(c.author, c.bot) });
    }
  }
  comments.sort((a, b) => Date.parse(a!.createdAt) - Date.parse(b!.createdAt));
  const reviews = (spec.reviews ?? []).map((r, i) => ({
    id: `PRR_${spec.number}_${i}`, state: r.state, submittedAt: r.state === 'PENDING' ? null : iso(now, r.hoursAgo),
    body: r.body ?? '', author: actor(r.author), comments: { totalCount: r.inline ?? 0 },
  }));
  const commits: { commit: { oid: string; committedDate: string } }[] = [];
  let oid = 0;
  for (const c of spec.commits ?? []) {
    for (let i = 0; i < c.count; i++) commits.push({ commit: { oid: `${spec.number.toString(16)}${(oid++).toString(16).padStart(8, '0')}`, committedDate: iso(now, c.hoursAgo + i * 0.01) } });
  }

  const times = [
    iso(now, spec.createdDaysAgo * 24),
    ...comments.map((c) => c!.createdAt),
    ...reviews.flatMap((r) => (r.submittedAt ? [r.submittedAt] : [])),
    ...commits.map((c) => c.commit.committedDate),
    ...(spec.forcePushesHoursAgo ?? []).map((h) => iso(now, h)),
  ];
  const updatedAt = times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));

  const list: RawPrListNode = {
    number: spec.number,
    title: spec.title,
    url: `${repoUrl}/pull/${spec.number}`,
    isDraft: !!spec.draft,
    createdAt: iso(now, spec.createdDaysAgo * 24),
    updatedAt,
    baseRefName: spec.base ?? 'main',
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
    author: actor(spec.author, spec.authorBot),
    labels: { nodes: (spec.labels ?? []).map((name) => ({ name })) },
  };
  if (spec.listOnly) return { list, detail: null };

  // Mimic GitHub's `last: 100` window on each connection.
  const last = <T>(arr: T[]) => arr.slice(-100);
  return {
    list,
    detail: {
      ...list,
      body: spec.body ?? '',
      comments: { totalCount: spec.totals?.comments ?? comments.length, nodes: last(comments) },
      reviews: { totalCount: spec.totals?.reviews ?? reviews.length, nodes: last(reviews) },
      commits: { totalCount: spec.totals?.commits ?? commits.length, nodes: last(commits) },
      lastCommit: { nodes: [{ commit: { statusCheckRollup: spec.ci === null ? null : { state: spec.ci ?? 'SUCCESS' } } }] },
      timelineItems: { nodes: (spec.forcePushesHoursAgo ?? []).map((h, i) => ({ id: `HRFPE_${spec.number}_${i}`, createdAt: iso(now, h), actor: actor(spec.author) })) },
      files: { totalCount: files.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: files },
    },
  };
}
