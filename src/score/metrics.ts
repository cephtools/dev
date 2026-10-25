// Measured, windowed activity counts derived from normalized events.

import type { CollectionConfig } from '../config.ts';
import type { ActivityEvent, PrRecord, WindowDef, WindowMetrics } from '../types.ts';
import { inWindow, maxIso } from '../util/time.ts';

/** Human activity that counts as discussion/review: not bots, not CI trigger comments. */
export function isSubstantive(e: ActivityEvent, botLogins: string[]): boolean {
  if (e.actorIsBot || (e.actor && botLogins.includes(e.actor))) return false;
  if (e.kind === 'comment' && e.noise) return false;
  return true;
}

export interface Push {
  at: string;
  commits: number;
}

/**
 * Group commits and force-push events into "pushes". A rebase rewrites every commit's
 * committedDate and also emits a force-push event; clustering by time keeps such an
 * update from counting as N separate code changes.
 */
export function clusterPushes(events: ActivityEvent[], clusterMinutes: number): Push[] {
  const code = events.filter((e) => e.kind === 'commit' || e.kind === 'force_push').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const pushes: Push[] = [];
  const gap = clusterMinutes * 60_000;
  let clusterStart = -Infinity;
  for (const e of code) {
    const t = Date.parse(e.at);
    const last = pushes[pushes.length - 1];
    if (last && t - clusterStart <= gap) {
      last.at = e.at; // a push happens when its last piece lands
      if (e.kind === 'commit') last.commits++;
    } else {
      clusterStart = t;
      pushes.push({ at: e.at, commits: e.kind === 'commit' ? 1 : 0 });
    }
  }
  return pushes;
}

export function windowMetrics(rec: PrRecord, now: Date, hours: number, config: CollectionConfig, pushes = clusterPushes(rec.events, config.pushClusterMinutes)): WindowMetrics {
  const m: WindowMetrics = { comments: 0, reviews: 0, verdicts: 0, reviewComments: 0, commits: 0, pushes: 0, participants: 0 };
  const people = new Set<string>();
  for (const e of rec.events) {
    if (!inWindow(e.at, now, hours)) continue;
    if (e.kind === 'commit') {
      m.commits++;
      continue;
    }
    if (e.kind === 'force_push' || !isSubstantive(e, config.botLogins)) continue;
    if (e.kind === 'comment') m.comments++;
    if (e.kind === 'review') {
      m.reviews++;
      if (e.state === 'APPROVED' || e.state === 'CHANGES_REQUESTED') m.verdicts++;
      m.reviewComments += e.inline ?? 0;
    }
    if (e.actor && e.actor !== rec.author) people.add(e.actor);
  }
  m.pushes = pushes.filter((p) => inWindow(p.at, now, hours)).length;
  m.participants = people.size;
  return m;
}

export function allWindowMetrics(rec: PrRecord, now: Date, windows: WindowDef[], config: CollectionConfig): Record<string, WindowMetrics> {
  const pushes = clusterPushes(rec.events, config.pushClusterMinutes);
  return Object.fromEntries(windows.map((w) => [w.key, windowMetrics(rec, now, w.hours, config, pushes)]));
}

/** Latest substantive human activity (comment, review or push), ignoring bots and CI triggers. */
export function lastActivityAt(rec: PrRecord, config: CollectionConfig): string | null {
  let latest: string | null = null;
  for (const e of rec.events) {
    if (e.kind === 'commit' || e.kind === 'force_push' || isSubstantive(e, config.botLogins)) latest = maxIso(latest, e.at);
  }
  return latest;
}
