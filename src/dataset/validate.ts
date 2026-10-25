// Validator for the JSON Schema subset used by schema/dataset.schema.json:
// type (incl. arrays of types), required, properties, additionalProperties (schema),
// items, enum, minimum, maximum, $ref to #/$defs/*. Kept tiny to avoid a dependency.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  $ref?: string;
  $defs?: Record<string, Schema>;
};

const SCHEMA_PATH = fileURLToPath(new URL('../../schema/dataset.schema.json', import.meta.url));

export function loadDatasetSchema(): Schema {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Schema;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function validate(value: unknown, schema: Schema = loadDatasetSchema()): string[] {
  const errors: string[] = [];
  const root = schema;
  const walk = (v: unknown, s: Schema, path: string) => {
    if (errors.length > 50) return;
    if (s.$ref) {
      const name = s.$ref.replace('#/$defs/', '');
      const target = root.$defs?.[name];
      if (!target) throw new Error(`unknown $ref ${s.$ref}`);
      return walk(v, target, path);
    }
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const t = typeOf(v);
      if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
        errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
        return;
      }
    }
    if (s.enum && !s.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: ${v} < minimum ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: ${v} > maximum ${s.maximum}`);
    }
    if (Array.isArray(v) && s.items) v.forEach((item, i) => walk(item, s.items!, `${path}[${i}]`));
    if (typeOf(v) === 'object') {
      const obj = v as Record<string, unknown>;
      for (const key of s.required ?? []) if (!(key in obj)) errors.push(`${path}: missing required "${key}"`);
      for (const [key, val] of Object.entries(obj)) {
        const ps = s.properties?.[key];
        if (ps) walk(val, ps, `${path}.${key}`);
        else if (s.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
        else if (typeof s.additionalProperties === 'object') walk(val, s.additionalProperties, `${path}.${key}`);
      }
    }
  };
  walk(value, schema, '$');
  return errors;
}
