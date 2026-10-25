import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decay, inAgeRange, inWindow } from '../src/util/time.ts';
import { windowMetrics } from '../src/score/metrics.ts';
import { config, ev, hoursAgo, NOW, record } from './helpers.ts';

test('inWindow is half-open and excludes future timestamps', () => {
  assert.equal(inWindow(hoursAgo(0), NOW, 24), true);
  assert.equal(inWindow(hoursAgo(23.99), NOW, 24), true);
  assert.equal(inWindow(hoursAgo(24), NOW, 24), false);
  assert.equal(inWindow(hoursAgo(-1), NOW, 24), false);
});

test('inAgeRange selects [from, to) by age', () => {
  assert.equal(inAgeRange(hoursAgo(168), NOW, 168, 336), true);
  assert.equal(inAgeRange(hoursAgo(336), NOW, 168, 336), false);
  assert.equal(inAgeRange(hoursAgo(100), NOW, 168, 336), false);
});

test('decay halves every half-life, is 1 at age 0 and 0 past the cutoff', () => {
  assert.equal(decay(0, 72), 1);
  assert.equal(decay(72, 72), 0.5);
  assert.equal(decay(144, 72), 0.25);
  assert.equal(decay(-5, 72), 1, 'clock skew treated as now');
  assert.equal(decay(400, 72, 336), 0);
});

test('window metrics count each window independently', () => {
  const rec = record({
    events: [
      ev('comment', 2, { actor: 'a' }),
      ev('comment', 30, { actor: 'b' }),
      ev('comment', 200, { actor: 'c' }),
      ev('review', 10, { actor: 'a', state: 'APPROVED', inline: 2 }),
      ev('commit', 5),
    ],
  });
  const d1 = windowMetrics(rec, NOW, 24, config.collection);
  const d7 = windowMetrics(rec, NOW, 168, config.collection);
  const d30 = windowMetrics(rec, NOW, 720, config.collection);
  assert.deepEqual([d1.comments, d7.comments, d30.comments], [1, 2, 3]);
  assert.deepEqual([d1.reviews, d1.verdicts, d1.reviewComments], [1, 1, 2]);
  assert.equal(d1.participants, 1);
  assert.equal(d7.participants, 2);
  assert.equal(d1.commits, 1);
  assert.equal(d1.pushes, 1);
});

test('participants exclude the PR author and bots', () => {
  const rec = record({
    author: 'me',
    events: [ev('comment', 1, { actor: 'me' }), ev('comment', 1, { actor: 'ceph-jenkins' }), ev('comment', 1, { actor: 'bot', actorIsBot: true }), ev('comment', 1, { actor: 'you' })],
  });
  const m = windowMetrics(rec, NOW, 24, config.collection);
  assert.equal(m.comments, 2, 'bot comments are not counted');
  assert.equal(m.participants, 1);
});
