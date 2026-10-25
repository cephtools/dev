import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write JSON to a temp file in the same directory, then rename: readers never see a partial file. */
export function writeJsonAtomic(path: string, value: unknown, pretty = true): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');
  renameSync(tmp, path);
}
