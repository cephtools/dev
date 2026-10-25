import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRecord } from '../src/collect/cache.ts';
import { dedupeEvents, normalizeDetailNode, type RawPrDetailNode } from '../src/collect/normalize.ts';
import { clusterPushes, windowMetrics } from '../src/score/metrics.ts';
import { config, ev, hoursAgo, NOW, record } from './helpers.ts';

const actor = (login: string) => ({ login, __typename: 'User' });

function rawNode(over: Partial<RawPrDetailNode> = {}): RawPrDetailNode {
  return {
    number: 7, title: 't', url: 'u', isDraft: false, createdAt: hoursAgo(500), updatedAt: hoursAgo(1), baseRefName: 'main',
    author: actor('me'), labels: { nodes: [] }, body: '',
    comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, commits: { totalCount: 0, nodes: [] },
    timelineItems: { nodes: [] }, files: { totalCount: 0, nodes: [] },
    ...over,
  };
}

test('the same node id is counted once, even if returned twice', () => {
  const c = { id: 'IC_1', createdAt: hoursAgo(2), body: 'hi', author: actor('a') };
  const rec = normalizeDetailNode(rawNode({ comments: { totalCount: 2, nodes: [c, c] } }), { config: config.collection, now: NOW });
  assert.equal(rec.events.filter((e) => e.kind === 'comment').length, 1);
});

test('inline review comments are counted via their review, never as issue comments', () => {
  const rec = normalizeDetailNode(rawNode({
    comments: { totalCount: 1, nodes: [{ id: 'IC_1', createdAt: hoursAgo(2), body: 'general', author: actor('a') }] },
    reviews: { totalCount: 1, nodes: [{ id: 'R_1', state: 'COMMENTED', submittedAt: hoursAgo(3), body: '', author: actor('b'), comments: { totalCount: 4 } }] },
  }), { config: config.collection, now: NOW });
  const m = windowMetrics(rec, NOW, 24, config.collection);
  assert.equal(m.comments, 1);
  assert.equal(m.reviews, 1);
  assert.equal(m.reviewComments, 4);
});

test('pending reviews and minimized comments are ignored; CI triggers are marked noise', () => {
  const rec = normalizeDetailNode(rawNode({
    comments: { totalCount: 3, nodes: [
      { id: 'IC_1', createdAt: hoursAgo(2), body: 'spam', isMinimized: true, author: actor('a') },
      { id: 'IC_2', createdAt: hoursAgo(2), body: 'jenkins test make check', author: actor('me') },
      { id: 'IC_3', createdAt: hoursAgo(2), body: 'jenkins retest this please', author: actor('me') },
    ] },
    reviews: { totalCount: 1, nodes: [{ id: 'R_1', state: 'PENDING', submittedAt: null, author: actor('b') }] },
  }), { config: config.collection, now: NOW });
  assert.equal(rec.events.filter((e) => e.kind === 'review').length, 0);
  const comments = rec.events.filter((e) => e.kind === 'comment');
  assert.equal(comments.length, 2);
  assert.ok(comments.every((e) => e.noise));
  assert.equal(windowMetrics(rec, NOW, 24, config.collection).comments, 0);
});

test('a rebase (force push + rewritten commits) counts as one push', () => {
  const events = [
    ev('force_push', 10),
    ...Array.from({ length: 8 }, (_, i) => ev('commit', 10 + i * 0.01)),
    ev('commit', 2),
  ];
  const pushes = clusterPushes(events, config.collection.pushClusterMinutes);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].commits, 8);
});

test('dedupeEvents keeps the latest copy and sorts by time', () => {
  const a = { id: 'X', kind: 'comment' as const, at: hoursAgo(5), actor: 'a', actorIsBot: false };
  const b = { ...a, actor: 'edited' };
  const out = dedupeEvents([b, ev('comment', 9), a]);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.id === 'X')!.actor, 'a');
  assert.ok(Date.parse(out[0].at) < Date.parse(out[1].at));
});

test('cache merge never duplicates events across runs', () => {
  const shared = ev('comment', 50, { id: 'SAME' });
  const cached = record({ events: [ev('comment', 300, { id: 'OLD' }), shared], fetchedAt: hoursAgo(40) });
  // Fresh fetch is truncated at 100h: it saw SAME and a new one, but not OLD.
  const fresh = record({ events: [shared, ev('comment', 1, { id: 'NEW' })], eventsCompleteSince: hoursAgo(100) });
  const merged = mergeRecord(cached, fresh, NOW, 120);
  assert.deepEqual(merged.events.map((e) => e.id), ['OLD', 'SAME', 'NEW']);
  assert.equal(merged.eventsCompleteSince, null, 'cached fetch overlapped the truncation point');
});

test('cache merge drops events deleted on GitHub when the fresh fetch is complete', () => {
  const cached = record({ events: [ev('comment', 30, { id: 'DELETED' }), ev('comment', 20, { id: 'KEPT' })] });
  const fresh = record({ events: [ev('comment', 20, { id: 'KEPT' })], eventsCompleteSince: null });
  assert.deepEqual(mergeRecord(cached, fresh, NOW, 120).events.map((e) => e.id), ['KEPT']);
});

test('cache merge marks a gap when cached data does not reach the truncation point', () => {
  const cached = record({ events: [ev('comment', 900)], fetchedAt: hoursAgo(800) });
  const fresh = record({ events: [ev('comment', 1)], eventsCompleteSince: hoursAgo(100) });
  assert.equal(mergeRecord(cached, fresh, NOW, 120).eventsCompleteSince, hoursAgo(100));
});

test('event retention trims old events and records the incompleteness', () => {
  const fresh = record({ events: [ev('comment', 24 * 200), ev('comment', 1)] });
  const merged = mergeRecord(undefined, fresh, NOW, 120);
  assert.equal(merged.events.length, 1);
  assert.ok(merged.eventsCompleteSince);
});

test('truncated connections set eventsCompleteSince to the oldest returned event', () => {
  const nodes = Array.from({ length: 3 }, (_, i) => ({ id: `C${i}`, createdAt: hoursAgo(10 - i), body: 'x', author: actor('a') }));
  const rec = normalizeDetailNode(rawNode({ comments: { totalCount: 250, nodes } }), { config: config.collection, now: NOW });
  assert.equal(rec.eventsCompleteSince, hoursAgo(10));
  assert.equal(rec.totals.comments, 250);
});
