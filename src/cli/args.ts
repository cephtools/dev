/** Tiny `--key value` / `--flag` parser; positional arguments land in `_`. */
export function parseArgs(argv: string[]): { _: string[]; [key: string]: string | boolean | string[] } {
  const out: { _: string[]; [key: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
