// End-to-end checks on the representative fixtures (tests/fixtures/prs.json).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDataset, sampleRecords } from '../src/sample/dataset.ts';
import { technicalImportance } from '../src/score/importance.ts';
import { trendingScore } from '../src/score/trending.ts';
import { config, NOW, rules } from './helpers.ts';

const { dataset } = sampleDataset(NOW);
const pr = (n: number) => dataset.prs.find((p) => p.number === n)!;
const trendRank = (n: number) => pr(n).trending.rank ?? Infinity;

test('highly discussed dashboard PR trends but is not technically important', () => {
  const p = pr(61001);
  assert.equal(p.trending.rank, 1);
  assert.ok(p.metrics['7d'].comments >= 20);
  assert.equal(p.technical.important, false);
  assert.equal(p.technical.score, 0);
});

test('silent BlueStore on-disk change is technically important despite no discussion', () => {
  const p = pr(61002);
  assert.equal(p.metrics['30d'].comments + p.metrics['30d'].reviews, 0);
  assert.ok(p.technical.important);
  assert.equal(p.technical.subsystems[0].id, 'bluestore');
  assert.equal(p.technical.confidence, 'high');
  assert.ok(p.technical.score > pr(61001).technical.score);
  assert.ok(trendRank(61002) > trendRank(61001));
});

test('silent cross-subsystem ObjectStore interface change ranks at the top of technical importance', () => {
  const top = [...dataset.prs].sort((a, b) => b.technical.score - a.technical.score)[0];
  assert.equal(top.number, 61015);
  assert.ok(top.technical.subsystems.some((s) => s.id === 'architecture'));
  assert.equal(top.totals.comments, 0);
});

test('technical importance is independent of popularity', () => {
  const records = sampleRecords(NOW);
  const quiet = records.find((r) => r.number === 61002)!;
  // Same PR, now with a flood of discussion and reviews.
  const loud = structuredClone(quiet);
  for (let i = 0; i < 80; i++) loud.events.push({ id: `L${i}`, kind: 'comment', at: new Date(NOW.getTime() - i * 3_600_000).toISOString(), actor: `u${i % 9}`, actorIsBot: false });
  loud.totals.comments = 80;
  const a = technicalImportance(quiet, rules, config.importance);
  const b = technicalImportance(loud, rules, config.importance);
  assert.deepEqual(b, a);
  const ctx = { now: NOW, config: config.trending, collection: config.collection };
  assert.ok(trendingScore(loud, ctx).score > trendingScore(quiet, ctx).score);
});

test('long-lived PR with many lifetime comments but little recent activity does not trend', () => {
  const p = pr(60420);
  assert.ok(p.totals.comments > 200);
  assert.ok(trendRank(60420) > trendRank(61016));
  assert.equal(p.trending.acceleration.basis, 'own-history');
  assert.equal(p.technical.important, false, 'large rgw change is not tracked as storage-core importance');
});

test('accelerating older PR is flagged against its own baseline', () => {
  const p = pr(61016);
  assert.equal(p.trending.acceleration.basis, 'own-history');
  assert.ok(p.trending.acceleration.multiplier > 1.3);
});

test('noise-only PR (CI triggers, bots) has no discussion', () => {
  const p = pr(61014);
  assert.equal(p.metrics['7d'].comments, 0);
  assert.ok(p.trending.score < 2);
});

test('list-only PR is kept and marked missing, not dropped', () => {
  const p = pr(61013);
  assert.equal(p.detail, 'missing');
  assert.equal(p.trending.acceleration.basis, 'no-detail');
  assert.equal(dataset.collection.missing, 1);
  assert.ok(dataset.collection.partial);
});

test('recently merged PR keeps its scores but takes no trending rank', () => {
  const p = pr(60990);
  assert.equal(p.state, 'merged');
  assert.ok(p.mergedAt);
  assert.ok(p.technical.important);
  assert.ok(p.trending.score > 0);
  assert.equal(p.trending.rank, null);
  assert.equal(pr(60975).state, 'closed');
  assert.equal(pr(60975).mergedAt, null);
  const ranks = dataset.prs.flatMap((x) => (x.trending.rank === null ? [] : [x.trending.rank])).sort((a, b) => a - b);
  assert.deepEqual(ranks, ranks.map((_, i) => i + 1), 'open PRs are ranked 1..n without gaps');
  assert.equal(dataset.scoring.population.population, dataset.prs.filter((x) => x.state === 'open' && x.trending.acceleration.recentWeighted > 0).length);
});

test('dataset covers every fixture PR', () => {
  assert.equal(dataset.prs.length, sampleRecords(NOW).length);
});
