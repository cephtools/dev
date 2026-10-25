// PR description cleanup before keyword matching.

/**
 * Markers where Ceph's PR template begins (contribution guidelines, checklist,
 * Jenkins command list). Everything from the first marker on is boilerplate.
 */
const TEMPLATE_MARKERS = [/^#+\s*Contribution Guidelines/im, /^#+\s*Checklist\s*$/im, /<summary>\s*Show available Jenkins commands/i];

/** Remove HTML comments and the PR template so only the author's own text is matched. Idempotent. */
export function stripTemplate(body: string): string {
  let text = body.replace(/<!--[\s\S]*?(-->|$)/g, '');
  for (const re of TEMPLATE_MARKERS) {
    const m = re.exec(text);
    if (m) text = text.slice(0, m.index);
  }
  return text.trim();
}
