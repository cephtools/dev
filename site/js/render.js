// HTML renderers. Pure functions returning strings (no DOM), so they can be tested in
// Node. Every interpolated value goes through esc().

import { absTime, esc, hoursSince, hueOf, num, plural, relTime } from './format.js';
import { DEFAULT_FILTERS, prState, windowMetrics } from './state.js';

const CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

function authorHtml(login) {
  return `<span class="author" style="--h:${hueOf(login)}">${esc(login)}</span>`;
}

export function subsystemName(dataset, id) {
  return dataset.subsystems.find((s) => s.id === id)?.name ?? id;
}

function ghLink(href, text, cls = 'gh') {
  return `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens GitHub)</span></a>`;
}

function labelChips(pr, max = 4) {
  const shown = pr.labels.slice(0, max).map((l) => `<span class="chip label">${esc(l)}</span>`).join('');
  const more = pr.labels.length > max ? `<span class="chip label muted">+${pr.labels.length - max}</span>` : '';
  return shown + more;
}

/** "Merged", "Closed" or "Draft"; open PRs that are ready for review get none. */
function stateBadge(pr) {
  const state = prState(pr);
  if (state === 'merged') return '<span class="badge merged">Merged</span>';
  if (state === 'closed') return '<span class="badge closed">Closed</span>';
  return pr.isDraft ? '<span class="badge draft">Draft</span>' : '';
}

function badgeList(pr, dataset, includeState = false) {
  const out = [];
  if (includeState && stateBadge(pr)) out.push(stateBadge(pr));
  const main = dataset.scoring.importance.mainBranches ?? ['main'];
  if (!main.includes(pr.baseRef)) out.push(`<span class="badge backport" title="Targets ${esc(pr.baseRef)}">→ ${esc(pr.baseRef)}</span>`);
  if (pr.detail === 'missing') out.push('<span class="badge warn" title="Activity and files not collected yet">no detail yet</span>');
  if (pr.detail === 'stale') out.push(`<span class="badge warn" title="Details fetched ${esc(absTime(pr.fetchedAt))}; PR changed since">details stale</span>`);
  if (prState(pr) === 'open' && (pr.ciState === 'FAILURE' || pr.ciState === 'ERROR')) out.push('<span class="badge ci-fail">CI failing</span>');
  return out;
}

function badges(pr, dataset) {
  return badgeList(pr, dataset, true).join('');
}

function rankChange(pr) {
  const { rank, previousRank } = pr.trending;
  if (!rank) return '';
  if (!previousRank) return '<span class="delta new" title="Not ranked in the previous snapshot">new</span>';
  const d = previousRank - rank;
  if (d === 0) return '';
  const up = d > 0;
  return `<span class="delta ${up ? 'up' : 'down'}" title="Rank ${previousRank} → ${rank}">${up ? '↑' : '↓'}${Math.abs(d)}<span class="sr-only"> ${up ? 'up' : 'down'} ${Math.abs(d)} places</span></span>`;
}

// List rows styled after GitHub's own pull-request list: a state icon, a title line
// with chips, a muted line with number/age/author and view-specific notes, and metrics
// with icons on the right. Everything else lives in the detail panel.

const SEP = ' <span class="sep">·</span> ';

/** Join fragments so lines wrap only between them, never inside one. */
function joinBits(bits) {
  return bits.filter(Boolean).map((b) => `<span class="bit">${b}</span>`).join(SEP);
}

/** Icons are <symbol>s defined once in index.html. */
function ico(id) {
  return `<svg class="ico" aria-hidden="true" viewBox="0 0 16 16"><use href="#${id}"/></svg>`;
}

const STATE_ICONS = {
  open: ['i-pr', 'Open pull request'],
  draft: ['i-pr', 'Draft pull request'],
  merged: ['i-merged', 'Merged pull request'],
  closed: ['i-pr-closed', 'Closed pull request'],
};

function stateIcon(pr) {
  const state = prState(pr) === 'open' && pr.isDraft ? 'draft' : prState(pr);
  const [icon, label] = STATE_ICONS[state];
  return `<span class="state ${state}" title="${label}">${ico(icon)}<span class="sr-only">${label}</span></span>`;
}

/** When a merged or closed PR was merged or closed; null for open PRs. */
function closedAt(pr) {
  const state = prState(pr);
  return state === 'open' ? null : (state === 'merged' && pr.mergedAt) || pr.closedAt;
}

function closedTime(pr, now) {
  return `<time datetime="${esc(closedAt(pr) ?? '')}" title="${esc(absTime(closedAt(pr)))}">${esc(relTime(closedAt(pr), now))}</time>`;
}

function metric(id, value, label) {
  return `<span class="metric" title="${esc(label)}">${ico(id)}${num(value)}<span class="sr-only"> ${esc(label)}</span></span>`;
}

function rowTitle(pr, chips) {
  return `<div class="row-title"><h3><button type="button" class="pr-open" data-pr="${pr.number}" aria-haspopup="dialog">${esc(pr.title)}</button></h3>${chips}</div>`;
}

function rowMeta(pr, now, notes) {
  const num = `<a class="pr-num" href="${esc(pr.url)}" target="_blank" rel="noopener" title="Open on GitHub">#${pr.number}</a>`;
  const by = pr.author ? ` by ${authorHtml(pr.author)}` : '';
  // As on GitHub: "#1 opened 3d ago by x", "#1 by x was merged 2d ago".
  const head = closedAt(pr) ? `${num}${by} was ${esc(prState(pr))} ${closedTime(pr, now)}` : `${num} opened ${esc(relTime(pr.createdAt, now))}${by}`;
  return `<p class="row-meta">${joinBits([head, ...notes])}</p>`;
}

function updatedBit(pr, now) {
  return `updated <time datetime="${esc(pr.lastActivityAt ?? '')}" title="Last substantive activity: ${esc(absTime(pr.lastActivityAt))}">${esc(relTime(pr.lastActivityAt, now))}</time>`;
}

export function renderTrendingCard(pr, ctx) {
  const { dataset, win, now } = ctx;
  const m = windowMetrics(pr, win);
  const t = pr.trending;
  const a = t.acceleration;
  const notes = [];
  if (t.unusual) notes.push('<span class="badge hot" title="Recent activity far above typical active PRs (median + 3×MAD)">unusual activity</span>');
  if (a.basis === 'own-history' && a.ratio !== null) {
    if (a.ratio >= 1.5) notes.push(`<span class="badge accel" title="Recent activity vs this PR's own previous weekly pace">${esc(a.ratio)}× usual pace</span>`);
    else if (a.ratio <= 0.67) notes.push(`<span class="badge slow" title="Recent activity vs this PR's own previous weekly pace">slowing</span>`);
  }
  notes.push(...badgeList(pr, dataset), updatedBit(pr, now));
  const right = [
    metric('i-comment', m.comments, `${plural(m.comments, 'comment')} in ${win}${m.participants ? ` from ${plural(m.participants, 'person', 'people')}` : ''}`),
    metric('i-review', m.reviews, `${plural(m.reviews, 'review')} in ${win}${m.reviewComments ? `, ${m.reviewComments} inline comments` : ''}${m.verdicts ? `, ${m.verdicts} approve/request-changes` : ''}`),
    metric('i-push', m.pushes, `${plural(m.pushes, 'code push', 'code pushes')} in ${win} (${plural(m.commits, 'commit')}); a rebase counts once`),
    `<span class="metric size" title="${plural(pr.changedFiles, 'file')} changed"><span class="add">+${num(pr.additions)}</span> <span class="del">−${num(pr.deletions)}</span></span>`,
    `<span class="score trend" title="Trending score (heuristic)">${esc(t.score)}${rankChange(pr)}</span>`,
    ghLink(pr.url, 'GitHub'),
  ];
  return `<article class="row" data-pr="${pr.number}">
  ${stateIcon(pr)}
  <div class="row-main">${rowTitle(pr, labelChips(pr, 3))}${rowMeta(pr, now, notes)}</div>
  <div class="row-right">${right.join('')}</div>
</article>`;
}

function confidenceChip(conf) {
  if (!conf) return '';
  return `<span class="conf conf-${esc(conf)}" title="Heuristic classification">${esc(CONF_LABEL[conf])}</span>`;
}

// Links to the PR's "Files changed" page; app.js upgrades the href to the per-file
// #diff-<sha256(path)> fragment once computed in the browser (see diffAnchor).
function fileRow(pr, f) {
  return `<li><a href="${esc(pr.url)}/files" data-path="${esc(f.path)}" target="_blank" rel="noopener"><code>${esc(f.path)}</code></a> <span class="add">+${num(f.additions)}</span> <span class="del">−${num(f.deletions)}</span></li>`;
}

export function renderTechnicalCard(pr, ctx) {
  const { dataset, now } = ctx;
  const t = pr.technical;
  const subs = t.subsystems
    .map((s) => `<span class="chip sub conf-${esc(s.confidence)}" data-sub="${esc(s.id)}" title="${esc(CONF_LABEL[s.confidence])}; subsystem score ${esc(s.score)}">${esc(subsystemName(dataset, s.id))}</span>`)
    .join('');
  const d30 = pr.metrics['30d'] ?? windowMetrics(pr, '30d');
  const notes = [confidenceChip(t.confidence)];
  // The 30-day window covers a younger PR's whole life, so say so instead of "in 30d".
  const young = hoursSince(pr.createdAt, now) < 30 * 24;
  const span = young ? `since it was opened ${relTime(pr.createdAt, now)}` : 'in 30 days';
  if (d30 && d30.comments + d30.reviews === 0) notes.push(`<span class="badge quiet" title="No human comments or reviews ${esc(span)}">${young ? 'no discussion yet' : 'no discussion in 30d'}</span>`);
  else notes.push(`<span title="Human comments and reviews ${esc(span)}">${plural(d30?.comments ?? 0, 'comment')}, ${plural(d30?.reviews ?? 0, 'review')}${young ? '' : ' in 30d'}</span>`);
  notes.push(...badgeList(pr, dataset), updatedBit(pr, now));
  const right = [
    metric('i-diff', t.coreLines, 'lines changed outside tests, docs and the dashboard frontend'),
    `<span class="score tech" title="Technical importance (heuristic, 0–100)">${esc(t.score)}</span>`,
    ghLink(pr.url, 'GitHub'),
  ];
  return `<article class="row" data-pr="${pr.number}">
  ${stateIcon(pr)}
  <div class="row-main">${rowTitle(pr, subs)}${rowMeta(pr, now, notes)}<p class="row-why" title="${esc(t.explanation)}">${esc(t.explanation)}</p></div>
  <div class="row-right">${right.join('')}</div>
</article>`;
}

export function renderList(prs, view, ctx, limit) {
  const row = view === 'technical' ? renderTechnicalCard : renderTrendingCard;
  const shown = prs.slice(0, limit).map((pr) => row(pr, ctx)).join('\n');
  const legend = view === 'technical' ? 'core lines · importance' : `comments · reviews · pushes in ${esc(ctx.win)} · size · trend`;
  const head = `<div class="list-head"><span>${num(Math.min(limit, prs.length))} of ${num(prs.length)} PRs</span><span class="muted">${legend}</span></div>`;
  const more = prs.length > limit ? `<button type="button" class="more" data-more="1">Show more (${prs.length - limit} remaining)</button>` : '';
  return `<div class="list">${head}${shown}</div>${more}`;
}

export function renderEmpty(view, filtered) {
  const msg = {
    trending: 'No PRs with recent substantive activity match these filters.',
    technical: 'No technically important PRs match these filters. Try lowering the minimum score.',
    subsystems: 'No classified PRs match these filters.',
  }[view] ?? 'Nothing to show.';
  return `<div class="empty" role="status"><p>${esc(msg)}</p>${filtered ? '<button type="button" class="reset-inline" data-reset="1">Reset filters</button>' : ''}</div>`;
}

export function renderSubsystems(prs, ctx) {
  const { dataset } = ctx;
  const minScore = dataset.scoring.importance.minScore;
  const status = ctx.status && ctx.status !== DEFAULT_FILTERS.status ? `&status=${encodeURIComponent(ctx.status)}` : '';
  return `<div class="subsys-grid">${dataset.subsystems
    .map((s) => {
      const members = prs.filter((p) => p.technical.subsystems.some((m) => m.id === s.id));
      const important = members.filter((p) => p.technical.score >= minScore);
      const high = members.filter((p) => p.technical.subsystems.find((m) => m.id === s.id)?.confidence === 'high');
      const top = [...members].sort((a, b) => b.technical.score - a.technical.score).slice(0, 6);
      const rows = top
        .map((p) => `<li><span class="mini-score" title="Technical importance">${esc(p.technical.score)}</span><span><button type="button" class="pr-open" data-pr="${p.number}" aria-haspopup="dialog"><span class="num">#${p.number}</span> ${esc(p.title)}</button>${stateBadge(p) ? ` ${stateBadge(p)}` : ''}</span></li>`)
        .join('');
      return `<section class="subsys" aria-labelledby="sub-${esc(s.id)}">
  <h3 id="sub-${esc(s.id)}">${esc(s.name)}</h3>
  <p class="muted">${esc(s.description)}</p>
  <p class="counts"><strong>${members.length}</strong> classified · <strong>${important.length}</strong> ≥ ${minScore} · <strong>${high.length}</strong> high confidence</p>
  ${rows ? `<ol class="toplist">${rows}</ol>` : '<p class="muted">No PRs classified here.</p>'}
  ${members.length ? `<a class="view-all" href="#/technical?sub=${encodeURIComponent(s.id)}&min=0${status}">All ${members.length} in Technical view →</a>` : ''}
</section>`;
    })
    .join('')}</div>`;
}

export function renderBanners(dataset, status, now = new Date()) {
  const out = [];
  if (status && !status.ok) {
    const shown = dataset ? ` Showing data from ${esc(absTime(dataset.generatedAt))}.` : '';
    out.push({ level: 'error', html: `<strong>Latest collection failed</strong> (${esc(absTime(status.lastAttemptAt))}): ${esc(status.error ?? 'unknown error')}.${shown}` });
  }
  if (!dataset) return out;
  const age = hoursSince(dataset.generatedAt, now);
  if (age > dataset.site.staleAfterHours) {
    out.push({ level: 'warn', html: `<strong>Data is ${esc(relTime(dataset.generatedAt, now).replace(' ago', ''))} old.</strong> Updates are expected every ${esc(dataset.site.refreshHours)}h; scheduled collection may be failing.` });
  }
  if (dataset.collection.source === 'sample') {
    out.push({ level: 'info', html: '<strong>Sample data.</strong> Generated from test fixtures, not from GitHub.' });
  }
  const notes = dataset.collection.notes.filter((n) => !/^Sample dataset/.test(n));
  if (dataset.collection.partial && notes.length) {
    out.push({ level: 'info', html: `<details><summary><strong>Partial collection</strong>: some PRs use cached or incomplete data.</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` });
  }
  return out;
}

export function renderStatusLine(dataset, now = new Date()) {
  if (!dataset) return 'No dataset published yet';
  const open = dataset.prs.filter((p) => prState(p) === 'open').length;
  const days = dataset.collection.closedDays;
  const closed = days ? ` · ${num(dataset.prs.length - open)} merged or closed in ${esc(days)}d` : '';
  return `Updated <time datetime="${esc(dataset.generatedAt)}" title="${esc(absTime(dataset.generatedAt))}">${esc(relTime(dataset.generatedAt, now))}</time> · ${esc(absTime(dataset.generatedAt))} · ${num(open)} open PRs${closed}`;
}

// ---------- detail panel ----------

function metricsTable(pr, dataset) {
  const wins = dataset.windows.map((w) => w.key);
  const rows = [
    ['Comments', 'comments', pr.totals.comments],
    ['Reviews submitted', 'reviews', pr.totals.reviews],
    ['Approve / request changes', 'verdicts', null],
    ['Inline review comments', 'reviewComments', null],
    ['Commits', 'commits', pr.totals.commits],
    ['Pushes (rebases count once)', 'pushes', null],
    ['Participants (excl. author)', 'participants', null],
  ];
  const head = `<tr><th scope="col">Measured</th>${wins.map((w) => `<th scope="col">${esc(w)}</th>`).join('')}<th scope="col" title="GitHub totalCount, includes bots">lifetime</th></tr>`;
  const body = rows
    .map(([label, key, total]) => `<tr><th scope="row">${esc(label)}</th>${wins.map((w) => `<td>${num(pr.metrics[w]?.[key] ?? 0)}</td>`).join('')}<td>${total === null ? '—' : num(total)}</td></tr>`)
    .join('');
  return `<table class="metrics"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const BASIS_TEXT = {
  'own-history': 'compared with this PR’s own weekly activity over the preceding weeks',
  'new-pr': 'PR too new for a baseline; no acceleration applied',
  'truncated-history': 'older events were truncated by GitHub API limits; no acceleration applied',
  'no-detail': 'activity not collected yet',
};

function evidenceList(items) {
  return `<ul class="evidence">${items
    .map((e) => `<li><span class="ev-type">${esc(e.type)}</span> ${esc(e.detail)} <span class="ev-w" title="weight">+${esc(e.weight)}</span>${e.files?.length ? `<div class="ev-files">${e.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}</li>`)
    .join('')}</ul>`;
}

export function renderDetail(pr, ctx) {
  const { dataset, now } = ctx;
  const t = pr.trending;
  const tech = pr.technical;
  const a = t.acceleration;
  const files = pr.files;
  const subsystems = tech.subsystems
    .map((s) => `<div class="sub-detail"><h4><span class="chip sub conf-${esc(s.confidence)}" data-sub="${esc(s.id)}">${esc(subsystemName(dataset, s.id))}</span> <span class="muted">score ${esc(s.score)}</span> ${confidenceChip(s.confidence)}</h4>${evidenceList(s.evidence)}</div>`)
    .join('');
  const flags = [
    tech.flags.backport && 'targets a release branch (backport, weighted down)',
    tech.flags.mechanical && 'title describes a move/rename/cleanup (weighted down)',
    tech.flags.testOnly && 'test-only change',
    tech.flags.docsOnly && 'documentation-only change',
    tech.flags.filesTruncated && 'file list truncated; classification may miss files',
  ].filter(Boolean);

  return `<header class="detail-head">
  <h2 id="detail-title"><span class="num">#${pr.number}</span> ${esc(pr.title)}</h2>
  <button type="button" class="close" data-close="1" aria-label="Close details">×</button>
</header>
<div class="detail-body">
  <p class="meta">${pr.author ? `by ${authorHtml(pr.author)} · ` : ''}opened ${esc(relTime(pr.createdAt, now))}${closedAt(pr) ? ` · ${esc(prState(pr))} ${closedTime(pr, now)}` : ''} · base <code>${esc(pr.baseRef)}</code>${pr.ciState ? ` · CI ${esc(pr.ciState.toLowerCase())}` : ''} ${badges(pr, dataset)}</p>
  <p class="meta">${labelChips(pr, 20)}</p>
  <p class="links">${ghLink(pr.url, 'Conversation', 'btn')} ${ghLink(`${pr.url}/files`, 'Files changed', 'btn')} ${ghLink(`${pr.url}/commits`, 'Commits', 'btn')}</p>

  <section><h3>Activity <span class="tag measured">measured</span></h3>
    ${pr.detail === 'missing' ? '<p class="muted">Activity details have not been collected for this PR yet.</p>' : metricsTable(pr, dataset)}
    <p class="muted small">Last substantive activity ${esc(relTime(pr.lastActivityAt, now))} (${esc(absTime(pr.lastActivityAt))}). Bot comments and CI trigger comments (e.g. “jenkins test …”) are excluded from windowed counts. Details fetched ${esc(absTime(pr.fetchedAt))}.</p>
  </section>

  <section><h3>Trending score: ${esc(t.score)} <span class="tag heuristic">heuristic</span></h3>
    <ul class="kv">
      <li>Discussion <strong>${esc(t.components.discussion)}</strong> + review <strong>${esc(t.components.review)}</strong> + code <strong>${esc(t.components.code)}</strong> = base <strong>${esc(t.base)}</strong></li>
      <li>Acceleration ×<strong>${esc(a.multiplier)}</strong>: ${esc(BASIS_TEXT[a.basis])}${a.ratio !== null ? ` (recent ${esc(a.recentWeighted)} vs ${esc(a.baselineWeeklyWeighted)}/week before, ratio ${esc(a.ratio)})` : ''}</li>
      ${t.rank ? `<li>Rank <strong>${t.rank}</strong>${t.previousRank ? ` (was ${t.previousRank} at ${esc(absTime(dataset.history.comparedTo))})` : ''}</li>` : ''}
      ${t.unusual ? `<li><strong>Unusual:</strong> recent activity ≥ ${esc(dataset.scoring.population.threshold)} (median of active PRs ${esc(dataset.scoring.population.median)})</li>` : ''}
    </ul>
    <p>${t.explanation.map(esc).join(' · ')}</p>
  </section>

  <section><h3>Technical importance: ${esc(tech.score)}/100 <span class="tag heuristic">heuristic</span> ${confidenceChip(tech.confidence)}</h3>
    <p>${esc(tech.explanation)}</p>
    ${flags.length ? `<p class="muted">Note: ${flags.map(esc).join('; ')}.</p>` : ''}
    ${subsystems || '<p class="muted">No subsystem matched.</p>'}
    ${tech.signals.length ? `<div class="sub-detail"><h4>Cross-cutting signals</h4>${evidenceList(tech.signals)}</div>` : ''}
  </section>

  <section><h3>Changed files <span class="muted small">(${files.length} shown of ${num(pr.changedFiles)}; relevant files first)</span></h3>
    ${files.length ? `<ul class="files">${files.map((f) => fileRow(pr, f).replace('<li>', f.relevant ? '<li class="relevant">' : '<li>')).join('')}</ul>` : '<p class="muted">File list not collected yet.</p>'}
  </section>
</div>`;
}

// ---------- about ----------

export function renderAbout(ctx) {
  const { dataset } = ctx;
  const tr = dataset.scoring.trending;
  const im = dataset.scoring.importance;
  const w = tr.weights;
  const c = dataset.collection;
  const pop = dataset.scoring.population;
  return `<article class="prose">
<h2>What this dashboard answers</h2>
<ul>
  <li><strong>Trending</strong>: what is attracting unusual attention right now?</li>
  <li><strong>Technical importance</strong>: what technically significant work deserves review, even if nobody is talking about it?</li>
</ul>
<p>The two scores are computed independently. Technical importance never uses comment counts, reviews or other popularity signals.</p>

<h2>Measured vs heuristic</h2>
<p>Counts marked <span class="tag measured">measured</span> come straight from GitHub (comments, reviews, commits, files, lines). Scores, classifications and confidence levels are <span class="tag heuristic">heuristic</span>: transparent rules, not ground truth.</p>

<h2>Trending score</h2>
<p>Only activity from the last ${esc(tr.lookbackDays)} days counts; each event's weight halves every ${esc(tr.halfLifeHours)}h. Lifetime totals are ignored, so a PR with 200 comments spread over two years does not outrank one with 20 reviews yesterday.</p>
<table class="weights"><thead><tr><th scope="col">Event</th><th scope="col">Weight</th></tr></thead><tbody>
  <tr><td>Issue comment (human, not a CI trigger such as “jenkins test …”)</td><td>${esc(w.comment)}</td></tr>
  <tr><td>Review: approve or request changes</td><td>${esc(w.reviewVerdict)}</td></tr>
  <tr><td>Review: comment with a summary body</td><td>${esc(w.reviewSummary)}</td></tr>
  <tr><td>Inline review comment (max ${esc(w.reviewInlineCapPerReview)} per review)</td><td>${esc(w.reviewInlineComment)}</td></tr>
  <tr><td>Code push (commits and force-pushes close together count once; at most ${esc(w.pushesPerDayCap)} per day)</td><td>${esc(w.push)}</td></tr>
  <tr><td>Distinct participant in the last ${esc(tr.recentDays)} days (max ${esc(w.participantCap)})</td><td>${esc(w.participant)}</td></tr>
</tbody></table>
<p>Each event is counted once: inline comments are counted through the review that carries them and never as separate comments; events are de-duplicated by GitHub node id across pages and collection runs. Code size only nudges the code component (at most +${esc(Math.round(tr.sizeFactor.max * 100))}%), so a large but idle PR cannot trend.</p>
<p><strong>Acceleration.</strong> Activity in the last ${esc(tr.recentDays)} days is compared with the PR's own weekly average over the previous ${esc(tr.baselineDays)} days, using event timestamps. The multiplier is 1 + ${esc(tr.acceleration.slope)}·log₂(ratio), clamped to [${esc(tr.acceleration.min)}, ${esc(tr.acceleration.max)}]. PRs younger than ${esc(tr.recentDays + tr.acceleration.minBaselineDays)} days, or whose older events were truncated by API limits, get no multiplier; the detail panel says which case applies.</p>
<p><strong>Unusual activity</strong> flags PRs whose recent weighted activity is at least median + ${esc(tr.unusual.madMultiplier)}×MAD of open PRs that had any recent activity (and ≥ ${esc(tr.unusual.minWeightedEvents)}). Current threshold: ${esc(pop.threshold)} (median ${esc(pop.median)}, ${esc(pop.population)} active PRs). This is a robust outlier heuristic, not a significance test.</p>
<p><strong>Merged and closed PRs</strong> (Status filter) are scored the same way, so activity just before a merge still shows. They are not ranked, though: trend ranks, rank movement and the unusual-activity threshold only consider open PRs.</p>

<h2>Technical importance</h2>
<p>Classification uses rules in <code>config/subsystems.json</code>:</p>
<ol>
  <li><strong>Paths</strong> (primary evidence). Each changed file counts toward the first, most specific matching rule of a subsystem. A rule's weight is scaled by how much of it changed (${esc(im.churn.floor)} + ${esc(im.churn.perDecade)}·log₁₀(1+lines), max 1), so a one-line touch counts less than a rewrite but sheer size saturates quickly. Tests, docs and the dashboard frontend are excluded.</li>
  <li><strong>Labels and keywords</strong> in the title (full weight) or description (half), capped at ${esc(im.labelCap)} and ${esc(im.keywordCap)} per subsystem.</li>
  <li><strong>Cross-cutting signals</strong>: persistent/wire-format definitions touched, design docs, and described regressions, compatibility, concurrency or measured performance changes. Text signals only count when core code changes.</li>
</ol>
<p>A subsystem is assigned at a score ≥ ${esc(im.assignThreshold)}. “Major architectural changes” additionally requires path evidence (core interfaces) or substantial changes across several core areas. Confidence: <em>high</em> when path evidence alone reaches the threshold and is corroborated by labels/keywords, <em>medium</em> with path evidence only, <em>low</em> when based on text alone.</p>
<p>Overall: best subsystem + ${esc(im.secondarySubsystemWeight)}× the others (at most +${esc(im.secondarySubsystemCap)}) + signals, ×${esc(im.backportMultiplier)} for backports, ×${esc(im.mechanicalMultiplier)} when the title describes a move/rename/cleanup, mapped to 0–100 with 100·(1−e^(−raw/${esc(im.scale)})). PRs scoring ≥ ${esc(im.minScore)} are listed as technically important. Test- or docs-only PRs score 0.</p>

<h2>Data</h2>
<ul>
  <li>Source: ${c.source === 'sample' ? 'sample fixtures' : `GitHub GraphQL API, <a href="${esc(dataset.repo.url)}">${esc(dataset.repo.owner)}/${esc(dataset.repo.name)}</a>`}.</li>
  <li>Collected ${esc(absTime(c.startedAt))}; ${esc(c.listed)} open PRs listed (GitHub reports ${esc(c.totalOpen)})${c.closedDays ? `, plus ${esc(c.closedListed)} merged or closed in the last ${esc(c.closedDays)} days` : ''}; ${esc(c.fetched)} detail fetches this run, ${esc(c.stale)} stale, ${esc(c.missing)} without details; ${esc(c.apiRequests)} API requests (${esc(c.apiCost)} points).</li>
  <li>Windows: ${dataset.windows.map((w) => esc(w.key)).join(', ')}. Trend ranks compared with the snapshot from ${esc(absTime(dataset.history.comparedTo))}.</li>
  <li>Updates are scheduled every ~${esc(dataset.site.refreshHours)}h. If a run fails, the previous dataset stays online and a banner reports the failure.</li>
</ul>
<h2>Limitations</h2>
<ul>
  <li>GitHub returns at most the latest 100 comments, reviews and commits per query; older events are retained from earlier runs where possible, otherwise acceleration is disabled for that PR.</li>
  <li>Path rules cannot see what changed inside a file; a one-line change in a critical file still counts as a touch of that file.</li>
  <li>Commit timestamps are author-controlled; force-push events are used to detect rebases.</li>
  <li>CI state is the combined status of the latest commit and may lag.</li>
</ul>
</article>`;
}
