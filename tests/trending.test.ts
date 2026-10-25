import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capPushesPerDay, markUnusual, trendingScore } from '../src/score/trending.ts';
import { ageHours } from '../src/util/time.ts';
import { config, ev, fromSpec, hoursAgo, NOW, record } from './helpers.ts';

const ctx = { now: NOW, config: config.trending, collection: config.collection };

test('20 substantive reviews yesterday outrank 200 comments spread over two years', () => {
  const old = fromSpec({
    number: 1,
    createdDaysAgo: 730,
    comments: [{ repeat: 200, authors: ['a', 'b', 'c'], startHoursAgo: 400, everyHours: 85 }],
    totals: { comments: 200 },
  });
  const hot = fromSpec({
    number: 2,
    createdDaysAgo: 40,
    reviews: Array.from({ length: 20 }, (_, i) => ({ author: `r${i % 6}`, hoursAgo: 10 + i, state: i % 4 === 0 ? 'APPROVED' : 'COMMENTED', inline: 3, body: 'see inline' })),
  });
  const a = trendingScore(old, ctx);
  const b = trendingScore(hot, ctx);
  assert.ok(old.totals.comments > hot.totals.reviews);
  assert.ok(b.score > 10 * a.score, `hot ${b.score} vs old ${a.score}`);
});

test('older activity decays: same events score lower the older they are', () => {
  const at = (h: number) => trendingScore(record({ events: [ev('comment', h), ev('review', h, { state: 'APPROVED' })] }), ctx).base;
  assert.ok(at(1) > at(72));
  assert.ok(at(72) > at(200));
  assert.equal(at(24 * 20), 0, 'outside the lookback window');
});

test('bots and CI trigger comments contribute nothing', () => {
  const noisy = record({
    events: [
      ...Array.from({ length: 10 }, (_, i) => ev('comment', i + 1, { actor: 'ceph-jenkins' })),
      ...Array.from({ length: 10 }, (_, i) => ev('comment', i + 1, { actor: 'x', actorIsBot: true })),
      ...Array.from({ length: 10 }, (_, i) => ev('comment', i + 1, { actor: 'dev', noise: true })),
    ],
  });
  const r = trendingScore(noisy, ctx);
  assert.equal(r.score, 0);
  assert.match(r.explanation[0], /No substantive activity/);
});

test('code size alone never makes an idle PR trend, and only nudges active ones', () => {
  const idleHuge = record({ additions: 50_000, deletions: 20_000 });
  assert.equal(trendingScore(idleHuge, ctx).score, 0);
  const push = [ev('force_push', 5)];
  const small = trendingScore(record({ additions: 5, deletions: 1, events: push }), ctx).components.code;
  const huge = trendingScore(record({ additions: 50_000, deletions: 20_000, events: push }), ctx).components.code;
  assert.ok(huge > small);
  assert.ok(huge <= small * (1 + config.trending.sizeFactor.max) + 0.1);
});

test('inline review comments are capped per review', () => {
  const capped = trendingScore(record({ events: [ev('review', 1, { state: 'COMMENTED', inline: 500 })] }), ctx).components.review;
  const max = config.trending.weights.reviewInlineCapPerReview * config.trending.weights.reviewInlineComment;
  assert.ok(capped <= max + 0.01, `${capped} <= ${max}`);
});

test('acceleration compares against the PR\'s own earlier activity', () => {
  const base = { createdAt: new Date(NOW.getTime() - 90 * 86400_000).toISOString() };
  const steadyEvents = Array.from({ length: 35 }, (_, d) => ev('comment', d * 24 + 3, { actor: `p${d % 3}` }));
  const steady = trendingScore(record({ ...base, events: steadyEvents }), ctx);
  const burstEvents = Array.from({ length: 10 }, (_, i) => ev('comment', i * 10 + 1, { actor: `p${i % 3}` }));
  const burst = trendingScore(record({ ...base, events: [...burstEvents, ev('comment', 500)] }), ctx);
  assert.equal(steady.acceleration.basis, 'own-history');
  assert.ok(Math.abs(steady.acceleration.multiplier - 1) < 0.1, `steady multiplier ${steady.acceleration.multiplier}`);
  assert.ok(burst.acceleration.multiplier > 1.4, `burst multiplier ${burst.acceleration.multiplier}`);
  assert.ok(burst.explanation.some((e) => /previous weekly activity/.test(e)));
});

test('no acceleration claim without enough history', () => {
  const young = trendingScore(record({ createdAt: new Date(NOW.getTime() - 5 * 86400_000).toISOString(), events: [ev('comment', 1)] }), ctx);
  assert.equal(young.acceleration.basis, 'new-pr');
  assert.equal(young.acceleration.multiplier, 1);
  const truncated = trendingScore(record({ eventsCompleteSince: new Date(NOW.getTime() - 3 * 86400_000).toISOString(), events: [ev('comment', 1)] }), ctx);
  assert.equal(truncated.acceleration.basis, 'truncated-history');
  assert.equal(truncated.acceleration.multiplier, 1);
});

test('PRs without detail data report no-detail instead of a fake zero', () => {
  const r = trendingScore(record({ detail: 'none' }), ctx);
  assert.equal(r.acceleration.basis, 'no-detail');
  assert.match(r.explanation[0], /not collected/);
});

test('unusual marks robust outliers only', () => {
  const results = [1, 2, 2, 3, 3, 4, 2, 60].map((recentWeighted) => ({
    score: 1, base: 1, components: { discussion: 0, review: 0, code: 0 }, unusual: false, explanation: [],
    acceleration: { basis: 'own-history' as const, ratio: 1, multiplier: 1, recentWeighted, baselineWeeklyWeighted: 1 },
  }));
  const pop = markUnusual(results, config.trending);
  assert.deepEqual(results.map((r) => r.unusual), [false, false, false, false, false, false, false, true]);
  assert.ok(pop.threshold >= config.trending.unusual.minWeightedEvents);
});

test('frequent force-pushes are capped per day in the score but reported in full', () => {
  const pushes = (n: number) => Array.from({ length: n }, (_, i) => ev('force_push', 1 + i * 0.6)); // n pushes within one day, 36 min apart
  const two = trendingScore(record({ events: pushes(2) }), ctx);
  const thirty = trendingScore(record({ events: pushes(30).filter((e) => ageHours(e.at, NOW) < 24) }), ctx);
  assert.ok(thirty.components.code <= two.components.code * 1.01, `${thirty.components.code} vs ${two.components.code}`);
  assert.match(thirty.explanation.join(' '), /counted, max 2\/day/);
  const days = [...pushes(1), ev('force_push', 30), ev('force_push', 54)]; // one push on each of 3 days
  assert.equal(capPushesPerDay([{ at: hoursAgo(1), commits: 0 }, { at: hoursAgo(2), commits: 0 }, { at: hoursAgo(3), commits: 0 }], NOW, 2).length, 2);
  assert.ok(trendingScore(record({ events: days }), ctx).components.code > two.components.code);
});
