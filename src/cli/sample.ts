// Build a sample dataset from the fixture PRs without touching the network.
//
//   node src/cli/sample.ts --out sample-data [--now 2026-10-25T12:00:00Z]

import { publishDataset, writeStatus } from '../dataset/publish.ts';
import { sampleDataset } from '../sample/dataset.ts';
import { parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const out = str(args.out, 'sample-data');
const now = typeof args.now === 'string' ? new Date(args.now) : new Date();
if (Number.isNaN(now.getTime())) throw new Error(`invalid --now ${args.now}`);
const { dataset } = sampleDataset(now);
const manifest = publishDataset(out, dataset, 1);
writeStatus(out, { lastAttemptAt: dataset.generatedAt, ok: true, error: null, lastSuccessAt: dataset.generatedAt, lastSuccessId: manifest.id, partial: dataset.collection.partial, notes: dataset.collection.notes });
console.log(`[sample] wrote ${out}/${manifest.dataset} (${dataset.prs.length} PRs)`);
