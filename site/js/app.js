// DOM glue: load data, keep controls ⇄ URL hash in sync, render the current view.

import { diffAnchor, esc } from './format.js';
import { applyFilters, buildHash, DEFAULT_FILTERS, defaultSort, effectiveMin, facets, parseHash, SORTS, sortPrs } from './state.js';
import { renderAbout, renderBanners, renderDetail, renderEmpty, renderList, renderStatusLine, renderSubsystems } from './render.js';

const PAGE = 50;
const $ = (sel) => document.querySelector(sel);
const els = {
  status: $('#data-status'),
  banners: $('#banners'),
  filters: $('#filters'),
  view: $('#view'),
  count: $('#result-count'),
  dialog: $('#detail'),
  dialogContent: $('#detail-content'),
};

let dataset = null;
let status = null;
let state = parseHash(location.hash);
let limit = PAGE;
let lastTrigger = null;

/** Dataset files are immutable (unique id), so they use normal caching; manifest/status are revalidated. */
async function loadJson(url, revalidate = false) {
  const res = await fetch(url, revalidate ? { cache: 'no-cache' } : undefined);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Manifest and status embedded by build-site.ts, saving two round trips before the dataset request. */
function bootData() {
  const el = document.getElementById('boot');
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

/** Upgrade file links to GitHub's per-file #diff-<sha256(path)> fragment (computed here, not shipped in the dataset). */
async function upgradeFileLinks(root, prUrl) {
  for (const a of root.querySelectorAll('a[data-path]')) {
    try {
      a.href = `${prUrl}/files#${await diffAnchor(a.dataset.path)}`;
    } catch {
      // keep the plain "Files changed" link (e.g. no SubtleCrypto outside a secure context)
    }
  }
}

function ctx() {
  return { dataset, win: state.filters.win, now: new Date() };
}

function control(name) {
  return els.filters.elements.namedItem(name);
}

function fillSelect(name, options, keepFirst = true) {
  const sel = control(name);
  const first = keepFirst ? sel.options[0].outerHTML : '';
  sel.innerHTML = first + options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
}

function populateControls() {
  fillSelect('sub', dataset.subsystems.map((s) => [s.id, s.name]));
  const f = facets(dataset.prs);
  fillSelect('label', f.labels.map(([l, n]) => [l, `${l} (${n})`]));
  $('#authors').innerHTML = f.authors.map(([a]) => `<option value="${esc(a)}"></option>`).join('');
  fillSelect('win', dataset.windows.map((w) => [w.key, w.key]), false);
}

function syncControls() {
  const { view, filters } = state;
  const sorts = SORTS[view] ?? [];
  fillSelect('sort', sorts.map((s) => [s.key, s.label]), false);
  for (const [key, value] of Object.entries(filters)) {
    const el = control(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = value === '1';
    else el.value = key === 'sort' ? value || defaultSort(view) : value;
  }
  if (dataset) control('min').placeholder = String(effectiveMin(view, { ...filters, min: '' }, dataset));
  els.filters.hidden = view === 'about';
  els.filters.dataset.view = view;
  for (const a of document.querySelectorAll('nav a[data-view]')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function readControls() {
  const filters = { ...state.filters };
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    const el = control(key);
    if (!el) continue;
    filters[key] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
  }
  if (filters.sort === defaultSort(state.view)) filters.sort = '';
  return filters;
}

function updateHash(replace = true) {
  const hash = buildHash(state.view, state.filters, state.pr);
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
}

function isFiltered() {
  return Object.entries(state.filters).some(([k, v]) => k !== 'sort' && k !== 'win' && v !== DEFAULT_FILTERS[k]);
}

function render() {
  if (!dataset) return;
  els.status.innerHTML = renderStatusLine(dataset);
  renderBannerList();
  const { view, filters } = state;
  document.title = `${dataset.site.title} · ${{ trending: 'Trending', technical: 'Technical importance', subsystems: 'Subsystems', about: 'About' }[view]}`;
  if (view === 'about') {
    els.count.textContent = '';
    els.view.innerHTML = renderAbout(ctx());
    return;
  }
  const filtered = applyFilters(dataset.prs, view, filters, dataset);
  if (view === 'subsystems') {
    const classified = filtered.filter((p) => p.technical.subsystems.length);
    els.count.textContent = `${classified.length} classified PRs`;
    els.view.innerHTML = classified.length ? renderSubsystems(classified, ctx()) : renderEmpty(view, isFiltered());
    return;
  }
  const sorted = sortPrs(filtered, view, filters.sort, filters.win);
  els.count.textContent = `Showing ${Math.min(limit, sorted.length)} of ${sorted.length} PRs`;
  els.view.innerHTML = sorted.length ? renderList(sorted, view, ctx(), limit) : renderEmpty(view, isFiltered());
}

function renderBannerList() {
  els.banners.innerHTML = renderBanners(dataset, status)
    .map((b) => `<div class="banner ${b.level}" role="${b.level === 'error' ? 'alert' : 'status'}">${b.html}</div>`)
    .join('');
}

function openDetail(number, trigger) {
  const pr = dataset?.prs.find((p) => p.number === number);
  if (!pr) return;
  lastTrigger = trigger ?? null;
  els.dialogContent.innerHTML = renderDetail(pr, ctx());
  upgradeFileLinks(els.dialogContent, pr.url);
  if (!els.dialog.open) els.dialog.showModal();
  els.dialog.querySelector('.close')?.focus();
  if (state.pr !== number) {
    state.pr = number;
    updateHash(false);
  }
}

function closeDetail() {
  if (els.dialog.open) els.dialog.close();
}

els.dialog.addEventListener('close', () => {
  if (state.pr) {
    state.pr = null;
    updateHash();
  }
  lastTrigger?.focus();
});
els.dialog.addEventListener('click', (e) => {
  if (e.target === els.dialog || e.target.closest('[data-close]')) closeDetail();
});

els.filters.addEventListener('input', (e) => {
  if (e.target.name === 'q' || e.target.name === 'author' || e.target.name === 'min') {
    state.filters = readControls();
    limit = PAGE;
    updateHash();
    render();
  }
});
els.filters.addEventListener('change', () => {
  state.filters = readControls();
  limit = PAGE;
  updateHash();
  render();
});
els.filters.addEventListener('submit', (e) => e.preventDefault());
els.filters.addEventListener('reset', (e) => {
  e.preventDefault();
  state.filters = { ...DEFAULT_FILTERS };
  limit = PAGE;
  syncControls();
  updateHash();
  render();
});

els.view.addEventListener('click', (e) => {
  const open = e.target.closest('.pr-open');
  if (open) return openDetail(Number(open.dataset.pr), open);
  if (e.target.closest('[data-more]')) {
    limit += PAGE;
    render();
    return;
  }
  if (e.target.closest('[data-reset]')) els.filters.reset();
});

window.addEventListener('hashchange', () => {
  const next = parseHash(location.hash);
  if (next.view !== state.view) limit = PAGE;
  state = next;
  syncControls();
  render();
  if (state.pr) openDetail(state.pr);
  else closeDetail();
});

async function init() {
  syncControls();
  els.view.innerHTML = '<p class="loading" role="status">Loading dataset…</p>';
  const boot = bootData();
  status = boot?.status ?? null;
  if (!boot) {
    try {
      status = await loadJson('data/status.json', true);
    } catch {
      status = null; // optional: older deployments may not have it
    }
  }
  try {
    const manifest = boot ? boot.manifest : await loadJson('data/manifest.json', true);
    if (!manifest) throw new Error('no dataset has been published yet');
    if (manifest.schemaVersion !== 1) throw new Error(`unsupported schema version ${manifest.schemaVersion}`);
    dataset = await loadJson(`data/${manifest.dataset}`);
  } catch (err) {
    els.status.textContent = 'No data';
    els.banners.innerHTML = renderBanners(null, status).map((b) => `<div class="banner ${b.level}" role="alert">${b.html}</div>`).join('');
    els.view.innerHTML = `<div class="empty" role="alert"><p><strong>Could not load the PR dataset.</strong></p><p class="muted">${esc(err.message)}</p><p class="muted">If this is a new deployment, the first scheduled collection may not have finished yet.</p></div>`;
    els.filters.hidden = true;
    return;
  }
  populateControls();
  syncControls();
  render();
  if (state.pr) openDetail(state.pr);
}

init();
