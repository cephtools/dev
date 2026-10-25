// Formatting helpers. Pure functions: no DOM access, importable from Node tests.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for safe interpolation into HTML (content and attribute values). */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** "3h ago", "5d ago", "just now"; `now` is injectable for tests. */
export function relTime(iso, now = new Date()) {
  if (!iso) return 'never';
  const s = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (s < 0) return 'just now';
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/** "2026-10-25 12:00 UTC" */
export function absTime(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
}

export function num(n) {
  if (n === null || n === undefined) return '—';
  return Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString('en-US');
}

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function hoursSince(iso, now = new Date()) {
  return iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Infinity;
}

/**
 * GitHub "Files changed" fragment for a path: diff-<sha256(path)>. Computed here rather
 * than shipped in the dataset (hex hashes are incompressible). Needs a secure context.
 */
export async function diffAnchor(path) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return 'diff-' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
