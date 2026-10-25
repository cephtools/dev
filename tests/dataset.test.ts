import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { datasetId, diffAnchor } from '../src/dataset/build.ts';
import { appendSnapshot, comparisonSnapshot } from '../src/dataset/history.ts';
import { publishDataset, readManifest, ValidationError } from '../src/dataset/publish.ts';
import { validate } from '../src/dataset/validate.ts';
import { sampleDataset } from '../src/sample/dataset.ts';
import { NOW } from './helpers.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'prdash-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('sample dataset conforms to the JSON schema', () => {
  const { dataset } = sampleDataset(NOW);
  assert.deepEqual(validate(JSON.parse(JSON.stringify(dataset))), []);
});

test('schema validation catches type errors, missing fields and bad enums', () => {
  const { dataset } = sampleDataset(NOW);
  const bad = JSON.parse(JSON.stringify(dataset));
  bad.prs[0].number = 'x';
  delete bad.prs[1].trending;
  bad.prs[2].detail = 'unknown';
  bad.prs[3].technical.score = 140;
  const errors = validate(bad);
  assert.ok(errors.some((e) => /prs\[0\]\.number/.test(e)));
  assert.ok(errors.some((e) => /prs\[1\].*trending/.test(e)));
  assert.ok(errors.some((e) => /prs\[2\]\.detail/.test(e)));
  assert.ok(errors.some((e) => /prs\[3\]\.technical\.score/.test(e)));
});

test('publish writes a versioned dataset then points the manifest at it', () => {
  const dir = tmp();
  const first = sampleDataset(NOW).dataset;
  const m1 = publishDataset(dir, first, 2);
  assert.equal(readManifest(dir)!.dataset, `datasets/${first.id}.json`);
  const second = sampleDataset(new Date(NOW.getTime() + 3_600_000)).dataset;
  publishDataset(dir, second, 2);
  const third = sampleDataset(new Date(NOW.getTime() + 7_200_000)).dataset;
  publishDataset(dir, third, 2);
  const files = readdirSync(join(dir, 'datasets')).sort();
  assert.deepEqual(files, [`${second.id}.json`, `${third.id}.json`], 'keeps the newest N datasets');
  assert.ok(!files.includes(`${m1.id}.json`));
  assert.equal(readManifest(dir)!.id, third.id);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
  assert.equal(JSON.parse(readFileSync(join(dir, readManifest(dir)!.dataset), 'utf8')).id, third.id);
});

test('an invalid dataset is rejected and the previous manifest stays intact', () => {
  const dir = tmp();
  const good = sampleDataset(NOW).dataset;
  publishDataset(dir, good, 3);
  const bad = { ...sampleDataset(new Date(NOW.getTime() + 1000)).dataset, prs: [] as never[] };
  assert.throws(() => publishDataset(dir, bad, 3), ValidationError, 'listed PRs but empty list');
  assert.equal(readManifest(dir)!.id, good.id);
});

test('dataset ids sort chronologically and anchors match GitHub diff fragments', () => {
  assert.equal(datasetId(new Date('2026-10-25T09:05:03.123Z')), '20261025T090503Z');
  assert.ok(datasetId(new Date('2026-10-25T10:00:00Z')) > datasetId(new Date('2026-10-25T09:59:59Z')));
  assert.match(diffAnchor('src/os/bluestore/BlueStore.cc'), /^diff-[0-9a-f]{64}$/);
});

test('history picks a ~24h-old snapshot and trims by retention', () => {
  const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  let h = { version: 1 as const, snapshots: [] as { at: string; prs: Record<string, [number, number, number]> }[] };
  for (const age of [400, 30, 21, 3]) h = appendSnapshot(h, { at: at(age), prs: {} }, NOW, 14);
  assert.equal(h.snapshots.length, 3, '400h-old snapshot trimmed');
  assert.equal(comparisonSnapshot(h, NOW)!.at, at(21));
  assert.equal(comparisonSnapshot({ version: 1, snapshots: [{ at: at(3), prs: {} }] }, NOW)!.at, at(3));
  assert.equal(comparisonSnapshot({ version: 1, snapshots: [] }, NOW), null);
});

test('rank movement is computed against the previous snapshot', () => {
  const { dataset } = sampleDataset(NOW);
  const p = dataset.prs.find((x) => x.number === 61001)!;
  assert.equal(p.trending.rank, 1);
  assert.equal(p.trending.previousRank, 3);
  assert.ok(dataset.history.comparedTo);
});
