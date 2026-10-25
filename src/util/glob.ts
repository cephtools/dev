// Minimal glob → RegExp: '**' spans directories, '*' and '?' stay within a segment,
// '{a,b}' alternation. Enough for path rules without pulling in a dependency.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) return re;
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      out += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      out += ')';
    } else if (c === ',' && braceDepth > 0) {
      out += '|';
    } else {
      out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  re = new RegExp(`^${out}$`);
  cache.set(glob, re);
  return re;
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
