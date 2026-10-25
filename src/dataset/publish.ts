// Atomic publication. Layout of a data directory:
//
//   manifest.json            { schemaVersion, id, generatedAt, dataset: "datasets/<id>.json" }
//   datasets/<id>.json       immutable, versioned dataset files (last N kept)
//   status.json              outcome of the latest collection attempt (success or failure)
//
// The dataset file is fully written before manifest.json is atomically replaced to
// point at it, so a reader always sees either the old or the new complete dataset.

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../util/fs.ts';
import type { Dataset } from './build.ts';
import { validate } from './validate.ts';

export interface Manifest {
  schemaVersion: number;
  id: string;
  generatedAt: string;
  dataset: string;
}

export interface Status {
  lastAttemptAt: string;
  ok: boolean;
  error: string | null;
  lastSuccessAt: string | null;
  lastSuccessId: string | null;
  partial: boolean;
  notes: string[];
}

export class ValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`dataset failed schema validation:\n  ${errors.slice(0, 10).join('\n  ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export function publishDataset(dir: string, dataset: Dataset, keep: number): Manifest {
  const errors = validate(dataset);
  if (errors.length) throw new ValidationError(errors);
  if (dataset.collection.listed > 0 && dataset.prs.length === 0) throw new ValidationError(['dataset has no PRs although PRs were listed']);

  const rel = `datasets/${dataset.id}.json`;
  writeJsonAtomic(join(dir, rel), dataset, false);
  const manifest: Manifest = { schemaVersion: dataset.schemaVersion, id: dataset.id, generatedAt: dataset.generatedAt, dataset: rel };
  writeJsonAtomic(join(dir, 'manifest.json'), manifest);
  pruneDatasets(dir, keep, `${dataset.id}.json`);
  return manifest;
}

function pruneDatasets(dir: string, keep: number, current: string): void {
  const dsDir = join(dir, 'datasets');
  const files = readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort(); // ids sort chronologically
  const excess = files.filter((f) => f !== current).slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const f of excess) unlinkSync(join(dsDir, f));
}

export function readStatus(dir: string): Status | null {
  const p = join(dir, 'status.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Status) : null;
}

export function writeStatus(dir: string, status: Status): void {
  writeJsonAtomic(join(dir, 'status.json'), status);
}

export function readManifest(dir: string): Manifest | null {
  const p = join(dir, 'manifest.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}
