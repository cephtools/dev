// Validate a published data directory against schema/dataset.schema.json.
//
//   node src/cli/validate.ts <data dir>

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, readStatus } from '../dataset/publish.ts';
import { validate } from '../dataset/validate.ts';

const dir = process.argv[2] ?? 'sample-data';
const fail = (msg: string) => {
  console.error(`[validate] ${msg}`);
  process.exit(1);
};

const manifest = readManifest(dir);
if (!manifest) fail(`${dir}/manifest.json not found`);
const path = join(dir, manifest!.dataset);
if (!existsSync(path)) fail(`manifest points to missing ${path}`);
const dataset = JSON.parse(readFileSync(path, 'utf8'));
const errors = validate(dataset);
if (errors.length) fail(`${path} is invalid:\n  ${errors.join('\n  ')}`);
if (dataset.id !== manifest!.id) fail(`manifest id ${manifest!.id} != dataset id ${dataset.id}`);
if (dataset.collection.listed > 0 && dataset.prs.length === 0) fail('dataset lists PRs but contains none');

const status = readStatus(dir);
const important = dataset.prs.filter((p: { technical: { important: boolean } }) => p.technical.important).length;
console.log(`[validate] OK ${path}: ${dataset.prs.length} PRs, ${important} technically important; status ok=${status?.ok ?? 'n/a'}`);
