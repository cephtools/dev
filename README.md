# Ceph PR Radar

A static GitHub Pages dashboard that helps Ceph developers find open pull requests in
[ceph/ceph](https://github.com/ceph/ceph) that deserve attention, and explains why.

It answers two separate questions:

- **Trending**: what is attracting unusual attention right now?
- **Technical importance**: what technically significant work should I review, even if nobody is talking about it?

The scores are independent. Technical importance is computed only from *what a PR changes*
(paths, persistent formats, interfaces) and how it is described, never from comments or reviews.

Views: **Trending**, **Technical importance**, **Subsystems** (BlueStore, RocksDB & metadata,
Crimson & Seastar, OSD performance, Memory management, Major architectural changes) and
**About / Scoring**, which documents the live scoring parameters. Clicking a PR opens a detail panel
with measured metrics, score breakdowns, classification evidence and links to the changed files on GitHub.

## How it works

```text
GitHub Actions (cron, every 3h)
  └─ src/cli/collect.ts
       list open PRs (GraphQL, paginated)                ← cheap, always complete
       fetch details only for new/changed/aged PRs       ← incremental, batched, budgeted
       merge into cache.json (dedup by node id)
       score: trending (activity) + technical (paths/text)
       publish datasets/<id>.json, then manifest.json    ← atomic
  └─ state pushed to the `dashboard-data` branch (one orphan commit, force-pushed)
  └─ src/cli/build-site.ts → dist/ → GitHub Pages
Browser: site/ (plain ES modules, no build step) loads data/manifest.json → dataset
```

There is no server and no runtime dependency. The collector is TypeScript, executed directly by
Node ≥ 22.18 (type stripping); `typescript` and `@types/node` are dev dependencies used only for
type checking. See [docs/architecture.md](docs/architecture.md) for the design decisions.

## Repository layout

| Path | Contents |
|---|---|
| `config/dashboard.json` | Target repo, time windows, scoring weights, collection limits |
| `config/subsystems.json` | Subsystem classification rules (paths, keywords, labels, signals) |
| `schema/dataset.schema.json` | Published data contract; validated before every publish and deploy |
| `src/github/` | GraphQL client (retries, rate limits) and queries |
| `src/collect/` | Listing, incremental detail collection, normalization, cache merge |
| `src/score/` | Windowed metrics, trending score, classification, technical importance |
| `src/dataset/` | Dataset assembly, history snapshots, schema validation, atomic publish |
| `src/cli/` | `collect`, `sample`, `build-site`, `validate`, `serve` |
| `site/` | Static frontend |
| `tests/` | `node:test` suites and fixtures (`tests/fixtures/prs.json`) |
| `sample-data/` | Sample dataset generated from the fixtures |

## Local development

```sh
npm install           # dev dependencies only (typescript, @types/node)
npm run dev           # build sample data + site, serve on http://localhost:8080
npm run check         # typecheck + tests + sample + schema validation + site build
```

Against live data (read-only, uses your token's GraphQL budget; a full first run costs ~200 points):

```sh
GITHUB_TOKEN=$(gh auth token) node src/cli/collect.ts --state state [--max-details 100]
node src/cli/build-site.ts --data state/public --out dist
npm run serve
```

`--max-details` limits detail fetches for a quick trial; PRs without details are still listed
and flagged as incomplete. Re-running continues incrementally from `state/cache.json`.

Other commands: `npm test`, `npm run typecheck`, `node src/cli/validate.ts <data dir>`.

## Deployment

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions:** the workflow declares what it needs
   (below); make sure the organization does not restrict `GITHUB_TOKEN` to read-only for this repository.
4. Run **Actions → Update dashboard → Run workflow** once. The first run creates the
   `dashboard-data` branch and deploys the site within about 6 minutes: it lists every open PR
   but fetches details only for the 400 most recently updated (`collection.bootstrapMaxDetailPrs`).
   The remaining PRs show as "no detail yet" until the next scheduled run (3 hours later) fetches them.

### Workflow permissions

| Permission | Why |
|---|---|
| `contents: write` | Force-push collector state (cache, history, published data) to `dashboard-data` |
| `pages: write`, `id-token: write` | Deploy with `actions/deploy-pages` |

Reading ceph/ceph needs no extra permission: it is a public repository and `GITHUB_TOKEN` can read
public data. Its GraphQL budget is 1,000 points/hour; a full run uses about 200, an incremental run far less.

Optional settings:

- **Secret `PR_DASH_TOKEN`**: a fine-grained personal access token (public repositories, read-only)
  raises the budget to 5,000 points/hour. Used instead of `GITHUB_TOKEN` when present.
- **Variable `PR_DASH_REPO`**: `owner/name` to track another repository without editing config.

No token is ever sent to the browser; the frontend only reads static JSON.

### Configuration

- **Target repository**: `repo` in `config/dashboard.json` (or the `PR_DASH_REPO` variable/env).
- **Refresh frequency**: the `cron` line in `.github/workflows/update.yml`; keep `site.refreshHours`
  and `site.staleAfterHours` in `config/dashboard.json` consistent (they drive the stale-data banner).
- **Windows, weights, thresholds**: `windows`, `trending`, `importance` in `config/dashboard.json`.
- **Classification rules**: `config/subsystems.json`. Within a subsystem, list specific path rules before
  general ones (each file counts for its first matching rule).

## Scoring methodology

Full details, with the live parameters, are on the dashboard's **About / Scoring** page.

### Trending (heuristic)

- Only substantive human activity counts: bots and CI trigger comments (`jenkins test …`) are excluded.
- Events: issue comments (1), approve/request-changes reviews (3), commented reviews with a summary (1.5),
  inline review comments (0.5 each, capped per review), code pushes (2), distinct participants in 7 days (1 each, capped).
- Every event decays with a 72h half-life; nothing older than 14 days counts. Lifetime totals are not used.
- No double counting: inline comments are counted through the review that carries them; all events are
  de-duplicated by GitHub node id; commits and force-pushes close in time collapse into one push, so a rebase counts once.
- At most 2 pushes per day count toward the score, so iterating on a WIP branch doesn't trend by itself
  (the cards still show the real push count).
- Size only nudges the code component (≤ +25%); an idle large PR scores 0.
- **Acceleration** compares the last 7 days with the PR's own weekly average over the preceding 28 days,
  from event timestamps: ×(1 + 0.3·log₂ ratio), clamped to [0.75, 1.75]. It is disabled, and the UI says so,
  for PRs younger than 21 days or whose older events were truncated by API limits.
- **Unusual activity** flags PRs at or above median + 3×MAD of currently active PRs. This is a robust outlier
  rule, not a statistical significance test.
- Rank movement is compared with the snapshot closest to 24h earlier (kept 14 days on the data branch).

### Technical importance (heuristic)

- **Path rules** (primary evidence), weighted by how much of the matched code changed
  (`0.4 + 0.2·log₁₀(1+lines)`, max 1), so a large change saturates quickly. Tests, docs and the dashboard frontend are excluded.
- **Labels and keywords** in title (full) or description (half), capped per subsystem.
- **Cross-cutting signals**: persistent/wire-format files (`*_types.*`, `denc.h`, `osd_types`, messages…),
  design docs, and described regressions, compatibility, concurrency or measured performance changes.
  Text signals only count when core code changes. Ceph's PR template (checklist, guidelines) and HTML comments
  are stripped first, and phrases like "regression tests" don't count as a reported regression.
- Subsystem assignment needs a score ≥ 10. "Major architectural changes" also requires path evidence on core
  interfaces or substantial changes across ≥ 4 core areas (breadth bonus capped at 15); text alone is not enough.
- Confidence: **high** = path evidence reaches the threshold on its own and is corroborated by labels/keywords;
  **medium** = path evidence only; **low** = text only.
- Overall = best subsystem + 0.25 × others (capped at +12, so incidental touches can't pile up) + signals,
  ×0.6 for backports, ×0.6 when the title describes a move/rename/cleanup, mapped to 0–100. PRs ≥ 30 are listed.
  Test-only and docs-only PRs score 0.

## Data, failures and freshness

- `data/manifest.json` points to an immutable `data/datasets/<id>.json`; the dataset is written and
  validated before the manifest is atomically replaced, so readers never see partial data.
- `data/status.json` records every attempt. If collection fails, the workflow redeploys the last good
  dataset, the dashboard shows a failure banner with the error, and the run is marked failed.
- A listing that is clearly incomplete is treated as a failure; a failed collection never becomes an empty list.
- If the detail budget runs out (or single PRs fail), the run still publishes: affected PRs use cached
  details or are flagged "no detail yet", and a "Partial collection" banner lists what happened.
- Data older than `site.staleAfterHours` triggers a stale-data banner.

## Limitations

- GitHub returns at most the newest 100 comments/reviews/commits per PR per query. Older events survive from
  earlier runs; where they cannot, acceleration is disabled for that PR rather than guessed.
- Path rules see which files changed, not what changed inside them.
- Commit timestamps are author-controlled; force-push events are used to detect rebases.
- Review comments are attributed to their review's submission time.
- Changing comment ignore patterns or bot logins applies to newly fetched PRs; cached PRs update on their next refresh (≤ 48h).
- Scheduled workflows in a repository with no activity for 60 days are disabled by GitHub; the data branch
  pushes normally count as activity, but re-enable the workflow if that happens.

## Troubleshooting

| Symptom | Check |
|---|---|
| "Could not load the PR dataset" | First run not finished, or it failed before any success: see the Actions log. |
| Red "Latest collection failed" banner | Actions → Update dashboard → failed run → "Collect PR data" step. |
| "Partial collection" right after setup | Expected: the first run publishes early; the next run fills in the remaining PRs. |
| `RateLimitError` / "Partial collection" | Normal during the first runs with `GITHUB_TOKEN`; later runs catch up incrementally. Add `PR_DASH_TOKEN` to speed up. |
| Push to `dashboard-data` rejected | Workflow permissions must allow write; branch protection must not cover `dashboard-data`. |
| Deploy step fails with an environment error | Pages source must be "GitHub Actions"; the `github-pages` environment must allow the default branch. |
| Stale-data banner | Scheduled runs disabled or failing; check the Actions tab. |
| A PR is misclassified | Inspect its evidence in the detail panel, adjust `config/subsystems.json`, add a test in `tests/classify.test.ts`. |
