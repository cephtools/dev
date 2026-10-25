import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, churnFactor, fileKind } from '../src/score/classify.ts';
import { technicalImportance } from '../src/score/importance.ts';
import { globToRegExp } from '../src/util/glob.ts';
import { stripTemplate } from '../src/util/text.ts';
import { config, files, record, rules } from './helpers.ts';

const cfg = config.importance;
const ids = (r: ReturnType<typeof technicalImportance>) => r.subsystems.map((s) => s.id);

test('glob: *, ** and {a,b}', () => {
  assert.ok(globToRegExp('src/os/bluestore/**').test('src/os/bluestore/a/b.cc'));
  assert.ok(!globToRegExp('src/os/bluestore/*').test('src/os/bluestore/a/b.cc'));
  assert.ok(globToRegExp('src/os/bluestore/BlueStore.{cc,h}').test('src/os/bluestore/BlueStore.h'));
  assert.ok(!globToRegExp('src/os/bluestore/BlueStore.{cc,h}').test('src/os/bluestore/BlueStore.cc.orig'));
  assert.ok(globToRegExp('**/tests/**').test('src/pybind/mgr/foo/tests/test_a.py'));
  assert.ok(globToRegExp('src/rocksdb').test('src/rocksdb'));
});

test('file kinds: tests, docs, frontend, core', () => {
  assert.equal(fileKind('src/test/objectstore/store_test.cc', rules), 'test');
  assert.equal(fileKind('qa/tasks/ceph.py', rules), 'test');
  assert.equal(fileKind('doc/dev/osd.rst', rules), 'docs');
  assert.equal(fileKind('src/pybind/mgr/dashboard/frontend/src/app.ts', rules), 'frontend');
  assert.equal(fileKind('src/os/bluestore/BlueStore.cc', rules), 'core');
});

test('BlueStore on-disk types classify as BlueStore with high confidence and a format signal', () => {
  const r = technicalImportance(record({
    title: 'os/bluestore: change blob encoding',
    labels: ['bluestore'],
    files: files(['src/os/bluestore/bluestore_types.cc', 200, 50], ['src/os/bluestore/bluestore_types.h', 40, 10]),
  }), rules, cfg);
  assert.equal(ids(r)[0], 'bluestore');
  assert.equal(r.confidence, 'high');
  assert.ok(r.signals.some((s) => s.type === 'format'));
  assert.ok(r.important);
  assert.ok(r.relevantFiles.some((f) => f.path.endsWith('bluestore_types.cc')));
});

test('a PR can belong to several subsystems', () => {
  const r = technicalImportance(record({
    files: files(['src/osd/ECBackend.cc', 150, 80], ['src/common/buffer.cc', 60, 10], ['src/include/buffer.h', 20, 2]),
  }), rules, cfg);
  assert.deepEqual(new Set(ids(r)), new Set(['osd-perf', 'memory']));
});

test('within a subsystem each file counts for its most specific rule only', () => {
  const { matches } = classify(record({ files: files(['src/os/bluestore/BlueStore.cc', 100, 0]) }), rules, cfg);
  const bs = matches.find((m) => m.id === 'bluestore')!;
  const paths = bs.evidence.filter((e) => e.type === 'path');
  assert.equal(paths.length, 1, 'not also counted by src/os/bluestore/**');
  assert.match(paths[0].detail, /core BlueStore/);
});

test('keyword-only matches are low confidence, and architecture needs path evidence', () => {
  const r = technicalImportance(record({
    title: 'rgw: redesign bucket index cache to cut rocksdb compaction and memory usage',
    files: files(['src/rgw/rgw_bucket.cc', 300, 100]),
  }), rules, cfg);
  assert.ok(!ids(r).includes('architecture'), 'no architecture claim from words alone');
  for (const s of r.subsystems) assert.equal(s.confidence, 'low');
});

test('test-only and docs-only PRs score zero even when titles mention critical code', () => {
  const t = technicalImportance(record({ title: 'qa: bluestore allocator thrash test', labels: ['bluestore'], files: files(['qa/suites/rados/thrash/x.yaml', 30, 0]) }), rules, cfg);
  assert.equal(t.score, 0);
  assert.ok(t.flags.testOnly);
  const d = technicalImportance(record({ title: 'doc: bluestore tuning', files: files(['doc/rados/configuration/bluestore-config-ref.rst', 50, 10]) }), rules, cfg);
  assert.equal(d.score, 0);
  assert.ok(d.flags.docsOnly);
});

test('many files outside tracked subsystems do not make a PR important', () => {
  const many = Array.from({ length: 80 }, (_, i) => [`src/rgw/rgw_file_${i}.cc`, 500, 200] as [string, number, number]);
  const r = technicalImportance(record({ title: 'rgw: big feature', files: files(...many) }), rules, cfg);
  assert.equal(r.important, false);
  assert.equal(r.subsystems.length, 0);
});

test('churn factor rewards substance but saturates', () => {
  const c = cfg.churn;
  assert.ok(churnFactor(1, c) < churnFactor(100, c));
  assert.equal(churnFactor(100_000, c), 1);
  assert.ok(churnFactor(0, c) >= c.floor);
});

test('a tiny RocksDB submodule bump is still classified', () => {
  const r = technicalImportance(record({ title: 'build: update rocksdb submodule', files: files(['src/rocksdb', 1, 1]) }), rules, cfg);
  assert.equal(ids(r)[0], 'rocksdb');
  assert.ok(r.important);
});

test('backports are weighted down', () => {
  const pr = { files: files(['src/os/bluestore/AvlAllocator.cc', 40, 10]), title: 'os/bluestore: fix allocator' };
  const main = technicalImportance(record(pr), rules, cfg);
  const backport = technicalImportance(record({ ...pr, baseRef: 'squid' }), rules, cfg);
  assert.ok(backport.flags.backport);
  assert.ok(backport.raw < main.raw);
});

test('cross-area breadth is evidence for an architectural change', () => {
  const r = technicalImportance(record({
    files: files(['src/os/ObjectStore.h', 100, 20], ['src/osd/PrimaryLogPG.cc', 80, 10], ['src/crimson/os/futurized_store.h', 40, 5], ['src/kv/RocksDBStore.cc', 50, 5], ['src/os/bluestore/BlueStore.cc', 60, 10]),
  }), rules, cfg);
  const arch = r.subsystems.find((s) => s.id === 'architecture');
  assert.ok(arch);
  assert.ok(arch.evidence.some((e) => e.type === 'breadth'));
});

test('missing file data yields no classification rather than a guess', () => {
  const r = technicalImportance(record({ detail: 'none', title: 'os/bluestore: huge rework', labels: ['bluestore'] }), rules, cfg);
  assert.equal(r.score, 0);
  assert.equal(r.confidence, null);
  assert.match(r.explanation, /not collected/);
});

test('PR template and HTML comments are ignored for keyword matching', () => {
  const body = 'Fix allocator accounting.\n<!-- regression? deadlock? -->\n## Contribution Guidelines\n- crash data loss corruption\n## Checklist\n- [ ] Includes bug reproducer';
  assert.equal(stripTemplate(body), 'Fix allocator accounting.');
  const r = technicalImportance(record({ title: 'os/bluestore: fix accounting', body, files: files(['src/os/bluestore/AvlAllocator.cc', 40, 10]) }), rules, cfg);
  assert.ok(!r.signals.some((s) => s.type === 'signal'), JSON.stringify(r.signals));
});

test('"regression tests" is not a reported regression; a real regression is', () => {
  const sig = (body: string) => technicalImportance(record({ title: 'osd: x', body, files: files(['src/osd/PG.cc', 50, 5]) }), rules, cfg).signals.some((s) => s.detail.startsWith('Mentions a regression'));
  assert.equal(sig('Includes focused regression tests for each conversion.'), false);
  assert.equal(sig('Adds crash tests.'), false);
  assert.equal(sig('Fixes a performance regression introduced in squid.'), true);
  assert.equal(sig('OSD crashes on startup.'), true);
});

test('breadth bonus and incidental secondary subsystems are capped', () => {
  const areas = ['src/os/', 'src/osd/', 'src/mon/', 'src/mds/', 'src/rgw/', 'src/librbd/', 'src/client/', 'src/msg/', 'src/common/', 'src/mgr/'];
  const r = technicalImportance(record({
    files: files(['src/include/encoding.h', 200, 100], ...areas.map((a) => [`${a}x.cc`, 50, 10] as [string, number, number]),
      ['src/os/bluestore/bluestore_types.h', 3, 2], ['src/crimson/os/seastore/seastore_types.h', 3, 2], ['src/kv/RocksDBStore.cc', 3, 2], ['src/common/buffer.cc', 3, 2]),
  }), rules, cfg);
  const breadth = r.subsystems.flatMap((s) => s.evidence).find((e) => e.type === 'breadth')!;
  assert.ok(breadth.weight <= rules.coreAreas.breadthMax);
  const [best, ...others] = r.subsystems.map((s) => s.score);
  const signals = r.signals.reduce((a, s) => a + s.weight, 0);
  assert.ok(others.length >= 3);
  assert.ok(r.raw <= best + cfg.secondarySubsystemCap + signals + 0.1);
});

test('move/rename/cleanup titles are weighted down and flagged', () => {
  const pr = { files: files(['src/include/encoding.h', 600, 500], ['src/include/denc.h', 300, 300]) };
  const normal = technicalImportance(record({ ...pr, title: 'include/{encoding,denc}: split container templates into separate headers' }), rules, cfg);
  const moved = technicalImportance(record({ ...pr, title: 'include/{encoding,denc}: move container templates to separate headers' }), rules, cfg);
  assert.ok(moved.flags.mechanical && !normal.flags.mechanical);
  assert.ok(Math.abs(moved.raw - normal.raw * cfg.mechanicalMultiplier) < 0.2);
  assert.match(moved.explanation, /move\/rename\/cleanup/);
});

test('MDS and client changes classify as CephFS; a deadlock in the title is a reported risk', () => {
  const r = technicalImportance(record({
    title: 'mds: fix deadlock between subtree export and rename',
    labels: ['cephfs'],
    files: files(['src/mds/Migrator.cc', 48, 22], ['src/mds/Locker.cc', 30, 9], ['src/client/Client.cc', 10, 2]),
  }), rules, cfg);
  assert.equal(ids(r)[0], 'cephfs');
  assert.equal(r.confidence, 'high');
  assert.ok(r.important);
  assert.ok(r.signals.some((s) => s.detail.startsWith('Mentions a regression')));
  const types = technicalImportance(record({ title: 'mds: bump inode_t encoding', files: files(['src/mds/mdstypes.h', 20, 5]) }), rules, cfg);
  assert.ok(types.signals.some((s) => s.type === 'format'), 'mdstypes is a persistent format');
});
