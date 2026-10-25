// Assemble the deployable static site:
//
//   node src/cli/build-site.ts --data <data dir> --out dist
//
// Copies site/ and the published data (manifest, status, referenced dataset) into
// <out>/data/. Fails if the referenced dataset is missing or invalid, so a broken
// dataset is never deployed. A data dir with only status.json (no successful run yet)
// is allowed: the dashboard then shows the collection error.
//
// The manifest and status are also embedded in index.html (replacing the
// `<!-- build:boot -->` marker) together with a preload hint for the dataset, so a
// page load is one HTML round trip plus the dataset download instead of a chain of
// dependent requests.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, readStatus } from '../dataset/publish.ts';
import { validate } from '../dataset/validate.ts';
import { parseArgs, str } from './args.ts';

const BOOT_MARKER = '<!-- build:boot -->';

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
const status = existsSync(dataDir) ? readStatus(dataDir) : null;
if (status) cpSync(join(dataDir, 'status.json'), join(outDir, 'data', 'status.json'));

const indexPath = join(outDir, 'index.html');
const html = readFileSync(indexPath, 'utf8');
if (!html.includes(BOOT_MARKER)) throw new Error(`site/index.html lacks the ${BOOT_MARKER} marker`);
// "<" is escaped so no embedded string (e.g. an error message) can close the script tag.
const bootJson = JSON.stringify({ manifest, status }).replace(/</g, '\\u003c');
const preload = manifest ? `<link rel="preload" href="data/${manifest.dataset}" as="fetch" crossorigin>\n  ` : '';
writeFileSync(indexPath, html.replace(BOOT_MARKER, `${preload}<script id="boot" type="application/json">${bootJson}</script>`));
console.log(`[build] wrote ${outDir}/`);
