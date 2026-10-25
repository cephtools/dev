// Trending score: decayed recent activity, adjusted by acceleration against the PR's
// own earlier activity. Every term is reported so the UI can explain the number.
//
//   base  = discussion + review + code           (each a sum of weight × decay(age))
//   score = base × acceleration multiplier
//
// Lifetime totals are deliberately absent: only events inside the lookback window count.

import type { CollectionConfig, TrendingConfig } from '../config.ts';
import type { ActivityEvent, PrRecord, TrendingResult } from '../types.ts';
import { ageHours, decay, inAgeRange, inWindow, round } from '../util/time.ts';
import { clusterPushes, isSubstantive, type Push } from './metrics.ts';

export interface TrendingContext {
  now: Date;
  config: TrendingConfig;
  collection: CollectionConfig;
}

function reviewWeight(e: ActivityEvent, w: TrendingConfig['weights']): number {
  let weight = 0;
  if (e.state === 'APPROVED' || e.state === 'CHANGES_REQUESTED') weight += w.reviewVerdict;
  else if (e.hasBody) weight += w.reviewSummary;
  weight += Math.min(e.inline ?? 0, w.reviewInlineCapPerReview) * w.reviewInlineComment;
  // A COMMENTED review with neither body nor inline comments still signals a look.
  return weight || w.reviewInlineComment;
}

/**
 * Keep at most `perDay` pushes (the newest) in each 24h age bucket. Iterating on a
 * WIP branch with dozens of force-pushes is not dozens of times more interesting.
 */
export function capPushesPerDay(pushes: Push[], now: Date, perDay: number): Push[] {
  const buckets = new Map<number, Push[]>();
  for (const p of pushes) {
    const day = Math.floor(Math.max(0, ageHours(p.at, now)) / 24);
    buckets.set(day, [...(buckets.get(day) ?? []), p]);
  }
  return [...buckets.values()].flatMap((b) => b.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, perDay));
}

/** Undecayed weight of substantive events and pushes in an age range (hours). */
function weightedActivity(rec: PrRecord, pushes: Push[], ctx: TrendingContext, fromH: number, toH: number): number {
  const w = ctx.config.weights;
  let total = 0;
  for (const e of rec.events) {
    if (!inAgeRange(e.at, ctx.now, fromH, toH) || !isSubstantive(e, ctx.collection.botLogins)) continue;
    if (e.kind === 'comment') total += w.comment;
    else if (e.kind === 'review') total += reviewWeight(e, w);
  }
  for (const p of pushes) if (inAgeRange(p.at, ctx.now, fromH, toH)) total += w.push;
  return total;
}

export function trendingScore(rec: PrRecord, ctx: TrendingContext): TrendingResult {
  const { config, now } = ctx;
  const w = config.weights;
  const lookbackH = config.lookbackDays * 24;
  const recentH = config.recentDays * 24;

  if (rec.detail !== 'full') {
    return {
      score: 0,
      base: 0,
      components: { discussion: 0, review: 0, code: 0 },
      acceleration: { basis: 'no-detail', ratio: null, multiplier: 1, recentWeighted: 0, baselineWeeklyWeighted: null },
      unusual: false,
      explanation: ['Activity details not collected yet; score unavailable.'],
    };
  }

  let discussion = 0;
  let review = 0;
  let commentsRecent = 0;
  let reviewsRecent = 0;
  let verdictsRecent = 0;
  let inlineRecent = 0;
  const participants = new Set<string>();

  for (const e of rec.events) {
    if (e.kind !== 'comment' && e.kind !== 'review') continue;
    if (!isSubstantive(e, ctx.collection.botLogins)) continue;
    const d = decay(ageHours(e.at, now), config.halfLifeHours, lookbackH);
    if (d === 0) continue;
    if (e.kind === 'comment') discussion += w.comment * d;
    else review += reviewWeight(e, w) * d;
    if (inWindow(e.at, now, recentH)) {
      if (e.actor && e.actor !== rec.author) participants.add(e.actor);
      if (e.kind === 'comment') commentsRecent++;
      else {
        reviewsRecent++;
        inlineRecent += e.inline ?? 0;
        if (e.state === 'APPROVED' || e.state === 'CHANGES_REQUESTED') verdictsRecent++;
      }
    }
  }
  // Distinct people matter more than one person posting many comments.
  discussion += w.participant * Math.min(participants.size, w.participantCap);

  const allPushes = clusterPushes(rec.events, ctx.collection.pushClusterMinutes);
  const pushes = capPushesPerDay(allPushes, now, w.pushesPerDayCap);
  let code = 0;
  for (const p of pushes) code += w.push * decay(ageHours(p.at, now), config.halfLifeHours, lookbackH);
  const pushesRecent = allPushes.filter((p) => inWindow(p.at, now, recentH)).length;
  const pushesRecentCounted = pushes.filter((p) => inWindow(p.at, now, recentH)).length;
  // Size nudges code activity slightly; it can never make an idle PR trend.
  const lines = rec.additions + rec.deletions;
  const sizeBoost = Math.min(config.sizeFactor.max, config.sizeFactor.perDecade * Math.log10(1 + lines));
  code *= 1 + sizeBoost;

  const base = discussion + review + code;

  // Acceleration: last `recentDays` vs the weekly average of the preceding `baselineDays`.
  const recentWeighted = weightedActivity(rec, pushes, ctx, 0, recentH);
  const baselineH = config.baselineDays * 24;
  const prAgeH = ageHours(rec.createdAt, now);
  const completeSinceAgeH = rec.eventsCompleteSince ? ageHours(rec.eventsCompleteSince, now) : Infinity;
  const minBaselineH = config.acceleration.minBaselineDays * 24;
  let acceleration: TrendingResult['acceleration'];
  if (prAgeH < recentH + minBaselineH) {
    acceleration = { basis: 'new-pr', ratio: null, multiplier: 1, recentWeighted: round(recentWeighted), baselineWeeklyWeighted: null };
  } else if (completeSinceAgeH < recentH + minBaselineH) {
    acceleration = { basis: 'truncated-history', ratio: null, multiplier: 1, recentWeighted: round(recentWeighted), baselineWeeklyWeighted: null };
  } else {
    // Baseline window is limited by PR age and by how far back events are complete.
    const baselineEndH = Math.min(recentH + baselineH, prAgeH, completeSinceAgeH);
    const baselineWeeks = (baselineEndH - recentH) / (7 * 24);
    const weekly = weightedActivity(rec, pushes, ctx, recentH, baselineEndH) / baselineWeeks;
    const recentWeekly = recentWeighted / (recentH / (7 * 24));
    const ratio = (recentWeekly + 1) / (weekly + 1);
    const a = config.acceleration;
    const multiplier = Math.min(a.max, Math.max(a.min, 1 + a.slope * Math.log2(ratio)));
    acceleration = { basis: 'own-history', ratio: round(ratio, 1), multiplier: round(multiplier, 2), recentWeighted: round(recentWeighted), baselineWeeklyWeighted: round(weekly) };
  }

  const score = base * acceleration.multiplier;

  const explanation: string[] = [];
  const days = config.recentDays;
  if (reviewsRecent) {
    const verdictNote = verdictsRecent ? ` (${verdictsRecent} approve/request-changes)` : '';
    const inlineNote = inlineRecent ? `, ${inlineRecent} inline comments` : '';
    explanation.push(`${reviewsRecent} review${reviewsRecent > 1 ? 's' : ''}${verdictNote}${inlineNote} in ${days}d`);
  }
  if (commentsRecent) explanation.push(`${commentsRecent} comment${commentsRecent > 1 ? 's' : ''} from ${participants.size} other participant${participants.size === 1 ? '' : 's'} in ${days}d`);
  if (pushesRecent) {
    const capped = pushesRecentCounted < pushesRecent ? ` (${pushesRecentCounted} counted, max ${w.pushesPerDayCap}/day)` : '';
    explanation.push(`${pushesRecent} code push${pushesRecent > 1 ? 'es' : ''} in ${days}d${capped}`);
  }
  if (acceleration.basis === 'own-history' && acceleration.ratio !== null) {
    if (acceleration.ratio >= 1.5) explanation.push(`${acceleration.ratio}× its previous weekly activity`);
    else if (acceleration.ratio <= 0.67) explanation.push(`slowing: ${acceleration.ratio}× its previous weekly activity`);
  } else if (acceleration.basis === 'new-pr' && base > 0) {
    explanation.push('new PR: no earlier baseline to compare against');
  }
  if (!explanation.length) explanation.push(`No substantive activity in the last ${config.lookbackDays} days`);

  return {
    score: round(score),
    base: round(base),
    components: { discussion: round(discussion), review: round(review), code: round(code) },
    acceleration,
    unusual: false,
    explanation,
  };
}

/**
 * Population comparison: mark PRs whose recent weighted activity is far above that of
 * comparable open PRs (those with any recent activity), using median + k × MAD.
 * Returns the threshold so the UI can show it. This is a robust heuristic, not a
 * statistical significance test.
 */
export function markUnusual(results: TrendingResult[], config: TrendingConfig): { median: number; mad: number; threshold: number; population: number } {
  const active = results.map((r) => r.acceleration.recentWeighted).filter((v) => v > 0).sort((a, b) => a - b);
  const median = quantile(active, 0.5);
  const mad = quantile(active.map((v) => Math.abs(v - median)).sort((a, b) => a - b), 0.5);
  // 1.4826 × MAD estimates a standard deviation for roughly normal data.
  const threshold = Math.max(config.unusual.minWeightedEvents, median + config.unusual.madMultiplier * 1.4826 * Math.max(mad, 1));
  for (const r of results) {
    if (r.acceleration.recentWeighted >= threshold) {
      r.unusual = true;
      r.explanation.push(`recent activity ${r.acceleration.recentWeighted} vs ${round(median)} for a typical active PR`);
    }
  }
  return { median: round(median), mad: round(mad), threshold: round(threshold), population: active.length };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
