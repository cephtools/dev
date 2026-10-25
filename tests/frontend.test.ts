// Frontend modules are plain ES modules without DOM access, so they run in Node.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffAnchor, esc, relTime } from '../site/js/format.js';
import { applyFilters, buildHash, parseHash, sortPrs } from '../site/js/state.js';
import { renderAbout, renderBanners, renderDetail, renderList, renderSubsystems, renderTechnicalCard, renderTrendingCard } from '../site/js/render.js';
import { sampleDataset } from '../src/sample/dataset.ts';
import { NOW } from './helpers.ts';

const { dataset } = JSON.parse(JSON.stringify(sampleDataset(NOW))) as ReturnType<typeof sampleDataset>;
const ctx = { dataset, win: '7d', now: NOW };
const filters = parseHash('').filters;
const pr = (n: number) => dataset.prs.find((p) => p.number === n)!;

test('escaping prevents HTML injection from PR titles and labels', () => {
  const evil = structuredClone(pr(61001));
  evil.title = '<img src=x onerror=alert(1)>';
  evil.labels = ['"><script>'];
  const html = renderTrendingCard(evil, ctx) + renderTechnicalCard(evil, ctx) + renderDetail(evil, ctx);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>'));
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('trending card shows score, explanation, metrics and GitHub link', () => {
  const html = renderTrendingCard(pr(61001), ctx);
  assert.match(html, /#61001/);
  assert.match(html, new RegExp(`>${pr(61001).trending.score}<`));
  assert.match(html, /href="https:\/\/github.com\/ceph\/ceph\/pull\/61001"/);
  assert.match(html, /7d:/);
  assert.match(html, /comments/);
  assert.match(html, /"badge hot"/);
});

test('technical card shows subsystems, confidence, explanation and relevant files', () => {
  const html = renderTechnicalCard(pr(61002), ctx);
  assert.match(html, /BlueStore/);
  assert.match(html, /High confidence/);
  assert.match(html, /bluestore_types/);
  assert.match(html, /no discussion in 30d/);
  assert.match(html, /\+\d+ more/);
});

test('detail panel separates measured metrics from heuristic scores', () => {
  const html = renderDetail(pr(61002), ctx);
  assert.match(html, /tag measured/);
  assert.match(html, /tag heuristic/);
  assert.match(html, /Cross-cutting signals/);
  assert.match(html, /<a href="https:\/\/github.com\/ceph\/ceph\/pull\/61002\/files" data-path="src\/os\/bluestore\/bluestore_types\.cc"/);
  const missing = renderDetail(pr(61013), ctx);
  assert.match(missing, /not been collected/);
});

test('filters: views, subsystem, draft status, backports, author, search', () => {
  const trending = applyFilters(dataset.prs, 'trending', filters, dataset);
  assert.ok(trending.every((p) => p.trending.score > 0));
  const technical = applyFilters(dataset.prs, 'technical', filters, dataset);
  assert.ok(technical.every((p) => p.technical.score >= dataset.scoring.importance.minScore));
  assert.ok(technical.some((p) => p.number === 61002));
  assert.ok(!technical.some((p) => p.number === 61001));

  const bs = applyFilters(dataset.prs, 'technical', { ...filters, sub: 'bluestore', min: '0' }, dataset);
  assert.ok(bs.length > 0 && bs.every((p) => p.technical.subsystems.some((s: { id: string }) => s.id === 'bluestore')));
  assert.deepEqual(applyFilters(dataset.prs, 'trending', { ...filters, status: 'draft' }, dataset).map((p) => p.number), [61010]);
  assert.ok(!applyFilters(dataset.prs, 'technical', { ...filters, backports: '', min: '0' }, dataset).some((p) => p.baseRef !== 'main'));
  assert.deepEqual(applyFilters(dataset.prs, 'subsystems', { ...filters, author: 'StorageDev' }, dataset).map((p) => p.number), [61002]);
  assert.deepEqual(applyFilters(dataset.prs, 'subsystems', { ...filters, q: 'mclock' }, dataset).map((p) => p.number), [61016]);
});

test('sorting: each view sorts independently', () => {
  const t = sortPrs(applyFilters(dataset.prs, 'trending', filters, dataset), 'trending', '', '7d');
  assert.equal(t[0].number, 61001);
  const quiet = sortPrs(applyFilters(dataset.prs, 'technical', filters, dataset), 'technical', 'quiet', '7d');
  assert.equal(quiet[0].metrics['30d'].comments, 0);
  const upd = sortPrs(dataset.prs, 'trending', 'updated', '7d');
  for (let i = 1; i < upd.length; i++) {
    assert.ok(Date.parse(upd[i - 1].lastActivityAt ?? upd[i - 1].updatedAt) >= Date.parse(upd[i].lastActivityAt ?? upd[i].updatedAt));
  }
});

test('hash state round-trips', () => {
  const f = { ...filters, sub: 'crimson', status: 'draft', q: 'a b', sort: 'reviews' };
  const hash = buildHash('technical', f, 61003);
  const parsed = parseHash(hash);
  assert.equal(parsed.view, 'technical');
  assert.deepEqual(parsed.filters, f);
  assert.equal(parsed.pr, 61003);
  assert.equal(parseHash('#/nonsense').view, 'trending');
});

test('banners: failure, stale, sample and partial states', () => {
  const failed = renderBanners(dataset, { ok: false, error: 'RateLimitError: x', lastAttemptAt: NOW.toISOString() }, NOW);
  assert.ok(failed.some((b) => b.level === 'error' && /RateLimitError/.test(b.html)));
  const later = new Date(NOW.getTime() + 2 * 86400_000);
  assert.ok(renderBanners(dataset, { ok: true }, later).some((b) => b.level === 'warn' && /old/.test(b.html)));
  assert.ok(!renderBanners(dataset, { ok: true }, NOW).some((b) => b.level === 'warn'));
  assert.ok(renderBanners(dataset, null, NOW).some((b) => /Sample data/.test(b.html)));
  assert.ok(renderBanners(dataset, null, NOW).some((b) => /Partial collection/.test(b.html)));
  assert.ok(renderBanners(null, { ok: false, error: 'boom', lastAttemptAt: NOW.toISOString() }, NOW).some((b) => /boom/.test(b.html)));
});

test('list pagination, subsystems and about render', () => {
  const html = renderList(dataset.prs, 'trending', ctx, 3);
  assert.equal((html.match(/<article/g) ?? []).length, 3);
  assert.match(html, /Show more \(13 remaining\)/);
  const subs = renderSubsystems(dataset.prs, ctx);
  for (const s of dataset.subsystems) assert.ok(subs.includes(s.name.replace('&', '&amp;')));
  assert.match(renderAbout(ctx), /Acceleration/);
});

test('relative time formatting', () => {
  assert.equal(relTime(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW), '3h ago');
  assert.equal(relTime(new Date(NOW.getTime() - 5 * 86400_000).toISOString(), NOW), '5d ago');
  assert.equal(relTime(null, NOW), 'never');
});

test('file anchors computed in the browser match GitHub diff fragments', async () => {
  const { createHash } = await import('node:crypto');
  const path = 'src/os/bluestore/BlueStore.cc';
  assert.equal(await diffAnchor(path), `diff-${createHash('sha256').update(path).digest('hex')}`);
});
