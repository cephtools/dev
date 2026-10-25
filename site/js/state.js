// View state ⇄ URL hash, filtering and sorting. Pure functions (no DOM).

export const VIEWS = ['trending', 'technical', 'subsystems', 'about'];

export const SORTS = {
  trending: [
    { key: 'score', label: 'Trending score' },
    { key: 'discussion', label: 'Recent discussion' },
    { key: 'reviews', label: 'Review activity' },
    { key: 'updated', label: 'Latest activity' },
    { key: 'rising', label: 'Rank change' },
  ],
  technical: [
    { key: 'importance', label: 'Technical importance' },
    { key: 'confidence', label: 'Confidence' },
    { key: 'quiet', label: 'Least discussed first' },
    { key: 'core', label: 'Core lines changed' },
    { key: 'updated', label: 'Latest activity' },
  ],
  subsystems: [
    { key: 'importance', label: 'Technical importance' },
    { key: 'score', label: 'Trending score' },
    { key: 'updated', label: 'Latest activity' },
  ],
  about: [],
};

export const DEFAULT_FILTERS = {
  q: '',
  sub: '',
  author: '',
  label: '',
  status: 'all', // all | ready | draft
  win: '7d',
  min: '', // empty: view default
  backports: '', // '1': also show PRs targeting release branches
  active: '', // '1': only PRs with activity in the selected window
  sort: '',
};

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const view = VIEWS.includes(path) ? path : 'trending';
  const filters = { ...DEFAULT_FILTERS };
  const params = new URLSearchParams(query);
  for (const key of Object.keys(DEFAULT_FILTERS)) if (params.has(key)) filters[key] = params.get(key) ?? '';
  const pr = Number(params.get('pr')) || null;
  return { view, filters, pr };
}

/**
 * @param {string} view
 * @param {Record<string, string>} filters
 * @param {number | null} [pr]
 */
export function buildHash(view, filters, pr = null) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== DEFAULT_FILTERS[key] && value !== undefined) params.set(key, value);
  }
  if (pr) params.set('pr', String(pr));
  const q = params.toString();
  return `#/${view}${q ? `?${q}` : ''}`;
}

export function defaultSort(view) {
  return SORTS[view]?.[0]?.key ?? '';
}

/** Minimum score used by a view when the filter is empty. */
export function effectiveMin(view, filters, dataset) {
  if (filters.min !== '' && !Number.isNaN(Number(filters.min))) return Number(filters.min);
  if (view === 'technical') return dataset.scoring.importance.minScore;
  return 0;
}

const CONF_RANK = { high: 3, medium: 2, low: 1 };

export function windowMetrics(pr, win) {
  return pr.metrics[win] ?? Object.values(pr.metrics)[0];
}

/**
 * Apply all filters for a view. Trending excludes PRs without recent activity; technical requires a classification.
 * @param {any[]} prs
 * @param {string} view
 * @param {Record<string, string>} filters
 * @param {any} dataset
 * @returns {any[]}
 */
export function applyFilters(prs, view, filters, dataset) {
  const q = filters.q.trim().toLowerCase();
  const min = effectiveMin(view, filters, dataset);
  const mainBranches = dataset.scoring.importance.mainBranches ?? ['main'];
  return prs.filter((pr) => {
    if (q && !(`#${pr.number} ${pr.title} ${pr.author ?? ''}`.toLowerCase().includes(q) || String(pr.number) === q)) return false;
    if (filters.sub && !pr.technical.subsystems.some((s) => s.id === filters.sub)) return false;
    if (filters.author && (pr.author ?? '').toLowerCase() !== filters.author.toLowerCase()) return false;
    if (filters.label && !pr.labels.includes(filters.label)) return false;
    if (filters.status === 'draft' && !pr.isDraft) return false;
    if (filters.status === 'ready' && pr.isDraft) return false;
    if (filters.backports !== '1' && !mainBranches.includes(pr.baseRef)) return false;
    if (filters.active === '1') {
      const m = windowMetrics(pr, filters.win);
      if (!m || m.comments + m.reviews + m.pushes === 0) return false;
    }
    if (view === 'trending') return pr.trending.score > 0 && pr.trending.score >= min;
    if (view === 'technical') return pr.technical.subsystems.length > 0 && pr.technical.score >= min;
    return true;
  });
}

/**
 * @param {any[]} prs
 * @param {string} view
 * @param {string} sortKey
 * @param {string} win
 * @returns {any[]}
 */
export function sortPrs(prs, view, sortKey, win) {
  const key = sortKey || defaultSort(view);
  const by = (f) => (a, b) => f(b) - f(a) || b.number - a.number;
  const last = (pr) => Date.parse(pr.lastActivityAt ?? pr.updatedAt);
  const m = (pr) => windowMetrics(pr, win);
  const cmp = {
    score: by((pr) => pr.trending.score),
    discussion: by((pr) => m(pr).comments * 100 + m(pr).participants),
    reviews: by((pr) => m(pr).reviews * 100 + m(pr).reviewComments),
    updated: by(last),
    rising: by((pr) => (pr.trending.previousRank && pr.trending.rank ? pr.trending.previousRank - pr.trending.rank : pr.trending.rank ? 1000 - pr.trending.rank : -1e6)),
    importance: by((pr) => pr.technical.score),
    confidence: by((pr) => (CONF_RANK[pr.technical.confidence] ?? 0) * 1000 + pr.technical.score),
    quiet: (a, b) => {
      const da = (a.metrics['30d']?.comments ?? 0) + (a.metrics['30d']?.reviews ?? 0);
      const db = (b.metrics['30d']?.comments ?? 0) + (b.metrics['30d']?.reviews ?? 0);
      return da - db || b.technical.score - a.technical.score;
    },
    core: by((pr) => pr.technical.coreLines),
  }[key] ?? by((pr) => pr.trending.score);
  return [...prs].sort(cmp);
}

/** Distinct values for filter dropdowns, most frequent first. */
export function facets(prs) {
  const count = (values) => {
    const m = new Map();
    for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return { labels: count(prs.flatMap((p) => p.labels)), authors: count(prs.map((p) => p.author)) };
}
