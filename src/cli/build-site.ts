// Assemble the deployable static site:
//
//   node src/cli/build-site.ts --data <data dir> --out dist
//
// Copies site/ and the published data (manifest, status, referenced dataset) into
// <out>/data/. Fails if the referenced dataset is missing or invalid, so a broken
// dataset is never deployed. A data dir with only status.json (no successful run yet)
// is allowed: the dashboard then shows the collection error.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from '../dataset/publish.ts';
import { validate } from '../dataset/validate.ts';
import { parseArgs, str } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const dataDir = str(args.data, 'sample-data');
const outDir = str(args.out, 'dist');
const siteDir = new URL('../../site/', import.meta.url).pathname;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'data', 'datasets'), { recursive: true });
cpSync(siteDir, outDir, { recursive: true });
writeFileSync(join(outDir, '.nojekyll'), '');

const manifest = existsSync(dataDir) ? readManifest(dataDir) : null;
if (manifest) {
  const src = join(dataDir, manifest.dataset);
  if (!existsSync(src)) throw new Error(`manifest references missing ${src}`);
  const errors = validate(JSON.parse(readFileSync(src, 'utf8')));
  if (errors.length) throw new Error(`dataset ${src} is invalid:\n  ${errors.slice(0, 10).join('\n  ')}`);
  cpSync(src, join(outDir, 'data', manifest.dataset));
  cpSync(join(dataDir, 'manifest.json'), join(outDir, 'data', 'manifest.json'));
  console.log(`[build] dataset ${manifest.id}`);
} else {
  console.warn(`[build] no manifest in ${dataDir}; site will show the "no data yet" state`);
}
if (existsSync(join(dataDir, 'status.json'))) cpSync(join(dataDir, 'status.json'), join(outDir, 'data', 'status.json'));
console.log(`[build] wrote ${outDir}/`);
